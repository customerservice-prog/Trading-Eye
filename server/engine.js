import { EventEmitter } from "node:events";
import { OnlineModel } from "./model.js";
import { fingerprintFromFeatures, patternProbabilities, blendProbabilities, timeBucketET } from "./patterns.js";

const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const pct=(a,b)=>b?(a-b)/b:0;

export class RealMarketEngine extends EventEmitter {
  constructor({db,provider,symbols,backfillDays=30,predictEvery=5,horizonMinutes=15,enabled=true}) {
    super();
    this.db=db;
    this.provider=provider;
    this.enabled=enabled;
    this.coreSymbols=[...new Set(symbols.map(s=>String(s).toUpperCase()))];
    this.pinnedSymbols=new Set(this.coreSymbols);
    this.liveSymbolLimit=this.provider.maxSymbols||28;
    this.symbols=[...this.coreSymbols].slice(0,this.liveSymbolLimit);
    this.hotLastUsed=new Map(this.symbols.map(s=>[s,Date.now()]));
    this.backfillDays=backfillDays;
    this.predictEvery=predictEvery;
    this.horizonMinutes=horizonMinutes;
    this.historyRetention=Math.min(100000,Math.max(5000,this.backfillDays*600));
    this.model=new OnlineModel(db);
    this.modelLab=null;
    this.paperBroker=null;
    this.histories=new Map(this.symbols.map(s=>[s,[]]));
    this.latestQuotes=new Map();
    this.latestTrades=new Map();
    this.barCounters=new Map(this.symbols.map(s=>[s,0]));
    this.latestPatternInsight=new Map();
    this.patternLabCache=new Map();
    this.focusSymbols=new Set(this.symbols.slice(0,1));
    this.symbolDeepHistory=new Set();
    this.rawQueue=[];
    this.providerStatus={state:"STARTING",provider:"alpaca",feed:provider.feed};
    this.lastEventAt=null;
    this.lastBarAt=null;
    this.startedAt=new Date();
    this.backfill={state:"WAITING",rows:0,startedAt:null,finishedAt:null,error:null};
    this.flushTimer=null;
    this.heartbeatTimer=null;
  }

  async init() {
    await this.model.load();
    for (const symbol of this.symbols) {
      const rows=await this.db.getBars(symbol,{limit:800});
      this.histories.set(symbol,rows.map(r=>this.#rowToBar(r)));
    }
    this.provider.onStatus=s=>this.#onProviderStatus(s);
    this.provider.onEvent=e=>this.#onProviderEvent(e);
    this.flushTimer=setInterval(()=>this.#flushRaw().catch(err=>this.#recordError("raw_flush",err)),1000);
    this.heartbeatTimer=setInterval(()=>this.#heartbeat().catch(()=>{}),15000);
    await this.#heartbeat();
    if (!this.enabled) {
      this.providerStatus={state:"DISABLED",provider:"alpaca",feed:this.provider.feed};
      await this.#heartbeat();
      return;
    }
    if (this.provider.configured()) {
      this.#backfill().catch(err=>{
        this.backfill.state="ERROR";
        this.backfill.error=String(err?.message||err);
        this.backfill.finishedAt=new Date().toISOString();
        console.log(JSON.stringify({
          event:"backfill_error",
          message:this.backfill.error,
          rows:this.backfill.rows
        }));
        this.emit("status",this.status());
      });
      this.provider.start().catch(err=>this.#recordError("provider_start",err));
    } else {
      this.providerStatus={state:"NOT_CONFIGURED",provider:"alpaca",feed:this.provider.feed};
    }
  }

  attachIntelligence({modelLab=null,paperBroker=null}={}) {
    this.modelLab=modelLab;
    this.paperBroker=paperBroker;
  }

  hotSymbols() {
    return [...this.symbols];
  }

  focusSymbol(symbol) {
    symbol=String(symbol||"").trim().toUpperCase();
    if (!symbol || !this.symbols.includes(symbol)) return [];
    this.focusSymbols=new Set([symbol]);
    return this.provider.setFocusSymbols([symbol]);
  }

  async activateSymbol(symbol,{backfill=true,pin=false,focus=true}={}) {
    symbol=String(symbol||"").trim().toUpperCase();
    if (!symbol) throw new Error("Symbol required");
    this.hotLastUsed.set(symbol,Date.now());
    if (pin) this.pinnedSymbols.add(symbol);

    if (!this.symbols.includes(symbol)) {
      const currentLimit=this.provider.currentSymbolLimit?.()||this.liveSymbolLimit;
      if (this.symbols.length>=currentLimit) {
        const removable=this.symbols
          .filter(s=>!this.pinnedSymbols.has(s))
          .sort((a,b)=>(this.hotLastUsed.get(a)||0)-(this.hotLastUsed.get(b)||0));
        const drop=removable[0];
        if (!drop) throw new Error("Live hot set is full");
        this.symbols=this.symbols.filter(s=>s!==drop);
        this.histories.delete(drop);
        this.latestQuotes.delete(drop);
        this.latestTrades.delete(drop);
        this.barCounters.delete(drop);
        this.hotLastUsed.delete(drop);
      }
      this.symbols.push(symbol);
      this.histories.set(symbol,[]);
      this.barCounters.set(symbol,0);
      this.symbols=this.provider.setSymbols(this.symbols);
    }

    if (focus) this.focusSymbol(symbol);

    const existing=this.histories.get(symbol)||[];
    if (backfill && !this.symbolDeepHistory.has(symbol)) {
      this.#backfillSymbol(symbol).catch(err=>this.#recordError("symbol_backfill",err));
    }
    return {symbol,hotSymbols:this.hotSymbols(),pinned:[...this.pinnedSymbols]};
  }

  async setAutoCandidates(candidates,{backfillDays=3}={}) {
    const unique=[...new Set((candidates||[]).map(s=>String(s).toUpperCase()).filter(Boolean))];
    const pinned=[...this.pinnedSymbols];
    const target=[...pinned];
    for (const symbol of unique) {
      if (target.length>=this.liveSymbolLimit) break;
      if (!target.includes(symbol)) target.push(symbol);
    }
    this.symbols=target.slice(0,this.liveSymbolLimit);
    for (const symbol of this.symbols) {
      if (!this.histories.has(symbol)) this.histories.set(symbol,[]);
      if (!this.barCounters.has(symbol)) this.barCounters.set(symbol,0);
      this.hotLastUsed.set(symbol,this.hotLastUsed.get(symbol)||Date.now());
    }
    this.symbols=this.provider.setSymbols(this.symbols);
    await this.#backfillSymbols(this.symbols.filter(s=>(this.histories.get(s)||[]).length<120),backfillDays);
    console.log(JSON.stringify({event:"auto_hot_set_updated",symbols:this.symbols}));
    return this.hotSymbols();
  }

  async #backfillSymbols(symbols,days=3) {
    const requested=[...new Set((symbols||[]).filter(Boolean))];
    if (!requested.length) return;
    const end=new Date(Date.now()-20*60*1000);
    const start=new Date(end.getTime()-Math.max(1,Math.min(10,days))*24*60*60*1000);
    const collected=new Map(requested.map(s=>[s,[]]));
    await this.provider.historicalBarsForSymbols({
      symbols:requested,start,end,timeframe:"1Min",
      onPage:async barsBySymbol=>{
        const batch=[];
        for (const [symbol,rows] of Object.entries(barsBySymbol)) {
          for (const r of rows) {
            const bar={
              provider:"alpaca",feed:this.provider.historicalFeed||"iex",symbol,ts:new Date(r.t),
              open:r.o,high:r.h,low:r.l,close:r.c,volume:r.v,
              tradeCount:r.n??null,vwap:r.vw??null,source:"historical"
            };
            batch.push(bar);
            if (!collected.has(symbol)) collected.set(symbol,[]);
            collected.get(symbol).push(bar);
          }
        }
        for(let i=0;i<batch.length;i+=700) await this.db.upsertBarsBatch(batch.slice(i,i+700));
      }
    });
    for (const [symbol,rows] of collected.entries()) {
      if (!rows.length) continue;
      rows.sort((a,b)=>+a.ts-+b.ts);
      this.histories.set(symbol,rows.slice(-this.historyRetention));
    }
  }

  async #backfillSymbol(symbol) {
    const end=new Date(Date.now()-20*60*1000);
    const start=new Date(end.getTime()-Math.min(this.backfillDays,90)*24*60*60*1000);
    const collected=[];
    await this.provider.historicalBarsForSymbols({
      symbols:[symbol],start,end,timeframe:"1Min",
      onPage:async barsBySymbol=>{
        const rows=barsBySymbol[symbol]||[];
        const batch=rows.map(r=>({
          provider:"alpaca",feed:this.provider.historicalFeed||"iex",symbol,ts:new Date(r.t),
          open:r.o,high:r.h,low:r.l,close:r.c,volume:r.v,
          tradeCount:r.n??null,vwap:r.vw??null,source:"historical"
        }));
        for(let i=0;i<batch.length;i+=700) await this.db.upsertBarsBatch(batch.slice(i,i+700));
        collected.push(...batch);
      }
    });
    if (collected.length) {
      collected.sort((a,b)=>+a.ts-+b.ts);
      this.histories.set(symbol,collected.slice(-this.historyRetention));
      this.symbolDeepHistory.add(symbol);
      await this.#buildPatternMemoryForSymbol(symbol);
      console.log(JSON.stringify({event:"symbol_backfill_complete",symbol,bars:collected.length}));
    }
  }

  async #buildPatternMemoryForSymbol(symbol) {
    const rows=this.histories.get(symbol)||[];
    if (rows.length<1200) return;

    const aggregates=new Map();
    for (let i=30;i<rows.length-61;i+=5) {
      const features=this.#historicalFeatures(rows,i);
      if (!features) continue;
      const fingerprint=fingerprintFromFeatures(features,rows[i].ts);
      if (!fingerprint) continue;

      for (const horizon of [15,30,60]) {
        const future=rows[i+horizon];
        if (!future) continue;
        const elapsed=(+new Date(future.ts)-+new Date(rows[i].ts))/60000;
        if (elapsed<horizon-1 || elapsed>horizon+5) continue;

        const reference=rows[i].close;
        const ret=(future.close-reference)/reference;
        const path=rows.slice(i+1,i+horizon+1);
        const mfe=path.length?Math.max(...path.map(x=>(x.high-reference)/reference)):0;
        const mae=path.length?Math.min(...path.map(x=>(x.low-reference)/reference)):0;
        const direction=ret>.001?"UP":ret<-.001?"DOWN":"FLAT";
        const key=`${fingerprint}::${horizon}`;
        const agg=aggregates.get(key)||{
          symbol,fingerprint,horizonMinutes:horizon,sampleCount:0,
          upCount:0,flatCount:0,downCount:0,sumReturn:0,sumAbsReturn:0,
          sumMfe:0,sumMae:0,lastSeen:null
        };
        agg.sampleCount++;
        if (direction==="UP") agg.upCount++;
        else if (direction==="DOWN") agg.downCount++;
        else agg.flatCount++;
        agg.sumReturn+=ret;
        agg.sumAbsReturn+=Math.abs(ret);
        agg.sumMfe+=mfe;
        agg.sumMae+=mae;
        agg.lastSeen=rows[i].ts;
        aggregates.set(key,agg);
      }
    }

    const rowsToSave=[...aggregates.values()].filter(x=>x.sampleCount>=6);
    for (const agg of rowsToSave) {
      await this.db.upsertPatternAggregate({
        symbol:agg.symbol,
        fingerprint:agg.fingerprint,
        horizonMinutes:agg.horizonMinutes,
        sampleCount:agg.sampleCount,
        upCount:agg.upCount,
        flatCount:agg.flatCount,
        downCount:agg.downCount,
        avgReturn:agg.sumReturn/agg.sampleCount,
        avgAbsReturn:agg.sumAbsReturn/agg.sampleCount,
        avgMfe:agg.sumMfe/agg.sampleCount,
        avgMae:agg.sumMae/agg.sampleCount,
        lastSeen:agg.lastSeen,
        context:{source:"on_demand_90d_1m"}
      });
    }
    console.log(JSON.stringify({
      event:"symbol_pattern_memory_built",
      symbol,
      patterns:rowsToSave.length,
      bars:rows.length
    }));
  }

  #rowToBar(r) {
    return {
      provider:r.provider,feed:r.feed,symbol:r.symbol,
      ts:new Date(r.ts),open:Number(r.open),high:Number(r.high),low:Number(r.low),
      close:Number(r.close),volume:Number(r.volume),tradeCount:r.trade_count,
      vwap:r.vwap==null?null:Number(r.vwap),source:r.source
    };
  }

  async #backfill() {
    this.backfill={state:"RUNNING",rows:0,startedAt:new Date().toISOString(),finishedAt:null,error:null};
    console.log(JSON.stringify({
      event:"backfill_started",
      feed:this.provider.feed,
      days:this.backfillDays,
      symbols:this.symbols
    }));
    this.emit("status",this.status());
    const end=new Date(Date.now()-20*60*1000);
    const defaultStart=new Date(end.getTime()-this.backfillDays*24*60*60*1000);
    const start=await this.db.getBackfillStart(this.symbols,defaultStart);
    await this.provider.historicalBars({
      start,end,
      onPage:async barsBySymbol=>{
        const batch=[];
        for (const [symbol,rows] of Object.entries(barsBySymbol)) {
          for (const r of rows) {
            batch.push({
              provider:"alpaca",feed:this.provider.historicalFeed||"iex",symbol,ts:new Date(r.t),
              open:r.o,high:r.h,low:r.l,close:r.c,volume:r.v,
              tradeCount:r.n ?? null,vwap:r.vw ?? null,source:"historical"
            });
          }
        }
        for (let i=0;i<batch.length;i+=700) {
          await this.db.upsertBarsBatch(batch.slice(i,i+700));
        }
        for (const bar of batch) {
          const history=this.histories.get(bar.symbol)||[];
          const existing=history.findIndex(x=>+new Date(x.ts)===+new Date(bar.ts));
          if (existing>=0) history[existing]=bar; else history.push(bar);
          history.sort((a,b)=>+new Date(a.ts)-+new Date(b.ts));
          if (history.length>this.historyRetention) history.splice(0,history.length-this.historyRetention);
          this.histories.set(bar.symbol,history);
        }
        this.backfill.rows+=batch.length;
        console.log(JSON.stringify({
          event:"backfill_page",
          rowsAdded:batch.length,
          totalRows:this.backfill.rows
        }));
        this.emit("status",this.status());
      }
    });
    for (const symbol of this.symbols) {
      const historyLimit=Math.min(100000,Math.max(5000,this.backfillDays*600));
      const rows=await this.db.getBars(symbol,{limit:historyLimit});
      this.histories.set(symbol,rows.map(r=>this.#rowToBar(r)));
      if (rows.length>=1200) this.symbolDeepHistory.add(symbol);
    }
    this.backfill.state="COMPLETE";
    this.backfill.finishedAt=new Date().toISOString();
    console.log(JSON.stringify({
      event:"backfill_complete",
      rows:this.backfill.rows
    }));
    await this.#bootstrapHistoricalModel();
    this.emit("status",this.status());
  }

  #onProviderStatus(status) {
    if (Array.isArray(status.symbols) && ["LIVE","LIMIT_ADJUSTED"].includes(status.state)) {
      if (status.state==="LIMIT_ADJUSTED" && this.provider.feed!=="overnight") {
        this.liveSymbolLimit=Number(status.maxSymbols)||status.symbols.length||this.liveSymbolLimit;
      }
      this.symbols=[...status.symbols];
      if (Array.isArray(status.tradeFocus)) this.focusSymbols=new Set(status.tradeFocus);
      for (const symbol of this.symbols) {
        if (!this.histories.has(symbol)) this.histories.set(symbol,[]);
        if (!this.barCounters.has(symbol)) this.barCounters.set(symbol,0);
        this.hotLastUsed.set(symbol,this.hotLastUsed.get(symbol)||Date.now());
      }
      const missing=this.symbols.filter(s=>(this.histories.get(s)||[]).length<120);
      if (missing.length) {
        this.#backfillSymbols(missing,3).catch(err=>this.#recordError("feed_switch_backfill",err));
      }
    }
    this.providerStatus={...status,at:new Date().toISOString()};
    console.log(JSON.stringify({
      event:"provider_status",
      provider:status.provider,
      feed:status.feed,
      state:status.state,
      code:status.code ?? null
    }));
    this.emit("status",this.status());
  }

  #normalizeRaw(msg) {
    return {
      provider:"alpaca",feed:this.provider.feed,
      type:msg.T==="t"?"trade":msg.T==="q"?"quote":"bar",
      symbol:msg.S || null,ts:new Date(msg.t || Date.now()),payload:msg
    };
  }

  async #onProviderEvent(msg) {
    const event=this.#normalizeRaw(msg);
    this.lastEventAt=event.ts;
    this.rawQueue.push(event);

    if (msg.T==="q") {
      const quote={
        provider:"alpaca",feed:this.provider.feed,symbol:msg.S,ts:new Date(msg.t),
        bidPrice:Number(msg.bp),bidSize:Number(msg.bs),bidExchange:msg.bx,
        askPrice:Number(msg.ap),askSize:Number(msg.as),askExchange:msg.ax,
        conditions:msg.c || [],tape:msg.z || null
      };
      this.latestQuotes.set(msg.S,quote);
      this.emit("market",{type:"quote",data:quote});
      return;
    }

    if (msg.T==="t") {
      const trade={
        provider:"alpaca",feed:this.provider.feed,symbol:msg.S,ts:new Date(msg.t),
        id:msg.i,exchange:msg.x,price:Number(msg.p),size:Number(msg.s),
        conditions:msg.c || [],tape:msg.z || null
      };
      const list=this.latestTrades.get(msg.S) || [];
      list.unshift(trade);
      this.latestTrades.set(msg.S,list.slice(0,150));
      this.emit("market",{type:"trade",data:trade});
      return;
    }

    if (msg.T==="b") {
      const bar={
        provider:"alpaca",feed:this.provider.feed,symbol:msg.S,ts:new Date(msg.t),
        open:Number(msg.o),high:Number(msg.h),low:Number(msg.l),close:Number(msg.c),
        volume:Number(msg.v),tradeCount:msg.n ?? null,vwap:msg.vw ?? null,source:"stream"
      };
      this.lastBarAt=bar.ts;
      await this.db.upsertBar(bar);
      const history=this.histories.get(bar.symbol) || [];
      const existing=history.findIndex(x=>+new Date(x.ts)===+bar.ts);
      if (existing>=0) history[existing]=bar; else history.push(bar);
      history.sort((a,b)=>+new Date(a.ts)-+new Date(b.ts));
      if (history.length>this.historyRetention) history.splice(0,history.length-this.historyRetention);
      this.histories.set(bar.symbol,history);
      await this.#scoreDue(bar);
      await this.#maybePredict(bar);
      if (this.paperBroker) this.paperBroker.onBar(bar).catch(err=>this.#recordError("paper_bar",err));
      this.emit("market",{type:"bar",data:bar});
    }
  }

  #features(symbol) {
    const rows=this.histories.get(symbol) || [];
    if (rows.length<30) return null;
    const last=rows.at(-1), prev3=rows.at(-4), prev12=rows.at(-13);
    const recent=rows.slice(-24);
    const past=recent.slice(0,-1);
    const avgVol=past.reduce((a,x)=>a+x.volume,0)/Math.max(1,past.length);
    const returns=recent.slice(1).map((x,i)=>pct(x.close,recent[i].close));
    const rv=Math.sqrt(returns.reduce((a,r)=>a+r*r,0)/Math.max(1,returns.length));
    const body=(last.close-last.open)/Math.max(last.high-last.low,last.close*.00001);
    const volSum=recent.reduce((a,x)=>a+x.volume,0);
    const vwap=recent.reduce((a,x)=>a+((x.high+x.low+x.close)/3)*x.volume,0)/Math.max(1,volSum);

    let up=0,total=0;
    for (const s of this.symbols) {
      const h=this.histories.get(s)||[];
      if (h.length>=7) {
        total++;
        if (h.at(-1).close>h.at(-7).close) up++;
      }
    }
    const breadth=total?up/total:.5;
    return {
      trend:clamp(pct(last.close,prev12.close)/.012,-1,1),
      momentum:clamp(pct(last.close,prev3.close)/.006,-1,1),
      volume:clamp((last.volume/Math.max(avgVol,1)-1)/1.2,-1,1),
      volatility:clamp((rv-.0017)/.003,-1,1),
      orderFlow:clamp(body,-1,1),
      breadth:clamp((breadth-.5)*2,-1,1),
      vwap:clamp(((last.close-vwap)/Math.max(vwap,1))/.006,-1,1)
    };
  }


  patternLab(symbol,{limit=40}={}) {
    symbol=String(symbol||"").toUpperCase();
    const rows=this.histories.get(symbol)||[];
    const currentFeatures=this.#features(symbol);
    const latest=rows.at(-1)||null;
    const historyReady=this.symbolDeepHistory.has(symbol);

    if (!currentFeatures || !latest || rows.length<100) {
      return {
        symbol,
        historyReady,
        status:historyReady?"INSUFFICIENT_HISTORY":"BUILDING_HISTORY",
        fingerprint:null,
        exactMatches:0,
        analyzedCount:0,
        statsByHorizon:{},
        analogs:[]
      };
    }

    const cacheKey=String(+new Date(latest.ts))+"::"+rows.length+"::"+String(historyReady);
    const cached=this.patternLabCache.get(symbol);
    if (cached?.key===cacheKey) {
      return {...cached.result,analogs:cached.result.analogs.slice(0,Math.max(5,Math.min(100,Number(limit)||40)))};
    }

    const currentFingerprint=fingerprintFromFeatures(currentFeatures,latest.ts);
    const currentBucket=timeBucketET(latest.ts);
    const keys=["trend","momentum","volume","volatility","orderFlow","vwap"];
    const candidates=[];

    for (let i=30;i<rows.length-61;i+=5) {
      const f=this.#historicalFeatures(rows,i);
      if (!f) continue;

      const horizons={};
      for (const horizon of [15,30,60]) {
        const future=rows[i+horizon];
        if (!future) continue;
        const elapsed=(+new Date(future.ts)-+new Date(rows[i].ts))/60000;
        if (elapsed<horizon-1 || elapsed>horizon+5) continue;
        const reference=Number(rows[i].close);
        const ret=(Number(future.close)-reference)/reference;
        const path=rows.slice(i+1,i+horizon+1);
        const mfe=path.length?Math.max(...path.map(x=>(Number(x.high)-reference)/reference)):0;
        const mae=path.length?Math.min(...path.map(x=>(Number(x.low)-reference)/reference)):0;
        horizons[horizon]={return:ret,mfe,mae,endPrice:Number(future.close)};
      }
      if (!horizons[15]) continue;

      const histFingerprint=fingerprintFromFeatures(f,rows[i].ts);
      const exact=histFingerprint===currentFingerprint;
      let sum=0;
      for (const key of keys) {
        const d=Number(currentFeatures[key]||0)-Number(f[key]||0);
        sum+=d*d;
      }
      let distance=Math.sqrt(sum/keys.length);
      if (timeBucketET(rows[i].ts)!==currentBucket) distance+=.22;
      const similarity=clamp(1-distance/1.45,0,1);

      candidates.push({
        time:new Date(rows[i].ts).toISOString(),
        entryPrice:Number(rows[i].close),
        fingerprint:histFingerprint,
        exact,
        similarity,
        distance,
        features:f,
        horizons
      });
    }

    candidates.sort((a,b)=>{
      if (a.exact!==b.exact) return a.exact?-1:1;
      return b.similarity-a.similarity;
    });

    const studySet=candidates.filter(x=>x.exact || x.similarity>=.58).slice(0,250);
    const statsByHorizon={};
    for (const horizon of [15,30,60]) {
      const values=studySet.map(x=>x.horizons[horizon]).filter(Boolean);
      if (!values.length) continue;
      const returns=values.map(x=>x.return);
      const up=returns.filter(x=>x>.001).length;
      const down=returns.filter(x=>x<-.001).length;
      const flat=returns.length-up-down;
      statsByHorizon[horizon]={
        samples:returns.length,
        upRate:up/returns.length,
        flatRate:flat/returns.length,
        downRate:down/returns.length,
        avgReturn:returns.reduce((a,b)=>a+b,0)/returns.length,
        avgMfe:values.reduce((a,x)=>a+x.mfe,0)/values.length,
        avgMae:values.reduce((a,x)=>a+x.mae,0)/values.length
      };
    }

    const result={
      symbol,
      historyReady,
      status:historyReady?"READY":"BUILDING_HISTORY",
      currentTime:new Date(latest.ts).toISOString(),
      currentPrice:Number(latest.close),
      fingerprint:currentFingerprint,
      timeBucket:currentBucket,
      exactMatches:candidates.filter(x=>x.exact).length,
      analyzedCount:studySet.length,
      statsByHorizon,
      analogs:candidates.slice(0,100)
    };
    this.patternLabCache.set(symbol,{key:cacheKey,result});
    return {...result,analogs:result.analogs.slice(0,Math.max(5,Math.min(100,Number(limit)||40)))};
  }

  #historicalFeatures(rows,index) {
    if (index<29) return null;
    const window=rows.slice(Math.max(0,index-23),index+1);
    const last=rows[index],prev3=rows[index-3],prev12=rows[index-12];
    if (!last||!prev3||!prev12||window.length<20) return null;
    const past=window.slice(0,-1);
    const avgVol=past.reduce((a,x)=>a+x.volume,0)/Math.max(1,past.length);
    const returns=window.slice(1).map((x,i)=>pct(x.close,window[i].close));
    const rv=Math.sqrt(returns.reduce((a,r)=>a+r*r,0)/Math.max(1,returns.length));
    const body=(last.close-last.open)/Math.max(last.high-last.low,last.close*.00001);
    const volSum=window.reduce((a,x)=>a+x.volume,0);
    const vwap=window.reduce((a,x)=>a+((x.high+x.low+x.close)/3)*x.volume,0)/Math.max(1,volSum);
    return {
      trend:clamp(pct(last.close,prev12.close)/.012,-1,1),
      momentum:clamp(pct(last.close,prev3.close)/.006,-1,1),
      volume:clamp((last.volume/Math.max(avgVol,1)-1)/1.2,-1,1),
      volatility:clamp((rv-.0017)/.003,-1,1),
      orderFlow:clamp(body,-1,1),
      breadth:0,
      vwap:clamp(((last.close-vwap)/Math.max(vwap,1))/.006,-1,1)
    };
  }

  async #bootstrapHistoricalModel() {
    if (this.model.stats?.historicalBootstrappedAt) return;
    let trainingSamples=0,holdoutSamples=0,holdoutCorrect=0,highConfidenceSamples=0,highConfidenceCorrect=0;
    for (const symbol of this.symbols) {
      const rows=this.histories.get(symbol)||[];
      if (rows.length<120) continue;
      const split=Math.floor(rows.length*.70);
      const lastTrain=Math.max(30,split-this.horizonMinutes-1);
      for (let i=30;i<lastTrain;i+=3) {
        const features=this.#historicalFeatures(rows,i);
        const future=rows[i+this.horizonMinutes];
        if (!features||!future) continue;
        const predicted=this.model.analyze(features);
        const ret=(future.close-rows[i].close)/rows[i].close;
        const actual=ret>.001?"UP":ret<-.001?"DOWN":"FLAT";
        await this.model.learn(features,actual,{
          p_up:predicted.pUp,p_down:predicted.pDown
        },{persist:false,historical:true});
        trainingSamples++;
      }
      for (let i=Math.max(30,split);i<rows.length-this.horizonMinutes;i+=3) {
        const features=this.#historicalFeatures(rows,i);
        const future=rows[i+this.horizonMinutes];
        if (!features||!future) continue;
        const predicted=this.model.analyze(features);
        const ret=(future.close-rows[i].close)/rows[i].close;
        const actual=ret>.001?"UP":ret<-.001?"DOWN":"FLAT";
        const correct=predicted.direction===actual;
        holdoutSamples++;
        if (correct) holdoutCorrect++;
        if (predicted.confidence>=.60) {
          highConfidenceSamples++;
          if (correct) highConfidenceCorrect++;
        }
      }
    }
    await this.model.setHistoricalValidation({
      trainingSamples,
      holdoutSamples,
      holdoutAccuracy:holdoutSamples?holdoutCorrect/holdoutSamples:null,
      highConfidenceSamples,
      highConfidenceAccuracy:highConfidenceSamples?highConfidenceCorrect/highConfidenceSamples:null
    });
  }

  async #maybePredict(bar) {
    const count=(this.barCounters.get(bar.symbol)||0)+1;
    this.barCounters.set(bar.symbol,count);
    if (count%this.predictEvery!==0) return;
    const features=this.#features(bar.symbol);
    if (!features) return;

    const learned=this.modelLab?.predict(bar.symbol)||null;
    const fallback=this.model.analyze(features);
    const base=learned?{
      direction:learned.direction,
      confidence:learned.confidence,
      pUp:learned.pUp,
      pFlat:learned.pFlat,
      pDown:learned.pDown,
      modelVersion:learned.modelVersion
    }:fallback;

    const fingerprint=fingerprintFromFeatures(features,bar.ts);
    const memoryRow=await this.db.getPattern(bar.symbol,fingerprint,this.horizonMinutes);
    const memory=patternProbabilities(memoryRow);
    const blended=blendProbabilities(base,memory);

    const patternInsight=memory?{
      fingerprint,
      sampleCount:memory.sampleCount,
      upRate:memory.up,
      flatRate:memory.flat,
      downRate:memory.down,
      avgReturn:memory.avgReturn,
      patternWeight:blended.patternWeight
    }:{fingerprint,sampleCount:0,patternWeight:0};
    this.latestPatternInsight.set(bar.symbol,patternInsight);

    const createdAt=new Date(bar.ts);
    const targetAt=new Date(createdAt.getTime()+this.horizonMinutes*60*1000);
    const modelId=learned?.modelId||null;
    const modelVersion=learned?.modelVersion||base.modelVersion;
    const id=`${bar.symbol}-${createdAt.toISOString()}-${modelId||("legacy-v"+modelVersion)}`;
    const confidence=blended.confidence;
    const sorted=[blended.pUp,blended.pFlat,blended.pDown].sort((a,b)=>b-a);
    const edge=(sorted[0]||0)-(sorted[1]||0);
    const noTrade=learned
      ? Boolean(learned.noTrade||confidence<.46||edge<.055)
      : confidence<.52||edge<.07;

    const p={
      id,symbol:bar.symbol,provider:"alpaca",feed:this.provider.feed,
      createdAt,targetAt,horizonMinutes:this.horizonMinutes,referencePrice:bar.close,
      direction:blended.direction,confidence,
      pUp:blended.pUp,pFlat:blended.pFlat,pDown:blended.pDown,
      features:{
        ...features,
        pattern:patternInsight,
        ml:learned?{family:learned.family,edge:learned.edge,noTrade:learned.noTrade}:null
      },
      modelVersion,
      modelId,
      modelDetails:learned?{
        family:learned.family,
        edge,
        noTrade,
        test:learned.metrics?.test||null,
        shadow:learned.metrics?.shadow||null
      }:{family:"legacy_online",edge,noTrade}
    };
    await this.db.savePrediction(p);
    if (this.modelLab) await this.modelLab.shadowPredict(bar.symbol,bar);
    this.emit("market",{type:"prediction",data:{...p,edge,noTrade}});
    if (this.paperBroker) {
      this.paperBroker.handlePrediction({...p,edge,noTrade}).catch(err=>this.#recordError("paper_prediction",err));
    }
  }

  async #scoreDue(bar) {
    const due=await this.db.pendingPredictions(bar.symbol,bar.ts);
    for (const p of due) {
      const ret=(bar.close-Number(p.reference_price))/Number(p.reference_price);
      const actualDirection=ret>.001?"UP":ret<-.001?"DOWN":"FLAT";
      const correct=p.direction===actualDirection;
      await this.db.scorePrediction(p.id,{
        resultPrice:bar.close,resultReturn:ret,actualDirection,correct,scoredAt:bar.ts
      });
      if (!p.model_id) {
        await this.model.learn(p.features,actualDirection,p);
      }
      this.emit("market",{type:"prediction_scored",data:{
        id:p.id,symbol:p.symbol,actualDirection,correct,resultPrice:bar.close,resultReturn:ret,scoredAt:bar.ts
      }});
    }
    if (this.modelLab) await this.modelLab.scoreShadowDue(bar);
  }

  async #flushRaw() {
    if (!this.rawQueue.length) return;
    const batch=this.rawQueue.splice(0,Math.min(800,this.rawQueue.length));
    await this.db.insertRawBatch(batch);
  }

  #recordError(area,err) {
    this.emit("status",{...this.status(),engineError:{area,message:String(err?.message||err),at:new Date().toISOString()}});
  }

  async #heartbeat() {
    await this.db.heartbeat("trading-eye-engine",this.providerStatus.state,{
      feed:this.provider.feed,lastEventAt:this.lastEventAt,lastBarAt:this.lastBarAt,
      backfill:this.backfill,uptimeSeconds:Math.floor((Date.now()-this.startedAt.getTime())/1000)
    });
  }

  status() {
    return {
      mode:"REAL_DATA_ONLY",
      engineEnabled:this.enabled,
      configured:this.provider.configured(),
      provider:this.providerStatus,
      symbols:this.symbols,
      coreSymbols:this.coreSymbols,
      pinnedSymbols:[...this.pinnedSymbols],
      focusSymbols:[...this.focusSymbols],
      deepHistorySymbols:[...this.symbolDeepHistory],
      liveSymbolLimit:this.liveSymbolLimit,
      lastEventAt:this.lastEventAt,
      lastBarAt:this.lastBarAt,
      backfill:this.backfill,
      model:this.model.snapshot(),
      modelLab:this.modelLab?.status?.()||null,
      startedAt:this.startedAt,
      uptimeSeconds:Math.floor((Date.now()-this.startedAt.getTime())/1000)
    };
  }

  snapshot(symbol) {
    const history=(this.histories.get(symbol)||[]).slice(-500);
    const quote=this.latestQuotes.get(symbol)||null;
    const trades=(this.latestTrades.get(symbol)||[]).slice(0,100);
    const features=this.#features(symbol);
    const learned=this.modelLab?.predict(symbol)||null;
    const analysis=learned|| (features?this.model.analyze(features):null);
    const patternInsight=this.latestPatternInsight.get(symbol)||null;
    return {symbol,bars:history,quote,trades,features,analysis,patternInsight,status:this.status()};
  }
}

import { EventEmitter } from "node:events";
import { OnlineModel } from "./model.js";

const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const pct=(a,b)=>b?(a-b)/b:0;

export class RealMarketEngine extends EventEmitter {
  constructor({db,provider,symbols,backfillDays=30,predictEvery=5,horizonMinutes=15,enabled=true}) {
    super();
    this.db=db;
    this.provider=provider;
    this.enabled=enabled;
    this.symbols=symbols;
    this.backfillDays=backfillDays;
    this.predictEvery=predictEvery;
    this.horizonMinutes=horizonMinutes;
    this.model=new OnlineModel(db);
    this.histories=new Map(symbols.map(s=>[s,[]]));
    this.latestQuotes=new Map();
    this.latestTrades=new Map();
    this.barCounters=new Map(symbols.map(s=>[s,0]));
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
              provider:"alpaca",feed:this.provider.feed,symbol,ts:new Date(r.t),
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
          if (history.length>1800) history.splice(0,history.length-1800);
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
      if (history.length>1800) history.splice(0,history.length-1800);
      this.histories.set(bar.symbol,history);
      await this.#scoreDue(bar);
      await this.#maybePredict(bar);
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
    const a=this.model.analyze(features);
    const createdAt=new Date(bar.ts);
    const targetAt=new Date(createdAt.getTime()+this.horizonMinutes*60*1000);
    const id=`${bar.symbol}-${createdAt.toISOString()}-v${a.modelVersion}`;
    const p={
      id,symbol:bar.symbol,provider:"alpaca",feed:this.provider.feed,
      createdAt,targetAt,horizonMinutes:this.horizonMinutes,referencePrice:bar.close,
      direction:a.direction,confidence:a.confidence,pUp:a.pUp,pFlat:a.pFlat,pDown:a.pDown,
      features,modelVersion:a.modelVersion
    };
    await this.db.savePrediction(p);
    this.emit("market",{type:"prediction",data:p});
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
      await this.model.learn(p.features,actualDirection,p);
      this.emit("market",{type:"prediction_scored",data:{
        id:p.id,symbol:p.symbol,actualDirection,correct,resultPrice:bar.close,resultReturn:ret,scoredAt:bar.ts
      }});
    }
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
      lastEventAt:this.lastEventAt,
      lastBarAt:this.lastBarAt,
      backfill:this.backfill,
      model:this.model.snapshot(),
      startedAt:this.startedAt,
      uptimeSeconds:Math.floor((Date.now()-this.startedAt.getTime())/1000)
    };
  }

  snapshot(symbol) {
    const history=(this.histories.get(symbol)||[]).slice(-500);
    const quote=this.latestQuotes.get(symbol)||null;
    const trades=(this.latestTrades.get(symbol)||[]).slice(0,100);
    const features=this.#features(symbol);
    const analysis=features?this.model.analyze(features):null;
    return {symbol,bars:history,quote,trades,features,analysis,status:this.status()};
  }
}

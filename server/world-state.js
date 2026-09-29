import { EventEmitter } from "node:events";

const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const pct=(a,b)=>b?(a-b)/b:0;
const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0;
const stdev=a=>{
  if(a.length<2) return 0;
  const m=mean(a);
  return Math.sqrt(a.reduce((s,x)=>s+(x-m)**2,0)/(a.length-1));
};

const FOMC_DATES=[
  "2026-01-28","2026-03-18","2026-04-29","2026-06-17","2026-07-29","2026-09-16","2026-10-28","2026-12-09",
  "2027-01-27","2027-03-17","2027-04-28","2027-06-09","2027-07-28","2027-09-15","2027-10-27","2027-12-08"
];

const POSITIVE_WORDS=[
  "beats","beat estimates","raises guidance","raised guidance","record revenue","record profit",
  "approval","approved","contract award","wins contract","partnership","buyback","repurchase",
  "dividend increase","upgrade","outperform","acquisition premium","strong demand","profit growth",
  "revenue growth","margin expansion","positive trial","breakthrough"
];
const NEGATIVE_WORDS=[
  "misses","missed estimates","lowers guidance","cut guidance","offering","dilution","bankruptcy",
  "investigation","subpoena","lawsuit","fraud","downgrade","underperform","recall","cyberattack",
  "data breach","ceo resigns","chief executive resigns","halted","trading halt","default",
  "going concern","restatement","warning","weak demand","margin compression","layoffs"
];
const SHOCK_WORDS=[
  "bankruptcy","fraud","halted","trading halt","subpoena","investigation","cyberattack","data breach",
  "ceo resigns","default","going concern","restatement","emergency","recall","offering","dilution"
];

const SEC_FORM_RISK={
  "8-K":.62,"8-K/A":.65,"10-Q":.55,"10-Q/A":.60,"10-K":.60,"10-K/A":.65,
  "4":.32,"4/A":.35,"SC 13D":.68,"SC 13D/A":.60,"SC 13G":.45,"SC 13G/A":.42,
  "S-3":.78,"S-3/A":.78,"424B3":.82,"424B5":.90,"424B2":.72,"FWP":.74,
  "DEF 14A":.38,"DEFA14A":.40,"6-K":.50,"20-F":.58
};

const fetchWithTimeout=(url,options={},ms=12000)=>
  fetch(url,{...options,signal:AbortSignal.timeout(ms)});

function utcDay(d=new Date()){
  return new Date(d).toISOString().slice(0,10);
}
function ymdCompact(d=new Date()){
  return utcDay(d).replaceAll("-","");
}
function addDays(date,days){
  const d=new Date(date);
  d.setUTCDate(d.getUTCDate()+days);
  return d;
}
function daysBetween(a,b){
  return (+new Date(b)-+new Date(a))/(24*60*60*1000);
}
function scoreText(text=""){
  const s=String(text).toLowerCase();
  let score=0;
  for(const w of POSITIVE_WORDS) if(s.includes(w)) score+=1;
  for(const w of NEGATIVE_WORDS) if(s.includes(w)) score-=1;
  const shock=SHOCK_WORDS.some(w=>s.includes(w));
  return {
    sentiment:clamp(score/4,-1,1),
    shock:shock?1:clamp(Math.abs(score)/5,0,.7)
  };
}
function optionContractMeta(symbol){
  const m=String(symbol||"").match(/^([A-Z.]{1,6})(\d{6})([CP])(\d{8})$/);
  if(!m) return null;
  return {
    underlying:m[1],
    expiration:"20"+m[2].slice(0,2)+"-"+m[2].slice(2,4)+"-"+m[2].slice(4,6),
    type:m[3]==="C"?"call":"put",
    strike:Number(m[4])/1000
  };
}
function latestFinite(rows=[]){
  const clean=rows.filter(x=>Number.isFinite(x.value));
  return clean.at(-1)||null;
}
function previousFinite(rows=[]){
  const clean=rows.filter(x=>Number.isFinite(x.value));
  return clean.length>1?clean.at(-2):null;
}
function etNowParts(){
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-US",{
      timeZone:"America/New_York",weekday:"short",hour:"2-digit",minute:"2-digit",hourCycle:"h23",
      year:"numeric",month:"2-digit",day:"2-digit"
    }).formatToParts(new Date()).filter(x=>x.type!=="literal").map(x=>[x.type,x.value])
  );
}

export class WorldStateEngine extends EventEmitter {
  constructor({
    db,marketEngine,alpacaKey,alpacaSecret,enabled=true,
    secUserAgent="TradingEye/1.0 (research; github.com/customerservice-prog/Trading-Eye)"
  }={}){
    super();
    this.db=db;
    this.marketEngine=marketEngine;
    this.alpacaKey=alpacaKey||"";
    this.alpacaSecret=alpacaSecret||"";
    this.enabled=Boolean(enabled);
    this.secUserAgent=secUserAgent;
    this.sourceStatus={};
    this.symbols={};
    this.global={
      updatedAt:null,macro:{},fed:{},sourceCoverage:0,eventRisk:0,uncertainty:1
    };
    this.newsSeen=new Set();
    this.secTickerMap=new Map();
    this.secCursor=0;
    this.optionsCursor=0;
    this.timers=[];
    this.running=new Set();
    this.lastError=null;
    this.startedAt=new Date();
  }

  async init(){
    if(!this.enabled) return;
    await this.db.pool.query(`
      CREATE TABLE IF NOT EXISTS world_events (
        id BIGSERIAL PRIMARY KEY,
        source TEXT NOT NULL,
        external_id TEXT NOT NULL,
        symbol TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL,
        event_at TIMESTAMPTZ NOT NULL,
        headline TEXT,
        sentiment DOUBLE PRECISION,
        severity DOUBLE PRECISION,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(source,external_id,symbol)
      );
      CREATE INDEX IF NOT EXISTS world_events_symbol_time
        ON world_events(symbol,event_at DESC);
      CREATE INDEX IF NOT EXISTS world_events_category_time
        ON world_events(category,event_at DESC);

      CREATE TABLE IF NOT EXISTS world_symbol_state (
        symbol TEXT PRIMARY KEY,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        risk_score DOUBLE PRECISION NOT NULL DEFAULT 0,
        uncertainty DOUBLE PRECISION NOT NULL DEFAULT 1,
        catalyst_score DOUBLE PRECISION NOT NULL DEFAULT 0,
        factors JSONB NOT NULL DEFAULT '{}'::jsonb
      );

      CREATE TABLE IF NOT EXISTS world_source_status (
        source TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        data_at TIMESTAMPTZ,
        detail TEXT,
        meta JSONB NOT NULL DEFAULT '{}'::jsonb
      );

      CREATE TABLE IF NOT EXISTS world_global_state (
        id INTEGER PRIMARY KEY DEFAULT 1 CHECK(id=1),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        state JSONB NOT NULL DEFAULT '{}'::jsonb
      );
    `);

    await this.#loadPersisted();
    await this.#safe("market",()=>this.refreshMarketFactors());
    await this.#safe("fed",()=>this.refreshFedRisk());
    await this.#safe("macro",()=>this.refreshMacro());
    await this.#safe("news",()=>this.refreshNews());
    await this.#safe("corporate",()=>this.refreshCorporateActions());
    await this.#safe("finra",()=>this.refreshFinraShortVolume());
    await this.#safe("sec",()=>this.refreshSec());
    await this.#safe("options",()=>this.refreshOptions());
    await this.recompute();

    this.timers.push(setInterval(()=>this.#safe("market",()=>this.refreshMarketFactors()),15000));
    this.timers.push(setInterval(()=>this.#safe("news",()=>this.refreshNews()),45000));
    this.timers.push(setInterval(()=>this.#safe("sec",()=>this.refreshSec()),5*60*1000));
    this.timers.push(setInterval(()=>this.#safe("options",()=>this.refreshOptions()),4*60*1000));
    this.timers.push(setInterval(()=>this.#safe("corporate",()=>this.refreshCorporateActions()),15*60*1000));
    this.timers.push(setInterval(()=>this.#safe("macro",()=>this.refreshMacro()),15*60*1000));
    this.timers.push(setInterval(()=>this.#safe("finra",()=>this.refreshFinraShortVolume()),30*60*1000));
    this.timers.push(setInterval(()=>this.#safe("fed",()=>this.refreshFedRisk()),10*60*1000));
    this.timers.push(setInterval(()=>this.recompute().catch(err=>this.#capture(err)),30000));
  }

  stop(){
    for(const t of this.timers) clearInterval(t);
    this.timers=[];
  }

  async #loadPersisted(){
    const [symbols,global,sources]=await Promise.all([
      this.db.pool.query("SELECT symbol,risk_score,uncertainty,catalyst_score,factors,updated_at FROM world_symbol_state"),
      this.db.pool.query("SELECT state,updated_at FROM world_global_state WHERE id=1"),
      this.db.pool.query("SELECT * FROM world_source_status")
    ]);
    for(const r of symbols.rows){
      this.symbols[r.symbol]={
        riskScore:Number(r.risk_score)||0,
        uncertainty:Number(r.uncertainty)||1,
        catalystScore:Number(r.catalyst_score)||0,
        factors:r.factors||{},
        updatedAt:r.updated_at
      };
    }
    if(global.rows[0]?.state) this.global={...this.global,...global.rows[0].state,updatedAt:global.rows[0].updated_at};
    for(const r of sources.rows){
      this.sourceStatus[r.source]={
        state:r.state,checkedAt:r.checked_at,dataAt:r.data_at,detail:r.detail,meta:r.meta||{}
      };
    }
  }

  status(){
    const hot=this.marketEngine?.hotSymbols?.()||[];
    return {
      enabled:this.enabled,
      startedAt:this.startedAt,
      lastError:this.lastError,
      global:this.global,
      sources:this.sourceStatus,
      symbols:Object.fromEntries(hot.map(s=>[s,this.contextFor(s)])),
      hotSymbols:hot
    };
  }

  contextFor(symbol){
    symbol=String(symbol||"").toUpperCase();
    const state=this.symbols[symbol]||{};
    return {
      symbol,
      riskScore:Number(state.riskScore)||0,
      uncertainty:Number(state.uncertainty??this.global.uncertainty)||0,
      catalystScore:Number(state.catalystScore)||0,
      blockProof:Boolean((Number(state.riskScore)||0)>=.90),
      factors:state.factors||{},
      updatedAt:state.updatedAt||null,
      global:{
        macro:this.global.macro||{},
        fed:this.global.fed||{},
        eventRisk:Number(this.global.eventRisk)||0,
        sourceCoverage:Number(this.global.sourceCoverage)||0
      }
    };
  }

  async recentEvents({symbol=null,limit=100}={}){
    const n=Math.max(1,Math.min(300,Number(limit)||100));
    const params=[];
    let where="";
    if(symbol){
      params.push(String(symbol).toUpperCase());
      where="WHERE symbol=$1 OR symbol=''";
    }
    params.push(n);
    const q=await this.db.pool.query(`
      SELECT id,source,external_id,symbol,category,event_at,headline,sentiment,severity,payload
      FROM world_events
      ${where}
      ORDER BY event_at DESC
      LIMIT $${params.length}
    `,params);
    return q.rows;
  }

  async #safe(name,fn){
    if(this.running.has(name)) return;
    this.running.add(name);
    try{
      await fn();
    }catch(err){
      this.#source(name,"ERROR",null,String(err?.message||err));
      this.#capture(err);
    }finally{
      this.running.delete(name);
    }
  }

  #capture(err){
    this.lastError=String(err?.message||err);
    console.log(JSON.stringify({event:"world_state_error",message:this.lastError}));
  }

  async #persistSource(name){
    const s=this.sourceStatus[name];
    if(!s) return;
    await this.db.pool.query(`
      INSERT INTO world_source_status(source,state,checked_at,data_at,detail,meta)
      VALUES($1,$2,$3,$4,$5,$6::jsonb)
      ON CONFLICT(source) DO UPDATE SET
        state=EXCLUDED.state,checked_at=EXCLUDED.checked_at,data_at=EXCLUDED.data_at,
        detail=EXCLUDED.detail,meta=EXCLUDED.meta
    `,[name,s.state,s.checkedAt,s.dataAt,s.detail||null,JSON.stringify(s.meta||{})]);
  }

  #source(name,state,dataAt=null,detail=null,meta={}){
    this.sourceStatus[name]={
      state,checkedAt:new Date().toISOString(),
      dataAt:dataAt?new Date(dataAt).toISOString():null,
      detail,meta
    };
    this.#persistSource(name).catch(()=>{});
  }

  async #event({source,externalId,symbol="",category,eventAt,headline="",sentiment=0,severity=0,payload={}}){
    await this.db.pool.query(`
      INSERT INTO world_events(source,external_id,symbol,category,event_at,headline,sentiment,severity,payload)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
      ON CONFLICT(source,external_id,symbol) DO UPDATE SET
        event_at=EXCLUDED.event_at,headline=EXCLUDED.headline,sentiment=EXCLUDED.sentiment,
        severity=EXCLUDED.severity,payload=EXCLUDED.payload
    `,[
      source,String(externalId),String(symbol||"").toUpperCase(),category,new Date(eventAt),
      headline||"",Number(sentiment)||0,Number(severity)||0,JSON.stringify(payload||{})
    ]);
  }

  #ensure(symbol){
    symbol=String(symbol).toUpperCase();
    if(!this.symbols[symbol]){
      this.symbols[symbol]={
        riskScore:0,uncertainty:1,catalystScore:0,updatedAt:null,
        factors:{market:{},news:{},sec:{},corporate:{},options:{},short:{}}
      };
    }
    return this.symbols[symbol];
  }

  async refreshMarketFactors(){
    const symbols=this.marketEngine?.hotSymbols?.()||[];
    let newest=null;
    for(const symbol of symbols){
      const state=this.#ensure(symbol);
      const q=this.marketEngine.latestQuotes.get(symbol)||null;
      const rows=this.marketEngine.histories.get(symbol)||[];
      const bar=rows.at(-1)||null;
      const bid=Number(q?.bidPrice),ask=Number(q?.askPrice);
      const mid=bid>0&&ask>0?(bid+ask)/2:null;
      const spreadBps=mid?((ask-bid)/mid)*10000:null;
      const imbalance=(Number(q?.bidSize)||0)+(Number(q?.askSize)||0)>0
        ? ((Number(q?.bidSize)||0)-(Number(q?.askSize)||0))/((Number(q?.bidSize)||0)+(Number(q?.askSize)||0))
        : 0;
      const recent=rows.slice(-25);
      const rets=[];
      for(let i=1;i<recent.length;i++){
        const a=Number(recent[i-1].close),b=Number(recent[i].close);
        if(a>0&&Number.isFinite(b)) rets.push((b-a)/a);
      }
      const vols=recent.slice(0,-1).map(x=>Number(x.volume)||0);
      const curVol=Number(bar?.volume)||0;
      const avgVol=mean(vols.slice(-20));
      const volumeShock=avgVol?curVol/avgVol:1;
      state.factors.market={
        price:mid??Number(bar?.close)||null,
        spreadBps:Number.isFinite(spreadBps)?spreadBps:null,
        quoteImbalance:imbalance,
        rv20:stdev(rets),
        volumeShock,
        quoteAt:q?.ts||null,
        barAt:bar?.ts||null
      };
      newest=[newest,q?.ts,bar?.ts].filter(Boolean).sort((a,b)=>+new Date(b)-+new Date(a))[0]||newest;
    }
    this.#source("market","OK",newest,"Live quote/bar microstructure from Alpaca");
    await this.recompute();
  }

  async refreshNews(){
    if(!this.alpacaKey||!this.alpacaSecret) throw new Error("Alpaca credentials unavailable for news");
    const symbols=(this.marketEngine?.hotSymbols?.()||[]).slice(0,50);
    if(!symbols.length) return;
    const params=new URLSearchParams({
      symbols:symbols.join(","),limit:"50",sort:"desc",include_content:"false",
      start:new Date(Date.now()-6*60*60*1000).toISOString()
    });
    const res=await fetchWithTimeout("https://data.alpaca.markets/v1beta1/news?"+params,{
      headers:{
        "APCA-API-KEY-ID":this.alpacaKey,
        "APCA-API-SECRET-KEY":this.alpacaSecret,
        accept:"application/json"
      }
    });
    if(!res.ok) throw new Error("Alpaca news HTTP "+res.status);
    const body=await res.json();
    const news=Array.isArray(body.news)?body.news:[];
    const bySymbol=new Map();
    for(const item of news){
      const text=(item.headline||"")+" "+(item.summary||"");
      const scored=scoreText(text);
      const eventAt=item.updated_at||item.created_at||new Date();
      for(const symbol of item.symbols||[]){
        if(!symbols.includes(symbol)) continue;
        const arr=bySymbol.get(symbol)||[];
        arr.push({...item,...scored,eventAt});
        bySymbol.set(symbol,arr);
        await this.#event({
          source:"alpaca_news",externalId:item.id||item.url||crypto.randomUUID(),symbol,
          category:"NEWS",eventAt,headline:item.headline||"",
          sentiment:scored.sentiment,severity:scored.shock,
          payload:{source:item.source,summary:item.summary,url:item.url}
        });
      }
    }
    for(const symbol of symbols){
      const state=this.#ensure(symbol);
      const rows=bySymbol.get(symbol)||[];
      const weighted=rows.map(r=>{
        const ageH=Math.max(0,(Date.now()-+new Date(r.eventAt))/3600000);
        const w=Math.exp(-ageH/2);
        return {score:r.sentiment*w,shock:r.shock*w,w};
      });
      const totalW=weighted.reduce((s,x)=>s+x.w,0);
      const sentiment=totalW?weighted.reduce((s,x)=>s+x.score,0)/totalW:0;
      const shock=weighted.length?Math.max(...weighted.map(x=>x.shock)):0;
      state.factors.news={
        count6h:rows.length,sentiment,shock,
        latestHeadline:rows[0]?.headline||null,
        latestAt:rows[0]?.eventAt||null
      };
    }
    this.#source("news","OK",news[0]?.updated_at||news[0]?.created_at||new Date(),
      "Alpaca market news",{articles:news.length});
    await this.recompute();
  }

  async refreshCorporateActions(){
    if(!this.alpacaKey||!this.alpacaSecret) throw new Error("Alpaca credentials unavailable for corporate actions");
    const symbols=(this.marketEngine?.hotSymbols?.()||[]).slice(0,50);
    if(!symbols.length) return;
    const start=utcDay(addDays(new Date(),-7));
    const end=utcDay(addDays(new Date(),45));
    const params=new URLSearchParams({
      symbols:symbols.join(","),start,end,limit:"1000",sort:"desc",data_quality:"all"
    });
    const res=await fetchWithTimeout("https://data.alpaca.markets/v1/corporate-actions?"+params,{
      headers:{
        "APCA-API-KEY-ID":this.alpacaKey,
        "APCA-API-SECRET-KEY":this.alpacaSecret,
        accept:"application/json"
      }
    });
    if(!res.ok) throw new Error("Alpaca corporate actions HTTP "+res.status);
    const body=await res.json();
    const flat=[];
    for(const [type,items] of Object.entries(body||{})){
      if(!Array.isArray(items)) continue;
      for(const item of items) flat.push({type,item});
    }
    for(const symbol of symbols){
      const state=this.#ensure(symbol);
      const rows=flat.filter(x=>{
        const s=x.item?.symbol||x.item?.old_symbol||x.item?.new_symbol;
        return String(s||"").toUpperCase()===symbol;
      });
      const risk=rows.reduce((m,x)=>{
        const t=String(x.type||"");
        const high=/merger|spin_off|reverse_split|redemption|worthless|rights/.test(t);
        const medium=/split|dividend|name_change|symbol_change/.test(t);
        return Math.max(m,high?.75:medium?.38:.25);
      },0);
      state.factors.corporate={
        count:rows.length,risk,
        types:[...new Set(rows.map(x=>x.type))].slice(0,8),
        next:rows[0]?.item||null
      };
      for(const x of rows.slice(0,10)){
        const item=x.item||{};
        const ext=item.id||item.corporate_action_id||JSON.stringify(item).slice(0,120);
        const at=item.process_date||item.ex_date||item.payable_date||new Date();
        await this.#event({
          source:"alpaca_corporate",externalId:ext,symbol,category:"CORPORATE_ACTION",
          eventAt:at,headline:x.type,sentiment:0,severity:risk,payload:item
        });
      }
    }
    this.#source("corporate","OK",new Date(),"Alpaca corporate actions",{actions:flat.length});
    await this.recompute();
  }

  async refreshOptions(){
    if(!this.alpacaKey||!this.alpacaSecret) throw new Error("Alpaca credentials unavailable for options");
    const symbols=(this.marketEngine?.hotSymbols?.()||[]).filter(s=>!["SPY","QQQ","IWM","XLF","XLK","SMH"].includes(s));
    if(!symbols.length) return;
    const batch=[];
    for(let i=0;i<4&&i<symbols.length;i++) batch.push(symbols[(this.optionsCursor+i)%symbols.length]);
    this.optionsCursor=(this.optionsCursor+batch.length)%symbols.length;

    let newest=null,success=0;
    for(const symbol of batch){
      try{
        const state=this.#ensure(symbol);
        const price=Number(state.factors.market?.price)||0;
        const params=new URLSearchParams({
          feed:"indicative",limit:"250",
          expiration_date_gte:utcDay(new Date()),
          expiration_date_lte:utcDay(addDays(new Date(),45))
        });
        const res=await fetchWithTimeout(
          "https://data.alpaca.markets/v1beta1/options/snapshots/"+encodeURIComponent(symbol)+"?"+params,
          {headers:{
            "APCA-API-KEY-ID":this.alpacaKey,
            "APCA-API-SECRET-KEY":this.alpacaSecret,
            accept:"application/json"
          }},15000
        );
        if(!res.ok){
          state.factors.options={...(state.factors.options||{}),state:"UNAVAILABLE",httpStatus:res.status};
          continue;
        }
        const body=await res.json();
        const snaps=body.snapshots||{};
        const calls=[],puts=[];
        for(const [contract,snap] of Object.entries(snaps)){
          const meta=optionContractMeta(contract);
          if(!meta||!price||Math.abs(meta.strike-price)/price>.12) continue;
          const iv=Number(snap?.greeks?.implied_volatility ?? snap?.implied_volatility);
          if(!Number.isFinite(iv)||iv<=0) continue;
          const quote=snap.latestQuote||snap.latest_quote||{};
          const bid=Number(quote.bp??quote.bid_price),ask=Number(quote.ap??quote.ask_price);
          const row={iv,strike:meta.strike,expiration:meta.expiration,bid,ask};
          (meta.type==="call"?calls:puts).push(row);
          const qt=quote.t||quote.timestamp;
          if(qt && (!newest || +new Date(qt)>+new Date(newest))) newest=qt;
        }
        const callIv=mean(calls.map(x=>x.iv));
        const putIv=mean(puts.map(x=>x.iv));
        const all=[...calls,...puts];
        state.factors.options={
          state:all.length?"OK":"THIN",
          contracts:all.length,callContracts:calls.length,putContracts:puts.length,
          impliedVol:mean(all.map(x=>x.iv)),
          callIv,putIv,putCallIvSkew:putIv-callIv,
          putCallCountRatio:calls.length?puts.length/calls.length:null,
          stress:clamp((mean(all.map(x=>x.iv))-.25)/.75,0,1)
        };
        success++;
      }catch{}
      await sleep(120);
    }
    this.#source("options",success?"OK":"DEGRADED",newest||new Date(),
      "Alpaca indicative options chain",{symbolsAttempted:batch.length,symbolsUpdated:success});
    await this.recompute();
  }

  async #loadSecTickerMap(){
    const res=await fetchWithTimeout("https://www.sec.gov/files/company_tickers.json",{
      headers:{"User-Agent":this.secUserAgent,Accept:"application/json"}
    });
    if(!res.ok) throw new Error("SEC ticker map HTTP "+res.status);
    const body=await res.json();
    this.secTickerMap.clear();
    for(const row of Object.values(body||{})){
      if(row?.ticker&&row?.cik_str!=null){
        this.secTickerMap.set(String(row.ticker).toUpperCase(),String(row.cik_str).padStart(10,"0"));
      }
    }
  }

  async refreshSec(){
    if(!this.secTickerMap.size) await this.#loadSecTickerMap();
    const symbols=this.marketEngine?.hotSymbols?.()||[];
    if(!symbols.length) return;
    const batch=[];
    for(let i=0;i<6&&i<symbols.length;i++) batch.push(symbols[(this.secCursor+i)%symbols.length]);
    this.secCursor=(this.secCursor+batch.length)%symbols.length;
    let newest=null,success=0;

    for(const symbol of batch){
      const cik=this.secTickerMap.get(symbol);
      if(!cik) continue;
      try{
        const res=await fetchWithTimeout("https://data.sec.gov/submissions/CIK"+cik+".json",{
          headers:{"User-Agent":this.secUserAgent,Accept:"application/json"}
        });
        if(!res.ok) continue;
        const body=await res.json();
        const recent=body?.filings?.recent||{};
        const forms=recent.form||[];
        const state=this.#ensure(symbol);
        const rows=[];
        for(let i=0;i<Math.min(forms.length,30);i++){
          const filingDate=recent.filingDate?.[i];
          if(!filingDate) continue;
          const age=daysBetween(filingDate,new Date());
          if(age>21) continue;
          const form=forms[i];
          const risk=SEC_FORM_RISK[form]??.25;
          rows.push({
            form,risk,filingDate,
            accession:recent.accessionNumber?.[i]||"",
            primaryDocument:recent.primaryDocument?.[i]||""
          });
        }
        const offeringRisk=rows.filter(x=>/S-3|424B|FWP/.test(x.form)).reduce((m,x)=>Math.max(m,x.risk),0);
        const activistRisk=rows.filter(x=>/13D/.test(x.form)).reduce((m,x)=>Math.max(m,x.risk),0);
        const insiderActivity=rows.filter(x=>/^4/.test(x.form)).length;
        const filingRisk=rows.reduce((m,x)=>Math.max(m,x.risk),0);
        state.factors.sec={
          company:body.name||null,cik,filings21d:rows.length,
          filingRisk,offeringRisk,activistRisk,insiderActivity,
          forms:rows.slice(0,12)
        };
        for(const x of rows.slice(0,12)){
          newest=!newest||+new Date(x.filingDate)>+new Date(newest)?x.filingDate:newest;
          await this.#event({
            source:"sec_edgar",externalId:x.accession||symbol+"-"+x.form+"-"+x.filingDate,
            symbol,category:"SEC_FILING",eventAt:x.filingDate,
            headline:x.form+" filing",sentiment:0,severity:x.risk,
            payload:{cik,primaryDocument:x.primaryDocument}
          });
        }
        success++;
      }catch{}
      await sleep(140);
    }
    this.#source("sec",success?"OK":"DEGRADED",newest||new Date(),
      "SEC EDGAR submissions",{symbolsAttempted:batch.length,symbolsUpdated:success});
    await this.recompute();
  }

  async #fredSeries(id){
    const res=await fetchWithTimeout("https://fred.stlouisfed.org/graph/fredgraph.csv?id="+encodeURIComponent(id),{},15000);
    if(!res.ok) throw new Error("FRED "+id+" HTTP "+res.status);
    const text=await res.text();
    const lines=text.trim().split(/\r?\n/).slice(1);
    const rows=lines.map(line=>{
      const [date,val]=line.split(",");
      const value=Number(val);
      return {date,value:Number.isFinite(value)?value:NaN};
    });
    const latest=latestFinite(rows),prev=previousFinite(rows);
    return {id,latest,previous:prev};
  }

  async refreshMacro(){
    const ids=["VIXCLS","DGS2","DGS10","T10Y2Y","DFF","BAMLH0A0HYM2","DTWEXBGS"];
    const results=await Promise.allSettled(ids.map(id=>this.#fredSeries(id)));
    const macro={};
    for(const r of results){
      if(r.status!=="fulfilled") continue;
      const v=r.value;
      macro[v.id]={
        value:v.latest?.value??null,date:v.latest?.date??null,
        previous:v.previous?.value??null,
        change:v.latest&&v.previous?v.latest.value-v.previous.value:null
      };
    }
    const vix=Number(macro.VIXCLS?.value)||0;
    const hy=Number(macro.BAMLH0A0HYM2?.value)||0;
    const curve=Number(macro.T10Y2Y?.value)||0;
    const d10chg=Math.abs(Number(macro.DGS10?.change)||0);
    const macroStress=clamp(
      .40*clamp((vix-15)/25,0,1)+
      .30*clamp((hy-3)/7,0,1)+
      .15*clamp((-curve)/1.0,0,1)+
      .15*clamp(d10chg/.25,0,1),
      0,1
    );
    this.global.macro={...macro,stress:macroStress,updatedAt:new Date().toISOString()};
    const dates=Object.values(macro).map(x=>x?.date).filter(Boolean).sort();
    this.#source("macro",Object.keys(macro).length>=4?"OK":"DEGRADED",dates.at(-1)||new Date(),
      "FRED macro/rates/volatility",{series:Object.keys(macro)});
    await this.recompute();
  }

  async refreshFedRisk(){
    const today=utcDay(new Date());
    const next=FOMC_DATES.find(d=>d>=today)||null;
    const days=next==null?null:daysBetween(today,next);
    const risk=days==null?0:days<=0?1:days<=1?.92:days<=3?.72:days<=7?.42:.10;
    this.global.fed={
      nextFomcDate:next,daysToFomc:days,risk,
      calendarSource:"Federal Reserve published FOMC schedule"
    };
    this.#source("fed","OK",new Date(),"FOMC calendar risk",{nextFomcDate:next,daysToFomc:days});
    await this.recompute();
  }

  async refreshFinraShortVolume(){
    const symbols=new Set(this.marketEngine?.hotSymbols?.()||[]);
    if(!symbols.size) return;
    let text=null,dataDate=null;
    for(let back=0;back<7;back++){
      const d=addDays(new Date(),-back);
      const p=etNowParts();
      if(["Sat","Sun"].includes(new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",weekday:"short"}).format(d))) continue;
      const day=ymdCompact(d);
      const res=await fetchWithTimeout("https://cdn.finra.org/equity/regsho/daily/CNMSshvol"+day+".txt",{},12000).catch(()=>null);
      if(res?.ok){
        text=await res.text();dataDate=utcDay(d);break;
      }
    }
    if(!text) throw new Error("No recent FINRA consolidated NMS short-volume file found");
    const seen=new Set();
    for(const line of text.split(/\r?\n/).slice(1)){
      const [date,symbol,shortVol,shortExempt,totalVol]=line.split("|");
      if(!symbols.has(symbol)) continue;
      const short=Number(shortVol)||0,exempt=Number(shortExempt)||0,total=Number(totalVol)||0;
      const state=this.#ensure(symbol);
      state.factors.short={
        date:dataDate,shortVolume:short,shortExemptVolume:exempt,totalVolume:total,
        shortVolumeRatio:total?(short+exempt)/total:null
      };
      seen.add(symbol);
    }
    this.#source("finra","OK",dataDate,"FINRA consolidated daily short-sale volume",{symbolsUpdated:seen.size});
    await this.recompute();
  }

  async recompute(){
    if(!this.enabled) return;
    const sources=["market","news","sec","corporate","options","macro","fed","finra"];
    const now=Date.now();
    const fresh=sources.filter(name=>{
      const s=this.sourceStatus[name];
      if(!s||s.state==="ERROR") return false;
      const checked=+new Date(s.checkedAt||0);
      const ttl=name==="market"?2*60*1000:name==="news"?10*60*1000:name==="sec"?30*60*1000:name==="options"?30*60*1000:2*60*60*1000;
      return checked&&now-checked<ttl;
    });
    const coverage=fresh.length/sources.length;
    const macroStress=Number(this.global.macro?.stress)||0;
    const fedRisk=Number(this.global.fed?.risk)||0;
    let globalEventRisk=Math.max(macroStress*.75,fedRisk);

    for(const symbol of this.marketEngine?.hotSymbols?.()||[]){
      const state=this.#ensure(symbol);
      const f=state.factors||{};
      const newsShock=Number(f.news?.shock)||0;
      const filingRisk=Number(f.sec?.filingRisk)||0;
      const offeringRisk=Number(f.sec?.offeringRisk)||0;
      const corpRisk=Number(f.corporate?.risk)||0;
      const optionStress=Number(f.options?.stress)||0;
      const spreadRisk=clamp((Number(f.market?.spreadBps)||0)/35,0,1);
      const volumeShock=clamp(((Number(f.market?.volumeShock)||1)-1)/4,0,1);
      const shortRatio=Number(f.short?.shortVolumeRatio);
      const shortPressure=Number.isFinite(shortRatio)?clamp((shortRatio-.45)/.35,0,1):0;
      const risk=clamp(
        .20*newsShock+
        .14*filingRisk+
        .12*offeringRisk+
        .08*corpRisk+
        .12*optionStress+
        .10*macroStress+
        .08*fedRisk+
        .07*spreadRisk+
        .04*volumeShock+
        .05*shortPressure,
        0,1
      );
      const catalyst=clamp(Number(f.news?.sentiment)||0,-1,1);
      const symbolCoverage=["market","news","sec","corporate","macro","fed","finra"]
        .filter(name=>fresh.includes(name)).length/7;
      const uncertainty=clamp(1-symbolCoverage+.20*(f.options?.state==="UNAVAILABLE"?.5:0),0,1);
      state.riskScore=risk;
      state.uncertainty=uncertainty;
      state.catalystScore=catalyst;
      state.updatedAt=new Date().toISOString();
      globalEventRisk=Math.max(globalEventRisk,risk);

      await this.db.pool.query(`
        INSERT INTO world_symbol_state(symbol,updated_at,risk_score,uncertainty,catalyst_score,factors)
        VALUES($1,NOW(),$2,$3,$4,$5::jsonb)
        ON CONFLICT(symbol) DO UPDATE SET
          updated_at=NOW(),risk_score=EXCLUDED.risk_score,uncertainty=EXCLUDED.uncertainty,
          catalyst_score=EXCLUDED.catalyst_score,factors=EXCLUDED.factors
      `,[symbol,risk,uncertainty,catalyst,JSON.stringify(f)]);
    }

    this.global={
      ...this.global,
      updatedAt:new Date().toISOString(),
      sourceCoverage:coverage,
      eventRisk:globalEventRisk,
      uncertainty:clamp(1-coverage,0,1),
      missingSources:sources.filter(x=>!fresh.includes(x))
    };
    await this.db.pool.query(`
      INSERT INTO world_global_state(id,updated_at,state)
      VALUES(1,NOW(),$1::jsonb)
      ON CONFLICT(id) DO UPDATE SET updated_at=NOW(),state=EXCLUDED.state
    `,[JSON.stringify(this.global)]);
    this.emit("update",this.status());
  }
}

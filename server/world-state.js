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

const SEC_CIK_SEEDS={
  AAPL:"0000320193",MSFT:"0000789019",NVDA:"0001045810",AMZN:"0001018724",
  META:"0001326801",GOOGL:"0001652044",GOOG:"0001652044",TSLA:"0001318605",
  AMD:"0000002488",AVGO:"0001730168",NFLX:"0001065280",PLTR:"0001321655",
  COIN:"0001679788",JPM:"0000019617",BAC:"0000070858",INTC:"0000050863",
  MU:"0000723125",UBER:"0001543151",HOOD:"0001783879"
};

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

function zonedNyToUtc({year,month,day,hour=0,minute=0,second=0}){
  const desired=Date.UTC(year,month-1,day,hour,minute,second);
  let guess=desired;
  const fmt=new Intl.DateTimeFormat("en-US",{
    timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit",
    hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"
  });
  for(let i=0;i<3;i++){
    const p=Object.fromEntries(fmt.formatToParts(new Date(guess))
      .filter(x=>x.type!=="literal").map(x=>[x.type,x.value]));
    const actual=Date.UTC(Number(p.year),Number(p.month)-1,Number(p.day),Number(p.hour),Number(p.minute),Number(p.second));
    guess+=desired-actual;
  }
  return new Date(guess);
}

function parseIcsDate(line){
  const value=String(line||"").split(":").at(-1)||"";
  const m=value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if(!m) return null;
  const parts={year:Number(m[1]),month:Number(m[2]),day:Number(m[3]),hour:Number(m[4]||0),minute:Number(m[5]||0),second:Number(m[6]||0)};
  return m[7]?new Date(Date.UTC(parts.year,parts.month-1,parts.day,parts.hour,parts.minute,parts.second)):zonedNyToUtc(parts);
}

function parseIcsEvents(text=""){
  const unfolded=String(text).replace(/\r?\n[ \t]/g,"");
  const blocks=unfolded.split("BEGIN:VEVENT").slice(1);
  return blocks.map(block=>{
    const lines=block.split(/\r?\n/);
    const dt=lines.find(x=>x.startsWith("DTSTART"));
    const summary=lines.find(x=>x.startsWith("SUMMARY"));
    const uid=lines.find(x=>x.startsWith("UID"));
    return {
      at:parseIcsDate(dt),
      title:summary?summary.slice(summary.indexOf(":")+1).replace(/\\,/g,",").replace(/\\n/g," "):"",
      uid:uid?uid.slice(uid.indexOf(":")+1):null
    };
  }).filter(x=>x.at&&x.title);
}

function proximityRisk(at,{maxDays=7}={}){
  const hours=(+new Date(at)-Date.now())/3600000;
  if(hours<-.5) return 0;
  if(hours<=1) return 1;
  if(hours<=4) return .90;
  if(hours<=24) return .75;
  if(hours<=72) return .55;
  if(hours<=maxDays*24) return .30;
  return .08;
}

function cleanXml(value=""){
  return String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,"$1")
    .replace(/<[^>]+>/g," ")
    .replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">")
    .replace(/&#39;/g,"'").replace(/&quot;/g,'"')
    .replace(/\s+/g," ").trim();
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
      updatedAt:null,macro:{},fed:{},economicCalendar:{},crossAsset:{},sourceCoverage:0,eventRisk:0,uncertainty:1,unobservableShockReserve:.15
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
    await this.#safe("economic_calendar",()=>this.refreshEconomicCalendar());
    await this.#safe("macro",()=>this.refreshMacro());
    await this.#safe("cross_asset",()=>this.refreshCrossAsset());
    await this.#safe("news",()=>this.refreshNews());
    await this.#safe("earnings",()=>this.refreshEarningsCalendar());
    await this.#safe("halts",()=>this.refreshTradingHalts());
    await this.#safe("corporate",()=>this.refreshCorporateActions());
    await this.#safe("finra",()=>this.refreshFinraShortVolume());
    await this.#safe("sec",()=>this.refreshSec());
    await this.#safe("options",()=>this.refreshOptions());
    await this.recompute();

    this.timers.push(setInterval(()=>this.#safe("market",()=>this.refreshMarketFactors()),15000));
    this.timers.push(setInterval(()=>this.#safe("news",()=>this.refreshNews()),45000));
    this.timers.push(setInterval(()=>this.#safe("halts",()=>this.refreshTradingHalts()),60*1000));
    this.timers.push(setInterval(()=>this.#safe("sec",()=>this.refreshSec()),5*60*1000));
    this.timers.push(setInterval(()=>this.#safe("options",()=>this.refreshOptions()),4*60*1000));
    this.timers.push(setInterval(()=>this.#safe("cross_asset",()=>this.refreshCrossAsset()),5*60*1000));
    this.timers.push(setInterval(()=>this.#safe("earnings",()=>this.refreshEarningsCalendar()),30*60*1000));
    this.timers.push(setInterval(()=>this.#safe("corporate",()=>this.refreshCorporateActions()),15*60*1000));
    this.timers.push(setInterval(()=>this.#safe("macro",()=>this.refreshMacro()),15*60*1000));
    this.timers.push(setInterval(()=>this.#safe("economic_calendar",()=>this.refreshEconomicCalendar()),60*60*1000));
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
      blockProof:Boolean(
        (Number(state.riskScore)||0)>=.90 ||
        Boolean(state.factors?.halt?.active) ||
        (Number(state.factors?.earnings?.risk)||0)>=.90 ||
        (Number(this.global.economicCalendar?.risk)||0)>=.95 ||
        (Number(this.global.fed?.risk)||0)>=.98
      ),
      factors:state.factors||{},
      updatedAt:state.updatedAt||null,
      global:{
        macro:this.global.macro||{},
        fed:this.global.fed||{},
        economicCalendar:this.global.economicCalendar||{},
        crossAsset:this.global.crossAsset||{},
        eventRisk:Number(this.global.eventRisk)||0,
        sourceCoverage:Number(this.global.sourceCoverage)||0,
        unobservableShockReserve:Number(this.global.unobservableShockReserve)||0
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
    console.log(JSON.stringify({
      event:"world_source_status",source:name,state,
      dataAt:this.sourceStatus[name].dataAt,detail,meta
    }));
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
        price:mid ?? (Number(bar?.close)||null),
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
        return Math.max(m,high ? .75 : (medium ? .38 : .25));
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
    const headers={
      "User-Agent":this.secUserAgent,
      "Accept":"application/json,text/plain,*/*",
      "Accept-Language":"en-US,en;q=0.9",
      "Accept-Encoding":"gzip, deflate"
    };
    this.secTickerMap.clear();
    for(const [ticker,cik] of Object.entries(SEC_CIK_SEEDS)) this.secTickerMap.set(ticker,cik);

    const attempts=[
      {url:"https://www.sec.gov/files/company_tickers.json",kind:"json"},
      {url:"https://www.sec.gov/files/company_tickers_exchange.json",kind:"exchange"},
      {url:"https://www.sec.gov/include/ticker.txt",kind:"text"}
    ];

    const errors=[];
    for(const attempt of attempts){
      try{
        const res=await fetchWithTimeout(attempt.url,{headers},15000);
        if(!res.ok){
          errors.push(attempt.kind+":"+res.status);
          continue;
        }
        if(attempt.kind==="json"){
          const body=await res.json();
          for(const row of Object.values(body||{})){
            if(row?.ticker&&row?.cik_str!=null){
              this.secTickerMap.set(String(row.ticker).toUpperCase(),String(row.cik_str).padStart(10,"0"));
            }
          }
        }else if(attempt.kind==="exchange"){
          const body=await res.json();
          const fields=body.fields||[];
          const ti=fields.indexOf("ticker"),ci=fields.indexOf("cik");
          for(const row of body.data||[]){
            if(ti>=0&&ci>=0&&row[ti]&&row[ci]!=null){
              this.secTickerMap.set(String(row[ti]).toUpperCase(),String(row[ci]).padStart(10,"0"));
            }
          }
        }else{
          const text=await res.text();
          for(const line of text.split(/\r?\n/)){
            const [ticker,cik]=line.trim().split(/\s+/);
            if(ticker&&cik) this.secTickerMap.set(ticker.toUpperCase(),String(cik).padStart(10,"0"));
          }
        }
        if(this.secTickerMap.size>Object.keys(SEC_CIK_SEEDS).length) return;
      }catch(err){
        errors.push(attempt.kind+":"+String(err?.message||err));
      }
    }

    if(this.secTickerMap.size){
      console.log(JSON.stringify({
        event:"sec_ticker_map_fallback",
        seeded:this.secTickerMap.size,
        errors
      }));
      return;
    }
    throw new Error("SEC ticker map unavailable: "+errors.join(", "));
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
          headers:{
            "User-Agent":this.secUserAgent,
            "Accept":"application/json",
            "Accept-Language":"en-US,en;q=0.9",
            "Accept-Encoding":"gzip, deflate"
          }
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

  async refreshEconomicCalendar(){
    const now=Date.now();
    const horizon=now+14*24*60*60*1000;
    const events=[];
    let blsOk=false,beaOk=false;

    try{
      const res=await fetchWithTimeout("https://www.bls.gov/schedule/news_release/bls.ics",{
        headers:{"User-Agent":this.secUserAgent,Accept:"text/calendar,text/plain,*/*"}
      },15000);
      if(res.ok){
        const text=await res.text();
        for(const ev of parseIcsEvents(text)){
          const t=+new Date(ev.at);
          if(t<now-60*60*1000||t>horizon) continue;
          const title=ev.title;
          let severity=.35;
          if(/Consumer Price Index|Employment Situation/i.test(title)) severity=.98;
          else if(/Producer Price Index|Employment Cost Index/i.test(title)) severity=.86;
          else if(/Job Openings|JOLTS|Productivity and Costs/i.test(title)) severity=.70;
          else if(/Import and Export Price|Real Earnings/i.test(title)) severity=.58;
          else continue;
          events.push({source:"BLS",id:ev.uid||("BLS-"+title+"-"+ev.at.toISOString()),title,at:ev.at,severity});
        }
        blsOk=true;
      }
    }catch{}

    try{
      const res=await fetchWithTimeout("https://apps.bea.gov/API/signup/release_dates.json",{
        headers:{"User-Agent":this.secUserAgent,Accept:"application/json"}
      },15000);
      if(res.ok){
        const body=await res.json();
        for(const [title,obj] of Object.entries(body||{})){
          if(title==="file_last_updated"||!obj?.release_dates) continue;
          let severity=.35;
          if(/Gross Domestic Product$|Personal Income and Outlays|Corporate Profits/i.test(title)) severity=.92;
          else if(/International Trade in Goods and Services/i.test(title)) severity=.62;
          else if(/International Transactions|Investment Position/i.test(title)) severity=.48;
          else continue;
          for(const raw of obj.release_dates||[]){
            const at=new Date(raw);
            const t=+at;
            if(!Number.isFinite(t)||t<now-60*60*1000||t>horizon) continue;
            events.push({source:"BEA",id:"BEA-"+title+"-"+raw,title,at,severity});
          }
        }
        beaOk=true;
      }
    }catch{}

    events.sort((a,b)=>+a.at-+b.at);
    const dedup=[];
    const seen=new Set();
    for(const ev of events){
      const key=ev.source+"|"+ev.title+"|"+ev.at.toISOString();
      if(seen.has(key)) continue;
      seen.add(key);dedup.push(ev);
    }

    for(const ev of dedup.slice(0,40)){
      await this.#event({
        source:ev.source.toLowerCase()+"_calendar",externalId:ev.id,symbol:"",
        category:"ECONOMIC_CALENDAR",eventAt:ev.at,headline:ev.title,
        sentiment:0,severity:ev.severity,
        payload:{scheduled:true,official:true}
      });
    }

    const next=dedup[0]||null;
    const risk=dedup.reduce((m,ev)=>Math.max(m,ev.severity*proximityRisk(ev.at)),0);
    this.global.economicCalendar={
      risk,
      nextEvent:next?{source:next.source,title:next.title,at:next.at,severity:next.severity}:null,
      upcoming:dedup.slice(0,15).map(x=>({source:x.source,title:x.title,at:x.at,severity:x.severity})),
      updatedAt:new Date().toISOString()
    };
    this.#source(
      "economic_calendar",
      blsOk&&beaOk?"OK":(blsOk||beaOk?"DEGRADED":"ERROR"),
      next?.at||new Date(),
      "Official BLS + BEA scheduled economic releases",
      {bls:blsOk,bea:beaOk,upcoming:dedup.length,risk}
    );
    await this.recompute();
  }

  async refreshEarningsCalendar(){
    const hot=new Set(this.marketEngine?.hotSymbols?.()||[]);
    if(!hot.size) return;
    const bySymbol=new Map([...hot].map(s=>[s,[]]));
    let success=0,totalRows=0,newest=null;

    for(let offset=0;offset<=7;offset++){
      const day=addDays(new Date(),offset);
      const date=utcDay(day);
      try{
        const res=await fetchWithTimeout(
          "https://api.nasdaq.com/api/calendar/earnings?date="+encodeURIComponent(date),
          {headers:{
            "User-Agent":"Mozilla/5.0 (compatible; TradingEye/1.0)",
            "Accept":"application/json, text/plain, */*",
            "Referer":"https://www.nasdaq.com/",
            "Origin":"https://www.nasdaq.com"
          }},12000
        );
        if(!res.ok) continue;
        const body=await res.json();
        const rows=body?.data?.rows||[];
        success++;totalRows+=rows.length;
        for(const row of rows){
          const symbol=String(row.symbol||"").replace(/[^A-Z.]/g,"").toUpperCase();
          if(!hot.has(symbol)) continue;
          const ymd=date.split("-").map(Number);
          const timeLabel=String(row.time||row.timeStatus||row.marketTime||"").toLowerCase();
          const hour=timeLabel.includes("pre")?8:timeLabel.includes("after")?16:12;
          const minute=timeLabel.includes("after")?5:0;
          const at=zonedNyToUtc({year:ymd[0],month:ymd[1],day:ymd[2],hour,minute});
          const risk=clamp(proximityRisk(at,{maxDays:7})*(timeLabel.includes("not")?.85:1),0,1);
          const ev={
            at,risk,date,session:timeLabel||"unknown",
            epsForecast:row.epsForecast||row.eps_forecast||null,
            lastYearEps:row.lastYearEPS||row.last_year_eps||null,
            name:row.name||null
          };
          bySymbol.get(symbol).push(ev);
          newest=!newest||+at>+newest?at:newest;
          await this.#event({
            source:"nasdaq_earnings",externalId:"NASDAQ-EARN-"+symbol+"-"+date,
            symbol,category:"EARNINGS_CALENDAR",eventAt:at,
            headline:(row.name||symbol)+" earnings (estimated calendar)",
            sentiment:0,severity:risk,
            payload:{...ev,estimated:true,calendarProvider:"Nasdaq/Zacks-derived"}
          });
        }
      }catch{}
      await sleep(80);
    }

    for(const symbol of hot){
      const state=this.#ensure(symbol);
      const rows=(bySymbol.get(symbol)||[]).sort((a,b)=>+a.at-+b.at);
      const next=rows[0]||null;
      state.factors.earnings={
        scheduled:Boolean(next),
        risk:next?.risk||0,
        nextAt:next?.at||null,
        session:next?.session||null,
        epsForecast:next?.epsForecast||null,
        estimated:true,
        source:"Nasdaq earnings calendar"
      };
    }

    this.#source(
      "earnings",
      success?"OK":"DEGRADED",
      newest||new Date(),
      "Nasdaq earnings calendar (dates may be estimates)",
      {daysQueried:8,daysSucceeded:success,rows:totalRows,hotSymbols:hot.size}
    );
    await this.recompute();
  }

  async refreshCrossAsset(){
    if(!this.alpacaKey||!this.alpacaSecret) throw new Error("Alpaca credentials unavailable for cross-asset proxies");
    const proxies=["SPY","QQQ","IWM","TLT","GLD","USO","UUP","HYG","XLF","XLK","SMH"];
    const params=new URLSearchParams({symbols:proxies.join(","),feed:"iex"});
    const res=await fetchWithTimeout("https://data.alpaca.markets/v2/stocks/snapshots?"+params,{
      headers:{
        "APCA-API-KEY-ID":this.alpacaKey,
        "APCA-API-SECRET-KEY":this.alpacaSecret,
        accept:"application/json"
      }
    },15000);
    if(!res.ok) throw new Error("Alpaca cross-asset snapshots HTTP "+res.status);
    const body=await res.json();
    const snapshots=body.snapshots||body||{};
    const returns={};
    let newest=null;
    for(const symbol of proxies){
      const snap=snapshots[symbol]||{};
      const cur=Number(snap.dailyBar?.c??snap.daily_bar?.c??snap.latestTrade?.p??snap.latest_trade?.p);
      const prev=Number(snap.prevDailyBar?.c??snap.prev_daily_bar?.c);
      if(cur>0&&prev>0) returns[symbol]=(cur-prev)/prev;
      const ts=snap.latestTrade?.t||snap.latest_trade?.t||snap.minuteBar?.t||snap.minute_bar?.t;
      if(ts&&(!newest||+new Date(ts)>+new Date(newest))) newest=ts;
    }
    const riskOff=clamp(
      .32*clamp(-(returns.SPY||0)/.025,0,1)+
      .18*clamp(-(returns.HYG||0)/.012,0,1)+
      .15*clamp(Math.abs(returns.TLT||0)/.018,0,1)+
      .12*clamp(Math.abs(returns.UUP||0)/.012,0,1)+
      .10*clamp(Math.abs(returns.USO||0)/.035,0,1)+
      .08*clamp(Math.abs(returns.GLD||0)/.025,0,1)+
      .05*clamp(Math.abs((returns.QQQ||0)-(returns.SPY||0))/.02,0,1),
      0,1
    );
    this.global.crossAsset={
      returns,riskOff,updatedAt:new Date().toISOString(),
      proxies:"Equity/bond/gold/oil/dollar/credit ETF proxies"
    };
    this.#source("cross_asset",Object.keys(returns).length>=6?"OK":"DEGRADED",newest||new Date(),
      "Alpaca cross-asset ETF stress proxies",{symbols:Object.keys(returns),riskOff});
    await this.recompute();
  }

  async refreshTradingHalts(){
    const hot=this.marketEngine?.hotSymbols?.()||[];
    const res=await fetchWithTimeout("https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts",{
      headers:{"User-Agent":"Mozilla/5.0 (compatible; TradingEye/1.0)",Accept:"application/rss+xml,text/xml,*/*"}
    },12000);
    if(!res.ok) throw new Error("Nasdaq Trader halt RSS HTTP "+res.status);
    const xml=await res.text();
    const items=[...xml.matchAll(/<item[\s\S]*?<\/item>/gi)].map(m=>m[0]);
    const parsed=items.map(item=>{
      const title=cleanXml(item.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]||"");
      const desc=cleanXml(item.match(/<description[^>]*>([\s\S]*?)<\/description>/i)?.[1]||"");
      const pub=cleanXml(item.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i)?.[1]||"");
      return {title,desc,pub,text:(title+" "+desc).trim()};
    });
    const halted=[];
    for(const symbol of hot){
      const state=this.#ensure(symbol);
      const match=parsed.find(x=>new RegExp("\\b"+symbol.replace(".","\\.")+"\\b","i").test(x.text));
      state.factors.halt={
        active:Boolean(match),
        risk:match?1:0,
        detail:match?.text||null,
        updatedAt:new Date().toISOString()
      };
      if(match){
        halted.push(symbol);
        await this.#event({
          source:"nasdaq_halts",externalId:"HALT-"+symbol+"-"+(match.pub||utcDay(new Date())),
          symbol,category:"TRADING_HALT",eventAt:match.pub?new Date(match.pub):new Date(),
          headline:match.text||("Trading halt "+symbol),sentiment:0,severity:1,
          payload:{officialNasdaqTrader:true}
        });
      }
    }
    this.#source("halts","OK",new Date(),"Nasdaq Trader current halt/pause RSS",
      {items:parsed.length,haltedHotSymbols:halted});
    await this.recompute();
  }

  async refreshFedRisk(){
    const today=utcDay(new Date());
    const next=FOMC_DATES.find(d=>d>=today)||null;
    const days=next==null?null:daysBetween(today,next);
    const risk=days==null ? 0 : (days<=0 ? 1 : (days<=1 ? .92 : (days<=3 ? .72 : (days<=7 ? .42 : .10))));
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
    const sources=[
      "market","news","sec","corporate","options","macro","fed","finra",
      "economic_calendar","earnings","halts","cross_asset"
    ];
    const now=Date.now();
    const quality={};
    const fresh=sources.filter(name=>{
      const src=this.sourceStatus[name];
      if(!src||src.state==="ERROR") { quality[name]=0; return false; }
      const checked=+new Date(src.checkedAt||0);
      const ttl=name==="market"?2*60*1000:
        name==="news"?10*60*1000:
        name==="halts"?3*60*1000:
        ["sec","options","cross_asset"].includes(name)?30*60*1000:
        name==="earnings"?2*60*60*1000:
        3*60*60*1000;
      const valid=Boolean(checked&&now-checked<ttl);
      quality[name]=valid?(src.state==="OK"?1:.5):0;
      return valid;
    });
    const coverage=sources.reduce((sum,name)=>sum+(quality[name]||0),0)/sources.length;
    const macroStress=Number(this.global.macro?.stress)||0;
    const fedRisk=Number(this.global.fed?.risk)||0;
    const economicRisk=Number(this.global.economicCalendar?.risk)||0;
    const crossAssetRisk=Number(this.global.crossAsset?.riskOff)||0;
    let globalEventRisk=Math.max(macroStress*.75,fedRisk,economicRisk,crossAssetRisk*.70);

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
      const earningsRisk=Number(f.earnings?.risk)||0;
      const haltRisk=Number(f.halt?.risk)||0;
      const unobservableShockReserve=clamp(
        .08+
        .18*macroStress+
        .12*crossAssetRisk+
        .10*newsShock+
        .10*optionStress+
        .10*spreadRisk+
        .25*(1-coverage),
        .08,.60
      );
      const weighted=clamp(
        .14*newsShock+
        .10*filingRisk+
        .09*offeringRisk+
        .06*corpRisk+
        .10*optionStress+
        .08*macroStress+
        .05*fedRisk+
        .09*economicRisk+
        .12*earningsRisk+
        .06*crossAssetRisk+
        .04*spreadRisk+
        .03*volumeShock+
        .04*shortPressure+
        .05*unobservableShockReserve,
        0,1
      );
      const risk=haltRisk>=1?1:weighted;
      const catalyst=clamp(Number(f.news?.sentiment)||0,-1,1);
      const symbolSources=["market","news","sec","corporate","options","macro","fed","finra","economic_calendar","earnings","halts","cross_asset"];
      const symbolCoverage=symbolSources.reduce((sum,name)=>sum+(quality[name]||0),0)/symbolSources.length;
      const uncertainty=clamp(1-symbolCoverage+.10*unobservableShockReserve,0,1);
      state.factors.unknownShock={
        reserve:unobservableShockReserve,
        meaning:"Explicit reserve for unobservable/private/surprise events; not a directional forecast."
      };
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

    const hotStates=(this.marketEngine?.hotSymbols?.()||[]).map(sym=>this.symbols[sym]).filter(Boolean);
    const shockReserve=hotStates.length
      ? Math.max(...hotStates.map(x=>Number(x.factors?.unknownShock?.reserve)||.08))
      : clamp(.08+.25*(1-coverage)+.18*macroStress+.12*crossAssetRisk,.08,.60);
    this.global={
      ...this.global,
      updatedAt:new Date().toISOString(),
      sourceCoverage:coverage,
      sourceQuality:quality,
      eventRisk:globalEventRisk,
      uncertainty:clamp(1-coverage+.10*shockReserve,0,1),
      unobservableShockReserve:shockReserve,
      missingSources:sources.filter(x=>(quality[x]||0)===0),
      degradedSources:sources.filter(x=>(quality[x]||0)>0&&(quality[x]||0)<1)
    };
    await this.db.pool.query(`
      INSERT INTO world_global_state(id,updated_at,state)
      VALUES(1,NOW(),$1::jsonb)
      ON CONFLICT(id) DO UPDATE SET updated_at=NOW(),state=EXCLUDED.state
    `,[JSON.stringify(this.global)]);
    this.emit("update",this.status());
  }
}

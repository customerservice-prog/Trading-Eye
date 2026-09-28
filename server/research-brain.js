import { EventEmitter } from "node:events";
import path from "node:path";
import { Readable } from "node:stream";
import unzipper from "unzipper";
import crypto from "node:crypto";

const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0;
const median=a=>{
  if(!a.length) return 0;
  const x=[...a].sort((p,q)=>p-q);
  const m=Math.floor(x.length/2);
  return x.length%2?x[m]:(x[m-1]+x[m])/2;
};
const stdev=a=>{
  if(a.length<2) return 0;
  const m=mean(a);
  return Math.sqrt(a.reduce((s,x)=>s+(x-m)**2,0)/(a.length-1));
};
const pct=(a,b)=>b?(a-b)/b:0;

function etDate(date=new Date()){
  return new Intl.DateTimeFormat("en-CA",{
    timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit"
  }).format(date);
}
function parseDay(v){
  const s=String(v||"").trim();
  if(/^\d{8}$/.test(s)) return s.slice(0,4)+"-"+s.slice(4,6)+"-"+s.slice(6,8);
  if(/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d=new Date(s);
  return Number.isNaN(+d)?null:d.toISOString().slice(0,10);
}
function num(v){
  const n=Number(v);
  return Number.isFinite(n)?n:null;
}
function safeSymbol(entryPath){
  const base=path.basename(entryPath||"")
    .replace(/\.(txt|csv)$/i,"")
    .replace(/\.us$/i,"")
    .trim()
    .toUpperCase();
  return /^[A-Z0-9.\-]{1,20}$/.test(base)?base:null;
}
function classifyMomentum(r20){
  if(r20>=.12) return "MOM_STRONG_UP";
  if(r20>=.04) return "MOM_UP";
  if(r20<=-.12) return "MOM_STRONG_DOWN";
  if(r20<=-.04) return "MOM_DOWN";
  return "MOM_FLAT";
}
function classifyVol(rv20){
  if(rv20>=.035) return "VOL_HIGH";
  if(rv20<=.012) return "VOL_LOW";
  return "VOL_NORMAL";
}
function classifyVolume(rel){
  if(rel>=2) return "RVOL_2X";
  if(rel>=1.4) return "RVOL_HIGH";
  if(rel<=.65) return "RVOL_LOW";
  return "RVOL_NORMAL";
}
function classifyLocation(close,hi60,lo60){
  const pos=(close-lo60)/Math.max(1e-9,hi60-lo60);
  if(pos>=.9) return "NEAR_60D_HIGH";
  if(pos<=.1) return "NEAR_60D_LOW";
  return "MID_RANGE";
}

export class ResearchBrain extends EventEmitter {
  constructor({
    db,marketEngine,modelLab,deepStudy,
    longHistoryEnabled=false,
    longHistoryProvider="stooq_bulk",
    longHistoryStart="1999-01-01",
    longHistoryUrl="https://stooq.com/db/h/d_us_txt.zip"
  }){
    super();
    this.db=db;
    this.marketEngine=marketEngine;
    this.modelLab=modelLab;
    this.deepStudy=deepStudy;
    this.longHistoryEnabled=Boolean(longHistoryEnabled);
    this.longHistoryProvider=longHistoryProvider;
    this.longHistoryStart=longHistoryStart;
    this.longHistoryUrl=longHistoryUrl;
    this.timer=null;
    this.heartbeatTimer=null;
    this.longHistoryRunning=false;
    this.miningRunning=false;
    this.miningCursor=0;
    this.lastResearchEventAt=null;
    this.lastHeartbeatAt=null;
    this.lastObserved={};
  }

  async init(){
    await this.#event({
      category:"SYSTEM",
      title:"Research Brain online",
      message:"Continuous research worker started. All activity shown here is backed by real jobs/events stored in Postgres.",
      details:{
        longHistoryEnabled:this.longHistoryEnabled,
        longHistoryStart:this.longHistoryStart,
        intradaySource:"Alpaca",
        longHistorySource:this.longHistoryProvider
      }
    });

    await this.#syncJobMirror();
    this.timer=setInterval(()=>this.tick().catch(err=>this.#error("tick",err)),15000);
    this.heartbeatTimer=setInterval(()=>this.#heartbeat().catch(()=>{}),60000);
    setTimeout(()=>this.tick().catch(err=>this.#error("initial_tick",err)),3500);
  }

  stop(){
    clearInterval(this.timer);
    clearInterval(this.heartbeatTimer);
  }

  async status(){
    const [coverage,jobs,events,findings]=await Promise.all([
      this.db.researchCoverage(),
      this.db.researchJobs(),
      this.db.recentResearchEvents({limit:100}),
      this.db.topResearchFindings({limit:60})
    ]);
    return {
      running:true,
      heartbeatAt:this.lastHeartbeatAt,
      lastResearchEventAt:this.lastResearchEventAt,
      sources:{
        intraday:{
          provider:"Alpaca",
          coverageStart:"2016-01-01",
          status:this.marketEngine?.providerStatus?.state||"UNKNOWN",
          note:"Intraday/live and historical SIP/IEX research."
        },
        longHistory:{
          provider:this.longHistoryProvider,
          targetStart:this.longHistoryStart,
          enabled:this.longHistoryEnabled,
          status:this.longHistoryRunning?"SYNCING":(Number(coverage.longHistory?.bars)>0?"READY":"WAITING"),
          note:"Separate daily-history lane; never labeled as Alpaca."
        }
      },
      coverage,jobs,events,findings,
      systems:{
        provider:this.marketEngine?.status?.()||null,
        modelLab:this.modelLab?.status?.()||null,
        deepStudy:this.deepStudy?.status?.()||null
      }
    };
  }

  async tick(){
    await this.#syncJobMirror();

    const coverage=await this.db.researchCoverage();
    if(this.longHistoryEnabled && !this.longHistoryRunning){
      const last=coverage.longHistory?.last?String(coverage.longHistory.last).slice(0,10):null;
      const today=etDate();
      const shouldSync=!coverage.longHistory?.bars || !last || last<today;
      if(shouldSync){
        this.longHistoryRunning=true;
        this.#syncLongHistory()
          .catch(err=>this.#error("long_history",err))
          .finally(()=>{this.longHistoryRunning=false;});
      }
    }

    if(Number(coverage.longHistory?.bars)>0 && !this.miningRunning){
      this.miningRunning=true;
      this.#mineNextBatch()
        .catch(err=>this.#error("pattern_mining",err))
        .finally(()=>{this.miningRunning=false;});
    }
  }

  async #syncJobMirror(){
    const provider=this.marketEngine?.providerStatus||{};
    const backfill=this.marketEngine?.backfill||{};
    const lab=this.modelLab?.status?.()||{};
    const study=this.deepStudy?.status?.()||{};

    await Promise.all([
      this.db.upsertResearchJob({
        jobKey:"live-market-observation",
        jobType:"LIVE_OBSERVATION",
        status:["LIVE","CONNECTED"].includes(provider.state)?"RUNNING":"WAITING",
        phase:provider.state||"WAITING",
        provider:"alpaca",
        progress:["LIVE","CONNECTED"].includes(provider.state)?1:0,
        barsProcessed:0,
        details:{
          feed:provider.feed||null,
          lastEventAt:this.marketEngine?.lastEventAt||null,
          lastBarAt:this.marketEngine?.lastBarAt||null,
          symbols:this.marketEngine?.symbols||[]
        }
      }),
      this.db.upsertResearchJob({
        jobKey:"alpaca-intraday-memory",
        jobType:"INTRADAY_HISTORY",
        status:backfill.state==="RUNNING"?"RUNNING":backfill.state==="ERROR"?"ERROR":"COMPLETE",
        phase:backfill.state,
        provider:"alpaca",
        progress:backfill.state==="COMPLETE"?1:0,
        barsProcessed:Number(backfill.rows)||0,
        details:backfill
      }),
      this.db.upsertResearchJob({
        jobKey:"model-lab",
        jobType:"MODEL_RESEARCH",
        status:lab.training?"RUNNING":"MONITORING",
        phase:lab.training?"TRAINING":lab.shadowModels?.length?"LIVE_SHADOW":"IDLE",
        provider:"internal",
        progress:lab.training?.5:1,
        details:{
          production:lab.production?.modelId||null,
          shadowModels:(lab.shadowModels||[]).map(x=>x.modelId),
          latestRun:lab.latestRun||null
        }
      }),
      this.db.upsertResearchJob({
        jobKey:"post-close-deep-study",
        jobType:"DEEP_STUDY",
        status:study.running?"RUNNING":"MONITORING",
        phase:study.universeState?.phase||study.patternState?.state||"IDLE",
        provider:"alpaca",
        progress:study.running?.5:1,
        itemsDone:Number(study.universeState?.deepAssets)||0,
        barsProcessed:Number(study.universeState?.deepBars)||0,
        details:study
      })
    ]);

    const snapshot={
      provider:provider.state,
      modelRun:lab.latestRun?.runId||null,
      modelRunStatus:lab.latestRun?.status||null,
      production:lab.production?.modelId||null,
      shadows:(lab.shadowModels||[]).map(x=>x.modelId).join(","),
      deepStudy:study.lastStudy?.completedAt||null
    };
    if(JSON.stringify(snapshot)!==JSON.stringify(this.lastObserved)){
      const prev=this.lastObserved;
      this.lastObserved=snapshot;
      if(prev.provider && prev.provider!==snapshot.provider){
        await this.#event({
          category:"LIVE",
          title:"Live market state changed",
          message:`Market feed changed from ${prev.provider} to ${snapshot.provider}.`,
          details:{from:prev.provider,to:snapshot.provider,feed:provider.feed}
        });
      }
      if(prev.modelRun && prev.modelRun!==snapshot.modelRun && snapshot.modelRun){
        await this.#event({
          category:"MODEL",
          title:"New Model Lab run",
          message:`Model Lab started/recorded run ${snapshot.modelRun}.`,
          details:lab.latestRun||{}
        });
      }
      if(prev.production && prev.production!==snapshot.production && snapshot.production){
        await this.#event({
          category:"MODEL",
          level:"IMPORTANT",
          title:"Production model changed",
          message:`Production model is now ${snapshot.production}.`,
          details:{previous:prev.production,current:snapshot.production}
        });
      }
      if(prev.shadows!==undefined && prev.shadows!==snapshot.shadows){
        await this.#event({
          category:"MODEL",
          title:"Live-shadow set changed",
          message:snapshot.shadows
            ?`Live shadow is testing: ${snapshot.shadows}.`
            :"No challenger is currently in live shadow.",
          details:{models:(lab.shadowModels||[])}
        });
      }
    }
  }

  async #heartbeat(){
    this.lastHeartbeatAt=new Date().toISOString();
    const coverage=await this.db.researchCoverage();
    await this.db.upsertResearchJob({
      jobKey:"research-brain-heartbeat",
      jobType:"SYSTEM",
      status:"RUNNING",
      phase:"CONTINUOUS",
      provider:"internal",
      progress:1,
      details:{
        heartbeatAt:this.lastHeartbeatAt,
        intradayBars:coverage.intraday?.bars||0,
        longHistoryBars:coverage.longHistory?.bars||0,
        findings:coverage.findings?.findings||0,
        models:coverage.models||{}
      }
    });
    this.emit("status",{heartbeatAt:this.lastHeartbeatAt});
  }

  async #syncLongHistory(){
    const jobKey="long-history-1999-present";
    const assetStats=await this.db.assetStats();
    await this.db.upsertResearchJob({
      jobKey,jobType:"LONG_HISTORY_INGEST",status:"RUNNING",phase:"DOWNLOADING",
      provider:this.longHistoryProvider,progress:0,itemsDone:0,
      itemsTotal:Number(assetStats.active)||null,barsProcessed:0,
      details:{targetStart:this.longHistoryStart,url:this.longHistoryUrl}
    });
    await this.#event({
      category:"DATA",
      jobKey,
      title:"1999+ long-history sync started",
      message:`Downloading U.S. daily-history bulk data. Bars before ${this.longHistoryStart} are ignored.`,
      details:{provider:this.longHistoryProvider,url:this.longHistoryUrl}
    });

    const res=await fetch(this.longHistoryUrl,{
      headers:{
        "user-agent":"Trading-Eye-Research/1.0",
        "accept":"application/zip,application/octet-stream,*/*"
      }
    });
    if(!res.ok||!res.body) throw new Error(`Long-history bulk HTTP ${res.status}`);

    const zipStream=Readable.fromWeb(res.body).pipe(unzipper.Parse({forceStream:true}));
    let symbolsDone=0,barsProcessed=0,barsStored=0,filesSkipped=0;
    const targetStart=this.longHistoryStart;

    for await (const entry of zipStream){
      if(entry.type!=="File" || !/\.(txt|csv)$/i.test(entry.path||"")){
        entry.autodrain();
        continue;
      }
      const symbol=safeSymbol(entry.path);
      if(!symbol){
        filesSkipped++;
        entry.autodrain();
        continue;
      }

      let text;
      try{
        text=(await entry.buffer()).toString("utf8");
      }catch{
        filesSkipped++;
        continue;
      }
      const parsed=this.#parseLongHistoryFile(symbol,text,targetStart);
      barsProcessed+=parsed.length;
      if(parsed.length){
        barsStored+=await this.db.upsertLongHistoryBars(parsed);
      }
      symbolsDone++;

      if(symbolsDone%100===0){
        const total=Number(assetStats.active)||null;
        await this.db.upsertResearchJob({
          jobKey,jobType:"LONG_HISTORY_INGEST",status:"RUNNING",phase:"PARSING",
          provider:this.longHistoryProvider,
          progress:total?clamp(symbolsDone/total,0,.99):0,
          itemsDone:symbolsDone,itemsTotal:total,barsProcessed,
          details:{barsStored,filesSkipped,targetStart}
        });
        this.emit("status",{jobKey,symbolsDone,barsProcessed,barsStored});
      }
    }

    const coverage=await this.db.researchCoverage();
    await this.db.upsertResearchJob({
      jobKey,jobType:"LONG_HISTORY_INGEST",status:"COMPLETE",phase:"READY",
      provider:this.longHistoryProvider,progress:1,itemsDone:symbolsDone,
      itemsTotal:symbolsDone,barsProcessed,
      completedAt:new Date().toISOString(),
      details:{barsStored,filesSkipped,coverage:coverage.longHistory,targetStart}
    });
    await this.#event({
      category:"DATA",
      jobKey,
      level:"IMPORTANT",
      title:"1999+ long-history sync complete",
      message:`Stored ${barsStored.toLocaleString()} daily bars across ${symbolsDone.toLocaleString()} source files. Coverage now begins ${coverage.longHistory?.first||"unknown"}.`,
      details:{symbolsDone,barsProcessed,barsStored,filesSkipped,coverage:coverage.longHistory}
    });
  }

  #parseLongHistoryFile(symbol,text,startDay){
    const lines=String(text||"").replace(/\r/g,"").split("\n").filter(Boolean);
    if(lines.length<2) return [];
    const delim=lines[0].includes(";")?";":",";
    const header=lines[0].split(delim).map(x=>x.trim().replace(/[<>]/g,"").toUpperCase());
    const idx=name=>header.indexOf(name);
    const dateIdx=idx("DATE");
    const openIdx=idx("OPEN");
    const highIdx=idx("HIGH");
    const lowIdx=idx("LOW");
    const closeIdx=idx("CLOSE");
    const volIdx=Math.max(idx("VOL"),idx("VOLUME"));
    if(dateIdx<0||openIdx<0||highIdx<0||lowIdx<0||closeIdx<0) return [];

    const out=[];
    for(let i=1;i<lines.length;i++){
      const cols=lines[i].split(delim);
      const day=parseDay(cols[dateIdx]);
      if(!day||day<startDay) continue;
      const open=num(cols[openIdx]),high=num(cols[highIdx]),low=num(cols[lowIdx]),close=num(cols[closeIdx]);
      const volume=volIdx>=0?num(cols[volIdx])||0:0;
      if(![open,high,low,close].every(x=>x!=null&&x>0)) continue;
      out.push({
        provider:this.longHistoryProvider,
        symbol,day,open,high,low,close,volume
      });
    }
    return out;
  }

  async #mineNextBatch(){
    const symbols=await this.db.longHistorySymbols({limit:50000});
    if(!symbols.length) return;
    const batchSize=8;
    if(this.miningCursor>=symbols.length) this.miningCursor=0;
    const batch=symbols.slice(this.miningCursor,this.miningCursor+batchSize);
    this.miningCursor=(this.miningCursor+batch.length)%symbols.length;

    const jobKey="long-history-pattern-mining";
    await this.db.upsertResearchJob({
      jobKey,jobType:"PATTERN_MINING",status:"RUNNING",phase:"TESTING_PATTERNS",
      provider:this.longHistoryProvider,
      progress:symbols.length?this.miningCursor/symbols.length:0,
      itemsDone:this.miningCursor,itemsTotal:symbols.length,barsProcessed:0,
      details:{currentSymbols:batch.map(x=>x.symbol),start:this.longHistoryStart}
    });

    let barsProcessed=0,findingsStored=0;
    for(const meta of batch){
      const rows=await this.db.getLongHistoryBars(meta.symbol,{start:this.longHistoryStart,limit:10000});
      barsProcessed+=rows.length;
      const findings=this.#mineSymbol(meta.symbol,rows);
      for(const finding of findings){
        await this.db.upsertResearchFinding(finding);
        findingsStored++;
      }
    }

    await this.db.upsertResearchJob({
      jobKey,jobType:"PATTERN_MINING",status:"RUNNING",phase:"ROTATING",
      provider:this.longHistoryProvider,
      progress:symbols.length?this.miningCursor/symbols.length:0,
      itemsDone:this.miningCursor,itemsTotal:symbols.length,barsProcessed,
      details:{lastSymbols:batch.map(x=>x.symbol),findingsStored}
    });

    if(findingsStored){
      await this.#event({
        category:"PATTERN",
        jobKey,
        title:"Historical patterns updated",
        message:`Tested ${batch.length} symbols / ${barsProcessed.toLocaleString()} daily bars and updated ${findingsStored} statistically filtered findings.`,
        details:{symbols:batch.map(x=>x.symbol),barsProcessed,findingsStored}
      });
    }
  }

  #mineSymbol(symbol,rawRows){
    const rows=(rawRows||[]).map(r=>({
      day:String(r.day).slice(0,10),
      open:Number(r.open),high:Number(r.high),low:Number(r.low),
      close:Number(r.close),volume:Number(r.volume)||0
    })).filter(r=>r.close>0);
    if(rows.length<260) return [];

    const groups=new Map();
    for(let i=80;i<rows.length-65;i++){
      const close=rows[i].close;
      const r20=pct(close,rows[i-20].close);
      const daily=[];
      for(let j=i-20;j<i;j++) daily.push(pct(rows[j+1].close,rows[j].close));
      const rv20=stdev(daily);
      const avgVol=mean(rows.slice(i-20,i).map(x=>x.volume));
      const relVol=avgVol?rows[i].volume/avgVol:1;
      const hi60=Math.max(...rows.slice(i-59,i+1).map(x=>x.high));
      const lo60=Math.min(...rows.slice(i-59,i+1).map(x=>x.low));
      const patternKey=[
        classifyMomentum(r20),
        classifyVol(rv20),
        classifyVolume(relVol),
        classifyLocation(close,hi60,lo60)
      ].join("|");

      let g=groups.get(patternKey);
      if(!g){ g={patternKey,samples:[]}; groups.set(patternKey,g); }

      const horizons={};
      for(const h of [5,20,60]){
        const future=rows[i+h];
        if(!future) continue;
        const path=rows.slice(i+1,i+h+1);
        const ret=pct(future.close,close);
        const favorable=Math.max(...path.map(x=>pct(x.high,close)));
        const adverse=Math.min(...path.map(x=>pct(x.low,close)));
        horizons[h]={return:ret,favorable,adverse};
      }
      g.samples.push({day:rows[i].day,horizons});
    }

    const findings=[];
    for(const g of groups.values()){
      for(const h of [5,20,60]){
        const samples=g.samples.map(x=>({day:x.day,...x.horizons[h]})).filter(x=>x.return!=null);
        if(samples.length<40) continue;
        const returns=samples.map(x=>x.return);
        const hitRate=returns.filter(x=>x>0).length/returns.length;
        const avgReturn=mean(returns);
        const medReturn=median(returns);
        const avgFav=mean(samples.map(x=>x.favorable));
        const avgAdv=mean(samples.map(x=>x.adverse));
        const edge=Math.abs(hitRate-.5);
        const score=edge*Math.sqrt(samples.length)+Math.abs(avgReturn)*12;
        if(edge<.075 && Math.abs(avgReturn)<.012) continue;
        const status=samples.length>=100 && edge>=.10 && Math.abs(avgReturn)>=.01?"PROMOTED":"CANDIDATE";
        const direction=avgReturn>=0?"positive":"negative";
        const findingId=crypto
          .createHash("sha1")
          .update([this.longHistoryProvider,symbol,g.patternKey,h].join("|"))
          .digest("hex");
        findings.push({
          findingId,
          provider:this.longHistoryProvider,
          scope:"SYMBOL_DAILY",
          symbol,
          patternKey:g.patternKey,
          horizonDays:h,
          sampleCount:samples.length,
          hitRate,
          avgForwardReturn:avgReturn,
          medianForwardReturn:medReturn,
          avgAdverseReturn:avgAdv,
          avgFavorableReturn:avgFav,
          score,
          status,
          description:`${symbol}: ${g.patternKey.replaceAll("|"," + ")} historically had a ${direction} average ${h}-day outcome across ${samples.length} observations.`,
          evidence:{
            start:samples[0]?.day,
            end:samples.at(-1)?.day,
            examples:samples.slice(-8)
          }
        });
      }
    }
    return findings.sort((a,b)=>b.score-a.score).slice(0,12);
  }

  async #event(event){
    const saved=await this.db.addResearchEvent(event);
    if(saved){
      this.lastResearchEventAt=saved.event_ts;
      this.emit("event",saved);
    }
    return saved;
  }

  async #error(area,err){
    const message=String(err?.message||err);
    await this.#event({
      category:"ERROR",level:"ERROR",
      title:"Research worker error",
      message:`${area}: ${message}`,
      details:{area}
    });
    if(area==="long_history"){
      await this.db.upsertResearchJob({
        jobKey:"long-history-1999-present",jobType:"LONG_HISTORY_INGEST",
        status:"ERROR",phase:"ERROR",provider:this.longHistoryProvider,
        progress:0,error:message,details:{targetStart:this.longHistoryStart}
      });
    }
  }
}

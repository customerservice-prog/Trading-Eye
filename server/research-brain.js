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
    longHistoryUrl="https://static.stooq.com/db/h/d_us_txt.zip",
    longHistoryApiKey="",
    symbolFallbackEnabled=true,
    historicalIntegrityVerified=false,
    role="all"
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
    this.longHistoryApiKey=String(longHistoryApiKey||"");
    this.symbolFallbackEnabled=Boolean(symbolFallbackEnabled);
    this.historicalIntegrityVerified=Boolean(historicalIntegrityVerified);
    this.role=String(role||"all").toLowerCase();
    this.longHistoryRetryAfter=0;
    this.longHistoryAuthNoticeSent=false;
    this.githubMirrorManifest=null;
    this.githubMirrorCursor=0;
    this.timer=null;
    this.heartbeatTimer=null;
    this.longHistoryRunning=false;
    this.miningRunning=false;
    this.miningCursor=0;
    this.lastResearchEventAt=null;
    this.lastHeartbeatAt=null;
    this.lastObserved={};
    this.sessionStartEventId=null;
  }

  async init(){
    const validationVersion="v3_baseline_excess";
    const demoted=await this.db.demoteLegacyResearchFindings(validationVersion);
    const startEvent=await this.#event({
      category:"SYSTEM",
      title:"Research Brain online",
      message:"Continuous research worker started. All activity shown here is backed by real jobs/events stored in Postgres.",
      details:{
        longHistoryEnabled:this.longHistoryEnabled,
        longHistoryStart:this.longHistoryStart,
        intradaySource:"Alpaca",
        longHistorySource:this.longHistoryProvider,
        role:this.role,
        legacyPromotionsDemoted:demoted
      }
    });
    if(demoted){
      await this.#event({
        category:"PATTERN",
        level:"IMPORTANT",
        title:"Legacy pattern promotions reset for stronger validation",
        message:`${demoted} older findings were relabeled LEGACY_UNVALIDATED until they pass the new discovery → validation → holdout pipeline.`,
        details:{demoted,validationVersion}
      });
    }
    this.sessionStartEventId=Number(startEvent?.id)||null;

    if(this.role!=="long_history") await this.#syncJobMirror();
    this.timer=setInterval(()=>this.tick().catch(err=>this.#error("tick",err)),15000);
    this.heartbeatTimer=setInterval(()=>this.#heartbeat().catch(()=>{}),60000);
    setTimeout(()=>this.tick().catch(err=>this.#error("initial_tick",err)),3500);
  }

  stop(){
    clearInterval(this.timer);
    clearInterval(this.heartbeatTimer);
  }

  async status(){
    const [coverage,jobs,allEvents,findings]=await Promise.all([
      this.db.researchCoverage(),
      this.db.researchJobs(),
      this.db.recentResearchEvents({limit:160}),
      this.db.topResearchFindings({limit:60})
    ]);
    const events=this.sessionStartEventId
      ? allEvents.filter(e=>Number(e.id)>=this.sessionStartEventId)
      : allEvents.slice(-100);
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
          keyConfigured:Boolean(this.longHistoryApiKey),
          fallbackEnabled:this.symbolFallbackEnabled,
          status:this.longHistoryRunning
            ?"SYNCING"
            :Number(coverage.longHistory?.bars)>0
              ?"READY"
              :this.longHistoryEnabled&&!this.longHistoryApiKey&&this.symbolFallbackEnabled
                ?"TRYING_PUBLIC_CSV"
                :this.longHistoryEnabled&&!this.longHistoryApiKey
                  ?"AUTH_REQUIRED"
                  :"WAITING",
          note:"Separate daily-history lane; never labeled as Alpaca.",
          integrity:{
            status:this.historicalIntegrityVerified?"VERIFIED":"UNVERIFIED",
            survivorshipAndDelistings:this.historicalIntegrityVerified?"VERIFIED":"UNVERIFIED",
            corporateActions:this.historicalIntegrityVerified?"VERIFIED":"UNVERIFIED",
            realMoneyGateBlocked:!this.historicalIntegrityVerified,
            note:this.historicalIntegrityVerified
              ?"Historical survivorship/delisting and corporate-action handling has been explicitly verified."
              :"Research may continue, but real-money review stays locked until delistings, ticker changes, splits/dividends, and survivorship handling are genuinely audited."
          }
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
    if(this.role!=="long_history") await this.#syncJobMirror();

    const coverage=await this.db.researchCoverage();
    if(this.role!=="orchestrator" && this.longHistoryEnabled && !this.longHistoryRunning){
      if(!this.longHistoryApiKey){
        if(Date.now()<this.longHistoryRetryAfter) return;
        this.longHistoryRunning=true;
        this.#syncGithubMirrorBatch()
          .catch(err=>this.#error("long_history",err))
          .finally(()=>{this.longHistoryRunning=false;});
        return;
        if(!this.longHistoryAuthNoticeSent){
          this.longHistoryAuthNoticeSent=true;
          await this.#event({
            category:"DATA",
            level:"IMPORTANT",
            jobKey:"long-history-1999-present",
            title:"1999+ research lane is waiting for a free history key",
            message:"Alpaca starts in 2016. The separate long-history lane is ready, but its bulk provider requires a free Stooq download key before ingestion can start.",
            details:{keyUrl:"https://stooq.com/q/d/?s=spy.us&get_apikey"}
          });
        }
        await this.db.upsertResearchJob({
          jobKey:"long-history-1999-present",
          jobType:"LONG_HISTORY_INGEST",
          status:"WAITING",
          phase:"AUTH_REQUIRED",
          provider:this.longHistoryProvider,
          progress:0,
          details:{
            targetStart:this.longHistoryStart,
            keyRequired:true,
            keyUrl:"https://stooq.com/q/d/?s=spy.us&get_apikey"
          }
        });
        return;
      }
      if(Date.now()<this.longHistoryRetryAfter) return;
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

    if(this.role!=="orchestrator" && Number(coverage.longHistory?.bars)>0 && !this.miningRunning){
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
      jobKey:"research-brain-heartbeat-"+this.role,
      jobType:"SYSTEM",
      status:"RUNNING",
      phase:"CONTINUOUS",
      provider:"internal",
      progress:1,
      details:{
        heartbeatAt:this.lastHeartbeatAt,
        role:this.role,
        intradayBars:coverage.intraday?.bars||0,
        longHistoryBars:coverage.longHistory?.bars||0,
        findings:coverage.findings?.findings||0,
        models:coverage.models||{}
      }
    });
    this.emit("status",{heartbeatAt:this.lastHeartbeatAt});
  }

  #githubRawUrl(repo,path,ref="main"){
    const encoded=String(path).split("/").map(encodeURIComponent).join("/");
    return `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(ref)}/${encoded}`;
  }

  async #loadGithubMirrorManifest(){
    if(this.githubMirrorManifest?.length) return this.githubMirrorManifest;
    const repo="ARKMD/stooq";
    const base="d_us_txt/data/daily/us";
    const res=await fetch(`https://api.github.com/repos/${repo}/contents/${base.split("/").map(encodeURIComponent).join("/")}`,{
      headers:{
        "user-agent":"Trading-Eye-Research/1.0",
        "accept":"application/vnd.github+json"
      }
    });
    if(!res.ok) throw new Error(`GitHub mirror root HTTP ${res.status}`);
    const dirs=await res.json();
    const files=[];
    for(const dir of dirs.filter(x=>x.type==="dir")){
      const treeUrl=String(dir.git_url||"")+(String(dir.git_url||"").includes("?")?"&":"?")+"recursive=1";
      const tr=await fetch(treeUrl,{
        headers:{
          "user-agent":"Trading-Eye-Research/1.0",
          "accept":"application/vnd.github+json"
        }
      });
      if(!tr.ok) throw new Error(`GitHub mirror tree HTTP ${tr.status}`);
      const tree=await tr.json();
      for(const item of tree.tree||[]){
        if(item.type!=="blob"||!/\.us\.txt$/i.test(item.path||"")) continue;
        const name=path.basename(item.path).replace(/\.us\.txt$/i,"").toUpperCase();
        if(!/^[A-Z0-9.\-]{1,20}$/.test(name)) continue;
        files.push({
          symbol:name,
          path:`${base}/${dir.name}/${item.path}`,
          size:Number(item.size)||0,
          sha:item.sha||null
        });
      }
    }
    const dedup=new Map();
    for(const file of files){
      const prev=dedup.get(file.symbol);
      if(!prev||file.size>prev.size) dedup.set(file.symbol,file);
    }
    const priority=["SPY","QQQ","DIA","IWM","AAPL","MSFT","NVDA","AMZN","META","GOOGL","AMD","TSLA"];
    const ordered=[
      ...priority.map(s=>dedup.get(s)).filter(Boolean),
      ...[...dedup.values()].filter(x=>!priority.includes(x.symbol)).sort((a,b)=>a.symbol.localeCompare(b.symbol))
    ];
    this.githubMirrorManifest=ordered;
    return ordered;
  }

  #parseGithubMirrorFile(symbol,text){
    const lines=String(text||"").replace(/\r/g,"").split("\n").filter(Boolean);
    if(lines.length<2) return [];
    const header=lines[0].split(",").map(x=>x.trim().replace(/[<>]/g,"").toUpperCase());
    const idx=name=>header.indexOf(name);
    const dateIdx=idx("DATE");
    const openIdx=idx("OPEN");
    const highIdx=idx("HIGH");
    const lowIdx=idx("LOW");
    const closeIdx=idx("CLOSE");
    const volIdx=idx("VOL");
    if(dateIdx<0||openIdx<0||highIdx<0||lowIdx<0||closeIdx<0) return [];
    const out=[];
    for(let i=1;i<lines.length;i++){
      const cols=lines[i].split(",");
      const day=parseDay(cols[dateIdx]);
      if(!day||day<this.longHistoryStart) continue;
      const open=num(cols[openIdx]),high=num(cols[highIdx]),low=num(cols[lowIdx]),close=num(cols[closeIdx]);
      const volume=volIdx>=0?num(cols[volIdx])||0:0;
      if(![open,high,low,close].every(x=>x!=null&&x>0)) continue;
      out.push({
        provider:"stooq_github_mirror",
        symbol,day,open,high,low,close,volume
      });
    }
    return out;
  }

  async #syncGithubMirrorBatch(){
    const jobKey="long-history-1999-present";
    const manifest=await this.#loadGithubMirrorManifest();
    const existing=new Set((await this.db.longHistorySymbols({limit:50000})).map(x=>x.symbol));
    const pending=manifest.filter(x=>!existing.has(x.symbol));
    const batch=pending.slice(0,40);

    if(!batch.length){
      const coverage=await this.db.researchCoverage();
      await this.db.upsertResearchJob({
        jobKey,jobType:"LONG_HISTORY_INGEST",status:"COMPLETE",phase:"MIRROR_READY",
        provider:"stooq_github_mirror",progress:1,itemsDone:manifest.length,itemsTotal:manifest.length,
        barsProcessed:Number(coverage.longHistory?.bars)||0,
        completedAt:new Date().toISOString(),
        details:{
          sourceRepo:"ARKMD/stooq",
          mirrorSnapshot:"2025-01-10-ish",
          coverage:coverage.longHistory,
          updateLayer:"Alpaca"
        }
      });
      return;
    }

    await this.db.upsertResearchJob({
      jobKey,jobType:"LONG_HISTORY_INGEST",status:"RUNNING",phase:"GITHUB_MIRROR",
      provider:"stooq_github_mirror",
      progress:manifest.length?existing.size/manifest.length:0,
      itemsDone:existing.size,itemsTotal:manifest.length,
      barsProcessed:Number((await this.db.researchCoverage()).longHistory?.bars)||0,
      details:{
        sourceRepo:"ARKMD/stooq",
        batch:batch.map(x=>x.symbol),
        targetStart:this.longHistoryStart
      }
    });

    if(!this.longHistoryAuthNoticeSent){
      this.longHistoryAuthNoticeSent=true;
      await this.#event({
        category:"DATA",
        jobKey,
        level:"IMPORTANT",
        title:"1999+ GitHub mirror bootstrap started",
        message:"Trading Eye found a public Stooq GitHub mirror and is bootstrapping long daily history from it without requiring your CAPTCHA/API key. Newer/live data remains sourced separately from Alpaca.",
        details:{repo:"ARKMD/stooq",files:manifest.length,targetStart:this.longHistoryStart}
      });
    }

    let symbolsDone=0,barsStored=0,misses=0;
    for(const file of batch){
      try{
        const url=this.#githubRawUrl("ARKMD/stooq",file.path,"main");
        const res=await fetch(url,{
          headers:{
            "user-agent":"Trading-Eye-Research/1.0",
            "accept":"text/plain,*/*"
          }
        });
        if(!res.ok){
          if([403,429].includes(res.status)){
            this.longHistoryRetryAfter=Date.now()+30*60*1000;
            throw Object.assign(new Error(`GitHub raw HTTP ${res.status}`),{status:res.status});
          }
          misses++;
          continue;
        }
        const text=await res.text();
        const rows=this.#parseGithubMirrorFile(file.symbol,text);
        if(rows.length){
          barsStored+=await this.db.upsertLongHistoryBars(rows);
        }else misses++;
      }catch(err){
        misses++;
        if([403,429].includes(Number(err?.status))){
          await this.db.upsertResearchJob({
            jobKey,jobType:"LONG_HISTORY_INGEST",status:"WAITING",phase:"RATE_LIMITED",
            provider:"stooq_github_mirror",
            progress:manifest.length?(existing.size+symbolsDone)/manifest.length:0,
            itemsDone:existing.size+symbolsDone,itemsTotal:manifest.length,
            barsProcessed:Number((await this.db.researchCoverage()).longHistory?.bars)||0,
            error:String(err?.message||err),
            details:{retryAfter:new Date(this.longHistoryRetryAfter).toISOString()}
          });
          return;
        }
      }
      symbolsDone++;
      if(symbolsDone%10===0){
        console.log(JSON.stringify({
          event:"research_github_history_progress",
          symbolsDone,barsStored,misses,
          totalPending:pending.length,totalManifest:manifest.length
        }));
      }
      await new Promise(r=>setTimeout(r,500));
    }

    const coverage=await this.db.researchCoverage();
    await this.db.upsertResearchJob({
      jobKey,jobType:"LONG_HISTORY_INGEST",status:"RUNNING",phase:"GITHUB_MIRROR",
      provider:"stooq_github_mirror",
      progress:manifest.length?(existing.size+symbolsDone)/manifest.length:0,
      itemsDone:existing.size+symbolsDone,itemsTotal:manifest.length,
      barsProcessed:Number(coverage.longHistory?.bars)||0,
      details:{sourceRepo:"ARKMD/stooq",barsStored,misses,coverage:coverage.longHistory}
    });
    await this.#event({
      category:"DATA",
      jobKey,
      title:"GitHub history batch stored",
      message:`Processed ${symbolsDone} mirror symbols and stored ${barsStored.toLocaleString()} daily bars. Research continues in the next batch.`,
      details:{symbolsDone,barsStored,misses,coverage:coverage.longHistory}
    });
  }

  #stooqSymbol(symbol){
    return String(symbol||"").trim().toLowerCase().replaceAll(".","-")+".us";
  }

  async #fetchPublicCsvSymbol(symbol){
    const end=etDate().replaceAll("-","");
    const start=this.longHistoryStart.replaceAll("-","");
    const s=this.#stooqSymbol(symbol);
    const url=`https://stooq.com/q/d/l/?s=${encodeURIComponent(s)}&i=d&d1=${start}&d2=${end}`;
    const res=await fetch(url,{
      headers:{
        "user-agent":"Mozilla/5.0 Trading-Eye-Research/1.0",
        "accept":"text/csv,text/plain,*/*",
        "accept-language":"en-US,en;q=0.9"
      }
    });
    const body=await res.text();
    if(!res.ok){
      const err=new Error(`Stooq public CSV HTTP ${res.status}`);
      err.status=res.status;
      throw err;
    }
    if(/<!doctype|<html|enable javascript|captcha/i.test(body.slice(0,500))){
      const err=new Error("Stooq public CSV returned browser verification instead of data");
      err.status=403;
      throw err;
    }
    const lines=body.replace(/\r/g,"").split("\n").filter(Boolean);
    if(lines.length<3 || !/^date,/i.test(lines[0])){
      return [];
    }
    const out=[];
    for(let i=1;i<lines.length;i++){
      const cols=lines[i].split(",");
      const day=parseDay(cols[0]);
      const open=num(cols[1]),high=num(cols[2]),low=num(cols[3]),close=num(cols[4]);
      const volume=num(cols[5])||0;
      if(!day||day<this.longHistoryStart||![open,high,low,close].every(x=>x!=null&&x>0)) continue;
      out.push({
        provider:"stooq_symbol_csv",
        symbol:String(symbol).toUpperCase(),
        day,open,high,low,close,volume
      });
    }
    return out;
  }

  async #syncLongHistoryPerSymbol(){
    const jobKey="long-history-1999-present";
    const coverage=await this.db.researchCoverage();
    const already=new Set((await this.db.longHistorySymbols({limit:50000})).map(x=>x.symbol));
    const assets=await this.db.listActiveAssets({
      limit:20000,
      dataSupportedOnly:true,
      scannerEligibleOnly:true
    });
    const priority=["SPY","QQQ","DIA","IWM","AAPL","MSFT","NVDA","AMZN","META","GOOGL"];
    const ordered=[
      ...priority.map(symbol=>assets.find(a=>a.symbol===symbol)).filter(Boolean),
      ...assets.filter(a=>!priority.includes(a.symbol))
    ];
    const pending=ordered.filter(a=>!already.has(a.symbol));
    const batch=pending.slice(0,50);

    if(!batch.length){
      await this.db.upsertResearchJob({
        jobKey,jobType:"LONG_HISTORY_INGEST",status:"COMPLETE",phase:"READY",
        provider:"stooq_symbol_csv",progress:1,itemsDone:already.size,itemsTotal:assets.length,
        barsProcessed:Number(coverage.longHistory?.bars)||0,
        completedAt:new Date().toISOString(),
        details:{mode:"public_symbol_csv",coverage:coverage.longHistory}
      });
      return;
    }

    await this.db.upsertResearchJob({
      jobKey,jobType:"LONG_HISTORY_INGEST",status:"RUNNING",phase:"PUBLIC_CSV",
      provider:"stooq_symbol_csv",
      progress:assets.length?already.size/assets.length:0,
      itemsDone:already.size,itemsTotal:assets.length,
      barsProcessed:Number(coverage.longHistory?.bars)||0,
      details:{mode:"public_symbol_csv",batch:batch.map(x=>x.symbol),targetStart:this.longHistoryStart}
    });

    if(!this.longHistoryAuthNoticeSent){
      this.longHistoryAuthNoticeSent=true;
      await this.#event({
        category:"DATA",
        jobKey,
        title:"Trying no-key 1999+ symbol history",
        message:"Bulk history requires a key, so Trading Eye is testing Stooq's public per-symbol CSV path at a conservative rate before asking you for anything.",
        details:{symbols:batch.slice(0,5).map(x=>x.symbol)}
      });
    }

    let symbolsDone=0,barsStored=0,misses=0;
    for(const asset of batch){
      try{
        const rows=await this.#fetchPublicCsvSymbol(asset.symbol);
        if(rows.length){
          barsStored+=await this.db.upsertLongHistoryBars(rows);
        }else{
          misses++;
        }
      }catch(err){
        if([401,403,429].includes(Number(err?.status))){
          this.symbolFallbackEnabled=false;
          this.longHistoryRetryAfter=Date.now()+6*60*60*1000;
          await this.db.upsertResearchJob({
            jobKey,jobType:"LONG_HISTORY_INGEST",status:"WAITING",phase:"AUTH_REQUIRED",
            provider:this.longHistoryProvider,progress:0,
            itemsDone:already.size+symbolsDone,itemsTotal:assets.length,
            barsProcessed:Number(coverage.longHistory?.bars)||0,
            error:String(err?.message||err),
            details:{
              publicCsvBlocked:true,
              keyRequired:true,
              keyUrl:"https://stooq.com/q/d/?s=spy.us&get_apikey"
            }
          });
          await this.#event({
            category:"DATA",
            level:"IMPORTANT",
            jobKey,
            title:"No-key long-history path is blocked",
            message:"Stooq blocked the public CSV fallback too. The 1999+ lane now genuinely requires the free Stooq history key; Trading Eye will not scrape around that restriction.",
            details:{status:err?.status||null,keyUrl:"https://stooq.com/q/d/?s=spy.us&get_apikey"}
          });
          return;
        }
        misses++;
      }
      symbolsDone++;
      if(symbolsDone%10===0){
        console.log(JSON.stringify({
          event:"research_symbol_history_progress",
          symbolsDone,barsStored,misses
        }));
      }
      await new Promise(r=>setTimeout(r,1800));
    }

    const refreshed=await this.db.researchCoverage();
    await this.db.upsertResearchJob({
      jobKey,jobType:"LONG_HISTORY_INGEST",status:"RUNNING",phase:"PUBLIC_CSV",
      provider:"stooq_symbol_csv",
      progress:assets.length?(already.size+symbolsDone)/assets.length:0,
      itemsDone:already.size+symbolsDone,itemsTotal:assets.length,
      barsProcessed:Number(refreshed.longHistory?.bars)||0,
      details:{mode:"public_symbol_csv",barsStored,misses,coverage:refreshed.longHistory}
    });
    await this.#event({
      category:"DATA",
      jobKey,
      title:"Long-history batch stored",
      message:`Processed ${symbolsDone} symbols and stored ${barsStored.toLocaleString()} historical daily bars without an API key.`,
      details:{symbolsDone,barsStored,misses,coverage:refreshed.longHistory}
    });
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

    const u=new URL(this.longHistoryUrl);
    if(this.longHistoryApiKey) u.searchParams.set("apikey",this.longHistoryApiKey);
    const res=await fetch(u,{
      headers:{
        "user-agent":"Trading-Eye-Research/1.0",
        "accept":"application/zip,application/octet-stream,*/*"
      }
    });
    if(!res.ok||!res.body){
      if([401,403].includes(res.status)) this.longHistoryRetryAfter=Date.now()+6*60*60*1000;
      throw new Error(`Long-history bulk HTTP ${res.status}`);
    }

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
        console.log(JSON.stringify({
          event:"research_long_history_progress",
          symbolsDone,barsProcessed,barsStored,filesSkipped
        }));
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
    const statusCounts={PROMOTED:0,VALIDATED:0,CANDIDATE:0,REJECTED_VALIDATION:0,REJECTED_HOLDOUT:0};
    for(const meta of batch){
      const rows=await this.db.getLongHistoryBars(meta.symbol,{start:this.longHistoryStart,limit:10000});
      barsProcessed+=rows.length;
      const findings=this.#mineSymbol(meta.symbol,rows);
      for(const finding of findings){
        await this.db.upsertResearchFinding(finding);
        findingsStored++;
        statusCounts[finding.status]=(statusCounts[finding.status]||0)+1;
      }
    }

    await this.db.upsertResearchJob({
      jobKey,jobType:"PATTERN_MINING",status:"RUNNING",phase:"ROTATING",
      provider:this.longHistoryProvider,
      progress:symbols.length?this.miningCursor/symbols.length:0,
      itemsDone:this.miningCursor,itemsTotal:symbols.length,barsProcessed,
      details:{lastSymbols:batch.map(x=>x.symbol),findingsStored,statusCounts}
    });

    if(findingsStored){
      await this.#event({
        category:"PATTERN",
        jobKey,
        title:"Historical patterns updated",
        message:`Tested ${batch.length} symbols / ${barsProcessed.toLocaleString()} daily bars: ${statusCounts.PROMOTED||0} promoted, ${(statusCounts.REJECTED_VALIDATION||0)+(statusCounts.REJECTED_HOLDOUT||0)} rejected by unseen data, ${(statusCounts.VALIDATED||0)+(statusCounts.CANDIDATE||0)} still proving.`,
        details:{symbols:batch.map(x=>x.symbol),barsProcessed,findingsStored,statusCounts}
      });
    }
  }

  #mineSymbol(symbol,rawRows){
    const rows=(rawRows||[]).map(r=>({
      day:String(r.day).slice(0,10),
      open:Number(r.open),high:Number(r.high),low:Number(r.low),
      close:Number(r.close),volume:Number(r.volume)||0
    })).filter(r=>r.close>0);
    if(rows.length<420) return [];

    const validationVersion="v3_baseline_excess";
    const summarize=(samples,baseline=null,directionSign=null)=>{
      const valid=(samples||[]).filter(x=>x?.return!=null);
      const returns=valid.map(x=>Number(x.return));
      if(!returns.length){
        return {
          samples:0,hitRate:null,directionalHitRate:null,avgReturn:null,
          medianReturn:null,stdevReturn:null,avgFavorable:null,avgAdverse:null,
          baselineAvgReturn:null,baselineHitRate:null,excessAvgReturn:null,
          hitRateUplift:null,zVsBaseline:null,start:null,end:null
        };
      }
      const hitRate=returns.filter(x=>x>0).length/returns.length;
      const avgReturn=mean(returns);
      const sd=Math.max(1e-9,stdev(returns));
      const baselineAvg=Number(baseline?.avgReturn)||0;
      const baselineHit=baseline?.hitRate==null?.5:Number(baseline.hitRate);
      const sign=directionSign==null?(avgReturn-baselineAvg>=0?1:-1):directionSign;
      const directionalHitRate=sign>0?hitRate:1-hitRate;
      const baselineDirectionalHit=sign>0?baselineHit:1-baselineHit;
      const excessAvgReturn=avgReturn-baselineAvg;
      const signedExcess=sign*excessAvgReturn;
      const hitRateUplift=directionalHitRate-baselineDirectionalHit;
      const zVsBaseline=signedExcess/(sd/Math.sqrt(returns.length));
      return {
        samples:returns.length,
        hitRate,
        directionalHitRate,
        avgReturn,
        medianReturn:median(returns),
        stdevReturn:sd,
        avgFavorable:mean(valid.map(x=>Number(x.favorable)||0)),
        avgAdverse:mean(valid.map(x=>Number(x.adverse)||0)),
        baselineAvgReturn:baselineAvg,
        baselineHitRate:baselineHit,
        excessAvgReturn,
        hitRateUplift,
        zVsBaseline,
        start:valid[0]?.day||null,
        end:valid.at(-1)?.day||null
      };
    };

    const groups=new Map();
    const allByHorizon={5:[],20:[],60:[]};

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
        const sample={day:rows[i].day,return:ret,favorable,adverse};
        horizons[h]=sample;
        allByHorizon[h].push(sample);
      }
      g.samples.push({day:rows[i].day,horizons});
    }

    const eligibleDays=allByHorizon[5].map(x=>x.day).sort();
    if(eligibleDays.length<250) return [];
    const discoveryCut=eligibleDays[Math.floor(eligibleDays.length*.60)];
    const validationCut=eligibleDays[Math.floor(eligibleDays.length*.80)];

    const split=(samples)=>{
      const sorted=[...(samples||[])].sort((a,b)=>String(a.day).localeCompare(String(b.day)));
      return {
        discovery:sorted.filter(x=>x.day<=discoveryCut),
        validation:sorted.filter(x=>x.day>discoveryCut&&x.day<=validationCut),
        holdout:sorted.filter(x=>x.day>validationCut)
      };
    };

    const baselineByHorizon={};
    for(const h of [5,20,60]){
      const s=split(allByHorizon[h]);
      baselineByHorizon[h]={
        discovery:summarize(s.discovery),
        validation:summarize(s.validation),
        holdout:summarize(s.holdout)
      };
    }

    const findings=[];
    const minExcess={5:.003,20:.006,60:.010};

    for(const g of groups.values()){
      for(const h of [5,20,60]){
        const samples=g.samples
          .map(x=>x.horizons[h])
          .filter(Boolean);
        if(samples.length<75) continue;

        const s=split(samples);
        const discoveryBase=baselineByHorizon[h].discovery;
        const discoveryRaw=summarize(s.discovery,discoveryBase);
        const discoveryExcess=Number(discoveryRaw.excessAvgReturn)||0;
        const directionSign=discoveryExcess>=0?1:-1;

        const discovery=summarize(s.discovery,discoveryBase,directionSign);
        const validation=summarize(s.validation,baselineByHorizon[h].validation,directionSign);
        const holdout=summarize(s.holdout,baselineByHorizon[h].holdout,directionSign);

        const effect=minExcess[h];
        const signedDiscovery=directionSign*Number(discovery.excessAvgReturn||0);
        const signedValidation=directionSign*Number(validation.excessAvgReturn||0);
        const signedHoldout=directionSign*Number(holdout.excessAvgReturn||0);

        const discoveryPass=
          discovery.samples>=35 &&
          signedDiscovery>=effect*.80 &&
          Number(discovery.hitRateUplift)>=.04 &&
          Number(discovery.zVsBaseline)>=2.0;

        if(!discoveryPass) continue;

        const enoughValidation=validation.samples>=18;
        const enoughHoldout=holdout.samples>=18;

        const validationPass=
          enoughValidation &&
          signedValidation>=effect*.55 &&
          Number(validation.hitRateUplift)>=.025 &&
          Number(validation.zVsBaseline)>=1.65;

        const holdoutPass=
          enoughHoldout &&
          signedHoldout>=effect*.40 &&
          Number(holdout.hitRateUplift)>=.02 &&
          Number(holdout.zVsBaseline)>=1.64;

        let status="CANDIDATE";
        if(enoughValidation&&!validationPass) status="REJECTED_VALIDATION";
        else if(validationPass&&enoughHoldout&&!holdoutPass) status="REJECTED_HOLDOUT";
        else if(validationPass&&holdoutPass) status="PROMOTED";
        else if(validationPass) status="VALIDATED";

        const valZ=Math.max(-4,Math.min(6,Number(validation.zVsBaseline)||0));
        const holdZ=Math.max(-4,Math.min(6,Number(holdout.zVsBaseline)||0));
        const score=
          valZ*.35 +
          holdZ*.55 +
          Math.max(-.10,Math.min(.20,Number(validation.hitRateUplift)||0))*6 +
          Math.max(-.10,Math.min(.20,Number(holdout.hitRateUplift)||0))*8;

        const direction=directionSign>0?"positive":"negative";
        const findingId=crypto
          .createHash("sha1")
          .update([this.longHistoryProvider,symbol,g.patternKey,h].join("|"))
          .digest("hex");

        const headline=holdout.samples?holdout:validation.samples?validation:discovery;
        const laterEvidence=status==="PROMOTED"
          ? `It beat the symbol's normal ${h}-day baseline in both validation and the recent holdout.`
          : status==="REJECTED_VALIDATION"
            ? `It looked good in discovery but failed to beat the symbol's normal baseline in later validation.`
            : status==="REJECTED_HOLDOUT"
              ? `It beat baseline in validation but failed the most recent holdout.`
              : status==="VALIDATED"
                ? `It beat baseline in validation but still needs enough recent holdout samples.`
                : `It is still collecting later unseen evidence.`;

        findings.push({
          findingId,
          provider:this.longHistoryProvider,
          scope:"SYMBOL_DAILY",
          symbol,
          patternKey:g.patternKey,
          horizonDays:h,
          sampleCount:samples.length,
          hitRate:headline.directionalHitRate,
          avgForwardReturn:headline.excessAvgReturn,
          medianForwardReturn:headline.medianReturn,
          avgAdverseReturn:headline.avgAdverse,
          avgFavorableReturn:headline.avgFavorable,
          score,
          status,
          validationVersion,
          discoveryMetrics:discovery,
          validationMetrics:validation,
          holdoutMetrics:holdout,
          description:`${symbol}: ${g.patternKey.replaceAll("|"," + ")} showed a ${direction} ${h}-day excess pattern versus its normal baseline. ${laterEvidence}`,
          evidence:{
            validationVersion,
            intendedDirection:directionSign>0?"UP":"DOWN",
            totalSamples:samples.length,
            discoveryCut,
            validationCut,
            discoveryWindow:{start:discovery.start,end:discovery.end,samples:discovery.samples},
            validationWindow:{start:validation.start,end:validation.end,samples:validation.samples},
            holdoutWindow:{start:holdout.start,end:holdout.end,samples:holdout.samples},
            baseline:{
              discovery:baselineByHorizon[h].discovery,
              validation:baselineByHorizon[h].validation,
              holdout:baselineByHorizon[h].holdout
            },
            historicalIntegrityVerified:this.historicalIntegrityVerified,
            recentHoldoutExamples:s.holdout.slice(-8)
          }
        });
      }
    }

    const rankStatus=s=>s==="PROMOTED"?0:s==="VALIDATED"?1:s==="CANDIDATE"?2:3;
    return findings
      .sort((a,b)=>rankStatus(a.status)-rankStatus(b.status)||b.score-a.score)
      .slice(0,18);
  }

  async #event(event){
    const saved=await this.db.addResearchEvent(event);
    if(saved){
      this.lastResearchEventAt=saved.event_ts;
      console.log(JSON.stringify({
        event:"research_event",
        id:saved.id,
        category:saved.category,
        level:saved.level,
        jobKey:saved.job_key,
        title:saved.title,
        message:saved.message
      }));
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
      this.longHistoryRetryAfter=Math.max(this.longHistoryRetryAfter,Date.now()+60*60*1000);
      await this.db.upsertResearchJob({
        jobKey:"long-history-1999-present",jobType:"LONG_HISTORY_INGEST",
        status:"ERROR",phase:"ERROR",provider:this.longHistoryProvider,
        progress:0,error:message,details:{targetStart:this.longHistoryStart}
      });
    }
  }
}

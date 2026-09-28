import { EventEmitter } from "node:events";
import { fingerprintFromFeatures, timeBucketET } from "./patterns.js";

const pct=(a,b)=>b?(a-b)/b:0;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));

function etParts(date=new Date()) {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-US",{
      timeZone:"America/New_York",
      year:"numeric",month:"2-digit",day:"2-digit",weekday:"short",
      hour:"2-digit",minute:"2-digit",hourCycle:"h23"
    }).formatToParts(date).filter(p=>p.type!=="literal").map(p=>[p.type,p.value])
  );
}
function etDate(date=new Date()) {
  const p=etParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}
function minuteET(ts) {
  const p=Object.fromEntries(
    new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",hour:"2-digit",minute:"2-digit",hourCycle:"h23"})
      .formatToParts(new Date(ts)).filter(x=>x.type!=="literal").map(x=>[x.type,x.value])
  );
  return Number(p.hour)*60+Number(p.minute);
}
function dayOfWeek(dateStr) {
  return new Date(dateStr+"T12:00:00Z").getUTCDay();
}
function addDays(dateStr,delta) {
  const d=new Date(dateStr+"T12:00:00Z");
  d.setUTCDate(d.getUTCDate()+delta);
  return d.toISOString().slice(0,10);
}
function isWeekday(dateStr) {
  const d=dayOfWeek(dateStr);
  return d>=1&&d<=5;
}
function mean(arr) {
  return arr.length?arr.reduce((a,b)=>a+b,0)/arr.length:0;
}
function std(arr) {
  if (arr.length<2) return 0;
  const m=mean(arr);
  return Math.sqrt(arr.reduce((a,x)=>a+(x-m)**2,0)/(arr.length-1));
}
function correlation(a,b) {
  const n=Math.min(a.length,b.length);
  if (n<8) return null;
  const aa=a.slice(0,n),bb=b.slice(0,n);
  const ma=mean(aa),mb=mean(bb);
  let num=0,da=0,db=0;
  for (let i=0;i<n;i++) {
    const x=aa[i]-ma,y=bb[i]-mb;
    num+=x*y; da+=x*x; db+=y*y;
  }
  return da&&db?num/Math.sqrt(da*db):null;
}
function barNum(r) {
  return {
    ...r,ts:new Date(r.ts),open:Number(r.open),high:Number(r.high),low:Number(r.low),
    close:Number(r.close),volume:Number(r.volume),vwap:r.vwap==null?null:Number(r.vwap)
  };
}
function slicePeriod(rows,start,end) {
  return rows.filter(r=>{
    const m=minuteET(r.ts);
    return m>=start&&m<end;
  });
}
function periodMetric(rows) {
  if (!rows.length) return null;
  const first=rows[0],last=rows.at(-1);
  const volume=rows.reduce((s,x)=>s+x.volume,0);
  return {
    bars:rows.length,
    open:first.open,close:last.close,
    high:Math.max(...rows.map(x=>x.high)),
    low:Math.min(...rows.map(x=>x.low)),
    return:pct(last.close,first.open),
    range:pct(Math.max(...rows.map(x=>x.high)),Math.min(...rows.map(x=>x.low))),
    volume
  };
}
function symbolMetrics(rows) {
  if (!rows.length) return null;
  const first=rows[0],last=rows.at(-1);
  const returns=[];
  let peak=first.open,maxDrawdown=0,maxRunup=0;
  for (let i=1;i<rows.length;i++) {
    returns.push(pct(rows[i].close,rows[i-1].close));
    peak=Math.max(peak,rows[i].high);
    maxDrawdown=Math.min(maxDrawdown,pct(rows[i].low,peak));
    maxRunup=Math.max(maxRunup,pct(rows[i].high,first.open));
  }
  const volume=rows.reduce((s,x)=>s+x.volume,0);
  const volWeighted=rows.reduce((s,x)=>s+(x.vwap??x.close)*x.volume,0)/Math.max(1,volume);
  return {
    bars:rows.length,
    open:first.open,close:last.close,
    high:Math.max(...rows.map(x=>x.high)),
    low:Math.min(...rows.map(x=>x.low)),
    return:pct(last.close,first.open),
    range:pct(Math.max(...rows.map(x=>x.high)),Math.min(...rows.map(x=>x.low))),
    realizedVol:Math.sqrt(returns.reduce((s,r)=>s+r*r,0)),
    volume,vwap:volWeighted,
    greenMinuteShare:returns.length?returns.filter(r=>r>0).length/returns.length:0,
    maxDrawdown,maxRunup,
    periods:{
      premarket:periodMetric(slicePeriod(rows,4*60,9*60+30)),
      open30:periodMetric(slicePeriod(rows,9*60+30,10*60)),
      morning:periodMetric(slicePeriod(rows,10*60,11*60+30)),
      midday:periodMetric(slicePeriod(rows,11*60+30,14*60)),
      afternoon:periodMetric(slicePeriod(rows,14*60,15*60)),
      powerHour:periodMetric(slicePeriod(rows,15*60,16*60)),
      afterHours:periodMetric(slicePeriod(rows,16*60,20*60))
    }
  };
}

function featureAt(rows,index) {
  if (index<29) return null;
  const window=rows.slice(index-23,index+1);
  const last=rows[index],prev3=rows[index-3],prev12=rows[index-12];
  if (!last||!prev3||!prev12||window.length<20) return null;
  const prior=window.slice(0,-1);
  const avgVol=mean(prior.map(x=>x.volume));
  const rets=window.slice(1).map((x,i)=>pct(x.close,window[i].close));
  const rv=Math.sqrt(mean(rets.map(r=>r*r)));
  const body=(last.close-last.open)/Math.max(last.high-last.low,last.close*.00001);
  const volume=window.reduce((s,x)=>s+x.volume,0);
  const vwap=window.reduce((s,x)=>s+((x.high+x.low+x.close)/3)*x.volume,0)/Math.max(1,volume);
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

function predictionSummary(rows) {
  const scored=rows.filter(x=>x.status==="SCORED");
  const correct=scored.filter(x=>x.correct).length;
  const bySymbol={};
  const byBucket={};
  for (const p of scored) {
    const s=bySymbol[p.symbol]||(bySymbol[p.symbol]={scored:0,correct:0});
    s.scored++; if (p.correct) s.correct++;
    const bucket=Number(p.confidence)>=.72?"high":Number(p.confidence)>=.58?"medium":"low";
    const b=byBucket[bucket]||(byBucket[bucket]={scored:0,correct:0});
    b.scored++; if (p.correct) b.correct++;
  }
  for (const o of Object.values(bySymbol)) o.accuracy=o.scored?o.correct/o.scored:null;
  for (const o of Object.values(byBucket)) o.accuracy=o.scored?o.correct/o.scored:null;
  return {
    total:rows.length,scored:scored.length,correct,
    accuracy:scored.length?correct/scored.length:null,
    bySymbol,byConfidence:byBucket,
    worstMisses:scored.filter(x=>!x.correct)
      .sort((a,b)=>Math.abs(Number(b.result_return)||0)-Math.abs(Number(a.result_return)||0))
      .slice(0,10)
      .map(x=>({symbol:x.symbol,time:x.created_at,direction:x.direction,actual:x.actual_direction,confidence:Number(x.confidence),return:Number(x.result_return)}))
  };
}

function alignedReturns(bySymbol) {
  const maps={};
  for (const [symbol,rows] of Object.entries(bySymbol)) {
    const m=new Map();
    for (let i=1;i<rows.length;i++) {
      const key=Math.floor(+rows[i].ts/300000)*300000;
      const r=pct(rows[i].close,rows[i-1].close);
      if (Number.isFinite(r)) m.set(key,r);
    }
    maps[symbol]=m;
  }
  const symbols=Object.keys(maps);
  const pairs=[];
  for (let i=0;i<symbols.length;i++) for (let j=i+1;j<symbols.length;j++) {
    const a=maps[symbols[i]],b=maps[symbols[j]];
    const keys=[...a.keys()].filter(k=>b.has(k));
    const c=correlation(keys.map(k=>a.get(k)),keys.map(k=>b.get(k)));
    if (c!=null) pairs.push({a:symbols[i],b:symbols[j],correlation:c,samples:keys.length});
  }
  return pairs.sort((x,y)=>Math.abs(y.correlation)-Math.abs(x.correlation));
}

function buildLessons(metrics,predictionReview,correlations) {
  const lessons=[];
  const entries=Object.entries(metrics).filter(([,m])=>m);
  if (entries.length) {
    const strongest=[...entries].sort((a,b)=>Math.abs(b[1].return)-Math.abs(a[1].return))[0];
    lessons.push({
      type:"largest_move",symbol:strongest[0],
      text:`${strongest[0]} had the largest absolute session move at ${(strongest[1].return*100).toFixed(2)}%.`
    });
    const widest=[...entries].sort((a,b)=>b[1].range-a[1].range)[0];
    lessons.push({
      type:"range_expansion",symbol:widest[0],
      text:`${widest[0]} had the widest intraday range at ${(widest[1].range*100).toFixed(2)}%.`
    });
  }
  if (predictionReview.scored) {
    lessons.push({
      type:"model_score",
      text:`The live model scored ${predictionReview.scored} predictions at ${(predictionReview.accuracy*100).toFixed(1)}% directional accuracy for this study window.`
    });
  }
  if (correlations.length) {
    const c=correlations[0];
    lessons.push({
      type:"correlation",
      text:`${c.a} and ${c.b} were the strongest monitored relationship with correlation ${c.correlation.toFixed(2)} across aligned 5-minute returns.`
    });
  }
  return lessons;
}

export class DeepStudyEngine extends EventEmitter {
  constructor({db,marketEngine,symbols,model}) {
    super();
    this.db=db;
    this.marketEngine=marketEngine;
    this.symbols=symbols;
    this.model=model;
    this.running=false;
    this.lastStudy=null;
    this.patternState={state:"WAITING",patterns:0,lastBuiltAt:null,error:null};
    this.timer=null;
    this.initialized=false;
  }

  async init() {
    if (this.initialized) return;
    this.initialized=true;
    this.timer=setInterval(()=>this.tick().catch(err=>this.#error(err)),60000);
    setTimeout(()=>this.tick().catch(err=>this.#error(err)),5000);
  }

  stop() { clearInterval(this.timer); }

  status() {
    return {
      running:this.running,
      lastStudy:this.lastStudy,
      patternState:this.patternState
    };
  }

  async latest(limit=10) {
    return this.db.recentStudies({limit,stage:"regular_close"});
  }

  async tick() {
    if (!this.marketEngine.enabled || this.running) return;
    if (this.marketEngine.backfill.state!=="COMPLETE") return;

    const memoryStats=await this.db.patternMemoryStats();
    if (!memoryStats.patterns && this.patternState.state!=="BUILDING" && this.patternState.state!=="COMPLETE") {
      await this.rebuildPatternMemory();
    } else if (memoryStats.patterns && this.patternState.state==="WAITING") {
      this.patternState={
        state:"COMPLETE",
        patterns:memoryStats.patterns,
        totalSamples:memoryStats.totalSamples,
        byHorizon:memoryStats.byHorizon,
        lastBuiltAt:null,
        error:null
      };
    }

    const p=etParts();
    const today=`${p.year}-${p.month}-${p.day}`;
    const minute=Number(p.hour)*60+Number(p.minute);

    const candidates=[];
    if (isWeekday(today) && minute>=16*60+10) candidates.push({date:today,stage:"regular_close"});
    if (isWeekday(today) && minute>=20*60+10) candidates.push({date:today,stage:"extended_close"});

    let prior=today;
    for (let i=0;i<7;i++) {
      prior=addDays(prior,-1);
      if (isWeekday(prior)) {
        candidates.push({date:prior,stage:"regular_close"});
        candidates.push({date:prior,stage:"extended_close"});
      }
    }

    for (const c of candidates) {
      if (await this.db.hasCompletedStudy(c.date,c.stage)) continue;
      await this.runStudy(c.date,c.stage);
      break;
    }
  }

  async runStudy(studyDate,stage="regular_close") {
    if (this.running) return null;
    this.running=true;
    const startTime=stage==="extended_close"?"04:00:00":"09:30:00";
    const endTime=stage==="extended_close"?"20:00:00":"16:00:00";
    await this.db.beginDailyStudy(studyDate,stage,this.model.version);
    this.emit("status",this.status());
    try {
      const raw=await this.db.getSessionBars(studyDate,{startTime,endTime});
      const bySymbol={};
      for (const row of raw) {
        const r=barNum(row);
        (bySymbol[r.symbol]||(bySymbol[r.symbol]=[])).push(r);
      }
      const metrics={};
      for (const symbol of this.symbols) metrics[symbol]=symbolMetrics(bySymbol[symbol]||[]);

      const valid=Object.values(metrics).filter(Boolean);
      const market={
        symbolCount:valid.length,
        totalBars:raw.length,
        breadthGreen:valid.length?valid.filter(x=>x.return>0).length/valid.length:null,
        avgReturn:valid.length?mean(valid.map(x=>x.return)):null,
        avgRange:valid.length?mean(valid.map(x=>x.range)):null,
        avgRealizedVol:valid.length?mean(valid.map(x=>x.realizedVol)):null,
        totalVolume:valid.reduce((s,x)=>s+x.volume,0),
        correlations:alignedReturns(bySymbol).slice(0,15)
      };

      const predictions=await this.db.getPredictionReview(studyDate);
      const review=predictionSummary(predictions);
      const recent=await this.db.recentStudies({limit:45,stage});
      const analogs=this.#findAnalogs({market,symbols:metrics},recent.filter(x=>String(x.study_date).slice(0,10)!==studyDate)).slice(0,8);

      if (stage==="regular_close") await this.#learnPatternsForDay(bySymbol);
      const topPatterns=await this.db.topPatterns({minSamples:12,limit:40});
      const memoryStats=await this.db.patternMemoryStats();
      const patternFindings={
        memorySize:memoryStats.patterns,
        totalSamples:memoryStats.totalSamples,
        byHorizon:memoryStats.byHorizon,
        strongest:topPatterns.slice(0,15).map(p=>({
          symbol:p.symbol,fingerprint:p.fingerprint,horizonMinutes:p.horizon_minutes,
          samples:p.sample_count,
          upRate:Number(p.up_count)/Number(p.sample_count),
          flatRate:Number(p.flat_count)/Number(p.sample_count),
          downRate:Number(p.down_count)/Number(p.sample_count),
          avgReturn:Number(p.avg_return)
        }))
      };

      const lessons=buildLessons(metrics,review,market.correlations);
      const payload={symbols:metrics,market,predictionReview:review,patternFindings,analogs,lessons};
      await this.db.completeDailyStudy(studyDate,stage,payload);
      this.lastStudy={studyDate,stage,completedAt:new Date().toISOString(),...payload};
      console.log(JSON.stringify({
        event:"deep_study_complete",studyDate,stage,bars:raw.length,
        predictions:review.scored,patterns:patternFindings.memorySize
      }));
      this.emit("study",this.lastStudy);
      return this.lastStudy;
    } catch(err) {
      await this.db.failDailyStudy(studyDate,stage,err?.message||err);
      console.log(JSON.stringify({event:"deep_study_error",studyDate,stage,message:String(err?.message||err)}));
      throw err;
    } finally {
      this.running=false;
      this.emit("status",this.status());
    }
  }

  #findAnalogs(current,recent) {
    const cur=current.market;
    if (cur.avgReturn==null) return [];
    return recent.filter(r=>r.status==="COMPLETE"&&r.market?.avgReturn!=null).map(r=>{
      const m=r.market;
      const dist=
        Math.abs(Number(cur.avgReturn)-Number(m.avgReturn))/0.01+
        Math.abs(Number(cur.avgRange)-Number(m.avgRange))/0.015+
        Math.abs(Number(cur.breadthGreen??.5)-Number(m.breadthGreen??.5))*2+
        Math.abs(Number(cur.avgRealizedVol)-Number(m.avgRealizedVol))/0.02;
      return {
        studyDate:String(r.study_date).slice(0,10),
        distance:dist,
        avgReturn:Number(m.avgReturn),
        avgRange:Number(m.avgRange),
        breadthGreen:Number(m.breadthGreen)
      };
    }).sort((a,b)=>a.distance-b.distance);
  }

  async #learnPatternsForDay(bySymbol) {
    for (const [symbol,rows] of Object.entries(bySymbol)) {
      for (let i=30;i<rows.length-16;i+=5) {
        const features=featureAt(rows,i);
        if (!features) continue;
        const fp=fingerprintFromFeatures(features,rows[i].ts);
        for (const horizon of [15,30,60]) {
          const future=rows[i+horizon];
          if (!future) continue;
          const elapsed=(future.ts-rows[i].ts)/60000;
          if (elapsed<horizon-1||elapsed>horizon+5) continue;
          const ret=pct(future.close,rows[i].close);
          const path=rows.slice(i+1,i+horizon+1);
          const mfe=path.length?Math.max(...path.map(x=>pct(x.high,rows[i].close))):0;
          const mae=path.length?Math.min(...path.map(x=>pct(x.low,rows[i].close))):0;
          const direction=ret>.001?"UP":ret<-.001?"DOWN":"FLAT";
          await this.db.updatePatternMemory({
            symbol,fingerprint:fp,horizonMinutes:horizon,direction,
            return:ret,absReturn:Math.abs(ret),mfe,mae,lastSeen:rows[i].ts,
            context:{timeBucket:timeBucketET(rows[i].ts)}
          });
        }
      }
    }
  }

  async rebuildPatternMemory() {
    if (this.patternState.state==="BUILDING") return;
    this.patternState={state:"BUILDING",patterns:0,lastBuiltAt:null,error:null};
    this.emit("status",this.status());
    try {
      const aggregates=new Map();
      for (const symbol of this.symbols) {
        const rows=(this.marketEngine.histories.get(symbol)||[]).map(barNum);
        for (let i=30;i<rows.length-61;i+=5) {
          const features=featureAt(rows,i);
          if (!features) continue;
          const fp=fingerprintFromFeatures(features,rows[i].ts);
          for (const horizon of [15,30,60]) {
            const future=rows[i+horizon];
            if (!future) continue;
            const elapsed=(future.ts-rows[i].ts)/60000;
            if (elapsed<horizon-1||elapsed>horizon+5) continue;
            const ret=pct(future.close,rows[i].close);
            const path=rows.slice(i+1,i+horizon+1);
            const mfe=path.length?Math.max(...path.map(x=>pct(x.high,rows[i].close))):0;
            const mae=path.length?Math.min(...path.map(x=>pct(x.low,rows[i].close))):0;
            const direction=ret>.001?"UP":ret<-.001?"DOWN":"FLAT";
            const key=`${symbol}::${fp}::${horizon}`;
            const a=aggregates.get(key)||{
              symbol,fingerprint:fp,horizonMinutes:horizon,sampleCount:0,
              upCount:0,flatCount:0,downCount:0,sumReturn:0,sumAbsReturn:0,sumMfe:0,sumMae:0,lastSeen:null
            };
            a.sampleCount++;
            a[direction==="UP"?"upCount":direction==="DOWN"?"downCount":"flatCount"]++;
            a.sumReturn+=ret;a.sumAbsReturn+=Math.abs(ret);a.sumMfe+=mfe;a.sumMae+=mae;
            a.lastSeen=rows[i].ts;
            aggregates.set(key,a);
          }
        }
      }
      const rows=[...aggregates.values()]
        .filter(x=>x.sampleCount>=6)
        .sort((a,b)=>b.sampleCount-a.sampleCount)
        .slice(0,3000);
      for (const a of rows) {
        await this.db.upsertPatternAggregate({
          ...a,
          avgReturn:a.sumReturn/a.sampleCount,
          avgAbsReturn:a.sumAbsReturn/a.sampleCount,
          avgMfe:a.sumMfe/a.sampleCount,
          avgMae:a.sumMae/a.sampleCount,
          context:{builtFrom:"rolling_90_day_memory",stepMinutes:5}
        });
      }
      this.patternState={state:"COMPLETE",patterns:rows.length,lastBuiltAt:new Date().toISOString(),error:null};
      console.log(JSON.stringify({event:"pattern_memory_built",patterns:rows.length}));
    } catch(err) {
      this.patternState={state:"ERROR",patterns:0,lastBuiltAt:null,error:String(err?.message||err)};
      console.log(JSON.stringify({event:"pattern_memory_error",message:this.patternState.error}));
    }
    this.emit("status",this.status());
  }

  #error(err) {
    console.log(JSON.stringify({event:"deep_study_scheduler_error",message:String(err?.message||err)}));
  }
}

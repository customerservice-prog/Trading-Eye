import crypto from "node:crypto";
import { FeatureFactory } from "./feature-factory.js";
import {
  CLASS_NAMES,SoftmaxModel,BoostedStumpModel,
  metricsFor,chooseTemperature,applyTemperature
} from "./ml-models.js";

const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const sleepTick=()=>new Promise(r=>setImmediate(r));

function etParts(value=new Date()){
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-US",{
      timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit",
      weekday:"short",hour:"2-digit",minute:"2-digit",hourCycle:"h23"
    }).formatToParts(new Date(value)).filter(x=>x.type!=="literal").map(x=>[x.type,x.value])
  );
}
function etDay(value){
  const p=etParts(value);
  return `${p.year}-${p.month}-${p.day}`;
}
function etMinute(value){
  const p=etParts(value);
  return Number(p.hour)*60+Number(p.minute);
}
function regularSession(value){
  const p=etParts(value);
  if(["Sat","Sun"].includes(p.weekday)) return false;
  const m=Number(p.hour)*60+Number(p.minute);
  return m>=9*60+30&&m<16*60;
}
function bucket(value){
  const m=etMinute(value);
  if(m<10*60+30) return "OPENING_60M";
  if(m<14*60+30) return "MIDDAY";
  return "LATE_DAY";
}
function directionFromProbs(p){
  const i=p.indexOf(Math.max(...p));
  return CLASS_NAMES[i]||"FLAT";
}
function edgeFromProbs(p){
  const s=[...p].sort((a,b)=>b-a);
  return (s[0]||0)-(s[1]||0);
}
function ratio(n,d){ return d?Number(n)/Number(d):0; }
function mean(a){ return a.length?a.reduce((s,x)=>s+x,0)/a.length:0; }

const STRATEGIES=[
  {key:"strict_proof",minConf:.50,minEdge:.070,allowFlat:false,stop:.0050,target:.0090,hold:30,costBps:3},
  {key:"balanced",minConf:.44,minEdge:.035,allowFlat:false,stop:.0050,target:.0080,hold:25,costBps:3},
  {key:"aggressive",minConf:.34,minEdge:.008,allowFlat:true,flatDiff:.006,stop:.0045,target:.0075,hold:30,costBps:4},
  {key:"fast_probe",minConf:.33,minEdge:0,allowFlat:true,flatDiff:.004,stop:.0030,target:.0045,hold:12,costBps:4},
  {key:"wide_runner",minConf:.36,minEdge:.010,allowFlat:true,flatDiff:.008,stop:.0065,target:.0120,hold:45,costBps:4}
];

export class ReplayArena {
  constructor({
    db,modelLab,marketEngine,enabled=true,
    intervalMs=90*1000,
    historyBarsPerSymbol=14000,
    maxSymbols=16
  }={}){
    this.db=db;
    this.modelLab=modelLab;
    this.marketEngine=marketEngine;
    this.enabled=Boolean(enabled);
    this.intervalMs=Math.max(30*1000,Number(intervalMs)||90*1000);
    this.historyBarsPerSymbol=Math.max(4000,Math.min(30000,Number(historyBarsPerSymbol)||14000));
    this.maxSymbols=Math.max(6,Math.min(24,Number(maxSymbols)||16));
    this.factory=new FeatureFactory();
    this.timer=null;
    this.running=false;
    this.lastError=null;
    this.lastRun=null;
    this.totals={attempts:0,runs:0,decisions:0,trades:0,wins:0,losses:0};
    this.startedAt=new Date();
  }

  async init(){
    if(!this.enabled) return;
    await this.db.pool.query(`
      CREATE TABLE IF NOT EXISTS replay_arena_runs (
        run_id TEXT PRIMARY KEY,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        status TEXT NOT NULL DEFAULT 'RUNNING',
        replay_day DATE,
        model_family TEXT,
        train_start TIMESTAMPTZ,
        train_end TIMESTAMPTZ,
        symbols JSONB NOT NULL DEFAULT '[]'::jsonb,
        config JSONB NOT NULL DEFAULT '{}'::jsonb,
        summary JSONB NOT NULL DEFAULT '{}'::jsonb,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS replay_arena_runs_recent
        ON replay_arena_runs(started_at DESC);

      CREATE TABLE IF NOT EXISTS replay_arena_trades (
        id BIGSERIAL PRIMARY KEY,
        run_id TEXT NOT NULL,
        strategy_key TEXT NOT NULL,
        symbol TEXT NOT NULL,
        decision_at TIMESTAMPTZ NOT NULL,
        side TEXT NOT NULL,
        entry_at TIMESTAMPTZ NOT NULL,
        entry_price DOUBLE PRECISION NOT NULL,
        exit_at TIMESTAMPTZ NOT NULL,
        exit_price DOUBLE PRECISION NOT NULL,
        exit_reason TEXT NOT NULL,
        return DOUBLE PRECISION NOT NULL,
        p_up DOUBLE PRECISION NOT NULL,
        p_flat DOUBLE PRECISION NOT NULL,
        p_down DOUBLE PRECISION NOT NULL,
        confidence DOUBLE PRECISION NOT NULL,
        edge DOUBLE PRECISION NOT NULL,
        time_bucket TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS replay_arena_trades_recent
        ON replay_arena_trades(created_at DESC);
      CREATE INDEX IF NOT EXISTS replay_arena_trades_symbol
        ON replay_arena_trades(symbol,created_at DESC);
    `);

    await this.db.pool.query(`
      UPDATE replay_arena_runs
      SET status='ERROR',completed_at=NOW(),
          error=COALESCE(error,'Service restarted during replay cycle.')
      WHERE status='RUNNING'
    `);

    await this.#loadState();
    setTimeout(()=>this.runCycle().catch(err=>this.#capture(err)),12000);
    this.timer=setInterval(()=>this.runCycle().catch(err=>this.#capture(err)),this.intervalMs);
  }

  stop(){ clearInterval(this.timer); }

  status(){
    return {
      enabled:this.enabled,
      running:this.running,
      mode:regularSession(new Date())?"BACKGROUND_REPLAY":"24_7_REPLAY",
      startedAt:this.startedAt,
      lastError:this.lastError,
      lastRun:this.lastRun,
      totals:this.totals,
      policy:{
        futureHidden:true,
        entryOnNextBar:true,
        replayLearningPool:"EARLIEST_20_TO_60_PERCENT_OF_STORED_MINUTE_HISTORY",
        newestHistoryReserved:"NEWEST_40_PERCENT NEVER USED TO CHOOSE REPLAY FOCUS",
        countsTowardRealMoneyReadiness:false
      }
    };
  }

  async #loadState(){
    const [runs,last]=await Promise.all([
      this.db.pool.query(`
        SELECT
          COUNT(*)::int AS attempts,
          COUNT(*) FILTER (WHERE status='COMPLETE')::int AS runs,
          COALESCE(SUM((summary->>'decisions')::int) FILTER (WHERE status='COMPLETE'),0)::bigint AS decisions,
          COALESCE(SUM((summary->>'trades')::int) FILTER (WHERE status='COMPLETE'),0)::bigint AS trades,
          COALESCE(SUM((summary->>'wins')::int) FILTER (WHERE status='COMPLETE'),0)::bigint AS wins,
          COALESCE(SUM((summary->>'losses')::int) FILTER (WHERE status='COMPLETE'),0)::bigint AS losses
        FROM replay_arena_runs
      `),
      this.db.pool.query(`
        SELECT run_id,started_at,completed_at,status,replay_day,model_family,summary,config,error
        FROM replay_arena_runs
        ORDER BY started_at DESC LIMIT 1
      `)
    ]);
    const r=runs.rows[0]||{};
    this.totals={
      attempts:Number(r.attempts)||0,
      runs:Number(r.runs)||0,
      decisions:Number(r.decisions)||0,
      trades:Number(r.trades)||0,
      wins:Number(r.wins)||0,
      losses:Number(r.losses)||0
    };
    if(last.rows[0]) this.lastRun=this.#runRow(last.rows[0]);
  }

  #runRow(r){
    return {
      runId:r.run_id,
      startedAt:r.started_at,
      completedAt:r.completed_at,
      status:r.status,
      replayDay:r.replay_day?String(r.replay_day).slice(0,10):null,
      modelFamily:r.model_family,
      summary:r.summary||{},
      config:r.config||{},
      error:r.error||null
    };
  }

  async recentRuns(limit=12){
    const q=await this.db.pool.query(`
      SELECT run_id,started_at,completed_at,status,replay_day,model_family,summary,config,error
      FROM replay_arena_runs
      ORDER BY started_at DESC
      LIMIT $1
    `,[Math.max(1,Math.min(50,Number(limit)||12))]);
    return q.rows.map(r=>this.#runRow(r));
  }

  async leaderboard(){
    const q=await this.db.pool.query(`
      SELECT strategy_key,
        COUNT(*)::int AS trades,
        COUNT(*) FILTER (WHERE return>0)::int AS wins,
        COUNT(*) FILTER (WHERE return<0)::int AS losses,
        AVG(return) AS avg_return,
        SUM(return) AS sum_return,
        SUM(return) FILTER (WHERE return>0) AS gross_profit,
        ABS(SUM(return) FILTER (WHERE return<0)) AS gross_loss
      FROM replay_arena_trades
      GROUP BY strategy_key
      ORDER BY AVG(return) DESC
    `);
    return q.rows.map(r=>{
      const gp=Number(r.gross_profit)||0;
      const gl=Number(r.gross_loss)||0;
      return {
        strategy:r.strategy_key,
        trades:Number(r.trades)||0,
        wins:Number(r.wins)||0,
        losses:Number(r.losses)||0,
        winRate:ratio(r.wins,r.trades),
        avgReturn:Number(r.avg_return)||0,
        sumReturn:Number(r.sum_return)||0,
        profitFactor:gl?gp/gl:(gp>0?Infinity:null)
      };
    });
  }

  async runCycle(){
    if(!this.enabled||this.running) return this.lastRun;
    const openNow=regularSession(new Date());
    const lastCompletedAt=this.lastRun?.completedAt?+new Date(this.lastRun.completedAt):0;
    if(openNow&&lastCompletedAt&&Date.now()-lastCompletedAt<5*60*1000) return this.lastRun;
    this.running=true;
    this.lastError=null;
    const runId="REPLAY-"+crypto.randomUUID();
    const startedAt=new Date();

    try{
      const meta=await this.db.listSymbolsWithMinuteHistory({minBars:3000,limit:40});
      const liquidPriority=[
        "SPY","QQQ","IWM","MSFT","NVDA","AAPL","AMZN","META","GOOGL",
        "AMD","TSLA","AVGO","NFLX","PLTR","JPM","BAC","MU","UBER","XLF","XLK","SMH"
      ];
      const available=new Set(meta.map(x=>x.symbol));
      const hotSymbols=(this.marketEngine?.hotSymbols?.()||[]).filter(s=>available.has(s));
      const cycleMaxSymbols=openNow?Math.min(8,this.maxSymbols):this.maxSymbols;
      const symbols=[
        ...liquidPriority.filter(s=>available.has(s)),
        ...hotSymbols.filter(s=>!liquidPriority.includes(s))
      ].filter((s,i,a)=>a.indexOf(s)===i).slice(0,cycleMaxSymbols);

      if(symbols.length<5) throw new Error("Replay Arena needs at least 5 symbols with 3,000 stored minute bars.");

      const histories=new Map();
      for(const symbol of symbols){
        const rows=await this.db.getBars(symbol,{limit:this.historyBarsPerSymbol});
        if(rows.length>=3000) histories.set(symbol,rows);
        await sleepTick();
      }
      if(histories.size<5) throw new Error("Replay Arena could not load enough deep minute histories.");

      const dayCounts=new Map();
      for(const rows of histories.values()){
        const seen=new Set();
        for(const row of rows){
          if(!regularSession(row.ts)) continue;
          const day=etDay(row.ts);
          if(seen.has(day)) continue;
          seen.add(day);
          dayCounts.set(day,(dayCounts.get(day)||0)+1);
        }
      }
      const days=[...dayCounts.entries()]
        .filter(([,count])=>count>=Math.min(5,histories.size))
        .map(([day])=>day)
        .sort();
      if(days.length<8) throw new Error("Replay Arena needs at least 8 shared historical sessions.");

      const poolStart=Math.floor(days.length*.20);
      const poolEnd=Math.max(poolStart+1,Math.floor(days.length*.60));
      const poolDays=days.slice(poolStart,poolEnd);
      if(!poolDays.length) throw new Error("Replay Arena training-only session pool is empty.");

      const cursor=this.totals.attempts%poolDays.length;
      const replayDay=poolDays[cursor];
      const sessionTimestamps=[];
      for(const rows of histories.values()){
        for(const row of rows){
          if(etDay(row.ts)===replayDay&&regularSession(row.ts)) sessionTimestamps.push(+new Date(row.ts));
        }
      }
      if(!sessionTimestamps.length) throw new Error("Replay session has no regular-hours minute bars.");
      const replayStart=new Date(Math.min(...sessionTimestamps));
      const replayEnd=new Date(Math.max(...sessionTimestamps)+60*1000);

      const preHistories=new Map();
      for(const [symbol,rows] of histories.entries()){
        const pre=rows.filter(r=>+new Date(r.ts)<+replayStart);
        if(pre.length>=600) preHistories.set(symbol,pre);
      }

      const dataset=this.factory.buildDataset(preHistories,{
        symbols:[...preHistories.keys()],horizon:15,step:5,maxSamples:26000
      });
      if(dataset.length<1800) throw new Error(`Replay ${replayDay} has only ${dataset.length} prior examples; skipping until enough pre-session data exists.`);

      const calSize=Math.max(300,Math.min(2500,Math.floor(dataset.length*.16)));
      const train=dataset.slice(0,-calSize);
      const validation=dataset.slice(-calSize);
      if(train.length<1200||validation.length<250) throw new Error("Replay pre-session train/calibration split is too small.");

      const candidates=[];
      const softmax=new SoftmaxModel({featureCount:train[0].x.length,name:"replay_softmax"});
      softmax.train(train,{epochs:3,learningRate:.022,l2:.001,maxSamples:18000});
      const softCal=chooseTemperature(softmax,validation);
      candidates.push({
        name:"replay_softmax",model:softmax,temperature:softCal.temperature,
        metrics:softCal.metrics
      });

      const boosted=new BoostedStumpModel({featureCount:train[0].x.length,name:"replay_boosted"});
      boosted.train(train,{rounds:12,learningRate:.18,maxSamples:9000});
      const boostCal=chooseTemperature(boosted,validation);
      candidates.push({
        name:"replay_boosted",model:boosted,temperature:boostCal.temperature,
        metrics:boostCal.metrics
      });

      const selected=[...candidates].sort((a,b)=>
        (a.metrics.brier+a.metrics.ece*.20)-(b.metrics.brier+b.metrics.ece*.20)
      )[0];

      const contextMap=this.factory.buildContextMap(histories);
      const trades=[];
      let decisions=0;
      let predictionCorrect=0;
      let predictionScored=0;
      const nextAllowed=new Map();

      for(const [symbol,rows] of histories.entries()){
        const indices=[];
        for(let i=40;i<rows.length-46;i++){
          const ts=+new Date(rows[i].ts);
          if(ts>=+replayStart&&ts<+replayEnd&&regularSession(rows[i].ts)) indices.push(i);
        }
        if(indices.length<80) continue;

        for(let k=0;k<indices.length;k+=5){
          const i=indices[k];
          const row=rows[i];
          const ts=+new Date(row.ts);
          const features=this.factory.extract(rows,i,contextMap.get(ts)||{});
          const target=this.factory.target(rows,i,15);
          if(!features||!target) continue;

          const x=this.factory.vector(features);
          const probs=applyTemperature(selected.model.predict(x),selected.temperature);
          const modelDirection=directionFromProbs(probs);
          const confidence=Math.max(...probs);
          const edge=edgeFromProbs(probs);
          decisions++;
          predictionScored++;
          if(modelDirection===target.direction) predictionCorrect++;

          for(const strategy of STRATEGIES){
            const key=strategy.key+"|"+symbol;
            if(i<(nextAllowed.get(key)||0)) continue;

            let direction=modelDirection;
            if(direction==="FLAT"){
              if(!strategy.allowFlat) continue;
              const diff=Math.abs(probs[0]-probs[2]);
              if(diff<strategy.flatDiff) continue;
              direction=probs[0]>=probs[2]?"UP":"DOWN";
            }else{
              if(confidence<strategy.minConf||edge<strategy.minEdge) continue;
            }
            if(!["UP","DOWN"].includes(direction)) continue;

            const entryIdx=i+1;
            if(!rows[entryIdx]||etDay(rows[entryIdx].ts)!==replayDay) continue;
            const side=direction==="UP"?"LONG":"SHORT";
            const cost=strategy.costBps/10000;
            const rawEntry=Number(rows[entryIdx].open);
            if(!rawEntry) continue;
            const entry=side==="LONG"?rawEntry*(1+cost):rawEntry*(1-cost);

            const maxExit=Math.min(rows.length-1,entryIdx+strategy.hold);
            let exitIdx=maxExit;
            let exitReason="TIME";
            let rawExit=Number(rows[maxExit].close);

            for(let j=entryIdx;j<=maxExit;j++){
              const b=rows[j];
              if(etDay(b.ts)!==replayDay){ exitIdx=j-1; exitReason="SESSION_END"; rawExit=Number(rows[exitIdx].close); break; }
              const high=Number(b.high),low=Number(b.low);
              if(side==="LONG"){
                const stop=entry*(1-strategy.stop);
                const targetPx=entry*(1+strategy.target);
                if(low<=stop){ exitIdx=j; exitReason="STOP"; rawExit=stop; break; }
                if(high>=targetPx){ exitIdx=j; exitReason="TARGET"; rawExit=targetPx; break; }
              }else{
                const stop=entry*(1+strategy.stop);
                const targetPx=entry*(1-strategy.target);
                if(high>=stop){ exitIdx=j; exitReason="STOP"; rawExit=stop; break; }
                if(low<=targetPx){ exitIdx=j; exitReason="TARGET"; rawExit=targetPx; break; }
              }
            }
            if(!rows[exitIdx]) continue;
            const exit=side==="LONG"?rawExit*(1-cost):rawExit*(1+cost);
            const ret=side==="LONG"?(exit-entry)/entry:(entry-exit)/entry;

            trades.push({
              runId,strategy:strategy.key,symbol,
              decisionAt:row.ts,side,
              entryAt:rows[entryIdx].ts,entryPrice:entry,
              exitAt:rows[exitIdx].ts,exitPrice:exit,
              exitReason,return:ret,
              pUp:probs[0],pFlat:probs[1],pDown:probs[2],
              confidence,edge,timeBucket:bucket(row.ts)
            });
            nextAllowed.set(key,exitIdx+1);
          }
        }
        await sleepTick();
      }

      if(!trades.length) throw new Error("Replay Arena generated zero executable trades for the selected session.");

      const strategySummary=STRATEGIES.map(strategy=>{
        const rows=trades.filter(t=>t.strategy===strategy.key);
        const wins=rows.filter(t=>t.return>0);
        const losses=rows.filter(t=>t.return<0);
        const gp=wins.reduce((s,t)=>s+t.return,0);
        const gl=Math.abs(losses.reduce((s,t)=>s+t.return,0));
        let equity=1,peak=1,maxDd=0;
        for(const t of rows.sort((a,b)=>+new Date(a.exitAt)-+new Date(b.exitAt))){
          equity+=t.return;
          peak=Math.max(peak,equity);
          maxDd=Math.min(maxDd,(equity-peak)/peak);
        }
        return {
          strategy:strategy.key,trades:rows.length,wins:wins.length,losses:losses.length,
          winRate:ratio(wins.length,rows.length),
          avgReturn:mean(rows.map(t=>t.return)),
          sumReturn:rows.reduce((s,t)=>s+t.return,0),
          profitFactor:gl?gp/gl:(gp>0?Infinity:null),
          maxDrawdown:maxDd
        };
      }).sort((a,b)=>b.avgReturn-a.avgReturn);

      const symbolMap=new Map();
      const timeMap=new Map();
      for(const t of trades){
        const s=symbolMap.get(t.symbol)||{symbol:t.symbol,trades:0,wins:0,losses:0,sum:0};
        s.trades++; s.sum+=t.return; if(t.return>0)s.wins++; else if(t.return<0)s.losses++;
        symbolMap.set(t.symbol,s);

        const tb=timeMap.get(t.timeBucket)||{bucket:t.timeBucket,trades:0,wins:0,losses:0,sum:0};
        tb.trades++; tb.sum+=t.return; if(t.return>0)tb.wins++; else if(t.return<0)tb.losses++;
        timeMap.set(t.timeBucket,tb);
      }

      const weakSymbols=[...symbolMap.values()]
        .map(x=>({...x,winRate:ratio(x.wins,x.trades),avgReturn:ratio(x.sum,x.trades)}))
        .filter(x=>x.trades>=5)
        .sort((a,b)=>a.avgReturn-b.avgReturn)
        .slice(0,5);
      const weakTimes=[...timeMap.values()]
        .map(x=>({...x,winRate:ratio(x.wins,x.trades),avgReturn:ratio(x.sum,x.trades)}))
        .filter(x=>x.trades>=8)
        .sort((a,b)=>a.avgReturn-b.avgReturn)
        .slice(0,3);

      const focusSymbols=weakSymbols
        .filter(x=>x.avgReturn<0||x.winRate<.45)
        .map(x=>({symbol:x.symbol,samples:x.trades,errorRate:1-x.winRate}));
      const focusTimeBuckets=weakTimes
        .filter(x=>x.avgReturn<0||x.winRate<.45)
        .map(x=>({bucket:x.bucket,samples:x.trades,errorRate:1-x.winRate}));

      this.modelLab?.setReplayFocus?.({
        sourceRunId:runId,replayDay,
        focusSymbols,focusTimeBuckets,
        hardExampleReplayMultiplier:3,
        noFutureLeak:true
      });

      const wins=trades.filter(t=>t.return>0).length;
      const losses=trades.filter(t=>t.return<0).length;
      const summary={
        decisions,
        predictionScored,
        predictionCorrect,
        predictionAccuracy:ratio(predictionCorrect,predictionScored),
        trades:trades.length,wins,losses,
        winRate:ratio(wins,trades.length),
        selectedModel:selected.name,
        selectedValidation:selected.metrics,
        strategies:strategySummary,
        bestStrategy:strategySummary[0]||null,
        weakSymbols,weakTimes,
        focusSymbols,focusTimeBuckets,
        futureHidden:true,
        newest40PctUntouched:true
      };
      const config={
        replayPoolStartPercent:20,
        replayPoolEndPercent:60,
        storedSharedSessions:days.length,
        poolSessions:poolDays.length,
        cursor,
        strategyCount:STRATEGIES.length,
        strategies:STRATEGIES,
        modelSelection:"PRE_SESSION_VALIDATION_ONLY",
        entryRule:"NEXT_BAR_OPEN",
        historicalQuoteApproximation:"FIXED_CONSERVATIVE_BPS_COST",
        runtimeMode:openNow?"MARKET_OPEN_THROTTLED":"MARKET_CLOSED_AGGRESSIVE",
        cycleMaxSymbols
      };

      await this.db.pool.query(`
        INSERT INTO replay_arena_runs(
          run_id,started_at,status,replay_day,model_family,train_start,train_end,symbols,config,summary
        ) VALUES($1,$2,'RUNNING',$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb)
      `,[
        runId,startedAt,replayDay,selected.name,
        new Date(dataset[0].ts),new Date(dataset.at(-1).ts),
        JSON.stringify([...histories.keys()]),JSON.stringify(config),JSON.stringify(summary)
      ]);

      for(let offset=0;offset<trades.length;offset+=300){
        const chunk=trades.slice(offset,offset+300);
        const values=[];
        const tuples=[];
        chunk.forEach((t,i)=>{
          const n=i*17;
          tuples.push("("+Array.from({length:17},(_,j)=>"$"+(n+j+1)).join(",")+")");
          values.push(
            t.runId,t.strategy,t.symbol,t.decisionAt,t.side,t.entryAt,t.entryPrice,
            t.exitAt,t.exitPrice,t.exitReason,t.return,t.pUp,t.pFlat,t.pDown,
            t.confidence,t.edge,t.timeBucket
          );
        });
        await this.db.pool.query(`
          INSERT INTO replay_arena_trades(
            run_id,strategy_key,symbol,decision_at,side,entry_at,entry_price,
            exit_at,exit_price,exit_reason,return,p_up,p_flat,p_down,confidence,edge,time_bucket
          ) VALUES ${tuples.join(",")}
        `,values);
      }

      await this.db.pool.query(`
        UPDATE replay_arena_runs
        SET status='COMPLETE',completed_at=NOW(),summary=$2::jsonb,error=NULL
        WHERE run_id=$1
      `,[runId,JSON.stringify(summary)]);

      this.totals.attempts++;
      this.totals.runs++;
      this.totals.decisions+=decisions;
      this.totals.trades+=trades.length;
      this.totals.wins+=wins;
      this.totals.losses+=losses;
      this.lastRun={
        runId,startedAt,completedAt:new Date(),status:"COMPLETE",replayDay,
        modelFamily:selected.name,summary,config,error:null
      };

      console.log(JSON.stringify({
        event:"replay_arena_complete",
        runId,replayDay,model:selected.name,
        decisions,trades:trades.length,wins,losses,
        bestStrategy:summary.bestStrategy?.strategy||null,
        bestAvgReturn:summary.bestStrategy?.avgReturn||0,
        weakSymbols:focusSymbols.map(x=>x.symbol),
        weakTimes:focusTimeBuckets.map(x=>x.bucket),
        newest40PctUntouched:true
      }));

      return this.lastRun;
    }catch(err){
      this.lastError=String(err?.message||err);
      try{
        await this.db.pool.query(`
          INSERT INTO replay_arena_runs(run_id,started_at,completed_at,status,error)
          VALUES($1,$2,NOW(),'ERROR',$3)
          ON CONFLICT(run_id) DO UPDATE SET status='ERROR',completed_at=NOW(),error=EXCLUDED.error
        `,[runId,startedAt,this.lastError]);
      }catch{}
      this.totals.attempts++;
      console.log(JSON.stringify({event:"replay_arena_error",runId,message:this.lastError}));
      throw err;
    }finally{
      this.running=false;
    }
  }

  #capture(err){
    this.lastError=String(err?.message||err);
  }
}

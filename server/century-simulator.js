import crypto from "node:crypto";

const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const ratio=(n,d)=>d?Number(n)/Number(d):0;
const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0;

const ALLOCATION={
  strict_proof:.05,
  balanced:.08,
  aggressive:.14,
  fast_probe:.08,
  wide_runner:.10
};

const SCENARIOS=[
  {
    key:"baseline_mix",label:"Baseline mixed century",
    extraCostBps:0,shockMult:1,worstBlockChance:.05,crisisBias:1,unknownShockBias:1
  },
  {
    key:"regime_shift",label:"Regime-shift century",
    extraCostBps:1.5,shockMult:1.4,worstBlockChance:.12,crisisBias:1.8,unknownShockBias:1.2
  },
  {
    key:"liquidity_stress",label:"Liquidity-stress century",
    extraCostBps:9,shockMult:1.5,worstBlockChance:.18,crisisBias:1.5,unknownShockBias:1.3
  },
  {
    key:"macro_event",label:"Macro/event-shock century",
    extraCostBps:3,shockMult:2.5,worstBlockChance:.18,crisisBias:2.2,unknownShockBias:1.7
  },
  {
    key:"crash_heavy",label:"Crash-heavy century",
    extraCostBps:5,shockMult:3.5,worstBlockChance:.25,crisisBias:4.0,unknownShockBias:2.0
  },
  {
    key:"adversarial",label:"Adversarial break-it century",
    extraCostBps:12,shockMult:5,worstBlockChance:.45,crisisBias:5.0,unknownShockBias:2.8
  }
];

const REGIMES={
  NORMAL:{vol:1.0,drift:0,costBps:0,shock:.0005},
  TREND_UP:{vol:1.05,drift:.00025,costBps:.2,shock:.0005},
  TREND_DOWN:{vol:1.18,drift:-.00035,costBps:.6,shock:.0008},
  CHOP:{vol:.88,drift:0,costBps:1.2,shock:.0006},
  HIGH_VOL:{vol:1.65,drift:0,costBps:3,shock:.0020},
  CRISIS:{vol:2.35,drift:-.0018,costBps:9,shock:.0100},
  LIQUIDITY_DROUGHT:{vol:1.35,drift:-.00015,costBps:14,shock:.0040}
};

const BASE_TRANSITIONS={
  NORMAL:[["NORMAL",.45],["TREND_UP",.15],["TREND_DOWN",.12],["CHOP",.14],["HIGH_VOL",.09],["CRISIS",.02],["LIQUIDITY_DROUGHT",.03]],
  TREND_UP:[["TREND_UP",.52],["NORMAL",.22],["CHOP",.10],["TREND_DOWN",.05],["HIGH_VOL",.07],["CRISIS",.01],["LIQUIDITY_DROUGHT",.03]],
  TREND_DOWN:[["TREND_DOWN",.46],["NORMAL",.20],["CHOP",.10],["TREND_UP",.06],["HIGH_VOL",.12],["CRISIS",.03],["LIQUIDITY_DROUGHT",.03]],
  CHOP:[["CHOP",.46],["NORMAL",.25],["TREND_UP",.08],["TREND_DOWN",.08],["HIGH_VOL",.08],["CRISIS",.02],["LIQUIDITY_DROUGHT",.03]],
  HIGH_VOL:[["HIGH_VOL",.38],["NORMAL",.20],["TREND_DOWN",.14],["CHOP",.10],["TREND_UP",.06],["CRISIS",.07],["LIQUIDITY_DROUGHT",.05]],
  CRISIS:[["CRISIS",.30],["HIGH_VOL",.30],["TREND_DOWN",.20],["NORMAL",.08],["CHOP",.05],["TREND_UP",.02],["LIQUIDITY_DROUGHT",.05]],
  LIQUIDITY_DROUGHT:[["LIQUIDITY_DROUGHT",.34],["HIGH_VOL",.20],["NORMAL",.20],["CHOP",.10],["TREND_DOWN",.08],["TREND_UP",.03],["CRISIS",.05]]
};

function hash32(input){
  const hex=crypto.createHash("sha256").update(String(input)).digest("hex").slice(0,8);
  return parseInt(hex,16)>>>0;
}
function prng(seed){
  let a=seed>>>0;
  return ()=>{
    a|=0;a=a+0x6D2B79F5|0;
    let t=Math.imul(a^a>>>15,1|a);
    t=t+Math.imul(t^t>>>7,61|t)^t;
    return ((t^t>>>14)>>>0)/4294967296;
  };
}
function pick(rng,arr){ return arr[Math.floor(rng()*arr.length)]||arr[0]; }
function percentile(values,p){
  if(!values.length) return null;
  const a=[...values].sort((x,y)=>x-y);
  const idx=(a.length-1)*clamp(p,0,1);
  const lo=Math.floor(idx),hi=Math.ceil(idx);
  if(lo===hi) return a[lo];
  return a[lo]+(a[hi]-a[lo])*(idx-lo);
}
function safeExp(logValue){
  return Math.exp(clamp(logValue,-25,25));
}
function chooseRegime(rng,current,scenario){
  const rows=BASE_TRANSITIONS[current]||BASE_TRANSITIONS.NORMAL;
  const weighted=rows.map(([name,p])=>{
    let w=p;
    if(name==="CRISIS") w*=scenario.crisisBias;
    if(name==="HIGH_VOL") w*=Math.sqrt(scenario.crisisBias);
    if(name==="LIQUIDITY_DROUGHT") w*=1+Math.max(0,scenario.extraCostBps)/12;
    return [name,w];
  });
  const total=weighted.reduce((s,x)=>s+x[1],0);
  let x=rng()*total;
  for(const [name,w] of weighted){ x-=w; if(x<=0) return name; }
  return weighted.at(-1)?.[0]||"NORMAL";
}
function regimeSideAdjustment(regime,longShare,shortShare){
  const drift=Number(REGIMES[regime]?.drift)||0;
  return drift*(Number(longShare||0)-Number(shortShare||0));
}
function compoundTradeReturns(rows,allocation){
  let log=0;
  for(const r of rows){
    const x=clamp(allocation*(Number(r.return)||0),-.95,1);
    log+=Math.log1p(x);
  }
  return Math.expm1(log);
}
function annualizeStats(daily){
  const years=[];
  for(let i=0;i<daily.length;i+=252){
    const chunk=daily.slice(i,i+252);
    let log=0;
    for(const x of chunk) log+=Math.log1p(clamp(x,-.95,5));
    years.push(Math.expm1(log));
  }
  return years;
}
function equityPath(daily,start=100){
  let logEq=Math.log(start),peak=logEq,maxDd=0;
  for(const r of daily){
    logEq+=Math.log1p(clamp(r,-.95,5));
    peak=Math.max(peak,logEq);
    const dd=Math.exp(logEq-peak)-1;
    maxDd=Math.min(maxDd,dd);
  }
  return {final:start*safeExp(logEq-Math.log(start)),maxDrawdown:maxDd};
}
function sampleWorstPool(days,strategy){
  return days
    .filter(d=>d.strategies[strategy])
    .sort((a,b)=>Number(a.strategies[strategy].baseDaily)-Number(b.strategies[strategy].baseDaily))
    .slice(0,Math.max(1,Math.ceil(days.length*.25)));
}

export class CenturySimulator {
  constructor({
    db,modelLab,worldState,enabled=true,
    years=100,tradingDaysPerYear=252,
    monteCarloPaths=1500,
    intervalMs=15*60*1000
  }={}){
    this.db=db;
    this.modelLab=modelLab;
    this.worldState=worldState;
    this.enabled=Boolean(enabled);
    this.years=Math.max(10,Math.min(200,Number(years)||100));
    this.daysPerYear=Math.max(240,Math.min(260,Number(tradingDaysPerYear)||252));
    this.monteCarloPaths=Math.max(250,Math.min(5000,Number(monteCarloPaths)||1500));
    this.intervalMs=Math.max(5*60*1000,Number(intervalMs)||15*60*1000);
    this.running=false;
    this.timer=null;
    this.lastError=null;
    this.lastRun=null;
    this.lastRetrainRequestedAt=0;
    this.totals={runs:0,coreYears:0,stressYears:0,days:0,paths:0};
    this.startedAt=new Date();
  }

  async init(){
    if(!this.enabled) return;
    await this.db.pool.query(`
      CREATE TABLE IF NOT EXISTS century_sim_runs (
        run_id TEXT PRIMARY KEY,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        status TEXT NOT NULL DEFAULT 'RUNNING',
        core_years INTEGER NOT NULL DEFAULT 100,
        trading_days INTEGER NOT NULL DEFAULT 0,
        scenario_count INTEGER NOT NULL DEFAULT 0,
        monte_carlo_paths INTEGER NOT NULL DEFAULT 0,
        source_replay_days INTEGER NOT NULL DEFAULT 0,
        config JSONB NOT NULL DEFAULT '{}'::jsonb,
        summary JSONB NOT NULL DEFAULT '{}'::jsonb,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS century_sim_runs_recent
        ON century_sim_runs(started_at DESC);
    `);
    await this.db.pool.query(`
      UPDATE century_sim_runs
      SET status='ERROR',completed_at=NOW(),
          error=COALESCE(error,'Service restarted before century simulation completed.')
      WHERE status='RUNNING'
    `);
    await this.#loadState();
    setTimeout(()=>this.runCentury().catch(err=>this.#capture(err)),10000);
    this.timer=setInterval(()=>this.runCentury().catch(err=>this.#capture(err)),this.intervalMs);
  }

  stop(){ clearInterval(this.timer); }

  status(){
    return {
      enabled:this.enabled,
      running:this.running,
      startedAt:this.startedAt,
      lastError:this.lastError,
      lastRun:this.lastRun,
      totals:this.totals,
      policy:{
        coreYears:this.years,
        tradingDaysPerYear:this.daysPerYear,
        scenarios:SCENARIOS.map(x=>x.key),
        scenarioYearsPerRun:this.years*SCENARIOS.length,
        monteCarloPaths:this.monteCarloPaths,
        countsTowardRealMoneyReadiness:false,
        description:"Synthetic century stress testing grounded in real replay-day blocks; not literal historical data."
      }
    };
  }

  async recentRuns(limit=10){
    const q=await this.db.pool.query(`
      SELECT run_id,started_at,completed_at,status,core_years,trading_days,scenario_count,
             monte_carlo_paths,source_replay_days,config,summary,error
      FROM century_sim_runs
      ORDER BY started_at DESC
      LIMIT $1
    `,[Math.max(1,Math.min(30,Number(limit)||10))]);
    return q.rows.map(r=>this.#row(r));
  }

  #row(r){
    return {
      runId:r.run_id,startedAt:r.started_at,completedAt:r.completed_at,status:r.status,
      coreYears:Number(r.core_years)||0,tradingDays:Number(r.trading_days)||0,
      scenarioCount:Number(r.scenario_count)||0,monteCarloPaths:Number(r.monte_carlo_paths)||0,
      sourceReplayDays:Number(r.source_replay_days)||0,config:r.config||{},summary:r.summary||{},
      error:r.error||null
    };
  }

  async #loadState(){
    const [agg,last]=await Promise.all([
      this.db.pool.query(`
        SELECT COUNT(*) FILTER (WHERE status='COMPLETE')::int runs,
               COALESCE(SUM(core_years) FILTER (WHERE status='COMPLETE'),0)::bigint core_years,
               COALESCE(SUM(core_years*scenario_count) FILTER (WHERE status='COMPLETE'),0)::bigint stress_years,
               COALESCE(SUM(trading_days) FILTER (WHERE status='COMPLETE'),0)::bigint days,
               COALESCE(SUM(monte_carlo_paths) FILTER (WHERE status='COMPLETE'),0)::bigint paths
        FROM century_sim_runs
      `),
      this.db.pool.query(`
        SELECT * FROM century_sim_runs ORDER BY started_at DESC LIMIT 1
      `)
    ]);
    const a=agg.rows[0]||{};
    this.totals={
      runs:Number(a.runs)||0,coreYears:Number(a.core_years)||0,
      stressYears:Number(a.stress_years)||0,days:Number(a.days)||0,paths:Number(a.paths)||0
    };
    if(last.rows[0]) this.lastRun=this.#row(last.rows[0]);
  }

  async #loadReplayBlocks(){
    const q=await this.db.pool.query(`
      WITH recent_runs AS (
        SELECT DISTINCT ON (replay_day) run_id,replay_day
        FROM replay_arena_runs
        WHERE status='COMPLETE' AND replay_day IS NOT NULL
        ORDER BY replay_day DESC,completed_at DESC
        LIMIT 180
      )
      SELECT r.run_id,r.replay_day,t.strategy_key,t.symbol,t.side,t.return,t.time_bucket,t.exit_reason
      FROM recent_runs r
      JOIN replay_arena_trades t ON t.run_id=r.run_id
      ORDER BY r.replay_day,t.id
    `);
    const byDay=new Map();
    const strategySet=new Set();
    for(const row of q.rows){
      const day=String(row.replay_day).slice(0,10);
      if(!byDay.has(day)) byDay.set(day,{day,strategies:{},allTrades:[]});
      const d=byDay.get(day);
      const strategy=String(row.strategy_key);
      strategySet.add(strategy);
      if(!d.strategies[strategy]) d.strategies[strategy]={rows:[]};
      const trade={
        symbol:String(row.symbol),side:String(row.side),return:Number(row.return)||0,
        timeBucket:String(row.time_bucket||"UNKNOWN"),exitReason:String(row.exit_reason||"")
      };
      d.strategies[strategy].rows.push(trade);
      d.allTrades.push({...trade,strategy});
    }

    const strategies=[...strategySet].filter(x=>ALLOCATION[x]!=null);
    const days=[...byDay.values()].sort((a,b)=>a.day.localeCompare(b.day));
    for(const d of days){
      for(const strategy of strategies){
        const entry=d.strategies[strategy];
        if(!entry?.rows?.length) continue;
        const allocation=ALLOCATION[strategy];
        const longs=entry.rows.filter(x=>x.side==="LONG").length;
        const shorts=entry.rows.length-longs;
        entry.trades=entry.rows.length;
        entry.longShare=ratio(longs,entry.rows.length);
        entry.shortShare=ratio(shorts,entry.rows.length);
        entry.baseDaily=compoundTradeReturns(entry.rows,allocation);
        entry.avgAbs=mean(entry.rows.map(x=>Math.abs(x.return)));
        entry.lossRate=ratio(entry.rows.filter(x=>x.return<0).length,entry.rows.length);
      }
    }
    return {days,strategies};
  }

  #simulateScenario({scenario,days,strategies,rng,world}){
    const targetDays=this.years*this.daysPerYear;
    const results={};
    const schedules=[];
    let regime="NORMAL";
    const currentEventRisk=Number(world?.global?.eventRisk)||0;
    const currentUnknown=Number(world?.global?.unobservableShockReserve)||.12;
    const currentMacro=Number(world?.global?.macro?.stress)||0;
    const currentCross=Number(world?.global?.crossAsset?.riskOff)||0;

    for(let i=0;i<targetDays;i++){
      regime=chooseRegime(rng,regime,scenario);
      const worst= rng()<scenario.worstBlockChance;
      schedules.push({
        regime,worst,
        shockU:rng(),
        shockSizeU:rng(),
        blockU:rng(),
        signU:rng()
      });
    }

    for(const strategy of strategies){
      const allocation=ALLOCATION[strategy]||.05;
      const available=days.filter(d=>d.strategies[strategy]);
      const worstPool=sampleWorstPool(available,strategy);
      const daily=[];
      const annual=[];
      const lossBySymbol=new Map();
      const lossByTime=new Map();
      let shockDays=0;
      let catastrophicDays=0;

      for(let i=0;i<targetDays;i++){
        const sched=schedules[i];
        const sourcePool=sched.worst&&worstPool.length?worstPool:available;
        const day=sourcePool[Math.floor(sched.blockU*sourcePool.length)]||available[0];
        const block=day?.strategies?.[strategy];
        if(!block){ daily.push(0); continue; }

        const reg=REGIMES[sched.regime]||REGIMES.NORMAL;
        const base=Number(block.baseDaily)||0;
        const sideAdj=regimeSideAdjustment(sched.regime,block.longShare,block.shortShare)
          * Math.max(1,Number(block.trades)||1)*allocation;
        const costBps=(reg.costBps+scenario.extraCostBps)
          * Math.max(1,Number(block.trades)||1)*allocation;
        let ret=base*reg.vol+sideAdj-(costBps/10000);

        const shockProb=clamp(
          (reg.shock*scenario.shockMult)+
          .0015*scenario.unknownShockBias+
          .0030*currentEventRisk+
          .0020*currentUnknown+
          .0015*currentMacro+
          .0010*currentCross,
          0,.12
        );
        if(sched.shockU<shockProb){
          shockDays++;
          const harmful=scenario.key==="adversarial" || sched.signU<.78;
          const magnitude=(.008+.072*(sched.shockSizeU**2))*scenario.unknownShockBias;
          ret+=harmful?-magnitude:magnitude*.55;
          if(magnitude>=.04&&harmful) catastrophicDays++;
        }
        if(sched.regime==="CRISIS"&&scenario.key==="adversarial"){
          ret-=.003+.012*sched.shockSizeU;
        }

        ret=clamp(ret,-.50,.35);
        daily.push(ret);

        for(const tr of block.rows){
          const sm=lossBySymbol.get(tr.symbol)||{symbol:tr.symbol,samples:0,losses:0,sum:0};
          sm.samples++;
          if(ret<0) sm.losses++;
          sm.sum+=ret;
          lossBySymbol.set(tr.symbol,sm);

          const tm=lossByTime.get(tr.timeBucket)||{bucket:tr.timeBucket,samples:0,losses:0,sum:0};
          tm.samples++;
          if(ret<0) tm.losses++;
          tm.sum+=ret;
          lossByTime.set(tr.timeBucket,tm);
        }
      }

      annual.push(...annualizeStats(daily));
      const eq=equityPath(daily,100);
      const negativeDays=daily.filter(x=>x<0).length;
      const worstDay=Math.min(...daily);
      const bestDay=Math.max(...daily);
      const avgDay=mean(daily);
      const yearly=annual;
      const positiveYears=yearly.filter(x=>x>0).length;

      const pathFinals=[];
      const pathDrawdowns=[];
      let belowStart=0,drawdown50=0;
      for(let p=0;p<this.monteCarloPaths;p++){
        let logEq=Math.log(100),peak=logEq,maxDd=0;
        for(let y=0;y<this.years;y++){
          const yr=pick(rng,yearly);
          logEq+=Math.log1p(clamp(Number(yr)||0,-.95,8));
          peak=Math.max(peak,logEq);
          maxDd=Math.min(maxDd,Math.exp(logEq-peak)-1);
        }
        const final=100*safeExp(logEq-Math.log(100));
        pathFinals.push(final);
        pathDrawdowns.push(maxDd);
        if(final<100) belowStart++;
        if(maxDd<=-.50) drawdown50++;
      }

      results[strategy]={
        strategy,scenario:scenario.key,allocation,
        days:daily.length,years:yearly.length,
        avgDay,worstDay,bestDay,negativeDayRate:ratio(negativeDays,daily.length),
        avgYear:mean(yearly),medianYear:percentile(yearly,.50),
        p05Year:percentile(yearly,.05),p01Year:percentile(yearly,.01),
        worstYear:Math.min(...yearly),bestYear:Math.max(...yearly),
        positiveYearRate:ratio(positiveYears,yearly.length),
        sequentialFinal100:eq.final,sequentialMaxDrawdown:eq.maxDrawdown,
        monteCarlo:{
          paths:this.monteCarloPaths,
          p01Final:percentile(pathFinals,.01),
          p05Final:percentile(pathFinals,.05),
          medianFinal:percentile(pathFinals,.50),
          p95Final:percentile(pathFinals,.95),
          chanceBelowStart:ratio(belowStart,this.monteCarloPaths),
          chanceDrawdown50:ratio(drawdown50,this.monteCarloPaths),
          medianMaxDrawdown:percentile(pathDrawdowns,.50),
          p95WorstDrawdown:percentile(pathDrawdowns,.05)
        },
        shockDays,catastrophicDays,
        weakSymbols:[...lossBySymbol.values()]
          .sort((a,b)=>a.sum-b.sum).slice(0,6),
        weakTimes:[...lossByTime.values()]
          .sort((a,b)=>a.sum-b.sum).slice(0,4)
      };
    }

    return results;
  }

  async runCentury(){
    if(!this.enabled||this.running) return this.lastRun;
    this.running=true;
    this.lastError=null;
    const runId="CENTURY-"+crypto.randomUUID();
    const startedAt=new Date();

    try{
      console.log(JSON.stringify({
        event:"century_sim_started",runId,
        coreYears:this.years,tradingDays:this.years*this.daysPerYear,
        scenarios:SCENARIOS.length,monteCarloPathsPerWorld:this.monteCarloPaths
      }));
      const source=await this.#loadReplayBlocks();
      if(source.days.length<5) throw new Error("Century Simulator needs at least 5 completed Replay Arena days.");
      if(source.strategies.length<2) throw new Error("Century Simulator needs at least 2 replay-tested policies.");

      const world=this.worldState?.status?.()||{};
      const scenarioResults={};
      for(const scenario of SCENARIOS){
        const rng=prng(hash32(runId+"|"+scenario.key));
        scenarioResults[scenario.key]=this.#simulateScenario({
          scenario,days:source.days,strategies:source.strategies,rng,world
        });
      }

      const strategySummary={};
      for(const strategy of source.strategies){
        const rows=SCENARIOS.map(s=>scenarioResults[s.key]?.[strategy]).filter(Boolean);
        const worstByP05=[...rows].sort((a,b)=>
          Number(a.monteCarlo?.p05Final||0)-Number(b.monteCarlo?.p05Final||0)
        )[0];
        const worstByDrawdown=[...rows].sort((a,b)=>
          Number(a.sequentialMaxDrawdown||0)-Number(b.sequentialMaxDrawdown||0)
        )[0];
        const worstChance=Math.max(...rows.map(x=>Number(x.monteCarlo?.chanceBelowStart)||0));
        const worst50=Math.max(...rows.map(x=>Number(x.monteCarlo?.chanceDrawdown50)||0));
        const medianFinalMedian=percentile(rows.map(x=>Number(x.monteCarlo?.medianFinal)||0),.50);
        const robustScore=
          Math.log(Math.max(.01,Number(worstByP05?.monteCarlo?.p05Final)||.01))
          -2.5*worstChance
          -2.0*worst50
          +0.4*Math.log(Math.max(.01,medianFinalMedian));

        strategySummary[strategy]={
          strategy,robustScore,
          medianFinalAcrossWorlds:medianFinalMedian,
          worstWorld:worstByP05?.scenario||null,
          worstP05Final:worstByP05?.monteCarlo?.p05Final??null,
          worstChanceBelowStart:worstChance,
          worstChanceDrawdown50:worst50,
          worstSequentialDrawdown:worstByDrawdown?.sequentialMaxDrawdown??null,
          positiveWorlds:rows.filter(x=>Number(x.avgYear)>0).length,
          worlds:rows.length
        };
      }

      const ranked=Object.values(strategySummary).sort((a,b)=>b.robustScore-a.robustScore);
      const survivalGates={
        requireAllWorldsPositive:true,
        minWorstP05Ending100:100,
        maxWorstChanceBelowStart:.05,
        maxChanceDrawdown50:.005,
        maxWorstSequentialDrawdown:-.25
      };
      const survivors=ranked.filter(x=>
        x.positiveWorlds===x.worlds &&
        Number(x.worstP05Final)>=survivalGates.minWorstP05Ending100 &&
        Number(x.worstChanceBelowStart)<=survivalGates.maxWorstChanceBelowStart &&
        Number(x.worstChanceDrawdown50)<=survivalGates.maxChanceDrawdown50 &&
        Number(x.worstSequentialDrawdown)>=survivalGates.maxWorstSequentialDrawdown
      );
      const candidate=survivors[0]||null;
      const leastFragile=ranked[0]||null;

      const adverseRows=[];
      for(const scenario of SCENARIOS){
        for(const strategy of source.strategies){
          const r=scenarioResults[scenario.key]?.[strategy];
          if(r) adverseRows.push(r);
        }
      }
      const symbolAgg=new Map();
      const timeAgg=new Map();
      for(const r of adverseRows){
        for(const x of r.weakSymbols||[]){
          const s=symbolAgg.get(x.symbol)||{symbol:x.symbol,samples:0,losses:0,score:0};
          s.samples+=Number(x.samples)||0;s.losses+=Number(x.losses)||0;s.score+=Number(x.sum)||0;
          symbolAgg.set(x.symbol,s);
        }
        for(const x of r.weakTimes||[]){
          const t=timeAgg.get(x.bucket)||{bucket:x.bucket,samples:0,losses:0,score:0};
          t.samples+=Number(x.samples)||0;t.losses+=Number(x.losses)||0;t.score+=Number(x.sum)||0;
          timeAgg.set(x.bucket,t);
        }
      }

      const focusSymbols=[...symbolAgg.values()]
        .sort((a,b)=>a.score-b.score)
        .slice(0,6)
        .map(x=>({symbol:x.symbol,samples:x.samples,errorRate:ratio(x.losses,x.samples)}));
      const focusTimeBuckets=[...timeAgg.values()]
        .sort((a,b)=>a.score-b.score)
        .slice(0,4)
        .map(x=>({bucket:x.bucket,samples:x.samples,errorRate:ratio(x.losses,x.samples)}));

      this.modelLab?.setReplayFocus?.({
        sourceRunId:runId,
        replayDay:"SYNTHETIC_CENTURY",
        focusSymbols,focusTimeBuckets,
        hardExampleReplayMultiplier:4,
        noFutureLeak:true
      });

      const summary={
        coreYears:this.years,
        tradingDays:this.years*this.daysPerYear,
        scenarioCount:SCENARIOS.length,
        stressEquivalentYears:this.years*SCENARIOS.length,
        monteCarloPathsPerWorld:this.monteCarloPaths,
        totalMonteCarloPaths:this.monteCarloPaths*SCENARIOS.length*source.strategies.length,
        sourceReplayDays:source.days.length,
        strategies:strategySummary,
        rankedStrategies:ranked,
        survivalGates,
        survivors:survivors.map(x=>x.strategy),
        centuryVerdict:candidate?"SURVIVOR_FOUND":"NO_POLICY_SURVIVED",
        robustResearchCandidate:candidate,
        leastFragilePolicy:leastFragile,
        focusSymbols,focusTimeBuckets,
        scenarioResults,
        worldInputs:{
          sourceCoverage:Number(world?.global?.sourceCoverage)||0,
          eventRisk:Number(world?.global?.eventRisk)||0,
          macroStress:Number(world?.global?.macro?.stress)||0,
          crossAssetStress:Number(world?.global?.crossAsset?.riskOff)||0,
          unobservableShockReserve:Number(world?.global?.unobservableShockReserve)||0
        },
        caveats:{
          synthetic:true,
          literalHistoricalCentury:false,
          countsTowardRealMoneyReadiness:false,
          selectionIsResearchOnly:true
        }
      };
      const config={
        years:this.years,daysPerYear:this.daysPerYear,
        scenarios:SCENARIOS,regimes:REGIMES,
        allocations:ALLOCATION,monteCarloPaths:this.monteCarloPaths,
        source:"Replay Arena completed no-hindsight trade-day blocks + current World State stress parameters"
      };

      await this.db.pool.query(`
        INSERT INTO century_sim_runs(
          run_id,started_at,completed_at,status,core_years,trading_days,scenario_count,
          monte_carlo_paths,source_replay_days,config,summary,error
        ) VALUES($1,$2,NOW(),'COMPLETE',$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,NULL)
      `,[
        runId,startedAt,this.years,this.years*this.daysPerYear,SCENARIOS.length,
        this.monteCarloPaths,source.days.length,JSON.stringify(config),JSON.stringify(summary)
      ]);

      this.lastRun={
        runId,startedAt,completedAt:new Date(),status:"COMPLETE",
        coreYears:this.years,tradingDays:this.years*this.daysPerYear,
        scenarioCount:SCENARIOS.length,monteCarloPaths:this.monteCarloPaths,
        sourceReplayDays:source.days.length,config,summary,error:null
      };
      this.totals.runs++;
      this.totals.coreYears+=this.years;
      this.totals.stressYears+=this.years*SCENARIOS.length;
      this.totals.days+=this.years*this.daysPerYear;
      this.totals.paths+=this.monteCarloPaths*SCENARIOS.length*source.strategies.length;

      console.log(JSON.stringify({
        event:"century_sim_complete",runId,
        coreYears:this.years,
        tradingDays:this.years*this.daysPerYear,
        stressEquivalentYears:this.years*SCENARIOS.length,
        sourceReplayDays:source.days.length,
        strategies:source.strategies,
        totalMonteCarloPaths:summary.totalMonteCarloPaths,
        centuryVerdict:summary.centuryVerdict,
        robustResearchCandidate:candidate?.strategy||null,
        leastFragilePolicy:leastFragile?.strategy||null,
        candidateWorstP05Final:candidate?.worstP05Final??null,
        candidateWorstChanceBelowStart:candidate?.worstChanceBelowStart??null,
        candidateWorstDrawdown50:candidate?.worstChanceDrawdown50??null,
        focusSymbols:focusSymbols.map(x=>x.symbol),
        focusTimeBuckets:focusTimeBuckets.map(x=>x.bucket),
        countsTowardRealMoneyReadiness:false,
        durationMs:Date.now()-startedAt.getTime()
      }));

      if(!candidate) await this.#requestFailureRetrain(summary);

      return this.lastRun;
    }catch(err){
      this.lastError=String(err?.message||err);
      try{
        await this.db.pool.query(`
          INSERT INTO century_sim_runs(
            run_id,started_at,completed_at,status,core_years,trading_days,scenario_count,
            monte_carlo_paths,source_replay_days,error
          ) VALUES($1,$2,NOW(),'ERROR',$3,0,0,$4,0,$5)
          ON CONFLICT(run_id) DO UPDATE SET status='ERROR',completed_at=NOW(),error=EXCLUDED.error
        `,[runId,startedAt,this.years,this.monteCarloPaths,this.lastError]);
      }catch{}
      console.log(JSON.stringify({event:"century_sim_error",runId,message:this.lastError}));
      throw err;
    }finally{
      this.running=false;
    }
  }

  async #requestFailureRetrain(summary){
    if(!this.modelLab||this.modelLab.training) return;
    const latest=this.modelLab.status?.().latestRun;
    const latestReason=String(latest?.dataset?.reason||"");
    const latestAt=latest?.startedAt?+new Date(latest.startedAt):0;
    const priorCentury=latestReason==="century_stress_failure";
    const last=Math.max(
      priorCentury?(latestAt||0):0,
      this.lastRetrainRequestedAt||0
    );
    const cooldown=3*60*60*1000;
    if(priorCentury&&Date.now()-last<cooldown) return;
    if(!priorCentury&&this.lastRetrainRequestedAt&&Date.now()-this.lastRetrainRequestedAt<cooldown) return;

    this.lastRetrainRequestedAt=Date.now();
    console.log(JSON.stringify({
      event:"century_retrain_requested",
      reason:"century_stress_failure",
      verdict:summary?.centuryVerdict,
      leastFragilePolicy:summary?.leastFragilePolicy?.strategy||null,
      focusSymbols:(summary?.focusSymbols||[]).map(x=>x.symbol),
      focusTimeBuckets:(summary?.focusTimeBuckets||[]).map(x=>x.bucket)
    }));
    setTimeout(()=>{
      this.modelLab.trainNow("century_stress_failure")
        .catch(err=>this.#capture(err));
    },1000);
  }

  #capture(err){
    this.lastError=String(err?.message||err);
  }
}

const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0;
const stdev=a=>{
  if(a.length<2) return 0;
  const m=mean(a);
  return Math.sqrt(a.reduce((s,x)=>s+(x-m)**2,0)/(a.length-1));
};
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));

function classIndex(name){return name==="UP"?0:name==="DOWN"?2:1;}
function metrics(rows){
  if(!rows.length) return {samples:0,accuracy:null,brier:null,ece:null};
  let correct=0,brier=0;
  const buckets=Array.from({length:10},()=>({n:0,conf:0,correct:0}));
  for(const r of rows){
    const p=[Number(r.p_up)||0,Number(r.p_flat)||0,Number(r.p_down)||0];
    const yi=classIndex(r.actual_direction);
    const pi=p.indexOf(Math.max(...p));
    if(pi===yi) correct++;
    for(let c=0;c<3;c++){
      const d=p[c]-(c===yi?1:0);
      brier+=d*d/3;
    }
    const conf=Math.max(...p);
    const bi=Math.min(9,Math.floor(conf*10));
    buckets[bi].n++;buckets[bi].conf+=conf;if(pi===yi)buckets[bi].correct++;
  }
  let ece=0;
  for(const b of buckets){
    if(!b.n) continue;
    ece+=(b.n/rows.length)*Math.abs(b.conf/b.n-b.correct/b.n);
  }
  return {samples:rows.length,accuracy:correct/rows.length,brier:brier/rows.length,ece};
}
function gate(key,passed,current,requirement,message){
  return {key,passed,status:passed?"PASS":"FAIL",current,requirement,message};
}

export class GovernanceEngine {
  constructor({db,modelLab,paperBroker,eventEngine=null,manualApproval=false}){
    this.db=db;
    this.modelLab=modelLab;
    this.paperBroker=paperBroker;
    this.eventEngine=eventEngine;
    this.manualApproval=Boolean(manualApproval);
    this.timer=null;
    this.lastEvaluation=null;
    this.lastDrift=null;
    this.lastError=null;
  }

  async init(){
    await this.evaluate().catch(err=>this.#capture(err));
    this.timer=setInterval(()=>this.evaluate().catch(err=>this.#capture(err)),5*60*1000);
  }
  stop(){clearInterval(this.timer);}

  status(){
    return {
      readiness:this.lastEvaluation,
      drift:this.lastDrift,
      lastError:this.lastError
    };
  }

  async #productionRecent(){
    const prod=this.modelLab?.productionRecord;
    if(!prod?.model_id) return {prod:null,recent:[],prior:[]};
    const q=await this.db.pool.query(`
      SELECT created_at,p_up,p_flat,p_down,actual_direction,features
      FROM predictions
      WHERE model_id=$1 AND status='SCORED'
      ORDER BY created_at DESC
      LIMIT 700
    `,[prod.model_id]);
    const rows=q.rows;
    return {prod,recent:rows.slice(0,200),prior:rows.slice(200,700)};
  }

  #featureDrift(recent,prior){
    if(recent.length<60||prior.length<120) return {score:0,features:[]};
    const keys=new Set();
    for(const r of [...recent.slice(0,20),...prior.slice(0,20)]){
      for(const k of Object.keys(r.features||{})){
        if(typeof r.features?.[k]==="number") keys.add(k);
      }
    }
    const scores=[];
    for(const key of keys){
      const a=recent.map(r=>Number(r.features?.[key])).filter(Number.isFinite);
      const b=prior.map(r=>Number(r.features?.[key])).filter(Number.isFinite);
      if(a.length<40||b.length<80) continue;
      const sd=Math.max(.05,stdev(b));
      const z=Math.abs(mean(a)-mean(b))/sd;
      if(Number.isFinite(z)) scores.push({feature:key,z,recentMean:mean(a),baselineMean:mean(b)});
    }
    scores.sort((x,y)=>y.z-x.z);
    return {score:scores.length?mean(scores.slice(0,Math.min(8,scores.length)).map(x=>x.z)):0,features:scores.slice(0,8)};
  }

  async evaluateDrift(){
    const {prod,recent,prior}=await this.#productionRecent();
    if(!prod){
      this.lastDrift={status:"NO_PRODUCTION",active:false,samples:0};
      return this.lastDrift;
    }
    const recentMetrics=metrics(recent);
    const baseline=prod.test_metrics||{};
    const brierRatio=recentMetrics.brier!=null&&Number(baseline.brier)>0
      ? recentMetrics.brier/Number(baseline.brier)
      : null;
    const accuracyDrop=recentMetrics.accuracy!=null&&baseline.accuracy!=null
      ? Number(baseline.accuracy)-recentMetrics.accuracy
      : null;
    const featureDrift=this.#featureDrift(recent,prior);

    let status="STABLE";
    if(recentMetrics.samples>=100){
      if((brierRatio!=null&&brierRatio>=1.5)||(accuracyDrop!=null&&accuracyDrop>=.12)||recentMetrics.ece>=.15||featureDrift.score>=1.75){
        status="CRITICAL";
      }else if((brierRatio!=null&&brierRatio>=1.25)||(accuracyDrop!=null&&accuracyDrop>=.08)||recentMetrics.ece>=.10||featureDrift.score>=1.25){
        status="DEGRADED";
      }
    }else status="COLLECTING";

    const active=status==="CRITICAL"||status==="DEGRADED";
    const drift={
      modelId:prod.model_id,status,active,
      recent:recentMetrics,
      baseline:{accuracy:Number(baseline.accuracy)||null,brier:Number(baseline.brier)||null,ece:Number(baseline.ece)||null},
      brierRatio,accuracyDrop,featureDrift,
      evaluatedAt:new Date().toISOString()
    };

    if(active){
      const old=await this.db.pool.query(`
        SELECT alert_id,status FROM drift_alerts
        WHERE active=true AND model_id=$1 AND metric='COMPOSITE'
        ORDER BY created_at DESC LIMIT 1
      `,[prod.model_id]);
      if(!old.rowCount||old.rows[0].status!==status){
        await this.db.pool.query(`
          INSERT INTO drift_alerts(model_id,status,metric,baseline,recent,ratio,sample_count,details,active)
          VALUES($1,$2,'COMPOSITE',$3,$4,$5,$6,$7::jsonb,true)
        `,[
          prod.model_id,status,Number(baseline.brier)||null,recentMetrics.brier,brierRatio,
          recentMetrics.samples,JSON.stringify(drift)
        ]);
      }
      if(status==="CRITICAL"){
        await this.paperBroker.setAutopilot(false).catch(()=>{});
      }
    }else{
      await this.db.pool.query(`
        UPDATE drift_alerts SET active=false,resolved_at=NOW()
        WHERE active=true AND model_id=$1
      `,[prod.model_id]);
    }
    this.lastDrift=drift;
    return drift;
  }

  async evaluateReadiness(drift){
    const lab=this.modelLab?.status?.()||{};
    const prod=lab.production||null;
    const live=prod?.liveMetrics||{};
    const wf=prod?.walkForwardMetrics||{};
    const paper=await this.paperBroker.snapshot();

    const [quality,historical,findings,shadowSlices,eventCount]=await Promise.all([
      this.db.activeDataQualityFlags(),
      this.db.historicalUniverseStats(),
      this.db.pool.query(`
        SELECT
          COUNT(*) FILTER(WHERE status='PROMOTED' AND validation_version='chronological-v2')::int AS promoted,
          COUNT(*) FILTER(WHERE status='REJECTED' AND validation_version='chronological-v2')::int AS rejected
        FROM research_pattern_findings
      `),
      this.db.pool.query(`
        SELECT COUNT(DISTINCT regime)::int AS regimes,
               COUNT(DISTINCT time_bucket)::int AS time_buckets
        FROM model_shadow_predictions
        WHERE status='SCORED' AND ($1::text IS NULL OR model_id=$1)
      `,[prod?.modelId||null]),
      this.db.pool.query("SELECT COUNT(*)::int AS n FROM market_events")
    ]);

    const criticalQuality=quality.filter(x=>["CRITICAL","ERROR"].includes(x.severity)).length;
    const promotedFindings=Number(findings.rows[0]?.promoted)||0;
    const regimes=Number(shadowSlices.rows[0]?.regimes)||0;
    const timeBuckets=Number(shadowSlices.rows[0]?.time_buckets)||0;
    const events=Number(eventCount.rows[0]?.n)||0;

    const gates=[
      gate("production_model",Boolean(prod),{modelId:prod?.modelId||null},{required:true},"A production model must exist."),
      gate("historical_validation",promotedFindings>=25,{promoted:promotedFindings},{minPromoted:25},"At least 25 patterns must survive chronological validation/holdout."),
      gate("survivorship_coverage",Number(historical.historicalOnly)>=100,{historicalOnly:Number(historical.historicalOnly)||0,currentActive:Number(historical.currentActive)||0},{minHistoricalOnly:100},"Research must include historical-only securities, not just today's survivors."),
      gate("live_samples",Number(live.samples)>=2000,{samples:Number(live.samples)||0},{min:2000},"Production needs at least 2,000 future scored predictions."),
      gate("live_calibration",(Number(live.samples)>=2000&&Number(live.brier)<=.21&&Number(live.ece)<=.07),{brier:live.brier??null,ece:live.ece??null},{maxBrier:.21,maxEce:.07},"Live probabilities must stay calibrated."),
      gate("walk_forward",(Number(wf.folds?.length)>=4&&Number(wf.accuracyStd)<=.08),{folds:Number(wf.folds?.length)||0,accuracyStd:wf.accuracyStd??null},{minFolds:4,maxAccuracyStd:.08},"Historical edge must survive multiple walk-forward windows."),
      gate("regime_coverage",(regimes>=3&&timeBuckets>=3),{regimes,timeBuckets},{minRegimes:3,minTimeBuckets:3},"Live proof must span different market regimes and times of day."),
      gate("paper_sample",Number(paper.closedOutcomes)>=200,{closedOutcomes:Number(paper.closedOutcomes)||0},{min:200},"Paper execution needs at least 200 closed outcomes."),
      gate("paper_economics",(Number(paper.closedOutcomes)>=200&&Number(paper.realizedPnl)>0&&Number(paper.profitFactor)>=1.2&&Number(paper.maxDrawdown)>=-.10),{
        realizedPnl:paper.realizedPnl,profitFactor:paper.profitFactor,maxDrawdown:paper.maxDrawdown
      },{realizedPnl:">0",minProfitFactor:1.2,maxDrawdown:"-10%"},"Paper P/L must remain positive after deterministic execution costs."),
      gate("data_quality",criticalQuality===0,{criticalFlags:criticalQuality,totalFlags:quality.length},{criticalFlags:0},"No unresolved critical data-quality issue."),
      gate("drift",!["CRITICAL","DEGRADED"].includes(drift?.status),{status:drift?.status||"UNKNOWN"},{allowed:["STABLE","COLLECTING"]},"Production must not be in a drift/degradation state."),
      gate("event_awareness",events>=1||Boolean(this.eventEngine),{storedEvents:events,eventEngine:Boolean(this.eventEngine)},{engineRequired:true},"Event-risk engine must be active."),
      gate("manual_approval",this.manualApproval,{approved:this.manualApproval},{required:true},"You must manually approve any future tiny live-money experiment.")
    ];

    const passedWithoutManual=gates.filter(g=>g.key!=="manual_approval").every(g=>g.passed);
    const eligibleForManualReview=passedWithoutManual;
    const realMoneyEnabled=false;
    let status="LOCKED";
    if(eligibleForManualReview&&!this.manualApproval) status="REVIEW_ELIGIBLE";
    else if(gates.filter(g=>g.passed).length>=7) status="PROVING";
    if(drift?.status==="CRITICAL"||criticalQuality>0) status="NOT_READY";

    const score=gates.filter(g=>g.key!=="manual_approval").reduce((s,g)=>s+(g.passed?1:0),0)/
      Math.max(1,gates.filter(g=>g.key!=="manual_approval").length);

    for(const g of gates){
      await this.db.pool.query(`
        INSERT INTO readiness_gates(gate_key,status,passed,current_value,requirement,message,updated_at)
        VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,NOW())
        ON CONFLICT(gate_key) DO UPDATE SET
          status=EXCLUDED.status,passed=EXCLUDED.passed,current_value=EXCLUDED.current_value,
          requirement=EXCLUDED.requirement,message=EXCLUDED.message,updated_at=NOW()
      `,[g.key,g.status,g.passed,JSON.stringify(g.current),JSON.stringify(g.requirement),g.message]);
    }
    await this.db.pool.query(`
      INSERT INTO readiness_snapshots(status,eligible,score,gates,notes)
      VALUES($1,$2,$3,$4::jsonb,$5::jsonb)
    `,[
      status,eligibleForManualReview,score,JSON.stringify(gates),
      JSON.stringify([
        "Real-money execution is not implemented/enabled by readiness alone.",
        "Any future live test requires explicit manual approval and a separate tiny-risk broker integration."
      ])
    ]);

    const result={
      status,score,eligibleForManualReview,realMoneyEnabled,
      manualApproval:this.manualApproval,gates,
      evaluatedAt:new Date().toISOString()
    };
    this.lastEvaluation=result;
    return result;
  }

  async #updateScoreboard(readiness,drift){
    const historical=await this.db.historicalUniverseStats();
    const findings=await this.db.pool.query(`
      SELECT
        COUNT(*) FILTER(WHERE validation_version='chronological-v2')::int AS validated,
        COUNT(*) FILTER(WHERE status='PROMOTED' AND validation_version='chronological-v2')::int AS promoted
      FROM research_pattern_findings
    `);
    const lab=this.modelLab?.status?.()||{};
    const paper=await this.paperBroker.snapshot();
    const events=await this.db.pool.query("SELECT COUNT(*)::int AS n FROM market_events");
    const quality=await this.db.activeDataQualityFlags();

    const stages=[
      ["historical_validation","Historical validation",Number(findings.rows[0]?.promoted)>=25,
        Math.min(1,(Number(findings.rows[0]?.promoted)||0)/25),
        `${Number(findings.rows[0]?.promoted)||0} patterns survived discovery → validation → holdout`],
      ["survivorship","Survivorship / corporate actions",Number(historical.historicalOnly)>=100,
        Math.min(1,(Number(historical.historicalOnly)||0)/100),
        `${Number(historical.historicalOnly)||0} historical-only securities included; ${quality.length} active data-quality flags`],
      ["model_diversity","Model diversity",Boolean(lab.latestRun?.candidates?.length>=5),Math.min(1,(lab.latestRun?.candidates?.length||0)/5),
        `${lab.latestRun?.candidates?.length||0} model candidates in latest lab run`],
      ["market_context","Whole-market context",true,1,"SPY/QQQ, breadth, dispersion, cross-sectional rank and sector-relative features enabled"],
      ["event_awareness","Event awareness",Boolean(this.eventEngine),Boolean(this.eventEngine)?1:0,
        `${Number(events.rows[0]?.n)||0} real sourced market events stored`],
      ["live_shadow","Live-shadow proof",Number(lab.production?.liveMetrics?.samples)>=2000,
        Math.min(1,(Number(lab.production?.liveMetrics?.samples)||0)/2000),
        `${Number(lab.production?.liveMetrics?.samples)||0} future production outcomes scored`],
      ["paper_execution","Execution realism",Number(paper.closedOutcomes)>=200,
        Math.min(1,(Number(paper.closedOutcomes)||0)/200),
        `${Number(paper.closedOutcomes)||0} closed paper outcomes · PF ${paper.profitFactor==null?"—":Number(paper.profitFactor).toFixed(2)}`],
      ["drift","Drift monitoring",!["CRITICAL","DEGRADED"].includes(drift?.status),drift?.status==="STABLE"?1:.5,
        `Drift status: ${drift?.status||"UNKNOWN"}`],
      ["readiness","Hard readiness gates",readiness.eligibleForManualReview,readiness.score,
        `${readiness.gates.filter(g=>g.passed).length}/${readiness.gates.length} gates currently pass`],
      ["real_money_lock","Real-money lock",false,0,
        readiness.eligibleForManualReview?"Manual review eligible; real money still locked":"Locked until every proof gate passes and you manually approve a tiny test"]
    ];

    for(let i=0;i<stages.length;i++){
      const [key,label,passed,progress,summary]=stages[i];
      await this.db.pool.query(`
        INSERT INTO proof_scoreboard(stage_key,stage_order,label,status,progress,summary,details,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,NOW())
        ON CONFLICT(stage_key) DO UPDATE SET
          stage_order=EXCLUDED.stage_order,label=EXCLUDED.label,status=EXCLUDED.status,
          progress=EXCLUDED.progress,summary=EXCLUDED.summary,details=EXCLUDED.details,updated_at=NOW()
      `,[
        key,i+1,label,passed?"PASS":key==="real_money_lock"?"LOCKED":"PROVING",
        clamp(Number(progress)||0,0,1),summary,JSON.stringify({passed})
      ]);
    }
  }

  async evaluate(){
    this.lastError=null;
    const drift=await this.evaluateDrift();
    const readiness=await this.evaluateReadiness(drift);
    await this.#updateScoreboard(readiness,drift);
    return {readiness,drift};
  }

  async scoreboard(){
    const q=await this.db.pool.query(`
      SELECT stage_key,stage_order,label,status,progress,summary,details,updated_at
      FROM proof_scoreboard
      ORDER BY stage_order
    `);
    return q.rows;
  }

  #capture(err){
    this.lastError=String(err?.message||err);
    console.log(JSON.stringify({event:"governance_error",message:this.lastError}));
  }
}

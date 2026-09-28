const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0;
const stdev=a=>{
  if(a.length<2) return 0;
  const m=mean(a);
  return Math.sqrt(a.reduce((s,x)=>s+(x-m)**2,0)/(a.length-1));
};
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));

function classIndex(name){return name==="UP"?0:name==="DOWN"?2:1;}
function metrics(rows){
  if(!rows.length) return {samples:0,accuracy:0,brier:1,ece:1};
  let correct=0,brier=0;
  const buckets=Array.from({length:10},()=>({n:0,c:0,ok:0}));
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
    const b=Math.min(9,Math.floor(conf*10));
    buckets[b].n++;buckets[b].c+=conf;if(pi===yi)buckets[b].ok++;
  }
  let ece=0;
  for(const b of buckets){
    if(!b.n) continue;
    ece+=(b.n/rows.length)*Math.abs(b.c/b.n-b.ok/b.n);
  }
  return {samples:rows.length,accuracy:correct/rows.length,brier:brier/rows.length,ece};
}

export class DriftMonitor {
  constructor({db,modelLab,paperBroker,marketIntegrity}){
    this.db=db;
    this.modelLab=modelLab;
    this.paperBroker=paperBroker;
    this.marketIntegrity=marketIntegrity;
    this.timer=null;
    this.latest=null;
  }

  async init(){
    await this.measure().catch(()=>{});
    this.timer=setInterval(()=>this.measure().catch(()=>{}),5*60*1000);
  }

  stop(){clearInterval(this.timer);}

  status(){
    return this.latest||{
      status:"UNKNOWN",score:0,reasons:["No drift measurement yet."],measuredAt:null
    };
  }

  async measure(){
    const production=this.modelLab?.productionRecord;
    if(!production?.model_id){
      this.latest={status:"NO_MODEL",score:1,reasons:["No production model."],measuredAt:new Date().toISOString()};
      return this.latest;
    }
    const modelId=production.model_id;
    const recentQ=await this.db.pool.query(`
      SELECT p_up,p_flat,p_down,actual_direction,features,created_at
      FROM predictions
      WHERE model_id=$1 AND status='SCORED'
      ORDER BY created_at DESC LIMIT 250
    `,[modelId]);
    const baselineQ=await this.db.pool.query(`
      SELECT p_up,p_flat,p_down,actual_direction,features,created_at
      FROM predictions
      WHERE model_id=$1 AND status='SCORED'
      ORDER BY created_at DESC OFFSET 250 LIMIT 1000
    `,[modelId]);
    const recent=metrics(recentQ.rows);
    const historicalTest=production.test_metrics||{};
    const baseline=baselineQ.rowCount?metrics(baselineQ.rows):{
      samples:Number(historicalTest.samples)||0,
      accuracy:Number(historicalTest.accuracy)||0,
      brier:Number(historicalTest.brier)||.22,
      ece:Number(historicalTest.ece)||.08
    };

    const recentFeatures=recentQ.rows.map(r=>r.features||{});
    const baselineFeatures=baselineQ.rows.map(r=>r.features||{});
    const keys=[...new Set(recentFeatures.flatMap(x=>Object.keys(x).filter(k=>typeof x[k]==="number")))].slice(0,48);
    const driftFeatures={};
    let maxZ=0;
    if(baselineFeatures.length>=50){
      for(const key of keys){
        const a=recentFeatures.map(x=>Number(x[key])).filter(Number.isFinite);
        const b=baselineFeatures.map(x=>Number(x[key])).filter(Number.isFinite);
        if(a.length<20||b.length<30) continue;
        const sd=Math.max(.05,stdev(b));
        const z=Math.abs(mean(a)-mean(b))/sd;
        driftFeatures[key]=z;
        maxZ=Math.max(maxZ,z);
      }
    }

    const quality=await this.db.pool.query(`
      SELECT COUNT(*)::int AS open_count,
             COUNT(*) FILTER (WHERE severity IN ('HIGH','CRITICAL'))::int AS severe_count
      FROM data_quality_incidents WHERE status='OPEN'
    `);
    const severe=Number(quality.rows[0]?.severe_count)||0;
    const reasons=[];
    let score=0;

    if(recent.samples>=80){
      const brierRatio=recent.brier/Math.max(.05,Number(baseline.brier)||.22);
      const eceDelta=recent.ece-(Number(baseline.ece)||0);
      const accDelta=(Number(baseline.accuracy)||0)-recent.accuracy;
      if(brierRatio>1.12){score+=.35;reasons.push(`Recent Brier worsened ${((brierRatio-1)*100).toFixed(0)}% versus baseline.`);}
      if(eceDelta>.035){score+=.22;reasons.push("Recent calibration error increased materially.");}
      if(accDelta>.06){score+=.18;reasons.push("Recent directional accuracy fell materially below baseline.");}
    }else{
      reasons.push(`Only ${recent.samples} scored live samples in the drift window.`);
    }
    if(maxZ>1.5){score+=Math.min(.25,(maxZ-1.5)*.12);reasons.push(`Feature-distribution shift detected (max z ${maxZ.toFixed(2)}).`);}
    if(severe){score+=.35;reasons.push(`${severe} severe open data-quality incident(s).`);}

    score=clamp(score,0,1);
    const status=score>=.65?"HALT":score>=.35?"DEGRADED":score>=.18?"WATCH":"STABLE";
    if(status==="HALT"){
      await this.paperBroker?.setAutopilot(false).catch(()=>{});
    }
    const measuredAt=new Date().toISOString();
    this.latest={
      modelId,status,score,reasons,measuredAt,
      recent,baseline,featureDrift:driftFeatures,
      severeDataIncidents:severe
    };
    await this.db.pool.query(`
      INSERT INTO model_drift_snapshots(
        model_id,measured_at,window_samples,recent_accuracy,recent_brier,recent_ece,
        baseline_accuracy,baseline_brier,baseline_ece,feature_drift,score,status,reasons
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13::jsonb)
    `,[
      modelId,measuredAt,recent.samples,recent.accuracy,recent.brier,recent.ece,
      baseline.accuracy,baseline.brier,baseline.ece,JSON.stringify(driftFeatures),
      score,status,JSON.stringify(reasons)
    ]);
    console.log(JSON.stringify({event:"model_drift_measurement",modelId,status,score,samples:recent.samples}));
    return this.latest;
  }
}

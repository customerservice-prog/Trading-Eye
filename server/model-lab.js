import crypto from "node:crypto";
import { FeatureFactory, MODEL_FEATURES } from "./feature-factory.js";
import {
  CLASS_NAMES,SoftmaxModel,GaussianNBModel,EnsembleModel,
  metricsFor,chooseTemperature,buildEnsembleWeight,splitChronologically
} from "./ml-models.js";

const sleepTick=()=>new Promise(r=>setImmediate(r));

function etParts(date=new Date()){
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-US",{
      timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit",
      weekday:"short",hour:"2-digit",minute:"2-digit",hourCycle:"h23"
    }).formatToParts(date).filter(x=>x.type!=="literal").map(x=>[x.type,x.value])
  );
}
function etDate(date=new Date()){
  const p=etParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}
function modelFromRegistryArtifact(a){
  if(!a) return null;
  if(a.kind==="ensemble") return EnsembleModel.fromArtifact(a);
  if(a.kind==="softmax") return SoftmaxModel.fromArtifact(a);
  if(a.kind==="gaussian_nb") return GaussianNBModel.fromArtifact(a);
  return null;
}
function directionFromProbs(p){
  const i=p.indexOf(Math.max(...p));
  return CLASS_NAMES[i]||"FLAT";
}
function edgeFromProbs(p){
  const s=[...p].sort((a,b)=>b-a);
  return (s[0]||0)-(s[1]||0);
}

export class ModelLab {
  constructor({db,marketEngine,horizonMinutes=15,enabled=true}){
    this.db=db;
    this.marketEngine=marketEngine;
    this.horizonMinutes=horizonMinutes;
    this.enabled=enabled;
    this.factory=new FeatureFactory();
    this.productionRecord=null;
    this.productionModel=null;
    this.latestRun=null;
    this.training=false;
    this.lastError=null;
    this.timer=null;
  }

  async init(){
    await this.loadProduction();
    this.latestRun=await this.#loadLatestRun();
    this.timer=setInterval(()=>this.tick().catch(err=>this.#capture(err)),5*60*1000);
    setTimeout(()=>this.tick().catch(err=>this.#capture(err)),12000);
  }

  stop(){ clearInterval(this.timer); }

  async loadProduction(){
    const q=await this.db.pool.query(`
      SELECT * FROM model_registry
      WHERE horizon_minutes=$1 AND status='PRODUCTION'
      ORDER BY promoted_at DESC NULLS LAST,trained_at DESC
      LIMIT 1
    `,[this.horizonMinutes]);
    this.productionRecord=q.rows[0]||null;
    this.productionModel=this.productionRecord
      ? modelFromRegistryArtifact(this.productionRecord.artifact)
      : null;
  }

  async #loadLatestRun(){
    const q=await this.db.pool.query(`
      SELECT * FROM model_lab_runs
      WHERE horizon_minutes=$1
      ORDER BY started_at DESC LIMIT 1
    `,[this.horizonMinutes]);
    return q.rows[0]||null;
  }

  status(){
    const p=this.productionRecord;
    return {
      enabled:this.enabled,
      training:this.training,
      lastError:this.lastError,
      production:p?{
        modelId:p.model_id,
        family:p.family,
        trainedAt:p.trained_at,
        promotedAt:p.promoted_at,
        validationMetrics:p.validation_metrics,
        testMetrics:p.test_metrics,
        shadowMetrics:p.shadow_metrics,
        dataset:p.dataset,
        calibration:p.calibration
      }:null,
      latestRun:this.latestRun?{
        runId:this.latestRun.run_id,
        status:this.latestRun.status,
        startedAt:this.latestRun.started_at,
        completedAt:this.latestRun.completed_at,
        winnerModelId:this.latestRun.winner_model_id,
        promotionReason:this.latestRun.promotion_reason,
        dataset:this.latestRun.dataset,
        candidates:this.latestRun.candidates,
        error:this.latestRun.error
      }:null
    };
  }

  currentFeatures(symbol){
    const rows=this.marketEngine.histories.get(String(symbol).toUpperCase())||[];
    if(rows.length<50) return null;
    return this.factory.extract(rows,rows.length-1);
  }

  predict(symbol){
    if(!this.productionModel||!this.productionRecord) return null;
    const features=this.currentFeatures(symbol);
    if(!features) return null;
    const x=this.factory.vector(features);
    const probs=this.productionModel.predict(x);
    const direction=directionFromProbs(probs);
    const confidence=Math.max(...probs);
    const edge=edgeFromProbs(probs);
    return {
      direction,
      confidence,
      edge,
      pUp:probs[0],
      pFlat:probs[1],
      pDown:probs[2],
      noTrade:confidence<.46||edge<.055,
      modelId:this.productionRecord.model_id,
      modelVersion:Math.floor(new Date(this.productionRecord.trained_at).getTime()/1000),
      family:this.productionRecord.family,
      features,
      featureVector:x,
      metrics:{
        test:this.productionRecord.test_metrics,
        shadow:this.productionRecord.shadow_metrics
      }
    };
  }

  async tick(){
    if(!this.enabled||this.training) return;
    if(this.marketEngine.backfill.state!=="COMPLETE") return;
    const now=etParts();
    const minute=Number(now.hour)*60+Number(now.minute);
    const weekday=!["Sat","Sun"].includes(now.weekday);
    const today=`${now.year}-${now.month}-${now.day}`;

    if(!this.productionRecord){
      await this.trainNow("bootstrap_no_production");
      return;
    }
    const runDate=this.latestRun?.started_at?etDate(new Date(this.latestRun.started_at)):null;
    if(weekday&&minute>=21*60+30&&runDate!==today){
      await this.trainNow("nightly_research");
    }
  }

  #candidateSpecs(){
    const idx=name=>MODEL_FEATURES.indexOf(name);
    const momentum=[
      "ret1","ret3","ret5","ret10","ret20","momAccel",
      "volRel5","volRel20","volAccel","trendSlope10","trendSlope30",
      "timeSin","timeCos"
    ].map(idx).filter(i=>i>=0);
    const reversion=[
      "ret1","ret3","rv5","rv20","vwapDist","ma5Dist","ma20Dist","maCross",
      "high20Dist","low20Dist","rangeCompression","upperWick","lowerWick",
      "closeLocation","timeSin","timeCos"
    ].map(idx).filter(i=>i>=0);

    return [
      {name:"softmax_full",build:()=>new SoftmaxModel({featureCount:MODEL_FEATURES.length,name:"softmax_full"})},
      {name:"softmax_momentum",build:()=>new SoftmaxModel({featureCount:MODEL_FEATURES.length,featureIndices:momentum,name:"softmax_momentum"})},
      {name:"softmax_reversion",build:()=>new SoftmaxModel({featureCount:MODEL_FEATURES.length,featureIndices:reversion,name:"softmax_reversion"})},
      {name:"gaussian_full",build:()=>new GaussianNBModel({featureCount:MODEL_FEATURES.length,name:"gaussian_full"})}
    ];
  }

  async trainNow(reason="manual"){
    if(this.training) return null;
    this.training=true;
    this.lastError=null;
    const runId="LAB-"+crypto.randomUUID();
    const startedAt=new Date();

    await this.db.pool.query(`
      INSERT INTO model_lab_runs(run_id,horizon_minutes,status,started_at,dataset,candidates)
      VALUES($1,$2,'RUNNING',NOW(),'{}'::jsonb,'[]'::jsonb)
    `,[runId,this.horizonMinutes]);

    try{
      const usableSymbols=[...this.marketEngine.histories.entries()]
        .filter(([,rows])=>rows.length>=1500)
        .map(([symbol])=>symbol);
      const dataset=this.factory.buildDataset(this.marketEngine.histories,{
        symbols:usableSymbols,horizon:this.horizonMinutes,step:5,maxSamples:160000
      });
      if(dataset.length<3000) throw new Error(`Model Lab needs at least 3000 chronological examples; found ${dataset.length}`);

      const splits=splitChronologically(dataset);
      const datasetSummary={
        reason,
        symbols:usableSymbols,
        total:dataset.length,
        train:splits.train.length,
        validation:splits.validation.length,
        test:splits.test.length,
        shadow:splits.shadow.length,
        start:new Date(dataset[0].ts).toISOString(),
        end:new Date(dataset.at(-1).ts).toISOString(),
        features:MODEL_FEATURES
      };

      const candidates=[];
      for(const spec of this.#candidateSpecs()){
        const model=spec.build();
        if(model.kind==="softmax"){
          model.train(splits.train,{epochs:4,learningRate:.022,l2:.001,maxSamples:70000});
        }else{
          model.train(splits.train,{maxSamples:120000});
        }
        const calibrated=chooseTemperature(model,splits.validation);
        const test=metricsFor(model,splits.test,{temperature:calibrated.temperature});
        const shadow=metricsFor(model,splits.shadow,{temperature:calibrated.temperature});
        candidates.push({
          name:spec.name,
          model,
          temperature:calibrated.temperature,
          validation:calibrated.metrics,
          test,
          shadow
        });
        await sleepTick();
      }

      const members=[...candidates]
        .sort((a,b)=>a.validation.brier-b.validation.brier)
        .slice(0,3);
      const weights=members.map(x=>buildEnsembleWeight(x.validation));
      const ensemble=new EnsembleModel({
        members:members.map(x=>({name:x.name,model:x.model,temperature:x.temperature})),
        weights,
        temperature:1,
        name:"meta_ensemble"
      });
      const ensembleCalibration=chooseTemperature(ensemble,splits.validation);
      ensemble.temperature=ensembleCalibration.temperature;
      const ensembleTest=metricsFor(ensemble,splits.test);
      const ensembleShadow=metricsFor(ensemble,splits.shadow);
      candidates.push({
        name:"meta_ensemble",
        model:ensemble,
        temperature:ensemble.temperature,
        validation:ensembleCalibration.metrics,
        test:ensembleTest,
        shadow:ensembleShadow
      });

      const candidateSummaries=[];
      for(const c of candidates){
        const modelId=`TE-${this.horizonMinutes}M-${startedAt.toISOString().replace(/[-:.TZ]/g,"").slice(0,14)}-${c.name}`;
        c.modelId=modelId;
        candidateSummaries.push({
          modelId,
          family:c.name,
          calibration:{temperature:c.temperature},
          validation:c.validation,
          test:c.test,
          shadow:c.shadow
        });
        await this.db.pool.query(`
          INSERT INTO model_registry(
            model_id,family,horizon_minutes,status,trained_at,train_start,train_end,
            feature_names,artifact,calibration,validation_metrics,test_metrics,shadow_metrics,dataset,notes
          ) VALUES($1,$2,$3,'CHALLENGER',NOW(),$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13)
          ON CONFLICT(model_id) DO NOTHING
        `,[
          modelId,c.name,this.horizonMinutes,
          new Date(dataset[0].ts),new Date(dataset.at(-1).ts),
          JSON.stringify(MODEL_FEATURES),
          JSON.stringify(c.model.artifact()),
          JSON.stringify({temperature:c.temperature}),
          JSON.stringify(c.validation),JSON.stringify(c.test),JSON.stringify(c.shadow),
          JSON.stringify(datasetSummary),reason
        ]);
      }

      const winner=[...candidates].sort((a,b)=>{
        const sa=a.shadow.brier+a.test.brier*.65+a.shadow.ece*.20-a.shadow.accuracy*.04;
        const sb=b.shadow.brier+b.test.brier*.65+b.shadow.ece*.20-b.shadow.accuracy*.04;
        return sa-sb;
      })[0];

      let promote=false;
      let promotionReason="";
      if(!this.productionRecord){
        promote=winner.shadow.samples>=500;
        promotionReason=promote
          ?"First production model: selected from unseen test + live-shadow holdout metrics."
          :"Not enough shadow samples for first production promotion.";
      }else{
        const incumbent=modelFromRegistryArtifact(this.productionRecord.artifact);
        const incTest=incumbent?metricsFor(incumbent,splits.test):null;
        const incShadow=incumbent?metricsFor(incumbent,splits.shadow):null;
        if(incTest&&incShadow){
          const brierBetter=winner.shadow.brier<=incShadow.brier*.985;
          const testSafe=winner.test.brier<=incTest.brier*1.005;
          const accuracySafe=winner.shadow.accuracy>=incShadow.accuracy-.01;
          const calibrated=winner.shadow.ece<=incShadow.ece+.02;
          promote=winner.shadow.samples>=500&&brierBetter&&testSafe&&accuracySafe&&calibrated;
          promotionReason=promote
            ?`Promoted: shadow Brier ${winner.shadow.brier.toFixed(4)} vs incumbent ${incShadow.brier.toFixed(4)}, with test/accuracy/calibration guards passed.`
            :`Rejected promotion: challenger did not beat incumbent under Brier/test/accuracy/calibration guards.`;
        }else{
          promotionReason="Incumbent artifact could not be evaluated safely; production unchanged.";
        }
      }

      if(promote){
        await this.db.pool.query("BEGIN");
        try{
          await this.db.pool.query(`
            UPDATE model_registry SET status='RETIRED'
            WHERE horizon_minutes=$1 AND status='PRODUCTION'
          `,[this.horizonMinutes]);
          await this.db.pool.query(`
            UPDATE model_registry
            SET status='PRODUCTION',promoted_at=NOW()
            WHERE model_id=$1
          `,[winner.modelId]);
          await this.db.pool.query("COMMIT");
        }catch(err){
          await this.db.pool.query("ROLLBACK");
          throw err;
        }
      }

      await this.db.pool.query(`
        UPDATE model_lab_runs SET
          status='COMPLETE',completed_at=NOW(),dataset=$2::jsonb,candidates=$3::jsonb,
          winner_model_id=$4,promotion_reason=$5,error=NULL
        WHERE run_id=$1
      `,[
        runId,JSON.stringify(datasetSummary),JSON.stringify(candidateSummaries),
        winner.modelId,promotionReason
      ]);

      this.latestRun=await this.#loadLatestRun();
      if(promote) await this.loadProduction();
      console.log(JSON.stringify({
        event:"model_lab_complete",
        runId,
        examples:dataset.length,
        symbols:usableSymbols.length,
        winner:winner.modelId,
        promoted:promote,
        shadowBrier:winner.shadow.brier,
        shadowAccuracy:winner.shadow.accuracy,
        shadowEce:winner.shadow.ece
      }));
      return {runId,winner:winner.modelId,promoted:promote,promotionReason};
    }catch(err){
      this.lastError=String(err?.message||err);
      await this.db.pool.query(`
        UPDATE model_lab_runs
        SET status='ERROR',completed_at=NOW(),error=$2
        WHERE run_id=$1
      `,[runId,this.lastError]);
      console.log(JSON.stringify({event:"model_lab_error",runId,message:this.lastError}));
      throw err;
    }finally{
      this.training=false;
      this.latestRun=await this.#loadLatestRun();
    }
  }

  #capture(err){
    this.lastError=String(err?.message||err);
    console.log(JSON.stringify({event:"model_lab_scheduler_error",message:this.lastError}));
  }
}

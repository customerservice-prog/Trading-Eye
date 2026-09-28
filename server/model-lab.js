import crypto from "node:crypto";
import { FeatureFactory, MODEL_FEATURES } from "./feature-factory.js";
import {
  CLASS_NAMES,SoftmaxModel,GaussianNBModel,BoostedStumpModel,BaggedBoostedModel,EnsembleModel,
  metricsFor,chooseTemperature,buildEnsembleWeight,splitChronologically,applyTemperature
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
  if(a.kind==="boosted_stumps") return BoostedStumpModel.fromArtifact(a);
  if(a.kind==="bagged_boosted") return BaggedBoostedModel.fromArtifact(a);
  return null;
}
function directionFromProbs(p){
  const i=p.indexOf(Math.max(...p));
  return CLASS_NAMES[i]||"FLAT";
}
function localContributions(model,x,classIdx){
  const out=new Map();
  const add=(idx,value)=>{
    if(!Number.isFinite(value)) return;
    out.set(idx,(out.get(idx)||0)+value);
  };

  const visit=(m,scale=1)=>{
    if(!m) return;
    if(m.kind==="ensemble"){
      const total=(m.weights||[]).reduce((s,w)=>s+Math.max(0,Number(w)||0),0)||1;
      (m.members||[]).forEach((member,i)=>{
        const w=Math.max(0,Number(m.weights?.[i])||0)/total;
        visit(member.model,scale*w);
      });
      return;
    }
    if(m.kind==="softmax"){
      const indices=m.featureIndices||[];
      const weights=m.weights?.[classIdx]||[];
      indices.forEach((featureIdx,j)=>{
        add(featureIdx,scale*(Number(weights[j])||0)*(Number(x[featureIdx])||0));
      });
      return;
    }
    if(m.kind==="bagged_boosted"){
      const members=m.members||[];
      for(const member of members){
        const indices=member.featureIndices||[];
        const artifact=member.artifact||{};
        for(const stump of artifact.stumps||[]){
          const localIdx=Number(stump.featureIndex);
          const globalIdx=indices[localIdx];
          if(globalIdx==null) continue;
          const localValue=Number(x[globalIdx])||0;
          const delta=localValue<=Number(stump.threshold)
            ? stump.leftValue
            : stump.rightValue;
          const own=Number(delta?.[classIdx])||0;
          const others=(delta||[]).filter((_,i)=>i!==classIdx).map(Number);
          const baseline=others.length?others.reduce((a,b)=>a+b,0)/others.length:0;
          add(globalIdx,scale*(own-baseline)/Math.max(1,members.length));
        }
      }
      return;
    }
    if(m.kind==="boosted_stumps"){
      for(const stump of m.stumps||[]){
        const featureIdx=Number(stump.featureIndex);
        const delta=(Number(x[featureIdx])||0)<=Number(stump.threshold)
          ? stump.leftValue
          : stump.rightValue;
        const own=Number(delta?.[classIdx])||0;
        const others=(delta||[]).filter((_,i)=>i!==classIdx).map(Number);
        const baseline=others.length?others.reduce((a,b)=>a+b,0)/others.length:0;
        add(featureIdx,scale*(own-baseline));
      }
      return;
    }
    if(m.kind==="gaussian_nb"){
      const indices=m.featureIndices||[];
      indices.forEach((featureIdx,j)=>{
        const v=Number(x[featureIdx])||0;
        const ownMean=Number(m.means?.[classIdx]?.[j])||0;
        const ownVar=Math.max(.02,Number(m.vars?.[classIdx]?.[j])||1);
        const own=-.5*Math.log(ownVar)-.5*((v-ownMean)**2)/ownVar;
        const others=[];
        for(let c=0;c<CLASS_NAMES.length;c++){
          if(c===classIdx) continue;
          const mean=Number(m.means?.[c]?.[j])||0;
          const variance=Math.max(.02,Number(m.vars?.[c]?.[j])||1);
          others.push(-.5*Math.log(variance)-.5*((v-mean)**2)/variance);
        }
        const baseline=others.length?others.reduce((a,b)=>a+b,0)/others.length:0;
        add(featureIdx,scale*(own-baseline));
      });
    }
  };

  visit(model,1);
  return [...out.entries()]
    .map(([idx,contribution])=>({
      key:MODEL_FEATURES[idx]||("feature_"+idx),
      value:Number(x[idx])||0,
      contribution,
      source:"ml"
    }))
    .sort((a,b)=>Math.abs(b.contribution)-Math.abs(a.contribution))
    .slice(0,8);
}

function edgeFromProbs(p){
  const s=[...p].sort((a,b)=>b-a);
  return (s[0]||0)-(s[1]||0);
}
function classIndex(name){
  return name==="UP"?0:name==="DOWN"?2:1;
}
function liveMetrics(rows){
  if(!rows.length) return {samples:0,accuracy:0,brier:1,logLoss:10,ece:1};
  let correct=0,brier=0,logLoss=0;
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
    logLoss+=-Math.log(Math.max(1e-9,p[yi]));
    const conf=Math.max(...p);
    const b=Math.min(9,Math.floor(conf*10));
    buckets[b].n++;buckets[b].conf+=conf;if(pi===yi)buckets[b].correct++;
  }
  let ece=0;
  for(const b of buckets){
    if(!b.n) continue;
    const avg=b.conf/b.n,acc=b.correct/b.n;
    ece+=(b.n/rows.length)*Math.abs(avg-acc);
  }
  return {
    samples:rows.length,
    accuracy:correct/rows.length,
    brier:brier/rows.length,
    logLoss:logLoss/rows.length,
    ece
  };
}

function shadowTimeBucket(ts){
  const parts=Object.fromEntries(
    new Intl.DateTimeFormat("en-US",{
      timeZone:"America/New_York",hour:"2-digit",minute:"2-digit",hourCycle:"h23"
    }).formatToParts(new Date(ts)).filter(x=>x.type!=="literal").map(x=>[x.type,x.value])
  );
  const m=Number(parts.hour)*60+Number(parts.minute);
  if(m<9*60+30) return "PREMARKET";
  if(m<10*60+30) return "OPENING_HOUR";
  if(m<14*60) return "MIDDAY";
  if(m<15*60) return "AFTERNOON";
  if(m<16*60) return "POWER_HOUR";
  return "AFTER_HOURS";
}
function confidenceBucket(conf){
  const c=Number(conf)||0;
  if(c>=.70) return "70_PLUS";
  if(c>=.60) return "60_69";
  if(c>=.50) return "50_59";
  return "UNDER_50";
}
function sliceMetrics(rows,key){
  const groups={};
  for(const row of rows){
    const k=String(row[key]||"UNKNOWN");
    (groups[k]||(groups[k]=[])).push(row);
  }
  const out={};
  for(const [k,list] of Object.entries(groups)) out[k]=liveMetrics(list);
  return out;
}

export class ModelLab {
  constructor({db,marketEngine,horizonMinutes=15,enabled=true,forceTrainOnStart=false}){
    this.db=db;
    this.marketEngine=marketEngine;
    this.horizonMinutes=horizonMinutes;
    this.enabled=enabled;
    this.forceTrainOnStart=Boolean(forceTrainOnStart);
    this.factory=new FeatureFactory();
    this.productionRecord=null;
    this.productionModel=null;
    this.latestRun=null;
    this.shadowModels=[];
    this.liveShadowMetrics={};
    this.productionLiveMetrics={samples:0,accuracy:0,brier:1,logLoss:10,ece:1};
    this.shadowMinSamples=1000;
    this.cachedRegime={value:"UNKNOWN",at:0};
    this.shadowScoreCounter=0;
    this.training=false;
    this.lastError=null;
    this.timer=null;
  }

  async init(){
    await this.loadProduction();
    await this.loadShadowModels();
    await this.refreshLiveShadowMetrics();
    this.latestRun=await this.#loadLatestRun();
    this.timer=setInterval(()=>this.tick().catch(err=>this.#capture(err)),5*60*1000);
    setTimeout(()=>{
      if(this.forceTrainOnStart) this.trainNow("forced_preview_validation").catch(err=>this.#capture(err));
      else this.tick().catch(err=>this.#capture(err));
    },12000);
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
    this.productionTemperature=Number(this.productionRecord?.calibration?.temperature)||1;
  }

  async loadShadowModels(){
    const q=await this.db.pool.query(`
      SELECT * FROM model_registry
      WHERE horizon_minutes=$1 AND status='SHADOW'
      ORDER BY shadow_started_at DESC NULLS LAST,trained_at DESC
      LIMIT 4
    `,[this.horizonMinutes]);
    this.shadowModels=q.rows.map(row=>({
      record:row,
      model:modelFromRegistryArtifact(row.artifact),
      temperature:Number(row.calibration?.temperature)||1
    })).filter(x=>x.model);
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
        walkForwardMetrics:p.walk_forward_metrics,
        shadowMetrics:p.shadow_metrics,
        liveMetrics:this.productionLiveMetrics,
        liveShadowMetrics:p.live_shadow_metrics,
        dataset:p.dataset,
        calibration:p.calibration
      }:null,
      shadowModels:this.shadowModels.map(x=>({
        modelId:x.record.model_id,
        family:x.record.family,
        shadowStartedAt:x.record.shadow_started_at,
        liveMetrics:this.liveShadowMetrics[x.record.model_id]||x.record.live_shadow_metrics||{},
        testMetrics:x.record.test_metrics,
        historicalShadowMetrics:x.record.shadow_metrics
      })),
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

  async #currentRegime(){
    if(Date.now()-this.cachedRegime.at<60000) return this.cachedRegime.value;
    const row=await this.db.latestMarketRegime().catch(()=>null);
    this.cachedRegime={
      value:String(row?.regime||"UNKNOWN"),
      at:Date.now()
    };
    return this.cachedRegime.value;
  }

  currentFeatures(symbol){
    const rows=this.marketEngine.histories.get(String(symbol).toUpperCase())||[];
    if(rows.length<50) return null;
    const last=rows.at(-1);
    const context=this.factory.contextAt(this.marketEngine.histories,last?.ts||Date.now(),String(symbol).toUpperCase());
    return this.factory.extract(rows,rows.length-1,context);
  }

  predict(symbol){
    if(!this.productionModel||!this.productionRecord) return null;
    const features=this.currentFeatures(symbol);
    if(!features) return null;
    const x=this.factory.vector(features);
    const probs=applyTemperature(this.productionModel.predict(x),this.productionTemperature);
    const direction=directionFromProbs(probs);
    const confidence=Math.max(...probs);
    const edge=edgeFromProbs(probs);
    const classIdx=classIndex(direction);
    const contributions=localContributions(this.productionModel,x,classIdx);
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
      contributions,
      metrics:{
        test:this.productionRecord.test_metrics,
        walkForward:this.productionRecord.walk_forward_metrics,
        shadow:this.productionRecord.shadow_metrics,
        live:this.productionLiveMetrics
      }
    };
  }

  async shadowPredict(symbol,bar){
    if(!this.shadowModels.length||!bar) return;
    const features=this.currentFeatures(symbol);
    if(!features) return;
    const x=this.factory.vector(features);
    const createdAt=new Date(bar.ts);
    const targetAt=new Date(createdAt.getTime()+this.horizonMinutes*60*1000);
    const regime=await this.#currentRegime();
    const timeBucket=shadowTimeBucket(createdAt);

    for(const item of this.shadowModels){
      const raw=item.model.predict(x);
      const p=applyTemperature(raw,item.temperature);
      const direction=directionFromProbs(p);
      const confidence=Math.max(...p);
      await this.db.pool.query(`
        INSERT INTO model_shadow_predictions(
          model_id,symbol,created_at,target_at,reference_price,direction,confidence,
          p_up,p_flat,p_down,status,regime,time_bucket,confidence_bucket,model_details
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'PENDING',$11,$12,$13,$14::jsonb)
        ON CONFLICT(model_id,symbol,created_at) DO NOTHING
      `,[
        item.record.model_id,String(symbol).toUpperCase(),createdAt,targetAt,Number(bar.close),
        direction,confidence,p[0],p[1],p[2],regime,timeBucket,confidenceBucket(confidence),
        JSON.stringify({family:item.record.family,horizonMinutes:this.horizonMinutes})
      ]);
    }
  }

  async scoreShadowDue(bar){
    if(!bar?.symbol||!this.shadowModels.length) return;
    const q=await this.db.pool.query(`
      SELECT * FROM model_shadow_predictions
      WHERE symbol=$1 AND status='PENDING' AND target_at <= $2
      ORDER BY target_at
    `,[bar.symbol,bar.ts]);
    if(!q.rowCount) return;

    for(const row of q.rows){
      const ret=(Number(bar.close)-Number(row.reference_price))/Number(row.reference_price);
      const actual=ret>.001?"UP":ret<-.001?"DOWN":"FLAT";
      const correct=row.direction===actual;
      await this.db.pool.query(`
        UPDATE model_shadow_predictions SET
          status='SCORED',result_price=$4,result_return=$5,
          actual_direction=$6,correct=$7,scored_at=$8
        WHERE model_id=$1 AND symbol=$2 AND created_at=$3
      `,[
        row.model_id,row.symbol,row.created_at,Number(bar.close),ret,actual,correct,bar.ts
      ]);
    }
    this.shadowScoreCounter+=q.rowCount;
    if(this.shadowScoreCounter>=20){
      this.shadowScoreCounter=0;
      await this.refreshLiveShadowMetrics();
      await this.evaluateShadowPromotion();
    }
  }

  async refreshLiveShadowMetrics(){
    if(this.productionRecord?.model_id){
      const prod=await this.db.pool.query(`
        SELECT p_up,p_flat,p_down,actual_direction
        FROM predictions
        WHERE model_id=$1 AND status='SCORED'
        ORDER BY created_at
      `,[this.productionRecord.model_id]);
      this.productionLiveMetrics=liveMetrics(prod.rows);
    }else{
      this.productionLiveMetrics={samples:0,accuracy:0,brier:1,logLoss:10,ece:1};
    }

    const map={};
    for(const item of this.shadowModels){
      const q=await this.db.pool.query(`
        SELECT p_up,p_flat,p_down,actual_direction,symbol,created_at,confidence,
               regime,time_bucket,confidence_bucket
        FROM model_shadow_predictions
        WHERE model_id=$1 AND status='SCORED'
        ORDER BY created_at
      `,[item.record.model_id]);
      const metrics={
        ...liveMetrics(q.rows),
        byRegime:sliceMetrics(q.rows,"regime"),
        byTimeBucket:sliceMetrics(q.rows,"time_bucket"),
        byConfidence:sliceMetrics(q.rows,"confidence_bucket"),
        bySymbol:sliceMetrics(q.rows,"symbol")
      };
      map[item.record.model_id]=metrics;
      await this.db.pool.query(`
        UPDATE model_registry SET live_shadow_metrics=$2::jsonb
        WHERE model_id=$1
      `,[item.record.model_id,JSON.stringify(metrics)]);
      item.record.live_shadow_metrics=metrics;
    }
    this.liveShadowMetrics=map;
    return map;
  }

  async #pairedProductionMetrics(shadowModelId){
    if(!this.productionRecord?.model_id) return null;
    const q=await this.db.pool.query(`
      SELECT p.p_up,p.p_flat,p.p_down,p.actual_direction
      FROM model_shadow_predictions s
      JOIN predictions p
        ON p.symbol=s.symbol
       AND p.created_at=s.created_at
       AND p.status='SCORED'
       AND p.model_id=$2
      WHERE s.model_id=$1 AND s.status='SCORED'
      ORDER BY s.created_at
    `,[shadowModelId,this.productionRecord.model_id]);
    return liveMetrics(q.rows);
  }

  async evaluateShadowPromotion(){
    if(!this.productionRecord||!this.shadowModels.length) return null;
    for(const item of [...this.shadowModels]){
      const challenger=this.liveShadowMetrics[item.record.model_id]||item.record.live_shadow_metrics||{};
      if(Number(challenger.samples||0)<this.shadowMinSamples) continue;
      const incumbent=await this.#pairedProductionMetrics(item.record.model_id);
      if(!incumbent||incumbent.samples<Math.floor(this.shadowMinSamples*.8)) continue;

      const challengerTest=item.record.test_metrics||{};
      const incumbentTest=this.productionRecord.test_metrics||{};
      const liveBrierBetter=challenger.brier<=incumbent.brier*.985;
      const liveAccuracySafe=challenger.accuracy>=incumbent.accuracy-.005;
      const liveCalibrationSafe=challenger.ece<=incumbent.ece+.015;
      const historicalSafe=!incumbentTest.brier||challengerTest.brier<=Number(incumbentTest.brier)*1.01;
      const meaningfulSlices=[
        ...Object.values(challenger.byTimeBucket||{}),
        ...Object.values(challenger.byRegime||{})
      ].filter(x=>Number(x.samples||0)>=50);
      const sliceSafe=meaningfulSlices.length>=3 &&
        meaningfulSlices.every(x=>Number(x.brier||1)<=Math.max(.30,Number(challenger.brier||1)*1.25));
      const pass=liveBrierBetter&&liveAccuracySafe&&liveCalibrationSafe&&historicalSafe&&sliceSafe;

      if(pass){
        const reason=`Live-shadow promotion: challenger Brier ${challenger.brier.toFixed(4)} vs production ${incumbent.brier.toFixed(4)} across ${challenger.samples} paired real-time outcomes; calibration, accuracy, historical and slice-stability guards passed.`;
        const client=await this.db.pool.connect();
        try{
          await client.query("BEGIN");
          await client.query(`
            UPDATE model_registry SET status='RETIRED'
            WHERE horizon_minutes=$1 AND status='PRODUCTION'
          `,[this.horizonMinutes]);
          await client.query(`
            UPDATE model_registry SET
              status='PRODUCTION',promoted_at=NOW(),live_shadow_metrics=$2::jsonb,notes=COALESCE(notes,'')||$3
            WHERE model_id=$1
          `,[item.record.model_id,JSON.stringify(challenger),"\n"+reason]);
          await client.query(`
            UPDATE model_registry SET status='REJECTED'
            WHERE horizon_minutes=$1 AND status='SHADOW' AND model_id<>$2
          `,[this.horizonMinutes,item.record.model_id]);
          await client.query("COMMIT");
        }catch(err){
          await client.query("ROLLBACK");
          throw err;
        }finally{
          client.release();
        }
        await this.db.pool.query(`
          UPDATE model_lab_runs SET promotion_reason=$2
          WHERE winner_model_id=$1
        `,[item.record.model_id,reason]);
        console.log(JSON.stringify({
          event:"model_live_shadow_promoted",
          modelId:item.record.model_id,
          challenger,
          incumbent
        }));
        await this.loadProduction();
        await this.loadShadowModels();
        await this.refreshLiveShadowMetrics();
        return {promoted:item.record.model_id,reason};
      }

      if(Number(challenger.samples||0)>=1000 && challenger.brier>=incumbent.brier*.995){
        const reason=`Live shadow rejected after ${challenger.samples} outcomes: Brier ${challenger.brier.toFixed(4)} did not beat production ${incumbent.brier.toFixed(4)}.`;
        await this.db.pool.query(`
          UPDATE model_registry SET status='REJECTED',notes=COALESCE(notes,'')||$2
          WHERE model_id=$1
        `,[item.record.model_id,"\n"+reason]);
        console.log(JSON.stringify({event:"model_live_shadow_rejected",modelId:item.record.model_id,reason}));
        await this.loadShadowModels();
      }
    }
    return null;
  }

  async #ensureTrainingCoverage(){
    const existing=await this.db.listSymbolsWithMinuteHistory({minBars:4000,limit:80});
    const totalExisting=existing.reduce((s,x)=>s+Number(x.bars||0),0);
    if(existing.length>=12 && totalExisting>=60000){
      return {backfilled:false,symbols:existing.length,bars:totalExisting};
    }

    const provider=this.marketEngine.provider;
    if(!provider?.configured?.()){
      throw new Error(
        `Model Lab training coverage is insufficient (${existing.length} symbols / ${totalExisting} minute bars) and the research worker has no historical-data credentials.`
      );
    }

    const latest=await this.db.latestUniverseScan();
    const scanDate=latest?.scan_date?String(latest.scan_date).slice(0,10):null;
    const ranked=scanDate?await this.db.topUniverseCandidates(scanDate,{limit:28}):[];
    const wanted=[...new Set([
      "SPY","QQQ","DIA","IWM",
      "XLK","XLF","XLE","XLV","XLY","XLP","XLI","XLB","XLU","XLRE","XLC",
      "AAPL","MSFT","NVDA","AMZN","META","GOOGL","AMD","TSLA",
      ...ranked.map(x=>x.symbol)
    ])].slice(0,24);

    const counts=new Map(existing.map(x=>[x.symbol,Number(x.bars)||0]));
    const needs=wanted.filter(s=>(counts.get(s)||0)<4000);
    if(!needs.length){
      return {backfilled:false,symbols:existing.length,bars:totalExisting};
    }

    const end=new Date(Date.now()-20*60*1000);
    const start=new Date(end.getTime()-70*24*60*60*1000);
    let barsAdded=0;

    console.log(JSON.stringify({
      event:"model_lab_backfill_started",
      symbols:needs,
      start:start.toISOString(),
      end:end.toISOString()
    }));

    for(let offset=0;offset<needs.length;offset+=6){
      const chunk=needs.slice(offset,offset+6);
      await provider.historicalBarsForSymbols({
        symbols:chunk,start,end,timeframe:"1Min",limit:10000,
        onPage:async barsBySymbol=>{
          const batch=[];
          for(const [symbol,rows] of Object.entries(barsBySymbol||{})){
            for(const r of rows||[]){
              batch.push({
                provider:"alpaca",
                feed:provider.historicalFeed||"sip",
                symbol,
                ts:new Date(r.t),
                open:r.o,high:r.h,low:r.l,close:r.c,volume:r.v,
                tradeCount:r.n??null,vwap:r.vw??null,source:"ml_training_backfill"
              });
            }
          }
          for(let i=0;i<batch.length;i+=700){
            await this.db.upsertBarsBatch(batch.slice(i,i+700));
          }
          barsAdded+=batch.length;
        }
      });
      console.log(JSON.stringify({
        event:"model_lab_backfill_progress",
        completedSymbols:Math.min(offset+chunk.length,needs.length),
        totalSymbols:needs.length,
        barsAdded
      }));
      await sleepTick();
    }

    const refreshed=await this.db.listSymbolsWithMinuteHistory({minBars:4000,limit:80});
    const total=refreshed.reduce((s,x)=>s+Number(x.bars||0),0);
    console.log(JSON.stringify({
      event:"model_lab_backfill_complete",
      symbols:refreshed.length,
      bars:total,
      barsAdded
    }));
    return {backfilled:true,symbols:refreshed.length,bars:total,barsAdded};
  }

  async #trainingHistories(){
    const meta=await this.db.listSymbolsWithMinuteHistory({minBars:600,limit:64});
    const histories=new Map();
    for(const row of meta){
      const live=this.marketEngine.histories.get(row.symbol);
      if(live?.length>=600){
        histories.set(row.symbol,live);
        continue;
      }
      const bars=await this.db.getBars(row.symbol,{limit:26000});
      if(bars.length>=600) histories.set(row.symbol,bars);
      await sleepTick();
    }

    for(const symbol of ["SPY","QQQ"]){
      if(histories.has(symbol)) continue;
      const bars=await this.db.getBars(symbol,{limit:26000});
      if(bars.length>=1500) histories.set(symbol,bars);
    }
    return histories;
  }

  async tick(){
    if(!this.enabled||this.training) return;
    await this.refreshLiveShadowMetrics();
    if(this.shadowModels.length){
      await this.evaluateShadowPromotion();
    }
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
      "spyRet5","qqqRet5","breadth5","relativeSpy5","relativeQqq5",
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
      {name:"gaussian_full",build:()=>new GaussianNBModel({featureCount:MODEL_FEATURES.length,name:"gaussian_full"})},
      {name:"boosted_stumps",build:()=>new BoostedStumpModel({featureCount:MODEL_FEATURES.length,name:"boosted_stumps"})},
      {name:"bagged_boosted",build:()=>new BaggedBoostedModel({featureCount:MODEL_FEATURES.length,name:"bagged_boosted"})}
    ];
  }

  #specByName(name){
    return this.#candidateSpecs().find(x=>x.name===name)||null;
  }

  #fitBaseCandidate(name,train,validation){
    const spec=this.#specByName(name);
    if(!spec) return null;
    const model=spec.build();
    if(model.kind==="softmax"){
      model.train(train,{epochs:3,learningRate:.022,l2:.001,maxSamples:30000});
    }else if(model.kind==="boosted_stumps"){
      model.train(train,{rounds:14,learningRate:.20,maxSamples:12000});
    }else if(model.kind==="bagged_boosted"){
      model.train(train,{bags:5,rounds:12,learningRate:.18,maxSamples:10000});
    }else{
      model.train(train,{maxSamples:50000});
    }
    const calibrated=chooseTemperature(model,validation);
    return {name,model,temperature:calibrated.temperature};
  }

  #fitCandidateByName(name,train,validation,memberNames=[]){
    if(name!=="meta_ensemble") return this.#fitBaseCandidate(name,train,validation);

    const names=memberNames.length?memberNames:["softmax_full","softmax_momentum","gaussian_full"];
    const members=names.map(n=>this.#fitBaseCandidate(n,train,validation)).filter(Boolean);
    if(!members.length) return null;
    const weights=members.map(m=>{
      const metrics=metricsFor(m.model,validation,{temperature:m.temperature});
      return buildEnsembleWeight(metrics);
    });
    const ensemble=new EnsembleModel({
      members:members.map(m=>({name:m.name,model:m.model,temperature:m.temperature})),
      weights,
      temperature:1,
      name:"meta_ensemble"
    });
    const calibrated=chooseTemperature(ensemble,validation);
    ensemble.temperature=calibrated.temperature;
    return {name,model:ensemble,temperature:ensemble.temperature};
  }

  async #walkForward(name,dataset,memberNames=[]){
    const maxSamples=36000;
    const data=dataset.length>maxSamples
      ? Array.from({length:maxSamples},(_,i)=>dataset[Math.floor(i*(dataset.length/maxSamples))])
      : dataset;
    if(data.length<5000) return {folds:[],samples:0,accuracy:0,brier:1,logLoss:10,ece:1,accuracyStd:1};

    const fractions=[
      [.50,.62],
      [.62,.74],
      [.74,.86]
    ];
    const folds=[];
    for(let i=0;i<fractions.length;i++){
      const [trainEndFrac,testEndFrac]=fractions[i];
      const trainEnd=Math.floor(data.length*trainEndFrac);
      const testEnd=Math.floor(data.length*testEndFrac);
      const pre=data.slice(0,trainEnd);
      const calStart=Math.floor(pre.length*.84);
      const train=pre.slice(0,calStart);
      const validation=pre.slice(calStart);
      const test=data.slice(trainEnd,testEnd);
      if(train.length<1000||validation.length<200||test.length<200) continue;
      const fitted=this.#fitCandidateByName(name,train,validation,memberNames);
      if(!fitted) continue;
      const metrics=metricsFor(fitted.model,test,{temperature:fitted.temperature});
      folds.push({
        fold:i+1,
        trainStart:new Date(train[0].ts).toISOString(),
        trainEnd:new Date(train.at(-1).ts).toISOString(),
        testStart:new Date(test[0].ts).toISOString(),
        testEnd:new Date(test.at(-1).ts).toISOString(),
        ...metrics
      });
      await sleepTick();
    }
    const total=folds.reduce((s,x)=>s+x.samples,0)||1;
    const avg=key=>folds.reduce((s,x)=>s+Number(x[key]||0)*x.samples,0)/total;
    const accs=folds.map(x=>x.accuracy);
    const am=accs.length?accs.reduce((a,b)=>a+b,0)/accs.length:0;
    const accuracyStd=accs.length
      ?Math.sqrt(accs.reduce((s,x)=>s+(x-am)**2,0)/accs.length)
      :1;
    return {
      folds,
      samples:folds.reduce((s,x)=>s+x.samples,0),
      accuracy:avg("accuracy"),
      brier:avg("brier"),
      logLoss:avg("logLoss"),
      ece:avg("ece"),
      accuracyStd
    };
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
      const coverage=await this.#ensureTrainingCoverage();
      const trainingHistories=await this.#trainingHistories();
      const usableSymbols=[...trainingHistories.keys()];
      const dataset=this.factory.buildDataset(trainingHistories,{
        symbols:usableSymbols,horizon:this.horizonMinutes,step:5,maxSamples:160000
      });
      if(dataset.length<3000) throw new Error(`Model Lab needs at least 3000 chronological examples; found ${dataset.length}`);

      const splits=splitChronologically(dataset);
      const datasetSummary={
        reason,
        coverage,
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
        }else if(model.kind==="boosted_stumps"){
          model.train(splits.train,{rounds:18,learningRate:.20,maxSamples:14000});
        }else if(model.kind==="bagged_boosted"){
          model.train(splits.train,{bags:6,rounds:14,learningRate:.18,maxSamples:12000});
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
        memberNames:members.map(x=>x.name),
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
          shadow:c.shadow,
          walkForward:null
        });
        await this.db.pool.query(`
          INSERT INTO model_registry(
            model_id,family,horizon_minutes,status,trained_at,train_start,train_end,
            feature_names,artifact,calibration,validation_metrics,test_metrics,walk_forward_metrics,shadow_metrics,dataset,notes
          ) VALUES($1,$2,$3,'CHALLENGER',NOW(),$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14)
          ON CONFLICT(model_id) DO NOTHING
        `,[
          modelId,c.name,this.horizonMinutes,
          new Date(dataset[0].ts),new Date(dataset.at(-1).ts),
          JSON.stringify(MODEL_FEATURES),
          JSON.stringify(c.model.artifact()),
          JSON.stringify({temperature:c.temperature}),
          JSON.stringify(c.validation),JSON.stringify(c.test),JSON.stringify({}),JSON.stringify(c.shadow),
          JSON.stringify(datasetSummary),reason
        ]);
      }

      const winner=[...candidates].sort((a,b)=>{
        const sa=a.shadow.brier+a.test.brier*.65+a.shadow.ece*.20-a.shadow.accuracy*.04;
        const sb=b.shadow.brier+b.test.brier*.65+b.shadow.ece*.20-b.shadow.accuracy*.04;
        return sa-sb;
      })[0];

      const walkForward=await this.#walkForward(
        winner.name,
        dataset,
        winner.memberNames||[]
      );
      winner.walkForward=walkForward;
      const winnerSummary=candidateSummaries.find(x=>x.modelId===winner.modelId);
      if(winnerSummary) winnerSummary.walkForward=walkForward;
      await this.db.pool.query(
        "UPDATE model_registry SET walk_forward_metrics=$2::jsonb WHERE model_id=$1",
        [winner.modelId,JSON.stringify(walkForward)]
      );

      let promote=false;
      let enterShadow=false;
      let promotionReason="";

      if(!this.productionRecord){
        const wfSafe=walkForward.folds.length>=2 &&
          walkForward.brier<=winner.shadow.brier*1.18 &&
          walkForward.accuracyStd<=.10;
        promote=winner.shadow.samples>=500&&wfSafe;
        promotionReason=promote
          ?"Bootstrap production selected from chronological train/validation/test/final-holdout data. Future replacements require live shadow proof."
          :"Not enough chronological holdout samples for first production model.";
      }else{
        const incumbent=modelFromRegistryArtifact(this.productionRecord.artifact);
        const incTest=incumbent?metricsFor(incumbent,splits.test):null;
        const incHoldout=incumbent?metricsFor(incumbent,splits.shadow):null;
        if(incTest&&incHoldout){
          const holdoutBrierBetter=winner.shadow.brier<=incHoldout.brier*.995;
          const testSafe=winner.test.brier<=incTest.brier*1.005;
          const accuracySafe=winner.shadow.accuracy>=incHoldout.accuracy-.01;
          const calibrated=winner.shadow.ece<=incHoldout.ece+.02;
          const wfSafe=walkForward.folds.length>=2 &&
            walkForward.brier<=winner.shadow.brier*1.18 &&
            walkForward.accuracyStd<=.10;
          enterShadow=winner.shadow.samples>=500&&holdoutBrierBetter&&testSafe&&accuracySafe&&calibrated&&wfSafe;
          promotionReason=enterShadow
            ?`Historical gates passed. ${winner.modelId} entered LIVE SHADOW; it cannot replace production until enough future real-time outcomes beat production on paired Brier/calibration/accuracy.`
            :`Rejected before live shadow: challenger did not beat incumbent under chronological Brier/test/accuracy/calibration guards.`;
        }else{
          promotionReason="Incumbent artifact could not be evaluated safely; challenger rejected and production unchanged.";
        }
      }

      const candidateIds=candidates.map(x=>x.modelId);
      if(promote){
        const client=await this.db.pool.connect();
        try{
          await client.query("BEGIN");
          await client.query(`
            UPDATE model_registry SET status='RETIRED'
            WHERE horizon_minutes=$1 AND status='PRODUCTION'
          `,[this.horizonMinutes]);
          await client.query(`
            UPDATE model_registry
            SET status='PRODUCTION',promoted_at=NOW()
            WHERE model_id=$1
          `,[winner.modelId]);
          await client.query(`
            UPDATE model_registry SET status='REJECTED'
            WHERE model_id=ANY($1::text[]) AND model_id<>$2
          `,[candidateIds,winner.modelId]);
          await client.query("COMMIT");
        }catch(err){
          await client.query("ROLLBACK");
          throw err;
        }finally{
          client.release();
        }
      }else if(enterShadow){
        await this.db.pool.query(`
          UPDATE model_registry
          SET status=CASE WHEN model_id=$2 THEN 'SHADOW' ELSE 'REJECTED' END,
              shadow_started_at=CASE WHEN model_id=$2 THEN NOW() ELSE shadow_started_at END
          WHERE model_id=ANY($1::text[])
        `,[candidateIds,winner.modelId]);
      }else{
        await this.db.pool.query(`
          UPDATE model_registry SET status='REJECTED'
          WHERE model_id=ANY($1::text[])
        `,[candidateIds]);
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
      await this.loadShadowModels();
      await this.refreshLiveShadowMetrics();
      console.log(JSON.stringify({
        event:"model_lab_complete",
        runId,
        examples:dataset.length,
        symbols:usableSymbols.length,
        winner:winner.modelId,
        promoted:promote,
        enteredLiveShadow:enterShadow,
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

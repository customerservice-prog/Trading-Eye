const EPS=1e-9;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));

export const CLASS_NAMES=["UP","FLAT","DOWN"];

function softmax(logits){
  const m=Math.max(...logits);
  const ex=logits.map(x=>Math.exp(x-m));
  const s=ex.reduce((a,b)=>a+b,0)||1;
  return ex.map(x=>x/s);
}
function argmax(a){
  let bi=0;
  for(let i=1;i<a.length;i++) if(a[i]>a[bi]) bi=i;
  return bi;
}
function targetIndex(y){ return argmax(y); }

export function applyTemperature(probs,temp=1){
  const t=Math.max(.35,Math.min(3,Number(temp)||1));
  const adjusted=probs.map(p=>Math.pow(Math.max(EPS,p),1/t));
  const s=adjusted.reduce((a,b)=>a+b,0)||1;
  return adjusted.map(x=>x/s);
}

export class SoftmaxModel {
  constructor({featureCount,featureIndices=null,weights=null,bias=null,name="softmax"}){
    this.kind="softmax";
    this.name=name;
    this.featureCount=featureCount;
    this.featureIndices=featureIndices||Array.from({length:featureCount},(_,i)=>i);
    this.weights=weights||CLASS_NAMES.map(()=>Array(this.featureIndices.length).fill(0));
    this.bias=bias||CLASS_NAMES.map(()=>0);
  }

  train(examples,{epochs=5,learningRate=.025,l2=.0008,maxSamples=120000}={}){
    const data=examples.length>maxSamples
      ? examples.filter((_,i)=>i%Math.ceil(examples.length/maxSamples)===0).slice(0,maxSamples)
      : examples;
    if(!data.length) return this;

    let lr=learningRate;
    for(let epoch=0;epoch<epochs;epoch++){
      for(let n=0;n<data.length;n++){
        const e=data[(n*15485863+epoch*32452843)%data.length];
        const x=this.featureIndices.map(i=>Number(e.x[i])||0);
        const logits=this.weights.map((w,c)=>
          this.bias[c]+w.reduce((s,v,j)=>s+v*x[j],0)
        );
        const p=softmax(logits);
        for(let c=0;c<CLASS_NAMES.length;c++){
          const err=(Number(e.y[c])||0)-p[c];
          this.bias[c]+=lr*err*.35;
          for(let j=0;j<x.length;j++){
            this.weights[c][j]+=lr*(err*x[j]-l2*this.weights[c][j]);
          }
        }
      }
      lr*=.82;
    }
    return this;
  }

  predict(x){
    const xx=this.featureIndices.map(i=>Number(x[i])||0);
    const logits=this.weights.map((w,c)=>
      this.bias[c]+w.reduce((s,v,j)=>s+v*xx[j],0)
    );
    return softmax(logits);
  }

  artifact(){
    return {
      kind:this.kind,name:this.name,featureCount:this.featureCount,
      featureIndices:this.featureIndices,weights:this.weights,bias:this.bias
    };
  }

  static fromArtifact(a){
    return new SoftmaxModel(a);
  }
}

export class GaussianNBModel {
  constructor({featureCount,featureIndices=null,means=null,vars=null,priors=null,name="gaussian_nb"}){
    this.kind="gaussian_nb";
    this.name=name;
    this.featureCount=featureCount;
    this.featureIndices=featureIndices||Array.from({length:featureCount},(_,i)=>i);
    this.means=means||CLASS_NAMES.map(()=>Array(this.featureIndices.length).fill(0));
    this.vars=vars||CLASS_NAMES.map(()=>Array(this.featureIndices.length).fill(1));
    this.priors=priors||CLASS_NAMES.map(()=>1/CLASS_NAMES.length);
  }

  train(examples,{maxSamples=160000}={}){
    const data=examples.length>maxSamples
      ? examples.filter((_,i)=>i%Math.ceil(examples.length/maxSamples)===0).slice(0,maxSamples)
      : examples;
    const sums=CLASS_NAMES.map(()=>Array(this.featureIndices.length).fill(0));
    const sumSq=CLASS_NAMES.map(()=>Array(this.featureIndices.length).fill(0));
    const counts=CLASS_NAMES.map(()=>0);

    for(const e of data){
      const c=targetIndex(e.y);
      counts[c]++;
      for(let j=0;j<this.featureIndices.length;j++){
        const v=Number(e.x[this.featureIndices[j]])||0;
        sums[c][j]+=v;
        sumSq[c][j]+=v*v;
      }
    }
    const total=counts.reduce((a,b)=>a+b,0)||1;
    for(let c=0;c<CLASS_NAMES.length;c++){
      this.priors[c]=(counts[c]+3)/(total+9);
      for(let j=0;j<this.featureIndices.length;j++){
        const n=Math.max(1,counts[c]);
        const m=sums[c][j]/n;
        const variance=Math.max(.02,sumSq[c][j]/n-m*m);
        this.means[c][j]=m;
        this.vars[c][j]=variance;
      }
    }
    return this;
  }

  predict(x){
    const scores=CLASS_NAMES.map((_,c)=>{
      let s=Math.log(Math.max(EPS,this.priors[c]));
      for(let j=0;j<this.featureIndices.length;j++){
        const v=Number(x[this.featureIndices[j]])||0;
        const mean=this.means[c][j];
        const variance=this.vars[c][j];
        const d=v-mean;
        s+=-.5*Math.log(2*Math.PI*variance)-.5*d*d/variance;
      }
      return s;
    });
    return softmax(scores);
  }

  artifact(){
    return {
      kind:this.kind,name:this.name,featureCount:this.featureCount,
      featureIndices:this.featureIndices,means:this.means,vars:this.vars,priors:this.priors
    };
  }

  static fromArtifact(a){
    return new GaussianNBModel(a);
  }
}

export function modelFromArtifact(a){
  if(!a) return null;
  if(a.kind==="softmax") return SoftmaxModel.fromArtifact(a);
  if(a.kind==="gaussian_nb") return GaussianNBModel.fromArtifact(a);
  return null;
}

export function metricsFor(model,examples,{temperature=1}={}){
  let correct=0,brier=0,logLoss=0;
  const confidenceBuckets=Array.from({length:10},()=>({n:0,conf:0,correct:0}));
  const confusion=CLASS_NAMES.map(()=>CLASS_NAMES.map(()=>0));

  for(const e of examples){
    const raw=model.predict(e.x);
    const p=applyTemperature(raw,temperature);
    const yi=targetIndex(e.y);
    const pi=argmax(p);
    if(pi===yi) correct++;
    confusion[yi][pi]++;
    for(let c=0;c<CLASS_NAMES.length;c++){
      const d=p[c]-(c===yi?1:0);
      brier+=d*d/CLASS_NAMES.length;
    }
    logLoss+=-Math.log(Math.max(EPS,p[yi]));
    const conf=Math.max(...p);
    const bucket=Math.min(9,Math.floor(conf*10));
    confidenceBuckets[bucket].n++;
    confidenceBuckets[bucket].conf+=conf;
    if(pi===yi) confidenceBuckets[bucket].correct++;
  }
  const n=Math.max(1,examples.length);
  let ece=0;
  const calibration=confidenceBuckets
    .filter(b=>b.n)
    .map(b=>{
      const avgConf=b.conf/b.n;
      const accuracy=b.correct/b.n;
      ece+=(b.n/n)*Math.abs(avgConf-accuracy);
      return {samples:b.n,avgConfidence:avgConf,accuracy};
    });
  return {
    samples:examples.length,
    accuracy:correct/n,
    brier:brier/n,
    logLoss:logLoss/n,
    ece,
    calibration,
    confusion
  };
}

export function chooseTemperature(model,validation){
  let best={temperature:1,metrics:metricsFor(model,validation,{temperature:1})};
  for(const t of [.55,.7,.85,1,1.15,1.35,1.6,2,2.5]){
    const metrics=metricsFor(model,validation,{temperature:t});
    if(metrics.logLoss<best.metrics.logLoss) best={temperature:t,metrics};
  }
  return best;
}

export class EnsembleModel {
  constructor({members,weights,temperature=1,name="meta_ensemble"}){
    this.kind="ensemble";
    this.name=name;
    this.members=members;
    this.weights=weights;
    this.temperature=temperature;
  }

  predict(x){
    const out=[0,0,0];
    let total=0;
    for(let i=0;i<this.members.length;i++){
      const w=Math.max(0,Number(this.weights[i])||0);
      if(!w) continue;
      const raw=this.members[i].model.predict(x);
      const p=applyTemperature(raw,this.members[i].temperature||1);
      for(let c=0;c<3;c++) out[c]+=w*p[c];
      total+=w;
    }
    if(!total) return [1/3,1/3,1/3];
    const base=out.map(x=>x/total);
    return applyTemperature(base,this.temperature);
  }

  artifact(){
    return {
      kind:this.kind,name:this.name,weights:this.weights,temperature:this.temperature,
      members:this.members.map(m=>({
        name:m.name,
        artifact:m.model.artifact(),
        temperature:m.temperature||1
      }))
    };
  }

  static fromArtifact(a){
    const members=(a.members||[]).map(m=>({
      name:m.name,
      model:modelFromArtifact(m.artifact),
      temperature:m.temperature||1
    })).filter(x=>x.model);
    return new EnsembleModel({
      members,weights:a.weights||members.map(()=>1),
      temperature:a.temperature||1,name:a.name||"meta_ensemble"
    });
  }
}

export function buildEnsembleWeight(metrics){
  const brier=Math.max(.01,Number(metrics?.brier)||1);
  const ece=Math.max(0,Number(metrics?.ece)||0);
  return 1/(brier*(1+ece*2));
}

export function splitChronologically(examples){
  const n=examples.length;
  const a=Math.floor(n*.60);
  const b=Math.floor(n*.78);
  const c=Math.floor(n*.90);
  return {
    train:examples.slice(0,a),
    validation:examples.slice(a,b),
    test:examples.slice(b,c),
    shadow:examples.slice(c)
  };
}

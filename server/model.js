const KEYS=["trend","momentum","volume","volatility","orderFlow","breadth","vwap"];
const DEFAULT_WEIGHTS={trend:.70,momentum:.58,volume:.20,volatility:-.08,orderFlow:.46,breadth:.42,vwap:.34,bias:0};
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const sigmoid=x=>1/(1+Math.exp(-x));

export class OnlineModel {
  constructor(db,{key="minute-direction-v1",learningRate=.045}={}) {
    this.db=db;
    this.key=key;
    this.learningRate=learningRate;
    this.version=1;
    this.weights={...DEFAULT_WEIGHTS};
    this.stats={learningUpdates:0,lastUpdatedAt:null};
  }

  async load() {
    const row=await this.db.loadModel(this.key);
    if (row) {
      this.version=row.version || 1;
      this.weights={...DEFAULT_WEIGHTS,...row.weights};
      this.stats={...this.stats,...row.stats};
    } else {
      await this.persist();
    }
  }

  analyze(features) {
    const raw=KEYS.reduce((sum,k)=>sum+(features[k]||0)*(this.weights[k]||0),this.weights.bias||0);
    const directional=sigmoid(raw*1.8);
    const certainty=Math.abs(directional-.5)*2;
    const flat=clamp(.27-certainty*.18+Math.max(0,features.volatility||0)*.025,.07,.30);
    const remainder=1-flat;
    const pUp=directional*remainder;
    const pDown=(1-directional)*remainder;
    const probs={UP:pUp,FLAT:flat,DOWN:pDown};
    const direction=Object.entries(probs).sort((a,b)=>b[1]-a[1])[0][0];
    const confidence=Math.max(pUp,flat,pDown);
    const contributions=KEYS.map(key=>({
      key,value:features[key]||0,weight:this.weights[key]||0,
      contribution:(features[key]||0)*(this.weights[key]||0)
    })).sort((a,b)=>Math.abs(b.contribution)-Math.abs(a.contribution));
    return {direction,confidence,pUp,pFlat:flat,pDown,raw,contributions,modelVersion:this.version};
  }

  async learn(features,actualDirection,predicted,{persist=true,historical=false}={}) {
    const target=actualDirection==="UP"?1:actualDirection==="DOWN"?0:.5;
    const predDirectional=predicted.p_up/Math.max(.000001,predicted.p_up+predicted.p_down);
    const error=target-predDirectional;
    for (const key of KEYS) {
      this.weights[key]=clamp(
        this.weights[key]+this.learningRate*error*(features[key]||0),
        -2.25,2.25
      );
    }
    this.weights.bias=clamp(this.weights.bias+this.learningRate*error*.22,-.75,.75);
    this.version+=1;
    this.stats.learningUpdates=(this.stats.learningUpdates||0)+1;
    if (historical) this.stats.historicalUpdates=(this.stats.historicalUpdates||0)+1;
    else this.stats.liveUpdates=(this.stats.liveUpdates||0)+1;
    this.stats.lastUpdatedAt=new Date().toISOString();
    if (persist) await this.persist();
  }

  async setHistoricalValidation(validation) {
    this.stats.historicalBootstrappedAt=new Date().toISOString();
    this.stats.historicalTrainingSamples=validation.trainingSamples;
    this.stats.historicalHoldoutSamples=validation.holdoutSamples;
    this.stats.historicalHoldoutAccuracy=validation.holdoutAccuracy;
    this.stats.historicalHighConfidenceSamples=validation.highConfidenceSamples;
    this.stats.historicalHighConfidenceAccuracy=validation.highConfidenceAccuracy;
    await this.persist();
  }

  async persist() {
    await this.db.saveModel(this.key,this.version,this.weights,this.stats);
  }

  snapshot() {
    return {
      key:this.key,version:this.version,weights:{...this.weights},stats:{...this.stats}
    };
  }
}

export { KEYS as FEATURE_KEYS };

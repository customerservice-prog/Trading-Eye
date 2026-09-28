const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0;
const stdev=a=>{
  if(a.length<2) return 0;
  const m=mean(a);
  return Math.sqrt(a.reduce((s,x)=>s+(x-m)**2,0)/(a.length-1));
};
const pct=(a,b)=>b?(a-b)/b:0;

export const MODEL_FEATURES=[
  "ret1","ret3","ret5","ret10","ret20",
  "momAccel","body","range","upperWick","lowerWick",
  "rv5","rv20","volRel5","volRel20","volAccel",
  "vwapDist","ma5Dist","ma20Dist","maCross",
  "high20Dist","low20Dist","rangeCompression",
  "trendSlope10","trendSlope30","closeLocation",
  "spyRet5","qqqRet5","breadth5","relativeSpy5","relativeQqq5",
  "sectorRet5","relativeSector5","eventRisk","corporateActionRisk",
  "timeSin","timeCos"
];

function etMinute(ts){
  const d=new Date(ts);
  const parts=Object.fromEntries(
    new Intl.DateTimeFormat("en-US",{
      timeZone:"America/New_York",hour:"2-digit",minute:"2-digit",hourCycle:"h23"
    }).formatToParts(d).filter(x=>x.type!=="literal").map(x=>[x.type,x.value])
  );
  return Number(parts.hour)*60+Number(parts.minute);
}

function slope(values){
  const n=values.length;
  if(n<2) return 0;
  const xm=(n-1)/2;
  const ym=mean(values);
  let num=0,den=0;
  for(let i=0;i<n;i++){
    const dx=i-xm;
    num+=dx*(values[i]-ym);
    den+=dx*dx;
  }
  return den?num/den:0;
}

export class FeatureFactory {
  extract(rows,index=rows.length-1,context={}){
    if(!Array.isArray(rows) || index<35 || !rows[index]) return null;
    const last=rows[index];
    const c=n=>Number(rows[index-n]?.close);
    const o=Number(last.open),h=Number(last.high),l=Number(last.low),close=Number(last.close);
    if(![o,h,l,close].every(Number.isFinite) || close<=0) return null;

    const recent=rows.slice(Math.max(0,index-39),index+1);
    const vols=recent.map(x=>Number(x.volume)||0);
    const closes=recent.map(x=>Number(x.close)||0);
    const returns=[];
    for(let i=1;i<recent.length;i++){
      const a=Number(recent[i-1].close),b=Number(recent[i].close);
      if(a>0&&Number.isFinite(b)) returns.push((b-a)/a);
    }
    const r5=returns.slice(-5),r20=returns.slice(-20);

    const avgVol5=mean(vols.slice(-6,-1));
    const avgVol20=mean(vols.slice(-21,-1));
    const curVol=Number(last.volume)||0;

    const tpv=recent.slice(-20).reduce((s,x)=>{
      const tp=(Number(x.high)+Number(x.low)+Number(x.close))/3;
      return s+tp*(Number(x.volume)||0);
    },0);
    const vol20=recent.slice(-20).reduce((s,x)=>s+(Number(x.volume)||0),0);
    const vwap20=vol20?tpv/vol20:close;

    const ma5=mean(closes.slice(-5));
    const ma20=mean(closes.slice(-20));
    const highs20=recent.slice(-20).map(x=>Number(x.high));
    const lows20=recent.slice(-20).map(x=>Number(x.low));
    const hi20=Math.max(...highs20);
    const lo20=Math.min(...lows20);
    const barRange=Math.max(h-l,close*1e-6);

    const trueRanges=[];
    for(let i=Math.max(1,recent.length-20);i<recent.length;i++){
      const x=recent[i],p=recent[i-1];
      trueRanges.push(Math.max(
        Number(x.high)-Number(x.low),
        Math.abs(Number(x.high)-Number(p.close)),
        Math.abs(Number(x.low)-Number(p.close))
      )/Math.max(Number(p.close),1e-9));
    }
    const range5=mean(trueRanges.slice(-5));
    const range20=mean(trueRanges);

    const minute=etMinute(last.ts||last.time||Date.now());
    const regularMinute=clamp(minute-(9*60+30),0,390);
    const angle=(regularMinute/390)*Math.PI*2;

    const feature={
      ret1:clamp(pct(close,c(1))/0.01,-3,3),
      ret3:clamp(pct(close,c(3))/0.02,-3,3),
      ret5:clamp(pct(close,c(5))/0.025,-3,3),
      ret10:clamp(pct(close,c(10))/0.04,-3,3),
      ret20:clamp(pct(close,c(20))/0.06,-3,3),
      momAccel:clamp((pct(close,c(3))-pct(c(3),c(6)))/0.02,-3,3),
      body:clamp((close-o)/barRange,-1,1),
      range:clamp(((h-l)/close)/0.03,0,3),
      upperWick:clamp((h-Math.max(o,close))/barRange,0,1),
      lowerWick:clamp((Math.min(o,close)-l)/barRange,0,1),
      rv5:clamp(stdev(r5)/0.015,0,3),
      rv20:clamp(stdev(r20)/0.02,0,3),
      volRel5:clamp(avgVol5?curVol/avgVol5-1:0,-1,4),
      volRel20:clamp(avgVol20?curVol/avgVol20-1:0,-1,4),
      volAccel:clamp(avgVol5&&avgVol20?(avgVol5/avgVol20)-1:0,-2,3),
      vwapDist:clamp(((close-vwap20)/close)/0.025,-3,3),
      ma5Dist:clamp(((close-ma5)/close)/0.02,-3,3),
      ma20Dist:clamp(((close-ma20)/close)/0.05,-3,3),
      maCross:clamp(((ma5-ma20)/close)/0.04,-3,3),
      high20Dist:clamp(((close-hi20)/close)/0.04,-3,0),
      low20Dist:clamp(((close-lo20)/close)/0.04,0,3),
      rangeCompression:clamp(range20?range5/range20-1:0,-1,2),
      trendSlope10:clamp((slope(closes.slice(-10))/close)/0.004,-3,3),
      trendSlope30:clamp((slope(closes.slice(-30))/close)/0.002,-3,3),
      closeLocation:clamp(((close-lo20)/Math.max(hi20-lo20,close*1e-6))*2-1,-1,1),
      spyRet5:clamp((Number(context.spyRet5)||0)/0.025,-3,3),
      qqqRet5:clamp((Number(context.qqqRet5)||0)/0.03,-3,3),
      breadth5:clamp(Number(context.breadth5)||0,-1,1),
      relativeSpy5:clamp((pct(close,c(5))-(Number(context.spyRet5)||0))/0.025,-3,3),
      relativeQqq5:clamp((pct(close,c(5))-(Number(context.qqqRet5)||0))/0.03,-3,3),
      sectorRet5:clamp((Number(context.sectorRet5)||0)/0.03,-3,3),
      relativeSector5:clamp((pct(close,c(5))-(Number(context.sectorRet5)||0))/0.03,-3,3),
      eventRisk:clamp(Number(context.eventRisk)||0,0,1),
      corporateActionRisk:clamp(Number(context.corporateActionRisk)||0,0,1),
      timeSin:Math.sin(angle),
      timeCos:Math.cos(angle)
    };
    return feature;
  }

  buildContextMap(histories,sectorProxyBySymbol={}){
    const accum=new Map();
    const core={SPY:new Map(),QQQ:new Map()};
    const symbolReturns=new Map();
    for(const [symbol,rows] of histories.entries()){
      if(!Array.isArray(rows)||rows.length<6) continue;
      for(let i=5;i<rows.length;i++){
        const ts=+new Date(rows[i].ts||rows[i].time);
        const prev=Number(rows[i-5].close),cur=Number(rows[i].close);
        if(!Number.isFinite(ts)||!prev||!Number.isFinite(cur)) continue;
        const r=(cur-prev)/prev;
        let a=accum.get(ts);
        if(!a){ a={up:0,total:0}; accum.set(ts,a); }
        a.total++;
        if(r>0) a.up++;
        if(!symbolReturns.has(symbol)) symbolReturns.set(symbol,new Map());
        symbolReturns.get(symbol).set(ts,r);
        if(symbol==="SPY") core.SPY.set(ts,r);
        if(symbol==="QQQ") core.QQQ.set(ts,r);
      }
    }
    const out=new Map();
    for(const [ts,a] of accum.entries()){
      out.set(ts,{
        spyRet5:core.SPY.get(ts)||0,
        qqqRet5:core.QQQ.get(ts)||0,
        breadth5:a.total?((a.up/a.total)-.5)*2:0,
        symbolReturns
      });
    }
    return out;
  }

  contextAt(histories,ts,sectorProxy=null,extra={}){
    const target=+new Date(ts);
    let up=0,total=0,spyRet5=0,qqqRet5=0;
    for(const [symbol,rows] of histories.entries()){
      if(!rows?.length) continue;
      let idx=rows.length-1;
      while(idx>5 && +new Date(rows[idx].ts||rows[idx].time)>target) idx--;
      if(idx<5) continue;
      const prev=Number(rows[idx-5].close),cur=Number(rows[idx].close);
      if(!prev||!Number.isFinite(cur)) continue;
      const r=(cur-prev)/prev;
      total++; if(r>0) up++;
      if(symbol==="SPY") spyRet5=r;
      if(symbol==="QQQ") qqqRet5=r;
    }
    let sectorRet5=0;
    if(sectorProxy){
      const rows=histories.get(sectorProxy)||[];
      let idx=rows.length-1;
      while(idx>5 && +new Date(rows[idx].ts||rows[idx].time)>target) idx--;
      if(idx>=5){
        const prev=Number(rows[idx-5].close),cur=Number(rows[idx].close);
        if(prev&&Number.isFinite(cur)) sectorRet5=(cur-prev)/prev;
      }
    }
    return {
      spyRet5,qqqRet5,sectorRet5,
      breadth5:total?((up/total)-.5)*2:0,
      eventRisk:Number(extra.eventRisk)||0,
      corporateActionRisk:Number(extra.corporateActionRisk)||0
    };
  }

  vector(features){
    return MODEL_FEATURES.map(k=>Number(features?.[k])||0);
  }

  target(rows,index,horizon=15,threshold=.001){
    const ref=rows[index],future=rows[index+horizon];
    if(!ref||!future) return null;
    const t0=+new Date(ref.ts||ref.time),t1=+new Date(future.ts||future.time);
    const elapsed=(t1-t0)/60000;
    if(!Number.isFinite(elapsed)||elapsed<horizon-1||elapsed>horizon+5) return null;
    const r=(Number(future.close)-Number(ref.close))/Number(ref.close);
    return {
      direction:r>threshold?"UP":r<-threshold?"DOWN":"FLAT",
      return:r,
      target:[r>threshold?1:0,Math.abs(r)<=threshold?1:0,r<-threshold?1:0]
    };
  }

  buildDataset(histories,{
    symbols=null,horizon=15,step=5,maxSamples=220000,
    sectorProxyBySymbol={},eventRiskBySymbol={},excludeDaysBySymbol=new Map()
  }={}){
    const examples=[];
    const chosen=symbols||[...histories.keys()];
    const contextMap=this.buildContextMap(histories,sectorProxyBySymbol);
    for(const symbol of chosen){
      const rows=histories.get(symbol)||[];
      if(rows.length<100) continue;
      for(let i=40;i<rows.length-horizon-1;i+=step){
        const ts=+new Date(rows[i].ts||rows[i].time);
        const day=new Date(ts).toISOString().slice(0,10);
        const excluded=excludeDaysBySymbol instanceof Map
          ?excludeDaysBySymbol.get(symbol)?.has(day)
          :excludeDaysBySymbol?.[symbol]?.includes?.(day);
        if(excluded) continue;
        const base=contextMap.get(ts)||{};
        const sectorProxy=sectorProxyBySymbol[symbol]||null;
        const sectorRet5=sectorProxy
          ?(base.symbolReturns?.get(sectorProxy)?.get(ts)||0)
          :0;
        const extra=eventRiskBySymbol[symbol]||{};
        const features=this.extract(rows,i,{
          ...base,
          sectorRet5,
          eventRisk:Number(extra.eventRisk)||0,
          corporateActionRisk:Number(extra.corporateActionRisk)||0
        });
        const target=this.target(rows,i,horizon);
        if(!features||!target) continue;
        examples.push({
          symbol,
          ts:+new Date(rows[i].ts||rows[i].time),
          x:this.vector(features),
          features,
          y:target.target,
          direction:target.direction,
          futureReturn:target.return
        });
      }
    }
    examples.sort((a,b)=>a.ts-b.ts);
    if(examples.length>maxSamples){
      const stride=examples.length/maxSamples;
      const sampled=[];
      for(let i=0;i<maxSamples;i++) sampled.push(examples[Math.floor(i*stride)]);
      return sampled;
    }
    return examples;
  }
}

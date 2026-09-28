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
  "spyRet5","qqqRet5","breadth5","dispersion5","crossRank5",
  "relativeSpy5","relativeQqq5","sectorRet5","relativeSector5",
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

const SECTOR_ETFS=["XLK","XLF","XLE","XLV","XLY","XLP","XLI","XLB","XLU","XLRE","XLC"];

function correlation(a,b){
  const n=Math.min(a.length,b.length);
  if(n<30) return 0;
  const aa=a.slice(-n),bb=b.slice(-n);
  const ma=mean(aa),mb=mean(bb);
  let num=0,da=0,db=0;
  for(let i=0;i<n;i++){
    const x=aa[i]-ma,y=bb[i]-mb;
    num+=x*y;da+=x*x;db+=y*y;
  }
  return da&&db?num/Math.sqrt(da*db):0;
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
      dispersion5:clamp((Number(context.dispersion5)||0)/0.03,0,3),
      crossRank5:clamp(Number(context.crossRank5)||0,-1,1),
      relativeSpy5:clamp((pct(close,c(5))-(Number(context.spyRet5)||0))/0.025,-3,3),
      relativeQqq5:clamp((pct(close,c(5))-(Number(context.qqqRet5)||0))/0.03,-3,3),
      sectorRet5:clamp((Number(context.sectorRet5)||0)/0.03,-3,3),
      relativeSector5:clamp((pct(close,c(5))-(Number(context.sectorRet5)||0))/0.03,-3,3),
      timeSin:Math.sin(angle),
      timeCos:Math.cos(angle)
    };
    return feature;
  }

  #returnMaps(histories){
    const maps=new Map();
    for(const [symbol,rows] of histories.entries()){
      const m=new Map();
      if(Array.isArray(rows)&&rows.length>=6){
        for(let i=5;i<rows.length;i++){
          const ts=+new Date(rows[i].ts||rows[i].time);
          const prev=Number(rows[i-5].close),cur=Number(rows[i].close);
          if(Number.isFinite(ts)&&prev>0&&Number.isFinite(cur)) m.set(ts,(cur-prev)/prev);
        }
      }
      maps.set(symbol,m);
    }
    return maps;
  }

  #sectorAssignments(histories,returnMaps=null){
    const maps=returnMaps||this.#returnMaps(histories);
    const sectors=SECTOR_ETFS.filter(s=>maps.get(s)?.size);
    const assignments=new Map();
    for(const [symbol,map] of maps.entries()){
      if(["SPY","QQQ",...SECTOR_ETFS].includes(symbol)) {
        assignments.set(symbol,symbol);
        continue;
      }
      let best="SPY",bestCorr=-Infinity;
      for(const sector of sectors){
        const sm=maps.get(sector);
        const a=[],b=[];
        const keys=[...map.keys()].slice(-2200);
        for(const ts of keys){
          if(sm.has(ts)){a.push(map.get(ts));b.push(sm.get(ts));}
        }
        const c=correlation(a,b);
        if(c>bestCorr){bestCorr=c;best=sector;}
      }
      assignments.set(symbol,bestCorr>=.15?best:"SPY");
    }
    return assignments;
  }

  buildContextMap(histories){
    const maps=this.#returnMaps(histories);
    const sectors=this.#sectorAssignments(histories,maps);
    const byTs=new Map();
    for(const [symbol,map] of maps.entries()){
      for(const [ts,r] of map.entries()){
        let row=byTs.get(ts);
        if(!row){row={returns:new Map()};byTs.set(ts,row);}
        row.returns.set(symbol,r);
      }
    }

    const out=new Map();
    for(const [ts,row] of byTs.entries()){
      const vals=[...row.returns.values()].filter(Number.isFinite);
      const breadth=vals.length?((vals.filter(x=>x>0).length/vals.length)-.5)*2:0;
      const dispersion=stdev(vals);
      const sorted=[...vals].sort((a,b)=>a-b);
      const spyRet5=row.returns.get("SPY")||0;
      const qqqRet5=row.returns.get("QQQ")||0;

      for(const [symbol,r] of row.returns.entries()){
        let rank=0;
        if(sorted.length>1){
          let idx=0;
          while(idx<sorted.length&&sorted[idx]<r) idx++;
          rank=(idx/(sorted.length-1))*2-1;
        }
        const sector=sectors.get(symbol)||"SPY";
        out.set(symbol+"|"+ts,{
          spyRet5,qqqRet5,breadth5:breadth,dispersion5:dispersion,
          crossRank5:rank,
          sectorEtf:sector,
          sectorRet5:row.returns.get(sector)||spyRet5
        });
      }
    }
    return out;
  }

  contextAt(histories,ts,symbol=null){
    const target=+new Date(ts);
    const rowsBySymbol=[];
    let spyRet5=0,qqqRet5=0,ownRet=0;
    for(const [sym,rows] of histories.entries()){
      if(!rows?.length) continue;
      let idx=rows.length-1;
      while(idx>5 && +new Date(rows[idx].ts||rows[idx].time)>target) idx--;
      if(idx<5) continue;
      const prev=Number(rows[idx-5].close),cur=Number(rows[idx].close);
      if(!prev||!Number.isFinite(cur)) continue;
      const r=(cur-prev)/prev;
      rowsBySymbol.push({symbol:sym,r});
      if(sym==="SPY") spyRet5=r;
      if(sym==="QQQ") qqqRet5=r;
      if(sym===symbol) ownRet=r;
    }
    const vals=rowsBySymbol.map(x=>x.r);
    const breadth5=vals.length?((vals.filter(x=>x>0).length/vals.length)-.5)*2:0;
    const dispersion5=stdev(vals);
    const sorted=[...vals].sort((a,b)=>a-b);
    let crossRank5=0;
    if(symbol&&sorted.length>1){
      let idx=0;
      while(idx<sorted.length&&sorted[idx]<ownRet) idx++;
      crossRank5=(idx/(sorted.length-1))*2-1;
    }

    // Use recent correlation to choose a sector proxy for live inference.
    let sectorEtf="SPY",best=-Infinity;
    if(symbol&&histories.has(symbol)){
      const own=histories.get(symbol)||[];
      const ownReturns=[];
      for(let i=Math.max(5,own.length-350);i<own.length;i+=5){
        const p=Number(own[i-5]?.close),c=Number(own[i]?.close);
        if(p>0&&Number.isFinite(c)) ownReturns.push({ts:+new Date(own[i].ts),r:(c-p)/p});
      }
      for(const sector of SECTOR_ETFS){
        const sr=histories.get(sector)||[];
        if(sr.length<20) continue;
        const sm=new Map();
        for(let i=Math.max(5,sr.length-350);i<sr.length;i+=5){
          const p=Number(sr[i-5]?.close),c=Number(sr[i]?.close);
          if(p>0&&Number.isFinite(c)) sm.set(+new Date(sr[i].ts),(c-p)/p);
        }
        const a=[],b=[];
        for(const x of ownReturns){if(sm.has(x.ts)){a.push(x.r);b.push(sm.get(x.ts));}}
        const corr=correlation(a,b);
        if(corr>best){best=corr;sectorEtf=sector;}
      }
    }
    const sectorRet5=rowsBySymbol.find(x=>x.symbol===sectorEtf)?.r||spyRet5;
    return {spyRet5,qqqRet5,breadth5,dispersion5,crossRank5,sectorEtf,sectorRet5};
  }  vector(features){
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

  buildDataset(histories,{symbols=null,horizon=15,step=5,maxSamples=220000}={}){
    const examples=[];
    const chosen=symbols||[...histories.keys()];
    const contextMap=this.buildContextMap(histories);
    for(const symbol of chosen){
      const rows=histories.get(symbol)||[];
      if(rows.length<100) continue;
      for(let i=40;i<rows.length-horizon-1;i+=step){
        const ts=+new Date(rows[i].ts||rows[i].time);
        const features=this.extract(rows,i,contextMap.get(symbol+"|"+ts)||{});
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

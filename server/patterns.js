const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));

function bin(v,{strong=.55,weak=.15}={}) {
  if (v>=strong) return "++";
  if (v>=weak) return "+";
  if (v<=-strong) return "--";
  if (v<=-weak) return "-";
  return "0";
}

export function timeBucketET(ts) {
  const d=new Date(ts);
  const parts=Object.fromEntries(
    new Intl.DateTimeFormat("en-US",{
      timeZone:"America/New_York",hour:"2-digit",minute:"2-digit",hourCycle:"h23"
    }).formatToParts(d).filter(p=>p.type!=="literal").map(p=>[p.type,p.value])
  );
  const minute=Number(parts.hour)*60+Number(parts.minute);
  if (minute<4*60) return "overnight";
  if (minute<9*60+30) return "premarket";
  if (minute<10*60) return "open30";
  if (minute<11*60+30) return "morning";
  if (minute<14*60) return "midday";
  if (minute<15*60) return "afternoon";
  if (minute<16*60) return "power";
  if (minute<20*60) return "afterhours";
  return "overnight";
}

export function fingerprintFromFeatures(features,ts) {
  if (!features) return null;
  return [
    "t"+bin(Number(features.trend)||0),
    "m"+bin(Number(features.momentum)||0),
    "v"+bin(Number(features.volume)||0,{strong:.5,weak:.12}),
    "x"+bin(Number(features.volatility)||0,{strong:.45,weak:.10}),
    "o"+bin(Number(features.orderFlow)||0,{strong:.5,weak:.15}),
    "w"+bin(Number(features.vwap)||0,{strong:.35,weak:.08}),
    "b"+bin(Number(features.breadth)||0,{strong:.45,weak:.10}),
    "s"+timeBucketET(ts)
  ].join("|");
}

export function patternProbabilities(row) {
  if (!row) return null;
  const n=Number(row.sample_count)||0;
  if (!n) return null;
  return {
    sampleCount:n,
    up:(Number(row.up_count)||0)/n,
    flat:(Number(row.flat_count)||0)/n,
    down:(Number(row.down_count)||0)/n,
    avgReturn:Number(row.avg_return)||0,
    avgAbsReturn:Number(row.avg_abs_return)||0,
    avgMfe:Number(row.avg_mfe)||0,
    avgMae:Number(row.avg_mae)||0
  };
}

export function blendProbabilities(base,pattern) {
  if (!pattern || pattern.sampleCount<12) return {
    pUp:base.pUp,pFlat:base.pFlat,pDown:base.pDown,
    direction:base.direction,confidence:base.confidence,patternWeight:0
  };
  const weight=clamp(.08+Math.log2(pattern.sampleCount)/28,.12,.34);
  const pUp=base.pUp*(1-weight)+pattern.up*weight;
  const pFlat=base.pFlat*(1-weight)+pattern.flat*weight;
  const pDown=base.pDown*(1-weight)+pattern.down*weight;
  const sum=Math.max(.000001,pUp+pFlat+pDown);
  const probs={UP:pUp/sum,FLAT:pFlat/sum,DOWN:pDown/sum};
  const direction=Object.entries(probs).sort((a,b)=>b[1]-a[1])[0][0];
  return {
    pUp:probs.UP,pFlat:probs.FLAT,pDown:probs.DOWN,
    direction,confidence:Math.max(probs.UP,probs.FLAT,probs.DOWN),patternWeight:weight
  };
}

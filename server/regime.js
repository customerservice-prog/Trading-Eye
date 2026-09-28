const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));

export function classifyMarketRegime(metrics) {
  if (!metrics || !metrics.assets) {
    return {regime:"UNKNOWN",confidence:0,reasons:["No completed whole-market scan is available."]};
  }

  const m=metrics;
  const twoWay=(m.strongUp||0)+(m.strongDown||0);
  let regime="MIXED";
  let score=.52;
  const reasons=[];

  if (m.breadthUp>=.64 && m.medianReturn1d>.002 && m.trendBreadthUp>=.58) {
    regime="BROAD_RISK_ON";
    score=.62+
      clamp((m.breadthUp-.64)*1.2,0,.14)+
      clamp(m.medianReturn1d/.02,0,.10)+
      clamp((m.trendBreadthUp-.58)*.5,0,.08);
    reasons.push(
      `${Math.round(m.breadthUp*100)}% of researched U.S. stocks/ETFs finished higher.`,
      `${Math.round(m.trendBreadthUp*100)}% remain positive over the 20-day window.`
    );
  } else if (m.breadthUp<=.36 && m.medianReturn1d<-.002 && m.trendBreadthUp<=.45) {
    regime="BROAD_RISK_OFF";
    score=.62+
      clamp((.36-m.breadthUp)*1.2,0,.14)+
      clamp(Math.abs(m.medianReturn1d)/.02,0,.10)+
      clamp((.45-m.trendBreadthUp)*.5,0,.08);
    reasons.push(
      `Only ${Math.round(m.breadthUp*100)}% of researched U.S. stocks/ETFs finished higher.`,
      `20-day trend breadth fell to ${Math.round(m.trendBreadthUp*100)}%.`
    );
  } else if (m.dispersion1d>=.035 && m.breadthUp>=.40 && m.breadthUp<=.60) {
    regime="HIGH_DISPERSION_ROTATION";
    score=.60+clamp((m.dispersion1d-.035)*4,0,.20);
    reasons.push(
      "Winners and losers were unusually spread apart.",
      "Breadth stayed mixed, which points more to rotation than a single broad direction."
    );
  } else if (twoWay>=.22 && m.avgAbsReturn1d>=.018) {
    regime="VOLATILE_TWO_WAY";
    score=.60+clamp((twoWay-.22)*.8,0,.18);
    reasons.push(
      `${Math.round((m.strongUp||0)*100)}% moved up at least 2% while ${Math.round((m.strongDown||0)*100)}% fell at least 2%.`,
      "Large moves happened in both directions."
    );
  } else if (m.avgAbsReturn1d<=.009 && m.dispersion1d<=.018 && m.medianRelativeVolume<=1.05) {
    regime="QUIET_COMPRESSION";
    score=.60+
      clamp((.009-m.avgAbsReturn1d)*12,0,.12)+
      clamp((.018-m.dispersion1d)*6,0,.10);
    reasons.push(
      "The typical stock moved relatively little.",
      "Cross-stock dispersion and relative volume were subdued."
    );
  } else {
    reasons.push(
      `Breadth was ${Math.round(m.breadthUp*100)}% positive.`,
      `Median one-day move was ${(m.medianReturn1d*100).toFixed(2)}%.`
    );
  }

  return {
    regime,
    confidence:clamp(score,.5,.92),
    reasons,
    metrics:m
  };
}

export function explainAttention(row, regimeRow=null) {
  const reasons=[];
  const r1=Number(row.return_1d)||0;
  const r5=Number(row.return_5d)||0;
  const r20=Number(row.return_20d)||0;
  const rel=Number(row.relative_volume)||0;
  const rv=Number(row.realized_vol_20)||0;
  const open=Number(row.open30_return);
  const power=Number(row.power_hour_return);
  const follow=Number(row.trend_follow_rate);
  const reverse=Number(row.reversal_rate);
  const deep=Number(row.deep_score);

  if (Math.abs(r1)>=.04) reasons.push(`${r1>0?"+":""}${(r1*100).toFixed(1)}% one-day move`);
  else if (Math.abs(r1)>=.02) reasons.push(`${r1>0?"+":""}${(r1*100).toFixed(1)}% session move`);

  if (rel>=2) reasons.push(`${rel.toFixed(1)}× relative volume`);
  else if (rel>=1.4) reasons.push(`${rel.toFixed(1)}× normal volume`);

  if (Math.abs(r20)>=.18) reasons.push(`${r20>0?"strong":"weak"} 20-day trend`);
  else if (Math.abs(r5)>=.08) reasons.push(`${r5>0?"strong":"weak"} 5-day momentum`);

  if (Number.isFinite(open) && Math.abs(open)>=.015) {
    reasons.push(`${open>0?"strong opening drive":"heavy opening selloff"}`);
  }

  if (Number.isFinite(power) && Math.abs(power)>=.015) {
    reasons.push(`${power>0?"strong power hour":"weak power hour"}`);
  }

  if (Number.isFinite(follow) && follow>=.70) reasons.push("often follows its opening direction");
  if (Number.isFinite(reverse) && reverse>=.70) reasons.push("frequent opening reversals");

  if (rv>=.75) reasons.push("high 20-day realized volatility");
  if (Number.isFinite(deep) && deep>=5) reasons.push("high 5-minute deep-study score");

  if (regimeRow?.regime==="BROAD_RISK_ON" && r1>0) reasons.push("moving with a broad risk-on market");
  if (regimeRow?.regime==="BROAD_RISK_OFF" && r1<0) reasons.push("moving with a broad risk-off market");
  if (regimeRow?.regime==="HIGH_DISPERSION_ROTATION") reasons.push("standing out in a rotation-heavy market");

  return reasons.slice(0,5);
}

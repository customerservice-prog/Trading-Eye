import { MarketClient } from "./market-client.js?v=20260928-0935";
import { MarketChart } from "./chart.js?v=20260928-0935";
import { FEATURE_LABELS } from "./ui-labels.js?v=20260928-0935";

const $=id=>document.getElementById(id);
const money=v=>Number(v||0).toLocaleString(undefined,{style:"currency",currency:"USD"});
const num=v=>Number(v||0).toLocaleString();
const pct=v=>(Number(v||0)*100).toFixed(2)+"%";
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));

const NAMES={
  SPY:"S&P 500 ETF",QQQ:"Nasdaq 100 ETF",NVDA:"NVIDIA",AAPL:"Apple",AMD:"AMD",TSLA:"Tesla"
};

const client=new MarketClient();
const chart=new MarketChart($("marketChart"),$("chartTooltip"));

let activeSymbol="QQQ";
let timeframe="5m";
let forecastOn=true;
let beginnerOn=true;
let simpleReasons=true;
let monitoredSymbols=["SPY","QQQ","NVDA","AAPL","AMD","TSLA"];
let status=null;
let snapshot={bars:[],quote:null,trades:[],analysis:null,features:null,predictions:[]};
let watchlist={rows:[],provider:"alpaca",feed:"iex"};
let predictionData={rows:[],stats:null,legacyModel:null,modelLab:null};
let paperData={startingCash:100000,cash:100000,equity:100000,openPnl:0,realizedPnl:0,fillCount:0,autopilotEnabled:false,positions:[],fills:[]};
let modelLabData={enabled:true,training:false,production:null,latestRun:null};
let studyData={status:null,rows:[]};
let scannerData={universe:null,scan:null,candidates:[],hotSymbols:[],pinnedSymbols:[]};
let patternLabData={symbol:null,status:"WAITING",statsByHorizon:{},analogs:[]};
let researchData={
  running:false,heartbeatAt:null,lastResearchEventAt:null,
  sources:{},coverage:{},jobs:[],events:[],findings:[]
};
let proofData={rows:[],governance:{readiness:null,drift:null}};
let refreshTimer=null;
let researchTimer=null;
let commandTimer=null;
let symbolSearchTimer=null;
let lastSymbolResults=[];

function toast(message) {
  const el=$("toast");
  el.textContent=message;
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer=setTimeout(()=>el.classList.remove("show"),2800);
}

function safeTime(value) {
  if (!value) return "—";
  const d=new Date(value);
  return Number.isNaN(+d)?"—":d.toLocaleTimeString([],{hour:"numeric",minute:"2-digit",second:"2-digit"});
}

function ageText(value) {
  if (!value) return "no real event yet";
  const ms=Date.now()-new Date(value).getTime();
  if (!Number.isFinite(ms)) return "unknown";
  if (ms<60000) return Math.max(0,Math.floor(ms/1000))+"s ago";
  if (ms<3600000) return Math.floor(ms/60000)+"m ago";
  return Math.floor(ms/3600000)+"h ago";
}

function marketSessionET() {
  const parts=Object.fromEntries(
    new Intl.DateTimeFormat("en-US",{
      timeZone:"America/New_York",
      weekday:"short",
      hour:"2-digit",
      minute:"2-digit",
      hourCycle:"h23"
    }).formatToParts(new Date()).filter(p=>p.type!=="literal").map(p=>[p.type,p.value])
  );
  const day={Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6}[parts.weekday];
  const minute=Number(parts.hour)*60+Number(parts.minute);
  if (day===6) return {key:"CLOSED",label:"CLOSED",detail:"U.S. stocks are closed Saturday."};
  if (day===0) {
    return minute>=20*60
      ? {key:"OVERNIGHT",label:"OVERNIGHT",detail:"Sunday overnight session is active."}
      : {key:"CLOSED",label:"CLOSED",detail:"U.S. stocks reopen Sunday at 8:00 PM ET for overnight trading."};
  }
  if (day===5 && minute>=20*60) return {key:"CLOSED",label:"CLOSED",detail:"Regular U.S. trading has ended for the week."};
  if (minute<4*60) return {key:"OVERNIGHT",label:"OVERNIGHT",detail:"Overnight session · thinner trading than regular hours."};
  if (minute<9*60+30) return {key:"PREMARKET",label:"PREMARKET",detail:"Regular market opens at 9:30 AM ET."};
  if (minute<16*60) return {key:"OPEN",label:"MARKET OPEN",detail:"Regular U.S. session · 9:30 AM–4:00 PM ET."};
  if (minute<20*60) return {key:"AFTER_HOURS",label:"AFTER HOURS",detail:"Regular session ended; after-hours trading is active."};
  return {key:"OVERNIGHT",label:"OVERNIGHT",detail:"Overnight session is active."};
}

function latestSelectedMarketTs() {
  const values=[
    snapshot.quote?.ts,
    snapshot.trades?.[0]?.ts,
    snapshot.bars?.at(-1)?.ts,
    status?.lastBarAt,
    status?.lastEventAt
  ].map(v=>v?+new Date(v):NaN).filter(Number.isFinite);
  return values.length?Math.max(...values):null;
}

function readinessSummary() {
  const server=proofData?.governance?.readiness||status?.governance?.readiness||null;
  if(server){
    const map={
      LOCKED:{label:"LOCKED",review:false},
      PROVING:{label:"PROVING",review:false},
      NOT_READY:{label:"NOT READY",review:false},
      REVIEW_ELIGIBLE:{label:"REVIEW ELIGIBLE",review:true}
    };
    const state=map[server.status]||map.LOCKED;
    const passed=(server.gates||[]).filter(g=>g.passed).length;
    const total=(server.gates||[]).length;
    const failed=(server.gates||[]).filter(g=>!g.passed&&g.key!=="manual_approval");
    const detail=server.status==="REVIEW_ELIGIBLE"
      ?"All automated proof gates passed. Real money is still locked until a manual tiny-test review."
      : failed.length
        ? `${passed}/${total} proof gates pass. Next blocker: ${failed[0].message}`
        : `${passed}/${total} proof gates pass. Real money remains locked.`;
    return {...state,detail,score:Number(server.score)||0};
  }

  return {
    label:"LOCKED",
    detail:"Server proof gates are still loading. Real money stays locked by default.",
    review:false,
    score:0
  };
}

function renderBeginnerCommandCenter() {
  if (!$("beginnerCommandTitle")) return;
  const session=marketSessionET();
  const a=normalizeAnalysis(snapshot.analysis);
  const latestTs=latestSelectedMarketTs();
  const ageMs=latestTs==null?null:Date.now()-latestTs;
  const age=latestTs==null?"NO UPDATE YET":ageText(latestTs);

  $("beginnerSession").textContent=session.label;
  $("beginnerSessionDetail").textContent=session.detail;

  const actionEl=$("beginnerAction");
  const actionBox=actionEl?.closest(".beginner-command-item");
  actionBox?.classList.remove("positive","negative");

  if (!a) {
    actionEl.textContent="WAIT";
    $("beginnerActionDetail").textContent="The AI does not have enough real evidence yet.";
  } else if (a.eventRisk?.blocked) {
    actionEl.textContent="WAIT — EVENT RISK";
    $("beginnerActionDetail").textContent=
      a.eventRisk.events?.[0]?.headline
        ? `A high-impact sourced event is active: ${a.eventRisk.events[0].headline}`
        : "A high-impact sourced event is active. Paper entry is blocked.";
  } else if (a.noTrade || a.confidence<.46 || a.edge<.055) {
    actionEl.textContent="WAIT — NO EDGE";
    $("beginnerActionDetail").textContent=
      `UP ${Math.round(a.probabilities.up*100)}% · FLAT ${Math.round(a.probabilities.flat*100)}% · DOWN ${Math.round(a.probabilities.down*100)}%. That is too close to call.`;
  } else if (a.direction==="UP") {
    actionBox?.classList.add("positive");
    actionEl.textContent="PAPER: UP SETUP";
    $("beginnerActionDetail").textContent=
      `The model sees ${Math.round(a.probabilities.up*100)}% UP probability. Paper-only while it proves itself.`;
  } else if (a.direction==="DOWN") {
    actionBox?.classList.add("negative");
    actionEl.textContent="PAPER: DOWN SETUP";
    $("beginnerActionDetail").textContent=
      `The model sees ${Math.round(a.probabilities.down*100)}% DOWN probability. Paper-only while it proves itself.`;
  } else {
    actionEl.textContent="WAIT — SIDEWAYS";
    $("beginnerActionDetail").textContent="The model currently expects no strong directional move.";
  }

  $("beginnerDataAge").textContent=age;
  if (!providerConnected()) {
    $("beginnerDataDetail").textContent="Provider is reconnecting or unavailable. Trading Eye will not invent prices.";
  } else if (latestTs==null) {
    $("beginnerDataDetail").textContent=`${sourceName()} is connected, but this symbol has not produced a new real update yet.`;
  } else if (session.key==="CLOSED") {
    $("beginnerDataDetail").textContent=`${sourceName()} · last selected-symbol update ${age}.`;
  } else if (ageMs!=null && ageMs>5*60*1000) {
    $("beginnerDataDetail").textContent=`${sourceName()} connected · selected stock has been quiet for ${age}.`;
  } else {
    $("beginnerDataDetail").textContent=`${sourceName()} · selected-symbol data is current.`;
  }

  const jobs=Array.isArray(researchData.jobs)?researchData.jobs:[];
  const running=jobs.filter(j=>j.status==="RUNNING");
  const current=
    running.find(j=>j.job_key==="long-history-1999-present") ||
    running.find(j=>j.job_type==="PATTERN_MINING") ||
    running.find(j=>j.job_type==="MODEL_RESEARCH") ||
    running.find(j=>j.job_key!=="research-brain-heartbeat-orchestrator"&&!String(j.job_key||"").startsWith("research-brain-heartbeat")) ||
    running[0] || null;

  if (current) {
    $("beginnerResearchState").textContent="WORKING NOW";
    const item=Number(current.items_done)||0;
    const total=current.items_total==null?null:Number(current.items_total);
    const bars=Number(current.bars_processed)||0;
    $("beginnerResearchDetail").textContent=
      `${String(current.phase||current.job_type||"research").replaceAll("_"," ")} · ${bars?num(bars)+" bars":""}${total?" · "+num(item)+"/"+num(total)+" items":""}`.replace(/ · $/,"");
  } else {
    $("beginnerResearchState").textContent="MONITORING";
    $("beginnerResearchDetail").textContent="No heavy job this second; live observation and shadow scoring continue.";
  }

  const ready=readinessSummary();
  $("beginnerReadiness").textContent=ready.label;
  $("beginnerReadinessDetail").textContent=ready.detail;
  $("beginnerReadiness")?.closest(".beginner-command-item")?.classList.toggle("review",ready.review);

  const actionLabel=actionEl?.textContent||"WAIT";
  $("beginnerCommandTitle").textContent=`${activeSymbol}: ${actionLabel}`;
  $("beginnerCommandSubtitle").textContent=
    session.key==="OPEN"
      ?"The market is open. Trading Eye is watching real data and will stay out when the edge is weak."
      :`${session.label}. Trading Eye is still researching; paper entries only happen when the model has enough edge.`;
}

function openResearchFocus() {
  const btn=document.querySelector('#lowerTabs button[data-tab="research"]');
  if (btn) btn.click();
  document.body.classList.add("research-focus");
  document.body.style.overflow="hidden";
  renderResearchBrain();
}

function closeResearchFocus() {
  document.body.classList.remove("research-focus");
  document.body.style.overflow="";
}

function activeFeed() {
  return String(status?.provider?.feed || watchlist.feed || "unknown").toLowerCase();
}

function sourceName() {
  return "Alpaca "+activeFeed().toUpperCase();
}

function providerConnected() {
  return Boolean(status?.configured && ["LIVE","CONNECTED"].includes(status?.provider?.state));
}

function currentRealPrice() {
  const feed=activeFeed();
  const q=snapshot.quote;
  const bid=Number(q?.bidPrice), ask=Number(q?.askPrice);
  const midpoint=Number.isFinite(bid)&&Number.isFinite(ask)&&bid>0&&ask>0?(bid+ask)/2:null;
  const b=snapshot.bars?.at(-1);
  const barPrice=b&&Number.isFinite(Number(b.close))?Number(b.close):null;
  const trades=snapshot.trades||[];
  const tradePrice=trades.length&&Number.isFinite(Number(trades[0].price))?Number(trades[0].price):null;

  if (feed==="overnight") return midpoint ?? barPrice ?? tradePrice;
  return tradePrice ?? midpoint ?? barPrice;
}

function normalizeAnalysis(a) {
  if (!a) return null;
  return {
    direction:a.direction,
    confidence:Number(a.confidence),
    edge:Number(a.edge)||0,
    noTrade:Boolean(a.noTrade),
    family:a.family||null,
    eventRisk:a.eventRisk||snapshot.eventRisk||null,
    probabilities:{up:Number(a.pUp),flat:Number(a.pFlat),down:Number(a.pDown)},
    contributions:Array.isArray(a.contributions)?a.contributions:[]
  };
}

function aggregateBars(rows,tf) {
  const minutes={"1m":1,"5m":5,"15m":15,"1h":60}[tf];
  if (!minutes) {
    const byDay=new Map();
    for (const row of rows) {
      const d=new Date(row.ts);
      const key=d.toISOString().slice(0,10);
      const b=byDay.get(key);
      if (!b) byDay.set(key,{...row,time:+d,open:Number(row.open),high:Number(row.high),low:Number(row.low),close:Number(row.close),volume:Number(row.volume)});
      else {
        b.high=Math.max(b.high,Number(row.high));
        b.low=Math.min(b.low,Number(row.low));
        b.close=Number(row.close);
        b.volume+=Number(row.volume);
      }
    }
    return [...byDay.values()];
  }
  const size=minutes*60000;
  const groups=new Map();
  for (const row of rows) {
    const t=+new Date(row.ts);
    const key=Math.floor(t/size)*size;
    let b=groups.get(key);
    if (!b) {
      b={time:key,open:Number(row.open),high:Number(row.high),low:Number(row.low),close:Number(row.close),volume:Number(row.volume)};
      groups.set(key,b);
    } else {
      b.high=Math.max(b.high,Number(row.high));
      b.low=Math.min(b.low,Number(row.low));
      b.close=Number(row.close);
      b.volume+=Number(row.volume);
    }
  }
  return [...groups.values()].sort((a,b)=>a.time-b.time);
}

function chartPredictions(rows) {
  return (rows||[]).map(p=>({
    time:+new Date(p.created_at || p.createdAt),
    direction:p.direction,
    actual:p.actual_direction || null,
    correct:p.correct
  }));
}

function directionCopy(a) {
  if (!a) return {title:"Waiting for real data",summary:"No prediction is shown until enough real market bars have been received."};
  if (a.noTrade) return {
    title:"NO TRADE — edge too weak",
    summary:"The production model does not have enough separation between outcomes to justify a paper entry. Trading Eye will keep watching instead of forcing a trade."
  };
  const gap=Math.abs(a.probabilities.up-a.probabilities.down);
  if (a.confidence<.46 || gap<.10) return {
    title:"Wait — unclear",
    summary:"The real-data signals do not agree strongly enough for the model to take a clear side."
  };
  if (a.direction==="UP") return {
    title:a.confidence>=.60?"Buyers look stronger":"Leaning upward",
    summary:"The current model assigns the highest probability to an upward move over its prediction horizon."
  };
  if (a.direction==="DOWN") return {
    title:a.confidence>=.60?"Sellers look stronger":"Leaning downward",
    summary:"The current model assigns the highest probability to a downward move over its prediction horizon."
  };
  return {title:"Sideways is most likely",summary:"The current model assigns the highest probability to a flat move over its prediction horizon."};
}

function beginnerExplanation(a) {
  if (!a) {
    if (!status?.configured) return "A real market-data provider has not been connected yet. Trading Eye will not invent prices while it waits.";
    return "The feed is connected, but the model needs enough real one-minute bars before it will form a prediction.";
  }
  const top=a.contributions.slice(0,3);
  const names=top.map(x=>FEATURE_LABELS[x.key]?.title).filter(Boolean);
  if (a.direction==="UP") return "The strongest real-data inputs currently lean upward"+(names.length?": "+names.join(", ")+".":".");
  if (a.direction==="DOWN") return "The strongest real-data inputs currently lean downward"+(names.length?": "+names.join(", ")+".":".");
  return "The strongest real-data inputs currently do not favor a large directional move.";
}

function renderStatus() {
  const configured=Boolean(status?.configured);
  const state=status?.provider?.state || "STARTING";
  const feed=(status?.provider?.feed || "—").toUpperCase();

  if (!configured) {
    $("feedStatus").textContent="REAL DATA NOT CONNECTED";
    $("brainStateBadge").innerHTML="<i></i> WAITING";
  } else {
    $("feedStatus").textContent=`ALPACA ${feed} · ${state}`;
    $("brainStateBadge").innerHTML=`<i></i> ${snapshot.analysis?"LEARNING":"COLLECTING"}`;
  }

  $("techPulse").textContent=configured?"Alpaca":"Not connected";
  $("techPulse").className=configured?"positive":"negative";
  $("breadthPulse").textContent=feed==="SIP"
    ?"Consolidated U.S."
    :feed==="OVERNIGHT"
      ?"Overnight · free"
      :"IEX only";
  $("breadthPulse").className=feed==="SIP"?"positive":"neutral";
  $("volPulse").textContent=ageText(status?.lastBarAt);
  $("volPulse").className="neutral";
  $("marketRegimeBadge").textContent=state;

  const buttons=[$("paperBuyBtn"),$("paperSellBtn"),$("flattenBtn"),$("autopilotToggle")];
  const usable=providerConnected() && currentRealPrice()!=null;
  for (const b of buttons) if (b) b.disabled=!usable;

  document.body.dataset.dataState=configured?"configured":"missing";
}

function renderWatchlist() {
  const wrap=$("watchlist");
  wrap.innerHTML="";
  for (const row of watchlist.rows||[]) {
    const symbol=row.symbol;
    const bar=row.bar;
    const price=bar?Number(bar.close):null;
    const el=document.createElement("div");
    el.className="watch-row"+(symbol===activeSymbol?" active":"");
    el.dataset.symbol=symbol;
    el.innerHTML=`
      <div>
        <div class="watch-symbol">${symbol}</div>
        <div class="watch-name">${row.name||NAMES[symbol]||symbol}</div>
      </div>
      <div class="watch-price">
        <strong>${price==null?"—":price.toFixed(2)}</strong>
        <span class="neutral">${bar?"1m · "+safeTime(bar.ts):"no real bar"}</span>
      </div>`;
    el.addEventListener("click",()=>selectSymbol(symbol));
    wrap.appendChild(el);
  }
}

function renderHistoricalMemory() {
  if (!$("memorySampleCount")) return;
  const m=snapshot.patternInsight||null;
  const samples=Number(m?.sampleCount)||0;

  $("memorySampleCount").textContent=samples?num(samples)+" matches":"0 matches";
  $("memoryUp").textContent=samples?Math.round(Number(m.upRate||0)*100)+"%":"—";
  $("memoryFlat").textContent=samples?Math.round(Number(m.flatRate||0)*100)+"%":"—";
  $("memoryDown").textContent=samples?Math.round(Number(m.downRate||0)*100)+"%":"—";
  $("memoryAvgReturn").textContent=samples
    ? (Number(m.avgReturn||0)>=0?"+":"")+pct(Number(m.avgReturn||0))
    : "—";
  $("memoryWeight").textContent=samples
    ? Math.round(Number(m.patternWeight||0)*100)+"%"
    : "—";

  if (!samples) {
    $("memoryExplanation").textContent="Trading Eye has not found a stored historical setup matching this current state yet.";
    return;
  }

  const rates=[
    ["up",Number(m.upRate||0)],
    ["flat",Number(m.flatRate||0)],
    ["down",Number(m.downRate||0)]
  ].sort((a,b)=>b[1]-a[1]);
  const leader=rates[0];
  const avg=(Number(m.avgReturn||0)*100).toFixed(2);
  const weight=Math.round(Number(m.patternWeight||0)*100);

  if (samples<12) {
    $("memoryExplanation").textContent=
      `Trading Eye found ${samples} similar stored setups, but that is below the 12-sample threshold required before historical memory can influence a prediction.`;
  } else {
    $("memoryExplanation").textContent=
      `Across ${samples} similar stored setups, ${leader[0]} was most common at ${Math.round(leader[1]*100)}%. The average 15-minute move was ${Number(avg)>=0?"+":""}${avg}%. Historical memory currently contributes about ${weight}% of the combined forecast.`;
  }
}

function renderAI() {
  renderHistoricalMemory();
  const a=normalizeAnalysis(snapshot.analysis);
  const copy=directionCopy(a);
  $("decisionTitle").textContent=copy.title;
  $("decisionSummary").textContent=copy.summary;
  $("decisionTitle").className=a?.direction==="UP"?"positive":a?.direction==="DOWN"?"negative":"neutral";

  const conf=a?Math.round(a.confidence*100):0;
  $("confidenceValue").textContent=a?conf+"%":"—";
  $("confidenceRing").style.setProperty("--confidence",conf);

  const vals=a
    ? [Math.round(a.probabilities.up*100),Math.round(a.probabilities.flat*100),Math.round(a.probabilities.down*100)]
    : [0,0,0];
  $("probUp").textContent=a?vals[0]+"%":"—";
  $("probFlat").textContent=a?vals[1]+"%":"—";
  $("probDown").textContent=a?vals[2]+"%":"—";
  $("probUpBar").style.width=vals[0]+"%";
  $("probFlatBar").style.width=vals[1]+"%";
  $("probDownBar").style.width=vals[2]+"%";

  $("beginnerExplanation").textContent=beginnerExplanation(a);
  $("chartCalloutTitle").textContent=copy.title;
  const productionId=modelLabData?.production?.modelId||status?.modelLab?.production?.modelId||null;
  $("chartCalloutBody").textContent=a
    ? `${sourceName()} data · ${productionId?("production "+productionId):("legacy fallback v"+(status?.model?.version||"—"))} · prediction stored before result.`
    : (!status?.configured?"No real provider is connected. No forecast is being generated.":"Collecting enough real bars to begin.");

  const reasons=$("reasonList");
  reasons.innerHTML="";
  if (!a) {
    reasons.innerHTML=`<div class="reason-item"><span class="reason-dot mixed"></span><div class="reason-copy"><strong>No synthetic fallback</strong><span>${status?.configured?"Waiting for sufficient real market history.":"Add real provider credentials to begin ingestion."}</span></div><span class="reason-value">—</span></div>`;
    return;
  }
  const broad=scannerData.regime||null;
  if (broad?.regime) {
    const item=document.createElement("div");
    item.className="reason-item";
    item.innerHTML=`<span class="reason-dot mixed"></span><div class="reason-copy"><strong>Broad U.S. market regime</strong><span>${String(broad.regime).replaceAll("_"," ")} from the completed whole-market scan dated ${broad.scan_date}.</span></div><span class="reason-value">${Math.round(Number(broad.confidence||0)*100)}%</span>`;
    reasons.appendChild(item);
  }

  for (const c of a.contributions.slice(0,4)) {
    const label=FEATURE_LABELS[c.key] || {title:c.key,positive:"Positive contribution.",negative:"Negative contribution."};
    const statusClass=Math.abs(c.contribution)<.08?"mixed":c.contribution>0?"good":"bad";
    const explanation=simpleReasons
      ? (c.value>=0?label.positive:label.negative)
      : c.source==="ml"
        ? `Real feature ${c.value>=0?"+":""}${Number(c.value).toFixed(2)} · local model influence ${c.contribution>=0?"+":""}${Number(c.contribution).toFixed(3)}.`
        : `Real feature ${c.value>=0?"+":""}${Number(c.value).toFixed(2)} × learned weight ${Number(c.weight).toFixed(2)}.`;
    const item=document.createElement("div");
    item.className="reason-item";
    item.innerHTML=`<span class="reason-dot ${statusClass}"></span><div class="reason-copy"><strong>${label.title}</strong><span>${explanation}</span></div><span class="reason-value">${c.contribution>=0?"+":""}${Number(c.contribution).toFixed(2)}</span>`;
    reasons.appendChild(item);
  }
}

function renderChart() {
  const rows=aggregateBars(snapshot.bars||[],timeframe);
  const a=normalizeAnalysis(snapshot.analysis);
  chart.showForecast=forecastOn && Boolean(a);
  chart.showBeginner=beginnerOn;
  chart.setData({candles:rows,analysis:a,predictions:chartPredictions(snapshot.predictions),timeframe});

  const trade=snapshot.trades?.[0]||null;
  const bar=snapshot.bars?.at(-1)||null;
  const price=currentRealPrice();
  $("symbolName").textContent=activeSymbol;
  const feed=activeFeed();
  const overnightNote=feed==="overnight"?" · indicative quotes / delayed trades":"";
  $("symbolDescription").textContent=`${NAMES[activeSymbol]||activeSymbol} · ${sourceName()} · REAL${overnightNote}`;
  $("lastPrice").textContent=price==null?"—":price.toFixed(2);
  const q=snapshot.quote;
  if (feed==="overnight" && q && Number.isFinite(Number(q.bidPrice)) && Number.isFinite(Number(q.askPrice))) {
    $("priceChange").textContent=`indicative quote midpoint · ${safeTime(q.ts)}`;
  } else {
    $("priceChange").textContent=trade?`last trade · ${safeTime(trade.ts)}`:(bar?`1m close · ${safeTime(bar.ts)}`:"no real price");
  }
  $("priceChange").className="price-change neutral";

  $("vwapValue").textContent=bar?.vwap==null?"—":Number(bar.vwap).toFixed(2);
  $("volumeValue").textContent=bar?num(bar.volume):"—";
  const spread=q && Number.isFinite(Number(q.askPrice)) && Number.isFinite(Number(q.bidPrice))
    ? Number(q.askPrice)-Number(q.bidPrice):null;
  $("spreadValue").textContent=spread==null?"—":"$"+spread.toFixed(3);
}

function renderTapeAndBook() {
  const trades=snapshot.trades||[];
  $("tapeBody").innerHTML=trades.length?trades.slice(0,40).map(t=>`
    <tr>
      <td>${safeTime(t.ts)}</td>
      <td>${Number(t.price).toFixed(2)}</td>
      <td>${num(t.size)}</td>
      <td>${activeFeed()==="overnight"?(t.exchange||"—")+" · 15m delay":(t.exchange||"—")}</td>
    </tr>`).join(""):`<tr><td colspan="4">No real trades received for this symbol yet.</td></tr>`;

  const q=snapshot.quote;
  if (!q) {
    $("bidBook").innerHTML='<div class="book-row"><span>—</span><span>—</span><span>No real quote</span></div>';
    $("askBook").innerHTML='<div class="book-row"><span>—</span><span>—</span><span>No real quote</span></div>';
  } else {
    $("bidBook").innerHTML=`<div class="book-row"><span class="positive">${Number(q.bidPrice).toFixed(2)}</span><span>${num(q.bidSize)}</span><span>${q.bidExchange||"—"}</span></div>`;
    $("askBook").innerHTML=`<div class="book-row"><span class="negative">${Number(q.askPrice).toFixed(2)}</span><span>${num(q.askSize)}</span><span>${q.askExchange||"—"}</span></div>`;
  }
}

function renderPaper() {
  const p=paperData||{};
  $("paperEquity").textContent=money(p.equity);
  $("paperCash").textContent=money(p.cash);
  $("openPnl").textContent=money(p.openPnl);
  $("realizedPnl").textContent=money(p.realizedPnl);
  $("paperTrades").textContent=num(p.fillCount||0);
  $("paperClosedOutcomes").textContent=num(p.closedOutcomes||0);
  $("paperWinRate").textContent=p.winRate==null?"—":pct(Number(p.winRate));
  $("paperProfitFactor").textContent=p.profitFactor==null?"—":(Number.isFinite(Number(p.profitFactor))?Number(p.profitFactor).toFixed(2):"∞");
  $("paperMaxDrawdown").textContent=p.maxDrawdown==null?"—":pct(Number(p.maxDrawdown));
  const avgWinner=p.avgWinner==null?null:Number(p.avgWinner);
  const avgLoser=p.avgLoser==null?null:Number(p.avgLoser);
  $("paperAvgWinLoss").textContent=avgWinner==null&&avgLoser==null
    ?"—"
    :`${avgWinner==null?"—":money(avgWinner)} / ${avgLoser==null?"—":money(avgLoser)}`;
  $("openPnl").className=Number(p.openPnl)>0?"positive":Number(p.openPnl)<0?"negative":"neutral";
  $("realizedPnl").className=Number(p.realizedPnl)>0?"positive":Number(p.realizedPnl)<0?"negative":"neutral";
  $("paperWinRate").className=Number(p.winRate)>=.5?"positive":"neutral";
  $("paperMaxDrawdown").className=Number(p.maxDrawdown)<-.05?"negative":"neutral";
  if ($("autopilotToggle")) $("autopilotToggle").checked=Boolean(p.autopilotEnabled);
  $("positionsTable").innerHTML=(p.positions||[]).length?p.positions.map(pos=>`
    <div class="position-row">
      <strong>${pos.symbol}</strong><span>${pos.qty>0?"LONG":"SHORT"}</span>
      <span>${Math.abs(pos.qty)} shares</span><span>Avg ${Number(pos.avgPrice).toFixed(2)}</span>
      <span>Mark ${Number(pos.mark).toFixed(2)}</span>
      <strong class="${Number(pos.pnl)>0?"positive":Number(pos.pnl)<0?"negative":"neutral"}">${money(pos.pnl)}</strong>
    </div>`).join(""):`No open server-side paper positions. Fill model: ${p.fillModel||"waiting for broker"}.`;

  if ($("paperFillModel")) $("paperFillModel").textContent=p.fillModel||"Waiting for server broker";
  if ($("paperFillBody")) {
    const fills=Array.isArray(p.fills)?p.fills:[];
    $("paperFillBody").innerHTML=fills.length?fills.slice(0,40).map(fill=>`
      <tr>
        <td>${safeTime(fill.createdAt)}</td>
        <td><strong>${fill.symbol}</strong></td>
        <td class="${fill.side==="BUY"?"positive":"negative"}">${fill.side}</td>
        <td>${num(fill.qty)}</td>
        <td>${Number(fill.fillPrice).toFixed(2)}</td>
        <td>${fill.marketBid==null?"—":Number(fill.marketBid).toFixed(2)}</td>
        <td>${fill.marketAsk==null?"—":Number(fill.marketAsk).toFixed(2)}</td>
        <td class="${Number(fill.realizedPnl)>0?"positive":Number(fill.realizedPnl)<0?"negative":"neutral"}">${money(fill.realizedPnl||0)}</td>
      </tr>`).join(""):`<tr><td colspan="8">No deterministic server fills yet.</td></tr>`;
  }
}

function renderLearning() {
  const s=predictionData.stats;
  const production=modelLabData?.production||predictionData.modelLab?.production||null;
  const live=production?.liveMetrics||{};
  $("accuracyValue").textContent=Number(live.samples)>0?pct(Number(live.accuracy)):"Waiting live proof";
  $("predictionCount").textContent=num(s?.predictions||0);
  $("scoredCount").textContent=num(live.samples||0);
  $("highConfidenceAccuracy").textContent=Number(live.samples)>0?Number(live.ece||0).toFixed(4):"—";

  const testAcc=production?.testMetrics?.accuracy;
  const liveBrier=Number(live.samples)>0?live.brier:null;
  $("historicalHoldoutAccuracy").textContent=testAcc==null?"No production model":pct(testAcc);
  $("learningUpdates").textContent=liveBrier==null?"—":Number(liveBrier).toFixed(4);

  if ($("modelLabSummary")) {
    const run=modelLabData?.latestRun||predictionData.modelLab?.latestRun||null;
    const wf=production?.walkForwardMetrics||{};
    const challengers=modelLabData?.shadowModels||[];
    $("modelLabSummary").innerHTML=production
      ? `<strong>Production: ${production.modelId}</strong><br>${production.family} · test ${pct(Number(production.testMetrics?.accuracy||0))} · walk-forward ${wf.accuracy==null?"—":pct(Number(wf.accuracy))} · ${num(wf.folds?.length||0)} folds · live shadow challengers ${challengers.length}.<br>${run?.promotionReason||"Production remains locked until a challenger proves better on future paired outcomes."}`
      : `<strong>Model Lab is building the first production model.</strong><br>Predictions stay on the legacy fallback until a challenger passes calibration, unseen-test, walk-forward and final-holdout guards.`;
  }

  if ($("shadowModelBody")) {
    const challengers=modelLabData?.shadowModels||predictionData.modelLab?.shadowModels||[];
    $("shadowProofTitle").textContent=challengers.length
      ? `${challengers.length} challenger${challengers.length===1?"":"s"} collecting future outcomes`
      : "No challenger in live shadow";
    $("shadowModelBody").innerHTML=challengers.length?challengers.map(c=>{
      const live=c.liveMetrics||{};
      const test=c.testMetrics||{};
      return `<tr>
        <td><strong>${c.modelId||"—"}</strong></td>
        <td>${c.family||"—"}</td>
        <td>${num(live.samples||0)}</td>
        <td>${Number(live.samples)>0?pct(Number(live.accuracy||0)):"—"}</td>
        <td>${Number(live.samples)>0?Number(live.brier||0).toFixed(4):"—"}</td>
        <td>${Number(live.samples)>0?Number(live.ece||0).toFixed(4):"—"}</td>
        <td>${test.accuracy==null?"—":pct(Number(test.accuracy))}</td>
        <td>LIVE SHADOW</td>
      </tr>`;
    }).join(""):`<tr><td colspan="8">No challenger is currently eligible for live shadow.</td></tr>`;
  }

  const rows=predictionData.rows||[];
  $("predictionBody").innerHTML=rows.length?rows.map(p=>`
    <tr>
      <td>${safeTime(p.created_at)}</td>
      <td><strong>${p.symbol}</strong></td>
      <td class="${p.direction==="UP"?"positive":p.direction==="DOWN"?"negative":"neutral"}">${p.direction}</td>
      <td>${Math.round(Number(p.confidence)*100)}%</td>
      <td class="${p.status==="PENDING"?"neutral":p.correct?"positive":"negative"}">${p.status==="PENDING"?"PENDING":p.correct?"✓ "+p.actual_direction:"✕ "+p.actual_direction}</td>
    </tr>`).join(""):`<tr><td colspan="5">No real-data predictions have been recorded yet.</td></tr>`;
}

function renderPatternLab() {
  if (!$("patternLabSymbol")) return;
  const p=patternLabData||{};
  const ready=p.status==="READY";
  $("patternLabSymbol").textContent=p.symbol||activeSymbol;
  $("patternLabStatus").textContent=ready
    ? `${num(p.exactMatches||0)} exact/coarse fingerprint matches · ${num(p.analyzedCount||0)} close analogs analyzed`
    : "Building/loading 90-day real minute history and pattern memory…";
  $("patternFingerprint").textContent=p.fingerprint||"—";
  $("patternMatchSummary").textContent=p.analogs?.length
    ? `Showing ${p.analogs.length} closest real historical analogs`
    : "No historical analogs available yet";

  const renderHorizon=(h)=>{
    const s=p.statsByHorizon?.[h];
    const leadEl=$("pattern"+h+"Lead");
    const statEl=$("pattern"+h+"Stats");
    if (!s?.samples) {
      leadEl.textContent="—";
      statEl.textContent="No usable historical analogs yet";
      return;
    }
    const options=[
      ["UP",Number(s.upRate||0)],
      ["FLAT",Number(s.flatRate||0)],
      ["DOWN",Number(s.downRate||0)]
    ].sort((a,b)=>b[1]-a[1]);
    leadEl.textContent=`${options[0][0]} ${Math.round(options[0][1]*100)}%`;
    leadEl.className=options[0][0]==="UP"?"positive":options[0][0]==="DOWN"?"negative":"neutral";
    const avg=Number(s.avgReturn||0);
    statEl.textContent=`${num(s.samples)} analogs · avg ${avg>=0?"+":""}${pct(avg)} · MFE ${pct(Number(s.avgMfe||0))} · MAE ${pct(Number(s.avgMae||0))}`;
  };
  [15,30,60].forEach(renderHorizon);

  const analogs=Array.isArray(p.analogs)?p.analogs:[];
  $("patternAnalogBody").innerHTML=analogs.length
    ? analogs.map(a=>{
        const h15=a.horizons?.[15];
        const h30=a.horizons?.[30];
        const h60=a.horizons?.[60];
        const fmtRet=(h)=>h?((Number(h.return)>=0?"+":"")+pct(Number(h.return))):"—";
        const d=new Date(a.time);
        const when=Number.isNaN(+d)?"—":d.toLocaleString([],{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"});
        return `<tr>
          <td>${when}</td>
          <td class="${Number(a.similarity)>=.8?"similarity-high":""}">${Math.round(Number(a.similarity||0)*100)}%${a.exact?" · exact":""}</td>
          <td>${Number(a.entryPrice||0).toFixed(2)}</td>
          <td class="${h15?.return>0?"positive":h15?.return<0?"negative":"neutral"}">${fmtRet(h15)}</td>
          <td class="${h30?.return>0?"positive":h30?.return<0?"negative":"neutral"}">${fmtRet(h30)}</td>
          <td class="${h60?.return>0?"positive":h60?.return<0?"negative":"neutral"}">${fmtRet(h60)}</td>
          <td class="positive">${h15?pct(Number(h15.mfe||0)):"—"}</td>
          <td class="negative">${h15?pct(Number(h15.mae||0)):"—"}</td>
        </tr>`;
      }).join("")
    : '<tr><td colspan="8">Pattern Lab is waiting for enough real historical data for this symbol.</td></tr>';
}

function renderScanner() {
  if (!$("scannerBody")) return;
  const universe=scannerData.universe||{};
  const scan=scannerData.scan||null;
  const candidates=Array.isArray(scannerData.candidates)?scannerData.candidates:[];

  $("universeAssetCount").textContent=num(universe.dataSupported||universe.active||0);
  $("scannerDate").textContent=scan?.scan_date?String(scan.scan_date).slice(0,10):"—";
  $("scannerStatus").textContent=scan
    ? `${scan.status||"UNKNOWN"} · broad ${num(scan.assets_scanned||0)} · deep ${num(scan.deep_assets||0)} · ${num(scan.deep_bars||0)} 5m bars`
    : "Waiting for first full-market scan";
  $("hotSetCount").textContent=num((scannerData.hotSymbols||[]).length);

  const regime=scannerData.regime||null;
  $("broadRegime").textContent=regime?.regime?String(regime.regime).replaceAll("_"," "):"—";
  $("broadRegimeMeta").textContent=regime
    ? `as of ${regime.scan_date} · ${Math.round(Number(regime.confidence||0)*100)}% classifier confidence`
    : "Waiting for completed scan";

  $("scannerBody").innerHTML=candidates.length
    ? candidates.map((r,i)=>`
      <tr data-symbol="${r.symbol}">
        <td>${i+1}</td>
        <td><strong>${r.symbol}</strong></td>
        <td>${r.name||"—"}</td>
        <td class="${Number(r.return_1d)>0?"positive":Number(r.return_1d)<0?"negative":"neutral"}">${pct(Number(r.return_1d)||0)}</td>
        <td class="${Number(r.return_5d)>0?"positive":Number(r.return_5d)<0?"negative":"neutral"}">${pct(Number(r.return_5d)||0)}</td>
        <td class="${Number(r.return_20d)>0?"positive":Number(r.return_20d)<0?"negative":"neutral"}">${pct(Number(r.return_20d)||0)}</td>
        <td>${Number(r.relative_volume||0).toFixed(2)}×</td>
        <td>${Number(r.interesting_score||0).toFixed(2)}</td>
        <td>${r.deep_score==null?"—":Number(r.deep_score).toFixed(2)}</td>
        <td>${Array.isArray(r.attention_reasons)&&r.attention_reasons.length?r.attention_reasons.join(" · "):"—"}</td>
      </tr>`).join("")
    : '<tr><td colspan="10">Trading Eye has not completed a whole-market scan yet.</td></tr>';
}

function renderResearchBrain() {
  if (!$("researchState")) return;
  const r=researchData||{};
  const coverage=r.coverage||{};
  const intraday=coverage.intraday||{};
  const longHistory=coverage.longHistory||{};
  const findings=coverage.findings||{};
  const models=coverage.models||{};
  const jobs=Array.isArray(r.jobs)?r.jobs:[];
  const events=Array.isArray(r.events)?r.events:[];
  const patternFindings=Array.isArray(r.findings)?r.findings:[];

  const runningJobs=jobs.filter(j=>j.status==="RUNNING");
  const errorJobs=jobs.filter(j=>j.status==="ERROR");
  const current=runningJobs.find(j=>j.job_key!=="research-brain-heartbeat")||runningJobs[0]||null;

  const stateText=errorJobs.length
    ? "Research Brain running with an error to inspect"
    : runningJobs.length
      ? "Research Brain is working now"
      : "Research Brain monitoring continuously";
  $("researchState").textContent=stateText;
  if ($("researchTopState")) {
    $("researchTopState").textContent=errorJobs.length
      ? "AI RESEARCH NEEDS ATTENTION"
      : runningJobs.length
        ? "AI RESEARCH WORKING"
        : "AI RESEARCH LIVE";
    $("researchTopBtn")?.classList.toggle("error",Boolean(errorJobs.length));
  }
  $("researchPulse").classList.toggle("research-error",Boolean(errorJobs.length));
  $("researchCurrentTask").textContent=current
    ? `${String(current.job_type||"research").replaceAll("_"," ")} · ${String(current.phase||current.status||"running").replaceAll("_"," ")} · ${num(current.bars_processed||0)} bars processed`
    : "No heavy job is running this second. Live observation, model shadow scoring, and research monitoring remain active.";
  $("researchHeartbeat").textContent=r.heartbeatAt
    ? ageText(r.heartbeatAt)
    : r.lastResearchEventAt
      ? ageText(r.lastResearchEventAt)
      : "starting";

  const intradayFirst=intraday.first?String(intraday.first).slice(0,10):"—";
  const intradayLast=intraday.last?String(intraday.last).slice(0,10):"—";
  $("researchIntradayCoverage").textContent=`${num(intraday.bars||0)} bars`;
  $("researchIntradayMeta").textContent=`${num(intraday.symbols||0)} symbols · ${intradayFirst} → ${intradayLast} · Alpaca`;

  const longFirst=longHistory.first?String(longHistory.first).slice(0,10):"not loaded";
  const longLast=longHistory.last?String(longHistory.last).slice(0,10):"—";
  $("researchLongCoverage").textContent=Number(longHistory.bars)
    ? `${num(longHistory.bars)} bars`
    : "1999+ waiting";
  $("researchLongMeta").textContent=Number(longHistory.bars)
    ? `${num(longHistory.symbols||0)} symbols · ${longFirst} → ${longLast} · ${r.sources?.longHistory?.provider||"long-history source"}`
    : `${r.sources?.longHistory?.provider||"long-history source"} · target ${r.sources?.longHistory?.targetStart||"1999-01-01"}`;

  $("researchFindingCount").textContent=num(findings.findings||0);
  $("researchFindingMeta").textContent=`${num(findings.promoted||0)} promoted research findings · ${num((coverage.predictions||{}).scored||0)} predictions scored`;

  $("researchModelCount").textContent=num(models.models||0);
  $("researchModelMeta").textContent=`${num(models.production||0)} production · ${num(models.shadow||0)} live shadow · ${num(models.rejected||0)} rejected`;

  $("researchJobSummary").textContent=`${runningJobs.length} running · ${errorJobs.length} errors · ${jobs.length} tracked`;
  $("researchJobs").innerHTML=jobs.length?jobs.map(j=>{
    const progress=clamp(Number(j.progress)||0,0,1);
    const status=String(j.status||"UNKNOWN").toLowerCase();
    const done=Number(j.items_done)||0;
    const total=j.items_total==null?null:Number(j.items_total);
    const bars=Number(j.bars_processed)||0;
    return `<div class="research-job">
      <div class="research-job-top">
        <div class="research-job-name">
          <strong>${String(j.job_type||j.job_key||"research").replaceAll("_"," ")}</strong>
          <span>${String(j.phase||"").replaceAll("_"," ")} · ${j.provider||"internal"}</span>
        </div>
        <span class="research-job-status ${status}">${j.status||"—"}</span>
        <span class="research-job-progress-value">${Math.round(progress*100)}%</span>
      </div>
      <div class="research-job-bar"><span style="width:${Math.max(progress*100,j.status==="RUNNING"?2:0)}%"></span></div>
      <div class="research-job-meta">
        <span>${bars?num(bars)+" bars":"monitoring"}</span>
        <span>${total?num(done)+" / "+num(total)+" items":done?num(done)+" items":""}</span>
        <span>updated ${ageText(j.updated_at)}</span>
        ${j.error?`<span class="negative">${j.error}</span>`:""}
      </div>
    </div>`;
  }).join(""):'<div class="research-job"><div class="research-job-name"><strong>No jobs recorded yet</strong><span>Research worker is initializing.</span></div></div>';

  $("researchEventCount").textContent=`${num(events.length)} events`;
  $("researchEventStream").innerHTML=events.length?events.slice(-120).reverse().map(e=>{
    const level=String(e.level||"INFO").toLowerCase();
    const d=new Date(e.event_ts);
    const when=Number.isNaN(+d)?"—":d.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",second:"2-digit"});
    return `<div class="research-event ${level}">
      <span class="research-event-time">${when}</span>
      <span class="research-event-category">${e.category||"SYSTEM"}</span>
      <span class="research-event-message"><strong>${e.title||"Research"}</strong>${e.message||""}</span>
    </div>`;
  }).join(""):'<div class="research-event"><span class="research-event-time">—</span><span class="research-event-category">SYSTEM</span><span class="research-event-message">Waiting for first research event.</span></div>';

  $("researchFindingBody").innerHTML=patternFindings.length?patternFindings.map(f=>{
    const evidence=f.evidence||{};
    return `<tr class="${String(f.status||"candidate").toLowerCase()}">
      <td>${f.status||"CANDIDATE"}</td>
      <td><strong>${f.symbol||"MARKET"}</strong></td>
      <td>${f.description||f.pattern_key||"—"}</td>
      <td>${num(f.horizon_days)}d</td>
      <td>${num(f.sample_count)}</td>
      <td>${f.hit_rate==null?"—":pct(Number(f.hit_rate))}</td>
      <td class="${Number(f.avg_forward_return)>0?"positive":Number(f.avg_forward_return)<0?"negative":"neutral"}">${f.avg_forward_return==null?"—":(Number(f.avg_forward_return)>=0?"+":"")+pct(Number(f.avg_forward_return))}</td>
      <td>${Number(f.score||0).toFixed(2)}</td>
      <td>${evidence.start||"—"} → ${evidence.end||"—"}</td>
    </tr>`;
  }).join(""):'<tr><td colspan="9">No 1999+ research findings yet. The long-history lane must ingest data before pattern mining can begin.</td></tr>';
}

function renderDeepStudy() {
  if (!$("deepStudyState")) return;
  const state=studyData.status||{};
  const pattern=state.patternState||{};
  const latest=(studyData.rows||[])[0]||null;

  let label="Waiting";
  if (state.running) label="Studying now";
  else if (pattern.state==="BUILDING") label="Building 90-day memory";
  else if (latest?.status==="COMPLETE") label="Study complete";
  else if (pattern.state==="COMPLETE") label="Pattern memory ready";

  $("deepStudyState").textContent=label;
  $("deepStudyDate").textContent=latest
    ? `${String(latest.study_date).slice(0,10)} · ${String(latest.stage||"regular_close").replaceAll("_"," ")}`
    : pattern.lastBuiltAt
      ? "Pattern memory built "+safeTime(pattern.lastBuiltAt)
      : "Waiting for a completed market session";

  const findings=latest?.pattern_findings||{};
  $("patternMemoryCount").textContent=num(pattern.patterns||findings.memorySize||0);
  $("deepStudyBars").textContent=num(latest?.market?.totalBars||0);
  $("deepStudyPredictions").textContent=num(latest?.prediction_review?.scored||0);
  $("deepStudyAnalogs").textContent=num(Array.isArray(latest?.analogs)?latest.analogs.length:0);

  const lessons=Array.isArray(latest?.lessons)?latest.lessons:[];
  $("deepStudyLessons").innerHTML=lessons.length
    ? lessons.slice(0,6).map(x=>`<div class="study-item">${x.text||"Study result recorded."}</div>`).join("")
    : `<div class="study-item">${state.running?"Trading Eye is studying the completed session now.":"The next completed daily study will appear here."}</div>`;

  const patterns=Array.isArray(findings.strongest)?findings.strongest:[];
  $("deepStudyPatterns").innerHTML=patterns.length
    ? patterns.slice(0,6).map(p=>{
        const up=Math.round(Number(p.upRate||0)*100);
        const down=Math.round(Number(p.downRate||0)*100);
        return `<div class="study-item"><strong>${p.symbol} · ${p.horizonMinutes}m</strong> · ${num(p.samples)} matches · ↑ ${up}% / ↓ ${down}%</div>`;
      }).join("")
    : `<div class="study-item">${pattern.state==="BUILDING"?"Scanning the 90-day real market history for repeating setups…":"No sufficiently repeated pattern has been promoted yet."}</div>`;
}

function renderAll() {
  renderStatus();
  renderBeginnerCommandCenter();
  renderWatchlist();
  renderAI();
  renderChart();
  renderTapeAndBook();
  renderPaper();
  renderLearning();
  renderPatternLab();
  renderScanner();
  renderResearchBrain();
  renderDeepStudy();
}

async function refreshAll({quiet=false}={}) {
  try {
    const [st,wl,snap,preds,studies,scanner,paperState,lab,research,proof]=await Promise.all([
      client.status(),client.watchlist(),client.snapshot(activeSymbol),client.predictions(),
      client.studies(10),client.scanner(50),client.paper(),client.modelLab(),client.research(),
      client.proofScoreboard()
    ]);
    status=st; watchlist=wl; snapshot=snap; predictionData=preds; studyData=studies; scannerData=scanner;
    paperData=paperState; modelLabData=lab; researchData=research; proofData=proof;
    monitoredSymbols=(wl.rows||[]).map(x=>x.symbol);
    if (!monitoredSymbols.length) monitoredSymbols=st.symbols||monitoredSymbols;
    renderAll();
    client.patternLab(activeSymbol,40)
      .then(p=>{patternLabData=p;renderPatternLab();})
      .catch(()=>{});
    if (!quiet) toast(st.configured?`Connected: ${sourceName()}`:"Backend online; real market provider still needs credentials.");
  } catch (err) {
    if (!quiet) toast("Real-data backend error: "+String(err.message||err));
    $("feedStatus").textContent="BACKEND UNAVAILABLE";
  }
}

async function selectSymbol(symbol,{activate=true}={}) {
  symbol=String(symbol||"").trim().toUpperCase();
  if (!symbol) return;
  try {
    if (activate || !monitoredSymbols.includes(symbol)) {
      const activated=await client.activate(symbol);
      monitoredSymbols=activated.hotSymbols||monitoredSymbols;
      watchlist=await client.watchlist();
    }
    activeSymbol=symbol;
    $("symbolInput").value=symbol;
    $("symbolResults").classList.add("hidden");
    snapshot=await client.snapshot(symbol);
    patternLabData={symbol,status:"BUILDING_HISTORY",statsByHorizon:{},analogs:[]};
    renderAll();
    client.patternLab(symbol,40)
      .then(p=>{
        if (activeSymbol===symbol) {
          patternLabData=p;
          renderPatternLab();
        }
      })
      .catch(()=>{});
    return true;
  } catch (err) {
    toast(String(err.message||err));
    return false;
  }
}

async function loadSymbol() {
  const raw=$("symbolInput").value.trim();
  if (!raw) return;
  const ticker=raw.toUpperCase();
  const direct=await selectSymbol(ticker,{activate:true});
  if (direct) return;
  try {
    const found=await client.searchAssets(raw,10);
    const first=found.rows?.find(x=>x.data_supported!==false);
    if (!first) throw new Error("No supported US stock found for "+raw);
    await selectSymbol(first.symbol,{activate:true});
  } catch(err) {
    toast(String(err.message||err));
    $("symbolInput").value=activeSymbol;
  }
}

function applyRealtime(event) {
  if (event.type==="status") {
    status={...(status||{}),...event.data};
    renderStatus(); renderBeginnerCommandCenter(); renderAI();
    return;
  }
  const d=event.data;
  if (!d || d.symbol!==activeSymbol) {
    if (event.type==="bar") client.watchlist().then(w=>{watchlist=w;renderWatchlist();}).catch(()=>{});
    return;
  }
  if (event.type==="quote") snapshot.quote=d;
  if (event.type==="trade") {
    snapshot.trades=[d,...(snapshot.trades||[]).filter(x=>x.id!==d.id)].slice(0,150);
  }
  if (event.type==="bar") {
    const rows=(snapshot.bars||[]).filter(x=>+new Date(x.ts)!==+new Date(d.ts));
    rows.push(d); rows.sort((a,b)=>+new Date(a.ts)-+new Date(b.ts));
    snapshot.bars=rows.slice(-1200);
    client.snapshot(activeSymbol)
      .then(s=>{
        snapshot=s;
        renderAll();
        client.patternLab(activeSymbol,40)
          .then(p=>{patternLabData=p;renderPatternLab();})
          .catch(()=>{});
      })
      .catch(()=>{});
  }
  if (event.type==="prediction" || event.type==="prediction_scored") {
    client.predictions().then(p=>{predictionData=p;renderLearning();}).catch(()=>{});
    client.snapshot(activeSymbol).then(s=>{snapshot=s;renderAI();renderChart();}).catch(()=>{});
  }
  if (event.type==="deep_study_status" || event.type==="deep_study_complete") {
    client.studies(10).then(s=>{studyData=s;renderDeepStudy();}).catch(()=>{});
  }
  if (event.type==="research_event") {
    const ev=event.data;
    researchData.events=[...(researchData.events||[]).filter(x=>x.id!==ev?.id),ev].filter(Boolean).slice(-180);
    researchData.lastResearchEventAt=ev?.event_ts||new Date().toISOString();
    renderResearchBrain();
    renderBeginnerCommandCenter();
    return;
  }
  if (event.type==="research_status") {
    researchData={...researchData,...event.data};
    renderResearchBrain();
    return;
  }
  renderChart(); renderTapeAndBook(); renderPaper();
}

function setTour(open,markSeen=false) {
  const panel=$("tourPanel");
  if (!panel) return;
  panel.classList.toggle("hidden",!open);
  document.body.style.overflow=open?"hidden":"";
  if (markSeen) try { localStorage.setItem("trading-eye-tour-seen-real","1"); } catch {}
}

$("researchTopBtn")?.addEventListener("click",openResearchFocus);
$("beginnerResearchBtn")?.addEventListener("click",openResearchFocus);
$("researchCloseBtn")?.addEventListener("click",closeResearchFocus);
$("loadSymbolBtn").addEventListener("click",loadSymbol);
$("symbolInput").addEventListener("keydown",e=>{
  if(e.key==="Enter") loadSymbol();
  if(e.key==="Escape") $("symbolResults").classList.add("hidden");
});
$("symbolInput").addEventListener("input",e=>{
  clearTimeout(symbolSearchTimer);
  const q=e.target.value.trim();
  if (q.length<1) {
    $("symbolResults").classList.add("hidden");
    return;
  }
  symbolSearchTimer=setTimeout(async()=>{
    try {
      const found=await client.searchAssets(q,12);
      lastSymbolResults=found.rows||[];
      const box=$("symbolResults");
      if (!lastSymbolResults.length) {
        box.innerHTML='<div class="symbol-result disabled"><span>No matching US stocks</span></div>';
        box.classList.remove("hidden");
        return;
      }
      box.innerHTML=lastSymbolResults.map((a,i)=>`
        <div class="symbol-result ${a.data_supported===false?"disabled":""}" data-result-index="${i}">
          <strong>${a.symbol}</strong>
          <span>${a.name||"US equity"}</span>
          <em>${a.exchange||""}${a.data_supported===false?" · unavailable on free feed":""}</em>
        </div>`).join("");
      box.classList.remove("hidden");
    } catch {}
  },180);
});
$("symbolResults").addEventListener("click",e=>{
  const row=e.target.closest("[data-result-index]");
  if (!row) return;
  const asset=lastSymbolResults[Number(row.dataset.resultIndex)];
  if (!asset || asset.data_supported===false) return;
  selectSymbol(asset.symbol,{activate:true});
});
document.addEventListener("click",e=>{
  if (!e.target.closest(".symbol-search-wrap")) $("symbolResults").classList.add("hidden");
});
$("timeframes").addEventListener("click",e=>{
  const btn=e.target.closest("button[data-tf]");
  if (!btn) return;
  timeframe=btn.dataset.tf;
  document.querySelectorAll("#timeframes button").forEach(x=>x.classList.toggle("active",x===btn));
  renderChart();
});
$("pauseBtn").addEventListener("click",()=>refreshAll());
$("predictionToggle").addEventListener("click",e=>{
  forecastOn=!forecastOn;
  e.currentTarget.classList.toggle("active",forecastOn);
  e.currentTarget.innerHTML=`<span class="toolbar-dot ai"></span>${forecastOn?"AI forecast on":"AI forecast off"}`;
  renderChart();
});
$("beginnerToggle").addEventListener("click",e=>{
  beginnerOn=!beginnerOn;
  e.currentTarget.classList.toggle("active",beginnerOn);
  e.currentTarget.innerHTML=`<span class="toolbar-dot beginner"></span>${beginnerOn?"Beginner labels on":"Beginner labels off"}`;
  $("aiChartCallout").style.display=beginnerOn?"":"none";
});
$("simplifyBtn").addEventListener("click",()=>{
  simpleReasons=!simpleReasons;
  $("simplifyBtn").textContent=simpleReasons?"Show model math":"Explain simply";
  renderAI();
});
$("autopilotToggle").addEventListener("change",async e=>{
  try{
    paperData=await client.setPaperAutopilot(e.target.checked);
    renderPaper();
    toast(e.target.checked
      ?"Server AI paper autopilot enabled. It will keep running with this tab closed."
      :"Server AI paper autopilot disabled.");
  }catch(err){
    e.target.checked=!e.target.checked;
    toast(String(err.message||err));
  }
});
$("paperBuyBtn").addEventListener("click",async()=>{
  try{
    const fill=await client.paperOrder({symbol:activeSymbol,side:"BUY",source:"MANUAL_PAPER"});
    toast(`Paper BUY filled ${fill.qty} ${activeSymbol} @ ${Number(fill.fillPrice).toFixed(2)} using ${fill.fillModel}.`);
    paperData=await client.paper();
    renderPaper();
  }catch(err){ toast(String(err.message||err)); }
});
$("paperSellBtn").addEventListener("click",async()=>{
  try{
    const fill=await client.paperOrder({symbol:activeSymbol,side:"SELL",source:"MANUAL_PAPER"});
    toast(`Paper SELL filled ${fill.qty} ${activeSymbol} @ ${Number(fill.fillPrice).toFixed(2)} using ${fill.fillModel}.`);
    paperData=await client.paper();
    renderPaper();
  }catch(err){ toast(String(err.message||err)); }
});
$("flattenBtn").addEventListener("click",async()=>{
  try{
    const fill=await client.flattenPaper(activeSymbol);
    toast(fill.ok
      ? `Paper position flattened @ ${Number(fill.fillPrice).toFixed(2)}.`
      :"No open paper position in "+activeSymbol+".");
    paperData=await client.paper();
    renderPaper();
  }catch(err){ toast(String(err.message||err)); }
});
$("scannerBody")?.addEventListener("click",e=>{
  const row=e.target.closest("tr[data-symbol]");
  if (!row) return;
  selectSymbol(row.dataset.symbol,{activate:true});
});

$("lowerTabs").addEventListener("click",e=>{
  const btn=e.target.closest("button[data-tab]");
  if (!btn) return;
  document.querySelectorAll("#lowerTabs button").forEach(x=>x.classList.toggle("active",x===btn));
  document.querySelectorAll(".tab-pane").forEach(x=>x.classList.remove("active"));
  $("tab-"+btn.dataset.tab).classList.add("active");
});
$("helpBtn").addEventListener("click",()=>setTour(true));
$("tourCloseBtn").addEventListener("click",()=>setTour(false,true));
$("tourDoneBtn").addEventListener("click",()=>setTour(false,true));
document.querySelectorAll("[data-tour-close]").forEach(el=>el.addEventListener("click",()=>setTour(false,true)));
document.addEventListener("keydown",e=>{
  if(e.key!=="Escape") return;
  if(document.body.classList.contains("research-focus")) return closeResearchFocus();
  if(!$("tourPanel").classList.contains("hidden")) setTour(false,true);
});

client.on(applyRealtime);
client.connect();
await refreshAll({quiet:true});
clearInterval(refreshTimer);
refreshTimer=setInterval(()=>refreshAll({quiet:true}),30000);
clearInterval(researchTimer);
researchTimer=setInterval(()=>{
  client.research()
    .then(r=>{researchData=r;renderResearchBrain();renderBeginnerCommandCenter();})
    .catch(()=>{});
},10000);
clearInterval(commandTimer);
commandTimer=setInterval(renderBeginnerCommandCenter,1000);

try {
  if (!localStorage.getItem("trading-eye-tour-seen-real")) setTimeout(()=>setTour(true),700);
} catch {}

window.TradingEye=Object.freeze({
  mode:"REAL_DATA_ONLY",
  status:()=>status,
  activeSymbol:()=>activeSymbol,
  paperAccount:()=>paperData,
  modelLab:()=>modelLabData
});

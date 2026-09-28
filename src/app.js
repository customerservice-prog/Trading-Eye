import { MarketClient } from "./market-client.js";
import { PaperEngine } from "./paper-engine.js";
import { MarketChart } from "./chart.js";
import { FEATURE_LABELS } from "./ui-labels.js";

const $=id=>document.getElementById(id);
const money=v=>Number(v||0).toLocaleString(undefined,{style:"currency",currency:"USD"});
const num=v=>Number(v||0).toLocaleString();
const pct=v=>(Number(v||0)*100).toFixed(2)+"%";
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));

const NAMES={
  SPY:"S&P 500 ETF",QQQ:"Nasdaq 100 ETF",NVDA:"NVIDIA",AAPL:"Apple",AMD:"AMD",TSLA:"Tesla"
};

const client=new MarketClient();
const paper=new PaperEngine(100_000);
const chart=new MarketChart($("marketChart"),$("chartTooltip"));

let activeSymbol="QQQ";
let timeframe="5m";
let forecastOn=true;
let beginnerOn=true;
let simpleReasons=true;
let autopilot=false;
let monitoredSymbols=["SPY","QQQ","NVDA","AAPL","AMD","TSLA"];
let status=null;
let snapshot={bars:[],quote:null,trades:[],analysis:null,features:null,predictions:[]};
let watchlist={rows:[],provider:"alpaca",feed:"iex"};
let predictionData={rows:[],stats:null,model:null};
let studyData={status:null,rows:[]};
let lastAutoTradeAt=0;
let refreshTimer=null;

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
        <div class="watch-name">${NAMES[symbol]||symbol}</div>
      </div>
      <div class="watch-price">
        <strong>${price==null?"—":price.toFixed(2)}</strong>
        <span class="neutral">${bar?"1m · "+safeTime(bar.ts):"no real bar"}</span>
      </div>`;
    el.addEventListener("click",()=>selectSymbol(symbol));
    wrap.appendChild(el);
  }
}

function renderAI() {
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
  $("chartCalloutBody").textContent=a
    ? `${sourceName()} data · model v${status?.model?.version||"—"} · prediction stored before result.`
    : (!status?.configured?"No real provider is connected. No forecast is being generated.":"Collecting enough real bars to begin.");

  const reasons=$("reasonList");
  reasons.innerHTML="";
  if (!a) {
    reasons.innerHTML=`<div class="reason-item"><span class="reason-dot mixed"></span><div class="reason-copy"><strong>No synthetic fallback</strong><span>${status?.configured?"Waiting for sufficient real market history.":"Add real provider credentials to begin ingestion."}</span></div><span class="reason-value">—</span></div>`;
    return;
  }
  for (const c of a.contributions.slice(0,5)) {
    const label=FEATURE_LABELS[c.key] || {title:c.key,positive:"Positive contribution.",negative:"Negative contribution."};
    const statusClass=Math.abs(c.contribution)<.08?"mixed":c.contribution>0?"good":"bad";
    const explanation=simpleReasons
      ? (c.value>=0?label.positive:label.negative)
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
  const realPrice=currentRealPrice();
  if (realPrice!=null) paper.mark(activeSymbol,realPrice);
  const p=paper.snapshot();
  $("paperEquity").textContent=money(p.equity);
  $("paperCash").textContent=money(p.cash);
  $("openPnl").textContent=money(p.openPnl);
  $("realizedPnl").textContent=money(p.realizedPnl);
  $("paperTrades").textContent=num(p.tradeCount);
  $("openPnl").className=p.openPnl>0?"positive":p.openPnl<0?"negative":"neutral";
  $("realizedPnl").className=p.realizedPnl>0?"positive":p.realizedPnl<0?"negative":"neutral";
  $("positionsTable").innerHTML=p.positions.length?p.positions.map(pos=>`
    <div class="position-row">
      <strong>${pos.symbol}</strong><span>${pos.qty>0?"LONG":"SHORT"}</span>
      <span>${Math.abs(pos.qty)} shares</span><span>Avg ${pos.avgPrice.toFixed(2)}</span>
      <span>Mark ${pos.mark.toFixed(2)}</span>
      <strong class="${pos.pnl>0?"positive":pos.pnl<0?"negative":"neutral"}">${money(pos.pnl)}</strong>
    </div>`).join(""):"No open paper positions. Paper fills are simulated; market prices are real provider data.";
}

function renderLearning() {
  const s=predictionData.stats;
  const scored=Number(s?.scored||0), correct=Number(s?.correct||0);
  const hiScored=Number(s?.high_conf_scored||0), hiCorrect=Number(s?.high_conf_correct||0);
  $("accuracyValue").textContent=scored?pct(correct/scored):"Collecting…";
  $("predictionCount").textContent=num(s?.predictions||0);
  $("scoredCount").textContent=num(scored);
  $("highConfidenceAccuracy").textContent=hiScored?pct(hiCorrect/hiScored):"Not enough yet";
  const historicalHoldout=predictionData.model?.stats?.historicalHoldoutAccuracy;
  $("historicalHoldoutAccuracy").textContent=historicalHoldout==null?"Not trained yet":pct(historicalHoldout);
  $("learningUpdates").textContent=num(predictionData.model?.stats?.learningUpdates||0);

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
  renderWatchlist();
  renderAI();
  renderChart();
  renderTapeAndBook();
  renderPaper();
  renderLearning();
  renderDeepStudy();
}

async function refreshAll({quiet=false}={}) {
  try {
    const [st,wl,snap,preds,studies]=await Promise.all([
      client.status(),client.watchlist(),client.snapshot(activeSymbol),client.predictions(),client.studies(10)
    ]);
    status=st; watchlist=wl; snapshot=snap; predictionData=preds; studyData=studies;
    monitoredSymbols=st.symbols||monitoredSymbols;
    renderAll();
    if (!quiet) toast(st.configured?`Connected: ${sourceName()}`:"Backend online; real market provider still needs credentials.");
  } catch (err) {
    if (!quiet) toast("Real-data backend error: "+String(err.message||err));
    $("feedStatus").textContent="BACKEND UNAVAILABLE";
  }
}

async function selectSymbol(symbol) {
  if (!monitoredSymbols.includes(symbol)) return;
  activeSymbol=symbol;
  $("symbolInput").value=symbol;
  try {
    snapshot=await client.snapshot(symbol);
    renderAll();
  } catch (err) { toast(String(err.message||err)); }
}

function loadSymbol() {
  const symbol=$("symbolInput").value.trim().toUpperCase();
  if (!monitoredSymbols.includes(symbol)) {
    toast("This backend is currently monitoring: "+monitoredSymbols.join(", "));
    $("symbolInput").value=activeSymbol;
    return;
  }
  selectSymbol(symbol);
}

function maybeAutopilot() {
  if (!autopilot) return;
  const a=normalizeAnalysis(snapshot.analysis);
  const price=currentRealPrice();
  if (!a || price==null || !providerConnected()) return;
  if (Date.now()-lastAutoTradeAt<60000) return;
  const pos=paper.positions[activeSymbol];
  if (!pos && a.confidence>=.60 && ["UP","DOWN"].includes(a.direction)) {
    const qty=paper.suggestedQty(price,.009);
    paper.trade(activeSymbol,a.direction==="UP"?"BUY":"SELL",qty,price,"AI PAPER · REAL DATA");
    lastAutoTradeAt=Date.now();
    toast(`AI paper trade using real ${sourceName()} market price.`);
  }
}

function applyRealtime(event) {
  if (event.type==="status") {
    status={...(status||{}),...event.data};
    renderStatus(); renderAI();
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
    client.snapshot(activeSymbol).then(s=>{snapshot=s;renderAll();maybeAutopilot();}).catch(()=>{});
  }
  if (event.type==="prediction" || event.type==="prediction_scored") {
    client.predictions().then(p=>{predictionData=p;renderLearning();}).catch(()=>{});
    client.snapshot(activeSymbol).then(s=>{snapshot=s;renderAI();renderChart();}).catch(()=>{});
  }
  if (event.type==="deep_study_status" || event.type==="deep_study_complete") {
    client.studies(10).then(s=>{studyData=s;renderDeepStudy();}).catch(()=>{});
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

$("loadSymbolBtn").addEventListener("click",loadSymbol);
$("symbolInput").addEventListener("keydown",e=>{if(e.key==="Enter")loadSymbol();});
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
$("autopilotToggle").addEventListener("change",e=>{
  autopilot=e.target.checked;
  toast(autopilot?"AI autopilot enabled for PAPER MONEY using real market data only.":"AI paper autopilot disabled.");
});
$("paperBuyBtn").addEventListener("click",()=>{
  const price=currentRealPrice();
  if (price==null) return toast("No real market price is available.");
  const qty=paper.suggestedQty(price,.008);
  const t=paper.trade(activeSymbol,"BUY",qty,price,"MANUAL PAPER · REAL DATA");
  if (t) toast(`Paper buy ${qty} ${activeSymbol}. Fill is simulated; reference market price is real.`);
  renderPaper();
});
$("paperSellBtn").addEventListener("click",()=>{
  const price=currentRealPrice();
  if (price==null) return toast("No real market price is available.");
  const qty=paper.suggestedQty(price,.008);
  const t=paper.trade(activeSymbol,"SELL",qty,price,"MANUAL PAPER · REAL DATA");
  if (t) toast(`Paper sell ${qty} ${activeSymbol}. Fill is simulated; reference market price is real.`);
  renderPaper();
});
$("flattenBtn").addEventListener("click",()=>{
  const price=currentRealPrice();
  if (price==null) return toast("No real market price is available.");
  const t=paper.flatten(activeSymbol,price,"MANUAL PAPER · REAL DATA");
  toast(t?"Paper position flattened. Fill is simulated.":"No open paper position in "+activeSymbol+".");
  renderPaper();
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
document.addEventListener("keydown",e=>{if(e.key==="Escape"&&!$("tourPanel").classList.contains("hidden"))setTour(false,true);});

client.on(applyRealtime);
client.connect();
await refreshAll({quiet:true});
clearInterval(refreshTimer);
refreshTimer=setInterval(()=>refreshAll({quiet:true}),30000);

try {
  if (!localStorage.getItem("trading-eye-tour-seen-real")) setTimeout(()=>setTour(true),700);
} catch {}

window.TradingEye=Object.freeze({
  mode:"REAL_DATA_ONLY",
  status:()=>status,
  activeSymbol:()=>activeSymbol,
  paperAccount:()=>paper.snapshot()
});

import { MarketClient } from "./market-client.js?v=20260928-2300";
import { MarketChart } from "./chart.js?v=20260928-2300";
import { FEATURE_LABELS } from "./ui-labels.js?v=20260928-2300";

const $=id=>document.getElementById(id);
const money=v=>Number(v||0).toLocaleString(undefined,{style:"currency",currency:"USD"});
const num=v=>Number(v||0).toLocaleString();
const pct=v=>(Number(v||0)*100).toFixed(2)+"%";
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const esc=v=>String(v??"").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));

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
let explorationData={enabled:true,startingCash:100000,cash:100000,equity:100000,openPnl:0,realizedPnl:0,fillCount:0,autopilotEnabled:true,positions:[],fills:[]};
let mistakeData={enabled:true,running:false,lastError:null,lastAnalysis:null};
let replayData={status:{enabled:true,running:false,totals:{runs:0,decisions:0,trades:0,wins:0,losses:0}},runs:[],leaderboard:[]};
let worldData={status:{enabled:true,global:{sourceCoverage:0,eventRisk:0,uncertainty:1},sources:{},symbols:{}},symbol:null,events:[]};
let modelLabData={enabled:true,training:false,production:null,latestRun:null};
let readinessData={
  status:"LOCKED",reviewEligible:false,liveTradingEnabled:false,
  detail:"Server proof gate is loading.",gates:[],blockers:[]
};
let studyData={status:null,rows:[]};
let scannerData={universe:null,scan:null,candidates:[],hotSymbols:[],pinnedSymbols:[]};
let patternLabData={symbol:null,status:"WAITING",statsByHorizon:{},analogs:[]};
let researchData={
  running:false,heartbeatAt:null,lastResearchEventAt:null,
  sources:{},coverage:{},jobs:[],events:[],findings:[]
};
let refreshTimer=null;
let researchTimer=null;
let paperTimer=null;
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
  const status=String(readinessData?.status||"LOCKED").toUpperCase();
  const label=status.replaceAll("_"," ");
  const detail=readinessData?.detail||"Server proof gate is still loading.";
  return {
    label,
    detail,
    review:Boolean(readinessData?.reviewEligible),
    gates:Array.isArray(readinessData?.gates)?readinessData.gates:[],
    blockers:Array.isArray(readinessData?.blockers)?readinessData.blockers:[]
  };
}

function renderBeginnerCommandCenter() {
  if (!$("heroPaperEquity")) return;

  const p=paperData||{};
  const positions=Array.isArray(p.positions)?p.positions:[];
  const fills=Array.isArray(p.fills)?p.fills:[];
  const starting=Number(p.startingCash)||100000;
  const equity=Number(p.equity);
  const safeEquity=Number.isFinite(equity)?equity:starting;
  const totalPnl=safeEquity-starting;
  const session=marketSessionET();
  const a=normalizeAnalysis(snapshot.analysis);
  const latestTs=latestSelectedMarketTs();
  const ageMs=latestTs==null?null:Date.now()-latestTs;

  $("heroPaperEquity").textContent=money(safeEquity);
  $("heroPaperPnl").textContent=`${totalPnl>0?"+":""}${money(totalPnl)} total profit / loss`;
  $("heroPaperPnl").className="paper-money-pnl "+(totalPnl>0?"positive":totalPnl<0?"negative":"neutral");
  $("heroPaperAutopilot").textContent=p.autopilotEnabled?"ON — AI CAN PAPER TRADE":"OFF";
  $("heroPaperAutopilot").className=p.autopilotEnabled?"positive":"neutral";

  if (positions.length) {
    $("heroPaperBalanceNote").textContent="This fake balance refreshes every 3 seconds and moves with the real market while a paper position is open.";
    if (positions.length===1) {
      const pos=positions[0];
      const side=Number(pos.qty)>0?"LONG":"SHORT";
      $("heroPaperPosition").textContent=`${side} ${pos.symbol}`;
      $("heroPaperPositionDetail").textContent=`${Math.abs(Number(pos.qty)||0)} shares · open profit/loss ${money(pos.pnl)}`;
      $("heroPaperPosition").className=Number(pos.pnl)>0?"positive":Number(pos.pnl)<0?"negative":"neutral";
    } else {
      const openPnl=positions.reduce((sum,pos)=>sum+(Number(pos.pnl)||0),0);
      $("heroPaperPosition").textContent=`${positions.length} OPEN TRADES`;
      $("heroPaperPositionDetail").textContent=`Combined open profit/loss ${money(openPnl)} · ${positions.slice(0,3).map(x=>x.symbol).join(", ")}`;
      $("heroPaperPosition").className=openPnl>0?"positive":openPnl<0?"negative":"neutral";
    }
  } else {
    $("heroPaperBalanceNote").textContent=fills.length
      ?"No paper trade is open now, so the fake balance should stay still until the next trade."
      :"No paper trade has opened yet, so $100,000 staying still is correct.";
    $("heroPaperPosition").textContent="NONE";
    $("heroPaperPositionDetail").textContent="No fake money is in the market right now.";
    $("heroPaperPosition").className="neutral";
  }

  const last=fills[0]||null;
  if (last) {
    const source=String(last.source||"PAPER").toUpperCase();
    const who=source.startsWith("AI_")?"AI":"PAPER";
    $("heroPaperLastAction").textContent=`${who} ${last.side} ${last.qty} ${last.symbol}`;
    const realized=Number(last.realizedPnl)||0;
    $("heroPaperLastDetail").textContent=`Filled at ${money(last.fillPrice)} · ${safeTime(last.createdAt)}${Math.abs(realized)>0.000001?" · closed P/L "+money(realized):""}`;
    $("heroPaperLastAction").className=last.side==="BUY"?"positive":"negative";
  } else {
    $("heroPaperLastAction").textContent="NO TRADES YET";
    $("heroPaperLastDetail").textContent=p.autopilotEnabled
      ?"Autopilot is on. The AI is waiting for a setup strong enough to risk fake money."
      :"Turn on paper autopilot below if you want the AI to place fake trades automatically.";
    $("heroPaperLastAction").className="neutral";
  }

  const actionEl=$("beginnerAction");
  const actionCard=$("heroActionCard");
  actionCard?.classList.remove("positive","negative");

  if (positions.length) {
    const openPnl=positions.reduce((sum,pos)=>sum+(Number(pos.pnl)||0),0);
    actionEl.textContent="PAPER TRADE OPEN";
    $("beginnerActionDetail").textContent=`Fake money is currently in ${positions.length===1?positions[0].symbol:positions.length+" positions"} · open P/L ${money(openPnl)}.`;
    actionCard?.classList.add(openPnl>=0?"positive":"negative");
  } else if (!a) {
    actionEl.textContent="WAITING";
    $("beginnerActionDetail").textContent="The AI is still collecting enough real market evidence.";
  } else {
    const up=Math.round(a.probabilities.up*100);
    const flat=Math.round(a.probabilities.flat*100);
    const down=Math.round(a.probabilities.down*100);
    if (a.direction==="FLAT" && a.probabilities.flat>=a.probabilities.up && a.probabilities.flat>=a.probabilities.down) {
      actionEl.textContent="WAIT — SIDEWAYS";
      $("beginnerActionDetail").textContent=`${flat}% flat/sideways. The AI will not use paper money here.`;
    } else if (a.noTrade || a.confidence<.46 || a.edge<.055) {
      actionEl.textContent="WAIT — NO TRADE";
      $("beginnerActionDetail").textContent=`UP ${up}% · SIDEWAYS ${flat}% · DOWN ${down}%. Not strong enough for a paper trade.`;
    } else if (a.direction==="UP") {
      actionEl.textContent="WATCHING TO BUY";
      $("beginnerActionDetail").textContent=`${up}% up. If all paper-trade rules pass, autopilot may open a fake long trade.`;
      actionCard?.classList.add("positive");
    } else if (a.direction==="DOWN") {
      actionEl.textContent="WATCHING TO SHORT";
      $("beginnerActionDetail").textContent=`${down}% down. If all paper-trade rules pass, autopilot may open a fake short trade.`;
      actionCard?.classList.add("negative");
    } else {
      actionEl.textContent="WAITING";
      $("beginnerActionDetail").textContent="No clear paper-trade setup right now.";
    }
  }

  $("beginnerSession").textContent=session.label;
  $("beginnerDataAge").textContent=!providerConnected()
    ?"OFFLINE"
    : latestTs==null
      ?"WAITING"
      : ageMs!=null&&ageMs<60000
        ?"LIVE"
        : ageText(latestTs);

  if ($("heroExploreEquity")) {
    const ep=explorationData||{};
    const eStarting=Number(ep.startingCash)||100000;
    const eEquity=Number.isFinite(Number(ep.equity))?Number(ep.equity):eStarting;
    const eGross=Number(ep.grossExposure)||0;
    const ePositions=Array.isArray(ep.positions)?ep.positions:[];
    const eMistakeLevel=String(mistakeData?.lastAnalysis?.guard?.level||modelLabData?.mistakeGuard?.level||"LEARNING").toUpperCase();

    $("heroExploreEquity").textContent=money(eEquity);
    $("heroExploreDeployed").textContent=`${money(eGross)} · ${Math.round(Number(ep.grossExposurePct||0)*100)}%`;
    $("heroExploreOpen").textContent=num(ePositions.length);
    $("heroExploreFills").textContent=num(ep.fillCount||0);
    $("heroExploreMistakes").textContent=eMistakeLevel==="ALERT"?"BLOCKING":eMistakeLevel;
    $("heroExploreMistakes").className=eMistakeLevel==="ALERT"?"negative":eMistakeLevel==="WARN"?"neutral":"positive";
  }

  if ($("heroReplayState")) {
    const rs=replayData?.status||{};
    const totals=rs.totals||{};
    const last=rs.lastRun||{};
    $("heroReplayState").textContent=rs.running?"RUNNING NOW":"24/7 ACTIVE";
    $("heroReplayState").className=rs.running?"positive":"";
    $("heroReplayMeta").textContent=Number(totals.runs)
      ? `${num(totals.runs)} runs · ${num(totals.trades)} simulated trades${last.replayDay?" · last "+last.replayDay:""}`
      :"Server replay worker is starting; it keeps running with this page closed.";
  }

  if ($("heroWorldState")) {
    const ws=worldData?.status||{};
    const g=ws.global||{};
    const sym=worldData?.symbol||ws.symbols?.[activeSymbol]||{};
    const risk=Number(sym.riskScore)||0;
    const coverage=Number(g.sourceCoverage)||0;
    const label=risk>=.90?"BLOCKING PROOF":risk>=.65?"HIGH RISK":risk>=.40?"ELEVATED":"MONITORING";
    $("heroWorldState").textContent=label;
    $("heroWorldState").className=risk>=.65?"negative":risk>=.40?"neutral":"positive";
    $("heroWorldMeta").textContent=`${Math.round(coverage*100)}% sources · ${Math.round(risk*100)}% ${activeSymbol} event risk`;
    if ($("beginnerWorldState")) {
      $("beginnerWorldState").textContent=label;
      $("beginnerWorldState").className=risk>=.65?"negative":risk>=.40?"neutral":"positive";
    }
  }

  const jobs=Array.isArray(researchData.jobs)?researchData.jobs:[];
  const running=jobs.filter(j=>j.status==="RUNNING");
  $("beginnerResearchState").textContent=running.length?"WORKING":"MONITORING";

  if ($("beginnerMistakeState")) {
    const mistakeLevel=String(mistakeData?.lastAnalysis?.guard?.level||modelLabData?.mistakeGuard?.level||"LEARNING").toUpperCase();
    $("beginnerMistakeState").textContent=mistakeLevel==="ALERT"?"BLOCKING":mistakeLevel;
    $("beginnerMistakeState").className=mistakeLevel==="ALERT"?"negative":mistakeLevel==="WARN"?"neutral":"positive";
  }

  const ready=readinessSummary();
  $("beginnerReadiness").textContent=ready.review?"REVIEW ELIGIBLE":"LOCKED";
  $("beginnerReadiness").className=ready.review?"positive":"";
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
  if (!a) return {title:"WAITING FOR DATA",summary:"No paper trade can happen until the model has enough real market data."};

  const up=Number(a.probabilities.up)||0;
  const flat=Number(a.probabilities.flat)||0;
  const down=Number(a.probabilities.down)||0;

  if (a.direction==="FLAT" && flat>=up && flat>=down) {
    return {
      title:`${Math.round(flat*100)}% SIDEWAYS — NO PAPER TRADE`,
      summary:"The model currently thinks sideways/flat is most likely, so the AI should wait instead of buying or shorting."
    };
  }
  if (a.noTrade) return {
    title:"WAIT — NO PAPER TRADE",
    summary:"The directional edge is not strong enough. The AI should keep the fake money in cash."
  };
  if (a.direction==="UP") return {
    title:`${Math.round(up*100)}% UP — WATCHING TO BUY`,
    summary:"Up is the strongest directional outcome, but paper-trade risk rules still have to pass before an entry."
  };
  if (a.direction==="DOWN") return {
    title:`${Math.round(down*100)}% DOWN — WATCHING TO SHORT`,
    summary:"Down is the strongest directional outcome, but paper-trade risk rules still have to pass before an entry."
  };
  return {title:"WAIT — NO PAPER TRADE",summary:"The AI does not have a strong enough directional setup right now."};
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
  if ($("confidenceLabel")) {
    $("confidenceLabel").textContent=!a
      ?"model read"
      : a.direction==="FLAT"
        ?"sideways chance"
        : a.direction==="UP"
          ?"up chance"
          :"down chance";
  }

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

function renderExploration() {
  if (!$("explorationEquity")) return;
  const p=explorationData||{};
  const starting=Number(p.startingCash)||100000;
  const equity=Number.isFinite(Number(p.equity))?Number(p.equity):starting;
  const pnl=equity-starting;
  const positions=Array.isArray(p.positions)?p.positions:[];

  $("explorationEquity").textContent=money(equity);
  $("explorationPnl").textContent=(pnl>0?"+":"")+money(pnl);
  $("explorationPnl").className=pnl>0?"positive":pnl<0?"negative":"neutral";
  $("explorationPositions").textContent=num(positions.length);
  $("explorationFills").textContent=num(p.fillCount||0);
  $("explorationState").textContent=p.autopilotEnabled?"LEARNING LIVE":"PAUSED";
  $("explorationState").className="soft-badge "+(p.autopilotEnabled?"positive":"neutral");

  $("explorationExplanation").textContent=positions.length
    ?"This practice account currently has fake positions open. It deliberately tests marginal setups that the strict proof account may reject."
    :"This practice account waits for directional setups, but uses looser fake-money thresholds than the proof account. Its results never count toward real-money readiness.";

  $("explorationPositionList").innerHTML=positions.length
    ? positions.map(pos=>`
      <div class="exploration-position">
        <strong>${pos.symbol} · ${Number(pos.qty)>0?"LONG":"SHORT"}</strong>
        <span>${Math.abs(Number(pos.qty)||0)} shares</span>
        <span class="${Number(pos.pnl)>0?"positive":Number(pos.pnl)<0?"negative":"neutral"}">${money(pos.pnl)}</span>
      </div>`).join("")
    : '<div class="exploration-empty">No exploration trade is open this second.</div>';
}

function renderMistakeLab() {
  if (!$("mistakeGuardTitle")) return;
  const m=mistakeData?.lastAnalysis||{};
  const guard=m.guard||modelLabData?.mistakeGuard||{};
  const level=String(guard.level||"INSUFFICIENT").toUpperCase();
  const samples=Number(m.scoredSamples)||0;
  const mistakes=Number(m.mistakes)||0;

  $("mistakeGuardTitle").textContent=level==="ALERT"
    ?"ALERT — strict entries are blocked"
    : level==="WARN"
      ?"WATCHING — recent mistakes increased"
      : level==="STABLE"
        ?"STABLE — learning from mistakes"
        :"COLLECTING FUTURE OUTCOMES";
  $("mistakeGuardTitle").className=level==="ALERT"?"negative":level==="WARN"?"neutral":"positive";
  $("mistakeGuardDetail").textContent=guard.reason||"Mistake Lab is waiting for enough scored future predictions.";
  $("mistakeSamples").textContent=num(samples);
  $("mistakeCount").textContent=num(mistakes);
  $("mistakeHighConf").textContent=num(m.highConfMistakes||0);
  $("mistakeMissedMoves").textContent=num(m.missedMoves||0);
  $("mistakeAnalyzedAt").textContent=m.analyzedAt?"analyzed "+ageText(m.analyzedAt):"Waiting for first analysis";

  const lessons=Array.isArray(m.lessons)?m.lessons:[];
  $("mistakeLessons").innerHTML=lessons.length
    ? lessons.map(x=>`
      <div class="mistake-lesson ${String(x.severity||"LOW").toLowerCase()}">
        <span>${x.severity||"LOW"}</span>
        <div><strong>${x.title||"Lesson"}</strong><p>${x.text||""}</p></div>
      </div>`).join("")
    : '<div class="mistake-lesson low"><span>WAIT</span><div><strong>No lesson yet</strong><p>The lab needs scored future outcomes before it can diagnose mistakes.</p></div></div>';

  const rows=Array.isArray(m.latestMistakes)?m.latestMistakes:[];
  $("mistakeTableBody").innerHTML=rows.length
    ? rows.map(x=>`
      <tr>
        <td>${safeTime(x.createdAt)}</td>
        <td><strong>${x.symbol}</strong></td>
        <td class="${x.predicted==="UP"?"positive":x.predicted==="DOWN"?"negative":"neutral"}">${x.predicted}</td>
        <td class="${x.actual==="UP"?"positive":x.actual==="DOWN"?"negative":"neutral"}">${x.actual}</td>
        <td>${Math.round(Number(x.confidence||0)*100)}%</td>
        <td class="${Number(x.resultReturn)>0?"positive":Number(x.resultReturn)<0?"negative":"neutral"}">${(Number(x.resultReturn||0)*100).toFixed(2)}%</td>
        <td>${x.modelId||"legacy"}</td>
      </tr>`).join("")
    : '<tr><td colspan="7">No wrong future predictions recorded in the current Mistake Lab window yet.</td></tr>';
}


function renderReplayArena() {
  if (!$("replayTitle")) return;
  const data=replayData||{};
  const rs=data.status||{};
  const totals=rs.totals||{};
  const last=rs.lastRun||{};
  const summary=last.summary||{};
  const running=Boolean(rs.running);

  $("replayTitle").textContent=running
    ?"REPLAY ARENA RUNNING NOW"
    : Number(totals.runs)
      ?"REPLAY ARENA ACTIVE 24/7"
      :"REPLAY ARENA STARTING";
  $("replayDetail").textContent=running
    ?"Trading Eye is currently replaying a historical session forward minute-by-minute with future bars hidden."
    :"The worker keeps cycling stored sessions on the server. Replay failures can shape challenger training but never count as real-money proof.";

  $("replayRuns").textContent=num(totals.runs||0);
  $("replayDecisions").textContent=num(totals.decisions||0);
  $("replayTrades").textContent=num(totals.trades||0);
  $("replayWinRate").textContent=Number(totals.trades)>0?pct(Number(totals.wins||0)/Number(totals.trades)):"—";
  $("replayDay").textContent=last.replayDay||"—";
  $("replayBestStrategy").textContent=summary.bestStrategy?.strategy
    ? summary.bestStrategy.strategy.replaceAll("_"," ").toUpperCase()
    : "—";
  $("replayModel").textContent=last.modelFamily||summary.selectedModel||"waiting";
  $("replayLastRun").textContent=last.completedAt
    ? "last completed "+ageText(last.completedAt)
    : running?"running now":"waiting";

  const board=Array.isArray(data.leaderboard)?data.leaderboard:[];
  $("replayStrategyBody").innerHTML=board.length
    ? board.map(x=>`
      <tr>
        <td><strong>${String(x.strategy||"").replaceAll("_"," ")}</strong></td>
        <td>${num(x.trades||0)}</td>
        <td>${pct(Number(x.winRate)||0)}</td>
        <td class="${Number(x.avgReturn)>0?"positive":Number(x.avgReturn)<0?"negative":"neutral"}">${(Number(x.avgReturn||0)*100).toFixed(3)}%</td>
        <td>${x.profitFactor==null?"—":Number.isFinite(Number(x.profitFactor))?Number(x.profitFactor).toFixed(2):"∞"}</td>
      </tr>`).join("")
    : '<tr><td colspan="5">Replay strategy results will appear after the first completed session.</td></tr>';

  const focusSymbols=Array.isArray(summary.focusSymbols)?summary.focusSymbols:[];
  const focusTimes=Array.isArray(summary.focusTimeBuckets)?summary.focusTimeBuckets:[];
  const zones=[
    ...focusSymbols.map(x=>({type:"SYMBOL",name:x.symbol||x,detail:`${num(x.samples||0)} replay trades · ${Math.round(Number(x.errorRate||0)*100)}% loss/error rate`})),
    ...focusTimes.map(x=>({type:"TIME",name:String(x.bucket||x).replaceAll("_"," "),detail:`${num(x.samples||0)} replay trades · ${Math.round(Number(x.errorRate||0)*100)}% loss/error rate`}))
  ];
  $("replayFocusCount").textContent=`${zones.length} focus zone${zones.length===1?"":"s"}`;
  $("replayFocusList").innerHTML=zones.length
    ? zones.map(z=>`
      <div class="replay-focus-item">
        <span>${z.type}</span>
        <div><strong>${z.name}</strong><small>${z.detail}</small></div>
      </div>`).join("")
    : '<div class="replay-focus-empty">No replay weakness cluster has been strong enough to feed into challenger training yet.</div>';

  const runs=Array.isArray(data.runs)?data.runs:[];
  $("replayRunBody").innerHTML=runs.length
    ? runs.map(r=>`
      <tr>
        <td>${safeTime(r.startedAt)}</td>
        <td>${r.replayDay||"—"}</td>
        <td>${r.modelFamily||"—"}</td>
        <td>${num(r.summary?.decisions||0)}</td>
        <td>${num(r.summary?.trades||0)}</td>
        <td>${r.summary?.bestStrategy?.strategy?String(r.summary.bestStrategy.strategy).replaceAll("_"," "):"—"}</td>
        <td class="${r.status==="COMPLETE"?"positive":r.status==="ERROR"?"negative":"neutral"}">${r.status||"—"}</td>
      </tr>`).join("")
    : '<tr><td colspan="7">No replay sessions stored yet.</td></tr>';
}


function renderWorldState() {
  if (!$("worldStateTitle")) return;
  const data=worldData||{};
  const ws=data.status||{};
  const global=ws.global||{};
  const sym=data.symbol||ws.symbols?.[activeSymbol]||{};
  const factors=sym.factors||{};
  const risk=Number(sym.riskScore)||0;
  const coverage=Number(global.sourceCoverage)||0;
  const riskLabel=risk>=.90?"BLOCKED":risk>=.65?"HIGH":risk>=.40?"ELEVATED":"NORMAL";

  $("worldStateTitle").textContent=`${activeSymbol} WORLD STATE — ${riskLabel}`;
  $("worldStateTitle").className=risk>=.65?"negative":risk>=.40?"neutral":"positive";
  $("worldStateDetail").textContent=sym.blockProof
    ?"Severe real-world event risk is blocking strict proof-account entries. Exploration can still test this situation with fake money."
    :"Trading Eye is combining observable external factors with the live market before strict entries are allowed.";
  $("worldRiskScore").textContent=`${Math.round(risk*100)}%`;
  $("worldRiskScore").className=risk>=.65?"negative":risk>=.40?"neutral":"positive";
  $("worldCoverage").textContent=`${Math.round(coverage*100)}% source coverage · uncertainty ${Math.round(Number(sym.uncertainty||global.uncertainty||0)*100)}%`;
  $("worldUpdatedAt").textContent=global.updatedAt?"updated "+ageText(global.updatedAt):"waiting for first update";

  const sourceNames={
    market:"Live market",news:"Market news",sec:"SEC EDGAR",corporate:"Corporate actions",
    options:"Options chain",macro:"Macro / rates",fed:"Fed calendar",finra:"FINRA short volume"
  };
  const sources=ws.sources||{};
  $("worldSourceGrid").innerHTML=Object.entries(sourceNames).map(([key,label])=>{
    const x=sources[key]||{state:"STARTING"};
    const state=String(x.state||"STARTING").toUpperCase();
    const cls=state==="OK"?"positive":state==="ERROR"?"negative":"neutral";
    return `<div class="world-source-card">
      <span>${esc(label)}</span>
      <strong class="${cls}">${esc(state)}</strong>
      <small>${esc(x.detail||"Waiting for source")}${x.dataAt?" · "+esc(ageText(x.dataAt)):""}</small>
    </div>`;
  }).join("");

  const news=factors.news||{};
  $("worldNewsFactor").textContent=news.count6h!=null
    ? `${news.count6h} stories · sentiment ${Math.round(Number(news.sentiment||0)*100)}`
    :"—";
  $("worldNewsMeta").textContent=news.latestHeadline||"No recent symbol-specific news loaded.";

  const sec=factors.sec||{};
  $("worldSecFactor").textContent=sec.filings21d!=null
    ? `${sec.filings21d} filings · risk ${Math.round(Number(sec.filingRisk||0)*100)}%`
    :"—";
  $("worldSecMeta").textContent=sec.offeringRisk
    ? `Offering/dilution risk ${Math.round(Number(sec.offeringRisk)*100)}% · insider-form activity ${sec.insiderActivity||0}`
    : `Insider-form activity ${sec.insiderActivity||0} · no high offering risk detected`;

  const opt=factors.options||{};
  $("worldOptionsFactor").textContent=opt.impliedVol
    ? `IV ${(Number(opt.impliedVol)*100).toFixed(1)}% · stress ${Math.round(Number(opt.stress||0)*100)}%`
    : (opt.state||"—");
  $("worldOptionsMeta").textContent=Number.isFinite(Number(opt.putCallIvSkew))
    ? `Put-call IV skew ${(Number(opt.putCallIvSkew)*100).toFixed(1)} pts · ${opt.contracts||0} near-money contracts`
    :"Options skew not available yet.";

  const macro=global.macro||{};
  const fed=global.fed||{};
  $("worldMacroFactor").textContent=`Macro stress ${Math.round(Number(macro.stress||0)*100)}% · Fed ${Math.round(Number(fed.risk||0)*100)}%`;
  $("worldMacroMeta").textContent=fed.nextFomcDate
    ? `Next FOMC ${fed.nextFomcDate} · ${Number(fed.daysToFomc).toFixed(0)} days`
    :"FOMC schedule loading.";

  const short=factors.short||{};
  $("worldShortFactor").textContent=Number.isFinite(Number(short.shortVolumeRatio))
    ? `${(Number(short.shortVolumeRatio)*100).toFixed(1)}% short-sale volume`
    :"—";
  $("worldShortMeta").textContent=short.date
    ? `FINRA consolidated NMS · ${short.date}`
    :"Daily FINRA file not loaded yet.";

  const market=factors.market||{};
  $("worldMarketFactor").textContent=Number.isFinite(Number(market.spreadBps))
    ? `${Number(market.spreadBps).toFixed(1)} bps spread · imbalance ${Math.round(Number(market.quoteImbalance||0)*100)}`
    :"—";
  $("worldMarketMeta").textContent=market.volumeShock
    ? `Volume ${Number(market.volumeShock).toFixed(2)}× recent average · RV20 ${(Number(market.rv20||0)*100).toFixed(2)}%`
    :"Waiting for live quote/bar microstructure.";

  const events=Array.isArray(data.events)?data.events:[];
  $("worldEventsTitle").textContent=`Latest events for ${activeSymbol} + global market`;
  $("worldEventsBody").innerHTML=events.length
    ? events.slice(0,80).map(ev=>{
      const severity=Number(ev.severity)||0;
      const when=ev.event_at?new Date(ev.event_at).toLocaleString([],{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}):"—";
      return `<tr>
        <td>${esc(when)}</td>
        <td>${esc(ev.source||"—")}</td>
        <td><strong>${esc(ev.symbol||"MARKET")}</strong></td>
        <td>${esc(ev.category||"—")}</td>
        <td>${esc(ev.headline||"—")}</td>
        <td class="${severity>=.7?"negative":severity>=.4?"neutral":"positive"}">${Math.round(severity*100)}%</td>
      </tr>`;
    }).join("")
    : '<tr><td colspan="6">No external events stored for this symbol yet.</td></tr>';
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
    const drift=production?.drift||modelLabData?.drift||{};
    $("modelLabSummary").innerHTML=production
      ? `<strong>Production: ${production.modelId}</strong><br>${production.family} · test ${pct(Number(production.testMetrics?.accuracy||0))} · walk-forward ${wf.accuracy==null?"—":pct(Number(wf.accuracy))} · ${num(wf.folds?.length||0)} folds · live shadow challengers ${challengers.length}.<br>Drift guard: <strong>${String(drift.level||"INSUFFICIENT").replaceAll("_"," ")}</strong> · ${drift.reason||"collecting recent future outcomes"}.<br>${run?.promotionReason||"Production remains locked until a challenger proves better on future paired outcomes."}`
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

  if ($("readinessGateList")) {
    const ready=readinessSummary();
    const drift=production?.drift||modelLabData?.drift||{};
    $("readinessProofTitle").textContent=`Server proof gate: ${ready.label}`;
    $("readinessProofMeta").textContent=ready.review
      ?"All proof gates passed for manual review only; live execution remains disabled."
      : `${ready.blockers.length} blocker${ready.blockers.length===1?"":"s"} · drift ${String(drift.level||"INSUFFICIENT").replaceAll("_"," ")}`;
    $("readinessGateList").innerHTML=ready.gates.length
      ? ready.gates.map(g=>`
        <div class="readiness-gate ${g.pass?"pass":"blocked"}">
          <div class="readiness-gate-status">${g.pass?"✓ PASS":"× BLOCKED"}</div>
          <div class="readiness-gate-copy">
            <strong>${g.label||g.key}</strong>
            <span>${g.detail||""}</span>
          </div>
          <div class="readiness-gate-values">
            <span>Current <b>${g.current==null?"—":g.current}</b></span>
            <span>Target <b>${g.target==null?"—":g.target}</b></span>
          </div>
        </div>`).join("")
      : '<div class="readiness-gate blocked"><div class="readiness-gate-copy"><strong>Server proof gate loading</strong><span>No client-side shortcut can mark the system ready.</span></div></div>';
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
  const longIntegrity=r.sources?.longHistory?.integrity||{};
  const integrityStatus=String(longIntegrity.status||"UNVERIFIED").toUpperCase();

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
    ? `${num(longHistory.symbols||0)} symbols · ${longFirst} → ${longLast} · ${r.sources?.longHistory?.provider||"long-history source"} · integrity ${integrityStatus}`
    : `${r.sources?.longHistory?.provider||"long-history source"} · target ${r.sources?.longHistory?.targetStart||"1999-01-01"} · integrity ${integrityStatus}`;

  $("researchFindingCount").textContent=num(findings.findings||0);
  $("researchFindingMeta").textContent=`${num(findings.promoted||0)} passed holdout · ${num((coverage.predictions||{}).scored||0)} future predictions scored · research-only`;

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
    const rawStatus=String(f.status||"CANDIDATE").toUpperCase();
    const statusLabel={
      PROMOTED:"PASSED HOLDOUT",
      VALIDATED:"PASSED VALIDATION",
      REJECTED_HOLDOUT:"FAILED HOLDOUT",
      REJECTED_VALIDATION:"FAILED VALIDATION",
      LEGACY_UNVALIDATED:"NEEDS RECHECK",
      CANDIDATE:"STILL PROVING"
    }[rawStatus]||rawStatus.replaceAll("_"," ");
    return `<tr class="${String(f.status||"candidate").toLowerCase()}">
      <td>${statusLabel}</td>
      <td><strong>${f.symbol||"MARKET"}</strong></td>
      <td>${f.description||f.pattern_key||"—"}</td>
      <td>${num(f.horizon_days)}d</td>
      <td>${num(f.sample_count)}</td>
      <td>${f.hit_rate==null?"—":pct(Number(f.hit_rate))}</td>
      <td class="${Number(f.avg_forward_return)>0?"positive":Number(f.avg_forward_return)<0?"negative":"neutral"}">${f.avg_forward_return==null?"—":(Number(f.avg_forward_return)>=0?"+":"")+pct(Number(f.avg_forward_return))}</td>
      <td>${Number(f.score||0).toFixed(2)}</td>
      <td>${
        evidence.holdoutWindow?.start
          ? evidence.holdoutWindow.start+" → "+evidence.holdoutWindow.end
          : evidence.validationWindow?.start
            ? evidence.validationWindow.start+" → "+evidence.validationWindow.end
            : evidence.discoveryWindow?.start
              ? evidence.discoveryWindow.start+" → "+evidence.discoveryWindow.end
              : "—"
      }</td>
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
  renderExploration();
  renderMistakeLab();
  renderReplayArena();
  renderWorldState();
  renderLearning();
  renderPatternLab();
  renderScanner();
  renderResearchBrain();
  renderDeepStudy();
}

async function refreshAll({quiet=false}={}) {
  try {
    const [st,wl,snap,preds,studies,scanner,paperState,exploreState,mistakes,replay,world,lab,research,readiness]=await Promise.all([
      client.status(),client.watchlist(),client.snapshot(activeSymbol),client.predictions(),
      client.studies(10),client.scanner(50),client.paper(),client.explorationPaper(),client.mistakes(),client.replay(10),
      client.worldState(activeSymbol,80),client.modelLab(),client.research(),client.readiness()
    ]);
    status=st; watchlist=wl; snapshot=snap; predictionData=preds; studyData=studies; scannerData=scanner;
    paperData=paperState; explorationData=exploreState; mistakeData=mistakes; replayData=replay; worldData=world;
    modelLabData=lab; researchData=research; readinessData=readiness;
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
    [snapshot,worldData]=await Promise.all([
      client.snapshot(symbol),
      client.worldState(symbol,80)
    ]);
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
    if (event.type==="prediction_scored") {
      client.readiness().then(r=>{readinessData=r;renderLearning();renderBeginnerCommandCenter();}).catch(()=>{});
    }
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
  if (event.type==="mistake_lab") {
    mistakeData={...mistakeData,lastAnalysis:event.data};
    renderMistakeLab();
    renderLearning();
    return;
  }
  if (event.type==="world_state") {
    worldData={...worldData,status:event.data};
    worldData.symbol=event.data?.symbols?.[activeSymbol]||worldData.symbol;
    renderWorldState();
    renderBeginnerCommandCenter();
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

$("runReplayBtn")?.addEventListener("click",async()=>{
  const btn=$("runReplayBtn");
  try{
    btn.disabled=true;
    btn.textContent="Replay running…";
    await client.runReplay();
    replayData=await client.replay(10);
    renderReplayArena();
    renderBeginnerCommandCenter();
    toast("Replay Arena completed another no-hindsight session.");
  }catch(err){
    toast(String(err.message||err));
  }finally{
    btn.disabled=false;
    btn.textContent="Run one replay now";
  }
});

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
    renderBeginnerCommandCenter();
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
    renderBeginnerCommandCenter();
  }catch(err){ toast(String(err.message||err)); }
});
$("paperSellBtn").addEventListener("click",async()=>{
  try{
    const fill=await client.paperOrder({symbol:activeSymbol,side:"SELL",source:"MANUAL_PAPER"});
    toast(`Paper SELL filled ${fill.qty} ${activeSymbol} @ ${Number(fill.fillPrice).toFixed(2)} using ${fill.fillModel}.`);
    paperData=await client.paper();
    renderPaper();
    renderBeginnerCommandCenter();
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
    renderBeginnerCommandCenter();
  }catch(err){ toast(String(err.message||err)); }
});
$("scannerBody")?.addEventListener("click",e=>{
  const row=e.target.closest("tr[data-symbol]");
  if (!row) return;
  selectSymbol(row.dataset.symbol,{activate:true});
});

$("paperDetailsBtn")?.addEventListener("click",()=>{
  const btn=document.querySelector('#lowerTabs button[data-tab="paper"]');
  btn?.click();
  document.querySelector(".lower-panel")?.scrollIntoView({behavior:"smooth",block:"start"});
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
  Promise.all([client.research(),client.mistakes(),client.replay(10),client.worldState(activeSymbol,80)])
    .then(([r,m,replay,world])=>{
      researchData=r;
      mistakeData=m;
      replayData=replay;
      worldData=world;
      renderResearchBrain();
      renderMistakeLab();
      renderReplayArena();
      renderWorldState();
      renderBeginnerCommandCenter();
    })
    .catch(()=>{});
},10000);

clearInterval(paperTimer);
paperTimer=setInterval(()=>{
  Promise.all([client.paper(),client.explorationPaper()])
    .then(([p,e])=>{
      paperData=p;
      explorationData=e;
      renderPaper();
      renderExploration();
      renderBeginnerCommandCenter();
    })
    .catch(()=>{});
},3000);

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
  explorationAccount:()=>explorationData,
  mistakes:()=>mistakeData,
  replay:()=>replayData,
  worldState:()=>worldData,
  modelLab:()=>modelLabData
});

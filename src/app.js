import { MarketSimulator, SYMBOLS } from "./market-sim.js";
import { LearningEngine, FEATURE_LABELS } from "./learning-engine.js";
import { PaperEngine } from "./paper-engine.js";
import { MarketChart } from "./chart.js";

const $ = id => document.getElementById(id);
const money = v => Number(v || 0).toLocaleString(undefined, { style: "currency", currency: "USD" });
const pct = v => (v * 100).toFixed(2) + "%";
const num = v => Number(v || 0).toLocaleString();
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const sim = new MarketSimulator();
const learner = new LearningEngine({ horizonSteps: 15, predictionEvery: 5, learningRate: 0.055 });
const paper = new PaperEngine(100_000);
const chart = new MarketChart($("marketChart"), $("chartTooltip"));

let activeSymbol = "QQQ";
let timeframe = "5m";
let forecastOn = true;
let beginnerOn = true;
let simpleReasons = false;
let autopilot = false;
let latestAnalysis = null;
let lastAutoTradeAt = 0;

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 2600);
}

function valueClass(v) {
  return v > 0 ? "positive" : v < 0 ? "negative" : "neutral";
}

function directionCopy(analysis) {
  if (!analysis) return { title: "Watching", summary: "Collecting enough evidence to form a view." };
  const p = analysis.probabilities;
  const directionalGap = Math.abs(p.up - p.down);
  if (analysis.confidence < 0.61 || directionalGap < 0.15) {
    return {
      title: "Wait — unclear",
      summary: "Buyers and sellers are too evenly matched. The AI would rather do nothing than force a weak prediction."
    };
  }
  if (analysis.direction === "UP") {
    return {
      title: analysis.confidence >= 0.76 ? "Buyers look stronger" : "Leaning upward",
      summary: "Several current signals favor an upward move, but this is still a probability—not a promise."
    };
  }
  return {
    title: analysis.confidence >= 0.76 ? "Sellers look stronger" : "Leaning downward",
    summary: "Several current signals favor a downward move, but the model can still be wrong."
  };
}

function beginnerExplanation(analysis) {
  if (!analysis) return "Trading Eye is watching the chart, activity and the broader market before taking a side.";
  const top = analysis.contributions.slice(0, 3);
  const positives = top.filter(x => x.contribution > 0).length;
  const negatives = top.filter(x => x.contribution < 0).length;

  if (analysis.confidence < 0.61) {
    return "Think of a tug-of-war: neither side is clearly winning. The computer sees mixed clues, so the safest paper decision is to keep watching.";
  }
  if (analysis.direction === "UP") {
    return positives >= 2
      ? "The strongest clues are lining up toward buyers. The AI sees more evidence for price rising than falling, so it is leaning up while continuing to watch for a reversal."
      : "The AI leans upward, but some important clues disagree. Treat this as a weak forecast, not a green light.";
  }
  return negatives >= 2
    ? "The strongest clues are lining up toward sellers. The AI sees more evidence for price falling than rising, so it is leaning down while watching for buyers to return."
    : "The AI leans downward, but some important clues disagree. Treat this as a weak forecast, not a certainty.";
}

function renderWatchlist(snapshot) {
  const wrap = $("watchlist");
  wrap.innerHTML = "";
  for (const [symbol, meta] of Object.entries(SYMBOLS)) {
    const q = snapshot.quotes[symbol];
    const row = document.createElement("div");
    row.className = "watch-row" + (symbol === activeSymbol ? " active" : "");
    row.dataset.symbol = symbol;
    row.innerHTML = `
      <div>
        <div class="watch-symbol">${symbol}</div>
        <div class="watch-name">${meta.name}</div>
      </div>
      <div class="watch-price">
        <strong>${q.price.toFixed(2)}</strong>
        <span class="${valueClass(q.change)}">${q.change >= 0 ? "+" : ""}${pct(q.changePct)}</span>
      </div>`;
    row.addEventListener("click", () => {
      activeSymbol = symbol;
      $("symbolInput").value = symbol;
      renderAll(sim.snapshot());
    });
    wrap.appendChild(row);
  }
}

function renderPulse(pulse) {
  $("marketRegimeBadge").textContent = pulse.regime;
  $("techPulse").textContent = pulse.tech >= 0 ? "Strengthening" : "Weakening";
  $("techPulse").className = valueClass(pulse.tech);
  $("breadthPulse").textContent = Math.round(pulse.breadth * 100) + "% rising";
  $("breadthPulse").className = pulse.breadth >= 0.5 ? "positive" : "negative";
  $("volPulse").textContent = pulse.volatility > 0.35 ? "High" : pulse.volatility < -0.2 ? "Calm" : "Normal";
  $("volPulse").className = pulse.volatility > 0.35 ? "negative" : "neutral";
}

function renderAI(analysis, features) {
  latestAnalysis = analysis;
  const copy = directionCopy(analysis);
  $("decisionTitle").textContent = copy.title;
  $("decisionSummary").textContent = copy.summary;
  $("decisionTitle").className = analysis?.direction === "UP" ? "positive" : analysis?.direction === "DOWN" ? "negative" : "";

  const confidence = analysis ? Math.round(analysis.confidence * 100) : 50;
  $("confidenceValue").textContent = confidence + "%";
  $("confidenceRing").style.setProperty("--confidence", confidence);
  $("probUp").textContent = analysis ? Math.round(analysis.probabilities.up * 100) + "%" : "—";
  $("probFlat").textContent = analysis ? Math.round(analysis.probabilities.flat * 100) + "%" : "—";
  $("probDown").textContent = analysis ? Math.round(analysis.probabilities.down * 100) + "%" : "—";
  $("beginnerExplanation").textContent = beginnerExplanation(analysis);

  if (analysis) {
    $("chartCalloutTitle").textContent = copy.title;
    $("chartCalloutBody").textContent = analysis.confidence >= 0.70
      ? `${Math.round(analysis.confidence * 100)}% model confidence. Forecast is being tracked and scored.`
      : "Not enough agreement yet. Watching instead of forcing a trade.";
  }

  const reasons = $("reasonList");
  reasons.innerHTML = "";
  if (!analysis || !features) return;

  for (const c of analysis.contributions.slice(0, 5)) {
    const label = FEATURE_LABELS[c.key];
    if (!label) continue;
    const positiveForPrice = c.contribution > 0;
    const featurePositive = c.value >= 0;
    const item = document.createElement("div");
    item.className = "reason-item";

    const status = Math.abs(c.contribution) < 0.08 ? "mixed" : positiveForPrice ? "good" : "bad";
    const explain = simpleReasons
      ? (featurePositive ? label.simplePositive : label.simpleNegative)
      : `Current reading ${c.value >= 0 ? "+" : ""}${c.value.toFixed(2)} × learned weight ${c.weight.toFixed(2)}.`;

    item.innerHTML = `
      <span class="reason-dot ${status}"></span>
      <div class="reason-copy"><strong>${label.title}</strong><span>${explain}</span></div>
      <span class="reason-value">${c.contribution >= 0 ? "+" : ""}${c.contribution.toFixed(2)}</span>
    `;
    reasons.appendChild(item);
  }
}

function renderChart(analysis) {
  const candles = sim.getCandles(activeSymbol, timeframe, 150);
  const recent = learner.recentPredictions(80).filter(x => x.symbol === activeSymbol);
  chart.showForecast = forecastOn;
  chart.showBeginner = beginnerOn;
  chart.setData({ candles, analysis, predictions: recent, timeframe });

  const quote = sim.getQuote(activeSymbol);
  const meta = sim.getMeta(activeSymbol);
  const raw = sim.getCandles(activeSymbol, "1m", 30);
  const vwapRows = raw.slice(-20);
  const vwap = recent.reduce((a, x) => a + ((x.high + x.low + x.close) / 3) * x.volume, 0) /
    Math.max(1, recent.reduce((a, x) => a + x.volume, 0));

  $("symbolName").textContent = activeSymbol;
  $("symbolDescription").textContent = meta.name + " · demo";
  $("lastPrice").textContent = quote.price.toFixed(2);
  $("priceChange").textContent = (quote.change >= 0 ? "+" : "") + quote.change.toFixed(2) + " (" + pct(quote.changePct) + ")";
  $("priceChange").className = "price-change " + valueClass(quote.change);
  $("vwapValue").textContent = vwap.toFixed(2);
  $("volumeValue").textContent = num(quote.volume);
  $("spreadValue").textContent = "$" + quote.spread.toFixed(3);
}

function renderTapeAndBook() {
  const tape = sim.getTape(activeSymbol, 28);
  $("tapeBody").innerHTML = tape.map(t => `
    <tr>
      <td>${t.time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</td>
      <td class="${t.side === "BUY" ? "positive" : "negative"}">${t.price.toFixed(2)}</td>
      <td>${num(t.size)}</td>
      <td class="${t.side === "BUY" ? "positive" : "negative"}">${t.side}</td>
    </tr>`).join("");

  const book = sim.getBook(activeSymbol, 10);
  $("bidBook").innerHTML = book.bids.map(x => `
    <div class="book-row"><span class="positive">${x.price.toFixed(2)}</span><span>${num(x.size)}</span><span>${x.orders} orders</span></div>`).join("");
  $("askBook").innerHTML = book.asks.map(x => `
    <div class="book-row"><span class="negative">${x.price.toFixed(2)}</span><span>${num(x.size)}</span><span>${x.orders} orders</span></div>`).join("");
}

function renderPaper() {
  const p = paper.snapshot();
  $("paperEquity").textContent = money(p.equity);
  $("paperCash").textContent = money(p.cash);
  $("openPnl").textContent = money(p.openPnl);
  $("realizedPnl").textContent = money(p.realizedPnl);
  $("paperTrades").textContent = num(p.tradeCount);
  $("openPnl").className = valueClass(p.openPnl);
  $("realizedPnl").className = valueClass(p.realizedPnl);

  if (!p.positions.length) {
    $("positionsTable").innerHTML = "No open paper positions. Use Paper buy / Paper sell, or enable AI autopilot.";
  } else {
    $("positionsTable").innerHTML = p.positions.map(pos => `
      <div class="position-row">
        <strong>${pos.symbol}</strong>
        <span>${pos.qty > 0 ? "LONG" : "SHORT"}</span>
        <span>${Math.abs(pos.qty)} shares</span>
        <span>Avg ${pos.avgPrice.toFixed(2)}</span>
        <span>Mark ${pos.mark.toFixed(2)}</span>
        <strong class="${valueClass(pos.pnl)}">${money(pos.pnl)}</strong>
      </div>`).join("");
  }
}

function renderLearning() {
  const s = learner.statsSnapshot();
  $("accuracyValue").textContent = s.accuracy == null ? "Collecting…" : pct(s.accuracy);
  $("predictionCount").textContent = num(s.predictions);
  $("scoredCount").textContent = num(s.scored);
  $("highConfidenceAccuracy").textContent = s.highConfidenceAccuracy == null ? "Not enough yet" : pct(s.highConfidenceAccuracy);
  $("learningUpdates").textContent = num(s.learningUpdates);

  const rows = learner.recentPredictions(80);
  $("predictionBody").innerHTML = rows.map(p => `
    <tr>
      <td>${new Date(p.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</td>
      <td><strong>${p.symbol}</strong></td>
      <td class="${p.direction === "UP" ? "positive" : "negative"}">${p.direction}</td>
      <td>${Math.round(p.confidence * 100)}%</td>
      <td class="${p.actual == null ? "neutral" : p.correct ? "positive" : "negative"}">${p.actual == null ? "PENDING" : p.correct ? "✓ " + p.actual : "✕ " + p.actual}</td>
    </tr>`).join("");
}

function maybeAutopilot(analysis, quote) {
  if (!autopilot || !analysis || !quote) return;
  const now = Date.now();
  if (now - lastAutoTradeAt < 6500) return;

  const pos = paper.positions[activeSymbol];
  const strong = analysis.confidence >= 0.80;
  const directionQty = pos?.qty || 0;

  if (!pos && strong) {
    const qty = paper.suggestedQty(quote.price, 0.009);
    const side = analysis.direction === "UP" ? "BUY" : "SELL";
    const trade = paper.trade(activeSymbol, side, qty, quote.price, "AI PAPER");
    if (trade) {
      lastAutoTradeAt = now;
      toast(`AI paper trade: ${side} ${qty} ${activeSymbol} @ ${trade.fill.toFixed(2)}`);
    }
    return;
  }

  if (pos) {
    const mark = quote.price;
    const pnlPct = pos.qty > 0 ? (mark - pos.avgPrice) / pos.avgPrice : (pos.avgPrice - mark) / pos.avgPrice;
    const opposite = (pos.qty > 0 && analysis.direction === "DOWN") || (pos.qty < 0 && analysis.direction === "UP");
    if ((opposite && analysis.confidence >= 0.71) || pnlPct >= 0.006 || pnlPct <= -0.0045) {
      const trade = paper.flatten(activeSymbol, quote.price, "AI PAPER");
      if (trade) {
        lastAutoTradeAt = now;
        toast(`AI flattened paper ${activeSymbol} @ ${trade.fill.toFixed(2)}`);
      }
    }
  }
}

function trainAndAnalyze(snapshot) {
  let active = null;

  for (const symbol of Object.keys(SYMBOLS)) {
    const q = snapshot.quotes[symbol];
    const features = sim.getFeatures(symbol);
    paper.mark(symbol, q.price);
    if (!features) continue;

    const result = learner.observe({
      symbol,
      features,
      price: q.price,
      time: snapshot.at
    });

    if (symbol === activeSymbol) active = { ...result, features };
  }

  if (!active) {
    const features = sim.getFeatures(activeSymbol);
    active = { analysis: learner.analyze(features), features, locked: null, scored: [] };
  }
  return active;
}

function renderAll(snapshot, train = false) {
  renderWatchlist(snapshot);
  renderPulse(snapshot.pulse);

  const features = sim.getFeatures(activeSymbol);
  const analysis = train ? trainAndAnalyze(snapshot).analysis : learner.analyze(features);
  const activeFeatures = sim.getFeatures(activeSymbol);

  renderAI(analysis, activeFeatures);
  renderChart(analysis);
  renderTapeAndBook();
  renderPaper();
  renderLearning();

  if (train) maybeAutopilot(analysis, snapshot.quotes[activeSymbol]);
}

function loadSymbol() {
  const requested = $("symbolInput").value.trim().toUpperCase();
  if (!SYMBOLS[requested]) {
    toast("This demo build currently includes SPY, QQQ, NVDA, AAPL, AMD and TSLA.");
    $("symbolInput").value = activeSymbol;
    return;
  }
  activeSymbol = requested;
  renderAll(sim.snapshot());
}

$("loadSymbolBtn").addEventListener("click", loadSymbol);
$("symbolInput").addEventListener("keydown", e => { if (e.key === "Enter") loadSymbol(); });

$("timeframes").addEventListener("click", e => {
  const btn = e.target.closest("button[data-tf]");
  if (!btn) return;
  timeframe = btn.dataset.tf;
  document.querySelectorAll("#timeframes button").forEach(x => x.classList.toggle("active", x === btn));
  renderAll(sim.snapshot());
});

$("pauseBtn").addEventListener("click", () => {
  const running = sim.toggle();
  $("pauseBtn").textContent = running ? "Ⅱ" : "▶";
  $("feedStatus").textContent = running ? "Demo feed running" : "Demo feed paused";
  toast(running ? "Demo market resumed." : "Demo market paused.");
});

$("predictionToggle").addEventListener("click", e => {
  forecastOn = !forecastOn;
  e.currentTarget.classList.toggle("active", forecastOn);
  e.currentTarget.textContent = forecastOn ? "AI forecast on" : "AI forecast off";
  renderAll(sim.snapshot());
});

$("beginnerToggle").addEventListener("click", e => {
  beginnerOn = !beginnerOn;
  e.currentTarget.classList.toggle("active", beginnerOn);
  e.currentTarget.textContent = beginnerOn ? "Beginner labels on" : "Beginner labels off";
  $("aiChartCallout").style.display = beginnerOn ? "" : "none";
});

$("simplifyBtn").addEventListener("click", () => {
  simpleReasons = !simpleReasons;
  $("simplifyBtn").textContent = simpleReasons ? "Show model math" : "Simplify";
  renderAI(latestAnalysis, sim.getFeatures(activeSymbol));
});

$("autopilotToggle").addEventListener("change", e => {
  autopilot = e.target.checked;
  toast(autopilot ? "AI autopilot enabled for PAPER MONEY only." : "AI paper autopilot disabled.");
});

$("paperBuyBtn").addEventListener("click", () => {
  const q = sim.getQuote(activeSymbol);
  const qty = paper.suggestedQty(q.price, 0.008);
  const trade = paper.trade(activeSymbol, "BUY", qty, q.price, "MANUAL PAPER");
  if (trade) toast(`Paper bought ${qty} ${activeSymbol} @ ${trade.fill.toFixed(2)}`);
  renderPaper();
});

$("paperSellBtn").addEventListener("click", () => {
  const q = sim.getQuote(activeSymbol);
  const qty = paper.suggestedQty(q.price, 0.008);
  const trade = paper.trade(activeSymbol, "SELL", qty, q.price, "MANUAL PAPER");
  if (trade) toast(`Paper sold ${qty} ${activeSymbol} @ ${trade.fill.toFixed(2)}`);
  renderPaper();
});

$("flattenBtn").addEventListener("click", () => {
  const q = sim.getQuote(activeSymbol);
  const trade = paper.flatten(activeSymbol, q.price, "MANUAL PAPER");
  toast(trade ? `Paper position flattened @ ${trade.fill.toFixed(2)}` : "No open paper position in " + activeSymbol + ".");
  renderPaper();
});

$("lowerTabs").addEventListener("click", e => {
  const btn = e.target.closest("button[data-tab]");
  if (!btn) return;
  document.querySelectorAll("#lowerTabs button").forEach(x => x.classList.toggle("active", x === btn));
  document.querySelectorAll(".tab-pane").forEach(x => x.classList.remove("active"));
  $("tab-" + btn.dataset.tab).classList.add("active");
});

sim.subscribe(snapshot => renderAll(snapshot, true));
renderAll(sim.snapshot(), false);
sim.start();

window.TradingEye = Object.freeze({
  mode: "DEMO_PAPER",
  getLearningStats: () => learner.statsSnapshot(),
  getPaperAccount: () => paper.snapshot(),
  getActiveSymbol: () => activeSymbol
});

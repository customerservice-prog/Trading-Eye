const SYMBOLS = {
  SPY: { name: "S&P 500 ETF", start: 664.20, beta: 0.90, tech: 0.25, vol: 0.0017 },
  QQQ: { name: "Nasdaq 100 ETF", start: 596.80, beta: 1.05, tech: 0.90, vol: 0.0022 },
  NVDA: { name: "NVIDIA", start: 192.40, beta: 1.28, tech: 1.00, vol: 0.0044 },
  AAPL: { name: "Apple", start: 251.30, beta: 0.90, tech: 0.76, vol: 0.0025 },
  AMD: { name: "AMD", start: 206.60, beta: 1.22, tech: 0.98, vol: 0.0040 },
  TSLA: { name: "Tesla", start: 443.70, beta: 1.18, tech: 0.48, vol: 0.0047 }
};

const TF_MINUTES = { "1m": 1, "5m": 5, "15m": 15, "1h": 60, "1d": 390 };

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function normal() {
  let u = 0, v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function pct(a, b) { return b ? (a - b) / b : 0; }

export class MarketSimulator {
  constructor() {
    this.symbols = SYMBOLS;
    this.series = {};
    this.tape = {};
    this.listeners = new Set();
    this.timer = null;
    this.running = false;
    this.stepCount = 0;
    this.marketBias = 0;
    this.techBias = 0;
    this.regimeClock = 0;
    this.virtualTime = Date.now() - 620 * 60_000;
    this.#seedHistory();
  }

  #seedHistory() {
    for (const symbol of Object.keys(SYMBOLS)) {
      this.series[symbol] = [];
      this.tape[symbol] = [];
    }
    for (let i = 0; i < 620; i++) this.#step(true);
    for (const symbol of Object.keys(SYMBOLS)) this.tape[symbol] = this.tape[symbol].slice(-80);
  }

  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  start(speedMs = 900) {
    if (this.timer) return;
    this.running = true;
    this.timer = setInterval(() => {
      this.#step(false);
      for (const fn of this.listeners) fn(this.snapshot());
    }, speedMs);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.running = false;
  }

  toggle() {
    if (this.running) this.stop(); else this.start();
    return this.running;
  }

  #step(seeding) {
    this.virtualTime += 60_000;
    this.stepCount++;
    this.regimeClock++;

    if (this.regimeClock > 35 + Math.random() * 55) {
      this.marketBias = clamp(this.marketBias * 0.35 + normal() * 0.00042, -0.00075, 0.00075);
      this.techBias = clamp(this.techBias * 0.35 + normal() * 0.00050, -0.0009, 0.0009);
      this.regimeClock = 0;
    } else {
      this.marketBias = clamp(this.marketBias * 0.94 + normal() * 0.000035, -0.00075, 0.00075);
      this.techBias = clamp(this.techBias * 0.93 + normal() * 0.000045, -0.0009, 0.0009);
    }

    const marketShock = normal() * 0.00065;
    const techShock = normal() * 0.0008;

    for (const [symbol, meta] of Object.entries(SYMBOLS)) {
      const s = this.series[symbol];
      const prev = s.length ? s[s.length - 1].close : meta.start;
      const idio = normal() * meta.vol * 0.55;
      const drift =
        this.marketBias * meta.beta +
        this.techBias * meta.tech +
        marketShock * meta.beta +
        techShock * meta.tech * 0.55 +
        idio;

      const open = prev;
      const close = Math.max(1, open * (1 + drift));
      const rangeScale = Math.max(meta.vol * 0.7, Math.abs(drift) * 0.85);
      const high = Math.max(open, close) * (1 + Math.abs(normal()) * rangeScale * 0.38);
      const low = Math.min(open, close) * (1 - Math.abs(normal()) * rangeScale * 0.38);
      const activity = 0.75 + Math.abs(drift) / Math.max(meta.vol, 0.0001) * 1.7 + Math.random() * 0.8;
      const volume = Math.round((70_000 + Math.random() * 130_000) * activity);

      s.push({ time: this.virtualTime, open, high, low, close, volume });
      if (s.length > 1800) s.shift();

      const tradeCount = seeding ? 1 : 3 + Math.floor(Math.random() * 4);
      for (let t = 0; t < tradeCount; t++) {
        const side = Math.random() < clamp(0.5 + drift / Math.max(meta.vol * 5, 0.001), 0.16, 0.84) ? "BUY" : "SELL";
        const noise = normal() * Math.max((high - low) * 0.12, close * 0.00006);
        const tradePrice = clamp(close + noise, low, high);
        this.tape[symbol].unshift({
          time: new Date(this.virtualTime + t * 9000),
          price: tradePrice,
          size: Math.max(1, Math.round(Math.exp(3.5 + Math.random() * 2.2))),
          side
        });
      }
      this.tape[symbol] = this.tape[symbol].slice(0, 100);
    }
  }

  getMeta(symbol) { return SYMBOLS[symbol] || { name: symbol, start: 100, beta: 1, tech: 0.5, vol: 0.003 }; }

  getCandles(symbol, timeframe = "5m", limit = 180) {
    const raw = this.series[symbol] || [];
    const bucket = TF_MINUTES[timeframe] || 5;
    if (bucket === 1) return raw.slice(-limit);

    const out = [];
    for (let i = 0; i < raw.length; i += bucket) {
      const chunk = raw.slice(i, i + bucket);
      if (!chunk.length) continue;
      out.push({
        time: chunk[0].time,
        open: chunk[0].open,
        high: Math.max(...chunk.map(x => x.high)),
        low: Math.min(...chunk.map(x => x.low)),
        close: chunk[chunk.length - 1].close,
        volume: chunk.reduce((sum, x) => sum + x.volume, 0)
      });
    }
    return out.slice(-limit);
  }

  getLast(symbol) {
    const s = this.series[symbol] || [];
    return s[s.length - 1] || null;
  }

  getQuote(symbol) {
    const s = this.series[symbol] || [];
    const last = s[s.length - 1];
    const reference = s[Math.max(0, s.length - 391)] || s[0] || last;
    if (!last) return null;
    const change = last.close - reference.open;
    return {
      symbol,
      price: last.close,
      change,
      changePct: reference.open ? change / reference.open : 0,
      volume: last.volume,
      spread: last.close * (0.00008 + Math.random() * 0.00011)
    };
  }

  getTape(symbol, limit = 22) { return (this.tape[symbol] || []).slice(0, limit); }

  getBook(symbol, depth = 9) {
    const q = this.getQuote(symbol);
    if (!q) return { bids: [], asks: [] };
    const tick = q.price >= 200 ? 0.02 : 0.01;
    const spreadTicks = Math.max(1, Math.round(q.spread / tick));
    const mid = q.price;
    const bestBid = mid - (spreadTicks * tick) / 2;
    const bestAsk = mid + (spreadTicks * tick) / 2;
    const bids = [], asks = [];
    for (let i = 0; i < depth; i++) {
      bids.push({ price: bestBid - i * tick, size: 100 + Math.round(Math.random() * 2200), orders: 1 + Math.floor(Math.random() * 18) });
      asks.push({ price: bestAsk + i * tick, size: 100 + Math.round(Math.random() * 2200), orders: 1 + Math.floor(Math.random() * 18) });
    }
    return { bids, asks };
  }

  getFeatures(symbol) {
    const s = this.series[symbol] || [];
    if (s.length < 40) return null;
    const last = s[s.length - 1];
    const prev3 = s[s.length - 4];
    const prev12 = s[s.length - 13];
    const recent = s.slice(-24);
    const avgVol = recent.slice(0, -1).reduce((a, x) => a + x.volume, 0) / Math.max(1, recent.length - 1);
    const returns = recent.slice(1).map((x, i) => pct(x.close, recent[i].close));
    const rv = Math.sqrt(returns.reduce((a, r) => a + r * r, 0) / Math.max(1, returns.length));
    const body = (last.close - last.open) / Math.max(last.high - last.low, last.close * 0.00001);
    const vwap = recent.reduce((a, x) => a + ((x.high + x.low + x.close) / 3) * x.volume, 0) /
      Math.max(1, recent.reduce((a, x) => a + x.volume, 0));

    const breadthReturns = Object.keys(SYMBOLS).map(sym => {
      const rows = this.series[sym];
      const a = rows[rows.length - 1];
      const b = rows[rows.length - 7];
      return a && b ? pct(a.close, b.close) : 0;
    });
    const breadth = breadthReturns.filter(x => x > 0).length / breadthReturns.length;

    return {
      trend: clamp(pct(last.close, prev12.close) / 0.012, -1, 1),
      momentum: clamp(pct(last.close, prev3.close) / 0.006, -1, 1),
      volume: clamp((last.volume / Math.max(avgVol, 1) - 1) / 1.2, -1, 1),
      volatility: clamp((rv - 0.0017) / 0.0030, -1, 1),
      orderFlow: clamp(body, -1, 1),
      breadth: clamp((breadth - 0.5) * 2, -1, 1),
      vwap: clamp(((last.close - vwap) / Math.max(vwap, 1)) / 0.006, -1, 1)
    };
  }

  getMarketPulse() {
    const returns = Object.keys(SYMBOLS).map(sym => {
      const rows = this.series[sym];
      const last = rows[rows.length - 1];
      const prev = rows[rows.length - 8];
      return last && prev ? pct(last.close, prev.close) : 0;
    });
    const up = returns.filter(r => r > 0).length;
    const avg = returns.reduce((a, b) => a + b, 0) / returns.length;
    const qqq = this.getFeatures("QQQ");
    return {
      breadth: up / returns.length,
      tech: avg,
      volatility: qqq ? qqq.volatility : 0,
      regime: avg > 0.003 ? "Bullish" : avg < -0.003 ? "Bearish" : Math.abs(avg) < 0.0008 ? "Choppy" : "Mixed"
    };
  }

  snapshot() {
    return {
      at: this.virtualTime,
      running: this.running,
      quotes: Object.fromEntries(Object.keys(SYMBOLS).map(s => [s, this.getQuote(s)])),
      pulse: this.getMarketPulse()
    };
  }
}

export { SYMBOLS };

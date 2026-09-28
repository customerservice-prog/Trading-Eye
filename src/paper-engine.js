function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

export class PaperEngine {
  constructor(startingCash = 100_000) {
    this.startingCash = startingCash;
    this.cash = startingCash;
    this.positions = {};
    this.trades = [];
    this.realizedPnl = 0;
    this.equityHigh = startingCash;
    this.maxDrawdown = 0;
    this.lastMarks = {};
    this.#load();
  }

  #load() {
    try {
      const raw = localStorage.getItem("trading-eye-paper-v1");
      if (!raw) return;
      const p = JSON.parse(raw);
      this.cash = Number.isFinite(p.cash) ? p.cash : this.startingCash;
      this.positions = p.positions || {};
      this.trades = Array.isArray(p.trades) ? p.trades.slice(-500) : [];
      this.realizedPnl = Number.isFinite(p.realizedPnl) ? p.realizedPnl : 0;
      this.equityHigh = Number.isFinite(p.equityHigh) ? p.equityHigh : this.startingCash;
      this.maxDrawdown = Number.isFinite(p.maxDrawdown) ? p.maxDrawdown : 0;
    } catch (_) {}
  }

  #save() {
    try {
      localStorage.setItem("trading-eye-paper-v1", JSON.stringify({
        cash: this.cash,
        positions: this.positions,
        trades: this.trades.slice(-500),
        realizedPnl: this.realizedPnl,
        equityHigh: this.equityHigh,
        maxDrawdown: this.maxDrawdown
      }));
    } catch (_) {}
  }

  mark(symbol, price) {
    if (Number.isFinite(price)) this.lastMarks[symbol] = price;
    const eq = this.equity();
    this.equityHigh = Math.max(this.equityHigh, eq);
    if (this.equityHigh > 0) {
      this.maxDrawdown = Math.min(this.maxDrawdown, (eq - this.equityHigh) / this.equityHigh);
    }
  }

  equity() {
    return this.cash + Object.entries(this.positions).reduce((sum, [symbol, p]) => {
      const mark = this.lastMarks[symbol] ?? p.avgPrice;
      return sum + p.qty * mark;
    }, 0);
  }

  openPnl() {
    return Object.entries(this.positions).reduce((sum, [symbol, p]) => {
      const mark = this.lastMarks[symbol] ?? p.avgPrice;
      return sum + (mark - p.avgPrice) * p.qty;
    }, 0);
  }

  trade(symbol, side, qty, referencePrice, source = "MANUAL") {
    qty = Math.max(1, Math.floor(qty));
    if (!Number.isFinite(referencePrice) || referencePrice <= 0) return null;
    const signed = side === "BUY" ? qty : -qty;
    const slip = referencePrice * (0.00005 + Math.random() * 0.00010);
    const fill = side === "BUY" ? referencePrice + slip : referencePrice - slip;
    const old = this.positions[symbol] || { qty: 0, avgPrice: 0 };
    const newQty = old.qty + signed;
    let realized = 0;
    let avgPrice = old.avgPrice;

    if (old.qty === 0 || Math.sign(old.qty) === Math.sign(signed)) {
      const oldNotional = Math.abs(old.qty) * old.avgPrice;
      const addNotional = Math.abs(signed) * fill;
      avgPrice = (oldNotional + addNotional) / Math.max(1, Math.abs(newQty));
    } else {
      const closingQty = Math.min(Math.abs(old.qty), Math.abs(signed));
      realized = (fill - old.avgPrice) * closingQty * Math.sign(old.qty);
      this.realizedPnl += realized;

      if (newQty === 0) avgPrice = 0;
      else if (Math.sign(newQty) !== Math.sign(old.qty)) avgPrice = fill;
    }

    this.cash -= signed * fill;

    if (newQty === 0) delete this.positions[symbol];
    else this.positions[symbol] = { qty: newQty, avgPrice };

    const trade = {
      id: Date.now() + "-" + Math.random().toString(36).slice(2, 8),
      at: Date.now(),
      symbol,
      side,
      qty,
      fill,
      source,
      realized
    };
    this.trades.push(trade);
    this.trades = this.trades.slice(-500);
    this.mark(symbol, fill);
    this.#save();
    return trade;
  }

  flatten(symbol, price, source = "MANUAL") {
    const p = this.positions[symbol];
    if (!p || !p.qty) return null;
    return this.trade(symbol, p.qty > 0 ? "SELL" : "BUY", Math.abs(p.qty), price, source);
  }

  suggestedQty(price, riskFraction = 0.01) {
    const eq = this.equity();
    const notional = clamp(eq * riskFraction * 8, 250, eq * 0.12);
    return Math.max(1, Math.floor(notional / price));
  }

  snapshot() {
    return {
      startingCash: this.startingCash,
      cash: this.cash,
      equity: this.equity(),
      openPnl: this.openPnl(),
      realizedPnl: this.realizedPnl,
      tradeCount: this.trades.length,
      maxDrawdown: this.maxDrawdown,
      positions: Object.entries(this.positions).map(([symbol, p]) => ({
        symbol,
        ...p,
        mark: this.lastMarks[symbol] ?? p.avgPrice,
        pnl: ((this.lastMarks[symbol] ?? p.avgPrice) - p.avgPrice) * p.qty
      }))
    };
  }

  reset() {
    this.cash = this.startingCash;
    this.positions = {};
    this.trades = [];
    this.realizedPnl = 0;
    this.equityHigh = this.startingCash;
    this.maxDrawdown = 0;
    this.lastMarks = {};
    try { localStorage.removeItem("trading-eye-paper-v1"); } catch (_) {}
  }
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function niceTime(ts, timeframe) {
  const d = new Date(ts);
  if (timeframe === "1d") return d.toLocaleDateString([], { month: "short", day: "numeric" });
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export class MarketChart {
  constructor(canvas, tooltip) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.tooltip = tooltip;
    this.candles = [];
    this.analysis = null;
    this.predictions = [];
    this.timeframe = "5m";
    this.showForecast = true;
    this.showBeginner = true;
    this.hover = null;
    this.dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    this.colors = this.#colors();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement);
    canvas.addEventListener("pointermove", e => this.#pointer(e));
    canvas.addEventListener("pointerleave", () => {
      this.hover = null;
      this.tooltip?.classList.add("hidden");
      this.draw();
    });
    this.resize();
  }

  #colors() {
    const s = getComputedStyle(document.documentElement);
    return {
      bg: "#080d14",
      grid: s.getPropertyValue("--line").trim() || "#1e2a3a",
      muted: s.getPropertyValue("--muted").trim() || "#7f91a7",
      text: s.getPropertyValue("--soft").trim() || "#a8b6c8",
      green: s.getPropertyValue("--green").trim() || "#42d392",
      red: s.getPropertyValue("--red").trim() || "#ff6b7a",
      cyan: s.getPropertyValue("--cyan").trim() || "#56d9ff",
      purple: s.getPropertyValue("--purple").trim() || "#9c8cff"
    };
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this.canvas.width = Math.floor(r.width * this.dpr);
    this.canvas.height = Math.floor(r.height * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.draw();
  }

  setData({ candles, analysis, predictions = [], timeframe = "5m" }) {
    this.candles = candles || [];
    this.analysis = analysis || null;
    this.predictions = predictions || [];
    this.timeframe = timeframe;
    this.draw();
  }

  #layout() {
    const r = this.canvas.getBoundingClientRect();
    const W = r.width;
    const H = r.height;
    const pad = { left: 12, right: 66, top: 12, bottom: 22 };
    const volumeH = Math.max(54, H * 0.17);
    const plotH = H - pad.top - pad.bottom - volumeH - 10;
    return { W, H, pad, volumeH, plotH, volumeTop: pad.top + plotH + 10 };
  }

  #visible() {
    const max = this.canvas.getBoundingClientRect().width < 650 ? 55 : 95;
    return this.candles.slice(-max);
  }

  #scales(rows, l) {
    const forecastSlots = this.showForecast ? 15 : 1;
    const futureFraction = this.showForecast ? 0.16 : 0.03;
    let low = Math.min(...rows.map(x => x.low));
    let high = Math.max(...rows.map(x => x.high));
    const last = rows[rows.length - 1]?.close || 1;

    if (this.showForecast && this.analysis) {
      const directional = this.analysis.probabilities.up - this.analysis.probabilities.down;
      const expected = last * (1 + directional * 0.0075);
      const band = last * (0.0035 + (1 - this.analysis.confidence) * 0.010);
      low = Math.min(low, expected - band);
      high = Math.max(high, expected + band);
    }

    const span = Math.max(high - low, last * 0.005);
    low -= span * 0.10;
    high += span * 0.10;
    const chartWidth = l.W - l.pad.left - l.pad.right;
    const actualWidth = chartWidth * (1 - futureFraction);
    const xStep = actualWidth / Math.max(1, rows.length);
    const x = i => l.pad.left + (i + 0.5) * xStep;
    const y = price => l.pad.top + ((high - price) / (high - low)) * l.plotH;
    return { low, high, x, y, xStep, chartWidth, actualWidth, forecastSlots, futureFraction };
  }

  draw() {
    const ctx = this.ctx;
    const l = this.#layout();
    if (!l.W || !l.H) return;
    ctx.clearRect(0, 0, l.W, l.H);
    ctx.fillStyle = this.colors.bg;
    ctx.fillRect(0, 0, l.W, l.H);

    const rows = this.#visible();
    if (rows.length < 2) {
      ctx.fillStyle = this.colors.muted;
      ctx.font = "11px system-ui";
      ctx.fillText("Waiting for market data…", 20, 30);
      return;
    }

    const s = this.#scales(rows, l);
    this.#drawGrid(ctx, l, s, rows);
    if (this.showForecast && this.analysis) this.#drawForecast(ctx, l, s, rows);
    this.#drawVolume(ctx, l, s, rows);
    this.#drawCandles(ctx, l, s, rows);
    this.#drawPredictionMarkers(ctx, l, s, rows);
    this.#drawLastPrice(ctx, l, s, rows);
    if (this.hover) this.#drawCrosshair(ctx, l, s, rows);
  }

  #drawGrid(ctx, l, s, rows) {
    ctx.save();
    ctx.strokeStyle = "rgba(30,42,58,.72)";
    ctx.fillStyle = this.colors.muted;
    ctx.font = "8px system-ui";
    ctx.lineWidth = 1;

    for (let i = 0; i <= 5; i++) {
      const y = l.pad.top + (l.plotH / 5) * i;
      ctx.beginPath(); ctx.moveTo(l.pad.left, y); ctx.lineTo(l.W - l.pad.right + 5, y); ctx.stroke();
      const price = s.high - ((s.high - s.low) / 5) * i;
      ctx.fillText(price.toFixed(price >= 100 ? 2 : 3), l.W - l.pad.right + 10, y + 3);
    }

    const marks = 6;
    for (let i = 0; i <= marks; i++) {
      const idx = Math.min(rows.length - 1, Math.round((rows.length - 1) * (i / marks)));
      const x = s.x(idx);
      ctx.beginPath(); ctx.moveTo(x, l.pad.top); ctx.lineTo(x, l.volumeTop + l.volumeH); ctx.stroke();
      const label = niceTime(rows[idx].time, this.timeframe);
      const w = ctx.measureText(label).width;
      ctx.fillText(label, clamp(x - w / 2, l.pad.left, l.W - l.pad.right - w), l.H - 7);
    }
    ctx.restore();
  }

  #drawVolume(ctx, l, s, rows) {
    const maxV = Math.max(...rows.map(x => x.volume), 1);
    const barW = Math.max(1.5, s.xStep * 0.58);
    ctx.save();
    rows.forEach((c, i) => {
      const h = (c.volume / maxV) * (l.volumeH - 6);
      ctx.fillStyle = c.close >= c.open ? "rgba(66,211,146,.27)" : "rgba(255,107,122,.24)";
      ctx.fillRect(s.x(i) - barW / 2, l.volumeTop + l.volumeH - h, barW, h);
    });
    ctx.restore();
  }

  #drawCandles(ctx, l, s, rows) {
    const bodyW = Math.max(2, Math.min(8, s.xStep * 0.62));
    ctx.save();
    rows.forEach((c, i) => {
      const x = s.x(i);
      const up = c.close >= c.open;
      const color = up ? this.colors.green : this.colors.red;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, s.y(c.high));
      ctx.lineTo(x, s.y(c.low));
      ctx.stroke();

      const yo = s.y(c.open), yc = s.y(c.close);
      const top = Math.min(yo, yc);
      const h = Math.max(1.2, Math.abs(yc - yo));
      ctx.fillRect(x - bodyW / 2, top, bodyW, h);
    });
    ctx.restore();
  }

  #drawForecast(ctx, l, s, rows) {
    const last = rows[rows.length - 1];
    const lastX = s.x(rows.length - 1);
    const direction = this.analysis.probabilities.up - this.analysis.probabilities.down;
    const endX = l.W - l.pad.right - 4;
    const centerEnd = last.close * (1 + direction * 0.0075);
    const uncertainty = last.close * (0.0035 + (1 - this.analysis.confidence) * 0.010);
    const startBand = last.close * 0.0012;

    const upper0 = s.y(last.close + startBand);
    const lower0 = s.y(last.close - startBand);
    const upper1 = s.y(centerEnd + uncertainty);
    const lower1 = s.y(centerEnd - uncertainty);

    ctx.save();
    const grad = ctx.createLinearGradient(lastX, 0, endX, 0);
    grad.addColorStop(0, "rgba(86,217,255,.18)");
    grad.addColorStop(1, "rgba(86,217,255,.035)");
    ctx.fillStyle = grad;
    ctx.strokeStyle = "rgba(86,217,255,.42)";
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(lastX, upper0);
    ctx.lineTo(endX, upper1);
    ctx.lineTo(endX, lower1);
    ctx.lineTo(lastX, lower0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.setLineDash([3, 5]);
    ctx.strokeStyle = "rgba(86,217,255,.62)";
    ctx.beginPath();
    ctx.moveTo(lastX, s.y(last.close));
    ctx.lineTo(endX, s.y(centerEnd));
    ctx.stroke();

    ctx.fillStyle = this.colors.cyan;
    ctx.font = "8px system-ui";
    ctx.fillText("AI expected area", Math.min(endX - 85, lastX + 12), Math.max(l.pad.top + 12, upper1 - 6));
    ctx.restore();
  }

  #drawPredictionMarkers(ctx, l, s, rows) {
    const recent = this.predictions.slice(0, 12);
    if (!recent.length) return;
    ctx.save();
    for (const p of recent) {
      let nearest = 0;
      let best = Infinity;
      rows.forEach((c, i) => {
        const d = Math.abs(c.time - p.time);
        if (d < best) { best = d; nearest = i; }
      });
      if (best > 90 * 60_000) continue;
      const c = rows[nearest];
      const x = s.x(nearest);
      const y = p.direction === "UP" ? s.y(c.low) + 11 : s.y(c.high) - 11;
      ctx.fillStyle = p.actual ? (p.correct ? this.colors.green : this.colors.red) : this.colors.purple;
      ctx.beginPath(); ctx.arc(x, y, 3.2, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  #drawLastPrice(ctx, l, s, rows) {
    const last = rows[rows.length - 1];
    const y = s.y(last.close);
    ctx.save();
    ctx.strokeStyle = last.close >= last.open ? "rgba(66,211,146,.45)" : "rgba(255,107,122,.42)";
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(l.pad.left, y); ctx.lineTo(l.W - l.pad.right + 4, y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = last.close >= last.open ? this.colors.green : this.colors.red;
    ctx.fillRect(l.W - l.pad.right + 6, y - 8, l.pad.right - 10, 16);
    ctx.fillStyle = "#07100d";
    ctx.font = "bold 8px system-ui";
    ctx.fillText(last.close.toFixed(2), l.W - l.pad.right + 11, y + 3);
    ctx.restore();
  }

  #pointer(e) {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    this.hover = { x, y };

    const rows = this.#visible();
    if (!rows.length) return;
    const l = this.#layout();
    const s = this.#scales(rows, l);
    const idx = clamp(Math.round((x - l.pad.left) / Math.max(s.xStep, 1) - 0.5), 0, rows.length - 1);
    const c = rows[idx];
    if (this.tooltip && c && x <= l.W - l.pad.right + 8) {
      this.tooltip.innerHTML = `<strong>${niceTime(c.time, this.timeframe)}</strong><br>O ${c.open.toFixed(2)} &nbsp; H ${c.high.toFixed(2)}<br>L ${c.low.toFixed(2)} &nbsp; C ${c.close.toFixed(2)}<br>Vol ${Math.round(c.volume).toLocaleString()}`;
      this.tooltip.style.left = Math.min(l.W - 160, x + 12) + "px";
      this.tooltip.style.top = Math.max(8, y - 32) + "px";
      this.tooltip.classList.remove("hidden");
    }
    this.draw();
  }

  #drawCrosshair(ctx, l) {
    ctx.save();
    ctx.strokeStyle = "rgba(168,182,200,.28)";
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(this.hover.x, l.pad.top);
    ctx.lineTo(this.hover.x, l.volumeTop + l.volumeH);
    ctx.moveTo(l.pad.left, this.hover.y);
    ctx.lineTo(l.W - l.pad.right, this.hover.y);
    ctx.stroke();
    ctx.restore();
  }
}

const FEATURE_KEYS = ["trend", "momentum", "volume", "volatility", "orderFlow", "breadth", "vwap"];

const DEFAULT_WEIGHTS = {
  trend: 0.72,
  momentum: 0.62,
  volume: 0.24,
  volatility: -0.10,
  orderFlow: 0.50,
  breadth: 0.46,
  vwap: 0.38,
  bias: 0
};

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

export class LearningEngine {
  constructor({ horizonSteps = 12, predictionEvery = 6, learningRate = 0.065 } = {}) {
    this.horizonSteps = horizonSteps;
    this.predictionEvery = predictionEvery;
    this.learningRate = learningRate;
    this.weights = { ...DEFAULT_WEIGHTS };
    this.symbolSteps = {};
    this.pending = [];
    this.history = [];
    this.lastPredictionStep = {};
    this.stats = {
      predictions: 0,
      scored: 0,
      correct: 0,
      highConfidenceScored: 0,
      highConfidenceCorrect: 0,
      learningUpdates: 0
    };
    this.#load();
  }

  #load() {
    try {
      const raw = localStorage.getItem("trading-eye-learning-v1");
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed.weights) this.weights = { ...DEFAULT_WEIGHTS, ...parsed.weights };
      if (parsed.stats) this.stats = { ...this.stats, ...parsed.stats };
      if (Array.isArray(parsed.history)) this.history = parsed.history.slice(-200);
    } catch (_) {}
  }

  #save() {
    try {
      localStorage.setItem("trading-eye-learning-v1", JSON.stringify({
        weights: this.weights,
        stats: this.stats,
        history: this.history.slice(-200)
      }));
    } catch (_) {}
  }

  #rawScore(features) {
    return FEATURE_KEYS.reduce((sum, key) => sum + (features[key] || 0) * (this.weights[key] || 0), this.weights.bias || 0);
  }

  analyze(features) {
    const raw = this.#rawScore(features);
    const directional = sigmoid(raw * 1.8);
    const certainty = Math.abs(directional - 0.5) * 2;
    const flat = clamp(0.28 - certainty * 0.20 + Math.max(0, features.volatility) * 0.025, 0.07, 0.30);
    const remainder = 1 - flat;
    const up = directional * remainder;
    const down = (1 - directional) * remainder;
    const confidence = clamp(Math.max(up, down) + certainty * 0.12, 0.50, 0.94);
    const direction = up > down ? "UP" : "DOWN";

    const contributions = FEATURE_KEYS.map(key => ({
      key,
      value: features[key] || 0,
      weight: this.weights[key] || 0,
      contribution: (features[key] || 0) * (this.weights[key] || 0)
    })).sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

    return {
      direction,
      raw,
      confidence,
      probabilities: { up, flat, down },
      contributions
    };
  }

  observe({ symbol, features, price, time }) {
    this.step += 1;
    const scored = [];

    for (const p of this.pending.filter(x => x.symbol === symbol && symbolStep - x.step >= this.horizonSteps)) {
      const move = (price - p.price) / p.price;
      const actual = move > 0.0010 ? "UP" : move < -0.0010 ? "DOWN" : "FLAT";
      const predicted = p.direction;
      const correct = predicted === actual || (actual === "FLAT" && p.probabilities.flat >= Math.max(p.probabilities.up, p.probabilities.down));

      this.stats.scored += 1;
      if (correct) this.stats.correct += 1;
      if (p.confidence >= 0.72) {
        this.stats.highConfidenceScored += 1;
        if (correct) this.stats.highConfidenceCorrect += 1;
      }

      const target = actual === "UP" ? 1 : actual === "DOWN" ? 0 : 0.5;
      const predictedUp = p.probabilities.up / Math.max(0.0001, p.probabilities.up + p.probabilities.down);
      const error = target - predictedUp;
      for (const key of FEATURE_KEYS) {
        this.weights[key] = clamp(
          this.weights[key] + this.learningRate * error * (p.features[key] || 0),
          -2.25,
          2.25
        );
      }
      this.weights.bias = clamp(this.weights.bias + this.learningRate * error * 0.25, -0.75, 0.75);
      this.stats.learningUpdates += 1;

      const row = {
        ...p,
        resultPrice: price,
        resultMove: move,
        actual,
        correct,
        scoredAt: time
      };
      this.history.unshift(row);
      scored.push(row);
    }

    if (scored.length) {
      const ids = new Set(scored.map(x => x.id));
      this.pending = this.pending.filter(x => !ids.has(x.id));
      this.history = this.history.slice(0, 300);
      this.#save();
    }

    let locked = null;
    const lastStep = this.lastPredictionStep[symbol] ?? -Infinity;
    if (symbolStep - lastStep >= this.predictionEvery) {
      const a = this.analyze(features);
      locked = {
        id: symbol + "-" + time + "-" + symbolStep,
        symbol,
        time,
        step: symbolStep,
        price,
        features: { ...features },
        direction: a.direction,
        confidence: a.confidence,
        probabilities: { ...a.probabilities },
        raw: a.raw
      };
      this.pending.push(locked);
      this.lastPredictionStep[symbol] = symbolStep;
      this.stats.predictions += 1;
      this.#save();
    }

    return { analysis: this.analyze(features), locked, scored };
  }

  statsSnapshot() {
    const accuracy = this.stats.scored ? this.stats.correct / this.stats.scored : null;
    const highConfidenceAccuracy = this.stats.highConfidenceScored
      ? this.stats.highConfidenceCorrect / this.stats.highConfidenceScored
      : null;
    return {
      ...this.stats,
      accuracy,
      highConfidenceAccuracy,
      weights: { ...this.weights },
      pending: this.pending.length
    };
  }

  recentPredictions(limit = 80) {
    const pendingRows = this.pending.slice().reverse().map(p => ({ ...p, actual: null, correct: null }));
    return [...pendingRows, ...this.history].sort((a, b) => b.time - a.time).slice(0, limit);
  }

  resetLearning() {
    this.weights = { ...DEFAULT_WEIGHTS };
    this.pending = [];
    this.history = [];
    this.lastPredictionStep = {};
    this.stats = {
      predictions: 0,
      scored: 0,
      correct: 0,
      highConfidenceScored: 0,
      highConfidenceCorrect: 0,
      learningUpdates: 0
    };
    try { localStorage.removeItem("trading-eye-learning-v1"); } catch (_) {}
  }
}

export const FEATURE_LABELS = {
  trend: {
    title: "Price trend",
    simplePositive: "Price has been climbing over the recent window.",
    simpleNegative: "Price has been falling over the recent window."
  },
  momentum: {
    title: "Short-term momentum",
    simplePositive: "The latest candles are accelerating upward.",
    simpleNegative: "The latest candles are accelerating downward."
  },
  volume: {
    title: "Volume",
    simplePositive: "More trading activity than usual is supporting the move.",
    simpleNegative: "Trading activity is lighter than usual, so the move has less support."
  },
  volatility: {
    title: "Volatility",
    simplePositive: "Price is moving around more than normal.",
    simpleNegative: "Price movement is relatively calm."
  },
  orderFlow: {
    title: "Buying vs. selling",
    simplePositive: "The latest candle shows buyers pushing price toward the high.",
    simpleNegative: "The latest candle shows sellers pushing price toward the low."
  },
  breadth: {
    title: "Broader market",
    simplePositive: "More symbols in the watchlist are rising together.",
    simpleNegative: "More symbols in the watchlist are weakening together."
  },
  vwap: {
    title: "Price vs. average",
    simplePositive: "Price is above its recent volume-weighted average.",
    simpleNegative: "Price is below its recent volume-weighted average."
  }
};

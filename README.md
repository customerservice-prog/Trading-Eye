# Trading Eye

Trading Eye is a beginner-first trading terminal inspired by the workflow of thinkorswim/TradingView, with an AI learning layer built directly into the charting experience.

## What this first build does

- Thinkorswim-style multi-panel desktop terminal
- Live-feeling candlestick chart with volume and prediction cone
- Watchlist, time & sales, synthetic Level II, paper account and learning stats
- Beginner explanations beside every AI prediction
- Adaptive prediction engine that learns from its own locked predictions
- Every prediction is scored after its horizon expires
- Paper trading only; real-money trading is intentionally locked
- Optional AI autopilot can place simulated paper trades when confidence is high
- Persistent learning statistics in the browser
- Clear provider boundary for replacing the demo feed with licensed real market data later

## Safety / integrity rule

The current repository ships in **DEMO MARKET / PAPER MONEY** mode. It does not pretend generated prices are live exchange data and it cannot place real orders.

That is intentional. A real feed should be connected through a market-data adapter before any claim of live market coverage is made. Real brokerage execution should remain a separate, explicit later phase after long out-of-sample and paper-trading validation.

## Run locally

This is a dependency-free static web application.

```bash
python -m http.server 8080
```

Then open:

```
http://localhost:8080
```

You can also serve the repository with any static host.

## Docker / Railway

```bash
docker build -t trading-eye .
docker run -p 8080:80 trading-eye
```

The included `Dockerfile` serves the app with nginx.

## Architecture

```
src/
  app.js               terminal UI controller
  chart.js             canvas candlestick/volume/prediction renderer
  learning-engine.js   online adaptive probability model + scoring
  market-sim.js        correlated demo market feed
  paper-engine.js      simulated account, fills, positions and P/L
```

The next production phase should add:

1. Licensed historical + streaming market-data provider
2. Server-side ingestion and normalized market-event storage
3. Options, futures, breadth, news, filings and macro feeds
4. Feature store and historical market-state search
5. Walk-forward backtesting and leakage guards
6. Server-side model registry / experiment tracking
7. Broker paper-account integration
8. Only after validation: separately permissioned, capped real-money execution

## Product principle

The UI always answers five beginner questions:

1. What is the market doing?
2. What does the AI think happens next?
3. Why?
4. How confident is it?
5. Has the AI actually earned trust over time?

Trading Eye should make complex market information understandable without pretending uncertainty does not exist.

# Trading Eye

Trading Eye is a beginner-first market terminal with a persistent learning engine.

## Production integrity rule

Trading Eye is now **REAL-DATA-ONLY**.

It does not generate fallback prices, synthetic candles, fake trades, fake quotes, or fake Level II depth.

If a real provider is unavailable, the UI shows that data is unavailable.

## Current production architecture

- Node.js service running continuously on Railway
- PostgreSQL persistent database
- Alpaca real-time market-data adapter
- Authenticated WebSocket ingestion for real trades, quotes, and 1-minute bars
- Historical real-bar backfill
- Raw provider events stored with provider, feed, and source timestamp
- Persistent model state
- Server-side prediction creation and scoring
- 15-minute prediction horizon
- Historical time-ordered training segment
- Separate historical holdout validation segment
- Separate live prediction accuracy
- Browser frontend consumes only backend real-data APIs/WebSockets
- Paper account only; real brokerage execution is not connected

## Feed coverage

The configured default is:

```
ALPACA_FEED=iex
```

That means real-time data from **IEX only**. It must not be described as the entire U.S. market.

If the connected Alpaca subscription permits SIP:

```
ALPACA_FEED=sip
```

SIP is consolidated U.S. stock-market coverage.

The exact active feed is shown in the UI.

## 24/7 behavior

The Trading Eye service itself runs continuously even when no browser is open.

During periods when the configured stock feed has no market events, Trading Eye does not manufacture candles. It remains online, preserves model/data state, maintains health checks, and resumes ingestion when the provider sends real events.

## Required Railway variables

```
DATABASE_URL=${{Postgres.DATABASE_URL}}
ALPACA_API_KEY_ID=<real Alpaca key>
ALPACA_API_SECRET_KEY=<real Alpaca secret>
PORT=80
```

Optional:

```
ALPACA_FEED=iex
TRADING_SYMBOLS=SPY,QQQ,NVDA,AAPL,AMD,TSLA
BACKFILL_DAYS=30
```

## What is stored

### raw_market_events
Provider-native trade, quote, and bar messages.

### market_bars_1m
Normalized real one-minute bars.

### predictions
Predictions stored before their result exists, including probability, features, model version, target time, and later scored outcome.

### model_state
Persistent model weights and learning statistics.

### service_heartbeats
24/7 engine health and provider status.

## Learning integrity

Historical training and live proof are deliberately separated.

Historical data:
1. Older chronological portion is used for training.
2. Later holdout portion is evaluated without learning from those answers.

Live data:
1. Prediction is written to Postgres.
2. Its target timestamp is fixed.
3. After the target time arrives, the real market result is scored.
4. Only then can the model learn from that result.

Historical holdout accuracy is **not** presented as live accuracy.

## Paper trading

Paper-money fills are simulations and are labeled as such.

The reference market prices must come from the real provider.

There is currently no code path that can send a real brokerage order.

## Local run

```bash
npm install
DATABASE_URL=... \
ALPACA_API_KEY_ID=... \
ALPACA_API_SECRET_KEY=... \
ALPACA_FEED=iex \
PORT=8080 \
npm start
```

Then open:

```
http://localhost:8080
```

## Next data layers

The architecture is designed to add real sources for:

- consolidated SIP stock data
- true depth / Level II or Level III
- options chains and Greeks
- futures
- market breadth
- news
- SEC filings
- macroeconomic releases
- corporate actions
- earnings/analyst events

Each source must remain explicitly identified in the stored data and UI.

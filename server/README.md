# Trading Eye real-data service

This service is fail-closed.

- It never creates synthetic prices.
- It never creates synthetic trades or quotes.
- If Alpaca credentials are missing or invalid, market data remains unavailable.
- Every stored event includes provider, feed and provider timestamp.
- IEX means IEX-only coverage; it must never be labeled as consolidated U.S. market data.
- SIP means consolidated U.S. exchange coverage available under the connected Alpaca subscription.
- Predictions are stored before outcomes and scored only after their target horizon.
- Model state is persisted in Postgres.
- The process remains online even when no browser is open.

Required production variables:

- DATABASE_URL
- ALPACA_API_KEY_ID
- ALPACA_API_SECRET_KEY

Optional:

- ALPACA_FEED=iex (or sip if subscription permits)
- TRADING_SYMBOLS=SPY,QQQ,NVDA,AAPL,AMD,TSLA
- BACKFILL_DAYS=30

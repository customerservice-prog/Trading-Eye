import pg from "pg";

const { Pool } = pg;

export class Database {
  constructor(connectionString) {
    this.pool = connectionString ? new Pool({ connectionString, max: 10 }) : null;
    this.ready = false;
  }

  async init() {
    if (!this.pool) return false;
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS raw_market_events (
        id BIGSERIAL PRIMARY KEY,
        provider TEXT NOT NULL,
        feed TEXT NOT NULL,
        event_type TEXT NOT NULL,
        symbol TEXT,
        event_ts TIMESTAMPTZ NOT NULL,
        received_ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        payload JSONB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS raw_market_events_symbol_ts
        ON raw_market_events(symbol, event_ts DESC);
      CREATE INDEX IF NOT EXISTS raw_market_events_type_ts
        ON raw_market_events(event_type, event_ts DESC);

      CREATE TABLE IF NOT EXISTS market_bars_1m (
        provider TEXT NOT NULL,
        feed TEXT NOT NULL,
        symbol TEXT NOT NULL,
        ts TIMESTAMPTZ NOT NULL,
        open DOUBLE PRECISION NOT NULL,
        high DOUBLE PRECISION NOT NULL,
        low DOUBLE PRECISION NOT NULL,
        close DOUBLE PRECISION NOT NULL,
        volume DOUBLE PRECISION NOT NULL,
        trade_count INTEGER,
        vwap DOUBLE PRECISION,
        source TEXT NOT NULL DEFAULT 'stream',
        inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY(provider, feed, symbol, ts)
      );
      CREATE INDEX IF NOT EXISTS market_bars_symbol_ts
        ON market_bars_1m(symbol, ts DESC);

      CREATE TABLE IF NOT EXISTS predictions (
        id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        provider TEXT NOT NULL,
        feed TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        target_at TIMESTAMPTZ NOT NULL,
        horizon_minutes INTEGER NOT NULL,
        reference_price DOUBLE PRECISION NOT NULL,
        direction TEXT NOT NULL,
        confidence DOUBLE PRECISION NOT NULL,
        p_up DOUBLE PRECISION NOT NULL,
        p_flat DOUBLE PRECISION NOT NULL,
        p_down DOUBLE PRECISION NOT NULL,
        features JSONB NOT NULL,
        model_version INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING',
        result_price DOUBLE PRECISION,
        result_return DOUBLE PRECISION,
        actual_direction TEXT,
        correct BOOLEAN,
        scored_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS predictions_symbol_created
        ON predictions(symbol, created_at DESC);
      CREATE INDEX IF NOT EXISTS predictions_pending_target
        ON predictions(status, target_at);

      CREATE TABLE IF NOT EXISTS model_state (
        model_key TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        weights JSONB NOT NULL,
        stats JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS service_heartbeats (
        service_key TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        details JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    this.ready = true;
    return true;
  }

  async ping() {
    if (!this.pool) return false;
    try {
      await this.pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  async upsertBar(bar) {
    if (!this.ready) return;
    await this.pool.query(`
      INSERT INTO market_bars_1m
        (provider,feed,symbol,ts,open,high,low,close,volume,trade_count,vwap,source)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT(provider,feed,symbol,ts) DO UPDATE SET
        open=EXCLUDED.open, high=EXCLUDED.high, low=EXCLUDED.low,
        close=EXCLUDED.close, volume=EXCLUDED.volume,
        trade_count=EXCLUDED.trade_count, vwap=EXCLUDED.vwap,
        source=EXCLUDED.source
    `,[
      bar.provider,bar.feed,bar.symbol,bar.ts,bar.open,bar.high,bar.low,bar.close,
      bar.volume,bar.tradeCount ?? null,bar.vwap ?? null,bar.source || "stream"
    ]);
  }

  async upsertBarsBatch(bars) {
    if (!this.ready || !bars.length) return;
    const values=[];
    const rows=[];
    bars.forEach((bar,i)=>{
      const n=i*12;
      rows.push("(" + Array.from({length:12},(_,j)=>"$"+(n+j+1)).join(",") + ")");
      values.push(
        bar.provider,bar.feed,bar.symbol,bar.ts,bar.open,bar.high,bar.low,bar.close,
        bar.volume,bar.tradeCount ?? null,bar.vwap ?? null,bar.source || "historical"
      );
    });
    await this.pool.query(`
      INSERT INTO market_bars_1m
        (provider,feed,symbol,ts,open,high,low,close,volume,trade_count,vwap,source)
      VALUES ${rows.join(",")}
      ON CONFLICT(provider,feed,symbol,ts) DO UPDATE SET
        open=EXCLUDED.open,high=EXCLUDED.high,low=EXCLUDED.low,close=EXCLUDED.close,
        volume=EXCLUDED.volume,trade_count=EXCLUDED.trade_count,vwap=EXCLUDED.vwap,
        source=EXCLUDED.source
    `,values);
  }

  async insertRawBatch(events) {
    if (!this.ready || !events.length) return;
    const values=[];
    const rows=[];
    events.forEach((e,i)=>{
      const n=i*6;
      rows.push(`($${n+1},$${n+2},$${n+3},$${n+4},$${n+5},$${n+6}::jsonb)`);
      values.push(e.provider,e.feed,e.type,e.symbol || null,e.ts,JSON.stringify(e.payload));
    });
    await this.pool.query(`
      INSERT INTO raw_market_events(provider,feed,event_type,symbol,event_ts,payload)
      VALUES ${rows.join(",")}
    `,values);
  }

  async getBars(symbol,{limit=500,start=null,end=null}={}) {
    if (!this.ready) return [];
    const params=[symbol];
    let where="WHERE symbol=$1";
    if (start) { params.push(start); where+=` AND ts >= $${params.length}`; }
    if (end) { params.push(end); where+=` AND ts <= $${params.length}`; }
    params.push(Math.max(1,Math.min(100000,limit)));
    const q=await this.pool.query(`
      SELECT provider,feed,symbol,ts,open,high,low,close,volume,trade_count,vwap,source
      FROM market_bars_1m
      ${where}
      ORDER BY ts DESC
      LIMIT $${params.length}
    `,params);
    return q.rows.reverse();
  }

  async getLatestBars(symbols) {
    if (!this.ready || !symbols.length) return {};
    const q=await this.pool.query(`
      SELECT DISTINCT ON (symbol)
        symbol,provider,feed,ts,open,high,low,close,volume,trade_count,vwap,source
      FROM market_bars_1m
      WHERE symbol = ANY($1::text[])
      ORDER BY symbol, ts DESC
    `,[symbols]);
    return Object.fromEntries(q.rows.map(r=>[r.symbol,r]));
  }

  async savePrediction(p) {
    if (!this.ready) return;
    await this.pool.query(`
      INSERT INTO predictions
        (id,symbol,provider,feed,created_at,target_at,horizon_minutes,reference_price,
         direction,confidence,p_up,p_flat,p_down,features,model_version)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15)
      ON CONFLICT(id) DO NOTHING
    `,[
      p.id,p.symbol,p.provider,p.feed,p.createdAt,p.targetAt,p.horizonMinutes,
      p.referencePrice,p.direction,p.confidence,p.pUp,p.pFlat,p.pDown,
      JSON.stringify(p.features),p.modelVersion
    ]);
  }

  async pendingPredictions(symbol,at) {
    if (!this.ready) return [];
    const q=await this.pool.query(`
      SELECT * FROM predictions
      WHERE symbol=$1 AND status='PENDING' AND target_at <= $2
      ORDER BY target_at
    `,[symbol,at]);
    return q.rows;
  }

  async scorePrediction(id,{resultPrice,resultReturn,actualDirection,correct,scoredAt}) {
    if (!this.ready) return;
    await this.pool.query(`
      UPDATE predictions SET
        status='SCORED', result_price=$2, result_return=$3,
        actual_direction=$4, correct=$5, scored_at=$6
      WHERE id=$1
    `,[id,resultPrice,resultReturn,actualDirection,correct,scoredAt]);
  }

  async recentPredictions({symbol=null,limit=100}={}) {
    if (!this.ready) return [];
    const params=[];
    let where="";
    if (symbol) { params.push(symbol); where="WHERE symbol=$1"; }
    params.push(Math.max(1,Math.min(1000,limit)));
    const q=await this.pool.query(`
      SELECT * FROM predictions ${where}
      ORDER BY created_at DESC LIMIT $${params.length}
    `,params);
    return q.rows;
  }

  async predictionStats() {
    if (!this.ready) return null;
    const q=await this.pool.query(`
      SELECT
        COUNT(*)::int AS predictions,
        COUNT(*) FILTER (WHERE status='SCORED')::int AS scored,
        COUNT(*) FILTER (WHERE status='SCORED' AND correct=true)::int AS correct,
        COUNT(*) FILTER (WHERE status='SCORED' AND confidence >= .72)::int AS high_conf_scored,
        COUNT(*) FILTER (WHERE status='SCORED' AND confidence >= .72 AND correct=true)::int AS high_conf_correct
      FROM predictions
    `);
    return q.rows[0];
  }

  async loadModel(key) {
    if (!this.ready) return null;
    const q=await this.pool.query("SELECT * FROM model_state WHERE model_key=$1",[key]);
    return q.rows[0] || null;
  }

  async saveModel(key,version,weights,stats) {
    if (!this.ready) return;
    await this.pool.query(`
      INSERT INTO model_state(model_key,version,weights,stats,updated_at)
      VALUES($1,$2,$3::jsonb,$4::jsonb,NOW())
      ON CONFLICT(model_key) DO UPDATE SET
        version=EXCLUDED.version,weights=EXCLUDED.weights,stats=EXCLUDED.stats,updated_at=NOW()
    `,[key,version,JSON.stringify(weights),JSON.stringify(stats)]);
  }

  async heartbeat(key,status,details={}) {
    if (!this.ready) return;
    await this.pool.query(`
      INSERT INTO service_heartbeats(service_key,status,details,updated_at)
      VALUES($1,$2,$3::jsonb,NOW())
      ON CONFLICT(service_key) DO UPDATE SET
        status=EXCLUDED.status,details=EXCLUDED.details,updated_at=NOW()
    `,[key,status,JSON.stringify(details)]);
  }
}

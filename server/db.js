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

      CREATE TABLE IF NOT EXISTS daily_market_studies (
        study_date DATE NOT NULL,
        stage TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'RUNNING',
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        symbols JSONB NOT NULL DEFAULT '{}'::jsonb,
        market JSONB NOT NULL DEFAULT '{}'::jsonb,
        prediction_review JSONB NOT NULL DEFAULT '{}'::jsonb,
        pattern_findings JSONB NOT NULL DEFAULT '{}'::jsonb,
        analogs JSONB NOT NULL DEFAULT '[]'::jsonb,
        lessons JSONB NOT NULL DEFAULT '[]'::jsonb,
        model_version INTEGER,
        error TEXT,
        PRIMARY KEY(study_date, stage)
      );
      CREATE INDEX IF NOT EXISTS daily_market_studies_completed
        ON daily_market_studies(completed_at DESC);

      CREATE TABLE IF NOT EXISTS pattern_memory (
        symbol TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        horizon_minutes INTEGER NOT NULL,
        sample_count INTEGER NOT NULL DEFAULT 0,
        up_count INTEGER NOT NULL DEFAULT 0,
        flat_count INTEGER NOT NULL DEFAULT 0,
        down_count INTEGER NOT NULL DEFAULT 0,
        avg_return DOUBLE PRECISION NOT NULL DEFAULT 0,
        avg_abs_return DOUBLE PRECISION NOT NULL DEFAULT 0,
        avg_mfe DOUBLE PRECISION NOT NULL DEFAULT 0,
        avg_mae DOUBLE PRECISION NOT NULL DEFAULT 0,
        last_seen TIMESTAMPTZ,
        context JSONB NOT NULL DEFAULT '{}'::jsonb,
        PRIMARY KEY(symbol,fingerprint,horizon_minutes)
      );
      CREATE INDEX IF NOT EXISTS pattern_memory_strength
        ON pattern_memory(sample_count DESC);
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

  async getBackfillStart(symbols,defaultStart) {
    if (!this.ready || !symbols.length) return defaultStart;
    const q=await this.pool.query(`
      WITH latest AS (
        SELECT symbol, MAX(ts) AS latest_ts
        FROM market_bars_1m
        WHERE symbol = ANY($1::text[])
        GROUP BY symbol
      )
      SELECT COUNT(*)::int AS covered, MIN(latest_ts) AS oldest_latest
      FROM latest
    `,[symbols]);
    const row=q.rows[0];
    if (!row || Number(row.covered)!==symbols.length || !row.oldest_latest) return defaultStart;
    return new Date(new Date(row.oldest_latest).getTime()-10*60*1000);
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

  async getSessionBars(studyDate,{startTime="09:30:00",endTime="16:00:00"}={}) {
    if (!this.ready) return [];
    const q=await this.pool.query(`
      SELECT provider,feed,symbol,ts,open,high,low,close,volume,trade_count,vwap,source
      FROM market_bars_1m
      WHERE (ts AT TIME ZONE 'America/New_York')::date = $1::date
        AND (ts AT TIME ZONE 'America/New_York')::time >= $2::time
        AND (ts AT TIME ZONE 'America/New_York')::time < $3::time
      ORDER BY symbol, ts
    `,[studyDate,startTime,endTime]);
    return q.rows;
  }

  async getPredictionReview(studyDate) {
    if (!this.ready) return [];
    const q=await this.pool.query(`
      SELECT id,symbol,created_at,target_at,horizon_minutes,reference_price,direction,
             confidence,p_up,p_flat,p_down,features,model_version,status,result_price,
             result_return,actual_direction,correct,scored_at
      FROM predictions
      WHERE (created_at AT TIME ZONE 'America/New_York')::date = $1::date
      ORDER BY created_at
    `,[studyDate]);
    return q.rows;
  }

  async beginDailyStudy(studyDate,stage,modelVersion) {
    if (!this.ready) return;
    await this.pool.query(`
      INSERT INTO daily_market_studies(study_date,stage,status,started_at,model_version)
      VALUES($1,$2,'RUNNING',NOW(),$3)
      ON CONFLICT(study_date,stage) DO UPDATE SET
        status='RUNNING',started_at=NOW(),completed_at=NULL,error=NULL,model_version=EXCLUDED.model_version
    `,[studyDate,stage,modelVersion]);
  }

  async completeDailyStudy(studyDate,stage,payload) {
    if (!this.ready) return;
    await this.pool.query(`
      UPDATE daily_market_studies SET
        status='COMPLETE',completed_at=NOW(),
        symbols=$3::jsonb,market=$4::jsonb,prediction_review=$5::jsonb,
        pattern_findings=$6::jsonb,analogs=$7::jsonb,lessons=$8::jsonb,error=NULL
      WHERE study_date=$1 AND stage=$2
    `,[
      studyDate,stage,
      JSON.stringify(payload.symbols||{}),JSON.stringify(payload.market||{}),
      JSON.stringify(payload.predictionReview||{}),JSON.stringify(payload.patternFindings||{}),
      JSON.stringify(payload.analogs||[]),JSON.stringify(payload.lessons||[])
    ]);
  }

  async failDailyStudy(studyDate,stage,error) {
    if (!this.ready) return;
    await this.pool.query(`
      UPDATE daily_market_studies
      SET status='ERROR',completed_at=NOW(),error=$3
      WHERE study_date=$1 AND stage=$2
    `,[studyDate,stage,String(error).slice(0,2000)]);
  }

  async hasCompletedStudy(studyDate,stage) {
    if (!this.ready) return false;
    const q=await this.pool.query(`
      SELECT 1 FROM daily_market_studies
      WHERE study_date=$1 AND stage=$2 AND status='COMPLETE'
      LIMIT 1
    `,[studyDate,stage]);
    return q.rowCount>0;
  }

  async recentStudies({limit=30,stage="regular_close"}={}) {
    if (!this.ready) return [];
    const q=await this.pool.query(`
      SELECT study_date,stage,status,started_at,completed_at,symbols,market,
             prediction_review,pattern_findings,analogs,lessons,model_version,error
      FROM daily_market_studies
      WHERE stage=$1
      ORDER BY study_date DESC
      LIMIT $2
    `,[stage,Math.max(1,Math.min(365,limit))]);
    return q.rows;
  }

  async upsertPatternAggregate(row) {
    if (!this.ready) return;
    await this.pool.query(`
      INSERT INTO pattern_memory(
        symbol,fingerprint,horizon_minutes,sample_count,up_count,flat_count,down_count,
        avg_return,avg_abs_return,avg_mfe,avg_mae,last_seen,context
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
      ON CONFLICT(symbol,fingerprint,horizon_minutes) DO UPDATE SET
        sample_count=EXCLUDED.sample_count,
        up_count=EXCLUDED.up_count,
        flat_count=EXCLUDED.flat_count,
        down_count=EXCLUDED.down_count,
        avg_return=EXCLUDED.avg_return,
        avg_abs_return=EXCLUDED.avg_abs_return,
        avg_mfe=EXCLUDED.avg_mfe,
        avg_mae=EXCLUDED.avg_mae,
        last_seen=EXCLUDED.last_seen,
        context=EXCLUDED.context
    `,[
      row.symbol,row.fingerprint,row.horizonMinutes,row.sampleCount,
      row.upCount,row.flatCount,row.downCount,row.avgReturn,row.avgAbsReturn,
      row.avgMfe,row.avgMae,row.lastSeen,JSON.stringify(row.context||{})
    ]);
  }

  async updatePatternMemory(row) {
    if (!this.ready) return;
    await this.pool.query(`
      INSERT INTO pattern_memory(
        symbol,fingerprint,horizon_minutes,sample_count,up_count,flat_count,down_count,
        avg_return,avg_abs_return,avg_mfe,avg_mae,last_seen,context
      ) VALUES($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
      ON CONFLICT(symbol,fingerprint,horizon_minutes) DO UPDATE SET
        sample_count=pattern_memory.sample_count+1,
        up_count=pattern_memory.up_count+EXCLUDED.up_count,
        flat_count=pattern_memory.flat_count+EXCLUDED.flat_count,
        down_count=pattern_memory.down_count+EXCLUDED.down_count,
        avg_return=((pattern_memory.avg_return*pattern_memory.sample_count)+EXCLUDED.avg_return)/(pattern_memory.sample_count+1),
        avg_abs_return=((pattern_memory.avg_abs_return*pattern_memory.sample_count)+EXCLUDED.avg_abs_return)/(pattern_memory.sample_count+1),
        avg_mfe=((pattern_memory.avg_mfe*pattern_memory.sample_count)+EXCLUDED.avg_mfe)/(pattern_memory.sample_count+1),
        avg_mae=((pattern_memory.avg_mae*pattern_memory.sample_count)+EXCLUDED.avg_mae)/(pattern_memory.sample_count+1),
        last_seen=EXCLUDED.last_seen,
        context=EXCLUDED.context
    `,[
      row.symbol,row.fingerprint,row.horizonMinutes,
      row.direction==="UP"?1:0,row.direction==="FLAT"?1:0,row.direction==="DOWN"?1:0,
      row.return,row.absReturn,row.mfe,row.mae,row.lastSeen,JSON.stringify(row.context||{})
    ]);
  }

  async getPattern(symbol,fingerprint,horizonMinutes) {
    if (!this.ready) return null;
    const q=await this.pool.query(`
      SELECT symbol,fingerprint,horizon_minutes,sample_count,up_count,flat_count,down_count,
             avg_return,avg_abs_return,avg_mfe,avg_mae,last_seen,context
      FROM pattern_memory
      WHERE symbol=$1 AND fingerprint=$2 AND horizon_minutes=$3
      LIMIT 1
    `,[symbol,fingerprint,horizonMinutes]);
    return q.rows[0]||null;
  }

  async topPatterns({symbol=null,minSamples=12,limit=30}={}) {
    if (!this.ready) return [];
    const safeLimit=Math.max(1,Math.min(200,Number(limit)||30));
    const params=[minSamples];
    let where="WHERE sample_count >= $1";
    if (symbol) {
      params.push(symbol);
      where+=" AND symbol=$2";
    }
    const q=await this.pool.query(`
      SELECT symbol,fingerprint,horizon_minutes,sample_count,up_count,flat_count,down_count,
             avg_return,avg_abs_return,avg_mfe,avg_mae,last_seen,context
      FROM pattern_memory
      ${where}
      ORDER BY sample_count DESC, ABS(avg_return) DESC
      LIMIT ${safeLimit}
    `,params);
    return q.rows;
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

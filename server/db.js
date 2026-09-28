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
      CREATE TABLE IF NOT EXISTS asset_universe (
        symbol TEXT PRIMARY KEY,
        name TEXT,
        exchange TEXT,
        asset_class TEXT NOT NULL DEFAULT 'us_equity',
        status TEXT NOT NULL,
        tradable BOOLEAN NOT NULL DEFAULT false,
        fractionable BOOLEAN NOT NULL DEFAULT false,
        shortable BOOLEAN NOT NULL DEFAULT false,
        easy_to_borrow BOOLEAN NOT NULL DEFAULT false,
        marginable BOOLEAN NOT NULL DEFAULT false,
        data_supported BOOLEAN NOT NULL DEFAULT true,
        scanner_eligible BOOLEAN NOT NULL DEFAULT true,
        attributes JSONB NOT NULL DEFAULT '[]'::jsonb,
        provider TEXT NOT NULL DEFAULT 'alpaca',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS asset_universe_status_exchange
        ON asset_universe(status,exchange,symbol);
      CREATE INDEX IF NOT EXISTS asset_universe_name_search
        ON asset_universe(LOWER(name));
      ALTER TABLE asset_universe
        ADD COLUMN IF NOT EXISTS scanner_eligible BOOLEAN NOT NULL DEFAULT true;

      CREATE TABLE IF NOT EXISTS market_bars_1d (
        provider TEXT NOT NULL,
        feed TEXT NOT NULL,
        symbol TEXT NOT NULL,
        day DATE NOT NULL,
        open DOUBLE PRECISION NOT NULL,
        high DOUBLE PRECISION NOT NULL,
        low DOUBLE PRECISION NOT NULL,
        close DOUBLE PRECISION NOT NULL,
        volume DOUBLE PRECISION NOT NULL,
        trade_count INTEGER,
        vwap DOUBLE PRECISION,
        inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY(provider,feed,symbol,day)
      );
      CREATE INDEX IF NOT EXISTS market_bars_1d_symbol_day
        ON market_bars_1d(symbol,day DESC);

      CREATE TABLE IF NOT EXISTS universe_scan_runs (
        scan_date DATE PRIMARY KEY,
        scan_version INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'RUNNING',
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        assets_scanned INTEGER NOT NULL DEFAULT 0,
        daily_bars INTEGER NOT NULL DEFAULT 0,
        candidates INTEGER NOT NULL DEFAULT 0,
        deep_assets INTEGER NOT NULL DEFAULT 0,
        deep_bars INTEGER NOT NULL DEFAULT 0,
        error TEXT
      );

      ALTER TABLE universe_scan_runs
        ADD COLUMN IF NOT EXISTS scan_version INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE universe_scan_runs
        ADD COLUMN IF NOT EXISTS deep_assets INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE universe_scan_runs
        ADD COLUMN IF NOT EXISTS deep_bars INTEGER NOT NULL DEFAULT 0;

      CREATE TABLE IF NOT EXISTS universe_scan_results (
        scan_date DATE NOT NULL,
        symbol TEXT NOT NULL,
        close DOUBLE PRECISION,
        return_1d DOUBLE PRECISION,
        return_5d DOUBLE PRECISION,
        return_20d DOUBLE PRECISION,
        avg_volume_20 DOUBLE PRECISION,
        relative_volume DOUBLE PRECISION,
        realized_vol_20 DOUBLE PRECISION,
        avg_range_20 DOUBLE PRECISION,
        interesting_score DOUBLE PRECISION,
        deep_score DOUBLE PRECISION,
        intraday_profile JSONB NOT NULL DEFAULT '{}'::jsonb,
        details JSONB NOT NULL DEFAULT '{}'::jsonb,
        PRIMARY KEY(scan_date,symbol)
      );
      ALTER TABLE universe_scan_results
        ADD COLUMN IF NOT EXISTS deep_score DOUBLE PRECISION;
      ALTER TABLE universe_scan_results
        ADD COLUMN IF NOT EXISTS intraday_profile JSONB NOT NULL DEFAULT '{}'::jsonb;
      CREATE INDEX IF NOT EXISTS universe_scan_results_rank
        ON universe_scan_results(scan_date,interesting_score DESC);

      CREATE TABLE IF NOT EXISTS market_regime_daily (
        scan_date DATE PRIMARY KEY,
        regime TEXT NOT NULL,
        confidence DOUBLE PRECISION NOT NULL,
        metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
        reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS market_regime_daily_latest
        ON market_regime_daily(scan_date DESC);

      CREATE TABLE IF NOT EXISTS universe_intraday_profiles (
        scan_date DATE NOT NULL,
        symbol TEXT NOT NULL,
        bars_5m INTEGER NOT NULL DEFAULT 0,
        sessions INTEGER NOT NULL DEFAULT 0,
        last_day_return DOUBLE PRECISION,
        open30_return DOUBLE PRECISION,
        midday_return DOUBLE PRECISION,
        power_hour_return DOUBLE PRECISION,
        first_hour_range DOUBLE PRECISION,
        realized_vol_5d DOUBLE PRECISION,
        open_volume_share DOUBLE PRECISION,
        close_volume_share DOUBLE PRECISION,
        trend_follow_rate DOUBLE PRECISION,
        reversal_rate DOUBLE PRECISION,
        deep_score DOUBLE PRECISION,
        profile JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY(scan_date,symbol)
      );
      CREATE INDEX IF NOT EXISTS universe_intraday_rank
        ON universe_intraday_profiles(scan_date,deep_score DESC);

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
      ALTER TABLE predictions ADD COLUMN IF NOT EXISTS model_id TEXT;
      ALTER TABLE predictions ADD COLUMN IF NOT EXISTS model_details JSONB NOT NULL DEFAULT '{}'::jsonb;

      CREATE TABLE IF NOT EXISTS model_registry (
        model_id TEXT PRIMARY KEY,
        family TEXT NOT NULL,
        horizon_minutes INTEGER NOT NULL,
        status TEXT NOT NULL,
        trained_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        train_start TIMESTAMPTZ,
        train_end TIMESTAMPTZ,
        feature_names JSONB NOT NULL DEFAULT '[]'::jsonb,
        artifact JSONB NOT NULL,
        calibration JSONB NOT NULL DEFAULT '{}'::jsonb,
        validation_metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
        test_metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
        walk_forward_metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
        shadow_metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
        live_shadow_metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
        shadow_started_at TIMESTAMPTZ,
        dataset JSONB NOT NULL DEFAULT '{}'::jsonb,
        promoted_at TIMESTAMPTZ,
        parent_model_id TEXT,
        notes TEXT
      );
      ALTER TABLE model_registry ADD COLUMN IF NOT EXISTS walk_forward_metrics JSONB NOT NULL DEFAULT '{}'::jsonb;
      ALTER TABLE model_registry ADD COLUMN IF NOT EXISTS live_shadow_metrics JSONB NOT NULL DEFAULT '{}'::jsonb;
      ALTER TABLE model_registry ADD COLUMN IF NOT EXISTS shadow_started_at TIMESTAMPTZ;
      CREATE INDEX IF NOT EXISTS model_registry_horizon_status
        ON model_registry(horizon_minutes,status,trained_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS model_registry_one_production_per_horizon
        ON model_registry(horizon_minutes)
        WHERE status='PRODUCTION';

      CREATE TABLE IF NOT EXISTS model_lab_runs (
        run_id TEXT PRIMARY KEY,
        horizon_minutes INTEGER NOT NULL,
        status TEXT NOT NULL,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        dataset JSONB NOT NULL DEFAULT '{}'::jsonb,
        candidates JSONB NOT NULL DEFAULT '[]'::jsonb,
        winner_model_id TEXT,
        promotion_reason TEXT,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS model_lab_runs_recent
        ON model_lab_runs(started_at DESC);

      CREATE TABLE IF NOT EXISTS model_shadow_predictions (
        model_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        target_at TIMESTAMPTZ NOT NULL,
        reference_price DOUBLE PRECISION NOT NULL,
        direction TEXT NOT NULL,
        confidence DOUBLE PRECISION NOT NULL,
        p_up DOUBLE PRECISION NOT NULL,
        p_flat DOUBLE PRECISION NOT NULL,
        p_down DOUBLE PRECISION NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING',
        result_price DOUBLE PRECISION,
        result_return DOUBLE PRECISION,
        actual_direction TEXT,
        correct BOOLEAN,
        scored_at TIMESTAMPTZ,
        PRIMARY KEY(model_id,symbol,created_at)
      );
      CREATE INDEX IF NOT EXISTS model_shadow_due
        ON model_shadow_predictions(status,target_at);
      CREATE INDEX IF NOT EXISTS model_shadow_scored_model
        ON model_shadow_predictions(model_id,status,created_at);

      CREATE TABLE IF NOT EXISTS paper_accounts (
        account_id TEXT PRIMARY KEY,
        starting_cash DOUBLE PRECISION NOT NULL,
        cash DOUBLE PRECISION NOT NULL,
        realized_pnl DOUBLE PRECISION NOT NULL DEFAULT 0,
        autopilot_enabled BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS paper_positions (
        account_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        qty INTEGER NOT NULL,
        avg_price DOUBLE PRECISION NOT NULL,
        opened_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY(account_id,symbol)
      );

      CREATE TABLE IF NOT EXISTS paper_orders (
        order_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        qty INTEGER NOT NULL,
        order_type TEXT NOT NULL DEFAULT 'MARKET',
        status TEXT NOT NULL,
        source TEXT NOT NULL,
        model_id TEXT,
        requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        filled_at TIMESTAMPTZ,
        reference_quote JSONB NOT NULL DEFAULT '{}'::jsonb,
        reject_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS paper_orders_recent
        ON paper_orders(account_id,requested_at DESC);

      CREATE TABLE IF NOT EXISTS paper_fills (
        fill_id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        qty INTEGER NOT NULL,
        fill_price DOUBLE PRECISION NOT NULL,
        market_bid DOUBLE PRECISION,
        market_ask DOUBLE PRECISION,
        quote_ts TIMESTAMPTZ,
        fill_model TEXT NOT NULL,
        realized_pnl DOUBLE PRECISION NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      ALTER TABLE paper_fills ADD COLUMN IF NOT EXISTS realized_pnl DOUBLE PRECISION NOT NULL DEFAULT 0;
      CREATE INDEX IF NOT EXISTS paper_fills_recent
        ON paper_fills(account_id,created_at DESC);

      CREATE TABLE IF NOT EXISTS paper_equity_snapshots (
        account_id TEXT NOT NULL,
        ts TIMESTAMPTZ NOT NULL,
        equity DOUBLE PRECISION NOT NULL,
        cash DOUBLE PRECISION NOT NULL,
        open_pnl DOUBLE PRECISION NOT NULL,
        realized_pnl DOUBLE PRECISION NOT NULL,
        positions JSONB NOT NULL DEFAULT '[]'::jsonb,
        PRIMARY KEY(account_id,ts)
      );

      CREATE TABLE IF NOT EXISTS model_state (
        model_key TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        weights JSONB NOT NULL,
        stats JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS research_jobs (
        job_key TEXT PRIMARY KEY,
        job_type TEXT NOT NULL,
        status TEXT NOT NULL,
        phase TEXT,
        provider TEXT,
        progress DOUBLE PRECISION NOT NULL DEFAULT 0,
        items_done BIGINT NOT NULL DEFAULT 0,
        items_total BIGINT,
        bars_processed BIGINT NOT NULL DEFAULT 0,
        details JSONB NOT NULL DEFAULT '{}'::jsonb,
        started_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS research_jobs_status_updated
        ON research_jobs(status,updated_at DESC);

      CREATE TABLE IF NOT EXISTS research_events (
        id BIGSERIAL PRIMARY KEY,
        event_ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        category TEXT NOT NULL,
        level TEXT NOT NULL DEFAULT 'INFO',
        job_key TEXT,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        details JSONB NOT NULL DEFAULT '{}'::jsonb
      );
      CREATE INDEX IF NOT EXISTS research_events_ts
        ON research_events(event_ts DESC);
      CREATE INDEX IF NOT EXISTS research_events_job
        ON research_events(job_key,event_ts DESC);

      CREATE TABLE IF NOT EXISTS research_pattern_findings (
        finding_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        scope TEXT NOT NULL,
        symbol TEXT,
        pattern_key TEXT NOT NULL,
        horizon_days INTEGER NOT NULL,
        sample_count INTEGER NOT NULL,
        hit_rate DOUBLE PRECISION,
        avg_forward_return DOUBLE PRECISION,
        median_forward_return DOUBLE PRECISION,
        avg_adverse_return DOUBLE PRECISION,
        avg_favorable_return DOUBLE PRECISION,
        score DOUBLE PRECISION NOT NULL,
        description TEXT NOT NULL,
        evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
        validation_version TEXT NOT NULL DEFAULT 'legacy',
        discovery_metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
        validation_metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
        holdout_metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
        first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        status TEXT NOT NULL DEFAULT 'CANDIDATE'
      );
      ALTER TABLE research_pattern_findings
        ADD COLUMN IF NOT EXISTS validation_version TEXT NOT NULL DEFAULT 'legacy';
      ALTER TABLE research_pattern_findings
        ADD COLUMN IF NOT EXISTS discovery_metrics JSONB NOT NULL DEFAULT '{}'::jsonb;
      ALTER TABLE research_pattern_findings
        ADD COLUMN IF NOT EXISTS validation_metrics JSONB NOT NULL DEFAULT '{}'::jsonb;
      ALTER TABLE research_pattern_findings
        ADD COLUMN IF NOT EXISTS holdout_metrics JSONB NOT NULL DEFAULT '{}'::jsonb;
      CREATE INDEX IF NOT EXISTS research_pattern_findings_rank
        ON research_pattern_findings(score DESC,last_seen DESC);

      CREATE TABLE IF NOT EXISTS long_history_bars_1d (
        provider TEXT NOT NULL,
        symbol TEXT NOT NULL,
        day DATE NOT NULL,
        open DOUBLE PRECISION NOT NULL,
        high DOUBLE PRECISION NOT NULL,
        low DOUBLE PRECISION NOT NULL,
        close DOUBLE PRECISION NOT NULL,
        volume DOUBLE PRECISION NOT NULL DEFAULT 0,
        inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY(provider,symbol,day)
      );
      CREATE INDEX IF NOT EXISTS long_history_symbol_day
        ON long_history_bars_1d(symbol,day DESC);
      CREATE INDEX IF NOT EXISTS long_history_day
        ON long_history_bars_1d(day);

      CREATE TABLE IF NOT EXISTS historical_security_master (
        symbol TEXT PRIMARY KEY,
        first_day DATE,
        last_day DATE,
        current_active BOOLEAN NOT NULL DEFAULT false,
        survivorship_class TEXT NOT NULL DEFAULT 'UNKNOWN',
        current_name TEXT,
        current_exchange TEXT,
        source TEXT NOT NULL DEFAULT 'long_history',
        bars BIGINT NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS historical_security_master_survivorship
        ON historical_security_master(survivorship_class,last_day DESC);

      CREATE TABLE IF NOT EXISTS corporate_action_flags (
        flag_id BIGSERIAL PRIMARY KEY,
        symbol TEXT NOT NULL,
        action_day DATE NOT NULL,
        action_type TEXT NOT NULL,
        confidence DOUBLE PRECISION NOT NULL DEFAULT 0,
        source TEXT NOT NULL,
        details JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(symbol,action_day,action_type,source)
      );
      CREATE INDEX IF NOT EXISTS corporate_action_flags_symbol_day
        ON corporate_action_flags(symbol,action_day DESC);

      CREATE TABLE IF NOT EXISTS data_quality_flags (
        flag_id BIGSERIAL PRIMARY KEY,
        severity TEXT NOT NULL,
        scope TEXT NOT NULL,
        symbol TEXT,
        flag_type TEXT NOT NULL,
        message TEXT NOT NULL,
        details JSONB NOT NULL DEFAULT '{}'::jsonb,
        active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resolved_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS data_quality_flags_active
        ON data_quality_flags(active,severity,created_at DESC);

      CREATE TABLE IF NOT EXISTS market_events (
        event_id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        symbol TEXT,
        event_type TEXT NOT NULL,
        headline TEXT,
        event_ts TIMESTAMPTZ NOT NULL,
        importance DOUBLE PRECISION NOT NULL DEFAULT 0,
        details JSONB NOT NULL DEFAULT '{}'::jsonb,
        inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS market_events_symbol_ts
        ON market_events(symbol,event_ts DESC);
      CREATE INDEX IF NOT EXISTS market_events_type_ts
        ON market_events(event_type,event_ts DESC);

      ALTER TABLE model_shadow_predictions
        ADD COLUMN IF NOT EXISTS regime TEXT;
      ALTER TABLE model_shadow_predictions
        ADD COLUMN IF NOT EXISTS time_bucket TEXT;
      ALTER TABLE model_shadow_predictions
        ADD COLUMN IF NOT EXISTS confidence_bucket TEXT;
      ALTER TABLE model_shadow_predictions
        ADD COLUMN IF NOT EXISTS model_details JSONB NOT NULL DEFAULT '{}'::jsonb;

      ALTER TABLE paper_orders
        ADD COLUMN IF NOT EXISTS filled_qty INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE paper_orders
        ADD COLUMN IF NOT EXISTS avg_fill_price DOUBLE PRECISION;
      ALTER TABLE paper_orders
        ADD COLUMN IF NOT EXISTS fees DOUBLE PRECISION NOT NULL DEFAULT 0;
      ALTER TABLE paper_orders
        ADD COLUMN IF NOT EXISTS execution_details JSONB NOT NULL DEFAULT '{}'::jsonb;

      ALTER TABLE paper_fills
        ADD COLUMN IF NOT EXISTS fees DOUBLE PRECISION NOT NULL DEFAULT 0;
      ALTER TABLE paper_fills
        ADD COLUMN IF NOT EXISTS slippage_bps DOUBLE PRECISION NOT NULL DEFAULT 0;
      ALTER TABLE paper_fills
        ADD COLUMN IF NOT EXISTS impact_bps DOUBLE PRECISION NOT NULL DEFAULT 0;
      ALTER TABLE paper_fills
        ADD COLUMN IF NOT EXISTS participation_rate DOUBLE PRECISION;

      CREATE TABLE IF NOT EXISTS readiness_gates (
        gate_key TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        passed BOOLEAN NOT NULL DEFAULT false,
        current_value JSONB NOT NULL DEFAULT '{}'::jsonb,
        requirement JSONB NOT NULL DEFAULT '{}'::jsonb,
        message TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      ALTER TABLE readiness_gates ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'UNKNOWN';
      ALTER TABLE readiness_gates ADD COLUMN IF NOT EXISTS passed BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE readiness_gates ADD COLUMN IF NOT EXISTS current_value JSONB NOT NULL DEFAULT '{}'::jsonb;
      ALTER TABLE readiness_gates ADD COLUMN IF NOT EXISTS requirement JSONB NOT NULL DEFAULT '{}'::jsonb;
      ALTER TABLE readiness_gates ADD COLUMN IF NOT EXISTS message TEXT NOT NULL DEFAULT '';
      ALTER TABLE readiness_gates ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

      CREATE TABLE IF NOT EXISTS readiness_snapshots (
        id BIGSERIAL PRIMARY KEY,
        evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        status TEXT NOT NULL,
        eligible BOOLEAN NOT NULL DEFAULT false,
        score DOUBLE PRECISION NOT NULL DEFAULT 0,
        gates JSONB NOT NULL DEFAULT '[]'::jsonb,
        notes JSONB NOT NULL DEFAULT '[]'::jsonb
      );
      ALTER TABLE readiness_snapshots ADD COLUMN IF NOT EXISTS evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
      ALTER TABLE readiness_snapshots ADD COLUMN IF NOT EXISTS measured_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
      ALTER TABLE readiness_snapshots ALTER COLUMN measured_at SET DEFAULT NOW();
      ALTER TABLE readiness_snapshots ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'LOCKED';
      ALTER TABLE readiness_snapshots ADD COLUMN IF NOT EXISTS eligible BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE readiness_snapshots ADD COLUMN IF NOT EXISTS score DOUBLE PRECISION NOT NULL DEFAULT 0;
      ALTER TABLE readiness_snapshots ADD COLUMN IF NOT EXISTS gates JSONB NOT NULL DEFAULT '[]'::jsonb;
      ALTER TABLE readiness_snapshots ADD COLUMN IF NOT EXISTS notes JSONB NOT NULL DEFAULT '[]'::jsonb;
      CREATE INDEX IF NOT EXISTS readiness_snapshots_recent
        ON readiness_snapshots(evaluated_at DESC);

      CREATE TABLE IF NOT EXISTS drift_alerts (
        alert_id BIGSERIAL PRIMARY KEY,
        model_id TEXT,
        status TEXT NOT NULL,
        metric TEXT NOT NULL,
        baseline DOUBLE PRECISION,
        recent DOUBLE PRECISION,
        ratio DOUBLE PRECISION,
        sample_count INTEGER NOT NULL DEFAULT 0,
        details JSONB NOT NULL DEFAULT '{}'::jsonb,
        active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resolved_at TIMESTAMPTZ
      );
      ALTER TABLE drift_alerts ADD COLUMN IF NOT EXISTS model_id TEXT;
      ALTER TABLE drift_alerts ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'UNKNOWN';
      ALTER TABLE drift_alerts ADD COLUMN IF NOT EXISTS metric TEXT NOT NULL DEFAULT 'UNKNOWN';
      ALTER TABLE drift_alerts ADD COLUMN IF NOT EXISTS baseline DOUBLE PRECISION;
      ALTER TABLE drift_alerts ADD COLUMN IF NOT EXISTS recent DOUBLE PRECISION;
      ALTER TABLE drift_alerts ADD COLUMN IF NOT EXISTS ratio DOUBLE PRECISION;
      ALTER TABLE drift_alerts ADD COLUMN IF NOT EXISTS sample_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE drift_alerts ADD COLUMN IF NOT EXISTS details JSONB NOT NULL DEFAULT '{}'::jsonb;
      ALTER TABLE drift_alerts ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;
      ALTER TABLE drift_alerts ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
      ALTER TABLE drift_alerts ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
      CREATE INDEX IF NOT EXISTS drift_alerts_active
        ON drift_alerts(active,status,created_at DESC);

      CREATE TABLE IF NOT EXISTS proof_scoreboard (
        stage_key TEXT PRIMARY KEY,
        stage_order INTEGER NOT NULL,
        label TEXT NOT NULL,
        status TEXT NOT NULL,
        progress DOUBLE PRECISION NOT NULL DEFAULT 0,
        summary TEXT NOT NULL,
        details JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      ALTER TABLE proof_scoreboard ADD COLUMN IF NOT EXISTS stage_order INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE proof_scoreboard ADD COLUMN IF NOT EXISTS label TEXT NOT NULL DEFAULT '';
      ALTER TABLE proof_scoreboard ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'PROVING';
      ALTER TABLE proof_scoreboard ADD COLUMN IF NOT EXISTS progress DOUBLE PRECISION NOT NULL DEFAULT 0;
      ALTER TABLE proof_scoreboard ADD COLUMN IF NOT EXISTS summary TEXT NOT NULL DEFAULT '';
      ALTER TABLE proof_scoreboard ADD COLUMN IF NOT EXISTS details JSONB NOT NULL DEFAULT '{}'::jsonb;
      ALTER TABLE proof_scoreboard ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

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

  async upsertAssets(assets) {
    if (!this.ready || !assets.length) return;
    for (let i=0;i<assets.length;i+=500) {
      const chunk=assets.slice(i,i+500);
      const values=[];
      const rows=[];
      chunk.forEach((a,j)=>{
        const n=j*14;
        rows.push("(" + Array.from({length:14},(_,k)=>"$"+(n+k+1)).join(",") + ")");
        values.push(
          a.symbol,a.name||null,a.exchange||null,a.assetClass||"us_equity",a.status||"active",
          Boolean(a.tradable),Boolean(a.fractionable),Boolean(a.shortable),Boolean(a.easyToBorrow),
          Boolean(a.marginable),Boolean(a.dataSupported),Boolean(a.scannerEligible),
          JSON.stringify(a.attributes||[]),"alpaca"
        );
      });
      await this.pool.query(`
        INSERT INTO asset_universe(
          symbol,name,exchange,asset_class,status,tradable,fractionable,shortable,easy_to_borrow,
          marginable,data_supported,scanner_eligible,attributes,provider
        ) VALUES ${rows.join(",")}
        ON CONFLICT(symbol) DO UPDATE SET
          name=EXCLUDED.name,exchange=EXCLUDED.exchange,asset_class=EXCLUDED.asset_class,
          status=EXCLUDED.status,tradable=EXCLUDED.tradable,fractionable=EXCLUDED.fractionable,
          shortable=EXCLUDED.shortable,easy_to_borrow=EXCLUDED.easy_to_borrow,
          marginable=EXCLUDED.marginable,data_supported=EXCLUDED.data_supported,
          scanner_eligible=EXCLUDED.scanner_eligible,
          attributes=EXCLUDED.attributes,provider=EXCLUDED.provider,updated_at=NOW()
      `,values);
    }
  }

  async assetStats() {
    if (!this.ready) return {active:0,dataSupported:0};
    const q=await this.pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status='active')::int AS active,
        COUNT(*) FILTER (WHERE status='active' AND data_supported=true)::int AS data_supported
      FROM asset_universe
    `);
    const r=q.rows[0]||{};
    return {active:Number(r.active)||0,dataSupported:Number(r.data_supported)||0};
  }

  async findAsset(symbol) {
    if (!this.ready) return null;
    const q=await this.pool.query(`
      SELECT symbol,name,exchange,asset_class,status,tradable,fractionable,shortable,easy_to_borrow,
             marginable,data_supported,scanner_eligible,attributes
      FROM asset_universe WHERE symbol=$1 LIMIT 1
    `,[String(symbol).toUpperCase()]);
    return q.rows[0]||null;
  }

  async searchAssets(query,{limit=25}={}) {
    if (!this.ready) return [];
    const q=String(query||"").trim();
    if (!q) return [];
    const n=Math.max(1,Math.min(100,Number(limit)||25));
    const r=await this.pool.query(`
      SELECT symbol,name,exchange,asset_class,status,tradable,fractionable,shortable,data_supported,scanner_eligible,attributes
      FROM asset_universe
      WHERE status='active'
        AND (symbol ILIKE $1 OR name ILIKE $2)
      ORDER BY
        CASE WHEN symbol=UPPER($3) THEN 0 WHEN symbol ILIKE $4 THEN 1 ELSE 2 END,
        symbol
      LIMIT ${n}
    `,[q+"%", "%"+q+"%", q, q+"%"]);
    return r.rows;
  }

  async listActiveAssets({limit=10000,dataSupportedOnly=true,scannerEligibleOnly=false}={}) {
    if (!this.ready) return [];
    const n=Math.max(1,Math.min(20000,Number(limit)||10000));
    const filters=["status='active'"];
    if (dataSupportedOnly) filters.push("data_supported=true");
    if (scannerEligibleOnly) filters.push("scanner_eligible=true");
    const where="WHERE "+filters.join(" AND ");
    const q=await this.pool.query(`
      SELECT symbol,name,exchange,asset_class,status,tradable,fractionable,shortable,data_supported,scanner_eligible,attributes
      FROM asset_universe ${where}
      ORDER BY symbol LIMIT ${n}
    `);
    return q.rows;
  }

  async coreSchemaCheck() {
    if (!this.pool) return {ok:false,tables:[],missingTables:["no_pool"],missingColumns:[]};
    const requiredTables=[
      "model_registry","model_lab_runs","model_shadow_predictions",
      "paper_accounts","paper_positions","paper_orders","paper_fills","paper_equity_snapshots"
    ];
    const requiredColumns=[
      ["model_registry","walk_forward_metrics"],
      ["model_registry","live_shadow_metrics"],
      ["model_registry","shadow_started_at"],
      ["paper_fills","realized_pnl"],
      ["predictions","model_id"],
      ["predictions","model_details"]
    ];
    const t=await this.pool.query(`
      SELECT tablename FROM pg_tables
      WHERE schemaname='public' AND tablename = ANY($1::text[])
    `,[requiredTables]);
    const foundTables=t.rows.map(r=>r.tablename);
    const missingTables=requiredTables.filter(x=>!foundTables.includes(x));
    const c=await this.pool.query(`
      SELECT table_name,column_name
      FROM information_schema.columns
      WHERE table_schema='public'
    `);
    const colSet=new Set(c.rows.map(r=>r.table_name+"."+r.column_name));
    const missingColumns=requiredColumns
      .filter(([table,column])=>!colSet.has(table+"."+column))
      .map(([table,column])=>table+"."+column);
    return {
      ok:missingTables.length===0&&missingColumns.length===0,
      tables:foundTables.sort(),
      missingTables,
      missingColumns
    };
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

  async upsertDailyBarsBatch(bars) {
    if (!this.ready || !bars.length) return;
    for (let i=0;i<bars.length;i+=800) {
      const chunk=bars.slice(i,i+800);
      const values=[];
      const rows=[];
      chunk.forEach((bar,j)=>{
        const n=j*11;
        rows.push("(" + Array.from({length:11},(_,k)=>"$"+(n+k+1)).join(",") + ")");
        values.push(
          bar.provider,bar.feed,bar.symbol,bar.day,bar.open,bar.high,bar.low,bar.close,
          bar.volume,bar.tradeCount??null,bar.vwap??null
        );
      });
      await this.pool.query(`
        INSERT INTO market_bars_1d(
          provider,feed,symbol,day,open,high,low,close,volume,trade_count,vwap
        ) VALUES ${rows.join(",")}
        ON CONFLICT(provider,feed,symbol,day) DO UPDATE SET
          open=EXCLUDED.open,high=EXCLUDED.high,low=EXCLUDED.low,close=EXCLUDED.close,
          volume=EXCLUDED.volume,trade_count=EXCLUDED.trade_count,vwap=EXCLUDED.vwap
      `,values);
    }
  }

  async universeScannedSymbols(scanDate) {
    if (!this.ready) return [];
    const q=await this.pool.query(`
      SELECT symbol FROM universe_scan_results WHERE scan_date=$1
    `,[scanDate]);
    return q.rows.map(r=>r.symbol);
  }

  async beginUniverseScan(scanDate,scanVersion=1) {
    if (!this.ready) return;
    await this.pool.query(`
      INSERT INTO universe_scan_runs(scan_date,scan_version,status,started_at)
      VALUES($1,$2,'RUNNING',NOW())
      ON CONFLICT(scan_date) DO UPDATE SET
        scan_version=EXCLUDED.scan_version,status='RUNNING',started_at=NOW(),
        completed_at=NULL,error=NULL,assets_scanned=0,daily_bars=0,candidates=0,
        deep_assets=0,deep_bars=0
    `,[scanDate,scanVersion]);
  }

  async saveUniverseScanResults(scanDate,rows) {
    if (!this.ready || !rows.length) return;
    for (let i=0;i<rows.length;i+=700) {
      const chunk=rows.slice(i,i+700);
      const values=[];
      const placeholders=[];
      chunk.forEach((r,j)=>{
        const n=j*11;
        placeholders.push("(" + Array.from({length:11},(_,k)=>"$"+(n+k+1)).join(",") + ")");
        values.push(
          scanDate,r.symbol,r.close,r.return1d,r.return5d,r.return20d,r.avgVolume20,
          r.relativeVolume,r.realizedVol20,r.avgRange20,r.interestingScore
        );
      });
      await this.pool.query(`
        INSERT INTO universe_scan_results(
          scan_date,symbol,close,return_1d,return_5d,return_20d,avg_volume_20,
          relative_volume,realized_vol_20,avg_range_20,interesting_score
        ) VALUES ${placeholders.join(",")}
        ON CONFLICT(scan_date,symbol) DO UPDATE SET
          close=EXCLUDED.close,return_1d=EXCLUDED.return_1d,return_5d=EXCLUDED.return_5d,
          return_20d=EXCLUDED.return_20d,avg_volume_20=EXCLUDED.avg_volume_20,
          relative_volume=EXCLUDED.relative_volume,realized_vol_20=EXCLUDED.realized_vol_20,
          avg_range_20=EXCLUDED.avg_range_20,interesting_score=EXCLUDED.interesting_score
      `,values);
    }
  }

  async completeUniverseScan(scanDate,{assetsScanned,dailyBars,candidates,deepAssets=0,deepBars=0}) {
    if (!this.ready) return;
    await this.pool.query(`
      UPDATE universe_scan_runs SET
        status='COMPLETE',completed_at=NOW(),assets_scanned=$2,daily_bars=$3,candidates=$4,
        deep_assets=$5,deep_bars=$6,error=NULL
      WHERE scan_date=$1
    `,[scanDate,assetsScanned,dailyBars,candidates,deepAssets,deepBars]);
  }

  async failUniverseScan(scanDate,error) {
    if (!this.ready) return;
    await this.pool.query(`
      UPDATE universe_scan_runs SET status='ERROR',completed_at=NOW(),error=$2
      WHERE scan_date=$1
    `,[scanDate,String(error).slice(0,2000)]);
  }

  async universeScanComplete(scanDate,scanVersion=1) {
    if (!this.ready) return false;
    const q=await this.pool.query(`
      SELECT 1 FROM universe_scan_runs
      WHERE scan_date=$1 AND scan_version=$2 AND status='COMPLETE' LIMIT 1
    `,[scanDate,scanVersion]);
    return q.rowCount>0;
  }

  async latestUniverseScan() {
    if (!this.ready) return null;
    const q=await this.pool.query(`
      SELECT TO_CHAR(scan_date,'YYYY-MM-DD') AS scan_date,
             scan_version,status,started_at,completed_at,assets_scanned,daily_bars,candidates,
             deep_assets,deep_bars,error
      FROM universe_scan_runs ORDER BY scan_date DESC LIMIT 1
    `);
    return q.rows[0]||null;
  }

  async intradayScannedSymbols(scanDate) {
    if (!this.ready) return [];
    const q=await this.pool.query("SELECT symbol FROM universe_intraday_profiles WHERE scan_date=$1",[scanDate]);
    return q.rows.map(r=>r.symbol);
  }

  async saveIntradayProfiles(scanDate,rows) {
    if (!this.ready || !rows.length) return;
    for (let i=0;i<rows.length;i+=500) {
      const chunk=rows.slice(i,i+500);
      const values=[];
      const placeholders=[];
      chunk.forEach((r,j)=>{
        const n=j*16;
        placeholders.push("(" + Array.from({length:16},(_,k)=>"$"+(n+k+1)).join(",") + ")");
        values.push(
          scanDate,r.symbol,r.bars5m,r.sessions,r.lastDayReturn,r.open30Return,r.middayReturn,
          r.powerHourReturn,r.firstHourRange,r.realizedVol5d,r.openVolumeShare,r.closeVolumeShare,
          r.trendFollowRate,r.reversalRate,r.deepScore,JSON.stringify(r.profile||{})
        );
      });
      await this.pool.query(`
        INSERT INTO universe_intraday_profiles(
          scan_date,symbol,bars_5m,sessions,last_day_return,open30_return,midday_return,
          power_hour_return,first_hour_range,realized_vol_5d,open_volume_share,
          close_volume_share,trend_follow_rate,reversal_rate,deep_score,profile
        ) VALUES ${placeholders.join(",")}
        ON CONFLICT(scan_date,symbol) DO UPDATE SET
          bars_5m=EXCLUDED.bars_5m,sessions=EXCLUDED.sessions,last_day_return=EXCLUDED.last_day_return,
          open30_return=EXCLUDED.open30_return,midday_return=EXCLUDED.midday_return,
          power_hour_return=EXCLUDED.power_hour_return,first_hour_range=EXCLUDED.first_hour_range,
          realized_vol_5d=EXCLUDED.realized_vol_5d,open_volume_share=EXCLUDED.open_volume_share,
          close_volume_share=EXCLUDED.close_volume_share,trend_follow_rate=EXCLUDED.trend_follow_rate,
          reversal_rate=EXCLUDED.reversal_rate,deep_score=EXCLUDED.deep_score,
          profile=EXCLUDED.profile,updated_at=NOW()
      `,values);
    }
  }

  async updateUniverseDeepProgress(scanDate,{deepAssets,deepBars}) {
    if (!this.ready) return;
    await this.pool.query(
      "UPDATE universe_scan_runs SET deep_assets=$2,deep_bars=$3 WHERE scan_date=$1",
      [scanDate,deepAssets,deepBars]
    );
  }

  async computeUniverseRegimeMetrics(scanDate) {
    if (!this.ready) return null;
    const q=await this.pool.query(`
      SELECT
        COUNT(*)::int AS assets,
        AVG(r.return_1d) AS avg_return_1d,
        PERCENTILE_CONT(.5) WITHIN GROUP (ORDER BY r.return_1d) AS median_return_1d,
        STDDEV_SAMP(r.return_1d) AS dispersion_1d,
        AVG(ABS(r.return_1d)) AS avg_abs_return_1d,
        AVG(CASE WHEN r.return_1d > 0 THEN 1.0 ELSE 0.0 END) AS breadth_up,
        AVG(CASE WHEN r.return_1d >= .02 THEN 1.0 ELSE 0.0 END) AS strong_up,
        AVG(CASE WHEN r.return_1d <= -.02 THEN 1.0 ELSE 0.0 END) AS strong_down,
        AVG(CASE WHEN r.return_20d > 0 THEN 1.0 ELSE 0.0 END) AS trend_breadth_up,
        PERCENTILE_CONT(.5) WITHIN GROUP (ORDER BY r.relative_volume) AS median_relative_volume,
        PERCENTILE_CONT(.5) WITHIN GROUP (ORDER BY r.realized_vol_20) AS median_realized_vol_20
      FROM universe_scan_results r
      JOIN asset_universe a ON a.symbol=r.symbol
      WHERE r.scan_date=$1
        AND a.status='active'
        AND a.scanner_eligible=true
        AND a.data_supported=true
        AND r.return_1d IS NOT NULL
    `,[scanDate]);
    const r=q.rows[0];
    if (!r || !Number(r.assets)) return null;
    return {
      assets:Number(r.assets)||0,
      avgReturn1d:Number(r.avg_return_1d)||0,
      medianReturn1d:Number(r.median_return_1d)||0,
      dispersion1d:Number(r.dispersion_1d)||0,
      avgAbsReturn1d:Number(r.avg_abs_return_1d)||0,
      breadthUp:Number(r.breadth_up)||0,
      strongUp:Number(r.strong_up)||0,
      strongDown:Number(r.strong_down)||0,
      trendBreadthUp:Number(r.trend_breadth_up)||0,
      medianRelativeVolume:Number(r.median_relative_volume)||0,
      medianRealizedVol20:Number(r.median_realized_vol_20)||0
    };
  }

  async saveMarketRegime(scanDate,{regime,confidence,metrics,reasons}) {
    if (!this.ready) return;
    await this.pool.query(`
      INSERT INTO market_regime_daily(scan_date,regime,confidence,metrics,reasons,created_at,updated_at)
      VALUES($1,$2,$3,$4::jsonb,$5::jsonb,NOW(),NOW())
      ON CONFLICT(scan_date) DO UPDATE SET
        regime=EXCLUDED.regime,confidence=EXCLUDED.confidence,
        metrics=EXCLUDED.metrics,reasons=EXCLUDED.reasons,updated_at=NOW()
    `,[scanDate,regime,confidence,JSON.stringify(metrics||{}),JSON.stringify(reasons||[])]);
  }

  async latestMarketRegime() {
    if (!this.ready) return null;
    const q=await this.pool.query(`
      SELECT TO_CHAR(scan_date,'YYYY-MM-DD') AS scan_date,
             regime,confidence,metrics,reasons,created_at,updated_at
      FROM market_regime_daily
      ORDER BY scan_date DESC
      LIMIT 1
    `);
    return q.rows[0]||null;
  }

  async topUniverseCandidates(scanDate,{limit=30}={}) {
    if (!this.ready) return [];
    const n=Math.max(1,Math.min(200,Number(limit)||30));
    const q=await this.pool.query(`
      SELECT r.scan_date,r.symbol,r.close,r.return_1d,r.return_5d,r.return_20d,
             r.avg_volume_20,r.relative_volume,r.realized_vol_20,r.avg_range_20,
             r.interesting_score,
             COALESCE(i.deep_score,r.deep_score) AS deep_score,
             COALESCE(i.profile,r.intraday_profile) AS intraday_profile,
             i.open30_return,i.midday_return,i.power_hour_return,i.first_hour_range,
             i.realized_vol_5d,i.open_volume_share,i.close_volume_share,
             i.trend_follow_rate,i.reversal_rate,
             a.name,a.exchange
      FROM universe_scan_results r
      LEFT JOIN asset_universe a ON a.symbol=r.symbol
      LEFT JOIN universe_intraday_profiles i
        ON i.scan_date=r.scan_date AND i.symbol=r.symbol
      WHERE r.scan_date=$1
        AND COALESCE(a.scanner_eligible,true)=true
        AND COALESCE(a.data_supported,true)=true
      ORDER BY (r.interesting_score + COALESCE(i.deep_score,r.deep_score,0)) DESC
      LIMIT ${n}
    `,[scanDate]);
    return q.rows;
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

  async listSymbolsWithMinuteHistory({minBars=1500,limit=40}={}) {
    if (!this.ready) return [];
    const n=Math.max(1,Math.min(200,Number(limit)||40));
    const min=Math.max(100,Number(minBars)||1500);
    const q=await this.pool.query(`
      SELECT symbol,COUNT(*)::int AS bars,MIN(ts) AS first_ts,MAX(ts) AS last_ts
      FROM market_bars_1m
      GROUP BY symbol
      HAVING COUNT(*) >= $1
      ORDER BY COUNT(*) DESC, symbol
      LIMIT ${n}
    `,[min]);
    return q.rows.map(r=>({
      symbol:r.symbol,bars:Number(r.bars)||0,firstTs:r.first_ts,lastTs:r.last_ts
    }));
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
         direction,confidence,p_up,p_flat,p_down,features,model_version,model_id,model_details)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17::jsonb)
      ON CONFLICT(id) DO NOTHING
    `,[
      p.id,p.symbol,p.provider,p.feed,p.createdAt,p.targetAt,p.horizonMinutes,
      p.referencePrice,p.direction,p.confidence,p.pUp,p.pFlat,p.pDown,
      JSON.stringify(p.features),p.modelVersion,p.modelId||null,JSON.stringify(p.modelDetails||{})
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

  async patternMemoryStats() {
    if (!this.ready) return {patterns:0,totalSamples:0};
    const q=await this.pool.query(`
      SELECT
        COUNT(*)::int AS patterns,
        COALESCE(SUM(sample_count),0)::bigint AS total_samples,
        COUNT(*) FILTER (WHERE horizon_minutes=15)::int AS h15,
        COUNT(*) FILTER (WHERE horizon_minutes=30)::int AS h30,
        COUNT(*) FILTER (WHERE horizon_minutes=60)::int AS h60
      FROM pattern_memory
    `);
    const r=q.rows[0]||{};
    return {
      patterns:Number(r.patterns)||0,
      totalSamples:Number(r.total_samples)||0,
      byHorizon:{15:Number(r.h15)||0,30:Number(r.h30)||0,60:Number(r.h60)||0}
    };
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

  async upsertResearchJob(job) {
    if (!this.ready) return;
    await this.pool.query(`
      INSERT INTO research_jobs(
        job_key,job_type,status,phase,provider,progress,items_done,items_total,
        bars_processed,details,started_at,updated_at,completed_at,error
      ) VALUES(
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,
        COALESCE($11,NOW()),NOW(),$12,$13
      )
      ON CONFLICT(job_key) DO UPDATE SET
        job_type=EXCLUDED.job_type,status=EXCLUDED.status,phase=EXCLUDED.phase,
        provider=EXCLUDED.provider,progress=EXCLUDED.progress,
        items_done=EXCLUDED.items_done,items_total=EXCLUDED.items_total,
        bars_processed=EXCLUDED.bars_processed,details=EXCLUDED.details,
        started_at=COALESCE(research_jobs.started_at,EXCLUDED.started_at),
        updated_at=NOW(),completed_at=EXCLUDED.completed_at,error=EXCLUDED.error
    `,[
      job.jobKey,job.jobType,job.status,job.phase||null,job.provider||null,
      Number(job.progress)||0,Number(job.itemsDone)||0,
      job.itemsTotal==null?null:Number(job.itemsTotal),
      Number(job.barsProcessed)||0,JSON.stringify(job.details||{}),
      job.startedAt||null,job.completedAt||null,job.error||null
    ]);
  }

  async addResearchEvent(event) {
    if (!this.ready) return null;
    const q=await this.pool.query(`
      INSERT INTO research_events(category,level,job_key,title,message,details)
      VALUES($1,$2,$3,$4,$5,$6::jsonb)
      RETURNING id,event_ts,category,level,job_key,title,message,details
    `,[
      event.category||"SYSTEM",event.level||"INFO",event.jobKey||null,
      event.title,event.message,JSON.stringify(event.details||{})
    ]);
    return q.rows[0]||null;
  }

  async recentResearchEvents({limit=120,afterId=null}={}) {
    if (!this.ready) return [];
    const n=Math.max(1,Math.min(500,Number(limit)||120));
    if (afterId!=null) {
      const q=await this.pool.query(`
        SELECT id,event_ts,category,level,job_key,title,message,details
        FROM research_events
        WHERE id > $1
        ORDER BY id ASC
        LIMIT ${n}
      `,[Number(afterId)]);
      return q.rows;
    }
    const q=await this.pool.query(`
      SELECT id,event_ts,category,level,job_key,title,message,details
      FROM research_events
      ORDER BY id DESC
      LIMIT ${n}
    `);
    return q.rows.reverse();
  }

  async researchJobs() {
    if (!this.ready) return [];
    const q=await this.pool.query(`
      SELECT job_key,job_type,status,phase,provider,progress,items_done,items_total,
             bars_processed,details,started_at,updated_at,completed_at,error
      FROM research_jobs
      ORDER BY
        CASE status WHEN 'RUNNING' THEN 0 WHEN 'QUEUED' THEN 1 ELSE 2 END,
        updated_at DESC
    `);
    return q.rows;
  }

  async researchCoverage() {
    if (!this.ready) return {};
    const [m1,longDaily,patterns,models,preds]=await Promise.all([
      this.pool.query(`
        SELECT COUNT(*)::bigint AS bars,COUNT(DISTINCT symbol)::int AS symbols,
               MIN(ts) AS first_ts,MAX(ts) AS last_ts
        FROM market_bars_1m
      `),
      this.pool.query(`
        SELECT COUNT(*)::bigint AS bars,COUNT(DISTINCT symbol)::int AS symbols,
               MIN(day) AS first_day,MAX(day) AS last_day
        FROM long_history_bars_1d
      `),
      this.pool.query(`
        SELECT COUNT(*)::int AS findings,
               COUNT(*) FILTER (WHERE status='PROMOTED')::int AS promoted
        FROM research_pattern_findings
      `),
      this.pool.query(`
        SELECT COUNT(*)::int AS models,
               COUNT(*) FILTER (WHERE status='PRODUCTION')::int AS production,
               COUNT(*) FILTER (WHERE status='SHADOW')::int AS shadow,
               COUNT(*) FILTER (WHERE status='REJECTED')::int AS rejected
        FROM model_registry
      `),
      this.pool.query(`
        SELECT COUNT(*)::int AS predictions,
               COUNT(*) FILTER (WHERE status='SCORED')::int AS scored
        FROM predictions
      `)
    ]);
    return {
      intraday:{
        bars:Number(m1.rows[0]?.bars)||0,
        symbols:Number(m1.rows[0]?.symbols)||0,
        first:m1.rows[0]?.first_ts||null,
        last:m1.rows[0]?.last_ts||null
      },
      longHistory:{
        bars:Number(longDaily.rows[0]?.bars)||0,
        symbols:Number(longDaily.rows[0]?.symbols)||0,
        first:longDaily.rows[0]?.first_day||null,
        last:longDaily.rows[0]?.last_day||null
      },
      findings:patterns.rows[0]||{},
      models:models.rows[0]||{},
      predictions:preds.rows[0]||{}
    };
  }

  async upsertLongHistoryBars(bars) {
    if (!this.ready || !bars?.length) return 0;
    let inserted=0;
    for (let i=0;i<bars.length;i+=1000) {
      const chunk=bars.slice(i,i+1000);
      const values=[];
      const rows=[];
      chunk.forEach((b,j)=>{
        const n=j*8;
        rows.push("(" + Array.from({length:8},(_,k)=>"$"+(n+k+1)).join(",") + ")");
        values.push(
          b.provider||"stooq",b.symbol,b.day,b.open,b.high,b.low,b.close,b.volume||0
        );
      });
      await this.pool.query(`
        INSERT INTO long_history_bars_1d(
          provider,symbol,day,open,high,low,close,volume
        ) VALUES ${rows.join(",")}
        ON CONFLICT(provider,symbol,day) DO UPDATE SET
          open=EXCLUDED.open,high=EXCLUDED.high,low=EXCLUDED.low,
          close=EXCLUDED.close,volume=EXCLUDED.volume
      `,values);
      inserted+=chunk.length;
    }
    return inserted;
  }

  async longHistorySymbols({limit=20000}={}) {
    if (!this.ready) return [];
    const n=Math.max(1,Math.min(50000,Number(limit)||20000));
    const q=await this.pool.query(`
      SELECT symbol,COUNT(*)::int AS bars,MIN(day) AS first_day,MAX(day) AS last_day
      FROM long_history_bars_1d
      GROUP BY symbol
      ORDER BY COUNT(*) DESC,symbol
      LIMIT ${n}
    `);
    return q.rows;
  }

  async getLongHistoryBars(symbol,{start="1999-01-01",limit=10000}={}) {
    if (!this.ready) return [];
    const n=Math.max(1,Math.min(20000,Number(limit)||10000));
    const q=await this.pool.query(`
      SELECT provider,symbol,day,open,high,low,close,volume
      FROM long_history_bars_1d
      WHERE symbol=$1 AND day >= $2::date
      ORDER BY day
      LIMIT ${n}
    `,[String(symbol).toUpperCase(),start]);
    return q.rows;
  }

  async demoteLegacyResearchFindings(currentVersion="v3_baseline_excess") {
    if (!this.ready) return 0;
    const q=await this.pool.query(`
      UPDATE research_pattern_findings
      SET status='LEGACY_UNVALIDATED',last_seen=NOW()
      WHERE status IN ('PROMOTED','VALIDATED')
        AND COALESCE(validation_version,'legacy') <> $1
    `,[currentVersion]);
    return q.rowCount||0;
  }

  async upsertResearchFinding(f) {
    if (!this.ready) return;
    await this.pool.query(`
      INSERT INTO research_pattern_findings(
        finding_id,provider,scope,symbol,pattern_key,horizon_days,sample_count,
        hit_rate,avg_forward_return,median_forward_return,avg_adverse_return,
        avg_favorable_return,score,description,evidence,validation_version,
        discovery_metrics,validation_metrics,holdout_metrics,first_seen,last_seen,status
      ) VALUES(
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,
        $17::jsonb,$18::jsonb,$19::jsonb,NOW(),NOW(),$20
      )
      ON CONFLICT(finding_id) DO UPDATE SET
        sample_count=EXCLUDED.sample_count,hit_rate=EXCLUDED.hit_rate,
        avg_forward_return=EXCLUDED.avg_forward_return,
        median_forward_return=EXCLUDED.median_forward_return,
        avg_adverse_return=EXCLUDED.avg_adverse_return,
        avg_favorable_return=EXCLUDED.avg_favorable_return,
        score=EXCLUDED.score,description=EXCLUDED.description,
        evidence=EXCLUDED.evidence,validation_version=EXCLUDED.validation_version,
        discovery_metrics=EXCLUDED.discovery_metrics,
        validation_metrics=EXCLUDED.validation_metrics,
        holdout_metrics=EXCLUDED.holdout_metrics,
        last_seen=NOW(),status=EXCLUDED.status
    `,[
      f.findingId,f.provider,f.scope,f.symbol||null,f.patternKey,f.horizonDays,
      f.sampleCount,f.hitRate,f.avgForwardReturn,f.medianForwardReturn,
      f.avgAdverseReturn,f.avgFavorableReturn,f.score,f.description,
      JSON.stringify(f.evidence||{}),f.validationVersion||"legacy",
      JSON.stringify(f.discoveryMetrics||{}),
      JSON.stringify(f.validationMetrics||{}),
      JSON.stringify(f.holdoutMetrics||{}),
      f.status||"CANDIDATE"
    ]);
  }

  async topResearchFindings({limit=80,status=null}={}) {
    if (!this.ready) return [];
    const n=Math.max(1,Math.min(300,Number(limit)||80));
    const params=[];
    let where="";
    if(status){ params.push(status); where="WHERE status=$1"; }
    const q=await this.pool.query(`
      SELECT finding_id,provider,scope,symbol,pattern_key,horizon_days,sample_count,
             hit_rate,avg_forward_return,median_forward_return,avg_adverse_return,
             avg_favorable_return,score,description,evidence,validation_version,
             discovery_metrics,validation_metrics,holdout_metrics,
             first_seen,last_seen,status
      FROM research_pattern_findings
      ${where}
      ORDER BY score DESC,last_seen DESC
      LIMIT ${n}
    `,params);
    return q.rows;
  }

  async refreshHistoricalSecurityMaster(symbols=null) {
    if (!this.ready) return 0;
    const params=[];
    let where="";
    if(Array.isArray(symbols)&&symbols.length){
      params.push(symbols.map(s=>String(s).toUpperCase()));
      where="WHERE h.symbol = ANY($1::text[])";
    }
    const q=await this.pool.query(`
      INSERT INTO historical_security_master(
        symbol,first_day,last_day,current_active,survivorship_class,
        current_name,current_exchange,source,bars,updated_at
      )
      SELECT
        h.symbol,MIN(h.day),MAX(h.day),
        BOOL_OR(a.symbol IS NOT NULL AND a.status='active') AS current_active,
        CASE
          WHEN BOOL_OR(a.symbol IS NOT NULL AND a.status='active') THEN 'CURRENT_ACTIVE'
          ELSE 'HISTORICAL_ONLY'
        END,
        MAX(a.name),MAX(a.exchange),'long_history',COUNT(*)::bigint,NOW()
      FROM long_history_bars_1d h
      LEFT JOIN asset_universe a ON a.symbol=h.symbol
      ${where}
      GROUP BY h.symbol
      ON CONFLICT(symbol) DO UPDATE SET
        first_day=EXCLUDED.first_day,last_day=EXCLUDED.last_day,
        current_active=EXCLUDED.current_active,
        survivorship_class=EXCLUDED.survivorship_class,
        current_name=EXCLUDED.current_name,current_exchange=EXCLUDED.current_exchange,
        bars=EXCLUDED.bars,updated_at=NOW()
      RETURNING symbol
    `,params);
    return q.rowCount;
  }

  async auditCorporateActionCandidates(symbols) {
    if (!this.ready || !Array.isArray(symbols) || !symbols.length) return {actions:0,quality:0};
    const syms=symbols.map(s=>String(s).toUpperCase());
    const q=await this.pool.query(`
      WITH x AS (
        SELECT symbol,day,close,
               LAG(close) OVER(PARTITION BY symbol ORDER BY day) AS prev_close
        FROM long_history_bars_1d
        WHERE symbol=ANY($1::text[])
      ),
      jumps AS (
        SELECT symbol,day,close,prev_close,
               close/NULLIF(prev_close,0) AS ratio
        FROM x
        WHERE prev_close>0
          AND (close/prev_close >= 1.45 OR close/prev_close <= .69)
      )
      SELECT * FROM jumps
      ORDER BY symbol,day
    `,[syms]);

    let actions=0,quality=0;
    const common=[2,3,4,5,10,1.5];
    for(const r of q.rows){
      const ratio=Number(r.ratio);
      const inv=ratio>0?1/ratio:Infinity;
      const candidate=[ratio,inv].some(v=>common.some(f=>Math.abs(v-f)/f<=.08));
      if(candidate){
        await this.pool.query(`
          INSERT INTO corporate_action_flags(
            symbol,action_day,action_type,confidence,source,details
          ) VALUES($1,$2,'SPLIT_LIKE',.75,'price_jump_heuristic',$3::jsonb)
          ON CONFLICT(symbol,action_day,action_type,source) DO UPDATE SET
            confidence=EXCLUDED.confidence,details=EXCLUDED.details
        `,[
          r.symbol,r.day,JSON.stringify({
            previousClose:Number(r.prev_close),close:Number(r.close),ratio
          })
        ]);
        actions++;
      }else if(Math.abs(ratio-1)>=.60){
        await this.pool.query(`
          INSERT INTO data_quality_flags(
            severity,scope,symbol,flag_type,message,details,active
          )
          SELECT 'WARN','HISTORICAL_SYMBOL',$1,'EXTREME_DAILY_JUMP',
                 'Extreme historical daily jump requires caution in research.',
                 $2::jsonb,true
          WHERE NOT EXISTS(
            SELECT 1 FROM data_quality_flags
            WHERE active=true AND symbol=$1 AND flag_type='EXTREME_DAILY_JUMP'
              AND details->>'day'=$3
          )
        `,[
          r.symbol,
          JSON.stringify({day:String(r.day).slice(0,10),ratio,previousClose:Number(r.prev_close),close:Number(r.close)}),
          String(r.day).slice(0,10)
        ]);
        quality++;
      }
    }
    return {actions,quality};
  }

  async corporateActionDays(symbol) {
    if(!this.ready) return [];
    const q=await this.pool.query(`
      SELECT action_day
      FROM corporate_action_flags
      WHERE symbol=$1 AND confidence>=.6
      ORDER BY action_day
    `,[String(symbol).toUpperCase()]);
    return q.rows.map(r=>String(r.action_day).slice(0,10));
  }

  async historicalUniverseStats() {
    if(!this.ready) return {};
    const q=await this.pool.query(`
      SELECT
        COUNT(*)::int AS symbols,
        COUNT(*) FILTER(WHERE current_active)::int AS current_active,
        COUNT(*) FILTER(WHERE NOT current_active)::int AS historical_only,
        MIN(first_day) AS first_day,
        MAX(last_day) AS last_day,
        SUM(bars)::bigint AS bars
      FROM historical_security_master
    `);
    const r=q.rows[0]||{};
    return {
      symbols:Number(r.symbols)||0,
      currentActive:Number(r.current_active)||0,
      historicalOnly:Number(r.historical_only)||0,
      firstDay:r.first_day||null,lastDay:r.last_day||null,bars:Number(r.bars)||0
    };
  }

  async activeDataQualityFlags() {
    if(!this.ready) return [];
    const q=await this.pool.query(`
      SELECT flag_id,severity,scope,symbol,flag_type,message,details,created_at
      FROM data_quality_flags
      WHERE active=true
      ORDER BY CASE severity WHEN 'CRITICAL' THEN 0 WHEN 'ERROR' THEN 1 WHEN 'WARN' THEN 2 ELSE 3 END,
               created_at DESC
      LIMIT 200
    `);
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

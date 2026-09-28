export class ReadinessGate {
  constructor({db,modelLab,paperBroker,driftMonitor,marketIntegrity,accountId}){
    this.db=db;
    this.modelLab=modelLab;
    this.paperBroker=paperBroker;
    this.driftMonitor=driftMonitor;
    this.marketIntegrity=marketIntegrity;
    this.accountId=accountId;
    this.timer=null;
    this.latest=null;
  }

  async init(){
    await this.measure().catch(()=>{});
    this.timer=setInterval(()=>this.measure().catch(()=>{}),5*60*1000);
  }

  stop(){clearInterval(this.timer);}

  status(){
    return this.latest||{
      status:"LOCKED",
      score:0,
      blockers:["Readiness has not been measured yet."],
      gates:{},
      measuredAt:null,
      realMoneyEnabled:false
    };
  }

  async measure(){
    const production=this.modelLab?.status?.().production||null;
    const paper=await this.paperBroker.snapshot();
    const drift=this.driftMonitor?.status?.()||{status:"UNKNOWN",score:1};
    const integrity=this.marketIntegrity?.status?.()||{};

    const [incidents,lifecycle,corp,promotedPatterns] = await Promise.all([
      this.db.pool.query(`
        SELECT COUNT(*)::int AS open_count,
               COUNT(*) FILTER (WHERE severity IN ('HIGH','CRITICAL'))::int AS severe_count
        FROM data_quality_incidents WHERE status='OPEN'
      `),
      this.db.pool.query(`
        SELECT COUNT(DISTINCT symbol)::int AS symbols,
               COUNT(DISTINCT symbol) FILTER (WHERE status<>'active')::int AS inactive_symbols
        FROM asset_lifecycle
      `),
      this.db.pool.query("SELECT COUNT(*)::int AS n FROM corporate_actions"),
      this.db.pool.query("SELECT COUNT(*)::int AS n FROM research_pattern_findings WHERE status='PROMOTED'")
    ]);

    const live=production?.liveMetrics||{};
    const test=production?.testMetrics||{};
    const gates={
      productionModel:{
        pass:Boolean(production?.modelId),
        value:production?.modelId||null,
        requirement:"A promoted production model must exist."
      },
      unseenTest:{
        pass:Number(test.samples||0)>=500 && Number(test.brier||1)<=.23 && Number(test.ece||1)<=.10,
        value:{samples:Number(test.samples)||0,brier:Number(test.brier)||null,ece:Number(test.ece)||null},
        requirement:"At least 500 unseen test samples with bounded Brier/ECE."
      },
      liveFutureProof:{
        pass:Number(live.samples||0)>=1000 && Number(live.brier||1)<=.22 && Number(live.ece||1)<=.08,
        value:{samples:Number(live.samples)||0,brier:Number(live.brier)||null,ece:Number(live.ece)||null},
        requirement:"At least 1,000 future live outcomes with strong calibration."
      },
      paperExecution:{
        pass:Number(paper.closedOutcomes||0)>=150 &&
             Number(paper.realizedPnl||0)>0 &&
             Number(paper.profitFactor||0)>=1.20 &&
             Number(paper.maxDrawdown||0)>=-.10,
        value:{
          closedOutcomes:Number(paper.closedOutcomes)||0,
          realizedPnl:Number(paper.realizedPnl)||0,
          profitFactor:paper.profitFactor,
          maxDrawdown:Number(paper.maxDrawdown)||0
        },
        requirement:"150+ closed paper outcomes, positive P/L, PF ≥1.20, drawdown ≥-10%."
      },
      drift:{
        pass:["STABLE","WATCH"].includes(drift.status),
        value:{status:drift.status,score:drift.score},
        requirement:"Production model must not be DEGRADED or HALTED."
      },
      dataQuality:{
        pass:Number(incidents.rows[0]?.severe_count||0)===0,
        value:{
          open:Number(incidents.rows[0]?.open_count)||0,
          severe:Number(incidents.rows[0]?.severe_count)||0
        },
        requirement:"No HIGH/CRITICAL unresolved data-quality incidents."
      },
      survivorshipAwareness:{
        pass:Number(lifecycle.rows[0]?.symbols||0)>=500 && Number(lifecycle.rows[0]?.inactive_symbols||0)>0,
        value:{
          lifecycleSymbols:Number(lifecycle.rows[0]?.symbols)||0,
          inactiveSymbols:Number(lifecycle.rows[0]?.inactive_symbols)||0
        },
        requirement:"Historical asset lifecycle must include inactive/delisted names."
      },
      corporateActions:{
        pass:Number(corp.rows[0]?.n||0)>0,
        value:{actions:Number(corp.rows[0]?.n)||0,lastSync:integrity.lastCorporateActionSync||null},
        requirement:"Corporate-action data must be synced and used for exclusions."
      },
      historicalValidation:{
        pass:Number(promotedPatterns.rows[0]?.n||0)>0,
        value:{promotedPatterns:Number(promotedPatterns.rows[0]?.n)||0},
        requirement:"At least one historical pattern must survive later validation and holdout."
      }
    };

    const entries=Object.entries(gates);
    const passed=entries.filter(([,g])=>g.pass).length;
    const score=entries.length?passed/entries.length:0;
    const blockers=entries.filter(([,g])=>!g.pass).map(([name,g])=>`${name}: ${g.requirement}`);

    let status="LOCKED";
    if(score>=.50) status="PROVING";
    if(score>=.75) status="NOT_READY";
    if(score===1) status="REVIEW_ELIGIBLE";

    // Real money is intentionally never auto-enabled. REVIEW_ELIGIBLE means manual review only.
    const realMoneyEnabled=false;
    const measuredAt=new Date().toISOString();
    this.latest={
      status,score,passed,total:entries.length,blockers,gates,measuredAt,
      modelId:production?.modelId||null,
      paperAccountId:this.accountId,
      realMoneyEnabled
    };
    await this.db.pool.query(`
      INSERT INTO readiness_snapshots(
        measured_at,status,score,gates,blockers,model_id,paper_account_id,details
      ) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8::jsonb)
    `,[
      measuredAt,status,score,JSON.stringify(gates),JSON.stringify(blockers),
      production?.modelId||null,this.accountId,
      JSON.stringify({realMoneyEnabled:false,passed,total:entries.length})
    ]);
    console.log(JSON.stringify({event:"readiness_measurement",status,score,passed,total:entries.length}));
    return this.latest;
  }
}

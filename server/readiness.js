export class ReadinessEvaluator {
  constructor({
    db,marketEngine,modelLab,paperBroker,researchBrain,
    historicalIntegrityVerified=false
  }){
    this.db=db;
    this.marketEngine=marketEngine;
    this.modelLab=modelLab;
    this.paperBroker=paperBroker;
    this.researchBrain=researchBrain;
    this.historicalIntegrityVerified=Boolean(historicalIntegrityVerified);
  }

  #gate(key,label,pass,current,target,detail,{critical=false,quality=false}={}){
    return {
      key,label,pass:Boolean(pass),current,target,detail,
      critical:Boolean(critical),quality:Boolean(quality)
    };
  }

  async #productionBreadth(modelId){
    if(!modelId||!this.db?.ready) return {days:0,symbols:0,samples:0};
    const q=await this.db.pool.query(`
      SELECT
        COUNT(*)::int AS samples,
        COUNT(DISTINCT (created_at AT TIME ZONE 'America/New_York')::date)::int AS days,
        COUNT(DISTINCT symbol)::int AS symbols
      FROM predictions
      WHERE model_id=$1 AND status='SCORED'
    `,[modelId]);
    const r=q.rows[0]||{};
    return {
      days:Number(r.days)||0,
      symbols:Number(r.symbols)||0,
      samples:Number(r.samples)||0
    };
  }

  async #paperBreadth(){
    if(!this.db?.ready) return {days:0,symbols:0};
    const q=await this.db.pool.query(`
      SELECT
        COUNT(DISTINCT (created_at AT TIME ZONE 'America/New_York')::date)::int AS days,
        COUNT(DISTINCT symbol)::int AS symbols
      FROM paper_fills
      WHERE account_id=$1
    `,[this.paperBroker?.accountId||"TE_PAPER_MAIN_V1"]);
    const r=q.rows[0]||{};
    return {days:Number(r.days)||0,symbols:Number(r.symbols)||0};
  }

  async evaluate(){
    const [research,paper]=await Promise.all([
      this.researchBrain?.status?.()||{},
      this.paperBroker?.snapshot?.()||{}
    ]);
    const lab=this.modelLab?.status?.()||{};
    const production=lab.production||null;
    const productionId=production?.modelId||null;
    const [liveBreadth,paperBreadth]=await Promise.all([
      this.#productionBreadth(productionId),
      this.#paperBreadth()
    ]);

    const live=production?.liveMetrics||{};
    const liveSamples=Math.max(Number(live.samples)||0,liveBreadth.samples||0);
    const brier=live.brier==null?null:Number(live.brier);
    const ece=live.ece==null?null:Number(live.ece);
    const accuracy=live.accuracy==null?null:Number(live.accuracy);
    const drift=production?.drift||lab.drift||{};
    const driftLevel=String(drift.level||"INSUFFICIENT").toUpperCase();

    const coverage=research.coverage||{};
    const longHistory=coverage.longHistory||{};
    const longFirst=longHistory.first?String(longHistory.first).slice(0,10):null;
    const longBars=Number(longHistory.bars)||0;
    const longSymbols=Number(longHistory.symbols)||0;
    const startsEarlyEnough=Boolean(longFirst && longFirst<="2000-01-01");

    const jobs=Array.isArray(research.jobs)?research.jobs:[];
    const errorJobs=jobs.filter(j=>String(j.status||"").toUpperCase()==="ERROR");

    const closed=Number(paper.closedOutcomes)||0;
    const pf=paper.profitFactor==null?null:Number(paper.profitFactor);
    const dd=paper.maxDrawdown==null?null:Number(paper.maxDrawdown);
    const realized=Number(paper.realizedPnl)||0;

    const gates=[
      this.#gate(
        "production_model","Production model exists",
        Boolean(production),productionId||"none","production model",
        production?"A trained production model is active.":"No production model has completed the model-lab pipeline yet.",
        {critical:true}
      ),
      this.#gate(
        "historical_integrity","Historical integrity audit",
        this.historicalIntegrityVerified,
        this.historicalIntegrityVerified?"VERIFIED":"UNVERIFIED","VERIFIED",
        this.historicalIntegrityVerified
          ?"Survivorship/delisting and corporate-action handling has been explicitly verified."
          :"Long history may still contain survivorship, delisting, ticker-change, split, or dividend-adjustment limitations. Review remains locked until this is genuinely audited.",
        {critical:true}
      ),
      this.#gate(
        "long_history_depth","Long-history depth",
        startsEarlyEnough && longSymbols>=200 && longBars>=300000,
        `${longSymbols} symbols · ${longBars.toLocaleString()} bars · first ${longFirst||"none"}`,
        "≥200 symbols · ≥300,000 daily bars · begins by 2000-01-01",
        "Long history must be broad and deep enough that a few surviving large-cap names cannot dominate the evidence."
      ),
      this.#gate(
        "forward_live_samples","Future live outcomes",
        liveSamples>=2000,liveSamples,">= 2,000 scored future outcomes",
        "These outcomes must have been predicted before the future market result existed."
      ),
      this.#gate(
        "live_day_breadth","Live day breadth",
        liveBreadth.days>=20,liveBreadth.days,">= 20 distinct market days",
        "A large number of predictions from one or two days is not enough."
      ),
      this.#gate(
        "live_symbol_breadth","Live symbol breadth",
        liveBreadth.symbols>=8,liveBreadth.symbols,">= 8 symbols",
        "The production model must prove itself across multiple stocks/ETFs, not one lucky ticker."
      ),
      this.#gate(
        "live_brier","Live probability quality",
        brier!=null && brier<=.21,brier==null?"none":Number(brier.toFixed(4)),"<= 0.2100 Brier",
        "Lower Brier score means the probability forecasts are closer to the realized outcomes.",
        {quality:true}
      ),
      this.#gate(
        "live_calibration","Live calibration",
        ece!=null && ece<=.06,ece==null?"none":Number(ece.toFixed(4)),"<= 0.0600 ECE",
        "Confidence should match reality instead of becoming overconfident.",
        {quality:true}
      ),
      this.#gate(
        "model_drift","Model drift guard",
        driftLevel!=="ALERT" && driftLevel!=="UNKNOWN",
        driftLevel,"STABLE or WARN",
        driftLevel==="ALERT"
          ?"Recent future outcomes deteriorated enough that new AI paper entries are blocked until performance recovers or the model is replaced."
          :"Recent performance is not in the hard-stop drift state.",
        {quality:true}
      ),
      this.#gate(
        "paper_outcomes","Paper execution outcomes",
        closed>=300,closed,">= 300 closed paper outcomes",
        "Paper profitability must survive a much larger executed sample after spread/slippage penalties."
      ),
      this.#gate(
        "paper_day_breadth","Paper trading day breadth",
        paperBreadth.days>=15,paperBreadth.days,">= 15 distinct market days",
        "Paper results need to persist across different sessions."
      ),
      this.#gate(
        "paper_symbol_breadth","Paper symbol breadth",
        paperBreadth.symbols>=5,paperBreadth.symbols,">= 5 symbols",
        "Paper performance should not come from one ticker."
      ),
      this.#gate(
        "paper_profit_factor","Paper profit factor",
        pf!=null && (pf===Infinity || (Number.isFinite(pf) && pf>=1.20)),
        pf==null?"none":Number.isFinite(pf)?Number(pf.toFixed(2)):"∞",">= 1.20",
        "Gross paper winners must meaningfully exceed gross paper losers after execution costs.",
        {quality:true}
      ),
      this.#gate(
        "paper_positive","Paper realized P/L",
        realized>0,Number(realized.toFixed(2)),"> $0",
        "The executed paper strategy must be net positive, not just directionally accurate.",
        {quality:true}
      ),
      this.#gate(
        "paper_drawdown","Paper max drawdown",
        dd!=null && dd>=-.06,dd==null?"none":Number((dd*100).toFixed(2))+"%",">= -6.00%",
        "A strategy with an unacceptable drawdown is not review-ready even if total P/L is positive.",
        {quality:true}
      ),
      this.#gate(
        "research_health","Research pipeline health",
        errorJobs.length===0,errorJobs.length,"0 active research errors",
        errorJobs.length
          ? `${errorJobs.length} research job(s) currently report an error.`
          :"No tracked research job currently reports an error.",
        {critical:true}
      )
    ];

    const blockers=gates.filter(g=>!g.pass);
    const criticalBlockers=blockers.filter(g=>g.critical);
    const evidenceIncomplete=blockers.filter(g=>[
      "long_history_depth","forward_live_samples","live_day_breadth","live_symbol_breadth",
      "paper_outcomes","paper_day_breadth","paper_symbol_breadth"
    ].includes(g.key));
    const qualityFailures=blockers.filter(g=>g.quality);

    let status="REVIEW_ELIGIBLE";
    let detail="All server-side proof gates passed. This only permits a manual review; live trading is still not enabled.";
    if(criticalBlockers.length){
      status="LOCKED";
      detail=criticalBlockers[0].detail;
    }else if(evidenceIncomplete.length){
      status="PROVING";
      detail=`${evidenceIncomplete.length} evidence gate(s) still need more independent future/paper data.`;
    }else if(qualityFailures.length){
      status="NOT_READY";
      detail=`${qualityFailures.length} quality/risk gate(s) failed. The system should keep researching and paper-trading, not advance.`;
    }

    return {
      status,
      reviewEligible:status==="REVIEW_ELIGIBLE",
      liveTradingEnabled:false,
      evaluatedAt:new Date().toISOString(),
      detail,
      policy:{
        version:"server-proof-v1",
        note:"REVIEW_ELIGIBLE never means guaranteed profit and never enables a live order by itself."
      },
      evidence:{
        modelId:productionId,
        live:{samples:liveSamples,days:liveBreadth.days,symbols:liveBreadth.symbols,accuracy,brier,ece,drift},
        paper:{
          closedOutcomes:closed,days:paperBreadth.days,symbols:paperBreadth.symbols,
          realizedPnl:realized,profitFactor:pf,maxDrawdown:dd
        },
        history:{bars:longBars,symbols:longSymbols,first:longFirst,integrityVerified:this.historicalIntegrityVerified},
        researchErrors:errorJobs.map(j=>({jobKey:j.job_key,type:j.job_type,error:j.error||null}))
      },
      gates,
      blockers
    };
  }
}

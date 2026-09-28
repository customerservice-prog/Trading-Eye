import { EventEmitter } from "node:events";

const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));

function etBucket(value){
  const d=new Date(value);
  if(Number.isNaN(+d)) return "UNKNOWN";
  const parts=Object.fromEntries(
    new Intl.DateTimeFormat("en-US",{
      timeZone:"America/New_York",hour:"2-digit",minute:"2-digit",hourCycle:"h23"
    }).formatToParts(d).filter(x=>x.type!=="literal").map(x=>[x.type,x.value])
  );
  const minute=Number(parts.hour)*60+Number(parts.minute);
  if(minute<10*60+30) return "OPENING_60M";
  if(minute<14*60+30) return "MIDDAY";
  return "LATE_DAY";
}

function ratio(n,d){ return d?Number(n)/Number(d):0; }

export class MistakeLab extends EventEmitter {
  constructor({
    db,modelLab,enabled=true,
    explorationAccountId="TE_PAPER_EXPLORATION_V1",
    analysisEveryMs=2*60*1000,
    retrainCooldownMs=6*60*60*1000,
    warnRetrainCooldownMs=12*60*60*1000
  }={}){
    super();
    this.db=db;
    this.modelLab=modelLab;
    this.enabled=Boolean(enabled);
    this.explorationAccountId=String(explorationAccountId||"TE_PAPER_EXPLORATION_V1");
    this.analysisEveryMs=analysisEveryMs;
    this.retrainCooldownMs=retrainCooldownMs;
    this.warnRetrainCooldownMs=warnRetrainCooldownMs;
    this.timer=null;
    this.running=false;
    this.pendingScores=0;
    this.lastError=null;
    this.lastAnalysis=null;
    this.lastRetrainRequestedAt=0;
  }

  async init(){
    if(!this.enabled) return;
    await this.db.pool.query(`
      CREATE TABLE IF NOT EXISTS mistake_lab_snapshots (
        id BIGSERIAL PRIMARY KEY,
        analyzed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        scored_samples INTEGER NOT NULL DEFAULT 0,
        mistakes INTEGER NOT NULL DEFAULT 0,
        high_conf_mistakes INTEGER NOT NULL DEFAULT 0,
        missed_moves INTEGER NOT NULL DEFAULT 0,
        guard JSONB NOT NULL DEFAULT '{}'::jsonb,
        lessons JSONB NOT NULL DEFAULT '[]'::jsonb,
        summary JSONB NOT NULL DEFAULT '{}'::jsonb
      );
      CREATE INDEX IF NOT EXISTS mistake_lab_snapshots_recent
        ON mistake_lab_snapshots(analyzed_at DESC);
    `);
    await this.analyze().catch(err=>this.#capture(err));
    this.timer=setInterval(()=>this.analyze().catch(err=>this.#capture(err)),this.analysisEveryMs);
  }

  stop(){ clearInterval(this.timer); }

  status(){
    return {
      enabled:this.enabled,
      running:this.running,
      pendingScores:this.pendingScores,
      lastError:this.lastError,
      lastAnalysis:this.lastAnalysis
    };
  }

  async onPredictionScored(){
    if(!this.enabled) return;
    this.pendingScores++;
    if(this.pendingScores>=10 && !this.running){
      this.pendingScores=0;
      setTimeout(()=>this.analyze().catch(err=>this.#capture(err)),250);
    }
  }

  async analyze(){
    if(!this.enabled||this.running) return this.lastAnalysis;
    this.running=true;
    this.lastError=null;
    try{
      const [q,exploreQ]=await Promise.all([
        this.db.pool.query(`
          SELECT
            id,symbol,created_at,direction,confidence,p_up,p_flat,p_down,
            result_return,actual_direction,correct,features,model_id,model_details
          FROM predictions
          WHERE status='SCORED'
          ORDER BY created_at DESC
          LIMIT 1200
        `),
        this.db.pool.query(`
          SELECT
            f.symbol,f.realized_pnl,f.created_at,f.fill_price,
            o.source,o.model_id
          FROM paper_fills f
          LEFT JOIN paper_orders o ON o.order_id=f.order_id
          WHERE f.account_id=$1
            AND ABS(f.realized_pnl) > 0.0000001
          ORDER BY f.created_at DESC
          LIMIT 300
        `,[this.explorationAccountId])
      ]);
      const rows=q.rows||[];
      const explorationClosed=exploreQ.rows||[];
      const recent=rows.slice(0,Math.min(250,rows.length));
      const baseline=rows.slice(250,Math.min(1000,rows.length));

      const mistakes=recent.filter(r=>r.correct===false);
      const highConf=recent.filter(r=>Number(r.confidence)>=.55);
      const highConfMistakes=highConf.filter(r=>r.correct===false);
      const missedMoves=recent.filter(r=>{
        const noTrade=Boolean(r.model_details?.noTrade);
        const moved=Math.abs(Number(r.result_return)||0)>=.003;
        return noTrade&&moved;
      });
      const hardReversals=recent.filter(r=>
        (r.direction==="UP"&&r.actual_direction==="DOWN") ||
        (r.direction==="DOWN"&&r.actual_direction==="UP")
      );

      const explorationWins=explorationClosed.filter(r=>Number(r.realized_pnl)>0);
      const explorationLosses=explorationClosed.filter(r=>Number(r.realized_pnl)<0);
      const explorationGrossProfit=explorationWins.reduce((sum,r)=>sum+(Number(r.realized_pnl)||0),0);
      const explorationGrossLoss=Math.abs(explorationLosses.reduce((sum,r)=>sum+(Number(r.realized_pnl)||0),0));
      const explorationProfitFactor=explorationGrossLoss
        ? explorationGrossProfit/explorationGrossLoss
        : explorationGrossProfit>0?Infinity:null;
      const explorationStops=explorationClosed.filter(r=>String(r.source||"").endsWith("_STOP"));
      const explorationTimeouts=explorationClosed.filter(r=>String(r.source||"").endsWith("_TIME_EXIT"));

      const errorRate=ratio(mistakes.length,recent.length);
      const baselineErrorRate=ratio(baseline.filter(r=>r.correct===false).length,baseline.length);
      const highConfErrorRate=ratio(highConfMistakes.length,highConf.length);
      const delta=baseline.length?errorRate-baselineErrorRate:0;

      let level="STABLE";
      if(recent.length>=80 && (
        delta>=.08 ||
        (highConf.length>=25&&highConfErrorRate>=.32) ||
        ratio(hardReversals.length,recent.length)>=.16
      )) level="ALERT";
      else if(recent.length>=50 && (
        delta>=.04 ||
        (highConf.length>=20&&highConfErrorRate>=.24) ||
        ratio(hardReversals.length,recent.length)>=.10
      )) level="WARN";

      const group=(keyFn)=>{
        const m=new Map();
        for(const r of recent){
          const key=keyFn(r);
          if(!key) continue;
          const x=m.get(key)||{key,samples:0,mistakes:0,highConfMistakes:0,avgAbsMove:0};
          x.samples++;
          if(r.correct===false) x.mistakes++;
          if(r.correct===false&&Number(r.confidence)>=.55) x.highConfMistakes++;
          x.avgAbsMove+=Math.abs(Number(r.result_return)||0);
          m.set(key,x);
        }
        return [...m.values()].map(x=>({
          ...x,
          errorRate:ratio(x.mistakes,x.samples),
          avgAbsMove:ratio(x.avgAbsMove,x.samples)
        })).sort((a,b)=>b.errorRate-a.errorRate||b.samples-a.samples);
      };

      const bySymbol=group(r=>r.symbol).filter(x=>x.samples>=5).slice(0,8);
      const byTime=group(r=>etBucket(r.created_at)).filter(x=>x.samples>=5);
      const byCall=group(r=>r.direction).filter(x=>x.samples>=5);

      const confusion={};
      for(const r of recent){
        const key=`${r.direction||"?"}->${r.actual_direction||"?"}`;
        confusion[key]=(confusion[key]||0)+1;
      }

      const lessons=[];
      const up=byCall.find(x=>x.key==="UP");
      const down=byCall.find(x=>x.key==="DOWN");
      const flat=byCall.find(x=>x.key==="FLAT");
      if(up?.samples>=10&&up.errorRate>=.55){
        lessons.push({
          key:"up_overcall",severity:up.errorRate>=.68?"HIGH":"MEDIUM",
          title:"UP calls are failing too often",
          text:`${Math.round(up.errorRate*100)}% of recent UP calls were wrong across ${up.samples} scored outcomes. New challengers need to reduce this bias.`
        });
      }
      if(down?.samples>=10&&down.errorRate>=.55){
        lessons.push({
          key:"down_overcall",severity:down.errorRate>=.68?"HIGH":"MEDIUM",
          title:"DOWN calls are failing too often",
          text:`${Math.round(down.errorRate*100)}% of recent DOWN calls were wrong across ${down.samples} scored outcomes. New challengers need to reduce this bias.`
        });
      }
      if(flat?.samples>=10&&missedMoves.length>=Math.max(5,recent.length*.05)){
        lessons.push({
          key:"flat_missed_moves",severity:"MEDIUM",
          title:"Sideways/no-trade filter missed real moves",
          text:`${missedMoves.length} recent no-trade calls were followed by moves of at least 0.30%. Mistake Lab will keep these as hard examples for the next challenger cycle.`
        });
      }

      const worstSymbol=bySymbol[0];
      if(worstSymbol&&worstSymbol.samples>=8&&worstSymbol.errorRate>=.60){
        lessons.push({
          key:"symbol_"+worstSymbol.key,severity:"MEDIUM",
          title:`${worstSymbol.key} is a current weak spot`,
          text:`${Math.round(worstSymbol.errorRate*100)}% error rate across ${worstSymbol.samples} recent scored ${worstSymbol.key} predictions. The strict lane should be cautious until this improves.`
        });
      }

      const worstTime=byTime[0];
      if(worstTime&&worstTime.samples>=10&&worstTime.errorRate>=.58){
        lessons.push({
          key:"time_"+worstTime.key,severity:"MEDIUM",
          title:`${worstTime.key.replaceAll("_"," ")} is error-prone`,
          text:`${Math.round(worstTime.errorRate*100)}% of recent predictions in this time bucket were wrong. Future challengers should learn a stronger time-of-day filter.`
        });
      }

      if(hardReversals.length>=8){
        lessons.push({
          key:"hard_reversal",severity:"HIGH",
          title:"Directional reversals need attention",
          text:`${hardReversals.length} recent predictions called UP when the result was DOWN or vice versa. These are the most expensive classification mistakes and receive priority in retraining.`
        });
      }

      if(explorationClosed.length>=10 && ratio(explorationLosses.length,explorationClosed.length)>=.60){
        lessons.push({
          key:"exploration_loss_cluster",severity:"MEDIUM",
          title:"Exploration trades are finding a weak zone",
          text:`${explorationLosses.length} of ${explorationClosed.length} recent closed exploration trades lost money. That is useful failure data; the strict proof account remains isolated from it.`
        });
      }
      if(explorationStops.length>=5){
        lessons.push({
          key:"exploration_stops",severity:"MEDIUM",
          title:"Too many exploration trades are hitting the stop",
          text:`${explorationStops.length} recent exploration positions reached the paper stop. Mistake Lab will compare those entries with successful setups during challenger retraining.`
        });
      }
      if(explorationTimeouts.length>=5){
        lessons.push({
          key:"exploration_timeouts",severity:"LOW",
          title:"Some experimental signals are not moving fast enough",
          text:`${explorationTimeouts.length} exploration trades aged out without reaching target or stop. Time-to-move is a useful filter for future challengers.`
        });
      }

      if(!lessons.length){
        lessons.push({
          key:"stable",severity:"LOW",
          title:"No dominant mistake cluster right now",
          text:recent.length
            ?`Mistake Lab studied ${recent.length} recent future outcomes and found no single failure mode strong enough to trigger a new guard.`
            :"Mistake Lab is waiting for scored future predictions."
        });
      }

      const guard={
        level,
        blockStrictEntries:level==="ALERT",
        recentSamples:recent.length,
        baselineSamples:baseline.length,
        errorRate,
        baselineErrorRate,
        errorRateDelta:delta,
        highConfidenceSamples:highConf.length,
        highConfidenceErrorRate:highConfErrorRate,
        hardReversalRate:ratio(hardReversals.length,recent.length),
        reason:level==="ALERT"
          ?"Recent mistakes deteriorated materially. Strict paper entries are blocked while a challenger is retrained."
          :level==="WARN"
            ?"Recent mistakes are weaker than normal. Strict entries remain available but the system is under tighter observation."
            :"Recent scored mistakes are within the current guardrails."
      };

      const summary={
        scoredSamples:recent.length,
        mistakes:mistakes.length,
        correct:recent.length-mistakes.length,
        errorRate,
        highConfMistakes:highConfMistakes.length,
        missedMoves:missedMoves.length,
        hardReversals:hardReversals.length,
        confusion,
        bySymbol,
        byTime,
        byCall,
        exploration:{
          accountId:this.explorationAccountId,
          closedOutcomes:explorationClosed.length,
          wins:explorationWins.length,
          losses:explorationLosses.length,
          winRate:ratio(explorationWins.length,explorationClosed.length),
          grossProfit:explorationGrossProfit,
          grossLoss:explorationGrossLoss,
          profitFactor:explorationProfitFactor,
          stops:explorationStops.length,
          timeouts:explorationTimeouts.length
        },
        latestMistakes:mistakes.slice(0,30).map(r=>({
          id:r.id,symbol:r.symbol,createdAt:r.created_at,
          predicted:r.direction,actual:r.actual_direction,
          confidence:Number(r.confidence)||0,
          resultReturn:Number(r.result_return)||0,
          modelId:r.model_id||null,
          noTrade:Boolean(r.model_details?.noTrade)
        }))
      };

      this.lastAnalysis={
        analyzedAt:new Date().toISOString(),
        ...summary,
        guard,
        lessons
      };

      await this.db.pool.query(`
        INSERT INTO mistake_lab_snapshots(
          scored_samples,mistakes,high_conf_mistakes,missed_moves,guard,lessons,summary
        ) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb)
      `,[
        recent.length,mistakes.length,highConfMistakes.length,missedMoves.length,
        JSON.stringify(guard),JSON.stringify(lessons),JSON.stringify(summary)
      ]);

      this.modelLab?.setMistakeGuard?.(guard);
      this.emit("analysis",this.lastAnalysis);
      console.log(JSON.stringify({
        event:"mistake_lab_analysis",
        samples:recent.length,
        mistakes:mistakes.length,
        highConfMistakes:highConfMistakes.length,
        missedMoves:missedMoves.length,
        explorationClosed:explorationClosed.length,
        explorationLosses:explorationLosses.length,
        level,
        blockStrictEntries:guard.blockStrictEntries
      }));

      await this.#maybeRetrain(guard);
      return this.lastAnalysis;
    }finally{
      this.running=false;
    }
  }

  async #maybeRetrain(guard){
    if(!this.modelLab||this.modelLab.training) return;

    const isAlert=guard.level==="ALERT";
    const isWarn=guard.level==="WARN"&&Number(guard.recentSamples)>=200;
    if(!isAlert&&!isWarn) return;

    const latest=this.modelLab.status?.().latestRun;
    const lastRunAt=latest?.startedAt?+new Date(latest.startedAt):0;
    const lastRequest=Math.max(lastRunAt||0,this.lastRetrainRequestedAt||0);
    const cooldown=isAlert?this.retrainCooldownMs:this.warnRetrainCooldownMs;
    if(Date.now()-lastRequest<cooldown) return;

    this.lastRetrainRequestedAt=Date.now();
    const reason=isAlert?"mistake_lab_alert":"mistake_lab_warn_refresh";
    console.log(JSON.stringify({
      event:"mistake_lab_retrain_requested",
      severity:guard.level,
      reason,
      errorRate:guard.errorRate,
      baselineErrorRate:guard.baselineErrorRate,
      recentSamples:guard.recentSamples
    }));
    setTimeout(()=>{
      this.modelLab.trainNow(reason)
        .catch(err=>this.#capture(err));
    },1000);
  }

  #capture(err){
    this.lastError=String(err?.message||err);
    console.log(JSON.stringify({event:"mistake_lab_error",message:this.lastError}));
  }
}

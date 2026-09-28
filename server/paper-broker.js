import crypto from "node:crypto";

const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));

export class PaperBroker {
  constructor({
    db,marketEngine,accountId="TE_PAPER_MAIN",startingCash=100000,
    fillBufferBps=1.5,maxPositionPct=.10,maxGrossPct=.50,maxPositions=6,
    dailyLossPct=.03,autopilotMinConfidence=.50,autopilotMinEdge=.07,
    autopilotEnabled=true,respectNoTrade=true,entryPositionPct=.05,
    sourceTag="AI_PAPER"
  }){
    this.db=db;
    this.marketEngine=marketEngine;
    this.accountId=accountId;
    this.startingCash=startingCash;
    this.fillBufferBps=fillBufferBps;
    this.maxPositionPct=maxPositionPct;
    this.maxGrossPct=maxGrossPct;
    this.maxPositions=maxPositions;
    this.dailyLossPct=dailyLossPct;
    this.autopilotMinConfidence=autopilotMinConfidence;
    this.autopilotMinEdge=autopilotMinEdge;
    this.autopilotEnabled=Boolean(autopilotEnabled);
    this.respectNoTrade=Boolean(respectNoTrade);
    this.entryPositionPct=clamp(Number(entryPositionPct)||.05,.005,this.maxPositionPct);
    this.sourceTag=String(sourceTag||"AI_PAPER").toUpperCase().replace(/[^A-Z0-9_]/g,"_");
    this.snapshotTimer=null;
    this.processing=new Set();
  }

  async init(){
    await this.db.pool.query(`
      INSERT INTO paper_accounts(account_id,starting_cash,cash,realized_pnl,autopilot_enabled)
      VALUES($1,$2,$2,0,$3)
      ON CONFLICT(account_id) DO NOTHING
    `,[this.accountId,this.startingCash,this.autopilotEnabled]);
    this.snapshotTimer=setInterval(()=>this.recordEquitySnapshot().catch(()=>{}),5*60*1000);
    await this.recordEquitySnapshot().catch(()=>{});
  }

  stop(){ clearInterval(this.snapshotTimer); }

  #marketState(symbol){
    const q=this.marketEngine.latestQuotes.get(symbol)||null;
    const trades=this.marketEngine.latestTrades.get(symbol)||[];
    const rows=this.marketEngine.histories.get(symbol)||[];
    const bar=rows.at(-1)||null;
    const bid=Number(q?.bidPrice),ask=Number(q?.askPrice);
    const bidSize=Math.max(0,Number(q?.bidSize)||0);
    const askSize=Math.max(0,Number(q?.askSize)||0);
    const midpoint=Number.isFinite(bid)&&Number.isFinite(ask)&&bid>0&&ask>0?(bid+ask)/2:null;
    const spread=midpoint!=null?Math.max(0,ask-bid):null;
    const spreadBps=midpoint&&spread!=null?(spread/midpoint)*10000:null;
    const lastTrade=trades.length?Number(trades[0].price):null;
    const barClose=bar?Number(bar.close):null;
    return {
      quote:q,
      bid:Number.isFinite(bid)&&bid>0?bid:null,
      ask:Number.isFinite(ask)&&ask>0?ask:null,
      bidSize,askSize,midpoint,spread,spreadBps,
      lastTrade:Number.isFinite(lastTrade)&&lastTrade>0?lastTrade:null,
      barClose:Number.isFinite(barClose)&&barClose>0?barClose:null,
      mark:midpoint??lastTrade??barClose??null
    };
  }

  #freshQuote(symbol,maxAgeMs=null){
    const s=this.#marketState(symbol);
    if(!s.quote||!s.bid||!s.ask) return null;
    const ts=+new Date(s.quote.ts);
    const allowedAge=maxAgeMs==null?(this.#regularSessionNow()?30000:180000):maxAgeMs;
    if(!Number.isFinite(ts)||Date.now()-ts>allowedAge) return null;
    return {...s,quoteAgeMs:Math.max(0,Date.now()-ts)};
  }

  async #account(){
    const q=await this.db.pool.query(
      "SELECT * FROM paper_accounts WHERE account_id=$1",
      [this.accountId]
    );
    return q.rows[0]||null;
  }

  async #positions(){
    const q=await this.db.pool.query(
      "SELECT * FROM paper_positions WHERE account_id=$1 ORDER BY symbol",
      [this.accountId]
    );
    return q.rows;
  }

  async snapshot(){
    const account=await this.#account();
    const positions=await this.#positions();
    const marked=positions.map(p=>{
      const market=this.#marketState(p.symbol);
      const mark=market.mark??Number(p.avg_price);
      const qty=Number(p.qty);
      const avg=Number(p.avg_price);
      return {
        symbol:p.symbol,
        qty,
        avgPrice:avg,
        mark,
        marketSource:market.midpoint!=null?"MIDPOINT":market.lastTrade!=null?"LAST_TRADE":"LAST_BAR",
        pnl:(mark-avg)*qty,
        openedAt:p.opened_at,
        updatedAt:p.updated_at
      };
    });
    const cash=Number(account?.cash)||0;
    const positionValue=marked.reduce((s,p)=>s+p.qty*p.mark,0);
    const openPnl=marked.reduce((s,p)=>s+p.pnl,0);
    const equity=cash+positionValue;
    const gross=marked.reduce((s,p)=>s+Math.abs(p.qty*p.mark),0);

    const fills=await this.db.pool.query(`
      SELECT
        f.fill_id,f.order_id,f.symbol,f.side,f.qty,f.fill_price,f.market_bid,f.market_ask,
        f.quote_ts,f.fill_model,f.realized_pnl,f.created_at,
        o.source
      FROM paper_fills f
      LEFT JOIN paper_orders o ON o.order_id=f.order_id
      WHERE f.account_id=$1
      ORDER BY f.created_at DESC LIMIT 100
    `,[this.accountId]);
    const fillCount=await this.db.pool.query(
      "SELECT COUNT(*)::int AS n FROM paper_fills WHERE account_id=$1",
      [this.accountId]
    );
    const closed=await this.db.pool.query(`
      SELECT realized_pnl
      FROM paper_fills
      WHERE account_id=$1 AND ABS(realized_pnl) > 0.0000001
      ORDER BY created_at
    `,[this.accountId]);
    const outcomes=closed.rows.map(r=>Number(r.realized_pnl)||0);
    const winners=outcomes.filter(x=>x>0);
    const losers=outcomes.filter(x=>x<0);
    const grossProfit=winners.reduce((a,b)=>a+b,0);
    const grossLoss=Math.abs(losers.reduce((a,b)=>a+b,0));

    const dd=await this.db.pool.query(`
      WITH ordered AS (
        SELECT ts,equity,
          MAX(equity) OVER (
            PARTITION BY account_id ORDER BY ts
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
          ) AS peak
        FROM paper_equity_snapshots
        WHERE account_id=$1
      )
      SELECT COALESCE(MIN((equity-peak)/NULLIF(peak,0)),0) AS max_drawdown
      FROM ordered
    `,[this.accountId]);

    return {
      accountId:this.accountId,
      lane:this.sourceTag.includes("EXPLORE")?"EXPLORATION":"PROOF",
      sourceTag:this.sourceTag,
      respectNoTrade:this.respectNoTrade,
      entryPositionPct:this.entryPositionPct,
      startingCash:Number(account?.starting_cash)||this.startingCash,
      cash,equity,openPnl,
      realizedPnl:Number(account?.realized_pnl)||0,
      grossExposure:gross,
      grossExposurePct:equity?gross/equity:0,
      autopilotEnabled:Boolean(account?.autopilot_enabled),
      fillModel:"TOP_OF_BOOK+DYNAMIC_SPREAD_LIQUIDITY_IMPACT",
      fillCount:Number(fillCount.rows[0]?.n)||0,
      closedOutcomes:outcomes.length,
      winRate:outcomes.length?winners.length/outcomes.length:null,
      avgWinner:winners.length?grossProfit/winners.length:null,
      avgLoser:losers.length?losers.reduce((a,b)=>a+b,0)/losers.length:null,
      profitFactor:grossLoss?grossProfit/grossLoss:(grossProfit>0?Infinity:null),
      maxDrawdown:Number(dd.rows[0]?.max_drawdown)||0,
      positions:marked,
      fills:fills.rows.map(r=>({
        fillId:r.fill_id,orderId:r.order_id,symbol:r.symbol,side:r.side,qty:Number(r.qty),
        fillPrice:Number(r.fill_price),marketBid:r.market_bid==null?null:Number(r.market_bid),
        marketAsk:r.market_ask==null?null:Number(r.market_ask),quoteTs:r.quote_ts,
        fillModel:r.fill_model,source:r.source||null,
        realizedPnl:Number(r.realized_pnl)||0,createdAt:r.created_at
      }))
    };
  }

  async setAutopilot(enabled){
    await this.db.pool.query(`
      UPDATE paper_accounts SET autopilot_enabled=$2,updated_at=NOW()
      WHERE account_id=$1
    `,[this.accountId,Boolean(enabled)]);
    return this.snapshot();
  }

  async suggestedQty(symbol,{positionPct=.05}={}){
    const state=await this.snapshot();
    const market=this.#marketState(symbol);
    const price=market.ask??market.mark;
    if(!price) return 0;
    const notional=Math.max(250,state.equity*clamp(positionPct,.005,this.maxPositionPct));
    return Math.max(1,Math.floor(notional/price));
  }

  async submitMarketOrder({symbol,side,qty,source="MANUAL_PAPER",modelId=null}){
    symbol=String(symbol||"").toUpperCase();
    side=String(side||"").toUpperCase();
    qty=Math.max(1,Math.floor(Number(qty)||0));
    if(!symbol||!["BUY","SELL"].includes(side)||!qty) throw new Error("Invalid paper order");

    const lockKey=symbol;
    if(this.processing.has(lockKey)) throw new Error("Paper order already processing for "+symbol);
    this.processing.add(lockKey);
    try{
      const market=this.#freshQuote(symbol);
      if(!market) return this.#rejectOrder({symbol,side,qty,source,modelId,reason:"NO_FRESH_TOP_OF_BOOK"});

      const spreadBps=Number(market.spreadBps);
      if(!Number.isFinite(spreadBps)||spreadBps<0){
        return this.#rejectOrder({symbol,side,qty,source,modelId,reason:"INVALID_TOP_OF_BOOK"});
      }
      const aiEntry=String(source||"").endsWith("_ENTRY");
      if(spreadBps>100 || (aiEntry&&spreadBps>25)){
        return this.#rejectOrder({
          symbol,side,qty,source,modelId,
          reason:aiEntry?"AI_ENTRY_SPREAD_TOO_WIDE":"SPREAD_TOO_WIDE"
        });
      }

      const displayedSize=side==="BUY"?market.askSize:market.bidSize;
      const liquidityRatio=displayedSize>0?qty/displayedSize:2;
      const spreadPenaltyBps=Math.min(15,Math.max(0,spreadBps)*.25);
      const sizePenaltyBps=Math.min(20,Math.max(0,liquidityRatio-.5)*3);
      const effectiveBufferBps=Math.min(
        35,
        Math.max(this.fillBufferBps,this.fillBufferBps+spreadPenaltyBps+sizePenaltyBps)
      );
      const buffer=effectiveBufferBps/10000;
      const fillPrice=side==="BUY"?market.ask*(1+buffer):market.bid*(1-buffer);
      const quoteTs=new Date(market.quote.ts);
      const snapshot=await this.snapshot();
      const old=snapshot.positions.find(p=>p.symbol===symbol)||null;
      const oldQty=Number(old?.qty)||0;
      const signed=side==="BUY"?qty:-qty;
      const newQty=oldQty+signed;
      const isOpening=!oldQty&&newQty;
      const increasesExposure=Math.abs(newQty)>Math.abs(oldQty);
      const asset=await this.db.findAsset(symbol);

      if(newQty<0 && !asset?.shortable){
        return this.#rejectOrder({symbol,side,qty,source,modelId,reason:"SYMBOL_NOT_SHORTABLE"});
      }
      if(isOpening && snapshot.positions.length>=this.maxPositions){
        return this.#rejectOrder({symbol,side,qty,source,modelId,reason:"MAX_POSITIONS"});
      }

      const prospectiveNotional=Math.abs(newQty*fillPrice);
      if(increasesExposure && prospectiveNotional>snapshot.equity*this.maxPositionPct){
        return this.#rejectOrder({symbol,side,qty,source,modelId,reason:"MAX_POSITION_EXPOSURE"});
      }
      const oldNotional=Math.abs(oldQty*(old?.mark||fillPrice));
      const grossAfter=snapshot.grossExposure-oldNotional+prospectiveNotional;
      if(increasesExposure && grossAfter>snapshot.equity*this.maxGrossPct){
        return this.#rejectOrder({symbol,side,qty,source,modelId,reason:"MAX_GROSS_EXPOSURE"});
      }
      if(side==="BUY" && fillPrice*qty>snapshot.cash){
        return this.#rejectOrder({symbol,side,qty,source,modelId,reason:"INSUFFICIENT_CASH"});
      }
      const dayBase=await this.#dailyEquityBaseline();
      if(dayBase>0 && snapshot.equity<=dayBase*(1-this.dailyLossPct)){
        await this.setAutopilot(false);
        return this.#rejectOrder({symbol,side,qty,source,modelId,reason:"PAPER_DAILY_LOSS_LIMIT"});
      }

      return await this.#fillOrder({
        symbol,side,qty,fillPrice,market,quoteTs,source,modelId,oldQty,
        oldAvg:Number(old?.avgPrice)||0,
        execution:{spreadBps,displayedSize,liquidityRatio,effectiveBufferBps,quoteAgeMs:market.quoteAgeMs}
      });
    }finally{
      this.processing.delete(lockKey);
    }
  }

  async #dailyEquityBaseline(){
    const q=await this.db.pool.query(`
      SELECT equity
      FROM paper_equity_snapshots
      WHERE account_id=$1
        AND (ts AT TIME ZONE 'America/New_York')::date =
            (NOW() AT TIME ZONE 'America/New_York')::date
      ORDER BY ts ASC
      LIMIT 1
    `,[this.accountId]);
    return q.rowCount?Number(q.rows[0].equity)||0:0;
  }

  async #rejectOrder({symbol,side,qty,source,modelId,reason}){
    const orderId="PO-"+crypto.randomUUID();
    await this.db.pool.query(`
      INSERT INTO paper_orders(
        order_id,account_id,symbol,side,qty,status,source,model_id,reference_quote,reject_reason
      ) VALUES($1,$2,$3,$4,$5,'REJECTED',$6,$7,'{}'::jsonb,$8)
    `,[orderId,this.accountId,symbol,side,qty,source,modelId,reason]);
    return {ok:false,orderId,status:"REJECTED",reason};
  }

  async #fillOrder({symbol,side,qty,fillPrice,market,quoteTs,source,modelId,oldQty,oldAvg,execution={}}){
    const orderId="PO-"+crypto.randomUUID();
    const fillId="PF-"+crypto.randomUUID();
    const signed=side==="BUY"?qty:-qty;
    const newQty=oldQty+signed;
    let realized=0;
    let newAvg=oldAvg;

    if(!oldQty || Math.sign(oldQty)===Math.sign(signed)){
      const oldNotional=Math.abs(oldQty)*oldAvg;
      const addNotional=Math.abs(signed)*fillPrice;
      newAvg=(oldNotional+addNotional)/Math.max(1,Math.abs(newQty));
    }else{
      const closingQty=Math.min(Math.abs(oldQty),Math.abs(signed));
      realized=(fillPrice-oldAvg)*closingQty*Math.sign(oldQty);
      if(newQty===0) newAvg=0;
      else if(Math.sign(newQty)!==Math.sign(oldQty)) newAvg=fillPrice;
      else newAvg=oldAvg;
    }

    const client=await this.db.pool.connect();
    try{
      await client.query("BEGIN");
      await client.query(`
        INSERT INTO paper_orders(
          order_id,account_id,symbol,side,qty,status,source,model_id,requested_at,filled_at,reference_quote
        ) VALUES($1,$2,$3,$4,$5,'FILLED',$6,$7,NOW(),NOW(),$8::jsonb)
      `,[
        orderId,this.accountId,symbol,side,qty,source,modelId,
        JSON.stringify({
          bid:market.bid,ask:market.ask,bidSize:market.bidSize,askSize:market.askSize,
          ts:market.quote.ts,spreadBps:execution.spreadBps,
          displayedSize:execution.displayedSize,liquidityRatio:execution.liquidityRatio,
          effectiveBufferBps:execution.effectiveBufferBps,quoteAgeMs:execution.quoteAgeMs
        })
      ]);

      await client.query(`
        INSERT INTO paper_fills(
          fill_id,order_id,account_id,symbol,side,qty,fill_price,market_bid,market_ask,quote_ts,fill_model,realized_pnl
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      `,[
        fillId,orderId,this.accountId,symbol,side,qty,fillPrice,
        market.bid,market.ask,quoteTs,
        `TOP_OF_BOOK+DYNAMIC_${Number(execution.effectiveBufferBps||this.fillBufferBps).toFixed(1)}bps`,realized
      ]);

      await client.query(`
        UPDATE paper_accounts
        SET cash=cash-$2,realized_pnl=realized_pnl+$3,updated_at=NOW()
        WHERE account_id=$1
      `,[this.accountId,signed*fillPrice,realized]);

      if(newQty===0){
        await client.query(
          "DELETE FROM paper_positions WHERE account_id=$1 AND symbol=$2",
          [this.accountId,symbol]
        );
      }else{
        await client.query(`
          INSERT INTO paper_positions(account_id,symbol,qty,avg_price,opened_at,updated_at)
          VALUES($1,$2,$3,$4,NOW(),NOW())
          ON CONFLICT(account_id,symbol) DO UPDATE SET
            qty=EXCLUDED.qty,
            avg_price=EXCLUDED.avg_price,
            opened_at=CASE
              WHEN paper_positions.qty*EXCLUDED.qty < 0 THEN NOW()
              ELSE paper_positions.opened_at
            END,
            updated_at=NOW()
        `,[this.accountId,symbol,newQty,newAvg]);
      }
      await client.query("COMMIT");
    }catch(err){
      await client.query("ROLLBACK");
      throw err;
    }finally{
      client.release();
    }

    return {
      ok:true,orderId,fillId,status:"FILLED",symbol,side,qty,
      fillPrice,marketBid:market.bid,marketAsk:market.ask,quoteTs,
      realized,
      execution,
      fillModel:`TOP_OF_BOOK+DYNAMIC_${Number(execution.effectiveBufferBps||this.fillBufferBps).toFixed(1)}bps`
    };
  }

  async flatten(symbol,{source="MANUAL_FLATTEN",modelId=null}={}){
    const snap=await this.snapshot();
    const pos=snap.positions.find(p=>p.symbol===String(symbol).toUpperCase());
    if(!pos?.qty) return {ok:false,status:"NO_POSITION"};
    return this.submitMarketOrder({
      symbol:pos.symbol,
      side:pos.qty>0?"SELL":"BUY",
      qty:Math.abs(pos.qty),
      source,modelId
    });
  }

  #regularSessionNow(){
    const parts=Object.fromEntries(
      new Intl.DateTimeFormat("en-US",{
        timeZone:"America/New_York",
        weekday:"short",hour:"2-digit",minute:"2-digit",hourCycle:"h23"
      }).formatToParts(new Date()).filter(x=>x.type!=="literal").map(x=>[x.type,x.value])
    );
    if(["Sat","Sun"].includes(parts.weekday)) return false;
    const minute=Number(parts.hour)*60+Number(parts.minute);
    return minute>=9*60+30 && minute<16*60;
  }

  async handlePrediction(prediction){
    const account=await this.#account();
    if(!account?.autopilot_enabled||!prediction) return;
    if(!this.#regularSessionNow()) return;
    if(!prediction.modelId) return;
    if(this.respectNoTrade&&prediction.noTrade) return;
    if(Number(prediction.confidence)<this.autopilotMinConfidence) return;
    if(Number(prediction.edge)<this.autopilotMinEdge) return;
    if(!["UP","DOWN"].includes(prediction.direction)) return;

    const snap=await this.snapshot();
    const pos=snap.positions.find(p=>p.symbol===prediction.symbol);
    const desired=prediction.direction==="UP"?1:-1;

    if(pos){
      if(Math.sign(pos.qty)!==desired){
        await this.flatten(prediction.symbol,{source:this.sourceTag+"_EXIT",modelId:prediction.modelId});
      }
      return;
    }

    const qty=await this.suggestedQty(prediction.symbol,{positionPct:this.entryPositionPct});
    if(!qty) return;
    await this.submitMarketOrder({
      symbol:prediction.symbol,
      side:desired>0?"BUY":"SELL",
      qty,
      source:this.sourceTag+"_ENTRY",
      modelId:prediction.modelId
    });
  }

  async onBar(bar){
    if(!bar?.symbol) return;
    const snap=await this.snapshot();
    const pos=snap.positions.find(p=>p.symbol===bar.symbol);
    if(!pos) return;

    const ret=pos.qty>0
      ? (Number(bar.close)-pos.avgPrice)/pos.avgPrice
      : (pos.avgPrice-Number(bar.close))/pos.avgPrice;
    const age=Date.now()-new Date(pos.openedAt).getTime();

    if(ret<=-.005){
      await this.flatten(bar.symbol,{source:this.sourceTag+"_STOP"});
    }else if(ret>=.009){
      await this.flatten(bar.symbol,{source:this.sourceTag+"_TARGET"});
    }else if(age>=75*60*1000){
      await this.flatten(bar.symbol,{source:this.sourceTag+"_TIME_EXIT"});
    }
  }

  async recordEquitySnapshot(){
    const s=await this.snapshot();
    await this.db.pool.query(`
      INSERT INTO paper_equity_snapshots(
        account_id,ts,equity,cash,open_pnl,realized_pnl,positions
      ) VALUES($1,date_trunc('minute',NOW()),$2,$3,$4,$5,$6::jsonb)
      ON CONFLICT(account_id,ts) DO UPDATE SET
        equity=EXCLUDED.equity,cash=EXCLUDED.cash,open_pnl=EXCLUDED.open_pnl,
        realized_pnl=EXCLUDED.realized_pnl,positions=EXCLUDED.positions
    `,[
      this.accountId,s.equity,s.cash,s.openPnl,s.realizedPnl,JSON.stringify(s.positions)
    ]);
  }
}

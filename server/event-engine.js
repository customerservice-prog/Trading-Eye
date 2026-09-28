const sleep=ms=>new Promise(r=>setTimeout(r,ms));

export class EventEngine {
  constructor({db,marketEngine,key="",secret=""}){
    this.db=db;
    this.marketEngine=marketEngine;
    this.key=key;
    this.secret=secret;
    this.timer=null;
    this.secTickerMap=new Map();
    this.secTickerLoadedAt=0;
    this.lastPollAt=null;
    this.lastError=null;
    this.newsEvents=0;
    this.secEvents=0;
    this.riskCache=new Map();
  }

  async init(){
    await this.poll().catch(err=>this.#capture(err));
    this.timer=setInterval(()=>this.poll().catch(err=>this.#capture(err)),5*60*1000);
  }

  stop(){ clearInterval(this.timer); }

  status(){
    return {
      lastPollAt:this.lastPollAt,lastError:this.lastError,
      newsEvents:this.newsEvents,secEvents:this.secEvents,
      secTickers:this.secTickerMap.size
    };
  }

  async #upsertEvent(e){
    await this.db.pool.query(`
      INSERT INTO market_events(
        event_id,source,symbol,event_type,headline,event_ts,importance,details
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
      ON CONFLICT(event_id) DO UPDATE SET
        headline=EXCLUDED.headline,event_ts=EXCLUDED.event_ts,
        importance=EXCLUDED.importance,details=EXCLUDED.details
    `,[
      e.eventId,e.source,e.symbol||null,e.eventType,e.headline||null,
      e.eventTs,Number(e.importance)||0,JSON.stringify(e.details||{})
    ]);
  }

  async #loadSecTickers(){
    if(this.secTickerMap.size && Date.now()-this.secTickerLoadedAt<24*60*60*1000) return;
    const res=await fetch("https://www.sec.gov/files/company_tickers.json",{
      headers:{
        "user-agent":"TradingEye research customerservice@friendlypartyrental.com",
        "accept":"application/json"
      }
    });
    if(!res.ok) throw new Error("SEC ticker map HTTP "+res.status);
    const data=await res.json();
    const map=new Map();
    for(const row of Object.values(data||{})){
      if(!row?.ticker||row.cik_str==null) continue;
      map.set(String(row.ticker).toUpperCase(),String(row.cik_str).padStart(10,"0"));
    }
    this.secTickerMap=map;
    this.secTickerLoadedAt=Date.now();
  }

  async #pollSec(symbols){
    await this.#loadSecTickers();
    const important=new Set(["8-K","10-Q","10-K","6-K","20-F","S-1","S-3","SC 13D","SC 13G"]);
    let added=0;
    for(const symbol of symbols.slice(0,12)){
      const cik=this.secTickerMap.get(symbol);
      if(!cik) continue;
      try{
        const res=await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`,{
          headers:{
            "user-agent":"TradingEye research customerservice@friendlypartyrental.com",
            "accept":"application/json"
          }
        });
        if(!res.ok) continue;
        const data=await res.json();
        const recent=data?.filings?.recent||{};
        const forms=recent.form||[];
        for(let i=0;i<Math.min(forms.length,40);i++){
          const form=String(forms[i]||"");
          if(!important.has(form)) continue;
          const filingDate=recent.filingDate?.[i];
          const accepted=recent.acceptanceDateTime?.[i];
          const accession=recent.accessionNumber?.[i];
          if(!filingDate||!accession) continue;
          const ts=accepted ? new Date(accepted) : new Date(filingDate+"T16:00:00-04:00");
          if(Date.now()-ts.getTime()>14*24*60*60*1000) continue;
          const importance=["8-K","10-Q","10-K"].includes(form)?.85:.65;
          await this.#upsertEvent({
            eventId:`sec-${cik}-${accession}`,
            source:"SEC",
            symbol,eventType:"SEC_FILing".toUpperCase(),
            headline:`${symbol} filed ${form}`,
            eventTs:ts,
            importance,
            details:{form,filingDate,accession,cik}
          });
          added++;
        }
      }catch{}
      await sleep(120);
    }
    this.secEvents=added;
  }

  async #pollAlpacaNews(symbols){
    if(!this.key||!this.secret||!symbols.length) return;
    const params=new URLSearchParams({
      symbols:symbols.slice(0,20).join(","),
      limit:"50",
      sort:"desc",
      include_content:"false"
    });
    const res=await fetch("https://data.alpaca.markets/v1beta1/news?"+params,{
      headers:{
        "APCA-API-KEY-ID":this.key,
        "APCA-API-SECRET-KEY":this.secret,
        "accept":"application/json"
      }
    });
    if(!res.ok) return;
    const data=await res.json();
    let added=0;
    for(const n of data?.news||[]){
      const created=new Date(n.created_at||n.updated_at||Date.now());
      if(Date.now()-created.getTime()>3*24*60*60*1000) continue;
      for(const symbol of (n.symbols||[]).filter(s=>symbols.includes(String(s).toUpperCase()))){
        await this.#upsertEvent({
          eventId:`alpaca-news-${n.id}-${symbol}`,
          source:"ALPACA_NEWS",
          symbol:String(symbol).toUpperCase(),
          eventType:"NEWS",
          headline:n.headline||"Market news",
          eventTs:created,
          importance:.55,
          details:{id:n.id,author:n.author||null,url:n.url||null}
        });
        added++;
      }
    }
    this.newsEvents=added;
  }

  async poll(){
    const symbols=[...new Set(this.marketEngine?.hotSymbols?.()||[])];
    if(!symbols.length) return;
    this.lastError=null;
    await Promise.allSettled([
      this.#pollAlpacaNews(symbols),
      this.#pollSec(symbols)
    ]);
    this.lastPollAt=new Date().toISOString();
    this.riskCache.clear();
  }

  async riskForSymbol(symbol,at=new Date()){
    symbol=String(symbol||"").toUpperCase();
    const key=symbol+"|"+Math.floor(new Date(at).getTime()/60000);
    if(this.riskCache.has(key)) return this.riskCache.get(key);
    const q=await this.db.pool.query(`
      SELECT source,event_type,headline,event_ts,importance
      FROM market_events
      WHERE symbol=$1
        AND event_ts BETWEEN $2::timestamptz - interval '24 hours'
                         AND $2::timestamptz + interval '2 hours'
      ORDER BY importance DESC,event_ts DESC
      LIMIT 20
    `,[symbol,new Date(at)]);
    const events=q.rows;
    const recent=events.filter(e=>Math.abs(new Date(at)-new Date(e.event_ts))<=6*60*60*1000);
    const risk=Math.min(1,recent.reduce((m,e)=>Math.max(m,Number(e.importance)||0),0));
    const result={
      risk,
      blocked:risk>=.80,
      elevated:risk>=.55,
      events:events.map(e=>({
        source:e.source,type:e.event_type,headline:e.headline,
        eventTs:e.event_ts,importance:Number(e.importance)||0
      }))
    };
    this.riskCache.set(key,result);
    return result;
  }

  #capture(err){
    this.lastError=String(err?.message||err);
    console.log(JSON.stringify({event:"event_engine_error",message:this.lastError}));
  }
}

import crypto from "node:crypto";

const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function sicSector(sic){
  const n=Number(String(sic||"").replace(/\D/g,""));
  if(!Number.isFinite(n)) return {sector:"Unknown",proxy:null};
  if(n>=100&&n<1000) return {sector:"Energy",proxy:"XLE"};
  if(n>=1000&&n<1500) return {sector:"Materials",proxy:"XLB"};
  if(n>=1500&&n<1800) return {sector:"Industrials",proxy:"XLI"};
  if(n>=2000&&n<4000){
    if(n>=2830&&n<2840) return {sector:"Health Care",proxy:"XLV"};
    if(n>=3570&&n<3580) return {sector:"Technology",proxy:"XLK"};
    if(n>=3670&&n<3680) return {sector:"Technology",proxy:"XLK"};
    if(n>=3600&&n<3700) return {sector:"Technology",proxy:"XLK"};
    return {sector:"Industrials",proxy:"XLI"};
  }
  if(n>=4000&&n<5000) return {sector:"Industrials",proxy:"XLI"};
  if(n>=5000&&n<5200) return {sector:"Consumer Discretionary",proxy:"XLY"};
  if(n>=5200&&n<6000) return {sector:"Consumer Discretionary",proxy:"XLY"};
  if(n>=6000&&n<6800) return {sector:"Financials",proxy:"XLF"};
  if(n>=6500&&n<6600) return {sector:"Real Estate",proxy:"XLRE"};
  if(n>=7000&&n<7300) return {sector:"Consumer Discretionary",proxy:"XLY"};
  if(n>=7300&&n<7400) return {sector:"Technology",proxy:"XLK"};
  if(n>=8000&&n<8100) return {sector:"Health Care",proxy:"XLV"};
  if(n>=4900&&n<5000) return {sector:"Utilities",proxy:"XLU"};
  return {sector:"Unknown",proxy:null};
}

export class MarketIntegrity {
  constructor({db,key,secret,hotSymbols=()=>[]}){
    this.db=db;
    this.key=key;
    this.secret=secret;
    this.hotSymbols=hotSymbols;
    this.timer=null;
    this.secTimer=null;
    this.lastAssetSync=null;
    this.lastCorporateActionSync=null;
    this.lastSecSync=null;
    this.syncing=false;
  }

  configured(){return Boolean(this.key&&this.secret);}

  async init(){
    await this.syncAssetsAll().catch(err=>this.#incident("ASSET_SYNC","WARN",null,String(err?.message||err)));
    await this.syncCorporateActions({days:120}).catch(err=>this.#incident("CORPORATE_ACTION_SYNC","WARN",null,String(err?.message||err)));
    await this.syncSecHotSet().catch(()=>{});
    this.timer=setInterval(()=>this.tick().catch(()=>{}),60*60*1000);
    this.secTimer=setInterval(()=>this.syncSecHotSet().catch(()=>{}),6*60*60*1000);
  }

  stop(){
    clearInterval(this.timer);
    clearInterval(this.secTimer);
  }

  status(){
    return {
      lastAssetSync:this.lastAssetSync,
      lastCorporateActionSync:this.lastCorporateActionSync,
      lastSecSync:this.lastSecSync
    };
  }

  async tick(){
    const now=Date.now();
    if(!this.lastAssetSync||now-new Date(this.lastAssetSync).getTime()>24*60*60*1000){
      await this.syncAssetsAll();
    }
    if(!this.lastCorporateActionSync||now-new Date(this.lastCorporateActionSync).getTime()>6*60*60*1000){
      await this.syncCorporateActions({days:120});
    }
  }

  async syncAssetsAll(){
    if(!this.configured()) return;
    const res=await fetch("https://paper-api.alpaca.markets/v2/assets?status=all&asset_class=us_equity",{
      headers:{
        "APCA-API-KEY-ID":this.key,
        "APCA-API-SECRET-KEY":this.secret,
        accept:"application/json"
      }
    });
    if(!res.ok) throw new Error("Alpaca all-assets HTTP "+res.status);
    const rows=await res.json();
    const date=new Date().toISOString().slice(0,10);
    for(let i=0;i<rows.length;i+=500){
      const chunk=rows.slice(i,i+500);
      const vals=[];
      const ph=[];
      chunk.forEach((a,j)=>{
        const n=j*8;
        ph.push("(" + Array.from({length:8},(_,k)=>"$"+(n+k+1)).join(",") + ")");
        vals.push(
          String(a.symbol||"").toUpperCase(),date,a.status||"unknown",a.exchange||null,
          a.name||null,Boolean(a.tradable),"alpaca",JSON.stringify({
            asset_class:a.class||null,attributes:a.attributes||[],
            shortable:Boolean(a.shortable),fractionable:Boolean(a.fractionable)
          })
        );
      });
      await this.db.pool.query(`
        INSERT INTO asset_lifecycle(
          symbol,as_of_date,status,exchange,name,tradable,source,details
        ) VALUES ${ph.join(",")}
        ON CONFLICT(symbol,as_of_date,source) DO UPDATE SET
          status=EXCLUDED.status,exchange=EXCLUDED.exchange,name=EXCLUDED.name,
          tradable=EXCLUDED.tradable,details=EXCLUDED.details
      `,vals);
    }
    this.lastAssetSync=new Date().toISOString();
  }

  async syncCorporateActions({days=120}={}){
    if(!this.configured()) return;
    const end=new Date();
    const start=new Date(end.getTime()-days*86400000);
    let token=null;
    let count=0;
    do{
      const params=new URLSearchParams({
        start:start.toISOString().slice(0,10),
        end:end.toISOString().slice(0,10),
        limit:"1000",
        sort:"asc",
        data_quality:"complete",
        cas_region:"us"
      });
      if(token) params.set("page_token",token);
      const res=await fetch("https://data.alpaca.markets/v1/corporate-actions?"+params,{
        headers:{
          "APCA-API-KEY-ID":this.key,
          "APCA-API-SECRET-KEY":this.secret,
          accept:"application/json"
        }
      });
      if(!res.ok) throw new Error("Alpaca corporate-actions HTTP "+res.status);
      const body=await res.json();
      const actionGroups=Object.entries(body||{}).filter(([k,v])=>Array.isArray(v));
      for(const [group,items] of actionGroups){
        for(const item of items){
          const symbol=String(item.symbol||item.old_symbol||item.new_symbol||"").toUpperCase()||null;
          const id=String(item.id||crypto.createHash("sha1").update(JSON.stringify(item)).digest("hex"));
          const ratio=Number(item.new_rate||item.ratio||item.rate||item.cash)||null;
          const cash=Number(item.cash||item.amount||item.cash_amount)||null;
          await this.db.pool.query(`
            INSERT INTO corporate_actions(
              action_id,symbol,action_type,process_date,ex_date,record_date,payable_date,
              old_symbol,new_symbol,ratio,cash_amount,currency,source,raw,updated_at
            ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'alpaca',$13::jsonb,NOW())
            ON CONFLICT(action_id) DO UPDATE SET
              symbol=EXCLUDED.symbol,action_type=EXCLUDED.action_type,
              process_date=EXCLUDED.process_date,ex_date=EXCLUDED.ex_date,
              record_date=EXCLUDED.record_date,payable_date=EXCLUDED.payable_date,
              old_symbol=EXCLUDED.old_symbol,new_symbol=EXCLUDED.new_symbol,
              ratio=EXCLUDED.ratio,cash_amount=EXCLUDED.cash_amount,
              currency=EXCLUDED.currency,raw=EXCLUDED.raw,updated_at=NOW()
          `,[
            id,symbol,String(group).replace(/s$/,""),
            item.process_date||null,item.ex_date||null,item.record_date||null,item.payable_date||null,
            item.old_symbol||null,item.new_symbol||null,Number.isFinite(ratio)?ratio:null,
            Number.isFinite(cash)?cash:null,item.currency||null,JSON.stringify(item)
          ]);
          count++;
        }
      }
      token=body?.next_page_token||null;
      if(token) await sleep(250);
    }while(token);
    this.lastCorporateActionSync=new Date().toISOString();
    console.log(JSON.stringify({event:"market_integrity_corporate_actions",count}));
  }

  async syncSecHotSet(){
    const symbols=[...new Set(this.hotSymbols().map(s=>String(s).toUpperCase()))].slice(0,24);
    if(!symbols.length) return;
    const tickersRes=await fetch("https://www.sec.gov/files/company_tickers.json",{
      headers:{"user-agent":"Trading Eye customerservice@friendlypartyrental.com","accept":"application/json"}
    });
    if(!tickersRes.ok) return;
    const all=await tickersRes.json();
    const byTicker=new Map(Object.values(all||{}).map(x=>[String(x.ticker||"").toUpperCase(),x]));
    for(const symbol of symbols){
      const meta=byTicker.get(symbol);
      if(!meta) continue;
      const cik=String(meta.cik_str).padStart(10,"0");
      try{
        const res=await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`,{
          headers:{"user-agent":"Trading Eye customerservice@friendlypartyrental.com","accept":"application/json"}
        });
        if(!res.ok) continue;
        const body=await res.json();
        const sic=body.sic||null;
        const sector=sicSector(sic);
        await this.db.pool.query(`
          INSERT INTO asset_metadata(
            symbol,cik,sic_code,sic_description,sector,sector_proxy,industry,source,updated_at,details
          ) VALUES($1,$2,$3,$4,$5,$6,$7,'sec',NOW(),$8::jsonb)
          ON CONFLICT(symbol) DO UPDATE SET
            cik=EXCLUDED.cik,sic_code=EXCLUDED.sic_code,sic_description=EXCLUDED.sic_description,
            sector=EXCLUDED.sector,sector_proxy=EXCLUDED.sector_proxy,industry=EXCLUDED.industry,
            source='sec',updated_at=NOW(),details=EXCLUDED.details
        `,[
          symbol,cik,sic,body.sicDescription||null,sector.sector,sector.proxy,
          body.category||null,JSON.stringify({entityType:body.entityType||null})
        ]);

        const recent=body.filings?.recent||{};
        const forms=recent.form||[];
        const dates=recent.filingDate||[];
        const accession=recent.accessionNumber||[];
        const primary=recent.primaryDocument||[];
        for(let i=0;i<Math.min(forms.length,50);i++){
          const form=String(forms[i]||"");
          if(!["8-K","10-Q","10-K","6-K","S-1","S-3"].includes(form)) continue;
          const eventId=`SEC:${symbol}:${accession[i]||i}`;
          const acc=String(accession[i]||"").replaceAll("-","");
          const url=acc&&primary[i]
            ?`https://www.sec.gov/Archives/edgar/data/${Number(meta.cik_str)}/${acc}/${primary[i]}`
            :null;
          const severity=form==="8-K"?1:form==="10-Q"||form==="10-K"?.85:.65;
          await this.db.pool.query(`
            INSERT INTO material_events(
              event_id,symbol,event_type,event_ts,source,headline,accession_no,url,severity,raw
            ) VALUES($1,$2,$3,$4::date,'sec',$5,$6,$7,$8,$9::jsonb)
            ON CONFLICT(event_id) DO NOTHING
          `,[
            eventId,symbol,form,dates[i]||new Date().toISOString().slice(0,10),
            `${form} filing`,accession[i]||null,url,severity,
            JSON.stringify({form,filingDate:dates[i]||null})
          ]);
        }
      }catch{}
      await sleep(120);
    }
    this.lastSecSync=new Date().toISOString();
  }

  async context(symbol,ts=new Date()){
    symbol=String(symbol||"").toUpperCase();
    const t=new Date(ts);
    const before=new Date(t.getTime()-3*86400000);
    const after=new Date(t.getTime()+3*86400000);
    const [meta,corp,events,lifecycle]=await Promise.all([
      this.db.pool.query("SELECT * FROM asset_metadata WHERE symbol=$1 LIMIT 1",[symbol]),
      this.db.pool.query(`
        SELECT action_type,COALESCE(ex_date,process_date) AS event_date
        FROM corporate_actions
        WHERE symbol=$1 AND COALESCE(ex_date,process_date) BETWEEN $2::date AND $3::date
        ORDER BY event_date
      `,[symbol,before.toISOString().slice(0,10),after.toISOString().slice(0,10)]),
      this.db.pool.query(`
        SELECT event_type,event_ts,severity
        FROM material_events
        WHERE symbol=$1 AND event_ts BETWEEN $2 AND $3
        ORDER BY event_ts DESC
      `,[symbol,new Date(t.getTime()-7*86400000),new Date(t.getTime()+86400000)]),
      this.db.pool.query(`
        SELECT status,as_of_date FROM asset_lifecycle
        WHERE symbol=$1 AND as_of_date <= $2::date
        ORDER BY as_of_date DESC LIMIT 1
      `,[symbol,t.toISOString().slice(0,10)])
    ]);
    const eventRisk=Math.min(1,events.rows.reduce((s,e)=>s+Number(e.severity||0),0));
    const corporateActionRisk=corp.rowCount?1:0;
    return {
      metadata:meta.rows[0]||null,
      sectorProxy:meta.rows[0]?.sector_proxy||null,
      eventRisk,
      corporateActionRisk,
      lifecycle:lifecycle.rows[0]||null,
      events:events.rows,
      corporateActions:corp.rows
    };
  }

  async exclusionMap({symbols,start,end}){
    if(!symbols?.length) return new Map();
    const q=await this.db.pool.query(`
      SELECT symbol,COALESCE(ex_date,process_date) AS d
      FROM corporate_actions
      WHERE symbol = ANY($1::text[])
        AND COALESCE(ex_date,process_date) BETWEEN $2::date AND $3::date
    `,[symbols,new Date(start).toISOString().slice(0,10),new Date(end).toISOString().slice(0,10)]);
    const map=new Map();
    for(const r of q.rows){
      if(!map.has(r.symbol)) map.set(r.symbol,new Set());
      const base=+new Date(String(r.d).slice(0,10)+"T12:00:00Z");
      for(let k=-2;k<=2;k++){
        map.get(r.symbol).add(new Date(base+k*86400000).toISOString().slice(0,10));
      }
    }
    return map;
  }

  async #incident(category,severity,symbol,message,details={}){
    const id=crypto.randomUUID();
    await this.db.pool.query(`
      INSERT INTO data_quality_incidents(
        incident_id,severity,category,symbol,source,message,details
      ) VALUES($1,$2,$3,$4,'market_integrity',$5,$6::jsonb)
    `,[id,severity,category,symbol,message,JSON.stringify(details)]);
  }
}

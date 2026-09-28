const sleep=ms=>new Promise(r=>setTimeout(r,ms));

export class ContextPoller {
  constructor({db,key,secret,modelLab,feed="iex"}){
    this.db=db;
    this.key=key;
    this.secret=secret;
    this.modelLab=modelLab;
    this.feed=feed;
    this.symbols=["SPY","QQQ","XLK","XLF","XLV","XLY","XLP","XLI","XLE","XLB","XLU","XLRE","XLC"];
    this.timer=null;
    this.lastPollAt=null;
    this.lastError=null;
  }

  configured(){return Boolean(this.key&&this.secret);}

  async init(){
    await this.poll().catch(err=>{this.lastError=String(err?.message||err);});
    this.timer=setInterval(()=>this.poll().catch(err=>{this.lastError=String(err?.message||err);}),60*1000);
  }

  stop(){clearInterval(this.timer);}

  status(){
    return {
      configured:this.configured(),
      symbols:this.symbols,
      feed:this.feed,
      lastPollAt:this.lastPollAt,
      lastError:this.lastError
    };
  }

  async poll(){
    if(!this.configured()) return;
    const params=new URLSearchParams({
      symbols:this.symbols.join(","),
      feed:this.feed
    });
    const res=await fetch("https://data.alpaca.markets/v2/stocks/bars/latest?"+params,{
      headers:{
        "APCA-API-KEY-ID":this.key,
        "APCA-API-SECRET-KEY":this.secret,
        accept:"application/json"
      }
    });
    if(!res.ok){
      const body=await res.text();
      throw new Error(`Context latest-bars HTTP ${res.status}: ${body.slice(0,180)}`);
    }
    const body=await res.json();
    const bars=body.bars||{};
    const persist=[];
    for(const [symbol,r] of Object.entries(bars)){
      if(!r?.t) continue;
      const bar={
        provider:"alpaca",
        feed:this.feed,
        symbol:String(symbol).toUpperCase(),
        ts:new Date(r.t),
        open:Number(r.o),
        high:Number(r.h),
        low:Number(r.l),
        close:Number(r.c),
        volume:Number(r.v)||0,
        tradeCount:r.n??null,
        vwap:r.vw??null,
        source:"context_poller"
      };
      if(![bar.open,bar.high,bar.low,bar.close].every(Number.isFinite)) continue;
      persist.push(bar);
      const history=this.modelLab?.contextHistories?.get(bar.symbol)||[];
      const idx=history.findIndex(x=>+new Date(x.ts)===+bar.ts);
      if(idx>=0) history[idx]=bar;
      else history.push(bar);
      history.sort((a,b)=>+new Date(a.ts)-+new Date(b.ts));
      if(history.length>3000) history.splice(0,history.length-3000);
      if(this.modelLab?.contextHistories) this.modelLab.contextHistories.set(bar.symbol,history);
    }
    if(persist.length){
      for(let i=0;i<persist.length;i+=700){
        await this.db.upsertBarsBatch(persist.slice(i,i+700));
      }
    }
    this.lastPollAt=new Date().toISOString();
    this.lastError=null;
    return persist.length;
  }
}

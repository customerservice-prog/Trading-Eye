import WebSocket from "ws";

const sleep = ms => new Promise(r=>setTimeout(r,ms));

export class AlpacaProvider {
  constructor({key,secret,feed="iex",symbols=[],onEvent=()=>{},onStatus=()=>{}}) {
    this.key=key;
    this.secret=secret;
    this.feed=feed;
    this.symbols=symbols;
    this.onEvent=onEvent;
    this.onStatus=onStatus;
    this.ws=null;
    this.stopped=false;
    this.connected=false;
    this.authenticated=false;
    this.lastEventAt=null;
    this.reconnects=0;
  }

  configured() { return Boolean(this.key && this.secret); }

  async start() {
    if (!this.configured()) {
      this.onStatus({state:"NOT_CONFIGURED",provider:"alpaca",feed:this.feed});
      return;
    }
    this.stopped=false;
    while (!this.stopped) {
      try {
        await this.#connectOnce();
      } catch (err) {
        this.onStatus({state:"ERROR",provider:"alpaca",feed:this.feed,error:String(err?.message||err)});
      }
      if (!this.stopped) {
        this.reconnects++;
        this.onStatus({state:"RECONNECTING",provider:"alpaca",feed:this.feed,reconnects:this.reconnects});
        await sleep(Math.min(30000,1000*Math.max(1,this.reconnects)));
      }
    }
  }

  stop() {
    this.stopped=true;
    try { this.ws?.close(); } catch {}
  }

  #connectOnce() {
    return new Promise((resolve,reject)=>{
      const url=`wss://stream.data.alpaca.markets/v2/${this.feed}`;
      const ws=new WebSocket(url,{headers:{"Content-Type":"application/json"}});
      this.ws=ws;
      let settled=false;
      let authTimer=setTimeout(()=>{
        if (!this.authenticated) {
          try { ws.terminate(); } catch {}
          reject(new Error("Alpaca authentication timeout"));
        }
      },10000);

      ws.on("open",()=>{
        this.connected=true;
        this.onStatus({state:"CONNECTED",provider:"alpaca",feed:this.feed});
      });

      ws.on("message",raw=>{
        let messages;
        try { messages=JSON.parse(raw.toString()); } catch { return; }
        if (!Array.isArray(messages)) messages=[messages];
        for (const msg of messages) {
          if (msg.T==="success" && msg.msg==="connected") {
            ws.send(JSON.stringify({action:"auth",key:this.key,secret:this.secret}));
            continue;
          }
          if (msg.T==="success" && msg.msg==="authenticated") {
            clearTimeout(authTimer);
            this.authenticated=true;
            this.reconnects=0;
            ws.send(JSON.stringify({
              action:"subscribe",
              trades:this.symbols,
              quotes:this.symbols,
              bars:this.symbols
            }));
            this.onStatus({state:"LIVE",provider:"alpaca",feed:this.feed,symbols:this.symbols});
            continue;
          }
          if (msg.T==="error") {
            this.onStatus({state:"ERROR",provider:"alpaca",feed:this.feed,error:msg.msg || "Alpaca stream error",code:msg.code});
            continue;
          }
          if (["t","q","b"].includes(msg.T)) {
            this.lastEventAt=new Date(msg.t || Date.now());
            this.onEvent(msg);
          }
        }
      });

      ws.on("error",err=>{
        if (!settled && !this.authenticated) {
          settled=true;
          clearTimeout(authTimer);
          reject(err);
        }
      });

      ws.on("close",(code,reason)=>{
        this.connected=false;
        this.authenticated=false;
        clearTimeout(authTimer);
        this.onStatus({state:"DISCONNECTED",provider:"alpaca",feed:this.feed,code,reason:reason?.toString()});
        if (!settled) { settled=true; resolve(); }
      });
    });
  }

  async historicalBars({start,end,limit=10000,onPage=()=>{}}) {
    if (!this.configured()) throw new Error("Alpaca is not configured");
    let token=null;
    do {
      const params=new URLSearchParams({
        symbols:this.symbols.join(","),
        timeframe:"1Min",
        start:new Date(start).toISOString(),
        end:new Date(end).toISOString(),
        limit:String(limit),
        adjustment:"raw",
        feed:this.feed
      });
      if (token) params.set("page_token",token);
      const res=await fetch("https://data.alpaca.markets/v2/stocks/bars?"+params,{
        headers:{
          "APCA-API-KEY-ID":this.key,
          "APCA-API-SECRET-KEY":this.secret,
          "accept":"application/json"
        }
      });
      if (!res.ok) {
        const body=await res.text();
        throw new Error(`Alpaca historical HTTP ${res.status}: ${body.slice(0,300)}`);
      }
      const data=await res.json();
      await onPage(data.bars || {});
      token=data.next_page_token || null;
    } while(token && !this.stopped);
  }
}

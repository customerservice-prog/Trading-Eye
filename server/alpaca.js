import WebSocket from "ws";

const sleep = ms => new Promise(r=>setTimeout(r,ms));

export class AlpacaProvider {
  constructor({key,secret,feed="auto",historicalFeed="iex",symbols=[],maxSymbols=28,onEvent=()=>{},onStatus=()=>{}}) {
    this.key=key;
    this.secret=secret;
    this.feedMode=feed;
    this.historicalFeed=historicalFeed;
    this.feed=this.#desiredFeed();
    this.maxSymbols=Math.max(5,Math.min(30,Number(maxSymbols)||28));
    this.symbols=[...new Set(symbols.map(s=>String(s).toUpperCase()))].slice(0,this.maxSymbols);
    this.subscribedSymbols=new Set();
    this.onEvent=onEvent;
    this.onStatus=onStatus;
    this.ws=null;
    this.stopped=false;
    this.connected=false;
    this.authenticated=false;
    this.lastEventAt=null;
    this.reconnects=0;
    this.switchTimer=null;
  }

  #desiredFeed() {
    if (this.feedMode!=="auto") return this.feedMode;
    const parts=Object.fromEntries(
      new Intl.DateTimeFormat("en-US",{
        timeZone:"America/New_York",
        weekday:"short",
        hour:"2-digit",
        minute:"2-digit",
        hourCycle:"h23"
      }).formatToParts(new Date()).filter(p=>p.type!=="literal").map(p=>[p.type,p.value])
    );
    const day={Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6}[parts.weekday];
    const minute=Number(parts.hour)*60+Number(parts.minute);
    const overnight=
      (day===0 && minute>=20*60) ||
      (day>=1 && day<=4 && (minute<4*60 || minute>=20*60)) ||
      (day===5 && minute<4*60);
    return overnight?"overnight":"iex";
  }

  #streamUrl(feed) {
    const version=["overnight","boats"].includes(feed)?"v1beta1":"v2";
    return `wss://stream.data.alpaca.markets/${version}/${feed}`;
  }

  configured() { return Boolean(this.key && this.secret); }

  async start() {
    if (!this.configured()) {
      this.onStatus({state:"NOT_CONFIGURED",provider:"alpaca",feed:this.feed});
      return;
    }
    this.stopped=false;
    clearInterval(this.switchTimer);
    this.switchTimer=setInterval(()=>{
      const desired=this.#desiredFeed();
      if (desired!==this.feed) {
        this.onStatus({state:"SWITCHING",provider:"alpaca",feed:this.feed,nextFeed:desired});
        this.feed=desired;
        try { this.ws?.close(1000,"session switch"); } catch {}
      }
    },30000);
    while (!this.stopped) {
      this.feed=this.#desiredFeed();
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
    clearInterval(this.switchTimer);
    this.switchTimer=null;
    try { this.ws?.close(); } catch {}
  }

  #connectOnce() {
    return new Promise((resolve,reject)=>{
      const url=this.#streamUrl(this.feed);
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
            this.subscribedSymbols=new Set(this.symbols);
            this.onStatus({state:"LIVE",provider:"alpaca",feed:this.feed,symbols:this.symbols});
            continue;
          }
          if (msg.T==="error") {
            const code=Number(msg.code);
            this.onStatus({state:"ERROR",provider:"alpaca",feed:this.feed,error:msg.msg || "Alpaca stream error",code});
            if (code===405 && this.symbols.length>5) {
              this.maxSymbols=Math.max(5,Math.min(this.maxSymbols-2,this.symbols.length-1));
              this.symbols=this.symbols.slice(0,this.maxSymbols);
              this.onStatus({
                state:"LIMIT_ADJUSTED",provider:"alpaca",feed:this.feed,code,
                maxSymbols:this.maxSymbols,symbols:this.symbols
              });
              try { ws.close(1000,"symbol limit retry"); } catch {}
            } else if ([402,404,406,409].includes(code)) {
              try { ws.close(1000,"retry"); } catch {}
            }
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

  setSymbols(symbols) {
    const next=[...new Set(symbols.map(s=>String(s).toUpperCase()).filter(Boolean))].slice(0,this.maxSymbols);
    const current=new Set(this.symbols);
    const add=next.filter(s=>!current.has(s));
    const remove=this.symbols.filter(s=>!next.includes(s));
    this.symbols=next;
    if (this.ws && this.authenticated && this.ws.readyState===1) {
      if (remove.length) {
        this.ws.send(JSON.stringify({action:"unsubscribe",trades:remove,quotes:remove,bars:remove}));
        remove.forEach(s=>this.subscribedSymbols.delete(s));
      }
      if (add.length) {
        this.ws.send(JSON.stringify({action:"subscribe",trades:add,quotes:add,bars:add}));
        add.forEach(s=>this.subscribedSymbols.add(s));
      }
      this.onStatus({state:"LIVE",provider:"alpaca",feed:this.feed,symbols:this.symbols});
    }
    return this.symbols;
  }

  async historicalBarsForSymbols({symbols,start,end,timeframe="1Min",limit=10000,onPage=()=>{}}) {
    if (!this.configured()) throw new Error("Alpaca is not configured");
    const requested=[...new Set((symbols||[]).map(s=>String(s).toUpperCase()).filter(Boolean))];
    if (!requested.length) return;
    let token=null;
    do {
      const params=new URLSearchParams({
        symbols:requested.join(","),
        timeframe,
        start:new Date(start).toISOString(),
        end:new Date(end).toISOString(),
        limit:String(limit),
        adjustment:"raw",
        feed:this.historicalFeed
      });
      if (token) params.set("page_token",token);
      let res=null;
      for (let attempt=0;attempt<8;attempt++) {
        res=await fetch("https://data.alpaca.markets/v2/stocks/bars?"+params,{
          headers:{
            "APCA-API-KEY-ID":this.key,
            "APCA-API-SECRET-KEY":this.secret,
            "accept":"application/json"
          }
        });
        if (res.ok) break;
        if (res.status===429 || res.status>=500) {
          const retryHeader=Number(res.headers.get("retry-after"));
          await sleep(Number.isFinite(retryHeader)&&retryHeader>0?retryHeader*1000:Math.min(10000,800*(attempt+1)));
          continue;
        }
        const body=await res.text();
        throw new Error(`Alpaca historical HTTP ${res.status}: ${body.slice(0,300)}`);
      }
      if (!res?.ok) throw new Error("Alpaca historical request exhausted retries");
      const data=await res.json();
      await onPage(data.bars || {});
      token=data.next_page_token || null;
      if (token) await sleep(325);
    } while(token && !this.stopped);
  }

  async historicalBars({start,end,limit=10000,onPage=()=>{}}) {
    if (!this.configured()) throw new Error("Alpaca is not configured");
    return this.historicalBarsForSymbols({
      symbols:this.symbols,start,end,timeframe:"1Min",limit,onPage
    });
  }
}

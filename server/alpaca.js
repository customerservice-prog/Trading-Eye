import WebSocket from "ws";

const sleep = ms => new Promise(r=>setTimeout(r,ms));

export class AlpacaProvider {
  constructor({
    key,secret,feed="auto",historicalFeed="sip",symbols=[],
    maxSymbols=28,overnightMaxSymbols=14,onEvent=()=>{},onStatus=()=>{}
  }) {
    this.key=key;
    this.secret=secret;
    this.feedMode=feed;
    this.historicalFeed=historicalFeed;
    this.feed=this.#desiredFeed();
    this.maxSymbols=Math.max(5,Math.min(30,Number(maxSymbols)||28));
    this.overnightMaxSymbols=Math.max(5,Math.min(this.maxSymbols,Number(overnightMaxSymbols)||14));
    this.requestedSymbols=[...new Set(symbols.map(s=>String(s).toUpperCase()))].slice(0,this.maxSymbols);
    this.symbols=this.requestedSymbols.slice(0,this.#effectiveLimit());
    this.focusSymbols=new Set(this.symbols.slice(0,1));
    this.subscribedQuotes=new Set();
    this.subscribedBars=new Set();
    this.subscribedTrades=new Set();
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

  #effectiveLimit() {
    return this.feed==="overnight"?this.overnightMaxSymbols:this.maxSymbols;
  }

  #applyFeedCapacity() {
    this.symbols=this.requestedSymbols.slice(0,this.#effectiveLimit());
    return this.symbols;
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
        this.#applyFeedCapacity();
        try { this.ws?.close(1000,"session switch"); } catch {}
      }
    },30000);
    while (!this.stopped) {
      this.feed=this.#desiredFeed();
      this.#applyFeedCapacity();
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
            const trades=[...this.focusSymbols].filter(s=>this.symbols.includes(s));
            ws.send(JSON.stringify({
              action:"subscribe",
              trades,
              quotes:this.symbols,
              bars:this.symbols
            }));
            this.subscribedQuotes=new Set(this.symbols);
            this.subscribedBars=new Set(this.symbols);
            this.subscribedTrades=new Set(trades);
            this.onStatus({
              state:"LIVE",provider:"alpaca",feed:this.feed,symbols:this.symbols,
              symbolLimit:this.#effectiveLimit(),requestedSymbols:this.requestedSymbols,
              tradeFocus:trades
            });
            continue;
          }
          if (msg.T==="error") {
            const code=Number(msg.code);
            this.onStatus({state:"ERROR",provider:"alpaca",feed:this.feed,error:msg.msg || "Alpaca stream error",code});
            if (code===405 && this.symbols.length>5) {
              if (this.feed==="overnight") {
                this.overnightMaxSymbols=Math.max(5,Math.min(this.overnightMaxSymbols-1,this.symbols.length-1));
              } else {
                this.maxSymbols=Math.max(5,Math.min(this.maxSymbols-1,this.symbols.length-1));
              }
              this.#applyFeedCapacity();
              this.onStatus({
                state:"LIMIT_ADJUSTED",provider:"alpaca",feed:this.feed,code,
                maxSymbols:this.maxSymbols,overnightMaxSymbols:this.overnightMaxSymbols,
                symbolLimit:this.#effectiveLimit(),symbols:this.symbols,
                requestedSymbols:this.requestedSymbols,tradeFocus:[...this.focusSymbols]
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
    this.requestedSymbols=[...new Set(symbols.map(s=>String(s).toUpperCase()).filter(Boolean))].slice(0,this.maxSymbols);
    const next=this.requestedSymbols.slice(0,this.#effectiveLimit());
    const current=new Set(this.symbols);
    const add=next.filter(s=>!current.has(s));
    const remove=this.symbols.filter(s=>!next.includes(s));
    this.symbols=next;

    for (const focus of [...this.focusSymbols]) {
      if (!this.symbols.includes(focus)) this.focusSymbols.delete(focus);
    }
    if (!this.focusSymbols.size && this.symbols.length) this.focusSymbols.add(this.symbols[0]);

    if (this.ws && this.authenticated && this.ws.readyState===1) {
      const removeTrades=remove.filter(s=>this.subscribedTrades.has(s));
      if (remove.length || removeTrades.length) {
        this.ws.send(JSON.stringify({
          action:"unsubscribe",
          trades:removeTrades,
          quotes:remove,
          bars:remove
        }));
        remove.forEach(s=>{
          this.subscribedQuotes.delete(s);
          this.subscribedBars.delete(s);
        });
        removeTrades.forEach(s=>this.subscribedTrades.delete(s));
      }
      if (add.length) {
        this.ws.send(JSON.stringify({action:"subscribe",trades:[],quotes:add,bars:add}));
        add.forEach(s=>{
          this.subscribedQuotes.add(s);
          this.subscribedBars.add(s);
        });
      }
      this.#syncTradeFocus();
      this.onStatus({
        state:"LIVE",provider:"alpaca",feed:this.feed,symbols:this.symbols,
        symbolLimit:this.#effectiveLimit(),requestedSymbols:this.requestedSymbols,
        tradeFocus:[...this.focusSymbols]
      });
    }
    return this.symbols;
  }

  #syncTradeFocus() {
    if (!this.ws || !this.authenticated || this.ws.readyState!==1) return;
    const desired=new Set([...this.focusSymbols].filter(s=>this.symbols.includes(s)));
    const remove=[...this.subscribedTrades].filter(s=>!desired.has(s));
    const add=[...desired].filter(s=>!this.subscribedTrades.has(s));
    if (remove.length) {
      this.ws.send(JSON.stringify({action:"unsubscribe",trades:remove,quotes:[],bars:[]}));
      remove.forEach(s=>this.subscribedTrades.delete(s));
    }
    if (add.length) {
      this.ws.send(JSON.stringify({action:"subscribe",trades:add,quotes:[],bars:[]}));
      add.forEach(s=>this.subscribedTrades.add(s));
    }
  }

  setFocusSymbols(symbols) {
    const desired=[...new Set((symbols||[]).map(s=>String(s).toUpperCase()).filter(s=>this.symbols.includes(s)))].slice(0,2);
    this.focusSymbols=new Set(desired.length?desired:this.symbols.slice(0,1));
    this.#syncTradeFocus();
    this.onStatus({
      state:this.authenticated?"LIVE":"FOCUS_UPDATED",
      provider:"alpaca",feed:this.feed,symbols:this.symbols,
      symbolLimit:this.#effectiveLimit(),requestedSymbols:this.requestedSymbols,
      tradeFocus:[...this.focusSymbols]
    });
    return [...this.focusSymbols];
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

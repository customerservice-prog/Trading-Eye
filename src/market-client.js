export class MarketClient {
  constructor() {
    this.listeners=new Set();
    this.ws=null;
    this.reconnectTimer=null;
    this.closed=false;
  }

  on(fn) { this.listeners.add(fn); return ()=>this.listeners.delete(fn); }
  emit(event) { for (const fn of this.listeners) fn(event); }

  async status() {
    const r=await fetch("/api/status",{cache:"no-store"});
    if (!r.ok) throw new Error("Status request failed: "+r.status);
    return r.json();
  }

  async snapshot(symbol) {
    const r=await fetch("/api/snapshot/"+encodeURIComponent(symbol),{cache:"no-store"});
    if (!r.ok) throw new Error("Snapshot request failed: "+r.status);
    return r.json();
  }

  async watchlist() {
    const r=await fetch("/api/watchlist",{cache:"no-store"});
    if (!r.ok) throw new Error("Watchlist request failed: "+r.status);
    return r.json();
  }

  async predictions(symbol=null) {
    const qs=symbol?"?symbol="+encodeURIComponent(symbol):"";
    const r=await fetch("/api/predictions"+qs,{cache:"no-store"});
    if (!r.ok) throw new Error("Predictions request failed: "+r.status);
    return r.json();
  }

  connect() {
    this.closed=false;
    const proto=location.protocol==="https:"?"wss":"ws";
    const ws=new WebSocket(`${proto}://${location.host}/ws`);
    this.ws=ws;
    ws.addEventListener("open",()=>this.emit({type:"socket",data:{state:"CONNECTED"}}));
    ws.addEventListener("message",e=>{
      try { this.emit(JSON.parse(e.data)); } catch {}
    });
    ws.addEventListener("close",()=>{
      this.emit({type:"socket",data:{state:"DISCONNECTED"}});
      if (!this.closed) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer=setTimeout(()=>this.connect(),2500);
      }
    });
    ws.addEventListener("error",()=>{});
  }

  close() {
    this.closed=true;
    clearTimeout(this.reconnectTimer);
    try { this.ws?.close(); } catch {}
  }
}

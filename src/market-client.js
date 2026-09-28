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

  async searchAssets(query,limit=25) {
    const r=await fetch("/api/assets/search?q="+encodeURIComponent(query)+"&limit="+encodeURIComponent(limit),{cache:"no-store"});
    if (!r.ok) throw new Error("Asset search failed: "+r.status);
    return r.json();
  }

  async activate(symbol) {
    const r=await fetch("/api/activate/"+encodeURIComponent(symbol),{
      method:"POST",
      headers:{"Content-Type":"application/json"}
    });
    const body=await r.json().catch(()=>({}));
    if (!r.ok) throw new Error(body.error||("Activation failed: "+r.status));
    return body;
  }

  async hotSet() {
    const r=await fetch("/api/hot-set",{cache:"no-store"});
    if (!r.ok) throw new Error("Hot set request failed: "+r.status);
    return r.json();
  }

  async predictions(symbol=null) {
    const qs=symbol?"?symbol="+encodeURIComponent(symbol):"";
    const r=await fetch("/api/predictions"+qs,{cache:"no-store"});
    if (!r.ok) throw new Error("Predictions request failed: "+r.status);
    return r.json();
  }

  async scanner(limit=50) {
    const r=await fetch("/api/scanner/latest?limit="+encodeURIComponent(limit),{cache:"no-store"});
    if (!r.ok) throw new Error("Scanner request failed: "+r.status);
    return r.json();
  }

  async studyStatus() {
    const r=await fetch("/api/studies/status",{cache:"no-store"});
    if (!r.ok) throw new Error("Study status request failed: "+r.status);
    return r.json();
  }

  async studies(limit=10) {
    const r=await fetch("/api/studies/latest?limit="+encodeURIComponent(limit),{cache:"no-store"});
    if (!r.ok) throw new Error("Studies request failed: "+r.status);
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

export class AssetUniverse {
  constructor({db,key,secret}) {
    this.db=db;
    this.key=key;
    this.secret=secret;
    this.lastSyncAt=null;
    this.syncState="WAITING";
    this.count=0;
    this.timer=null;
  }

  configured() { return Boolean(this.key && this.secret); }

  async init() {
    if (this.configured()) {
      await this.sync().catch(()=>{});
      this.timer=setInterval(()=>this.sync().catch(()=>{}),24*60*60*1000);
    }
  }

  stop() { clearInterval(this.timer); }

  async sync() {
    if (!this.configured()) return;
    this.syncState="RUNNING";
    const res=await fetch("https://paper-api.alpaca.markets/v2/assets?status=active&asset_class=us_equity",{
      headers:{
        "APCA-API-KEY-ID":this.key,
        "APCA-API-SECRET-KEY":this.secret,
        "accept":"application/json"
      }
    });
    if (!res.ok) {
      this.syncState="ERROR";
      throw new Error("Alpaca assets HTTP "+res.status);
    }
    const raw=await res.json();
    const assets=(Array.isArray(raw)?raw:[]).map(a=>({
      symbol:String(a.symbol||"").toUpperCase(),
      name:a.name||null,
      exchange:a.exchange||null,
      assetClass:a.class||"us_equity",
      status:a.status||"active",
      tradable:Boolean(a.tradable),
      fractionable:Boolean(a.fractionable),
      shortable:Boolean(a.shortable),
      easyToBorrow:Boolean(a.easy_to_borrow),
      marginable:Boolean(a.marginable),
      attributes:Array.isArray(a.attributes)?a.attributes:[],
      dataSupported:String(a.exchange||"").toUpperCase()!=="OTC"
    })).filter(a=>a.symbol);
    await this.db.upsertAssets(assets);
    this.count=assets.length;
    this.lastSyncAt=new Date().toISOString();
    this.syncState="COMPLETE";
    console.log(JSON.stringify({event:"asset_universe_synced",assets:this.count}));
  }

  async search(query,limit=25) {
    return this.db.searchAssets(query,{limit});
  }

  async get(symbol) {
    return this.db.findAsset(symbol);
  }

  async stats() {
    const stats=await this.db.assetStats();
    return {...stats,lastSyncAt:this.lastSyncAt,syncState:this.syncState};
  }
}

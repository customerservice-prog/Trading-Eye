import express from "express";
import http from "node:http";
import { WebSocketServer } from "ws";
import { Database } from "./db.js";
import { AlpacaProvider } from "./alpaca.js";
import { RealMarketEngine } from "./engine.js";
import { DeepStudyEngine } from "./deep-study.js";
import { AssetUniverse } from "./universe.js";

const PORT=Number(process.env.PORT || 8080);
const SYMBOLS=(process.env.TRADING_SYMBOLS || "SPY,QQQ,NVDA,AAPL,AMD,TSLA")
  .split(",").map(s=>s.trim().toUpperCase()).filter(Boolean);
const FEED=(process.env.ALPACA_FEED || "auto").trim().toLowerCase();
const HISTORICAL_FEED=(process.env.ALPACA_HISTORICAL_FEED || "sip").trim().toLowerCase();
const BACKFILL_DAYS=Math.max(1,Math.min(365,Number(process.env.BACKFILL_DAYS || 30)));
const LIVE_SYMBOL_LIMIT=Math.max(5,Math.min(30,Number(process.env.ALPACA_LIVE_SYMBOL_LIMIT || 28)));
const OVERNIGHT_LIVE_SYMBOL_LIMIT=Math.max(
  5,Math.min(LIVE_SYMBOL_LIMIT,Number(process.env.ALPACA_OVERNIGHT_SYMBOL_LIMIT || 14))
);
const ENGINE_ENABLED=String(process.env.TRADING_ENGINE_ENABLED ?? "true").toLowerCase() === "true";

const db=new Database(process.env.DATABASE_URL);
await db.init();

const universe=new AssetUniverse({
  db,
  key:process.env.ALPACA_API_KEY_ID,
  secret:process.env.ALPACA_API_SECRET_KEY
});
await universe.init();

const provider=new AlpacaProvider({
  key:process.env.ALPACA_API_KEY_ID,
  secret:process.env.ALPACA_API_SECRET_KEY,
  feed:FEED,
  historicalFeed:HISTORICAL_FEED,
  maxSymbols:LIVE_SYMBOL_LIMIT,
  overnightMaxSymbols:OVERNIGHT_LIVE_SYMBOL_LIMIT,
  symbols:SYMBOLS
});
const engine=new RealMarketEngine({db,provider,symbols:SYMBOLS,backfillDays:BACKFILL_DAYS,enabled:ENGINE_ENABLED});
await engine.init();

const deepStudy=new DeepStudyEngine({db,marketEngine:engine,symbols:SYMBOLS,model:engine.model});
await deepStudy.init();

const app=express();
app.disable("x-powered-by");
app.use(express.json({limit:"100kb"}));

app.get("/health",async(req,res)=>{
  const database=await db.ping();
  const s=engine.status();
  res.status(database?200:503).json({
    ok:database,
    database,
    providerConfigured:s.configured,
    providerState:s.provider.state,
    feed:s.provider.feed,
    feedMode:FEED,
    historicalFeed:HISTORICAL_FEED,
    mode:"REAL_DATA_ONLY",
    marketScope:"US_EQUITIES_ONLY",
    engineEnabled:s.engineEnabled,
    deepStudy:deepStudy.status(),
    lastEventAt:s.lastEventAt,
    lastBarAt:s.lastBarAt
  });
});

app.get("/api/status",async(req,res)=>{
  res.json({...engine.status(),database:await db.ping()});
});

app.get("/api/assets/stats",async(req,res)=>{
  res.json(await universe.stats());
});

app.get("/api/assets/search",async(req,res)=>{
  const q=String(req.query.q||"").trim();
  if (!q) return res.json({rows:[]});
  res.json({rows:await universe.search(q,Number(req.query.limit)||25)});
});

app.post("/api/activate/:symbol",async(req,res)=>{
  const symbol=String(req.params.symbol||"").trim().toUpperCase();
  const asset=await universe.get(symbol);
  if (!asset || asset.status!=="active" || asset.asset_class!=="us_equity") {
    return res.status(404).json({error:"Unknown or inactive U.S. equity"});
  }
  if (!asset.data_supported || String(asset.exchange||"").toUpperCase()==="OTC") {
    return res.status(400).json({error:"This U.S. symbol is not available on the current free Alpaca feed",asset});
  }
  try {
    const pin=String(req.query.pin||"false").toLowerCase()==="true";
    const hot=await engine.activateSymbol(symbol,{backfill:true,pin});
    res.json({ok:true,asset,...hot});
  } catch(err) {
    res.status(400).json({error:String(err?.message||err)});
  }
});

app.get("/api/hot-set",async(req,res)=>{
  const symbols=engine.hotSymbols();
  const assets=await Promise.all(symbols.map(s=>universe.get(s)));
  res.json({symbols,assets});
});

app.get("/api/snapshot/:symbol",async(req,res)=>{
  const symbol=req.params.symbol.toUpperCase();
  if (!engine.hotSymbols().includes(symbol)) return res.status(404).json({error:"Symbol is not active in the live hot set"});
  const snap=engine.snapshot(symbol);
  const predictions=await db.recentPredictions({symbol,limit:80});
  res.json({...snap,predictions});
});

app.get("/api/watchlist",async(req,res)=>{
  const hotSymbols=engine.hotSymbols();
  const latest=await db.getLatestBars(hotSymbols);
  const rows=await Promise.all(hotSymbols.map(async symbol=>{
    const snap=engine.snapshot(symbol);
    const bar=latest[symbol]||snap.bars.at(-1)||null;
    const asset=await universe.get(symbol);
    return {symbol,name:asset?.name||symbol,exchange:asset?.exchange||null,bar,quote:snap.quote,analysis:snap.analysis};
  }));
  const universeStats=await universe.stats();
  res.json({provider:"alpaca",feed:engine.status().provider.feed,feedMode:FEED,mode:"REAL_DATA_ONLY",rows,universe:universeStats});
});

app.get("/api/scanner/latest",async(req,res)=>{
  const latest=await db.latestUniverseScan();
  const scanDate=latest?.scan_date?String(latest.scan_date).slice(0,10):null;
  const candidates=scanDate?await db.topUniverseCandidates(scanDate,{limit:Number(req.query.limit)||50}):[];
  const universeStats=await universe.stats();
  res.json({
    universe:universeStats,
    scan:latest,
    candidates,
    hotSymbols:engine.hotSymbols(),
    pinnedSymbols:[...engine.pinnedSymbols]
  });
});

app.get("/api/studies/status",async(req,res)=>{
  res.json(deepStudy.status());
});

app.get("/api/studies/latest",async(req,res)=>{
  const limit=Math.max(1,Math.min(30,Number(req.query.limit)||10));
  const rows=await deepStudy.latest(limit);
  res.json({status:deepStudy.status(),rows});
});

app.get("/api/predictions",async(req,res)=>{
  const symbol=req.query.symbol?String(req.query.symbol).toUpperCase():null;
  const rows=await db.recentPredictions({symbol,limit:Number(req.query.limit)||200});
  const stats=await db.predictionStats();
  res.json({rows,stats,model:engine.model.snapshot(),provider:"alpaca",feed:engine.status().provider.feed,feedMode:FEED});
});

app.use(express.static(".",{
  extensions:["html"],
  setHeaders(res,path){
    if (path.endsWith(".html")||path.endsWith(".js")||path.endsWith(".css")) {
      res.setHeader("Cache-Control","no-store, max-age=0");
    } else {
      res.setHeader("Cache-Control","public, max-age=300");
    }
  }
}));

app.use((req,res)=>res.sendFile("index.html",{root:process.cwd()}));

const server=http.createServer(app);
const wss=new WebSocketServer({server,path:"/ws"});

function broadcast(obj) {
  const msg=JSON.stringify(obj);
  for (const client of wss.clients) if (client.readyState===1) client.send(msg);
}
engine.on("market",event=>broadcast(event));
engine.on("status",status=>broadcast({type:"status",data:status}));
deepStudy.on("status",status=>broadcast({type:"deep_study_status",data:status}));
deepStudy.on("study",study=>broadcast({type:"deep_study_complete",data:study}));

wss.on("connection",ws=>{
  ws.send(JSON.stringify({type:"status",data:engine.status()}));
  ws.on("error",()=>{});
});

server.listen(PORT,"0.0.0.0",()=>{
  console.log(JSON.stringify({
    event:"server_started",port:PORT,mode:"REAL_DATA_ONLY",
    provider:"alpaca",feed:provider.feed,feedMode:FEED,marketScope:"US_EQUITIES_ONLY",
    liveSymbolLimit:LIVE_SYMBOL_LIMIT,overnightLiveSymbolLimit:OVERNIGHT_LIVE_SYMBOL_LIMIT,
    symbols:SYMBOLS,providerConfigured:provider.configured(),engineEnabled:ENGINE_ENABLED
  }));
});

const shutdown=async()=>{
  provider.stop();
  universe.stop();
  deepStudy.stop();
  server.close(()=>process.exit(0));
  setTimeout(()=>process.exit(1),8000).unref();
};
process.on("SIGTERM",shutdown);
process.on("SIGINT",shutdown);

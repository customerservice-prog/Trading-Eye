import express from "express";
import http from "node:http";
import { WebSocketServer } from "ws";
import { Database } from "./db.js";
import { AlpacaProvider } from "./alpaca.js";
import { RealMarketEngine } from "./engine.js";

const PORT=Number(process.env.PORT || 8080);
const SYMBOLS=(process.env.TRADING_SYMBOLS || "SPY,QQQ,NVDA,AAPL,AMD,TSLA")
  .split(",").map(s=>s.trim().toUpperCase()).filter(Boolean);
const FEED=(process.env.ALPACA_FEED || "auto").trim().toLowerCase();
const HISTORICAL_FEED=(process.env.ALPACA_HISTORICAL_FEED || "iex").trim().toLowerCase();
const BACKFILL_DAYS=Math.max(1,Math.min(365,Number(process.env.BACKFILL_DAYS || 30)));
const ENGINE_ENABLED=String(process.env.TRADING_ENGINE_ENABLED ?? "true").toLowerCase() === "true";

const db=new Database(process.env.DATABASE_URL);
await db.init();

const provider=new AlpacaProvider({
  key:process.env.ALPACA_API_KEY_ID,
  secret:process.env.ALPACA_API_SECRET_KEY,
  feed:FEED,
  historicalFeed:HISTORICAL_FEED,
  symbols:SYMBOLS
});
const engine=new RealMarketEngine({db,provider,symbols:SYMBOLS,backfillDays:BACKFILL_DAYS,enabled:ENGINE_ENABLED});
await engine.init();

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
    engineEnabled:s.engineEnabled,
    lastEventAt:s.lastEventAt,
    lastBarAt:s.lastBarAt
  });
});

app.get("/api/status",async(req,res)=>{
  res.json({...engine.status(),database:await db.ping()});
});

app.get("/api/snapshot/:symbol",async(req,res)=>{
  const symbol=req.params.symbol.toUpperCase();
  if (!SYMBOLS.includes(symbol)) return res.status(404).json({error:"Symbol is not in the monitored universe"});
  const snap=engine.snapshot(symbol);
  const predictions=await db.recentPredictions({symbol,limit:80});
  res.json({...snap,predictions});
});

app.get("/api/watchlist",async(req,res)=>{
  const latest=await db.getLatestBars(SYMBOLS);
  const rows=SYMBOLS.map(symbol=>{
    const snap=engine.snapshot(symbol);
    const bar=latest[symbol]||snap.bars.at(-1)||null;
    return {symbol,bar,quote:snap.quote,analysis:snap.analysis};
  });
  res.json({provider:"alpaca",feed:engine.status().provider.feed,feedMode:FEED,mode:"REAL_DATA_ONLY",rows});
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
    if (path.endsWith(".html")) res.setHeader("Cache-Control","no-store");
    else res.setHeader("Cache-Control","public, max-age=300");
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

wss.on("connection",ws=>{
  ws.send(JSON.stringify({type:"status",data:engine.status()}));
  ws.on("error",()=>{});
});

server.listen(PORT,"0.0.0.0",()=>{
  console.log(JSON.stringify({
    event:"server_started",port:PORT,mode:"REAL_DATA_ONLY",
    provider:"alpaca",feed:provider.feed,feedMode:FEED,symbols:SYMBOLS,providerConfigured:provider.configured(),engineEnabled:ENGINE_ENABLED
  }));
});

const shutdown=async()=>{
  provider.stop();
  server.close(()=>process.exit(0));
  setTimeout(()=>process.exit(1),8000).unref();
};
process.on("SIGTERM",shutdown);
process.on("SIGINT",shutdown);

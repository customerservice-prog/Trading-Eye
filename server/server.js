import express from "express";
import http from "node:http";
import { WebSocketServer } from "ws";
import { Database } from "./db.js";
import { AlpacaProvider } from "./alpaca.js";
import { RealMarketEngine } from "./engine.js";
import { DeepStudyEngine } from "./deep-study.js";
import { AssetUniverse } from "./universe.js";
import { explainAttention } from "./regime.js";
import { fingerprintFromFeatures, patternProbabilities, blendProbabilities } from "./patterns.js";
import { ModelLab } from "./model-lab.js";
import { PaperBroker } from "./paper-broker.js";

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
const MODEL_LAB_ENABLED=String(process.env.MODEL_LAB_ENABLED ?? "true").toLowerCase() === "true";
const MODEL_LAB_FORCE_TRAIN_ON_START=String(process.env.MODEL_LAB_FORCE_TRAIN_ON_START ?? "false").toLowerCase() === "true";
const PAPER_AUTOPILOT_ENABLED=String(process.env.PAPER_AUTOPILOT_ENABLED ?? "true").toLowerCase() === "true";
const PAPER_FILL_BUFFER_BPS=Math.max(0,Math.min(20,Number(process.env.PAPER_FILL_BUFFER_BPS || 1.5)));
const PAPER_ACCOUNT_ID=String(process.env.PAPER_ACCOUNT_ID || "TE_PAPER_MAIN_V1");

const db=new Database(process.env.DATABASE_URL);
await db.init();
const coreSchema=await db.coreSchemaCheck();
console.log(JSON.stringify({event:"core_schema_check",...coreSchema}));

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

const modelLab=new ModelLab({
  db,marketEngine:engine,horizonMinutes:15,enabled:MODEL_LAB_ENABLED,
  forceTrainOnStart:MODEL_LAB_FORCE_TRAIN_ON_START
});
await modelLab.init();

const paperBroker=new PaperBroker({
  db,marketEngine:engine,
  accountId:PAPER_ACCOUNT_ID,
  startingCash:100000,
  fillBufferBps:PAPER_FILL_BUFFER_BPS,
  autopilotEnabled:PAPER_AUTOPILOT_ENABLED
});
await paperBroker.init();

engine.attachIntelligence({modelLab,paperBroker});

const deepStudy=new DeepStudyEngine({db,marketEngine:engine,symbols:SYMBOLS,model:engine.model});
await deepStudy.init();

const app=express();
app.disable("x-powered-by");
app.use(express.json({limit:"100kb"}));

app.get("/health",async(req,res)=>{
  const database=await db.ping();
  const s=engine.status();
  res.status(database?200:503).json({
    ok:database&&coreSchema.ok,
    database,
    coreSchema,
    providerConfigured:s.configured,
    providerState:s.provider.state,
    feed:s.provider.feed,
    feedMode:FEED,
    historicalFeed:HISTORICAL_FEED,
    mode:"REAL_DATA_ONLY",
    marketScope:"US_EQUITIES_ONLY",
    engineEnabled:s.engineEnabled,
    deepStudy:deepStudy.status(),
    modelLab:modelLab.status(),
    paperBroker:true,
    lastEventAt:s.lastEventAt,
    lastBarAt:s.lastBarAt
  });
});

app.get("/api/status",async(req,res)=>{
  res.json({
    ...engine.status(),
    database:await db.ping(),
    modelLab:modelLab.status()
  });
});

app.get("/api/model-lab",async(req,res)=>{
  res.json(modelLab.status());
});

app.get("/api/paper",async(req,res)=>{
  res.json(await paperBroker.snapshot());
});

app.post("/api/paper/autopilot",async(req,res)=>{
  const enabled=Boolean(req.body?.enabled);
  res.json(await paperBroker.setAutopilot(enabled));
});

app.post("/api/paper/order",async(req,res)=>{
  try{
    const symbol=String(req.body?.symbol||"").trim().toUpperCase();
    const side=String(req.body?.side||"").trim().toUpperCase();
    let qty=Number(req.body?.qty);
    if(!qty) qty=await paperBroker.suggestedQty(symbol,{positionPct:.05});
    const result=await paperBroker.submitMarketOrder({
      symbol,side,qty,
      source:String(req.body?.source||"MANUAL_PAPER"),
      modelId:req.body?.modelId||null
    });
    res.status(result.ok?200:400).json(result);
  }catch(err){
    res.status(400).json({ok:false,error:String(err?.message||err)});
  }
});

app.post("/api/paper/flatten/:symbol",async(req,res)=>{
  try{
    const result=await paperBroker.flatten(req.params.symbol,{source:"MANUAL_FLATTEN"});
    res.status(result.ok?200:400).json(result);
  }catch(err){
    res.status(400).json({ok:false,error:String(err?.message||err)});
  }
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

  let patternInsight=snap.patternInsight||null;
  if (!patternInsight && snap.features && snap.bars?.length) {
    const ts=snap.bars.at(-1)?.ts||Date.now();
    const fingerprint=fingerprintFromFeatures(snap.features,ts);
    if (fingerprint) {
      const row=await db.getPattern(symbol,fingerprint,15);
      const memory=patternProbabilities(row);
      if (memory) {
        const blended=snap.analysis?blendProbabilities(snap.analysis,memory):null;
        patternInsight={
          fingerprint,
          sampleCount:memory.sampleCount,
          upRate:memory.up,
          flatRate:memory.flat,
          downRate:memory.down,
          avgReturn:memory.avgReturn,
          avgAbsReturn:memory.avgAbsReturn,
          avgMfe:memory.avgMfe,
          avgMae:memory.avgMae,
          patternWeight:blended?.patternWeight||0
        };
      }
    }
  }

  res.json({...snap,patternInsight,predictions});
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
  const rawCandidates=scanDate?await db.topUniverseCandidates(scanDate,{limit:Number(req.query.limit)||50}):[];
  const regime=await db.latestMarketRegime();
  const candidates=rawCandidates.map(row=>({
    ...row,
    attention_score:Number(row.interesting_score||0)+Number(row.deep_score||0),
    attention_reasons:explainAttention(row,regime)
  }));
  const universeStats=await universe.stats();
  res.json({
    universe:universeStats,
    scan:latest,
    regime,
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

app.get("/api/pattern-lab/:symbol",async(req,res)=>{
  const symbol=String(req.params.symbol||"").trim().toUpperCase();
  if (!engine.hotSymbols().includes(symbol)) {
    return res.status(404).json({error:"Symbol is not active in the live hot set"});
  }
  const limit=Math.max(5,Math.min(100,Number(req.query.limit)||40));
  res.json(engine.patternLab(symbol,{limit}));
});

app.get("/api/predictions",async(req,res)=>{
  const symbol=req.query.symbol?String(req.query.symbol).toUpperCase():null;
  const rows=await db.recentPredictions({symbol,limit:Number(req.query.limit)||200});
  const stats=await db.predictionStats();
  res.json({
    rows,stats,
    legacyModel:engine.model.snapshot(),
    modelLab:modelLab.status(),
    provider:"alpaca",
    feed:engine.status().provider.feed,
    feedMode:FEED
  });
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
    symbols:SYMBOLS,providerConfigured:provider.configured(),engineEnabled:ENGINE_ENABLED,
    modelLabEnabled:MODEL_LAB_ENABLED,
    modelLabForceTrainOnStart:MODEL_LAB_FORCE_TRAIN_ON_START,
    paperAutopilotEnabled:PAPER_AUTOPILOT_ENABLED
  }));
});

const shutdown=async()=>{
  provider.stop();
  universe.stop();
  deepStudy.stop();
  modelLab.stop();
  paperBroker.stop();
  server.close(()=>process.exit(0));
  setTimeout(()=>process.exit(1),8000).unref();
};
process.on("SIGTERM",shutdown);
process.on("SIGINT",shutdown);

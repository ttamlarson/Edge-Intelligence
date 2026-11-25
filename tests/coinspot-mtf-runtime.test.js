import test from "node:test";
import assert from "node:assert/strict";
import { __test } from "../index.js";
import { createMtfPaperAccount, processMtfPaperAccount } from "../coinspot-mtf-paper.js";

function kvStore() {
 const values=new Map();
 return {values,binding:{get:async key=>values.get(key)??null,put:async(key,value)=>values.set(key,value)}};
}

test("CoinSpot MTF sync backfills one UTC day per run using read-only historical orders",async()=>{
 const kv=kvStore(),originalFetch=globalThis.fetch,calls=[];
 globalThis.fetch=async(url,options={})=>{
  const target=String(url),method=options.method||"GET",body=options.body?JSON.parse(options.body):null;
  calls.push({url:target,method,body});
  if(target.includes("/pubapi/v2/latest/")){
   return new Response(JSON.stringify({status:"ok",prices:{bid:100,ask:101,last:100.5}}),{status:200,headers:{"Content-Type":"application/json"}});
  }
  return new Response(JSON.stringify({status:"ok",buyorders:[],sellorders:[]}),{status:200,headers:{"Content-Type":"application/json"}});
 };
 try {
  const now="2026-11-25T06:00:00.000Z";
  const first=await __test.syncCoinSpotMtfHistory({EDGE_KV:kv.binding,COINSPOT_READONLY_KEY:"test-key",COINSPOT_READONLY_SECRET:"test-secret"},now);
  assert.equal(first.status,"BACKFILLING");
  assert.equal(first.processedDate,"2026-07-28");
  assert.equal(calls.filter(call=>call.url.endsWith("/status")).length,1);
  assert.equal(calls.filter(call=>call.url.endsWith("/orders/market/completed")).length,20);
  assert.equal(calls.filter(call=>call.url.includes("/pubapi/v2/orders/completed/")).length,2);
  const historyCalls=calls.filter(call=>call.url.endsWith("/orders/market/completed"));
  assert.ok(historyCalls.every(call=>call.method==="POST"&&call.body.markettype==="AUD"&&call.body.limit===500));
  const stored=JSON.parse(kv.values.get("coinspot-mtf-history-global-v1"));
  assert.equal(stored.liveTradingEnabled,false);
  assert.equal(stored.markets.BTC.dailyCandles.length,0);
  assert.equal(stored.nextDate,"2026-07-29");
 } finally { globalThis.fetch=originalFetch; }
});

test("CoinSpot MTF status keeps signals blocked during warm-up but still retrieves live AUD quotes",async()=>{
 const kv=kvStore(),originalFetch=globalThis.fetch;
 kv.values.set("coinspot-mtf-history-global-v1",JSON.stringify({
  mode:"COINSPOT_AUD_RESEARCH_ONLY",status:"BACKFILLING",nextDate:"2026-07-29",liveTradingEnabled:false,
  markets:{BTC:{dailyCandles:[],fourHourCandles:[],tradesFetched:0},ETH:{dailyCandles:[],fourHourCandles:[],tradesFetched:0}}
 }));
 globalThis.fetch=async()=>new Response(JSON.stringify({status:"ok",prices:{bid:100,ask:101,last:100.5}}),{status:200,headers:{"Content-Type":"application/json"}});
 try{
  const status=await __test.getCoinSpotMtfStrategy({EDGE_KV:kv.binding},"2026-11-25T08:00:00.000Z");
  assert.equal(status.markets.length,2);
  assert.equal(status.markets[0].signalStatus,"WARMUP_REQUIRED");
  assert.equal(status.markets[0].signal,null);
  assert.equal(status.markets[0].quote.bid,100);
  assert.equal(status.markets[0].quote.ask,101);
  assert.equal(status.liveTradingEnabled,false);
 }finally{globalThis.fetch=originalFetch;}
});

test("CoinSpot MTF paper runner advances history and creates a paper-only AUD ledger",async()=>{
 const kv=kvStore(),originalFetch=globalThis.fetch,calls=[];
 globalThis.fetch=async(url,options={})=>{
  const target=String(url),method=options.method||"GET",body=options.body?JSON.parse(options.body):null;
  calls.push({url:target,method,body});
  if(target.includes("/pubapi/v2/latest/")){
   return new Response(JSON.stringify({status:"ok",prices:{bid:100,ask:101,last:100.5}}),{status:200,headers:{"Content-Type":"application/json"}});
  }
  return new Response(JSON.stringify({status:"ok",buyorders:[],sellorders:[]}),{status:200,headers:{"Content-Type":"application/json"}});
 };
 try{
  const result=await __test.runCoinSpotMtfPaper({EDGE_KV:kv.binding,COINSPOT_READONLY_KEY:"test-key",COINSPOT_READONLY_SECRET:"test-secret",OPENAI_API_KEY:""}, "2026-11-25T08:00:00.000Z");
  assert.equal(calls.filter(call=>call.url.endsWith("/status")).length,1);
  assert.equal(calls.filter(call=>call.url.endsWith("/orders/market/completed")).length,20);
  assert.equal(calls.filter(call=>call.url.includes("/pubapi/v2/orders/completed/")).length,2);
  assert.equal(calls.filter(call=>call.url.includes("/pubapi/v2/latest/")).length,2);
  assert.equal(result.mode,"COINSPOT_MTF_AUTOMATED_PAPER");
  assert.equal(result.cashAud,100);
  assert.equal(result.liveTradingEnabled,false);
  assert.equal(result.paperOnly,true);
  assert.equal(result.markets.length,2);
  assert.equal(result.markets[0].signalStatus,"WARMUP_REQUIRED");
  const history=JSON.parse(kv.values.get("coinspot-mtf-history-global-v1"));
  assert.equal(history.lastProcessedDate,"2026-07-28");
  const account=JSON.parse(kv.values.get("coinspot-mtf-paper-global-v1"));
  assert.equal(account.liveTradingEnabled,false);
 }finally{globalThis.fetch=originalFetch;}
});

test("CoinSpot read-only transport retries once with a fresh signed nonce",async()=>{
 const originalFetch=globalThis.fetch,calls=[];
 globalThis.fetch=async(url,options)=>{
  const body=JSON.parse(options.body);
  calls.push({url:String(url),body,headers:options.headers});
  if(calls.length===1) throw new TypeError("simulated transient network reset");
  return new Response(JSON.stringify({status:"ok"}),{status:200,headers:{"Content-Type":"application/json"}});
 };
 try{
  const result=await __test.coinSpotReadOnly({COINSPOT_READONLY_KEY:"test-key",COINSPOT_READONLY_SECRET:"test-secret"},"/status");
  assert.equal(result.status,"ok");
  assert.equal(calls.length,2);
  assert.ok(calls[1].body.nonce>calls[0].body.nonce);
  assert.ok(calls.every(call=>call.url.endsWith("/api/v2/ro/status")));
 }finally{globalThis.fetch=originalFetch;}
});

test("CoinSpot timeout persists provider diagnostics but does not advance incomplete history",async()=>{
 const kv=kvStore(),originalFetch=globalThis.fetch;
 let calls=0;
 globalThis.fetch=async()=>{
  calls++;
  const error=new Error("simulated timeout");
  error.name="TimeoutError";
  throw error;
 };
 try{
  await assert.rejects(
   ()=>__test.syncCoinSpotMtfHistory({EDGE_KV:kv.binding,COINSPOT_READONLY_KEY:"test-key",COINSPOT_READONLY_SECRET:"test-secret"},"2026-11-25T06:00:00.000Z"),
   /COINSPOT_TIMEOUT/
  );
  assert.equal(calls,10);
  const history=JSON.parse(kv.values.get("coinspot-mtf-history-global-v1"));
  assert.equal(history.providerProbe.readOnlyStatus,"FAILED");
  assert.equal(history.nextDate,"2026-07-28");
  assert.equal(history.lastProcessedDate,undefined);
 }finally{globalThis.fetch=originalFetch;}
});

test("CoinSpot read-only adapter blocks every non-read-only endpoint",async()=>{
 const originalFetch=globalThis.fetch;
 let calls=0;
 globalThis.fetch=async()=>{calls++;throw new Error("must not be called");};
 try{
  await assert.rejects(
   ()=>__test.coinSpotReadOnly({COINSPOT_READONLY_KEY:"test-key",COINSPOT_READONLY_SECRET:"test-secret"},"/my/buy"),
   /only permits read-only/
  );
  assert.equal(calls,0);
 }finally{globalThis.fetch=originalFetch;}
});


test("existing paper positions remain stop-managed while historical candles are warming",async()=>{
 const kv=kvStore(),originalFetch=globalThis.fetch;
 const now="2026-11-25T08:00:00.000Z";
 const opened=processMtfPaperAccount(createMtfPaperAccount(now),{markets:[{
  coin:"BTC",quote:{bid:99900,ask:100000,last:100000},
  signal:{status:"BUY_CANDIDATE_PAPER_ONLY",signalAt:"2026-11-25T04:00:00.000Z",
   indicators:{breakoutVotes:3,atr20:1000},risk:{initialStopDistance:2500},
   checks:{dailyTrend:true,fourHourTrend:true}}
 }],now});
 assert.ok(opened.openPosition);
 const stop=opened.openPosition.stopPrice;
 kv.values.set("coinspot-mtf-history-global-v1",JSON.stringify({
  mode:"COINSPOT_AUD_RESEARCH_ONLY",status:"BACKFILLING",nextDate:"2026-07-29",liveTradingEnabled:false,
  markets:{BTC:{dailyCandles:[],fourHourCandles:[],tradesFetched:0},ETH:{dailyCandles:[],fourHourCandles:[],tradesFetched:0}}
 }));
 kv.values.set("coinspot-mtf-paper-global-v1",JSON.stringify(opened));
 globalThis.fetch=async()=>new Response(JSON.stringify({status:"ok",prices:{bid:stop*0.95,ask:stop*0.951,last:stop*0.95}}),{status:200,headers:{"Content-Type":"application/json"}});
 try{
  const result=await __test.runCoinSpotMtfPaper({EDGE_KV:kv.binding},"2026-11-25T09:00:00.000Z");
  assert.equal(result.openPosition,null);
  assert.equal(result.closedTrades.at(-1).reason,"TRAILING_STOP");
  const btc=result.markets.find(m=>m.coin==="BTC");
  assert.equal(btc.signalStatus,"WARMUP_REQUIRED");
  assert.ok(btc.bid<stop);
  assert.equal(result.liveTradingEnabled,false);
  assert.equal(result.paperOnly,true);
 }finally{globalThis.fetch=originalFetch;}
});


test("CoinSpot refuses to advance a historical date when non-empty rows fail trade validation",async()=>{
 const kv=kvStore(),originalFetch=globalThis.fetch;
 globalThis.fetch=async(url,options={})=>{
  const target=String(url);
  if(target.endsWith("/status")) return new Response(JSON.stringify({status:"ok"}),{status:200});
  if(target.endsWith("/orders/market/completed")){
   const body=JSON.parse(options.body||"{}");
   const coin=body.cointype;
   const invalid={market:coin+"/AUD",solddate:"2026-07-28T10:00:00.000Z",rate:"not-a-price",amount:1,total:100};
   return new Response(JSON.stringify({status:"ok",buyorders:[invalid],sellorders:[]}),{status:200});
  }
  if(target.includes("/pubapi/v2/orders/completed/")) return new Response(JSON.stringify({status:"ok",buyorders:[],sellorders:[]}),{status:200});
  throw new Error("Unexpected CoinSpot URL: "+target);
 };
 try{
  await assert.rejects(
   ()=>__test.syncCoinSpotMtfHistory({EDGE_KV:kv.binding,COINSPOT_READONLY_KEY:"test-key",COINSPOT_READONLY_SECRET:"test-secret"},"2026-11-25T06:00:00.000Z"),
   /COINSPOT_HISTORY_SCHEMA_MISMATCH/
  );
  const history=JSON.parse(kv.values.get("coinspot-mtf-history-global-v1"));
  assert.equal(history.nextDate,"2026-07-28");
  assert.equal(history.lastProcessedDate,undefined);
  assert.equal(history.liveTradingEnabled,false);
 }finally{globalThis.fetch=originalFetch;}
});


test("CoinSpot refuses to advance a saturated day when epoch sub-day partitions return no history",async()=>{
 const kv=kvStore(),originalFetch=globalThis.fetch;
 globalThis.fetch=async(url,options={})=>{
  const target=String(url);
  if(target.endsWith("/status")) return new Response(JSON.stringify({status:"ok"}),{status:200});
  if(target.endsWith("/orders/market/completed")){
   const body=JSON.parse(options.body||"{}"),coin=body.cointype;
   if(typeof body.startdate==="string" && /^\d{4}-\d{2}-\d{2}$/.test(body.startdate)){
    const make=offset=>Array.from({length:500},(_,i)=>({
     market:coin+"/AUD",
     solddate:new Date(Date.parse("2026-07-28T00:00:00.000Z")+(offset+i)*1000).toISOString(),
     rate:coin==="BTC"?90000:2500,amount:0.01,total:coin==="BTC"?900:25
    }));
    return new Response(JSON.stringify({status:"ok",buyorders:make(0),sellorders:make(500)}),{status:200});
   }
   return new Response(JSON.stringify({status:"ok",buyorders:[],sellorders:[]}),{status:200});
  }
  if(target.includes("/pubapi/v2/orders/completed/")) return new Response(JSON.stringify({status:"ok",buyorders:[],sellorders:[]}),{status:200});
  throw new Error("Unexpected CoinSpot URL: "+target);
 };
 try{
  await assert.rejects(
   ()=>__test.syncCoinSpotMtfHistory({EDGE_KV:kv.binding,COINSPOT_READONLY_KEY:"test-key",COINSPOT_READONLY_SECRET:"test-secret"},"2026-11-25T06:00:00.000Z"),
   /COINSPOT_HISTORY_PARTITION_EMPTY/
  );
  const history=JSON.parse(kv.values.get("coinspot-mtf-history-global-v1"));
  assert.equal(history.nextDate,"2026-07-28");
  assert.equal(history.lastProcessedDate,undefined);
  assert.equal(history.liveTradingEnabled,false);
  assert.equal(history.providerProbe.markets[0].readOnlyHistory.partitionHistory.length,2);
  assert.equal(history.providerProbe.markets[0].readOnlyHistory.partitionHistory[0].validAudTrades,0);
  assert.equal(history.providerProbe.markets[0].readOnlyHistory.partitionHistory[1].validAudTrades,0);
  assert.equal(history.providerProbe.markets[0].readOnlyHistory.outOfRangeTrades,1000);
 }finally{globalThis.fetch=originalFetch;}
});


test("CoinSpot sub-day probe detects a provider that returns out-of-window trades",async()=>{
 const originalFetch=globalThis.fetch;
 globalThis.fetch=async(url,options={})=>{
  const target=String(url);
  if(!target.endsWith("/orders/market/completed")) throw new Error("Unexpected URL: "+target);
  const body=JSON.parse(options.body||"{}"),coin=body.cointype;
  const row={market:coin+"/AUD",solddate:"2026-11-25T10:00:00.000Z",rate:90000,amount:0.01,total:900};
  return new Response(JSON.stringify({status:"ok",buyorders:[row],sellorders:[]}),{status:200});
 };
 try{
  const probe=await __test.probeCoinSpotHistory({COINSPOT_READONLY_KEY:"test-key",COINSPOT_READONLY_SECRET:"test-secret"},"BTC","2026-11-25T12:00:00.000Z");
  assert.equal(probe.partitionHistory.length,2);
  assert.equal(probe.partitionHistory[0].validAudTrades,1);
  assert.equal(probe.partitionHistory[1].validAudTrades,0);
  assert.equal(probe.partitionHistory[1].outOfRangeTrades,1);
  assert.deepEqual(probe.partitionHistory[0].variants.map(variant=>variant.format),["epoch","epoch-string","epoch-ms"]);
  assert.deepEqual(probe.partitionHistory[1].variants.map(variant=>variant.format),["epoch","epoch-string","epoch-ms"]);
 }finally{globalThis.fetch=originalFetch;}
});


test("CoinSpot sync rewinds legacy dates whose prior batches had raw rows but zero accepted trades",async()=>{
 const kv=kvStore(),originalFetch=globalThis.fetch;
 kv.values.set("coinspot-mtf-history-global-v1",JSON.stringify({
  mode:"COINSPOT_AUD_RESEARCH_ONLY",status:"BACKFILLING",
  nextDate:"2026-08-21",lastProcessedDate:"2026-08-20",
  markets:{BTC:{dailyCandles:[],fourHourCandles:[],tradesFetched:0},ETH:{dailyCandles:[],fourHourCandles:[],tradesFetched:0}},
  lastBatch:[
   {coin:"BTC",tradeCount:0,rawBuyOrders:500,rawSellOrders:500,apiCalls:3},
   {coin:"ETH",tradeCount:0,rawBuyOrders:357,rawSellOrders:357,apiCalls:3}
  ],
  liveTradingEnabled:false
 }));
 globalThis.fetch=async(url)=>{
  const target=String(url);
  if(target.endsWith("/status")) return new Response(JSON.stringify({status:"ok"}),{status:200});
  if(target.endsWith("/orders/market/completed")) return new Response(JSON.stringify({status:"ok",buyorders:[],sellorders:[]}),{status:200});
  if(target.includes("/pubapi/v2/orders/completed/")) return new Response(JSON.stringify({status:"ok",buyorders:[],sellorders:[]}),{status:200});
  throw new Error("Unexpected CoinSpot URL: "+target);
 };
 try{
  const result=await __test.syncCoinSpotMtfHistory({EDGE_KV:kv.binding,COINSPOT_READONLY_KEY:"test-key",COINSPOT_READONLY_SECRET:"test-secret"},"2026-11-25T12:00:00.000Z");
  assert.equal(result.processedDate,"2026-08-19");
  const saved=JSON.parse(kv.values.get("coinspot-mtf-history-global-v1"));
  assert.equal(saved.historyIntegrityRewindFrom,"2026-08-20");
  assert.equal(saved.lastProcessedDate,"2026-08-19");
  assert.equal(saved.lastBatchDate,"2026-08-19");
  assert.equal(saved.nextDate,"2026-08-20");
  assert.equal(saved.liveTradingEnabled,false);
 }finally{globalThis.fetch=originalFetch;}
});


test("CoinSpot MTF cron slots are isolated from other scheduled provider workloads",()=>{
 const env={EDGE_KV:{},COINSPOT_READONLY_KEY:"read-only",COINSPOT_READONLY_SECRET:"read-only-secret"};
 const at=minute=>({scheduledTime:Date.parse("2026-11-25T09:"+String(minute).padStart(2,"0")+":00.000Z")});
 assert.equal(__test.isCoinSpotMtfScheduleSlot(at(0),env),false);
 assert.equal(__test.isCoinSpotMtfScheduleSlot(at(15),env),true);
 assert.equal(__test.isCoinSpotMtfScheduleSlot(at(30),env),true);
 assert.equal(__test.isCoinSpotMtfScheduleSlot(at(45),env),true);
 assert.equal(__test.isCoinSpotMtfScheduleSlot(at(15),{EDGE_KV:{},COINSPOT_READONLY_KEY:"",COINSPOT_READONLY_SECRET:""}),false);
});


test("CoinSpot backfill uses a validated string-epoch partition when numeric epoch returns empty",async()=>{
 const kv=kvStore(),originalFetch=globalThis.fetch;
 kv.values.set("coinspot-mtf-history-global-v1",JSON.stringify({
  mode:"COINSPOT_AUD_RESEARCH_ONLY",status:"BACKFILLING",
  nextDate:"2026-08-19",lastProcessedDate:"2026-08-18",
  markets:{BTC:{dailyCandles:[],fourHourCandles:[],tradesFetched:0},ETH:{dailyCandles:[],fourHourCandles:[],tradesFetched:0}},
  liveTradingEnabled:false
 }));
 globalThis.fetch=async(url,options={})=>{
  const target=String(url);
  if(target.endsWith("/status")) return new Response(JSON.stringify({status:"ok"}),{status:200});
  if(target.endsWith("/orders/market/completed")){
   const body=JSON.parse(options.body||"{}"),coin=body.cointype;
   const makeRow=timestamp=>({market:coin+"/AUD",solddate:new Date(timestamp).toISOString(),rate:coin==="BTC"?90000:2500,amount:0.01,total:coin==="BTC"?900:25});
   if(body.startdate==="2026-11-25"){
    return new Response(JSON.stringify({status:"ok",buyorders:[makeRow(Date.parse("2026-11-25T09:00:00Z"))],sellorders:[]}),{status:200});
   }
   if(body.startdate==="2026-08-19"){
    const make=offset=>Array.from({length:500},(_,i)=>makeRow(Date.parse("2026-08-19T00:00:00Z")+(offset+i)*1000));
    return new Response(JSON.stringify({status:"ok",buyorders:make(0),sellorders:make(500)}),{status:200});
   }
   if(typeof body.startdate==="string" && /^\d+$/.test(body.startdate)){
    const start=Number(body.startdate)*1000;
    return new Response(JSON.stringify({status:"ok",buyorders:[makeRow(start+5*60*1000)],sellorders:[]}),{status:200});
   }
   return new Response(JSON.stringify({status:"ok",buyorders:[],sellorders:[]}),{status:200});
  }
  if(target.includes("/pubapi/v2/orders/completed/")) return new Response(JSON.stringify({status:"ok",buyorders:[],sellorders:[]}),{status:200});
  throw new Error("Unexpected CoinSpot URL: "+target);
 };
 try{
  const result=await __test.syncCoinSpotMtfHistory({EDGE_KV:kv.binding,COINSPOT_READONLY_KEY:"test-key",COINSPOT_READONLY_SECRET:"test-secret"},"2026-11-25T12:00:00.000Z");
  assert.equal(result.processedDate,"2026-08-19");
  assert.equal(result.markets[0].tradeCount,2);
  assert.equal(result.markets[1].tradeCount,2);
  const saved=JSON.parse(kv.values.get("coinspot-mtf-history-global-v1"));
  assert.equal(saved.markets.BTC.dailyCandles.length,1);
  assert.equal(saved.markets.BTC.fourHourCandles.length,2);
  assert.equal(saved.markets.ETH.dailyCandles.length,1);
  assert.equal(saved.markets.ETH.fourHourCandles.length,2);
  assert.equal(saved.lastProcessedDate,"2026-08-19");
  assert.equal(saved.nextDate,"2026-08-20");
  assert.equal(saved.liveTradingEnabled,false);
 }finally{globalThis.fetch=originalFetch;}
});

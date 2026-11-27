import test from "node:test";
import assert from "node:assert/strict";
import worker, { __test } from "../index.js";
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
  assert.equal(status.markets[0].quote.retrievedAt,"2026-11-25T08:00:00.000Z");
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
  const result=await __test.runCoinSpotMtfPaper({EDGE_KV:kv.binding,COINSPOT_READONLY_KEY:"test-key",COINSPOT_READONLY_SECRET:"test-secret",OPENAI_API_KEY:""}, "2026-11-25T08:00:00.000Z", 1);
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
   assert.equal(result.markets[0].quoteRetrievedAt,"2026-11-25T08:00:00.000Z");
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
  coin:"BTC",pair:"BTC/AUD",quote:{pair:"BTC/AUD",bid:99900,ask:100000,last:100000,spreadBps:10,retrievedAt:now},
  signal:{strategy:"EDGE_MTF_DONCHIAN_ENSEMBLE_V1",status:"BUY_CANDIDATE_PAPER_ONLY",signalAt:"2026-11-25T04:00:00.000Z",
   indicators:{breakoutVotes:3,atr20:1000},risk:{initialStopDistance:2500},
   checks:{dailyTrend:true,fourHourTrend:true,positiveLongTrendSlope:true,breakoutVotes:true,pullbackReclaim:false,entryTrigger:true,liquidity:true,volatility:true},
   execution:{orderIntent:"NONE",paperOnly:true,liveTradingEnabled:false}}
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
 const epochMsRequests=[];
 globalThis.fetch=async(url,options={})=>{
  const target=String(url);
  if(target.endsWith("/status")) return new Response(JSON.stringify({status:"ok"}),{status:200});
  if(target.endsWith("/orders/market/completed")){
   const body=JSON.parse(options.body||"{}"),coin=body.cointype;
   if(typeof body.startdate==="number"&&body.startdate>1e12) epochMsRequests.push(body.startdate);
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
   /COINSPOT_SUBDAY_EPOCH_MS_UNVERIFIED/
  );
  const history=JSON.parse(kv.values.get("coinspot-mtf-history-global-v1"));
  assert.equal(history.nextDate,"2026-07-28");
  assert.equal(history.lastProcessedDate,undefined);
  assert.equal(history.liveTradingEnabled,false);
  assert.equal(history.providerProbe.markets[0].readOnlyHistory.partitionHistory.length,2);
  assert.equal(epochMsRequests.length,4,"only provider-probe epoch-ms requests should run; unvalidated backfill partitions must not be queried");
  assert.ok(history.pendingHistorySync);
  assert.equal(history.pendingHistorySync.coins.BTC.windows.length,2);
  assert.equal(history.markets.BTC?.dailyCandles?.length ?? 0,0);
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
  assert.equal(result.processedDate,"2026-07-28");
  const saved=JSON.parse(kv.values.get("coinspot-mtf-history-global-v1"));
  assert.equal(saved.historyIntegrityRewindFrom,"2026-08-20");
  assert.equal(saved.historyIntegrityFullRewindFrom,"2026-07-28");
  assert.ok(saved.historyIntegrityFullRewindAt);
  assert.equal(saved.lastProcessedDate,"2026-07-28");
  assert.equal(saved.lastBatchDate,"2026-07-28");
  assert.equal(saved.nextDate,"2026-07-29");
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


test("CoinSpot backfill uses validated millisecond-epoch partitions when seconds return empty",async()=>{
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
   if(typeof body.startdate==="number" && body.startdate > 1e12){
    const start=Number(body.startdate);
    const probeDayStart=Date.parse("2026-11-25T00:00:00.000Z");
    const rows=start===probeDayStart?[makeRow(Date.parse("2026-11-25T09:00:00.000Z"))]
      :start===probeDayStart+12*60*60*1000?[]:[makeRow(start+5*60*1000)];
    return new Response(JSON.stringify({status:"ok",buyorders:rows,sellorders:[]}),{status:200});
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
  assert.ok(result.markets[0].queryFormatsAttempted.includes("epoch-ms"));
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


test("CoinSpot legacy integrity marker rebuilds the entire original 120-day window once",async()=>{
 const kv=kvStore(),originalFetch=globalThis.fetch;
 const variants=[{format:"epoch"},{format:"epoch-string"},{format:"epoch-ms"}];
 const probeMarket=coin=>({coin,pair:coin+"/AUD",readOnlyHistory:{partitionHistory:[
  {startAt:"2026-11-25T00:00:00.000Z",endAt:"2026-11-25T12:00:00.000Z",variants},
  {startAt:"2026-11-25T12:00:00.000Z",endAt:"2026-11-26T00:00:00.000Z",variants}
 ]}});
 kv.values.set("coinspot-mtf-history-global-v1",JSON.stringify({
  mode:"COINSPOT_AUD_RESEARCH_ONLY",status:"BACKFILLING",
  nextDate:"2026-08-20",lastProcessedDate:"2026-08-19",lastBatchDate:"2026-08-19",
  historyIntegrityRewindFrom:"2026-08-20",historyIntegrityRewindAt:"2026-11-25T10:00:00.000Z",
  lastProviderProbeAt:"2026-11-25T10:15:00.000Z",
  providerProbe:{markets:[probeMarket("BTC"),probeMarket("ETH")]},
  markets:{
   BTC:{dailyCandles:[{timestamp:1}],fourHourCandles:[{timestamp:1}],tradesFetched:1642,lastHistoryDate:"2026-08-19"},
   ETH:{dailyCandles:[{timestamp:1},{timestamp:2},{timestamp:3}],fourHourCandles:Array.from({length:18},(_,i)=>({timestamp:i})),tradesFetched:898,lastHistoryDate:"2026-08-19"}
  },
  lastBatch:[{coin:"BTC",tradeCount:1642,rawBuyOrders:2769,rawSellOrders:2769},{coin:"ETH",tradeCount:602,rawBuyOrders:844,rawSellOrders:844}],
  liveTradingEnabled:false
 }));
 globalThis.fetch=async(url)=>{
  const target=String(url);
  if(target.endsWith("/orders/market/completed")) return new Response(JSON.stringify({status:"ok",buyorders:[],sellorders:[]}),{status:200});
  throw new Error("Unexpected CoinSpot URL: "+target);
 };
 try{
  const result=await __test.syncCoinSpotMtfHistory({EDGE_KV:kv.binding,COINSPOT_READONLY_KEY:"test-key",COINSPOT_READONLY_SECRET:"test-secret"},"2026-11-25T10:45:00.000Z");
  assert.equal(result.processedDate,"2026-07-28");
  const saved=JSON.parse(kv.values.get("coinspot-mtf-history-global-v1"));
  assert.equal(saved.historyIntegrityFullRewindFrom,"2026-07-28");
  assert.ok(saved.historyIntegrityFullRewindAt);
  assert.equal(saved.lastProcessedDate,"2026-07-28");
  assert.equal(saved.nextDate,"2026-07-29");
  assert.equal(saved.markets.BTC.dailyCandles.length,0);
  assert.equal(saved.markets.BTC.fourHourCandles.length,0);
  assert.equal(saved.markets.BTC.tradesFetched,0);
  assert.equal(saved.markets.ETH.dailyCandles.length,0);
  assert.equal(saved.markets.ETH.fourHourCandles.length,0);
  assert.equal(saved.markets.ETH.tradesFetched,0);
  assert.equal(saved.liveTradingEnabled,false);
 }finally{globalThis.fetch=originalFetch;}
});

test("CoinSpot MTF scheduled failures remain visible to Cloudflare Cron Events", async () => {
 const env = {
  EDGE_KV: { get: async () => { throw new Error("paper ledger storage unavailable"); } },
  COINSPOT_READONLY_KEY: "test-readonly-key",
  COINSPOT_READONLY_SECRET: "test-readonly-secret"
 };
 let pending;
 const ctx = { waitUntil: promise => { pending = promise; } };
 await worker.scheduled({ scheduledTime: Date.parse("2026-11-25T09:15:00.000Z") }, env, ctx);
 assert.ok(pending instanceof Promise);
 await assert.rejects(pending, /paper ledger storage unavailable/);
});


test("CoinSpot MTF readiness counts only completed candles and exposes stored partial bars", async () => {
 const kv=kvStore(),originalFetch=globalThis.fetch;
 const now="2026-11-25T12:00:00.000Z";
 const day=24*60*60*1000,fourHours=4*60*60*1000;
 const daily=Array.from({length:110},(_,i)=>({
  timestamp:new Date(Date.parse("2026-08-08T00:00:00.000Z")+i*day).toISOString(),
  open:100,high:101,low:99,close:100,volume:1
 }));
 const fourHourBars=Array.from({length:210},(_,i)=>({
  timestamp:new Date(Date.parse("2026-10-21T16:00:00.000Z")+i*fourHours).toISOString(),
  open:100,high:101,low:99,close:100,volume:1
 }));
 kv.values.set("coinspot-mtf-history-global-v1",JSON.stringify({
  mode:"COINSPOT_AUD_RESEARCH_ONLY",status:"BACKFILLING",nextDate:"2026-11-25",liveTradingEnabled:false,
  markets:{
   BTC:{dailyCandles:daily,fourHourCandles:fourHourBars,tradesFetched:123,lastHistoryDate:"2026-11-25"},
   ETH:{dailyCandles:[],fourHourCandles:[],tradesFetched:0}
  }
 }));
 globalThis.fetch=async()=>new Response(JSON.stringify({status:"ok",prices:{bid:100,ask:100.1,last:100.05}}),{status:200,headers:{"Content-Type":"application/json"}});
 try{
  const result=await __test.getCoinSpotMtfStrategy({EDGE_KV:kv.binding},now);
  const btc=result.markets.find(m=>m.coin==="BTC");
  assert.equal(btc.signalStatus,"WARMUP_REQUIRED");
  assert.equal(btc.history.dailyCandles,109);
  assert.equal(btc.history.fourHourCandles,209);
  assert.equal(btc.history.storedDailyCandles,110);
  assert.equal(btc.history.storedFourHourCandles,210);
  assert.equal(btc.history.lastCompletedDailyAt,"2026-11-24T00:00:00.000Z");
  assert.equal(btc.history.lastCompletedFourHourAt,"2026-11-25T08:00:00.000Z");
 }finally{globalThis.fetch=originalFetch;}
});

test("CoinSpot MTF scheduled success emits a structured paper-only runtime summary", async () => {
 const kv=kvStore(),originalFetch=globalThis.fetch,originalLog=console.log;
 const variants=[{format:"epoch"},{format:"epoch-string"},{format:"epoch-ms"}];
 const probeMarket=coin=>({coin,pair:coin+"/AUD",readOnlyHistory:{partitionHistory:[
  {variants},{variants}
 ]}});
 kv.values.set("coinspot-mtf-history-global-v1",JSON.stringify({
  mode:"COINSPOT_AUD_RESEARCH_ONLY",status:"BACKFILLING",nextDate:"2026-11-20",
  markets:{
   BTC:{dailyCandles:[],fourHourCandles:[],tradesFetched:0},
   ETH:{dailyCandles:[],fourHourCandles:[],tradesFetched:0}
  },
  providerProbe:{markets:[probeMarket("BTC"),probeMarket("ETH")]},
  lastProviderProbeAt:new Date().toISOString(),
  liveTradingEnabled:false
 }));
 globalThis.fetch=async(url,options={})=>{
  const target=String(url);
  if(target.includes("/pubapi/v2/latest/")){
   return new Response(JSON.stringify({status:"ok",prices:{bid:100,ask:100.1,last:100.05}}),{status:200,headers:{"Content-Type":"application/json"}});
  }
  return new Response(JSON.stringify({status:"ok",buyorders:[],sellorders:[]}),{status:200,headers:{"Content-Type":"application/json"}});
 };
 const messages=[];
 console.log=(...args)=>messages.push(args.join(" "));
 let pending;
 try{
  await worker.scheduled({scheduledTime:Date.parse("2026-11-25T09:15:00.000Z")},{
   EDGE_KV:kv.binding,COINSPOT_READONLY_KEY:"test-readonly-key",COINSPOT_READONLY_SECRET:"test-readonly-secret"
  },{waitUntil:promise=>{pending=promise;}});
  assert.ok(pending instanceof Promise);
  await pending;
  const line=messages.find(message=>message.includes('"event":"COINSPOT_MTF_SCAN"'));
  assert.ok(line);
  const summary=JSON.parse(line);
  assert.equal(summary.paperOnly,true);
  assert.equal(summary.liveTradingEnabled,false);
  assert.equal(summary.backfill.requested,4);
  assert.equal(summary.backfill.processed,4);
  assert.deepEqual(summary.markets.map(m=>m.pair),["BTC/AUD","ETH/AUD"]);
   assert.ok(summary.markets.every(m=>Number.isFinite(Date.parse(m.quoteRetrievedAt))));
  assert.equal(summary.ledger.equityAud,100);
  assert.equal(summary.ledger.openPosition,null);
  assert.ok(!line.includes("test-readonly-key"));
  assert.ok(!line.includes("test-readonly-secret"));
 }finally{
  globalThis.fetch=originalFetch;
  console.log=originalLog;
 }
});


test("CoinSpot MTF evaluates a fresh contiguous tail after an older historical gap", async () => {
 const kv=kvStore(),originalFetch=globalThis.fetch;
 const daily=Array.from({length:122},(_,index)=>{
  const close=100+index*0.5;
  return {timestamp:new Date(Date.parse("2026-07-27T00:00:00.000Z")+index*86400000).toISOString(),open:close-0.1,high:close+0.3,low:close-0.3,close,volume:1000};
 });
 const fourHour=Array.from({length:420},(_,index)=>{
  const close=200+index*0.1+(index===419?2:0);
  const timestamp=Date.parse("2026-09-17T00:00:00.000Z")+index*4*3600000+(index>=100?4*3600000:0);
  return {timestamp:new Date(timestamp).toISOString(),open:close-0.1,high:close+0.3,low:close-0.3,close,volume:100};
 });
 kv.values.set("coinspot-mtf-history-global-v1",JSON.stringify({
  mode:"COINSPOT_AUD_RESEARCH_ONLY",status:"BACKFILLING",nextDate:"2026-11-26",liveTradingEnabled:false,
  markets:{BTC:{dailyCandles:daily,fourHourCandles:fourHour,tradesFetched:1000},ETH:{dailyCandles:daily,fourHourCandles:fourHour,tradesFetched:500}}
 }));
 globalThis.fetch=async url=>new Response(JSON.stringify({status:"ok",prices:{bid:100,ask:100.1,last:100.05}}),{status:200,headers:{"Content-Type":"application/json"}});
 try{
  const result=await __test.getCoinSpotMtfStrategy({EDGE_KV:kv.binding},"2026-11-26T04:00:00.000Z");
  const btc=result.markets.find(m=>m.coin==="BTC");
  assert.equal(btc.history.fourHourCandles,420);
  assert.equal(btc.history.contiguousFourHourCandles,320);
  assert.equal(btc.history.fourHourGapCount,1);
  assert.equal(btc.history.latestFourHourGap.missingIntervals,1);
  assert.equal(btc.signalStatus,"BUY_CANDIDATE_PAPER_ONLY");
  assert.equal(btc.signalError,null);
  assert.equal(btc.signal.execution.orderIntent,"NONE");
  assert.equal(btc.signal.execution.liveTradingEnabled,false);
 }finally{globalThis.fetch=originalFetch;}
});

test("CoinSpot MTF paper snapshot reports the exact contiguous-history blocker after a recent gap", async () => {
 const kv=kvStore(),originalFetch=globalThis.fetch;
 const daily=Array.from({length:122},(_,index)=>{
  const close=100+index*0.5;
  return {timestamp:new Date(Date.parse("2026-07-27T00:00:00.000Z")+index*86400000).toISOString(),open:close-0.1,high:close+0.3,low:close-0.3,close,volume:1000};
 });
 const fourHour=Array.from({length:420},(_,index)=>{
  const close=200+index*0.1;
  const timestamp=Date.parse("2026-09-17T00:00:00.000Z")+index*4*3600000+(index>=400?4*3600000:0);
  return {timestamp:new Date(timestamp).toISOString(),open:close-0.1,high:close+0.3,low:close-0.3,close,volume:100};
 });
 kv.values.set("coinspot-mtf-history-global-v1",JSON.stringify({
  mode:"COINSPOT_AUD_RESEARCH_ONLY",status:"COLLECTING_LIVE_DAY",nextDate:"2026-11-26",liveTradingEnabled:false,
  markets:{BTC:{dailyCandles:daily,fourHourCandles:fourHour,tradesFetched:1000},ETH:{dailyCandles:daily,fourHourCandles:fourHour,tradesFetched:500}}
 }));
 globalThis.fetch=async url=>new Response(JSON.stringify({status:"ok",prices:{bid:100,ask:100.1,last:100.05}}),{status:200,headers:{"Content-Type":"application/json"}});
 try{
  const result=await __test.runCoinSpotMtfPaper({EDGE_KV:kv.binding},"2026-11-26T04:00:00.000Z",1);
  const eth=result.markets.find(m=>m.coin==="ETH");
  assert.equal(eth.fourHourCandles,420);
  assert.equal(eth.contiguousFourHourCandles,20);
  assert.equal(eth.fourHourGapCount,1);
  assert.equal(eth.latestFourHourGap.previousAt,"2026-11-22T12:00:00.000Z");
  assert.equal(eth.latestFourHourGap.nextAt,"2026-11-22T20:00:00.000Z");
  assert.equal(eth.fourHourGapDiagnostics[0].status,"UNVERIFIED_GAP");
  assert.equal(eth.signalStatus,"INSUFFICIENT_CONTIGUOUS_HISTORY_AFTER_GAP");
  assert.match(eth.signalError,/20\/210/);
  assert.equal(result.paperOnly,true);
  assert.equal(result.liveTradingEnabled,false);
  assert.equal(result.cashAud,100);
  assert.equal(result.openPosition,null);
 }finally{globalThis.fetch=originalFetch;}
});


test("CoinSpot MTF identifies a verified zero-trade interval without fabricating a four-hour candle", async () => {
 const kv=kvStore(),originalFetch=globalThis.fetch;
 const now="2026-11-26T01:45:00.000Z";
 const day=24*60*60*1000,fourHours=4*60*60*1000;
 const gapAt=Date.parse("2026-11-22T16:00:00.000Z");
 const daily=Array.from({length:122},(_,index)=>{
  const timestamp=new Date(Date.parse("2026-07-28T00:00:00.000Z")+index*day).toISOString();
  return {timestamp,open:100,high:101,low:99,close:100,volume:1,tradeCount:timestamp.startsWith("2026-11-22")?144:6};
 });
 const fourHourBars=[];
 const firstFourHour=Date.parse("2026-09-17T00:00:00.000Z");
 const finalFourHour=Date.parse("2026-11-26T00:00:00.000Z");
 const countsOnGapDay={0:44,4:32,8:38,12:12,20:18};
 for(let timestamp=firstFourHour;timestamp<=finalFourHour;timestamp+=fourHours){
  if(timestamp===gapAt) continue;
  const date=new Date(timestamp).toISOString().slice(0,10);
  const hour=new Date(timestamp).getUTCHours();
  const tradeCount=date==="2026-11-22"?countsOnGapDay[hour]:1;
  fourHourBars.push({
   timestamp:new Date(timestamp).toISOString(),open:100,high:101,low:99,close:100,volume:1,tradeCount
  });
 }
 kv.values.set("coinspot-mtf-history-global-v1",JSON.stringify({
  mode:"COINSPOT_AUD_RESEARCH_ONLY",status:"COLLECTING_LIVE_DAY",nextDate:"2026-11-26",liveTradingEnabled:false,
  markets:{
   BTC:{dailyCandles:[],fourHourCandles:[],tradesFetched:0},
   ETH:{dailyCandles:daily,fourHourCandles:fourHourBars,tradesFetched:1000}
  }
 }));
 globalThis.fetch=async()=>new Response(JSON.stringify({status:"ok",prices:{bid:100,ask:100.1,last:100.05}}),{status:200,headers:{"Content-Type":"application/json"}});
 try{
  const result=await __test.getCoinSpotMtfStrategy({EDGE_KV:kv.binding},now);
  const eth=result.markets.find(m=>m.coin==="ETH");
  assert.equal(eth.history.contiguousFourHourCandles,19);
  assert.equal(eth.history.fourHourGapCount,1);
  assert.deepEqual(eth.history.fourHourGapDiagnostics,[{
   startAt:"2026-11-22T16:00:00.000Z",
   endAt:"2026-11-22T20:00:00.000Z",
   status:"CONFIRMED_NO_TRADES",
   dailyTradeCount:144,
   observedFourHourTradeCount:144
  }]);
  assert.equal(eth.signalStatus,"NO_TRADE");
  assert.equal(eth.signal.status,"NO_TRADE");
  assert.equal(eth.history.signalWindowFourHourCandles,240);
  assert.equal(eth.history.signalWindowElapsedIntervals,241);
  assert.equal(eth.history.signalWindowMissingIntervals,1);
  assert.equal(eth.history.signalWindowConfirmedZeroTradeIntervals,1);
  assert.equal(eth.history.signalWindowStatus,"READY_WITH_CONFIRMED_ZERO_TRADE_GAP");
  assert.ok(eth.signal.failedChecks.includes("dailyTrend"));
  assert.equal(eth.history.fourHourCandles,419);
  assert.equal(eth.history.storedFourHourCandles,420);

  const storedState=JSON.parse(kv.values.get("coinspot-mtf-history-global-v1"));
  const invalidDaily=structuredClone(storedState);
  invalidDaily.markets.ETH.dailyCandles.find(c=>c.timestamp==="2026-11-22T00:00:00.000Z").tradeCount=null;
  kv.values.set("coinspot-mtf-history-global-v1",JSON.stringify(invalidDaily));
  const dailyCountUnknown=await __test.getCoinSpotMtfStrategy({EDGE_KV:kv.binding},now);
  assert.equal(dailyCountUnknown.markets.find(m=>m.coin==="ETH").history.fourHourGapDiagnostics[0].status,"UNVERIFIED_GAP");
  assert.equal(dailyCountUnknown.markets.find(m=>m.coin==="ETH").signalStatus,"INSUFFICIENT_CONTIGUOUS_HISTORY_AFTER_GAP");
  assert.equal(dailyCountUnknown.markets.find(m=>m.coin==="ETH").signal,null);

  const invalidFourHour=structuredClone(storedState);
  invalidFourHour.markets.ETH.fourHourCandles.find(c=>c.timestamp==="2026-11-22T12:00:00.000Z").tradeCount=null;
  kv.values.set("coinspot-mtf-history-global-v1",JSON.stringify(invalidFourHour));
  const fourHourCountUnknown=await __test.getCoinSpotMtfStrategy({EDGE_KV:kv.binding},now);
  assert.equal(fourHourCountUnknown.markets.find(m=>m.coin==="ETH").history.fourHourGapDiagnostics[0].status,"UNVERIFIED_GAP");
  assert.equal(fourHourCountUnknown.markets.find(m=>m.coin==="ETH").signalStatus,"INSUFFICIENT_CONTIGUOUS_HISTORY_AFTER_GAP");
  assert.equal(fourHourCountUnknown.markets.find(m=>m.coin==="ETH").signal,null);

  const multipleGaps=structuredClone(storedState);
  multipleGaps.markets.ETH.fourHourCandles=multiplegapsBars(multipleGaps.markets.ETH.fourHourCandles);
  multipleGaps.markets.ETH.dailyCandles.find(c=>c.timestamp==="2026-11-22T00:00:00.000Z").tradeCount=126;
  kv.values.set("coinspot-mtf-history-global-v1",JSON.stringify(multipleGaps));
  const multiGapResult=await __test.getCoinSpotMtfStrategy({EDGE_KV:kv.binding},now);
  const multiGapEth=multiGapResult.markets.find(m=>m.coin==="ETH");
  assert.equal(multiGapEth.history.fourHourGapDiagnostics.length,2);
  assert.ok(multiGapEth.history.fourHourGapDiagnostics.every(item=>item.status==="CONFIRMED_NO_TRADES"));
  assert.equal(multiGapEth.history.signalWindowMissingIntervals,2);
  assert.equal(multiGapEth.history.signalWindowConfirmedZeroTradeIntervals,2);
  assert.equal(multiGapEth.history.signalWindowStatus,"BLOCKED_EXCESSIVE_ZERO_TRADE_GAPS");
  assert.equal(multiGapEth.signalStatus,"INSUFFICIENT_CONTIGUOUS_HISTORY_AFTER_GAP");
  assert.equal(multiGapEth.signal,null);
  assert.match(multiGapEth.signalError,/confirmed zero-trade intervals 2026-11-22T16:00:00.000Z -> 2026-11-23T00:00:00.000Z/);
 }finally{globalThis.fetch=originalFetch;}
});

function multiplegapsBars(bars) {
 return bars.filter(c=>c.timestamp!=="2026-11-22T20:00:00.000Z");
}


test("CoinSpot MTF scheduled telemetry exposes deterministic gate and history blockers", async () => {
 const kv=kvStore(),originalFetch=globalThis.fetch,originalLog=console.log,calls=[],messages=[];
 const day=24*60*60*1000,fourHours=4*60*60*1000;
 const nowMs=Date.now(),targetDate=new Date(nowMs).toISOString().slice(0,10),startMs=Date.parse(targetDate+"T00:00:00.000Z"),endMs=startMs+day,previousDate=new Date(startMs-day).toISOString().slice(0,10);
 const lastCompletedFourHourStart=Math.floor(nowMs/fourHours)*fourHours-fourHours;
 const probeAt=new Date().toISOString();
 const completeMarket=()=>({
  windows:[],processedThroughMs:endMs,trades:[],rawRowsSeen:0,rawBuyOrders:0,rawSellOrders:0,
  apiCallsTotal:0,emptyPrimaryResponses:0,emptyHistoryWindows:0,dateFormatFallbackHits:0,
  queryFormatsAttempted:[],marketsSeen:[],sampleOrderAt:null,saturatedWindows:0,complete:true,tradeCount:0
 });
 const probeMarket=coin=>{
  const tradeCount=coin==="BTC"?606:112,half=tradeCount/2;
  const variants=(buy,sell,count)=>[
   {format:"date",rawBuyOrders:0,rawSellOrders:0,validAudTrades:0,outOfRangeTrades:0},
   {format:"epoch",rawBuyOrders:0,rawSellOrders:0,validAudTrades:0,outOfRangeTrades:0},
   {format:"epoch-ms",rawBuyOrders:buy,rawSellOrders:sell,validAudTrades:count,outOfRangeTrades:0}
  ];
  return {
   coin,pair:coin+"/AUD",
   readOnlyHistory:{
    date:targetDate,rawBuyOrders:half,rawSellOrders:half,
    validAudTrades:tradeCount,outOfRangeTrades:0,
    partitionHistory:[
     {startAt:new Date(startMs).toISOString(),endAt:new Date(startMs+12*60*60*1000).toISOString(),variants:variants(half,0,half)},
     {startAt:new Date(startMs+12*60*60*1000).toISOString(),endAt:new Date(endMs).toISOString(),variants:variants(0,half,half)}
    ],
    partitionValidation:{
     version:1,status:"VALIDATED",reason:"FULL_DAY_AND_PARTITIONS_RECONCILED",
     fullDayTradeCount:tradeCount,partitionTradeCount:tradeCount,
     fullDayRawBuyOrders:half,fullDayRawSellOrders:half,
     partitionRawBuyOrders:half,partitionRawSellOrders:half,
     fullDayOutOfRangeTrades:0,partitionOutOfRangeTrades:0
    }
   }
  };
 };
 const daily=Array.from({length:122},(_,index)=>{
  const close=150-index*0.3;
  return {
   timestamp:new Date(startMs-122*day+index*day).toISOString(),
   open:close+0.1,high:close+1,low:close-1,close,volume:1000,tradeCount:100
  };
 });
 const fourHourBars=Array.from({length:420},(_,index)=>{
  const close=200-index*0.2;
  return {
   timestamp:new Date(lastCompletedFourHourStart-419*fourHours+index*fourHours).toISOString(),
   open:close+0.1,high:close+1,low:close-1,close,volume:100,tradeCount:20
  };
 });
 kv.values.set("coinspot-mtf-history-global-v1",JSON.stringify({
  mode:"COINSPOT_AUD_RESEARCH_ONLY",status:"BACKFILLING",
  nextDate:targetDate,lastProcessedDate:previousDate,lastBatchDate:previousDate,
  lastProviderProbeAt:probeAt,
  providerProbe:{
   checkedAt:probeAt,
   readOnlyStatus:"AUTHENTICATED",
   partitionValidationComputedAt:probeAt,
   markets:[probeMarket("BTC"),probeMarket("ETH")]
  },
  pendingHistorySync:{targetDate,coins:{BTC:completeMarket(),ETH:completeMarket()}},
  liveTradingEnabled:false,
  markets:{
   BTC:{dailyCandles:daily,fourHourCandles:fourHourBars,tradesFetched:42000,lastHistoryDate:targetDate},
   ETH:{dailyCandles:daily,fourHourCandles:fourHourBars,tradesFetched:18000,lastHistoryDate:targetDate}
  }
 }));
 globalThis.fetch=async url=>{
  const target=String(url);calls.push(target);
  if(target.includes("/pubapi/v2/latest/")){
   return new Response(JSON.stringify({status:"ok",prices:{bid:100,ask:100.1,last:100.05}}),{status:200,headers:{"Content-Type":"application/json"}});
  }
  throw new Error("Unexpected request in paper-only telemetry test: "+target);
 };
 console.log=(...args)=>messages.push(args.join(" "));
 let pending;
 try{
  await worker.scheduled({scheduledTime:Date.parse(targetDate+"T00:15:00.000Z")},{
   EDGE_KV:kv.binding,COINSPOT_READONLY_KEY:"test-readonly-key",COINSPOT_READONLY_SECRET:"test-readonly-secret"
  },{waitUntil:promise=>{pending=promise;}});
  assert.ok(pending instanceof Promise);
  await pending;
  const line=messages.find(message=>message.includes('"event":"COINSPOT_MTF_SCAN"'));
  assert.ok(line);
  const summary=JSON.parse(line);
  const btc=summary.markets.find(market=>market.pair==="BTC/AUD");
  assert.equal(btc.signalStatus,"NO_TRADE");
  assert.ok(btc.failedChecks.includes("dailyTrend"));
  assert.ok(btc.failedChecks.includes("fourHourTrend"));
  assert.ok(btc.failedChecks.includes("positiveLongTrendSlope"));
  assert.ok(btc.failedChecks.includes("entryTrigger"));
  assert.equal(btc.checks.liquidity,true);
  assert.equal(btc.checks.volatility,true);
  assert.equal(btc.signalWindowStatus,"READY_CONTIGUOUS");
  assert.equal(btc.signalWindowMissingIntervals,0);
  assert.equal(btc.signalWindowConfirmedZeroTradeIntervals,0);
  assert.equal(btc.signalError,null);
  assert.ok(btc.signalMetrics.dailyTrendDistancePct<0);
  assert.ok(btc.signalMetrics.fourHourTrendSpreadPct<0);
  assert.ok(btc.signalMetrics.longTrendSlopePct<0);
  assert.equal(btc.aiGateStatus,"NOT_REQUIRED");
  assert.equal(summary.lastError,null);
  assert.equal(summary.historySync.status,"COLLECTING_LIVE_DAY");
  assert.equal(summary.historySync.dateComplete,true);
  assert.equal(summary.historySync.progress,null);
  assert.deepEqual(summary.historySync.lastBatch.map(market=>({
   coin:market.coin,tradeCount:market.tradeCount,partialTradeCount:market.partialTradeCount,
   complete:market.complete,apiCalls:market.apiCalls,pendingWindows:market.pendingWindows
  })),[
   {coin:"BTC",tradeCount:0,partialTradeCount:0,complete:true,apiCalls:0,pendingWindows:0},
   {coin:"ETH",tradeCount:0,partialTradeCount:0,complete:true,apiCalls:0,pendingWindows:0}
  ]);
  assert.equal(summary.historySync.providerProbe.readOnlyStatus,"AUTHENTICATED");
  assert.equal(summary.historySync.providerProbe.checkedAt,probeAt);
  assert.equal(summary.historySync.providerProbe.partitionValidationComputedAt,probeAt);
  assert.deepEqual(summary.historySync.providerProbe.markets.map(market=>({
   pair:market.pair,status:market.partitionValidation.status,reason:market.partitionValidation.reason,
   fullDayTradeCount:market.partitionValidation.fullDayTradeCount,
   partitionTradeCount:market.partitionValidation.partitionTradeCount,
   outOfRangeTrades:market.partitionValidation.partitionOutOfRangeTrades
  })),[
   {pair:"BTC/AUD",status:"VALIDATED",reason:"FULL_DAY_AND_PARTITIONS_RECONCILED",fullDayTradeCount:606,partitionTradeCount:606,outOfRangeTrades:0},
   {pair:"ETH/AUD",status:"VALIDATED",reason:"FULL_DAY_AND_PARTITIONS_RECONCILED",fullDayTradeCount:112,partitionTradeCount:112,outOfRangeTrades:0}
  ]);
  assert.equal(JSON.stringify(summary).includes("test-readonly-key"),false);
  assert.equal(summary.historyRequestsThisScan,0);
  assert.equal(summary.paperOnly,true);
  assert.equal(summary.liveTradingEnabled,false);
  assert.equal(calls.length,2);
  assert.ok(calls.every(url=>url.includes("/pubapi/v2/latest/")));
  const saved=JSON.parse(kv.values.get("coinspot-mtf-paper-status-global-v1"));
  assert.deepEqual(saved.markets.find(market=>market.pair==="BTC/AUD").failedChecks,btc.failedChecks);
  assert.equal(saved.paperOnly,true);
  assert.equal(saved.liveTradingEnabled,false);
 }finally{
  globalThis.fetch=originalFetch;
  console.log=originalLog;
 }
});


test("backdated scheduled MTF paper scans are rejected before CoinSpot sync or KV writes",async()=>{
 const kv=kvStore(),originalFetch=globalThis.fetch;
 const accountKey="coinspot-mtf-paper-global-v1",historyKey="coinspot-mtf-history-global-v1",statusKey="coinspot-mtf-paper-status-global-v1";
 const accountRaw=JSON.stringify(createMtfPaperAccount("2026-11-25T09:00:00.000Z"));
 const historyRaw=JSON.stringify({mode:"COINSPOT_AUD_RESEARCH_ONLY",status:"BACKFILLING",nextDate:"2026-07-28",markets:{},liveTradingEnabled:false});
 kv.values.set(accountKey,accountRaw);
 kv.values.set(historyKey,historyRaw);
 let requests=0;
 globalThis.fetch=async()=>{requests++;throw new Error("Unexpected CoinSpot request for a backdated scan.");};
 try{
  await assert.rejects(
   ()=>__test.runCoinSpotMtfPaper({EDGE_KV:kv.binding,COINSPOT_READONLY_KEY:"test-key",COINSPOT_READONLY_SECRET:"test-secret"},"2026-11-25T08:00:00.000Z",1),
   /older than the stored ledger/
  );
  assert.equal(requests,0);
  assert.equal(kv.values.get(accountKey),accountRaw);
  assert.equal(kv.values.get(historyKey),historyRaw);
  assert.equal(kv.values.has(statusKey),false);
 }finally{globalThis.fetch=originalFetch;}
});

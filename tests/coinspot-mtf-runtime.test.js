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
  assert.equal(calls.filter(call=>call.url.endsWith("/orders/market/completed")).length,8);
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
  assert.equal(history.lastProcessedDate,"2026-07-31");
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

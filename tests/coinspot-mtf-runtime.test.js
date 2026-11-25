import test from "node:test";
import assert from "node:assert/strict";
import { __test } from "../index.js";

function kvStore() {
 const values=new Map();
 return {values,binding:{get:async key=>values.get(key)??null,put:async(key,value)=>values.set(key,value)}};
}

test("CoinSpot MTF sync backfills one UTC day per run using read-only historical orders",async()=>{
 const kv=kvStore(),originalFetch=globalThis.fetch,calls=[];
 globalThis.fetch=async(url,options)=>{
  calls.push({url:String(url),method:options.method,body:JSON.parse(options.body)});
  return new Response(JSON.stringify({status:"ok",buyorders:[],sellorders:[]}),{status:200,headers:{"Content-Type":"application/json"}});
 };
 try {
  const now="2026-11-25T06:00:00.000Z";
  const first=await __test.syncCoinSpotMtfHistory({EDGE_KV:kv.binding,COINSPOT_READONLY_KEY:"test-key",COINSPOT_READONLY_SECRET:"test-secret"},now);
  assert.equal(first.status,"BACKFILLING");
  assert.equal(first.processedDate,"2026-07-28");
  assert.equal(calls.length,2);
  assert.ok(calls.every(call=>call.url.endsWith("/orders/market/completed")&&call.method==="POST"));
  assert.ok(calls.every(call=>call.body.markettype==="AUD"&&call.body.limit===500));
  const stored=JSON.parse(kv.values.get("coinspot-mtf-history-global-v1"));
  assert.equal(stored.liveTradingEnabled,false);
  assert.equal(stored.markets.BTC.dailyCandles.length,0);
  assert.equal(stored.nextDate,"2026-07-29");
 } finally { globalThis.fetch=originalFetch; }
});

test("CoinSpot MTF status does not invent candles or signals before history is warm",async()=>{
 const kv=kvStore();
 kv.values.set("coinspot-mtf-history-global-v1",JSON.stringify({
  mode:"COINSPOT_AUD_RESEARCH_ONLY",status:"BACKFILLING",nextDate:"2026-07-29",liveTradingEnabled:false,
  markets:{BTC:{dailyCandles:[],fourHourCandles:[],tradesFetched:0},ETH:{dailyCandles:[],fourHourCandles:[],tradesFetched:0}}
 }));
 const status=await __test.getCoinSpotMtfStrategy({EDGE_KV:kv.binding});
 assert.equal(status.markets.length,2);
 assert.equal(status.markets[0].signalStatus,"WARMUP_REQUIRED");
 assert.equal(status.markets[0].signal,null);
 assert.equal(status.liveTradingEnabled,false);
});

test("CoinSpot MTF paper runner advances history and creates a paper-only AUD ledger",async()=>{
 const kv=kvStore(),originalFetch=globalThis.fetch,calls=[];
 globalThis.fetch=async(url,options)=>{
  calls.push({url:String(url),body:JSON.parse(options.body)});
  return new Response(JSON.stringify({status:"ok",buyorders:[],sellorders:[]}),{status:200,headers:{"Content-Type":"application/json"}});
 };
 try{
  const result=await __test.runCoinSpotMtfPaper({EDGE_KV:kv.binding,COINSPOT_READONLY_KEY:"test-key",COINSPOT_READONLY_SECRET:"test-secret",OPENAI_API_KEY:""}, "2026-11-25T08:00:00.000Z");
  assert.equal(calls.length,8);
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

test("CoinSpot timeout is explicit and an incomplete history date is not written",async()=>{
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
  assert.equal(calls,2);
  assert.equal(kv.values.has("coinspot-mtf-history-global-v1"),false);
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

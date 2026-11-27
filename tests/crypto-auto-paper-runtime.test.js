import test from "node:test";
import assert from "node:assert/strict";
import { __test } from "../index.js";

function storage(raw) {
 const values=new Map([["crypto-auto-paper-global-v1",raw]]);
 return { values, binding:{get:async key=>values.get(key)??null,put:async(key,value)=>values.set(key,value)} };
}

test("automated crypto scan preserves invalid JSON ledger without replacing it",async()=>{
 const raw="not-json",kv=storage(raw);
 const result=await __test.runAutomatedCryptoPaper({EDGE_KV:kv.binding});
 assert.equal(result.status,"LEDGER_INVALID_JSON");
 assert.equal(kv.values.get("crypto-auto-paper-global-v1"),raw);
});

test("automated crypto scan preserves structurally invalid ledger without replacing it",async()=>{
 const raw=JSON.stringify({mode:"AUTOMATED_PAPER_ONLY",quoteCurrency:"USDT",startingCapital:100,liveTradingEnabled:false,closedTrades:[],lastProcessed:{},cash:-500});
 const kv=storage(raw);
 const result=await __test.runAutomatedCryptoPaper({EDGE_KV:kv.binding});
 assert.equal(result.status,"LEDGER_VALIDATION_FAILED");
 assert.equal(kv.values.get("crypto-auto-paper-global-v1"),raw);
});


test("scheduled crypto scan stays below the Worker subrequest cap and omits AbortSignal.timeout", async () => {
 const kv=storage(null), calls=[];
 const now="2026-11-25T06:00:00.000Z";
 const result=await __test.runScheduledCryptoPaper({EDGE_KV:kv.binding},{
  now,
  fetchImpl:async (url,options)=>{
   calls.push({url,hasSignal:Object.hasOwn(options,"signal")});
   return new Response("unavailable",{status:503});
  }
 });
 assert.equal(calls.length,40);
 assert.ok(calls.length<50);
 assert.ok(calls.every(call=>call.hasSignal===false));
 assert.equal(result.mode,"AUTOMATED_PAPER_ONLY");
 assert.equal(result.liveTradingEnabled,false);
 assert.equal(result.marketDataStatus,"ALL_PROVIDERS_UNAVAILABLE");
 assert.ok(result.markets.every(market=>market.errorCode==="HTTP_503"));
 assert.equal(result.lastScanAt,now);
 assert.equal(JSON.parse(kv.values.get("crypto-auto-paper-global-v1")).lastScanAt,now);
});

test("scheduled crypto scan records a bounded provider error detail without storing credentials", async () => {
 const kv=storage(null);
 const result=await __test.runScheduledCryptoPaper({EDGE_KV:kv.binding},{
  now:"2026-11-25T06:00:00.000Z",
  fetchImpl:async ()=>{throw new TypeError("network fetch failed\nBearer secret-must-not-appear");}
 });
 const stored=JSON.parse(kv.values.get("crypto-auto-paper-global-v1"));
 assert.equal(result.markets.length,10);
 assert.ok(result.markets.every(market=>market.errorCode==="UPSTREAM_FETCH_ERROR"));
 assert.ok(result.markets.every(market=>typeof market.errorDetail==="string"&&market.errorDetail.length<=160));
 assert.ok(!JSON.stringify(stored).includes("secret-must-not-appear"));
});

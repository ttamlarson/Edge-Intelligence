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

import test from "node:test";import assert from "node:assert/strict";import {normalizeCoinSpotMarket,calculateCoinSpotSpreadBps} from "../coinspot.js";
const latest={status:"ok",prices:{bid:99000,ask:99100,last:99050}};
const trades={status:"ok",orders:[{market:"BTC/AUD",solddate:"2026-11-18T00:00:00.000Z",rate:99000,amount:.001,total:99},{market:"BTC/USDT",solddate:"2026-11-18T00:01:00.000Z",rate:1,amount:1,total:1},{market:"BTC/AUD",solddate:"bad",rate:1,amount:1,total:1}]};
test("CoinSpot normalizer validates AUD quote and filters non-AUD/malformed trades",()=>{const x=normalizeCoinSpotMarket({coin:"BTC",latest,trades});assert.equal(x.pair,"BTC/AUD");assert.equal(x.bid,99000);assert.equal(x.ask,99100);assert.equal(x.completedTrades.length,1);assert.equal(x.dataClass,"live_public_quote_and_recent_completed_trades_not_ohlc");});
test("CoinSpot normalizer rejects invalid prices and unsupported coins",()=>{assert.throws(()=>normalizeCoinSpotMarket({coin:"DOGE",latest,trades}));assert.throws(()=>normalizeCoinSpotMarket({coin:"BTC",latest:{...latest,prices:{bid:0,ask:1,last:1}},trades}));});
test("CoinSpot completed trades are sorted and bounded to the latest 100",()=>{const orders=Array.from({length:120},(_,i)=>({market:"ETH/AUD",solddate:new Date(Date.parse("2026-11-17T00:00:00Z")+i*1000).toISOString(),rate:3000+i,amount:.01,total:30}));const x=normalizeCoinSpotMarket({coin:"ETH",latest,trades:{status:"ok",orders}});assert.equal(x.completedTrades.length,100);assert.equal(x.completedTrades[0].price,3020);assert.equal(x.completedTrades.at(-1).price,3119);});

test("CoinSpot spread uses the midpoint and preserves precision at the 50 bps execution gate",()=>{
 const spread=calculateCoinSpotSpreadBps(91640.63,92100);
 assert.ok(spread>50);
 const normalized=normalizeCoinSpotMarket({coin:"BTC",latest:{status:"ok",prices:{bid:91640.63,ask:92100,last:91650}},trades:{status:"ok",orders:[]}});
 assert.ok(normalized.spreadBps>50);
 assert.equal(normalized.spreadPct,Number((normalized.spreadBps/100).toFixed(4)));
});
test("CoinSpot spread rejects invalid or crossed quotes",()=>{
 assert.throws(()=>calculateCoinSpotSpreadBps(0,1),/valid/);
 assert.throws(()=>calculateCoinSpotSpreadBps(2,1),/valid/);
});

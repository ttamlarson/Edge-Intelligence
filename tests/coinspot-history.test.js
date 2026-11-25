import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCoinSpotCompletedOrders, aggregateCoinSpotTrades, mergeCoinSpotCandles } from "../coinspot-history.js";

test("normalizes authenticated CoinSpot AUD completed orders and rejects other quote markets",()=>{
 const payload={status:"ok",buyorders:[
  {market:"BTC/AUD",solddate:"2026-11-24T00:10:00Z",rate:100,amount:2,total:200},
  {market:"BTC/USDT",solddate:"2026-11-24T00:11:00Z",rate:1,amount:2,total:2},
  {market:"BTC/AUD",solddate:"bad",rate:100,amount:1,total:100}
 ],sellorders:[{market:"BTC/AUD",solddate:"2026-11-24T00:10:00Z",rate:100,amount:2,total:200}]};
 const trades=normalizeCoinSpotCompletedOrders({coin:"BTC",payload});
 assert.equal(trades.length,1);
 assert.equal(trades[0].totalAud,200);
 assert.throws(()=>normalizeCoinSpotCompletedOrders({coin:"DOGE",payload}));
 assert.throws(()=>normalizeCoinSpotCompletedOrders({coin:"BTC",payload:{status:"error"}}));
});

test("aggregates native CoinSpot trades into 4h and daily OHLCV without filling empty buckets",()=>{
 const start=Date.parse("2026-11-24T00:00:00Z");
 const trades=[
  {timestamp:start+1000,price:100,amount:1,totalAud:100},
  {timestamp:start+2000,price:105,amount:2,totalAud:210},
  {timestamp:start+4*3600000+1000,price:103,amount:1,totalAud:103}
 ];
 const fourHour=aggregateCoinSpotTrades(trades,4*3600000);
 const daily=aggregateCoinSpotTrades(trades,24*3600000);
 assert.equal(fourHour.length,2);
 assert.equal(fourHour[0].open,100);
 assert.equal(fourHour[0].high,105);
 assert.equal(fourHour[0].close,105);
 assert.equal(fourHour[0].volume,3);
 assert.equal(daily.length,1);
 assert.equal(daily[0].tradeCount,3);
});

test("merges updates by candle timestamp and keeps the newest bounded history",()=>{
 const base={open:1,high:2,low:1,close:2,volume:1};
 const merged=mergeCoinSpotCandles(
  [{...base,timestamp:"2026-11-23T00:00:00Z"},{...base,timestamp:"2026-11-24T00:00:00Z"}],
  [{...base,close:3,timestamp:"2026-11-24T00:00:00Z"},{...base,timestamp:"2026-11-25T00:00:00Z"}],2
 );
 assert.equal(merged.length,2);
 assert.equal(merged[0].close,3);
 assert.equal(merged[1].timestamp,"2026-11-25T00:00:00Z");
});

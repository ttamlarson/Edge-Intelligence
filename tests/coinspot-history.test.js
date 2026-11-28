import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCoinSpotCompletedOrders, aggregateCoinSpotTrades, mergeCoinSpotCandles, coinSpotHistoryRangeParams, COINSPOT_FOUR_HOUR_HISTORY_LIMIT } from "../coinspot-history.js";

test("normalizes authenticated CoinSpot AUD completed orders and rejects other quote markets",()=>{
 const payload={status:"ok",buyorders:[
  {market:"BTC/AUD",solddate:"2026-11-24T00:10:00Z",rate:100,amount:2,total:200},
  {market:"BTC/USDT",solddate:"2026-11-24T00:11:00Z",rate:1,amount:2,total:2},
 ],sellorders:[{market:"BTC/AUD",solddate:"2026-11-24T00:10:00Z",rate:100,amount:2,total:200}]};
 const trades=normalizeCoinSpotCompletedOrders({coin:"BTC",payload});
 assert.equal(trades.length,1);
 assert.equal(trades[0].totalAud,200);
 const malformedMixedPayload = {
  status:"ok",
  buyorders:[
   {market:"BTC/AUD",solddate:"2026-11-24T00:10:00Z",rate:100,amount:2,total:200},
   {market:"BTC/AUD",solddate:"bad",rate:100,amount:1,total:100}
  ],
  sellorders:[]
 };
 assert.throws(
  ()=>normalizeCoinSpotCompletedOrders({coin:"BTC",payload:malformedMixedPayload}),
  /COINSPOT_HISTORY_SCHEMA_MISMATCH/
 );
 assert.throws(
  ()=>normalizeCoinSpotCompletedOrders({coin:"BTC",payload:{status:"ok",buyorders:[{solddate:"2026-11-24T00:10:00Z",rate:100,amount:1,total:100}],sellorders:[]}}),
  /COINSPOT_HISTORY_SCHEMA_MISMATCH/
 );
 assert.throws(()=>normalizeCoinSpotCompletedOrders({coin:"DOGE",payload}));
 assert.throws(()=>normalizeCoinSpotCompletedOrders({coin:"BTC",payload:{status:"error"}}));
});

test("rejects coercible non-numeric CoinSpot fields while accepting decimal strings", () => {
 const base = {
  market: "BTC/AUD",
  solddate: "2026-11-24T00:10:00.000Z",
  rate: 100,
  amount: 0.5,
  total: 50
 };
 for (const field of ["rate", "amount", "total"]) {
  for (const invalid of [true, [1], "0x10", "Infinity", "NaN", {}]) {
   const payload = { status: "ok", buyorders: [{ ...base, [field]: invalid }], sellorders: [] };
   assert.throws(
    () => normalizeCoinSpotCompletedOrders({ coin: "BTC", payload }),
    /COINSPOT_HISTORY_SCHEMA_MISMATCH/,
    `expected invalid ${field} value ${JSON.stringify(invalid)} to be rejected`
   );
  }
 }
 const decimalPayload = {
  status: "ok",
  buyorders: [{ ...base, rate: "100.25", amount: "0.5", total: "50.125" }],
  sellorders: []
 };
 const [trade] = normalizeCoinSpotCompletedOrders({ coin: "BTC", payload: decimalPayload });
 assert.equal(trade.price, 100.25);
 assert.equal(trade.amount, 0.5);
 assert.equal(trade.totalAud, 50.125);
});

test("aggregates only canonical numeric timestamps and normalized numeric trade fields", () => {
 const timestamp = Date.parse("2026-11-24T00:10:00.000Z");
 const valid = { timestamp, price: 100, amount: 0.5, totalAud: 50 };
 assert.equal(aggregateCoinSpotTrades([valid], 4 * 60 * 60 * 1000).length, 1);
 for (const invalid of [
  { ...valid, timestamp: String(timestamp) },
  { ...valid, timestamp: true },
  { ...valid, price: true },
  { ...valid, amount: [0.5] },
  { ...valid, totalAud: "0x32" }
 ]) {
  assert.throws(() => aggregateCoinSpotTrades([invalid], 4 * 60 * 60 * 1000), /Invalid normalized CoinSpot trade/);
 }
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


test("retains up to 720 actual four-hour candles for extended multi-timeframe history", () => {
 const base={open:100,high:101,low:99,close:100,volume:1};
 const bars=Array.from({length:730},(_,index)=>({
  ...base,timestamp:new Date(Date.UTC(2026,0,1)+index*4*60*60*1000).toISOString()
 }));
 const retained=mergeCoinSpotCandles([],bars,COINSPOT_FOUR_HOUR_HISTORY_LIMIT);
 assert.equal(COINSPOT_FOUR_HOUR_HISTORY_LIMIT,720);
 assert.equal(retained.length,720);
 assert.equal(retained[0].timestamp,bars[10].timestamp);
 assert.equal(retained.at(-1).timestamp,bars.at(-1).timestamp);
});

test("builds documented UTC-date and exact Unix-epoch CoinSpot history ranges", () => {
 const start = Date.parse("2026-08-14T00:00:00.000Z");
 const end = Date.parse("2026-08-15T00:00:00.000Z");
 assert.deepEqual(coinSpotHistoryRangeParams(start, end, "date"), {
  startdate: "2026-08-14", enddate: "2026-08-14"
 });
 assert.deepEqual(coinSpotHistoryRangeParams(start, end, "epoch"), {
  startdate: Math.floor(start / 1000), enddate: Math.floor((end - 1) / 1000)
 });
 const halfDayEnd = start + 12 * 60 * 60 * 1000;
 assert.deepEqual(coinSpotHistoryRangeParams(start, halfDayEnd, "epoch"), {
  startdate: Math.floor(start / 1000), enddate: Math.floor((halfDayEnd - 1) / 1000)
 });
 assert.deepEqual(coinSpotHistoryRangeParams(start, halfDayEnd, "epoch-string"), {
  startdate: String(Math.floor(start / 1000)), enddate: String(Math.floor((halfDayEnd - 1) / 1000))
 });
 assert.deepEqual(coinSpotHistoryRangeParams(start, halfDayEnd, "epoch-ms"), {
  startdate: start, enddate: halfDayEnd - 1
 });
 assert.throws(() => coinSpotHistoryRangeParams(end, start, "date"), /Invalid CoinSpot history date range/);
 assert.throws(() => coinSpotHistoryRangeParams(start, end, "milliseconds"), /format must be date, epoch, epoch-string or epoch-ms/);
});

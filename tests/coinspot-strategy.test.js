import test from "node:test";import assert from "node:assert/strict";import {validateCoinSpotCandles,backtestCoinSpotTrend,walkForwardCoinSpotTrend} from "../coinspot-strategy.js";
const candles=Array.from({length:400},(_,i)=>{const close=100+i*.08+Math.sin(i/5)*.7;return {timestamp:new Date(Date.UTC(2025,0,1,i)).toISOString(),open:close-.1,high:close+.5,low:close-.5,close,volume:100+i};});
test("validates minimum history and OHLCV integrity",()=>{assert.throws(()=>validateCoinSpotCandles(candles.slice(0,299)));assert.equal(validateCoinSpotCandles(candles).length,400);const bad=candles.map(x=>({...x}));bad[3].high=1;assert.throws(()=>validateCoinSpotCandles(bad));});
test("backtest uses 100 AUD, split samples and explicit trading costs",()=>{const x=backtestCoinSpotTrend({candles});assert.equal(x.startingCapitalAud,100);assert.equal(x.liveTradingEnabled,false);assert.ok(x.inSample);assert.ok(x.outOfSample);assert.equal(x.costs.feeRate,.001);assert.equal(x.sample.minimumOutOfSampleTrades,30);assert.equal(x.sample.outOfSampleCandles,400-x.splitIndex);assert.ok(x.outOfSample.evaluatedBars>0);assert.ok(x.outOfSample.skipped.trendFilter>=0);assert.ok(x.outOfSample.dateRange.from);assert.ok(x.outOfSample.dateRange.to);});
test("rejects unsupported starting capital and invalid parameters",()=>{assert.throws(()=>backtestCoinSpotTrend({candles,startingCapitalAud:500}));assert.throws(()=>backtestCoinSpotTrend({candles,spreadBps:-1}));});

test("supports non-AUD quote currencies without relabelling P&L as AUD",()=>{const x=backtestCoinSpotTrend({candles,quoteCurrency:"USDT"});assert.equal(x.quoteCurrency,"USDT");assert.equal(x.startingCapital,100);assert.equal(x.startingCapitalAud,undefined);assert.equal(typeof x.outOfSample.netPnlQuote,"number");assert.equal(x.outOfSample.netPnlAud,undefined);});


test("crypto walk-forward uses fixed chronological folds and separate virtual capital", () => {
 const now=Date.parse("2026-11-25T08:00:00.000Z");
 const result=walkForwardCoinSpotTrend({
  candles,market:"BTCUSDT",source:"Synthetic test fixture only",quoteCurrency:"USDT",now
 });
 assert.equal(result.liveTradingEnabled,false);
 assert.equal(result.parameterPolicy,"FIXED_RULES_NO_FITTING");
 assert.equal(result.sourceVerification,"NOT_INDEPENDENTLY_VERIFIED");
 assert.equal(result.folds.length,3);
 assert.equal(result.folds[0].priorHistoryBars,240);
 assert.equal(result.folds[0].testStartAt,candles[240].timestamp);
 assert.equal(result.summary.assessment,"INSUFFICIENT_OUT_OF_SAMPLE_TRADES");
 assert.ok(result.folds.every(fold=>fold.endingEquityQuote>=0));
});

test("crypto walk-forward rejects future, incomplete and discontinuous hourly data", () => {
 const shifted=candles.map((bar,index)=>({
  ...bar,timestamp:new Date(Date.parse("2026-11-25T07:00:00.000Z")-(candles.length-1-index)*3600000).toISOString()
 }));
 assert.throws(()=>walkForwardCoinSpotTrend({
  candles:shifted,market:"BTCUSDT",source:"fixture",now:Date.parse("2026-11-25T06:00:00.000Z")
 }),/future-dated/i);
 assert.throws(()=>walkForwardCoinSpotTrend({
  candles:shifted,market:"BTCUSDT",source:"fixture",now:Date.parse("2026-11-25T07:30:00.000Z")
 }),/incomplete/i);
 const gap=shifted.map(x=>({...x}));
 for(let i=100;i<gap.length;i++)gap[i].timestamp=new Date(Date.parse(gap[i].timestamp)+3600000).toISOString();
 assert.throws(()=>walkForwardCoinSpotTrend({
  candles:gap,market:"BTCUSDT",source:"fixture",now:Date.parse("2026-11-25T08:05:00.000Z")
 }),/contiguous hourly/i);
});

test("crypto walk-forward does not let later folds alter earlier results", () => {
 const first=walkForwardCoinSpotTrend({
  candles,market:"BTCUSDT",source:"Synthetic test fixture only",
  now:Date.parse("2026-11-25T08:00:00.000Z")
 });
 const changed=candles.map(x=>({...x}));
 const firstEnd=240+Math.floor((candles.length-240)/3);
 for(let i=firstEnd;i<changed.length;i++){
  changed[i]={...changed[i],open:changed[i].open*1.5,high:changed[i].high*1.5,low:changed[i].low*1.5,close:changed[i].close*1.5};
 }
 const second=walkForwardCoinSpotTrend({
  candles:changed,market:"BTCUSDT",source:"Synthetic test fixture only",
  now:Date.parse("2026-11-25T08:00:00.000Z")
 });
 assert.deepEqual(second.folds[0],first.folds[0]);
});

test("crypto strategy exits stop-first at the worse open after a gap", () => {
 const now=Date.parse("2026-11-25T08:00:00.000Z");
 const original=walkForwardCoinSpotTrend({
  candles,market:"BTCUSDT",source:"Synthetic test fixture only",now
 });
 const trade=original.folds.flatMap(fold=>fold.tradesDetail)[0];
 assert.ok(trade,"test fixture should produce a qualifying paper-research trade");
 const entryIndex=candles.findIndex(bar=>bar.timestamp===trade.entryAt);
 assert.ok(entryIndex>=0 && entryIndex+1<candles.length);
 const changed=candles.map(x=>({...x}));
 const gapOpen=trade.stopPrice-0.25;
 changed[entryIndex+1]={
  ...changed[entryIndex+1],open:gapOpen,low:gapOpen-0.1,
  high:trade.targetPrice+0.1,close:gapOpen-0.05
 };
 const result=walkForwardCoinSpotTrend({
  candles:changed,market:"BTCUSDT",source:"Synthetic test fixture only",now
 });
 const closed=result.folds.flatMap(fold=>fold.tradesDetail).find(item=>item.entryAt===trade.entryAt);
 assert.equal(closed.reason,"STOP_GAP_WORSE_OPEN");
 assert.equal(closed.exit,gapOpen);
});

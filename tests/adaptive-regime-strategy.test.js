import test from "node:test";
import assert from "node:assert/strict";
import { backtestAdaptiveRegime } from "../adaptive-regime-strategy.js";

const candles = Array.from({length:520},(_,i)=>{
  const close=100+i*.05+Math.sin(i/9)*1.4;
  return {timestamp:new Date(Date.UTC(2025,0,1,i)).toISOString(),open:close-.15,high:close+.6,low:close-.6,close,volume:1000+i};
});
test("adaptive regime strategy validates candles and returns chronological OOS assessment",()=>{
  const result=backtestAdaptiveRegime({candles,market:"SOLUSDT",quoteCurrency:"USDT"});
  assert.equal(result.strategy,"EDGE_ADAPTIVE_REGIME_1H_V1");
  assert.equal(result.market,"SOLUSDT");
  assert.equal(result.liveTradingEnabled,false);
  assert.equal(result.activeVariant.strategy,"EDGE_ACTIVE_MOMENTUM_1H_V1");
  assert.ok(result.activeVariant.outOfSample.evaluatedBars>0);
  assert.ok(["INSUFFICIENT_OUT_OF_SAMPLE_TRADES","NOT_PROVEN_PROFITABLE","CANDIDATE_FOR_FORWARD_PAPER_TEST"].includes(result.activeVariant.assessment));
  assert.equal(result.sample.totalCandles,520);
  assert.equal(result.sample.outOfSampleCandles,520-result.sample.splitIndex);
  assert.ok(result.inSample.evaluatedBars>0);
  assert.ok(result.outOfSample.evaluatedBars>0);
  assert.ok(result.outOfSample.skipped.bullRegime>=0);
  assert.ok(["INSUFFICIENT_OUT_OF_SAMPLE_TRADES","NOT_PROVEN_PROFITABLE","CANDIDATE_FOR_FORWARD_PAPER_TEST"].includes(result.assessment));
});
test("adaptive regime rejects invalid OHLCV and unsafe assumptions",()=>{
  assert.throws(()=>backtestAdaptiveRegime({candles:candles.slice(0,299)}));
  const invalid=candles.map(x=>({...x}));invalid[10].low=999;
  assert.throws(()=>backtestAdaptiveRegime({candles:invalid}));
  assert.throws(()=>backtestAdaptiveRegime({candles,startingCapital:500}));
  assert.throws(()=>backtestAdaptiveRegime({candles,trainFraction:.2}));
});

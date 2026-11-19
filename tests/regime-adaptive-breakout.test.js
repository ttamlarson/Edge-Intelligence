import test from "node:test";
import assert from "node:assert/strict";
import { aggregateFourHourCandles, backtestRegimeAdaptiveBreakout } from "../regime-adaptive-breakout.js";
const fixture = Array.from({ length: 2400 }, (_, i) => {
  const close = 100 + i * .035 + Math.sin(i / 13) * 2 + (i > 1700 ? Math.sin(i / 5) * 1.2 : 0);
  return { timestamp: new Date(Date.UTC(2025, 0, 1, i)).toISOString(), open: close - .08,
    high: close + .45, low: close - .45, close, volume: 1000 + (i % 17) * 30 };
});
test("aggregates only complete ordered four-hour candles", () => {
  const bars = aggregateFourHourCandles(fixture);
  assert.equal(bars.length, 600);
  assert.equal(bars[0].volume, fixture.slice(0, 4).reduce((s, x) => s + x.volume, 0));
  assert.equal(bars[0].open, fixture[0].open);
  assert.equal(bars[0].close, fixture[3].close);
});
test("breakout returns chronological OOS metrics and never enables live trading", () => {
  const result = backtestRegimeAdaptiveBreakout({ candles: fixture, market: "BTCUSDT" });
  assert.equal(result.strategy, "EDGE_REGIME_ADAPTIVE_BREAKOUT_4H_V1");
  assert.equal(result.timeframe, "4h");
  assert.equal(result.liveTradingEnabled, false);
  assert.ok(result.sample.fourHourCandles >= 500);
  assert.ok(result.outOfSample.evaluatedBars > 0);
  assert.ok(result.outOfSample.dateRange.from);
  assert.ok(result.outOfSample.dateRange.to);
  assert.ok(["INSUFFICIENT_OUT_OF_SAMPLE_TRADES", "NOT_PROVEN_PROFITABLE", "CANDIDATE_FOR_FORWARD_PAPER_TEST"].includes(result.assessment));
  assert.equal(result.risk.perTradePct, .5);
});
test("rejects malformed candles and unsafe assumptions", () => {
  assert.throws(() => aggregateFourHourCandles(fixture.slice(0, 299)));
  const invalid = fixture.map(x => ({ ...x })); invalid[8].high = 1;
  assert.throws(() => aggregateFourHourCandles(invalid));
  assert.throws(() => backtestRegimeAdaptiveBreakout({ candles: fixture, startingCapital: 500 }));
  assert.throws(() => backtestRegimeAdaptiveBreakout({ candles: fixture, trainFraction: .2 }));
});
test("drops incomplete four-hour buckets rather than filling missing hourly bars", () => {
  const gapped = fixture.filter((_, i) => i !== 20);
  const bars = aggregateFourHourCandles(gapped);
  assert.ok(bars.length < 600);
});

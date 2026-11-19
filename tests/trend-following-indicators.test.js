import test from "node:test";
import assert from "node:assert/strict";
import { aggregateTrendFourHourCandles, backtestTrendFollowingIndicators } from "../trend-following-indicators.js";
const fixture = Array.from({ length: 7200 }, (_, i) => {
  const wave = Math.sin(i / 37) * 1.7 + Math.sin(i / 9) * .25;
  const base = i < 2400 ? 100 + i * .018 : i < 4800 ? 143 + (i - 2400) * .005 : 155 + (i - 4800) * .022;
  const close = base + wave;
  return { timestamp: new Date(Date.UTC(2024, 0, 1, i)).toISOString(), open: close - .12, high: close + .55, low: close - .55, close, volume: 1000 + (i % 31) * 20 };
});
test("aggregates only complete aligned 4h candles", () => {
  const bars = aggregateTrendFourHourCandles(fixture);
  assert.equal(bars.length, 1800); assert.equal(bars[0].open, fixture[0].open);
  assert.equal(bars[0].close, fixture[3].close);
  assert.equal(bars[0].volume, fixture.slice(0, 4).reduce((s, x) => s + x.volume, 0));
});
test("returns independent 1h and 4h variants and never enables live execution", () => {
  const r = backtestTrendFollowingIndicators({ candles: fixture, market: "BTCUSDT" });
  assert.equal(r.strategy, "EDGE_TREND_FOLLOWING_INDICATORS_V2"); assert.equal(r.liveTradingEnabled, false);
  assert.equal(r.oneHour.timeframe, "1h"); assert.equal(r.fourHour.timeframe, "4h");
  assert.equal(r.oneHour.variants.length, 2); assert.equal(r.fourHour.variants.length, 2);
  for (const tf of [r.oneHour, r.fourHour]) for (const v of tf.variants) {
    assert.ok(v.outOfSample.evaluatedBars > 0);
    assert.ok(["INSUFFICIENT_OUT_OF_SAMPLE_TRADES", "NOT_PROVEN_PROFITABLE", "CANDIDATE_FOR_FORWARD_PAPER_TEST"].includes(v.assessment));
  }
});
test("keeps minimum evidence and risk gates intact", () => {
  assert.throws(() => backtestTrendFollowingIndicators({ candles: fixture, minimumOutOfSampleTrades: 10 }));
  assert.throws(() => backtestTrendFollowingIndicators({ candles: fixture, startingCapital: 500 }));
  const r = backtestTrendFollowingIndicators({ candles: fixture });
  assert.equal(r.sample.minimumOutOfSampleTrades, 30);
  assert.equal(r.oneHour.variants[0].riskPct, .5);
});
test("rejects malformed and unordered candles", () => {
  assert.throws(() => aggregateTrendFourHourCandles(fixture.slice(0, 299)));
  const bad = fixture.map(x => ({ ...x })); bad[5].high = 1;
  assert.throws(() => backtestTrendFollowingIndicators({ candles: bad }));
  const unordered = fixture.map(x => ({ ...x })); [unordered[3], unordered[4]] = [unordered[4], unordered[3]];
  assert.throws(() => aggregateTrendFourHourCandles(unordered));
});
test("drops gapped and incomplete 4h buckets", () => {
  const bars = aggregateTrendFourHourCandles(fixture.filter((_, i) => i !== 20));
  assert.ok(bars.length < 1800);
});

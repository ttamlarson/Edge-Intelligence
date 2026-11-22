import test from "node:test";
import assert from "node:assert/strict";
import { analyzeAsxDailySetup } from "../asx-analysis.js";

const now = Date.parse("2026-11-20T08:00:00Z");
function bars() {
  return Array.from({ length: 60 }, (_, i) => {
    const close = 10 + i * 0.08;
    return { timestamp: new Date(now - (60 - i) * 86400000).toISOString(), open: close - 0.02, high: close + 0.2, low: close - 0.2, close, volume: 1000 + i * 10 };
  });
}
test("ASX analysis returns an explainable technical score, not a probability", () => {
  const data = bars();
  const result = analyzeAsxDailySetup({ symbol: "BHP", bars: data, source: "Test fixture", currency: "AUD", observedAt: data.at(-1).timestamp, now });
  assert.equal(result.status, "REVIEW");
  assert.equal(result.scoreType, "TECHNICAL_SETUP_SCORE_NOT_PROBABILITY");
  assert.ok(result.score >= 0 && result.score <= 100);
  assert.equal(result.factors.length, 5);
  assert.equal(result.indicators.sma20 > result.indicators.sma50, true);
});
test("ASX analysis rejects stale, malformed, non-AUD and insufficient input", () => {
  const data = bars();
  const args = { symbol: "BHP", bars: data, source: "Test fixture", currency: "AUD", observedAt: data.at(-1).timestamp, now };
  assert.equal(analyzeAsxDailySetup({ ...args, currency: "USD" }).status, "REJECTED");
  assert.equal(analyzeAsxDailySetup({ ...args, bars: data.slice(0, 20) }).status, "INSUFFICIENT_DATA");
  assert.equal(analyzeAsxDailySetup({ ...args, observedAt: new Date(now - 2 * 86400000).toISOString() }).status, "STALE");
  const malformed = data.map(bar => ({ ...bar })); malformed[5].high = 0;
  assert.equal(analyzeAsxDailySetup({ ...args, bars: malformed }).status, "REJECTED");
});
test("missing volume is excluded from score coverage rather than fabricated", () => {
  const data = bars().map(({ volume, ...bar }) => ({ ...bar, volume: null }));
  const result = analyzeAsxDailySetup({ symbol: "CBA", bars: data, source: "Test fixture", currency: "AUD", observedAt: data.at(-1).timestamp, now });
  assert.equal(result.status, "REVIEW");
  assert.equal(result.scoreCoverage, 85);
  assert.equal(result.indicators.volumeRatio, null);
});

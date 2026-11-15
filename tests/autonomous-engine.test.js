import test from "node:test";
import assert from "node:assert/strict";
import { createPaperPortfolio, estimateAsxSideCost, evaluateAsxSwingSetup, openPaperPosition, validateDailyBars } from "../autonomous-engine.js";
const now = Date.parse("2026-11-15T02:00:00Z");
function makeBars() {
  const bars = [];
  for (let i = 0; i < 55; i++) { const close = 10 + i * 0.08; bars.push({ close, high: close + 0.2, low: close - 0.2, timestamp: new Date(now - (55 - i) * 86400000).toISOString() }); }
  bars[54].high = 15; bars[54].close = 14.7; return bars;
}
test("ASX cost model applies tier-one minimum, GST and slippage", () => assert.deepEqual(estimateAsxSideCost(100), { commissionAud: 5, gstAud: 0.5, slippageAud: 0.1, totalAud: 5.6 }));
test("daily bars reject missing provenance, wrong currency and stale data", () => {
  const bars = makeBars();
  assert.equal(validateDailyBars(bars, { currency: "AUD", observedAt: new Date(now).toISOString(), now }).valid, false);
  assert.equal(validateDailyBars(bars, { source: "Test feed", currency: "USD", observedAt: new Date(now).toISOString(), now }).valid, false);
  assert.equal(validateDailyBars(bars, { source: "Test feed", currency: "AUD", observedAt: new Date(now - 6 * 86400000).toISOString(), now }).valid, false);
});
test("daily bars reject malformed OHLC and duplicate timestamps", () => {
  const bars = makeBars(); bars[2].low = bars[2].close + 1;
  assert.equal(validateDailyBars(bars, { source: "feed", currency: "AUD", observedAt: new Date(now).toISOString(), now }).valid, false);
  const duplicate = makeBars(); duplicate[1].timestamp = duplicate[0].timestamp;
  assert.equal(validateDailyBars(duplicate, { source: "feed", currency: "AUD", observedAt: new Date(now).toISOString(), now }).valid, false);
});
test("portfolio starts with $500 virtual cash and permanently disables live trading", () => {
  const portfolio = createPaperPortfolio(); assert.equal(portfolio.cashAud, 500); assert.equal(portfolio.mode, "PAPER_ONLY"); assert.equal(portfolio.liveTradingEnabled, false);
});
test("paper position cannot be opened from an unvalidated or executable candidate", () => {
  assert.equal(openPaperPosition(createPaperPortfolio(), { status: "PAPER_CANDIDATE", executable: true, simulatedOnly: true }).accepted, false);
});
test("paper portfolio preserves reserve and limits concurrent positions", () => {
  const portfolio = createPaperPortfolio();
  const candidate = { status: "PAPER_CANDIDATE", executable: false, simulatedOnly: true, symbol: "TEST", shares: 10, entryReference: 10, stopPrice: 9, targetPrice: 12, notionalAud: 100, estimatedEntryCostsAud: 5.6 };
  const result = openPaperPosition(portfolio, candidate, { id: "p1", openedAt: new Date(now).toISOString() });
  assert.equal(result.accepted, true); assert.equal(result.portfolio.cashAud, 394.4); assert.equal(result.portfolio.positions.length, 1); assert.equal(result.portfolio.liveTradingEnabled, false);
});

import test from "node:test";
import assert from "node:assert/strict";
import { createPaperPortfolio, estimateAsxSideCost, evaluateAsxSwingSetup, openPaperPosition, validateDailyBars } from "../autonomous-engine.js";
const now = Date.parse("2026-11-15T02:00:00Z");
function makeBars() {
  const bars = [];
  for (let i = 0; i < 55; i++) { const close = 10 + i * 0.08; bars.push({ open: close, close, high: close + 0.2, low: close - 0.2, timestamp: new Date(now - (55 - i) * 86400000).toISOString() }); }
  bars[54].high = 15; bars[54].close = 14.7; return bars;
}
test("ASX cost model applies tier-one minimum, GST and slippage", () => assert.deepEqual(estimateAsxSideCost(100), { commissionAud: 5, gstAud: 0.5, slippageAud: 0.1, totalAud: 5.6 }));
test("daily bars reject missing provenance, wrong currency and stale data", () => {
  const bars = makeBars();
  assert.equal(validateDailyBars(bars, { currency: "AUD", observedAt: new Date(now).toISOString(), now }).valid, false);
  assert.equal(validateDailyBars(bars, { source: "Test feed", currency: "USD", observedAt: new Date(now).toISOString(), now }).valid, false);
  assert.equal(validateDailyBars(bars, { source: "Test feed", currency: "AUD", observedAt: new Date(now - 2 * 86400000).toISOString(), now }).valid, false);
});
test("daily bars reject malformed OHLC and duplicate timestamps", () => {
  const bars = makeBars(); bars[2].low = bars[2].close + 1;
  assert.equal(validateDailyBars(bars, { source: "feed", currency: "AUD", observedAt: new Date(now).toISOString(), now }).valid, false);
  const duplicate = makeBars(); duplicate[1].timestamp = duplicate[0].timestamp;
  assert.equal(validateDailyBars(duplicate, { source: "feed", currency: "AUD", observedAt: new Date(now).toISOString(), now }).valid, false);
  const missingOpen = makeBars(); delete missingOpen[4].open;
  assert.equal(validateDailyBars(missingOpen, { source: "feed", currency: "AUD", observedAt: new Date(now).toISOString(), now }).valid, false);
  const invalidOpen = makeBars(); invalidOpen[4].open = invalidOpen[4].high + 1;
  assert.equal(validateDailyBars(invalidOpen, { source: "feed", currency: "AUD", observedAt: new Date(now).toISOString(), now }).valid, false);
});
test("portfolio starts with $500 virtual cash and permanently disables live trading", () => {
  const portfolio = createPaperPortfolio(); assert.equal(portfolio.cashAud, 500); assert.equal(portfolio.mode, "PAPER_ONLY"); assert.equal(portfolio.liveTradingEnabled, false);
});
test("paper position cannot be opened from an unvalidated or executable candidate", () => {
  assert.equal(openPaperPosition(createPaperPortfolio(), { status: "PAPER_CANDIDATE", executable: true, simulatedOnly: true }).accepted, false);
});
test("paper portfolio preserves reserve and limits concurrent positions", () => {
  const zeroCosts = { commissionRate: 0, minimumCommissionAud: 0, gstRate: 0, slippageBps: 0 };
  const makeCandidate = (symbol, cashAud, openPositions) => evaluateAsxSwingSetup({
    symbol, bars: makeBars(), source: "Synthetic test fixture only", currency: "AUD",
    observedAt: new Date(now).toISOString(), equityAud: 500, cashAud, openPositions, now, costs: zeroCosts
  });
  const portfolio = createPaperPortfolio();
  const candidate = makeCandidate("TEST", portfolio.cashAud, 0);
  assert.equal(candidate.status, "PAPER_CANDIDATE", candidate.reason);
  const first = openPaperPosition(portfolio, candidate, { id: "p1", openedAt: new Date(now).toISOString(), now });
  assert.equal(first.accepted, true, first.reason);
  assert.ok(first.portfolio.cashAud >= 100);
  assert.equal(first.portfolio.positions.length, 1);
  assert.equal(first.portfolio.liveTradingEnabled, false);

  const secondCandidate = makeCandidate("TEST2", first.portfolio.cashAud, 1);
  const second = openPaperPosition(first.portfolio, secondCandidate, { id: "p2", openedAt: new Date(now).toISOString(), now });
  assert.equal(second.accepted, true, second.reason);
  assert.equal(second.portfolio.positions.filter(position => position.status === "OPEN_PAPER").length, 2);
  assert.ok(second.portfolio.cashAud >= 100);

  const thirdCandidate = makeCandidate("TEST3", second.portfolio.cashAud, 0);
  const third = openPaperPosition(second.portfolio, thirdCandidate, { id: "p3", openedAt: new Date(now).toISOString(), now });
  assert.equal(third.accepted, false);
  assert.match(third.reason, /Position limit/);
});

import { updatePaperMarksFromBars } from "../autonomous-engine.js";

test("DataCedar daily bars update open paper marks without changing cash or realised history", () => {
  const portfolio = createPaperPortfolio();
  const openedAt = new Date(now - 86400000).toISOString();
  const bars = makeBars().map((bar, index) => ({ ...bar, timestamp: new Date(now - (55 - index) * 86400000).toISOString() }));
  const candidate = evaluateAsxSwingSetup({ symbol: "TEST", bars, source: "Test fixture", currency: "AUD", observedAt: new Date(now).toISOString(), now, costs: { commissionRate: 0, minimumCommissionAud: 0, gstRate: 0, slippageBps: 0 } });
  assert.equal(candidate.status, "PAPER_CANDIDATE");
  const opened = openPaperPosition(portfolio, candidate, { id: "mark-test", openedAt, now });
  assert.equal(opened.accepted, true, opened.reason);
  const cashBefore = opened.portfolio.cashAud;
  const realisedBefore = opened.portfolio.closedTrades.length;
  const markBars = { TEST: [{
    timestamp: new Date(now + 3600000).toISOString(),
    open: candidate.entryReference + 0.2, high: candidate.entryReference + 0.3,
    low: candidate.entryReference + 0.1, close: candidate.entryReference + 0.25
  }] };
  const result = updatePaperMarksFromBars(opened.portfolio, markBars, { now: now + 2 * 3600000 });
  assert.deepEqual(result.markedSymbols, ["TEST"]);
  assert.equal(result.portfolio.cashAud, cashBefore);
  assert.equal(result.portfolio.closedTrades.length, realisedBefore);
  assert.equal(result.portfolio.positions[0].lastMarkPrice, candidate.entryReference + 0.25);
  assert.equal(result.portfolio.liveTradingEnabled, false);
});

test("DataCedar mark refresh skips absent and older marks without altering ledger", () => {
  const portfolio = createPaperPortfolio();
  const result = updatePaperMarksFromBars(portfolio, { MISSING: [] });
  assert.deepEqual(result.markedSymbols, []);
  assert.equal(result.portfolio.cashAud, 500);
  assert.equal(result.accepted, true);
});

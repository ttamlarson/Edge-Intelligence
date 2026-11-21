import test from "node:test";
import assert from "node:assert/strict";
import { calculatePaperPortfolioEquity, closePaperPosition, createPaperPortfolio, estimateAsxSideCost, evaluateAsxSwingSetup, markPaperPosition, openPaperPosition, parseAsxDailyCsv, recordPaperMark, validateDailyBars } from "../autonomous-engine.js";
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
  const openedAt = new Date(now).toISOString();
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

test("daily-bar screening rejects stale or future bars even when source observation metadata is fresh", () => {
  const base = makeBars();
  const common = {
    symbol: "TEST", source: "Synthetic test fixture only", currency: "AUD",
    equityAud: 500, cashAud: 500, now, costs: { commissionRate: 0, minimumCommissionAud: 0, gstRate: 0, slippageBps: 0 }
  };

  const staleBars = base.map(bar => ({ ...bar, timestamp: new Date(Date.parse(bar.timestamp) - 2 * 86400000).toISOString() }));
  const stale = evaluateAsxSwingSetup({ ...common, bars: staleBars, observedAt: new Date(now).toISOString() });
  assert.equal(stale.status, "REJECTED");
  assert.match(stale.reason, /Latest daily bar is future-dated or stale/);

  const futureBars = base.map(bar => ({ ...bar }));
  futureBars.at(-1).timestamp = new Date(now + 60 * 60_000).toISOString();
  const future = evaluateAsxSwingSetup({ ...common, bars: futureBars, observedAt: new Date(now).toISOString() });
  assert.equal(future.status, "REJECTED");
  assert.match(future.reason, /Latest daily bar is future-dated or stale/);

  const lateBarBars = base.map(bar => ({ ...bar }));
  lateBarBars.at(-1).timestamp = new Date(now - 60 * 60_000).toISOString();
  const observationBeforeBar = validateDailyBars(lateBarBars, {
    source: common.source, currency: "AUD",
    observedAt: new Date(now - 2 * 60 * 60_000).toISOString(), now
  });
  assert.equal(observationBeforeBar.valid, false);
  assert.match(observationBeforeBar.reason, /later than the source observation/);
});

test("daily-bar screening rejects invalid freshness clock configuration", () => {
  const bars = makeBars();
  const options = { source: "Synthetic test fixture only", currency: "AUD", observedAt: new Date(now).toISOString(), now };
  assert.equal(validateDailyBars(bars, { ...options, now: Number.NaN }).valid, false);
  assert.equal(validateDailyBars(bars, { ...options, maxAgeMs: Number.NaN }).valid, false);
  assert.equal(validateDailyBars(bars, { ...options, maxAgeMs: -1 }).valid, false);
});


const noCosts = { commissionRate: 0, minimumCommissionAud: 0, gstRate: 0, slippageBps: 0 };

test("ASX CSV import requires AUD confirmation and handles BOM, quoted fields, Australian dates and multiple tickers", () => {
  const csv = [
    "\uFEFFSymbol,Date,Open,High,Low,Close,Adj Close,Volume",
    '"BHP","20/11/2026",10,11,9,10.5,10.4,1000',
    '"CBA","2026-11-20T16:10:00+08:00",100,102,99,101,100,500'
  ].join(String.fromCharCode(13, 10));
  assert.equal(parseAsxDailyCsv(csv).valid, false);
  assert.equal(parseAsxDailyCsv(csv, { currency: "USD" }).valid, false);
  const parsed = parseAsxDailyCsv(csv, { currency: "AUD" });
  assert.equal(parsed.valid, true, parsed.reason);
  assert.deepEqual(parsed.symbols, ["BHP", "CBA"]);
  assert.equal(parsed.rows, 2);
  assert.equal(parsed.barsBySymbol.BHP[0].timestamp, "2026-11-20T00:00:00.000Z");
  assert.equal(parsed.barsBySymbol.CBA[0].timestamp, "2026-11-20T08:10:00.000Z");
  assert.equal(parseAsxDailyCsv(csv.replace("Low,Close,Adj Close", "Low,Adj Close,Volume"), { currency: "AUD" }).valid, false);
  const malformed = ["Symbol,Date,Open,High,Low,Close", '"BHP,20/11/2026,10,11,9,10.5'].join(String.fromCharCode(10));
  assert.equal(parseAsxDailyCsv(malformed, { currency: "AUD" }).valid, false);
  const duplicate = ["Symbol,Date,Open,High,Low,Close", "BHP,20/11/2026,10,11,9,10.5", "BHP,2026-11-20,10,11,9,10.5"].join(String.fromCharCode(10));
  assert.equal(parseAsxDailyCsv(duplicate, { currency: "AUD" }).valid, false);
});

test("signal screening includes entry and stop-exit fees inside the 1% net-equity risk cap", () => {
  const common = {
    symbol: "TEST", bars: makeBars(), source: "Synthetic test fixture only", currency: "AUD",
    observedAt: new Date(now).toISOString(), equityAud: 500, cashAud: 500, now
  };
  const feeBearing = evaluateAsxSwingSetup(common);
  assert.equal(feeBearing.status, "REJECTED");
  assert.match(feeBearing.reason, /after estimated fees/);
  const noFeeCandidate = evaluateAsxSwingSetup({ ...common, costs: noCosts });
  assert.equal(noFeeCandidate.status, "PAPER_CANDIDATE", noFeeCandidate.reason);
  assert.ok(noFeeCandidate.estimatedNetStopLossAud <= noFeeCandidate.riskBudgetAud + 0.01);
  const largerAccount = evaluateAsxSwingSetup({ ...common, equityAud: 5000, costs: undefined });
  assert.equal(largerAccount.status, "REJECTED");
  assert.match(largerAccount.reason, /2:1 minimum/);
});

test("paper equity is net of estimated exit fees and opening risk is checked against current equity", () => {
  const costs = { commissionRate: 0.0008, minimumCommissionAud: 5, gstRate: 0.1, slippageBps: 10 };
  const position = {
    id: "equity-position", symbol: "BHP", shares: 10, entryPrice: 10, stopPrice: 9, targetPrice: 12,
    entryCostsAud: 5.6, debitAud: 105.6, openedAt: new Date(now).toISOString(),
    status: "OPEN_PAPER", costAssumptions: costs
  };
  const portfolio = { ...createPaperPortfolio(), cashAud: 394.4, positions: [position] };
  const expectedExitCost = estimateAsxSideCost(100, costs).totalAud;
  assert.equal(calculatePaperPortfolioEquity(portfolio), Math.round((394.4 + 100 - expectedExitCost) * 100) / 100);

  const candidate = evaluateAsxSwingSetup({
    symbol: "TEST", bars: makeBars(), source: "Synthetic test fixture only", currency: "AUD",
    observedAt: new Date(now).toISOString(), equityAud: 500, cashAud: 400, openPositions: 1, now, costs: noCosts
  });
  assert.equal(candidate.status, "PAPER_CANDIDATE", candidate.reason);
  const markedDownPosition = { ...position, costAssumptions: noCosts, lastMarkPrice: 5 };
  const reducedEquityPortfolio = { ...createPaperPortfolio(), cashAud: 400, positions: [markedDownPosition] };
  assert.equal(calculatePaperPortfolioEquity(reducedEquityPortfolio), 450);
  const rejected = openPaperPosition(reducedEquityPortfolio, candidate, { id: "over-risk", openedAt: new Date(now).toISOString(), now });
  assert.equal(rejected.accepted, false);
  assert.match(rejected.reason, /risk budget/);
});

test("ASX paper lifecycle preserves four-decimal prices, marks without cash movement, closes once and reconciles history", () => {
  const pennyBars = makeBars().map(bar => ({
    ...bar, open: bar.open / 100, high: bar.high / 100, low: bar.low / 100, close: bar.close / 100
  }));
  const candidate = evaluateAsxSwingSetup({
    symbol: "PENNY", bars: pennyBars, source: "Synthetic test fixture only", currency: "AUD",
    observedAt: new Date(now).toISOString(), equityAud: 500, cashAud: 500, now, costs: noCosts
  });
  assert.equal(candidate.status, "PAPER_CANDIDATE", candidate.reason);
  assert.equal(candidate.entryReference, 0.147);
  assert.equal(Number.isInteger(candidate.stopPrice * 10000), true);
  assert.equal(Number.isInteger(candidate.targetPrice * 10000), true);

  const opened = openPaperPosition(createPaperPortfolio(), candidate, {
    id: "penny-1", openedAt: new Date(now).toISOString(), now
  });
  assert.equal(opened.accepted, true, opened.reason);
  assert.equal(opened.position.costAssumptions.minimumCommissionAud, 0);
  const cashAfterOpen = opened.portfolio.cashAud;
  assert.equal(calculatePaperPortfolioEquity(opened.portfolio), 500);

  const markTime = now + 60 * 60_000;
  const marked = recordPaperMark(opened.portfolio, "penny-1", 0.1485, {
    markedAt: new Date(markTime).toISOString(), now: markTime
  });
  assert.equal(marked.accepted, true, marked.reason);
  assert.equal(marked.position.lastMarkPrice, 0.1485);
  assert.equal(marked.portfolio.cashAud, cashAfterOpen);
  assert.equal(marked.portfolio.closedTrades.length, 0);
  assert.equal(markPaperPosition(marked.position, 0.1485).markPrice, 0.1485);
  const olderMark = recordPaperMark(marked.portfolio, "penny-1", 0.148, {
    markedAt: new Date(markTime - 1000).toISOString(), now: markTime + 1000
  });
  assert.equal(olderMark.accepted, false);

  const closeTime = markTime + 60 * 60_000;
  const closed = closePaperPosition(marked.portfolio, "penny-1", 0.1495, {
    closedAt: new Date(closeTime).toISOString(), now: closeTime
  });
  assert.equal(closed.accepted, true, closed.reason);
  assert.equal(closed.trade.exitPrice, 0.1495);
  assert.equal(closed.trade.exitValueAud, Math.round(opened.position.shares * 0.1495 * 100) / 100);
  assert.equal(closed.trade.profitLossAud, Math.round((closed.trade.proceedsAud - opened.position.debitAud) * 100) / 100);
  assert.equal(closed.portfolio.cashAud, 500 + closed.trade.profitLossAud);
  assert.equal(closed.portfolio.closedTrades.length, 1);
  assert.equal(closed.portfolio.positions[0].status, "CLOSED_PAPER");
  assert.equal(calculatePaperPortfolioEquity(closed.portfolio), closed.portfolio.cashAud);
  assert.equal(closePaperPosition(closed.portfolio, "penny-1", 0.15, {
    closedAt: new Date(closeTime + 1000).toISOString(), now: closeTime + 1000
  }).accepted, false);

  const reopened = openPaperPosition(closed.portfolio, candidate, {
    id: "penny-2", openedAt: new Date(closeTime + 1000).toISOString(), now: closeTime + 1000
  });
  assert.equal(reopened.accepted, true, reopened.reason);
});

test("paper close reconciles entry and exit fees and records negative net proceeds without overdrawing cash", () => {
  const costs = { commissionRate: 0.0008, minimumCommissionAud: 5, gstRate: 0.1, slippageBps: 10 };
  const capital = 500;
  const entryValue = 100;
  const entryCost = estimateAsxSideCost(entryValue, costs);
  const position = {
    id: "fee-close", symbol: "TEST", shares: 10, entryPrice: 10, stopPrice: 9, targetPrice: 12,
    entryCostsAud: entryCost.totalAud, debitAud: entryValue + entryCost.totalAud,
    costAssumptions: costs, openedAt: new Date(now).toISOString(), status: "OPEN_PAPER"
  };
  const held = { ...createPaperPortfolio({ capitalAud: capital }), cashAud: capital - position.debitAud, positions: [position] };
  const closed = closePaperPosition(held, "fee-close", 12, {
    closedAt: new Date(now + 1000).toISOString(), now: now + 1000
  });
  const exitCost = estimateAsxSideCost(120, costs);
  assert.equal(closed.accepted, true, closed.reason);
  assert.equal(closed.trade.exitCostsAud, exitCost.totalAud);
  assert.equal(closed.trade.proceedsAud, Math.round((120 - exitCost.totalAud) * 100) / 100);
  assert.equal(closed.trade.profitLossAud, Math.round((closed.trade.proceedsAud - position.debitAud) * 100) / 100);
  assert.equal(closed.portfolio.cashAud, capital + closed.trade.profitLossAud);
  assert.equal(closed.portfolio.closedTrades.length, 1);

  const tinyCapital = 100;
  const tinyEntryValue = 0.01;
  const tinyEntryCost = estimateAsxSideCost(tinyEntryValue, costs);
  const tinyPosition = {
    id: "negative-proceeds", symbol: "MICRO", shares: 1, entryPrice: 0.01, stopPrice: 0.005, targetPrice: 0.02,
    entryCostsAud: tinyEntryCost.totalAud, debitAud: tinyEntryValue + tinyEntryCost.totalAud,
    costAssumptions: costs, openedAt: new Date(now).toISOString(), status: "OPEN_PAPER"
  };
  const tinyHeld = { ...createPaperPortfolio({ capitalAud: tinyCapital }), cashAud: tinyCapital - tinyPosition.debitAud, positions: [tinyPosition] };
  const tinyClosed = closePaperPosition(tinyHeld, "negative-proceeds", 0.01, {
    closedAt: new Date(now + 1000).toISOString(), now: now + 1000
  });
  assert.equal(tinyClosed.accepted, true, tinyClosed.reason);
  assert.ok(tinyClosed.trade.proceedsAud < 0);
  assert.ok(tinyClosed.portfolio.cashAud >= 0);
  assert.equal(tinyClosed.portfolio.closedTrades.length, 1);
  assert.equal(tinyClosed.portfolio.cashAud, tinyCapital + tinyClosed.trade.profitLossAud);
});

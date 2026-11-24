import test from "node:test";
import assert from "node:assert/strict";
import {
  createPaperPortfolio, calculatePaperPortfolioEquity, closePaperPosition, estimateAsxSideCost, evaluateAsxSwingSetup, markPaperPosition,
  openPaperPosition, parseAsxDailyCsv, recordPaperMark, updatePaperMarksFromBars
} from "../autonomous-engine.js";

const now = Date.parse("2026-11-16T00:30:00.000Z");
const zeroCostSchedule = { commissionRate: 0, minimumCommissionAud: 0, gstRate: 0, slippageBps: 0 };
const parseCsv = csv => parseAsxDailyCsv(csv, { currency: "AUD" });

function makeCsv(symbol, offset = 0) {
  const rows = ["Symbol,Date,Open,High,Low,Close"];
  for (let i = 0; i < 55; i++) {
    const close = i === 54 ? 14.7 + offset : 10 + i * 0.08 + offset;
    const open = i === 54 ? 14.3 + offset : close;
    const high = i === 54 ? 15 + offset : close + 0.2;
    const low = i === 54 ? 14.1 + offset : close - 0.2;
    const date = new Date(now - (55 - i) * 86_400_000).toISOString().slice(0, 10);
    rows.push([symbol, date, open, high, low, close].join(","));
  }
  return rows.join("\n");
}

function candidateFromCsv(csv, symbol) {
  const imported = parseCsv(csv);
  assert.equal(imported.valid, true, imported.reason);
  assert.deepEqual(imported.symbols, [symbol]);
  const bars = imported.barsBySymbol[symbol];
  const candidate = evaluateAsxSwingSetup({
    symbol, bars, source: "Synthetic test fixture only", currency: "AUD",
    observedAt: bars.at(-1).timestamp, equityAud: 500, cashAud: 500,
    openPositions: 0, now, costs: zeroCostSchedule
  });
  assert.equal(candidate.status, "PAPER_CANDIDATE", candidate.reason);
  return candidate;
}

test("CSV parser groups valid daily bars by ticker", () => {
  const result = parseCsv("Symbol,Date,Open,High,Low,Close\nBHP,2026-11-12,40,41,39,40.5\nCBA,2026-11-12,170,172,169,171");
  assert.equal(result.valid, true);
  assert.deepEqual(result.symbols, ["BHP", "CBA"]);
  assert.equal(result.rows, 2);
});

test("CSV parser rejects malformed OHLC, duplicate sessions and impossible ISO dates", () => {
  assert.equal(parseCsv("Symbol,Date,Open,High,Low,Close\nBHP,2026-11-12,40,39,39,40").valid, false);
  assert.equal(parseCsv("Symbol,Date,Open,High,Low,Close\nBHP,2026-11-12,42,41,39,40").valid, false);
  assert.equal(parseCsv("Symbol,Date,Open,High,Low,Close\nBHP,2026-11-12,40,41,39,40\nBHP,2026-11-12,40,41,39,40").valid, false);
  assert.equal(parseCsv("Symbol,Date,Open,High,Low,Close\nBHP,2026-02-31,40,41,39,40").valid, false);
});


test("CSV import requires explicit AUD confirmation and rejects adjusted-close-only data", () => {
  const csv = "Symbol,Date,Open,High,Low,Close\nBHP,2026-11-12,40,41,39,40.5";
  assert.equal(parseAsxDailyCsv(csv).valid, false);
  assert.match(parseAsxDailyCsv(csv).reason, /explicitly confirmed as AUD/);
  assert.equal(parseAsxDailyCsv(csv, { currency: "USD" }).valid, false);
  assert.equal(parseAsxDailyCsv(csv, { currency: "AUD" }).valid, true);
  const adjusted = "Symbol,Date,Open,High,Low,Adj Close\nBHP,2026-11-12,40,41,39,40.5";
  assert.match(parseCsv(adjusted).reason, /Required columns/);
});

test("CSV parser rejects malformed quotes and supports correctly quoted fields", () => {
  const malformed = 'Symbol,Date,Open,High,Low,Close\nBHP"oops,2026-11-12,40,41,39,40';
  assert.equal(parseCsv(malformed).valid, false);
  assert.match(parseCsv(malformed).reason, /malformed quoting/);
  const quoted = '"Symbol","Date","Open","High","Low","Close"\n"BHP","2026-11-12","40","41","39","40.5"';
  assert.equal(parseCsv(quoted).valid, true);
});

test("CSV parser strips a UTF-8 BOM and interprets Australian DD/MM/YYYY dates", () => {
  const csv = "\uFEFFSymbol,Date,Open,High,Low,Close\nBHP,12/11/2026,40,41,39,40.5\nCBA,13/11/2026,170,172,169,171";
  const result = parseCsv(csv);
  assert.equal(result.valid, true, result.reason);
  assert.equal(result.barsBySymbol.BHP[0].timestamp, "2026-11-12T00:00:00.000Z");
  assert.equal(result.barsBySymbol.CBA[0].timestamp, "2026-11-13T00:00:00.000Z");
});

test("CSV parser rejects impossible Australian dates and timezone-less timestamps", () => {
  assert.equal(parseCsv("Symbol,Date,Open,High,Low,Close\nBHP,31/02/2026,40,41,39,40").valid, false);
  assert.equal(parseCsv("Symbol,Date,Open,High,Low,Close\nBHP,2026-11-12T00:00:00,40,41,39,40").valid, false);
  const explicitZone = parseCsv("Symbol,Date,Open,High,Low,Close\nBHP,2026-11-12T00:00:00+08:00,40,41,39,40");
  assert.equal(explicitZone.valid, true, explicitZone.reason);
  assert.equal(explicitZone.barsBySymbol.BHP[0].timestamp, "2026-11-11T16:00:00.000Z");
});


test("signal screening rejects a ticker that does not close above the prior 20-session breakout", () => {
  const imported = parseCsv(makeCsv("BHP"));
  const bars = imported.barsBySymbol.BHP.map(bar => ({ ...bar }));
  Object.assign(bars.at(-1), { open: 14.1, high: 14.3, low: 14.0, close: 14.2 });
  const result = evaluateAsxSwingSetup({
    symbol: "BHP", bars, source: "Synthetic test fixture only", currency: "AUD",
    observedAt: bars.at(-1).timestamp, equityAud: 500, cashAud: 500, now, costs: zeroCostSchedule
  });
  assert.equal(result.status, "NO_SIGNAL");
  assert.equal(result.executable, false);
  assert.equal(result.simulatedOnly, true);
});

test("default cost assumptions reject this synthetic setup at the after-cost 2:1 gate", () => {
  const imported = parseCsv(makeCsv("BHP"));
  const bars = imported.barsBySymbol.BHP;
  const result = evaluateAsxSwingSetup({
    symbol: "BHP", bars, source: "Synthetic test fixture only", currency: "AUD",
    observedAt: bars.at(-1).timestamp, equityAud: 5000, cashAud: 500, now
  });
  assert.equal(result.status, "REJECTED");
  assert.match(result.reason, /2:1 minimum/);
});

test("paper lifecycle imports, screens, opens, marks, closes with stored cost assumptions and permits re-entry", () => {
  const bhp = candidateFromCsv(makeCsv("BHP"), "BHP");
  const cba = candidateFromCsv(makeCsv("CBA", 2), "CBA");
  const initial = createPaperPortfolio();
  const first = openPaperPosition(initial, bhp, { id: "bhp-1", openedAt: new Date(now).toISOString(), now });
  assert.equal(first.accepted, true, first.reason);
  assert.equal(first.portfolio.cashAud, 426.5);
  const second = openPaperPosition(first.portfolio, cba, { id: "cba-1", openedAt: new Date(now).toISOString(), now });
  assert.equal(second.accepted, true, second.reason);
  assert.equal(second.portfolio.positions.filter(p => p.status === "OPEN_PAPER").length, 2);
  assert.equal(second.portfolio.cashAud, 343);
  assert.ok(second.portfolio.cashAud >= 100);

  const mark = markPaperPosition(first.position, 15);
  assert.equal(mark.markPrice, 15);
  assert.equal(mark.estimatedExitCostsAud, 0);
  assert.equal(mark.unrealizedProfitLossAud, 1.5);
  assert.equal(first.position.lastMarkPrice, undefined);

  const closedBhp = closePaperPosition(second.portfolio, "bhp-1", 15, { closedAt: new Date(now + 60_000).toISOString() });
  assert.equal(closedBhp.accepted, true);
  assert.equal(closedBhp.trade.exitCostsAud, 0);
  assert.equal(closedBhp.trade.proceedsAud, 75);
  assert.equal(closedBhp.trade.profitLossAud, 1.5);
  assert.equal(closedBhp.portfolio.cashAud, 418);

  const closedCba = closePaperPosition(closedBhp.portfolio, "cba-1", 17, { closedAt: new Date(now + 120_000).toISOString() });
  assert.equal(closedCba.accepted, true);
  assert.equal(closedCba.trade.exitCostsAud, 0);
  assert.equal(closedCba.trade.proceedsAud, 85);
  assert.equal(closedCba.trade.profitLossAud, 1.5);
  assert.equal(closedCba.portfolio.cashAud, 503);
  assert.equal(closedCba.portfolio.closedTrades.length, 2);
  assert.deepEqual(closedCba.portfolio.closedTrades.map(t => t.id), ["bhp-1", "cba-1"]);

  // Closed history remains in positions; it must not consume the concurrent-open-position limit.
  const reopened = openPaperPosition(closedCba.portfolio, bhp, { id: "bhp-2", openedAt: new Date(now + 180_000).toISOString(), now: now + 180_000 });
  assert.equal(reopened.accepted, true, reopened.reason);
  assert.equal(reopened.portfolio.positions.filter(p => p.status === "OPEN_PAPER").length, 1);
  assert.equal(reopened.portfolio.closedTrades.length, 2);
  assert.equal(reopened.portfolio.cashAud, 429.5);
  assert.equal(reopened.portfolio.liveTradingEnabled, false);
});

test("paper opening rejects malformed candidate sizing without changing cash", () => {
  const portfolio = createPaperPortfolio();
  const malformed = {
    status: "PAPER_CANDIDATE", executable: false, simulatedOnly: true,
    symbol: "BHP", source: "Synthetic test fixture only", currency: "AUD",
    observedAt: new Date(now).toISOString(), shares: -1, entryReference: 10,
    stopPrice: 9, targetPrice: 12, notionalAud: 10, estimatedEntryCostsAud: 0
  };
  const result = openPaperPosition(portfolio, malformed, { id: "bad-1", now });
  assert.equal(result.accepted, false);
  assert.equal(portfolio.cashAud, 500);
  assert.equal(portfolio.positions.length, 0);
});


test("opening rechecks the AUD 200 allocation cap including entry fees", () => {
  const base = candidateFromCsv(makeCsv("BHP"), "BHP");
  const costs = { commissionRate: 0, minimumCommissionAud: 0.01, gstRate: 0, slippageBps: 0 };
  const shares = 13, entryReference = 15.3846, stopPrice = 15.01, targetPrice = 16.5;
  const notionalAud = shares * entryReference;
  const entryCost = estimateAsxSideCost(notionalAud, costs);
  const stopCost = estimateAsxSideCost(shares * stopPrice, costs);
  const targetCost = estimateAsxSideCost(shares * targetPrice, costs);
  const netTarget = shares * targetPrice - notionalAud - entryCost.totalAud - targetCost.totalAud;
  const netStop = notionalAud - shares * stopPrice + entryCost.totalAud + stopCost.totalAud;
  const candidate = {
    ...base, shares, entryReference, stopPrice, targetPrice, notionalAud,
    riskBudgetAud: 5, estimatedEntryCostsAud: entryCost.totalAud,
    estimatedNetTargetProfitAud: netTarget, estimatedNetStopLossAud: netStop,
    rewardRiskAfterCosts: netTarget / netStop,
    assumptions: { commissionRate: costs.commissionRate, commissionMinimumAud: costs.minimumCommissionAud, gstRate: costs.gstRate, slippageBps: costs.slippageBps }
  };
  const result = openPaperPosition(createPaperPortfolio(), candidate, { id: "entry-fees-over-cap", openedAt: new Date(now).toISOString(), now });
  assert.equal(result.accepted, false);
  assert.match(result.reason, /AUD 200 paper allocation cap/);
});

test("paper portfolio rejects stale candidate data at the time of opening", () => {
  const candidate = candidateFromCsv(makeCsv("BHP"), "BHP");
  const result = openPaperPosition(createPaperPortfolio(), candidate, {
    id: "stale-1", now: now + 2 * 86_400_000
  });
  assert.equal(result.accepted, false);
  assert.match(result.reason, /provenance or freshness/);
});

test("paper opening rejects backdated and future-dated opening timestamps", () => {
  const candidate = candidateFromCsv(makeCsv("BHP"), "BHP");
  const portfolio = createPaperPortfolio();
  const backdated = openPaperPosition(portfolio, candidate, {
    id: "backdated-open", openedAt: new Date(now - 2 * 86_400_000).toISOString(), now
  });
  assert.equal(backdated.accepted, false);
  assert.match(backdated.reason, /Opening timestamp/);

  const future = openPaperPosition(portfolio, candidate, {
    id: "future-open", openedAt: new Date(now + 10 * 60_000).toISOString(), now
  });
  assert.equal(future.accepted, false);
  assert.match(future.reason, /Opening timestamp/);
  assert.equal(portfolio.cashAud, 500);
  assert.equal(portfolio.positions.length, 0);
});


test("marking rejects corrupt position quantities and accounting values", () => {
  const valid = { id: "mark-1", status: "OPEN_PAPER", shares: 2, debitAud: 20 };
  assert.equal(markPaperPosition({ ...valid, shares: 0 }, 12), null);
  assert.equal(markPaperPosition({ ...valid, debitAud: Number.NaN }, 12), null);
  assert.equal(markPaperPosition({ ...valid, shares: 1.5 }, 12), null);
});

test("closing fails safely for malformed portfolio history and invalid chronology", () => {
  const candidate = candidateFromCsv(makeCsv("BHP"), "BHP");
  const openedAt = new Date(now).toISOString();
  const opened = openPaperPosition(createPaperPortfolio(), candidate, { id: "close-guard-1", openedAt, now });
  assert.equal(opened.accepted, true);
  const missingHistory = { ...opened.portfolio, closedTrades: undefined };
  const invalidHistory = closePaperPosition(missingHistory, "close-guard-1", 15, { closedAt: new Date(now + 60_000).toISOString() });
  assert.equal(invalidHistory.accepted, false);
  assert.match(invalidHistory.reason, /trade history/);
  assert.equal(opened.portfolio.cashAud, 426.5);

  const backwardsTime = closePaperPosition(opened.portfolio, "close-guard-1", 15, { closedAt: new Date(now - 1).toISOString() });
  assert.equal(backwardsTime.accepted, false);
  assert.match(backwardsTime.reason, /timestamp/);
  assert.equal(opened.portfolio.positions[0].status, "OPEN_PAPER");
  assert.equal(opened.portfolio.closedTrades.length, 0);
});


test("paper opening revalidates risk budget and fee assumptions against candidate values", () => {
  const candidate = candidateFromCsv(makeCsv("BHP"), "BHP");
  const portfolio = createPaperPortfolio();
  const excessiveRisk = {
    ...candidate,
    shares: 10,
    notionalAud: 147,
    estimatedEntryCostsAud: 0,
    estimatedNetTargetProfitAud: 0,
    estimatedNetStopLossAud: 0,
    rewardRiskAfterCosts: 0
  };
  const riskResult = openPaperPosition(portfolio, excessiveRisk, { id: "risk-bypass", openedAt: new Date(now).toISOString(), now });
  assert.equal(riskResult.accepted, false);
  assert.match(riskResult.reason, /risk budget/);

  const alteredFees = {
    ...candidate,
    assumptions: { ...candidate.assumptions, commissionRate: 0.0008 }
  };
  const feeResult = openPaperPosition(portfolio, alteredFees, { id: "fee-bypass", openedAt: new Date(now).toISOString(), now });
  assert.equal(feeResult.accepted, false);
  assert.match(feeResult.reason, /entry costs/);
  assert.equal(portfolio.cashAud, 500);
  assert.equal(portfolio.positions.length, 0);
});

test("saving a paper mark persists the latest valuation without changing cash or trade history", () => {
  const candidate = candidateFromCsv(makeCsv("BHP"), "BHP");
  const openedAt = new Date(now).toISOString();
  const opened = openPaperPosition(createPaperPortfolio(), candidate, { id: "mark-persist-1", openedAt, now });
  assert.equal(opened.accepted, true, opened.reason);
  const cashBeforeMark = opened.portfolio.cashAud;
  const historyBeforeMark = opened.portfolio.closedTrades;

  const firstMark = recordPaperMark(opened.portfolio, "mark-persist-1", 15, {
    markedAt: new Date(now + 60_000).toISOString(),
    costs: zeroCostSchedule
  });
  assert.equal(firstMark.accepted, true, firstMark.reason);
  assert.equal(firstMark.position.lastMarkPrice, 15);
  assert.equal(firstMark.position.lastMarkedAt, new Date(now + 60_000).toISOString());
  assert.equal(firstMark.mark.unrealizedProfitLossAud, 1.5);
  assert.equal(firstMark.portfolio.cashAud, cashBeforeMark);
  assert.equal(firstMark.portfolio.closedTrades, historyBeforeMark);
  assert.equal(opened.portfolio.positions[0].lastMarkPrice, undefined);

  const secondMark = recordPaperMark(firstMark.portfolio, "mark-persist-1", 15.25, {
    markedAt: new Date(now + 120_000).toISOString(),
    costs: zeroCostSchedule
  });
  assert.equal(secondMark.accepted, true, secondMark.reason);
  assert.equal(secondMark.position.lastMarkPrice, 15.25);
  assert.equal(secondMark.portfolio.cashAud, cashBeforeMark);
  assert.equal(secondMark.portfolio.closedTrades.length, 0);

  const outOfOrder = recordPaperMark(secondMark.portfolio, "mark-persist-1", 14, {
    markedAt: new Date(now + 90_000).toISOString(),
    costs: zeroCostSchedule
  });
  assert.equal(outOfOrder.accepted, false);
  assert.match(outOfOrder.reason, /earlier than the previous mark/);
  assert.equal(secondMark.portfolio.positions[0].lastMarkPrice, 15.25);
});

test("paper marks and closed history retain the exact fee assumptions and component breakdowns", () => {
  const candidate = candidateFromCsv(makeCsv("BHP"), "BHP");
  const opened = openPaperPosition(createPaperPortfolio(), candidate, {
    id: "fee-audit-1", openedAt: new Date(now).toISOString(), now
  });
  assert.equal(opened.accepted, true, opened.reason);
  assert.deepEqual(opened.position.entryCostBreakdown, {
    commissionAud: 0, gstAud: 0, slippageAud: 0, totalAud: 0
  });

  const markCosts = { commissionRate: 0, minimumCommissionAud: 1, gstRate: 0, slippageBps: 0 };
  const marked = recordPaperMark(opened.portfolio, "fee-audit-1", 15, {
    markedAt: new Date(now + 60_000).toISOString(), costs: markCosts
  });
  assert.equal(marked.accepted, true, marked.reason);
  assert.deepEqual(marked.position.lastMarkCostAssumptions, markCosts);
  assert.equal(markPaperPosition(marked.position, 15).estimatedExitCostsAud, 1);
  const mark = markPaperPosition(marked.position, 15);
  assert.equal(calculatePaperPortfolioEquity(marked.portfolio),
    Math.round((marked.portfolio.cashAud + mark.marketValueAud - mark.estimatedExitCostsAud) * 100) / 100);

  const exitCosts = { commissionRate: 0, minimumCommissionAud: 2, gstRate: 0.1, slippageBps: 0 };
  const closed = closePaperPosition(marked.portfolio, "fee-audit-1", 15, {
    closedAt: new Date(now + 120_000).toISOString(), costs: exitCosts
  });
  assert.equal(closed.accepted, true, closed.reason);
  assert.deepEqual(closed.trade.exitCostAssumptions, exitCosts);
  assert.deepEqual(closed.trade.exitCostBreakdown, {
    commissionAud: 2, gstAud: 0.2, slippageAud: 0, totalAud: 2.2
  });
  assert.equal(closed.trade.exitCostsAud, 2.2);
  assert.equal(closed.trade.proceedsAud, 72.8);
  assert.equal(closed.trade.profitLossAud, -0.7);
  assert.equal(closed.portfolio.cashAud, 499.3);
  assert.equal(closed.portfolio.closedTrades[0].id, "fee-audit-1");
});


test("provider mark refresh ignores malformed and future bars and chooses the latest eligible OHLC bar", () => {
  const candidate = candidateFromCsv(makeCsv("BHP"), "BHP");
  const opened = openPaperPosition(createPaperPortfolio(), candidate, {
    id: "provider-mark-guard", openedAt: new Date(now).toISOString(), now
  });
  assert.equal(opened.accepted, true, opened.reason);
  const valid = { timestamp: new Date(now + 60_000).toISOString(), open: 15, high: 15.5, low: 14.9, close: 15.25 };
  const refreshed = updatePaperMarksFromBars(opened.portfolio, {
    BHP: [{ timestamp: "not-a-date", open: 15, high: 16, low: 14, close: 15 }, valid]
  }, { now: now + 120_000 });
  assert.deepEqual(refreshed.markedSymbols, ["BHP"]);
  assert.equal(refreshed.portfolio.positions[0].lastMarkPrice, 15.25);
  assert.equal(refreshed.portfolio.cashAud, opened.portfolio.cashAud);

  const future = updatePaperMarksFromBars(opened.portfolio, {
    BHP: [{ ...valid, timestamp: new Date(now + 60 * 60_000).toISOString() }]
  }, { now });
  assert.deepEqual(future.markedSymbols, []);
  assert.deepEqual(future.skippedSymbols, ["BHP"]);
  assert.equal(future.portfolio.positions[0].lastMarkPrice, undefined);
  assert.equal(updatePaperMarksFromBars(opened.portfolio, { BHP: [valid] }, { currency: "USD", now }).accepted, false);
});

test("manual paper marks reject future timestamps without mutating the ledger", () => {
  const candidate = candidateFromCsv(makeCsv("BHP"), "BHP");
  const opened = openPaperPosition(createPaperPortfolio(), candidate, {
    id: "future-manual-mark", openedAt: new Date(now).toISOString(), now
  });
  const result = recordPaperMark(opened.portfolio, "future-manual-mark", 15, {
    markedAt: new Date(now + 10 * 60_000).toISOString(), now, costs: zeroCostSchedule
  });
  assert.equal(result.accepted, false);
  assert.match(result.reason, /future-dated/);
  assert.equal(opened.portfolio.positions[0].lastMarkPrice, undefined);
});

test("paper marking rejects closed positions and invalid prices without changing the portfolio", () => {
  const candidate = candidateFromCsv(makeCsv("BHP"), "BHP");
  const opened = openPaperPosition(createPaperPortfolio(), candidate, {
    id: "mark-invalid-1", openedAt: new Date(now).toISOString(), now
  });
  const invalidPrice = recordPaperMark(opened.portfolio, "mark-invalid-1", 0, {
    markedAt: new Date(now + 60_000).toISOString()
  });
  assert.equal(invalidPrice.accepted, false);
  assert.equal(opened.portfolio.positions[0].lastMarkPrice, undefined);
  const closed = closePaperPosition(opened.portfolio, "mark-invalid-1", 15, {
    closedAt: new Date(now + 60_000).toISOString()
  });
  assert.equal(closed.accepted, true);
  const closedMark = recordPaperMark(closed.portfolio, "mark-invalid-1", 16, {
    markedAt: new Date(now + 120_000).toISOString()
  });
  assert.equal(closedMark.accepted, false);
  assert.match(closedMark.reason, /not found/);
  assert.equal(closed.portfolio.closedTrades.length, 1);
});


test("a paper close records net-negative proceeds when minimum fees exceed exit value", () => {
  const candidate = candidateFromCsv(makeCsv("BHP"), "BHP");
  const opened = openPaperPosition(createPaperPortfolio(), candidate, {
    id: "negative-proceeds-close", openedAt: new Date(now).toISOString(), now
  });
  const closed = closePaperPosition(opened.portfolio, "negative-proceeds-close", 0.001, {
    closedAt: new Date(now + 60_000).toISOString(),
    costs: { commissionRate: 0.0008, minimumCommissionAud: 5, gstRate: 0.1, slippageBps: 10 }
  });
  assert.equal(closed.accepted, true, closed.reason);
  assert.ok(closed.trade.exitCostsAud > closed.trade.exitValueAud);
  assert.ok(closed.trade.proceedsAud < 0);
  assert.equal(closed.portfolio.cashAud, Math.round((opened.portfolio.cashAud + closed.trade.proceedsAud) * 100) / 100);
  assert.ok(closed.portfolio.cashAud >= 0);
  assert.equal(closed.portfolio.closedTrades.length, 1);
  assert.equal(closed.portfolio.closedTrades[0].id, "negative-proceeds-close");
  const duplicateClose = closePaperPosition(closed.portfolio, "negative-proceeds-close", 15, {
    closedAt: new Date(now + 120_000).toISOString()
  });
  assert.equal(duplicateClose.accepted, false);
  assert.equal(closed.portfolio.closedTrades.length, 1);
});

test("closing cannot predate a previously saved manual paper mark", () => {
  const candidate = candidateFromCsv(makeCsv("BHP"), "BHP");
  const opened = openPaperPosition(createPaperPortfolio(), candidate, {
    id: "mark-close-order-1", openedAt: new Date(now).toISOString(), now
  });
  assert.equal(opened.accepted, true, opened.reason);
  const marked = recordPaperMark(opened.portfolio, "mark-close-order-1", 15, {
    markedAt: new Date(now + 60_000).toISOString(),
    costs: zeroCostSchedule
  });
  assert.equal(marked.accepted, true, marked.reason);

  const earlierClose = closePaperPosition(marked.portfolio, "mark-close-order-1", 15.5, {
    closedAt: new Date(now + 30_000).toISOString()
  });
  assert.equal(earlierClose.accepted, false);
  assert.match(earlierClose.reason, /precedes the latest mark/);
  assert.equal(marked.portfolio.positions[0].status, "OPEN_PAPER");
  assert.equal(marked.portfolio.closedTrades.length, 0);

  const laterClose = closePaperPosition(marked.portfolio, "mark-close-order-1", 15.5, {
    closedAt: new Date(now + 120_000).toISOString()
  });
  assert.equal(laterClose.accepted, true, laterClose.reason);
  assert.equal(laterClose.trade.closedAt, new Date(now + 120_000).toISOString());
  assert.equal(laterClose.portfolio.closedTrades.length, 1);
});

test("CSV parser rejects rows with missing or unlabelled extra columns", () => {
  const headerWithVolume = "Symbol,Date,Open,High,Low,Close,Volume";
  const missingOptionalValue = headerWithVolume + "\nBHP,2026-11-12,40,41,39,40.5";
  const extraUnlabelledValue = "Symbol,Date,Open,High,Low,Close\nBHP,2026-11-12,40,41,39,40.5,999999";
  assert.equal(parseCsv(missingOptionalValue).valid, false);
  assert.match(parseCsv(missingOptionalValue).reason, /column count/);
  assert.equal(parseCsv(extraUnlabelledValue).valid, false);
  assert.match(parseCsv(extraUnlabelledValue).reason, /column count/);
  assert.equal(parseCsv("Symbol,Date,Open,High,Low,Close,\nBHP,2026-11-12,40,41,39,40.5,").valid, false);
  assert.match(parseCsv("Symbol,Date,Open,High,Low,Close,\nBHP,2026-11-12,40,41,39,40.5,").reason, /empty or duplicate header/);
  assert.equal(parseCsv("Symbol,Date,Open,High,Low,Close,Close\nBHP,2026-11-12,40,41,39,40.5,40.5").valid, false);
});


test("CSV parser rejects multiple aliases for the same required field", () => {
  const symbolAliases = parseCsv("Symbol,Ticker,Date,Open,High,Low,Close\nBHP,CSL,2026-11-12,40,41,39,40");
  assert.equal(symbolAliases.valid, false);
  assert.match(symbolAliases.reason, /duplicate or ambiguous required columns/);

  const dateAliases = parseCsv("Symbol,Date,Timestamp,Open,High,Low,Close\nBHP,2026-11-12,2026-11-12,40,41,39,40");
  assert.equal(dateAliases.valid, false);
  assert.match(dateAliases.reason, /duplicate or ambiguous required columns/);
});

test("CSV parser rejects one trading session represented by different timezone encodings", () => {
  const csv = [
    "Symbol,Date,Open,High,Low,Close",
    "BHP,2026-11-12,40,41,39,40",
    "BHP,2026-11-12T00:00:00+08:00,40,41,39,40"
  ].join("\n");
  const result = parseCsv(csv);
  assert.equal(result.valid, false);
  assert.match(result.reason, /Duplicate daily bar/);
});

test("signal screening rejects a breakout when the 20-day average is below the 50-day average", () => {
  const imported = parseCsv(makeCsv("BHP"));
  const bars = imported.barsBySymbol.BHP.map((bar, index) => {
    const close = index < 35 ? 20 : 10;
    return { ...bar, open: close, high: close + 0.2, low: close - 0.2, close };
  });
  Object.assign(bars.at(-1), { open: 24.5, high: 25.2, low: 24.4, close: 25 });
  const result = evaluateAsxSwingSetup({
    symbol: "BHP", bars, source: "Synthetic test fixture only", currency: "AUD",
    observedAt: bars.at(-1).timestamp, equityAud: 500, cashAud: 500, now, costs: zeroCostSchedule
  });
  assert.equal(result.status, "NO_SIGNAL");
  assert.match(result.reason, /trend and 20-session breakout/);
});

test("paper opening rejects a duplicate open symbol without changing cash or history", () => {
  const candidate = candidateFromCsv(makeCsv("BHP"), "BHP");
  const opened = openPaperPosition(createPaperPortfolio(), candidate, {
    id: "duplicate-symbol-1", openedAt: new Date(now).toISOString(), now
  });
  assert.equal(opened.accepted, true, opened.reason);
  const duplicate = openPaperPosition(opened.portfolio, candidate, {
    id: "duplicate-symbol-2", openedAt: new Date(now + 60_000).toISOString(), now: now + 60_000
  });
  assert.equal(duplicate.accepted, false);
  assert.match(duplicate.reason, /duplicate open symbol/);
  assert.equal(opened.portfolio.cashAud, 500 - opened.position.debitAud);
  assert.equal(opened.portfolio.positions.length, 1);
  assert.equal(opened.portfolio.closedTrades.length, 0);
});

test("rounded fee components reconcile exactly to the recorded total", () => {
  const costs = { commissionRate: 0.0008, minimumCommissionAud: 0, gstRate: 0.1, slippageBps: 10 };
  const fee = estimateAsxSideCost(6.25, costs);
  assert.deepEqual(fee, { commissionAud: 0.01, gstAud: 0, slippageAud: 0.01, totalAud: 0.02 });
  assert.equal(fee.totalAud, fee.commissionAud + fee.gstAud + fee.slippageAud);
});

test("closing defaults to the latest mark fee assumptions unless explicitly overridden", () => {
  const candidate = candidateFromCsv(makeCsv("BHP"), "BHP");
  const opened = openPaperPosition(createPaperPortfolio(), candidate, {
    id: "latest-mark-fees-1", openedAt: new Date(now).toISOString(), now
  });
  assert.equal(opened.accepted, true, opened.reason);
  const markCosts = { commissionRate: 0, minimumCommissionAud: 1, gstRate: 0, slippageBps: 0 };
  const marked = recordPaperMark(opened.portfolio, "latest-mark-fees-1", 15, {
    markedAt: new Date(now + 60_000).toISOString(), costs: markCosts, now: now + 60_000
  });
  assert.equal(marked.accepted, true, marked.reason);
  const closed = closePaperPosition(marked.portfolio, "latest-mark-fees-1", 15, {
    closedAt: new Date(now + 120_000).toISOString(), now: now + 120_000
  });
  assert.equal(closed.accepted, true, closed.reason);
  assert.deepEqual(closed.trade.exitCostAssumptions, markCosts);
  assert.equal(closed.trade.exitCostsAud, 1);
  assert.equal(closed.trade.proceedsAud, Math.round((opened.position.shares * 15 - 1) * 100) / 100);
  assert.equal(closed.portfolio.cashAud, Math.round((500 + closed.trade.profitLossAud) * 100) / 100);
});

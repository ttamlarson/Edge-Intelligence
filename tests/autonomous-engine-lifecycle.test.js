import test from "node:test";
import assert from "node:assert/strict";
import {
  createPaperPortfolio, closePaperPosition, evaluateAsxSwingSetup, markPaperPosition,
  openPaperPosition, parseAsxDailyCsv, recordPaperMark
} from "../autonomous-engine.js";

const now = Date.parse("2026-11-16T00:30:00.000Z");
const zeroCostSchedule = { commissionRate: 0, minimumCommissionAud: 0, gstRate: 0, slippageBps: 0 };

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
  const imported = parseAsxDailyCsv(csv);
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
  const result = parseAsxDailyCsv("Symbol,Date,Open,High,Low,Close\nBHP,2026-11-12,40,41,39,40.5\nCBA,2026-11-12,170,172,169,171");
  assert.equal(result.valid, true);
  assert.deepEqual(result.symbols, ["BHP", "CBA"]);
  assert.equal(result.rows, 2);
});

test("CSV parser rejects malformed OHLC, duplicate sessions and impossible ISO dates", () => {
  assert.equal(parseAsxDailyCsv("Symbol,Date,Open,High,Low,Close\nBHP,2026-11-12,40,39,39,40").valid, false);
  assert.equal(parseAsxDailyCsv("Symbol,Date,Open,High,Low,Close\nBHP,2026-11-12,40,41,39,40\nBHP,2026-11-12,40,41,39,40").valid, false);
  assert.equal(parseAsxDailyCsv("Symbol,Date,Open,High,Low,Close\nBHP,2026-02-31,40,41,39,40").valid, false);
});

test("CSV parser strips a UTF-8 BOM and interprets Australian DD/MM/YYYY dates", () => {
  const csv = "\uFEFFSymbol,Date,Open,High,Low,Close\nBHP,12/11/2026,40,41,39,40.5\nCBA,13/11/2026,170,172,169,171";
  const result = parseAsxDailyCsv(csv);
  assert.equal(result.valid, true, result.reason);
  assert.equal(result.barsBySymbol.BHP[0].timestamp, "2026-11-12T00:00:00.000Z");
  assert.equal(result.barsBySymbol.CBA[0].timestamp, "2026-11-13T00:00:00.000Z");
});

test("CSV parser rejects impossible Australian dates and timezone-less timestamps", () => {
  assert.equal(parseAsxDailyCsv("Symbol,Date,Open,High,Low,Close\nBHP,31/02/2026,40,41,39,40").valid, false);
  assert.equal(parseAsxDailyCsv("Symbol,Date,Open,High,Low,Close\nBHP,2026-11-12T00:00:00,40,41,39,40").valid, false);
  const explicitZone = parseAsxDailyCsv("Symbol,Date,Open,High,Low,Close\nBHP,2026-11-12T00:00:00+08:00,40,41,39,40");
  assert.equal(explicitZone.valid, true, explicitZone.reason);
  assert.equal(explicitZone.barsBySymbol.BHP[0].timestamp, "2026-11-11T16:00:00.000Z");
});

test("default cost assumptions reject this synthetic setup at the after-cost 2:1 gate", () => {
  const imported = parseAsxDailyCsv(makeCsv("BHP"));
  const bars = imported.barsBySymbol.BHP;
  const result = evaluateAsxSwingSetup({
    symbol: "BHP", bars, source: "Synthetic test fixture only", currency: "AUD",
    observedAt: bars.at(-1).timestamp, equityAud: 500, cashAud: 500, now
  });
  assert.equal(result.status, "REJECTED");
  assert.match(result.reason, /2:1 minimum/);
});

test("paper lifecycle imports, screens, opens, marks, closes, accounts for fees and permits re-entry", () => {
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
  assert.equal(mark.estimatedExitCostsAud, 5.58);
  assert.equal(mark.unrealizedProfitLossAud, -4.08);
  assert.equal(first.position.lastMarkPrice, undefined);

  const closedBhp = closePaperPosition(second.portfolio, "bhp-1", 15, { closedAt: new Date(now + 60_000).toISOString() });
  assert.equal(closedBhp.accepted, true);
  assert.equal(closedBhp.trade.exitCostsAud, 5.58);
  assert.equal(closedBhp.trade.proceedsAud, 69.42);
  assert.equal(closedBhp.trade.profitLossAud, -4.08);
  assert.equal(closedBhp.portfolio.cashAud, 412.42);

  const closedCba = closePaperPosition(closedBhp.portfolio, "cba-1", 17, { closedAt: new Date(now + 120_000).toISOString() });
  assert.equal(closedCba.accepted, true);
  assert.equal(closedCba.trade.exitCostsAud, 5.59);
  assert.equal(closedCba.trade.proceedsAud, 79.41);
  assert.equal(closedCba.trade.profitLossAud, -4.09);
  assert.equal(closedCba.portfolio.cashAud, 491.83);
  assert.equal(closedCba.portfolio.closedTrades.length, 2);
  assert.deepEqual(closedCba.portfolio.closedTrades.map(t => t.id), ["bhp-1", "cba-1"]);

  // Closed history remains in positions; it must not consume the concurrent-open-position limit.
  const reopened = openPaperPosition(closedCba.portfolio, bhp, { id: "bhp-2", openedAt: new Date(now + 180_000).toISOString(), now: now + 180_000 });
  assert.equal(reopened.accepted, true, reopened.reason);
  assert.equal(reopened.portfolio.positions.filter(p => p.status === "OPEN_PAPER").length, 1);
  assert.equal(reopened.portfolio.closedTrades.length, 2);
  assert.equal(reopened.portfolio.cashAud, 418.33);
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

test("paper portfolio rejects stale candidate data at the time of opening", () => {
  const candidate = candidateFromCsv(makeCsv("BHP"), "BHP");
  const result = openPaperPosition(createPaperPortfolio(), candidate, {
    id: "stale-1", now: now + 2 * 86_400_000
  });
  assert.equal(result.accepted, false);
  assert.match(result.reason, /provenance or freshness/);
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
  const riskResult = openPaperPosition(portfolio, excessiveRisk, { id: "risk-bypass", now });
  assert.equal(riskResult.accepted, false);
  assert.match(riskResult.reason, /risk budget/);

  const alteredFees = {
    ...candidate,
    assumptions: { ...candidate.assumptions, commissionRate: 0.0008 }
  };
  const feeResult = openPaperPosition(portfolio, alteredFees, { id: "fee-bypass", now });
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

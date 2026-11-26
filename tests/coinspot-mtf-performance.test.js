import test from "node:test";
import assert from "node:assert/strict";
import { calculateMtfPaperPerformance } from "../coinspot-mtf-performance.js";

const base = { startingCapitalAud:100, equityAud:100, realizedPnlAud:0, unrealizedPnlAud:0, closedTrades:[], openPosition:null };
const now = "2026-11-26T08:00:00.000Z";

test("reports an empty paper ledger as zero profit without inventing win rate or profit factor", () => {
  const p = calculateMtfPaperPerformance(base, now);
  assert.equal(p.netPnlAud, 0); assert.equal(p.returnPct, 0); assert.equal(p.closedTrades, 0);
  assert.equal(p.winRatePct, null); assert.equal(p.profitFactor, null); assert.equal(p.equityCurve, null);
});

test("calculates net closed-trade performance, fees and rolling windows", () => {
  const account = { ...base, equityAud:102.4, realizedPnlAud:2.4, closedTrades:[
    { closedAt:"2026-11-26T07:00:00.000Z", pnlAud:4, entryFeeAud:.1, exitFeeAud:.1 },
    { closedAt:"2026-11-22T07:00:00.000Z", pnlAud:-1.6, entryFeeAud:.1, exitFeeAud:.1 }
  ] };
  const p = calculateMtfPaperPerformance(account, now);
  assert.equal(p.realizedPnlAud, 2.4); assert.equal(p.netPnlAud, 2.4);
  assert.equal(p.returnPct, 2.4); assert.equal(p.closedTrades, 2);
  assert.equal(p.winningTrades, 1); assert.equal(p.losingTrades, 1);
  assert.equal(p.winRatePct, 50); assert.equal(p.profitFactor, 2.5);
  assert.equal(p.feesPaidAud, .4); assert.equal(p.rolling24hPnlAud, 4);
  assert.equal(p.rolling7dPnlAud, 2.4); assert.equal(p.rolling30dPnlAud, 2.4);
});

test("includes unrealized P&L in net P&L but not in closed-trade win statistics", () => {
  const account = { ...base, equityAud:99.5, realizedPnlAud:0, unrealizedPnlAud:-.5,
    openPosition:{ coin:"BTC" }, closedTrades:[] };
  const p = calculateMtfPaperPerformance(account, now);
  assert.equal(p.netPnlAud, -.5); assert.equal(p.returnPct, -.5);
  assert.equal(p.closedTrades, 0); assert.equal(p.openPosition, true);
});

test("rejects an invalid calculation clock", () => assert.throws(() => calculateMtfPaperPerformance(base, "not-a-date"), /Invalid performance/));

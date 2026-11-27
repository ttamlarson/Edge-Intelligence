import test from "node:test";
import assert from "node:assert/strict";
import { __test } from "../index.js";

const FOUR_HOURS = 4 * 60 * 60 * 1000;
const DAY = 24 * FOUR_HOURS;

function makeHistoryFixture() {
  const start = Date.parse("2026-07-30T16:00:00.000Z");
  const fourHourCandles = Array.from({ length: 720 }, (_, index) => ({
    timestamp: new Date(start + index * FOUR_HOURS).toISOString(),
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1,
    tradeCount: 1
  }));

  const observedByDay = new Map();
  for (const candle of fourHourCandles) {
    const day = candle.timestamp.slice(0, 10);
    observedByDay.set(day, (observedByDay.get(day) || 0) + candle.tradeCount);
  }

  const tradesFetchedByDate = {
    "2026-07-28": 2,
    "2026-07-29": 3
  };
  for (const [day, observed] of observedByDay) {
    // The first retained day is deliberately incomplete: the daily total
    // proves that its missing leading four-hour bars are outside the 720-bar
    // retention boundary. Every later date reconciles exactly.
    tradesFetchedByDate[day] = day === "2026-07-30" ? observed + 1 : observed;
  }

  const dailyCandles = Object.entries(tradesFetchedByDate)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, tradeCount]) => ({
      timestamp: day + "T00:00:00.000Z",
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: tradeCount,
      tradeCount
    }));

  return { dailyCandles, fourHourCandles, tradesFetchedByDate };
}

test("excludes only leading dates outside a full four-hour retention window", () => {
  const result = __test.validateCoinSpotMtfMarketHistory(makeHistoryFixture());

  assert.equal(result.status, "VALIDATED");
  assert.equal(result.unverifiedDailyDays, 0);
  assert.equal(result.unverifiedFourHourDays, 0);
  assert.equal(result.validatedFourHourDays, 120);
  assert.equal(result.fourHourCandles.length, 718);
  assert.deepEqual(result.retentionBoundaryExcludedFourHourDays, [
    "2026-07-28",
    "2026-07-29",
    "2026-07-30"
  ]);
  assert.match(result.reason, /RETENTION_DATES_EXCLUDED/);
});

test("does not waive a mismatched four-hour day inside the retained window", () => {
  const history = makeHistoryFixture();
  const day = "2026-08-01";
  const revisedCount = history.tradesFetchedByDate[day] + 1;
  history.tradesFetchedByDate[day] = revisedCount;
  history.dailyCandles.find(candle => candle.timestamp.startsWith(day)).tradeCount = revisedCount;

  const result = __test.validateCoinSpotMtfMarketHistory(history);

  assert.equal(result.status, "BACKFILLING_WITH_UNVERIFIED_CACHED_DAYS");
  assert.equal(result.unverifiedFourHourDays, 1);
  assert.ok(result.retentionBoundaryExcludedFourHourDays.includes("2026-07-30"));
});

test("does not classify a truncated leading day as a retention exclusion below the bar cap", () => {
  const history = makeHistoryFixture();
  history.fourHourCandles.pop();

  const result = __test.validateCoinSpotMtfMarketHistory(history);

  assert.equal(result.status, "BACKFILLING_WITH_UNVERIFIED_CACHED_DAYS");
  assert.ok(result.unverifiedFourHourDays >= 1);
  assert.deepEqual(result.retentionBoundaryExcludedFourHourDays, []);
});

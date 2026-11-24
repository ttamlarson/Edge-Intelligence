import test from "node:test";
import assert from "node:assert/strict";
import { normalizeBinanceHourlyKlines } from "../binance-market-data.js";

function fixture(now = Date.parse("2026-11-25T12:00:00.000Z"), count = 260) {
  const rows = [];
  const lastOpen = Math.floor(now / 3_600_000) * 3_600_000 - 3_600_000;
  for (let i = count - 1; i >= 0; i--) {
    const openTime = lastOpen - i * 3_600_000;
    const open = 100 + (count - i) * 0.1;
    rows.push([openTime, String(open), String(open + 1), String(open - 1), String(open + 0.5), "1000", openTime + 3_599_999]);
  }
  return { now, rows };
}

test("accepts ordered, complete, fresh Binance hourly candles and excludes the open candle", () => {
  const { now, rows } = fixture();
  const openCandle = [Math.floor(now / 3_600_000) * 3_600_000, "130", "131", "129", "130.5", "1000", Math.floor(now / 3_600_000) * 3_600_000 + 3_599_999];
  const result = normalizeBinanceHourlyKlines([...rows, openCandle], { now });
  assert.equal(result.valid, true);
  assert.equal(result.bars.length, 260);
  assert.equal(result.bars.at(-1).close, Number(rows.at(-1)[4]));
  assert.equal(Date.parse(result.bars.at(-1).timestamp), Number(rows.at(-1)[0]));
});

test("rejects duplicate and out-of-order candle timestamps", () => {
  const { now, rows } = fixture();
  const duplicate = rows.map(row => [...row]);
  duplicate[10][0] = duplicate[9][0];
  assert.equal(normalizeBinanceHourlyKlines(duplicate, { now }).reason, "INVALID_HOURLY_CANDLES");
  const reversed = [...rows].reverse();
  assert.equal(normalizeBinanceHourlyKlines(reversed, { now }).reason, "INVALID_HOURLY_CANDLES");
});

test("rejects malformed OHLC, negative volume and malformed rows", () => {
  const { now, rows } = fixture();
  const badOhlc = rows.map(row => [...row]);
  badOhlc[4][2] = String(Number(badOhlc[4][1]) - 1);
  assert.equal(normalizeBinanceHourlyKlines(badOhlc, { now }).reason, "INVALID_HOURLY_CANDLES");
  const badVolume = rows.map(row => [...row]);
  badVolume[4][5] = "-1";
  assert.equal(normalizeBinanceHourlyKlines(badVolume, { now }).reason, "INVALID_HOURLY_CANDLES");
  assert.equal(normalizeBinanceHourlyKlines([...rows.slice(0, -1), [1, 2]], { now }).reason, "INVALID_HOURLY_CANDLES");
});

test("rejects stale candles and invalid clock configuration", () => {
  const now = Date.parse("2026-11-25T12:00:00.000Z");
  const { rows } = fixture(now - 8 * 3_600_000);
  assert.equal(normalizeBinanceHourlyKlines(rows, { now }).reason, "STALE_HOURLY_CANDLES");
  assert.equal(normalizeBinanceHourlyKlines(rows, { now: Number.NaN }).reason, "INVALID_VALIDATION_CLOCK");
});

test("rejects insufficient history after removing the still-open candle", () => {
  const { now, rows } = fixture(Date.parse("2026-11-25T12:00:00.000Z"), 220);
  const openCandle = [Math.floor(now / 3_600_000) * 3_600_000, "130", "131", "129", "130.5", "1000", Math.floor(now / 3_600_000) * 3_600_000 + 3_599_999];
  assert.equal(normalizeBinanceHourlyKlines([...rows.slice(1), openCandle], { now }).reason, "INVALID_OR_INCOMPLETE_RESPONSE");
});

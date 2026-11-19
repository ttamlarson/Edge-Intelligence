import test from "node:test";
import assert from "node:assert/strict";
import { parseBinanceKlineCsv } from "../crypto-csv.js";

const header = "open_time_ms,open,high,low,close,volume,close_time_ms,quote_asset_volume,number_of_trades,taker_buy_base_asset_volume,taker_buy_quote_asset_volume,ignore";
function row(time, close = 10) { return `${time},10,11,9,${close},2,${time + 3599999},20,5,1,10,0`; }
function sample(count = 301) { const start = Date.UTC(2026, 0, 1); return [header, ...Array.from({ length: count }, (_, i) => row(start + i * 3600000))].join("\n"); }

test("imports Binance hourly CSV and preserves USDT quote denomination", () => {
  const result = parseBinanceKlineCsv(sample(), { symbol: "BTCUSDT", quoteAsset: "USDT", now: Date.UTC(2026, 0, 20) });
  assert.equal(result.candles.length, 301);
  assert.equal(result.metadata.baseAsset, "BTC");
  assert.equal(result.metadata.priceCurrency, "USDT");
  assert.equal(result.quality.completeHourlySeries, true);
});
test("rejects a quote asset that does not match the symbol", () => {
  assert.throws(() => parseBinanceKlineCsv(sample(), { symbol: "BTCUSDT", quoteAsset: "AUD" }), /does not match/);
});
test("excludes a still-open final candle", () => {
  const start = Date.UTC(2026, 0, 1);
  const csv = [header, ...Array.from({ length: 301 }, (_, i) => row(start + i * 3600000))].join("\n");
  const result = parseBinanceKlineCsv(csv, { symbol: "ETHUSDT", quoteAsset: "USDT", now: start + 300 * 3600000 + 1000 });
  assert.equal(result.candles.length, 300);
});
test("rejects duplicate or out-of-order timestamps", () => {
  const start = Date.UTC(2026, 0, 1);
  assert.throws(() => parseBinanceKlineCsv([header, row(start), row(start)].join("\n"), { symbol: "BTCUSDT", now: start + 999999999 }), /strictly ordered/);
});
test("rejects incomplete OHLCV schema", () => {
  assert.throws(() => parseBinanceKlineCsv("timestamp,close\nnow,10", { symbol: "BTCUSDT" }), /missing required/);
});

test("accepts canonical timestamp OHLCV exports as well as Binance kline exports", () => {
  const start = Date.UTC(2026, 0, 1);
  const rows = ["timestamp,open,high,low,close,volume", ...Array.from({ length: 301 }, (_, i) =>
    `${new Date(start + i * 3600000).toISOString()},10,11,9,10,2`)];
  const result = parseBinanceKlineCsv(rows.join("\\n"), {
    symbol: "BTCUSDT", quoteAsset: "USDT", now: start + 302 * 3600000
  });
  assert.equal(result.candles.length, 301);
  assert.equal(result.metadata.csvFormat, "timestamp OHLCV");
  assert.equal(result.metadata.priceCurrency, "USDT");
});

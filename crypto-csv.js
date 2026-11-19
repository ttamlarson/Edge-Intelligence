const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;

function splitCsvLine(line) {
  const cells = [];
  let value = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') { value += '"'; i++; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) { cells.push(value); value = ""; }
    else value += char;
  }
  if (quoted) throw Error("CSV contains an unterminated quoted field.");
  cells.push(value);
  return cells;
}

function timestampMs(value, isBinance) {
  if (isBinance) return finite(value);
  const numeric = finite(value);
  if (numeric !== null) return numeric < 1e11 ? numeric * 1000 : numeric;
  const parsed = Date.parse(String(value || "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseBinanceKlineCsv(csv, {
  symbol, exchange = "Binance", quoteAsset = "USDT",
  now = Date.now(), excludeOpenCandle = true
} = {}) {
  if (typeof csv !== "string" || !csv.trim()) throw Error("A non-empty CSV string is required.");
  if (!/^[A-Z0-9]{5,20}$/.test(String(symbol || ""))) throw Error("Provide the exact market symbol, e.g. BTCUSDT.");
  if (!/^[A-Z0-9]{2,10}$/.test(String(quoteAsset || ""))) throw Error("Provide the quote asset explicitly.");
  const lines = csv.replace(/^\uFEFF/, "").trim().split(/\r?\n/);
  const headers = splitCsvLine(lines.shift()).map(x => x.trim().toLowerCase().replace(/^\uFEFF/, ""));
  const indexes = Object.fromEntries(headers.map((name, index) => [name, index]));
  const binanceFormat = indexes.open_time_ms !== undefined;
  const timeColumn = binanceFormat ? "open_time_ms" : (indexes.timestamp !== undefined ? "timestamp" : "open_time");
  const closeTimeColumn = indexes.close_time_ms !== undefined ? "close_time_ms" : null;
  const required = [timeColumn, "open", "high", "low", "close", "volume"];
  const missing = required.filter(name => indexes[name] === undefined);
  if (missing.length) throw Error(`CSV header must include ${required.join(", ")}. Missing: ${missing.join(", ")}.`);
  const baseAsset = symbol.slice(0, -quoteAsset.length);
  if (!baseAsset || !symbol.endsWith(quoteAsset)) throw Error("The symbol does not match the declared quote asset.");
  const candles = [];
  let previous = -Infinity, missingIntervals = 0;
  for (const [lineIndex, line] of lines.entries()) {
    if (!line.trim()) continue;
    const cells = splitCsvLine(line);
    const get = name => cells[indexes[name]];
    const openTime = timestampMs(get(timeColumn), binanceFormat);
    const closeTime = closeTimeColumn ? finite(get(closeTimeColumn)) : null;
    const open = finite(get("open")), high = finite(get("high")), low = finite(get("low")), close = finite(get("close")), volume = finite(get("volume"));
    if (![openTime, open, high, low, close, volume].every(Number.isFinite)) throw Error(`Invalid numeric candle data on CSV line ${lineIndex + 2}.`);
    if (openTime <= previous) throw Error("Candles must be strictly ordered with no duplicate timestamps.");
    if (Math.min(open, high, low, close) <= 0 || high < Math.max(open, close) || low > Math.min(open, close) || high < low || volume < 0 ||
        (closeTimeColumn && (closeTime === null || closeTime - openTime !== 3599999)))
      throw Error(`Invalid OHLCV values or candle times on CSV line ${lineIndex + 2}.`);
    if (previous !== -Infinity && openTime - previous !== 3600000) missingIntervals++;
    previous = openTime;
    if (excludeOpenCandle && (closeTimeColumn ? closeTime >= now : openTime + 3600000 > now)) continue;
    candles.push({ timestamp: new Date(openTime).toISOString(), open, high, low, close, volume });
  }
  if (candles.length < 300) throw Error(`Only ${candles.length} completed candles remain; at least 300 are required.`);
  return {
    metadata: {
      source: "CryptoFetch CSV export", exchange, symbol, baseAsset, quoteAsset,
      timeframe: "1h", priceCurrency: quoteAsset, candleCount: candles.length,
      firstCandleAt: candles[0].timestamp, lastCandleAt: candles.at(-1).timestamp,
      lastCandleCompleted: true, importedAt: new Date(now).toISOString(),
      csvFormat: binanceFormat ? "Binance kline" : "timestamp OHLCV"
    },
    quality: { missingIntervals, duplicateTimestamps: 0, completeHourlySeries: missingIntervals === 0 },
    candles
  };
}

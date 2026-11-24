// Validate Binance public 1-hour klines before they reach the crypto signal engine.
// Fail closed on malformed, duplicated, out-of-order, future or stale observations.
const finite = value => value === null || value === undefined || value === "" ? null : Number.isFinite(Number(value)) ? Number(value) : null;

export function normalizeBinanceHourlyKlines(raw, { now = Date.now(), minBars = 220, maxAgeMs = 2 * 60 * 60 * 1000 } = {}) {
  const reject = reason => ({ valid: false, reason, bars: [] });
  if (!Array.isArray(raw) || raw.length < minBars) return reject("INVALID_OR_INCOMPLETE_RESPONSE");
  if (!Number.isFinite(now) || !Number.isInteger(minBars) || minBars < 1 || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
    return reject("INVALID_VALIDATION_CLOCK");
  }

  const parsed = [];
  let previousOpenTime = -Infinity;
  for (const row of raw) {
    if (!Array.isArray(row) || row.length < 7) return reject("INVALID_HOURLY_CANDLES");
    const openTime = finite(row[0]);
    const closeTime = finite(row[6]);
    const open = finite(row[1]);
    const high = finite(row[2]);
    const low = finite(row[3]);
    const close = finite(row[4]);
    const volume = finite(row[5]);
    if (![openTime, closeTime, open, high, low, close, volume].every(Number.isFinite) ||
        openTime <= previousOpenTime || closeTime <= openTime || volume < 0 ||
        Math.min(open, high, low, close) <= 0 || high < Math.max(open, close) || low > Math.min(open, close) || low > high) {
      return reject("INVALID_HOURLY_CANDLES");
    }
    previousOpenTime = openTime;
    parsed.push({ openTime, closeTime, open, high, low, close, volume });
  }

  const closed = parsed.filter(bar => bar.closeTime < now);
  if (closed.length < minBars) return reject("INVALID_OR_INCOMPLETE_RESPONSE");
  const latest = closed.at(-1);
  if (now - latest.closeTime > maxAgeMs) return reject("STALE_HOURLY_CANDLES");
  return {
    valid: true,
    bars: closed.map(bar => ({
      timestamp: new Date(bar.openTime).toISOString(),
      open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume
    })),
    latestClosedCandle: new Date(latest.openTime).toISOString()
  };
}

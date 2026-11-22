// Deterministic ASX research scoring. This is technical-analysis decision support,
// not an AI model, probability forecast, recommendation, or executable instruction.
const number = value => value === null || value === undefined || value === "" ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;

export function analyzeAsxDailySetup({ symbol, bars, source, currency, observedAt, now = Date.now(), maxAgeMs = 36 * 60 * 60 * 1000 } = {}) {
  const ticker = String(symbol || "").trim().toUpperCase();
  const fail = (status, reason) => ({ status, symbol: ticker, source: typeof source === "string" ? source : null, currency: currency || null, score: null, scoreType: "NOT_A_PROBABILITY", reason, factors: [] });
  if (!/^[A-Z0-9.]{2,12}$/.test(ticker)) return fail("INSUFFICIENT_DATA", "A valid ASX ticker is required.");
  if (currency !== "AUD") return fail("REJECTED", "Only explicitly denominated AUD bars can be analysed.");
  if (typeof source !== "string" || !source.trim()) return fail("REJECTED", "A named data source is required.");
  if (!Array.isArray(bars) || bars.length < 51) return fail("INSUFFICIENT_DATA", "At least 51 daily OHLC bars are required.");
  if (!Number.isFinite(now) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) return fail("REJECTED", "The analysis clock or freshness limit is invalid.");
  const observed = Date.parse(observedAt || "");
  if (!Number.isFinite(observed) || observed > now + 300000 || now - observed > maxAgeMs) return fail("STALE", "The source observation is missing, future-dated or stale.");
  const clean = [];
  for (const bar of bars) {
    const open = number(bar?.open), high = number(bar?.high), low = number(bar?.low), close = number(bar?.close);
    const timestamp = Date.parse(bar?.timestamp || "");
    const volume = number(bar?.volume);
    if (![open, high, low, close, timestamp].every(Number.isFinite) || open <= 0 || low <= 0 ||
        high < Math.max(open, close) || low > Math.min(open, close) || high < low ||
        (bar?.volume !== undefined && (volume === null || volume < 0))) {
      return fail("REJECTED", "One or more daily bars failed OHLCV validation.");
    }
    clean.push({ open, high, low, close, timestamp, volume });
  }
  for (let i = 1; i < clean.length; i++) if (clean[i].timestamp <= clean[i - 1].timestamp) return fail("REJECTED", "Daily bars must have unique increasing timestamps.");
  const latest = clean.at(-1);
  if (latest.timestamp > now + 300000 || now - latest.timestamp > maxAgeMs) return fail("STALE", "The latest daily bar is future-dated or stale.");
  if (latest.timestamp > observed + 300000) return fail("REJECTED", "The latest daily bar is later than the source observation.");

  const closes = clean.map(bar => bar.close);
  const sma20 = mean(closes.slice(-20)), sma50 = mean(closes.slice(-50));
  const priorHigh20 = Math.max(...clean.slice(-21, -1).map(bar => bar.high));
  const gains = [], losses = [];
  for (let i = clean.length - 14; i < clean.length; i++) {
    const change = closes[i] - closes[i - 1];
    gains.push(Math.max(0, change)); losses.push(Math.max(0, -change));
  }
  const averageGain = mean(gains), averageLoss = mean(losses);
  const rsi14 = averageLoss === 0 ? (averageGain === 0 ? 50 : 100) : 100 - 100 / (1 + averageGain / averageLoss);
  const trueRanges = [];
  for (let i = clean.length - 14; i < clean.length; i++) {
    const previous = clean[i - 1].close, bar = clean[i];
    trueRanges.push(Math.max(bar.high - bar.low, Math.abs(bar.high - previous), Math.abs(bar.low - previous)));
  }
  const atr14 = mean(trueRanges), atrPct = atr14 / latest.close * 100;
  const volumeValues = clean.slice(-21, -1).map(bar => bar.volume);
  const hasVolume = latest.volume !== null && volumeValues.every(value => value !== null);
  const volumeRatio = hasVolume && mean(volumeValues) > 0 ? latest.volume / mean(volumeValues) : null;

  const factors = [];
  const add = (name, points, maxPoints, detail) => factors.push({ name, points, maxPoints, detail });
  add("Trend alignment", (latest.close > sma20 ? 12.5 : 0) + (sma20 > sma50 ? 12.5 : 0), 25,
    `Close ${latest.close > sma20 ? "above" : "not above"} SMA20; SMA20 ${sma20 > sma50 ? "above" : "not above"} SMA50.`);
  const breakoutPct = (latest.close / priorHigh20 - 1) * 100;
  add("20-day breakout", breakoutPct >= 0 ? 25 : breakoutPct >= -2 ? 12 : 0, 25,
    breakoutPct >= 0 ? "Close is at or above the prior 20-session high." : `Close is ${Math.abs(breakoutPct).toFixed(2)}% below the prior 20-session high.`);
  const momentumPoints = rsi14 >= 45 && rsi14 <= 65 ? 20 : (rsi14 >= 35 && rsi14 < 45) || (rsi14 > 65 && rsi14 <= 75) ? 10 : 0;
  add("RSI momentum", momentumPoints, 20, `RSI(14) is ${rsi14.toFixed(1)}.`);
  const volatilityPoints = atrPct >= 1 && atrPct <= 5 ? 15 : atrPct >= 0.5 && atrPct <= 8 ? 8 : 0;
  add("Volatility range", volatilityPoints, 15, `ATR(14) is ${atrPct.toFixed(2)}% of the latest close.`);
  if (hasVolume && volumeRatio !== null) add("Volume confirmation", volumeRatio >= 1.2 ? 15 : volumeRatio >= 0.8 ? 8 : 0, 15, `Latest volume is ${volumeRatio.toFixed(2)}× the prior 20-session average.`);
  const available = factors.reduce((sum, factor) => sum + factor.maxPoints, 0);
  const raw = factors.reduce((sum, factor) => sum + factor.points, 0);
  const score = Math.round(raw / available * 100);
  return {
    status: "REVIEW", symbol: ticker, source: source.trim(), currency: "AUD",
    observedAt: new Date(observed).toISOString(), latestBarAt: new Date(latest.timestamp).toISOString(),
    score, scoreType: "TECHNICAL_SETUP_SCORE_NOT_PROBABILITY",
    scoreCoverage: Math.round(available), latestClose: latest.close,
    indicators: { sma20: Number(sma20.toFixed(4)), sma50: Number(sma50.toFixed(4)), rsi14: Number(rsi14.toFixed(2)), atr14: Number(atr14.toFixed(4)), atrPct: Number(atrPct.toFixed(2)), breakoutPct: Number(breakoutPct.toFixed(2)), volumeRatio: volumeRatio === null ? null : Number(volumeRatio.toFixed(2)) },
    factors, reason: "Deterministic technical screen only. A higher score is not a probability of profit and does not authorise a paper or live order."
  };
}

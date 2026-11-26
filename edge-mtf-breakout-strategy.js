// EDGE multi-timeframe crypto trend/breakout research engine.
// Pure signal/risk functions only: no exchange calls and no order placement.
const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;
const round = value => Math.round((value + Number.EPSILON) * 1e8) / 1e8;
const PERIOD_4H = 4 * 60 * 60 * 1000;
const PERIOD_1D = 24 * 60 * 60 * 1000;

function ema(values, period) {
  if (values.length < period) return null;
  const alpha = 2 / (period + 1);
  let result = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  for (const value of values.slice(period)) result = value * alpha + result * (1 - alpha);
  return result;
}

export function latestContiguousCandleRun(candles, interval, label = "OHLCV history") {
  if (!Array.isArray(candles) || candles.length > 50000 || !Number.isSafeInteger(interval) || interval <= 0) {
    throw new Error(label + " has invalid candle continuity inputs.");
  }
  let previous = -Infinity;
  let runStart = 0;
  let gapCount = 0;
  let latestGap = null;
  const normalized = candles.map((candle, index) => {
    const timestamp = Date.parse(candle?.timestamp);
    const open = finite(candle?.open), high = finite(candle?.high), low = finite(candle?.low);
    const close = finite(candle?.close), volume = finite(candle?.volume);
    if (!Number.isFinite(timestamp) || timestamp % interval !== 0 ||
        (previous !== -Infinity && timestamp <= previous) ||
        ![open, high, low, close, volume].every(Number.isFinite) ||
        Math.min(open, high, low, close) <= 0 || high < Math.max(open, close) ||
        low > Math.min(open, close) || high < low || volume < 0) {
      throw new Error(label + " contains invalid, unordered, unaligned or incomplete OHLCV data.");
    }
    if (previous !== -Infinity) {
      const delta = timestamp - previous;
      if (delta % interval !== 0) {
        throw new Error(label + " contains timestamps that are not aligned to the candle interval.");
      }
      if (delta > interval) {
        gapCount++;
        latestGap = {
          previousAt: new Date(previous).toISOString(),
          nextAt: new Date(timestamp).toISOString(),
          missingIntervals: delta / interval - 1
        };
        runStart = index;
      }
    }
    previous = timestamp;
    return { timestamp: new Date(timestamp).toISOString(), open, high, low, close, volume };
  });
  const latestRun = normalized.slice(runStart);
  return {
    candles: latestRun,
    totalCandles: normalized.length,
    contiguousCandles: latestRun.length,
    gapCount,
    latestGap
  };
}

function validateCandles(candles, interval, label, minimum) {
  if (!Array.isArray(candles) || candles.length < minimum || candles.length > 50000) {
    throw new Error(`${label} requires between ${minimum} and 50,000 completed OHLCV candles.`);
  }
  let previous = -Infinity;
  return candles.map(candle => {
    const timestamp = Date.parse(candle.timestamp);
    const open = finite(candle.open), high = finite(candle.high), low = finite(candle.low);
    const close = finite(candle.close), volume = finite(candle.volume);
    if (!Number.isFinite(timestamp) || (previous !== -Infinity && timestamp - previous !== interval) ||
        ![open, high, low, close, volume].every(Number.isFinite) ||
        Math.min(open, high, low, close) <= 0 || high < Math.max(open, close) ||
        low > Math.min(open, close) || high < low || volume < 0) {
      throw new Error(`${label} contains invalid, unordered, incomplete or non-contiguous OHLCV data.`);
    }
    previous = timestamp;
    return { timestamp: new Date(timestamp).toISOString(), open, high, low, close, volume };
  });
}

function atr(candles, period = 20) {
  if (candles.length <= period) return null;
  let total = 0;
  for (let index = candles.length - period; index < candles.length; index++) {
    const candle = candles[index], previousClose = candles[index - 1].close;
    total += Math.max(candle.high - candle.low, Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose));
  }
  return total / period;
}

function donchianHigh(candles, lookback) {
  // Excludes the current signal candle to prevent look-ahead.
  const prior = candles.slice(-(lookback + 1), -1);
  if (prior.length !== lookback) return null;
  return Math.max(...prior.map(candle => candle.high));
}

export function evaluateEdgeBreakoutSignal({
  dailyCandles, fourHourCandles, asOf = Date.now(), spreadBps = 0,
  minimumVolume = 0, volatilityMinPct = 0.002, volatilityMaxPct = 0.12
} = {}) {
  const daily = validateCandles(dailyCandles, PERIOD_1D, "Daily history", 110);
  const fourHour = validateCandles(fourHourCandles, PERIOD_4H, "Four-hour history", 210);
  const clock = asOf instanceof Date ? asOf.getTime() : typeof asOf === "string" ? Date.parse(asOf) : Number(asOf);
  if (!Number.isFinite(clock) || !Number.isFinite(spreadBps) || spreadBps < 0 ||
      !Number.isFinite(minimumVolume) || minimumVolume < 0 ||
      !Number.isFinite(volatilityMinPct) || !Number.isFinite(volatilityMaxPct) ||
      volatilityMinPct <= 0 || volatilityMaxPct <= volatilityMinPct) {
    throw new Error("Invalid signal clock, spread, volume or volatility configuration.");
  }
  const dailyBar = daily.at(-1), signalBar = fourHour.at(-1);
  if (Date.parse(dailyBar.timestamp) + PERIOD_1D > clock ||
      Date.parse(signalBar.timestamp) + PERIOD_4H > clock) {
    throw new Error("The latest daily or four-hour candle is incomplete; signals require closed candles.");
  }
  if (Date.parse(dailyBar.timestamp) > Date.parse(signalBar.timestamp)) {
    throw new Error("Daily regime candle cannot be later than the four-hour signal candle.");
  }

  const dailyCloses = daily.map(candle => candle.close);
  const fourHourCloses = fourHour.map(candle => candle.close);
  const dailyEma100 = ema(dailyCloses, 100);
  const fourHourEma20 = ema(fourHourCloses, 20);
  const priorFourHourEma20 = ema(fourHourCloses.slice(0, -1), 20);
  const ema50 = ema(fourHourCloses, 50);
  const ema200 = ema(fourHourCloses, 200);
  const priorEma200 = ema(fourHourCloses.slice(0, -10), 200);
  const volatility = atr(fourHour, 20);
  const volatilityPct = volatility / signalBar.close;
  const channel = [20, 55, 100].map(lookback => ({
    lookback, high: donchianHigh(fourHour, lookback)
  }));
  const votes = channel.filter(level => signalBar.close > level.high).length;
  const previousSignalBar = fourHour.at(-2);
  const pullbackReclaim = previousSignalBar.close <= priorFourHourEma20 &&
    signalBar.close > fourHourEma20 && signalBar.close > signalBar.open;
  const breakoutTrigger = votes >= 2;
  const entryTrigger = breakoutTrigger || pullbackReclaim;
  const checks = {
    dailyTrend: dailyBar.close > dailyEma100,
    fourHourTrend: ema50 > ema200,
    positiveLongTrendSlope: ema200 > priorEma200,
    breakoutVotes: breakoutTrigger,
    pullbackReclaim,
    entryTrigger,
    liquidity: signalBar.volume > 0 && signalBar.volume >= minimumVolume && spreadBps <= 50,
    volatility: volatilityPct >= volatilityMinPct && volatilityPct <= volatilityMaxPct
  };
  // Breakout and pullback reclaim are alternative entry triggers. The higher-timeframe,
  // liquidity and volatility gates remain mandatory for both paths.
  const eligible = checks.dailyTrend && checks.fourHourTrend &&
    checks.positiveLongTrendSlope && checks.entryTrigger && checks.liquidity && checks.volatility;
  const stopDistance = volatility * 2.5;
  return {
    strategy: "EDGE_MTF_DONCHIAN_ENSEMBLE_V1",
    status: eligible ? "BUY_CANDIDATE_PAPER_ONLY" : "NO_TRADE",
    entryModel: !entryTrigger ? null : breakoutTrigger ? "DONCHIAN_BREAKOUT" : "PULLBACK_RECLAIM",
    signalAt: signalBar.timestamp,
    evaluatedAt: new Date(clock).toISOString(),
    marketRegime: checks.dailyTrend && checks.fourHourTrend && checks.positiveLongTrendSlope ? "BULLISH" : "NOT_BULLISH",
    checks,
    indicators: {
      dailyEma100: round(dailyEma100), fourHourEma20: round(fourHourEma20),
      fourHourEma50: round(ema50), fourHourEma200: round(ema200), atr20: round(volatility),
      atrPct: round(volatilityPct * 100), breakoutVotes: votes,
      breakoutLevels: channel.map(level => ({ lookback: level.lookback, priorHigh: round(level.high) })),
      spreadBps
    },
    risk: {
      initialStopDistance: round(stopDistance),
      stopReference: "actual_next_executable_fill_minus_2.5_ATR",
      trailingStop: "highest_completed_4h_close_since_entry_minus_3_ATR",
      maximumHoldingDays: 30,
      maximumNotionalAllocationPct: 25,
      riskBudgetPct: 0.5
    },
    execution: {
      orderIntent: "NONE",
      paperOnly: true,
      requiresNextExecutableQuote: true,
      liveTradingEnabled: false
    }
  };
}

export function sizeEdgeBreakoutPosition({ equity, entryPrice, atr20, feeRate = 0.001, riskPct = 0.005, allocationPct = 0.25, minimumNotional = 10 } = {}) {
  if (![equity, entryPrice, atr20, feeRate, riskPct, allocationPct, minimumNotional].every(Number.isFinite) ||
      equity <= 0 || entryPrice <= 0 || atr20 <= 0 || feeRate < 0 ||
      riskPct <= 0 || riskPct > 0.01 || allocationPct <= 0 || allocationPct > 0.25 || minimumNotional < 0) {
    throw new Error("Invalid position-sizing inputs.");
  }
  const stopDistance = atr20 * 2.5;
  const riskBudget = equity * riskPct;
  const riskLimitedNotional = riskBudget / (stopDistance / entryPrice);
  const allocationLimitedNotional = equity * allocationPct;
  const notional = Math.min(riskLimitedNotional, allocationLimitedNotional);
  const quantity = notional / (entryPrice * (1 + feeRate));
  const actualNotional = quantity * entryPrice;
  return {
    notional: round(actualNotional),
    quantity: round(quantity),
    riskBudget: round(riskBudget),
    estimatedStopRisk: round(quantity * stopDistance),
    stopPrice: round(entryPrice - stopDistance),
    accepted: actualNotional >= minimumNotional && quantity > 0,
    liveTradingEnabled: false
  };
}

export function getEdgeBreakoutExit({ entryPrice, highestCompletedClose, atr20, fourHourClose, dailyTrendBullish, ageDays = 0 } = {}) {
  if (![entryPrice, highestCompletedClose, atr20, fourHourClose, ageDays].every(Number.isFinite) ||
      entryPrice <= 0 || highestCompletedClose <= 0 || atr20 <= 0 || ageDays < 0 ||
      typeof dailyTrendBullish !== "boolean") throw new Error("Invalid position exit inputs.");
  const initialStop = entryPrice - 2.5 * atr20;
  const trailingStop = highestCompletedClose - 3 * atr20;
  const activeStop = Math.max(initialStop, trailingStop);
  let reason = null;
  if (fourHourClose <= activeStop) reason = "ATR_TRAILING_STOP";
  else if (fourHourClose <= entryPrice && !dailyTrendBullish) reason = "DAILY_TREND_REVERSAL";
  else if (ageDays >= 30) reason = "MAXIMUM_HOLDING_PERIOD";
  return {
    shouldExit: reason !== null, reason,
    activeStop: round(activeStop), initialStop: round(initialStop),
    trailingStop: round(trailingStop), liveTradingEnabled: false
  };
}

// Experimental early-reversal signal research. Shadow-only: never accepted by the paper ledger.
const DAY = 86400000;
const FOUR_HOURS = 14400000;
const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;
const round = value => Math.round((value + Number.EPSILON) * 1e8) / 1e8;

function validate(candles, interval, minimum, label) {
  if (!Array.isArray(candles) || candles.length < minimum || candles.length > 50000) {
    throw new Error(label + " requires at least " + minimum + " actual candles.");
  }
  let previous = -Infinity;
  return candles.map(candle => {
    const timestamp = Date.parse(candle?.timestamp || "");
    const open = finite(candle?.open), high = finite(candle?.high);
    const low = finite(candle?.low), close = finite(candle?.close);
    const volume = finite(candle?.volume);
    if (!Number.isFinite(timestamp) || timestamp % interval !== 0 || timestamp <= previous ||
        ![open, high, low, close, volume].every(Number.isFinite) ||
        Math.min(open, high, low, close) <= 0 || high < Math.max(open, close) ||
        low > Math.min(open, close) || high < low || volume < 0) {
      throw new Error(label + " contains invalid, unordered, incomplete or misaligned OHLCV data.");
    }
    if (previous !== -Infinity && timestamp - previous !== interval) {
      throw new Error(label + " must be contiguous; missing candles are never fabricated.");
    }
    previous = timestamp;
    return { timestamp: new Date(timestamp).toISOString(), open, high, low, close, volume };
  });
}

function ema(values, period) {
  if (values.length < period) return null;
  let value = values.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
  const alpha = 2 / (period + 1);
  for (let i = period; i < values.length; i++) value = values[i] * alpha + value * (1 - alpha);
  return value;
}

function atr(candles, period = 20) {
  if (candles.length <= period) return null;
  let total = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const current = candles[i], previous = candles[i - 1];
    total += Math.max(current.high - current.low,
      Math.abs(current.high - previous.close), Math.abs(current.low - previous.close));
  }
  return total / period;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let gains = 0, losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - 100 / (1 + rs);
}

/**
 * Earlier daily recovery + four-hour confirmation.
 * This is a shadow signal only until chronological out-of-sample validation passes.
 * The legacy paper ledger deliberately rejects this strategy identifier.
 */
export function evaluateEarlyReversalShadow({
  dailyCandles, fourHourCandles, asOf = Date.now(), spreadBps = 0,
  minimumVolume = 0, volatilityMinPct = 0.002, volatilityMaxPct = 0.12
} = {}) {
  const daily = validate(dailyCandles, DAY, 60, "Daily history");
  const fourHour = validate(fourHourCandles, FOUR_HOURS, 210, "Four-hour history");
  const clock = asOf instanceof Date ? asOf.getTime()
    : typeof asOf === "string" ? Date.parse(asOf) : Number(asOf);
  if (!Number.isFinite(clock) || !Number.isFinite(spreadBps) || spreadBps < 0 ||
      !Number.isFinite(minimumVolume) || minimumVolume < 0 ||
      !Number.isFinite(volatilityMinPct) || !Number.isFinite(volatilityMaxPct) ||
      volatilityMinPct <= 0 || volatilityMaxPct <= volatilityMinPct) {
    throw new Error("Invalid early-reversal evaluation inputs.");
  }
  const dailyBar = daily.at(-1), signalBar = fourHour.at(-1);
  if (Date.parse(dailyBar.timestamp) + DAY > clock ||
      Date.parse(signalBar.timestamp) + FOUR_HOURS > clock ||
      Date.parse(dailyBar.timestamp) > Date.parse(signalBar.timestamp)) {
    throw new Error("Early-reversal signals require closed, correctly ordered daily and four-hour candles.");
  }

  const dc = daily.map(c => c.close), hc = fourHour.map(c => c.close);
  const dailyEma20 = ema(dc, 20), dailyEma50 = ema(dc, 50);
  const priorDailyEma20 = ema(dc.slice(0, -1), 20);
  const priorDailyEma50 = ema(dc.slice(0, -5), 50);
  const fourHourEma20 = ema(hc, 20), fourHourEma50 = ema(hc, 50);
  const priorFourHourEma20 = ema(hc.slice(0, -1), 20);
  const priorFourHourEma50 = ema(hc.slice(0, -5), 50);
  const volatility = atr(fourHour, 20);
  const volatilityPct = volatility / signalBar.close;
  const momentum = rsi(hc, 14);
  const previous = fourHour.at(-2);
  const reclaim = previous.close <= priorFourHourEma20 &&
    signalBar.close > fourHourEma20 && signalBar.close > signalBar.open;
  const breakoutLevel = Math.max(...fourHour.slice(-21, -1).map(c => c.high));
  const breakout = signalBar.close > breakoutLevel && signalBar.close > signalBar.open;

  // The daily 20/50 EMA recovery replaces the legacy 100-day/4h-200 EMA gate,
  // but still requires two independent timeframes to turn upward.
  const checks = {
    dailyPriceRecovery: dailyBar.close > dailyEma20,
    dailyFastTrend: dailyEma20 > dailyEma50,
    dailyFastSlope: dailyEma20 > priorDailyEma20,
    dailySlowSlope: dailyEma50 > priorDailyEma50,
    fourHourFastTrend: fourHourEma20 > fourHourEma50,
    fourHourFastSlope: fourHourEma20 > priorFourHourEma20,
    fourHourSlowSlope: fourHourEma50 > priorFourHourEma50,
    entryTrigger: reclaim || breakout,
    momentum: momentum >= 50 && momentum <= 72,
    liquidity: signalBar.volume > 0 && signalBar.volume >= minimumVolume && spreadBps <= 50,
    volatility: volatilityPct >= volatilityMinPct && volatilityPct <= volatilityMaxPct
  };
  const failedChecks = Object.entries(checks).filter(([, passed]) => !passed).map(([key]) => key);
  const eligible = failedChecks.length === 0;
  const setupChecks = ["dailyPriceRecovery", "dailyFastSlope", "fourHourFastSlope"];
  const watch = !eligible && setupChecks.every(key => checks[key]) &&
    !["liquidity", "volatility"].some(key => !checks[key]);
  const entryModel = eligible ? (reclaim ? "EARLY_EMA_RECLAIM" : "EARLY_20_BAR_BREAKOUT") : null;
  const stopDistance = volatility * 2.5;
  return {
    strategy: "EDGE_MTF_EARLY_REVERSAL_SHADOW_V1",
    status: eligible ? "SHADOW_CANDIDATE_PAPER_ONLY" : watch ? "WATCH" : "NO_SETUP",
    entryModel,
    signalAt: signalBar.timestamp,
    evaluatedAt: new Date(clock).toISOString(),
    marketRegime: checks.dailyFastTrend && checks.fourHourFastTrend ? "RECOVERING" : "NOT_RECOVERING",
    checks, failedChecks,
    indicators: {
      dailyClose: round(dailyBar.close), dailyEma20: round(dailyEma20),
      dailyEma50: round(dailyEma50), dailyEma20SlopePct: round((dailyEma20 / priorDailyEma20 - 1) * 100),
      fourHourClose: round(signalBar.close), fourHourEma20: round(fourHourEma20),
      fourHourEma50: round(fourHourEma50), fourHourEma20SlopePct: round((fourHourEma20 / priorFourHourEma20 - 1) * 100),
      rsi14: round(momentum), atr20: round(volatility), atrPct: round(volatilityPct * 100),
      breakoutLevel: round(breakoutLevel), spreadBps
    },
    risk: {
      initialStopDistance: round(stopDistance), initialStopAtr: 2.5,
      trailingStopAtr: 3, maximumHoldingDays: 30,
      maximumNotionalAllocationPct: 25, riskBudgetPct: 0.5
    },
    execution: {
      orderIntent: "NONE", paperOnly: true, shadowOnly: true,
      eligibleForPaperLedger: false, liveTradingEnabled: false
    }
  };
}

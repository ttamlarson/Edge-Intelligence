// EDGE Regime-Adaptive Breakout v1.0 — 4-hour, long-only research backtest.
// Closed 4h bars, next-bar entries, explicit costs and chronological OOS testing. No order execution.
const n = value => Number.isFinite(Number(value)) ? Number(value) : null;
const round = value => Math.round((value + Number.EPSILON) * 10000) / 10000;
const HOUR = 3600000, FOUR_HOURS = HOUR * 4;
function ema(values, period) {
  if (values.length < period) return null;
  const alpha = 2 / (period + 1);
  let value = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (const item of values.slice(period)) value = alpha * item + (1 - alpha) * value;
  return value;
}
function atr(bars, period = 14) {
  if (bars.length <= period) return null;
  let sum = 0;
  for (let i = bars.length - period; i < bars.length; i++) {
    const b = bars[i], prev = bars[i - 1].close;
    sum += Math.max(b.high - b.low, Math.abs(b.high - prev), Math.abs(b.low - prev));
  }
  return sum / period;
}
function adx(bars, period = 14) {
  if (bars.length < period * 2 + 1) return null;
  const dx = [];
  for (let i = bars.length - period; i < bars.length; i++) {
    let tr = 0, plus = 0, minus = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const cur = bars[j], prev = bars[j - 1];
      tr += Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close));
      const up = cur.high - prev.high, down = prev.low - cur.low;
      if (up > down && up > 0) plus += up;
      if (down > up && down > 0) minus += down;
    }
    const pdi = tr ? 100 * plus / tr : 0, mdi = tr ? 100 * minus / tr : 0;
    dx.push(pdi + mdi ? 100 * Math.abs(pdi - mdi) / (pdi + mdi) : 0);
  }
  return dx.reduce((a, b) => a + b, 0) / dx.length;
}
export function aggregateFourHourCandles(hourly) {
  if (!Array.isArray(hourly) || hourly.length < 300) throw Error("At least 300 hourly candles are required.");
  const clean = [];
  let previous = -Infinity;
  for (const bar of hourly) {
    const time = Date.parse(bar.timestamp), open = n(bar.open), high = n(bar.high), low = n(bar.low), close = n(bar.close), volume = n(bar.volume);
    if (![time, open, high, low, close, volume].every(Number.isFinite) || time <= previous ||
      Math.min(open, high, low, close) <= 0 || high < Math.max(open, close) || low > Math.min(open, close) || high < low || volume < 0)
      throw Error("Hourly candle series contains invalid, unordered or incomplete OHLCV data.");
    previous = time;
    clean.push({ time, open, high, low, close, volume });
  }
  const groups = new Map();
  for (const bar of clean) {
    const bucket = Math.floor(bar.time / FOUR_HOURS) * FOUR_HOURS;
    if (!groups.has(bucket)) groups.set(bucket, []);
    groups.get(bucket).push(bar);
  }
  const output = [];
  for (const [bucket, rows] of groups) {
    if (rows.length !== 4 || rows[0].time !== bucket || rows.some((x, i) => x.time !== bucket + i * HOUR)) continue;
    output.push({ timestamp: new Date(bucket).toISOString(), open: rows[0].open,
      high: Math.max(...rows.map(x => x.high)), low: Math.min(...rows.map(x => x.low)),
      close: rows[3].close, volume: rows.reduce((sum, x) => sum + x.volume, 0) });
  }
  if (output.length < 500) throw Error("At least 500 complete 4-hour candles are required after aggregation.");
  return output;
}
function simulate(bars, start, end, cfg) {
  let cash = cfg.capital, position = null, peak = cfg.capital, maxDrawdown = 0;
  const trades = [], skipped = { warmup: 0, trend: 0, breakout: 0, adx: 0, volume: 0, positionOpen: 0, riskSizing: 0 };
  let evaluatedBars = 0, eligibleSignals = 0;
  for (let i = Math.max(220, start); i < end; i++) {
    const history = bars.slice(0, i), bar = bars[i], closes = history.map(x => x.close);
    const trend = ema(closes, 200), priorTrend = ema(closes.slice(0, -10), 200);
    const volatility = atr(history), strength = adx(history);
    const priorHigh = Math.max(...history.slice(-20).map(x => x.high));
    const averageVolume = history.slice(-20).reduce((sum, x) => sum + x.volume, 0) / 20;
    evaluatedBars++;
    if (position) {
      const stop = Math.max(position.stop, position.highWater - cfg.trailingAtr * volatility);
      let exit = null, reason = null;
      if (bar.open <= stop) { exit = bar.open; reason = "GAP_STOP"; }
      else if (bar.low <= stop) { exit = stop; reason = "ATR_TRAILING_STOP"; }
      else if (bar.close < trend) { exit = bar.close; reason = "TREND_EXIT"; }
      else if (i - position.entryIndex >= cfg.maxHoldBars) { exit = bar.close; reason = "TIME_EXIT"; }
      else if (i === end - 1) { exit = bar.close; reason = "WINDOW_END"; }
      if (exit !== null) {
        const fill = exit * (1 - cfg.exitCostRate);
        const proceeds = position.quantity * fill * (1 - cfg.feeRate);
        const pnl = proceeds - position.cost;
        cash += proceeds;
        trades.push({ entryAt: position.entryAt, exitAt: bar.timestamp, entry: round(position.entry),
          exit: round(exit), pnlQuote: round(pnl), reason, barsHeld: i - position.entryIndex });
        position = null;
      } else position.highWater = Math.max(position.highWater, bar.high);
    }
    if (position) skipped.positionOpen++;
    else if (!trend || !priorTrend || !volatility || strength === null) skipped.warmup++;
    else if (!(bar.close > trend && trend > priorTrend)) skipped.trend++;
    else if (!(bar.close > priorHigh)) skipped.breakout++;
    else if (!(strength > 20)) skipped.adx++;
    else if (!(bar.volume > averageVolume)) skipped.volume++;
    else if (i + 1 < end) {
      eligibleSignals++;
      const next = bars[i + 1], entry = next.open * (1 + cfg.entryCostRate);
      const stopDistance = cfg.stopAtr * volatility, equity = cash;
      const riskBudget = equity * cfg.riskPct, maxSpend = Math.min(cash, equity * cfg.maxAllocationPct);
      const quantity = Math.min(maxSpend / (entry * (1 + cfg.feeRate)), riskBudget / stopDistance);
      const cost = quantity * entry * (1 + cfg.feeRate);
      if (quantity > 0 && stopDistance > 0 && cost >= cfg.minTrade && cost <= cash) {
        cash -= cost;
        position = { entry, entryAt: next.timestamp, entryIndex: i + 1, quantity, cost,
          stop: entry - stopDistance, highWater: entry };
      } else skipped.riskSizing++;
    }
    const equity = cash + (position ? position.quantity * bar.close : 0);
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
  }
  const winners = trades.filter(x => x.pnlQuote > 0), losers = trades.filter(x => x.pnlQuote < 0);
  const grossWins = winners.reduce((s, x) => s + x.pnlQuote, 0), grossLoss = -losers.reduce((s, x) => s + x.pnlQuote, 0);
  return { trades: trades.length, wins: winners.length, losses: losers.length,
    winRatePct: trades.length ? round(winners.length / trades.length * 100) : 0,
    netPnlQuote: round(trades.reduce((s, x) => s + x.pnlQuote, 0)),
    endingEquityQuote: round(cash + (position ? position.quantity * bars[end - 1].close : 0)),
    profitFactor: grossLoss ? round(grossWins / grossLoss) : grossWins ? null : 0,
    maxDrawdownPct: round(maxDrawdown * 100), evaluatedBars, eligibleSignals, skipped,
    dateRange: { from: bars[Math.max(220, start)]?.timestamp ?? null, to: bars[end - 1]?.timestamp ?? null },
    tradesDetail: trades };
}
export function backtestRegimeAdaptiveBreakout({ candles, market = "UNKNOWN", quoteCurrency = "USDT",
  startingCapital = 100, feeRate = .001, slippageBps = 15, spreadBps = 10, trainFraction = .7 } = {}) {
  if (startingCapital !== 100 || !/^[A-Z]{3,5}$/.test(quoteCurrency) ||
    ![feeRate, slippageBps, spreadBps, trainFraction].every(Number.isFinite) ||
    feeRate < 0 || slippageBps < 0 || spreadBps < 0 || trainFraction < .5 || trainFraction > .85)
    throw Error("Invalid breakout backtest assumptions.");
  const bars = aggregateFourHourCandles(candles);
  const split = Math.floor(bars.length * trainFraction);
  const config = { capital: startingCapital, feeRate,
    entryCostRate: (slippageBps + spreadBps / 2) / 10000,
    exitCostRate: (slippageBps + spreadBps / 2) / 10000,
    riskPct: .005, maxAllocationPct: .25, stopAtr: 2.5, trailingAtr: 3,
    maxHoldBars: 120, minTrade: 5 };
  const inSample = simulate(bars, 220, split, config);
  const outOfSample = simulate(bars, split, bars.length, config);
  const minimumTrades = 30;
  const assessment = outOfSample.trades < minimumTrades ? "INSUFFICIENT_OUT_OF_SAMPLE_TRADES" :
    outOfSample.netPnlQuote > 0 && outOfSample.profitFactor > 1.2 && outOfSample.maxDrawdownPct < 20
      ? "CANDIDATE_FOR_FORWARD_PAPER_TEST" : "NOT_PROVEN_PROFITABLE";
  return { strategy: "EDGE_REGIME_ADAPTIVE_BREAKOUT_4H_V1", market: String(market).toUpperCase(),
    quoteCurrency, methodology: "4h close above rising 200 EMA + 20-bar high breakout + ADX > 20 + volume above 20-bar average; next-bar entry, 2.5 ATR initial stop, 3 ATR trailing stop, trend/time exits.",
    timeframe: "4h", costs: { feeRate, slippageBps, spreadBps },
    risk: { perTradePct: .5, maxAllocationPct: 25, initialStopAtr: 2.5, trailingStopAtr: 3, maxHoldHours: 480 },
    sample: { hourlyCandles: candles.length, fourHourCandles: bars.length, splitIndex: split,
      trainFraction, inSampleCandles: split - 220, outOfSampleCandles: bars.length - split,
      minimumOutOfSampleTrades: minimumTrades },
    inSample, outOfSample, assessment, liveTradingEnabled: false };
}

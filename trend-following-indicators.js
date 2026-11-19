// EDGE Trend-Following Indicators v2. Long-only, research-only; no order execution.
const num = x => Number.isFinite(Number(x)) ? Number(x) : null;
const round = x => Math.round((x + Number.EPSILON) * 10000) / 10000;
const HOUR = 3600000;
function ema(values, period) {
  if (values.length < period) return null;
  const a = 2 / (period + 1);
  let v = values.slice(0, period).reduce((s, x) => s + x, 0) / period;
  for (const x of values.slice(period)) v = a * x + (1 - a) * v;
  return v;
}
function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let up = 0, down = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const d = values[i] - values[i - 1]; if (d > 0) up += d; else down -= d;
  }
  return down ? 100 - 100 / (1 + up / down) : 100;
}
function atr(bars, period = 14) {
  if (bars.length <= period) return null;
  let total = 0;
  for (let i = bars.length - period; i < bars.length; i++) {
    const b = bars[i], p = bars[i - 1].close;
    total += Math.max(b.high - b.low, Math.abs(b.high - p), Math.abs(b.low - p));
  }
  return total / period;
}
function macdHistogram(closes) {
  if (closes.length < 35) return null;
  const line = [];
  for (let i = 25; i < closes.length; i++) {
    const part = closes.slice(0, i + 1);
    line.push(ema(part, 12) - ema(part, 26));
  }
  return line.at(-1) - ema(line, 9);
}
function adx(bars, period = 14) {
  if (bars.length < period * 2 + 1) return null;
  const dx = [];
  for (let i = bars.length - period; i < bars.length; i++) {
    let tr = 0, plus = 0, minus = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const c = bars[j], p = bars[j - 1];
      tr += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
      const up = c.high - p.high, dn = p.low - c.low;
      if (up > dn && up > 0) plus += up;
      if (dn > up && dn > 0) minus += dn;
    }
    const pdi = tr ? 100 * plus / tr : 0, mdi = tr ? 100 * minus / tr : 0;
    dx.push(pdi + mdi ? 100 * Math.abs(pdi - mdi) / (pdi + mdi) : 0);
  }
  return dx.reduce((s, x) => s + x, 0) / dx.length;
}
function validate(candles) {
  if (!Array.isArray(candles) || candles.length < 300 || candles.length > 50000)
    throw Error("At least 300 and no more than 50,000 hourly candles are required.");
  let prev = -Infinity;
  return candles.map((b, i) => {
    const t = Date.parse(b.timestamp), open = num(b.open), high = num(b.high), low = num(b.low), close = num(b.close), volume = num(b.volume);
    if (![t, open, high, low, close, volume].every(Number.isFinite) || t <= prev ||
      Math.min(open, high, low, close) <= 0 || high < Math.max(open, close) ||
      low > Math.min(open, close) || high < low || volume < 0)
      throw Error("Invalid or unordered OHLCV candle at row " + (i + 1) + ".");
    prev = t; return { time: t, timestamp: new Date(t).toISOString(), open, high, low, close, volume };
  });
}
export function aggregateTrendFourHourCandles(hourly) {
  const data = validate(hourly), groups = new Map();
  for (const b of data) {
    const bucket = Math.floor(b.time / (4 * HOUR)) * 4 * HOUR;
    if (!groups.has(bucket)) groups.set(bucket, []);
    groups.get(bucket).push(b);
  }
  const out = [];
  for (const [bucket, rows] of groups) {
    if (rows.length !== 4 || rows[0].time !== bucket || rows.some((b, i) => b.time !== bucket + i * HOUR)) continue;
    out.push({ timestamp: new Date(bucket).toISOString(), open: rows[0].open,
      high: Math.max(...rows.map(x => x.high)), low: Math.min(...rows.map(x => x.low)),
      close: rows[3].close, volume: rows.reduce((s, x) => s + x.volume, 0) });
  }
  return out;
}
function indicators(bars, i) {
  const h = bars.slice(0, i + 1), closes = h.map(x => x.close);
  return { e20: ema(closes.slice(-260), 20), e50: ema(closes.slice(-320), 50),
    e200: ema(closes.slice(-500), 200), rsi: rsi(closes), macd: macdHistogram(closes),
    adx: adx(h), atr: atr(h) };
}
const VARIANTS = [
  { id: "FULL_CONFLUENCE", label: "Full indicator confluence", rsiMin: 50, rsiMax: 68, adxMin: 20, macdPositive: true },
  { id: "BALANCED_CONFIRMATION", label: "Balanced trend confirmation", rsiMin: 45, rsiMax: 72, adxMin: 18, macdPositive: false }
];
function simulate(bars, start, end, cfg, variant) {
  let cash = cfg.capital, position = null, peak = cfg.capital, maxDD = 0, cooldown = 0;
  const trades = [], skipped = { trendAlignment: 0, rsi: 0, macd: 0, adx: 0, volatility: 0, positionOpen: 0, cooldown: 0, riskSizing: 0 };
  let evaluatedBars = 0, eligibleSignals = 0;
  for (let i = Math.max(220, start); i < end; i++) {
    const b = bars[i], ind = indicators(bars, i), next = bars[i + 1];
    evaluatedBars++; if (cooldown > 0) cooldown--;
    if (position) {
      const stop = Math.max(position.stop, position.highWater - cfg.trailingAtr * ind.atr);
      let exit = null, reason = null;
      if (b.low <= stop) { exit = stop; reason = "ATR_TRAILING_STOP"; }
      else if (b.close < ind.e20 || (ind.macd < 0 && position.negativeMacd >= 1)) { exit = b.close; reason = "TREND_MOMENTUM_BREAK"; }
      else if (i - position.entryIndex >= cfg.maxHoldBars) { exit = b.close; reason = "TIME_EXIT"; }
      else if (i === end - 1) { exit = b.close; reason = "WINDOW_END"; }
      if (exit !== null) {
        const fill = exit * (1 - cfg.exitCost), proceeds = position.qty * fill * (1 - cfg.fee);
        const pnl = proceeds - position.cost; cash += proceeds;
        trades.push({ entryAt: position.entryAt, exitAt: b.timestamp, entry: round(position.entry), exit: round(exit), pnlQuote: round(pnl), reason, barsHeld: i - position.entryIndex });
        if (pnl < 0) cooldown = cfg.cooldownBars;
        position = null;
      } else {
        position.highWater = Math.max(position.highWater, b.high);
        position.negativeMacd = ind.macd < 0 ? position.negativeMacd + 1 : 0;
      }
    }
    if (position) skipped.positionOpen++;
    else if (cooldown > 0) skipped.cooldown++;
    else if (!(ind.e20 > ind.e50 && ind.e50 > ind.e200 && b.close > ind.e200)) skipped.trendAlignment++;
    else if (!(ind.rsi >= variant.rsiMin && ind.rsi <= variant.rsiMax)) skipped.rsi++;
    else if (!(variant.macdPositive ? ind.macd > 0 : ind.macd > -Infinity)) skipped.macd++;
    else if (!(ind.adx >= variant.adxMin)) skipped.adx++;
    else if (!(ind.atr > 0)) skipped.volatility++;
    else if (next && i + 1 < end) {
      eligibleSignals++;
      const entry = next.open * (1 + cfg.entryCost), distance = cfg.stopAtr * ind.atr;
      const risk = cash * cfg.riskPct, allocation = Math.min(cash, cash * cfg.maxAllocation);
      const qty = Math.min(allocation / (entry * (1 + cfg.fee)), risk / distance);
      const cost = qty * entry * (1 + cfg.fee);
      if (qty > 0 && distance > 0 && cost >= cfg.minTrade && cost <= cash) {
        cash -= cost; position = { entry, entryAt: next.timestamp, entryIndex: i + 1, qty, cost,
          stop: entry - distance, highWater: entry, negativeMacd: 0 };
      } else skipped.riskSizing++;
    }
    const equity = cash + (position ? position.qty * b.close : 0);
    peak = Math.max(peak, equity); maxDD = Math.max(maxDD, (peak - equity) / peak);
  }
  const wins = trades.filter(t => t.pnlQuote > 0), losses = trades.filter(t => t.pnlQuote < 0);
  const grossWin = wins.reduce((s, t) => s + t.pnlQuote, 0), grossLoss = -losses.reduce((s, t) => s + t.pnlQuote, 0);
  return { trades: trades.length, wins: wins.length, losses: losses.length,
    winRatePct: trades.length ? round(wins.length / trades.length * 100) : 0,
    netPnlQuote: round(trades.reduce((s, t) => s + t.pnlQuote, 0)),
    endingEquityQuote: round(cash + (position ? position.qty * bars[end - 1].close : 0)),
    profitFactor: grossLoss ? round(grossWin / grossLoss) : grossWin ? null : 0,
    maxDrawdownPct: round(maxDD * 100), evaluatedBars, eligibleSignals, skipped,
    dateRange: { from: bars[Math.max(220, start)]?.timestamp ?? null, to: bars[end - 1]?.timestamp ?? null }, tradesDetail: trades };
}
function assessment(x, minimum) {
  if (x.trades < minimum) return "INSUFFICIENT_OUT_OF_SAMPLE_TRADES";
  return x.netPnlQuote > 0 && x.profitFactor > 1.2 && x.maxDrawdownPct < 10
    ? "CANDIDATE_FOR_FORWARD_PAPER_TEST" : "NOT_PROVEN_PROFITABLE";
}
function timeframeResult(bars, timeframe, cfg) {
  const split = Math.floor(bars.length * cfg.trainFraction);
  return { timeframe, candleCount: bars.length, splitIndex: split,
    inSampleCandles: Math.max(0, split - 220), outOfSampleCandles: bars.length - split,
    variants: VARIANTS.map(v => {
      const inSample = simulate(bars, 220, split, cfg, v);
      const outOfSample = simulate(bars, split, bars.length, cfg, v);
      return { ...v, riskPct: cfg.riskPct * 100, allocationPct: cfg.maxAllocation * 100,
        inSample, outOfSample, assessment: assessment(outOfSample, cfg.minimum) };
    }) };
}
export function backtestTrendFollowingIndicators({ candles, market = "UNKNOWN", quoteCurrency = "USDT",
  startingCapital = 100, feeRate = .001, slippageBps = 15, spreadBps = 10,
  trainFraction = .7, minimumOutOfSampleTrades = 30 } = {}) {
  const hourly = validate(candles);
  if (startingCapital !== 100 || !/^[A-Z]{3,5}$/.test(quoteCurrency) ||
    ![feeRate, slippageBps, spreadBps, trainFraction, minimumOutOfSampleTrades].every(Number.isFinite) ||
    feeRate < 0 || slippageBps < 0 || spreadBps < 0 || trainFraction < .5 || trainFraction > .85 ||
    !Number.isInteger(minimumOutOfSampleTrades) || minimumOutOfSampleTrades < 30 || minimumOutOfSampleTrades > 500)
    throw Error("Invalid trend-following backtest assumptions.");
  const cfg = { capital: startingCapital, fee: feeRate,
    entryCost: (slippageBps + spreadBps / 2) / 10000, exitCost: (slippageBps + spreadBps / 2) / 10000,
    riskPct: .005, maxAllocation: .25, stopAtr: 2.5, trailingAtr: 3,
    maxHoldBars: 120, cooldownBars: 6, minTrade: 5, trainFraction, minimum: minimumOutOfSampleTrades };
  const fourHour = aggregateTrendFourHourCandles(hourly);
  return { strategy: "EDGE_TREND_FOLLOWING_INDICATORS_V2", market: String(market).toUpperCase(), quoteCurrency,
    methodology: "EMA20/50/200 trend alignment + RSI momentum + MACD histogram + ADX trend strength; 2.5 ATR initial stop, 3 ATR trailing stop, next-bar entries and trend/time exits.",
    costs: { feeRate, slippageBps, spreadBps },
    risk: { perTradePct: .5, maxAllocationPct: 25, initialStopAtr: 2.5, trailingStopAtr: 3, maximumHoldingBars: 120 },
    sample: { totalHourlyCandles: hourly.length, trainFraction, minimumOutOfSampleTrades,
      assessmentRule: "At least 30 completed OOS trades; then positive net P&L, profit factor > 1.2 and max drawdown < 10%." },
    oneHour: timeframeResult(hourly, "1h", cfg),
    fourHour: timeframeResult(fourHour, "4h", { ...cfg, maxHoldBars: 120 }), liveTradingEnabled: false };
}

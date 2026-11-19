// EDGE Adaptive Regime Trading v1.0 — long-only, multi-market research engine.
// Candle-only simulation. No exchange connectivity, order routing, or live execution.
const num = value => Number.isFinite(Number(value)) ? Number(value) : null;
const round = value => Math.round((value + Number.EPSILON) * 10000) / 10000;

function ema(values, period) {
  if (values.length < period) return null;
  const alpha = 2 / (period + 1);
  let value = values.slice(0, period).reduce((sum, x) => sum + x, 0) / period;
  for (const x of values.slice(period)) value = alpha * x + (1 - alpha) * value;
  return value;
}
function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let up = 0, down = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    if (change > 0) up += change; else down -= change;
  }
  if (down === 0) return 100;
  return 100 - 100 / (1 + up / down);
}
function atr(candles, period = 14) {
  if (candles.length <= period) return null;
  let total = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const bar = candles[i], previous = candles[i - 1].close;
    total += Math.max(bar.high - bar.low, Math.abs(bar.high - previous), Math.abs(bar.low - previous));
  }
  return total / period;
}
function validate(candles) {
  if (!Array.isArray(candles) || candles.length < 300 || candles.length > 20000) throw Error("At least 300 and no more than 20,000 hourly candles are required.");
  let previous = -Infinity;
  return candles.map(bar => {
    const time = Date.parse(bar.timestamp), open = num(bar.open), high = num(bar.high), low = num(bar.low), close = num(bar.close), volume = num(bar.volume);
    if (![time, open, high, low, close, volume].every(Number.isFinite) || time <= previous ||
      Math.min(open, high, low, close) <= 0 || high < Math.max(open, close) || low > Math.min(open, close) || high < low || volume < 0)
      throw Error("Candle series contains invalid, unordered or incomplete OHLCV data.");
    previous = time;
    return { timestamp: new Date(time).toISOString(), open, high, low, close, volume };
  });
}
function regimeAt(history) {
  const closes = history.map(x => x.close);
  const e20 = ema(closes.slice(-120), 20), e50 = ema(closes.slice(-160), 50), e100 = ema(closes.slice(-220), 100);
  if (![e20, e50, e100].every(Number.isFinite)) return "UNDEFINED";
  if (e20 > e50 && e50 > e100 && closes.at(-1) > e50) return "BULL";
  if (e20 < e50 && e50 < e100 && closes.at(-1) < e50) return "BEAR";
  return "SIDEWAYS";
}
function simulate(candles, start, end, config) {
  let cash = config.capital, position = null, peak = config.capital, maxDrawdown = 0, cooldown = 0;
  const trades = [], skip = { bullRegime: 0, pullback: 0, momentum: 0, cooldown: 0, positionOpen: 0, riskSizing: 0 };
  let bars = 0, signals = 0;
  for (let i = Math.max(220, start); i < end; i++) {
    const history = candles.slice(0, i), closes = history.map(x => x.close), bar = candles[i];
    const e20 = ema(closes.slice(-120), 20), e50 = ema(closes.slice(-160), 50);
    const regime = config.active ? (e20 > e50 && bar.close > e50 ? "BULL" : e20 < e50 ? "BEAR" : "SIDEWAYS") : regimeAt(history);
    const momentum = rsi(closes), volatility = atr(history), next = candles[i + 1];
    bars++;
    if (cooldown > 0) cooldown--;
    if (position) {
      position.highWater = Math.max(position.highWater, bar.high);
      const trail = position.highWater - config.trailingAtr * volatility;
      const activeStop = Math.max(position.stop, trail);
      let exit = null, reason = null;
      if (bar.low <= activeStop) { exit = activeStop; reason = "ATR_TRAILING_STOP"; }
      else if (regime === "BEAR" || (e20 < e50 && bar.close < e20)) { exit = bar.close; reason = "REGIME_BREAK"; }
      else if (i - position.entryIndex >= config.maxHoldBars) { exit = bar.close; reason = "TIME_EXIT"; }
      else if (i === end - 1) { exit = bar.close; reason = "WINDOW_END"; }
      if (exit !== null) {
        const fill = exit * (1 - config.exitCostRate);
        const proceeds = position.quantity * fill * (1 - config.feeRate);
        const pnl = proceeds - position.cost;
        cash += proceeds;
        trades.push({ entryAt: position.entryAt, exitAt: bar.timestamp, entry: round(position.entry), exit: round(exit), pnlQuote: round(pnl), reason, barsHeld: i - position.entryIndex });
        if (pnl < 0) cooldown = config.lossCooldownBars;
        position = null;
      }
    }
    if (position) skip.positionOpen++;
    else if (cooldown > 0) skip.cooldown++;
    else if (regime !== "BULL") skip.bullRegime++;
    else if (!(config.active
      ? bar.close > e20 && (bar.low <= e20 * config.pullbackTolerance || bar.close > Math.max(...history.slice(-4).map(x => x.high)))
      : bar.low <= e20 * config.pullbackTolerance && bar.close > e20)) skip.pullback++;
    else if (!(momentum >= config.rsiMin && momentum <= config.rsiMax && volatility > 0)) skip.momentum++;
    else if (next && i + 1 < end) {
      signals++;
      const entry = next.open * (1 + config.entryCostRate);
      const stopDistance = config.stopAtr * volatility;
      const equity = cash + (position ? position.quantity * bar.close : 0);
      const riskBudget = equity * config.riskPct;
      const maxSpend = Math.min(cash, equity * config.maxAllocationPct);
      const quantity = Math.min(maxSpend / (entry * (1 + config.feeRate)), riskBudget / stopDistance);
      const cost = quantity * entry * (1 + config.feeRate);
      if (quantity > 0 && cost >= config.minTrade && cost <= cash && stopDistance > 0) {
        cash -= cost;
        position = { entry, entryAt: next.timestamp, entryIndex: i + 1, quantity, cost, stop: entry - stopDistance, highWater: entry };
      } else skip.riskSizing++;
    }
    const equity = cash + (position ? position.quantity * bar.close : 0);
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
  }
  const winners = trades.filter(t => t.pnlQuote > 0), losers = trades.filter(t => t.pnlQuote < 0);
  const grossWin = winners.reduce((sum, t) => sum + t.pnlQuote, 0), grossLoss = -losers.reduce((sum, t) => sum + t.pnlQuote, 0);
  return {
    trades: trades.length, wins: winners.length, losses: losers.length,
    winRatePct: trades.length ? round(winners.length / trades.length * 100) : 0,
    netPnlQuote: round(trades.reduce((sum, t) => sum + t.pnlQuote, 0)),
    endingEquityQuote: round(cash + (position ? position.quantity * candles[end - 1].close : 0)),
    profitFactor: grossLoss ? round(grossWin / grossLoss) : grossWin ? null : 0,
    maxDrawdownPct: round(maxDrawdown * 100), evaluatedBars: bars, eligibleSignals: signals,
    skipped: skip, dateRange: { from: candles[Math.max(220, start)]?.timestamp ?? null, to: candles[end - 1]?.timestamp ?? null },
    tradesDetail: trades
  };
}
export function backtestAdaptiveRegime({ candles, market = "UNKNOWN", quoteCurrency = "USDT", startingCapital = 100, feeRate = .001, slippageBps = 15, spreadBps = 10, trainFraction = .7 } = {}) {
  const data = validate(candles);
  if (startingCapital !== 100 || !/^[A-Z]{3,5}$/.test(quoteCurrency) ||
    ![feeRate, slippageBps, spreadBps, trainFraction].every(Number.isFinite) ||
    feeRate < 0 || slippageBps < 0 || spreadBps < 0 || trainFraction < .5 || trainFraction > .85)
    throw Error("Invalid adaptive-regime backtest assumptions.");
  const split = Math.floor(data.length * trainFraction);
  const config = {
    capital: startingCapital, feeRate, entryCostRate: (slippageBps + spreadBps / 2) / 10000,
    exitCostRate: (slippageBps + spreadBps / 2) / 10000, riskPct: .0075, maxAllocationPct: .35,
    stopAtr: 2.2, trailingAtr: 2.8, pullbackTolerance: 1.012, rsiMin: 48, rsiMax: 68,
    maxHoldBars: 72, lossCooldownBars: 8, minTrade: 5
  };
  const inSample = simulate(data, 220, split, config), outOfSample = simulate(data, split, data.length, config);
  const activeConfig = { ...config, active: true, riskPct: .005, maxAllocationPct: .25, stopAtr: 1.8, trailingAtr: 2.2, pullbackTolerance: 1.025, rsiMin: 42, rsiMax: 75, maxHoldBars: 48, lossCooldownBars: 4 };
  const activeInSample = simulate(data, 220, split, activeConfig), activeOutOfSample = simulate(data, split, data.length, activeConfig);
  const minimumTrades = 20;
  const assess = sample => sample.trades < minimumTrades ? "INSUFFICIENT_OUT_OF_SAMPLE_TRADES" :
    sample.netPnlQuote > 0 && sample.profitFactor > 1.2 && sample.maxDrawdownPct < 10
      ? "CANDIDATE_FOR_FORWARD_PAPER_TEST" : "NOT_PROVEN_PROFITABLE";
  const assessment = assess(outOfSample), activeAssessment = assess(activeOutOfSample);
  return {
    strategy: "EDGE_ADAPTIVE_REGIME_1H_V1", market: String(market).toUpperCase(), quoteCurrency,
    methodology: "Bull regime (EMA20>EMA50>EMA100) + EMA20 pullback reclaim + RSI confirmation; ATR trailing stop, regime/time exits, loss cooldown.",
    costs: { feeRate, slippageBps, spreadBps }, risk: { perTradePct: .75, maxAllocationPct: 35, maxHoldHours: 72, lossCooldownHours: 8 },
    sample: { totalCandles: data.length, splitIndex: split, trainFraction, inSampleCandles: split - 220, outOfSampleCandles: data.length - split, minimumOutOfSampleTrades: minimumTrades },
    inSample, outOfSample, assessment,
    activeVariant: {
      strategy: "EDGE_ACTIVE_MOMENTUM_1H_V1",
      methodology: "Higher-frequency EMA20/50 trend filter with EMA20 reclaim or four-bar breakout, RSI 42–75, tighter ATR stop/trail and shorter cooldown.",
      risk: { perTradePct: .5, maxAllocationPct: 25, maxHoldHours: 48, lossCooldownHours: 4 },
      inSample: activeInSample, outOfSample: activeOutOfSample, assessment: activeAssessment
    },
    liveTradingEnabled: false
  };
}

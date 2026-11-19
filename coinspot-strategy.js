// CoinSpot-aware, long-only research backtester. No order execution.
const finite = x => Number.isFinite(Number(x)) ? Number(x) : null;
const round = x => Math.round((x + Number.EPSILON) * 100) / 100;
function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let value = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (const x of values.slice(period)) value = x * k + value * (1 - k);
  return value;
}
function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let gains = 0, losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const delta = values[i] - values[i - 1];
    if (delta > 0) gains += delta; else losses -= delta;
  }
  return losses === 0 ? 100 : 100 - 100 / (1 + gains / losses);
}
function atr(candles, period = 14) {
  if (candles.length <= period) return null;
  let total = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const prev = candles[i - 1].close, bar = candles[i];
    total += Math.max(bar.high - bar.low, Math.abs(bar.high - prev), Math.abs(bar.low - prev));
  }
  return total / period;
}
export function validateCoinSpotCandles(candles) {
  if (!Array.isArray(candles) || candles.length < 300 || candles.length > 20000)
    throw Error("At least 300 and no more than 20,000 hourly candles are required.");
  let last = -Infinity;
  return candles.map(c => {
    const timestamp = Date.parse(c.timestamp);
    const open = finite(c.open), high = finite(c.high), low = finite(c.low), close = finite(c.close), volume = finite(c.volume);
    if (!Number.isFinite(timestamp) || timestamp <= last || ![open, high, low, close, volume].every(Number.isFinite) ||
      Math.min(open, high, low, close) <= 0 || high < Math.max(open, close) ||
      low > Math.min(open, close) || high < low || volume < 0)
      throw Error("Candle series contains invalid or unordered OHLCV data.");
    last = timestamp;
    return { timestamp: new Date(timestamp).toISOString(), open, high, low, close, volume };
  });
}
function runSegment(candles, start, end, costs) {
  let cash = 100, position = null, peak = 100, maxDrawdown = 0, dailyLoss = 0, activeDay = "";
  const trades = [];
  for (let i = Math.max(60, start); i < end; i++) {
    const history = candles.slice(0, i), closes = history.map(x => x.close);
    const fast = ema(closes.slice(-100), 20), slow = ema(closes.slice(-100), 50);
    const momentum = rsi(closes), volatility = atr(history), bar = candles[i], day = bar.timestamp.slice(0, 10);
    if (day !== activeDay) { activeDay = day; dailyLoss = 0; }
    if (position) {
      let exit = null, reason = null;
      if (bar.low <= position.stop) { exit = position.stop; reason = "STOP"; }
      else if (bar.high >= position.target) { exit = position.target; reason = "TARGET"; }
      else if (i === end - 1) { exit = bar.close; reason = "WINDOW_END"; }
      if (exit !== null) {
        const sell = exit * (1 - (costs.slippageBps + costs.spreadBps / 2) / 10000);
        const gross = position.quantity * sell, fee = gross * costs.feeRate, proceeds = gross - fee;
        const pnl = proceeds - position.cost;
        cash += proceeds;
        trades.push({ entryAt: position.openedAt, exitAt: bar.timestamp, entry: round(position.entry), exit: round(exit), pnlQuote: round(pnl), reason });
        if (pnl < 0) dailyLoss += -pnl;
        position = null;
      }
    }
    if (!position && i + 1 < end && dailyLoss < 3 && fast > slow && bar.close > fast &&
      momentum >= 50 && momentum <= 68 && volatility > 0) {
      const next = candles[i + 1], entry = next.open * (1 + (costs.slippageBps + costs.spreadBps / 2) / 10000);
      const riskBudget = Math.min(cash * 0.01, 3 - dailyLoss), spend = Math.min(50, Math.max(0, cash - 50));
      const stop = entry - 2 * volatility, target = entry + 3 * volatility;
      const quantity = Math.min(spend / (entry * (1 + costs.feeRate)), riskBudget / (entry - stop));
      const cost = quantity * entry * (1 + costs.feeRate);
      if (cost >= 10 && cost <= spend) { cash -= cost; position = { openedAt: next.timestamp, entry, quantity, cost, stop, target }; }
    }
    const equity = cash + (position ? position.quantity * bar.close : 0);
    peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
  }
  const winners = trades.filter(t => t.pnlQuote > 0), losers = trades.filter(t => t.pnlQuote < 0);
  const grossWins = winners.reduce((sum, t) => sum + t.pnlQuote, 0), grossLosses = -losers.reduce((sum, t) => sum + t.pnlQuote, 0);
  return { trades: trades.length, wins: winners.length, losses: losers.length,
    winRatePct: trades.length ? round(winners.length / trades.length * 100) : 0,
    netPnlQuote: round(trades.reduce((sum, t) => sum + t.pnlQuote, 0)),
    endingEquityAud: round(cash + (position ? position.quantity * candles[end - 1].close : 0)),
    profitFactor: grossLosses ? Number((grossWins / grossLosses).toFixed(3)) : grossWins ? null : 0,
    maxDrawdownPct: round(maxDrawdown * 100), tradesDetail: trades };
}
export function backtestCoinSpotTrend({ candles, startingCapital = 100, startingCapitalAud, quoteCurrency = "AUD", feeRate = .001, slippageBps = 15, spreadBps = 10, trainFraction = .7 } = {}) {
  const validated = validateCoinSpotCandles(candles);
  if ((startingCapitalAud !== undefined && startingCapitalAud !== 100) || startingCapital !== 100 || !/^[A-Z]{3,5}$/.test(quoteCurrency) || ![feeRate, slippageBps, spreadBps, trainFraction].every(Number.isFinite) ||
    feeRate < 0 || slippageBps < 0 || spreadBps < 0 || trainFraction < .5 || trainFraction > .85)
    throw Error("Invalid backtest assumptions.");
  const split = Math.floor(validated.length * trainFraction), costs = { feeRate, slippageBps, spreadBps };
  const inSample = runSegment(validated, 60, split, costs), outOfSample = runSegment(validated, split, validated.length, costs);
  const assessment = outOfSample.trades < 30 ? "INSUFFICIENT_OUT_OF_SAMPLE_TRADES" :
    outOfSample.netPnlAud > 0 && outOfSample.profitFactor > 1.2 && outOfSample.maxDrawdownPct < 10
      ? "CANDIDATE_FOR_FORWARD_PAPER_TEST" : "NOT_PROVEN_PROFITABLE";
  return { strategy: "EMA_TREND_PULLBACK_1H_V1", marketDataSource: "user_supplied_historical_ohlcv",
    startingCapitalAud: 100, costs, splitIndex: split, inSample, outOfSample, assessment, liveTradingEnabled: false };
}

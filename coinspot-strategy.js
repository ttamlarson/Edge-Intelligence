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
  if (!Array.isArray(candles) || candles.length < 300 || candles.length > 50000)
    throw Error("At least 300 and no more than 50,000 hourly candles are required.");
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
  const skipped = { positionOpen: 0, dailyLossLimit: 0, trendFilter: 0, rsiFilter: 0, volatilityFilter: 0, insufficientCapitalOrRisk: 0 };
  let evaluatedBars = 0, eligibleSignals = 0;
  for (let i = Math.max(60, start); i < end; i++) {
    const history = candles.slice(0, i), closes = history.map(x => x.close);
    const fast = ema(closes.slice(-100), 20), slow = ema(closes.slice(-100), 50);
    const momentum = rsi(closes), volatility = atr(history), bar = candles[i], day = bar.timestamp.slice(0, 10);
    evaluatedBars++;
    if (day !== activeDay) { activeDay = day; dailyLoss = 0; }
    if (position) {
      let exit = null, reason = null;
      if (bar.low <= position.stop) {
        exit = Math.min(position.stop, bar.open);
        reason = bar.open < position.stop ? "STOP_GAP_WORSE_OPEN" : "STOP";
      }
      else if (bar.high >= position.target) { exit = position.target; reason = "TARGET"; }
      else if (i === end - 1) { exit = bar.close; reason = "WINDOW_END"; }
      if (exit !== null) {
        const sell = exit * (1 - (costs.slippageBps + costs.spreadBps / 2) / 10000);
        const gross = position.quantity * sell, fee = gross * costs.feeRate, proceeds = gross - fee;
        const pnl = proceeds - position.cost;
        cash += proceeds;
        trades.push({
          entryAt: position.openedAt, exitAt: bar.timestamp,
          entry: round(position.entry), exit: round(exit),
          stopPrice: round(position.stop), targetPrice: round(position.target),
          pnlQuote: round(pnl), reason
        });
        if (pnl < 0) dailyLoss += -pnl;
        position = null;
      }
    }
    if (position) { skipped.positionOpen++; }
    else if (dailyLoss >= 3) { skipped.dailyLossLimit++; }
    else if (!(fast > slow && bar.close > fast)) { skipped.trendFilter++; }
    else if (!(momentum >= 50 && momentum <= 68)) { skipped.rsiFilter++; }
    else if (!(volatility > 0)) { skipped.volatilityFilter++; }
    else if (i + 1 < end) {
      eligibleSignals++;
      const next = candles[i + 1], entry = next.open * (1 + (costs.slippageBps + costs.spreadBps / 2) / 10000);
      const riskBudget = Math.min(cash * 0.01, 3 - dailyLoss), spend = Math.min(50, Math.max(0, cash - 50));
      const stop = entry - 2 * volatility, target = entry + 3 * volatility;
      const quantity = Math.min(spend / (entry * (1 + costs.feeRate)), riskBudget / (entry - stop));
      const cost = quantity * entry * (1 + costs.feeRate);
      if (cost >= 10 && cost <= spend) { cash -= cost; position = { openedAt: next.timestamp, entry, quantity, cost, stop, target }; }
      else skipped.insufficientCapitalOrRisk++;
    }
    const liquidationMark = position
      ? position.quantity * bar.close *
        (1 - (costs.slippageBps + costs.spreadBps / 2) / 10000) * (1 - costs.feeRate)
      : 0;
    const equity = cash + liquidationMark;
    peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
  }
  const winners = trades.filter(t => t.pnlQuote > 0), losers = trades.filter(t => t.pnlQuote < 0);
  const grossWins = winners.reduce((sum, t) => sum + t.pnlQuote, 0), grossLosses = -losers.reduce((sum, t) => sum + t.pnlQuote, 0);
  const endingEquityQuote = round(cash + (position ? position.quantity * candles[end - 1].close : 0));
  return { trades: trades.length, wins: winners.length, losses: losers.length,
    winRatePct: trades.length ? round(winners.length / trades.length * 100) : 0,
    netPnlQuote: round(trades.reduce((sum, t) => sum + t.pnlQuote, 0)),
    endingEquityQuote, returnPct: round((endingEquityQuote - 100) / 100 * 100),
    profitFactor: grossLosses ? Number((grossWins / grossLosses).toFixed(3)) : grossWins ? null : 0,
    maxDrawdownPct: round(maxDrawdown * 100), evaluatedBars, eligibleSignals,
    skipped, dateRange: { from: candles[Math.max(60, start)]?.timestamp ?? null, to: candles[end - 1]?.timestamp ?? null },
    tradesDetail: trades };
}
export function backtestCoinSpotTrend({ candles, startingCapital = 100, startingCapitalAud, quoteCurrency = "AUD", feeRate = .001, slippageBps = 15, spreadBps = 10, trainFraction = .7 } = {}) {
  const validated = validateCoinSpotCandles(candles);
  if ((startingCapitalAud !== undefined && startingCapitalAud !== 100) || startingCapital !== 100 || !/^[A-Z]{3,5}$/.test(quoteCurrency) || ![feeRate, slippageBps, spreadBps, trainFraction].every(Number.isFinite) ||
    feeRate < 0 || slippageBps < 0 || spreadBps < 0 || trainFraction < .5 || trainFraction > .85)
    throw Error("Invalid backtest assumptions.");
  const split = Math.floor(validated.length * trainFraction), costs = { feeRate, slippageBps, spreadBps };
  const inSample = runSegment(validated, 60, split, costs), outOfSample = runSegment(validated, split, validated.length, costs);
  const minimumOutOfSampleTrades = 30;
  const assessment = outOfSample.trades < minimumOutOfSampleTrades ? "INSUFFICIENT_OUT_OF_SAMPLE_TRADES" :
    outOfSample.netPnlQuote > 0 && outOfSample.profitFactor > 1.2 && outOfSample.maxDrawdownPct < 10
      ? "CANDIDATE_FOR_FORWARD_PAPER_TEST" : "NOT_PROVEN_PROFITABLE";
  return { strategy: "EMA_TREND_PULLBACK_1H_V1", marketDataSource: "user_supplied_historical_ohlcv",
    startingCapital: 100, quoteCurrency, ...(quoteCurrency === "AUD" ? { startingCapitalAud: 100 } : {}), costs,
    sample: { totalCandles: validated.length, splitIndex: split, trainFraction, inSampleCandles: split - 60, outOfSampleCandles: validated.length - split,
      minimumOutOfSampleTrades, assessmentRule: "At least 30 completed out-of-sample trades; then positive net P&L, profit factor > 1.2 and max drawdown < 10%." },
    splitIndex: split, inSample, outOfSample, assessment, liveTradingEnabled: false };
}


function benchmarkFold(candles, startIndex, endIndex, costs, startingCapital) {
  const entry = candles[startIndex].open * (1 + (costs.slippageBps + costs.spreadBps / 2) / 10000);
  const spend = startingCapital * 0.5;
  const quantity = spend / (entry * (1 + costs.feeRate));
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return { status: "NO_BENCHMARK_POSITION", returnPct: null, profitLossQuote: null, quantity: 0 };
  }
  const entryCost = quantity * entry * (1 + costs.feeRate);
  const rawExit = candles[endIndex - 1].close;
  const exit = rawExit * (1 - (costs.slippageBps + costs.spreadBps / 2) / 10000);
  const proceeds = quantity * exit * (1 - costs.feeRate);
  const profitLossQuote = round(proceeds - entryCost);
  return {
    status: "SIMULATED_BUY_AND_HOLD_REFERENCE",
    startingCapitalQuote: round(startingCapital), allocationPct: 50,
    entryAt: candles[startIndex].timestamp,
    exitAt: candles[endIndex - 1].timestamp,
    quantity: round(quantity),
    profitLossQuote,
    returnPct: round(profitLossQuote / startingCapital * 100)
  };
}

export function walkForwardCoinSpotTrend({
  candles, market = "UNKNOWN", source = "user_supplied_historical_ohlcv",
  quoteCurrency = "USDT", startingCapital = 100,
  feeRate = 0.001, slippageBps = 15, spreadBps = 10,
  initialHistoryFraction = 0.6, foldCount = 3,
  minimumOutOfSampleTrades = 30, now = Date.now()
} = {}) {
  const data = validateCoinSpotCandles(candles);
  const ticker = String(market || "").toUpperCase();
  const clock = now instanceof Date ? now.getTime() : typeof now === "string" ? Date.parse(now) : Number(now);
  if (!/^[A-Z0-9]{2,20}$/.test(ticker) || typeof source !== "string" || !source.trim() || source.length > 200 ||
      !/^[A-Z]{3,5}$/.test(quoteCurrency) || startingCapital !== 100 ||
      ![feeRate, slippageBps, spreadBps, initialHistoryFraction].every(Number.isFinite) ||
      feeRate < 0 || slippageBps < 0 || spreadBps < 0 ||
      initialHistoryFraction < 0.5 || initialHistoryFraction > 0.8 ||
      !Number.isInteger(foldCount) || foldCount < 2 || foldCount > 6 ||
      !Number.isInteger(minimumOutOfSampleTrades) || minimumOutOfSampleTrades < 1 ||
      !Number.isFinite(clock)) {
    throw Error("Invalid crypto walk-forward symbol, source, currency, cost, clock or fold assumptions.");
  }
  for (let i = 1; i < data.length; i++) {
    if (Date.parse(data[i].timestamp) - Date.parse(data[i - 1].timestamp) !== 3600000) {
      throw Error("Chronological crypto walk-forward requires a complete, contiguous hourly candle series.");
    }
  }
  const latestMs = Date.parse(data.at(-1).timestamp);
  if (latestMs > clock + 5 * 60_000) throw Error("Crypto research data contains a future-dated hourly candle.");
  if (latestMs + 3600000 > clock + 5 * 60_000) throw Error("The latest crypto hourly candle is incomplete; wait for the next hourly close.");
  const initialHistoryBars = Math.floor(data.length * initialHistoryFraction);
  const outOfSampleBars = data.length - initialHistoryBars;
  if (initialHistoryBars < 60 || outOfSampleBars < foldCount * 20) {
    throw Error("At least 60 prior hourly candles and 20 out-of-sample candles per fold are required.");
  }

  const costs = { feeRate, slippageBps, spreadBps };
  const folds = [];
  for (let foldIndex = 0; foldIndex < foldCount; foldIndex++) {
    const startIndex = initialHistoryBars + Math.floor(foldIndex * outOfSampleBars / foldCount);
    const endIndex = initialHistoryBars + Math.floor((foldIndex + 1) * outOfSampleBars / foldCount);
    const simulated = runSegment(data, startIndex, endIndex, costs);
    folds.push({
      fold: foldIndex + 1,
      priorHistoryBars: startIndex,
      testBars: endIndex - startIndex,
      testStartAt: data[startIndex].timestamp,
      testEndAt: data[endIndex - 1].timestamp,
      ...simulated,
      benchmark: benchmarkFold(data, startIndex, endIndex, costs)
    });
  }

  const trades = folds.flatMap(fold => fold.tradesDetail);
  const winners = trades.filter(trade => trade.pnlQuote > 0);
  const losers = trades.filter(trade => trade.pnlQuote < 0);
  const grossProfit = winners.reduce((sum, trade) => sum + trade.pnlQuote, 0);
  const grossLoss = -losers.reduce((sum, trade) => sum + trade.pnlQuote, 0);
  const meanFoldReturnPct = folds.reduce((sum, fold) => sum + fold.returnPct, 0) / folds.length;
  const benchmarkReturns = folds.map(fold => fold.benchmark.returnPct).filter(Number.isFinite);
  const meanBenchmarkReturnPct = benchmarkReturns.length
    ? benchmarkReturns.reduce((sum, value) => sum + value, 0) / benchmarkReturns.length
    : null;
  const meanFoldMaxDrawdownPct = folds.reduce((sum, fold) => sum + fold.maxDrawdownPct, 0) / folds.length;
  const pooledProfitFactor = grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(3)) : null;
  const pooledWinRatePct = trades.length ? round(winners.length / trades.length * 100) : null;
  const assessment = trades.length < minimumOutOfSampleTrades
    ? "INSUFFICIENT_OUT_OF_SAMPLE_TRADES"
    : meanBenchmarkReturnPct !== null && meanFoldReturnPct > 0 &&
      meanFoldReturnPct > meanBenchmarkReturnPct && pooledProfitFactor !== null &&
      pooledProfitFactor > 1.2 && meanFoldMaxDrawdownPct < 10
      ? "CANDIDATE_FOR_EXTENDED_FORWARD_PAPER_REVIEW"
      : "NOT_PROVEN";

  return {
    strategy: "EMA_TREND_PULLBACK_1H_V1",
    market: ticker,
    quoteCurrency,
    source,
    sourceVerification: "NOT_INDEPENDENTLY_VERIFIED",
    asOf: new Date(clock).toISOString(),
    data: {
      bars: data.length,
      firstBarAt: data[0].timestamp,
      lastBarAt: data.at(-1).timestamp,
      initialHistoryFraction,
      initialHistoryBars,
      outOfSampleBars
    },
    methodology: "Fixed EMA20/EMA50 trend and RSI 50–68 pullback screen; next-hour-open entries; 1% equity risk budget, 50% allocation ceiling, daily realised-loss pause, 0.1% fee, configured slippage and spread; stop-first hourly OHLC exits with worse-open gap handling; fold-end liquidation.",
    comparison: "Each fold resets the same virtual 100-unit quote-currency capital. The buy-and-hold reference uses a separate 50-unit allocation and is not risk-matched.",
    parameterPolicy: "FIXED_RULES_NO_FITTING",
    startingCapital: 100,
    costs,
    folds,
    summary: {
      totalOutOfSampleTrades: trades.length,
      pooledWinRatePct,
      pooledProfitFactor,
      meanFoldReturnPct: round(meanFoldReturnPct),
      meanBenchmarkReturnPct: meanBenchmarkReturnPct === null ? null : round(meanBenchmarkReturnPct),
      meanFoldMaxDrawdownPct: round(meanFoldMaxDrawdownPct),
      positiveReturnFolds: folds.filter(fold => fold.returnPct > 0).length,
      foldCount,
      minimumOutOfSampleTrades,
      assessment
    },
    disclaimer: "This is a deterministic historical simulation, not a trained predictive model, executable fill record or profitability guarantee. Source labels and data-use rights are not independently verified. No sample data is generated or substituted.",
    liveTradingEnabled: false
  };
}

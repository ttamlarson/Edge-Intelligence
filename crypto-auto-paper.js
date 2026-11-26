// EDGE automated crypto paper engine. Binance public market data only; never submits exchange orders.
export const AUTO_SYMBOLS = ["BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT","BNBUSDT","DOGEUSDT","ADAUSDT","LINKUSDT","AVAXUSDT","LTCUSDT"];
export const AUTO_CONFIG = Object.freeze({
  startingCapital: 100,
  feeRate: 0.001,
  slippageBps: 15,
  spreadBps: 10,
  riskPct: 0.005,
  maxAllocationPct: 25,
  maxDailyLossPct: 2,
  stopAtr: 2.5,
  targetAtr: 5,
  maxHoldHours: 120
});

const round = value => Math.round((value + Number.EPSILON) * 10000) / 10000;
const roundQuantity = value => Math.floor(value * 1e8) / 1e8;
const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;
const costBps = (AUTO_CONFIG.slippageBps + AUTO_CONFIG.spreadBps / 2) / 10000;
const liquidationValue = (position, price) =>
  position.quantity * price * (1 - costBps) * (1 - AUTO_CONFIG.feeRate);

function ema(values, period) {
  if (values.length < period) return null;
  const multiplier = 2 / (period + 1);
  let value = values.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
  for (const item of values.slice(period)) value = item * multiplier + value * (1 - multiplier);
  return value;
}
function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let up = 0, down = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    if (change > 0) up += change; else down -= change;
  }
  return down === 0 ? 100 : 100 - 100 / (1 + up / down);
}
function atr(bars, period = 14) {
  if (bars.length <= period) return null;
  let sum = 0;
  for (let i = bars.length - period; i < bars.length; i++) {
    const previous = bars[i - 1].close, bar = bars[i];
    sum += Math.max(bar.high - bar.low, Math.abs(bar.high - previous), Math.abs(bar.low - previous));
  }
  return sum / period;
}
function adx(bars, period = 14) {
  if (bars.length < period * 2 + 2) return null;
  const dx = [];
  for (let end = bars.length - period + 1; end <= bars.length; end++) {
    let trueRange = 0, positive = 0, negative = 0;
    for (let i = end - period; i < end; i++) {
      const current = bars[i], previous = bars[i - 1];
      trueRange += Math.max(current.high - current.low, Math.abs(current.high - previous.close), Math.abs(current.low - previous.close));
      const up = current.high - previous.high, down = previous.low - current.low;
      if (up > down && up > 0) positive += up;
      if (down > up && down > 0) negative += down;
    }
    const plusDi = trueRange ? 100 * positive / trueRange : 0;
    const minusDi = trueRange ? 100 * negative / trueRange : 0;
    dx.push(plusDi + minusDi ? 100 * Math.abs(plusDi - minusDi) / (plusDi + minusDi) : 0);
  }
  return dx.reduce((sum, value) => sum + value, 0) / dx.length;
}

export function evaluateAutoSignal(bars) {
  if (!Array.isArray(bars) || bars.length < 220) {
    return {
      signal: false,
      reason: "WARMUP_REQUIRED",
      checks: { warmup: { passed: false, value: Array.isArray(bars) ? bars.length : 0, required: 220 } },
      failedChecks: ["WARMUP_REQUIRED"]
    };
  }
  const last = bars.at(-1);
  const closes = bars.map(bar => bar.close);
  const ema20 = ema(closes.slice(-100), 20);
  const ema50 = ema(closes.slice(-150), 50);
  const ema200 = ema(closes, 200);
  const momentum = rsi(closes);
  const volatility = atr(bars);
  const strength = adx(bars);
  const macd = ema(closes, 12) - ema(closes, 26);
  const previousMacd = ema(closes.slice(0, -1), 12) - ema(closes.slice(0, -1), 26);
  const checks = {
    trend: { passed: ema20 > ema50 && ema50 > ema200 && last.close > ema20, value: { close: round(last.close), ema20: round(ema20), ema50: round(ema50), ema200: round(ema200) }, required: "close > EMA20 > EMA50 > EMA200" },
    rsi: { passed: momentum >= 50 && momentum <= 68, value: round(momentum), required: "50–68" },
    macd: { passed: macd > previousMacd, value: { current: round(macd), previous: round(previousMacd) }, required: "current MACD > previous MACD" },
    adx: { passed: strength >= 18, value: round(strength), required: "≥ 18" },
    atr: { passed: Number.isFinite(volatility) && volatility > 0, value: round(volatility), required: "valid positive ATR" }
  };
  const failedChecks = Object.entries(checks).filter(([, check]) => !check.passed).map(([key]) => key.toUpperCase());
  return {
    signal: failedChecks.length === 0,
    reason: failedChecks.join("_") || "TREND_FOLLOWING_CONFLUENCE",
    failedChecks, checks, timestamp: last.timestamp, price: last.close,
    atr: volatility, rsi: round(momentum), adx: round(strength),
    ema20: round(ema20), ema50: round(ema50), ema200: round(ema200)
  };
}

export function createAutoPaperAccount(now = new Date().toISOString()) {
  return {
    mode: "AUTOMATED_PAPER_ONLY",
    paperOnly: true,
    quoteCurrency: "USDT",
    startingCapital: AUTO_CONFIG.startingCapital,
    cash: AUTO_CONFIG.startingCapital,
    realizedPnl: 0,
    openPosition: null,
    closedTrades: [],
    lastProcessed: {},
    lastCandidateRanking: [],
    dailyLoss: 0,
    day: now.slice(0, 10),
    equity: AUTO_CONFIG.startingCapital,
    peakEquity: AUTO_CONFIG.startingCapital,
    maxDrawdownPct: 0,
    liveTradingEnabled: false,
    updatedAt: now
  };
}

export function validateAutoPaperAccount(value) {
  const validDate = input => typeof input === "string" && Number.isFinite(Date.parse(input));
  const validNumber = (input, min = -Infinity) =>
    input !== null && input !== undefined && input !== "" && Number.isFinite(Number(input)) && Number(input) >= min;
  const validTrade = trade => trade && typeof trade === "object" && validDate(trade.closedAt) && validNumber(trade.pnl);
  const position = value?.openPosition;
  const validPosition = position === null || (
    position && typeof position === "object" && AUTO_SYMBOLS.includes(position.symbol) &&
    typeof position.id === "string" && validDate(position.openedAt) &&
    validNumber(position.entryPrice, 0.00000001) && validNumber(position.quantity, 0.00000001) &&
    validNumber(position.entryCost, 0.00000001) && validNumber(position.entryFee, 0) &&
    validNumber(position.stopPrice, 0.00000001) && Number(position.stopPrice) < Number(position.entryPrice) &&
    validNumber(position.trailingStop, 0.00000001) && validNumber(position.targetPrice, 0.00000001) &&
    Number(position.targetPrice) > Number(position.entryPrice) && validNumber(position.atr, 0.00000001) &&
    validNumber(position.highestPrice, 0.00000001)
  );
  const invalid = [];
  if (!value || value.mode !== "AUTOMATED_PAPER_ONLY" || value.quoteCurrency !== "USDT" ||
      value.startingCapital !== AUTO_CONFIG.startingCapital || value.liveTradingEnabled !== false ||
      (value.paperOnly !== undefined && value.paperOnly !== true)) invalid.push("account identity or paper-only safety flags");
  if (!Array.isArray(value?.closedTrades) || value.closedTrades.length > 200 || !value.closedTrades.every(validTrade)) invalid.push("closed-trade history");
  if (!value?.lastProcessed || typeof value.lastProcessed !== "object" || Array.isArray(value.lastProcessed) ||
      !Object.values(value.lastProcessed).every(validDate)) invalid.push("processed-signal cursor");
  if (!validNumber(value?.cash, 0) || !validNumber(value?.realizedPnl) || !validNumber(value?.equity, 0) ||
      !validNumber(value?.peakEquity, 0.00000001) || !validNumber(value?.maxDrawdownPct, 0) ||
      !validNumber(value?.dailyLoss, 0)) invalid.push("account balances or risk metrics");
  if (!validDate(value?.updatedAt) || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value?.day || "") ||
      !Number.isFinite(Date.parse((value?.day || "") + "T00:00:00.000Z"))) invalid.push("account timestamps");
  if (!validPosition) invalid.push("open position");
  if (invalid.length) {
    throw new Error("Automated crypto paper ledger failed validation (" + invalid.join(", ") + "); existing data must be preserved.");
  }
  return true;
}

export function normalizeAutoPaperAccount(value, now = new Date().toISOString()) {
  validateAutoPaperAccount(value);
  const day = now.slice(0, 10);
  const dailyLoss = round(value.closedTrades
    .filter(trade => String(trade.closedAt || "").slice(0, 10) === day)
    .reduce((sum, trade) => sum + Math.max(0, -Number(trade.pnl || 0)), 0));
  return { ...value, paperOnly: true, day, dailyLoss, updatedAt: now };
}

export function rankAutoPaperCandidates(signals, prices, account) {
  if (!account || account.mode !== "AUTOMATED_PAPER_ONLY" || account.liveTradingEnabled !== false ||
      (account.paperOnly !== undefined && account.paperOnly !== true)) return [];
  const equity = finite(account.equity);
  const cash = finite(account.cash);
  const dailyLoss = Math.max(0, finite(account.dailyLoss) ?? 0);
  const maximumDailyLoss = account.startingCapital * AUTO_CONFIG.maxDailyLossPct / 100;
  const dailyLossRemaining = Math.max(0, maximumDailyLoss - dailyLoss);
  const riskBudget = Math.min(Math.max(0, equity || 0) * AUTO_CONFIG.riskPct, dailyLossRemaining);
  const allocation = Math.min(Math.max(0, equity || 0) * AUTO_CONFIG.maxAllocationPct / 100, Math.max(0, cash || 0));
  if (!(riskBudget > 0) || !(allocation > 0)) return [];

  const candidates = [];
  for (const [symbol, signal] of Object.entries(signals || {})) {
    if (!AUTO_SYMBOLS.includes(symbol) || signal?.signal !== true ||
        typeof signal.timestamp !== "string" || !Number.isFinite(Date.parse(signal.timestamp)) ||
        !Number.isFinite(signal.atr) || signal.atr <= 0 ||
        signal.timestamp === account.lastProcessed?.[symbol]) continue;
    const price = finite(prices?.[symbol]);
    if (!(price > 0)) continue;
    const entryPrice = price * (1 + costBps);
    const stopPrice = entryPrice - AUTO_CONFIG.stopAtr * signal.atr;
    const targetPrice = entryPrice + AUTO_CONFIG.targetAtr * signal.atr;
    const entryCostPerUnit = entryPrice * (1 + AUTO_CONFIG.feeRate);
    const stopProceedsPerUnit = stopPrice * (1 - costBps) * (1 - AUTO_CONFIG.feeRate);
    const targetProceedsPerUnit = targetPrice * (1 - costBps) * (1 - AUTO_CONFIG.feeRate);
    const netStopRiskPerUnit = entryCostPerUnit - stopProceedsPerUnit;
    const netTargetProfitPerUnit = targetProceedsPerUnit - entryCostPerUnit;
    if (!(stopPrice > 0) || !(netStopRiskPerUnit > 0) || !(netTargetProfitPerUnit > 0)) continue;

    const quantity = roundQuantity(Math.min(riskBudget / netStopRiskPerUnit, allocation / entryCostPerUnit));
    const entryCost = quantity * entryCostPerUnit;
    const entryFee = quantity * entryPrice * AUTO_CONFIG.feeRate;
    const estimatedNetStopLossQuote = quantity * netStopRiskPerUnit;
    const estimatedNetTargetProfitQuote = quantity * netTargetProfitPerUnit;
    if (!(quantity > 0) || entryCost < 5 || entryCost > cash + 1e-8 ||
        estimatedNetStopLossQuote > riskBudget + 1e-8 ||
        dailyLoss + estimatedNetStopLossQuote > maximumDailyLoss + 1e-8) continue;

    candidates.push({
      symbol,
      signalAt: signal.timestamp,
      price,
      atr: signal.atr,
      adx: finite(signal.adx) ?? 0,
      rsi: finite(signal.rsi),
      entryPrice: round(entryPrice),
      stopPrice: round(stopPrice),
      targetPrice: round(targetPrice),
      quantity,
      entryFee: round(entryFee),
      entryCost: round(entryCost),
      riskBudgetQuote: round(riskBudget),
      dailyLossRemainingQuote: round(dailyLossRemaining),
      allocationCapQuote: round(allocation),
      estimatedNetStopLossQuote: round(estimatedNetStopLossQuote),
      estimatedNetTargetProfitQuote: round(estimatedNetTargetProfitQuote),
      rewardRiskAfterCosts: round(estimatedNetTargetProfitQuote / estimatedNetStopLossQuote),
      riskBudgetUtilizationPct: round(estimatedNetStopLossQuote / riskBudget * 100),
      allocationUtilizationPct: round(entryCost / allocation * 100),
      rankingMethod: "NET_REWARD_RISK_AFTER_FEES_AND_SPREAD_SLIPPAGE_THEN_NET_TARGET_PROFIT_THEN_RISK_UTILIZATION_THEN_ADX"
    });
  }

  candidates.sort((a, b) =>
    b.rewardRiskAfterCosts - a.rewardRiskAfterCosts ||
    b.estimatedNetTargetProfitQuote - a.estimatedNetTargetProfitQuote ||
    a.riskBudgetUtilizationPct - b.riskBudgetUtilizationPct ||
    b.adx - a.adx ||
    a.symbol.localeCompare(b.symbol)
  );
  return candidates.map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

export function calculateAutoPaperPerformance(account) {
  try { validateAutoPaperAccount(account); }
  catch { return { status: "INVALID_PAPER_LEDGER", tradeCount: 0, assessment: "NOT_PROVEN" }; }
  const trades = account.closedTrades.slice().sort((a, b) => Date.parse(a.closedAt) - Date.parse(b.closedAt));
  const winners = trades.filter(trade => Number(trade.pnl) > 0);
  const losers = trades.filter(trade => Number(trade.pnl) < 0);
  const grossProfit = winners.reduce((sum, trade) => sum + Number(trade.pnl), 0);
  const grossLoss = -losers.reduce((sum, trade) => sum + Number(trade.pnl), 0);
  const netPnl = trades.reduce((sum, trade) => sum + Number(trade.pnl), 0);
  const fees = trades.reduce((sum, trade) =>
    sum + Math.max(0, finite(trade.entryFee) ?? 0) + Math.max(0, finite(trade.exitFee) ?? 0), 0);
  let equity = account.startingCapital, peak = equity, maxDrawdown = 0;
  for (const trade of trades) {
    equity += Number(trade.pnl);
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  const tradeCount = trades.length;
  const bySymbol = {};
  for (const symbol of [...new Set(trades.map(trade => trade.symbol).filter(Boolean))].sort()) {
    const rows = trades.filter(trade => trade.symbol === symbol);
    const wins = rows.filter(trade => Number(trade.pnl) > 0).length;
    bySymbol[symbol] = {
      tradeCount: rows.length,
      netPnlQuote: round(rows.reduce((sum, trade) => sum + Number(trade.pnl), 0)),
      winRatePct: round(wins / rows.length * 100)
    };
  }
  return {
    status: tradeCount < 30 ? "INSUFFICIENT_SAMPLE" : tradeCount < 100 ? "EARLY_SAMPLE" : "LARGER_SAMPLE_NOT_PROOF",
    tradeCount,
    wins: winners.length,
    losses: losers.length,
    winRatePct: tradeCount ? round(winners.length / tradeCount * 100) : null,
    netPnlQuote: round(netPnl),
    netReturnPct: round(netPnl / account.startingCapital * 100),
    grossProfitQuote: round(grossProfit),
    grossLossQuote: round(grossLoss),
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss) : null,
    averageWinQuote: winners.length ? round(grossProfit / winners.length) : null,
    averageLossQuote: losers.length ? round(grossLoss / losers.length) : null,
    expectancyQuote: tradeCount ? round(netPnl / tradeCount) : null,
    estimatedFeesQuote: round(fees),
    maxRealizedDrawdownQuote: round(maxDrawdown),
    maxRealizedDrawdownPct: peak > 0 ? round(maxDrawdown / peak * 100) : null,
    markToMarketMaxDrawdownPct: finite(account.maxDrawdownPct),
    bySymbol,
    basis: "CLOSED_PAPER_TRADES_NET_OF_SIMULATED_FEES_SPREAD_AND_SLIPPAGE",
    assessment: "NOT_PROVEN",
    interpretation: "Paper outcomes are descriptive only. Sample-size labels do not establish a repeatable edge or future profitability."
  };
}

export function markAutoPaperAccount(account, { prices, now = new Date().toISOString() } = {}) {
  const a = normalizeAutoPaperAccount(account, now);
  const position = a.openPosition;
  const price = position ? finite(prices?.[position.symbol]) : null;
  if (position && price > 0) {
    const mark = price * (1 - costBps);
    const gross = position.quantity * mark;
    const exitFee = gross * AUTO_CONFIG.feeRate;
    a.unrealizedPnl = round(gross - exitFee - position.entryCost);
    a.markPrice = price;
    const peak = Math.max(position.highestPrice || position.entryPrice, price);
    position.highestPrice = peak;
    position.trailingStop = Math.max(position.trailingStop || position.stopPrice, peak - AUTO_CONFIG.stopAtr * position.atr);
    const held = (Date.parse(now) - Date.parse(position.openedAt)) / 3600000;
    const reason = price <= position.trailingStop ? "TRAILING_STOP"
      : price >= position.targetPrice ? "TAKE_PROFIT"
        : held >= AUTO_CONFIG.maxHoldHours ? "MAX_HOLD" : null;
    if (reason) {
      const exit = price * (1 - costBps);
      const grossExit = position.quantity * exit;
      const fee = grossExit * AUTO_CONFIG.feeRate;
      const proceeds = grossExit - fee;
      const pnl = proceeds - position.entryCost;
      a.cash = round(a.cash + proceeds);
      a.realizedPnl = round(a.realizedPnl + pnl);
      a.closedTrades.push({
        id: position.id, symbol: position.symbol, openedAt: position.openedAt, closedAt: now,
        entryPrice: position.entryPrice, exitPrice: round(exit), quantity: position.quantity,
        pnl: round(pnl), reason, entryFee: position.entryFee, exitFee: round(fee),
        strategy: position.strategy
      });
      a.closedTrades = a.closedTrades.slice(-200);
      a.openPosition = null;
      a.unrealizedPnl = 0;
      a.dailyLoss = round(a.closedTrades
        .filter(trade => String(trade.closedAt || "").slice(0, 10) === now.slice(0, 10))
        .reduce((sum, trade) => sum + Math.max(0, -Number(trade.pnl || 0)), 0));
    }
  }
  a.equity = round(a.cash + (a.openPosition
    ? liquidationValue(a.openPosition, a.markPrice || a.openPosition.entryPrice)
    : 0));
  a.peakEquity = Math.max(a.peakEquity || AUTO_CONFIG.startingCapital, a.equity);
  a.maxDrawdownPct = round(Math.max(a.maxDrawdownPct || 0, (a.peakEquity - a.equity) / a.peakEquity * 100));
  a.paperOnly = true;
  a.liveTradingEnabled = false;
  a.updatedAt = now;
  return a;
}

export function processAutoPaperSignals(account, { signals, prices, now = new Date().toISOString() } = {}) {
  const a = markAutoPaperAccount(normalizeAutoPaperAccount(account, now), { prices, now });
  const candidates = Object.entries(signals || {}).filter(([symbol, signal]) =>
    AUTO_SYMBOLS.includes(symbol) && signal?.signal === true &&
    typeof signal.timestamp === "string" && Number.isFinite(Date.parse(signal.timestamp)) &&
    Number.isFinite(signal.atr) && signal.atr > 0 &&
    signal.timestamp !== a.lastProcessed[symbol]
  );
  const ranked = rankAutoPaperCandidates(signals, prices, a);
  a.lastCandidateRanking = ranked;
  const maximumDailyLoss = a.startingCapital * AUTO_CONFIG.maxDailyLossPct / 100;
  if (a.openPosition || a.dailyLoss >= maximumDailyLoss) {
    for (const [symbol, signal] of candidates) {
      if (finite(prices?.[symbol]) > 0) a.lastProcessed[symbol] = signal.timestamp;
    }
  } else {
    // Consume valid priced candidates for this scan so a second-best signal
    // cannot become a stale entry immediately after the first position closes.
    for (const candidate of ranked) a.lastProcessed[candidate.symbol] = candidate.signalAt;
    for (const candidate of ranked) {
      if (candidate.estimatedNetStopLossQuote > candidate.riskBudgetQuote + 1e-8 ||
          a.dailyLoss + candidate.estimatedNetStopLossQuote > maximumDailyLoss + 1e-8 ||
          candidate.entryCost > a.cash + 1e-8) continue;
      a.cash = round(a.cash - candidate.entryCost);
      a.openPosition = {
        id: candidate.symbol + "-" + candidate.signalAt,
        symbol: candidate.symbol,
        openedAt: now,
        signalAt: candidate.signalAt,
        entryPrice: candidate.entryPrice,
        quantity: candidate.quantity,
        entryFee: candidate.entryFee,
        entryCost: candidate.entryCost,
        stopPrice: candidate.stopPrice,
        trailingStop: candidate.stopPrice,
        targetPrice: candidate.targetPrice,
        atr: candidate.atr,
        highestPrice: candidate.entryPrice,
        strategy: "TREND_FOLLOWING_1H_V1",
        candidateRank: candidate.rank,
        rankingMethod: candidate.rankingMethod,
        riskBudgetQuote: candidate.riskBudgetQuote,
        estimatedNetStopLossQuote: candidate.estimatedNetStopLossQuote,
        estimatedNetTargetProfitQuote: candidate.estimatedNetTargetProfitQuote,
        rewardRiskAfterCosts: candidate.rewardRiskAfterCosts,
        riskBudgetUtilizationPct: candidate.riskBudgetUtilizationPct,
        status: "OPEN_PAPER_ONLY"
      };
      break;
    }
  }
  a.equity = round(a.cash + (a.openPosition
    ? liquidationValue(a.openPosition, prices?.[a.openPosition.symbol] || a.openPosition.entryPrice)
    : 0));
  a.peakEquity = Math.max(a.peakEquity || AUTO_CONFIG.startingCapital, a.equity);
  a.maxDrawdownPct = round(Math.max(a.maxDrawdownPct || 0, (a.peakEquity - a.equity) / a.peakEquity * 100));
  a.paperOnly = true;
  a.liveTradingEnabled = false;
  a.updatedAt = now;
  return a;
}

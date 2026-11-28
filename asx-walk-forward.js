// Chronological, fixed-rule ASX walk-forward research.
// Signals use only completed bars available at the prior close; simulated entries use the next daily open.
// This is deterministic research, not a trained predictive model or an execution route.
import {
  EDGE_MAX_POSITION_AUD, EDGE_MIN_CASH_RESERVE_AUD, EDGE_RISK_PER_TRADE_PCT,
  EDGE_STARTING_CAPITAL_AUD, estimateAsxSideCost, evaluateAsxSwingSetup
} from "./autonomous-engine.js";

const round2 = value => Math.round((value + Number.EPSILON) * 100) / 100;
const round4 = value => Math.round((value + Number.EPSILON) * 10000) / 10000;
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const SYDNEY_FORMATTER = new Intl.DateTimeFormat("en-AU", {
  timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23"
});

function sydneyClock(value) {
  const ms = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(ms)) return null;
  const parts = SYDNEY_FORMATTER.formatToParts(new Date(ms));
  const fields = Object.fromEntries(parts.filter(part => part.type !== "literal").map(part => [part.type, part.value]));
  return {
    date: fields.year + "-" + fields.month + "-" + fields.day,
    minutes: Number(fields.hour) * 60 + Number(fields.minute)
  };
}

function validateResearchClock(bars, now) {
  const nowMs = now instanceof Date ? now.getTime() : typeof now === "string" ? Date.parse(now) : Number(now);
  if (!Number.isFinite(nowMs)) throw new TypeError("A valid research as-of clock is required.");
  const latestMs = Date.parse(bars.at(-1).timestamp);
  if (latestMs > nowMs + 5 * 60_000) {
    throw new TypeError("Historical ASX data contains a future-dated daily bar relative to the research clock.");
  }
  const latestClock = sydneyClock(latestMs);
  const currentClock = sydneyClock(nowMs);
  if (!latestClock || !currentClock || latestClock.date > currentClock.date ||
      (latestClock.date === currentClock.date && currentClock.minutes < 17 * 60)) {
    throw new TypeError("The latest ASX daily bar may be incomplete; wait until 17:00 Sydney time or use the previous completed session.");
  }
  return nowMs;
}

function normalizeCosts(value = {}) {
  const costs = {
    commissionRate: value.commissionRate ?? 0.0008,
    minimumCommissionAud: value.minimumCommissionAud ?? 5,
    gstRate: value.gstRate ?? 0.1,
    slippageBps: value.slippageBps ?? 10
  };
  if (!Object.values(costs).every(item => Number.isFinite(item) && item >= 0)) {
    throw new TypeError("Walk-forward fee, GST and slippage assumptions must be finite non-negative numbers.");
  }
  return costs;
}

function normalizeBars(bars) {
  if (!Array.isArray(bars) || bars.length < 51 || bars.length > 5000) {
    throw new TypeError("At least 51 and no more than 5,000 completed daily bars are required.");
  }
  let previous = -Infinity;
  const sessionDates = new Set();
  return bars.map((bar, index) => {
    const timestamp = Date.parse(bar?.timestamp || "");
    const sessionDate = Number.isFinite(timestamp) ? sydneyClock(timestamp)?.date : null;
    const open = Number(bar?.open), high = Number(bar?.high);
    const low = Number(bar?.low), close = Number(bar?.close);
    if (!Number.isFinite(timestamp) || timestamp <= previous ||
        !sessionDate || sessionDates.has(sessionDate) ||
        ![open, high, low, close].every(Number.isFinite) ||
        open <= 0 || high <= 0 || low <= 0 || close <= 0 ||
        high < Math.max(open, close) || low > Math.min(open, close) || low > high) {
      throw new TypeError("Invalid, duplicate-session or unordered ASX OHLC bar at row " + (index + 1) + ".");
    }
    previous = timestamp;
    sessionDates.add(sessionDate);
    return {
      timestamp: new Date(timestamp).toISOString(),
      open: round4(open), high: round4(high), low: round4(low), close: round4(close)
    };
  });
}

function sizeAtNextOpen(candidate, entryPrice, cash, costs) {
  const stopPrice = candidate.stopPrice;
  const targetPrice = candidate.targetPrice;
  if (!Number.isFinite(entryPrice) || entryPrice <= stopPrice || entryPrice >= targetPrice) {
    return { accepted: false, reason: "Next-session open gapped through the stop or target; no paper entry was assumed." };
  }
  const riskBudgetAud = cash * EDGE_RISK_PER_TRADE_PCT;
  const maxSpendAud = Math.min(EDGE_MAX_POSITION_AUD, Math.max(0, cash - EDGE_MIN_CASH_RESERVE_AUD));
  const perShareRisk = entryPrice - stopPrice;
  let shares = Math.min(Math.floor(riskBudgetAud / perShareRisk), Math.floor(maxSpendAud / entryPrice));
  let notionalAud = 0, entryCost = null, stopCost = null, netStopLossAud = 0;
  while (shares >= 1) {
    notionalAud = shares * entryPrice;
    entryCost = estimateAsxSideCost(notionalAud, costs);
    stopCost = estimateAsxSideCost(shares * stopPrice, costs);
    if (!entryCost || !stopCost) return { accepted: false, reason: "Next-open transaction costs could not be calculated." };
    netStopLossAud = notionalAud - shares * stopPrice + entryCost.totalAud + stopCost.totalAud;
    if (notionalAud + entryCost.totalAud <= maxSpendAud + 0.01 &&
        netStopLossAud <= riskBudgetAud + 0.01) break;
    shares--;
  }
  if (shares < 1) return { accepted: false, reason: "No whole-share next-open position fits the unchanged 1% risk, AUD 200 allocation and cash-reserve controls after fees." };
  const targetCost = estimateAsxSideCost(shares * targetPrice, costs);
  if (!targetCost) return { accepted: false, reason: "Target-side transaction costs could not be calculated." };
  const netTargetProfitAud = shares * targetPrice - notionalAud - entryCost.totalAud - targetCost.totalAud;
  if (netTargetProfitAud + 1e-9 < 2 * netStopLossAud) {
    return { accepted: false, reason: "Next-open gap reduced the fee-adjusted reward/risk below 2:1." };
  }
  return {
    accepted: true, shares, entryPrice: round4(entryPrice),
    stopPrice, targetPrice, notionalAud: round2(notionalAud),
    entryCostsAud: entryCost.totalAud,
    netStopLossAud: round2(netStopLossAud),
    netTargetProfitAud: round2(netTargetProfitAud),
    debitAud: round2(notionalAud + entryCost.totalAud)
  };
}

function benchmarkFold(bars, startIndex, endIndex, startingCapitalAud, costs) {
  const entryPrice = bars[startIndex].open;
  const exitPrice = bars[endIndex - 1].close;
  const maxSpend = Math.min(EDGE_MAX_POSITION_AUD, Math.max(0, startingCapitalAud - EDGE_MIN_CASH_RESERVE_AUD));
  let shares = Math.floor(maxSpend / entryPrice);
  while (shares > 0) {
    const notional = shares * entryPrice;
    const entryCost = estimateAsxSideCost(notional, costs);
    if (entryCost && notional + entryCost.totalAud <= maxSpend + 0.01) break;
    shares--;
  }
  if (shares < 1) return { status: "NO_BENCHMARK_POSITION", returnPct: null, profitLossAud: null, shares: 0 };
  const notional = shares * entryPrice;
  const entryCost = estimateAsxSideCost(notional, costs);
  const exitCost = estimateAsxSideCost(shares * exitPrice, costs);
  if (!entryCost || !exitCost) return { status: "BENCHMARK_COST_ERROR", returnPct: null, profitLossAud: null, shares };
  const pnl = round2(shares * exitPrice - exitCost.totalAud - notional - entryCost.totalAud);
  return {
    status: "SIMULATED_BUY_AND_HOLD_REFERENCE",
    entryAt: bars[startIndex].timestamp,
    exitAt: bars[endIndex - 1].timestamp,
    shares,
    profitLossAud: pnl,
    returnPct: round4(pnl / startingCapitalAud * 100)
  };
}

function simulateFold({ bars, symbol, source, startIndex, endIndex, startingCapitalAud, costs }) {
  let cash = startingCapitalAud;
  let peak = startingCapitalAud;
  let maxDrawdownAud = 0;
  let maxDrawdownPct = 0;
  let maxIntradayAdverseDrawdownAud = 0;
  let maxIntradayAdverseDrawdownPct = 0;
  let signalIndex = startIndex - 1;
  let noSignalCount = 0;
  let screeningRejectCount = 0;
  let gapRejectCount = 0;
  let riskRejectCount = 0;
  const trades = [];

  while (signalIndex < endIndex - 1) {
    const signalBar = bars[signalIndex];
    const nextBar = bars[signalIndex + 1];
    const signalAvailableAt = Date.parse(signalBar.timestamp) + 10 * 60 * 60 * 1000;
    const candidate = evaluateAsxSwingSetup({
      symbol,
      bars: bars.slice(0, signalIndex + 1),
      source,
      currency: "AUD",
      observedAt: signalBar.timestamp,
      equityAud: cash,
      cashAud: cash,
      openPositions: 0,
      now: signalAvailableAt,
      costs
    });
    if (candidate.status !== "PAPER_CANDIDATE") {
      if (candidate.status === "NO_SIGNAL") noSignalCount++;
      else screeningRejectCount++;
      signalIndex++;
      continue;
    }

    const sizing = sizeAtNextOpen(candidate, nextBar.open, cash, costs);
    if (!sizing.accepted) {
      if (sizing.reason.includes("gapped")) gapRejectCount++;
      else riskRejectCount++;
      signalIndex++;
      continue;
    }

    const cashAfterEntry = round2(cash - sizing.debitAud);
    let exitIndex = endIndex - 1;
    let exitPrice = bars[exitIndex].close;
    let exitReason = "WINDOW_END";
    for (let index = signalIndex + 1; index < endIndex; index++) {
      const bar = bars[index];
      const stopHit = bar.low <= sizing.stopPrice;
      const targetHit = bar.high >= sizing.targetPrice;

      // Daily OHLC does not reveal the order of intraday highs and lows. Keep
      // close-to-close drawdown separate from a conservative adverse mark:
      // daily low while exposed, or the gap-aware stop fill on a stop-hit bar.
      const adverseMarkPrice = stopHit ? Math.min(sizing.stopPrice, bar.open) : bar.low;
      const adverseMarkValue = sizing.shares * adverseMarkPrice;
      const adverseExitCost = estimateAsxSideCost(adverseMarkValue, costs);
      const adverseEquity = adverseExitCost
        ? cashAfterEntry + adverseMarkValue - adverseExitCost.totalAud
        : cashAfterEntry;
      maxIntradayAdverseDrawdownAud = Math.max(
        maxIntradayAdverseDrawdownAud, peak - adverseEquity
      );
      if (peak > 0) {
        maxIntradayAdverseDrawdownPct = Math.max(
          maxIntradayAdverseDrawdownPct,
          (peak - adverseEquity) / peak * 100
        );
      }

      if (stopHit || targetHit) {
        exitIndex = index;
        const gapBelowStop = stopHit && bar.open < sizing.stopPrice;
        exitPrice = stopHit ? Math.min(sizing.stopPrice, bar.open) : sizing.targetPrice;
        exitReason = stopHit && targetHit
          ? gapBelowStop ? "STOP_FIRST_BOTH_TOUCHED_GAP_WORSE_OPEN" : "STOP_FIRST_BOTH_TOUCHED"
          : gapBelowStop
            ? "STOP_GAP_WORSE_OPEN"
            : stopHit ? "STOP" : "TARGET";
        break;
      }

      // Only mark at the daily close while the position is still open. On a
      // stop/target bar the simulated exit has already happened, so the later
      // close cannot create a fictitious equity peak or drawdown.
      const markedValue = sizing.shares * bar.close;
      const estimatedExitCost = estimateAsxSideCost(markedValue, costs);
      const markedEquity = estimatedExitCost
        ? cashAfterEntry + markedValue - estimatedExitCost.totalAud
        : cashAfterEntry;
      peak = Math.max(peak, markedEquity);
      maxDrawdownAud = Math.max(maxDrawdownAud, peak - markedEquity);
      if (peak > 0) maxDrawdownPct = Math.max(maxDrawdownPct, (peak - markedEquity) / peak * 100);
    }

    const exitValue = sizing.shares * exitPrice;
    const exitCost = estimateAsxSideCost(exitValue, costs);
    if (!exitCost) {
      riskRejectCount++;
      signalIndex = exitIndex + 1;
      continue;
    }
    const proceedsAud = round2(exitValue - exitCost.totalAud);
    const profitLossAud = round2(proceedsAud - sizing.debitAud);
    const nextCash = round2(cashAfterEntry + proceedsAud);
    if (!Number.isFinite(nextCash) || nextCash < 0) throw new Error("Walk-forward paper cash reconciliation failed.");
    trades.push({
      signalAt: signalBar.timestamp,
      entryAt: nextBar.timestamp,
      exitAt: bars[exitIndex].timestamp,
      entryPrice: sizing.entryPrice,
      exitPrice: round4(exitPrice),
      stopPrice: sizing.stopPrice,
      targetPrice: sizing.targetPrice,
      shares: sizing.shares,
      notionalAud: sizing.notionalAud,
      entryCostsAud: sizing.entryCostsAud,
      exitCostsAud: exitCost.totalAud,
      profitLossAud,
      exitReason,
      barsHeld: exitIndex - signalIndex
    });
    cash = nextCash;
    peak = Math.max(peak, cash);
    maxDrawdownAud = Math.max(maxDrawdownAud, peak - cash);
    if (peak > 0) maxDrawdownPct = Math.max(maxDrawdownPct, (peak - cash) / peak * 100);
    signalIndex = exitIndex + 1;
  }

  const wins = trades.filter(trade => trade.profitLossAud > 0);
  const losses = trades.filter(trade => trade.profitLossAud < 0);
  const grossProfit = wins.reduce((sum, trade) => sum + trade.profitLossAud, 0);
  const grossLoss = -losses.reduce((sum, trade) => sum + trade.profitLossAud, 0);
  const profitFactor = grossLoss > 0 ? round4(grossProfit / grossLoss) : null;
  const benchmark = benchmarkFold(bars, startIndex, endIndex, startingCapitalAud, costs);
  return {
    priorHistoryBars: startIndex,
    testBars: endIndex - startIndex,
    testStartAt: bars[startIndex].timestamp,
    testEndAt: bars[endIndex - 1].timestamp,
    tradeCount: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: trades.length ? round4(wins.length / trades.length * 100) : null,
    profitFactor,
    netProfitLossAud: round2(trades.reduce((sum, trade) => sum + trade.profitLossAud, 0)),
    returnPct: round4((cash - startingCapitalAud) / startingCapitalAud * 100),
    maxDrawdownAud: round2(maxDrawdownAud),
    maxDrawdownPct: round4(maxDrawdownPct),
    maxIntradayAdverseDrawdownAud: round2(maxIntradayAdverseDrawdownAud),
    maxIntradayAdverseDrawdownPct: round4(maxIntradayAdverseDrawdownPct),
    averageTradeProfitLossAud: trades.length ? round2(trades.reduce((sum, trade) => sum + trade.profitLossAud, 0) / trades.length) : null,
    benchmark,
    noSignalCount,
    screeningRejectCount,
    gapRejectCount,
    riskRejectCount,
    trades
  };
}

export function walkForwardAsxStrategy({
  symbol, bars, source, currency = "AUD",
  startingCapitalAud = EDGE_STARTING_CAPITAL_AUD,
  trainFraction = 0.6, foldCount = 3, minimumOutOfSampleTrades = 30,
  costs = {}, now = Date.now()
} = {}) {
  const ticker = String(symbol || "").toUpperCase();
  if (!/^[A-Z0-9.]{2,12}$/.test(ticker) || typeof source !== "string" || !source.trim() ||
      currency !== "AUD" || !Number.isFinite(startingCapitalAud) || startingCapitalAud <= 0 ||
      !Number.isFinite(trainFraction) || trainFraction < 0.5 || trainFraction > 0.8 ||
      !Number.isInteger(foldCount) || foldCount < 2 || foldCount > 6 ||
      !Number.isInteger(minimumOutOfSampleTrades) || minimumOutOfSampleTrades < 1) {
    throw new TypeError("Invalid ASX walk-forward symbol, source, AUD currency, capital or fold assumptions.");
  }
  const data = normalizeBars(bars);
  const asOf = validateResearchClock(data, now);
  const feeAssumptions = normalizeCosts(costs);
  const minimumHistoryBars = Math.max(51, Math.ceil(foldCount * 20 / (1 - trainFraction)));
  if (data.length < minimumHistoryBars) throw new TypeError("At least " + minimumHistoryBars + " daily bars are required for the selected prior-history and fold windows.");
  const testStartIndex = Math.floor(data.length * trainFraction);
  const testBars = data.length - testStartIndex;
  if (testStartIndex < 51 || testBars < foldCount * 20) {
    throw new TypeError("The selected history does not provide 51 prior bars and at least 20 out-of-sample bars per fold.");
  }

  const folds = [];
  for (let foldIndex = 0; foldIndex < foldCount; foldIndex++) {
    const startIndex = testStartIndex + Math.floor(foldIndex * testBars / foldCount);
    const endIndex = testStartIndex + Math.floor((foldIndex + 1) * testBars / foldCount);
    folds.push({
      fold: foldIndex + 1,
      ...simulateFold({
        bars: data, symbol: ticker, source, startIndex, endIndex,
        startingCapitalAud, costs: feeAssumptions
      })
    });
  }

  const trades = folds.flatMap(fold => fold.trades);
  const grossProfit = trades.filter(trade => trade.profitLossAud > 0).reduce((sum, trade) => sum + trade.profitLossAud, 0);
  const grossLoss = -trades.filter(trade => trade.profitLossAud < 0).reduce((sum, trade) => sum + trade.profitLossAud, 0);
  const meanFoldReturnPct = mean(folds.map(fold => fold.returnPct));
  const benchmarkReturns = folds.map(fold => fold.benchmark.returnPct).filter(Number.isFinite);
  const benchmarkCoverage = {
    availableFolds: benchmarkReturns.length,
    totalFolds: folds.length,
    complete: benchmarkReturns.length === folds.length
  };
  // Never compare all strategy folds with only a subset of benchmark folds.
  const meanBenchmarkReturnPct = benchmarkCoverage.complete ? mean(benchmarkReturns) : null;
  const meanFoldMaxDrawdownPct = mean(folds.map(fold => fold.maxDrawdownPct));
  const meanFoldIntradayAdverseDrawdownPct = mean(folds.map(fold => fold.maxIntradayAdverseDrawdownPct));
  const sortedReturns = folds.map(fold => fold.returnPct).sort((a, b) => a - b);
  const medianFoldReturnPct = sortedReturns.length ? sortedReturns[Math.floor(sortedReturns.length / 2)] : null;
  const pooledProfitFactor = grossLoss > 0 ? round4(grossProfit / grossLoss) : null;
  const pooledWinRatePct = trades.length
    ? round4(trades.filter(trade => trade.profitLossAud > 0).length / trades.length * 100)
    : null;
  const assessment = trades.length < minimumOutOfSampleTrades
    ? "INSUFFICIENT_OUT_OF_SAMPLE_TRADES"
    : benchmarkCoverage.complete && meanFoldReturnPct > 0 && meanBenchmarkReturnPct !== null &&
      meanFoldReturnPct > meanBenchmarkReturnPct && pooledProfitFactor !== null &&
      pooledProfitFactor > 1.2 && meanFoldMaxDrawdownPct < 10
      ? "CANDIDATE_FOR_EXTENDED_FORWARD_PAPER_REVIEW"
      : "NOT_PROVEN";

  return {
    strategy: "ASX_DAILY_TREND_BREAKOUT_NET_RR_V2",
    symbol: ticker,
    currency: "AUD",
    source,
    sourceVerification: "NOT_INDEPENDENTLY_VERIFIED",
    asOf: new Date(asOf).toISOString(),
    data: {
      bars: data.length,
      firstBarAt: data[0].timestamp,
      lastBarAt: data.at(-1).timestamp,
      priorHistoryFraction: trainFraction
    },
    methodology: "Expanding-history rolling-origin validation. Fixed 20/50-day trend and 20-session breakout rules; prior bars only; next-session open entries; re-sized positions under the existing 1% net-equity risk cap, AUD 200 position cap and AUD 100 cash reserve; modeled commission, GST and slippage; stop-first OHLC exits with worse-open gap handling; daily-low adverse drawdown proxy; window-end liquidation.",
    comparison: "Each fold resets the same virtual AUD capital. The benchmark is a separate AUD 200 allocation-capped buy-and-hold reference, not a risk-matched strategy. A pooled benchmark comparison is available only when every fold has a valid reference position.",
    parameterPolicy: "FIXED_RULES_NO_FITTING",
    startingCapitalAud,
    costAssumptions: feeAssumptions,
    folds,
    summary: {
      totalOutOfSampleTrades: trades.length,
      pooledWinRatePct,
      pooledProfitFactor,
      meanFoldReturnPct: meanFoldReturnPct === null ? null : round4(meanFoldReturnPct),
      medianFoldReturnPct: medianFoldReturnPct === null ? null : round4(medianFoldReturnPct),
      meanBenchmarkReturnPct: meanBenchmarkReturnPct === null ? null : round4(meanBenchmarkReturnPct),
      benchmarkCoverage,
      meanFoldMaxDrawdownPct: meanFoldMaxDrawdownPct === null ? null : round4(meanFoldMaxDrawdownPct),
      meanFoldIntradayAdverseDrawdownPct: meanFoldIntradayAdverseDrawdownPct === null ? null : round4(meanFoldIntradayAdverseDrawdownPct),
      positiveReturnFolds: folds.filter(fold => fold.returnPct > 0).length,
      foldCount,
      minimumOutOfSampleTrades,
      assessment
    },
    disclaimer: "This is a deterministic historical simulation, not a trained predictive model, executable fill record or profitability guarantee. Close-to-close drawdown is reported separately from a conservative daily-low adverse-drawdown proxy; daily OHLC cannot reconstruct the intraday price path. A partial buy-and-hold benchmark is not pooled or used to pass the assessment gate. Historical source labels and data-use rights are not independently verified. No sample data is generated or substituted.",
    liveTradingEnabled: false
  };
}

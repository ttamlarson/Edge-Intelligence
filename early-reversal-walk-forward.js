// Chronological, cost-adjusted research for the early-reversal shadow strategy.
// This module is deliberately isolated from the paper ledger and all exchange execution.
import { evaluateEarlyReversalShadow } from "./early-reversal-shadow.js";

const FOUR_HOURS = 4 * 60 * 60 * 1000;
const DAY = 6 * FOUR_HOURS;
const MINIMUM_HISTORY = 210;
const MINIMUM_OUT_OF_SAMPLE_TRADES = 30;
const STARTING_CAPITAL_AUD = 100;
const CONFIG = Object.freeze({
  feeRate: 0.001,
  slippageBps: 15,
  spreadBps: 50,
  riskBudgetPct: 0.5,
  maxAllocationPct: 25,
  maxDailyLossAud: 3,
  initialStopAtr: 2.5,
  trailingStopAtr: 3,
  maxHoldingBars: 180,
  minimumNotionalAud: 10
});
const round = value => Math.round((value + Number.EPSILON) * 100) / 100;
const finite = value => value === null || value === undefined || value === "" ? null : Number.isFinite(Number(value)) ? Number(value) : null;

function validateBars(candles, interval, label) {
  if (!Array.isArray(candles) || candles.length > 50000) {
    throw new Error(label + " must be a bounded candle array.");
  }
  let previous = -Infinity;
  return candles.map(candle => {
    const timestamp = Date.parse(candle?.timestamp || "");
    const open = finite(candle?.open), high = finite(candle?.high);
    const low = finite(candle?.low), close = finite(candle?.close);
    const volume = finite(candle?.volume);
    if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== candle.timestamp || timestamp % interval !== 0 || timestamp <= previous ||
        ![open, high, low, close, volume].every(Number.isFinite) ||
        Math.min(open, high, low, close) <= 0 || high < Math.max(open, close) ||
        low > Math.min(open, close) || high < low || volume < 0) {
      throw new Error(label + " contains invalid, unordered, incomplete or misaligned OHLCV data.");
    }
    previous = timestamp;
    return { timestamp: new Date(timestamp).toISOString(), open, high, low, close, volume };
  });
}

function latestContiguousRun(candles, interval) {
  let run = [];
  let gapCount = 0;
  for (const candle of candles) {
    if (run.length && Date.parse(candle.timestamp) - Date.parse(run.at(-1).timestamp) !== interval) {
      gapCount++;
      run = [];
    }
    run.push(candle);
  }
  return { candles: run, gapCount };
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

function closePosition(position, rawExit, reason, cash, executionCostBps, feeRate, bar) {
  const exitPrice = rawExit * (1 - executionCostBps / 10000);
  const grossProceeds = position.quantity * exitPrice;
  const exitFee = grossProceeds * feeRate;
  const proceeds = grossProceeds - exitFee;
  const pnl = proceeds - position.entryCost;
  return {
    cash: cash + proceeds,
    trade: {
      signalAt: position.signalAt,
      entryAt: position.entryAt,
      exitAt: bar.timestamp,
      entryModel: position.entryModel,
      entryPrice: round(position.entryPrice),
      exitPrice: round(exitPrice),
      quantity: Number(position.quantity.toFixed(10)),
      entryFeeAud: round(position.entryFee),
      exitFeeAud: round(exitFee),
      pnlAud: round(pnl),
      reason
    }
  };
}

function simulateFold({ candles, dailyCandles, startIndex, endIndex, spreadBps, feeRate, slippageBps }) {
  const cashStart = STARTING_CAPITAL_AUD;
  let cash = cashStart;
  let position = null;
  let dailyLoss = 0;
  let dailyLossDate = "";
  let peakEquity = cashStart;
  let maxDrawdownPct = 0;
  const trades = [];
  let feesPaidAud = 0;
  let blockedByDailyLoss = 0;
  let blockedByMinimumNotional = 0;
  const executionCostBps = slippageBps + spreadBps / 2;

  const markEquity = bar => {
    const liquidationValue = position
      ? position.quantity * bar.close * (1 - executionCostBps / 10000) * (1 - feeRate)
      : 0;
    const equity = cash + liquidationValue;
    peakEquity = Math.max(peakEquity, equity);
    if (peakEquity > 0) maxDrawdownPct = Math.max(maxDrawdownPct, (peakEquity - equity) / peakEquity * 100);
    return equity;
  };

  const recordClose = (rawExit, reason, bar) => {
    const closed = closePosition(position, rawExit, reason, cash, executionCostBps, feeRate, bar);
    cash = closed.cash;
    feesPaidAud += closed.trade.exitFeeAud + position.entryFee;
    if (closed.trade.pnlAud < 0) dailyLoss += -closed.trade.pnlAud;
    trades.push(closed.trade);
    position = null;
  };

  for (let i = startIndex; i < endIndex; i++) {
    const bar = candles[i];
    const date = bar.timestamp.slice(0, 10);
    if (date !== dailyLossDate) {
      dailyLossDate = date;
      dailyLoss = 0;
    }

    let closedThisBar = false;
    if (position) {
      const stop = position.stopPrice;
      if (bar.open <= stop) {
        recordClose(bar.open, "STOP_GAP", bar);
        closedThisBar = true;
      } else if (bar.low <= stop) {
        recordClose(stop, "STOP", bar);
        closedThisBar = true;
      } else {
        position.highestPrice = Math.max(position.highestPrice, bar.high);
        position.holdingBars++;
        const currentAtr = atr(candles.slice(Math.max(0, i - 20), i + 1), 20);
        if (Number.isFinite(currentAtr) && currentAtr > 0) {
          position.stopPrice = Math.max(position.stopPrice,
            position.highestPrice - CONFIG.trailingStopAtr * currentAtr);
        }
        if (position.holdingBars >= CONFIG.maxHoldingBars) {
          recordClose(bar.close, "MAX_HOLD", bar);
          closedThisBar = true;
        }
      }
    }

    // A signal is calculated only from the previous fully closed 4h bar.
    // Entry is at this bar's open, so no same-bar close or future data leaks in.
    if (!position && !closedThisBar && i > 0) {
      const signalIndex = i - 1;
      if (signalIndex >= MINIMUM_HISTORY - 1) {
        const signalBar = candles[signalIndex];
        const signalAsOf = Date.parse(signalBar.timestamp) + FOUR_HOURS;
        const completedDaily = dailyCandles
          .filter(candle => Date.parse(candle.timestamp) + DAY <= signalAsOf)
          .slice(-120);
        const historyStart = signalIndex - (MINIMUM_HISTORY - 1);
        const signalHistory = candles.slice(historyStart, signalIndex + 1);
        if (signalHistory.length === MINIMUM_HISTORY && completedDaily.length >= 60) {
          let signal = null;
          try {
            signal = evaluateEarlyReversalShadow({
              dailyCandles: completedDaily,
              fourHourCandles: signalHistory,
              asOf: signalAsOf,
              spreadBps
            });
          } catch {
            signal = null;
          }
          if (signal?.status === "SHADOW_CANDIDATE_PAPER_ONLY") {
            const equity = cash;
            const riskBudgetAud = Math.min(
              equity * CONFIG.riskBudgetPct / 100,
              Math.max(0, CONFIG.maxDailyLossAud - dailyLoss)
            );
            const allocationAud = Math.min(equity * CONFIG.maxAllocationPct / 100, cash);
            const entryPrice = bar.open * (1 + executionCostBps / 10000);
            const stopPrice = entryPrice - signal.risk.initialStopDistance;
            const entryCostPerUnit = entryPrice * (1 + feeRate);
            const stopExitPerUnit = stopPrice > 0
              ? stopPrice * (1 - executionCostBps / 10000) * (1 - feeRate)
              : Number.NaN;
            const riskPerUnit = entryCostPerUnit - stopExitPerUnit;
            const quantity = riskBudgetAud > 0 && allocationAud > 0 &&
              Number.isFinite(riskPerUnit) && riskPerUnit > 0 && stopPrice > 0
              ? Math.min(allocationAud / entryCostPerUnit, riskBudgetAud / riskPerUnit)
              : 0;
            const notional = quantity * entryPrice;
            const entryFee = notional * feeRate;
            const entryCost = notional + entryFee;
            if (dailyLoss >= CONFIG.maxDailyLossAud) {
              blockedByDailyLoss++;
            } else if (notional < CONFIG.minimumNotionalAud || entryCost > cash + 1e-8) {
              blockedByMinimumNotional++;
            } else {
              cash -= entryCost;
              position = {
                signalAt: signal.signalAt,
                entryAt: bar.timestamp,
                entryModel: signal.entryModel,
                entryPrice,
                quantity,
                entryFee,
                entryCost,
                stopPrice,
                highestPrice: entryPrice,
                holdingBars: 1
              };
              // The entry bar is checked against the initial stop, but a high
              // printed later in this bar only tightens the stop for the next bar.
              if (bar.open <= position.stopPrice) {
                recordClose(bar.open, "STOP_GAP", bar);
                closedThisBar = true;
              } else if (bar.low <= position.stopPrice) {
                recordClose(position.stopPrice, "STOP", bar);
                closedThisBar = true;
              } else {
                position.highestPrice = Math.max(position.highestPrice, bar.high);
                const currentAtr = atr(candles.slice(Math.max(0, i - 20), i + 1), 20);
                if (Number.isFinite(currentAtr) && currentAtr > 0) {
                  position.stopPrice = Math.max(position.stopPrice,
                    position.highestPrice - CONFIG.trailingStopAtr * currentAtr);
                }
              }
            }
          }
        }
      }
    }
    markEquity(bar);
  }

  if (position) {
    const finalBar = candles[endIndex - 1];
    recordClose(finalBar.close, "FOLD_END", finalBar);
    markEquity(finalBar);
  }

  const winners = trades.filter(trade => trade.pnlAud > 0);
  const losers = trades.filter(trade => trade.pnlAud < 0);
  const grossProfit = winners.reduce((sum, trade) => sum + trade.pnlAud, 0);
  const grossLoss = -losers.reduce((sum, trade) => sum + trade.pnlAud, 0);
  const endingEquityAud = round(cash);
  return {
    testBars: endIndex - startIndex,
    testStartAt: candles[startIndex].timestamp,
    testEndAt: candles[endIndex - 1].timestamp,
    trades: trades.length,
    wins: winners.length,
    losses: losers.length,
    winRatePct: trades.length ? round(winners.length / trades.length * 100) : null,
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss) : null,
    netPnlAud: round(endingEquityAud - cashStart),
    returnPct: round((endingEquityAud / cashStart - 1) * 100),
    maxDrawdownPct: round(maxDrawdownPct),
    feesPaidAud: round(feesPaidAud),
    grossProfitAud: round(grossProfit),
    grossLossAud: round(grossLoss),
    blockedByDailyLoss,
    blockedByMinimumNotional
  };
}

export function walkForwardEarlyReversalShadow({
  dailyCandles,
  fourHourCandles,
  market = "UNKNOWN",
  source = "coinspot_readonly_completed_orders",
  now = Date.now(),
  spreadBps = CONFIG.spreadBps,
  feeRate = CONFIG.feeRate,
  slippageBps = CONFIG.slippageBps,
  initialHistoryFraction = 0.6,
  foldCount = 3,
  minimumOutOfSampleTrades = MINIMUM_OUT_OF_SAMPLE_TRADES
} = {}) {
  const ticker = String(market || "").toUpperCase();
  const clock = now instanceof Date ? now.getTime()
    : typeof now === "string" ? Date.parse(now) : Number(now);
  if (!["BTC/AUD", "ETH/AUD"].includes(ticker) ||
      typeof source !== "string" || !source.trim() || source.length > 120 ||
      !Number.isFinite(clock) || ![spreadBps, feeRate, slippageBps, initialHistoryFraction].every(Number.isFinite) ||
      spreadBps < 0 || spreadBps > 50 || feeRate < 0 || feeRate > 0.02 ||
      slippageBps < 0 || slippageBps > 500 ||
      initialHistoryFraction < 0.5 || initialHistoryFraction > 0.8 ||
      !Number.isInteger(foldCount) || foldCount < 2 || foldCount > 6 ||
      !Number.isInteger(minimumOutOfSampleTrades) || minimumOutOfSampleTrades < 1) {
    throw new Error("Invalid early-reversal walk-forward market, source, cost or fold assumptions.");
  }

  const daily = validateBars(dailyCandles, DAY, "Daily history");
  const fourHour = validateBars(fourHourCandles, FOUR_HOURS, "Four-hour history");
  if (daily.some(candle => Date.parse(candle.timestamp) > clock) || fourHour.some(candle => Date.parse(candle.timestamp) > clock)) {
    throw new Error("Walk-forward data contains a future-dated four-hour candle.");
  }
  for (let i = 1; i < daily.length; i++) {
    if (Date.parse(daily[i].timestamp) - Date.parse(daily[i - 1].timestamp) !== DAY) {
      throw new Error("Daily walk-forward history must be contiguous; missing candles are never fabricated.");
    }
  }
  const completedDaily = daily.filter(candle => Date.parse(candle.timestamp) + DAY <= clock);
  const completedFourHour = fourHour.filter(candle => Date.parse(candle.timestamp) + FOUR_HOURS <= clock);
  const latestRun = latestContiguousRun(completedFourHour, FOUR_HOURS);
  const run = latestRun.candles;
  const history = {
    dailyCandles: completedDaily.length,
    fourHourCandles: completedFourHour.length,
    latestContiguousFourHourCandles: run.length,
    fourHourGapCount: latestRun.gapCount,
    firstFourHourAt: run[0]?.timestamp || null,
    lastFourHourAt: run.at(-1)?.timestamp || null,
    firstDailyAt: completedDaily[0]?.timestamp || null,
    lastDailyAt: completedDaily.at(-1)?.timestamp || null
  };
  const base = {
    strategy: "EDGE_MTF_EARLY_REVERSAL_SHADOW_V1",
    market: ticker,
    source,
    sourceVerification: "NOT_INDEPENDENTLY_VERIFIED",
    asOf: new Date(clock).toISOString(),
    history,
    costs: {
      feeRate,
      slippageBps,
      spreadBps,
      spreadAssumption: "FIXED_MAXIMUM_ALLOWED_SPREAD; historical bid/ask spreads are unavailable",
      executionCostBpsPerSide: round(slippageBps + spreadBps / 2)
    },
    parameters: {
      initialHistoryFraction,
      foldCount,
      minimumOutOfSampleTrades,
      startingCapitalAud: STARTING_CAPITAL_AUD,
      riskBudgetPct: CONFIG.riskBudgetPct,
      maxAllocationPct: CONFIG.maxAllocationPct,
      maxDailyLossAud: CONFIG.maxDailyLossAud,
      initialStopAtr: CONFIG.initialStopAtr,
      trailingStopAtr: CONFIG.trailingStopAtr,
      maximumHoldingDays: 30
    },
    execution: {
      orderIntent: "NONE",
      paperOnly: true,
      shadowOnly: true,
      eligibleForPaperLedger: false,
      liveTradingEnabled: false
    }
  };

  if (completedDaily.length < 60 || run.length < MINIMUM_HISTORY + foldCount * 20) {
    return {
      ...base,
      status: "INSUFFICIENT_HISTORY",
      summary: {
        totalOutOfSampleTrades: 0,
        assessment: "INSUFFICIENT_HISTORY",
        requiredDailyCandles: 60,
        requiredLatestContiguousFourHourCandles: MINIMUM_HISTORY + foldCount * 20
      },
      folds: [],
      limitations: [
        "Only complete, actual CoinSpot-derived candles are used.",
        "Four-hour gaps split the history; missing candles are never fabricated.",
        "No strategy parameters are fitted on the out-of-sample periods."
      ]
    };
  }

  const initialHistoryBars = Math.floor(run.length * initialHistoryFraction);
  const outOfSampleBars = run.length - initialHistoryBars;
  if (initialHistoryBars < MINIMUM_HISTORY || outOfSampleBars < foldCount * 20) {
    return {
      ...base,
      status: "INSUFFICIENT_HISTORY",
      summary: { totalOutOfSampleTrades: 0, assessment: "INSUFFICIENT_HISTORY" },
      folds: [],
      limitations: ["Not enough chronological history remains after the training/warm-up split."]
    };
  }

  const folds = [];
  for (let fold = 0; fold < foldCount; fold++) {
    const startIndex = initialHistoryBars + Math.floor(fold * outOfSampleBars / foldCount);
    const endIndex = initialHistoryBars + Math.floor((fold + 1) * outOfSampleBars / foldCount);
    folds.push({
      fold: fold + 1,
      ...simulateFold({
        candles: run,
        dailyCandles: completedDaily,
        startIndex,
        endIndex,
        spreadBps,
        feeRate,
        slippageBps
      })
    });
  }

  const totalTrades = folds.reduce((sum, fold) => sum + fold.trades, 0);
  const wins = folds.reduce((sum, fold) => sum + fold.wins, 0);
  const losses = folds.reduce((sum, fold) => sum + fold.losses, 0);
  const grossProfit = folds.reduce((sum, fold) => sum + fold.grossProfitAud, 0);
  const grossLoss = folds.reduce((sum, fold) => sum + fold.grossLossAud, 0);
  const pooledProfitFactor = grossLoss > 0 ? round(grossProfit / grossLoss) : null;
  const meanFoldReturnPct = folds.reduce((sum, fold) => sum + fold.returnPct, 0) / folds.length;
  const meanFoldDrawdownPct = folds.reduce((sum, fold) => sum + fold.maxDrawdownPct, 0) / folds.length;
  const positiveFolds = folds.filter(fold => fold.returnPct > 0).length;
  const assessment = totalTrades < minimumOutOfSampleTrades
    ? "INSUFFICIENT_OUT_OF_SAMPLE_TRADES"
    : meanFoldReturnPct > 0 && positiveFolds >= Math.ceil(foldCount * 2 / 3) &&
      pooledProfitFactor !== null && pooledProfitFactor > 1.2 && meanFoldDrawdownPct < 10
      ? "CANDIDATE_FOR_EXTENDED_FORWARD_PAPER_REVIEW"
      : "NOT_PROVEN_PROFITABLE";

  return {
    ...base,
    status: assessment === "CANDIDATE_FOR_EXTENDED_FORWARD_PAPER_REVIEW"
      ? "RESEARCH_CANDIDATE" : assessment,
    methodology: "Fixed early-reversal rules; signal on a completed 4h close; entry at the next 4h open; 0.1% fee per side, 15 bps slippage plus half of a conservative 50 bps spread per side; 0.5% equity risk budget, 25% allocation ceiling, A$3 daily loss cap, 2.5 ATR initial stop, 3 ATR trailing stop, and 30-day maximum hold. Stops use adverse gap fills and stop-first OHLC handling.",
    summary: {
      totalOutOfSampleTrades: totalTrades,
      wins,
      losses,
      winRatePct: totalTrades ? round(wins / totalTrades * 100) : null,
      pooledProfitFactor,
      meanFoldReturnPct: round(meanFoldReturnPct),
      meanFoldMaxDrawdownPct: round(meanFoldDrawdownPct),
      positiveReturnFolds: positiveFolds,
      foldCount,
      minimumOutOfSampleTrades,
      totalFeesPaidAud: round(folds.reduce((sum, fold) => sum + fold.feesPaidAud, 0)),
      assessment
    },
    folds,
    limitations: [
      "Historical bid/ask spreads are unavailable; the maximum permitted 50 bps spread is charged on every side.",
      "CoinSpot trade-derived OHLCV does not provide historical executable order-book depth or guaranteed fills.",
      "This deterministic backtest does not use AI to predict returns; any AI review remains advisory only.",
      "A research candidate would still require an extended forward paper sample; it cannot enter the production ledger or enable live trading."
    ]
  };
}

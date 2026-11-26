// Side-by-side chronological out-of-sample diagnostics for existing crypto strategies.
// This is a research screen only; it does not select, tune or execute a strategy.
const finite = value => typeof value === "number" && Number.isFinite(value) ? value : null;
const round2 = value => Math.round((value + Number.EPSILON) * 100) / 100;

function appendRow(rows, strategy, timeframe, sample, assessment, minimumOutOfSampleTrades, minimumProfitFactor, maximumDrawdownPct) {
  if (!sample || typeof sample !== "object") return;
  const trades = Number.isInteger(sample.trades) && sample.trades >= 0 ? sample.trades : 0;
  const netPnlQuote = finite(sample.netPnlQuote);
  const profitFactor = finite(sample.profitFactor);
  const maxDrawdownPct = finite(sample.maxDrawdownPct);
  const winRatePct = finite(sample.winRatePct);
  const returnPct = netPnlQuote === null ? null : round2(netPnlQuote);
  const commonScreen = trades < minimumOutOfSampleTrades
    ? "INSUFFICIENT_OUT_OF_SAMPLE_TRADES"
    : netPnlQuote === null || profitFactor === null || maxDrawdownPct === null
      ? "INCOMPLETE_OUT_OF_SAMPLE_METRICS"
      : netPnlQuote > 0 && profitFactor > minimumProfitFactor && maxDrawdownPct < maximumDrawdownPct
        ? "MEETS_COMMON_RESEARCH_SCREEN"
        : "DOES_NOT_MEET_COMMON_RESEARCH_SCREEN";
  rows.push({
    strategy,
    timeframe,
    outOfSampleTrades: trades,
    netPnlQuote,
    returnPct,
    winRatePct,
    profitFactor,
    maxDrawdownPct,
    window: {
      from: typeof sample.dateRange?.from === "string" ? sample.dateRange.from : null,
      to: typeof sample.dateRange?.to === "string" ? sample.dateRange.to : null
    },
    originalAssessment: typeof assessment === "string" ? assessment : "NOT_ASSESSED",
    commonScreen
  });
}

export function buildCryptoStrategyComparison({
  legacy, adaptive, breakout, trendFollowing,
  minimumOutOfSampleTrades = 30,
  minimumProfitFactor = 1.2,
  maximumDrawdownPct = 10
} = {}) {
  if (!Number.isInteger(minimumOutOfSampleTrades) || minimumOutOfSampleTrades < 1 ||
      !Number.isFinite(minimumProfitFactor) || minimumProfitFactor < 0 ||
      !Number.isFinite(maximumDrawdownPct) || maximumDrawdownPct <= 0) {
    throw new TypeError("Crypto strategy comparison thresholds are invalid.");
  }

  const strategies = [];
  appendRow(strategies, "EMA trend pullback", "1h", legacy?.outOfSample, legacy?.assessment,
    minimumOutOfSampleTrades, minimumProfitFactor, maximumDrawdownPct);
  appendRow(strategies, "Adaptive regime", "1h", adaptive?.outOfSample, adaptive?.assessment,
    minimumOutOfSampleTrades, minimumProfitFactor, maximumDrawdownPct);
  appendRow(strategies, "Active momentum", "1h", adaptive?.activeVariant?.outOfSample, adaptive?.activeVariant?.assessment,
    minimumOutOfSampleTrades, minimumProfitFactor, maximumDrawdownPct);
  appendRow(strategies, "Regime-adaptive breakout", "4h", breakout?.outOfSample, breakout?.assessment,
    minimumOutOfSampleTrades, minimumProfitFactor, maximumDrawdownPct);

  for (const timeframe of ["oneHour", "fourHour"]) {
    const model = trendFollowing?.[timeframe];
    for (const variant of model?.variants || []) {
      appendRow(strategies, "Trend following · " + String(variant.id || variant.label || "variant"), timeframe === "oneHour" ? "1h" : "4h",
        variant.outOfSample, variant.assessment, minimumOutOfSampleTrades, minimumProfitFactor, maximumDrawdownPct);
    }
  }

  return {
    status: strategies.length >= 2 ? "MULTI_STRATEGY_OOS_COMPARISON" : "LIMITED_STRATEGY_OOS_COMPARISON",
    method: "SEPARATE_CHRONOLOGICAL_70_30_OUT_OF_SAMPLE_SPLITS",
    strategyCount: strategies.length,
    minimumOutOfSampleTrades,
    commonScreenThresholds: {
      minimumProfitFactor,
      maximumDrawdownPct,
      rule: "At least the minimum trade count, positive net P&L, profit factor above the threshold and drawdown below the threshold."
    },
    meetsCommonResearchScreenCount: strategies.filter(row => row.commonScreen === "MEETS_COMMON_RESEARCH_SCREEN").length,
    strategies,
    sourceVerification: "NOT_INDEPENDENTLY_VERIFIED",
    interpretation: "The strategies use different indicators, timeframes, holding periods and risk settings. Their separate chronological holdouts are a screening comparison, not a statistically matched head-to-head test. Meeting the common screen supports further paper research only; it does not establish profitability or predict future returns."
  };
}

// EDGE autonomous ASX swing-trading foundation. Simulation only; never submits orders.
export const EDGE_STARTING_CAPITAL_AUD = 500;
export const EDGE_RISK_PER_TRADE_PCT = 0.01;
export const EDGE_MAX_POSITION_AUD = 200;
export const EDGE_MIN_CASH_RESERVE_AUD = 100;
export const EDGE_MAX_OPEN_POSITIONS = 2;
export const EDGE_COMMISSION_MIN_AUD = 5;
export const EDGE_GST_RATE = 0.10;
export const EDGE_DEFAULT_SLIPPAGE_BPS = 10;
export const EDGE_MAX_DAILY_BAR_AGE_MS = 36 * 60 * 60 * 1000;
const DEFAULT_ASX_COMMISSION_RATE = 0.0008;
const num = value => value === null || value === undefined || value === "" ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const round2 = value => Math.round((value + Number.EPSILON) * 100) / 100;
const roundPrice = value => Number.isFinite(value) ? Math.round((value + Number.EPSILON) * 10000) / 10000 : value;
const resolveAsxCostAssumptions = costs => {
  const supplied = costs ?? {};
  return {
    commissionRate: supplied.commissionRate === undefined ? DEFAULT_ASX_COMMISSION_RATE : supplied.commissionRate,
    minimumCommissionAud: supplied.minimumCommissionAud === undefined ? EDGE_COMMISSION_MIN_AUD : supplied.minimumCommissionAud,
    gstRate: supplied.gstRate === undefined ? EDGE_GST_RATE : supplied.gstRate,
    slippageBps: supplied.slippageBps === undefined ? EDGE_DEFAULT_SLIPPAGE_BPS : supplied.slippageBps
  };
};

// Parse only deterministic market-data date formats. Date-only CSV values use
// ISO YYYY-MM-DD or Australian DD/MM/YYYY; timestamps must carry an explicit
// timezone so browser locale settings cannot shift a trading session.
function parseAsxCsvDate(value) {
  const raw = String(value ?? "").trim();
  const calendarTimestamp = (year, month, day) => {
    if (![year, month, day].every(Number.isInteger) || year < 1900 || year > 9999) return null;
    const timestamp = Date.UTC(year, month - 1, day);
    const date = new Date(timestamp);
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
      ? timestamp
      : null;
  };

  let match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) return calendarTimestamp(Number(match[1]), Number(match[2]), Number(match[3]));

  match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) return calendarTimestamp(Number(match[3]), Number(match[2]), Number(match[1]));

  match = raw.match(/^(\d{4})-(\d{2})-(\d{2})T/);
  if (!match || calendarTimestamp(Number(match[1]), Number(match[2]), Number(match[3])) === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(raw)) return null;
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function asxCsvSessionDate(value) {
  const raw = String(value ?? "").trim();
  let match = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|T)/);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) return `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`;
  return null;
}

export function estimateAsxSideCost(tradeValueAud, { commissionRate = DEFAULT_ASX_COMMISSION_RATE, minimumCommissionAud = EDGE_COMMISSION_MIN_AUD, gstRate = EDGE_GST_RATE, slippageBps = EDGE_DEFAULT_SLIPPAGE_BPS } = {}) {
  const value = num(tradeValueAud);
  if (value === null || value <= 0 || ![commissionRate, minimumCommissionAud, gstRate, slippageBps].every(v => Number.isFinite(v) && v >= 0)) return null;
  const commission = Math.max(minimumCommissionAud, value * commissionRate);
  const gst = commission * gstRate;
  const slippage = value * slippageBps / 10000;
  const commissionAud = round2(commission);
  const gstAud = round2(gst);
  const slippageAud = round2(slippage);
  const totalAud = round2(commissionAud + gstAud + slippageAud);
  return { commissionAud, gstAud, slippageAud, totalAud };
}

export function validateDailyBars(bars, { source, currency, observedAt, now = Date.now(), maxAgeMs = EDGE_MAX_DAILY_BAR_AGE_MS } = {}) {
  if (!Array.isArray(bars) || bars.length < 51) return { valid: false, reason: "At least 51 daily bars are required." };
  if (typeof source !== "string" || !source.trim()) return { valid: false, reason: "A named market-data source is required." };
  if (currency !== "AUD") return { valid: false, reason: "Only explicitly denominated AUD instruments are eligible." };
  if (!Number.isFinite(now) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) return { valid: false, reason: "Market-data clock or freshness limit is invalid." };
  const timestamp = Date.parse(observedAt || "");
  if (!Number.isFinite(timestamp) || timestamp > now + 5 * 60_000 || now - timestamp > maxAgeMs) return { valid: false, reason: "Market data is missing, future-dated or stale." };
  const clean = bars.map(bar => ({
    open: num(bar?.open), close: num(bar?.close), high: num(bar?.high), low: num(bar?.low),
    timestamp: Date.parse(bar?.timestamp || "")
  }))
    .filter(bar => bar.open > 0 && bar.close > 0 && bar.high >= Math.max(bar.open, bar.close) &&
      bar.low > 0 && bar.low <= Math.min(bar.open, bar.close) && bar.low <= bar.high &&
      Number.isFinite(bar.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp);
  if (clean.length !== bars.length) return { valid: false, reason: "One or more daily bars failed OHLC validation." };
  for (let i = 1; i < clean.length; i++) if (clean[i].timestamp <= clean[i - 1].timestamp) return { valid: false, reason: "Daily bars must have unique increasing timestamps." };
  const latestBarTimestamp = clean.at(-1).timestamp;
  if (latestBarTimestamp > now + 5 * 60_000 || now - latestBarTimestamp > maxAgeMs) {
    return { valid: false, reason: "Latest daily bar is future-dated or stale." };
  }
  if (latestBarTimestamp > timestamp + 5 * 60_000) {
    return { valid: false, reason: "Latest daily bar is later than the source observation." };
  }
  return { valid: true, bars: clean, source, currency, observedAt: new Date(timestamp).toISOString() };
}

export function evaluateAsxSwingSetup({ symbol, bars, source, currency, observedAt, equityAud = EDGE_STARTING_CAPITAL_AUD, cashAud = equityAud, openPositions = 0, now = Date.now(), costs = {} } = {}) {
  const reject = reason => ({ status: "REJECTED", executable: false, simulatedOnly: true, symbol: String(symbol || "").toUpperCase(), observedAt: typeof observedAt === "string" ? observedAt : null, reason });
  if (!/^[A-Z0-9.]{2,12}$/.test(String(symbol || "").toUpperCase())) return reject("A valid ASX ticker is required.");
  const validated = validateDailyBars(bars, { source, currency, observedAt, now });
  if (!validated.valid) return reject(validated.reason);
  const equity = num(equityAud), cash = num(cashAud);
  if (equity === null || equity <= 0 || cash === null || cash < 0 || !Number.isInteger(openPositions) || openPositions < 0) return reject("Portfolio state is invalid.");
  if (openPositions >= EDGE_MAX_OPEN_POSITIONS) return reject("Maximum open positions reached.");
  const closes = validated.bars.map(bar => bar.close), last = closes.at(-1);
  const sma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const sma50 = closes.slice(-50).reduce((a, b) => a + b, 0) / 50;
  const priorHigh20 = Math.max(...closes.slice(-21, -1));
  const ranges = validated.bars.slice(-15).map((bar, index) => {
    const previousClose = validated.bars[validated.bars.length - 16 + index]?.close ?? bar.close;
    return Math.max(bar.high - bar.low, Math.abs(bar.high - previousClose), Math.abs(bar.low - previousClose));
  });
  const atr14 = ranges.slice(-14).reduce((a, b) => a + b, 0) / 14;
  if (!(last > sma20 && sma20 > sma50 && last > priorHigh20)) return { status: "NO_SIGNAL", executable: false, simulatedOnly: true, symbol: String(symbol).toUpperCase(), observedAt: validated.observedAt, reason: "Daily trend and 20-session breakout conditions are not all satisfied." };
  const entryPrice = roundPrice(last);
  const stopPrice = roundPrice(entryPrice - 2 * atr14);
  if (stopPrice <= 0 || stopPrice >= entryPrice) return reject("Volatility-based stop is invalid.");
  const riskBudget = equity * EDGE_RISK_PER_TRADE_PCT;
  const maxSpend = Math.min(EDGE_MAX_POSITION_AUD, Math.max(0, cash - EDGE_MIN_CASH_RESERVE_AUD));
  const perShareRisk = entryPrice - stopPrice;
  let shares = Math.min(Math.floor(riskBudget / perShareRisk), Math.floor(maxSpend / entryPrice));
  let notional = 0, buyCost = null, sellCost = null, targetSellCost = null, netStopLoss = 0, rawNetStopLoss = 0;
  while (shares >= 1) {
    notional = shares * entryPrice;
    buyCost = estimateAsxSideCost(notional, costs);
    sellCost = estimateAsxSideCost(shares * stopPrice, costs);
    if (!buyCost || !sellCost) return reject("Estimated transaction costs are invalid.");
    rawNetStopLoss = notional - shares * stopPrice + buyCost.totalAud + sellCost.totalAud;
    netStopLoss = round2(rawNetStopLoss);
    if (notional + buyCost.totalAud <= maxSpend + 0.01 && rawNetStopLoss <= riskBudget + 0.01) break;
    shares--;
  }
  if (shares < 1) return reject("No whole-share position fits the 1% net-equity risk budget and AUD 200 allocation cap after estimated fees.");

  // A fixed 2R gross target cannot meet a 2:1 NET reward/risk gate after
  // round-trip fees. Solve for the lowest four-decimal target that clears
  // 2:1 using the same commission, GST and slippage assumptions as the ledger.
  const requiredNetProfit = 2 * rawNetStopLoss;
  const netTargetAt = price => {
    const exitCost = estimateAsxSideCost(shares * price, costs);
    return exitCost ? shares * price - notional - buyCost.totalAud - exitCost.totalAud : Number.NEGATIVE_INFINITY;
  };
  let lower = entryPrice;
  let upper = entryPrice + 2 * perShareRisk;
  let expansions = 0;
  while (netTargetAt(upper) + 1e-9 < requiredNetProfit && expansions < 32) {
    upper = entryPrice + (upper - entryPrice) * 2;
    expansions++;
  }
  if (!Number.isFinite(upper) || netTargetAt(upper) + 1e-9 < requiredNetProfit) {
    return reject("A finite target meeting the 2:1 net reward/risk requirement cannot be found after estimated fees.");
  }
  for (let i = 0; i < 64; i++) {
    const middle = (lower + upper) / 2;
    if (netTargetAt(middle) >= requiredNetProfit) upper = middle;
    else lower = middle;
  }
  let targetPrice = Math.ceil((upper - 1e-10) * 10000) / 10000;
  targetSellCost = estimateAsxSideCost(shares * targetPrice, costs);
  let rawNetTargetProfit = targetSellCost ? shares * targetPrice - notional - buyCost.totalAud - targetSellCost.totalAud : Number.NEGATIVE_INFINITY;
  for (let i = 0; i < 3 && rawNetTargetProfit + 1e-9 < requiredNetProfit; i++) {
    targetPrice = roundPrice(targetPrice + 0.0001);
    targetSellCost = estimateAsxSideCost(shares * targetPrice, costs);
    rawNetTargetProfit = targetSellCost ? shares * targetPrice - notional - buyCost.totalAud - targetSellCost.totalAud : Number.NEGATIVE_INFINITY;
  }
  const targetValue = shares * targetPrice;
  const netTargetProfit = round2(rawNetTargetProfit);
  if (targetPrice <= entryPrice || rawNetStopLoss <= 0 || rawNetTargetProfit <= 0 || rawNetTargetProfit + 1e-9 < requiredNetProfit) return reject("Expected net reward after estimated costs is below the 2:1 minimum.");
  return { status: "PAPER_CANDIDATE", executable: false, simulatedOnly: true, strategy: "ASX_DAILY_TREND_BREAKOUT_NET_RR_V2", symbol: String(symbol).toUpperCase(), source: validated.source, currency: "AUD", observedAt: validated.observedAt, entryReference: entryPrice, stopPrice, targetPrice, shares, notionalAud: round2(notional), riskBudgetAud: round2(riskBudget), estimatedEntryCostsAud: buyCost.totalAud, estimatedNetTargetProfitAud: round2(netTargetProfit), estimatedNetStopLossAud: round2(netStopLoss), rewardRiskAfterCosts: round2(netTargetProfit / netStopLoss), assumptions: { commissionRate: costs.commissionRate ?? 0.0008, commissionMinimumAud: costs.minimumCommissionAud ?? EDGE_COMMISSION_MIN_AUD, gstRate: costs.gstRate ?? EDGE_GST_RATE, slippageBps: costs.slippageBps ?? EDGE_DEFAULT_SLIPPAGE_BPS, exitAtStopOrTarget: true }, reason: "Candidate passed deterministic screening; it is not an order or a prediction of profit." };
}

export function createPaperPortfolio({ capitalAud = EDGE_STARTING_CAPITAL_AUD } = {}) {
  const capital = num(capitalAud);
  const roundedCapital = capital === null ? null : round2(capital);
  if (capital === null || capital <= 0 || roundedCapital <= 0) throw new TypeError("Paper capital must be positive AUD after cent rounding.");
  return { mode: "PAPER_ONLY", currency: "AUD", startingCapitalAud: roundedCapital, cashAud: roundedCapital, positions: [], closedTrades: [], liveTradingEnabled: false };
}

export function openPaperPosition(portfolio, candidate, { id, openedAt = new Date().toISOString(), now = Date.now() } = {}) {
  if (!portfolio || portfolio.mode !== "PAPER_ONLY" || portfolio.liveTradingEnabled !== false) throw new TypeError("A simulation-only portfolio is required.");
  if (portfolio.currency !== "AUD" || !Array.isArray(portfolio.positions) || (portfolio.closedTrades !== undefined && !Array.isArray(portfolio.closedTrades)) || !Number.isFinite(portfolio.cashAud) || portfolio.cashAud < 0 || !Number.isFinite(portfolio.startingCapitalAud) || portfolio.startingCapitalAud <= 0) {
    return { accepted: false, reason: "Paper portfolio cash or ledger state is invalid." };
  }
  if (!candidate || candidate.status !== "PAPER_CANDIDATE" || candidate.executable !== false || candidate.simulatedOnly !== true) return { accepted: false, reason: "Only validated paper candidates can be opened." };

  const symbol = candidate.symbol;
  const candidateObservedTimestamp = Date.parse(candidate.observedAt || "");
  const aiReview = candidate.aiReview;
  if (aiReview !== undefined) {
    const provenance = aiReview?.inputProvenance;
    const reviewedTimestamp = Date.parse(aiReview?.reviewedAt || "");
    const validAiReview = aiReview?.status === "AI_APPROVED_PAPER_CANDIDATE" &&
      aiReview?.decision === "APPROVE" && Number.isFinite(aiReview?.confidence) &&
      aiReview.confidence >= 75 && aiReview.confidence <= 100 &&
      Number.isFinite(aiReview?.predictedWinProbability) &&
      aiReview.predictedWinProbability >= 0 && aiReview.predictedWinProbability <= 1 &&
      Array.isArray(aiReview?.riskFlags) && aiReview.riskFlags.length === 0 &&
      typeof aiReview?.model === "string" && aiReview.model.length > 0 &&
      typeof aiReview?.reviewId === "string" && aiReview.reviewId.length > 0 &&
      Number.isFinite(reviewedTimestamp) && reviewedTimestamp >= candidateObservedTimestamp && reviewedTimestamp <= now + 5 * 60_000 &&
      provenance?.currency === "AUD" && provenance?.source === candidate.source &&
      Date.parse(provenance?.observedAt || "") === Date.parse(candidate.observedAt || "") &&
      provenance?.sourceVerification === "NOT_INDEPENDENTLY_VERIFIED" &&
      Number.isInteger(provenance?.barsProvided) && provenance.barsProvided >= 51 &&
      provenance?.barsReviewed === 30 && provenance?.fingerprintAlgorithm === "SHA-256" &&
      typeof provenance?.fingerprint === "string" && /^[a-f0-9]{64}$/i.test(provenance.fingerprint) &&
      aiReview.reviewId.endsWith(provenance.fingerprint.slice(0, 16));
    if (!validAiReview) return { accepted: false, reason: "AI review provenance or approval metadata is invalid." };
  }
  const shares = num(candidate.shares), entryPrice = roundPrice(num(candidate.entryReference));
  const stopPrice = roundPrice(num(candidate.stopPrice)), targetPrice = roundPrice(num(candidate.targetPrice));
  const reportedNotional = num(candidate.notionalAud), notional = shares * entryPrice, entryCosts = num(candidate.estimatedEntryCostsAud);
  const observedAt = candidateObservedTimestamp, openedTimestamp = Date.parse(openedAt || "");
  if (typeof symbol !== "string" || !/^[A-Z0-9.]{2,12}$/.test(symbol) || candidate.currency !== "AUD" ||
      typeof candidate.source !== "string" || !candidate.source.trim() ||
      !Number.isFinite(observedAt) || !Number.isFinite(now) || observedAt > now + 5 * 60_000 || now - observedAt > EDGE_MAX_DAILY_BAR_AGE_MS) {
    return { accepted: false, reason: "Candidate provenance or freshness is invalid." };
  }
  if (!Number.isFinite(openedTimestamp) || openedTimestamp > now + 5 * 60_000 || openedTimestamp < observedAt - 5 * 60_000 ||
      (aiReview && Date.parse(aiReview.reviewedAt) > openedTimestamp)) {
    return { accepted: false, reason: "Opening timestamp must follow the source observation and cannot be future-dated." };
  }
  if (!Number.isInteger(shares) || shares < 1 ||
      entryPrice === null || entryPrice <= 0 || stopPrice === null || stopPrice <= 0 || stopPrice >= entryPrice ||
      targetPrice === null || targetPrice <= entryPrice || reportedNotional === null || reportedNotional <= 0 ||
      !Number.isFinite(notional) || round2(notional) !== round2(reportedNotional) || notional > EDGE_MAX_POSITION_AUD ||
      entryCosts === null || entryCosts < 0) {
    return { accepted: false, reason: "Candidate sizing or price levels are invalid." };
  }

  // Recalculate risk and all cost-sensitive reward figures at the point of
  // opening. A caller must not be able to mutate a screened candidate to
  // bypass the portfolio risk budget or the estimated entry/exit fees.
  const riskBudget = num(candidate.riskBudgetAud);
  const portfolioEquity = calculatePaperPortfolioEquity(portfolio);
  const assumptions = candidate.assumptions || {};
  const costs = {
    commissionRate: num(assumptions.commissionRate),
    minimumCommissionAud: num(assumptions.commissionMinimumAud),
    gstRate: num(assumptions.gstRate),
    slippageBps: num(assumptions.slippageBps)
  };
  if (riskBudget === null || riskBudget <= 0 ||
      !Object.values(costs).every(value => value !== null && value >= 0) ||
      !Number.isFinite(portfolioEquity) || portfolioEquity <= 0 ||
      riskBudget > round2(portfolioEquity * EDGE_RISK_PER_TRADE_PCT) + 0.01 ||
      shares * (entryPrice - stopPrice) > riskBudget + 0.01) {
    return { accepted: false, reason: "Candidate exceeds the paper portfolio risk budget or has invalid cost assumptions." };
  }
  const expectedEntryCost = estimateAsxSideCost(notional, costs);
  const expectedStopCost = estimateAsxSideCost(shares * stopPrice, costs);
  const expectedTargetCost = estimateAsxSideCost(shares * targetPrice, costs);
  if (!expectedEntryCost || !expectedStopCost || !expectedTargetCost ||
      round2(entryCosts) !== expectedEntryCost.totalAud) {
    return { accepted: false, reason: "Candidate entry costs do not match its declared fee assumptions." };
  }
  const rawNetTargetProfit = shares * targetPrice - notional - expectedEntryCost.totalAud - expectedTargetCost.totalAud;
  const rawNetStopLoss = notional - shares * stopPrice + expectedEntryCost.totalAud + expectedStopCost.totalAud;
  const netTargetProfit = round2(rawNetTargetProfit);
  const netStopLoss = round2(rawNetStopLoss);
  if (rawNetStopLoss <= 0 || rawNetStopLoss > riskBudget + 0.01 || rawNetTargetProfit + 1e-9 < 2 * rawNetStopLoss ||
      round2(num(candidate.estimatedNetTargetProfitAud)) !== netTargetProfit ||
      round2(num(candidate.estimatedNetStopLossAud)) !== netStopLoss ||
      round2(num(candidate.rewardRiskAfterCosts)) !== round2(netTargetProfit / netStopLoss)) {
    return { accepted: false, reason: "Candidate net reward/risk does not reconcile with its prices and fees." };
  }

  const openPositions = portfolio.positions.filter(position => position?.status === "OPEN_PAPER");
  if (openPositions.length >= EDGE_MAX_OPEN_POSITIONS || openPositions.some(position => position.symbol === symbol)) {
    return { accepted: false, reason: "Position limit or duplicate open symbol." };
  }
  const positionId = String(id || crypto.randomUUID());
  const knownIds = [...portfolio.positions, ...(portfolio.closedTrades || [])].map(position => position?.id);
  if (!positionId || knownIds.includes(positionId)) return { accepted: false, reason: "Paper position ID must be unique." };

  const debit = round2(notional + entryCosts);
  if (debit > EDGE_MAX_POSITION_AUD) return { accepted: false, reason: "Position plus entry costs exceeds the AUD 200 paper allocation cap." };
  if (debit > portfolio.cashAud - EDGE_MIN_CASH_RESERVE_AUD) return { accepted: false, reason: "Insufficient cash after preserving the minimum reserve." };
  const position = { id: positionId, symbol, shares, entryPrice, stopPrice, targetPrice, entryCostsAud: round2(entryCosts), entryCostBreakdown: { ...expectedEntryCost }, debitAud: debit, costAssumptions: costs, openedAt, status: "OPEN_PAPER", ...(aiReview ? { aiReview: { ...aiReview, inputProvenance: { ...aiReview.inputProvenance } } } : {}) };
  return {
    accepted: true,
    portfolio: { ...portfolio, cashAud: round2(portfolio.cashAud - debit), positions: [...portfolio.positions, position], closedTrades: portfolio.closedTrades || [] },
    position
  };
}

// Refresh open paper-position valuations from validated provider bars. This is
// valuation-only: it never changes cash, entry cost, realised P&L or trade status.
export function updatePaperMarksFromBars(portfolio, barsBySymbol, {
  source = "DataCedar ASX historical daily bars", currency = "AUD", now = Date.now(),
  maxAgeMs = EDGE_MAX_DAILY_BAR_AGE_MS
} = {}) {
  if (!portfolio || portfolio.mode !== "PAPER_ONLY" || portfolio.liveTradingEnabled !== false ||
      portfolio.currency !== "AUD" || !Array.isArray(portfolio.positions) || !Array.isArray(portfolio.closedTrades) ||
      !barsBySymbol || typeof barsBySymbol !== "object" || Array.isArray(barsBySymbol) ||
      typeof source !== "string" || !source.trim() || currency !== "AUD" ||
      !Number.isFinite(now) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
    return { accepted: false, portfolio, markedSymbols: [], skippedSymbols: [], reason: "Simulation-only portfolio, AUD source and valid symbol bars are required." };
  }
  let next = portfolio;
  const markedSymbols = [], skippedSymbols = [];
  for (const position of portfolio.positions.filter(item => item?.status === "OPEN_PAPER")) {
    const bars = barsBySymbol[position.symbol];
    const eligible = Array.isArray(bars) ? bars.filter(bar => {
      const timestamp = Date.parse(bar?.timestamp || "");
      const open = num(bar?.open), high = num(bar?.high), low = num(bar?.low), close = num(bar?.close);
      return Number.isFinite(timestamp) && timestamp <= now + 5 * 60_000 && now - timestamp <= maxAgeMs &&
        open !== null && open > 0 && high !== null && high >= Math.max(open, close) &&
        low !== null && low > 0 && close !== null && close > 0 &&
        low <= Math.min(open, close) && low <= high;
    }) : [];
    const latest = eligible.reduce((best, bar) =>
      !best || Date.parse(bar.timestamp) > Date.parse(best.timestamp) ? bar : best, null);
    const timestamp = Date.parse(latest?.timestamp || "");
    const price = num(latest?.close);
    if (!latest || !Number.isFinite(timestamp) || price === null || price <= 0) {
      skippedSymbols.push(position.symbol); continue;
    }
    const result = recordPaperMark(next, position.id, price, {
      markedAt: new Date(timestamp).toISOString(), now
    });
    if (!result.accepted) { skippedSymbols.push(position.symbol); continue; }
    next = result.portfolio;
    markedSymbols.push(position.symbol);
  }
  return { accepted: true, portfolio: next, markedSymbols, skippedSymbols, source };
}

export function parseAsxDailyCsv(csvText, { currency } = {}) {
  if (currency !== "AUD") return { valid: false, reason: "CSV currency must be explicitly confirmed as AUD." };
  if (typeof csvText !== "string" || csvText.length > 5_000_000) return { valid: false, reason: "CSV must be text under 5 MB." };
  const rows = []; let row = [], field = "", quoted = false, quoteClosed = false;
  const pushField = () => { row.push(field.trim()); field = ""; quoteClosed = false; };
  const pushRow = () => { pushField(); if (row.some(cell => cell !== "")) rows.push(row); row = []; };
  for (let i = 0; i < csvText.length; i++) {
    const ch = csvText[i];
    if (quoted) {
      if (ch === '"') {
        if (csvText[i + 1] === '"') { field += '"'; i++; }
        else { quoted = false; quoteClosed = true; }
      } else field += ch;
      continue;
    }
    if (quoteClosed) {
      if (ch === ",") pushField();
      else if (ch === "\n") pushRow();
      else if (ch === "\r" || ch === " " || ch === "\t") continue;
      else return { valid: false, reason: "CSV contains malformed quoting." };
      continue;
    }
    if (ch === '"') {
      if (field.trim() !== "") return { valid: false, reason: "CSV contains malformed quoting." };
      field = ""; quoted = true;
    } else if (ch === ",") pushField();
    else if (ch === "\n") pushRow();
    else if (ch !== "\r") field += ch;
  }
  if (quoted) return { valid: false, reason: "CSV contains an unterminated quoted field." };
  row.push(field.trim()); if (row.some(cell => cell !== "")) rows.push(row);
  if (rows.length < 2) return { valid: false, reason: "CSV needs a header and at least one data row." };
  const headers = rows.shift().map(x => x.replace(/^\uFEFF/, "").toLowerCase().replace(/[ _-]/g, ""));
  if (headers.some(header => !header) || new Set(headers).size !== headers.length) return { valid: false, reason: "CSV contains an empty or duplicate header column." };
  const resolveColumn = (...names) => {
    const matches = headers.flatMap((header, column) => names.includes(header) ? [column] : []);
    return matches.length === 1 ? matches[0] : matches.length === 0 ? -1 : -2;
  };
  const cols = { symbol: resolveColumn("symbol","ticker","code"), date: resolveColumn("date","timestamp","tradingdate"), open: resolveColumn("open"), high: resolveColumn("high"), low: resolveColumn("low"), close: resolveColumn("close") };
  const requiredColumns = Object.values(cols);
  if (requiredColumns.some(v => v === -2)) return { valid: false, reason: "CSV contains duplicate or ambiguous required columns." };
  if (requiredColumns.some(v => v === -1)) return { valid: false, reason: "Required columns: Symbol, Date, Open, High, Low, Close." };
  if (new Set(requiredColumns).size !== requiredColumns.length) return { valid: false, reason: "CSV contains duplicate or ambiguous required columns." };
  const grouped = {};
  const sessionDates = {};
  for (const cells of rows) {
    if (cells.length !== headers.length) return { valid: false, reason: "CSV row has an inconsistent column count." };
    const symbol = String(cells[cols.symbol] || "").trim().toUpperCase();
    const dateRaw = String(cells[cols.date] || "").trim();
    const date = parseAsxCsvDate(dateRaw);
    const sessionDate = asxCsvSessionDate(dateRaw);
    const validDate = Number.isFinite(date);
    const bar = { timestamp: validDate ? new Date(date).toISOString() : null, open: num(cells[cols.open]), high: num(cells[cols.high]), low: num(cells[cols.low]), close: num(cells[cols.close]) };
    if (!/^[A-Z0-9.]{2,12}$/.test(symbol) || !bar.timestamp || !sessionDate || [bar.open,bar.high,bar.low,bar.close].some(v => v === null || v <= 0) || bar.high < Math.max(bar.open,bar.close) || bar.low > Math.min(bar.open,bar.close) || bar.low > bar.high) return { valid: false, reason: "A row has an invalid ticker, date or OHLC value." };
    const sessions = sessionDates[symbol] ||= new Set();
    if (sessions.has(sessionDate)) return { valid: false, reason: "Duplicate daily bar detected." };
    sessions.add(sessionDate);
    (grouped[symbol] ||= []).push(bar);
  }
  const symbols = Object.keys(grouped);
  if (!symbols.length) return { valid: false, reason: "No valid ticker rows found." };
  for (const bars of Object.values(grouped)) {
    bars.sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp));
    for(let i=1;i<bars.length;i++) if(bars[i].timestamp===bars[i-1].timestamp) return {valid:false,reason:"Duplicate daily bar detected."};
  }
  return { valid: true, symbols: symbols.sort(), barsBySymbol: grouped, rows: Object.values(grouped).reduce((n,b)=>n+b.length,0), latestBar: Object.values(grouped).flat().reduce((a,b)=>a.timestamp>b.timestamp?a:b).timestamp };
}

export function closePaperPosition(portfolio, positionId, exitPrice, { closedAt = new Date().toISOString(), costs, now = Date.now(), exitType = "MANUAL_PAPER_CLOSE" } = {}) {
  if (!portfolio || portfolio.mode !== "PAPER_ONLY" || portfolio.liveTradingEnabled !== false) return { accepted: false, reason: "Simulation-only portfolio required." };
  if (portfolio.currency !== "AUD" || !Array.isArray(portfolio.positions) || !Array.isArray(portfolio.closedTrades) || !Number.isFinite(portfolio.cashAud) || portfolio.cashAud < 0) {
    return { accepted: false, reason: "Paper portfolio cash or trade history is invalid." };
  }
  if (!["MANUAL_PAPER_CLOSE", "AUTOMATED_PAPER_DAILY_BAR_EXIT"].includes(exitType)) return { accepted: false, reason: "Paper exit type is invalid." };
  const index = portfolio.positions.findIndex(p => p?.id === positionId && p.status === "OPEN_PAPER");
  if (index < 0) return { accepted: false, reason: "Open paper position not found." };
  const position = portfolio.positions[index], price = num(exitPrice);
  const openedTimestamp = Date.parse(position.openedAt || ""), closedTimestamp = Date.parse(closedAt || "");
  const lastMarkedTimestamp = position.lastMarkedAt ? Date.parse(position.lastMarkedAt) : openedTimestamp;
  if (!Number.isInteger(position.shares) || position.shares < 1 || !Number.isFinite(position.debitAud) || position.debitAud < 0 ||
      !Number.isFinite(openedTimestamp) || !Number.isFinite(lastMarkedTimestamp) || !Number.isFinite(closedTimestamp) || !Number.isFinite(now) ||
      closedTimestamp > now + 5 * 60_000 || closedTimestamp < Math.max(openedTimestamp, lastMarkedTimestamp)) {
    return { accepted: false, reason: "Open position or close timestamp is invalid, future-dated or precedes the latest mark." };
  }
  if (price === null || price <= 0) return { accepted: false, reason: "Exit price must be positive." };
  const normalizedPrice = roundPrice(price);
  const exitCostAssumptions = resolveAsxCostAssumptions(costs ?? position.lastMarkCostAssumptions ?? position.costAssumptions ?? {});
  const exitValue = position.shares * normalizedPrice, exitCost = estimateAsxSideCost(exitValue, exitCostAssumptions);
  if (!Number.isFinite(exitValue) || !exitCost) return { accepted: false, reason: "Exit costs could not be calculated." };
  const proceeds = round2(exitValue - exitCost.totalAud);
  const pnl = round2(proceeds - position.debitAud);
  const nextCash = round2(portfolio.cashAud + proceeds);
  // A minimum brokerage fee can exceed a very small exit value. Record the
  // resulting negative net proceeds rather than making the simulated trade
  // impossible to close; the portfolio itself must never overdraw.
  if (!Number.isFinite(proceeds) || !Number.isFinite(nextCash) || nextCash < 0) return { accepted: false, reason: "Close proceeds or resulting cash are invalid." };
  const closed = { ...position, status: "CLOSED_PAPER", exitPrice: normalizedPrice, exitValueAud: round2(exitValue), exitCostsAud: exitCost.totalAud, exitCostBreakdown: { ...exitCost }, exitCostAssumptions, proceedsAud: proceeds, profitLossAud: pnl, closedAt, exitType };
  const positions = portfolio.positions.slice(); positions[index] = closed;
  return { accepted: true, portfolio: { ...portfolio, cashAud: nextCash, positions, closedTrades: [...portfolio.closedTrades, closed] }, trade: closed };
}

export function markPaperPosition(position, markPrice, costs = position?.lastMarkCostAssumptions ?? position?.costAssumptions ?? {}) {
  const price = num(markPrice);
  if (!position || position.status !== "OPEN_PAPER" || price === null || price <= 0 ||
      !Number.isInteger(position.shares) || position.shares < 1 ||
      !Number.isFinite(position.debitAud) || position.debitAud < 0) return null;
  const normalizedPrice = roundPrice(price);
  const value = position.shares * normalizedPrice, sellCost = estimateAsxSideCost(value, resolveAsxCostAssumptions(costs));
  if (!Number.isFinite(value) || !sellCost) return null;
  const unrealizedProfitLossAud = round2(value - sellCost.totalAud - position.debitAud);
  if (!Number.isFinite(unrealizedProfitLossAud)) return null;
  return { markPrice: normalizedPrice, marketValueAud: round2(value), estimatedExitCostsAud: sellCost.totalAud, unrealizedProfitLossAud };
}

export function calculatePaperPortfolioEquity(portfolio) {
  if (!portfolio || portfolio.mode !== "PAPER_ONLY" || portfolio.liveTradingEnabled !== false ||
      portfolio.currency !== "AUD" || !Array.isArray(portfolio.positions) ||
      !Number.isFinite(portfolio.cashAud) || portfolio.cashAud < 0) return null;
  let equity = portfolio.cashAud;
  for (const position of portfolio.positions.filter(item => item?.status === "OPEN_PAPER")) {
    const mark = markPaperPosition(position, position.lastMarkPrice ?? position.entryPrice);
    if (!mark) return null;
    equity += mark.marketValueAud - mark.estimatedExitCostsAud;
  }
  return Number.isFinite(equity) ? round2(equity) : null;
}

// Persist a valuation-only mark for an open paper position. This never changes
// cash or realized trade history; it only updates the position's last mark.
export function recordPaperMark(portfolio, positionId, markPrice, {
  markedAt = new Date().toISOString(), costs, now = Date.now(), maxFutureSkewMs = 5 * 60_000
} = {}) {
  if (!portfolio || portfolio.mode !== "PAPER_ONLY" || portfolio.liveTradingEnabled !== false) {
    return { accepted: false, reason: "Simulation-only portfolio required." };
  }
  if (portfolio.currency !== "AUD" || !Array.isArray(portfolio.positions) || !Array.isArray(portfolio.closedTrades) ||
      !Number.isFinite(portfolio.cashAud) || portfolio.cashAud < 0) {
    return { accepted: false, reason: "Paper portfolio cash or trade history is invalid." };
  }
  const index = portfolio.positions.findIndex(position => position?.id === positionId && position.status === "OPEN_PAPER");
  if (index < 0) return { accepted: false, reason: "Open paper position not found." };

  const position = portfolio.positions[index];
  const openedTimestamp = Date.parse(position.openedAt || "");
  const markedTimestamp = Date.parse(markedAt || "");
  const previousMarkTimestamp = position.lastMarkedAt ? Date.parse(position.lastMarkedAt) : openedTimestamp;
  if (!Number.isFinite(openedTimestamp) || !Number.isFinite(markedTimestamp) ||
      !Number.isFinite(previousMarkTimestamp) || !Number.isFinite(now) ||
      !Number.isFinite(maxFutureSkewMs) || maxFutureSkewMs < 0 ||
      markedTimestamp > now + maxFutureSkewMs || markedTimestamp < openedTimestamp ||
      markedTimestamp < previousMarkTimestamp) {
    return { accepted: false, reason: "Paper mark timestamp is invalid, future-dated or earlier than the previous mark." };
  }

  const markCostAssumptions = resolveAsxCostAssumptions(costs ?? position.lastMarkCostAssumptions ?? position.costAssumptions ?? {});
  const mark = markPaperPosition(position, markPrice, markCostAssumptions);
  if (!mark) return { accepted: false, reason: "Paper mark price or position accounting is invalid." };
  const updatedPosition = {
    ...position,
    lastMarkPrice: mark.markPrice,
    lastMarkedAt: new Date(markedTimestamp).toISOString(),
    lastMarkCostAssumptions: markCostAssumptions
  };
  const positions = portfolio.positions.slice();
  positions[index] = updatedPosition;
  return {
    accepted: true,
    portfolio: { ...portfolio, positions },
    position: updatedPosition,
    mark
  };
}

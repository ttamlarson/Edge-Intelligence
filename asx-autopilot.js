import {
  calculatePaperPortfolioEquity, closePaperPosition, createPaperPortfolio,
  evaluateAsxSwingSetup, openPaperPosition, recordPaperMark
} from "./autonomous-engine.js";
import { fetchDataCedarBars, normalizeDataCedarSymbols } from "./datacedar.js";

const STORAGE_KEY = "asx-auto-paper-v1";
const MAX_SIGNAL_HISTORY = 100;
const MIN_SCAN_INTERVAL_MS = 6 * 60 * 60 * 1000;

function sydneyClock(timestamp) {
  const ms = typeof timestamp === "number" ? timestamp : Date.parse(timestamp);
  if (!Number.isFinite(ms)) return null;
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date(ms));
  const fields = Object.fromEntries(parts.filter(part => part.type !== "literal").map(part => [part.type, part.value]));
  return { date: `${fields.year}-${fields.month}-${fields.day}`, minutes: Number(fields.hour) * 60 + Number(fields.minute) };
}

export function isAsxDailyBarComplete(timestamp, now = Date.now()) {
  const barClock = sydneyClock(timestamp);
  const currentClock = sydneyClock(now);
  if (!barClock || !currentClock) return false;
  // DataCedar's ts_ms is the bar OPEN time. Do not use a bar whose Sydney
  // session date is today until 17:00 Sydney time (16:00 close + publication buffer).
  return barClock.date !== currentClock.date || currentClock.minutes >= 17 * 60;
}

function iso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("A valid scan clock is required.");
  return date.toISOString();
}

function initialSnapshot() {
  return {
    schemaVersion: 1,
    mode: "AUTOMATED_ASX_PAPER_ONLY",
    liveTradingEnabled: false,
    status: "WAITING_FOR_FIRST_SCAN",
    portfolio: createPaperPortfolio(),
    lastScanAt: null,
    lastBarBySymbol: {},
    signals: [],
    scanCount: 0
  };
}

export function calculateAsxPaperPerformance(portfolio) {
  if (!portfolio || portfolio.mode !== "PAPER_ONLY" || portfolio.liveTradingEnabled !== false ||
      !Number.isFinite(portfolio.startingCapitalAud) || portfolio.startingCapitalAud <= 0 ||
      !Array.isArray(portfolio.closedTrades)) {
    return { status: "INVALID_PAPER_LEDGER", tradeCount: 0 };
  }
  const rows = portfolio.closedTrades.filter(trade =>
    trade?.status === "CLOSED_PAPER" && Number.isFinite(trade.profitLossAud) &&
    Number.isFinite(Date.parse(trade.closedAt || "")));
  const trades = rows.slice().sort((a, b) => Date.parse(a.closedAt) - Date.parse(b.closedAt));
  const wins = trades.filter(trade => trade.profitLossAud > 0);
  const losses = trades.filter(trade => trade.profitLossAud < 0);
  const grossProfitAud = wins.reduce((sum, trade) => sum + trade.profitLossAud, 0);
  const grossLossAud = -losses.reduce((sum, trade) => sum + trade.profitLossAud, 0);
  const totalRealizedProfitLossAud = trades.reduce((sum, trade) => sum + trade.profitLossAud, 0);
  let equity = portfolio.startingCapitalAud;
  let peak = equity;
  let maxDrawdownAud = 0;
  for (const trade of trades) {
    equity += trade.profitLossAud;
    peak = Math.max(peak, equity);
    maxDrawdownAud = Math.max(maxDrawdownAud, peak - equity);
  }
  const tradeCount = trades.length;
  return {
    status: tradeCount < 30 ? "INSUFFICIENT_SAMPLE" : tradeCount < 100 ? "EARLY_SAMPLE" : "LARGER_SAMPLE_NOT_PROOF",
    tradeCount, invalidTradeCount: portfolio.closedTrades.length - tradeCount,
    wins: wins.length, losses: losses.length,
    winRatePct: tradeCount ? Math.round((wins.length / tradeCount) * 10000) / 100 : null,
    totalRealizedProfitLossAud: Math.round((totalRealizedProfitLossAud + Number.EPSILON) * 100) / 100,
    grossProfitAud: Math.round((grossProfitAud + Number.EPSILON) * 100) / 100,
    grossLossAud: Math.round((grossLossAud + Number.EPSILON) * 100) / 100,
    profitFactor: grossLossAud > 0 ? Math.round((grossProfitAud / grossLossAud) * 100) / 100 : null,
    averageWinAud: wins.length ? Math.round((grossProfitAud / wins.length + Number.EPSILON) * 100) / 100 : null,
    averageLossAud: losses.length ? Math.round((grossLossAud / losses.length + Number.EPSILON) * 100) / 100 : null,
    expectancyAud: tradeCount ? Math.round((totalRealizedProfitLossAud / tradeCount + Number.EPSILON) * 100) / 100 : null,
    maxRealizedDrawdownAud: Math.round((maxDrawdownAud + Number.EPSILON) * 100) / 100,
    maxRealizedDrawdownPct: peak > 0 ? Math.round((maxDrawdownAud / peak) * 10000) / 100 : null,
    basis: "CLOSED_TRADES_REALIZED_PNL_ONLY"
  };
}

function validateSnapshot(value) {
  if (!value || value.schemaVersion !== 1 || value.mode !== "AUTOMATED_ASX_PAPER_ONLY" ||
      value.liveTradingEnabled !== false || value.portfolio?.mode !== "PAPER_ONLY" ||
      value.portfolio?.liveTradingEnabled !== false || !Array.isArray(value.portfolio.positions) ||
      !Array.isArray(value.portfolio.closedTrades) || !value.lastBarBySymbol || typeof value.lastBarBySymbol !== "object" ||
      !Array.isArray(value.signals)) {
    throw new Error("Automated ASX paper ledger failed its safety validation.");
  }
  return value;
}

export async function readAsxAutopilot(env) {
  if (!env?.EDGE_KV) return { status: "BLOCKED_STORAGE_NOT_CONFIGURED", configured: false, liveTradingEnabled: false };
  const raw = await env.EDGE_KV.get(STORAGE_KEY);
  if (!raw) { const snapshot = initialSnapshot(); return { ...snapshot, configured: env.ASX_AUTOPILOT_ENABLED === "true", symbols: configuredSymbols(env), performance: calculateAsxPaperPerformance(snapshot.portfolio) }; }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error("Automated ASX paper ledger is invalid JSON."); }
  const snapshot = validateSnapshot(parsed);
  return { ...snapshot, configured: env.ASX_AUTOPILOT_ENABLED === "true", symbols: configuredSymbols(env), performance: calculateAsxPaperPerformance(snapshot.portfolio) };
}

function configuredSymbols(env) {
  if (env?.ASX_AUTOPILOT_ENABLED !== "true") return [];
  try { return normalizeDataCedarSymbols(env.ASX_AUTOPILOT_SYMBOLS || ""); }
  catch { return []; }
}

export async function runAsxAutopilot(env, { now = new Date(), fetchImpl = fetch } = {}) {
  const scannedAt = iso(now);
  const nowMs = Date.parse(scannedAt);
  if (env?.ASX_AUTOPILOT_ENABLED !== "true") return { status: "DISABLED", scannedAt, liveTradingEnabled: false, message: "Set ASX_AUTOPILOT_ENABLED=true only after confirming DataCedar access and data-use rights." };
  if (!env?.EDGE_KV) return { status: "BLOCKED_STORAGE_NOT_CONFIGURED", scannedAt, liveTradingEnabled: false };
  if (!env?.DATACEDAR_API_KEY) return { status: "BLOCKED_DATACEDAR_KEY_MISSING", scannedAt, liveTradingEnabled: false };
  let symbols;
  try { symbols = normalizeDataCedarSymbols(env.ASX_AUTOPILOT_SYMBOLS || ""); }
  catch (error) { return { status: "BLOCKED_SYMBOL_CONFIGURATION", scannedAt, liveTradingEnabled: false, message: error.message }; }

  const raw = await env.EDGE_KV.get(STORAGE_KEY);
  let snapshot;
  try { snapshot = raw ? validateSnapshot(JSON.parse(raw)) : initialSnapshot(); }
  catch { throw new Error("Automated ASX paper ledger is corrupt; scan stopped without overwriting it."); }
  const previousScanMs = Date.parse(snapshot.lastScanAt || "");
  if (Number.isFinite(previousScanMs) && nowMs - previousScanMs < MIN_SCAN_INTERVAL_MS) {
    return { ...snapshot, status: "SCAN_THROTTLED", configured: true, symbols, liveTradingEnabled: false, performance: calculateAsxPaperPerformance(snapshot.portfolio), message: "The next scheduled DataCedar scan is due after the six-hour provider-call interval." };
  }
  let data;
  try {
    data = await fetchDataCedarBars({ symbols, apiKey: env.DATACEDAR_API_KEY, fetchImpl, now: new Date(scannedAt) });
  } catch (error) {
    const lastError = String(error?.message || "DataCedar request failed.").slice(0, 240);
    const failed = {
      ...snapshot, status: "DATA_PROVIDER_ERROR", liveTradingEnabled: false,
      lastAttemptAt: scannedAt, lastError,
      failedScanCount: (Number.isInteger(snapshot.failedScanCount) ? snapshot.failedScanCount : 0) + 1
    };
    await env.EDGE_KV.put(STORAGE_KEY, JSON.stringify(failed));
    return { ...failed, configured: true, symbols, performance: calculateAsxPaperPerformance(snapshot.portfolio) };
  }

  let portfolio = snapshot.portfolio;
  const signals = [];
  const processed = { ...snapshot.lastBarBySymbol };
  let processedBarsThisScan = 0;
  let incompleteSessionBars = 0;
  const openSymbols = () => new Set(portfolio.positions.filter(p => p.status === "OPEN_PAPER").map(p => p.symbol));

  for (const symbol of symbols) {
    const bars = data.barsBySymbol?.[symbol] || [];
    if (bars.length && !isAsxDailyBarComplete(bars.at(-1).timestamp, nowMs)) {
      incompleteSessionBars++;
      signals.push({ symbol, status: "INCOMPLETE_CURRENT_SESSION_BAR_IGNORED", reason: "DataCedar timestamp maps to today's Sydney session; the daily candle is ignored until 17:00 Sydney time." });
    }
    const completedBars = bars.filter(bar => isAsxDailyBarComplete(bar.timestamp, nowMs));
    if (completedBars.length < 51) {
      signals.push({ symbol, status: "INSUFFICIENT_COMPLETED_HISTORY", bars: completedBars.length, reason: "At least 51 completed daily bars are required; current-session bars are excluded." });
      continue;
    }
    const latest = completedBars.at(-1);
    const latestMs = Date.parse(latest.timestamp);
    if (!Number.isFinite(latestMs) || latestMs > nowMs + 5 * 60_000 || nowMs - latestMs > 36 * 60 * 60 * 1000) {
      signals.push({ symbol, status: "STALE_DATA_REJECTED", reason: "Latest daily bar is outside the 36-hour freshness limit." });
      continue;
    }
    if (processed[symbol] && Date.parse(processed[symbol]) >= latestMs) continue;

    // Daily OHLC exits use conservative stop-first handling when both levels
    // are touched in the same candle. A gap below the stop uses the worse open.
    // The close is never treated as a fill.
    const exitedThisBar = new Set();
    for (const position of portfolio.positions.filter(p => p.status === "OPEN_PAPER" && p.symbol === symbol)) {
      const openedMs = Date.parse(position.openedAt || "");
      const markedMs = Date.parse(position.lastMarkedAt || position.openedAt || "");
      if (latestMs <= Math.max(openedMs, markedMs)) continue;
      const stopHit = latest.low <= position.stopPrice;
      const targetHit = latest.high >= position.targetPrice;
      if (stopHit || targetHit) {
        const exitPrice = stopHit ? Math.min(position.stopPrice, latest.open) : position.targetPrice;
        const closed = closePaperPosition(portfolio, position.id, exitPrice, {
          closedAt: latest.timestamp, now: nowMs
        });
        if (closed.accepted) {
          portfolio = closed.portfolio;
          exitedThisBar.add(symbol);
          signals.push({ symbol, status: "POSITION_CLOSED_PAPER", reason: stopHit && targetHit && latest.open < position.stopPrice ? "Stop and target touched; stop-first, with a gap-aware worse-open exit." : stopHit && targetHit ? "Stop and target touched; conservative stop-first resolution." : stopHit && latest.open < position.stopPrice ? "Price gapped below the stop; simulated exit uses the worse daily open." : stopHit ? "Daily low reached the paper stop." : "Daily high reached the paper target.", exitPrice, profitLossAud: closed.trade.profitLossAud, closedAt: latest.timestamp });
        }
      } else {
        const marked = recordPaperMark(portfolio, position.id, latest.close, { markedAt: latest.timestamp, now: nowMs });
        if (marked.accepted) portfolio = marked.portfolio;
      }
    }

    if (!openSymbols().has(symbol) && !exitedThisBar.has(symbol)) {
      const candidate = evaluateAsxSwingSetup({
        symbol, bars: completedBars, source: data.source, currency: data.currency, observedAt: latest.timestamp,
        equityAud: calculatePaperPortfolioEquity(portfolio) ?? 0,
        cashAud: portfolio.cashAud,
        openPositions: portfolio.positions.filter(p => p.status === "OPEN_PAPER").length,
        now: nowMs
      });
      if (candidate.status === "PAPER_CANDIDATE") {
        const opened = openPaperPosition(portfolio, candidate, {
          id: `asx-auto-${symbol}-${latest.timestamp.slice(0, 10)}`,
          openedAt: scannedAt, now: nowMs
        });
        if (opened.accepted) {
          portfolio = opened.portfolio;
          signals.push({ symbol, status: "OPENED_PAPER", observedAt: candidate.observedAt, reason: candidate.reason, entryReference: candidate.entryReference, shares: candidate.shares, openedAt: scannedAt });
        } else signals.push({ symbol, status: "OPEN_REJECTED", observedAt: candidate.observedAt, reason: opened.reason });
      } else {
        signals.push({ symbol, status: candidate.status, observedAt: candidate.observedAt, reason: candidate.reason });
      }
    }
    processed[symbol] = latest.timestamp;
    processedBarsThisScan++;
  }

  const next = {
    ...snapshot, schemaVersion: 1, mode: "AUTOMATED_ASX_PAPER_ONLY", liveTradingEnabled: false,
    status: data.rows === 0 ? "NO_DATA" : processedBarsThisScan > 0 ? "SCAN_COMPLETED" : incompleteSessionBars > 0 ? "WAITING_FOR_SESSION_CLOSE" : "NO_NEW_COMPLETED_BAR", portfolio, lastScanAt: scannedAt,
    lastAttemptAt: scannedAt, lastError: null,
    lastBarBySymbol: processed,
    signals: [...snapshot.signals, ...signals].slice(-MAX_SIGNAL_HISTORY),
    scanCount: snapshot.scanCount + 1,
    source: data.source, dataClass: data.dataClass, latestBar: data.latestBar,
    symbols, rowsBySymbol: data.rowsBySymbol
  };
  await env.EDGE_KV.put(STORAGE_KEY, JSON.stringify(next));
  return { ...next, performance: calculateAsxPaperPerformance(portfolio) };
}

export const __test = { STORAGE_KEY, initialSnapshot, validateSnapshot, configuredSymbols };

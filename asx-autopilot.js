import {
  calculatePaperPortfolioEquity, closePaperPosition, createPaperPortfolio,
  evaluateAsxSwingSetup, openPaperPosition, recordPaperMark
} from "./autonomous-engine.js";
import { fetchDataCedarBars, normalizeDataCedarSymbols } from "./datacedar.js";

const STORAGE_KEY = "asx-auto-paper-v1";
const MAX_SIGNAL_HISTORY = 100;
const MIN_SCAN_INTERVAL_MS = 6 * 60 * 60 * 1000;

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
  if (!raw) return { ...initialSnapshot(), configured: env.ASX_AUTOPILOT_ENABLED === "true", symbols: configuredSymbols(env) };
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error("Automated ASX paper ledger is invalid JSON."); }
  return { ...validateSnapshot(parsed), configured: env.ASX_AUTOPILOT_ENABLED === "true", symbols: configuredSymbols(env) };
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
    return { ...snapshot, status: "SCAN_THROTTLED", configured: true, symbols, liveTradingEnabled: false, message: "The next scheduled DataCedar scan is due after the six-hour provider-call interval." };
  }
  const data = await fetchDataCedarBars({ symbols, apiKey: env.DATACEDAR_API_KEY, fetchImpl, now: new Date(scannedAt) });

  let portfolio = snapshot.portfolio;
  const signals = [];
  const processed = { ...snapshot.lastBarBySymbol };
  const openSymbols = () => new Set(portfolio.positions.filter(p => p.status === "OPEN_PAPER").map(p => p.symbol));

  for (const symbol of symbols) {
    const bars = data.barsBySymbol?.[symbol] || [];
    if (bars.length < 51) {
      signals.push({ symbol, status: "INSUFFICIENT_HISTORY", bars: bars.length, reason: "At least 51 validated daily bars are required." });
      continue;
    }
    const latest = bars.at(-1);
    const latestMs = Date.parse(latest.timestamp);
    if (!Number.isFinite(latestMs) || latestMs > nowMs + 5 * 60_000 || nowMs - latestMs > 36 * 60 * 60 * 1000) {
      signals.push({ symbol, status: "STALE_DATA_REJECTED", reason: "Latest daily bar is outside the 36-hour freshness limit." });
      continue;
    }
    if (processed[symbol] && Date.parse(processed[symbol]) >= latestMs) continue;

    // Daily OHLC exits use conservative stop-first handling when both levels
    // are touched in the same candle. The close is never treated as a fill.
    for (const position of portfolio.positions.filter(p => p.status === "OPEN_PAPER" && p.symbol === symbol)) {
      const openedMs = Date.parse(position.openedAt || "");
      const markedMs = Date.parse(position.lastMarkedAt || position.openedAt || "");
      if (latestMs <= Math.max(openedMs, markedMs)) continue;
      const stopHit = latest.low <= position.stopPrice;
      const targetHit = latest.high >= position.targetPrice;
      if (stopHit || targetHit) {
        const exitPrice = stopHit ? position.stopPrice : position.targetPrice;
        const closed = closePaperPosition(portfolio, position.id, exitPrice, {
          closedAt: latest.timestamp, now: nowMs
        });
        if (closed.accepted) {
          portfolio = closed.portfolio;
          signals.push({ symbol, status: "POSITION_CLOSED_PAPER", reason: stopHit && targetHit ? "Stop and target touched; conservative stop-first resolution." : stopHit ? "Daily low reached the paper stop." : "Daily high reached the paper target.", exitPrice, profitLossAud: closed.trade.profitLossAud, closedAt: latest.timestamp });
        }
      } else {
        const marked = recordPaperMark(portfolio, position.id, latest.close, { markedAt: latest.timestamp, now: nowMs });
        if (marked.accepted) portfolio = marked.portfolio;
      }
    }

    if (!openSymbols().has(symbol)) {
      const candidate = evaluateAsxSwingSetup({
        symbol, bars, source: data.source, currency: data.currency, observedAt: latest.timestamp,
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
          signals.push({ symbol, status: "OPENED_PAPER", reason: candidate.reason, entryReference: candidate.entryReference, shares: candidate.shares, openedAt: scannedAt });
        } else signals.push({ symbol, status: "OPEN_REJECTED", reason: opened.reason });
      } else {
        signals.push({ symbol, status: candidate.status, reason: candidate.reason });
      }
    }
    processed[symbol] = latest.timestamp;
  }

  const next = {
    ...snapshot, schemaVersion: 1, mode: "AUTOMATED_ASX_PAPER_ONLY", liveTradingEnabled: false,
    status: "SCAN_COMPLETED", portfolio, lastScanAt: scannedAt,
    lastBarBySymbol: processed,
    signals: [...snapshot.signals, ...signals].slice(-MAX_SIGNAL_HISTORY),
    scanCount: snapshot.scanCount + 1,
    source: data.source, dataClass: data.dataClass, latestBar: data.latestBar,
    symbols, rowsBySymbol: data.rowsBySymbol
  };
  await env.EDGE_KV.put(STORAGE_KEY, JSON.stringify(next));
  return next;
}

export const __test = { STORAGE_KEY, initialSnapshot, validateSnapshot, configuredSymbols };

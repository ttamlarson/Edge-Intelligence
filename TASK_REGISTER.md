# EDGE task register — autonomous trading foundation

“Complete” describes code and deterministic tests only; it does not establish live data access, broker connectivity, legal eligibility or profitability.

## Autonomous trading — $500 AUD personal account

| Task | Status | Evidence / remaining boundary |
|---|---|---|
| Deterministic daily swing strategy foundation | Complete | 20/50-day trend filter, 20-session breakout, ATR-based stop/target; candidate only. Not validated as profitable. |
| $500 portfolio risk configuration | Complete | 1% equity risk budget, AUD 200 maximum position, AUD 100 minimum reserve, two concurrent positions, whole-share sizing. |
| ASX transaction-cost model | Complete | IBKR tier-one AUD 5 minimum commission, GST assumption and configurable slippage per side. Verify account tariff and pass-through charges. |
| Data provenance and freshness gate | Complete | Requires named source, AUD currency, observed timestamp within 36 hours, 51 valid daily OHLC bars. |
| Simulation-only position opening | Complete | Paper portfolio fixed to AUD and liveTradingEnabled=false; rejects executable/non-paper candidates. |
| Licensed ASX daily data integration | Not implemented | No ASX feed or licence configured. No live scan can run. |
| Automated scheduled ASX scanning | Not implemented | Requires verified source integration and scheduler. |
| Broker read-only account/portfolio adapter | Not implemented | IBKR account and API permissions not configured or verified. |
| Complete mark-to-market, exits and immutable trade ledger | Not implemented | Current module only opens paper positions; full lifecycle still required. |
| Out-of-sample backtest and walk-forward validation | Not implemented | Existing replay is descriptive only; no profitability claim. |
| Live order execution | Disabled by design | No order routes, credentials or broker integration. Do not enable in this phase. |

Existing application, Worker, Australian-source, PWA and security work remains intact. The new engine is additive and does not alter existing browser storage keys.

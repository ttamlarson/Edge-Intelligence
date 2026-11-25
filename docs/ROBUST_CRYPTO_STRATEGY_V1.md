# EDGE Robust Crypto Strategy V1 — Research Specification

**Status:** Research candidate only. Not deployed, not enabled for orders, and not claimed profitable.  
**Initial venue target:** CoinSpot spot markets, AUD quote.  
**Initial instruments:** BTC/AUD and ETH/AUD only, subject to verified market data and executable bid/ask availability.  
**Execution:** Paper-only until the full release gate in this document is passed and the operator separately authorises live trading.

## Objective

Do not optimise for the highest historical return. Select the simplest strategy that has a repeatable positive net expectancy, tolerable drawdown, low parameter sensitivity, and evidence that survives unseen data and realistic execution costs. No strategy can be guaranteed to be the most profitable in future markets.

## Candidate architecture: multi-timeframe trend + breakout ensemble

This replaces the existing single-timeframe EMA/RSI screen as the *primary research hypothesis*; it does not silently delete or overwrite the existing strategy.

### 1. Market regime gate

Evaluate only completed candles:

- 1-day close above the 100-day EMA.
- 4-hour EMA(50) above EMA(200).
- 4-hour EMA(200) slope positive over the prior 10 completed 4-hour bars.
- Skip entries when ATR(20) / close is outside pre-registered volatility bounds, or when data is stale, incomplete, duplicated, gapped, or inconsistent.

A bearish or sideways regime means hold cash. No shorting, leverage, margin, or derivatives in V1.

### 2. Entry ensemble

On completed 4-hour candles, calculate Donchian breakouts using the *prior* 20, 55, and 100 bars (exclude the current bar from each channel). A breakout vote is true only when the completed close is above that prior channel high.

Require at least two of the three breakout votes, the regime gate above, and a minimum liquidity / spread gate. Enter no earlier than the next executable quote/bar. Never use the signal candle's close as an assumed fill.

RSI is diagnostic, not a hard optimiser knob. Do not add more indicators unless an ablation test shows stable incremental out-of-sample benefit after costs.

### 3. Exit ensemble

- Initial protective stop: 2.5 × ATR(20) below the actual simulated entry fill.
- Trailing stop: highest completed 4-hour close since entry minus 3 × ATR(20).
- Trend exit: close below the 4-hour EMA(50), or daily regime gate turns off.
- Time exit: 30 days maximum, unless a pre-registered test shows a robust reason to change it.
- If a candle touches both stop and target, use conservative stop-first ordering. A gap through a stop fills at the worse available open/quote, not at the stop price.
- Stops are not guaranteed fills. Paper simulation must model latency, spread, slippage, partial fills, rejected orders, and fees.

### 4. Portfolio and risk controls

- Spot only; no borrowing or leverage.
- Maximum initial risk budget: 0.5% of current net liquidation equity per position.
- Maximum notional allocation: 25% of equity per asset.
- Maximum simultaneous positions: 1 during the initial AUD 100 validation phase.
- Portfolio daily realised + unrealised loss circuit breaker: pause new entries at 2% of start-of-day equity. The previously configured AUD 20 daily loss is an emergency ceiling, not a routine loss budget; it must never be used as a target.
- Stop trading after 3 consecutive losing trades pending review.
- Never increase size to recover losses. Recompute sizing from current equity and actual stop distance.
- Reject trades where minimum order size, fees, spread, slippage, or price precision make the intended risk budget impossible.
- Missing or stale data, unverified instrument mapping, failed account reconciliation, clock drift, or unavailable risk state means fail closed.

### 5. Costs and execution model

For every backtest and paper fill, charge both entry and exit costs. Use venue-specific CoinSpot fee schedules and observed bid/ask spreads, not a generic exchange assumption. Model additional slippage and delayed execution; run at least base, 1.5×, and 2× cost stress tests. If verified CoinSpot historical OHLCV and quote data are unavailable, mark the result as provisional and do not infer live profitability from Binance USDT candles.

## Research protocol — no cherry-picking

1. Use independently sourced, timestamped, gap-checked history. Record source, market, quote currency, timezone, collection time, and data-use rights.
2. Freeze a small, pre-registered parameter grid. No repeated ad-hoc tuning on the final test set.
3. Use nested chronological walk-forward evaluation. Keep a final untouched holdout that is opened once after model selection is frozen.
4. Compare against cash and a cost-matched buy-and-hold benchmark. Report both absolute return and risk-adjusted return; compare drawdowns on a like-for-like basis.
5. Include every fee, spread, slippage, delayed fill, rejected order, and stop-gap assumption.
6. Report net return, CAGR where sample length supports it, Sharpe, Sortino, Calmar, max drawdown, exposure, turnover, win rate, average win/loss, profit factor, trade count, and fold-by-fold results.
7. Estimate uncertainty using block bootstrap / confidence intervals and correct for multiple configurations (e.g. Deflated Sharpe / probability of backtest overfitting). Do not select a strategy merely because it has the highest in-sample return.
8. Stress-test parameter neighbourhoods, alternate market regimes, double costs, and one-bar execution delay.
9. Run a forward paper test with recorded expected versus observed quotes/fills before any live decision.

## Promotion gates

A strategy may only be promoted from research to extended paper testing if all are true:

- At least 100 completed out-of-sample trades across a sufficiently broad and representative sample; report per-market results so one asset cannot hide another's failure.
- Positive net expectancy after verified venue costs.
- Pooled out-of-sample profit factor > 1.2 and no single fold dominates total profits.
- Out-of-sample max drawdown below the pre-registered 10% strategy limit.
- Positive results remain under 1.5× costs; 2× costs must not create catastrophic loss or risk-limit breaches.
- Bootstrap uncertainty and multiple-testing correction do not indicate that the apparent edge is indistinguishable from noise.
- No look-ahead, survivorship, leakage, stale-price, or data-integrity defects.
- At least 30 days of forward paper execution with no unexplained order/ledger mismatches and sufficient fills to assess execution quality.

These are minimum screening gates, not proof of future profitability. Passing them only authorises a further review, not live trading.

## AI's role

AI may summarise market regimes, explain signals, identify anomalies, and challenge assumptions. It cannot invent trades, override deterministic risk limits, adjust position sizes, or bypass data/execution checks. Strategy signals, sizing, stops, and order permissions remain deterministic and auditable.

## Live release gate

Live execution remains disabled. Any later live release requires a separate explicit operator approval after independent review of the final holdout, forward-paper results, exact CoinSpot order behaviour, credentials/scope, idempotency, reconciliation, kill switch, and maximum-loss controls. Start with the smallest venue-permitted order; do not assume AUD 100 is enough to satisfy minimum order sizes and fees.

## Research rationale and cautions

- The 2025 paper *Catching Crypto Trends* studies a multi-lookback Donchian trend ensemble and volatility-based sizing; its results motivate testing this family, not assuming its published performance will transfer to CoinSpot or EDGE.
- A 2023 Monash study reports that transaction costs materially affect crypto trend-following results.
- Recent 2026 research on crypto factors highlights how frictionless, full-sample optimisation can substantially overstate apparent performance. This is why EDGE must prefer cost-aware, out-of-sample robustness over a single high-return backtest.

References:
- https://concretumgroup.com/wp-content/uploads/2026/02/Catching-Crypto-Trends.pdf
- https://www.monash.edu/__data/assets/pdf_file/0011/3744821/Trend-following-Strategies-for-Crypto-Investors.pdf
- https://papers.ssrn.com/sol3/papers.cfm?abstract_id=7350238
- https://papers.ssrn.com/sol3/Delivery.cfm/6795938.pdf?abstractid=6795938&mirid=1

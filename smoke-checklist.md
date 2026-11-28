# EDGE deployment smoke checklist

## Automated CI validation
- [x] GitHub Actions `npm test` passed all 59 deterministic tests on commit `9f3729722f3583bae5a9baf5d14fff0fc044122e` (2026-11-15).
- [x] GitHub Actions `npm run check` passed JavaScript syntax checks on the same commit.
- [x] GitHub Actions `npm run build:pages` completed successfully on the same commit.
- [x] CI verified `dist/autonomous-engine.js` exists in the static build.
- [ ] Re-run CI after the PWA offline-cache and project-path fixes in this branch; do not treat earlier green CI as validation of later commits.
- [ ] Download and inspect the CI static-site artifact after it is produced.

## ASX autonomous paper desk
- [ ] Import a broker-authorised ASX daily OHLC CSV, confirm the source, explicitly attest AUD denomination and data-use rights, then verify timestamps, all four OHLC values and ticker grouping.
- [x] Automated tests reject missing/incorrect AUD confirmation, malformed quoting, adjusted-close-only files, malformed OHLC including Open, duplicate sessions, impossible ISO/Australian dates, timezone-less and unsupported timestamps, missing provenance, non-AUD, stale/future individual daily bars with fresh observation metadata, and invalid freshness-clock configuration.
- [x] Automated tests cover UTF-8 BOM headers, properly quoted fields, Australian DD/MM/YYYY parsing and ISO timestamps with explicit timezone offsets.
- [x] Automated tests cover CSV import (AUD attestation, BOM, quoting, Australian/ISO dates, duplicate rows, ambiguous semantic aliases, mixed-timezone duplicate sessions and missing Close), signal screening (breakout and 20/50-day trend gates), fee-inclusive 1% risk sizing, current net liquidation equity, position opening chronology, duplicate-symbol rejection, four-decimal price precision, marking without cash movement, latest-mark fee assumptions reused at close, component-to-total fee reconciliation, fee-aware closing, negative net proceeds, cash reconciliation, closed-trade history and re-entry after close.
- [x] Failed CSV replacement imports clear prior in-memory candidates before parsing and on read/parse failure; existing browser portfolio storage is not reset.
- [ ] Operator decision required before expecting default-cost candidates: the 2×ATR stop / 4×ATR target cannot satisfy the 2:1 net reward/risk gate after positive fees, and AUD 500 × 1% is below the minimum round-trip commission and GST.
- [ ] Complete a browser-level import/open/mark/close walkthrough with authorised market data.
- [x] Automated tests confirm there is no broker order execution path in the ASX paper engine.

## Static app and PWA
- [x] Static Pages build copies all required application assets, including `autonomous-engine.js`.
- [x] Service-worker shell now includes `autonomous-engine.js` for offline ASX paper-desk module loading.
- [x] Service-worker cache version incremented to invalidate the previous shell.
- [x] Manifest identity, start URL and scope are relative to support a project Pages path such as `/Edge-Intelligence/`.
- [ ] After the Cloudflare Pages workflow is merged and succeeds, verify https://edge-intelligence-486.pages.dev serves the site over HTTPS and applies the intended security headers.
- [ ] Complete standalone install on supported desktop/mobile browsers.
- [ ] Verify service-worker update activation and offline reload on a clean HTTPS browser profile.
- [ ] Confirm existing `edge-intelligence-v1`, `edge-forecasts-v1` and `edge-alert-rules-v1` browser storage remains unchanged after deployment.

## Integrations requiring backend account configuration
- [ ] Configure Worker bindings, Cloudflare Access, exact CORS origins and secrets.
- [ ] Call authenticated `/api/health`; treat it as configuration status, not proof that external providers work.
- [ ] Test Prediction.com with configured account entitlement, and Manifold search/pagination. Record venue, quote type, currency, jurisdiction, source timestamp and retrieval timestamp.
- [ ] Test actual RBA cash-rate and RSS parsing through the deployed Worker and compare against official sources.
- [ ] Obtain/configure ABS API key and verify a selected official dataflow and observation periods.
- [ ] Do not enable BOM records until distribution rights are confirmed.
- [ ] Keep AEC results empty until registered feed access and HTTPS ingestion are deployed and verified.
- [ ] Keep ASX market data absent until a suitable data licence is established; FEX remains non-integrated until product/API access is verified.
- [ ] Confirm user alert thresholds are isolated by authenticated user.
- [ ] Confirm no provider secret appears in static output, browser storage, logs or error responses.

## Release boundary
- This branch is research and paper simulation only. It does not connect to a broker, submit orders, or enable real-money trading.
- Cloudflare Pages publication, PR merge and production cutover remain separate actions; do not infer deployment from a successful build.


## DataCedar ASX connector smoke checks

- [ ] Confirm the Worker has the `DATACEDAR_API_KEY` secret; do not expose its value in browser code or logs.
- [ ] Call `GET /api/asx/datacedar/status` and confirm it reports the key configured without claiming data retrieval is verified.
- [ ] Fetch one ASX ticker (for example BHP), then two or three tickers; confirm returned bars are AUD, daily, raw-adjustment, timestamped and source-attributed.
- [ ] Try an unknown ticker and a ticker with no coverage; confirm EDGE reports provider errors or an empty series without sample-price substitution.
- [ ] Confirm more than three tickers, invalid dates and date windows over 366 days are rejected.
- [ ] Confirm fetching data alone does not change cash, positions, marks, closed trades or the `edge-asx-paper-v1` storage key.
- [ ] Open a candidate only by using its separate paper-trading action; confirm no broker route is called.


## CoinSpot live execution preparation (still locked)

- [x] Durable Object class allocates monotonically increasing nonces transactionally.
- [x] Durable idempotency reservations reject key reuse with a changed order intent.
- [x] Authenticated Worker routes scope coordinator state to the Cloudflare Access user.
- [x] Coordinator request bodies are bounded and malformed requests fail closed.
- [ ] Configure the Worker secret EDGE_COORDINATOR_TOKEN; never place its value in source control.
- [ ] Deploy the Worker and verify Durable Object migration and authenticated coordinator routes.
- [ ] Implement a separate least-privilege CoinSpot trading-key adapter; existing read-only keys must remain read-only.
- [ ] Implement exchange order-status/fill reconciliation, balance reservations, timeout/unknown-order recovery and emergency kill switch.
- [ ] Obtain trustworthy hourly BTC/AUD and ETH/AUD OHLCV history with source provenance; current public quote endpoint is not an hourly candle feed.
- [ ] Run chronological out-of-sample validation and independently review costs, drawdown and trade count.
- [ ] Complete at least 60 days of forward paper trading with immutable server-side trade/equity records.
- [ ] Require explicit operator activation after all release gates; live order submission stays disabled until then.


## Automated ASX paper autopilot (feature branch)

- [ ] Confirm data-use rights and that the DataCedar plan covers the chosen ASX symbols.
- [ ] Configure `ASX_AUTOPILOT_ENABLED=true`, `ASX_AUTOPILOT_SYMBOLS` (1–3 tickers), `DATACEDAR_API_KEY` as a Worker secret, and the existing `EDGE_KV` binding.
- [ ] Call authenticated `GET /api/asx/autopilot`; confirm configuration is reported separately from verified retrieval.
- [ ] Call authenticated `POST /api/asx/autopilot/scan`; verify actual DataCedar source, AUD denomination, daily timeframe, timestamps and returned symbol coverage.
- [ ] Confirm repeated cron invocations within six hours are throttled and do not reprocess a daily candle.
- [ ] Confirm open paper positions are marked only from newer daily bars and same-candle stop/target hits resolve stop-first.
- [ ] Confirm the automated KV ledger is separate from the device-local `edge-asx-paper-v1` account and that both remain paper-only.
- [ ] Confirm default fees/risk gates are not bypassed when candidates are rejected; no forced entries or real-money order routes exist.
- [ ] Verify Worker scheduled logs and the deployed UI only after approved merge/deployment.

- [ ] Simulate a DataCedar timeout, 401 or 429; confirm `DATA_PROVIDER_ERROR`, bounded error text and incremented failure count are persisted without advancing the successful scan cursor.

- [ ] During ASX trading hours, confirm the current Sydney-date daily bar is excluded until 17:00 Sydney time (including daylight-saving changes); verify the scanner uses only the latest completed bar.


## ASX research validation (paper only)

- Import an authorised AUD daily OHLC dataset with at least 150 completed bars for a ticker; verify the source label and date range shown in the walk-forward report.
- Run chronological walk-forward validation. Confirm each fold reports prior-history and test windows, next-session-open entry timestamps, modeled costs, stop-first exits, a buy-and-hold reference and a separate reset virtual account.
- Confirm datasets shorter than the minimum history, unordered timestamps, invalid OHLC and non-AUD assumptions are rejected.
- Confirm fewer than 30 pooled out-of-sample trades is labelled insufficient and never presented as evidence of profitability.
- For automated AI review, verify strict structured output, SHA-256 bar fingerprint, model/review ID, subjective confidence and separate uncalibrated win-probability fields.
- Close an AI-reviewed position through the automated daily-bar stop/target path and confirm the review metadata survives in trade history. Confirm manual closes are excluded from AI calibration diagnostics.
- Confirm the AI calibration report uses the latest chronological holdout, reports Brier/reliability diagnostics, and remains explicitly uncalibrated / not model-trained.
- Confirm all paper controls remain authoritative: 1% risk budget, AUD 200 position cap, AUD 100 cash reserve, fees and no live order route.
- Confirm each new AI review records the DataCedar source URL, retrieval time, exchange, AUD currency, daily timeframe, raw adjustment mode, historical-data classification, symbol set and per-symbol provider row count.
- Change one provider metadata field or one reviewed OHLC bar and verify the SHA-256 evidence fingerprint changes; confirm the full digest is embedded in and revalidated against the review ID before paper opening.
- Confirm the requested model alias and provider-returned model ID are stored separately, with provider response ID, review-policy version, request-start time and completion time.
- Delay the AI response in a test and verify the paper position opening timestamp is at or after review completion, never the request start.
- Return empty/boilerplate thesis or counter-thesis, invalid source URL, stale retrieval timestamp, missing symbol coverage or insufficient provider row count; confirm the AI reviewer fails closed and does not consume the completed-bar cursor for retryable provider failures.
- Seed trades with the same model but different review-policy versions; confirm calibration keeps separate chronological cohorts and does not pool the metrics. Legacy reviews remain grouped as unversioned.


## EDGE MTF Donchian breakout candidate

- [ ] Verify the multi-timeframe engine rejects incomplete, non-contiguous and invalid daily/four-hour OHLCV series.
- [ ] Confirm daily EMA100, four-hour EMA50/EMA200 and positive EMA200 slope use only completed candles.
- [ ] Confirm Donchian 20/55/100 highs exclude the signal candle and at least two breakout votes are required.
- [ ] Confirm spread above 50 bps, insufficient volume and out-of-range ATR/price all produce NO_TRADE.
- [ ] Verify sizing respects 0.5% risk and 25% allocation ceilings after fees and venue minimums.
- [ ] Confirm stop/trailing/time exits use conservative stop-first and gap handling in the eventual backtester.
- [ ] Confirm the module never submits orders and liveTradingEnabled remains false.
- [ ] Do not promote to paper execution until verified CoinSpot AUD daily/four-hour data, venue costs, next-quote fills, chronological out-of-sample tests and forward paper evidence are available.


## CoinSpot-native MTF strategy integration

- [ ] Verify Read Only API key can access `/orders/market/completed` for BTC/AUD and ETH/AUD.
- [ ] Verify HMAC signature and nonce ordering on repeated historical requests.
- [ ] Verify historical fetch splits saturated windows and never saves truncated results.
- [ ] Confirm candles are derived only from actual CoinSpot AUD completed orders; missing 4h/daily intervals are not filled. The strategy may use a newer contiguous tail after an older gap, but must not bridge or fabricate the missing interval.
- [ ] Confirm 110 completed daily and 210 completed 4h candles in the latest contiguous runs plus freshness and spread checks are required before any candidate signal; verify exact gap timestamps and contiguous counts are surfaced when blocked.
- [ ] Confirm strategy status is authenticated, rate-limited, and never places an exchange order.
- [ ] Confirm scheduled backfill advances one UTC day per 15-minute cron and preserves history on errors.


## CoinSpot MTF paper runtime remediation

- [x] Branch CI passed the read-only allowlist, retry, timeout, fee/slippage sizing, daily-loss and global-lease regression tests on commit `8e3b144c` (2026-11-27 10:18 UTC).
- [x] Regression test covers the 20-minute global Durable Object lease, exclusivity beyond 15 minutes, expiry recovery and owner-only release of a successor lease.
- [ ] After Worker deployment, call authenticated `GET /api/crypto/coinspot/readonly/status`; it must report `AUTHENTICATED` and `READ_ONLY` without exposing key material.
- [ ] Call authenticated `POST /api/crypto/coinspot/strategy/sync` or wait for the 15-minute schedule; confirm the response reports raw buy/sell counts and accepted BTC/AUD or ETH/AUD trades.
- [ ] Confirm a transient transport failure retries once with a higher nonce and records `COINSPOT_TIMEOUT` or `COINSPOT_NETWORK_ERROR` rather than silently advancing the history cursor.
- [ ] Confirm each persisted candle is derived from validated CoinSpot BTC/AUD or ETH/AUD completed orders, with no fabricated missing buckets.
- [ ] Confirm the paper ledger remains AUD 100, live trading disabled, no more than one open position, 0.5% round-trip-cost-aware risk, 25% allocation and AUD 3 daily-loss cap including unrealized losses.
- [ ] Confirm current quotes are still fetched during history warm-up so existing positions remain marked and stop-managed, and new positions immediately reflect bid-side fees/slippage in equity and daily loss.
- [ ] Do not call the engine operational until at least 110 completed daily and 210 completed four-hour candles per market are fresh, contiguous and validated; then complete forward paper validation before any separate live-trading decision.


### CoinSpot runtime subrequest and history-integrity checks

- [ ] Verify scheduled runner processes exactly one historical UTC day per 15-minute invocation and stays below Cloudflare's subrequest limit.
- [ ] Verify provider diagnostics are sampled no more than once per 24 hours.
- [ ] Verify recursive completed-order history requests stop at the 15-request per-market/day safety budget and do not advance incomplete dates.
- [ ] Inject non-empty but malformed CoinSpot completed-order rows; verify `COINSPOT_HISTORY_SCHEMA_MISMATCH`, persisted cursor remains unchanged, and no candle is written.
- [ ] Confirm dense-day history partitions return accepted normalized trades before a date is marked complete; never accept a capped partial daily response.

- [ ] Verify each half-day epoch probe returns only trades inside its requested UTC interval; check `outOfRangeTrades` remains zero.
- [ ] Confirm a saturated full-day response with empty child partitions fails as `COINSPOT_HISTORY_PARTITION_EMPTY` and preserves the date cursor.

- [ ] Verify full-day and 12-hour probes count only trades within their requested UTC range; any out-of-range record must be diagnosed and rejected by the backfill.

- [ ] Seed legacy state with a non-empty raw batch and zero accepted trades; verify the cursor rewinds exactly one prior UTC day once, persists the marker, and does not rewind repeatedly after a failed request.


### CoinSpot isolated cron schedule

- [ ] Verify :00 runs other research providers without CoinSpot MTF.
- [ ] Verify :15, :30 and :45 run CoinSpot MTF alone and avoid the shared subrequest limit.
- [ ] Verify the current 97-day backfill remains within the 24–48-hour target at three days per hour.

- [ ] Compare numeric seconds, string seconds and millisecond timestamps for each 12-hour history window; adopt only a representation with validated in-range BTC/AUD or ETH/AUD trades.

- [ ] Confirm sub-day millisecond epoch queries return valid in-range trades before any seconds-based fallback is attempted.

- [ ] Verify the one-time full-history migration resets only derived BTC/ETH candle caches and trade counters, preserves the paper ledger, and begins at `today - 120` exactly once.


## CoinSpot MTF ledger paper-only marker
- [ ] Confirm persisted MTF account reports `paperOnly: true` and `liveTradingEnabled: false`.
- [ ] Confirm a legacy account with no `paperOnly` marker is upgraded on its next scan.
- [ ] Confirm an explicit `paperOnly: false` ledger is rejected without resetting cash, positions or trade history.


## CoinSpot MTF AUD pair guard
- [ ] Confirm only exact BTC/AUD and ETH/AUD market + quote pairs are accepted for paper entries and position marks.
- [ ] Confirm BTC/USDT and ETH/USDT mismatches are rejected without changing the paper ledger.
- [ ] Confirm persisted positions and closed trades with non-AUD pair labels fail validation.

## 2026-11-26 — Research and paper-ledger hardening

- [ ] Confirm existing ASX and automated crypto ledgers with no paper-only marker are upgraded additively and retain cash, positions, closed trades and scan cursors.
- [ ] Seed an explicit `paperOnly: false` ASX or crypto ledger; verify the scan/API fails closed and stored bytes remain unchanged.
- [ ] Confirm new ASX and crypto ledgers persist `paperOnly: true` and `liveTradingEnabled: false`.
- [ ] Verify ASX review fingerprints change when candidate metrics or reviewed daily bars change, and review IDs differ by model version for the same evidence.
- [ ] Verify ASX probability reliability bins include Wilson 95% intervals and subjective confidence bands are labeled descriptive, not calibrated probabilities.
- [ ] Import a multi-year hourly crypto dataset and verify the comparison table includes each available 1h/4h strategy variant, each OOS window and the common research screen; insufficient-history variants must remain absent rather than receive fabricated metrics.
- [ ] Verify crypto candidate ranking uses net stop/target outcomes after fees, spread and slippage, and the chosen quantity does not exceed modeled remaining per-trade or daily-loss risk.
- [ ] Remove a candidate quote while retaining its valid signal; verify its timestamp is not consumed and the same signal can be retried when a valid quote arrives.
- [ ] Verify a valid priced candidate blocked by an open position or daily-loss pause is consumed and cannot become a stale later entry.
- [ ] Confirm crypto paper feedback uses closed trades only, includes simulated fees and realized drawdown, and remains marked NOT PROVEN at every sample size.
- [ ] Confirm no new broker credentials, wallet, deposit, withdrawal, live order or real-money execution path exists.


## CoinSpot MTF zero-trade gap diagnostics
- [ ] Confirm a missing four-hour bucket is classified `CONFIRMED_NO_TRADES` only when the UTC daily trade count exactly equals the sum of validated stored four-hour trade counts for that date.
- [ ] Confirm missing or mismatched trade-count metadata remains `UNVERIFIED_GAP`.
- [ ] Confirm both confirmed-zero-trade and unverified gaps remain unfilled, and the 210-contiguous-four-hour-candle readiness gate still blocks entries.
- [ ] Confirm the paper ledger, fee/slippage model, position sizing, stops, daily-loss limit, `paperOnly: true` and `liveTradingEnabled: false` remain unchanged.


## CoinSpot MTF pullback entry and stop timing
- [ ] Confirm a paper entry is accepted only for a 2-of-3 Donchian breakout or a bullish completed four-hour EMA20 reclaim after the previous completed four-hour close was at/below its EMA20.
- [ ] Confirm daily EMA100 regime, four-hour EMA50/EMA200 trend, positive long-term slope, positive volume, spread, volatility, freshness, AUD-pair and all risk gates remain mandatory for either entry model.
- [ ] Confirm the ledger records `DONCHIAN_BREAKOUT` or `PULLBACK_RECLAIM` and rejects `entryTrigger: true` if neither underlying trigger is true.
- [ ] Confirm an intrabar quote cannot advance the trailing-stop high-water mark; only a completed four-hour candle after the position opened can do so.
- [ ] Confirm fees, slippage, 25% allocation cap, 0.5% risk budget, A$3 daily-loss circuit, ATR stops, paper-only marker and disabled live-trading flag remain unchanged.


## CoinSpot MTF quote and ledger integrity
- [ ] Confirm the paper execution layer recomputes midpoint spread from bid/ask and rejects a quote whose reported spread is missing, inconsistent or understated.
- [ ] Confirm persisted open-position entry cost equals notional plus entry fee within rounding tolerance, and stop/ATR/timestamps are valid before a position is managed.
- [ ] Confirm closed trades require finite net P&L, entry/exit fees, prices, quantity and chronological timestamps before daily-loss calculations.
- [ ] Confirm invalid KV ledger data is rejected without resetting or overwriting the existing record; paper-only and live-trading safety flags remain unchanged.

- [ ] Confirm closed-trade P&L reconciles to quantity, entry/exit prices and recorded fees within rounding tolerance, and current-day realized losses cannot be understated in the daily-loss field.

- [ ] Confirm the ledger UTC day matches the persisted update timestamp so a malformed future/stale day cannot reset the current-day loss calculation.


## CoinSpot MTF open-position mark freshness
- [ ] Confirm each new paper position records the timestamp of its last valid executable bid/ask mark and reports `CURRENT`.
- [ ] Confirm a missing or crossed exit quote reports `UNAVAILABLE`, then `STALE` after 20 minutes, without inventing a price, changing the last mark timestamp, or overwriting stored equity/P&L.
- [ ] Confirm the next valid quote restores `CURRENT` and refreshes the mark timestamp; protective stops and all existing fee, slippage, sizing and loss controls remain unchanged.
- [ ] Confirm legacy open positions without mark metadata are conservatively marked stale when their original opening timestamp exceeds the freshness window.


## CoinSpot MTF daily-loss rollover and scan ordering

- [ ] Open a simulated position, roll the UTC day while the quote is unavailable, and confirm the last validated unrealized loss remains included in `dailyLossAud` until a fresh quote recalculates it.
- [ ] Confirm persisted-ledger validation rejects a daily-loss value that understates current-day realized losses plus the retained open-position loss.
- [ ] Invoke the paper runner with a scan timestamp older than the persisted ledger; confirm it rejects before CoinSpot history requests and leaves history, ledger and status KV values unchanged.
- [ ] Confirm a same-time or newer scan remains processable and that all entries/exits remain simulated with `paperOnly: true` and `liveTradingEnabled: false`.


- [ ] Confirm a legacy open-position ledger with no `riskAccountingVersion` is accepted for one-time migration, its retained unrealized loss is restored to `dailyLossAud`, and version 2 is persisted without resetting cash, position or trade history.


## Crypto AI review and strategy-comparison audit
- [ ] Confirm crypto AI reviews store the full validated-dataset SHA-256, source label, explicit unverified-source status, review-policy version, requested model alias, provider-returned model ID and provider response ID.
- [ ] Confirm request-start and completion timestamps are distinct, chronological and recorded in both the review and its provenance packet; a completion clock earlier than request start must fail closed.
- [ ] Return blank/boilerplate thesis or counter-thesis text and verify strict structured-output validation rejects it.
- [ ] Keep the requested model alias constant while returning two different provider model IDs; confirm the review IDs differ and the actual model IDs are displayed separately.
- [ ] Confirm strategy comparison reports quote-currency netPnlQuote and percentage returnPct independently; missing percentage metrics remain null and are never copied from currency P&L.
- [ ] Run the crypto walk-forward with two starting-capital values; confirm the 50% buy-and-hold allocation scales proportionally and benchmark returnPct equals net quote P&L divided by starting account capital, not the raw P&L amount.
- [ ] Confirm the crypto AI review remains advisory only, no model confidence is presented as calibrated probability, and all paper/live safety controls remain unchanged.


## CoinSpot MTF KV consistency and sync-failure handling

- [ ] Confirm the scheduled paper runner reads the history KV value once for sync, then evaluates the exact in-memory snapshot returned by that sync rather than performing a second potentially stale KV read.
- [ ] Confirm historySyncConsistency reports CONSISTENT_IN_MEMORY_SNAPSHOT when sync and strategy revisions match, and never includes the internal history arrays in the public status payload.
- [ ] Simulate an invalid/failed history sync and verify new entries and AI review are blocked for that scan while fresh public BTC/AUD and ETH/AUD quotes remain available for existing-position stop and loss management.
- [ ] Confirm the paper ledger remains paperOnly: true and liveTradingEnabled: false; fees, slippage, position sizing, stops and loss limits remain unchanged.


## CoinSpot MTF KV write-throttle regression
- [ ] Simulate two consecutive transient 429 responses on the history KV key; confirm bounded exponential backoff with jitter recovers and the history cursor advances only after the validated checkpoint is persisted.
- [ ] Simulate persistent 429 responses beyond the retry budget; confirm the scan fails closed, new entries and AI review are blocked, and existing history, paper ledger and risk settings are not reset.


## CoinSpot MTF stale-cache and backfill-budget regression

- [ ] Confirm a normal paper scan reports a maximum history request budget of 30, with no more than 15 requests per AUD market.
- [ ] Confirm a provider-probe scan applies its reduced history budget and preserves quote/position-management headroom.
- [ ] Confirm unverified cached daily/four-hour candles remain excluded from signal calculations and remain visible in diagnostics.
- [ ] Confirm 110 validated daily candles and 210 validated four-hour candles can pass warm-up despite stale unverified cache tails.
- [ ] Confirm 109 daily candles, fewer than 210 four-hour candles, invalid ledgers, unverified signal-window gaps, and excessive confirmed zero-trade gaps remain blocked.
- [ ] Confirm the paper ledger remains simulated and `liveTradingEnabled` remains `false`.


## CoinSpot MTF canonical ledger identity
- [x] Confirm persisted open-position and closed-trade IDs equal the canonical market plus four-hour signal timestamp (`<coin>-<signalAt>`).
- [x] Confirm a stored closed-trade strategy identity, when present, must equal `EDGE_MTF_DONCHIAN_ENSEMBLE_V1`; malformed IDs and unrelated strategy provenance fail closed without modifying the ledger.


## CoinSpot MTF ledger tenancy boundary
- [x] Confirm the automated MTF paper account uses deployment-wide global KV keys; do not describe it as per-Access-user isolated.
- [ ] Before admitting multiple unrelated Access users, implement subject-scoped ledgers and concurrency locks or explicitly restrict Access to the single intended operator.


## CoinSpot MTF global-ledger operator isolation
- [x] Confirm the scheduled MTF account is one deployment-wide ledger.
- [x] Confirm Worker routes serving that ledger, shared MTF history/strategy and private CoinSpot read-only account data require a verified Access email matching `COINSPOT_MTF_OPERATOR_EMAIL`.
- [ ] Verify missing or mismatched operator email receives HTTP 403 in production and the configured operator can read the paper ledger.
- [ ] Keep the Worker Access application policy limited to the same operator; do not use broad account-member access for the global ledger.


## CoinSpot MTF mixed malformed history rows
- [ ] Return one valid and one malformed BTC/AUD or ETH/AUD completed-order row in the same provider response; confirm `COINSPOT_HISTORY_SCHEMA_MISMATCH`, the target UTC date remains pending, and no daily/four-hour candles or trade counts are committed.
- [ ] Confirm the paper runner reports `DATA_OR_SYNC_WARNING`, blocks new entries and AI review for that scan, and preserves the A$100 paper ledger and all paper-only/live-disabled flags.
- [ ] Confirm fresh quotes remain available for protective management of an already-open paper position while malformed history blocks entries.

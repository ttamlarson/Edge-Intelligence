# EDGE task register — remediation status

Updated for the autonomous ASX trading foundation. “Complete” describes code and deterministic tests only; it does not establish live data access, broker connectivity, legal eligibility or profitability.

## Autonomous trading — $500 AUD personal account

| Task | Status | Evidence / remaining boundary |
|---|---|---|
| Deterministic daily swing strategy foundation | Complete | 20/50-day trend filter, 20-session breakout, ATR-based stop/target; candidate only. Not validated as profitable. |
| $500 portfolio risk configuration | Complete | 1% of current net liquidation equity after estimated exit costs; fee-inclusive stop risk, AUD 200 maximum position, AUD 100 minimum reserve, two concurrent positions and whole-share sizing. |
| ASX transaction-cost model | Complete | IBKR tier-one AUD 5 minimum commission, GST assumption and configurable slippage per side. Verify account tariff and pass-through charges. Fee assumptions are retained with each paper position for consistent marking and closing. |
| Data provenance and freshness gate | Complete | Requires named source, AUD currency, observed timestamp and latest individual daily bar within 36 hours, latest bar no more than five minutes after the source observation, and 51 valid daily OHLC bars. |
| Simulation-only position opening and closing | Complete | Paper portfolio fixed to AUD and liveTradingEnabled=false; candidate shape, provenance and freshness validated; opening timestamps must follow the source observation within five minutes and cannot be future-dated; entry fees count toward the AUD 200 allocation cap; negative net exit proceeds are recorded when minimum fees exceed exit value; only currently open positions count toward concurrency limits. |
| Default-cost candidate feasibility | Blocked pending operator decision | A 2×ATR stop and 4×ATR target are exactly 2:1 gross; positive round-trip fees make net reward/risk lower than the required 2:1. AUD 500 × 1% = AUD 5 risk budget versus AUD 5.50 minimum commission plus GST per side. Capital, risk, target and threshold assumptions remain unchanged. |
| Licensed ASX daily data integration | Adapter implemented; rights and retrieval unverified | Server-side DataCedar v3 daily-bar adapter is present. Data-use rights, symbol coverage and an actual provider response remain operator-gated; the scheduled paper scanner is disabled unless explicitly configured. |
| CSV-universe ASX scanning | Complete | Imports multi-ticker daily OHLC CSV only after an explicit AUD/data-rights user attestation; supports quoted fields, UTF-8 BOM headers, ISO dates and Australian DD/MM/YYYY; rejects malformed quoting, adjusted-close-only files, inconsistent OHLC, duplicate sessions (including mixed timezone encodings) and ambiguous required-column aliases. Failed replacement imports clear stale candidates. The separate server-side scheduled paper scanner is implemented but remains opt-in and rights-gated. |
| Broker read-only account/portfolio adapter | Not implemented | IBKR account and API permissions not configured or verified. |
| Manual mark-to-market, paper exits and closed-trade ledger | Complete | User-entered mark/exit price and local browser ledger; net liquidation equity deducts estimated exit fees using the latest mark assumptions; closes reuse those assumptions unless explicitly overridden; itemised fee components reconcile to the total charged; four-decimal prices reconcile marks, closes and cash. No broker reconciliation or immutable server audit. |
| Out-of-sample backtest and walk-forward validation | Implemented as fixed-rule research; evidence pending | Expanding-history chronological folds, next-session-open entries, fee/slippage-aware sizing, conservative stop/gap handling and a buy-and-hold reference are tested. Adequate source-verified observations and trade counts are still required; no profitability claim. |
| Live order execution | Disabled by design | No order routes, credentials or broker integration. Do not enable in this phase. |

Updated after local implementation and automated verification on `edge-production-remediation`. “Complete” means the code and its deterministic tests establish the stated behavior. It does not mean an external account, production deployment, legal status or provider service was live-verified.

## P0 — Security and data integrity

| Task | Status | Evidence / remaining boundary |
|---|---|---|
| Keep provider/API secrets server-side | Complete | Worker reads secrets only from bindings; no credential values are committed. `.dev.vars` and `.env` are ignored. |
| Authenticate Worker APIs | Complete | Cloudflare Access context or RS256 Access JWT validation against team JWKs; fails closed if missing/malformed. Tests include a valid signed JWT. Production Access policy still requires account setup. |
| Restrict CORS and add API security headers | Complete | Exact HTTPS allowlist via `FRONTEND_ORIGINS`, credentialed CORS, safe preflight headers, CSP and other headers. Pages `_headers` added. |
| Rate limit API routes | Complete | All read/write routes, including health, source registry, alert reads and cached opportunities, use data/AI/write bindings. User/route keys are SHA-256 hashed and bounded. Production namespace IDs must be unique; limits are approximate and region-local. |
| Bound input and external response sizes | Complete | Streaming body/provider caps, field bounds, strict schemas, timeout and redirect-host checks. |
| Keep alert settings private per user | Complete | KV keys hashed from authenticated subject; alert rules are separately loaded and applied to shared public candidate snapshots; tests verify cross-user filters. Scheduled webhook rules remain deployment-level, not personalized. |
| Preserve browser data and old storage keys | Complete | Existing keys retained; corrupt JSON falls back without the parser overwriting it. No reset/migration was run against browser data. |
| Canonical probability, quote, amount and currency handling | Complete | Numeric and fractional quotes, bid/ask, native currency, source, timestamps and freshness kept separate. Unknown amounts are never forced into AUD; MANA is labelled play money. No FX conversion feed configured. |
| Keep real-money trading disabled | Complete | No order, wallet, deposit or withdrawal routes; API health reports `realMoneyTrading:false`; paper settlement is explicitly simulated. |
| Correct provider market normalization | Complete | Worker and browser handle numeric price fields and canonical Worker payloads; deterministic regression tests added. |
| Sanitize AI report and citations | Complete | Evidence schema and probabilities validated; supplied market quote is the displayed quote; research edge is calculated by EDGE; citations must use HTTPS. |

## P1 — Existing functionality and data flows

| Task | Status | Evidence / remaining boundary |
|---|---|---|
| Prediction.com market search, arbitrage candidates and historical price replay | Requires external access or approval | Worker code paths fixed and tested against mocked payloads. Requires provider API key, plan entitlement and deployed live verification. No candidate can be marked executable. |
| Manifold search and pagination | Complete | Uses documented public search endpoint and `beforeTime` pagination; play-money/MANA labels and mock adapter test. Live API response and Australian user access not verified. |
| Arbitrage net calculation against complete fees, spread, depth and executable quotes | Incomplete | Candidate output now explicitly states provider-reported ROI; fee schedule, bid/ask, complete depth, slippage and net returns are not verified/calculated. Candidates stay `RESEARCH_ONLY` and `executable:false`. |
| Screenshot and URL AI analyzer | Complete | Frontend now sends screenshot, question, URL, supplied venue and quote; Worker validates and sends image to configured OpenAI Responses endpoint. Mock schema test exists; requires key and live verification. |
| AI research with source citations | Complete | UI, Worker prompt/schema validation and HTTPS citations are wired. Live OpenAI/web-search access and citation quality still need deployment verification. |
| Backtesting UI/API | Complete | Price-history route uses the shared bounded replay calculation and explicit exclusions. Provider history plan and live data remain unverified. |
| Forecast tracking and Brier score | Complete | Add, resolve, calibration display and Brier calculation are implemented and tested. Resolutions are user-entered; verify source evidence manually. |
| Paper trading | Complete | Existing records remain stored; NO price complements YES quote; manual resolution calculates simulated payout/P&L. No real money. |
| Watchlist | Complete | Existing localStorage persistence retained; add/remove helper has regression tests. |
| Alert configuration | Complete | User-scoped rules, bounds and manual scan UI are connected. No personal outbound delivery; cron webhook remains deployment-level. |
| API health screen | Complete | Authenticated screen reports configuration separately from source verification; it does not claim a live integration from configured secrets. |
| UI demo/data claims | Complete | Sample radar labelled illustrative; UI separates model estimates, observed quotes, provider estimates and simulated results. International access/jurisdiction explicitly unverified. |
| Currencies and financial value formatting | Complete | AUD only used for virtual paper units when declared; USD provider size labelled USD; MANA is labelled play money. Stale, missing and unknown FX never silently convert. |
| Australian date/time localization | Complete | Locale `en-AU`, browser timezone preference, explicit Australian IANA timezone choices including Perth AWST, Sydney/Melbourne daylight saving, Adelaide and other zones; UTC timestamps retained. |
| API pagination/search usability | Complete | Next-page control sends provider/Manifold cursor and query filters. Search remains subject to provider limits. |

## P1 — Australian-first sources, markets and regulation

| Task | Status | Evidence / remaining boundary |
|---|---|---|
| RBA cash-rate page and media-release adapters | Incomplete | Official URL adapters, parsing/schema checks, source/retrieval/period metadata and mocked tests. Worker has not been deployed to verify live retrieval; RBA exchange rates and broader statistics are not included. |
| ABS Indicator API | Requires external access or approval | Official adapter accepts validated dataflow IDs and parses SDMX observations. A registered API key and applicable terms are required; no live request was run. CPI_H default. |
| AEC historical/election results | Requires external access or approval | Worker bridge adapter now validates the EDGE HTTPS JSON contract, bearer secret, bounded payload, official AEC URLs and required timestamps. Register for the official FTP feed and operate the EML-to-JSON bridge; no bridge credentials/data are configured and provenance/finality require independent verification. |
| BOM observations | Requires external access or approval | Perth and Sydney official observation feeds identified and UTC/source-local timestamps supported. Runtime is gated until suitable distribution rights are confirmed. The live Worker adapter has not run. |
| BOM forecasts, warnings and climate | Requires external access or approval | Not implemented. Official products and RSS have product-specific restrictions; registered access/licensing and a validated product adapter are required. Emergency warning use is out of scope. |
| ASX market data | Requires external access or approval | No ASX market observations are fetched. Separate licence and access required. |
| Australian prediction-market operators / FEX Global | Requires external access or approval | No operator API was invented. FEX is displayed as not integrated; verify active event products, resumed trading, API documentation, permissions and data access before any adapter. |
| Prediction-market jurisdiction/product type | Incomplete | Market output reports play-money where known, otherwise venue/currency/jurisdiction unverified. Each operator/product's Australian eligibility is not legally established. |
| Australian regulatory review before trading | Complete | Real-money trading remains disabled. Future activation requires product-specific legal, licensing, operator, customer eligibility, exchange access and data-rights review. |
| Australian research dashboard | Incomplete | Dashboard combines available RBA, ABS, AEC, BOM, ASX and FEX status/records with local-time display and source-to-research handoff. Several source records are gated/not integrated, and no historical cross-indicator chart is implemented. |
| Australian commodity/energy indicators | Not implemented | No verified source product/licence/data adapter is configured. |

## P2 — PWA, tests, hosting and deployment

| Task | Status | Evidence / remaining boundary |
|---|---|---|
| Correct PWA icon/manifest paths | Complete | Existing SVG retained; stable manifest ID and 192/512 PNG install icons added and dimensions validated. |
| Service-worker install cache/offline shell | Complete | Restored `sw.js`; cache includes actual HTML/CSS/module/icons/manifest; offline navigation fallback and API network exclusion; deterministic install/activation tests pass. A clean-profile HTTPS browser test remains a release check. |
| Service-worker updates | Incomplete | Update prompt is shown and message handling now waits for activation, covered by a deterministic message test. Local Chromium installed a waiting worker but did not complete activation after selecting Update; verify the full lifecycle on a clean HTTPS profile before release. |
| Automated unit/Worker/source/interface tests | Complete | Dependency-free Node tests cover auth/JWT, CORS, source validation, market/currency normalization, dates, forecasting, paper settlement, backtest, watchlists, alerts, local storage, PWA install/update handling and ASX CSV, signal, fee-inclusive opening, marking, negative-proceeds closing, cash reconciliation and trade-history edge cases. Adapter tests are deterministic/mocked; they are not live API tests. |
| Frontend browser smoke | Incomplete | Local desktop (1440px) and mobile (390px) exercised all 13 navigation screens with no horizontal overflow. Offline reload, 192/512 PNG icon fetches and `beforeinstallprompt` were observed locally. Actual standalone install and successful update activation remain unverified. |
| Cloudflare Worker production configuration | Requires external access or approval | Wrangler bindings and setup docs added. KV ID, unique rate-limit namespaces, Access team/audience, exact frontend origin and provider secrets must be configured in the Cloudflare account. Wrangler is not installed/authenticated here; no deploy was run. |
| Cloudflare Pages build | Complete | Dependency-free build copies only public app assets and `_headers` into `dist/`; deploy command documented. |
| GitHub Pages deployment | Not implemented | Repository has no Pages workflow/settings. GitHub Pages will not apply Cloudflare `_headers`; no publishing configuration was added. |
| Deployment/live integration verification | Requires external access or approval | No secrets/accounts/permissions were supplied; no production deploy or live Worker API tests were performed. |
| PR creation | Requires external access or approval | Branch remains local; push/PR publication needs remote access and the user's required approval. No merge or deploy was performed. |

## Prior requirements recovered from repository evidence

- `smoke-checklist.md` covers Pages/PWA install, Worker health/bindings, market search, cited research, AI analysis, manual/scheduled scans, alert transitions, historical replay, forecasts/Brier score, secret hygiene, and production CORS/auth/rate limiting.
- The prior implementation had no test command, missing `assets/icon.svg` references, browser normalization that dropped numeric provider prices, Worker provider calls missing `env`, app.js handlers whose HTML controls were absent, broken health formatting, no static security headers, a hardcoded date banner, and globally shared alert rules.
- The prior audit found the Worker KV namespace ID was a placeholder; this remains an account setup step.
- No extra issues, deployment domain, Access team/audience, API keys, licences, or legal approvals could be recovered from repository history. See README for exact configuration steps.


## 2026-11-15 source recovery verification

- Reconstructed the application modules from the supplied `EDGE-source-for-trading.zip` archive into the project root.
- Restored the missing `sw.js` service worker and `scripts/build-pages.js` Pages build script.
- Verified `npm test`: 49 passed, 0 failed.
- Verified `npm run check`: passed.
- Verified `npm run build:pages`: passed and emitted the static Pages assets to `dist/`.
- These are local deterministic checks only. No Cloudflare account configuration, live provider request, data entitlement, deployment, or live trading was verified.

## DataCedar ASX connector

- [x] Add a server-side DataCedar v3 adapter for ASX daily bars, with bounded tickers/date windows and strict response validation.
- [x] Add authenticated Worker status and daily-bars routes; API key is read only from Worker secret `DATACEDAR_API_KEY`.
- [x] Add ASX Autopilot UI controls to fetch up to three tickers and screen them with the existing paper-only engine.
- [x] Add deterministic adapter tests and document secret setup and smoke checks.
- [ ] Operator action required: create a free DataCedar API key and configure Cloudflare Worker secret `DATACEDAR_API_KEY`.
- [ ] After the secret is configured, exercise a real ASX symbol request and verify current provider coverage before describing the integration as live.

## Cloudflare Pages frontend deployment (2026-11-19)

| Task | Status | Evidence / remaining boundary |
|---|---|---|
| Preserve the existing Cloudflare Pages Git integration | Complete | Cloudflare's GitHub App successfully deployed PR #12 to a branch preview at `https://edge-production-remediation-dwko.edge-intelligence-486.pages.dev`, confirming the repository is connected to the `edge-intelligence` Pages project. The Pages domain suffix is `edge-intelligence-486.pages.dev`. |
| Ensure the repository validates the static frontend before merge | Complete | Existing `ci.yml` runs tests, syntax checks and `npm run build:pages`; CI passed on the initial PR commit. |
| Keep the existing Worker backend and configure Pages CORS origin | Implemented on feature branch; production verification pending | Worker workflow retains `edge-intelligence-api` and sets its allowed frontend origin to `https://edge-intelligence-486.pages.dev`. Worker redeploy occurs separately after merge. |
| Remove conflicting GitHub Pages / Direct Upload publishing workflow | Implemented on feature branch | Pages is already Git-integrated. Do not switch it to Wrangler Direct Upload; Cloudflare's GitHub App performs preview and production deployments. |
| Verify production Pages URL, headers, CORS and Worker API | Requires external access or approval | Complete the Cloudflare Pages and Worker smoke checks after merge and successful production deployment. |
| Cloudflare API token Pages permission | Not required for current deployment path | Pages deployment is authorized by the Cloudflare GitHub App. Existing `CLOUDFLARE_API_TOKEN` remains dedicated to the Worker deployment workflow. |


## ASX paper workflow integrity hardening (2026-11-23)

| Task | Status | Evidence / remaining boundary |
|---|---|---|
| Reject ambiguous or inconsistent CSV import shape | Implemented on feature branch | CSV import now rejects empty/duplicate headers and rows whose field count differs from the header, preventing ignored extra values or silently missing declared fields. Regression tests cover missing optional values, unlabelled extra cells and ambiguous headers. |
| Preserve positive cent-denominated paper capital | Implemented on feature branch | Portfolio creation now rejects positive inputs that round to AUD 0.00, rather than creating a zero-cash account. Regression tests cover sub-cent and one-cent inputs. |
| Repository verification and release | Pending | Branch CI must pass tests, syntax checks and Pages build before merge. No live trading or external data access is introduced. |


## Three-day ASX automation sprint (2026-11-23)

| Task | Status | Evidence / remaining boundary |
|---|---|---|
| Scheduled server-side ASX daily scanner | Implemented on `edge-production-remediation-3day` | Opt-in Worker cron path uses the existing DataCedar adapter; symbols limited to 1–3; six-hour provider-call throttle; each new daily bar is processed once. |
| Automated server-side paper account | Implemented on feature branch | Separate operator-wide AUD 500 paper ledger in KV; daily OHLC mark updates and conservative stop-first stop/target exits; no merge with device-local `edge-asx-paper-v1`. |
| On-demand scan and status API | Implemented on feature branch | Authenticated `GET /api/asx/autopilot` and `POST /api/asx/autopilot/scan`, with rate limits. |
| ASX Autopilot UI | Implemented on feature branch | Status, last scan, open paper position count, recent signal outcomes and manual scan trigger. |
| Safety and deterministic regression tests | Implemented on feature branch; CI pending | Disabled-by-default, missing key/storage, secret stays server-side, persistence, idempotent daily bars, corrupt-ledger non-overwrite and default-cost rejection. |
| Live DataCedar verification | Blocked on operator configuration | Must configure Worker secret, symbols, KV and data-use rights; then verify an actual API response. |
| Economically viable paper position sizing | Blocked pending operator decision | Existing AUD 500 capital, 1% risk and minimum AUD 5.50 commission plus GST per side remain unchanged. No strategy/risk gates were weakened. |
| Production deployment | Pending explicit approval | Feature branch only; no merge or deployment performed. |


| Realized paper performance dashboard | Implemented on feature branch | Reports net realized P&L, win rate, profit factor, expectancy, average win/loss, realized drawdown and evidence-sample status; does not imply profitability. |
| Net reward/risk target correction | Implemented on feature branch | Targets are solved to meet the 2:1 net reward/risk gate after modeled entry/exit fees; strategy version is now `ASX_DAILY_TREND_BREAKOUT_NET_RR_V2`. |
| Conservative daily-bar exits | Implemented on feature branch | Stop gaps use the worse daily open, stop wins ambiguous stop/target candles, and the same symbol cannot re-enter on that candle. |

| Completed-session data guard | Implemented on feature branch | Uses exchange-local Sydney date/time, excludes the current session's daily candle until 17:00 Sydney time, and records the last completed bar only. |
| Provider failure visibility | Implemented on feature branch | Bounded DataCedar error and failure count are persisted; failed requests do not advance the successful scan cursor. |

| Next-session/intraday entry fill model | Outstanding | Current paper entry reference is the last completed daily close. It is not an executable next-session fill; implement and validate an intraday/next-session model before treating results as executable forward paper trading. |
| Walk-forward ASX out-of-sample validation | Outstanding | Collect source-verified history and run chronological out-of-sample tests with fees, slippage, corporate-action handling and adequate trade counts; no profitability claim until evidence supports it. |


## 2026-11-25 — AI-assisted ASX research advancement

- Added strict JSON Schema output for the ASX AI reviewer, separate subjective confidence from an uncalibrated win-probability estimate, and SHA-256 provenance fingerprints for the reviewed daily bars.
- Persisted approved review metadata on paper positions and closed trades. Automated daily-bar exits now carry a distinct exit type so calibration diagnostics can exclude manual exits.
- Added chronological holdout Brier/reliability diagnostics. This is evaluation only; no model is trained or automatically recalibrated, and small samples remain insufficient.
- Added fixed-rule expanding-history ASX walk-forward validation using next-session open entries, fee-aware sizing, unchanged portfolio risk limits, conservative stop/gap handling, fold resets and a buy-and-hold reference.
- Added browser research panel and CI syntax checks for the new research modules. All flows remain simulated and source labels remain unverified.
- Operational blocker: the production Worker has DataCedar and OpenAI secret bindings, but the ASX autopilot enable flag and ticker-universe variables are not configured. Confirm DataCedar data-use rights and the intended ticker universe before enabling scheduled scans. API key bindings alone do not prove successful provider retrieval or model invocation.


- Added deterministic cross-ticker candidate ranking by net reward/risk, net target profit and risk-budget utilisation. Uncalibrated AI win probability is deliberately not used as a ranking signal.


## 2026-11-25 — Multi-timeframe crypto breakout engine

- Added isolated `edge-mtf-breakout-strategy.js` with completed-candle daily/four-hour trend filters, three-lookback Donchian breakout voting, spread/volume/volatility gates, risk-based position sizing and deterministic exit calculations.
- Added synthetic-fixture unit tests for signal eligibility, incomplete/gapped data rejection, liquidity/spread fail-closed behaviour, sizing caps and exit rules. Synthetic tests validate implementation only; they are not market performance evidence.
- Added syntax check and README documentation. Engine is not connected to exchange execution, does not generate orders, and remains live-disabled.
- Outstanding before operational paper promotion: verified CoinSpot AUD multi-timeframe data adapter, fee/spread/slippage-aware chronological backtester, execution/fill reconciliation, and forward paper validation.


## 2026-11-25 — CoinSpot-native MTF data connection

- Added CoinSpot Read Only V2 completed market-order history adapter for BTC/AUD and ETH/AUD, using HMAC-SHA512 authenticated requests and the existing serialized nonce queue.
- Aggregates actual CoinSpot completed orders into UTC daily and 4-hour OHLCV bars. Missing intervals remain missing and the strategy rejects non-contiguous history.
- Adds bounded recursive splitting for potentially truncated history windows, per-run request budget, KV persistence, one-day scheduled backfill progression, and authenticated strategy status/manual sync endpoints.
- Strategy status uses current CoinSpot public bid/ask quotes to calculate spread and evaluates only closed, fresh bars. No order is placed; live execution remains disabled.
- Outstanding: run deployed Worker against the actual Read Only key; verify CoinSpot endpoint permissions, historical coverage and rate/volume; complete warm-up; integrate strategy candidates into an isolated paper ledger and validate fee/slippage/fill handling.


## 2026-11-25 — CoinSpot MTF paper runtime remediation

| Task | Status | Evidence / remaining boundary |
|---|---|---|
| Production runtime audit | Verified | GitHub CI and Pages production deployment were green on main commit `c031332`; the Worker had the latest backend code from `3cdf9dc` and a 15-minute cron. |
| CoinSpot historical sync | Blocked by provider transport | Production KV showed the history cursor at 2026-08-07, zero accepted BTC/AUD and ETH/AUD candles, and `DATA_OR_SYNC_WARNING`. The stored transport message was generic, so the actual timeout/network cause was not yet distinguishable. |
| Read-only credential verification | Implemented on `edge-production-remediation-coinspot-20261125` | Adds an authenticated `/api/crypto/coinspot/readonly/status` check and restricts the internal adapter to read-only endpoints only. |
| Transport resilience and diagnostics | Implemented on feature branch | One bounded retry uses a fresh nonce/signature; 15-second request timeout and explicit transport error codes. |
| Paper risk controls | Implemented on feature branch | Round-trip fee/slippage-aware stop-risk sizing, immediate bid-side mark-to-market after entry, and daily-loss accounting that includes open mark-to-market losses. |
| Warm-up position management | Implemented on feature branch | Current BTC/AUD and ETH/AUD quotes are fetched even before candle warm-up completes, so existing paper positions can still be marked and stopped; regression tests cover this path. |
| Live trading safety | Preserved | No order, cancel, withdrawal or transfer route is added. No live-trading safety flag or secret is changed. |
| Runtime promotion | Pending branch CI and deployment verification | Do not claim CoinSpot retrieval is operational until the read-only status check succeeds and KV contains validated, non-empty BTC/AUD and ETH/AUD history. |


## 2026-11-25 — CoinSpot MTF subrequest and history-integrity remediation

- Production KV confirms the CoinSpot Read Only `/status` probe authenticates and recent live BTC/AUD and ETH/AUD order history is available. The scheduled paper runner was exceeding Cloudflare's per-invocation subrequest ceiling while attempting four UTC backfill days per scan.
- Reduced scheduled work to one UTC backfill day per 15-minute invocation (approximately 30 hours for a 120-day warm-up before retries), capped recursive history requests at 16 per market/day, and reduced redundant provider probes to once per 24 hours.
- Added a fail-closed schema diagnostic: a non-empty provider response that yields zero valid normalized trades now blocks the sync instead of silently advancing the history cursor. Diagnostics expose only field-validity booleans.
- Regression coverage verifies one-day progression, bounded call counts, non-advancement on invalid non-empty rows, and paper-only safety.
- Remaining blocker: production history still contains sparse candles and historical responses require fresh runtime verification after this branch is tested and deployed. No strategy signal or paper entry is permitted until each market has the required fresh, contiguous history.


## 2026-11-25 — CoinSpot partition-window integrity

- The first post-deployment production scan advanced one day without exceeding the Worker subrequest ceiling, but it still accepted zero historical trades for both markets despite raw completed-order responses. The full-day responses were at/near the 500-per-side cap, while recursive epoch sub-day windows yielded no accepted trades.
- Added a two-window 12-hour epoch probe for each market, including in-range and out-of-range trade counts. The probe is forced once after deployment, then remains on the 24-hour cadence.
- Added fail-closed checks for saturated daily windows whose child partitions produce no accepted trades (`COINSPOT_HISTORY_PARTITION_EMPTY`) and for responses containing trades outside the requested UTC window (`COINSPOT_HISTORY_RANGE_MISMATCH`). The date cursor cannot advance in either case.
- Reduced the per-market/day recursive request ceiling to 15 to reserve subrequest headroom for the once-daily partition probe and existing scheduled services.
- Remaining blocker: the next production scan must show non-empty, correctly time-bounded epoch partitions before any historical candles can be considered complete. Strategy signals and paper entries remain blocked until the full 110 daily / 210 four-hour candle requirements are met.


## 2026-11-25 — Recovery of legacy skipped history dates

- Production state showed the 2026-08-19 and 2026-08-20 batches had non-empty raw CoinSpot order arrays but zero accepted trades. The first remediation had already advanced the cursor through those dates, so simply fixing future partitions would leave a historical gap.
- Added a one-time legacy-state migration: when an old batch has raw rows but zero accepted trades and no `lastBatchDate` marker, rewind the cursor to the day before the last processed date. This replays the suspect date and the previously skipped final date in order.
- Persist a rewind marker before any provider request so a timeout cannot repeatedly move the cursor backwards. Every successful sync now records `lastBatchDate`.
- Added regression coverage for the exact production-shaped legacy state and verified the cursor replays 2026-08-19 first without enabling live trading.


## 2026-11-25 — Isolate CoinSpot scheduled workload

- The 10:00 UTC production scan confirmed the daily partition probe plus Binance's ten-symbol scan could still exceed the Worker invocation's 50-subrequest ceiling. The probe recorded BTC/AUD's full-day history as valid but both 12-hour epoch windows as empty; ETH/AUD diagnostics were interrupted by the same subrequest limit.
- Isolated scheduled workloads: UTC :00 runs Binance/ASX/prediction scans; UTC :15, :30 and :45 run CoinSpot MTF alone. This preserves the other research engines while giving CoinSpot three daily-backfill slots per hour (one UTC day per 20-minute average slot; ~40 hours for 120 days, ~32.3 hours for the current 97-day backlog).
- Added deterministic dispatch tests for all quarter-hour slots and missing CoinSpot credentials.
- Remaining data blocker: numeric epoch sub-day filters returned zero rows despite valid full-day BTC/AUD history. Next diagnostic pass must test string-epoch and millisecond-epoch representations before accepting any historical candles.

- Added diagnostic comparisons for numeric epoch seconds, stringified epoch seconds and epoch milliseconds across both 12-hour windows. These alternate representations are not used for candle generation until a probe confirms in-range trades.

- Backfill now retries empty numeric-epoch partitions with stringified epoch seconds and millisecond epoch values, accepting only non-empty responses whose normalized trades all fall inside the exact requested UTC interval.

- Production probe confirmed millisecond epoch windows return in-range trades for BTC/AUD and ETH/AUD; numeric and string seconds returned empty. Sub-day backfill now uses milliseconds first, with seconds-based fallbacks retained only for empty responses.


## 2026-11-25 — Full-window history integrity rebuild

- The 10:30 UTC production scan proved millisecond epoch partitions work: BTC/AUD recovered 1,642 valid trades and created one daily plus six four-hour candles; ETH/AUD recovered 602 trades and created one daily plus six four-hour candles. The cursor advanced to 2026-08-20 with no sync error.
- Earlier four-day legacy batches had run under the defective parent-partition logic, so reprocessing only 2026-08-19 and 2026-08-20 could leave older gaps. Added a one-time full rebuild from the original `today - 120` start date (2026-07-28 for this run).
- The migration clears only derived BTC/ETH candles and history trade counters, preserves the paper ledger and all safety controls, persists its marker before network requests, and replays from the start date. Expected maximum cadence: ~40 hours for the 121 inclusive dates at three CoinSpot slots/hour.
- Regression test verifies the full rebuild starts at 2026-07-28, clears stale derived history, and leaves `liveTradingEnabled=false`.


## 2026-11-26 — Explicit paper-only marker for the automated CoinSpot MTF ledger

- Added a persisted `paperOnly: true` marker to new and updated AUD MTF paper accounts.
- Legacy accounts with no marker remain readable and are upgraded on the next scan; an explicit false marker is rejected without resetting the ledger.
- The existing `liveTradingEnabled: false` requirement is unchanged. No CoinSpot order, withdrawal or transfer route, credential or safety flag was added or enabled.
- Regression coverage verifies account creation, legacy migration and rejection of a false paper-only marker.


## 2026-11-26 — Enforce exact CoinSpot AUD pair identity

- Paper entries and open-position marks now require matching market and quote pair identifiers for BTC/AUD or ETH/AUD.
- Persisted open positions and closed trades with a non-AUD pair label fail ledger validation rather than being accepted or reset.
- Added regressions for BTC/USDT and ETH/USDT pair mismatches. Fees, slippage, sizing, stops, loss limits and live-trading safety flags remain unchanged.

## 2026-11-26 — ASX/crypto research and paper-ledger hardening

- Added explicit paper-only markers to ASX and automated crypto paper ledgers. Legacy missing markers are upgraded additively without resetting portfolio state; explicit false markers are rejected without overwriting the stored ledger.
- Bound ASX AI review fingerprints to candidate metrics plus reviewed daily bars, and made review IDs model-version-specific to prevent calibration samples from being merged across model versions.
- Added Wilson 95% uncertainty intervals to ASX probability calibration and descriptive subjective-confidence bands. Confidence bands are not treated as probability calibration.
- Added a consolidated out-of-sample strategy comparison for the existing crypto EMA, adaptive-regime, breakout and trend-following variants. The common screen is a research filter, not a profitability claim; timeframes and risk settings differ.
- Reworked automated USDT paper candidate ranking to use modeled net stop risk and net target reward after fees, spread and slippage, with sizing constrained by both per-trade risk and remaining daily-loss capacity.
- Missing candidate prices now remain retryable; valid priced candidates blocked by an existing position or daily-loss stop are consumed to prevent stale entry. Added closed-trade feedback metrics and surfaced ranking/feedback in the crypto panel.
- Added regression tests for migration safety, model-version identity, calibration uncertainty, strategy comparison, risk sizing, missing-price retries, feedback metrics and the Worker API/asset paths.
- Production merge/deploy remains gated on the full GitHub CI test, syntax and Pages build checks.


## 2026-11-26 — CoinSpot MTF zero-trade gap diagnostics

- Production history reconciliation found the ETH/AUD four-hour interval 2026-11-22 16:00–20:00 UTC absent from the candle series while the 22 November daily trade count exactly matched the sum of all stored four-hour trade counts (144).
- Added explicit `CONFIRMED_NO_TRADES` versus `UNVERIFIED_GAP` diagnostics. A confirmed zero-trade interval is not a missing provider batch, but it still breaks the fixed four-hour time series.
- Kept the 210-contiguous-four-hour-candle readiness gate unchanged. No carry-forward, interpolation or synthetic OHLCV candle is created.
- Added regression coverage for exact daily/four-hour trade-count reconciliation and for gaps with insufficient metadata. Paper execution and all live-trading safety flags remain unchanged.


## 2026-11-26 — CoinSpot MTF pullback entry and completed-candle stop timing

- Added a second deterministic entry path: a bullish four-hour EMA20 reclaim following a completed close at/below the prior EMA20. The daily trend, four-hour EMA50/EMA200 trend, positive long-term slope, spread, positive volume and volatility checks remain mandatory.
- Kept the Donchian breakout path and record the selected entry model in the paper position and closed-trade ledger.
- Corrected trailing-stop high-water tracking so it advances only from a completed four-hour close after the simulated position opened; live quotes can trigger but cannot tighten the stop using an unfinished candle.
- Added regression tests for pullback entries, invalid trigger flags, and completed-candle stop timing. Fee/slippage assumptions, position sizing, daily loss limit and all live-trading safety flags remain unchanged.


## 2026-11-26 — CoinSpot MTF quote and ledger integrity

- Added a second execution-layer spread check that recomputes the executable bid/ask spread from the midpoint instead of trusting the signal payload. Understated, missing or inconsistent spread metadata is rejected before sizing.
- Strengthened persisted-ledger validation for open-position cost/fee reconciliation, positive stop and ATR values, high-water/trailing-stop consistency, ISO timestamps, and closed-trade net P&L/fee/price/quantity fields.
- Invalid KV ledger records remain fail-closed and are not reset. No entry thresholds, fee/slippage assumptions, position sizing, stops, daily-loss limit or live-trading safety flags were relaxed or changed.
- Added regression tests for spoofed spread metadata and malformed persisted position/closed-trade accounting.


## 2026-11-26 — CoinSpot MTF realized P&L reconciliation

- Closed-trade net P&L must reconcile to quantity, executable entry/exit prices and recorded fees within cent-rounding tolerance. Finite but inconsistent ledger values fail closed.
- The persisted daily-loss value must cover all realized losses from the ledger's current UTC day, preventing a malformed KV record from understating the daily-loss circuit.
- No strategy thresholds, simulated capital, fees, slippage, allocation, stops, loss limit or live-trading safety flags were changed.

- The ledger UTC day must match its update timestamp before daily-loss reconciliation; mismatched day metadata fails closed.


## 2026-11-27 — CoinSpot MTF daily-loss rollover and monotonic scan clock

- [x] Preserve the last validated open-position unrealized loss across UTC midnight when a quote is unavailable; recalculate from the next valid quote.
- [x] Validate persisted daily loss against current-day realized losses plus the retained open-position unrealized loss.
- [x] Reject backdated paper scan clocks before CoinSpot history synchronization, preserving the existing history cursor, ledger and status records.
- [x] Add regression tests for stale-quote day rollover, understated daily-loss metadata, direct backdated ledger processing and scheduled-runner no-write behavior.
- Risk limits, capital, fees, slippage, position sizing, stops, entry gates and all live-trading safety flags remain unchanged. This remains simulated paper trading only.


- Legacy MTF ledgers without a risk-accounting version are migrated additively on the next scan; version 2 requires persisted daily loss to cover realized and retained open-position losses. No cash, position or trade history is reset.


## 2026-11-27 — ASX AI provenance, model identity and calibration hardening

- [x] Bind each ASX AI review to the DataCedar source URL, retrieval timestamp, ASX/AUD denomination, daily timeframe, raw adjustment mode, historical-data classification, symbol universe and provider row count.
- [x] Include provider metadata, deterministic candidate metrics and the reviewed daily bars in the SHA-256 evidence fingerprint; require the full fingerprint in the review ID and at paper-position opening.
- [x] Record requested model alias separately from the provider-returned model ID, the provider response ID, review-policy version, request-start time and completion time. Paper opening cannot be backdated to the beginning of a slow model call.
- [x] Separate chronological calibration cohorts by both actual model identity and review-policy version. Legacy records remain explicitly grouped as unversioned; no mixed-cohort metric is pooled.
- [x] Require substantive thesis and counter-thesis text in strict structured AI output. Invalid source metadata, missing provider rows or malformed analysis fail closed before a paper candidate can be approved.
- Deterministic risk, fee, sizing, cash-reserve, price and paper-only controls remain authoritative. AI probability remains uncalibrated and is not a ranking input. Provider source verification and data-use rights remain unverified; scheduled ASX paper scanning stays disabled unless the operator has explicitly configured and authorised it.
- [x] Extend the same model-version and review-policy audit to crypto research reviews: retain the full validated-dataset SHA-256, requested alias, provider-returned model ID, response ID and request/completion timestamps. User-supplied/external OHLCV provenance remains explicitly unverified.
- [x] Correct crypto strategy comparison so netPnlQuote remains a quote-currency amount and returnPct comes only from the strategy percentage metric; missing percentage data remains null rather than being mislabeled as P&L.
- [x] Scale the crypto walk-forward buy-and-hold reference allocation with starting capital and calculate account-level percentage return against that capital, keeping benchmark quote P&L and percentage return in separate units.


## 2026-11-27 — MTF risk ranking, AI provenance and ASX session integrity

- [x] Cap each CoinSpot MTF entry's fee/slippage-adjusted stop-risk budget by both the existing 0.5% equity budget and the remaining AUD 3 daily-loss headroom. A candidate that cannot support the AUD 10 minimum notional is blocked without consuming its signal.
- [x] Replace breakout-vote-only ordering with deterministic risk-budget-use, executable-spread, modeled-cost, breakout-vote, long-trend and signal-age ranking. Persist the scan-relative rank and entry-time risk/cost evidence additively in the paper ledger and closed trades.
- [x] Add descriptive paper-trade feedback grouped by entry model, including sample size, win rate, profit factor, average spread, risk-budget use and retained-history completeness. Small samples remain explicitly insufficient; no predictive edge or profitability is inferred.
- [x] Version the CoinSpot MTF AI veto by requested model and review-policy version. Bind reviews to SHA-256 signal, history-completeness and quote-spread evidence; retain provider model/response identity, request/completion times, quote observation time and explicit unverified-source status. Cached records are checked against current evidence.
- [x] Fail closed on stale/future signal or quote clocks, missing contiguous-history counts, malformed provider identity, invalid structured output, oversized response, timeout, cache failure or invalid provenance. The AI review is qualitative/advisory and cannot set probabilities or override deterministic controls.
- [x] Expose candidate rank/risk/cost evidence, AI model/policy/fingerprint/source status and entry-model feedback in the dashboard.
- [x] Reject duplicate Australia/Sydney session dates in ASX walk-forward input, even where timestamps differ.
- Regression tests added for daily-loss headroom, risk/spread ranking, feedback completeness, MTF AI review cache/provenance/failure paths, missing history counts and duplicate Sydney sessions.
- Validation boundary: latest Pages preview deployment succeeded, but the Pages project has an empty build command. GitHub Actions workflow-run retrieval returned no records, so npm test, npm run check and npm run build:pages are not verified. PR #81 remains draft/unmerged; no Worker or production Pages deployment was made.
- All trading remains simulated. No broker credentials, live order routes, real-money execution or user-data resets were introduced.


## 2026-11-27 — CoinSpot MTF KV read-after-write consistency

- [x] Pass the validated in-memory history state from the completed read-only sync batch directly into strategy evaluation, avoiding an immediate KV re-read that can observe an older edge-cache value.
- [x] Add historySyncConsistency telemetry so the runtime reports whether the strategy consumed the same sync timestamp and cursor.
- [x] Fail closed for new entries and AI review when history sync is missing, invalid, unsuccessful or inconsistent. Continue retrieving public AUD quotes so existing paper positions retain quote/stop/daily-loss management.
- [x] Add regression tests for the single-read snapshot handoff, sync-error blocking and protective exits while entry creation is disabled.
- [x] Keep the A$100 paper ledger, validated BTC/AUD and ETH/AUD inputs, fee/slippage assumptions, position sizing, stops, daily-loss cap and live-trading safety flags unchanged.
- Validation: awaiting GitHub CI and post-merge Worker/Pages deployment verification. No real CoinSpot order, withdrawal or transfer was submitted.


## 2026-11-27 — CoinSpot MTF KV 429 retry resilience
- [x] Replace the single transient 429 retry with three bounded exponential backoff retries (1.2s, 2.4s and 4.8s plus jitter) while retaining per-isolate write serialization and the minimum per-key write interval.
- [x] Keep persistent quota failures fail-closed; no history cursor, paper ledger or risk settings are reset and no new entry or AI review is permitted on a sync error.
- [x] Add regression coverage for repeated transient 429s, serialized writes and persistent quota failures.
- Production telemetry recorded one KV PUT 429 scan at 2026-11-27 04:30 UTC. Subsequent scans at 07:15, 07:30 and 07:45 UTC completed four-day batches without a sync error. This retry change improves resilience but does not claim Cloudflare's external write quota is eliminated.


## 2026-11-27 — CoinSpot MTF global sync lease duration

- [x] Increase the private Durable Object paper-sync lease from 10 to 20 minutes. The configured four-day backfill can issue up to 24 read-only requests; two bounded 15-second attempts per request yield a 12-minute worst-case retry envelope, so the previous lease could expire while a slow scan still held pending history/ledger writes.
- [x] Add a regression test proving the lease remains exclusive beyond 15 minutes, becomes reclaimable after 20 minutes, and an expired owner cannot release a successor's lease.
- [x] Preserve owner-only release, scheduled overlap skip, manual HTTP 409 behavior, paper-only execution, and all existing risk controls.
- Validation: GitHub Actions branch CI passed on commit `8e3b144c` (deterministic tests, JavaScript syntax, ASX module checks and Pages build). Production deployment verification pending.
- Production runtime at 2026-11-27 10:15 UTC: backfill advanced through 2026-10-05, with 70/110 validated daily candles for each market; 53 daily and 54 four-hour cached dates remain unverified. The history/strategy snapshot timestamps and cursors match. BTC spread was 20.45 bps; ETH spread was 64.39 bps, above the unchanged 50 bps entry ceiling. The A$100 ledger remained flat with zero positions and zero completed trades.



## 2026-11-27 — CoinSpot MTF readiness remediation

- Increase the bounded paper-scan history request allowance from 20 to 30 total requests (still capped at 15 per AUD market) to reduce repeated scans on saturated CoinSpot history days.
- Keep the provider-probe reduced-budget guard intact.
- Continue excluding cached candles that do not reconcile to the completed-order date ledger, but do not let excluded stale cache tails block signals built solely from validated contiguous candles.
- Keep the 110 daily / 210 four-hour warm-up, spread ceiling, sizing, daily loss limit, paper-only ledger and live-order lock unchanged.
- Regression coverage added for sufficient validated history with stale unverified cache tails.


## 2026-11-28 — CoinSpot MTF canonical ledger identity

- [x] Require open-position IDs to equal the canonical `<coin>-<signalAt>` identity generated by the paper engine.
- [x] Require closed-trade IDs to retain the same canonical market/signal identity; reject malformed or missing IDs.
- [x] Reject a closed trade whose optional strategy provenance names a strategy other than `EDGE_MTF_DONCHIAN_ENSEMBLE_V1`.
- [x] Add regression coverage for corrupted open-position IDs, closed-trade IDs and strategy attribution.
- Risk settings, signal thresholds, fee/slippage assumptions, stops, loss limits and live-trading safety flags are unchanged.

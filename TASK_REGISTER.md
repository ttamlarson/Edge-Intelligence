# EDGE task register — remediation status

Updated for the autonomous ASX trading foundation. “Complete” describes code and deterministic tests only; it does not establish live data access, broker connectivity, legal eligibility or profitability.

## Autonomous trading — $500 AUD personal account

| Task | Status | Evidence / remaining boundary |
|---|---|---|
| Deterministic daily swing strategy foundation | Complete | 20/50-day trend filter, 20-session breakout, ATR-based stop/target; candidate only. Not validated as profitable. |
| $500 portfolio risk configuration | Complete | 1% equity risk budget, AUD 200 maximum position, AUD 100 minimum reserve, two concurrent positions, whole-share sizing. |
| ASX transaction-cost model | Complete | IBKR tier-one AUD 5 minimum commission, GST assumption and configurable slippage per side. Verify account tariff and pass-through charges. |
| Data provenance and freshness gate | Complete | Requires named source, AUD currency, observed timestamp and latest individual daily bar within 36 hours, latest bar no more than five minutes after the source observation, and 51 valid daily OHLC bars. |
| Simulation-only position opening and closing | Complete | Paper portfolio fixed to AUD and liveTradingEnabled=false; candidate shape, provenance and freshness validated; entry fees count toward the AUD 200 allocation cap; negative net exit proceeds are recorded when minimum fees exceed exit value; only currently open positions count toward concurrency limits. |
| Licensed ASX daily data integration | Not implemented | No ASX feed or licence configured. No live scan can run. |
| CSV-universe ASX scanning | Complete | Imports multi-ticker daily OHLC CSV only after an explicit AUD/data-rights user attestation; supports quoted fields, UTF-8 BOM headers, ISO dates and Australian DD/MM/YYYY; rejects malformed quoting, adjusted-close-only files, inconsistent OHLC, duplicate sessions and timezone-less/unsupported dates. Scheduled live scanning still not implemented. |
| Broker read-only account/portfolio adapter | Not implemented | IBKR account and API permissions not configured or verified. |
| Manual mark-to-market, paper exits and closed-trade ledger | Complete | User-entered mark/exit price and local browser ledger; no broker reconciliation or immutable server audit. |
| Out-of-sample backtest and walk-forward validation | Not implemented | Existing replay is descriptive only; no profitability claim. |
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

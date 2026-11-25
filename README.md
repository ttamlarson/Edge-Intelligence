# EDGE Intelligence

EDGE is a static, Australian-first market research and forecast-tracking app, backed by a Cloudflare Worker. It distinguishes official observations, venue quotes, model research and simulations. It does not place orders, connect wallets or enable real-money trading.

## Autonomous ASX trading foundation (simulation only)

The first personal-account trading foundation is implemented in `autonomous-engine.js`. It is deterministic rather than allowing an LLM to invent orders:

- Initial virtual equity: AUD 500; maximum position notional: AUD 200; minimum cash reserve: AUD 100.
- Daily swing setup: close above the 20-day average, 20-day breakout and 20-day average above the 50-day average.
- Volatility stop/target: 2 x ATR(14) stop and 4 x ATR(14) target.
- Risk budget: 1% of current net liquidation equity per candidate; whole ASX shares only. Estimated entry and stop-exit costs count against the risk budget; entry costs also count toward the position allocation cap.
- Cost model: tier-one IBKR ASX minimum commission AUD 5 plus 10% GST and configurable slippage (default 10 bps) per side. Confirm the actual account tariff and pass-through charges before relying on estimates.
- Rejects stale or future-dated individual bars (even when source-observation metadata is fresh), malformed, non-AUD or unprovenanced daily bars; rejects candidates that fail post-cost reward/risk or portfolio limits.
- Paper portfolio only. It cannot submit orders and has no broker credentials, broker connection or live execution route.

This is an engine foundation, not a live strategy. The repository does not yet contain a licensed ASX market-data feed, automated daily scanner, broker read-only adapter, or a robust out-of-sample backtest. Manual marking, paper exits and closed-trade history are implemented in a device-local browser ledger; they are not broker-reconciled or an immutable server audit. The dashboard values open positions net of estimated exit costs, preserves four-decimal share prices, and stores entry-fee components, mark-specific fee assumptions, and the exact exit-fee assumptions and components in closed-trade history. The latest mark's fee assumptions are reused for a subsequent close unless the close explicitly overrides them, and itemised fee components reconcile to the recorded total. Net-liquidation equity uses the fee assumptions retained with the latest mark. Paper opening timestamps must follow the source observation within a five-minute tolerance and cannot be future-dated. Until external data and strategy validation are completed, no genuine ASX performance claim can be made. A deterministic screen is not evidence of positive expected returns.

**Default-cost feasibility blocker:** the current 2×ATR stop and 4×ATR target produce exactly 2:1 gross reward/risk before costs, so any positive round-trip fees reduce the net ratio below the required 2:1. The AUD 500 starting portfolio's 1% risk budget is AUD 5, below the AUD 5.50 minimum commission plus GST on each side (before slippage). Default-cost candidates are therefore rejected by design. Changing capital, risk percentage, stop/target multiples, the net reward/risk threshold or cost assumptions requires an explicit operator decision; none is silently relaxed.

The default screen requires at least 2:1 reward/risk after estimated round-trip costs while its initial target is 4 x ATR against a 2 x ATR stop (approximately 2:1 before costs). This can reject otherwise qualifying small-account setups. The cost schedule and risk/target policy are deliberately not changed without confirming the user's actual brokerage tariff and risk preferences.

## ASX Autopilot paper desk

The sidebar's **ASX Autopilot · Paper** workspace accepts a multi-ticker daily OHLC CSV with `Symbol, Date, Open, High, Low, Close` headers (a separate `Adj Close` column is not substituted for `Close`). Date fields must be ISO `YYYY-MM-DD`, Australian `DD/MM/YYYY`, or ISO-8601 timestamps with an explicit `Z` or UTC offset. Slash dates are always interpreted day-first as Australian `DD/MM/YYYY` (not US `MM/DD/YYYY`), so convert non-Australian exports before importing. Timezone-less timestamps, malformed CSV quoting and unsupported date strings are rejected; all four OHLC values must be internally consistent. UTF-8 BOM headers and properly quoted fields are supported. Ambiguous duplicate aliases (for example both `Symbol` and `Ticker`) and repeated trading-session dates are rejected even when timestamp offsets produce different UTC instants. A failed replacement import clears the previous candidate list so stale candidates cannot be opened accidentally. CSV import remains blocked until the user explicitly confirms AUD denomination and data-use rights; the source label and declaration are not independently authenticated. The parser receives the explicit AUD declaration before screening each ticker. The app stores the virtual AUD portfolio in the additive browser key `edge-asx-paper-v1`. Users can open candidate positions in simulation, save timestamped manual valuation marks without changing cash or realized P&L, close positions separately, and review estimated net P&L in the local ledger. Mark refreshes ignore malformed, stale and future bars; entry fees count toward the AUD 200 allocation cap; a negative net exit after minimum fees is recorded as a loss rather than preventing closure.

CSV source labels are user-declared, not independently authenticated. Only import data you are authorised to use. The latest daily close is a reference, not an executable fill. The paper desk is not connected to a live ASX feed, broker account, or order API. Browser storage is device-local and is not a server-side audit ledger. The strategy has not been validated as profitable.

## CoinSpot crypto research and paper trading

The **CoinSpot Crypto · Paper** workspace supports public BTC/AUD and ETH/AUD quotes, a persistent per-Cloudflare-Access-user AUD 100 paper ledger, and a separate CoinSpot read-only account adapter.

- Public market data: CoinSpot V2 latest bid/ask/last and up to 100 recent completed trades. The public API data is not an OHLC candle history.
- Paper account: AUD 100 starting capital, AUD 50 maximum position spend, one open position, AUD 3 daily realised-loss pause, 0.1% fee each side, and modelled spread/slippage. Entries use the public ask; exits use the public bid. Stops and targets are simulation-only and are evaluated when the authenticated paper-account endpoint is refreshed.
- Strategy research: `coinspot-strategy.js` is a hypothesis-only 1-hour EMA20/EMA50 trend-continuation screen with RSI and ATR filters, next-bar-open entries, conservative same-candle stop-first resolution, fee/spread/slippage costs and a chronological in-sample/out-of-sample split. It requires at least 300 validated hourly candles uploaded as CSV. The CSV source is user-supplied and not independently verified.
- The strategy assessment requires at least 30 out-of-sample trades, positive out-of-sample net P&L, profit factor above 1.2 and maximum drawdown below 10% before it can be considered for forward paper testing. Passing those thresholds is not proof of future profitability.
- The Strategy Lab also runs a fixed-rule chronological crypto walk-forward across three expanding-history folds. It requires at least 300 contiguous, completed hourly candles, rejects future or unfinished candles, models fee/spread/slippage, resolves stops before targets and fills stop gaps at the worse open. Each fold resets the same virtual 100-unit quote-currency capital and is compared with a separate 50-unit buy-and-hold reference. No parameters are fitted and no sample candles are generated.
- A separate authenticated AI research-review action asks the Worker to recompute that walk-forward and then critiques the deterministic report using a strict JSON schema. It fingerprints the 50 most recent candles and records unverified source provenance. AI can only recommend extended forward paper observation when the deterministic gate also passes; it cannot change strategy rules, costs, sizing or risk controls, and it cannot place orders or claim calibrated predictive skill.
- Private CoinSpot integration is read-only only. Configure Worker secrets `COINSPOT_READONLY_KEY` and `COINSPOT_READONLY_SECRET` using a CoinSpot Read Only API key. Do not enable trade, withdrawal or transfer permissions. Use the Cloudflare dashboard's Worker > Settings > Variables and Secrets interface to add these values. Never commit credentials or enter them in the browser UI, GitHub source, or ChatGPT.
- CoinSpot API V2 is documented by CoinSpot as BETA; verify API behavior and current fees before use. Market orders currently show a 0.1% fee, while instant buy/sell/swap and stop/take-profit/limit order products show different fee schedules.

No real-money order endpoint is implemented or enabled. No strategy is claimed profitable until it has been tested on a genuine, sufficiently large, independently sourced dataset and then forward-tested in paper mode. A positive backtest alone is not a guarantee.

## Architecture

- `index.html`, `app.js`, `domain.js`, `styles.css`: browser single-page app. Existing localStorage keys remain in use: `edge-intelligence-v1`, `edge-forecasts-v1`, and `edge-alert-rules-v1`.
- `index.js`: Cloudflare Worker API, Cloudflare Access JWT verification, CORS, rate limits, bounded requests, AI/provider proxying and per-user alert preferences.
- `au-sources.js`: official RBA, ABS, AEC and BOM adapters/source registry. RBA public pages and RSS are fetched by the Worker. ABS requires its registered API key. BOM display is disabled until rights are confirmed. AEC results require registered feed access and an operator-controlled HTTPS ingestion bridge.
- `domain.js`: canonical probability/quote model, currency and timezone formatting, forecast score, paper settlement and historical replay calculations.
- `autonomous-engine.js`: deterministic ASX daily trend-breakout screening, conservative costs, portfolio sizing and simulation-only position opening.
- `sw.js`, `manifest.webmanifest`, `icon.svg`, `icon-192.png`, `icon-512.png`, `_headers`: offline shell, installable PWA metadata/icons and Cloudflare Pages security headers.

## Local development

Requirements: Node.js 20.11 or newer. No npm dependencies are required.

```powershell
npm.cmd test
npm.cmd run check
npm.cmd run build:pages
python -m http.server 4173 --directory dist
```

Open `http://localhost:4173/`. The Worker requires Cloudflare bindings and Access configuration; API features will fail closed until those are configured. Never use a browser-side provider key. Do not use fabricated sample data as market evidence: Overview demo cards are illustrative, and paper positions are simulated virtual AUD units.

## Australian data and market coverage

- RBA cash-rate page and media-release RSS adapters are implemented with schema checks and source/retrieval metadata. Live requests from the deployed Worker still need verification.
- ABS Indicator API uses `CPI_H` by default. Set another documented dataflow identifier in the Australia dashboard. The registered ABS API key must be configured as the Worker secret `ABS_INDICATOR_API_KEY`.
- AEC's official Media Feed is published as EML/XML over FTP. Register with the AEC for the feed and operate an HTTPS bridge that polls FTP, parses the applicable AEC EML schema, and returns the EDGE JSON contract below. Configure `AEC_INGESTION_URL` and `AEC_INGESTION_HOST` as Worker variables and `AEC_INGESTION_TOKEN` as a Worker secret.
- BOM observations are gated pending suitable distribution rights; forecasts, warnings and climate adapters are not implemented.
- ASX data is not integrated; a separate licence and access are required.
- FEX Global is not integrated. Prediction.com venue entitlements and Australian eligibility are unverified. Manifold is play-money and MANA is not AUD. International venues are secondary and must not be treated as accessible or legally available to Australian users without verification.

## Cloudflare Worker setup

See `wrangler.toml` for required bindings and placeholders. Do not deploy until every placeholder is replaced, Access is enabled, CORS is exact and production/staging resources are isolated. Keep provider keys as Worker secrets only. `/api/health` reports configuration, not proof that external services work.

## Production and staging

Deployment steps, Worker secrets, source-ingestion contracts and manual verification remain in `smoke-checklist.md`. No production deployment is authorised by this code change.


## DataCedar ASX historical data connector

The ASX Autopilot workspace includes an optional DataCedar Explorer (free) connector for up to three tickers per request. The Worker calls the fixed DataCedar v3 batch-bars endpoint using exchange-qualified identifiers (`asx:TICKER`), daily timeframe, raw adjustment and a maximum 366-day request window. It validates the symbol identity, UTC timestamps, OHLC consistency, optional volume, duplicate dates and requested date bounds before returning AUD bars to the existing deterministic paper screen.

### Setup

1. Create a free DataCedar account and API key at https://datacedar.com/markets/australia.
2. In the Cloudflare Worker environment, add the secret `DATACEDAR_API_KEY` using the Cloudflare dashboard or `wrangler secret put DATACEDAR_API_KEY`. Never place the key in frontend code, browser storage, GitHub source or logs.
3. Deploy the Worker after reviewing the change, then open ASX Autopilot and enter up to three ASX tickers.
4. Use the status route `GET /api/asx/datacedar/status`, then request `GET /api/asx/datacedar/bars?symbols=BHP,CBA` through the authenticated Worker.

The connector uses daily historical bars only. DataCedar's documentation describes the Explorer tier as one year of daily history and seven days of minute history; EDGE deliberately does not use minute data. Provider coverage can vary by symbol. An empty series is reported as no data, never replaced with synthetic prices. The provider documentation also distinguishes its historical research bars from a consolidated real-time feed and best-execution record. Confirm the current DataCedar plan and data-use terms before relying on returned data. No automatic trade is opened: a candidate still requires a separate user action in the paper desk.

Required Worker secret: `DATACEDAR_API_KEY`. The existing localStorage key `edge-asx-paper-v1` and saved positions are unchanged.

## Live execution preparation (locked)

The proposed live account limits are AUD 100 maximum allocated capital, AUD 20 maximum realised daily loss, AUD 25 maximum individual order notional, and one open position. These are hard ceilings for the initial release, not a target allocation or a profitability claim.

`live-execution-guard.js` is a deliberately non-executing safety boundary. It validates BTC/AUD and ETH/AUD spot order intents, checks the proposed capital and loss limits, and evaluates independent release gates for explicit user activation, out-of-sample strategy validation, forward-paper approval, separately configured trading credentials, account reconciliation, and the emergency kill switch. It has no CoinSpot transport, signing, credential access, or order-submission function. Its accepted intents are still marked `executable: false`.

Live trading remains disabled. The existing `COINSPOT_READONLY_KEY` and `COINSPOT_READONLY_SECRET` remain read-only and must not be repurposed. The `coinspot-execution-coordinator.js` Durable Object now provides per-Access-user monotonic nonce allocation and persistent idempotency reservations behind authenticated Worker routes (`/api/crypto/coinspot/execution/nonce`, `/idempotency/reserve`, `/idempotency/complete`). Configure `EDGE_COORDINATOR_TOKEN` as a Worker secret before those routes can be used. This coordinator does not submit orders or reconcile exchange fills. A future execution adapter must use a separate least-privilege trading key, never request withdrawal or transfer permissions, and must add order-status reconciliation, balance reservation, partial-fill handling, stale-quote rejection, a global server-side kill switch and end-to-end tests before any order route is enabled. Do not deploy a trading adapter or create live orders until the strategy has passed the documented validation gates and the user has explicitly activated live execution.

## Cloudflare Pages frontend deployment

The browser application is deployed independently from the existing Cloudflare Worker API:

- Pages project: `edge-intelligence`
- Expected production URL: `https://edge-intelligence-486.pages.dev`
- Production branch: `main`
- Static build command: `npm run build:pages`
- Build output directory: `dist/`
- Frontend API origin: `https://edge-intelligence-api.ttamlarson.workers.dev`

The repository is already connected to Cloudflare Pages through the Cloudflare Workers & Pages GitHub App. That integration automatically creates preview deployments for pull requests and deploys the production branch after merge. The repository's `ci.yml` independently runs `npm test`, `npm run check`, and `npm run build:pages` before changes are accepted. Keep the Cloudflare Pages build settings aligned with Node.js 22, root directory `/`, build command `npm run build:pages`, and output directory `dist`.

The existing Git-integrated Pages project must remain Git-integrated. Cloudflare does not support switching an existing Git-integrated Pages project to Wrangler Direct Upload in place. Do not add a second Direct Upload workflow or attempt to publish with Wrangler to this project. Cloudflare's GitHub App handles Pages deployment authorization; no Pages permission needs to be added to `CLOUDFLARE_API_TOKEN` for this route. The existing token remains used by the separate Worker deployment workflow.

The Worker remains a separate deployment named `edge-intelligence-api`; its source is not copied into the Pages static output. Its deployment workflow configures the allowed frontend CORS origin as `https://edge-intelligence-486.pages.dev`. Frontend-only commits do not redeploy or replace the Worker. If a custom Pages domain is added later, update the Worker `FRONTEND_ORIGINS` configuration and redeploy the Worker.

No production deployment is considered verified until the Cloudflare Pages production deployment succeeds and the deployed URL, security headers, CORS and Worker API are smoke-tested.


## Automated ASX paper autopilot (three-day delivery sprint)

The Worker now includes an opt-in scheduled ASX paper scanner in `asx-autopilot.js`. It uses the existing DataCedar daily-bar adapter and the existing deterministic ASX paper engine. It is disabled by default and only runs when all operator configuration is present:

- `ASX_AUTOPILOT_ENABLED=true`
- `ASX_AUTOPILOT_SYMBOLS=BHP,CBA,CSL` (one to three unique tickers; select only symbols covered by the account and permitted by the data licence)
- `DATACEDAR_API_KEY` Worker secret
- `EDGE_KV` Worker binding

The Worker cron invokes the scanner, with a six-hour minimum provider-call interval to avoid repeatedly downloading unchanged daily history. The scanner records source-attributed signals, marks open positions from newer daily closes, and applies daily-bar stop/target simulation using stop-first handling when both levels occur in one candle. It persists a separate operator-wide AUD 500 virtual paper account under `asx-auto-paper-v1`; this does not import, overwrite or merge the existing device-local `edge-asx-paper-v1` ledger. Authenticated status and on-demand scan routes are `GET /api/asx/autopilot` and `POST /api/asx/autopilot/scan`.

The account remains `PAPER_ONLY` and `liveTradingEnabled=false`. Daily OHLC bars are historical observations, not executable prices. Stop/target prices are simulation assumptions; same-candle ambiguity is resolved conservatively. The current AUD 500 / 1% risk / minimum commission policy can reject every otherwise qualifying setup after costs. The scanner does not relax this gate or force trades. A scheduled code path is not proof of live DataCedar access: configure the key, confirm rights, run a real symbol request and verify the returned bars before relying on it. Never put the DataCedar key in browser code or GitHub.


The automated ASX paper desk also reports realized-only performance metrics: closed trade count, win rate, gross profit/loss, profit factor, average win/loss, expectancy, and realized-equity drawdown. Metrics exclude malformed trade records and disclose the excluded count. Samples below 30 trades are labelled `INSUFFICIENT_SAMPLE`; 30–99 are labelled `EARLY_SAMPLE`; 100+ is labelled `LARGER_SAMPLE_NOT_PROOF`. These are descriptive accounting statistics, not evidence of future returns. Open/unrealized P&L is deliberately not mixed into realized performance.

Provider failures are persisted as `DATA_PROVIDER_ERROR` with a bounded, sanitized message and failure count. The last successful scan timestamp/candle cursor is not advanced on provider errors, and the dashboard shows the last provider error. A successful later scan clears the displayed error without erasing the historical failure count.

ASX daily bars are timestamped at their bar open. To avoid treating an unfinished session as a completed daily close, the autopilot converts bar timestamps and the Worker clock to `Australia/Sydney` (including daylight saving) and excludes a bar dated today until 17:00 Sydney time. It then screens the latest completed bar only. DataCedar describes `ts_ms` as the bar open time in UTC; its data is historical/source-attributed, not an execution feed.

**Execution-model limitation:** the current automated ASX paper ledger uses the last completed daily close as its entry reference. This is a transparent close-based simulation assumption, not a next-session executable fill or a live order. Before any claim of executable forward paper trading or any real-money workflow, implement and validate a next-session/intraday fill model with the appropriate licensed data.


## ASX walk-forward research and AI outcome diagnostics

The ASX desk now has an optional chronological walk-forward research pass for imported or fetched daily bars. It uses expanding prior history, fixed 20/50-day trend and 20-session breakout rules, a conservative historical bar-availability buffer, next-session open entry references, fee-aware whole-share re-sizing, the existing 1% net-equity risk cap, AUD 200 position cap and AUD 100 cash reserve. Stop/target ambiguity is resolved stop-first; a stop gap uses the worse open. Positions are liquidated at each fold boundary for accounting.

Each fold resets the same virtual AUD capital. The comparison is a separate AUD 200 allocation-capped buy-and-hold reference, not a risk-matched strategy; if no whole share fits, that fold's benchmark is unavailable rather than reported as a zero-return benchmark. Future-dated and unfinished current-session bars are rejected against the research clock. The strategy parameters are fixed; no parameter fitting or predictive-model training occurs. A minimum of 30 pooled out-of-sample trades is required before a result can be considered for extended forward paper review. Smaller samples remain explicitly insufficient. Historical results are not a profitability claim.

The AI reviewer now uses a strict JSON Schema response containing both subjective reasoning confidence and a separate uncalibrated win-probability estimate. The distinction is deliberate: subjective confidence is not a probability. The reviewer fingerprints its 30 most recent input bars with SHA-256 and records source label, AUD currency, observation time, bar coverage, model identifier and review ID. Source labels remain unverified declarations, not proof of licensing or data quality. The model can only veto or approve a deterministic paper candidate; the existing engine recalculates and enforces all price, size, fee, cash and risk controls.

Closed AI-reviewed trades retain their review metadata. Calibration diagnostics use only approved reviews that later close through the automated daily-bar stop/target path. They sort outcomes chronologically, reserve the latest 30% as a holdout, and report Brier score, reliability bins and expected calibration error. Any baseline probability is estimated from the earlier reference window only; holdout outcomes never set their own comparison baseline. Manual exits are excluded. This is an outcome audit only: it does not train or adjust the model, and it will not report a calibration status until the configured minimum out-of-sample sample is met.

No market data is generated or substituted. The walk-forward panel uses only the currently imported/fetched ASX bars and displays their source label and date range. Confirm data-use rights before using any provider dataset.


ASX autopilot candidate selection is now risk-aware and deterministic across the configured ticker set. AI-approved candidates are ranked lexicographically by higher fee-adjusted net reward/risk, higher estimated net target profit, then lower consumption of the fixed risk budget; ticker is the final tie-breaker. The uncalibrated AI win-probability estimate is deliberately excluded from ranking until a sufficiently large chronological outcome sample exists. Portfolio controls still decide whether any ranked candidate can actually open.


## Multi-timeframe crypto breakout research candidate

`edge-mtf-breakout-strategy.js` implements a deterministic, long-only signal and risk-sizing engine for the separately documented EDGE MTF Donchian Ensemble V1. It requires verified, contiguous completed daily and four-hour OHLCV series; checks the daily EMA100 regime, four-hour EMA50/EMA200 trend and slope, two-of-three prior Donchian breakouts, spread, volume and volatility; and exposes risk sizing and exit calculations. The module is deliberately isolated from exchange execution: it creates no orders, is not wired to live trading, and returns paper-only candidate signals. Tests use synthetic fixtures solely to exercise code paths, not to claim strategy performance. Production use still requires a real multi-timeframe data adapter, fee/slippage-aware chronological backtester, CoinSpot quote/fill reconciliation and forward paper validation.


## CoinSpot-native MTF breakout data connection

The MTF Donchian research route uses CoinSpot Read Only V2 `/orders/market/completed` history for BTC/AUD and ETH/AUD, with the existing authenticated HMAC-SHA512 request path and strictly increasing nonce queue. Actual completed market orders are aggregated into UTC 4-hour and daily OHLCV bars; no empty candles are fabricated. A bounded recursive time-window fetch splits potentially truncated responses, and the scheduled Worker advances a one-day historical backfill per 15-minute run. The authenticated status route is `GET /api/crypto/coinspot/strategy`; an authenticated manual one-day sync is `POST /api/crypto/coinspot/strategy/sync`. Signals remain withheld until sufficient fresh contiguous CoinSpot history and current public bid/ask quotes exist. This integration is research/paper-candidate only and cannot place exchange orders.


## CoinSpot multi-timeframe automated paper trading

The CoinSpot AUD MTF breakout candidate is now connected to a separate automated paper ledger in `coinspot-mtf-paper.js`. It uses BTC/AUD and ETH/AUD CoinSpot read-only completed-order history, the daily/4-hour breakout strategy, and live public bid/ask quotes for simulated fills. The 15-minute Worker schedule advances one historical UTC day per run (approximately 30 hours for a 120-day warm-up, before any provider retries), evaluates the fixed strategy, updates a virtual AUD 100 account, and records simulated trades. The paper ledger uses a 0.5% equity risk budget, 25% maximum allocation, one position, 0.1% fees, 15 bps slippage, an ATR stop/trailing stop, and an AUD 3 daily loss pause. OpenAI provides advisory risk commentary on qualifying candidates; AI cannot alter strategy parameters, sizing, or risk controls. The new endpoint is `GET/POST /api/crypto/coinspot/mtf-paper`. This is simulation only: it does not submit CoinSpot orders, and it does not prove profitability. The history backfill and first successful authenticated CoinSpot response must be verified in production before treating the engine as operational.


## CoinSpot MTF paper runtime hardening

- The authenticated CoinSpot adapter now has an explicit read-only endpoint allowlist: status, balances, open market orders and completed market-order history only. Order placement, cancellation, withdrawals and transfers are rejected before any upstream request.
- `GET /api/crypto/coinspot/readonly/status` verifies the configured Read Only key against CoinSpot's documented `/status` endpoint without returning credentials.
- Transient CoinSpot transport failures are retried once with a fresh monotonic nonce and matching HMAC-SHA512 signature. Requests have a bounded 15-second timeout and persist explicit `COINSPOT_TIMEOUT` or `COINSPOT_NETWORK_ERROR` diagnostics.
- Paper position sizing now includes both entry and stop-exit fees and modeled slippage in its risk budget. The daily-loss circuit includes open mark-to-market losses as well as realized losses and closes an open paper position when the limit is reached.
- Current BTC/AUD and ETH/AUD quotes are fetched even while historical candles are warming, so existing paper positions remain marked and stop-managed. New positions are marked to the current bid after modeled slippage and fees immediately on entry.
- The engine remains restricted to BTC/AUD and ETH/AUD, AUD 100 simulated capital, one open position, 0.5% risk per trade, 25% allocation and AUD 3 daily loss. It never submits CoinSpot orders; `liveTradingEnabled` remains false.


### CoinSpot MTF production runtime safeguards

The scheduled paper runner is isolated from Binance, ASX and prediction-provider scans: CoinSpot runs at UTC :15, :30 and :45, while the other scheduled workloads use :00. It processes one historical UTC day per CoinSpot slot (approximately 40 hours for a 120-day warm-up) to stay within Cloudflare's Worker subrequest ceiling. Provider diagnostics are sampled at most once per 24 hours, and each market/day history fetch has a bounded 15-request budget. If CoinSpot returns non-empty rows that cannot be normalized into valid BTC/AUD or ETH/AUD trades, the sync fails closed and does not advance the history cursor. The error includes field-validity booleans only, never order payloads or credentials. A saturated interval that cannot be safely recovered remains a blocker; the engine will not treat a partial/truncated response as complete history.


The provider health probe checks two epoch-second 12-hour windows for each market and reports in-range versus out-of-range trades. Saturated daily responses whose child windows yield no accepted trades raise `COINSPOT_HISTORY_PARTITION_EMPTY`; out-of-window records raise `COINSPOT_HISTORY_RANGE_MISMATCH`. Neither case advances the historical cursor.


On first run after this integrity migration, legacy history state whose last batch contains raw completed orders but zero accepted trades is rewound one additional UTC day. The last-batch date is recorded as a one-time marker so provider failures cannot repeatedly move the cursor backwards. The previously skipped date and the last processed date are then replayed under the new partition and timestamp checks.


The daily diagnostic probe compares three sub-day timestamp representations—numeric Unix seconds, stringified Unix seconds and Unix milliseconds—for both 12-hour windows. These are diagnostics only: a format is not adopted for backfill until it returns valid trades inside the exact requested UTC window. The backfill remains paper-only and fails closed on empty or out-of-range partitions.


When a numeric epoch partition is empty, the backfill now tries stringified epoch seconds and millisecond epoch values in sequence. It adopts the first non-empty representation only when every normalized trade falls inside the requested UTC window; errors or out-of-range data fail closed.

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

This is an engine foundation, not a live strategy. The repository does not yet contain a licensed ASX market-data feed, automated daily scanner, broker read-only adapter, or a robust out-of-sample backtest. Manual marking, paper exits and closed-trade history are implemented in a device-local browser ledger; they are not broker-reconciled or an immutable server audit. The dashboard values open positions net of estimated exit costs, preserves four-decimal share prices, and stores entry-fee components, mark-specific fee assumptions, and the exact exit-fee assumptions and components in closed-trade history. Net-liquidation equity uses the fee assumptions retained with the latest mark. Paper opening timestamps must follow the source observation within a five-minute tolerance and cannot be future-dated. Until external data and strategy validation are completed, no genuine ASX performance claim can be made. A deterministic screen is not evidence of positive expected returns.

**Default-cost feasibility blocker:** the current 2×ATR stop and 4×ATR target produce exactly 2:1 gross reward/risk before costs, so any positive round-trip fees reduce the net ratio below the required 2:1. The AUD 500 starting portfolio's 1% risk budget is AUD 5, below the AUD 5.50 minimum commission plus GST on each side (before slippage). Default-cost candidates are therefore rejected by design. Changing capital, risk percentage, stop/target multiples, the net reward/risk threshold or cost assumptions requires an explicit operator decision; none is silently relaxed.

The default screen requires at least 2:1 reward/risk after estimated round-trip costs while its initial target is 4 x ATR against a 2 x ATR stop (approximately 2:1 before costs). This can reject otherwise qualifying small-account setups. The cost schedule and risk/target policy are deliberately not changed without confirming the user's actual brokerage tariff and risk preferences.

## ASX Autopilot paper desk

The sidebar's **ASX Autopilot · Paper** workspace accepts a multi-ticker daily OHLC CSV with `Symbol, Date, Open, High, Low, Close` headers (a separate `Adj Close` column is not substituted for `Close`). Date fields must be ISO `YYYY-MM-DD`, Australian `DD/MM/YYYY`, or ISO-8601 timestamps with an explicit `Z` or UTC offset. Slash dates are always interpreted day-first as Australian `DD/MM/YYYY` (not US `MM/DD/YYYY`), so convert non-Australian exports before importing. Timezone-less timestamps, malformed CSV quoting and unsupported date strings are rejected; all four OHLC values must be internally consistent. UTF-8 BOM headers and properly quoted fields are supported. CSV import remains blocked until the user explicitly confirms AUD denomination and data-use rights; the source label and declaration are not independently authenticated. The parser receives the explicit AUD declaration before screening each ticker. The app stores the virtual AUD portfolio in the additive browser key `edge-asx-paper-v1`. Users can open candidate positions in simulation, save timestamped manual valuation marks without changing cash or realized P&L, close positions separately, and review estimated net P&L in the local ledger. Mark refreshes ignore malformed, stale and future bars; entry fees count toward the AUD 200 allocation cap; a negative net exit after minimum fees is recorded as a loss rather than preventing closure.

CSV source labels are user-declared, not independently authenticated. Only import data you are authorised to use. The latest daily close is a reference, not an executable fill. The paper desk is not connected to a live ASX feed, broker account, or order API. Browser storage is device-local and is not a server-side audit ledger. The strategy has not been validated as profitable.

## CoinSpot crypto research and paper trading

The **CoinSpot Crypto · Paper** workspace supports public BTC/AUD and ETH/AUD quotes, a persistent per-Cloudflare-Access-user AUD 100 paper ledger, and a separate CoinSpot read-only account adapter.

- Public market data: CoinSpot V2 latest bid/ask/last and up to 100 recent completed trades. The public API data is not an OHLC candle history.
- Paper account: AUD 100 starting capital, AUD 50 maximum position spend, one open position, AUD 3 daily realised-loss pause, 0.1% fee each side, and modelled spread/slippage. Entries use the public ask; exits use the public bid. Stops and targets are simulation-only and are evaluated when the authenticated paper-account endpoint is refreshed.
- Strategy research: `coinspot-strategy.js` is a hypothesis-only 1-hour EMA20/EMA50 trend-continuation screen with RSI and ATR filters, next-bar-open entries, conservative same-candle stop-first resolution, fee/spread/slippage costs and a chronological in-sample/out-of-sample split. It requires at least 300 validated hourly candles uploaded as CSV. The CSV source is user-supplied and not independently verified.
- The strategy assessment requires at least 30 out-of-sample trades, positive out-of-sample net P&L, profit factor above 1.2 and maximum drawdown below 10% before it can be considered for forward paper testing. Passing those thresholds is not proof of future profitability.
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

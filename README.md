# EDGE Intelligence

EDGE is a static, Australian-first market research and forecast-tracking app, backed by a Cloudflare Worker. It distinguishes official observations, venue quotes, model research and simulations. It does not place orders, connect wallets or enable real-money trading.

## Autonomous ASX trading foundation (simulation only)

The first personal-account trading foundation is implemented in `autonomous-engine.js`. It is deterministic rather than allowing an LLM to invent orders:

- Initial virtual equity: AUD 500; maximum position notional: AUD 200; minimum cash reserve: AUD 100.
- Daily swing setup: close above the 20-day average, 20-day breakout and 20-day average above the 50-day average.
- Volatility stop/target: 2 x ATR(14) stop and 4 x ATR(14) target.
- Risk budget: 1% of equity per candidate; whole ASX shares only.
- Cost model: tier-one IBKR ASX minimum commission AUD 5 plus 10% GST and configurable slippage (default 10 bps) per side. Confirm the actual account tariff and pass-through charges before relying on estimates.
- Rejects stale, malformed, non-AUD or unprovenanced daily bars; rejects candidates that fail post-cost reward/risk or portfolio limits.
- Paper portfolio only. It cannot submit orders and has no broker credentials, broker connection or live execution route.

This is an engine foundation, not a live strategy. The repository does not yet contain a licensed ASX market-data feed, automated daily scanner, broker read-only adapter, full trade-close/mark-to-market ledger, or a validated backtest. Until these are implemented and verified, no genuine ASX candidate or performance claim can be produced. A deterministic screen is not evidence of positive expected returns.

## ASX Autopilot paper desk

The sidebar's **ASX Autopilot · Paper** workspace accepts a multi-ticker daily OHLC CSV with `Symbol, Date, Open, High, Low, Close` headers. It validates row structure, groups tickers, screens each ticker with the deterministic strategy in `autonomous-engine.js`, and stores a virtual AUD portfolio in the additive browser key `edge-asx-paper-v1`. Users can open candidate positions in simulation, mark them manually, close them, and review estimated net P&L in the local ledger.

CSV source labels are user-declared, not independently authenticated. Only import data you are authorised to use. The latest daily close is a reference, not an executable fill. The paper desk is not connected to a live ASX feed, broker account, or order API. Browser storage is device-local and is not a server-side audit ledger. The strategy has not been validated as profitable.

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

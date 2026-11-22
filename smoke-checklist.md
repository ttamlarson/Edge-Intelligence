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
- [x] Automated tests cover CSV import (AUD attestation, BOM, quoting, Australian/ISO dates, duplicate rows and missing Close), signal screening, fee-inclusive 1% risk sizing, current net liquidation equity, position opening chronology (source-observation ordering and future-time rejection), four-decimal price precision, marking without cash movement, mark-specific fee assumptions, entry/exit fee component history, fee-aware closing, negative net proceeds, cash reconciliation, closed-trade history and re-entry after close.
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

# EDGE deployment smoke checklist

## Automated CI validation
- [x] GitHub Actions `npm test` passed all 59 deterministic tests on commit `9f3729722f3583bae5a9baf5d14fff0fc044122e` (2026-11-15).
- [x] GitHub Actions `npm run check` passed JavaScript syntax checks on the same commit.
- [x] GitHub Actions `npm run build:pages` completed successfully on the same commit.
- [x] CI verified `dist/autonomous-engine.js` exists in the static build.
- [ ] Re-run CI after the PWA offline-cache and project-path fixes in this branch; do not treat earlier green CI as validation of later commits.
- [ ] Download and inspect the CI static-site artifact after it is produced.

## ASX autonomous paper desk
- [ ] Import a broker-authorised ASX daily OHLC CSV and confirm source name, timestamps, OHLC integrity and ticker grouping.
- [x] Automated tests reject malformed OHLC, duplicate sessions, impossible ISO dates, missing provenance, non-AUD and stale daily bars.
- [x] Automated tests cover CSV-to-screen-to-open-to-mark-to-close lifecycle, fee accounting, cash reconciliation, closed-trade history, stale-candidate rejection and re-entry after closed positions.
- [ ] Complete a browser-level import/open/mark/close walkthrough with authorised market data.
- [x] Automated tests confirm there is no broker order execution path in the ASX paper engine.

## Static app and PWA
- [x] Static Pages build copies all required application assets, including `autonomous-engine.js`.
- [x] Service-worker shell now includes `autonomous-engine.js` for offline ASX paper-desk module loading.
- [x] Service-worker cache version incremented to invalidate the previous shell.
- [x] Manifest identity, start URL and scope are relative to support a project Pages path such as `/Edge-Intelligence/`.
- [ ] Verify Pages serves the site over HTTPS and applies the intended security headers.
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
- GitHub Pages publication, PR merge and production cutover remain separate actions; do not infer deployment from a successful build.

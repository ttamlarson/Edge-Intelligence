# EDGE deployment smoke checklist

## Automated checks (run locally)
- [x] `npm test` passes all 49 deterministic mocked adapter, domain, Worker, interface and service-worker tests (2026-11-15).
- [x] `npm run check` passes syntax checks for browser, Worker, domain/source adapter and Pages build modules (2026-11-15).
- [x] `npm run build:pages` emits only the public static application assets (2026-11-15).
- [x] Local HTTPS-equivalent `localhost` secure context fetched both manifest PNG icons and fired `beforeinstallprompt`.
- [x] Local desktop and mobile navigation smoke tests; no horizontal overflow; offline shell reload passed.

## Required after account configuration, before deployment is considered verified
- [ ] Confirm Pages serves the site over HTTPS and applies `_headers` security headers.
- [ ] Complete standalone install on supported desktop/mobile browsers; only installability event/icons were verified locally, not the OS/browser install dialog.
- [ ] Verify service-worker update activation and page reload on a clean HTTPS browser profile. A waiting update prompt was observed locally but selecting Update did not complete activation in this test session.
- [ ] Confirm the existing `edge-intelligence-v1`, `edge-forecasts-v1` and `edge-alert-rules-v1` browser storage remains unchanged after the frontend update.
- [ ] Confirm Cloudflare Access policies permit intended users only and reject missing, expired, wrong-audience and wrong-issuer JWTs.
- [ ] Confirm exact CORS origins, credentialed preflight behavior, rate-limit bindings and request limits in deployed Worker.
- [ ] Call authenticated `/api/health`; treat it as configuration status, not a provider integration test.
- [ ] Test Prediction.com with the configured account entitlement, and Manifold search/pagination. Record venue, quote type, currency, jurisdiction, source timestamp and retrieval timestamp.
- [ ] Test actual RBA cash-rate and RSS response parsing via the deployed Worker. Compare results with the linked official source.
- [ ] Obtain/configure ABS API key and verify a selected official dataflow and observation periods.
- [ ] Do not enable BOM records until distribution rights are confirmed; if approved, verify timestamps, source links and required attribution.
- [ ] Keep AEC results empty until registered feed access and HTTPS ingestion are deployed and verified.
- [ ] Confirm ASX remains absent until a data licence is established; confirm FEX remains non-integrated until an event API/product and access are verified.
- [ ] Confirm analyzer/research citations link to HTTPS sources and distinguish model estimate from user-supplied market price.
- [ ] Confirm scanner results say provider ROI estimate, research-only, simulated candidate and not executable.
- [ ] Confirm paper settlement changes virtual AUD units only; no payment, order or wallet request exists.
- [ ] Confirm user A cannot read/overwrite user B's alert thresholds.
- [ ] Confirm no provider secret appears in static output, browser storage, logs or error responses.
- [ ] If publishing on GitHub Pages, configure equivalent response headers separately; this repository has no GitHub Pages workflow.
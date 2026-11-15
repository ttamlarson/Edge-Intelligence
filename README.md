# EDGE Intelligence

EDGE is a static, Australian-first market research and forecast-tracking app, backed by a Cloudflare Worker. It distinguishes official observations, venue quotes, model research and simulations. It does not place orders, connect wallets or enable real-money trading.

## Architecture

- `index.html`, `app.js`, `domain.js`, `styles.css`: browser single-page app. Existing localStorage keys remain in use: `edge-intelligence-v1`, `edge-forecasts-v1`, and `edge-alert-rules-v1`.
- `index.js`: Cloudflare Worker API, Cloudflare Access JWT verification, CORS, rate limits, bounded requests, AI/provider proxying and per-user alert preferences.
- `au-sources.js`: official RBA, ABS, AEC and BOM adapters/source registry. RBA public pages and RSS are fetched by the Worker. ABS requires its registered API key. BOM display is disabled until rights are confirmed. AEC results require registered feed access and an operator-controlled HTTPS ingestion bridge.
- `domain.js`: canonical probability/quote model, currency and timezone formatting, forecast score, paper settlement and historical replay calculations.
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
- AEC's official Media Feed is published as EML/XML over FTP. Register with the AEC for the feed and operate an HTTPS bridge that polls FTP, parses the applicable AEC EML schema, and returns the EDGE JSON contract below. Configure `AEC_INGESTION_URL` and `AEC_INGESTION_HOST` as Worker variables and `AEC_INGESTION_TOKEN` as a Worker secret. The Worker validates HTTPS endpoint host, bearer authentication, payload size, field bounds, timestamps and official AEC result URLs. Schema validation does not prove that the bridge's claimed AEC provenance is authentic or that a tally is final; verify both independently.
- BOM observations are available behind an explicit rights gate. Anonymous BOM products and RSS are personal/non-commercial; confirm suitable rights for this application's distribution, then set `BOM_DATA_LICENSED=true`. Forecasts, warnings and climate adapters are not implemented. Never use this app as an emergency warning service.
- ASX data is not integrated; a separate licence and access are required.
- FEX Global is not integrated. No active event-product/API/access path was verified. Prediction.com venue entitlements and Australian eligibility are unverified. Manifold is clearly labelled play-money and MANA is not AUD. International venues are secondary and must not be treated as accessible or legally available to Australian users without verification.
- No USD, MANA or provider-native amount is automatically displayed as AUD. Currency conversion requires sourced, timestamped and recent FX data; no conversion feed is currently configured.

## Cloudflare Worker setup

1. Create a Workers KV namespace: `npx wrangler kv namespace create EDGE_KV`. Replace the placeholder namespace ID in `wrangler.toml`.
2. Set `FRONTEND_ORIGINS` to the exact HTTPS Cloudflare Pages origin(s), comma separated. Do not use `*`.
3. Configure a Cloudflare Access self-hosted application protecting the Worker API host. Add only intended users to its access policy. Copy the Access team domain and application's audience tag to `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` in `wrangler.toml`.
4. Choose three unused, positive, account-unique Cloudflare rate-limit namespace IDs in `wrangler.toml` for `DATA_LIMITER`, `AI_LIMITER`, and `WRITE_LIMITER`. Limits are approximate and local to Cloudflare locations.
5. Set provider keys as Worker secrets using Wrangler's interactive prompt:

   ```powershell
   npx wrangler secret put PREDICTION_HUNT_API_KEY
   npx wrangler secret put OPENAI_API_KEY
   npx wrangler secret put ABS_INDICATOR_API_KEY
   npx wrangler secret put ALERT_WEBHOOK_URL
   npx wrangler secret put AEC_INGESTION_TOKEN
   ```

   `ABS_INDICATOR_API_KEY`, `ALERT_WEBHOOK_URL`, and `AEC_INGESTION_TOKEN` are optional for the respective features. Never commit secret values. Provider account entitlements, costs and product terms apply.
6. Keep `BOM_DATA_LICENSED=false` until distribution rights are confirmed.
7. Deploy the Worker from the repository root: `npx wrangler deploy`.
8. Put the deployed Worker URL in Settings in the browser. Because the API uses Cloudflare Access cookies/JWTs cross-origin, configure Access on the API hostname and use the exact allowed Pages origin.
9. Test authentication, CORS, rate limiting, each source endpoint and the actual provider calls in the deployed environment. `/api/health` reports configuration and is not a live integration test.

The scheduled 15-minute scan uses deployment-level `cron-alert-rules` and the deployment webhook, if configured. User alert thresholds are stored separately by authenticated user. The authenticated alerts feed filters the shared public candidate snapshot using that user's thresholds; scheduled webhook notifications remain deployment-level and are not personalized.

### Production and staging environments

The default Wrangler environment is production. `[env.staging]` is a separately named Worker with separate Access audience, frontend origin, KV namespace and rate-limit namespaces. Worker `vars` and bindings are not inherited, so both sets must be completed independently. The staging rate-limit IDs `4101`–`4103` are examples; replace them with unused, positive, account-unique namespace IDs, distinct from production. Configure a separate staging Access application/policy and allow only its Pages preview origin. Worker secrets are also environment-specific: set production secrets without `--env`, staging secrets with `--env staging`. `.dev.vars` is git-ignored for local development; use non-production credentials only.

```powershell
# Local staging Worker (uses local bindings and the simulated Access identity only when configured by Wrangler)
npx wrangler dev --env staging

# Stage static Pages preview and Worker after account configuration
npm.cmd run build:pages
npx wrangler pages deploy dist --project-name edge-intelligence --branch=staging
npx wrangler deploy --env staging

# Staging secrets (Wrangler prompts for each secret value)
npx wrangler secret put OPENAI_API_KEY --env staging
npx wrangler secret put PREDICTION_HUNT_API_KEY --env staging
npx wrangler secret put ABS_INDICATOR_API_KEY --env staging
npx wrangler secret put AEC_INGESTION_TOKEN --env staging

# Production secrets use the same commands without --env; production deploy is `npx wrangler deploy`.
```

Do not deploy either environment until all placeholder values are replaced, staging and production bindings are isolated, Access protection is enabled for the Worker hostname(s), and CORS contains only each environment's Pages origin. Confirm custom-domain routing if using an API hostname; the default staging workers.dev URL needs its own Access protection and frontend-origin allowance.

### EDGE AEC bridge response contract

The bridge is a separate operator-managed component because Workers do not poll the AEC FTP feed directly. It must fetch and parse the currently applicable AEC Media Feed schema, then expose JSON shaped as `{ "schema": "edge.aec.results.v1", "records": [...] }`. Each record requires `id`, `eventName`, `candidate`, non-negative numeric `votes`, `observationPeriod`, ISO `publishedAt`, and an HTTPS `sourceUrl` on `results.aec.gov.au` or an official AEC website host. Optional fields are `contest`, `party`, `percent` (0–100), `status`, and the source-provided `sourceTimezone`. The bridge endpoint must require the configured bearer token. Never expose that token to the browser. The Worker limits responses to 2 MiB and 500 records. Unit tests exercise valid and invalid contract payloads; no real bridge or AEC feed is configured here.

## Cloudflare Pages deployment

1. Build only the static app assets: `npm.cmd run build:pages`.
2. Create a Pages project in the Cloudflare dashboard, or use `npx wrangler pages project create edge-intelligence` once for the account.
3. Deploy `dist/` with `npx wrangler pages deploy dist --project-name edge-intelligence`.
4. Add your final Pages hostname to `FRONTEND_ORIGINS`, update the Access/API hostname settings and redeploy the Worker.
5. Verify installation, offline launch, update prompt, and API authentication on the HTTPS Pages domain.

The repository has no GitHub Pages workflow or configuration. Cloudflare Pages `_headers` are not applied by GitHub Pages; if using GitHub Pages, separately configure equivalent security headers and update the documented deployment setup. No production deployment has been run from this checkout.

## Verification and remaining live checks

```powershell
npm.cmd test
npm.cmd run check
npm.cmd run build:pages
```

Tests use deterministic mocked provider responses. They do not prove the Worker has valid Access settings, provider credentials, provider entitlements, data licences or current API availability. See [TASK_REGISTER.md](TASK_REGISTER.md) and [smoke-checklist.md](smoke-checklist.md) for status and manual verification steps. No integration should be called live until its deployed request and response have been checked.
# Project instructions

## Scope and safety
- Preserve the existing single-page frontend and Cloudflare Worker architecture unless a change is necessary to fix a documented issue.
- Do not add real-money order placement, wallets, deposits, withdrawals, or copy trading. Paper trading must remain explicitly simulated.
- Keep provider credentials in Worker secrets. Never put credentials in browser storage, source, fixtures, screenshots, or logs.
- Do not claim an external integration is operational until its API response has been exercised and validated. Deterministic mocked tests are not live verification.
- Treat Australian legal availability, provider access, data licensing, and event-market eligibility as explicit fields/statuses. Do not infer eligibility from a platform's country selector or API presence.
- Preserve existing localStorage keys and data. New settings must be additive and migration-safe.

## Engineering
- Use small dependency-free modules where practical; this project is deployed as static files plus an ES module Cloudflare Worker.
- Run `npm test` and `npm run check` after code changes. Add tests for regressions and boundary cases.
- Validate external responses before rendering or calculating with them. Record source, observed/retrieved timestamps, currency, and units for data.
- Store timestamps in UTC; format dates with Australian locale and an explicit IANA timezone.
- Mark demo and paper results as simulated. Never label bookmaker odds as exchange prices.
- Update README.md, smoke-checklist.md, and TASK_REGISTER.md when implementation or operational requirements change.

## Deployment
- Work on `edge-production-remediation`; do not commit directly to `main`.
- Never push, publish, or deploy without explicit user approval.
- Document required Worker bindings, variables, and secrets without including their values.
# EDGE Cloudflare Worker deployment

Follow the root README's deployment guide. The exact Worker secret names are:

- `PREDICTION_HUNT_API_KEY` (required for live market data and scheduled scans)
- `OPENAI_API_KEY` (required for AI research and analysis)
- `ALERT_WEBHOOK_URL` (optional; Discord-compatible webhook)

Create a KV namespace with `wrangler kv namespace create EDGE_KV` and copy the returned namespace ID into `wrangler.toml`, replacing `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`.

Deploy from this directory with `wrangler deploy`. The configured cron runs every 15 minutes. The Worker stores the latest scan, alert state and alert rules in KV.

The implementation uses Prediction.com API v2 market, price-history and arbitrage endpoints, and the OpenAI Responses API with web search. Provider plan eligibility and API usage charges apply. A successful deploy does not prove that every provider endpoint is enabled on your account; verify `/api/health` and then run a live market search and scan.

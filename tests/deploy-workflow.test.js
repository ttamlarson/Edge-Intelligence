import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Worker deploy workflow watches every directly imported runtime module", async () => {
  const workflow = await readFile(new URL("../.github/workflows/worker-deploy.yml", import.meta.url), "utf8");
  for (const file of [
    "index.js",
    "domain.js",
    "au-sources.js",
    "datacedar.js",
    "asx-autopilot.js",
    "asx-ai-advisor.js",
    "binance-market-data.js",
    "autonomous-engine.js",
    "coinspot.js",
    "coinspot-paper.js",
    "crypto-auto-paper.js"
  ]) {
    assert.match(workflow, new RegExp('      - "' + file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '"'), `Worker deployment must trigger when ${file} changes`);
  }
});


test("Worker configuration provides a bounded CPU budget for scheduled MTF scans", async () => {
  const config = await readFile(new URL("../wrangler.toml", import.meta.url), "utf8");
  assert.match(config, /\[limits\][\s\S]*?cpu_ms\s*=\s*10000/m,
    "the scheduled Worker must have an explicit 10-second CPU ceiling");
});

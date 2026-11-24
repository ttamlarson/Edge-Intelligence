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
    "autonomous-engine.js",
    "coinspot.js",
    "coinspot-paper.js",
    "crypto-auto-paper.js"
  ]) {
    assert.match(workflow, new RegExp('      - "' + file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '"'), `Worker deployment must trigger when ${file} changes`);
  }
});

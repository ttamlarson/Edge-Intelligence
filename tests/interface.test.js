import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
test("all feature navigation links resolve to an implemented page and required controls", async () => {
  const html = await readFile(resolve(root, "index.html"), "utf8");
  const app = await readFile(resolve(root, "app.js"), "utf8");
  const pages = [...html.matchAll(/id="page-([a-z-]+)"/g)].map(m => m[1]);
  const nav = [...html.matchAll(/data-page="([a-z-]+)"/g)].map(m => m[1]);
  for (const page of nav) assert.ok(pages.includes(page), `missing page ${page}`);
  for (const id of ["loadAustralia", "marketSearch", "marketNext", "analyzeBtn", "researchBtn", "backtestBtn", "saveForecast", "saveAlertRules", "runScan", "paperAdd", "refreshHealth", "testConnection", "asxConfirmData"]) {
    assert.match(html, new RegExp(`id="${id}"`), `missing control ${id}`);
  }
  for (const id of ["loadAustralia", "researchBtn", "backtestBtn", "saveForecast", "saveAlertRules", "runScan", "paperAdd", "asxConfirmData"]) assert.ok(app.includes(`$("${id}")`), `control ${id} has no frontend handler`);
});

test("static deployment headers include security controls", async () => {
  const headers = await readFile(resolve(root, "_headers"), "utf8");
  for (const header of ["X-Content-Type-Options", "X-Frame-Options", "Referrer-Policy", "Permissions-Policy", "Content-Security-Policy", "Strict-Transport-Security"]) assert.ok(headers.includes(header));
});

test("service-worker update prompt waits for acknowledgement and offers retry on timeout", async () => {
  const app = await readFile(resolve(root, "app.js"), "utf8");
  assert.match(app, /new MessageChannel\(\)/);
  assert.match(app, /SKIP_WAITING/);
  assert.match(app, /Update ready \| Retry/);
  assert.match(app, /Restarting EDGE/);
  assert.match(app, /worker\.state==="installed"&&reg\.active/);
});

test("a failed ASX CSV replacement cannot leave previous candidates actionable", async () => {
  const app = await readFile(resolve(root, "app.js"), "utf8");
  const start = app.indexOf('$("asxImportBtn")?.addEventListener("click",()=>{');
  const end = app.indexOf('$("asxDataCedarBtn")?.addEventListener("click",async()=>{', start);
  assert.ok(start >= 0 && end > start, "ASX CSV import handler must exist");
  const handler = app.slice(start, end);
  const clear = handler.indexOf("asxUniverse={};");
  const parse = handler.indexOf("parseAsxDailyCsv");
  assert.ok(clear >= 0 && parse > clear, "previous imported candidates must be cleared before parsing a replacement file");
  assert.match(handler, /if\(!parsed\.valid\)\{[\s\S]*?renderAsxDesk\(\);return\}/);
  assert.match(handler, /reader\.onerror=\(\)=>\{[\s\S]*?asxCandidates=\[\];[\s\S]*?renderAsxDesk\(\);/);
});


test("CoinSpot MTF paper panel distinguishes an eligible entry from a blocked trigger", async () => {
  const app = await readFile(resolve(root, "app.js"), "utf8");
  assert.match(app, /m\.triggerModel/);
  assert.match(app, /m\.failedChecks/);
  assert.match(app, /m\.aiGateStatus/);
  assert.match(app, /AI GATE APPROVED/);
  assert.match(app, /AI GATE BLOCKED/);
  assert.match(app, /Trigger only/);
  assert.match(app, /Blocked by/);
});

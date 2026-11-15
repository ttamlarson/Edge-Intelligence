import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exists = async file => { try { await readFile(resolve(root, file)); return true; } catch { return false; } };

test("PWA manifest, HTML and service-worker shell use existing icon and module paths", async () => {
  const manifest = JSON.parse(await readFile(resolve(root, "manifest.webmanifest"), "utf8"));
  const html = await readFile(resolve(root, "index.html"), "utf8");
  const sw = await readFile(resolve(root, "sw.js"), "utf8");
  for (const icon of manifest.icons) assert.equal(await exists(icon.src.replace(/^\.\//, "")), true, icon.src);
  for (const [src, size] of [["icon-192.png", 192], ["icon-512.png", 512]]) {
    const png = await readFile(resolve(root, src));
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
  }
  assert.match(html, /href="\.\/manifest\.webmanifest"/);
  assert.match(html, /type="module" src="\.\/app\.js"/);
  assert.match(sw, /"\.\/domain\.js"/);
  assert.match(sw, /"\.\/autonomous-engine\.js"/);
  assert.equal(await exists("autonomous-engine.js"), true);
  assert.equal(manifest.id, "./");
  assert.equal(manifest.start_url, "./");
  assert.equal(manifest.scope, "./");
  assert.doesNotMatch(sw, /assets\/icon\.svg/);
});

test("service-worker installation precaches every required shell resource", async () => {
  const source = await readFile(resolve(root, "sw.js"), "utf8");
  const handlers = new Map();
  let cachedPaths;
  const fakeCache = { addAll: async paths => { cachedPaths = paths; }, match: async () => null, put: async () => {} };
  const context = {
    self: { location: { origin: "https://edge.test" }, clients: { claim: async () => {} }, addEventListener: (name, handler) => handlers.set(name, handler), skipWaiting: () => {} },
    caches: { open: async () => fakeCache, keys: async () => [], delete: async () => true, match: async () => null },
    URL, Response, fetch: async () => new Response("ok")
  };
  vm.runInNewContext(source, context);
  let installPromise;
  handlers.get("install")({ waitUntil: promise => { installPromise = promise; } });
  await installPromise;
  assert.deepEqual(Array.from(cachedPaths), ["./", "./index.html", "./styles.css", "./app.js", "./domain.js", "./autonomous-engine.js", "./manifest.webmanifest", "./icon.svg", "./icon-192.png", "./icon-512.png"]);
  for (const path of cachedPaths) assert.equal(await exists(path.replace(/^\.\//, "") || "index.html"), true, path);
});

test("service-worker activation removes only older EDGE shell caches", async () => {
  const source = await readFile(resolve(root, "sw.js"), "utf8");
  const handlers = new Map(); const deleted = [];
  const context = {
    self: { location: { origin: "https://edge.test" }, clients: { claim: async () => {} }, addEventListener: (name, handler) => handlers.set(name, handler), skipWaiting: () => {} },
    caches: { open: async () => ({}), keys: async () => ["edge-shell-v1", "edge-shell-v2", "edge-shell-v3", "edge-shell-v4", "edge-shell-v5", "edge-shell-v6", "edge-shell-v7", "edge-shell-v8", "user-cache"], delete: async name => deleted.push(name), match: async () => null },
    URL, Response, fetch
  };
  vm.runInNewContext(source, context);
  let activation; handlers.get("activate")({ waitUntil: promise => { activation = promise; } }); await activation;
  assert.deepEqual(deleted, ["edge-shell-v1", "edge-shell-v2", "edge-shell-v3", "edge-shell-v4", "edge-shell-v5", "edge-shell-v6", "edge-shell-v7", "edge-shell-v8"]);
});

test("service-worker update message keeps skipWaiting alive until it resolves", async () => {
  const source = await readFile(resolve(root, "sw.js"), "utf8");
  const handlers = new Map(); const sequence = [];
  const context = {
    self: { location: { origin: "https://edge.test" }, clients: { claim: async () => {} }, addEventListener: (name, handler) => handlers.set(name, handler), skipWaiting: async () => { sequence.push("skipWaiting-start"); await Promise.resolve(); sequence.push("skipWaiting-resolved"); } },
    caches: { open: async () => ({}), keys: async () => [], delete: async () => true, match: async () => null }, URL, Response, fetch
  };
  vm.runInNewContext(source, context);
  let task; let acknowledgement;
  handlers.get("message")({ data: { type: "SKIP_WAITING" }, ports: [{ postMessage: value => { sequence.push("acknowledged"); acknowledgement = value; } }], waitUntil: promise => { task = promise; } });
  await task;
  assert.deepEqual(sequence, ["skipWaiting-start", "skipWaiting-resolved", "acknowledged"]);
  assert.equal(acknowledgement.type, "SKIP_WAITING_ACCEPTED");
});

test("service-worker does not acknowledge an update if skipWaiting fails", async () => {
  const source = await readFile(resolve(root, "sw.js"), "utf8");
  const handlers = new Map(); let acknowledged = false; let task;
  const context = {
    self: { location: { origin: "https://edge.test" }, clients: { claim: async () => {} }, addEventListener: (name, handler) => handlers.set(name, handler), skipWaiting: async () => { throw new Error("activation rejected"); } },
    caches: { open: async () => ({}), keys: async () => [], delete: async () => true, match: async () => null }, URL, Response, fetch
  };
  vm.runInNewContext(source, context);
  handlers.get("message")({ data: { type: "SKIP_WAITING" }, ports: [{ postMessage: () => { acknowledged = true; } }], waitUntil: promise => { task = promise; } });
  await assert.rejects(task, /activation rejected/);
  assert.equal(acknowledged, false);
});

import test from "node:test";
import assert from "node:assert/strict";
import { __test } from "../index.js";

test("serializes CoinSpot history KV writes and recovers from repeated transient 429s", async () => {
  const writes = [];
  let attempts = 0;
  let failuresRemaining = 2;
  let lastSuccessfulWriteAt = 0;
  const originalNow = Date.now;
  const originalSetTimeout = globalThis.setTimeout;
  let clock = originalNow();

  // Advance a deterministic fake clock instead of sleeping through retry backoff.
  Date.now = () => clock;
  globalThis.setTimeout = (callback, delay = 0, ...args) => {
    clock += Math.max(0, Number(delay) || 0);
    queueMicrotask(() => callback(...args));
    return 0;
  };

  try {
    const env = {
      EDGE_KV: {
        async put(key, value) {
          attempts++;
          if (failuresRemaining > 0) {
            failuresRemaining--;
            throw new Error("KV PUT failed: 429 Too Many Requests");
          }
          if (lastSuccessfulWriteAt && clock - lastSuccessfulWriteAt < 1000) {
            throw new Error("KV PUT failed: 429 Too Many Requests");
          }
          lastSuccessfulWriteAt = clock;
          writes.push({ key, value: JSON.parse(value), at: clock });
        }
      }
    };

    await Promise.all([
      __test.persistCoinSpotMtfHistory(env, { marker: "first" }),
      __test.persistCoinSpotMtfHistory(env, { marker: "second" })
    ]);

    assert.equal(attempts, 4);
    assert.equal(writes.length, 2);
    assert.equal(writes[0].key, "coinspot-mtf-history-global-v1");
    assert.equal(writes[0].value.marker, "first");
    assert.equal(writes[1].value.marker, "second");
    assert.ok(writes[1].at - writes[0].at >= 1000);

    let persistentAttempts = 0;
    const persistent429 = {
      EDGE_KV: {
        async put() {
          persistentAttempts++;
          throw new Error("KV PUT failed: 429 Too Many Requests");
        }
      }
    };
    await assert.rejects(
      __test.persistCoinSpotMtfHistory(persistent429, { marker: "must-not-persist" }),
      /429 Too Many Requests/
    );
    assert.equal(persistentAttempts, 4);
  } finally {
    Date.now = originalNow;
    globalThis.setTimeout = originalSetTimeout;
  }
});

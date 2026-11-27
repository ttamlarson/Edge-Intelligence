import test from "node:test";
import assert from "node:assert/strict";
import { __test } from "../index.js";

test("serializes CoinSpot history KV writes and retries one transient 429", async () => {
  const writes = [];
  let attempts = 0;
  let lastSuccessfulWriteAt = 0;
  let rejectFirst = true;
  const env = {
    EDGE_KV: {
      async put(key, value) {
        attempts++;
        const now = Date.now();
        if (rejectFirst) {
          rejectFirst = false;
          throw new Error("KV PUT failed: 429 Too Many Requests");
        }
        if (lastSuccessfulWriteAt && now - lastSuccessfulWriteAt < 1000) {
          throw new Error("KV PUT failed: 429 Too Many Requests");
        }
        lastSuccessfulWriteAt = now;
        writes.push({ key, value: JSON.parse(value), at: now });
      }
    }
  };

  await Promise.all([
    __test.persistCoinSpotMtfHistory(env, { marker: "first" }),
    __test.persistCoinSpotMtfHistory(env, { marker: "second" })
  ]);

  assert.equal(attempts, 3);
  assert.equal(writes.length, 2);
  assert.equal(writes[0].key, "coinspot-mtf-history-global-v1");
  assert.equal(writes[0].value.marker, "first");
  assert.equal(writes[1].value.marker, "second");
  assert.ok(writes[1].at - writes[0].at >= 1000);
});

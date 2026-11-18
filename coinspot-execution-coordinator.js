// Durable, per-account CoinSpot execution coordinator.
// This class only allocates monotonic nonces and reserves idempotency keys.
// It never signs requests, calls CoinSpot, or submits exchange orders.
const JSON_HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const MAX_KEY_LENGTH = 128;
const MAX_BODY_BYTES = 8192;

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: JSON_HEADERS });
}
async function digest(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, "0")).join("");
}

export class CoinSpotExecutionCoordinator {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    if (request.method !== "POST") return response({ error: "Method not allowed." }, 405);
    const expected = String(this.env.EDGE_COORDINATOR_TOKEN || "");
    const supplied = request.headers.get("x-edge-coordinator-token") || "";
    if (!expected || supplied.length !== expected.length ||
        !crypto.subtle.timingSafeEqual) {
      // Workers WebCrypto has no timingSafeEqual; compare a digest instead.
      if (!expected || await digest(supplied) !== await digest(expected)) return response({ error: "Forbidden." }, 403);
    } else if (await digest(supplied) !== await digest(expected)) {
      return response({ error: "Forbidden." }, 403);
    }

    const url = new URL(request.url);
    if (url.pathname === "/nonce") {
      const nonce = await this.ctx.storage.transaction(async txn => {
        const previous = await txn.get("coinspot:lastNonce") || 0;
        const next = Math.max(Math.floor(Date.now()), previous + 1);
        await txn.put("coinspot:lastNonce", next);
        return next;
      });
      return response({ nonce });
    }

    if (url.pathname === "/idempotency/reserve") {
      const length = Number(request.headers.get("content-length") || 0);
      if (length > MAX_BODY_BYTES) return response({ error: "Request too large." }, 413);
      let input;
      try { input = await request.json(); } catch { return response({ error: "Invalid JSON." }, 400); }
      const key = String(input?.key || "");
      if (!key || key.length > MAX_KEY_LENGTH || !/^[a-zA-Z0-9._:-]+$/.test(key)) return response({ error: "Invalid idempotency key." }, 400);
      if (!input.intent || typeof input.intent !== "object" || Array.isArray(input.intent)) return response({ error: "Order intent is required." }, 400);
      const intentHash = await digest(JSON.stringify(input.intent));
      const result = await this.ctx.storage.transaction(async txn => {
        const storageKey = "coinspot:idempotency:" + key;
        const existing = await txn.get(storageKey);
        if (existing) {
          if (existing.intentHash !== intentHash) return { conflict: true };
          return { duplicate: true, record: existing };
        }
        const record = { key, intentHash, state: "RESERVED", createdAt: new Date().toISOString() };
        await txn.put(storageKey, record);
        return { duplicate: false, record };
      });
      if (result.conflict) return response({ error: "Idempotency key was already used for a different order intent." }, 409);
      return response({ ...result, record: result.record });
    }

    if (url.pathname === "/idempotency/complete") {
      let input;
      try { input = await request.json(); } catch { return response({ error: "Invalid JSON." }, 400); }
      const key = String(input?.key || "");
      const state = String(input?.state || "");
      if (!key || key.length > MAX_KEY_LENGTH || !["ACKNOWLEDGED", "REJECTED", "UNKNOWN"].includes(state)) return response({ error: "Invalid completion state." }, 400);
      const result = await this.ctx.storage.transaction(async txn => {
        const storageKey = "coinspot:idempotency:" + key;
        const record = await txn.get(storageKey);
        if (!record) return null;
        if (record.state !== "RESERVED" && record.state !== state) return { conflict: true };
        const updated = { ...record, state, updatedAt: new Date().toISOString() };
        await txn.put(storageKey, updated);
        return updated;
      });
      if (!result) return response({ error: "Reservation not found." }, 404);
      if (result.conflict) return response({ error: "Idempotency record cannot transition from its current state." }, 409);
      return response({ record: result });
    }
    return response({ error: "Not found." }, 404);
  }
}

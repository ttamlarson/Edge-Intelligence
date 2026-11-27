// Durable CoinSpot coordinator for private paper-sync leases and per-Access-user
// execution idempotency. It never signs or submits orders.
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
async function readBoundedJson(request) {
  const reader = request.body?.getReader();
  if (!reader) return {};
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new Error("too_large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export class CoinSpotExecutionCoordinator {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }

  async fetch(request) {
    if (request.method !== "POST") return response({ error: "Method not allowed." }, 405);
    const url = new URL(request.url);

    // Internal Worker-to-DO lease used to serialize MTF history and paper-ledger
    // writes across scheduled and HTTP invocations. The DO is not exposed by a
    // public route; the existing execution-coordination routes remain token-gated.
    if (url.pathname === "/paper-sync/acquire" || url.pathname === "/paper-sync/release") {
      let input;
      try { input = await readBoundedJson(request); }
      catch (error) { return response({ error: error.message === "too_large" ? "Request too large." : "Invalid JSON." }, error.message === "too_large" ? 413 : 400); }
      const leaseId = String(input?.leaseId || "");
      if (!/^[a-f0-9-]{36}$/i.test(leaseId)) return response({ error: "Invalid paper sync lease ID." }, 400);
      const key = "coinspot:paper-sync:lease";
      if (url.pathname === "/paper-sync/acquire") {
        const result = await this.ctx.storage.transaction(async txn => {
          const current = await txn.get(key);
          const now = Date.now();
          if (current && Number(current.expiresAt) > now) return { acquired: false, expiresAt: current.expiresAt };
          const lease = { leaseId, acquiredAt: now, expiresAt: now + 10 * 60 * 1000 };
          await txn.put(key, lease);
          return { acquired: true, expiresAt: lease.expiresAt };
        });
        return response(result, result.acquired ? 200 : 409);
      }
      const result = await this.ctx.storage.transaction(async txn => {
        const current = await txn.get(key);
        if (!current) return { released: false };
        if (current.leaseId !== leaseId) return { released: false, conflict: true, expiresAt: current.expiresAt };
        await txn.delete(key);
        return { released: true };
      });
      return response(result, result.conflict ? 409 : 200);
    }

    const expected = String(this.env.EDGE_COORDINATOR_TOKEN || "");
    const supplied = request.headers.get("x-edge-coordinator-token") || "";
    if (!expected || supplied.length !== expected.length ||
        await digest(supplied) !== await digest(expected)) return response({ error: "Forbidden." }, 403);

    if (url.pathname === "/nonce") {
      const nonce = await this.ctx.storage.transaction(async txn => {
        const previous = await txn.get("coinspot:lastNonce") || 0;
        const next = Math.max(Date.now(), previous + 1);
        await txn.put("coinspot:lastNonce", next);
        return next;
      });
      return response({ nonce });
    }

    let input;
    try { input = await readBoundedJson(request); }
    catch (error) { return response({ error: error.message === "too_large" ? "Request too large." : "Invalid JSON." }, error.message === "too_large" ? 413 : 400); }

    if (url.pathname === "/idempotency/reserve") {
      const key = String(input?.key || "");
      if (!key || key.length > MAX_KEY_LENGTH || !/^[a-zA-Z0-9._:-]+$/.test(key)) return response({ error: "Invalid idempotency key." }, 400);
      if (!input.intent || typeof input.intent !== "object" || Array.isArray(input.intent)) return response({ error: "Order intent is required." }, 400);
      const intentHash = await digest(JSON.stringify(input.intent));
      const result = await this.ctx.storage.transaction(async txn => {
        const storageKey = "coinspot:idempotency:" + key;
        const existing = await txn.get(storageKey);
        if (existing) return existing.intentHash === intentHash ? { duplicate: true, record: existing } : { conflict: true };
        const record = { key, intentHash, state: "RESERVED", createdAt: new Date().toISOString() };
        await txn.put(storageKey, record);
        return { duplicate: false, record };
      });
      if (result.conflict) return response({ error: "Idempotency key was already used for a different order intent." }, 409);
      return response(result);
    }

    if (url.pathname === "/idempotency/complete") {
      const key = String(input?.key || ""), state = String(input?.state || "");
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

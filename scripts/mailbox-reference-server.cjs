#!/usr/bin/env node

// Reference implementation of the relay mailbox contract for tests and QA
// harnesses. `locked: true` mirrors the production SealedMailboxStore worker:
// every mailbox must be registered with a token hash before use, reads,
// writes, and claims require the bearer token, appended payloads must be
// sealed, and mailboxes are partitioned by mailboxId. The default open mode
// stays permissive for suites that exercise unrelated behavior.

const http = require("node:http");
const { createHash } = require("node:crypto");
const { mkdir, readFile, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { URL } = require("node:url");

const ERROR_UNREGISTERED = "mailbox_unregistered";
const ERROR_UNAUTHORIZED = "mailbox_unauthorized";
const ERROR_UNSEALED = "mailbox_unsealed_payload";
const ERROR_PUSH_ENDPOINT_REJECTED = "mailbox_push_endpoint_rejected";
// W-G: mirrors MAILBOX_ERROR_REVOKED in the shared contract.
const ERROR_REVOKED = "mailbox_revoked";
// W-D: mirrors MAILBOX_PUSH_ENDPOINT_ALLOWLIST in
// src/shared/mailboxSealedPayload.ts. The reference server cannot import the
// TypeScript contract, so the parity suite is what keeps the two honest.
const PUSH_ENDPOINT_ALLOWLIST = [
  "fcm.googleapis.com",
  "android.googleapis.com",
  "push.apple.com",
  "push.services.mozilla.com",
  "updates.push.services.mozilla.com",
  "notify.windows.com"
];

function isAllowedPushEndpointHost(hostname) {
  const host = String(hostname || "").trim().toLowerCase();
  if (!host) {
    return false;
  }
  return PUSH_ENDPOINT_ALLOWLIST.some((allowed) => host === allowed || host.endsWith("." + allowed));
}

const DEFAULT_EVENT_TTL_MS = 72 * 60 * 60 * 1000;

function createReferenceMailboxServer(options = {}) {
  const storePath = options.storePath;
  const locked = options.locked === true;
  const eventTtlMs = Number.isFinite(options.eventTtlMs) && options.eventTtlMs > 0
    ? options.eventTtlMs
    : DEFAULT_EVENT_TTL_MS;
  const buckets = new Map();
  let loaded = false;

  function bucketFor(mailboxId) {
    const id = mailboxId || "";
    let bucket = buckets.get(id);
    if (!bucket) {
      bucket = { lock: undefined, eventsById: new Map(), claimsByKey: new Map(), arrivalSeq: 0 };
      buckets.set(id, bucket);
    }
    return bucket;
  }

  // Mirrors the worker's retention rule: expiry runs on arrival time stamped
  // by the server, and events persisted before stamping existed expire
  // rather than living forever.
  function sweepExpired(bucket) {
    const cutoff = Date.now() - eventTtlMs;
    for (const [eventId, event] of Array.from(bucket.eventsById.entries())) {
      const arrivedAt = Date.parse(event.arrivedAt ?? "");
      if (!Number.isFinite(arrivedAt) || arrivedAt < cutoff) {
        bucket.eventsById.delete(eventId);
      }
    }
  }

  function oldestArrivalSeq(bucket) {
    let oldest = Infinity;
    for (const event of bucket.eventsById.values()) {
      if (typeof event.arrivalSeq === "number" && event.arrivalSeq < oldest) {
        oldest = event.arrivalSeq;
      }
    }
    return oldest === Infinity ? bucket.arrivalSeq + 1 : oldest;
  }

  const server = http.createServer(async (request, response) => {
    try {
      await loadStore();
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "OPTIONS") {
        response.writeHead(204, corsHeaders());
        response.end();
        return;
      }
      if (request.method === "GET" && url.pathname === "/healthz") {
        writeJson(response, 200, { ok: true, eventCount: totalEventCount() });
        return;
      }
      const mailboxId = url.searchParams.get("mailboxId") ?? "";
      if (locked && !mailboxId.trim() && url.pathname.startsWith("/v1/mailbox/")) {
        writeJson(response, 400, { ok: false, error: "mailboxId required" });
        return;
      }
      const bucket = bucketFor(mailboxId.trim());
      // W-G: terminal by design — a revoked mailbox answers every route,
      // register included, with its own code, before any other routing.
      if (bucket && bucket.revokedAt) {
        writeJson(response, 401, { ok: false, error: ERROR_REVOKED, revokedAt: bucket.revokedAt });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/mailbox/register") {
        const token = bearerToken(request);
        if (!token) {
          writeJson(response, 401, { ok: false, error: ERROR_UNAUTHORIZED });
          return;
        }
        const body = await readJsonBody(request);
        const claimedHash = typeof body.tokenHashBase64Url === "string" ? body.tokenHashBase64Url.trim() : "";
        const computedHash = sha256Base64Url(token);
        if (!claimedHash || claimedHash !== computedHash) {
          writeJson(response, 400, { ok: false, error: "token hash mismatch" });
          return;
        }
        if (!bucket.lock) {
          bucket.lock = {
            tokenHashBase64Url: computedHash,
            registeredAt: new Date().toISOString(),
            epoch: require("node:crypto").randomUUID()
          };
          await persistStore();
          writeJson(response, 200, { ok: true, registered: true, epoch: bucket.lock.epoch });
          return;
        }
        if (bucket.lock.tokenHashBase64Url === computedHash) {
          if (!bucket.lock.epoch) {
            bucket.lock.epoch = require("node:crypto").randomUUID();
            await persistStore();
          }
          writeJson(response, 200, { ok: true, registered: true, epoch: bucket.lock.epoch });
          return;
        }
        writeJson(response, 401, { ok: false, error: ERROR_UNAUTHORIZED });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/mailbox/revoke") {
        if (!bucket.lock) {
          writeJson(response, 200, { ok: true, revoked: false });
          return;
        }
        const token = bearerToken(request);
        if (!token || bucket.lock.tokenHashBase64Url !== sha256Base64Url(token)) {
          writeJson(response, 401, { ok: false, error: ERROR_UNAUTHORIZED });
          return;
        }
        // W-G: everything readable goes, the tombstone stays. A cleared bucket
        // is indistinguishable from one that never existed, which would let a
        // restored backup resurrect a revoked mailbox.
        buckets.set(mailboxId.trim() || "", { revokedAt: new Date().toISOString() });
        await persistStore();
        writeJson(response, 200, { ok: true, revoked: true });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/push/vapid") {
        writeJson(response, 200, { ok: Boolean(options.vapidPublicKey), publicKey: options.vapidPublicKey || "" });
        return;
      }
      if (
        url.pathname === "/v1/mailbox/events" ||
        url.pathname === "/v1/mailbox/claims" ||
        url.pathname === "/v1/mailbox/delete" ||
        url.pathname === "/v1/mailbox/push-subscription"
      ) {
        if (locked) {
          if (!bucket.lock) {
            writeJson(response, 401, { ok: false, error: ERROR_UNREGISTERED });
            return;
          }
          const token = bearerToken(request);
          if (!token || bucket.lock.tokenHashBase64Url !== sha256Base64Url(token)) {
            writeJson(response, 401, { ok: false, error: ERROR_UNAUTHORIZED });
            return;
          }
        }
      }
      if (request.method === "POST" && url.pathname === "/v1/mailbox/push-subscription") {
        const body = await readJsonBody(request);
        const endpoint = typeof body.subscription?.endpoint === "string" ? body.subscription.endpoint.trim() : "";
        let parsedEndpoint;
        try {
          parsedEndpoint = new URL(endpoint);
        } catch {
          writeJson(response, 400, { ok: false, error: "push subscription endpoint must be a URL" });
          return;
        }
        if (parsedEndpoint.protocol !== "https:") {
          writeJson(response, 400, { ok: false, error: ERROR_PUSH_ENDPOINT_REJECTED, reason: "https required" });
          return;
        }
        if (!isAllowedPushEndpointHost(parsedEndpoint.hostname)) {
          writeJson(response, 400, { ok: false, error: ERROR_PUSH_ENDPOINT_REJECTED, reason: "unsupported push service" });
          return;
        }
        bucket.pushSubscription = {
          endpoint,
          suppressOriginId: typeof body.suppressOriginId === "string" ? body.suppressOriginId : undefined,
          savedAt: new Date().toISOString()
        };
        writeJson(response, 200, { ok: true, saved: true });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/mailbox/delete") {
        const body = await readJsonBody(request);
        const eventIds = Array.isArray(body.eventIds)
          ? body.eventIds.filter((id) => typeof id === "string" && id.trim())
          : [];
        const deletedEventIds = [];
        for (const eventId of eventIds) {
          if (bucket.eventsById.delete(eventId)) {
            deletedEventIds.push(eventId);
          }
        }
        if (deletedEventIds.length > 0) {
          await persistStore();
        }
        writeJson(response, 200, { ok: true, deletedEventIds });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/mailbox/events") {
        const body = await readJsonBody(request);
        const incoming = Array.isArray(body.events) ? body.events : [];
        const appendedEventIds = [];
        const duplicateEventIds = [];
        for (const event of incoming) {
          assertMailboxEvent(event);
          if (locked && !isSealedPayload(event.payload)) {
            writeJson(response, 400, { ok: false, error: ERROR_UNSEALED });
            return;
          }
        }
        const arrivedAt = new Date().toISOString();
        for (const event of incoming) {
          if (bucket.eventsById.has(event.eventId)) {
            duplicateEventIds.push(event.eventId);
            continue;
          }
          bucket.arrivalSeq += 1;
          bucket.eventsById.set(event.eventId, { ...event, arrivalSeq: bucket.arrivalSeq, arrivedAt });
          appendedEventIds.push(event.eventId);
        }
        if (appendedEventIds.length > 0) {
          await persistStore();
        }
        writeJson(response, 200, {
          ackRole: "mailbox",
          eventIds: incoming.map((event) => event.eventId),
          appendedEventIds,
          duplicateEventIds
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/mailbox/claims") {
        const body = await readJsonBody(request);
        const claim = assertClaimRequest(body);
        const key = `${claim.conversationId}\0${claim.eventId}`;
        const existing = bucket.claimsByKey.get(key);
        const now = Date.now();
        if (existing && existing.ownerId !== claim.ownerId && Date.parse(existing.expiresAt) > now) {
          writeJson(response, 200, {
            ok: true,
            acquired: false,
            claim: existing
          });
          return;
        }
        const timestamp = new Date(now).toISOString();
        const ttlMs = Math.max(5000, Math.min(600000, Math.floor(Number(claim.ttlMs || 45000))));
        const next = {
          conversationId: claim.conversationId,
          eventId: claim.eventId,
          ownerId: claim.ownerId,
          ownerRole: claim.ownerRole,
          runId: claim.runId,
          claimedAt: existing?.ownerId === claim.ownerId ? existing.claimedAt : timestamp,
          updatedAt: timestamp,
          expiresAt: new Date(now + ttlMs).toISOString()
        };
        bucket.claimsByKey.set(key, next);
        writeJson(response, 200, {
          ok: true,
          acquired: true,
          claim: next
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/mailbox/events") {
        const conversationId = url.searchParams.get("conversationId") ?? "";
        const logScopeId = url.searchParams.get("logScopeId") ?? conversationId;
        const originId = url.searchParams.get("originId") ?? "";
        const afterSeq = Number(url.searchParams.get("afterSeq") ?? "0");
        const afterArrivalRaw = url.searchParams.get("afterArrival");
        const afterArrival = afterArrivalRaw === null ? undefined : Math.max(0, Number(afterArrivalRaw) || 0);
        const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get("limit") ?? "500")));
        const tail = url.searchParams.get("tail") === "true";
        sweepExpired(bucket);
        const filtered = Array.from(bucket.eventsById.values())
          .filter((event) => !conversationId || event.conversationId === conversationId)
          .filter((event) => !conversationId || event.logScopeId === logScopeId)
          .filter((event) => !originId || event.originId === originId)
          .filter((event) => !originId || !Number.isFinite(afterSeq) || event.originSeq > afterSeq);
        let events;
        if (afterArrival !== undefined) {
          events = filtered
            .filter((event) => event.arrivalSeq > afterArrival)
            .sort((left, right) => left.arrivalSeq - right.arrivalSeq)
            .slice(0, limit);
        } else {
          const sorted = filtered.sort(compareMailboxEvents);
          events = tail ? sorted.slice(-limit) : sorted.slice(0, limit);
        }
        writeJson(response, 200, {
          events,
          maxArrivalSeq: bucket.arrivalSeq,
          oldestArrivalSeq: oldestArrivalSeq(bucket),
          epoch: bucket.lock?.epoch ?? ""
        });
        return;
      }
      writeJson(response, 404, { ok: false, error: "not found" });
    } catch (error) {
      writeJson(response, 400, {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  function totalEventCount() {
    let count = 0;
    for (const bucket of buckets.values()) {
      count += bucket.eventsById.size;
    }
    return count;
  }

  async function loadStore() {
    if (loaded || !storePath) {
      loaded = true;
      return;
    }
    loaded = true;
    try {
      const raw = await readFile(storePath, "utf8");
      const parsed = JSON.parse(raw);
      const restoreCounter = (bucket, stored) => {
        let max = Number.isFinite(stored) ? stored : 0;
        for (const event of bucket.eventsById.values()) {
          if (typeof event.arrivalSeq === "number" && event.arrivalSeq > max) {
            max = event.arrivalSeq;
          }
        }
        bucket.arrivalSeq = max;
      };
      if (Array.isArray(parsed.events)) {
        const bucket = bucketFor("");
        for (const event of parsed.events) {
          assertMailboxEvent(event);
          bucket.eventsById.set(event.eventId, event);
        }
        restoreCounter(bucket, parsed.arrivalSeq);
      }
      if (parsed.mailboxes && typeof parsed.mailboxes === "object" && !Array.isArray(parsed.mailboxes)) {
        for (const [mailboxId, record] of Object.entries(parsed.mailboxes)) {
          if (!record || typeof record !== "object") {
            continue;
          }
          const bucket = bucketFor(mailboxId);
          if (record.lock && typeof record.lock === "object") {
            bucket.lock = record.lock;
          }
          if (Array.isArray(record.events)) {
            for (const event of record.events) {
              assertMailboxEvent(event);
              bucket.eventsById.set(event.eventId, event);
            }
          }
          restoreCounter(bucket, record.arrivalSeq);
        }
      }
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return;
      }
      throw error;
    }
  }

  async function persistStore() {
    if (!storePath) {
      return;
    }
    await mkdir(path.dirname(storePath), { recursive: true });
    // The default bucket keeps the legacy flat shape so older stores round-trip.
    const defaultBucket = buckets.get("");
    const mailboxes = {};
    for (const [mailboxId, bucket] of buckets.entries()) {
      if (!mailboxId) {
        continue;
      }
      mailboxes[mailboxId] = {
        ...(bucket.lock ? { lock: bucket.lock } : {}),
        events: Array.from(bucket.eventsById.values()).sort(compareMailboxEvents),
        arrivalSeq: bucket.arrivalSeq
      };
    }
    const store = {
      events: defaultBucket ? Array.from(defaultBucket.eventsById.values()).sort(compareMailboxEvents) : [],
      ...(defaultBucket ? { arrivalSeq: defaultBucket.arrivalSeq } : {}),
      ...(Object.keys(mailboxes).length > 0 ? { mailboxes } : {})
    };
    await writeFile(storePath, JSON.stringify(store, null, 2), "utf8");
  }

  return {
    server,
    listen: (port = 0, host = "127.0.0.1") => new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Reference mailbox did not bind to a TCP port."));
          return;
        }
        resolve({
          port: address.port,
          url: `http://${host}:${address.port}`
        });
      });
    }),
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
    eventCount: () => totalEventCount()
  };
}

function bearerToken(request) {
  const raw = String(request.headers.authorization || "").trim();
  const match = /^Bearer\s+([A-Za-z0-9_-]+)$/.exec(raw);
  return match ? match[1] : "";
}

function sha256Base64Url(value) {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

function isSealedPayload(payload) {
  return Boolean(payload) &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    payload.v === 1 &&
    payload.alg === "A256GCM" &&
    typeof payload.iv === "string" &&
    typeof payload.ct === "string";
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("error", reject);
    request.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
    "cache-control": "no-store"
  };
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "content-type": "application/json", ...corsHeaders() });
  response.end(JSON.stringify(payload));
}

function assertMailboxEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new Error("Mailbox event must be an object.");
  }
  for (const field of ["eventId", "conversationId", "logScopeId", "originId", "kind", "eventHash"]) {
    if (typeof event[field] !== "string" || !event[field].trim()) {
      throw new Error(`Mailbox event requires ${field}.`);
    }
  }
  if (!Number.isSafeInteger(event.originSeq) || event.originSeq < 1) {
    throw new Error("Mailbox event requires positive originSeq.");
  }
}

function assertClaimRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Mailbox claim must be an object.");
  }
  const result = {};
  for (const field of ["conversationId", "eventId", "ownerId", "ownerRole", "runId"]) {
    if (typeof value[field] !== "string" || !value[field].trim()) {
      throw new Error(`Mailbox claim requires ${field}.`);
    }
    result[field] = value[field].trim();
  }
  result.ttlMs = value.ttlMs;
  return result;
}

function compareMailboxEvents(left, right) {
  return left.conversationId.localeCompare(right.conversationId) ||
    left.logScopeId.localeCompare(right.logScopeId) ||
    left.originId.localeCompare(right.originId) ||
    left.originSeq - right.originSeq ||
    left.eventId.localeCompare(right.eventId);
}

if (require.main === module) {
  const mailbox = createReferenceMailboxServer({
    storePath: process.env.ACCORD_MAILBOX_STORE,
    locked: process.env.ACCORD_MAILBOX_LOCKED === "1"
  });
  mailbox.listen(Number(process.env.PORT || 18089), process.env.HOST || "127.0.0.1").then((address) => {
    console.log(`AccordAgents reference mailbox listening on ${address.url}`);
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { createReferenceMailboxServer };

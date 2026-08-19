// W-C's ring path, run against the real worker with its outbound fetch
// intercepted at the runtime boundary.
//
// The obvious harness — point the subscription at a local fake push service —
// cannot work, and should not: W-D's allowlist refuses any endpoint that is not
// a real Web Push origin, and punching a hole in a security control to enable a
// test is a worse trade than the test is worth. Miniflare is the same workerd
// runtime `wrangler dev` runs, so the worker under test is the real one, and
// its API adds the seam the CLI lacks: `outboundService` intercepts everything
// the worker fetches. The subscription is therefore a genuinely allowlisted
// https endpoint, and the interceptor is what answers it.
//
// The one knob this needs is ACCORD_MAILBOX_PUSH_MIN_INTERVAL_MS, a timing
// override with the same shape and the same purpose as the retention TTL
// override the contract suite already uses.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash, createHmac, randomBytes } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { Miniflare } from "miniflare";

const repoRoot = path.resolve(import.meta.dirname, "..");
const PUSH_INTERVAL_MS = 1500;
const PUSH_ORIGIN = "https://fcm.googleapis.com";
const PUSH_PATH = "/fcm/send/ring-path-suite";

function credentials(label) {
  const sealKey = createHash("sha256").update(`accord-ring-${label}`, "utf8").digest();
  const token = createHmac("sha256", sealKey).update("accord-mailbox-auth-v1", "utf8").digest("base64url");
  const mailboxId = "mb-" + createHmac("sha256", sealKey).update("accord-mailbox-scope-v1", "utf8").digest("base64url").slice(0, 32);
  return { token, mailboxId, tokenHashBase64Url: createHash("sha256").update(token, "utf8").digest("base64url") };
}

function sealedEvent(overrides = {}) {
  return {
    eventId: "ring-event-1",
    conversationId: "conversation-ring",
    logScopeId: "conversation-ring",
    originId: "device-desktop",
    originSeq: 1,
    logicalTs: "0000000000000001:device-desktop:conversation-ring",
    kind: "mobile.timeline.events",
    payload: {
      v: 1,
      alg: "A256GCM",
      iv: randomBytes(12).toString("base64url"),
      ct: Buffer.from("sealed", "utf8").toString("base64url")
    },
    payloadHash: "sha256-payload",
    eventHash: "sha256-event",
    createdAt: "2026-08-16T00:00:00.000Z",
    ...overrides
  };
}

// A syntactically valid VAPID key pair is required or the worker declines to
// ring at all. These are generated per run and never leave the process.
async function vapidKeys() {
  const { webcrypto } = await import("node:crypto");
  const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await webcrypto.subtle.exportKey("jwk", pair.privateKey);
  const raw = Buffer.from(await webcrypto.subtle.exportKey("raw", pair.publicKey));
  return { publicKey: raw.toString("base64url"), privateKeyJwk: JSON.stringify(jwk) };
}

async function startWorker(rings, pushStatus) {
  const vapid = await vapidKeys();
  const mf = new Miniflare({
    // The same worker source the deploy ships, bundled to the module format
    // workerd loads. Miniflare is the runtime `wrangler dev` runs, so this is
    // the real worker, not a stand-in.
    scriptPath: path.join(repoRoot, "dist/relay-worker/index.mjs"),
    modules: true,
    compatibilityDate: "2026-08-08",
    compatibilityFlags: ["nodejs_compat"],
    // The classes are declared new_sqlite_classes in wrangler.jsonc; the
    // shorthand form gives them key-value storage instead and the object never
    // becomes ready.
    durableObjects: {
      RELAY_ROOMS: { className: "RelayRoom", useSQLite: true },
      MAILBOXES: { className: "SealedMailboxStore", useSQLite: true }
    },
    bindings: {
      ACCORD_RELAY_PROVIDER: "cloudflare-durable-object",
      ACCORD_MAILBOX_PUSH_MIN_INTERVAL_MS: String(PUSH_INTERVAL_MS),
      ACCORD_VAPID_PUBLIC_KEY: vapid.publicKey,
      ACCORD_VAPID_PRIVATE_KEY_JWK: vapid.privateKeyJwk,
      ACCORD_VAPID_SUBJECT: "mailto:relay@accordagents.test"
    },
    // Every outbound fetch the worker makes lands here. The only one it makes
    // is the wake push, so this is the ring log.
    outboundService(request) {
      rings.push({ at: Date.now(), url: request.url, authorization: request.headers.get("authorization") ?? "" });
      return new Response("", { status: pushStatus.value });
    }
  });
  return mf;
}

test("W-C ring path: only a finished run rings, and a finish inside the window is deferred, not dropped", async (t) => {
  const rings = [];
  const pushStatus = { value: 201 };
  let mf;
  try {
    mf = await startWorker(rings, pushStatus);
    await mf.ready;
  } catch (error) {
    assert.fail(`could not start the worker under Miniflare: ${error?.message || error}`);
  }

  const creds = credentials("worker");
  const call = (pathname, { method = "GET", body, token = creds.token, query = {} } = {}) => {
    const url = new URL(pathname, "https://relay.test");
    url.searchParams.set("mailboxId", creds.mailboxId);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, String(value));
    }
    return mf.dispatchFetch(url.toString(), {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  };

  try {
    assert.equal((await call("/v1/mailbox/register", {
      method: "POST",
      body: { tokenHashBase64Url: creds.tokenHashBase64Url }
    })).status, 200);

    assert.equal((await call("/v1/mailbox/push-subscription", {
      method: "POST",
      body: {
        subscription: { endpoint: `${PUSH_ORIGIN}${PUSH_PATH}`, keys: { p256dh: "p", auth: "a" } },
        suppressOriginId: "device-phone"
      }
    })).status, 200);

    // 1. An ordinary append — progress, not a finish — must ring nothing.
    assert.equal((await call("/v1/mailbox/events", {
      method: "POST",
      body: { events: [sealedEvent({ eventId: "ring-progress", originSeq: 1 })] }
    })).status, 200);
    await delay(500);
    assert.equal(rings.length, 0, "an unmarked append never rings");

    // 2. A marked append rings once.
    assert.equal((await call("/v1/mailbox/events", {
      method: "POST",
      body: { events: [sealedEvent({ eventId: "ring-finish-1", originSeq: 2 })], runFinished: true }
    })).status, 200);
    for (let i = 0; i < 20 && rings.length === 0; i += 1) {
      await delay(100);
    }
    assert.equal(rings.length, 1, "a marked append rings exactly once");

    // 3. A second finish inside the debounce window must be DEFERRED, not
    //    dropped: it is the last thing that happens in that run.
    const firstRingAt = rings[0].at;
    assert.equal((await call("/v1/mailbox/events", {
      method: "POST",
      body: { events: [sealedEvent({ eventId: "ring-finish-2", originSeq: 3 })], runFinished: true }
    })).status, 200);
    await delay(300);
    assert.equal(rings.length, 1, "the second finish does not ring immediately");

    for (let i = 0; i < 60 && rings.length < 2; i += 1) {
      await delay(200);
    }
    assert.equal(rings.length, 2, "the deferred finish rings rather than being dropped");
    assert.ok(
      rings[1].at - firstRingAt >= PUSH_INTERVAL_MS - 250,
      `the deferred ring waits out the interval (waited ${rings[1].at - firstRingAt}ms)`
    );
    for (const ring of rings) {
      assert.equal(ring.url, `${PUSH_ORIGIN}${PUSH_PATH}`, "the ring goes to the subscribed endpoint and nowhere else");
      assert.match(ring.authorization, /^vapid t=/, "the ring is VAPID-authenticated");
    }

    // 4. The retention sweep must still be armed after the deferred ring
    //    fired — the two share the object's single alarm.
    const listing = await (await call("/v1/mailbox/events", { query: { afterArrival: 0, limit: 500 } })).json();
    assert.equal(listing.events.length, 3, "the deferred ring did not disturb stored events");

    // 5. A 410 means the subscription lapsed: drop it, do not retry, and let
    //    the phone re-register on its next open.
    pushStatus.value = 410;
    rings.length = 0;
    await delay(PUSH_INTERVAL_MS);
    assert.equal((await call("/v1/mailbox/events", {
      method: "POST",
      body: { events: [sealedEvent({ eventId: "ring-finish-3", originSeq: 4 })], runFinished: true }
    })).status, 200);
    for (let i = 0; i < 30 && rings.length === 0; i += 1) {
      await delay(100);
    }
    assert.equal(rings.length, 1, "the ring was attempted once");

    pushStatus.value = 201;
    rings.length = 0;
    await delay(PUSH_INTERVAL_MS);
    assert.equal((await call("/v1/mailbox/events", {
      method: "POST",
      body: { events: [sealedEvent({ eventId: "ring-finish-4", originSeq: 5 })], runFinished: true }
    })).status, 200);
    await delay(PUSH_INTERVAL_MS + 500);
    assert.equal(rings.length, 0, "a dropped subscription is not rung again and not retried");
    t.diagnostic("410 dropped the subscription");
  } finally {
    await mf.dispose();
  }
});

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
    async outboundService(request) {
      rings.push({ at: Date.now(), url: request.url, authorization: request.headers.get("authorization") ?? "" });
      if (pushStatus.delayMs) {
        await delay(pushStatus.delayMs);
      }
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

// The User's defect, 2026-09-20: two notifications per finished answer, the
// second one contentless ("Open AccordAgents to sync updates."). Her desktop
// ends a turn in a burst of finish marks — 588 in a day, 480 of them within
// 100ms of the one before — so the relay rang on the first and deferred a ring
// for the rest. By the time the deferred one fired, the phone had answered the
// first, fetched everything, and found an empty box.
//
// The doorbell now rings for what the phone does not have. What it has is what
// it says it has: the cursor it brings on its next read, sent only after the
// page is stored on the device. Not what a response carried — a page that
// never arrives must still be rung for — and not what any other reader took.
test("W-C ring path: the doorbell rings for what the phone does not have", async (t) => {
  const rings = [];
  const pushStatus = { value: 201 };
  let mf;
  try {
    mf = await startWorker(rings, pushStatus);
    await mf.ready;
  } catch (error) {
    assert.fail(`could not start the worker under Miniflare: ${error?.message || error}`);
  }

  const creds = credentials("read-cursor");
  const call = (pathname, { method = "GET", body, query = {} } = {}) => {
    const url = new URL(pathname, "https://relay.test");
    url.searchParams.set("mailboxId", creds.mailboxId);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, String(value));
    }
    return mf.dispatchFetch(url.toString(), {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${creds.token}` },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  };
  let seq = 0;
  const finish = async (label) => {
    seq += 1;
    assert.equal((await call("/v1/mailbox/events", {
      method: "POST",
      body: { events: [sealedEvent({ eventId: `cursor-${label}`, originSeq: seq })], runFinished: true }
    })).status, 200, `append ${label}`);
  };
  // An append that carries no terminal snapshot: progress for a turn still
  // running. It is never marked, so it is never what a ring is about.
  const progress = async (label) => {
    seq += 1;
    assert.equal((await call("/v1/mailbox/events", {
      method: "POST",
      body: { events: [sealedEvent({ eventId: `cursor-${label}`, originSeq: seq })] }
    })).status, 200, `append ${label}`);
  };
  const waitForRings = async (count, ms = PUSH_INTERVAL_MS * 2 + 500) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && rings.length < count) {
      await delay(100);
    }
    return rings.length;
  };
  // What the phone's service worker does once a page is durably stored: it
  // asks for what comes after the cursor it just committed.
  const phoneAcknowledges = async (cursor, extra = {}) => {
    const response = await call("/v1/mailbox/events", {
      query: { reader: "phone", afterArrival: cursor, limit: 500, ...extra }
    });
    assert.equal(response.status, 200);
    return response.json();
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

    // A finished turn as her desktop publishes it: the terminal batch, then
    // the snapshot behind it, milliseconds apart.
    await finish("finish-1");
    assert.equal(await waitForRings(1, 2000), 1, "the answer rings once, straight away");
    await finish("finish-2");

    // The phone was woken, stored both envelopes and said so.
    await phoneAcknowledges(2);
    assert.equal(await waitForRings(2), 1, "nothing is rung twice for what the phone already has");

    // A phone that FETCHED but stored nothing acknowledges nothing: its cursor
    // is still behind, and the doorbell must ring. This is the background sync
    // that times out on a large page, or whose write fails.
    await finish("finish-3");
    await phoneAcknowledges(2);
    assert.equal(await waitForRings(2), 2, "a page the phone did not store is still rung for");
    await phoneAcknowledges(3);

    // The page the phone fetched but did not store, inside the debounce window
    // where the ring is deferred: the response carried everything, the phone
    // kept none of it, and the ring it is still owed must fire.
    await finish("defer-a");
    assert.equal(await waitForRings(3), 3, "the first of the pair rings straight away");
    await finish("defer-b");
    await phoneAcknowledges(3);
    assert.equal(await waitForRings(4), 4, "a deferred ring survives a read that stored nothing");
    await phoneAcknowledges(5);

    // A desktop read — the same box, for the phone's own writes — says nothing
    // about what reached the phone, even when it happens after the ring was
    // armed.
    await finish("finish-4");
    assert.equal((await call("/v1/mailbox/events", { query: { afterArrival: 6, limit: 500 } })).status, 200);
    assert.equal(await waitForRings(5), 5, "a desktop read does not silence the phone's doorbell");
    await phoneAcknowledges(6);

    // A filtered read hands over a slice of the box, so its cursor cannot
    // stand for the whole of it.
    await finish("finish-5");
    await phoneAcknowledges(7, { conversationId: "conversation-ring" });
    assert.equal(await waitForRings(6), 6, "a filtered read does not acknowledge the whole box");
    await phoneAcknowledges(7);

    // Nor does a tail read, which is not a cursor read at all.
    await finish("finish-6");
    assert.equal((await call("/v1/mailbox/events", { query: { reader: "phone", tail: "true", limit: 1 } })).status, 200);
    assert.equal(await waitForRings(7), 7, "a tail read does not acknowledge the whole box");
    await phoneAcknowledges(8);

    // A cursor far beyond the box — a stale one after a renumber, or a
    // mistake — is clamped to what the box holds, so it can silence nothing
    // that arrives afterwards.
    await phoneAcknowledges(1e15);
    await finish("finish-7");
    assert.equal(await waitForRings(8), 8, "an absurd cursor cannot mute the doorbell");
    await phoneAcknowledges(9);

    // The case the User met twice: the phone is woken, stores the finished
    // turn and says so within seconds — and while it does, the desktop keeps
    // appending the next turn's progress. Those envelopes are not a finished
    // run, so the ring deferred behind them must not fire: measured against
    // the newest envelope it did, and she got a second notification for
    // nothing. A real finish after them still rings.
    await finish("quiet-finish-a");
    assert.equal(await waitForRings(9, 2000), 9, "the finished turn rings once");
    // The second finish of the same turn lands inside the debounce window, so
    // its ring is deferred. Before it fires the phone stores everything and
    // says so — and the desktop, already working on the next turn, appends
    // progress behind that acknowledgement.
    await finish("quiet-finish-b");
    await phoneAcknowledges(11);
    await progress("quiet-progress-1");
    await progress("quiet-progress-2");
    assert.equal(await waitForRings(10), 9, "the deferred ring stays quiet: its finish is already on the phone");
    // A genuinely new finished turn still rings, progress or no progress.
    await finish("quiet-finish-c");
    assert.equal(await waitForRings(10), 10, "the next finished turn still rings");
    await phoneAcknowledges(15);
    t.diagnostic(`rings at ${rings.map((ring) => ring.at - rings[0].at).join(", ")}ms`);
  } finally {
    await mf.dispose();
  }
});

// Review finding, 2026-09-22: the ring was awaited inside the append, so the
// desktop's append — which it finishes before sending the live copy to an open
// phone — waited for the push service every time a turn finished, and up to the
// ring's 5s timeout when that service stalled. The append answers first now;
// the ring goes out behind it, and a ring that fails leaves the next one alone.
test("W-C ring path: a finished turn's append does not wait for the push service", async (t) => {
  const rings = [];
  const pushStatus = { value: 201, delayMs: 3000 };
  let mf;
  try {
    mf = await startWorker(rings, pushStatus);
    await mf.ready;
  } catch (error) {
    assert.fail(`could not start the worker under Miniflare: ${error?.message || error}`);
  }

  const creds = credentials("slow-push");
  const call = (pathname, { method = "GET", body, query = {} } = {}) => {
    const url = new URL(pathname, "https://relay.test");
    url.searchParams.set("mailboxId", creds.mailboxId);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, String(value));
    }
    return mf.dispatchFetch(url.toString(), {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${creds.token}` },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  };
  const waitForRings = async (count, ms) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && rings.length < count) {
      await delay(50);
    }
    return rings.length;
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

    // The push service takes 3s to answer. The append must not.
    const started = Date.now();
    const response = await call("/v1/mailbox/events", {
      method: "POST",
      body: { events: [sealedEvent({ eventId: "slow-finish-1", originSeq: 1 })], runFinished: true }
    });
    const appendMs = Date.now() - started;
    assert.equal(response.status, 200);
    // Well under the push service's 3s, with room for a loaded machine.
    assert.ok(appendMs < 1500, `the append answers before the push service does (took ${appendMs}ms)`);
    assert.equal(await waitForRings(1, 2000), 1, "the ring still goes out");

    // A push service that never answers: the ring is attempted, its 5s
    // timeout rejects it inside the relay, and the next finished turn still
    // rings.
    await delay(pushStatus.delayMs + PUSH_INTERVAL_MS);
    pushStatus.delayMs = 6000;
    assert.equal((await call("/v1/mailbox/events", {
      method: "POST",
      body: { events: [sealedEvent({ eventId: "slow-finish-2", originSeq: 2 })], runFinished: true }
    })).status, 200);
    assert.equal(await waitForRings(2, 2000), 2, "the failing ring was attempted");
    pushStatus.delayMs = 0;
    await delay(5000 + PUSH_INTERVAL_MS);
    assert.equal((await call("/v1/mailbox/events", {
      method: "POST",
      body: { events: [sealedEvent({ eventId: "slow-finish-3", originSeq: 3 })], runFinished: true }
    })).status, 200);
    assert.equal(await waitForRings(3, 2000), 3, "a failed ring does not stop the next one");
    const listing = await (await call("/v1/mailbox/events", { query: { afterArrival: 0, limit: 500 } })).json();
    assert.equal(listing.events.length, 3, "every finished turn was stored");
    t.diagnostic(`append took ${appendMs}ms against a 3000ms push service`);
  } finally {
    await mf.dispose();
  }
});

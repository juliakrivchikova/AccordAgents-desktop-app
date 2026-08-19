// W-H: one test body, two implementations.
//
// The mailbox contract has two implementations — the Node reference server the
// harnesses run against, and the Cloudflare worker the phone actually talks to.
// Until now each had its own tests, so the two could drift apart and every
// suite would stay green. This module holds the contract cases *once*; the
// runner parametrizes them over both targets, so drift fails loudly.
//
// Bound, deliberate: the mailbox contract surface only. No RelayRoom WebSocket
// coverage, no duplication of client-side logic, no client-engine conformance.
// Widening it would dilute what a green run means.
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export const CONTRACT_TTL_MS = 3000;

const AUTH_INFO = "accord-mailbox-auth-v1";
const SCOPE_INFO = "accord-mailbox-scope-v1";

export function pairingCredentials(label) {
  // The same derivation the desktop and phone use: scope id and bearer token
  // are both HMACs of the pairing seal key, and the relay stores only the
  // token's hash.
  const sealKey = createHash("sha256").update(`accord-contract-${label}`, "utf8").digest();
  const token = createHmac("sha256", sealKey).update(AUTH_INFO, "utf8").digest("base64url");
  const mailboxId = "mb-" + createHmac("sha256", sealKey).update(SCOPE_INFO, "utf8").digest("base64url").slice(0, 32);
  return {
    sealKey,
    token,
    mailboxId,
    tokenHashBase64Url: createHash("sha256").update(token, "utf8").digest("base64url")
  };
}

function sealed(content) {
  // Shape only: the mailbox must accept a sealed envelope and refuse anything
  // it can read, so the test does not need a real AES-GCM payload here.
  return {
    v: 1,
    alg: "A256GCM",
    iv: randomBytes(12).toString("base64url"),
    ct: Buffer.from(JSON.stringify({ content }), "utf8").toString("base64url")
  };
}

export function mailboxEvent(overrides = {}) {
  return {
    eventId: "contract-event-1",
    conversationId: "conversation-contract",
    logScopeId: "conversation-contract",
    originId: "device-contract",
    originSeq: 1,
    logicalTs: "0000000000000001:device-contract:conversation-contract",
    kind: "message.created",
    payload: sealed("hello from the contract suite"),
    payloadHash: "sha256-payload",
    eventHash: "sha256-event",
    createdAt: "2026-08-16T00:00:00.000Z",
    ...overrides
  };
}

async function call(target, pathname, { method = "GET", token, body, query = {} } = {}) {
  const url = new URL(pathname, target.baseUrl);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, String(value));
  }
  const send = () => fetch(url, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store"
  });

  // `wrangler dev` occasionally drops its connection to the runtime and answers
  // 500 "Network connection lost" — the dev server failing, not the worker
  // answering. Retried once, narrowly: any other status, including a real 500
  // from the worker, is returned as-is so a genuine fault still fails the case.
  let response = await send();
  if (response.status === 500) {
    const detail = await response.clone().text();
    if (detail.includes("Network connection lost")) {
      await delay(250);
      response = await send();
    }
  }
  return response;
}

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    assert.fail(`expected JSON, got ${response.status}: ${text.slice(0, 200)}`);
  }
}

const register = (target, creds) => call(target, "/v1/mailbox/register", {
  method: "POST",
  token: creds.token,
  query: { mailboxId: creds.mailboxId },
  body: { tokenHashBase64Url: creds.tokenHashBase64Url }
});

const append = (target, creds, events) => call(target, "/v1/mailbox/events", {
  method: "POST",
  token: creds.token,
  query: { mailboxId: creds.mailboxId },
  body: { events }
});

const read = (target, creds, afterArrival = 0) => call(target, "/v1/mailbox/events", {
  token: creds.token,
  query: { mailboxId: creds.mailboxId, afterArrival, limit: 500 }
});

// Every case is `{ name, run(target) }`. `target` is `{ baseUrl, kind }` where
// kind is "reference" or "worker" — cases must not branch on it. A case that
// needs to is a divergence, and belongs in the runner with a stated reason.
export const CONTRACT_CASES = [
  {
    name: "an unregistered mailbox refuses reads and appends as unregistered, not unauthorized",
    async run(target) {
      const creds = pairingCredentials(`${target.kind}-unregistered`);
      const response = await read(target, creds);
      assert.equal(response.status, 401);
      const body = await readJson(response);
      // The two 401s must be distinguishable by body, not just status: the
      // phone shows a re-pair screen for one and keeps waiting quietly for the
      // other.
      assert.equal(body.error, "mailbox_unregistered");
    }
  },
  {
    name: "registration locks the mailbox to one token, and a foreign token is unauthorized",
    async run(target) {
      const creds = pairingCredentials(`${target.kind}-locked`);
      assert.equal((await register(target, creds)).status, 200);

      const intruder = { ...creds, token: pairingCredentials(`${target.kind}-intruder`).token };
      const response = await read(target, intruder);
      assert.equal(response.status, 401);
      assert.equal((await readJson(response)).error, "mailbox_unauthorized");
    }
  },
  {
    name: "registration is idempotent for the same token",
    async run(target) {
      const creds = pairingCredentials(`${target.kind}-idempotent`);
      assert.equal((await register(target, creds)).status, 200);
      assert.equal((await register(target, creds)).status, 200);
    }
  },
  {
    name: "an unsealed payload is refused with its own error code",
    async run(target) {
      const creds = pairingCredentials(`${target.kind}-sealing`);
      await register(target, creds);
      const response = await append(target, creds, [mailboxEvent({ payload: { content: "cleartext" } })]);
      assert.equal(response.status, 400);
      assert.equal((await readJson(response)).error, "mailbox_unsealed_payload");
    }
  },
  {
    name: "appends are acked by id, deduped, and served in arrival order with an epoch",
    async run(target) {
      const creds = pairingCredentials(`${target.kind}-arrival`);
      await register(target, creds);

      const first = await readJson(await append(target, creds, [
        mailboxEvent({ eventId: "arrival-a", originSeq: 1 }),
        mailboxEvent({ eventId: "arrival-b", originSeq: 2 })
      ]));
      assert.deepEqual(first.appendedEventIds, ["arrival-a", "arrival-b"]);

      // A duplicate is acked through duplicateEventIds, not appendedEventIds —
      // the publisher treats both as delivered (mailboxSyncClient.ts:121), so
      // an implementation that reported it as newly appended would silently
      // change what "appended" means.
      const repeat = await readJson(await append(target, creds, [mailboxEvent({ eventId: "arrival-a" })]));
      assert.deepEqual(repeat.appendedEventIds, [], "a duplicate is not reported as newly appended");
      assert.deepEqual(repeat.duplicateEventIds, ["arrival-a"], "a duplicate is acked as a duplicate");

      const listing = await readJson(await read(target, creds));
      const ids = listing.events.map((event) => event.eventId);
      assert.deepEqual(ids, ["arrival-a", "arrival-b"], "no duplicate row and arrival order preserved");
      assert.equal(typeof listing.epoch, "string");
      assert.ok(listing.epoch.length > 0, "every listing carries an epoch");

      const seqs = listing.events.map((event) => event.arrivalSeq);
      assert.ok(seqs.every((seq) => Number.isFinite(seq)), "every envelope carries an arrivalSeq");
      assert.ok(seqs[1] > seqs[0], "arrivalSeq increases with arrival");

      // The cursor contract: reading after the first arrival returns only what
      // came later, which is what lets the phone resume without re-reading.
      const resumed = await readJson(await read(target, creds, seqs[0]));
      assert.deepEqual(resumed.events.map((event) => event.eventId), ["arrival-b"]);
    }
  },
  {
    name: "the owner can delete envelopes and the mailbox stops serving them",
    async run(target) {
      const creds = pairingCredentials(`${target.kind}-delete`);
      await register(target, creds);
      await append(target, creds, [
        mailboxEvent({ eventId: "delete-a", originSeq: 1 }),
        mailboxEvent({ eventId: "delete-b", originSeq: 2 })
      ]);

      const deleted = await readJson(await call(target, "/v1/mailbox/delete", {
        method: "POST",
        token: creds.token,
        query: { mailboxId: creds.mailboxId },
        body: { eventIds: ["delete-a"] }
      }));
      assert.deepEqual(deleted.deletedEventIds, ["delete-a"]);

      const listing = await readJson(await read(target, creds));
      assert.deepEqual(listing.events.map((event) => event.eventId), ["delete-b"]);
    }
  },
  {
    name: "a foreign token cannot delete another pairing's envelopes",
    async run(target) {
      const creds = pairingCredentials(`${target.kind}-delete-auth`);
      await register(target, creds);
      await append(target, creds, [mailboxEvent({ eventId: "delete-guarded" })]);

      const intruder = { ...creds, token: pairingCredentials(`${target.kind}-delete-intruder`).token };
      const response = await call(target, "/v1/mailbox/delete", {
        method: "POST",
        token: intruder.token,
        query: { mailboxId: creds.mailboxId },
        body: { eventIds: ["delete-guarded"] }
      });
      assert.equal(response.status, 401);
      assert.equal((await readJson(response)).error, "mailbox_unauthorized");

      const listing = await readJson(await read(target, creds));
      assert.deepEqual(listing.events.map((event) => event.eventId), ["delete-guarded"]);
    }
  },
  {
    name: "events expire by arrival time and the sweep re-arms until the box is empty",
    async run(target) {
      const creds = pairingCredentials(`${target.kind}-ttl`);
      await register(target, creds);
      await append(target, creds, [mailboxEvent({ eventId: "ttl-a", originSeq: 1 })]);

      // A second envelope roughly half a TTL later: when the first expires the
      // sweep must re-arm for this one rather than stopping, which is the
      // single-alarm behavior the retention design depends on.
      await delay(Math.round(CONTRACT_TTL_MS / 2));
      await append(target, creds, [mailboxEvent({ eventId: "ttl-b", originSeq: 2 })]);

      const beforeExpiry = await readJson(await read(target, creds));
      assert.deepEqual(beforeExpiry.events.map((event) => event.eventId), ["ttl-a", "ttl-b"]);

      let remaining = ["ttl-a", "ttl-b"];
      const deadline = Date.now() + CONTRACT_TTL_MS * 4;
      while (Date.now() < deadline && remaining.length > 0) {
        await delay(250);
        remaining = (await readJson(await read(target, creds))).events.map((event) => event.eventId);
      }
      assert.deepEqual(remaining, [], "both envelopes expire, so the sweep re-armed after the first");
    }
  },
  {
    name: "push subscriptions are accepted for the owner and refused for anyone else",
    async run(target) {
      const creds = pairingCredentials(`${target.kind}-push`);
      await register(target, creds);

      const subscription = {
        endpoint: "https://fcm.googleapis.com/fcm/send/contract-suite",
        keys: { p256dh: "contract-p256dh", auth: "contract-auth" }
      };
      const accepted = await call(target, "/v1/mailbox/push-subscription", {
        method: "POST",
        token: creds.token,
        query: { mailboxId: creds.mailboxId },
        body: { subscription }
      });
      assert.equal(accepted.status, 200, await accepted.clone().text());
      assert.equal((await readJson(accepted)).ok, true);

      const intruder = pairingCredentials(`${target.kind}-push-intruder`);
      const refused = await call(target, "/v1/mailbox/push-subscription", {
        method: "POST",
        token: intruder.token,
        query: { mailboxId: creds.mailboxId },
        body: { subscription }
      });
      assert.equal(refused.status, 401);
      assert.equal((await readJson(refused)).error, "mailbox_unauthorized");
    }
  },
  {
    // W-D: an authenticated owner may still only point the wake push at a real
    // Web Push service. Anything else turns the relay into an egress hop.
    name: "push endpoints outside the allowlist are refused with their own code",
    async run(target) {
      const creds = pairingCredentials(`${target.kind}-push-allowlist`);
      await register(target, creds);

      const save = (endpoint) => call(target, "/v1/mailbox/push-subscription", {
        method: "POST",
        token: creds.token,
        query: { mailboxId: creds.mailboxId },
        body: { subscription: { endpoint, keys: { p256dh: "p", auth: "a" } } }
      });

      for (const allowed of [
        "https://fcm.googleapis.com/fcm/send/abc",
        "https://web.push.apple.com/abc",
        "https://updates.push.services.mozilla.com/wpush/v2/abc",
        "https://xyz.notify.windows.com/w/?token=abc"
      ]) {
        const response = await save(allowed);
        assert.equal(response.status, 200, `${allowed} must be accepted: ${await response.clone().text()}`);
      }

      for (const [rejected, why] of [
        ["http://fcm.googleapis.com/fcm/send/abc", "plain http"],
        ["https://attacker.test/collect", "unknown host"],
        ["https://internal.local:8080/probe", "internal host"],
        // Suffix matching must be on a dot boundary, not a substring: this
        // host merely *contains* an allowlisted name.
        ["https://push.apple.com.attacker.test/abc", "lookalike host"],
        ["https://evilpush.apple.com.co/abc", "lookalike suffix"]
      ]) {
        const response = await save(rejected);
        assert.equal(response.status, 400, `${why} must be refused: ${rejected}`);
        assert.equal((await readJson(response)).error, "mailbox_push_endpoint_rejected", why);
      }
    }
  },
  {
    // W-G: revocation is terminal. A cleared mailbox is indistinguishable from
    // one that never existed, which would let a restored backup — or the
    // revoked phone itself — re-register the same scope id and bring the
    // mailbox back.
    name: "a revoked mailbox is terminal and says so on every route",
    async run(target) {
      const creds = pairingCredentials(`${target.kind}-revoked`);
      await register(target, creds);
      await append(target, creds, [mailboxEvent({ eventId: "revoked-a" })]);

      const revoked = await call(target, "/v1/mailbox/revoke", {
        method: "POST",
        token: creds.token,
        query: { mailboxId: creds.mailboxId },
        body: {}
      });
      assert.equal(revoked.status, 200);
      assert.equal((await readJson(revoked)).revoked, true);

      // Its own credentials cannot bring it back, and every route says the same
      // thing — including register, which is the resurrection path.
      for (const [pathname, options] of [
        ["/v1/mailbox/events", { token: creds.token, query: { afterArrival: 0 } }],
        ["/v1/mailbox/events", { method: "POST", token: creds.token, body: { events: [mailboxEvent({ eventId: "revoked-b" })] } }],
        ["/v1/mailbox/register", { method: "POST", token: creds.token, body: { tokenHashBase64Url: creds.tokenHashBase64Url } }],
        ["/v1/mailbox/delete", { method: "POST", token: creds.token, body: { eventIds: ["revoked-a"] } }],
        ["/v1/mailbox/push-subscription", { method: "POST", token: creds.token, body: { subscription: { endpoint: "https://fcm.googleapis.com/fcm/send/x", keys: { p256dh: "p", auth: "a" } } } }]
      ]) {
        const response = await call(target, pathname, { ...options, query: { mailboxId: creds.mailboxId, ...(options.query ?? {}) } });
        const detail = await response.clone().text();
        assert.equal(response.status, 401, `${pathname} must refuse a revoked mailbox (got ${response.status}: ${detail.slice(0, 160)})`);
        assert.equal((await readJson(response)).error, "mailbox_revoked", `${pathname} must say revoked, not unregistered`);
      }

      // A different pairing is untouched: revocation is per mailbox, and
      // re-pairing derives a fresh scope id and a different object.
      const fresh = pairingCredentials(`${target.kind}-revoked-fresh`);
      const freshResponse = await register(target, fresh);
      const freshBody = await freshResponse.clone().text();
      assert.equal(freshResponse.status, 200, `re-pairing is unaffected (${freshResponse.status}: ${freshBody}) mailbox=${fresh.mailboxId} revoked=${creds.mailboxId}`);
    }
  }
];

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createReferenceMailboxServer } = require("./mailbox-reference-server.cjs");

test("reference mailbox acks exact eventIds and range-syncs scoped events", async () => {
  const mailbox = createReferenceMailboxServer();
  const address = await mailbox.listen();
  try {
    const first = event({ eventId: "event-1", originSeq: 1 });
    const second = event({ eventId: "event-2", originSeq: 2 });
    const ack = await postJson(`${address.url}/v1/mailbox/events`, { events: [first, second] });
    const duplicate = await postJson(`${address.url}/v1/mailbox/events`, { events: [first] });
    const range = await getJson(`${address.url}/v1/mailbox/events?conversationId=conversation-1&logScopeId=conversation-1&originId=device-1&afterSeq=1`);

    assert.deepEqual(ack, {
      ackRole: "mailbox",
      eventIds: ["event-1", "event-2"],
      appendedEventIds: ["event-1", "event-2"],
      duplicateEventIds: []
    });
    assert.deepEqual(duplicate, {
      ackRole: "mailbox",
      eventIds: ["event-1"],
      appendedEventIds: [],
      duplicateEventIds: ["event-1"]
    });
    assert.deepEqual(range.events.map((item) => item.eventId), ["event-2"]);
  } finally {
    await mailbox.close();
  }
});

test("reference mailbox persists events across restart", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "accordagents-mailbox-"));
  const storePath = path.join(directory, "events.json");
  const firstMailbox = createReferenceMailboxServer({ storePath });
  const firstAddress = await firstMailbox.listen();
  try {
    await postJson(`${firstAddress.url}/v1/mailbox/events`, {
      events: [event({ eventId: "event-persisted", originSeq: 1 })]
    });
  } finally {
    await firstMailbox.close();
  }

  const secondMailbox = createReferenceMailboxServer({ storePath });
  const secondAddress = await secondMailbox.listen();
  try {
    const range = await getJson(`${secondAddress.url}/v1/mailbox/events?conversationId=conversation-1&logScopeId=conversation-1`);
    assert.deepEqual(range.events.map((item) => item.eventId), ["event-persisted"]);
  } finally {
    await secondMailbox.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("locked reference mailbox enforces registration, bearer auth, sealing, partitioning, and revoke", async () => {
  const mailbox = createReferenceMailboxServer({ locked: true });
  const address = await mailbox.listen();
  const token = "token-alpha-1234567890";
  const tokenHash = (await import("node:crypto")).createHash("sha256").update(token, "utf8").digest("base64url");
  const otherToken = "token-beta-1234567890";
  const otherTokenHash = (await import("node:crypto")).createHash("sha256").update(otherToken, "utf8").digest("base64url");
  const sealed = { v: 1, alg: "A256GCM", iv: "aXYtdGVzdA", ct: "Y3QtdGVzdA" };
  try {
    // mailboxId is mandatory in locked mode.
    assert.equal((await rawFetch(`${address.url}/v1/mailbox/events`)).status, 400);
    // Unregistered mailboxes answer nothing.
    assert.equal((await rawFetch(`${address.url}/v1/mailbox/events?mailboxId=mb-a`)).status, 401);
    // Registration requires a bearer token whose hash matches the body.
    assert.equal((await rawFetch(`${address.url}/v1/mailbox/register?mailboxId=mb-a`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tokenHashBase64Url: tokenHash })
    })).status, 401);
    assert.equal((await rawFetch(`${address.url}/v1/mailbox/register?mailboxId=mb-a`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ tokenHashBase64Url: otherTokenHash })
    })).status, 400);
    assert.equal((await rawFetch(`${address.url}/v1/mailbox/register?mailboxId=mb-a`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ tokenHashBase64Url: tokenHash })
    })).status, 200);
    // Registration is idempotent for the same token and exclusive against others.
    assert.equal((await rawFetch(`${address.url}/v1/mailbox/register?mailboxId=mb-a`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ tokenHashBase64Url: tokenHash })
    })).status, 200);
    assert.equal((await rawFetch(`${address.url}/v1/mailbox/register?mailboxId=mb-a`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${otherToken}` },
      body: JSON.stringify({ tokenHashBase64Url: otherTokenHash })
    })).status, 401);
    // Reads and writes require the bearer token.
    assert.equal((await rawFetch(`${address.url}/v1/mailbox/events?mailboxId=mb-a`)).status, 401);
    assert.equal((await rawFetch(`${address.url}/v1/mailbox/events?mailboxId=mb-a`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong-token" },
      body: JSON.stringify({ events: [event({ payload: sealed })] })
    })).status, 401);
    // Plaintext payloads are refused even with the right token.
    assert.equal((await rawFetch(`${address.url}/v1/mailbox/events?mailboxId=mb-a`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ events: [event({ payload: { content: "plaintext" } })] })
    })).status, 400);
    // Sealed payloads with the right token round-trip.
    assert.equal((await rawFetch(`${address.url}/v1/mailbox/events?mailboxId=mb-a`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ events: [event({ payload: sealed })] })
    })).status, 200);
    const listed = await rawFetch(`${address.url}/v1/mailbox/events?mailboxId=mb-a`, {
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(listed.status, 200);
    assert.deepEqual((await listed.json()).events.map((item) => item.eventId), ["event-1"]);
    // Claims are behind the same lock.
    assert.equal((await rawFetch(`${address.url}/v1/mailbox/claims?mailboxId=mb-a`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId: "conversation-1", eventId: "event-1", ownerId: "o", ownerRole: "desktop", runId: "r" })
    })).status, 401);
    // A different mailbox is a different world.
    assert.equal((await rawFetch(`${address.url}/v1/mailbox/events?mailboxId=mb-b`, {
      headers: { authorization: `Bearer ${token}` }
    })).status, 401);
    // Revoke requires the token and destroys the mailbox.
    assert.equal((await rawFetch(`${address.url}/v1/mailbox/revoke?mailboxId=mb-a`, {
      method: "POST",
      headers: { authorization: "Bearer wrong-token" }
    })).status, 401);
    assert.equal((await rawFetch(`${address.url}/v1/mailbox/revoke?mailboxId=mb-a`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` }
    })).status, 200);
    assert.equal((await rawFetch(`${address.url}/v1/mailbox/events?mailboxId=mb-a`, {
      headers: { authorization: `Bearer ${token}` }
    })).status, 401);
  } finally {
    await mailbox.close();
  }
});

test("reference mailbox serves the arrival-cursor contract with epoch, staleness signal, TTL, and owner delete", async () => {
  const mailbox = createReferenceMailboxServer({ locked: true, eventTtlMs: 60_000 });
  const address = await mailbox.listen();
  const token = "cursor-test-token-1234567890";
  const tokenHash = (await import("node:crypto")).createHash("sha256").update(token, "utf8").digest("base64url");
  const auth = { authorization: `Bearer ${token}` };
  const sealed = () => ({ v: 1, alg: "A256GCM", iv: "aXYtdGVzdA", ct: "Y3QtdGVzdA" });
  const base = `${address.url}/v1/mailbox/events?mailboxId=mb-cursor`;
  try {
    const registered = await rawFetch(`${address.url}/v1/mailbox/register?mailboxId=mb-cursor`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({ tokenHashBase64Url: tokenHash })
    });
    const epoch = (await registered.json()).epoch;
    assert.ok(epoch, "registration must mint an epoch");

    for (let index = 1; index <= 3; index += 1) {
      await rawFetch(base, {
        method: "POST",
        headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify({ events: [event({ eventId: `event-${index}`, originSeq: index, payload: sealed() })] })
      });
    }
    // Cursor mode: strictly after N, ascending arrival, epoch echoed.
    const afterOne = await (await rawFetch(`${base}&afterArrival=1`, { headers: auth })).json();
    assert.deepEqual(afterOne.events.map((item) => item.eventId), ["event-2", "event-3"]);
    assert.deepEqual(afterOne.events.map((item) => item.arrivalSeq), [2, 3]);
    assert.equal(afterOne.maxArrivalSeq, 3);
    assert.equal(afterOne.oldestArrivalSeq, 1);
    assert.equal(afterOne.epoch, epoch);
    // Caught-up reader gets nothing and the same watermark.
    const caughtUp = await (await rawFetch(`${base}&afterArrival=3`, { headers: auth })).json();
    assert.equal(caughtUp.events.length, 0);

    // Owner delete removes named events; oldestArrivalSeq moves past them.
    const deleted = await (await rawFetch(`${address.url}/v1/mailbox/delete?mailboxId=mb-cursor`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({ eventIds: ["event-1", "event-2", "missing"] })
    })).json();
    assert.deepEqual(deleted.deletedEventIds, ["event-1", "event-2"]);
    const afterDelete = await (await rawFetch(`${base}&afterArrival=0`, { headers: auth })).json();
    assert.deepEqual(afterDelete.events.map((item) => item.eventId), ["event-3"]);
    assert.equal(afterDelete.oldestArrivalSeq, 3);
    // Delete requires the bearer like everything else.
    assert.equal((await rawFetch(`${address.url}/v1/mailbox/delete?mailboxId=mb-cursor`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventIds: ["event-3"] })
    })).status, 401);
  } finally {
    await mailbox.close();
  }
});

test("reference mailbox expires events by server arrival time and signals the gap to stale cursors", async () => {
  const mailbox = createReferenceMailboxServer({ locked: true, eventTtlMs: 50 });
  const address = await mailbox.listen();
  const token = "ttl-test-token-1234567890";
  const tokenHash = (await import("node:crypto")).createHash("sha256").update(token, "utf8").digest("base64url");
  const auth = { authorization: `Bearer ${token}` };
  const base = `${address.url}/v1/mailbox/events?mailboxId=mb-ttl`;
  try {
    await rawFetch(`${address.url}/v1/mailbox/register?mailboxId=mb-ttl`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({ tokenHashBase64Url: tokenHash })
    });
    await rawFetch(base, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({ events: [event({ eventId: "event-old", originSeq: 1, payload: { v: 1, alg: "A256GCM", iv: "aXY", ct: "Y3Q" } })] })
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const drained = await (await rawFetch(`${base}&afterArrival=0`, { headers: auth })).json();
    assert.equal(drained.events.length, 0, "expired events must be gone");
    assert.equal(drained.maxArrivalSeq, 1);
    // Empty box: oldest = max + 1, so cursor 0 fails the staleness test
    // (cursor + 1 < oldestArrivalSeq) and a phone knows to refill.
    assert.equal(drained.oldestArrivalSeq, 2);
  } finally {
    await mailbox.close();
  }
});

async function rawFetch(url, init) {
  return fetch(url, init);
}

function event(overrides = {}) {
  return {
    eventId: "event-1",
    conversationId: "conversation-1",
    logScopeId: "conversation-1",
    originId: "device-1",
    originSeq: 1,
    logicalTs: "0000000000000001:device-1:conversation-1",
    kind: "message.created",
    payload: { content: "hello" },
    payloadHash: "sha256:payload",
    eventHash: `sha256:${overrides.eventId ?? "event-1"}`,
    createdAt: "2026-08-06T00:00:00.000Z",
    ...overrides
  };
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    assert.fail(await response.text());
  }
  return response.json();
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    assert.fail(await response.text());
  }
  return response.json();
}

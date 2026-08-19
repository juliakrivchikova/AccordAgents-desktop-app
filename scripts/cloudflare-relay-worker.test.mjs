import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import WebSocket from "ws";

import { mailboxEvent as sealedMailboxEvent, pairingCredentials } from "./mailbox-contract-suite.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const wranglerConfig = path.join(repoRoot, "cloudflare/relay/wrangler.jsonc");

test("Cloudflare Durable Object relay forwards only live sealed frames", async () => {
  const worker = await startWranglerRelay();
  try {
    const manifest = await fetchJson(`${worker.httpUrl}/v1/relay/manifest`);
    assert.equal(manifest.ok, true);
    assert.equal(manifest.manifest.provider, "cloudflare-durable-object");
    assert.equal(manifest.manifest.maxFrameBytes, 10_240);
    assert.equal(manifest.manifest.providerHistory, "none");

    const desktop = await openRelaySocket(worker.wsUrl, {
      rid: "rv-cloudflare-forward",
      role: "desktop",
      cap: "PAIRING-FINGERPRINT"
    });
    const phone = await openRelaySocket(worker.wsUrl, {
      rid: "rv-cloudflare-forward",
      role: "phone",
      cap: "PAIRING-FINGERPRINT"
    });
    try {
      const received = nextSealedFrame(desktop);
      const frame = sealedFrame({
        logicalMessageId: "event-1",
        ciphertextChunk: "sealed-mobile-payload"
      });
      phone.send(JSON.stringify(frame));
      assert.deepEqual(await received, frame);
    } finally {
      phone.close();
      desktop.close();
    }
  } finally {
    await worker.close();
  }
});

// A dead socket with no close frame reads as OPEN forever — nothing pings
// these sockets. When the room refused the newcomer instead, one silent
// network drop turned into a permanent lockout: the real desktop was told
// "duplicate relay role" by its own ghost on every reconnect, so no live
// frame could travel and the phone's relay sends timed out into nowhere.
test("Cloudflare Durable Object relay seats the newest connection and evicts the previous holder", async () => {
  const worker = await startWranglerRelay();
  try {
    const first = await openRelaySocket(worker.wsUrl, {
      rid: "rv-cloudflare-guards",
      role: "desktop",
      cap: "PAIRING-FINGERPRINT"
    });
    const firstClosed = closeEvent(first);
    const second = await openRelaySocket(worker.wsUrl, {
      rid: "rv-cloudflare-guards",
      role: "desktop",
      cap: "PAIRING-FINGERPRINT"
    });
    const seated = JSON.parse(await nextData(second));
    assert.deepEqual(await firstClosed, { code: 4001, reason: "replaced by newer connection" });
    assert.equal(seated.type, "relay.ready");
    assert.equal(seated.role, "desktop");

    // The replacement holds a working seat: phone frames land on it.
    const phone = await openRelaySocket(worker.wsUrl, {
      rid: "rv-cloudflare-guards",
      role: "phone",
      cap: "PAIRING-FINGERPRINT"
    });
    const received = nextSealedFrame(second);
    const frame = sealedFrame({
      logicalMessageId: "after-eviction",
      ciphertextChunk: "sealed-after-eviction"
    });
    phone.send(JSON.stringify(frame));
    assert.deepEqual(await received, frame);

    phone.send(JSON.stringify(sealedFrame({
      logicalMessageId: "oversize",
      ciphertextChunk: "x".repeat(12_000)
    })));
    assert.equal(await closeCode(phone), 1009);
    second.close();
  } finally {
    await worker.close();
  }
});

test("Cloudflare Durable Object mailbox durably acks, dedupes, scopes, and range-syncs events", async () => {
  const worker = await startWranglerRelay();
  try {
    const owner = pairingCredentials("worker-suite-events");
    const otherOwner = pairingCredentials("worker-suite-events-other");
    await registerMailbox(worker, owner);
    await registerMailbox(worker, otherOwner);
    const mailboxUrl = `${worker.httpUrl}/v1/mailbox/events?mailboxId=${owner.mailboxId}`;
    const otherMailboxUrl = `${worker.httpUrl}/v1/mailbox/events?mailboxId=${otherOwner.mailboxId}`;
    const first = sealedMailboxEvent({ eventId: "event-cloudflare-mailbox-1", originSeq: 1, originId: "device-cloudflare", conversationId: "conversation-cloudflare", logScopeId: "conversation-cloudflare" });
    const second = sealedMailboxEvent({ eventId: "event-cloudflare-mailbox-2", originSeq: 2, originId: "device-cloudflare", conversationId: "conversation-cloudflare", logScopeId: "conversation-cloudflare" });
    const other = sealedMailboxEvent({ eventId: "event-cloudflare-mailbox-other", originSeq: 3, originId: "device-cloudflare", conversationId: "conversation-cloudflare", logScopeId: "conversation-cloudflare" });

    const ack = await postJson(mailboxUrl, { events: [first, second] }, owner.token);
    assert.deepEqual(ack, {
      ackRole: "mailbox",
      eventIds: [first.eventId, second.eventId],
      appendedEventIds: [first.eventId, second.eventId],
      duplicateEventIds: []
    });

    const duplicate = await postJson(mailboxUrl, { events: [first] }, owner.token);
    assert.deepEqual(duplicate, {
      ackRole: "mailbox",
      eventIds: [first.eventId],
      appendedEventIds: [],
      duplicateEventIds: [first.eventId]
    });

    await postJson(otherMailboxUrl, { events: [other] }, otherOwner.token);
    const range = await fetchJson(`${mailboxUrl}&conversationId=conversation-cloudflare&logScopeId=conversation-cloudflare&originId=device-cloudflare&afterSeq=1`, owner.token);
    assert.deepEqual(range.events.map((event) => event.eventId), [second.eventId]);

    const allScoped = await fetchJson(`${mailboxUrl}&limit=10`, owner.token);
    assert.deepEqual(allScoped.events.map((event) => event.eventId), [first.eventId, second.eventId]);

    const tail = await fetchJson(`${mailboxUrl}&limit=1&tail=true`, owner.token);
    assert.deepEqual(tail.events.map((event) => event.eventId), [second.eventId]);

    const isolated = await fetchJson(`${otherMailboxUrl}&conversationId=conversation-cloudflare&logScopeId=conversation-cloudflare`, otherOwner.token);
    assert.deepEqual(isolated.events.map((event) => event.eventId), [other.eventId]);
  } finally {
    await worker.close();
  }
});

test("Cloudflare Durable Object mailbox grants one execution claim per live mobile event", async () => {
  const worker = await startWranglerRelay();
  try {
    const owner = pairingCredentials("worker-suite-claims");
    await registerMailbox(worker, owner);
    const claimUrl = `${worker.httpUrl}/v1/mailbox/claims?mailboxId=${owner.mailboxId}`;
    const first = await postJson(claimUrl, {
      conversationId: "conversation-cloudflare",
      eventId: "mobile-event-claim",
      ownerId: "cloud-runner-a",
      ownerRole: "cloud-runner",
      runId: "mobile-mobile-event-claim",
      ttlMs: 60_000
    }, owner.token);
    assert.equal(first.ok, true);
    assert.equal(first.acquired, true);
    assert.equal(first.claim.ownerId, "cloud-runner-a");

    const duplicate = await postJson(claimUrl, {
      conversationId: "conversation-cloudflare",
      eventId: "mobile-event-claim",
      ownerId: "desktop-route",
      ownerRole: "desktop",
      runId: "mobile-mobile-event-claim",
      ttlMs: 60_000
    }, owner.token);
    assert.equal(duplicate.ok, true);
    assert.equal(duplicate.acquired, false);
    assert.equal(duplicate.claim.ownerId, "cloud-runner-a");

    const renewed = await postJson(claimUrl, {
      conversationId: "conversation-cloudflare",
      eventId: "mobile-event-claim",
      ownerId: "cloud-runner-a",
      ownerRole: "cloud-runner",
      runId: "mobile-mobile-event-claim",
      ttlMs: 60_000
    }, owner.token);
    assert.equal(renewed.ok, true);
    assert.equal(renewed.acquired, true);
    assert.equal(renewed.claim.ownerId, "cloud-runner-a");
    assert.equal(renewed.claim.claimedAt, first.claim.claimedAt);
  } finally {
    await worker.close();
  }
});

async function startWranglerRelay() {
  const port = await freePort();
  const persistTo = await mkdtemp(path.join(tmpdir(), "accordagents-cloudflare-relay-"));
  const child = spawn("npx", [
    "wrangler",
    "dev",
    "--config",
    wranglerConfig,
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--local",
    "--persist-to",
    persistTo,
    "--log-level",
    "error",
    "--show-interactive-dev-session",
    "false"
  ], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NO_COLOR: "1"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const output = [];
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));

  const httpUrl = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/v1/relay`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`wrangler dev exited early:\n${output.join("")}`);
    }
    try {
      const health = await fetchJson(`${httpUrl}/healthz`);
      if (health.ok) {
        return {
          httpUrl,
          wsUrl,
          close: async () => {
            child.kill("SIGTERM");
            await Promise.race([
              new Promise((resolve) => child.once("exit", resolve)),
              delay(5_000)
            ]);
            if (child.exitCode === null) {
              child.kill("SIGKILL");
            }
            await rm(persistTo, { recursive: true, force: true });
          }
        };
      }
    } catch {
      await delay(250);
    }
  }
  child.kill("SIGTERM");
  await rm(persistTo, { recursive: true, force: true });
  throw new Error(`wrangler dev did not become ready:\n${output.join("")}`);
}

// The mailbox is locked: every route needs a registered owner and a bearer
// token derived from the pairing seal key. These tests predate the lock, so
// they register first and carry the token, exactly like the desktop does.
async function registerMailbox(worker, creds) {
  await postJson(
    `${worker.httpUrl}/v1/mailbox/register?mailboxId=${creds.mailboxId}`,
    { tokenHashBase64Url: creds.tokenHashBase64Url },
    creds.token
  );
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to allocate test port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function fetchJson(url, token) {
  const response = await fetch(url, token ? { headers: { authorization: `Bearer ${token}` } } : undefined);
  assert.equal(response.ok, true, `${url} returned ${response.status}`);
  return response.json();
}

async function postJson(url, body, token) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    assert.fail(`${url} returned ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

function openRelaySocket(baseUrl, query) {
  const url = new URL(baseUrl);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function nextData(socket) {
  return new Promise((resolve) => {
    socket.once("message", (data) => {
      resolve(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
    });
  });
}

function nextSealedFrame(socket) {
  return new Promise((resolve) => {
    const onMessage = (data) => {
      const parsed = JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
      if (parsed.protocol !== "accord-relay-v1") {
        socket.once("message", onMessage);
        return;
      }
      resolve(parsed);
    };
    socket.once("message", onMessage);
  });
}

function closeCode(socket) {
  return new Promise((resolve) => {
    socket.once("close", (code) => resolve(code));
  });
}

function closeEvent(socket) {
  return new Promise((resolve) => {
    socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

function sealedFrame(overrides = {}) {
  return {
    protocol: "accord-relay-v1",
    streamId: "route-cloudflare:phone",
    logicalMessageId: "event-cloudflare",
    frameId: "event-cloudflare:0:1",
    frameIndex: 0,
    frameCount: 1,
    ciphertextChunk: "sealed",
    ...overrides
  };
}

function mailboxEvent(overrides = {}) {
  const event = {
    eventId: "event-cloudflare-mailbox",
    conversationId: "conversation-cloudflare",
    logScopeId: "conversation-cloudflare",
    originId: "device-cloudflare",
    originSeq: 1,
    logicalTs: "0000000000000001:device-cloudflare:conversation-cloudflare",
    kind: "message.created",
    payload: { content: "from PWA while desktop is unavailable" },
    payloadHash: "sha256-payload",
    eventHash: "sha256-event",
    createdAt: "2026-08-12T00:00:00.000Z",
    ...overrides
  };
  return event;
}

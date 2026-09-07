/**
 * The receiving half of a chat action.
 *
 * Emitting an action is not a user scenario: a signature made on one machine
 * has to become part of the next machine's own state. This drives a real
 * MachineHostService with a real signed device event and checks that it did.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { StorageService } from "../dist/main/main/services/storage.js";
import { ChatEventLogService } from "../dist/main/main/services/chatEventLog.js";
import { MachineHostService } from "../dist/main/main/services/machineHost.js";
import { ChatActionApplier } from "../dist/main/main/services/chatActionApplier.js";
import { DESKTOP_ID, MACHINE_ID } from "./machine-test-events.mjs";

function pairing(issuer) {
  const now = Date.now();
  return {
    version: 1, purpose: "machine-host", issuer,
    rendezvousId: "action-room", stableRoutingId: "route-action",
    relaySealKeyBase64: Buffer.alloc(32, 9).toString("base64url"),
    relayUrl: "ws://127.0.0.1:1/v1/relay",
    capabilities: [{ scope: "device", canRead: true, canWrite: true, canRunCloudParticipants: true, canListConversations: true }],
    fingerprint: "ACTION-TEST", createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString()
  };
}

async function harness(revisions) {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-action-apply-"));
  const storage = new StorageService({ dbPath: path.join(dir, "host.sqlite3") });
  const source = new StorageService({ dbPath: path.join(dir, "source.sqlite3") });
  const eventLog = new ChatEventLogService(storage);
  const sourceLog = new ChatEventLogService(source);
  const [identity, sender] = await Promise.all([
    eventLog.getOrCreateDeviceIdentity(), sourceLog.getOrCreateDeviceIdentity()
  ]);
  const inserted = [];
  const logs = [];
  const client = {
    on: () => () => undefined, connect: async () => undefined, close: () => undefined,
    sendCiphertext: async () => []
  };
  const host = new MachineHostService(
    {
      runMachineHostedTurn: async () => ({ messages: [], warnings: [] }),
      cancelRun: () => true,
      respondToAppToolApproval: async () => undefined,
      applyReplicatedConversation: async () => undefined
    },
    { getConversation: async () => undefined },
    { importMachineSettingsSnapshot: async () => undefined },
    { write: async (event, payload) => { logs.push({ event, payload }); } },
    {
      chatActions: new ChatActionApplier({
        artifacts: {
          getRevision: async (_artifactId, versionEventId) => revisions[versionEventId],
          insertSignature: async (record) => {
            if (inserted.some((entry) => entry.versionEventId === record.versionEventId && entry.signer === record.signer)) return false;
            inserted.push(record);
            return true;
          }
        }
      }),
      pairing: pairing(sender), deviceId: identity.originId, appVersion: "test",
      eventStorage: storage, eventLog, publicKeyDerBase64: identity.publicKeyDerBase64,
      outboxPath: path.join(dir, "outbox.json"), createClient: () => client
    }
  );
  await host.start();
  const send = async (kind, payload) => {
    const { event } = await sourceLog.appendLocalEvent({
      conversationId: "chat", kind, payload,
      logScopeId: `device:action-room:${JSON.stringify(["chat", "actions"])}`
    });
    await host.eventChannel.receive({
      protocol: "accord-device-events-v1", from: sender.originId, to: identity.originId, type: "event", event
    });
    return event;
  };
  return { host, send, inserted, logs, cleanup: async () => { host.close(); await rm(dir, { recursive: true, force: true }); } };
}

test("a signature made on another machine is applied here, once", async () => {
  const h = await harness({ "rev-1": { version: 1, contentHash: "hash-1", superseded: false } });
  try {
    await h.host.handleBody({ type: "machine.hello.ack", desktopDeviceId: DESKTOP_ID, machineId: MACHINE_ID, appVersion: "test" });
    await h.send("artifact.signature.added", {
      operationId: "op-sig-1", targetKey: "artifact:plan",
      signer: "gera", signedStateId: "rev-1", signedContentHash: "hash-1"
    });
    assert.equal(h.inserted.length, 1, "the signature must reach this machine's own state");
    assert.equal(h.inserted[0].signer, "gera");
    assert.equal(h.inserted[0].version, 1);

    // A redelivery of the same action changes nothing.
    await h.send("artifact.signature.added", {
      operationId: "op-sig-1", targetKey: "artifact:plan",
      signer: "gera", signedStateId: "rev-1", signedContentHash: "hash-1"
    });
    assert.equal(h.inserted.length, 1);
  } finally { await h.cleanup(); }
});

test("a signature for a revision this machine lacks is kept for retry, not lost", async () => {
  const h = await harness({});
  try {
    await h.host.handleBody({ type: "machine.hello.ack", desktopDeviceId: DESKTOP_ID, machineId: MACHINE_ID, appVersion: "test" });
    await h.send("artifact.signature.added", {
      operationId: "op-sig-2", targetKey: "artifact:plan",
      signer: "drew", signedStateId: "rev-missing", signedContentHash: "hash-x"
    });
    assert.deepEqual(h.inserted, []);
    assert.ok(
      h.logs.some((entry) => entry.event === "machine-host.action.applied" && entry.payload?.status === "deferred"),
      "it is deferred and reported, not silently dropped"
    );
  } finally { await h.cleanup(); }
});

test("a change made on a revision this machine has replaced is reported as superseded", async () => {
  const h = await harness({ "rev-1": { version: 1, contentHash: "hash-1", superseded: true } });
  try {
    await h.host.handleBody({ type: "machine.hello.ack", desktopDeviceId: DESKTOP_ID, machineId: MACHINE_ID, appVersion: "test" });
    await h.send("artifact.revision.created", {
      operationId: "op-rev-1", targetKey: "artifact:plan", stateId: "rev-2b", contentHash: "hash-2b",
      precondition: { expectedStateId: "rev-1", expectedContentHash: "hash-1" }
    });
    assert.ok(
      h.logs.some((entry) => entry.event === "machine-host.action.applied" && entry.payload?.status === "superseded"),
      "the losing change is visible, not written over the winner"
    );
  } finally { await h.cleanup(); }
});

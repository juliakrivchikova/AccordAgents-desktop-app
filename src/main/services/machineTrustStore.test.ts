import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { MachineTrustStore } from "./machineTrustStore";
import { createChatEventDeviceIdentity } from "./chatEventLog";
import { signMachineControl, verifyMachineControl } from "./machineControlAuthentication";
import type { MachineTrustRoster } from "../../shared/machineTrust";
import type { MachineLinkEnvelope } from "../../shared/machineLink";

const owner = createChatEventDeviceIdentity(new Date().toISOString());
const other = createChatEventDeviceIdentity(new Date().toISOString());
const peer = { deviceId: other.originId, publicKeyDerBase64: other.publicKeyDerBase64, role: "desktop" as const,
  relayUrl: "wss://relay.example/v1/relay", rendezvousId: "room", relaySealKeyBase64: Buffer.alloc(32, 1).toString("base64url") };
const roster = (peers = [peer], updatedAt = "2026-09-07T12:00:00.000Z"): MachineTrustRoster => ({ version: 1, issuerDeviceId: owner.originId, updatedAt, peers });
const event = (seq: number) => ({ originId: owner.originId, logScopeId: "trust-stream", originSeq: seq, eventId: `e${seq}`, eventHash: `h${seq}` });
const disk = { mkdir: fs.mkdir, readFile: fs.readFile, rename: fs.rename, writeFile: fs.writeFile, unlink: fs.unlink };

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "accord-trust-store-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return path.join(dir, "trust.json");
}

test("failed rename never changes authority in memory; the same revocation retries and survives restart", async t => {
  const file = await fixture(t);
  let fail = false;
  const store = new MachineTrustStore(file, "self", owner.originId, { ...disk, rename: async (...args) => {
    if (fail) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    return fs.rename(...args);
  } });
  await store.accept(roster(), event(1));
  fail = true;
  await assert.rejects(store.accept(roster([]), event(2)), /disk full/);
  assert.equal(store.peer(other.originId)?.deviceId, other.originId);
  assert.equal((await new MachineTrustStore(file, "self", owner.originId).load())?.peers.length, 1);
  fail = false;
  await store.accept(roster([]), event(2));
  assert.equal((await new MachineTrustStore(file, "self", owner.originId).load())?.peers.length, 0);
});

test("signed sequence persists even for unchanged peers and outranks reversed wall clocks", async t => {
  const file = await fixture(t);
  const store = new MachineTrustStore(file, "self", owner.originId);
  await store.accept(roster(), event(1));
  await store.accept(roster([], "2020-01-01T00:00:00Z"), event(3));
  await store.accept(roster([], "2019-01-01T00:00:00Z"), event(4));
  const restarted = new MachineTrustStore(file, "self", owner.originId);
  await restarted.accept(roster(), event(2));
  assert.deepEqual(restarted.peers(), []);
  await assert.rejects(restarted.accept(roster(), event(4)), /Conflicting/);
});

test("overlapping updates serialize their full compare, write and publication", async t => {
  const file = await fixture(t);
  const store = new MachineTrustStore(file, "self", owner.originId);
  await Promise.all([store.accept(roster(), event(1)), store.accept(roster([]), event(2)), store.accept(roster(), event(1))]);
  assert.deepEqual((await new MachineTrustStore(file, "self", owner.originId).load())?.peers, []);
});

test("corrupt and unreadable trust cannot be silently replaced by a new grant", async t => {
  const file = await fixture(t);
  await fs.writeFile(file, "{broken bytes");
  const store = new MachineTrustStore(file, "self", owner.originId);
  await assert.rejects(store.accept(roster(), event(1)));
  assert.equal(await fs.readFile(file, "utf8"), "{broken bytes");
  const blocked = new MachineTrustStore(file, "self", owner.originId, { ...disk,
    readFile: (async () => { throw Object.assign(new Error("unreadable"), { code: "EACCES" }); }) as typeof fs.readFile });
  await assert.rejects(blocked.accept(roster(), event(2)), /unreadable/);
  assert.equal(await fs.readFile(file, "utf8"), "{broken bytes");
});

test("another issuer, mismatched keys and duplicate identities cannot become trusted", async t => {
  const store = new MachineTrustStore(await fixture(t), "self", owner.originId);
  await assert.rejects(store.accept({ ...roster(), issuerDeviceId: other.originId }, event(1)), /issuer/);
  await assert.rejects(store.accept(roster(), { ...event(1), originId: other.originId }), /identity/);
  await assert.rejects(store.accept(roster([{ ...peer, publicKeyDerBase64: owner.publicKeyDerBase64 }]), event(1)), /identity/);
  await assert.rejects(store.accept(roster([peer, peer]), event(1)), /identity/);
  assert.deepEqual(store.peers(), []);
});

test("presence is bound to the enrolled signer, room, recipient and complete body", () => {
  const body: MachineLinkEnvelope = { protocol: "accord-machine-link-v1", messageId: "hello", sentAt: "now",
    body: { type: "machine.hello.ack", desktopDeviceId: owner.originId, appVersion: "test", machineId: "home" } };
  const expected = { from: owner.originId, publicKeyDerBase64: owner.publicKeyDerBase64, to: other.originId, room: "room" };
  const signed = signMachineControl(body, owner, "room", other.originId);
  assert.equal(verifyMachineControl(signed, expected), true);
  for (const forged of [body, signMachineControl(body, other, "room", other.originId),
    { ...signed, body: { ...body.body, machineId: "stolen-home" } }, { ...signed, messageId: "replay-as-new" }]) {
    assert.equal(verifyMachineControl(forged, expected), false);
  }
  assert.equal(verifyMachineControl(signed, { ...expected, room: "another-room" }), false);
  assert.equal(verifyMachineControl(signed, { ...expected, to: "another-recipient" }), false);
});

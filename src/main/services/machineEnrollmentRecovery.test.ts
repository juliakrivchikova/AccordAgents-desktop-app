import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SettingsService } from "./settings";
import { MachineLinkService } from "./machineLink";
import { createHeadlessPlatform, setHostPlatform } from "../platform";
import { assertRecoverableMachineEnrollment } from "../../shared/machineEnrollmentRecovery";
import type { MobilePairingPackage } from "../../shared/mobilePairing";

function recoveryPairing(room: string): MobilePairingPackage {
  return { version: 1, purpose: "machine-host", issuer: { originId: "desktop", keyId: "key", publicKeyDerBase64: "public-key" },
    rendezvousId: room, stableRoutingId: "stable-owner-route", relaySealKeyBase64: Buffer.alloc(32, 3).toString("base64url"),
    relayUrl: "wss://relay.example/v1/relay", fingerprint: "capability", createdAt: "2026-09-01T00:00:00.000Z",
    expiresAt: "2036-09-01T00:00:00.000Z", capabilities: [{ scope: "device", canRead: true, canWrite: true, canRunCloudParticipants: true, canListConversations: true }] };
}

test("restoring an enrollment commits the sealed route before reconnect, survives restart and refuses stale or foreign recovery", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-enrollment-recovery-"));
  setHostPlatform(createHeadlessPlatform({ userDataDir: dir }));
  const make = () => { const s = new SettingsService(); (s as any).settingsPath = path.join(dir, "settings.json"); return s; };
  const requested = recoveryPairing("recreated"), installed = recoveryPairing("installed");
  const clients: EventEmitter[] = [];
  const connections: string[] = [];
  const settings = make();
  const link = new MachineLinkService(settings, { write: async () => {} }, {
    appVersion: "test", desktopDeviceId: "desktop", eventStorage: {} as any, eventLog: {} as any,
    createClient: pairing => {
      const client = Object.assign(new EventEmitter(), { close: () => {}, connect: async () => {
        const disk = make();
        assert.equal((await disk.listMachines())[0].pairingKey, pairing.rendezvousId);
        assert.deepEqual(await disk.getMachinePairing(pairing.rendezvousId), pairing);
        connections.push(pairing.rendezvousId);
      } });
      clients.push(client); return client as any;
    }
  });
  try {
    const record = { id: "machine", name: "Cloud run", deviceId: "", pairingKey: requested.rendezvousId, createdAt: requested.createdAt };
    await settings.saveMachine(record, requested);
    await link.connectMachine(record);
    const restore = link.restoreEnrollment(record.id, JSON.stringify(requested), JSON.stringify(installed), "original-home");
    assert.equal(link.restoreEnrollment(record.id, JSON.stringify(requested), JSON.stringify(installed), "original-home"), restore);
    await assert.rejects(link.restoreEnrollment(record.id, JSON.stringify(requested), JSON.stringify(recoveryPairing("conflicting"))), /Another connection recovery/);
    assert.equal(await restore, "original-home");
    assert.deepEqual(connections, ["recreated", "installed"]);
    clients[0].emit("peer", { type: "peer-connected", peer: { role: "machine", deviceId: "late-old-peer" } });
    assert.equal(link.isMachineConnected(record.id), false, "retired client events cannot resurrect the previous link");
    assert.equal((await make().listMachines())[0].pairingKey, "installed");
    await settings.restoreMachineEnrollment(record.id, requested, installed, "original-home"); // redelivery
    const before = await readFile(path.join(dir, "settings.json"), "utf8");
    assert.ok(!before.includes(installed.relaySealKeyBase64));
    await assert.rejects(settings.restoreMachineEnrollment("original-home", requested, recoveryPairing("a-third-room")), /changed during setup/);
    await assert.rejects(settings.restoreMachineEnrollment(record.id, installed, { ...installed, issuer: { ...installed.issuer, originId: "other-desktop" } }), /another environment/);
    assert.equal(await readFile(path.join(dir, "settings.json"), "utf8"), before);
    await settings.removeMachine("original-home");
    await assert.rejects(settings.restoreMachineEnrollment(record.id, requested, installed), /not found/);
  } finally { link.close(); setHostPlatform(undefined); await rm(dir, { recursive: true, force: true }); }
});

test("a failed enrollment save retains the old in-memory and on-disk route for retry", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-recovery-disk-"));
  const platform = createHeadlessPlatform({ userDataDir: dir });
  setHostPlatform(platform);
  const settings = new SettingsService();
  (settings as any).settingsPath = path.join(dir, "settings.json");
  const old = recoveryPairing("new"), installed = recoveryPairing("existing");
  const record = { id: "one", name: "Cloud run", deviceId: "", pairingKey: old.rendezvousId, createdAt: old.createdAt };
  try {
    await settings.saveMachine(record, old);
    let release!: () => void;
    (settings as any).storedWriteQueue = new Promise<void>(resolve => { release = resolve; });
    const first = settings.restoreMachineEnrollment(record.id, old, installed);
    let duplicateFinished = false;
    const duplicate = settings.restoreMachineEnrollment(record.id, old, installed).then(() => { duplicateFinished = true; });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(duplicateFinished, false, "a duplicate waits for the first durable commit");
    release(); await first; await duplicate;
    await settings.saveMachine(record, old);
    const before = await readFile(path.join(dir, "settings.json"), "utf8");
    const previousInstalled = await settings.getMachinePairing(installed.rendezvousId);
    (settings as any).settingsPath = path.join(dir, "settings.json", "not-a-directory");
    await assert.rejects(settings.restoreMachineEnrollment(record.id, old, installed));
    assert.equal((await settings.listMachines())[0].pairingKey, old.rendezvousId);
    assert.deepEqual(await settings.getMachinePairing(installed.rendezvousId), previousInstalled);
    assert.equal(await readFile(path.join(dir, "settings.json"), "utf8"), before);
    (settings as any).settingsPath = path.join(dir, "settings.json");
    await settings.restoreMachineEnrollment(record.id, old, installed);
    assert.equal((await settings.listMachines())[0].pairingKey, installed.rendezvousId);
    await settings.saveMachine({ ...record, id: "two" }, old);
    await assert.rejects(settings.restoreMachineEnrollment("two", old, installed), /already connected/);
    await settings.saveMachine({ ...record, pendingRuns: [{ runId: "pending", conversationId: "chat" }] }, old);
    await assert.rejects(settings.restoreMachineEnrollment(record.id, old, installed), /pending actions/);
  } finally { setHostPlatform(undefined); await rm(dir, { recursive: true, force: true }); }
});

test("connection recovery rejects another key and non-machine capabilities", () => {
  const expected = recoveryPairing("new"), installed = recoveryPairing("old");
  assert.throws(() => assertRecoverableMachineEnrollment(expected, { ...installed, issuer: { ...installed.issuer, publicKeyDerBase64: "foreign-key" } }), /another environment/);
  assert.throws(() => assertRecoverableMachineEnrollment(expected, { ...installed, purpose: "phone-control" }), /another environment/);
});

test("a never-connected replacement restores the original immutable home id and install record atomically", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-recovery-home-"));
  setHostPlatform(createHeadlessPlatform({ userDataDir: dir }));
  const settings = new SettingsService();
  (settings as any).settingsPath = path.join(dir, "settings.json");
  const requested = recoveryPairing("new"), installed = recoveryPairing("original-room");
  const record = { id: "temporary", name: "Cloud run", deviceId: "", pairingKey: "new", createdAt: requested.createdAt };
  try {
    await settings.saveMachine(record, requested);
    await settings.saveMachineInstall({ machineId: record.id, target: { host: "example" }, installRoot: "/install", userDataDir: "/data", serviceName: "machine", serviceScope: "user" });
    (settings as any).settingsPath = path.join(dir, "settings.json", "invalid");
    await assert.rejects(settings.restoreMachineEnrollment(record.id, requested, installed, "original-home"));
    assert.equal((await settings.listMachines())[0].id, record.id);
    assert.equal((await settings.listMachineInstalls())[0].machineId, record.id);
    (settings as any).settingsPath = path.join(dir, "settings.json");
    const restored = await settings.restoreMachineEnrollment(record.id, requested, installed, "original-home");
    assert.equal(restored.id, "original-home");
    assert.deepEqual((await settings.listMachines()).map(m => m.id), ["original-home"]);
    assert.equal((await settings.listMachineInstalls())[0].machineId, "original-home");
    assert.equal((await settings.restoreMachineEnrollment(record.id, requested, installed, "original-home")).id, "original-home");
    await settings.saveMachine({ ...record, deviceId: "already-used" }, requested);
    await assert.rejects(settings.restoreMachineEnrollment(record.id, requested, installed, "different-home"), /identity cannot be replaced/);
    assert.equal((await settings.listMachines()).find(m => m.id === record.id)?.deviceId, "already-used");
  } finally { setHostPlatform(undefined); await rm(dir, { recursive: true, force: true }); }
});

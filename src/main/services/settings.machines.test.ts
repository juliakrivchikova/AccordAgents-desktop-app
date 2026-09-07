import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SettingsService } from "./settings";
import { createHeadlessPlatform, setHostPlatform } from "../platform";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

test("a machine power key stays sealed and local through settings export/import and secret-store failures", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-power-settings-"));
  const config = { version: 1 as const, instanceId: "i-0123456789abcdef0",
    credentials: { accessKeyId: "AKIAFAKEMACHINEPOWER1", secretAccessKey: "synthetic-power-secret", region: "us-east-1" } };
  const make = () => { const service = new SettingsService(); (service as any).settingsPath = path.join(dir, "settings.json"); return service; };
  setHostPlatform(createHeadlessPlatform({ userDataDir: dir, appVersion: "test" }));
  try {
    await make().saveMachinePower(config);
    const raw = await readFile(path.join(dir, "settings.json"), "utf8");
    assert.equal(raw.includes(config.credentials.secretAccessKey), false);
    assert.equal(raw.includes(config.credentials.accessKeyId), false);
    assert.ok(JSON.parse(raw).encryptedMachinePower.startsWith("sealed:"));
    assert.deepEqual(await make().getMachinePower(), config);
    const snapshot = await make().exportMachineSettingsSnapshot();
    assert.equal(snapshot.settingsJson.includes("MachinePower"), false);
    assert.equal(JSON.stringify(snapshot).includes(config.credentials.secretAccessKey), false);
    await make().importMachineSettingsSnapshot({ ...snapshot, settingsJson: JSON.stringify({
      ...JSON.parse(snapshot.settingsJson), encryptedMachinePower: "a different machine's key"
    }) });
    assert.deepEqual(await make().getMachinePower(), config);
    const platform = createHeadlessPlatform({ userDataDir: dir, appVersion: "test" });
    setHostPlatform({ ...platform, secrets: { ...platform.secrets, isEncryptionAvailable: () => false } });
    await assert.rejects(make().getMachinePower(), /secret store/);
    await assert.rejects(make().saveMachinePower(config), /secret store/);
    const disk = JSON.parse(await readFile(path.join(dir, "settings.json"), "utf8"));
    assert.equal(disk.encryptedMachinePower, JSON.parse(raw).encryptedMachinePower, "failed writes never erase the existing key");
    await writeFile(path.join(dir, "settings.json"), "damaged-settings");
    await assert.rejects(make().getMachinePower(), /could not be read/);
    await assert.rejects(make().saveMachinePower(config), /left untouched/);
    assert.equal(await readFile(path.join(dir, "settings.json"), "utf8"), "damaged-settings");
  } finally { setHostPlatform(undefined); await rm(dir, { recursive: true, force: true }); }
});

test("machine run intents and held stops survive a fresh SettingsService reading the disk", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-machine-settings-"));
  const file = path.join(dir, "settings.json");
  const instance = (): SettingsService => {
    const service = new SettingsService();
    (service as any).settingsPath = file;
    return service;
  };
  try {
    const record = {
      id: "machine-1", name: "Test machine", deviceId: "device-machine", pairingKey: "pairing-1",
      createdAt: "2026-09-06T00:00:00.000Z",
      pendingRuns: [{ runId: "run-live", conversationId: "chat-1" }],
      pendingCancels: [{ runId: "run-stopped", conversationId: "chat-2" }]
    };
    await instance().saveMachine(record);
    assert.deepEqual((await instance().listMachines())[0].pendingRuns, record.pendingRuns);
    assert.deepEqual((await instance().listMachines())[0].pendingCancels, record.pendingCancels);
    const disk = JSON.parse(await readFile(file, "utf8"));
    disk.machines[0].pendingRuns.push(null, {}, { runId: 12, conversationId: "chat" }, { runId: " ", conversationId: "chat" }, { runId: "run-live", conversationId: "chat-1" });
    await writeFile(file, JSON.stringify(disk));
    const restarted = instance();
    assert.deepEqual((await restarted.listMachines())[0].pendingRuns, record.pendingRuns);
    await restarted.saveMachine({ ...record, pendingRuns: [], pendingCancels: [] });
    assert.deepEqual((await instance().listMachines())[0].pendingRuns, []);
    assert.deepEqual((await instance().listMachines())[0].pendingCancels, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent machine runtimes publish one complete secret key and corrupt keys never get replaced", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-machine-key-"));
  const modulePath = path.join(__dirname, "..", "platform.js");
  const code = `
    const fs = require('node:fs'), path = require('node:path');
    const original = fs.existsSync;
    fs.existsSync = name => {
      const exists = original(name);
      if (name.endsWith('machine-secrets.key') && !exists) {
        fs.writeFileSync(path.join(process.argv[1], process.pid + '.ready'), 'ready');
        const deadline = Date.now() + 5000;
        while (fs.readdirSync(process.argv[1]).filter(name => name.endsWith('.ready')).length < 2) {
          if (Date.now() > deadline) throw new Error('key race barrier timed out');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      }
      return exists;
    };
    const { createHeadlessPlatform } = require(process.argv[2]);
    const platform = createHeadlessPlatform({ userDataDir: process.argv[1], appVersion: 'test' });
    console.log(platform.secrets.encryptString('concurrent-key-proof').toString('base64'));
  `;
  try {
    const results = await Promise.all([1, 2].map(() => promisify(execFile)(process.execPath, ["-e", code, dir, modulePath])));
    const platform = createHeadlessPlatform({ userDataDir: dir, appVersion: "test" });
    for (const result of results) assert.equal(platform.secrets.decryptString(Buffer.from(result.stdout.trim(), "base64")), "concurrent-key-proof");
    const key = path.join(dir, "machine-secrets.key");
    await writeFile(key, "corrupt-key-do-not-replace");
    const restarted = createHeadlessPlatform({ userDataDir: dir, appVersion: "test" });
    assert.throws(() => restarted.secrets.encryptString("secret"), /corrupt/);
    assert.equal(await readFile(key, "utf8"), "corrupt-key-do-not-replace");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a machine settings snapshot applies its environment in one durable write and fails without partial changes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-machine-import-"));
  const file = path.join(dir, "settings.json");
  setHostPlatform(createHeadlessPlatform({ userDataDir: dir, appVersion: "test" }));
  const service = new SettingsService();
  (service as any).settingsPath = file;
  try {
    await service.saveAgentEnvironmentVariable({ key: "OLD_TOKEN", value: "old-value" });
    const snapshot = { version: 1 as const, exportedAt: new Date().toISOString(), settingsJson: JSON.stringify({ cliAgentRunTimeoutMs: 90_000 }),
      agentEnvironment: [{ key: "TEST_TOKEN", value: "synthetic-sensitive-value" }] };
    await service.importMachineSettingsSnapshot(snapshot);
    assert.deepEqual((await service.getManualAgentEnvironment()).env, { TEST_TOKEN: "synthetic-sensitive-value" });
    const stored = await readFile(file, "utf8");
    assert.equal(stored.includes("synthetic-sensitive-value"), false);
    assert.equal(stored.includes("OLD_TOKEN"), false);
    await assert.rejects(service.importMachineSettingsSnapshot({ ...snapshot, agentEnvironment: [{ key: "HOME", value: "refused" }] }));
    assert.equal(await readFile(file, "utf8"), stored);
    (service as any).settingsPath = path.join(file, "cannot-write.json");
    await assert.rejects(service.importMachineSettingsSnapshot({ ...snapshot, agentEnvironment: [{ key: "REPLACEMENT", value: "not-stored" }] }));
    assert.deepEqual((await service.getManualAgentEnvironment()).env, { TEST_TOKEN: "synthetic-sensitive-value" }, "a failed write restores the committed in-memory snapshot");
    (service as any).settingsPath = file;
    assert.equal(await readFile(file, "utf8"), stored);
  } finally { setHostPlatform(undefined); await rm(dir, { recursive: true, force: true }); }
});

test("machine export refuses an unreadable enabled secret instead of deleting it on the receiver", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-machine-export-"));
  const file = path.join(dir, "settings.json");
  const platform = createHeadlessPlatform({ userDataDir: dir, appVersion: "test" });
  setHostPlatform(platform);
  const service = new SettingsService();
  (service as any).settingsPath = file;
  try {
    await service.saveAgentEnvironmentVariable({ key: "TEST_TOKEN", value: "synthetic-secret" });
    const committed = await readFile(file, "utf8");
    platform.secrets.decryptString = () => { throw new Error("secret store unavailable"); };
    await assert.rejects(service.exportMachineSettingsSnapshot(), /TEST_TOKEN could not be read/);
    assert.equal(await readFile(file, "utf8"), committed);
    await service.saveAgentEnvironmentVariable({ key: "TEST_TOKEN", enabled: false });
    assert.deepEqual((await service.exportMachineSettingsSnapshot()).agentEnvironment, []);
  } finally { setHostPlatform(undefined); await rm(dir, { recursive: true, force: true }); }
});

test("a machine's install record never travels to a machine and dies with the machine", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-machine-install-"));
  const file = path.join(dir, "settings.json");
  setHostPlatform(createHeadlessPlatform({ userDataDir: dir }));
  const instance = (): SettingsService => {
    const service = new SettingsService();
    (service as any).settingsPath = file;
    return service;
  };
  try {
    await instance().saveMachine({
      id: "machine-1", name: "Cloud box", deviceId: "", pairingKey: "pairing-1",
      createdAt: "2026-09-06T00:00:00.000Z"
    });
    await instance().saveMachineInstall({
      machineId: "machine-1",
      target: { host: "198.51.100.10", user: "ubuntu", identityFile: "/Users/me/.ssh/accord.pem" },
      installRoot: "/home/ubuntu/accordagents-machine",
      userDataDir: "/home/ubuntu/.accordagents/machine",
      serviceName: "accordagents-machine",
      serviceScope: "system",
      installedVersion: "1.10.4"
    });
    assert.equal((await instance().getMachineInstall("machine-1"))?.installedVersion, "1.10.4");

    await instance().saveMachinePowerHandoffs([{
      handoffId: "handoff-1", machineId: "machine-1", instanceId: "i-0943b28f7231ab93c",
      issuedTo: "phone-1", issuedAt: "2026-09-07T06:00:00.000Z"
    }]);

    // The snapshot a machine receives must not carry this desktop's way in,
    // nor the record of which of the User's devices can wake it.
    const snapshot = await instance().exportMachineSettingsSnapshot();
    assert.ok(!snapshot.settingsJson.includes("machineInstalls"));
    assert.ok(!snapshot.settingsJson.includes("machinePowerHandoffs"));
    assert.ok(!snapshot.settingsJson.includes("phone-1"));
    assert.ok(!snapshot.settingsJson.includes("198.51.100.10"));
    assert.ok(!snapshot.settingsJson.includes("accord.pem"));

    // Applying a snapshot on a machine must not wipe that machine's own records.
    const receiver = instance();
    await receiver.importMachineSettingsSnapshot(snapshot);
    assert.equal((await instance().getMachineInstall("machine-1"))?.installedVersion, "1.10.4");

    // Removing the machine removes the access record with it.
    await instance().removeMachine("machine-1");
    assert.equal(await instance().getMachineInstall("machine-1"), undefined);
    assert.ok(!(await readFile(file, "utf8")).includes("198.51.100.10"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("controller trust stays local when settings are exported or imported", async () => {
  const { createChatEventDeviceIdentity } = await import("./chatEventLog");
  const dir = await mkdtemp(path.join(tmpdir(), "accord-trust-settings-"));
  setHostPlatform(createHeadlessPlatform({ userDataDir: dir, appVersion: "test" }));
  const service = new SettingsService();
  (service as any).settingsPath = path.join(dir, "settings.json");
  try {
    const identity = createChatEventDeviceIdentity(new Date().toISOString());
    const record = { deviceId: identity.originId, publicKeyDerBase64: identity.publicKeyDerBase64,
      role: "desktop" as const, name: "Local controller", addedAt: identity.createdAt };
    await service.saveTrustedDevice(record);
    const snapshot = await service.exportMachineSettingsSnapshot();
    assert.equal(JSON.parse(snapshot.settingsJson).trustedDevices, undefined);
    await service.importMachineSettingsSnapshot({ ...snapshot, settingsJson: JSON.stringify({ trustedDevices: [] }) });
    assert.deepEqual(await service.listTrustedDevices(), [record]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a removed device cannot let itself back in on the pairing it still holds", async () => {
  const { createChatEventDeviceIdentity } = await import("./chatEventLog");
  const dir = await mkdtemp(path.join(tmpdir(), "accord-trust-revoke-"));
  setHostPlatform(createHeadlessPlatform({ userDataDir: dir, appVersion: "test" }));
  const service = new SettingsService();
  (service as any).settingsPath = path.join(dir, "settings.json");
  try {
    const phone = createChatEventDeviceIdentity(new Date().toISOString());
    const pairing = { key: "route\u0000room", createdAt: new Date(Date.now() - 60_000).toISOString() };
    const record = { deviceId: phone.originId, publicKeyDerBase64: phone.publicKeyDerBase64,
      role: "phone" as const, name: "Phone", addedAt: phone.createdAt };
    await service.saveTrustedDevice(record, pairing);
    assert.equal((await service.machinePairingTrust()).authorizedKeys.includes(pairing.key), true);

    // The owner removes it. Announcing the same key on the same pairing is
    // exactly what a phone does on every reconnect, and it used to be enough
    // to put the device straight back in the roster.
    await service.removeTrustedDevice(phone.originId);
    await assert.rejects(() => service.saveTrustedDevice(record, pairing), /pair again/);
    assert.deepEqual(await service.listTrustedDevices(), []);

    // A fresh identity on that same pairing is the same move under a new name.
    const alias = createChatEventDeviceIdentity(new Date().toISOString());
    await assert.rejects(() => service.saveTrustedDevice({
      deviceId: alias.originId, publicKeyDerBase64: alias.publicKeyDerBase64,
      role: "phone" as const, name: "Phone", addedAt: alias.createdAt
    }, pairing), /pair again/);

    // The revocation is a fact on disk, so a restarted app still refuses it.
    const restarted = new SettingsService();
    (restarted as any).settingsPath = path.join(dir, "settings.json");
    assert.equal((await restarted.machinePairingTrust()).revokedKeys.includes(pairing.key), true);
    await assert.rejects(() => restarted.saveTrustedDevice(record, pairing), /pair again/);

    // And a new invitation the owner makes lets the device pair again.
    const fresh = { key: "route-2\u0000room-2", createdAt: new Date().toISOString() };
    await restarted.saveTrustedDevice(record, fresh);
    assert.deepEqual((await restarted.listTrustedDevices()).map(device => device.deviceId), [phone.originId]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("the devices the owner trusts, and the ones removed, survive a restart", async () => {
  const { createChatEventDeviceIdentity } = await import("./chatEventLog");
  const dir = await mkdtemp(path.join(tmpdir(), "accord-trust-restart-"));
  setHostPlatform(createHeadlessPlatform({ userDataDir: dir, appVersion: "test" }));
  const settingsPath = path.join(dir, "settings.json");
  const service = new SettingsService();
  (service as any).settingsPath = settingsPath;
  try {
    const phone = createChatEventDeviceIdentity(new Date().toISOString());
    const laptop = createChatEventDeviceIdentity(new Date().toISOString());
    const pairing = { key: "route-a\u0000room-a", createdAt: new Date(Date.now() - 60_000).toISOString() };
    await service.saveTrustedDevice({ deviceId: phone.originId, publicKeyDerBase64: phone.publicKeyDerBase64,
      role: "phone" as const, name: "Phone", addedAt: phone.createdAt }, pairing);
    await service.saveTrustedDevice({ deviceId: laptop.originId, publicKeyDerBase64: laptop.publicKeyDerBase64,
      role: "desktop" as const, name: "Laptop", addedAt: laptop.createdAt });
    await service.removeTrustedDevice(laptop.originId);

    // Settings are rebuilt field by field when they are read, so anything the
    // rebuild forgets is written to disk and then dropped on the next start.
    // The roster went that way: every trusted device stopped being trusted
    // after a restart, machines were handed an empty roster, and the owner's
    // removals were forgotten just as completely.
    const restarted = new SettingsService();
    (restarted as any).settingsPath = settingsPath;
    assert.deepEqual((await restarted.listTrustedDevices()).map(device => device.deviceId), [phone.originId]);
    const trust = await restarted.machinePairingTrust();
    assert.deepEqual(trust.authorizedKeys, [pairing.key], "the pairing the phone is bound to is still its own");
    await assert.rejects(() => restarted.saveTrustedDevice({
      deviceId: laptop.originId, publicKeyDerBase64: laptop.publicKeyDerBase64,
      role: "desktop" as const, name: "Laptop", addedAt: laptop.createdAt
    }, { key: "route-b\u0000room-b", createdAt: new Date(Date.now() - 120_000).toISOString() }),
      /pair again/, "a device removed before the restart is still removed after it");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

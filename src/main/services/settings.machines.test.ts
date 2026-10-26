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

test("a handover that did not work puts the previous machine power key back, and never travels or touches an unreadable file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-power-revert-"));
  const key = (id: string) => ({ version: 1 as const, instanceId: "i-0123456789abcdef0",
    credentials: { accessKeyId: id, secretAccessKey: `secret-${id}`, region: "us-east-1" } });
  const make = () => { const service = new SettingsService(); (service as any).settingsPath = path.join(dir, "settings.json"); return service; };
  setHostPlatform(createHeadlessPlatform({ userDataDir: dir, appVersion: "test" }));
  try {
    await make().revertMachinePower();
    assert.equal(await make().getMachinePower(), undefined, "nothing to put back is not an error");
    await make().saveMachinePower(key("AKIAFIRSTPOWERKEY001"));
    await make().saveMachinePower(key("AKIASECONDPOWERKEY01"));
    const raw = await readFile(path.join(dir, "settings.json"), "utf8");
    assert.equal(raw.includes("secret-AKIAFIRSTPOWERKEY001"), false, "the previous key stays sealed too");
    const snapshot = await make().exportMachineSettingsSnapshot();
    const previous = JSON.parse(raw).encryptedMachinePowerPrevious as string;
    assert.ok(previous.startsWith("sealed:"));
    assert.equal(JSON.stringify(snapshot).includes(previous), false, "the previous key never travels");
    await make().revertMachinePower();
    assert.deepEqual(await make().getMachinePower(), key("AKIAFIRSTPOWERKEY001"));
    await make().revertMachinePower();
    assert.deepEqual(await make().getMachinePower(), key("AKIAFIRSTPOWERKEY001"), "a revert is used up: a second one changes nothing");
    await rm(path.join(dir, "settings.json"));
    await make().saveMachinePower(key("AKIAFIRSTPOWERKEY001"));
    await make().revertMachinePower();
    assert.equal(await make().getMachinePower(), undefined, "a first key ever is reverted to no key");
    await writeFile(path.join(dir, "settings.json"), "damaged-settings");
    await assert.rejects(make().revertMachinePower(), /left untouched/);
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

test("what the desktop published to a machine's runtime survives a fresh SettingsService reading the disk", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-machine-published-"));
  const file = path.join(dir, "settings.json");
  const instance = (): SettingsService => {
    const service = new SettingsService();
    (service as any).settingsPath = file;
    return service;
  };
  try {
    const published = { instanceId: "runtime-run-1", settings: "digest-of-settings", roster: "digest-of-roster" };
    const record = { id: "machine-p", name: "Published", deviceId: "device-p", pairingKey: "pairing-p", createdAt: "2026-10-22T00:00:00.000Z", published };
    await instance().saveMachine(record);
    assert.deepEqual((await instance().listMachines())[0].published, published, "a desktop restart remembers it, so it publishes nothing again");
    const disk = JSON.parse(await readFile(file, "utf8"));
    disk.machines[0].published = { instanceId: 7, settings: "x".repeat(300), roster: "kept" };
    await writeFile(file, JSON.stringify(disk));
    assert.deepEqual((await instance().listMachines())[0].published, { roster: "kept" }, "malformed parts are dropped, so they are published again");
    disk.machines[0].published = "nonsense";
    await writeFile(file, JSON.stringify(disk));
    assert.equal((await instance().listMachines())[0].published, undefined);
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

test("AWS machine association and prepared project paths survive settings reload", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-machine-cloud-selection-"));
  setHostPlatform(createHeadlessPlatform({ userDataDir: dir, appVersion: "test" }));
  try {
    const service = new SettingsService();
    await service.saveMachine({ id: "cloud", name: "Cloud", deviceId: "", pairingKey: "test", createdAt: "now", awsInstanceId: "i-abc123" });
    await service.saveMachineInstall({ machineId: "cloud", target: { host: "198.51.100.8" }, installRoot: "/home/ubuntu/app",
      userDataDir: "/home/ubuntu/data", serviceName: "test", serviceScope: "user", projects: { "/Users/test/repo": "/home/ubuntu/repo" } });
    const restarted = new SettingsService();
    assert.equal((await restarted.listMachines())[0].awsInstanceId, "i-abc123");
    assert.equal((await restarted.getMachineInstall("cloud"))?.projects?.["/Users/test/repo"], "/home/ubuntu/repo");
  } finally { setHostPlatform(undefined); await rm(dir, { recursive: true, force: true }); }
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

test("the devices the owner trusts, and the ones removed, survive a restart", async () => {
  const { createChatEventDeviceIdentity } = await import("./chatEventLog");
  const dir = await mkdtemp(path.join(tmpdir(), "accord-trust-restart-"));
  setHostPlatform(createHeadlessPlatform({ userDataDir: dir, appVersion: "test" }));
  const settingsPath = path.join(dir, "settings.json");
  const service = new SettingsService();
  (service as any).settingsPath = settingsPath;
  try {
    const phone = createChatEventDeviceIdentity(new Date().toISOString());
    const removedPhone = createChatEventDeviceIdentity(new Date().toISOString());
    const laptop = createChatEventDeviceIdentity(new Date().toISOString());
    const now = new Date().toISOString();
    await service.savePhoneInvite({ inviteId: "invite-1", issuedAt: now, expiresAt: new Date(Date.now() + 600_000).toISOString() });
    assert.equal(await service.admitInvitedPhone({ deviceId: phone.originId, publicKeyDerBase64: phone.publicKeyDerBase64,
      role: "phone", name: "Phone", addedAt: now, inviteId: "invite-1", phoneScope: { scope: "device" } }), true);
    await service.savePhoneInvite({ inviteId: "invite-2", issuedAt: now, expiresAt: new Date(Date.now() + 600_000).toISOString() });
    assert.equal(await service.admitInvitedPhone({ deviceId: removedPhone.originId, publicKeyDerBase64: removedPhone.publicKeyDerBase64,
      role: "phone", name: "Old phone", addedAt: now, inviteId: "invite-2", phoneScope: { scope: "device" } }), true);
    await service.saveTrustedDevice({ deviceId: laptop.originId, publicKeyDerBase64: laptop.publicKeyDerBase64,
      role: "desktop" as const, name: "Laptop", addedAt: laptop.createdAt });
    await service.removeTrustedDevice(laptop.originId);
    await service.removeTrustedDevice(removedPhone.originId);

    // Settings are rebuilt field by field when they are read, so anything the
    // rebuild forgets is written to disk and then dropped on the next start.
    // The roster went that way: every trusted device stopped being trusted
    // after a restart, machines were handed an empty roster, and the owner's
    // removals were forgotten just as completely.
    const restarted = new SettingsService();
    (restarted as any).settingsPath = settingsPath;
    assert.deepEqual((await restarted.listTrustedDevices()).map(device => device.deviceId), [phone.originId]);
    // A phone removed before the restart does not come back with a
    // certificate this desktop has no invite for.
    assert.equal(await restarted.admitInvitedPhone({ deviceId: removedPhone.originId, publicKeyDerBase64: removedPhone.publicKeyDerBase64,
      role: "phone", name: "Old phone", addedAt: now, inviteId: "invite-unknown", phoneScope: { scope: "device" } }), false);
    assert.equal(await restarted.admitInvitedPhone({ deviceId: removedPhone.originId, publicKeyDerBase64: removedPhone.publicKeyDerBase64,
      role: "phone", name: "Old phone", addedAt: now, inviteId: "invite-2", phoneScope: { scope: "device" } }), false,
      "nor with the invite that was revoked with it");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a phone paired again replaces its own entry, and its old code can no longer take it off", async () => {
  const { createChatEventDeviceIdentity } = await import("./chatEventLog");
  const dir = await mkdtemp(path.join(tmpdir(), "accord-phone-repair-"));
  setHostPlatform(createHeadlessPlatform({ userDataDir: dir, appVersion: "test" }));
  const service = new SettingsService();
  (service as any).settingsPath = path.join(dir, "settings.json");
  try {
    const phone = createChatEventDeviceIdentity(new Date().toISOString());
    const now = new Date().toISOString();
    const later = new Date(Date.now() + 600_000).toISOString();
    const admit = (inviteId: string) => service.admitInvitedPhone({ deviceId: phone.originId, publicKeyDerBase64: phone.publicKeyDerBase64,
      role: "phone", name: "iPhone", addedAt: now, inviteId, phoneScope: { scope: "device" } });
    await service.savePhoneInvite({ inviteId: "invite-old", issuedAt: now, expiresAt: later });
    assert.equal(await admit("invite-old"), true);
    await service.savePhoneInvite({ inviteId: "invite-new", issuedAt: now, expiresAt: later });
    assert.equal(await admit("invite-new"), true);
    const trusted = await service.listTrustedDevices();
    assert.deepEqual(trusted.map((device) => [device.deviceId, device.inviteId]), [[phone.originId, "invite-new"]], "one entry, on the new code");
    assert.equal(await service.revokePhoneInvite("invite-old"), undefined, "the old code names no phone any more");
    assert.equal((await service.listTrustedDevices()).length, 1);
    assert.ok((await service.resolvedPhoneInviteIds()).includes("invite-old"));
    assert.equal(await service.revokePhoneInvite("invite-new"), phone.originId);
    assert.deepEqual(await service.listTrustedDevices(), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("what the shared relay set up is taken off once: its machines are named for removal, its phones and files go", async () => {
  const { createChatEventDeviceIdentity } = await import("./chatEventLog");
  const dir = await mkdtemp(path.join(tmpdir(), "accord-relay-removal-"));
  setHostPlatform(createHeadlessPlatform({ userDataDir: dir, appVersion: "test" }));
  const settingsPath = path.join(dir, "settings.json");
  const make = (): SettingsService => { const service = new SettingsService(); (service as any).settingsPath = settingsPath; return service; };
  const pairing = (room: string, hubUrl?: string) => ({ version: 1 as const, purpose: "machine-host" as const,
    issuer: { originId: "desktop", keyId: "key", publicKeyDerBase64: "public-key" }, rendezvousId: room, stableRoutingId: `route-${room}`,
    relaySealKeyBase64: Buffer.alloc(32, 7).toString("base64url"), ...(hubUrl ? { hubUrl } : {}), fingerprint: "F",
    capabilities: [{ scope: "device" as const, canRead: true, canWrite: true, canRunCloudParticipants: true, canListConversations: true }],
    createdAt: "2026-09-01T00:00:00.000Z", expiresAt: "2036-09-01T00:00:00.000Z" });
  try {
    const service = make();
    await service.saveMachine({ id: "relay-box", name: "Relay box", deviceId: "", pairingKey: "rv-relay", createdAt: "2026-09-01T00:00:00.000Z" }, pairing("rv-relay"));
    await service.saveMachine({ id: "server-box", name: "Server box", deviceId: "", pairingKey: "rv-server", createdAt: "2026-10-01T00:00:00.000Z" }, pairing("rv-server", "https://hub.example/"));
    const relayPhone = createChatEventDeviceIdentity(new Date().toISOString());
    const serverPhone = createChatEventDeviceIdentity(new Date().toISOString());
    const desktop = createChatEventDeviceIdentity(new Date().toISOString());
    const now = new Date().toISOString();
    await service.saveTrustedDevice({ deviceId: relayPhone.originId, publicKeyDerBase64: relayPhone.publicKeyDerBase64, role: "phone", name: "iPhone", addedAt: now });
    await service.saveTrustedDevice({ deviceId: desktop.originId, publicKeyDerBase64: desktop.publicKeyDerBase64, role: "desktop", name: "Laptop", addedAt: now });
    await service.savePhoneInvite({ inviteId: "invite-1", issuedAt: now, expiresAt: new Date(Date.now() + 600_000).toISOString() });
    await service.admitInvitedPhone({ deviceId: serverPhone.originId, publicKeyDerBase64: serverPhone.publicKeyDerBase64,
      role: "phone", name: "Pixel", addedAt: now, inviteId: "invite-1", phoneScope: { scope: "device" } });
    await writeFile(path.join(dir, "mobile-paired-devices.json"), "[]\n");
    await writeFile(path.join(dir, "pending-mailbox-revocations.json"), "[]\n");

    assert.deepEqual((await service.relayEraMachines()).map((machine) => machine.id), ["relay-box"]);
    // What was found is kept before anything goes, and merged with what a
    // second, finishing start finds.
    await service.beginRelayRemoval({ machines: ["Relay box"], startKeyHanded: false });
    await service.removeMachine("relay-box");
    await service.beginRelayRemoval({ machines: [], startKeyHanded: true });
    const recorded = await service.finishRelayRemoval();
    assert.deepEqual({ ...recorded, removedAt: undefined }, { removedAt: undefined, machines: ["Relay box"], phones: ["iPhone"], startKeyHanded: true });
    // The phone paired with the server and the other desktop stay.
    assert.deepEqual((await service.listTrustedDevices()).map((device) => device.name).sort(), ["Laptop", "Pixel"]);
    assert.deepEqual((await service.listMachines()).map((machine) => machine.id), ["server-box"]);
    await assert.rejects(readFile(path.join(dir, "mobile-paired-devices.json"), "utf8"), /ENOENT/);
    await assert.rejects(readFile(path.join(dir, "pending-mailbox-revocations.json"), "utf8"), /ENOENT/);

    // Once: a restarted desktop keeps the record for its notice and does not
    // take anything else off (a phone trusted by hand later stays).
    const restarted = make();
    assert.equal((await restarted.relayRemoval())?.phones[0], "iPhone");
    assert.deepEqual(await restarted.relayEraMachines(), []);
    await restarted.saveTrustedDevice({ deviceId: relayPhone.originId, publicKeyDerBase64: relayPhone.publicKeyDerBase64, role: "phone", name: "iPhone", addedAt: now });
    await restarted.beginRelayRemoval({ machines: ["Other"], startKeyHanded: false });
    assert.equal(await restarted.finishRelayRemoval(), undefined);
    assert.equal((await restarted.listTrustedDevices()).length, 3);
    assert.deepEqual((await restarted.relayRemoval())?.machines, ["Relay box"], "a removal recorded once is not changed");
    // Dismissed, it stays dismissed with its record.
    await restarted.dismissRelayRemoval();
    assert.ok((await make().relayRemoval())?.dismissedAt);
    // It never reaches a machine: it names the User's devices.
    assert.ok(!(await restarted.exportMachineSettingsSnapshot()).settingsJson.includes("relayRemoval"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("the automatic-stop switch survives a restart and reaches the machine with the settings snapshot", async () => {
  const desktopDir = await mkdtemp(path.join(tmpdir(), "accord-auto-stop-desktop-"));
  const machineDir = await mkdtemp(path.join(tmpdir(), "accord-auto-stop-machine-"));
  const make = (dir: string) => { const service = new SettingsService(); (service as any).settingsPath = path.join(dir, "settings.json"); return service; };
  setHostPlatform(createHeadlessPlatform({ userDataDir: desktopDir, appVersion: "test" }));
  try {
    assert.equal(await make(desktopDir).getMachineAutoStopEnabled(), true, "a key set up before the switch existed keeps working");
    await make(desktopDir).setMachineAutoStopEnabled(false);
    assert.equal(await make(desktopDir).getMachineAutoStopEnabled(), false);
    const machine = make(machineDir);
    assert.equal(await machine.getMachineAutoStopEnabled(), true);
    await machine.importMachineSettingsSnapshot(await make(desktopDir).exportMachineSettingsSnapshot());
    assert.equal(await make(machineDir).getMachineAutoStopEnabled(), false, "the machine, which decides to stop, is told");
    await make(desktopDir).setMachineAutoStopEnabled(true);
    await make(machineDir).importMachineSettingsSnapshot(await make(desktopDir).exportMachineSettingsSnapshot());
    assert.equal(await make(machineDir).getMachineAutoStopEnabled(), true);
  } finally {
    await rm(desktopDir, { recursive: true, force: true });
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("an unreadable settings file never reads as automatic stop left on, and is not overwritten by the switch", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-auto-stop-unreadable-"));
  const make = () => { const service = new SettingsService(); (service as any).settingsPath = path.join(dir, "settings.json"); return service; };
  setHostPlatform(createHeadlessPlatform({ userDataDir: dir, appVersion: "test" }));
  try {
    await writeFile(path.join(dir, "settings.json"), "{ not json");
    await assert.rejects(make().getMachineAutoStopEnabled(), /could not be read/);
    await assert.rejects(make().setMachineAutoStopEnabled(false), /nothing was changed/);
    assert.equal(await readFile(path.join(dir, "settings.json"), "utf8"), "{ not json");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a removed machine is remembered until what was kept for it has been dropped, and the question's rhythm survives a restart", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-machine-removed-"));
  const file = path.join(dir, "settings.json");
  const instance = (): SettingsService => {
    const service = new SettingsService();
    (service as any).settingsPath = file;
    return service;
  };
  try {
    await instance().saveMachine({ id: "machine-1", name: "Gone", deviceId: "device-gone", pairingKey: "room-gone", createdAt: "2026-09-06T00:00:00.000Z" });
    await instance().saveMachine({ id: "machine-2", name: "Never introduced", deviceId: "", pairingKey: "room-new", createdAt: "2026-09-06T00:00:00.000Z" });
    await instance().removeMachine("machine-1");
    await instance().removeMachine("machine-2");
    // A fresh start still knows what is left to drop, and only for a machine that had an identity.
    assert.deepEqual(await instance().listRemovedMachineOutboxes(), [{ pairingKey: "room-gone", deviceId: "device-gone" }]);
    // So does the time the User was last asked about unused machines, through an unrelated save too.
    await instance().saveMachineInactivityCheckAt("2026-10-01T12:00:00.000Z");
    await instance().saveMachine({ id: "machine-3", name: "Other", deviceId: "device-3", pairingKey: "room-3", createdAt: "2026-09-06T00:00:00.000Z" });
    assert.equal(await instance().getMachineInactivityCheckAt(), "2026-10-01T12:00:00.000Z");
    assert.equal(JSON.stringify((await instance().exportMachineSettingsSnapshot()).settingsJson).includes("room-gone"), false,
      "not part of what machines are sent");
    await instance().clearRemovedMachineOutbox("device-gone");
    assert.deepEqual(await instance().listRemovedMachineOutboxes(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the hub this desktop uses and a machine's key from setup survive a fresh SettingsService reading the disk", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-hub-settings-"));
  const file = path.join(dir, "settings.json");
  const instance = (): SettingsService => {
    const service = new SettingsService();
    (service as any).settingsPath = file;
    return service;
  };
  try {
    const server = { version: 1 as const, region: "us-east-1", instanceName: "accordagents-hub", ip: "52.72.175.0", user: "ubuntu", installedAt: "2026-10-18T19:28:02.800Z", installedVersion: "1.11.2" };
    await instance().saveHubConfig({ url: "https://52.72.175.0", hubId: "hub-1", server });
    await instance().saveMachine({ id: "machine-1", name: "Box", deviceId: "device-machine", pairingKey: "pairing-1", createdAt: "2026-10-18T00:00:00.000Z", devicePublicKeyDerBase64: "MCowBQYDK2VwAyEAkey" });
    const restarted = instance();
    assert.deepEqual(await restarted.getHubConfig(), { url: "https://52.72.175.0", hubId: "hub-1", server });
    assert.equal((await restarted.listMachines())[0].devicePublicKeyDerBase64, "MCowBQYDK2VwAyEAkey");
    // Another write keeps it too.
    await restarted.saveMachine({ id: "machine-2", name: "Box 2", deviceId: "", pairingKey: "pairing-2", createdAt: "2026-10-18T00:00:00.000Z" });
    assert.equal((await instance().getHubConfig())?.url, "https://52.72.175.0");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("forgetting an AWS instance is one write that holds only for the saved instance, and its note stays local", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-aws-gone-notice-"));
  const make = () => { const service = new SettingsService(); (service as any).settingsPath = path.join(dir, "settings.json"); return service; };
  setHostPlatform(createHeadlessPlatform({ userDataDir: dir, appVersion: "test" }));
  const credentials = { accessKeyId: "AKIAFAKEWORKERKEY001", secretAccessKey: "synthetic", region: "us-east-1" };
  const handle = (instanceId: string) => ({ instanceId, securityGroupId: "sg-1", keyName: "accordagents-worker-x", region: "us-east-1",
    instanceType: "t3.small", createdAt: "2026-10-22T11:00:00.000Z" });
  try {
    const notice = { instanceId: "i-0943b28f7231ab93c", at: "2026-10-22T10:00:00.000Z" };
    await make().saveAwsWorkerConnection(credentials, handle("i-0123456789abcdef0"));
    assert.equal(await make().forgetAwsWorkerInstance("i-0943b28f7231ab93c", { keepCredentials: true, notice }), false,
      "a forget about another instance changes nothing");
    assert.equal((await make().getPublicSettings()).cloudRuns.awsHandle?.instanceId, "i-0123456789abcdef0");

    assert.equal(await make().forgetAwsWorkerInstance("i-0123456789abcdef0", { keepCredentials: true, notice }), true);
    const kept = await make().getPublicSettings();
    assert.equal(kept.cloudRuns.awsHandle, undefined);
    assert.equal(kept.cloudRuns.hasAwsCredentials, true, "found gone by the app: the keys stay");
    assert.equal(kept.cloudRuns.mode, "aws");
    assert.deepEqual(await make().getAwsWorkerGoneNotice(), notice);
    const snapshot = await make().exportMachineSettingsSnapshot();
    assert.equal(snapshot.settingsJson.includes("awsWorkerGoneNotice"), false, "a machine never gets it");
    await make().importMachineSettingsSnapshot({ ...snapshot, settingsJson: JSON.stringify({ ...JSON.parse(snapshot.settingsJson), awsWorkerGoneNotice: undefined }) });
    assert.deepEqual(await make().getAwsWorkerGoneNotice(), notice, "nor can one overwrite it");

    await make().saveAwsWorkerConnection(credentials, handle("i-0fedcba9876543210"));
    assert.equal(await make().getAwsWorkerGoneNotice(), undefined, "another instance connected: the note ends");
    assert.equal(await make().forgetAwsWorkerInstance("i-0fedcba9876543210", { keepCredentials: false, mode: "ssh" }), true);
    const deleted = await make().getPublicSettings();
    assert.equal(deleted.cloudRuns.hasAwsCredentials, false, "Delete: the keys go too");
    assert.equal(deleted.cloudRuns.mode, "ssh");
    assert.equal(await make().getAwsWorkerCredentials(), undefined);
  } finally { setHostPlatform(undefined); await rm(dir, { recursive: true, force: true }); }
});

test("machines leaving with a gone instance are recorded durably, cleared one by one, and never travel to a machine", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-leaving-machines-"));
  const make = () => { const service = new SettingsService(); (service as any).settingsPath = path.join(dir, "settings.json"); return service; };
  setHostPlatform(createHeadlessPlatform({ userDataDir: dir, appVersion: "test" }));
  try {
    const at = "2026-10-22T10:00:00.000Z";
    await make().addLeavingMachines([{ machineId: "m1", instanceId: "i-0943b28f7231ab93c", at }, { machineId: "m2", instanceId: "i-0943b28f7231ab93c", at }]);
    await make().addLeavingMachines([{ machineId: "m1", instanceId: "i-0943b28f7231ab93c", at }]);
    assert.deepEqual((await make().listLeavingMachines()).map((entry) => entry.machineId), ["m2", "m1"], "a machine is recorded once");
    const snapshot = await make().exportMachineSettingsSnapshot();
    assert.equal(snapshot.settingsJson.includes("leavingMachines"), false);
    await make().importMachineSettingsSnapshot({ ...snapshot, settingsJson: JSON.stringify({ ...JSON.parse(snapshot.settingsJson), leavingMachines: [] }) });
    assert.equal((await make().listLeavingMachines()).length, 2, "a machine's snapshot cannot clear it");
    await make().clearLeavingMachine("m2");
    await make().clearLeavingMachine("unknown");
    assert.deepEqual((await make().listLeavingMachines()).map((entry) => entry.machineId), ["m1"]);
    await make().clearLeavingMachine("m1");
    assert.deepEqual(await make().listLeavingMachines(), []);
  } finally { setHostPlatform(undefined); await rm(dir, { recursive: true, force: true }); }
});

test("a leaving-machines write that fails leaves the settings in memory as the disk has them; the limit reports what it drops", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-leaving-write-"));
  const settingsDir = path.join(dir, "data");
  const make = () => { const service = new SettingsService(); (service as any).settingsPath = path.join(settingsDir, "settings.json"); return service; };
  setHostPlatform(createHeadlessPlatform({ userDataDir: dir, appVersion: "test" }));
  const { chmod, mkdir } = await import("node:fs/promises");
  try {
    await mkdir(settingsDir, { recursive: true });
    const at = "2026-10-22T10:00:00.000Z";
    const service = make();
    await service.addLeavingMachines([{ machineId: "m1", instanceId: "i-0943b28f7231ab93c", at }]);
    await chmod(settingsDir, 0o500);
    await assert.rejects(service.addLeavingMachines([{ machineId: "m2", instanceId: "i-0943b28f7231ab93c", at }]));
    assert.deepEqual((await service.listLeavingMachines()).map((entry) => entry.machineId), ["m1"], "memory still matches the disk");
    await chmod(settingsDir, 0o700);

    const many = Array.from({ length: 50 }, (_, index) => ({ machineId: `x${index}`, instanceId: "i-0123456789abcdef0", at, unverified: "refused" as const }));
    const dropped = await service.addLeavingMachines(many);
    assert.deepEqual(dropped.map((entry) => entry.machineId), ["m1"], "the oldest entry is reported, not silently lost");
    const kept = await make().listLeavingMachines();
    assert.equal(kept.length, 50);
    assert.equal(kept[0].unverified, "refused", "the reason an entry may not be removed survives a restart");
  } finally {
    await (await import("node:fs/promises")).chmod(settingsDir, 0o700).catch(() => undefined);
    setHostPlatform(undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

test("a machine already waiting for removal is never turned into one the app may not remove", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-leaving-downgrade-"));
  const make = () => { const service = new SettingsService(); (service as any).settingsPath = path.join(dir, "settings.json"); return service; };
  setHostPlatform(createHeadlessPlatform({ userDataDir: dir, appVersion: "test" }));
  try {
    const at = "2026-10-22T10:00:00.000Z";
    await make().addLeavingMachines([{ machineId: "m1", instanceId: "i-0943b28f7231ab93c", at }]);
    await make().addLeavingMachines([{ machineId: "m1", instanceId: "i-0943b28f7231ab93c", at, unverified: "refused" }]);
    assert.equal((await make().listLeavingMachines())[0].unverified, undefined);
    await make().addLeavingMachines([{ machineId: "m2", instanceId: "i-0123456789abcdef0", at, unverified: "refused" }]);
    await make().addLeavingMachines([{ machineId: "m2", instanceId: "i-0123456789abcdef0", at }]);
    assert.equal((await make().listLeavingMachines()).find((entry) => entry.machineId === "m2")?.unverified, undefined,
      "one the app could not check becomes removable once its instance is seen gone");
  } finally { setHostPlatform(undefined); await rm(dir, { recursive: true, force: true }); }
});

test("an unconfirmed leaving machine keeps where to look again and a well-formed account only", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-leaving-recheck-"));
  const make = () => { const service = new SettingsService(); (service as any).settingsPath = path.join(dir, "settings.json"); return service; };
  setHostPlatform(createHeadlessPlatform({ userDataDir: dir, appVersion: "test" }));
  try {
    const at = "2026-10-22T10:00:00.000Z";
    await make().addLeavingMachines([
      { machineId: "m1", instanceId: "i-0943b28f7231ab93c", at, unverified: "refused", region: "us-east-1", accountId: "018089055817" },
      { machineId: "m2", instanceId: "i-0943b28f7231ab93c", at, unverified: "unreadable", region: "us-east-1", accountId: "not-an-account" }
    ]);
    assert.deepEqual((await make().listLeavingMachines()).map((entry) => [entry.machineId, entry.region, entry.accountId]),
      [["m1", "us-east-1", "018089055817"], ["m2", "us-east-1", undefined]]);
  } finally { setHostPlatform(undefined); await rm(dir, { recursive: true, force: true }); }
});

test("a relay removal that failed half way keeps its first failure for the notice across a restart, until it finishes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-relay-removal-failed-"));
  setHostPlatform(createHeadlessPlatform({ userDataDir: dir, appVersion: "test" }));
  const settingsPath = path.join(dir, "settings.json");
  const make = (): SettingsService => { const service = new SettingsService(); (service as any).settingsPath = settingsPath; return service; };
  try {
    await make().beginRelayRemoval({ machines: ["One", "Two"], startKeyHanded: false });
    await make().noteRelayRemovalFailure({ machine: "One", message: "disk full" });
    const pending = await make().relayRemovalPending();
    assert.deepEqual({ machine: pending?.failed?.machine, message: pending?.failed?.message }, { machine: "One", message: "disk full" });
    assert.deepEqual(pending?.machines, ["One", "Two"]);
    await make().dismissRelayRemoval();
    assert.ok((await make().relayRemovalPending())?.failedDismissedAt, "its line, dismissed, stays dismissed");
    // The next start fails again: said again.
    await make().beginRelayRemoval({ machines: ["One"], startKeyHanded: false });
    await make().noteRelayRemovalFailure({ machine: "One", message: "still full" });
    assert.equal((await make().relayRemovalPending())?.failedDismissedAt, undefined);
    const recorded = await make().finishRelayRemoval();
    assert.deepEqual(recorded?.machines, ["One", "Two"]);
    assert.equal(await make().relayRemovalPending(), undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

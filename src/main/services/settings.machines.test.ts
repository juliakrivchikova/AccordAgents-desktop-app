import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SettingsService } from "./settings";
import { createHeadlessPlatform, setHostPlatform } from "../platform";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

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

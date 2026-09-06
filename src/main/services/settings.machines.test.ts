import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SettingsService } from "./settings";

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

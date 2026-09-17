import assert from "node:assert/strict";
import test from "node:test";
import { MachineAutoUpgradeService, type MachineAutoUpgradeOptions } from "./machineAutoUpgrade";
import type { MachineInstallRecord, MachineInstallSnapshot, MachineUpgradeRequest } from "../../shared/machineInstall";
import type { MachineActivity } from "./machineLink";

function record(overrides: Partial<MachineInstallRecord> = {}): MachineInstallRecord {
  return {
    machineId: "m1",
    target: { host: "10.0.0.5", user: "ubuntu" },
    installRoot: "/home/ubuntu/accordagents-machine",
    userDataDir: "/home/ubuntu/.accordagents/machine",
    serviceName: "accordagents-machine",
    serviceScope: "system",
    installedVersion: "1.10.4-beta.10",
    ...overrides
  };
}

function activity(overrides: Partial<MachineActivity> = {}): MachineActivity {
  return { machineId: "m1", connected: true, appVersion: "1.10.4-beta.10", activeRunIds: [], pendingTerminalRunIds: [], dispatchedRunIds: [], ...overrides };
}

function harness(overrides: Partial<MachineAutoUpgradeOptions> & { records?: MachineInstallRecord[]; activity?: () => MachineActivity | undefined } = {}) {
  const upgrades: MachineUpgradeRequest[] = [];
  const progress: MachineInstallSnapshot[] = [];
  const log: Array<{ event: string; payload: Record<string, unknown> }> = [];
  let changed = 0;
  const records = overrides.records ?? [record()];
  const service = new MachineAutoUpgradeService({
    desktopVersion: "1.10.4-beta.11",
    listInstalls: async () => records,
    machineName: async () => "Cloud run",
    machineActivity: async () => (overrides.activity ?? (() => activity()))(),
    payloadReady: () => true,
    upgrade: async (request, onProgress) => {
      upgrades.push(request);
      onProgress({ machineId: request.machineId, operationId: request.operationId, kind: "upgrade", phase: "bundle", message: "Staging…", updatedAt: "", completed: ["preflight"] });
      const snapshot: MachineInstallSnapshot = { machineId: request.machineId, operationId: request.operationId, kind: "upgrade", phase: "ready", message: "Updated.", updatedAt: "", completed: [] };
      return { snapshot, record: { ...records[0], installedVersion: "1.10.4-beta.11", lastOperation: snapshot } };
    },
    onProgress: (snapshot) => { progress.push(snapshot); },
    onChanged: () => { changed += 1; },
    logger: (event, payload) => { log.push({ event, payload }); },
    ...overrides
  });
  return { service, upgrades, progress, log, changed: () => changed, events: () => log.map((entry) => entry.event) };
}

test("a connected, idle machine on an older runtime is upgraded with the stored target and progress", async () => {
  const h = harness();
  await h.service.evaluate();
  assert.equal(h.upgrades.length, 1);
  const request = h.upgrades[0];
  assert.deepEqual(request.target, { host: "10.0.0.5", user: "ubuntu" });
  assert.equal(request.installRoot, "/home/ubuntu/accordagents-machine");
  assert.equal(request.serviceName, "accordagents-machine");
  assert.match(request.operationId, /^auto-upgrade-1\.10\.4-beta\.11-/);
  assert.equal(request.allowDowngrade, undefined, "never a downgrade");
  assert.ok(h.progress.some((snapshot) => snapshot.phase === "bundle"), "the installer's progress reaches Settings → Machines");
  assert.equal(h.changed(), 1);
  assert.deepEqual(h.events(), ["machines.auto-upgrade.start", "machines.auto-upgrade.finished"]);
  await h.service.evaluate();
  assert.equal(h.upgrades.length, 1, "one automatic attempt per machine per desktop version");
});

test("a busy machine is told to wait once and is upgraded when it becomes idle", async () => {
  let running = true;
  const h = harness({ activity: () => activity({ activeRunIds: running ? ["run-1"] : [] }) });
  await h.service.evaluate();
  assert.equal(h.upgrades.length, 0, "the drain would cut the member's turn short");
  assert.equal(h.service.hasWaiting(), true);
  assert.equal(h.progress.length, 1);
  assert.equal(h.progress[0].phase, "preflight");
  assert.match(h.progress[0].message, /Waiting for Cloud run to finish its current work before updating its runtime to 1\.10\.4-beta\.11/);
  await h.service.evaluate();
  assert.equal(h.progress.length, 1, "the waiting notice is shown once");
  running = false;
  await h.service.evaluate("m1");
  assert.equal(h.upgrades.length, 1);
  assert.equal(h.service.hasWaiting(), false);
});

test("a turn this desktop dispatched counts as busy even when the machine's hello predates it", async () => {
  const h = harness({ activity: () => activity({ dispatchedRunIds: ["run-2"] }) });
  await h.service.evaluate();
  assert.equal(h.upgrades.length, 0);
  assert.equal(h.service.hasWaiting(), true);
});

test("a machine that is not connected is left alone until it reports in", async () => {
  const h = harness({ activity: () => undefined });
  await h.service.evaluate();
  assert.equal(h.upgrades.length, 0);
  assert.equal(h.progress.length, 0);
  assert.equal(h.service.hasWaiting(), false);
});

test("a machine already on this desktop's version, or ahead of it, is not touched", async () => {
  const same = harness({ records: [record({ installedVersion: "1.10.4-beta.11" })] });
  await same.service.evaluate();
  assert.equal(same.upgrades.length, 0);
  // The record is behind but the machine reports it runs a newer runtime
  // (installed from another desktop): what runs wins, and the fence would
  // refuse a downgrade anyway.
  let asked = 0;
  const ahead = harness({ activity: () => { asked += 1; return activity({ appVersion: "1.10.5" }); } });
  await ahead.service.evaluate();
  assert.equal(ahead.upgrades.length, 0);
  assert.equal(asked, 1, "the machine was asked what it runs");
});

test("a machine never set up from this desktop, or with a setup action running, is skipped", async () => {
  const fresh = harness({ records: [record({ installedVersion: undefined })] });
  await fresh.service.evaluate();
  assert.equal(fresh.upgrades.length, 0);
  const running = harness({ records: [record({ lastOperation: { machineId: "m1", operationId: "upgrade-1", kind: "upgrade", phase: "transfer", message: "Copying…", updatedAt: "", completed: [] } })] });
  await running.service.evaluate();
  assert.equal(running.upgrades.length, 0, "the button's own upgrade is in progress");
});

test("a failed automatic attempt for this desktop version is not retried on the next start; the manual button is the way forward", async () => {
  const failed = harness({ records: [record({ lastOperation: { machineId: "m1", operationId: "auto-upgrade-1.10.4-beta.11-1", kind: "upgrade", phase: "error", message: "The machine's current runtime did not stop.", updatedAt: "", completed: [] } })] });
  await failed.service.evaluate();
  assert.equal(failed.upgrades.length, 0);
  // A failure from an earlier desktop version does not block this one.
  const older = harness({ records: [record({ lastOperation: { machineId: "m1", operationId: "auto-upgrade-1.10.4-beta.10-1", kind: "upgrade", phase: "error", message: "x", updatedAt: "", completed: [] } })] });
  await older.service.evaluate();
  assert.equal(older.upgrades.length, 1);
});

test("without a runtime payload nothing is attempted and the reason is logged", async () => {
  const h = harness({ payloadReady: () => false });
  await h.service.evaluate();
  assert.equal(h.upgrades.length, 0);
  assert.deepEqual(h.events(), ["machines.auto-upgrade.no-payload"]);
});

test("an installer that refuses to start is logged and the machine is not retried in this process", async () => {
  const h = harness({ upgrade: async () => { throw new Error("Another setup action for this machine is still running."); } });
  await h.service.evaluate();
  assert.ok(h.events().includes("machines.auto-upgrade.error"));
  assert.equal(h.changed(), 1);
  await h.service.evaluate();
  assert.equal(h.events().filter((event) => event === "machines.auto-upgrade.error").length, 1);
});

test("two triggers arriving together start one upgrade, not two", async () => {
  let resolveActivity: (() => void) | undefined;
  const h = harness({ machineActivity: () => new Promise((resolve) => { resolveActivity = () => resolve(activity()); }) });
  const first = h.service.evaluate("m1");
  const second = h.service.evaluate("m1");
  await new Promise((resolve) => setTimeout(resolve, 5));
  resolveActivity?.();
  await first;
  resolveActivity?.();
  await second;
  assert.equal(h.upgrades.length, 1);
});

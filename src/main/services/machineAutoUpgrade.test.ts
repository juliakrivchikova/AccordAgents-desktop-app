import assert from "node:assert/strict";
import test from "node:test";
import { MachineAutoUpgradeService, type MachineAutoUpgradeOptions } from "./machineAutoUpgrade";
import { machineRuntimeStatus, type MachineInstallRecord, type MachineInstallSnapshot, type MachineUpgradeRequest } from "../../shared/machineInstall";
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
  return { machineId: "m1", connected: true, fresh: true, appVersion: "1.10.4-beta.10", activeRunIds: [], pendingTerminalRunIds: [], dispatchedRunIds: [], ...overrides };
}

function snapshot(overrides: Partial<MachineInstallSnapshot> = {}): MachineInstallSnapshot {
  return { machineId: "m1", operationId: "op", kind: "upgrade", phase: "ready", message: "Updated.", updatedAt: "", completed: [], ...overrides };
}

function harness(overrides: Partial<MachineAutoUpgradeOptions> & { records?: MachineInstallRecord[]; activity?: () => MachineActivity | undefined; outcome?: () => MachineInstallSnapshot } = {}) {
  const upgrades: MachineUpgradeRequest[] = [];
  const progress: MachineInstallSnapshot[] = [];
  const log: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const holds: string[] = [];
  let released = 0;
  let changed = 0;
  const records = overrides.records ?? [record()];
  const service = new MachineAutoUpgradeService({
    desktopVersion: "1.10.4-beta.11",
    listInstalls: async () => records,
    machineName: async () => "Cloud run",
    machineActivity: async () => (overrides.activity ?? (() => activity()))(),
    resolveTarget: async (item) => item.target,
    payloadReady: () => ({ ok: true }),
    holdTurns: (machineId, reason) => { holds.push(`${machineId}:${reason}`); return () => { released += 1; }; },
    upgrade: async (request, onProgress) => {
      upgrades.push(request);
      onProgress(snapshot({ operationId: request.operationId, phase: "bundle", message: "Staging…", completed: ["preflight"] }));
      const final = (overrides.outcome ?? (() => snapshot({ operationId: request.operationId })))();
      return { snapshot: final, record: { ...records[0], installedVersion: final.phase === "ready" ? "1.10.4-beta.11" : records[0].installedVersion, lastOperation: final } };
    },
    onProgress: (item) => { progress.push(item); },
    onChanged: () => { changed += 1; },
    logger: (event, payload) => { log.push({ event, payload }); },
    ...overrides
  });
  return { service, upgrades, progress, log, holds, released: () => released, changed: () => changed, events: () => log.map((entry) => entry.event) };
}

test("a connected, idle machine on an older runtime is upgraded with its turns held and progress shown", async () => {
  const h = harness();
  await h.service.evaluate();
  assert.equal(h.upgrades.length, 1);
  const request = h.upgrades[0];
  assert.deepEqual(request.target, { host: "10.0.0.5", user: "ubuntu" });
  assert.equal(request.installRoot, "/home/ubuntu/accordagents-machine");
  assert.equal(request.serviceName, "accordagents-machine");
  assert.match(request.operationId, /^auto-upgrade-1\.10\.4-beta\.11-\d+$/);
  assert.equal(request.allowDowngrade, undefined, "never a downgrade");
  assert.deepEqual(h.holds, ["m1:updating the runtime to 1.10.4-beta.11; the turn starts when the update is done"]);
  assert.equal(h.released(), 1, "the hold is released when the upgrade ends");
  assert.ok(h.progress.some((item) => item.phase === "bundle"), "the installer's progress reaches Settings → Machines");
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
  assert.equal(h.progress[0].operationId, "auto-upgrade-1.10.4-beta.11", "the notice carries the bare prefix");
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

test("a machine that did not answer in time is not taken as idle", async () => {
  // Its last hello says nothing is running, but that hello may predate a
  // turn; stopping the runtime on it could kill that turn.
  const h = harness({ activity: () => activity({ fresh: false, activeRunIds: [] }) });
  await h.service.evaluate();
  assert.equal(h.upgrades.length, 0);
  assert.equal(h.service.hasWaiting(), true);
  assert.match(h.progress[0].message, /Waiting for Cloud run to report what it is doing/);
});

test("a machine that started work while the release was staged is retried once idle, not written off", async () => {
  let busyOnce = true;
  const h = harness({
    outcome: () => {
      if (busyOnce) {
        busyOnce = false;
        return snapshot({ phase: "needs-attention", message: "A member started work on the machine while the update was being staged, so its runtime was not stopped.", recovery: { kind: "machine-busy", detail: "staged" } });
      }
      return snapshot();
    }
  });
  await h.service.evaluate();
  assert.equal(h.upgrades.length, 1);
  assert.equal(h.service.hasWaiting(), true, "back to waiting for idle");
  await h.service.evaluate();
  assert.equal(h.upgrades.length, 2, "attempted again");
  assert.equal(h.released(), 2, "every hold is released");
});

test("a machine that is not connected is left alone until it reports in", async () => {
  const h = harness({ activity: () => undefined });
  await h.service.evaluate();
  assert.equal(h.upgrades.length, 0);
  assert.equal(h.progress.length, 0);
  assert.equal(h.service.hasWaiting(), false);
});

test("a machine that was waiting stops waiting when it goes away or is removed", async () => {
  let connected = true;
  const records = [record()];
  const h = harness({ records, activity: () => (connected ? activity({ activeRunIds: ["run-1"] }) : undefined) });
  await h.service.evaluate();
  assert.equal(h.service.hasWaiting(), true);
  connected = false;
  await h.service.evaluate();
  assert.equal(h.service.hasWaiting(), false, "offline: nothing to wait for");
  connected = true;
  await h.service.evaluate();
  assert.equal(h.service.hasWaiting(), true);
  records.length = 0;
  await h.service.evaluate();
  assert.equal(h.service.hasWaiting(), false, "removed: pruned so the re-check does not run forever");
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
  const running = harness({ records: [record({ lastOperation: snapshot({ operationId: "upgrade-1", phase: "transfer", message: "Copying…" }) })] });
  await running.service.evaluate();
  assert.equal(running.upgrades.length, 0, "the button's own upgrade is in progress");
});

test("a failed automatic attempt for this desktop version is not retried on the next start; the manual button is the way forward", async () => {
  const failed = harness({ records: [record({ lastOperation: snapshot({ operationId: "auto-upgrade-1.10.4-beta.11-1", phase: "error", message: "The machine's current runtime did not stop." }) })] });
  await failed.service.evaluate();
  assert.equal(failed.upgrades.length, 0);
  // A failure from an earlier desktop version does not block this one, and
  // neither does one the button produced: a full run re-proves the machine
  // at preflight before changing anything.
  const older = harness({ records: [record({ lastOperation: snapshot({ operationId: "auto-upgrade-1.10.4-beta.10-1", phase: "error", message: "x" }) })] });
  await older.service.evaluate();
  assert.equal(older.upgrades.length, 1);
  const manual = harness({ records: [record({ lastOperation: snapshot({ operationId: "upgrade-1757000000", phase: "needs-attention", message: "Setup was interrupted." }) })] });
  await manual.service.evaluate();
  assert.equal(manual.upgrades.length, 1);
});

test("a machine whose current address is unknown is not dialed at a dead one, and is asked again later", async () => {
  let address: { host: string } | undefined;
  const h = harness({ resolveTarget: async () => address });
  await h.service.evaluate();
  assert.equal(h.upgrades.length, 0);
  assert.deepEqual(h.events(), ["machines.auto-upgrade.unreachable"]);
  assert.equal(h.service.hasWaiting(), true, "the periodic re-check keeps asking");
  await h.service.evaluate();
  assert.equal(h.events().length, 1, "logged once");
  address = { host: "10.0.0.9" };
  await h.service.evaluate();
  assert.equal(h.upgrades.length, 1);
  assert.equal(h.upgrades[0].target.host, "10.0.0.9", "dialed at the current address, not the record's");
});

test("without a runtime payload nothing is attempted and the machine's row says why", async () => {
  const h = harness({ payloadReady: () => ({ ok: false, message: "dist/machine is missing." }) });
  await h.service.evaluate();
  assert.equal(h.upgrades.length, 0);
  assert.deepEqual(h.events(), ["machines.auto-upgrade.no-payload"]);
  assert.equal(h.progress.length, 1);
  assert.equal(h.progress[0].phase, "error");
  assert.match(h.progress[0].message, /cannot be updated from this desktop: dist\/machine is missing\./);
  await h.service.evaluate();
  assert.equal(h.progress.length, 1, "said once");
});

test("an installer that refuses to start is logged and the machine is not retried in this process", async () => {
  const h = harness({ upgrade: async () => { throw new Error("Another setup action for this machine is still running."); } });
  await h.service.evaluate();
  assert.ok(h.events().includes("machines.auto-upgrade.error"));
  assert.equal(h.changed(), 1);
  assert.equal(h.released(), 1);
  await h.service.evaluate();
  assert.equal(h.events().filter((event) => event === "machines.auto-upgrade.error").length, 1);
});

test("a trigger whose lookup throws is logged, never an unhandled rejection", async () => {
  const h = harness({ listInstalls: async () => { throw new Error("settings unreadable"); } });
  await h.service.evaluate("m1");
  assert.deepEqual(h.events(), ["machines.auto-upgrade.evaluate-error"]);
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

// ---- the Machines row -------------------------------------------------

test("the Machines row says when an update runs, failed, or is still owed, and stays quiet when current", () => {
  const desktopVersion = "1.10.4-beta.11";
  const behind = record();
  assert.equal(machineRuntimeStatus({ install: behind, live: undefined, connected: true, runningVersion: "1.10.4-beta.10", desktopVersion })?.state, "pending");
  assert.equal(machineRuntimeStatus({ install: record({ installedVersion: desktopVersion }), live: undefined, connected: true, runningVersion: desktopVersion, desktopVersion }), undefined);
  assert.equal(machineRuntimeStatus({ install: behind, live: undefined, connected: false, runningVersion: "1.10.5", desktopVersion }), undefined, "what runs wins over the record");
  const live = snapshot({ operationId: "auto-upgrade-1.10.4-beta.11-5", phase: "transfer", message: "Copying the runtime…" });
  assert.deepEqual(machineRuntimeStatus({ install: behind, live, connected: true, runningVersion: "1.10.4-beta.10", desktopVersion }), { state: "updating", text: "Copying the runtime…" });
  // Settings opened mid-update: the record carries the running phase.
  assert.equal(machineRuntimeStatus({ install: record({ lastOperation: live }), live: undefined, connected: true, runningVersion: "1.10.4-beta.10", desktopVersion })?.state, "updating");
  const failed = record({ lastOperation: snapshot({ phase: "needs-attention", message: "The machine's current runtime did not stop, so it was not replaced.", error: "The machine's current runtime did not stop, so it was not replaced." }) });
  assert.deepEqual(machineRuntimeStatus({ install: failed, live: undefined, connected: true, runningVersion: "1.10.4-beta.10", desktopVersion }),
    { state: "failed", text: "Runtime update failed: The machine's current runtime did not stop, so it was not replaced." });
  // Stepping back for a member's work is not a failure.
  const stepped = record({ lastOperation: snapshot({ phase: "needs-attention", message: "A member started work…", recovery: { kind: "machine-busy", detail: "staged" } }) });
  assert.equal(machineRuntimeStatus({ install: stepped, live: undefined, connected: true, runningVersion: "1.10.4-beta.10", desktopVersion })?.state, "pending");
  assert.match(machineRuntimeStatus({ install: stepped, live: undefined, connected: true, runningVersion: "1.10.4-beta.10", desktopVersion })?.text ?? "", /waits for the machine to be idle/);
});

test("the waiting notice is believed only while the machine is connected and behind", () => {
  const desktopVersion = "1.10.4-beta.11";
  const waiting = snapshot({ operationId: "auto-upgrade-1.10.4-beta.11", phase: "preflight", message: "Waiting for Cloud run to finish its current work…" });
  assert.equal(machineRuntimeStatus({ install: record(), live: waiting, connected: true, runningVersion: "1.10.4-beta.10", desktopVersion })?.state, "updating");
  assert.equal(machineRuntimeStatus({ install: record(), live: waiting, connected: false, runningVersion: "1.10.4-beta.10", desktopVersion })?.state, "pending", "offline: the notice is stale");
  assert.equal(machineRuntimeStatus({ install: record({ installedVersion: desktopVersion }), live: waiting, connected: true, runningVersion: desktopVersion, desktopVersion }), undefined, "updated meanwhile: quiet");
  const noPayload = snapshot({ operationId: "auto-upgrade-1.10.4-beta.11", phase: "error", message: "The runtime on Cloud run cannot be updated from this desktop: dist/machine is missing.", error: "dist/machine is missing." });
  assert.deepEqual(machineRuntimeStatus({ install: record(), live: noPayload, connected: true, runningVersion: "1.10.4-beta.10", desktopVersion }), { state: "failed", text: "dist/machine is missing." });
});

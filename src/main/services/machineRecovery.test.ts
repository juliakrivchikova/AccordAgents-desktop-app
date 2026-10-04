import assert from "node:assert/strict";
import test from "node:test";
import type { MachineInstallRecord } from "../../shared/machineInstall";
import {
  MACHINE_RECOVERY_AFTER_MS, MACHINE_RECOVERY_RETRY_MS, MACHINE_RECOVERY_RUNNING_REPORT_MS, MACHINE_RECOVERY_WATCH_GAP_MS,
  MachineRecoveryService
} from "./machineRecovery";

const record: MachineInstallRecord = { machineId: "cloud", target: { host: "203.0.113.9", user: "ubuntu" }, installRoot: "/r",
  userDataDir: "/d", serviceName: "s", serviceScope: "system", installedVersion: "1.11.1" };

function harness() {
  const state = {
    now: 10 * 60 * 60_000, linkStartedAt: 0 as number | undefined, connected: true, relay: true, runningSince: 0 as number | undefined,
    programRunning: false, agents: false, inspectError: undefined as string | undefined, setup: false,
    fail: undefined as string | undefined, reinstalls: [] as string[], inspections: 0, events: [] as string[]
  };
  const service = new MachineRecoveryService({
    now: () => state.now,
    linkStartedAt: () => state.linkStartedAt,
    linkState: () => state.connected ? "connected" : state.relay ? "out-of-touch" : "unknown",
    machineOnInstance: async () => record,
    instanceRunningSince: async () => state.runningSince,
    setupRunning: () => state.setup,
    inspect: async () => {
      state.inspections++;
      if (state.inspectError) throw new Error(state.inspectError);
      return { programRunning: state.programRunning, agentsRunning: state.agents };
    },
    reinstall: async (machineId) => { state.reinstalls.push(machineId); if (state.fail) throw new Error(state.fail); state.connected = true; },
    log: (event) => { state.events.push(event); }
  });
  // Checks every minute, as the desktop's timer does.
  const after = async (ms: number) => {
    let left = ms;
    do {
      const step = Math.min(left, 60_000);
      state.now += step;
      left -= step;
      await service.check();
    } while (left > 0);
  };
  const outOfTouch = async () => { state.connected = false; await after(0); };
  return { state, service, after, outOfTouch };
}

test("a program that is not running on a running instance is set up again by the app after five minutes", async () => {
  const h = harness();
  await h.after(0);
  await h.outOfTouch();
  await h.after(MACHINE_RECOVERY_AFTER_MS - 1);
  assert.deepEqual(h.state.reinstalls, [], "a short gap is a reconnect, not a failure");
  await h.after(1);
  assert.deepEqual(h.state.reinstalls, ["cloud"], "the machine that was watched is the one set up");
  assert.equal(h.service.failure("cloud"), undefined);
  assert.deepEqual(h.state.events.filter((event) => event.startsWith("machines.recovery.")), ["machines.recovery.start", "machines.recovery.finished"]);
});

test("a program that runs is never set up again for being out of touch, and is reported only after half an hour", async () => {
  // A dead link on this side (a laptop that slept) or one on the machine's
  // side looks the same from here; a new setup would fix neither, and each
  // restart would count as work and keep the instance from stopping.
  const h = harness();
  h.state.programRunning = true;
  await h.outOfTouch();
  await h.after(MACHINE_RECOVERY_RUNNING_REPORT_MS - 60_000);
  assert.deepEqual(h.state.reinstalls, []);
  assert.equal(h.service.failure("cloud"), undefined);
  assert.equal(h.state.inspections, 2, "the machine is asked again every fifteen minutes, not every minute");
  await h.after(MACHINE_RECOVERY_RETRY_MS);
  assert.deepEqual(h.state.reinstalls, []);
  assert.deepEqual(h.service.failure("cloud"), { kind: "running" });
  h.state.programRunning = false;
  await h.after(MACHINE_RECOVERY_RETRY_MS);
  assert.deepEqual(h.state.reinstalls, ["cloud"], "once it stops running, it is set up again");
  assert.equal(h.service.failure("cloud"), undefined);
});

test("agents still running are waited for; a wait that outlasts one look is said, and the setup follows when they finish", async () => {
  const h = harness();
  h.state.agents = true;
  await h.outOfTouch();
  await h.after(MACHINE_RECOVERY_AFTER_MS);
  assert.deepEqual(h.state.reinstalls, [], "agents of this deployment are never cut off");
  assert.equal(h.service.failure("cloud"), undefined, "a first wait is not news");
  await h.after(MACHINE_RECOVERY_RETRY_MS);
  assert.deepEqual(h.service.failure("cloud"), { kind: "agents" });
  h.state.agents = false;
  await h.after(MACHINE_RECOVERY_RETRY_MS);
  assert.deepEqual(h.state.reinstalls, ["cloud"]);
  assert.equal(h.service.failure("cloud"), undefined);
});

test("nothing is touched while a setup runs, or while the instance is stopped or just started", async () => {
  const h = harness();
  h.state.setup = true;
  await h.outOfTouch();
  await h.after(MACHINE_RECOVERY_RETRY_MS);
  assert.equal(h.state.inspections, 0);
  h.state.setup = false;
  h.state.runningSince = undefined;
  await h.after(MACHINE_RECOVERY_RETRY_MS);
  assert.equal(h.state.inspections, 0, "a stopped instance has no program to run, and is not started to ask it");
  h.state.runningSince = h.state.now;
  await h.after(60_000);
  assert.equal(h.state.inspections, 0, "an instance that just started is still bringing its program up");
  h.state.runningSince = 0;
  await h.after(60_000);
  assert.deepEqual(h.state.reinstalls, ["cloud"]);
});

test("a desktop that has just started does not judge, and its own watch starts then", async () => {
  const h = harness();
  h.state.linkStartedAt = h.state.now;
  h.state.connected = false;
  await h.after(30_000);
  assert.deepEqual(h.state.reinstalls, []);
  await h.after(60_000);
  await h.after(MACHINE_RECOVERY_AFTER_MS - 1_000);
  assert.deepEqual(h.state.reinstalls, [], "out of touch is counted from this desktop's first look");
  await h.after(1_000);
  assert.deepEqual(h.state.reinstalls, ["cloud"]);
});

test("failed setups are reported with their reason and tried again less and less often; the report clears once the program is back", async () => {
  const h = harness();
  h.state.fail = "ssh: connect to host timed out";
  await h.outOfTouch();
  await h.after(MACHINE_RECOVERY_AFTER_MS);
  assert.deepEqual(h.service.failure("cloud"), { kind: "setup", reason: "ssh: connect to host timed out" });
  await h.after(MACHINE_RECOVERY_RETRY_MS);
  assert.equal(h.state.reinstalls.length, 2, "tried again after fifteen minutes");
  await h.after(2 * MACHINE_RECOVERY_RETRY_MS - 60_000);
  assert.equal(h.state.reinstalls.length, 2, "then after thirty, so a setup that keeps failing does not loop");
  await h.after(60_000);
  assert.equal(h.state.reinstalls.length, 3, "and not given up on");
  h.state.connected = true;
  await h.after(0);
  assert.equal(h.service.failure("cloud"), undefined);
});

test("a machine that cannot be asked is reported as that, and nothing is set up blind", async () => {
  const h = harness();
  h.state.inspectError = "The AWS instance is stopping, so nothing was started.";
  await h.outOfTouch();
  await h.after(MACHINE_RECOVERY_AFTER_MS);
  assert.deepEqual(h.state.reinstalls, []);
  assert.deepEqual(h.service.failure("cloud"), { kind: "check", reason: "The AWS instance is stopping, so nothing was started." });
});

test("a relay this desktop cannot reach, or a desktop that slept, starts the watch again and drops what it knew", async () => {
  const h = harness();
  h.state.fail = "ssh: connect to host timed out";
  await h.outOfTouch();
  await h.after(MACHINE_RECOVERY_AFTER_MS);
  assert.ok(h.service.failure("cloud"));
  h.state.relay = false;
  await h.after(60_000);
  assert.equal(h.service.failure("cloud"), undefined, "an old failure is not shown as news while this side is cut off");
  h.state.fail = undefined;
  await h.after(MACHINE_RECOVERY_AFTER_MS);
  assert.equal(h.state.reinstalls.length, 1, "the program may be fine; only this side lost the relay");
  h.state.relay = true;
  await h.after(0);
  await h.after(MACHINE_RECOVERY_AFTER_MS - 1);
  assert.equal(h.state.reinstalls.length, 1, "out of touch is counted from when the relay was reachable again");
  await h.after(1);
  assert.equal(h.state.reinstalls.length, 2);

  const slept = harness();
  await slept.outOfTouch();
  slept.state.now += 2 * MACHINE_RECOVERY_AFTER_MS;
  assert.ok(2 * MACHINE_RECOVERY_AFTER_MS > MACHINE_RECOVERY_WATCH_GAP_MS);
  await slept.service.check();
  assert.deepEqual(slept.state.reinstalls, [], "a check after a sleep starts a new watch rather than judging across it");
  await slept.after(MACHINE_RECOVERY_AFTER_MS);
  assert.deepEqual(slept.state.reinstalls, ["cloud"]);
});

test("a check that fails to read its own records never rejects into the timer", async () => {
  const events: string[] = [];
  const service = new MachineRecoveryService({
    now: () => 10 * 60 * 60_000, linkStartedAt: () => 0, linkState: () => "out-of-touch",
    machineOnInstance: async () => { throw new Error("settings unreadable"); },
    instanceRunningSince: async () => 0, setupRunning: () => false,
    inspect: async () => ({ programRunning: false, agentsRunning: false }), reinstall: async () => undefined,
    log: (event) => { events.push(event); }
  });
  await service.check();
  assert.deepEqual(events, ["machines.recovery.error"]);
});

import assert from "node:assert/strict";
import test from "node:test";
import type { MachineInstallRecord } from "../../shared/machineInstall";
import { MACHINE_RECOVERY_AFTER_MS, MACHINE_RECOVERY_RETRY_MS, MACHINE_RECOVERY_WATCH_GAP_MS, MachineRecoveryService } from "./machineRecovery";

const record: MachineInstallRecord = { machineId: "cloud", target: { host: "203.0.113.9", user: "ubuntu" }, installRoot: "/r",
  userDataDir: "/d", serviceName: "s", serviceScope: "system", installedVersion: "1.11.1" };

function harness() {
  const state = {
    now: 10 * 60 * 60_000, linkStartedAt: 0 as number | undefined, connected: true, relay: true, runningSince: 0 as number | undefined,
    agents: false, setup: false, fail: undefined as string | undefined, reinstalls: 0, events: [] as string[]
  };
  const service = new MachineRecoveryService({
    now: () => state.now,
    linkStartedAt: () => state.linkStartedAt,
    linkState: () => state.connected ? "connected" as const : state.relay ? "out-of-touch" as const : "unknown" as const,
    machineOnInstance: async () => record,
    instanceRunningSince: async () => state.runningSince,
    setupRunning: () => state.setup,
    agentsRunning: async () => state.agents,
    reinstall: async () => { state.reinstalls++; if (state.fail) throw new Error(state.fail); state.connected = true; },
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
  return { state, service, after };
}

test("a program out of touch for five minutes on a running instance is set up again by the app", async () => {
  const h = harness();
  await h.after(0);
  h.state.connected = false;
  await h.after(0);
  await h.after(MACHINE_RECOVERY_AFTER_MS - 1);
  assert.equal(h.state.reinstalls, 0, "a short gap is a reconnect, not a failure");
  await h.after(1);
  assert.equal(h.state.reinstalls, 1);
  assert.equal(h.service.failure("cloud"), undefined);
  assert.deepEqual(h.state.events.filter((event) => event.startsWith("machines.recovery.")), ["machines.recovery.start", "machines.recovery.finished"]);
});

test("nothing is touched while agents run, while a setup runs, or while the instance is stopped or just started", async () => {
  const h = harness();
  h.state.connected = false;
  await h.after(0);
  h.state.agents = true;
  await h.after(MACHINE_RECOVERY_AFTER_MS);
  assert.equal(h.state.reinstalls, 0, "agents of this deployment still running are never cut off");
  h.state.agents = false;
  h.state.setup = true;
  await h.after(MACHINE_RECOVERY_RETRY_MS);
  assert.equal(h.state.reinstalls, 0);
  h.state.setup = false;
  h.state.runningSince = undefined;
  await h.after(MACHINE_RECOVERY_RETRY_MS);
  assert.equal(h.state.reinstalls, 0, "a stopped instance has no program to run");
  h.state.runningSince = h.state.now;
  await h.after(60_000);
  assert.equal(h.state.reinstalls, 0, "an instance that just started is still bringing its program up");
  h.state.runningSince = 0;
  await h.after(60_000);
  assert.equal(h.state.reinstalls, 1);
});

test("a desktop that has just started does not judge, and its own watch starts then", async () => {
  const h = harness();
  h.state.linkStartedAt = h.state.now;
  h.state.connected = false;
  await h.after(30_000);
  assert.equal(h.state.reinstalls, 0);
  await h.after(60_000);
  await h.after(MACHINE_RECOVERY_AFTER_MS - 1_000);
  assert.equal(h.state.reinstalls, 0, "out of touch is counted from this desktop's first look");
  await h.after(1_000);
  assert.equal(h.state.reinstalls, 1);
});

test("a failed attempt is reported and tried again later; the report clears once the program is back", async () => {
  const h = harness();
  h.state.connected = false;
  h.state.fail = "ssh: connect to host timed out";
  await h.after(0);
  await h.after(MACHINE_RECOVERY_AFTER_MS);
  assert.equal(h.service.failure("cloud"), "ssh: connect to host timed out");
  await h.after(MACHINE_RECOVERY_RETRY_MS - 1);
  assert.equal(h.state.reinstalls, 1, "not hammered");
  await h.after(1);
  assert.equal(h.state.reinstalls, 2, "and not given up on");
  h.state.connected = true;
  await h.after(0);
  assert.equal(h.service.failure("cloud"), undefined);
});

test("a relay this desktop cannot reach, or a desktop that slept, starts the watch again instead of reinstalling", async () => {
  const h = harness();
  h.state.connected = false;
  await h.after(0);
  h.state.relay = false;
  await h.after(MACHINE_RECOVERY_AFTER_MS);
  assert.equal(h.state.reinstalls, 0, "the program may be fine; only this side lost the relay");
  h.state.relay = true;
  await h.after(60_000);
  await h.after(MACHINE_RECOVERY_AFTER_MS - 60_000);
  assert.equal(h.state.reinstalls, 0, "out of touch is counted from when the relay was reachable again");
  await h.after(60_000);
  assert.equal(h.state.reinstalls, 1);

  const slept = harness();
  slept.state.connected = false;
  await slept.after(0);
  slept.state.now += 2 * MACHINE_RECOVERY_AFTER_MS;
  assert.ok(2 * MACHINE_RECOVERY_AFTER_MS > MACHINE_RECOVERY_WATCH_GAP_MS);
  await slept.service.check();
  assert.equal(slept.state.reinstalls, 0, "a check after a sleep starts a new watch rather than judging across it");
  for (let waited = 0; waited < MACHINE_RECOVERY_AFTER_MS; waited += 60_000) await slept.after(60_000);
  assert.equal(slept.state.reinstalls, 1);
});

import assert from "node:assert/strict";
import test from "node:test";
import { MachineIdleScheduler, type MachineIdleState } from "./machineIdle";
import { machinePowerPolicy } from "../../shared/machinePower";

function fixture() {
  let stored: MachineIdleState | undefined;
  const value = { now: 100, busy: false, ready: true, preparations: 0, stops: 0, writes: 0, failWrite: false };
  const state = { read: async () => stored && structuredClone(stored), write: async (next: MachineIdleState) => {
    if (value.failWrite) throw new Error("ENOSPC"); stored = structuredClone(next); value.writes++;
  } };
  const create = (bootId = "boot") => new MachineIdleScheduler({ state, bootId, uptimeMs: () => value.now,
    idleMs: 1000, isBusy: async () => value.busy, prepareStop: async () => {
      value.preparations++; return value.ready ? async () => { value.stops++; } : undefined;
    }, onError: () => undefined });
  return { value, state, create };
}

test("machine idle survives runtime restart, ignores wall clock and starts afresh on host boot", async () => {
  const f = fixture();
  const first = f.create(); await first.check(); first.close();
  f.value.now = 1099; const resumed = f.create(); await resumed.check(); assert.equal(f.value.stops, 0);
  f.value.now = 1100; await resumed.check(); assert.equal(f.value.stops, 1);
  await resumed.check(); assert.equal(f.value.stops, 1, "a prepared stop is never issued again"); resumed.close();
  f.value.now = 5000; const booted = f.create("new-boot"); await booted.check(); assert.equal(f.value.stops, 1);
  f.value.now = 6000; await booted.check(); assert.equal(f.value.stops, 2); booted.close();
});

test("a busy host prevents idle stop; a short completed turn between polls resets idle durably", async () => {
  const f = fixture(); const idle = f.create(); await idle.check();
  for (let i = 0; i < 4; i++) { f.value.now += 2000; f.value.busy = true; await idle.check(); assert.equal(f.value.stops, 0); }
  f.value.busy = false; await idle.check(); f.value.now += 999; await idle.check(); assert.equal(f.value.stops, 0);
  await idle.noteActivity(); idle.close();
  const restarted = f.create(); f.value.now += 100; await restarted.check(); assert.equal(f.value.stops, 0);
  f.value.now += 1000; await restarted.check(); assert.equal(f.value.stops, 1); restarted.close();
});

test("activity racing the final fence aborts preparation, and failed persistence cannot authorize stop", async () => {
  const f = fixture(); const idle = f.create(); await idle.check(); f.value.now = 1100;
  f.value.ready = false; await idle.check(); assert.equal(f.value.preparations, 1); assert.equal(f.value.stops, 0);
  f.value.failWrite = true; await assert.rejects(idle.noteActivity(), /ENOSPC/);
  await assert.rejects(idle.check(), /ENOSPC/); assert.equal(f.value.stops, 0, "a failed activity write stays busy even after its caller finishes");
  f.value.failWrite = false; await idle.noteActivity(); f.value.busy = false; f.value.ready = true;
  await idle.check(); assert.equal(f.value.stops, 0); f.value.now += 1000; await idle.check(); assert.equal(f.value.stops, 1);
  idle.close();
});

test("phone power policy grants only instance state and app-tagged start/stop", () => {
  const policy = machinePowerPolicy("us-east-1") as { Statement: Array<{ Action: string[]; Resource: string; Condition?: unknown }> };
  assert.deepEqual(policy.Statement[0], { Sid: "ReadInstanceState", Effect: "Allow", Action: ["ec2:DescribeInstances"], Resource: "*" });
  assert.deepEqual(policy.Statement[1].Action, ["ec2:StartInstances", "ec2:StopInstances"]);
  assert.deepEqual(policy.Statement[1].Condition, { StringEquals: { "aws:RequestedRegion": "us-east-1", "ec2:ResourceTag/accordagents-worker": "1" } });
  assert.throws(() => machinePowerPolicy("bad/region"));
});

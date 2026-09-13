import assert from "node:assert/strict";
import test from "node:test";
import { CloudRunSetupSession } from "./cloudRunSetupSession";
import type { CloudRunWorkerDoctorReport } from "../../shared/types";

test("reopening recovers only the live interaction; duplicate setup joins, another target cannot replace it", async () => {
  const session = new CloudRunSetupSession();
  let finish!: (report: CloudRunWorkerDoctorReport) => void;
  let calls = 0;
  const action = async (publish: (value: any) => void) => {
    calls++; publish({ stage: "claude-auth", message: "Sign in", authRequestId: "one", authProvider: "claude-code" });
    return new Promise<CloudRunWorkerDoctorReport>(resolve => { finish = resolve; });
  };
  const first = session.run(undefined, action, () => undefined);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(session.getProgress()?.authRequestId, "one");
  assert.equal(session.run(undefined, action, () => undefined), first);
  await assert.rejects(session.run({ host: "other" }, action, () => undefined), /Another worker setup/);
  finish({ ok: true, message: "Ready", checks: [] }); await first;
  assert.equal(calls, 1); assert.equal(session.getProgress(), null);
});

test("a failed setup clears the active challenge and may be retried; restart restores no stale auth", async () => {
  const session = new CloudRunSetupSession();
  const seen: string[] = [];
  await assert.rejects(session.run(undefined, async publish => {
    publish({ stage: "claude-auth", message: "Sign in", authRequestId: "one" }); throw new Error("Cancelled");
  }, value => seen.push(value.stage)), /Cancelled/);
  assert.equal(session.getProgress(), null); assert.equal(seen.at(-1), "error");
  assert.equal((await session.run(undefined, async () => ({ ok: true, message: "Ready", checks: [] }), () => undefined)).ok, true);
  assert.equal(new CloudRunSetupSession().getProgress(), null);
});

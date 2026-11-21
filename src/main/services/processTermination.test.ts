import { parseLinuxProcessStat } from "./processTermination";
import assert from "node:assert/strict";
import test from "node:test";
import {
  capturePosixDescendantsFromTable,
  hasLiveCapturedPosixProcesses,
  readProcessTableOutput,
  terminateCapturedPosixProcesses,
  terminateProcess,
  terminateProcessTreeIfRunning,
  type PosixProcessRow
} from "./processTermination";

for (const state of [
  { label: "exited", exitCode: 0, signalCode: null },
  { label: "signal-terminated", exitCode: null, signalCode: "SIGTERM" }
] as const) {
  test(`tracked process-tree termination refuses an already ${state.label} root PID`, () => {
    const childSignals: NodeJS.Signals[] = [];
    terminateProcessTreeIfRunning({
      pid: 42,
      exitCode: state.exitCode,
      signalCode: state.signalCode,
      killed: state.signalCode !== null,
      kill: (signal) => {
        childSignals.push(signal as NodeJS.Signals);
        return true;
      }
    }, "SIGKILL");
    assert.deepEqual(childSignals, []);
  });
}

test("tracked process-tree termination still escalates after an earlier signal was sent", (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX process-group signaling is unavailable on Windows");
    return;
  }
  const originalKill = process.kill;
  const processSignals: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
  process.kill = ((pid: number, signal: NodeJS.Signals | number) => {
    processSignals.push({ pid, signal });
    return true;
  }) as typeof process.kill;
  try {
    terminateProcessTreeIfRunning({
      pid: 42,
      exitCode: null,
      signalCode: null,
      killed: true,
      kill: () => true
    }, "SIGKILL");
  } finally {
    process.kill = originalKill;
  }
  assert.deepEqual(processSignals, [{ pid: -42, signal: "SIGKILL" }]);
});

test("retained process identities remain roots after their original provider is reparented", () => {
  const task = { pid: 100, startedAt: "Fri Sep  5 12:00:00 2026" };
  const helper = { pid: 200, startedAt: "Fri Sep  5 12:00:01 2026" };
  const rows = new Map<number, PosixProcessRow>([
    [task.pid, { ...task, ppid: 1, pgid: task.pid }],
    [helper.pid, { ...helper, ppid: task.pid, pgid: helper.pid }]
  ]);

  assert.deepEqual(
    capturePosixDescendantsFromTable(42, rows, [task]),
    [task, helper]
  );
  assert.deepEqual(
    capturePosixDescendantsFromTable(42, rows, [{ ...task, startedAt: "recycled" }]),
    []
  );
});

test("POSIX process-group termination falls back to the direct child", (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX process-group signaling is unavailable on Windows");
    return;
  }
  const originalKill = process.kill;
  const groupSignals: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
  const childSignals: NodeJS.Signals[] = [];
  process.kill = ((pid: number, signal: NodeJS.Signals | number) => {
    groupSignals.push({ pid, signal });
    throw new Error("process group is already gone");
  }) as typeof process.kill;
  try {
    terminateProcess({
      pid: 42,
      kill: (signal) => {
        childSignals.push(signal as NodeJS.Signals);
        return true;
      }
    }, "SIGTERM", true);
  } finally {
    process.kill = originalKill;
  }

  assert.deepEqual(groupSignals, [{ pid: -42, signal: "SIGTERM" }]);
  assert.deepEqual(childSignals, ["SIGTERM"]);
});

test("a captured zombie has finished execution even before its parent reaps it", () => {
  const identity = { pid: 42, startedAt: "Fri Sep  5 12:00:00 2026" };
  const rows = new Map<number, PosixProcessRow>([[42, { ...identity, ppid: 1, pgid: 42, state: "Z" }]]);
  assert.equal(hasLiveCapturedPosixProcesses([identity], () => rows), false);
  rows.set(42, { ...rows.get(42)!, state: "S" });
  assert.equal(hasLiveCapturedPosixProcesses([identity], () => rows), true);
});

test("captured POSIX identity checks refuse a recycled PID and signal a matching group", (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX process identity checks are unavailable on Windows");
    return;
  }
  const captured = [{ pid: 42, startedAt: "Fri Sep  5 12:00:00 2026" }];
  const recycled = new Map<number, PosixProcessRow>([[42, {
    pid: 42,
    ppid: 1,
    pgid: 42,
    startedAt: "Fri Sep  5 12:01:00 2026"
  }]]);
  const matching = new Map<number, PosixProcessRow>([[42, {
    pid: 42,
    ppid: 1,
    pgid: 42,
    startedAt: captured[0].startedAt
  }]]);
  const originalKill = process.kill;
  const signals: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
  process.kill = ((pid: number, signal: NodeJS.Signals | number) => {
    signals.push({ pid, signal });
    return true;
  }) as typeof process.kill;
  try {
    assert.equal(hasLiveCapturedPosixProcesses(captured, () => recycled), false);
    terminateCapturedPosixProcesses(captured, "SIGKILL", () => recycled);
    assert.deepEqual(signals, []);

    assert.equal(hasLiveCapturedPosixProcesses(captured, () => undefined), true);
    terminateCapturedPosixProcesses(captured, "SIGKILL", () => undefined);
    assert.deepEqual(signals, []);

    assert.equal(hasLiveCapturedPosixProcesses(captured, () => matching), true);
    terminateCapturedPosixProcesses(captured, "SIGKILL", () => matching);
    assert.deepEqual(signals, [{ pid: -42, signal: "SIGKILL" }]);
  } finally {
    process.kill = originalKill;
  }
});


test("Linux process identities use kernel start ticks and boot identity, never wall time or the command name", () => {
  const fields = ["S", "12", "34", ...Array(16).fill("0"), "123456789", "999"];
  const boot = "11111111-1111-1111-1111-111111111111";
  const row = parseLinuxProcessStat(`45 (name with ) and spaces) ${fields.join(" ")}`, boot);
  assert.equal(row.pid, 45);
  assert.equal(row.ppid, 12);
  assert.equal(row.pgid, 34);
  assert.equal(row.startedAt, `linux:${boot}:123456789`);
  assert.notEqual(parseLinuxProcessStat(`45 (name) ${fields.join(" ")}`, "22222222-2222-2222-2222-222222222222").startedAt, row.startedAt);
  assert.throws(() => parseLinuxProcessStat("45 broken", boot));
});

const PS_ROW = "printf '   42     1    42 Ss   Sat Nov 21 13:08:51 2026    \\n'";
function blockEventLoop(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

test("a process table read survives an event-loop stall longer than its deadline", { skip: process.platform === "win32" }, async () => {
  // Electron's main thread can hold the loop past the deadline while the
  // packaged native supervisor starts; the finished output must still count.
  const reading = readProcessTableOutput("/bin/sh", ["-c", PS_ROW], 100);
  blockEventLoop(600);
  const rows = await reading;
  assert.deepEqual(rows?.get(42), { pid: 42, ppid: 1, pgid: 42, state: "Ss", startedAt: "Sat Nov 21 13:08:51 2026" });
});

test("a table command still running at its deadline yields no table, never the part it printed", { skip: process.platform === "win32" }, async () => {
  const startedAt = Date.now();
  const rows = await readProcessTableOutput("/bin/sh", ["-c", `${PS_ROW}; exec sleep 5`], 200);
  assert.equal(rows, undefined);
  assert.ok(Date.now() - startedAt < 3_000, "the hung command was abandoned at its deadline");
});

test("a table command that fails yields no table, even with rows on stdout", { skip: process.platform === "win32" }, async () => {
  assert.equal(await readProcessTableOutput("/bin/sh", ["-c", `${PS_ROW}; exit 1`], 1_000), undefined);
  assert.equal(await readProcessTableOutput("/nonexistent/accord-ps", [], 1_000), undefined);
});

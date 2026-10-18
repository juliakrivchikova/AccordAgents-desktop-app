import assert from "node:assert/strict";
import test from "node:test";
import {
  describeScriptSchedule,
  nextCronRun,
  nextScriptDueAt,
  parseCron,
  scriptLateGraceMs,
  validateScriptSchedule
} from "./scriptSchedule";

const iso = (ms: number) => new Date(ms).toISOString();

test("weekdays at 17:00 fire at the User's 17:00, not the host's", () => {
  // Friday 2026-10-16 18:00 in Berlin (CEST, UTC+2) is 16:00Z.
  const friday = Date.parse("2026-10-16T16:00:00Z");
  // The next weekday 17:00 Berlin is Monday 2026-10-19 15:00Z.
  assert.equal(iso(nextCronRun("0 17 * * 1-5", "Europe/Berlin", friday)), "2026-10-19T15:00:00.000Z");
  // Before 17:00 on a weekday it is the same day.
  const thursdayNoon = Date.parse("2026-10-15T10:00:00Z");
  assert.equal(iso(nextCronRun("0 17 * * 1-5", "Europe/Berlin", thursdayNoon)), "2026-10-15T15:00:00.000Z");
});

test("a run exactly at the due minute is not repeated", () => {
  const due = Date.parse("2026-10-15T15:00:00Z");
  assert.equal(iso(nextCronRun("0 17 * * 1-5", "Europe/Berlin", due)), "2026-10-16T15:00:00.000Z");
});

test("a wall-clock time skipped by spring forward fires at the first minute after the gap", () => {
  // Europe/Berlin jumps 02:00 -> 03:00 on 2026-03-29 (01:00Z).
  const before = Date.parse("2026-03-28T12:00:00Z");
  assert.equal(iso(nextCronRun("30 2 * * *", "Europe/Berlin", before)), "2026-03-29T01:00:00.000Z");
});

test("a wall-clock time repeated by fall back fires once, at its first occurrence", () => {
  // Europe/Berlin goes 03:00 -> 02:00 on 2026-10-25 (01:00Z); 02:30 happens twice.
  const before = Date.parse("2026-10-24T12:00:00Z");
  const first = nextCronRun("30 2 * * *", "Europe/Berlin", before);
  assert.equal(iso(first), "2026-10-25T00:30:00.000Z");
  assert.equal(iso(nextCronRun("30 2 * * *", "Europe/Berlin", first)), "2026-10-26T01:30:00.000Z");
});

test("an every-15-minutes cron keeps running through the repeated hour when DST ends", () => {
  // Europe/Berlin goes 03:00 -> 02:00 on 2026-10-25 (01:00Z).
  let at = Date.parse("2026-10-25T00:30:00Z");
  const fired: string[] = [];
  for (let index = 0; index < 6; index += 1) {
    at = nextCronRun("*/15 * * * *", "Europe/Berlin", at);
    fired.push(iso(at));
  }
  assert.deepEqual(fired, [
    "2026-10-25T00:45:00.000Z",
    "2026-10-25T01:00:00.000Z",
    "2026-10-25T01:15:00.000Z",
    "2026-10-25T01:30:00.000Z",
    "2026-10-25T01:45:00.000Z",
    "2026-10-25T02:00:00.000Z"
  ]);
});

test("a midnight-hour cron is not delayed by a DST change later that day", () => {
  // Europe/Berlin springs forward on Sunday 2027-03-28; Monday 00:30 is 2027-03-28T22:30Z.
  const saturday = Date.parse("2027-03-27T12:00:00Z");
  assert.equal(iso(nextCronRun("30 0 * * 1", "Europe/Berlin", saturday)), "2027-03-28T22:30:00.000Z");
  // America/New_York springs forward on Sunday 2027-03-14; Monday 00:30 EDT is 04:30Z.
  assert.equal(iso(nextCronRun("30 0 * * 1", "America/New_York", Date.parse("2027-03-13T17:00:00Z"))), "2027-03-15T04:30:00.000Z");
});

test("a cron expression that can never fire is refused", () => {
  assert.throws(() => validateScriptSchedule({ kind: "cron", expression: "0 9 30 2 *", timeZone: "UTC" }), /never fires/);
});

test("cron lists, ranges and steps", () => {
  const spec = parseCron("*/15 9-17 * * 1,3,5");
  assert.deepEqual([...spec.minutes], [0, 15, 30, 45]);
  assert.equal(spec.hours.size, 9);
  assert.deepEqual([...spec.daysOfWeek].sort(), [1, 3, 5]);
  assert.throws(() => parseCron("* * *"), /five fields/);
  assert.throws(() => parseCron("61 * * * *"), /0-59/);
  assert.throws(() => parseCron("L * * * *"), /not supported/);
});

test("intervals stay anchored to the first run across a missed stretch", () => {
  const anchor = Date.parse("2026-10-17T10:00:00Z");
  const schedule = { kind: "interval" as const, everySeconds: 60 };
  assert.equal(nextScriptDueAt(schedule, anchor, anchor), anchor + 60_000);
  // After the laptop slept for 3h 30s, the next due time is on the minute grid.
  assert.equal(iso(nextScriptDueAt(schedule, anchor, anchor + 3 * 3600_000 + 30_000)), "2026-10-17T13:01:00.000Z");
  // A due time still in the future stays as it is.
  assert.equal(nextScriptDueAt(schedule, anchor + 120_000, anchor), anchor + 120_000);
});

test("late grace is the interval, capped at ten minutes", () => {
  assert.equal(scriptLateGraceMs({ kind: "interval", everySeconds: 60 }), 60_000);
  assert.equal(scriptLateGraceMs({ kind: "interval", everySeconds: 3600 }), 600_000);
  assert.equal(scriptLateGraceMs({ kind: "cron", expression: "0 17 * * 1-5", timeZone: "Europe/Berlin" }), 600_000);
});

test("schedules are described in words", () => {
  assert.equal(describeScriptSchedule({ kind: "interval", everySeconds: 60 }), "Every minute");
  assert.equal(describeScriptSchedule({ kind: "interval", everySeconds: 900 }), "Every 15 minutes");
  assert.equal(describeScriptSchedule({ kind: "cron", expression: "0 17 * * 1-5", timeZone: "Europe/Berlin" }), "Weekdays at 17:00 (Europe/Berlin)");
  assert.equal(describeScriptSchedule({ kind: "cron", expression: "*/5 * * * *", timeZone: "UTC" }), "Cron \"*/5 * * * *\" (UTC)");
});

test("invalid schedules are refused with a reason", () => {
  assert.throws(() => validateScriptSchedule({ kind: "interval", everySeconds: 30 }), /60/);
  assert.throws(() => validateScriptSchedule({ kind: "cron", expression: "0 17 * * 1-5", timeZone: "Mars/Olympus" }), /time zone/);
  validateScriptSchedule({ kind: "cron", expression: "0 17 * * 1-5", timeZone: "Europe/Berlin" });
});

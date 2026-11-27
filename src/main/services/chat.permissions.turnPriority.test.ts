import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { TurnQueue } from "./chat/turns/turnQueue";
import type { ParticipantTurnReservation } from "./chat/types";

/** One member's turns as the chat queues them: each label is written when its
 *  turn starts, and the turn runs until the test releases it. */
function queueOf(): { queue: TurnQueue; started: string[]; run: (label: string, reservation: ParticipantTurnReservation) => { release: () => void; started: Promise<void> } } {
  const queue = new TurnQueue({ host: { runsHere: () => true } } as never);
  const started: string[] = [];
  const run = (label: string, reservation: ParticipantTurnReservation) => {
    const begun = reservation.wait().then(() => { started.push(label); });
    return { release: () => reservation.release(), started: begun };
  };
  return { queue, started, run };
}

const reserve = (queue: TurnQueue, mode: "exclusive" | "shared" | "following" = "exclusive", options: Parameters<TurnQueue["reserveParticipantTurn"]>[3] = {}) =>
  queue.reserveParticipantTurn("chat", "member", mode, options);

test("a turn put next runs right after the running turn, before the turns that waited", async () => {
  const { queue, started, run } = queueOf();
  const running = run("running", reserve(queue));
  await running.started;
  const waiting = run("waiting", reserve(queue));
  const next = run("next", reserve(queue, "exclusive", { priority: "next" }));
  await delay(10);
  assert.deepEqual(started, ["running"]);
  running.release();
  await next.started;
  await delay(10);
  assert.deepEqual(started, ["running", "next"], "the turn that waited still waits");
  next.release();
  await waiting.started;
  assert.deepEqual(started, ["running", "next", "waiting"]);
  waiting.release();
});

test("a message delivered into a live CLI runs with the running turn, waits for an operation, and goes before the turns that waited", async () => {
  const { queue, started, run } = queueOf();
  const running = run("running", reserve(queue));
  await running.started;
  const waiting = run("waiting", reserve(queue));
  const live = run("live", reserve(queue, "shared", { priority: "live" }));
  await live.started;
  assert.deepEqual(started, ["running", "live"]);
  running.release();
  await delay(10);
  assert.deepEqual(started, ["running", "live"], "the turn that waited waits for the delivered one");
  live.release();
  await waiting.started;
  waiting.release();

  const operation = run("operation", reserve(queue, "exclusive", { operation: true }));
  await operation.started;
  const afterOperation = run("live after operation", reserve(queue, "shared", { priority: "live" }));
  await delay(10);
  assert.equal(started.includes("live after operation"), false, "a compaction, restart or move runs first");
  operation.release();
  await afterOperation.started;
  afterOperation.release();
});

test("a compaction and the turn that goes on after it run before a request that waited; the User's message keeps its place behind that request", async () => {
  const { queue, started, run } = queueOf();
  const asking = run("asking", reserve(queue));
  await asking.started;
  const request = run("request", reserve(queue));
  const compaction = run("compaction", reserve(queue, "exclusive", { operation: true, priority: "next" }));
  const goOn = run("go on", reserve(queue, "following", { priority: "next", userFirst: true }));
  asking.release();
  await compaction.started;
  const user = run("user", reserve(queue, "exclusive", { byUser: true }));
  compaction.release();
  await goOn.started;
  goOn.release();
  await request.started;
  request.release();
  await user.started;
  user.release();
  assert.deepEqual(started, ["asking", "compaction", "go on", "request", "user"]);
});

test("the User's message sent while a member compacts goes before the turn it goes on in, as her words come first", async () => {
  const { queue, started, run } = queueOf();
  const asking = run("asking", reserve(queue));
  await asking.started;
  const compaction = run("compaction", reserve(queue, "exclusive", { operation: true, priority: "next" }));
  const goOn = run("go on", reserve(queue, "following", { priority: "next", userFirst: true }));
  asking.release();
  await compaction.started;
  const user = run("user", reserve(queue, "exclusive", { byUser: true }));
  // Released at once: her message counts as ready though its wait has not run.
  compaction.release();
  await user.started;
  await delay(10);
  assert.deepEqual(started, ["asking", "compaction", "user"]);
  user.release();
  await goOn.started;
  goOn.release();
  assert.deepEqual(started, ["asking", "compaction", "user", "go on"]);
});

test("the User's message ready before a go-on turn is not held by a request delivered now behind it (no deadlock)", async () => {
  const { queue, started, run } = queueOf();
  const compaction = run("compaction", reserve(queue, "exclusive", { operation: true, priority: "next" }));
  await compaction.started;
  const goOn = run("go on", reserve(queue, "following", { priority: "next", userFirst: true }));
  const user = run("user", reserve(queue, "exclusive", { byUser: true }));
  const forced = run("forced", reserve(queue, "exclusive", { priority: "next" }));
  compaction.release();
  await user.started;
  user.release();
  await goOn.started;
  goOn.release();
  await forced.started;
  forced.release();
  assert.deepEqual(started, ["compaction", "user", "go on", "forced"]);
});

test("a reply the member's CLI began on its own counts as running: a compaction waits for it", async () => {
  const { queue, started, run } = queueOf();
  const own = reserve(queue, "shared", { startsNow: true });
  const compaction = run("compaction", reserve(queue, "exclusive", { operation: true, priority: "next" }));
  await delay(10);
  assert.deepEqual(started, []);
  assert.deepEqual(queue.memberActivity("chat", "member"), { running: "turn", waiting: 1, compacting: true, goingOn: false });
  own.release();
  await compaction.started;
  assert.deepEqual(queue.memberActivity("chat", "member"), { running: "operation", waiting: 0, compacting: true, goingOn: false });
  compaction.release();
  assert.deepEqual(queue.memberActivity("chat", "member"), { running: "none", waiting: 0, compacting: false, goingOn: false });
});

test("a turn stopped while it waits behind a turn put next gives up its place", async () => {
  const { queue, started, run } = queueOf();
  const running = run("running", reserve(queue));
  await running.started;
  const next = reserve(queue, "exclusive", { priority: "next" });
  const waiting = run("waiting", reserve(queue));
  assert.equal(queue.hasWaitingTurns("chat", "member", next), true);
  next.release();
  running.release();
  await waiting.started;
  assert.deepEqual(started, ["running", "waiting"]);
  waiting.release();
  assert.equal(queue.hasWaitingTurns("chat", "member"), false);
});

test("a turn put first that is waited for again by whoever it was handed to does not wait for the User's message that waits for it", async () => {
  const { queue, started, run } = queueOf();
  const goOn = reserve(queue, "exclusive", { priority: "next", userFirst: true });
  await goOn.wait();
  // Her message, sent while the go-on turn runs, waits for it.
  const user = run("user", reserve(queue, "exclusive", { byUser: true }));
  await delay(10);
  const again = await Promise.race([goOn.wait().then(() => "resolved"), delay(200).then(() => "stuck")]);
  assert.equal(again, "resolved");
  assert.deepEqual(started, []);
  goOn.release();
  await user.started;
  assert.deepEqual(started, ["user"]);
});

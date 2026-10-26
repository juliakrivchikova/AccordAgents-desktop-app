import assert from "node:assert/strict";
import test from "node:test";
import { MachineInactivityQuestions } from "./machineInactivityQuestions";

test("a question about an unused machine is settled once: by her answer, by the machine coming back, or by its removal elsewhere", async () => {
  const shown: string[][] = [];
  const questions = new MachineInactivityQuestions((list) => shown.push(list.map((item) => item.machineId)));
  const a = questions.ask({ machineId: "a", name: "A", inactiveDays: 12 });
  const b = questions.ask({ machineId: "b", name: "B", inactiveDays: 30 });
  const c = questions.ask({ machineId: "c", name: "C", inactiveDays: 11 });
  assert.deepEqual(questions.list().map((item) => item.machineId), ["a", "b", "c"]);
  // Removed some other way (AWS, the relay's cleanup, Settings): gone from the window.
  questions.settle("b", "remove");
  assert.equal(await b, "remove");
  assert.deepEqual(shown[shown.length - 1], ["a", "c"]);
  // Connected again.
  questions.settle("a", "active");
  assert.equal(await a, "active");
  // Her answer to remove: the removal settles it only once, through her answer.
  const removed: string[] = [];
  await questions.answer("c", "remove", async (machineId) => { removed.push(machineId); questions.settle(machineId, "remove"); });
  assert.equal(await c, "remove");
  assert.deepEqual(removed, ["c"]);
  assert.deepEqual(questions.list(), []);
});

test("a removal that fails keeps the question for her to answer again", async () => {
  const questions = new MachineInactivityQuestions(() => undefined);
  const pending = questions.ask({ machineId: "a", name: "A", inactiveDays: 12 });
  await assert.rejects(questions.answer("a", "remove", async () => { throw new Error("AWS said no"); }), /AWS said no/);
  assert.equal(questions.list().length, 1);
  await questions.answer("a", "keep", async () => undefined);
  assert.equal(await pending, "keep");
});

test("a removal that fails after the machine was already taken off still settles the question", async () => {
  const questions = new MachineInactivityQuestions(() => undefined);
  const pending = questions.ask({ machineId: "a", name: "A", inactiveDays: 12 });
  await assert.rejects(questions.answer("a", "remove", async (machineId) => {
    questions.settle(machineId, "remove"); // settings removed it
    throw new Error("the link could not forget it");
  }), /could not forget/);
  assert.equal(await pending, "remove");
  assert.deepEqual(questions.list(), []);
});

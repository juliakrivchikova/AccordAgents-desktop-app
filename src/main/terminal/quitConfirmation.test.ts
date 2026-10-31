import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createQuitConfirmation, createQuitQuestion, installQuitConfirmation, quitConfirmationDetail, quitStep } from "./quitConfirmation";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await wait(2);
  }
}

type Commands = Array<string | null> | undefined;

function harness(options: { terminals?: boolean; commands?: Commands | Error; answer?: boolean | Error; confirmedForMs?: number } = {}) {
  const asked: Commands[] = [];
  const events: string[] = [];
  let quits = 0;
  let checks = 0;
  const confirmation = createQuitConfirmation({
    hasTerminals: () => options.terminals ?? true,
    runningCommands: async () => {
      checks += 1;
      if (options.commands instanceof Error) throw options.commands;
      return "commands" in options ? options.commands as Commands : ["npm"];
    },
    ask: async (commands) => {
      asked.push(commands);
      if (options.answer instanceof Error) throw options.answer;
      return options.answer ?? true;
    },
    quit: () => { quits += 1; },
    log: (event) => events.push(event),
    confirmedForMs: options.confirmedForMs
  });
  return { confirmation, asked, events, quits: () => quits, checks: () => checks };
}

test("without terminals a quit goes straight on", () => {
  const h = harness({ terminals: false });
  assert.equal(h.confirmation.hold(), false);
  assert.equal(h.checks(), 0);
});

test("shells at their prompts: held only for the check, then quit without asking", async () => {
  const h = harness({ commands: [] });
  assert.equal(h.confirmation.hold(), true);
  assert.equal(h.confirmation.holding(), true);
  await waitFor(() => h.quits() === 1, "quit");
  assert.deepEqual(h.asked, []);
  assert.equal(h.confirmation.hold(), false, "the second quit passes");
  assert.equal(h.confirmation.holding(), false);
});

test("a running command asks; Quit quits once, however many times quit was pressed meanwhile", async () => {
  const h = harness({ commands: ["npm", "vim"], answer: true });
  assert.equal(h.confirmation.hold(), true);
  assert.equal(h.confirmation.hold(), true, "a second Cmd+Q while asking is held, not asked again");
  await waitFor(() => h.quits() === 1, "quit");
  assert.deepEqual(h.asked, [["npm", "vim"]]);
  assert.equal(h.checks(), 1);
  assert.deepEqual(h.events, ["app-quit.confirm-asked", "app-quit.confirm-answered"]);
});

test("the quit again comes after the current turn, never inside it", async () => {
  let answer!: (quit: boolean) => void;
  let quits = 0;
  const confirmation = createQuitConfirmation({
    hasTerminals: () => true,
    runningCommands: async () => ["npm"],
    ask: () => new Promise<boolean>((resolve) => { answer = resolve; }),
    quit: () => { quits += 1; }
  });
  confirmation.hold();
  await waitFor(() => typeof answer === "function", "question");
  answer(true);
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  assert.equal(quits, 0, "not from a microtask of the quit that asked");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(quits, 1);
});

test("Cancel keeps the app running, and the next quit asks again", async () => {
  const h = harness({ answer: false });
  assert.equal(h.confirmation.hold(), true);
  await waitFor(() => !h.confirmation.holding(), "answer");
  assert.equal(h.quits(), 0);
  assert.equal(h.confirmation.hold(), true);
  await waitFor(() => h.asked.length === 2, "second question");
});

test("a Quit answer stands only for a while: a quit stopped by something else asks again later", async () => {
  const h = harness({ answer: true, confirmedForMs: 30 });
  h.confirmation.hold();
  await waitFor(() => h.quits() === 1, "quit");
  assert.equal(h.confirmation.hold(), false);
  await wait(60);
  assert.equal(h.confirmation.hold(), true);
  await waitFor(() => h.asked.length === 2, "asked again");
});

test("a quit let through that did not happen is taken back: the next quit asks again", async () => {
  const h = harness({ answer: false });
  h.confirmation.allow();
  assert.equal(h.confirmation.hold(), false);
  h.confirmation.revoke();
  assert.equal(h.confirmation.hold(), true);
  await waitFor(() => h.asked.length === 1, "asked");
});

test("the question is shown once for whoever asks while it is open, and marks a quit among them", async () => {
  const answers: Array<(answer: boolean | undefined) => void> = [];
  const ask = createQuitQuestion(() => new Promise((resolve) => { answers.push(resolve); }));
  const restart = ask(["sleep"], "restart");
  assert.equal(restart.quitAsked, false);
  const quit = ask(["sleep"], "quit");
  assert.equal(quit, restart, "the quit waits for the same answer");
  assert.equal(answers.length, 1, "one sheet, not two");
  assert.equal(restart.quitAsked, true);
  answers[0](true);
  assert.equal(await restart.answer, true);
  assert.equal(await quit.answer, true);
  const next = ask(["sleep"], "restart");
  assert.notEqual(next, restart, "answered: the next ask is a new question");
  assert.equal(next.quitAsked, false);
  assert.equal(answers.length, 2);
  answers[1](undefined);
  assert.equal(await next.answer, undefined);
});

test("when the host cannot say, it asks; when checking or asking fails, the quit is not trapped", async () => {
  const unknown = harness({ commands: undefined, answer: false });
  unknown.confirmation.hold();
  await waitFor(() => unknown.asked.length === 1, "question");
  assert.deepEqual(unknown.asked, [undefined]);
  const brokenAsk = harness({ answer: new Error("no window") });
  brokenAsk.confirmation.hold();
  await waitFor(() => brokenAsk.quits() === 1, "quit after a failed question");
  assert.ok(brokenAsk.events.includes("app-quit.confirm-failed"));
  const brokenCheck = harness({ commands: new Error("host gone") });
  brokenCheck.confirmation.hold();
  await waitFor(() => brokenCheck.quits() === 1, "quit after a failed check");
  assert.deepEqual(brokenCheck.asked, []);
  assert.ok(brokenCheck.events.includes("app-quit.confirm-failed"));
});

test("the check runs before every other quit step, which stay out while the User is asked", async () => {
  let answer!: (quit: boolean) => void;
  const confirmation = createQuitConfirmation({
    hasTerminals: () => true,
    runningCommands: async () => ["npm"],
    ask: () => new Promise<boolean>((resolve) => { answer = resolve; }),
    quit: () => app.emit("before-quit", event())
  });
  const app = new EventEmitter();
  const steps: string[] = [];
  let prevented = 0;
  const event = () => ({ preventDefault: () => { prevented += 1; } });
  app.on("before-quit", quitStep(confirmation, () => steps.push("cleanup")));
  installQuitConfirmation(app as unknown as Parameters<typeof installQuitConfirmation>[0], confirmation);
  app.emit("before-quit", event());
  assert.deepEqual(steps, [], "held: no quit step runs");
  assert.equal(prevented, 1);
  await waitFor(() => typeof answer === "function", "question");
  answer(true);
  await waitFor(() => steps.length === 1, "the quit going on");
  assert.equal(prevented, 1, "the confirmed quit is not held again");
});

test("a quit a program asks for with a signal goes through unasked, also while the User is being asked", async () => {
  const idle = harness({ commands: ["npm"] });
  idle.confirmation.allow();
  assert.equal(idle.confirmation.hold(), false);
  assert.equal(idle.checks(), 0);

  let answer!: (quit: boolean) => void;
  const asking = createQuitConfirmation({
    hasTerminals: () => true,
    runningCommands: async () => ["npm"],
    ask: () => new Promise<boolean>((resolve) => { answer = resolve; }),
    quit: () => undefined
  });
  assert.equal(asking.hold(), true);
  await waitFor(() => typeof answer === "function", "question");
  asking.allow();
  assert.equal(asking.holding(), false, "the quit steps no longer wait");
  assert.equal(asking.hold(), false, "the signalled quit passes");
  answer(false);
});

test("the question names what stops", () => {
  const generic = "A command is still running in the terminal. Quitting stops it.";
  assert.equal(quitConfirmationDetail(undefined), generic);
  assert.equal(quitConfirmationDetail([null]), generic);
  assert.equal(quitConfirmationDetail(["npm"]), "npm is still running in the terminal. Quitting stops it.");
  assert.equal(quitConfirmationDetail(["", null, "npm"]), "npm is still running in the terminal. Quitting stops it.");
  assert.equal(quitConfirmationDetail(["npm", "vim", "npm"]), "npm, vim are still running in the terminal. Quitting stops them.");
  assert.equal(quitConfirmationDetail(["a", "b", "c"]), "a, b, c are still running in the terminal. Quitting stops them.");
  assert.equal(quitConfirmationDetail(["a", "b", "c", "d"]), "a, b, c and 1 more are still running in the terminal. Quitting stops them.");
});

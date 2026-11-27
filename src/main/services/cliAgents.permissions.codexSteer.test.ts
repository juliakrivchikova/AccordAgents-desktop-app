import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CliAgentRunner } from "./cliAgents";
import { cliParts } from "./cliAgents/test/cliParts";
import type { ParticipantRunResult } from "./providers";
import { writeCodexAppServerFixture } from "./cliAgents/test/runnerFixtures";

process.env.CLAUDE_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), "aa-claude-config-"));

/** A Codex app-server whose first turn runs until it is steered (or, when
 *  steering is refused, until the steer was asked), then answers. */
function fakeCodex(refuseSteer: boolean): string {
  return `#!/usr/bin/env node
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
let turns = 0;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex", platformFamily: "unix", platformOsName: "macos", platformArch: "arm64" } });
    return;
  }
  if (message.method === "thread/start" || message.method === "thread/resume") {
    send({ id: message.id, result: { thread: { id: "thread-steer" }, model: "gpt-5" } });
    return;
  }
  if (message.method === "turn/start") {
    turns += 1;
    const turn = "turn-" + turns;
    send({ id: message.id, result: { turn: { id: turn } } });
    send({ method: "turn/started", params: { threadId: "thread-steer", turn: { id: turn } } });
    if (turns === 1) {
      send({ method: "item/completed", params: { threadId: "thread-steer", turnId: turn, item: { id: "a1", type: "agentMessage", text: "Building the old variant." } } });
      return;
    }
    send({ method: "item/completed", params: { threadId: "thread-steer", turnId: turn, item: { id: "b2", type: "agentMessage", text: "Ran the correction as its own turn." } } });
    send({ method: "turn/completed", params: { threadId: "thread-steer", turn: { id: turn, status: "completed" } } });
    return;
  }
  if (message.method === "turn/steer") {
    if (${refuseSteer ? "true" : "false"}) {
      send({ id: message.id, error: { code: -32600, message: "no active turn to steer" } });
      send({ method: "item/completed", params: { threadId: "thread-steer", turnId: "turn-1", item: { id: "a2", type: "agentMessage", text: "Old variant done." } } });
      send({ method: "turn/completed", params: { threadId: "thread-steer", turn: { id: "turn-1", status: "completed" } } });
      return;
    }
    if (message.params.expectedTurnId !== "turn-1" || message.params.threadId !== "thread-steer") process.exit(31);
    send({ id: message.id, result: { turnId: "turn-1" } });
    send({ method: "item/completed", params: { threadId: "thread-steer", turnId: "turn-1", item: { id: "s1", type: "agentMessage", text: "Took the correction." } } });
    send({ method: "turn/completed", params: { threadId: "thread-steer", turn: { id: "turn-1", status: "completed" } } });
  }
});
`;
}

async function runSteer(refuseSteer: boolean): Promise<{ first: ParticipantRunResult; second: ParticipantRunResult; outcomes: string[] }> {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-codex-steer-"));
  const codexPath = await writeCodexAppServerFixture(fixtureDir, fakeCodex(refuseSteer));
  const runner = new CliAgentRunner(undefined, undefined, codexPath) as any;
  const participant = { id: "codex-member", kind: "codex-cli", label: "Codex" };
  const warm = { conversationId: "chat-steer", participantId: "codex-member", contextKey: "context-steer", idleTimeoutMs: 60_000 };
  const run = (prompt: string, extra: Record<string, unknown> = {}): Promise<ParticipantRunResult> =>
    cliParts(runner).codexRuns.runCodexAppServerWarmOrOneShot(participant, prompt, fixtureDir, undefined, "chat", undefined, { agentMode: "auto", warm, ...extra });
  try {
    // The first turn runs in Codex (its text has streamed) when the request comes.
    let streamed!: () => void;
    const running = new Promise<void>((resolve) => { streamed = resolve; });
    const first = run("Build the old variant.", { onOutput: () => streamed() });
    await running;
    const outcomes: string[] = [];
    const second = run("Correction: build the new one.", { steerIntoRunningTurn: (outcome: string) => outcomes.push(outcome) });
    return { first: await first, second: await second, outcomes };
  } finally {
    await runner.shutdownWarmAgents();
    await rm(fixtureDir, { recursive: true, force: true });
  }
}

test("a request delivered now steers a busy Codex member's running turn: the reply so far goes on in the request's reply", async () => {
  const { first, second, outcomes } = await runSteer(false);
  assert.deepEqual(outcomes, ["steered"]);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.turnContinues, true);
  assert.equal(first.content, "Building the old variant.");
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.content, "Took the correction.");
  assert.equal(second.turnContinues, undefined);
});

test("when Codex does not take the steer, the request runs as a turn of its own once the running turn ends", async () => {
  const { first, second, outcomes } = await runSteer(true);
  assert.deepEqual(outcomes, ["not-steered"]);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.turnContinues, undefined);
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.content, "Ran the correction as its own turn.");
});

/** A Codex app-server for the harder cases: `turn/start` answered late, the
 *  steer answered late, two steers, and every `turn/interrupt` recorded. */
function slowCodex(options: { startDelayMs?: number; steerDelayMs?: number; twoSteers?: boolean }): string {
  return `#!/usr/bin/env node
const readline = require("node:readline");
const fs = require("node:fs");
const path = require("node:path");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const log = (line) => fs.appendFileSync(path.join(__dirname, "calls.log"), line + "\\n");
let steers = 0;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method) log(message.method);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex", platformFamily: "unix", platformOsName: "macos", platformArch: "arm64" } });
    return;
  }
  if (message.method === "thread/start" || message.method === "thread/resume") {
    send({ id: message.id, result: { thread: { id: "thread-slow" }, model: "gpt-5" } });
    return;
  }
  if (message.method === "turn/start") {
    setTimeout(() => {
      send({ id: message.id, result: { turn: { id: "turn-1" } } });
      send({ method: "turn/started", params: { threadId: "thread-slow", turn: { id: "turn-1" } } });
      send({ method: "item/completed", params: { threadId: "thread-slow", turnId: "turn-1", item: { id: "a1", type: "agentMessage", text: "Working." } } });
    }, ${options.startDelayMs ?? 0});
    return;
  }
  if (message.method === "turn/steer") {
    steers += 1;
    const n = steers;
    setTimeout(() => {
      send({ id: message.id, result: { turnId: "turn-1" } });
      send({ method: "item/completed", params: { threadId: "thread-slow", turnId: "turn-1", item: { id: "s" + n, type: "agentMessage", text: "Steer " + n + " taken." } } });
      const last = ${options.twoSteers ? "n === 2" : "true"};
      if (last) send({ method: "turn/completed", params: { threadId: "thread-slow", turn: { id: "turn-1", status: "completed" } } });
    }, ${options.steerDelayMs ?? 0} * steers);
    return;
  }
  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    send({ method: "turn/completed", params: { threadId: "thread-slow", turn: { id: "turn-1", status: "interrupted" } } });
  }
});
`;
}

async function withSlowCodex<T>(fake: string, body: (run: (prompt: string, extra?: Record<string, unknown>, signal?: AbortSignal) => Promise<ParticipantRunResult>, calls: () => Promise<string[]>) => Promise<T>): Promise<T> {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-codex-steer-slow-"));
  const codexPath = await writeCodexAppServerFixture(fixtureDir, fake);
  const runner = new CliAgentRunner(undefined, undefined, codexPath) as any;
  const participant = { id: "codex-member", kind: "codex-cli", label: "Codex" };
  const warm = { conversationId: "chat-steer", participantId: "codex-member", contextKey: "context-steer", idleTimeoutMs: 60_000 };
  const run = (prompt: string, extra: Record<string, unknown> = {}, signal?: AbortSignal): Promise<ParticipantRunResult> =>
    cliParts(runner).codexRuns.runCodexAppServerWarmOrOneShot(participant, prompt, fixtureDir, undefined, "chat", signal, { agentMode: "auto", warm, ...extra });
  const calls = async (): Promise<string[]> => (await readFile(path.join(fixtureDir, "calls.log"), "utf8").catch(() => "")).split("\n").filter(Boolean);
  try {
    return await body(run, calls);
  } finally {
    await runner.shutdownWarmAgents();
    await rm(fixtureDir, { recursive: true, force: true });
  }
}

test("a request delivered while Codex still starts its turn is steered once the turn has its id, never cut", async () => {
  await withSlowCodex(slowCodex({ startDelayMs: 800 }), async (run, calls) => {
    const first = run("Build the old variant.");
    // Its turn/start is sent, not answered yet.
    for (let tries = 0; tries < 100 && !(await calls()).includes("turn/start"); tries += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    const outcomes: string[] = [];
    const second = run("Correction.", { steerIntoRunningTurn: (outcome: string) => outcomes.push(outcome) });
    const [a, b] = [await first, await second];
    assert.deepEqual(outcomes, ["steered"]);
    assert.equal(a.turnContinues, true);
    assert.equal(b.content, "Steer 1 taken.");
    assert.equal((await calls()).filter((call) => call === "turn/start").length, 1);
  });
});

test("Stop pressed while Codex takes a steered message stops the turn it went into", async () => {
  await withSlowCodex(slowCodex({ steerDelayMs: 500 }), async (run, calls) => {
    let streamed!: () => void;
    const running = new Promise<void>((resolve) => { streamed = resolve; });
    const first = run("Build the old variant.", { onOutput: () => streamed() });
    await running;
    const stop = new AbortController();
    const outcomes: string[] = [];
    const second = run("Correction.", { steerIntoRunningTurn: (outcome: string) => outcomes.push(outcome) }, stop.signal);
    // Stopped while the steer waits for Codex's answer.
    for (let tries = 0; tries < 100 && !(await calls()).includes("turn/steer"); tries += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    stop.abort();
    const [a, b] = [await first, await second];
    assert.equal(a.turnContinues, true, "the reply so far ended where the message went in");
    assert.equal(b.ok, false, "the steered run ended stopped");
    assert.ok((await calls()).includes("turn/interrupt"), "the Codex turn it went into was interrupted");
  });
});

test("two requests delivered now to one Codex turn: each takes the turn over in its order, none is cut or sent twice", async () => {
  await withSlowCodex(slowCodex({ steerDelayMs: 300, twoSteers: true }), async (run, calls) => {
    let streamed!: () => void;
    const running = new Promise<void>((resolve) => { streamed = resolve; });
    const first = run("Build the old variant.", { onOutput: () => streamed() });
    await running;
    const outcomes: string[] = [];
    const second = run("Correction one.", { steerIntoRunningTurn: (outcome: string) => outcomes.push(`one ${outcome}`) });
    const third = run("Correction two.", { steerIntoRunningTurn: (outcome: string) => outcomes.push(`two ${outcome}`) });
    const [a, b, c] = [await first, await second, await third];
    assert.deepEqual(outcomes.sort(), ["one steered", "two steered"]);
    assert.equal(a.turnContinues, true);
    assert.equal(b.turnContinues, true);
    assert.equal(b.content, "Steer 1 taken.");
    assert.equal(c.content, "Steer 2 taken.");
    assert.equal((await calls()).filter((call) => call === "turn/start").length, 1, "nothing sent again as a turn of its own");
  });
});

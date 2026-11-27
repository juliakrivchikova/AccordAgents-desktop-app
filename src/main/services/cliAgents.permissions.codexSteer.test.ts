import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
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

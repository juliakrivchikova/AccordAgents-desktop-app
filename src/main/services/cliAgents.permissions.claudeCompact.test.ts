import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CliAgentRunner } from "./cliAgents";
import { cliDependencies, cliParts } from "./cliAgents/test/cliParts";
import { warmAgentKey } from "./cliAgents/warm/warmKeys";
import {
  assertFixtureProcessStops, makeRunner, writeClaudeCompactionFixture, writeCodexAppServerFixture
} from "./cliAgents/test/runnerFixtures";

// Claude Code's own config on this computer (Claude in Chrome, for one) must
// not decide these tests: an empty config folder is a fresh Claude Code.
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), "aa-claude-config-"));

test("codex app-server expires a completed-turn Guardian denial before compaction", async () => {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-codex-guardian-compact-"));
  const codexPath = await writeCodexAppServerFixture(fixtureDir, `#!/usr/bin/env node
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex", platformFamily: "unix", platformOsName: "macos", platformArch: "arm64" } });
  } else if (message.method === "thread/start" || message.method === "thread/resume") {
    send({ id: message.id, result: { thread: { id: "thread-guardian-compact" }, model: "gpt-5" } });
  } else if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-guardian-compact" } } });
    send({ method: "turn/started", params: { threadId: "thread-guardian-compact", turn: { id: "turn-guardian-compact" } } });
    send({ method: "item/autoApprovalReview/completed", params: {
      threadId: "thread-guardian-compact", turnId: "turn-guardian-compact", startedAtMs: 10, completedAtMs: 20,
      reviewId: "review-guardian-compact", targetItemId: "item-guardian-compact", decisionSource: "agent",
      review: { status: "denied", riskLevel: "high", userAuthorization: "low", rationale: "Protected action" },
      action: { type: "command", source: "unifiedExec", command: "git push origin scratch", cwd: process.cwd() }
    } });
    send({ method: "item/completed", params: { threadId: "thread-guardian-compact", turnId: "turn-guardian-compact", item: {
      id: "item-guardian-compact", type: "commandExecution", status: "failed", command: "git push origin scratch"
    } } });
    send({ method: "item/agentMessage/delta", params: { threadId: "thread-guardian-compact", turnId: "turn-guardian-compact", itemId: "agent-guardian-compact", delta: "Guardian denial recorded." } });
    send({ method: "item/completed", params: { threadId: "thread-guardian-compact", turnId: "turn-guardian-compact", item: { id: "agent-guardian-compact", type: "agentMessage", text: "Guardian denial recorded." } } });
    send({ method: "turn/completed", params: { threadId: "thread-guardian-compact", turn: { id: "turn-guardian-compact", status: "completed" } } });
  } else if (message.method === "thread/compact/start") {
    send({ id: message.id, result: {} });
    send({ method: "turn/started", params: { threadId: "thread-guardian-compact", turn: { id: "compact-turn" } } });
    send({ method: "turn/completed", params: { threadId: "thread-guardian-compact", turn: { id: "compact-turn", status: "completed" } } });
  }
});
`);
  const runner = new CliAgentRunner(undefined, undefined, codexPath) as any;
  const participant = { id: "participant-guardian-compact", kind: "codex-cli", label: "Codex" } as const;
  const warm = {
    conversationId: "conversation-guardian-compact",
    participantId: "participant-guardian-compact",
    contextKey: "context-guardian-compact",
    idleTimeoutMs: 60_000
  };
  let approvalAborted = false;
  try {
    const first = await cliParts(runner).codexRuns.runCodexAppServerWarmOrOneShot(
      participant,
      "Attempt the protected command.",
      fixtureDir,
      undefined,
      "chat",
      undefined,
      {
        agentMode: "auto",
        warm,
        onCodexServerRequest: (request: { signal: AbortSignal; responseDelivered: Promise<void> }) => {
          void request.responseDelivered.catch(() => undefined);
          return new Promise((_resolve, reject) => {
            request.signal.addEventListener("abort", () => {
              approvalAborted = true;
              reject(request.signal.reason);
            }, { once: true });
          });
        }
      }
    );
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(approvalAborted, false);

    const compact = await runner.compactSession(
      participant,
      fixtureDir,
      undefined,
      "chat",
      undefined,
      { agentMode: "auto", sessionId: first.sessionId, warm }
    );
    assert.equal(compact.ok, true, JSON.stringify(compact));
    assert.equal(approvalAborted, true);
  } finally {
    await runner.shutdownWarmAgents();
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

async function waitForCondition(condition: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!(await condition())) {
    if (Date.now() - start > timeoutMs) assert.fail("Timed out waiting for condition.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function readFixtureLog(log: string): Promise<Array<{ pid: number; started?: string[]; message?: string; control?: string; background?: string; replied?: string; compacted?: string; compacting?: string }>> {
  return (await readFile(log, "utf8")).trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

test("each compaction the member's live Claude Code process runs is told once, whatever reply it happened in, a failed one too; a subagent's is not", { timeout: 15_000 }, async () => {
  if (process.platform === "win32") return;
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-claude-auto-compact-"));
  const { claudePath } = await writeClaudeCompactionFixture(fixtureDir);
  const runner = makeRunner() as any;
  cliDependencies(runner).nativeProcessDbPath = path.join(fixtureDir, "native-processes.sqlite3");
  cliParts(runner).cliRuns.providerExecutableForRun = async () => claudePath;
  const participant = { id: "claude-auto-compact", kind: "claude-code", label: "Claude", model: "sonnet" };
  const warm = { conversationId: "conversation-auto-compact", participantId: participant.id, contextKey: "context-auto-compact", idleTimeoutMs: 60_000 };
  const take = () => runner.takeMemberClaudeCompactions(warm.conversationId, participant.id);
  try {
    const before = await runner.run(participant, "Write a lot.", fixtureDir, undefined, "chat", undefined, { agentMode: "default", warm, sessionId: "fixture-session" });
    assert.equal(before.ok, true, JSON.stringify(before));
    assert.equal(take(), 0);
    const filled = await runner.run(participant, "Fill the context.", fixtureDir, undefined, "chat", undefined, { agentMode: "default", warm, sessionId: "fixture-session" });
    assert.equal(filled.content, "Answered after compacting.");
    assert.equal(take(), 1, "the CLI rebuilt its system prompt from its launch's text: ChatService says the member's access again");
    assert.equal(take(), 0, "told once");
    const failed = await runner.run(participant, "Fill then fail.", fixtureDir, undefined, "chat", undefined, { agentMode: "default", warm, sessionId: "fixture-session" });
    assert.equal(failed.ok, false, JSON.stringify(failed));
    assert.equal(take(), 1, "a reply that failed after compacting still counts");
    const subagent = await runner.run(participant, "Subagent compacts.", fixtureDir, undefined, "chat", undefined, { agentMode: "default", warm, sessionId: "fixture-session" });
    assert.equal(subagent.ok, true, JSON.stringify(subagent));
    assert.equal(take(), 0, "a subagent's compaction leaves the member's system prompt as it was");
    assert.equal(runner.takeMemberClaudeCompactions("another-conversation", participant.id), 0, "counted per member");
  } finally {
    await runner.shutdownWarmAgents();
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("Claude /compact runs in the member's live process, so its next reply continues from the compacted context", { timeout: 15_000 }, async () => {
  if (process.platform === "win32") return;
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-claude-compact-live-"));
  const { claudePath, log } = await writeClaudeCompactionFixture(fixtureDir);
  const runner = makeRunner() as any;
  cliDependencies(runner).nativeProcessDbPath = path.join(fixtureDir, "native-processes.sqlite3");
  cliParts(runner).cliRuns.providerExecutableForRun = async () => claudePath;
  const participant = { id: "claude-compact", kind: "claude-code", label: "Claude", model: "claude-opus-5-5[1m]" };
  const warm = { conversationId: "conversation-compact", participantId: participant.id, contextKey: "context-compact", idleTimeoutMs: 60_000 };
  try {
    const first = await runner.run(participant, "Write a lot.", fixtureDir, undefined, "chat", undefined, { agentMode: "default", warm, sessionId: "fixture-session" });
    const second = await runner.run(participant, "Write more.", fixtureDir, undefined, "chat", undefined, { agentMode: "default", warm, sessionId: "fixture-session" });
    assert.equal(first.ok && second.ok, true);
    assert.equal(second.contextUsage?.usedTokens, 109000, "two long replies on the resumed session: 109k in context");

    const compact = await runner.compactSession(participant, fixtureDir, undefined, "chat", undefined,
      { agentMode: "default", warm, sessionId: "fixture-session", compactInstructions: "keep the plan" });
    assert.equal(compact.ok, true, JSON.stringify(compact));
    assert.equal(compact.contextUsage?.usedTokens, 29000, "the CLI's own count of the compacted context, system prompt included");
    assert.equal(compact.contextUsage?.contextWindowTokens, 1000000);

    const next = await runner.run(participant, "Continue.", fixtureDir, undefined, "chat", undefined, { agentMode: "default", warm, sessionId: "fixture-session" });
    assert.equal(next.contextUsage?.usedTokens, 69000, "the next reply continues from the compacted 29k, not from 109k");

    const entries = await readFixtureLog(log);
    const pids = new Set(entries.map((entry) => entry.pid));
    assert.equal(pids.size, 1, "the compaction and every reply ran in the one live process");
    assert.deepEqual(entries.filter((entry) => entry.message).map((entry) => entry.message),
      ["Write a lot.", "Write more.", "/compact keep the plan", "Continue."]);
    assert.ok(entries.some((entry) => entry.control === "get_context_usage"));
  } finally {
    await runner.shutdownWarmAgents();
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("Claude /compact runs while the member's background work keeps running, as in the dedicated CLI, and the work survives it", { timeout: 15_000 }, async () => {
  if (process.platform === "win32") return;
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-claude-compact-busy-"));
  const { claudePath, log, finishBackground } = await writeClaudeCompactionFixture(fixtureDir);
  const runner = makeRunner() as any;
  cliDependencies(runner).nativeProcessDbPath = path.join(fixtureDir, "native-processes.sqlite3");
  cliParts(runner).cliRuns.providerExecutableForRun = async () => claudePath;
  const participant = { id: "claude-compact-busy", kind: "claude-code", label: "Claude", model: "claude-opus-5-5[1m]" };
  const backgroundReports: string[][] = [];
  let selfResumed: Promise<any> | undefined;
  const warm = { conversationId: "conversation-compact-busy", participantId: participant.id, contextKey: "context-busy", idleTimeoutMs: 60_000,
    onSelfResumedTurn: (turn: any) => { selfResumed = turn.attach({}); },
    onBackgroundTasksChanged: (tasks: any[]) => { backgroundReports.push(tasks.map((task) => task.label)); } };
  try {
    const started = await runner.run(participant, "Start background.", fixtureDir, undefined, "chat", undefined, { agentMode: "default", warm, sessionId: "fixture-session" });
    assert.equal(started.ok, true);
    const live = Array.from(cliParts(runner).warmAgents.entries.values())[0] as any;
    assert.equal(live.hasLiveBackgroundWork(), true);
    const compact = await runner.compactSession(participant, fixtureDir, undefined, "chat", undefined, { agentMode: "default", warm, sessionId: "fixture-session" });
    assert.equal(compact.ok, true, JSON.stringify(compact));
    assert.equal(live.hasLiveBackgroundWork(), true, "the background task is still running after the compaction");
    assert.deepEqual(backgroundReports, [["fixture background task"]], "its status was never cleared");
    let entries = await readFixtureLog(log);
    assert.equal(entries.some((entry) => entry.background === "finished"), false, "compacted while the work ran, without waiting for it");

    await finishBackground();
    await waitForCondition(() => Boolean(selfResumed));
    const finished = await selfResumed!;
    assert.equal(finished.content, "Background done.", "the work finished in the same process and its answer still arrives");
    assert.deepEqual(backgroundReports, [["fixture background task"], []]);
    entries = await readFixtureLog(log);
    assert.ok(entries.findIndex((entry) => entry.message === "/compact") < entries.findIndex((entry) => entry.background === "finished"));
    assert.equal(new Set(entries.map((entry) => entry.pid)).size, 1, "in the same process, which was not ended");
  } finally {
    await runner.shutdownWarmAgents();
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("Claude /compact: background work that finishes during the compaction is answered after it, as a reply of its own", { timeout: 15_000 }, async () => {
  if (process.platform === "win32") return;
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-claude-compact-meanwhile-"));
  const { claudePath, log, finishBackground } = await writeClaudeCompactionFixture(fixtureDir);
  const runner = makeRunner() as any;
  cliDependencies(runner).nativeProcessDbPath = path.join(fixtureDir, "native-processes.sqlite3");
  cliParts(runner).cliRuns.providerExecutableForRun = async () => claudePath;
  const participant = { id: "claude-compact-meanwhile", kind: "claude-code", label: "Claude", model: "claude-opus-5-5[1m]" };
  const backgroundReports: string[][] = [];
  let selfResumed: Promise<any> | undefined;
  const warm = { conversationId: "conversation-compact-meanwhile", participantId: participant.id, contextKey: "context-meanwhile", idleTimeoutMs: 60_000,
    onSelfResumedTurn: (turn: any) => { selfResumed = turn.attach({}); },
    onBackgroundTasksChanged: (tasks: any[]) => { backgroundReports.push(tasks.map((task) => task.label)); } };
  try {
    await runner.run(participant, "Start background.", fixtureDir, undefined, "chat", undefined, { agentMode: "default", warm, sessionId: "fixture-session" });
    const compacting = runner.compactSession(participant, fixtureDir, undefined, "chat", undefined,
      { agentMode: "default", warm, sessionId: "fixture-session", compactInstructions: "meanwhile" });
    await waitForCondition(async () => (await readFixtureLog(log)).some((entry) => entry.compacting));
    await finishBackground();
    const compact = await compacting;
    assert.equal(compact.ok, true, JSON.stringify(compact));
    assert.equal(compact.content, "", "the compaction's reply is not the task's answer");
    assert.equal(compact.contextUsage?.usedTokens, 29000, "the compaction's own figure, not the task answer's 100k");
    await waitForCondition(() => Boolean(selfResumed));
    assert.equal((await selfResumed!).content, "Background done.", "the task's answer is a reply of its own");
    assert.deepEqual(backgroundReports, [["fixture background task"], []]);
    const entries = await readFixtureLog(log);
    const finishedAt = entries.findIndex((entry) => entry.background === "finished");
    assert.ok(finishedAt > entries.findIndex((entry) => entry.message === "/compact meanwhile")
      && finishedAt < entries.findIndex((entry) => entry.compacted), "the task ended while the compaction ran");
  } finally {
    await runner.shutdownWarmAgents();
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("Claude /compact: the answer to background work that ends during it gets the task's row and the thread that started the task", { timeout: 15_000 }, async () => {
  if (process.platform === "win32") return;
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-claude-compact-meanwhile-step-"));
  const { claudePath, log, finishBackground } = await writeClaudeCompactionFixture(fixtureDir);
  const runner = makeRunner() as any;
  cliDependencies(runner).nativeProcessDbPath = path.join(fixtureDir, "native-processes.sqlite3");
  cliParts(runner).cliRuns.providerExecutableForRun = async () => claudePath;
  const participant = { id: "claude-compact-meanwhile-step", kind: "claude-code", label: "Claude", model: "claude-opus-5-5[1m]" };
  let resumed: { origin: unknown; outputs: string[]; done: Promise<any> } | undefined;
  const warm = { conversationId: "conversation-compact-meanwhile-step", participantId: participant.id, contextKey: "context-meanwhile-step", idleTimeoutMs: 60_000,
    onSelfResumedTurn: (turn: any) => {
      const outputs: string[] = [];
      resumed = { origin: turn.origin, outputs, done: turn.attach({ onOutput: (event: { text: string }) => outputs.push(event.text) }) };
    } };
  try {
    await runner.run(participant, "Start background.", fixtureDir, undefined, "chat", undefined,
      { agentMode: "default", sessionId: "fixture-session", warm: { ...warm, origin: { runId: "run-started-task", messageId: "reply-started-task" } } });
    await runner.run(participant, "Write a lot.", fixtureDir, undefined, "chat", undefined,
      { agentMode: "default", sessionId: "fixture-session", warm: { ...warm, origin: { runId: "run-later", messageId: "reply-later" } } });
    const compacting = runner.compactSession(participant, fixtureDir, undefined, "chat", undefined,
      { agentMode: "default", warm, sessionId: "fixture-session", compactInstructions: "meanwhile-step" });
    await waitForCondition(async () => (await readFixtureLog(log)).some((entry) => entry.compacting));
    await finishBackground();
    assert.equal((await compacting).ok, true);
    await waitForCondition(() => Boolean(resumed));
    assert.equal((await resumed!.done).content, "Background done.");
    assert.deepEqual(resumed!.origin, { runId: "run-started-task", messageId: "reply-started-task" }, "in the thread of the turn that started the task");
    assert.ok(resumed!.outputs.some((text) => /Background task finished: fixture background task/.test(text)), "with the task's row");
  } finally {
    await runner.shutdownWarmAgents();
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("Claude /compact runs in a process started with other settings while it carries background work, instead of waiting for that work", { timeout: 15_000 }, async () => {
  if (process.platform === "win32") return;
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-claude-compact-other-settings-"));
  const { claudePath, log, finishBackground } = await writeClaudeCompactionFixture(fixtureDir);
  const runner = makeRunner() as any;
  cliDependencies(runner).nativeProcessDbPath = path.join(fixtureDir, "native-processes.sqlite3");
  cliParts(runner).cliRuns.providerExecutableForRun = async () => claudePath;
  const participant = { id: "claude-compact-other-settings", kind: "claude-code", label: "Claude", model: "claude-opus-5-5[1m]" };
  const warm = { conversationId: "conversation-compact-other-settings", participantId: participant.id, contextKey: "context-once", idleTimeoutMs: 60_000,
    onSelfResumedTurn: (turn: any) => { void turn.attach({}); } };
  try {
    // A turn with a one-time approval: its process has other settings.
    await runner.run(participant, "Start background.", fixtureDir, undefined, "chat", undefined, { agentMode: "default", warm, sessionId: "fixture-session" });
    const compact = await runner.compactSession(participant, fixtureDir, undefined, "chat", undefined,
      { agentMode: "default", warm: { ...warm, contextKey: "context-usual" }, sessionId: "fixture-session" });
    assert.equal(compact.ok, true, JSON.stringify(compact));
    const entries = await readFixtureLog(log);
    assert.equal(entries.filter((entry) => entry.started).length, 1, "no process was started or replaced");
    assert.equal(entries.some((entry) => entry.background === "finished"), false, "compacted without waiting for the background work");
    assert.equal((Array.from(cliParts(runner).warmAgents.entries.values())[0] as any).hasLiveBackgroundWork(), true, "which keeps running");
    await finishBackground();
  } finally {
    await runner.shutdownWarmAgents();
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("Claude /compact waits for a reply in progress before it is sent", { timeout: 15_000 }, async () => {
  if (process.platform === "win32") return;
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-claude-compact-reply-"));
  const { claudePath, log } = await writeClaudeCompactionFixture(fixtureDir);
  const runner = makeRunner() as any;
  cliDependencies(runner).nativeProcessDbPath = path.join(fixtureDir, "native-processes.sqlite3");
  cliParts(runner).cliRuns.providerExecutableForRun = async () => claudePath;
  const participant = { id: "claude-compact-reply", kind: "claude-code", label: "Claude", model: "claude-opus-5-5[1m]" };
  const warm = { conversationId: "conversation-compact-reply", participantId: participant.id, contextKey: "context-reply", idleTimeoutMs: 60_000 };
  try {
    const replying = runner.run(participant, "Reply slowly.", fixtureDir, undefined, "chat", undefined, { agentMode: "default", warm, sessionId: "fixture-session" });
    await waitForCondition(async () => (await readFixtureLog(log).catch(() => [])).some((entry) => entry.message === "Reply slowly."));
    const compact = await runner.compactSession(participant, fixtureDir, undefined, "chat", undefined, { agentMode: "default", warm, sessionId: "fixture-session" });
    assert.equal((await replying).content, "Slow reply.");
    assert.equal(compact.ok, true, JSON.stringify(compact));
    assert.equal(compact.contextUsage?.usedTokens, 29000);
    const entries = await readFixtureLog(log);
    const repliedAt = entries.findIndex((entry) => entry.replied === "Reply slowly.");
    const compactAt = entries.findIndex((entry) => entry.message === "/compact");
    assert.ok(repliedAt >= 0 && compactAt > repliedAt, "the compaction was sent only once the reply had ended");
  } finally {
    await runner.shutdownWarmAgents();
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("Claude /compact queued behind a reply is sent when that reply ends, while background work keeps running", { timeout: 15_000 }, async () => {
  if (process.platform === "win32") return;
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-claude-compact-queued-"));
  const { claudePath, log, finishBackground } = await writeClaudeCompactionFixture(fixtureDir);
  const runner = makeRunner() as any;
  cliDependencies(runner).nativeProcessDbPath = path.join(fixtureDir, "native-processes.sqlite3");
  cliParts(runner).cliRuns.providerExecutableForRun = async () => claudePath;
  const participant = { id: "claude-compact-queued", kind: "claude-code", label: "Claude", model: "claude-opus-5-5[1m]" };
  const warm = { conversationId: "conversation-compact-queued", participantId: participant.id, contextKey: "context-queued", idleTimeoutMs: 60_000,
    onSelfResumedTurn: (turn: any) => { void turn.attach({}); } };
  try {
    await runner.run(participant, "Start background.", fixtureDir, undefined, "chat", undefined, { agentMode: "default", warm, sessionId: "fixture-session" });
    const live = Array.from(cliParts(runner).warmAgents.entries.values())[0] as any;
    const replying = runner.run(participant, "Reply slowly.", fixtureDir, undefined, "chat", undefined, { agentMode: "default", warm, sessionId: "fixture-session" });
    await waitForCondition(async () => (await readFixtureLog(log)).some((entry) => entry.message === "Reply slowly."));
    const compact = await runner.compactSession(participant, fixtureDir, undefined, "chat", undefined, { agentMode: "default", warm, sessionId: "fixture-session" });
    assert.equal((await replying).content, "Slow reply.");
    assert.equal(compact.ok, true, JSON.stringify(compact));
    const entries = await readFixtureLog(log);
    assert.ok(entries.findIndex((entry) => entry.message === "/compact") > entries.findIndex((entry) => entry.replied === "Reply slowly."),
      "sent once the reply ended");
    assert.equal(entries.some((entry) => entry.background === "finished"), false, "without waiting for the background work");
    assert.equal(live.hasLiveBackgroundWork(), true);
    await finishBackground();
  } finally {
    await runner.shutdownWarmAgents();
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("Claude /compact: Stop while it waits for a reply in progress cancels it before it is sent, and the process keeps serving", { timeout: 15_000 }, async () => {
  if (process.platform === "win32") return;
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-claude-compact-stop-waiting-"));
  const { claudePath, log } = await writeClaudeCompactionFixture(fixtureDir);
  const runner = makeRunner() as any;
  cliDependencies(runner).nativeProcessDbPath = path.join(fixtureDir, "native-processes.sqlite3");
  cliParts(runner).cliRuns.providerExecutableForRun = async () => claudePath;
  const participant = { id: "claude-compact-stop-waiting", kind: "claude-code", label: "Claude", model: "claude-opus-5-5[1m]" };
  const warm = { conversationId: "conversation-compact-stop-waiting", participantId: participant.id, contextKey: "context-stop-waiting", idleTimeoutMs: 60_000 };
  try {
    const replying = runner.run(participant, "Reply slowly.", fixtureDir, undefined, "chat", undefined, { agentMode: "default", warm, sessionId: "fixture-session" });
    await waitForCondition(async () => (await readFixtureLog(log).catch(() => [])).some((entry) => entry.message === "Reply slowly."));
    const stop = new AbortController();
    const compacting = runner.compactSession(participant, fixtureDir, undefined, "chat", stop.signal, { agentMode: "default", warm, sessionId: "fixture-session" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    stop.abort(new Error("Stopped by user."));
    const stopped = await compacting;
    assert.equal(stopped.ok, false);
    assert.equal(stopped.error, "Compaction was cancelled.");
    assert.equal((await replying).content, "Slow reply.", "the reply in progress is not touched");
    const live = Array.from(cliParts(runner).warmAgents.entries.values())[0] as any;
    assert.ok(live.idleTimer, "the member's idle timer is re-armed");
    const next = await runner.run(participant, "Still there?", fixtureDir, undefined, "chat", undefined, { agentMode: "default", warm, sessionId: "fixture-session" });
    assert.equal(next.ok, true);
    const entries = await readFixtureLog(log);
    assert.equal(entries.some((entry) => entry.message?.startsWith("/compact")), false, "never sent");
    assert.equal(new Set(entries.map((entry) => entry.pid)).size, 1);
  } finally {
    await runner.shutdownWarmAgents();
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("Claude /compact: Stop interrupts it in the live process, which keeps serving the member", { timeout: 15_000 }, async () => {
  if (process.platform === "win32") return;
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-claude-compact-stop-"));
  const { claudePath, log } = await writeClaudeCompactionFixture(fixtureDir);
  const runner = makeRunner() as any;
  cliDependencies(runner).nativeProcessDbPath = path.join(fixtureDir, "native-processes.sqlite3");
  cliParts(runner).cliRuns.providerExecutableForRun = async () => claudePath;
  const participant = { id: "claude-compact-stop", kind: "claude-code", label: "Claude", model: "claude-opus-5-5[1m]" };
  const warm = { conversationId: "conversation-compact-stop", participantId: participant.id, contextKey: "context-stop", idleTimeoutMs: 60_000 };
  try {
    await runner.run(participant, "Hello.", fixtureDir, undefined, "chat", undefined, { agentMode: "default", warm });
    const fresh = await runner.run(participant, "Hello again.", fixtureDir, undefined, "chat", undefined, { agentMode: "default", warm });
    assert.equal(fresh.ok, true);
    const stop = new AbortController();
    const stopping = runner.compactSession(participant, fixtureDir, undefined, "chat", stop.signal,
      { agentMode: "default", warm, sessionId: "fixture-session", compactInstructions: "slowly" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    stop.abort(new Error("Stopped by user."));
    const stopped = await stopping;
    assert.equal(stopped.ok, false);
    assert.equal(stopped.error, "Compaction was cancelled.");
    const after = await runner.run(participant, "Still there?", fixtureDir, undefined, "chat", undefined, { agentMode: "default", warm, sessionId: "fixture-session" });
    assert.equal(after.ok, true, "the member's process survived the Stop and serves the next reply");
    const entries = await readFixtureLog(log);
    assert.equal(new Set(entries.map((entry) => entry.pid)).size, 1);
    assert.ok(entries.some((entry) => entry.control === "interrupt"), "Stop interrupted the step instead of ending the process");
  } finally {
    await runner.shutdownWarmAgents();
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("Claude /compact the CLI declines is reported with the CLI's own words, not as compacted", { timeout: 15_000 }, async () => {
  if (process.platform === "win32") return;
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-claude-compact-refused-"));
  const { claudePath } = await writeClaudeCompactionFixture(fixtureDir);
  const runner = makeRunner() as any;
  cliDependencies(runner).nativeProcessDbPath = path.join(fixtureDir, "native-processes.sqlite3");
  cliParts(runner).cliRuns.providerExecutableForRun = async () => claudePath;
  const participant = { id: "claude-compact-refused", kind: "claude-code", label: "Claude", model: "claude-opus-5-5[1m]" };
  const warm = { conversationId: "conversation-compact-refused", participantId: participant.id, contextKey: "context-refused", idleTimeoutMs: 60_000 };
  try {
    // A live process of a brand-new session (nothing said yet in it).
    cliParts(runner).warmAgents.entries.clear();
    const entry = await cliParts(runner).claudeProcess.createClaudeWarmAgent(warmAgentKey(participant as never, fixtureDir, "chat", { agentMode: "default", warm }),
      `${warm.conversationId}:${warm.participantId}`, participant, fixtureDir, "chat", { agentMode: "default", warm, persistSession: true }, claudePath);
    cliParts(runner).warmAgents.entries.set(entry.key, entry);
    const refused = await runner.compactSession(participant, fixtureDir, undefined, "chat", undefined, { agentMode: "default", warm, sessionId: "fixture-session" });
    assert.equal(refused.ok, false);
    assert.equal(refused.error, "No messages to compact");
  } finally {
    await runner.shutdownWarmAgents();
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("Claude /compact with no live process starts the member's live process as its turn would, and the next turn continues in it", { timeout: 15_000 }, async () => {
  if (process.platform === "win32") return;
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-claude-compact-own-"));
  const { claudePath, log } = await writeClaudeCompactionFixture(fixtureDir);
  const runner = makeRunner() as any;
  cliDependencies(runner).nativeProcessDbPath = path.join(fixtureDir, "native-processes.sqlite3");
  cliParts(runner).cliRuns.providerExecutableForRun = async () => claudePath;
  const participant = { id: "claude-compact-own", kind: "claude-code", label: "Claude", model: "claude-opus-5-5[1m]" };
  const warm = { conversationId: "conversation-compact-own", participantId: participant.id, contextKey: "context-a", idleTimeoutMs: 60_000 };
  const appMcp = { url: "http://127.0.0.1:9/mcp", token: "member-token", toolNames: ["app_chat_send_message"] };
  try {
    // A live process started with other settings: its next turn replaces it.
    await runner.run(participant, "Write a lot.", fixtureDir, undefined, "chat", undefined, { agentMode: "default", warm, appMcp, sessionId: "fixture-session" });
    const member = { agentMode: "default", warm: { ...warm, contextKey: "context-b" }, appMcp, sessionId: "fixture-session", persistSession: true };
    const compact = await runner.compactSession(participant, fixtureDir, undefined, "chat", undefined, member);
    assert.equal(compact.ok, true, JSON.stringify(compact));
    assert.equal(compact.contextUsage?.usedTokens, 29000, "the figure of the process that holds the compacted session");

    let entries = await readFixtureLog(log);
    const starts = entries.filter((entry) => entry.started);
    assert.equal(starts.length, 2, "the stale process was replaced by the member's process");
    const started = starts[1].started!;
    assert.ok(started.includes("--resume") && started.includes("fixture-session"), "resumed on the member's session");
    assert.ok(started.includes("--mcp-config"), "with the member's app tools, as its turns start it");
    assert.equal(entries.find((entry) => entry.message?.startsWith("/compact"))?.pid, starts[1].pid);
    assert.equal(cliParts(runner).warmAgents.entries.size, 1, "kept as the member's live process");
    await assertFixtureProcessStops(starts[0].pid);

    const next = await runner.run(participant, "Continue.", fixtureDir, undefined, "chat", undefined, member);
    assert.equal(next.ok, true);
    assert.equal(next.contextUsage?.usedTokens, 69000, "the next turn continues from the 29k shown after compacting");
    entries = await readFixtureLog(log);
    assert.equal(entries.filter((entry) => entry.started).length, 2, "no further process was started");
    assert.equal(entries.find((entry) => entry.message === "Continue.")?.pid, starts[1].pid, "the next turn ran in the process the compaction started");
  } finally {
    await runner.shutdownWarmAgents();
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

/** A stand-in for the process a compaction runs in: records what it was
 *  asked and answers like the CLI. */
function fakeCompactionProcess(answer: { ok?: boolean; contextUsage?: unknown; postTokens?: number } = {}) {
  const calls: Array<{ prompt: string; timeoutMs?: number; allowEmptyContent?: boolean; observers?: string[] }> = [];
  let compactions = 0;
  const entry: any = {
    key: "compact-entry", scopeKey: "compact-scope", providerKind: "claude-code", closed: false, queue: Promise.resolve(),
    process: { exitCode: null },
    isIdle: () => true,
    run: async (prompt: string, _signal: unknown, _onOutput: unknown, _onSessionId: unknown, timeoutMs?: number, _goal?: unknown, _codex?: unknown, claude?: Record<string, unknown>) => {
      calls.push({
        prompt,
        timeoutMs,
        allowEmptyContent: claude?.allowEmptyContent as boolean | undefined,
        observers: ["onSelfResumedTurn", "onBackgroundTasksChanged"].filter((name) => typeof claude?.[name] === "function")
      });
      if (answer.ok === false) return { ok: false, sessionId: "session-1", error: "compaction failed" };
      compactions += 1;
      return { ok: true, sessionId: "session-1", content: "" };
    },
    contextUsage: async () => answer.contextUsage,
    lastCompactBoundary: () => (compactions ? { count: compactions, ...(answer.postTokens ? { postTokens: answer.postTokens } : {}) } : undefined)
  };
  return { entry, calls };
}

const COMPACT_WARM = { conversationId: "c1", participantId: "p1", contextKey: "k", idleTimeoutMs: 60_000, onSelfResumedTurn: () => undefined, onBackgroundTasksChanged: () => undefined };

function startsFakeMemberProcess(runner: any, entry: any): { created?: { key: string; scopeKey: string; options: any } } {
  const record: { created?: { key: string; scopeKey: string; options: any } } = {};
  cliParts(runner).cliRuns.providerExecutableForRun = async () => "claude";
  cliParts(runner).claudeProcess.createClaudeWarmAgent = async (key: string, scopeKey: string, _participant: unknown, _repoPath: unknown, _kind: unknown, options: any) => {
    record.created = { key, scopeKey, options };
    entry.key = key;
    entry.scopeKey = scopeKey;
    cliParts(runner).warmAgents.entries.set(key, entry);
    return entry;
  };
  return record;
}

test("claude compact with no live process starts the member's process as its turn would and keeps it: its key, role and app tools, its turns' timeout, the CLI's count reported", async () => {
  const runner = makeRunner() as any;
  runner.setRunTimeoutMs(2 * 60 * 60_000);
  const usage = { usedTokens: 1995, contextWindowTokens: 1_000_000, percentage: 0, source: "claude-code", updatedAt: "2026-06-17T00:00:00.000Z" };
  const { entry, calls } = fakeCompactionProcess({ contextUsage: usage });
  const record = startsFakeMemberProcess(runner, entry);
  const closed: string[] = [];
  cliParts(runner).warmAgentClose.closeWarmAgent = async (_entry: unknown, reason: string) => { closed.push(reason); };
  const participant = { kind: "claude-code", label: "@claude" };
  const options = {
    sessionId: "session-1",
    role: { name: "role", description: "d", instructions: "i", promptFallbackPrompt: "" },
    appMcp: { url: "http://127.0.0.1:1", token: "t", toolNames: [] },
    warm: COMPACT_WARM
  };

  const result = await cliParts(runner).claudeRuns.compactClaudeSession(participant, "/repo", "chat", undefined, options);

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{ prompt: "/compact", timeoutMs: 2 * 60 * 60_000, allowEmptyContent: true, observers: ["onSelfResumedTurn", "onBackgroundTasksChanged"] }]);
  assert.equal(record.created!.key, warmAgentKey(participant as never, "/repo", "chat", options), "under the key the member's next turn looks up");
  assert.equal(record.created!.scopeKey, "c1:p1");
  assert.equal(record.created!.options.sessionId, "session-1", "resumed on the member's session");
  assert.equal(record.created!.options.role, options.role);
  assert.equal(record.created!.options.appMcp, options.appMcp);
  assert.equal(record.created!.options.warm, options.warm);
  assert.deepEqual(closed, [], "not closed afterwards");
  assert.equal(cliParts(runner).warmAgents.entries.get(record.created!.key), entry, "kept as the member's live process");
  assert.ok(entry.idleTimer, "with the member's idle timer re-armed");
  clearTimeout(entry.idleTimer);
  assert.equal(result.contextUsage.usedTokens, 1995);
});

test("claude compact instructions are sent as part of the native compact command", async () => {
  const runner = makeRunner() as any;
  const { entry, calls } = fakeCompactionProcess({ postTokens: 9000 });
  startsFakeMemberProcess(runner, entry);

  const result = await cliParts(runner).claudeRuns.compactClaudeSession(
    { kind: "claude-code", label: "@claude", model: "claude-opus-5-5[1m]" },
    "/repo",
    "chat",
    undefined,
    {
      sessionId: "session-1",
      compactInstructions: "keep focus on user approval and test output",
      warm: COMPACT_WARM
    }
  );

  assert.equal(result.ok, true);
  assert.equal(calls[0].prompt, "/compact keep focus on user approval and test output");
  assert.equal(result.contextUsage?.usedTokens, 9000, "without get_context_usage, the CLI's own compaction figure");
  clearTimeout(entry.idleTimer);
});

test("claude compact reports the CLI's failure as the compaction's and keeps the member's process; one left unusable is closed", async () => {
  const runner = makeRunner() as any;
  const { entry } = fakeCompactionProcess({ ok: false });
  startsFakeMemberProcess(runner, entry);
  const closed: string[] = [];
  cliParts(runner).warmAgentClose.closeWarmAgent = async (_entry: unknown, reason: string) => { closed.push(reason); };
  const options = { sessionId: "session-1", warm: COMPACT_WARM };
  const result = await cliParts(runner).claudeRuns.compactClaudeSession({ kind: "claude-code", label: "@claude" }, "/repo", "chat", undefined, options);
  assert.equal(result.ok, false);
  assert.equal(result.error, "compaction failed");
  assert.equal(cliParts(runner).warmAgents.entries.get(entry.key), entry, "still the member's process");
  assert.ok(entry.idleTimer, "with its idle timer");
  entry.run = async () => { entry.unusable = true; throw new Error("claude warm process exited with code 1"); };
  const crashed = await cliParts(runner).claudeRuns.compactClaudeSession({ kind: "claude-code", label: "@claude" }, "/repo", "chat", undefined, options);
  assert.equal(crashed.ok, false);
  assert.match(crashed.error, /exited with code 1/);
  assert.deepEqual(closed, ["unusable"]);
  assert.equal(cliParts(runner).warmAgents.entries.has(entry.key), false);
  clearTimeout(entry.idleTimer);
});

test("claude compact that waited for a process with other settings does not start one once native sessions shut down", async () => {
  const runner = makeRunner() as any;
  let created = false;
  cliParts(runner).claudeProcess.createClaudeWarmAgent = async () => { created = true; throw new Error("must not start"); };
  const busy: any = {
    key: "other-settings", scopeKey: "c1:p1", providerKind: "claude-code", closed: false, queue: Promise.resolve(), process: { exitCode: null },
    isIdle: () => false,
    whenIdle: async () => { cliParts(runner).warmAgents.warmShutdown = true; }
  };
  cliParts(runner).warmAgents.entries.set(busy.key, busy);
  const result = await cliParts(runner).claudeRuns.compactClaudeSession({ kind: "claude-code", label: "@claude" }, "/repo", "chat", undefined, { sessionId: "session-1", warm: COMPACT_WARM });
  assert.equal(result.ok, false);
  assert.match(result.error, /shutting down/);
  assert.equal(created, false);
  cliParts(runner).warmAgents.warmShutdown = false;
});

test("claude compact without a member session has nothing to compact", async () => {
  const runner = makeRunner() as any;
  cliParts(runner).claudeProcess.createClaudeWarmAgent = async () => assert.fail("no process is started without a member session");
  const result = await cliParts(runner).claudeRuns.compactClaudeSession({ kind: "claude-code", label: "@claude" }, "/repo", "chat", undefined, { sessionId: "session-1" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "@claude has no chat session to compact.");
});

test("a host admission completing after shutdown cannot start its earlier command or compaction", async () => {
  for (const compact of [false, true]) {
    const runner = makeRunner() as any;
    let admit!: (value: { admitted: true }) => void;
    runner.setHostAdmission(() => new Promise(resolve => { admit = resolve; }));
    let executions = 0;
    cliParts(runner).codexRuns.runCodex = cliParts(runner).codexRuns.compactCodexSession = async () => { executions++; throw new Error("must not execute"); };
    const method = compact ? "compactSession" : "run";
    const participant = { id: "late", label: "Codex", kind: "codex-cli" };
    const pending = compact
      ? runner[method](participant, undefined, undefined, "chat", undefined, { sessionId: "session" })
      : runner[method](participant, "held", undefined, undefined, "chat");
    await runner.shutdownWarmAgents();
    admit({ admitted: true });
    const result = await pending;
    assert.equal(result.ok, false); assert.match(result.error, /shut down while/);
    assert.equal(executions, 0); assert.equal(runner.hasActiveNativeWork(), false);
  }
});

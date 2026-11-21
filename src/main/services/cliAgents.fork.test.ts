import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CliAgentRunner, isForkSourceMissingError } from "./cliAgents";
import { defaultChatAgentPermissions } from "../../shared/agentPermissions";

// A member made as a fork of the main session's CLI session
// (docs/main-session.md): its first turn copies that session through the
// CLI's own fork and gets an id of its own; later turns resume its own id.

process.env.CLAUDE_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), "aa-claude-config-fork-"));

const role = { name: "accordagents-child", description: "Child", instructions: "You are @child.", promptFallbackPrompt: "" };

function claudeArgs(options: Record<string, unknown>, newSessionId?: string): string[] {
  const runner = new CliAgentRunner() as any;
  const fullOptions = { agentMode: "default", permissions: defaultChatAgentPermissions(), role, persistSession: true, ...options };
  const config = runner.claudeToolConfig("chat", "/repo", [], fullOptions);
  return runner.claudeLaunchArgs(
    { id: "child", kind: "claude-code", label: "@child" },
    "chat",
    fullOptions,
    config,
    [],
    "warm",
    newSessionId
  ) as string[];
}

test("claude: a fork resumes the source with --fork-session under its own new session id, without --agent", () => {
  const args = claudeArgs({ forkFromSessionId: "parent-session" }, "child-session");
  const resume = args.indexOf("--resume");
  assert.ok(resume >= 0, args.join(" "));
  assert.equal(args[resume + 1], "parent-session");
  assert.equal(args.includes("--fork-session"), true);
  assert.equal(args[args.indexOf("--session-id") + 1], "child-session", "the copy gets the id the app persists");
  // Claude Code keeps the source's agent in a resumed session; --agent is
  // not applied there, so it is not sent.
  assert.equal(args.includes("--agents"), false);
  assert.equal(args.includes("--agent"), false);
});

test("claude: once the fork has its own id it resumes that id, never the source", () => {
  const args = claudeArgs({ sessionId: "child-session", forkFromSessionId: "parent-session" });
  assert.equal(args[args.indexOf("--resume") + 1], "child-session");
  assert.equal(args.includes("--fork-session"), false);
  assert.equal(args.includes("parent-session"), false);
});

test("claude: Fork to new chat copies only up to the reply the User saw: --resume-session-at with the fork, never on its own session", () => {
  const args = claudeArgs({ forkFromSessionId: "parent-session", forkResumeAt: "assistant-uuid-1" }, "child-session");
  const fork = args.indexOf("--fork-session");
  assert.deepEqual(args.slice(args.indexOf("--resume"), fork + 3), ["--resume", "parent-session", "--fork-session", "--resume-session-at", "assistant-uuid-1"]);
  assert.equal(args[args.indexOf("--session-id") + 1], "child-session");
  const own = claudeArgs({ sessionId: "child-session", forkFromSessionId: "parent-session", forkResumeAt: "assistant-uuid-1" });
  assert.equal(own.includes("--resume-session-at"), false, "its own session is resumed whole");
  assert.equal(claudeArgs({ forkFromSessionId: "parent-session" }, "child-session").includes("--resume-session-at"), false, "a delegated fork copies all of it");
});

/** A Claude Code transcript of two turns ("remember APPLE": a1, "remember
 *  BANANA": a2), as 2.1.329 writes it, under a projects folder. */
async function claudeProjectsWithTranscript(sessionId: string, extraLines: string[] = []): Promise<string> {
  const projects = await mkdtemp(path.join(tmpdir(), "aa-claude-projects-"));
  await mkdir(path.join(projects, "-repo"), { recursive: true });
  const entry = (type: string, uuid: string, timestamp: string) => JSON.stringify({ isSidechain: false, type, uuid, timestamp, message: { role: type, content: "x" } });
  await writeFile(path.join(projects, "-repo", `${sessionId}.jsonl`), [
    entry("user", "u1", "2026-11-21T16:23:41.220Z"), entry("assistant", "a1", "2026-11-21T16:23:42.531Z"),
    entry("user", "u2", "2026-11-21T16:23:48.684Z"), entry("assistant", "a2", "2026-11-21T16:23:49.905Z"), ...extraLines
  ].join("\n"), "utf8");
  return projects;
}

/** runClaude with its turn recorded instead of run: what the fork asks of the CLI, and what it said at once. */
async function claudeForkTurns(projects: string, forkCut: Record<string, unknown>, answers: Array<Record<string, unknown>> = []) {
  const said: string[] = [];
  const runner = new CliAgentRunner() as any;
  runner.claudeProjectsDirectory = async () => projects;
  const turns: any[] = [];
  runner.runClaudeTurn = async (participant: unknown, _prompt: string, _repo: unknown, _kind: unknown, _signal: unknown, options: any) => {
    turns.push(options);
    return { participant, ok: true, content: "ok", sessionId: "child-session", ...(answers[turns.length - 1] ?? {}) };
  };
  const result = await runner.runClaude({ id: "main", kind: "claude-code", label: "@main" }, "Go on.", "/repo", "chat", undefined,
    { persistSession: true, forkFromSessionId: "parent-session", forkCut, onForkCutMissed: (reason: string) => said.push(`${turns.length}:${reason}`) });
  return { result, turns, said };
}

test("claude: the fork reads the source's transcript and ends the copy at the reply's assistant message", async () => {
  const projects = await claudeProjectsWithTranscript("parent-session");
  try {
    const recorded = await claudeForkTurns(projects, { at: "a1" });
    assert.equal(recorded.turns.length, 1);
    assert.equal(recorded.turns[0].forkResumeAt, "a1");
    assert.equal(recorded.turns[0].forkCut, undefined);
    assert.equal(recorded.result.forkCutMissed, undefined);
    const byTime = await claudeForkTurns(projects, { finishedBy: "2026-11-21T16:23:43.000Z" });
    assert.equal(byTime.turns[0].forkResumeAt, "a1", "an older reply, by its finish");
    const nothingAfter = await claudeForkTurns(projects, { at: "a2" });
    assert.equal(nothingAfter.turns[0].forkResumeAt, "a2", "nothing came after it: all of it, and a turn the member starts meanwhile stays out");
    assert.equal(nothingAfter.result.forkCutMissed, undefined);
    assert.deepEqual(nothingAfter.said, []);
  } finally {
    await rm(projects, { recursive: true, force: true });
  }
});

test("claude: a point the CLI cannot keep copies the whole session and says why", async () => {
  const compacted = await claudeProjectsWithTranscript("parent-session", [JSON.stringify({ type: "system", subtype: "compact_boundary", uuid: "c1", timestamp: "2026-11-21T16:30:00.000Z" })]);
  const empty = await mkdtemp(path.join(tmpdir(), "aa-claude-projects-empty-"));
  try {
    const afterCompaction = await claudeForkTurns(compacted, { at: "a1" });
    assert.equal(afterCompaction.turns[0].forkResumeAt, undefined);
    assert.equal(afterCompaction.result.forkCutMissed, "its session was compacted after that reply");
    assert.deepEqual(afterCompaction.said, ["0:its session was compacted after that reply"], "said before the turn runs");
    const noTranscript = await claudeForkTurns(empty, { at: "a1" });
    assert.equal(noTranscript.turns[0].forkResumeAt, undefined);
    assert.equal(noTranscript.result.forkCutMissed, "its session file could not be read");
    assert.deepEqual(noTranscript.said, [], "said with the turn, once the copy was made: a session not on this device is no copy");
    // The CLI refused the point after all: once more, whole, and said.
    const projects = await claudeProjectsWithTranscript("parent-session");
    try {
      const refused = await claudeForkTurns(projects, { at: "a1" }, [{ ok: false, content: "", error: "claude warm process exited with code 1: No message found with message.uuid of: a1" }]);
      assert.deepEqual(refused.turns.map((turn) => turn.forkResumeAt), ["a1", undefined]);
      assert.equal(refused.result.ok, true);
      assert.equal(refused.result.forkCutMissed, "that reply is not in its session");
      assert.deepEqual(refused.said, ["1:that reply is not in its session"], "said before the whole copy runs");
      // A Claude Code without the flag: the same, said so.
      const unsupported = await claudeForkTurns(projects, { at: "a1" }, [{ ok: false, content: "", error: "error: unknown option '--resume-session-at'" }]);
      assert.deepEqual(unsupported.turns.map((turn) => turn.forkResumeAt), ["a1", undefined]);
      assert.equal(unsupported.result.forkCutMissed, "this Claude Code cannot end a copy at a reply");
      // Any other failure is the turn's own.
      const failed = await claudeForkTurns(projects, { at: "a1" }, [{ ok: false, content: "", error: "Model not found" }]);
      assert.equal(failed.turns.length, 1);
      assert.equal(failed.result.forkCutMissed, undefined);
    } finally {
      await rm(projects, { recursive: true, force: true });
    }
  } finally {
    await rm(compacted, { recursive: true, force: true });
    await rm(empty, { recursive: true, force: true });
  }
});

test("claude: a reply a later compaction kept is the point, with no word; refused after all, the whole session and the compaction said", async () => {
  const kept = JSON.stringify({ type: "system", subtype: "compact_boundary", uuid: "c1", timestamp: "2026-11-21T16:30:00.000Z",
    compactMetadata: { trigger: "manual", preservedMessages: { uuids: ["a2"], allUuids: ["a2"] } } });
  const summary = JSON.stringify({ isSidechain: false, type: "user", uuid: "s1", timestamp: "2026-11-21T16:30:00.100Z", isCompactSummary: true,
    message: { role: "user", content: "This session is being continued from a previous conversation…" } });
  const projects = await claudeProjectsWithTranscript("parent-session", [kept, summary]);
  try {
    const cut = await claudeForkTurns(projects, { at: "a2" });
    assert.equal(cut.turns[0].forkResumeAt, "a2");
    assert.equal(cut.result.forkCutMissed, undefined);
    assert.deepEqual(cut.said, []);
    const refused = await claudeForkTurns(projects, { at: "a2" }, [{ ok: false, content: "", error: "claude warm process exited with code 1: No message found with message.uuid of: a2" }]);
    assert.deepEqual(refused.turns.map((turn) => turn.forkResumeAt), ["a2", undefined]);
    assert.equal(refused.result.forkCutMissed, "its session was compacted after that reply");
    assert.deepEqual(refused.said, ["1:its session was compacted after that reply"]);
  } finally {
    await rm(projects, { recursive: true, force: true });
  }
});

test("claude: when the member's session changed after the reply, the session that reply was in is copied up to it; gone, the member's own, said", async () => {
  const projects = await claudeProjectsWithTranscript("earlier-session");
  await writeFile(path.join(projects, "-repo", "parent-session.jsonl"), await readFile(path.join(projects, "-repo", "earlier-session.jsonl"), "utf8"), "utf8");
  try {
    const earlier = await claudeForkTurns(projects, { at: "a1", sessionId: "earlier-session" });
    assert.deepEqual([earlier.turns[0].forkFromSessionId, earlier.turns[0].forkResumeAt], ["earlier-session", "a1"], "what she saw");
    assert.deepEqual(earlier.said, []);
    const gone = await claudeForkTurns(projects, { at: "a1", sessionId: "lost-session" });
    assert.deepEqual([gone.turns[0].forkFromSessionId, gone.turns[0].forkResumeAt], ["parent-session", undefined]);
    assert.deepEqual(gone.said, ["0:its session changed after its last reply, and that earlier session is gone"]);
  } finally {
    await rm(projects, { recursive: true, force: true });
  }
});

test("claude: a member's session that is not on this device at all is not said to be copied whole: the CLI cannot copy it, and the member starts clean", async () => {
  const empty = await mkdtemp(path.join(tmpdir(), "aa-claude-projects-empty-"));
  const earlierOnly = await claudeProjectsWithTranscript("earlier-session");
  const sourceGone = { ok: false, content: "", error: "claude warm process exited with code 1: No conversation found with session ID: parent-session", forkCopyFailed: true };
  try {
    for (const [label, projects, forkCut] of [
      ["its transcript", empty, { at: "a1" }],
      ["the reply's earlier session and its own", earlierOnly, { at: "a1", sessionId: "lost-session" }]
    ] as const) {
      const failed = await claudeForkTurns(projects, forkCut, [sourceGone]);
      assert.deepEqual(failed.said, [], `${label}: nothing said before the turn`);
      assert.deepEqual([failed.turns[0].forkFromSessionId, failed.turns[0].forkResumeAt], ["parent-session", undefined], label);
      assert.equal(failed.result.forkCutMissed, undefined, `${label}: no copy, nothing it may hold`);
      assert.equal(failed.result.forkCopyFailed, true, label);
    }
    // The CLI found it after all: the whole copy says why, with the turn.
    const made = await claudeForkTurns(empty, { at: "a1" });
    assert.deepEqual(made.said, []);
    assert.equal(made.result.forkCutMissed, "its session file could not be read");
  } finally {
    await rm(empty, { recursive: true, force: true });
    await rm(earlierOnly, { recursive: true, force: true });
  }
});

test("claude: a copy whose point cannot be named says why before the turn when the member's session is here, and nothing when it is not", async () => {
  const projects = await claudeProjectsWithTranscript("parent-session");
  const empty = await mkdtemp(path.join(tmpdir(), "aa-claude-projects-empty-"));
  try {
    const here = await claudeForkTurns(projects, { unknown: "the app found no reply of it that ended a turn" });
    assert.deepEqual(here.said, ["0:the app found no reply of it that ended a turn"]);
    assert.equal(here.turns[0].forkResumeAt, undefined);
    assert.equal(here.result.forkCutMissed, "the app found no reply of it that ended a turn");
    const gone = await claudeForkTurns(empty, { unknown: "the app found no reply of it that ended a turn" },
      [{ ok: false, content: "", error: "claude warm process exited with code 1: No conversation found with session ID: parent-session", forkCopyFailed: true }]);
    assert.deepEqual(gone.said, []);
    assert.equal(gone.result.forkCutMissed, undefined);
  } finally {
    await rm(projects, { recursive: true, force: true });
    await rm(empty, { recursive: true, force: true });
  }
});

/** A Claude Code that runs on stream-json as 2.1.330 does when it forks:
 *  `--resume <source> --fork-session` of a session it cannot load prints
 *  "No conversation found" and exits before it reads a message. */
async function fakeClaudeFork(dir: string): Promise<string> {
  const claudePath = path.join(dir, "claude-fixture");
  await writeFile(claudePath, `#!/usr/bin/env node
const readline = require("node:readline");
const argv = process.argv.slice(2);
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const after = (flag) => argv[argv.indexOf(flag) + 1];
const source = argv.includes("--fork-session") ? after("--resume") : undefined;
const sessionId = after("--session-id") || after("--resume");
if (source === "lost-session") {
  process.stderr.write("No conversation found with session ID: lost-session\\n");
  send({ type: "result", subtype: "error_during_execution", is_error: true, session_id: sessionId, errors: ["No conversation found with session ID: lost-session"] });
  process.exit(1);
}
if (source === "crashing-session") {
  process.stderr.write("Error: something broke while loading\\n");
  process.exit(3);
}
const input = readline.createInterface({ input: process.stdin });
input.on("close", () => process.exit(0));
let lines = 0;
input.on("line", () => {
  lines += 1;
  // A second message into a copy that already started: the process dies.
  if (source === "dies-on-second" && lines === 2) process.exit(1);
  send({ type: "system", subtype: "init", session_id: sessionId });
  if (source === "failing-turn") {
    process.stderr.write("API Error: overloaded\\n");
    process.exit(1);
  }
  send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Copied." }] } });
  send({ type: "result", subtype: "success", result: "Copied.", session_id: sessionId });
});
`, "utf8");
  await chmod(claudePath, 0o755);
  return claudePath;
}

test("claude: a fork whose live process exits before it takes the message reports that the copy was not made; a turn that fails after the copy does not", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aa-claude-fork-warm-"));
  const claudePath = await fakeClaudeFork(dir);
  const run = async (source: string) => {
    const runner = new CliAgentRunner() as any;
    runner.nativeProcessDbPath = path.join(dir, `native-${source}.sqlite3`);
    runner.providerExecutableForRun = async () => claudePath;
    try {
      return await runner.run({ id: "child", kind: "claude-code", label: "@child" }, "Your task.", dir, undefined, "chat", undefined, {
        persistSession: true,
        forkFromSessionId: source,
        agentMode: "default",
        permissions: defaultChatAgentPermissions(),
        warm: { conversationId: "chat", participantId: `child-${source}`, contextKey: "child-context", idleTimeoutMs: 60_000 }
      });
    } finally {
      await runner.shutdownWarmAgents();
    }
  };
  try {
    const gone = await run("lost-session");
    assert.equal(gone.ok, false);
    assert.equal(isForkSourceMissingError(gone.error), true, gone.error);
    assert.equal(gone.forkCopyFailed, true);
    const crashed = await run("crashing-session");
    assert.equal(crashed.ok, false);
    assert.equal(isForkSourceMissingError(crashed.error), false, crashed.error);
    assert.equal(crashed.forkCopyFailed, true, "an unknown failure of the copy");
    const failedTurn = await run("failing-turn");
    assert.equal(failedTurn.ok, false);
    assert.equal(failedTurn.forkCopyFailed, undefined, "the copy was made; the turn failed");
    const copied = await run("parent-session");
    assert.equal(copied.ok, true, JSON.stringify(copied));
    assert.equal(copied.content, "Copied.");
    assert.equal(copied.forkCopyFailed, undefined);
    assert.equal(gone.sessionNotStarted, true);
    // Two messages sent at once share the process: the first made the copy;
    // the second, lost when the process died, is no failed copy.
    const shared = new CliAgentRunner() as any;
    shared.nativeProcessDbPath = path.join(dir, "native-shared.sqlite3");
    shared.providerExecutableForRun = async () => claudePath;
    try {
      const options = { persistSession: true, forkFromSessionId: "dies-on-second", agentMode: "default", permissions: defaultChatAgentPermissions(),
        warm: { conversationId: "chat", participantId: "child-shared", contextKey: "child-context", idleTimeoutMs: 60_000 } };
      const first = await shared.run({ id: "child", kind: "claude-code", label: "@child" }, "First.", dir, undefined, "chat", undefined, options);
      assert.equal(first.ok, true, JSON.stringify(first));
      const second = await shared.run({ id: "child", kind: "claude-code", label: "@child" }, "Second.", dir, undefined, "chat", undefined, options);
      assert.equal(second.ok, false);
      assert.equal(second.forkCopyFailed, undefined, "the copy was made by the first");
      assert.equal(second.sessionNotStarted, undefined);
    } finally {
      await shared.shutdownWarmAgents();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("claude: a reply records the uuid of its last assistant message, not a subagent's", () => {
  const runner = new CliAgentRunner() as any;
  let resolved: any;
  const reply = runner.newClaudeWarmReply({ resolve: (result: unknown) => { resolved = result; }, reject: () => undefined, allowEmptyContent: true });
  reply.started = true;
  // Its usage is known, so the reply ends at once (no session log read).
  reply.usedTokens = 1_000;
  reply.contextWindowTokens = 200_000;
  reply.sessionId = "s-1";
  const state = { replies: [reply], active: reply, cancelRequests: new Map() };
  runner.applyClaudeWarmReplyEvent(reply, { type: "assistant", uuid: "a-1", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "t" }] } });
  runner.applyClaudeWarmReplyEvent(reply, { type: "assistant", uuid: "sub-1", parent_tool_use_id: "t", message: { content: [{ type: "text", text: "sub" }] } });
  runner.applyClaudeWarmReplyEvent(reply, { type: "assistant", uuid: "a-2", message: { content: [{ type: "text", text: "Done." }] } });
  runner.finishClaudeWarmReply(state, reply, "Done.", { type: "result", session_id: "s-1", result: "Done." }, { id: "m", kind: "claude-code", label: "@m" });
  assert.equal(resolved.sessionCut, "a-2");
  assert.equal(resolved.sessionId, "s-1");
});

test("claude: a clean member starts its own session with its role", () => {
  const args = claudeArgs({}, "fresh-session");
  assert.equal(args.includes("--resume"), false);
  assert.equal(args.includes("--fork-session"), false);
  assert.equal(args[args.indexOf("--session-id") + 1], "fresh-session");
  assert.equal(args[args.indexOf("--agent") + 1], "accordagents-child");
});

test("codex: fork params carry the member's own settings, as a resume does", () => {
  const runner = new CliAgentRunner() as any;
  const options = {
    agentMode: "default",
    permissions: { ...defaultChatAgentPermissions(), workspaceWrite: true, webAccess: true },
    role,
    persistSession: true
  };
  const participant = { id: "child", kind: "codex-cli", label: "@child", model: "gpt-5", reasoningEffort: "high" };
  const fork = runner.codexAppServerThreadForkParams("parent-thread", participant, "/repo", "chat", options);
  const resume = runner.codexAppServerThreadResumeParams("parent-thread", participant, "/repo", "chat", options);
  assert.equal(fork.threadId, "parent-thread");
  assert.equal(fork.ephemeral, false);
  for (const key of ["model", "cwd", "approvalPolicy", "approvalsReviewer", "sandbox", "config", "developerInstructions"]) {
    assert.deepEqual(fork[key], resume[key], key);
  }
  assert.equal(fork.sandbox, "workspace-write");
  assert.equal(fork.developerInstructions, "You are @child.");
});

async function writeCodexAppServerFixture(fixtureDir: string, source: string): Promise<string> {
  await writeFile(path.join(fixtureDir, "app-server"), source, "utf8");
  return process.execPath;
}

/** A fake codex app-server that records the methods it was asked, answers a
 *  fork with `forkId` and finishes every turn. */
function fakeCodexAppServer(logPath: string, forkId: string, sourceTurns: Array<Record<string, unknown>> = [], failTurns = false): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const rl = readline.createInterface({ input: process.stdin });
const sourceTurns = ${JSON.stringify(sourceTurns)};
let thread = "";
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method) fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ method: message.method, params: message.params }) + "\\n");
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex", platformFamily: "unix", platformOsName: "macos", platformArch: "arm64" } });
    return;
  }
  if (message.method === "thread/turns/list") {
    if (message.params.threadId === "lost-thread") {
      send({ id: message.id, error: { code: -32600, message: "thread not loaded: lost-thread" } });
      return;
    }
    // Newest first, two at a time, as Codex 0.155.1 pages them.
    const start = message.params.cursor ? Number(message.params.cursor) : 0;
    const page = sourceTurns.slice(start, start + 2);
    send({ id: message.id, result: { data: page, nextCursor: start + 2 < sourceTurns.length ? String(start + 2) : null } });
    return;
  }
  if (message.method === "thread/fork") {
    if (message.params.threadId === "lost-thread") {
      send({ id: message.id, error: { code: -32600, message: "no rollout found for thread id lost-thread" } });
      return;
    }
    if (message.params.threadId === "broken-thread") {
      send({ id: message.id, error: { code: -32603, message: "failed to read rollout: unexpected end of file" } });
      return;
    }
    if (message.params.lastTurnId && !sourceTurns.some((turn) => turn.id === message.params.lastTurnId)) {
      send({ id: message.id, error: { code: -32600, message: "turn not found: " + message.params.lastTurnId } });
      return;
    }
    thread = ${JSON.stringify(forkId)};
    send({ id: message.id, result: { thread: { id: thread }, model: "gpt-5" } });
    return;
  }
  if (message.method === "thread/start" || message.method === "thread/resume") {
    thread = message.params.threadId || "fresh-thread";
    send({ id: message.id, result: { thread: { id: thread }, model: "gpt-5" } });
    return;
  }
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-1" } } });
    send({ method: "item/completed", params: { threadId: thread, turnId: "turn-1", item: { id: "agent-1", type: "agentMessage", text: "Forked." } } });
    send({ method: "turn/completed", params: { threadId: thread, turn: { id: "turn-1", status: ${failTurns ? '"failed", error: { message: "The model is overloaded." }' : '"completed"'} } } });
  }
});
`;
}

async function runForkedCodexTurn(
  forkId: string,
  cut: { forkCut?: Record<string, unknown>; sourceTurns?: Array<Record<string, unknown>>; failTurns?: boolean; source?: string; said?: string[] } = {}
): Promise<{ result: any; sessionIds: string[]; methods: Array<{ method: string; params: any }> }> {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-codex-fork-"));
  const logPath = path.join(fixtureDir, "methods.jsonl");
  const codexPath = await writeCodexAppServerFixture(fixtureDir, fakeCodexAppServer(logPath, forkId, cut.sourceTurns, cut.failTurns));
  const runner = new CliAgentRunner(undefined, undefined, codexPath) as any;
  const sessionIds: string[] = [];
  try {
    const result = await runner.runCodexAppServerWarmOrOneShot(
      { id: "child", kind: "codex-cli", label: "@child" },
      "Your task.",
      fixtureDir,
      undefined,
      "chat",
      undefined,
      {
        persistSession: true,
        forkFromSessionId: cut.source ?? "parent-thread",
        ...(cut.forkCut ? { forkCut: cut.forkCut } : {}),
        onForkCutMissed: (reason: string) => cut.said?.push(reason),
        agentMode: "default",
        permissions: defaultChatAgentPermissions(),
        role,
        onSessionId: (id: string) => sessionIds.push(id),
        warm: { conversationId: "chat", participantId: "child", contextKey: "child-context", idleTimeoutMs: 60_000 }
      }
    );
    const methods = (await readFile(logPath, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    return { result, sessionIds, methods };
  } finally {
    await runner.shutdownWarmAgents();
    await rm(fixtureDir, { recursive: true, force: true });
  }
}

test("codex: the first turn of a fork asks thread/fork of the source and reports the copy's id", async () => {
  const { result, sessionIds, methods } = await runForkedCodexTurn("child-thread");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.content, "Forked.");
  const names = methods.map((item) => item.method);
  assert.deepEqual(names.filter((name) => name.startsWith("thread/")), ["thread/fork"], "no thread/start or thread/resume");
  const fork = methods.find((item) => item.method === "thread/fork")!;
  assert.equal(fork.params.threadId, "parent-thread");
  assert.equal(fork.params.developerInstructions, "You are @child.");
  assert.equal(methods.find((item) => item.method === "turn/start")!.params.threadId, "child-thread");
  assert.deepEqual([...new Set(sessionIds)], ["child-thread"], "the member's own id, never the source's");
});

// The source thread's turns, newest first, as Codex 0.155.1 lists them
// (UUIDv7 ids made when each turn started; seconds for its times).
const SOURCE_TURNS = [
  { id: "01a1feed-5a00-7000-8000-000000000003", status: "inProgress", startedAt: 1795278330, completedAt: null, items: [] },
  { id: "01a1feed-46a3-71b1-91a2-bdb954f85164", status: "completed", startedAt: 1795278325, completedAt: 1795278327, items: [] },
  { id: "01a1feed-3311-7760-8525-235aaa841192", status: "completed", startedAt: 1795278320, completedAt: 1795278325, items: [] }
];

test("codex: Fork to new chat forks only through the turn of the reply the User saw (lastTurnId) and records each turn's id", async () => {
  const { result, methods } = await runForkedCodexTurn("child-thread", { forkCut: { at: "01a1feed-3311-7760-8525-235aaa841192" }, sourceTurns: SOURCE_TURNS });
  assert.equal(result.ok, true, JSON.stringify(result));
  const fork = methods.find((item) => item.method === "thread/fork")!;
  assert.equal(fork.params.lastTurnId, "01a1feed-3311-7760-8525-235aaa841192");
  assert.equal(methods.some((item) => item.method === "thread/turns/list"), false, "a recorded turn is used as it is");
  assert.equal(result.forkCutMissed, undefined);
  assert.equal(result.sessionCut, "turn-1", "where the copy's own session stands when its reply ends");
});

test("codex: a reply from before its turn was recorded is matched to the last turn that started before it finished, a page at a time", async () => {
  const { result, methods } = await runForkedCodexTurn("child-thread", { forkCut: { finishedBy: "2026-11-21T16:25:25.409Z" }, sourceTurns: SOURCE_TURNS });
  assert.equal(result.ok, true, JSON.stringify(result));
  const lists = methods.filter((item) => item.method === "thread/turns/list");
  assert.deepEqual(lists.map((item) => [item.params.threadId, item.params.sortDirection, item.params.itemsView, item.params.cursor ?? null]),
    [["parent-thread", "desc", "notLoaded", null], ["parent-thread", "desc", "notLoaded", "2"]]);
  assert.equal(methods.find((item) => item.method === "thread/fork")!.params.lastTurnId, "01a1feed-3311-7760-8525-235aaa841192");
  // The newest finished turn is the reply's own: nothing after it but a turn still running.
  const latest = await runForkedCodexTurn("child-thread", { forkCut: { finishedBy: "2026-11-21T16:25:28.000Z" }, sourceTurns: SOURCE_TURNS });
  assert.equal(latest.methods.find((item) => item.method === "thread/fork")!.params.lastTurnId, "01a1feed-46a3-71b1-91a2-bdb954f85164", "the running turn is left out");
  const finished = SOURCE_TURNS.slice(1);
  const whole = await runForkedCodexTurn("child-thread", { forkCut: { finishedBy: "2026-11-21T16:25:28.000Z" }, sourceTurns: finished });
  assert.equal(whole.methods.find((item) => item.method === "thread/fork")!.params.lastTurnId, "01a1feed-46a3-71b1-91a2-bdb954f85164",
    "nothing came after it: all of it, and a turn the member starts meanwhile stays out");
  assert.equal(whole.result.forkCutMissed, undefined);
});

test("codex: a turn Codex does not know copies the whole thread and says why; so does a reply older than every turn there", async () => {
  const refused = await runForkedCodexTurn("child-thread", { forkCut: { at: "01a1feed-0000-7000-8000-00000000dead" }, sourceTurns: SOURCE_TURNS });
  assert.equal(refused.result.ok, true, JSON.stringify(refused.result));
  assert.deepEqual(refused.methods.filter((item) => item.method === "thread/fork").map((item) => item.params.lastTurnId ?? null),
    ["01a1feed-0000-7000-8000-00000000dead", null]);
  assert.equal(refused.result.forkCutMissed, "that reply is not in its session");
  // The copy is made even when the turn then fails: it says so too.
  const failed = await runForkedCodexTurn("child-thread", { forkCut: { at: "01a1feed-0000-7000-8000-00000000dead" }, sourceTurns: SOURCE_TURNS, failTurns: true });
  assert.equal(failed.result.ok, false);
  assert.equal(failed.result.forkCutMissed, "that reply is not in its session");
  const before = await runForkedCodexTurn("child-thread", { forkCut: { finishedBy: "2026-11-21T16:00:00.000Z" }, sourceTurns: SOURCE_TURNS });
  assert.equal(before.methods.find((item) => item.method === "thread/fork")!.params.lastTurnId, undefined);
  assert.equal(before.result.forkCutMissed, "none of its session's turns ended by that reply");
});

test("codex: when the member's thread changed after the reply, the thread that reply was in is forked through it; gone, the member's own, said", async () => {
  const turn = "01a1feed-3311-7760-8525-235aaa841192";
  const earlier = await runForkedCodexTurn("child-thread", { forkCut: { at: turn, sessionId: "earlier-thread" }, sourceTurns: SOURCE_TURNS });
  assert.equal(earlier.result.ok, true, JSON.stringify(earlier.result));
  assert.deepEqual(earlier.methods.filter((item) => item.method === "thread/fork").map((item) => [item.params.threadId, item.params.lastTurnId ?? null]),
    [["earlier-thread", turn]], "what she saw");
  assert.equal(earlier.result.forkCutMissed, undefined);
  const gone = await runForkedCodexTurn("child-thread", { forkCut: { at: turn, sessionId: "lost-thread" }, sourceTurns: SOURCE_TURNS });
  assert.equal(gone.result.ok, true, JSON.stringify(gone.result));
  assert.deepEqual(gone.methods.filter((item) => item.method === "thread/fork").map((item) => [item.params.threadId, item.params.lastTurnId ?? null]),
    [["lost-thread", turn], ["parent-thread", null]]);
  assert.equal(gone.result.forkCutMissed, "its session changed after its last reply, and that earlier session is gone");
});

test("codex: a fork whose copy Codex did not make says so (forkCopyFailed), and never that the copy may hold more", async () => {
  const said: string[] = [];
  const gone = await runForkedCodexTurn("child-thread", { source: "lost-thread", forkCut: { finishedBy: "2026-11-21T16:25:25.409Z" }, said });
  assert.equal(gone.result.ok, false);
  assert.equal(isForkSourceMissingError(gone.result.error), true, gone.result.error);
  assert.equal(gone.result.forkCopyFailed, true);
  assert.equal(gone.result.forkCutMissed, undefined, "no copy, nothing it may hold");
  assert.deepEqual(said, [], "its turns could not be listed, but nothing is said before the copy is made");
  assert.equal(gone.methods.some((item) => item.method === "turn/start"), false);
  const broken = await runForkedCodexTurn("child-thread", { source: "broken-thread" });
  assert.equal(broken.result.ok, false);
  assert.equal(isForkSourceMissingError(broken.result.error), false);
  assert.equal(broken.result.forkCopyFailed, true, "an unknown failure of the copy");
  // A copy made whole is said once it is made, before the turn.
  const madeSaid: string[] = [];
  const made = await runForkedCodexTurn("child-thread", { forkCut: { at: "01a1feed-0000-7000-8000-00000000dead" }, sourceTurns: SOURCE_TURNS, said: madeSaid });
  assert.equal(made.result.ok, true);
  assert.deepEqual(madeSaid, ["that reply is not in its session"]);
  // No point named: said once the copy is made; not at all when the thread is gone.
  const unknownSaid: string[] = [];
  const unknown = await runForkedCodexTurn("child-thread", { forkCut: { unknown: "the app found no reply of it that ended a turn" }, said: unknownSaid });
  assert.equal(unknown.result.ok, true);
  assert.deepEqual(unknownSaid, ["the app found no reply of it that ended a turn"]);
  assert.equal(unknown.methods.find((item) => item.method === "thread/fork")!.params.lastTurnId, undefined);
  const lostSaid: string[] = [];
  const lost = await runForkedCodexTurn("child-thread", { source: "lost-thread", forkCut: { unknown: "the app found no reply of it that ended a turn" }, said: lostSaid });
  assert.equal(lost.result.forkCopyFailed, true);
  assert.deepEqual(lostSaid, []);
  // A turn that fails after the copy was made is the turn's own.
  const failed = await runForkedCodexTurn("child-thread", { failTurns: true });
  assert.equal(failed.result.ok, false);
  assert.equal(failed.result.forkCopyFailed, undefined);
});

test("codex: a fork answered with the source's own id is refused, so the member never writes to it", async () => {
  const { result, sessionIds, methods } = await runForkedCodexTurn("parent-thread");
  assert.equal(result.ok, false);
  assert.equal(result.forkCopyFailed, true, "no copy was made: the turn tries again, then starts clean");
  assert.equal(sessionIds.includes("parent-thread"), false);
  assert.equal(methods.some((item) => item.method === "turn/start"), false);
});

test("a fork's source is missing only by the CLIs' own words for it, not by any other \"not found\"", () => {
  assert.equal(isForkSourceMissingError("No conversation found with session ID: 8c1f0a6e-5c1b-4a8e-9f00-1b2c3d4e5f60"), true);
  assert.equal(isForkSourceMissingError("thread/fork failed: no rollout found for thread id 019a-parent"), true);
  for (const other of ["Model not found: gpt-unknown", "File not found: src/app.ts", "MCP server not found", "session does not exist yet", undefined]) {
    assert.equal(isForkSourceMissingError(other), false, String(other));
  }
});

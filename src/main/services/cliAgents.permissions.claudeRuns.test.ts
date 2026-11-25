import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { cliDependencies, cliParts } from "./cliAgents/test/cliParts";
import { defaultChatAgentPermissions } from "../../shared/agentPermissions";
import { assertFixtureProcessStops, makeRunner, testProcessExists, writeClaudeCompactionFixture } from "./cliAgents/test/runnerFixtures";

// Claude Code's own config on this computer (Claude in Chrome, for one) must
// not decide these tests: an empty config folder is a fresh Claude Code.
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), "aa-claude-config-"));

test("Claude public warm-run path: background work outlives the reply, the next message and a Stop, and its result arrives as a new reply", { timeout: 15_000 }, async () => {
  if (process.platform === "win32") {
    return;
  }
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-claude-background-warm-"));
  const claudePath = path.join(fixtureDir, "claude-fixture");
  const processPidsFile = path.join(fixtureDir, "process-pids.txt");
  const helperPidFile = path.join(fixtureDir, "helper.pid");
  const stdinLog = path.join(fixtureDir, "stdin.jsonl");
  // Mirrors Claude Code 2.1.280 on stream-json: uuid-stamped messages get a
  // command lifecycle, an interrupt ends only the running step with
  // error_during_execution, and a finished background task makes the CLI
  // start a step on its own.
  await writeFile(claudePath, `#!/usr/bin/env node
const { appendFileSync, writeFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const readline = require("node:readline");
appendFileSync(${JSON.stringify(processPidsFile)}, String(process.pid) + "\\n");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
let helper;
let messages = 0;
let running;
const input = readline.createInterface({ input: process.stdin });
input.on("close", () => {
  if (helper) helper.kill("SIGTERM");
  process.exit(0);
});
input.on("line", (line) => {
  appendFileSync(${JSON.stringify(stdinLog)}, line + "\\n");
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: { still_queued: [] } } });
    if (message.request.subtype === "interrupt" && running) {
      send({ type: "result", subtype: "error_during_execution", is_error: true });
      send({ type: "command_lifecycle", command_uuid: running, state: "cancelled" });
      running = undefined;
    }
    return;
  }
  messages += 1;
  const uuid = message.uuid;
  send({ type: "command_lifecycle", command_uuid: uuid, state: "queued" });
  send({ type: "command_lifecycle", command_uuid: uuid, state: "started" });
  send({ type: "system", subtype: "init", session_id: "fixture-session" });
  if (messages === 1) {
    helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    writeFileSync(${JSON.stringify(helperPidFile)}, String(helper.pid));
    send({ type: "system", subtype: "task_started", task_id: "task-1", description: "fixture background task", is_backgrounded: true });
    send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Started." }] } });
    send({ type: "result", subtype: "success", result: "Started." });
    send({ type: "command_lifecycle", command_uuid: uuid, state: "completed" });
    return;
  }
  if (messages === 2) {
    running = uuid;
    send({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Working on it" } } });
    send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Working on it" }] } });
    return;
  }
  send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Third." }] } });
  send({ type: "result", subtype: "success", result: "Third." });
  send({ type: "command_lifecycle", command_uuid: uuid, state: "completed" });
  setTimeout(() => {
    helper.kill("SIGTERM");
    helper = undefined;
    send({ type: "system", subtype: "background_tasks_changed", tasks: [] });
    send({ type: "system", subtype: "task_notification", task_id: "task-1", status: "completed" });
    send({ type: "system", subtype: "init", session_id: "fixture-session" });
    send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Background done." }] } });
    send({ type: "result", subtype: "success", result: "Background done." });
  }, 100);
});
`, "utf8");
  await chmod(claudePath, 0o755);

  const runner = makeRunner() as any;
  cliDependencies(runner).nativeProcessDbPath = path.join(fixtureDir, "native-processes.sqlite3");
  cliParts(runner).cliRuns.providerExecutableForRun = async () => claudePath;
  const participant = { id: "claude-background", kind: "claude-code", label: "Claude" };
  const selfResumed: any[] = [];
  let markSelfResumed!: () => void;
  const selfResumedSeen = new Promise<void>((resolve) => { markSelfResumed = resolve; });
  let repliesStarted = 0;
  const backgroundReports: string[][] = [];
  const warm = {
    conversationId: "conversation-background",
    participantId: participant.id,
    contextKey: "context-background",
    idleTimeoutMs: 60_000,
    onReplyStarted: () => { repliesStarted += 1; },
    onBackgroundTasksChanged: (tasks: any[]) => { backgroundReports.push(tasks.map((task) => `${task.label}@${task.origin?.messageId}`)); },
    origin: { runId: "run-1", messageId: "reply-1" },
    onSelfResumedTurn: (turn: any) => {
      selfResumed.push(turn);
      markSelfResumed();
    }
  };
  let helperPid: number | undefined;
  try {
    const firstOutputs: Array<{ text: string }> = [];
    const first = await runner.run(participant, "Start work.", fixtureDir, undefined, "chat", undefined, {
      agentMode: "default",
      warm,
      onOutput: (event: { text: string }) => firstOutputs.push(event)
    });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.content, "Started.", "the reply ends at its result");
    assert.equal(repliesStarted, 1, "a fresh process is announced once, before it starts");
    assert.ok(firstOutputs.some((event) => /Running in the background: fixture background task/.test(event.text)));
    helperPid = Number.parseInt((await readFile(helperPidFile, "utf8")).trim(), 10);
    assert.equal(testProcessExists(helperPid), true);
    assert.equal(runner.hasActiveNativeWork(), true, "native background work keeps the machine busy");
    assert.equal(runner.fenceIdleNativeAdmissions(), undefined);

    const controller = new AbortController();
    let markWorking!: () => void;
    const working = new Promise<void>((resolve) => { markWorking = resolve; });
    const secondRun = runner.run(participant, "Do a long step.", fixtureDir, undefined, "chat", controller.signal, {
      agentMode: "default",
      warm: { ...warm, origin: { runId: "run-2", messageId: "reply-2" } },
      onOutput: (event: { kind: string; text: string }) => {
        if (event.kind === "tool" || /Working on it/.test(event.text)) markWorking();
      }
    });
    // Stop only once the step is visibly running, as a user would.
    await working;
    controller.abort(new Error("Stopped by user."));
    const second = await secondRun;
    assert.equal(second.ok, false, "a stopped reply does not succeed");
    const control = (await readFile(stdinLog, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line))
      .find((message) => message.type === "control_request");
    assert.equal(control?.request?.subtype, "interrupt", "Stop interrupts the step instead of closing the process");
    assert.equal(testProcessExists(helperPid), true, "Stop keeps the background work");

    const third = await runner.run(participant, "Anything else?", fixtureDir, undefined, "chat", undefined, {
      agentMode: "default",
      warm: { ...warm, origin: { runId: "run-3", messageId: "reply-3" } }
    });
    assert.equal(third.content, "Third.");
    assert.equal(repliesStarted, 3, "on a live process each message is announced when the CLI takes it");
    const processPids = (await readFile(processPidsFile, "utf8")).trim().split(/\r?\n/).map(Number);
    assert.equal(processPids.length, 1, "every message went to the same live process");

    await selfResumedSeen;
    assert.deepEqual(selfResumed[0].origin, { runId: "run-1", messageId: "reply-1" }, "the finished work names the reply that started it");
    const outputs: Array<{ text: string }> = [];
    const continuation = await selfResumed[0].attach({ onOutput: (event: { text: string }) => outputs.push(event) });
    assert.equal(continuation.ok, true);
    assert.equal(continuation.content, "Background done.");
    assert.ok(outputs.some((event) => /Background task finished: fixture background task/.test(event.text)));
    assert.deepEqual(backgroundReports, [["fixture background task@reply-1"], []],
      "the member's background work is reported once when it starts, with the reply that started it, and once when it ends");
    await assertFixtureProcessStops(helperPid);
  } finally {
    await runner.shutdownWarmAgents();
    if (helperPid && testProcessExists(helperPid)) {
      process.kill(helperPid, "SIGKILL");
    }
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("Claude Code's own modes: a new mode is set in the member's live process before its message goes in, as Shift+Tab sets it, and the process stays", { timeout: 15_000 }, async () => {
  if (process.platform === "win32") {
    return;
  }
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-claude-mode-warm-"));
  const claudePath = path.join(fixtureDir, "claude-fixture");
  const launches = path.join(fixtureDir, "launches.jsonl");
  const stdinLog = path.join(fixtureDir, "stdin.jsonl");
  const refuseOnce = path.join(fixtureDir, "refuse-once");
  const answerManual = path.join(fixtureDir, "answer-manual");
  // Mirrors Claude Code 2.1.330 on stream-json: set_permission_mode answers
  // with the mode and a system/status that carries it; system/init says the
  // mode a step runs in; an account without auto mode is refused with the
  // binary's words and code (auto_mode_unavailable).
  await writeFile(claudePath, `#!/usr/bin/env node
const { appendFileSync, existsSync, rmSync } = require("node:fs");
const readline = require("node:readline");
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(launches)}, JSON.stringify({ pid: process.pid, mode: argv[argv.indexOf("--permission-mode") + 1] }) + "\\n");
let mode = argv[argv.indexOf("--permission-mode") + 1];
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const input = readline.createInterface({ input: process.stdin });
input.on("close", () => process.exit(0));
input.on("line", (line) => {
  const message = JSON.parse(line);
  appendFileSync(${JSON.stringify(stdinLog)}, JSON.stringify({ pid: process.pid, type: message.type, request: message.request, text: message.message && message.message.content[0].text }) + "\\n");
  if (message.type === "control_request") {
    if (message.request.subtype === "set_permission_mode" && message.request.mode === "auto") {
      send({ type: "control_response", response: { subtype: "error", request_id: message.request_id, error: "Cannot set permission mode to auto: auto mode is not available for this account", code: "auto_mode_unavailable" } });
      return;
    }
    if (message.request.subtype === "set_permission_mode" && existsSync(${JSON.stringify(refuseOnce)})) {
      rmSync(${JSON.stringify(refuseOnce)});
      send({ type: "control_response", response: { subtype: "error", request_id: message.request_id, error: "Mode change is not possible right now" } });
      return;
    }
    if (message.request.subtype === "set_permission_mode" && existsSync(${JSON.stringify(answerManual)})) {
      send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: { mode: "default" } } });
      return;
    }
    if (message.request.subtype === "set_permission_mode") mode = message.request.mode;
    send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: { mode } } });
    send({ type: "system", subtype: "status", status: null, permissionMode: mode });
    return;
  }
  const uuid = message.uuid;
  send({ type: "command_lifecycle", command_uuid: uuid, state: "started" });
  send({ type: "system", subtype: "init", session_id: "mode-session", permissionMode: mode });
  // A plan the User approved: the CLI leaves Plan mode on its own.
  if (/approve the plan/.test(message.message.content[0].text)) {
    mode = "default";
    send({ type: "system", subtype: "status", status: null, permissionMode: mode });
  }
  send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "In " + mode + "." }] } });
  send({ type: "result", subtype: "success", result: "In " + mode + "." });
  send({ type: "command_lifecycle", command_uuid: uuid, state: "completed" });
});
`, "utf8");
  await chmod(claudePath, 0o755);

  const runner = makeRunner() as any;
  cliDependencies(runner).nativeProcessDbPath = path.join(fixtureDir, "native-processes.sqlite3");
  cliParts(runner).cliRuns.providerExecutableForRun = async () => claudePath;
  const participant = { id: "claude-mode", kind: "claude-code", label: "@claude" };
  const warm = { conversationId: "conversation-mode", participantId: participant.id, contextKey: "context-mode", idleTimeoutMs: 60_000 };
  const own = (agentMode: "default" | "plan" | "auto", workspaceWrite: boolean) => ({
    agentMode,
    permissions: { ...defaultChatAgentPermissions(), workspaceWrite, cliApprovals: true as const }
  });
  const stdin = async () => (await readFile(stdinLog, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const pids = async () => (await readFile(launches, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const controlsSince = async (from: number) => (await stdin()).slice(from).filter((entry) => entry.type === "control_request").map((entry) => entry.request);
  try {
    const first = await runner.run(participant, "one", fixtureDir, undefined, "chat", undefined, { ...own("default", false), warm });
    assert.equal(first.content, "In default.");
    assert.deepEqual((await pids()).map((launch) => launch.mode), ["default"]);
    assert.deepEqual(await controlsSince(0), [], "started in its mode: nothing to switch");

    // Accept edits now: switched first, then the message, in that order.
    let seen = (await stdin()).length;
    const second = await runner.run(participant, "two", fixtureDir, undefined, "chat", undefined, { ...own("default", true), warm });
    assert.equal(second.content, "In acceptEdits.");
    const written = (await stdin()).slice(seen);
    assert.deepEqual(written.map((entry) => entry.type === "control_request" ? `${entry.request.subtype}:${entry.request.mode}` : entry.text),
      ["set_permission_mode:acceptEdits", "two"]);

    // The User's menu mid-turn (ChatService through memberClaudeControl) is
    // remembered: the next message in that mode switches nothing.
    assert.deepEqual(await runner.memberClaudeControl(warm.conversationId, participant.id, { subtype: "set_permission_mode", mode: "plan" }, 5_000), { mode: "plan" });
    seen = (await stdin()).length;
    // A run that read the member as Accept edits before she picked Plan goes
    // in with her Plan (warm.permissionMode).
    const third = await runner.run(participant, "three", fixtureDir, undefined, "chat", undefined, { ...own("default", true), warm: { ...warm, permissionMode: () => "plan" } });
    assert.equal(third.content, "In plan.");
    assert.deepEqual(await controlsSince(seen), [], "already in Plan");

    // The CLI left Plan itself (an approved plan): the next Plan message
    // switches it back, since the process says where it is.
    await runner.run(participant, "approve the plan", fixtureDir, undefined, "chat", undefined, { ...own("plan", false), warm });
    seen = (await stdin()).length;
    const fifth = await runner.run(participant, "five", fixtureDir, undefined, "chat", undefined, { ...own("plan", false), warm });
    assert.equal(fifth.content, "In plan.");
    assert.deepEqual(await controlsSince(seen), [{ subtype: "set_permission_mode", mode: "plan" }]);
    assert.equal((await pids()).length, 1, "every mode change kept the one live process");

    // Auto refused for the account: the message is not sent in another mode,
    // the turn says why in the CLI's words, and a new process (which would
    // be refused too) is not started.
    seen = (await stdin()).length;
    const refused = await runner.run(participant, "six", fixtureDir, undefined, "chat", undefined, { ...own("auto", false), warm });
    assert.equal(refused.ok, false);
    assert.equal(refused.content, "Claude Code's auto mode is not available for @claude (Cannot set permission mode to auto: auto mode is not available for this account), so the message was not sent. Choose another mode for @claude.");
    assert.equal((await stdin()).slice(seen).some((entry) => entry.type === "user"), false, "the message did not go in");
    assert.equal((await pids()).length, 1, "the process stays: a new one would be refused too");

    // Refused for another reason while nothing runs in it: a process started
    // in the member's mode takes the message, which goes on.
    await writeFile(refuseOnce, "");
    const seventh = await runner.run(participant, "seven", fixtureDir, undefined, "chat", undefined, { ...own("default", true), warm });
    assert.equal(seventh.ok, true, JSON.stringify(seventh));
    assert.equal(seventh.content, "In acceptEdits.");
    assert.deepEqual((await pids()).map((launch) => launch.mode), ["default", "acceptEdits"], "a fresh process, started in the member's mode");

    // The CLI says it switched to another mode: the message is not sent.
    await writeFile(answerManual, "");
    seen = (await stdin()).length;
    const other = await runner.run(participant, "eight", fixtureDir, undefined, "chat", undefined, { ...own("plan", false), warm });
    assert.equal(other.content, "Claude Code switched @claude to Manual instead of Plan, so the message was not sent.");
    assert.equal((await stdin()).slice(seen).some((entry) => entry.type === "user"), false);
    await rm(answerManual);

    // A classic member's mode is its process's (another mode is another
    // process): nothing is switched in a live one.
    seen = (await stdin()).length;
    await runner.run(participant, "classic", fixtureDir, undefined, "chat", undefined, { agentMode: "default", permissions: { ...defaultChatAgentPermissions(), workspaceWrite: true }, warm });
    assert.deepEqual(await controlsSince(seen), []);
  } finally {
    await runner.shutdownWarmAgents();
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("Claude Code's own modes: a mode the CLI moves to itself (an approved plan) is reported to the member's chat; the app's own switches and the CLI's start are not", { timeout: 15_000 }, async () => {
  if (process.platform === "win32") {
    return;
  }
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-claude-plan-mode-"));
  const claudePath = path.join(fixtureDir, "claude-fixture");
  // Claude Code 2.1.330 on stream-json: set_permission_mode answers with the
  // mode and a system/status carrying it; a plan the User approved with "Yes,
  // auto-accept edits" (setMode acceptEdits) moves the session itself and
  // says so on system/status.
  await writeFile(claudePath, `#!/usr/bin/env node
const readline = require("node:readline");
const argv = process.argv.slice(2);
let mode = argv[argv.indexOf("--permission-mode") + 1];
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const input = readline.createInterface({ input: process.stdin });
input.on("close", () => process.exit(0));
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    if (message.request.subtype === "set_permission_mode") mode = message.request.mode;
    // The status first, then the answer: the app's own switch either way.
    send({ type: "system", subtype: "status", status: null, permissionMode: mode });
    send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: { mode } } });
    return;
  }
  const uuid = message.uuid;
  send({ type: "command_lifecycle", command_uuid: uuid, state: "started" });
  send({ type: "system", subtype: "init", session_id: "plan-session", permissionMode: mode });
  if (/approve the plan/.test(message.message.content[0].text)) {
    mode = "acceptEdits";
    send({ type: "system", subtype: "status", status: null, permissionMode: mode });
  }
  send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "In " + mode + "." }] } });
  send({ type: "result", subtype: "success", result: "In " + mode + "." });
  send({ type: "command_lifecycle", command_uuid: uuid, state: "completed" });
});
`, "utf8");
  await chmod(claudePath, 0o755);

  const runner = makeRunner() as any;
  cliDependencies(runner).nativeProcessDbPath = path.join(fixtureDir, "native-processes.sqlite3");
  cliParts(runner).cliRuns.providerExecutableForRun = async () => claudePath;
  const participant = { id: "claude-plan", kind: "claude-code", label: "@claude" };
  const moved: string[] = [];
  const warm = {
    conversationId: "conversation-plan",
    participantId: participant.id,
    contextKey: "context-plan",
    idleTimeoutMs: 60_000,
    onCliPermissionMode: (mode: string) => moved.push(mode)
  };
  const own = (agentMode: "default" | "plan" | "auto", workspaceWrite: boolean) => ({
    agentMode,
    permissions: { ...defaultChatAgentPermissions(), workspaceWrite, cliApprovals: true as const }
  });
  try {
    const first = await runner.run(participant, "plan it", fixtureDir, undefined, "chat", undefined, { ...own("plan", false), warm });
    assert.equal(first.content, "In plan.");
    assert.deepEqual(moved, [], "its start is not a switch");
    assert.equal(runner.memberClaudeAutoModeAvailable(warm.conversationId, participant.id), false, "auto mode not known yet");

    const approved = await runner.run(participant, "approve the plan", fixtureDir, undefined, "chat", undefined, { ...own("plan", false), warm });
    assert.equal(approved.content, "In acceptEdits.");
    assert.deepEqual(moved, ["acceptEdits"], "the CLI's own switch reaches the chat");

    // The app's switches (the User's menu, a turn's alignment) are not the CLI's.
    assert.deepEqual(await runner.memberClaudeControl(warm.conversationId, participant.id, { subtype: "set_permission_mode", mode: "default" }, 5_000), { mode: "default" });
    const aligned = await runner.run(participant, "go", fixtureDir, undefined, "chat", undefined, { ...own("plan", false), warm });
    assert.equal(aligned.content, "In plan.");
    assert.deepEqual(moved, ["acceptEdits"], "nothing more");

    // The CLI ran in auto mode itself: the account has it.
    assert.deepEqual(await runner.memberClaudeControl(warm.conversationId, participant.id, { subtype: "set_permission_mode", mode: "auto" }, 5_000), { mode: "auto" });
    assert.equal(runner.memberClaudeAutoModeAvailable(warm.conversationId, participant.id), true);
    assert.deepEqual(moved, ["acceptEdits"]);
  } finally {
    await runner.shutdownWarmAgents();
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("Claude's context after a turn of tool calls and a subagent is its last main-thread call, as /context reports it", { timeout: 15_000 }, async () => {
  if (process.platform === "win32") return;
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-claude-context-turn-"));
  const { claudePath } = await writeClaudeCompactionFixture(fixtureDir);
  const runner = makeRunner() as any;
  cliDependencies(runner).nativeProcessDbPath = path.join(fixtureDir, "native-processes.sqlite3");
  cliParts(runner).cliRuns.providerExecutableForRun = async () => claudePath;
  const participant = { id: "claude-context", kind: "claude-code", label: "Claude", model: "sonnet" };
  const warm = { conversationId: "conversation-context", participantId: participant.id, contextKey: "context-turn", idleTimeoutMs: 60_000 };
  try {
    const reply = await runner.run(participant, "Work with tools.", fixtureDir, undefined, "chat", undefined, { agentMode: "default", warm, sessionId: "fixture-session" });
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.equal(reply.contextUsage?.usedTokens, 62995,
      "the last main-thread call (what /context shows), not the result's sum of every call (303,995) nor the subagent's 150k");
    assert.equal(reply.contextUsage?.contextWindowTokens, 1000000, "the main model's window from the result, not the subagent model's 200k");
    assert.equal(reply.contextUsage?.percentage, 6);
    assert.equal(reply.contextUsage?.model, "claude-sonnet-5-5");
  } finally {
    await runner.shutdownWarmAgents();
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("Claude public warm-run path: without the CLI's command lifecycle, a second message waits for the first reply, and Stop drops it before it is sent", { timeout: 15_000 }, async () => {
  if (process.platform === "win32") {
    return;
  }
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-claude-nolifecycle-"));
  const claudePath = path.join(fixtureDir, "claude-fixture");
  const stdinLog = path.join(fixtureDir, "stdin.jsonl");
  await writeFile(claudePath, `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
let results = 0;
let messages = 0;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  appendFileSync(${JSON.stringify(stdinLog)}, JSON.stringify({ type: message.type, results }) + "\\n");
  if (message.type !== "user") return;
  messages += 1;
  const reply = "Reply " + messages + ".";
  setTimeout(() => {
    send({ type: "system", subtype: "init", session_id: "old-cli" });
    send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: reply }] } });
    send({ type: "result", subtype: "success", result: reply });
    results += 1;
  }, messages === 1 ? 300 : 10);
});
`, "utf8");
  await chmod(claudePath, 0o755);
  const runner = makeRunner() as any;
  cliParts(runner).cliRuns.providerExecutableForRun = async () => claudePath;
  const participant = { id: "claude-old", kind: "claude-code", label: "Claude" };
  const warm = { conversationId: "conversation-old", participantId: participant.id, contextKey: "context-old", idleTimeoutMs: 60_000 };
  try {
    const firstRun = runner.run(participant, "One.", fixtureDir, undefined, "chat", undefined, { agentMode: "default", warm });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const secondRun = runner.run(participant, "Two.", fixtureDir, undefined, "chat", undefined, { agentMode: "default", warm });
    const controller = new AbortController();
    const thirdRun = runner.run(participant, "Three.", fixtureDir, undefined, "chat", controller.signal, { agentMode: "default", warm });
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort(new Error("Stopped by user."));
    const third = await thirdRun;
    assert.equal(third.ok, false, "a message never sent is dropped at once");
    const [first, second] = await Promise.all([firstRun, secondRun]);
    assert.equal(first.content, "Reply 1.");
    assert.equal(second.content, "Reply 2.");
    const log = (await readFile(stdinLog, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.deepEqual(log.map((entry) => entry.type), ["user", "user"], "the stopped message was never written and no control request was needed");
    assert.equal(log[1].results, 1, "the second message was written only after the first reply ended");
  } finally {
    await runner.shutdownWarmAgents();
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("Claude public warm-run path: a provider that dies with background work kills that work and the next message starts fresh without replaying", { timeout: 10_000 }, async () => {
  if (process.platform === "win32") {
    return;
  }
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-claude-background-failure-"));
  const claudePath = path.join(fixtureDir, "claude-fixture");
  const countFile = path.join(fixtureDir, "count.txt");
  const pidsFile = path.join(fixtureDir, "pids.txt");
  const taskPidFile = path.join(fixtureDir, "task.pid");
  const helperPidFile = path.join(fixtureDir, "helper.pid");
  const backgroundTaskScript = `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
process.on("SIGTERM", () => {});
setTimeout(() => {
  const helper = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });
  writeFileSync(${JSON.stringify(helperPidFile)}, String(helper.pid));
}, 150);
setInterval(() => {}, 1000);
`;
  await writeFile(claudePath, `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("node:fs");
const readline = require("node:readline");
const countFile = ${JSON.stringify(countFile)};
const count = existsSync(countFile) ? Number(readFileSync(countFile, "utf8")) + 1 : 1;
writeFileSync(countFile, String(count));
appendFileSync(${JSON.stringify(pidsFile)}, String(process.pid) + "\\n");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", () => {
  send({ type: "system", subtype: "init", session_id: "failure-session-" + count });
  if (count === 1) {
    const task = spawn(process.execPath, ["-e", ${JSON.stringify(backgroundTaskScript)}], { stdio: "ignore", detached: true });
    writeFileSync(${JSON.stringify(taskPidFile)}, String(task.pid));
    send({ type: "system", subtype: "task_started", task_id: "task-1", description: "failing background task", is_backgrounded: true });
    send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Work started." }] } });
    send({ type: "result", subtype: "success", result: "Work started." });
    const failWhenHelperStarts = () => {
      if (!existsSync(${JSON.stringify(helperPidFile)})) {
        setTimeout(failWhenHelperStarts, 5);
        return;
      }
      process.stdout.write(JSON.stringify({ type: "error", error: "fixture provider failed" }) + "\\n", () => process.exit(1));
    };
    failWhenHelperStarts();
    return;
  }
  send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Fresh after failure." }] } });
  send({ type: "result", subtype: "success", result: "Fresh after failure." });
});
`, "utf8");
  await chmod(claudePath, 0o755);

  const runner = makeRunner() as any;
  cliDependencies(runner).nativeProcessDbPath = path.join(fixtureDir, "native-processes.sqlite3");
  cliParts(runner).cliRuns.providerExecutableForRun = async () => claudePath;
  let oneShotFallbacks = 0;
  cliParts(runner).claudeRuns.runClaudeOneShot = async (): Promise<never> => {
    oneShotFallbacks += 1;
    throw new Error("prompt replayed through one-shot fallback");
  };
  const participant = { id: "claude-failure", kind: "claude-code", label: "Claude" };
  const warm = {
    conversationId: "conversation-failure",
    participantId: participant.id,
    contextKey: "context-failure",
    idleTimeoutMs: 60_000
  };
  let taskPid: number | undefined;
  let helperPid: number | undefined;
  try {
    const first = await runner.run(participant, "Start work.", fixtureDir, undefined, "chat", undefined, {
      agentMode: "default",
      warm
    });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.content, "Work started.");
    assert.equal(first.warnings, undefined, "the reply itself finished cleanly");
    assert.equal(oneShotFallbacks, 0);
    taskPid = Number.parseInt((await readFile(taskPidFile, "utf8")).trim(), 10);
    // The provider dies only after its background task has started a helper.
    for (let attempt = 0; attempt < 200 && helperPid === undefined; attempt += 1) {
      const text = await readFile(helperPidFile, "utf8").catch(() => "");
      helperPid = text.trim() ? Number.parseInt(text.trim(), 10) : undefined;
      if (helperPid === undefined) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    assert.ok(helperPid, "the background task started its helper");
    await assertFixtureProcessStops(taskPid);
    await assertFixtureProcessStops(helperPid);

    const second = await runner.run(participant, "Continue safely.", fixtureDir, undefined, "chat", undefined, {
      agentMode: "default",
      warm
    });
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(second.content, "Fresh after failure.");
    const pids = (await readFile(pidsFile, "utf8")).trim().split(/\r?\n/).map(Number);
    assert.equal(pids.length, 2);
    assert.notEqual(pids[0], pids[1]);
    assert.equal(oneShotFallbacks, 0);
  } finally {
    await runner.shutdownWarmAgents();
    for (const pid of [taskPid, helperPid]) {
      if (pid && testProcessExists(pid)) {
        process.kill(pid, "SIGKILL");
      }
    }
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

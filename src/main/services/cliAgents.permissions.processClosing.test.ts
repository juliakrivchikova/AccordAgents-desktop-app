import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { NativeProcessRegistry } from "./nativeProcessRegistry";
import { CliAgentRunner } from "./cliAgents";
import { cliDependencies, cliParts } from "./cliAgents/test/cliParts";
import { ensureLoginShellEnvPrimed } from "./command";
import { assertFixtureProcessStops, makeRunner, testProcessExists, writeCodexAppServerFixture } from "./cliAgents/test/runnerFixtures";

// Claude Code's own config on this computer (Claude in Chrome, for one) must
// not decide these tests: an empty config folder is a fresh Claude Code.
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), "aa-claude-config-"));

test("idle accounts for native operations before a warm session exists and releases failed operations", async () => {
  const runner = makeRunner();
  const participant = { id: "idle-native", kind: "codex-cli" as const, label: "Codex" };
  let finish!: (value: Awaited<ReturnType<CliAgentRunner["run"]>>) => void;
  let fail!: (error: Error) => void;
  const pending = new Promise<Awaited<ReturnType<CliAgentRunner["run"]>>>((resolve, reject) => { finish = resolve; fail = reject; });
  let calls = 0;
  const native = cliParts(runner).codexRuns as unknown as { runCodex(): ReturnType<CliAgentRunner["run"]>; compactCodexSession(): ReturnType<CliAgentRunner["compactSession"]> };
  native.runCodex = () => { calls++; return pending; };
  const running = runner.run(participant, "native goal", undefined, undefined, "chat");
  assert.equal(runner.hasActiveNativeWork(), true);
  assert.equal(runner.fenceIdleNativeAdmissions(), undefined);
  finish({ participant, ok: true, content: "complete" }); await running;
  assert.equal(runner.hasActiveNativeWork(), false);
  const release = runner.fenceIdleNativeAdmissions()!;
  assert.equal((await runner.run(participant, "held", undefined, undefined, "chat")).ok, false);
  assert.equal((await runner.compactSession(participant, undefined, undefined, "chat", undefined, { sessionId: "s" })).ok, false);
  assert.equal(calls, 1);
  release();
  native.runCodex = () => new Promise((_resolve, reject) => { fail = reject; });
  const failed = runner.run(participant, "fails", undefined, undefined, "chat");
  await Promise.resolve();
  fail(new Error("native setup failed")); await assert.rejects(failed, /native setup failed/);
  assert.equal(runner.hasActiveNativeWork(), false);
});

test("a shutdown while a Claude turn reads its Chrome setting stops the turn", async () => {
  for (const compact of [false, true]) {
    const runner = makeRunner() as any;
    let release!: () => void;
    const reading = new Promise<void>((resolve) => { release = resolve; });
    cliParts(runner).claudeSettings.withClaudeChrome = async (_participant: unknown, _repoPath: unknown, _kind: unknown, options: Record<string, unknown>) => {
      await reading;
      return { ...options, claudeChrome: false };
    };
    cliParts(runner).claudeRuns.runClaude = cliParts(runner).claudeRuns.compactClaudeSession = async () => { throw new Error("must not start"); };
    const participant = { id: "p1", label: "Claude", kind: "claude-code" };
    const warm = { conversationId: "c1", participantId: "p1", contextKey: "k", idleTimeoutMs: 1000 };
    const pending = compact
      ? runner.compactSession(participant, undefined, undefined, "chat", undefined, { warm, sessionId: "s1" })
      : runner.run(participant, "hi", undefined, undefined, "chat", undefined, { warm });
    const closing = runner.shutdownWarmAgents();
    release();
    const result = await pending;
    await closing;
    assert.equal(result.ok, false);
    assert.match(result.error, /shut down while/);
  }
});

test("native goal idle detector warns once per idle episode and rearms on activity", async () => {
  const runner = makeRunner() as any;
  const outputs: unknown[] = [];
  const monitor = cliParts(runner).warmAgents.createNativeGoalIdleMonitor(
    { id: "p1", kind: "claude-code", label: "Claude" },
    (event: unknown) => outputs.push(event),
    15
  );
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.equal(outputs.length, 1);
  assert.equal((outputs[0] as { activityDetail?: string }).activityDetail, undefined);
  monitor.touch();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(outputs.length, 2);
  monitor.close();
});

test("Windows warm-agent shutdown terminates provider descendants", async (t) => {
  if (process.platform !== "win32") {
    t.skip("taskkill process-tree behavior is only available on Windows");
    return;
  }
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-codex-warm-tree-"));
  const helperPidFile = path.join(fixtureDir, "warm-helper.pid");
  const gracefulShutdownMarker = path.join(fixtureDir, "graceful-shutdown.marker");
  const codexPath = await writeCodexAppServerFixture(fixtureDir, `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const readline = require("node:readline");
const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
writeFileSync(${JSON.stringify(helperPidFile)}, String(helper.pid));
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const input = readline.createInterface({ input: process.stdin });
input.on("close", () => writeFileSync(${JSON.stringify(gracefulShutdownMarker)}, "stdin closed"));
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex", platformFamily: "windows", platformOsName: "windows", platformArch: "x64" } });
  } else if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "thread-warm-tree" }, model: "gpt-5" } });
  } else if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-warm-tree" } } });
    send({ method: "turn/started", params: { threadId: "thread-warm-tree", turn: { id: "turn-warm-tree" } } });
    send({ method: "item/completed", params: { threadId: "thread-warm-tree", turnId: "turn-warm-tree", item: {
      id: "message-warm-tree", type: "agentMessage", text: "done"
    } } });
    send({ method: "turn/completed", params: { threadId: "thread-warm-tree", turn: { id: "turn-warm-tree", status: "completed" } } });
  }
});
`);
  const runner = new CliAgentRunner(undefined, undefined, codexPath) as any;
  let helperPid: number | undefined;
  t.after(async () => {
    await runner.shutdownWarmAgents();
    if (helperPid && testProcessExists(helperPid)) {
      process.kill(helperPid, "SIGKILL");
    }
    await rm(fixtureDir, { recursive: true, force: true });
  });

  const result = await cliParts(runner).codexRuns.runCodexAppServerWarmOrOneShot(
    { id: "participant-warm-tree", kind: "codex-cli", label: "Codex" },
    "Reply with done.",
    fixtureDir,
    undefined,
    "chat",
    undefined,
    {
      agentMode: "default",
      warm: {
        conversationId: "conversation-warm-tree",
        participantId: "participant-warm-tree",
        contextKey: "context-warm-tree",
        idleTimeoutMs: 60_000
      }
    }
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  helperPid = Number.parseInt((await readFile(helperPidFile, "utf8")).trim(), 10);
  assert.equal(testProcessExists(helperPid), true);

  await runner.shutdownWarmAgents();
  assert.equal(await readFile(gracefulShutdownMarker, "utf8"), "stdin closed");
  await assertFixtureProcessStops(helperPid);
});

test("closing AccordAgents terminates every warm agent process while responses are active", async (t) => {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-close-active-agents-"));
  const pidFile = path.join(fixtureDir, "active-agent-pids.txt");
  const startedFile = path.join(fixtureDir, "active-agent-started.txt");
  const codexPath = await writeCodexAppServerFixture(fixtureDir, `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const readline = require("node:readline");
appendFileSync(${JSON.stringify(pidFile)}, String(process.pid) + "\\n");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex", platformFamily: process.platform, platformOsName: process.platform, platformArch: process.arch } });
  } else if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "thread-" + process.pid }, model: "gpt-5" } });
  } else if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-" + process.pid } } });
    send({ method: "turn/started", params: { threadId: "thread-" + process.pid, turn: { id: "turn-" + process.pid } } });
    appendFileSync(${JSON.stringify(startedFile)}, String(process.pid) + "\\n");
  }
});
`);
  const diagnostics: unknown[] = [];
  const runner = new CliAgentRunner({ write: async (event, payload) => { diagnostics.push({ event, payload }); } }, undefined, { codexExecutable: codexPath, nativeProcessDbPath: path.join(fixtureDir, "native-processes.sqlite3") }) as any;
  const participants = ["one", "two"].map((id) => ({ id: `participant-${id}`, kind: "codex-cli" as const, label: `Codex ${id}` }));
  t.after(async () => {
    await runner.shutdownWarmAgents();
    await rm(fixtureDir, { recursive: true, force: true });
  });

  // Shell readiness can take up to its own eight-second timeout; it is a
  // fixture prerequisite, not part of this four-second provider-start check.
  await ensureLoginShellEnvPrimed();
  const runs = participants.map((participant) => cliParts(runner).codexRuns.runCodexAppServerWarmOrOneShot(
    participant,
    "Keep responding until the app closes.",
    fixtureDir,
    undefined,
    "chat",
    undefined,
    {
      agentMode: "default",
      warm: {
        conversationId: `conversation-${participant.id}`,
        participantId: participant.id,
        contextKey: `context-${participant.id}`,
        idleTimeoutMs: 60_000
      }
    }
  ));

  const earlyResults: unknown[] = [];
  for (const run of runs) void run.then((result: unknown) => earlyResults.push(result), (error: unknown) => earlyResults.push(String(error)));
  let startedPids: number[] = [];
  for (let attempt = 0; attempt < 80; attempt += 1) {
    startedPids = await readFile(startedFile, "utf8")
      .then((value) => value.trim().split(/\r?\n/).filter(Boolean).map(Number))
      .catch(() => []);
    if (startedPids.length === participants.length) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (startedPids.length !== participants.length) {
    const native = new NativeProcessRegistry(path.join(fixtureDir, "native-processes.sqlite3"));
    const diagnostic = { earlyResults, diagnostics, providers: await readFile(pidFile, "utf8").catch(() => "none"),
      preparing: [...cliParts(runner).warmAgents.warmPreparations].map((value: { key: string }) => value.key), creating: [...cliParts(runner).warmAgents.warmAgentCreations.keys()], warm: [...cliParts(runner).warmAgents.entries.keys()],
      receipts: await native.openLeases().catch(error => String(error)) };
    console.error("native-close-startup-diagnostic", JSON.stringify(diagnostic));
  }
  assert.equal(startedPids.length, participants.length, `both agent responses should be active before app shutdown; early outcomes: ${JSON.stringify(earlyResults)}`);
  assert.equal(runner.hasActiveNativeWork(), true);
  assert.equal(runner.fenceIdleNativeAdmissions(), undefined, "idle stop cannot fence active provider responses");

  await runner.shutdownWarmAgents();
  const results = await Promise.all(runs);
  assert.equal(results.every((result: { ok: boolean }) => result.ok === false), true);
  for (const pid of startedPids) {
    await assertFixtureProcessStops(pid);
  }
  assert.equal(runner.hasActiveNativeWork(), false);
  const releaseIdle = runner.fenceIdleNativeAdmissions();
  assert.equal(typeof releaseIdle, "function");
  const refused = await cliParts(runner).codexRuns.runCodexAppServerWarmOrOneShot(participants[0], "Must stay queued.", fixtureDir, undefined,
    "chat", undefined, { agentMode: "default", warm: { conversationId: "idle-fenced", participantId: participants[0].id, contextKey: "idle-fenced", idleTimeoutMs: 60_000 } });
  assert.equal(refused.ok, false);
  assert.equal((await readFile(pidFile, "utf8")).trim().split(/\r?\n/).length, participants.length, "a fenced command never spawns a replacement provider");
  releaseIdle();
});

test("Claude public warm-run path: the idle timer never closes a process with live background work, and closes it once that work and its reply are done", { timeout: 15_000 }, async () => {
  if (process.platform === "win32") {
    return;
  }
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-claude-idle-"));
  const claudePath = path.join(fixtureDir, "claude-fixture");
  const providerPidFile = path.join(fixtureDir, "provider.pid");
  const helperPidFile = path.join(fixtureDir, "helper.pid");
  await writeFile(claudePath, `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const readline = require("node:readline");
writeFileSync(${JSON.stringify(providerPidFile)}, String(process.pid));
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
let helper;
const input = readline.createInterface({ input: process.stdin });
input.on("close", () => { if (helper) helper.kill("SIGTERM"); process.exit(0); });
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type !== "user") return;
  send({ type: "command_lifecycle", command_uuid: message.uuid, state: "started" });
  send({ type: "system", subtype: "init", session_id: "idle-session" });
  helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  writeFileSync(${JSON.stringify(helperPidFile)}, String(helper.pid));
  send({ type: "system", subtype: "task_started", task_id: "task-1", description: "long task", is_backgrounded: true });
  send({ type: "result", subtype: "success", result: "Started." });
  setTimeout(() => {
    helper.kill("SIGTERM");
    helper = undefined;
    send({ type: "system", subtype: "background_tasks_changed", tasks: [] });
    send({ type: "system", subtype: "task_notification", task_id: "task-1", status: "completed" });
    send({ type: "system", subtype: "init", session_id: "idle-session" });
    send({ type: "result", subtype: "success", result: "Done." });
  }, 900);
});
`, "utf8");
  await chmod(claudePath, 0o755);
  const runner = makeRunner() as any;
  cliParts(runner).cliRuns.providerExecutableForRun = async () => claudePath;
  const participant = { id: "claude-idle", kind: "claude-code", label: "Claude" };
  let attachResult: Promise<any> | undefined;
  const warm = {
    conversationId: "conversation-idle",
    participantId: participant.id,
    contextKey: "context-idle",
    idleTimeoutMs: 150,
    onSelfResumedTurn: (turn: any) => { attachResult = turn.attach({}); }
  };
  let providerPid: number | undefined;
  try {
    const first = await runner.run(participant, "Start.", fixtureDir, undefined, "chat", undefined, { agentMode: "default", warm });
    assert.equal(first.content, "Started.");
    providerPid = Number.parseInt((await readFile(providerPidFile, "utf8")).trim(), 10);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(testProcessExists(providerPid), true, "the idle timer fired while background work was live and left the process alone");
    assert.equal(cliParts(runner).warmAgents.entries.size, 1);
    for (let attempt = 0; attempt < 100 && !attachResult; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(attachResult, "the CLI's own reply was offered");
    assert.equal((await attachResult).content, "Done.");
    await assertFixtureProcessStops(providerPid);
    assert.equal(cliParts(runner).warmAgents.entries.size, 0, "once idle, the process is retired by the re-armed timer");
  } finally {
    await runner.shutdownWarmAgents();
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("Claude live background shutdown escalates when the provider ignores stdin EOF", { timeout: 10_000 }, async () => {
  if (process.platform === "win32") {
    return;
  }
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-claude-background-escalation-"));
  const claudePath = path.join(fixtureDir, "claude-fixture");
  const providerPidFile = path.join(fixtureDir, "provider.pid");
  const helperPidFile = path.join(fixtureDir, "helper.pid");
  const stdinClosedMarker = path.join(fixtureDir, "stdin-closed.marker");
  await writeFile(claudePath, `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const readline = require("node:readline");
writeFileSync(${JSON.stringify(providerPidFile)}, String(process.pid));
// It ignores SIGTERM as well, so only the final SIGKILL ends it, and a slow
// machine still gets to record the EOF before then.
process.on("SIGTERM", () => {});
const helper = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });
writeFileSync(${JSON.stringify(helperPidFile)}, String(helper.pid));
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const input = readline.createInterface({ input: process.stdin });
input.on("close", () => {
  writeFileSync(${JSON.stringify(stdinClosedMarker)}, "closed");
  setInterval(() => {}, 1000);
});
input.on("line", () => {
  send({ type: "system", subtype: "init", session_id: "escalation-session" });
  send({ type: "system", subtype: "task_started", task_id: "task-1", description: "stuck background task", is_backgrounded: true });
  send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Still running." }] } });
  send({ type: "result", subtype: "success", result: "Still running." });
});
`, "utf8");
  await chmod(claudePath, 0o755);

  const runner = makeRunner() as any;
  cliDependencies(runner).nativeProcessDbPath = path.join(fixtureDir, "native-processes.sqlite3");
  cliParts(runner).cliRuns.providerExecutableForRun = async () => claudePath;
  cliParts(runner).warmAgentClose.claudeBackgroundCloseGraceMs = 20;
  const participant = { id: "claude-escalation", kind: "claude-code", label: "Claude" };
  const controller = new AbortController();
  let markHeld!: () => void;
  const held = new Promise<void>((resolve) => { markHeld = resolve; });
  let providerPid: number | undefined;
  let helperPid: number | undefined;
  try {
    const run = runner.run(participant, "Start work.", fixtureDir, undefined, "chat", controller.signal, {
      agentMode: "default",
      warm: {
        conversationId: "conversation-escalation",
        participantId: participant.id,
        contextKey: "context-escalation",
        idleTimeoutMs: 60_000
      },
      onOutput: (event: { activityStatus?: string; text: string }) => {
        if (/Running in the background/.test(event.text)) {
          markHeld();
        }
      }
    });
    await held;
    providerPid = Number.parseInt((await readFile(providerPidFile, "utf8")).trim(), 10);
    helperPid = Number.parseInt((await readFile(helperPidFile, "utf8")).trim(), 10);
    const result = await run;
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.content, "Still running.");
    assert.equal(controller.signal.aborted, false);
    // Removing the member (or closing the chat) retires its process with the
    // background work it still carries.
    await runner.closeWarmAgents("conversation-escalation", participant.id, "member-removed");
    assert.equal(await readFile(stdinClosedMarker, "utf8"), "closed");
    await assertFixtureProcessStops(providerPid);
    await assertFixtureProcessStops(helperPid);
  } finally {
    await runner.shutdownWarmAgents();
    for (const pid of [providerPid, helperPid]) {
      if (pid && testProcessExists(pid)) {
        process.kill(pid, "SIGKILL");
      }
    }
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("Claude live background shutdown kills descendants after the provider exits on stdin EOF", { timeout: 10_000 }, async () => {
  if (process.platform === "win32") {
    return;
  }
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-claude-background-eof-exit-"));
  const claudePath = path.join(fixtureDir, "claude-fixture");
  const helperPidFile = path.join(fixtureDir, "helper.pid");
  const stdinClosedMarker = path.join(fixtureDir, "stdin-closed.marker");
  await writeFile(claudePath, `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const readline = require("node:readline");
// SIGTERM (sent 300 ms after EOF) must not end it before it handles the
// EOF itself on a slow machine; it exits on EOF as the scenario says.
process.on("SIGTERM", () => {});
const helper = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });
writeFileSync(${JSON.stringify(helperPidFile)}, String(helper.pid));
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const input = readline.createInterface({ input: process.stdin });
input.on("close", () => {
  writeFileSync(${JSON.stringify(stdinClosedMarker)}, "closed");
  process.exit(0);
});
input.on("line", () => {
  send({ type: "system", subtype: "init", session_id: "eof-exit-session" });
  send({ type: "system", subtype: "task_started", task_id: "task-1", description: "orphan-prone background task", is_backgrounded: true });
  send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Still running." }] } });
  send({ type: "result", subtype: "success", result: "Still running." });
});
`, "utf8");
  await chmod(claudePath, 0o755);

  const runner = makeRunner() as any;
  cliDependencies(runner).nativeProcessDbPath = path.join(fixtureDir, "native-processes.sqlite3");
  cliParts(runner).cliRuns.providerExecutableForRun = async () => claudePath;
  cliParts(runner).warmAgentClose.claudeBackgroundCloseGraceMs = 200;
  const participant = { id: "claude-eof-exit", kind: "claude-code", label: "Claude" };
  const controller = new AbortController();
  let markHeld!: () => void;
  const held = new Promise<void>((resolve) => { markHeld = resolve; });
  let helperPid: number | undefined;
  try {
    const run = runner.run(participant, "Start work.", fixtureDir, undefined, "chat", controller.signal, {
      agentMode: "default",
      warm: {
        conversationId: "conversation-eof-exit",
        participantId: participant.id,
        contextKey: "context-eof-exit",
        idleTimeoutMs: 60_000
      },
      onOutput: (event: { activityStatus?: string; text: string }) => {
        if (/Running in the background/.test(event.text)) {
          markHeld();
        }
      }
    });
    await held;
    helperPid = Number.parseInt((await readFile(helperPidFile, "utf8")).trim(), 10);
    const result = await run;
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.content, "Still running.");
    assert.equal(controller.signal.aborted, false);
    await runner.closeWarmAgents("conversation-eof-exit", participant.id, "member-removed");
    assert.equal(await readFile(stdinClosedMarker, "utf8"), "closed");
    await assertFixtureProcessStops(helperPid);
  } finally {
    await runner.shutdownWarmAgents();
    if (helperPid && testProcessExists(helperPid)) {
      process.kill(helperPid, "SIGKILL");
    }
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("update quit immediately terminates a warm Claude provider and its detached background task", { timeout: 10_000 }, async () => {
  if (process.platform === "win32") {
    return;
  }
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-claude-update-quit-"));
  const claudePath = path.join(fixtureDir, "claude-fixture");
  const providerPidFile = path.join(fixtureDir, "provider.pid");
  const helperPidFile = path.join(fixtureDir, "helper.pid");
  await writeFile(claudePath, `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const readline = require("node:readline");
writeFileSync(${JSON.stringify(providerPidFile)}, String(process.pid));
const helper = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });
writeFileSync(${JSON.stringify(helperPidFile)}, String(helper.pid));
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", () => {
  send({ type: "system", subtype: "init", session_id: "update-quit-session" });
  send({ type: "system", subtype: "task_started", task_id: "task-1", description: "update-sensitive task", is_backgrounded: true });
  send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Still running." }] } });
  send({ type: "result", subtype: "success", result: "Still running." });
});
`, "utf8");
  await chmod(claudePath, 0o755);

  const runner = makeRunner() as any;
  cliParts(runner).cliRuns.providerExecutableForRun = async () => claudePath;
  let captureCount = 0;
  cliParts(runner).warmAgentClose.readClaudeBackgroundProcessTable = async () => {
    captureCount += 1;
    const { readPosixProcessTableAsync } = await import("./processTermination");
    return readPosixProcessTableAsync();
  };
  const participant = { id: "claude-update-quit", kind: "claude-code", label: "Claude" };
  let markHeld!: () => void;
  const held = new Promise<void>((resolve) => { markHeld = resolve; });
  let providerPid: number | undefined;
  let helperPid: number | undefined;
  try {
    const run = runner.run(participant, "Start work.", fixtureDir, undefined, "chat", undefined, {
      agentMode: "default",
      warm: {
        conversationId: "conversation-update-quit",
        participantId: participant.id,
        contextKey: "context-update-quit",
        idleTimeoutMs: 60_000
      },
      onOutput: (event: { activityStatus?: string; text: string }) => {
        if (/Running in the background/.test(event.text)) {
          markHeld();
        }
      }
    });
    await held;
    providerPid = Number.parseInt((await readFile(providerPidFile, "utf8")).trim(), 10);
    helperPid = Number.parseInt((await readFile(helperPidFile, "utf8")).trim(), 10);
    await run;
    assert.ok(captureCount > 0, "the shared descendant sampler ran while background work was live");
    runner.terminateWarmAgentsImmediately("update installation");
    await assertFixtureProcessStops(providerPid);
    await assertFixtureProcessStops(helperPid);
    const capturesAfterShutdown = captureCount;
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(captureCount, capturesAfterShutdown, "update shutdown stopped the shared descendant sampler");
  } finally {
    runner.terminateWarmAgentsImmediately("test cleanup");
    for (const pid of [providerPid, helperPid]) {
      if (pid && testProcessExists(pid)) {
        process.kill(pid, "SIGKILL");
      }
    }
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("update quit also terminates a Claude provider already in graceful close", { timeout: 10_000 }, async () => {
  if (process.platform === "win32") {
    return;
  }
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-claude-update-during-close-"));
  const claudePath = path.join(fixtureDir, "claude-fixture");
  const providerPidFile = path.join(fixtureDir, "provider.pid");
  const helperPidFile = path.join(fixtureDir, "helper.pid");
  const stdinClosedMarker = path.join(fixtureDir, "stdin-closed.marker");
  await writeFile(claudePath, `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const readline = require("node:readline");
writeFileSync(${JSON.stringify(providerPidFile)}, String(process.pid));
const helper = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });
writeFileSync(${JSON.stringify(helperPidFile)}, String(helper.pid));
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const input = readline.createInterface({ input: process.stdin });
input.on("close", () => {
  writeFileSync(${JSON.stringify(stdinClosedMarker)}, "closed");
  setInterval(() => {}, 1000);
});
input.on("line", () => {
  send({ type: "system", subtype: "init", session_id: "update-during-close-session" });
  send({ type: "system", subtype: "task_started", task_id: "task-1", description: "update-sensitive task", is_backgrounded: true });
  send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Still running." }] } });
  send({ type: "result", subtype: "success", result: "Still running." });
});
`, "utf8");
  await chmod(claudePath, 0o755);

  const runner = makeRunner() as any;
  cliParts(runner).cliRuns.providerExecutableForRun = async () => claudePath;
  cliParts(runner).warmAgentClose.claudeBackgroundCloseGraceMs = 5_000;
  const participant = { id: "claude-update-during-close", kind: "claude-code", label: "Claude" };
  const controller = new AbortController();
  let markHeld!: () => void;
  const held = new Promise<void>((resolve) => { markHeld = resolve; });
  let providerPid: number | undefined;
  let helperPid: number | undefined;
  try {
    const run = runner.run(participant, "Start work.", fixtureDir, undefined, "chat", controller.signal, {
      agentMode: "default",
      warm: {
        conversationId: "conversation-update-during-close",
        participantId: participant.id,
        contextKey: "context-update-during-close",
        idleTimeoutMs: 60_000
      },
      onOutput: (event: { activityStatus?: string; text: string }) => {
        if (/Running in the background/.test(event.text)) {
          markHeld();
        }
      }
    });
    await held;
    providerPid = Number.parseInt((await readFile(providerPidFile, "utf8")).trim(), 10);
    helperPid = Number.parseInt((await readFile(helperPidFile, "utf8")).trim(), 10);
    const result = await run;
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(controller.signal.aborted, false);
    const closing = runner.closeWarmAgents("conversation-update-during-close", participant.id, "member-removed");
    let stdinClosed = false;
    for (let attempt = 0; attempt < 100 && !stdinClosed; attempt += 1) {
      stdinClosed = await readFile(stdinClosedMarker, "utf8")
        .then((value) => value === "closed")
        .catch(() => false);
      if (!stdinClosed) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    assert.equal(stdinClosed, true, "ordinary close entered its graceful stdin-EOF wait");
    assert.equal(cliParts(runner).warmAgents.entries.size, 0, "the closing provider already left the active map");
    assert.equal(cliParts(runner).warmAgentClose.closingWarmAgents.size, 1, "the closing provider remains visible to update shutdown");

    runner.terminateWarmAgentsImmediately("update installation");
    await closing;
    await assertFixtureProcessStops(providerPid);
    await assertFixtureProcessStops(helperPid);
  } finally {
    runner.terminateWarmAgentsImmediately("test cleanup");
    for (const pid of [providerPid, helperPid]) {
      if (pid && testProcessExists(pid)) {
        process.kill(pid, "SIGKILL");
      }
    }
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("Claude background-process sampling is shared, non-overlapping, and lives until the last agent stops", async () => {
  const runner = makeRunner() as any;
  const rows = new Map<number, never>();
  let reads = 0;
  let resolveFirstRead!: (value: Map<number, never>) => void;
  const firstRead = new Promise<Map<number, never>>((resolve) => { resolveFirstRead = resolve; });
  cliParts(runner).warmAgentClose.readClaudeBackgroundProcessTable = () => {
    reads += 1;
    return reads === 1 ? firstRead : Promise.resolve(new Map<number, never>());
  };
  let firstLive = true;
  let secondLive = true;
  const firstTables: unknown[] = [];
  const secondTables: unknown[] = [];
  let markSharedDelivery!: () => void;
  const sharedDelivery = new Promise<void>((resolve) => { markSharedDelivery = resolve; });
  let markSoloDelivery!: () => void;
  const soloDelivery = new Promise<void>((resolve) => { markSoloDelivery = resolve; });
  const noteDelivery = (): void => {
    if (firstTables.length === 1 && secondTables.length === 1) {
      markSharedDelivery();
    }
    if (secondTables.length === 2) {
      markSoloDelivery();
    }
  };
  cliParts(runner).warmAgents.entries.set("first", {
    closed: false,
    hasLiveBackgroundWork: () => firstLive,
    refreshCapturedBackgroundProcesses: (table: unknown) => {
      firstTables.push(table);
      noteDelivery();
    }
  });
  cliParts(runner).warmAgents.entries.set("second", {
    closed: false,
    hasLiveBackgroundWork: () => secondLive,
    refreshCapturedBackgroundProcesses: (table: unknown) => {
      secondTables.push(table);
      noteDelivery();
    }
  });

  try {
    cliParts(runner).warmAgentClose.ensureClaudeBackgroundProcessCapture();
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(reads, 1, "timer ticks do not overlap an in-flight process-table read");

    resolveFirstRead(rows);
    await sharedDelivery;
    assert.equal(reads, 1, "one completed sample used one process-table read");
    assert.deepEqual(firstTables, [rows]);
    assert.deepEqual(secondTables, [rows]);

    firstLive = false;
    await soloDelivery;
    assert.equal(reads, 2, "the remaining agent kept the sampler alive for one shared tick");
    assert.deepEqual(firstTables, [rows]);
    assert.equal(secondTables.length, 2);
    assert.notEqual(secondTables[1], rows, "the second tick used its own table snapshot");

    secondLive = false;
    cliParts(runner).warmAgentClose.maybeStopClaudeBackgroundProcessCapture();
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(reads, 2, "the shared sampler stopped after the last agent retired");
  } finally {
    firstLive = false;
    secondLive = false;
    cliParts(runner).warmAgentClose.stopClaudeBackgroundProcessCapture();
    cliParts(runner).warmAgents.entries.clear();
  }
});

test("immediate shutdown ignores a recycled warm-agent root PID and its unrelated children", (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX process identity checks are unavailable on Windows");
    return;
  }
  const runner = makeRunner() as any;
  const oldIdentity = { pid: 42, startedAt: "Fri Sep  5 12:00:00 2026" };
  cliParts(runner).warmAgentClose.readPosixProcessTableForTermination = () => new Map([
    [42, { pid: 42, ppid: 1, pgid: 42, startedAt: "Fri Sep  5 12:01:00 2026" }],
    [43, { pid: 43, ppid: 42, pgid: 42, startedAt: "Fri Sep  5 12:01:01 2026" }]
  ]);
  const childSignals: NodeJS.Signals[] = [];
  const processSignals: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
  const originalKill = process.kill;
  process.kill = ((pid: number, signal: NodeJS.Signals | number) => {
    processSignals.push({ pid, signal });
    return true;
  }) as typeof process.kill;
  cliParts(runner).warmAgents.entries.set("stale", {
    closed: false,
    providerKind: "claude-code",
    process: {
      pid: 42,
      exitCode: 0,
      signalCode: null,
      killed: false,
      kill: (signal: NodeJS.Signals) => {
        childSignals.push(signal);
        return true;
      }
    },
    processIdentity: () => oldIdentity,
    capturedBackgroundProcesses: () => []
  });
  try {
    runner.terminateWarmAgentsImmediately("update installation");
    assert.deepEqual(processSignals, []);
    assert.deepEqual(childSignals, []);
  } finally {
    process.kill = originalKill;
    cliParts(runner).warmAgents.entries.clear();
  }
});

test("shutdown waits for a session still being constructed and duplicate construction shares its owner", async () => {
  const runner = makeRunner() as any;
  let create!: (entry: any) => void;
  const ready = new Promise<any>((resolve) => { create = resolve; });
  let constructions = 0;
  let started!: () => void;
  const constructing = new Promise<void>(resolve => { started = resolve; });
  const closed: string[] = [];
  cliParts(runner).warmAgentClose.closeWarmAgent = async (entry: any) => { closed.push(entry.key); entry.closed = true; };
  const first = cliParts(runner).warmAgents.createTrackedWarmAgent("starting", () => { constructions += 1; started(); return ready; });
  const duplicate = cliParts(runner).warmAgents.createTrackedWarmAgent("starting", () => { constructions += 1; return ready; });
  assert.equal(first, duplicate);
  await constructing;
  const shuttingDown = runner.shutdownWarmAgents();
  await assert.rejects(cliParts(runner).warmAgents.createTrackedWarmAgent("new", async () => ({})), /shutting down/);
  create({ key: "starting", closed: false });
  await assert.rejects(first, /before this command started/);
  await shuttingDown;
  assert.deepEqual(closed, ["starting"]);
  assert.equal(constructions, 1);
  assert.equal(cliParts(runner).warmAgents.entries.size, 0);
});

test("conversation shutdown keeps other chats running and retries failed native closure", async () => {
  const runner = makeRunner() as any;
  const entry = (conversationId: string) => ({ key: JSON.stringify({ conversationId, participantId: "member" }), scopeKey: `${conversationId}:member`, closed: false });
  const archived = entry("chat");
  const other = entry("chat:other");
  cliParts(runner).warmAgents.entries.set(archived.key, archived);
  cliParts(runner).warmAgents.entries.set(other.key, other);
  cliParts(runner).warmAgents.clearWarmIdleTimer = () => {};
  cliParts(runner).warmAgentClose.maybeStopClaudeBackgroundProcessCapture = () => {};
  let attempts = 0;
  cliParts(runner).warmAgentClose.closeWarmAgentProcess = async (value: unknown) => {
    assert.equal(value, archived);
    if (++attempts === 1) throw new Error("closure receipt could not be stored");
  };
  await assert.rejects(runner.closeConversationSessions("chat"), /receipt could not be stored/);
  assert.equal(runner.hasActiveNativeWork(), true, "a closed flag is not a proof that descendants are gone");
  await assert.rejects(cliParts(runner).warmAgents.createTrackedWarmAgent(archived.key, async () => archived), /sessions are closing/);
  assert.equal(cliParts(runner).warmAgents.entries.get(other.key), other);
  assert.equal(other.closed, false);
  await runner.closeConversationSessions("chat");
  assert.equal(attempts, 2);
  assert.equal(runner.hasActiveNativeWork(), false);
  assert.equal(cliParts(runner).warmAgents.entries.get(other.key), other);
});

test("conversation shutdown fences concurrent construction and preserves another chat's startup", async () => {
  const runner = makeRunner() as any;
  const key = JSON.stringify({ conversationId: "closing", participantId: "member" });
  let finish!: (entry: unknown) => void;
  let started!: () => void;
  const constructing = new Promise<void>(resolve => { started = resolve; });
  const creating = cliParts(runner).warmAgents.createTrackedWarmAgent(key, () => new Promise(resolve => { finish = resolve; started(); }));
  await constructing;
  const closed: string[] = [];
  cliParts(runner).warmAgentClose.closeWarmAgent = async (entry: { key: string }) => { closed.push(entry.key); };
  const closing = runner.closeConversationSessions("closing");
  assert.equal(runner.closeConversationSessions("closing"), closing);
  await assert.rejects(cliParts(runner).warmAgents.createTrackedWarmAgent(key, async () => ({})), /sessions are closing/);
  const unrelated = JSON.stringify({ conversationId: "another", participantId: "member" });
  await cliParts(runner).warmAgents.createTrackedWarmAgent(unrelated, async () => ({ key: unrelated }));
  finish({ key });
  await assert.rejects(creating, /before this command started/);
  await closing;
  assert.deepEqual(closed, [key]);
  assert.ok(cliParts(runner).warmAgents.entries.has(unrelated));
});

test("shutdown waits for pre-spawn preparation and refuses its late provider creation", async () => {
  for (const kind of ["codex-cli", "claude-code"] as const) {
    const runner = makeRunner() as any;
    let release!: () => void;
    const preparing = new Promise<void>(resolve => { release = resolve; });
    cliParts(runner).warmAgents.closeStaleWarmAgents = () => preparing;
    cliParts(runner).cliRuns.codexExecutableForRun = async () => process.execPath;
    cliParts(runner).cliRuns.providerExecutableForRun = async () => process.execPath;
    let constructed = 0;
    cliParts(runner).codexAppServer.constructCodexAppServerWarmAgent = async () => { constructed++; throw new Error("must not spawn"); };
    cliParts(runner).claudeProcess.constructClaudeWarmAgent = async () => { constructed++; throw new Error("must not spawn"); };
    const args = [{ id: "held", label: "Held", kind }, "message", undefined,
      ...(kind === "codex-cli" ? [undefined] : []), "chat", undefined,
      { warm: { conversationId: "preparing", participantId: "held", contextKey: "test", idleTimeoutMs: 1000 } }];
    const running = kind === "codex-cli"
      ? cliParts(runner).codexRuns.runCodexAppServerWarmOrOneShot(...args)
      : cliParts(runner).claudeRuns.runClaudeWarmOrOneShot(...args);
    assert.equal(runner.hasActiveNativeWork(), true);
    let closed = false;
    const closing = runner.shutdownWarmAgents().then(() => { closed = true; });
    await Promise.resolve();
    assert.equal(closed, false, "shutdown waits even though no provider creation has begun");
    release();
    const result = await running;
    await closing;
    assert.equal(result.ok, false);
    assert.equal(constructed, 0);
    assert.equal(runner.hasActiveNativeWork(), false);
  }
});

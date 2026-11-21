import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
function fakeCodexAppServer(logPath: string, forkId: string): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const rl = readline.createInterface({ input: process.stdin });
let thread = "";
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method) fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ method: message.method, params: message.params }) + "\\n");
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex", platformFamily: "unix", platformOsName: "macos", platformArch: "arm64" } });
    return;
  }
  if (message.method === "thread/fork") {
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
    send({ method: "turn/completed", params: { threadId: thread, turn: { id: "turn-1", status: "completed" } } });
  }
});
`;
}

async function runForkedCodexTurn(forkId: string): Promise<{ result: any; sessionIds: string[]; methods: Array<{ method: string; params: any }> }> {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-codex-fork-"));
  const logPath = path.join(fixtureDir, "methods.jsonl");
  const codexPath = await writeCodexAppServerFixture(fixtureDir, fakeCodexAppServer(logPath, forkId));
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
        forkFromSessionId: "parent-thread",
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

test("codex: a fork answered with the source's own id is refused, so the member never writes to it", async () => {
  const { result, sessionIds, methods } = await runForkedCodexTurn("parent-thread");
  assert.equal(result.ok, false);
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

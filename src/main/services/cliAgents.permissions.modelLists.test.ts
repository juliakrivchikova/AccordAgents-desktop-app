import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  ClaudeModelListTimeoutError, CliAgentRunner, claudeAppliedSettings, parseClaudeInitializeModels, runClaudeModelListProbe,
  withCliStartModel
} from "./cliAgents";
import { cliParts } from "./cliAgents/test/cliParts";
import { makeRunner, writeCodexAppServerFixture } from "./cliAgents/test/runnerFixtures";

// Claude Code's own config on this computer (Claude in Chrome, for one) must
// not decide these tests: an empty config folder is a fresh Claude Code.
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), "aa-claude-config-"));

// The shape Claude Code 2.1.321 answers an SDK initialize request with.
const CLAUDE_INITIALIZE_MODELS = [
  { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", description: "Opus 5.5 · Best for everyday, complex tasks" },
  { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", description: "For complex work and everyday tasks" },
  { value: "fable", resolvedModel: "claude-fable-5-2", displayName: "Fable 5.2", description: "For your toughest challenges" },
  { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet 5.5", description: "Most efficient for simpler tasks" },
  { value: "haiku", resolvedModel: "claude-haiku-5-5", displayName: "Haiku 5.5", description: "Fastest for quick answers" },
  { value: "claude-opus-4-8", resolvedModel: "claude-opus-4-8", displayName: "Opus 4.8", description: "Best for everyday, complex tasks" },
  { value: "claude-haiku-4-5-20251001", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5" }
];

function fakeClaudeChild() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const signals: string[] = [];
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    signals,
    killed: false,
    exitCode: null as number | null,
    signalCode: null as string | null,
    kill(signal: string) {
      signals.push(signal);
      this.killed = true;
      return true;
    }
  });
  return child;
}

/** Answers the initialize request it reads on stdin with `answer`. */
function answerInitialize(child: ReturnType<typeof fakeClaudeChild>, answer: Record<string, unknown>, options: { trailingNewline?: boolean } = {}): void {
  child.stdin.on("data", (chunk) => {
    const request = JSON.parse(String(chunk));
    queueMicrotask(() => {
      const line = JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: request.request_id, response: answer } });
      child.stdout.write(options.trailingNewline === false ? line : `${line}\n`);
    });
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("Claude model list keeps the CLI's own names and order, without its Default row", () => {
  const models = parseClaudeInitializeModels(CLAUDE_INITIALIZE_MODELS);
  assert.deepEqual(models.map((model) => [model.id, model.label]), [
    ["opus", "Opus 5.5"],
    ["fable", "Fable 5.2"],
    ["sonnet", "Sonnet 5.5"],
    ["haiku", "Haiku 5.5"],
    ["claude-opus-4-8", "Opus 4.8"],
    ["claude-haiku-4-5-20251001", "Haiku 4.5"]
  ]);
  assert.deepEqual(models.filter((model) => model.recommended).map((model) => model.id), ["opus"]);
  assert.equal(models[0].description, "For complex work and everyday tasks");
  assert.equal(models.every((model) => model.source === "cli"), true);
  assert.deepEqual(parseClaudeInitializeModels(undefined), []);
  assert.deepEqual(parseClaudeInitializeModels([null, "opus", { displayName: "No value" }]), []);
});

test("Claude model list marks one recommended model at most, names a model by its id when unnamed, and drops repeats", () => {
  const twoForDefault = parseClaudeInitializeModels([
    { value: "default", resolvedModel: "claude-opus-5-5" },
    { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5" },
    { value: "claude-opus-5-5", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5 (pinned)" },
    { value: "claude-sonnet-5" },
    { value: "claude-sonnet-5", displayName: "Sonnet 5 again" }
  ]);
  assert.deepEqual(twoForDefault.map((model) => [model.id, model.label, model.recommended]), [
    ["opus", "Opus 5.5", true],
    ["claude-opus-5-5", "Opus 5.5 (pinned)", false],
    ["claude-sonnet-5", "claude-sonnet-5", false]
  ]);
  const noDefault = parseClaudeInitializeModels([{ value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus" }]);
  assert.equal(noDefault[0].recommended, false);
});

test("Claude model list asks the CLI with one initialize request and no prompt, outside any project", async () => {
  const child = fakeClaudeChild();
  let launch: { command: string; args: readonly string[]; options: Record<string, any> } | undefined;
  const written: string[] = [];
  child.stdin.on("data", (chunk) => {
    written.push(String(chunk));
    const request = JSON.parse(String(chunk));
    queueMicrotask(() => {
      child.stdout.write("Warning: not JSON\n");
      child.stdout.write(`${JSON.stringify({ type: "system", subtype: "ui_invalidate" })}\n`);
      child.stdout.write(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "someone-else", response: { models: [] } } })}\n`);
      const answer = JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: request.request_id, response: { commands: [], models: CLAUDE_INITIALIZE_MODELS } } });
      // Split across chunks the way a large pipe write arrives.
      child.stdout.write(answer.slice(0, 40));
      child.stdout.write(`${answer.slice(40)}\n`);
    });
  });
  let stdinEnded = false;
  child.stdin.on("finish", () => { stdinEnded = true; });

  const answer = await runClaudeModelListProbe({
    executable: "/tmp/claude-stub",
    env: { PATH: "/usr/bin", CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: "1" },
    cwd: "/tmp/home",
    timeoutMs: 1_000,
    spawnClaude: ((command: string, args: readonly string[], options: Record<string, any>) => {
      launch = { command, args, options };
      return child;
    }) as any
  });

  assert.deepEqual(answer.models, CLAUDE_INITIALIZE_MODELS);
  assert.equal(launch?.command, "/tmp/claude-stub");
  assert.deepEqual(launch?.args, ["-p", "--safe-mode", "--no-chrome", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]);
  assert.equal(launch?.options.cwd, "/tmp/home");
  assert.equal(launch?.options.windowsHide, true);
  assert.equal(launch?.options.detached, process.platform !== "win32");
  assert.equal(launch?.options.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY, "1");
  assert.equal("CLAUDE_CODE_FORCE_SESSION_PERSISTENCE" in launch!.options.env, false);
  // The models first, then the settings it applies (its model, effort).
  assert.equal(written.length, 2);
  assert.deepEqual(JSON.parse(written[0]).request, { subtype: "initialize" });
  assert.deepEqual(JSON.parse(written[1]).request, { subtype: "get_settings" });
  await wait(5);
  assert.equal(stdinEnded, true);
});

test("Claude model list carries the settings Claude Code says it applies, and goes without them when it does not answer", async () => {
  const child = fakeClaudeChild();
  child.stdin.on("data", (chunk) => {
    const request = JSON.parse(String(chunk));
    const response = request.request.subtype === "initialize"
      ? { models: CLAUDE_INITIALIZE_MODELS, current_permission_mode: "acceptEdits" }
      : { effective: { model: "sonnet" }, applied: { model: "claude-sonnet-5-5", effort: "low" } };
    queueMicrotask(() => child.stdout.write(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: request.request_id, response } })}\n`));
  });
  const answer = await runClaudeModelListProbe({ executable: "/tmp/claude-stub", env: {}, cwd: "/tmp", timeoutMs: 1_000, spawnClaude: (() => child) as any });
  assert.equal(answer.current_permission_mode, "acceptEdits");
  assert.deepEqual(claudeAppliedSettings(answer.appliedSettings), { model: "claude-sonnet-5-5", effort: "low" });

  // An older Claude Code that never answers get_settings: the model list alone.
  const older = fakeClaudeChild();
  older.stdin.on("data", (chunk) => {
    const request = JSON.parse(String(chunk));
    if (request.request.subtype !== "initialize") return;
    queueMicrotask(() => older.stdout.write(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: request.request_id, response: { models: CLAUDE_INITIALIZE_MODELS } } })}\n`));
  });
  const alone = await runClaudeModelListProbe({ executable: "/tmp/claude-stub", env: {}, cwd: "/tmp", timeoutMs: 1_000, settingsTimeoutMs: 20, spawnClaude: (() => older) as any });
  assert.deepEqual(alone.models, CLAUDE_INITIALIZE_MODELS);
  assert.equal("appliedSettings" in alone, false);

  // One that refuses it, or exits after the list: the list alone too.
  const refusing = fakeClaudeChild();
  refusing.stdin.on("data", (chunk) => {
    const request = JSON.parse(String(chunk));
    const line = request.request.subtype === "initialize"
      ? { type: "control_response", response: { subtype: "success", request_id: request.request_id, response: { models: CLAUDE_INITIALIZE_MODELS } } }
      : { type: "control_response", response: { subtype: "error", request_id: request.request_id, error: "Unknown request" } };
    queueMicrotask(() => refusing.stdout.write(`${JSON.stringify(line)}\n`));
  });
  const refused = await runClaudeModelListProbe({ executable: "/tmp/claude-stub", env: {}, cwd: "/tmp", timeoutMs: 1_000, spawnClaude: (() => refusing) as any });
  assert.deepEqual(refused.models, CLAUDE_INITIALIZE_MODELS);
  assert.equal("appliedSettings" in refused, false);
  const exiting = fakeClaudeChild();
  exiting.stdin.on("data", (chunk) => {
    const request = JSON.parse(String(chunk));
    if (request.request.subtype !== "initialize") return;
    queueMicrotask(() => {
      exiting.stdout.write(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: request.request_id, response: { models: CLAUDE_INITIALIZE_MODELS } } })}\n`);
      setTimeout(() => { exiting.exitCode = 0; exiting.emit("close", 0); }, 5);
    });
  });
  const exited = await runClaudeModelListProbe({ executable: "/tmp/claude-stub", env: {}, cwd: "/tmp", timeoutMs: 1_000, spawnClaude: (() => exiting) as any });
  assert.deepEqual(exited.models, CLAUDE_INITIALIZE_MODELS);
});

test("a member without a model runs the one the User's config names: the list marks it, listed or not", () => {
  // Claude Code: her settings' model "sonnet" applies claude-sonnet-5-5.
  const sonnet = parseClaudeInitializeModels(CLAUDE_INITIALIZE_MODELS, "claude-sonnet-5-5");
  assert.deepEqual(sonnet.filter((model) => model.recommended).map((model) => model.id), ["sonnet"]);
  // Nothing in her settings: the account's default, as before.
  assert.deepEqual(parseClaudeInitializeModels(CLAUDE_INITIALIZE_MODELS, "claude-opus-5-5").filter((model) => model.recommended).map((model) => model.id), ["opus"]);
  // A model the list does not have is put first by its id.
  const custom = parseClaudeInitializeModels(CLAUDE_INITIALIZE_MODELS, "claude-custom-1");
  assert.deepEqual([custom[0]?.id, custom[0]?.recommended, custom.filter((model) => model.recommended).length], ["claude-custom-1", true, 1]);
  // Codex: model/list marks GPT-6-Luna default while config.toml runs gpt-5.6-luna.
  const codex = withCliStartModel([
    { id: "gpt-6-luna", label: "GPT-6-Luna (gpt-6-luna)", source: "cli", recommended: true },
    { id: "gpt-5.6-luna", label: "GPT-5.6-Luna (gpt-5.6-luna)", source: "cli", recommended: false }
  ], "gpt-5.6-luna");
  assert.deepEqual(codex.map((model) => [model.id, model.recommended]), [["gpt-6-luna", false], ["gpt-5.6-luna", true]]);
  assert.deepEqual(withCliStartModel(codex, undefined), codex, "no model in her config: the list as the CLI marked it");
});

test("Claude model list lets the CLI exit by itself, then stops it and its children", async () => {
  const polite = fakeClaudeChild();
  answerInitialize(polite, { models: CLAUDE_INITIALIZE_MODELS });
  polite.stdin.on("finish", () => { polite.exitCode = 0; polite.emit("close", 0); });
  await runClaudeModelListProbe({
    executable: "/tmp/claude-stub", env: {}, cwd: "/tmp", timeoutMs: 1_000, exitGraceMs: 10, killGraceMs: 10,
    spawnClaude: (() => polite) as any
  });
  await wait(40);
  assert.deepEqual(polite.signals, []);

  const stubborn = fakeClaudeChild();
  answerInitialize(stubborn, { models: CLAUDE_INITIALIZE_MODELS });
  await runClaudeModelListProbe({
    executable: "/tmp/claude-stub", env: {}, cwd: "/tmp", timeoutMs: 1_000, exitGraceMs: 10, killGraceMs: 10,
    spawnClaude: (() => stubborn) as any
  });
  assert.deepEqual(stubborn.signals, []);
  await wait(60);
  assert.deepEqual(stubborn.signals, ["SIGTERM", "SIGKILL"]);
});

test("Claude model list reads an answer the CLI ends without a newline", async () => {
  const child = fakeClaudeChild();
  answerInitialize(child, { models: CLAUDE_INITIALIZE_MODELS }, { trailingNewline: false });
  child.stdin.on("finish", () => undefined);
  setTimeout(() => { child.exitCode = 0; child.emit("close", 0); }, 20);
  const answer = await runClaudeModelListProbe({
    executable: "/tmp/claude-stub", env: {}, cwd: "/tmp", timeoutMs: 1_000, spawnClaude: (() => child) as any
  });
  assert.deepEqual(answer.models, CLAUDE_INITIALIZE_MODELS);
});

test("Claude model list fails plainly when the CLI exits, refuses, stays silent, floods, or cannot start", async () => {
  const exiting = fakeClaudeChild();
  const exited = runClaudeModelListProbe({
    executable: "/tmp/claude-stub", env: {}, cwd: "/tmp", timeoutMs: 1_000,
    spawnClaude: (() => {
      queueMicrotask(() => {
        exiting.stderr.write("Not logged in");
        setTimeout(() => { exiting.exitCode = 1; exiting.emit("close", 1); }, 5);
      });
      return exiting;
    }) as any
  });
  await assert.rejects(exited, /exited with code 1 before listing its models: Not logged in/);

  const refusing = fakeClaudeChild();
  refusing.stdin.on("data", (chunk) => {
    const request = JSON.parse(String(chunk));
    queueMicrotask(() => refusing.stdout.write(`${JSON.stringify({ type: "control_response", response: { subtype: "error", request_id: request.request_id, error: "unknown request" } })}\n`));
  });
  await assert.rejects(runClaudeModelListProbe({
    executable: "/tmp/claude-stub", env: {}, cwd: "/tmp", timeoutMs: 1_000, spawnClaude: (() => refusing) as any
  }), /did not list its models: unknown request/);

  const silent = fakeClaudeChild();
  await assert.rejects(runClaudeModelListProbe({
    executable: "/tmp/claude-stub", env: {}, cwd: "/tmp", timeoutMs: 20, exitGraceMs: 5, killGraceMs: 5, spawnClaude: (() => silent) as any
  }), (error: unknown) => error instanceof ClaudeModelListTimeoutError);
  await wait(40);
  assert.deepEqual(silent.signals, ["SIGTERM", "SIGKILL"]);

  const flooding = fakeClaudeChild();
  flooding.stdin.on("data", () => queueMicrotask(() => flooding.stdout.write("x".repeat(64))));
  await assert.rejects(runClaudeModelListProbe({
    executable: "/tmp/claude-stub", env: {}, cwd: "/tmp", timeoutMs: 1_000, maxOutputBytes: 16, spawnClaude: (() => flooding) as any
  }), /exceeded 16 bytes/);

  const missing = fakeClaudeChild();
  queueMicrotask(() => missing.emit("error", Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" })));
  await assert.rejects(runClaudeModelListProbe({
    executable: "/tmp/claude-stub", env: {}, cwd: "/tmp", timeoutMs: 1_000, spawnClaude: (() => missing) as any
  }), /ENOENT/);
});

test("Claude model catalog reads the /model picker only when the CLI answered without models", async () => {
  const runner = makeRunner() as any;
  let pickerReads = 0;
  cliParts(runner).modelCatalogs.requestClaudeInitializeAnswer = async () => ({ models: CLAUDE_INITIALIZE_MODELS });
  cliParts(runner).modelCatalogs.runClaudeModelProbe = async () => {
    pickerReads += 1;
    return "Select model 1. Default (recommended) ✔ Opus 4.8 2. Fable Fable 5 Enter to set · Esc to cancel";
  };
  const listed = await cliParts(runner).modelCatalogs.listClaudeModelCatalog("2026-11-20T00:00:00.000Z");
  assert.deepEqual(listed.models.map((model: { id: string }) => model.id), ["opus", "fable", "sonnet", "haiku", "claude-opus-4-8", "claude-haiku-4-5-20251001"]);
  assert.equal(listed.authoritative, true);
  assert.equal(pickerReads, 0);

  cliParts(runner).modelCatalogs.requestClaudeInitializeAnswer = async () => { throw new Error("initialize unsupported"); };
  const fromPicker = await cliParts(runner).modelCatalogs.listClaudeModelCatalog("2026-11-20T00:00:00.000Z");
  assert.deepEqual(fromPicker.models.map((model: { id: string }) => model.id), ["fable"]);
  assert.equal(pickerReads, 1);

  cliParts(runner).modelCatalogs.requestClaudeInitializeAnswer = async () => ({ models: [] });
  await cliParts(runner).modelCatalogs.listClaudeModelCatalog("2026-11-20T00:00:00.000Z");
  assert.equal(pickerReads, 2);

  // A CLI that did not answer in time is not asked again through its picker.
  cliParts(runner).modelCatalogs.requestClaudeInitializeAnswer = async () => { throw new ClaudeModelListTimeoutError(""); };
  await assert.rejects(cliParts(runner).modelCatalogs.listClaudeModelCatalog("2026-11-20T00:00:00.000Z"), ClaudeModelListTimeoutError);
  assert.equal(pickerReads, 2);

  // Both reads empty: the error names the initialize failure, not only the picker.
  cliParts(runner).modelCatalogs.requestClaudeInitializeAnswer = async () => { throw new Error("Claude Code exited with code 1 before listing its models: boom"); };
  cliParts(runner).modelCatalogs.runClaudeModelProbe = async () => "nothing here";
  await assert.rejects(cliParts(runner).modelCatalogs.listClaudeModelCatalog("2026-11-20T00:00:00.000Z"), /did not list any models\. Claude Code exited with code 1 before listing its models: boom/);
});

test("A signed-out Claude Code model list is shown but read again next time", async (t) => {
  if (process.platform === "win32") {
    t.skip("the Windows catalog path keeps its own exact-catalog rules");
    return;
  }
  const runner = makeRunner() as any;
  let reads = 0;
  let account: Record<string, unknown> = { tokenSource: "none", apiProvider: "firstParty" };
  cliParts(runner).modelCatalogs.requestClaudeInitializeAnswer = async () => {
    reads += 1;
    return { account, models: [{ value: "default", resolvedModel: "opus" }, { value: "opus", resolvedModel: "opus", displayName: "Opus" }] };
  };
  const signedOut = await runner.listModelCatalog("claude-code");
  assert.deepEqual(signedOut.models.map((model: { id: string }) => model.id), ["opus"]);
  assert.equal(signedOut.authoritative, false);
  account = { subscriptionType: "Claude Ultra", apiProvider: "firstParty" };
  const signedIn = await runner.listModelCatalog("claude-code");
  assert.equal(signedIn.authoritative, true);
  await runner.listModelCatalog("claude-code");
  assert.equal(reads, 2);
});

test("Windows Claude catalogs never add configured or hard-coded fallback models", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows-specific exact catalog behavior");
    return;
  }
  const runner = makeRunner() as any;
  cliParts(runner).modelCatalogs.listClaudeModelCatalog = async (fetchedAt: string) => ({
    kind: "claude-code",
    models: [{ id: "account-offered", label: "Account offered", source: "cli" }],
    authoritative: true,
    fetchedAt
  });
  const catalog = await runner.listModelCatalog("claude-code", "configured-but-not-offered");
  assert.deepEqual(catalog.models.map((model: { id: string }) => model.id), ["account-offered"]);
  const cachedCatalog = await runner.listModelCatalog("claude-code", "configured-but-not-offered");
  assert.deepEqual(cachedCatalog.models.map((model: { id: string }) => model.id), ["account-offered"]);

  cliParts(runner).modelCatalogs.modelCatalogs.clear();
  cliParts(runner).modelCatalogs.listClaudeModelCatalog = async () => { throw new Error("picker unavailable"); };
  const failed = await runner.listModelCatalog("claude-code", "configured-but-not-offered");
  assert.deepEqual(failed.models, []);
  assert.equal(failed.authoritative, false);
});

test("Codex model catalog handles server requests and rejects external-token refresh contract drift", async () => {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-codex-model-catalog-"));
  const originalCwd = process.cwd();
  const codexPath = await writeCodexAppServerFixture(fixtureDir, `#!/usr/bin/env node
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
let initializeId;
let modelListId;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    if (message.params?.capabilities?.requestAttestation !== false) process.exit(61);
    initializeId = message.id;
    send({ id: "current-time", method: "currentTime/read", params: {} });
  } else if (message.id === "current-time") {
    if (typeof message.result?.currentTimeAt !== "number") process.exit(62);
    send({ id: initializeId, result: { userAgent: "fake-codex", platformFamily: "unix", platformOsName: "macos", platformArch: "arm64" } });
  } else if (message.method === "config/read") {
    send({ id: message.id, error: { code: -32601, message: "method not found" } });
  } else if (message.method === "model/list") {
    modelListId = message.id;
    send({ id: "token-refresh", method: "account/chatgptAuthTokens/refresh", params: { reason: "unauthorized", previousAccountId: null } });
  } else if (message.id === "token-refresh") {
    if (message.error?.code !== -32601 || !String(message.error?.message).includes("never supplies external ChatGPT tokens")) process.exit(63);
    send({ id: modelListId, result: { data: [{ id: "gpt-fixture", displayName: "Fixture", isDefault: true }], nextCursor: null } });
  } else if (message.method === "account/login/start") {
    process.exit(64);
  }
});
`);
  process.chdir(fixtureDir);
  const runner = new CliAgentRunner(undefined, undefined, codexPath);
  try {
    const catalog = await runner.listModelCatalog("codex-cli");
    assert.equal(catalog.authoritative, true, catalog.error);
    assert.equal(catalog.models[0]?.id, "gpt-fixture");
    // A Codex that cannot say its config: the list as it marked it, no start defaults.
    assert.equal(catalog.startDefaults, undefined);
    assert.equal(catalog.models[0]?.recommended, true);
  } finally {
    await runner.shutdownWarmAgents();
    process.chdir(originalCwd);
    await rm(fixtureDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("Codex model catalog names the model, effort and mode the User's config.toml starts Codex in", async () => {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-codex-start-defaults-"));
  const originalCwd = process.cwd();
  const codexPath = await writeCodexAppServerFixture(fixtureDir, `#!/usr/bin/env node
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex" } });
  } else if (message.method === "model/list") {
    send({ id: message.id, result: { data: [
      { id: "gpt-6-luna", displayName: "GPT-6-Luna", isDefault: true, defaultReasoningEffort: "medium" },
      { id: "gpt-5.6-luna", displayName: "GPT-5.6-Luna", isDefault: false, defaultReasoningEffort: "medium" }
    ], nextCursor: null } });
  } else if (message.method === "config/read") {
    send({ id: message.id, result: { config: { model: "gpt-5.6-luna", model_reasoning_effort: "low", approvals_reviewer: "auto_review", approval_policy: null, sandbox_mode: null } } });
  }
});
`);
  process.chdir(fixtureDir);
  const runner = new CliAgentRunner(undefined, undefined, codexPath);
  try {
    const catalog = await runner.listModelCatalog("codex-cli");
    assert.equal(catalog.authoritative, true, catalog.error);
    assert.deepEqual(catalog.models.filter((model) => model.recommended).map((model) => model.id), ["gpt-5.6-luna"]);
    assert.deepEqual(catalog.startDefaults, { access: "auto-review", model: "gpt-5.6-luna", modelLabel: "GPT-5.6-Luna", reasoningEffort: "low" });
  } finally {
    await runner.shutdownWarmAgents();
    process.chdir(originalCwd);
    await rm(fixtureDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("a Codex config with a read-only sandbox starts the main session in Read Only, whoever reviews its asks", async () => {
  // Her config.toml with sandbox_mode = "read-only" added: Codex 0.155.1's
  // config/read answers it so (approvals_reviewer from guardian_subagent).
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-codex-start-read-only-"));
  const originalCwd = process.cwd();
  const codexPath = await writeCodexAppServerFixture(fixtureDir, `#!/usr/bin/env node
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex" } });
  } else if (message.method === "model/list") {
    send({ id: message.id, result: { data: [{ id: "gpt-5.6-luna", displayName: "GPT-5.6-Luna", isDefault: true }], nextCursor: null } });
  } else if (message.method === "config/read") {
    send({ id: message.id, result: { config: { model: "gpt-5.6-luna", approvals_reviewer: "auto_review", approval_policy: null, sandbox_mode: "read-only" } } });
  }
});
`);
  process.chdir(fixtureDir);
  const runner = new CliAgentRunner(undefined, undefined, codexPath);
  try {
    const catalog = await runner.listModelCatalog("codex-cli");
    assert.equal(catalog.authoritative, true, catalog.error);
    assert.equal(catalog.startDefaults?.access, "read-only", "never Ask for approval, which edits the workspace");
  } finally {
    await runner.shutdownWarmAgents();
    process.chdir(originalCwd);
    await rm(fixtureDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("Claude Code's catalog names the model, effort and mode her settings start it in", async () => {
  const runner = makeRunner() as any;
  cliParts(runner).modelCatalogs.requestClaudeInitializeAnswer = async () => ({
    models: CLAUDE_INITIALIZE_MODELS,
    current_permission_mode: "acceptEdits",
    appliedSettings: { applied: { model: "claude-sonnet-5-5", effort: "xhigh" } }
  });
  const catalog = await cliParts(runner).modelCatalogs.listClaudeModelCatalog("2026-11-22T00:00:00.000Z");
  assert.deepEqual(catalog.models.filter((model: { recommended?: boolean }) => model.recommended).map((model: { id: string }) => model.id), ["sonnet"]);
  assert.deepEqual(catalog.startDefaults, { access: "acceptEdits", model: "sonnet", modelLabel: "Sonnet 5.5", reasoningEffort: "xhigh" });
  // Bypass Permissions is not a mode the composer offers: Manual, which
  // asks before anything her settings do not allow.
  cliParts(runner).modelCatalogs.requestClaudeInitializeAnswer = async () => ({ models: CLAUDE_INITIALIZE_MODELS, current_permission_mode: "bypassPermissions" });
  const bypass = await cliParts(runner).modelCatalogs.listClaudeModelCatalog("2026-11-22T00:00:00.000Z");
  assert.equal(bypass.startDefaults?.access, "manual");
});

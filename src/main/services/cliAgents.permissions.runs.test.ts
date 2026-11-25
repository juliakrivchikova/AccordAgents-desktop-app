import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { cliParts } from "./cliAgents/test/cliParts";
import { claudeReasoningEffort } from "./cliAgents/claude/launch";
import { codexReasoningEffort } from "./cliAgents/codex/appServerParams";
import { commandErrorText } from "./cliAgents/runs/outputText";
import { agentRunEnv, withAppMcpClientStatus } from "./cliAgents/runs/runEnvironment";
import { warmAgentKey } from "./cliAgents/warm/warmKeys";
import { CommandError } from "./command";
import { CODEX_APP_SERVER_MCP_TOKEN_ENV } from "./codexExec";
import { makeRunner } from "./cliAgents/test/runnerFixtures";

// Claude Code's own config on this computer (Claude in Chrome, for one) must
// not decide these tests: an empty config folder is a fresh Claude Code.
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), "aa-claude-config-"));

test("a session log's context: subagent lines skipped, the CLI's own window kept for the same model only", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "accordagents-claude-known-"));
  try {
    const runner = makeRunner();
    const internals = cliParts(runner).sessionLogs as unknown as { findClaudeSessionLogPath(sessionId: string): Promise<string | undefined> };
    const call = (model: string, input: number, extra: Record<string, unknown> = {}): string =>
      JSON.stringify({ type: "assistant", ...extra, message: { model, usage: { input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: input - 2, output_tokens: 9 } } });
    const file = path.join(dir, "session.jsonl");
    // The member's last call, then a subagent's (older CLIs wrote those into the same log).
    await writeFile(file, `${call("claude-haiku-4-5", 97_902)}\n${call("claude-sonnet-5-5", 150_000, { isSidechain: true })}\n`);
    internals.findClaudeSessionLogPath = async () => file;
    const claude = { id: "claude-known", kind: "claude-code" as const, label: "Claude", model: "haiku" };
    const plain = await runner.contextUsageForSession(claude, "s", { waitForLog: false });
    assert.deepEqual([plain?.usedTokens, plain?.contextWindowTokens, plain?.model], [97_902, 200_000, "claude-haiku-4-5"], "the member's call, not the subagent's");
    const stored = { usedTokens: 1, percentage: 0, source: "claude-code" as const, updatedAt: "2026-11-22T00:00:00.000Z" };
    // The window the CLI named for this model at the last turn wins over the map...
    const same = await runner.contextUsageForSession(claude, "s", { waitForLog: false, known: { ...stored, contextWindowTokens: 1_000_000, model: "claude-haiku-4-5", windowFromCli: true } });
    assert.equal(same?.contextWindowTokens, 1_000_000);
    assert.equal(same?.windowFromCli, true);
    // A window an older build stored (the map's, or another model's entry) is not kept.
    const legacy = await runner.contextUsageForSession(claude, "s", { waitForLog: false, known: { ...stored, contextWindowTokens: 1_000_000, model: "claude-haiku-4-5" } });
    assert.equal(legacy?.contextWindowTokens, 200_000);
    // ...but not another model's, nor another CLI's.
    const other = await runner.contextUsageForSession(claude, "s", { waitForLog: false, known: { ...stored, contextWindowTokens: 1_000_000, model: "claude-sonnet-5-5", windowFromCli: true } });
    assert.equal(other?.contextWindowTokens, 200_000);
    const codex = await runner.contextUsageForSession(claude, "s", { waitForLog: false, known: { ...stored, source: "codex-cli", contextWindowTokens: 258_400, model: "claude-haiku-4-5", windowFromCli: true } });
    assert.equal(codex?.contextWindowTokens, 200_000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("agentRunEnv filters blocked manual keys and preserves app MCP token precedence", () => {
  const env = agentRunEnv({
    agentEnv: {
      AA_MANUAL_AGENT_ENV_TEST: "manual",
      PATH: "/manual/bin",
      ACCORD_AGENTS_INTERNAL: "blocked",
      [CODEX_APP_SERVER_MCP_TOKEN_ENV]: "manual-token"
    },
    appMcp: {
      token: "per-run-token"
    }
  } as never);

  assert.equal(env?.AA_MANUAL_AGENT_ENV_TEST, "manual");
  assert.equal(env?.PATH, undefined);
  assert.equal(env?.ACCORD_AGENTS_INTERNAL, undefined);
  assert.equal(env?.[CODEX_APP_SERVER_MCP_TOKEN_ENV], "per-run-token");
});

test("warmAgentKey changes when the manual agent environment version changes", () => {
  const participant = {
    id: "participant-1",
    kind: "codex",
    model: "gpt-5",
    reasoningEffort: "medium"
  };
  const baseOptions = {
    extraReadableDirs: ["/tmp/workspace"],
    warm: {
      conversationId: "conversation-1",
      participantId: "participant-1",
      contextKey: "prompt-context-v1"
    }
  };

  const firstKey = warmAgentKey(participant as never, "/tmp/repo", "chat", {
    ...baseOptions,
    agentEnvKey: "agent-env-v1"
  } as never);
  const secondKey = warmAgentKey(participant as never, "/tmp/repo", "chat", {
    ...baseOptions,
    agentEnvKey: "agent-env-v2"
  } as never);
  const repeatedFirstKey = warmAgentKey(participant as never, "/tmp/repo", "chat", {
    ...baseOptions,
    agentEnvKey: "agent-env-v1"
  } as never);

  assert.notEqual(firstKey, secondKey);
  assert.equal(firstKey, repeatedFirstKey);
  assert.equal(JSON.parse(firstKey).agentEnvKey, "agent-env-v1");
  assert.equal(JSON.parse(secondKey).agentEnvKey, "agent-env-v2");
});

test("a Chrome switch waits for a busy member process instead of the member waiting for it", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "accordagents-chrome-defer-"));
  try {
    await writeFile(path.join(dir, ".claude.json"), JSON.stringify({ claudeInChromeDefaultEnabled: true }));
    const runner = makeRunner() as any;
    const warm = { conversationId: "c1", participantId: "p1", contextKey: "", idleTimeoutMs: 1 };
    const options = { agentEnv: { CLAUDE_CONFIG_DIR: dir }, warm };
    const runningKey = warmAgentKey({ id: "p1", kind: "claude-code" } as never, "/r", "chat", { warm });
    let idle = false;
    cliParts(runner).warmAgents.entries.set(runningKey, { key: runningKey, scopeKey: "c1:p1", closed: false, isIdle: () => idle });
    const member = { id: "p1", kind: "claude-code" };
    const chrome = async (runOptions: Record<string, unknown>, kind = "chat") => (await cliParts(runner).claudeSettings.withClaudeChrome(member, "/r", kind, runOptions)).claudeChrome;
    assert.equal(await chrome(options), false, "busy (a background task): it keeps what it started with");
    assert.equal(await chrome({ ...options, nativeGoal: { objective: "x" } }), true, "a goal runs in its own process: the setting as it is now");
    assert.equal(await chrome({ ...options, warm: { ...warm, contextKey: "changed" } }), true, "other settings changed too: the process is replaced anyway");
    idle = true;
    assert.equal(await chrome(options), true, "idle: its next turn gets the new setting");
    assert.equal(await chrome({ agentEnv: { CLAUDE_CONFIG_DIR: dir } }), true, "a one-shot run reads it too");
    assert.equal(await chrome({ agentEnv: { CLAUDE_CONFIG_DIR: dir }, isolated: true }), undefined, "the app's own runs never get it");
    assert.equal(await chrome({ agentEnv: { CLAUDE_CONFIG_DIR: dir } }, "general"), undefined, "nor runs that are not a chat member's");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a changed agent environment closes only member processes that hold no work", async () => {
  const runner = makeRunner() as any;
  const closed: string[] = [];
  cliParts(runner).warmAgentClose.closeWarmAgent = async (entry: { key: string; closed: boolean }, reason: string) => {
    entry.closed = true;
    closed.push(`${entry.key}:${reason}`);
  };
  const entry = (key: string, extra: Record<string, unknown> = {}) => ({ key, scopeKey: key, closed: false, queue: Promise.resolve(), ...extra });
  cliParts(runner).warmAgents.entries.set("idle-claude", entry("idle-claude", { isIdle: () => true }));
  cliParts(runner).warmAgents.entries.set("answering-claude", entry("answering-claude", { isIdle: () => false }));
  cliParts(runner).warmAgents.entries.set("background-claude", entry("background-claude", { isIdle: () => false, hasLiveBackgroundWork: () => true }));
  cliParts(runner).warmAgents.entries.set("idle-codex", entry("idle-codex"));
  const codex: Record<string, unknown> = entry("running-codex");
  cliParts(runner).warmAgents.entries.set("running-codex", codex);
  let finish!: () => void;
  const turn = cliParts(runner).warmAgents.enqueueWarmRun(codex, () => new Promise<void>((resolve) => { finish = resolve; }));

  await runner.retireIdleWarmAgents("environment-changed");
  assert.deepEqual(closed.sort(), ["idle-claude:environment-changed", "idle-codex:environment-changed"]);
  assert.deepEqual([...cliParts(runner).warmAgents.entries.keys()].sort(), ["answering-claude", "background-claude", "running-codex"],
    "a reply in progress, background tasks and a running turn keep their process");
  assert.equal(cliParts(runner).warmAgents.warmShutdown, undefined, "new turns are not refused meanwhile");

  finish();
  await turn;
  assert.equal(codex.activeRuns, 0);
  await runner.retireIdleWarmAgents("environment-changed");
  assert.ok(closed.includes("running-codex:environment-changed"), "once its turn is over it holds no work");
});

test("an environment change waits for a busy member process instead of the member waiting for it", () => {
  const runner = makeRunner() as any;
  const member = { id: "p1", kind: "claude-code" };
  const warm = { conversationId: "c1", participantId: "p1", contextKey: "", idleTimeoutMs: 1 };
  const runningKey = warmAgentKey(member as never, "/r", "chat", { warm, agentEnvKey: "v1" });
  let idle = false;
  cliParts(runner).warmAgents.entries.set(runningKey, { key: runningKey, scopeKey: "c1:p1", closed: false, isIdle: () => idle });
  const envKey = (runOptions: Record<string, unknown>, kind = "chat") =>
    cliParts(runner).warmAgents.withBusyMemberEnvironment(member, "/r", kind, runOptions).agentEnvKey;
  const options = { warm, agentEnvKey: "v2" };
  assert.equal(envKey(options), "v1", "busy (a background task): its messages go into the session already running");
  assert.equal(warmAgentKey(member as never, "/r", "chat", { ...options, agentEnvKey: envKey(options) }), runningKey);
  assert.equal(envKey({ ...options, nativeGoal: { objective: "x" } }), "v2", "a goal runs in its own process: the values as they are now");
  assert.equal(envKey({ ...options, warm: { ...warm, contextKey: "changed" } }), "v2", "other settings changed too: the process is replaced anyway");
  assert.equal(envKey({ ...options, warm: { ...warm, participantId: "p2" } }), "v2", "another member's busy process changes nothing");
  idle = true;
  assert.equal(envKey(options), "v2", "idle: its next turn gets the new values");
});

test("reasoning effort mapping is provider-specific", () => {
  const runner = makeRunner() as any;

  assert.equal(codexReasoningEffort("minimal"), "minimal");
  assert.equal(codexReasoningEffort("max"), "max");
  assert.equal(codexReasoningEffort("ultra"), "ultra");
  assert.equal(codexReasoningEffort("invalid" as never), undefined);
  assert.equal(claudeReasoningEffort("xhigh"), "xhigh");
  assert.equal(claudeReasoningEffort("max"), "max");
  assert.equal(claudeReasoningEffort("ultra"), undefined);
  assert.equal(claudeReasoningEffort("minimal"), undefined);
});

test("withAppMcpClientStatus warns and flags unestablished app MCP generations", () => {
  const runner = makeRunner() as any;
  const participant = {
    id: "codex",
    kind: "codex-cli" as const,
    label: "@codex",
    model: undefined
  };
  const result = withAppMcpClientStatus({
    participant,
    ok: true,
    content: "done"
  }, participant, {
    appMcp: {
      url: "http://127.0.0.1:1/mcp",
      token: "token",
      toolNames: ["app_chat_request_participants"],
      clientGenerationId: "generation-1",
      clientStatus: () => ({
        initialized: false,
        listedTools: false,
        requiredToolsPresent: false,
        missingToolNames: ["app_chat_request_participants"],
        errored: false
      })
    }
  });

  assert.equal(result.appMcpClientFailed, true);
  assert.equal(result.warnings!.some((warning: string) => warning.includes("app tools did not finish MCP setup")), true);
});

test("withAppMcpClientStatus does not warn for healthy warm reuse after setup", () => {
  const runner = makeRunner() as any;
  const participant = {
    kind: "codex-cli",
    label: "@codex",
    model: undefined
  };
  const options = {
    appMcp: {
      url: "http://127.0.0.1:1/mcp",
      token: "token",
      toolNames: ["app_chat_request_participants"],
      clientGenerationId: "generation-healthy",
      clientStatus: () => ({
        initialized: true,
        listedTools: true,
        requiredToolsPresent: true,
        missingToolNames: [],
        errored: false
      })
    }
  };

  for (let turn = 0; turn < 3; turn += 1) {
    const result = withAppMcpClientStatus({
      participant,
      ok: true,
      content: `turn ${turn}`
    } as never, participant as never, options);

    assert.equal(result.appMcpClientFailed, undefined);
    assert.equal(result.warnings, undefined);
  }
});

test("commandErrorText surfaces structured result errors", () => {
  const runner = makeRunner() as any;
  const error = new CommandError("claude exited with code 1", {
    command: "claude",
    args: [],
    stdout: JSON.stringify({
      type: "result",
      is_error: true,
      result: "You've hit your session limit; resets 4:10pm"
    }),
    stderr: "",
    exitCode: 1,
    timedOut: false
  });

  const message = commandErrorText(error);

  assert.match(message, /You've hit your session limit/);
  assert.doesNotMatch(message, /Last events: result\./);
});

test("failed keeps raw CLI diagnostics out of visible chat content", () => {
  const runner = makeRunner() as any;
  const error = new CommandError("codex timed out after 1800000ms", {
    command: "codex",
    args: [],
    stdout: "",
    stderr: [
      "2026-06-16T09:48:01.929525Z ERROR rmcp::transport::worker: worker quit with fatal:",
      "Transport channel closed, when AuthRequired(AuthRequiredError {",
      "www_authenticate_header: \"Bearer resource_metadata=\\\"https://mcp.slack.com/.well-known/oauth-protected-resource\\\"\" })"
    ].join("\n"),
    exitCode: null,
    timedOut: true
  });

  const result = cliParts(runner).cliRuns.failed({ label: "@sam-codex-qa-lead" } as any, error);

  assert.equal(result.content, "@sam-codex-qa-lead could not finish because the Slack MCP server needs authorization.");
  assert.match(result.error, /AuthRequired/);
  assert.doesNotMatch(result.content, /AuthRequired|Transport channel closed|1800000ms/);
});

test("failed formats CLI timeout content in human-readable time", () => {
  const runner = makeRunner() as any;

  const result = cliParts(runner).cliRuns.failed(
    { label: "@sam-codex-qa-lead" } as any,
    new Error("codex app-server timed out after 86400000ms")
  );

  assert.equal(result.content, "@sam-codex-qa-lead timed out after 24 hours.");
  assert.match(result.error, /86400000ms/);
});

test("host admission waits count as busy and a Stop during the wait never starts the provider", async () => {
  const runner = makeRunner();
  const participant = { id: "host-admission", kind: "codex-cli" as const, label: "Codex" };
  let admit!: (value: { admitted: true }) => void;
  runner.setHostAdmission(() => new Promise(resolve => { admit = resolve; }));
  let executions = 0;
  (cliParts(runner).codexRuns as unknown as { runCodex(): Promise<unknown> }).runCodex = async () => { executions++; throw new Error("must not execute"); };
  const abort = new AbortController();
  const running = runner.run(participant, "held", undefined, undefined, "chat", abort.signal);
  assert.equal(runner.hasActiveNativeWork(), true);
  assert.equal(runner.fenceIdleNativeAdmissions(), undefined);
  abort.abort();
  admit({ admitted: true });
  const result = await running;
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /cancelled before native execution/);
  assert.equal(executions, 0);
  assert.equal(runner.hasActiveNativeWork(), false);
  runner.setHostAdmission(async () => { throw new Error("coordination disk unavailable"); });
  assert.match((await runner.run(participant, "refused", undefined, undefined, "chat")).error ?? "", /coordination disk unavailable/);
  assert.equal(executions, 0);
});

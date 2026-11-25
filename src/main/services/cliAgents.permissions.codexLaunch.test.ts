import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { cliParts } from "./cliAgents/test/cliParts";
import {
  claudeAutoAllowedAppMcpTools, claudePermissionPromptArgs, claudeToolConfig, shouldPassClaudeAllowedTools
} from "./cliAgents/claude/launch";
import {
  codexAppServerThreadResumeParams, codexAppServerThreadStartParams, codexModelReasoningEfforts, codexPrompt
} from "./cliAgents/codex/appServerParams";
import { buildCodexExecInvocation } from "./codexExec";
import { isCodexCollaborationModeRefusal } from "./cliAgents";
import { defaultChatAgentPermissions } from "../../shared/agentPermissions";
import { chatOptions, makeRunner, ownModeOptions } from "./cliAgents/test/runnerFixtures";

// Claude Code's own config on this computer (Claude in Chrome, for one) must
// not decide these tests: an empty config folder is a fresh Claude Code.
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), "aa-claude-config-"));

for (const kind of ["claude-code", "codex-cli"] as const) {
  test(`${kind}: context usage for a session whose log is gone is read once when asked not to wait`, async () => {
    const runner = makeRunner();
    const participant = { id: `${kind}-missing-log`, kind, label: kind };
    const reads: string[] = [];
    const lookups = cliParts(runner).sessionLogs as Record<"findClaudeSessionLogPath" | "findCodexSessionLogPath", (sessionId: string) => Promise<string | undefined>>;
    lookups[kind === "claude-code" ? "findClaudeSessionLogPath" : "findCodexSessionLogPath"] = async (sessionId) => {
      reads.push(sessionId);
      return undefined;
    };

    assert.equal(await runner.contextUsageForSession(participant, "gone-session", { waitForLog: false }), undefined);
    assert.deepEqual(reads, ["gone-session"]);

    // The default still waits for a log that may not be written yet (after a turn or a compaction).
    reads.length = 0;
    assert.equal(await runner.contextUsageForSession(participant, "fresh-session"), undefined);
    assert.ok(reads.length > 1, `the default retries a missing log (read ${reads.length} times)`);
  });
}

test("a Codex rollout's context is its latest token count with usage, read from the end", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "accordagents-codex-rollout-"));
  try {
    const runner = makeRunner();
    const internals = cliParts(runner).sessionLogs as unknown as { findCodexSessionLogPath(sessionId: string): Promise<string | undefined> };
    const count = (total: number, window: number): string => JSON.stringify({ type: "event_msg", payload: { type: "token_count",
      info: { total_token_usage: { total_tokens: 9_999_999 }, last_token_usage: { total_tokens: total }, model_context_window: window } } });
    const file = path.join(dir, "rollout-x-s.jsonl");
    await writeFile(file, [
      count(151_216, 258_400),
      JSON.stringify({ type: "response_item", payload: { type: "message", content: "token_count is just a word here" } }),
      count(23_410, 258_400),
      // Rate limits only, then a line still being written.
      JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: null, rate_limits: {} } }),
      "{\"type\":\"event_msg\",\"payload\":{\"type\":\"token_c"
    ].join("\n"));
    internals.findCodexSessionLogPath = async () => file;
    const usage = await runner.contextUsageForSession({ id: "codex", kind: "codex-cli", label: "Codex" }, "s", { waitForLog: false });
    assert.deepEqual([usage?.usedTokens, usage?.contextWindowTokens, usage?.percentage], [23_410, 258_400, 5]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("codex app-server auto mode applies workspace-write web preset and native auto reviewer", () => {
  const runner = makeRunner() as any;
  const participant = {
    kind: "codex-cli",
    label: "@codex",
    model: undefined,
    reasoningEffort: "xhigh"
  };
  const params = codexAppServerThreadStartParams(
    participant as never,
    "/repo",
    "chat",
    chatOptions({
      agentMode: "auto",
      workspaceWrite: false,
      webAccess: false
    })
  );

  assert.equal(params.approvalPolicy, "on-request");
  assert.equal(params.approvalsReviewer, "auto_review");
  assert.equal(params.sandbox, "workspace-write");
  assert.equal((params.config as any).web_search, "live");
  assert.equal((params.config as any).model_reasoning_effort, "xhigh");
});

test("every non-interactive Codex exec path explicitly disables approvals", () => {
  for (const options of [
    { agentMode: "default" as const },
    { agentMode: "plan" as const, sessionId: "session-1" },
    { agentMode: "auto" as const, remoteSandbox: { networkAccess: true, gitWritableRoot: "/tmp/repo" } }
  ]) {
    const invocation = buildCodexExecInvocation({
      participant: { id: "participant", kind: "codex-cli", label: "Codex" },
      prompt: "Prompt",
      outputPath: "/tmp/output",
      repoPath: "/tmp/repo",
      kind: "chat",
      options
    });
    assert.equal(invocation.args.includes('approval_policy="never"'), true, invocation.args.join(" "));
  }
});

test("codex exec carries a member's provider -c overrides on fresh and resumed sessions, never the key", () => {
  const participant = {
    id: "participant",
    kind: "codex-cli" as const,
    label: "Codex",
    model: "glm-5.3",
    codexConfigOverrides: [
      'model_provider="accordagents_host"',
      'model_providers.accordagents_host.base_url="https://api.z.ai/api/v1"',
      'model_providers.accordagents_host.wire_api="responses"',
      'model_providers.accordagents_host.env_key="CODEX_PROVIDER_HOST_API_KEY"'
    ]
  };
  const fresh = buildCodexExecInvocation({ participant, prompt: "Prompt", outputPath: "/tmp/output", repoPath: "/tmp/repo", kind: "chat", options: { agentMode: "default" } });
  const resumed = buildCodexExecInvocation({ participant, prompt: "Prompt", outputPath: "/tmp/output", repoPath: "/tmp/repo", kind: "chat", options: { agentMode: "default", sessionId: "session-1" } });
  for (const [label, invocation] of [["fresh", fresh], ["resumed", resumed]] as const) {
    const args = invocation.args;
    for (const override of participant.codexConfigOverrides) {
      const index = args.indexOf(override);
      assert.ok(index > 0, `${label}: ${override} missing in ${args.join(" ")}`);
      assert.equal(args[index - 1], "-c", label);
      // Options precede the prompt placeholder / session id, as codex requires.
      assert.ok(index < args.lastIndexOf("-"), `${label}: override after prompt in ${args.join(" ")}`);
    }
    assert.equal(args.some((arg) => /CODEX_PROVIDER_HOST_API_KEY=/.test(arg) || /zai-secret/.test(arg)), false, label);
  }
  assert.equal(resumed.args.indexOf("session-1") > resumed.args.lastIndexOf("-c"), true, "resume: session id stays after -c options");
});

test("Codex catalog preserves max and ultra and their default recommendation", () => {
  const runner = makeRunner() as any;
  const options = codexModelReasoningEfforts({
    defaultReasoningEffort: "max",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra", "invalid", "ultra"].map(
      (reasoningEffort) => ({ reasoningEffort, description: `Use ${reasoningEffort}` })
    )
  });
  assert.deepEqual(options.map((option: any) => option.id), ["low", "medium", "high", "xhigh", "max", "ultra"]);
  assert.deepEqual(options.slice(-2), [
    { id: "max", label: "Max", description: "Use max", recommended: true },
    { id: "ultra", label: "Ultra", description: "Use ultra", recommended: false }
  ]);
  assert.deepEqual(codexModelReasoningEfforts(undefined), []);
});

test("Codex max and ultra reach fresh and resumed local and remote invocations", () => {
  const runner = makeRunner() as any;
  for (const reasoningEffort of ["max", "ultra"] as const) {
    const participant = { id: "participant", kind: "codex-cli" as const, label: "Codex", model: "gpt-6-astra", reasoningEffort };
    const options = chatOptions({ agentMode: "auto", workspaceWrite: true });
    const start = codexAppServerThreadStartParams(participant, "/repo", "chat", options);
    const resume = codexAppServerThreadResumeParams("session-1", participant, "/repo", "chat", options);
    assert.equal((start.config as any).model_reasoning_effort, reasoningEffort);
    assert.equal((resume.config as any).model_reasoning_effort, reasoningEffort);
    for (const sessionId of [undefined, "session-1"]) {
      const invocation = buildCodexExecInvocation({
        participant,
        prompt: "Prompt",
        outputPath: "/tmp/output",
        repoPath: "/repo",
        kind: "chat",
        options: { ...options, sessionId, remoteSandbox: { networkAccess: true, gitWritableRoot: "/repo" } }
      });
      assert.ok(invocation.args.includes(`model_reasoning_effort="${reasoningEffort}"`));
    }
  }
});

test("codex app-server resume re-asserts the auto preset so a mode switch applies without a fresh session", () => {
  const runner = makeRunner() as any;
  const participant = {
    kind: "codex-cli",
    label: "@codex",
    model: undefined
  };
  const params = codexAppServerThreadResumeParams(
    "session-1",
    participant as never,
    "/repo",
    "chat",
    chatOptions({
      agentMode: "auto",
      workspaceWrite: false,
      webAccess: false
    })
  );

  // Resuming the existing session still launches under the new Auto-review profile,
  // so switching to auto mid-chat takes effect without dropping the session.
  assert.equal(params.threadId, "session-1");
  assert.equal(params.approvalPolicy, "on-request");
  assert.equal(params.approvalsReviewer, "auto_review");
  assert.equal(params.sandbox, "workspace-write");
  assert.equal((params.config as any).web_search, "live");
});

test("a Codex chat turn is the member's message as it is: no per-turn envelope, whatever the mode", () => {
  const runner = makeRunner() as any;
  for (const agentMode of ["default", "plan", "auto"] as const) {
    const prompt = codexPrompt("Fix the flaky test.", "/repo", undefined, "chat", chatOptions({ agentMode, workspaceWrite: false, canRequestPermissions: true }));
    assert.equal(prompt, "Fix the flaky test.");
  }
  assert.equal(codexPrompt("Hi.", undefined, undefined, "chat", chatOptions({ agentMode: "default", workspaceWrite: false, canRequestPermissions: false })), "Hi.");
});

test("Codex Ask for approval and Read Only (sessions view) ask the User through approval cards (on-request, reviewer the User); Approve for me lets Codex review; Full Access never asks; the classic controls never ask", () => {
  const runner = makeRunner() as any;
  const participant = { kind: "codex-cli", label: "@codex", model: undefined };
  const readOnly = codexAppServerThreadStartParams(participant as never, "/repo", "chat", ownModeOptions("default", false));
  assert.equal(readOnly.sandbox, "read-only");
  assert.equal(readOnly.approvalPolicy, "on-request", "Codex's Read Only preset: approval to edit or go online");
  assert.equal(readOnly.approvalsReviewer, "user", "the User answers, even when her Codex config routes asks to auto-review");
  const workspace = codexAppServerThreadResumeParams("thread-1", participant as never, "/repo", "chat", ownModeOptions("default", true));
  assert.equal(workspace.sandbox, "workspace-write");
  assert.equal(workspace.approvalPolicy, "on-request", "Codex's Ask for approval preset, on resume too");
  assert.equal(workspace.approvalsReviewer, "user");
  const auto = codexAppServerThreadStartParams(participant as never, "/repo", "chat", ownModeOptions("auto", false));
  assert.equal(auto.approvalPolicy, "on-request");
  assert.equal(auto.approvalsReviewer, "auto_review", "Approve for me");
  assert.equal(auto.sandbox, "workspace-write");
  const full = codexAppServerThreadStartParams(participant as never, "/repo", "chat", ownModeOptions("full-access", false));
  assert.equal(full.sandbox, "danger-full-access", "Codex's Full Access preset");
  assert.equal(full.approvalPolicy, "never");
  assert.equal(full.approvalsReviewer, null);
  assert.equal(codexAppServerThreadResumeParams("thread-1", participant as never, "/repo", "chat", ownModeOptions("full-access", false)).sandbox, "danger-full-access", "on resume too");
  // A member saved in Plan before Plan was its own toggle: Read Only, asking.
  const legacyPlan = codexAppServerThreadStartParams(participant as never, "/repo", "chat", ownModeOptions("plan", true));
  assert.equal(legacyPlan.sandbox, "read-only");
  assert.equal(legacyPlan.approvalPolicy, "on-request");
  const classic = codexAppServerThreadStartParams(participant as never, "/repo", "chat", chatOptions({ agentMode: "default", workspaceWrite: true }));
  assert.equal(classic.approvalPolicy, "never", "classic: unchanged");
  assert.equal(classic.approvalsReviewer, null, "classic: unchanged");
  const classicPlan = codexAppServerThreadStartParams(participant as never, "/repo", "chat", chatOptions({ agentMode: "plan", workspaceWrite: true }));
  assert.deepEqual([classicPlan.sandbox, classicPlan.approvalPolicy], ["read-only", "never"], "the classic Plan: unchanged");
});

test("Codex's Plan mode is its collaboration mode, said on every turn (a thread keeps the last one), with the thread's model; off, its Default mode with the member's effort", () => {
  const runner = makeRunner() as any;
  const participant = { kind: "codex-cli", label: "@codex", model: undefined, reasoningEffort: "high" };
  const planned = { ...ownModeOptions("default", true), permissions: { ...ownModeOptions("default", true).permissions, codexPlanMode: true as const } };
  assert.deepEqual(cliParts(runner).codexRuns.codexCollaborationMode(participant, "chat", planned, "gpt-6-luna"),
    { mode: "plan", settings: { model: "gpt-6-luna", reasoning_effort: null, developer_instructions: null } }, "Codex's own effort for Plan mode");
  assert.equal(codexAppServerThreadStartParams(participant as never, "/repo", "chat", planned).sandbox, "workspace-write", "the preset stays under Plan mode");
  assert.deepEqual(cliParts(runner).codexRuns.codexCollaborationMode(participant, "chat", ownModeOptions("default", true), "gpt-6-luna"),
    { mode: "default", settings: { model: "gpt-6-luna", reasoning_effort: "high", developer_instructions: null } }, "off: Default, turning a thread's Plan off");
  // No effort of its own: the thread's, which Codex took from her
  // config.toml (thread/start's reasoningEffort): her terminal's "low", never
  // reset by a null to the model's own.
  const noEffort = { ...participant, reasoningEffort: undefined };
  assert.equal(cliParts(runner).codexRuns.codexCollaborationMode(noEffort, "chat", ownModeOptions("default", true), "gpt-5.6-luna", "low").settings.reasoning_effort, "low");
  assert.equal(cliParts(runner).codexRuns.codexCollaborationMode(noEffort, "chat", planned, "gpt-5.6-luna", "low").settings.reasoning_effort, null, "Plan mode: Codex's own effort for it");
  assert.equal(cliParts(runner).codexRuns.codexCollaborationMode(participant, "chat", ownModeOptions("default", true), "gpt-5.6-luna", "low").settings.reasoning_effort, "high", "the member's own wins");
  // Her config's effort, as Codex said it with its list, also when the
  // thread came back from a turn in Plan mode without one.
  cliParts(runner).modelCatalogs.modelCatalogs.set("codex-cli", { catalog: { kind: "codex-cli", models: [], authoritative: true, fetchedAt: "t", startDefaults: { reasoningEffort: "low" } }, expiresAt: Date.now() + 60_000 });
  assert.equal(cliParts(runner).codexRuns.codexCollaborationMode(noEffort, "chat", ownModeOptions("default", true), "gpt-5.6-luna", undefined).settings.reasoning_effort, "low");
  // A model of the member's own, or an added provider: the thread's effort
  // (Codex's own choice for it), never her config's.
  assert.equal(cliParts(runner).codexRuns.codexCollaborationMode({ ...noEffort, model: "gpt-6-luna" }, "chat", ownModeOptions("default", true), "gpt-6-luna", "medium").settings.reasoning_effort, "medium");
  assert.equal(cliParts(runner).codexRuns.codexCollaborationMode({ ...noEffort, codexConfigOverrides: ['model_provider="accordagents_host"'] }, "chat", ownModeOptions("default", true), "glm-5.3", undefined).settings.reasoning_effort, null);
  cliParts(runner).modelCatalogs.modelCatalogs.delete("codex-cli");
  assert.equal(cliParts(runner).codexRuns.codexCollaborationMode({ ...participant, model: "gpt-5.6-terra" }, "chat", planned, "gpt-6-luna").settings.model, "gpt-5.6-terra", "the member's own model");
  assert.equal(cliParts(runner).codexRuns.codexCollaborationMode(participant, "chat", planned, undefined), undefined, "no model known: nothing said");
  assert.equal(cliParts(runner).codexRuns.codexCollaborationMode(participant, "chat", ownModeOptions("plan", true), "m").mode, "plan", "a member saved in Plan from before");
  assert.equal(cliParts(runner).codexRuns.codexCollaborationMode(participant, "chat", chatOptions({ agentMode: "default", workspaceWrite: true }), "m").mode, "default", "classic: Default");
  assert.equal(cliParts(runner).codexRuns.codexCollaborationMode(participant, "code-review", planned, "m"), undefined, "chat turns only");
});

test("Codex's Full Access is not a Claude Code or Antigravity mode: a Claude member given it launches exactly as in Auto", () => {
  const runner = makeRunner() as any;
  const full = ownModeOptions("full-access", false);
  const auto = ownModeOptions("auto", false);
  assert.equal(claudeToolConfig("chat", "/repo", [], full).permissionMode, "auto");
  assert.deepEqual(claudePermissionPromptArgs("chat", full), claudePermissionPromptArgs("chat", auto), "its asks still reach the app's cards");
  assert.equal(shouldPassClaudeAllowedTools("chat", full), shouldPassClaudeAllowedTools("chat", auto));
  const config = claudeToolConfig("chat", "/repo", [], full);
  assert.deepEqual(claudeAutoAllowedAppMcpTools("chat", full, config), claudeAutoAllowedAppMcpTools("chat", auto, claudeToolConfig("chat", "/repo", [], auto)),
    "its app tools are pre-approved as in Auto");
});

test("Codex's Full Access runs only as the User's menu sets it (the CLI's own mode); anywhere else no wider than Auto", () => {
  const runner = makeRunner() as any;
  const participant = { kind: "codex-cli", label: "@codex", model: undefined };
  const classic = codexAppServerThreadStartParams(participant as never, "/repo", "chat", chatOptions({ agentMode: "full-access", workspaceWrite: false }));
  assert.notEqual(classic.sandbox, "danger-full-access", "never outside the sandbox without her menu's choice");
  assert.equal(classic.sandbox, "workspace-write");
  const exec = buildCodexExecInvocation({ participant: participant as any, prompt: "p", outputPath: "/tmp/o", repoPath: "/tmp/r", kind: "chat", options: { agentMode: "full-access", permissions: { ...defaultChatAgentPermissions(), cliApprovals: true } } });
  assert.equal(exec.args[exec.args.indexOf("--sandbox") + 1], "danger-full-access", "codex exec: Full Access in its own mode");
  const execClassic = buildCodexExecInvocation({ participant: participant as any, prompt: "p", outputPath: "/tmp/o", repoPath: "/tmp/r", kind: "chat", options: { agentMode: "full-access", permissions: defaultChatAgentPermissions() } });
  assert.notEqual(execClassic.args[execClassic.args.indexOf("--sandbox") + 1], "danger-full-access", "codex exec: not without it");
});

test("a Codex that refuses the collaboration mode is told apart from other errors", () => {
  assert.equal(isCodexCollaborationModeRefusal("Invalid params: unknown field `collaborationMode`"), true);
  assert.equal(isCodexCollaborationModeRefusal("collaboration_mode is experimental and requires experimentalApi"), true);
  assert.equal(isCodexCollaborationModeRefusal("turn not found"), false);
  assert.equal(isCodexCollaborationModeRefusal("invalid model gpt-x"), false);
});

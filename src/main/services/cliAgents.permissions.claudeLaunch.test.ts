import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CLAUDE_APP_MCP_TOOL_TIMEOUT_MS, CliAgentRunner } from "./cliAgents";
import { cliParts } from "./cliAgents/test/cliParts";
import {
  claudeAllowedToolsArgs, claudeLaunchArgs, claudeMcpArgs, claudePermissionPromptArgs, claudeToolConfig, claudeToolsArgs,
  redactedClaudeArgs
} from "./cliAgents/claude/launch";
import { claudePermissionDenials } from "./cliAgents/claude/output";
import { agentRunEnv } from "./cliAgents/runs/runEnvironment";
import { warmAgentKey } from "./cliAgents/warm/warmKeys";
import { claudeMainThreadContext, isClaudeCompactBoundary } from "./cliContextUsage";
import { buildAgentContextUsage, contextWindowForModel } from "../../shared/agentContext";
import { APP_TOOL_PERMISSION_WAIT_MS } from "../../shared/appMcpToolContracts";
import { chatOptions, makeRunner, ownModeOptions } from "./cliAgents/test/runnerFixtures";

// Claude Code's own config on this computer (Claude in Chrome, for one) must
// not decide these tests: an empty config folder is a fresh Claude Code.
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), "aa-claude-config-"));

test("Claude context usage read from the end of the log matches reading the whole log", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "accordagents-claude-log-"));
  try {
    const runner = makeRunner();
    const claude = { id: "claude-log", kind: "claude-code" as const, label: "Claude", model: "claude-opus-5-5" };
    const usage = (input: number): string => JSON.stringify({ type: "assistant", message: { model: "claude-opus-5-5", usage: { input_tokens: input, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 10 } } });
    const boundary = JSON.stringify({ type: "system", subtype: "compact_boundary" });
    const filler = JSON.stringify({ type: "user", message: { content: "п".repeat(300_000) } });
    const internals = cliParts(runner).sessionLogs as unknown as {
      findClaudeSessionLogPath(sessionId: string): Promise<string | undefined>;
    };
    // The whole-log reading this replaced: the last usage after the last compaction boundary.
    const wholeLog = (content: string): unknown => {
      let latest: { usedTokens?: number; model?: string } | undefined;
      for (const line of content.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as unknown;
          if (isClaudeCompactBoundary(event)) {
            latest = undefined;
            continue;
          }
          latest = claudeMainThreadContext(event) ?? latest;
        } catch {
          // partial line
        }
      }
      return latest && buildAgentContextUsage({
        usedTokens: latest.usedTokens,
        contextWindowTokens: contextWindowForModel("claude-code", latest.model),
        source: "claude-code",
        model: latest.model
      });
    };
    const cases: Record<string, string[]> = {
      "usage then filler": [usage(1000), filler, usage(52_000), filler, "{\"type\":\"last-prompt\"}"],
      "usage before a boundary only": [usage(90_000), boundary, filler],
      "usage after a boundary": [usage(90_000), boundary, usage(12_000), "{partial"],
      "no usage at all": [filler, "not json"]
    };
    const results: Record<string, number | undefined> = {};
    for (const [name, lines] of Object.entries(cases)) {
      const content = `${lines.join("\n")}\n`;
      const file = path.join(dir, `${name.replace(/ /g, "-")}.jsonl`);
      await writeFile(file, content);
      internals.findClaudeSessionLogPath = async () => file;
      const fromEnd = await runner.contextUsageForSession(claude, "session", { waitForLog: false });
      const strip = (value: unknown): unknown => value && typeof value === "object" ? { ...(value as Record<string, unknown>), updatedAt: undefined } : value;
      assert.deepEqual(strip(fromEnd), strip(wholeLog(content)), name);
      results[name] = (fromEnd as { usedTokens?: number } | undefined)?.usedTokens;
    }
    assert.deepEqual(results, {
      "usage then filler": 52_000,
      "usage before a boundary only": undefined,
      "usage after a boundary": 12_000,
      "no usage at all": undefined
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a Claude member started with Claude in Chrome gets --chrome and its own process key", () => {
  const runner = makeRunner() as any;
  const options = chatOptions({ agentMode: "default", workspaceWrite: false });
  const config = claudeToolConfig("chat", "/selected/repo", [], options);
  const launch = (claudeChrome?: boolean) => claudeLaunchArgs(
    { id: "claude-1", kind: "claude-code", label: "@claude" }, "chat", { ...options, claudeChrome }, config, [], "warm", "session-1"
  ) as string[];
  assert.equal(launch(true).includes("--chrome"), true);
  assert.equal(launch(false).includes("--chrome"), false);
  assert.equal(launch(undefined).includes("--chrome"), false);
  const participant = { id: "claude-1", kind: "claude-code" };
  const warm = { conversationId: "c1", participantId: "claude-1", contextKey: "k" };
  assert.notEqual(warmAgentKey(participant as never, "/r", "chat", { warm, claudeChrome: true } as never), warmAgentKey(participant as never, "/r", "chat", { warm } as never),
    "switching it starts the next turn in a new process");
  assert.equal(warmAgentKey(participant as never, "/r", "chat", { warm, claudeChrome: false } as never), warmAgentKey(participant as never, "/r", "chat", { warm } as never),
    "off keeps the key processes already had");
});

function claudeAllowedToolsFromArgs(args: string[]): string[] {
  const index = args.indexOf("--allowedTools");
  return index >= 0 ? (args[index + 1] ?? "").split(",").filter(Boolean) : [];
}

test("claude launch diagnostics redact MCP tokens, inline settings, and role instructions", () => {
  const runner = makeRunner() as any;
  const args = [
    "-p",
    "--mcp-config",
    "{\"headers\":{\"Authorization\":\"Bearer secret-token\"}}",
    "--settings",
    "{\"permissions\":{\"ask\":[\"Bash(secret-path)\"]}}",
    "--append-system-prompt",
    "private instructions",
    "--add-dir",
    "/repo/history"
  ];

  const redacted = redactedClaudeArgs(args) as string[];
  assert.equal(redacted.join(" ").includes("secret-token"), false);
  assert.equal(redacted.join(" ").includes("secret-path"), false);
  assert.equal(redacted.join(" ").includes("private instructions"), false);
  assert.ok(redacted.includes("/repo/history"));
  assert.equal(redacted.filter((value) => value === "<redacted>").length, 3);
});

test("claude denial diagnostics retain only categorical layer evidence", () => {
  const runner = makeRunner() as any;
  const secretCanary = "CANARY_SECRET /private/target $(cat ~/.ssh/id_ed25519)";
  const denials = claudePermissionDenials(JSON.stringify({
    permission_denials: [
      { tool_name: "Write", reason: secretCanary, input: { file_path: "/secret/file" } },
      { tool_name: "Bash", stage: "sandbox", decision_code: "sandbox_denied", message: secretCanary },
      { tool_name: "Read", stage: "novel-runtime-stage", decision_reason: secretCanary }
    ]
  }));

  assert.deepEqual(denials, [
    {
      toolName: "Write",
      layer: "provider-native-permission-or-classifier",
      decisionCode: "permission_denied"
    },
    {
      toolName: "Bash",
      layer: "provider-sandbox-settings-or-os",
      decisionCode: "sandbox_denied"
    },
    {
      toolName: "Read",
      layer: "unknown-provider-runtime",
      decisionCode: "permission_denied",
      missingEvidence: ["recognized denial stage/category"]
    }
  ]);
  assert.equal(JSON.stringify(denials).includes("/secret/file"), false);
  assert.equal(JSON.stringify(denials).includes(secretCanary), false);
});

test("claude denial diagnostics do not warn for a successful Auto classifier decision", () => {
  const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const runner = new CliAgentRunner({
    async write(event, payload) {
      events.push({ event, payload });
    }
  }) as any;
  const participant = { id: "claude-1", kind: "claude-code", label: "@claude" };
  const raw = {
    permission_denials: [{ tool_name: "Write", reason: "private target path" }]
  };
  const success = cliParts(runner).claudeSettings.withClaudePermissionDenialWarning({
    participant,
    ok: true,
    content: "Handled safely.",
    durationMs: 1
  }, raw, participant, "one-shot");
  const failure = cliParts(runner).claudeSettings.withClaudePermissionDenialWarning({
    participant,
    ok: false,
    content: "Failed.",
    error: "failed",
    durationMs: 1
  }, raw, participant, "one-shot");

  assert.equal(success.warnings, undefined);
  assert.equal(failure.warnings.length, 1);
  assert.match(failure.warnings[0], /native permission\/classifier layer/);
  assert.equal(JSON.stringify(events).includes("private target path"), false);
});

test("claudeToolConfig maps default + workspaceWrite=true to acceptEdits", () => {
  const runner = makeRunner() as any;
  const config = claudeToolConfig("chat", "/repo", [], chatOptions({
    agentMode: "default",
    workspaceWrite: true
  }));
  assert.equal(config.permissionMode, "acceptEdits");
  assert.ok(config.tools.includes("Write"));
  assert.ok(config.tools.includes("Edit"));
  assert.equal(config.disallowedTools.includes("Write"), false);
  assert.equal(config.disallowedTools.includes("Edit"), false);
});

test("claudeToolConfig maps default + workspaceWrite=false to default and disallows editors", () => {
  const runner = makeRunner() as any;
  const config = claudeToolConfig("chat", "/repo", [], chatOptions({
    agentMode: "default",
    workspaceWrite: false
  }));
  assert.equal(config.permissionMode, "default");
  assert.equal(config.tools.includes("Write"), false);
  assert.equal(config.tools.includes("Edit"), false);
  assert.ok(config.disallowedTools.includes("Write"));
  assert.ok(config.disallowedTools.includes("Edit"));
  assert.equal(config.disallowedTools.includes("MultiEdit"), false);
  assert.ok(config.disallowedTools.includes("NotebookEdit"));
});

test("claudeToolConfig auto-allows web tools when webAccess is true", () => {
  const runner = makeRunner() as any;
  const config = claudeToolConfig("chat", "/repo", [], chatOptions({
    agentMode: "default",
    workspaceWrite: false,
    webAccess: true
  }));
  assert.ok(config.tools.includes("WebSearch"));
  assert.ok(config.tools.includes("WebFetch"));
  assert.ok(config.allowedTools.includes("WebSearch"));
  assert.ok(config.allowedTools.includes("WebFetch"));
  assert.equal(config.disallowedTools.includes("WebSearch"), false);
  assert.equal(config.disallowedTools.includes("WebFetch"), false);
});

test("claudeToolConfig disallows web tools when webAccess is false", () => {
  const runner = makeRunner() as any;
  const config = claudeToolConfig("chat", "/repo", [], chatOptions({
    agentMode: "default",
    workspaceWrite: false,
    webAccess: false
  }));
  assert.equal(config.tools.includes("WebSearch"), false);
  assert.equal(config.tools.includes("WebFetch"), false);
  assert.equal(config.allowedTools.includes("WebSearch"), false);
  assert.equal(config.allowedTools.includes("WebFetch"), false);
  assert.ok(config.disallowedTools.includes("WebSearch"));
  assert.ok(config.disallowedTools.includes("WebFetch"));
});

test("claudeToolConfig auto mode uses native auto permission mode with Bash available", () => {
  const runner = makeRunner() as any;
  const config = claudeToolConfig("chat", "/repo", [], chatOptions({
    agentMode: "auto",
    workspaceWrite: false,
    webAccess: false
  }));
  assert.equal(config.permissionMode, "auto");
  assert.ok(config.tools.includes("Write"));
  assert.ok(config.tools.includes("Edit"));
  assert.ok(config.tools.includes("WebSearch"));
  assert.ok(config.tools.includes("WebFetch"));
  assert.ok(config.allowedTools.includes("WebSearch"));
  assert.ok(config.allowedTools.includes("WebFetch"));
  // Bash is available so the native auto classifier can decide each command; it is
  // neither broadly allowlisted (that would bypass the classifier) nor disallowed.
  assert.ok(config.tools.includes("Bash"));
  assert.equal(config.allowedTools.includes("Bash"), false);
  assert.equal(config.disallowedTools.includes("Bash"), false);
});

test("claudeToolConfig auto mode ignores all stored shell rules", () => {
  const runner = makeRunner() as any;
  const config = claudeToolConfig("chat", "/repo", [], chatOptions({
    agentMode: "auto",
    workspaceWrite: false,
    webAccess: false,
    shell: {
      enabled: true,
      rules: [
        { action: "deny", match: "prefix", pattern: "rm -rf" },
        { action: "allow", match: "prefix", pattern: "curl" },
        { action: "ask", match: "exact", pattern: "git push" }
      ]
    }
  }));
  assert.equal(config.permissionMode, "auto");
  assert.ok(config.tools.includes("Bash"));
  assert.equal(config.disallowedTools.some((tool: string) => tool.includes("rm -rf")), false);
  assert.equal(config.allowedTools.some((tool: string) => tool.includes("curl")), false);
  assert.equal(config.askTools.some((tool: string) => tool.includes("git push")), false);
  assert.equal(config.allowedTools.includes("Bash"), false);
});

test("claudeToolConfig leaves plan agent mode untouched regardless of workspaceWrite", () => {
  const runner = makeRunner() as any;
  const planNoWrite = claudeToolConfig("chat", "/repo", [], chatOptions({
    agentMode: "plan",
    workspaceWrite: false
  }));
  const planWithWrite = claudeToolConfig("chat", "/repo", [], chatOptions({
    agentMode: "plan",
    workspaceWrite: true
  }));
  assert.equal(planNoWrite.permissionMode, "plan");
  assert.equal(planWithWrite.permissionMode, "plan");
  // plan mode disables workspaceWrite via effective permissions, so editors stay disallowed
  assert.ok(planWithWrite.disallowedTools.includes("Write"));
});

test("claudeToolConfig enables native Skill tool without selected skills", () => {
  const runner = makeRunner() as any;
  const chatConfig = claudeToolConfig("chat", "/repo", [], chatOptions({
    agentMode: "default",
    workspaceWrite: false
  }));
  const reviewConfig = claudeToolConfig("code-review", "/repo", [], chatOptions({
    agentMode: "default",
    workspaceWrite: false
  }));

  assert.ok(chatConfig.tools.includes("Skill"));
  assert.ok(chatConfig.allowedTools.includes("Skill"));
  assert.ok(reviewConfig.tools.includes("Skill"));
  assert.ok(reviewConfig.allowedTools.includes("Skill"));
});

test("claudeToolConfig enables subagent spawning (Agent/Task) across kinds", () => {
  const runner = makeRunner() as any;
  const configs = [
    claudeToolConfig("chat", "/repo", [], chatOptions({ agentMode: "default", workspaceWrite: false })),
    claudeToolConfig("chat", "/repo", [], chatOptions({ agentMode: "auto", workspaceWrite: false })),
    claudeToolConfig("general", "/repo", [], chatOptions({ agentMode: "default", workspaceWrite: false })),
    claudeToolConfig("code-review", "/repo", [], chatOptions({ agentMode: "default", workspaceWrite: false })),
    claudeToolConfig("implementation-plan", "/repo", [], chatOptions({ agentMode: "default", workspaceWrite: false }))
  ];

  for (const config of configs) {
    for (const tool of ["Agent", "Task"]) {
      assert.ok(config.tools.includes(tool), `tools should include ${tool}`);
      assert.ok(config.allowedTools.includes(tool), `allowedTools should include ${tool}`);
      assert.equal(config.disallowedTools.includes(tool), false, `disallowedTools should not include ${tool}`);
    }
  }
});

test("claude chat MCP config is additive and does not pass strict or closed tools", () => {
  const runner = makeRunner() as any;
  const options = chatOptions({
    agentMode: "default",
    workspaceWrite: false,
    canRequestPermissions: true,
    appToolNames: ["app_permissions_request_change", "app_tool_permission"]
  });
  const config = claudeToolConfig("chat", "/repo", [], options);
  const mcpArgs = claudeMcpArgs("chat", options);
  const toolsArgs = claudeToolsArgs("chat", config, options);

  assert.deepEqual(mcpArgs.slice(0, 1), ["--mcp-config"]);
  assert.equal(mcpArgs.includes("--strict-mcp-config"), false);
  assert.deepEqual(toolsArgs, []);
  const parsed = JSON.parse(mcpArgs[1]);
  assert.equal(parsed.mcpServers.accord_agents.type, "http");
  assert.equal(parsed.mcpServers.accord_agents.url, "http://127.0.0.1:1/mcp");
  // Claude Code waits for the User's answer on a permission card as long as
  // the card waits (its default gave up after 60 s), for the app's server
  // only: the User's own MCP servers keep Claude Code's defaults.
  assert.equal(parsed.mcpServers.accord_agents.timeout, APP_TOOL_PERMISSION_WAIT_MS + 5 * 60_000);
  assert.equal(CLAUDE_APP_MCP_TOOL_TIMEOUT_MS > APP_TOOL_PERMISSION_WAIT_MS, true, "the app answers first");
  assert.equal(Object.keys(agentRunEnv(options) ?? {}).includes("MCP_TOOL_TIMEOUT"), false);
});

test("claude default chat delegates unmatched tool approvals to app_tool_permission", () => {
  const runner = makeRunner() as any;
  const options = chatOptions({
    agentMode: "default",
    workspaceWrite: false,
    canRequestPermissions: true,
    appToolNames: ["app_permissions_request_change", "app_tool_permission"]
  });

  assert.deepEqual(claudePermissionPromptArgs("chat", options), [
    "--permission-prompt-tool",
    "mcp__accord_agents__app_tool_permission"
  ]);
});

test("claude auto chat preauthorizes the eligible exposed app MCP inventory only", () => {
  const runner = makeRunner() as any;
  const eligibleAppTools = [
    "mcp__accord_agents__app_chat_get_context",
    "mcp__accord_agents__app_chat_get_participants",
    "mcp__accord_agents__app_chat_get_participant_activity",
    "mcp__accord_agents__app_chat_get_participant_request_status",
    "mcp__accord_agents__app_chat_read_messages",
    "mcp__accord_agents__app_chat_list_attachments",
    "mcp__accord_agents__app_chat_read_attachment",
    "mcp__accord_agents__app_chat_react",
    "mcp__accord_agents__app_chat_send_message",
    "mcp__accord_agents__app_chat_set_title",
    "mcp__accord_agents__app_permissions_request_change"
  ];
  const options = chatOptions({
    agentMode: "auto",
    workspaceWrite: false,
    webAccess: true,
    canRequestPermissions: true,
    appToolNames: [
      "app_chat_get_context",
      "app_chat_get_participants",
      "app_chat_get_participant_activity",
      "app_chat_get_participant_request_status",
      "app_chat_read_messages",
      "app_chat_list_attachments",
      "app_chat_read_attachment",
      "app_chat_export_attachment",
      "app_chat_react",
      "app_chat_send_message",
      "app_chat_set_title",
      "app_permissions_request_change",
      "app_tool_permission"
    ]
  });
  const config = claudeToolConfig("chat", "/repo", [], options);
  const args = claudeAllowedToolsArgs("chat", options, config);
  const allowedTools = claudeAllowedToolsFromArgs(args);

  assert.equal(config.allowedTools.length > 0, true);
  assert.deepEqual(args.slice(0, 1), ["--allowedTools"]);
  assert.deepEqual(allowedTools, eligibleAppTools);
  for (const tool of [
    "mcp__accord_agents__app_chat_export_attachment",
    "mcp__accord_agents__app_tool_permission",
    "Bash",
    "Edit",
    "Write",
    "NotebookEdit",
    "WebSearch",
    "WebFetch"
  ]) {
    assert.equal(allowedTools.includes(tool), false, `${tool} should not be auto-allowed`);
  }
  assert.deepEqual(claudePermissionPromptArgs("chat", options), [
    "--permission-prompt-tool",
    "mcp__accord_agents__app_tool_permission"
  ]);
});

test("claude Plan and non-chat runs do not receive the chat permission prompt bridge", () => {
  const runner = makeRunner() as any;
  const plan = chatOptions({
    agentMode: "plan",
    workspaceWrite: false,
    appToolNames: ["app_tool_permission"]
  });
  const auto = chatOptions({
    agentMode: "auto",
    workspaceWrite: true,
    appToolNames: ["app_tool_permission"]
  });

  assert.deepEqual(claudePermissionPromptArgs("chat", plan), []);
  assert.deepEqual(claudePermissionPromptArgs("single" as never, auto), []);
});

test("claude auto app MCP preauthorization is deny-by-default and intersects exposed tools", () => {
  const runner = makeRunner() as any;
  const options = chatOptions({
    agentMode: "auto",
    workspaceWrite: false,
    canRequestPermissions: true,
    appToolNames: ["app_artifact_create", "app_chat_export_attachment", "app_tool_permission"],
    autoPreauthorizedToolNames: ["app_artifact_create", "app_unexposed", "app_chat_export_attachment", "app_tool_permission"]
  });
  const config = claudeToolConfig("chat", "/repo", [], options);
  const allowedTools = claudeAllowedToolsFromArgs(claudeAllowedToolsArgs("chat", options, config));

  assert.deepEqual(allowedTools, [
    "mcp__accord_agents__app_artifact_create",
    "mcp__accord_agents__app_chat_export_attachment"
  ]);
  assert.equal(allowedTools.includes("mcp__accord_agents__app_tool_permission"), false);

  const noClassification = {
    ...options,
    appMcp: { ...options.appMcp, autoPreauthorizedToolNames: undefined }
  };
  assert.deepEqual(claudeAllowedToolsArgs(
    "chat",
    noClassification as never,
    claudeToolConfig("chat", "/repo", [], noClassification as never)
  ), []);
});

test("claude production launch-argv matrix preserves Auto authority across session paths", () => {
  const runner = makeRunner() as any;
  const participant = {
    id: "claude-1",
    kind: "claude-code",
    label: "@claude",
    model: undefined,
    reasoningEffort: undefined
  };
  const base = chatOptions({
    agentMode: "auto",
    workspaceWrite: true,
    webAccess: true,
    canRequestPermissions: true,
    appToolNames: ["app_artifact_create", "app_chat_export_attachment", "app_tool_permission"]
  });
  const scenarios: Array<{
    name: string;
    transport: "one-shot" | "warm";
    options: any;
    newSessionId?: string;
  }> = [
    { name: "cold", transport: "one-shot", options: base, newSessionId: "new-session" },
    { name: "warm", transport: "warm", options: base, newSessionId: "warm-session" },
    { name: "idle-respawn", transport: "warm", options: base, newSessionId: "idle-respawn-session" },
    { name: "resume", transport: "one-shot", options: { ...base, sessionId: "resume-session" } },
    { name: "retry-fallback", transport: "one-shot", options: { ...base, warm: undefined }, newSessionId: "retry-session" },
    { name: "participant-request", transport: "warm", options: base, newSessionId: "request-session" },
    { name: "restored-session", transport: "one-shot", options: { ...base, sessionId: "restored-session" } }
  ];

  for (const scenario of scenarios) {
    const config = claudeToolConfig("chat", "/selected/repo", ["/chat-history"], scenario.options);
    const args = claudeLaunchArgs(
      participant as never,
      "chat",
      scenario.options,
      config,
      ["/chat-history"],
      scenario.transport,
      scenario.newSessionId
    ) as string[];
    const allowedTools = claudeAllowedToolsFromArgs(args);

    assert.deepEqual(allowedTools, ["mcp__accord_agents__app_artifact_create"], scenario.name);
    assert.equal(args.includes("--tools"), false, scenario.name);
    assert.equal(args.includes("--disallowedTools"), false, scenario.name);
    assert.equal(args.includes("/outside/explicit-target.txt"), false, scenario.name);
    assert.equal(args.includes("--add-dir"), true, scenario.name);
    assert.equal(args.includes("/chat-history"), true, scenario.name);
    assert.equal(
      args.filter((arg) => arg === "--permission-mode").length,
      1,
      `${scenario.name}: permission mode flag count`
    );
    assert.equal(args[args.indexOf("--permission-mode") + 1], "auto", scenario.name);
    assert.equal(
      args.filter((arg) => arg === "--permission-prompt-tool").length,
      1,
      `${scenario.name}: permission prompt flag count`
    );
    assert.equal(
      args[args.indexOf("--permission-prompt-tool") + 1],
      "mcp__accord_agents__app_tool_permission",
      scenario.name
    );
    for (const nativeTool of ["Bash", "Edit", "Write", "Read", "WebSearch", "Skill", "Agent", "Task"]) {
      assert.equal(allowedTools.includes(nativeTool), false, `${scenario.name}:${nativeTool}`);
    }
    if (scenario.options.sessionId) {
      assert.equal(args.includes("--resume"), true, scenario.name);
    }
  }
});

test("claude outside-directory parity fixture adds no app path denial or writable root", () => {
  const runner = makeRunner() as any;
  const options = chatOptions({
    agentMode: "auto",
    workspaceWrite: true,
    webAccess: true,
    canRequestPermissions: true,
    appToolNames: ["app_artifact_create"]
  });
  const config = claudeToolConfig("chat", "/selected/repo", ["/chat-history"], options);
  const args = claudeLaunchArgs(
    { id: "claude-1", kind: "claude-code", label: "@claude" },
    "chat",
    options,
    config,
    ["/chat-history"],
    "one-shot",
    "session-1"
  ) as string[];
  const serialized = JSON.stringify(args);

  assert.equal(config.permissionMode, "auto");
  assert.deepEqual(config.disallowedTools, []);
  assert.deepEqual(config.askTools, []);
  assert.equal(serialized.includes("/outside/explicit-target.txt"), false);
  assert.equal(serialized.includes("sandbox.filesystem.allowWrite"), false);
  assert.equal(serialized.includes("writable_roots"), false);
});

test("claude native goal uses one streaming print invocation", () => {
  const runner = makeRunner() as any;
  const options = {
    ...chatOptions({
      agentMode: "auto",
      workspaceWrite: true,
      webAccess: true
    }),
    nativeGoal: { name: "goal", objective: "finish the task" }
  };
  const config = claudeToolConfig("chat", "/repo", [], options as never);
  const args = claudeLaunchArgs(
    { id: "claude-1", kind: "claude-code", label: "@claude" },
    "chat",
    options as never,
    config,
    [],
    "one-shot-stream",
    "session-1"
  ) as string[];

  assert.equal(args.filter((value) => value === "-p").length, 1);
  assert.equal(args.includes("--include-partial-messages"), true);
  assert.equal(args[args.indexOf("--output-format") + 1], "stream-json");
  assert.equal(args.includes("--input-format"), false);
});

test("claude auto chat without app MCP still omits allowedTools", () => {
  const runner = makeRunner() as any;
  const options = chatOptions({
    agentMode: "auto",
    workspaceWrite: false,
    webAccess: true
  });
  const config = claudeToolConfig("chat", "/repo", [], options);

  assert.equal(config.allowedTools.length > 0, true);
  assert.deepEqual(claudeAllowedToolsArgs("chat", options, config), []);
});

test("claude default and plan chats keep full app MCP allowedTools", () => {
  const runner = makeRunner() as any;
  for (const agentMode of ["default", "plan"] as const) {
    const options = chatOptions({
      agentMode,
      workspaceWrite: false,
      canRequestPermissions: true,
      appToolNames: [
        "app_chat_list_attachments",
        "app_chat_read_attachment",
        "app_chat_export_attachment",
        "app_permissions_request_change"
      ]
    });
    const config = claudeToolConfig("chat", "/repo", [], options);
    const allowedTools = claudeAllowedToolsFromArgs(claudeAllowedToolsArgs("chat", options, config));

    for (const tool of [
      "mcp__accord_agents__app_chat_list_attachments",
      "mcp__accord_agents__app_chat_read_attachment",
      "mcp__accord_agents__app_chat_export_attachment",
      "mcp__accord_agents__app_permissions_request_change"
    ]) {
      assert.equal(allowedTools.includes(tool), true, `${agentMode} should keep ${tool}`);
    }
  }
});

test("claude default chat still hard-denies off-toggle capabilities via disallowedTools", () => {
  const runner = makeRunner() as any;
  // Dropping the closed --tools whitelist must not weaken off-toggle enforcement:
  // workspaceWrite/webAccess/shell all OFF (the defaultChatAgentPermissions baseline)
  // still has to emit hard denies so escalation only ever applies to unknown tools.
  const options = chatOptions({
    agentMode: "default",
    workspaceWrite: false,
    webAccess: false,
    canRequestPermissions: true,
    appToolNames: ["app_permissions_request_change", "app_tool_permission"]
  });
  const config = claudeToolConfig("chat", "/repo", [], options);
  const disallowed = new Set(config.disallowedTools as string[]);

  for (const tool of ["Edit", "Write", "NotebookEdit", "WebSearch", "WebFetch", "Bash"]) {
    assert.equal(disallowed.has(tool), true, `expected ${tool} to be hard-denied`);
  }
  assert.equal(disallowed.has("MultiEdit"), false);
});

test("claude non-chat keeps strict app MCP config and explicit tools", () => {
  const runner = makeRunner() as any;
  const options = chatOptions({
    agentMode: "default",
    workspaceWrite: false,
    canRequestPermissions: true,
    appToolNames: ["app_permissions_request_change", "app_tool_permission"]
  });
  const config = claudeToolConfig("code-review", "/repo", [], options);

  assert.ok(claudeMcpArgs("code-review", options).includes("--strict-mcp-config"));
  assert.deepEqual(claudePermissionPromptArgs("code-review", options), []);
  assert.deepEqual(claudeToolsArgs("code-review", config, options).slice(0, 1), ["--tools"]);
});

test("Claude Code Default (sessions view): edits, commands and web stay available and each is asked through the app's approval card, as the CLI asks", () => {
  const runner = makeRunner() as any;
  const options = ownModeOptions("default", false, { enabled: false, rules: [{ action: "deny", match: "prefix", pattern: "rm -rf" }] });
  const config = claudeToolConfig("chat", "/repo", [], options);
  assert.equal(config.permissionMode, "default");
  for (const tool of ["Edit", "Write", "NotebookEdit", "Bash", "WebSearch", "WebFetch"]) {
    assert.equal(config.disallowedTools.includes(tool), false, `${tool} is not taken away`);
    assert.equal(config.allowedTools.includes(tool), false, `${tool} is not pre-approved: the CLI asks`);
  }
  assert.ok(config.disallowedTools.includes("Bash(rm -rf:*)"), "a deny rule stays a hard stop");
  assert.deepEqual(claudePermissionPromptArgs("chat", options), ["--permission-prompt-tool", "mcp__accord_agents__app_tool_permission"],
    "every ask goes to the app's approval card");
});

test("Claude Code Accept edits (sessions view): edits without asking, commands and web asked", () => {
  const runner = makeRunner() as any;
  const config = claudeToolConfig("chat", "/repo", [], ownModeOptions("default", true));
  assert.equal(config.permissionMode, "acceptEdits");
  assert.equal(config.disallowedTools.includes("Bash"), false);
  assert.equal(config.disallowedTools.includes("WebFetch"), false);
  assert.equal(config.allowedTools.includes("WebFetch"), false, "web asked, not pre-approved");
});

// Was: Plan disallowed Edit/Write/NotebookEdit and Bash, and Auto pre-allowed
// web tools, dropped the shell rules and passed only pre-authorized app tools.
// In Claude Code's own modes the tools no longer depend on the mode: the
// mode can change in the live process mid-reply (set_permission_mode, as
// Shift+Tab in Claude Code 2.1.330), so a process started in one mode must
// be exactly the process of every other; the CLI's own Plan mode refuses
// edits and its Auto classifier decides, as in its terminal.
test("Claude Code Plan mode and Auto mode are the CLI's own: the same tools as Manual, only --permission-mode differs; the classic controls still take away what is not granted", () => {
  const runner = makeRunner() as any;
  const plan = claudeToolConfig("chat", "/repo", [], ownModeOptions("plan", false));
  assert.equal(plan.permissionMode, "plan");
  assert.ok(!plan.disallowedTools.includes("Edit") && !plan.disallowedTools.includes("Bash"), "Plan mode is Claude Code's own: it takes nothing away");
  assert.equal(claudeToolConfig("chat", "/repo", [], ownModeOptions("auto", false)).permissionMode, "auto");
  const classic = claudeToolConfig("chat", "/repo", [], chatOptions({ agentMode: "default", workspaceWrite: false }));
  assert.ok(["Edit", "Bash", "WebFetch"].every((tool) => classic.disallowedTools.includes(tool)), "classic: unchanged");
});

test("Claude Code's own modes launch one and the same process: Manual, Accept edits, Plan, Auto (and Full Access) differ only in --permission-mode", () => {
  const runner = makeRunner() as any;
  const participant = { id: "claude-own", kind: "claude-code", label: "@claude", model: "sonnet" };
  const shell = {
    enabled: true,
    rules: [
      { action: "allow" as const, match: "prefix" as const, pattern: "git status" },
      { action: "ask" as const, match: "prefix" as const, pattern: "npm test" },
      { action: "deny" as const, match: "prefix" as const, pattern: "rm -rf" }
    ]
  };
  const appToolNames = ["app_permissions_request_change", "app_tool_permission", "app_chat_send_message", "app_chat_export_attachment"];
  const ownMode = (agentMode: "default" | "plan" | "auto" | "full-access", workspaceWrite: boolean) => {
    const options = chatOptions({ agentMode, workspaceWrite, shell, canRequestPermissions: true, appToolNames, autoPreauthorizedToolNames: ["app_chat_send_message"] });
    return {
      ...options,
      permissions: {
        ...options.permissions,
        cliApprovals: true as const,
        providerNative: { "claude-code": { allowedTools: ["mcp__github__get_issue", "Bash(make:*)"] } }
      }
    };
  };
  const launch = (options: ReturnType<typeof ownMode>) => {
    const toolConfig = claudeToolConfig("chat", "/repo", ["/workspace"], options);
    const args: string[] = claudeLaunchArgs(participant as never, "chat", options, toolConfig, ["/workspace"], "warm", "session-1");
    const at = args.indexOf("--permission-mode");
    return { mode: args[at + 1], rest: [...args.slice(0, at), ...args.slice(at + 2)] };
  };
  const manual = launch(ownMode("default", false));
  const cases: Array<[string, ReturnType<typeof ownMode>, string]> = [
    ["Accept edits", ownMode("default", true), "acceptEdits"],
    ["Plan", ownMode("plan", false), "plan"],
    ["Auto", ownMode("auto", false), "auto"],
    ["Full Access (Auto on Claude Code)", ownMode("full-access", false), "auto"]
  ];
  assert.equal(manual.mode, "default");
  for (const [name, options, mode] of cases) {
    const other = launch(options);
    assert.equal(other.mode, mode, name);
    assert.deepEqual(other.rest, manual.rest, `${name}: the same launch as Manual but for --permission-mode`);
  }
  // The Manual surface: present and asked unless granted; the stored shell
  // rules and provider-native rules are Claude Code's own rules in every
  // mode (as in her own Claude settings: its parsing, deny > ask > allow,
  // its Auto's stripping, its Plan mode); the app tools Auto pre-authorizes,
  // Skill and subagent tools allowed.
  const allowed = claudeAllowedToolsFromArgs(manual.rest);
  for (const tool of ["Bash(git status:*)", "Bash(make:*)", "mcp__github__get_issue", "mcp__accord_agents__app_chat_send_message", "Skill", "Agent", "Task"]) {
    assert.ok(allowed.includes(tool), `${tool} allowed`);
  }
  for (const tool of ["Edit", "Write", "WebFetch", "WebSearch", "Bash"]) {
    assert.equal(allowed.includes(tool), false, `${tool} asked, not pre-approved`);
  }
  // App tools Auto leaves to the CLI (an export writes into the project) are
  // asked in every mode; the permission prompt tool is never a model tool.
  for (const tool of ["mcp__accord_agents__app_chat_export_attachment", "mcp__accord_agents__app_permissions_request_change", "mcp__accord_agents__app_tool_permission"]) {
    assert.equal(allowed.includes(tool), false, `${tool} not pre-approved`);
  }
  const disallowed = (manual.rest[manual.rest.indexOf("--disallowedTools") + 1] ?? "").split(",");
  assert.deepEqual(disallowed, ["Bash(rm -rf:*)"], "only the deny rule is a hard stop");
  assert.deepEqual(JSON.parse(manual.rest[manual.rest.indexOf("--settings") + 1]), { permissions: { ask: ["Bash(npm test:*)"] } });
  assert.equal(manual.rest[manual.rest.indexOf("--permission-prompt-tool") + 1], "mcp__accord_agents__app_tool_permission", "every mode asks through the cards");

  // Classic members (no cliApprovals): exactly as before.
  const classic = (agentMode: "default" | "plan" | "auto", workspaceWrite: boolean) => chatOptions({ agentMode, workspaceWrite, shell, canRequestPermissions: true, appToolNames, autoPreauthorizedToolNames: ["app_chat_send_message"] });
  const classicPlan = claudeToolConfig("chat", "/repo", [], classic("plan", false));
  assert.ok(["Edit", "Write", "NotebookEdit", "Bash"].every((tool) => classicPlan.disallowedTools.includes(tool)), "classic Plan: edits and Bash taken away");
  assert.deepEqual(claudePermissionPromptArgs("chat", classic("plan", false)), [], "classic Plan: no permission prompt tool");
  const classicManual = claudeToolConfig("chat", "/repo", [], classic("default", false));
  assert.ok(["Bash(git status:*)", "mcp__accord_agents__app_chat_export_attachment"].every((tool) => classicManual.allowedTools.includes(tool)), "classic Manual: unchanged");
  const classicAuto = classic("auto", false);
  const classicAutoConfig = claudeToolConfig("chat", "/repo", [], classicAuto);
  assert.ok(classicAutoConfig.allowedTools.includes("WebFetch"), "classic Auto: web pre-approved");
  assert.equal(classicAutoConfig.askTools.length, 0, "classic Auto: the shell rules are the classifier's");
  assert.deepEqual(claudeAllowedToolsFromArgs(claudeAllowedToolsArgs("chat", classicAuto, classicAutoConfig)), ["mcp__accord_agents__app_chat_send_message"],
    "classic Auto: only pre-authorized app tools in --allowedTools");
});

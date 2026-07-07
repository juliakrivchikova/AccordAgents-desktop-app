import assert from "node:assert/strict";
import test from "node:test";
import { CliAgentRunner, parseClaudeModelPickerOutput } from "./cliAgents";
import { CommandError } from "./command";
import { CODEX_APP_SERVER_MCP_TOKEN_ENV } from "./codexExec";
import { defaultChatAgentPermissions } from "../../shared/agentPermissions";

function makeRunner(): CliAgentRunner {
  return new CliAgentRunner();
}

function makeCodexPendingTurn(overrides: Partial<Record<string, unknown>> = {}) {
  const timer = setTimeout(() => undefined, 1);
  clearTimeout(timer);
  return {
    startedAt: Date.now(),
    threadId: "thread-1",
    messages: [],
    streamedText: "",
    completedAgentMessages: [],
    nextAgentMessageStartsBlock: false,
    timer,
    onOutput: undefined,
    resolve: undefined,
    reject: undefined,
    ...overrides
  };
}

function makeClaudeWarmPendingTurn(overrides: Partial<Record<string, unknown>> = {}) {
  const timer = setTimeout(() => undefined, 1);
  clearTimeout(timer);
  return {
    startedAt: Date.now(),
    messages: [],
    streamedText: "",
    nextTextBlockStartsBlock: false,
    timer,
    onOutput: undefined,
    resolve: undefined,
    reject: undefined,
    ...overrides
  };
}

test("agentRunEnv filters blocked manual keys and preserves app MCP token precedence", () => {
  const runner = makeRunner() as unknown as {
    agentRunEnv(options: Record<string, unknown>): NodeJS.ProcessEnv | undefined;
  };

  const env = runner.agentRunEnv({
    agentEnv: {
      AA_MANUAL_AGENT_ENV_TEST: "manual",
      PATH: "/manual/bin",
      ACCORD_AGENTS_INTERNAL: "blocked",
      [CODEX_APP_SERVER_MCP_TOKEN_ENV]: "manual-token"
    },
    appMcp: {
      token: "per-run-token"
    }
  });

  assert.equal(env?.AA_MANUAL_AGENT_ENV_TEST, "manual");
  assert.equal(env?.PATH, undefined);
  assert.equal(env?.ACCORD_AGENTS_INTERNAL, undefined);
  assert.equal(env?.[CODEX_APP_SERVER_MCP_TOKEN_ENV], "per-run-token");
});

test("warmAgentKey changes when the manual agent environment version changes", () => {
  const runner = makeRunner() as unknown as {
    warmAgentKey(
      participant: Record<string, unknown>,
      repoPath: string | undefined,
      kind: string,
      options: Record<string, unknown>
    ): string;
  };
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

  const firstKey = runner.warmAgentKey(participant, "/tmp/repo", "chat", {
    ...baseOptions,
    agentEnvKey: "agent-env-v1"
  });
  const secondKey = runner.warmAgentKey(participant, "/tmp/repo", "chat", {
    ...baseOptions,
    agentEnvKey: "agent-env-v2"
  });
  const repeatedFirstKey = runner.warmAgentKey(participant, "/tmp/repo", "chat", {
    ...baseOptions,
    agentEnvKey: "agent-env-v1"
  });

  assert.notEqual(firstKey, secondKey);
  assert.equal(firstKey, repeatedFirstKey);
  assert.equal(JSON.parse(firstKey).agentEnvKey, "agent-env-v1");
  assert.equal(JSON.parse(secondKey).agentEnvKey, "agent-env-v2");
});

test("parseClaudeModelPickerOutput extracts aliases and default model from picker text", () => {
  const output = [
    "\u001b[?25lSelect m\u001b[12Gdel",
    "\u001b[3G❯\u001b[5G1.\u001b[8GDefault\u001b[16G(recommended)\u001b[30G✔\u001b[33GUse\u001b[37Gthe\u001b[41Gdefault\u001b[49Gmodel\u001b[55G(currently\u001b[66GOpus\u001b[71G4.8\u001b[75G(1M",
    "\u001b[33Gcontext))\u001b[43G·\u001b[45G$5/$25\u001b[52Gper\u001b[56GMtok",
    "\u001b[5G2.\u001b[8GOpus\u001b[33GOpus\u001b[38G4.8\u001b[42Gwith\u001b[47G1M\u001b[50Gcontext",
    "\u001b[5G3.\u001b[8GFable\u001b[33GFable\u001b[39G5",
    "\u001b[5G4.\u001b[8GSonnet\u001b[33GSonnet\u001b[40G4.6",
    "\u001b[5G5.\u001b[8GSonnet\u001b[15G(1M\u001b[19Gcontext)\u001b[33GSonnet\u001b[40G4.6\u001b[44Gfor\u001b[48Glong\u001b[53Gsessions",
    "\u001b[5G6.\u001b[8GHaiku\u001b[33GHaiku\u001b[39G4.5",
    "● Enter to set · Esc to cancel"
  ].join("\n");

  assert.deepEqual(parseClaudeModelPickerOutput(output).map((model) => ({
    id: model.id,
    recommended: model.recommended === true
  })), [
    { id: "opus", recommended: true },
    { id: "fable", recommended: false },
    { id: "sonnet", recommended: false },
    { id: "claude-sonnet-4-6[1m]", recommended: false },
    { id: "haiku", recommended: false }
  ]);
});

test("codex app-server stream keeps token deltas joined inside one agent message", () => {
  const runner = makeRunner() as any;
  const outputs: Array<{ kind: string; cumulative?: string }> = [];
  const pending = makeCodexPendingTurn({
    onOutput: (event: { kind: string; cumulative?: string }) => outputs.push(event)
  });
  const participant = { id: "p1", label: "Agent" };

  runner.handleCodexAppServerNotification(
    { method: "item/started", params: { item: { type: "agentMessage" } } },
    participant,
    pending,
    () => pending,
    (error: Error) => { throw error; }
  );
  runner.handleCodexAppServerNotification(
    { method: "item/agentMessage/delta", params: { delta: "hel" } },
    participant,
    pending,
    () => pending,
    (error: Error) => { throw error; }
  );
  runner.handleCodexAppServerNotification(
    { method: "item/agentMessage/delta", params: { delta: "lo" } },
    participant,
    pending,
    () => pending,
    (error: Error) => { throw error; }
  );

  assert.equal(outputs.filter((event) => event.kind === "text").at(-1)?.cumulative, "hello");
});

test("codex app-server stream excludes paragraph-separated preamble from final content", () => {
  const runner = makeRunner() as any;
  const outputs: Array<{ kind: string; cumulative?: string }> = [];
  const resolved: unknown[] = [];
  const pending = makeCodexPendingTurn({
    onOutput: (event: { kind: string; cumulative?: string }) => outputs.push(event),
    resolve: (result: unknown) => resolved.push(result)
  });
  const participant = { id: "p1", label: "Agent" };
  const fail = (error: Error): never => { throw error; };

  for (const text of ["first.", "second."]) {
    runner.handleCodexAppServerNotification(
      { method: "item/started", params: { item: { type: "agentMessage" } } },
      participant,
      pending,
      () => pending,
      fail
    );
    runner.handleCodexAppServerNotification(
      { method: "item/agentMessage/delta", params: { delta: text } },
      participant,
      pending,
      () => pending,
      fail
    );
    runner.handleCodexAppServerNotification(
      { method: "item/completed", params: { item: { type: "agentMessage", text } } },
      participant,
      pending,
      () => pending,
      fail
    );
  }
  runner.handleCodexAppServerNotification(
    { method: "turn/completed", params: { turn: { status: "completed" } } },
    participant,
    pending,
    () => pending,
    fail
  );

  assert.equal(outputs.filter((event) => event.kind === "text").at(-1)?.cumulative, "first.\n\nsecond.");
  assert.equal((resolved[0] as { content: string }).content, "second.");
});

test("codex app-server stream rejoins mid-sentence agent messages around tool usage", () => {
  const runner = makeRunner() as any;
  const outputs: Array<{ kind: string; text: string; cumulative?: string }> = [];
  const resolved: unknown[] = [];
  const pending = makeCodexPendingTurn({
    onOutput: (event: { kind: string; text: string; cumulative?: string }) => outputs.push(event),
    resolve: (result: unknown) => resolved.push(result)
  });
  const participant = { id: "p1", label: "Agent" };
  const fail = (error: Error): never => { throw error; };
  const send = (record: Record<string, unknown>): void => runner.handleCodexAppServerNotification(
    record,
    participant,
    pending,
    () => pending,
    fail
  );

  send({ method: "item/started", params: { item: { type: "agentMessage" } } });
  send({ method: "item/agentMessage/delta", params: { delta: "Current EUR/RUB is" } });
  send({ method: "item/completed", params: { item: { type: "agentMessage", text: "Current EUR/RUB is" } } });
  send({ method: "item/started", params: { item: { type: "webSearch" } } });
  send({ method: "item/started", params: { item: { type: "agentMessage" } } });
  send({ method: "item/agentMessage/delta", params: { delta: "about 1 EUR" } });
  send({ method: "item/agentMessage/delta", params: { delta: " = 89.88 RUB." } });
  send({ method: "item/completed", params: { item: { type: "agentMessage", text: "about 1 EUR = 89.88 RUB." } } });
  send({ method: "turn/completed", params: { turn: { status: "completed" } } });

  assert.equal(outputs.find((event) => event.kind === "tool")?.text, "Using web search\n");
  assert.equal(outputs.filter((event) => event.kind === "text").at(-1)?.cumulative, "Current EUR/RUB is about 1 EUR = 89.88 RUB.");
  assert.equal((resolved[0] as { content: string }).content, "Current EUR/RUB is about 1 EUR = 89.88 RUB.");
});

test("codex app-server stream keeps parenthetical citation boundaries as paragraph breaks outside final content", () => {
  const runner = makeRunner() as any;
  const outputs: Array<{ kind: string; cumulative?: string }> = [];
  const resolved: unknown[] = [];
  const pending = makeCodexPendingTurn({
    onOutput: (event: { kind: string; cumulative?: string }) => outputs.push(event),
    resolve: (result: unknown) => resolved.push(result)
  });
  const participant = { id: "p1", label: "Agent" };
  const fail = (error: Error): never => { throw error; };
  const sendAgentMessage = (text: string): void => {
    runner.handleCodexAppServerNotification(
      { method: "item/started", params: { item: { type: "agentMessage" } } },
      participant,
      pending,
      () => pending,
      fail
    );
    runner.handleCodexAppServerNotification(
      { method: "item/agentMessage/delta", params: { delta: text } },
      participant,
      pending,
      () => pending,
      fail
    );
    runner.handleCodexAppServerNotification(
      { method: "item/completed", params: { item: { type: "agentMessage", text } } },
      participant,
      pending,
      () => pending,
      fail
    );
  };

  sendAgentMessage("Current EUR/RUB is about 1 EUR = 89.88 RUB. (exchange-rates.org)");
  sendAgentMessage("For comparison, the Bank of Russia official rate is 87.4027 RUB per EUR. (cbr.ru)");
  runner.handleCodexAppServerNotification(
    { method: "turn/completed", params: { turn: { status: "completed" } } },
    participant,
    pending,
    () => pending,
    fail
  );

  const expected = [
    "Current EUR/RUB is about 1 EUR = 89.88 RUB. (exchange-rates.org)",
    "For comparison, the Bank of Russia official rate is 87.4027 RUB per EUR. (cbr.ru)"
  ].join("\n\n");
  assert.equal(outputs.filter((event) => event.kind === "text").at(-1)?.cumulative, expected);
  assert.equal((resolved[0] as { content: string }).content, "For comparison, the Bank of Russia official rate is 87.4027 RUB per EUR. (cbr.ru)");
});

test("codex app-server keeps internal multi-paragraph final item complete", () => {
  const runner = makeRunner() as any;
  const resolved: unknown[] = [];
  const pending = makeCodexPendingTurn({
    resolve: (result: unknown) => resolved.push(result)
  });
  const participant = { id: "p1", label: "Agent" };
  const fail = (error: Error): never => { throw error; };
  const final = [
    "Current EUR/RUB is about 1 EUR = 89.88 RUB. (exchange-rates.org)",
    "For comparison, the Bank of Russia official rate is 87.4027 RUB per EUR. (cbr.ru)"
  ].join("\n\n");

  for (const text of ["I’ll check the exchange sources first.", final]) {
    runner.handleCodexAppServerNotification(
      { method: "item/started", params: { item: { type: "agentMessage" } } },
      participant,
      pending,
      () => pending,
      fail
    );
    runner.handleCodexAppServerNotification(
      { method: "item/agentMessage/delta", params: { delta: text } },
      participant,
      pending,
      () => pending,
      fail
    );
    runner.handleCodexAppServerNotification(
      { method: "item/completed", params: { item: { type: "agentMessage", text } } },
      participant,
      pending,
      () => pending,
      fail
    );
  }
  runner.handleCodexAppServerNotification(
    { method: "turn/completed", params: { turn: { status: "completed" } } },
    participant,
    pending,
    () => pending,
    fail
  );

  assert.equal((resolved[0] as { content: string }).content, final);
});

test("codex app-server falls back to trailing paragraph when completions are missing", () => {
  const runner = makeRunner() as any;
  const resolved: unknown[] = [];
  const pending = makeCodexPendingTurn({
    resolve: (result: unknown) => resolved.push(result)
  });
  const participant = { id: "p1", label: "Agent" };
  const fail = (error: Error): never => { throw error; };

  runner.handleCodexAppServerNotification(
    { method: "item/started", params: { item: { type: "agentMessage" } } },
    participant,
    pending,
    () => pending,
    fail
  );
  runner.handleCodexAppServerNotification(
    { method: "item/agentMessage/delta", params: { delta: "I’ll check the sources first.\n\nFinal answer." } },
    participant,
    pending,
    () => pending,
    fail
  );
  runner.handleCodexAppServerNotification(
    { method: "turn/completed", params: { turn: { status: "completed" } } },
    participant,
    pending,
    () => pending,
    fail
  );

  assert.equal((resolved[0] as { content: string }).content, "Final answer.");
});

test("claude warm stream rejoins mid-sentence text blocks", () => {
  const runner = makeRunner() as any;
  const outputs: Array<{ kind: string; cumulative?: string }> = [];
  const pending = makeClaudeWarmPendingTurn({
    onOutput: (event: { kind: string; cumulative?: string }) => outputs.push(event)
  });
  const participant = { id: "p1", label: "Agent", kind: "claude-code" };
  const fail = (error: Error): never => { throw error; };
  const send = (event: Record<string, unknown>): void => runner.handleClaudeWarmLine(
    JSON.stringify(event),
    participant,
    {},
    undefined,
    pending,
    () => pending,
    fail
  );

  send({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "text" } } });
  send({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Current EUR/RUB is" } } });
  send({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "text" } } });
  send({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "about 1 EUR = 89.88 RUB." } } });

  assert.equal(outputs.filter((event) => event.kind === "text").at(-1)?.cumulative, "Current EUR/RUB is about 1 EUR = 89.88 RUB.");
});

test("claude warm fallback excludes paragraph-separated preamble from final content", () => {
  const runner = makeRunner() as any;
  const resolved: unknown[] = [];
  const pending = makeClaudeWarmPendingTurn({
    resolve: (result: unknown) => resolved.push(result)
  });
  const participant = { id: "p1", label: "Agent", kind: "claude-code" };
  const fail = (error: Error): never => { throw error; };
  const send = (event: Record<string, unknown>): void => runner.handleClaudeWarmLine(
    JSON.stringify(event),
    participant,
    {},
    undefined,
    pending,
    () => pending,
    fail
  );

  send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "I’ll check the existing settings first." }] } });
  send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Final answer." }] } });
  send({ type: "result" });

  assert.equal((resolved[0] as { content: string }).content, "Final answer.");
});

test("claude warm fallback rejoins mid-sentence assistant text items", () => {
  const runner = makeRunner() as any;
  const resolved: unknown[] = [];
  const pending = makeClaudeWarmPendingTurn({
    resolve: (result: unknown) => resolved.push(result)
  });
  const participant = { id: "p1", label: "Agent", kind: "claude-code" };
  const fail = (error: Error): never => { throw error; };
  const send = (event: Record<string, unknown>): void => runner.handleClaudeWarmLine(
    JSON.stringify(event),
    participant,
    {},
    undefined,
    pending,
    () => pending,
    fail
  );

  send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Current EUR/RUB is" }] } });
  send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "about 1 EUR = 89.88 RUB." }] } });
  send({ type: "result" });

  assert.equal((resolved[0] as { content: string }).content, "Current EUR/RUB is about 1 EUR = 89.88 RUB.");
});

test("claude warm rejects result events without response content", () => {
  const runner = makeRunner() as any;
  const resolved: unknown[] = [];
  const rejected: Error[] = [];
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const pending = makeClaudeWarmPendingTurn({
    resolve: (result: unknown) => resolved.push(result),
    reject: (error: Error) => rejected.push(error)
  });
  const participant = { id: "p1", label: "Agent", kind: "claude-code" };
  const fail = (error: Error): never => { throw error; };

  runner.handleClaudeWarmLine(
    JSON.stringify({ type: "result" }),
    participant,
    {},
    undefined,
    pending,
    () => pending,
    fail
  );

  assert.equal(resolved.length, 0);
  assert.equal(rejected[0]?.message, "Claude warm process completed without response content.");
});

test("claude warm permits empty result only when explicitly allowed", () => {
  const runner = makeRunner() as any;
  const resolved: unknown[] = [];
  const rejected: Error[] = [];
  const pending = makeClaudeWarmPendingTurn({
    resolve: (result: unknown) => resolved.push(result),
    reject: (error: Error) => rejected.push(error)
  });
  const participant = { id: "p1", label: "Agent", kind: "claude-code" };
  const fail = (error: Error): never => { throw error; };

  runner.handleClaudeWarmLine(
    JSON.stringify({ type: "result" }),
    participant,
    { allowEmptyContent: true },
    undefined,
    pending,
    () => pending,
    fail
  );

  assert.equal(rejected.length, 0);
  assert.equal((resolved[0] as { ok: boolean; content: string; sessionId: string }).ok, true);
  assert.equal((resolved[0] as { content: string }).content, "");
  assert.equal((resolved[0] as { sessionId?: string }).sessionId, undefined);
});

function chatOptions(overrides: {
  agentMode: "default" | "plan" | "auto";
  workspaceWrite: boolean;
  webAccess?: boolean;
  shell?: ReturnType<typeof defaultChatAgentPermissions>["shell"];
  canRequestPermissions?: boolean;
  appToolNames?: string[];
}) {
  const permissions = defaultChatAgentPermissions();
  return {
    agentMode: overrides.agentMode,
    permissions: {
      ...permissions,
      repoRead: true,
      workspaceWrite: overrides.workspaceWrite,
      webAccess: overrides.webAccess ?? false,
      shell: overrides.shell ?? permissions.shell
    },
    appMcp: overrides.canRequestPermissions
      ? {
          url: "http://127.0.0.1:1/mcp",
          token: "token",
          toolNames: overrides.appToolNames ?? ["app_permissions_request_change"]
        }
      : undefined
  };
}

function claudeAllowedToolsFromArgs(args: string[]): string[] {
  const index = args.indexOf("--allowedTools");
  return index >= 0 ? (args[index + 1] ?? "").split(",").filter(Boolean) : [];
}

test("claudeToolConfig maps default + workspaceWrite=true to acceptEdits", () => {
  const runner = makeRunner() as any;
  const config = runner.claudeToolConfig("chat", "/repo", [], chatOptions({
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
  const config = runner.claudeToolConfig("chat", "/repo", [], chatOptions({
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
  const config = runner.claudeToolConfig("chat", "/repo", [], chatOptions({
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
  const config = runner.claudeToolConfig("chat", "/repo", [], chatOptions({
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
  const config = runner.claudeToolConfig("chat", "/repo", [], chatOptions({
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

test("claudeToolConfig auto mode forwards only deny shell rules and drops allow/ask", () => {
  const runner = makeRunner() as any;
  const config = runner.claudeToolConfig("chat", "/repo", [], chatOptions({
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
  // deny rule forwarded as a hard stop...
  assert.ok(config.disallowedTools.some((tool: string) => tool.includes("rm -rf")));
  // ...but stale allow/ask rules are NOT forwarded (native auto classifier decides).
  assert.equal(config.allowedTools.some((tool: string) => tool.includes("curl")), false);
  assert.equal(config.askTools.some((tool: string) => tool.includes("git push")), false);
  assert.equal(config.allowedTools.includes("Bash"), false);
});

test("claudeToolConfig leaves plan agent mode untouched regardless of workspaceWrite", () => {
  const runner = makeRunner() as any;
  const planNoWrite = runner.claudeToolConfig("chat", "/repo", [], chatOptions({
    agentMode: "plan",
    workspaceWrite: false
  }));
  const planWithWrite = runner.claudeToolConfig("chat", "/repo", [], chatOptions({
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
  const chatConfig = runner.claudeToolConfig("chat", "/repo", [], chatOptions({
    agentMode: "default",
    workspaceWrite: false
  }));
  const reviewConfig = runner.claudeToolConfig("code-review", "/repo", [], chatOptions({
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
    runner.claudeToolConfig("chat", "/repo", [], chatOptions({ agentMode: "default", workspaceWrite: false })),
    runner.claudeToolConfig("chat", "/repo", [], chatOptions({ agentMode: "auto", workspaceWrite: false })),
    runner.claudeToolConfig("general", "/repo", [], chatOptions({ agentMode: "default", workspaceWrite: false })),
    runner.claudeToolConfig("code-review", "/repo", [], chatOptions({ agentMode: "default", workspaceWrite: false })),
    runner.claudeToolConfig("implementation-plan", "/repo", [], chatOptions({ agentMode: "default", workspaceWrite: false }))
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
  const config = runner.claudeToolConfig("chat", "/repo", [], options);
  const mcpArgs = runner.claudeMcpArgs("chat", options);
  const toolsArgs = runner.claudeToolsArgs("chat", config, options);

  assert.deepEqual(mcpArgs.slice(0, 1), ["--mcp-config"]);
  assert.equal(mcpArgs.includes("--strict-mcp-config"), false);
  assert.deepEqual(toolsArgs, []);
  const parsed = JSON.parse(mcpArgs[1]);
  assert.equal(parsed.mcpServers.accord_agents.type, "http");
  assert.equal(parsed.mcpServers.accord_agents.url, "http://127.0.0.1:1/mcp");
});

test("claude default chat delegates unmatched tool approvals to app_tool_permission", () => {
  const runner = makeRunner() as any;
  const options = chatOptions({
    agentMode: "default",
    workspaceWrite: false,
    canRequestPermissions: true,
    appToolNames: ["app_permissions_request_change", "app_tool_permission"]
  });

  assert.deepEqual(runner.claudePermissionPromptArgs("chat", options), [
    "--permission-prompt-tool",
    "mcp__accord_agents__app_tool_permission"
  ]);
});

test("claude auto chat passes only read-context app MCP allowedTools", () => {
  const runner = makeRunner() as any;
  const readContextTools = [
    "mcp__accord_agents__app_chat_get_context",
    "mcp__accord_agents__app_chat_get_participants",
    "mcp__accord_agents__app_chat_get_participant_request_status",
    "mcp__accord_agents__app_chat_read_messages",
    "mcp__accord_agents__app_chat_list_attachments",
    "mcp__accord_agents__app_chat_read_attachment"
  ];
  const options = chatOptions({
    agentMode: "auto",
    workspaceWrite: false,
    webAccess: true,
    canRequestPermissions: true,
    appToolNames: [
      "app_chat_get_context",
      "app_chat_get_participants",
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
  const config = runner.claudeToolConfig("chat", "/repo", [], options);
  const args = runner.claudeAllowedToolsArgs("chat", options, config);
  const allowedTools = claudeAllowedToolsFromArgs(args);

  assert.equal(config.allowedTools.length > 0, true);
  assert.deepEqual(args.slice(0, 1), ["--allowedTools"]);
  assert.deepEqual(allowedTools, readContextTools);
  for (const tool of [
    "mcp__accord_agents__app_chat_export_attachment",
    "mcp__accord_agents__app_chat_react",
    "mcp__accord_agents__app_chat_send_message",
    "mcp__accord_agents__app_chat_set_title",
    "mcp__accord_agents__app_permissions_request_change",
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
  assert.deepEqual(runner.claudePermissionPromptArgs("chat", options), []);
});

test("claude auto chat without app MCP still omits allowedTools", () => {
  const runner = makeRunner() as any;
  const options = chatOptions({
    agentMode: "auto",
    workspaceWrite: false,
    webAccess: true
  });
  const config = runner.claudeToolConfig("chat", "/repo", [], options);

  assert.equal(config.allowedTools.length > 0, true);
  assert.deepEqual(runner.claudeAllowedToolsArgs("chat", options, config), []);
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
    const config = runner.claudeToolConfig("chat", "/repo", [], options);
    const allowedTools = claudeAllowedToolsFromArgs(runner.claudeAllowedToolsArgs("chat", options, config));

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
  const config = runner.claudeToolConfig("chat", "/repo", [], options);
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
  const config = runner.claudeToolConfig("code-review", "/repo", [], options);

  assert.ok(runner.claudeMcpArgs("code-review", options).includes("--strict-mcp-config"));
  assert.deepEqual(runner.claudePermissionPromptArgs("code-review", options), []);
  assert.deepEqual(runner.claudeToolsArgs("code-review", config, options).slice(0, 1), ["--tools"]);
});

test("codex app-server auto mode applies workspace-write web preset and guardian reviewer", () => {
  const runner = makeRunner() as any;
  const participant = {
    kind: "codex-cli",
    label: "@codex",
    model: undefined,
    reasoningEffort: "xhigh"
  };
  const params = runner.codexAppServerThreadStartParams(
    participant,
    "/repo",
    "chat",
    chatOptions({
      agentMode: "auto",
      workspaceWrite: false,
      webAccess: false
    })
  );

  assert.equal(params.approvalPolicy, "on-request");
  assert.equal(params.approvalsReviewer, "guardian_subagent");
  assert.equal(params.sandbox, "workspace-write");
  assert.equal(params.config.web_search, "live");
  assert.equal(params.config.model_reasoning_effort, "xhigh");
});

test("reasoning effort mapping is provider-specific", () => {
  const runner = makeRunner() as any;

  assert.equal(runner.codexReasoningEffort("minimal"), "minimal");
  assert.equal(runner.codexReasoningEffort("max"), undefined);
  assert.equal(runner.claudeReasoningEffort("xhigh"), "xhigh");
  assert.equal(runner.claudeReasoningEffort("minimal"), undefined);
});

test("codex app-server resume re-asserts the auto preset so a mode switch applies without a fresh session", () => {
  const runner = makeRunner() as any;
  const participant = {
    kind: "codex-cli",
    label: "@codex",
    model: undefined
  };
  const params = runner.codexAppServerThreadResumeParams(
    "session-1",
    participant,
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
  assert.equal(params.approvalsReviewer, "guardian_subagent");
  assert.equal(params.sandbox, "workspace-write");
  assert.equal(params.config.web_search, "live");
});

test("withAppMcpClientStatus warns and flags unestablished app MCP generations", () => {
  const runner = makeRunner() as any;
  const participant = {
    kind: "codex-cli",
    label: "@codex",
    model: undefined
  };
  const result = runner.withAppMcpClientStatus({
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
  assert.equal(result.warnings.some((warning: string) => warning.includes("app tools did not finish MCP setup")), true);
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
    const result = runner.withAppMcpClientStatus({
      participant,
      ok: true,
      content: `turn ${turn}`
    }, participant, options);

    assert.equal(result.appMcpClientFailed, undefined);
    assert.equal(result.warnings, undefined);
  }
});

test("codex app-server compact instructions become a scoped compact_prompt override", () => {
  const runner = makeRunner() as any;
  const participant = {
    kind: "codex-cli",
    label: "@codex",
    model: undefined
  };
  const params = runner.codexAppServerThreadResumeParams(
    "session-1",
    participant,
    "/repo",
    "chat",
    {
      ...chatOptions({
        agentMode: "default",
        workspaceWrite: false,
        webAccess: false
      }),
      compactInstructions: "keep focus on parser and CLI protocol details"
    }
  );

  assert.equal(params.threadId, "session-1");
  assert.match(params.config.compact_prompt, /Compact the conversation context/);
  assert.match(params.config.compact_prompt, /keep focus on parser and CLI protocol details/);
});

test("codex app-server does not override compact_prompt unless compact instructions are scoped", () => {
  const runner = makeRunner() as any;
  const participant = {
    kind: "codex-cli",
    label: "@codex",
    model: undefined
  };
  const params = runner.codexAppServerThreadResumeParams(
    "session-1",
    participant,
    "/repo",
    "chat",
    chatOptions({
      agentMode: "default",
      workspaceWrite: false,
      webAccess: false
    })
  );

  assert.equal("compact_prompt" in params.config, false);
});

test("codex app-server compact prompt can be explicitly cleared after an instructed compact", () => {
  const runner = makeRunner() as any;
  const participant = {
    kind: "codex-cli",
    label: "@codex",
    model: undefined
  };
  const params = runner.codexAppServerThreadResumeParams(
    "session-1",
    participant,
    "/repo",
    "chat",
    {
      ...chatOptions({
        agentMode: "default",
        workspaceWrite: false,
        webAccess: false
      }),
      clearCompactPrompt: true
    }
  );

  assert.equal(params.config.compact_prompt, null);
});

test("codex app-server compact returns token usage captured during compact", () => {
  const runner = makeRunner() as any;
  const participant = {
    kind: "codex-cli",
    label: "@codex",
    model: "gpt-5"
  };
  let pending: any = {
    threadId: "session-1",
    startedAt: Date.now(),
    timer: setTimeout(() => undefined, 1000),
    resolve: (result: unknown) => {
      resolved = result;
    },
    reject: (error: Error) => {
      throw error;
    }
  };
  let resolved: any;
  const cleanupPending = () => {
    const current = pending;
    pending = undefined;
    clearTimeout(current.timer);
    return current;
  };
  const rejectPending = (error: Error) => {
    throw error;
  };

  assert.equal(runner.handleCodexAppServerCompactNotification({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "session-1",
      usage: {
        input_tokens: 120
      },
      contextWindowTokens: 1000
    }
  }, participant, pending, cleanupPending, rejectPending), true);

  assert.equal(runner.handleCodexAppServerCompactNotification({
    method: "thread/compacted",
    params: {
      threadId: "session-1"
    }
  }, participant, pending, cleanupPending, rejectPending), true);

  assert.equal(resolved.ok, true);
  assert.equal(resolved.sessionId, "session-1");
  assert.equal(resolved.contextUsage.usedTokens, 120);
  assert.equal(resolved.contextUsage.contextWindowTokens, 1000);
  assert.equal(resolved.contextUsage.percentage, 12);
});

test("codex app-server compact resolves CLI-style context_compacted events", () => {
  const runner = makeRunner() as any;
  const participant = {
    kind: "codex-cli",
    label: "@codex",
    model: "gpt-5"
  };
  let pending: any = {
    threadId: "session-1",
    startedAt: Date.now(),
    timer: setTimeout(() => undefined, 1000),
    resolve: (result: unknown) => {
      resolved = result;
    },
    reject: (error: Error) => {
      throw error;
    }
  };
  let resolved: any;
  const cleanupPending = () => {
    const current = pending;
    pending = undefined;
    clearTimeout(current.timer);
    return current;
  };
  const rejectPending = (error: Error) => {
    throw error;
  };

  assert.equal(runner.handleCodexAppServerCompactNotification({
    type: "event",
    msg: {
      type: "context_compacted",
      thread_id: "session-1",
      usage: {
        input_tokens: 80
      },
      context_window_tokens: 1000
    }
  }, participant, pending, cleanupPending, rejectPending), true);

  assert.equal(resolved.ok, true);
  assert.equal(resolved.sessionId, "session-1");
  assert.equal(resolved.contextUsage.usedTokens, 80);
  assert.equal(resolved.contextUsage.contextWindowTokens, 1000);
  assert.equal(resolved.contextUsage.percentage, 8);
});

test("codex app-server compact resolves compact completion event variants", () => {
  const runner = makeRunner() as any;
  const participant = {
    kind: "codex-cli",
    label: "@codex",
    model: "gpt-5"
  };
  let resolved: any;
  let pending: any = {
    threadId: "session-1",
    startedAt: Date.now(),
    timer: setTimeout(() => undefined, 1000),
    resolve: (result: unknown) => {
      resolved = result;
    },
    reject: (error: Error) => {
      throw error;
    }
  };
  const cleanupPending = () => {
    const current = pending;
    pending = undefined;
    clearTimeout(current.timer);
    return current;
  };
  const rejectPending = (error: Error) => {
    throw error;
  };

  assert.equal(runner.handleCodexAppServerCompactNotification({
    method: "thread/compact/completed",
    params: {
      threadId: "session-1",
      usage: {
        input_tokens: 70
      },
      contextWindowTokens: 1000
    }
  }, participant, pending, cleanupPending, rejectPending), true);

  assert.equal(resolved.ok, true);
  assert.equal(resolved.sessionId, "session-1");
  assert.equal(resolved.contextUsage.usedTokens, 70);
  assert.equal(resolved.contextUsage.percentage, 7);
});

function makeCompactPending(threadId: string): { pending: any; cleanupPending: () => any; rejectPending: (error: Error) => void; getResolved: () => any; getRejected: () => Error | undefined } {
  let resolved: any;
  let rejected: Error | undefined;
  let pending: any = {
    threadId,
    startedAt: Date.now(),
    timer: setTimeout(() => undefined, 1000),
    resolve: (result: unknown) => {
      resolved = result;
    },
    reject: (error: Error) => {
      rejected = error;
    }
  };
  const cleanupPending = () => {
    const current = pending;
    pending = undefined;
    if (current) {
      clearTimeout(current.timer);
    }
    return current;
  };
  const rejectPending = (error: Error) => {
    const current = cleanupPending();
    current?.reject(error);
  };
  return {
    get pending() {
      return pending;
    },
    cleanupPending,
    rejectPending,
    getResolved: () => resolved,
    getRejected: () => rejected
  } as any;
}

test("codex app-server compact resolves on the compaction turn lifecycle (no thread/compacted)", () => {
  // codex >= 0.139 runs compaction as a normal turn: turn/started ->
  // thread/tokenUsage/updated (reduced) -> turn/completed, and never emits a
  // dedicated thread/compacted event. The handler must resolve on that turn.
  const runner = makeRunner() as any;
  const participant = { kind: "codex-cli", label: "@codex", model: "gpt-5.5" };
  const ctx = makeCompactPending("session-1");

  assert.equal(runner.handleCodexAppServerCompactNotification({
    method: "turn/started",
    params: { threadId: "session-1", turn: { id: "compact-turn" } }
  }, participant, ctx.pending, ctx.cleanupPending, ctx.rejectPending), true);

  assert.equal(runner.handleCodexAppServerCompactNotification({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "session-1",
      turnId: "compact-turn",
      tokenUsage: {
        total: { totalTokens: 0, inputTokens: 0 },
        last: { totalTokens: 5519, inputTokens: 0 },
        modelContextWindow: 258400
      }
    }
  }, participant, ctx.pending, ctx.cleanupPending, ctx.rejectPending), true);

  assert.equal(runner.handleCodexAppServerCompactNotification({
    method: "turn/completed",
    params: { threadId: "session-1", turn: { id: "compact-turn", status: "completed" } }
  }, participant, ctx.pending, ctx.cleanupPending, ctx.rejectPending), true);

  const resolved = ctx.getResolved();
  assert.equal(resolved.ok, true);
  assert.equal(resolved.sessionId, "session-1");
  assert.equal(resolved.contextUsage.usedTokens, 5519);
  assert.equal(resolved.contextUsage.contextWindowTokens, 258400);
  assert.equal(resolved.contextUsage.percentage, 2);
});

test("codex app-server compact ignores a stray turn/completed before the compaction turn", () => {
  const runner = makeRunner() as any;
  const participant = { kind: "codex-cli", label: "@codex", model: "gpt-5.5" };
  const ctx = makeCompactPending("session-1");

  // A completion that arrives before we ever saw the compaction turn start must
  // be ignored so we do not resolve on a prior turn and report stale usage.
  assert.equal(runner.handleCodexAppServerCompactNotification({
    method: "turn/completed",
    params: { threadId: "session-1", turn: { id: "earlier-turn", status: "completed" } }
  }, participant, ctx.pending, ctx.cleanupPending, ctx.rejectPending), true);
  assert.equal(ctx.getResolved(), undefined);
  assert.equal(ctx.pending !== undefined, true);
});

test("codex app-server compact rejects when the compaction turn fails", () => {
  const runner = makeRunner() as any;
  const participant = { kind: "codex-cli", label: "@codex", model: "gpt-5.5" };
  const ctx = makeCompactPending("session-1");

  runner.handleCodexAppServerCompactNotification({
    method: "turn/started",
    params: { threadId: "session-1", turn: { id: "compact-turn" } }
  }, participant, ctx.pending, ctx.cleanupPending, ctx.rejectPending);

  assert.equal(runner.handleCodexAppServerCompactNotification({
    method: "turn/completed",
    params: { threadId: "session-1", turn: { id: "compact-turn", status: "failed", error: { message: "model overloaded" } } }
  }, participant, ctx.pending, ctx.cleanupPending, ctx.rejectPending), true);

  assert.equal(ctx.getResolved(), undefined);
  assert.match(String(ctx.getRejected()?.message), /model overloaded/);
});

test("findContextUsedTokens reads the last turn total tokens from both codex shapes", () => {
  const runner = makeRunner() as any;
  // Rollout log shape (post-compact: input_tokens 0 but total_tokens carries the summary size).
  assert.equal(runner.findContextUsedTokens({
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { input_tokens: 0, total_tokens: 0 },
        last_token_usage: { input_tokens: 0, total_tokens: 5519 },
        model_context_window: 258400
      }
    }
  }), 5519);
  // App-server event shape.
  assert.equal(runner.findContextUsedTokens({
    method: "thread/tokenUsage/updated",
    params: { tokenUsage: { total: { totalTokens: 0 }, last: { totalTokens: 6093 }, modelContextWindow: 258400 } }
  }), 6093);
  // A populated session prefers the most recent turn over the cumulative total.
  assert.equal(runner.findContextUsedTokens({
    payload: {
      info: {
        total_token_usage: { input_tokens: 65128346, total_tokens: 65320914 },
        last_token_usage: { input_tokens: 150556, total_tokens: 151216 }
      }
    }
  }), 151216);
});

test("agentContextUsageFromEvent resolves a window for current model ids", () => {
  const runner = makeRunner() as any;
  const claude = runner.agentContextUsageFromEvent(
    { message: { model: "claude-opus-4-8", usage: { input_tokens: 4042, cache_creation_input_tokens: 13829, cache_read_input_tokens: 0 } } },
    { kind: "claude-code", label: "@claude" },
    "claude-code"
  );
  assert.equal(claude.usedTokens, 17871);
  assert.equal(claude.contextWindowTokens, 1_000_000);
});

test("claude compact uses the compact-specific timeout", async () => {
  const runner = makeRunner() as any;
  runner.setRunTimeoutMs(2 * 60 * 60_000);
  let timeoutMs: unknown;
  runner.runClaude = async (_participant: unknown, _prompt: string, _repoPath: string | undefined, _kind: string, _signal: AbortSignal | undefined, options: { timeoutMs?: number }) => {
    timeoutMs = options.timeoutMs;
    return { ok: false, sessionId: "session-1", error: "timeout" };
  };

  await runner.compactClaudeSession(
    { kind: "claude-code", label: "@claude" },
    "/repo",
    "chat",
    undefined,
    {
      sessionId: "session-1"
    }
  );

  assert.equal(timeoutMs, 5 * 60_000);
});

test("claude compact runs one-shot so the result reports post-compact usage", async () => {
  const runner = makeRunner() as any;
  let seenWarm: unknown = "unset";
  let seenAllowEmptyContent: unknown = "unset";
  runner.runClaude = async (_participant: unknown, _prompt: string, _repoPath: string | undefined, _kind: string, _signal: AbortSignal | undefined, options: { warm?: unknown; allowEmptyContent?: boolean }) => {
    seenWarm = options.warm;
    seenAllowEmptyContent = options.allowEmptyContent;
    return { ok: true, sessionId: "session-1", contextUsage: { usedTokens: 1995, contextWindowTokens: 1_000_000, percentage: 0, source: "claude-code", updatedAt: "2026-06-17T00:00:00.000Z" } };
  };

  const result = await runner.compactClaudeSession(
    { kind: "claude-code", label: "@claude" },
    "/repo",
    "chat",
    undefined,
    {
      sessionId: "session-1",
      warm: { conversationId: "c1", participantId: "p1", contextKey: "k", idleTimeoutMs: 1000 }
    }
  );

  assert.equal(seenWarm, undefined);
  assert.equal(seenAllowEmptyContent, true);
  assert.equal(result.contextUsage.usedTokens, 1995);
  assert.equal(result.contextUsage.percentage, 0);
});

test("claude compact instructions are sent as part of the native compact command", async () => {
  const runner = makeRunner() as any;
  let prompt: string | undefined;
  runner.runClaude = async (_participant: unknown, value: string) => {
    prompt = value;
    return { ok: true, sessionId: "session-1" };
  };

  const result = await runner.compactClaudeSession(
    { kind: "claude-code", label: "@claude" },
    "/repo",
    "chat",
    undefined,
    {
      sessionId: "session-1",
      compactInstructions: "keep focus on user approval and test output"
    }
  );

  assert.equal(result.ok, true);
  assert.equal(prompt, "/compact keep focus on user approval and test output");
});

test("codexPrompt chat envelope passes the inner prompt through and does not duplicate permission text", () => {
  const runner = makeRunner() as any;
  const innerPrompt = "INNER_PROMPT_MARKER";
  const wrapped = runner.codexPrompt(innerPrompt, "/repo", undefined, "chat", chatOptions({
    agentMode: "default",
    workspaceWrite: false,
    webAccess: false,
    canRequestPermissions: true
  }));

  assert.match(wrapped, /You are running for AccordAgents Chat in default mode/);
  assert.match(wrapped, /Read-only file inspection/);
  assert.ok(wrapped.includes(innerPrompt));
  assert.doesNotMatch(wrapped, /Shell commands are blocked for this turn/);
  assert.doesNotMatch(wrapped, /Workspace file edits are blocked for this turn/);
  assert.doesNotMatch(wrapped, /Web access is blocked for this turn/);
  assert.doesNotMatch(wrapped, /app_permissions_request_change/);
});

test("codexPrompt chat envelope reflects plan agent mode in its header", () => {
  const runner = makeRunner() as any;
  const wrapped = runner.codexPrompt("INNER", "/repo", undefined, "chat", chatOptions({
    agentMode: "plan",
    workspaceWrite: true,
    webAccess: false,
    canRequestPermissions: true
  }));

  assert.match(wrapped, /You are running for AccordAgents Chat in plan mode/);
});

test("codexPrompt chat envelope marks runs without readable context", () => {
  const runner = makeRunner() as any;
  const wrapped = runner.codexPrompt("INNER", undefined, undefined, "chat", chatOptions({
    agentMode: "default",
    workspaceWrite: false,
    canRequestPermissions: false
  }));

  assert.match(wrapped, /No repository or app-managed readable directory is available/);
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

  const message = runner.commandErrorText(error);

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

  const result = runner.failed({ label: "@sam-codex-qa-lead" } as any, error);

  assert.equal(result.content, "@sam-codex-qa-lead could not finish because the Slack MCP server needs authorization.");
  assert.match(result.error, /AuthRequired/);
  assert.doesNotMatch(result.content, /AuthRequired|Transport channel closed|1800000ms/);
});

test("failed formats CLI timeout content in human-readable time", () => {
  const runner = makeRunner() as any;

  const result = runner.failed(
    { label: "@sam-codex-qa-lead" } as any,
    new Error("codex app-server timed out after 86400000ms")
  );

  assert.equal(result.content, "@sam-codex-qa-lead timed out after 24 hours.");
  assert.match(result.error, /86400000ms/);
});

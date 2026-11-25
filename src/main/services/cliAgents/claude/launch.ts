import { createHash } from "node:crypto";
import type { ChatReasoningEffort, ChatShellPermissionRule, ConversationKind, ParticipantConfig } from "../../../../shared/types";
import { chatAgentModeForKind, normalizeChatAgentPermissions } from "../../../../shared/agentPermissions";
import { applyChatAccessOptionById } from "../../../../shared/chatAccessModes";
import { normalizeChatReasoningEffort } from "../../../../shared/reasoningEffort";
import { APP_TOOL_PERMISSION_WAIT_MS } from "../../../../shared/appMcpToolContracts";
import { claudeCodePermissionMode, type ClaudePermissionMode } from "./permissionModes";
import type { ClaudeToolConfig } from "./types";
import { errorText } from "../runs/outputText";
import { agentModeForRun, permissionsForRun } from "../runs/runEnvironment";
import type { CliAgentAppMcpOptions, CliAgentImageInput, CliAgentRunOptions } from "../types";

const APP_PERMISSIONS_REQUEST_CHANGE_TOOL = "app_permissions_request_change";
const APP_TOOL_PERMISSION_TOOL = "app_tool_permission";
const APP_TOOL_PERMISSION_MCP_TOOL = `mcp__accord_agents__${APP_TOOL_PERMISSION_TOOL}`;

/**
 * How long Claude Code waits on a call of the app's tools (the app MCP
 * server's own `timeout`, ms). Its default gives up on Claude Code's
 * permission prompt after 60 s (an HTTP server's answer) while the User's
 * card waits APP_TOOL_PERMISSION_WAIT_MS: then her answer reached nobody
 * (Claude Code 2.1.329). It is a hard limit per call (progress does not
 * extend it), so it is the app's wait and five minutes more: the app answers
 * first (it denies at the end of its wait), and a sign-in card's reconnect
 * after a late answer still fits. Set for this server only, never
 * MCP_TOOL_TIMEOUT, which would change the User's own MCP servers too.
 */
export const CLAUDE_APP_MCP_TOOL_TIMEOUT_MS = APP_TOOL_PERMISSION_WAIT_MS + 5 * 60_000;

export function claudeReasoningEffort(value: ChatReasoningEffort | undefined): ChatReasoningEffort | undefined {
  return normalizeChatReasoningEffort(value, "claude-code");
}

/** The run's options with Claude Code's mode set to `mode` (its file-edit
 *  right telling Manual from Accept edits): in its own modes only
 *  `--permission-mode` depends on it. */
export function withClaudePermissionMode(options: CliAgentRunOptions, mode: ClaudePermissionMode): CliAgentRunOptions {
  const access = applyChatAccessOptionById("claude-code", mode, options.permissions);
  return { ...options, agentMode: access.agentMode, permissions: access.permissions };
}

export function claudeLaunchArgs(
  participant: ParticipantConfig,
  kind: ConversationKind,
  options: CliAgentRunOptions,
  toolConfig: ClaudeToolConfig,
  extraReadableDirs: string[],
  transport: "one-shot" | "one-shot-stream" | "warm",
  newSessionId?: string,
  promptSuggestions = false
): string[] {
  const args = transport === "warm"
    ? [
        "-p",
        "--verbose",
        "--include-partial-messages",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        // The CLI predicts the User's next prompt after each reply, as the
        // dedicated CLI does in its input (its own setting can turn it off).
        ...(promptSuggestions ? ["--prompt-suggestions"] : []),
        "--permission-mode",
        toolConfig.permissionMode
      ]
    : transport === "one-shot-stream"
      ? [
          "-p",
          "--verbose",
          "--include-partial-messages",
          "--output-format",
          "stream-json",
          "--permission-mode",
          toolConfig.permissionMode
        ]
      : [
        "-p",
        "--output-format",
        "json",
        "--permission-mode",
        toolConfig.permissionMode
      ];
  args.push(...claudeAllowedToolsArgs(kind, options, toolConfig));
  if (toolConfig.disallowedTools.length > 0) {
    args.push("--disallowedTools", toolConfig.disallowedTools.join(","));
  }
  if (toolConfig.askTools.length > 0) {
    args.push("--settings", JSON.stringify({ permissions: { ask: toolConfig.askTools } }));
  }
  if (options.sessionId) {
    args.push("--resume", options.sessionId);
  } else if (options.forkFromSessionId) {
    // The copy is a new session with the id given here (Claude Code
    // 2.1.329 reports it on every event); the source session is not
    // written to.
    args.push("--resume", options.forkFromSessionId, "--fork-session");
    // Fork to new chat: only up to the reply the User saw last (Claude
    // Code 2.1.329 keeps the session through this assistant message).
    if (options.forkResumeAt) {
      args.push("--resume-session-at", options.forkResumeAt);
    }
    if (newSessionId) {
      args.push("--session-id", newSessionId);
    }
  } else if (newSessionId) {
    args.push("--session-id", newSessionId);
  }
  if (participant.model) {
    args.push("--model", participant.model);
  }
  if (options.claudeChrome) {
    args.push("--chrome");
  }
  const reasoningEffort = claudeReasoningEffort(participant.reasoningEffort);
  if (reasoningEffort) {
    args.push("--effort", reasoningEffort);
  }
  // The member's instructions go on top of Claude Code's own system prompt
  // on every launch, as the dedicated CLI's `--append-system-prompt` adds
  // them. Claude Code 2.1.330 records the system prompt on a conversation's
  // first request and sends that record on every later request and resume
  // until the conversation is compacted, when it renders it again from the
  // launch's text; a fork keeps its source's record. So a resumed or forked
  // session keeps what it started with, and the caller says what changed.
  // (A main-thread `--agent` replaced Claude Code's own system prompt, and a
  // resume without its definition dropped the member's instructions.)
  if (options.role) {
    args.push("--append-system-prompt", options.role.instructions);
  }
  args.push(...claudeMcpArgs(kind, options));
  args.push(...claudePermissionPromptArgs(kind, options));
  if (extraReadableDirs.length > 0) {
    args.push("--add-dir", ...extraReadableDirs);
  }
  args.push(...claudeToolsArgs(kind, toolConfig, options));
  return args;
}

/** A uuid-stamped message makes the CLI report its queue state under that
 *  id (`command_lifecycle`). */
export function claudeWarmUserMessage(prompt: string, uuid?: string, images?: CliAgentImageInput[]): Record<string, unknown> {
  // Pictures go as the image blocks of the message, as a picture pasted
  // into the dedicated CLI does; a message of pictures alone has no text.
  const content: Array<Record<string, unknown>> = [
    ...(prompt || !images?.length ? [{ type: "text", text: prompt }] : []),
    ...(images ?? []).map((image) => ({
      type: "image",
      source: { type: "base64", media_type: image.mimeType, data: image.dataBase64 }
    }))
  ];
  return {
    type: "user",
    ...(uuid ? { uuid } : {}),
    message: {
      role: "user",
      content
    },
    parent_tool_use_id: null
  };
}

export function shouldPassClaudeAllowedTools(kind: ConversationKind, options: CliAgentRunOptions): boolean {
  // In Claude Code's own modes the allow list is the same in every mode
  // (claudeToolConfig); the CLI's Auto applies it as the CLI does.
  if (claudeOwnMode(kind, options)) {
    return true;
  }
  return !(kind === "chat" && chatAgentModeForKind("claude-code", agentModeForRun(kind, options)) === "auto");
}

export function claudeAllowedToolsArgs(kind: ConversationKind, options: CliAgentRunOptions, toolConfig: ClaudeToolConfig): string[] {
  const allowedTools = shouldPassClaudeAllowedTools(kind, options)
    ? toolConfig.allowedTools
    : claudeAutoAllowedAppMcpTools(kind, options, toolConfig);
  return allowedTools.length > 0 ? ["--allowedTools", allowedTools.join(",")] : [];
}

export function claudeAutoAllowedAppMcpTools(kind: ConversationKind, options: CliAgentRunOptions, toolConfig: ClaudeToolConfig): string[] {
  if (kind !== "chat" || chatAgentModeForKind("claude-code", agentModeForRun(kind, options)) !== "auto") {
    return [];
  }
  const exposedAppTools = new Set(options.appMcp?.toolNames ?? []);
  const autoPreauthorizedTools = new Set(options.appMcp?.autoPreauthorizedToolNames ?? []);
  const configuredAllowedTools = new Set(toolConfig.allowedTools);
  return Array.from(autoPreauthorizedTools)
    .filter((toolName) => toolName !== APP_TOOL_PERMISSION_TOOL)
    .filter((toolName) => exposedAppTools.has(toolName))
    .map((toolName) => `mcp__accord_agents__${toolName}`)
    .filter((toolName) => configuredAllowedTools.has(toolName));
}

export function claudeMcpArgs(kind: ConversationKind, options: CliAgentRunOptions): string[] {
  if (options.isolated) {
    // Without --strict-mcp-config the CLI boots every server from the user's
    // own config; an app-internal run must not spend their tokens or wait for
    // those connections.
    return ["--mcp-config", "{\"mcpServers\":{}}", "--strict-mcp-config"];
  }
  if (!options.appMcp) {
    return [];
  }
  return kind === "chat"
    ? ["--mcp-config", claudeMcpConfigJson(options.appMcp)]
    : ["--mcp-config", claudeMcpConfigJson(options.appMcp), "--strict-mcp-config"];
}

export function claudePermissionPromptArgs(kind: ConversationKind, options: CliAgentRunOptions): string[] {
  const permissionPromptTool = claudePermissionPromptTool(kind, options);
  return permissionPromptTool ? ["--permission-prompt-tool", permissionPromptTool] : [];
}

function claudePermissionPromptTool(kind: ConversationKind, options: CliAgentRunOptions): string | undefined {
  const agentMode = chatAgentModeForKind("claude-code", agentModeForRun(kind, options));
  if (
    kind !== "chat" ||
    // Every mode of Claude Code's own asks through the cards: the process
    // may be switched into a mode that asks while it runs.
    (!claudeOwnMode(kind, options) && agentMode !== "default" && agentMode !== "auto") ||
    !options.appMcp?.toolNames.includes(APP_TOOL_PERMISSION_TOOL)
  ) {
    return undefined;
  }
  return APP_TOOL_PERMISSION_MCP_TOOL;
}

export function claudeToolsArgs(kind: ConversationKind, toolConfig: ClaudeToolConfig, options: CliAgentRunOptions): string[] {
  if (kind === "chat") {
    return [];
  }
  const tools = claudeToolsWithAppMcp(toolConfig.tools, options);
  return ["--tools", tools.length > 0 ? tools.join(",") : ""];
}

function claudeToolsWithAppMcp(tools: string[], options: CliAgentRunOptions): string[] {
  const next = new Set(tools);
  for (const toolName of options.appMcp?.toolNames ?? []) {
    next.add(`mcp__accord_agents__${toolName}`);
  }
  return Array.from(next);
}

function claudeMcpConfigJson(appMcp: CliAgentAppMcpOptions): string {
  return JSON.stringify({
    mcpServers: {
      accord_agents: {
        type: "http",
        url: appMcp.url,
        headers: {
          Authorization: `Bearer ${appMcp.token}`
        },
        timeout: CLAUDE_APP_MCP_TOOL_TIMEOUT_MS
      }
    }
  });
}

export function claudeToolListArg(args: string[], flag: string): string[] {
  const index = args.indexOf(flag);
  if (index < 0) {
    return [];
  }
  return (args[index + 1] ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

export function redactedClaudeArgs(args: string[]): string[] {
  const sensitiveValueFlags = new Set(["--append-system-prompt", "--mcp-config", "--settings"]);
  const redacted: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    redacted.push(arg);
    if (sensitiveValueFlags.has(arg) && index + 1 < args.length) {
      redacted.push("<redacted>");
      index += 1;
    }
  }
  return redacted;
}

export function stableToolInventoryHash(toolNames: string[]): string {
  return createHash("sha256").update([...toolNames].sort().join("\0")).digest("hex").slice(0, 16);
}

export function claudePermissionMode(kind: ConversationKind, options: CliAgentRunOptions): ClaudePermissionMode {
  return claudeCodePermissionMode(agentModeForRun(kind, options), options.permissions);
}

/** A chat member in Claude Code's own mode (the sessions view's access,
 *  `cliApprovals`): only `--permission-mode` tells its modes apart, so the
 *  mode can change in its live process, as Shift+Tab changes it in the
 *  CLI (claudeToolConfig). */
export function claudeOwnMode(kind: ConversationKind, options: CliAgentRunOptions): boolean {
  return kind === "chat" && normalizeChatAgentPermissions(options.permissions).cliApprovals === true;
}

export function claudeToolConfig(
  kind: ConversationKind,
  repoPath: string | undefined,
  extraReadableDirs: string[],
  options: CliAgentRunOptions
): ClaudeToolConfig {
  const agentMode = chatAgentModeForKind("claude-code", agentModeForRun(kind, options));
  const permissionMode = claudePermissionMode(kind, options);
  // Claude Code's own modes (the sessions view's Manual, Accept edits, Plan
  // and Auto): what is not granted is not taken away but asked about, each
  // ask an approval card through --permission-prompt-tool, as the CLI asks
  // in its terminal. Deny rules stay hard stops. The tools are the same in
  // every mode and only --permission-mode tells them apart, so the CLI's
  // own Plan mode and Auto classifier decide, and the mode can change in
  // the live process mid-reply exactly as Shift+Tab changes it in the CLI.
  const asksForUngranted = claudeOwnMode(kind, options);
  const permissions = asksForUngranted
    ? normalizeChatAgentPermissions(options.permissions)
    : permissionsForRun("claude-code", agentMode, options);
  const tools = new Set<string>();
  const allowedTools: string[] = [];
  const disallowedTools: string[] = [];
  const askTools: string[] = [];
  const providerNativeAllowedTools = permissions.providerNative?.["claude-code"]?.allowedTools ?? [];
  const readContextAvailable = Boolean(repoPath) || extraReadableDirs.length > 0;
  const readTools = ["Read", "Grep", "Glob", "LS"];
  // Claude Code 2.1 validates --disallowedTools strictly and rejects MultiEdit as
  // unknown. Current builds expose ordinary file mutation through Edit/Write and
  // notebook mutation through NotebookEdit.
  const editTools = ["Edit", "Write", "NotebookEdit"];
  const webTools = ["WebSearch", "WebFetch"];

  if (readContextAvailable) {
    for (const tool of readTools) {
      tools.add(tool);
    }
  }
  if (permissions.webAccess) {
    for (const tool of webTools) {
      tools.add(tool);
      allowedTools.push(tool);
    }
  } else if (asksForUngranted) {
    for (const tool of webTools) {
      tools.add(tool);
    }
  } else {
    disallowedTools.push(...webTools);
  }
  if (permissions.workspaceWrite || asksForUngranted) {
    for (const tool of editTools) {
      tools.add(tool);
    }
  } else {
    disallowedTools.push(...editTools);
  }
  if (permissions.shell.enabled) {
    tools.add("Bash");
    for (const rule of permissions.shell.rules) {
      const toolRule = claudeBashPermissionRule(rule);
      if (agentMode !== "auto" || asksForUngranted) {
        // Classic Auto uses the provider's native classifier without app-stored shell policy.
        // Default mode, and every mode of the CLI's own, honor every explicit app rule.
        if (rule.action === "deny") {
          disallowedTools.push(toolRule);
        } else if (rule.action === "allow") {
          // In Claude Code's own modes a CLI rule too, the same in every
          // mode: Claude Code applies it as a rule in her own settings
          // (its parsing, deny > ask > allow, what its Auto strips, and
          // how its Plan mode treats an allowed command).
          allowedTools.push(toolRule);
        } else {
          askTools.push(toolRule);
        }
      }
    }
  } else if (asksForUngranted) {
    tools.add("Bash");
    for (const rule of permissions.shell.rules) {
      if (rule.action === "deny") {
        disallowedTools.push(claudeBashPermissionRule(rule));
      }
    }
  } else {
    disallowedTools.push("Bash");
  }
  for (const toolRule of providerNativeAllowedTools) {
    allowedTools.push(toolRule);
    const toolName = claudeToolNameFromAllowedTool(toolRule);
    if (toolName) {
      tools.add(toolName);
    }
  }
  // Claude Code's own modes: only the app tools pre-authorized for its Auto
  // (app_chat_export_attachment, which writes into the project, is left to
  // the CLI there), in every mode, since the process is the same in all;
  // in Manual the rest is asked through the cards.
  const autoPreauthorizedAppTools = new Set(options.appMcp?.autoPreauthorizedToolNames ?? []);
  for (const toolName of options.appMcp?.toolNames ?? []) {
    if (asksForUngranted && (toolName === APP_TOOL_PERMISSION_TOOL || !autoPreauthorizedAppTools.has(toolName))) continue;
    allowedTools.push(`mcp__accord_agents__${toolName}`);
  }
  // Claude's native Skill tool is read-only skill discovery/loading. It must be present even
  // when no slash skill was selected so participants can truthfully inspect available skills.
  // An isolated app run has no skills to inspect and no reason to spawn subagents.
  if (!options.isolated) {
    tools.add("Skill");
    allowedTools.push("Skill");
  }
  // Always-on subagent spawning for Claude participants. The subagent tool is registered as
  // "Agent" in current Claude Code (params prompt/subagent_type); "Task" is the older name and
  // is listed too for version robustness — unknown tool names are ignored by the CLI. Subagents
  // inherit this run's permissions and are separate from chat participant requests.
  for (const subagentTool of options.isolated ? [] : ["Agent", "Task"]) {
    tools.add(subagentTool);
    allowedTools.push(subagentTool);
  }
  const disallowedToolSet = new Set(disallowedTools);
  for (const toolRule of providerNativeAllowedTools) {
    const toolName = claudeToolNameFromAllowedTool(toolRule);
    if (toolName) {
      disallowedToolSet.delete(toolName);
    }
  }

  return {
    permissionMode,
    tools: Array.from(tools),
    allowedTools: Array.from(new Set(allowedTools)),
    disallowedTools: Array.from(disallowedToolSet),
    askTools: Array.from(new Set(askTools))
  };
}

function claudeToolNameFromAllowedTool(toolRule: string): string | undefined {
  const trimmed = toolRule.trim();
  if (!trimmed) {
    return undefined;
  }
  const parenIndex = trimmed.indexOf("(");
  return parenIndex > 0 ? trimmed.slice(0, parenIndex) : trimmed;
}

function claudeBashPermissionRule(rule: ChatShellPermissionRule): string {
  const pattern = rule.pattern.trim();
  return rule.match === "prefix" ? `Bash(${pattern}:*)` : `Bash(${pattern})`;
}

function canRequestPermissionChanges(options: CliAgentRunOptions): boolean {
  return Boolean(options.appMcp?.toolNames.includes(APP_PERMISSIONS_REQUEST_CHANGE_TOOL));
}

export function isClaudeAgentFlagUnsupported(error: unknown): boolean {
  const message = errorText(error).toLowerCase();
  return (
    /(?:unknown|unrecognized|invalid|unsupported).{0,80}--append-system-prompt/.test(message) ||
    /--append-system-prompt.{0,80}(?:unknown|unrecognized|invalid|unsupported)/.test(message)
  );
}

export function isClaudePermissionModeUnsupported(error: unknown): boolean {
  // Heuristic: older Claude CLIs without the `auto` permission mode reject the flag
  // value. Match errors that name permission-mode alongside an invalid/unknown/choices
  // hint, or an invalid `auto` value near "permission".
  const message = errorText(error).toLowerCase();
  return (
    /(?:unknown|unrecognized|invalid|unsupported|choices|must be|expected).{0,80}permission-mode/.test(message) ||
    /permission-mode.{0,80}(?:unknown|unrecognized|invalid|unsupported|choices|must be|expected)/.test(message) ||
    /invalid.{0,40}\bauto\b.{0,40}permission/.test(message)
  );
}

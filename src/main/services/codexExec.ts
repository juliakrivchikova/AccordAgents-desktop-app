import type {
  ChatAgentMode,
  ChatAgentPermissions,
  ChatProviderKind,
  ChatReasoningEffort,
  ConversationKind,
  GitDiffMode,
  ParticipantConfig
} from "../../shared/types";
import { effectiveChatAgentPermissionsForProvider, normalizeChatAgentMode, normalizeChatAgentPermissions } from "../../shared/agentPermissions";

export const CODEX_APP_SERVER_MCP_TOKEN_ENV = "ACCORD_AGENTS_MCP_TOKEN";
export const CODEX_AUTO_APPROVALS_REVIEWER = "guardian_subagent";

export type CodexLiveOutputKind = "tool" | "text";

export interface CodexLiveOutputEvent {
  kind: CodexLiveOutputKind;
  text: string;
  cumulative?: string;
}

export type CodexLiveOutputCallback = (event: CodexLiveOutputEvent) => void;
export type CodexSessionIdCallback = (sessionId: string) => void;

export interface CodexExecRoleOptions {
  instructions: string;
}

export interface CodexExecAppMcpOptions {
  url: string;
  token: string;
}

export interface CodexExecRemoteSandboxOptions {
  // The remote worker box is a dedicated dev environment: remote runs keep the
  // workspace-write sandbox but open network access (gh/npm need it) and make
  // the workspace .git writable (workspace-write mounts it read-only by
  // default, which blocks the agent from committing).
  networkAccess?: boolean;
  gitWritableRoot?: string;
}

export interface CodexExecOptions {
  sessionId?: string;
  extraReadableDirs?: string[];
  role?: CodexExecRoleOptions;
  appMcp?: CodexExecAppMcpOptions;
  agentMode?: ChatAgentMode;
  permissions?: ChatAgentPermissions;
  // When true, do NOT run no-repo sessions as `--ephemeral`, so codex persists
  // the rollout and `codex exec resume <sessionId>` can continue the session
  // (required for the remote offline-permission round-trip). Mirrors the
  // app-server `ephemeral: !persistSession` behavior used by local chat.
  persistSession?: boolean;
  remoteSandbox?: CodexExecRemoteSandboxOptions;
}

export interface CodexExecInvocation {
  args: string[];
  input: string;
  env?: NodeJS.ProcessEnv;
}

export interface BuildCodexExecInvocationRequest {
  participant: ParticipantConfig;
  prompt: string;
  outputPath: string;
  repoPath?: string;
  diffMode?: GitDiffMode;
  kind: ConversationKind;
  options?: CodexExecOptions;
}

export function buildCodexExecInvocation(request: BuildCodexExecInvocationRequest): CodexExecInvocation {
  const options = request.options ?? {};
  const resuming = Boolean(options.sessionId);
  const mode = agentModeForRun(request.kind, options);
  const permissions = permissionsForRun("codex-cli", mode, options);
  const args = resuming
    ? [
        "exec",
        "resume",
        "--json",
        "--output-last-message",
        request.outputPath,
        options.sessionId as string,
        "-"
      ]
    : [
        "exec",
        "--sandbox",
        permissions.workspaceWrite ? "workspace-write" : "read-only",
        "--json",
        "--output-last-message",
        request.outputPath,
        "-"
      ];

  if (request.participant.model && !resuming) {
    args.splice(args.length - 1, 0, "--model", request.participant.model);
  }
  const reasoningEffort = codexReasoningEffort(request.participant.reasoningEffort);
  if (reasoningEffort) {
    insertCodexOptionBeforePrompt(args, resuming, "-c", `model_reasoning_effort=${tomlString(reasoningEffort)}`);
  }
  if (!resuming) {
    for (const dir of normalizedExtraReadableDirs(options.extraReadableDirs)) {
      args.splice(args.length - 1, 0, "--add-dir", dir);
    }
  }
  if (request.repoPath && !resuming) {
    args.splice(1, 0, "--cd", request.repoPath);
    if (request.kind === "chat") {
      args.splice(1, 0, "--skip-git-repo-check");
    }
  } else if (!request.repoPath && !resuming) {
    const noRepoFlags = options.persistSession
      ? ["--skip-git-repo-check", "--ignore-rules"]
      : ["--skip-git-repo-check", "--ephemeral", "--ignore-rules"];
    args.splice(1, 0, ...noRepoFlags);
  } else if (!request.repoPath && resuming) {
    args.splice(2, 0, "--skip-git-repo-check");
  } else if (request.kind === "chat" && resuming) {
    args.splice(2, 0, "--skip-git-repo-check");
  }
  if (resuming) {
    insertCodexOptionBeforePrompt(
      args,
      resuming,
      "-c",
      `sandbox_mode=${tomlString(permissions.workspaceWrite ? "workspace-write" : "read-only")}`
    );
  }
  if (options.remoteSandbox?.networkAccess) {
    insertCodexOptionBeforePrompt(args, resuming, "-c", "sandbox_workspace_write.network_access=true");
  }
  if (options.remoteSandbox?.gitWritableRoot) {
    insertCodexOptionBeforePrompt(
      args,
      resuming,
      "-c",
      `sandbox_workspace_write.writable_roots=[${tomlString(options.remoteSandbox.gitWritableRoot)}]`
    );
  }
  if (mode === "auto") {
    insertCodexOptionBeforePrompt(
      args,
      resuming,
      "-c",
      `approval_policy=${tomlString("on-request")}`,
      "-c",
      `approvals_reviewer=${tomlString(CODEX_AUTO_APPROVALS_REVIEWER)}`
    );
  }
  if (options.role) {
    insertCodexOptionBeforePrompt(args, resuming, "-c", `developer_instructions=${tomlString(options.role.instructions)}`);
  }
  if (options.appMcp) {
    insertCodexOptionBeforePrompt(
      args,
      resuming,
      "-c",
      `mcp_servers.accord_agents.url=${tomlString(options.appMcp.url)}`,
      "-c",
      `mcp_servers.accord_agents.bearer_token_env_var=${tomlString(CODEX_APP_SERVER_MCP_TOKEN_ENV)}`
    );
  }
  if (permissions.webAccess) {
    args.unshift("--search");
  }

  return {
    args,
    input: codexPrompt(request.prompt, request.repoPath, request.diffMode, request.kind, options),
    env: codexAppMcpEnv(options)
  };
}

export function codexAppMcpEnv(options: CodexExecOptions = {}): NodeJS.ProcessEnv | undefined {
  if (!options.appMcp) {
    return undefined;
  }
  return {
    [CODEX_APP_SERVER_MCP_TOKEN_ENV]: options.appMcp.token
  };
}

export function createCodexLineHandler(onLine: (line: string) => void): (chunk: string) => void {
  let buffer = "";
  return (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        onLine(line);
      }
      newline = buffer.indexOf("\n");
    }
  };
}

export function emitCodexLiveOutput(
  line: string,
  onOutput: CodexLiveOutputCallback | undefined,
  deltaAccumulator?: { value: string },
  onSessionId?: CodexSessionIdCallback
): void {
  try {
    const event = JSON.parse(line) as unknown;
    reportCodexSessionId(onSessionId, findCodexSessionIdInValue(event));
    if (!onOutput) {
      return;
    }
    const delta = extractCodexAssistantStreamingDelta(event);
    if (delta && deltaAccumulator) {
      deltaAccumulator.value += delta;
      emitLiveOutput(onOutput, "text", delta, deltaAccumulator.value);
      return;
    }
    const toolSummary = codexToolSummary(event);
    if (toolSummary) {
      emitLiveOutput(onOutput, "tool", `${toolSummary}\n`);
    }
  } catch {
    // Ignore non-JSON CLI output in live rendering; raw output is still spooled.
  }
}

export function reportCodexSessionId(
  onSessionId: CodexSessionIdCallback | undefined,
  sessionId: string | undefined
): void {
  const normalized = sessionId?.trim();
  if (!normalized) {
    return;
  }
  onSessionId?.(normalized);
}

export function extractCodexSessionId(stdout: string): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const event = JSON.parse(line) as unknown;
      const sessionId = findCodexSessionIdInValue(event);
      if (sessionId) {
        return sessionId;
      }
    } catch {
      // Ignore non-JSON status lines from the CLI.
    }
  }
  return undefined;
}

export function extractCodexText(stdout: string): string {
  const messages: string[] = [];
  const deltas: string[] = [];
  const plainLines: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const event = JSON.parse(line) as unknown;
      const message = extractCodexAssistantMessage(event);
      if (message) {
        messages.push(message);
      }
      const delta = extractCodexAssistantDelta(event);
      if (delta) {
        deltas.push(delta);
      }
    } catch {
      plainLines.push(line.trim());
    }
  }
  return messages.at(-1) ?? (deltas.join("").trim() || plainLines.join("\n").trim() || stdout.trim());
}

function emitLiveOutput(
  onOutput: CodexLiveOutputCallback | undefined,
  kind: CodexLiveOutputKind,
  text: string,
  cumulative?: string
): void {
  const clean = cleanLiveOutputText(text);
  if (!onOutput || !clean) {
    return;
  }
  const cleanCumulative = cumulative !== undefined ? cleanLiveOutputText(cumulative) : undefined;
  onOutput({ kind, text: clean, cumulative: cleanCumulative });
}

function cleanLiveOutputText(text: string): string {
  return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function codexToolSummary(event: unknown): string | undefined {
  const record = asRecord(event);
  if (!record) {
    return undefined;
  }
  const method = stringField(record, "method");
  if (method === "item/autoApprovalReview/started") {
    return "Auto-reviewing approval request";
  }
  if (method === "item/autoApprovalReview/completed") {
    return "Auto-review completed";
  }
  const item = asRecord(record.item) ?? record;
  const type = `${stringField(record, "type") ?? ""} ${stringField(item, "type") ?? ""}`.toLowerCase();
  const name = stringField(item, "name") ?? stringField(item, "tool_name");
  const command = stringField(item, "command") ?? stringField(item, "cmd");
  if (command && /command|exec|shell|bash/.test(type)) {
    return "Running command";
  }
  if (name && /tool|function|call/.test(type)) {
    return toolActivityLabel(name);
  }
  if (/read|grep|glob|ls/.test(type) && name) {
    return toolActivityLabel(name);
  }
  return undefined;
}

function toolActivityLabel(name: string): string {
  const normalized = name.toLowerCase();
  if (normalized === "read") {
    return "Reading file";
  }
  if (normalized === "grep") {
    return "Searching files";
  }
  if (normalized === "glob") {
    return "Scanning files";
  }
  if (normalized === "ls") {
    return "Listing files";
  }
  return `Using ${name}`;
}

function codexPrompt(
  prompt: string,
  repoPath: string | undefined,
  diffMode: GitDiffMode | undefined,
  kind: ConversationKind,
  options: CodexExecOptions = {}
): string {
  if (kind === "implementation-plan") {
    return [
      "You are running inside the selected repository in plan mode and read-only sandbox mode.",
      "Inspect files and git state as needed. Do not edit files, run mutating commands, install dependencies, or wait for terminal confirmation.",
      "If a blocking product or technical decision is needed, report it in the requested output format instead of asking interactively.",
      prompt
    ].join("\n\n");
  }

  if (kind === "chat") {
    const mode = agentModeForRun(kind, options);
    const readContextAvailable = Boolean(repoPath) || normalizedExtraReadableDirs(options.extraReadableDirs).length > 0;
    return [
      `You are running for AccordAgents Chat in ${mode} mode.`,
      readContextAvailable
        ? "Read-only file inspection, search, and listing are allowed for the selected repository and app-managed history files described in the prompt. Use these only to gather context."
        : "No repository or app-managed readable directory is available for this run.",
      prompt
    ].join("\n\n");
  }

  const hasRepoContext = Boolean(repoPath) && (kind === "code-review" || Boolean(diffMode));

  return [
    hasRepoContext
      ? "You are running inside the selected repository in read-only mode. Inspect files and git state as needed. Do not edit files."
      : diffMode
        ? "Use the provided diff context. Do not inspect local files unless repository context is explicitly provided."
        : "Answer the user's question directly. Do not inspect local files unless context is explicitly provided.",
    diffMode ? `The user selected diff mode: ${diffMode}.` : "",
    prompt
  ]
    .filter(Boolean)
    .join("\n\n");
}

function agentModeForRun(kind: ConversationKind, options: CodexExecOptions): ChatAgentMode {
  return kind === "chat" ? normalizeChatAgentMode(options.agentMode) : "plan";
}

function permissionsForRun(
  providerKind: ChatProviderKind | undefined,
  mode: ChatAgentMode,
  options: CodexExecOptions
): ChatAgentPermissions {
  return effectiveChatAgentPermissionsForProvider(providerKind, mode, normalizeChatAgentPermissions(options.permissions));
}

function normalizedExtraReadableDirs(dirs: string[] | undefined): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const dir of dirs ?? []) {
    const trimmed = dir.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function insertCodexOptionBeforePrompt(args: string[], resuming: boolean, ...items: string[]): void {
  const promptIndex = resuming ? Math.max(args.length - 2, 2) : Math.max(args.length - 1, 1);
  args.splice(promptIndex, 0, ...items);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function codexReasoningEffort(value: ChatReasoningEffort | undefined): ChatReasoningEffort | undefined {
  return value && value !== "none" ? value : undefined;
}

function extractCodexAssistantMessage(event: unknown): string | undefined {
  const record = asRecord(event);
  if (!record) {
    return undefined;
  }

  const type = stringField(record, "type");
  if (type === "agent_message") {
    return stringField(record, "message")?.trim();
  }

  const item = asRecord(record.item);
  if (item) {
    return textFromAssistantMessageItem(item);
  }

  return textFromAssistantMessageItem(record);
}

function extractCodexAssistantDelta(event: unknown): string | undefined {
  const record = asRecord(event);
  if (!record) {
    return undefined;
  }
  const type = stringField(record, "type") ?? "";
  if (!type.includes("output_text") && type !== "agent_message_delta") {
    return undefined;
  }
  return stringField(record, "delta") ?? stringField(record, "text") ?? stringField(record, "message");
}

function extractCodexAssistantStreamingDelta(event: unknown): string | undefined {
  const record = asRecord(event);
  if (!record) {
    return undefined;
  }
  const type = stringField(record, "type");
  if (type !== "agent_message_delta" && type !== "response.output_text.delta") {
    return undefined;
  }
  return stringField(record, "delta");
}

function textFromAssistantMessageItem(item: Record<string, unknown>): string | undefined {
  const itemType = stringField(item, "type");
  const role = stringField(item, "role");
  if (itemType !== "message" && itemType !== "assistant_message" && role !== "assistant") {
    return undefined;
  }
  if (role && role !== "assistant") {
    return undefined;
  }

  const directText = stringField(item, "message") ?? stringField(item, "text") ?? stringField(item, "output_text");
  if (directText?.trim()) {
    return directText.trim();
  }

  const content = item.content;
  if (typeof content === "string") {
    return content.trim() || undefined;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }

  const texts = content
    .map((block) => {
      if (typeof block === "string") {
        return block;
      }
      const blockRecord = asRecord(block);
      if (!blockRecord) {
        return "";
      }
      return stringField(blockRecord, "text") ?? stringField(blockRecord, "output_text") ?? "";
    })
    .filter((text) => text.trim());

  return texts.length ? texts.join("\n").trim() : undefined;
}

function findCodexSessionIdInValue(value: unknown): string | undefined {
  const stack: unknown[] = [value];
  const preferredKeys = new Set(["session_id", "sessionId", "conversation_id", "conversationId", "thread_id", "threadId", "id"]);
  while (stack.length) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    const record = asRecord(current);
    if (!record) {
      continue;
    }
    for (const key of preferredKeys) {
      const sessionId = uuidText(record[key]);
      if (sessionId) {
        return sessionId;
      }
    }
    const type = stringField(record, "type") ?? "";
    if (type.toLowerCase().includes("session")) {
      const sessionId = Object.values(record).map((nested) => uuidText(nested)).find(Boolean);
      if (sessionId) {
        return sessionId;
      }
    }
    stack.push(...Object.values(record).filter((nested) => nested && typeof nested === "object"));
  }
  return undefined;
}

function uuidText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const match = value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
  return match?.[0];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

import path from "node:path";
import type {
  ChatAgentMode,
  ChatAgentPermissions,
  ChatProviderKind,
  ConversationKind,
  ParticipantConfig
} from "../../shared/types";
import { effectiveChatAgentPermissionsForProvider, normalizeChatAgentMode, normalizeChatAgentPermissions } from "../../shared/agentPermissions";

// Antigravity CLI (`agy`) discovers MCP servers from the global
// `~/.gemini/config/mcp_config.json` file only — there is no per-invocation MCP
// flag. The app therefore syncs one static `accord_agents` entry that launches
// the app's dedicated stdio-proxy launch mode, and passes the per-run bridge
// URL/token through the agy process environment. agy spawns MCP stdio servers
// with the parent environment inherited (verified empirically), so concurrent
// runs keep distinct tokens without racing on the shared config file.
export const GEMINI_MCP_URL_ENV = "ACCORD_AGENTS_MCP_URL";
export const GEMINI_MCP_TOKEN_ENV = "ACCORD_AGENTS_MCP_TOKEN";

export interface GeminiExecAppMcpOptions {
  url: string;
  token: string;
}

export interface GeminiExecOptions {
  sessionId?: string;
  extraReadableDirs?: string[];
  appMcp?: GeminiExecAppMcpOptions;
  agentMode?: ChatAgentMode;
  permissions?: ChatAgentPermissions;
  // Extra environment for the agy process. App-managed per-run vars (the
  // App-MCP url/token) always take precedence over entries here.
  extraEnv?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface GeminiExecInvocation {
  args: string[];
  env?: NodeJS.ProcessEnv;
}

export interface BuildGeminiExecInvocationRequest {
  participant: ParticipantConfig;
  prompt: string;
  repoPath?: string;
  kind: ConversationKind;
  logFilePath?: string;
  options?: GeminiExecOptions;
}

export interface GeminiExecUsage {
  inputTokens?: number;
  outputTokens?: number;
  thinkingTokens?: number;
  totalTokens?: number;
}

export interface GeminiExecResult {
  conversationId?: string;
  status?: string;
  response?: string;
  error?: string;
  usage?: GeminiExecUsage;
}

export function buildGeminiExecInvocation(request: BuildGeminiExecInvocationRequest): GeminiExecInvocation {
  const options = request.options ?? {};
  const mode = agentModeForRun(request.kind, options);
  const permissions = permissionsForRun("gemini-cli", mode, options);
  const args: string[] = [];

  if (options.sessionId) {
    args.push("--conversation", options.sessionId);
  }
  args.push("--print", geminiPrompt(request.prompt, request.repoPath, request.kind, mode, permissions));
  args.push("--output-format", "json");
  if (options.timeoutMs && options.timeoutMs > 0) {
    // Keep agy's own print-mode deadline behind the app-side runCommand timeout
    // so cancellation and timeout handling stay owned by the app.
    args.push("--print-timeout", `${Math.ceil(options.timeoutMs / 1000) + 60}s`);
  }
  if (request.logFilePath) {
    args.push("--log-file", request.logFilePath);
  }
  if (request.participant.model && !options.sessionId) {
    args.push("--model", request.participant.model);
  }
  if (request.repoPath) {
    args.push("--add-dir", request.repoPath);
  }
  for (const dir of normalizedExtraReadableDirs(options.extraReadableDirs)) {
    args.push("--add-dir", dir);
  }
  if (mode === "auto" || permissions.workspaceWrite) {
    // Print mode cannot answer interactive tool confirmations, so granted-write
    // and Auto-review runs must skip the confirmation prompts entirely.
    args.push("--dangerously-skip-permissions");
  } else {
    // Best effort: agy has no OS-enforced read-only sandbox. `--sandbox` only
    // restricts terminal commands; the prompt preamble carries the read-only
    // contract for file tools.
    args.push("--sandbox");
  }

  return {
    args,
    env: geminiInvocationEnv(options)
  };
}

export function geminiAppMcpEnv(options: GeminiExecOptions = {}): NodeJS.ProcessEnv | undefined {
  if (!options.appMcp) {
    return undefined;
  }
  return {
    [GEMINI_MCP_URL_ENV]: options.appMcp.url,
    [GEMINI_MCP_TOKEN_ENV]: options.appMcp.token
  };
}

function geminiInvocationEnv(options: GeminiExecOptions): NodeJS.ProcessEnv | undefined {
  const appMcpEnv = geminiAppMcpEnv(options);
  if (!options.extraEnv && !appMcpEnv) {
    return undefined;
  }
  return { ...options.extraEnv, ...appMcpEnv };
}

export function parseGeminiExecResult(stdout: string): GeminiExecResult | undefined {
  const lines = stdout.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line || !line.startsWith("{")) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object") {
        continue;
      }
      if (!("conversation_id" in parsed) && !("response" in parsed) && !("status" in parsed)) {
        continue;
      }
      return {
        conversationId: stringField(parsed, "conversation_id"),
        status: stringField(parsed, "status"),
        response: stringField(parsed, "response"),
        error: stringField(parsed, "error"),
        usage: parseGeminiUsage(parsed.usage)
      };
    } catch {
      // Keep scanning: narration or log noise may precede the result object.
    }
  }
  return undefined;
}

export function isGeminiResumeMissText(text: string): boolean {
  return /(?:conversation|trajectory)\s+[\w-]*\s*(?:not found|does not exist)|no such conversation|unknown conversation/i.test(text);
}

// --- Live-run tailing -------------------------------------------------------
//
// agy print mode writes nothing useful to stdout until the final result JSON,
// but two on-disk artifacts update while the run progresses:
//   1. the glog file passed via `--log-file`, which names the conversation id
//      within the first seconds ("Print mode: conversation=<uuid>, sending
//      message" / "Print mode: resuming conversation <uuid>"), and
//   2. `~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/
//      logs/transcript.jsonl`, a step-indexed JSONL of executed tool steps
//      (RUN_COMMAND, VIEW_FILE, SEARCH_WEB, ...).
// The runner tails both: the log for an early session id (so Stop/crash does
// not lose the conversation), the transcript for coarse live activity events.

const GEMINI_UUID_PATTERN = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const GEMINI_LOG_CONVERSATION_PATTERNS: RegExp[] = [
  new RegExp(`Print mode: conversation=(${GEMINI_UUID_PATTERN})`),
  new RegExp(`Print mode: resuming conversation (${GEMINI_UUID_PATTERN})`),
  new RegExp(`Stream goroutine exited for (${GEMINI_UUID_PATTERN})`)
];

export function extractGeminiLogConversationId(logText: string): string | undefined {
  for (const pattern of GEMINI_LOG_CONVERSATION_PATTERNS) {
    const match = logText.match(pattern);
    if (match?.[1]) {
      return match[1].toLowerCase();
    }
  }
  return undefined;
}

export function geminiTranscriptPathForConversation(homeDir: string, conversationId: string): string {
  return path.join(homeDir, ".gemini", "antigravity-cli", "brain", conversationId, ".system_generated", "logs", "transcript.jsonl");
}

export type GeminiActivityKind = "command" | "tool" | "web" | "file-edit";

export interface GeminiTranscriptActivity {
  label: string;
  kind: GeminiActivityKind;
}

// Executed-step types observed in real transcripts. PLANNER_RESPONSE lines are
// intentionally ignored: they narrate intent (and repeat the tool call the
// executed step will log again), so emitting them would duplicate activity.
const GEMINI_TRANSCRIPT_TYPE_ACTIVITY: Record<string, GeminiTranscriptActivity> = {
  RUN_COMMAND: { label: "Running command", kind: "command" },
  VIEW_FILE: { label: "Reading file", kind: "tool" },
  VIEW_FILE_OUTLINE: { label: "Reading file outline", kind: "tool" },
  VIEW_CODE_ITEM: { label: "Reading code", kind: "tool" },
  LIST_DIR: { label: "Listing files", kind: "tool" },
  FIND_BY_NAME: { label: "Scanning files", kind: "tool" },
  GREP_SEARCH: { label: "Searching files", kind: "tool" },
  CODEBASE_SEARCH: { label: "Searching code", kind: "tool" },
  SEARCH_WEB: { label: "Using web search", kind: "web" },
  READ_URL_CONTENT: { label: "Fetching URL", kind: "web" },
  WRITE_TO_FILE: { label: "Updating files", kind: "file-edit" },
  REPLACE_FILE_CONTENT: { label: "Updating files", kind: "file-edit" },
  MULTI_REPLACE_FILE_CONTENT: { label: "Updating files", kind: "file-edit" },
  ERROR_MESSAGE: { label: "Handling a tool error", kind: "tool" },
  MCP_TOOL: { label: "Using app tool", kind: "tool" },
  GENERIC: { label: "Using tool", kind: "tool" }
};

export function parseGeminiTranscriptActivity(line: string): GeminiTranscriptActivity | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const type = (parsed as Record<string, unknown>).type;
  if (typeof type !== "string") {
    return undefined;
  }
  return GEMINI_TRANSCRIPT_TYPE_ACTIVITY[type];
}

function parseGeminiUsage(value: unknown): GeminiExecUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return {
    inputTokens: numberField(record, "input_tokens"),
    outputTokens: numberField(record, "output_tokens"),
    thinkingTokens: numberField(record, "thinking_tokens"),
    totalTokens: numberField(record, "total_tokens")
  };
}

function geminiPrompt(
  prompt: string,
  repoPath: string | undefined,
  kind: ConversationKind,
  mode: ChatAgentMode,
  permissions: ChatAgentPermissions
): string {
  if (kind !== "chat") {
    return [
      repoPath
        ? "You are running inside the selected repository in read-only mode. Inspect files as needed. Do not edit files."
        : "Answer the user's question directly. Do not inspect local files unless context is explicitly provided.",
      prompt
    ].join("\n\n");
  }
  const lines = [`You are running for AccordAgents Chat in ${mode} mode.`];
  if (repoPath) {
    lines.push(`The selected repository workspace is ${repoPath}.`);
  }
  if (repoPath && (mode === "auto" || permissions.workspaceWrite)) {
    lines.push(
      `File modifications are limited to the selected repository workspace (${repoPath}). Do not create, modify, move, or delete files outside that workspace.`
    );
  }
  if (mode !== "auto" && !permissions.workspaceWrite) {
    lines.push(
      "This run is read-only: do not create, modify, or delete files, and do not run mutating terminal commands. Use file and terminal access only to gather context."
    );
  }
  lines.push(prompt);
  return lines.join("\n\n");
}

function agentModeForRun(kind: ConversationKind, options: GeminiExecOptions): ChatAgentMode {
  return kind === "chat" ? normalizeChatAgentMode(options.agentMode) : "plan";
}

function permissionsForRun(
  providerKind: ChatProviderKind | undefined,
  mode: ChatAgentMode,
  options: GeminiExecOptions
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

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

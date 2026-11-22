import path from "node:path";
import type {
  ChatAgentMode,
  ChatAgentPermissions,
  ChatProviderKind,
  ConversationKind,
  ParticipantConfig
} from "../../shared/types";
import { chatAgentModeForKind, effectiveChatAgentPermissionsForProvider, normalizeChatAgentMode, normalizeChatAgentPermissions } from "../../shared/agentPermissions";
import { geminiModelId } from "../../shared/geminiModels";

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
  /** The app tools this run exposes; agy is told to allow each. */
  toolNames?: string[];
}

/** The MCP server name the app's tools are under in agy's config. */
export const GEMINI_APP_MCP_SERVER = "accord_agents";

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
  /** The User's own agy settings, so the session settings that allow the
   *  app's tools never drop her rules (geminiUserSettings). */
  userSettings?: GeminiUserSettings;
  /** Where the run's session settings file goes (in the run's own folder);
   *  without one they travel inline. */
  settingsPath?: string;
}

/** What the app could read of agy's settings.json: its `permissions`, or that
 *  it could not be read, in which case the app adds no session settings. */
export type GeminiUserSettings = { readable: true; permissions?: Record<string, unknown> } | { readable: false };

export interface GeminiExecInvocation {
  args: string[];
  env?: NodeJS.ProcessEnv;
  /** Session settings to write to options.settingsPath before the run. */
  settings?: Record<string, unknown>;
}

export interface GeminiInteractiveGoalInvocation extends GeminiExecInvocation {
  goalPrompt: string;
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
  args.push("--print", geminiPrompt(request.prompt, request.repoPath, request.kind));
  args.push("--output-format", "json");
  if (options.timeoutMs && options.timeoutMs > 0) {
    // Keep agy's own print-mode deadline behind the app-side runCommand timeout
    // so cancellation and timeout handling stay owned by the app.
    args.push("--print-timeout", `${Math.ceil(options.timeoutMs / 1000) + 60}s`);
  }
  if (request.logFilePath) {
    args.push("--log-file", request.logFilePath);
  }
  const model = geminiModelId(request.participant.model);
  if (model && !options.sessionId) {
    args.push("--model", model);
  }
  if (request.repoPath) {
    args.push("--add-dir", request.repoPath);
  }
  for (const dir of normalizedExtraReadableDirs(options.extraReadableDirs)) {
    args.push("--add-dir", dir);
  }
  const permissionArgs = geminiPermissionArgs(request.kind, mode, permissions, request.participant, options);
  args.push(...permissionArgs.args);

  return {
    args,
    env: geminiInvocationEnv(options),
    ...(permissionArgs.settings ? { settings: permissionArgs.settings } : {})
  };
}

export function buildGeminiInteractiveGoalInvocation(
  request: BuildGeminiExecInvocationRequest
): GeminiInteractiveGoalInvocation {
  const options = request.options ?? {};
  const mode = agentModeForRun(request.kind, options);
  const permissions = permissionsForRun("gemini-cli", mode, options);
  const args: string[] = [];
  if (options.sessionId) {
    args.push("--conversation", options.sessionId);
  }
  if (request.logFilePath) {
    args.push("--log-file", request.logFilePath);
  }
  const model = geminiModelId(request.participant.model);
  if (model && !options.sessionId) {
    args.push("--model", model);
  }
  if (request.repoPath) {
    args.push("--add-dir", request.repoPath);
  }
  for (const dir of normalizedExtraReadableDirs(options.extraReadableDirs)) {
    args.push("--add-dir", dir);
  }
  const permissionArgs = geminiPermissionArgs(request.kind, mode, permissions, request.participant, options);
  args.push(...permissionArgs.args);
  return {
    args,
    env: geminiInvocationEnv(options),
    ...(permissionArgs.settings ? { settings: permissionArgs.settings } : {}),
    goalPrompt: `/goal ${geminiPrompt(request.prompt, request.repoPath, request.kind)}`
  };
}

/**
 * How agy is allowed to act. In the sessions view's access (`cliApprovals`)
 * agy runs in its own mode (`--mode`, its Default being `agentMode: ""`,
 * which `--mode` does not take), without skipping its confirmations: what
 * the mode would ask about, print mode refuses, as `agy -p` does in a
 * terminal (agy 1.5.14, 2026-11-21). The classic controls keep the app's
 * own mapping: granted writes and Auto-review skip every confirmation, else
 * terminal restrictions and a read-only instruction.
 */
function geminiPermissionArgs(
  kind: ConversationKind,
  mode: ChatAgentMode,
  permissions: ChatAgentPermissions,
  participant: Pick<ParticipantConfig, "geminiSettings">,
  options: GeminiExecOptions
): { args: string[]; settings?: Record<string, unknown> } {
  const args: string[] = [];
  let modeSettings: Record<string, unknown> | undefined;
  const ownMode = kind === "chat" && permissions.cliApprovals === true;
  if (ownMode) {
    const agyMode = geminiAgentMode(mode, permissions);
    if (agyMode) {
      args.push("--mode", agyMode);
    } else {
      modeSettings = { agentMode: "" };
    }
  } else if (mode === "auto" || permissions.workspaceWrite) {
    // Print mode cannot answer interactive tool confirmations, so granted-write
    // and Auto-review runs must skip the confirmation prompts entirely.
    args.push("--dangerously-skip-permissions");
  } else {
    // Best effort: agy has no OS-enforced read-only sandbox. `--sandbox` only
    // restricts terminal commands; the prompt preamble carries the read-only
    // contract for file tools.
    args.push("--sandbox");
  }
  const skipsConfirmations = !ownMode && (mode === "auto" || permissions.workspaceWrite);
  const appTools = skipsConfirmations ? undefined : geminiAppToolSettings(options);
  const sessionSettings = geminiSessionSettings(participant, appTools);
  const settings = sessionSettings || modeSettings ? { ...(sessionSettings ?? {}), ...(modeSettings ?? {}) } : undefined;
  if (settings) {
    args.push("--settings", options.settingsPath ?? JSON.stringify(settings));
  }
  return { args, ...(settings ? { settings } : {}) };
}

/** agy's `--mode` for a member's mode and file-edit right; none for its
 *  Default. */
export function geminiAgentMode(mode: ChatAgentMode, permissions: Pick<ChatAgentPermissions, "workspaceWrite">): "accept-edits" | "auto" | "plan" | undefined {
  if (mode === "auto") return "auto";
  if (mode === "plan") return "plan";
  return permissions.workspaceWrite ? "accept-edits" : undefined;
}

/** agy takes one --settings: the member's own (its Gemini API key route)
 *  under the app-tool rules, which never set the same keys. */
function geminiSessionSettings(
  participant: Pick<ParticipantConfig, "geminiSettings">,
  appToolSettings: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  const own = participant.geminiSettings && Object.keys(participant.geminiSettings).length > 0 ? participant.geminiSettings : undefined;
  return own || appToolSettings ? { ...(own ?? {}), ...(appToolSettings ?? {}) } : undefined;
}

/**
 * agy without --dangerously-skip-permissions cannot ask before a tool runs
 * when the app runs it: a tool no rule allows is denied, and a turn that only
 * wanted an app tool (naming the chat, say) ends with no answer (agy 1.5.x,
 * 2026-11-07). The app's own tools are allowed as Claude Code's --allowedTools
 * allows them; each asks the User itself where it must. The User's own
 * permission rules go along with them, so a session setting that replaces
 * hers instead of adding to them drops nothing; when her settings cannot be
 * read, nothing is added and agy keeps to her file alone.
 */
export function geminiAppToolSettings(options: GeminiExecOptions): Record<string, unknown> | undefined {
  const toolNames = (options.appMcp?.toolNames ?? []).filter((name) => /^[A-Za-z0-9_-]+$/.test(name));
  const user = options.userSettings ?? { readable: true };
  if (!options.appMcp || toolNames.length === 0 || !user.readable) {
    return undefined;
  }
  const own = user.permissions ?? {};
  const ownAllow = Array.isArray(own.allow) ? own.allow.filter((rule): rule is string => typeof rule === "string") : [];
  if (own.allow !== undefined && (!Array.isArray(own.allow) || ownAllow.length !== own.allow.length)) {
    // Rules the app would have to rewrite to add its own: leave them to agy.
    return undefined;
  }
  const allow = Array.from(new Set([...ownAllow, ...toolNames.map((name) => `mcp(${GEMINI_APP_MCP_SERVER}/${name})`)]));
  return { permissions: { ...own, allow } };
}

/** Reads agy's settings.json text: a missing file is no rules; a file that is
 *  not plain JSON (comments, say) is one the app does not try to understand. */
export function geminiUserSettings(settingsText: string | undefined): GeminiUserSettings {
  if (settingsText === undefined) {
    return { readable: true };
  }
  try {
    const parsed = JSON.parse(settingsText.replace(/^\uFEFF/, "")) as { permissions?: unknown } | null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { readable: false };
    }
    const permissions = parsed.permissions;
    if (permissions === undefined) {
      return { readable: true };
    }
    return permissions && typeof permissions === "object" && !Array.isArray(permissions)
      ? { readable: true, permissions: permissions as Record<string, unknown> }
      : { readable: false };
  } catch {
    return { readable: false };
  }
}

/** agy's user settings, where its own permission rules live. */
export function geminiUserSettingsPath(homeDir: string): string {
  return path.join(homeDir, ".gemini", "antigravity-cli", "settings.json");
}

/** What agy says when headless mode denied a tool it could not ask about: its
 *  own words, without the flag advice the User cannot follow from the app, so
 *  she reads why instead of an empty reply. */
export function geminiHeadlessDenial(stderr: string): string | undefined {
  const line = stderr.split(/\r?\n/).map((text) => text.trim()).find((text) => /headless mode cannot prompt/i.test(text));
  if (!line) {
    return undefined;
  }
  return line
    .replace(/^jetski:\s*/i, "")
    .replace(/^no output produced\s*[—-]\s*/i, "")
    .split(/(?<=\.)\s+(?=[A-Z])/)
    .filter((sentence) => !/--dangerously-skip-permissions/.test(sentence))
    .join(" ")
    .replace(/^./, (first) => first.toUpperCase());
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
  new RegExp(`Created conversation (${GEMINI_UUID_PATTERN})`),
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
  kind: ConversationKind
): string {
  if (kind !== "chat") {
    return [
      repoPath
        ? "You are running inside the selected repository in read-only mode. Inspect files as needed. Do not edit files."
        : "Answer the user's question directly. Do not inspect local files unless context is explicitly provided.",
      prompt
    ].join("\n\n");
  }
  // A chat turn is the member's message as it is: its mode, workspace and
  // what print mode cannot ask are in its session's instructions, said once
  // (ChatService.antigravityAccessLines).
  return prompt;
}

function agentModeForRun(kind: ConversationKind, options: GeminiExecOptions): ChatAgentMode {
  // Codex's Full Access is not an agy mode: Auto, the broadest agy offers.
  return kind === "chat" ? chatAgentModeForKind("gemini-cli", options.agentMode) : "plan";
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

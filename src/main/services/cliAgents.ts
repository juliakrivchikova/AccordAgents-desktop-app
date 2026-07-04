import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Dirent } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type {
  AgentContextUsage,
  AgentContextUsageSource,
  AgentHealth,
  ChatAgentActivityEvent,
  ChatAgentActivityKind,
  ChatAgentMode,
  ChatAgentPermissions,
  ChatProviderKind,
  ChatReasoningEffort,
  ChatShellPermissionRule,
  ConversationKind,
  GitDiffMode,
  ParticipantConfig,
  ProviderModel,
  ProviderReasoningEffortOption,
  ProviderModelCatalog
} from "../../shared/types";
import { effectiveChatAgentPermissionsForProvider, normalizeChatAgentMode, normalizeChatAgentPermissions } from "../../shared/agentPermissions";
import { buildAgentContextUsage, contextWindowForModel } from "../../shared/agentContext";
import { filterAllowedAgentEnvironment } from "../../shared/agentEnvironment";
import { CLI_AGENT_RUN_TIMEOUT_DEFAULT_MS, normalizeCliAgentRunTimeoutMs } from "../../shared/cliAgentRunSettings";
import { chatTextEndsAtSentenceOrParagraphBoundary } from "../../shared/processingTranscript";
import { chatReasoningEffortLabel, normalizeChatReasoningEffort } from "../../shared/reasoningEffort";
import { cliFailureNoticeText } from "../../shared/warnings";
import { CommandError, commandEnvironment, commandExists, ensureLoginShellEnvPrimed, runCommand, type CommandEnvironmentOptions } from "./command";
import {
  buildCodexExecInvocation,
  createCodexLineHandler,
  emitCodexLiveOutput as emitCodexExecLiveOutput,
  extractCodexSessionId as extractCodexExecSessionId,
  extractCodexText as extractCodexExecText
} from "./codexExec";
import type { ParticipantRunResult } from "./providers";

const MAX_CLI_ERROR_CHARS = 500;
const MAX_CLI_ERROR_LINES = 8;
const MAX_CLI_EVENT_SUMMARIES = 2;
const CLI_AGENT_COMPACT_TIMEOUT_MS = 5 * 60_000;
const WARM_AGENT_KILL_GRACE_MS = 1500;
const SESSION_LOG_RETRY_MS = 80;
const SESSION_LOG_RETRIES = 4;
const MODEL_CATALOG_CACHE_MS = 5 * 60_000;
const MODEL_CATALOG_TIMEOUT_MS = 12_000;
const CLAUDE_MODEL_PROBE_TIMEOUT_MS = 8_000;
const CODEX_APP_SERVER_DISABLED_ENV = "ACCORD_AGENTS_CODEX_APP_SERVER";
const CODEX_APP_SERVER_MCP_TOKEN_ENV = "ACCORD_AGENTS_MCP_TOKEN";
const CLAUDE_CODE_LOGIN_SHELL_AUTH_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_BASE_URL"
];
const CLAUDE_CODE_COMMAND_ENV_OPTIONS: CommandEnvironmentOptions = {
  dropProcessEnvKeysAbsentFromLoginShell: CLAUDE_CODE_LOGIN_SHELL_AUTH_ENV_KEYS
};
const CODEX_AUTO_APPROVALS_REVIEWER = "guardian_subagent";
const APP_PERMISSIONS_REQUEST_CHANGE_TOOL = "app_permissions_request_change";
const APP_TOOL_PERMISSION_TOOL = "app_tool_permission";
const APP_TOOL_PERMISSION_MCP_TOOL = `mcp__accord_agents__${APP_TOOL_PERMISSION_TOOL}`;

export interface CliAgentRunOptions {
  persistSession?: boolean;
  sessionId?: string;
  compactInstructions?: string;
  clearCompactPrompt?: boolean;
  extraReadableDirs?: string[];
  resumeFallbackPrompt?: string;
  role?: CliAgentRoleOptions;
  appMcp?: CliAgentAppMcpOptions;
  agentEnv?: NodeJS.ProcessEnv;
  agentEnvKey?: string;
  warm?: CliAgentWarmOptions;
  onOutput?: CliAgentOutputCallback;
  onSessionId?: CliAgentSessionIdCallback;
  agentMode?: ChatAgentMode;
  permissions?: ChatAgentPermissions;
  // Validated user-visible skills selected for this run, resolved to their real directories
  // server-side. Codex uses this for scoped read-only skill-file reads; Claude's native
  // Skill tool is available for every Claude session.
  selectedSkills?: CliAgentSelectedSkill[];
  timeoutMs?: number;
}

export interface CliAgentSelectedSkill {
  name: string;
  dir: string;
}

export type CliAgentOutputKind = "tool" | "text";

export interface CliAgentOutputEvent {
  kind: CliAgentOutputKind;
  text: string;
  cumulative?: string;
  activityKind?: ChatAgentActivityKind;
  activityStatus?: ChatAgentActivityEvent["status"];
  activityDetail?: string;
}

export type CliAgentOutputCallback = (event: CliAgentOutputEvent) => void;

export type CliAgentSessionIdCallback = (sessionId: string) => void;

export interface CliAgentWarmOptions {
  conversationId: string;
  participantId: string;
  contextKey: string;
  idleTimeoutMs: number;
}

export interface CliAgentRoleOptions {
  name: string;
  description: string;
  instructions: string;
  promptFallbackPrompt: string;
}

export interface CliAgentAppMcpOptions {
  url: string;
  token: string;
  toolNames: string[];
  clientGenerationId?: string;
  clientStatus?: (clientGenerationId: string) => CliAgentAppMcpClientStatus | undefined;
}

export interface CliAgentAppMcpClientStatus {
  initialized: boolean;
  listedTools: boolean;
  requiredToolsPresent: boolean;
  missingToolNames: string[];
  errored: boolean;
  errorMessage?: string;
}

export interface CliAgentCompactResult {
  participant: ParticipantConfig;
  ok: boolean;
  sessionId?: string;
  contextUsage?: AgentContextUsage;
  providerNative?: boolean;
  content?: string;
  error?: string;
}

interface CliAgentDebugLogger {
  write(event: string, payload: Record<string, unknown>): Promise<void>;
}

interface WarmAgentEntry {
  key: string;
  scopeKey: string;
  providerKind: ParticipantConfig["kind"];
  process: ChildProcessWithoutNullStreams;
  run: (prompt: string, signal?: AbortSignal, onOutput?: CliAgentOutputCallback, onSessionId?: CliAgentSessionIdCallback, timeoutMs?: number) => Promise<ParticipantRunResult>;
  compact?: (instructions?: string, signal?: AbortSignal, onSessionId?: CliAgentSessionIdCallback) => Promise<CliAgentCompactResult>;
  queue: Promise<void>;
  idleTimer?: NodeJS.Timeout;
  closed: boolean;
}

interface ClaudeWarmPendingTurn {
  startedAt: number;
  messages: string[];
  streamedText: string;
  nextTextBlockStartsBlock: boolean;
  sessionId?: string;
  model?: string;
  usedTokens?: number;
  contextWindowTokens?: number;
  timer: NodeJS.Timeout;
  abort?: () => void;
  onOutput?: CliAgentOutputCallback;
  onSessionId?: CliAgentSessionIdCallback;
  resolve: (result: ParticipantRunResult) => void;
  reject: (error: Error) => void;
}

interface CodexAppServerPendingRequest {
  method: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

interface CachedModelCatalog {
  catalog: ProviderModelCatalog;
  expiresAt: number;
}

interface CodexAppServerPendingTurn {
  startedAt: number;
  threadId: string;
  turnId?: string;
  messages: string[];
  streamedText: string;
  completedAgentMessages: string[];
  finalMessage?: string;
  nextAgentMessageStartsBlock: boolean;
  model?: string;
  contextUsage?: AgentContextUsage;
  timer: NodeJS.Timeout;
  abort?: () => void;
  onOutput?: CliAgentOutputCallback;
  resolve: (result: ParticipantRunResult) => void;
  reject: (error: Error) => void;
}

interface CodexAppServerPendingCompact {
  threadId: string;
  startedAt: number;
  contextUsage?: AgentContextUsage;
  // codex app-server (>= 0.139) runs compaction as a normal turn that emits
  // turn/started + turn/completed instead of a dedicated thread/compacted event.
  // We capture that turn id so we resolve on the right turn/completed.
  compactTurnId?: string;
  sawCompactTurn?: boolean;
  timer: NodeJS.Timeout;
  abort?: () => void;
  onSessionId?: CliAgentSessionIdCallback;
  resolve: (result: CliAgentCompactResult) => void;
  reject: (error: Error) => void;
}

interface CodexAppServerThreadStartResult {
  thread?: {
    id?: string;
    sessionId?: string;
  };
  model?: string;
}

interface CodexAppServerTurnStartResult {
  turn?: {
    id?: string;
  };
}

type ClaudePermissionMode = "default" | "plan" | "acceptEdits" | "auto";

interface ClaudeToolConfig {
  permissionMode: ClaudePermissionMode;
  tools: string[];
  allowedTools: string[];
  disallowedTools: string[];
  askTools: string[];
}

function stripAnsi(value: string): string {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[\d+(?:;\d+)?G/g, " ")
    .replace(/\u001b\[\d+C/g, " ")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[0-9=>]/g, "")
    .replace(/\u001b[@-Z\\-_]/g, "");
}

export function parseClaudeModelPickerOutput(output: string): ProviderModel[] {
  const text = stripAnsi(output)
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n+/g, "\n");
  const start = text.indexOf("Select model");
  const end = start >= 0 ? text.indexOf("Enter to set", start) : -1;
  const body = start >= 0 ? text.slice(start, end > start ? end : undefined) : text;
  const models: ProviderModel[] = [];
  let defaultAlias: string | undefined;
  const itemPattern = /(?:^|\n|\s)(?:[›>]\s*)?(\d+)\.\s+([A-Za-z][A-Za-z0-9_-]*)\s+([\s\S]*?)(?=(?:\n|\s)(?:[›>]\s*)?\d+\.\s+[A-Za-z]|(?:\n|\s)●\s+|Enter to set|$)/g;

  for (const match of body.matchAll(itemPattern)) {
    const alias = match[2]?.trim();
    const details = match[3]?.replace(/\s+/g, " ").trim() ?? "";
    if (!alias) {
      continue;
    }
    const id = alias.toLowerCase();
    if (id === "default") {
      const defaultMatch = details.match(/(?:✔\s*)?([A-Za-z][A-Za-z0-9_-]*)\s+\d/);
      defaultAlias = defaultMatch?.[1]?.toLowerCase();
      continue;
    }
    const titleDetail = details.match(/^\(([^)]+)\)\s+(.*)$/);
    const displayName = titleDetail ? `${alias} (${titleDetail[1]})` : alias;
    const description = titleDetail ? titleDetail[2].trim() : details;
    const modelId = claudeModelIdFromPickerItem(id, displayName, description);
    models.push({
      id: modelId,
      label: description ? `${displayName} (${description})` : displayName,
      description: description || undefined,
      source: "cli",
      recommended: defaultAlias === id || defaultAlias === modelId
    });
  }

  return dedupeProviderModels(models);
}

function claudeModelIdFromPickerItem(alias: string, displayName: string, description: string): string {
  const oneMillionContext = /\b1M\s+context\b|\(1M\s+context\)/i.test(`${displayName} ${description}`);
  if (alias === "sonnet" && oneMillionContext) {
    const version = description.match(/\bSonnet\s+(\d+(?:\.\d+)?)/i)?.[1];
    if (version) {
      return `claude-sonnet-${version.replace(/\./g, "-")}[1m]`;
    }
  }
  return alias;
}

function dedupeProviderModels(models: ProviderModel[]): ProviderModel[] {
  const seen = new Set<string>();
  const deduped: ProviderModel[] = [];
  for (const model of models) {
    const id = model.id.trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    deduped.push({ ...model, id });
  }
  return deduped;
}

export class CliAgentRunner {
  private readonly warmAgents = new Map<string, WarmAgentEntry>();
  private readonly warmUnsupportedLogged = new Set<ParticipantConfig["kind"]>();
  private readonly modelCatalogs = new Map<ChatProviderKind, CachedModelCatalog>();
  private readonly modelCatalogRequests = new Map<ChatProviderKind, Promise<ProviderModelCatalog>>();
  private runTimeoutMs = CLI_AGENT_RUN_TIMEOUT_DEFAULT_MS;

  constructor(private readonly debugLogs?: CliAgentDebugLogger) {}

  setRunTimeoutMs(timeoutMs: number): void {
    this.runTimeoutMs = normalizeCliAgentRunTimeoutMs(timeoutMs);
  }

  async detectAgents(): Promise<AgentHealth[]> {
    const [codex, claude] = await Promise.all([this.detectCodex(), this.detectClaude()]);
    return [codex, claude];
  }

  async listModelCatalog(kind: ChatProviderKind, configuredModel?: string): Promise<ProviderModelCatalog> {
    const cached = this.modelCatalogs.get(kind);
    if (cached && cached.expiresAt > Date.now()) {
      return this.withConfiguredModel(cached.catalog, configuredModel);
    }

    const fetchedAt = new Date().toISOString();
    const currentRequest = this.modelCatalogRequests.get(kind);
    const request = currentRequest ?? (async (): Promise<ProviderModelCatalog> => {
      const catalog = kind === "codex-cli"
        ? await this.listCodexModelCatalog(fetchedAt)
        : await this.listClaudeModelCatalog(fetchedAt);
      const normalized = {
        ...catalog,
        models: this.dedupeModels(catalog.models)
      };
      this.modelCatalogs.set(kind, {
        catalog: normalized,
        expiresAt: Date.now() + MODEL_CATALOG_CACHE_MS
      });
      return normalized;
    })();
    if (!currentRequest) {
      this.modelCatalogRequests.set(kind, request);
    }

    try {
      const normalized = await request;
      return this.withConfiguredModel(normalized, configuredModel);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.debugLogs?.write("cli.model-catalog.error", { kind, message });
      return this.withConfiguredModel({
        kind,
        models: this.fallbackModelsForKind(kind),
        authoritative: false,
        fetchedAt,
        error: message
      }, configuredModel);
    } finally {
      if (this.modelCatalogRequests.get(kind) === request) {
        this.modelCatalogRequests.delete(kind);
      }
    }
  }

  async run(
    participant: ParticipantConfig,
    prompt: string,
    repoPath: string | undefined,
    diffMode: GitDiffMode | undefined,
    kind: ConversationKind,
    signal?: AbortSignal,
    options: CliAgentRunOptions = {}
  ): Promise<ParticipantRunResult> {
    const effectiveRepoPath = this.repoPathForRun(repoPath, diffMode, kind);
    if (participant.kind === "codex-cli") {
      return this.runCodex(participant, prompt, effectiveRepoPath, diffMode, kind, signal, options);
    }
    if (participant.kind === "claude-code") {
      return this.runClaude(participant, prompt, effectiveRepoPath, kind, signal, options);
    }
    return { participant, ok: false, content: "", error: `${participant.label} is not a CLI agent.` };
  }

  async compactSession(
    participant: ParticipantConfig,
    repoPath: string | undefined,
    diffMode: GitDiffMode | undefined,
    kind: ConversationKind,
    signal?: AbortSignal,
    options: CliAgentRunOptions = {}
  ): Promise<CliAgentCompactResult> {
    if (!options.sessionId) {
      return { participant, ok: false, error: `${participant.label} does not have an active CLI session to compact.` };
    }
    const effectiveRepoPath = this.repoPathForRun(repoPath, diffMode, kind);
    if (participant.kind === "codex-cli") {
      return this.compactCodexSession(participant, effectiveRepoPath, diffMode, kind, signal, options);
    }
    if (participant.kind === "claude-code") {
      return this.compactClaudeSession(participant, effectiveRepoPath, kind, signal, options);
    }
    return { participant, ok: false, error: `${participant.label} is not a CLI agent.` };
  }

  async shutdownWarmAgents(): Promise<void> {
    const entries = Array.from(this.warmAgents.values());
    this.warmAgents.clear();
    await Promise.all(entries.map((entry) => this.closeWarmAgent(entry, "shutdown")));
  }

  async contextUsageForSession(
    participant: ParticipantConfig,
    sessionId: string | undefined
  ): Promise<AgentContextUsage | undefined> {
    if (!sessionId) {
      return undefined;
    }
    if (participant.kind === "codex-cli") {
      return this.extractCodexSessionLogContextUsageWithRetry(sessionId, participant);
    }
    if (participant.kind === "claude-code") {
      return this.extractClaudeSessionLogContextUsageWithRetry(sessionId, participant);
    }
    return undefined;
  }

  private async listCodexModelCatalog(fetchedAt: string): Promise<ProviderModelCatalog> {
    await ensureLoginShellEnvPrimed();
    const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
      env: commandEnvironment(),
      stdio: ["pipe", "pipe", "pipe"]
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    let nextRequestId = 1;
    let stdoutBuffer = "";
    let stderr = "";
    let closed = false;
    const pendingRequests = new Map<number, CodexAppServerPendingRequest>();

    const cleanup = (cause?: Error): void => {
      if (closed) {
        return;
      }
      closed = true;
      const error = cause ?? new Error(`codex app-server model probe ended before receiving a response${stderr.trim() ? `: ${this.errorText(stderr)}` : ""}`);
      for (const pending of pendingRequests.values()) {
        pending.reject(error);
      }
      pendingRequests.clear();
      if (!child.killed && child.exitCode === null) {
        child.kill("SIGTERM");
      }
    };

    const sendRequest = (method: string, params: unknown): Promise<unknown> => {
      if (closed || child.exitCode !== null || child.killed) {
        return Promise.reject(new Error("codex app-server process is not running"));
      }
      const id = nextRequestId;
      nextRequestId += 1;
      return new Promise<unknown>((resolve, reject) => {
        pendingRequests.set(id, { method, resolve, reject });
        child.stdin.write(`${JSON.stringify({ method, id, params })}\n`, (error) => {
          if (error) {
            pendingRequests.delete(id);
            reject(error);
          }
        });
      });
    };

    const handleResponse = (record: Record<string, unknown>): void => {
      const id = typeof record.id === "number" ? record.id : undefined;
      if (id === undefined) {
        return;
      }
      const pending = pendingRequests.get(id);
      if (!pending) {
        return;
      }
      pendingRequests.delete(id);
      const error = this.asRecord(record.error);
      if (error) {
        pending.reject(new Error(this.stringField(error, "message") ?? `${pending.method} failed`));
        return;
      }
      pending.resolve(record.result);
    };

    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      let lineBreak = stdoutBuffer.indexOf("\n");
      while (lineBreak >= 0) {
        const line = stdoutBuffer.slice(0, lineBreak).trim();
        stdoutBuffer = stdoutBuffer.slice(lineBreak + 1);
        if (line) {
          try {
            const event = JSON.parse(line) as unknown;
            const record = this.asRecord(event);
            if (record) {
              handleResponse(record);
            }
          } catch {
            // Ignore non-JSON status output.
          }
        }
        lineBreak = stdoutBuffer.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("exit", (code) => {
      cleanup(new Error(`codex app-server model probe exited with code ${code ?? "unknown"}${stderr.trim() ? `: ${this.errorText(stderr)}` : ""}`));
    });

    const timeout = setTimeout(() => {
      cleanup(new Error(`codex app-server model probe timed out${stderr.trim() ? `: ${this.errorText(stderr)}` : ""}`));
    }, MODEL_CATALOG_TIMEOUT_MS);
    try {
      await sendRequest("initialize", {
        clientInfo: {
          name: "accordagents",
          title: "AccordAgents",
          version: "0.1.0"
        },
        capabilities: {
          experimentalApi: true,
          optOutNotificationMethods: []
        }
      });
      const models: ProviderModel[] = [];
      let cursor: string | undefined;
      do {
        const result = this.asRecord(await sendRequest("model/list", { cursor: cursor ?? null, includeHidden: false, limit: 100 }));
        const data = Array.isArray(result?.data) ? result.data : [];
        for (const item of data) {
          const record = this.asRecord(item);
          const id = this.stringField(record ?? {}, "id") ?? this.stringField(record ?? {}, "model");
          if (!id) {
            continue;
          }
          const displayName = this.stringField(record ?? {}, "displayName") ?? id;
          const description = this.stringField(record ?? {}, "description");
          const supportedReasoningEfforts = this.codexModelReasoningEfforts(record);
          const defaultReasoningEffort = normalizeChatReasoningEffort(this.stringField(record ?? {}, "defaultReasoningEffort"), "codex-cli");
          models.push({
            id,
            label: displayName === id ? id : `${displayName} (${id})`,
            description,
            source: "cli",
            recommended: record?.isDefault === true,
            hidden: record?.hidden === true,
            supportedReasoningEfforts: supportedReasoningEfforts.length > 0 ? supportedReasoningEfforts : undefined,
            defaultReasoningEffort
          });
        }
        cursor = this.stringField(result ?? {}, "nextCursor");
      } while (cursor);

      if (models.length === 0) {
        throw new Error(`codex app-server returned no models${stderr.trim() ? `: ${this.errorText(stderr)}` : ""}`);
      }
      return {
        kind: "codex-cli",
        models,
        authoritative: true,
        fetchedAt
      };
    } finally {
      clearTimeout(timeout);
      cleanup();
    }
  }

  private async listClaudeModelCatalog(fetchedAt: string): Promise<ProviderModelCatalog> {
    const output = await this.runClaudeModelProbe();
    const models = parseClaudeModelPickerOutput(output);
    if (models.length === 0) {
      throw new Error("Claude model picker did not expose parseable model choices.");
    }
    return {
      kind: "claude-code",
      models,
      authoritative: true,
      fetchedAt
    };
  }

  private codexModelReasoningEfforts(record: Record<string, unknown> | undefined): ProviderReasoningEffortOption[] {
    const values = Array.isArray(record?.supportedReasoningEfforts) ? record.supportedReasoningEfforts : [];
    const defaultReasoningEffort = normalizeChatReasoningEffort(this.stringField(record ?? {}, "defaultReasoningEffort"), "codex-cli");
    const options: ProviderReasoningEffortOption[] = [];
    for (const value of values) {
      const option = this.asRecord(value);
      const effort = normalizeChatReasoningEffort(this.stringField(option ?? {}, "reasoningEffort"), "codex-cli");
      if (!effort || options.some((item) => item.id === effort)) {
        continue;
      }
      options.push({
        id: effort,
        label: chatReasoningEffortLabel(effort),
        description: this.stringField(option ?? {}, "description"),
        recommended: effort === defaultReasoningEffort
      });
    }
    return options;
  }

  private async runClaudeModelProbe(): Promise<string> {
    await ensureLoginShellEnvPrimed();
    return new Promise<string>((resolve, reject) => {
      const child = spawn("expect", ["-c", this.claudeModelProbeExpectScript()], {
        env: commandEnvironment(undefined, CLAUDE_CODE_COMMAND_ENV_OPTIONS),
        stdio: ["pipe", "pipe", "pipe"]
      });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");

      let output = "";
      let stderr = "";
      let finished = false;

      const finish = (error?: Error): void => {
        if (finished) {
          return;
        }
        finished = true;
        clearTimeout(timeout);
        if (!child.killed && child.exitCode === null) {
          child.kill("SIGTERM");
        }
        if (error) {
          reject(error);
          return;
        }
        resolve(output);
      };

      const timeout = setTimeout(() => {
        finish(new Error(`Claude model picker probe timed out${stderr.trim() ? `: ${this.errorText(stderr)}` : ""}`));
      }, CLAUDE_MODEL_PROBE_TIMEOUT_MS);
      timeout.unref();

      child.stdout.on("data", (chunk) => {
        output += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.once("error", (error) => finish(error));
      child.once("exit", (code) => {
        if (finished) {
          return;
        }
        if (code === 0) {
          finish();
          return;
        }
        if (code !== 0) {
          finish(new Error(`Claude model picker probe exited with code ${code ?? "unknown"}${stderr.trim() ? `: ${this.errorText(stderr)}` : ""}`));
        }
      });
    });
  }

  private claudeModelProbeExpectScript(): string {
    return [
      "set timeout 8",
      "log_user 1",
      "spawn claude --safe-mode --no-chrome",
      "expect {",
      "  -re \".\" {}",
      "  timeout { exit 124 }",
      "  eof { exit 1 }",
      "}",
      "after 500",
      "send \"/model\\r\"",
      "expect {",
      "  -re \"cancel\" {}",
      "  timeout { exit 124 }",
      "  eof { exit 1 }",
      "}",
      "send \"\\033\"",
      "after 250",
      "send \"/exit\\r\"",
      "expect {",
      "  eof {}",
      "  timeout { exit 0 }",
      "}",
      "exit 0"
    ].join("\n");
  }

  private fallbackModelsForKind(kind: ChatProviderKind): ProviderModel[] {
    if (kind !== "claude-code") {
      return [];
    }
    return [
      { id: "opus", label: "Opus", source: "builtin" },
      { id: "sonnet", label: "Sonnet", source: "builtin" },
      { id: "haiku", label: "Haiku", source: "builtin" }
    ];
  }

  private withConfiguredModel(catalog: ProviderModelCatalog, configuredModel?: string): ProviderModelCatalog {
    const id = configuredModel?.trim();
    if (!id || catalog.models.some((model) => model.id === id)) {
      return catalog;
    }
    return {
      ...catalog,
      models: [
        {
          id,
          label: id,
          source: "configured",
          recommended: true
        },
        ...catalog.models
      ]
    };
  }

  private dedupeModels(models: ProviderModel[]): ProviderModel[] {
    return dedupeProviderModels(models);
  }

  private async detectCodex(): Promise<AgentHealth> {
    const command = await commandExists("codex");
    if (!command.path) {
      return { kind: "codex-cli", label: "Codex CLI", installed: false, error: command.error };
    }
    try {
      const version = await runCommand("codex", ["--version"], { timeoutMs: 10_000 });
      return { kind: "codex-cli", label: "Codex CLI", installed: true, path: command.path, version: version.stdout.trim() };
    } catch (error) {
      return { kind: "codex-cli", label: "Codex CLI", installed: true, path: command.path, error: this.errorText(error) };
    }
  }

  private async detectClaude(): Promise<AgentHealth> {
    const command = await commandExists("claude");
    if (!command.path) {
      return { kind: "claude-code", label: "Claude Code", installed: false, error: command.error };
    }
    try {
      const version = await runCommand("claude", ["--version"], { timeoutMs: 10_000 });
      return { kind: "claude-code", label: "Claude Code", installed: true, path: command.path, version: version.stdout.trim() };
    } catch (error) {
      return { kind: "claude-code", label: "Claude Code", installed: true, path: command.path, error: this.errorText(error) };
    }
  }

  private async runCodex(
    participant: ParticipantConfig,
    prompt: string,
    repoPath: string | undefined,
    diffMode: GitDiffMode | undefined,
    kind: ConversationKind,
    signal?: AbortSignal,
    options: CliAgentRunOptions = {}
  ): Promise<ParticipantRunResult> {
    if (options.warm && kind === "chat") {
      return this.runCodexAppServerWarmOrOneShot(participant, prompt, repoPath, diffMode, kind, signal, options);
    }
    return this.runCodexOneShot(participant, prompt, repoPath, diffMode, kind, signal, options);
  }

  private async compactCodexSession(
    participant: ParticipantConfig,
    repoPath: string | undefined,
    diffMode: GitDiffMode | undefined,
    kind: ConversationKind,
    signal: AbortSignal | undefined,
    options: CliAgentRunOptions
  ): Promise<CliAgentCompactResult> {
    const compactWithEntry = async (entry: WarmAgentEntry, warm?: CliAgentWarmOptions): Promise<CliAgentCompactResult> => {
      if (!entry.compact) {
        return { participant, ok: false, error: "Codex app-server compact is not available." };
      }
      return this.enqueueWarmRun(entry, async () => {
        this.clearWarmIdleTimer(entry);
        try {
          const result = await entry.compact!(options.compactInstructions, signal, options.onSessionId);
          if (warm) {
            this.scheduleWarmIdleTimer(entry, warm.idleTimeoutMs);
          }
          return result;
        } catch (error) {
          this.warmAgents.delete(entry.key);
          await this.closeWarmAgent(entry, signal?.aborted ? "aborted" : "failed");
          return this.failedCompact(participant, error);
        }
      });
    };

    const warm = options.warm;
    if (warm && kind === "chat" && process.env[CODEX_APP_SERVER_DISABLED_ENV] !== "0") {
      const key = this.warmAgentKey(participant, repoPath, kind, options);
      const scopeKey = this.warmAgentScopeKey(warm);
      await this.closeStaleWarmAgents(scopeKey, key);
      let entry = this.warmAgents.get(key);
      if (!entry || entry.closed || entry.process.exitCode !== null) {
        if (entry) {
          this.warmAgents.delete(key);
          await this.closeWarmAgent(entry, "stale");
        }
        try {
          await ensureLoginShellEnvPrimed();
          entry = this.createCodexAppServerWarmAgent(key, scopeKey, participant, repoPath, diffMode, kind, options);
          this.warmAgents.set(key, entry);
        } catch (error) {
          return this.failedCompact(participant, error);
        }
      }
      return compactWithEntry(entry, warm);
    }

    try {
      await ensureLoginShellEnvPrimed();
      const entry = this.createCodexAppServerWarmAgent(
        `compact:${options.sessionId}:${randomUUID()}`,
        `compact:${options.sessionId}`,
        participant,
        repoPath,
        diffMode,
        kind,
        this.withoutWarm(options)
      );
      try {
        return await compactWithEntry(entry);
      } finally {
        await this.closeWarmAgent(entry, "compact-complete");
      }
    } catch (error) {
      return this.failedCompact(participant, error);
    }
  }

  private async runCodexAppServerWarmOrOneShot(
    participant: ParticipantConfig,
    prompt: string,
    repoPath: string | undefined,
    diffMode: GitDiffMode | undefined,
    kind: ConversationKind,
    signal: AbortSignal | undefined,
    options: CliAgentRunOptions
  ): Promise<ParticipantRunResult> {
    const warm = options.warm;
    if (!warm || process.env[CODEX_APP_SERVER_DISABLED_ENV] === "0") {
      return this.runCodexOneShot(participant, prompt, repoPath, diffMode, kind, signal, this.withoutWarm(options));
    }
    const key = this.warmAgentKey(participant, repoPath, kind, options);
    const scopeKey = this.warmAgentScopeKey(warm);
    await this.closeStaleWarmAgents(scopeKey, key);
    let entry = this.warmAgents.get(key);
    if (!entry || entry.closed || entry.process.exitCode !== null) {
      if (entry) {
        this.warmAgents.delete(key);
        await this.closeWarmAgent(entry, "stale");
      }
      try {
        await ensureLoginShellEnvPrimed();
        entry = this.createCodexAppServerWarmAgent(key, scopeKey, participant, repoPath, diffMode, kind, options);
        this.warmAgents.set(key, entry);
        void this.writeDebugLog("cli-agent-warm-started", {
          providerKind: participant.kind,
          participantId: participant.id,
          conversationId: warm.conversationId,
          runtime: "codex-app-server"
        });
      } catch (error) {
        void this.writeDebugLog("cli-agent-warm-start-failed", {
          providerKind: participant.kind,
          participantId: participant.id,
          conversationId: warm.conversationId,
          runtime: "codex-app-server",
          error: this.errorText(error)
        });
        return this.runCodexOneShot(participant, prompt, repoPath, diffMode, kind, signal, this.withoutWarm(options));
      }
    }

    return this.enqueueWarmRun(entry, async () => {
      this.clearWarmIdleTimer(entry as WarmAgentEntry);
      try {
        const result = this.withAppMcpClientStatus(
          await (entry as WarmAgentEntry).run(prompt, signal, options.onOutput, options.onSessionId, options.timeoutMs),
          participant,
          options
        );
        if (result.appMcpClientFailed) {
          this.warmAgents.delete(key);
          await this.closeWarmAgent(entry as WarmAgentEntry, "app-mcp-unavailable");
          return result;
        }
        this.scheduleWarmIdleTimer(entry as WarmAgentEntry, warm.idleTimeoutMs);
        return result;
      } catch (error) {
        this.warmAgents.delete(key);
        await this.closeWarmAgent(entry as WarmAgentEntry, signal?.aborted ? "aborted" : "failed");
        if (signal?.aborted) {
          return this.failed(participant, error);
        }
        void this.writeDebugLog("cli-agent-warm-fallback", {
          providerKind: participant.kind,
          participantId: participant.id,
          conversationId: warm.conversationId,
          runtime: "codex-app-server",
          error: this.errorText(error)
        });
        return this.runCodexOneShot(participant, prompt, repoPath, diffMode, kind, signal, this.withoutWarm(options));
      }
    });
  }

  private createCodexAppServerWarmAgent(
    key: string,
    scopeKey: string,
    participant: ParticipantConfig,
    repoPath: string | undefined,
    diffMode: GitDiffMode | undefined,
    kind: ConversationKind,
    options: CliAgentRunOptions
  ): WarmAgentEntry {
    const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
      cwd: repoPath,
      env: commandEnvironment(this.agentRunEnv(options)),
      stdio: ["pipe", "pipe", "pipe"]
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    let stdoutBuffer = "";
    let stderrBuffer = "";
    let stderr = "";
    let closed = false;
    let nextRequestId = 1;
    let threadId = options.sessionId;
    let threadLoaded = false;
    let initialized = false;
    let activeModel = participant.model;
    const pendingRequests = new Map<number, CodexAppServerPendingRequest>();
    let pendingTurn: CodexAppServerPendingTurn | undefined;
    let pendingCompact: CodexAppServerPendingCompact | undefined;

    const cleanupPendingTurn = (): CodexAppServerPendingTurn | undefined => {
      const current = pendingTurn;
      if (!current) {
        return undefined;
      }
      clearTimeout(current.timer);
      if (current.abort) {
        current.abort();
      }
      pendingTurn = undefined;
      return current;
    };

    const rejectPendingTurn = (error: Error): void => {
      const current = cleanupPendingTurn();
      current?.reject(error);
    };

    const cleanupPendingCompact = (): CodexAppServerPendingCompact | undefined => {
      const current = pendingCompact;
      if (!current) {
        return undefined;
      }
      clearTimeout(current.timer);
      if (current.abort) {
        current.abort();
      }
      pendingCompact = undefined;
      return current;
    };

    const rejectPendingCompact = (error: Error): void => {
      const current = cleanupPendingCompact();
      current?.reject(error);
    };

    const sendRequest = (method: string, params: unknown, timeoutMs?: number): Promise<unknown> => {
      if (closed || child.exitCode !== null || child.killed) {
        return Promise.reject(new Error("codex app-server process is not running"));
      }
      const id = nextRequestId;
      nextRequestId += 1;
      return new Promise<unknown>((resolve, reject) => {
        let settled = false;
        let timer: NodeJS.Timeout | undefined;
        const settle = (callback: () => void): void => {
          if (settled) {
            return;
          }
          settled = true;
          if (timer) {
            clearTimeout(timer);
          }
          pendingRequests.delete(id);
          callback();
        };
        const resolveRequest = (result: unknown): void => settle(() => resolve(result));
        const rejectRequest = (error: Error): void => settle(() => reject(error));
        pendingRequests.set(id, { method, resolve: resolveRequest, reject: rejectRequest });
        if (timeoutMs && timeoutMs > 0) {
          timer = setTimeout(() => {
            rejectRequest(new Error(`${method} timed out after ${timeoutMs}ms`));
          }, timeoutMs);
          timer.unref();
        }
        child.stdin.write(`${JSON.stringify({ method, id, params })}\n`, (error) => {
          if (error) {
            rejectRequest(error);
          }
        });
      });
    };

    const initialize = async (timeoutMs?: number): Promise<void> => {
      if (initialized) {
        return;
      }
      await sendRequest("initialize", {
        clientInfo: {
          name: "accordagents",
          title: "AccordAgents",
          version: "0.1.0"
        },
        capabilities: {
          experimentalApi: true,
          optOutNotificationMethods: []
        }
      }, timeoutMs);
      initialized = true;
    };

    const ensureThread = async (timeoutMs?: number): Promise<string> => {
      await initialize(timeoutMs);
      if (threadId && threadLoaded) {
        return threadId;
      }
      if (threadId) {
        if (options.sessionId && threadId === options.sessionId) {
          const result = await sendRequest("thread/resume", this.codexAppServerThreadResumeParams(options.sessionId, participant, repoPath, kind, options), timeoutMs) as CodexAppServerThreadStartResult;
          threadId = result.thread?.id ?? options.sessionId;
          activeModel = result.model ?? activeModel;
        }
        threadLoaded = true;
        return threadId;
      }
      const result = await sendRequest("thread/start", this.codexAppServerThreadStartParams(participant, repoPath, kind, options), timeoutMs) as CodexAppServerThreadStartResult;
      const nextThreadId = result.thread?.id ?? result.thread?.sessionId;
      if (!nextThreadId) {
        throw new Error("codex app-server did not return a thread id");
      }
      threadId = nextThreadId;
      threadLoaded = true;
      activeModel = result.model ?? activeModel;
      return nextThreadId;
    };

    const handleResponse = (record: Record<string, unknown>): void => {
      const id = typeof record.id === "number" ? record.id : undefined;
      if (id === undefined) {
        return;
      }
      const pending = pendingRequests.get(id);
      if (!pending) {
        return;
      }
      pendingRequests.delete(id);
      const error = this.asRecord(record.error);
      if (error) {
        pending.reject(new Error(this.stringField(error, "message") ?? `${pending.method} failed`));
        return;
      }
      pending.resolve(record.result);
    };

    const handleLine = (line: string): void => {
      let event: unknown;
      try {
        event = JSON.parse(line) as unknown;
      } catch {
        return;
      }
      const record = this.asRecord(event);
      if (!record) {
        return;
      }
      if ("id" in record) {
        handleResponse(record);
        return;
      }
      if (this.handleCodexAppServerCompactNotification(record, participant, pendingCompact, cleanupPendingCompact, rejectPendingCompact)) {
        return;
      }
      this.handleCodexAppServerNotification(record, participant, pendingTurn, cleanupPendingTurn, rejectPendingTurn);
    };

    const handleData = (chunk: string, stream: "stdout" | "stderr"): void => {
      if (stream === "stderr") {
        stderr = this.truncateText(`${stderr}${chunk}`, MAX_CLI_ERROR_CHARS);
        stderrBuffer += chunk;
      } else {
        stdoutBuffer += chunk;
      }
      let buffer = stream === "stderr" ? stderrBuffer : stdoutBuffer;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          handleLine(line);
        }
        newline = buffer.indexOf("\n");
      }
      if (stream === "stderr") {
        stderrBuffer = buffer;
      } else {
        stdoutBuffer = buffer;
      }
    };

    child.stdout.on("data", (chunk: string) => handleData(chunk, "stdout"));
    child.stderr.on("data", (chunk: string) => handleData(chunk, "stderr"));
    child.stdin.on("error", (error) => {
      closed = true;
      rejectPendingTurn(error);
      rejectPendingCompact(error);
      for (const pending of pendingRequests.values()) {
        pending.reject(error);
      }
      pendingRequests.clear();
    });
    child.on("error", (error) => {
      closed = true;
      rejectPendingTurn(error);
      rejectPendingCompact(error);
      for (const pending of pendingRequests.values()) {
        pending.reject(error);
      }
      pendingRequests.clear();
    });
    child.on("close", (exitCode) => {
      closed = true;
      const error = new Error(`codex app-server process exited${exitCode === null ? "" : ` with code ${exitCode}`}${stderr ? `: ${stderr}` : ""}`);
      rejectPendingTurn(error);
      rejectPendingCompact(error);
      for (const pending of pendingRequests.values()) {
        pending.reject(error);
      }
      pendingRequests.clear();
    });

    return {
      key,
      scopeKey,
      providerKind: participant.kind,
      process: child,
      queue: Promise.resolve(),
      closed: false,
      compact: async (
        instructions?: string,
        signal?: AbortSignal,
        onSessionId?: CliAgentSessionIdCallback
      ): Promise<CliAgentCompactResult> => {
        const timeoutMs = options.timeoutMs ?? CLI_AGENT_COMPACT_TIMEOUT_MS;
        const currentThreadId = await ensureThread(timeoutMs);
        const compactOptions: CliAgentRunOptions = {
          ...options,
          sessionId: currentThreadId
        };
        if (instructions?.trim()) {
          compactOptions.compactInstructions = instructions;
        } else {
          delete compactOptions.compactInstructions;
        }
        delete compactOptions.clearCompactPrompt;
        const resumeResult = await sendRequest("thread/resume", this.codexAppServerThreadResumeParams(
          currentThreadId,
          participant,
          repoPath,
          kind,
          compactOptions
        ), timeoutMs) as CodexAppServerThreadStartResult;
        const compactThreadId = resumeResult.thread?.id ?? currentThreadId;
        threadId = compactThreadId;
        threadLoaded = true;
        activeModel = resumeResult.model ?? activeModel;
        this.reportSessionId(onSessionId, compactThreadId);
        if (pendingCompact) {
          return { participant, ok: false, error: "codex app-server already has an active compact operation" };
        }
        const startedAt = Date.now();
        const timer = setTimeout(() => {
          rejectPendingCompact(new Error(`codex app-server compact timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref();
        const abort = (): void => {
          rejectPendingCompact(new Error("codex app-server compact was cancelled"));
        };
        const resultPromise = new Promise<CliAgentCompactResult>((resolve, reject) => {
          pendingCompact = {
            threadId: compactThreadId,
            startedAt,
            timer,
            abort: signal ? () => signal.removeEventListener("abort", abort) : undefined,
            onSessionId,
            resolve,
            reject
          };
        });
        if (signal?.aborted) {
          abort();
          return resultPromise;
        }
        signal?.addEventListener("abort", abort, { once: true });
        try {
          void this.writeDebugLog("cli-agent-compact-started", {
            providerKind: participant.kind,
            participantId: participant.id,
            threadId: compactThreadId,
            timeoutMs
          });
          void sendRequest("thread/compact/start", { threadId: compactThreadId }, timeoutMs)
            .then((result) => {
              const record = this.asRecord(result);
              if (record) {
                this.handleCodexAppServerCompactNotification(record, participant, pendingCompact, cleanupPendingCompact, rejectPendingCompact);
              }
            })
            .catch((error) => {
              rejectPendingCompact(error instanceof Error ? error : new Error(String(error)));
            });
          const result = await resultPromise;
          if (result.contextUsage) {
            return result;
          }
          const logUsage = await this.extractCodexSessionLogContextUsageWithRetry(result.sessionId ?? compactThreadId, participant);
          return logUsage ? { ...result, contextUsage: logUsage } : result;
        } finally {
          if (instructions?.trim()) {
            const clearCompactOptions: CliAgentRunOptions = {
              ...options,
              sessionId: compactThreadId,
              clearCompactPrompt: true
            };
            delete clearCompactOptions.compactInstructions;
            await sendRequest("thread/resume", this.codexAppServerThreadResumeParams(
              compactThreadId,
              participant,
              repoPath,
              kind,
              clearCompactOptions
            ), 10_000).catch(() => undefined);
          }
        }
      },
      run: async (
        turnPrompt: string,
        signal?: AbortSignal,
        onOutput?: CliAgentOutputCallback,
        onSessionId?: CliAgentSessionIdCallback,
        timeoutMsOverride?: number
      ): Promise<ParticipantRunResult> => {
        const timeoutMs = timeoutMsOverride ?? this.runTimeoutMs;
        const currentThreadId = await ensureThread(timeoutMs);
        this.reportSessionId(onSessionId, currentThreadId);
        const startedAt = Date.now();
        const timer = setTimeout(() => {
          rejectPendingTurn(new Error(`codex app-server timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref();
        const abort = (): void => {
          const current = pendingTurn;
          if (current?.turnId) {
            void sendRequest("turn/interrupt", { threadId: current.threadId, turnId: current.turnId }).catch(() => undefined);
          }
          rejectPendingTurn(new Error("codex app-server turn was cancelled"));
        };
        const resultPromise = new Promise<ParticipantRunResult>((resolve, reject) => {
          pendingTurn = {
            startedAt,
            threadId: currentThreadId,
            messages: [],
            streamedText: "",
            completedAgentMessages: [],
            nextAgentMessageStartsBlock: false,
            model: activeModel,
            timer,
            abort: signal ? () => signal.removeEventListener("abort", abort) : undefined,
            onOutput,
            resolve,
            reject
          };
        });
        if (signal?.aborted) {
          abort();
          return resultPromise;
        }
        signal?.addEventListener("abort", abort, { once: true });
        const turn = await sendRequest("turn/start", {
          threadId: currentThreadId,
          effort: this.codexReasoningEffort(participant.reasoningEffort) ?? null,
          input: [
            {
              type: "text",
              text: this.codexPrompt(turnPrompt, repoPath, diffMode, kind, options),
              text_elements: []
            }
          ]
        }, timeoutMs) as CodexAppServerTurnStartResult;
        if (pendingTurn) {
          pendingTurn.turnId = turn.turn?.id;
        }
        return resultPromise;
      }
    };
  }

  private codexAppServerThreadStartParams(
    participant: ParticipantConfig,
    repoPath: string | undefined,
    kind: ConversationKind,
    options: CliAgentRunOptions
  ): Record<string, unknown> {
    const mode = this.agentModeForRun(kind, options);
    const permissions = this.permissionsForRun("codex-cli", mode, options);
    return {
      model: participant.model ?? null,
      cwd: repoPath ?? null,
      approvalPolicy: this.codexAppServerApprovalPolicy(mode),
      approvalsReviewer: mode === "auto" ? CODEX_AUTO_APPROVALS_REVIEWER : null,
      sandbox: permissions.workspaceWrite ? "workspace-write" : "read-only",
      config: this.codexAppServerConfig(participant, permissions, options),
      developerInstructions: options.role?.instructions ?? null,
      ephemeral: !options.persistSession,
      experimentalRawEvents: false,
      persistExtendedHistory: false
    };
  }

  private codexAppServerThreadResumeParams(
    sessionId: string,
    participant: ParticipantConfig,
    repoPath: string | undefined,
    kind: ConversationKind,
    options: CliAgentRunOptions
  ): Record<string, unknown> {
    const mode = this.agentModeForRun(kind, options);
    const permissions = this.permissionsForRun("codex-cli", mode, options);
    return {
      threadId: sessionId,
      model: participant.model ?? null,
      cwd: repoPath ?? null,
      approvalPolicy: this.codexAppServerApprovalPolicy(mode),
      approvalsReviewer: mode === "auto" ? CODEX_AUTO_APPROVALS_REVIEWER : null,
      sandbox: permissions.workspaceWrite ? "workspace-write" : "read-only",
      config: this.codexAppServerConfig(participant, permissions, options),
      developerInstructions: options.role?.instructions ?? null,
      excludeTurns: true,
      persistExtendedHistory: false
    };
  }

  private codexAppServerApprovalPolicy(mode: ChatAgentMode): string {
    return mode === "auto" ? "on-request" : "never";
  }

  private codexReasoningEffort(value: ChatReasoningEffort | undefined): ChatReasoningEffort | undefined {
    return normalizeChatReasoningEffort(value, "codex-cli");
  }

  private claudeReasoningEffort(value: ChatReasoningEffort | undefined): ChatReasoningEffort | undefined {
    return normalizeChatReasoningEffort(value, "claude-code");
  }

  private codexAppServerConfig(
    participant: ParticipantConfig,
    permissions: ChatAgentPermissions,
    options: CliAgentRunOptions
  ): Record<string, unknown> {
    const config: Record<string, unknown> = {
      web_search: permissions.webAccess ? "live" : "disabled"
    };
    const reasoningEffort = this.codexReasoningEffort(participant.reasoningEffort);
    if (reasoningEffort) {
      config.model_reasoning_effort = reasoningEffort;
    }
    if (options.appMcp) {
      config["mcp_servers.accord_agents.url"] = options.appMcp.url;
      config["mcp_servers.accord_agents.bearer_token_env_var"] = CODEX_APP_SERVER_MCP_TOKEN_ENV;
    }
    if (options.compactInstructions?.trim()) {
      config.compact_prompt = this.codexCompactPrompt(options.compactInstructions);
    } else if (options.clearCompactPrompt) {
      config.compact_prompt = null;
    }
    return config;
  }

  private codexCompactPrompt(instructions: string | undefined): string | null {
    const focus = instructions?.trim();
    if (!focus) {
      return null;
    }
    return [
      "Compact the conversation context for future turns. Preserve the information needed to continue accurately: user requirements, decisions, constraints, file paths, commands run, test results, open risks, and next steps.",
      "Pay special attention to this user focus instruction:",
      focus
    ].join("\n\n");
  }

  private handleCodexAppServerCompactNotification(
    record: Record<string, unknown>,
    participant: ParticipantConfig,
    pending: CodexAppServerPendingCompact | undefined,
    cleanupPending: () => CodexAppServerPendingCompact | undefined,
    rejectPending: (error: Error) => void
  ): boolean {
    if (!pending) {
      return false;
    }
    const eventNames = this.codexAppServerEventNames(record);
    if (eventNames.length === 0) {
      return false;
    }
    const params = this.asRecord(record.params) ?? this.asRecord(record.msg) ?? this.asRecord(record.event) ?? this.asRecord(record.payload) ?? record;
    const threadIdFromEvent = this.findStringField(record, ["threadId", "thread_id"]);
    if (threadIdFromEvent && threadIdFromEvent !== pending.threadId) {
      return false;
    }
    if (eventNames.some((name) => this.isCodexAppServerTokenUsageEventName(name))) {
      pending.contextUsage = this.agentContextUsageFromEvent(record, participant, "codex-cli") ?? pending.contextUsage;
      return true;
    }
    // Newer codex builds (>= 0.139) signal a completed compaction with a normal
    // turn lifecycle rather than a dedicated thread/compacted event. Track the
    // compaction turn id so the matching turn/completed resolves the operation.
    if (eventNames.some((name) => this.isCodexAppServerTurnStartedEventName(name))) {
      const turnId = this.codexAppServerTurnId(record, params);
      pending.sawCompactTurn = true;
      if (turnId) {
        pending.compactTurnId = turnId;
      }
      return true;
    }
    const compactComplete = eventNames.some((name) => this.isCodexAppServerCompactCompleteEventName(name));
    const turnCompleted = eventNames.some((name) => this.isCodexAppServerTurnCompletedEventName(name));
    if (turnCompleted && !compactComplete) {
      // Ignore unrelated turn completions that are not the compaction turn.
      const turnId = this.codexAppServerTurnId(record, params);
      if (pending.compactTurnId && turnId && turnId !== pending.compactTurnId) {
        return true;
      }
      if (!pending.sawCompactTurn && !pending.compactTurnId) {
        // We have not yet observed the compaction turn starting; ignore stray
        // completions from a prior turn to avoid resolving too early.
        return true;
      }
      const turn = this.asRecord(params.turn) ?? this.asRecord(record.turn);
      const status = this.stringField(turn ?? {}, "status");
      if (status && status !== "completed") {
        const error = this.asRecord(turn?.error) ?? this.asRecord(params.error);
        rejectPending(new Error(this.stringField(error ?? {}, "message") ?? `codex app-server compact turn ${status}`));
        return true;
      }
    }
    if (compactComplete || turnCompleted) {
      const current = cleanupPending();
      current?.resolve({
        participant,
        ok: true,
        sessionId: current.threadId,
        contextUsage: this.agentContextUsageFromEvent(record, participant, "codex-cli") ?? current.contextUsage,
        providerNative: true
      });
      return true;
    }
    if (eventNames.some((name) => this.isCodexAppServerErrorEventName(name))) {
      const error = this.asRecord(params.error) ?? this.asRecord(record.error);
      rejectPending(new Error(this.stringField(error ?? {}, "message") ?? "codex app-server reported an error"));
      return true;
    }
    return false;
  }

  private codexAppServerTurnId(record: Record<string, unknown>, params: Record<string, unknown>): string | undefined {
    const turn = this.asRecord(params.turn) ?? this.asRecord(record.turn);
    return (
      this.stringField(turn ?? {}, "id") ??
      this.findStringField(record, ["turnId", "turn_id"])
    );
  }

  private codexAppServerEventNames(record: Record<string, unknown>): string[] {
    const names = new Set<string>();
    const add = (value: unknown): void => {
      const entry = this.asRecord(value);
      if (!entry) {
        return;
      }
      for (const key of ["method", "type"]) {
        const name = this.stringField(entry, key);
        if (name?.trim()) {
          names.add(name.trim());
        }
      }
    };
    add(record);
    add(record.params);
    add(record.msg);
    add(record.event);
    add(record.payload);
    return Array.from(names);
  }

  private isCodexAppServerTokenUsageEventName(name: string): boolean {
    return this.normalizedCodexAppServerEventName(name) === "thread_tokenusage_updated";
  }

  private isCodexAppServerCompactCompleteEventName(name: string): boolean {
    const normalized = this.normalizedCodexAppServerEventName(name);
    return [
      "thread_compacted",
      "context_compacted",
      "thread_compact_completed",
      "thread_compact_complete",
      "thread_compact_finished",
      "compact_completed",
      "compact_complete",
      "compact_finished"
    ].includes(normalized);
  }

  private isCodexAppServerTurnStartedEventName(name: string): boolean {
    return this.normalizedCodexAppServerEventName(name) === "turn_started";
  }

  private isCodexAppServerTurnCompletedEventName(name: string): boolean {
    return this.normalizedCodexAppServerEventName(name) === "turn_completed";
  }

  private isCodexAppServerErrorEventName(name: string): boolean {
    return this.normalizedCodexAppServerEventName(name) === "error";
  }

  private normalizedCodexAppServerEventName(name: string): string {
    return name.trim().toLowerCase().replace(/[/-]/g, "_");
  }

  private handleCodexAppServerNotification(
    record: Record<string, unknown>,
    participant: ParticipantConfig,
    pending: CodexAppServerPendingTurn | undefined,
    cleanupPending: () => CodexAppServerPendingTurn | undefined,
    rejectPending: (error: Error) => void
  ): void {
    if (!pending) {
      return;
    }
    const method = this.stringField(record, "method");
    const params = this.asRecord(record.params);
    if (!method || !params) {
      return;
    }
    this.logCodexAppServerNotificationSummary(method, params, pending);
    if (method === "item/autoApprovalReview/started") {
      this.emitLiveOutput(pending.onOutput, "tool", "Auto-reviewing approval request\n", undefined, {
        activityKind: "approval",
        activityStatus: "started"
      });
      return;
    }
    if (method === "item/autoApprovalReview/completed") {
      this.emitLiveOutput(pending.onOutput, "tool", "Auto-review completed\n", undefined, {
        activityKind: "approval",
        activityStatus: "completed"
      });
      return;
    }
    if (method === "item/started") {
      const item = this.asRecord(params.item);
      const itemType = this.stringField(item ?? {}, "type");
      if (itemType === "agentMessage" && pending.streamedText.trim()) {
        pending.nextAgentMessageStartsBlock = true;
      }
      const summary = this.codexAppServerToolSummary(item);
      if (summary) {
        this.emitLiveOutput(pending.onOutput, "tool", `${summary.label}\n`, undefined, {
          activityKind: summary.kind,
          activityStatus: "started"
        });
      }
      return;
    }
    if (method === "item/agentMessage/delta") {
      const delta = this.stringField(params, "delta");
      if (delta) {
        pending.messages.push(delta);
        if (pending.nextAgentMessageStartsBlock) {
          pending.streamedText = this.textWithAgentMessageBoundary(pending.streamedText, delta);
          pending.nextAgentMessageStartsBlock = false;
        }
        pending.streamedText += delta;
        this.emitLiveOutput(pending.onOutput, "text", delta, pending.streamedText);
      }
      return;
    }
    if (method === "item/completed") {
      const item = this.asRecord(params.item);
      if (this.stringField(item ?? {}, "type") === "agentMessage") {
        const text = this.stringField(item ?? {}, "text");
        if (text) {
          pending.finalMessage = text;
          pending.completedAgentMessages.push(text);
        }
      }
      return;
    }
    if (method === "thread/tokenUsage/updated") {
      pending.contextUsage = this.agentContextUsageFromEvent(record, participant, "codex-cli") ?? pending.contextUsage;
      return;
    }
    if (method === "error") {
      const error = this.asRecord(params.error);
      rejectPending(new Error(this.stringField(error ?? {}, "message") ?? "codex app-server reported an error"));
      return;
    }
    if (method !== "turn/completed") {
      return;
    }
    const turn = this.asRecord(params.turn);
    const status = this.stringField(turn ?? {}, "status");
    const current = cleanupPending();
    if (!current) {
      return;
    }
    if (status !== "completed") {
      const error = this.asRecord(turn?.error);
      current.reject(new Error(this.stringField(error ?? {}, "message") ?? `codex app-server turn ${status ?? "failed"}`));
      return;
    }
    const content = this.codexAppServerFinalContent(current);
    current.resolve({
      participant,
      ok: true,
      content,
      durationMs: Date.now() - current.startedAt,
      sessionId: current.threadId,
      roleRuntime: undefined,
      contextUsage: current.contextUsage
    });
  }

  private codexAppServerFinalContent(turn: CodexAppServerPendingTurn): string {
    const completedMessages = this.completedAgentMessagesForFinal(turn.completedAgentMessages, turn.finalMessage);
    if (completedMessages.length > 0) {
      return this.finalTextFromMessageItems(completedMessages);
    }
    return this.trailingTextBlock(turn.streamedText || turn.messages.join(""));
  }

  private completedAgentMessagesForFinal(completedMessages: string[], finalMessage: string | undefined): string[] {
    const messages = completedMessages.filter((message) => message.trim());
    if (finalMessage?.trim() && messages.at(-1) !== finalMessage) {
      messages.push(finalMessage);
    }
    return messages;
  }

  private finalTextFromMessageItems(messages: string[]): string {
    let currentIndex = messages.length - 1;
    let finalText = messages[currentIndex] ?? "";
    while (currentIndex > 0) {
      const previous = messages[currentIndex - 1] ?? "";
      const separator = this.agentMessageBoundarySeparator(previous, messages[currentIndex] ?? finalText);
      if (separator === "\n\n") {
        break;
      }
      finalText = `${previous.trimEnd()}${separator}${separator ? finalText.trimStart() : finalText}`;
      currentIndex -= 1;
    }
    return finalText.trim();
  }

  private trailingTextBlock(text: string): string {
    const normalized = text.replace(/\r\n/g, "\n").trimEnd();
    const splitIndex = normalized.lastIndexOf("\n\n");
    if (splitIndex < 0) {
      return normalized.trim();
    }
    let start = splitIndex + 2;
    while (normalized[start] === "\n") {
      start += 1;
    }
    return normalized.slice(start).trim();
  }

  private textWithAgentMessageBoundary(previous: string, next: string): string {
    const trimmedPrevious = previous.trimEnd();
    if (!trimmedPrevious) {
      return previous;
    }
    return `${trimmedPrevious}${this.agentMessageBoundarySeparator(trimmedPrevious, next)}`;
  }

  private agentMessageBoundarySeparator(previous: string, next: string): string {
    if (!previous.trim() || !next) {
      return "";
    }
    if (chatTextEndsAtSentenceOrParagraphBoundary(previous)) {
      return "\n\n";
    }
    if (/^\s|^[,.;:!?)]/.test(next)) {
      return "";
    }
    return " ";
  }

  private logCodexAppServerNotificationSummary(
    method: string,
    params: Record<string, unknown>,
    pending: CodexAppServerPendingTurn
  ): void {
    const item = this.asRecord(params.item);
    const delta = this.stringField(params, "delta");
    const itemType = this.stringField(item ?? {}, "type");
    const text = this.stringField(item ?? {}, "text");
    const turn = this.asRecord(params.turn);
    void this.debugLogs?.write("cli.codex-app-server.event-summary", {
      method,
      itemType,
      itemId: this.stringField(item ?? {}, "id"),
      turnId: this.stringField(turn ?? {}, "id") ?? pending.turnId,
      deltaLength: delta?.length,
      completedTextLength: text?.length
    });
  }

  private codexAppServerToolSummary(item: Record<string, unknown> | undefined): { label: string; kind: ChatAgentActivityKind } | undefined {
    if (!item) {
      return undefined;
    }
    const type = this.stringField(item, "type");
    if (type === "commandExecution") {
      return { label: "Running command", kind: "command" };
    }
    if (type === "mcpToolCall") {
      const tool = this.stringField(item, "tool");
      return { label: tool ? this.toolActivityLabel(tool) : "Using MCP tool", kind: "tool" };
    }
    if (type === "dynamicToolCall") {
      const tool = this.stringField(item, "tool");
      return { label: tool ? this.toolActivityLabel(tool) : "Using tool", kind: "tool" };
    }
    if (type === "webSearch") {
      return { label: "Using web search", kind: "web" };
    }
    if (type === "imageView") {
      return { label: "Viewing image", kind: "tool" };
    }
    if (type === "fileChange") {
      return { label: "Updating files", kind: "file-edit" };
    }
    return undefined;
  }

  private async runCodexOneShot(
    participant: ParticipantConfig,
    prompt: string,
    repoPath: string | undefined,
    diffMode: GitDiffMode | undefined,
    kind: ConversationKind,
    signal?: AbortSignal,
    options: CliAgentRunOptions = {}
  ): Promise<ParticipantRunResult> {
    const startedAt = Date.now();
    let outputDir: string | undefined;
    try {
      outputDir = await mkdtemp(path.join(tmpdir(), "accordagents-codex-"));
      const outputPath = path.join(outputDir, "last-message.txt");
      const invocation = buildCodexExecInvocation({
        participant,
        prompt,
        outputPath,
        repoPath,
        diffMode,
        kind,
        options: {
          ...options,
          extraEnv: this.agentRunEnv(options)
        }
      });
      const codexDeltaAccumulator = { value: "" };
      const stdoutLines = createCodexLineHandler((line) =>
        emitCodexExecLiveOutput(line, options.onOutput, codexDeltaAccumulator, options.onSessionId)
      );
      const result = await runCommand("codex", invocation.args, {
        cwd: repoPath,
        input: invocation.input,
        timeoutMs: options.timeoutMs ?? this.runTimeoutMs,
        env: invocation.env,
        signal,
        onStdout: options.onOutput || options.onSessionId ? stdoutLines : undefined
      });
      const lastMessage = await this.readOptionalFile(outputPath);
      const sessionId = extractCodexExecSessionId(result.stdout) ?? options.sessionId;
      this.reportSessionId(options.onSessionId, sessionId);
      return this.withAppMcpClientStatus({
        participant,
        ok: true,
        content: lastMessage.trim() || extractCodexExecText(result.stdout),
        durationMs: Date.now() - startedAt,
        sessionId,
        roleRuntime: options.role ? "codex-developer-instructions" : undefined,
        contextUsage:
          this.extractCodexContextUsage(result.stdout, participant) ??
          await this.extractCodexSessionLogContextUsageWithRetry(sessionId, participant)
      }, participant, options);
    } catch (error) {
      if (options.role && this.isCodexDeveloperInstructionsUnsupported(error)) {
        const fallback = await this.runCodexOneShot(
          participant,
          options.role.promptFallbackPrompt,
          repoPath,
          diffMode,
          kind,
          signal,
          {
            persistSession: options.persistSession,
            sessionId: options.sessionId,
            extraReadableDirs: options.extraReadableDirs,
            resumeFallbackPrompt: options.resumeFallbackPrompt,
            agentMode: options.agentMode,
            permissions: options.permissions,
            appMcp: options.appMcp,
            agentEnv: options.agentEnv,
            agentEnvKey: options.agentEnvKey,
            onSessionId: options.onSessionId
          }
        );
        return {
          ...fallback,
          roleRuntime: "prompt-fallback",
          warnings: [
            ...(fallback.warnings ?? []),
            `${participant.label}: Codex rejected developer_instructions config; used prompt fallback for role instructions.`
          ]
        };
      }
      if (options.sessionId && this.isResumeMiss(error)) {
        const restarted = await this.runCodexOneShot(participant, options.resumeFallbackPrompt ?? prompt, repoPath, diffMode, kind, signal, {
          persistSession: options.persistSession,
          extraReadableDirs: options.extraReadableDirs,
          role: options.role,
          agentMode: options.agentMode,
          permissions: options.permissions,
          appMcp: options.appMcp,
          agentEnv: options.agentEnv,
          agentEnvKey: options.agentEnvKey,
          onSessionId: options.onSessionId
        });
        return { ...restarted, sessionRestarted: true };
      }
      return this.failed(participant, error, Date.now() - startedAt);
    } finally {
      if (outputDir) {
        await rm(outputDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  private async runClaude(
    participant: ParticipantConfig,
    prompt: string,
    repoPath: string | undefined,
    kind: ConversationKind,
    signal?: AbortSignal,
    options: CliAgentRunOptions = {}
  ): Promise<ParticipantRunResult> {
    if (options.warm && kind === "chat") {
      return this.runClaudeWarmOrOneShot(participant, prompt, repoPath, kind, signal, options);
    }
    return this.runClaudeOneShot(participant, prompt, repoPath, kind, signal, options);
  }

  private async compactClaudeSession(
    participant: ParticipantConfig,
    repoPath: string | undefined,
    kind: ConversationKind,
    signal: AbortSignal | undefined,
    options: CliAgentRunOptions
  ): Promise<CliAgentCompactResult> {
    const compactPrompt = options.compactInstructions?.trim()
      ? `/compact ${options.compactInstructions.trim()}`
      : "/compact";
    // Run one-shot (no warm process): the one-shot result parses the final
    // result JSON, whose usage reflects the post-compaction summary size. The
    // warm streaming path does not surface usage for the /compact local command,
    // so it would leave the stale pre-compact figure on the hover.
    const result = await this.runClaude(participant, compactPrompt, repoPath, kind, signal, {
      ...options,
      warm: undefined,
      role: undefined,
      selectedSkills: undefined,
      appMcp: undefined,
      onOutput: undefined,
      timeoutMs: options.timeoutMs ?? CLI_AGENT_COMPACT_TIMEOUT_MS
    });
    return {
      participant,
      ok: result.ok,
      sessionId: result.sessionId,
      contextUsage: result.contextUsage,
      providerNative: false,
      content: result.content,
      error: result.error
    };
  }

  private async runClaudeOneShot(
    participant: ParticipantConfig,
    prompt: string,
    repoPath: string | undefined,
    kind: ConversationKind,
    signal?: AbortSignal,
    options: CliAgentRunOptions = {}
  ): Promise<ParticipantRunResult> {
    const startedAt = Date.now();
    const newSessionId = options.persistSession && !options.sessionId ? randomUUID() : undefined;
    const extraReadableDirs = this.normalizedExtraReadableDirs(options.extraReadableDirs);
    const toolConfig = this.claudeToolConfig(kind, repoPath, extraReadableDirs, options);
    try {
      const args = [
        "-p",
        "--output-format",
        "json",
        "--permission-mode",
        toolConfig.permissionMode
      ];
      args.push(...this.claudeAllowedToolsArgs(kind, options, toolConfig));
      if (toolConfig.disallowedTools.length > 0) {
        args.push("--disallowedTools", toolConfig.disallowedTools.join(","));
      }
      if (toolConfig.askTools.length > 0) {
        args.push("--settings", JSON.stringify({ permissions: { ask: toolConfig.askTools } }));
      }
      if (options.sessionId) {
        args.push("--resume", options.sessionId);
      } else if (newSessionId) {
        args.push("--session-id", newSessionId);
      }
      if (participant.model) {
        args.push("--model", participant.model);
      }
      const reasoningEffort = this.claudeReasoningEffort(participant.reasoningEffort);
      if (reasoningEffort) {
        args.push("--effort", reasoningEffort);
      }
      if (options.role && !options.sessionId) {
        args.push("--agents", this.claudeAgentsJson(options.role), "--agent", options.role.name);
      }
      args.push(...this.claudeMcpArgs(kind, options));
      args.push(...this.claudePermissionPromptArgs(kind, options));
      if (extraReadableDirs.length > 0) {
        args.push("--add-dir", ...extraReadableDirs);
      }
      args.push(...this.claudeToolsArgs(kind, toolConfig, options));
      this.reportSessionId(options.onSessionId, newSessionId);

      const result = await runCommand(
        "claude",
        args,
        {
          cwd: repoPath,
          input: prompt,
          timeoutMs: options.timeoutMs ?? this.runTimeoutMs,
          env: this.agentRunEnv(options),
          envOptions: CLAUDE_CODE_COMMAND_ENV_OPTIONS,
          signal
        }
      );
      const sessionId = this.extractClaudeSessionId(result.stdout) ?? newSessionId ?? options.sessionId;
      this.reportSessionId(options.onSessionId, sessionId);
      return this.withAppMcpClientStatus({
        participant,
        ok: true,
        content: this.extractClaudeText(result.stdout),
        durationMs: Date.now() - startedAt,
        sessionId,
        roleRuntime: options.role && !options.sessionId ? "claude-agent" : undefined,
        contextUsage:
          this.extractClaudeContextUsage(result.stdout, participant) ??
          await this.extractClaudeSessionLogContextUsageWithRetry(sessionId, participant)
      }, participant, options);
    } catch (error) {
      if (this.agentModeForRun(kind, options) === "auto" && this.isClaudePermissionModeUnsupported(error)) {
        // Fail loudly instead of silently downgrading: Auto-review must run as native
        // Claude auto, not a different mode under the same label.
        return this.failed(
          participant,
          new Error("Claude Code in this environment does not support Auto-review (--permission-mode auto). Upgrade Claude Code, or set this participant to Default or Plan mode."),
          Date.now() - startedAt
        );
      }
      if (options.role && !options.sessionId && this.isClaudeAgentFlagUnsupported(error)) {
        const fallback = await this.runClaudeOneShot(
          participant,
          options.role.promptFallbackPrompt,
          repoPath,
          kind,
          signal,
          {
            persistSession: options.persistSession,
            extraReadableDirs: options.extraReadableDirs,
            resumeFallbackPrompt: options.resumeFallbackPrompt,
            agentMode: options.agentMode,
            permissions: options.permissions,
            appMcp: options.appMcp,
            onSessionId: options.onSessionId
          }
        );
        return {
          ...fallback,
          roleRuntime: "prompt-fallback",
          warnings: [
            ...(fallback.warnings ?? []),
            `${participant.label}: Claude Code rejected --agent/--agents; used prompt fallback for role instructions.`
          ]
        };
      }
      if (options.sessionId && this.isResumeMiss(error)) {
        const restarted = await this.runClaudeOneShot(participant, options.resumeFallbackPrompt ?? prompt, repoPath, kind, signal, {
          persistSession: options.persistSession,
          extraReadableDirs: options.extraReadableDirs,
          role: options.role,
          agentMode: options.agentMode,
          permissions: options.permissions,
          appMcp: options.appMcp,
          onSessionId: options.onSessionId
        });
        return { ...restarted, sessionRestarted: true };
      }
      return this.failed(participant, error, Date.now() - startedAt);
    }
  }

  private async runClaudeWarmOrOneShot(
    participant: ParticipantConfig,
    prompt: string,
    repoPath: string | undefined,
    kind: ConversationKind,
    signal: AbortSignal | undefined,
    options: CliAgentRunOptions
  ): Promise<ParticipantRunResult> {
    const warm = options.warm;
    if (!warm) {
      return this.runClaudeOneShot(participant, prompt, repoPath, kind, signal, options);
    }
    const key = this.warmAgentKey(participant, repoPath, kind, options);
    const scopeKey = this.warmAgentScopeKey(warm);
    await this.closeStaleWarmAgents(scopeKey, key);
    let entry = this.warmAgents.get(key);
    if (!entry || entry.closed || entry.process.exitCode !== null) {
      if (entry) {
        this.warmAgents.delete(key);
        await this.closeWarmAgent(entry, "stale");
      }
      try {
        await ensureLoginShellEnvPrimed();
        entry = this.createClaudeWarmAgent(key, scopeKey, participant, repoPath, kind, options);
        this.warmAgents.set(key, entry);
        void this.writeDebugLog("cli-agent-warm-started", {
          providerKind: participant.kind,
          participantId: participant.id,
          conversationId: warm.conversationId
        });
      } catch (error) {
        void this.writeDebugLog("cli-agent-warm-start-failed", {
          providerKind: participant.kind,
          participantId: participant.id,
          conversationId: warm.conversationId,
          error: this.errorText(error)
        });
        return this.runClaudeOneShot(participant, prompt, repoPath, kind, signal, this.withoutWarm(options));
      }
    }

    return this.enqueueWarmRun(entry, async () => {
      this.clearWarmIdleTimer(entry as WarmAgentEntry);
      try {
        const result = this.withAppMcpClientStatus(
          await (entry as WarmAgentEntry).run(prompt, signal, options.onOutput, options.onSessionId, options.timeoutMs),
          participant,
          options
        );
        if (result.appMcpClientFailed) {
          this.warmAgents.delete(key);
          await this.closeWarmAgent(entry as WarmAgentEntry, "app-mcp-unavailable");
          return result;
        }
        this.scheduleWarmIdleTimer(entry as WarmAgentEntry, warm.idleTimeoutMs);
        return result;
      } catch (error) {
        this.warmAgents.delete(key);
        await this.closeWarmAgent(entry as WarmAgentEntry, signal?.aborted ? "aborted" : "failed");
        if (signal?.aborted) {
          return this.failed(participant, error);
        }
        void this.writeDebugLog("cli-agent-warm-fallback", {
          providerKind: participant.kind,
          participantId: participant.id,
          conversationId: warm.conversationId,
          error: this.errorText(error)
        });
        return this.runClaudeOneShot(participant, prompt, repoPath, kind, signal, this.withoutWarm(options));
      }
    });
  }

  private createClaudeWarmAgent(
    key: string,
    scopeKey: string,
    participant: ParticipantConfig,
    repoPath: string | undefined,
    kind: ConversationKind,
    options: CliAgentRunOptions
  ): WarmAgentEntry {
    const newSessionId = options.persistSession && !options.sessionId ? randomUUID() : undefined;
    const extraReadableDirs = this.normalizedExtraReadableDirs(options.extraReadableDirs);
    const toolConfig = this.claudeToolConfig(kind, repoPath, extraReadableDirs, options);
    const args = [
      "-p",
      "--verbose",
      "--include-partial-messages",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--permission-mode",
      toolConfig.permissionMode
    ];
    args.push(...this.claudeAllowedToolsArgs(kind, options, toolConfig));
    if (toolConfig.disallowedTools.length > 0) {
      args.push("--disallowedTools", toolConfig.disallowedTools.join(","));
    }
    if (toolConfig.askTools.length > 0) {
      args.push("--settings", JSON.stringify({ permissions: { ask: toolConfig.askTools } }));
    }
    if (options.sessionId) {
      args.push("--resume", options.sessionId);
    } else if (newSessionId) {
      args.push("--session-id", newSessionId);
    }
    if (participant.model) {
      args.push("--model", participant.model);
    }
    const reasoningEffort = this.claudeReasoningEffort(participant.reasoningEffort);
    if (reasoningEffort) {
      args.push("--effort", reasoningEffort);
    }
    if (options.role && !options.sessionId) {
      args.push("--agents", this.claudeAgentsJson(options.role), "--agent", options.role.name);
    }
    args.push(...this.claudeMcpArgs(kind, options));
    args.push(...this.claudePermissionPromptArgs(kind, options));
    if (extraReadableDirs.length > 0) {
      args.push("--add-dir", ...extraReadableDirs);
    }
    args.push(...this.claudeToolsArgs(kind, toolConfig, options));

    const child = spawn("claude", args, {
      cwd: repoPath,
      env: commandEnvironment(this.agentRunEnv(options), CLAUDE_CODE_COMMAND_ENV_OPTIONS),
      stdio: ["pipe", "pipe", "pipe"]
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    let stdoutBuffer = "";
    let stderr = "";
    let closed = false;
    let pending: ClaudeWarmPendingTurn | undefined;

    const cleanupPending = (): ClaudeWarmPendingTurn | undefined => {
      const current = pending;
      if (!current) {
        return undefined;
      }
      clearTimeout(current.timer);
      if (current.abort) {
        current.abort();
      }
      pending = undefined;
      return current;
    };

    const rejectPending = (error: Error): void => {
      const current = cleanupPending();
      current?.reject(error);
    };

    child.stderr.on("data", (chunk: string) => {
      stderr = this.truncateText(`${stderr}${chunk}`, MAX_CLI_ERROR_CHARS);
    });

    child.stdin.on("error", (error) => {
      closed = true;
      rejectPending(error);
    });

    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      let newline = stdoutBuffer.indexOf("\n");
      while (newline >= 0) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (line) {
          this.handleClaudeWarmLine(line, participant, options, newSessionId, pending, cleanupPending, rejectPending);
        }
        newline = stdoutBuffer.indexOf("\n");
      }
    });

    child.on("error", (error) => {
      closed = true;
      rejectPending(error);
    });
    child.on("close", (exitCode) => {
      closed = true;
      rejectPending(new Error(`claude warm process exited${exitCode === null ? "" : ` with code ${exitCode}`}${stderr ? `: ${stderr}` : ""}`));
    });

    return {
      key,
      scopeKey,
      providerKind: participant.kind,
      process: child,
      queue: Promise.resolve(),
      closed: false,
      run: (
        turnPrompt: string,
        signal?: AbortSignal,
        onOutput?: CliAgentOutputCallback,
        onSessionId?: CliAgentSessionIdCallback,
        timeoutMs?: number
      ) => {
        if (closed || child.exitCode !== null || child.killed) {
          return Promise.reject(new Error("claude warm process is not running"));
        }
        if (pending) {
          return Promise.reject(new Error("claude warm process already has an active turn"));
        }
        return new Promise<ParticipantRunResult>((resolve, reject) => {
          const startedAt = Date.now();
          const effectiveTimeoutMs = timeoutMs ?? this.runTimeoutMs;
          const timer = setTimeout(() => {
            rejectPending(new Error(`claude warm process timed out after ${effectiveTimeoutMs}ms`));
          }, effectiveTimeoutMs);
          timer.unref();
          const abort = (): void => {
            rejectPending(new Error("claude warm process was cancelled"));
          };
          pending = {
            startedAt,
            messages: [],
            streamedText: "",
            nextTextBlockStartsBlock: false,
            sessionId: options.sessionId ?? newSessionId,
            model: participant.model,
            timer,
            abort: signal ? () => signal.removeEventListener("abort", abort) : undefined,
            onOutput,
            onSessionId,
            resolve,
            reject
          };
          if (signal?.aborted) {
            abort();
            return;
          }
          signal?.addEventListener("abort", abort, { once: true });
          this.reportSessionId(onSessionId, pending.sessionId);
          child.stdin.write(`${JSON.stringify(this.claudeWarmUserMessage(turnPrompt))}\n`, (error) => {
            if (error) {
              rejectPending(error);
            }
          });
        });
      }
    };
  }

  private handleClaudeWarmLine(
    line: string,
    participant: ParticipantConfig,
    options: CliAgentRunOptions,
    fallbackSessionId: string | undefined,
    pending: ClaudeWarmPendingTurn | undefined,
    cleanupPending: () => ClaudeWarmPendingTurn | undefined,
    rejectPending: (error: Error) => void
  ): void {
    if (!pending) {
      return;
    }
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      rejectPending(new Error(`claude warm process emitted invalid JSON: ${line.slice(0, 120)}`));
      return;
    }
    const sessionIdFromEvent = this.findSessionId(event);
    pending.sessionId = sessionIdFromEvent ?? pending.sessionId ?? fallbackSessionId;
    this.reportSessionId(pending.onSessionId, pending.sessionId);
    pending.model = this.findModelId(event) ?? pending.model ?? participant.model;
    pending.usedTokens = this.findContextUsedTokens(event) ?? pending.usedTokens;
    pending.contextWindowTokens = this.findContextWindowTokens(event) ?? pending.contextWindowTokens;
    const streamError = this.claudeWarmStreamError(event);
    if (streamError) {
      rejectPending(new Error(streamError));
      return;
    }
    const toolSummary = this.claudeWarmToolSummary(event);
    if (toolSummary) {
      this.emitLiveOutput(pending.onOutput, "tool", `${toolSummary.label}\n`, undefined, {
        activityKind: toolSummary.kind,
        activityStatus: "started"
      });
    }
    if (this.claudeWarmTextBlockStarted(event) && pending.streamedText.trim()) {
      pending.nextTextBlockStartsBlock = true;
    }
    const streamDelta = this.extractClaudeStreamEventTextDelta(event);
    if (streamDelta) {
      if (pending.nextTextBlockStartsBlock) {
        pending.streamedText = this.textWithAgentMessageBoundary(pending.streamedText, streamDelta);
        pending.nextTextBlockStartsBlock = false;
      }
      pending.streamedText += streamDelta;
      this.emitLiveOutput(pending.onOutput, "text", streamDelta, pending.streamedText);
    }
    const assistantText = this.extractClaudeWarmAssistantText(event);
    if (assistantText) {
      pending.messages.push(assistantText);
    }
    if (!this.isClaudeWarmResult(event)) {
      return;
    }
    const current = cleanupPending();
    if (!current) {
      return;
    }
    const resultText = this.extractClaudeWarmResultText(event);
    const content = resultText ?? (
      current.messages.length > 0
        ? this.finalTextFromMessageItems(current.messages)
        : this.trailingTextBlock(current.streamedText)
    );
    const sessionId = this.findSessionId(event) ?? current.sessionId ?? fallbackSessionId;
    this.reportSessionId(current.onSessionId, sessionId);
    const contextUsage = buildAgentContextUsage({
      usedTokens: current.usedTokens,
      contextWindowTokens: current.contextWindowTokens ?? contextWindowForModel(participant.kind, current.model),
      source: "claude-code",
      model: current.model
    });
    const result: ParticipantRunResult = {
      participant,
      ok: true,
      content: content.trim(),
      durationMs: Date.now() - current.startedAt,
      sessionId,
      roleRuntime: options.role && !options.sessionId ? "claude-agent" : undefined,
      contextUsage
    };
    if (contextUsage || !sessionId) {
      current.resolve(result);
      return;
    }
    void this.extractClaudeSessionLogContextUsageWithRetry(sessionId, participant)
      .then((logUsage) => current.resolve({ ...result, contextUsage: logUsage }))
      .catch(() => current.resolve(result));
  }

  private claudeWarmUserMessage(prompt: string): Record<string, unknown> {
    return {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: prompt }]
      },
      parent_tool_use_id: null
    };
  }

  private isClaudeWarmResult(event: unknown): boolean {
    return this.stringField(this.asRecord(event) ?? {}, "type") === "result";
  }

  private claudeWarmStreamError(event: unknown): string | undefined {
    const record = this.asRecord(event);
    if (!record) {
      return undefined;
    }
    const type = this.stringField(record, "type");
    if (type === "error") {
      const error = record.error;
      if (typeof error === "string") {
        return error;
      }
      const errorRecord = this.asRecord(error);
      return this.stringField(errorRecord ?? {}, "message") ?? this.stringField(record, "message") ?? "claude warm process reported an error";
    }
    if (type === "result" && record.is_error === true) {
      return this.stringField(record, "result") ?? this.stringField(record, "error") ?? "claude warm process returned an error result";
    }
    return undefined;
  }

  private extractClaudeWarmResultText(event: unknown): string | undefined {
    const record = this.asRecord(event);
    if (!record) {
      return undefined;
    }
    return this.stringField(record, "result") ?? this.stringField(record, "content") ?? this.stringField(record, "message");
  }

  private extractClaudeStreamEventTextDelta(event: unknown): string | undefined {
    const record = this.asRecord(event);
    if (!record) {
      return undefined;
    }
    if (this.stringField(record, "type") !== "stream_event") {
      return undefined;
    }
    const inner = this.asRecord(record.event);
    if (!inner) {
      return undefined;
    }
    if (this.stringField(inner, "type") !== "content_block_delta") {
      return undefined;
    }
    const delta = this.asRecord(inner.delta);
    if (!delta) {
      return undefined;
    }
    if (this.stringField(delta, "type") !== "text_delta") {
      return undefined;
    }
    return this.stringField(delta, "text");
  }

  private extractClaudeWarmAssistantText(event: unknown): string | undefined {
    const record = this.asRecord(event);
    if (!record) {
      return undefined;
    }
    const type = this.stringField(record, "type");
    if (type !== "assistant") {
      return undefined;
    }
    const message = this.asRecord(record.message);
    if (message) {
      return this.textFromAssistantMessageItem(message);
    }
    return this.textFromAssistantMessageItem(record);
  }

  private enqueueWarmRun<T>(entry: WarmAgentEntry, task: () => Promise<T>): Promise<T> {
    const run = entry.queue.catch(() => undefined).then(task);
    entry.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private warmAgentKey(
    participant: ParticipantConfig,
    repoPath: string | undefined,
    kind: ConversationKind,
    options: CliAgentRunOptions
  ): string {
    return JSON.stringify({
      conversationId: options.warm?.conversationId,
      participantId: options.warm?.participantId,
      providerKind: participant.kind,
      model: participant.model ?? "",
      reasoningEffort: participant.reasoningEffort ?? "",
      repoPath: repoPath ?? "",
      kind,
      extraReadableDirs: this.normalizedExtraReadableDirs(options.extraReadableDirs),
      agentEnvKey: options.agentEnvKey ?? "",
      contextKey: options.warm?.contextKey ?? ""
    });
  }

  private warmAgentScopeKey(warm: CliAgentWarmOptions): string {
    return `${warm.conversationId}:${warm.participantId}`;
  }

  private async closeStaleWarmAgents(scopeKey: string, nextKey: string): Promise<void> {
    const stale = Array.from(this.warmAgents.values()).filter((entry) => entry.scopeKey === scopeKey && entry.key !== nextKey);
    for (const entry of stale) {
      this.warmAgents.delete(entry.key);
      await this.closeWarmAgent(entry, "context-changed");
    }
  }

  private scheduleWarmIdleTimer(entry: WarmAgentEntry, idleTimeoutMs: number): void {
    this.clearWarmIdleTimer(entry);
    entry.idleTimer = setTimeout(() => {
      this.warmAgents.delete(entry.key);
      void this.closeWarmAgent(entry, "idle-timeout");
    }, idleTimeoutMs);
    entry.idleTimer.unref();
  }

  private clearWarmIdleTimer(entry: WarmAgentEntry): void {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
  }

  private async closeWarmAgent(entry: WarmAgentEntry, reason: string): Promise<void> {
    if (entry.closed) {
      return;
    }
    entry.closed = true;
    this.clearWarmIdleTimer(entry);
    void this.writeDebugLog("cli-agent-warm-closed", {
      providerKind: entry.providerKind,
      reason
    });
    if (entry.process.exitCode !== null || entry.process.signalCode !== null || entry.process.killed) {
      return;
    }
    entry.process.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (entry.process.exitCode === null && entry.process.signalCode === null) {
          entry.process.kill("SIGKILL");
        }
        resolve();
      }, WARM_AGENT_KILL_GRACE_MS);
      timer.unref();
      entry.process.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private createLineHandler(onLine: (line: string) => void): (chunk: string) => void {
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

  private emitCodexLiveOutput(
    line: string,
    onOutput: CliAgentOutputCallback | undefined,
    deltaAccumulator?: { value: string },
    onSessionId?: CliAgentSessionIdCallback
  ): void {
    try {
      const event = JSON.parse(line) as unknown;
      this.reportSessionId(onSessionId, this.findSessionId(event));
      if (!onOutput) {
        return;
      }
      const delta = this.extractCodexAssistantStreamingDelta(event);
      if (delta && deltaAccumulator) {
        deltaAccumulator.value += delta;
        this.emitLiveOutput(onOutput, "text", delta, deltaAccumulator.value);
        return;
      }
      const completedMessage = this.extractCodexAssistantMessage(event);
      if (completedMessage && deltaAccumulator && !deltaAccumulator.value.trim()) {
        deltaAccumulator.value = completedMessage;
        this.emitLiveOutput(onOutput, "text", completedMessage, deltaAccumulator.value);
        return;
      }
      const toolSummary = this.codexToolSummary(event);
      if (toolSummary) {
        this.emitLiveOutput(onOutput, "tool", `${toolSummary.label}\n`, undefined, {
          activityKind: toolSummary.kind,
          activityStatus: "started"
        });
      }
    } catch {
      // Ignore non-JSON CLI output in the live chat panel; stderr/stdout diagnostics
      // are still captured by the final command result and debug logs.
    }
  }

  private reportSessionId(onSessionId: CliAgentSessionIdCallback | undefined, sessionId: string | undefined): void {
    const normalized = sessionId?.trim();
    if (!normalized) {
      return;
    }
    onSessionId?.(normalized);
  }

  private emitLiveOutput(
    onOutput: CliAgentOutputCallback | undefined,
    kind: CliAgentOutputKind,
    text: string,
    cumulative?: string,
    activity?: {
      activityKind?: ChatAgentActivityKind;
      activityStatus?: ChatAgentActivityEvent["status"];
      activityDetail?: string;
    }
  ): void {
    const clean = this.cleanLiveOutputText(text);
    if (!onOutput || !clean) {
      return;
    }
    const cleanCumulative = cumulative !== undefined ? this.cleanLiveOutputText(cumulative) : undefined;
    onOutput({ kind, text: clean, cumulative: cleanCumulative, ...activity });
  }

  private cleanLiveOutputText(text: string): string {
    return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
  }

  private codexToolSummary(event: unknown): { label: string; kind: ChatAgentActivityKind } | undefined {
    const record = this.asRecord(event);
    if (!record) {
      return undefined;
    }
    const method = this.stringField(record, "method");
    if (method === "item/autoApprovalReview/started") {
      return { label: "Auto-reviewing approval request", kind: "approval" };
    }
    if (method === "item/autoApprovalReview/completed") {
      return { label: "Auto-review completed", kind: "approval" };
    }
    const item = this.asRecord(record.item) ?? record;
    const type = `${this.stringField(record, "type") ?? ""} ${this.stringField(item, "type") ?? ""}`.toLowerCase();
    const name = this.stringField(item, "name") ?? this.stringField(item, "tool_name");
    const command = this.stringField(item, "command") ?? this.stringField(item, "cmd");
    if (command && /command|exec|shell|bash/.test(type)) {
      return { label: "Running command", kind: "command" };
    }
    if (name && /tool|function|call/.test(type)) {
      return { label: this.toolActivityLabel(name), kind: "tool" };
    }
    if (/read|grep|glob|ls/.test(type) && name) {
      return { label: this.toolActivityLabel(name), kind: "tool" };
    }
    return undefined;
  }

  private toolActivityLabel(name: string): string {
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

  private claudeWarmTextBlockStarted(event: unknown): boolean {
    const record = this.asRecord(event);
    if (!record || this.stringField(record, "type") !== "stream_event") {
      return false;
    }
    const inner = this.asRecord(record.event);
    if (!inner || this.stringField(inner, "type") !== "content_block_start") {
      return false;
    }
    const block = this.asRecord(inner.content_block);
    return this.stringField(block ?? {}, "type") === "text";
  }

  private claudeWarmToolSummary(event: unknown): { label: string; kind: ChatAgentActivityKind } | undefined {
    const record = this.asRecord(event);
    if (!record) {
      return undefined;
    }
    const message = this.asRecord(record.message) ?? record;
    const content = message.content;
    if (!Array.isArray(content)) {
      return undefined;
    }
    for (const block of content) {
      const blockRecord = this.asRecord(block);
      if (!blockRecord || this.stringField(blockRecord, "type") !== "tool_use") {
        continue;
      }
      const name = this.stringField(blockRecord, "name");
      if (name) {
        return { label: this.toolActivityLabel(name), kind: this.claudeActivityKindForTool(name) };
      }
    }
    return undefined;
  }

  private claudeActivityKindForTool(name: string): ChatAgentActivityKind {
    const normalized = name.toLowerCase();
    if (normalized === "bash") {
      return "command";
    }
    if (normalized === "websearch" || normalized === "webfetch") {
      return "web";
    }
    if (["edit", "write", "multiedit", "notebookedit"].includes(normalized)) {
      return "file-edit";
    }
    return "tool";
  }

  private withoutWarm(options: CliAgentRunOptions): CliAgentRunOptions {
    const { warm: _warm, ...next } = options;
    return next;
  }

  private appMcpEnv(options: CliAgentRunOptions): NodeJS.ProcessEnv | undefined {
    if (!options.appMcp) {
      return undefined;
    }
    return {
      [CODEX_APP_SERVER_MCP_TOKEN_ENV]: options.appMcp.token
    };
  }

  private agentRunEnv(options: CliAgentRunOptions): NodeJS.ProcessEnv | undefined {
    const manualEnv = filterAllowedAgentEnvironment(options.agentEnv);
    const appMcpEnv = this.appMcpEnv(options);
    if (Object.keys(manualEnv).length === 0 && !appMcpEnv) {
      return undefined;
    }
    return {
      ...manualEnv,
      ...(appMcpEnv ?? {})
    };
  }

  private withAppMcpClientStatus(
    result: ParticipantRunResult,
    participant: ParticipantConfig,
    options: CliAgentRunOptions
  ): ParticipantRunResult {
    const warning = this.appMcpClientWarning(participant, options);
    if (!warning) {
      return result;
    }
    return {
      ...result,
      appMcpClientFailed: true,
      warnings: [
        ...(result.warnings ?? []),
        warning
      ]
    };
  }

  private appMcpClientWarning(participant: ParticipantConfig, options: CliAgentRunOptions): string | undefined {
    const appMcp = options.appMcp;
    if (!appMcp?.clientGenerationId || !appMcp.clientStatus) {
      return undefined;
    }
    const status = appMcp.clientStatus(appMcp.clientGenerationId);
    if (!status) {
      return `${participant.label}: app tools did not load for this run; the AccordAgents MCP bridge may be unreachable or stale.`;
    }
    if (status.errored) {
      return `${participant.label}: app tools reported an MCP connection error; the AccordAgents MCP bridge will be refreshed.`;
    }
    if (!status.initialized || !status.listedTools) {
      return `${participant.label}: app tools did not finish MCP setup; the AccordAgents MCP bridge may be unreachable or stale.`;
    }
    if (!status.requiredToolsPresent) {
      const missing = status.missingToolNames.slice(0, 3).join(", ");
      return `${participant.label}: app tools loaded without required tools${missing ? ` (${missing})` : ""}; the AccordAgents MCP bridge will be refreshed.`;
    }
    return undefined;
  }

  private shouldPassClaudeAllowedTools(kind: ConversationKind, options: CliAgentRunOptions): boolean {
    return !(kind === "chat" && this.agentModeForRun(kind, options) === "auto");
  }

  private claudeAllowedToolsArgs(kind: ConversationKind, options: CliAgentRunOptions, toolConfig: ClaudeToolConfig): string[] {
    return this.shouldPassClaudeAllowedTools(kind, options) && toolConfig.allowedTools.length > 0
      ? ["--allowedTools", toolConfig.allowedTools.join(",")]
      : [];
  }

  private claudeMcpArgs(kind: ConversationKind, options: CliAgentRunOptions): string[] {
    if (!options.appMcp) {
      return [];
    }
    return kind === "chat"
      ? ["--mcp-config", this.claudeMcpConfigJson(options.appMcp)]
      : ["--mcp-config", this.claudeMcpConfigJson(options.appMcp), "--strict-mcp-config"];
  }

  private claudePermissionPromptArgs(kind: ConversationKind, options: CliAgentRunOptions): string[] {
    const permissionPromptTool = this.claudePermissionPromptTool(kind, options);
    return permissionPromptTool ? ["--permission-prompt-tool", permissionPromptTool] : [];
  }

  private claudePermissionPromptTool(kind: ConversationKind, options: CliAgentRunOptions): string | undefined {
    if (
      kind !== "chat" ||
      this.agentModeForRun(kind, options) !== "default" ||
      !options.appMcp?.toolNames.includes(APP_TOOL_PERMISSION_TOOL)
    ) {
      return undefined;
    }
    return APP_TOOL_PERMISSION_MCP_TOOL;
  }

  private claudeToolsArgs(kind: ConversationKind, toolConfig: ClaudeToolConfig, options: CliAgentRunOptions): string[] {
    if (kind === "chat") {
      return [];
    }
    const tools = this.claudeToolsWithAppMcp(toolConfig.tools, options);
    return ["--tools", tools.length > 0 ? tools.join(",") : ""];
  }

  private claudeToolsWithAppMcp(tools: string[], options: CliAgentRunOptions): string[] {
    const next = new Set(tools);
    for (const toolName of options.appMcp?.toolNames ?? []) {
      next.add(`mcp__accord_agents__${toolName}`);
    }
    return Array.from(next);
  }

  private claudeMcpConfigJson(appMcp: CliAgentAppMcpOptions): string {
    return JSON.stringify({
      mcpServers: {
        accord_agents: {
          type: "http",
          url: appMcp.url,
          headers: {
            Authorization: `Bearer ${appMcp.token}`
          }
        }
      }
    });
  }

  private logWarmUnsupportedOnce(providerKind: ParticipantConfig["kind"], reason: string): void {
    if (this.warmUnsupportedLogged.has(providerKind)) {
      return;
    }
    this.warmUnsupportedLogged.add(providerKind);
    void this.writeDebugLog("cli-agent-warm-unsupported", { providerKind, reason });
  }

  private async writeDebugLog(event: string, payload: Record<string, unknown>): Promise<void> {
    await this.debugLogs?.write(event, payload);
  }

  private agentModeForRun(kind: ConversationKind, options: CliAgentRunOptions): ChatAgentMode {
    return kind === "chat" ? normalizeChatAgentMode(options.agentMode) : "plan";
  }

  private permissionsForRun(
    providerKind: ChatProviderKind | undefined,
    mode: ChatAgentMode,
    options: CliAgentRunOptions
  ): ChatAgentPermissions {
    return effectiveChatAgentPermissionsForProvider(providerKind, mode, normalizeChatAgentPermissions(options.permissions));
  }

  private claudePermissionMode(kind: ConversationKind, options: CliAgentRunOptions): ClaudePermissionMode {
    const agentMode = this.agentModeForRun(kind, options);
    if (agentMode === "plan") {
      return "plan";
    }
    if (agentMode === "auto") {
      // Native Claude auto mode: a classifier auto-approves safe tool calls (incl. Bash)
      // and blocks dangerous ones without prompting — the headless-friendly analog of
      // Codex Auto-review. If the installed CLI lacks it, runClaudeOneShot fails the run
      // loudly with an upgrade message rather than silently running a different mode.
      return "auto";
    }
    const permissions = this.permissionsForRun("claude-code", agentMode, options);
    return permissions.workspaceWrite ? "acceptEdits" : "default";
  }

  private claudeToolConfig(
    kind: ConversationKind,
    repoPath: string | undefined,
    extraReadableDirs: string[],
    options: CliAgentRunOptions
  ): ClaudeToolConfig {
    const agentMode = this.agentModeForRun(kind, options);
    const permissionMode = this.claudePermissionMode(kind, options);
    const permissions = this.permissionsForRun("claude-code", agentMode, options);
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
    } else {
      disallowedTools.push(...webTools);
    }
    if (permissions.workspaceWrite) {
      for (const tool of editTools) {
        tools.add(tool);
      }
    } else {
      disallowedTools.push(...editTools);
    }
    if (permissions.shell.enabled) {
      tools.add("Bash");
      for (const rule of permissions.shell.rules) {
        const toolRule = this.claudeBashPermissionRule(rule);
        if (rule.action === "deny") {
          disallowedTools.push(toolRule);
        } else if (agentMode !== "auto") {
          // In Auto-review the native auto classifier owns allow/ask decisions, so only
          // deny rules are forwarded as hard stops. Outside auto, honor allow/ask too.
          if (rule.action === "allow") {
            allowedTools.push(toolRule);
          } else {
            askTools.push(toolRule);
          }
        }
      }
    } else {
      disallowedTools.push("Bash");
    }
    for (const toolRule of providerNativeAllowedTools) {
      allowedTools.push(toolRule);
      const toolName = this.claudeToolNameFromAllowedTool(toolRule);
      if (toolName) {
        tools.add(toolName);
      }
    }
    for (const toolName of options.appMcp?.toolNames ?? []) {
      allowedTools.push(`mcp__accord_agents__${toolName}`);
    }
    // Claude's native Skill tool is read-only skill discovery/loading. It must be present even
    // when no slash skill was selected so participants can truthfully inspect available skills.
    tools.add("Skill");
    allowedTools.push("Skill");
    // Always-on subagent spawning for Claude participants. The subagent tool is registered as
    // "Agent" in current Claude Code (params prompt/subagent_type); "Task" is the older name and
    // is listed too for version robustness — unknown tool names are ignored by the CLI. Subagents
    // inherit this run's permissions and are separate from chat participant requests.
    for (const subagentTool of ["Agent", "Task"]) {
      tools.add(subagentTool);
      allowedTools.push(subagentTool);
    }
    const disallowedToolSet = new Set(disallowedTools);
    for (const toolRule of providerNativeAllowedTools) {
      const toolName = this.claudeToolNameFromAllowedTool(toolRule);
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

  private claudeToolNameFromAllowedTool(toolRule: string): string | undefined {
    const trimmed = toolRule.trim();
    if (!trimmed) {
      return undefined;
    }
    const parenIndex = trimmed.indexOf("(");
    return parenIndex > 0 ? trimmed.slice(0, parenIndex) : trimmed;
  }

  private claudeBashPermissionRule(rule: ChatShellPermissionRule): string {
    const pattern = rule.pattern.trim();
    return rule.match === "prefix" ? `Bash(${pattern}:*)` : `Bash(${pattern})`;
  }

  private canRequestPermissionChanges(options: CliAgentRunOptions): boolean {
    return Boolean(options.appMcp?.toolNames.includes(APP_PERMISSIONS_REQUEST_CHANGE_TOOL));
  }

  private codexPrompt(
    prompt: string,
    repoPath: string | undefined,
    diffMode: GitDiffMode | undefined,
    kind: ConversationKind,
    options: CliAgentRunOptions = {}
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
      const mode = this.agentModeForRun(kind, options);
      const readContextAvailable = Boolean(repoPath) || this.normalizedExtraReadableDirs(options.extraReadableDirs).length > 0;
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

  private repoPathForRun(repoPath: string | undefined, diffMode: GitDiffMode | undefined, kind: ConversationKind): string | undefined {
    if (!repoPath) {
      return undefined;
    }
    return kind === "code-review" || kind === "implementation-plan" || kind === "chat" || Boolean(diffMode) ? repoPath : undefined;
  }

  private normalizedExtraReadableDirs(dirs: string[] | undefined): string[] {
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

  private insertCodexOptionBeforePrompt(args: string[], resuming: boolean, ...items: string[]): void {
    const promptIndex = resuming ? Math.max(args.length - 2, 2) : Math.max(args.length - 1, 1);
    args.splice(promptIndex, 0, ...items);
  }

  private tomlString(value: string): string {
    return JSON.stringify(value);
  }

  private claudeAgentsJson(role: CliAgentRoleOptions): string {
    return JSON.stringify({
      [role.name]: {
        description: role.description,
        prompt: role.instructions
      }
    });
  }

  private isCodexDeveloperInstructionsUnsupported(error: unknown): boolean {
    const message = this.errorText(error).toLowerCase();
    return (
      message.includes("developer_instructions") &&
      /unknown|invalid|unrecognized|unsupported|unexpected|failed to parse|configuration|config/.test(message)
    );
  }

  private isClaudeAgentFlagUnsupported(error: unknown): boolean {
    const message = this.errorText(error).toLowerCase();
    return (
      /(?:unknown|unrecognized|invalid|unsupported).{0,80}--agents?/.test(message) ||
      /--agents?.{0,80}(?:unknown|unrecognized|invalid|unsupported)/.test(message)
    );
  }

  private isClaudePermissionModeUnsupported(error: unknown): boolean {
    // Heuristic: older Claude CLIs without the `auto` permission mode reject the flag
    // value. Match errors that name permission-mode alongside an invalid/unknown/choices
    // hint, or an invalid `auto` value near "permission".
    const message = this.errorText(error).toLowerCase();
    return (
      /(?:unknown|unrecognized|invalid|unsupported|choices|must be|expected).{0,80}permission-mode/.test(message) ||
      /permission-mode.{0,80}(?:unknown|unrecognized|invalid|unsupported|choices|must be|expected)/.test(message) ||
      /invalid.{0,40}\bauto\b.{0,40}permission/.test(message)
    );
  }

  private extractCodexContextUsage(stdout: string, participant: ParticipantConfig): AgentContextUsage | undefined {
    let latest: AgentContextUsage | undefined;
    let model = participant.model;
    let usedTokens: number | undefined;
    let contextWindowTokens: number | undefined;
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const event = JSON.parse(line) as unknown;
        model = this.findModelId(event) ?? model;
        usedTokens = this.findContextUsedTokens(event) ?? usedTokens;
        contextWindowTokens = this.findContextWindowTokens(event) ?? contextWindowTokens;
        const usage = buildAgentContextUsage({
          usedTokens,
          contextWindowTokens: contextWindowTokens ?? contextWindowForModel(participant.kind, model),
          source: "codex-cli",
          model
        });
        if (usage) {
          latest = usage;
        }
      } catch {
        // Non-JSON output cannot carry structured usage.
      }
    }
    return latest;
  }

  private extractClaudeContextUsage(stdout: string, participant: ParticipantConfig): AgentContextUsage | undefined {
    try {
      return this.agentContextUsageFromEvent(JSON.parse(stdout) as unknown, participant, "claude-code");
    } catch {
      return undefined;
    }
  }

  private async extractCodexSessionLogContextUsageWithRetry(
    sessionId: string | undefined,
    participant: ParticipantConfig
  ): Promise<AgentContextUsage | undefined> {
    if (!sessionId) {
      return undefined;
    }
    for (let attempt = 0; attempt < SESSION_LOG_RETRIES; attempt += 1) {
      const usage = await this.extractCodexSessionLogContextUsage(sessionId, participant);
      if (usage || attempt === SESSION_LOG_RETRIES - 1) {
        return usage;
      }
      await this.delay(SESSION_LOG_RETRY_MS);
    }
    return undefined;
  }

  private async extractCodexSessionLogContextUsage(
    sessionId: string,
    participant: ParticipantConfig
  ): Promise<AgentContextUsage | undefined> {
    const filePath = await this.findCodexSessionLogPath(sessionId);
    if (!filePath) {
      return undefined;
    }
    return this.extractCodexContextUsage(await this.readOptionalFile(filePath), participant);
  }

  private async extractClaudeSessionLogContextUsageWithRetry(
    sessionId: string | undefined,
    participant: ParticipantConfig
  ): Promise<AgentContextUsage | undefined> {
    if (!sessionId) {
      return undefined;
    }
    for (let attempt = 0; attempt < SESSION_LOG_RETRIES; attempt += 1) {
      const usage = await this.extractClaudeSessionLogContextUsage(sessionId, participant);
      if (usage || attempt === SESSION_LOG_RETRIES - 1) {
        return usage;
      }
      await this.delay(SESSION_LOG_RETRY_MS);
    }
    return undefined;
  }

  private async extractClaudeSessionLogContextUsage(
    sessionId: string,
    participant: ParticipantConfig
  ): Promise<AgentContextUsage | undefined> {
    const filePath = await this.findClaudeSessionLogPath(sessionId);
    if (!filePath) {
      return undefined;
    }
    const content = await this.readOptionalFile(filePath);
    let latest: AgentContextUsage | undefined;
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const event = JSON.parse(line) as unknown;
        // A compaction boundary resets the conversation: usage recorded before it
        // is stale (pre-compact). Discard anything seen so far so we never report
        // the old, larger context after a /compact.
        if (this.isClaudeCompactBoundary(event)) {
          latest = undefined;
          continue;
        }
        const usage = this.agentContextUsageFromEvent(event, participant, "claude-code");
        if (usage) {
          latest = usage;
        }
      } catch {
        // Ignore partial or diagnostic lines in Claude's local session log.
      }
    }
    return latest;
  }

  private isClaudeCompactBoundary(event: unknown): boolean {
    const record = this.asRecord(event);
    if (!record) {
      return false;
    }
    return this.stringField(record, "subtype") === "compact_boundary" || record.isCompactSummary === true;
  }

  private async findClaudeSessionLogPath(sessionId: string): Promise<string | undefined> {
    return this.findFileByName(path.join(homedir(), ".claude", "projects"), `${sessionId}.jsonl`, 5);
  }

  private async findCodexSessionLogPath(sessionId: string): Promise<string | undefined> {
    return this.findFileByNameMatch(
      path.join(homedir(), ".codex", "sessions"),
      (fileName) => fileName.endsWith(".jsonl") && fileName.includes(sessionId),
      6
    );
  }

  private async findFileByName(
    directoryPath: string,
    fileName: string,
    maxDepth: number
  ): Promise<string | undefined> {
    return this.findFileByNameMatch(directoryPath, (name) => name === fileName, maxDepth);
  }

  private async findFileByNameMatch(
    directoryPath: string,
    matchesFileName: (fileName: string) => boolean,
    maxDepth: number
  ): Promise<string | undefined> {
    let entries: Dirent[];
    try {
      entries = await readdir(directoryPath, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isFile() && matchesFileName(entry.name)) {
        return entryPath;
      }
    }
    if (maxDepth <= 0) {
      return undefined;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const found = await this.findFileByNameMatch(path.join(directoryPath, entry.name), matchesFileName, maxDepth - 1);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  private async delay(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref();
    });
  }

  private agentContextUsageFromEvent(
    event: unknown,
    participant: ParticipantConfig,
    source: AgentContextUsageSource
  ): AgentContextUsage | undefined {
    const model = this.findModelId(event) ?? participant.model;
    return buildAgentContextUsage({
      usedTokens: this.findContextUsedTokens(event),
      contextWindowTokens: this.findContextWindowTokens(event) ?? contextWindowForModel(participant.kind, model),
      source,
      model
    });
  }

  private findContextUsedTokens(value: unknown): number | undefined {
    const explicit = this.findNumberField(value, [
      "context_window_used_tokens",
      "contextWindowUsedTokens",
      "context_used_tokens",
      "contextUsedTokens",
      "context_tokens",
      "contextTokens",
      "used_tokens",
      "usedTokens"
    ]);
    if (explicit) {
      return explicit;
    }
    // Codex reports per-turn usage nested as last_token_usage / tokenUsage.last.
    // The current context occupancy is the most recent turn's total tokens, which
    // is what Codex itself shows as "context left" and what drops after a compact.
    const lastTurn = this.findCodexLastTurnUsedTokens(value);
    if (lastTurn) {
      return lastTurn;
    }
    const usage = this.findUsageRecord(value);
    if (usage) {
      const fromUsage = this.inputTokensFromUsage(usage) ?? this.numberField(usage, "total_tokens") ?? this.numberField(usage, "totalTokens");
      if (fromUsage) {
        return fromUsage;
      }
    }
    return this.findNumberField(value, ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens"]);
  }

  private findCodexLastTurnUsedTokens(value: unknown): number | undefined {
    const last = this.findCodexLastTurnRecord(value);
    if (!last) {
      return undefined;
    }
    return (
      this.numberField(last, "total_tokens") ??
      this.numberField(last, "totalTokens") ??
      this.numberField(last, "input_tokens") ??
      this.numberField(last, "inputTokens")
    );
  }

  private findCodexLastTurnRecord(value: unknown): Record<string, unknown> | undefined {
    // Rollout log shape: { ...: { last_token_usage: { total_tokens, ... } } }
    const direct = this.findRecordByKey(value, ["last_token_usage", "lastTokenUsage"]);
    if (direct) {
      return direct;
    }
    // app-server event shape: { params: { tokenUsage: { last: { totalTokens, ... } } } }
    const container = this.findRecordByKey(value, ["tokenUsage", "token_usage"]);
    if (container) {
      const last = this.asRecord(container.last) ?? this.asRecord(container.last_token_usage) ?? this.asRecord(container.lastTokenUsage);
      if (last) {
        return last;
      }
    }
    return undefined;
  }

  private findRecordByKey(value: unknown, keys: string[]): Record<string, unknown> | undefined {
    const wanted = new Set(keys);
    const stack: unknown[] = [value];
    while (stack.length) {
      const current = stack.pop();
      if (Array.isArray(current)) {
        stack.push(...current);
        continue;
      }
      const record = this.asRecord(current);
      if (!record) {
        continue;
      }
      for (const key of wanted) {
        const child = this.asRecord(record[key]);
        if (child) {
          return child;
        }
      }
      stack.push(...Object.values(record).filter((nested) => nested && typeof nested === "object"));
    }
    return undefined;
  }

  private findContextWindowTokens(value: unknown): number | undefined {
    return this.findNumberField(value, [
      "model_context_window",
      "modelContextWindow",
      "context_window_tokens",
      "contextWindowTokens",
      "context_window",
      "contextWindow",
      "max_context_tokens",
      "maxContextTokens"
    ]);
  }

  private findModelId(value: unknown): string | undefined {
    return this.findStringField(value, ["model", "model_id", "modelId", "resolved_model", "resolvedModel"]);
  }

  private inputTokensFromUsage(usage: Record<string, unknown>): number | undefined {
    const inputTokens = this.numberField(usage, "input_tokens") ?? this.numberField(usage, "inputTokens");
    const promptTokens = this.numberField(usage, "prompt_tokens") ?? this.numberField(usage, "promptTokens");
    const anthropicCacheTokens =
      (this.numberField(usage, "cache_creation_input_tokens") ?? this.numberField(usage, "cacheCreationInputTokens") ?? 0) +
      (this.numberField(usage, "cache_read_input_tokens") ?? this.numberField(usage, "cacheReadInputTokens") ?? 0);
    if (inputTokens || anthropicCacheTokens > 0) {
      return (inputTokens ?? 0) + anthropicCacheTokens;
    }
    return promptTokens;
  }

  private findUsageRecord(value: unknown): Record<string, unknown> | undefined {
    const stack: unknown[] = [value];
    while (stack.length) {
      const current = stack.pop();
      if (Array.isArray(current)) {
        stack.push(...current);
        continue;
      }
      const record = this.asRecord(current);
      if (!record) {
        continue;
      }
      const usage = this.asRecord(record.usage) ?? this.asRecord(record.token_usage) ?? this.asRecord(record.tokenUsage);
      if (usage) {
        return usage;
      }
      stack.push(...Object.values(record).filter((nested) => nested && typeof nested === "object"));
    }
    return undefined;
  }

  private findNumberField(value: unknown, keys: string[]): number | undefined {
    const stack: unknown[] = [value];
    const wanted = new Set(keys);
    while (stack.length) {
      const current = stack.pop();
      if (Array.isArray(current)) {
        stack.push(...current);
        continue;
      }
      const record = this.asRecord(current);
      if (!record) {
        continue;
      }
      for (const key of wanted) {
        const number = this.numberField(record, key);
        if (number) {
          return number;
        }
      }
      stack.push(...Object.values(record).filter((nested) => nested && typeof nested === "object"));
    }
    return undefined;
  }

  private findStringField(value: unknown, keys: string[]): string | undefined {
    const stack: unknown[] = [value];
    const wanted = new Set(keys);
    while (stack.length) {
      const current = stack.pop();
      if (Array.isArray(current)) {
        stack.push(...current);
        continue;
      }
      const record = this.asRecord(current);
      if (!record) {
        continue;
      }
      for (const key of wanted) {
        const text = this.stringField(record, key);
        if (text?.trim()) {
          return text.trim();
        }
      }
      stack.push(...Object.values(record).filter((nested) => nested && typeof nested === "object"));
    }
    return undefined;
  }

  private extractCodexText(stdout: string): string {
    const messages: string[] = [];
    const deltas: string[] = [];
    const plainLines: string[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const event = JSON.parse(line) as unknown;
        const message = this.extractCodexAssistantMessage(event);
        if (message) {
          messages.push(message);
        }
        const delta = this.extractCodexAssistantDelta(event);
        if (delta) {
          deltas.push(delta);
        }
      } catch {
        plainLines.push(line.trim());
      }
    }
    return messages.at(-1) ?? (deltas.join("").trim() || plainLines.join("\n").trim() || stdout.trim());
  }

  private extractClaudeText(stdout: string): string {
    try {
      const parsed = JSON.parse(stdout) as { result?: string; content?: string; message?: string };
      return parsed.result ?? parsed.content ?? parsed.message ?? stdout.trim();
    } catch {
      return stdout.trim();
    }
  }

  private extractClaudeSessionId(stdout: string): string | undefined {
    try {
      const parsed = JSON.parse(stdout) as { session_id?: string; sessionId?: string };
      return this.uuidText(parsed.session_id) ?? this.uuidText(parsed.sessionId);
    } catch {
      return undefined;
    }
  }

  private extractCodexSessionId(stdout: string): string | undefined {
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const event = JSON.parse(line) as unknown;
        const sessionId = this.findSessionId(event);
        if (sessionId) {
          return sessionId;
        }
      } catch {
        // Ignore non-JSON status lines from the CLI.
      }
    }
    return undefined;
  }

  private async readOptionalFile(filePath: string): Promise<string> {
    try {
      return await readFile(filePath, "utf8");
    } catch {
      return "";
    }
  }

  private extractCodexAssistantMessage(event: unknown): string | undefined {
    const record = this.asRecord(event);
    if (!record) {
      return undefined;
    }

    const type = this.stringField(record, "type");
    if (type === "agent_message") {
      return this.stringField(record, "message")?.trim();
    }

    const item = this.asRecord(record.item);
    if (item) {
      return this.textFromAssistantMessageItem(item);
    }

    return this.textFromAssistantMessageItem(record);
  }

  private extractCodexAssistantDelta(event: unknown): string | undefined {
    const record = this.asRecord(event);
    if (!record) {
      return undefined;
    }
    const type = this.stringField(record, "type") ?? "";
    if (!type.includes("output_text") && type !== "agent_message_delta") {
      return undefined;
    }
    return this.stringField(record, "delta") ?? this.stringField(record, "text") ?? this.stringField(record, "message");
  }

  private extractCodexAssistantStreamingDelta(event: unknown): string | undefined {
    const record = this.asRecord(event);
    if (!record) {
      return undefined;
    }
    const type = this.stringField(record, "type");
    if (type !== "agent_message_delta" && type !== "response.output_text.delta") {
      return undefined;
    }
    return this.stringField(record, "delta");
  }

  private textFromAssistantMessageItem(item: Record<string, unknown>): string | undefined {
    const itemType = this.stringField(item, "type");
    const role = this.stringField(item, "role");
    if (itemType !== "message" && itemType !== "assistant_message" && itemType !== "agent_message" && role !== "assistant") {
      return undefined;
    }
    if (role && role !== "assistant") {
      return undefined;
    }

    const directText = this.stringField(item, "message") ?? this.stringField(item, "text") ?? this.stringField(item, "output_text");
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
        const blockRecord = this.asRecord(block);
        if (!blockRecord) {
          return "";
        }
        return this.stringField(blockRecord, "text") ?? this.stringField(blockRecord, "output_text") ?? "";
      })
      .filter((text) => text.trim());

    return texts.length ? texts.join("\n").trim() : undefined;
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  }

  private stringField(record: Record<string, unknown>, key: string): string | undefined {
    const value = record[key];
    return typeof value === "string" ? value : undefined;
  }

  private numberField(record: Record<string, unknown>, key: string): number | undefined {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return Math.floor(value);
    }
    if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())) {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
    }
    return undefined;
  }

  private findSessionId(value: unknown): string | undefined {
    const stack: unknown[] = [value];
    const preferredKeys = new Set(["session_id", "sessionId", "conversation_id", "conversationId", "thread_id", "threadId", "id"]);
    while (stack.length) {
      const current = stack.pop();
      if (Array.isArray(current)) {
        stack.push(...current);
        continue;
      }
      const record = this.asRecord(current);
      if (!record) {
        continue;
      }
      for (const key of preferredKeys) {
        const sessionId = this.uuidText(record[key]);
        if (sessionId) {
          return sessionId;
        }
      }
      const type = this.stringField(record, "type") ?? "";
      if (type.toLowerCase().includes("session")) {
        const sessionId = Object.values(record).map((nested) => this.uuidText(nested)).find(Boolean);
        if (sessionId) {
          return sessionId;
        }
      }
      stack.push(...Object.values(record).filter((nested) => nested && typeof nested === "object"));
    }
    return undefined;
  }

  private uuidText(value: unknown): string | undefined {
    if (typeof value !== "string") {
      return undefined;
    }
    const match = value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
    return match?.[0];
  }

  private isResumeMiss(error: unknown): boolean {
    const message = this.errorText(error).toLowerCase();
    return /resume|session|conversation|thread/.test(message) && /not found|missing|unknown|cannot|can't|no .*session|no .*found|does not exist/.test(message);
  }

  private failed(participant: ParticipantConfig, error: unknown, durationMs?: number): ParticipantRunResult {
    const message = this.errorText(error);
    return {
      participant,
      ok: false,
      content: this.visibleFailureText(participant, error, message),
      error: message,
      durationMs
    };
  }

  private failedCompact(participant: ParticipantConfig, error: unknown): CliAgentCompactResult {
    return {
      participant,
      ok: false,
      error: this.errorText(error)
    };
  }

  private visibleFailureText(participant: ParticipantConfig, error: unknown, diagnostic: string): string {
    return cliFailureNoticeText(diagnostic, {
      label: participant.label,
      defaultTimeoutMs: this.runTimeoutMs,
      forceTimeout: this.isTimeoutError(error, diagnostic)
    });
  }

  private isTimeoutError(error: unknown, diagnostic: string): boolean {
    return (
      (error instanceof CommandError && error.result.timedOut) ||
      /\btimed out after \d+ms\b/i.test(diagnostic)
    );
  }

  private errorText(error: unknown): string {
    if (error instanceof CommandError) {
      return this.commandErrorText(error);
    }
    return this.truncateText(error instanceof Error ? error.message : String(error), MAX_CLI_ERROR_CHARS);
  }

  private commandErrorText(error: CommandError): string {
    const base = error.message.trim();
    const stderr = this.cleanCommandOutput(error.result.stderr);
    if (stderr) {
      return this.truncateText(`${base}: ${stderr}`, MAX_CLI_ERROR_CHARS);
    }

    const structuredSummary = this.summarizeStructuredOutput(error.result.stdout);
    if (structuredSummary) {
      return this.truncateText(`${base}. ${structuredSummary}`, MAX_CLI_ERROR_CHARS);
    }

    const stdout = this.cleanCommandOutput(error.result.stdout);
    if (stdout) {
      return this.truncateText(`${base}. Output: ${stdout}`, MAX_CLI_ERROR_CHARS);
    }

    return base;
  }

  private summarizeStructuredOutput(stdout: string): string | undefined {
    const summaries: string[] = [];
    let sawStructuredOutput = false;

    for (const line of stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) {
        continue;
      }
      try {
        const summary = this.summarizeStructuredEvent(JSON.parse(trimmed));
        sawStructuredOutput = true;
        if (summary) {
          summaries.push(summary);
          if (summaries.length > MAX_CLI_EVENT_SUMMARIES) {
            summaries.shift();
          }
        }
      } catch {
        // Non-JSON stdout is handled by cleanCommandOutput.
      }
    }

    if (summaries.length > 0) {
      return `No stderr was reported; CLI stdout contained structured events only. Last events: ${summaries.join(" | ")}.`;
    }
    if (sawStructuredOutput) {
      return "No stderr was reported. CLI stdout only contained structured events.";
    }
    return undefined;
  }

  private summarizeStructuredEvent(event: unknown): string | undefined {
    const record = this.asRecord(event);
    if (!record) {
      return undefined;
    }

    const type = this.stringField(record, "type") ?? "event";
    const message =
      this.stringField(record, "message") ??
      this.stringField(record, "error") ??
      (record.is_error === true
        ? this.stringField(record, "result") ?? this.stringField(record, "content")
        : undefined);
    if (message) {
      return `${type}: ${this.truncateText(message, 90)}`;
    }

    const item = this.asRecord(record.item);
    if (item) {
      const itemType = this.stringField(item, "type") ?? "item";
      const status = this.stringField(item, "status");
      const command = this.stringField(item, "command");
      const exitCode = typeof item.exit_code === "number" ? ` exit ${item.exit_code}` : "";
      const statusText = status ? ` ${status}` : "";
      if (command) {
        return `${type}/${itemType}${statusText}${exitCode}: ${this.truncateText(command, 90)}`;
      }
      return `${type}/${itemType}${statusText}${exitCode}`;
    }

    const threadId = this.stringField(record, "thread_id");
    if (threadId) {
      return `${type}: ${threadId}`;
    }
    return type;
  }

  private cleanCommandOutput(output: string): string {
    const lines = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) {
      return "";
    }
    const selected = lines.slice(0, MAX_CLI_ERROR_LINES);
    if (lines.length > selected.length) {
      selected.push(`[${lines.length - selected.length} more output lines omitted]`);
    }
    return selected.join("\n");
  }

  private truncateText(text: string, maxChars: number): string {
    const trimmed = text.trim();
    if (trimmed.length <= maxChars) {
      return trimmed;
    }
    return `${trimmed.slice(0, maxChars).trimEnd()}... [truncated ${trimmed.length - maxChars} chars]`;
  }
}

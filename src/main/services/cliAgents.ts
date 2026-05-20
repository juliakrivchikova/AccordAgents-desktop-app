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
  ChatAgentMode,
  ChatAgentPermissions,
  ChatShellPermissionRule,
  ConversationKind,
  GitDiffMode,
  ParticipantConfig
} from "../../shared/types";
import { effectiveChatAgentPermissions, normalizeChatAgentMode, normalizeChatAgentPermissions } from "../../shared/agentPermissions";
import { buildAgentContextUsage, contextWindowForModel } from "../../shared/agentContext";
import { CommandError, commandExists, runCommand } from "./command";
import type { ParticipantRunResult } from "./providers";

const MAX_CLI_ERROR_CHARS = 500;
const MAX_CLI_ERROR_LINES = 8;
const MAX_CLI_EVENT_SUMMARIES = 2;
const CLI_AGENT_RUN_TIMEOUT_MS = 15 * 60_000;
const WARM_AGENT_KILL_GRACE_MS = 1500;
const SESSION_LOG_RETRY_MS = 80;
const SESSION_LOG_RETRIES = 4;
const CODEX_APP_SERVER_DISABLED_ENV = "AI_CONSENSUS_CODEX_APP_SERVER";
const CODEX_APP_SERVER_MCP_TOKEN_ENV = "AI_CONSENSUS_MCP_TOKEN";
const APP_PERMISSIONS_REQUEST_CHANGE_TOOL = "app_permissions_request_change";

export interface CliAgentRunOptions {
  persistSession?: boolean;
  sessionId?: string;
  extraReadableDirs?: string[];
  resumeFallbackPrompt?: string;
  role?: CliAgentRoleOptions;
  appMcp?: CliAgentAppMcpOptions;
  warm?: CliAgentWarmOptions;
  onOutput?: CliAgentOutputCallback;
  agentMode?: ChatAgentMode;
  permissions?: ChatAgentPermissions;
}

export type CliAgentOutputKind = "tool" | "text";

export interface CliAgentOutputEvent {
  kind: CliAgentOutputKind;
  text: string;
  cumulative?: string;
}

export type CliAgentOutputCallback = (event: CliAgentOutputEvent) => void;

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
}

interface CliAgentDebugLogger {
  write(event: string, payload: Record<string, unknown>): Promise<void>;
}

interface WarmAgentEntry {
  key: string;
  scopeKey: string;
  providerKind: ParticipantConfig["kind"];
  process: ChildProcessWithoutNullStreams;
  run: (prompt: string, signal?: AbortSignal, onOutput?: CliAgentOutputCallback) => Promise<ParticipantRunResult>;
  queue: Promise<void>;
  idleTimer?: NodeJS.Timeout;
  closed: boolean;
}

interface ClaudeWarmPendingTurn {
  startedAt: number;
  messages: string[];
  streamedText: string;
  sessionId?: string;
  model?: string;
  usedTokens?: number;
  contextWindowTokens?: number;
  timer: NodeJS.Timeout;
  abort?: () => void;
  onOutput?: CliAgentOutputCallback;
  resolve: (result: ParticipantRunResult) => void;
  reject: (error: Error) => void;
}

interface CodexAppServerPendingRequest {
  method: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

interface CodexAppServerPendingTurn {
  startedAt: number;
  threadId: string;
  turnId?: string;
  messages: string[];
  streamedText: string;
  finalMessage?: string;
  model?: string;
  contextUsage?: AgentContextUsage;
  timer: NodeJS.Timeout;
  abort?: () => void;
  onOutput?: CliAgentOutputCallback;
  resolve: (result: ParticipantRunResult) => void;
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

type ClaudePermissionMode = "default" | "plan" | "acceptEdits";

interface ClaudeToolConfig {
  permissionMode: ClaudePermissionMode;
  tools: string[];
  allowedTools: string[];
  disallowedTools: string[];
  askTools: string[];
}

export class CliAgentRunner {
  private readonly warmAgents = new Map<string, WarmAgentEntry>();
  private readonly warmUnsupportedLogged = new Set<ParticipantConfig["kind"]>();

  constructor(private readonly debugLogs?: CliAgentDebugLogger) {}

  async detectAgents(): Promise<AgentHealth[]> {
    const [codex, claude] = await Promise.all([this.detectCodex(), this.detectClaude()]);
    return [codex, claude];
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
        const result = await (entry as WarmAgentEntry).run(prompt, signal, options.onOutput);
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
      env: { ...process.env, ...this.appMcpEnv(options) },
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

    const initialize = async (): Promise<void> => {
      if (initialized) {
        return;
      }
      await sendRequest("initialize", {
        clientInfo: {
          name: "ai-consensus",
          title: "AI Consensus",
          version: "0.1.0"
        },
        capabilities: {
          experimentalApi: true,
          optOutNotificationMethods: []
        }
      });
      initialized = true;
    };

    const ensureThread = async (): Promise<string> => {
      await initialize();
      if (threadId && threadLoaded) {
        return threadId;
      }
      if (threadId) {
        if (options.sessionId && threadId === options.sessionId) {
          const result = await sendRequest("thread/resume", this.codexAppServerThreadResumeParams(options.sessionId, participant, repoPath, kind, options)) as CodexAppServerThreadStartResult;
          threadId = result.thread?.id ?? options.sessionId;
          activeModel = result.model ?? activeModel;
        }
        threadLoaded = true;
        return threadId;
      }
      const result = await sendRequest("thread/start", this.codexAppServerThreadStartParams(participant, repoPath, kind, options)) as CodexAppServerThreadStartResult;
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
      for (const pending of pendingRequests.values()) {
        pending.reject(error);
      }
      pendingRequests.clear();
    });
    child.on("error", (error) => {
      closed = true;
      rejectPendingTurn(error);
      for (const pending of pendingRequests.values()) {
        pending.reject(error);
      }
      pendingRequests.clear();
    });
    child.on("close", (exitCode) => {
      closed = true;
      const error = new Error(`codex app-server process exited${exitCode === null ? "" : ` with code ${exitCode}`}${stderr ? `: ${stderr}` : ""}`);
      rejectPendingTurn(error);
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
      run: async (turnPrompt: string, signal?: AbortSignal, onOutput?: CliAgentOutputCallback): Promise<ParticipantRunResult> => {
        const currentThreadId = await ensureThread();
        const startedAt = Date.now();
        const timer = setTimeout(() => {
          rejectPendingTurn(new Error(`codex app-server timed out after ${CLI_AGENT_RUN_TIMEOUT_MS}ms`));
        }, CLI_AGENT_RUN_TIMEOUT_MS);
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
          input: [
            {
              type: "text",
              text: this.codexPrompt(turnPrompt, repoPath, diffMode, kind, options),
              text_elements: []
            }
          ]
        }) as CodexAppServerTurnStartResult;
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
    const permissions = this.permissionsForRun(mode, options);
    return {
      model: participant.model ?? null,
      cwd: repoPath ?? null,
      approvalPolicy: this.codexAppServerApprovalPolicy(mode),
      approvalsReviewer: mode === "auto" ? "auto_review" : null,
      sandbox: permissions.workspaceWrite ? "workspace-write" : "read-only",
      config: this.codexAppServerConfig(permissions, options),
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
    const permissions = this.permissionsForRun(mode, options);
    return {
      threadId: sessionId,
      model: participant.model ?? null,
      cwd: repoPath ?? null,
      approvalPolicy: this.codexAppServerApprovalPolicy(mode),
      approvalsReviewer: mode === "auto" ? "auto_review" : null,
      sandbox: permissions.workspaceWrite ? "workspace-write" : "read-only",
      config: this.codexAppServerConfig(permissions, options),
      developerInstructions: options.role?.instructions ?? null,
      excludeTurns: true,
      persistExtendedHistory: false
    };
  }

  private codexAppServerApprovalPolicy(mode: ChatAgentMode): string {
    return mode === "auto" ? "on-request" : "never";
  }

  private codexAppServerConfig(
    permissions: ChatAgentPermissions,
    options: CliAgentRunOptions
  ): Record<string, unknown> {
    const config: Record<string, unknown> = {
      web_search: permissions.webAccess ? "live" : "disabled"
    };
    if (options.appMcp) {
      config["mcp_servers.ai_consensus.url"] = options.appMcp.url;
      config["mcp_servers.ai_consensus.bearer_token_env_var"] = CODEX_APP_SERVER_MCP_TOKEN_ENV;
    }
    return config;
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
    if (method === "item/started") {
      const summary = this.codexAppServerToolSummary(this.asRecord(params.item));
      if (summary) {
        this.emitLiveOutput(pending.onOutput, "tool", `${summary}\n`);
      }
      return;
    }
    if (method === "item/agentMessage/delta") {
      const delta = this.stringField(params, "delta");
      if (delta) {
        pending.messages.push(delta);
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
    const content = (current.finalMessage ?? current.messages.join("")).trim();
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

  private codexAppServerToolSummary(item: Record<string, unknown> | undefined): string | undefined {
    if (!item) {
      return undefined;
    }
    const type = this.stringField(item, "type");
    if (type === "commandExecution") {
      return "Running command";
    }
    if (type === "mcpToolCall") {
      const tool = this.stringField(item, "tool");
      return tool ? this.toolActivityLabel(tool) : "Using MCP tool";
    }
    if (type === "dynamicToolCall") {
      const tool = this.stringField(item, "tool");
      return tool ? this.toolActivityLabel(tool) : "Using tool";
    }
    if (type === "webSearch") {
      return "Using web search";
    }
    if (type === "imageView") {
      return "Viewing image";
    }
    if (type === "fileChange") {
      return "Updating files";
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
      outputDir = await mkdtemp(path.join(tmpdir(), "ai-consensus-codex-"));
      const outputPath = path.join(outputDir, "last-message.txt");
      const resuming = Boolean(options.sessionId);
      const extraReadableDirs = this.normalizedExtraReadableDirs(options.extraReadableDirs);
      const mode = this.agentModeForRun(kind, options);
      const permissions = this.permissionsForRun(mode, options);
      const args = resuming
        ? [
            "exec",
            "resume",
            "--json",
            "--output-last-message",
            outputPath,
            options.sessionId as string,
            "-"
          ]
        : [
            "exec",
            "--sandbox",
            permissions.workspaceWrite ? "workspace-write" : "read-only",
            "--json",
            "--output-last-message",
            outputPath,
            "-"
          ];
      if (participant.model && !resuming) {
        args.splice(args.length - 1, 0, "--model", participant.model);
      }
      if (!resuming) {
        for (const dir of extraReadableDirs) {
          args.splice(args.length - 1, 0, "--add-dir", dir);
        }
      }
      if (repoPath && !resuming) {
        args.splice(1, 0, "--cd", repoPath);
        if (kind === "chat") {
          args.splice(1, 0, "--skip-git-repo-check");
        }
      } else if (!repoPath && !resuming) {
        // Session persistence is only useful when a repository is selected. For free-form runs,
        // keep Codex ephemeral so unrelated conversations do not bleed together.
        args.splice(1, 0, "--skip-git-repo-check", "--ephemeral", "--ignore-rules");
      } else if (!repoPath && resuming) {
        args.splice(2, 0, "--skip-git-repo-check");
      } else if (kind === "chat" && resuming) {
        args.splice(2, 0, "--skip-git-repo-check");
      }
      if (mode === "auto") {
        this.insertCodexOptionBeforePrompt(
          args,
          resuming,
          "-c",
          `approval_policy=${this.tomlString("on-request")}`,
          "-c",
          `approvals_reviewer=${this.tomlString("auto_review")}`
        );
      }
      if (options.role) {
        this.insertCodexOptionBeforePrompt(args, resuming, "-c", `developer_instructions=${this.tomlString(options.role.instructions)}`);
      }
      if (options.appMcp) {
        this.insertCodexOptionBeforePrompt(
          args,
          resuming,
          "-c",
          `mcp_servers.ai_consensus.url=${this.tomlString(options.appMcp.url)}`,
          "-c",
          `mcp_servers.ai_consensus.bearer_token_env_var=${this.tomlString("AI_CONSENSUS_MCP_TOKEN")}`
        );
      }
      if (permissions.webAccess) {
        args.unshift("--search");
      }
      const codexDeltaAccumulator = { value: "" };
      const stdoutLines = this.createLineHandler((line) => this.emitCodexLiveOutput(line, options.onOutput, codexDeltaAccumulator));
      const result = await runCommand("codex", args, {
        cwd: repoPath,
        input: this.codexPrompt(prompt, repoPath, diffMode, kind, options),
        timeoutMs: CLI_AGENT_RUN_TIMEOUT_MS,
        env: this.appMcpEnv(options),
        signal,
        onStdout: options.onOutput ? stdoutLines : undefined
      });
      const lastMessage = await this.readOptionalFile(outputPath);
      const sessionId = this.extractCodexSessionId(result.stdout) ?? options.sessionId;
      return {
        participant,
        ok: true,
        content: lastMessage.trim() || this.extractCodexText(result.stdout),
        durationMs: Date.now() - startedAt,
        sessionId,
        roleRuntime: options.role ? "codex-developer-instructions" : undefined,
        contextUsage:
          this.extractCodexContextUsage(result.stdout, participant) ??
          await this.extractCodexSessionLogContextUsageWithRetry(sessionId, participant)
      };
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
            appMcp: options.appMcp
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
          appMcp: options.appMcp
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
      if (toolConfig.allowedTools.length > 0) {
        args.push("--allowedTools", toolConfig.allowedTools.join(","));
      }
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
      if (options.role && !options.sessionId) {
        args.push("--agents", this.claudeAgentsJson(options.role), "--agent", options.role.name);
      }
      if (options.appMcp) {
        args.push("--mcp-config", this.claudeMcpConfigJson(options.appMcp), "--strict-mcp-config");
      }
      if (extraReadableDirs.length > 0) {
        args.push("--add-dir", ...extraReadableDirs);
      }
      const tools = this.claudeToolsWithAppMcp(toolConfig.tools, options);
      if (tools.length > 0) {
        args.push("--tools", tools.join(","));
      } else {
        args.push("--tools", "");
      }

      const result = await runCommand(
        "claude",
        args,
        {
          cwd: repoPath,
          input: prompt,
          timeoutMs: CLI_AGENT_RUN_TIMEOUT_MS,
          env: this.appMcpEnv(options),
          signal
        }
      );
      const sessionId = this.extractClaudeSessionId(result.stdout) ?? newSessionId ?? options.sessionId;
      return {
        participant,
        ok: true,
        content: this.extractClaudeText(result.stdout),
        durationMs: Date.now() - startedAt,
        sessionId,
        roleRuntime: options.role && !options.sessionId ? "claude-agent" : undefined,
        contextUsage:
          this.extractClaudeContextUsage(result.stdout, participant) ??
          await this.extractClaudeSessionLogContextUsageWithRetry(sessionId, participant)
      };
    } catch (error) {
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
            appMcp: options.appMcp
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
          appMcp: options.appMcp
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
        const result = await (entry as WarmAgentEntry).run(prompt, signal, options.onOutput);
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
    if (toolConfig.allowedTools.length > 0) {
      args.push("--allowedTools", toolConfig.allowedTools.join(","));
    }
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
    if (options.role && !options.sessionId) {
      args.push("--agents", this.claudeAgentsJson(options.role), "--agent", options.role.name);
    }
    if (options.appMcp) {
      args.push("--mcp-config", this.claudeMcpConfigJson(options.appMcp), "--strict-mcp-config");
    }
    if (extraReadableDirs.length > 0) {
      args.push("--add-dir", ...extraReadableDirs);
    }
    const tools = this.claudeToolsWithAppMcp(toolConfig.tools, options);
    if (tools.length > 0) {
      args.push("--tools", tools.join(","));
    } else {
      args.push("--tools", "");
    }

    const child = spawn("claude", args, {
      cwd: repoPath,
      env: { ...process.env, ...this.appMcpEnv(options) },
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
      run: (turnPrompt: string, signal?: AbortSignal, onOutput?: CliAgentOutputCallback) => {
        if (closed || child.exitCode !== null || child.killed) {
          return Promise.reject(new Error("claude warm process is not running"));
        }
        if (pending) {
          return Promise.reject(new Error("claude warm process already has an active turn"));
        }
        return new Promise<ParticipantRunResult>((resolve, reject) => {
          const startedAt = Date.now();
          const timer = setTimeout(() => {
            rejectPending(new Error(`claude warm process timed out after ${CLI_AGENT_RUN_TIMEOUT_MS}ms`));
          }, CLI_AGENT_RUN_TIMEOUT_MS);
          timer.unref();
          const abort = (): void => {
            rejectPending(new Error("claude warm process was cancelled"));
          };
          pending = {
            startedAt,
            messages: [],
            streamedText: "",
            sessionId: options.sessionId ?? newSessionId,
            model: participant.model,
            timer,
            abort: signal ? () => signal.removeEventListener("abort", abort) : undefined,
            onOutput,
            resolve,
            reject
          };
          if (signal?.aborted) {
            abort();
            return;
          }
          signal?.addEventListener("abort", abort, { once: true });
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
    pending.sessionId = this.findSessionId(event) ?? pending.sessionId ?? fallbackSessionId;
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
      this.emitLiveOutput(pending.onOutput, "tool", `${toolSummary}\n`);
    }
    const streamDelta = this.extractClaudeStreamEventTextDelta(event);
    if (streamDelta) {
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
    const content = this.extractClaudeWarmResultText(event) ?? current.messages.at(-1) ?? "";
    const sessionId = this.findSessionId(event) ?? current.sessionId ?? fallbackSessionId;
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

  private enqueueWarmRun(entry: WarmAgentEntry, task: () => Promise<ParticipantRunResult>): Promise<ParticipantRunResult> {
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
      repoPath: repoPath ?? "",
      kind,
      extraReadableDirs: this.normalizedExtraReadableDirs(options.extraReadableDirs),
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

  private emitCodexLiveOutput(line: string, onOutput: CliAgentOutputCallback | undefined, deltaAccumulator?: { value: string }): void {
    if (!onOutput) {
      return;
    }
    try {
      const event = JSON.parse(line) as unknown;
      const delta = this.extractCodexAssistantStreamingDelta(event);
      if (delta && deltaAccumulator) {
        deltaAccumulator.value += delta;
        this.emitLiveOutput(onOutput, "text", delta, deltaAccumulator.value);
        return;
      }
      const toolSummary = this.codexToolSummary(event);
      if (toolSummary) {
        this.emitLiveOutput(onOutput, "tool", `${toolSummary}\n`);
      }
    } catch {
      // Ignore non-JSON CLI output in the live chat panel; stderr/stdout diagnostics
      // are still captured by the final command result and debug logs.
    }
  }

  private emitLiveOutput(
    onOutput: CliAgentOutputCallback | undefined,
    kind: CliAgentOutputKind,
    text: string,
    cumulative?: string
  ): void {
    const clean = this.cleanLiveOutputText(text);
    if (!onOutput || !clean) {
      return;
    }
    const cleanCumulative = cumulative !== undefined ? this.cleanLiveOutputText(cumulative) : undefined;
    onOutput({ kind, text: clean, cumulative: cleanCumulative });
  }

  private cleanLiveOutputText(text: string): string {
    return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
  }

  private codexToolSummary(event: unknown): string | undefined {
    const record = this.asRecord(event);
    if (!record) {
      return undefined;
    }
    const item = this.asRecord(record.item) ?? record;
    const type = `${this.stringField(record, "type") ?? ""} ${this.stringField(item, "type") ?? ""}`.toLowerCase();
    const name = this.stringField(item, "name") ?? this.stringField(item, "tool_name");
    const command = this.stringField(item, "command") ?? this.stringField(item, "cmd");
    if (command && /command|exec|shell|bash/.test(type)) {
      return "Running command";
    }
    if (name && /tool|function|call/.test(type)) {
      return this.toolActivityLabel(name);
    }
    if (/read|grep|glob|ls/.test(type) && name) {
      return this.toolActivityLabel(name);
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

  private claudeWarmToolSummary(event: unknown): string | undefined {
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
        return this.toolActivityLabel(name);
      }
    }
    return undefined;
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

  private claudeToolsWithAppMcp(tools: string[], options: CliAgentRunOptions): string[] {
    const next = new Set(tools);
    for (const toolName of options.appMcp?.toolNames ?? []) {
      next.add(`mcp__ai_consensus__${toolName}`);
    }
    return Array.from(next);
  }

  private claudeMcpConfigJson(appMcp: CliAgentAppMcpOptions): string {
    return JSON.stringify({
      mcpServers: {
        ai_consensus: {
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

  private permissionsForRun(mode: ChatAgentMode, options: CliAgentRunOptions): ChatAgentPermissions {
    return effectiveChatAgentPermissions(mode, normalizeChatAgentPermissions(options.permissions));
  }

  private claudePermissionMode(kind: ConversationKind, options: CliAgentRunOptions): ClaudePermissionMode {
    const agentMode = this.agentModeForRun(kind, options);
    if (agentMode === "plan") {
      return "plan";
    }
    const permissions = this.permissionsForRun(agentMode, options);
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
    const permissions = this.permissionsForRun(agentMode, options);
    const tools = new Set<string>();
    const allowedTools: string[] = [];
    const disallowedTools: string[] = [];
    const askTools: string[] = [];
    const providerNativeAllowedTools = permissions.providerNative?.["claude-code"]?.allowedTools ?? [];
    const readContextAvailable = Boolean(repoPath) || extraReadableDirs.length > 0;
    const readTools = ["Read", "Grep", "Glob", "LS"];
    const editTools = ["Edit", "Write", "MultiEdit", "NotebookEdit"];
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
        if (rule.action === "allow") {
          allowedTools.push(toolRule);
        } else if (rule.action === "ask") {
          askTools.push(toolRule);
        } else {
          disallowedTools.push(toolRule);
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
      allowedTools.push(`mcp__ai_consensus__${toolName}`);
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
        `You are running for AI Consensus Chat in ${mode} mode.`,
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
        const usage = this.agentContextUsageFromEvent(JSON.parse(line) as unknown, participant, "claude-code");
        if (usage) {
          latest = usage;
        }
      } catch {
        // Ignore partial or diagnostic lines in Claude's local session log.
      }
    }
    return latest;
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
    const usage = this.findUsageRecord(value);
    if (usage) {
      return this.inputTokensFromUsage(usage) ?? this.numberField(usage, "total_tokens") ?? this.numberField(usage, "totalTokens");
    }
    return this.findNumberField(value, ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens"]);
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
    if (itemType !== "message" && itemType !== "assistant_message" && role !== "assistant") {
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
      content: `${participant.label} failed: ${message}`,
      error: message,
      durationMs
    };
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
    const message = this.stringField(record, "message") ?? this.stringField(record, "error");
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

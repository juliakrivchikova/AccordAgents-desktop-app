import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import type {
  ChatAgentPermissions,
  ChatAppToolApprovalScope,
  ChatPermissionChangeRequest,
  ChatPermissionRequestToolResult,
  ChatRemoteRunStatus,
  ConversationKind,
  GitDiffMode,
  ParticipantConfig,
  RemoteParticipantSessionHandle,
  RemoteRunSyncInfo
} from "../../shared/types";
import { filterAllowedAgentEnvironment } from "../../shared/agentEnvironment";
import { APP_PERMISSIONS_REQUEST_CHANGE_TOOL } from "./appMcp";
import type { ChatAppToolApprovalDecisionEvent, ChatService } from "./chat";
import { buildCloudRunSshTarget, cloudRunSshOptionArgs } from "./cloudRunWorkers";
import { CommandError, commandEnvironment, runCommand } from "./command";
import {
  CODEX_APP_SERVER_MCP_TOKEN_ENV,
  buildCodexExecInvocation,
  createCodexLineHandler,
  emitCodexLiveOutput,
  extractCodexSessionId,
  extractCodexText
} from "./codexExec";
import type { CodexExecOptions, CodexExecInvocation, CodexExecRemoteSandboxOptions } from "./codexExec";
import { defaultRemoteMirrorSync, localProjectHasGitDir, remoteMirrorPath } from "./remoteMirrorSync";
import type { RemoteMirrorSyncRunner } from "./remoteMirrorSync";
import {
  detectRepoToolchainRequirements,
  formatToolchainAdvisoryIssues,
  issueFromRequirement,
  RemoteRunPreflightError,
  RemoteRunPreflightInfrastructureError
} from "./toolchainRequirements";
import type { ToolchainIssueCategory, ToolchainPreflightIssue, ToolchainRequirement } from "./toolchainRequirements";
import {
  REMOTE_SESSION_IDLE_TIMEOUT_MS,
  REMOTE_OPERATION_LEASE_MS,
  REMOTE_SESSION_PROTOCOL_VERSION,
  REMOTE_STOP_DRAIN_LEASE_MS,
  REMOTE_STOP_DRAIN_SHUTDOWN_LEASE_MS,
  remoteParticipantRuntimeFingerprint,
  remoteParticipantSessionKey,
  remoteSessionControlScript,
  remoteSessionInstallerScript,
  remoteSessionSupervisorScript,
  remoteWorkerOperationLeaseShellScript
} from "./remoteSessionSupervisorScript";

const DEFAULT_APPLY_LIMIT = 200;
const DEFAULT_REMOTE_RUN_TIMEOUT_MS = 24 * 60 * 60_000;
const DEFAULT_DETACHED_MAX_RUNTIME_MS = 24 * 60 * 60_000;

// v1 env forwarding: remote runs get the same environment local runs inherit
// (process env + login-shell env), minus machine-specific vars that would
// break the Linux worker or leak meaningless local state. The worker merges
// forwarded vars OVER its own env, so anything not listed here wins over the
// box; listed vars are never forwarded, so the box's own values win.
const REMOTE_ENV_DENYLIST_EXACT = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "SHLVL", "PWD", "OLDPWD",
  "TMPDIR", "TMP", "TEMP", "TERM", "TERMINFO", "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION", "TERM_SESSION_ID", "DISPLAY", "WINDOWID",
  "SSH_AUTH_SOCK", "SSH_AGENT_PID", "SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY",
  "GPG_AGENT_INFO", "LANG", "LANGUAGE", "EDITOR", "VISUAL", "PAGER",
  "COMMAND_MODE", "SECURITYSESSIONID", "MANPATH", "INFOPATH", "CDPATH",
  "TMUX", "TMUX_PANE", "JAVA_HOME", "ANDROID_HOME", "SDKROOT",
  "DEVELOPER_DIR", "VIRTUAL_ENV", "GOPATH", "GOROOT", "CARGO_HOME",
  "RUSTUP_HOME", "ORIGINAL_XDG_CURRENT_DESKTOP"
]);
const REMOTE_ENV_DENYLIST_PREFIXES = [
  "LC_", "DYLD_", "XPC_", "__", "Apple_", "ELECTRON_", "CHROME_", "NODE_",
  "npm_", "NVM_", "HOMEBREW_", "ITERM_", "VSCODE_", "XDG_", "CONDA_",
  "ACCORD_AGENTS_"
];

export function forwardedDesktopEnvironment(base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const source = base ?? commandEnvironment();
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) {
      continue;
    }
    if (REMOTE_ENV_DENYLIST_EXACT.has(key)) {
      continue;
    }
    if (REMOTE_ENV_DENYLIST_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      continue;
    }
    result[key] = value;
  }
  return result;
}

export type RemoteRunSpoolRecordKind =
  | "lifecycle"
  | "output_text"
  | "provider_output"
  | "provider_result"
  | "permission_pending"
  | "permission_decision"
  | "terminal_state";

interface RemoteRunRecordBase {
  id: string;
  conversationId: string;
  runId: string;
  seq: number;
  workerSeq?: number;
  createdAt: string;
}

export interface RemoteRunLifecycleRecord extends RemoteRunRecordBase {
  kind: "lifecycle";
  state: "started" | "connected" | "disconnected" | "reconnecting";
  message?: string;
  remoteRunStatus?: ChatRemoteRunStatus;
}

export interface RemoteRunOutputTextRecord extends RemoteRunRecordBase {
  kind: "output_text";
  participantId: string;
  content: string;
  sourceMessageId?: string;
  threadId?: string;
  chatThreadRootId?: string;
}

export interface RemoteRunProviderOutputRecord extends RemoteRunRecordBase {
  kind: "provider_output";
  participantId: string;
  stream: "stdout" | "stderr";
  content: string;
}

export interface RemoteRunProviderResultRecord extends RemoteRunRecordBase {
  kind: "provider_result";
  participantId: string;
  ok: boolean;
  content: string;
  exitCode?: number | null;
  error?: string;
  sessionId?: string;
  durationMs?: number;
  sourceMessageId?: string;
  threadId?: string;
  chatThreadRootId?: string;
}

export interface RemoteRunPermissionPendingRecord extends RemoteRunRecordBase {
  kind: "permission_pending";
  participantId: string;
  roleConfigVersion?: number;
  triggerMessageId?: string;
  requestId?: string;
  request: ChatPermissionChangeRequest;
  runPermissions?: ChatAgentPermissions;
}

export interface RemoteRunPermissionDecisionRecord extends RemoteRunRecordBase {
  kind: "permission_decision";
  requestId: string;
  status: "approved" | "denied";
  approvalScope?: ChatAppToolApprovalScope;
  approvalUpdatedAt?: string;
  error?: string;
}

export interface RemoteRunTerminalStateRecord extends RemoteRunRecordBase {
  kind: "terminal_state";
  status: "completed" | "cancelled" | "failed";
  reason?: string;
}

export type RemoteRunReplayRecord =
  | RemoteRunLifecycleRecord
  | RemoteRunOutputTextRecord
  | RemoteRunProviderOutputRecord
  | RemoteRunProviderResultRecord
  | RemoteRunPermissionPendingRecord
  | RemoteRunPermissionDecisionRecord
  | RemoteRunTerminalStateRecord;

type RemoteRunRecordInput =
  | Omit<RemoteRunLifecycleRecord, "id" | "seq" | "createdAt">
  | Omit<RemoteRunOutputTextRecord, "id" | "seq" | "createdAt">
  | Omit<RemoteRunProviderOutputRecord, "id" | "seq" | "createdAt">
  | Omit<RemoteRunProviderResultRecord, "id" | "seq" | "createdAt">
  | Omit<RemoteRunPermissionPendingRecord, "id" | "seq" | "createdAt" | "requestId"> & { requestId?: string }
  | Omit<RemoteRunPermissionDecisionRecord, "id" | "seq" | "createdAt">
  | Omit<RemoteRunTerminalStateRecord, "id" | "seq" | "createdAt">;

type RemoteRunRecordInputWithOverrides = RemoteRunRecordInput & {
  id?: string;
  workerSeq?: number;
  createdAt?: string;
};

export interface RemoteRunApplyRecordResult {
  applied: boolean;
  runId: string;
  seq: number;
  cursorSeq: number;
  permissionResult?: ChatPermissionRequestToolResult;
}

export interface RemoteRunServiceOptions {
  spoolRoot?: string;
  applyLimit?: number;
  codexExecutor?: RemoteCodexExecutor;
  detachedWorkerTransport?: RemoteDetachedWorkerTransport;
  mirrorSync?: RemoteMirrorSyncRunner;
  syncLogger?: (event: string, payload: Record<string, unknown>) => void;
  remoteGitDirProbe?: (worker: RemoteRunWorkerTarget, gitDirPath: string, signal?: AbortSignal) => Promise<boolean>;
  sessionIdleTimeoutMs?: number;
}

export interface RemoteRunStartRequest {
  conversationId: string;
  runId?: string;
}

export interface RemoteRunToolchainPreflightOptions {
  localRepoPath?: string;
  skip?: boolean;
}

export interface RemoteRunWorkerTarget {
  host: string;
  user?: string;
  port?: number;
  identityFile?: string;
  hostKeyAlias?: string;
  sshPath?: string;
  codexPath?: string;
  remoteCwd?: string;
  workerRoot?: string;
}

export interface RemoteRunRealStartRequest extends RemoteRunStartRequest {
  participant: ParticipantConfig;
  prompt: string;
  worker: RemoteRunWorkerTarget;
  kind?: ConversationKind;
  repoPath?: string;
  diffMode?: GitDiffMode;
  options?: CodexExecOptions;
  toolchainPreflight?: RemoteRunToolchainPreflightOptions;
  timeoutMs?: number;
  signal?: AbortSignal;
  sourceMessageId?: string;
  threadId?: string;
  chatThreadRootId?: string;
}

export interface RemoteRunDetachedStartRequest extends RemoteRunRealStartRequest {
  maxRuntimeMs?: number;
  contextSnapshot?: unknown;
  // Mirror-sync mode: when set (and no pre-provisioned repoPath/remoteCwd is
  // given), the local project directory is rsynced to a per-project mirror
  // under the worker root before launch and the run executes in that mirror.
  // Sync is ONE-WAY by design: the local tree is never written automatically.
  // Results come back via git (the agent commits/pushes from the box) or via
  // an explicit pullMirrorForRun call.
  sync?: { localPath: string };
  onPhase?: (status: ChatRemoteRunStatus) => void;
  onToolchainAdvisory?: (message: string) => void;
}

export interface RemoteRunDetachedPollRequest {
  conversationId?: string;
  runId: string;
  worker: RemoteRunWorkerTarget;
  afterWorkerSeq?: number;
}

export interface RemoteRunDetachedCancelRequest {
  conversationId?: string;
  runId: string;
  worker: RemoteRunWorkerTarget;
  reason?: string;
}

export interface RemoteRunDetachedReapRequest {
  worker: RemoteRunWorkerTarget;
}

export interface RemoteCodexExecutorRequest {
  worker: RemoteRunWorkerTarget;
  invocation: CodexExecInvocation;
  remoteFinalPath: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface RemoteCodexExecutorCallbacks {
  onStdout(chunk: string): void;
  onStderr(chunk: string): void;
}

export interface RemoteCodexExecutionResult {
  stdout: string;
  stderr: string;
  finalMessage: string;
  exitCode: number | null;
  timedOut: boolean;
}

export type RemoteCodexExecutor = (
  request: RemoteCodexExecutorRequest,
  callbacks: RemoteCodexExecutorCallbacks
) => Promise<RemoteCodexExecutionResult>;

export type RemoteDetachedRunStatus = "running" | "completed" | "failed" | "cancelled" | "unknown";

export interface RemoteDetachedRunState {
  runId: string;
  conversationId?: string;
  participantId?: string;
  status: RemoteDetachedRunStatus;
  workerCursorSeq?: number;
  pid?: number;
  pgid?: number;
  relayPort?: number;
  startedAt?: string;
  lastHeartbeat?: string;
  completedAt?: string;
  exitCode?: number | null;
  signal?: string;
  timedOut?: boolean;
  error?: string;
  providerSessionId?: string;
  providerSessionValid?: boolean;
  acceptedAt?: string;
  sync?: RemoteRunSyncInfo;
  remoteSession?: RemoteParticipantSessionHandle;
}

export interface RemoteParticipantSessionEnsureRequest {
  conversationId: string;
  participantId: string;
  worker: RemoteRunWorkerTarget;
  runtimeFingerprint: string;
  idleTimeoutMs: number;
  signal?: AbortSignal;
}

export interface RemoteParticipantSessionEnsureResult {
  handle: RemoteParticipantSessionHandle;
  launched: boolean;
}

export interface RemoteParticipantSessionInspectRequest {
  handle: RemoteParticipantSessionHandle;
  signal?: AbortSignal;
}

export interface RemoteParticipantSessionInspectResult {
  status: "live" | "stopped" | "unknown";
  activeRunId?: string;
  queuedRunIds?: string[];
  providerSessionId?: string;
  providerSessionValid?: boolean;
}

export interface RemoteParticipantSessionDiscovery extends RemoteParticipantSessionInspectResult {
  handle: RemoteParticipantSessionHandle;
  conversationId?: string;
  participantId?: string;
  hasQueuedTurns?: boolean;
}

export interface RemoteParticipantSessionStopRequest {
  handle: RemoteParticipantSessionHandle;
  remove?: boolean;
  removeArtifacts?: boolean;
  runIds?: string[];
  providerSessionIds?: string[];
  signal?: AbortSignal;
}

export interface RemoteWorkerStopLease {
  leaseId: string;
  expiresAt: string;
}

export interface RemoteWorkerStopAuthorization {
  allowed: boolean;
  reason?: string;
  lease?: RemoteWorkerStopLease;
}

export interface RemoteWorkerOperationLease {
  leaseId: string;
  ownerId: string;
  kind: string;
  expiresAt: string;
}

interface RemoteWorkerEventBase {
  kind: RemoteRunSpoolRecordKind;
  workerSeq: number;
  createdAt?: string;
}

export interface RemoteWorkerLifecycleEvent extends RemoteWorkerEventBase {
  kind: "lifecycle";
  state: RemoteRunLifecycleRecord["state"] | "detached_started";
  message?: string;
}

export interface RemoteWorkerProviderOutputEvent extends RemoteWorkerEventBase {
  kind: "provider_output";
  stream: RemoteRunProviderOutputRecord["stream"];
  content: string;
}

export interface RemoteWorkerProviderResultEvent extends RemoteWorkerEventBase {
  kind: "provider_result";
  ok: boolean;
  content: string;
  exitCode?: number | null;
  error?: string;
  sessionId?: string;
  durationMs?: number;
  sourceMessageId?: string;
  threadId?: string;
  chatThreadRootId?: string;
}

export interface RemoteWorkerPermissionPendingEvent extends RemoteWorkerEventBase {
  kind: "permission_pending";
  roleConfigVersion?: number;
  triggerMessageId?: string;
  requestId?: string;
  request: ChatPermissionChangeRequest;
  runPermissions?: ChatAgentPermissions;
}

export interface RemoteWorkerTerminalStateEvent extends RemoteWorkerEventBase {
  kind: "terminal_state";
  status: RemoteRunTerminalStateRecord["status"];
  reason?: string;
}

export type RemoteWorkerEvent =
  | RemoteWorkerLifecycleEvent
  | RemoteWorkerProviderOutputEvent
  | RemoteWorkerProviderResultEvent
  | RemoteWorkerPermissionPendingEvent
  | RemoteWorkerTerminalStateEvent;

export interface RemoteDetachedWorkerLaunchRequest {
  conversationId: string;
  runId: string;
  participant: ParticipantConfig;
  worker: RemoteRunWorkerTarget;
  invocation: CodexExecInvocation;
  remoteRunDir: string;
  remoteFinalPath: string;
  timeoutMs: number;
  maxRuntimeMs: number;
  sourceMessageId?: string;
  threadId?: string;
  chatThreadRootId?: string;
  contextSnapshot?: unknown;
  signal?: AbortSignal;
  participantSession?: RemoteParticipantSessionHandle;
}

export interface RemoteToolchainPreflightProbeRequest {
  worker: RemoteRunWorkerTarget;
  requirements: ToolchainRequirement[];
  signal?: AbortSignal;
}

export interface RemoteDetachedWorkerPollRequest {
  runId: string;
  worker: RemoteRunWorkerTarget;
  afterWorkerSeq: number;
  signal?: AbortSignal;
}

export interface RemoteDetachedWorkerCancelRequest {
  runId: string;
  worker: RemoteRunWorkerTarget;
  reason?: string;
  signal?: AbortSignal;
}

export interface RemoteDetachedWorkerDecisionRequest {
  runId: string;
  worker: RemoteRunWorkerTarget;
  decision: RemoteRunPermissionDecisionRecord;
  signal?: AbortSignal;
}

export interface RemoteDetachedWorkerReapRequest {
  worker: RemoteRunWorkerTarget;
  signal?: AbortSignal;
}

export interface RemoteDetachedWorkerSnapshot {
  state: RemoteDetachedRunState;
  events: RemoteWorkerEvent[];
}

export interface RemoteDetachedWorkerTransport {
  preflight(request: RemoteToolchainPreflightProbeRequest): Promise<ToolchainPreflightIssue[]>;
  ensureParticipantSession?(request: RemoteParticipantSessionEnsureRequest): Promise<RemoteParticipantSessionEnsureResult>;
  submitTurn?(request: RemoteDetachedWorkerLaunchRequest): Promise<RemoteDetachedWorkerSnapshot>;
  inspectParticipantSession?(request: RemoteParticipantSessionInspectRequest): Promise<RemoteParticipantSessionInspectResult>;
  listParticipantSessions?(worker: RemoteRunWorkerTarget): Promise<RemoteParticipantSessionDiscovery[]>;
  stopParticipantSessionIfIdle?(request: RemoteParticipantSessionStopRequest): Promise<boolean>;
  authorizeAutomaticStop?(worker: RemoteRunWorkerTarget, ownerId: string): Promise<RemoteWorkerStopAuthorization>;
  renewAutomaticStopLease?(worker: RemoteRunWorkerTarget, lease: RemoteWorkerStopLease): Promise<RemoteWorkerStopLease>;
  releaseAutomaticStopLease?(worker: RemoteRunWorkerTarget, lease: RemoteWorkerStopLease): Promise<void>;
  acquireOperationLease?(worker: RemoteRunWorkerTarget, ownerId: string, kind: string): Promise<RemoteWorkerOperationLease>;
  renewOperationLease?(worker: RemoteRunWorkerTarget, lease: RemoteWorkerOperationLease): Promise<RemoteWorkerOperationLease>;
  releaseOperationLease?(worker: RemoteRunWorkerTarget, lease: RemoteWorkerOperationLease): Promise<void>;
  launch(request: RemoteDetachedWorkerLaunchRequest): Promise<RemoteDetachedWorkerSnapshot>;
  poll(request: RemoteDetachedWorkerPollRequest): Promise<RemoteDetachedWorkerSnapshot>;
  cancel(request: RemoteDetachedWorkerCancelRequest): Promise<RemoteDetachedWorkerSnapshot>;
  writePermissionDecision?(request: RemoteDetachedWorkerDecisionRequest): Promise<void>;
  reapExpiredRuns?(request: RemoteDetachedWorkerReapRequest): Promise<RemoteDetachedWorkerSnapshot[]>;
}

export interface RemoteRunPermissionRequest {
  conversationId: string;
  runId: string;
  participantId: string;
  roleConfigVersion?: number;
  triggerMessageId?: string;
  request: ChatPermissionChangeRequest;
  runPermissions?: ChatAgentPermissions;
}

export interface RemoteRunOutputTextRequest {
  conversationId: string;
  runId: string;
  participantId: string;
  content: string;
  sourceMessageId?: string;
  threadId?: string;
  chatThreadRootId?: string;
}

export class RemoteRunService {
  private readonly spoolRoot: string;
  private readonly applyLimit: number;
  private readonly codexExecutor: RemoteCodexExecutor;
  private readonly detachedWorkerTransport: RemoteDetachedWorkerTransport;
  private readonly connectedRuns = new Map<string, boolean>();
  private readonly appliedSeqByRun = new Map<string, number>();
  private readonly seqByRun = new Map<string, number>();
  private readonly appendChainByRun = new Map<string, Promise<unknown>>();
  private readonly detachedWorkerByRun = new Map<string, RemoteRunWorkerTarget>();
  private readonly detachedContextByRun = new Map<string, { conversationId: string; participantId: string }>();
  private readonly mirrorSync: RemoteMirrorSyncRunner;
  private readonly syncLogger?: (event: string, payload: Record<string, unknown>) => void;
  private readonly remoteGitDirProbe: (worker: RemoteRunWorkerTarget, gitDirPath: string, signal?: AbortSignal) => Promise<boolean>;
  private readonly detachedSyncByRun = new Map<string, RemoteRunSyncInfo>();
  private readonly mirrorOpChainByPath = new Map<string, Promise<void>>();
  private readonly activeRunsByMirror = new Map<string, Set<string>>();
  private readonly sessionIdleTimeoutMs: number;
  private readonly toolchainPreflightCache = new Map<string, ToolchainPreflightIssue[]>();

  constructor(
    private readonly chat: Pick<ChatService, "applyRemoteRunReplayRecord" | "onAppToolApprovalDecision" | "getRemoteRunCursorSeq">,
    options: RemoteRunServiceOptions = {}
  ) {
    this.spoolRoot = options.spoolRoot ?? path.join(app.getPath("userData"), "remote-runs");
    this.applyLimit = Math.max(1, Math.floor(options.applyLimit ?? DEFAULT_APPLY_LIMIT));
    this.codexExecutor = options.codexExecutor ?? defaultRemoteCodexExecutor;
    this.detachedWorkerTransport = options.detachedWorkerTransport ?? new SshDetachedWorkerTransport();
    this.mirrorSync = options.mirrorSync ?? defaultRemoteMirrorSync;
    this.syncLogger = options.syncLogger;
    this.remoteGitDirProbe = options.remoteGitDirProbe ?? defaultRemoteGitDirProbe;
    this.sessionIdleTimeoutMs = Math.max(1, Math.floor(options.sessionIdleTimeoutMs ?? REMOTE_SESSION_IDLE_TIMEOUT_MS));
    this.chat.onAppToolApprovalDecision((event) => this.appendPermissionDecision(event));
  }

  async startSimulatedRun(request: RemoteRunStartRequest): Promise<string> {
    const runId = request.runId?.trim() || randomUUID();
    await this.appendSpoolRecord({
      kind: "lifecycle",
      conversationId: request.conversationId,
      runId,
      state: "started"
    });
    return runId;
  }

  async startRealRun(request: RemoteRunRealStartRequest): Promise<RemoteRunProviderResultRecord> {
    const runId = request.runId?.trim() || randomUUID();
    const startedAt = Date.now();
    const remoteFinalPath = `/tmp/accordagents-${this.safeRunId(runId)}-last-message.txt`;
    this.connectedRuns.set(runId, true);
    await this.appendSpoolRecord({
      kind: "lifecycle",
      conversationId: request.conversationId,
      runId,
      state: "started"
    });

    const invocation = buildCodexExecInvocation({
      participant: request.participant,
      prompt: request.prompt,
      outputPath: remoteFinalPath,
      repoPath: request.repoPath,
      diffMode: request.diffMode,
      kind: request.kind ?? "chat",
      options: {
        ...request.options,
        persistSession: true,
        extraEnv: {
          ...forwardedDesktopEnvironment(),
          ...filterAllowedAgentEnvironment(request.options?.extraEnv)
        }
      }
    });

    let stdout = "";
    let stderr = "";
    let sessionId = request.options?.sessionId;
    const pendingOutputWrites: Promise<unknown>[] = [];
    const lineHandler = createCodexLineHandler((line) =>
      emitCodexLiveOutput(line, undefined, undefined, (nextSessionId) => {
        sessionId = nextSessionId;
      })
    );
    const appendOutput = (stream: RemoteRunProviderOutputRecord["stream"], chunk: string): void => {
      if (!chunk) {
        return;
      }
      if (stream === "stdout") {
        stdout += chunk;
        lineHandler(chunk);
      } else {
        stderr += chunk;
      }
      pendingOutputWrites.push(this.appendProviderOutput({
        conversationId: request.conversationId,
        runId,
        participantId: request.participant.id,
        stream,
        content: chunk
      }));
    };

    try {
      await this.ensureRemoteToolchainPreflight(
        request.worker,
        {
          ...request.toolchainPreflight
        },
        request.signal
      );
      const execution = await this.codexExecutor({
        worker: request.worker,
        invocation,
        remoteFinalPath,
        timeoutMs: Math.max(1, Math.floor(request.timeoutMs ?? DEFAULT_REMOTE_RUN_TIMEOUT_MS)),
        signal: request.signal
      }, {
        onStdout: (chunk) => appendOutput("stdout", chunk),
        onStderr: (chunk) => appendOutput("stderr", chunk)
      });
      stdout ||= execution.stdout;
      stderr ||= execution.stderr;
      sessionId = extractCodexSessionId(stdout) ?? sessionId;
      await Promise.all(pendingOutputWrites);
      const error = this.remoteExecutionError(execution);
      return await this.appendProviderResult({
        conversationId: request.conversationId,
        runId,
        participantId: request.participant.id,
        ok: !error,
        content: execution.finalMessage.trim() || extractCodexText(stdout) || stderr.trim() || error || "",
        exitCode: execution.exitCode,
        error,
        sessionId,
        durationMs: Date.now() - startedAt,
        sourceMessageId: request.sourceMessageId,
        threadId: request.threadId,
        chatThreadRootId: request.chatThreadRootId
      });
    } catch (error) {
      await Promise.all(pendingOutputWrites);
      const message = error instanceof Error ? error.message : String(error);
      return await this.appendProviderResult({
        conversationId: request.conversationId,
        runId,
        participantId: request.participant.id,
        ok: false,
        content: message,
        error: message,
        sessionId,
        durationMs: Date.now() - startedAt,
        sourceMessageId: request.sourceMessageId,
        threadId: request.threadId,
        chatThreadRootId: request.chatThreadRootId
      });
    }
  }

  async startDetachedRun(request: RemoteRunDetachedStartRequest): Promise<RemoteDetachedRunState> {
    const runId = request.runId?.trim() || randomUUID();
    const maxRuntimeMs = Math.max(1, Math.floor(request.maxRuntimeMs ?? DEFAULT_DETACHED_MAX_RUNTIME_MS));
    const remoteRunDir = this.remoteWorkerRunDir(request.worker, runId);
    const remoteFinalPath = `${remoteRunDir}/final.txt`;
    this.connectedRuns.set(runId, true);
    this.detachedWorkerByRun.set(runId, request.worker);
    this.detachedContextByRun.set(runId, {
      conversationId: request.conversationId,
      participantId: request.participant.id
    });
    await this.appendSpoolRecord({
      kind: "lifecycle",
      conversationId: request.conversationId,
      runId,
      state: "started"
    });

    const runtimeFingerprint = remoteParticipantRuntimeFingerprint({
      participant: request.participant,
      repoPath: request.repoPath ?? request.sync?.localPath,
      kind: request.kind ?? "chat",
      options: request.options,
      codexPath: request.worker.codexPath
    });
    let participantSession: RemoteParticipantSessionEnsureResult | undefined;
    if (this.detachedWorkerTransport.ensureParticipantSession) {
      await this.emitDetachedPhase(runId, request, "preparing-worker", "Checking warm remote session");
      participantSession = await this.detachedWorkerTransport.ensureParticipantSession({
        conversationId: request.conversationId,
        participantId: request.participant.id,
        worker: request.worker,
        runtimeFingerprint,
        idleTimeoutMs: this.sessionIdleTimeoutMs,
        signal: request.signal
      });
      if (participantSession.launched) {
        await this.emitDetachedPhase(runId, request, "launching-session", "Launching remote session");
      }
    } else {
      await this.emitDetachedPhase(runId, request, "launching-session", "Checking remote environment");
    }
    const advisoryIssues = await this.ensureRemoteToolchainPreflight(
      request.worker,
      {
        ...request.toolchainPreflight,
        localRepoPath: request.toolchainPreflight?.localRepoPath ?? request.sync?.localPath
      },
      request.signal
    );
    const advisoryMessage = formatToolchainAdvisoryIssues(advisoryIssues);
    if (advisoryMessage) {
      request.onToolchainAdvisory?.(advisoryMessage);
      await this.emitDetachedPhase(
        runId,
        request,
        participantSession ? "preparing-worker" : "launching-session",
        "Checking remote environment",
        advisoryMessage
      );
    }

    const sync = await this.prepareMirrorForRun(runId, request);
    const effectiveRepoPath = sync?.remotePath ?? request.repoPath;
    await this.emitDetachedPhase(
      runId,
      request,
      participantSession ? "preparing-worker" : "launching-session",
      "Preparing remote sandbox"
    );
    const remoteSandbox = await this.remoteSandboxOptionsForRun(request, sync, effectiveRepoPath);

    const invocation = buildCodexExecInvocation({
      participant: request.participant,
      prompt: request.prompt,
      outputPath: remoteFinalPath,
      repoPath: effectiveRepoPath,
      diffMode: request.diffMode,
      kind: request.kind ?? "chat",
      options: {
        ...request.options,
        persistSession: true,
        remoteSandbox,
        extraEnv: {
          ...forwardedDesktopEnvironment(),
          ...filterAllowedAgentEnvironment(request.options?.extraEnv)
        }
      }
    });

    let snapshot: RemoteDetachedWorkerSnapshot;
    try {
      if (!participantSession) {
        await this.emitDetachedPhase(runId, request, "launching-session", "Launching remote session");
      }
      const launchRequest: RemoteDetachedWorkerLaunchRequest = {
        conversationId: request.conversationId,
        runId,
        participant: request.participant,
        worker: request.worker,
        invocation,
        remoteRunDir,
        remoteFinalPath,
        timeoutMs: Math.max(1, Math.floor(request.timeoutMs ?? DEFAULT_REMOTE_RUN_TIMEOUT_MS)),
        maxRuntimeMs,
        sourceMessageId: request.sourceMessageId,
        threadId: request.threadId,
        chatThreadRootId: request.chatThreadRootId,
        contextSnapshot: request.contextSnapshot,
        signal: request.signal,
        participantSession: participantSession?.handle
      };
      if (participantSession && this.detachedWorkerTransport.submitTurn) {
        try {
          snapshot = await this.detachedWorkerTransport.submitTurn(launchRequest);
        } catch {
          const relaunched = await this.detachedWorkerTransport.ensureParticipantSession?.({
            conversationId: request.conversationId,
            participantId: request.participant.id,
            worker: request.worker,
            runtimeFingerprint,
            idleTimeoutMs: this.sessionIdleTimeoutMs,
            signal: request.signal
          });
          if (!relaunched) {
            throw new Error("Remote participant session became unavailable.");
          }
          participantSession = relaunched;
          if (relaunched.launched) {
            await this.emitDetachedPhase(runId, request, "launching-session", "Relaunching stale remote session");
          }
          snapshot = await this.detachedWorkerTransport.submitTurn({
            ...launchRequest,
            participantSession: relaunched.handle
          });
        }
      } else {
        snapshot = await this.detachedWorkerTransport.launch(launchRequest);
      }
    } catch (error) {
      this.forgetRunSync(runId);
      throw error;
    }
    await this.projectWorkerSnapshot(request.conversationId, runId, request.participant.id, snapshot);
    await this.projectSnapshotTerminalFallback(request.conversationId, runId, request.participant.id, snapshot);
    await this.emitDetachedPhase(runId, request, "waiting-for-response", "Waiting for response");
    const state = participantSession
      ? { ...snapshot.state, remoteSession: participantSession.handle }
      : snapshot.state;
    return sync ? { ...state, sync } : state;
  }

  async inspectParticipantSession(handle: RemoteParticipantSessionHandle): Promise<RemoteParticipantSessionInspectResult> {
    if (!this.detachedWorkerTransport.inspectParticipantSession) {
      return { status: "unknown" };
    }
    return this.detachedWorkerTransport.inspectParticipantSession({ handle });
  }

  async listParticipantSessions(worker: RemoteRunWorkerTarget): Promise<RemoteParticipantSessionDiscovery[]> {
    return this.detachedWorkerTransport.listParticipantSessions?.(worker) ?? [];
  }

  async stopParticipantSessionIfIdle(
    handle: RemoteParticipantSessionHandle,
    remove = false,
    cleanup: Pick<RemoteParticipantSessionStopRequest, "removeArtifacts" | "runIds" | "providerSessionIds"> = {}
  ): Promise<boolean> {
    if (!this.detachedWorkerTransport.stopParticipantSessionIfIdle) {
      return false;
    }
    return this.detachedWorkerTransport.stopParticipantSessionIfIdle({ handle, remove, ...cleanup });
  }

  async authorizeAutomaticWorkerStop(worker: RemoteRunWorkerTarget, ownerId: string): Promise<RemoteWorkerStopAuthorization> {
    if (!this.detachedWorkerTransport.authorizeAutomaticStop) {
      return { allowed: false, reason: "worker lifecycle protocol is unavailable" };
    }
    return this.detachedWorkerTransport.authorizeAutomaticStop(worker, ownerId);
  }

  async renewAutomaticWorkerStopLease(
    worker: RemoteRunWorkerTarget,
    lease: RemoteWorkerStopLease
  ): Promise<RemoteWorkerStopLease> {
    if (!this.detachedWorkerTransport.renewAutomaticStopLease) {
      throw new Error("Worker lifecycle lease renewal is unavailable.");
    }
    return this.detachedWorkerTransport.renewAutomaticStopLease(worker, lease);
  }

  async releaseAutomaticWorkerStopLease(worker: RemoteRunWorkerTarget, lease: RemoteWorkerStopLease): Promise<void> {
    await this.detachedWorkerTransport.releaseAutomaticStopLease?.(worker, lease);
  }

  async acquireWorkerOperationLease(
    worker: RemoteRunWorkerTarget,
    ownerId: string,
    kind: string
  ): Promise<RemoteWorkerOperationLease> {
    if (!this.detachedWorkerTransport.acquireOperationLease) {
      throw new Error("Worker operation lease protocol is unavailable.");
    }
    return this.detachedWorkerTransport.acquireOperationLease(worker, ownerId, kind);
  }

  async renewWorkerOperationLease(
    worker: RemoteRunWorkerTarget,
    lease: RemoteWorkerOperationLease
  ): Promise<RemoteWorkerOperationLease> {
    if (!this.detachedWorkerTransport.renewOperationLease) {
      throw new Error("Worker operation lease renewal is unavailable.");
    }
    return this.detachedWorkerTransport.renewOperationLease(worker, lease);
  }

  async releaseWorkerOperationLease(worker: RemoteRunWorkerTarget, lease: RemoteWorkerOperationLease): Promise<void> {
    await this.detachedWorkerTransport.releaseOperationLease?.(worker, lease);
  }

  registerDetachedRunContext(
    runId: string,
    worker: RemoteRunWorkerTarget,
    context: { conversationId: string; participantId: string; sync?: RemoteRunSyncInfo }
  ): void {
    this.detachedWorkerByRun.set(runId, worker);
    this.detachedContextByRun.set(runId, {
      conversationId: context.conversationId,
      participantId: context.participantId
    });
    if (context.sync?.localPath) {
      this.registerRunSync(runId, context.sync);
    }
  }

  async pollDetachedRun(request: RemoteRunDetachedPollRequest): Promise<RemoteDetachedRunState> {
    this.connectedRuns.set(request.runId, true);
    this.detachedWorkerByRun.set(request.runId, request.worker);
    const knownContext = this.detachedContextByRun.get(request.runId);
    const conversationId = request.conversationId ?? knownContext?.conversationId ?? await this.conversationIdForRun(request.runId);
    const afterWorkerSeq = request.afterWorkerSeq ?? await this.lastProjectedWorkerSeq(request.runId);
    let snapshot = await this.detachedWorkerTransport.poll({
      runId: request.runId,
      worker: request.worker,
      afterWorkerSeq
    });
    if (this.shouldRecoverMissingPermissionEvents(snapshot, afterWorkerSeq)) {
      snapshot = await this.detachedWorkerTransport.poll({
        runId: request.runId,
        worker: request.worker,
        afterWorkerSeq: 0
      });
    }
    const participantId = knownContext?.participantId ?? snapshot.state.participantId ?? await this.participantIdForRun(request.runId).catch(() => undefined);
    await this.projectWorkerSnapshot(conversationId ?? snapshot.state.conversationId, request.runId, participantId, snapshot);
    await this.projectSnapshotTerminalFallback(conversationId ?? snapshot.state.conversationId, request.runId, participantId, snapshot);
    return snapshot.state;
  }

  async cancelDetachedRun(request: RemoteRunDetachedCancelRequest): Promise<RemoteDetachedRunState> {
    this.detachedWorkerByRun.set(request.runId, request.worker);
    const knownContext = this.detachedContextByRun.get(request.runId);
    const conversationId = request.conversationId ?? knownContext?.conversationId ?? await this.conversationIdForRun(request.runId);
    const snapshot = await this.detachedWorkerTransport.cancel({
      runId: request.runId,
      worker: request.worker,
      reason: request.reason
    });
    const participantId = knownContext?.participantId ?? snapshot.state.participantId ?? await this.participantIdForRun(request.runId).catch(() => undefined);
    await this.projectWorkerSnapshot(conversationId ?? snapshot.state.conversationId, request.runId, participantId, snapshot);
    await this.projectSnapshotTerminalFallback(conversationId ?? snapshot.state.conversationId, request.runId, participantId, snapshot);
    return snapshot.state;
  }

  async reapExpiredRuns(request: RemoteRunDetachedReapRequest): Promise<RemoteDetachedRunState[]> {
    if (!this.detachedWorkerTransport.reapExpiredRuns) {
      return [];
    }
    const snapshots = await this.detachedWorkerTransport.reapExpiredRuns({ worker: request.worker });
    const states: RemoteDetachedRunState[] = [];
    for (const snapshot of snapshots) {
      const runId = snapshot.state.runId;
      this.connectedRuns.set(runId, true);
      const conversationId = snapshot.state.conversationId ?? await this.conversationIdForRun(runId);
      const participantId = snapshot.state.participantId ?? await this.participantIdForRun(runId);
      await this.projectWorkerSnapshot(conversationId, runId, participantId, snapshot);
      await this.projectSnapshotTerminalFallback(conversationId, runId, participantId, snapshot);
      states.push(snapshot.state);
    }
    return states;
  }

  async setConnected(runId: string, connected: boolean): Promise<RemoteRunApplyRecordResult[]> {
    this.connectedRuns.set(runId, connected);
    if (!connected) {
      await this.appendSpoolRecordForKnownRun(runId, "disconnected");
      return [];
    }
    await this.appendSpoolRecordForKnownRun(runId, "connected");
    return this.applyFromCursor(runId);
  }

  async appendOutputText(request: RemoteRunOutputTextRequest): Promise<RemoteRunOutputTextRecord> {
    const appended = await this.appendSpoolRecord({
      kind: "output_text",
      ...request
    });
    return appended.record as RemoteRunOutputTextRecord;
  }

  async appendProviderOutput(
    request: Omit<RemoteRunProviderOutputRecord, "id" | "seq" | "createdAt" | "kind">
  ): Promise<RemoteRunProviderOutputRecord> {
    const appended = await this.appendSpoolRecord({
      kind: "provider_output",
      ...request
    });
    return appended.record as RemoteRunProviderOutputRecord;
  }

  async appendProviderResult(
    request: Omit<RemoteRunProviderResultRecord, "id" | "seq" | "createdAt" | "kind">
  ): Promise<RemoteRunProviderResultRecord> {
    const appended = await this.appendSpoolRecord({
      kind: "provider_result",
      ...request
    });
    const status: RemoteRunTerminalStateRecord["status"] = request.ok ? "completed" : "failed";
    await this.markTerminal(request.conversationId, request.runId, status, request.error);
    return appended.record as RemoteRunProviderResultRecord;
  }

  async requestPermission(request: RemoteRunPermissionRequest): Promise<RemoteRunPermissionPendingRecord> {
    const requestId = randomUUID();
    const appended = await this.appendSpoolRecord({
      kind: "permission_pending",
      ...request,
      requestId
    });
    return appended.record as RemoteRunPermissionPendingRecord;
  }

  async markTerminal(
    conversationId: string,
    runId: string,
    status: RemoteRunTerminalStateRecord["status"],
    reason?: string
  ): Promise<RemoteRunTerminalStateRecord> {
    const appended = await this.appendSpoolRecord({
      kind: "terminal_state",
      conversationId,
      runId,
      status,
      reason
    });
    return appended.record as RemoteRunTerminalStateRecord;
  }

  async applyFromCursor(runId: string): Promise<RemoteRunApplyRecordResult[]> {
    await this.ensureCursorSeeded(runId);
    const afterSeq = this.appliedSeqByRun.get(runId) ?? 0;
    const records = await this.readRecords(runId, { afterSeq, limit: this.applyLimit });
    const results: RemoteRunApplyRecordResult[] = [];
    for (const record of records) {
      const result = await this.chat.applyRemoteRunReplayRecord(record);
      this.appliedSeqByRun.set(runId, result.cursorSeq);
      results.push(result);
    }
    return results;
  }

  // On the first drain in this process, seed the in-memory cursor from the
  // durable cursorSeq ChatService persisted. Without this a restarted service
  // (or a second instance over the same spool) rescans from seq 0 and would
  // re-apply records whose ids have aged out of the bounded applied-id window,
  // duplicating messages on a long run after reconnect.
  private async ensureCursorSeeded(runId: string): Promise<void> {
    if (this.appliedSeqByRun.has(runId)) {
      return;
    }
    const head = await this.readRecords(runId, { limit: 1 });
    const conversationId = head[0]?.conversationId;
    if (!conversationId) {
      this.appliedSeqByRun.set(runId, 0);
      return;
    }
    const persisted = await this.chat.getRemoteRunCursorSeq(conversationId, runId);
    this.appliedSeqByRun.set(runId, persisted);
  }

  async readRecords(
    runId: string,
    options: { afterSeq?: number; limit?: number } = {}
  ): Promise<RemoteRunReplayRecord[]> {
    let body = "";
    try {
      body = await readFile(this.spoolPath(runId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    const afterSeq = Math.max(0, Math.floor(options.afterSeq ?? 0));
    const limit = Math.max(1, Math.floor(options.limit ?? Number.MAX_SAFE_INTEGER));
    const records: RemoteRunReplayRecord[] = [];
    for (const line of body.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const record = this.normalizeRecord(parsed);
      if (!record || record.seq <= afterSeq) {
        continue;
      }
      records.push(record);
      if (records.length >= limit) {
        break;
      }
    }
    return records.sort((a, b) => a.seq - b.seq);
  }

  async queryPermissionDecision(
    runId: string,
    requestId: string
  ): Promise<RemoteRunPermissionDecisionRecord | undefined> {
    const records = await this.readRecords(runId);
    return records
      .filter((record): record is RemoteRunPermissionDecisionRecord =>
        record.kind === "permission_decision" && record.requestId === requestId
      )
      .at(-1);
  }

  private async projectWorkerSnapshot(
    conversationId: string | undefined,
    runId: string,
    participantId: string | undefined,
    snapshot: RemoteDetachedWorkerSnapshot
  ): Promise<void> {
    const resolvedConversationId = conversationId ?? snapshot.state.conversationId ?? await this.conversationIdForRun(runId);
    const resolvedParticipantId = participantId ?? snapshot.state.participantId ?? await this.participantIdForRun(runId);
    const events = [...snapshot.events].sort((a, b) => a.workerSeq - b.workerSeq);
    let previousWorkerSeq = 0;
    for (const event of events) {
      if (!Number.isFinite(event.workerSeq) || event.workerSeq <= 0) {
        throw new Error(`Remote worker event for run ${runId} has an invalid workerSeq.`);
      }
      if (event.workerSeq <= previousWorkerSeq) {
        throw new Error(`Remote worker events for run ${runId} are not strictly monotonic.`);
      }
      previousWorkerSeq = event.workerSeq;
      await this.projectWorkerEvent(resolvedConversationId, runId, resolvedParticipantId, event);
    }
  }

  private shouldRecoverMissingPermissionEvents(
    snapshot: RemoteDetachedWorkerSnapshot,
    afterWorkerSeq: number
  ): boolean {
    return (
      afterWorkerSeq > 0 &&
      snapshot.events.length === 0 &&
      snapshot.state.status === "running" &&
      !Number.isFinite(snapshot.state.pid) &&
      !Number.isFinite(snapshot.state.pgid) &&
      (snapshot.state.workerCursorSeq ?? 0) >= afterWorkerSeq
    );
  }

  private async projectWorkerEvent(
    conversationId: string,
    runId: string,
    participantId: string,
    event: RemoteWorkerEvent
  ): Promise<void> {
    const existing = await this.readRecords(runId);
    const existingRecord = existing.find((record) => record.workerSeq === event.workerSeq || record.id === this.workerRecordId(runId, event));
    if (existingRecord) {
      if (existingRecord.kind === "permission_pending" && this.connectedRuns.get(runId) === true) {
        await this.chat.applyRemoteRunReplayRecord(existingRecord);
      }
      return;
    }
    const input = this.workerEventToRecordInput(conversationId, runId, participantId, event);
    if (!input) {
      return;
    }
    await this.appendSpoolRecord({
      ...input,
      id: this.workerRecordId(runId, event),
      workerSeq: event.workerSeq,
      createdAt: event.createdAt
    });
  }

  private async projectSnapshotTerminalFallback(
    conversationId: string | undefined,
    runId: string,
    participantId: string | undefined,
    snapshot: RemoteDetachedWorkerSnapshot
  ): Promise<void> {
    if (!this.isTerminalStatus(snapshot.state.status)) {
      return;
    }
    if (snapshot.events.some((event) => event.kind === "terminal_state")) {
      return;
    }
    const existing = await this.readRecords(runId);
    if (existing.some((record) => record.kind === "terminal_state")) {
      return;
    }
    const resolvedConversationId = conversationId ?? snapshot.state.conversationId ?? await this.conversationIdForRun(runId);
    const resolvedParticipantId = participantId ?? snapshot.state.participantId ?? await this.participantIdForRun(runId).catch(() => undefined);
    if (resolvedParticipantId) {
      this.detachedContextByRun.set(runId, {
        conversationId: resolvedConversationId,
        participantId: resolvedParticipantId
      });
    }
    await this.markTerminal(
      resolvedConversationId,
      runId,
      snapshot.state.status,
      snapshot.state.error ?? (snapshot.state.status === "cancelled" ? "cancelled" : undefined)
    );
  }

  private workerEventToRecordInput(
    conversationId: string,
    runId: string,
    participantId: string,
    event: RemoteWorkerEvent
  ): RemoteRunRecordInput | undefined {
    if (event.kind === "lifecycle") {
      const state = event.state === "detached_started" ? "started" : event.state;
      return {
        kind: "lifecycle",
        conversationId,
        runId,
        state,
        message: event.message
      };
    }
    if (event.kind === "provider_output") {
      return {
        kind: "provider_output",
        conversationId,
        runId,
        participantId,
        stream: event.stream,
        content: event.content
      };
    }
    if (event.kind === "provider_result") {
      return {
        kind: "provider_result",
        conversationId,
        runId,
        participantId,
        ok: event.ok,
        content: event.content,
        exitCode: event.exitCode,
        error: event.error,
        sessionId: event.sessionId,
        durationMs: event.durationMs,
        sourceMessageId: event.sourceMessageId,
        threadId: event.threadId,
        chatThreadRootId: event.chatThreadRootId
      };
    }
    if (event.kind === "permission_pending") {
      return {
        kind: "permission_pending",
        conversationId,
        runId,
        participantId,
        roleConfigVersion: event.roleConfigVersion,
        triggerMessageId: event.triggerMessageId,
        requestId: event.requestId ?? this.workerRecordId(runId, event),
        request: event.request,
        runPermissions: event.runPermissions
      };
    }
    if (event.kind === "terminal_state") {
      return {
        kind: "terminal_state",
        conversationId,
        runId,
        status: event.status,
        reason: event.reason
      };
    }
    return undefined;
  }

  private workerRecordId(runId: string, event: RemoteWorkerEvent): string {
    if (event.kind === "provider_result") {
      return `${runId}:final`;
    }
    return `${runId}:worker:${event.workerSeq}`;
  }

  private async lastProjectedWorkerSeq(runId: string): Promise<number> {
    const records = await this.readRecords(runId);
    return records.reduce((max, record) => Math.max(max, record.workerSeq ?? 0), 0);
  }

  private async conversationIdForRun(runId: string): Promise<string> {
    const records = await this.readRecords(runId);
    const conversationId = records[0]?.conversationId;
    if (!conversationId) {
      throw new Error(`Remote run ${runId} has no local projection yet.`);
    }
    return conversationId;
  }

  private async participantIdForRun(runId: string): Promise<string> {
    const records = await this.readRecords(runId);
    for (const record of records) {
      if ("participantId" in record && typeof record.participantId === "string") {
        return record.participantId;
      }
    }
    throw new Error(`Remote run ${runId} has no projected participant yet.`);
  }

  // Mirror-sync mode. Resolves the per-project mirror path under the worker
  // root, up-syncs the local project into it (unless another live run is
  // already working there), and returns the sync info recorded for the run.
  private async prepareMirrorForRun(
    runId: string,
    request: RemoteRunDetachedStartRequest
  ): Promise<RemoteRunSyncInfo | undefined> {
    const localPath = request.sync?.localPath?.trim();
    if (!localPath || request.repoPath) {
      return undefined;
    }
    const sshPath = request.worker.sshPath?.trim() || "ssh";
    const target = buildCloudRunSshTarget(request.worker);
    const sshBaseArgs = remoteSshBaseArgs(request.worker, target);
    const resolvedRoot = await resolveRemoteRunDir(
      sshPath,
      sshBaseArgs,
      remoteWorkerRootForTarget(request.worker),
      request.signal
    );
    const remotePath = remoteMirrorPath(resolvedRoot, localPath);
    const sync: RemoteRunSyncInfo = { localPath: path.resolve(localPath), remotePath };
    if ((this.activeRunsByMirror.get(remotePath)?.size ?? 0) > 0) {
      // Another live run is working in this mirror; re-syncing with --delete
      // would wipe its in-progress work. Reuse the mirror as-is, matching
      // local-run semantics where concurrent participants share the live dir.
      this.syncLogger?.("remote-run.sync.up.skipped-busy", { runId, remotePath });
      await this.emitDetachedPhase(runId, request, "syncing-files", "Using active project mirror");
      this.registerRunSync(runId, sync);
      return sync;
    }
    const startedAt = Date.now();
    await this.emitDetachedPhase(runId, request, "syncing-files", "Syncing project files");
    await this.chainMirrorOp(remotePath, () => this.mirrorSync.syncUp({
      worker: request.worker,
      localPath: sync.localPath,
      remotePath,
      signal: request.signal
    }));
    this.syncLogger?.("remote-run.sync.up", { runId, remotePath, durationMs: Date.now() - startedAt });
    await this.emitDetachedPhase(runId, request, "syncing-files", "Project files synced");
    this.registerRunSync(runId, sync);
    return sync;
  }

  private remoteRunPhase(
    phase: ChatRemoteRunStatus["phase"],
    label: string,
    detail?: string
  ): ChatRemoteRunStatus {
    const now = new Date().toISOString();
    return {
      phase,
      label,
      ...(detail ? { detail } : {}),
      startedAt: now,
      updatedAt: now,
      ...(phase === "processing-request" ? { processingStartedAt: now } : {})
    };
  }

  private async emitDetachedPhase(
    runId: string,
    request: RemoteRunDetachedStartRequest,
    phase: ChatRemoteRunStatus["phase"],
    label: string,
    detail?: string
  ): Promise<void> {
    const status = this.remoteRunPhase(phase, label, detail);
    request.onPhase?.(status);
    await this.appendSpoolRecord({
      kind: "lifecycle",
      conversationId: request.conversationId,
      runId,
      state: "started",
      message: label,
      remoteRunStatus: status
    });
  }

  private async remoteSandboxOptionsForRun(
    request: RemoteRunDetachedStartRequest,
    sync: RemoteRunSyncInfo | undefined,
    effectiveRepoPath: string | undefined
  ): Promise<CodexExecRemoteSandboxOptions> {
    if (!effectiveRepoPath) {
      return { networkAccess: true };
    }
    let hasGitDir = false;
    if (sync) {
      hasGitDir = localProjectHasGitDir(sync.localPath);
    } else {
      try {
        hasGitDir = await this.remoteGitDirProbe(request.worker, `${effectiveRepoPath}/.git`, request.signal);
      } catch {
        hasGitDir = false;
      }
    }
    return {
      networkAccess: true,
      gitWritableRoot: hasGitDir ? `${effectiveRepoPath}/.git` : undefined
    };
  }

  private async ensureRemoteToolchainPreflight(
    worker: RemoteRunWorkerTarget,
    options: RemoteRunToolchainPreflightOptions | undefined,
    signal: AbortSignal | undefined
  ): Promise<ToolchainPreflightIssue[]> {
    if (options?.skip) {
      return [];
    }
    const requirements = await detectRepoToolchainRequirements(options?.localRepoPath);
    if (requirements.length === 0) {
      return [];
    }
    const localIssues = requirements
      .filter((requirement) => requirement.unsupportedOnLinux)
      .map((requirement) => issueFromRequirement(requirement, "unsupported"));
    const probeRequirements = requirements.filter((requirement) => !requirement.unsupportedOnLinux);
    let remoteIssues: ToolchainPreflightIssue[] = [];
    if (probeRequirements.length > 0) {
      const cacheKey = JSON.stringify({
        worker: [worker.host, worker.user, worker.port, worker.codexPath],
        requirements: probeRequirements
      });
      const cached = this.toolchainPreflightCache.get(cacheKey);
      if (cached) {
        remoteIssues = cached;
      } else {
        try {
          remoteIssues = await this.detachedWorkerTransport.preflight({ worker, requirements: probeRequirements, signal });
          this.toolchainPreflightCache.set(cacheKey, remoteIssues);
        } catch (error) {
          throw new RemoteRunPreflightInfrastructureError(error instanceof Error ? error.message : String(error));
        }
      }
    }
    const blocking = [...localIssues, ...remoteIssues].filter((issue) => issue.severity === "required");
    if (blocking.length > 0) {
      throw new RemoteRunPreflightError(blocking);
    }
    return [...localIssues, ...remoteIssues].filter((issue) => issue.severity === "advisory");
  }

  // Explicit, user-initiated write-back: rsync the mirror's working tree into
  // the local project directory (.git and node_modules excluded). Never called
  // automatically — the local tree is only mutated on demand, so a long remote
  // run cannot silently overwrite concurrent local edits.
  async pullMirrorForRun(runId: string): Promise<void> {
    const sync = this.detachedSyncByRun.get(runId);
    if (!sync) {
      throw new Error(`Remote run ${runId} has no mirror-sync information.`);
    }
    const worker = this.detachedWorkerByRun.get(runId);
    if (!worker) {
      throw new Error(`Remote run ${runId} has no known worker.`);
    }
    const remotePath = sync.remotePath ?? await this.resolveMirrorPathForSync(worker, sync);
    if (!remotePath) {
      throw new Error(`Remote run ${runId} mirror path could not be resolved.`);
    }
    const startedAt = Date.now();
    try {
      await this.chainMirrorOp(remotePath, () => this.mirrorSync.syncDown({
        worker,
        localPath: sync.localPath,
        remotePath
      }));
      this.syncLogger?.("remote-run.sync.down", { runId, remotePath, durationMs: Date.now() - startedAt });
    } catch (error) {
      this.syncLogger?.("remote-run.sync.down.error", {
        runId,
        remotePath,
        message: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  // Terminal runs stop counting toward mirror busyness so the next run on the
  // same project up-syncs a fresh mirror again.
  private releaseMirrorForRun(runId: string): void {
    const sync = this.detachedSyncByRun.get(runId);
    if (sync?.remotePath) {
      this.untrackMirrorRun(sync.remotePath, runId);
    }
  }

  // A handle recorded before launch may know only the local path; resolve the
  // deterministic mirror path from the worker root when down-syncing after a
  // desktop restart.
  private async resolveMirrorPathForSync(
    worker: RemoteRunWorkerTarget,
    sync: RemoteRunSyncInfo
  ): Promise<string | undefined> {
    try {
      const sshPath = worker.sshPath?.trim() || "ssh";
      const target = buildCloudRunSshTarget(worker);
      const sshBaseArgs = remoteSshBaseArgs(worker, target);
      const resolvedRoot = await resolveRemoteRunDir(sshPath, sshBaseArgs, remoteWorkerRootForTarget(worker), undefined);
      return remoteMirrorPath(resolvedRoot, sync.localPath);
    } catch {
      return undefined;
    }
  }

  private registerRunSync(runId: string, sync: RemoteRunSyncInfo): void {
    this.detachedSyncByRun.set(runId, sync);
    if (sync.remotePath) {
      const runs = this.activeRunsByMirror.get(sync.remotePath) ?? new Set<string>();
      runs.add(runId);
      this.activeRunsByMirror.set(sync.remotePath, runs);
    }
  }

  private forgetRunSync(runId: string): void {
    const sync = this.detachedSyncByRun.get(runId);
    if (sync?.remotePath) {
      this.untrackMirrorRun(sync.remotePath, runId);
    }
    this.detachedSyncByRun.delete(runId);
  }

  private untrackMirrorRun(remotePath: string, runId: string): void {
    const runs = this.activeRunsByMirror.get(remotePath);
    if (!runs) {
      return;
    }
    runs.delete(runId);
    if (runs.size === 0) {
      this.activeRunsByMirror.delete(remotePath);
    }
  }

  // Serialize rsync operations per mirror so an up-sync for a new run and a
  // down-sync for a finishing run never interleave on the same directory.
  private async chainMirrorOp<T>(mirrorPath: string, op: () => Promise<T>): Promise<T> {
    const previous = this.mirrorOpChainByPath.get(mirrorPath) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(op);
    this.mirrorOpChainByPath.set(mirrorPath, next.then(() => undefined, () => undefined));
    return next;
  }

  private async appendSpoolRecord(
    input: RemoteRunRecordInputWithOverrides
  ): Promise<{ record: RemoteRunReplayRecord; applyResults: RemoteRunApplyRecordResult[] }> {
    if (input.kind === "terminal_state") {
      this.releaseMirrorForRun(input.runId);
    }
    return this.withRunAppend(input.runId, async () => {
      const seq = await this.nextSeq(input.runId);
      const { id, createdAt, workerSeq, ...payload } = input;
      const record = {
        id: id ?? (payload.kind === "permission_pending" ? payload.requestId ?? randomUUID() : randomUUID()),
        createdAt: createdAt ?? new Date().toISOString(),
        ...payload,
        ...(workerSeq !== undefined ? { workerSeq } : {}),
        seq
      } as RemoteRunReplayRecord;
      if (record.kind === "permission_pending" && !record.requestId) {
        record.requestId = record.id;
      }
      await mkdir(this.spoolRoot, { recursive: true });
      await appendFile(this.spoolPath(input.runId), `${JSON.stringify(record)}\n`, "utf8");
      const applyResults = this.connectedRuns.get(input.runId) === true
        ? await this.applyFromCursor(input.runId)
        : [];
      return { record, applyResults };
    });
  }

  // Serialize appends per run so monotonic seq allocation and the file write
  // are atomic. Without this, concurrent worker output and the decision
  // write-back (fired from the approval listener) can read the same max seq
  // and collide, breaking ordered replay.
  private async withRunAppend<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.appendChainByRun.get(runId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.appendChainByRun.set(runId, previous.then(() => gate));
    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  // In-memory monotonic seq per run, seeded once from the spool tail so a
  // restarted service (or a second instance over the same spool) continues the
  // sequence instead of restarting it. Called only inside withRunAppend.
  private async nextSeq(runId: string): Promise<number> {
    let current = this.seqByRun.get(runId);
    if (current === undefined) {
      const records = await this.readRecords(runId);
      current = records.reduce((max, record) => Math.max(max, record.seq), 0);
    }
    const next = current + 1;
    this.seqByRun.set(runId, next);
    return next;
  }

  private async appendSpoolRecordForKnownRun(
    runId: string,
    state: RemoteRunLifecycleRecord["state"]
  ): Promise<void> {
    const records = await this.readRecords(runId);
    const conversationId = records[0]?.conversationId;
    if (!conversationId) {
      return;
    }
    await this.appendSpoolRecord({
      kind: "lifecycle",
      conversationId,
      runId,
      state
    });
  }

  private async appendPermissionDecision(event: ChatAppToolApprovalDecisionEvent): Promise<void> {
    if (event.approval.toolName !== APP_PERMISSIONS_REQUEST_CHANGE_TOOL || !event.approval.resumeContext?.runId) {
      return;
    }
    const runId = event.approval.resumeContext.runId;
    const records = await this.readRecords(runId);
    const hasRequest = records.some((record) =>
      record.kind === "permission_pending" &&
      (record.requestId ?? record.id) === event.approval.id
    );
    if (!hasRequest) {
      return;
    }
    const hasDecision = records.some((record) =>
      record.kind === "permission_decision" &&
      record.requestId === event.approval.id
    );
    if (hasDecision) {
      return;
    }
    const appended = await this.appendSpoolRecord({
      kind: "permission_decision",
      conversationId: event.conversationId,
      runId,
      requestId: event.approval.id,
      status: event.status,
      approvalScope: event.approval.approvalScope,
      approvalUpdatedAt: event.approval.updatedAt,
      error: event.approval.error
    });
    const worker = this.detachedWorkerByRun.get(runId);
    if (worker && this.detachedWorkerTransport.writePermissionDecision) {
      await this.detachedWorkerTransport.writePermissionDecision({
        runId,
        worker,
        decision: appended.record as RemoteRunPermissionDecisionRecord
      }).catch(() => undefined);
    }
  }

  private spoolPath(runId: string): string {
    return path.join(this.spoolRoot, `${this.safeRunId(runId)}.jsonl`);
  }

  private safeRunId(runId: string): string {
    return runId.replace(/[^A-Za-z0-9._-]/g, "_") || "run";
  }

  private remoteWorkerRunDir(worker: RemoteRunWorkerTarget, runId: string): string {
    const root = worker.workerRoot?.trim() || "~/.accordagents/remote-runs";
    return `${root.replace(/\/+$/g, "")}/${this.safeRunId(runId)}`;
  }

  private normalizeRecord(value: unknown): RemoteRunReplayRecord | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    const record = value as Partial<RemoteRunReplayRecord>;
    if (
      typeof record.id !== "string" ||
      typeof record.conversationId !== "string" ||
      typeof record.runId !== "string" ||
      typeof record.seq !== "number" ||
      typeof record.createdAt !== "string" ||
      !this.isRecordKind(record.kind)
    ) {
      return undefined;
    }
    if (record.kind === "output_text") {
      return typeof record.participantId === "string" && typeof record.content === "string"
        ? record as RemoteRunOutputTextRecord
        : undefined;
    }
    if (record.kind === "provider_output") {
      return typeof record.participantId === "string" &&
        (record.stream === "stdout" || record.stream === "stderr") &&
        typeof record.content === "string"
        ? record as RemoteRunProviderOutputRecord
        : undefined;
    }
    if (record.kind === "provider_result") {
      return typeof record.participantId === "string" &&
        typeof record.ok === "boolean" &&
        typeof record.content === "string"
        ? record as RemoteRunProviderResultRecord
        : undefined;
    }
    if (record.kind === "permission_pending") {
      return typeof record.participantId === "string" && this.isPermissionChangeRequest(record.request)
        ? record as RemoteRunPermissionPendingRecord
        : undefined;
    }
    if (record.kind === "permission_decision") {
      return typeof record.requestId === "string" && (record.status === "approved" || record.status === "denied")
        ? record as RemoteRunPermissionDecisionRecord
        : undefined;
    }
    if (record.kind === "terminal_state") {
      return record.status === "completed" || record.status === "cancelled" || record.status === "failed"
        ? record as RemoteRunTerminalStateRecord
        : undefined;
    }
    return record as RemoteRunLifecycleRecord;
  }

  private isRecordKind(kind: unknown): kind is RemoteRunSpoolRecordKind {
    return kind === "lifecycle" ||
      kind === "output_text" ||
      kind === "provider_output" ||
      kind === "provider_result" ||
      kind === "permission_pending" ||
      kind === "permission_decision" ||
      kind === "terminal_state";
  }

  private isTerminalStatus(status: RemoteDetachedRunStatus): status is RemoteRunTerminalStateRecord["status"] {
    return status === "completed" || status === "cancelled" || status === "failed";
  }

  private isPermissionChangeRequest(value: unknown): value is ChatPermissionChangeRequest {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    const record = value as Record<string, unknown>;
    if (record.kind === "githubApp") {
      return typeof record.repository_full_name === "string" &&
        /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(record.repository_full_name.trim()) &&
        Array.isArray(record.permissions) &&
        record.permissions.length > 0 &&
        record.permissions.every((permission) =>
          typeof permission === "string" &&
          /^[A-Za-z0-9_:-]+$/.test(permission.trim())
        );
    }
    return record.kind === "portable" || record.kind === "shellRules" || record.kind === "providerNative";
  }

  private remoteExecutionError(execution: RemoteCodexExecutionResult): string | undefined {
    if (execution.timedOut) {
      return "Remote Codex run timed out.";
    }
    if (execution.exitCode !== 0) {
      const diagnostic = execution.stderr.trim() || execution.stdout.trim();
      return diagnostic
        ? `Remote Codex exited with code ${execution.exitCode}: ${diagnostic}`
        : `Remote Codex exited with code ${execution.exitCode}.`;
    }
    return undefined;
  }
}

class SshDetachedWorkerTransport implements RemoteDetachedWorkerTransport {
  async preflight(request: RemoteToolchainPreflightProbeRequest): Promise<ToolchainPreflightIssue[]> {
    if (request.requirements.length === 0) {
      return [];
    }
    const sshPath = request.worker.sshPath?.trim() || "ssh";
    const target = remoteSshTarget(request.worker);
    const sshBaseArgs = remoteSshBaseArgs(request.worker, target);
    const result = await runCommand(sshPath, [...sshBaseArgs, toolchainProbeScript(request.requirements)], {
      timeoutMs: 30_000,
      signal: request.signal
    });
    return parseToolchainProbeOutput(request.requirements, result.stdout);
  }

  async ensureParticipantSession(
    request: RemoteParticipantSessionEnsureRequest
  ): Promise<RemoteParticipantSessionEnsureResult> {
    const root = await this.ensureSessionProtocol(request.worker, request.signal);
    const sessionKey = remoteParticipantSessionKey(request.conversationId, request.participantId);
    const sessionDir = `${root}/sessions/${sessionKey}`;
    const result = await this.runSessionControl(request.worker, root, "ensure", {
      protocolVersion: REMOTE_SESSION_PROTOCOL_VERSION,
      sessionKey,
      sessionDir,
      conversationId: request.conversationId,
      participantId: request.participantId,
      runtimeFingerprint: request.runtimeFingerprint,
      idleTimeoutMs: request.idleTimeoutMs
    }, request.signal);
    if (result.ok !== true || (result.status !== "warm" && result.status !== "launched")) {
      throw new Error(`Remote participant session could not be prepared (${String(result.status ?? "unknown")}).`);
    }
    return {
      launched: result.status === "launched",
      handle: {
        sessionKey,
        sessionDir,
        worker: workerSettingsFromTarget(request.worker),
        protocolVersion: REMOTE_SESSION_PROTOCOL_VERSION,
        runtimeFingerprint: request.runtimeFingerprint,
        updatedAt: new Date().toISOString()
      }
    };
  }

  async submitTurn(request: RemoteDetachedWorkerLaunchRequest): Promise<RemoteDetachedWorkerSnapshot> {
    const session = request.participantSession;
    if (!session) {
      throw new Error("Remote participant session handle is missing.");
    }
    const root = await resolveRemoteRunDir(
      request.worker.sshPath?.trim() || "ssh",
      remoteSshBaseArgs(request.worker, remoteSshTarget(request.worker)),
      remoteWorkerRootForTarget(request.worker),
      request.signal
    );
    const resolvedRunDir = await resolveRemoteRunDir(
      request.worker.sshPath?.trim() || "ssh",
      remoteSshBaseArgs(request.worker, remoteSshTarget(request.worker)),
      request.remoteRunDir,
      request.signal
    );
    const resolvedFinalPath = `${resolvedRunDir}/final.txt`;
    const invocationArgs = replaceArgValue(request.invocation.args, request.remoteFinalPath, resolvedFinalPath);
    const invocation = {
      runId: request.runId,
      conversationId: request.conversationId,
      participantId: request.participant.id,
      args: invocationArgs,
      input: request.invocation.input,
      env: request.invocation.env ?? {},
      codexPath: request.worker.codexPath?.trim() || "codex",
      remoteCwd: request.worker.remoteCwd?.trim(),
      finalPath: resolvedFinalPath,
      maxRuntimeMs: request.maxRuntimeMs,
      resumeSessionId: resumeSessionIdFromArgs(invocationArgs),
      sourceMessageId: request.sourceMessageId,
      threadId: request.threadId,
      chatThreadRootId: request.chatThreadRootId
    };
    const result = await this.runSessionControl(request.worker, root, "submit", {
      sessionDir: session.sessionDir,
      runId: request.runId,
      runDir: resolvedRunDir,
      prompt: request.invocation.input,
      invocation,
      contextSnapshot: request.contextSnapshot ?? null
    }, request.signal);
    if (result.ok !== true) {
      throw new Error(`Remote participant session rejected the turn (${String(result.status ?? "unknown")}).`);
    }
    const runStatus = typeof result.runStatus === "string" ? result.runStatus : "accepted";
    if (runStatus === "completed" || runStatus === "failed" || runStatus === "cancelled") {
      return this.poll({
        runId: request.runId,
        worker: request.worker,
        afterWorkerSeq: 0,
        signal: request.signal
      });
    }
    return {
      state: {
        runId: request.runId,
        conversationId: request.conversationId,
        participantId: request.participant.id,
        status: "running",
        acceptedAt: new Date().toISOString()
      },
      events: []
    };
  }

  async inspectParticipantSession(
    request: RemoteParticipantSessionInspectRequest
  ): Promise<RemoteParticipantSessionInspectResult> {
    const worker = targetFromSessionHandle(request.handle);
    const root = await this.ensureSessionProtocol(worker, request.signal);
    const result = await this.runSessionControl(worker, root, "inspect", {
      sessionDir: request.handle.sessionDir
    }, request.signal);
    const state = result.state && typeof result.state === "object"
      ? result.state as Record<string, unknown>
      : {};
    return {
      status: result.status === "live" ? "live" : result.status === "stopped" ? "stopped" : "unknown",
      activeRunId: typeof state.activeRunId === "string" ? state.activeRunId : undefined,
      queuedRunIds: Array.isArray(state.queuedRunIds)
        ? state.queuedRunIds.filter((value): value is string => typeof value === "string")
        : undefined,
      providerSessionId: state.providerSessionValid === false
        ? undefined
        : typeof state.providerSessionId === "string" ? state.providerSessionId : undefined,
      providerSessionValid: typeof state.providerSessionValid === "boolean" ? state.providerSessionValid : undefined
    };
  }

  async listParticipantSessions(worker: RemoteRunWorkerTarget): Promise<RemoteParticipantSessionDiscovery[]> {
    const root = await this.ensureSessionProtocol(worker, undefined);
    const result = await this.runSessionControl(worker, root, "list-sessions", {}, undefined);
    const sessions = Array.isArray(result.sessions) ? result.sessions : [];
    const now = new Date().toISOString();
    return sessions.flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return [];
      }
      const record = value as Record<string, unknown>;
      const sessionDir = typeof record.sessionDir === "string" ? record.sessionDir : undefined;
      const sessionKey = typeof record.sessionKey === "string" ? record.sessionKey : undefined;
      if (!sessionDir || !sessionKey) {
        return [];
      }
      const queuedRunIds = Array.isArray(record.queuedRunIds)
        ? record.queuedRunIds.filter((item): item is string => typeof item === "string")
        : undefined;
      return [{
        handle: {
          sessionKey,
          sessionDir,
          worker: workerSettingsFromTarget(worker),
          protocolVersion: typeof record.protocolVersion === "number"
            ? record.protocolVersion
            : REMOTE_SESSION_PROTOCOL_VERSION,
          runtimeFingerprint: typeof record.runtimeFingerprint === "string"
            ? record.runtimeFingerprint
            : "unknown",
          updatedAt: now
        },
        conversationId: typeof record.conversationId === "string" ? record.conversationId : undefined,
        participantId: typeof record.participantId === "string" ? record.participantId : undefined,
        status: record.status === "live" ? "live" as const : record.status === "stopped" ? "stopped" as const : "unknown" as const,
        activeRunId: typeof record.activeRunId === "string" ? record.activeRunId : undefined,
        queuedRunIds,
        hasQueuedTurns: record.hasQueuedTurns === true,
        providerSessionId: record.providerSessionValid === false
          ? undefined
          : typeof record.providerSessionId === "string" ? record.providerSessionId : undefined,
        providerSessionValid: typeof record.providerSessionValid === "boolean" ? record.providerSessionValid : undefined
      }];
    });
  }

  async stopParticipantSessionIfIdle(request: RemoteParticipantSessionStopRequest): Promise<boolean> {
    const worker = targetFromSessionHandle(request.handle);
    const root = await this.ensureSessionProtocol(worker, request.signal);
    try {
      const result = await this.runSessionControl(worker, root, "stop-session", {
        sessionDir: request.handle.sessionDir,
        remove: request.remove === true,
        removeArtifacts: request.removeArtifacts === true,
        runIds: request.runIds ?? [],
        providerSessionIds: request.providerSessionIds ?? []
      }, request.signal);
      return result.ok === true && result.status === "stopped";
    } catch (error) {
      if (error instanceof RemoteSessionControlError && error.status === "busy") {
        return false;
      }
      throw error;
    }
  }

  async authorizeAutomaticStop(
    worker: RemoteRunWorkerTarget,
    ownerId: string
  ): Promise<RemoteWorkerStopAuthorization> {
    const root = await this.ensureSessionProtocol(worker, undefined);
    try {
      const result = await this.runSessionControl(worker, root, "authorize-stop", {
        protocolVersion: REMOTE_SESSION_PROTOCOL_VERSION,
        ownerId,
        ttlMs: REMOTE_STOP_DRAIN_LEASE_MS
      }, undefined);
      const lease = result.lease && typeof result.lease === "object"
        ? result.lease as Record<string, unknown>
        : undefined;
      if (result.ok === true && lease && typeof lease.leaseId === "string" && typeof lease.expiresAt === "string") {
        return { allowed: true, lease: { leaseId: lease.leaseId, expiresAt: lease.expiresAt } };
      }
      return { allowed: false, reason: String(result.status ?? "worker denied stop") };
    } catch (error) {
      if (error instanceof RemoteSessionControlError) {
        return { allowed: false, reason: error.status };
      }
      throw error;
    }
  }

  async renewAutomaticStopLease(
    worker: RemoteRunWorkerTarget,
    lease: RemoteWorkerStopLease
  ): Promise<RemoteWorkerStopLease> {
    const root = await this.ensureSessionProtocol(worker, undefined);
    const result = await this.runSessionControl(worker, root, "renew-stop", {
      leaseId: lease.leaseId,
      ttlMs: REMOTE_STOP_DRAIN_SHUTDOWN_LEASE_MS
    }, undefined);
    const renewed = result.lease && typeof result.lease === "object"
      ? result.lease as Record<string, unknown>
      : undefined;
    if (result.ok !== true || !renewed || typeof renewed.expiresAt !== "string") {
      throw new Error("Remote automatic-stop lease could not be renewed.");
    }
    return { leaseId: lease.leaseId, expiresAt: renewed.expiresAt };
  }

  async releaseAutomaticStopLease(worker: RemoteRunWorkerTarget, lease: RemoteWorkerStopLease): Promise<void> {
    const root = await this.ensureSessionProtocol(worker, undefined);
    await this.runSessionControl(worker, root, "release-stop", { leaseId: lease.leaseId }, undefined);
  }

  async acquireOperationLease(
    worker: RemoteRunWorkerTarget,
    ownerId: string,
    kind: string
  ): Promise<RemoteWorkerOperationLease> {
    const leaseId = randomUUID();
    const result = await this.runOperationLeaseShell(worker, "acquire", leaseId, ownerId, kind);
    return this.parseOperationLease(result, ownerId, kind);
  }

  async renewOperationLease(
    worker: RemoteRunWorkerTarget,
    lease: RemoteWorkerOperationLease
  ): Promise<RemoteWorkerOperationLease> {
    const result = await this.runOperationLeaseShell(
      worker,
      "renew",
      lease.leaseId,
      lease.ownerId,
      lease.kind
    );
    return this.parseOperationLease(result, lease.ownerId, lease.kind);
  }

  async releaseOperationLease(worker: RemoteRunWorkerTarget, lease: RemoteWorkerOperationLease): Promise<void> {
    await this.runOperationLeaseShell(worker, "release", lease.leaseId, lease.ownerId, lease.kind);
  }

  async launch(request: RemoteDetachedWorkerLaunchRequest): Promise<RemoteDetachedWorkerSnapshot> {
    const sshPath = request.worker.sshPath?.trim() || "ssh";
    const target = remoteSshTarget(request.worker);
    const sshBaseArgs = remoteSshBaseArgs(request.worker, target);
    const resolvedRunDir = await resolveRemoteRunDir(sshPath, sshBaseArgs, request.remoteRunDir, request.signal);
    const resolvedFinalPath = `${resolvedRunDir}/final.txt`;
    const invocationArgs = replaceArgValue(request.invocation.args, request.remoteFinalPath, resolvedFinalPath);
    const config = {
      runId: request.runId,
      conversationId: request.conversationId,
      participantId: request.participant.id,
      args: invocationArgs,
      input: request.invocation.input,
      env: request.invocation.env ?? {},
      codexPath: request.worker.codexPath?.trim() || "codex",
      remoteCwd: request.worker.remoteCwd?.trim(),
      finalPath: resolvedFinalPath,
      maxRuntimeMs: request.maxRuntimeMs,
      resumeSessionId: resumeSessionIdFromArgs(invocationArgs),
      sourceMessageId: request.sourceMessageId,
      threadId: request.threadId,
      chatThreadRootId: request.chatThreadRootId
    };
    await runCommand(sshPath, [...sshBaseArgs, `mkdir -p ${shellQuote(resolvedRunDir)}`], {
      timeoutMs: 30_000,
      signal: request.signal
    });
    await writeRemoteFile(sshPath, sshBaseArgs, `${resolvedRunDir}/prompt.txt`, request.invocation.input, request.signal);
    await writeRemoteFile(sshPath, sshBaseArgs, `${resolvedRunDir}/invocation.json`, JSON.stringify(config), request.signal);
    await writeRemoteFile(sshPath, sshBaseArgs, `${resolvedRunDir}/context-snapshot.json`, JSON.stringify(request.contextSnapshot ?? null), request.signal);
    await writeRemoteFile(sshPath, sshBaseArgs, `${resolvedRunDir}/worker.js`, detachedWorkerScript(), request.signal);
    const start = [
      `cd ${shellQuote(resolvedRunDir)} || exit 125`,
      "rm -f exit.json",
      "touch events.jsonl decisions.jsonl stdout.log stderr.log",
      `setsid node worker.js >/dev/null 2>&1 </dev/null & echo $! > wrapper.pid`
    ].join("; ");
    await runCommand(sshPath, [...sshBaseArgs, start], {
      timeoutMs: 30_000,
      signal: request.signal
    });
    return await this.waitForLaunchAck(request.worker, request.runId, request.signal);
  }

  async poll(request: RemoteDetachedWorkerPollRequest): Promise<RemoteDetachedWorkerSnapshot> {
    const sshPath = request.worker.sshPath?.trim() || "ssh";
    const target = remoteSshTarget(request.worker);
    const sshBaseArgs = remoteSshBaseArgs(request.worker, target);
    const runDir = await resolveRemoteRunDir(
      sshPath,
      sshBaseArgs,
      remoteWorkerRunDirForTarget(request.worker, request.runId),
      request.signal
    );
    let [state, events, exit] = await Promise.all([
      readRemoteJson<RemoteDetachedRunState>(sshPath, sshBaseArgs, `${runDir}/state.json`, request.signal),
      readRemoteWorkerEvents(sshPath, sshBaseArgs, `${runDir}/events.jsonl`, request.afterWorkerSeq, request.signal),
      readRemoteJson<RemoteDetachedRunState>(sshPath, sshBaseArgs, `${runDir}/exit.json`, request.signal)
    ]);
    if (state?.status === "running" && !exit) {
      let workerStopped = false;
      try {
        const root = await resolveRemoteRunDir(
          sshPath,
          sshBaseArgs,
          remoteWorkerRootForTarget(request.worker),
          request.signal
        );
        const identity = await this.runSessionControl(request.worker, root, "inspect-run", {
          runDir
        }, request.signal);
        workerStopped = identity.status === "stopped";
      } catch {
        // A failed identity probe is not evidence that detached work died.
        workerStopped = false;
      }
      if (workerStopped) {
        // The worker's last acts are: append the terminal events, write
        // exit.json, write terminal state.json, exit. A completion racing this
        // poll therefore looks exactly like a crash until exit.json is
        // re-read. Without this re-read the run is misreported as failed and
        // the provider_result carrying the final message is never projected.
        exit = await readRemoteJson<RemoteDetachedRunState>(sshPath, sshBaseArgs, `${runDir}/exit.json`, request.signal);
        if (!exit) {
          return {
            state: {
              ...state,
              status: "failed",
              completedAt: new Date().toISOString(),
              error: "Remote worker process exited without writing exit.json."
            },
            events
          };
        }
      }
    }
    // exit.json (and terminal state.json) are written strictly after the
    // terminal events, but the parallel reads above can see the exit while the
    // slightly-earlier events read missed the tail. Re-read events once so a
    // terminal snapshot always carries its provider_result/terminal_state
    // records instead of forcing the synthesized-terminal fallback.
    const terminalSeen = Boolean(exit) || (state ? state.status !== "running" && state.status !== "unknown" : false);
    if (terminalSeen && !events.some((event) => event.kind === "terminal_state")) {
      events = await readRemoteWorkerEvents(sshPath, sshBaseArgs, `${runDir}/events.jsonl`, request.afterWorkerSeq, request.signal);
    }
    return {
      state: exit
        ? { ...state, ...exit, runId: request.runId }
        : state ?? {
        runId: request.runId,
        status: "unknown"
      },
      events
    };
  }

  async cancel(request: RemoteDetachedWorkerCancelRequest): Promise<RemoteDetachedWorkerSnapshot> {
    const sshPath = request.worker.sshPath?.trim() || "ssh";
    const sshBaseArgs = remoteSshBaseArgs(request.worker, remoteSshTarget(request.worker));
    const root = await this.ensureSessionProtocol(request.worker, request.signal);
    const runDir = await resolveRemoteRunDir(
      sshPath,
      sshBaseArgs,
      remoteWorkerRunDirForTarget(request.worker, request.runId),
      request.signal
    );
    await this.runSessionControl(request.worker, root, "cancel-run", {
      runId: request.runId,
      runDir,
      reason: request.reason ?? "cancelled"
    }, request.signal);
    const snapshot = await this.poll({
      runId: request.runId,
      worker: request.worker,
      afterWorkerSeq: 0,
      signal: request.signal
    });
    const hasTerminal = snapshot.events.some((event) => event.kind === "terminal_state");
    if (hasTerminal) {
      return snapshot;
    }
    if (snapshot.state.status !== "running") {
      return snapshot;
    }
    const completedAt = new Date().toISOString();
    return {
      state: {
        ...(snapshot.state ?? { runId: request.runId }),
        runId: request.runId,
        status: "cancelled",
        completedAt,
        error: request.reason ?? "cancelled"
      },
      events: snapshot.events
    };
  }

  async writePermissionDecision(request: RemoteDetachedWorkerDecisionRequest): Promise<void> {
    const sshPath = request.worker.sshPath?.trim() || "ssh";
    const target = remoteSshTarget(request.worker);
    const sshBaseArgs = remoteSshBaseArgs(request.worker, target);
    const runDir = await resolveRemoteRunDir(
      sshPath,
      sshBaseArgs,
      remoteWorkerRunDirForTarget(request.worker, request.runId),
      request.signal
    );
    await runCommand(sshPath, [
      ...sshBaseArgs,
      `mkdir -p ${shellQuote(runDir)}; cat >> ${shellQuote(`${runDir}/decisions.jsonl`)}`
    ], {
      input: `${JSON.stringify(request.decision)}\n`,
      timeoutMs: 30_000,
      signal: request.signal
    });
  }

  async reapExpiredRuns(request: RemoteDetachedWorkerReapRequest): Promise<RemoteDetachedWorkerSnapshot[]> {
    const sshPath = request.worker.sshPath?.trim() || "ssh";
    const target = remoteSshTarget(request.worker);
    const sshBaseArgs = remoteSshBaseArgs(request.worker, target);
    const root = await resolveRemoteRunDir(
      sshPath,
      sshBaseArgs,
      remoteWorkerRootForTarget(request.worker),
      request.signal
    );
    const runDirs = await listRemoteRunDirs(sshPath, sshBaseArgs, root, request.signal);
    const snapshots: RemoteDetachedWorkerSnapshot[] = [];
    for (const runDir of runDirs) {
      const state = await readRemoteJson<RemoteDetachedRunState>(sshPath, sshBaseArgs, `${runDir}/state.json`, request.signal);
      if (!state?.runId) {
        continue;
      }
      const snapshot = await this.poll({
        runId: state.runId,
        worker: request.worker,
        afterWorkerSeq: 0,
        signal: request.signal
      });
      if (snapshot.state.status !== "running" && snapshot.state.status !== "unknown") {
        snapshots.push(snapshot);
      }
    }
    return snapshots;
  }

  private async waitForLaunchAck(
    worker: RemoteRunWorkerTarget,
    runId: string,
    signal: AbortSignal | undefined
  ): Promise<RemoteDetachedWorkerSnapshot> {
    // Cold-start tolerance: a fresh worker on a small box needs SSH + setsid +
    // node + relay bind before it writes a "running" state (~14s observed even
    // with no repo to clone). A 10s window falsely failed slow-but-healthy
    // launches with "did not acknowledge launch" while the worker went on to
    // run and complete successfully, orphaning the result. Give cold starts a
    // realistic window to acknowledge.
    const deadline = Date.now() + 60_000;
    let latest: RemoteDetachedWorkerSnapshot | undefined;
    while (Date.now() < deadline) {
      latest = await this.poll({ runId, worker, afterWorkerSeq: 0, signal });
      const hasDetachedStart = latest.events.some((event) =>
        event.kind === "lifecycle" && event.state === "detached_started"
      );
      if (
        latest.state.status === "running" &&
        Number.isFinite(latest.state.pid) &&
        Number.isFinite(latest.state.pgid) &&
        hasDetachedStart
      ) {
        return latest;
      }
      await sleep(200);
    }
    const status = latest?.state.status ?? "unknown";
    throw new Error(`Remote detached worker did not acknowledge launch; last status was ${status}.`);
  }

  private async ensureSessionProtocol(worker: RemoteRunWorkerTarget, signal: AbortSignal | undefined): Promise<string> {
    const sshPath = worker.sshPath?.trim() || "ssh";
    const target = remoteSshTarget(worker);
    const sshBaseArgs = remoteSshBaseArgs(worker, target);
    const root = await resolveRemoteRunDir(sshPath, sshBaseArgs, remoteWorkerRootForTarget(worker), signal);
    let currentVersion = 0;
    try {
      const result = await runCommand(sshPath, [...sshBaseArgs, `cat ${shellQuote(`${root}/protocol.json`)}`], {
        timeoutMs: 30_000,
        signal
      });
      const parsed = JSON.parse(result.stdout) as { version?: unknown };
      currentVersion = typeof parsed.version === "number" ? parsed.version : 0;
    } catch {
      currentVersion = 0;
    }
    if (currentVersion !== REMOTE_SESSION_PROTOCOL_VERSION) {
      await runCommand(sshPath, [...sshBaseArgs, `mkdir -p ${shellQuote(root)}`], {
        timeoutMs: 30_000,
        signal
      });
      const installerPath = `${root}/session-installer-${randomUUID()}.js`;
      await writeRemoteFile(sshPath, sshBaseArgs, installerPath, remoteSessionInstallerScript(), signal);
      try {
        const result = await runCommand(sshPath, [
          ...sshBaseArgs,
          `node ${shellQuote(installerPath)} ${shellQuote(root)}`
        ], {
          input: JSON.stringify({
            version: REMOTE_SESSION_PROTOCOL_VERSION,
            files: {
              "session-control.js": remoteSessionControlScript(),
              "session-supervisor.js": remoteSessionSupervisorScript(),
              "run-worker.js": detachedWorkerScript()
            }
          }),
          timeoutMs: 60_000,
          signal
        });
        const installed = JSON.parse(result.stdout || "{}") as { ok?: unknown; status?: unknown };
        if (installed.ok !== true) {
          throw new Error(`Remote session protocol installation failed (${String(installed.status ?? "unknown")}).`);
        }
      } finally {
        await runCommand(sshPath, [...sshBaseArgs, `rm -f ${shellQuote(installerPath)}`], {
          timeoutMs: 30_000,
          signal
        }).catch(() => undefined);
      }
    }
    return root;
  }

  private parseOperationLease(
    result: Record<string, unknown>,
    ownerId: string,
    kind: string
  ): RemoteWorkerOperationLease {
    const lease = result.lease && typeof result.lease === "object"
      ? result.lease as Record<string, unknown>
      : undefined;
    if (
      result.ok !== true ||
      !lease ||
      typeof lease.leaseId !== "string" ||
      typeof lease.expiresAt !== "string"
    ) {
      throw new Error(`Worker operation lease failed (${String(result.status ?? "unknown")}).`);
    }
    return {
      leaseId: lease.leaseId,
      ownerId,
      kind,
      expiresAt: lease.expiresAt
    };
  }

  private async runOperationLeaseShell(
    worker: RemoteRunWorkerTarget,
    action: "acquire" | "renew" | "release",
    leaseId: string,
    ownerId: string,
    kind: string
  ): Promise<Record<string, unknown>> {
    const sshPath = worker.sshPath?.trim() || "ssh";
    const sshBaseArgs = remoteSshBaseArgs(worker, remoteSshTarget(worker));
    const root = await resolveRemoteRunDir(
      sshPath,
      sshBaseArgs,
      remoteWorkerRootForTarget(worker),
      undefined
    );
    const command = [
      "sh -s --",
      shellQuote(root),
      shellQuote(action),
      shellQuote(leaseId),
      shellQuote(ownerId),
      shellQuote(kind),
      shellQuote(String(REMOTE_OPERATION_LEASE_MS))
    ].join(" ");
    try {
      const result = await runCommand(sshPath, [...sshBaseArgs, command], {
        input: remoteWorkerOperationLeaseShellScript(),
        timeoutMs: 30_000
      });
      return JSON.parse(result.stdout || "{}") as Record<string, unknown>;
    } catch (error) {
      if (error instanceof CommandError) {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(error.result.stdout || "{}") as Record<string, unknown>;
        } catch {
          parsed = {};
        }
        throw new RemoteSessionControlError(
          typeof parsed.status === "string" ? parsed.status : error.message,
          parsed
        );
      }
      throw error;
    }
  }

  private async runSessionControl(
    worker: RemoteRunWorkerTarget,
    root: string,
    action: string,
    payload: Record<string, unknown>,
    signal: AbortSignal | undefined
  ): Promise<Record<string, unknown>> {
    const sshPath = worker.sshPath?.trim() || "ssh";
    const sshBaseArgs = remoteSshBaseArgs(worker, remoteSshTarget(worker));
    const command = `node ${shellQuote(`${root}/session-control.js`)} ${shellQuote(root)} ${shellQuote(action)}`;
    try {
      const result = await runCommand(sshPath, [...sshBaseArgs, command], {
        input: JSON.stringify(payload),
        timeoutMs: 30_000,
        signal
      });
      return JSON.parse(result.stdout || "{}") as Record<string, unknown>;
    } catch (error) {
      if (error instanceof CommandError) {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(error.result.stdout || "{}") as Record<string, unknown>;
        } catch {
          parsed = {};
        }
        throw new RemoteSessionControlError(
          typeof parsed.status === "string" ? parsed.status : error.message,
          parsed
        );
      }
      throw error;
    }
  }
}

class RemoteSessionControlError extends Error {
  constructor(readonly status: string, readonly result: Record<string, unknown>) {
    super(`Remote session control failed: ${status}`);
  }
}

async function defaultRemoteCodexExecutor(
  request: RemoteCodexExecutorRequest,
  callbacks: RemoteCodexExecutorCallbacks
): Promise<RemoteCodexExecutionResult> {
  const sshPath = request.worker.sshPath?.trim() || "ssh";
  const target = remoteSshTarget(request.worker);
  const sshBaseArgs = remoteSshBaseArgs(request.worker, target);
  const token = request.invocation.env?.[CODEX_APP_SERVER_MCP_TOKEN_ENV];
  const tokenPath = token ? `/tmp/accordagents-${randomUUID()}-mcp-token` : undefined;
  if (token && tokenPath) {
    await runCommand(sshPath, [...sshBaseArgs, `umask 077; cat > ${shellQuote(tokenPath)}`], {
      input: token,
      timeoutMs: 30_000,
      signal: request.signal
    });
  }

  try {
    const result = await runRemoteCodexCommand(sshPath, sshBaseArgs, request, callbacks, tokenPath);
    const finalMessage = await readRemoteFinalMessage(sshPath, sshBaseArgs, request.remoteFinalPath, request.signal);
    return { ...result, finalMessage };
  } finally {
    await cleanupRemoteFiles(sshPath, sshBaseArgs, [request.remoteFinalPath, tokenPath], request.signal);
  }
}

function remoteSshTarget(worker: RemoteRunWorkerTarget): string {
  return buildCloudRunSshTarget(worker);
}

function workerSettingsFromTarget(worker: RemoteRunWorkerTarget): RemoteParticipantSessionHandle["worker"] {
  return {
    host: worker.host,
    user: worker.user,
    port: worker.port,
    identityFile: worker.identityFile,
    workerRoot: worker.workerRoot,
    remoteCwd: worker.remoteCwd,
    codexPath: worker.codexPath
  };
}

function targetFromSessionHandle(handle: RemoteParticipantSessionHandle): RemoteRunWorkerTarget {
  const host = handle.worker.host?.trim();
  if (!host) {
    throw new Error("Remote participant session has no worker host.");
  }
  return { ...handle.worker, host };
}

function toolchainProbeScript(requirements: ToolchainRequirement[]): string {
  return requirements.map((requirement, index) => {
    const ok = `printf '%s\\n' ${shellQuote(`${index}=ok`)}`;
    const missing = `printf '%s\\n' ${shellQuote(`${index}=missing`)}`;
    const probe = `printf '%s\\n' ${shellQuote(`${index}=probe`)}`;
    const probeCheck = requirement.probeCommand
      ? `if ${requirement.probeCommand} >/dev/null 2>&1; then ${ok}; else ${probe}; fi`
      : ok;
    const alternativeCheck = (requirement.alternativeCommands ?? [])
      .map((command) => `command -v ${shellQuote(command)} >/dev/null 2>&1 && ${shellQuote(command)} --version >/dev/null 2>&1`)
      .join(" || ");
    const alternativeBranch = alternativeCheck ? ` elif ${alternativeCheck}; then ${ok};` : "";
    return `if command -v ${shellQuote(requirement.command)} >/dev/null 2>&1; then ${probeCheck};${alternativeBranch} else ${missing}; fi`;
  }).join("; ");
}

function parseToolchainProbeOutput(
  requirements: ToolchainRequirement[],
  stdout: string
): ToolchainPreflightIssue[] {
  const statuses = new Map<number, ToolchainIssueCategory | "ok">();
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)=(ok|missing|probe)$/);
    if (!match) {
      continue;
    }
    statuses.set(Number.parseInt(match[1], 10), match[2] as ToolchainIssueCategory | "ok");
  }
  const issues: ToolchainPreflightIssue[] = [];
  requirements.forEach((requirement, index) => {
    const status = statuses.get(index);
    if (!status || status === "ok") {
      return;
    }
    issues.push(issueFromRequirement(requirement, status));
  });
  return issues;
}

function replaceArgValue(args: string[], from: string, to: string): string[] {
  return args.map((arg) => arg === from ? to : arg);
}

function resumeSessionIdFromArgs(args: string[]): string | undefined {
  const resumeIndex = args.indexOf("resume");
  if (resumeIndex < 0 || args.at(-1) !== "-") {
    return undefined;
  }
  const candidate = args.at(-2)?.trim();
  return candidate && !candidate.startsWith("-") ? candidate : undefined;
}

async function resolveRemoteRunDir(
  sshPath: string,
  sshBaseArgs: string[],
  remotePath: string,
  signal: AbortSignal | undefined
): Promise<string> {
  const trimmed = remotePath.trim();
  if (!trimmed) {
    throw new Error("Remote worker path is empty.");
  }
  if (trimmed.startsWith("/")) {
    return trimmed.replace(/\/+$/g, "") || "/";
  }
  const homeRelative = trimmed === "~"
    ? ""
    : trimmed.startsWith("~/")
      ? trimmed.slice(2)
      : trimmed;
  const command = homeRelative
    ? `printf '%s' "$HOME"/${shellQuote(homeRelative)}`
    : `printf '%s' "$HOME"`;
  const result = await runCommand(sshPath, [...sshBaseArgs, command], {
    timeoutMs: 30_000,
    signal
  });
  const resolved = result.stdout.trim();
  if (!resolved.startsWith("/")) {
    throw new Error(`Remote worker path did not resolve to an absolute path: ${remotePath}`);
  }
  return resolved.replace(/\/+$/g, "") || "/";
}

async function readRemotePid(
  sshPath: string,
  sshBaseArgs: string[],
  remotePath: string,
  signal: AbortSignal | undefined
): Promise<number | undefined> {
  try {
    const result = await runCommand(sshPath, [...sshBaseArgs, `cat ${shellQuote(remotePath)}`], {
      timeoutMs: 30_000,
      signal
    });
    const pid = Number.parseInt(result.stdout.trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

async function remotePidAlive(
  sshPath: string,
  sshBaseArgs: string[],
  pid: number,
  processGroup: boolean,
  signal: AbortSignal | undefined
): Promise<boolean> {
  const target = processGroup ? `-${Math.floor(pid)}` : `${Math.floor(pid)}`;
  try {
    await runCommand(sshPath, [...sshBaseArgs, `kill -0 ${target}`], {
      timeoutMs: 10_000,
      signal
    });
    return true;
  } catch {
    return false;
  }
}

async function listRemoteRunDirs(
  sshPath: string,
  sshBaseArgs: string[],
  root: string,
  signal: AbortSignal | undefined
): Promise<string[]> {
  try {
    const result = await runCommand(sshPath, [
      ...sshBaseArgs,
      `for dir in ${shellQuote(root)}/*; do [ -f "$dir/state.json" ] && printf '%s\\n' "$dir"; done`
    ], {
      timeoutMs: 30_000,
      signal
    });
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("/"));
  } catch {
    return [];
  }
}

async function writeRemoteFile(
  sshPath: string,
  sshBaseArgs: string[],
  remotePath: string,
  body: string,
  signal: AbortSignal | undefined
): Promise<void> {
  await runCommand(sshPath, [
    ...sshBaseArgs,
    `umask 077; mkdir -p ${shellQuote(path.posix.dirname(remotePath))}; cat > ${shellQuote(remotePath)}`
  ], {
    input: body,
    timeoutMs: 30_000,
    signal
  });
}

async function readRemoteJson<T>(
  sshPath: string,
  sshBaseArgs: string[],
  remotePath: string,
  signal: AbortSignal | undefined
): Promise<T | undefined> {
  try {
    const result = await runCommand(sshPath, [...sshBaseArgs, `cat ${shellQuote(remotePath)}`], {
      timeoutMs: 30_000,
      signal
    });
    return JSON.parse(result.stdout) as T;
  } catch {
    return undefined;
  }
}

async function readRemoteWorkerEvents(
  sshPath: string,
  sshBaseArgs: string[],
  remotePath: string,
  afterWorkerSeq: number,
  signal: AbortSignal | undefined
): Promise<RemoteWorkerEvent[]> {
  let body = "";
  try {
    const result = await runCommand(sshPath, [...sshBaseArgs, `cat ${shellQuote(remotePath)}`], {
      timeoutMs: 30_000,
      signal
    });
    body = result.stdout;
  } catch {
    return [];
  }
  const events: RemoteWorkerEvent[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const event = normalizeRemoteWorkerEvent(JSON.parse(line));
      if (event && event.workerSeq > afterWorkerSeq) {
        events.push(event);
      }
    } catch {
      // Ignore corrupt or partially written lines; a later poll will see the next complete line.
    }
  }
  return events.sort((a, b) => a.workerSeq - b.workerSeq);
}

function normalizeRemoteWorkerEvent(value: unknown): RemoteWorkerEvent | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const event = value as Partial<RemoteWorkerEvent>;
  if (typeof event.workerSeq !== "number" || !Number.isFinite(event.workerSeq) || event.workerSeq <= 0) {
    return undefined;
  }
  if (event.kind === "lifecycle") {
    return typeof event.state === "string" ? event as RemoteWorkerLifecycleEvent : undefined;
  }
  if (event.kind === "provider_output") {
    return (event.stream === "stdout" || event.stream === "stderr") && typeof event.content === "string"
      ? event as RemoteWorkerProviderOutputEvent
      : undefined;
  }
  if (event.kind === "provider_result") {
    return typeof event.ok === "boolean" && typeof event.content === "string"
      ? event as RemoteWorkerProviderResultEvent
      : undefined;
  }
  if (event.kind === "permission_pending") {
    return event.request ? event as RemoteWorkerPermissionPendingEvent : undefined;
  }
  if (event.kind === "terminal_state") {
    return event.status === "completed" || event.status === "cancelled" || event.status === "failed"
      ? event as RemoteWorkerTerminalStateEvent
      : undefined;
  }
  return undefined;
}

function remoteWorkerRootForTarget(worker: RemoteRunWorkerTarget): string {
  const root = worker.workerRoot?.trim() || "~/.accordagents/remote-runs";
  return root.replace(/\/+$/g, "") || "~/.accordagents/remote-runs";
}

function remoteWorkerRunDirForTarget(worker: RemoteRunWorkerTarget, runId: string): string {
  const root = remoteWorkerRootForTarget(worker);
  return `${root.replace(/\/+$/g, "")}/${runId.replace(/[^A-Za-z0-9._-]/g, "_") || "run"}`;
}

function remoteSshBaseArgs(worker: RemoteRunWorkerTarget, target: string): string[] {
  return [...cloudRunSshOptionArgs(worker), target];
}

async function defaultRemoteGitDirProbe(
  worker: RemoteRunWorkerTarget,
  gitDirPath: string,
  signal?: AbortSignal
): Promise<boolean> {
  const sshPath = worker.sshPath?.trim() || "ssh";
  const target = buildCloudRunSshTarget(worker);
  const sshBaseArgs = remoteSshBaseArgs(worker, target);
  const result = await runCommand(sshPath, [
    ...sshBaseArgs,
    `test -d ${shellQuote(`${gitDirPath}`)} && printf yes || printf no`
  ], {
    timeoutMs: 30_000,
    signal
  });
  return result.stdout.trim() === "yes";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runRemoteCodexCommand(
  sshPath: string,
  sshBaseArgs: string[],
  request: RemoteCodexExecutorRequest,
  callbacks: RemoteCodexExecutorCallbacks,
  tokenPath: string | undefined
): Promise<Omit<RemoteCodexExecutionResult, "finalMessage">> {
  const remoteCommand = remoteCodexCommand(request, tokenPath);
  try {
    const result = await runCommand(sshPath, [...sshBaseArgs, remoteCommand], {
      input: request.invocation.input,
      timeoutMs: request.timeoutMs,
      signal: request.signal,
      onStdout: callbacks.onStdout,
      onStderr: callbacks.onStderr
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      timedOut: result.timedOut
    };
  } catch (error) {
    if (error instanceof CommandError) {
      return {
        stdout: error.result.stdout,
        stderr: error.result.stderr,
        exitCode: error.result.exitCode,
        timedOut: error.result.timedOut
      };
    }
    throw error;
  }
}

function remoteCodexCommand(request: RemoteCodexExecutorRequest, tokenPath: string | undefined): string {
  const codexPath = request.worker.codexPath?.trim() || "codex";
  const cd = request.worker.remoteCwd?.trim()
    ? `cd ${shellQuote(request.worker.remoteCwd.trim())} || exit 125; `
    : "";
  const tokenEnv = tokenPath
    ? `${CODEX_APP_SERVER_MCP_TOKEN_ENV}="$(cat ${shellQuote(tokenPath)})" `
    : "";
  const codexArgs = request.invocation.args.map((arg) => shellQuote(arg)).join(" ");
  return [
    `rm -f ${shellQuote(request.remoteFinalPath)}`,
    `${cd}${tokenEnv}${shellQuote(codexPath)} ${codexArgs}`
  ].join("; ");
}

async function readRemoteFinalMessage(
  sshPath: string,
  sshBaseArgs: string[],
  remoteFinalPath: string,
  signal: AbortSignal | undefined
): Promise<string> {
  try {
    const result = await runCommand(sshPath, [...sshBaseArgs, `cat ${shellQuote(remoteFinalPath)}`], {
      timeoutMs: 30_000,
      signal
    });
    return result.stdout;
  } catch {
    return "";
  }
}

async function cleanupRemoteFiles(
  sshPath: string,
  sshBaseArgs: string[],
  filePaths: Array<string | undefined>,
  signal: AbortSignal | undefined
): Promise<void> {
  const existing = filePaths.filter((filePath): filePath is string => Boolean(filePath));
  if (existing.length === 0) {
    return;
  }
  const command = `rm -f ${existing.map((filePath) => shellQuote(filePath)).join(" ")}`;
  await runCommand(sshPath, [...sshBaseArgs, command], {
    timeoutMs: 30_000,
    signal,
    primeLoginShellEnv: false
  }).catch(() => undefined);
}

function detachedWorkerScript(): string {
  return String.raw`const fs = require("node:fs");
const cp = require("node:child_process");
const crypto = require("node:crypto");
const http = require("node:http");

const runDir = process.cwd();
const config = JSON.parse(fs.readFileSync("invocation.json", "utf8"));
let workerSeq = 0;
let stdout = "";
let stderr = "";
let timedOut = false;
let cancelled = false;
let activeChild;
const attemptedSessionId = config.resumeSessionId;
let sessionId;
let providerSessionValid;
let terminalWritten = false;
let resumeInFlight = false;
const pendingPermissionRequests = new Map();
const consumedDecisionIds = new Set();

function now() {
  return new Date().toISOString();
}

function writeJsonAtomic(file, value) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

let state = {
  runId: config.runId,
  conversationId: config.conversationId,
  participantId: config.participantId,
  processCookie: config.processCookie,
  status: "running",
  startedAt: now(),
  lastHeartbeat: now()
};

function appendEvent(event) {
  const next = {
    ...event,
    workerSeq: ++workerSeq,
    createdAt: now()
  };
  fs.appendFileSync("events.jsonl", JSON.stringify(next) + "\n");
  return next;
}

function toolTextResult(result) {
  return {
    content: [{
      type: "text",
      text: JSON.stringify(result, null, 2)
    }]
  };
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > 1024 * 1024) {
        reject(new Error("MCP request body is too large."));
        request.destroy();
      }
    });
    request.on("error", reject);
    request.on("end", () => {
      try {
        resolve(body.trim() ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON body."));
      }
    });
  });
}

function contextSnapshot() {
  try {
    return JSON.parse(fs.readFileSync("context-snapshot.json", "utf8"));
  } catch {
    return null;
  }
}

function findSessionId(value) {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  if (typeof value.thread_id === "string" && value.thread_id.trim()) {
    return value.thread_id.trim();
  }
  if (typeof value.session_id === "string" && value.session_id.trim()) {
    return value.session_id.trim();
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findSessionId(item);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
  for (const item of Object.values(value)) {
    const found = findSessionId(item);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function rememberSessionIdFromChunk(chunk) {
  for (const line of String(chunk || "").split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const found = findSessionId(JSON.parse(line));
      if (found) {
        sessionId = found;
        providerSessionValid = true;
        writeState({ providerSessionId: sessionId, providerSessionValid: true });
      }
    } catch {
      // Ignore non-JSON output.
    }
  }
}

function readDecisionRecords() {
  let body = "";
  try {
    body = fs.readFileSync("decisions.jsonl", "utf8");
  } catch {
    return [];
  }
  const records = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const record = JSON.parse(line);
      if (record && typeof record.requestId === "string") {
        records.push(record);
      }
    } catch {
      // Ignore partial decision writes; a later poll will see the complete line.
    }
  }
  return records;
}

function hasOutstandingPermission() {
  for (const pending of pendingPermissionRequests.values()) {
    if (!pending.resumed) {
      return true;
    }
  }
  return false;
}

function decisionKey(decision) {
  return String(decision.id || decision.requestId || "") + ":" + String(decision.approvalUpdatedAt || decision.createdAt || "");
}

function permissionResumePrompt(requestId, request, decision) {
  return [
    "The user has responded to a permission request from this remote run.",
    "Request id: " + requestId,
    "Decision: " + String(decision.status || "unknown"),
    decision.error ? "Decision error: " + String(decision.error) : "",
    "Requested permission change:",
    JSON.stringify(request, null, 2),
    "Continue the original task from this decision. If denied, explain the limitation and continue without that capability where possible."
  ].filter(Boolean).join("\n");
}

function insertBeforeResumeSession(args, ...items) {
  const promptIndex = Math.max(args.length - 2, 2);
  args.splice(promptIndex, 0, ...items);
}

function configValueFromArgs(prefix) {
  for (let index = 0; index < (config.args || []).length - 1; index += 1) {
    if (config.args[index] === "-c" && typeof config.args[index + 1] === "string" && config.args[index + 1].startsWith(prefix)) {
      return config.args[index + 1];
    }
  }
  return undefined;
}

function copyConfigArgsForResume(args) {
  const copied = [];
  for (let index = 0; index < (args || []).length - 1; index += 1) {
    if (args[index] !== "-c") {
      continue;
    }
    const value = args[index + 1];
    if (
      typeof value === "string" &&
      !value.startsWith("sandbox_mode=") &&
      (
        value.startsWith("model_reasoning_effort=") ||
        value.startsWith("approval_policy=") ||
        value.startsWith("approvals_reviewer=") ||
        value.startsWith("developer_instructions=") ||
        value.startsWith("mcp_servers.")
      )
    ) {
      copied.push("-c", value);
    }
  }
  return copied;
}

function requestedPortablePermission(request, permission) {
  return Boolean(
    request &&
    request.kind === "portable" &&
    Array.isArray(request.permissions) &&
    request.permissions.includes(permission)
  );
}

function originalWorkspaceWrite() {
  return (config.args || []).includes("workspace-write") ||
    Boolean(configValueFromArgs("sandbox_mode=")?.includes("workspace-write"));
}

function originalWebAccess() {
  return (config.args || []).includes("--search");
}

function resumeArgsForDecision(request, decision) {
  const approved = decision.status === "approved";
  const workspaceWrite = originalWorkspaceWrite() || (approved && requestedPortablePermission(request, "workspaceWrite"));
  const webAccess = originalWebAccess() || (approved && requestedPortablePermission(request, "webAccess"));
  const args = [
    "exec",
    "resume",
    "--skip-git-repo-check",
    "--json",
    "--output-last-message",
    config.finalPath,
    sessionId,
    "-"
  ];
  if (webAccess) {
    args.unshift("--search");
  }
  insertBeforeResumeSession(args, "-c", "sandbox_mode=\"" + (workspaceWrite ? "workspace-write" : "read-only") + "\"");
  insertBeforeResumeSession(args, ...copyConfigArgsForResume(config.args || []));
  return args;
}

function maybeResumeFromDecision() {
  if (terminalWritten || activeChild || resumeInFlight || cancelled || timedOut || !hasOutstandingPermission()) {
    return;
  }
  if (!sessionId) {
    finishRun(null, undefined, false, "Remote Codex requested permission before emitting a resumable session id.");
    return;
  }
  const decisions = readDecisionRecords();
  for (const [requestId, pending] of pendingPermissionRequests.entries()) {
    if (pending.resumed) {
      continue;
    }
    const decision = decisions.find((item) => item.requestId === requestId && !consumedDecisionIds.has(decisionKey(item)));
    if (!decision) {
      continue;
    }
    pending.resumed = true;
    consumedDecisionIds.add(decisionKey(decision));
    appendEvent({ kind: "lifecycle", state: "connected", message: "Permission decision received; resuming remote Codex." });
    resumeInFlight = true;
    startCodex(permissionResumePrompt(requestId, pending.request, decision), resumeArgsForDecision(pending.request, decision), true);
    resumeInFlight = false;
    return;
  }
}

async function handleRpcRequest(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return rpcError(null, -32600, "Invalid JSON-RPC request.");
  }
  const id = raw.id;
  const method = typeof raw.method === "string" ? raw.method : "";
  const notify = id === undefined;
  if (method === "initialize") {
    return notify ? undefined : rpcResult(id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "accordagents-worker-relay", version: "0.1.0" }
    });
  }
  if (method === "notifications/initialized") {
    return undefined;
  }
  if (method === "tools/list") {
    return notify ? undefined : rpcResult(id, {
      tools: [
        {
          name: "app_permissions_request_change",
          title: "Request Permission Change",
          description: "Queue a permission request for desktop approval when the desktop reconnects. Supports portable, shellRules, providerNative, and githubApp request kinds.",
          inputSchema: { type: "object", additionalProperties: true }
        },
        {
          name: "app_chat_get_context",
          title: "Get Chat Context Snapshot",
          description: "Read the run-start chat context snapshot stored on the worker.",
          inputSchema: { type: "object", additionalProperties: false, properties: {} }
        },
        {
          name: "app_chat_get_participants",
          title: "Get Chat Participants Snapshot",
          description: "Read participant data from the run-start context snapshot.",
          inputSchema: { type: "object", additionalProperties: false, properties: {} }
        }
      ]
    });
  }
  if (method !== "tools/call") {
    return notify ? undefined : rpcError(id, -32601, "Unsupported MCP method: " + (method || "unknown") + ".");
  }
  const params = raw.params && typeof raw.params === "object" ? raw.params : {};
  const name = params.name;
  const args = params.arguments || {};
  if (name === "app_permissions_request_change") {
    const requestId = crypto.randomUUID();
    const event = appendEvent({
      kind: "permission_pending",
      requestId,
      triggerMessageId: config.sourceMessageId,
      request: args
    });
    pendingPermissionRequests.set(requestId, {
      request: args,
      createdAt: event.createdAt,
      resumed: false
    });
    return notify ? undefined : rpcResult(id, toolTextResult({
      ok: true,
      status: "pending_user_approval",
      requestId,
      approvalId: requestId,
      request: args,
      updatedAt: event.createdAt
    }));
  }
  if (name === "app_chat_get_context") {
    return notify ? undefined : rpcResult(id, toolTextResult({
      ok: true,
      snapshot: contextSnapshot()
    }));
  }
  if (name === "app_chat_get_participants") {
    const snapshot = contextSnapshot();
    return notify ? undefined : rpcResult(id, toolTextResult({
      ok: true,
      participants: snapshot && typeof snapshot === "object" ? snapshot.participants || [] : []
    }));
  }
  return notify ? undefined : rpcError(id, -32603, "Unknown worker relay tool: " + String(name || "") + ".");
}

function startRelay(next) {
  const token = config.env && config.env.ACCORD_AGENTS_MCP_TOKEN;
  if (!token) {
    next();
    return;
  }
  const server = http.createServer(async (request, response) => {
    if (request.method !== "POST" || (request.url || "").split("?")[0] !== "/mcp") {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("Not found");
      return;
    }
    if (request.headers.authorization !== "Bearer " + token) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    try {
      const payload = await readJsonBody(request);
      const requests = Array.isArray(payload) ? payload : [payload];
      const results = [];
      for (const item of requests) {
        const result = await handleRpcRequest(item);
        if (result) {
          results.push(result);
        }
      }
      if (results.length === 0) {
        response.writeHead(202);
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(Array.isArray(payload) ? results : results[0]));
    } catch (error) {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(rpcError(null, -32700, error instanceof Error ? error.message : String(error))));
    }
  });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = address && typeof address === "object" ? address.port : undefined;
    if (port) {
      config.args = (config.args || []).map((arg) =>
        typeof arg === "string" && arg.startsWith("mcp_servers.accord_agents.url=")
          ? "mcp_servers.accord_agents.url=\"http://127.0.0.1:" + port + "/mcp\""
          : arg
      );
      writeState({ relayPort: port });
    }
    next();
  });
}

function writeState(patch) {
  state = {
    ...state,
    ...patch,
    lastHeartbeat: now(),
    workerCursorSeq: workerSeq
  };
  writeJsonAtomic("state.json", state);
}

function killGroup(signal) {
  if (!state.pgid) {
    return;
  }
  try {
    process.kill(-state.pgid, signal);
  } catch {
    // The child may already be gone.
  }
}

function groupAlive(pgid) {
  if (!Number.isFinite(Number(pgid)) || Number(pgid) <= 0) {
    return false;
  }
  try {
    process.kill(-Number(pgid), 0);
    return true;
  } catch {
    return false;
  }
}

function waitSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function ownedCookiePids() {
  if (!config.processCookie || process.platform !== "linux") {
    return [];
  }
  let entries = [];
  try { entries = fs.readdirSync("/proc"); } catch { return []; }
  return entries.flatMap((entry) => {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) {
      return [];
    }
    try {
      const matches = fs.readFileSync("/proc/" + entry + "/environ", "utf8")
        .split("\0").includes("ACCORD_AGENTS_PROCESS_COOKIE=" + config.processCookie);
      return matches ? [Number(entry)] : [];
    } catch {
      return [];
    }
  });
}

function cleanupOwnedGroup(pgid) {
  if (!groupAlive(pgid) && ownedCookiePids().length === 0) {
    return true;
  }
  try { process.kill(-Number(pgid), "SIGTERM"); } catch {}
  for (const pid of ownedCookiePids()) { try { process.kill(pid, "SIGTERM"); } catch {} }
  for (let index = 0; index < 20 && (groupAlive(pgid) || ownedCookiePids().length > 0); index += 1) { waitSync(50); }
  if (groupAlive(pgid) || ownedCookiePids().length > 0) {
    try { process.kill(-Number(pgid), "SIGKILL"); } catch {}
    for (const pid of ownedCookiePids()) { try { process.kill(pid, "SIGKILL"); } catch {} }
    for (let index = 0; index < 20 && (groupAlive(pgid) || ownedCookiePids().length > 0); index += 1) { waitSync(50); }
  }
  return !groupAlive(pgid) && ownedCookiePids().length === 0;
}

function extractedStdoutText() {
  const messages = [];
  const deltas = [];
  const plain = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const event = JSON.parse(line);
      if (typeof event.message === "string") {
        messages.push(event.message);
      } else if (typeof event.text === "string") {
        messages.push(event.text);
      } else if (event.type === "item.completed" && typeof event.item?.text === "string") {
        messages.push(event.item.text);
      } else if (typeof event.delta === "string") {
        deltas.push(event.delta);
      }
    } catch {
      plain.push(line.trim());
    }
  }
  return messages.at(-1) || deltas.join("").trim() || plain.join("\n").trim() || stdout.trim();
}

appendEvent({ kind: "lifecycle", state: "detached_started", message: "Remote run detached." });
writeState({});

const heartbeat = setInterval(() => writeState({}), 5000);
heartbeat.unref();

const decisionWatcher = setInterval(() => maybeResumeFromDecision(), 1000);
decisionWatcher.unref();

const timeout = setTimeout(() => {
  timedOut = true;
  writeState({ timedOut: true });
  if (activeChild) {
    killGroup("SIGTERM");
    setTimeout(() => killGroup("SIGKILL"), 2000).unref();
    return;
  }
  finishRun(null, undefined, false, "Remote Codex run timed out.");
}, Math.max(1, Number(config.maxRuntimeMs || 86400000)));
timeout.unref();

process.on("SIGTERM", () => {
  cancelled = true;
  writeState({ status: "cancelled", signal: "SIGTERM" });
  if (activeChild) {
    killGroup("SIGTERM");
    setTimeout(() => killGroup("SIGKILL"), 2000).unref();
    return;
  }
  finishRun(null, "SIGTERM", false, "Remote Codex run was cancelled.");
});

startRelay(() => startCodex(config.input || "", config.args || [], false));

function finishRun(exitCode, signal, forcedOk, forcedError) {
  if (terminalWritten) {
    return;
  }
  terminalWritten = true;
  clearInterval(heartbeat);
  clearTimeout(timeout);
  clearInterval(decisionWatcher);
  let finalMessage = "";
  try {
    finalMessage = fs.readFileSync(config.finalPath, "utf8").trim();
  } catch {
    finalMessage = "";
  }
  const ok = forcedError ? false : forcedOk ?? (exitCode === 0 && !signal && !timedOut && !cancelled);
  const error = ok
    ? undefined
    : forcedError
      ? forcedError
      : timedOut
      ? "Remote Codex run timed out."
      : cancelled
        ? "Remote Codex run was cancelled."
        : stderr.trim() || (signal ? "Remote Codex exited from signal " + signal + "." : "Remote Codex exited with code " + exitCode + ".");
  const startedAtMs = Date.parse(state.startedAt);
  const workerDurationMs = Number.isFinite(startedAtMs) ? Math.max(0, Date.now() - startedAtMs) : undefined;
  const effectiveSessionId = sessionId || attemptedSessionId;
  const resumeDiagnostic = (String(error || "") + "\n" + String(stderr || "")).toLowerCase();
  const resumeMiss = Boolean(attemptedSessionId && !ok &&
    /resume|session|conversation|thread/.test(resumeDiagnostic) &&
    /not found|missing|unknown|cannot|can't|unable|no .*session|no .*found|does not exist|unavailable/.test(resumeDiagnostic));
  providerSessionValid = resumeMiss ? false : Boolean(effectiveSessionId);
  appendEvent({
    kind: "provider_result",
    ok,
    content: finalMessage || extractedStdoutText() || stderr.trim() || error || "",
    exitCode,
    error,
    sessionId: effectiveSessionId,
    // Real on-box run time, measured by the worker. Without this the desktop
    // can only fall back to wall-clock-to-sync, which inflates the "Worked
    // for ..." chip by however long the laptop lid was closed before reconnect.
    durationMs: workerDurationMs,
    sourceMessageId: config.sourceMessageId,
    threadId: config.threadId,
    chatThreadRootId: config.chatThreadRootId
  });
  const status = ok ? "completed" : cancelled ? "cancelled" : "failed";
  appendEvent({ kind: "terminal_state", status, reason: error });
  const completedAt = now();
  const ownedPgid = state.pgid;
  const groupClean = cleanupOwnedGroup(ownedPgid);
  const exit = { runId: config.runId, status, exitCode, signal, timedOut, error, completedAt };
  writeJsonAtomic("exit.json", exit);
  writeState({
    status,
    pid: undefined,
    pgid: groupClean ? undefined : ownedPgid,
    providerSessionId: providerSessionValid ? effectiveSessionId : undefined,
    providerSessionValid,
    exitCode,
    signal,
    timedOut,
    error,
    completedAt
  });
  process.exit(0);
}

function startCodex(input, args, resuming) {
let child;
try {
child = cp.spawn(config.codexPath || "codex", args || [], {
  cwd: config.remoteCwd || undefined,
  env: { ...process.env, ...(config.env || {}) },
  detached: true,
  stdio: ["pipe", "pipe", "pipe"]
});
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  finishRun(null, undefined, false, message);
  return;
}

activeChild = child;
writeState({ status: "running", pid: child.pid, pgid: child.pid, relayPort: state.relayPort });
child.stdin.end(input || "");

child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdout += chunk;
  rememberSessionIdFromChunk(chunk);
  fs.appendFileSync("stdout.log", chunk);
  appendEvent({ kind: "provider_output", stream: "stdout", content: chunk });
});
child.stderr.on("data", (chunk) => {
  stderr += chunk;
  fs.appendFileSync("stderr.log", chunk);
  appendEvent({ kind: "provider_output", stream: "stderr", content: chunk });
});

child.on("close", (exitCode, signal) => {
  if (activeChild === child) {
    activeChild = undefined;
  }
  writeState({ pid: undefined });
  if (!cancelled && !timedOut && hasOutstandingPermission()) {
    appendEvent({
      kind: "lifecycle",
      state: "disconnected",
      message: resuming
        ? "Remote Codex is waiting for another permission decision."
        : "Remote Codex is waiting for a permission decision."
    });
    maybeResumeFromDecision();
    return;
  }
  finishRun(exitCode, signal);
});

child.on("error", (error) => {
  if (activeChild === child) {
    activeChild = undefined;
  }
  const message = error instanceof Error ? error.message : String(error);
  finishRun(null, undefined, false, message);
});
}
`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export class RemoteAppMcpRelay {
  constructor(private readonly remoteRuns: RemoteRunService, private readonly request: RemoteRunPermissionRequest) {}

  async callTool(toolName: string, input: unknown): Promise<Record<string, unknown>> {
    if (toolName !== APP_PERMISSIONS_REQUEST_CHANGE_TOOL) {
      return {
        ok: false,
        status: "unsupported",
        error: `Remote App MCP relay does not support ${toolName} in PR-B.`
      };
    }
    const record = await this.remoteRuns.requestPermission({
      ...this.request,
      request: input as ChatPermissionChangeRequest
    });
    return {
      ok: true,
      status: "queued",
      requestId: record.requestId ?? record.id
    };
  }
}

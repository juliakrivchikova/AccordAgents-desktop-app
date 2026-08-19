import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import type {
  ChatAgentMode,
  ChatAgentPermissions,
  ChatAppToolApprovalScope,
  ChatPermissionChangeRequest,
  ChatPermissionRequestToolResult,
  ChatProviderKind,
  ChatRemoteRunStatus,
  ChatReasoningEffort,
  ChatShellPermissionRule,
  ConversationKind,
  GitDiffMode,
  ParticipantConfig,
  RemoteParticipantSessionHandle,
  RemoteRunSyncInfo
} from "../../shared/types";
import { effectiveChatAgentPermissionsForProvider, normalizeChatAgentMode, normalizeChatAgentPermissions } from "../../shared/agentPermissions";
import { filterAllowedAgentEnvironment } from "../../shared/agentEnvironment";
import { normalizeChatReasoningEffort } from "../../shared/reasoningEffort";
import { APP_PERMISSIONS_REQUEST_CHANGE_TOOL } from "./appMcp";
import type { ChatAppToolApprovalDecisionEvent, ChatService } from "./chat";
import { buildCloudRunSshTarget, cloudRunSshOptionArgs } from "./cloudRunWorkers";
import { CommandError, commandEnvironment, runCommand } from "./command";
import { runWithSshRetries, sshRetryWorstCaseMs } from "./sshRetry";
import {
  CODEX_APP_SERVER_MCP_TOKEN_ENV,
  buildCodexExecInvocation,
  createCodexLineHandler,
  emitCodexLiveOutput,
  extractCodexSessionId,
  extractCodexText
} from "./codexExec";
import type { CodexExecOptions, CodexExecInvocation, CodexExecRemoteSandboxOptions } from "./codexExec";
import {
  REMOTE_MIRROR_DIRNAME,
  REMOTE_MIRROR_FINGERPRINT_VERSION,
  computeLocalMirrorFingerprint,
  defaultRemoteMirrorSync,
  localProjectHasGitDir,
  planWorkerMirrorReclaim,
  remoteMirrorPath
} from "./remoteMirrorSync";
import type {
  LocalMirrorFingerprint,
  RemoteMirrorSyncRunner,
  WorkerMirrorContainerSnapshot
} from "./remoteMirrorSync";
import {
  detectRepoToolchainRequirements,
  formatToolchainAdvisoryIssues,
  issueFromRequirement,
  RemoteRunPreflightError
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
// Per-attempt timeout for session-control + path-resolution SSH. These are all
// fast supervisor ops (ensure spawns detached and returns; submit/inspect/list
// just hand off/read), so a stalled attempt is a lossy-link KEX black hole, not
// slow work. Keep it short so a stall is abandoned and retried quickly instead
// of burning ~30s each.
export const REMOTE_SESSION_SSH_TIMEOUT_MS = 15_000;
export const REMOTE_SESSION_SSH_RETRY_ATTEMPTS = 3;
// Single-shot read of the worker's session protocol.json during warm prepare.
const REMOTE_SESSION_PROTOCOL_READ_TIMEOUT_MS = 30_000;
// Warm-session prepare runs, worst case, two retried SSH ops (resolve run dir +
// ensure session) plus one single-shot protocol read, in sequence. Derive the
// wall from that schedule (P1-7) so a lossy link can exhaust its retries instead
// of being cut off mid-schedule and forced into an avoidable cold launch. The
// old flat 60s could be blown past by a single retried op (~47s) alone.
export const REMOTE_WARM_SESSION_PREPARE_TIMEOUT_MS =
  2 * sshRetryWorstCaseMs(REMOTE_SESSION_SSH_RETRY_ATTEMPTS, REMOTE_SESSION_SSH_TIMEOUT_MS) +
  REMOTE_SESSION_PROTOCOL_READ_TIMEOUT_MS +
  5_000;
export const MAX_MIRROR_SYNC_STATE_ENTRIES = 200;
const MIRROR_SYNC_STATE_FILENAME = "mirror-sync-state.json";
const REMOTE_SECRET_ENV_KEYS = new Set(["GH_TOKEN", "GITHUB_TOKEN"]);
// Upper bound on paths a single opportunistic worker-mirror reclaim pass will
// delete, so a worker that has accumulated many orphans is drained gradually
// over several runs rather than in one large blocking rm.
const MAX_WORKER_MIRROR_RECLAIM_PER_PASS = 25;

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

export function remoteSessionProtocolPayload(): {
  version: number;
  files: Record<string, string>;
  hashes: Record<string, string>;
} {
  const files = {
    "session-control.js": remoteSessionControlScript(),
    "session-supervisor.js": remoteSessionSupervisorScript(),
    "run-worker.js": detachedWorkerScript()
  };
  return {
    version: REMOTE_SESSION_PROTOCOL_VERSION,
    files,
    hashes: Object.fromEntries(
      Object.entries(files).map(([name, body]) => [
        name,
        createHash("sha256").update(body).digest("hex")
      ])
    )
  };
}

export function remoteSessionProtocolMatchesCurrent(current: unknown): boolean {
  if (!current || typeof current !== "object" || Array.isArray(current)) {
    return false;
  }
  const record = current as Record<string, unknown>;
  if (record.version !== REMOTE_SESSION_PROTOCOL_VERSION) {
    return false;
  }
  const currentHashes = record.hashes;
  if (!currentHashes || typeof currentHashes !== "object" || Array.isArray(currentHashes)) {
    return false;
  }
  const { hashes } = remoteSessionProtocolPayload();
  return Object.entries(hashes).every(([name, value]) =>
    (currentHashes as Record<string, unknown>)[name] === value
  );
}

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
  | "chat_message"
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

export interface MirrorSyncStateFile {
  version: 1;
  mirrors: Record<string, MirrorSyncStateEntry>;
}

export interface MirrorSyncStateEntry {
  key: string;
  workerIdentity: Record<string, string | number | undefined>;
  remotePath: string;
  localPath: string;
  fingerprintVersion: typeof REMOTE_MIRROR_FINGERPRINT_VERSION;
  fingerprintDigest: string;
  fileCount: number;
  totalBytes: number;
  updatedAt: string;
}

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
  remoteMirrorProbe?: (worker: RemoteRunWorkerTarget, remotePath: string, expectGit: boolean, signal?: AbortSignal) => Promise<boolean>;
  enumerateWorkerMirrors?: (
    worker: RemoteRunWorkerTarget,
    mirrorsDir: string,
    signal?: AbortSignal
  ) => Promise<WorkerMirrorContainerSnapshot[]>;
  removeWorkerMirrorPaths?: (
    worker: RemoteRunWorkerTarget,
    paths: string[],
    signal?: AbortSignal
  ) => Promise<void>;
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
  claudePath?: string;
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
  invocation: RemoteAgentInvocation;
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

export interface RemoteAgentInvocation extends CodexExecInvocation {
  providerKind: ChatProviderKind;
  executablePath: string;
  remoteCwd?: string;
  secretEnv?: NodeJS.ProcessEnv;
  fallbackSessionId?: string;
}

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

/** A member speaking to the room while it is still working. Distinct from
 *  provider_output on purpose: that is a stream, this is one deliberate
 *  message, and only one of the two should ever be posted as chat. */
export interface RemoteWorkerChatMessageEvent extends RemoteWorkerEventBase {
  kind: "chat_message";
  content: string;
  sourceMessageId?: string;
  threadId?: string;
  chatThreadRootId?: string;
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
  | RemoteWorkerChatMessageEvent
  | RemoteWorkerTerminalStateEvent;

export interface RemoteDetachedWorkerLaunchRequest {
  conversationId: string;
  runId: string;
  participant: ParticipantConfig;
  worker: RemoteRunWorkerTarget;
  invocation: RemoteAgentInvocation;
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
  private readonly remoteMirrorProbe: (worker: RemoteRunWorkerTarget, remotePath: string, expectGit: boolean, signal?: AbortSignal) => Promise<boolean>;
  private readonly enumerateWorkerMirrors: (
    worker: RemoteRunWorkerTarget,
    mirrorsDir: string,
    signal?: AbortSignal
  ) => Promise<WorkerMirrorContainerSnapshot[]>;
  private readonly removeWorkerMirrorPaths: (
    worker: RemoteRunWorkerTarget,
    paths: string[],
    signal?: AbortSignal
  ) => Promise<void>;
  private readonly detachedSyncByRun = new Map<string, RemoteRunSyncInfo>();
  private readonly mirrorOpChainByPath = new Map<string, Promise<void>>();
  private mirrorSyncStateChain: Promise<unknown> = Promise.resolve();
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
    this.remoteMirrorProbe = options.remoteMirrorProbe ?? defaultRemoteMirrorProbe;
    this.enumerateWorkerMirrors = options.enumerateWorkerMirrors ?? ((worker, mirrorsDir, signal) => {
      const sshPath = worker.sshPath?.trim() || "ssh";
      const sshBaseArgs = remoteSshBaseArgs(worker, buildCloudRunSshTarget(worker));
      return enumerateWorkerMirrorContainers(sshPath, sshBaseArgs, mirrorsDir, signal);
    });
    this.removeWorkerMirrorPaths = options.removeWorkerMirrorPaths ?? ((worker, paths, signal) => {
      const sshPath = worker.sshPath?.trim() || "ssh";
      const sshBaseArgs = remoteSshBaseArgs(worker, buildCloudRunSshTarget(worker));
      return removeRemoteWorkerPaths(sshPath, sshBaseArgs, paths, signal);
    });
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

    const invocation = buildRemoteAgentInvocation({
      participant: request.participant,
      prompt: request.prompt,
      outputPath: remoteFinalPath,
      repoPath: request.repoPath,
      diffMode: request.diffMode,
      kind: request.kind ?? "chat",
      worker: request.worker,
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
    const lineHandler = request.participant.kind === "codex-cli"
      ? createCodexLineHandler((line) =>
          emitCodexLiveOutput(line, undefined, undefined, (nextSessionId) => {
            sessionId = nextSessionId;
          })
        )
      : undefined;
    const appendOutput = (stream: RemoteRunProviderOutputRecord["stream"], chunk: string): void => {
      if (!chunk) {
        return;
      }
      if (stream === "stdout") {
        stdout += chunk;
        lineHandler?.(chunk);
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
      sessionId = extractRemoteAgentSessionId(request.participant.kind, stdout) ?? invocation.fallbackSessionId ?? sessionId;
      await Promise.all(pendingOutputWrites);
      const error = this.remoteExecutionError(execution, request.participant.kind);
      return await this.appendProviderResult({
        conversationId: request.conversationId,
        runId,
        participantId: request.participant.id,
        ok: !error,
        content: execution.finalMessage.trim() || extractRemoteAgentText(request.participant.kind, stdout) || stderr.trim() || error || "",
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
      codexPath: remoteAgentExecutablePath(request.participant.kind, request.worker)
    });
    let participantSession: RemoteParticipantSessionEnsureResult | undefined;
    if (this.detachedWorkerTransport.ensureParticipantSession) {
      participantSession = await this.prepareWarmParticipantSession(runId, request, runtimeFingerprint);
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

    const invocation = buildRemoteAgentInvocation({
      participant: request.participant,
      prompt: request.prompt,
      outputPath: remoteFinalPath,
      repoPath: effectiveRepoPath,
      diffMode: request.diffMode,
      kind: request.kind ?? "chat",
      worker: request.worker,
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
        } catch (error) {
          try {
            const relaunched = await this.detachedWorkerTransport.ensureParticipantSession?.({
              conversationId: request.conversationId,
              participantId: request.participant.id,
              worker: request.worker,
              runtimeFingerprint,
              idleTimeoutMs: this.sessionIdleTimeoutMs,
              signal: request.signal
            });
            if (!relaunched) {
              throw new Error("Remote member session became unavailable.");
            }
            participantSession = relaunched;
            if (relaunched.launched) {
              await this.emitDetachedPhase(runId, request, "launching-session", "Relaunching stale remote session");
            }
            snapshot = await this.detachedWorkerTransport.submitTurn({
              ...launchRequest,
              participantSession: relaunched.handle
            });
          } catch (fallbackError) {
            if (request.signal?.aborted) {
              throw fallbackError;
            }
            const detail = errorMessage(fallbackError) || errorMessage(error);
            this.syncLogger?.("remote-run.session.warm-submit.fallback", { runId, message: detail });
            await this.emitDetachedPhase(
              runId,
              request,
              "launching-session",
              "Warm remote session unavailable; launching remote run",
              detail
            );
            const recovered = await this.recoverSubmittedWarmRun(launchRequest, participantSession?.handle);
            if (recovered) {
              snapshot = recovered;
            } else {
              participantSession = undefined;
              snapshot = await this.detachedWorkerTransport.launch({
                ...launchRequest,
                participantSession: undefined
              });
            }
          }
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

  private async prepareWarmParticipantSession(
    runId: string,
    request: RemoteRunDetachedStartRequest,
    runtimeFingerprint: string
  ): Promise<RemoteParticipantSessionEnsureResult | undefined> {
    await this.emitDetachedPhase(runId, request, "preparing-worker", "Checking warm remote session");
    try {
      const participantSession = await runWithTimeoutSignal(
        (signal) => this.detachedWorkerTransport.ensureParticipantSession?.({
          conversationId: request.conversationId,
          participantId: request.participant.id,
          worker: request.worker,
          runtimeFingerprint,
          idleTimeoutMs: this.sessionIdleTimeoutMs,
          signal
        }) ?? Promise.resolve(undefined),
        REMOTE_WARM_SESSION_PREPARE_TIMEOUT_MS,
        "Warm remote session setup timed out.",
        request.signal
      );
      if (participantSession?.launched) {
        await this.emitDetachedPhase(runId, request, "launching-session", "Launching remote session");
      }
      return participantSession;
    } catch (error) {
      if (request.signal?.aborted) {
        throw error;
      }
      const detail = errorMessage(error);
      this.syncLogger?.("remote-run.session.warm-prepare.fallback", { runId, message: detail });
      await this.emitDetachedPhase(
        runId,
        request,
        "launching-session",
        "Warm remote session unavailable; launching remote run",
        detail
      );
      return undefined;
    }
  }

  private async recoverSubmittedWarmRun(
    request: RemoteDetachedWorkerLaunchRequest,
    handle: RemoteParticipantSessionHandle | undefined
  ): Promise<RemoteDetachedWorkerSnapshot | undefined> {
    if (handle && this.detachedWorkerTransport.inspectParticipantSession) {
      try {
        const inspected = await this.detachedWorkerTransport.inspectParticipantSession({
          handle,
          signal: request.signal
        });
        if (
          inspected.activeRunId === request.runId ||
          (inspected.queuedRunIds ?? []).includes(request.runId)
        ) {
          this.syncLogger?.("remote-run.session.warm-submit.recovered", {
            runId: request.runId,
            status: inspected.activeRunId === request.runId ? "active" : "queued"
          });
          return await this.pollSubmittedRunOrRunningSnapshot(request);
        }
      } catch (error) {
        this.syncLogger?.("remote-run.session.warm-submit.inspect.error", {
          runId: request.runId,
          message: errorMessage(error)
        });
      }
    }
    try {
      const snapshot = await this.detachedWorkerTransport.poll({
        runId: request.runId,
        worker: request.worker,
        afterWorkerSeq: 0,
        signal: request.signal
      });
      if (snapshot.state.status !== "unknown" || snapshot.events.length > 0) {
        this.syncLogger?.("remote-run.session.warm-submit.recovered", {
          runId: request.runId,
          status: snapshot.state.status
        });
        return snapshot;
      }
    } catch (error) {
      this.syncLogger?.("remote-run.session.warm-submit.poll.error", {
        runId: request.runId,
        message: errorMessage(error)
      });
    }
    return undefined;
  }

  private async pollSubmittedRunOrRunningSnapshot(
    request: RemoteDetachedWorkerLaunchRequest
  ): Promise<RemoteDetachedWorkerSnapshot> {
    const snapshot = await this.detachedWorkerTransport.poll({
      runId: request.runId,
      worker: request.worker,
      afterWorkerSeq: 0,
      signal: request.signal
    });
    if (snapshot.state.status !== "unknown" || snapshot.events.length > 0) {
      return snapshot;
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

  clearToolchainPreflightCache(): void {
    this.toolchainPreflightCache.clear();
  }

  async clearMirrorSyncState(): Promise<void> {
    await this.withMirrorSyncStateWrite(async () => {
      await this.writeMirrorSyncState({ version: 1, mirrors: {} });
    });
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
    if (event.kind === "chat_message") {
      // A member posting mid-run is saying something to the room, not streaming
      // provider output — but the desktop already knows how to turn one text
      // into one participant message, so it maps onto that record rather than
      // inventing a second way to post.
      return {
        kind: "output_text",
        conversationId,
        runId,
        participantId,
        content: event.content,
        sourceMessageId: event.sourceMessageId,
        threadId: event.threadId,
        chatThreadRootId: event.chatThreadRootId
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
    throw new Error(`Remote run ${runId} has no projected member yet.`);
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
    await this.emitDetachedPhase(runId, request, "syncing-files", "Checking project files");
    await this.chainMirrorOp(remotePath, async () => {
      if ((this.activeRunsByMirror.get(remotePath)?.size ?? 0) > 0) {
        this.syncLogger?.("remote-run.sync.up.skipped-busy-after-wait", { runId, remotePath });
        await this.emitDetachedPhase(runId, request, "syncing-files", "Using active project mirror");
        return;
      }
      const fingerprint = await this.computeMirrorFingerprintForSync(runId, sync.localPath, remotePath, request.signal);
      if (fingerprint && await this.isMirrorSyncStateCurrent(request.worker, remotePath, sync.localPath, fingerprint, request.signal)) {
        this.syncLogger?.("remote-run.sync.up.skipped-current", { runId, remotePath });
        await this.emitDetachedPhase(runId, request, "syncing-files", "Project files up to date");
        return;
      }
      const startedAt = Date.now();
      let lastProgress = -1;
      await this.emitDetachedPhase(runId, request, "syncing-files", "Syncing project files");
      await this.mirrorSync.syncUp({
        worker: request.worker,
        localPath: sync.localPath,
        remotePath,
        signal: request.signal,
        onProgress: async ({ percent }) => {
          if (percent === lastProgress || percent < 0 || percent > 100) {
            return;
          }
          lastProgress = percent;
          await this.emitDetachedPhase(runId, request, "syncing-files", `Syncing project files (${percent}%)`);
        }
      });
      if (fingerprint) {
        await this.persistMirrorSyncState(request.worker, remotePath, sync.localPath, fingerprint).catch((error) => {
          this.syncLogger?.("remote-run.sync.state.write.error", {
            runId,
            remotePath,
            message: errorMessage(error)
          });
        });
      }
      this.syncLogger?.("remote-run.sync.up", { runId, remotePath, durationMs: Date.now() - startedAt });
      await this.emitDetachedPhase(runId, request, "syncing-files", "Project files synced");
    });
    this.registerRunSync(runId, sync);
    return sync;
  }

  // Documented, bounded maintenance cleanup for accumulated worker-side mirror
  // storage (P1-8): pre-`/repo` old-layout containers and ORPHANED linked
  // worktrees a mirror repo no longer registers. Conservative by construction —
  // never deletes an active mirror, a live/registered worktree, or a non-worktree
  // sibling dir (see planWorkerMirrorReclaim), and only ever removes paths under
  // `${root}/mirrors/`. This is an explicit maintenance entry point, NOT wired to
  // auto-run on the per-turn sync path: the whole point of the surrounding work is
  // to avoid deleting remote-only git state (P0-2), so worker-side deletion stays
  // a deliberate action rather than a hot-path side effect.
  async reclaimWorkerMirrorStorage(
    worker: RemoteRunWorkerTarget,
    signal: AbortSignal | undefined
  ): Promise<{ reclaimed: string[]; skipped: number }> {
    try {
      const sshPath = worker.sshPath?.trim() || "ssh";
      const target = buildCloudRunSshTarget(worker);
      const sshBaseArgs = remoteSshBaseArgs(worker, target);
      const resolvedRoot = await resolveRemoteRunDir(
        sshPath,
        sshBaseArgs,
        remoteWorkerRootForTarget(worker),
        signal
      );
      const mirrorsDir = `${resolvedRoot.replace(/\/+$/g, "")}/${REMOTE_MIRROR_DIRNAME}`;
      const containers = await this.enumerateWorkerMirrors(worker, mirrorsDir, signal);
      const plan = planWorkerMirrorReclaim(containers, new Set(this.activeRunsByMirror.keys()));
      const safe = plan.reclaim.filter((candidate) => candidate.startsWith(`${mirrorsDir}/`));
      if (safe.length === 0) {
        return { reclaimed: [], skipped: 0 };
      }
      const bounded = safe.slice(0, MAX_WORKER_MIRROR_RECLAIM_PER_PASS);
      await this.removeWorkerMirrorPaths(worker, bounded, signal);
      this.syncLogger?.("remote-run.mirror.reclaim", {
        removed: bounded.length,
        skipped: safe.length - bounded.length
      });
      return { reclaimed: bounded, skipped: safe.length - bounded.length };
    } catch (error) {
      this.syncLogger?.("remote-run.mirror.reclaim.error", { message: errorMessage(error) });
      return { reclaimed: [], skipped: 0 };
    }
  }

  private async computeMirrorFingerprintForSync(
    runId: string,
    localPath: string,
    remotePath: string,
    signal: AbortSignal | undefined
  ): Promise<LocalMirrorFingerprint | undefined> {
    try {
      return await computeLocalMirrorFingerprint(localPath, { signal });
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      this.syncLogger?.("remote-run.sync.fingerprint.error", {
        runId,
        remotePath,
        message: errorMessage(error)
      });
      return undefined;
    }
  }

  private async isMirrorSyncStateCurrent(
    worker: RemoteRunWorkerTarget,
    remotePath: string,
    localPath: string,
    fingerprint: LocalMirrorFingerprint,
    signal: AbortSignal | undefined
  ): Promise<boolean> {
    await this.mirrorSyncStateChain.catch(() => undefined);
    const state = await this.readMirrorSyncState();
    const entry = state.mirrors[this.mirrorSyncStateKey(worker, remotePath)];
    if (!(entry?.fingerprintVersion === fingerprint.version &&
      entry.fingerprintDigest === fingerprint.digest &&
      entry.remotePath === remotePath)) {
      return false;
    }
    return this.remoteMirrorLooksCurrent(worker, remotePath, localProjectHasGitDir(localPath), signal);
  }

  private async persistMirrorSyncState(
    worker: RemoteRunWorkerTarget,
    remotePath: string,
    localPath: string,
    fingerprint: LocalMirrorFingerprint
  ): Promise<void> {
    const key = this.mirrorSyncStateKey(worker, remotePath);
    const entry: MirrorSyncStateEntry = {
      key,
      workerIdentity: mirrorSyncWorkerIdentity(worker),
      remotePath,
      localPath,
      fingerprintVersion: fingerprint.version,
      fingerprintDigest: fingerprint.digest,
      fileCount: fingerprint.fileCount,
      totalBytes: fingerprint.totalBytes,
      updatedAt: new Date().toISOString()
    };
    await this.withMirrorSyncStateWrite(async () => {
      const state = await this.readMirrorSyncState();
      state.mirrors[key] = entry;
      pruneMirrorSyncState(state);
      await this.writeMirrorSyncState(state);
    });
  }

  private async remoteMirrorLooksCurrent(
    worker: RemoteRunWorkerTarget,
    remotePath: string,
    expectGit: boolean,
    signal: AbortSignal | undefined
  ): Promise<boolean> {
    try {
      return await this.remoteMirrorProbe(worker, remotePath, expectGit, signal);
    } catch (error) {
      this.syncLogger?.("remote-run.sync.remote-check.error", {
        remotePath,
        message: errorMessage(error)
      });
      return false;
    }
  }

  private async readMirrorSyncState(): Promise<MirrorSyncStateFile> {
    try {
      const parsed = JSON.parse(await readFile(this.mirrorSyncStatePath(), "utf8")) as Partial<MirrorSyncStateFile>;
      if (parsed.version !== 1 || !parsed.mirrors || typeof parsed.mirrors !== "object" || Array.isArray(parsed.mirrors)) {
        return { version: 1, mirrors: {} };
      }
      return { version: 1, mirrors: parsed.mirrors as Record<string, MirrorSyncStateEntry> };
    } catch {
      return { version: 1, mirrors: {} };
    }
  }

  private async writeMirrorSyncState(state: MirrorSyncStateFile): Promise<void> {
    await mkdir(this.spoolRoot, { recursive: true });
    const target = this.mirrorSyncStatePath();
    const temp = path.join(this.spoolRoot, `.${MIRROR_SYNC_STATE_FILENAME}.${randomUUID()}.tmp`);
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(temp, target);
  }

  private async withMirrorSyncStateWrite<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.mirrorSyncStateChain;
    const next = previous.catch(() => undefined).then(fn);
    this.mirrorSyncStateChain = next.then(() => undefined, () => undefined);
    return next;
  }

  private mirrorSyncStatePath(): string {
    return path.join(this.spoolRoot, MIRROR_SYNC_STATE_FILENAME);
  }

  private mirrorSyncStateKey(worker: RemoteRunWorkerTarget, remotePath: string): string {
    return createHash("sha256")
      .update(JSON.stringify({ worker: mirrorSyncWorkerIdentity(worker), remotePath }))
      .digest("hex");
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
    if (sync) {
      // Mirror mode: the repo is nested under a per-project container
      // (".../<slug>/repo"). Make the container the writable root so the agent
      // can create sibling worktrees ("git worktree add ../feature") scoped to
      // this project, and so .git (mounted read-only under workspace-write) is
      // writable for commits. The container holds only this project's repo +
      // its worktrees, so widening it does not expose other mirrors.
      const hasGitDir = localProjectHasGitDir(sync.localPath);
      const container = sync.remotePath ? path.posix.dirname(sync.remotePath) : path.posix.dirname(effectiveRepoPath);
      return {
        networkAccess: true,
        gitWritableRoot: hasGitDir ? container : undefined,
        dangerFullAccess: hasGitDir
      };
    }
    // Pre-provisioned repo on a user-managed box: stay conservative and only
    // open .git — we don't own the parent directory layout there.
    let hasGitDir = false;
    try {
      hasGitDir = await this.remoteGitDirProbe(request.worker, `${effectiveRepoPath}/.git`, request.signal);
    } catch {
      hasGitDir = false;
    }
    return {
      networkAccess: true,
      gitWritableRoot: hasGitDir ? `${effectiveRepoPath}/.git` : undefined,
      dangerFullAccess: hasGitDir
    };
  }

  private async ensureRemoteToolchainPreflight(
    worker: RemoteRunWorkerTarget,
    options: RemoteRunToolchainPreflightOptions | undefined,
    signal: AbortSignal | undefined
  ): Promise<ToolchainPreflightIssue[]> {
    // `skip` is an intentional legacy/manual override. By default preflight
    // detects this repo's requirements, probes the real ones over SSH, and
    // caches the result per worker/toolchain set so the same requirement set is
    // not re-probed every turn.
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
        worker: mirrorSyncWorkerIdentity(worker),
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
          remoteIssues = [{
            tool: "remote-preflight",
            label: "Remote environment preflight",
            severity: "advisory",
            category: "probe",
            detail: `Could not verify worker tooling: ${errorMessage(error)}`,
            sources: [],
            remediation: {
              kind: "manual",
              message: "The run will continue; use Cloud Runs setup/check if tooling errors appear."
            }
          }];
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

  private remoteExecutionError(execution: RemoteCodexExecutionResult, kind: ParticipantConfig["kind"]): string | undefined {
    const label = kind === "claude-code" ? "Claude" : "Codex";
    if (execution.timedOut) {
      return `Remote ${label} run timed out.`;
    }
    if (execution.exitCode !== 0) {
      const diagnostic = execution.stderr.trim() || execution.stdout.trim();
      return diagnostic
        ? `Remote ${label} exited with code ${execution.exitCode}: ${diagnostic}`
        : `Remote ${label} exited with code ${execution.exitCode}.`;
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
    const result = await runWithSshRetries(
      () => runCommand(sshPath, [...sshBaseArgs, toolchainProbeScript(request.requirements)], {
        timeoutMs: 30_000,
        signal: request.signal
      }),
      { signal: request.signal }
    );
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
      throw new Error(`Remote member session could not be prepared (${String(result.status ?? "unknown")}).`);
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
      throw new Error("Remote member session handle is missing.");
    }
    const sshPath = request.worker.sshPath?.trim() || "ssh";
    const sshBaseArgs = remoteSshBaseArgs(request.worker, remoteSshTarget(request.worker));
    const root = await resolveRemoteRunDir(
      sshPath,
      sshBaseArgs,
      remoteWorkerRootForTarget(request.worker),
      request.signal
    );
    const resolvedRunDir = await resolveRemoteRunDir(
      sshPath,
      sshBaseArgs,
      request.remoteRunDir,
      request.signal
    );
    const resolvedFinalPath = `${resolvedRunDir}/final.txt`;
    const secretEnvPath = request.invocation.secretEnv ? `${resolvedRunDir}/secret-env.json` : undefined;
    const invocationArgs = replaceArgValue(request.invocation.args, request.remoteFinalPath, resolvedFinalPath);
    const invocation = {
      runId: request.runId,
      conversationId: request.conversationId,
      participantId: request.participant.id,
      providerKind: request.invocation.providerKind,
      args: invocationArgs,
      input: request.invocation.input,
      env: request.invocation.env ?? {},
      codexPath: request.worker.codexPath?.trim() || "codex",
      commandPath: request.invocation.executablePath,
      remoteCwd: request.worker.remoteCwd?.trim() || request.invocation.remoteCwd?.trim(),
      finalPath: resolvedFinalPath,
      ...(secretEnvPath ? { secretEnvPath } : {}),
      maxRuntimeMs: request.maxRuntimeMs,
      resumeSessionId: resumeSessionIdFromArgs(invocationArgs),
      fallbackSessionId: request.invocation.fallbackSessionId,
      sourceMessageId: request.sourceMessageId,
      threadId: request.threadId,
      chatThreadRootId: request.chatThreadRootId
    };
    if (secretEnvPath) {
      await writeRemoteFile(sshPath, sshBaseArgs, secretEnvPath, JSON.stringify(request.invocation.secretEnv), request.signal);
    }
    const result = await this.runSessionControl(request.worker, root, "submit", {
      sessionDir: session.sessionDir,
      runId: request.runId,
      runDir: resolvedRunDir,
      prompt: request.invocation.input,
      invocation,
      contextSnapshot: request.contextSnapshot ?? null
    }, request.signal);
    if (result.ok !== true) {
      throw new Error(`Remote member session rejected the turn (${String(result.status ?? "unknown")}).`);
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
    const leaseId = randomUUID();
    try {
      const result = await this.runSessionControl(worker, root, "authorize-stop", {
        protocolVersion: REMOTE_SESSION_PROTOCOL_VERSION,
        ownerId,
        leaseId,
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
    const secretEnvPath = request.invocation.secretEnv ? `${resolvedRunDir}/secret-env.json` : undefined;
    const invocationArgs = replaceArgValue(request.invocation.args, request.remoteFinalPath, resolvedFinalPath);
    const config = {
      runId: request.runId,
      conversationId: request.conversationId,
      participantId: request.participant.id,
      providerKind: request.invocation.providerKind,
      args: invocationArgs,
      input: request.invocation.input,
      env: request.invocation.env ?? {},
      codexPath: request.worker.codexPath?.trim() || "codex",
      commandPath: request.invocation.executablePath,
      remoteCwd: request.worker.remoteCwd?.trim() || request.invocation.remoteCwd?.trim(),
      finalPath: resolvedFinalPath,
      ...(secretEnvPath ? { secretEnvPath } : {}),
      maxRuntimeMs: request.maxRuntimeMs,
      resumeSessionId: resumeSessionIdFromArgs(invocationArgs),
      fallbackSessionId: request.invocation.fallbackSessionId,
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
    if (secretEnvPath) {
      await writeRemoteFile(sshPath, sshBaseArgs, secretEnvPath, JSON.stringify(request.invocation.secretEnv), request.signal);
    }
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
    const protocol = remoteSessionProtocolPayload();
    let protocolCurrent = false;
    try {
      const result = await runCommand(sshPath, [...sshBaseArgs, `cat ${shellQuote(`${root}/protocol.json`)}`], {
        timeoutMs: 30_000,
        signal
      });
      const parsed = JSON.parse(result.stdout) as { version?: unknown };
      protocolCurrent = remoteSessionProtocolMatchesCurrent(parsed);
    } catch {
      protocolCurrent = false;
    }
    if (!protocolCurrent) {
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
            version: protocol.version,
            files: protocol.files
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
    const invoke = () => runCommand(sshPath, [...sshBaseArgs, command], {
      input: JSON.stringify(payload),
      timeoutMs: REMOTE_SESSION_SSH_TIMEOUT_MS,
      signal
    });
    try {
      // "submit" is not idempotent — a retry could double-submit a turn. Every
      // other control action (ensure/inspect/list/stop/lease/cancel) is safe to
      // re-run, so retry them past a transient connection drop instead of failing
      // the warm-session check and needlessly cold-launching. A real session-level
      // error (non-transient) still surfaces immediately below.
      const result = action === "submit"
        ? await invoke()
        : await runWithSshRetries(invoke, { signal, attempts: REMOTE_SESSION_SSH_RETRY_ATTEMPTS });
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

function mirrorSyncWorkerIdentity(worker: RemoteRunWorkerTarget): Record<string, string | number | undefined> {
  const stableHost = worker.hostKeyAlias?.trim() || worker.host;
  return {
    host: stableHost,
    user: worker.user,
    port: worker.port,
    identityFile: worker.identityFile,
    hostKeyAlias: worker.hostKeyAlias,
    sshPath: worker.sshPath,
    workerRoot: worker.workerRoot,
    remoteCwd: worker.remoteCwd
  };
}

export function pruneMirrorSyncState(state: MirrorSyncStateFile): void {
  const entries = Object.entries(state.mirrors);
  if (entries.length <= MAX_MIRROR_SYNC_STATE_ENTRIES) {
    return;
  }
  entries
    .sort((a, b) => a[1].updatedAt < b[1].updatedAt ? -1 : a[1].updatedAt > b[1].updatedAt ? 1 : 0)
    .slice(0, entries.length - MAX_MIRROR_SYNC_STATE_ENTRIES)
    .forEach(([key]) => {
      delete state.mirrors[key];
    });
}

async function runWithTimeoutSignal<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
  parentSignal: AbortSignal | undefined
): Promise<T> {
  if (parentSignal?.aborted) {
    throw new Error("Remote run was cancelled.");
  }
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  parentSignal?.addEventListener("abort", abort, { once: true });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(timeoutMessage));
    }, timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    parentSignal?.removeEventListener("abort", abort);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface BuildRemoteAgentInvocationRequest {
  participant: ParticipantConfig;
  prompt: string;
  outputPath: string;
  worker: RemoteRunWorkerTarget;
  repoPath?: string;
  diffMode?: GitDiffMode;
  kind: ConversationKind;
  options?: CodexExecOptions;
}

interface RemoteClaudeToolConfig {
  permissionMode: "default" | "plan" | "acceptEdits" | "auto" | "bypassPermissions";
  allowedTools: string[];
  disallowedTools: string[];
  askTools: string[];
}

function buildRemoteAgentInvocation(request: BuildRemoteAgentInvocationRequest): RemoteAgentInvocation {
  const remoteCwd = request.worker.remoteCwd?.trim() || request.repoPath;
  if (request.participant.kind === "codex-cli") {
    const invocation = splitRemoteAgentInvocationSecrets({
      ...buildCodexExecInvocation(request),
      providerKind: "codex-cli",
      executablePath: remoteAgentExecutablePath("codex-cli", request.worker),
      remoteCwd
    });
    return {
      ...invocation
    };
  }
  if (request.participant.kind === "claude-code") {
    return splitRemoteAgentInvocationSecrets({
      ...buildRemoteClaudeInvocation(request),
      remoteCwd
    });
  }
  throw new Error(`Cloud Runs does not support ${request.participant.kind}.`);
}

function splitRemoteAgentInvocationSecrets(invocation: RemoteAgentInvocation): RemoteAgentInvocation {
  const env = invocation.env;
  if (!env) {
    return invocation;
  }
  const publicEnv: NodeJS.ProcessEnv = {};
  const secretEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      continue;
    }
    if (REMOTE_SECRET_ENV_KEYS.has(key)) {
      secretEnv[key] = value;
    } else {
      publicEnv[key] = value;
    }
  }
  return {
    ...invocation,
    env: Object.keys(publicEnv).length > 0 ? publicEnv : undefined,
    secretEnv: Object.keys(secretEnv).length > 0 ? secretEnv : undefined
  };
}

function buildRemoteClaudeInvocation(request: BuildRemoteAgentInvocationRequest): RemoteAgentInvocation {
  const options = request.options ?? {};
  const extraReadableDirs = normalizedExtraReadableDirs(options.extraReadableDirs);
  const toolConfig = remoteClaudeToolConfig(request.kind, request.repoPath, extraReadableDirs, options);
  const newSessionId = options.persistSession && !options.sessionId ? randomUUID() : undefined;
  const args = [
    "-p",
    "--output-format",
    "json",
    "--permission-mode",
    toolConfig.permissionMode
  ];
  const allowedTools = remoteClaudeAllowedTools(toolConfig);
  if (allowedTools.length > 0) {
    args.push("--allowedTools", allowedTools.join(","));
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
  if (request.participant.model) {
    args.push("--model", request.participant.model);
  }
  const reasoningEffort = remoteClaudeReasoningEffort(request.participant.reasoningEffort);
  if (reasoningEffort) {
    args.push("--effort", reasoningEffort);
  }
  const role = remoteClaudeRole(options);
  if (role) {
    args.push("--agents", JSON.stringify({
      [role.name]: {
        description: role.description,
        prompt: role.instructions
      }
    }), "--agent", role.name);
  }
  if (options.appMcp) {
    args.push("--mcp-config", remoteClaudeMcpConfigJson(options.appMcp));
    if (request.kind !== "chat") {
      args.push("--strict-mcp-config");
    }
  }
  if (extraReadableDirs.length > 0) {
    args.push("--add-dir", ...extraReadableDirs);
  }
  return {
    args,
    input: remoteAgentPrompt(
      role ? request.prompt : remotePromptWithRoleInstructions(request.prompt, options.role?.instructions),
      request.repoPath,
      request.diffMode,
      request.kind,
      options
    ),
    env: remoteAgentInvocationEnv(options),
    providerKind: "claude-code",
    executablePath: remoteAgentExecutablePath("claude-code", request.worker),
    fallbackSessionId: newSessionId
  };
}

function remoteClaudeRole(options: CodexExecOptions): { name: string; description: string; instructions: string } | undefined {
  const role = options.role as { name?: unknown; description?: unknown; instructions?: unknown } | undefined;
  if (
    typeof role?.name === "string" &&
    role.name.trim() &&
    typeof role.description === "string" &&
    typeof role.instructions === "string" &&
    role.instructions.trim()
  ) {
    return {
      name: role.name.trim(),
      description: role.description.trim(),
      instructions: role.instructions
    };
  }
  return undefined;
}

function remotePromptWithRoleInstructions(prompt: string, instructions: string | undefined): string {
  const trimmed = instructions?.trim();
  if (!trimmed) {
    return prompt;
  }
  return [
    "Role instructions for this AccordAgents participant:",
    trimmed,
    "",
    prompt
  ].join("\n");
}

function remoteClaudeToolConfig(
  kind: ConversationKind,
  repoPath: string | undefined,
  extraReadableDirs: string[],
  options: CodexExecOptions
): RemoteClaudeToolConfig {
  const agentMode = agentModeForRun(kind, options);
  const permissions = permissionsForRun("claude-code", agentMode, options);
  const allowedTools: string[] = [];
  const disallowedTools: string[] = [];
  const askTools: string[] = [];
  const readContextAvailable = Boolean(repoPath) || extraReadableDirs.length > 0;
  const readTools = ["Read", "Grep", "Glob", "LS"];
  const editTools = ["Edit", "Write", "NotebookEdit"];
  const webTools = ["WebSearch", "WebFetch"];

  if (readContextAvailable) {
    allowedTools.push(...readTools);
  }
  if (permissions.webAccess) {
    allowedTools.push(...webTools);
  } else {
    disallowedTools.push(...webTools);
  }
  if (permissions.workspaceWrite) {
    allowedTools.push(...editTools);
  } else {
    disallowedTools.push(...editTools);
  }
  if (permissions.shell.enabled) {
    allowedTools.push("Bash");
    for (const rule of permissions.shell.rules) {
      const toolRule = remoteClaudeBashPermissionRule(rule);
      if (agentMode !== "auto") {
        if (rule.action === "deny") {
          disallowedTools.push(toolRule);
        } else if (rule.action === "allow") {
          allowedTools.push(toolRule);
        } else {
          askTools.push(toolRule);
        }
      }
    }
  } else {
    disallowedTools.push("Bash");
  }
  for (const toolRule of permissions.providerNative?.["claude-code"]?.allowedTools ?? []) {
    allowedTools.push(toolRule);
  }
  for (const toolName of remoteAppMcpToolNames(options)) {
    allowedTools.push(`mcp__accord_agents__${toolName}`);
  }
  allowedTools.push("Skill", "Agent", "Task");

  return {
    permissionMode: remoteClaudePermissionMode(kind, options, permissions),
    allowedTools: Array.from(new Set(allowedTools)),
    disallowedTools: Array.from(new Set(disallowedTools)),
    askTools: Array.from(new Set(askTools))
  };
}

function remoteClaudePermissionMode(
  kind: ConversationKind,
  options: CodexExecOptions,
  permissions: ChatAgentPermissions
): RemoteClaudeToolConfig["permissionMode"] {
  const mode = agentModeForRun(kind, options);
  if (mode === "plan") {
    return "plan";
  }
  if (mode === "auto") {
    return "bypassPermissions";
  }
  return permissions.workspaceWrite ? "acceptEdits" : "default";
}

function remoteClaudeAllowedTools(toolConfig: RemoteClaudeToolConfig): string[] {
  return toolConfig.allowedTools;
}

function remoteAppMcpToolNames(options: CodexExecOptions): string[] {
  const explicit = (options.appMcp as { toolNames?: unknown } | undefined)?.toolNames;
  if (Array.isArray(explicit)) {
    return explicit.filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
  }
  return options.appMcp
    ? [
      "app_permissions_request_change",
      "app_chat_get_context",
      "app_chat_get_participants",
      "app_chat_read_messages",
      "app_chat_list_attachments",
      "app_chat_read_attachment",
      "app_chat_send_message"
    ]
    : [];
}

function remoteClaudeMcpConfigJson(appMcp: NonNullable<CodexExecOptions["appMcp"]>): string {
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

function remoteClaudeBashPermissionRule(rule: ChatShellPermissionRule): string {
  const pattern = rule.pattern.trim();
  return rule.match === "prefix" ? `Bash(${pattern}:*)` : `Bash(${pattern})`;
}

function remoteClaudeReasoningEffort(value: ChatReasoningEffort | undefined): ChatReasoningEffort | undefined {
  const normalized = normalizeChatReasoningEffort(value, "claude-code");
  return normalized && normalized !== "none" ? normalized : undefined;
}

function remoteAgentInvocationEnv(options: CodexExecOptions): NodeJS.ProcessEnv | undefined {
  const appMcpEnv = options.appMcp
    ? { [CODEX_APP_SERVER_MCP_TOKEN_ENV]: options.appMcp.token }
    : undefined;
  if (!options.extraEnv && !appMcpEnv) {
    return undefined;
  }
  return { ...options.extraEnv, ...(appMcpEnv ?? {}) };
}

function remoteAgentPrompt(
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
  ].filter(Boolean).join("\n\n");
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

function remoteAgentExecutablePath(kind: ParticipantConfig["kind"], worker: RemoteRunWorkerTarget): string {
  return kind === "claude-code"
    ? worker.claudePath?.trim() || "claude"
    : worker.codexPath?.trim() || "codex";
}

function extractRemoteAgentSessionId(kind: ParticipantConfig["kind"], stdout: string): string | undefined {
  if (kind === "claude-code") {
    return extractRemoteClaudeSessionId(stdout);
  }
  return extractCodexSessionId(stdout);
}

function extractRemoteAgentText(kind: ParticipantConfig["kind"], stdout: string): string {
  if (kind === "claude-code") {
    return extractRemoteClaudeText(stdout);
  }
  return extractCodexText(stdout);
}

function extractRemoteClaudeText(stdout: string): string {
  for (const candidate of [stdout, ...stdout.split(/\r?\n/).reverse()]) {
    const trimmed = candidate.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as { result?: string; content?: string; message?: string };
      return parsed.result ?? parsed.content ?? parsed.message ?? trimmed;
    } catch {
      // Try the next line before falling back to raw stdout.
    }
  }
  return stdout.trim();
}

function extractRemoteClaudeSessionId(stdout: string): string | undefined {
  for (const candidate of [stdout, ...stdout.split(/\r?\n/).reverse()]) {
    const trimmed = candidate.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as { session_id?: string; sessionId?: string };
      const sessionId = parsed.session_id ?? parsed.sessionId;
      if (sessionId?.trim()) {
        return sessionId.trim();
      }
    } catch {
      // Try the next line.
    }
  }
  return undefined;
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
    hostKeyAlias: worker.hostKeyAlias,
    workerRoot: worker.workerRoot,
    remoteCwd: worker.remoteCwd,
    codexPath: worker.codexPath,
    claudePath: worker.claudePath
  };
}

function targetFromSessionHandle(handle: RemoteParticipantSessionHandle): RemoteRunWorkerTarget {
  const host = handle.worker.host?.trim();
  if (!host) {
    throw new Error("Remote member session has no worker host.");
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
  // Read-only path resolution: safe to retry past a transient connection drop.
  const result = await runWithSshRetries(
    () => runCommand(sshPath, [...sshBaseArgs, command], {
      timeoutMs: REMOTE_SESSION_SSH_TIMEOUT_MS,
      signal
    }),
    { signal, attempts: REMOTE_SESSION_SSH_RETRY_ATTEMPTS }
  );
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

async function defaultRemoteMirrorProbe(
  worker: RemoteRunWorkerTarget,
  remotePath: string,
  expectGit: boolean,
  signal?: AbortSignal
): Promise<boolean> {
  const sshPath = worker.sshPath?.trim() || "ssh";
  const target = buildCloudRunSshTarget(worker);
  const sshBaseArgs = remoteSshBaseArgs(worker, target);
  const gitCheck = expectGit ? ` && test -e ${shellQuote(`${remotePath}/.git`)}` : "";
  const result = await runCommand(sshPath, [
    ...sshBaseArgs,
    `test -d ${shellQuote(remotePath)}${gitCheck} && printf yes || printf no`
  ], {
    timeoutMs: REMOTE_SESSION_SSH_TIMEOUT_MS,
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
  const executablePath = request.invocation.executablePath?.trim() || remoteAgentExecutablePath(request.invocation.providerKind, request.worker);
  const cd = request.worker.remoteCwd?.trim()
    ? `cd ${shellQuote(request.worker.remoteCwd.trim())} || exit 125; `
    : "";
  const tokenEnv = tokenPath
    ? `${CODEX_APP_SERVER_MCP_TOKEN_ENV}="$(cat ${shellQuote(tokenPath)})" `
    : "";
  const codexArgs = request.invocation.args.map((arg) => shellQuote(arg)).join(" ");
  return [
    `rm -f ${shellQuote(request.remoteFinalPath)}`,
    `${cd}${tokenEnv}${shellQuote(executablePath)} ${codexArgs}`
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

// Snapshot every project-container dir under `${root}/mirrors/` in one round
// trip: for each container report whether it has the current `repo/` layout and
// a direct `.git`, then list its non-repo child dirs marking real linked
// worktrees (a `.git` FILE) and whether the mirror repo still registers each.
// Output is TSV: `C\t<hasRepo>\t<hasGit>\t<containerPath>` and
// `W\t<isWorktree>\t<registered>\t<worktreePath>`.
async function enumerateWorkerMirrorContainers(
  sshPath: string,
  sshBaseArgs: string[],
  mirrorsDir: string,
  signal: AbortSignal | undefined
): Promise<WorkerMirrorContainerSnapshot[]> {
  const quotedDir = shellQuote(mirrorsDir);
  const script = [
    `MIR=${quotedDir}`,
    `[ -d "$MIR" ] || exit 0`,
    `for c in "$MIR"/*/; do`,
    `  [ -d "$c" ] || continue`,
    `  c=\${c%/}`,
    `  hasrepo=0; [ -d "$c/repo" ] && hasrepo=1`,
    `  hasgit=0; [ -d "$c/.git" ] && hasgit=1`,
    `  printf 'C\\t%s\\t%s\\t%s\\n' "$hasrepo" "$hasgit" "$c"`,
    `  for w in "$c"/*/; do`,
    `    [ -d "$w" ] || continue`,
    `    w=\${w%/}`,
    `    base=\${w##*/}`,
    `    [ "$base" = repo ] && continue`,
    `    iswt=0; [ -f "$w/.git" ] && iswt=1`,
    `    reg=0; [ -e "$c/repo/.git/worktrees/$base" ] && reg=1`,
    `    printf 'W\\t%s\\t%s\\t%s\\n' "$iswt" "$reg" "$w"`,
    `  done`,
    `done`
  ].join("\n");
  const result = await runCommand(sshPath, [...sshBaseArgs, script], {
    timeoutMs: 30_000,
    signal
  });
  const byPath = new Map<string, WorkerMirrorContainerSnapshot>();
  let current: WorkerMirrorContainerSnapshot | undefined;
  for (const line of result.stdout.split(/\r?\n/)) {
    const fields = line.split("\t");
    if (fields[0] === "C" && fields.length === 4 && fields[3].startsWith("/")) {
      current = {
        path: fields[3],
        hasRepoSubdir: fields[1] === "1",
        hasDirectGitDir: fields[2] === "1",
        worktrees: []
      };
      byPath.set(current.path, current);
    } else if (fields[0] === "W" && fields.length === 4 && current && fields[3].startsWith("/")) {
      current.worktrees.push({
        path: fields[3],
        isWorktree: fields[1] === "1",
        registered: fields[2] === "1"
      });
    }
  }
  return [...byPath.values()];
}

// Delete a bounded set of reclaimed mirror paths. Every path is re-verified to
// sit under `${mirrorsDir}/` before removal as defense-in-depth against a
// parsing slip ever turning into an `rm -rf` outside the mirror tree.
async function removeRemoteWorkerPaths(
  sshPath: string,
  sshBaseArgs: string[],
  paths: string[],
  signal: AbortSignal | undefined
): Promise<void> {
  const targets = paths.filter((candidate) => candidate.startsWith("/") && !candidate.includes(".."));
  if (targets.length === 0) {
    return;
  }
  const command = `rm -rf ${targets.map((candidate) => shellQuote(candidate)).join(" ")}`;
  await runCommand(sshPath, [...sshBaseArgs, command], {
    timeoutMs: 60_000,
    signal,
    primeLoginShellEnv: false
  }).catch(() => undefined);
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

export function detachedWorkerScript(): string {
  return String.raw`const fs = require("node:fs");
const cp = require("node:child_process");
const crypto = require("node:crypto");
const http = require("node:http");

const runDir = process.cwd();
const config = JSON.parse(fs.readFileSync("invocation.json", "utf8"));
const providerKind = config.providerKind || "codex-cli";
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

function providerLabel() {
  return providerKind === "claude-code" ? "Claude" : "Codex";
}

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

function loadSecretEnvOnce() {
  const secretEnvPath = typeof config.secretEnvPath === "string" ? config.secretEnvPath : "";
  if (!secretEnvPath) {
    return {};
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(secretEnvPath, "utf8"));
    try { fs.unlinkSync(secretEnvPath); } catch {}
    const env = {};
    for (const [key, value] of Object.entries(parsed || {})) {
      if (typeof value === "string") {
        env[key] = value;
      }
    }
    return env;
  } catch (error) {
    try { fs.unlinkSync(secretEnvPath); } catch {}
    const message = error instanceof Error ? error.message : String(error);
    throw new Error("Remote secret env file could not be loaded: " + message);
  }
}

let runSecretEnv;
let startupError;
try {
  runSecretEnv = loadSecretEnvOnce();
} catch (error) {
  runSecretEnv = {};
  startupError = error instanceof Error ? error.message : String(error);
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
  if (providerKind !== "codex-cli") {
    finishRun(null, undefined, false, "Remote " + providerLabel() + " permission approval cannot be resumed on the worker yet.");
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
    startProvider(permissionResumePrompt(requestId, pending.request, decision), resumeArgsForDecision(pending.request, decision), true);
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
          title: "Get Chat Members Snapshot",
          description: "Read member data from the run-start context snapshot.",
          inputSchema: { type: "object", additionalProperties: false, properties: {} }
        },
        {
          name: "app_chat_read_messages",
          title: "Read Chat Messages",
          description: "Read paginated chat messages from the run-start snapshot, optionally filtered to one thread or one message id. Same result shape as the desktop tool. The window is fixed at run start: messages posted after this run began are not in it, and the page counts describe the snapshot, not the live conversation.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              messageId: { type: "string" },
              threadId: { type: "string" },
              beforeSequence: { type: "integer", minimum: 0 },
              afterSequence: { type: "integer", minimum: 0 },
              limit: { type: "integer", minimum: 1, maximum: 200 }
            }
          }
        },
        {
          name: "app_chat_send_message",
          title: "Post A Message Mid-Run",
          description: "Post a message to the chat while this run is still working. The post is queued on the worker and appears when the desktop next drains this run, so it is not instant and returns no message id. Text only.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["content"],
            properties: { content: { type: "string" } }
          }
        },
        {
          name: "app_chat_list_attachments",
          title: "List Chat Image Attachments",
          description: "List image attachments visible in the run-start snapshot, oldest first. Use this for attachment ids, then app_chat_read_attachment to see one.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              messageId: { type: "string" },
              threadId: { type: "string" },
              limit: { type: "integer", minimum: 1, maximum: 50 }
            }
          }
        },
        {
          name: "app_chat_read_attachment",
          title: "Read Chat Image Attachment",
          description: "Read one image attachment bundled with this run and return it as image content. Only attachments visible at run start are available.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["attachmentId"],
            properties: { attachmentId: { type: "string" } }
          }
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
  if (name === "app_chat_send_message") {
    if (notify) {
      return undefined;
    }
    const content = typeof args.content === "string" ? args.content.trim() : "";
    if (!content) {
      return rpcError(id, -32602, "ChatSendMessageDenied. Problem: content was empty. Cause: a mid-run post must carry text. Fix: pass a non-empty content string.");
    }
    if (content.length > 20000) {
      return rpcError(id, -32602, "ChatSendMessageDenied. Problem: content is too long for a mid-run post. Cause: the limit is 20000 characters. Fix: post a shorter update, or put the long form in an artifact when the run is over.");
    }
    if (args.attachments !== undefined) {
      // Refused rather than silently dropped: a member that believes it sent an
      // image and did not is worse than one told it cannot.
      return rpcError(id, -32602, "ChatSendMessageDenied. Problem: attachments cannot be sent from a cloud run yet. Cause: this run posts through the desktop's event spool, which carries text. Fix: post the text now and attach the image from a desktop turn.");
    }
    const event = appendEvent({
      kind: "chat_message",
      content,
      sourceMessageId: config.sourceMessageId,
      threadId: config.threadId,
      chatThreadRootId: config.chatThreadRootId
    });
    return rpcResult(id, toolTextResult({
      ok: true,
      // No message id: the message does not exist yet. Saying "sent" with a
      // fabricated id would be a lie the member would then quote.
      status: "queued_for_desktop",
      queuedAt: event.createdAt,
      workerSeq: event.workerSeq,
      note: "The post is queued on the worker and appears in the chat when the desktop next drains this run."
    }));
  }
  if (name === "app_chat_get_context") {
    return notify ? undefined : rpcResult(id, toolTextResult({
      ok: true,
      snapshot: contextSnapshot()
    }));
  }
  if (name === "app_chat_read_messages") {
    if (notify) {
      return undefined;
    }
    const snapshot = contextSnapshot();
    const record = snapshot && typeof snapshot === "object" ? snapshot : {};
    const all = Array.isArray(record.messages) ? record.messages : [];
    const window = record.messageWindow && typeof record.messageWindow === "object" ? record.messageWindow : {};
    const messageId = typeof args.messageId === "string" && args.messageId.trim() ? args.messageId.trim() : undefined;
    const threadId = typeof args.threadId === "string" && args.threadId.trim() ? args.threadId.trim() : undefined;
    const before = typeof args.beforeSequence === "number" && isFinite(args.beforeSequence) ? args.beforeSequence : undefined;
    const after = typeof args.afterSequence === "number" && isFinite(args.afterSequence) ? args.afterSequence : undefined;
    const limit = typeof args.limit === "number" && isFinite(args.limit) && args.limit > 0
      ? Math.min(200, Math.floor(args.limit))
      : 40;
    // Same precedence as the desktop tool: an explicit message id ignores every
    // other filter, and a forward page reads from the start of the match rather
    // than the end.
    const matched = all.filter((message) => {
      if (!message || typeof message !== "object") {
        return false;
      }
      if (messageId) {
        return message.id === messageId;
      }
      if (threadId && (!message.metadata || message.metadata.threadId !== threadId)) {
        return false;
      }
      const sequence = typeof message.sequence === "number" ? message.sequence : undefined;
      if (before !== undefined && sequence !== undefined && sequence >= before) {
        return false;
      }
      if (after !== undefined && sequence !== undefined && sequence <= after) {
        return false;
      }
      return true;
    });
    const selected = after !== undefined
      ? matched.slice(0, limit)
      : matched.slice(Math.max(0, matched.length - limit));
    const oldest = selected.length > 0 ? selected[0].sequence : undefined;
    const newest = selected.length > 0 ? selected[selected.length - 1].sequence : undefined;
    return rpcResult(id, toolTextResult({
      ok: true,
      conversationId: record.conversationId,
      requesterParticipantId: record.participantId,
      // Stated, not implied: a reader must be able to tell a quiet chat from a
      // stale window without comparing counts by hand.
      snapshotAtRunStart: true,
      filters: { messageId, threadId, beforeSequence: before, afterSequence: after, limit },
      messages: selected,
      page: {
        oldestSequence: oldest,
        newestSequence: newest,
        hasMoreBefore: oldest !== undefined
          ? matched.some((message) => typeof message.sequence === "number" && message.sequence < oldest)
          : false,
        hasMoreAfter: newest !== undefined
          ? matched.some((message) => typeof message.sequence === "number" && message.sequence > newest)
          : false,
        totalMessages: typeof window.totalMessages === "number" ? window.totalMessages : all.length,
        totalMatchingMessages: matched.length,
        oldestIncludedSequence: window.oldestIncludedSequence
      }
    }));
  }
  if (name === "app_chat_list_attachments" || name === "app_chat_read_attachment") {
    if (notify) {
      return undefined;
    }
    const snapshot = contextSnapshot();
    const record = snapshot && typeof snapshot === "object" ? snapshot : {};
    const bundled = Array.isArray(record.attachments) ? record.attachments : [];
    const window = record.attachmentWindow && typeof record.attachmentWindow === "object" ? record.attachmentWindow : {};
    if (name === "app_chat_read_attachment") {
      const attachmentId = typeof args.attachmentId === "string" ? args.attachmentId.trim() : "";
      const found = bundled.find((item) => item && item.attachment && item.attachment.id === attachmentId);
      if (!found) {
        // Same shape of refusal as the desktop: say why, and say what to call
        // next, rather than returning an empty image.
        return rpcError(id, -32602, "AttachmentReadDenied. Problem: this attachment was not bundled with this run. Cause: the id is absent, belongs to another conversation, is newer than this run, or fell outside the run's attachment budget. Fix: call app_chat_list_attachments for the ids that are available.");
      }
      const mimeType = found.attachment && typeof found.attachment.mimeType === "string"
        ? found.attachment.mimeType
        : "image/png";
      const summary = {
        conversationId: record.conversationId,
        requesterParticipantId: record.participantId,
        messageId: found.messageId,
        sequence: found.sequence,
        author: found.author,
        threadId: found.threadId,
        attachment: found.attachment,
        snapshotAtRunStart: true,
        dataBase64: "[omitted: returned as MCP image content]"
      };
      return rpcResult(id, {
        content: [
          { type: "text", text: JSON.stringify(summary, null, 2) },
          { type: "image", data: found.dataBase64, mimeType }
        ]
      });
    }
    const messageId = typeof args.messageId === "string" && args.messageId.trim() ? args.messageId.trim() : undefined;
    const threadId = typeof args.threadId === "string" && args.threadId.trim() ? args.threadId.trim() : undefined;
    const limit = typeof args.limit === "number" && isFinite(args.limit) && args.limit > 0
      ? Math.min(50, Math.floor(args.limit))
      : 20;
    const matched = bundled.filter((item) => {
      if (!item || typeof item !== "object") {
        return false;
      }
      if (messageId && item.messageId !== messageId) {
        return false;
      }
      if (threadId && item.threadId !== threadId) {
        return false;
      }
      return true;
    }).slice(-limit);
    return rpcResult(id, toolTextResult({
      ok: true,
      conversationId: record.conversationId,
      requesterParticipantId: record.participantId,
      snapshotAtRunStart: true,
      filters: { messageId, threadId, limit },
      attachments: matched.map((item) => ({
        messageId: item.messageId,
        sequence: item.sequence,
        author: item.author,
        threadId: item.threadId,
        attachment: item.attachment
      })),
      // Silence about a dropped image reads as "there were none".
      omittedCount: typeof window.omittedCount === "number" ? window.omittedCount : 0
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
      } else if (typeof event.result === "string") {
        messages.push(event.result);
      } else if (typeof event.content === "string") {
        messages.push(event.content);
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
  finishRun(null, undefined, false, "Remote " + providerLabel() + " run timed out.");
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
  finishRun(null, "SIGTERM", false, "Remote " + providerLabel() + " run was cancelled.");
});

startRelay(() => startProvider(config.input || "", config.args || [], false));

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
      ? "Remote " + providerLabel() + " run timed out."
      : cancelled
        ? "Remote " + providerLabel() + " run was cancelled."
        : stderr.trim() || (signal ? "Remote " + providerLabel() + " exited from signal " + signal + "." : "Remote " + providerLabel() + " exited with code " + exitCode + ".");
  const startedAtMs = Date.parse(state.startedAt);
  const workerDurationMs = Number.isFinite(startedAtMs) ? Math.max(0, Date.now() - startedAtMs) : undefined;
  const effectiveSessionId = sessionId || attemptedSessionId || config.fallbackSessionId;
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

function startProvider(input, args, resuming) {
if (startupError) {
  finishRun(null, undefined, false, startupError);
  return;
}
let child;
try {
child = cp.spawn(config.commandPath || config.codexPath || "codex", args || [], {
  cwd: config.remoteCwd || undefined,
  env: { ...process.env, ...(config.env || {}), ...runSecretEnv },
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
        ? "Remote " + providerLabel() + " is waiting for another permission decision."
        : "Remote " + providerLabel() + " is waiting for a permission decision."
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

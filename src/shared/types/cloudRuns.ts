import type { AwsWorkerHandleInfo } from "./awsWorker";
import type { ChatExecutionLeaseMetadata, ChatPromptContextPointerAdvance } from "./messages";

export type CloudRunRemoteExecutionMode = "inherit" | "local" | "remote";

export type CloudRunStatus = "running" | "completed" | "failed" | "cancelled" | "unknown";

export interface CloudRunWorkerSettings {
  host?: string;
  user?: string;
  port?: number;
  identityFile?: string;
  hostKeyAlias?: string;
  workerRoot?: string;
  remoteCwd?: string;
  codexPath?: string;
  claudePath?: string;
}

export type CloudRunWorkerMode = "ssh" | "aws";

export interface CloudRunsSettings {
  enabled: boolean;
  mode: CloudRunWorkerMode;
  worker: CloudRunWorkerSettings;
  // AWS-managed worker: credentials are stored encrypted and never returned to
  // the renderer; only hasAwsCredentials + the non-sensitive handle are exposed.
  hasAwsCredentials: boolean;
  awsHandle?: AwsWorkerHandleInfo;
  awsRegion?: string;
  awsInstanceType: string;
  awsRootVolumeSizeGb: number;
  maxRuntimeMs: number;
  pollIntervalMs: number;
}

export interface CloudRunsSettingsUpdate {
  enabled?: boolean;
  mode?: CloudRunWorkerMode;
  worker?: CloudRunWorkerSettings;
  awsInstanceType?: string;
  awsRootVolumeSizeGb?: number;
  maxRuntimeMs?: number;
  pollIntervalMs?: number;
}

export interface CloudRunWorkerTestResult {
  ok: boolean;
  message: string;
}

export type CloudRunWorkerCheckId =
  | "connect"
  | "sudo"
  | "rsync"
  | "git"
  | "gh"
  | "java"
  | "node"
  | "build-essential"
  | "codex"
  | "codex-auth"
  | "claude"
  | "claude-auth"
  | "git-identity"
  | "persistent-storage"
  | "userns"
  | "browser"
  | "headless-display"
  | "sqlite3";

export type CloudRunWorkerCheckStatus = "pass" | "warn" | "fail";

export interface CloudRunWorkerCheck {
  id: CloudRunWorkerCheckId;
  label: string;
  status: CloudRunWorkerCheckStatus;
  detail?: string;
  // True when "Set up worker" knows how to repair this check automatically.
  fixable?: boolean;
}

export interface CloudRunWorkerDoctorReport {
  ok: boolean;
  message: string;
  checks: CloudRunWorkerCheck[];
}

export interface CloudRunWorkerSetupProgress {
  stage: string;
  message: string;
  // Present while a provider device-auth fix waits for the user to approve the
  // sign-in in their browser.
  authUrl?: string;
  authCode?: string;
  authProvider?: "codex-cli" | "claude-code";
  authRequestId?: string;
  /** How a provider sign-in ended, on its last frame. */
  signInOutcome?: "completed" | "skipped" | "expired" | "failed";
}

export interface RemoteRunSyncInfo {
  localPath: string;
  // Stable per-project mirror repo on the worker.
  remotePath?: string;
}

export interface RemoteRunHandle {
  runId: string;
  conversationId: string;
  participantId: string;
  participantHandle?: string;
  worker: CloudRunWorkerSettings;
  status: CloudRunStatus;
  workerCursorSeq?: number;
  providerOutputMessageId?: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  lastPolledAt?: string;
  error?: string;
  sync?: RemoteRunSyncInfo;
  promptContextPointerAdvance?: ChatPromptContextPointerAdvance;
  executionLease?: ChatExecutionLeaseMetadata;
}

export interface RemoteParticipantSessionHandle {
  sessionKey: string;
  sessionDir: string;
  worker: CloudRunWorkerSettings;
  protocolVersion: number;
  runtimeFingerprint: string;
  updatedAt: string;
}

export interface RemoteSessionCleanupTombstone {
  id: string;
  handle: RemoteParticipantSessionHandle;
  reason: "participant-removed" | "chat-archived" | "chat-deleted" | "app-quit";
  createdAt: string;
  conversationId?: string;
  participantId?: string;
  runIds?: string[];
  providerSessionIds?: string[];
  removeArtifacts?: boolean;
}

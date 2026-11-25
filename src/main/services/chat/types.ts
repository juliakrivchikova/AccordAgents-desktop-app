import type {
  ChatAgentMode, ChatAgentPermissions, ChatAppToolApproval, ChatBehaviorRuleSnapshot, ChatAppToolCapability,
  ChatAgentActivityEvent, ChatImageMimeType, ChatParticipant, ChatParticipantConfig, ChatParticipantChangeRequest,
  ChatPromptContextPointerScope, ChatProviderKind, ChatRemoteRunStatus, ChatRoleChangeRequest, ChatRoleParticipantDefaults,
  ChatRoleParticipantChangeRequest, ChatRosterChangeRequest, ChatReasoningEffort, CloudRunStatus, ReviewProgress
} from "../../../shared/types";
import type { AppMcpClientStatus } from "../appMcp";

export type ProgressCallback = (progress: ReviewProgress) => void;

/** How a member's turn was opened on the User's server (Д4, Д5, Д13). */
export type ServerTurnOpen =
  | { kind: "none" }
  | { kind: "local"; serverRunId: string }
  | { kind: "remote"; serverRunId: string; canonical: boolean }
  | { kind: "stopped"; serverRunId: string }
  | { kind: "skip"; serverRunId: string; reason: string };

export interface ResolvedChatParticipantRole {
  id: string;
  label: string;
  version: number;
  appToolCapabilities?: ChatAppToolCapability[];
  participantDefaults?: ChatRoleParticipantDefaults;
  instructions: string;
  behaviorRules: ChatBehaviorRuleSnapshot[];
}

/** A member's access as one turn runs it. */
export interface ChatMemberAccess {
  agentMode: ChatAgentMode;
  permissions: ChatAgentPermissions;
}

export type ChatPromptContextScope = ChatPromptContextPointerScope;

export type ChatAttachmentImportSourceRoot = "repo";

export interface ChatToolImageAttachmentInput {
  kind: "image";
  sourcePath: string;
  filename?: string;
  mimeType?: ChatImageMimeType;
}

// Reply context for dispatch routing. Threaded through every path that recomputes
// dispatch from a trigger message so skill validation never diverges from the
// actual dispatch target.
export type ChatDispatchReplyContext = { parentMessageId?: string; threadId?: string; chatThreadRootId?: string };

export interface ChatAppMcpGateway {
  issueToken(grant: {
    conversationId: string;
    participantId: string;
    roleConfigId: string;
    roleConfigVersion: number;
    capabilities: ChatAppToolCapability[];
    clientGenerationId?: string;
    expectedToolNames?: string[];
    triggerMessageId?: string;
    triggerThreadId?: string;
    triggerParentMessageId?: string;
    triggerChatThreadRootId?: string;
    snapshotMaxSequence?: number;
    continuation?: boolean;
    runId?: string;
    turnSegmentId?: string;
    participantRequestDepth?: number;
    participantRequestBatchId?: string;
    chainRootId?: string;
    historyMarkdownPath?: string;
    historyJsonPath?: string;
    agentMode?: ChatAgentMode;
    runPermissions?: ChatAgentPermissions;
  }): { url: string; token: string } | undefined;
  updateToken?(token: string, grant: ChatAppMcpTokenGrant): { url: string; token: string } | undefined;
  clientStatus?(clientGenerationId: string): AppMcpClientStatus | undefined;
}

export type ChatAppMcpTokenGrant = Parameters<ChatAppMcpGateway["issueToken"]>[0];

export interface ChatAppMcpActor {
  conversationId: string;
  participantId: string;
  roleConfigId: string;
  roleConfigVersion: number;
  capabilities: ChatAppToolCapability[];
  triggerMessageId?: string;
  triggerThreadId?: string;
  triggerParentMessageId?: string;
  triggerChatThreadRootId?: string;
  snapshotMaxSequence?: number;
  continuation?: boolean;
  runId?: string;
  turnSegmentId?: string;
  participantRequestDepth?: number;
  participantRequestBatchId?: string;
  chainRootId?: string;
  historyMarkdownPath?: string;
  historyJsonPath?: string;
  agentMode?: ChatAgentMode;
  runPermissions?: ChatAgentPermissions;
}

/** What the main session asks for when it gives a new member a task
 *  (app_chat_delegate_task). */
export interface ChatTaskDelegationInput {
  task: string;
  /** Its short title (sessionsTaskTitle), as given. */
  title?: string;
  start?: "clean" | "fork";
  handle?: string;
  roleConfigId?: string;
  kind?: ChatProviderKind;
  model?: string;
  reasoningEffort?: ChatReasoningEffort;
  agentMode?: ChatAgentMode;
  /** The rights asked for, as given: what is left out is the main
   *  session's own. */
  permissions?: Record<string, unknown>;
  reason?: string;
}

export interface PreparedRosterChange {
  request: ChatRosterChangeRequest;
  participants: ChatParticipant[];
  summary: string;
  managementEscalation: boolean;
}

export interface PreparedRoleChange {
  request: ChatRoleChangeRequest;
  summary: string;
  managementEscalation: boolean;
}

export interface PreparedParticipantChange {
  request: ChatParticipantChangeRequest;
  participants: ChatParticipant[];
  presetParticipantConfigs: ChatParticipantConfig[];
  summary: string;
  managementEscalation: boolean;
}

export interface PreparedRoleParticipantChange {
  request: ChatRoleParticipantChangeRequest;
  role: PreparedRoleChange;
  participant: PreparedParticipantChange;
  summary: string;
  managementEscalation: boolean;
}

/** A device decision records its native-effect claim after validation and
 * before applying permissions or waking a CLI. A replay must never cross this
 * boundary twice, even if the caller lost its final acknowledgement. */
export interface ChatApprovalExecutionGuard {
  beforeApply(approval: ChatAppToolApproval): Promise<void>;
  awaitNativeDelivery?: boolean;
}

export interface ParticipantTurnReservation {
  queued: boolean;
  /** A shared turn (a Claude Code member's message to its CLI) asked while
   *  an earlier turn of the member still runs: its CLI holds the message in
   *  its queue until the running step's next tool result, as the dedicated
   *  CLI shows it ("Queued"), so its reply is queued until the CLI starts it
   *  (onReplyStarted). */
  behindMemberTurn?: boolean;
  wait: () => Promise<void>;
  release: () => void;
}

interface RemoteRunReplayState {
  cursorSeq: number;
  appliedRecordIds: string[];
  permissionRequestIdsByRecordId?: Record<string, string>;
  terminalState?: string;
  providerOutputMessageId?: string;
  providerOutputText?: string;
  providerOutputLineBuffer?: string;
  providerSessionId?: string;
  successfulProviderKind?: ChatProviderKind;
  providerActivityEvents?: ChatAgentActivityEvent[];
  providerActivitySequence?: number;
  providerActivityLabel?: string;
  providerOmittedActivityEventCount?: number;
  remoteRunStatus?: ChatRemoteRunStatus;
  updatedAt?: string;
}

type RemoteRunReplayStateByRun = Record<string, RemoteRunReplayState>;

type RemoteRunTerminalOutcome = Exclude<CloudRunStatus, "running" | "unknown">;

interface RemoteRunTerminalizationResult {
  changed: boolean;
  autoResumeRequestMessageIds: string[];
}

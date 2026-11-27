import type { ChatScriptChangeRequest } from "../scripts";
import type { ChatToolPermissionScope } from "../toolPermissionScope";
import type { ChatCodexApprovalRequest } from "./codexApprovals";
import type { ChatParticipantRequestApprovalRequest } from "./memberRequests";
import type { ChatAgentMode, ChatAppToolCapability, ChatShellPermissionRule } from "./members";
import type {
  ChatParticipantChangeRequest, ChatParticipantRemovalRequest, ChatRoleChangeRequest, ChatRoleParticipantChangeRequest,
  ChatRosterChangeRequest
} from "./rosterChanges";

export type ChatMentionApprovalStatus = "pending" | "approved" | "rejected";

export interface ChatPendingMention {
  targetParticipantId: string;
  targetHandle: string;
  status: ChatMentionApprovalStatus;
  approvedAt?: string;
  rejectedAt?: string;
}

export type ChatChoiceStatus = "pending" | "selected" | "cancelled";

export interface ChatChoiceOption {
  id: string;
  label: string;
  description?: string;
}

export interface ChatPendingChoice {
  id: string;
  title: string;
  question: string;
  options: ChatChoiceOption[];
  recommendedOptionId?: string;
  status: ChatChoiceStatus;
  selectedOptionId?: string;
  customAnswer?: string;
  note?: string;
  selectedAt?: string;
  cancelledAt?: string;
  /** When the member asked it (the end of the reply that carries it). */
  askedAt?: string;
  /** Closed by the app, not by the User: as soon as a message of hers,
   *  written after it, started a turn of its member (she went on instead of
   *  choosing; the User, 2026-11-15). Its status is `cancelled`, so it is
   *  closed everywhere a cancelled choice is; it is shown as expired. */
  expiredAt?: string;
  /** Closed by the app because its member is no longer in the chat (removed,
   *  or replaced by a member of the same name): nobody is there to take an
   *  answer. Shown as expired; never refused by the server for an answer
   *  given before (the answer has nobody to go to either). */
  memberGoneAt?: string;
  /** The durable answer which saved this selection, before native admission. */
  decisionEventId?: string;
  responseMessageId?: string;
  responseRunId?: string;
  /** The last few answers this choice was given and refused, oldest first,
   *  each by the operation it was sent under. Shown to the devices that sent
   *  them only while the choice still waits. */
  refusals?: Array<{ operationId: string; reason: string; at: string }>;
}

export type ChatPermissionGrant = "workspaceWrite" | "webAccess" | "repoRead";

export interface ChatPortablePermissionChangeRequest {
  kind: "portable";
  reason?: string;
  permissions: ChatPermissionGrant[];
}

export interface ChatShellRulesPermissionChangeRequest {
  kind: "shellRules";
  reason?: string;
  rules: ChatShellPermissionRule[];
}

export interface ChatProviderNativePermissionChangeRequest {
  kind: "providerNative";
  reason?: string;
  provider: "claude-code";
  allowedTools: string[];
}

export interface ChatGitHubAppPermissionChangeRequest {
  kind: "githubApp";
  reason?: string;
  repository_full_name: string;
  permissions: string[];
}

export type ChatPermissionChangeRequest =
  | ChatPortablePermissionChangeRequest
  | ChatShellRulesPermissionChangeRequest
  | ChatProviderNativePermissionChangeRequest
  | ChatGitHubAppPermissionChangeRequest;

export interface ChatToolPermissionRequest {
  kind: "toolPermission";
  agentMode?: ChatAgentMode;
  nativeOccurrenceId?: string;
  reason?: string;
  toolName: string;
  toolInput?: unknown;
  /** What "for this chat" covers, as Claude Code scopes its "don't ask
   *  again" (src/shared/toolPermissionScope.ts): set when the card is
   *  raised. A scoped tool's card without one offers no "for this chat". */
  chatScope?: ChatToolPermissionScope;
  /** Claude Code's ExitPlanMode: its own plan approval ("Ready to code?",
   *  src/shared/claudePlanApproval.ts) instead of a tool permission card. */
  planApproval?: ChatClaudePlanApproval;
}

/** What Claude Code's plan approval shows and offers. Only a pending card
 *  holds the plan: it is dropped once the User answered. */
export interface ChatClaudePlanApproval {
  /** The plan as Claude wrote it (empty: the CLI's "No plan found"). */
  plan?: string;
  planFilePath?: string;
  /** The account has Claude Code's auto mode, as far as the app knows it
   *  (the member's CLI ran in auto): "Yes, and use auto mode" in place of
   *  "Yes, auto-accept edits", as the CLI offers. */
  autoModeAvailable?: boolean;
  /** Too large to show (over the CLI's 200,000 characters): only "No, keep
   *  planning" is offered, as in the CLI. */
  withheld?: boolean;
}

/** The User's pick on Claude Code's plan approval: the CLI's own value for
 *  the row, and her words for "No, keep planning". */
export interface ChatClaudePlanDecision {
  optionId: string;
  feedback?: string;
}

/** A member asks the User to sign in to (or reconnect) an MCP server its task
 *  needs (src/shared/connectorSignIn.ts). The sign-in address comes from the
 *  member's CLI, never from the member. Answering it approves "Done" (the app
 *  reconnects the server) or declines "Not now". */
export interface ChatConnectorSignInRequest {
  kind: "connectorSignIn";
  /** The server's name as the CLI lists it, e.g. "claude.ai Sentry". */
  connector: string;
  /** sign-in: the CLI needs the User to authenticate; reconnect: the server
   *  failed to connect, and the User fixes it, then reconnects. */
  action: "sign-in" | "reconnect";
  authUrl?: string;
  /** The server's own sign-in, whose browser return the member's CLI takes on
   *  the computer it runs on: it can finish only in a browser there. */
  callbackOnMemberComputer?: boolean;
  reason?: string;
}

export type ChatAppToolApprovalStatus = "pending" | "approved" | "denied" | "cancelled" | "expired" | "auto-applied";

export type ChatAppToolApprovalScope = "once" | "chat";

export type ChatPermissionRequestToolStatus =
  | "pending_user_approval"
  | "approved"
  | "denied"
  | "already_granted"
  | "not_found";

export interface ChatPermissionRequestToolResult {
  ok: boolean;
  status: ChatPermissionRequestToolStatus;
  requestId?: string;
  approvalId?: string;
  summary?: string;
  request?: ChatPermissionChangeRequest;
  approvalScope?: ChatAppToolApprovalScope;
  updatedAt?: string;
  error?: string;
}

export type ChatAppToolApprovalRequest =
  | ChatScriptChangeRequest
  | ChatRosterChangeRequest
  | ChatRoleChangeRequest
  | ChatParticipantChangeRequest
  | ChatParticipantRemovalRequest
  | ChatRoleParticipantChangeRequest
  | ChatPermissionChangeRequest
  | ChatToolPermissionRequest
  | ChatConnectorSignInRequest
  | ChatParticipantRequestApprovalRequest
  | ChatSelfCompactionRequest
  | ChatCodexApprovalRequest;

export interface ChatSelfCompactionRequest {
  type: "self_compaction";
  instructions?: string;
  /** The member said its work is done: after the compaction it is not
   *  called again to go on, and what waits for it runs next. */
  workDone?: boolean;
  /** The member's context indicator (AgentContextUsage.percentage) when it
   *  asked: the card's meter, the same on the desktop and the phone. Set by
   *  the app, never taken from the member's arguments; absent when the
   *  indicator had no figure (the card then shows no meter). */
  contextPercentage?: number;
}

export interface ChatAppToolApproval {
  id: string;
  conversationId: string;
  requesterParticipantId: string;
  requesterHandle: string;
  requesterRoleConfigId: string;
  toolName: string;
  capability: ChatAppToolCapability;
  status: ChatAppToolApprovalStatus;
  request: ChatAppToolApprovalRequest;
  summary: string;
  createdAt: string;
  updatedAt: string;
  approvalScope?: ChatAppToolApprovalScope;
  appliedParticipantIds?: string[];
  resumeContext?: {
    runId: string;
    triggerMessageId: string;
    participantRequestBatchId?: string;
    remoteRun?: boolean;
  };
  consumedAt?: string;
  error?: string;
  /** A member removal decided (approved by the User, or auto-applied under
   *  the member's Manage members setting) and waiting for the chat's running
   *  turns to finish; cleared when the removal is applied or could not be.
   *  The asking member's own device applies it (Д2). */
  memberRemovalQueuedAt?: string;
  /** An approved (or auto-applied) addition requested by a member on a
   *  machine, waiting for the desktop, which owns the member list, to apply it. */
  memberAdditionQueuedAt?: string;
  /** A scheduled task a machine's member created without a card
   *  (ChatAgentPermissions.scheduleWithoutAsking): its card stands on the
   *  User's server, answered by that machine itself, until it is settled
   *  right after, so every device shows the task in the chat. */
  taskCreatedAt?: string;
  /** Desktop only: when the desktop applied (or could not apply) a machine
   *  member's roster change, so an older copy of the card from the machine
   *  does not bring the waiting state back. */
  rosterChangeSettledAt?: string;
  /** The desktop's view of a card a member on this machine raised on the
   *  User's server: the desktop shows it, and answers it there. */
  homeMachineId?: string;
  /** Answered on the User's server (from any device), not applied by the
   *  member's machine yet. */
  machineDecisionPending?: { decisionId: string; machineName: string; approve: boolean; at: string };
  machineDecisionReceiptId?: string;
  /** Desktop only: the User's answer to a machine member's roster change, as
   *  the User's server holds it (`server:<card>@<answered at>`); the desktop
   *  applies the change only for that answer. */
  machineAppliedDecisionId?: string;
  /** Answers its device could not apply (the last few), by the operation
   *  each was sent under: the card is asked again and says why. */
  cardRefusals?: ChatCardRefusal[];
  /** Claude Code's plan approval, answered: the row she picked. */
  planDecision?: ChatClaudePlanDecision;
}

export interface ChatAppToolApprovalPolicy {
  id: string;
  participantId: string;
  roleConfigId: string;
  toolName: string;
  capability: ChatAppToolCapability;
  targetParticipantId?: string;
  targetToolName?: string;
  /** For a tool permission rule: what of the tool it covers (a command
   *  prefix, a domain, a folder; ChatToolPermissionRequest.chatScope). A rule
   *  without one covers the whole tool. */
  targetToolScope?: ChatToolPermissionScope;
  scope: "chat";
  createdAt: string;
  updatedAt: string;
}

/** An answer a member's device could not apply, by the operation it was
 *  sent under on the User's server. */
export interface ChatCardRefusal {
  operationId: string;
  reason: string;
  at: string;
}

/** A card answered on the User's server for a member that runs elsewhere,
 *  while its device has not applied the answer yet. */
export interface ChatServerCardMark {
  cardId: string;
  state: "answered";
  answer: Record<string, unknown>;
  answeredAt: string;
  /** Where the member runs ("the machine" when unnamed). */
  machineName: string;
}

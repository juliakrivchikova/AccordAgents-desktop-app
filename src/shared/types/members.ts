import type { CloudRunRemoteExecutionMode, RemoteParticipantSessionHandle } from "./cloudRuns";
import type { ChatProviderKind, CliProviderHostVendor, ProviderKind } from "./providers";
import type { ChatBehaviorRuleSnapshot, ChatRoleParticipantDefaults, ChatRoleRuntime } from "./roles";

export type ChatAppToolCapability = "participants.manage" | "participants.request" | "compaction.request" | "permissions.request" | "scripts.request" | "participants.delegate" | "accord.start";

export interface ChatStaleRunRecovery {
  runId?: string;
  at: string;
}

export type AgentContextUsageSource = Extract<ProviderKind, "codex-cli" | "claude-code" | "gemini-cli">;

export interface AgentContextUsage {
  usedTokens: number;
  contextWindowTokens: number;
  percentage: number;
  source: AgentContextUsageSource;
  updatedAt: string;
  model?: string;
  /** The window is the one the CLI itself reported for the model (not the
   *  app's map): reading the session log again keeps it for that model. */
  windowFromCli?: true;
}

/** A member's mode. "full-access" is Codex's Full Access preset (its
 *  danger-full-access sandbox that never asks); only Codex has it, a member
 *  on another CLI runs Auto instead (chatAgentModeForKind). */
export type ChatAgentMode = "default" | "plan" | "auto" | "full-access";

export type ChatReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export type ChatParticipantRequestPermission = "ask" | "allow" | "deny";

export type ChatShellPermissionAction = "allow" | "ask" | "deny";

export type ChatShellPermissionMatch = "exact" | "prefix";

export interface ChatShellPermissionRule {
  action: ChatShellPermissionAction;
  pattern: string;
  match: ChatShellPermissionMatch;
}

export interface ChatAgentPermissions {
  repoRead: boolean;
  workspaceWrite: boolean;
  webAccess: boolean;
  requestParticipants: ChatParticipantRequestPermission;
  requestCompaction?: ChatParticipantRequestPermission;
  manageRolesParticipants?: ChatParticipantRequestPermission;
  /**
   * Creates scheduled tasks (`app_scripts_request_change` with op create)
   * without a card: the app installs and switches on what it proposes. Only
   * the User gives it (Settings → General → New chats), never a member's or
   * a machine's word. Absent: every task waits for her on a card. A task
   * that needs keys, and any change of a task, always does.
   */
  scheduleWithoutAsking?: true;
  shell: {
    enabled: boolean;
    rules: ChatShellPermissionRule[];
  };
  providerNative?: {
    "claude-code"?: {
      allowedTools: string[];
    };
  };
  /**
   * The member's CLI runs in its own permission mode (the sessions view's
   * access picker, src/shared/chatAccessModes.ts): what the rights above do
   * not already allow, the CLI asks about as it does in its own terminal —
   * Claude Code and Codex through the app's approval cards; Antigravity's
   * print mode cannot ask, so agy refuses it. Without it (the classic
   * controls), the app refuses what is not granted.
   */
  cliApprovals?: true;
  /**
   * Codex's Plan mode (its collaboration mode, `/plan` or Shift+Tab in its
   * terminal) on top of its permissions preset; read only with
   * `cliApprovals`, and only for Codex: Claude Code's and Antigravity's Plan
   * is one of their permission modes (`agentMode: "plan"`).
   */
  codexPlanMode?: true;
}

export interface ChatParticipant {
  id: string;
  participantConfigId?: string;
  handle: string;
  roleConfigId: string;
  roleConfigVersion?: number;
  behaviorRuleIds?: string[];
  kind: ChatProviderKind;
  model?: string;
  reasoningEffort?: ChatReasoningEffort;
  avatarId?: string;
  /** Added provider this member runs through (see CliProviderHost); absent =
   *  the built-in CLI with its own sign-in. */
  hostId?: string;
  /** Display snapshot of the provider's name and vendor, refreshed when the
   *  provider is edited; kept on the member so old chats still read correctly
   *  and the vendor's model defaults resolve without a settings lookup. */
  hostLabel?: string;
  hostVendor?: CliProviderHostVendor;
  agentMode?: ChatAgentMode;
  permissions?: ChatAgentPermissions;
  remoteExecution?: CloudRunRemoteExecutionMode;
  /** Machine that hosts this participant's sessions (machines transport).
   *  Absent = this desktop unless a Cloud choice is awaiting preparation. */
  homeMachineId?: string;
  /** Cloud choice is saved before the machine is ready. */
  cloudRun?: import("../cloudRunPreparation").CloudRunSelection;
  /** The member's session, put on the User's server by the device it moved
   *  away from, for the device it runs on now to take before its next turn.
   *  Written only by the computer, like the other home fields. */
  sessionHandoff?: import("../memberSessionMove").ChatSessionHandoff;
  skipToolchainPreflight?: boolean;
  autoWatch?: boolean;
  /** In a chat with a main session, the member that added this one without
   *  a card (the main session delegating, or a member it made adding its
   *  own): its rights and mode never go above the main session's as they are
   *  at each turn (docs/main-session.md). Absent for members the User added
   *  or approved herself. Set once, when the member is added. */
  delegatedByParticipantId?: string;
  /** The short title the main session gave the task it made this member for
   *  (app_chat_delegate_task): its name in the sessions view
   *  (sessionsMemberTitle), kept with the member so it names it however much
   *  of the chat is loaded, on every device. Set once, when the member is
   *  added; a later task never renames it. */
  taskTitle?: string;
  /** The main session of a chat made by Fork to new chat (src/shared/
   *  forkToNewChat.ts): the member of another chat whose CLI session it
   *  starts from. Written once, by the computer, when the chat is made; the
   *  device the main session runs on copies that member's session (which it
   *  holds: a fork never crosses devices) at its first turn. */
  forkOrigin?: ChatParticipantForkOrigin;
}

/** Where a forked main session comes from: a member of another chat. */
export interface ChatParticipantForkOrigin {
  conversationId: string;
  participantId: string;
  /** Its handle and its chat's title when it was forked, for the note the
   *  main session is given and the chat's lines about its copy. */
  handle: string;
  conversationTitle: string;
  kind: ChatProviderKind;
  /** What the User saw when she tapped Fork: the member's last reply that
   *  ended a turn of its CLI (lastMemberTurnEnd). The copy ends with that
   *  turn (the User, 2026-11-21: "When you tap Fork"). Absent when it had
   *  none. */
  seen?: ChatForkSeenReply;
}

/** A member's reply that ended a turn, as Fork to new chat cuts the copy at
 *  it (forkSeenReplyOf): the same fields on the computer and the phone. */
export interface ChatForkSeenReply {
  messageId: string;
  /** Where its CLI session stood when that turn ended, as the device that
   *  ran it recorded (ChatMessageMetadata.sessionCut). */
  sessionCut?: ChatMessageSessionCut;
  /** When the reply finished, on the clock of the device that ran its turn
   *  (its turn's start plus workedMs): a reply from before sessionCut is
   *  matched to its session by time. */
  finishedAt?: string;
}

/** Where a member's CLI session stood when one of its turns ended. */
export interface ChatMessageSessionCut {
  sessionId: string;
  /** Claude Code: the uuid of the turn's last assistant message (what
   *  `--resume-session-at` takes); Codex: the turn's id (thread/fork
   *  `lastTurnId`). */
  at: string;
}

/** Where a fork's copy ends (a forked main session's first turn), as the
 *  device that holds the source session reads it (forkCutFor). */
export interface ChatSessionForkCut {
  /** The CLI's own point: the copy ends there. */
  at?: string;
  /** The session that point is in, when it is not the member's session now
   *  (its session changed after the reply): that one is copied, when it is
   *  still on this device. */
  sessionId?: string;
  /** The reply's finish on the clock of the device that ran it: the copy ends
   *  with the last turn that finished by then. */
  finishedBy?: string;
  /** Why no point can be named: the whole session is copied and the chat
   *  says so. */
  unknown?: string;
}

export interface ChatSessionForkSource {
  participantId: string;
  sessionId: string;
  kind: ChatProviderKind;
  /** The chat the source member is in, when it is not this one (Fork to new
   *  chat): the copy becomes this chat's main session. */
  conversationId?: string;
  /** Fork to new chat: where the copy ends (what the User saw when she
   *  tapped Fork). A delegated fork has none: it copies the session as it
   *  is. */
  cut?: ChatSessionForkCut;
}

export interface ChatParticipantSession {
  participantId: string;
  sessionId: string;
  /** The member was made as a fork of another member's session (the main
   *  session delegating with start "fork"): its first turn starts from a copy
   *  of that session instead of an empty one, through the CLI's own fork
   *  (Claude --resume <id> --fork-session, Codex thread/fork). Cleared once
   *  the fork has its own sessionId. */
  forkFrom?: ChatSessionForkSource;
  /** The member whose session this one was forked from. Kept after the fork
   *  has its own id: both CLIs keep the source's system and developer
   *  instructions in a fork, so its first turn tells the member who it is. */
  forkedFromParticipantId?: string;
  executionSessionId?: string;
  roleConfigId: string;
  roleConfigVersion: number;
  roleAppToolCapabilities?: ChatAppToolCapability[];
  roleParticipantDefaults?: ChatRoleParticipantDefaults;
  roleRuntime?: ChatRoleRuntime;
  participantKind?: ChatProviderKind;
  participantModel?: string;
  participantReasoningEffort?: ChatReasoningEffort;
  participantBehaviorRules?: ChatBehaviorRuleSnapshot[];
  participantAgentMode?: ChatAgentMode;
  participantPermissions?: ChatAgentPermissions;
  runtimeConfigVersion?: number;
  appMcpClientGeneration?: number;
  roleLabel: string;
  roleInstructions: string;
  lastSyncedMessageId?: string;
  remoteSession?: RemoteParticipantSessionHandle;
  invalidatedRemoteSessionId?: string;
  invalidatedRemoteSessionAt?: string;
  /** The handoff (its body's hash) this session was taken from, so it is
   *  taken once on this device; see ChatParticipant.sessionHandoff. */
  importedHandoff?: string;
  /** Device-local: it moved here with this session, and its next turn tells
   *  it so (memberMovedNote); cleared once a turn of it succeeded. */
  movedHere?: { from: string; to: string; at: string };
  /** A hash of the member's access (repository, mode, permissions, what an
   *  @handle does) as its CLI session was last told it, in its instructions
   *  or a note: the CLI keeps the instructions a session started with, so a
   *  turn whose access differs says the change once. Absent for a session
   *  told nothing yet; "restate" after its conversation was compacted (the
   *  CLI rebuilt its instructions from the text its process was launched
   *  with, which may be older): its next turn says its access again. */
  instructionsAccessHash?: string;
  updatedAt: string;
}

export interface ChatParticipantInput {
  participantConfigId?: string;
  handle: string;
  roleConfigId: string;
  behaviorRuleIds?: string[];
  kind: ChatProviderKind;
  model?: string;
  reasoningEffort?: ChatReasoningEffort;
  avatarId?: string;
  hostId?: string;
  agentMode?: ChatAgentMode;
  permissions?: ChatAgentPermissions;
  remoteExecution?: CloudRunRemoteExecutionMode;
  homeMachineId?: string;
  /** Cloud choice is saved before the machine is ready. */
  cloudRun?: import("../cloudRunPreparation").CloudRunSelection;
  skipToolchainPreflight?: boolean;
  autoWatch?: boolean;
}

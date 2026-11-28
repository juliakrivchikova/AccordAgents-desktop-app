import type { ChatSubagentProviders } from "./subagentProviders";
import type { ChatLastMessageByParticipant, ChatMessage, ChatPromptContextPointers } from "./messages";
import type { ChatProviderKind } from "./providers";
import type { Finding } from "./reviews";
import type { ChatViewMode } from "./settings";

export type ConversationKind = "general" | "code-review" | "implementation-plan" | "chat";

export interface ConversationSummary {
  id: string;
  title: string;
  kind: ConversationKind;
  createdAt: string;
  updatedAt: string;
  repoPath?: string;
  running?: boolean;
  /** A member's reply in the chat has not ended (`isPendingReply`), though
   *  this device may hold no run in it: a machine member's turn asked from
   *  the phone. The chat list shows it as work; unlike `running` it blocks
   *  nothing (a reply whose machine is gone may never end). */
  replyPending?: boolean;
  archived?: boolean;
  /** Pinned by the User (shared through her server, like the archive state):
   *  the chat list shows it under Pinned, in the order it was pinned. */
  pinned?: boolean;
  pinnedAt?: string;
  /** A member's choice card in the chat waits for the User's answer
   *  (`isWaitingChoice`): the chat list marks the chat with it. */
  waitingChoice?: boolean;
  chatParticipants?: ConversationSummaryChatParticipant[];
  /** The provider of the chat's main session (shared/mainSession.ts): the
   *  chat list shows its glyph before the title (the User, 2026-11-26,
   *  variant A). Absent for a chat without one (a classic chat with its
   *  Assistant). */
  mainSessionKind?: ChatProviderKind;
}

export interface ConversationSummaryChatParticipant {
  participantConfigId?: string;
  handle: string;
  kind: ChatProviderKind;
}

export interface ChatParticipantCompactionState {
  runId: string;
  startedAt: string;
}

export type ChatParticipantWatcherPausedReason = "wake-limit" | "error";

export interface ChatParticipantWatcherState {
  lastSeenMessageId?: string;
  lastRunId?: string;
  lastTriggeredAt?: string;
  wakeChainDepth: number;
  pausedReason?: ChatParticipantWatcherPausedReason;
  updatedAt: string;
}

/** A Claude Code member's guess at the User's next prompt, sent by its CLI
 *  after a reply (`--prompt-suggestions`) and offered in the chat composer as
 *  the dedicated CLI offers it in its input. Kept in memory per chat only. */
export interface ChatPromptSuggestion {
  participantId: string;
  text: string;
  createdAt: string;
}

export interface ChatPromptSuggestionsUpdate {
  conversationId: string;
  /** Newest first, at most one per member. */
  suggestions: ChatPromptSuggestion[];
}

export type ConversationMetadata = Record<string, unknown> & {
  /** The chat's main session (shared/mainSession.ts): the member every
   *  message without an addressee goes to. Set when the chat is made and
   *  never changed; a chat without it is an Assistant chat from before. */
  mainSessionParticipantId?: string;
  /** The chat's own changes to its Agents list (src/shared/subagentProviders.ts):
   *  a CLI taken out, or its own model and effort. Set empty when the chat is
   *  made; none, or none for a CLI, means every ready CLI on Settings' values. */
  subagentProviders?: ChatSubagentProviders;
  /** The chat's view, switched by the User any number of times and shared
   *  through her server like the pin. Read it through chatViewFor(). */
  chatView?: ChatViewMode;
  /** When the computer moved this sessions-view chat's members with rights
   *  from the classic view into their CLI's own mode as it opened the chat
   *  (ChatList.convertMembersForSessionsView), so that is done once and a
   *  later change is not undone. Shared through her server. */
  cliModesConvertedAt?: string;
  /** The same, as this computer recorded it: never shared, so a server on an
   *  older program that drops cliModesConvertedAt (and a full read from it)
   *  does not make the computer move the members again at its next start. */
  cliModesConvertedHereAt?: string;
  /** This device's own record of the Accords folded into the chat (a line
   *  her server took), worked out from the whole chat, not the loaded page:
   *  their cards are not pinned (accordProgress.ts). Never shared. */
  accordClosedLaunchIds?: string[];
  machineRepository?: { sourcePath: string; paths: Record<string, string> };
  activationProviderKind?: ChatProviderKind;
  activeRunParticipantIdsByRunId?: Record<string, string>;
  /** Runs that only wait for a member to come back from its own questions
   *  (chatRunState WAIT_ONLY_RUNS_KEY): no turn of its runs in them. */
  waitOnlyRunIds?: string[];
  lastMessageByParticipant?: ChatLastMessageByParticipant;
  participantCompactionsByParticipantId?: Record<string, ChatParticipantCompactionState>;
  participantSelfCompactionRequestedAtByParticipantId?: Record<string, string>;
  promptContextPointers?: ChatPromptContextPointers;
  participantWatchers?: Record<string, ChatParticipantWatcherState>;
};

export interface Conversation extends ConversationSummary {
  messages: ChatMessage[];
  findings: Finding[];
  finalSummary?: string;
  metadata: ConversationMetadata;
}

/** Where to open a member's turn that is in progress: the message itself,
 *  and the thread it is in when it is a thread reply. */
export interface ChatRunningMessageTarget {
  messageId: string;
  threadRootId?: string;
}

export interface ConversationMessagePageRequest {
  conversationId: string;
  beforeSequence?: number;
  /** The page strictly before this message; takes precedence over the other
   *  cursors. Used by readers that know message ids but not sequences. */
  beforeMessageId?: string;
  aroundMessageId?: string;
  limit?: number;
}

export interface ConversationMessagePageInfo {
  oldestSequence?: number;
  newestSequence?: number;
  hasMoreBefore: boolean;
  totalMessages: number;
}

export interface ConversationMessagePage extends ConversationMessagePageInfo {
  messages: ChatMessage[];
}

export interface ConversationOpenResult {
  conversation: Conversation;
  messagePage: ConversationMessagePageInfo;
}

/** How `conversations:updated` describes a large chat without resending every
 *  message. `messages` then holds only the messages that changed since the
 *  previous update plus the newest `tailCount` messages (the last `tailCount`
 *  entries, in conversation order); `removedIds` names messages that no longer
 *  exist. The receiver merges these into the messages it already holds. Absent
 *  on legacy and first-time updates, which carry the full message list. */
export interface ConversationMessageDelta {
  totalMessages: number;
  tailCount: number;
  removedIds: string[];
  /** Whether any member's reply in the whole chat has not ended yet
   *  (`isPendingReply`): the carried messages may not include it
   *  (`ConversationSummary.replyPending`). */
  replyPending?: boolean;
  /** Whether any member's choice card in the whole chat waits for the User
   *  (`isWaitingChoice`; `ConversationSummary.waitingChoice`). */
  waitingChoice?: boolean;
}

export interface ConversationUpdate extends Conversation {
  messageDelta?: ConversationMessageDelta;
}

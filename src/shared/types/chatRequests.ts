import type { ChatAppToolApprovalRequest, ChatAppToolApprovalScope, ChatClaudePlanDecision } from "./cards";
import type { CloudRunRemoteExecutionMode } from "./cloudRuns";
import type { ChatAgentMode, ChatAgentPermissions, ChatParticipantInput, ChatReasoningEffort } from "./members";
import type { ChatImageAttachment, ChatImageInput } from "./messages";
import type { RepoFileMention } from "./repositories";
import type { ChatViewMode } from "./settings";
import type { ChatSkillMention } from "./skills";

export interface CreateChatConversationRequest {
  runId?: string;
  title?: string;
  repoPath?: string;
  skipDefaultParticipants?: boolean;
  participants: ChatParticipantInput[];
  /** Fork to new chat (src/shared/forkToNewChat.ts): the chat is made with
   *  one main session, a copy of this member's CLI session, in its chat's
   *  project; the title, folder and members given are not used. */
  forkOf?: ChatForkToNewChatSource;
}

export interface ChatForkToNewChatSource {
  conversationId: string;
  participantId: string;
}

export interface AddChatParticipantRequest {
  conversationId: string;
  participant: ChatParticipantInput;
}

export interface UpdateChatParticipantRuntimeRequest {
  conversationId: string;
  participantId: string;
  model?: string;
  reasoningEffort?: ChatReasoningEffort;
  agentMode?: ChatAgentMode;
  permissions?: ChatAgentPermissions;
  remoteExecution?: CloudRunRemoteExecutionMode;
  homeMachineId?: string;
  /** Cloud choice is saved before the machine is ready. */
  cloudRun?: import("../cloudRunPreparation").CloudRunSelection;
  skipToolchainPreflight?: boolean;
  autoWatch?: boolean;
}

export interface RemoveChatParticipantRequest {
  conversationId: string;
  participantId: string;
}

export interface CompactChatParticipantRequest {
  conversationId: string;
  participantId?: string;
  handle?: string;
  instructions?: string;
  triggeredBy?: "user" | "agent";
  runId?: string;
  threadId?: string;
  parentMessageId?: string;
  chatThreadRootId?: string;
}

/** Restart a member's CLI process (the members list): its next turn starts a
 *  new process that resumes the same session with the settings of then. */
export interface RestartChatParticipantRequest {
  conversationId: string;
  participantId: string;
  runId?: string;
  /** The User agreed to stop the member's background tasks; without it a
   *  member that has some is not restarted. */
  stopBackgroundTasks?: boolean;
}

export interface RenameChatConversationRequest {
  conversationId: string;
  title: string;
}

export interface SetChatArchivedRequest {
  conversationId: string;
  archived: boolean;
  onlyIfEmpty?: boolean;
}

export interface SetChatViewRequest {
  conversationId: string;
  view: ChatViewMode;
}

/** A chat's view as saved (shared/mainSession.ts). */
export interface ChatViewState {
  conversationId: string;
  view: ChatViewMode;
}

export interface SetChatPinnedRequest {
  conversationId: string;
  pinned: boolean;
}

/** A chat's pin as saved: all the window needs back (the chat itself can be
 *  megabytes, and its list row updates from the chat's own update). */
export interface ChatPinState {
  conversationId: string;
  pinned: boolean;
  pinnedAt?: string;
}

export interface DeleteChatConversationRequest {
  conversationId: string;
}

export interface StartChatAccordRequest {
  conversationId: string;
  facilitatorParticipantId: string;
  targetParticipantIds: string[];
  subject: string;
}

export interface StartChatAccordResult {
  runId: string;
  sourceMessageId: string;
}

export interface DismissConversationWarningsRequest {
  conversationId: string;
  warnings: string[];
}

export interface SendChatMessageRequest {
  conversationId: string;
  runId?: string;
  mobileEventId?: string;
  content: string;
  skillMentions?: ChatSkillMention[];
  repoFileMentions?: RepoFileMention[];
  imageAttachments?: ChatImageInput[];
  threadId?: string;
  parentMessageId?: string;
  chatThreadRootId?: string;
  /** Exactly these members get the message (a member's session panel):
   *  the @handles in its text are not read for addressees, and there is no
   *  fallback to the main session or the last speaker. */
  targetParticipantIds?: string[];
}

export interface ToggleChatReactionRequest {
  conversationId: string;
  messageId: string;
  emoji: string;
}

/** Takes a turn-finished note away (its cross), on every device. */
export interface DismissTurnFinishedNoteRequest {
  conversationId: string;
  messageId: string;
}

/** Folds the pinned Accord card into a line at the end of the chat (its
 *  cross), on every device. */
export interface CloseAccordCardRequest {
  conversationId: string;
  launchMessageId: string;
  /** The document's name, for the line's words. */
  title?: string;
}

export interface ReadChatAttachmentRequest {
  conversationId: string;
  attachmentId: string;
}

export interface ReadChatAttachmentResult {
  attachment: ChatImageAttachment;
  dataBase64: string;
}

export interface ExportChatAttachmentRequest {
  attachmentId: string;
  targetPath: string;
  overwrite?: boolean;
}

export interface ExportChatAttachmentResult {
  attachment: Omit<ChatImageAttachment, "storageKey">;
  targetPath: string;
  sizeBytes: number;
  overwrite: boolean;
}

export interface RespondToChatMentionsRequest {
  conversationId: string;
  sourceMessageId: string;
  targetParticipantIds: string[];
  approve: boolean;
  continueRequester?: boolean;
  runId?: string;
}

export interface RespondToChatChoiceRequest {
  conversationId: string;
  sourceMessageId: string;
  choiceId: string;
  cancel?: boolean;
  selectedOptionId?: string;
  customAnswer?: string;
  note?: string;
  runId?: string;
}

export interface RespondToChatAppToolApprovalRequest {
  conversationId: string;
  approvalId: string;
  approve: boolean;
  scope?: ChatAppToolApprovalScope;
  draftOverride?: ChatAppToolApprovalRequest;
  codexDecisionId?: string;
  /** Claude Code's plan approval: the row she picked and her words. */
  planDecision?: ChatClaudePlanDecision;
}

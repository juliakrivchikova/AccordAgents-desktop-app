import type { ReactNode } from "react";
import type {
  AppSettings,
  ChatAppToolApprovalRequest,
  ChatClaudePlanDecision,
  ChatAppToolApprovalScope,
  ChatImageInput,
  ChatSkillMention,
  ChatViewState,
  Conversation,
  RepoFileMention,
  RepoFileExternalOpenAction,
  RepoFileOpenAction,
  ReviewProgress
} from "../../../shared/types";
import type { ParticipantCompactHandler } from "../content/participant-hover-card";
import type { ArtifactsState } from "../artifacts/use-artifacts";
import type { ChatChoiceResponse } from "./chat-message-item";
import type { ChatParticipantRosterStatus } from "./chat-participant-menu";
import type { ChatComposerPicks } from "./chat-composer";
import type { ChatMemberSendRequest } from "./chat-member-session-panel";

export interface ChatMessageFocusRequest {
  conversationId?: string;
  messageId: string;
  threadRootId?: string;
  approvalId?: string;
  nonce: number;
  pending?: boolean;
}

export interface ChatConversationViewProps {
  conversation: Conversation;
  topBar?: ReactNode;
  settings: AppSettings;
  progress: ReviewProgress[];
  isRunning: boolean;
  participantStatusById: ReadonlyMap<string, ChatParticipantRosterStatus>;
  hasOlderMessages: boolean;
  olderMessagesLoading: boolean;
  draft: string;
  /** The main composer's picks for the draft, kept per chat by the owner. */
  composerPicks?: ChatComposerPicks;
  onDraftChange: (value: string) => void;
  onLoadOlderMessages: () => void;
  onLoadMessagePageForMessage: (messageId: string) => Promise<boolean>;
  messageFocusRequest?: ChatMessageFocusRequest;
  artifacts: ArtifactsState;
  onSend: (
    repoFileMentions?: RepoFileMention[],
    imageAttachments?: ChatImageInput[],
    skillMentions?: ChatSkillMention[],
    content?: string,
    /** The sessions view: exactly these members (the main session). */
    targetParticipantIds?: string[]
  ) => Promise<boolean>;
  accordDisabledReason?: string;
  /** The sessions view of a chat with a main session has too few for an
   *  Accord (accordLaunch): the button opens the side panel's Agents list to
   *  add one instead of the Accord dialog. */
  accordNeedsAgent?: boolean;
  onOpenAccord?: () => void;
  onSendThread: (
    rootMessage: Conversation["messages"][number],
    content: string,
    repoFileMentions?: RepoFileMention[],
    imageAttachments?: ChatImageInput[],
    skillMentions?: ChatSkillMention[]
  ) => Promise<boolean>;
  /** A member's session panel (the sessions view): to that member only. */
  onSendToMember?: (request: ChatMemberSendRequest) => Promise<boolean>;
  /** The sessions view: a member's … actions (Restart, Fork to new chat,
   *  Remove from chat) for its session's header, and its controls (model,
   *  effort, permission mode, Codex's Plan mode, where it runs) for under
   *  its composer. */
  renderMemberSettings?: (participantId: string) => ReactNode;
  renderMemberChip?: (participantId: string) => ReactNode;
  /** The main session's … actions (Restart, Fork to new chat), shown in the
   *  chat title's menu in the sessions view. */
  mainSessionActions?: import("./chat-view-switch").MainSessionActions;
  /** The chat's view as her server saved it, and a switch that failed. */
  onChatViewSaved?: (saved: ChatViewState) => void;
  onChatViewError?: (message: string) => void;
  onApproveMentions: (sourceMessageId: string, targetParticipantIds: string[], continueRequester: boolean) => void;
  onRejectMentions: (sourceMessageId: string, targetParticipantIds: string[]) => void;
  onRespondToChoice: (sourceMessageId: string, choiceId: string, response: ChatChoiceResponse) => void | Promise<void>;
  onToggleReaction: (messageId: string, emoji: string) => void;
  /** Takes a turn-finished note away. */
  onDismissTurnFinishedNote?: (messageId: string) => void;
  onRespondToAppToolApproval: (
    approvalId: string,
    approve: boolean,
    scope?: ChatAppToolApprovalScope,
    draftOverride?: ChatAppToolApprovalRequest,
    codexDecisionId?: string,
    planDecision?: ChatClaudePlanDecision
  ) => Promise<void>;
  setRepoFileOpenPreference: (action: RepoFileOpenAction | null) => Promise<void>;
  setRepoFileExternalOpenPreference: (action: RepoFileExternalOpenAction | null) => Promise<void>;
  onCompactParticipant: ParticipantCompactHandler;
  onStopRun?: (runId: string) => void;
  /** Send now on a message waiting behind the running reply `runId` (the
   *  CLI's send-now), the one waiting as `waitingRunId`, or every one. */
  onSendNow?: (runId: string, waitingRunId?: string) => void;
  onJumpToParticipantLastMessage: (participantId: string) => void;
}

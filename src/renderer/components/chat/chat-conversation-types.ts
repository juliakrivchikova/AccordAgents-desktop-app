import type { ReactNode } from "react";
import type {
  AppSettings,
  ChatAppToolApprovalRequest,
  ChatAppToolApprovalScope,
  ChatImageInput,
  ChatSkillMention,
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
    content?: string
  ) => Promise<boolean>;
  accordDisabledReason?: string;
  onOpenAccord?: () => void;
  onSendThread: (
    rootMessage: Conversation["messages"][number],
    content: string,
    repoFileMentions?: RepoFileMention[],
    imageAttachments?: ChatImageInput[],
    skillMentions?: ChatSkillMention[]
  ) => Promise<boolean>;
  onApproveMentions: (sourceMessageId: string, targetParticipantIds: string[], continueRequester: boolean) => void;
  onRejectMentions: (sourceMessageId: string, targetParticipantIds: string[]) => void;
  onRespondToChoice: (sourceMessageId: string, choiceId: string, response: ChatChoiceResponse) => void | Promise<void>;
  onToggleReaction: (messageId: string, emoji: string) => void;
  onRespondToAppToolApproval: (
    approvalId: string,
    approve: boolean,
    scope?: ChatAppToolApprovalScope,
    draftOverride?: ChatAppToolApprovalRequest,
    codexDecisionId?: string
  ) => Promise<void>;
  setRepoFileOpenPreference: (action: RepoFileOpenAction | null) => Promise<void>;
  setRepoFileExternalOpenPreference: (action: RepoFileExternalOpenAction | null) => Promise<void>;
  onCompactParticipant: ParticipantCompactHandler;
  onStopRun?: (runId: string) => void;
  onJumpToParticipantLastMessage: (participantId: string) => void;
  /** Called after a click outside the focused (highlighted) message dismisses that highlight. */
  onDismissMessageFocus?: () => void;
}

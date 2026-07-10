import type {
  AppSettings,
  ChatAppToolApprovalRequest,
  ChatAppToolApprovalScope,
  ChatImageInput,
  ChatSkillMention,
  Conversation,
  RepoFileMention,
  RepoFileOpenAction,
  ReviewProgress
} from "../../../shared/types";
import type { ParticipantCompactHandler } from "../content/participant-hover-card";
import type { ChatChoiceResponse } from "./chat-message-item";
import type { ChatParticipantRosterStatus } from "./chat-participant-menu";

export interface ChatMessageFocusRequest {
  conversationId?: string;
  messageId: string;
  threadRootId?: string;
  nonce: number;
  pending?: boolean;
}

export interface ChatConversationViewProps {
  conversation: Conversation;
  settings: AppSettings;
  progress: ReviewProgress[];
  isRunning: boolean;
  participantStatusById: ReadonlyMap<string, ChatParticipantRosterStatus>;
  hasOlderMessages: boolean;
  olderMessagesLoading: boolean;
  draft: string;
  onDraftChange: (value: string) => void;
  onLoadOlderMessages: () => void;
  onLoadMessagePageForMessage: (messageId: string) => Promise<boolean>;
  messageFocusRequest?: ChatMessageFocusRequest;
  onSend: (repoFileMentions?: RepoFileMention[], imageAttachments?: ChatImageInput[], skillMentions?: ChatSkillMention[]) => Promise<boolean>;
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
    draftOverride?: ChatAppToolApprovalRequest
  ) => Promise<void>;
  setRepoFileOpenPreference: (action: RepoFileOpenAction | null) => Promise<void>;
  onCompactParticipant: ParticipantCompactHandler;
  onStopRun?: (runId: string) => void;
}

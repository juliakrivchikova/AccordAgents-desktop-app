import { X } from "lucide-react";

import type {
  AgentContextUsage,
  AgentRunProgress,
  AppSettings,
  ChatImageInput,
  ChatParticipant,
  ChatParticipantRequestBatch,
  ChatParticipantSession,
  ChatSkillMention,
  Conversation,
  RepoFileMention
} from "../../../shared/types";
import { Avatar } from "../avatar/avatar";
import { MentionDirectoryContext, type ParticipantCompactHandler } from "../content/participant-hover-card";
import { IconButton } from "../primitives";
import { avatarForChatParticipant } from "./chat-avatars";
import { ChatComposer } from "./chat-composer";
import {
  chatMentionDirectory,
  chatRoleLabel,
  contextUsageForMessage,
  sessionIdForMessage
} from "./chat-conversation-data";
import { ChatMessageItem, type ChatChoiceResponse } from "./chat-message-item";
import type { ChatParticipantRosterStatus } from "./chat-participant-menu";

export function ChatThreadPanel(props: {
  rootMessage: Conversation["messages"][number];
  replies: Conversation["messages"][number][];
  participants: ChatParticipant[];
  participantStatusById: ReadonlyMap<string, ChatParticipantRosterStatus>;
  conversationId?: string;
  repoPath?: string;
  contextUsageByParticipant: Map<string, AgentContextUsage>;
  sessionsByParticipant: Map<string, ChatParticipantSession>;
  settings: AppSettings;
  draft: string;
  busy: boolean;
  submittingChoiceIds?: ReadonlySet<string>;
  liveProgressById: Map<string, AgentRunProgress>;
  onDraftChange: (value: string) => void;
  onSend: (repoFileMentions?: RepoFileMention[], imageAttachments?: ChatImageInput[], skillMentions?: ChatSkillMention[]) => boolean | void | Promise<boolean | void>;
  onClose: () => void;
  onApproveMentions: (sourceMessageId: string, targetParticipantIds: string[], continueRequester: boolean) => void;
  onRejectMentions: (sourceMessageId: string, targetParticipantIds: string[]) => void;
  onRespondToChoice: (sourceMessageId: string, choiceId: string, response: ChatChoiceResponse) => void | Promise<void>;
  onToggleReaction: (messageId: string, emoji: string) => void;
  onCompactParticipant: ParticipantCompactHandler;
  onStopRun?: (runId: string) => void;
  continuedMentionRequestIds: Set<string>;
  inferredParticipantRequestsByTrigger: Map<string, ChatParticipantRequestBatch[]>;
}): JSX.Element {
  const mentionDirectory = chatMentionDirectory(props.participants, props.settings.chatRoleConfigs, props.sessionsByParticipant, props.contextUsageByParticipant);
  const replyLabel = `${props.replies.length} ${props.replies.length === 1 ? "reply" : "replies"}`;
  return (
    <MentionDirectoryContext.Provider value={mentionDirectory}>
    <section className="chat-thread-panel" aria-label="Chat thread" data-testid="chat-thread-panel">
      <header className="thread-panel-head chat-thread-head">
        <div>
          <h2>Thread</h2>
          <span>{replyLabel}</span>
        </div>
        <div className="thread-panel-actions">
          <IconButton size="sm" icon={X} label="Close thread" tooltip="Close thread" onClick={props.onClose} />
        </div>
      </header>
      <div className="chat-thread-body">
        <ChatMessageItem
          message={props.rootMessage}
          conversationId={props.conversationId ?? ""}
          participants={props.participants}
          participantStatusById={props.participantStatusById}
          contextUsage={contextUsageForMessage(props.rootMessage, props.contextUsageByParticipant)}
          sessionId={sessionIdForMessage(props.rootMessage, props.sessionsByParticipant)}
          busy={props.busy}
          submittingChoiceIds={props.submittingChoiceIds}
          inThread
          hasContinuationReply={props.continuedMentionRequestIds.has(props.rootMessage.id)}
          inferredParticipantRequests={props.inferredParticipantRequestsByTrigger.get(props.rootMessage.id)}
          liveProgress={props.liveProgressById.get(props.rootMessage.id)}
          onApproveMentions={props.onApproveMentions}
          onRejectMentions={props.onRejectMentions}
          onRespondToChoice={props.onRespondToChoice}
          onToggleReaction={props.onToggleReaction}
          onCompactParticipant={props.onCompactParticipant}
          onStopRun={props.onStopRun}
        />
        {props.replies.length > 0 && (
          <div className="chat-thread-replies">
            <div className="chat-thread-divider">
              <span>{replyLabel}</span>
            </div>
            {props.replies.map((message) => (
              <ChatMessageItem
                message={message}
                conversationId={props.conversationId ?? ""}
                participants={props.participants}
                participantStatusById={props.participantStatusById}
                contextUsage={contextUsageForMessage(message, props.contextUsageByParticipant)}
                sessionId={sessionIdForMessage(message, props.sessionsByParticipant)}
                busy={props.busy}
                submittingChoiceIds={props.submittingChoiceIds}
                inThread
                hasContinuationReply={props.continuedMentionRequestIds.has(message.id)}
                inferredParticipantRequests={props.inferredParticipantRequestsByTrigger.get(message.id)}
                liveProgress={props.liveProgressById.get(message.id)}
                onApproveMentions={props.onApproveMentions}
                onRejectMentions={props.onRejectMentions}
                onRespondToChoice={props.onRespondToChoice}
                onToggleReaction={props.onToggleReaction}
                onCompactParticipant={props.onCompactParticipant}
                onStopRun={props.onStopRun}
                key={message.id}
              />
            ))}
          </div>
        )}
      </div>
      <ChatComposer
        className="chat-thread-composer"
        participants={props.participants}
        savedPrompts={props.settings.chatSavedPrompts}
        conversationId={props.conversationId}
        repoPath={props.repoPath}
        draft={props.draft}
        onDraftChange={props.onDraftChange}
        onSend={props.onSend}
        isRunning={props.busy}
        placeholder="Reply @name, /name, or #path..."
        testId="chat-thread-composer"
        renderParticipantAvatar={(participant) => <Avatar className="mini-avatar" spec={avatarForChatParticipant(participant)} />}
        participantRoleLabel={(participant) => chatRoleLabel(props.settings.chatRoleConfigs, participant)}
      />
    </section>
    </MentionDirectoryContext.Provider>
  );
}

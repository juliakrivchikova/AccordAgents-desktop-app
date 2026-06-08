import { X } from "lucide-react";

import type {
  AgentContextUsage,
  AgentRunProgress,
  AppSettings,
  ChatImageInput,
  ChatParticipant,
  ChatParticipantSession,
  ChatSkillMention,
  Conversation,
  RepoFileMention
} from "../../../shared/types";
import { Avatar } from "../avatar/avatar";
import { IconButton } from "../primitives";
import { authorForMessage } from "../conversation/conversation-display";
import { avatarForChatParticipant } from "./chat-avatars";
import { ChatComposer } from "./chat-composer";
import {
  chatRoleLabel,
  contextUsageForMessage,
  sessionIdForMessage
} from "./chat-conversation-data";
import { ChatMessageItem, type ChatChoiceResponse } from "./chat-message-item";

export function ChatThreadPanel(props: {
  rootMessage: Conversation["messages"][number];
  replies: Conversation["messages"][number][];
  participants: ChatParticipant[];
  conversationId?: string;
  repoPath?: string;
  contextUsageByParticipant: Map<string, AgentContextUsage>;
  sessionsByParticipant: Map<string, ChatParticipantSession>;
  settings: AppSettings;
  draft: string;
  busy: boolean;
  liveProgressById: Map<string, AgentRunProgress>;
  onDraftChange: (value: string) => void;
  onSend: (repoFileMentions?: RepoFileMention[], imageAttachments?: ChatImageInput[], skillMentions?: ChatSkillMention[]) => boolean | void | Promise<boolean | void>;
  onClose: () => void;
  onApproveMentions: (sourceMessageId: string, targetParticipantIds: string[], continueRequester: boolean) => void;
  onRejectMentions: (sourceMessageId: string, targetParticipantIds: string[]) => void;
  onRespondToChoice: (sourceMessageId: string, choiceId: string, response: ChatChoiceResponse) => void;
  onToggleReaction: (messageId: string, emoji: string) => void;
  onStopRun?: (runId: string) => void;
  continuedMentionRequestIds: Set<string>;
}): JSX.Element {
  const rootAuthor = authorForMessage(props.rootMessage, "chat");
  return (
    <section className="chat-thread-panel" aria-label="Chat thread" data-testid="chat-thread-panel">
      <header className="thread-panel-head chat-thread-head">
        <div>
          <h2>{rootAuthor}</h2>
          <span>{props.replies.length} {props.replies.length === 1 ? "reply" : "replies"}</span>
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
          contextUsage={contextUsageForMessage(props.rootMessage, props.contextUsageByParticipant)}
          sessionId={sessionIdForMessage(props.rootMessage, props.sessionsByParticipant)}
          busy={props.busy}
          inThread
          hasContinuationReply={props.continuedMentionRequestIds.has(props.rootMessage.id)}
          liveProgress={props.liveProgressById.get(props.rootMessage.id)}
          onApproveMentions={props.onApproveMentions}
          onRejectMentions={props.onRejectMentions}
          onRespondToChoice={props.onRespondToChoice}
          onToggleReaction={props.onToggleReaction}
          onStopRun={props.onStopRun}
        />
        {props.replies.length > 0 && (
          <div className="chat-thread-replies">
            <div className="chat-thread-divider">
              <span>{props.replies.length} {props.replies.length === 1 ? "reply" : "replies"}</span>
            </div>
            {props.replies.map((message) => (
              <ChatMessageItem
                message={message}
                conversationId={props.conversationId ?? ""}
                participants={props.participants}
                contextUsage={contextUsageForMessage(message, props.contextUsageByParticipant)}
                sessionId={sessionIdForMessage(message, props.sessionsByParticipant)}
                busy={props.busy}
                inThread
                hasContinuationReply={props.continuedMentionRequestIds.has(message.id)}
                liveProgress={props.liveProgressById.get(message.id)}
                onApproveMentions={props.onApproveMentions}
                onRejectMentions={props.onRejectMentions}
                onRespondToChoice={props.onRespondToChoice}
                onToggleReaction={props.onToggleReaction}
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
        conversationId={props.conversationId}
        repoPath={props.repoPath}
        draft={props.draft}
        onDraftChange={props.onDraftChange}
        onSend={props.onSend}
        isRunning={props.busy}
        placeholder="Reply with @name, /skill, or #path..."
        rows={3}
        maxHeight={180}
        testId="chat-thread-composer"
        renderParticipantAvatar={(participant) => <Avatar className="mini-avatar" spec={avatarForChatParticipant(participant)} />}
        participantRoleLabel={(participant) => chatRoleLabel(props.settings.chatRoleConfigs, participant)}
      />
    </section>
  );
}

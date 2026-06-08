import { useState } from "react";
import { CheckCircle2, Copy, FileText, ListChecks, MessageSquareReply, RefreshCw, SmilePlus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type {
  AgentContextUsage,
  AgentRunProgress,
  ChatParticipant,
  Conversation
} from "../../../shared/types";
import { CHAT_REACTION_EMOJIS } from "../../../shared/chatReactions";
import {
  chatDisplayContent,
  chatMessageImageAttachments,
  chatMessageRepoFileMentions,
  chatMessageSkillMentions,
  formatChatReplyDate,
  participantProviderLabel,
  participantRequestStatusLabel,
  providerLabel
} from "./chat-conversation-data";
import { formatChatTime } from "./chat-format";
import { ChatChoiceCard } from "./chat-choice-card";
import { ChatImageAttachmentStrip } from "./chat-image-attachments";
import { StreamingMessageContent } from "./chat-streaming";
import { AgentAvatarWithDetails, Avatar, avatarForMessage } from "../avatar/avatar";
import { MarkdownText } from "../content/markdown-text";
import { authorForMessage } from "../conversation/conversation-display";
import { IconButton, StatusBadge } from "../primitives";

export type ChatChoiceResponse = {
  selectedOptionId?: string;
  customAnswer?: string;
  note?: string;
};

export function ChatMessageItem(props: {
  message: Conversation["messages"][number];
  conversationId: string;
  participants?: ChatParticipant[];
  contextUsage?: AgentContextUsage;
  sessionId?: string;
  busy: boolean;
  submittingChoiceIds?: ReadonlySet<string>;
  selected?: boolean;
  inThread?: boolean;
  replyCount?: number;
  latestReplyAt?: string;
  hasContinuationReply?: boolean;
  liveProgress?: AgentRunProgress;
  onOpenThread?: () => void;
  onApproveMentions: (sourceMessageId: string, targetParticipantIds: string[], continueRequester: boolean) => void;
  onRejectMentions: (sourceMessageId: string, targetParticipantIds: string[]) => void;
  onRespondToChoice: (sourceMessageId: string, choiceId: string, response: ChatChoiceResponse) => void | Promise<void>;
  onToggleReaction: (messageId: string, emoji: string) => void;
  onStopRun?: (runId: string) => void;
}): JSX.Element {
  const { message } = props;
  const [copied, setCopied] = useState(false);
  const [reactionPickerOpen, setReactionPickerOpen] = useState(false);
  const author = authorForMessage(message, "chat");
  const isStreaming = message.status === "pending" && message.role === "participant";
  const streamedContent = props.liveProgress?.partialContent;
  const streamedActivity = props.liveProgress?.activity;
  const participant = message.participantId
    ? props.participants?.find((item) => item.id === message.participantId)
    : message.role === "system"
      ? props.participants?.find((item) => item.handle.toLowerCase() === "admin")
      : undefined;
  const pending = (message.metadata?.pendingMentions ?? []).filter((mention) => mention.status === "pending");
  const approved = (message.metadata?.pendingMentions ?? []).filter((mention) => mention.status === "approved");
  const choice = message.metadata?.pendingChoice;
  const participantRequest = message.metadata?.participantRequest;
  const skillMentions = chatMessageSkillMentions(message);
  const repoFileMentions = chatMessageRepoFileMentions(message);
  const imageAttachments = chatMessageImageAttachments(message);
  const allPendingIds = pending.map((mention) => mention.targetParticipantId);
  const displayContent = chatDisplayContent(message, author);
  const showThreadActions = !props.inThread && message.role !== "system" && Boolean(props.onOpenThread);
  const continuationRequested = Boolean(message.metadata?.requesterContinuationRequested);
  const canContinueRequester =
    message.role === "participant" &&
    continuationRequested &&
    approved.length > 0 &&
    pending.length === 0 &&
    !props.hasContinuationReply;
  const pendingMentionTargetLabel = pending.length === 1 ? `@${pending[0].targetHandle}` : `${pending.length} participants`;
  const approvePendingLabel = continuationRequested ? `Ask ${pendingMentionTargetLabel}, then return to ${author}` : "Approve mentions";
  const avatar = avatarForMessage(message, author, participant);
  const replyCount = props.replyCount ?? 0;
  const canCopy = Boolean(displayContent.trim());
  const canReact = message.status !== "pending";
  const reactionEntries = CHAT_REACTION_EMOJIS
    .map((emoji) => ({
      emoji,
      reactors: message.metadata?.reactions?.[emoji] ?? []
    }))
    .filter((entry) => entry.reactors.length > 0);

  async function copyMessage(): Promise<void> {
    if (!canCopy) {
      return;
    }
    await navigator.clipboard.writeText(displayContent);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  const threadActions = showThreadActions && replyCount > 0 ? (
    <button type="button" className="chat-thread-pill" onClick={props.onOpenThread}>
      <span>{replyCount} {replyCount === 1 ? "reply" : "replies"}</span>
      {props.latestReplyAt && <small>· Last reply {formatChatReplyDate(props.latestReplyAt)}</small>}
    </button>
  ) : null;

  function toggleReaction(emoji: string): void {
    if (!canReact) {
      return;
    }
    setReactionPickerOpen(false);
    props.onToggleReaction(message.id, emoji);
  }

  return (
    <>
      <article data-message-id={message.id} className={`message chat-message ${choice ? "has-choice" : ""} ${message.role} ${props.selected ? "selected-thread-root" : ""} ${props.inThread ? "in-thread" : ""} ${isStreaming ? "is-running" : ""}`}>
        {message.role === "participant" ? (
          <AgentAvatarWithDetails
            className="message-avatar"
            spec={avatar}
            contextUsage={props.contextUsage}
            sessionId={props.sessionId}
          />
        ) : (
          <Avatar className="message-avatar" spec={avatar} />
        )}
        <div className="message-body">
          <div className="message-actions">
            {isStreaming && message.metadata?.runId && props.onStopRun && (
              <IconButton
                className="message-action message-action-stop"
                size="xs"
                icon={X}
                label="Stop response"
                tooltip="Stop response"
                onClick={() => props.onStopRun?.(message.metadata!.runId!)}
              />
            )}
            <IconButton
              className="message-action"
              size="xs"
              icon={copied ? CheckCircle2 : Copy}
              label={copied ? "Copied" : "Copy message"}
              tooltip={copied ? "Copied" : "Copy message"}
              disabled={!canCopy}
              onClick={() => void copyMessage()}
            />
            {canReact && (
              <Popover open={reactionPickerOpen} onOpenChange={setReactionPickerOpen}>
                <PopoverTrigger asChild>
                  <IconButton
                    className="message-action"
                    size="xs"
                    icon={SmilePlus}
                    label="Add reaction"
                    tooltip="Add reaction"
                  />
                </PopoverTrigger>
                <PopoverContent align="end" className="chat-reaction-popover">
                  <div className="chat-reaction-picker" aria-label="Choose reaction">
                    {CHAT_REACTION_EMOJIS.map((emoji) => (
                      <button type="button" className="chat-reaction-option" onClick={() => toggleReaction(emoji)} key={emoji}>
                        {emoji}
                      </button>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
            )}
            {showThreadActions && (
              <IconButton
                className="message-action"
                size="xs"
                icon={MessageSquareReply}
                label="Reply in thread"
                tooltip="Reply in thread"
                onClick={props.onOpenThread}
              />
            )}
          </div>
          <div className="message-meta">
            <strong>{author}</strong>
            {participant && message.role === "participant" && (
              <span className="message-provider">{participantProviderLabel(participant.kind)}</span>
            )}
            <span className="message-when">{formatChatTime(message.createdAt)}</span>
            {message.status === "error" && <StatusBadge tone="danger">error</StatusBadge>}
            {!props.inThread && message.metadata?.parentMessageId && message.role === "user" && (
              <StatusBadge tone="neutral">reply</StatusBadge>
            )}
          </div>
          <div className="message-content">
            {isStreaming ? (
              <StreamingMessageContent content={streamedContent} activity={streamedActivity} startedAt={message.createdAt} />
            ) : (
              <MarkdownText content={displayContent} />
            )}
          </div>
          {isStreaming && message.metadata?.queuedBehind && (
            <div className="chat-queued-badge">
              <span>Queued — waiting for @{message.metadata.queuedBehind.handle} to finish</span>
            </div>
          )}
          {repoFileMentions.length > 0 && (
            <div className="repo-file-reference-footer">
              <FileText size={14} />
              <span>Referenced: {repoFileMentions.map((mention) => mention.path).join(", ")}</span>
            </div>
          )}
          {skillMentions.length > 0 && (
            <div className="repo-file-reference-footer skill-reference-footer">
              <ListChecks size={14} />
              <span>Skills: {skillMentions.map((mention) => `${mention.displayName} (${mention.variants.map((variant) => providerLabel(variant.providerKind)).join(", ")})`).join(", ")}</span>
            </div>
          )}
          {imageAttachments.length > 0 && (
            <ChatImageAttachmentStrip conversationId={props.conversationId} attachments={imageAttachments} />
          )}
          {reactionEntries.length > 0 && (
            <div className="chat-message-reactions" aria-label="Message reactions">
              {reactionEntries.map((entry) => {
                const userReacted = entry.reactors.some((reactor) => reactor.actorKind === "user" && reactor.actorId === "user");
                const actorLabels = entry.reactors.map((reactor) => reactor.actorLabel).join(", ");
                return (
                  <button
                    type="button"
                    className={`chat-reaction-chip ${userReacted ? "selected" : ""}`}
                    title={actorLabels}
                    aria-label={`${entry.emoji} reaction by ${actorLabels}`}
                    onClick={() => toggleReaction(entry.emoji)}
                    key={entry.emoji}
                  >
                    <span>{entry.emoji}</span>
                    <strong>{entry.reactors.length}</strong>
                  </button>
                );
              })}
            </div>
          )}
          {participantRequest && (
            <div className="chat-approval-note">
              <span>{participantRequestStatusLabel(participantRequest)}</span>
              {participantRequest.source === "inferred" && <StatusBadge tone="neutral">inferred request</StatusBadge>}
            </div>
          )}
          {approved.length > 0 && (
            <div className="chat-approval-note">
              <span>Approved: {approved.map((mention) => `@${mention.targetHandle}`).join(", ")}</span>
              {canContinueRequester && (
                <Button variant="outline" size="sm" onClick={() => props.onApproveMentions(message.id, [], true)}>
                  <RefreshCw size={15} />
                  Continue {author}
                </Button>
              )}
            </div>
          )}
          {pending.length > 0 && (
            <div className="chat-approval-box">
              <strong>Pending mentions: {pending.map((mention) => `@${mention.targetHandle}`).join(", ")}</strong>
              <div className="chat-approval-actions">
                <Button variant="outline" size="sm" onClick={() => props.onApproveMentions(message.id, allPendingIds, continuationRequested)}>
                  <CheckCircle2 size={16} />
                  {approvePendingLabel}
                </Button>
                {continuationRequested && (
                  <Button variant="outline" size="sm" onClick={() => props.onApproveMentions(message.id, allPendingIds, false)}>
                    Approve mentions
                  </Button>
                )}
                <Button variant="outline" size="sm" onClick={() => props.onRejectMentions(message.id, allPendingIds)}>
                  Reject
                </Button>
                {pending.map((mention) => (
                  <Button
                    variant="outline" size="sm"
                    onClick={() => props.onApproveMentions(message.id, [mention.targetParticipantId], false)}
                    key={mention.targetParticipantId}
                  >
                    Ask @{mention.targetHandle}
                  </Button>
                ))}
              </div>
            </div>
          )}
          {!choice && threadActions}
        </div>
      </article>
      {choice && (
        <div className={`chat-choice-row ${props.inThread ? "in-thread" : ""}`}>
          <span aria-hidden="true" />
          <div className="chat-choice-row-body">
            <ChatChoiceCard
              choice={choice}
              requesterLabel={author}
              submitting={props.submittingChoiceIds?.has(choice.id) === true}
              onConfirm={(response) => props.onRespondToChoice(message.id, choice.id, response)}
            />
            {threadActions}
          </div>
        </div>
      )}
    </>
  );
}

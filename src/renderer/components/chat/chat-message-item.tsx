import { useState } from "react";
import { CheckCircle2, Copy, FileText, ListChecks, RefreshCw, Square } from "lucide-react";

import { Button } from "@/components/ui/button";
import type {
  AgentContextUsage,
  AgentRunProgress,
  ChatParticipant,
  Conversation
} from "../../../shared/types";
import {
  chatDisplayContent,
  chatMessageImageAttachments,
  chatMessageRepoFileMentions,
  chatMessageSkillMentions,
  formatChatReplyDate,
  participantRequestStatusLabel,
  providerLabel
} from "./chat-conversation-data";
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
  selected?: boolean;
  inThread?: boolean;
  replyCount?: number;
  latestReplyAt?: string;
  hasContinuationReply?: boolean;
  liveProgress?: AgentRunProgress;
  onOpenThread?: () => void;
  onApproveMentions: (sourceMessageId: string, targetParticipantIds: string[], continueRequester: boolean) => void;
  onRejectMentions: (sourceMessageId: string, targetParticipantIds: string[]) => void;
  onRespondToChoice: (sourceMessageId: string, choiceId: string, response: ChatChoiceResponse) => void;
  onStopRun?: (runId: string) => void;
}): JSX.Element {
  const { message } = props;
  const [copied, setCopied] = useState(false);
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

  async function copyMessage(): Promise<void> {
    if (!canCopy) {
      return;
    }
    await navigator.clipboard.writeText(displayContent);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  const threadActions = showThreadActions ? (
    <>
      {replyCount > 0 && (
        <Button variant="link" size="sm" onClick={props.onOpenThread}>
          <span>{replyCount} {replyCount === 1 ? "reply" : "replies"}</span>
          {props.latestReplyAt && <small>Last reply {formatChatReplyDate(props.latestReplyAt)}</small>}
        </Button>
      )}
      <Button variant="link" size="sm" onClick={props.onOpenThread}>
        Reply
      </Button>
    </>
  ) : null;

  return (
    <>
      <article className={`message chat-message ${choice ? "has-choice" : ""} ${message.role} ${props.selected ? "selected-thread-root" : ""} ${props.inThread ? "in-thread" : ""}`}>
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
          {isStreaming && message.metadata?.runId && props.onStopRun ? (
            <IconButton
              className="message-stop-button"
              size="xs"
              variant="outline"
              icon={Square}
              label="Stop response"
              tooltip="Stop response"
              onClick={() => props.onStopRun?.(message.metadata!.runId!)}
            />
          ) : (
            <IconButton
              className="message-copy-button"
              size="xs"
              icon={copied ? CheckCircle2 : Copy}
              label={copied ? "Copied" : "Copy message"}
              tooltip={copied ? "Copied" : "Copy message"}
              disabled={!canCopy}
              onClick={() => void copyMessage()}
            />
          )}
          <div className="message-meta">
            <strong>{author}</strong>
            <span>{new Date(message.createdAt).toLocaleString()}</span>
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
              busy={props.busy}
              onConfirm={(response) => props.onRespondToChoice(message.id, choice.id, response)}
            />
            {threadActions}
          </div>
        </div>
      )}
    </>
  );
}

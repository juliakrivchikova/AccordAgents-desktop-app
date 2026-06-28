import { useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Copy, FileText, ListChecks, RefreshCw, Reply, Smile, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { AgentContextUsage, AgentRunProgress, ChatParticipant, ChatParticipantRequestBatch, Conversation } from "../../../shared/types";
import { CHAT_REACTION_EMOJIS } from "../../../shared/chatReactions";
import { chatProcessingTranscriptView, chatProcessingTranscriptViewHasHidden } from "../../../shared/processingTranscript";
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
import { ChatExpandedProcessingTranscript, StreamingMessageContent } from "./chat-streaming";
import { ChatMessageReactionList } from "./chat-message-reactions";
import { chatReplyPreviewAvatars } from "./chat-reply-preview";
import { Avatar, avatarForMessage } from "../avatar/avatar";
import { MarkdownText } from "../content/markdown-text";
import { AgentAvatarWithDetails, type ParticipantCompactContext, type ParticipantCompactHandler } from "../content/participant-hover-card";
import { CHAT_ASSISTANT_ROLE_ID, authorForMessage, chatParticipantReference } from "../conversation/conversation-display";
import { IconButton, StatusBadge } from "../primitives";
import { RosterStatusIndicator, type ChatParticipantRosterStatus } from "./chat-participant-menu";
import { WorkedRow } from "./chat-worked-row";

const MESSAGE_ACTION_CLASS = "message-action size-[26px] min-h-[26px] rounded-[8px] border-0 bg-transparent shadow-none";
const MESSAGE_ACTION_STOP_CLASS = `${MESSAGE_ACTION_CLASS} message-action-stop`;

export type ChatChoiceResponse = {
  cancel?: boolean;
  selectedOptionId?: string;
  customAnswer?: string;
  note?: string;
};

export function ChatMessageItem(props: {
  message: Conversation["messages"][number];
  conversationId: string;
  participants?: ChatParticipant[];
  participantStatusById: ReadonlyMap<string, ChatParticipantRosterStatus>;
  contextUsage?: AgentContextUsage;
  sessionId?: string;
  busy: boolean;
  submittingChoiceIds?: ReadonlySet<string>;
  selected?: boolean;
  inThread?: boolean;
  replyCount?: number;
  replyPreviewMessages?: Conversation["messages"];
  latestReplyAt?: string;
  hasContinuationReply?: boolean;
  inferredParticipantRequests?: ChatParticipantRequestBatch[];
  liveProgress?: AgentRunProgress;
  onOpenThread?: () => void;
  onApproveMentions: (sourceMessageId: string, targetParticipantIds: string[], continueRequester: boolean) => void;
  onRejectMentions: (sourceMessageId: string, targetParticipantIds: string[]) => void;
  onRespondToChoice: (sourceMessageId: string, choiceId: string, response: ChatChoiceResponse) => void | Promise<void>;
  onToggleReaction: (messageId: string, emoji: string) => void;
  onCompactParticipant?: ParticipantCompactHandler;
  onStopRun?: (runId: string) => void;
}): JSX.Element {
  const { message } = props;
  const [copied, setCopied] = useState(false);
  const [reactionPickerOpen, setReactionPickerOpen] = useState(false);
  const [processingTranscriptOpen, setProcessingTranscriptOpen] = useState(false);
  const author = authorForMessage(message, "chat");
  const isStreaming = message.status === "pending" && message.role === "participant";
  const streamedContent = props.liveProgress?.partialContent;
  const streamedActivity = props.liveProgress?.activity;
  const streamedActivityEvents = props.liveProgress?.activityEvents ?? [];
  const participant = message.participantId
    ? props.participants?.find((item) => item.id === message.participantId)
    : message.role === "system"
      ? props.participants?.find((item) => item.roleConfigId === CHAT_ASSISTANT_ROLE_ID)
      : undefined;
  const pending = (message.metadata?.pendingMentions ?? []).filter((mention) => mention.status === "pending");
  const approved = (message.metadata?.pendingMentions ?? []).filter((mention) => mention.status === "approved");
  const choice = message.metadata?.pendingChoice;
  const participantRequest = message.metadata?.participantRequest;
  const participantRequests = [
    ...(participantRequest ? [participantRequest] : []),
    ...(props.inferredParticipantRequests ?? [])
  ];
  const skillMentions = chatMessageSkillMentions(message);
  const repoFileMentions = chatMessageRepoFileMentions(message);
  const imageAttachments = chatMessageImageAttachments(message);
  const allPendingIds = pending.map((mention) => mention.targetParticipantId);
  const rawDisplayContent = chatDisplayContent(message, author);
  const processingTranscript = message.metadata?.processingTranscript;
  const activityEvents = message.metadata?.activityEvents ?? [];
  const displayContent = rawDisplayContent;
  const processingTranscriptView = !isStreaming && processingTranscript ? chatProcessingTranscriptView(processingTranscript.content, displayContent, {
    retainedStart: processingTranscript.retainedStart,
    truncated: processingTranscript.truncated,
    omittedActivityEventCount: processingTranscript.omittedActivityEventCount
  }) : undefined;
  const queuedBehind = isStreaming ? message.metadata?.queuedBehind : undefined;
  const workedMs = typeof message.metadata?.workedMs === "number" && Number.isFinite(message.metadata.workedMs) && message.metadata.workedMs >= 0
    ? message.metadata.workedMs
    : undefined;
  const showWorkedRow = message.role === "participant" && message.status === "done" && workedMs != null && !isStreaming;
  const showThreadActions = !props.inThread && message.role !== "system" && Boolean(props.onOpenThread);
  const continuationRequested = Boolean(message.metadata?.requesterContinuationRequested);
  const canContinueRequester =
    message.role === "participant" &&
    continuationRequested &&
    approved.length > 0 &&
    pending.length === 0 &&
    !props.hasContinuationReply;
  const pendingMentionTargetLabel = pending.length === 1 ? chatParticipantReference(pending[0].targetHandle) : `${pending.length} participants`;
  const approvePendingLabel = continuationRequested
    ? `Ask ${pendingMentionTargetLabel}, then return to ${author}`
    : pending.length === 1
      ? `Ask ${pendingMentionTargetLabel}`
      : "Ask all mentioned participants";
  const pendingMentionList = pending.map((mention) => chatParticipantReference(mention.targetHandle)).join(", ");
  const mentionApprovalTitle = pending.length === 1
    ? `Do you want to ask ${pendingMentionTargetLabel}?`
    : `Do you want to ask ${pending.length} mentioned participants?`;
  const mentionApprovalDescription = continuationRequested
    ? `${author} will continue after ${pendingMentionTargetLabel} replies.`
    : `This message mentions ${pendingMentionList}.`;
  const avatar = avatarForMessage(message, author, participant);
  const replyCount = props.replyCount ?? 0;
  const replyPreviewAvatars = chatReplyPreviewAvatars(props.replyPreviewMessages, props.participants);
  const canCopy = Boolean(displayContent.trim());
  const canReact = message.status !== "pending";
  const compactContext: ParticipantCompactContext | undefined = props.inThread
    ? {
        threadId: message.metadata?.threadId ?? message.id,
        parentMessageId: message.id,
        chatThreadRootId: message.metadata?.chatThreadRootId ?? message.id
      }
    : undefined;
  const reactionEntries = CHAT_REACTION_EMOJIS
    .map((emoji) => ({
      emoji,
      reactors: message.metadata?.reactions?.[emoji] ?? []
    }))
    .filter((entry) => entry.reactors.length > 0);
  const hasProcessingTranscript = Boolean(processingTranscriptView && chatProcessingTranscriptViewHasHidden(processingTranscriptView, activityEvents));

  async function copyMessage(): Promise<void> {
    if (!canCopy) {
      return;
    }
    await navigator.clipboard.writeText(displayContent);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  const threadActions = showThreadActions && (replyCount > 0 || participantRequest) ? (
    <button type="button" className="chat-thread-pill" onClick={props.onOpenThread}>
      {replyPreviewAvatars.length > 0 && (
        <span className="chat-thread-avatars" aria-hidden="true">
          {replyPreviewAvatars.map((entry) => (
            <Avatar className="chat-thread-avatar" spec={entry.avatar} tooltip={null} key={entry.id} />
          ))}
        </span>
      )}
      <span className="chat-thread-count">
        {replyCount > 0 ? `${replyCount} ${replyCount === 1 ? "reply" : "replies"}` : "Open request thread"}
      </span>
      {props.latestReplyAt && <small>Last reply {formatChatReplyDate(props.latestReplyAt)}</small>}
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
            handle={participant?.handle}
            compactDisabled={props.busy}
            compactContext={compactContext}
            onCompactParticipant={props.onCompactParticipant}
          />
        ) : (
          <Avatar className="message-avatar" spec={avatar} />
        )}
        <div className="message-body">
          <div className="message-actions">
            {isStreaming && message.metadata?.runId && props.onStopRun && (
              <IconButton
                className={MESSAGE_ACTION_STOP_CLASS}
                size="xs"
                icon={X}
                label="Stop response"
                tooltip="Stop response"
                onClick={() => props.onStopRun?.(message.metadata!.runId!)}
              />
            )}
            {hasProcessingTranscript && (
              <IconButton
                className={MESSAGE_ACTION_CLASS}
                size="xs"
                icon={processingTranscriptOpen ? ChevronUp : ChevronDown}
                label={processingTranscriptOpen ? "Hide full stream" : "Show full stream"}
                tooltip={processingTranscriptOpen ? "Hide full stream" : "Show full stream"}
                pressed={processingTranscriptOpen}
                onClick={() => setProcessingTranscriptOpen((open) => !open)}
              />
            )}
            <IconButton
              className={MESSAGE_ACTION_CLASS}
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
                    className={MESSAGE_ACTION_CLASS}
                    size="xs"
                    icon={Smile}
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
                className={MESSAGE_ACTION_CLASS}
                size="xs"
                icon={Reply}
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
            {message.role === "participant" && (
              queuedBehind ? (
                <span className="chat-rt-status is-queued" title="Status: Queued">
                  <span className="chat-rt-status-dot" />
                  Queued
                </span>
              ) : (
                <RosterStatusIndicator status={isStreaming ? "running" : props.participantStatusById.get(message.participantId ?? "") ?? "idle"} />
              )
            )}
            <span className="message-when">{formatChatTime(message.createdAt)}</span>
            {!props.inThread && message.metadata?.parentMessageId && message.role === "user" && (
              <StatusBadge tone="neutral">reply</StatusBadge>
            )}
          </div>
          {showWorkedRow && <WorkedRow workedMs={workedMs} />}
          <div className="message-content">
            {isStreaming ? (
              <StreamingMessageContent
                content={streamedContent}
                activity={streamedActivity}
                activityEvents={streamedActivityEvents}
                startedAt={message.createdAt}
              />
            ) : (
              <>
                {hasProcessingTranscript && processingTranscriptOpen && processingTranscriptView ? (
                  <ChatExpandedProcessingTranscript view={processingTranscriptView} activityEvents={activityEvents} />
                ) : (
                  <MarkdownText content={displayContent} />
                )}
              </>
            )}
          </div>
          {queuedBehind && (
            <div className="chat-queued-badge">
              <span>Queued — waiting for @{queuedBehind.handle} to finish</span>
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
          <ChatMessageReactionList reactions={reactionEntries} onToggleReaction={toggleReaction} />
          {participantRequests.map((request) => (
            <div className={`chat-approval-note ${participantRequestNoteClass(request)}`} key={request.id}>
              {isNegativeParticipantRequestStatus(request.status) && <AlertTriangle size={14} aria-hidden />}
              <span>{participantRequestStatusLabel(request)}</span>
              {request.source === "inferred" && <StatusBadge tone="neutral">inferred request</StatusBadge>}
            </div>
          ))}
          {approved.length > 0 && (
            <div className="chat-approval-note">
              <span>Approved: {approved.map((mention) => chatParticipantReference(mention.targetHandle)).join(", ")}</span>
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
              <div className="chat-approval-title-block">
                <strong>{mentionApprovalTitle}</strong>
                <span>{mentionApprovalDescription}</span>
              </div>
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
                    Ask {chatParticipantReference(mention.targetHandle)}
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

function participantRequestNoteClass(request: ChatParticipantRequestBatch): string {
  return `is-${request.status.replace(/_/g, "-")}`;
}

function isNegativeParticipantRequestStatus(status: ChatParticipantRequestBatch["status"]): boolean {
  return status === "denied" || status === "failed";
}

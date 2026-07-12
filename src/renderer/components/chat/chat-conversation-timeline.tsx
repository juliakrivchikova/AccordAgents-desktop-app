import type { RefObject } from "react";
import type { VirtualItem, Virtualizer } from "@tanstack/react-virtual";

import type {
  AgentContextUsage,
  AgentRunProgress,
  AppSettings,
  ChatAppToolApproval,
  ChatAppToolApprovalRequest,
  ChatAppToolApprovalScope,
  ChatParticipant,
  ChatParticipantRequestBatch,
  ChatParticipantSession,
  Conversation
} from "../../../shared/types";
import { TimelineLoadMoreRow } from "../conversation/timeline-primitives";
import type { ParticipantCompactHandler } from "../content/participant-hover-card";
import { ChatAppToolApprovalList } from "./chat-app-tool-approvals";
import type { ChatTimelineRow } from "./chat-conversation-data";
import {
  contextUsageForMessage,
  sessionIdForMessage
} from "./chat-conversation-data";
import { ChatMessageItem, type ChatChoiceResponse } from "./chat-message-item";
import type { ChatParticipantRosterStatus } from "./chat-participant-menu";
import { ChatThinkingRowItem } from "./chat-streaming";

type ThreadSummaryMap = Map<string, { replies: Conversation["messages"]; latestReplyAt?: string }>;

export function ChatConversationTimeline(props: {
  conversationId: string;
  contextUsageByParticipant: Map<string, AgentContextUsage>;
  continuedMentionRequestIds: Set<string>;
  hasOlderMessages: boolean;
  inferredParticipantRequestsByTrigger: Map<string, ChatParticipantRequestBatch[]>;
  isRunning: boolean;
  liveProgressById: Map<string, AgentRunProgress>;
  olderMessagesLoading: boolean;
  onApproveMentions: (sourceMessageId: string, targetParticipantIds: string[], continueRequester: boolean) => void;
  onCompactParticipant: ParticipantCompactHandler;
  onLoadOlderMessages: () => void;
  onOpenThread: (messageId: string) => void;
  onRejectMentions: (sourceMessageId: string, targetParticipantIds: string[]) => void;
  onRespondToAppToolApproval: (
    approvalId: string,
    approve: boolean,
    scope?: ChatAppToolApprovalScope,
    draftOverride?: ChatAppToolApprovalRequest
  ) => Promise<void>;
  onRespondToChoice: (sourceMessageId: string, choiceId: string, response: ChatChoiceResponse) => void | Promise<void>;
  onScroll: () => void;
  onScrollIntent: () => void;
  onStopRun?: (runId: string) => void;
  onToggleReaction: (messageId: string, emoji: string) => void;
  participantStatusById: ReadonlyMap<string, ChatParticipantRosterStatus>;
  participants: ChatParticipant[];
  pendingApprovalRows: ChatAppToolApproval[];
  rows: ChatTimelineRow[];
  selectedThreadRootId?: string;
  sessionsByParticipant: Map<string, ChatParticipantSession>;
  settings: AppSettings;
  submittingApprovalIds: ReadonlySet<string>;
  submittingChoiceIds: ReadonlySet<string>;
  threadSummaries: ThreadSummaryMap;
  timelineRef: RefObject<HTMLDivElement>;
  virtualItems: VirtualItem[];
  virtualizer: Virtualizer<HTMLDivElement, Element>;
}): JSX.Element {
  return (
    <div
      className={`chat-timeline virtual-timeline ${props.pendingApprovalRows.length > 0 ? "has-approvals" : ""}`}
      ref={props.timelineRef}
      onKeyDown={(event) => {
        if (isScrollKey(event.key)) {
          props.onScrollIntent();
        }
      }}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          props.onScrollIntent();
        }
      }}
      onScroll={props.onScroll}
      onTouchMove={props.onScrollIntent}
      onWheel={props.onScrollIntent}
    >
      <div className="virtual-timeline-inner" style={{ height: `${props.virtualizer.getTotalSize()}px` }}>
        {props.virtualItems.map((virtualItem) => {
          const row = props.rows[virtualItem.index];
          if (!row) {
            return null;
          }
          return (
            <div
              className="virtual-timeline-item"
              data-index={virtualItem.index}
              key={virtualItem.key}
              ref={props.virtualizer.measureElement}
              style={{ transform: `translateY(${virtualItem.start}px)` }}
            >
              {row.type === "load-older" ? (
                <TimelineLoadMoreRow
                  loading={props.olderMessagesLoading}
                  disabled={!props.hasOlderMessages || props.olderMessagesLoading}
                  onClick={props.onLoadOlderMessages}
                />
              ) : row.type === "thinking" ? (
                <ChatThinkingRowItem row={row.row} />
              ) : row.type === "approval" ? (
                <ChatAppToolApprovalList
                  approvals={[row.approval]}
                  participants={props.participants}
                  savedParticipants={props.settings.chatParticipantConfigs}
                  roles={props.settings.chatRoleConfigs}
                  submittingIds={props.submittingApprovalIds}
                  onRespond={props.onRespondToAppToolApproval}
                />
              ) : (
                <ChatMessageItem
                  message={row.message}
                  conversationId={props.conversationId}
                  participants={props.participants}
                  participantStatusById={props.participantStatusById}
                  contextUsage={contextUsageForMessage(row.message, props.contextUsageByParticipant)}
                  sessionId={sessionIdForMessage(row.message, props.sessionsByParticipant)}
                  busy={props.isRunning}
                  submittingChoiceIds={props.submittingChoiceIds}
                  selected={row.message.id === props.selectedThreadRootId}
                  replyCount={props.threadSummaries.get(row.message.id)?.replies.length ?? 0}
                  replyPreviewMessages={props.threadSummaries.get(row.message.id)?.replies}
                  latestReplyAt={props.threadSummaries.get(row.message.id)?.latestReplyAt}
                  hasContinuationReply={props.continuedMentionRequestIds.has(row.message.id)}
                  inferredParticipantRequests={props.inferredParticipantRequestsByTrigger.get(row.message.id)}
                  liveProgress={props.liveProgressById.get(row.message.id)}
                  onOpenThread={props.onOpenThread}
                  onApproveMentions={props.onApproveMentions}
                  onRejectMentions={props.onRejectMentions}
                  onRespondToChoice={props.onRespondToChoice}
                  onToggleReaction={props.onToggleReaction}
                  onCompactParticipant={props.onCompactParticipant}
                  onStopRun={props.onStopRun}
                />
              )}
            </div>
          );
        })}
      </div>
      <div className={`chat-app-tool-approval-slot ${props.pendingApprovalRows.length > 0 ? "has-approvals" : ""}`}>
        {props.pendingApprovalRows.length > 0 && (
          <ChatAppToolApprovalList
            approvals={props.pendingApprovalRows}
            participants={props.participants}
            savedParticipants={props.settings.chatParticipantConfigs}
            roles={props.settings.chatRoleConfigs}
            submittingIds={props.submittingApprovalIds}
            onRespond={props.onRespondToAppToolApproval}
          />
        )}
      </div>
    </div>
  );
}

function isScrollKey(key: string): boolean {
  return key === "ArrowDown" ||
    key === "ArrowUp" ||
    key === "End" ||
    key === "Home" ||
    key === "PageDown" ||
    key === "PageUp" ||
    key === " ";
}

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";

import type {
  ChatAppToolApprovalRequest,
  ChatAppToolApprovalScope,
  ChatImageInput,
  ChatSkillMention,
  Conversation,
  RepoFileMention
} from "../../../shared/types";
import { Avatar } from "../avatar/avatar";
import { MessageLinkContext } from "../content/markdown-text";
import { MentionDirectoryContext } from "../content/participant-hover-card";
import { RepoFileLinkContext, RepoFileOpenChooser } from "../content/repo-file-link";
import { RunStatusLine } from "../conversation/timeline-primitives";
import { avatarForChatParticipant } from "./chat-avatars";
import { ChatComposer } from "./chat-composer";
import {
  chatAppToolApprovals,
  chatContinuedMentionRequestIds,
  chatContextUsageByParticipant,
  chatMentionDirectory,
  chatParticipants,
  chatRoleLabel,
  chatSessionsByParticipant,
  chatThinkingRows,
  chatThreadSummaryMap,
  chatTopLevelMessages,
  liveMessageProgressById
} from "./chat-conversation-data";
import { ChatConversationTimeline } from "./chat-conversation-timeline";
import type { ChatConversationViewProps, ChatMessageFocusRequest } from "./chat-conversation-types";
import { ChatThreadPanel } from "./chat-thread-panel";
import { useChatConversationViewport } from "./use-chat-conversation-viewport";
import { useChatRepoFileOpen } from "./use-chat-repo-file-open";
import { useSubmittingIdSet } from "./use-submitting-id-set";

export type { ChatMessageFocusRequest } from "./chat-conversation-types";

export function ChatConversationView(props: ChatConversationViewProps): JSX.Element {
  const participants = chatParticipants(props.conversation);
  const pendingAppToolApprovals = chatAppToolApprovals(props.conversation).filter((approval) => approval.status === "pending");
  const resolvedTimelineApprovals = useMemo(
    () =>
      chatAppToolApprovals(props.conversation).filter(
        (approval) =>
          approval.status !== "pending" &&
          (approval.toolName === "app_roles_request_change" || approval.toolName === "app_participants_request_change")
      ),
    [props.conversation.metadata]
  );
  const activeRunIdsForChat = useMemo(() => activeRunIdsForConversation(props.conversation), [
    props.conversation.metadata,
    props.conversation.messages
  ]);
  const topLevelMessages = useMemo(() => chatTopLevelMessages(props.conversation), [props.conversation.messages]);
  const threadSummaries = useMemo(() => chatThreadSummaryMap(props.conversation), [props.conversation.messages]);
  const continuedMentionRequestIds = useMemo(() => chatContinuedMentionRequestIds(props.conversation), [props.conversation.messages]);
  const contextUsageByParticipant = useMemo(() => chatContextUsageByParticipant(props.conversation), [props.conversation.metadata]);
  const sessionsByParticipant = useMemo(() => chatSessionsByParticipant(props.conversation), [props.conversation.metadata]);
  const mentionDirectory = useMemo(
    () => chatMentionDirectory(participants, props.settings.chatRoleConfigs, sessionsByParticipant, contextUsageByParticipant),
    [participants, props.settings.chatRoleConfigs, sessionsByParticipant, contextUsageByParticipant]
  );
  const [selectedThreadRootId, setSelectedThreadRootId] = useState<string | undefined>();
  const [threadDrafts, setThreadDrafts] = useState<Record<string, string>>({});
  const [threadWidth, setThreadWidth] = useState(430);
  const [isResizingThread, setIsResizingThread] = useState(false);
  const approvalSubmission = useSubmittingIdSet();
  const choiceSubmission = useSubmittingIdSet();
  const repoFileOpen = useChatRepoFileOpen({
    conversationId: props.conversation.id,
    repoFileOpenAction: props.settings.repoFileOpenAction,
    setRepoFileOpenPreference: props.setRepoFileOpenPreference
  });
  const latestProgress = props.progress[props.progress.length - 1];
  const latestComposerProgress = useMemo(() => latestNonMessageProgress(props.progress), [props.progress]);
  const hasPendingParticipantMessage = useMemo(
    () => props.conversation.messages.some((message) => message.status === "pending" && message.role === "participant"),
    [props.conversation.messages]
  );
  const thinkingRows = useMemo(() => chatThinkingRows(props.progress), [props.progress]);
  const liveProgressById = useMemo(() => liveMessageProgressById(props.progress), [props.progress]);
  const thinkingSignature = thinkingRows.map((row) => `${row.key}:${row.activity ?? ""}:${row.updatedAt}`).join("|");
  const latestMessage = topLevelMessages[topLevelMessages.length - 1];
  const selectedThreadRoot = selectedThreadRootId
    ? topLevelMessages.find((message) => message.id === selectedThreadRootId)
    : undefined;
  const selectedThreadSummary = selectedThreadRoot ? threadSummaries.get(selectedThreadRoot.id) : undefined;
  const hasThread = Boolean(selectedThreadRoot);
  const chatTimelineRows = useMemo(() => {
    const rows = [];
    if (props.hasOlderMessages || props.olderMessagesLoading) {
      rows.push({ type: "load-older" as const, id: "load-older" });
    }
    const entries = [
      ...topLevelMessages.map((message) => ({ createdAt: message.createdAt, row: { type: "message" as const, id: message.id, message } })),
      ...resolvedTimelineApprovals.map((approval) => ({ createdAt: approval.createdAt, row: { type: "approval" as const, id: approval.id, approval } }))
    ];
    entries.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    rows.push(...entries.map((entry) => entry.row));
    if (props.isRunning) {
      rows.push(...thinkingRows.map((row) => ({ type: "thinking" as const, id: row.key, row })));
    }
    return rows;
  }, [props.hasOlderMessages, props.isRunning, props.olderMessagesLoading, resolvedTimelineApprovals, thinkingRows, topLevelMessages]);
  const viewport = useChatConversationViewport({
    conversationId: props.conversation.id,
    messages: props.conversation.messages,
    topLevelMessages,
    threadSummaries,
    selectedThreadRootId,
    setSelectedThreadRootId,
    chatTimelineRows,
    hasOlderMessages: props.hasOlderMessages,
    olderMessagesLoading: props.olderMessagesLoading,
    draft: props.draft,
    isRunning: props.isRunning,
    pendingApprovalCount: pendingAppToolApprovals.length,
    latestMessage,
    latestProgress,
    thinkingSignature,
    messageFocusRequest: props.messageFocusRequest,
    onLoadOlderMessages: props.onLoadOlderMessages,
    onLoadMessagePageForMessage: props.onLoadMessagePageForMessage
  });

  async function sendDraft(repoFileMentions: RepoFileMention[] = [], imageAttachments: ChatImageInput[] = [], skillMentions: ChatSkillMention[] = []): Promise<boolean> {
    return props.onSend(repoFileMentions, imageAttachments, skillMentions);
  }

  async function sendThreadDraft(
    rootMessage: Conversation["messages"][number],
    repoFileMentions: RepoFileMention[] = [],
    imageAttachments: ChatImageInput[] = [],
    skillMentions: ChatSkillMention[] = []
  ): Promise<boolean> {
    const content = (threadDrafts[rootMessage.id] ?? "").trim();
    if (!content && imageAttachments.length === 0 && skillMentions.length === 0) {
      return false;
    }
    const sent = await props.onSendThread(rootMessage, content, repoFileMentions, imageAttachments, skillMentions);
    if (sent) {
      setThreadDrafts((current) => ({ ...current, [rootMessage.id]: "" }));
    }
    return sent;
  }

  function handleAppToolApproval(
    approvalId: string,
    approve: boolean,
    scope?: ChatAppToolApprovalScope,
    draftOverride?: ChatAppToolApprovalRequest
  ): Promise<void> {
    return approvalSubmission.runWithSubmittingId(
      approvalId,
      () => props.onRespondToAppToolApproval(approvalId, approve, scope, draftOverride)
    );
  }

  function handleChoiceResponse(sourceMessageId: string, choiceId: string, response: Parameters<ChatConversationViewProps["onRespondToChoice"]>[2]): Promise<void> {
    return choiceSubmission.runWithSubmittingId(choiceId, async () => {
      await props.onRespondToChoice(sourceMessageId, choiceId, response);
    });
  }

  function startThreadResize(event: ReactPointerEvent<HTMLDivElement>): void {
    const view = viewport.viewRef.current;
    if (!view) {
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsResizingThread(true);
    const rect = view.getBoundingClientRect();
    const minThread = 320;
    const maxThread = Math.max(minThread, Math.min(820, rect.width - 360));

    const move = (moveEvent: PointerEvent): void => {
      const nextWidth = Math.round(rect.right - moveEvent.clientX);
      setThreadWidth(Math.min(maxThread, Math.max(minThread, nextWidth)));
    };
    const stop = (): void => {
      setIsResizingThread(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  }

  useEffect(() => {
    setSelectedThreadRootId(undefined);
    setThreadDrafts({});
    approvalSubmission.resetSubmittingIds();
    choiceSubmission.resetSubmittingIds();
    repoFileOpen.resetRepoFileChooser();
  }, [
    props.conversation.id,
    approvalSubmission.resetSubmittingIds,
    choiceSubmission.resetSubmittingIds,
    repoFileOpen.resetRepoFileChooser
  ]);

  useEffect(() => {
    if (selectedThreadRootId && !topLevelMessages.some((message) => message.id === selectedThreadRootId)) {
      setSelectedThreadRootId(undefined);
    }
  }, [selectedThreadRootId, topLevelMessages]);

  return (
    <MentionDirectoryContext.Provider value={mentionDirectory}>
    <MessageLinkContext.Provider value={viewport.focusChatMessage}>
      <RepoFileLinkContext.Provider value={repoFileOpen.repoFileLinkContext}>
        <div
          className={`chat-view ${hasThread ? "thread-open" : ""} ${isResizingThread ? "resizing-thread" : ""}`}
          data-testid="chat-view"
          ref={viewport.viewRef}
          style={{ "--chat-thread-width": `${threadWidth}px` } as CSSProperties}
        >
          <div className="chat-main">
            <ChatConversationTimeline
              conversationId={props.conversation.id}
              contextUsageByParticipant={contextUsageByParticipant}
              continuedMentionRequestIds={continuedMentionRequestIds}
              hasOlderMessages={props.hasOlderMessages}
              isRunning={props.isRunning}
              liveProgressById={liveProgressById}
              olderMessagesLoading={props.olderMessagesLoading}
              onApproveMentions={props.onApproveMentions}
              onCompactParticipant={props.onCompactParticipant}
              onLoadOlderMessages={props.onLoadOlderMessages}
              onOpenThread={setSelectedThreadRootId}
              onRejectMentions={props.onRejectMentions}
              onRespondToAppToolApproval={handleAppToolApproval}
              onRespondToChoice={handleChoiceResponse}
              onScroll={viewport.updateStickToBottom}
              onStopRun={props.onStopRun}
              onToggleReaction={props.onToggleReaction}
              participantStatusById={props.participantStatusById}
              participants={participants}
              pendingApprovalRows={pendingAppToolApprovals}
              rows={chatTimelineRows}
              selectedThreadRootId={selectedThreadRoot?.id}
              sessionsByParticipant={sessionsByParticipant}
              settings={props.settings}
              submittingApprovalIds={approvalSubmission.submittingIds}
              submittingChoiceIds={choiceSubmission.submittingIds}
              threadSummaries={threadSummaries}
              timelineRef={viewport.timelineRef}
              virtualItems={viewport.chatVirtualItems}
              virtualizer={viewport.chatVirtualizer}
            />
            <ChatComposer
              participants={participants}
              conversationId={props.conversation.id}
              repoPath={props.conversation.repoPath}
              draft={props.draft}
              onDraftChange={props.onDraftChange}
              onSend={sendDraft}
              isRunning={props.isRunning}
              activeRunCount={activeRunIdsForChat.length}
              onStopAllRuns={props.onStopRun ? () => {
                for (const runId of activeRunIdsForChat) {
                  props.onStopRun?.(runId);
                }
              } : undefined}
              placeholder="Mention participants with @name, skills with /name, or repo files with #path"
              status={props.isRunning && !hasPendingParticipantMessage && latestComposerProgress ? <RunStatusLine progress={latestComposerProgress} /> : undefined}
              testId="chat-main-composer"
              renderParticipantAvatar={(participant) => <Avatar className="mini-avatar" spec={avatarForChatParticipant(participant)} />}
              participantRoleLabel={(participant) => chatRoleLabel(props.settings.chatRoleConfigs, participant)}
            />
          </div>
          {selectedThreadRoot && <div className="thread-resizer" role="separator" aria-orientation="vertical" onPointerDown={startThreadResize} />}
          {selectedThreadRoot && (
            <ChatThreadPanel
              rootMessage={selectedThreadRoot}
              replies={selectedThreadSummary?.replies ?? []}
              participants={participants}
              participantStatusById={props.participantStatusById}
              conversationId={props.conversation.id}
              repoPath={props.conversation.repoPath}
              contextUsageByParticipant={contextUsageByParticipant}
              sessionsByParticipant={sessionsByParticipant}
              settings={props.settings}
              draft={threadDrafts[selectedThreadRoot.id] ?? ""}
              busy={props.isRunning}
              submittingChoiceIds={choiceSubmission.submittingIds}
              liveProgressById={liveProgressById}
              onDraftChange={(value) => setThreadDrafts((current) => ({ ...current, [selectedThreadRoot.id]: value }))}
              onSend={(repoFileMentions, imageAttachments, skillMentions) => sendThreadDraft(selectedThreadRoot, repoFileMentions, imageAttachments, skillMentions)}
              onClose={() => setSelectedThreadRootId(undefined)}
              onApproveMentions={props.onApproveMentions}
              onRejectMentions={props.onRejectMentions}
              onRespondToChoice={handleChoiceResponse}
              onToggleReaction={props.onToggleReaction}
              onCompactParticipant={props.onCompactParticipant}
              onStopRun={props.onStopRun}
              continuedMentionRequestIds={continuedMentionRequestIds}
            />
          )}
          <RepoFileOpenChooser
            fileRef={repoFileOpen.chooserFileRef}
            open={repoFileOpen.chooserOpen}
            onChoose={(action) => void repoFileOpen.chooseRepoFileOpenAction(action)}
            onOpenChange={repoFileOpen.handleRepoFileChooserOpenChange}
          />
        </div>
      </RepoFileLinkContext.Provider>
    </MessageLinkContext.Provider>
    </MentionDirectoryContext.Provider>
  );
}

function activeRunIdsForConversation(conversation: Conversation): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const active = conversation.metadata?.activeRunIds;
  if (Array.isArray(active)) {
    for (const id of active) {
      if (typeof id === "string" && id && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  }
  for (const message of conversation.messages) {
    if (message.status === "pending" && message.role === "participant") {
      const id = message.metadata?.runId;
      if (typeof id === "string" && id && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  }
  return ids;
}

function latestNonMessageProgress(progress: ChatConversationViewProps["progress"]): ChatConversationViewProps["progress"][number] | undefined {
  for (let i = progress.length - 1; i >= 0; i -= 1) {
    const item = progress[i];
    if (!item.agentProgress || !item.agentProgress.messageId) {
      return item;
    }
  }
  return undefined;
}

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { ArrowDown } from "lucide-react";

import type {
  ChatAppToolApprovalRequest,
  ChatAppToolApprovalScope,
  ChatImageInput,
  ChatSkillMention,
  Conversation,
  RepoFileMention
} from "../../../shared/types";
import { activeRunSummaryForConversation } from "../../../shared/chatActiveRuns";
import { Avatar } from "../avatar/avatar";
import { LocalFileLinkContext, LocalFileOpenChooser } from "../content/local-file-link";
import { MessageLinkContext } from "../content/markdown-text";
import { MentionDirectoryContext } from "../content/participant-hover-card";
import { RunStatusLine } from "../conversation/timeline-primitives";
import { avatarForChatParticipant } from "./chat-avatars";
import { ChatComposer } from "./chat-composer";
import {
  chatAppToolApprovals,
  chatContinuedMentionRequestIds,
  chatContextUsageByParticipant,
  chatInferredParticipantRequestBatchesByTrigger,
  chatMentionDirectory,
  chatParticipants,
  chatRoleLabel,
  chatSessionsByParticipant,
  chatThinkingRows,
  chatThreadSummaryMap,
  chatTopLevelMessages,
  liveMessageProgressById
} from "./chat-conversation-data";
import { ArtifactsContext } from "../artifacts/artifacts-context";
import { ArtifactsPanel } from "../artifacts/artifacts-panel";
import { ChatConversationTimeline } from "./chat-conversation-timeline";
import type { ChatConversationViewProps } from "./chat-conversation-types";
import { ChatThreadPanel } from "./chat-thread-panel";
import { useChatConversationViewport } from "./use-chat-conversation-viewport";
import { useChatLocalFileOpen } from "./use-chat-local-file-open";
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
  const activeRunSummary = useMemo(() => activeRunSummaryForConversation(props.conversation), [
    props.conversation.metadata,
    props.conversation.messages
  ]);
  const participantsById = useMemo(() => new Map(participants.map((participant) => [participant.id, participant])), [participants]);
  const activeRunParticipantRows = useMemo(() => activeRunSummary.participantIds.flatMap((participantId) => {
    const participant = participantsById.get(participantId);
    const status = props.participantStatusById.get(participantId);
    const runIds = activeRunSummary.runIdsByParticipantId.get(participantId) ?? [];
    return participant && status && status !== "idle" && runIds.length > 0 ? [{ participant, runIds, status }] : [];
  }), [
    activeRunSummary,
    participantsById,
    props.participantStatusById
  ]);
  const topLevelMessages = useMemo(() => chatTopLevelMessages(props.conversation), [props.conversation.messages]);
  const threadSummaries = useMemo(() => chatThreadSummaryMap(props.conversation), [props.conversation.messages]);
  const inferredParticipantRequestsByTrigger = useMemo(() => chatInferredParticipantRequestBatchesByTrigger(props.conversation), [props.conversation.messages]);
  const continuedMentionRequestIds = useMemo(() => chatContinuedMentionRequestIds(props.conversation), [props.conversation.messages]);
  const contextUsageByParticipant = useMemo(() => chatContextUsageByParticipant(props.conversation), [props.conversation.metadata]);
  const sessionsByParticipant = useMemo(() => chatSessionsByParticipant(props.conversation), [props.conversation.metadata]);
  const mentionDirectory = useMemo(
    () => chatMentionDirectory(participants, props.settings.chatRoleConfigs, sessionsByParticipant, contextUsageByParticipant),
    [participants, props.settings.chatRoleConfigs, sessionsByParticipant, contextUsageByParticipant]
  );
  const artifacts = props.artifacts;
  const [selectedThreadRootId, setSelectedThreadRootId] = useState<string | undefined>();
  const [threadDrafts, setThreadDrafts] = useState<Record<string, string>>({});
  const [threadWidth, setThreadWidth] = useState(430);
  const [isResizingThread, setIsResizingThread] = useState(false);
  const approvalSubmission = useSubmittingIdSet();
  const choiceSubmission = useSubmittingIdSet();
  const localFileOpen = useChatLocalFileOpen({
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
  const thinkingSignature = thinkingRows.map((row) => `${row.key}:${row.activity ?? ""}:${row.activityEvents?.length ?? 0}:${row.updatedAt}`).join("|");
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

  async function sendDraft(
    repoFileMentions: RepoFileMention[] = [],
    imageAttachments: ChatImageInput[] = [],
    skillMentions: ChatSkillMention[] = [],
    content?: string
  ): Promise<boolean> {
    const sent = await props.onSend(repoFileMentions, imageAttachments, skillMentions, content);
    if (sent) {
      viewport.scrollToChatBottom();
    }
    return sent;
  }

  async function sendThreadDraft(
    rootMessage: Conversation["messages"][number],
    repoFileMentions: RepoFileMention[] = [],
    imageAttachments: ChatImageInput[] = [],
    skillMentions: ChatSkillMention[] = [],
    contentOverride?: string
  ): Promise<boolean> {
    const content = (contentOverride ?? threadDrafts[rootMessage.id] ?? "").trim();
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
    localFileOpen.resetLocalFileChooser();
  }, [
    props.conversation.id,
    approvalSubmission.resetSubmittingIds,
    choiceSubmission.resetSubmittingIds,
    localFileOpen.resetLocalFileChooser
  ]);

  useEffect(() => {
    if (selectedThreadRootId && !topLevelMessages.some((message) => message.id === selectedThreadRootId)) {
      setSelectedThreadRootId(undefined);
    }
  }, [selectedThreadRootId, topLevelMessages]);

  return (
    <MentionDirectoryContext.Provider value={mentionDirectory}>
    <MessageLinkContext.Provider value={viewport.focusChatMessage}>
      <ArtifactsContext.Provider value={artifacts.context}>
      <LocalFileLinkContext.Provider value={localFileOpen.localFileLinkContext}>
        <div
          className={`chat-view ${hasThread ? "thread-open" : ""} ${isResizingThread ? "resizing-thread" : ""}`}
          data-testid="chat-view"
          ref={viewport.viewRef}
          style={{ "--chat-thread-width": `${threadWidth}px` } as CSSProperties}
          onClick={(event) => {
            // Message links (event.preventDefault) move the highlight; everything else
            // clicked outside the highlighted message dismisses it.
            if (event.defaultPrevented) {
              return;
            }
            if (viewport.dismissMessageFocus(event.target)) {
              props.onDismissMessageFocus?.();
            }
          }}
        >
          <div className="chat-main">
            <ChatConversationTimeline
              conversationId={props.conversation.id}
              contextUsageByParticipant={contextUsageByParticipant}
              continuedMentionRequestIds={continuedMentionRequestIds}
              hasOlderMessages={props.hasOlderMessages}
              inferredParticipantRequestsByTrigger={inferredParticipantRequestsByTrigger}
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
              onScrollIntent={viewport.markUserScrollIntent}
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
            {!viewport.isStuckToBottom && topLevelMessages.length > 0 && (
              <button
                type="button"
                className="chat-jump-to-latest"
                aria-label="Jump to latest"
                title="Jump to latest"
                onClick={viewport.scrollToChatBottom}
              >
                <ArrowDown size={19} aria-hidden />
              </button>
            )}
            <ChatComposer
              participants={participants}
              savedPrompts={props.settings.chatSavedPrompts}
              conversationId={props.conversation.id}
              repoPath={props.conversation.repoPath}
              draft={props.draft}
              onDraftChange={props.onDraftChange}
              onSend={sendDraft}
              accordDisabledReason={props.accordDisabledReason}
              onOpenAccord={props.onOpenAccord}
              isRunning={props.isRunning}
              activeRunCount={activeRunSummary.runIds.length}
              activeRunParticipantRows={activeRunParticipantRows}
              onStopAllRuns={props.onStopRun ? () => {
                for (const runId of activeRunSummary.runIds) {
                  props.onStopRun?.(runId);
                }
              } : undefined}
              onStopParticipantRuns={props.onStopRun ? (runIds) => {
                for (const runId of runIds) {
                  props.onStopRun?.(runId);
                }
              } : undefined}
              placeholder="Message @name, /name, or #path..."
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
              onSend={(repoFileMentions, imageAttachments, skillMentions, content) =>
                sendThreadDraft(selectedThreadRoot, repoFileMentions, imageAttachments, skillMentions, content)}
              onClose={() => setSelectedThreadRootId(undefined)}
              onApproveMentions={props.onApproveMentions}
              onRejectMentions={props.onRejectMentions}
              onRespondToChoice={handleChoiceResponse}
              onToggleReaction={props.onToggleReaction}
              onCompactParticipant={props.onCompactParticipant}
              onStopRun={props.onStopRun}
              continuedMentionRequestIds={continuedMentionRequestIds}
              inferredParticipantRequestsByTrigger={inferredParticipantRequestsByTrigger}
            />
          )}
          {artifacts.panelOpen && (
            <ArtifactsPanel
              conversationId={props.conversation.id}
              artifacts={artifacts.artifacts}
              selectedId={artifacts.selectedId}
              onSelect={artifacts.selectArtifact}
              onClose={artifacts.closePanel}
            />
          )}
          <LocalFileOpenChooser
            fileRef={localFileOpen.chooserFileRef}
            open={localFileOpen.chooserOpen}
            onChoose={(action) => void localFileOpen.chooseLocalFileOpenAction(action)}
            onOpenChange={localFileOpen.handleLocalFileChooserOpenChange}
          />
        </div>
      </LocalFileLinkContext.Provider>
      </ArtifactsContext.Provider>
    </MessageLinkContext.Provider>
    </MentionDirectoryContext.Provider>
  );
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

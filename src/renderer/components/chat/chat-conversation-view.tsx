import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { toast } from "sonner";

import type {
  AppSettings,
  ChatAppToolApprovalScope,
  ChatImageInput,
  ChatSkillMention,
  Conversation,
  RepoFileMention,
  RepoFileOpenAction,
  ReviewProgress
} from "../../../shared/types";
import { Avatar } from "../avatar/avatar";
import { MessageLinkContext, focusRenderedMessage } from "../content/markdown-text";
import { RepoFileLinkContext, RepoFileOpenChooser, type FileLinkRef } from "../content/repo-file-link";
import { RunStatusLine, TimelineLoadMoreRow } from "../conversation/timeline-primitives";
import { avatarForChatParticipant } from "./chat-avatars";
import { ChatAppToolApprovalList } from "./chat-app-tool-approvals";
import { ChatComposer } from "./chat-composer";
import type { ChatTimelineRow } from "./chat-conversation-data";
import {
  chatAppToolApprovals,
  chatContinuedMentionRequestIds,
  chatContextUsageByParticipant,
  chatParticipants,
  chatRoleLabel,
  chatSessionsByParticipant,
  chatThinkingRows,
  chatThreadSummaryMap,
  chatTopLevelMessages,
  contextUsageForMessage,
  liveMessageProgressById,
  sessionIdForMessage
} from "./chat-conversation-data";
import { ChatMessageItem, type ChatChoiceResponse } from "./chat-message-item";
import { ChatThinkingRowItem } from "./chat-streaming";
import { ChatThreadPanel } from "./chat-thread-panel";

export function ChatConversationView(props: {
  conversation: Conversation;
  settings: AppSettings;
  progress: ReviewProgress[];
  isRunning: boolean;
  hasOlderMessages: boolean;
  olderMessagesLoading: boolean;
  draft: string;
  onDraftChange: (value: string) => void;
  onLoadOlderMessages: () => void;
  onLoadMessagePageForMessage: (messageId: string) => Promise<boolean>;
  onSend: (repoFileMentions?: RepoFileMention[], imageAttachments?: ChatImageInput[], skillMentions?: ChatSkillMention[]) => Promise<boolean>;
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
  onRespondToAppToolApproval: (approvalId: string, approve: boolean, scope?: ChatAppToolApprovalScope) => Promise<void>;
  setRepoFileOpenPreference: (action: RepoFileOpenAction | null) => Promise<void>;
  onStopRun?: (runId: string) => void;
}): JSX.Element {
  const participants = chatParticipants(props.conversation);
  const pendingAppToolApprovals = chatAppToolApprovals(props.conversation).filter((approval) => approval.status === "pending");
  const activeRunIdsForChat = useMemo(() => {
    const ids: string[] = [];
    const seen = new Set<string>();
    const active = props.conversation.metadata?.activeRunIds;
    if (Array.isArray(active)) {
      for (const id of active) {
        if (typeof id === "string" && id && !seen.has(id)) {
          seen.add(id);
          ids.push(id);
        }
      }
    }
    for (const message of props.conversation.messages) {
      if (message.status === "pending" && message.role === "participant") {
        const id = message.metadata?.runId;
        if (typeof id === "string" && id && !seen.has(id)) {
          seen.add(id);
          ids.push(id);
        }
      }
    }
    return ids;
  }, [props.conversation.metadata, props.conversation.messages]);
  const topLevelMessages = useMemo(() => chatTopLevelMessages(props.conversation), [props.conversation.messages]);
  const threadSummaries = useMemo(() => chatThreadSummaryMap(props.conversation), [props.conversation.messages]);
  const continuedMentionRequestIds = useMemo(() => chatContinuedMentionRequestIds(props.conversation), [props.conversation.messages]);
  const contextUsageByParticipant = useMemo(() => chatContextUsageByParticipant(props.conversation), [props.conversation.metadata]);
  const sessionsByParticipant = useMemo(() => chatSessionsByParticipant(props.conversation), [props.conversation.metadata]);
  const [selectedThreadRootId, setSelectedThreadRootId] = useState<string | undefined>();
  const [threadDrafts, setThreadDrafts] = useState<Record<string, string>>({});
  const submittingApprovalIdsRef = useRef<Set<string>>(new Set<string>());
  const [submittingApprovalIds, setSubmittingApprovalIds] = useState<ReadonlySet<string>>(new Set<string>());
  const submittingChoiceIdsRef = useRef<Set<string>>(new Set<string>());
  const [submittingChoiceIds, setSubmittingChoiceIds] = useState<ReadonlySet<string>>(new Set<string>());
  const [threadWidth, setThreadWidth] = useState(430);
  const [isResizingThread, setIsResizingThread] = useState(false);
  const [chooserOpen, setChooserOpen] = useState(false);
  const [chooserFileRef, setChooserFileRef] = useState<FileLinkRef | null>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const pendingFocusMessageIdRef = useRef<string | undefined>();
  const loadingFocusMessageIdRef = useRef<string | undefined>();
  const stickToBottomRef = useRef(true);
  const forceStickToBottomRef = useRef(false);
  const previousMessageCountRef = useRef(topLevelMessages.length);
  const latestProgress = props.progress[props.progress.length - 1];
  const latestComposerProgress = useMemo(() => {
    for (let i = props.progress.length - 1; i >= 0; i -= 1) {
      const item = props.progress[i];
      if (!item.agentProgress || !item.agentProgress.messageId) {
        return item;
      }
    }
    return undefined;
  }, [props.progress]);
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
    const rows: ChatTimelineRow[] = [];
    if (props.hasOlderMessages || props.olderMessagesLoading) {
      rows.push({ type: "load-older", id: "load-older" });
    }
    for (const message of topLevelMessages) {
      rows.push({ type: "message", id: message.id, message });
    }
    if (props.isRunning) {
      for (const row of thinkingRows) {
        rows.push({ type: "thinking", id: row.key, row });
      }
    }
    return rows;
  }, [props.hasOlderMessages, props.isRunning, props.olderMessagesLoading, thinkingRows, topLevelMessages]);
  const chatVirtualizer = useVirtualizer({
    count: chatTimelineRows.length,
    getScrollElement: () => timelineRef.current,
    estimateSize: (index) => {
      const row = chatTimelineRows[index];
      return row?.type === "message" ? 170 : 56;
    },
    getItemKey: (index) => chatTimelineRows[index]?.id ?? index,
    overscan: 8,
    useFlushSync: false
  });
  const chatVirtualItems = chatVirtualizer.getVirtualItems();
  const repoFileLinkContext = useMemo(() => ({
    conversationId: props.conversation.id,
    requestOpenFile: (ref: FileLinkRef) => {
      const preference = props.settings.repoFileOpenAction;
      if (preference) {
        void openRepoFileReference(ref, preference);
        return;
      }
      setChooserFileRef(ref);
      setChooserOpen(true);
    }
  }), [props.conversation.id, props.settings.repoFileOpenAction]);

  function updateStickToBottom(): void {
    const timeline = timelineRef.current;
    if (!timeline) {
      return;
    }
    stickToBottomRef.current = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 96;
    if (timeline.scrollTop < 96 && props.hasOlderMessages && !props.olderMessagesLoading) {
      props.onLoadOlderMessages();
    }
  }

  async function sendDraft(repoFileMentions: RepoFileMention[] = [], imageAttachments: ChatImageInput[] = [], skillMentions: ChatSkillMention[] = []): Promise<boolean> {
    forceStickToBottomRef.current = true;
    return props.onSend(repoFileMentions, imageAttachments, skillMentions);
  }

  function scrollToChatBottom(): void {
    if (chatTimelineRows.length === 0) {
      return;
    }
    chatVirtualizer.scrollToIndex(chatTimelineRows.length - 1, { align: "end" });
    const timeline = timelineRef.current;
    if (timeline) {
      timeline.scrollTop = timeline.scrollHeight;
    }
  }

  function scheduleScrollToChatBottom(): void {
    scrollToChatBottom();
    window.requestAnimationFrame(() => {
      scrollToChatBottom();
      window.requestAnimationFrame(scrollToChatBottom);
    });
    window.setTimeout(scrollToChatBottom, 80);
    window.setTimeout(scrollToChatBottom, 180);
  }

  function scheduleFocusRenderedMessage(messageId: string): void {
    const focus = (): boolean => focusRenderedMessage(viewRef.current, messageId);
    window.requestAnimationFrame(() => {
      if (focus()) {
        return;
      }
      window.requestAnimationFrame(() => {
        if (focus()) {
          return;
        }
        window.setTimeout(focus, 80);
        window.setTimeout(focus, 180);
      });
    });
  }

  function focusLoadedChatMessage(messageId: string): boolean {
    if (focusRenderedMessage(viewRef.current, messageId)) {
      return true;
    }

    const rowIndex = chatTimelineRows.findIndex((row) => row.type === "message" && row.message.id === messageId);
    if (rowIndex >= 0) {
      chatVirtualizer.scrollToIndex(rowIndex, { align: "center" });
      scheduleFocusRenderedMessage(messageId);
      return true;
    }

    for (const [rootId, summary] of threadSummaries) {
      if (summary.replies.some((reply) => reply.id === messageId)) {
        setSelectedThreadRootId(rootId);
        scheduleFocusRenderedMessage(messageId);
        return true;
      }
    }

    return false;
  }

  async function loadAndFocusMessage(messageId: string): Promise<void> {
    if (loadingFocusMessageIdRef.current === messageId) {
      return;
    }
    loadingFocusMessageIdRef.current = messageId;
    pendingFocusMessageIdRef.current = messageId;
    try {
      const loaded = await props.onLoadMessagePageForMessage(messageId);
      if (loaded) {
        scheduleFocusRenderedMessage(messageId);
        return;
      }
      if (pendingFocusMessageIdRef.current === messageId) {
        pendingFocusMessageIdRef.current = undefined;
      }
    } finally {
      if (loadingFocusMessageIdRef.current === messageId) {
        loadingFocusMessageIdRef.current = undefined;
      }
    }
  }

  function focusChatMessage(messageId: string): boolean {
    if (focusLoadedChatMessage(messageId)) {
      return true;
    }
    if (props.hasOlderMessages && !props.olderMessagesLoading) {
      void loadAndFocusMessage(messageId);
      return true;
    }
    return false;
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

  async function handleAppToolApproval(
    approvalId: string,
    approve: boolean,
    scope?: ChatAppToolApprovalScope
  ): Promise<void> {
    if (submittingApprovalIdsRef.current.has(approvalId)) {
      return;
    }
    submittingApprovalIdsRef.current.add(approvalId);
    setSubmittingApprovalIds(new Set(submittingApprovalIdsRef.current));
    try {
      await props.onRespondToAppToolApproval(approvalId, approve, scope);
    } finally {
      submittingApprovalIdsRef.current.delete(approvalId);
      setSubmittingApprovalIds(new Set(submittingApprovalIdsRef.current));
    }
  }

  async function handleChoiceResponse(
    sourceMessageId: string,
    choiceId: string,
    response: ChatChoiceResponse
  ): Promise<void> {
    if (submittingChoiceIdsRef.current.has(choiceId)) {
      return;
    }
    submittingChoiceIdsRef.current.add(choiceId);
    setSubmittingChoiceIds(new Set(submittingChoiceIdsRef.current));
    try {
      await props.onRespondToChoice(sourceMessageId, choiceId, response);
    } finally {
      submittingChoiceIdsRef.current.delete(choiceId);
      setSubmittingChoiceIds(new Set(submittingChoiceIdsRef.current));
    }
  }

  async function openRepoFileReference(ref: FileLinkRef, action: RepoFileOpenAction): Promise<void> {
    try {
      const result = await window.consensus.openRepoFile({
        conversationId: props.conversation.id,
        path: ref.path,
        line: ref.line,
        column: ref.column,
        action
      });
      if (ref.line && !result.lineNavigationSupported) {
        toast.info(`Opened ${ref.path}. The default app cannot jump to line ${ref.line}.`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not open the file.");
    }
  }

  async function chooseRepoFileOpenAction(action: RepoFileOpenAction): Promise<void> {
    const ref = chooserFileRef;
    setChooserOpen(false);
    if (!ref) {
      return;
    }
    await props.setRepoFileOpenPreference(action);
    await openRepoFileReference(ref, action);
  }

  function handleRepoFileChooserOpenChange(open: boolean): void {
    setChooserOpen(open);
  }

  function startThreadResize(event: ReactPointerEvent<HTMLDivElement>): void {
    const view = viewRef.current;
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
    submittingApprovalIdsRef.current.clear();
    setSubmittingApprovalIds(new Set<string>());
    submittingChoiceIdsRef.current.clear();
    setSubmittingChoiceIds(new Set<string>());
    setChooserOpen(false);
    setChooserFileRef(null);
    pendingFocusMessageIdRef.current = undefined;
    loadingFocusMessageIdRef.current = undefined;
    stickToBottomRef.current = true;
    forceStickToBottomRef.current = true;
    scheduleScrollToChatBottom();
  }, [props.conversation.id]);

  useEffect(() => {
    if (selectedThreadRootId && !topLevelMessages.some((message) => message.id === selectedThreadRootId)) {
      setSelectedThreadRootId(undefined);
    }
  }, [selectedThreadRootId, topLevelMessages]);

  useEffect(() => {
    const pendingMessageId = pendingFocusMessageIdRef.current;
    if (!pendingMessageId) {
      return;
    }
    if (focusLoadedChatMessage(pendingMessageId)) {
      pendingFocusMessageIdRef.current = undefined;
    }
  }, [chatTimelineRows, selectedThreadRootId, threadSummaries]);

  useLayoutEffect(() => {
    const timeline = timelineRef.current;
    const messageCountChanged = previousMessageCountRef.current !== topLevelMessages.length;
    previousMessageCountRef.current = topLevelMessages.length;
    const shouldFollowBottom = stickToBottomRef.current || forceStickToBottomRef.current || messageCountChanged;
    if (!timeline || !shouldFollowBottom) {
      return;
    }
    scheduleScrollToChatBottom();
    stickToBottomRef.current = true;
    if (messageCountChanged) {
      forceStickToBottomRef.current = false;
    }
  }, [
    topLevelMessages.length,
    latestMessage?.content,
    latestMessage?.status,
    latestProgress?.message,
    thinkingSignature,
    props.draft,
    props.isRunning,
    chatTimelineRows.length,
    chatVirtualizer
  ]);

  useLayoutEffect(() => {
    scheduleScrollToChatBottom();
    stickToBottomRef.current = true;
  }, [props.conversation.id]);

  return (
    <MessageLinkContext.Provider value={focusChatMessage}>
      <RepoFileLinkContext.Provider value={repoFileLinkContext}>
        <div
          className={`chat-view ${hasThread ? "thread-open" : ""} ${isResizingThread ? "resizing-thread" : ""}`}
          data-testid="chat-view"
          ref={viewRef}
          style={{ "--chat-thread-width": `${threadWidth}px` } as CSSProperties}
        >
          <div className="chat-main">
            <div className={`chat-app-tool-approval-slot ${pendingAppToolApprovals.length > 0 ? "has-approvals" : ""}`}>
              {pendingAppToolApprovals.length > 0 && (
                <ChatAppToolApprovalList
                  approvals={pendingAppToolApprovals}
                  submittingIds={submittingApprovalIds}
                  onRespond={handleAppToolApproval}
                />
              )}
            </div>
            <div className="chat-timeline virtual-timeline" ref={timelineRef} onScroll={updateStickToBottom}>
              <div className="virtual-timeline-inner" style={{ height: `${chatVirtualizer.getTotalSize()}px` }}>
                {chatVirtualItems.map((virtualItem) => {
                  const row = chatTimelineRows[virtualItem.index];
                  if (!row) {
                    return null;
                  }
                  return (
                    <div
                      className="virtual-timeline-item"
                      data-index={virtualItem.index}
                      key={virtualItem.key}
                      ref={chatVirtualizer.measureElement}
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
                      ) : (
                        <ChatMessageItem
                          message={row.message}
                          conversationId={props.conversation.id}
                          participants={participants}
                          contextUsage={contextUsageForMessage(row.message, contextUsageByParticipant)}
                          sessionId={sessionIdForMessage(row.message, sessionsByParticipant)}
                          busy={props.isRunning}
                          submittingChoiceIds={submittingChoiceIds}
                          selected={row.message.id === selectedThreadRoot?.id}
                          replyCount={threadSummaries.get(row.message.id)?.replies.length ?? 0}
                          latestReplyAt={threadSummaries.get(row.message.id)?.latestReplyAt}
                          hasContinuationReply={continuedMentionRequestIds.has(row.message.id)}
                          liveProgress={liveProgressById.get(row.message.id)}
                          onOpenThread={() => setSelectedThreadRootId(row.message.id)}
                          onApproveMentions={props.onApproveMentions}
                          onRejectMentions={props.onRejectMentions}
                          onRespondToChoice={handleChoiceResponse}
                          onToggleReaction={props.onToggleReaction}
                          onStopRun={props.onStopRun}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
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
              conversationId={props.conversation.id}
              repoPath={props.conversation.repoPath}
              contextUsageByParticipant={contextUsageByParticipant}
              sessionsByParticipant={sessionsByParticipant}
              settings={props.settings}
              draft={threadDrafts[selectedThreadRoot.id] ?? ""}
              busy={props.isRunning}
              submittingChoiceIds={submittingChoiceIds}
              liveProgressById={liveProgressById}
              onDraftChange={(value) => setThreadDrafts((current) => ({ ...current, [selectedThreadRoot.id]: value }))}
              onSend={(repoFileMentions, imageAttachments, skillMentions) => sendThreadDraft(selectedThreadRoot, repoFileMentions, imageAttachments, skillMentions)}
              onClose={() => setSelectedThreadRootId(undefined)}
              onApproveMentions={props.onApproveMentions}
              onRejectMentions={props.onRejectMentions}
              onRespondToChoice={handleChoiceResponse}
              onToggleReaction={props.onToggleReaction}
              onStopRun={props.onStopRun}
              continuedMentionRequestIds={continuedMentionRequestIds}
            />
          )}
          <RepoFileOpenChooser
            fileRef={chooserFileRef}
            open={chooserOpen}
            onChoose={(action) => void chooseRepoFileOpenAction(action)}
            onOpenChange={handleRepoFileChooserOpenChange}
          />
        </div>
      </RepoFileLinkContext.Provider>
    </MessageLinkContext.Provider>
  );
}

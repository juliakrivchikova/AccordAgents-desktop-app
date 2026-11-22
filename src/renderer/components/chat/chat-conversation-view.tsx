import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { ArrowDown } from "lucide-react";

import type {
  ChatAppToolApprovalRequest,
  ChatAppToolApprovalScope,
  ChatImageInput,
  ChatSkillMention,
  Conversation,
  RepoFileMention
} from "../../../shared/types";
import type { ChatThreadSummary } from "./chat-thread-data";
import { activeRunSummaryForConversation } from "../../../shared/chatActiveRuns";
import { LocalFileLinkContext, LocalFileOpenChooser } from "../content/local-file-link";
import { MessageLinkContext } from "../content/markdown-text";
import { MentionDirectoryContext } from "../content/participant-hover-card";
import { RunStatusLine } from "../conversation/timeline-primitives";
import { IconButton } from "../primitives";
import { ChatComposer } from "./chat-composer";
import { ChatSessionsPresentationContext, renderComposerMemberMark } from "./chat-member-mark";
import {
  buildChatTimelineRows,
  chatAppToolApprovals,
  chatApprovalPlacement,
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
import { ArtifactNoteProgressContext } from "./chat-artifact-note-card";
import { artifactNoteProgressById } from "../../../shared/artifactNoteProgress";
import { ChatAccordDockSlot } from "./chat-accord-dock";
import { useDockedAccord } from "./use-accord-progress";
import { AccordLinesContext } from "./chat-accord-closed-line";
import { ARTIFACT_NOTE_MESSAGE_SOURCE } from "../../../shared/artifacts";
import { AttachmentPanelContext } from "../files/file-panel-context";
import { ChatSidePanel, useChatSidePanel } from "./chat-side-panel";
import { ChatConversationTimeline } from "./chat-conversation-timeline";
import type { ChatConversationViewProps } from "./chat-conversation-types";
import { useChatConversationViewport } from "./use-chat-conversation-viewport";
import { useChatActivityDisclosure } from "./use-chat-activity-disclosure";
import { useChatLocalFileOpen } from "./use-chat-local-file-open";
import { useSubmittingIdSet } from "./use-submitting-id-set";
import { useStableChatMessageActions } from "./use-stable-chat-message-actions";
import { useChatPromptSuggestions } from "./use-chat-prompt-suggestions";
import { sessionsComposerSuggestions } from "./use-chat-composer-suggestions";
import { useChatRightPanel, useChatRightPanelWidth } from "./use-chat-right-panel";
import { useChatSessionsChrome, useChatSessionsView } from "./use-chat-sessions-view";
import { useChatViewMode } from "./use-chat-view-mode";
import { ChatViewHeaderContext } from "./chat-view-switch";
import type { ChatPanelMessageContext } from "./chat-sessions-right-panel";
import { ChatSessionsLinksContext, ChatSessionsNamesContext, useStableMap, useStableSessionsViewNames } from "./chat-sessions-links";
import { mainComposerTargetIds, sessionsComposerProps } from "./chat-sessions-composer";
import { ChatViewRightPanels } from "./chat-view-right-panels";

export type { ChatMessageFocusRequest } from "./chat-conversation-types";

const NO_CLOSED_ACCORDS: readonly string[] = [];
const NO_THREADS = new Map<string, ChatThreadSummary>();

export function ChatConversationView(props: ChatConversationViewProps): JSX.Element {
  const participantStatusById = useStableMap(props.participantStatusById);
  const participants = useMemo(
    () => chatParticipants(props.conversation),
    [props.conversation.metadata.participants]
  );
  const promptSuggestions = useChatPromptSuggestions(props.conversation.id, participants);
  const pendingAppToolApprovals = chatAppToolApprovals(props.conversation).filter((approval) => approval.status === "pending");
  const resolvedTimelineApprovals = useMemo(
    () =>
      chatAppToolApprovals(props.conversation).filter(
        (approval) =>
          approval.status !== "pending" &&
          (
            approval.toolName === "app_roles_request_change" ||
            approval.toolName === "app_participants_request_change" ||
            approval.toolName === "app_scripts_request_change" ||
            approval.toolName === "app_connector_sign_in" ||
            approval.toolName === "app_chat_request_compaction" ||
            approval.toolName === "codex_auto_review_approval"
          )
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
    const status = participantStatusById.get(participantId);
    const runIds = activeRunSummary.runIdsByParticipantId.get(participantId) ?? [];
    return participant && status && status !== "idle" && runIds.length > 0 ? [{ participant, runIds, status }] : [];
  }), [
    activeRunSummary,
    participantsById,
    participantStatusById
  ]);
  const viewMode = useChatViewMode({
    conversation: props.conversation,
    defaultView: props.settings.defaultChatView,
    onSaved: props.onChatViewSaved,
    onError: props.onChatViewError
  });
  // The sessions view (docs/main-session.md): the main timeline holds the User
  // and the main session; each other member's session is in the right panel.
  const sessions = useChatSessionsView({
    conversation: props.conversation,
    view: viewMode.view,
    participants,
    participantStatusById: participantStatusById
  });
  const sessionsMainMessages = sessions?.mainMessages;
  const topLevelMessages = useMemo(
    () => sessionsMainMessages ?? chatTopLevelMessages(props.conversation),
    [props.conversation.messages, sessionsMainMessages]
  );
  const threadSummaries = useMemo(
    () => (sessionsMainMessages ? NO_THREADS : chatThreadSummaryMap(props.conversation)),
    [props.conversation.messages, sessionsMainMessages !== undefined]
  );
  const inferredParticipantRequestsByTrigger = useMemo(() => chatInferredParticipantRequestBatchesByTrigger(props.conversation), [props.conversation.messages]);
  const continuedMentionRequestIds = useMemo(() => chatContinuedMentionRequestIds(props.conversation), [props.conversation.messages]);
  const contextUsageByParticipant = useMemo(() => chatContextUsageByParticipant(props.conversation), [props.conversation.metadata]);
  const sessionsByParticipant = useMemo(() => chatSessionsByParticipant(props.conversation), [props.conversation.metadata]);
  const mentionDirectory = useMemo(
    () => chatMentionDirectory(participants, props.settings.chatRoleConfigs, sessionsByParticipant, contextUsageByParticipant),
    [participants, props.settings.chatRoleConfigs, sessionsByParticipant, contextUsageByParticipant]
  );
  const artifacts = props.artifacts;
  // Each artifact note's drafts and signatures as they stood when it was
  // written, read from the notes loaded for this chat. Worked out again only
  // when the notes themselves change, not on every update of a running turn.
  const artifactNotes = props.conversation.messages.filter(
    (message) => message.role === "system" && message.metadata?.appMessageSource === ARTIFACT_NOTE_MESSAGE_SOURCE
  );
  const artifactNotesKey = artifactNotes.map((note) => `${note.id}:${note.content.length}`).join("\n");
  const artifactNotesRef = useRef(artifactNotes);
  artifactNotesRef.current = artifactNotes;
  const artifactNoteProgress = useMemo(() => {
    const byId = artifacts.context.byId;
    return artifactNoteProgressById(artifactNotesRef.current, (artifactId) => {
      const summary = byId.get(artifactId);
      return summary ? { signers: summary.approval.requiredSigners.length, drafters: summary.requiredDraftCount || undefined } : undefined;
    });
  }, [artifactNotesKey, artifacts.context.byId]);
  const { docked: dockedAccord, latest: latestAccord, accordLines } = useDockedAccord(props.conversation.messages, artifactNotesKey, participants,
    props.conversation.metadata.accordClosedLaunchIds ?? NO_CLOSED_ACCORDS);
  const rightPanel = useChatRightPanel();
  const { selectedThreadRootId, selectThread: setSelectedThreadRootId } = rightPanel;
  const [threadDrafts, setThreadDrafts] = useState<Record<string, string>>({});
  const approvalSubmission = useSubmittingIdSet();
  const choiceSubmission = useSubmittingIdSet();
  const activityDisclosure = useChatActivityDisclosure(props.conversation.id);
  const chatMessageActions = useStableChatMessageActions({
    onApproveMentions: props.onApproveMentions,
    onRejectMentions: props.onRejectMentions,
    onRespondToChoice: props.onRespondToChoice,
    onToggleReaction: props.onToggleReaction,
    onCompactParticipant: props.onCompactParticipant,
    onStopRun: props.onStopRun,
    onDismissTurnFinishedNote: props.onDismissTurnFinishedNote,
    runChoiceWithSubmittingId: choiceSubmission.runWithSubmittingId
  });
  // Read when used, after the viewport below exists.
  const viewportRootRef = useRef<React.RefObject<HTMLDivElement> | undefined>(undefined);
  const chatRoot = useCallback((): HTMLElement | null => viewportRootRef.current?.current ?? null, []);
  const sidePanel = useChatSidePanel({ artifacts, root: chatRoot, selectThread: setSelectedThreadRootId });
  const localFileOpen = useChatLocalFileOpen({
    conversationId: props.conversation.id,
    repoFileOpenAction: props.settings.repoFileOpenAction,
    repoFileExternalOpenAction: props.settings.repoFileExternalOpenAction,
    setRepoFileOpenPreference: props.setRepoFileOpenPreference,
    setRepoFileExternalOpenPreference: props.setRepoFileExternalOpenPreference,
    openInPanel: sidePanel.openInPanel
  });
  const latestProgress = props.progress[props.progress.length - 1];
  const latestComposerProgress = useMemo(() => latestNonMessageProgress(props.progress), [props.progress]);
  const hasPendingParticipantMessage = useMemo(
    () => props.conversation.messages.some((message) => message.status === "pending" && message.role === "participant"),
    [props.conversation.messages]
  );
  const sessionsMainId = sessions?.mainSessionId;
  const thinkingRows = useMemo(
    () => chatThinkingRows(props.progress).filter((row) => !sessionsMainId || !row.participantId || row.participantId === sessionsMainId),
    [props.progress, sessionsMainId]
  );
  const liveProgressById = useMemo(() => liveMessageProgressById(props.progress), [props.progress]);
  const thinkingSignature = useMemo(
    () => thinkingRows.map((row) => `${row.key}:${row.activity ?? ""}:${row.activityEvents?.length ?? 0}:${row.updatedAt}`).join("|"),
    [thinkingRows]
  );
  const latestMessage = topLevelMessages[topLevelMessages.length - 1];
  const selectedThreadRoot = selectedThreadRootId
    ? topLevelMessages.find((message) => message.id === selectedThreadRootId)
    : undefined;
  const selectedThreadSummary = selectedThreadRoot ? threadSummaries.get(selectedThreadRoot.id) : undefined;
  const panel = rightPanel.panel;
  const sessionsPanelOpen = Boolean(sessions) && (
    panel?.kind === "members" || panel?.kind === "accord" ||
    (panel?.kind === "member" && (participantsById.has(panel.participantId) || sessions?.isFormerMember(panel.participantId) === true))
  );
  const hasThread = Boolean(selectedThreadRoot) || sessionsPanelOpen;
  const visibleApprovalMessages = useMemo(
    () => [...topLevelMessages, ...(selectedThreadSummary?.replies ?? [])],
    [selectedThreadSummary?.replies, topLevelMessages]
  );
  const approvalPlacement = useMemo(
    () => chatApprovalPlacement(pendingAppToolApprovals, visibleApprovalMessages),
    [pendingAppToolApprovals, visibleApprovalMessages]
  );
  const chatTimelineRows = useMemo(() => buildChatTimelineRows({
    hasOlderMessages: props.hasOlderMessages,
    olderMessagesLoading: props.olderMessagesLoading,
    isRunning: props.isRunning,
    loadedMessages: props.conversation.messages,
    topLevelMessages,
    resolvedApprovals: sessions ? resolvedTimelineApprovals.filter((approval) => !sessions.hidesApproval(approval)) : resolvedTimelineApprovals,
    thinkingRows
  }), [props.conversation.messages, props.hasOlderMessages, props.isRunning, props.olderMessagesLoading, resolvedTimelineApprovals, sessions, thinkingRows, topLevelMessages]);
  const sessionsChrome = useChatSessionsChrome({
    sessions, viewMode, rightPanel, participantsById, closeArtifacts: artifacts.closePanel, accordOpen: Boolean(dockedAccord)
  });
  // The names the app's own words use in the sessions view, the same object
  // while no name changes (rows that read them are not drawn again per token).
  const sessionsNames = useStableSessionsViewNames(sessionsChrome.links);
  // The main session's … actions go into the chat title's menu.
  const mainSessionActions = props.mainSessionActions;
  const headerState = useMemo(() => sessions && mainSessionActions
    ? { ...sessionsChrome.header, mainSession: { id: sessions.mainSessionId, actions: mainSessionActions } }
    : sessionsChrome.header, [mainSessionActions, sessions, sessionsChrome.header]);
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
    openOutsideTimeline: sessionsChrome.openOutsideTimeline,
    onLoadOlderMessages: props.onLoadOlderMessages,
    onLoadMessagePageForMessage: props.onLoadMessagePageForMessage
  });
  viewportRootRef.current = viewport.viewRef;

  async function sendDraft(
    repoFileMentions: RepoFileMention[] = [],
    imageAttachments: ChatImageInput[] = [],
    skillMentions: ChatSkillMention[] = [],
    content?: string
  ): Promise<boolean> {
    promptSuggestions.dismiss();
    // The sessions view's composer writes to the main session, whatever it names.
    const sent = await props.onSend(repoFileMentions, imageAttachments, skillMentions, content, mainComposerTargetIds(sessions?.mainSessionId));
    if (sent) {
      viewport.scrollToChatBottom();
    } else {
      promptSuggestions.reload();
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
    draftOverride?: ChatAppToolApprovalRequest,
    codexDecisionId?: string
  ): Promise<void> {
    return approvalSubmission.runWithSubmittingId(
      approvalId,
      () => props.onRespondToAppToolApproval(approvalId, approve, scope, draftOverride, codexDecisionId)
    );
  }

  const panelWidth = useChatRightPanelWidth(chatRoot, hasThread);

  useLayoutEffect(() => {
    // Reset before descendant focus effects consume a target for the newly mounted conversation.
    rightPanel.reset();
    setThreadDrafts({});
    approvalSubmission.resetSubmittingIds();
    choiceSubmission.resetSubmittingIds();
    localFileOpen.resetLocalFileChooser();
  }, [
    props.conversation.id,
    rightPanel.reset,
    approvalSubmission.resetSubmittingIds,
    choiceSubmission.resetSubmittingIds,
    localFileOpen.resetLocalFileChooser
  ]);

  useEffect(() => {
    if (selectedThreadRootId && !topLevelMessages.some((message) => message.id === selectedThreadRootId)) {
      setSelectedThreadRootId(undefined);
    }
  }, [selectedThreadRootId, topLevelMessages]);

  useEffect(() => {
    if (artifacts.panelOpen && panel) {
      rightPanel.close();
    }
  }, [artifacts.panelOpen, panel, rightPanel.close]);

  const hasInlineTopBar = Boolean(props.topBar);
  const showArtifactsPanel = artifacts.panelOpen && !hasThread;

  function openThread(messageId: string): void {
    artifacts.closePanel();
    setSelectedThreadRootId(messageId);
  }

  function stopRuns(runIds: readonly string[]): void {
    for (const runId of runIds) {
      props.onStopRun?.(runId);
    }
  }

  // Stable across renders: the message rows are memoized, and a new handler on every
  // render re-rendered all of them on every scroll step, which made frames long.
  const rowHandlersRef = useRef({ openThread, handleAppToolApproval });
  rowHandlersRef.current = { openThread, handleAppToolApproval };
  const stableOpenThread = useCallback((messageId: string) => rowHandlersRef.current.openThread(messageId), []);
  const stableAppToolApproval = useCallback(
    (...args: Parameters<typeof handleAppToolApproval>) => rowHandlersRef.current.handleAppToolApproval(...args),
    []
  );

  const panelMessageContext: ChatPanelMessageContext = {
    activityDisclosure,
    conversationId: props.conversation.id,
    participants,
    participantStatusById: participantStatusById,
    busy: props.isRunning,
    submittingChoiceIds: choiceSubmission.submittingIds,
    submittingApprovalIds: approvalSubmission.submittingIds,
    settings: props.settings,
    contextUsageByParticipant,
    sessionsByParticipant,
    continuedMentionRequestIds,
    inferredParticipantRequestsByTrigger,
    liveProgressById,
    ...chatMessageActions,
    onStopRun: props.onStopRun ? chatMessageActions.onStopRun : undefined,
    onDismissTurnFinishedNote: props.onDismissTurnFinishedNote ? chatMessageActions.onDismissTurnFinishedNote : undefined,
    onRespondToAppToolApproval: stableAppToolApproval
  };

  return (
    <ChatSessionsPresentationContext.Provider value={Boolean(sessions)}><ChatSessionsLinksContext.Provider value={sessionsChrome.links}><ChatSessionsNamesContext.Provider value={sessionsNames}>
    <MentionDirectoryContext.Provider value={mentionDirectory}>
    <MessageLinkContext.Provider value={viewport.focusChatMessage}>
      <ArtifactsContext.Provider value={artifacts.context}>
      <ArtifactNoteProgressContext.Provider value={artifactNoteProgress}>
      <AccordLinesContext.Provider value={accordLines}>
      <LocalFileLinkContext.Provider value={localFileOpen.localFileLinkContext}>
      <AttachmentPanelContext.Provider value={sidePanel.attachmentContext}>
        <div
          className={`chat-view ${hasInlineTopBar ? "with-inline-topbar" : ""} ${hasThread ? "thread-open" : ""} ${showArtifactsPanel ? "artifacts-open" : ""} ${panelWidth.isResizing ? "resizing-thread" : ""} ${sessions ? "is-sessions-view" : ""}`}
          data-testid="chat-view"
          data-chat-view={viewMode.view}
          data-right-panel={panel?.kind}
          ref={viewport.viewRef}
          style={{ "--chat-thread-width": `${panelWidth.width}px` } as CSSProperties}
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
          <ChatViewHeaderContext.Provider value={headerState}>{props.topBar}</ChatViewHeaderContext.Provider>
          <div className="chat-main">
            <ChatConversationTimeline
              activityDisclosure={activityDisclosure}
              conversationId={props.conversation.id}
              contextUsageByParticipant={contextUsageByParticipant}
              continuedMentionRequestIds={continuedMentionRequestIds}
              hasOlderMessages={props.hasOlderMessages}
              inferredParticipantRequestsByTrigger={inferredParticipantRequestsByTrigger}
              isRunning={props.isRunning}
              liveProgressById={liveProgressById}
              olderMessagesLoading={props.olderMessagesLoading}
              onApproveMentions={chatMessageActions.onApproveMentions}
              onCompactParticipant={chatMessageActions.onCompactParticipant}
              onLoadOlderMessages={props.onLoadOlderMessages}
              onOpenThread={stableOpenThread}
              onRejectMentions={chatMessageActions.onRejectMentions}
              onRespondToAppToolApproval={stableAppToolApproval}
              onRespondToChoice={chatMessageActions.onRespondToChoice}
              onScroll={viewport.updateStickToBottom}
              onScrollIntent={viewport.markUserScrollIntent}
              onStopRun={props.onStopRun ? chatMessageActions.onStopRun : undefined}
              onToggleReaction={chatMessageActions.onToggleReaction}
              onDismissTurnFinishedNote={props.onDismissTurnFinishedNote ? chatMessageActions.onDismissTurnFinishedNote : undefined}
              participantStatusById={participantStatusById}
              participants={participants}
              approvalsByMessageId={approvalPlacement.byMessageId}
              pendingApprovalRows={approvalPlacement.unanchored}
              rows={chatTimelineRows}
              sessions={sessionsChrome.timeline}
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
            <ChatAccordDockSlot
              docked={dockedAccord}
              conversationId={props.conversation.id}
              participants={participants}
              keepAtLatest={() => { if (viewport.isStuckToBottom) viewport.scrollToChatBottom(); }}
              onOpenInPanel={sessionsChrome.openAccord}
              panelLaunchId={panel?.kind === "accord" ? panel.launchId : undefined}
            >
              {!viewport.isStuckToBottom && topLevelMessages.length > 0 && (
                <IconButton className="chat-jump-to-latest" floating label="Jump to latest" icon={ArrowDown} onClick={viewport.scrollToChatBottom} />
              )}
            </ChatAccordDockSlot>
            <ChatComposer
              participants={participants}
              savedPrompts={props.settings.chatSavedPrompts}
              conversationId={props.conversation.id}
              repoPath={props.conversation.repoPath}
              draft={props.draft}
              picks={props.composerPicks}
              suggestions={sessionsComposerSuggestions(promptSuggestions.suggestions, sessions?.mainSessionId)}
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
              onJumpToParticipantLastMessage={props.onJumpToParticipantLastMessage}
              placeholder="Message @name, /name, or #path..."
              {...sessionsComposerProps(sessions?.mainSessionId, props.renderMemberChip,
                { runIds: activeRunSummary.runIdsByParticipantId.get(sessions?.mainSessionId ?? "") ?? [], onStopRun: props.onStopRun })}
              status={props.isRunning && !hasPendingParticipantMessage && latestComposerProgress ? <RunStatusLine progress={latestComposerProgress} /> : undefined}
              testId="chat-main-composer"
              takesFocusRequests
              renderParticipantAvatar={renderComposerMemberMark}
              participantRoleLabel={(participant) => chatRoleLabel(props.settings.chatRoleConfigs, participant)}
            />
          </div>
          <ChatViewRightPanels
            shown={hasThread}
            onStartResize={panelWidth.startResize}
            context={panelMessageContext}
            conversation={props.conversation}
            thread={selectedThreadRoot ? {
              root: selectedThreadRoot,
              summary: selectedThreadSummary,
              draft: threadDrafts[selectedThreadRoot.id] ?? "",
              approvalsByMessageId: approvalPlacement.byMessageId,
              onDraftChange: (value) => setThreadDrafts((current) => ({ ...current, [selectedThreadRoot.id]: value })),
              onSend: (repoFileMentions, imageAttachments, skillMentions, content) =>
                sendThreadDraft(selectedThreadRoot, repoFileMentions, imageAttachments, skillMentions, content),
              onClose: rightPanel.close
            } : undefined}
            sessions={sessions && sessionsPanelOpen ? {
              view: sessions,
              rightPanel,
              runIdsByParticipantId: activeRunSummary.runIdsByParticipantId,
              hasOlderMessages: props.hasOlderMessages,
              olderMessagesLoading: props.olderMessagesLoading,
              onLoadOlderMessages: props.onLoadOlderMessages,
              onSendToMember: props.onSendToMember ?? (async () => false),
              renderMemberSettings: props.renderMemberSettings,
              renderMemberChip: props.renderMemberChip,
              onStopRuns: props.onStopRun ? stopRuns : undefined,
              latestAccord,
              onOpenAccord: sessionsChrome.openAccord ?? rightPanel.openAccord
            } : undefined}
          />
          {showArtifactsPanel && (
            <ChatSidePanel
              conversation={props.conversation}
              settings={props.settings}
              artifacts={artifacts}
              backToThread={sidePanel.backToThread}
              openFileOutside={(ref, action) => void localFileOpen.openFileOutside(ref, action)}
            />
          )}
          <LocalFileOpenChooser
            fileRef={localFileOpen.chooserFileRef}
            open={localFileOpen.chooserOpen}
            onChoose={(action) => void localFileOpen.chooseLocalFileOpenAction(action)}
            onOpenChange={localFileOpen.handleLocalFileChooserOpenChange}
          />
        </div>
      </AttachmentPanelContext.Provider>
      </LocalFileLinkContext.Provider>
      </AccordLinesContext.Provider>
      </ArtifactNoteProgressContext.Provider>
      </ArtifactsContext.Provider>
    </MessageLinkContext.Provider>
    </MentionDirectoryContext.Provider>
    </ChatSessionsNamesContext.Provider></ChatSessionsLinksContext.Provider></ChatSessionsPresentationContext.Provider>
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

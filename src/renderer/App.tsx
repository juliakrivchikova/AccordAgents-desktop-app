import React from "react";
import { createRoot } from "react-dom/client";
import {
  RefreshCw,
  Settings,
  XCircle
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { ModeToggle } from "./components/mode-toggle";
import { ThemeProvider } from "./components/theme-provider";
import { AppLoadingState } from "./components/loading-states";
import { AppShell, Sidebar, SidebarPanelIcon, TopBar } from "./components/shell";
import { SettingsView, type SettingsSection } from "./components/settings/settings-view";
import { SettingsSidebar } from "./components/settings/settings-sidebar";
import { SlackView } from "./components/review/review-view";
import { ChatConversationView } from "./components/chat/chat-conversation-view";
import { ChatParticipantMenu } from "./components/chat/chat-participant-menu";
import { ChatAccordLauncherDialog } from "./components/chat/chat-accord-launcher-dialog";
import { NewChatScreen } from "./components/chat/new-chat-screen";
import { ChatTopBarTitle } from "./components/chat/chat-top-bar-title";
import { chatRoleLabel } from "./components/chat/chat-conversation-data";
import { avatarForChatParticipant } from "./components/chat/chat-avatars";
import { defaultChatParticipantDraft } from "./components/chat/chat-participant-drafts";
import { Avatar } from "./components/avatar/avatar";
import { isChatAssistantParticipant } from "./components/conversation/conversation-display";
import { planDecisionReplies } from "./components/review/review-conversation-data";
import { useAppState } from "./app/app-state";
import { useConversationActions } from "./app/use-conversation-actions";
import { useAppEffects } from "./app/use-app-effects";
import { useChatActions } from "./app/use-chat-actions";
import { useReviewDecisionActions } from "./app/use-review-decision-actions";
import { useReviewPlanActions } from "./app/use-review-plan-actions";
import { useSettingsActions } from "./app/use-settings-actions";
import { useAppViewModel } from "./app/use-app-view-model";
import { AppNotices } from "./app/app-notices";
import "./styles/app.css";

function App(): JSX.Element {
  const state = useAppState();
  const conversationActions = useConversationActions(state);
  const chatActions = useChatActions(state, conversationActions);
  const reviewDecisionActions = useReviewDecisionActions(state, conversationActions);
  const reviewPlanActions = useReviewPlanActions(state, conversationActions);
  const settingsActions = useSettingsActions(state);
  useAppEffects(state, conversationActions.refreshAll);
  const view = useAppViewModel(state);
  const [appVersion, setAppVersion] = React.useState("");
  const [accordDialogOpen, setAccordDialogOpen] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    void window.consensus.getAppVersion()
      .then((version) => {
        if (!cancelled) {
          setAppVersion(version);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAppVersion("");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const openSettingsSection = (section: SettingsSection): void => {
    state.setActiveSettingsSection(section);
    state.setSidebarMode("settings");
    state.setSidebarCollapsed(false);
  };
  const closeSettings = (): void => {
    state.setSidebarMode("history");
  };

  const openingConversationDescription = view.openingConversation
    ? `${view.openingConversation.kind === "chat" ? "Chat" : view.openingConversation.kind} · ${view.openingConversation.title}`
    : "Opening the selected conversation from history.";
  const isNewChatScreen = !state.initializing && !view.hasResultContext;
  const topBarTitle = view.activeChatConversation
    ? (
      <ChatTopBarTitle
        conversation={view.activeChatConversation}
        isRunning={view.conversationRunning}
        onRenameTitle={chatActions.renameChatConversation}
      />
    )
    : view.hasResultContext
      ? state.conversation?.title ?? view.openingConversation?.title ?? "Chat"
      : isNewChatScreen
        ? undefined
        : "New chat";
  const topBarLeading = state.sidebarCollapsed ? (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      title="Show sidebar"
      aria-label="Show sidebar"
      aria-controls="app-sidebar"
      aria-expanded="false"
      data-testid="sidebar-expand-toggle"
      onClick={() => state.setSidebarCollapsed(false)}
    >
      <SidebarPanelIcon />
      <span className="sr-only">Show sidebar</span>
    </Button>
  ) : undefined;
  const accordEligibleParticipants = React.useMemo(
    () => view.activeChatParticipants.filter((participant) => !isChatAssistantParticipant(participant)),
    [view.activeChatParticipants]
  );
  const accordDisabledReason = !view.activeChatConversation
    ? "Open a chat to start Accord."
    : view.activeChatConversation.metadata.archived === true
      ? "Archived chats cannot start Accord."
      : accordEligibleParticipants.length < 2
          ? "Add at least two participants to start Accord."
          : undefined;
  const canStartAccord = Boolean(view.activeChatConversation && !accordDisabledReason);
  const topBarActions = isNewChatScreen ? (
    <>
      <ModeToggle />
      <Button variant="ghost" size="icon-sm" className="topbar-icon-button" title="Settings" aria-label="Settings" onClick={() => openSettingsSection(state.activeSettingsSection)}>
        <Settings aria-hidden />
        <span className="sr-only">Settings</span>
      </Button>
    </>
  ) : (
    <>
      {state.busy && (
        <Button variant="outline" size="sm" onClick={() => void conversationActions.cancelReview()}>
          <XCircle aria-hidden />
          Stop
        </Button>
      )}
      {view.activeChatConversation && (
        <ChatParticipantMenu
          participants={view.activeChatParticipants}
          participantHasRunById={view.participantHasRunById}
          settings={state.settings}
          agents={state.agents}
          draft={state.chatMessageDraft}
          addParticipantDraft={state.chatAddParticipantDraft ?? defaultChatParticipantDraft(state.settings)}
          isRunning={view.conversationRunning}
          participantStatusById={view.participantStatusById}
          participantWatchers={view.activeChatConversation.metadata.participantWatchers}
          onDraftChange={state.setChatMessageDraft}
          onAddParticipantDraftChange={state.setChatAddParticipantDraft}
          onAddParticipant={() => void chatActions.addChatParticipant()}
          onAddSavedParticipant={(participant, remoteExecution) => void chatActions.addSavedChatParticipant(participant, remoteExecution)}
          onUpdateParticipantRuntime={(participantId, patch) => void chatActions.updateChatParticipantRuntime(participantId, patch)}
          onCompactParticipant={(participantId) => void chatActions.compactChatParticipant(participantId)}
          onRemoveParticipant={(participantId) => void chatActions.removeChatParticipant(participantId)}
          onJumpToParticipantLastMessage={conversationActions.jumpToParticipantLastMessage}
          onManageInSettings={() => openSettingsSection("participants")}
        />
      )}
      <ModeToggle />
      <Button variant="ghost" size="icon-sm" className="topbar-icon-button" title="Refresh" aria-label="Refresh" onClick={() => void conversationActions.refreshAll()}>
        <RefreshCw aria-hidden />
        <span className="sr-only">Refresh</span>
      </Button>
    </>
  );

  return (
    <AppShell
      sidebarCollapsed={state.sidebarCollapsed}
      sidebar={
        state.sidebarMode === "settings" ? (
          <SettingsSidebar
            section={state.activeSettingsSection}
            appVersion={appVersion}
            onSectionChange={state.setActiveSettingsSection}
            onBackToChats={closeSettings}
            onToggleSidebar={() => state.setSidebarCollapsed(true)}
          />
        ) : (
          <Sidebar
            projectGroups={view.projectSessionGroups}
            archivedSessions={view.archivedSessions}
            activeId={state.conversation?.id}
            pendingId={state.openingConversationId}
            busy={state.busy}
            loading={state.historyLoading}
            unreadIds={state.unreadConversationIds}
            appVersion={appVersion}
            onSelect={(id) => void conversationActions.openConversation(id)}
            onNewSession={() => void conversationActions.newChatSession()}
            onNewProjectSession={(projectRepoPath) => void conversationActions.newProjectSession(projectRepoPath)}
            onArchive={(id) => void chatActions.setChatArchived(id, true)}
            onUnarchive={(id) => void chatActions.setChatArchived(id, false)}
            onOpenSettings={() => openSettingsSection(state.activeSettingsSection)}
            onToggleSidebar={() => state.setSidebarCollapsed(true)}
          />
        )
      }
      topBar={state.sidebarMode === "settings" ? null : <TopBar leading={topBarLeading} title={topBarTitle} actions={topBarActions} className={isNewChatScreen ? "new-chat-topbar" : undefined} />}
    >
      <AppNotices
        error={state.error}
        warnings={view.visibleWarnings}
        warningScope={view.warningScope}
        conversationId={state.conversation?.id}
        setError={(value) => state.setError(value)}
        setWarnings={state.setWarnings}
        setDismissedWarningKeysByScope={state.setDismissedWarningKeysByScope}
      />

      {view.activeChatConversation && (
        <ChatAccordLauncherDialog
          open={accordDialogOpen}
          participants={accordEligibleParticipants}
          disabled={!canStartAccord}
          participantRoleLabel={(participant) => chatRoleLabel(state.settings.chatRoleConfigs, participant)}
          onOpenChange={setAccordDialogOpen}
          onStart={chatActions.startChatAccord}
        />
      )}

      {state.sidebarMode === "settings" ? (
        <SettingsView
          section={state.activeSettingsSection}
          settings={state.settings}
          agents={state.agents}
          updateProvider={settingsActions.updateProvider}
          saveChatRoleConfig={settingsActions.saveChatRoleConfig}
          archiveChatRoleConfig={settingsActions.archiveChatRoleConfig}
          saveChatBehaviorRuleConfig={settingsActions.saveChatBehaviorRuleConfig}
          deleteChatBehaviorRuleConfig={settingsActions.deleteChatBehaviorRuleConfig}
          saveChatSavedPromptConfig={settingsActions.saveChatSavedPromptConfig}
          deleteChatSavedPromptConfig={settingsActions.deleteChatSavedPromptConfig}
          saveChatParticipantConfig={settingsActions.saveChatParticipantConfig}
          deleteChatParticipantConfig={settingsActions.deleteChatParticipantConfig}
          setRepoFileOpenPreference={settingsActions.setRepoFileOpenPreference}
          setCliAgentRunTimeoutMs={settingsActions.setCliAgentRunTimeoutMs}
          setChatParticipantRequestMaxDepth={settingsActions.setChatParticipantRequestMaxDepth}
          setChatParticipantRequestPromptMaxChars={settingsActions.setChatParticipantRequestPromptMaxChars}
          setChatAutoWatchWakeLimit={settingsActions.setChatAutoWatchWakeLimit}
          setChatPromptContext={settingsActions.setChatPromptContext}
          saveCloudRunsSettings={settingsActions.saveCloudRunsSettings}
          getAgentEnvironment={settingsActions.getAgentEnvironment}
          saveAgentEnvironmentVariable={settingsActions.saveAgentEnvironmentVariable}
          deleteAgentEnvironmentVariable={settingsActions.deleteAgentEnvironmentVariable}
          sidebarCollapsed={state.sidebarCollapsed}
          onExpandSidebar={() => state.setSidebarCollapsed(false)}
          onClose={closeSettings}
        />
      ) : state.initializing ? (
        <div className="content-area compose-layout">
          <AppLoadingState />
        </div>
      ) : (
        <div className={`content-area ${view.hasResultContext ? "result-layout" : "compose-layout"}`}>
          {!view.hasResultContext && (
            <section className="composer new-chat-composer">
              <NewChatScreen
                prompt={state.question}
                repoPath={state.repoPath}
                repoInfo={state.repoInfo}
                selectedParticipantIds={state.selectedChatParticipantConfigIds}
                selectedParticipantRunLocations={state.selectedChatParticipantRunLocations}
                settings={state.settings}
                agents={state.agents}
                busy={state.busy}
                renderParticipantAvatar={(participant) => <Avatar className="mini-avatar" spec={avatarForChatParticipant(participant)} />}
                participantRoleLabel={(participant) => chatRoleLabel(state.settings.chatRoleConfigs, participant)}
                onPromptChange={state.setQuestion}
                onRepoPathChange={(value) => {
                  state.setRepoPath(value);
                  state.setRepoInfo(undefined);
                }}
                onRepoBlur={(path) => void conversationActions.inspectRepo(path)}
                onSelectRepo={() => void conversationActions.selectRepo()}
                onSelectedParticipantIdsChange={conversationActions.updateSelectedChatParticipantConfigIds}
                onSelectedParticipantRunLocationsChange={state.setSelectedChatParticipantRunLocations}
                onOpenParticipantsSettings={() => openSettingsSection("participants")}
                onStart={(repoFileMentions, imageAttachments, skillMentions) => chatActions.startChat({ repoFileMentions, imageAttachments, skillMentions })}
              />
            </section>
          )}

          {view.hasResultContext && (
            <section className={`conversation-panel ${view.conversationKind === "chat" ? "chat-conversation-panel" : ""}`}>
              {view.isOpeningConversation ? (
                <AppLoadingState title="Loading chat" description={openingConversationDescription} />
              ) : view.conversationKind === "chat" && state.conversation ? (
                <ChatConversationView
                  conversation={state.conversation}
                  settings={state.settings}
                  progress={view.visibleProgressLog}
                  isRunning={view.conversationRunning}
                  participantStatusById={view.participantStatusById}
                  hasOlderMessages={Boolean(state.messagePage?.hasMoreBefore)}
                  olderMessagesLoading={state.olderMessagesLoading}
                  draft={state.chatMessageDraft}
                  onDraftChange={state.setChatMessageDraft}
                  onLoadOlderMessages={() => void conversationActions.loadOlderConversationMessages()}
                  onLoadMessagePageForMessage={conversationActions.loadConversationMessagePageForMessage}
                  messageFocusRequest={state.chatMessageFocusRequest}
                  onSend={(repoFileMentions, imageAttachments, skillMentions) => chatActions.sendChatMessage({ repoFileMentions, imageAttachments, skillMentions })}
                  accordDisabledReason={accordDisabledReason}
                  onOpenAccord={() => setAccordDialogOpen(true)}
                  onSendThread={(rootMessage, content, repoFileMentions, imageAttachments, skillMentions) => chatActions.sendChatMessage({
                    content,
                    skillMentions,
                    repoFileMentions,
                    imageAttachments,
                    threadId: rootMessage.metadata?.threadId ?? rootMessage.id,
                    parentMessageId: rootMessage.id,
                    chatThreadRootId: rootMessage.id
                  })}
                  onApproveMentions={(sourceMessageId, targetParticipantIds, continueRequester) =>
                    void chatActions.respondToChatMentions(sourceMessageId, targetParticipantIds, true, continueRequester)
                  }
                  onRejectMentions={(sourceMessageId, targetParticipantIds) =>
                    void chatActions.respondToChatMentions(sourceMessageId, targetParticipantIds, false)
                  }
                  onRespondToChoice={(sourceMessageId, choiceId, response) => chatActions.respondToChatChoice(sourceMessageId, choiceId, response)}
                  onToggleReaction={(messageId, emoji) => void chatActions.toggleChatReaction(messageId, emoji)}
                  onRespondToAppToolApproval={chatActions.respondToChatAppToolApproval}
                  setRepoFileOpenPreference={settingsActions.setRepoFileOpenPreference}
                  onCompactParticipant={(participantId) => chatActions.compactChatParticipant(participantId)}
                  onStopRun={(runId) => void window.consensus.cancelReview(runId)}
                />
              ) : (
                <SlackView
                  conversation={state.conversation}
                  progress={view.visibleProgressLog}
                  kind={view.conversationKind}
                  isRunning={view.conversationRunning}
                  hasOlderMessages={Boolean(state.messagePage?.hasMoreBefore)}
                  olderMessagesLoading={state.olderMessagesLoading}
                  onLoadOlderMessages={() => void conversationActions.loadOlderConversationMessages()}
                  selectedThreadId={state.selectedThreadId}
                  focusedThreadId={state.focusedThreadId}
                  onSelectThread={(id) => {
                    state.setSelectedThreadId(id);
                    if (!id) state.setFocusedThreadId(undefined);
                  }}
                  onFocusThread={(id) => {
                    state.setSelectedThreadId(id);
                    state.setFocusedThreadId(id);
                  }}
                  onExitFocus={() => state.setFocusedThreadId(undefined)}
                  onCloseThread={() => {
                    state.setSelectedThreadId(undefined);
                    state.setFocusedThreadId(undefined);
                  }}
                  pendingDecisions={view.pendingDecisions}
                  decisionReplies={[...planDecisionReplies(state.conversation), ...Object.values(state.pendingClarifications)]}
                  decisionAnswers={view.visibleDecisionAnswers}
                  decisionResolutions={view.visibleDecisionResolutions}
                  clarificationDrafts={state.clarificationDrafts}
                  planItemReviewDrafts={state.planItemReviewDrafts}
                  planCorrectionDraft={state.planCorrectionDraft}
                  canComposePlan={view.canComposePlan}
                  reviewedPlanItemCount={view.reviewedPlanItemCount}
                  reviewablePlanItemCount={view.reviewablePlanItems.length}
                  canRecoverPlan={view.canRecoverPlan}
                  onDecisionAnswer={(decisionId, optionId) => void reviewDecisionActions.selectDecisionAnswer(decisionId, optionId)}
                  onResolveDecision={(decisionId) => void reviewDecisionActions.resolveDecisionThread(decisionId)}
                  onClarificationDraftChange={(decisionId, value) => state.setClarificationDrafts((current) => ({ ...current, [decisionId]: value }))}
                  onAskClarification={(decisionId) => void reviewDecisionActions.askDecisionClarification(decisionId)}
                  onPlanItemReviewDraftChange={(findingId, value) => state.setPlanItemReviewDrafts((current) => ({ ...current, [findingId]: value }))}
                  onConfirmPlanItem={(findingId) => void reviewDecisionActions.confirmPlanItem(findingId)}
                  onCommentPlanItem={(findingId) => void reviewDecisionActions.commentOnPlanItem(findingId)}
                  onPlanCorrectionDraftChange={state.setPlanCorrectionDraft}
                  onContinue={() => void reviewDecisionActions.continueReview()}
                  onComposePlan={() => void reviewPlanActions.composeImplementationPlan()}
                  onRetryFinalPlan={() => void reviewPlanActions.retryFinalPlanSynthesis()}
                  onRecoverPlan={() => void reviewPlanActions.recoverImplementationPlan()}
                  onRevisePlan={() => void reviewPlanActions.reviseImplementationPlan()}
                />
              )}
            </section>
          )}
        </div>
      )}
    </AppShell>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider>
      <TooltipProvider>
        <App />
        <Toaster richColors position="bottom-right" />
      </TooltipProvider>
    </ThemeProvider>
  </React.StrictMode>
);

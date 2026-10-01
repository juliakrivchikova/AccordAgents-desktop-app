import React from "react";
import { createRoot } from "react-dom/client";
import type {
  ChatActivityItem,
  ChatSkillMention,
  Conversation,
  PluginCatalogItem,
  StartReviewResult
} from "../shared/types";
import { ArrowLeft, ArrowRight, FileBox, RefreshCw, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { ModeToggle } from "./components/mode-toggle";
import { ThemeProvider } from "./components/theme-provider";
import { AppLoadingState } from "./components/loading-states";
import { AppShell, Sidebar, SidebarToggleButton, TopBar } from "./components/shell";
import { ActivityConversationTitle, ActivityView } from "./components/activity/activity-view";
import { SettingsView } from "./components/settings/settings-view";
import { SettingsSidebar } from "./components/settings/settings-sidebar";
import { ConversationPanel } from "./components/conversation/conversation-panel";
import { ChatParticipantMenu } from "./components/chat/chat-participant-menu";
import { useArtifacts } from "./components/artifacts/use-artifacts";
import { IconButton } from "./components/primitives";
import { ChatAccordLauncherDialog } from "./components/chat/chat-accord-launcher-dialog";
import { NewChatScreen } from "./components/chat/new-chat-screen";
import { ChatSearchModal } from "./components/search/chat-search-modal";
import { ChatTopBarTitle } from "./components/chat/chat-top-bar-title";
import { chatRoleLabel } from "./components/chat/chat-conversation-data";
import { avatarForChatParticipant } from "./components/chat/chat-avatars";
import { defaultChatParticipantDraft } from "./components/chat/chat-participant-drafts";
import type { DraftPluginMention } from "./components/chat/chat-composer-draft-utils";
import { Avatar } from "./components/avatar/avatar";
import { isChatAssistantParticipant } from "./components/conversation/conversation-display";
import { useAppState } from "./app/app-state";
import { useConversationActions } from "./app/use-conversation-actions";
import { useAppEffects } from "./app/use-app-effects";
import { useChatActions } from "./app/use-chat-actions";
import { useReviewDecisionActions } from "./app/use-review-decision-actions";
import { useReviewPlanActions } from "./app/use-review-plan-actions";
import { useSettingsActions } from "./app/use-settings-actions";
import { useAppViewModel } from "./app/use-app-view-model";
import { useCustomAvatarLibrary } from "./components/avatar/custom-avatars";
import { useChatSearch } from "./app/use-chat-search";
import { useChatSearchShortcut } from "./app/chat-search-shortcut";
import { useAppNavigation } from "./app/use-app-navigation";
import { AppNotices } from "./app/app-notices";
import { pluginNewChatDraft, pluginNewChatMentions } from "./app/plugin-new-chat";
import { clearActivityItem, markActivityItemRead } from "./app/activity-item-state";
import { errorText } from "./components/review/review-conversation-data";
import { isCodexActivityApprovalItem } from "../shared/chatActivity";
import { CHAT_SPLIT_WORKSPACE_MIN_WIDTH } from "./lib/chat-split-sizing";
import "./styles/app.css";
function App(): JSX.Element {
  const state = useAppState();
  // Drawn avatars live as files in userData; loading them here is what makes a
  // member's own picture appear in the timeline and the roster after a restart.
  useCustomAvatarLibrary(state.settings.chatCustomAvatars);
  const [searchOpen, setSearchOpen] = React.useState(false);
  // Not from Settings: a result would leave it and drop an unsaved edit.
  useChatSearchShortcut(() => {
    if (state.railView !== "settings") setSearchOpen(true);
  });
  const conversationActions = useConversationActions(state);
  const chatSearch = useChatSearch(searchOpen);
  const chatActions = useChatActions(state, conversationActions);
  const reviewDecisionActions = useReviewDecisionActions(state, conversationActions);
  const reviewPlanActions = useReviewPlanActions(state, conversationActions);
  const settingsActions = useSettingsActions(state);
  useAppEffects(
    state,
    conversationActions.refreshAll,
    conversationActions.refreshAgents,
    conversationActions.refreshActivity
  );
  const view = useAppViewModel(state);
  const artifacts = useArtifacts(state.conversation?.id);
  const activityUnreadCount = state.activityItems.reduce(
    (count, item) => count + (item.read || item.status === "running" ? 0 : 1),
    0
  );
  const [accordDialogOpen, setAccordDialogOpen] = React.useState(false);
  const [newChatPrefill, setNewChatPrefill] = React.useState<{
    key: number;
    prompt: string;
    pluginMentions: DraftPluginMention[];
    skillMentions: ChatSkillMention[];
  }>();

  const navigation = useAppNavigation(state, conversationActions);
  const { openSettingsSection } = navigation;
  // A control that hides itself (a sidebar toggle, Activity, Settings, Back)
  // hands focus to its counterpart, so the keyboard and VoiceOver keep their
  // place. Only after a keyboard press: after a mouse click the moved focus
  // would draw a focus ring nobody asked for.
  const focusAfterSwitch = (testId: string): void => {
    if (!(document.activeElement instanceof HTMLElement) || !document.activeElement.matches(":focus-visible")) {
      return;
    }
    window.requestAnimationFrame(() => {
      const target = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
      // A collapsed sidebar is inert; its expand toggle stands in for it.
      (target && !target.closest("[inert]") ? target : document.querySelector<HTMLElement>('[data-testid="sidebar-expand-toggle"]'))?.focus();
    });
  };
  const collapseSidebar = (): void => {
    state.setSidebarCollapsed(true);
    focusAfterSwitch("sidebar-expand-toggle");
  };
  const expandSidebar = (): void => {
    state.setSidebarCollapsed(false);
    focusAfterSwitch("sidebar-collapse-toggle");
  };
  const closeSettings = (): void => {
    navigation.returnToChats();
    focusAfterSwitch("sidebar-settings");
  };
  const tryPluginInNewChat = (plugin: PluginCatalogItem): void => {
    if (state.busy) {
      return;
    }
    const draft = pluginNewChatDraft(plugin);
    if (!draft.trim()) {
      return;
    }
    void conversationActions.newChatSession().then((started) => {
      if (!started) {
        return;
      }
      state.setQuestion(draft);
      const mentions = pluginNewChatMentions(plugin, draft);
      state.setNewChatPluginMentions(mentions.pluginMentions);
      state.setNewChatSkillMentions(mentions.skillMentions);
      setNewChatPrefill({
        key: Date.now(),
        prompt: draft,
        ...mentions
      });
      state.setRailView("chats");
      state.setSidebarCollapsed(false);
    });
  };

  const applyActivityCancelResult = async (item: ChatActivityItem, conversation?: Conversation, warnings?: string[]): Promise<void> => {
    if (conversation && state.conversation?.id === conversation.id) {
      state.setConversation(conversation);
    }
    if (warnings) {
      state.setWarnings(warnings);
    }
    state.setSelectedActivityItem((current) => current?.id === item.id ? undefined : current);
    await conversationActions.refreshConversations();
    await conversationActions.refreshActivity();
  };

  const cancelPendingActivityItem = async (item: ChatActivityItem): Promise<void> => {
    if (item.status !== "pending") {
      return;
    }
    state.setError(undefined);
    try {
      if (item.kind === "approval" && item.target.approvalId) {
        if (isCodexActivityApprovalItem(item)) {
          throw new Error("Open this Codex approval in chat and select one of its offered decisions.");
        }
        const conversation = await window.consensus.respondToChatAppToolApproval({
          conversationId: item.conversationId,
          approvalId: item.target.approvalId,
          approve: false
        });
        await applyActivityCancelResult(item, conversation);
        return;
      }
      const sourceMessageId = item.target.sourceMessageId ?? item.target.messageId;
      if (item.kind === "choice" && sourceMessageId && item.target.choiceId) {
        const result: StartReviewResult = await window.consensus.respondToChatChoice({
          conversationId: item.conversationId,
          sourceMessageId,
          choiceId: item.target.choiceId,
          cancel: true,
          runId: crypto.randomUUID()
        });
        await applyActivityCancelResult(item, result.conversation, result.warnings);
        return;
      }
      if (item.kind === "mention" && sourceMessageId && item.target.mentionTargetParticipantIds?.length) {
        const result: StartReviewResult = await window.consensus.respondToChatMentions({
          conversationId: item.conversationId,
          sourceMessageId,
          targetParticipantIds: item.target.mentionTargetParticipantIds,
          approve: false,
          runId: crypto.randomUUID()
        });
        await applyActivityCancelResult(item, result.conversation, result.warnings);
        return;
      }
      throw new Error("This activity item cannot be cancelled from the Activity list.");
    } catch (caught) {
      state.setError(errorText(caught));
    }
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
  const topBarLeading = state.railView === "chats" && state.sidebarCollapsed ? (
    <SidebarToggleButton expanded={false} onToggle={expandSidebar} />
  ) : undefined;
  const windowActions = (
    <>
      <ModeToggle />
      <IconButton
        label="Refresh"
        icon={RefreshCw}
        onClick={() => void (async () => {
          await conversationActions.refreshAll();
          if (state.railView === "activity") {
            await conversationActions.refreshActivity();
          }
        })()}
      />
    </>
  );
  const accordEligibleParticipants = React.useMemo(
    () => view.activeChatParticipants.filter((participant) => !isChatAssistantParticipant(participant)),
    [view.activeChatParticipants]
  );
  const accordDisabledReason = !view.activeChatConversation
    ? "Open a chat to start Accord."
    : view.activeChatConversation.metadata.archived === true
      ? "Archived chats cannot start Accord."
      : accordEligibleParticipants.length < 2
          ? "Add at least two members to start Accord."
          : undefined;
  const canStartAccord = Boolean(view.activeChatConversation && !accordDisabledReason);
  const topBarActions = isNewChatScreen ? undefined : (
    <>
      {state.busy && (
        <Button variant="outline" size="sm" onClick={() => void conversationActions.cancelReview()}>
          <XCircle aria-hidden />
          Stop
        </Button>
      )}
      {view.activeChatConversation && (
        <>
          <IconButton
            label="Artifacts"
            icon={FileBox}
            data-artifacts-trigger="true"
            pressed={artifacts.panelOpen}
            onClick={() => (artifacts.panelOpen ? artifacts.closePanel() : artifacts.openPanel())}
            tooltip="Artifacts — durable shared documents (plans, QA cases, decisions) with versions and sign-off"
          />
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
            onAddSavedParticipant={(participant) => void chatActions.addSavedChatParticipant(participant)}
            onUpdateParticipantRuntime={(participantId, patch) => chatActions.updateChatParticipantRuntime(participantId, patch)}
            onCompactParticipant={(participantId) => void chatActions.compactChatParticipant(participantId)}
            onRemoveParticipant={(participantId) => void chatActions.removeChatParticipant(participantId)}
            onJumpToParticipantLastMessage={conversationActions.jumpToParticipantLastMessage}
            onManageInSettings={() => openSettingsSection("participants")}
          />
        </>
      )}
    </>
  );
  const chatUsesInlineTopBar = state.railView === "chats" && Boolean(view.activeChatConversation);
  const openActivityItemInChat = (item: ChatActivityItem): void => {
    state.setRailView("chats");
    state.setSidebarCollapsed(false);
    state.setSelectedActivityItem(undefined);
    void conversationActions.openConversationAndFocusActivityItem(item, { timelineOnly: true });
  };
  // In Activity a previewed chat gets the same top row as in Chats, so a thread
  // or artifacts panel beside it lines up with that row. Only once the
  // selected item's own chat is loaded; until then the Activity pane keeps its
  // header. The item is the refreshed one, so its target is current.
  const selectedActivityId = state.selectedActivityItem?.id;
  const activityPreviewItem = state.railView === "activity" && selectedActivityId && !state.openingConversationId
    && view.activeChatConversation?.id === state.selectedActivityItem?.conversationId
    ? state.activityItems.find((item) => item.id === selectedActivityId) ?? state.selectedActivityItem
    : undefined;
  const activityTopBar = activityPreviewItem && view.activeChatConversation ? (
    <TopBar
      className="pr-4 border-[var(--app-border-subtle)]"
      title={<ActivityConversationTitle title={view.activeChatConversation.title} />}
      actions={<IconButton label="Open in chat" icon={ArrowRight} onClick={() => openActivityItemInChat(activityPreviewItem)} />}
    />
  ) : undefined;
  const chatTopBar = <TopBar leading={topBarLeading} title={topBarTitle} actions={topBarActions} className={isNewChatScreen ? "new-chat-topbar" : undefined} />;
  const conversationPanel = view.hasResultContext ? (
    <ConversationPanel
      state={state}
      view={view}
      conversationActions={conversationActions}
      chatActions={chatActions}
      reviewDecisionActions={reviewDecisionActions}
      reviewPlanActions={reviewPlanActions}
      settingsActions={settingsActions}
      openingConversationDescription={openingConversationDescription}
      accordDisabledReason={accordDisabledReason}
      onOpenAccord={() => setAccordDialogOpen(true)}
      topBar={chatUsesInlineTopBar ? chatTopBar : activityTopBar}
      artifacts={artifacts}
    />
  ) : undefined;
  const shellTopBar = state.railView === "settings" || state.railView === "activity" || chatUsesInlineTopBar
    ? null
    : chatTopBar;

  return (
    <AppShell
      sidebarCollapsed={state.sidebarCollapsed}
      // Activity takes the sidebar's place, the way Settings does.
      sidebarHidden={state.railView === "activity"}
      sidebarWidth={state.sidebarWidth}
      onSidebarWidthChange={state.setSidebarWidth}
      minWorkspaceWidth={view.hasResultContext ? CHAT_SPLIT_WORKSPACE_MIN_WIDTH : undefined}
      className={isNewChatScreen ? "is-new-chat-screen" : undefined}
      sidebar={
        state.railView === "settings" ? (
          <SettingsSidebar
            section={state.activeSettingsSection}
            onSectionChange={state.setActiveSettingsSection}
            onBackToChats={closeSettings}
            onToggleSidebar={collapseSidebar}
            footerActions={windowActions}
          />
        ) : (
          <Sidebar
            projectGroups={view.projectSessionGroups}
            archivedSessions={view.archivedSessions}
            activeId={state.conversation?.id}
            pendingId={state.openingConversationId}
            activityUnreadCount={activityUnreadCount}
            busy={state.busy}
            loading={state.historyLoading}
            unreadIds={state.unreadConversationIds}
            onOpenSearch={() => setSearchOpen(true)}
            onOpenActivity={() => {
              navigation.showView("activity");
              focusAfterSwitch("activity-back-to-chats");
            }}
            onOpenSettings={() => {
              navigation.showView("settings");
              focusAfterSwitch("settings-back-to-chats");
            }}
            onSelect={navigation.openChat}
            onNewSession={() => void conversationActions.newChatSession()}
            onNewProjectSession={(projectRepoPath) => void conversationActions.newProjectSession(projectRepoPath)}
            onArchive={(id) => void chatActions.setChatArchived(id, true)}
            onUnarchive={(id) => void chatActions.setChatArchived(id, false)}
            onDelete={(id) => chatActions.deleteChatConversation(id)}
            onToggleSidebar={collapseSidebar}
            footerActions={windowActions}
          />
        )
      }
      topBar={shellTopBar}
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

      <ChatSearchModal
        open={searchOpen}
        query={chatSearch.query}
        loading={chatSearch.loading}
        loadingMore={chatSearch.loadingMore}
        response={chatSearch.response}
        onOpenChange={setSearchOpen}
        onQueryChange={chatSearch.setQuery}
        onClear={chatSearch.clear}
        onLoadMore={chatSearch.loadMore}
        onOpenConversation={navigation.openChat}
        onOpenMessage={navigation.openChatMessage}
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

      {state.railView === "settings" ? (
        <SettingsView
          section={state.activeSettingsSection}
          settings={state.settings}
          agents={state.agents}
          updateProvider={settingsActions.updateProvider}
          setAssistantProviderKind={settingsActions.setAssistantProviderKind}
          saveChatRoleConfig={settingsActions.saveChatRoleConfig}
          archiveChatRoleConfig={settingsActions.archiveChatRoleConfig}
          saveChatBehaviorRuleConfig={settingsActions.saveChatBehaviorRuleConfig}
          deleteChatBehaviorRuleConfig={settingsActions.deleteChatBehaviorRuleConfig}
          saveChatSavedPromptConfig={settingsActions.saveChatSavedPromptConfig}
          deleteChatSavedPromptConfig={settingsActions.deleteChatSavedPromptConfig}
          saveChatParticipantConfig={settingsActions.saveChatParticipantConfig}
          deleteChatParticipantConfig={settingsActions.deleteChatParticipantConfig}
          saveCliProviderHost={settingsActions.saveCliProviderHost}
          deleteCliProviderHost={settingsActions.deleteCliProviderHost}
          setRepoFileOpenPreference={settingsActions.setRepoFileOpenPreference}
          setBetaUpdates={settingsActions.setBetaUpdates}
          setCliAgentRunTimeoutMs={settingsActions.setCliAgentRunTimeoutMs}
          setChatParticipantRequestMaxDepth={settingsActions.setChatParticipantRequestMaxDepth}
          setChatParticipantRequestPromptMaxChars={settingsActions.setChatParticipantRequestPromptMaxChars}
          setChatAutoWatchWakeLimit={settingsActions.setChatAutoWatchWakeLimit}
          setChatPromptContext={settingsActions.setChatPromptContext}
          saveCloudRunsSettings={settingsActions.saveCloudRunsSettings}
          getAgentEnvironment={settingsActions.getAgentEnvironment}
          saveAgentEnvironmentVariable={settingsActions.saveAgentEnvironmentVariable}
          deleteAgentEnvironmentVariable={settingsActions.deleteAgentEnvironmentVariable}
          onTryPluginInChat={tryPluginInNewChat}
          sidebarCollapsed={state.sidebarCollapsed}
          onExpandSidebar={expandSidebar}
          onClose={closeSettings}
        />
      ) : state.railView === "activity" ? (
        <ActivityView
          leading={(
            <IconButton
              label="Back to chats"
              icon={ArrowLeft}
              data-testid="activity-back-to-chats"
              onClick={() => {
                navigation.leaveActivity();
                focusAfterSwitch("sidebar-activity");
              }}
            />
          )}
          trailing={windowActions}
          items={state.activityItems}
          selectedItem={state.selectedActivityItem}
          loading={state.activityLoading}
          error={state.activityError}
          detailError={state.activityFocusError}
          onDismissDetailError={() => state.setActivityFocusError(undefined)}
          detail={<div className="content-area result-layout activity-conversation-content">
            {conversationPanel ?? <AppLoadingState title="Loading chat" description={openingConversationDescription} />}
          </div>}
          onSelect={(item) => {
            if (isCodexActivityApprovalItem(item)) {
              state.setRailView("chats");
              state.setSidebarCollapsed(false);
              state.setSelectedActivityItem(undefined);
              window.requestAnimationFrame(() => {
                void conversationActions.openConversationAndFocusActivityItem(item);
              });
              return;
            }
            // Selecting an activity item never marks anything read: unread state only
            // clears through the explicit "Mark read" action (or by opening the chat
            // itself in the chats view). markViewed: false keeps the detail open from
            // blanket-marking the conversation's items as viewed.
            state.setSelectedActivityItem(item);
            void conversationActions.openConversationAndFocusActivityItem(item, { markViewed: false });
          }}
          onMarkRead={(item) => markActivityItemRead(state, item.id)}
          onCancelPending={(item) => void cancelPendingActivityItem(item)}
          onClear={(item) => clearActivityItem(state, item.id)}
          detailHasHeader={Boolean(activityTopBar && conversationPanel)}
          onOpenInChat={openActivityItemInChat}
          onRetry={() => void conversationActions.refreshActivity()}
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
                pendingImages={state.newChatPendingImages}
                selectedFileMentions={state.newChatRepoFileMentions}
                selectedPluginMentions={state.newChatPluginMentions}
                selectedSkillMentions={state.newChatSkillMentions}
                repoPath={state.repoPath}
                repoInfo={state.repoInfo}
                selectedParticipantIds={state.selectedChatParticipantConfigIds}
                selectedParticipantRuntimeOverrides={state.selectedChatParticipantRuntimeOverrides}
                settings={state.settings}
                summaries={state.summaries}
                agents={state.agents}
                initialPluginMentions={newChatPrefill?.pluginMentions}
                initialSkillMentions={newChatPrefill?.skillMentions}
                prefillPrompt={newChatPrefill?.prompt}
                prefillRequestKey={newChatPrefill?.key}
                busy={state.busy}
                renderParticipantAvatar={(participant) => <Avatar className="mini-avatar" spec={avatarForChatParticipant(participant)} />}
                participantRoleLabel={(participant) => chatRoleLabel(state.settings.chatRoleConfigs, participant)}
                onPromptChange={state.setQuestion}
                onPendingImagesChange={state.setNewChatPendingImages}
                onSelectedFileMentionsChange={state.setNewChatRepoFileMentions}
                onSelectedPluginMentionsChange={state.setNewChatPluginMentions}
                onSelectedSkillMentionsChange={state.setNewChatSkillMentions}
                onRepoPathChange={(value) => {
                  state.setRepoPath(value);
                  state.setRepoInfo(undefined);
                }}
                onRepoBlur={(path) => void conversationActions.inspectRepo(path)}
                onSelectRepo={() => void conversationActions.selectRepo()}
                onSelectedParticipantIdsChange={conversationActions.updateSelectedChatParticipantConfigIds}
                onSelectedParticipantRuntimeOverridesChange={state.setSelectedChatParticipantRuntimeOverrides}
                onOpenParticipantsSettings={() => openSettingsSection("participants")}
                onOpenProviderSettings={() => openSettingsSection("general")}
                onRefreshAgents={() => conversationActions.refreshAgents({ force: true, trigger: "manual" })}
                onStart={(repoFileMentions, imageAttachments, skillMentions) => chatActions.startChat({ repoFileMentions, imageAttachments, skillMentions })}
              />
            </section>
          )}

          {conversationPanel}
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

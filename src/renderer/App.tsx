import React from "react";
import { createRoot } from "react-dom/client";
import { startRendererCrashReporting } from "./app/crash-reporting";
import type {
  ChatActivityItem,
  ChatParticipant,
  ChatSkillMention,
  Conversation,
  PluginCatalogItem,
  StartReviewResult
} from "../shared/types";
import { ArrowLeftIcon, ArrowRightIcon, FilesIcon, IconContext, TerminalWindowIcon, XCircleIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { ModeToggle } from "./components/mode-toggle";
import { ThemeProvider } from "./components/theme-provider";
import { AppLoadingState } from "./components/loading-states";
import { LoadingBar } from "@/components/ui/loading-bar";
import { AppShell, Sidebar, SidebarToggleButton, TopBar } from "./components/shell";
import { ActivityConversationTitle, ActivityView } from "./components/activity/activity-view";
import { SettingsView } from "./components/settings/settings-view";
import { SettingsSidebar } from "./components/settings/settings-sidebar";
import { ConversationPanel } from "./components/conversation/conversation-panel";
import { ChatParticipantMenu } from "./components/chat/chat-participant-menu";
import { useArtifacts } from "./components/artifacts/use-artifacts";
import { useFileEditLifecycle } from "./app/use-file-edit-lifecycle";
import { IconButton } from "./components/primitives";
import { ChatAccordLauncherDialog } from "./components/chat/chat-accord-launcher-dialog";
import { NewChatScreen } from "./components/chat/new-chat-screen";
import { ChatSearchModal } from "./components/search/chat-search-modal";
import { CliImportDialog } from "./components/cli-import/cli-import-dialog";
import { ChatTopBarTitle } from "./components/chat/chat-top-bar-title";
import { ChatClassicOnly, ChatViewHeaderControls } from "./components/chat/chat-view-switch";
import { sessionsViewNamesOf } from "../shared/sessionsViewText";
import { sessionsMemberSettings } from "./app/sessions-member-settings";
import { forkToNewChatReasonFor, useMachineForkSupport } from "./components/chat/use-fork-to-new-chat";
import { renderNewChatMemberMark } from "./components/chat/chat-member-mark";
import { chatViewFor } from "../shared/mainSession";
import { accordCandidates, accordLaunch } from "../shared/accordCandidates";
import { chatRoleLabel } from "./components/chat/chat-conversation-data";
import { defaultChatParticipantDraft } from "./components/chat/chat-participant-drafts";
import type { DraftPluginMention } from "./components/chat/chat-composer-draft-utils";
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
import { DictationHoldKey } from "./components/chat/dictation-hold-key";
import { pluginNewChatDraft, pluginNewChatMentions } from "./app/plugin-new-chat";
import { clearActivityItem, markActivityItemRead } from "./app/activity-item-state";
import { errorText } from "./components/review/review-conversation-data";
import { isCodexActivityApprovalItem } from "../shared/chatActivity";
import { CHAT_SPLIT_WORKSPACE_MIN_WIDTH } from "./lib/chat-split-sizing";
import { ChatBackgroundTasksContext } from "./components/chat/chat-roster-status";
import { UrgentAlertActionsContext } from "./components/chat/urgent-alert-context";
import { SubagentProvidersContext, type SubagentProvidersActions } from "./components/chat/subagent-providers-context";
import { restartingMembers } from "../shared/memberRestart";
import { TerminalPanel } from "./components/terminal/terminal-panel";
import { useTerminalPanel } from "./components/terminal/use-terminal-panel";
import { chatCreationStatus } from "./components/chat/chat-creation-state";
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
  const machineForkSupport = useMachineForkSupport();
  const artifacts = useArtifacts(state.conversation?.id);
  // A new terminal opens in the project of the chat in view, or of the new
  // chat being set up; with neither, in the home folder.
  const terminal = useTerminalPanel(
    view.activeChatConversation?.repoPath ?? (!state.initializing && !view.hasResultContext ? state.repoPath : undefined)
  );
  const activityUnreadCount = state.activityItems.reduce(
    (count, item) => count + (item.read || item.status === "running" ? 0 : 1),
    0
  );
  const [accordDialogOpen, setAccordDialogOpen] = React.useState(false);
  // The Accord dialog's names in the sessions view, read while it is open.
  const accordChat = view.activeChatConversation;
  const accordDialogNames = React.useMemo(
    () => (accordDialogOpen && accordChat ? sessionsViewNamesOf(accordChat) : undefined),
    [accordDialogOpen, accordChat?.messages, accordChat?.metadata]
  );
  const [newChatPrefill, setNewChatPrefill] = React.useState<{
    key: number;
    prompt: string;
    pluginMentions: DraftPluginMention[];
    skillMentions: ChatSkillMention[];
  }>();

  const navigation = useAppNavigation(state, conversationActions);
  useFileEditLifecycle({ conversationId: state.conversation?.id, artifacts, openChat: navigation.openChat });
  // Fork to new chat: a fork made after she went to another chat or screen
  // is opened from its notice as the sidebar opens a chat, as navigation
  // stands when she clicks it.
  const openChatRef = React.useRef(navigation.openChat);
  openChatRef.current = navigation.openChat;
  const forkToNewChat = (participantId: string): void => {
    void chatActions.forkChatParticipantToNewChat(participantId, { openChat: (conversationId) => openChatRef.current(conversationId) });
  };
  const { openSettingsSection } = navigation;
  // The side panel's Agents (sub-agent providers): the CLIs found here and the
  // change, through a ref so the context changes only with what it shows.
  const updateSubagentsRef = React.useRef(chatActions.updateChatSubagentProviders);
  updateSubagentsRef.current = chatActions.updateChatSubagentProviders;
  const subagentActions = React.useMemo<SubagentProvidersActions>(() => ({
    agents: state.agents,
    providers: state.settings.providers,
    update: (scope, change) => updateSubagentsRef.current(scope, change),
    openSetup: () => openSettingsSection("general")
  }), [state.agents, state.settings.providers, openSettingsSection]);
  const urgentAlertActions = React.useMemo(() => ({
    openAlertSettings: () => openSettingsSection("alerts"),
    openServerSettings: () => openSettingsSection("aws")
  }), [openSettingsSection]);
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

  // Pending rows whose Cancel is on its way: the row says so at once and cannot
  // be cancelled twice while the answer is applied.
  const [cancellingActivityItemIds, setCancellingActivityItemIds] = React.useState<ReadonlySet<string>>(() => new Set());
  const cancellingActivityItemIdsRef = React.useRef(new Set<string>());
  const setActivityItemCancelling = (itemId: string, cancelling: boolean): void => {
    const next = new Set(cancellingActivityItemIdsRef.current);
    if (cancelling) next.add(itemId); else next.delete(itemId);
    cancellingActivityItemIdsRef.current = next;
    setCancellingActivityItemIds(next);
  };

  const applyActivityCancelResult = async (item: ChatActivityItem, conversation?: Conversation, warnings?: string[]): Promise<void> => {
    // The answer can land after the User moved to another chat or preview; it
    // updates its own chat only if that is still the one loaded.
    if (conversation) {
      state.setConversation((current) => current?.id === conversation.id ? conversation : current);
    }
    // Only real warnings: an empty list would wipe those of the chat on screen.
    if (warnings?.length) {
      state.setWarnings(warnings);
    }
    // Answered: the row leaves Pending now, not after the lists are re-read.
    state.setActivityItems((items) => items.filter((candidate) => candidate.id !== item.id));
    state.setSelectedActivityItem((current) => current?.id === item.id ? undefined : current);
    await Promise.all([conversationActions.refreshConversations(), conversationActions.refreshActivity()]);
  };

  const cancelPendingActivityItem = async (item: ChatActivityItem): Promise<void> => {
    if (item.status !== "pending" || cancellingActivityItemIdsRef.current.has(item.id)) {
      return;
    }
    state.setError(undefined);
    setActivityItemCancelling(item.id, true);
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
    } finally {
      setActivityItemCancelling(item.id, false);
    }
  };

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
      : "New chat";
  const topBarLeading = state.railView === "chats" && state.sidebarCollapsed ? (
    <SidebarToggleButton expanded={false} onToggle={expandSidebar} />
  ) : undefined;
  const windowActions = <ModeToggle />;
  const accordEligibleParticipants = React.useMemo(
    () => view.activeChatParticipants.filter((participant) => !isChatAssistantParticipant(participant)),
    [view.activeChatParticipants]
  );
  // In a chat with a main session the CLIs of its Agents list count too: each
  // without a member yet gets one as the Accord starts.
  const accordAgents = accordChat ? accordCandidates(accordEligibleParticipants, accordChat, state.settings.subagentProvidersByProject).providers : [];
  const accordState = accordChat ? accordLaunch({ members: accordEligibleParticipants, providers: accordAgents }, accordChat) : undefined;
  const accordDisabledReason = !accordState
    ? "Open a chat to start Accord."
    : accordState.kind === "disabled" ? accordState.reason : undefined;
  const canStartAccord = accordState?.kind === "ready";
  const terminalToggle = (
    <IconButton
      label="Terminal"
      icon={TerminalWindowIcon}
      data-testid="terminal-toggle"
      pressed={terminal.open}
      onClick={terminal.toggle}
      tooltip="Terminal (Ctrl+`)"
    />
  );
  // Fork to new chat (src/shared/forkToNewChat.ts): why a member of the open
  // chat cannot be copied into a new chat's main session now.
  const forkToNewChatReason = (participant: ChatParticipant): string | undefined => view.activeChatConversation
    ? forkToNewChatReasonFor(participant, view.activeChatConversation, state.agents, state.settings, machineForkSupport)
    : "Open its chat first.";
  // The chat's members and their settings: the roster in the classic view's
  // header (the sessions view has a member's controls under its composer and
  // its … actions instead: sessionsMemberSettings).
  const rosterMenu = (memberId?: string, trigger?: React.ReactNode): JSX.Element | null => view.activeChatConversation ? (
    <ChatParticipantMenu
      participants={view.activeChatParticipants}
      participantHasRunById={view.participantHasRunById}
      settings={state.settings}
      agents={state.agents}
      draft={state.chatMessageDraft}
      addParticipantDraft={state.chatAddParticipantDraft ?? defaultChatParticipantDraft(state.settings)}
      busyParticipantIds={view.busyParticipantIds}
      participantStatusById={view.participantStatusById}
      participantWatchers={view.activeChatConversation.metadata.participantWatchers}
      onDraftChange={state.setChatMessageDraft}
      onAddParticipantDraftChange={state.setChatAddParticipantDraft}
      onAddParticipant={() => void chatActions.addChatParticipant()}
      onAddSavedParticipant={(participant) => void chatActions.addSavedChatParticipant(participant)}
      onUpdateParticipantRuntime={(participantId, patch) => chatActions.updateChatParticipantRuntime(participantId, patch)}
      onCompactParticipant={(participantId) => void chatActions.compactChatParticipant(participantId)}
      onRestartParticipant={(participantId, stopBackgroundTasks) => chatActions.restartChatParticipant(participantId, stopBackgroundTasks)}
      onStopRestart={(runId) => void window.consensus.cancelReview(runId)}
      restartingById={restartingMembers(state.progressLog)}
      onRemoveParticipant={(participantId) => void chatActions.removeChatParticipant(participantId)}
      onForkToNewChat={forkToNewChat}
      forkToNewChatReason={forkToNewChatReason}
      onJumpToParticipantLastMessage={conversationActions.jumpToParticipantLastMessage}
      onManageInSettings={() => openSettingsSection("participants")}
      memberId={memberId}
      trigger={trigger}
    />
  ) : null;
  // The sessions view's settings of one member: controls under its composer,
  // its … actions in its session's header, the main session's in the title's menu.
  const sessionsMember = sessionsMemberSettings({ view, progressLog: state.progressLog, chatActions, forkToNewChat, forkToNewChatReason });
  const topBarActions = isNewChatScreen ? terminalToggle : (
    <>
      {/* The open chat's view switch and members button (its chat view provides them). */}
      <ChatViewHeaderControls />
      {terminalToggle}
      {state.busy && (
        <Button variant="outline" size="sm" onClick={() => void conversationActions.cancelReview()}>
          <XCircleIcon aria-hidden />
          Stop
        </Button>
      )}
      {view.activeChatConversation && (
        <>
          <IconButton
            label="Artifacts"
            icon={FilesIcon}
            data-artifacts-trigger="true"
            pressed={artifacts.panelOpen && !artifacts.fileTarget}
            // While a file is shown, the button switches the panel to artifacts.
            onClick={() => (artifacts.panelOpen && !artifacts.fileTarget ? artifacts.closePanel() : artifacts.openPanel())}
            tooltip="Artifacts — durable shared documents (plans, QA cases, decisions) with versions and sign-off"
          />
          {/* The sessions view has one side panel instead (its own control). */}
          <ChatClassicOnly>{rosterMenu()}</ChatClassicOnly>
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
      actions={<IconButton label="Open in chat" icon={ArrowRightIcon} onClick={() => openActivityItemInChat(activityPreviewItem)} />}
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
      accordDisabledReason={accordDisabledReason}
      accordNeedsAgent={accordState?.kind === "add-agent"}
      onOpenAccord={() => setAccordDialogOpen(true)}
      renderMemberSettings={sessionsMember.actions}
      renderMemberChip={sessionsMember.controls}
      mainSessionActions={sessionsMember.mainSessionActions}
      topBar={chatUsesInlineTopBar ? chatTopBar : activityTopBar}
      artifacts={artifacts}
    />
  ) : undefined;
  const shellTopBar = state.railView === "settings" || state.railView === "activity" || chatUsesInlineTopBar
    ? null
    : chatTopBar;

  const shell = (
    <AppShell
      sidebarCollapsed={state.sidebarCollapsed}
      // Activity takes the sidebar's place, the way Settings does.
      sidebarHidden={state.railView === "activity"}
      sidebarWidth={state.sidebarWidth}
      onSidebarWidthChange={state.setSidebarWidth}
      // New chat keeps the chat's workspace width, so its composer stays put
      // when the chat opens.
      minWorkspaceWidth={view.hasResultContext || isNewChatScreen ? CHAT_SPLIT_WORKSPACE_MIN_WIDTH : undefined}
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
            pinnedSessions={view.pinnedSessions}
            recentSessions={view.recentSessions}
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
            onSetPinned={(id, pinned) => void chatActions.setChatPinned(id, pinned)}
            onToggleSidebar={collapseSidebar}
            footerActions={windowActions}
          />
        )
      }
      topBar={shellTopBar}
      bottomPanel={(
        <TerminalPanel
          state={terminal}
          chat={state.railView === "chats" && view.activeChatConversation
            ? { id: view.activeChatConversation.id, repoPath: view.activeChatConversation.repoPath }
            : undefined}
        />
      )}
    >
      <DictationHoldKey />

      <AppNotices
        error={state.error}
        warnings={view.visibleWarnings}
        warningScope={view.warningScope}
        noticeText={view.noticeText}
        crashReportsNotice={state.settings.crashReportsNotice}
        onDismissCrashReportsNotice={() => void settingsActions.dismissCrashReportsNotice()}
        onOpenCrashReportsSetting={() => {
          openSettingsSection("general");
          void settingsActions.dismissCrashReportsNotice();
        }}
        conversationId={state.conversation?.id}
        setError={(value) => state.setError(value)}
        setWarnings={state.setWarnings}
        setDismissedWarningKeysByScope={state.setDismissedWarningKeysByScope}
      />

      <CliImportDialog onOpenConversation={navigation.openChat} />
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
          providers={accordAgents}
          disabled={!canStartAccord}
          participantRoleLabel={(participant) => chatRoleLabel(state.settings.chatRoleConfigs, participant)}
          onOpenChange={setAccordDialogOpen}
          onStart={chatActions.startChatAccord}
          sessions={chatViewFor(view.activeChatConversation.metadata) === "sessions"}
          sessionsNames={accordDialogNames}
        />
      )}

      {state.railView === "settings" ? (
        <SettingsView
          section={state.activeSettingsSection}
          settings={state.settings}
          agents={state.agents}
          updateProvider={settingsActions.updateProvider}
          setAssistantProviderKind={settingsActions.setAssistantProviderKind}
          setNewChatDefaults={settingsActions.setNewChatDefaults}
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
          setRepoFileExternalOpenPreference={settingsActions.setRepoFileExternalOpenPreference}
          setBetaUpdates={settingsActions.setBetaUpdates}
          setCrashReports={settingsActions.setCrashReports}
          setCliAgentRunTimeoutMs={settingsActions.setCliAgentRunTimeoutMs}
          setChatParticipantRequestMaxDepth={settingsActions.setChatParticipantRequestMaxDepth}
          setChatParticipantRequestPromptMaxChars={settingsActions.setChatParticipantRequestPromptMaxChars}
          setChatAutoWatchWakeLimit={settingsActions.setChatAutoWatchWakeLimit}
          setChatPromptContext={settingsActions.setChatPromptContext}
          saveCloudRunsSettings={settingsActions.saveCloudRunsSettings}
          getAgentEnvironment={settingsActions.getAgentEnvironment}
          saveAgentEnvironmentVariable={settingsActions.saveAgentEnvironmentVariable}
          deleteAgentEnvironmentVariable={settingsActions.deleteAgentEnvironmentVariable}
          refreshAgentEnvironment={settingsActions.refreshAgentEnvironment}
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
              icon={ArrowLeftIcon}
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
          detail={<div className="content-area result-layout activity-conversation-content relative">
            {conversationPanel ?? <LoadingBar label="Loading chat" />}
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
          cancellingItemIds={cancellingActivityItemIds}
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
                mainSessionProvider={state.newChatMainSessionProvider}
                onMainSessionProviderChange={state.setNewChatMainSessionProvider}
                mainSessionOverrideFor={state.newChatMainSessionOverrideFor}
                onMainSessionOverrideForChange={state.setNewChatMainSessionOverrideFor}
                onMainSessionStartAccessChange={state.setNewChatMainSessionStartAccess}
                settings={state.settings}
                summaries={state.summaries}
                agents={state.agents}
                initialPluginMentions={newChatPrefill?.pluginMentions}
                initialSkillMentions={newChatPrefill?.skillMentions}
                prefillPrompt={newChatPrefill?.prompt}
                prefillRequestKey={newChatPrefill?.key}
                busy={state.busy}
                onOpenChat={navigation.openChat}
                onRepoInfoChange={state.setRepoInfo}
                onStopStart={() => void conversationActions.cancelReview()}
                creationStatus={state.busy && state.startingChatRef.current
                  ? chatCreationStatus(state.progressLog, state.currentRunId, Boolean(state.chatCreationRef.current?.signal.aborted))
                  : undefined}
                renderParticipantAvatar={renderNewChatMemberMark}
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
  return (
    <ChatBackgroundTasksContext.Provider value={view.participantBackgroundTasksById}>
      <UrgentAlertActionsContext.Provider value={urgentAlertActions}>
        <SubagentProvidersContext.Provider value={subagentActions}>
          {shell}
        </SubagentProvidersContext.Provider>
      </UrgentAlertActionsContext.Provider>
    </ChatBackgroundTasksContext.Provider>
  );
}

startRendererCrashReporting();

// Every icon in the app: Phosphor regular at 16px unless its owner sizes it.
const ICON_DEFAULTS = { size: 16, weight: "regular" } as const;

createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider>
      <IconContext.Provider value={ICON_DEFAULTS}>
        <TooltipProvider>
          <App />
          <Toaster richColors position="bottom-right" />
        </TooltipProvider>
      </IconContext.Provider>
    </ThemeProvider>
  </React.StrictMode>
);

import React from "react";
import { createRoot } from "react-dom/client";
import type { ChatSkillMention, PluginCatalogItem } from "../shared/types";
import {
  RefreshCw,
  XCircle
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { ModeToggle } from "./components/mode-toggle";
import { ThemeProvider } from "./components/theme-provider";
import { AppLoadingState } from "./components/loading-states";
import { AppRail, AppShell, Sidebar, SidebarPanelIcon, TopBar } from "./components/shell";
import { ActivityView } from "./components/activity/activity-view";
import { SettingsView, type SettingsSection } from "./components/settings/settings-view";
import { SettingsSidebar } from "./components/settings/settings-sidebar";
import { ConversationPanel } from "./components/conversation/conversation-panel";
import { ChatParticipantMenu } from "./components/chat/chat-participant-menu";
import { ChatAccordLauncherDialog } from "./components/chat/chat-accord-launcher-dialog";
import { NewChatScreen } from "./components/chat/new-chat-screen";
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
import { AppNotices } from "./app/app-notices";
import { pluginNewChatDraft, pluginNewChatMentions } from "./app/plugin-new-chat";
import "./styles/app.css";

function App(): JSX.Element {
  const state = useAppState();
  const conversationActions = useConversationActions(state);
  const chatActions = useChatActions(state, conversationActions);
  const reviewDecisionActions = useReviewDecisionActions(state, conversationActions);
  const reviewPlanActions = useReviewPlanActions(state, conversationActions);
  const settingsActions = useSettingsActions(state);
  useAppEffects(state, conversationActions.refreshAll, conversationActions.refreshActivity);
  const view = useAppViewModel(state);
  const [appVersion, setAppVersion] = React.useState("");
  const [accordDialogOpen, setAccordDialogOpen] = React.useState(false);
  const [newChatPrefill, setNewChatPrefill] = React.useState<{
    key: number;
    prompt: string;
    pluginMentions: DraftPluginMention[];
    skillMentions: ChatSkillMention[];
  }>();

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
    state.setRailView("settings");
    state.setSidebarCollapsed(false);
  };
  const closeSettings = (): void => {
    state.setRailView("chats");
  };
  const tryPluginInNewChat = (plugin: PluginCatalogItem): void => {
    if (state.busy) {
      return;
    }
    const draft = pluginNewChatDraft(plugin);
    if (!draft.trim()) {
      return;
    }
    void conversationActions.newChatSession().then(() => {
      state.setQuestion(draft);
      setNewChatPrefill({
        key: Date.now(),
        prompt: draft,
        ...pluginNewChatMentions(plugin, draft)
      });
      state.setRailView("chats");
      state.setSidebarCollapsed(false);
    });
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
    </>
  );
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
    />
  ) : undefined;

  return (
    <AppShell
      topStrip={(
        <div className="app-shell-top-strip-actions">
          <ModeToggle />
          <Button variant="ghost" size="icon-sm" className="topbar-icon-button" title="Refresh" aria-label="Refresh" onClick={() => void conversationActions.refreshAll()}>
            <RefreshCw aria-hidden />
            <span className="sr-only">Refresh</span>
          </Button>
        </div>
      )}
      rail={
        <AppRail
          activeView={state.railView}
          onSelect={(nextView) => {
            state.setRailView(nextView);
            if (nextView !== "activity") {
              state.setSelectedActivityItem(undefined);
            }
            if (nextView === "settings") {
              state.setSidebarCollapsed(false);
            }
          }}
        />
      }
      sidebarCollapsed={state.sidebarCollapsed}
      sidebarHidden={state.railView === "activity"}
      sidebarWidth={state.sidebarWidth}
      onSidebarWidthChange={state.setSidebarWidth}
      className={isNewChatScreen ? "is-new-chat-screen" : undefined}
      sidebar={
        state.railView === "settings" ? (
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
            onSelect={(id) => void conversationActions.openConversation(id)}
            onNewSession={() => void conversationActions.newChatSession()}
            onNewProjectSession={(projectRepoPath) => void conversationActions.newProjectSession(projectRepoPath)}
            onArchive={(id) => void chatActions.setChatArchived(id, true)}
            onUnarchive={(id) => void chatActions.setChatArchived(id, false)}
            onToggleSidebar={() => state.setSidebarCollapsed(true)}
          />
        )
      }
      topBar={state.railView === "settings" || state.railView === "activity" ? null : <TopBar leading={topBarLeading} title={topBarTitle} actions={topBarActions} className={isNewChatScreen ? "new-chat-topbar" : undefined} />}
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

      {state.railView === "settings" ? (
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
          onTryPluginInChat={tryPluginInNewChat}
          sidebarCollapsed={state.sidebarCollapsed}
          onExpandSidebar={() => state.setSidebarCollapsed(false)}
          onClose={closeSettings}
        />
      ) : state.railView === "activity" ? (
        <ActivityView
          items={state.activityItems}
          selectedItem={state.selectedActivityItem}
          loading={state.activityLoading}
          error={state.activityError}
          detail={(
            <div className="content-area result-layout activity-conversation-content">
              {conversationPanel ?? <AppLoadingState title="Loading chat" description={openingConversationDescription} />}
            </div>
          )}
          onSelect={(item) => {
            state.setSelectedActivityItem(item);
            void conversationActions.openConversationAndFocusActivityItem(item);
          }}
          onOpenInChat={(item) => {
            state.setRailView("chats");
            state.setSidebarCollapsed(false);
            state.setSelectedActivityItem(undefined);
            void conversationActions.openConversationAndFocusActivityItem(item);
          }}
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
                repoPath={state.repoPath}
                repoInfo={state.repoInfo}
                selectedParticipantIds={state.selectedChatParticipantConfigIds}
                selectedParticipantRunLocations={state.selectedChatParticipantRunLocations}
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

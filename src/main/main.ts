import path from "node:path";
import { randomUUID } from "node:crypto";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import type {
  AddChatParticipantRequest,
  AgentHealth,
  ChatBehaviorRuleConfigUpdate,
  CompactChatParticipantRequest,
  ChatParticipantConfigUpdate,
  ChatRoleConfigUpdate,
  ComposeImplementationPlanRequest,
  ContinueReviewRequest,
  ConversationMessagePageRequest,
  CreateChatConversationRequest,
  DismissConversationWarningsRequest,
  GitDiffRequest,
  OpenRepoFileRequest,
  PlanDecisionClarificationRequest,
  PlanItemReviewRequest,
  ProviderKind,
  ProviderSettingsUpdate,
  ReadChatAttachmentRequest,
  RenameChatConversationRequest,
  SetChatArchivedRequest,
  RepoFileSearchRequest,
  RespondToChatAppToolApprovalRequest,
  RespondToChatChoiceRequest,
  RespondToChatMentionsRequest,
  RecoverImplementationPlanRequest,
  ReviseImplementationPlanRequest,
  RetryImplementationPlanSynthesisRequest,
  ReviewRequest,
  SendChatMessageRequest,
  ToggleChatReactionRequest,
  UpdateChatParticipantRuntimeRequest,
  RemoveChatParticipantRequest,
  UserSkillDiagnosticsRequest,
  UserSkillSearchRequest
} from "../shared/types";
import { normalizeExternalUrlForOpen } from "../shared/externalLinks";
import { ChatService } from "./services/chat";
import { CliAgentRunner } from "./services/cliAgents";
import { ConsensusService } from "./services/consensus";
import { AppMcpService } from "./services/appMcp";
import { AppSkillsService } from "./services/appSkills";
import { bootstrapAppUpdater } from "./services/appUpdater";
import { ensureLoginShellEnvPrimed, setCommandDebugLogger } from "./services/command";
import { DebugLogService } from "./services/debugLogs";
import { GitService } from "./services/git";
import { ProviderRunner } from "./services/providers";
import { RepoFileOpenerService } from "./services/repoFileOpener";
import { SettingsService } from "./services/settings";
import { StorageService } from "./services/storage";
import { UserSkillsService } from "./services/userSkills";

let mainWindow: BrowserWindow | undefined;

const gitService = new GitService();
const settingsService = new SettingsService();
const storageService = new StorageService();
const repoFileOpenerService = new RepoFileOpenerService(storageService, settingsService);
const providerRunner = new ProviderRunner(settingsService);
const debugLogService = new DebugLogService();
setCommandDebugLogger(debugLogService);
const cliAgentRunner = new CliAgentRunner(debugLogService);
void settingsService.getCliAgentRunTimeoutMs()
  .then((timeoutMs) => cliAgentRunner.setRunTimeoutMs(timeoutMs))
  .catch((error) => {
    void debugLogService.write("settings.cli-agent-timeout.load-error", {
      message: error instanceof Error ? error.message : String(error)
    });
  });
const userSkillsService = new UserSkillsService({
  internalSourceRoot: appSkillsSourceRoot()
});
const appSkillsService = new AppSkillsService({
  sourceRoot: appSkillsSourceRoot(),
  appVersion: app.getVersion(),
  debugLogs: debugLogService
});
const appMcpService = new AppMcpService();
const consensusService = new ConsensusService(gitService, storageService, providerRunner, cliAgentRunner, debugLogService, (conversation) => {
  mainWindow?.webContents.send("conversations:updated", conversation);
});
const chatService = new ChatService(storageService, settingsService, cliAgentRunner, debugLogService, appMcpService, (conversation) => {
  mainWindow?.webContents.send("conversations:updated", conversation);
}, userSkillsService);
appMcpService.setRosterChangeHandler((actor, request) => chatService.requestRosterChangeFromTool(actor, request));
appMcpService.setRosterOptionsHandler((actor) => chatService.describeRosterOptionsForTool(actor));
appMcpService.setRoleChangeHandler((actor, request) => chatService.requestRoleChangeFromTool(actor, request));
appMcpService.setRoleOptionsHandler((actor) => chatService.describeRoleOptionsForTool(actor));
appMcpService.setParticipantChangeHandler((actor, request) => chatService.requestParticipantChangeFromTool(actor, request));
appMcpService.setParticipantOptionsHandler((actor) => chatService.describeParticipantOptionsForTool(actor));
appMcpService.setPermissionChangeHandler((actor, request) => chatService.requestPermissionChangeFromTool(actor, request));
appMcpService.setToolPermissionHandler((actor, request) => chatService.requestToolPermissionFromTool(actor, request));
appMcpService.setChatContextHandler((actor) => chatService.describeChatContextForTool(actor));
appMcpService.setChatParticipantsHandler((actor) => chatService.describeChatParticipantsForTool(actor));
appMcpService.setChatMessagesHandler((actor, request) => chatService.readChatMessagesForTool(actor, request));
appMcpService.setChatAttachmentListHandler((actor, request) => chatService.listChatAttachmentsForTool(actor, request));
appMcpService.setChatAttachmentReadHandler((actor, request) => chatService.readChatAttachmentForTool(actor, request));
appMcpService.setChatAttachmentExportHandler((actor, request) => chatService.exportChatAttachmentForTool(actor, request));
appMcpService.setChatParticipantRequestHandler((actor, request) => chatService.requestParticipantsFromTool(actor, request));
appMcpService.setChatParticipantRequestStatusHandler((actor, request) => chatService.participantRequestStatusForTool(actor, request));
appMcpService.setChatReactHandler((actor, request) => chatService.reactToMessageFromTool(actor, request));
appMcpService.setChatSendMessageHandler((actor, request) => chatService.sendChatMessageFromTool(actor, request));
const activeReviews = new Map<string, AbortController>();

function appSkillsSourceRoot(): string {
  return app.isPackaged
    ? path.join(__dirname, "appSkills")
    : path.join(process.cwd(), "src/main/appSkills");
}

async function detectAgentsWithAppSkills(): Promise<AgentHealth[]> {
  const agents = await cliAgentRunner.detectAgents();
  return appSkillsService.reconcileAgents(agents).catch((error) => {
    void debugLogService.write("app-skills-detect-sync-error", {
      error: error instanceof Error ? error.message : String(error)
    });
    return agents.map((agent) => ({
      ...agent,
      appSkillSync: agent.installed
        ? { status: "error", skillCount: 0, updatedAt: new Date().toISOString(), message: "App skill sync failed." }
        : { status: "not-installed", skillCount: 0, updatedAt: new Date().toISOString() }
    }));
  });
}

async function openExternalUrl(url: unknown): Promise<void> {
  await shell.openExternal(normalizeExternalUrlForOpen(url));
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 1080,
    minHeight: 720,
    title: "AccordAgents",
    backgroundColor: "#f5f2ec",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../../renderer/index.html"));
  }
}

function registerIpc(): void {
  ipcMain.handle("app:get-version", () => app.getVersion());
  ipcMain.handle("app:open-external", (_event, url: unknown) => openExternalUrl(url));
  ipcMain.handle("app:open-repo-file", (_event, request: OpenRepoFileRequest) => repoFileOpenerService.openRepoFile(request));
  ipcMain.handle("settings:get", () => settingsService.getPublicSettings());
  ipcMain.handle("settings:set-repo-file-open-preference", (_event, action: unknown) => repoFileOpenerService.setOpenPreference(action));
  ipcMain.handle("settings:set-cli-agent-run-timeout", async (_event, timeoutMs: number) => {
    const next = await settingsService.setCliAgentRunTimeoutMs(timeoutMs);
    cliAgentRunner.setRunTimeoutMs(next.cliAgentRunTimeoutMs);
    return next;
  });
  ipcMain.handle("settings:update-provider", (_event, update: ProviderSettingsUpdate) => settingsService.updateProvider(update));
  ipcMain.handle("settings:save-chat-role", (_event, update: ChatRoleConfigUpdate) => settingsService.saveChatRoleConfig(update));
  ipcMain.handle("settings:archive-chat-role", (_event, id: string) => settingsService.archiveChatRoleConfig(id));
  ipcMain.handle("settings:save-chat-behavior-rule", (_event, update: ChatBehaviorRuleConfigUpdate) => settingsService.saveChatBehaviorRuleConfig(update));
  ipcMain.handle("settings:delete-chat-behavior-rule", async (_event, id: string) => {
    const nextSettings = await settingsService.deleteChatBehaviorRuleConfig(id);
    await chatService.removeBehaviorRuleFromChatParticipants(id);
    return nextSettings;
  });
  ipcMain.handle("settings:save-chat-participant", async (_event, update: ChatParticipantConfigUpdate) => {
    const previousSettings = await settingsService.getPublicSettings();
    const previous = update.id?.trim()
      ? previousSettings.chatParticipantConfigs.find((participant) => participant.id === update.id?.trim())
      : undefined;
    const nextSettings = await settingsService.saveChatParticipantConfig(update);
    const saved = (previous?.id
      ? nextSettings.chatParticipantConfigs.find((participant) => participant.id === previous.id)
      : undefined);
    if (previous && saved) {
      await chatService.syncSavedParticipantConfig(previous, saved);
    }
    return nextSettings;
  });
  ipcMain.handle("settings:delete-chat-participant", (_event, id: string) => {
    return settingsService.deleteChatParticipantConfig(id);
  });
  ipcMain.handle("settings:update-last-repo-path", (_event, repoPath: string) => settingsService.updateLastRepoPath(repoPath));
  ipcMain.handle("settings:list-provider-models", async (_event, kind: ProviderKind) => {
    if (kind === "codex-cli" || kind === "claude-code") {
      const settings = await settingsService.getPublicSettings();
      const configuredModel = settings.providers.find((provider) => provider.kind === kind)?.model;
      return cliAgentRunner.listModelCatalog(kind, configuredModel);
    }
    return providerRunner.listModelCatalog(kind);
  });
  ipcMain.handle("agents:detect", async () => {
    const agents = await detectAgentsWithAppSkills();
    await settingsService.ensureGenericChatParticipantSeeds(agents);
    return agents;
  });
  ipcMain.handle("git:inspect-repo", (_event, repoPath: string) => gitService.inspectRepo(repoPath));
  ipcMain.handle("git:get-diff", (_event, request: GitDiffRequest) => gitService.getDiff(request));
  ipcMain.handle("git:search-repo-files", async (_event, request: RepoFileSearchRequest) => {
    const conversationId = typeof request?.conversationId === "string" ? request.conversationId : "";
    const query = typeof request?.query === "string" ? request.query : "";
    const limit = typeof request?.limit === "number" ? request.limit : undefined;
    const conversation = await storageService.getConversation(conversationId);
    if (!conversation?.repoPath) {
      return [];
    }
    return gitService.searchRepoFiles(conversation.repoPath, query, limit);
  });
  ipcMain.handle("skills:search", async (_event, request: UserSkillSearchRequest) => {
    const conversation = await storageService.getConversation(typeof request?.conversationId === "string" ? request.conversationId : "");
    if (!conversation || conversation.kind !== "chat") {
      return {
        target: { participantIds: [], providerKinds: [], hasClearTargets: false },
        skills: []
      };
    }
    const content = typeof request?.content === "string" ? request.content : "";
    return userSkillsService.search(
      {
        conversationId: conversation.id,
        query: typeof request?.query === "string" ? request.query : "",
        content,
        limit: typeof request?.limit === "number" ? request.limit : undefined
      },
      chatService.userSkillRunContext(conversation, content)
    );
  });
  ipcMain.handle("skills:diagnostics", async (_event, request?: UserSkillDiagnosticsRequest) => {
    const conversationId = typeof request?.conversationId === "string" ? request.conversationId : "";
    const conversation = conversationId ? await storageService.getConversation(conversationId) : undefined;
    return userSkillsService.diagnostics(
      conversation?.kind === "chat" ? conversation.repoPath : undefined,
      conversation?.kind === "chat" ? chatService.userSkillRunContext(conversation, "") : undefined
    );
  });
  ipcMain.handle("conversations:list", () => storageService.listConversations());
  ipcMain.handle("conversations:get", async (_event, id: string) => {
    const conversation = await storageService.getConversation(id);
    return conversation ? chatService.hydrateContextUsage(conversation) : conversation;
  });
  ipcMain.handle("conversations:open", async (_event, id: string, limit?: number) => {
    const result = await storageService.openConversation(id, limit);
    if (!result) {
      return result;
    }
    // openConversation returns a paginated window of messages consistent with
    // result.messagePage. hydrateContextUsage runs withChatMutation ->
    // refreshStoredChatState, which reassigns conversation.messages to the full
    // stored history; that would un-window the result and leave messages.length
    // inconsistent with messagePage. Keep the refreshed context-usage metadata but
    // restore the windowed messages captured before hydration.
    const windowedMessages = result.conversation.messages;
    const hydrated = await chatService.hydrateContextUsage(result.conversation);
    return {
      ...result,
      conversation: { ...hydrated, messages: windowedMessages }
    };
  });
  ipcMain.handle("conversations:list-messages", (_event, request: ConversationMessagePageRequest) => storageService.listConversationMessages(request));
  ipcMain.handle("conversations:save-decision-selections", async (_event, conversationId: string, selections: Record<string, string>) => {
    const conversation = await storageService.getConversation(conversationId);
    if (!conversation || conversation.kind !== "implementation-plan") {
      return conversation;
    }
    const normalizedSelections = Object.fromEntries(
      Object.entries(selections).filter(([decisionId, optionId]) => decisionId.trim() && optionId.trim())
    );
    conversation.metadata = {
      ...conversation.metadata,
      pendingDecisionSelections: normalizedSelections
    };
    conversation.updatedAt = new Date().toISOString();
    await storageService.saveConversation(conversation);
    return conversation;
  });
  ipcMain.handle("conversations:save-decision-resolutions", async (_event, conversationId: string, resolutions: Record<string, boolean>) => {
    const conversation = await storageService.getConversation(conversationId);
    if (!conversation || conversation.kind !== "implementation-plan") {
      return conversation;
    }
    const normalizedResolutions = Object.fromEntries(
      Object.entries(resolutions).filter(([decisionId, resolved]) => decisionId.trim() && resolved === true)
    );
    conversation.metadata = {
      ...conversation.metadata,
      pendingDecisionResolutions: normalizedResolutions
    };
    conversation.updatedAt = new Date().toISOString();
    await storageService.saveConversation(conversation);
    return conversation;
  });
  ipcMain.handle("conversations:save-plan-item-review", async (_event, request: PlanItemReviewRequest) => {
    return consensusService.savePlanItemReview(request);
  });
  ipcMain.handle("chat:create", async (_event, request: CreateChatConversationRequest) => {
    return chatService.createConversation(request);
  });
  ipcMain.handle("chat:rename", async (_event, request: RenameChatConversationRequest) => {
    return chatService.renameConversation(request);
  });
  ipcMain.handle("chat:set-archived", async (_event, request: SetChatArchivedRequest) => {
    return chatService.setArchived(request);
  });
  ipcMain.handle("chat:dismiss-warnings", async (_event, request: DismissConversationWarningsRequest) => {
    return chatService.dismissConversationWarnings(request);
  });
  ipcMain.handle("chat:add-participant", async (_event, request: AddChatParticipantRequest) => {
    return chatService.addParticipant(request);
  });
  ipcMain.handle("chat:update-participant-runtime", async (_event, request: UpdateChatParticipantRuntimeRequest) => {
    return chatService.updateParticipantRuntime(request);
  });
  ipcMain.handle("chat:remove-participant", async (_event, request: RemoveChatParticipantRequest) => {
    return chatService.removeParticipant(request);
  });
  ipcMain.handle("chat:compact-participant", async (_event, request: CompactChatParticipantRequest) => {
    const runId = request.runId ?? randomUUID();
    const controller = new AbortController();
    activeReviews.set(runId, controller);

    try {
      return await chatService.compactParticipant(
        { ...request, runId },
        controller.signal,
        (progress) => mainWindow?.webContents.send("conversations:review-progress", progress)
      );
    } catch (error) {
      const phase = controller.signal.aborted ? "cancelled" : "error";
      mainWindow?.webContents.send("conversations:review-progress", {
        runId,
        phase,
        message: error instanceof Error ? error.message : String(error),
        createdAt: new Date().toISOString()
      });
      throw error;
    } finally {
      activeReviews.delete(runId);
    }
  });
  ipcMain.handle("chat:send", async (_event, request: SendChatMessageRequest) => {
    const runId = request.runId ?? randomUUID();
    const controller = new AbortController();
    activeReviews.set(runId, controller);

    try {
      return await chatService.sendMessage(
        { ...request, runId },
        controller.signal,
        (progress) => mainWindow?.webContents.send("conversations:review-progress", progress)
      );
    } catch (error) {
      const phase = controller.signal.aborted ? "cancelled" : "error";
      mainWindow?.webContents.send("conversations:review-progress", {
        runId,
        phase,
        message: error instanceof Error ? error.message : String(error),
        createdAt: new Date().toISOString()
      });
      throw error;
    } finally {
      activeReviews.delete(runId);
    }
  });
  ipcMain.handle("chat:read-attachment", async (_event, request: ReadChatAttachmentRequest) => {
    return chatService.readChatAttachment(request);
  });
  ipcMain.handle("chat:toggle-reaction", async (_event, request: ToggleChatReactionRequest) => {
    return chatService.toggleReaction(request);
  });
  ipcMain.handle("chat:respond-to-mentions", async (_event, request: RespondToChatMentionsRequest) => {
    const runId = request.runId ?? randomUUID();
    const controller = new AbortController();
    activeReviews.set(runId, controller);

    try {
      return await chatService.respondToMentions(
        { ...request, runId },
        controller.signal,
        (progress) => mainWindow?.webContents.send("conversations:review-progress", progress)
      );
    } catch (error) {
      const phase = controller.signal.aborted ? "cancelled" : "error";
      mainWindow?.webContents.send("conversations:review-progress", {
        runId,
        phase,
        message: error instanceof Error ? error.message : String(error),
        createdAt: new Date().toISOString()
      });
      throw error;
    } finally {
      activeReviews.delete(runId);
    }
  });
  ipcMain.handle("chat:respond-to-choice", async (_event, request: RespondToChatChoiceRequest) => {
    const runId = request.runId ?? randomUUID();
    const controller = new AbortController();
    activeReviews.set(runId, controller);

    try {
      return await chatService.respondToChoice(
        { ...request, runId },
        controller.signal,
        (progress) => mainWindow?.webContents.send("conversations:review-progress", progress)
      );
    } catch (error) {
      const phase = controller.signal.aborted ? "cancelled" : "error";
      mainWindow?.webContents.send("conversations:review-progress", {
        runId,
        phase,
        message: error instanceof Error ? error.message : String(error),
        createdAt: new Date().toISOString()
      });
      throw error;
    } finally {
      activeReviews.delete(runId);
    }
  });
  ipcMain.handle("chat:respond-to-app-tool-approval", async (_event, request: RespondToChatAppToolApprovalRequest) => {
    return chatService.respondToAppToolApproval(
      request,
      (progress) => mainWindow?.webContents.send("conversations:review-progress", progress)
    );
  });
  ipcMain.handle("conversations:start-review", async (_event, request: ReviewRequest) => {
    const runId = request.runId ?? randomUUID();
    const controller = new AbortController();
    activeReviews.set(runId, controller);

    try {
      return await consensusService.startReview(
        { ...request, runId },
        controller.signal,
        (progress) => mainWindow?.webContents.send("conversations:review-progress", progress)
      );
    } catch (error) {
      const phase = controller.signal.aborted ? "cancelled" : "error";
      mainWindow?.webContents.send("conversations:review-progress", {
        runId,
        phase,
        message: error instanceof Error ? error.message : String(error),
        createdAt: new Date().toISOString()
      });
      throw error;
    } finally {
      activeReviews.delete(runId);
    }
  });
  ipcMain.handle("conversations:continue-review", async (_event, request: ContinueReviewRequest) => {
    const runId = request.runId ?? randomUUID();
    const controller = new AbortController();
    activeReviews.set(runId, controller);

    try {
      return await consensusService.continueReview(
        { ...request, runId },
        controller.signal,
        (progress) => mainWindow?.webContents.send("conversations:review-progress", progress)
      );
    } catch (error) {
      const phase = controller.signal.aborted ? "cancelled" : "error";
      mainWindow?.webContents.send("conversations:review-progress", {
        runId,
        phase,
        message: error instanceof Error ? error.message : String(error),
        createdAt: new Date().toISOString()
      });
      throw error;
    } finally {
      activeReviews.delete(runId);
    }
  });
  ipcMain.handle("conversations:compose-implementation-plan", async (_event, request: ComposeImplementationPlanRequest) => {
    const runId = request.runId ?? randomUUID();
    const controller = new AbortController();
    activeReviews.set(runId, controller);

    try {
      return await consensusService.composeImplementationPlan(
        { ...request, runId },
        controller.signal,
        (progress) => mainWindow?.webContents.send("conversations:review-progress", progress)
      );
    } catch (error) {
      const phase = controller.signal.aborted ? "cancelled" : "error";
      mainWindow?.webContents.send("conversations:review-progress", {
        runId,
        phase,
        message: error instanceof Error ? error.message : String(error),
        createdAt: new Date().toISOString()
      });
      throw error;
    } finally {
      activeReviews.delete(runId);
    }
  });
  ipcMain.handle("conversations:retry-implementation-plan-synthesis", async (_event, request: RetryImplementationPlanSynthesisRequest) => {
    const runId = request.runId ?? randomUUID();
    const controller = new AbortController();
    activeReviews.set(runId, controller);

    try {
      return await consensusService.retryImplementationPlanSynthesis(
        { ...request, runId },
        controller.signal,
        (progress) => mainWindow?.webContents.send("conversations:review-progress", progress)
      );
    } catch (error) {
      const phase = controller.signal.aborted ? "cancelled" : "error";
      mainWindow?.webContents.send("conversations:review-progress", {
        runId,
        phase,
        message: error instanceof Error ? error.message : String(error),
        createdAt: new Date().toISOString()
      });
      throw error;
    } finally {
      activeReviews.delete(runId);
    }
  });
  ipcMain.handle("conversations:recover-implementation-plan", async (_event, request: RecoverImplementationPlanRequest) => {
    const runId = request.runId ?? randomUUID();
    const controller = new AbortController();
    activeReviews.set(runId, controller);

    try {
      return await consensusService.recoverImplementationPlan(
        { ...request, runId },
        controller.signal,
        (progress) => mainWindow?.webContents.send("conversations:review-progress", progress)
      );
    } catch (error) {
      const phase = controller.signal.aborted ? "cancelled" : "error";
      mainWindow?.webContents.send("conversations:review-progress", {
        runId,
        phase,
        message: error instanceof Error ? error.message : String(error),
        createdAt: new Date().toISOString()
      });
      throw error;
    } finally {
      activeReviews.delete(runId);
    }
  });
  ipcMain.handle("conversations:revise-implementation-plan", async (_event, request: ReviseImplementationPlanRequest) => {
    const runId = request.runId ?? randomUUID();
    const controller = new AbortController();
    activeReviews.set(runId, controller);

    try {
      return await consensusService.reviseImplementationPlan(
        { ...request, runId },
        controller.signal,
        (progress) => mainWindow?.webContents.send("conversations:review-progress", progress)
      );
    } catch (error) {
      const phase = controller.signal.aborted ? "cancelled" : "error";
      mainWindow?.webContents.send("conversations:review-progress", {
        runId,
        phase,
        message: error instanceof Error ? error.message : String(error),
        createdAt: new Date().toISOString()
      });
      throw error;
    } finally {
      activeReviews.delete(runId);
    }
  });
  ipcMain.handle("conversations:ask-plan-decision-clarification", async (_event, request: PlanDecisionClarificationRequest) => {
    const runId = request.runId ?? randomUUID();
    const controller = new AbortController();
    activeReviews.set(runId, controller);

    try {
      return await consensusService.askPlanDecisionClarification(
        { ...request, runId },
        controller.signal,
        (progress) => mainWindow?.webContents.send("conversations:review-progress", progress)
      );
    } catch (error) {
      const phase = controller.signal.aborted ? "cancelled" : "error";
      mainWindow?.webContents.send("conversations:review-progress", {
        runId,
        phase,
        message: error instanceof Error ? error.message : String(error),
        createdAt: new Date().toISOString()
      });
      throw error;
    } finally {
      activeReviews.delete(runId);
    }
  });
  ipcMain.handle("conversations:cancel-review", (_event, runId: string) => {
    const controller = activeReviews.get(runId);
    if (controller) {
      controller.abort();
      return;
    }
    chatService.cancelRun(runId);
  });
  ipcMain.handle("dialog:select-repo", async () => {
    const options: Electron.OpenDialogOptions = {
      title: "Select repository",
      properties: ["openDirectory"]
    };
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    return result.canceled ? undefined : result.filePaths[0];
  });
}

void app.whenReady().then(async () => {
  registerIpc();
  bootstrapAppUpdater(debugLogService);
  await appMcpService.start();
  await storageService.init();
  createWindow();
  void ensureLoginShellEnvPrimed();
  await detectAgentsWithAppSkills().catch((error) => {
    void debugLogService.write("app-skills-startup-sync-error", {
      error: error instanceof Error ? error.message : String(error)
    });
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("Failed to start AccordAgents:", error);
  dialog.showErrorBox("AccordAgents failed to start", message);
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  void cliAgentRunner.shutdownWarmAgents();
  void appMcpService.stop();
});

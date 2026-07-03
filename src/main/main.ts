import path from "node:path";
import { randomUUID } from "node:crypto";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import type {
  AddChatParticipantRequest,
  AgentHealth,
  ChatBehaviorRuleConfigUpdate,
  ChatSavedPromptConfigUpdate,
  CloudRunsSettingsUpdate,
  CloudRunWorkerSettings,
  ConnectAwsWorkerRequest,
  CompactChatParticipantRequest,
  ChatParticipantConfigUpdate,
  ChatRoleConfigUpdate,
  ComposeImplementationPlanRequest,
  ContinueReviewRequest,
  ConversationMessagePageRequest,
  CreateChatConversationRequest,
  DismissConversationWarningsRequest,
  GitDiffRequest,
  InspectLocalFileRequest,
  OpenLocalFileRequest,
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
  StartChatAccordRequest,
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
import { ensureLoginShellEnvPrimed, runCommand, setCommandDebugLogger } from "./services/command";
import { buildCloudRunSshTarget, normalizeCloudRunWorkerSettings, validateCloudRunSshWorkerFields } from "./services/cloudRunWorkers";
import { CloudRunDoctorService } from "./services/cloudRunDoctor";
import { CloudRunAwsService } from "./services/cloudRunAws";
import { DebugLogService } from "./services/debugLogs";
import { GitService } from "./services/git";
import { ProviderRunner } from "./services/providers";
import { RemoteRunService } from "./services/remoteRuns";
import { RemoteRunCoordinator } from "./services/remoteRunCoordinator";
import { LocalFileOpenerService } from "./services/localFileOpener";
import { SettingsService } from "./services/settings";
import { StorageService } from "./services/storage";
import { UserSkillsService } from "./services/userSkills";

let mainWindow: BrowserWindow | undefined;

const gitService = new GitService();
const settingsService = new SettingsService();
const storageService = new StorageService();
const localFileOpenerService = new LocalFileOpenerService(storageService, settingsService);
const providerRunner = new ProviderRunner();
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
const remoteRunService = new RemoteRunService(chatService, {
  syncLogger: (event, payload) => {
    void debugLogService.write(event, payload);
  }
});
const cloudRunDoctorService = new CloudRunDoctorService({
  openExternal: (url) => {
    void openExternalUrl(url);
  },
  logger: (event, payload) => {
    void debugLogService.write(event, payload);
  }
});
const cloudRunAwsService = new CloudRunAwsService(settingsService, {
  logger: (event, payload) => {
    void debugLogService.write(event, payload);
  }
});
chatService.setCloudRunAwsService(cloudRunAwsService);
const remoteRunCoordinator = new RemoteRunCoordinator(remoteRunService, chatService, settingsService, debugLogService);
chatService.setRemoteRunService(remoteRunService);
chatService.setRemoteRunCoordinator(remoteRunCoordinator);
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
appMcpService.setChatSetTitleHandler((actor, request) => chatService.setChatTitleFromTool(actor, request));
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

async function testCloudRunWorker(worker: CloudRunWorkerSettings): Promise<{ ok: boolean; message: string }> {
  const normalized = normalizeCloudRunWorkerSettings(worker);
  const host = normalized.host ?? "";
  if (!host) {
    return { ok: false, message: "Worker host is required." };
  }
  let target: string;
  try {
    validateCloudRunSshWorkerFields(normalized as CloudRunWorkerSettings & { host: string });
    target = buildCloudRunSshTarget(normalized as CloudRunWorkerSettings & { host: string });
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  const args = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10"
  ];
  if (normalized.identityFile) {
    args.push("-i", normalized.identityFile);
  }
  if (typeof normalized.port === "number" && Number.isFinite(normalized.port)) {
    args.push("-p", String(normalized.port));
  }
  args.push(target, "command -v codex >/dev/null && printf ok");
  try {
    const result = await runCommand("ssh", args, { timeoutMs: 20_000 });
    return result.stdout.trim() === "ok"
      ? { ok: true, message: "Worker reachable; codex found." }
      : { ok: false, message: result.stdout.trim() || "Worker reachable, but codex check did not return ok." };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

async function withCloudRunWorker<T>(
  request: CloudRunWorkerSettings | undefined,
  action: (worker: CloudRunWorkerSettings) => Promise<T>
): Promise<T> {
  if (request) {
    return action(request);
  }
  const settings = await settingsService.getPublicSettings();
  if (settings.cloudRuns.mode !== "aws") {
    return action(settings.cloudRuns.worker);
  }
  cloudRunAwsService.noteRunStarted();
  try {
    return await action(await cloudRunAwsService.ensureWorkerForRun());
  } finally {
    await cloudRunAwsService.noteRunEnded();
  }
}

function registerIpc(): void {
  ipcMain.handle("app:get-version", () => app.getVersion());
  ipcMain.handle("app:open-external", (_event, url: unknown) => openExternalUrl(url));
  ipcMain.handle("app:inspect-local-file", (_event, request: InspectLocalFileRequest) => localFileOpenerService.inspectLocalFile(request));
  ipcMain.handle("app:open-local-file", (_event, request: OpenLocalFileRequest) => localFileOpenerService.openLocalFile(request));
  ipcMain.handle("settings:get", () => settingsService.getPublicSettings());
  ipcMain.handle("settings:set-repo-file-open-preference", (_event, action: unknown) => localFileOpenerService.setOpenPreference(action));
  ipcMain.handle("settings:set-cli-agent-run-timeout", async (_event, timeoutMs: number) => {
    const next = await settingsService.setCliAgentRunTimeoutMs(timeoutMs);
    cliAgentRunner.setRunTimeoutMs(next.cliAgentRunTimeoutMs);
    return next;
  });
  ipcMain.handle("settings:set-chat-participant-request-max-depth", (_event, maxDepth: number) => {
    return settingsService.setChatParticipantRequestMaxDepth(maxDepth);
  });
  ipcMain.handle("settings:save-cloud-runs", (_event, update: CloudRunsSettingsUpdate) => settingsService.saveCloudRunsSettings(update));
  ipcMain.handle("cloud-runs:test-worker", async (_event, request?: CloudRunWorkerSettings) => {
    return withCloudRunWorker(request, testCloudRunWorker);
  });
  ipcMain.handle("cloud-runs:diagnose-worker", async (_event, request?: CloudRunWorkerSettings) => {
    return withCloudRunWorker(request, (worker) => cloudRunDoctorService.diagnose(worker));
  });
  ipcMain.handle("cloud-runs:setup-worker", async (_event, request?: CloudRunWorkerSettings) => {
    return withCloudRunWorker(request, (worker) => cloudRunDoctorService.setup(worker, (progress) => {
      mainWindow?.webContents.send("cloud-runs:setup-progress", progress);
    }));
  });
  ipcMain.handle("cloud-runs:aws-bootstrap-command", (_event, region: string) =>
    cloudRunAwsService.bootstrapCommand(String(region ?? "").trim() || "us-east-1"));
  ipcMain.handle("cloud-runs:aws-connect", (_event, request: ConnectAwsWorkerRequest) =>
    cloudRunAwsService.connectWorker(request.blob, request.instanceType, request.rootVolumeSizeGb));
  ipcMain.handle("cloud-runs:aws-status", () => cloudRunAwsService.status());
  ipcMain.handle("cloud-runs:aws-stop", () => cloudRunAwsService.stopWorker());
  ipcMain.handle("cloud-runs:aws-delete", () => cloudRunAwsService.deleteWorker());
  ipcMain.handle("settings:update-provider", (_event, update: ProviderSettingsUpdate) => settingsService.updateProvider(update));
  ipcMain.handle("settings:save-chat-role", (_event, update: ChatRoleConfigUpdate) => settingsService.saveChatRoleConfig(update));
  ipcMain.handle("settings:archive-chat-role", (_event, id: string) => settingsService.archiveChatRoleConfig(id));
  ipcMain.handle("settings:save-chat-behavior-rule", (_event, update: ChatBehaviorRuleConfigUpdate) => settingsService.saveChatBehaviorRuleConfig(update));
  ipcMain.handle("settings:delete-chat-behavior-rule", async (_event, id: string) => {
    const nextSettings = await settingsService.deleteChatBehaviorRuleConfig(id);
    await chatService.removeBehaviorRuleFromChatParticipants(id);
    return nextSettings;
  });
  ipcMain.handle("settings:save-chat-saved-prompt", (_event, update: ChatSavedPromptConfigUpdate) => settingsService.saveChatSavedPromptConfig(update));
  ipcMain.handle("settings:delete-chat-saved-prompt", (_event, id: string) => settingsService.deleteChatSavedPromptConfig(id));
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
    let repoPath = "";
    if (conversationId) {
      const conversation = await storageService.getConversation(conversationId);
      repoPath = conversation?.repoPath ?? "";
    } else {
      repoPath = typeof request?.repoPath === "string" ? request.repoPath.trim() : "";
    }
    if (!repoPath) {
      return [];
    }
    return gitService.searchRepoFiles(repoPath, query, limit);
  });
  ipcMain.handle("skills:search", async (_event, request: UserSkillSearchRequest) => {
    const conversationId = typeof request?.conversationId === "string" ? request.conversationId : "";
    const content = typeof request?.content === "string" ? request.content : "";
    if (conversationId) {
      const conversation = await storageService.getConversation(conversationId);
      if (!conversation || conversation.kind !== "chat") {
        return {
          target: { participantIds: [], providerKinds: [], hasClearTargets: false },
          skills: []
        };
      }
      return userSkillsService.search(
        {
          conversationId: conversation.id,
          query: typeof request?.query === "string" ? request.query : "",
          content,
          limit: typeof request?.limit === "number" ? request.limit : undefined
        },
        chatService.userSkillRunContext(conversation, content)
      );
    }
    return userSkillsService.search(
      {
        query: typeof request?.query === "string" ? request.query : "",
        repoPath: typeof request?.repoPath === "string" ? request.repoPath : undefined,
        participants: Array.isArray(request?.participants) ? request.participants : [],
        content,
        limit: typeof request?.limit === "number" ? request.limit : undefined
      },
      await chatService.prospectiveUserSkillRunContext({
        repoPath: typeof request?.repoPath === "string" ? request.repoPath : undefined,
        participants: Array.isArray(request?.participants) ? request.participants : [],
        content
      })
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
  ipcMain.handle("chat:start-accord", async (_event, request: StartChatAccordRequest) => {
    const runId = randomUUID();
    const controller = new AbortController();
    activeReviews.set(runId, controller);

    try {
      return await chatService.startAccord(
        request,
        controller.signal,
        (progress) => mainWindow?.webContents.send("conversations:review-progress", progress),
        runId
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
  void remoteRunCoordinator.start().catch((error) => {
    void debugLogService.write("remote-run.coordinator.start.error", {
      message: error instanceof Error ? error.message : String(error)
    });
  });
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

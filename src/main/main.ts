import path from "node:path";
import { randomUUID } from "node:crypto";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import type {
  AddChatParticipantRequest,
  AgentDetectionRequest,
  DeleteAgentEnvironmentVariableRequest,
  AgentHealth,
  ChatBehaviorRuleConfigUpdate,
  ChatPromptContextSettings,
  ChatSavedPromptConfigUpdate,
  CloudRunsSettingsUpdate,
  CloudRunWorkerSettings,
  ConnectAwsWorkerRequest,
  AwsWorkerStartRequest,
  CompactChatParticipantRequest,
  ChatParticipantConfigUpdate,
  ChatRoleConfigUpdate,
  ComposeImplementationPlanRequest,
  ContinueReviewRequest,
  ConversationMessagePageRequest,
  CreateChatConversationRequest,
  DeleteChatConversationRequest,
  DismissConversationWarningsRequest,
  GitDiffRequest,
  InspectLocalFileRequest,
  ListChatActivityRequest,
  OpenLocalFileRequest,
  PlanDecisionClarificationRequest,
  PlanItemReviewRequest,
  PluginListRequest,
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
  SaveAgentEnvironmentVariableRequest,
  StartChatAccordRequest,
  ToggleChatReactionRequest,
  UpdateChatParticipantRuntimeRequest,
  RemoveChatParticipantRequest,
  UserSkillDiagnosticsRequest,
  UserSkillListRequest,
  UserSkillSearchRequest,
  UserSkillSummary
} from "../shared/types";
import type {
  ArtifactDraftAudiencePolicyByAuthor,
  CreateArtifactRequest,
  DiffArtifactRequest,
  ListArtifactsRequest,
  ListArtifactDraftsRequest,
  PublishArtifactRequest,
  PublishArtifactSourceRequest,
  ReadArtifactRequest,
  ReadArtifactDraftRequest,
  RenameArtifactRequest,
  ReplaceArtifactDraftRequest,
  ReviseArtifactRequest,
  SaveArtifactDraftRequest,
  SignArtifactRequest,
  SubmitArtifactDraftRequest,
  UpdateArtifactDraftRosterRequest,
  WithdrawArtifactDraftRequest,
  UpdateArtifactAccessRequest
} from "../shared/types";
import { ARTIFACT_USER_MEMBER } from "../shared/types";
import { artifactMembersForConversation } from "../shared/artifacts";
import { normalizeExternalUrlForOpen } from "../shared/externalLinks";
import { ArtifactService } from "./services/artifacts";
import { ArtifactStore } from "./services/artifactStore";
import { validateArtifactCreateToolRequest } from "./services/artifactToolRequest";
import { ChatService } from "./services/chat";
import { CliAgentRunner } from "./services/cliAgents";
import { ConsensusService } from "./services/consensus";
import { AppMcpService } from "./services/appMcp";
import {
  APP_ARTIFACT_CREATE_TOOL,
  APP_ARTIFACT_DRAFT_LIST_TOOL,
  APP_ARTIFACT_DRAFT_READ_TOOL,
  APP_ARTIFACT_DRAFT_REPLACE_TOOL,
  APP_ARTIFACT_DRAFT_SAVE_TOOL,
  APP_ARTIFACT_DRAFT_SET_ROSTER_TOOL,
  APP_ARTIFACT_DRAFT_SUBMIT_TOOL,
  APP_ARTIFACT_DRAFT_WITHDRAW_TOOL,
  APP_ARTIFACT_DIFF_TOOL,
  APP_ARTIFACT_LIST_TOOL,
  APP_ARTIFACT_PUBLISH_TOOL,
  APP_ARTIFACT_READ_TOOL,
  APP_ARTIFACT_RENAME_TOOL,
  APP_ARTIFACT_REVISE_TOOL,
  APP_ARTIFACT_SET_ACCESS_TOOL,
  APP_ARTIFACT_SIGN_TOOL
} from "./services/appMcp";
import { AppSkillsService } from "./services/appSkills";
import { AgentEnvironmentService } from "./services/agentEnvironment";
import { bootstrapAppUpdater } from "./services/appUpdater";
import { ensureLoginShellEnvPrimed, runCommand, setCommandDebugLogger } from "./services/command";
import { buildCloudRunSshTarget, cloudRunWorkerTargetFromSettings, normalizeCloudRunWorkerSettings, validateCloudRunSshWorkerFields } from "./services/cloudRunWorkers";
import { CloudRunDoctorService } from "./services/cloudRunDoctor";
import { CloudRunAwsService } from "./services/cloudRunAws";
import { AwsWorkerSetupService } from "./services/awsWorkerSetup";
import { DebugLogService } from "./services/debugLogs";
import { GitService } from "./services/git";
import { ProviderRunner } from "./services/providers";
import { RemoteRunService } from "./services/remoteRuns";
import { RemoteRunCoordinator } from "./services/remoteRunCoordinator";
import { LocalFileOpenerService } from "./services/localFileOpener";
import { SettingsService } from "./services/settings";
import { StorageService } from "./services/storage";
import { PluginService } from "./services/plugins";
import { UserSkillsService } from "./services/userSkills";

let mainWindow: BrowserWindow | undefined;
let quitCleanupStarted = false;
let quitCleanupFinished = false;

const userDataDirOverride = process.env.ACCORDAGENTS_USER_DATA_DIR?.trim();
if (userDataDirOverride) {
  app.setPath("userData", path.resolve(userDataDirOverride));
}

const gitService = new GitService();
const settingsService = new SettingsService();
const agentEnvironmentService = new AgentEnvironmentService(settingsService);
const storageService = new StorageService();
const localFileOpenerService = new LocalFileOpenerService(storageService, settingsService);
const providerRunner = new ProviderRunner();
const debugLogService = new DebugLogService();
setCommandDebugLogger(debugLogService);
const cliAgentRunner = new CliAgentRunner(debugLogService, () => settingsService.getManualAgentEnvironment());
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
const pluginService = new PluginService({
  userSkills: userSkillsService
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
}, userSkillsService, (progress) => mainWindow?.webContents.send("conversations:review-progress", progress));
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
  automaticStopGate: remoteRunService,
  logger: (event, payload) => {
    void debugLogService.write(event, payload);
  }
});
const awsWorkerSetupService = new AwsWorkerSetupService(cloudRunAwsService, cloudRunDoctorService, settingsService);
void awsWorkerSetupService.recoverInterruptedOperation();
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
appMcpService.setChatCompactionRequestHandler((actor, request) => chatService.requestSelfCompactionFromTool(actor, request));
appMcpService.setChatParticipantRequestStatusHandler((actor, request) => chatService.participantRequestStatusForTool(actor, request));
appMcpService.setChatReactHandler((actor, request) => chatService.reactToMessageFromTool(actor, request));
appMcpService.setChatSendMessageHandler((actor, request) => chatService.sendChatMessageFromTool(actor, request));
appMcpService.setChatSetTitleHandler((actor, request) => chatService.setChatTitleFromTool(actor, request));
// Artifacts persist in their own tables of the same SQLite database as
// conversations, but independently of conversation payloads.
const artifactStore = new ArtifactStore(path.join(app.getPath("userData"), "accordagents.sqlite3"));
const artifactService = new ArtifactService({
  store: artifactStore,
  getMembers: async (conversationId) => {
    const conversation = await storageService.getConversation(conversationId);
    if (!conversation || conversation.kind !== "chat") {
      return undefined;
    }
    return artifactMembersForConversation(conversation);
  },
  postNote: (conversationId, eventId, content) => chatService.postArtifactChatNote(conversationId, eventId, content),
  onChanged: (conversationId) => {
    mainWindow?.webContents.send("artifacts:updated", { conversationId });
  },
  logger: (event, payload) => {
    void debugLogService.write(event, payload);
  }
});
chatService.setArtifactCleanup((conversationId) => artifactService.deleteConversationArtifacts(conversationId));
appMcpService.setArtifactToolHandler(async (actor, toolName, request) => {
  let member: string;
  try {
    member = await chatService.artifactActorMember(actor);
  } catch (error) {
    return {
      ok: false,
      error: { code: "access_denied", message: error instanceof Error ? error.message : String(error) }
    };
  }
  return dispatchArtifactTool(member, actor.conversationId, toolName, request);
});
const activeReviews = new Map<string, AbortController>();

function artifactToolNumber(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return Number.NaN;
}

function artifactToolOptionalNumber(value: unknown): number | undefined {
  return value === undefined || value === null ? undefined : artifactToolNumber(value);
}

function artifactToolString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function artifactToolStringArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function artifactToolAudiencePolicy(value: unknown): ArtifactDraftAudiencePolicyByAuthor {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(Object.entries(value).map(([author, rawPolicy]) => {
    const policy = rawPolicy && typeof rawPolicy === "object" && !Array.isArray(rawPolicy)
      ? rawPolicy as Record<string, unknown>
      : {};
    return [author, {
      allowedReaders: artifactToolStringArray(policy.allowedReaders) ?? [],
      requiredReaders: artifactToolStringArray(policy.requiredReaders) ?? []
    }];
  }));
}

function artifactToolSources(value: unknown): PublishArtifactSourceRequest[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }
    const source = entry as Record<string, unknown>;
    const draftId = artifactToolString(source.draftId);
    const disposition = source.disposition === "considered" || source.disposition === "excluded"
      ? source.disposition
      : undefined;
    if (!draftId || !disposition) {
      return [];
    }
    return [{
      draftId,
      disposition,
      exclusionRationale: artifactToolString(source.exclusionRationale)
    }];
  });
}

async function dispatchArtifactTool(
  member: string,
  conversationId: string,
  toolName: string,
  rawRequest: unknown
): Promise<unknown> {
  const args = rawRequest && typeof rawRequest === "object" && !Array.isArray(rawRequest)
    ? rawRequest as Record<string, unknown>
    : {};
  const ref = {
    artifactId: artifactToolString(args.artifactId),
    name: artifactToolString(args.name)
  };
  switch (toolName) {
    case APP_ARTIFACT_LIST_TOOL:
      return artifactService.list(member, conversationId);
    case APP_ARTIFACT_READ_TOOL:
      return artifactService.read(member, {
        conversationId,
        ...ref,
        version: artifactToolOptionalNumber(args.version),
        includeHistory: args.includeHistory === true
      });
    case APP_ARTIFACT_DIFF_TOOL:
      return artifactService.diff(member, {
        conversationId,
        ...ref,
        fromVersion: artifactToolNumber(args.fromVersion),
        toVersion: artifactToolNumber(args.toVersion)
      });
    case APP_ARTIFACT_CREATE_TOOL: {
      const validationError = validateArtifactCreateToolRequest(args);
      if (validationError) {
        return { ok: false, error: { code: "invalid_request", message: validationError } };
      }
      return artifactService.create(member, args.initialState === "collecting_drafts" ? {
        conversationId,
        name: typeof args.name === "string" ? args.name : "",
        initialState: "collecting_drafts",
        contributors: artifactToolStringArray(args.contributors),
        labels: artifactToolStringArray(args.labels),
        allowedDraftAuthors: artifactToolStringArray(args.allowedDraftAuthors) ?? [],
        requiredDraftAuthors: artifactToolStringArray(args.requiredDraftAuthors) ?? [],
        audiencePolicyByAuthor: artifactToolAudiencePolicy(args.audiencePolicyByAuthor),
        operationId: typeof args.operationId === "string" ? args.operationId : ""
      } : {
        conversationId,
        name: typeof args.name === "string" ? args.name : "",
        initialState: "published",
        content: typeof args.content === "string" ? args.content : "",
        note: artifactToolString(args.note),
        contributors: artifactToolStringArray(args.contributors),
        requiredSigners: artifactToolStringArray(args.requiredSigners),
        labels: artifactToolStringArray(args.labels)
      });
    }
    case APP_ARTIFACT_DRAFT_LIST_TOOL:
      return artifactService.listDrafts(member, { conversationId, ...ref });
    case APP_ARTIFACT_DRAFT_READ_TOOL:
      return artifactService.readDraft(member, {
        conversationId,
        ...ref,
        draftId: typeof args.draftId === "string" ? args.draftId : ""
      });
    case APP_ARTIFACT_DRAFT_SAVE_TOOL:
      return artifactService.saveDraft(member, {
        conversationId,
        ...ref,
        draftId: artifactToolString(args.draftId),
        expectedEditRevision: artifactToolNumber(args.expectedEditRevision),
        content: typeof args.content === "string" ? args.content : "",
        readers: artifactToolStringArray(args.readers) ?? [],
        operationId: typeof args.operationId === "string" ? args.operationId : ""
      });
    case APP_ARTIFACT_DRAFT_SUBMIT_TOOL:
      return artifactService.submitDraft(member, {
        conversationId,
        ...ref,
        draftId: typeof args.draftId === "string" ? args.draftId : "",
        expectedEditRevision: artifactToolNumber(args.expectedEditRevision),
        operationId: typeof args.operationId === "string" ? args.operationId : ""
      });
    case APP_ARTIFACT_DRAFT_REPLACE_TOOL:
      return artifactService.replaceDraft(member, {
        conversationId,
        ...ref,
        supersedesDraftId: typeof args.supersedesDraftId === "string" ? args.supersedesDraftId : "",
        content: typeof args.content === "string" ? args.content : "",
        readers: artifactToolStringArray(args.readers) ?? [],
        operationId: typeof args.operationId === "string" ? args.operationId : ""
      });
    case APP_ARTIFACT_DRAFT_WITHDRAW_TOOL:
      return artifactService.withdrawDraft(member, {
        conversationId,
        ...ref,
        draftId: typeof args.draftId === "string" ? args.draftId : "",
        operationId: typeof args.operationId === "string" ? args.operationId : ""
      });
    case APP_ARTIFACT_DRAFT_SET_ROSTER_TOOL:
      return artifactService.updateDraftRoster(member, {
        conversationId,
        ...ref,
        allowedDraftAuthors: artifactToolStringArray(args.allowedDraftAuthors) ?? [],
        requiredDraftAuthors: artifactToolStringArray(args.requiredDraftAuthors) ?? [],
        audiencePolicyByAuthor: artifactToolAudiencePolicy(args.audiencePolicyByAuthor),
        expectedDraftRosterRevision: artifactToolNumber(args.expectedDraftRosterRevision),
        operationId: typeof args.operationId === "string" ? args.operationId : ""
      });
    case APP_ARTIFACT_PUBLISH_TOOL:
      return artifactService.publish(member, {
        conversationId,
        ...ref,
        content: typeof args.content === "string" ? args.content : "",
        note: artifactToolString(args.note),
        requiredSigners: artifactToolStringArray(args.requiredSigners) ?? [],
        sources: artifactToolSources(args.sources),
        operationId: typeof args.operationId === "string" ? args.operationId : ""
      });
    case APP_ARTIFACT_REVISE_TOOL:
      return artifactService.revise(member, {
        conversationId,
        ...ref,
        baseVersion: artifactToolNumber(args.baseVersion),
        content: typeof args.content === "string" ? args.content : "",
        note: artifactToolString(args.note)
      });
    case APP_ARTIFACT_RENAME_TOOL:
      return artifactService.rename(member, {
        conversationId,
        ...ref,
        newName: typeof args.newName === "string" ? args.newName : ""
      });
    case APP_ARTIFACT_SIGN_TOOL:
      return artifactService.sign(member, {
        conversationId,
        ...ref,
        version: artifactToolOptionalNumber(args.version)
      });
    case APP_ARTIFACT_SET_ACCESS_TOOL:
      return artifactService.updateAccess(member, {
        conversationId,
        ...ref,
        owner: artifactToolString(args.owner),
        contributors: artifactToolStringArray(args.contributors),
        requiredSigners: artifactToolStringArray(args.requiredSigners),
        labels: artifactToolStringArray(args.labels)
      });
    default:
      throw new Error(`Unknown artifact tool: ${toolName}.`);
  }
}

function appSkillsSourceRoot(): string {
  return app.isPackaged
    ? path.join(__dirname, "appSkills")
    : path.join(process.cwd(), "src/main/appSkills");
}

async function detectAgentsWithAppSkills(request?: AgentDetectionRequest): Promise<AgentHealth[]> {
  const agents = await cliAgentRunner.detectAgents(request);
  if (request?.trigger === "focus" || request?.trigger === "submit") {
    const cached = agents.map((agent) => ({
      ...agent,
      appSkillSync: appSkillsService.statusForAgent(agent)
    }));
    if (cached.every((agent) => agent.appSkillSync)) {
      return cached;
    }
  }
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

async function openTerminal(): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("Open Terminal is available on macOS only.");
  }
  const candidates = [
    "/System/Applications/Utilities/Terminal.app",
    "/Applications/Utilities/Terminal.app"
  ];
  for (const candidate of candidates) {
    const error = await shell.openPath(candidate);
    if (!error) {
      return;
    }
  }
  throw new Error("Terminal could not be opened.");
}

function createWindow(): void {
  const windowTitle = process.env.ACCORDAGENTS_WINDOW_TITLE?.trim() || "AccordAgents";
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 1080,
    minHeight: 720,
    title: windowTitle,
    backgroundColor: "#f5f2ec",
    ...(process.platform === "darwin" ? {
      titleBarStyle: "hiddenInset" as const,
      trafficLightPosition: { x: 16, y: 16 }
    } : {}),
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.on("page-title-updated", (event) => {
    if (windowTitle !== "AccordAgents") {
      event.preventDefault();
      mainWindow?.setTitle(windowTitle);
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
  const operationId = randomUUID();
  return cloudRunAwsService.withRunReference(operationId, async () => {
    const workerSettings = await cloudRunAwsService.ensureWorkerForRun();
    const worker = cloudRunWorkerTargetFromSettings(workerSettings);
    if (!worker) {
      throw new Error("The AWS worker did not provide a valid SSH target.");
    }
    const lease = await remoteRunService.acquireWorkerOperationLease(
      worker,
      operationId,
      "settings-worker-operation"
    );
    const renewalTimer = setInterval(() => {
      void remoteRunService.renewWorkerOperationLease(worker, lease).then((renewed) => {
        lease.expiresAt = renewed.expiresAt;
      }).catch((error) => {
        void debugLogService.write("cloud-runs.operation-lease.renew-error", {
          message: error instanceof Error ? error.message : String(error)
        });
      });
    }, 10_000);
    renewalTimer.unref?.();
    try {
      return await action(workerSettings);
    } finally {
      clearInterval(renewalTimer);
      await remoteRunService.releaseWorkerOperationLease(worker, lease).catch((error) => {
        void debugLogService.write("cloud-runs.operation-lease.release-error", {
          message: error instanceof Error ? error.message : String(error)
        });
      });
    }
  });
}

function registerIpc(): void {
  ipcMain.handle("app:get-version", () => app.getVersion());
  ipcMain.handle("app:open-external", (_event, url: unknown) => openExternalUrl(url));
  ipcMain.handle("app:open-terminal", () => openTerminal());
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
  ipcMain.handle("settings:set-chat-participant-request-prompt-max-chars", (_event, maxChars: number) => {
    return settingsService.setChatParticipantRequestPromptMaxChars(maxChars);
  });
  ipcMain.handle("settings:set-chat-auto-watch-wake-limit", (_event, limit: number) => {
    return settingsService.setChatAutoWatchWakeLimit(limit);
  });
  ipcMain.handle("settings:set-chat-prompt-context", (_event, settings: ChatPromptContextSettings) => {
    return settingsService.setChatPromptContext(settings);
  });
  ipcMain.handle("settings:save-cloud-runs", (_event, update: CloudRunsSettingsUpdate) => settingsService.saveCloudRunsSettings(update));
  ipcMain.handle("cloud-runs:test-worker", async (_event, request?: CloudRunWorkerSettings) => {
    return withCloudRunWorker(request, testCloudRunWorker);
  });
  ipcMain.handle("cloud-runs:diagnose-worker", async (_event, request?: CloudRunWorkerSettings) => {
    const managedAws = !request && (await settingsService.getPublicSettings()).cloudRuns.mode === "aws";
    return withCloudRunWorker(request, (worker) => cloudRunDoctorService.diagnose(worker, {
      requirePersistentStorage: managedAws
    }));
  });
  ipcMain.handle("cloud-runs:setup-worker", async (_event, request?: CloudRunWorkerSettings) => {
    const managedAws = !request && (await settingsService.getPublicSettings()).cloudRuns.mode === "aws";
    return withCloudRunWorker(request, (worker) => cloudRunDoctorService.setup(worker, (progress) => {
      mainWindow?.webContents.send("cloud-runs:setup-progress", progress);
    }, { requirePersistentStorage: managedAws }));
  });
  ipcMain.handle("cloud-runs:aws-bootstrap-command", (_event, region: string) =>
    cloudRunAwsService.bootstrapCommand(String(region ?? "").trim() || "us-east-1"));
  ipcMain.handle("cloud-runs:aws-connect", (_event, request: ConnectAwsWorkerRequest) =>
    cloudRunAwsService.connectWorker(request.blob, request.instanceType, request.rootVolumeSizeGb));
  ipcMain.handle("cloud-runs:aws-start", (event, request: AwsWorkerStartRequest) =>
    awsWorkerSetupService.start(request, (progress) => {
      if (!event.sender.isDestroyed()) event.sender.send("cloud-runs:aws-progress", progress);
    }));
  ipcMain.handle("cloud-runs:aws-status", () => cloudRunAwsService.status());
  ipcMain.handle("cloud-runs:aws-stop", () => cloudRunAwsService.stopWorker());
  ipcMain.handle("cloud-runs:aws-delete", () => cloudRunAwsService.deleteWorker());
  ipcMain.handle("settings:get-agent-environment", () => agentEnvironmentService.snapshot());
  ipcMain.handle("settings:save-agent-environment-variable", async (_event, request: SaveAgentEnvironmentVariableRequest) => {
    await settingsService.saveAgentEnvironmentVariable(request);
    await cliAgentRunner.shutdownWarmAgents();
    cliAgentRunner.invalidateAgentReadiness();
    return agentEnvironmentService.snapshot();
  });
  ipcMain.handle("settings:delete-agent-environment-variable", async (_event, request: DeleteAgentEnvironmentVariableRequest) => {
    await settingsService.deleteAgentEnvironmentVariable(request.key);
    await cliAgentRunner.shutdownWarmAgents();
    cliAgentRunner.invalidateAgentReadiness();
    return agentEnvironmentService.snapshot();
  });
  ipcMain.handle("settings:update-provider", async (_event, update: ProviderSettingsUpdate) => {
    const next = await settingsService.updateProvider(update);
    if (typeof update.enabled === "boolean") {
      cliAgentRunner.invalidateAgentReadiness();
      if (update.enabled) {
        void detectAgentsWithAppSkills({ force: true, trigger: "provider-enabled" }).catch(() => undefined);
      }
    }
    return next;
  });
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
    if (kind === "codex-cli" || kind === "claude-code" || kind === "gemini-cli") {
      const settings = await settingsService.getPublicSettings();
      const configuredModel = settings.providers.find((provider) => provider.kind === kind)?.model;
      return cliAgentRunner.listModelCatalog(kind, configuredModel);
    }
    return providerRunner.listModelCatalog(kind);
  });
  ipcMain.handle("agents:detect", async (_event, request?: AgentDetectionRequest) => {
    const agents = await detectAgentsWithAppSkills(normalizeAgentDetectionRequest(request));
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
        assistantProviderKind: request?.assistantProviderKind,
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
  ipcMain.handle("skills:list-all", (_event, request?: UserSkillListRequest) => {
    return userSkillsService.listAll({
      repoPath: typeof request?.repoPath === "string" ? request.repoPath : undefined,
      query: typeof request?.query === "string" ? request.query : undefined,
      limit: typeof request?.limit === "number" ? request.limit : undefined
    });
  });
  ipcMain.handle("plugins:list", async (_event, request?: PluginListRequest) => {
    const resolved = await resolvePluginListRequest(request);
    return pluginService.list(resolved.request, resolved.skills);
  });
  ipcMain.handle("plugins:refresh", async (_event, request?: PluginListRequest) => {
    const resolved = await resolvePluginListRequest(request);
    return pluginService.refresh(resolved.request, resolved.skills);
  });
  ipcMain.handle("conversations:list", () => storageService.listConversations());
  ipcMain.handle("conversations:list-activity", (_event, request?: ListChatActivityRequest) => storageService.listChatActivity(request));
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
  ipcMain.handle("chat:delete", async (_event, request: DeleteChatConversationRequest) => {
    return chatService.deleteConversation(request);
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
        { ...request, triggeredBy: "user", runId },
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
  // Artifact operations from the renderer act as the human chat member ("user").
  ipcMain.handle("artifacts:list", (_event, request: ListArtifactsRequest) =>
    artifactService.list(ARTIFACT_USER_MEMBER, request?.conversationId ?? ""));
  ipcMain.handle("artifacts:read", (_event, request: ReadArtifactRequest) =>
    artifactService.read(ARTIFACT_USER_MEMBER, request));
  ipcMain.handle("artifacts:diff", (_event, request: DiffArtifactRequest) =>
    artifactService.diff(ARTIFACT_USER_MEMBER, request));
  ipcMain.handle("artifacts:create", (_event, request: CreateArtifactRequest) =>
    artifactService.create(ARTIFACT_USER_MEMBER, request));
  ipcMain.handle("artifacts:revise", (_event, request: ReviseArtifactRequest) =>
    artifactService.revise(ARTIFACT_USER_MEMBER, request));
  ipcMain.handle("artifacts:rename", (_event, request: RenameArtifactRequest) =>
    artifactService.rename(ARTIFACT_USER_MEMBER, request));
  ipcMain.handle("artifacts:sign", (_event, request: SignArtifactRequest) =>
    artifactService.sign(ARTIFACT_USER_MEMBER, request));
  ipcMain.handle("artifacts:set-access", (_event, request: UpdateArtifactAccessRequest) =>
    artifactService.updateAccess(ARTIFACT_USER_MEMBER, request));
  ipcMain.handle("artifacts:drafts:list", (_event, request: ListArtifactDraftsRequest) =>
    artifactService.listDrafts(ARTIFACT_USER_MEMBER, request));
  ipcMain.handle("artifacts:drafts:read", (_event, request: ReadArtifactDraftRequest) =>
    artifactService.readDraft(ARTIFACT_USER_MEMBER, request));
  ipcMain.handle("artifacts:drafts:save", (_event, request: SaveArtifactDraftRequest) =>
    artifactService.saveDraft(ARTIFACT_USER_MEMBER, request));
  ipcMain.handle("artifacts:drafts:submit", (_event, request: SubmitArtifactDraftRequest) =>
    artifactService.submitDraft(ARTIFACT_USER_MEMBER, request));
  ipcMain.handle("artifacts:drafts:replace", (_event, request: ReplaceArtifactDraftRequest) =>
    artifactService.replaceDraft(ARTIFACT_USER_MEMBER, request));
  ipcMain.handle("artifacts:drafts:withdraw", (_event, request: WithdrawArtifactDraftRequest) =>
    artifactService.withdrawDraft(ARTIFACT_USER_MEMBER, request));
  ipcMain.handle("artifacts:drafts:set-roster", (_event, request: UpdateArtifactDraftRosterRequest) =>
    artifactService.updateDraftRoster(ARTIFACT_USER_MEMBER, request));
  ipcMain.handle("artifacts:publish", (_event, request: PublishArtifactRequest) =>
    artifactService.publish(ARTIFACT_USER_MEMBER, request));
  ipcMain.handle("dialog:select-repo", async () => {
    const options: Electron.OpenDialogOptions = {
      title: "Select repository",
      properties: ["openDirectory"]
    };
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    return result.canceled ? undefined : result.filePaths[0];
  });
}

function normalizeAgentDetectionRequest(value: unknown): AgentDetectionRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const record = value as Partial<AgentDetectionRequest>;
  const trigger = record.trigger === "initial" || record.trigger === "focus" || record.trigger === "manual" ||
    record.trigger === "submit" || record.trigger === "provider-enabled" || record.trigger === "service"
    ? record.trigger
    : undefined;
  return { force: record.force === true, trigger };
}

async function resolvePluginListRequest(request?: PluginListRequest): Promise<{
  request: PluginListRequest;
  skills?: UserSkillSummary[];
}> {
  const conversationId = typeof request?.conversationId === "string" ? request.conversationId : undefined;
  const query = typeof request?.query === "string" ? request.query : "";
  const content = typeof request?.content === "string" ? request.content : "";
  const limit = typeof request?.limit === "number" ? request.limit : undefined;
  if (conversationId) {
    const conversation = await storageService.getConversation(conversationId);
    if (!conversation || conversation.kind !== "chat") {
      return {
        request: { conversationId, query, content, limit },
        skills: []
      };
    }
    const skills = await userSkillsService.search(
      { conversationId: conversation.id, query, content, limit: 100 },
      chatService.userSkillRunContext(conversation, content)
    );
    return {
      request: { conversationId, repoPath: conversation.repoPath, query, content, limit },
      skills: skills.skills
    };
  }
  const repoPath = typeof request?.repoPath === "string" ? request.repoPath : undefined;
  const participants = Array.isArray(request?.participants) ? request.participants : undefined;
  if (participants) {
    const skills = await userSkillsService.search(
      { repoPath, participants, query, content, limit: 100 },
      await chatService.prospectiveUserSkillRunContext({
        repoPath,
        participants,
        assistantProviderKind: request?.assistantProviderKind,
        content
      })
    );
    return {
      request: { repoPath, participants, assistantProviderKind: request?.assistantProviderKind, query, content, limit },
      skills: skills.skills
    };
  }
  return {
    request: { repoPath, query, content, limit }
  };
}

void app.whenReady().then(async () => {
  registerIpc();
  bootstrapAppUpdater(debugLogService);
  await appMcpService.start();
  await storageService.init();
  await artifactService.flushPendingArtifactEvents().catch((error) => {
    void debugLogService.write("artifacts.outbox.startup-error", {
      message: error instanceof Error ? error.message : String(error)
    });
  });
  await chatService.reconcileDeletedConversationArtifacts().catch((error) => {
    void debugLogService.write("chat.delete.artifacts.reconcile-error", {
      message: error instanceof Error ? error.message : String(error)
    });
  });
  await chatService.reconcileTerminalRemoteRunState().catch((error) => {
    void debugLogService.write("chat.remote-run.reconcile-terminal-state.error", {
      message: error instanceof Error ? error.message : String(error)
    });
  });
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

app.on("before-quit", (event) => {
  if (quitCleanupFinished) {
    return;
  }
  event.preventDefault();
  if (quitCleanupStarted) {
    return;
  }
  quitCleanupStarted = true;
  const cleanup = Promise.allSettled([
    remoteRunCoordinator.shutdownIdleSessions(),
    cliAgentRunner.shutdownWarmAgents(),
    appMcpService.stop()
  ]);
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5_000));
  void Promise.race([cleanup.then(() => undefined), timeout]).finally(() => {
    quitCleanupFinished = true;
    app.quit();
  });
});

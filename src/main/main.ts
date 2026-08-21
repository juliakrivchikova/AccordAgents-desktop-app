import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { app, autoUpdater, BrowserWindow, dialog, ipcMain, shell } from "electron";
import type {
  AddChatParticipantRequest,
  AgentDetectionRequest,
  DeleteAgentEnvironmentVariableRequest,
  AgentHealth,
  ChatBehaviorRuleConfigUpdate,
  ChatMessage,
  ChatParticipant,
  ChatProviderKind,
  ChatPromptContextSettings,
  ChatSavedPromptConfigUpdate,
  CloudRunsSettingsUpdate,
  CloudRunWorkerSettings,
  ConnectAwsWorkerRequest,
  CreateMobilePairingRequest,
  RevokeMobilePairingRequest,
  RevokeMobilePairingResult,
  StoredPendingMailboxRevocation,
  AwsWorkerStartRequest,
  CompactChatParticipantRequest,
  ChatParticipantConfigUpdate,
  ChatRoleConfigUpdate,
  ComposeImplementationPlanRequest,
  ContinueReviewRequest,
  Conversation,
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
  SetArtifactArchivedRequest,
  SignArtifactRequest,
  SubmitArtifactDraftRequest,
  UpdateArtifactDraftRosterRequest,
  WithdrawArtifactDraftRequest,
  UpdateArtifactAccessRequest,
  ReviewProgress
} from "../shared/types";
import { ARTIFACT_USER_MEMBER } from "../shared/types";
import { artifactMembersForConversation } from "../shared/artifacts";
import { normalizeExternalUrlForOpen } from "../shared/externalLinks";
import { ArtifactService } from "./services/artifacts";
import { ArtifactStore } from "./services/artifactStore";
import { validateArtifactCreateToolRequest } from "./services/artifactToolRequest";
import { ChatEventLogService } from "./services/chatEventLog";
import { ChatEventMirrorService, chatEventMirrorOptionsFromEnv } from "./services/chatEventMirror";
import { ChatService } from "./services/chat";
import { MobilePairingService } from "./services/mobilePairing";
import { MobileProgressEnvelopeTracker } from "./services/mobileProgressEnvelopeTracker";
import {
  MobileRelayControlService,
  type MobileRelayChatCatalog,
  type MobileRelayChatListItem,
  type MobileTimelineEvents,
  type MobileTimelineSink
} from "./services/mobileRelayControl";
import {
  collectMobileMailboxOutboxEvents,
  fulfilledMobileEventKeysFromMailboxEvents,
  mobileMailboxEventScopeKey
} from "./services/mobileMailboxOutbox";
import { mobilePairingRequestWithEndpointDefaults, type MobilePairingPackage } from "../shared/mobilePairing";
import {
  chatMessageVisualThreadRootId,
  chatParticipantRequestReplyRootMap
} from "../shared/chatParticipantRequestThreads";
import type { ChatEventEnvelope } from "../shared/chatEvents";
import { readActiveRunIds } from "../shared/chatRunState";
import type { ChatDeviceCapabilityGrantPayload, ChatDeviceCapabilityRevokedPayload } from "../shared/chatDeviceCapabilities";
import { CliAgentRunner } from "./services/cliAgents";
import { ConsensusService } from "./services/consensus";
import { AppMcpService } from "./services/appMcp";
import { acquireMobileMailboxExecutionClaim } from "./services/mobileMailboxClaims";
import {
  deleteMailboxEvents,
  mailboxAccessForSealKey,
  mailboxAuthHeaders,
  mailboxEndpointForSealKey,
  openMailboxEventPayloads,
  classifyMailboxRegistrationFailure,
  registerMailboxForSealKey,
  revokeMailboxForSealKey,
  revokeMailboxWithToken,
  sealMailboxEventPayloads
} from "./services/mailboxAccess";
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
  APP_ARTIFACT_SET_ARCHIVED_TOOL,
  APP_ARTIFACT_SET_ACCESS_TOOL,
  APP_ARTIFACT_SIGN_TOOL
} from "./services/appMcp";
import { AppSkillsService } from "./services/appSkills";
import { AgentEnvironmentService } from "./services/agentEnvironment";
import { bootstrapAppUpdater } from "./services/appUpdater";
import { CommandError, ensureLoginShellEnvPrimed, runCommand, setCommandDebugLogger } from "./services/command";
import { buildCloudRunSshTarget, cloudRunSshOptionArgs, cloudRunWorkerTargetFromSettings, normalizeCloudRunWorkerSettings, validateCloudRunSshWorkerFields } from "./services/cloudRunWorkers";
import { CloudRunDoctorService } from "./services/cloudRunDoctor";
import { CloudRunAwsService } from "./services/cloudRunAws";
import { AwsWorkerSetupService } from "./services/awsWorkerSetup";
import { DebugLogService } from "./services/debugLogs";
import { GitService } from "./services/git";
import { MOBILE_RUNNER_POLICY_KIND, mobileMailboxRunnerInstallCommand, mobileMailboxRunnerPolicyFromConversation } from "./services/mobileMailboxRunner";
import { ProviderRunner } from "./services/providers";
import { RemoteRunService } from "./services/remoteRuns";
import { RemoteRunCoordinator } from "./services/remoteRunCoordinator";
import { LocalFileOpenerService } from "./services/localFileOpener";
import { SettingsService } from "./services/settings";
import { StorageService } from "./services/storage";
import {
  BundledSqliteInstallationError,
  DAMAGED_SQLITE_INSTALLATION_MESSAGE,
  resolveSqliteExecutable,
  validateSqliteExecutable
} from "./services/sqliteCli";
import { PluginService } from "./services/plugins";
import { UserSkillsService } from "./services/userSkills";

let mainWindow: BrowserWindow | undefined;
let quitCleanupStarted = false;
let quitCleanupFinished = false;
let quittingForUpdate = false;

function sendToMainWindow(channel: string, ...args: unknown[]): boolean {
  const window = mainWindow;
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
    return false;
  }
  try {
    window.webContents.send(channel, ...args);
    return true;
  } catch {
    return false;
  }
}

const userDataDirOverride = process.env.ACCORDAGENTS_USER_DATA_DIR?.trim();
if (userDataDirOverride) {
  app.setPath("userData", path.resolve(userDataDirOverride));
}

const gitService = new GitService();
const settingsService = new SettingsService();
const agentEnvironmentService = new AgentEnvironmentService(settingsService);
const sqliteExecutable = resolveSqliteExecutable({
  appPath: app.getAppPath(),
  resourcesPath: process.resourcesPath,
  isPackaged: app.isPackaged
});
const storageService = new StorageService({ sqliteExecutable });
const localFileOpenerService = new LocalFileOpenerService(storageService, settingsService);
const providerRunner = new ProviderRunner();
const debugLogService = new DebugLogService();
setCommandDebugLogger(debugLogService);

function runtimeErrorDetails(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack
    };
  }
  return { message: String(error) };
}

function recordMainProcessRuntimeError(kind: "uncaughtException" | "unhandledRejection", error: unknown, origin?: string): void {
  const details = runtimeErrorDetails(error);
  console.error(`Main process ${kind}:`, error);
  void debugLogService.write("main.runtime-error", {
    kind,
    origin,
    ...details
  });
  if (!mainWindow || mainWindow.isDestroyed()) {
    dialog.showErrorBox("AccordAgents failed", details.message);
    app.quit();
  }
}

process.on("uncaughtException", (error, origin) => {
  recordMainProcessRuntimeError("uncaughtException", error, origin);
});

process.on("unhandledRejection", (reason) => {
  recordMainProcessRuntimeError("unhandledRejection", reason);
});

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
const appMcpService = new AppMcpService(debugLogService);
const chatEventLogService = new ChatEventLogService(storageService);
const chatEventMirrorService = new ChatEventMirrorService(
  storageService,
  chatEventLogService,
  debugLogService,
  chatEventMirrorOptionsFromEnv()
);
const mobilePairingService = new MobilePairingService(chatEventLogService);
const consensusService = new ConsensusService(gitService, storageService, providerRunner, cliAgentRunner, debugLogService, (conversation) => {
  sendToMainWindow("conversations:updated", conversation);
});
const MOBILE_RELAY_CONNECT_TIMEOUT_MS = 8_000;
const MOBILE_MAILBOX_POLL_INTERVAL_MS = 2_500;
const MOBILE_MAILBOX_OWNER_ACTION_BACKOFF_MS = 5 * 60_000;
const MOBILE_EVENT_EXECUTION_CLAIM_TTL_MS = 45_000;
const mobileRelayControls = new Map<string, MobileRelayControlService>();
const mobileMailboxPollers = new Map<string, NodeJS.Timeout>();
const mobilePairingsByKey = new Map<string, MobilePairingPackage>();
// W1 arrival cursors, per pairing. Persisted with paired devices so a restart
// does not re-read the whole mailbox.
const mobileMailboxCursors = new Map<string, { epoch: string; cursor: number }>();
// W3/W-A bookkeeping: which published envelopes may be deleted early, decided
// per envelope rather than per run. See mobileProgressEnvelopeTracker.
const mobileProgressEnvelopes = new MobileProgressEnvelopeTracker();
// Phones that have actually connected, mapped to when they first connected.
// These survive restarts and never expire on a timer; only an explicit revoke
// removes them.
const mobileClaimedPairingKeys = new Map<string, string>();
const mobileMailboxRunnerStarts = new Map<string, Promise<boolean>>();
const mobilePairingExpiryTimers = new Map<string, NodeJS.Timeout>();
const mobileRevokedPairingKeys = new Set<string>();
let mobileMailboxOwnerActionBackoffUntil = 0;
const chatService = new ChatService(storageService, settingsService, cliAgentRunner, debugLogService, appMcpService, (conversation) => {
  sendToMainWindow("conversations:updated", conversation);
  for (const control of mobileRelayControls.values()) {
    control.pushConversationSnapshot(conversation);
  }
  void publishMobileRunnerPoliciesForConversation(conversation);
}, userSkillsService, (progress) => emitReviewProgress(progress), chatEventMirrorService, (conversation, messages) => {
  // W-C: an interrupted run's recovered terminals are the only thing that will
  // ever tell a paired phone that run is over.
  for (const control of mobileRelayControls.values()) {
    control.pushRecoveredRunTerminals(conversation, messages);
  }
});
// W-M: every progress path must reach the paired phones, not only the
// renderer. Interactive runs (chat:send, accord, compaction) pass their own
// per-run callback, which used to carry only the window delivery — the
// constructor-level fan-out was bypassed and phones went silent for every
// interactively started run, which is all of them.
function emitReviewProgress(progress: ReviewProgress): void {
  sendToMainWindow("conversations:review-progress", progress);
  for (const control of mobileRelayControls.values()) {
    control.noteExternalChatProgress(progress);
  }
}

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
chatService.setCloudRunDoctorService(cloudRunDoctorService);
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
appMcpService.setChatParticipantActivityHandler((actor) => chatService.describeChatParticipantActivityForTool(actor));
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
const artifactStore = new ArtifactStore(path.join(app.getPath("userData"), "accordagents.sqlite3"), sqliteExecutable);
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
    sendToMainWindow("artifacts:updated", { conversationId });
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
    case APP_ARTIFACT_SET_ARCHIVED_TOOL:
      return artifactService.setArchived(member, {
        conversationId,
        ...ref,
        archived: args.archived as boolean
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
      await settingsService.ensureAssistantProviderDefault(cached);
      return cached;
    }
  }
  const reconciled: AgentHealth[] = await appSkillsService.reconcileAgents(agents).catch((error): AgentHealth[] => {
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
  await settingsService.ensureAssistantProviderDefault(reconciled);
  return reconciled;
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
  const window = new BrowserWindow({
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
  mainWindow = window;
  window.on("close", () => {
    if (mainWindow === window) {
      mainWindow = undefined;
    }
  });
  window.webContents.on("destroyed", () => {
    if (mainWindow === window) {
      mainWindow = undefined;
    }
  });
  window.webContents.on("render-process-gone", () => {
    if (mainWindow === window) {
      mainWindow = undefined;
    }
  });
  window.on("page-title-updated", (event) => {
    if (windowTitle !== "AccordAgents") {
      event.preventDefault();
      window.setTitle(windowTitle);
    }
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    void window.loadURL(devServerUrl);
    window.webContents.openDevTools({ mode: "detach" });
  } else {
    void window.loadFile(path.join(__dirname, "../../renderer/index.html"));
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
    ...cloudRunSshOptionArgs(normalized as CloudRunWorkerSettings & { host: string }),
    target,
    "command -v codex >/dev/null && printf ok"
  ];
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

// W-I: a registration the relay refused outright can never succeed on retry —
// registration is trust-on-first-use, so the scope id is already taken. The
// lockout set stops the self-heal loop; the warning names the fix.
const mobileRegistrationLockouts = new Set<string>();
// W-G(e): remote-revoked handling runs once per pairing; the teardown below
// is not idempotent against concurrent poll/publish failures.
const mobileRemoteRevokedHandled = new Set<string>();

function mobilePairingConversationId(pairing: MobilePairingPackage): string | undefined {
  return pairing.capabilities.find((capability) => capability.scope === "conversation")?.conversationId;
}

/** W-G(e): the relay reports this mailbox as tombstoned. Terminal by design —
 *  polling and self-heal registration stop, the pairing is dropped and
 *  persisted as gone, and the paired conversation carries the warning. A
 *  desktop restored from an old backup must not silently resurrect a revoked
 *  mailbox. */
async function handleRemoteMailboxRevoked(pairing: MobilePairingPackage): Promise<void> {
  const key = mobilePairingKey(pairing);
  if (mobileRemoteRevokedHandled.has(key)) {
    return;
  }
  mobileRemoteRevokedHandled.add(key);
  mobileRevokedPairingKeys.add(key);
  mobileClaimedPairingKeys.delete(key);
  mobilePairingsByKey.delete(key);
  mobileMailboxCursors.delete(key);
  mobileRelayControls.get(pairing.rendezvousId)?.close();
  mobileRelayControls.delete(pairing.rendezvousId);
  const poller = mobileMailboxPollers.get(key);
  if (poller) {
    clearInterval(poller);
    mobileMailboxPollers.delete(key);
  }
  await persistMobilePairedDevices();
  await debugLogService.write("mobile.pairing.revoked-remote", {
    routingId: pairing.stableRoutingId,
    rendezvousId: pairing.rendezvousId
  });
  const conversationId = mobilePairingConversationId(pairing);
  if (conversationId) {
    await chatService.recordConversationWarning(
      conversationId,
      "The relay reports the paired phone's mailbox as revoked, so the pairing was stopped. Create a new pairing link to reconnect the phone."
    );
  }
}

function isRemoteRevokedMailboxBody(body: string): boolean {
  return body.includes("mailbox_revoked");
}

async function ensureMailboxRegisteredForPairing(pairing: MobilePairingPackage): Promise<boolean> {
  if (!pairing.outboxUrl) {
    return false;
  }
  const key = mobilePairingKey(pairing);
  if (mobileRegistrationLockouts.has(key) || mobileRevokedPairingKeys.has(key)) {
    return false;
  }
  try {
    const result = await registerMailboxForSealKey(pairing.outboxUrl, pairing.relaySealKeyBase64);
    if (!result.ok) {
      await debugLogService.write("mobile.mailbox.register-error", {
        routingId: pairing.stableRoutingId,
        status: result.status,
        message: result.error ?? ""
      });
      const failure = classifyMailboxRegistrationFailure(result);
      if (failure === "revoked") {
        await handleRemoteMailboxRevoked(pairing);
      } else if (failure === "lockout") {
        mobileRegistrationLockouts.add(key);
        await debugLogService.write("mobile.mailbox.register-lockout", {
          routingId: pairing.stableRoutingId
        });
        const conversationId = mobilePairingConversationId(pairing);
        if (conversationId) {
          await chatService.recordConversationWarning(
            conversationId,
            "The relay refused this pairing's mailbox registration, which can happen when the mailbox was claimed while the relay was unreachable. The phone cannot connect on this link; re-pair it with a fresh link."
          );
        }
      }
    }
    return result.ok;
  } catch (error) {
    await debugLogService.write("mobile.mailbox.register-error", {
      routingId: pairing.stableRoutingId,
      message: error instanceof Error ? error.message : String(error)
    });
    return false;
  }
}

async function startMobileRelayControlForPairing(pairing: MobilePairingPackage): Promise<void> {
  if (!pairing.relayUrl) {
    return;
  }
  // Idempotent re-register: covers pairings created while the relay was
  // unreachable and pairings persisted before mailboxes required a lock.
  void ensureMailboxRegisteredForPairing(pairing);
  const conversationCapability = pairing.capabilities.find((capability) => capability.scope === "conversation");
  mobileRelayControls.get(pairing.rendezvousId)?.close();
  mobilePairingsByKey.set(mobilePairingKey(pairing), pairing);
  scheduleMobilePairingExpiry(pairing);
  const timelineSink = mobileTimelineSinkForPairing(pairing);
  const control = new MobileRelayControlService(
    {
      relayUrl: pairing.relayUrl,
      rendezvousId: pairing.rendezvousId,
      relayCapability: pairing.fingerprint,
      relaySealKeyBase64: pairing.relaySealKeyBase64,
      ...(conversationCapability ? { conversationId: conversationCapability.conversationId } : {}),
      streamId: `${pairing.stableRoutingId}:phone`,
      isActive: () => isMobilePairingActive(pairing),
      onPhoneActivity: () => {
        void noteMobilePairingClaimed(pairing);
      }
    },
    {
      sendMessage: (request, signal, progress) => chatService.sendMessage(request, signal, progress),
      hasAcceptedMobileEvent: (conversationId, eventId) => chatService.hasAcceptedMobileEvent(conversationId, eventId),
      hasMobileMailboxResultForMobileEvent: (conversationId, eventId) =>
        hasFulfilledMobileMailboxEvent(pairing, conversationId, eventId),
      tryAcquireMobileEventExecution: (event, runId) =>
        acquireDesktopMobileExecutionClaim(pairing, event.conversationId, event.eventId, runId),
      cancelRun: (conversationId, runId) => cancelMobileChatRun(conversationId, runId)
    },
    mobileRelayChatCatalog(),
    (progress) => emitReviewProgress(progress),
    timelineSink
  );
  control.onSnapshotDiagnostic = (detail) => {
    void debugLogService.write("mobile.snapshot.run-state", {
      routingId: pairing.stableRoutingId,
      ...detail
    });
  };
  control.onLiveDiagnostic = (detail) => {
    void debugLogService.write("mobile.live.frame", {
      routingId: pairing.stableRoutingId,
      ...detail
    });
  };
  mobileRelayControls.set(pairing.rendezvousId, control);
  startMobileMailboxPollingForPairing(pairing, control);
  const connect = control.connect();
  connect.catch(() => undefined);
  try {
    await promiseWithTimeout(connect, MOBILE_RELAY_CONNECT_TIMEOUT_MS, "Mobile relay tunnel connection timed out.");
  } catch (error) {
    await debugLogService.write("mobile.relay.connect-error", {
      routingId: pairing.stableRoutingId,
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

async function recordMobilePairingCapabilityGrant(pairing: MobilePairingPackage): Promise<void> {
  const conversationCapabilities = pairing.capabilities.filter((capability) => capability.scope === "conversation");
  if (conversationCapabilities.length === 0) {
    return;
  }
  const deviceOriginId = mobileOriginIdForPairing(pairing);
  const grantId = mobilePairingGrantId(pairing);
  const payload: ChatDeviceCapabilityGrantPayload = {
    grantId,
    deviceOriginId,
    deviceKeyId: `mobile:${deviceOriginId}`,
    capabilities: pairing.capabilities,
    grantedAt: pairing.createdAt,
    expiresAt: pairing.expiresAt
  };
  for (const capability of conversationCapabilities) {
    await chatEventLogService.appendLocalEvent({
      conversationId: capability.conversationId,
      logScopeId: capability.conversationId,
      kind: "device.capability.granted",
      payload
    });
  }
}

async function revokeMobilePairingInternal(
  pairing: MobilePairingPackage,
  reason: string
): Promise<RevokeMobilePairingResult> {
  const key = mobilePairingKey(pairing);
  const revokedAt = new Date().toISOString();
  mobileRevokedPairingKeys.add(key);
  mobileClaimedPairingKeys.delete(key);
  mobilePairingsByKey.delete(key);
  mobileMailboxCursors.delete(key);
  mobileProgressEnvelopes.forgetPairing(key);
  mobileRelayControls.get(pairing.rendezvousId)?.close();
  mobileRelayControls.delete(pairing.rendezvousId);
  const poller = mobileMailboxPollers.get(key);
  if (poller) {
    clearInterval(poller);
    mobileMailboxPollers.delete(key);
  }
  const expiry = mobilePairingExpiryTimers.get(key);
  if (expiry) {
    clearTimeout(expiry);
    mobilePairingExpiryTimers.delete(key);
  }
  await persistMobilePairedDevices();
  await revokeMailboxForPairing(pairing);
  await recordMobilePairingCapabilityRevocation(pairing, revokedAt, reason);
  await debugLogService.write("mobile.pairing.revoked", {
    routingId: pairing.stableRoutingId,
    rendezvousId: pairing.rendezvousId,
    reason
  });
  return {
    revoked: true,
    stableRoutingId: pairing.stableRoutingId,
    rendezvousId: pairing.rendezvousId,
    revokedAt,
    reason
  };
}

async function recordMobilePairingCapabilityRevocation(
  pairing: MobilePairingPackage,
  revokedAt: string,
  reason: string
): Promise<void> {
  const conversationCapabilities = pairing.capabilities.filter((capability) => capability.scope === "conversation");
  if (conversationCapabilities.length === 0) {
    return;
  }
  const payload: ChatDeviceCapabilityRevokedPayload = {
    grantId: mobilePairingGrantId(pairing),
    deviceOriginId: mobileOriginIdForPairing(pairing),
    revokedAt,
    reason
  };
  for (const capability of conversationCapabilities) {
    await chatEventLogService.appendLocalEvent({
      conversationId: capability.conversationId,
      logScopeId: capability.conversationId,
      kind: "device.capability.revoked",
      payload
    });
  }
}

// Destroying the relay mailbox is what makes revocation real for the link
// holder: local bookkeeping alone leaves the mailbox readable with the old
// token. If the relay is unreachable the revoke is persisted and retried on
// startup until the relay confirms.
async function revokeMailboxForPairing(pairing: MobilePairingPackage): Promise<void> {
  if (!pairing.outboxUrl) {
    return;
  }
  try {
    const result = await revokeMailboxForSealKey(pairing.outboxUrl, pairing.relaySealKeyBase64);
    if (result.ok) {
      return;
    }
    await debugLogService.write("mobile.mailbox.revoke-error", {
      routingId: pairing.stableRoutingId,
      status: result.status,
      message: result.error ?? ""
    });
  } catch (error) {
    await debugLogService.write("mobile.mailbox.revoke-error", {
      routingId: pairing.stableRoutingId,
      message: error instanceof Error ? error.message : String(error)
    });
  }
  try {
    const access = mailboxAccessForSealKey(pairing.relaySealKeyBase64);
    const secret = settingsService.encodeMobilePairingSecret(access.token);
    const pending = await settingsService.readPendingMailboxRevocations();
    if (!pending.some((item) => item.mailboxScopeId === access.scopeId)) {
      await settingsService.writePendingMailboxRevocations([...pending, {
        outboxUrl: pairing.outboxUrl,
        mailboxScopeId: access.scopeId,
        encryptedToken: secret.encryptedValue,
        tokenProtection: secret.protection,
        revokedAt: new Date().toISOString()
      }]);
    }
  } catch (error) {
    await debugLogService.write("mobile.mailbox.revoke-persist-error", {
      routingId: pairing.stableRoutingId,
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

async function retryPendingMailboxRevocations(): Promise<void> {
  const pending = await settingsService.readPendingMailboxRevocations();
  if (pending.length === 0) {
    return;
  }
  const remaining: StoredPendingMailboxRevocation[] = [];
  for (const item of pending) {
    try {
      const token = settingsService.decodeMobilePairingSecret(item.encryptedToken, item.tokenProtection);
      if (!token) {
        // decode returns undefined when safeStorage is merely unavailable
        // right now, not only for corrupt records. Dropping the entry here
        // would forget the revoke forever and leave the revoked phone's
        // mailbox alive, so keep it for the next retry.
        remaining.push(item);
        continue;
      }
      const result = await revokeMailboxWithToken(item.outboxUrl, item.mailboxScopeId, token);
      if (!result.ok) {
        remaining.push(item);
      }
    } catch {
      remaining.push(item);
    }
  }
  if (remaining.length !== pending.length) {
    await settingsService.writePendingMailboxRevocations(remaining);
  }
}

function findMobilePairingForRevoke(request: RevokeMobilePairingRequest): MobilePairingPackage | undefined {
  const stableRoutingId = request.stableRoutingId?.trim();
  const rendezvousId = request.rendezvousId?.trim();
  if (!stableRoutingId) {
    throw new Error("Mobile pairing revoke requires stableRoutingId.");
  }
  if (rendezvousId) {
    return mobilePairingsByKey.get(mobilePairingKeyFromIds(stableRoutingId, rendezvousId));
  }
  return [...mobilePairingsByKey.values()].find((pairing) => pairing.stableRoutingId === stableRoutingId);
}

function scheduleMobilePairingExpiry(pairing: MobilePairingPackage): void {
  const key = mobilePairingKey(pairing);
  // A device that already connected is remembered until revoked. Re-arming the
  // invitation timer on restore killed it instantly, because expiresAt is the
  // long-past moment the original link was minted.
  if (mobileClaimedPairingKeys.has(key)) {
    return;
  }
  const existing = mobilePairingExpiryTimers.get(key);
  if (existing) {
    clearTimeout(existing);
  }
  const expiresAtMs = Date.parse(pairing.expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    return;
  }
  const timer = setTimeout(() => {
    void revokeMobilePairingInternal(pairing, "expired").catch((error) => {
      void debugLogService.write("mobile.pairing.expire-error", {
        routingId: pairing.stableRoutingId,
        rendezvousId: pairing.rendezvousId,
        message: error instanceof Error ? error.message : String(error)
      });
    });
  }, Math.max(0, expiresAtMs - Date.now()));
  timer.unref?.();
  mobilePairingExpiryTimers.set(key, timer);
}

function isMobilePairingActive(pairing: MobilePairingPackage): boolean {
  return !isMobilePairingExpired(pairing) && !mobileRevokedPairingKeys.has(mobilePairingKey(pairing));
}

function isMobilePairingExpired(pairing: MobilePairingPackage): boolean {
  // expiresAt bounds how long an unused link is good for, not how long a phone
  // stays paired. Once the phone has connected, only a revoke ends it.
  if (mobileClaimedPairingKeys.has(mobilePairingKey(pairing))) {
    return false;
  }
  const expiresAtMs = Date.parse(pairing.expiresAt);
  return Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now();
}

async function noteMobilePairingClaimed(pairing: MobilePairingPackage): Promise<void> {
  const key = mobilePairingKey(pairing);
  if (mobileClaimedPairingKeys.has(key) || mobileRevokedPairingKeys.has(key)) {
    return;
  }
  mobileClaimedPairingKeys.set(key, new Date().toISOString());
  const expiry = mobilePairingExpiryTimers.get(key);
  if (expiry) {
    clearTimeout(expiry);
    mobilePairingExpiryTimers.delete(key);
  }
  await persistMobilePairedDevices();
  await debugLogService.write("mobile.pairing.claimed", {
    routingId: pairing.stableRoutingId,
    rendezvousId: pairing.rendezvousId
  });
}

async function persistMobilePairedDevices(): Promise<void> {
  try {
    const devices = [...mobilePairingsByKey.entries()]
      .filter(([key]) => mobileClaimedPairingKeys.has(key) && !mobileRevokedPairingKeys.has(key))
      .map(([key, pairing]) => {
        const { relaySealKeyBase64, ...rest } = pairing;
        const secret = settingsService.encodeMobilePairingSecret(relaySealKeyBase64);
        const cursor = mobileMailboxCursors.get(key);
        return {
          stableRoutingId: pairing.stableRoutingId,
          rendezvousId: pairing.rendezvousId,
          pairingJson: JSON.stringify(rest),
          encryptedSealKey: secret.encryptedValue,
          sealKeyProtection: secret.protection,
          // The moment this phone first connected, carried across restarts.
          // Stamping "now" on every rewrite would silently turn this into a
          // last-saved timestamp.
          claimedAt: mobileClaimedPairingKeys.get(key) ?? new Date().toISOString(),
          ...(cursor ? { mailboxEpoch: cursor.epoch, mailboxCursor: cursor.cursor } : {})
        };
      });
    await settingsService.writeMobilePairedDevices(devices);
  } catch (error) {
    await debugLogService.write("mobile.pairing.persist-error", {
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

async function restoreMobilePairedDevices(): Promise<void> {
  // readMobilePairedDevices swallows its own read/parse errors and returns [].
  const devices = await settingsService.readMobilePairedDevices();
  // Each relay connect can burn its full timeout, so devices come back
  // together rather than in turn, and one unreadable record cannot strand the
  // phones behind it.
  const restored = await Promise.all(devices.map(async (device) => {
    try {
      const sealKey = settingsService.decodeMobilePairingSecret(device.encryptedSealKey, device.sealKeyProtection);
      if (!sealKey) {
        return false;
      }
      const pairing = { ...JSON.parse(device.pairingJson), relaySealKeyBase64: sealKey } as MobilePairingPackage;
      mobileClaimedPairingKeys.set(
        mobilePairingKey(pairing),
        typeof device.claimedAt === "string" && device.claimedAt ? device.claimedAt : new Date().toISOString()
      );
      if (typeof device.mailboxEpoch === "string" && Number.isFinite(device.mailboxCursor)) {
        mobileMailboxCursors.set(mobilePairingKey(pairing), {
          epoch: device.mailboxEpoch,
          cursor: device.mailboxCursor ?? 0
        });
      }
      await startMobileRelayControlForPairing(pairing);
      return true;
    } catch (error) {
      await debugLogService.write("mobile.pairing.restore-device-error", {
        routingId: device.stableRoutingId,
        message: error instanceof Error ? error.message : String(error)
      });
      return false;
    }
  }));
  const count = restored.filter(Boolean).length;
  if (count > 0) {
    await debugLogService.write("mobile.pairing.restored", { count });
  }
}

function acceptsMobileOutboxEnvelopeForPairing(pairing: MobilePairingPackage, event: ChatEventEnvelope): boolean {
  if (!isMobilePairingActive(pairing)) {
    return false;
  }
  if (event.originId !== mobileOriginIdForPairing(pairing)) {
    return false;
  }
  // Traffic from the phone proves it holds the key, so the device is now
  // remembered and the invitation window stops applying to it.
  if (mobileClaimedPairingKeys.has(mobilePairingKey(pairing))) {
    return true;
  }
  const eventCreatedAtMs = Date.parse(event.createdAt);
  const expiresAtMs = Date.parse(pairing.expiresAt);
  const withinWindow = !Number.isFinite(eventCreatedAtMs) ||
    !Number.isFinite(expiresAtMs) ||
    eventCreatedAtMs < expiresAtMs;
  if (withinWindow) {
    void noteMobilePairingClaimed(pairing);
  }
  return withinWindow;
}

function mobilePairingKey(pairing: MobilePairingPackage): string {
  return mobilePairingKeyFromIds(pairing.stableRoutingId, pairing.rendezvousId);
}

function mobilePairingKeyFromIds(stableRoutingId: string, rendezvousId: string): string {
  return `${stableRoutingId}\0${rendezvousId}`;
}

function mobilePairingGrantId(pairing: MobilePairingPackage): string {
  return `grant-${sha256Hex(mobilePairingKey(pairing)).slice(0, 32)}`;
}

function mobileOriginIdForPairing(pairing: MobilePairingPackage): string {
  return `mobile-${sha256Hex([
    pairing.stableRoutingId,
    pairing.rendezvousId,
    pairing.fingerprint,
    "mobile"
  ].filter(Boolean).join(":")).slice(0, 32)}`;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function prepareMobileControlForPairing(pairing: MobilePairingPackage): void {
  void startMobileRelayControlForPairing(pairing).catch((error) => {
    void debugLogService.write("mobile.pairing.background-start-error", {
      routingId: pairing.stableRoutingId,
      message: error instanceof Error ? error.message : String(error)
    });
  });
}

function prepareMobileCloudFallbackForPairing(pairing: MobilePairingPackage): void {
  void ensureMobileCloudFallbackReadyForPairing(pairing).catch((error) => {
    void debugLogService.write("mobile.runner.background-ready-error", {
      routingId: pairing.stableRoutingId,
      message: error instanceof Error ? error.message : String(error)
    });
  });
}

async function ensureMobileCloudFallbackReadyForPairing(pairing: MobilePairingPackage): Promise<void> {
  if (pairing.purpose !== "phone-control" || !pairing.outboxUrl || !pairingCanRunCloudParticipants(pairing)) {
    return;
  }
  const started = await ensureMobileMailboxRunnerForPairing(pairing);
  if (!started) {
    return;
  }
  await publishMobileRunnerPoliciesForPairing(pairing);
  await debugLogService.write("mobile.runner.ready", {
    routingId: pairing.stableRoutingId
  });
}

function ensureMobileMailboxRunnerForPairing(pairing: MobilePairingPackage): Promise<boolean> {
  const existing = mobileMailboxRunnerStarts.get(pairing.stableRoutingId);
  if (existing) {
    return existing;
  }
  const promise = startMobileMailboxRunnerForPairing(pairing).finally(() => {
    mobileMailboxRunnerStarts.delete(pairing.stableRoutingId);
  });
  mobileMailboxRunnerStarts.set(pairing.stableRoutingId, promise);
  return promise;
}

async function startMobileMailboxRunnerForPairing(pairing: MobilePairingPackage): Promise<boolean> {
  if (pairing.purpose !== "phone-control" || !pairing.outboxUrl || !pairingCanRunCloudParticipants(pairing)) {
    return false;
  }
  const settings = await settingsService.getPublicSettings();
  if (!settings.cloudRuns.enabled) {
    await debugLogService.write("mobile.runner.not-started", {
      routingId: pairing.stableRoutingId,
      reason: "cloud-runs-disabled"
    });
    return false;
  }
  await withCloudRunWorker(undefined, async (workerSettings) => {
    const worker = cloudRunWorkerTargetFromSettings(workerSettings);
    if (!worker) {
      throw new Error("Cloud Runs worker does not have a valid SSH target.");
    }
    validateCloudRunSshWorkerFields(worker);
    const target = buildCloudRunSshTarget(worker);
    const command = mobileMailboxRunnerInstallCommand({
      routeId: pairing.stableRoutingId,
      mailboxUrl: pairing.outboxUrl ? mailboxEndpointForSealKey(pairing.outboxUrl, pairing.relaySealKeyBase64) : "",
      mailboxToken: mailboxAccessForSealKey(pairing.relaySealKeyBase64).token,
      relaySealKeyBase64: pairing.relaySealKeyBase64,
      workerRoot: workerSettings.workerRoot,
      codexPath: workerSettings.codexPath,
      claudePath: workerSettings.claudePath,
      pollIntervalMs: 2_500,
      timeoutMs: settings.cloudRuns.maxRuntimeMs
    });
    const result = await runCommand("ssh", [
      ...cloudRunSshOptionArgs(worker),
      target,
      command
    ], { timeoutMs: 60_000 });
    await debugLogService.write("mobile.runner.started", {
      routingId: pairing.stableRoutingId,
      stdout: result.stdout.trim()
    });
  }).catch(async (error) => {
    await debugLogService.write("mobile.runner.start-error", {
      routingId: pairing.stableRoutingId,
      message: error instanceof Error ? error.message : String(error),
      exitCode: error instanceof CommandError ? error.result.exitCode : undefined,
      timedOut: error instanceof CommandError ? error.result.timedOut : undefined,
      stdout: error instanceof CommandError ? error.result.stdout.slice(-4000) : undefined,
      stderr: error instanceof CommandError ? error.result.stderr.slice(-4000) : undefined
    });
    throw error;
  });
  return true;
}

function pairingCanRunCloudParticipants(pairing: MobilePairingPackage): boolean {
  return pairing.capabilities.some((capability) => capability.canRunCloudParticipants === true);
}

async function publishMobileRunnerPoliciesForConversation(conversation: Conversation): Promise<void> {
  if (conversation.kind !== "chat" || mobilePairingsByKey.size === 0) {
    return;
  }
  for (const pairing of mobilePairingsByKey.values()) {
    await publishMobileRunnerPolicyForPairing(pairing, conversation);
  }
}

async function publishMobileRunnerPoliciesForPairing(pairing: MobilePairingPackage): Promise<void> {
  if (!pairing.outboxUrl || !pairingCanRunCloudParticipants(pairing)) {
    return;
  }
  if (isMobileMailboxOwnerActionBackoffActive()) {
    return;
  }
  const summaries = await storageService.listConversations();
  for (const summary of summaries.filter((item) => item.kind === "chat" && item.archived !== true).slice(0, 100)) {
    if (isMobileMailboxOwnerActionBackoffActive()) {
      return;
    }
    const conversation = await storageService.getConversation(summary.id);
    if (conversation && conversation.kind === "chat") {
      await publishMobileRunnerPolicyForPairing(pairing, conversation);
    }
  }
}

async function publishMobileRunnerPolicyForPairing(
  pairing: MobilePairingPackage,
  conversation: Conversation
): Promise<void> {
  if (!pairing.outboxUrl || !pairingCanRunCloudParticipants(pairing) || !pairingCanAccessConversation(pairing, conversation.id)) {
    return;
  }
  try {
    const contextSnapshot = await chatService.mobileMailboxRunnerContextSnapshot(conversation);
    const append = await chatEventLogService.appendLocalEvent({
      conversationId: conversation.id,
      logScopeId: conversation.id,
      kind: MOBILE_RUNNER_POLICY_KIND,
      payload: mobileMailboxRunnerPolicyFromConversation(conversation, pairing, contextSnapshot)
    });
    await postMailboxEvents(pairing, [append.event]);
  } catch (error) {
    if (isOwnerActionMailboxError(error)) {
      recordMobileMailboxOwnerActionBackoff();
    }
    await debugLogService.write("mobile.runner.policy-publish-error", {
      routingId: pairing.stableRoutingId,
      conversationId: conversation.id,
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

function pairingCanAccessConversation(pairing: MobilePairingPackage, conversationId: string): boolean {
  return pairing.capabilities.some((capability) =>
    capability.scope === "device"
      ? capability.canRead === true
      : capability.conversationId === conversationId && capability.canRead === true
  );
}

function mobileTimelineSinkForPairing(pairing: MobilePairingPackage): MobileTimelineSink | undefined {
  if (!pairing.outboxUrl) {
    return undefined;
  }
  const pairingKey = mobilePairingKey(pairing);
  return {
    async publishTimeline(timeline: MobileTimelineEvents, publishOptions?: { runFinished?: boolean }) {
      const conversationId = timeline.conversationId?.trim();
      if (!conversationId || timeline.events.length === 0 || !pairing.outboxUrl) {
        return;
      }
      const append = await chatEventLogService.appendLocalEvent({
        conversationId,
        logScopeId: conversationId,
        kind: "mobile.timeline.events",
        payload: timeline
      });
      const runFinished = publishOptions?.runFinished === true;
      // W-C diagnostics: the marker has now been wrong in both directions, so
      // record what was actually decided for each publication rather than
      // reasoning about it from the outside.
      await debugLogService.write("mobile.mailbox.ring-marker", {
        routingId: pairing.stableRoutingId,
        conversationId,
        runFinished,
        eventCount: timeline.events.length,
        statuses: timeline.events.map((event) => `${event.role ?? "?"}:${event.status ?? "?"}`).slice(0, 10)
      });
      await postMailboxEvents(pairing, [append.event], { runFinished });
      // W3/W-A: remember which envelopes carried nothing but pending progress,
      // and once every run they were waiting on has a durable terminal
      // snapshot, delete them so no reader can replay superseded progress. An
      // envelope carrying any terminal event is never tracked.
      const pendingRunIds = new Set<string>();
      const terminalRunIds = new Set<string>();
      for (const event of timeline.events) {
        const runId = typeof event.runId === "string" ? event.runId.trim() : "";
        if (!runId) {
          continue;
        }
        (event.status === "pending" ? pendingRunIds : terminalRunIds).add(runId);
      }
      const superseded = mobileProgressEnvelopes.recordAppend(pairingKey, {
        eventId: append.event.eventId,
        pendingRunIds: [...pendingRunIds],
        terminalRunIds: [...terminalRunIds]
      });
      if (superseded.length > 0) {
        try {
          await deleteMailboxEvents(pairing.outboxUrl, pairing.relaySealKeyBase64, superseded);
        } catch (error) {
          // Deletion is cleanup, not delivery: TTL remains the backstop.
          await debugLogService.write("mobile.mailbox.progress-delete-error", {
            routingId: pairing.stableRoutingId,
            eventIds: superseded,
            message: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }
  };
}

function startMobileMailboxPollingForPairing(
  pairing: MobilePairingPackage,
  control: MobileRelayControlService
): void {
  if (!pairing.outboxUrl) {
    return;
  }
  const pollerKey = mobilePairingKey(pairing);
  const existing = mobileMailboxPollers.get(pollerKey);
  if (existing) {
    clearInterval(existing);
  }
  let active = false;
  let backoffUntil = 0;
  const poll = async () => {
    if (active) {
      return;
    }
    if (Date.now() < backoffUntil || isMobileMailboxOwnerActionBackoffActive()) {
      return;
    }
    active = true;
    try {
      await pollMobileMailboxOutbox(pairing, control);
    } catch (error) {
      if (isOwnerActionMailboxError(error)) {
        backoffUntil = Date.now() + MOBILE_MAILBOX_OWNER_ACTION_BACKOFF_MS;
        recordMobileMailboxOwnerActionBackoff();
      }
      await debugLogService.write("mobile.mailbox.poll-error", {
        routingId: pairing.stableRoutingId,
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      active = false;
    }
  };
  const timer = setInterval(() => {
    void poll();
  }, MOBILE_MAILBOX_POLL_INTERVAL_MS);
  timer.unref?.();
  mobileMailboxPollers.set(pollerKey, timer);
  void poll();
}

async function pollMobileMailboxOutbox(
  pairing: MobilePairingPackage,
  control: MobileRelayControlService
): Promise<void> {
  if (!pairing.outboxUrl || !isMobilePairingActive(pairing)) {
    return;
  }
  const pairingKey = mobilePairingKey(pairing);
  const fetchPage = async (afterArrival: number) => {
    const url = new URL(mailboxEndpointForSealKey(pairing.outboxUrl ?? "", pairing.relaySealKeyBase64));
    url.searchParams.set("limit", "1000");
    url.searchParams.set("afterArrival", String(Math.max(0, afterArrival)));
    const response = await fetch(url.toString(), {
      headers: {
        accept: "application/json",
        ...mailboxAuthHeaders(pairing.relaySealKeyBase64)
      },
      signal: AbortSignal.timeout(8_000)
    });
    if (!response.ok) {
      const body = await response.text();
      if (isOwnerActionMailboxMessage(response.status, body)) {
        recordMobileMailboxOwnerActionBackoff();
      }
      // An unregistered mailbox means this pairing was created or restored
      // while the relay was unreachable; registering now lets the next poll
      // succeed without waiting for an app restart.
      if (response.status === 401 && body.includes("mailbox_unregistered")) {
        void ensureMailboxRegisteredForPairing(pairing);
      }
      // W-G(e): a tombstoned mailbox is terminal — stop instead of self-heal.
      if (isRemoteRevokedMailboxBody(body)) {
        void handleRemoteMailboxRevoked(pairing);
      }
      throw new Error(`Mailbox poll failed with HTTP ${response.status}: ${body}`);
    }
    return await response.json() as { events?: unknown; epoch?: unknown };
  };
  const stored = mobileMailboxCursors.get(pairingKey) ?? { epoch: "", cursor: 0 };
  const startedCursor = stored.cursor;
  const startedEpoch = stored.epoch;
  let body = await fetchPage(stored.cursor);
  const epoch = typeof body.epoch === "string" ? body.epoch : "";
  if (epoch && epoch !== stored.epoch) {
    // Box recreated: arrival numbering restarted. Re-read from zero and let
    // the accepted-event dedupe absorb the replay. The desktop never refills
    // — it is the system of record, not a reader with a gap.
    stored.epoch = epoch;
    stored.cursor = 0;
    body = await fetchPage(0);
  }
  if (!Array.isArray(body.events)) {
    return;
  }
  const opened = await openMailboxEventPayloads(body.events, pairing.relaySealKeyBase64);
  if (opened.unreadableEventIds.length > 0) {
    await debugLogService.write("mobile.mailbox.unreadable-events", {
      routingId: pairing.stableRoutingId,
      eventIds: opened.unreadableEventIds.slice(0, 20)
    });
  }
  const catalog = mobileRelayChatCatalog();
  const events = await collectMobileMailboxOutboxEvents(opened.events, {
    acceptMailboxMessageEvent,
    acceptMobileOutboxEnvelope: (event) => acceptsMobileOutboxEnvelopeForPairing(pairing, event),
    acceptFulfilledMobileOutboxEvent: (event) => chatService.acceptMobileMailboxOutboxEvent(event),
    hasAcceptedMobileEvent: (conversationId, eventId) => chatService.hasAcceptedMobileEvent(conversationId, eventId),
    hasMobileMailboxResultForMobileEvent: (conversationId, eventId) =>
      chatService.hasMobileMailboxResultForMobileEvent(conversationId, eventId),
    tryAcquireMobileEventExecution: (event) =>
      acquireDesktopMobileExecutionClaim(pairing, event.conversationId, event.eventId, `mobile-${event.eventId}`),
    isConversationAllowed: (conversationId) => catalog.isConversationAllowed
      ? catalog.isConversationAllowed(conversationId)
      : false
  });
  if (events.length > 0) {
    const accepted = await control.acceptMobileOutboxEvents(events, `mailbox:${Date.now()}`);
    const acceptedEventIds = new Set(accepted.eventIds);
    for (const event of opened.events) {
      if (
        event.kind === "run.cancel.requested" &&
        acceptedEventIds.has(event.eventId)
      ) {
        await chatService.acceptMobileMailboxOutboxEvent(event);
      }
    }
  }
  // Advance the cursor only after this page is durably processed. Persisting it
  // before decrypt/collection/delivery — or letting a mid-poll crash intervene —
  // would skip these events forever; here, any failure above leaves the cursor
  // and the next poll re-fetches, deduped by the accepted-event and
  // execution-claim layers.
  let advanced = stored.cursor;
  for (const event of body.events) {
    const arrivalSeq = (event as { arrivalSeq?: unknown }).arrivalSeq;
    if (typeof arrivalSeq === "number" && arrivalSeq > advanced) {
      advanced = arrivalSeq;
    }
  }
  stored.cursor = advanced;
  mobileMailboxCursors.set(pairingKey, stored);
  if (stored.cursor !== startedCursor || stored.epoch !== startedEpoch) {
    await persistMobilePairedDevices();
  }
}

async function hasFulfilledMobileMailboxEvent(
  pairing: MobilePairingPackage,
  conversationId: string,
  eventId: string
): Promise<boolean> {
  if (await chatService.hasMobileMailboxResultForMobileEvent(conversationId, eventId)) {
    return true;
  }
  if (!pairing.outboxUrl) {
    return false;
  }
  try {
    const url = new URL(mailboxEndpointForSealKey(pairing.outboxUrl, pairing.relaySealKeyBase64));
    url.searchParams.set("conversationId", conversationId);
    url.searchParams.set("logScopeId", conversationId);
    url.searchParams.set("limit", "100");
    const response = await fetch(url.toString(), {
      headers: {
        accept: "application/json",
        ...mailboxAuthHeaders(pairing.relaySealKeyBase64)
      },
      signal: AbortSignal.timeout(8_000)
    });
    if (!response.ok) {
      return false;
    }
    const body = await response.json() as { events?: unknown };
    if (!Array.isArray(body.events)) {
      return false;
    }
    const opened = await openMailboxEventPayloads(body.events, pairing.relaySealKeyBase64);
    return fulfilledMobileEventKeysFromMailboxEvents(opened.events)
      .has(mobileMailboxEventScopeKey(conversationId, eventId));
  } catch {
    return false;
  }
}

async function acquireDesktopMobileExecutionClaim(
  pairing: MobilePairingPackage,
  conversationId: string,
  eventId: string,
  runId: string
): Promise<boolean> {
  if (!pairing.outboxUrl || !pairingCanRunCloudParticipants(pairing)) {
    return true;
  }
  const result = await acquireMobileMailboxExecutionClaim(
    mailboxEndpointForSealKey(pairing.outboxUrl, pairing.relaySealKeyBase64),
    {
      conversationId,
      eventId,
      ownerId: `desktop:${pairing.stableRoutingId}`,
      ownerRole: "desktop",
      runId,
      ttlMs: MOBILE_EVENT_EXECUTION_CLAIM_TTL_MS
    },
    AbortSignal.timeout(8_000),
    mailboxAuthHeaders(pairing.relaySealKeyBase64)
  );
  if (!result.acquired) {
    await debugLogService.write("mobile.execution-claim.skipped", {
      routingId: pairing.stableRoutingId,
      conversationId,
      eventId,
      runId,
      ownerId: result.claim?.ownerId,
      ownerRole: result.claim?.ownerRole,
      expiresAt: result.claim?.expiresAt
    });
  }
  return result.acquired;
}

async function acceptMailboxMessageEvent(value: unknown): Promise<boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const event = value as Partial<ChatEventEnvelope>;
  if (event.kind !== "message.created") {
    return false;
  }
  const payload = event.payload;
  const message = payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as { message?: unknown }).message
    : undefined;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return false;
  }
  return chatService.acceptMobileMailboxMessageEvent(value as ChatEventEnvelope);
}

// W-C: runFinished is stated by the caller that knows a run finished, never
// inferred from the batch. Inference rang twice per run — a phone-originated
// user message comes back carrying the run's own id and a "done" status, and a
// conversation snapshot is full of finished messages.
async function postMailboxEvents(
  pairing: MobilePairingPackage,
  events: unknown[],
  options?: { runFinished?: boolean }
): Promise<void> {
  if (events.length === 0 || !pairing.outboxUrl) {
    return;
  }
  if (isMobileMailboxOwnerActionBackoffActive()) {
    throw new Error("Mobile mailbox is temporarily suspended after an owner-action response.");
  }
  // The relay stores ciphertext only: payloads are sealed with the pairing
  // key before they leave this process, and the request carries the derived
  // mailbox bearer token for the pairing's own locked mailbox.
  const runFinished = options?.runFinished === true;
  const sealed = await sealMailboxEventPayloads(events, pairing.relaySealKeyBase64);
  const response = await fetch(mailboxEndpointForSealKey(pairing.outboxUrl, pairing.relaySealKeyBase64), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...mailboxAuthHeaders(pairing.relaySealKeyBase64)
    },
    // The marker is computed from the cleartext batch before sealing: the
    // relay never sees which envelope is terminal, only that this append
    // finished a run — the same bit it can already infer from append timing,
    // size, and silence.
    body: JSON.stringify({ events: sealed, ...(runFinished ? { runFinished: true } : {}) }),
    signal: AbortSignal.timeout(8_000)
  });
  if (!response.ok) {
    const body = await response.text();
    if (isOwnerActionMailboxMessage(response.status, body)) {
      recordMobileMailboxOwnerActionBackoff();
    }
    if (response.status === 401 && body.includes("mailbox_unregistered")) {
      void ensureMailboxRegisteredForPairing(pairing);
    }
    // W-G(e): a tombstoned mailbox is terminal — stop instead of self-heal.
    if (isRemoteRevokedMailboxBody(body)) {
      void handleRemoteMailboxRevoked(pairing);
    }
    throw new Error(`Mailbox append failed with HTTP ${response.status}: ${body}`);
  }
}

function isMobileMailboxOwnerActionBackoffActive(): boolean {
  return Date.now() < mobileMailboxOwnerActionBackoffUntil;
}

function recordMobileMailboxOwnerActionBackoff(): void {
  mobileMailboxOwnerActionBackoffUntil = Math.max(
    mobileMailboxOwnerActionBackoffUntil,
    Date.now() + MOBILE_MAILBOX_OWNER_ACTION_BACKOFF_MS
  );
}

function isOwnerActionMailboxError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return isOwnerActionMailboxMessage(/HTTP 429/.test(message) ? 429 : 0, message);
}

function isOwnerActionMailboxMessage(status: number, message: string): boolean {
  return status === 429 && (
    /workers_daily_limit/.test(message) ||
    /owner_action_required/.test(message) ||
    /Do not retry/.test(message)
  );
}

function promiseWithTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function mobileRelayChatCatalog(): MobileRelayChatCatalog {
  return {
    async listChats() {
      const summaries = await storageService.listConversations();
      const visible = summaries.filter((summary) => summary.kind === "chat" && summary.archived !== true);
      const settings = await settingsService.getPublicSettings();
      const roleLabels = new Map(settings.chatRoleConfigs.map((role) => [
        role.id,
        role.id === "generic-participant" && role.label === "Generic Participant"
          ? "Generic Member"
          : role.label
      ]));
      const items: MobileRelayChatListItem[] = [];
      for (const summary of visible.slice(0, 100)) {
        const conversation = await storageService.getConversation(summary.id);
        const lastMessage = conversation?.messages.slice().reverse().find((message) => message.content.trim());
        const members = mobileRelayChatMembers(conversation);
        items.push({
          id: summary.id,
          title: summary.title || "Chat",
          group: mobileChatGroupLabel(summary.repoPath),
          snippet: mobileSnippet(lastMessage?.content),
          who: mobileWhoLabel(lastMessage),
          updatedAt: summary.updatedAt,
          running: summary.running === true,
          participants: (summary.chatParticipants ?? [])
            .map((participant) => participant.handle.startsWith("@") ? participant.handle : `@${participant.handle}`)
            .slice(0, 4),
          members: members.map((participant) => ({
            id: participant.id,
            handle: participant.handle,
            mentionHandle: mobileParticipantMentionHandle(participant, members),
            displayName: mobileParticipantDisplayName(participant),
            roleLabel: roleLabels.get(participant.roleConfigId) ?? participant.roleConfigId,
            kind: participant.kind,
            ...(participant.avatarId ? { avatarId: participant.avatarId } : {})
          }))
        });
      }
      return items;
    },
    async listTimeline(conversationId: string) {
      const opened = await storageService.openConversation(conversationId, 80);
      const messages = opened?.conversation.messages ?? [];
      // Same helper the desktop renders threads with, so the phone groups
      // replies exactly as the desktop does instead of showing one flat list.
      const conversationForThreads = { messages };
      const threadRoots = chatParticipantRequestReplyRootMap(conversationForThreads);
      return messages
        .filter((message) => message.content.trim())
        .map((message) => {
          const mobileEventId = mobileEventIdFromTimelineMessage(message);
          const threadRootId = chatMessageVisualThreadRootId(conversationForThreads, message, threadRoots);
          return {
            id: message.id,
            ...(threadRootId && threadRootId !== message.id ? { threadRootId } : {}),
            role: mobileTimelineRole(message),
            ...(message.participantLabel ? { participantLabel: message.participantLabel } : {}),
            content: message.content,
            status: message.status === "error" ? "error" as const : message.status === "pending" ? "pending" as const : "done" as const,
            createdAt: message.createdAt,
            ...(typeof message.metadata?.runId === "string" ? { runId: message.metadata.runId } : {}),
            messageId: message.id,
            ...(mobileEventId ? { mobileEventId } : {})
          };
        });
    },
    async isConversationAllowed(conversationId: string) {
      const conversation = await storageService.getConversation(conversationId);
      return conversation?.kind === "chat" && conversation.metadata.archived !== true;
    }
  };
}

async function cancelMobileChatRun(conversationId: string, runId: string): Promise<boolean> {
  const targetRunId = runId.trim();
  if (chatService.hasActiveRunForConversation(conversationId, targetRunId)) {
    return chatService.cancelRun(targetRunId);
  }
  const conversation = await storageService.getConversation(conversationId);
  if (!targetRunId || !conversation || conversation.kind !== "chat") {
    return false;
  }
  const belongsToConversation = readActiveRunIds(conversation.metadata).includes(targetRunId) ||
    conversation.metadata.runId === targetRunId ||
    conversation.messages.some((message) =>
      message.status === "pending" && message.metadata?.runId === targetRunId
    ) ||
    Boolean((conversation.metadata.remoteRunHandles as Record<string, unknown> | undefined)?.[targetRunId]);
  return belongsToConversation ? chatService.cancelRun(targetRunId) : false;
}

function mobileRelayChatMembers(conversation: Conversation | undefined): ChatParticipant[] {
  const participants = conversation?.metadata.participants;
  return Array.isArray(participants)
    ? participants.filter((participant): participant is ChatParticipant => Boolean(
      participant &&
      typeof participant === "object" &&
      typeof participant.id === "string" &&
      typeof participant.handle === "string" &&
      typeof participant.roleConfigId === "string" &&
      (participant.kind === "claude-code" || participant.kind === "codex-cli" || participant.kind === "gemini-cli")
    ))
    : [];
}

function mobileParticipantIsAssistant(participant: Pick<ChatParticipant, "handle" | "roleConfigId">): boolean {
  return participant.roleConfigId === "administrator" ||
    participant.handle.trim().replace(/^@/, "").toLowerCase() === "admin";
}

function mobileParticipantMentionHandle(
  participant: Pick<ChatParticipant, "handle" | "roleConfigId">,
  participants: Array<Pick<ChatParticipant, "handle" | "roleConfigId">>
): string {
  if (!mobileParticipantIsAssistant(participant)) {
    return participant.handle;
  }
  const normalizedHandle = participant.handle.trim().replace(/^@/, "").toLowerCase();
  const assistantAliasTaken = participants.some((item) =>
    item !== participant &&
    item.handle.trim().replace(/^@/, "").toLowerCase() === "assistant" &&
    item.roleConfigId !== "administrator"
  );
  return normalizedHandle === "admin" && !assistantAliasTaken ? "assistant" : participant.handle;
}

function mobileParticipantDisplayName(participant: Pick<ChatParticipant, "handle" | "roleConfigId">): string {
  return mobileParticipantIsAssistant(participant) ? "Chat Assistant" : `@${participant.handle}`;
}

function mobileChatGroupLabel(repoPath: string | undefined): string {
  if (!repoPath) {
    return "AccordAgents";
  }
  return path.basename(repoPath) || "AccordAgents";
}

function mobileSnippet(content: string | undefined): string {
  const normalized = content?.replace(/\s+/g, " ").trim() ?? "";
  if (!normalized) {
    return "No messages yet";
  }
  return normalized.length > 84 ? `${normalized.slice(0, 81)}...` : normalized;
}

function mobileWhoLabel(message: ChatMessage | undefined): string | undefined {
  if (!message) {
    return undefined;
  }
  if (message.role === "user") {
    return "you:";
  }
  if (message.participantLabel) {
    return `${message.participantLabel.replace(/^@/, "")}:`;
  }
  return message.role === "system" ? "system:" : undefined;
}

function mobileTimelineRole(message: ChatMessage): "you" | "participant" | "system" {
  if (message.role === "user") {
    return "you";
  }
  if (message.role === "participant") {
    return "participant";
  }
  return "system";
}

function mobileEventIdFromTimelineMessage(message: ChatMessage): string | undefined {
  const explicit = message.metadata?.mobileEventId;
  if (typeof explicit === "string" && explicit.trim()) {
    return explicit.trim();
  }
  const sourceMessageId = message.metadata?.sourceMessageId;
  const runId = message.metadata?.runId;
  if (
    typeof sourceMessageId === "string" &&
    sourceMessageId.trim() &&
    typeof runId === "string" &&
    runId === `mobile-${sourceMessageId.trim()}`
  ) {
    return sourceMessageId.trim();
  }
  return undefined;
}

function registerIpc(): void {
  ipcMain.handle("app:get-version", () => app.getVersion());
  ipcMain.handle("app:open-external", (_event, url: unknown) => openExternalUrl(url));
  ipcMain.handle("app:open-terminal", () => openTerminal());
  ipcMain.handle("app:inspect-local-file", (_event, request: InspectLocalFileRequest) => localFileOpenerService.inspectLocalFile(request));
  ipcMain.handle("app:open-local-file", (_event, request: OpenLocalFileRequest) => localFileOpenerService.openLocalFile(request));
  ipcMain.handle("settings:get", () => settingsService.getPublicSettings());
  ipcMain.handle("settings:set-repo-file-open-preference", (_event, action: unknown) => localFileOpenerService.setOpenPreference(action));
  ipcMain.handle("settings:set-beta-updates", (_event, enabled: boolean) => {
    return settingsService.setBetaUpdates(enabled);
  });
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
    const result = await withCloudRunWorker(request, testCloudRunWorker);
    remoteRunService.clearToolchainPreflightCache();
    await remoteRunService.clearMirrorSyncState();
    return result;
  });
  ipcMain.handle("cloud-runs:diagnose-worker", async (_event, request?: CloudRunWorkerSettings) => {
    const managedAws = !request && (await settingsService.getPublicSettings()).cloudRuns.mode === "aws";
    const result = await withCloudRunWorker(request, (worker) => cloudRunDoctorService.diagnose(worker, {
      requirePersistentStorage: managedAws
    }));
    remoteRunService.clearToolchainPreflightCache();
    await remoteRunService.clearMirrorSyncState();
    return result;
  });
  ipcMain.handle("cloud-runs:setup-worker", async (_event, request?: CloudRunWorkerSettings) => {
    const managedAws = !request && (await settingsService.getPublicSettings()).cloudRuns.mode === "aws";
    const result = await withCloudRunWorker(request, (worker) => cloudRunDoctorService.setup(worker, (progress) => {
      sendToMainWindow("cloud-runs:setup-progress", progress);
    }, { requirePersistentStorage: managedAws }));
    remoteRunService.clearToolchainPreflightCache();
    await remoteRunService.clearMirrorSyncState();
    return result;
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
  ipcMain.handle("settings:set-assistant-provider", (_event, kind: ChatProviderKind) =>
    settingsService.setAssistantProviderKind(kind));
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
      return cliAgentRunner.listModelCatalog(kind, configuredModel, settings.lastRepoPath);
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
        (progress) => emitReviewProgress(progress)
      );
    } catch (error) {
      const phase = controller.signal.aborted ? "cancelled" : "error";
      sendToMainWindow("conversations:review-progress", {
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
        (progress) => emitReviewProgress(progress),
        runId
      );
    } catch (error) {
      const phase = controller.signal.aborted ? "cancelled" : "error";
      sendToMainWindow("conversations:review-progress", {
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
        (progress) => emitReviewProgress(progress)
      );
    } catch (error) {
      const phase = controller.signal.aborted ? "cancelled" : "error";
      sendToMainWindow("conversations:review-progress", {
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
        (progress) => emitReviewProgress(progress)
      );
    } catch (error) {
      const phase = controller.signal.aborted ? "cancelled" : "error";
      sendToMainWindow("conversations:review-progress", {
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
        (progress) => emitReviewProgress(progress)
      );
    } catch (error) {
      const phase = controller.signal.aborted ? "cancelled" : "error";
      sendToMainWindow("conversations:review-progress", {
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
      (progress) => emitReviewProgress(progress)
    );
  });
  ipcMain.handle("mobile:create-pairing", async (_event, request: CreateMobilePairingRequest) => {
    const settings = await settingsService.getPublicSettings();
    const result = await mobilePairingService.createPairing(
      mobilePairingRequestWithEndpointDefaults(request, settings.mobileControl.defaults)
    );
    // Lock the mailbox before the link leaves this machine: registration is
    // trust-on-first-use, and only this process knows the scope id until the
    // link is shown. A failure is surfaced on the result and retried both
    // when the pairing reconnects and whenever mailbox traffic reports the
    // mailbox as unregistered.
    const mailboxRegistered = await ensureMailboxRegisteredForPairing(result.package);
    await recordMobilePairingCapabilityGrant(result.package);
    prepareMobileControlForPairing(result.package);
    prepareMobileCloudFallbackForPairing(result.package);
    return { ...result, mailboxRegistered };
  });
  ipcMain.handle("mobile:revoke-pairing", async (_event, request: RevokeMobilePairingRequest): Promise<RevokeMobilePairingResult> => {
    const stableRoutingId = request.stableRoutingId?.trim();
    const reason = request.reason?.trim() || "desktop-user";
    if (!stableRoutingId) {
      throw new Error("Mobile pairing revoke requires stableRoutingId.");
    }
    const pairing = findMobilePairingForRevoke(request);
    if (!pairing) {
      return {
        revoked: false,
        stableRoutingId,
        ...(request.rendezvousId?.trim() ? { rendezvousId: request.rendezvousId.trim() } : {}),
        revokedAt: new Date().toISOString(),
        reason
      };
    }
    return revokeMobilePairingInternal(pairing, reason);
  });
  ipcMain.handle("conversations:start-review", async (_event, request: ReviewRequest) => {
    const runId = request.runId ?? randomUUID();
    const controller = new AbortController();
    activeReviews.set(runId, controller);

    try {
      return await consensusService.startReview(
        { ...request, runId },
        controller.signal,
        (progress) => emitReviewProgress(progress)
      );
    } catch (error) {
      const phase = controller.signal.aborted ? "cancelled" : "error";
      sendToMainWindow("conversations:review-progress", {
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
        (progress) => emitReviewProgress(progress)
      );
    } catch (error) {
      const phase = controller.signal.aborted ? "cancelled" : "error";
      sendToMainWindow("conversations:review-progress", {
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
        (progress) => emitReviewProgress(progress)
      );
    } catch (error) {
      const phase = controller.signal.aborted ? "cancelled" : "error";
      sendToMainWindow("conversations:review-progress", {
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
        (progress) => emitReviewProgress(progress)
      );
    } catch (error) {
      const phase = controller.signal.aborted ? "cancelled" : "error";
      sendToMainWindow("conversations:review-progress", {
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
        (progress) => emitReviewProgress(progress)
      );
    } catch (error) {
      const phase = controller.signal.aborted ? "cancelled" : "error";
      sendToMainWindow("conversations:review-progress", {
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
        (progress) => emitReviewProgress(progress)
      );
    } catch (error) {
      const phase = controller.signal.aborted ? "cancelled" : "error";
      sendToMainWindow("conversations:review-progress", {
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
        (progress) => emitReviewProgress(progress)
      );
    } catch (error) {
      const phase = controller.signal.aborted ? "cancelled" : "error";
      sendToMainWindow("conversations:review-progress", {
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
  ipcMain.handle("artifacts:set-archived", (_event, request: SetArtifactArchivedRequest) =>
    artifactService.setArchived(ARTIFACT_USER_MEMBER, request));
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
  await validateSqliteExecutable({ executable: sqliteExecutable });
  registerIpc();
  let betaUpdates = false;
  try {
    betaUpdates = await settingsService.getBetaUpdatesEnabled();
  } catch (error) {
    void debugLogService.write("app-updater-settings-read-error", {
      error: error instanceof Error ? error.message : String(error)
    });
  }
  bootstrapAppUpdater(debugLogService, betaUpdates);
  await appMcpService.start();
  await storageService.init();
  // Deliberately not awaited: each paired phone reconnects through the relay
  // with its own connect timeout, and blocking here left the app with no
  // window at all while the relay was slow or unreachable.
  void restoreMobilePairedDevices().catch((error) => {
    void debugLogService.write("mobile.pairing.restore-error", {
      message: error instanceof Error ? error.message : String(error)
    });
  });
  void retryPendingMailboxRevocations().catch((error) => {
    void debugLogService.write("mobile.mailbox.revoke-retry-error", {
      message: error instanceof Error ? error.message : String(error)
    });
  });
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
  const damagedSqlite = error instanceof BundledSqliteInstallationError;
  const message = damagedSqlite
    ? DAMAGED_SQLITE_INSTALLATION_MESSAGE
    : error instanceof Error ? error.message : String(error);
  console.error("Failed to start AccordAgents:", error);
  dialog.showErrorBox(damagedSqlite ? "AccordAgents installation is damaged" : "AccordAgents failed to start", message);
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

autoUpdater.on("before-quit-for-update", () => {
  quittingForUpdate = true;
});

app.on("before-quit", (event) => {
  if (quittingForUpdate) {
    return;
  }
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

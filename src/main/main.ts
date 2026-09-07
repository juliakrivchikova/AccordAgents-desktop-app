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
  ChatSearchRequest,
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
  CreateArtifactRequest,
  DiffArtifactRequest,
  ListArtifactsRequest,
  ListArtifactDraftsRequest,
  PublishArtifactRequest,
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
import { stableJson } from "../shared/stableJson";
import { ArtifactService } from "./services/artifacts";
import { ArtifactStore } from "./services/artifactStore";
import { createArtifactToolDispatcher, wireArtifactToolHandler, wireChatAppToolHandlers } from "./appToolWiring";
import { ChatEventLogService } from "./services/chatEventLog";
import { ChatEventMirrorService, chatEventMirrorOptionsFromEnv } from "./services/chatEventMirror";
import { ChatService } from "./services/chat";
import { MobilePairingService } from "./services/mobilePairing";
import { MachineLinkService } from "./services/machineLink";
import { MachineInstallerService } from "./services/machineInstaller";
import { MachinePowerHandoffService } from "./services/machinePowerHandoff";
import { ChatActionApplier } from "./services/chatActionApplier";
import { ChatActionEmitter, permissionDecisionAction, choiceDecisionAction, chatActionEventId } from "./services/chatActionEmitter";
import { MachineApprovalExecutor, machineApprovalResultId } from "./services/machineApprovalExecutor";
import { readPosixProcessTableAsync } from "./services/processTermination";
import { createChatActionEffects } from "./services/chatActionEffects";
import { MachineChoiceExecutor, machineChoiceResultId } from "./services/chatActionNativeClaims";
import type { CreateMachineRequest, CreateMachineResult, MachineEnrollmentRequest, MachineListResult, MachineTrustedDevicesResult, RemoveMachineRequest, SaveTrustedDeviceRequest } from "../shared/machineLink";
import type {
  MachineInstallRecord,
  MachineInstallRequest,
  MachineInstallResult,
  MachineMirrorBootstrapRequest,
  MachineMirrorBootstrapResult,
  MachineRuntimePayloadInfo,
  MachineRuntimeProbe,
  MachineSshTarget,
  MachineUpgradeRequest
} from "../shared/machineInstall";
import type { MachineRuntimePayloadLocation } from "./services/machineInstaller";
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
import { CHAT_ACTION_LOG_SCOPE } from "../shared/chatActionEvents";
import { readActiveRunIds } from "../shared/chatRunState";
import type { ChatDeviceCapabilityGrantPayload, ChatDeviceCapabilityRevokedPayload } from "../shared/chatDeviceCapabilities";
import { CliAgentRunner } from "./services/cliAgents";
import { ConsensusService } from "./services/consensus";
import { AppMcpService } from "./services/appMcp";
import { acquireMobileMailboxExecutionClaim } from "./services/mobileMailboxClaims";
import { controlCardsFromConversation } from "../shared/mobileControlCards";
import { artifactNameKey } from "../shared/artifacts";
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
import { ProviderRunner } from "./services/providers";
import { DefaultRemoteAgentSetupSync } from "./services/remoteAgentSetup";
import { acquireWorkerOperationLease, renewWorkerOperationLease, releaseWorkerOperationLease } from "./services/remoteWorkerLease";
import { LocalFileOpenerService } from "./services/localFileOpener";
import { SettingsService } from "./services/settings";
import { StorageService } from "./services/storage";
import { ChatSearchService } from "./services/chatSearch";
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
const debugLogService = new DebugLogService();
const chatSearchService = new ChatSearchService(storageService, debugLogService);
const localFileOpenerService = new LocalFileOpenerService(storageService, settingsService);
const providerRunner = new ProviderRunner();
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

const cliAgentRunner = new CliAgentRunner(
  debugLogService,
  () => settingsService.getManualAgentEnvironment(),
  { electronAppPath: app.getAppPath() }
);
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
// Machines transport: enrolled machines that host participants.
let machineLinkService: MachineLinkService | undefined;
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
const mobilePairingExpiryTimers = new Map<string, NodeJS.Timeout>();
const mobileRevokedPairingKeys = new Set<string>();
let mobileMailboxOwnerActionBackoffUntil = 0;
const chatService = new ChatService(storageService, settingsService, cliAgentRunner, debugLogService, appMcpService, (conversation, update) => {
  // The renderer receives the delta form — the messages that changed plus the
  // newest window — because on a chat with thousands of messages the full
  // snapshot is tens of megabytes per update. The phone paths keep the full
  // snapshot they were written against.
  sendToMainWindow("conversations:updated", update);
  for (const control of mobileRelayControls.values()) {
    control.pushConversationSnapshot(conversation);
  }
  void machineLinkService?.replicateConversation(conversation).catch(() => undefined);
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

const cloudRunDoctorService = new CloudRunDoctorService({
  openExternal: (url) => {
    void openExternalUrl(url);
  },
  logger: (event, payload) => {
    void debugLogService.write(event, payload);
  }
});
const cloudRunAwsService = new CloudRunAwsService(settingsService, {
  // The box is no longer asked over SSH whether a turn is running on it: the
  // machine on it reports its own work over the link, and an idle stop waits
  // while any of it is in flight.
  automaticStopGate: {
    authorizeAutomaticWorkerStop: async () => machineLinkService?.hasActiveMachineWork()
      ? { allowed: false, reason: "A machine is still working." }
      : { allowed: true, lease: { leaseId: "machine-idle", expiresAt: new Date(Date.now() + 30_000).toISOString() } },
    renewAutomaticWorkerStopLease: async (_worker, lease) => machineLinkService?.hasActiveMachineWork()
      ? Promise.reject(new Error("A machine started working; the automatic stop is abandoned."))
      : { ...lease, expiresAt: new Date(Date.now() + 30_000).toISOString() },
    releaseAutomaticWorkerStopLease: async () => undefined
  },
  logger: (event, payload) => {
    void debugLogService.write(event, payload);
  }
});
const awsWorkerSetupService = new AwsWorkerSetupService(cloudRunAwsService, cloudRunDoctorService, settingsService);
void awsWorkerSetupService.recoverInterruptedOperation();
// Machines transport: the ONLY SSH path to a machine. Installing, upgrading
// and the one-time project mirror; never a message, a turn or a Stop.
function requireMachineLink(): MachineLinkService {
  if (!machineLinkService) {
    throw new Error("Machines are not ready yet; try again in a moment.");
  }
  return machineLinkService;
}
function machineRuntimePayload(): MachineRuntimePayloadLocation {
  // A packaged app ships the Linux runtime beside its asar, in
  // Contents/Resources/machine: rsync has to read real files, and nothing
  // inside an asar has a real path. A checkout uses what `npm run build`
  // produced. The override exists for QA and for pointing a packaged app at a
  // specific build; it deliberately skips the version check.
  const override = process.env.ACCORDAGENTS_MACHINE_BUNDLE_DIR?.trim();
  if (override) {
    return { dir: override, source: "override" };
  }
  if (app.isPackaged) {
    return { dir: path.join(process.resourcesPath, "machine"), source: "packaged", expectVersion: app.getVersion() };
  }
  return { dir: path.join(app.getAppPath(), "dist", "machine"), source: "checkout", expectVersion: app.getVersion() };
}
const machineInstallerService = new MachineInstallerService({
  store: settingsService,
  doctor: cloudRunDoctorService,
  getEnrollmentJson: (machineId) => requireMachineLink().enrollmentJson(machineId),
  waitForConnected: (machineId, timeoutMs, expectAppVersion) =>
    requireMachineLink().waitForConnected(machineId, timeoutMs, expectAppVersion),
  payload: machineRuntimePayload,
  machineName: async (machineId) => (await settingsService.listMachines()).find((machine) => machine.id === machineId)?.name,
  logger: (event, payload) => {
    void debugLogService.write(event, payload);
  }
});
void machineInstallerService.recoverInterruptedOperation();
// Rule 3: a device wakes a stopped AWS machine itself with a narrowly scoped
// key handed to it sealed at pairing. Nothing else in the app may hand that
// key out, and revoking a pairing goes through here so the User is told the
// key still has to be rotated.
const machinePowerHandoffService = new MachinePowerHandoffService(settingsService);

/** The handoff a new phone pairing carries, or undefined when this desktop
 *  manages no AWS machine. A failure to mint one never blocks pairing: the
 *  phone still controls the desktop, it just cannot wake the machine. */
async function machinePowerHandoffForPairing(pairing: MobilePairingPackage): Promise<MobilePairingPackage> {
  if (pairing.purpose !== "phone-control") return pairing;
  try {
    const machines = await settingsService.listMachines();
    const machineId = machines.length === 1 ? machines[0].id : "";
    const power = await machinePowerHandoffService.issue({
      machineId: machineId || "aws-machine",
      issuedTo: pairing.stableRoutingId
    });
    return { ...pairing, power };
  } catch (error) {
    void debugLogService.write("machine.power.handoff.skipped", {
      reason: error instanceof Error ? error.message : String(error)
    });
    return pairing;
  }
}
chatService.setCloudRunAwsService(cloudRunAwsService);
chatService.setCloudRunDoctorService(cloudRunDoctorService);
wireChatAppToolHandlers(appMcpService, chatService);
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
  },
  // Canonical action events for artifact work. The local change is already
  // committed when this runs; the event is what lets other peers fold the same
  // decision. `operationId` is derived from the immutable revision identity, so
  // a re-emission after a restart is folded once as a duplicate rather than as
  // a second revision.
  hasEmittedAction: (eventId) => chatActionEventExists(eventId),
  emitAction: (action) => publishChatAction(action),
  // The atomic path: the event is minted and handed to the artifact write, so
  // the change and the event peers learn from share one transaction.
  commitActionWithChange: async (action, write) => chatEventLogService.withPreparedLocalEvent({
    conversationId: action.conversationId,
    logScopeId: CHAT_ACTION_LOG_SCOPE,
    kind: action.kind,
    // Immutable bytes are written ahead of the change: a body large enough
    // becomes fragments here, and only the reference travels in the event.
    payload: await storageService.deviceEventBlobs().prepare(action.payload),
    eventId: `chat-action:${action.payload.operationId}`,
    recipients: machineLinkService?.chatActionRecipients() ?? []
  }, (prepared) => write({
    sql: prepared.sql,
    onlyIfSql: (condition) => prepared.sql
      ? storageService.chatEventAppendSql(prepared.event, {
        recipients: machineLinkService?.chatActionRecipients() ?? []
      }, condition)
      : ""
  })).then((outcome) => outcome.result)
});
chatService.setArtifactCleanup((conversationId) => artifactService.deleteConversationArtifacts(conversationId));
// A deleted chat is deleted on the machines that host its members too, durably
// and with a tombstone, so a snapshot still in flight cannot bring it back.
chatService.setConversationDeletedHandler(async (conversation) => {
  sendToMainWindow("conversations:deleted", conversation.id);
  await machineLinkService?.deleteConversationOnMachines(conversation);
});
const dispatchArtifactTool = createArtifactToolDispatcher(artifactService);
wireArtifactToolHandler(appMcpService, chatService, dispatchArtifactTool);
// Applies chat actions that arrive from a machine. Emitting an action is half
// a user scenario; without this a signature made on a machine would be stored
// and never become visible here.
const localChatActionEffects = createChatActionEffects({
  chat: chatService as unknown as Parameters<typeof createChatActionEffects>[0]["chat"],
  emitter: { beginExecution: (target) => chatActionEmitter.beginExecution(target), recordExecution: (request) => chatActionEmitter.recordExecution(request) },
  storage: { getConversation: (id) => storageService.getConversation(id) },
  applyApproval: async (event, payload) => (await localApprovalExecutor()).applyAction(event, payload),
  applyChoice: async (event, payload) => (await localChoiceExecutor()).applyAction(event, payload)
});
const chatActionApplier = new ChatActionApplier({
  effects: localChatActionEffects,
  artifacts: {
    getRevision: async (artifactId, versionEventId) => {
      const revision = await artifactStore.getRevision(artifactId, versionEventId);
      return revision
        ? { version: revision.version, contentHash: revision.contentHash, superseded: revision.superseded }
        : undefined;
    },
    insertSignature: (record) => artifactStore.insertSignature(record),
    hasArtifact: async (artifactId) => Boolean(await artifactStore.getById(artifactId)),
    createArtifact: async (request) => {
      await artifactStore.insertArtifact({
        id: request.artifactId,
        conversationId: request.conversationId,
        name: request.name,
        owner: request.owner,
        contributors: request.contributors,
        requiredSigners: request.requiredSigners,
        labels: request.labels,
        lifecycle: "published",
        allowedDraftAuthors: [],
        requiredDraftAuthors: [],
        audiencePolicyByAuthor: {},
        draftRosterRevision: 0,
        headVersion: request.revision.version,
        createdAt: request.createdAt,
        updatedAt: request.revision.createdAt
      }, artifactNameKey(request.name), {
        artifactId: request.artifactId,
        version: request.revision.version,
        versionEventId: request.revision.versionEventId,
        content: request.revision.content,
        author: request.revision.author,
        note: request.revision.note,
        createdAt: request.revision.createdAt
      });
    },
    retainRevision: (request) => artifactStore.retainProjectedRevision({
      artifactId: request.artifactId,
      versionEventId: request.versionEventId,
      baseVersionEventId: request.baseVersionEventId,
      version: request.version,
      content: request.content,
      contentHash: "",
      author: request.author,
      note: request.note,
      createdAt: request.createdAt
    })
  },
  logger: (event, payload) => {
    void debugLogService.write(event, payload);
  }
});
/** One route for every chat action: the local event plus a copy queued for
 *  each enrolled machine that holds the chat. With no machine enrolled the
 *  action is still written locally, for this desktop's own projection and for
 *  a machine that enrols later. */
async function publishChatAction(action: { conversationId: string; kind: string; payload: { operationId: string } }): Promise<void> {
  const request = {
    conversationId: action.conversationId,
    kind: action.kind,
    payload: action.payload as unknown,
    eventId: `chat-action:${action.payload.operationId}`
  };
  const published = (await machineLinkService?.publishChatAction(request)) ?? 0;
  if (published === 0) {
    await chatEventLogService.appendLocalEvent({ ...request, logScopeId: CHAT_ACTION_LOG_SCOPE });
  }
}

/**
 * A card answered on the phone.
 *
 * It takes exactly the path a desktop answer takes: the decision becomes a
 * durable event first, then the peer that holds the request acts on it once.
 * Delivery from the phone is not the answer being applied, and this is where
 * that distinction is kept.
 */
async function applyMobileDecision(request: {
  conversationId: string;
  kind: "permission.decided" | "choice.answered";
  payload: { operationId: string; targetKey: string; stateId?: string; detail?: Record<string, unknown> };
}): Promise<void> {
  await publishChatAction({ conversationId: request.conversationId, kind: request.kind, payload: request.payload });
  const event = await storageService.getChatEvent(`chat-action:${request.payload.operationId}`);
  if (!event) {
    throw new Error("The answer from the phone could not be recorded.");
  }
  const outcome = await chatActionApplier.apply(event);
  if (outcome.status === "deferred") {
    // Kept for retry rather than reported as answered: the peer that holds the
    // request could not act on it yet.
    void debugLogService.write("mobile.decision.deferred", {
      conversationId: request.conversationId, targetKey: request.payload.targetKey
    });
  }
}

async function chatActionEventExists(eventId: string): Promise<boolean> {
  return Boolean(await storageService.getChatEvent(eventId));
}

/** Permission answers, choices, participant requests and Stop become durable
 *  events here, before the provider is told, and the effect that follows is
 *  recorded once per target. */
const chatActionEmitter = new ChatActionEmitter({
  executedBy: app.getName(),
  publish: (action) => publishChatAction(action),
  hasEvent: (eventId) => chatActionEventExists(eventId),
  logger: (event, payload) => {
    void debugLogService.write(event, payload);
  }
});

let approvalExecutor: Promise<MachineApprovalExecutor> | undefined;
let runtimeIdentity: Promise<{ runtimeId: string; pid: number; startedAt: string }> | undefined;

/** This process, named the way a durable claim names its owner: one identity
 *  for every native admission this runtime takes. */
function localRuntimeIdentity(): Promise<{ runtimeId: string; pid: number; startedAt: string }> {
  const pending = runtimeIdentity ??= (async () => {
    const processIdentity = (await readPosixProcessTableAsync())?.get(process.pid);
    if (!processIdentity) throw new Error("This runtime's process identity could not be verified.");
    return { runtimeId: randomUUID(), pid: processIdentity.pid, startedAt: processIdentity.startedAt };
  })();
  void pending.catch(() => { if (runtimeIdentity === pending) runtimeIdentity = undefined; });
  return pending;
}

function localApprovalExecutor(): Promise<MachineApprovalExecutor> {
  const pending = approvalExecutor ??= (async () => {
    const device = await chatEventLogService.getOrCreateDeviceIdentity();
    const owner = await localRuntimeIdentity();
    return new MachineApprovalExecutor({
      storage: storageService, deviceId: device.originId, chat: chatService,
      progress: progress => emitReviewProgress(progress),
      getConversation: id => storageService.getConversation(id), runtimeIdentity: async () => owner,
      nativeProcessDbPath: path.join(app.getPath("userData"), "native-processes.sqlite3"),
      publish: async body => {
        await chatEventLogService.appendLocalEvent({ conversationId: body.conversationId,
          logScopeId: `approval:${body.approvalId}`, kind: body.type, eventId: machineApprovalResultId(body.decisionId!), payload: body });
      }
    });
  })();
  void pending.catch(() => { if (approvalExecutor === pending) approvalExecutor = undefined; });
  return pending;
}

let choiceExecutor: Promise<MachineChoiceExecutor> | undefined;
function localChoiceExecutor(): Promise<MachineChoiceExecutor> {
  const pending = choiceExecutor ??= (async () => {
    const device = await chatEventLogService.getOrCreateDeviceIdentity();
    return new MachineChoiceExecutor({ storage: storageService, deviceId: device.originId, chat: chatService,
      progress: progress => emitReviewProgress(progress), runtimeIdentity: () => localRuntimeIdentity(),
      nativeProcessDbPath: path.join(app.getPath("userData"), "native-processes.sqlite3"),
      publish: async body => {
        const request = { conversationId: body.conversationId, kind: body.type,
          eventId: machineChoiceResultId(body.decisionId), payload: body };
        if (!await machineLinkService?.publishChatAction(request)) {
          await chatEventLogService.appendLocalEvent({ ...request, logScopeId: `choice:${body.choiceId}` });
        }
      }
    });
  })();
  void pending.catch(() => { if (choiceExecutor === pending) choiceExecutor = undefined; });
  return pending;
}

async function recoverLocalChoiceActions(): Promise<void> {
  const device = await chatEventLogService.getOrCreateDeviceIdentity();
  let cursor = 0;
  for (;;) {
    const rows = await storageService.nativeCommands().pendingChoiceActions(device.originId, cursor);
    if (!rows.length) return;
    for (const row of rows) {
      cursor = row.originSeq;
      try {
        const event = await storageService.getChatEvent(row.eventId);
        if (!event) continue;
        const payload = await storageService.deviceEventBlobs().hydrate(event.payload) as import("../shared/chatActionEvents").ChatActionPayload;
        const claim = await storageService.nativeCommands().targetEffect(event.conversationId, payload.targetKey);
        if (claim?.eventId === event.eventId && localChatActionEffects.applyChoice) await localChatActionEffects.applyChoice(event, payload);
        else await chatActionApplier.apply(event, payload);
      } catch (error) {
        await debugLogService.write("chat.choice.recovery-pending", { eventId: row.eventId, message: error instanceof Error ? error.message : String(error) });
      }
    }
  }
}

async function recoverLocalApprovalActions(): Promise<void> {
  const device = await chatEventLogService.getOrCreateDeviceIdentity();
  let cursor = 0;
  for (;;) {
    const rows = await storageService.nativeCommands().pendingApprovalActions(device.originId, cursor);
    if (!rows.length) return;
    for (const row of rows) {
      cursor = row.originSeq;
      try {
        const event = await storageService.getChatEvent(row.eventId);
        if (!event) continue;
        const payload = await storageService.deviceEventBlobs().hydrate(event.payload) as import("../shared/chatActionEvents").ChatActionPayload;
        const claim = payload.targetKey?.startsWith("approval:")
          ? await storageService.nativeCommands().approvalEffect(event.conversationId, payload.targetKey.slice(9)) : undefined;
        if (claim?.eventId === event.eventId && localChatActionEffects.applyApproval) {
          // A retained fact belongs to its original executor even if the
          // participant has since moved. The claim prevents another effect.
          await localChatActionEffects.applyApproval(event, payload);
        } else await chatActionApplier.apply(event, payload);
      } catch (error) {
        await debugLogService.write("chat.approval.recovery-pending", { eventId: row.eventId, message: error instanceof Error ? error.message : String(error) });
      }
    }
  }
}

const activeReviews = new Map<string, AbortController>();

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
    const lease = await acquireWorkerOperationLease(worker, operationId, "settings-worker-operation");
    const renewalTimer = setInterval(() => {
      void renewWorkerOperationLease(worker, lease).then((renewed) => {
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
      await releaseWorkerOperationLease(worker, lease).catch((error) => {
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
      },
      // The phone's own signing key: stored here and named to every machine,
      // so a machine answers the phone when this desktop is closed.
      onPhoneIdentity: async (identity) => {
        // Named with the pairing it arrived on. Without this the stored rules
        // never ran, and a device the owner had just removed re-granted itself
        // simply by announcing its key again on the pairing it still held.
        await settingsService.saveTrustedDevice({
          deviceId: identity.deviceId,
          publicKeyDerBase64: identity.publicKeyDerBase64,
          role: "phone",
          name: identity.name,
          addedAt: new Date().toISOString()
        }, { key: mobilePairingKey(pairing), createdAt: pairing.createdAt });
        await machineLinkService?.refreshTrustRosters();
        await debugLogService.write("mobile.device.identity", { deviceId: identity.deviceId });
      },
      // Where the phone can reach each machine directly.
      machineAccess: async (deviceId?: string) => {
        const machines = await settingsService.listMachines();
        const trusted = deviceId
          ? (await settingsService.listTrustedDevices()).find((device) => device.deviceId === deviceId)
          : undefined;
        if (!trusted) return [];
        const access = [];
        for (const machine of machines) {
          const machinePairing = await settingsService.getMachinePairing(machine.pairingKey);
          const publicKeyDerBase64 = machine.lastHello?.publicKeyDerBase64;
          if (!machinePairing?.relayUrl || !machine.deviceId || !publicKeyDerBase64) continue;
          access.push({
            machineId: machine.id,
            name: machine.name,
            deviceId: machine.deviceId,
            publicKeyDerBase64,
            relayUrl: machinePairing.relayUrl,
            rendezvousId: machinePairing.rendezvousId,
            fingerprint: machinePairing.fingerprint,
            ...(machinePairing.outboxUrl ? { outboxUrl: machinePairing.outboxUrl } : {})
          });
        }
        return access;
      }
    },
    {
      sendMessage: (request, signal, progress) => chatService.sendMessage(request, signal, progress),
      hasAcceptedMobileEvent: (conversationId, eventId) => chatService.hasAcceptedMobileEvent(conversationId, eventId),
      hasMobileMailboxResultForMobileEvent: (conversationId, eventId) =>
        hasFulfilledMobileMailboxEvent(pairing, conversationId, eventId),
      tryAcquireMobileEventExecution: (event, runId) =>
        acquireDesktopMobileExecutionClaim(pairing, event.conversationId, event.eventId, runId),
      cancelRun: (conversationId, runId) => cancelMobileChatRun(conversationId, runId),
      applyMobileDecision: (request) => applyMobileDecision(request),
      conversationIdForRun: (runId) => chatService.conversationIdForRun(runId)
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

/** Takes back the power handoff this pairing carried. It cannot make the copy
 *  the device kept stop working — only rotating the key does — so the outcome
 *  is returned to the caller instead of being swallowed. */
async function revokeMachinePowerForPairing(
  pairing: MobilePairingPackage,
  reason: string
): Promise<{ required: boolean; detail?: string }> {
  const handoffId = pairing.power?.handoffId;
  if (!handoffId) return { required: false };
  try {
    const outcome = await machinePowerHandoffService.revoke(handoffId, reason);
    return { required: outcome.keyRotationRequired, detail: outcome.detail };
  } catch (error) {
    void debugLogService.write("machine.power.handoff.revoke-error", {
      message: error instanceof Error ? error.message : String(error)
    });
    return { required: false };
  }
}

async function revokeMobilePairingInternal(
  pairing: MobilePairingPackage,
  reason: string
): Promise<RevokeMobilePairingResult> {
  const key = mobilePairingKey(pairing);
  const revokedAt = new Date().toISOString();
  const powerRevocation = await revokeMachinePowerForPairing(pairing, reason);
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
    reason,
    ...(powerRevocation.required
      ? { powerKeyRotationRequired: true, powerKeyRotationDetail: powerRevocation.detail }
      : {})
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

/**
 * Brings the durable record of revoked pairings into this process.
 *
 * The in-memory set alone forgets everything on restart, so a pairing the
 * owner revoked came back the next time the app started.
 */
async function applyStoredMobilePairingRevocations(): Promise<void> {
  const trust = await settingsService.machinePairingTrust().catch(() => undefined);
  if (!trust) return;
  for (const key of trust.revokedKeys) {
    if (mobileRevokedPairingKeys.has(key)) continue;
    mobileRevokedPairingKeys.add(key);
    mobileClaimedPairingKeys.delete(key);
    const pairing = mobilePairingsByKey.get(key);
    if (!pairing) continue;
    mobileRelayControls.get(pairing.rendezvousId)?.close();
    mobileRelayControls.delete(pairing.rendezvousId);
    mobilePairingsByKey.delete(key);
  }
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

// A machine enrollment is durable: it is installed once on the machine and
// revoked by removing the machine, not by a clock.
const MACHINE_ENROLLMENT_TTL_MINUTES = 60 * 24 * 365 * 10;

function assertMachineId(value: unknown): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id) {
    throw new Error("Machine id is required.");
  }
  return id;
}

function assertMachineSshTarget(value: unknown): MachineSshTarget {
  const target = value && typeof value === "object" ? value as Partial<MachineSshTarget> : {};
  const host = typeof target.host === "string" ? target.host.trim() : "";
  if (!host) {
    throw new Error("The machine needs an address to reach it for setup.");
  }
  return {
    host,
    user: typeof target.user === "string" && target.user.trim() ? target.user.trim() : undefined,
    port: typeof target.port === "number" && Number.isFinite(target.port) ? Math.floor(target.port) : undefined,
    identityFile: typeof target.identityFile === "string" && target.identityFile.trim() ? target.identityFile.trim() : undefined,
    hostKeyAlias: typeof target.hostKeyAlias === "string" && target.hostKeyAlias.trim() ? target.hostKeyAlias.trim() : undefined
  };
}

/** What Settings shows: this desktop's own identity, so it can be added on
 *  another device, and the devices this one already trusts. */
async function trustedDevicesResult(): Promise<MachineTrustedDevicesResult> {
  const identity = await chatEventLogService.getOrCreateDeviceIdentity();
  return {
    thisDevice: {
      deviceId: identity.originId,
      publicKeyDerBase64: identity.publicKeyDerBase64,
      role: "desktop",
      name: "This computer",
      addedAt: identity.createdAt ?? new Date().toISOString()
    },
    devices: await settingsService.listTrustedDevices()
  };
}

async function machineListResult(): Promise<MachineListResult> {
  return {
    machines: await settingsService.listMachines(),
    status: machineLinkService?.status() ?? []
  };
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

function pairingCanRunCloudParticipants(pairing: MobilePairingPackage): boolean {
  return pairing.capabilities.some((capability) => capability.canRunCloudParticipants === true);
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
            ...(participant.avatarId ? { avatarId: participant.avatarId } : {}),
            // A member that lives on a machine travels with what that machine
            // needs to run it, so the phone can ask the machine itself when
            // this desktop is closed. Local members carry nothing extra.
            ...(participant.homeMachineId
              ? { homeMachineId: participant.homeMachineId, participant }
              : {})
          }))
        });
      }
      return items;
    },
    async listControlCards(conversationId: string) {
      // Straight from the stored conversation, so a card cannot exist on the
      // phone that does not exist on the machine that raised it.
      const conversation = await storageService.getConversation(conversationId);
      return conversation && conversation.kind === "chat" ? controlCardsFromConversation(conversation) : [];
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
      sendToMainWindow("cloud-runs:setup-progress", progress);
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
  ipcMain.handle("chat-search:query", (_event, request: ChatSearchRequest) => chatSearchService.search(request));
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
    if (hydrated.messages.length < result.messagePage.totalMessages) {
      // Hydration did not load the full history (non-chat kinds); keep the
      // window storage read.
      return {
        ...result,
        conversation: { ...hydrated, messages: windowedMessages }
      };
    }
    // Hydration can change or add messages (stale runs recovered, orphaned
    // requests marked). Later delta updates only describe changes after the
    // snapshot hydration emitted, so the window handed back is cut from the
    // hydrated history rather than the pre-hydration read.
    const total = hydrated.messages.length;
    const messages = hydrated.messages.slice(Math.max(0, total - Math.max(1, windowedMessages.length)));
    return {
      ...result,
      conversation: { ...hydrated, messages },
      messagePage: {
        totalMessages: total,
        oldestSequence: messages.length > 0 ? total - messages.length : undefined,
        newestSequence: messages.length > 0 ? total - 1 : undefined,
        hasMoreBefore: messages.length < total
      }
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
    const conversation = await storageService.getConversation(request.conversationId);
    const source = conversation?.messages.find(message => message.id === request.sourceMessageId);
    const participants = conversation?.metadata.participants as import("../shared/types").ChatParticipant[] | undefined;
    const participant = participants?.find(item => item.id === source?.participantId);
    if (participant?.homeMachineId) {
      if (!machineLinkService) throw new Error("The choice's machine link is not available.");
      await machineLinkService.respondToMachineChoice({ ...request, machineId: participant.homeMachineId });
    } else {
      const action = choiceDecisionAction(request);
      await publishChatAction(action);
      const event = await storageService.getChatEvent(chatActionEventId(action.payload.operationId));
      if (!event) throw new Error("The choice decision could not be stored.");
      await chatActionApplier.apply(event, action.payload);
      const receipt = await storageService.getChatEvent(machineChoiceResultId(event.eventId));
      const result = receipt ? await storageService.deviceEventBlobs().hydrate(receipt.payload) as import("../shared/machineLink").MachineChoiceResultBody : undefined;
      if (!result?.ok) throw new Error(result?.error ?? "The choice's application is not confirmed yet.");
    }
    return { conversation: await storageService.getConversation(request.conversationId), warnings: [] };
  });
  ipcMain.handle("chat:respond-to-app-tool-approval", async (_event, request: RespondToChatAppToolApprovalRequest) => {
    if (!await chatService.ownsAppToolApproval(request.conversationId, request.approvalId)) {
      const conversation = await storageService.getConversation(request.conversationId);
      const approvals = conversation?.metadata?.pendingAppToolApprovals as import("../shared/types").ChatAppToolApproval[] | undefined;
      if (!approvals?.find(item => item.id === request.approvalId)?.homeMachineId) {
        throw new Error("The approval's owning participant is not available here.");
      }
      return chatService.respondToAppToolApproval(request, progress => emitReviewProgress(progress));
    }
    // The answer becomes a durable event before the provider is told, so a
    // crash between the two leaves the decision recorded rather than lost.
    const action = permissionDecisionAction({
      conversationId: request.conversationId,
      approvalId: request.approvalId,
      approve: request.approve,
      scope: request.scope,
      decisionId: request.codexDecisionId,
      draftOverride: request.draftOverride
    });
    await publishChatAction(action);
    const event = await storageService.getChatEvent(chatActionEventId(action.payload.operationId));
    if (!event) throw new Error("The approval decision could not be stored.");
    await chatActionApplier.apply(event, action.payload);
    const receipt = await storageService.getChatEvent(machineApprovalResultId(event.eventId));
    const result = receipt ? await storageService.deviceEventBlobs().hydrate(receipt.payload) as import("../shared/machineLink").MachineApprovalResultBody : undefined;
    if (!result?.ok) throw new Error(result?.error ?? "The approval's application is not confirmed yet.");
    return storageService.getConversation(request.conversationId);
  });
  ipcMain.handle("machines:list", async (): Promise<MachineListResult> => machineListResult());
  ipcMain.handle("machines:create", async (_event, request: CreateMachineRequest): Promise<CreateMachineResult> => {
    const name = typeof request?.name === "string" ? request.name.trim() : "";
    if (!name) {
      throw new Error("A machine needs a name.");
    }
    const settings = await settingsService.getPublicSettings();
    // Machines use the same live room and sealed durable buffer as the phone.
    // The static PWA origin and the old command mailbox are not needed here.
    const pairing = await mobilePairingService.createPairing({
      purpose: "machine-host",
      ttlMinutes: MACHINE_ENROLLMENT_TTL_MINUTES,
      relayUrl: settings.mobileControl.defaults.relayUrl,
      outboxUrl: settings.mobileControl.defaults.outboxUrl
    });
    if (!pairing.package.relayUrl) {
      throw new Error("Machines need a relay URL; set the mobile control relay in Settings first.");
    }
    if (!pairing.package.outboxUrl) {
      throw new Error("Machines need a sealed mailbox URL; set the mobile control mailbox in Settings first.");
    }
    // Reserve the sealed mailbox before exposing its enrollment credentials.
    if (!await ensureMailboxRegisteredForPairing(pairing.package)) {
      throw new Error("The machine's relay mailbox could not be registered. Try adding the machine again.");
    }
    const record = {
      id: randomUUID(),
      name,
      deviceId: "",
      pairingKey: pairing.package.rendezvousId,
      createdAt: new Date().toISOString()
    };
    await settingsService.saveMachine(record, pairing.package);
    await machineLinkService?.connectMachine(record).catch((error) => {
      void debugLogService.write("machine-link.connect.error", { machineId: record.id, message: error instanceof Error ? error.message : String(error) });
    });
    void machineListResult().then((result) => sendToMainWindow("machines:updated", result));
    return { machine: record, enrollmentJson: JSON.stringify(pairing.package, null, 2) };
  });
  ipcMain.handle("machines:remove", async (_event, request: RemoveMachineRequest): Promise<MachineListResult> => {
    const id = typeof request?.id === "string" ? request.id.trim() : "";
    if (!id) {
      throw new Error("Machine id is required.");
    }
    await machineLinkService?.disconnectMachine(id);
    // Every device that was handed this machine's power key loses the handoff
    // with the machine; the key itself still needs rotating, and the outcome
    // is written to the debug log rather than lost.
    for (const outcome of await machinePowerHandoffService.revokeForMachine(id, "machine-removed")) {
      void debugLogService.write("machine.power.handoff.revoked", {
        handoffId: outcome.handoffId, keyRotationRequired: outcome.keyRotationRequired, detail: outcome.detail
      });
    }
    await settingsService.removeMachine(id);
    const result = await machineListResult();
    sendToMainWindow("machines:updated", result);
    return result;
  });
  ipcMain.handle("machines:install-probe", async (_event, request: { machineId: string; target: MachineSshTarget }): Promise<MachineRuntimeProbe> => {
    return machineInstallerService.probe(assertMachineSshTarget(request?.target));
  });
  ipcMain.handle("machines:install", async (_event, request: MachineInstallRequest): Promise<MachineInstallResult> => {
    return machineInstallerService.install(
      { ...request, machineId: assertMachineId(request?.machineId), target: assertMachineSshTarget(request?.target) },
      (snapshot) => sendToMainWindow("machines:install-progress", snapshot)
    ).then(async (result) => {
      sendToMainWindow("machines:updated", await machineListResult());
      return result;
    });
  });
  ipcMain.handle("machines:upgrade", async (_event, request: MachineUpgradeRequest): Promise<MachineInstallResult> => {
    return machineInstallerService.upgrade(
      { ...request, machineId: assertMachineId(request?.machineId), target: assertMachineSshTarget(request?.target) },
      (snapshot) => sendToMainWindow("machines:install-progress", snapshot)
    ).then(async (result) => {
      sendToMainWindow("machines:updated", await machineListResult());
      return result;
    });
  });
  ipcMain.handle("machines:bootstrap-mirror", async (_event, request: MachineMirrorBootstrapRequest): Promise<MachineMirrorBootstrapResult> => {
    // Defaults to the project the app currently has open, so the Machines
    // screen does not need its own project picker.
    const localPath = (typeof request?.localPath === "string" ? request.localPath.trim() : "")
      || (await settingsService.getPublicSettings()).lastRepoPath?.trim()
      || "";
    if (!localPath) {
      throw new Error("Open a project first; there is nothing to put on the machine.");
    }
    return machineInstallerService.bootstrapProjectMirror({ machineId: assertMachineId(request?.machineId), localPath });
  });
  ipcMain.handle("machines:install-list", async (): Promise<MachineInstallRecord[]> => settingsService.listMachineInstalls());
  // A machine answers the devices on this list, so the User can see exactly
  // which ones they are and take one off.
  ipcMain.handle("machines:trusted-devices", async (): Promise<MachineTrustedDevicesResult> => trustedDevicesResult());
  ipcMain.handle("machines:trust-device", async (_event, request: SaveTrustedDeviceRequest): Promise<MachineTrustedDevicesResult> => {
    await settingsService.saveTrustedDevice({
      deviceId: String(request?.deviceId ?? "").trim(),
      publicKeyDerBase64: String(request?.publicKeyDerBase64 ?? "").trim(),
      role: request?.role === "phone" ? "phone" : "desktop",
      name: String(request?.name ?? "").trim() || "Another device",
      addedAt: new Date().toISOString()
    });
    await machineLinkService?.refreshTrustRosters();
    return trustedDevicesResult();
  });
  ipcMain.handle("machines:untrust-device", async (_event, deviceId: string): Promise<MachineTrustedDevicesResult> => {
    await settingsService.removeTrustedDevice(String(deviceId ?? "").trim());
    // Removing the device also closes the pairing it was speaking on. Leaving
    // it open meant a revoked phone kept receiving this desktop's timeline and
    // could re-announce itself; the store records the revocation, and this
    // makes it true for the connection that is live right now.
    await applyStoredMobilePairingRevocations();
    await machineLinkService?.refreshTrustRosters();
    return trustedDevicesResult();
  });
  ipcMain.handle("machines:install-payload", async (): Promise<MachineRuntimePayloadInfo> => machineInstallerService.readPayload());
  ipcMain.handle("machines:enrollment", async (_event, request: MachineEnrollmentRequest): Promise<CreateMachineResult> => {
    const id = typeof request?.id === "string" ? request.id.trim() : "";
    const machine = (await settingsService.listMachines()).find((item) => item.id === id);
    if (!machine) {
      throw new Error("Machine not found.");
    }
    const pairing = await settingsService.getMachinePairing(machine.pairingKey);
    if (!pairing) {
      throw new Error("The machine's enrollment is missing; remove and add the machine again.");
    }
    return { machine, enrollmentJson: JSON.stringify(pairing, null, 2) };
  });
  ipcMain.handle("mobile:create-pairing", async (_event, request: CreateMobilePairingRequest) => {
    const settings = await settingsService.getPublicSettings();
    const minted = await mobilePairingService.createPairing(
      mobilePairingRequestWithEndpointDefaults(request, settings.mobileControl.defaults)
    );
    // The scoped power key travels sealed with the pairing and nowhere else.
    const result = { ...minted, package: await machinePowerHandoffForPairing(minted.package) };
    // Lock the mailbox before the link leaves this machine: registration is
    // trust-on-first-use, and only this process knows the scope id until the
    // link is shown. A failure is surfaced on the result and retried both
    // when the pairing reconnects and whenever mailbox traffic reports the
    // mailbox as unregistered.
    const mailboxRegistered = await ensureMailboxRegisteredForPairing(result.package);
    await recordMobilePairingCapabilityGrant(result.package);
    prepareMobileControlForPairing(result.package);
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
    // Stop is unconditional and idempotent: the same run stopped twice is one
    // operation. The event is what lets the machine that owns the run see it.
    const stopConversationId = chatService.conversationIdForRun(runId);
    if (stopConversationId) {
      void chatActionEmitter.stopRequested({ conversationId: stopConversationId, runId, by: "user" })
        .catch(() => undefined);
    }
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
  // Before any pairing is restored: a revocation the owner made is a fact
  // about this device, not about the process that was running when it happened.
  await applyStoredMobilePairingRevocations().catch(error => {
    void debugLogService.write("mobile.pairing.revocation-restore-error",
      { message: error instanceof Error ? error.message : String(error) });
  });
  void recoverLocalChoiceActions().catch(error => {
    void debugLogService.write("chat.choice.recovery-pending", { message: error instanceof Error ? error.message : String(error) });
  });
  void recoverLocalApprovalActions().catch(error => {
    void debugLogService.write("chat.approval.recovery-error", { message: error instanceof Error ? error.message : String(error) });
  });
  // A change committed here whose outgoing event did not survive would leave
  // peers permanently unaware of it. Recovery is idempotent: the operation ids
  // come from the immutable revision identity, so this is safe every start.
  void (async () => {
    try {
      const summaries = await storageService.listConversations();
      let recovered = 0;
      for (const summary of summaries) {
        if (summary.kind !== "chat") continue;
        recovered += await artifactService.recoverActionEvents(summary.id);
      }
      if (recovered) await debugLogService.write("artifact.action.recovered-at-start", { recovered });
    } catch (error) {
      await debugLogService.write("artifact.action.recover-failed", {
        message: error instanceof Error ? error.message : String(error)
      });
    }
  })();
  try {
    const desktopIdentity = await chatEventLogService.getOrCreateDeviceIdentity();
    machineLinkService = new MachineLinkService(settingsService, debugLogService, {
      chatActions: chatActionApplier,
      // A machine that held an action back because it lacked the revision it
      // refers to asks for exactly that state, and gets the same event again.
      serveChatActionDependency: async (dependency) => dependency.targetKey.startsWith("artifact:")
        && artifactService.emitRevisionActionFor(dependency.targetKey.slice("artifact:".length), dependency.stateId),
      appVersion: app.getVersion(),
      desktopDeviceId: desktopIdentity.originId,
      eventStorage: storageService,
      eventLog: chatEventLogService,
      // Every device the User has trusted is named to each machine, in the
      // room that machine is met in. That is what lets a machine keep working
      // when this desktop is closed.
      trustedDevices: async (room) => (await settingsService.listTrustedDevices()).map((device) => ({
        deviceId: device.deviceId,
        publicKeyDerBase64: device.publicKeyDerBase64,
        role: device.role,
        name: device.name,
        relayUrl: room.relayUrl,
        rendezvousId: room.rendezvousId,
        fingerprint: room.fingerprint
      }))
    });
    machineLinkService.onStatus(() => {
      void machineListResult().then((result) => sendToMainWindow("machines:updated", result));
    });
    machineLinkService.onConversationDeleted((event) => chatService.applyReplicatedConversationDeletion(event.conversationId, event.deletedAt));
    machineLinkService.onConversationBackDelta((delta) => {
      // The machine keeps the result until the desktop has stored it.
      return chatService.applyMachineBackDelta({ conversationId: delta.conversationId, messages: delta.messages })
        .then((conversation) => {
          if (!conversation) throw new Error("The desktop chat is unavailable; machine messages remain unacknowledged.");
          delta.acknowledge?.();
        })
        .catch((error) => {
          void debugLogService.write("machine-link.backdelta.apply-error", { message: error instanceof Error ? error.message : String(error) });
          throw error;
        });
    });
    // A member on a machine asked other members to answer. They run here,
    // each where that member lives; the machine waits for the answers.
    machineLinkService.onParticipantRequest((request) => chatService.runDelegatedParticipantRequest({
      conversationId: request.conversationId,
      requestMessageId: request.requestMessageId,
      depth: request.depth,
      ...(request.targetParticipantIds ? { targetParticipantIds: request.targetParticipantIds } : {})
    }).catch((error) => {
      void debugLogService.write("machine-link.participants.delegate-error", {
        conversationId: request.conversationId,
        requestMessageId: request.requestMessageId,
        message: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }));
    machineLinkService.onApproval((event) =>
      // A failed store must fail the machine's decision outcome (and the
      // card call behind it), so the error is logged and re-thrown.
      chatService.applyMachineApproval({
        conversationId: event.conversationId,
        approval: event.approval,
        policies: event.policies,
        decisionId: event.decisionId
      }).then(() => undefined, (error: unknown) => {
        void debugLogService.write("machine-link.approval.apply-error", { message: error instanceof Error ? error.message : String(error) });
        throw error;
      })
    );
    machineLinkService.onRunStarted((event) => chatService.applyMachineRunStarted(event));
    machineLinkService.onProgress(emitReviewProgress);
    machineLinkService.onLateTerminal((event) =>
      chatService.applyMachineLateTerminal({
        conversationId: event.conversationId,
        runId: event.runId,
        status: event.status,
        messages: event.messages,
        warnings: event.warnings,
        error: event.error,
        finishedAt: event.finishedAt,
        receiptId: event.receiptId,
        machineName: event.machineName
      })
    );
    machineLinkService.setConversationLoader((conversationId) => storageService.getConversation(conversationId));
    chatService.setMachineLink(machineLinkService);
    void machineLinkService.start().catch((error) => {
      void debugLogService.write("machine-link.start.error", { message: error instanceof Error ? error.message : String(error) });
    });
  } catch (error) {
    void debugLogService.write("machine-link.init.error", { message: error instanceof Error ? error.message : String(error) });
  }
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
  await chatService.reconcileConversationDeletions().catch((error) => {
    void debugLogService.write("chat.delete.reconcile-error", { message: error instanceof Error ? error.message : String(error) });
  });
  await chatService.reconcileDeletedConversationArtifacts().catch((error) => {
    void debugLogService.write("chat.delete.artifacts.reconcile-error", {
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
  // The updater cannot await the normal graceful quit gate. Kill warm CLI
  // process trees synchronously so detached background work cannot outlive the
  // app and keep mutating the repository during installation.
  cliAgentRunner.terminateWarmAgentsImmediately("update installation");
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
    cliAgentRunner.shutdownWarmAgents(),
    appMcpService.stop()
  ]);
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5_000));
  void Promise.race([cleanup.then(() => undefined), timeout]).finally(() => {
    quitCleanupFinished = true;
    app.quit();
  });
});

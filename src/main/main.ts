import path from "node:path";
import { HubInstaller, removeStaleHubTemp } from "./services/hubInstaller";
import { CloudRunPreparationService, cloudEnvironmentDirectory } from "./services/cloudRunPreparation";
import { AwsInstanceDiskService } from "./services/awsInstanceDisk";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { app, autoUpdater, BrowserWindow, dialog, ipcMain, powerMonitor, shell } from "electron";
import type { AvatarStudioTurnRequest, SaveCustomAvatarRequest } from "../shared/avatarStudio";
import type {
  AddChatParticipantRequest,
  AgentDetectionRequest,
  CliProviderHostUpdate,
  DeleteAgentEnvironmentVariableRequest,
  AgentHealth,
  ChatBehaviorRuleConfigUpdate,
  ChatProviderKind,
  ChatPromptContextSettings,
  ChatSearchRequest,
  ChatSavedPromptConfigUpdate,
  CloudRunsSettingsUpdate,
  CloudRunWorkerDoctorReport,
  CloudRunWorkerSettings,
  ConnectAwsWorkerRequest,
  AwsWorkerStartRequest,
  AwsDiskCleanCategory,
  SetAwsAutoStopRequest,
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
import { ArtifactClient } from "./services/artifactClient";
import { ArtifactStore } from "./services/artifactStore";
import { createArtifactToolDispatcher, wireArtifactToolHandler, wireChatAppToolHandlers } from "./appToolWiring";
import { ScriptService } from "./services/scripts";
import { ScriptHub } from "./services/scriptHub";
import { HubClient } from "./services/hubClient";
import { ServerChatLink } from "./services/serverChatLink";
import { deviceIdForPublicKey, hubCertificateCrypto, signHubText } from "./services/hubAuth";
import { HubPhonePublisher } from "./services/hubPhonePublisher";
import {
  HUB_PHONE_PROTOCOL_VERSION,
  hubPhoneInviteSigningText,
  verifyHubPhoneEnrollment,
  type HubPhoneInvite
} from "./../shared/hubProtocol";
import { machineSigningKey } from "../shared/machineLink";
import { HubTunnelClient } from "./services/hubTunnelClient";
import { ScriptSecretStore, ScriptStore } from "./services/scriptStore";
import { hostPlatform } from "./platform";
import {
  SCRIPT_DESKTOP_HOST_ID,
  type DeleteScriptSecretRequest,
  type GetScriptRevisionRequest,
  type ScriptIdRequest,
  type SetScriptEnabledRequest,
  type SetScriptSecretRequest
} from "../shared/scripts";
import { DeviceIdentityService } from "./services/deviceIdentity";
import { ChatService } from "./services/chat";
import { MobilePairingService } from "./services/mobilePairing";
import { MachineLinkService } from "./services/machineLink";
import { MachineInstallerService, machinePowerNeedsDelivery } from "./services/machineInstaller";
import { MACHINE_POWER_MAX_ATTEMPTS, MACHINE_POWER_RETRY_MS, compareVersions } from "../shared/machineInstall";
import { MachinePowerHandoffService } from "./services/machinePowerHandoff";
import { removeRelayEraRecords } from "./services/relayRemoval";
import { MachineInactivityQuestions } from "./services/machineInactivityQuestions";
import { MachineApprovalExecutor } from "./services/machineApprovalExecutor";
import { readPosixProcessTableAsync } from "./services/processTermination";
import { MachineChoiceExecutor, MachineMentionExecutor } from "./services/chatActionNativeClaims";
import type { ChatCardAppliers } from "./services/chatCards";
import type { AnswerMachineInactivityRequest, CreateMachineRequest, CreateMachineResult, MachineEnrollmentRequest, MachineInactivityQuestion, MachineListResult, MachineTrustedDevicesResult, RemoveMachineRequest, SaveTrustedDeviceRequest } from "../shared/machineLink";
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
import { type CreateMobilePairingResult, type MobilePairingPackage } from "../shared/mobilePairing";
import { CliAgentRunner } from "./services/cliAgents";
import { ConsensusService } from "./services/consensus";
import { AppMcpService } from "./services/appMcp";
import { AppSkillsService } from "./services/appSkills";
import { AvatarStudioService } from "./services/avatarStudio";
import { AgentEnvironmentService } from "./services/agentEnvironment";
import { CRASH_REPORTS_ACTIVE_ARG, crashReportingActive, startCrashReporting, stopCrashReporting } from "./services/crashReporting";
import { discardCrashReportData, loadOrCreateCrashReportInstallId, readCrashReportsEnabled } from "./services/crashReportPreferences";
import { isServerUpdateLoaderWindow, openServerUpdateLoader, updateServerBeforeOpening } from "./services/serverUpdateLoader";
import { ACTIVITY_RECHECK_MS, appHiddenForUpdate, bootstrapAppUpdater, createUpdateRestart, createUpdateRestartGate, currentUpdateWindows, quitAndInstallUpdate, showUpdateRestartPrompt, updatePromptWindowShown } from "./services/appUpdater";
import { MachineAutoUpgradeService } from "./services/machineAutoUpgrade";
import { MachineRecoveryService } from "./services/machineRecovery";
import { MachineInactivityCheck } from "./services/machineInactivity";
import { isMachineAutoUpgradeOperation, isMachineInstallTerminalPhase, isMachineRecoveryOperation } from "../shared/machineInstall";
import { CommandError, commandEnvironment, ensureLoginShellEnvPrimed, runCommand, setCommandDebugLogger } from "./services/command";
import { buildCloudRunSshTarget, cloudRunSshOptionArgs, cloudRunWorkerTargetFromSettings, normalizeCloudRunWorkerSettings, validateCloudRunSshWorkerFields } from "./services/cloudRunWorkers";
import { CloudRunDoctorService, enabledCloudProviders } from "./services/cloudRunDoctor";
import { CloudRunSetupSession } from "./services/cloudRunSetupSession";
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

// Once the profile directory is final and before the app is ready: the SDK
// registers the scheme the window reports through and starts the native
// crash handler, and neither can happen later.
const crashReportingStart = readCrashReportsEnabled(app.getPath("userData"))
  ? startCrashReporting(loadOrCreateCrashReportInstallId(app.getPath("userData")))
  : discardCrashReportDataAtLaunch();

function discardCrashReportDataAtLaunch(): { active: false; error?: string } {
  try {
    discardCrashReportData(app.getPath("userData"));
    return { active: false };
  } catch (error) {
    return { active: false, error: error instanceof Error ? error.message : String(error) };
  }
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
void debugLogService.write("crash-reports.start", { ...crashReportingStart });

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
/** This computer's own key: it signs its requests to the User's server and
 *  what it seals and signs in its machines' rooms. */
const deviceIdentityService = new DeviceIdentityService(storageService);
const mobilePairingService = new MobilePairingService(deviceIdentityService);
const consensusService = new ConsensusService(gitService, storageService, providerRunner, cliAgentRunner, debugLogService, (conversation) => {
  sendToMainWindow("conversations:updated", conversation);
});
// Machines transport: enrolled machines that host participants.
let machineLinkService: MachineLinkService | undefined;
/** When this desktop started connecting to its machines. */
let machineLinkStartedAt: number | undefined;
const DESKTOP_LINK_STARTUP_GRACE_MS = 60_000;
const chatService = new ChatService(storageService, settingsService, cliAgentRunner, debugLogService, appMcpService, (conversation, update) => {
  // The renderer receives the delta form — the messages that changed plus the
  // newest window — because on a chat with thousands of messages the full
  // snapshot is tens of megabytes per update.
  sendToMainWindow("conversations:updated", update);
  // Which members live on machines (their live progress is theirs to publish).
  hubPhonePublisher.noteConversation(conversation);
}, userSkillsService, (progress) => emitReviewProgress(progress));
// Every progress path reaches the phone (through the server), not only the
// renderer: interactive runs (chat:send, accord, compaction) pass their own
// per-run callback.
function emitReviewProgress(progress: ReviewProgress): void {
  sendToMainWindow("conversations:review-progress", progress);
  // A local member's live text, for the phone to show from the server.
  hubPhonePublisher.noteProgress(progress, chatService.conversationIdForRun(progress.runId));
}

const cloudRunDoctorService: CloudRunDoctorService = new CloudRunDoctorService({
  environmentForWorker: async (worker, readOnly) => {
    if (!worker.hostKeyAlias?.startsWith("accordagents-i-")) return {};
    const directory = cloudEnvironmentDirectory((await deviceIdentityService.getOrCreateDeviceIdentity()).originId);
    return machineInstallerService.providerEnvironment(worker, `~/${directory}`, readOnly);
  },
  openExternal: (url) => {
    void openExternalUrl(url).catch(() => undefined);
  },
  logger: (event, payload) => {
    void debugLogService.write(event, payload);
  }
});
const cloudRunSetupSession = new CloudRunSetupSession();
/** The owner's link to the User's own server (roster, phone pairing, the
 *  phone's catalog), when one is set up. Chats go through serverChatLink. */
let hubClient: HubClient | undefined;
let hubRosterPublish: Promise<void> | undefined;
let hubRosterAgain = false;
let hubRosterRetry: ReturnType<typeof setTimeout> | undefined;
let hubRosterRetryMs = 5_000;
/** The server took this desktop's device list, which only its owner may set. */
let hubOwnerConfirmed = false;

/** Phones paired with the User's server (the ones it admits). */
async function hubPhones(): Promise<import("../shared/machineTrust").TrustedDeviceRecord[]> {
  return (await settingsService.listTrustedDevices().catch(() => [])).filter((device) => device.role === "phone" && device.inviteId && device.phoneScope);
}

// Documents (artifacts) are the User's server's too (Д9): this computer keeps
// a copy, in their own tables of the same SQLite database as conversations,
// and writes every change through the server.
const artifactStore = new ArtifactStore(path.join(app.getPath("userData"), "accordagents.sqlite3"), sqliteExecutable);
const artifactService = new ArtifactClient({
  store: artifactStore,
  getMembers: async (conversationId) => {
    const opened = await storageService.openConversation(conversationId, 1);
    return opened?.conversation.kind === "chat" ? artifactMembersForConversation(opened.conversation) : undefined;
  },
  postNote: (conversationId, eventId, content) => chatService.postArtifactChatNote(conversationId, eventId, content),
  hasChat: async (conversationId) => (await storageService.openConversation(conversationId, 1))?.conversation.kind === "chat",
  onChanged: (conversationId) => {
    sendToMainWindow("artifacts:updated", { conversationId });
  },
  logger: (event, payload) => {
    void debugLogService.write(event, payload);
  }
});
chatService.setArtifactCleanup((conversationId) => artifactService.deleteConversationArtifacts(conversationId));

/** The User's server owns every chat (agreements Д1–Д13): her own server, or
 *  the same server inside this app when she has none (Д6). */
const serverChatLink = new ServerChatLink({
  storage: storageService,
  chat: chatService,
  identity: () => deviceIdentityService.getOrCreateDeviceIdentity(),
  hubConfig: async () => {
    const config = await settingsService.getHubConfig();
    return config ? { url: config.url } : undefined;
  },
  startEmbedded: async (owner) => {
    const { startEmbeddedHub } = await import("../hub/embeddedHub");
    return startEmbeddedHub({
      dataDir: path.join(app.getPath("userData"), "embedded-server"),
      owner,
      version: app.getVersion(),
      sqliteExecutable,
      log: (event, payload) => { void debugLogService.write(event, payload); }
    });
  },
  machineNames: async () => (await settingsService.listMachines().catch(() => [])).map((machine) => ({ id: machine.id, name: machine.name })),
  movesChats: true,
  artifacts: artifactService,
  log: (event, payload) => { void debugLogService.write(event, payload); }
});

/** The link to the server follows the hub settings: a new server, or none. */
async function restartServerChatLink(): Promise<void> {
  await serverChatLink.stop();
  serverChatLinkStarted = true;
  await serverChatLink.start();
}

/** Whether the link to the server has been started in this run: at start,
 *  or after the server's program was updated before the window opened. */
let serverChatLinkStarted = false;
async function startServerChatLinkOnce(): Promise<void> {
  if (serverChatLinkStarted) return;
  serverChatLinkStarted = true;
  await serverChatLink.start().catch((error: unknown) => {
    void debugLogService.write("chat.server.start-error", { message: error instanceof Error ? error.message : String(error) });
  });
}

let lastNewChatOptions: import("../shared/hubProtocol").HubNewChatOptions | undefined;
const hubPhonePublisher: HubPhonePublisher = new HubPhonePublisher({
  client: () => hubOwnerConfirmed ? hubClient : undefined,
  hasPhones: async () => (await hubPhones()).length > 0,
  machineMembersOf: async (conversationId) => {
    const opened = await storageService.openConversation(conversationId, 1);
    const participants = Array.isArray(opened?.conversation.metadata?.participants) ? opened!.conversation.metadata.participants as Array<{ id?: string; homeMachineId?: string }> : [];
    return new Set(participants.filter((participant) => participant?.id && participant.homeMachineId).map((participant) => participant.id as string));
  },
  buildCatalog: async (upload) => {
    const settings = await settingsService.getPublicSettings();
    for (const avatar of settings.chatCustomAvatars ?? []) {
      await upload(`custom:${avatar.id}`, `${avatar.id}:${avatar.createdAt}`, async () => {
        const read = await settingsService.readCustomAvatar(avatar.id);
        return { mimeType: read.mediaType, bytes: Buffer.from(read.dataBase64, "base64") };
      }).catch(() => undefined);
    }
    const skills = await userSkillsService.listAll({ limit: 300 }).catch(() => ({ skills: [] as import("../shared/types").UserSkillSummary[] }));
    // The phone's New chat, as this computer's offers it; what it last
    // offered while it cannot tell now (a CLI check that failed, say).
    const newChat = await storageService.listConversations()
      .then((summaries) => chatService.newChatOptions(summaries))
      .catch((error) => {
        void debugLogService.write("hub.phone.new-chat-options-error", { message: error instanceof Error ? error.message : String(error) });
        return undefined;
      }) ?? lastNewChatOptions;
    lastNewChatOptions = newChat;
    return {
      ...(newChat ? { newChat } : {}),
      roles: Object.fromEntries(settings.chatRoleConfigs.map((role) => [role.id,
        role.id === "generic-participant" && role.label === "Generic Participant" ? "Generic Member" : role.label])),
      prompts: (settings.chatSavedPrompts ?? []).slice(0, 200).map((prompt) => ({ id: prompt.id, label: prompt.label, trigger: prompt.trigger, body: prompt.body.slice(0, 20_000) })),
      skills: skills.skills
        .filter((skill) => skill.capabilityState === "invocable" && !skill.ambiguous)
        .map(({ scopeKinds: _scopeKinds, statusMessage: _statusMessage, ambiguous: _ambiguous, ...skill }) => ({ ...skill, description: skill.description?.slice(0, 400) }))
    };
  },
  wakeKeys: async () => {
    const wake = await cloudRunAwsService.deviceWakePower().catch(() => undefined);
    if (!wake?.machineId) return [];
    return [{ machineId: wake.machineId, instanceId: wake.config.instanceId, region: wake.config.credentials.region, credentials: wake.config.credentials }];
  },
  log: (event, payload) => { void debugLogService.write(event, payload); }
});

/**
 * A phone that pairs with one of this desktop's invites is on the server's
 * roster from that moment (the server checked the invite's token). This
 * desktop learns it from there, not from anything the phone writes: it checks
 * that the invite is its own (signed with its key) and the acceptance the
 * phone's (signed with the phone's key, inside the invite's window), and from
 * then on names the phone itself, on the server's roster and on every
 * machine. A phone whose invite this desktop revoked is not admitted, and the
 * next roster it publishes takes it off. Returns how many were admitted.
 */
async function admitEnrolledPhones(): Promise<number> {
  const client = hubClient;
  if (!client) return 0;
  const roster = await client.roster();
  const identity = await deviceIdentityService.getOrCreateDeviceIdentity();
  const trusted = await settingsService.listTrustedDevices().catch(() => []);
  let admittedCount = 0;
  for (const record of roster.enrollments ?? []) {
    const onRoster = roster.devices.find((device) => device.deviceId === record.deviceId && device.role === "phone");
    if (!onRoster || onRoster.inviteId !== record.invite?.inviteId) continue;
    // Read again every time the roster is: what is known already changes
    // nothing, and nobody is told again.
    const known = trusted.find((device) => device.deviceId === record.deviceId);
    if (known && known.inviteId === record.invite.inviteId && known.publicKeyDerBase64 === record.enrollment?.publicKeyDerBase64) continue;
    if (!verifyHubPhoneEnrollment(record, { issuerDeviceId: identity.originId, issuerPublicKeyDerBase64: identity.publicKeyDerBase64, ...hubCertificateCrypto }) ||
        record.enrollment.deviceId !== record.deviceId || onRoster.publicKeyDerBase64 !== record.enrollment.publicKeyDerBase64) {
      void debugLogService.write("hub.phone.enrollment-refused", { deviceId: record.deviceId, inviteId: record.invite?.inviteId ?? "" });
      continue;
    }
    const admitted = await settingsService.admitInvitedPhone({
      deviceId: record.enrollment.deviceId,
      publicKeyDerBase64: record.enrollment.publicKeyDerBase64,
      role: "phone",
      name: record.enrollment.name || record.invite.name || "Phone",
      addedAt: record.enrollment.enrolledAt,
      inviteId: record.invite.inviteId,
      phoneScope: record.invite.scope
    });
    void debugLogService.write("hub.phone.admitted", { deviceId: record.enrollment.deviceId, inviteId: record.invite.inviteId, admitted });
    if (admitted) admittedCount += 1;
  }
  if (admittedCount > 0) {
    publishHubRoster();
    hubPhonePublisher.phonesChanged();
    hubPhonePublisher.scheduleCatalog(0);
    hubPhonePublisher.publishWakeKeys();
  }
  return admittedCount;
}

/** How often the server's roster is read for phones that paired: every
 *  minute, and every few seconds while an invite this desktop made waits to
 *  be used (the User is pairing a phone right now). */
const HUB_PHONE_ROSTER_EVERY_MS = 60_000;
const HUB_PHONE_ROSTER_PAIRING_MS = 5_000;
let hubPhoneRosterTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleEnrolledPhones(delayMs: number): void {
  if (hubPhoneRosterTimer) clearTimeout(hubPhoneRosterTimer);
  hubPhoneRosterTimer = setTimeout(() => {
    hubPhoneRosterTimer = undefined;
    void (async () => {
      if (hubClient) {
        await admitEnrolledPhones().catch((error: unknown) => {
          void debugLogService.write("hub.phone.roster-read-error", { message: error instanceof Error ? error.message : String(error) });
        });
      }
      const invites = await settingsService.listPhoneInvites().catch(() => []);
      const pairing = invites.some((invite) => invite.state === "pending" && Date.parse(invite.expiresAt) > Date.now());
      scheduleEnrolledPhones(pairing ? HUB_PHONE_ROSTER_PAIRING_MS : HUB_PHONE_ROSTER_EVERY_MS);
    })();
  }, Math.max(0, delayMs));
  hubPhoneRosterTimer.unref?.();
}

/**
 * Tells the hub which devices are the User's: this desktop and every machine
 * whose key it knows. The hub admits nobody else, so a machine set up here
 * can reach it before its first hello. Coalesced: a change during a publish
 * is sent once more after it.
 */
function publishHubRoster(): void {
  if (!hubClient) return;
  if (hubRosterPublish) {
    hubRosterAgain = true;
    return;
  }
  const client = hubClient;
  if (hubRosterRetry) clearTimeout(hubRosterRetry);
  hubRosterRetry = undefined;
  hubRosterPublish = (async () => {
    const identity = await deviceIdentityService.getOrCreateDeviceIdentity();
    const machines = (await settingsService.listMachines()).flatMap((machine) => {
      const publicKeyDerBase64 = machineSigningKey(machine);
      // An entry whose id does not derive from its key would make the hub
      // refuse the whole list: it is left out, and said so.
      if (!machine.deviceId || !publicKeyDerBase64) return [];
      if (deviceIdForPublicKey(publicKeyDerBase64) !== machine.deviceId) {
        void debugLogService.write("hub.roster.inconsistent-machine", { machineId: machine.id });
        return [];
      }
      return [{ deviceId: machine.deviceId, publicKeyDerBase64, role: "machine" as const, name: machine.name, machineId: machine.id }];
    });
    // The phones paired with the server, as their invites allowed; and the
    // invites this desktop has settled, so a phone it removed stays out.
    const phones = (await hubPhones()).map((phone) => ({
      deviceId: phone.deviceId, publicKeyDerBase64: phone.publicKeyDerBase64, role: "phone" as const, name: phone.name,
      scope: phone.phoneScope!, inviteId: phone.inviteId!
    }));
    await client.setRoster([
      { deviceId: identity.originId, publicKeyDerBase64: identity.publicKeyDerBase64, role: "desktop", name: "This computer" },
      ...machines,
      ...phones
    ], await settingsService.resolvedPhoneInviteIds());
    hubRosterRetryMs = 5_000;
    hubOwnerConfirmed = true;
    void debugLogService.write("hub.roster.published", { machines: machines.length, phones: phones.length });
    // The machines it names read their settings from the server.
    void machineLinkService?.syncSettings().catch((error: unknown) => {
      void debugLogService.write("machine-link.settings.sync-error", { message: error instanceof Error ? error.message : String(error) });
    });
    hubPhonePublisher.scheduleCatalog();
    hubPhonePublisher.publishWakeKeys();
  })().catch((error: unknown) => {
    // A machine set up while the hub was away would be refused by it: the
    // list goes up again until the hub has it.
    void debugLogService.write("hub.roster.error", { message: error instanceof Error ? error.message : String(error), retryMs: hubRosterRetryMs });
    hubRosterRetry = setTimeout(() => { hubRosterRetry = undefined; publishHubRoster(); }, hubRosterRetryMs);
    hubRosterRetry.unref?.();
    hubRosterRetryMs = Math.min(5 * 60_000, hubRosterRetryMs * 2);
  }).finally(() => {
    hubRosterPublish = undefined;
    if (hubRosterAgain) {
      hubRosterAgain = false;
      publishHubRoster();
    }
  });
}

/** When each device last read the server's feed, as the server says; asked
 *  at most once a minute (the inactive-machine question reads it). */
let hubFeedReadsCache: { at: number; value?: Map<string, string> } = { at: 0 };
async function hubFeedReads(): Promise<Map<string, string> | undefined> {
  const client = hubClient;
  if (!client || !hubOwnerConfirmed) return undefined;
  if (Date.now() - hubFeedReadsCache.at < 60_000) return hubFeedReadsCache.value;
  const roster = await client.roster().catch(() => undefined);
  hubFeedReadsCache = { at: Date.now(), value: roster?.feedReads ? new Map(roster.feedReads.map((read) => [read.deviceId, read.readAt])) : hubFeedReadsCache.value };
  return hubFeedReadsCache.value;
}

/**
 * Plain lines for Settings → Your server about this computer's link to it:
 * what it wrote and has not got to the server yet, and why the last attempt
 * failed (the server keeps every failed attempt's reason, Д12).
 */
async function hubLinkNotices(): Promise<string[]> {
  const status = await serverChatLink.status().catch(() => undefined);
  if (!status) return [];
  const lines: string[] = [];
  if (!status.ready) lines.push("This computer is still moving its chats to your server; new messages wait for it.");
  if (status.queued > 0 && (status.unreachableSince !== undefined || !status.ready)) {
    lines.push(`${status.queued} change${status.queued === 1 ? "" : "s"} from this computer ${status.queued === 1 ? "is" : "are"} waiting to reach your server.`);
  }
  if (status.lastError && status.unreachableSince !== undefined) lines.push(`Last attempt: ${status.lastError}`);
  return lines;
}

async function startHubLink(): Promise<void> {
  const config = await settingsService.getHubConfig();
  if (!config) return;
  hubOwnerConfirmed = false;
  const identity = () => deviceIdentityService.getOrCreateDeviceIdentity();
  hubClient = new HubClient({ url: config.url, identity });
  // Another server (or the first): every machine's settings are put there.
  machineLinkService?.resetPublishedSettings();
  const blobClient = hubClient;
  // A picture the User sent from the phone is read from the server.
  chatService.setHubBlobReader((reference) => blobClient.downloadBytes(reference));
  hubPhonePublisher.reset();
  publishHubRoster();
  // Phones that paired while this desktop was away are on the server's
  // roster: learned now, and the roster is read again from then on.
  scheduleEnrolledPhones(0);
  void debugLogService.write("hub.link.started", { url: config.url });
  scheduleHubProgramUpdate();
}

/** The program on the User's server follows this desktop: after the desktop
 *  updates, the server is updated the way the Update button does it, once a
 *  minute after the link starts, and again later if it did not work (a few
 *  times per version at most). Settings shows its progress like a press. */
let hubProgramUpdateTimer: ReturnType<typeof setTimeout> | undefined;
const hubProgramUpdateTries = new Map<string, number>();
const HUB_PROGRAM_UPDATE_DELAY_MS = 60_000;
const HUB_PROGRAM_UPDATE_RETRY_MS = 30 * 60_000;
const HUB_PROGRAM_UPDATE_MAX_TRIES = 3;

function scheduleHubProgramUpdate(delayMs = HUB_PROGRAM_UPDATE_DELAY_MS): void {
  if (hubProgramUpdateTimer) return;
  hubProgramUpdateTimer = setTimeout(() => {
    hubProgramUpdateTimer = undefined;
    void updateHubProgramIfBehind();
  }, delayMs);
  hubProgramUpdateTimer.unref?.();
}

/** The update the User's server's program is due, if any: only the installed
 *  app updates it by itself (a build run from a checkout, or pointed at a
 *  test server, never puts its program there), only a server this desktop
 *  set up (it holds the key to it) and syncs with, and only when its program
 *  is older than this desktop. */
async function hubProgramUpdateDue(): Promise<{ from: string; to: string } | undefined> {
  if (!app.isPackaged || process.env.ACCORDAGENTS_HUB_URL?.trim()) return undefined;
  const config = await settingsService.getHubConfig().catch(() => undefined);
  const installed = config?.server?.installedVersion;
  const desktop = app.getVersion();
  if (!config?.server || !installed || compareVersions(desktop, installed) <= 0) return undefined;
  try {
    if (new URL(config.url).hostname !== config.server.ip) return undefined;
  } catch {
    return undefined;
  }
  return { from: installed, to: desktop };
}

/** The update made before the app's window opens is running. */
let hubProgramUpdatingBeforeOpening = false;

async function updateHubProgramIfBehind(): Promise<void> {
  const due = await hubProgramUpdateDue();
  if (!due) return;
  const desktop = due.to;
  if (hubProgramUpdatingBeforeOpening) {
    scheduleHubProgramUpdate(5 * 60_000);
    return;
  }
  // The server has just confirmed this desktop is its owner (only the owner
  // sets its devices): a desktop that is not cannot replace its program.
  if (!hubOwnerConfirmed) {
    // Not confirmed yet (the server away, this desktop offline): asked again.
    scheduleHubProgramUpdate(5 * 60_000);
    return;
  }
  // Updating stops the server for a few seconds: not while a member works.
  const busy = chatService.liveRunIds().length > 0
    || machineInstallerService.hasActiveOperations()
    || (await machineLinkService?.anyMachineBusy().catch(() => true)) === true;
  if (busy) {
    scheduleHubProgramUpdate(5 * 60_000);
    return;
  }
  const tries = hubProgramUpdateTries.get(desktop) ?? 0;
  if (tries >= HUB_PROGRAM_UPDATE_MAX_TRIES) return;
  hubProgramUpdateTries.set(desktop, tries + 1);
  void debugLogService.write("hub.program-update.start", { from: due.from, to: desktop, attempt: tries + 1 });
  try {
    const state = await hubInstaller.install({});
    void debugLogService.write("hub.program-update.finished", { status: state.status, message: state.message ?? "" });
    if (state.status !== "ready") scheduleHubProgramUpdate(HUB_PROGRAM_UPDATE_RETRY_MS);
  } catch (error) {
    void debugLogService.write("hub.program-update.error", { message: error instanceof Error ? error.message : String(error) });
    scheduleHubProgramUpdate(HUB_PROGRAM_UPDATE_RETRY_MS);
  }
}

/** The hub program this app installs: beside the asar when packaged (scp
 *  reads real files), what `npm run build` produced in a checkout. */
function hubPayloadDir(): string {
  const override = process.env.ACCORDAGENTS_HUB_BUNDLE_DIR?.trim();
  if (override) return override;
  if (app.isPackaged) return path.join(process.resourcesPath, "hub");
  return path.join(app.getAppPath(), "dist", "hub");
}

const hubInstaller = new HubInstaller({
  keyDir: path.join(app.getPath("userData"), "hub"),
  payloadDir: hubPayloadDir,
  bundledVersion: app.getVersion(),
  identity: async () => {
    const identity = await deviceIdentityService.getOrCreateDeviceIdentity();
    return { originId: identity.originId, publicKeyDerBase64: identity.publicKeyDerBase64 };
  },
  link: async ({ url, hubId, server }) => {
    await settingsService.saveHubConfig({ url, hubId, server });
    await startHubLink();
    // The chats move to the new server (once per server) and go through it
    // from now on.
    await restartServerChatLink();
  },
  currentLink: () => settingsService.getHubConfig().catch(() => undefined),
  reachable: () => serverChatLink.reachable(),
  notices: () => hubLinkNotices(),
  defaultRegion: async () => (await settingsService.getPublicSettings()).cloudRuns.awsRegion,
  log: (event, payload) => { void debugLogService.write(event, payload); }
});
hubInstaller.onProgress((state) => {
  sendToMainWindow("hub:setup-progress", state);
});
void removeStaleHubTemp().then((removed) => {
  if (removed) void debugLogService.write("hub.setup.temp-removed", { removed });
});

/** The AWS instance a worker target names (its host key alias carries it). */
function awsInstanceOfWorker(worker: { hostKeyAlias?: string }): string | undefined {
  const prefix = "accordagents-";
  return worker.hostKeyAlias?.startsWith(prefix) ? worker.hostKeyAlias.slice(prefix.length) : undefined;
}

/** Resolves once the machine link has started, or could not start. */
let markMachineLinkReady: () => void = () => undefined;
const machineLinkReady = new Promise<void>((resolve) => { markMachineLinkReady = resolve; });
const cloudRunAwsService = new CloudRunAwsService(settingsService, {
  appVersion: app.getVersion(),
  // Unknown while the link is still connecting after this desktop started.
  machineConnected: (machineId) => machineLinkService && machineLinkStartedAt !== undefined
    && Date.now() - machineLinkStartedAt >= DESKTOP_LINK_STARTUP_GRACE_MS
    ? machineLinkService.isMachineConnected(machineId) : undefined,
  machineRecoveryFailure: (machineId) => machineRecovery?.failure(machineId),
  // The box is no longer asked over SSH whether a turn is running on it: the
  // machine on it reports its own work over the link, and an idle stop waits
  // while any of it is in flight.
  automaticStopGate: {
    authorizeAutomaticWorkerStop: async (worker) => machineLinkService?.hasActiveMachineWork()
      ? { allowed: false, reason: "A machine is still working." }
      : machineLinkService?.machineKeepsAwake(awsInstanceOfWorker(worker))
        ? { allowed: false, reason: "A machine runs switched-on scheduled scripts." }
        : { allowed: true, lease: { leaseId: "machine-idle", expiresAt: new Date(Date.now() + 30_000).toISOString() } },
    renewAutomaticWorkerStopLease: async (worker, lease) => machineLinkService?.hasActiveMachineWork() || machineLinkService?.machineKeepsAwake(awsInstanceOfWorker(worker))
      ? Promise.reject(new Error("A machine started working; the automatic stop is abandoned."))
      : { ...lease, expiresAt: new Date(Date.now() + 30_000).toISOString() },
    releaseAutomaticWorkerStopLease: async () => undefined
  },
  // An instance deleted in Settings → AWS, or one AWS terminated or no longer
  // has, takes its machines along exactly as Settings → Remove removes one.
  removeMachine: async (machineId) => { await removeMachine(machineId); },
  machinesReady: () => machineLinkReady,
  logger: (event, payload) => {
    void debugLogService.write(event, payload);
  }
});
const awsWorkerSetupService = new AwsWorkerSetupService(cloudRunAwsService, cloudRunDoctorService, settingsService, {
  // This desktop's program on that instance; another desktop's does not count.
  installed: (instanceId) => cloudRunAwsService.programInstalledOn(instanceId),
  // The same setup choosing Cloud run does, as one step of setting AWS up.
  install: async (progress) => {
    await cloudRunPreparation.prepareRuntime({ progress });
    evaluateMachineUpdates?.();
    // Installed is installed: a list that cannot be sent now is sent later.
    void machineListResult().then((result) => sendToMainWindow("machines:updated", result)).catch(() => undefined);
  },
  ready: async () => { if (!await settingsService.getHubConfig()) throw new Error(SET_UP_SERVER_FOR_MACHINES); }
});
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
/** Questions about machines that stopped being used, waiting for the User. */
const machineInactivityQuestions = new MachineInactivityQuestions((questions) => sendToMainWindow("machines:inactivity-questions", questions));

/** Removes a machine from this desktop: Settings > Remove, and the answer
 *  "no longer in use" to the inactive-machine question. The cloud instance
 *  itself is not deleted. */
async function removeMachine(id: string): Promise<MachineListResult> {
  const record = (await settingsService.listMachines()).find((machine) => machine.id === id);
  await machineLinkService?.disconnectMachine(id);
  try {
    // Every device that was handed this machine's power key loses the handoff
    // with the machine; the key itself still needs rotating, and the outcome
    // is written to the debug log rather than lost.
    for (const outcome of await machinePowerHandoffService.revokeForMachine(id, "machine-removed")) {
      void debugLogService.write("machine.power.handoff.revoked", {
        handoffId: outcome.handoffId, keyRotationRequired: outcome.keyRotationRequired, detail: outcome.detail
      });
    }
    await settingsService.removeMachine(id);
    // However it was removed (Settings, AWS, the relay's cleanup), a question
    // about it is settled with it.
    machineInactivityQuestions.settle(id, "remove");
  } catch (error) {
    // Not removed: it stays a machine of this desktop, connected again, and
    // nothing kept for it is dropped.
    if (record) await machineLinkService?.connectMachine(record).catch(() => undefined);
    throw error;
  }
  await machineLinkService?.forgetMachine(id);
  // The User's server drops it from its roster: it reads and writes nothing more.
  publishHubRoster();
  const result = await machineListResult();
  sendToMainWindow("machines:updated", result);
  return result;
}

/** What the shared relay set up is taken off this desktop (see
 *  relayRemoval.ts); the other machines' rosters follow. */
async function removeRelayEra(): Promise<void> {
  const recorded = await removeRelayEraRecords({
    settings: settingsService,
    removeMachine: (machineId) => removeMachine(machineId).catch((error: unknown) => {
      void debugLogService.write("relay.remove-machine-error", { machineId, message: error instanceof Error ? error.message : String(error) });
      throw error;
    }),
    handoffs: machinePowerHandoffService,
    log: (event, payload) => { void debugLogService.write(event, payload); }
  });
  if (!recorded) return;
  void debugLogService.write("relay.removed", { machines: recorded.machines.length, phones: recorded.phones.length, startKeyHanded: recorded.startKeyHanded });
  publishHubRoster();
}

/** A machine's enrollment with the User's own server: its room there, nothing
 *  else (its chats it reads from the server like every device). */
function createHubMachinePairing(hubUrl: string): Promise<CreateMobilePairingResult> {
  return mobilePairingService.createPairing({ purpose: "machine-host", ttlMinutes: MACHINE_ENROLLMENT_TTL_MINUTES, hubUrl });
}

async function createMachine(request: CreateMachineRequest, awsInstanceId?: string): Promise<CreateMachineResult> {
  const name = typeof request?.name === "string" ? request.name.trim() : "";
  if (!name) {
    throw new Error("A machine needs a name.");
  }
  // A machine talks only to the User's own server: it meets this desktop in
  // its room there and reads and writes its chats there. Without a server
  // there are no machines.
  const hub = await settingsService.getHubConfig();
  if (!hub) throw new Error(SET_UP_SERVER_FOR_MACHINES);
  const pairing = await createHubMachinePairing(hub.url);
  const record = {
    id: randomUUID(),
    name,
    ...(awsInstanceId ? { awsInstanceId } : {}),
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
}

/** What Settings says where a machine would start without the User's server. */
const SET_UP_SERVER_FOR_MACHINES = "Set up your server first (Settings → Your server): cloud machines connect through it.";

const machineProfileSync = new DefaultRemoteAgentSetupSync();
const prepareMachineProfile = async (record: MachineInstallRecord): Promise<void> => {
  await machineProfileSync.sync({
    worker: { ...record.target, workerRoot: record.installRoot, profileHome: record.profileHome },
    sourceEnvironment: { ...commandEnvironment(), ...(await settingsService.getManualAgentEnvironment()).env }
  });
};
const machineInstallerService: MachineInstallerService = new MachineInstallerService({
  store: settingsService,
  doctor: cloudRunDoctorService,
  getEnrollmentJson: (machineId) => requireMachineLink().enrollmentJson(machineId),
  restoreEnrollment: (machineId, requested, installed, installedMachineId) => requireMachineLink().restoreEnrollment(machineId, requested, installed, installedMachineId),
  waitForConnected: (machineId, timeoutMs, expectAppVersion) =>
    requireMachineLink().waitForConnected(machineId, timeoutMs, expectAppVersion),
  payload: machineRuntimePayload,
  machineName: async (machineId) => (await settingsService.listMachines()).find((machine) => machine.id === machineId)?.name,
  prepareProfile: prepareMachineProfile,
  // The runtime it installs says its key: the User's server admits it from
  // then on (the roster names it), before it first connects.
  adoptIdentity: (machineId, identity) => requireMachineLink().adoptMachineIdentity(machineId, identity),
  identityKnown: async (machineId) => {
    const machine = (await settingsService.listMachines()).find((item) => item.id === machineId);
    return Boolean(machine?.deviceId && machineSigningKey(machine));
  },
  // Minutes pass between the preflight and the drain; a member may have
  // started on the machine meanwhile. Asked afresh, and a stale answer is not
  // taken as idle.
  // Only for the automatic update: the button is the recovery path and must
  // still be able to replace a runtime that no longer answers.
  beforeDrain: async (record, operationId, purpose) => {
    // Set up again because the machine said its program was not running: if
    // it came back meanwhile, it may be running turns again.
    if (isMachineRecoveryOperation(operationId)) {
      return machineLinkService?.isMachineConnected(record.machineId)
        ? "The machine's program came back while it was being set up again, so it was not stopped."
        : undefined;
    }
    // The Update button may replace a runtime that does not answer; a healthy
    // one is never stopped mid-turn only to hand it a stop key.
    if (!isMachineAutoUpgradeOperation(operationId) && purpose !== "key") return undefined;
    const activity = await machineLinkService?.machineActivity(record.machineId);
    if (!activity?.connected) return "The machine is not connected right now, so its runtime was not stopped.";
    if (!activity.fresh) return "The machine did not say what it is doing in time, so its runtime was not stopped.";
    if (activity.activeRunIds.length > 0) {
      return "A member started work on the machine while the update was being staged, so its runtime was not stopped.";
    }
    return undefined;
  },
  // A machine on this app's AWS instance gets the stop key the setup command
  // minted, so it stops the instance itself after three idle hours.
  machinePower: (machineId) => cloudRunAwsService.machinePowerFor(machineId),
  logger: (event, payload) => {
    void debugLogService.write(event, payload);
  }
});
/** Re-checks machines for a runtime update or a stop key to hand over; set
 *  once the machine link is up. */
let evaluateMachineUpdates: (() => void) | undefined;
/** The User asked Settings to try the machine's update or stop key again. */
let retryMachineUpdate: ((machineId: string) => Promise<void>) | undefined;
/** Brings the program on the cloud machine back by itself. */
let machineRecovery: MachineRecoveryService | undefined;
const cloudRunPreparation = new CloudRunPreparationService({
  onProgress: snapshot => sendToMainWindow("machines:cloud-run-progress", snapshot),
  configuredInstanceId: async () => (await settingsService.getPublicSettings()).cloudRuns.awsHandle?.instanceId,
  appVersion: app.getVersion(),
  environmentId: async () => (await deviceIdentityService.getOrCreateDeviceIdentity()).originId,
  aws: cloudRunAwsService,
  listMachines: () => settingsService.listMachines(),
  listInstalls: () => settingsService.listMachineInstalls(),
  createMachine: async (name, instanceId) => (await createMachine({ name }, instanceId)).machine,
  requireServer: async () => {
    if (!await settingsService.getHubConfig()) throw new Error(SET_UP_SERVER_FOR_MACHINES);
  },
  install: (request, progress) => machineInstallerService.install(request, progress),
  awaitActiveInstall: async (machineId) => { await machineInstallerService.activeOperation(machineId)?.catch(() => undefined); },
  isConnected: (machineId) => Boolean(machineLinkService?.isMachineConnected(machineId)),
  bootstrapProject: (machineId, localPath, signal, progress) => machineInstallerService.bootstrapProjectMirror({ machineId, localPath }, signal, progress),
  saveInstall: (record) => settingsService.saveMachineInstall(record),
  prepareMachine: async (worker, record) => {
    if (!worker.host) throw new Error("AWS did not return an address for this instance.");
    const current = { ...record, target: { ...worker, host: worker.host } };
    await machineInstallerService.ensureEnvironmentOwner(current);
    await prepareMachineProfile(current);
  },
  prepareProvider: async (worker, provider, record, progress) => {
    if (!worker.host) throw new Error("AWS did not return an address for this instance.");
    const scopedWorker = { ...worker, workerRoot: record.installRoot };
    const options = { requiredProviderKind: provider, profileHome: record.profileHome, maintenance: {
      runtimePath: `${record.installRoot}/current/accordagents-machine.cjs`,
      userDataDir: record.userDataDir,
      capabilityPath: `${record.installRoot}/current/maintenance-v1`
    } };
    progress({ message: "Checking the provider on your cloud machine…" });
    let report = await cloudRunDoctorService.diagnose(scopedWorker, options);
    if (!report.ok) report = await cloudRunDoctorService.setup(scopedWorker, progress, options);
    if (!report.ok) throw new Error(report.message);
  }
});
void machineInstallerService.recoverInterruptedOperation();
// Phones paired through the shared relay were handed the key that starts the
// AWS machine. Nothing hands it out any more (a phone talks only to the
// User's server); the records say who kept a copy, and a removed machine
// settles them.
const machinePowerHandoffService = new MachinePowerHandoffService({
  getDeviceStartKey: async () => (await cloudRunAwsService.deviceWakePower())?.config,
  listMachinePowerHandoffs: () => settingsService.listMachinePowerHandoffs(),
  saveMachinePowerHandoffs: (records) => settingsService.saveMachinePowerHandoffs(records)
});

chatService.setCloudRunPreparation(async (selection, provider, progress) => {
  if (provider !== "codex-cli" && provider !== "claude-code") throw new Error("This provider does not support Cloud run.");
  const result = await cloudRunPreparation.prepare({ operationId: randomUUID(), provider, instanceId: selection.instanceId }, progress);
  return result.machine.id;
});
chatService.setCloudRunAwsService(cloudRunAwsService);
chatService.setPromptSuggestionsListener((update) => sendToMainWindow("chat:prompt-suggestions", update));
chatService.onBackgroundTasksChanged((event) => sendToMainWindow("chat:background-tasks", event));
chatService.setMachineProjectPreparation((machineId, localPath, signal, progress) => cloudRunPreparation.prepareProject(machineId, localPath, signal, progress));
chatService.setCloudRunDoctorService(cloudRunDoctorService);
wireChatAppToolHandlers(appMcpService, chatService);
// Scheduled scripts hosted by this desktop. Files, history and run state live
// under userData/scripts; key values in their own encrypted file, never in
// settings.json, so no settings export or machine sync can carry them.
let scriptsUpdatedTimer: ReturnType<typeof setTimeout> | undefined;
const scriptService: ScriptService = new ScriptService({
  store: new ScriptStore(path.join(app.getPath("userData"), "scripts")),
  secrets: new ScriptSecretStore(path.join(app.getPath("userData"), "script-secrets.json"), hostPlatform().secrets),
  hostId: SCRIPT_DESKTOP_HOST_ID,
  hostLabel: process.platform === "darwin" ? "This Mac" : "This computer",
  hostPhrase: process.platform === "darwin" ? "this Mac" : "this computer",
  tokens: appMcpService,
  chat: {
    describeChat: (chatId) => chatService.describeChatForScripts(chatId),
    postScriptMessage: (input) => chatService.postScriptMessage({ ...input, progress: (progress) => emitReviewProgress(progress) })
  },
  node: { command: "node", env: {} },
  debugLog: (event, payload) => {
    void debugLogService.write(event, payload);
  },
  onChanged: () => broadcastScripts([])
});
// Every script the desktop can show: its own and those on its machines.
const scriptHub = new ScriptHub(scriptService, () => machineLinkService);
/** Machines to ask afresh in the next broadcast; undefined means all. */
let scriptsRefresh: Set<string> | undefined = new Set();
/** Lists can take seconds; one that finishes after a newer one is dropped. */
let scriptsBroadcastSeq = 0;
/** Tells the window the scripts changed. Only the machines that said so are
 *  asked again; the rest are shown from their last answer. */
function broadcastScripts(refresh?: string[]): void {
  if (!refresh) scriptsRefresh = undefined;
  else for (const machineId of refresh) scriptsRefresh?.add(machineId);
  if (scriptsUpdatedTimer) return;
  scriptsUpdatedTimer = setTimeout(() => {
    scriptsUpdatedTimer = undefined;
    const machines = scriptsRefresh ? [...scriptsRefresh] : undefined;
    scriptsRefresh = new Set();
    const seq = ++scriptsBroadcastSeq;
    void scriptHub.list(machines)
      .then((scripts) => { if (seq === scriptsBroadcastSeq) sendToMainWindow("scripts:updated", { scripts }); })
      .catch(() => undefined);
  }, 150);
}
chatService.setScriptHost(scriptService);
appMcpService.setScriptApiHandler((context, _route, body) => scriptService.postFromScript(context, body));
// A deleted chat reaches every other device through the User's server (its
// deletion is an operation there, which every device applies).
chatService.setConversationDeletedHandler(async (conversation) => {
  sendToMainWindow("conversations:deleted", conversation.id);
});
const avatarStudioService = new AvatarStudioService({
  cliRunner: cliAgentRunner,
  workRoot: path.join(app.getPath("userData"), "avatar-studio"),
  promptRoot: path.join(__dirname, "prompts"),
  debugLogs: debugLogService
});

// Scratch pictures never outlive the app: sweep whatever an earlier session left
// behind, and cancel live draws on quit.
void avatarStudioService.shutdown();
app.on("before-quit", () => {
  void avatarStudioService.shutdown();
});

const dispatchArtifactTool = createArtifactToolDispatcher(artifactService);
wireArtifactToolHandler(appMcpService, chatService, dispatchArtifactTool);

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

/** What applies the User's answers to this desktop's members' cards, from
 *  the User's server (agreement Д9): each answer once, whichever device gave
 *  it. A script that installs code is approved only by this desktop's own
 *  answer (its card shows the code); a phone's approval of one is refused. */
let cardAppliers: Promise<ChatCardAppliers> | undefined;
function localCardAppliers(): Promise<ChatCardAppliers> {
  const pending = cardAppliers ??= (async () => {
    const device = await deviceIdentityService.getOrCreateDeviceIdentity();
    const nativeProcessDbPath = path.join(app.getPath("userData"), "native-processes.sqlite3");
    return {
      approval: new MachineApprovalExecutor({
        storage: storageService, chat: chatService,
        progress: (progress) => emitReviewProgress(progress),
        runtimeIdentity: () => localRuntimeIdentity(), nativeProcessDbPath,
        codeApprover: () => device.originId
      }),
      choice: new MachineChoiceExecutor({ storage: storageService, chat: chatService,
        progress: (progress) => emitReviewProgress(progress), runtimeIdentity: () => localRuntimeIdentity(), nativeProcessDbPath }),
      mention: new MachineMentionExecutor({ storage: storageService, chat: chatService,
        progress: (progress) => emitReviewProgress(progress), runtimeIdentity: () => localRuntimeIdentity() })
    };
  })();
  void pending.catch(() => { if (cardAppliers === pending) cardAppliers = undefined; });
  return pending;
}
chatService.setCardAppliers(() => localCardAppliers());

const activeReviews = new Map<string, AbortController>();
const activeChatCreations = new Set<AbortController>();
app.on("before-quit", () => {
  for (const controller of activeChatCreations) controller.abort();
});

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

/** The window an update question is asked on: the main one, or any other
 *  still open. */
function updatePromptWindow(): BrowserWindow | undefined {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  return BrowserWindow.getAllWindows().find((window) => !window.isDestroyed() && !isServerUpdateLoaderWindow(window));
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
      // Centred in the renderer's 46px title rows (--app-header-height); rows
      // leave --app-traffic-light-inset (80px) clear for the lights.
      trafficLightPosition: { x: 16, y: 17 }
    } : {}),
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      additionalArguments: crashReportingActive() ? [CRASH_REPORTS_ACTIVE_ARG] : [],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow = window;
  // A restart for an update waits for every window to close; these say which
  // window closed, which did not, and why a renderer could not answer.
  const windowId = window.id;
  void debugLogService.write("app-window.created", { windowId, windows: BrowserWindow.getAllWindows().length });
  window.on("close", () => {
    debugLogService.writeNow("app-window.close", { windowId, forUpdate: quittingForUpdate, quitting: quitCleanupStarted });
    if (mainWindow === window) {
      mainWindow = undefined;
    }
  });
  window.on("closed", () => {
    debugLogService.writeNow("app-window.closed", { windowId, windows: BrowserWindow.getAllWindows().length });
  });
  window.on("unresponsive", () => {
    void debugLogService.write("app-window.unresponsive", { windowId });
  });
  window.on("responsive", () => {
    void debugLogService.write("app-window.responsive", { windowId });
  });
  window.webContents.on("will-prevent-unload", () => {
    debugLogService.writeNow("app-window.unload-prevented", { windowId });
  });
  window.webContents.on("destroyed", () => {
    if (mainWindow === window) {
      mainWindow = undefined;
    }
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    void debugLogService.write("app-window.renderer-gone", { windowId, reason: details.reason, exitCode: details.exitCode });
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
  action: (worker: CloudRunWorkerSettings) => Promise<T>,
  intent: "inspect" | "setup"
): Promise<T> {
  if (request) {
    return action(request);
  }
  const settings = await settingsService.getPublicSettings();
  if (settings.cloudRuns.mode !== "aws") {
    return action(settings.cloudRuns.worker);
  }
  if (intent === "inspect") {
    return action(await cloudRunAwsService.workerForInspection());
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
  const identity = await deviceIdentityService.getOrCreateDeviceIdentity();
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

/** What the cloud machine itself says about this deployment, asked over
 *  SSH: what its program last reported may be stale. This device's SSH
 *  access is renewed first, as its address may have changed since; a stopped
 *  instance is never started for it. */
async function inspectCloudMachine(record: MachineInstallRecord): Promise<{ programRunning: boolean; agentsRunning: boolean }> {
  const instanceId = (await settingsService.getPublicSettings()).cloudRuns.awsHandle?.instanceId;
  if (!instanceId) throw new Error("No AWS instance is set up in Settings.");
  const worker = await cloudRunAwsService.ensureExistingWorkerForRun(instanceId, { start: false });
  if (!worker.host) throw new Error("AWS did not return an address for the instance.");
  const probe = await machineInstallerService.probe(
    { host: worker.host, user: worker.user, port: worker.port, identityFile: worker.identityFile, hostKeyAlias: worker.hostKeyAlias },
    { installRoot: record.installRoot, userDataDir: record.userDataDir, serviceName: record.serviceName });
  // A program its unit keeps restarting is not running: it never stays up
  // long enough to connect, and only a new setup can help it.
  const settled = (probe.serviceAgeSeconds ?? Number.POSITIVE_INFINITY) >= 60;
  return { programRunning: probe.serviceState === "active" && probe.runtimePids.length > 0 && settled, agentsRunning: probe.providerPids.length > 0 };
}

async function machineListResult(): Promise<MachineListResult> {
  return {
    machines: await settingsService.listMachines(),
    status: machineLinkService?.status() ?? []
  };
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** How long a phone pairing code may wait to be scanned. */
const PHONE_INVITE_TTL_MS = 10 * 60_000;

/**
 * A one-time code for a phone: the desktop signs an invite with its own key,
 * registers it with the User's server, and shows the address of the server,
 * the token and the server's id as a QR code. The phone pairs with the server
 * itself, so the desktop may be closed by then.
 */
async function createPhoneInvite(request: import("../shared/types").CreatePhoneInviteRequest): Promise<import("../shared/types").CreatePhoneInviteResult> {
  const hub = await settingsService.getHubConfig().catch(() => undefined);
  if (!hub || !hubClient) throw new Error("Set up your server first (Your server, above): the phone connects through it.");
  const health = await hubClient.health();
  if (!Number.isSafeInteger(health.protocol) || health.protocol < HUB_PHONE_PROTOCOL_VERSION) {
    throw new Error("Your server runs an older program. Update it from Settings → Your server, then pair the phone.");
  }
  if (!hubOwnerConfirmed) throw new Error("Your server has not confirmed this computer yet. Try again in a moment.");
  const identity = await deviceIdentityService.getOrCreateDeviceIdentity();
  const token = randomBytes(32).toString("base64url");
  const issuedAt = new Date();
  const invite: HubPhoneInvite = {
    version: 1,
    inviteId: `invite-${randomUUID()}`,
    hubId: health.hubId,
    issuerDeviceId: identity.originId,
    tokenHash: sha256Hex(token),
    // A phone reads and writes every chat, as the desktop does: the server's
    // order carries no per-chat fences, so a one-chat phone is not offered.
    scope: { scope: "device" },
    name: "Phone",
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + PHONE_INVITE_TTL_MS).toISOString()
  };
  await hubClient.putPhoneInvite(invite, signHubText(identity, hubPhoneInviteSigningText(invite)));
  await settingsService.savePhoneInvite({ inviteId: invite.inviteId, issuedAt: invite.issuedAt, expiresAt: invite.expiresAt });
  const settings = await settingsService.getPublicSettings();
  const origin = request.staticOriginUrl?.trim() || settings.mobileControl.defaults.staticOriginUrl;
  if (!origin) throw new Error("The phone app's address is not set.");
  const pwaUrl = new URL(origin);
  pwaUrl.searchParams.set("pair", "server");
  // All three only in the fragment: the phone's app site never sees them.
  pwaUrl.hash = new URLSearchParams({ hub: hub.url, t: token, id: health.hubId }).toString();
  void debugLogService.write("hub.phone.invite-created", { inviteId: invite.inviteId, scope: invite.scope.scope });
  // The phone pairs with the server, not here: its roster is read often
  // while the code waits to be used, so the phone is named here soon after.
  scheduleEnrolledPhones(HUB_PHONE_ROSTER_PAIRING_MS);
  return { inviteId: invite.inviteId, expiresAt: invite.expiresAt, pwaUrl: pwaUrl.toString(), qrPayload: pwaUrl.toString() };
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
  ipcMain.handle("settings:set-crash-reports", async (_event, enabled: unknown) => {
    // Off stops first, so a failed write cannot leave reports running.
    if (enabled === false) {
      await stopCrashReporting(app.getPath("userData"));
      void debugLogService.write("crash-reports.stopped", {});
    }
    return settingsService.setCrashReports(enabled !== false);
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
    try { return await withCloudRunWorker(request, testCloudRunWorker, "inspect"); }
    catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) }; }
  });
  ipcMain.handle("cloud-runs:diagnose-worker", async (_event, request?: CloudRunWorkerSettings): Promise<CloudRunWorkerDoctorReport> => {
    try {
      const settings = await settingsService.getPublicSettings();
      const managedAws = !request && settings.cloudRuns.mode === "aws";
      // A provider the User has not signed in yet is offered, not an error:
      // only its members cannot run in the cloud until then.
      return await withCloudRunWorker(request, (worker) => cloudRunDoctorService.diagnose(worker, {
        requirePersistentStorage: managedAws,
        requiredProviderKinds: enabledCloudProviders(settings.providers),
        signIn: "optional"
      }), "inspect");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, message, checks: [] };
    }
  });
  ipcMain.handle("cloud-runs:setup-worker", (_event, request?: CloudRunWorkerSettings, options?: { signIn?: "codex-cli" | "claude-code" | "none" }) =>
    cloudRunSetupSession.run(request, async publish => {
      const settings = await settingsService.getPublicSettings();
      const managedAws = !request && settings.cloudRuns.mode === "aws";
      // Sign in… on one provider signs in that one; Install or Fix signs in
      // nobody; the others stay as they are.
      const signIn = options?.signIn === "codex-cli" || options?.signIn === "claude-code" ? options.signIn : undefined;
      return withCloudRunWorker(request, worker => cloudRunDoctorService.setup(worker, publish, {
        requirePersistentStorage: managedAws,
        requiredProviderKinds: enabledCloudProviders(settings.providers),
        ...(signIn ? { signIn: "optional" as const, offerSignIn: [signIn] }
          : options?.signIn === "none" ? { signIn: "optional" as const, offerSignIn: [] } : {})
      }), "setup");
    }, progress => sendToMainWindow("cloud-runs:setup-progress", progress)));
  ipcMain.handle("cloud-runs:get-setup-progress", () => cloudRunSetupSession.getProgress());
  ipcMain.handle("cloud-runs:submit-auth-code", (_event, request: { requestId: string; code: string }) =>
    cloudRunDoctorService.submitAuthCode(request?.requestId, request?.code));
  ipcMain.handle("cloud-runs:cancel-auth", (_event, requestId: string) => cloudRunDoctorService.cancelAuth(requestId));
  ipcMain.handle("cloud-runs:is-auth-active", (_event, requestId: string) => cloudRunDoctorService.isAuthActive(requestId));
  ipcMain.handle("cloud-runs:aws-bootstrap-command", (_event, region: string, recoveryOperationId?: string) =>
    cloudRunAwsService.bootstrapCommand(String(region ?? "").trim() || "us-east-1", recoveryOperationId));
  ipcMain.handle("cloud-runs:aws-connect", (_event, request: ConnectAwsWorkerRequest) =>
    cloudRunAwsService.connectWorker(request.blob, request.instanceType, request.rootVolumeSizeGb));
  ipcMain.handle("cloud-runs:aws-start", async (event, request: AwsWorkerStartRequest) => {
    const result = await awsWorkerSetupService.start(request, (progress) => {
      if (!event.sender.isDestroyed()) event.sender.send("cloud-runs:aws-progress", progress);
    });
    // A pasted setup result may carry a new stop key for the machine.
    if (request.blob?.trim()) evaluateMachineUpdates?.();
    return result;
  });
  ipcMain.handle("cloud-runs:aws-status", () => cloudRunAwsService.status());
  ipcMain.handle("cloud-runs:aws-auto-stop", async (_event, request: SetAwsAutoStopRequest) => {
    const { keyAdded } = await cloudRunAwsService.setAutoStop(request);
    const enabled = request?.enabled === true;
    void debugLogService.write("machines.auto-stop.switched", { enabled, newKey: keyAdded });
    // The machine decides when to stop; tell a connected one now, without
    // making the switch wait behind replication. One that is offline gets the
    // switch with the settings it receives on connecting.
    // Then ask the machine to report in: its answer confirms what it has, or
    // shows in the Automatic stop row that the change did not arrive.
    void (async () => {
      await machineLinkService?.syncSettings();
      // A moment later, so the answer follows the settings it was sent.
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      const holder = await cloudRunAwsService.autoStopMachineRecord();
      if (holder) await machineLinkService?.machineActivity(holder.machineId, { fresh: true });
    })().catch((error) => {
      void debugLogService.write("machines.auto-stop.sync-failed", { message: error instanceof Error ? error.message : String(error) });
    });
    // A new key goes over to the machine the next time it is idle.
    if (keyAdded) evaluateMachineUpdates?.();
    return cloudRunAwsService.status();
  });
  ipcMain.handle("cloud-runs:aws-reconnect-machine", async (_event, machineId?: string) => {
    const record = typeof machineId === "string" && machineId
      ? await cloudRunAwsService.machineRecordOnInstance(machineId)
      : await cloudRunAwsService.autoStopMachineRecord();
    if (machineLinkStartedAt === undefined || Date.now() - machineLinkStartedAt < DESKTOP_LINK_STARTUP_GRACE_MS) {
      throw new Error("Still connecting to the cloud machine. Try again in a minute.");
    }
    if (record?.lastOperation && !isMachineInstallTerminalPhase(record.lastOperation.phase)) {
      throw new Error("The cloud machine is being set up right now. Try again when that finishes.");
    }
    if (record && machineLinkService?.isMachineConnected(record.machineId)) {
      // A connected program is never drained by this button: the key goes
      // over the way automatic updates hand it over, once the machine is idle
      // and with new turns held.
      if (record.powerRetry) await settingsService.saveMachineInstall({ ...record, powerRetry: undefined });
      await retryMachineUpdate?.(record.machineId);
      void debugLogService.write("machines.auto-stop.retry", { machineId: record.machineId });
    } else {
      // Not connected: set its program up again, as choosing Cloud run does.
      // What it reported last may be stale, so the machine itself is asked
      // whether agents are running before anything is stopped.
      if (record?.installRoot && (await inspectCloudMachine(record)).agentsRunning) {
        throw new Error("Agents are still running on the cloud machine. Try again when they finish.");
      }
      const release = record ? machineLinkService?.holdTurns(record.machineId, "The cloud machine's program is being set up again.") : undefined;
      try {
        await cloudRunPreparation.prepareRuntime({ agentsChecked: Boolean(record?.installRoot), machineId: record?.machineId });
      } finally {
        release?.();
      }
      evaluateMachineUpdates?.();
      void debugLogService.write("machines.auto-stop.reconnected", { machineId: record?.machineId ?? "" });
    }
    sendToMainWindow("machines:updated", await machineListResult());
    return cloudRunAwsService.status();
  });
  const awsInstanceDisk = new AwsInstanceDiskService({
    worker: () => cloudRunAwsService.workerForInspection(),
    // A desktop set up before per-desktop folders keeps its recorded ones.
    program: async () => {
      const folder = cloudEnvironmentDirectory((await deviceIdentityService.getOrCreateDeviceIdentity()).originId);
      const recorded = await cloudRunAwsService.programFoldersOnInstance();
      const root = recorded?.installRoot ?? `~/${folder}`;
      const name = root.replace(/\/+$/, "").split("/").pop() ?? folder;
      return { root, data: recorded?.userDataDir ?? `~/.accordagents/${name === "accordagents-machine" ? "machine" : name}` };
    },
    log: (event, data) => { void debugLogService.write(event, data); }
  });
  ipcMain.handle("cloud-runs:aws-disk", (_event, options?: { refresh?: boolean }) => awsInstanceDisk.report(options));
  ipcMain.handle("cloud-runs:aws-disk-clean", (_event, category: AwsDiskCleanCategory) => awsInstanceDisk.clean(category));
  ipcMain.handle("cloud-runs:aws-disk-list", (_event, path?: string) => awsInstanceDisk.list(path));
  ipcMain.handle("cloud-runs:aws-disk-delete", (_event, paths: string[]) => awsInstanceDisk.remove(paths));
  ipcMain.handle("cloud-runs:aws-stop", () => cloudRunAwsService.stopWorker());
  ipcMain.handle("cloud-runs:aws-delete", () => cloudRunAwsService.deleteWorker());
  ipcMain.handle("settings:get-agent-environment", () => agentEnvironmentService.snapshot());
  ipcMain.handle("settings:save-agent-environment-variable", async (_event, request: SaveAgentEnvironmentVariableRequest) => {
    await settingsService.saveAgentEnvironmentVariable(request);
    await cliAgentRunner.shutdownWarmAgents();
    cliAgentRunner.invalidateAgentReadiness();
    return agentEnvironmentService.snapshot();
  });
  ipcMain.handle("settings:save-cli-provider-host", async (_event, update: CliProviderHostUpdate) => {
    const settings = await settingsService.saveCliProviderHost(update);
    const saved = update.id?.trim() ? settings.cliProviderHosts.find((host) => host.id === update.id?.trim()) : undefined;
    if (saved) {
      await chatService.syncCliProviderHost(saved);
    }
    return settings;
  });
  ipcMain.handle("settings:delete-cli-provider-host", async (_event, id: string) => {
    const settings = await settingsService.deleteCliProviderHost(id);
    await chatService.retireCliProviderHost(id);
    return settings;
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
  ipcMain.handle("avatar-studio:run-turn", (_event, request: AvatarStudioTurnRequest) => avatarStudioService.runTurn(request));
  ipcMain.handle("avatar-studio:cancel", (_event, studioId: string) => avatarStudioService.cancel(studioId));
  ipcMain.handle("avatar-studio:close", (_event, studioId: string) => avatarStudioService.closeStudio(studioId));
  ipcMain.handle("settings:save-custom-avatar", (_event, request: SaveCustomAvatarRequest) => settingsService.saveCustomAvatar(request));
  ipcMain.handle("settings:read-custom-avatar", (_event, id: string) => settingsService.readCustomAvatar(id));
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
  ipcMain.handle("chat:create", async (event, request: CreateChatConversationRequest) => {
    const runId = request.runId ?? randomUUID();
    if (activeReviews.has(runId)) throw new Error("This chat action is already running.");
    const controller = new AbortController();
    activeReviews.set(runId, controller);
    activeChatCreations.add(controller);
    const cancelCreation = (): void => controller.abort();
    event.sender.once("destroyed", cancelCreation);
    try {
      const created = await chatService.createConversation({ ...request, runId }, controller.signal, emitReviewProgress);
      // A new project, or a member used once more: the phone's New chat
      // offers what this one does.
      hubPhonePublisher.scheduleCatalog();
      return created;
    } catch (error) {
      if (controller.signal.aborted) throw new Error("Chat creation cancelled.");
      throw error;
    } finally {
      event.sender.removeListener("destroyed", cancelCreation);
      activeChatCreations.delete(controller);
      activeReviews.delete(runId);
    }
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
  ipcMain.handle("chat:get-prompt-suggestions", (_event, conversationId: unknown) =>
    typeof conversationId === "string" ? chatService.listPromptSuggestions(conversationId) : []);
  ipcMain.handle("chat:get-background-tasks", (_event, conversationId: unknown) =>
    typeof conversationId === "string" ? chatService.backgroundTasksForConversation(conversationId) : {});
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
  ipcMain.handle("scripts:list", () => scriptHub.list());
  ipcMain.handle("scripts:get-revision", (_event, request: GetScriptRevisionRequest) =>
    scriptHub.revision(request.hostId, request.scriptId, request.revisionId));
  ipcMain.handle("scripts:runs", (_event, request: ScriptIdRequest) => scriptHub.runs(request.hostId, request.scriptId));
  ipcMain.handle("scripts:set-secret", (_event, request: SetScriptSecretRequest) =>
    scriptHub.setSecret(request.hostId, request.scriptId, request.name, request.value));
  ipcMain.handle("scripts:delete-secret", (_event, request: DeleteScriptSecretRequest) =>
    scriptHub.deleteSecret(request.hostId, request.scriptId, request.name));
  ipcMain.handle("scripts:set-enabled", (_event, request: SetScriptEnabledRequest) =>
    scriptHub.setEnabled(request.hostId, request.scriptId, request.enabled));
  ipcMain.handle("scripts:run-now", (_event, request: ScriptIdRequest) => scriptHub.control(request.hostId, "runNow", request.scriptId));
  ipcMain.handle("scripts:delete", (_event, request: ScriptIdRequest) => scriptHub.control(request.hostId, "delete", request.scriptId));
  ipcMain.handle("scripts:release-held", (_event, request: ScriptIdRequest) => scriptHub.control(request.hostId, "releaseHeld", request.scriptId));
  ipcMain.handle("scripts:discard-held", (_event, request: ScriptIdRequest) => scriptHub.control(request.hostId, "discardHeld", request.scriptId));
  ipcMain.handle("chat:read-attachment", async (_event, request: ReadChatAttachmentRequest) => {
    return chatService.readChatAttachment(request);
  });
  ipcMain.handle("chat:toggle-reaction", async (_event, request: ToggleChatReactionRequest) => {
    return chatService.toggleReaction(request);
  });
  // Answers to cards a member waits on go to the User's server (agreement
  // Д9): the device the member runs on applies them, once, whichever device
  // answered first; this returns once the server took the answer.
  ipcMain.handle("chat:respond-to-mentions", async (_event, request: RespondToChatMentionsRequest) => {
    const runId = request.runId ?? randomUUID();
    const controller = new AbortController();
    activeReviews.set(runId, controller);
    try {
      return await chatService.answerMentionsCard({ ...request, runId }, controller.signal, (progress) => emitReviewProgress(progress));
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
    await chatService.answerChoiceCard(request);
    return { conversation: await storageService.getConversation(request.conversationId), warnings: [] };
  });
  ipcMain.handle("chat:respond-to-app-tool-approval", async (_event, request: RespondToChatAppToolApprovalRequest) => {
    await chatService.answerAppToolApprovalCard(request);
    return storageService.getConversation(request.conversationId);
  });
  ipcMain.handle("machines:list", async (): Promise<MachineListResult> => machineListResult());
  ipcMain.handle("machines:prepare-cloud-run", async (_event, request: import("../shared/cloudRunPreparation").PrepareCloudRunRequest) => {
    return cloudRunPreparation.prepare(request, () => {});
  });
  ipcMain.handle("machines:get-cloud-run-preparation", (_event, request: import("../shared/cloudRunPreparation").PrepareCloudRunRequest) => cloudRunPreparation.snapshot(request));
  ipcMain.handle("machines:create", async (_event, request: CreateMachineRequest): Promise<CreateMachineResult> => {
    return createMachine(request);
  });
  ipcMain.handle("machines:inactivity-questions", (): MachineInactivityQuestion[] => machineInactivityQuestions.list());
  ipcMain.handle("machines:inactivity-answer", async (_event, request: AnswerMachineInactivityRequest): Promise<MachineInactivityQuestion[]> => {
    const id = typeof request?.machineId === "string" ? request.machineId : "";
    if (request?.answer === "keep" || request?.answer === "remove") {
      await machineInactivityQuestions.answer(id, request.answer, (machineId) => removeMachine(machineId));
    }
    return machineInactivityQuestions.list();
  });
  ipcMain.handle("machines:remove", async (_event, request: RemoveMachineRequest): Promise<MachineListResult> => {
    const id = typeof request?.id === "string" ? request.id.trim() : "";
    if (!id) {
      throw new Error("Machine id is required.");
    }
    return removeMachine(id);
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
    publishHubRoster();
    return trustedDevicesResult();
  });
  ipcMain.handle("machines:untrust-device", async (_event, deviceId: string): Promise<MachineTrustedDevicesResult> => {
    await settingsService.removeTrustedDevice(String(deviceId ?? "").trim());
    publishHubRoster();
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
  ipcMain.handle("hub:setup-state", () => hubInstaller.state());
  ipcMain.handle("hub:setup-command", async (_event, request: import("../shared/hubSetup").HubSetupCommandRequest) => {
    const region = typeof request?.region === "string" ? request.region.trim() : "";
    return { command: await hubInstaller.command(region), region };
  });
  ipcMain.handle("hub:install", (_event, request: import("../shared/hubSetup").HubInstallRequest) => hubInstaller.install({
    ...(typeof request?.blob === "string" ? { blob: request.blob } : {}),
    ...(request?.startOver === true ? { startOver: true } : {})
  }));
  ipcMain.handle("mobile:create-phone-invite", async (_event, request: import("../shared/types").CreatePhoneInviteRequest | undefined) => createPhoneInvite(request ?? {}));
  ipcMain.handle("mobile:revoke-phone-invite", async (_event, request: { inviteId?: string } | undefined) => {
    const inviteId = typeof request?.inviteId === "string" ? request.inviteId.trim() : "";
    if (!inviteId) throw new Error("Revoking a phone needs its invite.");
    const removed = await settingsService.revokePhoneInvite(inviteId);
    hubPhonePublisher.phonesChanged();
    // The last phone gone: the server keeps no start key for it.
    hubPhonePublisher.publishWakeKeys();
    publishHubRoster();
    return { revoked: true, inviteId, ...(removed ? { deviceId: removed } : {}) };
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
    // Stop is unconditional and idempotent. A member running on another
    // device is stopped through the User's server (its turn there).
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
  // A downloaded update is applied only when no member is working anywhere:
  // restarting kills the local members' CLI processes, and the new desktop
  // then upgrades every machine's runtime, which kills the members there.
  const updateRestartGate = createUpdateRestartGate({
    isBusy: async () => chatService.liveRunIds().length > 0
      || machineInstallerService.hasActiveOperations()
      || (await machineLinkService?.anyMachineBusy().catch(() => true)) === true,
    onActivitySettled: (listener) => {
      const offRun = chatService.onParticipantRunSettled(() => listener());
      const offHello = machineLinkService?.onHello(() => listener());
      return () => { offRun(); offHello?.(); };
    },
    // The question is asked on a window; one waiting for a window is asked as
    // soon as the User brings one up.
    onWindowAvailable: (listener) => {
      const onFocus = (): void => listener();
      app.on("browser-window-focus", onFocus);
      return () => { app.removeListener("browser-window-focus", onFocus); };
    },
    canPrompt: () => updatePromptWindowShown(updatePromptWindow()),
    prompt: (info) => showUpdateRestartPrompt(info, updatePromptWindow()),
    quitAndInstall: createUpdateRestart({
      quitAndInstall: quitAndInstallUpdate,
      windows: currentUpdateWindows,
      appHidden: appHiddenForUpdate,
      log: (event, payload) => { debugLogService.writeNow(event, payload); }
    }),
    log: (event, payload) => { void debugLogService.write(event, payload); }
  });
  bootstrapAppUpdater(debugLogService, betaUpdates, updateRestartGate);
  // The first start after this desktop updated, while the User's server still
  // runs the older program: the server is updated before the app opens (the
  // User, 2026-10-29), and until then only a loader is shown and no member
  // starts — the link to the server, through which every turn comes, waits.
  const serverUpdate = await hubProgramUpdateDue().catch(() => undefined);
  const serverUpdateLoader = serverUpdate ? openServerUpdateLoader(path.join(__dirname, "../../renderer/assets")) : undefined;
  if (serverUpdate) hubProgramUpdatingBeforeOpening = true;
  await appMcpService.start();
  await storageService.init();
  void scriptService.start().catch((error) => {
    void debugLogService.write("scripts.start.error", { message: error instanceof Error ? error.message : String(error) });
  });
  // A laptop that slept through a due time runs it (or records it missed) on wake.
  powerMonitor.on("resume", () => {
    void scriptService.tick();
  });
  // Before any machine connects: what the shared relay set up goes first.
  await removeRelayEra().catch((error: unknown) => {
    void debugLogService.write("relay.remove-error", { message: error instanceof Error ? error.message : String(error) });
  });
  try {
    const desktopIdentity = await deviceIdentityService.getOrCreateDeviceIdentity();
    machineLinkService = new MachineLinkService(settingsService, debugLogService, {
      // A machine's key changed: the User's server is told who may use it.
      onDevicesChanged: () => publishHubRoster(),
      createClient: (pairing: MobilePairingPackage) => pairing.hubUrl ? new HubTunnelClient({
        hubUrl: pairing.hubUrl, rendezvousId: pairing.rendezvousId, role: "desktop",
        identity: () => deviceIdentityService.getOrCreateDeviceIdentity()
      }) : undefined,
      appVersion: app.getVersion(),
      desktopDeviceId: desktopIdentity.originId,
      deviceIdentity: deviceIdentityService,
      // A member on a machine reads a picture attached here from here (one
      // the phone sent it reads from the server).
      readChatAttachment: (request) => chatService.readChatAttachment(request),
      // Each machine's settings go to the User's server, sealed for it alone.
      publishSettings: async (machineId, sealed) => {
        const client = hubClient;
        if (!client) throw new Error("This computer is not linked to your server.");
        await client.putMachineSettings({ machineId, sealed });
      },
      // Where this desktop's projects were copied on each machine.
      machineProjects: async (machineId) => (await settingsService.listMachineInstalls()).find((record) => record.machineId === machineId)?.projects ?? {}
    });
    const machineLink = machineLinkService;
    // A turn of a member on a machine is asked once the machine has the
    // chat's project and its settings say where (Д4: the machine runs it).
    chatService.setRemoteTurnPreparation({
      beforeRemoteTurn: () => machineLink.syncSettings(),
      machineProjectReady: async (machineId, repoPath) => {
        const install = (await settingsService.listMachineInstalls()).find((record) => record.machineId === machineId);
        // A machine set up by hand keeps its own folders.
        return !install || Boolean(install.projects?.[repoPath]);
      }
    });
    chatService.setMachineWaitReason((machineId) => machineLink.turnWaitReason(machineId));
    // The machines are read before the link to the server starts, so their
    // keys are on the server's roster before anything is written for them;
    // a passing failure to read is tried again first.
    for (let attempt = 1; ; attempt += 1) {
      try {
        await machineLinkService.loadMachines();
        break;
      } catch (error) {
        void debugLogService.write("machine-link.load-error", { attempt, message: error instanceof Error ? error.message : String(error) });
        if (attempt >= 3) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    // Every chat is the server's (Д1): saves go there, its feed comes back.
    // A server about to be updated is linked once its program is replaced.
    if (!serverUpdate) await startServerChatLinkOnce();
    await startHubLink().catch((error: unknown) => {
      void debugLogService.write("hub.link.start-error", { message: error instanceof Error ? error.message : String(error) });
    });
    // A saved setting (an environment value, a role, a rule, a prompt, a
    // member preset) reaches the machines at once, not only on their next
    // connection. Bursts of writes are sent once.
    let machineSettingsSync: ReturnType<typeof setTimeout> | undefined;
    settingsService.onStoredChange(() => {
      hubPhonePublisher.scheduleCatalog();
      if (machineSettingsSync) clearTimeout(machineSettingsSync);
      machineSettingsSync = setTimeout(() => {
        machineSettingsSync = undefined;
        void machineLinkService?.syncSettings().catch((error) => {
          void debugLogService.write("machine-link.settings.sync-error", { message: error instanceof Error ? error.message : String(error) });
        });
      }, 500);
      machineSettingsSync.unref?.();
    });
    machineLinkService.onStatus(() => {
      void machineListResult().then((result) => sendToMainWindow("machines:updated", result));
    });
    // A machine coming or going changes which scripts Settings can reach, and
    // a machine says when its own scripts changed.
    let scriptHostsKey = "";
    machineLinkService.onStatus(() => {
      const key = JSON.stringify(machineLinkService?.scriptHosts() ?? []);
      if (key === scriptHostsKey) return;
      scriptHostsKey = key;
      broadcastScripts();
    });
    machineLinkService.onScriptsChanged((machineId) => broadcastScripts([machineId]));
    // A restarted runtime greets again with a new instance; until then its
    // requests are refused, so it is asked again once it has.
    machineLinkService.onHello((event) => broadcastScripts([event.machineId]));
    machineLinkService.onMemberBackgroundTasks((event) => {
      if (event.member) {
        chatService.applyMachineBackgroundTasks(event.machineId, event.member);
      } else if (event.snapshot) {
        chatService.replaceMachineBackgroundTasks(event.machineId, event.snapshot);
      }
    });
    machineLinkService.onPromptSuggestion((event) => chatService.receiveMemberPromptSuggestion({
      conversationId: event.conversationId,
      participantId: event.participantId,
      runId: event.runId,
      text: event.suggestion
    }, event.machineId));
    // A machine member's live progress, for this window only: the machine
    // posts it to the server itself for the phone.
    machineLinkService.onProgress((progress) => sendToMainWindow("conversations:review-progress", progress));
    machineLinkService.setConversationLoader((conversationId) => storageService.getConversation(conversationId));
    // Machines update together with the desktop: a machine whose runtime is
    // older than this desktop is upgraded as soon as it is connected and idle.
    const link = machineLinkService;
    const autoUpgrade = new MachineAutoUpgradeService({
      desktopVersion: app.getVersion(),
      listInstalls: () => settingsService.listMachineInstalls(),
      machineName: async (machineId) => (await settingsService.listMachines()).find((machine) => machine.id === machineId)?.name,
      machineActivity: (machineId) => link.machineActivity(machineId),
      resolveTarget: async (record) => {
        // An AWS instance gets a new public address every stop/start; the
        // record remembers the one the last setup used. Ask AWS for the
        // running instance's address without waking anything.
        const machine = (await settingsService.listMachines()).find((item) => item.id === record.machineId);
        // A machine installed over an instance's pinned host key is on that
        // instance too, even when its record does not name it.
        const instanceId = machine?.awsInstanceId ?? /^accordagents-(i-[a-f0-9]+)$/.exec(record.target?.hostKeyAlias ?? "")?.[1];
        if (!instanceId) return record.target;
        const worker = await cloudRunAwsService.workerForInspection().catch(() => undefined);
        if (!worker?.host || worker.hostKeyAlias !== `accordagents-${instanceId}`) {
          // Only a machine known to be on the app's instance waits for AWS to
          // name its address; one matched by its host key keeps the saved one.
          return machine?.awsInstanceId ? undefined : record.target;
        }
        return { host: worker.host, user: worker.user, port: worker.port, identityFile: worker.identityFile, hostKeyAlias: worker.hostKeyAlias };
      },
      payloadReady: () => {
        const payload = machineInstallerService.readPayload();
        return payload.ok ? { ok: true } : { ok: false, message: payload.message };
      },
      upgrade: (request, onProgress) => machineInstallerService.upgrade(request, onProgress),
      powerDue: async (record) => {
        const power = await cloudRunAwsService.machinePowerFor(record.machineId);
        return power && machinePowerNeedsDelivery(record, power) ? power.credentials.accessKeyId : undefined;
      },
      // A minute past the record's own retry window, so the key is due again.
      powerRetryMs: MACHINE_POWER_RETRY_MS + 60_000,
      powerMaxAttempts: MACHINE_POWER_MAX_ATTEMPTS,
      holdTurns: (machineId, reason) => link.holdTurns(machineId, reason),
      onProgress: (snapshot) => sendToMainWindow("machines:install-progress", snapshot),
      onChanged: async () => { sendToMainWindow("machines:updated", await machineListResult()); },
      logger: (event, payload) => { void debugLogService.write(event, payload); }
    });
    // A hello the desktop itself asked for (machineActivity) is not announced
    // here, so evaluating on every hello cannot feed itself.
    link.onHello((event) => { void autoUpgrade.evaluate(event.machineId); });
    evaluateMachineUpdates = () => { void autoUpgrade.evaluate(); };
    machineRecovery = new MachineRecoveryService({
      now: () => Date.now(),
      linkStartedAt: () => machineLinkStartedAt,
      // Where the machine is met says whether it is there: its room on the
      // relay, or on the User's server for a machine that talks only to it.
      linkState: (machineId) => link.presenceState(machineId),
      machineOnInstance: () => cloudRunAwsService.autoStopMachineRecord(),
      instanceRunningSince: () => cloudRunAwsService.instanceRunningSince(),
      setupRunning: (machineId) => Boolean(machineInstallerService.activeOperation(machineId)),
      inspect: (record) => inspectCloudMachine(record),
      reinstall: async (machineId) => {
        // A turn sent meanwhile waits for the new program instead of
        // reaching one that is about to be stopped.
        const release = link.holdTurns(machineId, "The cloud machine's program is being set up again.");
        try {
          await cloudRunPreparation.prepareRuntime({ agentsChecked: true, machineId, automatic: true });
        } finally {
          release();
        }
        void autoUpgrade.evaluate();
        void machineListResult().then((result) => sendToMainWindow("machines:updated", result)).catch(() => undefined);
      },
      log: (event, payload) => { void debugLogService.write(event, payload); }
    });
    const recoveryTimer = setInterval(() => { void machineRecovery?.check(); }, 60_000);
    recoveryTimer.unref?.();
    retryMachineUpdate = (machineId) => autoUpgrade.retry(machineId);
    chatService.onParticipantRunSettled(() => { if (autoUpgrade.hasWaiting()) void autoUpgrade.evaluate(); });
    // A turn started from the phone ends on the machine without an event this
    // desktop subscribes to; while a machine waits for idle, ask again.
    const autoUpgradeTimer = setInterval(() => { if (autoUpgrade.hasWaiting()) void autoUpgrade.evaluate(); }, ACTIVITY_RECHECK_MS);
    autoUpgradeTimer.unref?.();
    machineLinkStartedAt = Date.now();
    // An instance that was terminated while this desktop was closed leaves
    // no machine behind and no pile of chat changes kept for it. Looked at
    // once the link has its machines, so a removal is not undone by start.
    const forgetGoneInstance = (): void => {
      void cloudRunAwsService.forgetInstanceIfGone().catch((error: unknown) => {
        void debugLogService.write("aws-worker.gone-check.error", { message: error instanceof Error ? error.message : String(error) });
      });
    };
    void machineLinkService.start().then(() => {
      markMachineLinkReady();
      forgetGoneInstance();
      return autoUpgrade.evaluate();
    }).catch((error) => {
      markMachineLinkReady();
      forgetGoneInstance();
      void debugLogService.write("machine-link.start.error", { message: error instanceof Error ? error.message : String(error) });
    });
    // While a machine stays away, the User's server keeps everything it has
    // not read. Once every 10 days the User is asked about machines inactive
    // that long, in the window's notice stack; the answers come back over IPC.
    new MachineInactivityCheck({
      listMachines: () => settingsService.listMachines(),
      isConnected: (machineId) => link.isMachineConnected(machineId),
      // Its last read of the server's feed counts as activity too (it may
      // work for the phone while this desktop is closed).
      lastActiveAt: async (machine) => machine.deviceId ? (await hubFeedReads())?.get(machine.deviceId) : undefined,
      lastCheckAt: () => settingsService.getMachineInactivityCheckAt(),
      saveLastCheckAt: (at) => settingsService.saveMachineInactivityCheckAt(at),
      ask: (machine) => machineInactivityQuestions.ask({ machineId: machine.id, name: machine.name, inactiveDays: machine.inactiveDays }),
      log: (event, payload) => { void debugLogService.write(event, payload); }
    }).start();
    link.onHello((event) => machineInactivityQuestions.settle(event.machineId, "active"));
  } catch (error) {
    void debugLogService.write("machine-link.init.error", { message: error instanceof Error ? error.message : String(error) });
    markMachineLinkReady();
  }
  // A document's chat note this computer wrote before documents moved to the
  // server and never got into the chat goes in now (later notes come with the
  // server's feed).
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
  // A member removal the User approved before the app quit, still waiting for
  // a turn to end (nothing runs after a restart, so it is applied now), and a
  // machine member's addition not applied yet.
  void chatService.resumeQueuedRosterChanges().catch((error) => {
    void debugLogService.write("chat.member-removal.resume-error", {
      message: error instanceof Error ? error.message : String(error)
    });
  });
  if (serverUpdate && serverUpdateLoader) {
    const offProgress = hubInstaller.onProgress((state) => {
      if (state.status === "installing" && state.message) serverUpdateLoader.status(state.message);
    });
    try {
      let installing: Promise<{ status: string; message?: string }> | undefined;
      const outcome = await updateServerBeforeOpening({
        ownerConfirmed: () => hubOwnerConfirmed,
        install: () => {
          hubProgramUpdateTries.set(serverUpdate.to, (hubProgramUpdateTries.get(serverUpdate.to) ?? 0) + 1);
          installing = hubInstaller.install({});
          return installing;
        },
        loader: serverUpdateLoader,
        log: (event, payload) => { void debugLogService.write(event, payload); },
        from: serverUpdate.from,
        to: serverUpdate.to
      });
      if (outcome === "timed-out" && installing) {
        // It goes on behind the open app; the scheduled update waits for it.
        void installing.finally(() => { hubProgramUpdatingBeforeOpening = false; }).catch(() => undefined);
      } else {
        hubProgramUpdatingBeforeOpening = false;
      }
      if (outcome === "failed") scheduleHubProgramUpdate(HUB_PROGRAM_UPDATE_RETRY_MS);
    } catch (error) {
      hubProgramUpdatingBeforeOpening = false;
      void debugLogService.write("hub.program-update.error", { message: error instanceof Error ? error.message : String(error), beforeOpening: true });
    } finally {
      offProgress();
    }
    // Updated or not, the chats go through the server from here (an update
    // that linked the server again has started the link already).
    await startServerChatLinkOnce();
  }
  createWindow();
  serverUpdateLoader?.close();
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
  debugLogService.writeNow("app-window.all-closed", { forUpdate: quittingForUpdate, quitting: quitCleanupStarted });
  // The loader closed by hand while the server updates: the app's window
  // still comes.
  if (process.platform !== "darwin" && !hubProgramUpdatingBeforeOpening) {
    app.quit();
  }
});

autoUpdater.on("before-quit-for-update", () => {
  const again = quittingForUpdate;
  quittingForUpdate = true;
  debugLogService.writeNow("app-update-before-quit", { again, windows: currentUpdateWindows() });
  // The updater cannot await the normal graceful quit gate. Kill warm CLI
  // process trees synchronously so detached background work cannot outlive the
  // app and keep mutating the repository during installation.
  cliAgentRunner.terminateWarmAgentsImmediately("update installation");
});

/**
 * A restart for an update that did not happen. Electron closes every window
 * for it and then asks the native updater to install; when that finds nothing
 * to install ("No update available, can't quit and install") or cannot
 * relaunch, it reports an error and the app goes on running with no window
 * — on the User's desktop on 2026-10-29 it looked as if the app had updated,
 * and it was still beta.7. The window comes back and says what to do: the
 * downloaded update still installs when the app quits.
 */
autoUpdater.on("error", (error: Error) => {
  if (!quittingForUpdate) return;
  quittingForUpdate = false;
  debugLogService.writeNow("app-update-restart-failed", { message: error instanceof Error ? error.message : String(error) });
  setImmediate(() => {
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
    const window = mainWindow;
    if (!window) return;
    const say = (): void => {
      if (window.isDestroyed()) return;
      if (!window.isVisible()) window.show();
      void dialog.showMessageBox(window, {
        type: "warning",
        buttons: ["OK"],
        message: "The update was not installed",
        detail: "Quit AccordAgents and open it again to finish installing it."
      }).then(() => { void debugLogService.write("app-update-restart-failed-shown", {}); });
    };
    if (window.webContents.isLoading()) window.webContents.once("did-finish-load", say);
    else say();
  });
});

app.on("before-quit", (event) => {
  debugLogService.writeNow("app-quit.before-quit", {
    forUpdate: quittingForUpdate,
    cleanupStarted: quitCleanupStarted,
    cleanupFinished: quitCleanupFinished,
    windows: BrowserWindow.getAllWindows().length
  });
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
  const cleanupStartedAt = Date.now();
  let cleanupDone = false;
  const cleanup = Promise.allSettled([
    serverChatLink.stop(),
    cliAgentRunner.shutdownWarmAgents(),
    scriptService.stop().then(() => appMcpService.stop())
  ]).then(() => { cleanupDone = true; });
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5_000));
  void Promise.race([cleanup, timeout]).finally(() => {
    debugLogService.writeNow("app-quit.cleanup-finished", { ms: Date.now() - cleanupStartedAt, timedOut: !cleanupDone });
    quitCleanupFinished = true;
    // Quit again only after Electron's own quit call has returned. A quit
    // from the Quit menu (Cmd+Q), the Dock or a signal starts in native code,
    // so this promise can settle while that call is still emitting
    // before-quit: a nested app.quit() then runs inside it, and the outer call
    // overwrites the quitting state with "cancelled" on return. The windows
    // close and the app keeps running with none (2026-10-20, the User's
    // Cmd+Q at 08:45). The immediate runs at the loop's next wakeup, which
    // the quit's own file and network work brings at once (0 ms measured).
    setImmediate(() => app.quit());
  });
});

app.on("will-quit", () => {
  debugLogService.writeNow("app-quit.will-quit", { forUpdate: quittingForUpdate });
});

app.on("quit", (_event, exitCode) => {
  debugLogService.writeNow("app-quit.quit", { exitCode, forUpdate: quittingForUpdate });
});

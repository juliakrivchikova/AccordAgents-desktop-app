import path from "node:path";
import { userDataPath } from "../platform";
import type { MachineRecord, MachineSettingsSnapshot } from "../../shared/machineLink";
import type { TrustedDeviceRecord } from "../../shared/machineTrust";
import type { MachineInstallRecord } from "../../shared/machineInstall";
import type { AwsMachinePowerConfig } from "../../shared/machinePower";
import type { MachinePowerHandoffRecord } from "../../shared/machinePowerHandoff";
import type { MobilePairingPackage } from "../../shared/mobilePairing";
import type {
  AppSettings, AgentHealth, ChatBehaviorRuleConfigUpdate, ChatSavedPromptConfigUpdate, AwsWorkerHandleInfo,
  AwsWorkerOperationSnapshot, AwsWorkerSpec, AwsWorkerVolumeExpansion, CloudRunsSettingsUpdate, CloudRunWorkerMode,
  CliProviderHost, CliProviderHostUpdate, ChatParticipantConfigUpdate, ChatPromptContextSettings, ChatProviderKind,
  ChatRoleChangeOperation, ChatRoleConfigUpdate, NewChatDefaultsUpdate, AgentEnvironmentVariable, ProviderSettingsUpdate,
  RepoFileExternalOpenAction, RepoFileOpenAction, SaveAgentEnvironmentVariableRequest, SubagentDefaultUpdate
} from "../../shared/types";
import type { ReadCustomAvatarResult, SaveCustomAvatarRequest } from "../../shared/avatarStudio";
import type { AwsWorkerCredentials } from "./awsWorkerProvisioning";
import type { HubLinkConfig } from "../../shared/hubSetup";
import type { AwsWorkerGoneNotice, LeavingMachine } from "./settings/aws/leavingMachines";
import type { StoredHubPhoneInvite } from "./settings/machines/hubSetting";
import type { RelayRemovalFailure, RelayRemovalRecord } from "./settings/machines/relayRemovalRecords";
import type { SettingsUsageEvent } from "./settings/members/memberUsageEvent";
import { createSettingsModules, type SettingsModules } from "./settings/modules";

export type { AwsWorkerGoneNotice, LeavingMachine } from "./settings/aws/leavingMachines";
export type { RelayRemovalRecord, RelayRemovalPending, RelayRemovalFailure } from "./settings/machines/relayRemovalRecords";
export { BUILTIN_CHAT_ROLE_IDS, DEFAULT_MEMBER_ROLE_ID } from "./settings/roles/defaultRoles";
export type { SettingsUsageEvent } from "./settings/members/memberUsageEvent";
export type { StoredHubPhoneInvite } from "./settings/machines/hubSetting";

/** The app's settings. The work is done by the parts in ./settings. */
export class SettingsService {
  private readonly modules: SettingsModules;

  constructor(options: { profileHome?: string } = {}) {
    this.modules = createSettingsModules({ options, settingsPath: path.join(userDataPath(), "settings.json") });
  }

  setUsageObserver(observer: ((event: SettingsUsageEvent) => void) | undefined): void {
    this.modules.memberUsage.setUsageObserver(observer);
  }

  getPublicSettings(): Promise<AppSettings> {
    return this.modules.publicSettings.getPublicSettings();
  }

  saveCustomAvatar(request: SaveCustomAvatarRequest): Promise<AppSettings> {
    return this.modules.customAvatars.saveCustomAvatar(request);
  }

  readCustomAvatar(id: string): Promise<ReadCustomAvatarResult> {
    return this.modules.customAvatars.readCustomAvatar(id);
  }

  updateProvider(update: ProviderSettingsUpdate): Promise<AppSettings> {
    return this.modules.providerDefaults.updateProvider(update);
  }

  setAssistantProviderKind(kind: ChatProviderKind): Promise<AppSettings> {
    return this.modules.providerDefaults.setAssistantProviderKind(kind);
  }

  /** How a new chat starts besides its CLI (Settings → General → New chats,
   *  shared/newChatDefaults.ts). */
  setNewChatDefaults(update: NewChatDefaultsUpdate): Promise<AppSettings> {
    return this.modules.providerDefaults.setNewChatDefaults(update);
  }

  /** One CLI's model and effort for the agents a chat gives tasks to
   *  (Settings → General → Agents, shared/subagentProviders.ts). */
  setSubagentDefault(update: SubagentDefaultUpdate): Promise<AppSettings> {
    return this.modules.providerDefaults.setSubagentDefault(update);
  }

  ensureAssistantProviderDefault(agents: AgentHealth[]): Promise<AppSettings> {
    return this.modules.providerDefaults.ensureAssistantProviderDefault(agents);
  }

  recordSuccessfulChatProvider(kind: ChatProviderKind): Promise<void> {
    return this.modules.providerDefaults.recordSuccessfulChatProvider(kind);
  }

  saveChatRoleConfig(update: ChatRoleConfigUpdate): Promise<AppSettings> {
    return this.modules.roleConfigs.saveChatRoleConfig(update);
  }

  // Soft-delete a custom role. The record stays in settings so existing participants
  // keep resolving; it is hidden from the Roles list and pickers by the renderer.
  // Product rule: custom roles only, and only when no saved participant preset uses it.
  archiveChatRoleConfig(id: string): Promise<AppSettings> {
    return this.modules.roleConfigs.archiveChatRoleConfig(id);
  }

  saveChatRoleParticipantConfigBatch(
    roleOperations: ChatRoleChangeOperation[],
    participantUpdates: ChatParticipantConfigUpdate[]
  ): Promise<{ settings: AppSettings; roleIdByDraftRoleRef: Record<string, string> }> {
    return this.modules.roleConfigs.saveChatRoleParticipantConfigBatch(roleOperations, participantUpdates);
  }

  saveChatBehaviorRuleConfig(update: ChatBehaviorRuleConfigUpdate): Promise<AppSettings> {
    return this.modules.behaviorRules.saveChatBehaviorRuleConfig(update);
  }

  deleteChatBehaviorRuleConfig(id: string): Promise<AppSettings> {
    return this.modules.behaviorRules.deleteChatBehaviorRuleConfig(id);
  }

  saveChatSavedPromptConfig(update: ChatSavedPromptConfigUpdate): Promise<AppSettings> {
    return this.modules.savedPrompts.saveChatSavedPromptConfig(update);
  }

  deleteChatSavedPromptConfig(id: string): Promise<AppSettings> {
    return this.modules.savedPrompts.deleteChatSavedPromptConfig(id);
  }

  saveChatParticipantConfig(update: ChatParticipantConfigUpdate): Promise<AppSettings> {
    return this.modules.memberPresets.saveChatParticipantConfig(update);
  }

  deleteChatParticipantConfig(id: string): Promise<AppSettings> {
    return this.modules.memberPresets.deleteChatParticipantConfig(id);
  }

  ensureGenericChatParticipantSeeds(agents: AgentHealth[]): Promise<AppSettings> {
    return this.modules.memberPresets.ensureGenericChatParticipantSeeds(agents);
  }

  getMachineInactivityCheckAt(): Promise<string | undefined> {
    return this.modules.machinePower.getMachineInactivityCheckAt();
  }

  saveMachineInactivityCheckAt(at: string): Promise<void> {
    return this.modules.machinePower.saveMachineInactivityCheckAt(at);
  }

  updateLastRepoPath(repoPath: string): Promise<AppSettings> {
    return this.modules.appPreferences.updateLastRepoPath(repoPath);
  }

  getRepoFileOpenAction(): Promise<RepoFileOpenAction | undefined> {
    return this.modules.appPreferences.getRepoFileOpenAction();
  }

  setRepoFileOpenAction(action: RepoFileOpenAction | null): Promise<AppSettings> {
    return this.modules.appPreferences.setRepoFileOpenAction(action);
  }

  /** Undefined until the User chose (or had chosen before the panel): files the panel does not show then ask. */
  getRepoFileExternalOpenAction(): Promise<RepoFileExternalOpenAction | undefined> {
    return this.modules.appPreferences.getRepoFileExternalOpenAction();
  }

  setRepoFileExternalOpenAction(action: unknown): Promise<AppSettings> {
    return this.modules.appPreferences.setRepoFileExternalOpenAction(action);
  }

  getBetaUpdatesEnabled(): Promise<boolean> {
    return this.modules.appPreferences.getBetaUpdatesEnabled();
  }

  setBetaUpdates(enabled: boolean): Promise<AppSettings> {
    return this.modules.appPreferences.setBetaUpdates(enabled);
  }

  setChatShowMemberActions(shown: boolean): Promise<AppSettings> {
    return this.modules.appPreferences.setChatShowMemberActions(shown);
  }

  /** Kept in a marker file next to settings.json, not in it; see
   *  CRASH_REPORTS_OFF_MARKER. */
  setCrashReports(enabled: boolean): Promise<AppSettings> {
    return this.modules.appPreferences.setCrashReports(enabled);
  }

  dismissCrashReportsNotice(): Promise<AppSettings> {
    return this.modules.appPreferences.dismissCrashReportsNotice();
  }

  getCliAgentRunTimeoutMs(): Promise<number> {
    return this.modules.appPreferences.getCliAgentRunTimeoutMs();
  }

  setCliAgentRunTimeoutMs(timeoutMs: number): Promise<AppSettings> {
    return this.modules.appPreferences.setCliAgentRunTimeoutMs(timeoutMs);
  }

  getChatParticipantRequestMaxDepth(): Promise<number> {
    return this.modules.appPreferences.getChatParticipantRequestMaxDepth();
  }

  setChatParticipantRequestMaxDepth(maxDepth: number): Promise<AppSettings> {
    return this.modules.appPreferences.setChatParticipantRequestMaxDepth(maxDepth);
  }

  getChatParticipantRequestPromptMaxChars(): Promise<number> {
    return this.modules.appPreferences.getChatParticipantRequestPromptMaxChars();
  }

  setChatParticipantRequestPromptMaxChars(maxChars: number): Promise<AppSettings> {
    return this.modules.appPreferences.setChatParticipantRequestPromptMaxChars(maxChars);
  }

  setChatAutoWatchWakeLimit(limit: number): Promise<AppSettings> {
    return this.modules.appPreferences.setChatAutoWatchWakeLimit(limit);
  }

  setChatPromptContext(settings: ChatPromptContextSettings): Promise<AppSettings> {
    return this.modules.appPreferences.setChatPromptContext(settings);
  }

  saveCloudRunsSettings(update: CloudRunsSettingsUpdate): Promise<AppSettings> {
    return this.modules.cloudRuns.saveCloudRunsSettings(update);
  }

  /** Every variable members get, with the first and last characters of its
   *  value: the page never receives a whole value. */
  listAgentEnvironmentVariables(): Promise<AgentEnvironmentVariable[]> {
    return this.modules.agentEnvironment.listAgentEnvironmentVariables();
  }

  /** The variables members get, and the names they must not get from this
   *  computer either because the User deleted them. */
  getManualAgentEnvironment(): Promise<{ env: NodeJS.ProcessEnv; version: string; removedKeys: string[] }> {
    return this.modules.agentEnvironment.getManualAgentEnvironment();
  }

  /** A value the User saves is hers: it stays until she changes or deletes it,
   *  whatever the computer says later. */
  saveAgentEnvironmentVariable(update: SaveAgentEnvironmentVariableRequest): Promise<void> {
    return this.modules.agentEnvironment.saveAgentEnvironmentVariable(update);
  }

  /** Deleting is the same for every variable. When this computer sets the
   *  name too (or the variable came from it), the name is remembered so the
   *  next reading does not bring it back. */
  deleteAgentEnvironmentVariable(key: string, setByThisComputer = false): Promise<void> {
    return this.modules.agentEnvironment.deleteAgentEnvironmentVariable(key, setByThisComputer);
  }

  /** Brings the automatic variables in step with what this computer sets now:
   *  a new name is added, a changed value is updated, a name the computer no
   *  longer sets goes away. A value the User saved and a name she deleted are
   *  left as she made them. Returns whether anything changed. */
  reconcileAutomaticAgentEnvironment(computerEnvironment: Record<string, string>): Promise<boolean> {
    return this.modules.agentEnvironment.reconcileAutomaticAgentEnvironment(computerEnvironment);
  }

  /** Called after every settings write that reached the disk. */
  onStoredChange(listener: () => void): () => void {
    return this.modules.settingsStore.onStoredChange(listener);
  }

  // AWS-managed worker credential storage. Credentials are encrypted with
  // Electron safeStorage (same protection as provider API keys) and never
  // leave the main process; only hasAwsCredentials + the handle are public.
  saveAwsWorkerCredentials(credentials: AwsWorkerCredentials): Promise<void> {
    return this.modules.awsWorker.saveAwsWorkerCredentials(credentials);
  }

  getAwsWorkerCredentials(): Promise<AwsWorkerCredentials | undefined> {
    return this.modules.awsWorker.getAwsWorkerCredentials();
  }

  saveAwsWorkerHandle(handle: AwsWorkerHandleInfo | undefined): Promise<void> {
    return this.modules.awsWorker.saveAwsWorkerHandle(handle);
  }

  saveAwsWorkerConnection(credentials: AwsWorkerCredentials, handle: AwsWorkerHandleInfo): Promise<void> {
    return this.modules.awsWorker.saveAwsWorkerConnection(credentials, handle);
  }

  // Machines transport: enrolled machines and their sealed pairing packages.
  listMachines(): Promise<MachineRecord[]> {
    return this.modules.machineRegistry.listMachines();
  }

  saveMachine(record: MachineRecord, pairing?: MobilePairingPackage): Promise<MachineRecord[]> {
    return this.modules.machineRegistry.saveMachine(record, pairing);
  }

  restoreMachineEnrollment(id: string, requested: MobilePairingPackage, installed: MobilePairingPackage, installedMachineId = id): Promise<MachineRecord> {
    return this.modules.machineRegistry.restoreMachineEnrollment(id, requested, installed, installedMachineId);
  }

  removeMachine(id: string): Promise<MachineRecord[]> {
    return this.modules.machineRegistry.removeMachine(id);
  }

  /** The devices the User trusts with their machines. */
  listTrustedDevices(): Promise<TrustedDeviceRecord[]> {
    return this.modules.trustedDevices.listTrustedDevices();
  }

  /**
   * Adds or replaces a trusted device.
   *
   * The id has to be the one its key produces: a device is identified by its
   * signing key, and accepting a mismatched pair would trust a name rather
   * than a key.
   */
  saveTrustedDevice(record: TrustedDeviceRecord): Promise<TrustedDeviceRecord[]> {
    return this.modules.trustedDevices.saveTrustedDevice(record);
  }

  removeTrustedDevice(deviceId: string): Promise<TrustedDeviceRecord[]> {
    return this.modules.trustedDevices.removeTrustedDevice(deviceId);
  }

  /** A phone invite this desktop just registered with its server. */
  savePhoneInvite(invite: Omit<StoredHubPhoneInvite, "state">): Promise<void> {
    return this.modules.phoneInvites.savePhoneInvite(invite);
  }

  /**
   * A phone that enrolled with one of this desktop's invites (its certificate
   * already checked against this desktop's key). Trusted unless the invite
   * was revoked: then it stays out, whatever it shows again.
   */
  admitInvitedPhone(record: TrustedDeviceRecord & { inviteId: string }): Promise<boolean> {
    return this.modules.phoneInvites.admitInvitedPhone(record);
  }

  /** Revokes an invite: unused, it can no longer be used; used, its phone
   *  is removed. Returns the phone removed, if any. */
  revokePhoneInvite(inviteId: string): Promise<string | undefined> {
    return this.modules.phoneInvites.revokePhoneInvite(inviteId);
  }

  listPhoneInvites(): Promise<StoredHubPhoneInvite[]> {
    return this.modules.phoneInvites.listPhoneInvites();
  }

  /** The invites the server and the machines are told are settled. */
  resolvedPhoneInviteIds(): Promise<string[]> {
    return this.modules.phoneInvites.resolvedPhoneInviteIds();
  }

  /**
   * The machines that were enrolled with the shared relay: their enrollment
   * names no server of the User's, so they can never connect again. Every
   * machine set up since names the server, so this empties as they go.
   */
  relayEraMachines(): Promise<MachineRecord[]> {
    return this.modules.relayRemoval.relayEraMachines();
  }

  /** What a removal found before it takes anything off, merged with what an
   *  earlier, unfinished one found: the record names all of it. */
  beginRelayRemoval(found: { machines: Array<{ id: string; name: string }>; startKeyHanded: boolean }): Promise<void> {
    return this.modules.relayRemoval.beginRelayRemoval(found);
  }

  /**
   * Takes what was set up through the shared relay off this desktop, once:
   * the phones paired through it (a phone paired with the User's server has
   * the invite it enrolled with), and the files the relay's pairings kept.
   * The machines went first, through the usual removal (relayEraMachines);
   * what was found is recorded, but for the machines whose ids
   * are in `notRemoved` (their removal failed; tried again at each start).
   * Returns the record, or undefined when this was done before.
   */
  finishRelayRemoval(notRemoved: string[] = []): Promise<RelayRemovalRecord | undefined> {
    return this.modules.relayRemoval.finishRelayRemoval(notRemoved);
  }

  /** Relay machines a later start removed (after failing before): added to
   *  the record. */
  noteRelayMachinesRemoved(names: string[]): Promise<void> {
    return this.modules.relayRemoval.noteRelayMachinesRemoved(names);
  }

  /** The relay machines whose removal failed at this start, replacing the
   *  last start's; one removed (or gone) is dropped. */
  noteRelayRemovalFailures(failures: Array<{ machineId: string; machine: string; message: string }>): Promise<void> {
    return this.modules.relayRemoval.noteRelayRemovalFailures(failures);
  }

  relayRemovalFailures(): Promise<RelayRemovalFailure[]> {
    return this.modules.relayRemoval.relayRemovalFailures();
  }

  relayRemoval(): Promise<RelayRemovalRecord | undefined> {
    return this.modules.relayRemoval.relayRemoval();
  }

  /** Machine install records (machines transport, install/upgrade). Kept next
   *  to the machine records but deliberately outside the settings snapshot a
   *  machine receives. */
  listMachineInstalls(): Promise<MachineInstallRecord[]> {
    return this.modules.machineRegistry.listMachineInstalls();
  }

  getMachineInstall(machineId: string): Promise<MachineInstallRecord | undefined> {
    return this.modules.machineRegistry.getMachineInstall(machineId);
  }

  saveMachineInstall(record: MachineInstallRecord): Promise<void> {
    return this.modules.machineRegistry.saveMachineInstall(record);
  }

  removeMachineInstall(machineId: string): Promise<void> {
    return this.modules.machineRegistry.removeMachineInstall(machineId);
  }

  getMachinePairing(pairingKey: string): Promise<MobilePairingPackage | undefined> {
    return this.modules.hubSettings.getMachinePairing(pairingKey);
  }

  /** The hub this desktop syncs with. `ACCORDAGENTS_HUB_URL` points a local
   *  run at a test hub. An address that is neither HTTPS nor on this
   *  computer is not used. */
  getHubConfig(): Promise<HubLinkConfig | undefined> {
    return this.modules.hubSettings.getHubConfig();
  }

  /** Setup writes this once the User's hub answers (the hub setup flow). */
  saveHubConfig(config: HubLinkConfig | undefined): Promise<void> {
    return this.modules.hubSettings.saveHubConfig(config);
  }

  /** Whether the User left automatic stop on; the stop key is separate. */
  getMachineAutoStopEnabled(): Promise<boolean> {
    return this.modules.machinePower.getMachineAutoStopEnabled();
  }

  getMachineAutoStopChangedAt(): Promise<string | undefined> {
    return this.modules.machinePower.getMachineAutoStopChangedAt();
  }

  setMachineAutoStopEnabled(enabled: boolean): Promise<void> {
    return this.modules.machinePower.setMachineAutoStopEnabled(enabled);
  }

  getMachinePower(): Promise<AwsMachinePowerConfig | undefined> {
    return this.modules.machinePower.getMachinePower();
  }

  /** Start-key handoffs to devices (Rule 3). Records only; the key itself is
   *  the phone's start key in the AWS credentials, and reaches a device only
   *  inside its pairing link. */
  listMachinePowerHandoffs(): Promise<MachinePowerHandoffRecord[]> {
    return this.modules.machinePower.listMachinePowerHandoffs();
  }

  saveMachinePowerHandoffs(records: MachinePowerHandoffRecord[]): Promise<void> {
    return this.modules.machinePower.saveMachinePowerHandoffs(records);
  }

  /** Puts back the power key the last save replaced (none, if there was
   *  none): the runtime did not come back after a handover, and the key it
   *  ran with before is the one known to work. */
  revertMachinePower(): Promise<void> {
    return this.modules.machinePower.revertMachinePower();
  }

  saveMachinePower(config: AwsMachinePowerConfig): Promise<void> {
    return this.modules.machinePower.saveMachinePower(config);
  }

  /** What a machine needs to run participants exactly like this desktop:
   *  roles, rules, saved prompts, participant presets, prompt-context and
   *  limit settings, and the manually configured agent environment values.
   *  Dedicated provider/AWS credentials and machine records are excluded;
   *  secrets explicitly configured in agent environment variables travel. */
  exportMachineSettingsSnapshot(): Promise<MachineSettingsSnapshot> {
    return this.modules.machineSnapshot.exportMachineSettingsSnapshot();
  }

  /** Applies a desktop snapshot on a machine: shareable settings replace the
   *  machine's copy, environment values are stored with the machine's own
   *  secret store, and everything the machine owns (its records, providers)
   *  is kept. */
  importMachineSettingsSnapshot(snapshot: MachineSettingsSnapshot): Promise<void> {
    return this.modules.machineSnapshot.importMachineSettingsSnapshot(snapshot);
  }

  getCloudRunsDeviceId(): Promise<string> {
    return this.modules.cloudRuns.getCloudRunsDeviceId();
  }

  saveAwsWorkerOperation(operation: AwsWorkerOperationSnapshot | undefined): Promise<void> {
    return this.modules.awsWorker.saveAwsWorkerOperation(operation);
  }

  getAwsWorkerOperation(): Promise<AwsWorkerOperationSnapshot | undefined> {
    return this.modules.awsWorker.getAwsWorkerOperation();
  }

  saveAwsWorkerProvisioningToken(token: string | undefined): Promise<void> {
    return this.modules.awsWorker.saveAwsWorkerProvisioningToken(token);
  }

  getAwsWorkerProvisioningToken(): Promise<string | undefined> {
    return this.modules.awsWorker.getAwsWorkerProvisioningToken();
  }

  saveAwsWorkerVolumeExpansion(expansion: AwsWorkerVolumeExpansion | undefined): Promise<void> {
    return this.modules.awsWorker.saveAwsWorkerVolumeExpansion(expansion);
  }

  getAwsWorkerVolumeExpansion(): Promise<AwsWorkerVolumeExpansion | undefined> {
    return this.modules.awsWorker.getAwsWorkerVolumeExpansion();
  }

  /** Forgets the AWS instance `instanceId` in one write, and only while it
   *  is still the saved one; false when another instance was saved meanwhile.
   *  Without `keepCredentials` this app's AWS keys go too (Delete). The
   *  notice, when given, is what the AWS page says about it; otherwise any
   *  earlier one ends. */
  forgetAwsWorkerInstance(instanceId: string, options: {
    keepCredentials: boolean;
    notice?: AwsWorkerGoneNotice;
    mode?: CloudRunWorkerMode;
  }): Promise<boolean> {
    return this.modules.awsWorker.forgetAwsWorkerInstance(instanceId, options);
  }

  getAwsWorkerGoneNotice(): Promise<AwsWorkerGoneNotice | undefined> {
    return this.modules.awsWorker.getAwsWorkerGoneNotice();
  }

  /** Records machines that leave with their instance, before any is
   *  removed. Returns the oldest entries the limit dropped, if any. */
  addLeavingMachines(entries: LeavingMachine[]): Promise<LeavingMachine[]> {
    return this.modules.awsWorker.addLeavingMachines(entries);
  }

  listLeavingMachines(): Promise<LeavingMachine[]> {
    return this.modules.awsWorker.listLeavingMachines();
  }

  clearLeavingMachine(machineId: string): Promise<void> {
    return this.modules.awsWorker.clearLeavingMachine(machineId);
  }

  saveAwsWorkerSpecAcceptance(instanceId: string, desired: AwsWorkerSpec): Promise<void> {
    return this.modules.awsWorker.saveAwsWorkerSpecAcceptance(instanceId, desired);
  }

  hasAwsWorkerSpecAcceptance(instanceId: string, desired: AwsWorkerSpec): Promise<boolean> {
    return this.modules.awsWorker.hasAwsWorkerSpecAcceptance(instanceId, desired);
  }

  setCloudRunsMode(mode: CloudRunWorkerMode): Promise<void> {
    return this.modules.cloudRuns.setCloudRunsMode(mode);
  }

  clearAwsWorker(): Promise<void> {
    return this.modules.awsWorker.clearAwsWorker();
  }

  listCliProviderHosts(): Promise<CliProviderHost[]> {
    return this.modules.providerHosts.listCliProviderHosts();
  }

  saveCliProviderHost(update: CliProviderHostUpdate): Promise<AppSettings> {
    return this.modules.providerHosts.saveCliProviderHost(update);
  }

  deleteCliProviderHost(id: string): Promise<AppSettings> {
    return this.modules.providerHosts.deleteCliProviderHost(id);
  }

  /** The host plus its decrypted key, for a run. Never crosses the bridge. */
  getCliProviderHostSecret(id: string): Promise<{ host: CliProviderHost; apiKey: string | undefined } | undefined> {
    return this.modules.providerHosts.getCliProviderHostSecret(id);
  }
}

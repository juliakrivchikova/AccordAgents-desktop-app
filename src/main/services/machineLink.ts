import type { CliStartDefaultsByKind } from "../../shared/cliStartDefaults";
import type { MachineMemberRestartSupport } from "../../shared/memberRestart";
import type { MachineSessionMoveTarget } from "../../shared/memberSessionMove";
import type { ForkToNewChatMachineSupport } from "../../shared/forkToNewChat";
import type { CliModesMachineSupport } from "../../shared/chatAccessModes";
import type { MachineLinkStatus, MachineRecord, MachineScriptsOperation } from "../../shared/machineLink";
import type { MobilePairingPackage } from "../../shared/mobilePairing";
import type { Conversation, ReviewProgress } from "../../shared/types";
import type { MachineRecoveryLinkState } from "./machineRecovery";
import type { MachineActivity } from "./machineLink/activityState";
import { SCRIPTS_REQUEST_TIMEOUT_MS } from "./machineLink/constants";
import type { MachineMemberBackgroundEvent, MachinePromptSuggestionEvent, MachineScriptHost } from "./machineLink/types";
import type { DebugLogService } from "./debugLogs";
import type { MachineLinkDependencies } from "./machineLink/dependencies";
import type { MachineLinkOptions } from "./machineLink/types";
import { createMachineLinkModules, type MachineLinkModules } from "./machineLink/modules";

export type { MachineLinkOptions, MachineMemberBackgroundEvent, MachinePromptSuggestionEvent, MachineScriptHost } from "./machineLink/types";
export { type MachineActivity, machineActivityIsBusy } from "./machineLink/activityState";
export type { MachineLinkStatus };

/** The desktop's link to its machines. The work is done by the parts in ./machineLink. */
export class MachineLinkService {
  private readonly modules: MachineLinkModules;

  constructor(
    settings: MachineLinkDependencies["settings"],
    debugLogs: Pick<DebugLogService, "write">,
    options: MachineLinkOptions
  ) {
    this.modules = createMachineLinkModules({ settings, debugLogs, options, now: options.now ?? (() => new Date()) });
  }

  onStatus(listener: (status: MachineLinkStatus[]) => void): () => void {
    return this.modules.machineConnections.onStatus(listener);
  }

  /** A member hosted on a machine started or ended background work; `labels`
   *  empty also when the machine went away (nothing it said holds any more). */
  onMemberBackgroundTasks(listener: (event: MachineMemberBackgroundEvent) => void): () => void {
    return this.modules.machineMessages.onMemberBackgroundTasks(listener);
  }

  /** A member's next-prompt suggestion from the machine that ran its reply. */
  onPromptSuggestion(listener: (event: MachinePromptSuggestionEvent) => void): () => void {
    return this.modules.machineMessages.onPromptSuggestion(listener);
  }

  /** A machine member's live progress, for this window (the phone reads it
   *  from the server, where the machine posts it itself). */
  onProgress(listener: (progress: ReviewProgress) => void): () => void {
    return this.modules.machineMessages.onProgress(listener);
  }

  /** Lets the link check that a picture a machine asks for is in a chat. */
  setConversationLoader(loader: (conversationId: string) => Promise<Conversation | undefined>): void {
    this.modules.machineMessages.setConversationLoader(loader);
  }

  /** Reads the enrolled machines, so the server's roster names them before
   *  any chat activity. */
  loadMachines(): Promise<void> {
    return this.modules.machineConnections.loadMachines();
  }

  start(): Promise<void> {
    return this.modules.machineConnections.start();
  }

  connectMachine(record: MachineRecord, pairingOverride?: MobilePairingPackage): Promise<void> {
    return this.modules.machineConnections.connectMachine(record, pairingOverride);
  }

  /** Closes a machine's connection. It stays enrolled until `forgetMachine`. */
  disconnectMachine(machineId: string): Promise<void> {
    return this.modules.machineConnections.disconnectMachine(machineId);
  }

  /** The machine is no longer enrolled: removed from the app. */
  forgetMachine(machineId: string): Promise<void> {
    return this.modules.machineConnections.forgetMachine(machineId);
  }

  close(): void {
    this.modules.machineConnections.close();
  }

  /** Holds a machine's turns while its runtime is being replaced: the
   *  machine takes no new turn from the User's server meanwhile (they wait
   *  there for the runtime that takes them), and a waiting member's bubble
   *  says why. Each caller gets its own release; turns go on once every
   *  holder let go. */
  holdTurns(machineId: string, reason: string): () => void {
    return this.modules.turnHolds.holdTurns(machineId, reason);
  }

  hasTurnHold(machineId: string): boolean {
    return this.modules.turnHolds.hasTurnHold(machineId);
  }

  /** Why turns asked of this machine wait right now, when this desktop knows. */
  turnWaitReason(machineId: string): string | undefined {
    return this.modules.turnHolds.turnWaitReason(machineId);
  }

  /** Whether this machine's runtime restarts its members' processes, by the
   *  last hello it sent this desktop: "unknown" before any hello, and
   *  "disconnected" while it is not connected (a stopped machine has no
   *  member process to restart). */
  memberRestartSupport(machineId: string): MachineMemberRestartSupport {
    return this.modules.machineSupport.memberRestartSupport(machineId);
  }

  /** Whether a machine (by id, or by the AWS instance it runs on) takes and
   *  hands over members' sessions, by the last hello it sent this desktop,
   *  connected or not: its program changes only through this desktop. */
  sessionMoveTarget(target: { machineId?: string; instanceId?: string }): MachineSessionMoveTarget {
    return this.modules.machineSupport.sessionMoveTarget(target);
  }

  /** Whether a machine starts a main session from a copy of a member's
   *  session in another chat (Fork to new chat), by the last hello it sent
   *  this desktop, connected or not: its program changes only through this
   *  desktop. */
  forkToNewChatSupport(machineId: string): ForkToNewChatMachineSupport {
    return this.modules.machineSupport.forkToNewChatSupport(machineId);
  }

  /** Whether a machine runs Codex's Full Access and Plan mode as the menus
   *  set them, by the last hello it sent this desktop, connected or not: its
   *  program changes only through this desktop. */
  cliModesSupport(machineId: string): CliModesMachineSupport {
    return this.modules.machineSupport.cliModesSupport(machineId);
  }

  /** cliModesSupport of every machine that has greeted this desktop, for the
   *  User's server, which holds a phone's or a machine's turns to it. */
  cliModesByMachine(): Record<string, boolean> {
    return this.modules.machineSupport.cliModesByMachine();
  }

  /** What each CLI on a machine starts a new session in with that machine's
   *  own config, by the last hello it sent this desktop. */
  cliStartDefaults(machineId: string): CliStartDefaultsByKind | undefined {
    return this.modules.machineSupport.cliStartDefaults(machineId);
  }

  /** Ask a machine to do something with its scheduled scripts and wait for
   *  the answer. Ephemeral and sealed to that machine: a key value travels
   *  only here, never on the server or in settings. */
  scriptsRequest(machineId: string, operation: MachineScriptsOperation, timeoutMs = SCRIPTS_REQUEST_TIMEOUT_MS): Promise<unknown> {
    return this.modules.machineScripts.scriptsRequest(machineId, operation, timeoutMs);
  }

  /** Every machine whose scripts this desktop manages, with whether it is
   *  connected now and runs a runtime that hosts scripts. */
  scriptHosts(): MachineScriptHost[] {
    return this.modules.machineScripts.scriptHosts();
  }

  onScriptsChanged(listener: (machineId: string) => void): () => void {
    return this.modules.machineScripts.onScriptsChanged(listener);
  }

  status(): MachineLinkStatus[] {
    return this.modules.machineConnections.status();
  }

  /** The device identity of an enrolled machine as its signed hello or its
   *  setup proved it. */
  machineDeviceId(machineId: string): string | undefined {
    return this.modules.machineConnections.machineDeviceId(machineId);
  }

  /**
   * Machine setup reads the identity of the runtime it installs and records
   * it here: from then on the User's server admits it (the roster names it),
   * and its settings can be sealed for it, although it has not connected yet.
   */
  adoptMachineIdentity(machineId: string, identity: { originId: string; publicKeyDerBase64: string }): Promise<void> {
    return this.modules.machineConnections.adoptMachineIdentity(machineId, identity);
  }

  /** True while any connected machine says it is working. The AWS idle stop
   *  asks this before stopping a box. */
  hasActiveMachineWork(): boolean {
    return this.modules.machineConnections.hasActiveMachineWork();
  }

  /** True while scheduled scripts need a machine awake. Asked about one AWS
   *  instance, only the machines on it count, by what they last said even when
   *  the link is down at that moment; otherwise any connected one. */
  machineKeepsAwake(awsInstanceId?: string): boolean {
    return this.modules.machineConnections.machineKeepsAwake(awsInstanceId);
  }

  /** Every hello a machine sends: a (re)connect, a restart, a status change,
   *  or an answer to `machine.hello.request`. */
  onHello(listener: (event: { machineId: string; appVersion?: string; deviceId?: string }) => void): () => void {
    return this.modules.machineConnections.onHello(listener);
  }

  /** What one machine is doing right now, from a hello it sends on request.
   *  Answered with the last known hello when the machine does not reply in
   *  time, and undefined when it is not enrolled or not connected. */
  machineActivity(machineId: string, options: { fresh?: boolean; timeoutMs?: number } = {}): Promise<MachineActivity | undefined> {
    return this.modules.busyMachines.machineActivity(machineId, options);
  }

  /** True while any connected machine is running a turn, asked afresh. */
  anyMachineBusy(options: { timeoutMs?: number } = {}): Promise<boolean> {
    return this.modules.busyMachines.anyMachineBusy(options);
  }

  isMachineConnected(machineId: string): boolean {
    return this.modules.machineConnections.isMachineConnected(machineId);
  }

  /** This desktop's own way into the machine's room on the User's server is
   *  open, so a machine missing there is missing, not hidden by an outage on
   *  this side. */
  reachesRoom(machineId: string): boolean {
    return this.modules.machineConnections.reachesRoom(machineId);
  }

  /** Whether the machine's program is in touch, as its room says. */
  presenceState(machineId: string): MachineRecoveryLinkState {
    return this.modules.machineConnections.presenceState(machineId);
  }

  /** The enrollment package for a machine, as the installer writes it to the
   *  machine. Read on demand and never held anywhere else. */
  enrollmentJson(machineId: string): Promise<string> {
    return this.modules.enrollments.enrollmentJson(machineId);
  }

  restoreEnrollment(machineId: string, requestedJson: string, installedJson: string, installedMachineId = machineId): Promise<string> {
    return this.modules.enrollments.restoreEnrollment(machineId, requestedJson, installedJson, installedMachineId);
  }

  /** Resolves on the next hello from this machine that arrives after the call
   *  started. With `expectAppVersion` it also requires that hello to report
   *  that version, so an upgrade is only "done" once the new runtime greeted. */
  waitForConnected(machineId: string, timeoutMs: number, expectAppVersion?: string): Promise<boolean> {
    return this.modules.machineConnections.waitForConnected(machineId, timeoutMs, expectAppVersion);
  }

  // --- settings on the User's server ---------------------------------------

  /** The User's server changed (another one, or the link came back): every
   *  machine's settings are put there again. */
  resetPublishedSettings(): void {
    this.modules.settingsPublication.resetPublishedSettings();
  }

  /**
   * Puts the current settings of every machine this desktop set up on the
   * User's server, sealed for that machine alone (called after a settings
   * save, when the server link starts, and when a machine greets). A machine
   * already given exactly these is not given them again. A machine whose key
   * is not known yet is given them once it is (adoptMachineIdentity, hello).
   */
  syncSettings(): Promise<void> {
    return this.modules.settingsPublication.syncSettings();
  }
}

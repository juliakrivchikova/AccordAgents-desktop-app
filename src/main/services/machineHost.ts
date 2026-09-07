/**
 * Machine link, machine side (machines transport, work items 2 and 5).
 *
 * The headless runtime connects to its enrollment room as `machine`, applies
 * the desktop's settings and conversation replicas to its own storage, runs
 * participant turns with the same ChatService the desktop uses, and reports
 * progress and finished messages back to the desktop.
 */

import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MACHINE_LINK_PROTOCOL,
  isMachineLinkEnvelope,
  machineCommandId,
  machineCommandTerminalId,
  type MachineConversationDeltaBody,
  type MachineHelloBody,
  type MachineLinkEnvelope,
  type MachineLinkMessage,
  type MachineTurnFinishedBody,
  type MachineTurnRequestBody
} from "../../shared/machineLink";
import type { MobilePairingPackage } from "../../shared/mobilePairing";
import type { AgentHealth, ChatAppToolApproval, ChatAppToolApprovalPolicy, ChatMessage, Conversation, ReviewProgress } from "../../shared/types";
import type { ChatParticipantRun, ChatService } from "./chat";
import type { DebugLogService } from "./debugLogs";
import { messageBatches, messageStamp } from "./machineLink";
import { advanceInstanceSequence, isStoredTerminal } from "./machineTurnOutcome";
import { openMobileRelayPayload } from "./mobileRelaySealing";
import { deriveMachineChannelKey } from "../../shared/machineChannelKey";
import { openMachineRelayPayload, sealMachineRelayPayload } from "./machineRelaySealing";
import { RelayTunnelClient } from "./relayTunnelClient";
import { MachinePeerFabric } from "./machinePeerFabric";
import { MachineTrustStore } from "./machineTrustStore";
import { signMachineControl, verifyMachineControl, machineControlSender } from "./machineControlAuthentication";
import { stableJson } from "../../shared/stableJson";
import { userDataPath } from "../platform";
import { isMachineTrustRoster, type TrustedPeerAccess } from "../../shared/machineTrust";
import type { SettingsService } from "./settings";
import type { StorageService } from "./storage";
import type { ChatEventLogService } from "./chatEventLog";
import { DeviceEventChannel, type DeferredWithDependency } from "./deviceEventChannel";
import type { DeviceEventApplyOutcome } from "../../shared/deviceEventDelivery";
import { isDeviceEventPacket } from "../../shared/deviceEventChannel";
import { isMachineDurableMessage } from "../../shared/machineLink";
import { NativeProcessUnavailableError } from "./nativeProcess";
import type { ChatEventEnvelope } from "../../shared/chatEvents";
import { machineProgressEventId } from "../../shared/machineProgress";
import { MachineProgressSender } from "./machineProgressSender";
import type { NativeRuntimeIdentity } from "../../shared/nativeCommands";
import { readPosixProcessTableAsync } from "./processTermination";
import { verifyNativeExecutorGone } from "./nativeExecutorRecovery";
import { MachineApprovalExecutor, machineApprovalResultId } from "./machineApprovalExecutor";
import { MachineChoiceExecutor, machineChoiceResultId } from "./chatActionNativeClaims";
import type { ChatActionApplier } from "./chatActionApplier";
import type { ChatActionDependency } from "../../shared/deviceEventChannel";

export interface MachineHostOptions {
  /** Applies chat actions that arrive from the desktop or another machine. */
  chatActions?: ChatActionApplier;
  /** Produces the state a peer says a held action of its own is waiting for,
   *  by re-emitting the action that carries it. */
  serveChatActionDependency?: (dependency: ChatActionDependency) => Promise<boolean>;
  /** Where the trust roster is kept between runs. Defaults to the machine's
   *  own user data directory. */
  trustRosterPath?: string;
  /** True while another deployment on this host has committed an idle stop.
   *  A command that arrives then stays in the durable inbox rather than being
   *  started into an instance that is going away or failed as a turn. */
  hostStopCommitted?: () => boolean;
  /** Test seam: opens a connection to another device's room. */
  createPeerClient?: (room: { relayUrl: string; rendezvousId: string; sealKeyBase64: string; fingerprint?: string; deviceId: string }) => RelayTunnelClient;
  pairing: MobilePairingPackage;
  deviceId: string;
  machineName?: string;
  appVersion: string;
  eventStorage: StorageService;
  eventLog: ChatEventLogService;
  publicKeyDerBase64: string;
  detectProviders?: () => Promise<AgentHealth[]>;
  /** Runs after every settings snapshot import (runtime knobs such as the
   *  CLI run timeout are re-read from the imported settings). */
  onSettingsImported?: () => Promise<void> | void;
  /** The desktop's record id for this machine (from hello.ack): members
   *  whose home is this id are this runtime's own. */
  onDesktopMachineId?: (machineId: string) => void;
  /** File that keeps finished turns until the desktop acknowledges them, so
   *  a result survives a restart of this runtime. In-memory only when unset. */
  outboxPath?: string;
  reconnectDelayMs?: number;
  createClient?: (pairing: MobilePairingPackage) => RelayTunnelClient;
  now?: () => Date;
  nativeProcessDbPath?: string;
  /** Commit idle accounting before a completed native run stops being busy. */
  onNativeActivitySettled?: () => Promise<void>;
  idleStopWarning?: () => string | undefined;
}

/** Conversation metadata the machine owns and never takes from the desktop:
 *  its own provider sessions, run bookkeeping, and the approvals its members
 *  raised (the desktop shows those and sends decisions back). */
const MACHINE_OWNED_METADATA_KEYS = ["participantSessions", "activeRunIds", "running", "runId", "pendingAppToolApprovals"] as const;
/** How soon a failed outbox write is tried again. */
const OUTBOX_RETRY_MS = 30_000;
/** How many times an incomplete first copy is requested again. */
const MAX_RESYNC_ATTEMPTS = 3;

export class MachineHostService {
  private readonly failedDeltaWasSyncing = new Map<string, boolean>();
  private eventChannel!: DeviceEventChannel;
  private readonly client: RelayTunnelClient;
  private readonly now: () => Date;
  private readonly seenMessageIds = new Set<string>();
  private readonly activeTurns = new Map<string, AbortController>();
  /** Finished turns the desktop has not acknowledged (resent on every hello,
   *  kept on disk when an outbox path is configured). */
  private readonly pendingTerminals = new Map<string, MachineTurnFinishedBody>();
  private readonly durableTerminalIds = new Set<string>();
  /** Conversations that have raised approvals; re-forwarded after a reconnect. */
  private readonly approvalConversations = new Set<string>();
  /** Changes when this runtime starts: the desktop tells a restart from a reconnect by it. */
  private readonly instanceId = randomUUID();
  private readonly instanceStartedAt = new Date().toISOString();
  /** Monotonic start counter kept next to the outbox; undefined when it
   *  could not be read or advanced reliably (never published then). */
  private readonly instanceSequence?: number;
  /** Conversations whose first copy (shell + batches) is still arriving:
   *  own rows are compared against the desktop's only once it is complete. */
  private readonly syncing = new Set<string>();
  /** Conversations with a batch of the first copy that could not be stored;
   *  the copy is requested again instead of being declared complete. */
  private readonly failedSync = new Set<string>();
  /** How many times the first copy was requested again per conversation;
   *  a copy that keeps failing (a full disk) is not requested forever. */
  private readonly resyncAttempts = new Map<string, number>();
  /** Turn requests that arrived while a copy of their chat was still being
   *  received: they run once the copy is complete, or fail if it is not. */
  private readonly turnsAwaitingCopy = new Map<string, MachineTurnRequestBody[]>();
  /** True when the outbox file exists but could not be read: it is then
   *  never overwritten, so a result on disk is not lost to a bad read. */
  /** Applies an incoming chat action, or undefined when the event is not one.
   *  `deferred` keeps the event for retry rather than losing the action when
   *  what it refers to has not reached this machine yet. */
  private async applyChatAction(event: ChatEventEnvelope, hydrated?: unknown): Promise<"applied" | "deferred" | DeferredWithDependency | undefined> {
    const applier = this.options.chatActions;
    if (!applier?.handles(event, hydrated)) return undefined;
    const outcome = await applier.apply(event, hydrated);
    if (outcome.detail) {
      void this.debugLogs.write("machine-host.action.applied", {
        kind: outcome.kind, targetKey: outcome.targetKey, status: outcome.status, detail: outcome.detail
      });
    }
    if (outcome.status !== "deferred") return "applied";
    // Named, so the channel can ask the peer for exactly what is missing.
    return outcome.dependency ? { deferred: true, dependency: outcome.dependency } : "deferred";
  }

  applyChoiceAction(event: ChatEventEnvelope, payload: import("../../shared/chatActionEvents").ChatActionPayload): Promise<import("../../shared/machineLink").MachineChoiceResultBody> {
    return this.choiceExecutor.applyAction(event, payload);
  }

  applyApprovalAction(event: ChatEventEnvelope, payload: import("../../shared/chatActionEvents").ChatActionPayload): Promise<import("../../shared/machineLink").MachineApprovalResultBody> {
    return this.approvalExecutor.applyAction(event, payload);
  }

  /** The machine id the enrolling desktop gave this runtime. Members whose
   *  home is this id are the ones it acts for. */
  enrolledMachineId(): string | undefined {
    return this.homeMachineId;
  }

  /** This runtime, as a durable claim names its owner. Shared by every native
   *  admission here so one process cannot appear as two. */
  nativeRuntimeIdentity(): Promise<NativeRuntimeIdentity> {
    return this.getRuntimeIdentity();
  }

  /** False once this machine is draining or fenced for an idle stop: an answer
   *  stays queued rather than being half-applied by a runtime that is going. */
  canApplyNativeEffects(): boolean {
    return !this.draining && !this.idleFenced && !this.closed;
  }

  private outboxUnreadable = false;
  /** Why the outbox is not on disk right now (write failed / unreadable);
   *  travels in hello so the desktop can show it. */
  private outboxError?: string;
  private readonly progressSenders = new Map<string, MachineProgressSender>();
  private readonly progressErrors = new Map<string, string>();
  /** Outbox entries of an unexpected shape: kept (and written back into the
   *  outbox file) until they have been archived for recovery. */
  private rejectedOutboxEntries: unknown[] = [];
  private outboxRetryTimer?: ReturnType<typeof setTimeout>;
  private inbound: Promise<void> = Promise.resolve();
  /** Outbound sends leave in call order (progress before the finished result). */
  private outbound: Promise<void> = Promise.resolve();
  private desktopDeviceId?: string;
  private homeMachineId?: string;
  private readonly settlingRuns = new Map<string, ChatParticipantRun>();
  private readonly settlingInFlight = new Set<string>();
  private unsubscribeRunSettled?: () => void;
  private closed = false;
  private draining = false;
  private idleFenced = false;
  private readonly turnTasks = new Set<Promise<void>>();
  private readonly deletingConversationIds = new Set<string>();
  private readonly activeTurnConversations = new Map<string, string>();
  private readonly commandTasks = new Map<string, Promise<void>>();
  private readonly commandSessions = new Map<string, Promise<void>>();
  private commandRetry?: ReturnType<typeof setTimeout>;
  private runtimeIdentity?: Promise<NativeRuntimeIdentity>;
  private readonly approvalExecutor: MachineApprovalExecutor;
  private readonly choiceExecutor: MachineChoiceExecutor;
  /** The owner's other devices, and the channels to them. Without this a
   *  machine answers only the desktop that enrolled it. */
  private readonly trust: MachineTrustStore;
  private readonly peers: MachinePeerFabric;

  /** approval id -> last status + updatedAt forwarded to the desktop. */
  private readonly forwardedApprovals = new Map<string, string>();
  /** conversation id -> message id -> stamp the desktop is known to hold, so
   *  only changes made on this machine travel back. */
  private readonly knownMessages = new Map<string, Map<string, string>>();

  constructor(
    private readonly chat: Pick<ChatService, "runMachineHostedTurn" | "cancelRun" | "respondToChoice" | "respondToAppToolApproval" | "applyReplicatedConversation"> & Partial<Pick<ChatService, "activeParticipantRuns" | "hasActiveRunForConversation" | "onParticipantRunSettled" | "settledParticipantRunResult" | "runDelegatedParticipantRequest" | "conversationIdForRun" | "closeReplicatedConversationSessions">>,
    private readonly storage: Pick<StorageService, "getConversation"> & Partial<Pick<StorageService, "deleteConversation">>,
    private readonly settings: Pick<SettingsService, "importMachineSettingsSnapshot">,
    private readonly debugLogs: Pick<DebugLogService, "write">,
    private readonly options: MachineHostOptions
  ) {
    this.now = options.now ?? (() => new Date());
    const sequence = this.nextInstanceSequence();
    this.instanceSequence = sequence.sequence;
    if (sequence.error) {
      void this.debugLogs.write("machine-host.instance.unavailable", { message: sequence.error });
    }
    this.loadOutbox();
    const pairing = options.pairing;
    if (!pairing.relayUrl) {
      throw new Error("Machine enrollment has no relay URL.");
    }
    this.client = options.createClient?.(pairing) ?? new RelayTunnelClient({
      relayUrl: pairing.relayUrl,
      rendezvousId: pairing.rendezvousId,
      role: "machine",
      deviceId: options.deviceId,
      capability: pairing.fingerprint,
      streamId: `${pairing.stableRoutingId}:machine`,
      reconnectDelayMs: options.reconnectDelayMs
    });
    this.trust = new MachineTrustStore(
      options.trustRosterPath ?? path.join(userDataPath(), "machine-trust-roster.json"),
      options.deviceId,
      options.pairing.issuer.originId
    );
    // The owner's other devices reach this machine here. Each gets its own
    // sealed channel with its own signing key; anyone else is not answered.
    this.peers = new MachinePeerFabric({
      selfDeviceId: options.deviceId,
      storage: options.eventStorage,
      eventLog: options.eventLog,
      home: pairing,
      homeClient: this.client,
      createClient: (room) => options.createPeerClient?.({ ...room, deviceId: options.deviceId }) ?? new RelayTunnelClient({
        relayUrl: room.relayUrl,
        rendezvousId: room.rendezvousId,
        role: "machine",
        deviceId: options.deviceId,
        // The room's own fingerprint: the relay admits a connection only with
        // the capability the room was opened with.
        capability: room.fingerprint ?? pairing.fingerprint,
        streamId: `${room.rendezvousId}:machine-peer`,
        reconnectDelayMs: options.reconnectDelayMs
      }),
      isPeerConnected: () => true,
      apply: (event, body, peer) => this.applyDeviceEvent(event, body, this.peers.channel(peer.deviceId), peer),
      ...(options.serveChatActionDependency ? {
        serveDependency: async (dependency) => {
          try { return await options.serveChatActionDependency?.(dependency) ?? false; }
          catch { return false; }
        }
      } : {}),
      onError: (error) => { void this.debugLogs.write("machine-host.trust.error", { message: error.message }); },
      logger: (event, payload) => { void this.debugLogs.write(event, payload); }
    });
    this.choiceExecutor = new MachineChoiceExecutor({
      storage: options.eventStorage, deviceId: options.deviceId, chat,
      progress: (progress, conversationId) => this.noteProgress(conversationId, progress),
      runtimeIdentity: () => this.getRuntimeIdentity(), nativeProcessDbPath: options.nativeProcessDbPath,
      canApply: () => this.canApplyNativeEffects(), publish: body => this.send(body)
    });
    this.approvalExecutor = new MachineApprovalExecutor({
      storage: options.eventStorage, deviceId: options.deviceId, chat, getConversation: id => storage.getConversation(id),
      runtimeIdentity: () => this.getRuntimeIdentity(), nativeProcessDbPath: options.nativeProcessDbPath,
      canApply: () => !this.closed && !this.draining && !this.idleFenced,
      publish: body => this.send(body)
    });
    this.client.on("peer", (event) => {
      if (event.type === "ready") {
        // Own link (re)established: greet the desktop again even if it is
        // the same one, so stops and results held meanwhile are reconciled.
        const desktop = event.peers.find((peer) => peer.deviceId === options.pairing.issuer.originId);
        this.setDesktop(desktop?.deviceId, { announce: true });
      } else if (event.type === "peer-connected" && event.peer.deviceId === options.pairing.issuer.originId) {
        this.setDesktop(event.peer.deviceId);
      } else if (event.type === "peer-disconnected" && event.peer.deviceId === options.pairing.issuer.originId) {
        this.desktopDeviceId = undefined;
        void this.debugLogs.write("machine-host.desktop.away", { deviceId: event.peer.deviceId, pendingTerminals: this.pendingTerminals.size });
      }
    });
    // Inbound messages are applied strictly in arrival order: a conversation
    // delta must be stored before the turn request that follows it is read.
    // Turns themselves run detached from the queue (see runTurn).
    this.client.on("message", (message) => {
      this.inbound = this.inbound
        .then(() => this.handleMessage(message.ciphertext))
        .catch((error) => {
          void this.debugLogs.write("machine-host.message.error", { message: errorMessage(error) });
        });
    });
    this.client.on("error", (error) => {
      void this.debugLogs.write("machine-host.tunnel.error", { message: error.message });
    });
    this.unsubscribeRunSettled = this.chat.onParticipantRunSettled?.((run) => {
      if (this.activeTurns.has(run.runId)) {
        return; // The dispatched wrapper owns this result.
      }
      this.settlingRuns.set(run.runId, run);
      return this.finishNativeRun(run);
    });
  }

  private async initializeOwnerChannel(): Promise<void> {
    if (this.eventChannel) return;
    const options = this.options;
    const pairing = options.pairing;
    const identity = await options.eventLog.getOrCreateDeviceIdentity();
    this.eventChannel = new DeviceEventChannel({
      storage: options.eventStorage, eventLog: options.eventLog,
      pairing: { ...pairing, relaySealKeyBase64: deriveMachineChannelKey(identity, pairing.issuer.publicKeyDerBase64, pairing.rendezvousId) },
      isPeerConnected: () => Boolean(this.desktopDeviceId),
      channelId: pairing.rendezvousId, localDeviceId: options.deviceId,
      peerDeviceId: pairing.issuer.originId, peerPublicKeyDerBase64: pairing.issuer.publicKeyDerBase64,
      send: async (packet) => {
        const ciphertext = await sealMachineRelayPayload(packet, identity, pairing.issuer.publicKeyDerBase64, pairing.rendezvousId);
        await this.client.sendCiphertext({ logicalMessageId: randomUUID(), ciphertext, to: pairing.issuer.originId });
      },
      serveDependency: async (dependency) => {
        try { return await options.serveChatActionDependency?.(dependency) ?? false; }
        catch { return false; }
      },
      onDependencyUnavailable: (dependency) => {
        void this.debugLogs.write("machine-host.action.dependency-unavailable", { ...dependency });
      },
      apply: (event, body) => this.applyDeviceEvent(event, body, this.eventChannel),
      onError: (error) => { void this.debugLogs.write("machine-host.events.error", { message: error.message }); }
    });
  }

  async start(): Promise<void> {
    await this.initializeOwnerChannel();
    this.closed = false;
    for (const eventId of await this.options.eventStorage.storedChatEventIds([...this.pendingTerminals.values()].map(terminalEventId))) {
      this.durableTerminalIds.add(eventId);
    }
    for (const state of await this.options.eventStorage.deviceEvents().replicaState(this.options.pairing.rendezvousId)) {
      this.knownMessages.set(state.conversationId, state.messages);
      if (state.syncing) this.syncing.add(state.conversationId);
    }
    const roster = await this.trust.load();
    if (roster) {
      await this.peers.reconcile(this.rosterPeersToConnect(roster.peers));
      void this.debugLogs.write("machine-host.trust.restored", { peers: roster.peers.length, updatedAt: roster.updatedAt });
    }
    this.peers.start();
    await this.reconcileDeletedConversations().catch(error => {
      void this.debugLogs.write("machine-host.conversation.delete-recovery-error", { message: errorMessage(error) });
      this.retryCommands();
    });

    const homeMachineId = await this.options.eventStorage.deviceEvents().hostMachineId(this.options.pairing.rendezvousId);
    if (homeMachineId) {
      this.homeMachineId = homeMachineId;
      this.options.onDesktopMachineId?.(homeMachineId);
      this.eventChannel.start();
      await this.recoverCommands();
    }
    await this.client.connect().catch((error) => {
      void this.debugLogs.write("machine-host.connect.retrying", { message: errorMessage(error) });
    });
  }

  close(): void {
    this.closed = true;
    for (const sender of this.progressSenders.values()) sender.close();
    this.peers.close();
    this.eventChannel?.close();
    this.unsubscribeRunSettled?.();
    if (this.commandRetry) clearTimeout(this.commandRetry);
    if (this.outboxRetryTimer) {
      clearTimeout(this.outboxRetryTimer);
      this.outboxRetryTimer = undefined;
    }
    for (const controller of this.activeTurns.values()) {
      controller.abort();
    }
    this.activeTurns.clear();
    this.client.close();
  }

  /** Keep result delivery alive while providers finish closing. In particular,
   * don't turn a runtime shutdown into a User Stop or exit before the result
   * has entered the durable channel. */
  async shutdown(stopProviders: () => Promise<void>, closeLink = true): Promise<void> {
    this.draining = true;
    for (const waiting of this.turnsAwaitingCopy.values()) {
      for (const request of waiting) await this.finishQueuedTurn(request, "failed", "The machine shut down before this turn started.");
    }
    this.turnsAwaitingCopy.clear();
    await stopProviders();
    while (this.turnTasks.size || (this.approvalExecutor.hasActiveWork() || this.choiceExecutor.hasActiveWork()) || this.settlingInFlight.size || (this.chat.activeParticipantRuns?.().length ?? 0)) {
      // A turn may still be preparing its workspace when shutdown begins.
      // Close an executor created by that preparation before waiting again.
      await stopProviders();
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    for (const run of this.settlingRuns.values()) await this.finishNativeRun(run);
    await this.flushPendingTerminals();
    await this.outbound;
    if ([...this.progressSenders.values()].some(sender => sender.hasPending())) throw new Error("The machine's progress has not been stored; shutdown is not complete.");
    if (this.settlingRuns.size || !this.persistOutbox()) throw new Error("The machine's final results have not been stored; shutdown is not complete.");
    if (closeLink) this.close();
  }

  /** Installed before start() when this boot retained an uncertain AWS Stop.
   * The link can report the warning, but no native or replicated action runs. */
  retainIdleFence(): void { this.idleFenced = true; }

  publishPowerStatus(): Promise<void> { return this.sendHello(); }

  isDesktopConnected(): boolean {
    return Boolean(this.desktopDeviceId);
  }

  /** All work owned by this runtime, including native continuations and
   * incomplete copies. Stored, acknowledged-later results do not keep an idle
   * EC2 box running indefinitely; an unpersisted result does. */
  async hasWorkForIdleStop(): Promise<boolean> {
    if (this.closed || this.draining || this.activeTurns.size || this.turnTasks.size || this.commandTasks.size ||
        this.settlingRuns.size || this.settlingInFlight.size || this.turnsAwaitingCopy.size || this.syncing.size ||
        (this.approvalExecutor.hasActiveWork() || this.choiceExecutor.hasActiveWork()) || (this.chat.activeParticipantRuns?.().length ?? 0) ||
        this.outboxError || this.progressErrors.size || [...this.progressSenders.values()].some(sender => sender.hasPending())) return true;
    if ([...this.pendingTerminals.values()].some(terminal => !this.durableTerminalIds.has(terminalEventId(terminal)))) return true;
    return (await this.options.eventStorage.nativeCommands().pending()).length > 0;
  }

  /** The transient gate makes already received events wait in the durable
   * inbox; they must not fail or be acknowledged as applied during idle drain. */
  async prepareIdleStop(request: {
    bootId: string; uptimeMs: number; idleSinceMs: number;
    fenceNative(): (() => void) | undefined;
    stopProviders(): Promise<void>;
    commitHostStop?(prepareLocal: () => Promise<boolean>): Promise<boolean>;
  }): Promise<(() => Promise<void>) | undefined> {
    if (this.idleFenced || await this.hasWorkForIdleStop()) return undefined;
    this.idleFenced = true;
    let releaseNative: (() => void) | undefined;
    let committed = false;
    try {
      await this.inbound;
      await this.eventChannel.flush();
      if (await this.hasWorkForIdleStop()) return undefined;
      releaseNative = request.fenceNative();
      if (!releaseNative) return undefined;
      const prepareLocal = () => this.options.eventStorage.machinePower().tryFence(request.bootId, request.uptimeMs, randomUUID(), request.idleSinceMs);
      committed = await (request.commitHostStop ? request.commitHostStop(prepareLocal) : prepareLocal());
      if (!committed) return undefined;
      return () => this.shutdown(request.stopProviders, false);
    } catch (error) {
      // An uncertain file/SQLite result is not permission to reopen native
      // work after a durable fence might have committed. Power recovery will
      // reacquire the shared host fence before it can call AWS.
      committed = Boolean(await this.options.eventStorage.machinePower().stopFence(request.bootId).catch(() => "unconfirmed"));
      if (committed) this.uncertainIdleRelease = releaseNative;
      throw error;
    } finally {
      if (!committed) {
        releaseNative?.();
        this.idleFenced = false;
        void this.eventChannel.flush().catch(error => { void this.debugLogs.write("machine-host.idle.resume-error", { message: errorMessage(error) }); });
      }
    }
  }

  private uncertainIdleRelease?: () => void;

  /** A failed fence read is recoverable without restarting the runtime. Only
   * a successful read proving absence permits reopening native admission. */
  async recoverIdleFence(bootId: string): Promise<boolean> {
    if (await this.options.eventStorage.machinePower().stopFence(bootId)) return true;
    this.uncertainIdleRelease?.();
    this.uncertainIdleRelease = undefined;
    this.idleFenced = false;
    void this.eventChannel.flush().catch(error => { void this.debugLogs.write("machine-host.idle.resume-error", { message: errorMessage(error) }); });
    return false;
  }

  /** Called on every conversation mutation on this machine: approvals raised
   *  here (permission prompts, Codex approvals, member requests) are shown on
   *  the desktop, and their outcome travels back the same way. */
  noteConversationSnapshot(conversation: Conversation): void {
    this.forwardMachineMessages(conversation);
    const approvals = (conversation.metadata as { pendingAppToolApprovals?: unknown }).pendingAppToolApprovals;
    if (!Array.isArray(approvals)) {
      return;
    }
    if (approvals.length > 0) {
      this.approvalConversations.add(conversation.id);
    }
    const policies = (conversation.metadata as { appToolApprovalPolicies?: unknown }).appToolApprovalPolicies;
    for (const item of approvals) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const approval = item as ChatAppToolApproval;
      if (typeof approval.id !== "string" || typeof approval.status !== "string") {
        continue;
      }
      const stamp = `${approval.status}\0${approval.updatedAt ?? ""}`;
      const previous = this.forwardedApprovals.get(approval.id);
      if (previous === stamp) {
        continue;
      }
      this.forwardedApprovals.set(approval.id, stamp);
      const body: MachineLinkMessage = previous === undefined && approval.status === "pending"
        ? { type: "machine.approval.requested", conversationId: conversation.id, approval: { ...approval, homeMachineId: this.options.deviceId } }
        : {
            type: "machine.approval.updated",
            conversationId: conversation.id,
            approval: { ...approval, homeMachineId: this.options.deviceId },
            ...(Array.isArray(policies) ? { policies: policies as ChatAppToolApprovalPolicy[] } : {})
          };
      void this.send(body).catch((error) => {
        // The desktop is away; the next snapshot re-sends once it is back.
        this.forwardedApprovals.delete(approval.id);
        void this.debugLogs.write("machine-host.approval.forward-error", { approvalId: approval.id, message: errorMessage(error) });
      });
    }
  }

  private setDesktop(deviceId: string | undefined, options: { announce?: boolean } = {}): void {
    if (!deviceId) {
      return;
    }
    const changed = this.desktopDeviceId !== deviceId;
    this.desktopDeviceId = deviceId;
    if (changed || options.announce) {
      void this.debugLogs.write("machine-host.hello.sending", { reason: options.announce ? "link-ready" : "desktop-changed", deviceId });
      void this.sendHello()
        .then(() => this.flushPendingTerminals())
        .then(() => this.reforwardApprovals())
        .then(() => this.reforwardMachineMessages())
        .catch((error) => {
          void this.debugLogs.write("machine-host.hello.error", { message: errorMessage(error) });
        });
    }
  }

  /** Rows this machine changed while the desktop was away (a reply from a
   *  resume the machine started itself, a note) are offered again on
   *  reconnect; the inventory of what the desktop holds decides what goes. */
  private async reforwardMachineMessages(): Promise<void> {
    for (const run of this.settlingRuns.values()) {
      await this.finishNativeRun(run);
    }
    for (const conversationId of [...this.knownMessages.keys()]) {
      if (this.syncing.has(conversationId)) {
        continue;
      }
      const conversation = await this.storage.getConversation(conversationId);
      if (conversation && conversation.kind === "chat") {
        this.forwardMachineMessages(conversation);
      }
    }
  }

  /** After a reconnect the desktop may have missed approvals raised while it
   *  was away: every approval this machine holds is offered again (the
   *  desktop upserts by id, so repeats are harmless). */
  private async reforwardApprovals(): Promise<void> {
    this.forwardedApprovals.clear();
    for (const conversationId of [...this.approvalConversations]) {
      const conversation = await this.storage.getConversation(conversationId);
      if (conversation && conversation.kind === "chat") {
        this.noteConversationSnapshot(conversation);
      }
    }
  }

  private async sendHello(to?: string): Promise<void> {
    let providers: MachineHelloBody["providers"] = [];
    try {
      const agents = await this.options.detectProviders?.();
      providers = (agents ?? []).map((agent) => ({
        kind: agent.kind,
        installed: agent.installed,
        ...(agent.version ? { version: agent.version } : {})
      }));
    } catch {
      providers = [];
    }
    await this.send({
      type: "machine.hello",
      deviceId: this.options.deviceId,
      machineName: this.options.machineName ?? os.hostname(),
      appVersion: this.options.appVersion,
      platform: `${process.platform}-${process.arch}`,
      providers,
      publicKeyDerBase64: this.options.publicKeyDerBase64,
      activeRunIds: [...new Set([...this.activeTurns.keys(), ...this.queuedRunIds(), ...this.settlingRuns.keys(), ...(this.chat.activeParticipantRuns?.() ?? []).map((run) => run.runId)])],
      pendingTerminalRunIds: [...this.pendingTerminals.keys()],
      instanceId: this.instanceId,
      instanceStartedAt: this.instanceStartedAt,
      ...(typeof this.instanceSequence === "number" ? { instanceSequence: this.instanceSequence } : {}),
      ...((this.outboxError || this.progressErrors.size) ? { outboxError: [this.outboxError, ...this.progressErrors.values()].filter(Boolean).join("; ") } : {}),
      ...(this.options.idleStopWarning?.() ? { idleStopWarning: this.options.idleStopWarning() } : {})
    }, to);
  }

  /**
   * One path for everything a trusted device sends, whichever device it is.
   *
   * The desktop that enrolled this machine is simply the peer whose key is in
   * the enrollment; the owner's other devices arrive here through the roster.
   * Sharing this path is what keeps a turn from being run twice: every command
   * goes through the same durable command record, whoever sent it.
   */
  private async applyDeviceEvent(
    event: ChatEventEnvelope,
    body: unknown,
    channel: DeviceEventChannel | undefined,
    peer?: TrustedPeerAccess
  ): Promise<DeviceEventApplyOutcome | "deferred" | DeferredWithDependency> {
    // Hold commands during a committed stop, but still check current authority
    // before any application when the machine becomes available again.
    if (this.idleFenced || this.options.hostStopCommitted?.()) return "deferred";
    if (peer && stableJson(this.trust.peer(peer.deviceId) ?? null) !== stableJson(peer)) throw new Error("Machine controller authorization changed.");
    if (this.options.chatActions?.handles(event, body) && await this.isConversationDeleted(event.conversationId)) return "applied";
    if ((event.kind === "permission.decided" || event.kind === "choice.answered") && this.options.chatActions?.handles(event, body)) {
      // Delivery to a provider may wait; keep Stop and other chats moving.
      void this.applyChatAction(event, body).then(outcome => {
        if (outcome === "applied") return channel?.confirmApplied(event);
      }).catch(error => {
        void this.debugLogs.write("machine-host.approval.retry-pending", { eventId: event.eventId, message: errorMessage(error) });
      });
      return "deferred";
    }
    // A chat action from any of the owner's devices is applied here as well,
    // so a signature or a superseded change is not something only the sender
    // knows about.
    const action = await this.applyChatAction(event, body);
    if (action) return action;
    const envelope = { protocol: MACHINE_LINK_PROTOCOL, messageId: "event", sentAt: this.now().toISOString(), body };
    if (!isMachineLinkEnvelope(envelope) || !isMachineDurableMessage(envelope.body) ||
        envelope.body.type === "machine.conversation.backdelta" || envelope.body.type === "machine.turn.finished" || envelope.body.type === "machine.turn.started" ||
        envelope.body.type === "machine.approval.requested" || envelope.body.type === "machine.approval.updated" || envelope.body.type === "machine.approval.result" || envelope.body.type === "machine.choice.result" ||
        envelope.body.type === "machine.turn.progress.delta" ||
        !this.peerMayCommand(envelope.body, peer)) {
      throw new Error("Unexpected machine replication event.");
    }
    const conversationId = envelope.body.type === "machine.conversation.sync"
      ? envelope.body.conversation.id
      : "conversationId" in envelope.body ? envelope.body.conversationId : "";
    if (event.kind !== envelope.body.type || event.conversationId !== conversationId) {
      throw new Error("Machine replication event has the wrong chat identity.");
    }
    if (envelope.body.type === "machine.turn.request") {
      await this.acceptCommand(event, envelope.body);
    } else if (envelope.body.type === "machine.approval.decision") {
      if (await this.isConversationDeleted(conversationId)) return "applied";
      // Do not hold the ingress queue while a native decision is delivered:
      // Stop and other conversations must still be able to arrive.
      const decision = envelope.body;
      void this.approvalExecutor.apply(event, decision).then(() => channel?.confirmApplied(event)).catch((error) => {
        void this.debugLogs.write("machine-host.approval.retry-pending", { approvalId: decision.approvalId, message: errorMessage(error) });
      });
      return "deferred";
    } else if (envelope.body.type === "machine.turn.cancel") {
      await this.options.eventStorage.nativeCommands().cancel(envelope.body.runId, conversationId, event.eventId);
      await this.handleBody(envelope.body, true, event);
    } else await this.handleBody(envelope.body, true, event);
    return "applied";
  }

  /**
   * What a device is allowed to ask for, by what it is.
   *
   * Every device in the roster may drive members: send a turn, stop one,
   * answer an approval, deliver chat. Ownership is narrower — settings, the
   * machine's identity and the roster itself come only from the desktop that
   * installed this machine, so no phone or second machine can re-point it.
   * A delegation is the one thing only another machine sends.
   */
  private peerMayCommand(body: MachineLinkMessage, peer?: TrustedPeerAccess): boolean {
    const role = peer?.role ?? "desktop";
    switch (body.type) {
      case "machine.hello.ack":
      case "machine.settings.sync":
      case "machine.settings.sealed":
      case "machine.trust.roster":
        return !peer;
      case "machine.participants.delegate":
        // This machine sends delegations to the member's home; it accepts one
        // only from another machine acting for a member of its own.
        return role === "machine";
      case "machine.turn.request":
        return !peer || !body.sealedSettings;
      default:
        return true;
    }
  }

  private async handleMessage(ciphertext: string): Promise<void> {
    // Content is sealed to these two identities; the room capability grants no reading.
    const payload = await this.openHomeFrame(ciphertext);
    if (isDeviceEventPacket(payload)) {
      // The enrolling desktop keeps its own channel; every other device is
      // answered only if the roster says so.
      if (payload.from === this.options.pairing.issuer.originId) {
        await this.eventChannel.receive(payload);
      } else if (!await this.peers.receive(payload)) {
        void this.debugLogs.write("machine-host.trust.unknown-peer", { from: payload.from, type: payload.type });
      }
      return;
    }
    if (!isMachineLinkEnvelope(payload) || this.seenMessageIds.has(payload.messageId)) {
      return;
    }
    const from = machineControlSender(payload);
    const peer = from === this.options.pairing.issuer.originId ? undefined : this.trust.peer(from ?? "");
    const publicKey = from === this.options.pairing.issuer.originId ? this.options.pairing.issuer.publicKeyDerBase64 : peer?.publicKeyDerBase64;
    if (!from || !publicKey || isMachineDurableMessage(payload.body) || payload.body.type === "machine.settings.sync" ||
        (peer && !["machine.hello.request", "machine.turn.query"].includes(payload.body.type)) ||
        !verifyMachineControl(payload, { from, to: this.options.deviceId,
          room: this.options.pairing.rendezvousId, publicKeyDerBase64: publicKey })) {
      throw new Error("Machine controls require the enrolled sender's signature; actions require durable events.");
    }
    this.seenMessageIds.add(payload.messageId);
    if (this.seenMessageIds.size > 10_000) {
      const first = this.seenMessageIds.values().next().value;
      if (first) {
        this.seenMessageIds.delete(first);
      }
    }
    await this.handleBody(payload.body, false, undefined, from);
  }

  private async openHomeFrame(ciphertext: string): Promise<unknown> {
    const header = JSON.parse(ciphertext) as { senderPublicKeyDerBase64?: unknown };
    if (!header.senderPublicKeyDerBase64) {
      const bootstrap = await openMobileRelayPayload<unknown>(ciphertext, this.options.pairing.relaySealKeyBase64);
      if (isMachineLinkEnvelope(bootstrap) && bootstrap.body.type === "machine.hello.request") return bootstrap;
      throw new Error("Legacy machine content sealing is unsupported; update this device to reconnect.");
    }
    return openMachineRelayPayload(ciphertext, await this.options.eventLog.getOrCreateDeviceIdentity(),
      [this.options.pairing.issuer.publicKeyDerBase64, ...this.trust.peers().map(peer => peer.publicKeyDerBase64)],
      this.options.pairing.rendezvousId);
  }

  private async ownerSealKey(): Promise<string> {
    return deriveMachineChannelKey(await this.options.eventLog.getOrCreateDeviceIdentity(),
      this.options.pairing.issuer.publicKeyDerBase64, this.options.pairing.rendezvousId);
  }

  private async openRetainedSettings(ciphertext: string): Promise<unknown> {
    try { return await openMobileRelayPayload(ciphertext, await this.ownerSealKey()); }
    catch {
      // Pre-upgrade immutable signed events may retain an inner settings
      // cipher. Their outer transport is already pair-sealed and authenticated;
      // reading the historical inner cipher prevents pinning the event stream.
      // Newly emitted settings never use this legacy key.
      return openMobileRelayPayload(ciphertext, this.options.pairing.relaySealKeyBase64);
    }
  }

  private async handleBody(body: MachineLinkMessage, durable = false, event?: ChatEventEnvelope, replyTo = event?.originId): Promise<void> {
    if (this.idleFenced && body.type === "machine.turn.query") return;
    // Old, ephemeral frames cannot bypass the idle fence either. Current
    // peers use the durable inbox and retain these actions until apply.
    if (this.idleFenced && (isMachineDurableMessage(body) || body.type === "machine.settings.sync")) {
      throw new Error("The machine is stopping after idle; this action must remain queued.");
    }
    void this.debugLogs.write("machine-host.message", {
      type: body.type,
      ...("conversationId" in body ? { conversationId: body.conversationId } : {})
    });
    switch (body.type) {
      case "machine.trust.roster": {
        // Only the enrolling desktop reaches this (peerMayCommand), and only
        // inside its own sealed, signed channel.
        if (!event || !isMachineTrustRoster(body.roster)) throw new Error("Machine trust roster requires its signed event.");
        const accepted = await this.trust.accept(body.roster, event);
        await this.peers.reconcile(this.rosterPeersToConnect(accepted.roster.peers));
        void this.debugLogs.write("machine-host.trust.applied", {
          changed: accepted.changed,
          peers: accepted.roster.peers.length,
          updatedAt: accepted.roster.updatedAt
        });
        return;
      }
      case "machine.hello.ack":
        this.desktopDeviceId = body.desktopDeviceId || this.desktopDeviceId;
        if (body.machineId) {
          await this.options.eventStorage.deviceEvents().saveHostMachineId(this.options.pairing.rendezvousId, body.machineId);
          this.homeMachineId = body.machineId;
          this.options.onDesktopMachineId?.(body.machineId);
        }
        this.eventChannel.start();
        await this.recoverCommands();
        return;
      case "machine.hello.request":
        // A (re)started desktop asks to be greeted: the same reconciliation
        // as after a peer change, whether or not the relay reported one.
        if (replyTo && replyTo !== this.options.pairing.issuer.originId) await this.sendHello(replyTo);
        else this.setDesktop(this.options.pairing.issuer.originId, { announce: true });
        return;
      case "machine.settings.sync":
        await this.settings.importMachineSettingsSnapshot(body.snapshot);
        void this.debugLogs.write("machine-host.settings.synced", { exportedAt: body.snapshot.exportedAt });
        await this.options.onSettingsImported?.();
        return;
      case "machine.settings.sealed": {
        if (body.conversationId !== `machine-settings:${this.options.pairing.rendezvousId}`) throw new Error("Settings target the wrong enrolled machine.");
        const snapshot = await this.openRetainedSettings(body.ciphertext);
        await this.settings.importMachineSettingsSnapshot(snapshot as import("../../shared/machineLink").MachineSettingsSnapshot);
        await this.options.onSettingsImported?.();
        return;
      }
      case "machine.conversation.deleted": {
        // The owner deleted the chat. Nothing here may keep running against
        // it, and nothing that arrives later may write it back.
        await this.deleteReplicatedConversation(body.conversationId, body.deletedAt);
        return;
      }
      case "machine.conversation.sync":
        // A snapshot of a chat the owner deleted is stale by definition; it
        // cannot be told apart from a new one except by the tombstone.
        if (await this.isConversationDeleted(body.conversation.id)) {
          void this.debugLogs.write("machine-host.conversation.deleted-copy-refused",
            { conversationId: body.conversation.id, type: body.type });
          return;
        }
        // A fresh copy starts clean: a previous copy's failure is forgotten
        // (the retry budget is not).
        this.failedSync.delete(body.conversation.id);
        this.syncing.add(body.conversation.id);
        if (durable) await this.options.eventStorage.deviceEvents().saveReplicaState(this.options.pairing.rendezvousId, body.conversation.id, { syncing: true });
        await this.applyConversationSync(body.conversation, durable);
        return;
      case "machine.conversation.sync.done": {
        if (await this.isConversationDeleted(body.conversationId)) return;
        if (this.failedSync.has(body.conversationId)) {
          // A batch of this copy was not stored: the copy is not complete,
          // and comparing against it would send stale rows back. Ask again,
          // a bounded number of times; a copy that keeps failing stays
          // incomplete (turns on it fail honestly) instead of looping.
          await this.requestResync(body.conversationId);
          return;
        }
        if (durable) await this.options.eventStorage.deviceEvents().saveReplicaState(this.options.pairing.rendezvousId, body.conversationId, { syncing: false });
        this.resyncAttempts.delete(body.conversationId);
        this.syncing.delete(body.conversationId);
        for (const waiting of this.turnsAwaitingCopy.get(body.conversationId) ?? []) {
          void this.runTurn(waiting);
        }
        this.turnsAwaitingCopy.delete(body.conversationId);
        // Everything the desktop holds is registered now: rows this machine
        // made on its own (offline replies) travel back, nothing else does.
        const stored = await this.storage.getConversation(body.conversationId);
        if (stored && stored.kind === "chat") {
          this.forwardMachineMessages(stored);
        }
        return;
      }
      case "machine.conversation.delta":
        if (await this.isConversationDeleted(body.conversationId)) {
          void this.debugLogs.write("machine-host.conversation.deleted-copy-refused",
            { conversationId: body.conversationId, type: body.type });
          return;
        }
        // Only the desktop's own copy tells this machine what the desktop
        // already holds. A message the phone delivered here is new to the
        // desktop, and recording it as known would mean the desktop never
        // learns what the User asked while it was closed.
        await this.applyConversationDelta(body, durable, replyTo === undefined || replyTo === this.options.pairing.issuer.originId);
        return;
      case "machine.participants.delegate":
        if (await this.isConversationDeleted(body.conversationId)) return;
        // Another machine's member asked for members that live here. Only the
        // ones named are run, and the request message travelled ahead of this.
        await this.chat.runDelegatedParticipantRequest?.({
          conversationId: body.conversationId,
          requestMessageId: body.requestMessageId,
          depth: body.depth,
          ...(body.targetParticipantIds ? { targetParticipantIds: body.targetParticipantIds } : {})
        });
        return;
      case "machine.turn.request":
        if (this.activeTurns.has(body.runId) || this.pendingTerminals.has(body.runId) || this.isQueuedRun(body.runId)) return;
        if (await this.isConversationDeleted(body.conversationId)) {
          await this.finishQueuedTurn(body, "failed", "This chat was deleted; the turn did not run.");
          return;
        }
        if (this.draining) {
          await this.finishQueuedTurn(body, "failed", "The machine is shutting down; this turn did not start.");
          return;
        }
        if (this.failedSync.has(body.conversationId)) {
          // A batch of this chat's copy could not be stored; an honest
          // failure beats running a member against half a chat.
          await this.failTurnOnIncompleteCopy(body);
          return;
        }
        if (this.syncing.has(body.conversationId)) {
          // The copy is still arriving (a reconnect re-sent it while this
          // request was in flight): the turn runs when the copy is complete.
          const waiting = this.turnsAwaitingCopy.get(body.conversationId) ?? [];
          waiting.push(body);
          this.turnsAwaitingCopy.set(body.conversationId, waiting);
          void this.debugLogs.write("machine-host.turn.awaiting-copy", { conversationId: body.conversationId, runId: body.runId });
          return;
        }
        void this.runTurn(body);
        return;
      case "machine.turn.query":
        if (await this.options.eventStorage.nativeCommands().forRun(body.runId)) {
          await this.repeatCommandResult(body.runId);
          await this.recoverCommands();
          return;
        }
        if (!this.activeTurns.has(body.runId) && !this.pendingTerminals.has(body.runId) && !this.isQueuedRun(body.runId) && !this.settlingRuns.has(body.runId) && !this.chat.hasActiveRunForConversation?.(body.conversationId, body.runId)) {
          await this.send({ type: "machine.turn.unknown", conversationId: body.conversationId, runId: body.runId }, replyTo).catch(() => undefined);
        }
        return;
      case "machine.turn.cancel": {
        const queued = this.takeQueuedRun(body.runId);
        if (queued) {
          // Stopped before it ever started: nothing ran, so this is a
          // confirmed interruption, and the copy's completion must not
          // start it later.
          await this.finishQueuedTurn(queued, "interrupted");
          return;
        }
        const controller = this.activeTurns.get(body.runId);
        const command = await this.options.eventStorage.nativeCommands().forRun(body.runId);
        if (!controller && command) {
          if (command.phase === "queued") {
            const event = await this.options.eventStorage.getChatEvent(command.eventId);
            if (!event) throw new Error("The queued native command has lost its request.");
            const request = await this.options.eventStorage.deviceEventBlobs().hydrate(event.payload) as MachineTurnRequestBody;
            await this.finishQueuedTurn(request, "interrupted");
            return;
          }
          // Approval resumes can be owned directly by ChatService, even when
          // the original dispatch wrapper has already returned its result.
          if (this.chat.cancelRun(body.runId)) return;
          await this.repeatCommandResult(body.runId);
          await this.recoverCommands();
          return;
        }
        if (!controller && !this.pendingTerminals.has(body.runId) && !this.settlingRuns.has(body.runId) && !this.chat.hasActiveRunForConversation?.(body.conversationId, body.runId)) {
          // Not running here and no result waiting: this runtime cannot
          // confirm anything about it (Rule 2), so it says so.
          await this.send({ type: "machine.turn.unknown", conversationId: body.conversationId, runId: body.runId }, replyTo).catch(() => undefined);
          return;
        }
        controller?.abort();
        this.chat.cancelRun(body.runId);
        return;
      }
      case "machine.turn.finished.ack": {
        // The acknowledgement can win the race with this runtime's index
        // write, or arrive after a crash lost the legacy JSON outbox. Repair
        // the local receipt pointer before acknowledging this durable event.
        const eventId = `machine-terminal:${body.receiptId ?? `${body.runId}:${body.finishedAt}`}`;
        const event = await this.options.eventStorage.getChatEvent(eventId);
        if (event && event.originId === this.options.deviceId && event.kind === "machine.turn.finished" && event.conversationId === body.conversationId &&
            event.logScopeId === `device:${this.options.pairing.rendezvousId}:${JSON.stringify([body.conversationId, `terminal:${body.runId}`])}`) {
          await this.options.eventStorage.nativeCommands().recordOutcome(body.runId, eventId);
          if (body.receiptId === machineCommandId(body.runId) && await this.options.eventStorage.nativeCommands().forRun(body.runId)) {
            await this.options.eventStorage.nativeCommands().finish(machineCommandId(body.runId));
          }
        }
        const stored = this.pendingTerminals.get(body.runId);
        if (stored && stored.conversationId === body.conversationId &&
            stored.receiptId === body.receiptId && stored.finishedAt === body.finishedAt) {
          this.pendingTerminals.delete(body.runId);
          if (!this.persistOutbox()) {
            this.pendingTerminals.set(body.runId, stored);
            throw new Error("The machine could not persist the terminal acknowledgement.");
          }
          this.durableTerminalIds.delete(terminalEventId(stored));
          void this.debugLogs.write("machine-host.terminal.acked", { runId: body.runId, at: this.now().toISOString() });
        }
        return;
      }
      case "machine.approval.decision": {
        // The whole card answer is applied here exactly as the desktop's own
        // approval path would; the outcome (or the error) goes back so the
        // desktop's card call fails visibly instead of silently.
        const outcome = await this.chat.respondToAppToolApproval({
          conversationId: body.conversationId,
          approvalId: body.approvalId,
          approve: body.approve,
          ...(body.scope ? { scope: body.scope } : {}),
          ...(body.draftOverride ? { draftOverride: body.draftOverride } : {}),
          ...(body.codexDecisionId ? { codexDecisionId: body.codexDecisionId } : {})
        }).then((conversation) => {
          const approvals = (conversation?.metadata as { pendingAppToolApprovals?: ChatAppToolApproval[] } | undefined)?.pendingAppToolApprovals ?? [];
          const approval = approvals.find((item) => item.id === body.approvalId);
          const policies = (conversation?.metadata as { appToolApprovalPolicies?: ChatAppToolApprovalPolicy[] } | undefined)?.appToolApprovalPolicies;
          void this.debugLogs.write("machine-host.approval.decision-applied", {
            approvalId: body.approvalId,
            approve: body.approve,
            status: approval?.status
          });
          if (conversation) {
            this.noteConversationSnapshot(conversation);
          }
          return { ok: true as const, approval, policies };
        }).catch((error: unknown) => {
          void this.debugLogs.write("machine-host.approval.decision-error", { approvalId: body.approvalId, message: errorMessage(error) });
          return { ok: false as const, error: errorMessage(error) };
        });
        await this.send({
          type: "machine.approval.result",
          conversationId: body.conversationId,
          approvalId: body.approvalId,
          ok: outcome.ok,
          ...(outcome.ok
            ? {
                ...(outcome.approval ? { approval: { ...outcome.approval, homeMachineId: this.options.deviceId } } : {}),
                ...(Array.isArray(outcome.policies) ? { policies: outcome.policies } : {})
              }
            : { error: outcome.error })
        }).catch(() => undefined);
        return;
      }
      default:
        return;
    }
  }

  /** Messages created or changed by turns that started on this machine
   *  (resumes after approvals, member-request runs) reach the desktop as a
   *  back delta; messages the desktop sent here are never echoed. */
  private forwardMachineMessages(conversation: Conversation): void {
    const known = this.knownMessages.get(conversation.id);
    if (!known || this.syncing.has(conversation.id)) {
      return;
    }
    const changed = conversation.messages.filter((message) => known.get(message.id) !== messageStamp(message));
    if (changed.length === 0) {
      return;
    }
    for (const message of changed) {
      known.set(message.id, messageStamp(message));
    }
    // Bounded batches, like every other message list on this link.
    for (const batch of messageBatches(changed)) {
      void this.send({
        type: "machine.conversation.backdelta",
        conversationId: conversation.id,
        messages: batch,
        updatedAt: conversation.updatedAt
      }).catch((error) => {
        for (const message of batch) {
          known.delete(message.id);
        }
        void this.debugLogs.write("machine-host.backdelta.error", { conversationId: conversation.id, message: errorMessage(error) });
      });
    }
  }

  /** Registers what the desktop holds; returns the previous stamps of the
   *  touched ids so a failed apply can put the inventory back. */
  private rememberDesktopMessages(conversationId: string, messages: ChatMessage[], removedIds: string[] = []): Map<string, string | undefined> {
    const known = this.knownMessages.get(conversationId) ?? new Map<string, string>();
    const previous = new Map<string, string | undefined>();
    for (const message of messages) {
      previous.set(message.id, known.get(message.id));
      known.set(message.id, messageStamp(message));
    }
    for (const id of removedIds) {
      previous.set(id, known.get(id));
      known.delete(id);
    }
    this.knownMessages.set(conversationId, known);
    return previous;
  }

  private async saveIncomingInventory(conversationId: string, messages: ChatMessage[], removedIds?: string[]): Promise<void> {
    await this.options.eventStorage.deviceEvents().saveReplicaState(this.options.pairing.rendezvousId, conversationId, {
      stamps: new Map(messages.map((message) => [message.id, messageStamp(message)])), removedIds
    });
  }

  private async applyConversationSync(incoming: Conversation, durable = false): Promise<void> {
    // The desktop's copy is registered before it is applied, so the snapshot
    // the apply emits never echoes it back as a back delta. The inventory of
    // what the desktop holds is kept across syncs: a fresh copy after a
    // reconnect arrives as a shell plus batches, and a shell must not make
    // every stored row look new.
    const previousStamps = this.rememberDesktopMessages(incoming.id, incoming.messages);
    try {
      await this.applyConversationShell(incoming);
      if (durable) await this.saveIncomingInventory(incoming.id, incoming.messages);
    } catch (error) {
      this.restoreInventory(incoming.id, previousStamps);
      this.failedSync.add(incoming.id);
      void this.debugLogs.write("machine-host.sync.batch-failed", { conversationId: incoming.id, stage: "shell", message: errorMessage(error) });
      if (durable) throw error;
      return;
    }
    void this.debugLogs.write("machine-host.conversation.synced", { conversationId: incoming.id, messages: incoming.messages.length });
  }

  private async applyConversationShell(incoming: Conversation): Promise<void> {
    await this.chat.applyReplicatedConversation(incoming.id, (existing) => {
      const metadata = existing ? this.mergeMetadata(existing, incoming.metadata) : this.stripMachineOwned(incoming.metadata);
      // A fresh copy after a reconnect must not erase what this machine
      // produced meanwhile: the desktop's messages win by id, ours are kept,
      // and a reply finished here is never demoted by a stale pending bubble.
      const messages = mergeReplicatedMessages(existing?.messages ?? [], incoming.messages, [], this.ownedParticipantIds(existing ?? incoming));
      return { ...incoming, messages, metadata };
    });
  }

  /**
   * Deletes this machine's copy of a chat the owner deleted.
   *
   * Order matters and is the whole point: nothing native may still be running
   * against it, the providers it holds have to be actually closed, and the
   * tombstone is written before the rows go — a crash between the two must
   * leave the chat deletable, never resurrectable.
   */
  private async deleteReplicatedConversation(conversationId: string, deletedAt: string): Promise<void> {
    this.deletingConversationIds.add(conversationId);
    const tombstones = this.options.eventStorage.conversationTombstones();
    await tombstones.mark(conversationId, deletedAt);
    this.syncing.delete(conversationId);
    this.failedSync.delete(conversationId);
    const waiting = this.turnsAwaitingCopy.get(conversationId) ?? [];
    this.turnsAwaitingCopy.delete(conversationId);
    this.knownMessages.delete(conversationId);
    // Anything of this chat still in flight is stopped and waited for. A
    // provider left running against a deleted chat is exactly the process
    // nobody would ever come looking for.
    for (const [runId, controller] of this.activeTurns) {
      if (this.activeTurnConversations.get(runId) === conversationId || this.chat.conversationIdForRun?.(runId) === conversationId) controller.abort();
    }
    for (const request of waiting) await this.finishQueuedTurn(request, "failed", "This chat was deleted; the turn did not run.");
    if (!this.chat.closeReplicatedConversationSessions || !this.storage.deleteConversation) {
      throw new Error("The machine cannot prove that this chat's providers and stored copy were deleted.");
    }
    await this.chat.closeReplicatedConversationSessions(conversationId);
    if (this.storage.deleteConversation) {
      await this.storage.deleteConversation(conversationId).catch((error: unknown) => {
        void this.debugLogs.write("machine-host.conversation.delete-error", { conversationId, message: errorMessage(error) });
        throw error;
      });
    }
    // The owner's other devices need the same absence. Retained fanout uses
    // one stable event; replay after a crash cannot create a delete loop.
    await this.send({ type: "machine.conversation.deleted", conversationId, deletedAt: (await tombstones.deletedAt(conversationId))! });
    void this.debugLogs.write("machine-host.conversation.deleted", { conversationId, deletedAt });
  }

  private async isConversationDeleted(conversationId: string): Promise<boolean> {
    const deleted = await this.options.eventStorage.conversationTombstones().isDeleted(conversationId);
    return deleted || this.deletingConversationIds.has(conversationId);
  }

  private async reconcileDeletedConversations(): Promise<void> {
    for (;;) {
      const pending = await this.options.eventStorage.conversationTombstones().pendingCopies();
      for (const row of pending) await this.deleteReplicatedConversation(row.conversationId, row.deletedAt);
      if (pending.length < 100) return;
    }
  }

  private async applyConversationDelta(delta: MachineConversationDeltaBody, durable = false, fromDesktop = true): Promise<void> {
    const previousStamps = fromDesktop
      ? this.rememberDesktopMessages(delta.conversationId, delta.messages, delta.removedMessageIds ?? [])
      : new Map<string, string | undefined>();
    let missing = false;
    try {
      await this.chat.applyReplicatedConversation(delta.conversationId, (existing) => {
        if (!existing) {
          missing = true;
          return undefined;
        }
        const messages = mergeReplicatedMessages(existing.messages, delta.messages, delta.removedMessageIds ?? [], this.ownedParticipantIds(existing));
        const metadata = delta.metadata ? this.mergeMetadata(existing, delta.metadata) : existing.metadata;
        return { ...existing, messages, metadata, updatedAt: delta.updatedAt };
      });
      if (durable && !missing) await this.saveIncomingInventory(delta.conversationId, delta.messages, delta.removedMessageIds);
    } catch (error) {
      // The inventory must describe what is stored, not what was attempted:
      // the batch's stamps are reverted, and a first copy in progress is
      // asked for again when its sync.done arrives.
      this.restoreInventory(delta.conversationId, previousStamps);
      void this.debugLogs.write("machine-host.sync.batch-failed", { conversationId: delta.conversationId, stage: "delta", messages: delta.messages.length, message: errorMessage(error) });
      // The copy is incomplete from now on, whether or not a first copy was
      // in progress: turns on it fail until a fresh copy completes. Outside
      // a first copy there is no sync.done to trigger the request, so it is
      // made here (same bounded budget).
      this.failedSync.add(delta.conversationId);
      if (durable) {
        if (!this.failedDeltaWasSyncing.has(delta.conversationId)) this.failedDeltaWasSyncing.set(delta.conversationId, this.syncing.has(delta.conversationId));
        this.syncing.add(delta.conversationId);
        throw error;
      }
      if (!this.syncing.has(delta.conversationId)) {
        this.syncing.add(delta.conversationId);
        await this.requestResync(delta.conversationId);
      }
      return;
    }
    if (missing) {
      void this.debugLogs.write("machine-host.conversation.delta-without-copy", { conversationId: delta.conversationId });
      if (durable) throw new Error("The replicated chat shell is missing.");
    }
    if (durable) {
      this.failedSync.delete(delta.conversationId);
      if (this.failedDeltaWasSyncing.get(delta.conversationId) === false) this.syncing.delete(delta.conversationId);
      this.failedDeltaWasSyncing.delete(delta.conversationId);
    }
  }

  private async requestResync(conversationId: string): Promise<void> {
    // Turns waiting for this copy cannot run on it any more.
    for (const waiting of this.turnsAwaitingCopy.get(conversationId) ?? []) {
      await this.failTurnOnIncompleteCopy(waiting);
    }
    this.turnsAwaitingCopy.delete(conversationId);
    const attempts = (this.resyncAttempts.get(conversationId) ?? 0) + 1;
    this.resyncAttempts.set(conversationId, attempts);
    if (attempts > MAX_RESYNC_ATTEMPTS) {
      void this.debugLogs.write("machine-host.sync.gave-up", { conversationId, attempts });
      return;
    }
    void this.debugLogs.write("machine-host.sync.resync", { conversationId, attempt: attempts });
    await this.send({ type: "machine.conversation.resync", conversationId }).catch(() => undefined);
  }

  private ownedParticipantIds(conversation: Conversation): ReadonlySet<string> {
    const participants = (conversation.metadata as { participants?: Array<{ id: string; homeMachineId?: string }> }).participants ?? [];
    return new Set(participants.filter((participant) => this.homeMachineId && participant.homeMachineId === this.homeMachineId).map((participant) => participant.id));
  }

  private async failTurnOnIncompleteCopy(request: MachineTurnRequestBody): Promise<void> {
    await this.finishQueuedTurn(request, "failed", "This machine's copy of the chat is not complete yet (a sync batch could not be stored); try again once it has synced.");
  }

  /** A turn that never started (stopped while waiting for the copy, or the
   *  copy failed) still gets a stored, acknowledged result. */
  private async finishQueuedTurn(request: MachineTurnRequestBody, status: "interrupted" | "failed", error?: string): Promise<void> {
    const command = await this.options.eventStorage.nativeCommands().forRun(request.runId);
    if (command && await this.options.eventStorage.getChatEvent(command.terminalEventId)) {
      await this.options.eventStorage.nativeCommands().finish(command.commandId);
      return;
    }
    // Stop, shutdown and admission recovery may finish the same queued run.
    // Preserve the first receipt (including its finish time) through a failed
    // write; regenerating it would conflict with its immutable event on retry.
    if (this.pendingTerminals.has(request.runId)) {
      await this.flushPendingTerminals();
      return;
    }
    const messages = await this.options.eventStorage.machineProgress().retainPartialForOutcome({
      runId: request.runId, participantId: request.participantId, status, messages: []
    });
    this.pendingTerminals.set(request.runId, {
      type: "machine.turn.finished",
      receiptId: command?.commandId ?? randomUUID(),
      conversationId: request.conversationId,
      runId: request.runId,
      participantId: request.participantId,
      status,
      messages,
      warnings: [],
      ...(error ? { error } : {}),
      finishedAt: this.now().toISOString()
    });
    this.persistOutbox();
    await this.flushPendingTerminals();
  }

  private queuedRunIds(): string[] {
    return [...this.turnsAwaitingCopy.values()].flat().map((request) => request.runId);
  }

  private isQueuedRun(runId: string): boolean {
    return this.queuedRunIds().includes(runId);
  }

  private takeQueuedRun(runId: string): MachineTurnRequestBody | undefined {
    for (const [conversationId, waiting] of this.turnsAwaitingCopy.entries()) {
      const index = waiting.findIndex((request) => request.runId === runId);
      if (index >= 0) {
        const [request] = waiting.splice(index, 1);
        if (waiting.length === 0) {
          this.turnsAwaitingCopy.delete(conversationId);
        }
        return request;
      }
    }
    return undefined;
  }

  private restoreInventory(conversationId: string, previous: Map<string, string | undefined>): void {
    const known = this.knownMessages.get(conversationId);
    if (!known) {
      return;
    }
    for (const [id, stamp] of previous) {
      if (stamp === undefined) {
        known.delete(id);
      } else {
        known.set(id, stamp);
      }
    }
  }

  private mergeMetadata(existing: Conversation, incoming: Conversation["metadata"]): Conversation["metadata"] {
    const merged: Record<string, unknown> = { ...this.stripMachineOwned(incoming) };
    const own = existing.metadata as unknown as Record<string, unknown>;
    for (const key of MACHINE_OWNED_METADATA_KEYS) {
      if (own[key] !== undefined) {
        merged[key] = own[key];
      }
    }
    // Chat-wide approval policies granted on either side apply on both:
    // union by id, the newer record wins.
    const incomingPolicies = Array.isArray((incoming as { appToolApprovalPolicies?: unknown }).appToolApprovalPolicies)
      ? (incoming as { appToolApprovalPolicies: ChatAppToolApprovalPolicy[] }).appToolApprovalPolicies
      : [];
    const ownPolicies = Array.isArray(own.appToolApprovalPolicies) ? own.appToolApprovalPolicies as ChatAppToolApprovalPolicy[] : [];
    if (incomingPolicies.length > 0 || ownPolicies.length > 0) {
      const byId = new Map<string, ChatAppToolApprovalPolicy>();
      for (const policy of [...incomingPolicies, ...ownPolicies]) {
        const current = byId.get(policy.id);
        if (!current || (policy.updatedAt ?? "") > (current.updatedAt ?? "")) {
          byId.set(policy.id, policy);
        }
      }
      merged.appToolApprovalPolicies = [...byId.values()];
    }
    return merged as Conversation["metadata"];
  }

  private stripMachineOwned(metadata: Conversation["metadata"]): Conversation["metadata"] {
    const copy: Record<string, unknown> = { ...(metadata as unknown as Record<string, unknown>) };
    for (const key of MACHINE_OWNED_METADATA_KEYS) {
      delete copy[key];
    }
    return copy as Conversation["metadata"];
  }

  private runTurn(request: MachineTurnRequestBody): Promise<void> {
    const previous = this.commandTasks.get(request.runId);
    if (previous) return previous;
    const scope = `${request.conversationId}:${request.participantId}`;
    const task = (this.commandSessions.get(scope) ?? Promise.resolve()).catch(() => undefined).then(() => this.admitTurn(request));
    this.commandSessions.set(scope, task);
    this.commandTasks.set(request.runId, task);
    this.turnTasks.add(task);
    void task.finally(() => {
      this.turnTasks.delete(task); this.commandTasks.delete(request.runId);
      if (this.commandSessions.get(scope) === task) this.commandSessions.delete(scope);
    }).catch((error) => {
      void this.debugLogs.write("machine-host.turn.not-stored", { runId: request.runId, message: errorMessage(error) });
      this.retryCommands();
    });
    return task;
  }

  private async acceptCommand(event: ChatEventEnvelope, request: MachineTurnRequestBody): Promise<void> {
    if (event.eventId !== machineCommandId(request.runId) || request.participant.id !== request.participantId) {
      throw new Error("The native command has inconsistent identities.");
    }
    if (!this.homeMachineId) throw new Error("This machine's enrolled identity is not available yet.");
    await this.options.eventStorage.nativeCommands().accept({
      commandId: event.eventId, eventId: event.eventId, conversationId: request.conversationId,
      participantId: request.participantId, runId: request.runId, terminalEventId: machineCommandTerminalId(request.runId)
    });
    if (request.participant.homeMachineId !== this.homeMachineId) {
      await this.finishQueuedTurn(request, "failed", "This participant's home is not this machine; the command did not run.");
      return;
    }
    // Admission is durable before acknowledging the event. Execution is
    // independent of the receiver queue, so Stop can arrive during the turn.
    await this.handleBody(request, true);
  }

  private getRuntimeIdentity(): Promise<NativeRuntimeIdentity> {
    const identity = this.runtimeIdentity ??= (async () => {
      const identity = (await readPosixProcessTableAsync())?.get(process.pid);
      if (!identity) throw new Error("This runtime's process identity could not be verified.");
      return { runtimeId: this.instanceId, pid: identity.pid, startedAt: identity.startedAt };
    })();
    void identity.catch(() => { if (this.runtimeIdentity === identity) this.runtimeIdentity = undefined; });
    return identity;
  }

  private async admitTurn(request: MachineTurnRequestBody): Promise<void> {
    if (this.closed) return;
    // Recheck at admission, after any earlier turn in this participant's
    // queue. The receive-time check may have preceded deletion by minutes.
    if (await this.isConversationDeleted(request.conversationId)) {
      return this.finishQueuedTurn(request, "failed", "This chat was deleted; the turn did not run.");
    }
    const commands = this.options.eventStorage.nativeCommands();
    const command = await commands.forRun(request.runId);
    if (!command) {
      // Direct requests remain only for the pre-cutover protocol fixtures.
      if (this.draining) return this.finishQueuedTurn(request, "failed", "The machine shut down before this turn started.");
      return this.executeTurn(request);
    }
    const storedTerminal = await this.options.eventStorage.getChatEvent(command.terminalEventId);
    if (storedTerminal) {
      await commands.finish(command.commandId);
      return;
    }
    if (command.phase === "finished") throw new Error("A finished native command has lost its terminal event.");
    if (this.draining) return this.finishQueuedTurn(request, "failed", "The machine shut down before this turn started.");
    const owner = await this.getRuntimeIdentity();
    const executor = await commands.executor(command.conversationId, command.participantId);
    if (executor && !executor.released && executor.runtimeId !== owner.runtimeId) {
      if (!this.options.nativeProcessDbPath || !await verifyNativeExecutorGone(executor, this.options.nativeProcessDbPath)) {
        throw new NativeProcessUnavailableError("Waiting for the previous native executor's verified shutdown.");
      }
      await commands.releaseVerifiedExecutor(executor);
    }
    if (command.phase === "claimed") {
      // Input may have reached the CLI before the app died. Never replay it;
      // its surviving guardian must close before this failure is reported.
      return this.finishQueuedTurn(request, "failed", "The machine runtime ended after accepting this command; its execution outcome is uncertain and it was not run again.");
    }
    if (command.cancelled) return this.finishQueuedTurn(request, "interrupted");
    const conversation = await this.storage.getConversation(request.conversationId);
    const participants = (conversation?.metadata as { participants?: Array<{ id: string; homeMachineId?: string }> } | undefined)?.participants;
    if (participants?.find(participant => participant.id === request.participantId)?.homeMachineId !== this.homeMachineId) {
      return this.finishQueuedTurn(request, "failed", "This participant no longer belongs to this machine; the command did not run.");
    }
    const claimed = await commands.claim(command.commandId, owner);
    if (!claimed) throw new Error("The command is cancelled or owned by another runtime; admission will be reconciled.");
    if ((await commands.forRun(request.runId))?.cancelled) return this.finishQueuedTurn(request, "interrupted");
    if (this.closed) return;
    await this.send({ type: "machine.turn.started", conversationId: request.conversationId, runId: request.runId, startedAt: this.now().toISOString() });
    if (this.closed) return;
    if ((await commands.forRun(request.runId))?.cancelled) return this.finishQueuedTurn(request, "interrupted");
    return this.executeTurn(request);
  }

  private async recoverCommands(): Promise<void> {
    if (this.closed || this.draining || this.idleFenced || !this.homeMachineId) return;
    let cursor: { commandId: string; logicalTs: string } | undefined;
    for (;;) {
      const commands = await this.options.eventStorage.nativeCommands().pending(cursor);
      for (const command of commands) {
        const event = await this.options.eventStorage.getChatEvent(command.eventId);
        if (!event?.logScopeId.startsWith(`device:${this.options.pairing.rendezvousId}:`)) continue;
        const body = await this.options.eventStorage.deviceEventBlobs().hydrate(event.payload) as MachineTurnRequestBody;
        if (body.type !== "machine.turn.request" || body.runId !== command.runId) throw new Error("The retained native command is corrupt.");
        if (!this.activeTurns.has(body.runId) && !this.commandTasks.has(body.runId) && !this.isQueuedRun(body.runId)) {
          await this.handleBody(body, true);
        }
      }
      if (commands.length < 100) break;
      cursor = commands[commands.length - 1];
    }
  }

  private async repeatCommandResult(runId: string): Promise<void> {
    const commands = this.options.eventStorage.nativeCommands();
    const eventId = await commands.latestOutcome(runId) ?? (await commands.forRun(runId))?.terminalEventId;
    if (!eventId) return;
    const event = await this.options.eventStorage.getChatEvent(eventId);
    if (!event) return;
    const body = await this.options.eventStorage.deviceEventBlobs().hydrate(event.payload) as MachineTurnFinishedBody;
    // A new delivery references the same immutable execution receipt. The
    // original delivery may already be acknowledged before a late Stop arrives.
    await this.eventChannel.publish({ conversationId: body.conversationId, kind: body.type, payload: body,
      eventId: `machine-reconcile:${event.eventId}`, scope: `terminal:${runId}` });
  }

  private retryCommands(): void {
    if (this.commandRetry || this.closed || this.draining) return;
    this.commandRetry = setTimeout(() => {
      this.commandRetry = undefined;
      void this.reconcileDeletedConversations().then(() => this.recoverCommands()).catch((error) => {
        void this.debugLogs.write("machine-host.command.recovery-error", { message: errorMessage(error) });
        this.retryCommands();
      });
    }, 1000);
    this.commandRetry.unref();
  }

  private async executeTurn(request: MachineTurnRequestBody): Promise<void> {
    if (await this.isConversationDeleted(request.conversationId)) {
      return this.finishQueuedTurn(request, "failed", "This chat was deleted; the turn did not run.");
    }
    const controller = new AbortController();
    this.activeTurns.set(request.runId, controller);
    this.activeTurnConversations.set(request.runId, request.conversationId);
    const progress = (update: ReviewProgress): void => {
      this.noteProgress(request.conversationId, update);
    };
    let terminal: MachineTurnFinishedBody;
    try {
      if (request.sealedSettings) {
        const snapshot = await this.openRetainedSettings(request.sealedSettings);
        await this.settings.importMachineSettingsSnapshot(snapshot as import("../../shared/machineLink").MachineSettingsSnapshot);
        await this.options.onSettingsImported?.();
      }
      if (controller.signal.aborted || await this.isConversationDeleted(request.conversationId)) {
        throw new Error("This chat was deleted or its turn was cancelled before admission.");
      }
      const result = await this.chat.runMachineHostedTurn(
        {
          conversationId: request.conversationId,
          participantId: request.participantId,
          messageId: request.messageId,
          runId: request.runId,
          pendingMessageId: request.pendingMessageId
        },
        controller.signal,
        progress
      );
      terminal = {
        type: "machine.turn.finished",
        conversationId: request.conversationId,
        runId: request.runId,
        participantId: request.participantId,
        status: result.messages.some((message) => message.metadata?.terminalReason === "stop-unconfirmed") ? "failed"
          : controller.signal.aborted ? "interrupted" : result.messages.some((message) => message.status === "error") ? "failed" : "completed",
        messages: result.messages,
        warnings: result.warnings,
        finishedAt: this.now().toISOString()
      };
    } catch (error) {
      terminal = {
        type: "machine.turn.finished",
        conversationId: request.conversationId,
        runId: request.runId,
        participantId: request.participantId,
        status: controller.signal.aborted && !(error instanceof NativeProcessUnavailableError) ? "interrupted" : "failed",
        messages: [],
        warnings: [],
        error: errorMessage(error),
        finishedAt: this.now().toISOString()
      };
    } finally {
      this.activeTurns.delete(request.runId);
      this.activeTurnConversations.delete(request.runId);
    }
    // The result is kept (on disk when configured) until the desktop
    // acknowledges it: a desktop that is away, a relay that drops the frame,
    // or a restart of this runtime all get it delivered again.
    terminal.receiptId = (await this.options.eventStorage.nativeCommands().forRun(request.runId))?.commandId ?? randomUUID();
    this.pendingTerminals.set(request.runId, terminal);
    this.persistOutbox();
    // The finished messages travel in the result; they are not echoed again
    // as a back delta by the snapshot that saved them.
    this.rememberDesktopMessages(request.conversationId, terminal.messages);
    await this.flushPendingTerminals();
  }

  private async finishNativeRun(run: ChatParticipantRun): Promise<void> {
    if (this.settlingInFlight.has(run.runId) || !this.chat.settledParticipantRunResult) {
      return;
    }
    this.settlingInFlight.add(run.runId);
    try {
      const result = await this.chat.settledParticipantRunResult(run);
      const failed = result.messages.some((message) => message.role === "participant" && message.status === "error");
      const terminal: MachineTurnFinishedBody = {
        type: "machine.turn.finished", conversationId: run.conversationId,
        receiptId: randomUUID(),
        runId: run.runId, participantId: run.participantId,
        status: result.messages.some((message) => message.metadata?.terminalReason === "stop-unconfirmed") ? "failed"
          : run.aborted ? "interrupted" : failed ? "failed" : "completed",
        ...result, finishedAt: this.now().toISOString()
      };
      this.pendingTerminals.set(run.runId, terminal);
      this.persistOutbox();
      this.settlingRuns.delete(run.runId);
      await this.flushPendingTerminals();
    } catch (error) {
      void this.debugLogs.write("machine-host.native-result.not-stored", { runId: run.runId, message: errorMessage(error) });
    } finally {
      this.settlingInFlight.delete(run.runId);
    }
  }

  private async flushPendingTerminals(): Promise<void> {
    for (const [runId, terminal] of [...this.pendingTerminals.entries()]) {
      try {
        await this.send(terminal);
      } catch (error) {
        void this.debugLogs.write("machine-host.terminal.retry-later", { runId, message: errorMessage(error) });
        return;
      }
    }
  }

  private nextInstanceSequence(): { sequence?: number; error?: string } {
    const outbox = this.options.outboxPath;
    if (!outbox) {
      return { sequence: Date.now() };
    }
    const file = path.join(path.dirname(outbox), "machine-instance.json");
    return advanceInstanceSequence({
      read: () => readFileSync(file, "utf8"),
      write: (content) => {
        mkdirSync(path.dirname(file), { recursive: true });
        const temp = `${file}.${process.pid}.tmp`;
        writeFileSync(temp, content, "utf8");
        renameSync(temp, file);
      },
      now: () => Date.now()
    });
  }

  private loadOutbox(): void {
    const file = this.options.outboxPath;
    if (!file) {
      return;
    }
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") {
        // No outbox yet: nothing to deliver.
        return;
      }
      // Present but unreadable (permissions, I/O): never overwrite it.
      this.outboxUnreadable = true;
      this.outboxError = `the outbox on disk could not be read: ${errorMessage(error)}`;
      void this.debugLogs.write("machine-host.outbox.read-error", { file, message: errorMessage(error) });
      return;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        throw new Error("outbox is not a list");
      }
      const rejected: unknown[] = [];
      for (const entry of parsed) {
        if (isStoredTerminal(entry)) {
          this.pendingTerminals.set(entry.runId, entry);
        } else {
          rejected.push(entry);
        }
      }
      if (rejected.length > 0) {
        // Kept for recovery, never silently dropped: archived, and until
        // the archive is written they travel back into the outbox file.
        this.rejectedOutboxEntries = rejected;
        this.archiveRejectedEntries();
      }
    } catch (error) {
      // Damaged outbox: the original bytes are preserved before anything
      // may overwrite the file; if they cannot be moved or copied aside, the
      // file is never overwritten and the desktop is told.
      const damaged = `${file}.corrupt-${Date.now()}`;
      try {
        renameSync(file, damaged);
      } catch {
        try {
          copyFileSync(file, damaged);
        } catch (copyError) {
          this.outboxUnreadable = true;
          this.outboxError = `the outbox on disk is damaged and could not be preserved (${errorMessage(copyError)}); it is left untouched`;
          void this.debugLogs.write("machine-host.outbox.corrupt-preserve-failed", { file, message: errorMessage(copyError) });
          return;
        }
      }
      void this.debugLogs.write("machine-host.outbox.corrupt", { file, movedTo: damaged, message: errorMessage(error) });
    }
  }

  /** Writes the outbox; false when the results are held in memory only.
   *  A failed write is retried on a timer and reported to the desktop in
   *  the next hello, so a result that would not survive a restart of this
   *  runtime is never a silent condition. */
  private persistOutbox(): boolean {
    const file = this.options.outboxPath;
    if (!file) {
      return true;
    }
    if (this.outboxUnreadable) {
      void this.debugLogs.write("machine-host.outbox.write-skipped", { file, reason: "the existing outbox could not be read; not overwriting it" });
      return false;
    }
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      this.archiveRejectedEntries();
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify([...this.pendingTerminals.values(), ...this.rejectedOutboxEntries]), "utf8");
      renameSync(temp, file);
      if (this.outboxError) {
        this.outboxError = undefined;
        void this.debugLogs.write("machine-host.outbox.recovered", { file });
        this.announceOutboxState();
      }
      return true;
    } catch (error) {
      const message = errorMessage(error);
      const first = !this.outboxError;
      this.outboxError = `the outbox could not be written (${message}); ${this.pendingTerminals.size} result(s) are held in memory only`;
      void this.debugLogs.write("machine-host.outbox.write-error", { file, message, pendingTerminals: this.pendingTerminals.size });
      if (first) {
        this.announceOutboxState();
      }
      if (!this.outboxRetryTimer && !this.closed) {
        this.outboxRetryTimer = setTimeout(() => {
          this.outboxRetryTimer = undefined;
          if (this.pendingTerminals.size > 0 || this.outboxError) {
            this.persistOutbox();
          }
        }, OUTBOX_RETRY_MS);
        this.outboxRetryTimer.unref?.();
      }
      return false;
    }
  }

  private archiveRejectedEntries(): void {
    const file = this.options.outboxPath;
    if (!file || this.rejectedOutboxEntries.length === 0) {
      return;
    }
    const kept = `${file}.rejected-${Date.now()}.json`;
    try {
      writeFileSync(kept, JSON.stringify(this.rejectedOutboxEntries), "utf8");
      void this.debugLogs.write("machine-host.outbox.entries-rejected", { file, count: this.rejectedOutboxEntries.length, keptAt: kept });
      this.rejectedOutboxEntries = [];
    } catch (error) {
      void this.debugLogs.write("machine-host.outbox.archive-error", { file, count: this.rejectedOutboxEntries.length, message: errorMessage(error) });
    }
  }

  /** The desktop learns about the outbox state through hello. */
  private announceOutboxState(): void {
    if (this.desktopDeviceId && !this.closed) {
      void this.debugLogs.write("machine-host.hello.sending", { reason: "outbox-state" });
      void this.sendHello().catch(() => undefined);
    }
  }

  /** A member running here asked other members to answer. The desktop owns the
   *  roster and runs each of them where that member lives; this machine only
   *  waits for the answers to arrive with the conversation.
   *
   *  The body carries nothing that changes between attempts, so asking twice
   *  is the same event and not a second run of the same members. */
  delegateParticipantRequest(request: {
    conversationId: string;
    requestMessageId: string;
    batchId: string;
    depth: number;
    homeMachineId?: string;
    targetParticipantIds: string[];
    messages: ChatMessage[];
  }): Promise<void> {
    // Exactly one device is asked for each group of members: the machine they
    // live on, or the desktop. Nobody else is told to run them, so two devices
    // cannot start the same member.
    const peer = request.homeMachineId
      ? this.trust.peers().find((candidate) => candidate.role === "machine" && candidate.machineId === request.homeMachineId)
      : undefined;
    if (request.homeMachineId && !peer) {
      return Promise.reject(new Error(`The machine ${request.homeMachineId} is not in this machine's trust roster.`));
    }
    return this.enqueueOutbound(async () => {
      if (peer) {
        // That machine may never have seen this request: carry the rows it
        // needs before asking it to act on them.
        if (request.messages.length) {
          await this.publishToPeer(peer.deviceId, {
            type: "machine.conversation.delta",
            conversationId: request.conversationId,
            messages: request.messages,
            updatedAt: this.now().toISOString()
          });
        }
        await this.publishToPeer(peer.deviceId, {
          type: "machine.participants.delegate",
          conversationId: request.conversationId,
          requestMessageId: request.requestMessageId,
          batchId: request.batchId,
          depth: request.depth,
          targetParticipantIds: request.targetParticipantIds
        }, `machine-participants:${request.requestMessageId}:${peer.deviceId}`);
        return;
      }
      await this.publishToPeer(this.options.pairing.issuer.originId, {
        type: "machine.participants.delegate",
        conversationId: request.conversationId,
        requestMessageId: request.requestMessageId,
        batchId: request.batchId,
        depth: request.depth,
        targetParticipantIds: request.targetParticipantIds
      }, `machine-participants:${request.requestMessageId}:desktop`);
    });
  }

  /** Publishes one durable message to a single device. Used where a message
   *  must have exactly one executor rather than reaching everyone. */
  private async publishToPeer(deviceId: string, body: MachineLinkMessage, eventId?: string): Promise<void> {
    const conversationId = "conversationId" in body ? body.conversationId : "";
    const channel = deviceId === this.options.pairing.issuer.originId
      ? this.eventChannel
      : this.peers.channel(deviceId);
    if (!channel) throw new Error("That device is not in this machine's trust roster.");
    void this.debugLogs.write("machine-host.delegate.publish", { deviceId, kind: body.type, eventId });
    await channel.publish({
      conversationId,
      kind: body.type,
      payload: body,
      // The room this peer's channel actually speaks in: a row written for
      // any other room would sit in the outbox forever.
      recipients: [{
        deviceId,
        channelId: deviceId === this.options.pairing.issuer.originId
          ? this.options.pairing.rendezvousId
          : this.peers.roomFor(deviceId) ?? this.options.pairing.rendezvousId
      }],
      ...(eventId ? { eventId } : {})
    });
  }

  /** The devices that need a channel of their own. The desktop that enrolled
   *  this machine already has one — the enrollment channel — so it is not
   *  given a second. */
  private rosterPeersToConnect(peers: readonly TrustedPeerAccess[]): TrustedPeerAccess[] {
    return peers.filter((peer) => peer.deviceId !== this.options.pairing.issuer.originId);
  }

  /**
   * Who a result is delivered to: the enrolling desktop and every other device
   * of the owner that is met in this machine's own room.
   *
   * A machine in another room is deliberately not on this list. An event is
   * scoped to the room it was minted in, and another machine is a peer for
   * asking members to run, not an audience for this machine's results.
   */
  private resultRecipients(): Array<{ deviceId: string; channelId: string }> {
    const room = this.options.pairing.rendezvousId;
    const issuer = { deviceId: this.options.pairing.issuer.originId, channelId: room };
    const peers = this.peers.recipients()
      .filter((peer) => peer.channelId === room && peer.deviceId !== issuer.deviceId);
    return [issuer, ...peers];
  }

  private enqueueOutbound(task: () => Promise<void>): Promise<void> {
    const run = this.outbound.then(task);
    this.outbound = run.then(() => undefined, () => undefined);
    return run;
  }

  private send(body: MachineLinkMessage, to?: string): Promise<void> {
    const run = this.outbound.then(() => this.sendNow(body, to));
    this.outbound = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Covers native continuations whose run was created by ChatService rather
   * than a desktop dispatch (for example a permission continuation). */
  noteNativeProgress(progress: ReviewProgress): void {
    const sender = this.progressSenders.get(progress.runId);
    if (sender) { sender.note(progress); return; }
    const run = this.chat.activeParticipantRuns?.().find(item => item.runId === progress.runId);
    if (run) this.noteProgress(run.conversationId, progress);
  }

  private noteProgress(conversationId: string, progress: ReviewProgress): void {
    if (this.closed) return;
    let sender = this.progressSenders.get(progress.runId);
    if (!sender) {
      sender = new MachineProgressSender({
        conversationId,
        publish: frame => this.eventChannel.publish({ conversationId, kind: frame.type, payload: frame,
          eventId: machineProgressEventId(frame), scope: `terminal:${frame.runId}` }),
        stored: (event, frame) => this.options.eventStorage.machineProgress().apply(event, frame),
        onError: error => {
          this.progressErrors.set(progress.runId, `Progress is not stored: ${errorMessage(error)}`);
          void this.debugLogs.write("machine-host.progress.not-stored", { runId: progress.runId, message: errorMessage(error) });
          this.announceOutboxState();
        },
        onRecovered: () => {
          this.progressErrors.delete(progress.runId);
          this.announceOutboxState();
          void this.flushPendingTerminals();
        }
      });
      this.progressSenders.set(progress.runId, sender);
    }
    sender.note(progress);
  }

  private async sendNow(body: MachineLinkMessage, recipient?: string): Promise<void> {
    if (this.closed) {
      return;
    }
    if (isMachineDurableMessage(body)) {
      if (body.type === "machine.turn.finished" && !this.durableTerminalIds.has(terminalEventId(body))) {
        await this.options.onNativeActivitySettled?.();
      }
      if (body.type === "machine.turn.finished") await this.progressSenders.get(body.runId)?.finish();
      const conversationId = body.type === "machine.conversation.sync" ? body.conversation.id : "conversationId" in body ? body.conversationId : "";
      const published = await this.eventChannel.publish({ conversationId, kind: body.type, payload: body,
        // One result, delivered to every device the owner has: whichever of
        // them is online gets it, and the outbox holds it for the others.
        recipients: this.resultRecipients(),
        ...(body.type === "machine.approval.requested" || body.type === "machine.approval.updated" ? { scope: `approval:${body.approval.id}` } : {}),
        ...(body.type === "machine.choice.result" ? { eventId: machineChoiceResultId(body.decisionId), scope: `choice:${body.choiceId}` } : {}),
        ...(body.type === "machine.approval.result" && body.decisionId ? { eventId: machineApprovalResultId(body.decisionId), scope: `approval:${body.approvalId}` } : {}),
        ...(body.type === "machine.conversation.deleted" ? { eventId: `machine-delete:${JSON.stringify([this.options.deviceId, conversationId])}`, scope: "deletion" } : {}),
        ...(body.type === "machine.turn.started" ? { eventId: `machine-started:${body.runId}`, scope: `terminal:${body.runId}` } : {}),
        // One request message, one delegation: a redelivery or a restart is
        // the same event, not a second run of the same members. It stays on
        // the conversation's own stream, behind the back delta carrying the
        // request message it names.
        ...(body.type === "machine.participants.delegate"
          ? { eventId: `machine-participants:${body.requestMessageId}` } : {}),
        ...(body.type === "machine.turn.finished" ? { eventId: terminalEventId(body), scope: `terminal:${body.runId}` } : {}) });
      if (body.type === "machine.turn.finished") this.durableTerminalIds.add(published.eventId);
      if (body.type === "machine.turn.finished") await this.options.eventStorage.nativeCommands().recordOutcome(body.runId, published.eventId);
      if (body.type === "machine.turn.finished" && body.receiptId === machineCommandId(body.runId) && await this.options.eventStorage.nativeCommands().forRun(body.runId)) {
        await this.options.eventStorage.nativeCommands().finish(machineCommandId(body.runId));
      }
      if (body.type === "machine.turn.finished") {
        await this.options.eventStorage.machineProgress().close(body.runId);
        this.progressSenders.delete(body.runId);
      }
      return;
    }
    const to = recipient ?? this.desktopDeviceId;
    if (!to) {
      throw new Error("The desktop is not connected.");
    }
    const envelope: MachineLinkEnvelope = {
      protocol: MACHINE_LINK_PROTOCOL,
      messageId: randomUUID(),
      sentAt: this.now().toISOString(),
      body
    };
    const signed = signMachineControl(envelope, await this.options.eventLog.getOrCreateDeviceIdentity(), this.options.pairing.rendezvousId, to);
    const peerKey = to === this.options.pairing.issuer.originId
      ? this.options.pairing.issuer.publicKeyDerBase64 : this.trust.peer(to)?.publicKeyDerBase64;
    if (!peerKey) throw new Error("That device is no longer trusted.");
    const ciphertext = await sealMachineRelayPayload(signed, await this.options.eventLog.getOrCreateDeviceIdentity(),
      peerKey, this.options.pairing.rendezvousId);
    await this.client.sendCiphertext({ logicalMessageId: envelope.messageId, ciphertext, to });
  }
}

function terminalEventId(body: MachineTurnFinishedBody): string {
  return `machine-terminal:${body.receiptId ?? `${body.runId}:${body.finishedAt}`}`;
}

export function machineMessagesForRun(conversation: Conversation, participantId: string, runId: string): ChatMessage[] {
  return conversation.messages.filter((message) => message.participantId === participantId && message.metadata?.runId === runId);
}

/** Desktop messages win by id, this machine's own are kept, and a message
 *  finished here is never replaced by a stale pending copy of itself. */
export function mergeReplicatedMessages(own: ChatMessage[], incoming: ChatMessage[], removedIds: string[] = [], ownedParticipantIds: ReadonlySet<string> = new Set()): ChatMessage[] {
  const byId = new Map(own.map((message) => [message.id, message]));
  for (const message of incoming) {
    const current = byId.get(message.id);
    if (current && current.status !== "pending" && message.status === "pending") {
      continue;
    }
    // A desktop that swept a bubble as "interrupted" (its stale-run sweep
    // found no live run for it) never overrides this machine's own row for
    // that bubble, finished or still running: the machine runs it and knows.
    if (current && current.participantId && ownedParticipantIds.has(current.participantId) && message.metadata?.staleRunRecovery) {
      continue;
    }
    byId.set(message.id, message);
  }
  for (const id of removedIds) {
    byId.delete(id);
  }
  return [...byId.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

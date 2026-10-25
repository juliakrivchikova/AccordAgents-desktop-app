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
import { rm } from "node:fs/promises";
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
import type { MachineAttachmentResultBody, MachineCompactionDelegateRequest, MachineScriptsOperation, MachineScriptsRequestBody, MachineTransportMoveBody } from "../../shared/machineLink";
import { normalizeMachineTurnCompaction } from "../../shared/machineLink";
import type { MobilePairingPackage } from "../../shared/mobilePairing";
import type { AgentHealth, ChatAppToolApproval, ChatAppToolApprovalPolicy, ChatBackgroundTasksEvent, ChatMessage, Conversation, ReviewProgress } from "../../shared/types";
import type { ChatParticipantRun, ChatService } from "./chat";
import type { DebugLogService } from "./debugLogs";
import { advanceInstanceSequence, isStoredTerminal } from "./machineTurnOutcome";
import { openMobileRelayPayload } from "./mobileRelaySealing";
import { deriveMachineChannelKey } from "../../shared/machineChannelKey";
import { openMachineRelayPayload, sealMachineRelayPayload } from "./machineRelaySealing";
import { RelayTunnelClient, type TunnelClient } from "./relayTunnelClient";
import { deliverToChannel, type HubDeliverOutcome } from "./hubSync";
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
import type { DeviceEventApplyOutcome, DeviceEventGap } from "../../shared/deviceEventDelivery";
import { isDeviceEventPacket } from "../../shared/deviceEventChannel";
import { isMachineDurableMessage } from "../../shared/machineLink";
import { NativeProcessUnavailableError } from "./nativeProcess";
import type { ChatEventEnvelope } from "../../shared/chatEvents";
import { CHAT_CHANGES_EVENT_KIND, isChatChangesPayload, type ChatChangesPayload, isSafeChatId, CHAT_CHANGES_VERSION } from "./chatChanges";
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
  /** Opens a connection to another device's room (the hub's rooms, a test stand-in). */
  createPeerClient?: (room: { relayUrl: string; rendezvousId: string; sealKeyBase64: string; fingerprint?: string; deviceId: string }) => TunnelClient;
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
  /** The name the enrolling desktop gave this machine, from its greeting. */
  onDesktopMachineName?: (name: string) => void;
  /** File that keeps finished turns until the desktop acknowledges them, so
   *  a result survives a restart of this runtime. In-memory only when unset. */
  outboxPath?: string;
  reconnectDelayMs?: number;
  createClient?: (pairing: MobilePairingPackage) => TunnelClient;
  now?: () => Date;
  nativeProcessDbPath?: string;
  /** Commit idle accounting before a completed native run stops being busy. */
  onNativeActivitySettled?: () => Promise<void>;
  idleStopWarning?: () => string | undefined;
  /** The User's automatic-stop switch as this machine has it. */
  autoStopEnabled?: () => boolean | undefined;
  /** The User's hub carries this machine's events instead of the relay's
   *  per-peer delivery (see DeviceEventChannel.hubMode). */
  hubMode?: boolean;
  /** Through the hub: a channel's gap is asked of the hub (HubSync.repairGap). */
  hubRepair?: (gap: DeviceEventGap) => void;
  /** Scheduled scripts on this machine, operated by the enrolling desktop. */
  scripts?: {
    handle(operation: MachineScriptsOperation): Promise<unknown>;
    /** True while an enabled script needs this machine awake for its next run,
     *  or a script is running now. */
    keepsHostAwake(): boolean;
    /** How many switched-on scripts keep it awake, for the desktop to show. */
    scheduledCount?(): number;
    /** True while a script runs now (a move would cut it off). */
    runningNow?(): boolean;
  };
  /** Moves this machine to another relay address: writes it into the
   *  enrollment. Absent where the runtime cannot (it then says so). */
  moveTransport?: (addresses: { relayUrl: string; outboxUrl: string }) => Promise<void>;
  /** Starts this runtime again, reading the enrollment anew. */
  restartRuntime?: () => void;
  /** Whether the relay at this address answers (asked before a move, so a
   *  machine never rewrites its enrollment to a place it cannot reach). */
  probeRelay?: (relayUrl: string) => Promise<boolean>;
  /** Folds a `chat.changes` event into this machine's copy of the chat.
   *  "missing-conversation" holds the event until the chat arrives. */
  applyChatChanges?: (event: ChatEventEnvelope, payload: ChatChangesPayload) => Promise<"applied" | "missing-conversation" | "waiting">;
}

/** How soon a failed outbox write is tried again. */
const OUTBOX_RETRY_MS = 30_000;
/** How long one part of a picture may take to arrive from the desktop before
 *  the member's read fails. Restarted by every part, so it bounds silence,
 *  not the whole transfer. */
const ATTACHMENT_PART_TIMEOUT_MS = 120_000;
/** One run changes several things at once; the desktop hears about them together. */
const SCRIPTS_CHANGED_COALESCE_MS = 250;
/** How far the desktop's clock may be ahead of this machine's when it dates a request. */
const SCRIPTS_REQUEST_CLOCK_SKEW_MS = 30_000;
/** A move's settling ends this long before the desktop's deadline (or 40%
 *  of a shorter wait), leaving time to ask the server (up to 10 s) and to
 *  answer; the move itself is not made later than the second margin (or 10%)
 *  before it. */
const TRANSPORT_MOVE_SETTLE_MARGIN_MS = 25_000;
const TRANSPORT_MOVE_ANSWER_MARGIN_MS = 5_000;
const TRANSPORT_MOVE_ANSWER_MAX_MS = 5 * 60_000;

function changesScripts(operation: MachineScriptsOperation): boolean {
  return operation.op !== "list" && operation.op !== "revision" && operation.op !== "runs";
}

interface MachineAttachmentBytes { dataBase64: string; mediaType?: string; fileName?: string }

interface MachineAttachmentWaiter {
  resolve: (value: MachineAttachmentBytes) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  timeoutMs: number;
  chunks: Map<number, Buffer>;
  parts?: number;
  mediaType?: string;
  fileName?: string;
}
function compactionMark(request: MachineTurnRequestBody): Pick<MachineTurnFinishedBody, "compaction"> {
  return request.compaction ? { compaction: { triggeredBy: request.compaction.triggeredBy === "agent" ? "agent" : "user" } } : {};
}

/** The reasons a command did not run, said of a compaction rather than a turn. */
function compactionWording(reason: string): string {
  return reason
    .replace("so the member did not start. Send the message again once the machine is connected.", "so the compaction did not start. Compact again once the machine is connected.")
    .replace("the turn did not run", "the compaction did not run")
    .replace("before this turn started", "before this compaction started")
    .replace("this turn did not start", "this compaction did not start");
}

/** How long a turn request waits for the chat state it names before it fails
 *  honestly instead of running a member on a chat that has not arrived. */
const MACHINE_CHAT_WAIT_MS = 10 * 60 * 1000;

/**
 * How a turn ended, as the desktop is told. A Stop reaches the run either
 * through this host's cancel or through the User's stop action applied by
 * the chat; either way the chat marks the bubble stopped once the run is
 * gone, and that is an interruption, not a failure. A stop the chat could not
 * confirm stays a failure.
 */
function finishedTurnStatus(messages: ChatMessage[], aborted: boolean | undefined, failed = messages.some((message) => message.status === "error")): MachineTurnFinishedBody["status"] {
  if (messages.some((message) => message.metadata?.terminalReason === "stop-unconfirmed")) return "failed";
  if (aborted || messages.some((message) => message.metadata?.terminalReason === "user-stopped")) return "interrupted";
  return failed ? "failed" : "completed";
}

export class MachineHostService {
  private eventChannel!: DeviceEventChannel;
  private readonly client: TunnelClient;
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
  /** Turn requests that arrived before the chat state they name (the
   *  desktop's last chat change event) was applied here. They run once it
   *  is, or fail honestly if it never arrives. */
  private readonly turnsAwaitingChat = new Map<string, Array<{ request: MachineTurnRequestBody; since: number }>>();
  private awaitingChatTimer?: ReturnType<typeof setTimeout>;
  /** Events whose deferral was already reported, so a retry is not logged again. */
  private readonly reportedDeferrals = new Set<string>();
  /** True when the outbox file exists but could not be read: it is then
   *  never overwritten, so a result on disk is not lost to a bad read. */
  /** Applies an incoming chat action, or undefined when the event is not one.
   *  `deferred` keeps the event for retry rather than losing the action when
   *  what it refers to has not reached this machine yet. */
  private async applyChatAction(event: ChatEventEnvelope, hydrated?: unknown): Promise<"applied" | "deferred" | DeferredWithDependency | undefined> {
    const applier = this.options.chatActions;
    if (!applier?.handles(event, hydrated)) return undefined;
    const outcome = await applier.apply(event, hydrated);
    // A deferral is reported once; it is retried until it applies, and logging
    // every attempt wrote hundreds of thousands of identical lines a day.
    const repeatedDeferral = outcome.status === "deferred" && this.reportedDeferrals.has(event.eventId);
    if (outcome.status === "deferred") rememberBounded(this.reportedDeferrals, event.eventId);
    else this.reportedDeferrals.delete(event.eventId);
    if (outcome.detail && !repeatedDeferral) {
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

  /** requestId -> whoever is waiting for those picture bytes, and the parts
   *  that have arrived so far. */
  private readonly pendingAttachments = new Map<string, MachineAttachmentWaiter>();

  /**
   * The bytes of a picture this chat carries, from the desktop that holds it.
   *
   * Replication brings the attachment's metadata here but not its file, so
   * without this a member on a machine sees that the User attached a picture
   * and can never read it. The picture arrives in parts; the wait is bounded
   * per part, so a desktop that stops answering fails the read rather than
   * leaving the member waiting for the rest of its turn, while a large picture
   * on a slow link is not cut off as long as parts keep arriving.
   */
  async requestAttachment(conversationId: string, attachmentId: string, timeoutMs = ATTACHMENT_PART_TIMEOUT_MS): Promise<MachineAttachmentBytes> {
    const requestId = randomUUID();
    const pending = new Promise<MachineAttachmentBytes>((resolve, reject) => {
      const waiter: MachineAttachmentWaiter = {
        resolve, reject, timeoutMs, chunks: new Map(),
        timer: setTimeout(() => this.failAttachment(requestId, "The desktop did not answer with this picture in time."), timeoutMs)
      };
      waiter.timer.unref?.();
      this.pendingAttachments.set(requestId, waiter);
    });
    try {
      await this.send({ type: "machine.attachment.request", requestId, conversationId, attachmentId });
    } catch (error) {
      this.failAttachment(requestId, errorMessage(error));
    }
    return pending;
  }

  private failAttachment(requestId: string, message: string): void {
    const waiter = this.pendingAttachments.get(requestId);
    if (!waiter) return;
    this.pendingAttachments.delete(requestId);
    clearTimeout(waiter.timer);
    waiter.reject(new Error(message));
  }

  /** Every picture still awaited fails now: the desktop is gone or this
   *  runtime is closing, and nothing will answer. */
  private failAllAttachments(message: string): void {
    for (const requestId of [...this.pendingAttachments.keys()]) this.failAttachment(requestId, message);
  }

  private receiveAttachmentPart(body: MachineAttachmentResultBody): void {
    const waiter = this.pendingAttachments.get(body.requestId);
    if (!waiter) return;
    if (!body.ok || typeof body.dataBase64 !== "string") {
      this.failAttachment(body.requestId, body.error ?? "The desktop could not read this picture.");
      return;
    }
    const parts = Number.isInteger(body.parts) && (body.parts as number) > 0 ? (body.parts as number) : 1;
    const part = Number.isInteger(body.part) && (body.part as number) >= 0 ? (body.part as number) : 0;
    if (part >= parts) return;
    waiter.parts = parts;
    waiter.chunks.set(part, Buffer.from(body.dataBase64, "base64"));
    if (body.mediaType) waiter.mediaType = body.mediaType;
    if (body.fileName) waiter.fileName = body.fileName;
    if (waiter.chunks.size < parts) {
      // Progress: the bound restarts with every part that arrives.
      clearTimeout(waiter.timer);
      waiter.timer = setTimeout(() => this.failAttachment(body.requestId, "The desktop stopped sending this picture."), waiter.timeoutMs);
      waiter.timer.unref?.();
      return;
    }
    this.pendingAttachments.delete(body.requestId);
    clearTimeout(waiter.timer);
    const ordered = Array.from({ length: parts }, (_, index) => waiter.chunks.get(index) as Buffer);
    waiter.resolve({
      dataBase64: Buffer.concat(ordered).toString("base64"),
      ...(waiter.mediaType ? { mediaType: waiter.mediaType } : {}),
      ...(waiter.fileName ? { fileName: waiter.fileName } : {})
    });
  }

  /** The signing key of one of the owner's devices this machine trusts. */
  trustedKey(originId: string): string | undefined {
    if (originId === this.options.pairing.issuer.originId) return this.options.pairing.issuer.publicKeyDerBase64;
    return this.trust.peers().find((peer) => peer.deviceId === originId)?.publicKeyDerBase64;
  }

  /** An event the hub's order brought: to the desktop's channel when the
   *  desktop (or a machine's chat change it would forward) wrote it, else to
   *  the channel of the peer that did. `fetchBody` stores the event's large
   *  body, fetched only for an event one of this machine's channels takes. */
  async receiveFromHub(event: ChatEventEnvelope, fetchBody?: () => Promise<void>): Promise<HubDeliverOutcome> {
    await this.initializeOwnerChannel();
    if (this.eventChannel?.accepts(event)) return deliverToChannel(this.eventChannel, event, fetchBody);
    return this.peers.receiveFromHub(event, fetchBody);
  }

  /** Through the hub: this machine's channels' scopes, with the desktop and
   *  with its peers (where it starts again, it starts before their events). */
  hubChannelScopes(): string[] {
    return [`device:${this.options.pairing.rendezvousId}:`, ...this.peers.hubChannelScopes()];
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
    return !this.draining && !this.fenced && !this.closed;
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
  /** The enrolling desktop said, in its last greeting, that it runs the
   *  compactions members here ask for themselves. */
  private desktopTakesCompactions = false;
  private homeMachineId?: string;
  private readonly settlingRuns = new Map<string, ChatParticipantRun>();
  private readonly settlingInFlight = new Set<string>();
  private unsubscribeRunSettled?: () => void;
  private unsubscribeBackgroundTasks?: () => void;
  private closed = false;
  private draining = false;
  private idleFenced = false;
  /** Held by a move to another address from its check until the restart
   *  (or its refusal); kept apart from the idle stop's, so neither releases
   *  the other's. */
  private moveFenced = false;
  private get fenced(): boolean { return this.idleFenced || this.moveFenced; }
  private readonly turnTasks = new Set<Promise<void>>();
  private readonly deletingConversationIds = new Set<string>();
  private readonly activeTurnConversations = new Map<string, string>();
  private readonly commandTasks = new Map<string, Promise<void>>();
  private readonly commandSessions = new Map<string, Promise<void>>();
  /** The newest settings applied here. A command queued while this machine
   *  was away runs with the settings of its own moment (they travel sealed
   *  in it); newer ones that arrived meanwhile are put back once it has run,
   *  since the desktop publishes settings only when they change and nothing
   *  else would. */
  private newestSettings?: { exportedAt: string; snapshot: import("../../shared/machineLink").MachineSettingsSnapshot };
  /** Every command of a member still running here, by conversation:member. */
  private readonly commandScopeTasks = new Map<string, Set<Promise<void>>>();
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

  constructor(
    private readonly chat: Pick<ChatService, "runMachineHostedTurn" | "cancelRun" | "respondToChoice" | "respondToAppToolApproval" | "applyReplicatedConversation"> & Partial<Pick<ChatService, "activeParticipantRuns" | "liveRunIds" | "hasActiveRunForConversation" | "onParticipantRunSettled" | "settledParticipantRunResult" | "runDelegatedParticipantRequest" | "conversationIdForRun" | "closeReplicatedConversationSessions" | "onReplicatedConversationReady" | "setPromptSuggestionForwarder" | "applyMachineRepository" | "onBackgroundTasksChanged" | "localBackgroundTasks" | "runMachineHostedCompaction">>,
    private readonly storage: Pick<StorageService, "getConversation"> & Partial<Pick<StorageService, "deleteConversation" | "conversationPresence">>,
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
    if (!pairing.relayUrl && !pairing.hubUrl) {
      throw new Error("Machine enrollment names neither a relay nor a hub.");
    }
    this.client = options.createClient?.(pairing) ?? new RelayTunnelClient({
      relayUrl: pairing.relayUrl ?? "",
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
      ...(options.hubMode ? { hubMode: true, ...(options.hubRepair ? { hubRepair: options.hubRepair } : {}) } : {}),
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
      canApply: () => !this.closed && !this.draining && !this.fenced,
      publish: body => this.send(body),
      codeApprover: event => event.originId === options.pairing.issuer.originId
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
        this.failAllAttachments("The desktop went away before answering with this picture.");
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
    // Members hosted here show their background work on the desktop too.
    this.unsubscribeBackgroundTasks = this.chat.onBackgroundTasksChanged?.((event) => this.sendMemberBackground(event));
    // The desktop decides whether a member's next-prompt suggestion is still
    // on offer; with no desktop connected there is nobody to offer it to.
    this.chat.setPromptSuggestionForwarder?.((suggestion) => {
      if (this.closed) return;
      void this.send({
        type: "machine.turn.suggestion",
        conversationId: suggestion.conversationId,
        runId: suggestion.runId,
        participantId: suggestion.participantId,
        suggestion: suggestion.text
      }).catch((error) => {
        void this.debugLogs.write("machine-host.suggestion.not-sent", { runId: suggestion.runId, message: errorMessage(error) });
      });
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
      ...(options.hubMode ? { hubMode: true, ...(options.hubRepair ? { hubRepair: options.hubRepair } : {}) } : {}),
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
      peerHoldsEveryChat: true,
      // The desktop forwards what the owner's other machines wrote in chats,
      // unchanged: accepted when its author is one of them.
      forwardedOriginKey: (originId) => {
        const peer = this.trust.peer(originId);
        return peer?.role === "machine" ? peer.publicKeyDerBase64 : undefined;
      },
      onError: (error) => { void this.debugLogs.write("machine-host.events.error", { message: error.message }); }
    });
  }

  async start(): Promise<void> {
    await this.initializeOwnerChannel();
    this.closed = false;
    for (const eventId of await this.options.eventStorage.storedChatEventIds([...this.pendingTerminals.values()].map(terminalEventId))) {
      this.durableTerminalIds.add(eventId);
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
    this.failAllAttachments("The machine runtime is closing; this picture was not fetched.");
    this.closed = true;
    for (const sender of this.progressSenders.values()) sender.close();
    this.peers.close();
    this.eventChannel?.close();
    this.unsubscribeRunSettled?.();
    this.chat.setPromptSuggestionForwarder?.(undefined);
    this.unsubscribeBackgroundTasks?.();
    this.unsubscribeBackgroundTasks = undefined;
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
    for (const waiting of this.turnsAwaitingChat.values()) {
      for (const { request } of waiting) await this.finishQueuedTurn(request, "failed", "The machine shut down before this turn started.");
    }
    this.turnsAwaitingChat.clear();
    if (this.awaitingChatTimer) clearTimeout(this.awaitingChatTimer);
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

  /** Work a move would cut off: everything the idle stop waits for except
   *  a scheduled script's next run (it runs after the restart), and a
   *  member's background work besides. */
  private async hasWorkForMove(): Promise<boolean> {
    if (this.options.scripts?.runningNow?.()) return true;
    if ((this.chat.localBackgroundTasks?.() ?? []).length > 0) return true;
    if (this.queuedRunIds().length > 0 || (this.chat.liveRunIds?.() ?? []).length > 0) return true;
    if (this.closed || this.draining || this.activeTurns.size || this.turnTasks.size || this.commandTasks.size ||
        this.settlingRuns.size || this.settlingInFlight.size || this.turnsAwaitingChat.size ||
        (this.approvalExecutor.hasActiveWork() || this.choiceExecutor.hasActiveWork()) || (this.chat.activeParticipantRuns?.().length ?? 0) ||
        this.outboxError || this.progressErrors.size || [...this.progressSenders.values()].some(sender => sender.hasPending())) return true;
    if ([...this.pendingTerminals.values()].some(terminal => !this.durableTerminalIds.has(terminalEventId(terminal)))) return true;
    return (await this.options.eventStorage.nativeCommands().pending()).length > 0;
  }

  /** All work owned by this runtime, including native continuations and
   * incomplete copies. Stored, acknowledged-later results do not keep an idle
   * EC2 box running indefinitely; an unpersisted result does. */
  async hasWorkForIdleStop(): Promise<boolean> {
    // An enabled scheduled script must find the machine awake at its next
    // due time. This vetoes idle stop only; it is not a run, so the desktop's
    // update gate (hello run ids) does not wait for it.
    if (this.options.scripts?.keepsHostAwake()) return true;
    if (this.closed || this.draining || this.activeTurns.size || this.turnTasks.size || this.commandTasks.size ||
        this.settlingRuns.size || this.settlingInFlight.size || this.turnsAwaitingChat.size ||
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
    if (this.fenced || await this.hasWorkForIdleStop()) return undefined;
    // A move may have taken the machine while that was asked.
    if (this.fenced) return undefined;
    this.idleFenced = true;
    let releaseNative: (() => void) | undefined;
    let committed = false;
    try {
      await this.inbound;
      // A script request already taken (switching one on) is part of what
      // decides whether this machine may stop.
      await this.scriptsQueue;
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
        this.retryHeldEventsNow();
        void this.eventChannel.flush().catch(error => { void this.debugLogs.write("machine-host.idle.resume-error", { message: errorMessage(error) }); });
      }
    }
  }

  private uncertainIdleRelease?: () => void;

  /** Commands held while the idle fence stood are tried now that it is gone,
   *  on the desktop's channel and on every other device's (the phone, other
   *  machines) alike. */
  private retryHeldEventsNow(): void {
    this.eventChannel.retryHeldNow();
    for (const deviceId of this.peers.peerDeviceIds()) this.peers.channel(deviceId)?.retryHeldNow();
  }

  /** A failed fence read is recoverable without restarting the runtime. Only
   * a successful read proving absence permits reopening native admission. */
  async recoverIdleFence(bootId: string): Promise<boolean> {
    if (await this.options.eventStorage.machinePower().stopFence(bootId)) return true;
    this.uncertainIdleRelease?.();
    this.uncertainIdleRelease = undefined;
    this.idleFenced = false;
    this.retryHeldEventsNow();
    void this.eventChannel.flush().catch(error => { void this.debugLogs.write("machine-host.idle.resume-error", { message: errorMessage(error) }); });
    return false;
  }

  /** Called on every conversation mutation on this machine: approvals raised
   *  here (permission prompts, Codex approvals, member requests) are shown on
   *  the desktop, and their outcome travels back the same way. */
  noteConversationSnapshot(conversation: Conversation): void {
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

  /** Runs this machine finished while the desktop was away are closed on
   *  reconnect. Their messages already travel as chat change events. */
  private async reforwardMachineMessages(): Promise<void> {
    for (const run of this.settlingRuns.values()) {
      await this.finishNativeRun(run);
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
      activeRunIds: [...new Set([...this.activeTurns.keys(), ...this.queuedRunIds(), ...this.settlingRuns.keys(), ...(this.chat.activeParticipantRuns?.() ?? []).map((run) => run.runId), ...(this.chat.liveRunIds?.() ?? [])])],
      pendingTerminalRunIds: [...this.pendingTerminals.keys()],
      instanceId: this.instanceId,
      instanceStartedAt: this.instanceStartedAt,
      ...(typeof this.instanceSequence === "number" ? { instanceSequence: this.instanceSequence } : {}),
      ...((this.outboxError || this.progressErrors.size) ? { outboxError: [this.outboxError, ...this.progressErrors.values()].filter(Boolean).join("; ") } : {}),
      ...(this.options.idleStopWarning?.() ? { idleStopWarning: this.options.idleStopWarning() } : {}),
      ...(typeof this.options.autoStopEnabled?.() === "boolean" ? { autoStopEnabled: this.options.autoStopEnabled() } : {}),
      ...(this.options.moveTransport ? { transportMoveSupported: true } : {}),
      ...(this.options.scripts ? {
        scriptsSupported: true,
        keepAwake: this.options.scripts.keepsHostAwake(),
        keepAwakeScripts: this.options.scripts.scheduledCount?.() ?? 0
      } : {}),
      chatChanges: CHAT_CHANGES_VERSION,
      ...(this.chat.runMachineHostedCompaction ? { compactionSupported: true } : {})
    }, to);
    // A desktop that (re)connects learns what is running in the background now.
    this.sendMemberBackgroundSnapshot(to);
  }

  private sendMemberBackgroundSnapshot(to?: string): void {
    if (this.closed || !this.chat.localBackgroundTasks) return;
    void this.send({
      type: "machine.member.background.snapshot",
      members: this.chat.localBackgroundTasks().map((event) => ({
        conversationId: event.conversationId,
        participantId: event.participantId,
        labels: event.labels
      }))
    }, to).catch((error) => {
      void this.debugLogs.write("machine-host.background.snapshot-not-sent", { message: errorMessage(error) });
    });
  }

  private sendMemberBackground(event: ChatBackgroundTasksEvent, to?: string): void {
    if (this.closed) return;
    void this.send({
      type: "machine.member.background",
      conversationId: event.conversationId,
      participantId: event.participantId,
      labels: event.labels
    }, to).catch((error) => {
      void this.debugLogs.write("machine-host.background.not-sent", { participantId: event.participantId, message: errorMessage(error) });
    });
  }

  /** Tell the desktop the scripts changed, so its Settings and cards refresh.
   *  Best effort and coalesced: one run changes several things at once, and
   *  a desktop that is away asks again when it reconnects. */
  noteScriptsChanged(): void {
    if (!this.desktopDeviceId || this.closed || this.scriptsChangedTimer) return;
    this.scriptsChangedTimer = setTimeout(() => {
      this.scriptsChangedTimer = undefined;
      if (!this.desktopDeviceId || this.closed) return;
      void this.send({ type: "machine.scripts.changed" }).catch(() => undefined);
    }, SCRIPTS_CHANGED_COALESCE_MS);
    this.scriptsChangedTimer.unref?.();
  }

  private scriptsChangedTimer?: ReturnType<typeof setTimeout>;
  /** Script operations run one at a time, in order, off the inbound chain. */
  private scriptsQueue: Promise<void> = Promise.resolve();

  /** The desktop moves this machine to the User's own server: the new
   *  addresses go into the enrollment, the answer goes back, and the runtime
   *  starts again from it. Refused while anything runs here, so no turn is
   *  cut off; the desktop asks again once this machine is idle. */
  private async answerTransportMove(body: MachineTransportMoveBody, replyTo: string | undefined): Promise<void> {
    const fail = (error: string) => this.send({ type: "machine.transport.moved", requestId: body.requestId, ok: false, error }, replyTo).catch(() => undefined);
    const expiresAt = typeof body.expiresAt === "string" ? Date.parse(body.expiresAt) : Number.NaN;
    if (!this.options.moveTransport || !this.options.restartRuntime) return void await fail("This machine runtime cannot move; upgrade it.");
    if (body.instanceId !== this.instanceId) return void await fail("The machine restarted since this was asked; try again.");
    if (!Number.isFinite(expiresAt) || this.now().getTime() > expiresAt + SCRIPTS_REQUEST_CLOCK_SKEW_MS) return void await fail("This request is too old; nothing was changed.");
    const addresses = relayAddresses(body.relayUrl, body.outboxUrl, this.options.pairing.relayUrl);
    if (!addresses) return void await fail("These are not a relay's addresses.");
    if (this.fenced) return void await fail("The machine is busy; it moves once it is idle.");
    // From here no new work starts: what arrives waits in the durable inbox
    // (for this runtime if the move does not happen, the next one if it does).
    this.moveFenced = true;
    const refuse = async (error: string): Promise<void> => {
      this.moveFenced = false;
      this.retryHeldEventsNow();
      void this.eventChannel.flush().catch(error => { void this.debugLogs.write("machine-host.move.resume-error", { message: errorMessage(error) }); });
      await fail(error);
    };
    // The desktop stops waiting for the answer at its deadline, counted here
    // from receipt on this machine's own clock: past it, the machine refuses
    // rather than moving unseen.
    const budget = typeof body.answerWithinMs === "number" && Number.isFinite(body.answerWithinMs) && body.answerWithinMs > 0
      ? Math.min(body.answerWithinMs, TRANSPORT_MOVE_ANSWER_MAX_MS)
      : Math.max(0, expiresAt - this.now().getTime());
    const answerBy = this.now().getTime() + budget;
    const late = () => this.now().getTime() > answerBy - Math.min(TRANSPORT_MOVE_ANSWER_MARGIN_MS, budget * 0.1);
    try {
      // What was already taken in (a message being read, a script request,
      // an event being applied) settles before the machine says it is idle.
      const settled = (async () => {
        await this.inbound;
        await this.scriptsQueue;
        await this.eventChannel.flush();
        return true;
      })();
      const remaining = Math.max(0, answerBy - Math.min(TRANSPORT_MOVE_SETTLE_MARGIN_MS, budget * 0.4) - this.now().getTime());
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const inTime = await Promise.race([settled, new Promise<false>((resolve) => { deadline = setTimeout(() => resolve(false), remaining); })]);
      clearTimeout(deadline);
      if (!inTime) return void await refuse("The machine is still sending what it owes; it moves once that is done.");
    } catch (error) {
      return void await refuse(`The machine could not settle its current work: ${errorMessage(error)}`);
    }
    if (await this.hasWorkForMove().catch(() => true)) return void await refuse("The machine is busy; it moves once it is idle.");
    if (!await (this.options.probeRelay ?? probeRelayManifest)(addresses.relayUrl).catch(() => false)) {
      return void await refuse("This machine cannot reach the server at that address.");
    }
    // Asked again after the server answered: a scheduled script may have
    // started meanwhile.
    if (await this.hasWorkForMove().catch(() => true)) return void await refuse("The machine is busy; it moves once it is idle.");
    if (late()) return void await refuse("This request is too old; nothing was changed.");
    try {
      await this.options.moveTransport(addresses);
    } catch (error) {
      return void await refuse(`The machine could not save its new address: ${errorMessage(error)}`);
    }
    void this.debugLogs.write("machine.transport.moved", { relayHost: new URL(addresses.relayUrl).host });
    // The answer leaves first; then the runtime starts again on its new
    // address, also when the answer cannot leave: its enrollment names the
    // new one already, and staying here would only look like it stayed.
    const answered = this.send({ type: "machine.transport.moved", requestId: body.requestId, ok: true }, replyTo).catch(() => undefined);
    let waited: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([answered, new Promise((resolve) => { waited = setTimeout(resolve, 5_000); })]);
    clearTimeout(waited);
    setTimeout(() => this.options.restartRuntime?.(), 500).unref?.();
  }

  /** One desktop request on this machine's scripts, always answered. Served
   *  off the inbound chain, like a picture request on the desktop: releasing
   *  held messages posts into large chats, and Stop or a turn must not wait
   *  behind it. A request made for an earlier run of this runtime is refused,
   *  so a frame kept and replayed after a restart changes nothing. */
  private answerScriptsRequest(body: MachineScriptsRequestBody, replyTo: string | undefined): void {
    const fail = (error: string): MachineLinkMessage => ({ type: "machine.scripts.result", requestId: body.requestId, ok: false, error });
    const answer = async (): Promise<void> => {
      const scripts = this.options.scripts;
      const expiresAt = typeof body.expiresAt === "string" ? Date.parse(body.expiresAt) : Number.NaN;
      let reply: MachineLinkMessage;
      if (!scripts) {
        reply = fail("This machine runtime does not host scheduled scripts; upgrade it.");
      } else if (body.instanceId !== this.instanceId) {
        reply = fail("The machine restarted since this was asked; try again.");
      } else if (!Number.isFinite(expiresAt) || this.now().getTime() > expiresAt + SCRIPTS_REQUEST_CLOCK_SKEW_MS) {
        // The desktop has stopped waiting for it: doing it now would be a
        // change the User was told did not happen.
        reply = fail("This request is too old; nothing was changed.");
      } else if (changesScripts(body.operation) && (this.fenced || this.options.hostStopCommitted?.())) {
        reply = fail("The machine is stopping after being idle; try again when it is awake.");
      } else {
        try {
          reply = { type: "machine.scripts.result", requestId: body.requestId, ok: true, result: await scripts.handle(body.operation) };
        } catch (error) {
          reply = fail(errorMessage(error));
        }
      }
      await this.send(reply, replyTo).catch(() => undefined);
    };
    if (!changesScripts(body.operation)) {
      // Reads need no order: a list must not wait behind held messages
      // being posted into a large chat.
      void answer().catch(() => undefined);
      return;
    }
    const run = this.scriptsQueue.then(answer);
    this.scriptsQueue = run.catch(() => undefined);
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
    if (this.fenced || this.options.hostStopCommitted?.()) return "deferred";
    if (peer && stableJson(this.trust.peer(peer.deviceId) ?? null) !== stableJson(peer)) throw new Error("Machine controller authorization changed.");
    if (event.kind === CHAT_CHANGES_EVENT_KIND) {
      if (!this.options.applyChatChanges || !isChatChangesPayload(body)) throw new Error("Unexpected chat change event.");
      const outcome = await this.options.applyChatChanges(event, body);
      // A turn may be waiting for exactly this change.
      if (outcome === "applied") this.scheduleAwaitingChatCheck(100);
      return outcome === "applied" ? "applied" : "deferred";
    }
    if (this.options.chatActions?.handles(event, body) && await this.isConversationDeleted(event.conversationId)) return "applied";
    if ((event.kind === "permission.decided" || event.kind === "choice.answered") && this.options.chatActions?.handles(event, body)) {
      // Delivery to a provider may wait; keep Stop and other chats moving.
      void this.applyChatAction(event, body).then(outcome => {
        if (outcome === "applied") return channel?.confirmApplied(event);
      }).catch(error => {
        channel?.retryFailedSoon(event.eventId);
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
        channel?.retryFailedSoon(event.eventId);
        void this.debugLogs.write("machine-host.approval.retry-pending", { approvalId: decision.approvalId, message: errorMessage(error) });
      });
      return "deferred";
    } else if (envelope.body.type === "machine.turn.cancel") {
      await this.options.eventStorage.nativeCommands().cancel(envelope.body.runId, conversationId, event.eventId);
      await this.handleBody(envelope.body, event);
    } else await this.handleBody(envelope.body, event);
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
        // Where the member works here is the enrolling desktop's to say.
        return !peer || (!body.sealedSettings && !body.machineRepository);
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
    await this.handleBody(payload.body, undefined, from);
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

  private async handleBody(body: MachineLinkMessage, event?: ChatEventEnvelope, replyTo = event?.originId): Promise<void> {
    if (this.fenced && body.type === "machine.turn.query") return;
    // Old, ephemeral frames cannot bypass the idle fence either. Current
    // peers use the durable inbox and retain these actions until apply.
    if (this.fenced && (isMachineDurableMessage(body) || body.type === "machine.settings.sync")) {
      throw new Error(this.moveFenced ? "The machine is moving to another address; this action must remain queued." : "The machine is stopping after idle; this action must remain queued.");
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
        this.desktopTakesCompactions = body.compactionDelegation === true;
        if (body.machineId) {
          await this.options.eventStorage.deviceEvents().saveHostMachineId(this.options.pairing.rendezvousId, body.machineId);
          this.homeMachineId = body.machineId;
          this.options.onDesktopMachineId?.(body.machineId);
        }
        if (body.machineName?.trim()) this.options.onDesktopMachineName?.(body.machineName.trim());
        this.eventChannel.start();
        await this.recoverCommands();
        return;
      case "machine.member.background.request":
        this.sendMemberBackgroundSnapshot(replyTo);
        return;
      case "machine.hello.request":
        // A (re)started desktop asks to be greeted: the same reconciliation
        // as after a peer change, whether or not the relay reported one.
        if (replyTo && replyTo !== this.options.pairing.issuer.originId) await this.sendHello(replyTo);
        else this.setDesktop(this.options.pairing.issuer.originId, { announce: true });
        return;
      case "machine.settings.sync":
        if (await this.importSettings(body.snapshot, "sync")) {
          void this.debugLogs.write("machine-host.settings.synced", { exportedAt: body.snapshot.exportedAt });
          await this.options.onSettingsImported?.();
        }
        return;
      case "machine.settings.sealed": {
        if (body.conversationId !== `machine-settings:${this.options.pairing.rendezvousId}`) throw new Error("Settings target the wrong enrolled machine.");
        const snapshot = await this.openRetainedSettings(body.ciphertext);
        if (await this.importSettings(snapshot as import("../../shared/machineLink").MachineSettingsSnapshot, "event")) await this.options.onSettingsImported?.();
        return;
      }
      case "machine.conversation.deleted": {
        // The owner deleted the chat. Nothing here may keep running against
        // it, and nothing that arrives later may write it back. The id names
        // the chat's directory here, so it must be a plain token.
        if (!isSafeChatId(body.conversationId)) {
          void this.debugLogs.write("machine-host.conversation.unsafe-id-refused", { length: String(body.conversationId).length });
          return;
        }
        await this.deleteReplicatedConversation(body.conversationId, body.deletedAt);
        return;
      }
      case "machine.conversation.sync":
      case "machine.conversation.sync.done":
        // Chats reach this machine as chat change events now. A copy from a
        // desktop that has not been updated yet is not applied: it would
        // overwrite this machine's own replies with a stale copy.
        void this.debugLogs.write("machine-host.conversation.legacy-copy-ignored", { type: body.type });
        return;
      case "machine.conversation.delta":
        if (replyTo === undefined || replyTo === this.options.pairing.issuer.originId) {
          void this.debugLogs.write("machine-host.conversation.legacy-copy-ignored", { type: body.type });
          return;
        }
        if (await this.isConversationDeleted(body.conversationId)) {
          void this.debugLogs.write("machine-host.conversation.deleted-copy-refused",
            { conversationId: body.conversationId, type: body.type });
          return;
        }
        // A phone talking to this machine while the desktop is away: its
        // message becomes this machine's own new message, and reaches the
        // desktop as this machine's chat change.
        await this.applyPhoneMessages(body);
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
        // A compaction also waits behind a turn of the same member that is
        // still waiting for its chat here: it must not compact first.
        if (!(await this.chatReadyFor(body)) || (body.compaction && this.memberHasWaitingTurn(body))) {
          // The chat state this request was made against has not been applied
          // here yet (its change events are still arriving): the turn runs
          // once it is.
          const waiting = this.turnsAwaitingChat.get(body.conversationId) ?? [];
          waiting.push({ request: body, since: Date.now() });
          this.turnsAwaitingChat.set(body.conversationId, waiting);
          void this.debugLogs.write("machine-host.turn.awaiting-chat", { conversationId: body.conversationId, runId: body.runId, chatHead: body.chatHead });
          this.scheduleAwaitingChatCheck(1_000);
          return;
        }
        void this.runTurn(body);
        return;
      case "machine.attachment.result":
        this.receiveAttachmentPart(body);
        return;
      case "machine.scripts.request":
        // Only the enrolling desktop reaches here: other peers may send only
        // hello and turn queries over the ephemeral link, and this type is
        // never a durable event.
        this.answerScriptsRequest(body, replyTo);
        return;
      case "machine.scripts.result":
      case "machine.scripts.changed":
        return;
      case "machine.transport.move":
        // Only the enrolling desktop reaches here (see above).
        void this.answerTransportMove(body, replyTo);
        return;
      case "machine.transport.moved":
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
    const waiting = (this.turnsAwaitingChat.get(conversationId) ?? []).map((entry) => entry.request);
    this.turnsAwaitingChat.delete(conversationId);
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
    // Pictures fetched for this chat were kept beside its copy; they go with it.
    await rm(path.join(userDataPath(), "chats", conversationId), { recursive: true, force: true }).catch((error: unknown) => {
      void this.debugLogs.write("machine-host.conversation.attachments-delete-error", { conversationId, message: errorMessage(error) });
    });
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

  /** Adds messages a phone delivered straight to this machine. They are
   *  this machine's own from here on: the save emits them to the desktop. */
  private async applyPhoneMessages(delta: MachineConversationDeltaBody): Promise<void> {
    // A chat whose first change has not reached this machine yet: the phone's
    // message is held (and tried again) rather than dropped.
    if ((await this.chatPresence(delta.conversationId))?.kind !== "chat") {
      if (!this.phoneMessagesWaiting.has(delta.conversationId)) {
        this.phoneMessagesWaiting.add(delta.conversationId);
        void this.debugLogs.write("machine-host.phone-message.unknown-chat", { conversationId: delta.conversationId });
      }
      throw new Error("The chat has not reached this machine yet; the phone's message waits for it.");
    }
    this.phoneMessagesWaiting.delete(delta.conversationId);
    // What a phone types is the User's message, nothing else: this machine
    // signs it as its own change, so a member's reply or a system line from
    // a phone would reach every device with this machine's authority.
    const typed = delta.messages.flatMap((message): ChatMessage[] =>
      message && typeof message.id === "string" && message.id && message.role === "user" && typeof message.content === "string"
        && typeof message.createdAt === "string"
        ? [{ id: message.id, role: "user", content: message.content, createdAt: message.createdAt, status: "done" }]
        : []);
    if (typed.length < delta.messages.length) {
      void this.debugLogs.write("machine-host.phone-message.refused", { conversationId: delta.conversationId, refused: delta.messages.length - typed.length });
    }
    await this.chat.applyReplicatedConversation(delta.conversationId, (existing) => {
      if (!existing) return undefined;
      const known = new Set(existing.messages.map((message) => message.id));
      const added = typed.filter((message) => !known.has(message.id));
      if (!added.length) return undefined;
      const messages = [...existing.messages, ...added]
        .map((message, index) => ({ message, index }))
        .sort((left, right) => left.message.createdAt.localeCompare(right.message.createdAt) || left.index - right.index)
        .map((entry) => entry.message);
      const updatedAt = delta.updatedAt && delta.updatedAt > existing.updatedAt ? delta.updatedAt : existing.updatedAt;
      return { ...existing, messages, updatedAt };
    });
    this.chat.onReplicatedConversationReady?.(delta.conversationId);
  }

  /** Chats a phone's message is waiting for, so that is logged once. */
  private readonly phoneMessagesWaiting = new Set<string>();

  private async chatPresence(conversationId: string, messageId?: string): Promise<{ kind: string; hasMessage: boolean } | undefined> {
    if (this.storage.conversationPresence) return this.storage.conversationPresence(conversationId, messageId);
    const conversation = await this.storage.getConversation(conversationId);
    return conversation && { kind: conversation.kind, hasMessage: !messageId || conversation.messages.some((message) => message.id === messageId) };
  }

  /** True once this machine holds the chat state a turn request was made
   *  against: the chat itself, and the desktop's last change event it names.
   *  A phone names no change; the message its member answers is enough. */
  private async chatReadyFor(request: MachineTurnRequestBody): Promise<boolean> {
    // A compaction answers no message: the chat itself is what it needs.
    const presence = await this.chatPresence(request.conversationId, request.compaction ? undefined : request.messageId);
    if (presence?.kind !== "chat") return false;
    if (!request.chatHead || request.chatHead.originSeq < 1) return request.compaction ? true : presence.hasMessage;
    const applied = await this.options.eventStorage.deviceEvents().appliedHead(request.chatHead.originId, request.chatHead.logScopeId);
    return applied >= request.chatHead.originSeq;
  }

  /** Runs the turns whose chat has arrived; fails the ones that waited too
   *  long for it, so a member never hangs on a chat that never comes. */
  private scheduleAwaitingChatCheck(delayMs: number): void {
    if (this.closed || this.awaitingChatTimer || !this.turnsAwaitingChat.size) return;
    this.awaitingChatTimer = setTimeout(() => {
      this.awaitingChatTimer = undefined;
      void this.releaseTurnsAwaitingChat().catch((error) => {
        void this.debugLogs.write("machine-host.turn.awaiting-chat-error", { message: errorMessage(error) });
      }).finally(() => this.scheduleAwaitingChatCheck(1_000));
    }, delayMs);
    this.awaitingChatTimer.unref?.();
  }

  private memberHasWaitingTurn(request: MachineTurnRequestBody): boolean {
    return (this.turnsAwaitingChat.get(request.conversationId) ?? []).some((entry) => entry.request.participantId === request.participantId);
  }

  private async releaseTurnsAwaitingChat(): Promise<void> {
    for (const [conversationId, waiting] of [...this.turnsAwaitingChat.entries()]) {
      const remaining: Array<{ request: MachineTurnRequestBody; since: number }> = [];
      for (const entry of waiting) {
        // In arrival order per member: a compaction never overtakes an
        // earlier turn of its member that is still waiting.
        const behindEarlier = Boolean(entry.request.compaction) && remaining.some((earlier) => earlier.request.participantId === entry.request.participantId);
        if (!behindEarlier && await this.chatReadyFor(entry.request)) {
          void this.runTurn(entry.request);
        } else if (Date.now() - entry.since > MACHINE_CHAT_WAIT_MS) {
          await this.finishQueuedTurn(entry.request, "failed", "The chat has not reached this machine yet, so the member did not start. Send the message again once the machine is connected.");
        } else {
          remaining.push(entry);
        }
      }
      if (remaining.length) this.turnsAwaitingChat.set(conversationId, remaining);
      else this.turnsAwaitingChat.delete(conversationId);
    }
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
    const reason = error && request.compaction ? compactionWording(error) : error;
    this.pendingTerminals.set(request.runId, {
      type: "machine.turn.finished",
      receiptId: command?.commandId ?? randomUUID(),
      conversationId: request.conversationId,
      runId: request.runId,
      participantId: request.participantId,
      status,
      messages,
      warnings: [],
      ...(reason ? { error: reason } : {}),
      ...compactionMark(request),
      finishedAt: this.now().toISOString()
    });
    this.persistOutbox();
    await this.flushPendingTerminals();
  }

  private queuedRunIds(): string[] {
    return [...this.turnsAwaitingChat.values()].flat().map((entry) => entry.request.runId);
  }

  private isQueuedRun(runId: string): boolean {
    return this.queuedRunIds().includes(runId);
  }

  private takeQueuedRun(runId: string): MachineTurnRequestBody | undefined {
    for (const [conversationId, waiting] of this.turnsAwaitingChat.entries()) {
      const index = waiting.findIndex((entry) => entry.request.runId === runId);
      if (index >= 0) {
        const [{ request }] = waiting.splice(index, 1);
        if (waiting.length === 0) {
          this.turnsAwaitingChat.delete(conversationId);
        }
        return request;
      }
    }
    return undefined;
  }

  private runTurn(request: MachineTurnRequestBody): Promise<void> {
    const previous = this.commandTasks.get(request.runId);
    if (previous) return previous;
    const scope = `${request.conversationId}:${request.participantId}`;
    // A Claude Code member takes the next message while it is still working,
    // as its dedicated CLI does (ChatService.reserveParticipantTurn): its
    // turns are admitted one after another, but each runs as soon as it is
    // admitted instead of waiting for the previous one to finish.
    // A compaction rewrites the session: it is admitted only once every
    // earlier command of this member has finished, not only been admitted.
    const shared = !request.compaction && request.participant.kind === "claude-code";
    const earlier = request.compaction ? [...(this.commandScopeTasks.get(scope) ?? [])] : [];
    let markAdmitted!: () => void;
    const admitted = new Promise<void>((resolve) => { markAdmitted = resolve; });
    const task = Promise.allSettled([this.commandSessions.get(scope) ?? Promise.resolve(), ...earlier])
      .then(() => this.admitTurn(request, shared ? markAdmitted : undefined))
      .finally(markAdmitted);
    const sessionTail = shared ? admitted : task;
    this.commandSessions.set(scope, sessionTail);
    this.commandTasks.set(request.runId, task);
    this.turnTasks.add(task);
    const scopeTasks = this.commandScopeTasks.get(scope) ?? new Set<Promise<void>>();
    scopeTasks.add(task);
    this.commandScopeTasks.set(scope, scopeTasks);
    void task.finally(() => {
      this.turnTasks.delete(task); this.commandTasks.delete(request.runId);
      if (this.commandSessions.get(scope) === sessionTail) this.commandSessions.delete(scope);
      scopeTasks.delete(task);
      if (!scopeTasks.size && this.commandScopeTasks.get(scope) === scopeTasks) this.commandScopeTasks.delete(scope);
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
    await this.handleBody(request);
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

  private async admitTurn(request: MachineTurnRequestBody, onAdmitted?: () => void): Promise<void> {
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
    onAdmitted?.();
    return this.executeTurn(request);
  }

  private async recoverCommands(): Promise<void> {
    if (this.closed || this.draining || this.fenced || !this.homeMachineId) return;
    let cursor: { commandId: string; logicalTs: string } | undefined;
    for (;;) {
      const commands = await this.options.eventStorage.nativeCommands().pending(cursor);
      for (const command of commands) {
        const event = await this.options.eventStorage.getChatEvent(command.eventId);
        if (!event?.logScopeId.startsWith(`device:${this.options.pairing.rendezvousId}:`)) continue;
        const body = await this.options.eventStorage.deviceEventBlobs().hydrate(event.payload) as MachineTurnRequestBody;
        if (body.type !== "machine.turn.request" || body.runId !== command.runId) throw new Error("The retained native command is corrupt.");
        if (!this.activeTurns.has(body.runId) && !this.commandTasks.has(body.runId) && !this.isQueuedRun(body.runId)) {
          await this.handleBody(body);
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

  private async runTurnOnThisMachine(request: MachineTurnRequestBody, signal: AbortSignal, progress: (update: ReviewProgress) => void): Promise<MachineTurnFinishedBody> {
    const result = await this.chat.runMachineHostedTurn(
      {
        conversationId: request.conversationId,
        participantId: request.participantId,
        messageId: request.messageId,
        runId: request.runId,
        pendingMessageId: request.pendingMessageId
      },
      signal,
      progress
    );
    return this.finishedBody(request, finishedTurnStatus(result.messages, signal.aborted), result);
  }

  private finishedBody(request: MachineTurnRequestBody, status: MachineTurnFinishedBody["status"],
    result: { messages: ChatMessage[]; warnings: string[]; contextUsage?: MachineTurnFinishedBody["contextUsage"] }): MachineTurnFinishedBody {
    return {
      type: "machine.turn.finished",
      conversationId: request.conversationId,
      runId: request.runId,
      participantId: request.participantId,
      status,
      messages: result.messages,
      warnings: result.warnings,
      ...(result.contextUsage ? { contextUsage: result.contextUsage } : {}),
      ...compactionMark(request),
      finishedAt: this.now().toISOString()
    };
  }

  private async importSettings(snapshot: import("../../shared/machineLink").MachineSettingsSnapshot, source: string): Promise<boolean> {
    const exportedAt = typeof snapshot?.exportedAt === "string" ? snapshot.exportedAt : "";
    if (exportedAt && this.newestSettings && exportedAt < this.newestSettings.exportedAt) {
      void this.debugLogs.write("machine-host.settings.older-skipped", { source, exportedAt, newest: this.newestSettings.exportedAt });
      return false;
    }
    await this.settings.importMachineSettingsSnapshot(snapshot);
    if (exportedAt && (!this.newestSettings || exportedAt >= this.newestSettings.exportedAt)) this.newestSettings = { exportedAt, snapshot };
    return true;
  }

  /** Compacts a member here with the run id the desktop chose. No progress
   *  frames: the desktop shows a compaction's progress itself, as it does
   *  for a local member; the outcome line and the new context use travel
   *  with the result. */
  private async compactOnThisMachine(request: MachineTurnRequestBody, compaction: NonNullable<MachineTurnRequestBody["compaction"]>, signal: AbortSignal): Promise<MachineTurnFinishedBody> {
    if (!this.chat.runMachineHostedCompaction) throw new Error("This machine cannot compact members.");
    const result = await this.chat.runMachineHostedCompaction({
      conversationId: request.conversationId,
      participantId: request.participantId,
      runId: request.runId,
      ...normalizeMachineTurnCompaction(compaction)
    }, signal);
    return this.finishedBody(request, signal.aborted ? "interrupted" : "completed", result);
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
    let restoreSettings: import("../../shared/machineLink").MachineSettingsSnapshot | undefined;
    try {
      if (request.sealedSettings) {
        const snapshot = await this.openRetainedSettings(request.sealedSettings) as import("../../shared/machineLink").MachineSettingsSnapshot;
        const newest = this.newestSettings;
        const exportedAt = typeof snapshot?.exportedAt === "string" ? snapshot.exportedAt : "";
        if (newest && exportedAt && exportedAt < newest.exportedAt) restoreSettings = newest.snapshot;
        await this.settings.importMachineSettingsSnapshot(snapshot);
        if (exportedAt && !restoreSettings) this.newestSettings = { exportedAt, snapshot };
        await this.options.onSettingsImported?.();
      }
      if (controller.signal.aborted || await this.isConversationDeleted(request.conversationId)) {
        throw new Error("This chat was deleted or its turn was cancelled before admission.");
      }
      // The member works in this machine's copy of the project.
      await this.chat.applyMachineRepository?.(request.conversationId, request.machineRepository);
      terminal = request.compaction
        ? await this.compactOnThisMachine(request, request.compaction, controller.signal)
        : await this.runTurnOnThisMachine(request, controller.signal, progress);
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
        ...compactionMark(request),
        finishedAt: this.now().toISOString()
      };
    } finally {
      this.activeTurns.delete(request.runId);
      this.activeTurnConversations.delete(request.runId);
    }
    if (restoreSettings) {
      try {
        if (await this.importSettings(restoreSettings, "restore")) await this.options.onSettingsImported?.();
      } catch (error) {
        void this.debugLogs.write("machine-host.settings.restore-error", { runId: request.runId, message: errorMessage(error) });
      }
    }
    // The result is kept (on disk when configured) until the desktop
    // acknowledges it: a desktop that is away, a relay that drops the frame,
    // or a restart of this runtime all get it delivered again.
    terminal.receiptId = (await this.options.eventStorage.nativeCommands().forRun(request.runId))?.commandId ?? randomUUID();
    this.pendingTerminals.set(request.runId, terminal);
    this.persistOutbox();
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
        status: finishedTurnStatus(result.messages, run.aborted, failed),
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

  /** Whether the enrolling desktop is here and runs the compactions members
   *  here ask for themselves. When it is not, the member's compaction runs
   *  on this machine directly, as it always has. */
  canDelegateCompaction(): boolean {
    return this.desktopTakesCompactions && Boolean(this.desktopDeviceId) && !this.closed && !this.draining;
  }

  /** A member here asked to compact its own context: the desktop runs it as
   *  one the User asked for, and sends it back here as a compaction command.
   *  One event per run id, so a retry is the same request. */
  delegateCompaction(request: MachineCompactionDelegateRequest): Promise<void> {
    return this.enqueueOutbound(() => this.publishToPeer(this.options.pairing.issuer.originId, {
      type: "machine.compaction.delegate",
      conversationId: request.conversationId,
      participantId: request.participantId,
      runId: request.runId,
      ...(request.instructions ? { instructions: request.instructions } : {})
    }, `machine-compaction:${request.runId}`));
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
    // Through the hub nobody is waited on: each device reads the hub's order.
    if (this.options.hubMode) return [];
    const room = this.options.pairing.rendezvousId;
    const issuer = { deviceId: this.options.pairing.issuer.originId, channelId: room };
    const peers = this.peers.recipients()
      .filter((peer) => peer.channelId === room && peer.deviceId !== issuer.deviceId);
    return [issuer, ...peers];
  }

  /** Where this machine's own chat changes go: the desktop that installed it,
   *  and every other machine of the owner it knows (each holds every chat).
   *  Phones are not addressed; they read the chat from the desktop. Through
   *  the hub nobody is addressed: every device reads the hub's order. */
  chatChangeRecipients(): Array<{ deviceId: string; channelId: string }> {
    if (this.options.hubMode) return [];
    return [
      { deviceId: this.options.pairing.issuer.originId, channelId: this.options.pairing.rendezvousId },
      ...this.peers.machineRecipients()
    ];
  }

  /** The device identity of another of the owner's machines, by machine id:
   *  the only device that may change its members' replies. */
  machineOriginId(machineId: string): string | undefined {
    return this.trust.peers().find((peer) => peer.role === "machine" && peer.machineId === machineId)?.deviceId;
  }

  /** A chat save committed change events: send them now. */
  nudgeEventChannel(): void {
    // A save during startup can commit before the channel exists; the
    // channel sends what is waiting when it starts.
    if (this.eventChannel) this.eventChannel.nudge();
    this.peers.nudge();
  }

  /** Recipients for artifact actions committed directly with their store write. */
  chatActionRecipients(): Array<{ deviceId: string; channelId: string }> {
    return this.resultRecipients();
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
        // Through the hub nobody is named: every device reads its order.
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Adds to a set that keeps at most `limit` entries, dropping the oldest. */
function rememberBounded(set: Set<string>, value: string, limit = 5_000): void {
  set.delete(value);
  set.add(value);
  if (set.size > limit) set.delete(set.values().next().value as string);
}

/** A relay's two addresses as a move names them: the room socket and the
 *  mailbox, on one host, over TLS (plain only on this computer). */
function relayAddresses(relayUrl: unknown, outboxUrl: unknown, currentRelayUrl: string | undefined): { relayUrl: string; outboxUrl: string } | undefined {
  if (typeof relayUrl !== "string" || typeof outboxUrl !== "string") return undefined;
  try {
    const room = new URL(relayUrl);
    const mailbox = new URL(outboxUrl);
    const local = (url: URL) => url.hostname === "127.0.0.1" || url.hostname === "localhost";
    // This computer is a place only for a machine already on it (a test).
    const alreadyLocal = (() => { try { return local(new URL(currentRelayUrl ?? "")); } catch { return false; } })();
    if (local(room) && !alreadyLocal) return undefined;
    const secure = (room.protocol === "wss:" && mailbox.protocol === "https:") || (local(room) && room.protocol === "ws:" && mailbox.protocol === "http:");
    if (!secure || room.host !== mailbox.host || room.pathname !== "/v1/relay" || mailbox.pathname !== "/v1/mailbox/events") return undefined;
    return { relayUrl: room.toString(), outboxUrl: mailbox.toString() };
  } catch {
    return undefined;
  }
}

/** The relay at this room address answers with its manifest. */
async function probeRelayManifest(relayUrl: string): Promise<boolean> {
  const room = new URL(relayUrl);
  const manifest = new URL("/v1/relay/manifest", `${room.protocol === "wss:" ? "https:" : "http:"}//${room.host}`);
  const response = await fetch(manifest, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) return false;
  const body = await response.json() as { ok?: unknown; manifest?: { provider?: unknown } };
  return body.ok === true && typeof body.manifest?.provider === "string";
}

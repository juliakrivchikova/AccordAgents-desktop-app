/**
 * Machine link, desktop side (machines transport, work items 3–5).
 *
 * One relay room per enrolled machine: the desktop sits in the room as
 * `desktop`, the machine as `machine` with its device id. Every message is
 * sealed with the machine pairing's seal key and targeted at the peer's device
 * id. The desktop replicates conversations and settings to the machine and
 * dispatches participant turns to it; the machine answers with progress and
 * the finished participant messages.
 */

import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  MACHINE_LINK_PROTOCOL,
  isMachineLinkEnvelope,
  type MachineConversationDeltaBody,
  type MachineHelloBody,
  type MachineLinkEnvelope,
  type MachineLinkMessage,
  type MachineLinkStatus,
  type MachineRecord,
  type MachineTurnFinishedBody
} from "../../shared/machineLink";
import type { MobilePairingPackage } from "../../shared/mobilePairing";
import type { ChatAppToolApproval, ChatAppToolApprovalPolicy, ChatAppToolApprovalRequest, ChatMessage, Conversation, ReviewProgress } from "../../shared/types";
import type { MachineTurnDispatchRequest, MachineTurnDispatchResult, MachineTurnDispatcher } from "./chat";
import type { DebugLogService } from "./debugLogs";
import { openMobileRelayPayload, sealMobileRelayPayload } from "./mobileRelaySealing";
import { RelayTunnelClient } from "./relayTunnelClient";
import type { SettingsService } from "./settings";
import { isMachineDurableMessage, machineCommandId } from "../../shared/machineLink";
import { isDeviceEventPacket } from "../../shared/deviceEventChannel";
import { DeviceEventChannel } from "./deviceEventChannel";
import type { ChatEventLogService } from "./chatEventLog";
import type { StorageService } from "./storage";

export interface MachineLinkOptions {
  appVersion: string;
  desktopDeviceId: string;
  eventStorage: StorageService;
  eventLog: ChatEventLogService;
  reconnectDelayMs?: number;
  /** Test seam: builds the relay client for one machine room. */
  createClient?: (pairing: MobilePairingPackage) => RelayTunnelClient;
  now?: () => Date;
}

export type { MachineLinkStatus };

export interface MachineApprovalEvent {
  machineId: string;
  conversationId: string;
  approval: ChatAppToolApproval;
  policies?: ChatAppToolApprovalPolicy[];
}

/** A turn result for a run this desktop no longer tracks (it restarted
 *  meanwhile), any status. The listener stores it; the machine is told to
 *  drop the result (and a held stop is dropped) only after that. */
export interface MachineLateTerminalEvent {
  machineId: string;
  machineName: string;
  conversationId: string;
  runId: string;
  status: "completed" | "interrupted" | "failed" | "unconfirmed";
  messages: ChatMessage[];
  warnings: string[];
  error?: string;
  finishedAt?: string;
  receiptId?: string;
}

interface MachineConnection {
  eventChannel?: DeviceEventChannel;
  record: MachineRecord;
  pairing: MobilePairingPackage;
  client: RelayTunnelClient;
  machineDeviceId?: string;
  settingsSynced: boolean;
  /** Per conversation: the message ids and updatedAt values the machine holds. */
  replicated: Map<string, Map<string, string>>;
  /** Replication of one conversation is serialized so a snapshot push and a
   *  turn dispatch cannot interleave their deltas. */
  replication: Map<string, Promise<void>>;
  pendingTurns: Map<string, {
    resolve: (result: MachineTurnDispatchResult) => void;
    progress?: (progress: ReviewProgress) => void;
    /** Runtime instance the turn was dispatched to (from the machine's hello). */
    instanceId?: string;
    /** True once machine.turn.request has left; only then can the machine be
     *  asked whether it holds the run. */
    dispatched: boolean;
  }>;
  /** Stops the machine has not confirmed yet (run id → conversation id).
   *  Rule 2: a Stop is stored (in the machine record, so it survives a desktop
   *  restart) and delivered again when the machine is back; "stopped" appears
   *  only after the machine confirms. */
  pendingCancels: Map<string, string>;
  /** Serializes machine-record writes for this connection. */
  persist: Promise<void>;
  /** Latest snapshot waiting for the running replication pass, per
   *  conversation: many snapshots in flight collapse into one more pass. */
  replicationQueued: Map<string, Conversation>;
  /** Approval decisions waiting for the machine's outcome. */
  pendingApprovals: Map<string, { resolve: () => void; reject: (error: Error) => void }>;
  /** run id → conversation id for turns this desktop waits on. */
  pendingTurnConversations: Map<string, string>;
  /** Dispatched turns whose result is not stored yet (persisted in the
   *  machine record, so a restarted desktop still asks about them). */
  pendingRuns: Map<string, string>;
  /** Inbound messages are decrypted and applied strictly in arrival order. */
  inbound: Promise<void>;
  /** Sealing and frame writes preserve command order, including Stop. */
  outbound: Promise<void>;
  /** A hello arrived on this connection; until then the machine is asked
   *  to greet a desktop that just connected. */
  helloSeen: boolean;
  helloRequestTimer?: ReturnType<typeof setTimeout>;
  /** Start time of the newest runtime instance seen; a late hello from an
   *  older instance is ignored. */
  latestInstanceStartedAt?: string;
  /** Monotonic start counter of the newest runtime instance seen (preferred
   *  over the wall-clock start time). */
  latestInstanceSequence?: number;
}

/** How long a delivered Stop may go unconfirmed before the User is told the
 *  machine has not answered yet. */
const STOP_CONFIRM_GRACE_MS = 5_000;
/** How long the desktop waits for a machine to report the outcome of an
 *  approval decision. */
const APPROVAL_RESULT_TIMEOUT_MS = 60_000;
const TURN_ACK_TIMEOUT_MS = 24 * 60 * 60_000;
/** How long a freshly connected desktop waits for the machine's own hello
 *  before asking for one. */
const HELLO_REQUEST_GRACE_MS = 750;

export class MachineLinkService implements MachineTurnDispatcher {
  private readonly emitter = new EventEmitter();
  private readonly approvalListeners: Array<(event: MachineApprovalEvent) => Promise<void> | void> = [];
  private readonly lateTerminalListeners: Array<(event: MachineLateTerminalEvent) => Promise<void> | void> = [];
  private readonly runStartedListeners: Array<(event: { conversationId: string; runId: string }) => Promise<void> | void> = [];
  private readonly backDeltaListeners: Array<(delta: { machineId: string; conversationId: string; messages: ChatMessage[]; acknowledge?: () => void }) => Promise<void> | void> = [];
  private conversationLoader?: (conversationId: string) => Promise<Conversation | undefined>;
  private readonly connections = new Map<string, MachineConnection>();
  private readonly seenMessageIds = new Set<string>();
  private readonly now: () => Date;

  constructor(
    private readonly settings: Pick<SettingsService, "listMachines" | "saveMachine" | "removeMachine" | "getMachinePairing" | "exportMachineSettingsSnapshot">,
    private readonly debugLogs: Pick<DebugLogService, "write">,
    private readonly options: MachineLinkOptions
  ) {
    this.now = options.now ?? (() => new Date());
  }

  onStatus(listener: (status: MachineLinkStatus[]) => void): () => void {
    this.emitter.on("status", listener);
    return () => this.emitter.off("status", listener);
  }

  onRunStarted(listener: (event: { conversationId: string; runId: string }) => Promise<void> | void): () => void {
    this.runStartedListeners.push(listener);
    return () => { const index = this.runStartedListeners.indexOf(listener); if (index >= 0) this.runStartedListeners.splice(index, 1); };
  }

  /** Conversation changes made on a machine (approval cards, requests). The
   *  listener calls `acknowledge` once the messages are stored. */
  onConversationBackDelta(listener: (delta: { machineId: string; conversationId: string; messages: ChatMessage[]; acknowledge?: () => void }) => Promise<void> | void): () => void {
    this.backDeltaListeners.push(listener);
    return () => { const index = this.backDeltaListeners.indexOf(listener); if (index >= 0) this.backDeltaListeners.splice(index, 1); };
  }

  /** An approval raised or answered by a member on a machine. A listener
   *  may return a promise; the machine's decision outcome waits for it, so
   *  the card call returns only after the desktop stored the approval. */
  onApproval(listener: (event: MachineApprovalEvent) => Promise<void> | void): () => void {
    this.approvalListeners.push(listener);
    return () => {
      const index = this.approvalListeners.indexOf(listener);
      if (index >= 0) {
        this.approvalListeners.splice(index, 1);
      }
    };
  }

  private async emitApproval(event: MachineApprovalEvent): Promise<void> {
    await Promise.all(this.approvalListeners.map((listener) => listener(event)));
  }

  onLateTerminal(listener: (event: MachineLateTerminalEvent) => Promise<void> | void): () => void {
    this.lateTerminalListeners.push(listener);
    return () => {
      const index = this.lateTerminalListeners.indexOf(listener);
      if (index >= 0) {
        this.lateTerminalListeners.splice(index, 1);
      }
    };
  }

  private async emitLateTerminal(event: MachineLateTerminalEvent): Promise<void> {
    if (!this.lateTerminalListeners.length) throw new Error("No chat owner is available to store the machine's outcome.");
    await Promise.all(this.lateTerminalListeners.map((listener) => listener(event)));
  }

  /** Lets the link fetch the desktop's current copy of a chat when a machine
   *  asks for the first copy again. */
  setConversationLoader(loader: (conversationId: string) => Promise<Conversation | undefined>): void {
    this.conversationLoader = loader;
  }

  /** Forwards the desktop's decision on a machine-raised approval. */
  async respondToMachineApproval(request: {
    machineId: string;
    conversationId: string;
    approvalId: string;
    approve: boolean;
    scope?: "once" | "chat";
    draftOverride?: ChatAppToolApprovalRequest;
    codexDecisionId?: string;
  }): Promise<void> {
    const connection = this.connections.get(request.machineId);
    if (!connection?.machineDeviceId) {
      throw new Error("The machine that raised this approval is not connected; the decision will be possible once it reconnects.");
    }
    // The call resolves with the machine's outcome: an edited proposal or a
    // native decision the machine rejects is an error here, not a silent no-op.
    const outcome = new Promise<void>((resolve, reject) => {
      connection.pendingApprovals.set(request.approvalId, { resolve, reject });
    });
    const timeout = setTimeout(() => {
      const pending = connection.pendingApprovals.get(request.approvalId);
      if (pending) {
        connection.pendingApprovals.delete(request.approvalId);
        pending.reject(new Error(`Machine ${connection.record.name} did not confirm the decision in time.`));
      }
    }, APPROVAL_RESULT_TIMEOUT_MS);
    timeout.unref?.();
    try {
      await this.send(connection, {
        type: "machine.approval.decision",
        conversationId: request.conversationId,
        approvalId: request.approvalId,
        approve: request.approve,
        ...(request.scope ? { scope: request.scope } : {}),
        ...(request.draftOverride ? { draftOverride: request.draftOverride } : {}),
        ...(request.codexDecisionId ? { codexDecisionId: request.codexDecisionId } : {}),
        decidedAt: this.now().toISOString()
      });
      await outcome;
    } finally {
      clearTimeout(timeout);
      connection.pendingApprovals.delete(request.approvalId);
    }
    void this.debugLogs.write("machine-link.approval.decision-sent", {
      machineId: request.machineId,
      conversationId: request.conversationId,
      approvalId: request.approvalId,
      approve: request.approve,
      scope: request.scope
    });
  }

  async start(): Promise<void> {
    const machines = await this.settings.listMachines();
    void this.debugLogs.write("machine-link.start", { machines: machines.length, desktopDeviceId: this.options.desktopDeviceId });
    for (const record of machines) {
      await this.connectMachine(record).catch((error) => {
        void this.debugLogs.write("machine-link.connect.error", { machineId: record.id, message: errorMessage(error) });
      });
    }
  }

  async connectMachine(record: MachineRecord): Promise<void> {
    const existing = this.connections.get(record.id);
    if (existing) {
      existing.record = record;
      return;
    }
    const pairing = await this.settings.getMachinePairing(record.pairingKey);
    if (!pairing) {
      throw new Error(`Machine ${record.name} has no pairing package.`);
    }
    if (!pairing.relayUrl) {
      throw new Error(`Machine ${record.name} pairing has no relay URL.`);
    }
    const client = this.options.createClient?.(pairing) ?? new RelayTunnelClient({
      relayUrl: pairing.relayUrl,
      rendezvousId: pairing.rendezvousId,
      role: "desktop",
      deviceId: this.options.desktopDeviceId,
      capability: pairing.fingerprint,
      streamId: `${pairing.stableRoutingId}:machine`,
      reconnectDelayMs: this.options.reconnectDelayMs
    });
    const connection: MachineConnection = {
      record,
      pairing,
      client,
      settingsSynced: false,
      replicated: new Map(),
      replication: new Map(),
      pendingTurns: new Map(),
      pendingCancels: new Map((record.pendingCancels ?? []).map((cancel) => [cancel.runId, cancel.conversationId])),
      pendingRuns: new Map((record.pendingRuns ?? []).map((run) => [run.runId, run.conversationId])),
      persist: Promise.resolve(),
      replicationQueued: new Map(),
      pendingApprovals: new Map(),
      pendingTurnConversations: new Map(),
      inbound: Promise.resolve(),
      outbound: Promise.resolve(),
      helloSeen: false
    };
    this.connections.set(record.id, connection);
    if (record.deviceId && record.lastHello?.publicKeyDerBase64) {
      // A machine can post its reply and stop before this desktop returns.
      // The pinned identity lets the mailbox deliver without a new live hello.
      this.initializeEventChannel(connection, record.deviceId, record.lastHello.publicKeyDerBase64);
      connection.eventChannel?.start();
    }
    client.on("peer", (event) => {
      void this.debugLogs.write("machine-link.peer", {
        machineId: record.id,
        type: event.type,
        ...(event.type === "ready" ? { peers: event.peers.map((peer) => `${peer.role}:${peer.deviceId ?? ""}`) } : {}),
        ...(event.type === "peer-connected" || event.type === "peer-disconnected" ? { peer: `${event.peer.role}:${event.peer.deviceId ?? ""}` } : {})
      });
      if (event.type === "ready") {
        const machine = event.peers.find((peer) => peer.role === "machine");
        this.setMachinePeer(connection, machine?.deviceId);
      } else if (event.type === "peer-connected" && event.peer.role === "machine") {
        this.setMachinePeer(connection, event.peer.deviceId);
      } else if (event.type === "peer-disconnected" && event.peer.role === "machine") {
        this.setMachinePeer(connection, undefined);
      }
    });
    client.on("message", (message) => {
      // Strictly in order from decryption on: a large progress frame must
      // not be overtaken by the small finished result behind it.
      connection.inbound = connection.inbound
        .then(() => this.handleMessage(connection, message.ciphertext))
        .catch((error) => {
          void this.debugLogs.write("machine-link.message.error", { machineId: record.id, message: errorMessage(error) });
        });
    });
    client.on("state", (state) => {
      void this.debugLogs.write("machine-link.tunnel.state", { machineId: record.id, state });
      if (state !== "connected") {
        this.setMachinePeer(connection, undefined);
      }
    });
    client.on("error", (error) => {
      void this.debugLogs.write("machine-link.tunnel.error", { machineId: record.id, message: error.message });
    });
    await client.connect().catch((error) => {
      void this.debugLogs.write("machine-link.connect.retrying", { machineId: record.id, message: errorMessage(error) });
    });
  }

  async disconnectMachine(machineId: string): Promise<void> {
    const connection = this.connections.get(machineId);
    if (!connection) {
      return;
    }
    this.connections.delete(machineId);
    for (const pending of connection.pendingTurns.values()) {
      pending.resolve({ status: "failed", messages: [], warnings: [], error: "The machine was removed while the turn was running." });
    }
    connection.pendingTurns.clear();
    connection.eventChannel?.close();
    connection.client.close();
    this.emitStatus();
  }

  close(): void {
    for (const connection of this.connections.values()) {
      connection.eventChannel?.close();
      connection.client.close();
    }
    this.connections.clear();
  }

  status(): MachineLinkStatus[] {
    return [...this.connections.values()].map((connection) => ({
      machineId: connection.record.id,
      name: connection.record.name,
      connected: Boolean(connection.machineDeviceId),
      deviceId: connection.machineDeviceId ?? connection.record.deviceId ?? undefined,
      lastSeenAt: connection.record.lastSeenAt,
      lastHello: connection.record.lastHello,
      ...(connection.record.lastHello?.outboxError ? { warning: `Results on ${connection.record.name} are not kept on disk: ${connection.record.lastHello.outboxError}` } : {})
    }));
  }

  isMachineConnected(machineId: string): boolean {
    return Boolean(this.connections.get(machineId)?.machineDeviceId);
  }

  async cancelMachineRun(request: { machineId: string; conversationId: string; runId: string; onStopPending?: (machineName: string) => Promise<void> }): Promise<void> {
    const connection = this.connections.get(request.machineId);
    if (!connection) {
      throw new Error("The member's machine is not enrolled.");
    }
    connection.pendingCancels.set(request.runId, request.conversationId);
    await this.persistCancels(connection, true);
    const waiting = async (): Promise<void> => {
      if (connection.pendingCancels.has(request.runId)) {
        await request.onStopPending?.(connection.record.name);
      }
    };
    try {
      await this.send(connection, { type: "machine.turn.cancel", conversationId: request.conversationId, runId: request.runId });
      if (!connection.machineDeviceId) await waiting();
      const grace = setTimeout(() => { void waiting().catch((error) => {
        void this.debugLogs.write("machine-link.stop.feedback-error", { runId: request.runId, message: errorMessage(error) });
      }); }, STOP_CONFIRM_GRACE_MS);
      grace.unref?.();
    } catch {
      await waiting();
    }
  }

  /** Pushes the current desktop settings to every connected machine (call
   *  after settings change). */
  async syncSettings(): Promise<void> {
    const snapshot = await this.settings.exportMachineSettingsSnapshot();
    for (const connection of this.connections.values()) {
      if (!connection.eventChannel) {
        connection.settingsSynced = false;
        continue;
      }
      await this.send(connection, { type: "machine.settings.sync", snapshot });
      connection.settingsSynced = true;
    }
  }

  /** Replicates a conversation to the machines that host one of its
   *  participants: a full copy the first time, message deltas afterwards. */
  async replicateConversation(conversation: Conversation): Promise<void> {
    const participants = (conversation.metadata as { participants?: Array<{ homeMachineId?: unknown }> }).participants ?? [];
    const machineIds = new Set(
      participants
        .map((participant) => participant.homeMachineId)
        .filter((id): id is string => typeof id === "string" && id.length > 0)
    );
    for (const machineId of machineIds) {
      const connection = this.connections.get(machineId);
      if (!connection?.eventChannel) {
        continue;
      }
      await this.waitForIntroduction(connection);
      await this.replicateTo(connection, conversation);
    }
  }

  async runTurn(request: MachineTurnDispatchRequest): Promise<MachineTurnDispatchResult> {
    const machineId = request.participant.homeMachineId ?? "";
    const connection = this.connections.get(machineId);
    if (!connection) {
      return { status: "failed", messages: [], warnings: [], error: `@${request.participant.handle} is hosted on a machine that is not enrolled on this desktop.` };
    }
    if (!connection.eventChannel && !connection.machineDeviceId) {
      return { status: "failed", messages: [], warnings: [], error: `@${request.participant.handle} is hosted on ${connection.record.name}, which is not connected.` };
    }
    const interrupted: MachineTurnDispatchResult = { status: "interrupted", messages: [], warnings: [] };
    if (request.signal?.aborted) {
      return interrupted;
    }
    // Stop can arrive at any point of the preparation; a cancelled turn is
    // never dispatched, and one already dispatched is cancelled on the machine.
    let dispatchAttempted = false;
    let intentRecorded = false;
    let stopRequested = false;
    const stopPending = (reason: string): void => {
      if (!connection.pendingTurns.has(request.runId)) {
        return;
      }
      void this.debugLogs.write("machine-link.stop.waiting", { machineId: connection.record.id, runId: request.runId, reason });
      request.onStopPending?.(connection.record.name);
    };
    const onAbort = (): void => {
      if (!dispatchAttempted || stopRequested) {
        return;
      }
      stopRequested = true;
      void this.cancelMachineRun({
        machineId, conversationId: request.conversation.id, runId: request.runId,
        onStopPending: async () => stopPending("no confirmation")
      }).catch((error: unknown) => stopPending(errorMessage(error)));
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });
    const result = new Promise<MachineTurnDispatchResult>((resolve) => {
      connection.pendingTurns.set(request.runId, { resolve, progress: request.progress, instanceId: connection.record.lastHello?.instanceId, dispatched: false });
    });
    connection.pendingTurnConversations.set(request.runId, request.conversation.id);
    const timeout = setTimeout(() => {
      const pending = connection.pendingTurns.get(request.runId);
      if (pending) {
        connection.pendingTurns.delete(request.runId);
        pending.resolve({ status: "failed", messages: [], warnings: [], error: "The machine did not finish the turn within the run timeout." });
      }
    }, TURN_ACK_TIMEOUT_MS);
    timeout.unref?.();
    try {
      await this.waitForIntroduction(connection, request.signal);
      if (request.signal?.aborted) return interrupted;
      // The request retains its settings even if neither endpoint is online
      // at the same time. Seal before the append: settings can contain secrets
      // and can exceed one relay frame on the User's actual skill catalogue.
      const sealedSettings = await sealMobileRelayPayload(await this.settings.exportMachineSettingsSnapshot(), connection.pairing.relaySealKeyBase64);
      if (request.signal?.aborted) {
        return interrupted;
      }
      await this.replicateTo(connection, request.conversation);
      // A copy queued meanwhile (a machine asked for the chat again, a restart
      // cleared the inventory) must have left before the request follows it.
      await this.settleReplication(connection, request.conversation.id);
      if (request.signal?.aborted) {
        return interrupted;
      }
      // Persist the intent before any request can reach the provider. During
      // this preparation a hello must not query it; after a process restart
      // the recorded intent is reconciled, never automatically replayed.
      connection.pendingRuns.set(request.runId, request.conversation.id);
      intentRecorded = true;
      await this.persistCancels(connection, true);
      if (request.signal?.aborted) {
        return interrupted;
      }
      if (!connection.machineDeviceId) await request.onMachineWaiting?.(connection.record.name);
      await this.send(connection, {
        type: "machine.turn.request",
        conversationId: request.conversation.id,
        participantId: request.participant.id,
        participant: request.participant,
        messageId: request.triggerMessage.id,
        runId: request.runId,
        pendingMessageId: request.pendingMessageId,
        sealedSettings,
        requestedAt: this.now().toISOString()
      }, () => {
        // Queueing and sealing are still preparation. This synchronous fence
        // is the first point at which the request may leave for the machine.
        if (request.signal?.aborted) throw new Error("Stopped before machine dispatch.");
        dispatchAttempted = true;
        const entry = connection.pendingTurns.get(request.runId);
        if (entry) entry.dispatched = true;
      });
      if (request.signal?.aborted) {
        onAbort();
      }
      return await result;
    } catch (error) {
      if (request.signal?.aborted && !dispatchAttempted) return interrupted;
      return { status: "failed", messages: [], warnings: [], error: errorMessage(error) };
    } finally {
      if (intentRecorded && !dispatchAttempted) {
        // No provider could have seen the command. A failed cleanup remains
        // safe to reconcile as unknown after restart.
        connection.pendingRuns.delete(request.runId);
        await this.persistCancels(connection);
      }
      connection.pendingTurns.delete(request.runId);
      connection.pendingTurnConversations.delete(request.runId);
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", onAbort);
    }
  }

  private replicateTo(connection: MachineConnection, conversation: Conversation): Promise<void> {
    // Snapshots arrive faster than a pass over a large chat takes; only the
    // newest one matters, so a pass already queued just picks it up.
    const queued = connection.replicationQueued;
    const alreadyQueued = queued.has(conversation.id);
    queued.set(conversation.id, conversation);
    if (alreadyQueued) {
      return connection.replication.get(conversation.id) ?? Promise.resolve();
    }
    const previous = connection.replication.get(conversation.id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => {
      const latest = queued.get(conversation.id) ?? conversation;
      queued.delete(conversation.id);
      return this.replicateNow(connection, latest);
    });
    connection.replication.set(conversation.id, next.then(() => undefined, () => undefined));
    return next;
  }

  private waitForIntroduction(connection: MachineConnection, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted || connection.eventChannel) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const finish = (error?: Error): void => {
        clearTimeout(timer);
        this.emitter.off("status", check);
        signal?.removeEventListener("abort", aborted);
        if (error) reject(error); else resolve();
      };
      const check = (): void => {
        if (!this.connections.has(connection.record.id)) finish(new Error("The machine was removed while connecting."));
        else if (connection.eventChannel) finish();
      };
      const aborted = (): void => finish();
      const timer = setTimeout(() => finish(new Error(`Machine ${connection.record.name} did not finish introducing its event channel.`)), 15_000);
      timer.unref?.();
      this.emitter.on("status", check);
      signal?.addEventListener("abort", aborted, { once: true });
      check();
    });
  }

  private async settleReplication(connection: MachineConnection, conversationId: string): Promise<void> {
    for (let round = 0; round < 8; round += 1) {
      const chain = connection.replication.get(conversationId);
      if (!chain) {
        return;
      }
      await chain;
      if (connection.replication.get(conversationId) === chain) {
        return;
      }
    }
  }

  /** Rule 2: stops waiting for a machine are part of its record, so a
   *  desktop restart does not forget them. */
  private persistCancels(connection: MachineConnection, required = false): Promise<void> {
    const pendingCancels = [...connection.pendingCancels.entries()].map(([runId, conversationId]) => ({ runId, conversationId }));
    const pendingRuns = [...connection.pendingRuns.entries()].map(([runId, conversationId]) => ({ runId, conversationId }));
    connection.record = { ...connection.record, pendingCancels, pendingRuns };
    const record = connection.record;
    const write = connection.persist
      .then(() => this.settings.saveMachine(record))
      .then(() => undefined);
    connection.persist = write.catch((error: unknown) => {
      void this.debugLogs.write("machine-link.record.save-error", { machineId: record.id, message: errorMessage(error) });
    });
    return required ? write : connection.persist;
  }

  private async replicateNow(connection: MachineConnection, conversation: Conversation): Promise<void> {
    const known = connection.replicated.get(conversation.id);
    if (!known) {
      // A first copy travels as the conversation shell plus bounded message
      // batches, so a chat of any size stays under the relay's logical
      // message limit (the User's chats reach tens of megabytes as JSON).
      await this.send(connection, { type: "machine.conversation.sync", conversation: { ...conversation, messages: [] } });
      const sent = new Map<string, string>();
      for (const batch of messageBatches(conversation.messages)) {
        await this.send(connection, {
          type: "machine.conversation.delta",
          conversationId: conversation.id,
          messages: batch,
          updatedAt: conversation.updatedAt
        });
        for (const message of batch) {
          sent.set(message.id, messageStamp(message));
        }
      }
      // The machine compares its own rows against this copy only now, so a
      // shell followed by batches never makes its stored rows look new.
      await this.send(connection, { type: "machine.conversation.sync.done", conversationId: conversation.id });
      connection.replicated.set(conversation.id, sent);
      return;
    }
    const changed = conversation.messages.filter((message) => known.get(message.id) !== messageStamp(message));
    const presentIds = new Set(conversation.messages.map((message) => message.id));
    const removedMessageIds = [...known.keys()].filter((id) => !presentIds.has(id));
    const batches = messageBatches(changed);
    if (batches.length === 0) {
      batches.push([]);
    }
    for (const [index, batch] of batches.entries()) {
      const last = index === batches.length - 1;
      const delta: MachineConversationDeltaBody = {
        type: "machine.conversation.delta",
        conversationId: conversation.id,
        messages: batch,
        // Metadata and removals travel once, with the final batch.
        ...(last ? { metadata: conversation.metadata } : {}),
        ...(last && removedMessageIds.length > 0 ? { removedMessageIds } : {}),
        updatedAt: conversation.updatedAt
      };
      await this.send(connection, delta);
      for (const message of batch) {
        known.set(message.id, messageStamp(message));
      }
    }
    for (const id of removedMessageIds) {
      known.delete(id);
    }
  }

  private async handleMessage(connection: MachineConnection, ciphertext: string): Promise<void> {
    const payload = await openMobileRelayPayload<unknown>(ciphertext, connection.pairing.relaySealKeyBase64);
    if (isDeviceEventPacket(payload)) {
      if (!connection.eventChannel) throw new Error("The machine must introduce its signing identity before sending events.");
      await connection.eventChannel.receive(payload);
      return;
    }
    if (!isMachineLinkEnvelope(payload)) {
      return;
    }
    if (this.seenMessageIds.has(payload.messageId)) {
      return;
    }
    this.seenMessageIds.add(payload.messageId);
    if (this.seenMessageIds.size > 10_000) {
      const first = this.seenMessageIds.values().next().value;
      if (first) {
        this.seenMessageIds.delete(first);
      }
    }
    await this.handleBody(connection, payload.body);
  }

  private async handleBody(connection: MachineConnection, body: MachineLinkMessage): Promise<void> {
    switch (body.type) {
      case "machine.hello":
        await this.handleHello(connection, body);
        return;
      case "machine.turn.progress": {
        const pending = connection.pendingTurns.get(body.runId);
        pending?.progress?.(body.progress);
        return;
      }
      case "machine.turn.finished":
        await this.finishTurn(connection, body);
        return;
      case "machine.conversation.backdelta": {
        // The machine already holds these; do not echo them back on the next delta.
        const known = connection.replicated.get(body.conversationId);
        if (known) {
          for (const message of body.messages) {
            known.set(message.id, messageStamp(message));
          }
        }
        if (!this.backDeltaListeners.length) throw new Error("No chat owner is available to store the machine's messages.");
        await Promise.all(this.backDeltaListeners.map((listener) => listener({ machineId: connection.record.id, conversationId: body.conversationId, messages: body.messages })));
        return;
      }
      case "machine.turn.unknown":
        await this.handleUnknownRun(connection, body);
        return;
      case "machine.conversation.resync":
        await this.handleResync(connection, body.conversationId);
        return;
      case "machine.approval.result": {
        const pending = connection.pendingApprovals.get(body.approvalId);
        connection.pendingApprovals.delete(body.approvalId);
        try {
          if (!body.ok) {
            throw new Error(body.error ?? `Machine ${connection.record.name} could not apply the decision.`);
          }
          if (body.approval) {
            // Store the machine's view of the card (and policies) before the
            // desktop's card call returns; a failed store fails that call.
            await this.emitApproval({
              machineId: connection.record.id,
              conversationId: body.conversationId,
              approval: { ...body.approval, homeMachineId: connection.record.id },
              ...(body.policies ? { policies: body.policies } : {})
            });
          }
          pending?.resolve();
        } catch (error) {
          pending?.reject(error instanceof Error ? error : new Error(String(error)));
        }
        return;
      }
      case "machine.approval.requested":
      case "machine.approval.updated":
        await this.emitApproval({
          machineId: connection.record.id,
          conversationId: body.conversationId,
          approval: { ...body.approval, homeMachineId: connection.record.id },
          ...(body.type === "machine.approval.updated" && body.policies ? { policies: body.policies } : {})
        });
        return;
      default:
        return;
    }
  }

  private initializeEventChannel(connection: MachineConnection, deviceId: string, publicKeyDerBase64: string): void {
    if (!connection.eventChannel) {
      connection.eventChannel = new DeviceEventChannel({
        storage: this.options.eventStorage, eventLog: this.options.eventLog,
        pairing: connection.pairing,
        isPeerConnected: () => Boolean(connection.machineDeviceId),
        channelId: connection.pairing.rendezvousId, localDeviceId: this.options.desktopDeviceId,
        peerDeviceId: deviceId, peerPublicKeyDerBase64: publicKeyDerBase64,
        send: async (packet) => {
          const ciphertext = await sealMobileRelayPayload(packet, connection.pairing.relaySealKeyBase64);
          await connection.client.sendCiphertext({ logicalMessageId: randomUUID(), ciphertext, to: deviceId });
        },
        apply: async (event, body) => {
          const envelope = { protocol: MACHINE_LINK_PROTOCOL, messageId: "event", sentAt: this.now().toISOString(), body };
          if (!isMachineLinkEnvelope(envelope) || !["machine.conversation.backdelta", "machine.turn.finished", "machine.turn.started"].includes(envelope.body.type) ||
              !("conversationId" in envelope.body) ||
              event.kind !== envelope.body.type || event.conversationId !== envelope.body.conversationId) {
            throw new Error("Unexpected machine replication event.");
          }
          if (envelope.body.type === "machine.turn.finished") {
            const stored = await this.finishTurn(connection, envelope.body, () => connection.eventChannel!.confirmApplied(event));
            return stored ? "applied" : "deferred";
          }
          if (envelope.body.type === "machine.turn.started") {
            await Promise.all(this.runStartedListeners.map(listener => listener(envelope.body as { conversationId: string; runId: string })));
            return "applied";
          }
          await this.handleBody(connection, envelope.body);
          return "applied";
        },
        onError: (error) => { void this.debugLogs.write("machine-link.events.error", { machineId: connection.record.id, message: error.message }); }
      });
    }
  }

  private async handleHello(connection: MachineConnection, hello: MachineHelloBody): Promise<void> {
    // A hello from an instance older than one already seen (the old process
    // saying goodbye late) is ignored, but only when both hellos carry the
    // machine's on-disk start counter; without a reliable counter nothing
    // is inferred from clocks, and no hello is refused. Lost turns are
    // closed by asking the machine (machine.turn.query), never by ordering.
    const stale = typeof hello.instanceSequence === "number" && typeof connection.latestInstanceSequence === "number"
      && hello.instanceSequence < connection.latestInstanceSequence;
    if (stale) {
      void this.debugLogs.write("machine-link.hello.stale-instance", { machineId: connection.record.id, instanceId: hello.instanceId, instanceSequence: hello.instanceSequence, instanceStartedAt: hello.instanceStartedAt });
      return;
    }
    if (!hello.publicKeyDerBase64) throw new Error("This machine needs the device-event runtime before it can synchronize chats.");
    if (connection.record.deviceId && connection.record.deviceId !== hello.deviceId) {
      throw new Error("The machine's enrolled device identity changed; its history cannot be accepted as the previous machine.");
    }
    this.initializeEventChannel(connection, hello.deviceId, hello.publicKeyDerBase64);
    if (typeof hello.instanceSequence === "number") {
      connection.latestInstanceSequence = hello.instanceSequence;
    }
    if (hello.instanceStartedAt) {
      connection.latestInstanceStartedAt = hello.instanceStartedAt;
    }
    connection.machineDeviceId = hello.deviceId;
    connection.helloSeen = true;
    if (connection.helloRequestTimer) {
      clearTimeout(connection.helloRequestTimer);
      connection.helloRequestTimer = undefined;
    }
    connection.settingsSynced = false;
    // The machine's inventory of what it holds lives in its process: after
    // a restart (new instance id) every chat is copied afresh; after a mere
    // reconnect nothing is, so a network blip does not re-send 40 MB.
    const previousInstance = connection.record.lastHello?.instanceId;
    if (!hello.instanceId || !previousInstance || hello.instanceId !== previousInstance) {
      connection.replicated.clear();
    }
    const { type: _type, ...rest } = hello;
    connection.record = {
      ...connection.record,
      deviceId: hello.deviceId,
      lastSeenAt: this.now().toISOString(),
      lastHello: rest,
      pendingCancels: [...connection.pendingCancels.entries()].map(([runId, conversationId]) => ({ runId, conversationId })),
      pendingRuns: [...connection.pendingRuns.entries()].map(([runId, conversationId]) => ({ runId, conversationId }))
    };
    await this.persistCancels(connection, true);
    await this.send(connection, { type: "machine.hello.ack", desktopDeviceId: this.options.desktopDeviceId, appVersion: this.options.appVersion, machineId: connection.record.id });
    await this.send(connection, { type: "machine.settings.sync", snapshot: await this.settings.exportMachineSettingsSnapshot() });
    connection.settingsSynced = true;
    connection.eventChannel?.start();
    this.emitStatus();
    await this.reconcileAfterHello(connection, hello);
  }

  /** After a machine reconnects: stops that were waiting are delivered
   *  again, and turns the machine no longer knows (it restarted) are closed
   *  instead of waiting for a result that will never come. */
  private async reconcileAfterHello(connection: MachineConnection, hello: MachineHelloBody): Promise<void> {
    for (const [runId, conversationId] of [...connection.pendingCancels.entries()]) {
      void this.debugLogs.write("machine-link.stop.redelivered", { machineId: connection.record.id, runId });
      await this.send(connection, { type: "machine.turn.cancel", conversationId, runId }).catch(() => undefined);
    }
    // Turns this desktop still waits on that the machine did not list as
    // running or waiting in its outbox: ask the machine. A runtime that does
    // not hold the run answers machine.turn.unknown and the turn is closed
    // then; one that does hold it stays silent and the result follows. No
    // turn is ever closed from process order or clocks.
    // The records survive a desktop restart. A live preparation has a saved
    // intent too, but its in-memory dispatched flag prevents an early query.
    const listed = new Set([...(hello.activeRunIds ?? []), ...(hello.pendingTerminalRunIds ?? [])]);
    const asked = new Set<string>();
    for (const [runId, conversationId] of [...connection.pendingRuns.entries(), ...connection.pendingCancels.entries()]) {
      const preparing = connection.pendingTurns.get(runId)?.dispatched === false;
      if (listed.has(runId) || asked.has(runId) || preparing) {
        continue;
      }
      // A retained command may still be in the sealed mailbox or waiting on
      // earlier copy events. A live query must not overtake durable admission.
      if (await this.options.eventStorage.getChatEvent(machineCommandId(runId))) continue;
      asked.add(runId);
      void this.debugLogs.write("machine-link.turn.queried", { machineId: connection.record.id, runId });
      await this.send(connection, { type: "machine.turn.query", conversationId, runId }).catch(() => undefined);
    }
  }

  private async finishTurn(connection: MachineConnection, body: MachineTurnFinishedBody, onStored?: () => Promise<void>): Promise<boolean> {
    // The machine keeps the result until this acknowledgement arrives, and
    // it is sent only once the result has been stored on this desktop; a
    // held stop for the run is dropped at the same moment, never before.
    const acknowledge = async (): Promise<void> => {
      const held = connection.pendingCancels.get(body.runId);
      const remembered = connection.pendingRuns.get(body.runId);
      const changed = connection.pendingCancels.delete(body.runId);
      const forgotten = connection.pendingRuns.delete(body.runId);
      if (changed || forgotten) {
        try { await this.persistCancels(connection, true); }
        catch (error) {
          if (held) connection.pendingCancels.set(body.runId, held);
          if (remembered) connection.pendingRuns.set(body.runId, remembered);
          throw error;
        }
      }
      await this.send(connection, {
        type: "machine.turn.finished.ack", conversationId: body.conversationId, runId: body.runId,
        receiptId: body.receiptId, finishedAt: body.finishedAt
      });
    };
    const pending = connection.pendingTurns.get(body.runId);
    if (!pending) {
      // The turn finished while this desktop was away (restart, relay drop):
      // the machine kept the result, and the chat gets it exactly as a live
      // turn would (reply, stop, failure), stored before it is acknowledged.
      void this.debugLogs.write("machine-link.turn.finished-late", { machineId: connection.record.id, runId: body.runId, status: body.status, messages: body.messages.length });
      const known = connection.replicated.get(body.conversationId);
      for (const message of body.messages) {
        known?.set(message.id, messageStamp(message));
      }
      await this.emitLateTerminal({
        machineId: connection.record.id,
        machineName: connection.record.name,
        conversationId: body.conversationId,
        runId: body.runId,
        status: body.status,
        messages: body.messages,
        warnings: body.warnings,
        finishedAt: body.finishedAt,
        receiptId: body.receiptId,
        ...(body.error ? { error: body.error } : {})
      });
      await acknowledge();
      return true;
    }
    connection.pendingTurns.delete(body.runId);
    pending.resolve({
      status: body.status,
      messages: body.messages,
      warnings: body.warnings,
      error: body.error,
      finishedAt: body.finishedAt,
      receiptId: body.receiptId,
      acknowledge: async () => { await acknowledge(); await onStored?.(); }
    });
    return false;
  }

  /** The machine does not know this run: not running there, no result
   *  waiting. A held stop for it cannot be confirmed (Rule 2). */
  private async handleUnknownRun(connection: MachineConnection, body: { conversationId: string; runId: string }): Promise<void> {
    const pending = connection.pendingTurns.get(body.runId);
    const held = connection.pendingCancels.has(body.runId);
    void this.debugLogs.write("machine-link.turn.unknown", { machineId: connection.record.id, runId: body.runId, pending: Boolean(pending), held, dispatched: pending?.dispatched });
    if (pending && !pending.dispatched) {
      // The request has not left yet (a query raced the preparation, or a
      // stale answer): the turn is about to be dispatched, nothing to close.
      return;
    }
    if (await this.options.eventStorage.getChatEvent(machineCommandId(body.runId))) return;
    const detail = held
      ? `Machine ${connection.record.name} does not know this run any more; whether its processes are gone is not verified.`
      : `Machine ${connection.record.name} does not know this run any more (it restarted or lost it before finishing).`;
    const recorded = connection.pendingRuns.has(body.runId);
    const dropRecords = (): void => {
      const changed = connection.pendingCancels.delete(body.runId);
      const forgotten = connection.pendingRuns.delete(body.runId);
      if (changed || forgotten) {
        this.persistCancels(connection);
      }
    };
    if (pending) {
      connection.pendingTurns.delete(body.runId);
      // The live path stores the outcome and calls acknowledge; the held
      // stop goes with it. Without a stop this is a lost run, not a stop.
      pending.resolve({ status: held ? "unconfirmed" : "failed", messages: [], warnings: [], error: detail, acknowledge: dropRecords });
      return;
    }
    if (held || recorded) {
      // This desktop restarted since the turn was dispatched (or the stop
      // held): the chat gets the outcome first, and the records are dropped
      // only once it is stored.
      try {
        await this.emitLateTerminal({ machineId: connection.record.id, machineName: connection.record.name, conversationId: body.conversationId, runId: body.runId, status: held ? "unconfirmed" : "failed", messages: [], warnings: [], error: detail });
      } catch (error) {
        void this.debugLogs.write("machine-link.turn.late-store-error", { machineId: connection.record.id, runId: body.runId, message: errorMessage(error) });
        return;
      }
    }
    dropRecords();
  }

  /** The machine could not store a batch of the first copy: send the whole
   *  copy again from the desktop's current state. */
  private async handleResync(connection: MachineConnection, conversationId: string): Promise<void> {
    void this.debugLogs.write("machine-link.resync", { machineId: connection.record.id, conversationId });
    connection.replicated.delete(conversationId);
    const conversation = await this.conversationLoader?.(conversationId);
    if (!conversation) {
      void this.debugLogs.write("machine-link.resync.unavailable", { machineId: connection.record.id, conversationId });
      return;
    }
    await this.replicateTo(connection, conversation);
  }

  private setMachinePeer(connection: MachineConnection, deviceId: string | undefined): void {
    const changed = connection.machineDeviceId !== deviceId;
    if (!deviceId) {
      connection.machineDeviceId = undefined;
      connection.settingsSynced = false;
      connection.replicated.clear();
    } else if (!connection.machineDeviceId) {
      connection.machineDeviceId = deviceId;
      if (!connection.helloSeen && !connection.helloRequestTimer) {
        // The machine is there; if it does not greet this connection by
        // itself shortly (a relay may seat a restarted desktop silently in
        // place of the old one), ask for the hello that drives reconciliation.
        connection.helloRequestTimer = setTimeout(() => {
          connection.helloRequestTimer = undefined;
          if (connection.helloSeen || !connection.machineDeviceId) {
            return;
          }
          void this.debugLogs.write("machine-link.hello.requested", { machineId: connection.record.id });
          void this.send(connection, { type: "machine.hello.request", desktopDeviceId: this.options.desktopDeviceId }).catch(() => undefined);
        }, HELLO_REQUEST_GRACE_MS);
        connection.helloRequestTimer.unref?.();
      }
    }
    if (changed) {
      this.emitStatus();
    }
  }

  private send(connection: MachineConnection, body: MachineLinkMessage, beforeWrite?: () => void): Promise<void> {
    const send = connection.outbound.then(() => this.sendNow(connection, body, beforeWrite));
    connection.outbound = send.catch(() => undefined);
    return send;
  }

  private async sendNow(connection: MachineConnection, body: MachineLinkMessage, beforeWrite?: () => void): Promise<void> {
    if (body.type === "machine.settings.sync") {
      return this.sendNow(connection, {
        type: "machine.settings.sealed", conversationId: `machine-settings:${connection.pairing.rendezvousId}`,
        ciphertext: await sealMobileRelayPayload(body.snapshot, connection.pairing.relaySealKeyBase64)
      }, beforeWrite);
    }
    if (isMachineDurableMessage(body)) {
      if (!connection.eventChannel) throw new Error("The machine has not introduced its event channel yet.");
      const conversationId = body.type === "machine.conversation.sync" ? body.conversation.id : "conversationId" in body ? body.conversationId : "";
      beforeWrite?.();
      await connection.eventChannel.publish({ conversationId, kind: body.type, payload: body,
        ...(body.type === "machine.turn.request" ? { eventId: machineCommandId(body.runId) } : {}),
        ...(body.type === "machine.turn.cancel" ? { eventId: `machine-cancel:${body.runId}`, scope: `cancel:${body.runId}` } : {}),
        ...(body.type === "machine.turn.finished.ack" ? { eventId: `machine-terminal-ack:${body.receiptId ?? `${body.runId}:${body.finishedAt}`}`, scope: `terminal-ack:${body.runId}` } : {}) });
      return;
    }
    const to = connection.machineDeviceId;
    if (!to) {
      throw new Error(`${connection.record.name} is not connected.`);
    }
    const envelope: MachineLinkEnvelope = {
      protocol: MACHINE_LINK_PROTOCOL,
      messageId: randomUUID(),
      sentAt: this.now().toISOString(),
      body
    };
    const ciphertext = await sealMobileRelayPayload(envelope, connection.pairing.relaySealKeyBase64);
    beforeWrite?.();
    await connection.client.sendCiphertext({ logicalMessageId: envelope.messageId, ciphertext, to });
  }

  private emitStatus(): void {
    this.emitter.emit("status", this.status());
  }
}

/** Content hash of everything a message carries, so edits of equal length
 *  are never mistaken for "unchanged". Message objects are shared between
 *  snapshots, so the hash is cached per object and recomputed only when the
 *  fields that change in place (content, status, metadata, attachments)
 *  differ from the cached ones: a pass over a 14 000-row chat compares
 *  strings instead of serializing and hashing every row again. */
const stampCache = new WeakMap<ChatMessage, { content: string; status: string | undefined; metadata: unknown; metadataJson: string; attachments: unknown; stamp: string }>();

export function messageStamp(message: ChatMessage): string {
  const cached = stampCache.get(message);
  const attachments = (message as { attachments?: unknown }).attachments;
  if (cached && cached.content === message.content && cached.status === message.status && cached.attachments === attachments) {
    if (cached.metadata === message.metadata) {
      return cached.stamp;
    }
    const metadataJson = JSON.stringify(message.metadata ?? null);
    if (metadataJson === cached.metadataJson) {
      cached.metadata = message.metadata;
      return cached.stamp;
    }
  }
  const stamp = createHash("sha256").update(JSON.stringify(message)).digest("hex");
  stampCache.set(message, {
    content: message.content,
    status: message.status,
    metadata: message.metadata,
    metadataJson: JSON.stringify(message.metadata ?? null),
    attachments,
    stamp
  });
  return stamp;
}

/** Bounded message batches: at most MAX_BATCH_MESSAGES messages and about
 *  MAX_BATCH_BYTES of JSON per relay logical message (the sealed form is
 *  larger; the relay limit is 10 MiB). */
const MAX_BATCH_MESSAGES = 150;
const MAX_BATCH_BYTES = 1_500_000;

export function messageBatches(messages: ChatMessage[]): ChatMessage[][] {
  const batches: ChatMessage[][] = [];
  let current: ChatMessage[] = [];
  let currentBytes = 0;
  for (const message of messages) {
    const bytes = Buffer.byteLength(JSON.stringify(message), "utf8");
    if (current.length > 0 && (current.length >= MAX_BATCH_MESSAGES || currentBytes + bytes > MAX_BATCH_BYTES)) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(message);
    currentBytes += bytes;
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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

import { randomUUID } from "node:crypto";
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
import type { ChatMessage, Conversation, ReviewProgress } from "../../shared/types";
import type { MachineTurnDispatchRequest, MachineTurnDispatchResult, MachineTurnDispatcher } from "./chat";
import type { DebugLogService } from "./debugLogs";
import { openMobileRelayPayload, sealMobileRelayPayload } from "./mobileRelaySealing";
import { RelayTunnelClient } from "./relayTunnelClient";
import type { SettingsService } from "./settings";

export interface MachineLinkOptions {
  appVersion: string;
  desktopDeviceId: string;
  reconnectDelayMs?: number;
  /** Test seam: builds the relay client for one machine room. */
  createClient?: (pairing: MobilePairingPackage) => RelayTunnelClient;
  now?: () => Date;
}

export type { MachineLinkStatus };

interface MachineConnection {
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
  }>;
}

const TURN_ACK_TIMEOUT_MS = 24 * 60 * 60_000;

export class MachineLinkService implements MachineTurnDispatcher {
  private readonly emitter = new EventEmitter();
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

  /** Conversation changes made on a machine (approval cards, requests). */
  onConversationBackDelta(listener: (delta: { machineId: string; conversationId: string; messages: ChatMessage[] }) => void): () => void {
    this.emitter.on("backdelta", listener);
    return () => this.emitter.off("backdelta", listener);
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
      pendingTurns: new Map()
    };
    this.connections.set(record.id, connection);
    client.on("peer", (event) => {
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
      void this.handleMessage(connection, message.ciphertext).catch((error) => {
        void this.debugLogs.write("machine-link.message.error", { machineId: record.id, message: errorMessage(error) });
      });
    });
    client.on("state", (state) => {
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
    connection.client.close();
    this.emitStatus();
  }

  close(): void {
    for (const connection of this.connections.values()) {
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
      lastHello: connection.record.lastHello
    }));
  }

  isMachineConnected(machineId: string): boolean {
    return Boolean(this.connections.get(machineId)?.machineDeviceId);
  }

  /** Pushes the current desktop settings to every connected machine (call
   *  after settings change). */
  async syncSettings(): Promise<void> {
    const snapshot = await this.settings.exportMachineSettingsSnapshot();
    for (const connection of this.connections.values()) {
      if (!connection.machineDeviceId) {
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
      if (!connection?.machineDeviceId) {
        continue;
      }
      await this.replicateTo(connection, conversation);
    }
  }

  async runTurn(request: MachineTurnDispatchRequest): Promise<MachineTurnDispatchResult> {
    const machineId = request.participant.homeMachineId ?? "";
    const connection = this.connections.get(machineId);
    if (!connection) {
      return { status: "failed", messages: [], warnings: [], error: `@${request.participant.handle} is hosted on a machine that is not enrolled on this desktop.` };
    }
    if (!connection.machineDeviceId) {
      return { status: "failed", messages: [], warnings: [], error: `@${request.participant.handle} is hosted on ${connection.record.name}, which is not connected.` };
    }
    // Settings are small (roles, rules, presets, environment) and must be
    // exactly the desktop's at the moment the turn starts, so they travel with
    // every turn request rather than on a change hook.
    await this.send(connection, { type: "machine.settings.sync", snapshot: await this.settings.exportMachineSettingsSnapshot() });
    connection.settingsSynced = true;
    await this.replicateTo(connection, request.conversation);
    const result = new Promise<MachineTurnDispatchResult>((resolve) => {
      connection.pendingTurns.set(request.runId, { resolve, progress: request.progress });
    });
    const onAbort = (): void => {
      void this.send(connection, { type: "machine.turn.cancel", conversationId: request.conversation.id, runId: request.runId }).catch(() => undefined);
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => {
      const pending = connection.pendingTurns.get(request.runId);
      if (pending) {
        connection.pendingTurns.delete(request.runId);
        pending.resolve({ status: "failed", messages: [], warnings: [], error: "The machine did not finish the turn within the run timeout." });
      }
    }, TURN_ACK_TIMEOUT_MS);
    timeout.unref?.();
    try {
      await this.send(connection, {
        type: "machine.turn.request",
        conversationId: request.conversation.id,
        participantId: request.participant.id,
        participant: request.participant,
        messageId: request.triggerMessage.id,
        runId: request.runId,
        pendingMessageId: request.pendingMessageId,
        requestedAt: this.now().toISOString()
      });
      return await result;
    } catch (error) {
      connection.pendingTurns.delete(request.runId);
      return { status: "failed", messages: [], warnings: [], error: errorMessage(error) };
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", onAbort);
    }
  }

  private replicateTo(connection: MachineConnection, conversation: Conversation): Promise<void> {
    const previous = connection.replication.get(conversation.id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.replicateNow(connection, conversation));
    connection.replication.set(conversation.id, next.then(() => undefined, () => undefined));
    return next;
  }

  private async replicateNow(connection: MachineConnection, conversation: Conversation): Promise<void> {
    const known = connection.replicated.get(conversation.id);
    if (!known) {
      await this.send(connection, { type: "machine.conversation.sync", conversation });
      connection.replicated.set(conversation.id, new Map(conversation.messages.map((message) => [message.id, messageStamp(message)])));
      return;
    }
    const changed = conversation.messages.filter((message) => known.get(message.id) !== messageStamp(message));
    const presentIds = new Set(conversation.messages.map((message) => message.id));
    const removedMessageIds = [...known.keys()].filter((id) => !presentIds.has(id));
    const delta: MachineConversationDeltaBody = {
      type: "machine.conversation.delta",
      conversationId: conversation.id,
      messages: changed,
      metadata: conversation.metadata,
      removedMessageIds: removedMessageIds.length > 0 ? removedMessageIds : undefined,
      updatedAt: conversation.updatedAt
    };
    await this.send(connection, delta);
    for (const message of changed) {
      known.set(message.id, messageStamp(message));
    }
    for (const id of removedMessageIds) {
      known.delete(id);
    }
  }

  private async handleMessage(connection: MachineConnection, ciphertext: string): Promise<void> {
    const payload = await openMobileRelayPayload<unknown>(ciphertext, connection.pairing.relaySealKeyBase64);
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
    const body = payload.body;
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
        this.finishTurn(connection, body);
        return;
      case "machine.conversation.backdelta":
        this.emitter.emit("backdelta", { machineId: connection.record.id, conversationId: body.conversationId, messages: body.messages });
        return;
      default:
        return;
    }
  }

  private async handleHello(connection: MachineConnection, hello: MachineHelloBody): Promise<void> {
    connection.machineDeviceId = hello.deviceId;
    connection.settingsSynced = false;
    connection.replicated.clear();
    const { type: _type, ...rest } = hello;
    connection.record = {
      ...connection.record,
      deviceId: hello.deviceId,
      lastSeenAt: this.now().toISOString(),
      lastHello: rest
    };
    await this.settings.saveMachine(connection.record);
    await this.send(connection, { type: "machine.hello.ack", desktopDeviceId: this.options.desktopDeviceId, appVersion: this.options.appVersion });
    await this.send(connection, { type: "machine.settings.sync", snapshot: await this.settings.exportMachineSettingsSnapshot() });
    connection.settingsSynced = true;
    this.emitStatus();
  }

  private finishTurn(connection: MachineConnection, body: MachineTurnFinishedBody): void {
    const pending = connection.pendingTurns.get(body.runId);
    if (!pending) {
      return;
    }
    connection.pendingTurns.delete(body.runId);
    pending.resolve({
      status: body.status,
      messages: body.messages,
      warnings: body.warnings,
      error: body.error
    });
  }

  private setMachinePeer(connection: MachineConnection, deviceId: string | undefined): void {
    const changed = connection.machineDeviceId !== deviceId;
    if (!deviceId) {
      connection.machineDeviceId = undefined;
      connection.settingsSynced = false;
      connection.replicated.clear();
    } else if (!connection.machineDeviceId) {
      connection.machineDeviceId = deviceId;
    }
    if (changed) {
      this.emitStatus();
    }
  }

  private async send(connection: MachineConnection, body: MachineLinkMessage): Promise<void> {
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
    await connection.client.sendCiphertext({ logicalMessageId: envelope.messageId, ciphertext, to });
  }

  private emitStatus(): void {
    this.emitter.emit("status", this.status());
  }
}

function messageStamp(message: ChatMessage): string {
  return `${message.status ?? ""}\0${message.createdAt}\0${message.content.length}\0${JSON.stringify(message.metadata ?? null)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

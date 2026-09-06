/**
 * Machine link, machine side (machines transport, work items 2 and 5).
 *
 * The headless runtime connects to its enrollment room as `machine`, applies
 * the desktop's settings and conversation replicas to its own storage, runs
 * participant turns with the same ChatService the desktop uses, and reports
 * progress and finished messages back to the desktop.
 */

import { randomUUID } from "node:crypto";
import os from "node:os";
import {
  MACHINE_LINK_PROTOCOL,
  isMachineLinkEnvelope,
  type MachineConversationDeltaBody,
  type MachineHelloBody,
  type MachineLinkEnvelope,
  type MachineLinkMessage,
  type MachineTurnRequestBody
} from "../../shared/machineLink";
import type { MobilePairingPackage } from "../../shared/mobilePairing";
import type { AgentHealth, ChatMessage, Conversation, ReviewProgress } from "../../shared/types";
import type { ChatService } from "./chat";
import type { DebugLogService } from "./debugLogs";
import { openMobileRelayPayload, sealMobileRelayPayload } from "./mobileRelaySealing";
import { RelayTunnelClient } from "./relayTunnelClient";
import type { SettingsService } from "./settings";
import type { StorageService } from "./storage";

export interface MachineHostOptions {
  pairing: MobilePairingPackage;
  deviceId: string;
  machineName?: string;
  appVersion: string;
  detectProviders?: () => Promise<AgentHealth[]>;
  reconnectDelayMs?: number;
  createClient?: (pairing: MobilePairingPackage) => RelayTunnelClient;
  now?: () => Date;
}

/** Conversation metadata the machine owns and never takes from the desktop:
 *  its own provider sessions and run bookkeeping. */
const MACHINE_OWNED_METADATA_KEYS = ["participantSessions", "activeRunIds", "running", "runId"] as const;

export class MachineHostService {
  private readonly client: RelayTunnelClient;
  private readonly now: () => Date;
  private readonly seenMessageIds = new Set<string>();
  private readonly activeTurns = new Map<string, AbortController>();
  private inbound: Promise<void> = Promise.resolve();
  private desktopDeviceId?: string;
  private closed = false;

  constructor(
    private readonly chat: Pick<ChatService, "runMachineHostedTurn" | "cancelRun">,
    private readonly storage: Pick<StorageService, "getConversation" | "saveConversation">,
    private readonly settings: Pick<SettingsService, "importMachineSettingsSnapshot">,
    private readonly debugLogs: Pick<DebugLogService, "write">,
    private readonly options: MachineHostOptions
  ) {
    this.now = options.now ?? (() => new Date());
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
    this.client.on("peer", (event) => {
      if (event.type === "ready") {
        const desktop = event.peers.find((peer) => peer.role === "desktop");
        this.setDesktop(desktop?.deviceId);
      } else if (event.type === "peer-connected" && event.peer.role === "desktop") {
        this.setDesktop(event.peer.deviceId);
      } else if (event.type === "peer-disconnected" && event.peer.role === "desktop") {
        this.desktopDeviceId = undefined;
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
  }

  async start(): Promise<void> {
    this.closed = false;
    await this.client.connect();
  }

  close(): void {
    this.closed = true;
    for (const controller of this.activeTurns.values()) {
      controller.abort();
    }
    this.activeTurns.clear();
    this.client.close();
  }

  isDesktopConnected(): boolean {
    return Boolean(this.desktopDeviceId);
  }

  private setDesktop(deviceId: string | undefined): void {
    if (!deviceId) {
      return;
    }
    const changed = this.desktopDeviceId !== deviceId;
    this.desktopDeviceId = deviceId;
    if (changed) {
      void this.sendHello().catch((error) => {
        void this.debugLogs.write("machine-host.hello.error", { message: errorMessage(error) });
      });
    }
  }

  private async sendHello(): Promise<void> {
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
      providers
    });
  }

  private async handleMessage(ciphertext: string): Promise<void> {
    const payload = await openMobileRelayPayload<unknown>(ciphertext, this.options.pairing.relaySealKeyBase64);
    if (!isMachineLinkEnvelope(payload) || this.seenMessageIds.has(payload.messageId)) {
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
      case "machine.hello.ack":
        this.desktopDeviceId = body.desktopDeviceId || this.desktopDeviceId;
        return;
      case "machine.settings.sync":
        await this.settings.importMachineSettingsSnapshot(body.snapshot);
        void this.debugLogs.write("machine-host.settings.synced", { exportedAt: body.snapshot.exportedAt });
        return;
      case "machine.conversation.sync":
        await this.applyConversationSync(body.conversation);
        return;
      case "machine.conversation.delta":
        await this.applyConversationDelta(body);
        return;
      case "machine.turn.request":
        void this.runTurn(body);
        return;
      case "machine.turn.cancel":
        this.activeTurns.get(body.runId)?.abort();
        this.chat.cancelRun(body.runId);
        return;
      default:
        return;
    }
  }

  private async applyConversationSync(incoming: Conversation): Promise<void> {
    const existing = await this.storage.getConversation(incoming.id);
    const metadata = existing ? this.mergeMetadata(existing, incoming.metadata) : this.stripMachineOwned(incoming.metadata);
    await this.storage.saveConversation({ ...incoming, metadata });
    void this.debugLogs.write("machine-host.conversation.synced", { conversationId: incoming.id, messages: incoming.messages.length });
  }

  private async applyConversationDelta(delta: MachineConversationDeltaBody): Promise<void> {
    const existing = await this.storage.getConversation(delta.conversationId);
    if (!existing) {
      void this.debugLogs.write("machine-host.conversation.delta-without-copy", { conversationId: delta.conversationId });
      return;
    }
    const byId = new Map(existing.messages.map((message) => [message.id, message]));
    for (const message of delta.messages) {
      byId.set(message.id, message);
    }
    for (const id of delta.removedMessageIds ?? []) {
      byId.delete(id);
    }
    const messages = [...byId.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const metadata = delta.metadata ? this.mergeMetadata(existing, delta.metadata) : existing.metadata;
    await this.storage.saveConversation({ ...existing, messages, metadata, updatedAt: delta.updatedAt });
  }

  private mergeMetadata(existing: Conversation, incoming: Conversation["metadata"]): Conversation["metadata"] {
    const merged: Record<string, unknown> = { ...this.stripMachineOwned(incoming) };
    const own = existing.metadata as unknown as Record<string, unknown>;
    for (const key of MACHINE_OWNED_METADATA_KEYS) {
      if (own[key] !== undefined) {
        merged[key] = own[key];
      }
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

  private async runTurn(request: MachineTurnRequestBody): Promise<void> {
    const controller = new AbortController();
    this.activeTurns.set(request.runId, controller);
    const progress = (update: ReviewProgress): void => {
      void this.send({ type: "machine.turn.progress", conversationId: request.conversationId, runId: request.runId, progress: update }).catch(() => undefined);
    };
    try {
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
      await this.send({
        type: "machine.turn.finished",
        conversationId: request.conversationId,
        runId: request.runId,
        participantId: request.participantId,
        status: controller.signal.aborted ? "interrupted" : "completed",
        messages: result.messages,
        warnings: result.warnings,
        finishedAt: this.now().toISOString()
      });
    } catch (error) {
      await this.send({
        type: "machine.turn.finished",
        conversationId: request.conversationId,
        runId: request.runId,
        participantId: request.participantId,
        status: controller.signal.aborted ? "interrupted" : "failed",
        messages: [],
        warnings: [],
        error: errorMessage(error),
        finishedAt: this.now().toISOString()
      }).catch(() => undefined);
    } finally {
      this.activeTurns.delete(request.runId);
    }
  }

  private async send(body: MachineLinkMessage): Promise<void> {
    if (this.closed) {
      return;
    }
    const to = this.desktopDeviceId;
    if (!to) {
      throw new Error("The desktop is not connected.");
    }
    const envelope: MachineLinkEnvelope = {
      protocol: MACHINE_LINK_PROTOCOL,
      messageId: randomUUID(),
      sentAt: this.now().toISOString(),
      body
    };
    const ciphertext = await sealMobileRelayPayload(envelope, this.options.pairing.relaySealKeyBase64);
    await this.client.sendCiphertext({ logicalMessageId: envelope.messageId, ciphertext, to });
  }
}

export function machineMessagesForRun(conversation: Conversation, participantId: string, runId: string): ChatMessage[] {
  return conversation.messages.filter((message) => message.participantId === participantId && message.metadata?.runId === runId);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

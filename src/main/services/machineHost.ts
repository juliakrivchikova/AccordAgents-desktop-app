/**
 * Machine link, machine side (machines transport, work items 2 and 5).
 *
 * The headless runtime connects to its enrollment room as `machine`, applies
 * the desktop's settings and conversation replicas to its own storage, runs
 * participant turns with the same ChatService the desktop uses, and reports
 * progress and finished messages back to the desktop.
 */

import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import {
  MACHINE_LINK_PROTOCOL,
  isMachineLinkEnvelope,
  type MachineConversationDeltaBody,
  type MachineHelloBody,
  type MachineLinkEnvelope,
  type MachineLinkMessage,
  type MachineTurnFinishedBody,
  type MachineTurnRequestBody
} from "../../shared/machineLink";
import type { MobilePairingPackage } from "../../shared/mobilePairing";
import type { AgentHealth, ChatAppToolApproval, ChatAppToolApprovalPolicy, ChatMessage, Conversation, ReviewProgress } from "../../shared/types";
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
  /** Runs after every settings snapshot import (runtime knobs such as the
   *  CLI run timeout are re-read from the imported settings). */
  onSettingsImported?: () => Promise<void> | void;
  reconnectDelayMs?: number;
  createClient?: (pairing: MobilePairingPackage) => RelayTunnelClient;
  now?: () => Date;
}

/** Conversation metadata the machine owns and never takes from the desktop:
 *  its own provider sessions, run bookkeeping, and the approvals its members
 *  raised (the desktop shows those and sends decisions back). */
const MACHINE_OWNED_METADATA_KEYS = ["participantSessions", "activeRunIds", "running", "runId", "pendingAppToolApprovals"] as const;

export class MachineHostService {
  private readonly client: RelayTunnelClient;
  private readonly now: () => Date;
  private readonly seenMessageIds = new Set<string>();
  private readonly activeTurns = new Map<string, AbortController>();
  /** Finished turns not yet delivered to the desktop (resent on reconnect). */
  private readonly pendingTerminals = new Map<string, MachineTurnFinishedBody>();
  private inbound: Promise<void> = Promise.resolve();
  private desktopDeviceId?: string;
  private closed = false;

  /** approval id -> last status + updatedAt forwarded to the desktop. */
  private readonly forwardedApprovals = new Map<string, string>();
  /** conversation id -> message id -> stamp the desktop is known to hold, so
   *  only changes made on this machine travel back. */
  private readonly knownMessages = new Map<string, Map<string, string>>();

  constructor(
    private readonly chat: Pick<ChatService, "runMachineHostedTurn" | "cancelRun" | "respondToAppToolApproval" | "applyReplicatedConversation">,
    private readonly storage: Pick<StorageService, "getConversation">,
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
        // Own link (re)established: greet the desktop again even if it is
        // the same one, so stops and results held meanwhile are reconciled.
        const desktop = event.peers.find((peer) => peer.role === "desktop");
        this.setDesktop(desktop?.deviceId, { announce: true });
      } else if (event.type === "peer-connected" && event.peer.role === "desktop") {
        this.setDesktop(event.peer.deviceId);
      } else if (event.type === "peer-disconnected" && event.peer.role === "desktop") {
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

  /** Called on every conversation mutation on this machine: approvals raised
   *  here (permission prompts, Codex approvals, member requests) are shown on
   *  the desktop, and their outcome travels back the same way. */
  noteConversationSnapshot(conversation: Conversation): void {
    this.forwardMachineMessages(conversation);
    const approvals = (conversation.metadata as { pendingAppToolApprovals?: unknown }).pendingAppToolApprovals;
    if (!Array.isArray(approvals)) {
      return;
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
      void this.sendHello()
        .then(() => this.flushPendingTerminals())
        .catch((error) => {
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
      providers,
      activeRunIds: [...this.activeTurns.keys()],
      pendingTerminalRunIds: [...this.pendingTerminals.keys()]
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
    void this.debugLogs.write("machine-host.message", {
      type: body.type,
      ...("conversationId" in body ? { conversationId: body.conversationId } : {})
    });
    switch (body.type) {
      case "machine.hello.ack":
        this.desktopDeviceId = body.desktopDeviceId || this.desktopDeviceId;
        return;
      case "machine.settings.sync":
        await this.settings.importMachineSettingsSnapshot(body.snapshot);
        void this.debugLogs.write("machine-host.settings.synced", { exportedAt: body.snapshot.exportedAt });
        await this.options.onSettingsImported?.();
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
      case "machine.approval.decision":
        await this.chat.respondToAppToolApproval({
          conversationId: body.conversationId,
          approvalId: body.approvalId,
          approve: body.approve,
          ...(body.scope ? { scope: body.scope } : {})
        }).then((conversation) => {
          const approvals = (conversation?.metadata as { pendingAppToolApprovals?: Array<{ id: string; status: string }> } | undefined)?.pendingAppToolApprovals ?? [];
          void this.debugLogs.write("machine-host.approval.decision-applied", {
            approvalId: body.approvalId,
            approve: body.approve,
            status: approvals.find((item) => item.id === body.approvalId)?.status
          });
          if (conversation) {
            this.noteConversationSnapshot(conversation);
          }
        }).catch((error) => {
          void this.debugLogs.write("machine-host.approval.decision-error", { approvalId: body.approvalId, message: errorMessage(error) });
        });
        return;
      default:
        return;
    }
  }

  /** Messages created or changed by turns that started on this machine
   *  (resumes after approvals, member-request runs) reach the desktop as a
   *  back delta; messages the desktop sent here are never echoed. */
  private forwardMachineMessages(conversation: Conversation): void {
    const known = this.knownMessages.get(conversation.id);
    if (!known) {
      return;
    }
    const changed = conversation.messages.filter((message) => known.get(message.id) !== messageStamp(message));
    if (changed.length === 0) {
      return;
    }
    for (const message of changed) {
      known.set(message.id, messageStamp(message));
    }
    void this.send({
      type: "machine.conversation.backdelta",
      conversationId: conversation.id,
      messages: changed,
      updatedAt: conversation.updatedAt
    }).catch((error) => {
      for (const message of changed) {
        known.delete(message.id);
      }
      void this.debugLogs.write("machine-host.backdelta.error", { conversationId: conversation.id, message: errorMessage(error) });
    });
  }

  private rememberDesktopMessages(conversationId: string, messages: ChatMessage[], removedIds: string[] = []): void {
    const known = this.knownMessages.get(conversationId) ?? new Map<string, string>();
    for (const message of messages) {
      known.set(message.id, messageStamp(message));
    }
    for (const id of removedIds) {
      known.delete(id);
    }
    this.knownMessages.set(conversationId, known);
  }

  private async applyConversationSync(incoming: Conversation): Promise<void> {
    const existing = await this.storage.getConversation(incoming.id);
    const metadata = existing ? this.mergeMetadata(existing, incoming.metadata) : this.stripMachineOwned(incoming.metadata);
    // A fresh copy after a reconnect must not erase messages this machine
    // produced meanwhile: the desktop's messages win by id, ours are kept.
    const byId = new Map((existing?.messages ?? []).map((message) => [message.id, message]));
    for (const message of incoming.messages) {
      byId.set(message.id, message);
    }
    const messages = [...byId.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    await this.chat.applyReplicatedConversation({ ...incoming, messages, metadata });
    this.knownMessages.set(incoming.id, new Map(incoming.messages.map((message) => [message.id, messageStamp(message)])));
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
    await this.chat.applyReplicatedConversation({ ...existing, messages, metadata, updatedAt: delta.updatedAt });
    this.rememberDesktopMessages(delta.conversationId, delta.messages, delta.removedMessageIds ?? []);
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

  private async runTurn(request: MachineTurnRequestBody): Promise<void> {
    const controller = new AbortController();
    this.activeTurns.set(request.runId, controller);
    const progress = (update: ReviewProgress): void => {
      void this.send({ type: "machine.turn.progress", conversationId: request.conversationId, runId: request.runId, progress: update }).catch(() => undefined);
    };
    let terminal: MachineTurnFinishedBody;
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
      terminal = {
        type: "machine.turn.finished",
        conversationId: request.conversationId,
        runId: request.runId,
        participantId: request.participantId,
        status: controller.signal.aborted ? "interrupted" : "completed",
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
        status: controller.signal.aborted ? "interrupted" : "failed",
        messages: [],
        warnings: [],
        error: errorMessage(error),
        finishedAt: this.now().toISOString()
      };
    } finally {
      this.activeTurns.delete(request.runId);
    }
    // The result is kept until it has left this machine: a desktop that is
    // away or a relay that drops the frame gets it again on reconnect.
    this.pendingTerminals.set(request.runId, terminal);
    await this.flushPendingTerminals();
  }

  private async flushPendingTerminals(): Promise<void> {
    for (const [runId, terminal] of [...this.pendingTerminals.entries()]) {
      try {
        await this.send(terminal);
        this.pendingTerminals.delete(runId);
      } catch (error) {
        void this.debugLogs.write("machine-host.terminal.retry-later", { runId, message: errorMessage(error) });
        return;
      }
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

function messageStamp(message: ChatMessage): string {
  return createHash("sha256").update(JSON.stringify(message)).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

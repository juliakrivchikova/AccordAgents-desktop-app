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
import { messageBatches, messageStamp } from "./machineLink";
import { advanceInstanceSequence, isStoredTerminal } from "./machineTurnOutcome";
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
  /** File that keeps finished turns until the desktop acknowledges them, so
   *  a result survives a restart of this runtime. In-memory only when unset. */
  outboxPath?: string;
  reconnectDelayMs?: number;
  createClient?: (pairing: MobilePairingPackage) => RelayTunnelClient;
  now?: () => Date;
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
  private readonly client: RelayTunnelClient;
  private readonly now: () => Date;
  private readonly seenMessageIds = new Set<string>();
  private readonly activeTurns = new Map<string, AbortController>();
  /** Finished turns the desktop has not acknowledged (resent on every hello,
   *  kept on disk when an outbox path is configured). */
  private readonly pendingTerminals = new Map<string, MachineTurnFinishedBody>();
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
  private outboxUnreadable = false;
  /** Why the outbox is not on disk right now (write failed / unreadable);
   *  travels in hello so the desktop can show it. */
  private outboxError?: string;
  /** Outbox entries of an unexpected shape: kept (and written back into the
   *  outbox file) until they have been archived for recovery. */
  private rejectedOutboxEntries: unknown[] = [];
  private outboxRetryTimer?: ReturnType<typeof setTimeout>;
  private inbound: Promise<void> = Promise.resolve();
  /** Outbound sends leave in call order (progress before the finished result). */
  private outbound: Promise<void> = Promise.resolve();
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
        .catch((error) => {
          void this.debugLogs.write("machine-host.hello.error", { message: errorMessage(error) });
        });
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
      activeRunIds: [...this.activeTurns.keys(), ...this.queuedRunIds()],
      pendingTerminalRunIds: [...this.pendingTerminals.keys()],
      instanceId: this.instanceId,
      instanceStartedAt: this.instanceStartedAt,
      ...(typeof this.instanceSequence === "number" ? { instanceSequence: this.instanceSequence } : {}),
      ...(this.outboxError ? { outboxError: this.outboxError } : {})
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
        // A fresh copy starts clean: a previous copy's failure is forgotten
        // (the retry budget is not).
        this.failedSync.delete(body.conversation.id);
        this.syncing.add(body.conversation.id);
        await this.applyConversationSync(body.conversation);
        return;
      case "machine.conversation.sync.done": {
        if (this.failedSync.has(body.conversationId)) {
          // A batch of this copy was not stored: the copy is not complete,
          // and comparing against it would send stale rows back. Ask again,
          // a bounded number of times; a copy that keeps failing stays
          // incomplete (turns on it fail honestly) instead of looping.
          await this.requestResync(body.conversationId);
          return;
        }
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
        await this.applyConversationDelta(body);
        return;
      case "machine.turn.request":
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
        if (!this.activeTurns.has(body.runId) && !this.pendingTerminals.has(body.runId) && !this.isQueuedRun(body.runId)) {
          await this.send({ type: "machine.turn.unknown", conversationId: body.conversationId, runId: body.runId }).catch(() => undefined);
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
        if (!controller && !this.pendingTerminals.has(body.runId)) {
          // Not running here and no result waiting: this runtime cannot
          // confirm anything about it (Rule 2), so it says so.
          await this.send({ type: "machine.turn.unknown", conversationId: body.conversationId, runId: body.runId }).catch(() => undefined);
          return;
        }
        controller?.abort();
        this.chat.cancelRun(body.runId);
        return;
      }
      case "machine.turn.finished.ack":
        if (this.pendingTerminals.delete(body.runId)) {
          this.persistOutbox();
          void this.debugLogs.write("machine-host.terminal.acked", { runId: body.runId, at: this.now().toISOString() });
        }
        return;
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

  private async applyConversationSync(incoming: Conversation): Promise<void> {
    // The desktop's copy is registered before it is applied, so the snapshot
    // the apply emits never echoes it back as a back delta. The inventory of
    // what the desktop holds is kept across syncs: a fresh copy after a
    // reconnect arrives as a shell plus batches, and a shell must not make
    // every stored row look new.
    const previousStamps = this.rememberDesktopMessages(incoming.id, incoming.messages);
    try {
      await this.applyConversationShell(incoming);
    } catch (error) {
      this.restoreInventory(incoming.id, previousStamps);
      this.failedSync.add(incoming.id);
      void this.debugLogs.write("machine-host.sync.batch-failed", { conversationId: incoming.id, stage: "shell", message: errorMessage(error) });
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
      const messages = mergeReplicatedMessages(existing?.messages ?? [], incoming.messages);
      return { ...incoming, messages, metadata };
    });
  }

  private async applyConversationDelta(delta: MachineConversationDeltaBody): Promise<void> {
    const previousStamps = this.rememberDesktopMessages(delta.conversationId, delta.messages, delta.removedMessageIds ?? []);
    let missing = false;
    try {
      await this.chat.applyReplicatedConversation(delta.conversationId, (existing) => {
        if (!existing) {
          missing = true;
          return undefined;
        }
        const messages = mergeReplicatedMessages(existing.messages, delta.messages, delta.removedMessageIds ?? []);
        const metadata = delta.metadata ? this.mergeMetadata(existing, delta.metadata) : existing.metadata;
        return { ...existing, messages, metadata, updatedAt: delta.updatedAt };
      });
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
      if (!this.syncing.has(delta.conversationId)) {
        this.syncing.add(delta.conversationId);
        await this.requestResync(delta.conversationId);
      }
      return;
    }
    if (missing) {
      void this.debugLogs.write("machine-host.conversation.delta-without-copy", { conversationId: delta.conversationId });
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

  private async failTurnOnIncompleteCopy(request: MachineTurnRequestBody): Promise<void> {
    await this.finishQueuedTurn(request, "failed", "This machine's copy of the chat is not complete yet (a sync batch could not be stored); try again once it has synced.");
  }

  /** A turn that never started (stopped while waiting for the copy, or the
   *  copy failed) still gets a stored, acknowledged result. */
  private async finishQueuedTurn(request: MachineTurnRequestBody, status: "interrupted" | "failed", error?: string): Promise<void> {
    this.pendingTerminals.set(request.runId, {
      type: "machine.turn.finished",
      conversationId: request.conversationId,
      runId: request.runId,
      participantId: request.participantId,
      status,
      messages: [],
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
    // The result is kept (on disk when configured) until the desktop
    // acknowledges it: a desktop that is away, a relay that drops the frame,
    // or a restart of this runtime all get it delivered again.
    this.pendingTerminals.set(request.runId, terminal);
    this.persistOutbox();
    // The finished messages travel in the result; they are not echoed again
    // as a back delta by the snapshot that saved them.
    this.rememberDesktopMessages(request.conversationId, terminal.messages);
    await this.flushPendingTerminals();
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

  private send(body: MachineLinkMessage): Promise<void> {
    const run = this.outbound.then(() => this.sendNow(body));
    this.outbound = run.then(() => undefined, () => undefined);
    return run;
  }

  private async sendNow(body: MachineLinkMessage): Promise<void> {
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

/** Desktop messages win by id, this machine's own are kept, and a message
 *  finished here is never replaced by a stale pending copy of itself. */
export function mergeReplicatedMessages(own: ChatMessage[], incoming: ChatMessage[], removedIds: string[] = []): ChatMessage[] {
  const byId = new Map(own.map((message) => [message.id, message]));
  for (const message of incoming) {
    const current = byId.get(message.id);
    if (current && current.status !== "pending" && message.status === "pending") {
      continue;
    }
    // A desktop that swept a bubble as "interrupted" (its stale-run sweep
    // found no live run for it) never overrides an outcome this machine
    // already produced for that bubble: the machine ran it and knows.
    if (current && current.status !== "pending" && message.metadata?.staleRunRecovery) {
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

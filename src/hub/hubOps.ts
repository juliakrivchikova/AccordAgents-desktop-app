import { createHash } from "node:crypto";
import { LOCAL_MESSAGE_METADATA_KEYS, SHARED_CONVERSATION_METADATA_KEYS } from "../main/services/chatChanges";
import { claimOutcomeFor } from "../main/services/hubOpsStore";
import type { SavedMessageRow, StorageService } from "../main/services/storage";
import type { HubDevice } from "../shared/hubProtocol";
import {
  HUB_CHAT_PAGE_MESSAGES,
  HUB_FEED_PAGE_BYTES,
  HUB_FEED_PAGE_MAX,
  HUB_FEED_WAIT_MAX_MS,
  HUB_OP_MAX_BYTES,
  HUB_OPS_MAX_PER_REQUEST,
  hubOpShapeProblem,
  isHubChatId,
  isHubOpId,
  type HubChatPage,
  type HubChatsResponse,
  type HubClaimOutcome,
  type HubConversationFields,
  type HubFeedEntry,
  type HubFeedResponse,
  type HubOp,
  type HubOpEffect,
  type HubOpResult,
  type HubOpsResponse,
  type HubTurn
} from "../shared/hubOps";
import type { ChatMessage, ChatMessageReactions, Conversation } from "../shared/types";

/** Bookkeeping the server keeps on every message it holds: the message's
 *  place in the server's order, and the device that wrote it (the only one
 *  that may change it). Whatever a device sends for these is replaced. */
export const SERVER_MESSAGE_KEYS = ["serverSeq", "serverWriter"] as const;

/** One accepted operation, as the server's other parts hear of it. */
export interface HubOpApplied {
  deviceId: string;
  entry: HubFeedEntry;
  /** The chat after the operation (absent for a deleted chat and for turns). */
  conversation?: Conversation;
  /** The message as it was before an update. */
  previous?: ChatMessage;
}

export class HubOpsRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Chats kept in memory between operations, by their messages: a chat of
 *  hundreds of messages is not read again for every change. */
const CACHE_MESSAGE_LIMIT = 6_000;

type Rejection = { rejected: string };
type Outcome =
  | { result: HubOpResult; applied?: HubOpApplied };

/**
 * The server as the owner of every chat (Д1). Applies devices' operations one
 * at a time, in the order they arrive, by rules that are the same for every
 * device (Д2), and keeps what it accepted as the feed every device reads.
 */
export class HubOps {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly cache = new Map<string, { conversation: Conversation; token: string }>();
  private readonly rows = new WeakMap<ChatMessage, Omit<SavedMessageRow, "index" | "id">>();
  private readonly waiters = new Set<() => void>();
  private readonly listeners: Array<(applied: HubOpApplied) => void> = [];

  constructor(
    private readonly storage: StorageService,
    private readonly log: (event: string, payload: Record<string, unknown>) => void = () => undefined,
    private readonly now: () => Date = () => new Date()
  ) {}

  onApplied(listener: (applied: HubOpApplied) => void): void {
    this.listeners.push(listener);
  }

  async head(): Promise<number> {
    return this.storage.hubOps().head();
  }

  /** Applies a device's operations in order and answers each one. */
  apply(device: HubDevice, raw: unknown): Promise<HubOpsResponse> {
    const ops = (raw as { ops?: unknown } | undefined)?.ops;
    if (!Array.isArray(ops) || ops.length === 0 || ops.length > HUB_OPS_MAX_PER_REQUEST) {
      return Promise.reject(new HubOpsRequestError(400, `Send between 1 and ${HUB_OPS_MAX_PER_REQUEST} operations.`));
    }
    const run = this.queue.then(() => this.applyAll(device, ops));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async applyAll(device: HubDevice, ops: unknown[]): Promise<HubOpsResponse> {
    const devices = await this.storage.hub().devices();
    const results: HubOpResult[] = [];
    for (const op of ops) {
      const opId = isHubOpId((op as { opId?: unknown } | undefined)?.opId) ? (op as { opId: string }).opId : "";
      let outcome: Outcome;
      try {
        outcome = await this.applyOne(device, op, devices);
      } catch (error) {
        // A failure to store is not the operation's fault: the device sends
        // it again. Nothing was placed.
        this.cache.clear();
        this.log("hub.op.error", { opId, deviceId: device.deviceId, message: error instanceof Error ? error.message : String(error) });
        throw error;
      }
      results.push(outcome.result);
      const kind = typeof (op as { kind?: unknown })?.kind === "string" ? (op as { kind: string }).kind : "";
      const conversationId = typeof (op as { conversationId?: unknown })?.conversationId === "string" ? (op as { conversationId: string }).conversationId : "";
      if (outcome.result.status === "rejected") {
        this.log("hub.op.rejected", { opId, kind, conversationId, deviceId: device.deviceId, reason: outcome.result.reason });
      } else {
        this.log(outcome.result.status === "duplicate" ? "hub.op.duplicate" : "hub.op.accepted", {
          opId, kind, conversationId, deviceId: device.deviceId, seq: outcome.result.seq,
          ...(outcome.result.claim ? { claim: outcome.result.claim } : {})
        });
      }
      if (outcome.applied) {
        for (const listener of this.listeners) {
          try { listener(outcome.applied); } catch { /* a listener never breaks the order */ }
        }
      }
    }
    if (results.some((result) => result.status === "accepted")) this.wake();
    return { results, head: await this.head() };
  }

  private async applyOne(device: HubDevice, raw: unknown, devices: HubDevice[]): Promise<Outcome> {
    const problem = hubOpShapeProblem(raw);
    const opId = isHubOpId((raw as { opId?: unknown } | undefined)?.opId) ? (raw as { opId: string }).opId : "";
    if (problem) return reject(opId, problem);
    const op = raw as HubOp;
    if (Buffer.byteLength(JSON.stringify(op)) > HUB_OP_MAX_BYTES) return reject(opId, "The operation is too large.");
    const store = this.storage.hubOps();
    const prior = (await store.accepted([op.opId])).get(op.opId);
    if (prior) {
      if (prior.deviceId !== device.deviceId) return reject(opId, "Another device already used this operation id.");
      return { result: { ...prior.result, status: "duplicate" } as HubOpResult };
    }
    if (await this.storage.conversationTombstones().isDeleted(op.conversationId)) return reject(opId, "This chat was deleted.");
    const acceptedAt = this.now().toISOString();
    const seq = (await store.head()) + 1;
    const accepted = (effect: HubOpEffect, extra: { claim?: HubClaimOutcome; turn?: HubTurn } = {}) => ({
      result: { opId, status: "accepted" as const, seq, ...extra },
      entry: { seq, opId, deviceId: device.deviceId, conversationId: op.conversationId, acceptedAt, effect } satisfies HubFeedEntry
    });

    if (op.kind === "conversation.create") {
      if (await this.load(op.conversationId)) return reject(opId, "This chat already exists.");
      const fields = conversationFields(op.conversation);
      const conversation: Conversation = {
        id: op.conversationId,
        title: fields.title,
        kind: "chat",
        createdAt: fields.createdAt,
        updatedAt: acceptedAt,
        ...(fields.repoPath ? { repoPath: fields.repoPath } : {}),
        messages: [],
        findings: [],
        metadata: { participantSessions: [], warnings: [], running: false, ...fields.metadata } as Conversation["metadata"]
      };
      const done = accepted({ kind: "conversation.create", conversation: fields, updatedAt: acceptedAt });
      await this.save(conversation, done);
      return { result: done.result, applied: { deviceId: device.deviceId, entry: done.entry, conversation } };
    }

    if (op.kind === "turn.stop" || op.kind === "turn.claim" || op.kind === "turn.finish") {
      return this.applyTurn(device, op, devices, { opId, seq, acceptedAt });
    }

    const loaded = await this.load(op.conversationId);
    if (!loaded) return reject(opId, "There is no such chat.");
    const conversation: Conversation = { ...loaded, messages: [...loaded.messages], metadata: { ...loaded.metadata } };

    switch (op.kind) {
      case "conversation.update": {
        const metadata = sharedMetadata(op.metadata ?? {});
        const removed = (op.removedMetadataKeys ?? []).filter((key) => (SHARED_CONVERSATION_METADATA_KEYS as readonly string[]).includes(key));
        if (op.title !== undefined) conversation.title = op.title;
        if (op.repoPath === null) delete conversation.repoPath;
        else if (op.repoPath !== undefined) conversation.repoPath = op.repoPath;
        for (const [key, value] of Object.entries(metadata)) (conversation.metadata as Record<string, unknown>)[key] = value;
        for (const key of removed) delete (conversation.metadata as Record<string, unknown>)[key];
        conversation.updatedAt = acceptedAt;
        const done = accepted({
          kind: "conversation.update",
          ...(op.title !== undefined ? { title: op.title } : {}),
          ...(op.repoPath !== undefined ? { repoPath: op.repoPath } : {}),
          ...(Object.keys(metadata).length ? { metadata } : {}),
          ...(removed.length ? { removedMetadataKeys: removed } : {}),
          updatedAt: acceptedAt
        });
        await this.save(conversation, done);
        return { result: done.result, applied: { deviceId: device.deviceId, entry: done.entry, conversation } };
      }
      case "conversation.delete": {
        const done = accepted({ kind: "conversation.delete" });
        await this.storage.deleteConversation(op.conversationId, { alsoCommitSql: store.insertSql({ ...done.entry, kind: op.kind, result: done.result }) });
        this.cache.delete(op.conversationId);
        return { result: done.result, applied: { deviceId: device.deviceId, entry: done.entry } };
      }
      case "message.create": {
        if (conversation.messages.some((message) => message.id === op.message.id)) return reject(opId, "A message with this id already exists.");
        if (await store.isRemoved(op.conversationId, op.message.id)) return reject(opId, "This message was removed.");
        const refusal = this.mayWriteMessage(device, conversation, op.message, devices);
        if (refusal) return reject(opId, refusal.rejected);
        const message = storedMessage(op.message, { serverSeq: seq, serverWriter: device.deviceId });
        conversation.messages.push(message);
        conversation.updatedAt = acceptedAt;
        const done = accepted({ kind: "message.create", message });
        await this.save(conversation, done);
        return { result: done.result, applied: { deviceId: device.deviceId, entry: done.entry, conversation } };
      }
      case "message.update": {
        const index = conversation.messages.findIndex((message) => message.id === op.message.id);
        if (index < 0) {
          return reject(opId, await store.isRemoved(op.conversationId, op.message.id) ? "This message was removed." : "There is no such message.");
        }
        const current = conversation.messages[index];
        const writer = typeof current.metadata?.serverWriter === "string" ? current.metadata.serverWriter : undefined;
        const owner = devices.find((item) => item.role === "owner")?.deviceId;
        if ((writer ?? owner) !== device.deviceId) return reject(opId, "Only the device that wrote this message may change it.");
        if (op.message.role !== current.role || (op.message.participantId ?? "") !== (current.participantId ?? "")) {
          return reject(opId, "A message keeps its author.");
        }
        const message = storedMessage(op.message, {
          serverSeq: typeof current.metadata?.serverSeq === "number" ? current.metadata.serverSeq : seq,
          serverWriter: writer ?? device.deviceId,
          reactions: current.metadata?.reactions
        });
        conversation.messages[index] = message;
        conversation.updatedAt = acceptedAt;
        const done = accepted({ kind: "message.update", message });
        await this.save(conversation, done);
        return { result: done.result, applied: { deviceId: device.deviceId, entry: done.entry, conversation, previous: current } };
      }
      case "message.react": {
        const index = conversation.messages.findIndex((message) => message.id === op.messageId);
        if (index < 0) return reject(opId, "There is no such message.");
        const reactions = applyReactions(conversation.messages[index].metadata?.reactions, op.added, op.removed);
        const metadata = { ...(conversation.messages[index].metadata ?? {}) } as NonNullable<ChatMessage["metadata"]>;
        if (reactions) metadata.reactions = reactions; else delete metadata.reactions;
        conversation.messages[index] = { ...conversation.messages[index], metadata };
        conversation.updatedAt = acceptedAt;
        const done = accepted({ kind: "message.react", messageId: op.messageId, reactions: reactions ?? null });
        await this.save(conversation, done);
        return { result: done.result, applied: { deviceId: device.deviceId, entry: done.entry, conversation } };
      }
      case "message.remove": {
        conversation.messages = conversation.messages.filter((message) => message.id !== op.messageId);
        conversation.updatedAt = acceptedAt;
        const done = accepted({ kind: "message.remove", messageId: op.messageId });
        await this.save(conversation, done, (condition) => store.removedSql(op.conversationId, op.messageId, acceptedAt, condition));
        return { result: done.result, applied: { deviceId: device.deviceId, entry: done.entry, conversation } };
      }
    }
  }

  private async applyTurn(
    device: HubDevice,
    op: Extract<HubOp, { kind: "turn.claim" | "turn.stop" | "turn.finish" }>,
    devices: HubDevice[],
    place: { opId: string; seq: number; acceptedAt: string }
  ): Promise<Outcome> {
    const store = this.storage.hubOps();
    const { opId, seq, acceptedAt } = place;
    const current = await store.turn(op.runId);
    const head = seq - 1;
    // Nothing changes: the device hears where the turn stands; nothing is placed.
    const unchanged = (claim?: ReturnType<typeof claimOutcomeFor>) => ({
      result: { opId, status: "accepted" as const, seq: head, ...(claim ? { claim } : {}), ...(current ? { turn: current } : {}) }
    });
    const place_ = async (turn: HubTurn, claim?: ReturnType<typeof claimOutcomeFor>): Promise<Outcome> => {
      const effect: HubOpEffect = { kind: op.kind, turn } as HubOpEffect;
      const result: HubOpResult = { opId, status: "accepted", seq, ...(claim ? { claim } : {}), turn };
      const entry: HubFeedEntry = { seq, opId, deviceId: device.deviceId, conversationId: op.conversationId, acceptedAt, effect };
      await store.execute(`${store.turnSql(turn)} ${store.insertSql({ ...entry, kind: op.kind, result })}`);
      return { result, applied: { deviceId: device.deviceId, entry } };
    };

    if (op.kind === "turn.finish") {
      if (!current || current.executorDeviceId !== device.deviceId) return reject(opId, "Only the device that took this turn may finish it.");
      if (current.state === "finished") return unchanged("finished");
      return place_({ ...current, state: "finished", finishedAt: acceptedAt, outcome: op.outcome });
    }

    const conversation = await this.load(op.conversationId);
    if (!conversation) return reject(opId, "There is no such chat.");
    if (current && (current.conversationId !== op.conversationId || current.messageId !== op.messageId || current.participantId !== op.participantId)) {
      return reject(opId, "This turn belongs to another message.");
    }

    if (op.kind === "turn.stop") {
      if (!current) {
        return place_({ runId: op.runId, conversationId: op.conversationId, messageId: op.messageId, participantId: op.participantId,
          state: "stopped", finishedAt: acceptedAt, outcome: "stopped" });
      }
      if (current.state !== "claimed" || current.stopRequestedAt) return unchanged();
      return place_({ ...current, stopRequestedAt: acceptedAt });
    }

    // turn.claim: only where the member runs (Д4), once (Д5).
    if (!conversation.messages.some((message) => message.id === op.messageId)) return reject(opId, "There is no such message.");
    const home = homeDeviceId(conversation, op.participantId, devices);
    if (!home) return reject(opId, "This member is not in the chat, or its machine is not on the server's roster.");
    if (home !== device.deviceId) return reject(opId, "Only the device this member runs on may take its turn.");
    const settled = claimOutcomeFor(current, device.deviceId);
    if (settled) return unchanged(settled);
    return place_({ runId: op.runId, conversationId: op.conversationId, messageId: op.messageId, participantId: op.participantId,
      state: "claimed", executorDeviceId: device.deviceId, claimedAt: acceptedAt }, "claimed");
  }

  /** Who may add a message: anyone, except a member's message, which only
   *  the device that member runs on writes (Д4). */
  private mayWriteMessage(device: HubDevice, conversation: Conversation, message: ChatMessage, devices: HubDevice[]): Rejection | undefined {
    if (message.role !== "participant") return undefined;
    if (!message.participantId) return { rejected: "A member's message names its member." };
    const home = homeDeviceId(conversation, message.participantId, devices);
    if (!home) return { rejected: "This member is not in the chat, or its machine is not on the server's roster." };
    if (home !== device.deviceId) return { rejected: "Only the device this member runs on writes its messages." };
    return undefined;
  }

  // --- reading -------------------------------------------------------------

  /** What was accepted after `after`, waiting up to `waitMs` for something
   *  new. `gone` when the feed no longer holds what comes right after it. */
  async feed(after: number, waitMs: number, closed?: Promise<void>, deviceId?: string): Promise<HubFeedResponse | { gone: true; head: number }> {
    const store = this.storage.hubOps();
    if (!Number.isSafeInteger(after) || after < 0) throw new HubOpsRequestError(400, "Invalid position.");
    if (deviceId) await store.recordRead(deviceId, after, this.now().toISOString());
    if (after < await store.prunedThrough()) return { gone: true, head: await store.head() };
    let page = await store.after(after, HUB_FEED_PAGE_MAX, HUB_FEED_PAGE_BYTES);
    if (page.entries.length === 0 && waitMs > 0) {
      await this.wait(Math.min(waitMs, HUB_FEED_WAIT_MAX_MS), closed);
      page = await store.after(after, HUB_FEED_PAGE_MAX, HUB_FEED_PAGE_BYTES);
    }
    return { entries: page.entries, more: page.more, head: await store.head() };
  }

  async chats(): Promise<HubChatsResponse> {
    const summaries = await this.storage.listConversations();
    return {
      chats: summaries.filter((summary) => summary.kind === "chat").map((summary) => ({ id: summary.id, title: summary.title, updatedAt: summary.updatedAt })),
      head: await this.head()
    };
  }

  async chatPage(conversationId: string, before?: string): Promise<HubChatPage> {
    if (!isHubChatId(conversationId) || (before !== undefined && !isHubOpId(before))) throw new HubOpsRequestError(400, "Invalid chat page.");
    // The head first: a device that continues the feed from here misses
    // nothing accepted while this page was read.
    const head = await this.head();
    const opened = await this.storage.openConversation(conversationId, HUB_CHAT_PAGE_MESSAGES, before ? { beforeMessageId: before } : undefined);
    if (!opened || opened.conversation.kind !== "chat") throw new HubOpsRequestError(404, "There is no such chat.");
    const conversation = opened.conversation;
    const messages = conversation.messages;
    return {
      conversationId,
      conversation: { ...conversationFields(sharedFieldsOf(conversation)), updatedAt: conversation.updatedAt },
      messages,
      turns: await this.storage.hubOps().turnsFor(conversationId, messages.map((message) => message.id)),
      more: Boolean(opened.messagePage?.hasMoreBefore),
      head
    };
  }

  private wait(ms: number, closed?: Promise<void>): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.waiters.add(done);
      void closed?.then(done, done);
    });
  }

  private wake(): void {
    for (const waiter of [...this.waiters]) waiter();
  }

  /** Feed readers waiting now (the server's status). */
  waiting(): number {
    return this.waiters.size;
  }

  // --- storage -------------------------------------------------------------

  private async load(conversationId: string): Promise<Conversation | undefined> {
    const cached = this.cache.get(conversationId);
    if (cached && await this.storage.isConversationSaveOwned(conversationId, cached.token)) return cached.conversation;
    this.cache.delete(conversationId);
    const conversation = await this.storage.getConversation(conversationId);
    return conversation?.kind === "chat" ? conversation : undefined;
  }

  private async save(
    conversation: Conversation,
    done: { result: HubOpResult; entry: HubFeedEntry },
    also?: (condition?: string) => string
  ): Promise<void> {
    const store = this.storage.hubOps();
    const record = { ...done.entry, kind: done.entry.effect.kind, result: done.result };
    const token = await this.storage.saveConversation(conversation, {
      rows: this.rowsFor(conversation),
      alsoCommit: {
        sql: `${store.insertSql(record)} ${also?.() ?? ""}`,
        onlyIfSql: (condition) => `${store.insertSql(record, condition)} ${also?.(condition) ?? ""}`
      }
    });
    this.remember(conversation, token);
  }

  private rowsFor(conversation: Conversation): SavedMessageRow[] {
    return conversation.messages.map((message, index) => {
      let row = this.rows.get(message);
      if (!row) {
        const json = JSON.stringify(message);
        row = { createdAt: message.createdAt, json, hash: createHash("sha1").update(json).digest("hex") };
        this.rows.set(message, row);
      }
      return { index, id: message.id, ...row };
    });
  }

  private remember(conversation: Conversation, token: string): void {
    this.cache.delete(conversation.id);
    this.cache.set(conversation.id, { conversation, token });
    let messages = 0;
    for (const cached of this.cache.values()) messages += cached.conversation.messages.length;
    while (messages > CACHE_MESSAGE_LIMIT && this.cache.size > 1) {
      const [oldest] = this.cache.keys();
      messages -= this.cache.get(oldest)?.conversation.messages.length ?? 0;
      this.cache.delete(oldest);
    }
  }
}

function reject(opId: string, reason: string): Outcome {
  return { result: { opId, status: "rejected", reason } };
}

function sharedMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const shared: Record<string, unknown> = {};
  for (const key of SHARED_CONVERSATION_METADATA_KEYS) if (metadata[key] !== undefined) shared[key] = metadata[key];
  return shared;
}

function conversationFields(fields: HubConversationFields): HubConversationFields {
  return {
    title: fields.title,
    kind: "chat",
    createdAt: fields.createdAt,
    ...(fields.repoPath ? { repoPath: fields.repoPath } : {}),
    metadata: sharedMetadata(fields.metadata)
  };
}

function sharedFieldsOf(conversation: Conversation): HubConversationFields {
  return {
    title: conversation.title,
    kind: "chat",
    createdAt: conversation.createdAt,
    ...(conversation.repoPath ? { repoPath: conversation.repoPath } : {}),
    metadata: sharedMetadata(conversation.metadata as Record<string, unknown>)
  };
}

/** The message as the server keeps it: a device's own bookkeeping removed,
 *  the server's set, reactions only as the reactions operation left them. */
function storedMessage(message: ChatMessage, server: { serverSeq: number; serverWriter: string; reactions?: ChatMessageReactions }): ChatMessage {
  const metadata: Record<string, unknown> = { ...(message.metadata ?? {}) };
  for (const key of LOCAL_MESSAGE_METADATA_KEYS) delete metadata[key];
  delete metadata.reactions;
  if (server.reactions && Object.keys(server.reactions).length) metadata.reactions = server.reactions;
  metadata.serverSeq = server.serverSeq;
  metadata.serverWriter = server.serverWriter;
  return { ...message, metadata: metadata as ChatMessage["metadata"] };
}

function applyReactions(
  current: ChatMessageReactions | undefined,
  added: Array<{ emoji: string; reactor: { actorId: string } }>,
  removed: Array<{ emoji: string; actorId: string }>
): ChatMessageReactions | undefined {
  const reactions: ChatMessageReactions = {};
  for (const [emoji, reactors] of Object.entries(current ?? {})) {
    if (Array.isArray(reactors) && reactors.length) reactions[emoji] = [...reactors];
  }
  for (const entry of removed) {
    const list = reactions[entry.emoji]?.filter((reactor) => reactor.actorId !== entry.actorId);
    if (!list) continue;
    if (list.length) reactions[entry.emoji] = list; else delete reactions[entry.emoji];
  }
  for (const entry of added) {
    const list = (reactions[entry.emoji] ?? []).filter((reactor) => reactor.actorId !== entry.reactor.actorId);
    list.push(entry.reactor as ChatMessageReactions[string][number]);
    reactions[entry.emoji] = list;
  }
  return Object.keys(reactions).length ? reactions : undefined;
}

/** The device a member runs on (Д4): its machine when it has one, otherwise
 *  the computer that owns the server. Undefined for a member not in the chat
 *  or whose machine is not on the roster. */
export function homeDeviceId(conversation: Conversation, participantId: string, devices: HubDevice[]): string | undefined {
  const participants = Array.isArray(conversation.metadata?.participants) ? conversation.metadata.participants as Array<{ id?: unknown; homeMachineId?: unknown }> : [];
  const participant = participants.find((item) => item?.id === participantId);
  if (!participant) return undefined;
  if (typeof participant.homeMachineId === "string" && participant.homeMachineId) {
    return devices.find((device) => device.role === "machine" && device.machineId === participant.homeMachineId)?.deviceId;
  }
  return devices.find((device) => device.role === "owner")?.deviceId;
}

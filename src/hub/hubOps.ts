import { createHash } from "node:crypto";
import { LOCAL_MESSAGE_METADATA_KEYS, SHARED_CONVERSATION_METADATA_KEYS } from "../main/services/chatChanges";
import { claimOutcomeFor } from "../main/services/hubOpsStore";
import { HubArtifacts } from "./hubArtifacts";
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
  hubTurnRunId,
  isHubArtifactOpKind,
  isHubChatId,
  isHubOpId,
  type HubArtifactOpKind,
  type HubArtifactResponse,
  type HubArtifactRevisionResponse,
  type HubArtifactsResponse,
  type HubChatPage,
  type HubCard,
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
  /** Counts what was accepted: a read that saw nothing new waits only if
   *  nothing was accepted while it read (a word given meanwhile is not lost). */
  private generation = 0;
  private readonly listeners: Array<(applied: HubOpApplied) => void> = [];
  /** Every chat's documents, which the server owns too (Д9). */
  readonly artifacts: HubArtifacts;

  constructor(
    private readonly storage: StorageService,
    private readonly log: (event: string, payload: Record<string, unknown>) => void = () => undefined,
    private readonly now: () => Date = () => new Date()
  ) {
    this.artifacts = new HubArtifacts(storage, log, now);
  }

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

    if (op.kind === "chat.import") return this.applyImport(device, op, devices, { opId, seq, acceptedAt });
    if (op.kind === "artifact.import") {
      const outcome = await this.artifacts.import(device, op, { opId, seq, acceptedAt });
      return { result: outcome.result, ...(outcome.entry ? { applied: { deviceId: device.deviceId, entry: outcome.entry } } : {}) };
    }
    if (isArtifactOp(op)) {
      const outcome = await this.artifacts.apply(device, op, { opId, seq, acceptedAt }, (conversation, participantId) => homeDeviceId(conversation, participantId, devices));
      return { result: outcome.result, ...(outcome.entry ? { applied: { deviceId: device.deviceId, entry: outcome.entry } } : {}) };
    }
    if (op.kind === "card.raise" || op.kind === "card.answer" || op.kind === "card.settle") return this.applyCard(device, op, devices, { opId, seq, acceptedAt });
    if (op.kind === "turn.request" || op.kind === "turn.stop" || op.kind === "turn.claim" || op.kind === "turn.finish") {
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
        // The chat's documents go with it, in the same commit (Д9).
        const documents = await this.artifacts.deletionSql(op.conversationId, acceptedAt);
        // So do the cards its members waited on: nobody answers or settles
        // them any more (every operation on a deleted chat is refused).
        await this.storage.deleteConversation(op.conversationId, {
          alsoCommitSql: `${store.insertSql({ ...done.entry, kind: op.kind, result: done.result })} ${documents} ${store.deleteCardsSql(op.conversationId)}`
        });
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
        // A User's message asks a turn of every member it names: waiting on
        // the server for the device each member runs on (Д4).
        const turns = requestedTurnsFor(conversation, message, devices, { by: device.deviceId, at: acceptedAt });
        const done = accepted({ kind: "message.create", message, ...(turns.length ? { turns } : {}) });
        await this.save(conversation, done, () => turns.map((turn) => store.turnSql(turn)).join("\n"));
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
    op: Extract<HubOp, { kind: "turn.request" | "turn.claim" | "turn.stop" | "turn.finish" }>,
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
      return place_({ ...current, state: "finished", finishedAt: acceptedAt, outcome: op.outcome, ...(op.contextUsage ? { contextUsage: op.contextUsage } : {}) });
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
      // Asked for and not taken yet: nobody ever takes it.
      if (current.state === "requested") return place_({ ...current, state: "stopped", finishedAt: acceptedAt, outcome: "stopped" });
      if (current.state !== "claimed" || current.stopRequestedAt) return unchanged();
      return place_({ ...current, stopRequestedAt: acceptedAt });
    }

    if (!conversation.messages.some((message) => message.id === op.messageId)) return reject(opId, "There is no such message.");
    const home = homeDeviceId(conversation, op.participantId, devices);
    if (!home) return reject(opId, "This member is not in the chat, or its machine is not on the server's roster.");

    if (op.kind === "turn.request") {
      // Any device asks; the member's own device takes it (Д2, Д4).
      if (current) return unchanged(claimOutcomeFor(current, device.deviceId));
      return place_({ runId: op.runId, conversationId: op.conversationId, messageId: op.messageId, participantId: op.participantId,
        state: "requested", requestedAt: acceptedAt, requestedBy: device.deviceId,
        ...(op.pendingMessageId ? { pendingMessageId: op.pendingMessageId } : {}),
        ...(op.request ? { request: op.request } : {}) });
    }

    // turn.claim: only where the member runs (Д4), once (Д5).
    if (home !== device.deviceId) return reject(opId, "Only the device this member runs on may take its turn.");
    const settled = claimOutcomeFor(current, device.deviceId);
    if (settled) return unchanged(settled);
    return place_({ ...(current ?? { runId: op.runId, conversationId: op.conversationId, messageId: op.messageId, participantId: op.participantId }),
      state: "claimed", executorDeviceId: device.deviceId, claimedAt: acceptedAt }, "claimed");
  }

  /** Cards a member waits on (Д9): raised by the device the member runs on,
   *  answered once from any device, settled by the device that raised it. */
  private async applyCard(
    device: HubDevice,
    op: Extract<HubOp, { kind: "card.raise" | "card.answer" | "card.settle" }>,
    devices: HubDevice[],
    place: { opId: string; seq: number; acceptedAt: string }
  ): Promise<Outcome> {
    const { opId, seq, acceptedAt } = place;
    const store = this.storage.hubOps();
    const conversation = await this.load(op.conversationId);
    if (!conversation) return reject(opId, "There is no such chat.");
    const current = await store.card(op.cardId);
    if (current && current.conversationId !== op.conversationId) return reject(opId, "This card belongs to another chat.");
    const placeCard = async (card: HubCard): Promise<Outcome> => {
      const effect: HubOpEffect = { kind: op.kind, card } as HubOpEffect;
      const result: HubOpResult = { opId, status: "accepted", seq, card };
      const entry: HubFeedEntry = { seq, opId, deviceId: device.deviceId, conversationId: op.conversationId, acceptedAt, effect };
      await store.execute(`${store.cardSql(card)} ${store.insertSql({ ...entry, kind: op.kind, result })}`);
      return { result, applied: { deviceId: device.deviceId, entry, conversation } };
    };
    if (op.kind === "card.raise") {
      // A card always names its member, and only the device that member
      // runs on raises it (Д4): a copy of the chat never does.
      if (!op.participantId) return reject(opId, "A card names its member.");
      const home = homeDeviceId(conversation, op.participantId, devices);
      if (home !== device.deviceId) return reject(opId, "Only the device this member runs on raises its cards.");
      if (current && current.raisedBy !== device.deviceId) return reject(opId, "Another device raised this card.");
      if (current && (current.participantId !== op.participantId || current.cardKind !== op.cardKind)) return reject(opId, "A card keeps its member and its kind.");
      // Answered: the answer stands until its device settles it; what the
      // card shows does not change under it.
      if (current && current.state === "answered") return { result: { opId, status: "accepted", seq: seq - 1, card: current } };
      // Settled and raised again by its device: the member waits on it again
      // (its device could not apply the answer it got, and said why when it
      // settled it), so it is asked again, from the start.
      return placeCard({
        cardId: op.cardId, conversationId: op.conversationId, cardKind: op.cardKind, participantId: op.participantId,
        ...(op.messageId ? { messageId: op.messageId } : {}),
        raisedBy: device.deviceId, raisedAt: current?.raisedAt ?? acceptedAt, card: op.card, state: "pending"
      });
    }
    if (!current) return reject(opId, "There is no such card.");
    if (op.kind === "card.answer") {
      if (current.state !== "pending") return reject(opId, "This card was already answered.");
      // The User answers from her computer or her phones (Д2). A machine shows
      // her nothing to answer: it only says that its own member's policy
      // allowed what one of its cards asks (`auto`).
      if (device.role === "machine" && (current.raisedBy !== device.deviceId || (op.answer as { auto?: unknown }).auto !== true)) {
        return reject(opId, "A machine does not answer for the User.");
      }
      return placeCard({ ...current, state: "answered", answer: op.answer, answeredBy: device.deviceId, answeredAt: acceptedAt, answerOpId: opId });
    }
    if (current.raisedBy !== device.deviceId) return reject(opId, "Only the device that raised this card settles it.");
    if (current.state === "settled") return { result: { opId, status: "accepted", seq: seq - 1, card: current } };
    // A settle that says which answer it is about settles only that answer:
    // one sent for an earlier answer never closes the card asked again since.
    const forAnswer = (op.outcome as { answerOpId?: unknown }).answerOpId;
    if (typeof forAnswer === "string" && forAnswer && forAnswer !== current.answerOpId) {
      return reject(opId, "This card's answer is not the one this settles.");
    }
    return placeCard({ ...current, state: "settled", outcome: op.outcome, settledAt: acceptedAt });
  }

  /** Cards not settled yet. */
  async openCards(conversationId?: string): Promise<HubCard[]> {
    return this.storage.hubOps().openCards(conversationId);
  }

  /** Moving a chat to the server, one time, from the computer that held
   *  it: its fields, then its messages page by page; the last page names the
   *  order. Messages only the server held (written on a phone and not yet on
   *  the computer) keep their place by time. */
  private async applyImport(
    device: HubDevice,
    op: Extract<HubOp, { kind: "chat.import" }>,
    devices: HubDevice[],
    place: { opId: string; seq: number; acceptedAt: string }
  ): Promise<Outcome> {
    const { opId, seq, acceptedAt } = place;
    if (device.role !== "owner") return reject(opId, "Only the computer that held the chats moves them to the server.");
    const loaded = await this.load(op.conversationId);
    if (!loaded && !op.conversation) return reject(opId, "The first page of a chat names its fields.");
    const conversation: Conversation = loaded
      ? { ...loaded, messages: [...loaded.messages], metadata: { ...loaded.metadata } }
      : { id: op.conversationId, title: "", kind: "chat", createdAt: acceptedAt, updatedAt: acceptedAt, messages: [], findings: [],
        metadata: { participantSessions: [], warnings: [], running: false } as unknown as Conversation["metadata"] };
    if (op.conversation) {
      const fields = conversationFields(op.conversation);
      conversation.title = fields.title;
      conversation.createdAt = fields.createdAt;
      if (fields.repoPath) conversation.repoPath = fields.repoPath; else delete conversation.repoPath;
      for (const key of SHARED_CONVERSATION_METADATA_KEYS) {
        if (fields.metadata[key] !== undefined) (conversation.metadata as Record<string, unknown>)[key] = fields.metadata[key];
        else delete (conversation.metadata as Record<string, unknown>)[key];
      }
    }
    const store = this.storage.hubOps();
    for (const incoming of op.messages) {
      if (await store.isRemoved(op.conversationId, incoming.id)) continue;
      const index = conversation.messages.findIndex((message) => message.id === incoming.id);
      const writer = incoming.role === "participant" && incoming.participantId
        ? homeDeviceId(conversation, incoming.participantId, devices) ?? device.deviceId
        : device.deviceId;
      const existing = index >= 0 ? conversation.messages[index] : undefined;
      const message = storedMessage(incoming, {
        serverSeq: 0,
        serverWriter: typeof existing?.metadata?.serverWriter === "string" ? existing.metadata.serverWriter : writer,
        reactions: incoming.metadata?.reactions ?? existing?.metadata?.reactions
      });
      if (index >= 0) conversation.messages[index] = message; else conversation.messages.push(message);
    }
    if (op.order) {
      const rank = new Map(op.order.map((id, index) => [id, index]));
      const named = conversation.messages.filter((message) => rank.has(message.id)).sort((left, right) => (rank.get(left.id) ?? 0) - (rank.get(right.id) ?? 0));
      const others = conversation.messages.filter((message) => !rank.has(message.id));
      // Each message only the server held goes before the first named message
      // written after it.
      const merged: ChatMessage[] = [];
      let next = 0;
      for (const message of named) {
        while (next < others.length && others[next].createdAt.localeCompare(message.createdAt) < 0) merged.push(others[next++]);
        merged.push(message);
      }
      while (next < others.length) merged.push(others[next++]);
      conversation.messages = merged.map((message) => typeof message.metadata?.serverSeq === "number" ? message
        : { ...message, metadata: { ...(message.metadata ?? {}), serverSeq: 0 } as ChatMessage["metadata"] });
    }
    conversation.updatedAt = op.conversation?.updatedAt && typeof op.conversation.updatedAt === "string" ? op.conversation.updatedAt : conversation.updatedAt;
    const effect: HubOpEffect = { kind: "chat.import", last: Boolean(op.order) };
    const result: HubOpResult = { opId, status: "accepted", seq };
    const entry: HubFeedEntry = { seq, opId, deviceId: device.deviceId, conversationId: op.conversationId, acceptedAt, effect };
    await this.save(conversation, { result, entry });
    return { result, applied: { deviceId: device.deviceId, entry, conversation } };
  }

  /** Turns asked of this device's members that nobody took yet: what a
   *  computer or machine runs after it was off. */
  async waitingTurns(device: HubDevice): Promise<HubTurn[]> {
    const devices = await this.storage.hub().devices();
    const turns: HubTurn[] = [];
    const chats = new Map<string, Conversation | undefined>();
    for (const turn of await this.storage.hubOps().requested()) {
      if (!chats.has(turn.conversationId)) chats.set(turn.conversationId, await this.load(turn.conversationId));
      const conversation = chats.get(turn.conversationId);
      if (conversation && homeDeviceId(conversation, turn.participantId, devices) === device.deviceId) turns.push(turn);
    }
    return turns;
  }

  /** Turns this device took and never finished: what it closes after it
   *  stopped or restarted in the middle of them. */
  async claimedTurns(device: HubDevice): Promise<HubTurn[]> {
    return this.storage.hubOps().claimedBy(device.deviceId);
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
    let generation = this.generation;
    let page = await store.after(after, HUB_FEED_PAGE_MAX, HUB_FEED_PAGE_BYTES);
    // Something accepted while it read: read again rather than wait for the
    // next word (the one given meanwhile went to nobody).
    while (page.entries.length === 0 && waitMs > 0 && this.generation !== generation) {
      generation = this.generation;
      page = await store.after(after, HUB_FEED_PAGE_MAX, HUB_FEED_PAGE_BYTES);
    }
    // No await between that check and the wait's registration.
    if (page.entries.length === 0 && waitMs > 0) {
      await this.wait(Math.min(waitMs, HUB_FEED_WAIT_MAX_MS), closed);
      page = await store.after(after, HUB_FEED_PAGE_MAX, HUB_FEED_PAGE_BYTES);
    }
    return { entries: page.entries, more: page.more, head: await store.head() };
  }

  /** A chat's documents, as one consistent reading (between operations). */
  artifactStates(conversationId: string): Promise<HubArtifactsResponse> {
    if (!isHubChatId(conversationId)) return Promise.reject(new HubOpsRequestError(400, "Invalid chat id."));
    return this.betweenOperations(async () => ({ head: await this.head(), artifacts: await this.artifacts.states(conversationId) }));
  }

  /** One document whole, without revision bodies; none when the server has
   *  no such document. */
  artifactState(artifactId: string): Promise<HubArtifactResponse> {
    if (!isHubOpId(artifactId)) return Promise.reject(new HubOpsRequestError(400, "Invalid document id."));
    return this.betweenOperations(async () => {
      const head = await this.head();
      const artifact = await this.artifacts.state(artifactId);
      return artifact ? { artifact, head } : { head };
    });
  }

  /** One revision's body; none when the server has no such revision. */
  async artifactRevision(artifactId: string, versionEventId: string): Promise<HubArtifactRevisionResponse> {
    if (!isHubOpId(artifactId) || !versionEventId || versionEventId.length > 256) throw new HubOpsRequestError(400, "Invalid revision.");
    const revision = await this.artifacts.revision(artifactId, versionEventId);
    return revision ? { revision } : {};
  }

  /** Runs a reading after the operations being applied and before the next:
   *  it sees each of them whole or not at all. */
  private betweenOperations<T>(read: () => Promise<T>): Promise<T> {
    const run = this.queue.then(read);
    this.queue = run.catch(() => undefined);
    return run;
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
    this.generation += 1;
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

function isArtifactOp(op: HubOp): op is Extract<HubOp, { kind: HubArtifactOpKind }> {
  return isHubArtifactOpKind(op.kind);
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

/** The turns a User's message asks of the members it names (deliveryTargets):
 *  one per member in the chat, with the id every device can name. */
function requestedTurnsFor(conversation: Conversation, message: ChatMessage, devices: HubDevice[], by: { by: string; at: string }): HubTurn[] {
  if (message.role !== "user") return [];
  const targets = Array.isArray((message.metadata as { deliveryTargets?: unknown } | undefined)?.deliveryTargets)
    ? ((message.metadata as { deliveryTargets: unknown[] }).deliveryTargets).filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  return [...new Set(targets)].filter((participantId) => homeDeviceId(conversation, participantId, devices)).map((participantId) => ({
    runId: hubTurnRunId(message.id, participantId),
    conversationId: conversation.id,
    messageId: message.id,
    participantId,
    state: "requested" as const,
    requestedAt: by.at,
    requestedBy: by.by
  }));
}

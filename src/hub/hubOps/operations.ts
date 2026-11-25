import { CommandError } from "../../main/services/command";
import { randomUUID } from "node:crypto";
import { CHAT_LIST_ORDER_METADATA_KEYS, SHARED_CONVERSATION_METADATA_KEYS } from "../../main/services/chatChanges";
import { changesMembers, scopeMachineConversationUpdate } from "../hubMachineScope";
import type { HubDevice } from "../../shared/hubProtocol";
import { accordClosedLaunchId } from "../../shared/accordProgress";
import {
  HUB_OP_MAX_BYTES, HUB_OPS_MAX_PER_REQUEST, hubOpShapeProblem, isHubOpId, type HubClaimOutcome, type HubFeedEntry, type HubOp,
  type HubOpEffect, type HubOpResult, type HubOpsResponse, type HubTurn
} from "../../shared/hubOps";
import type { ChatMessage, Conversation } from "../../shared/types";
import {
  applyReactions, conversationFields, homeDeviceId, isArtifactOp, reject, requestedTurnsFor, sharedMetadata, storedMessage,
  withMainSessionNamed
} from "./chatRecords";
import { HUB_SERVER_WRITER } from "./constants";
import { mayWriteMessage } from "./messageRights";
import { type HubOpApplied, HubOpsRequestError, type Outcome } from "./types";
import type { HubOpsModules } from "./modules";
import type { HubOpsDependencies } from "./dependencies";

/** Applies devices' operations, one after another. */
export class Operations {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly ops: Pick<HubOpsModules, "cards" | "chatCache" | "feed" | "imports" | "memberRules" | "turns">,
    private readonly deps: Pick<HubOpsDependencies, "artifacts" | "log" | "now" | "storage">
  ) {}

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
    const devices = await this.deps.storage.hub().devices();
    const results: HubOpResult[] = [];
    for (const op of ops) {
      const opId = isHubOpId((op as { opId?: unknown } | undefined)?.opId) ? (op as { opId: string }).opId : "";
      let outcome: Outcome;
      try {
        outcome = await this.applyOne(device, op, devices);
      } catch (error) {
        this.ops.chatCache.cache.clear();
        const message = error instanceof Error ? error.message : String(error);
        this.deps.log("hub.op.error", { opId, deviceId: device.deviceId, message });
        // A failure to store is not the operation's fault: the device sends
        // it again. Nothing was placed.
        if (error instanceof CommandError || !opId) throw error;
        // Anything else would fail the same way every time: this operation
        // is refused, with the reason, and the device's later ones go on.
        outcome = reject(opId, `The server could not apply this operation: ${message.slice(0, 500)}`);
      }
      results.push(outcome.result);
      const kind = typeof (op as { kind?: unknown })?.kind === "string" ? (op as { kind: string }).kind : "";
      const conversationId = typeof (op as { conversationId?: unknown })?.conversationId === "string" ? (op as { conversationId: string }).conversationId : "";
      if (outcome.result.status === "rejected") {
        this.deps.log("hub.op.rejected", { opId, kind, conversationId, deviceId: device.deviceId, reason: outcome.result.reason });
      } else {
        this.deps.log(outcome.result.status === "duplicate" ? "hub.op.duplicate" : "hub.op.accepted", {
          opId, kind, conversationId, deviceId: device.deviceId, seq: outcome.result.seq,
          ...(outcome.result.claim ? { claim: outcome.result.claim } : {})
        });
      }
      if (outcome.applied) {
        for (const listener of this.ops.feed.listeners) {
          try { listener(outcome.applied); } catch { /* a listener never breaks the order */ }
        }
      }
    }
    if (results.some((result) => result.status === "accepted")) this.ops.feed.wake();
    return { results, head: await this.ops.feed.head() };
  }

  /**
   * A message the server writes itself: an urgent alert's card, created or
   * changed as the alert moves on (with no device online). Placed in the
   * same order as devices' operations and fed to every device; only an
   * alert card, and only one the server wrote, can be changed this way.
   */
  writeServerMessage(conversationId: string, message: ChatMessage): Promise<{ seq: number } | { refused: string }> {
    const run = this.queue.then(() => this.applyServerMessage(conversationId, message));
    this.queue = run.catch(() => undefined);
    return run.then((outcome) => {
      if (!("applied" in outcome)) return outcome;
      this.ops.feed.wake();
      for (const listener of this.ops.feed.listeners) {
        try { listener(outcome.applied); } catch { /* a listener never breaks the order */ }
      }
      return { seq: outcome.applied.entry.seq };
    }, (error: unknown) => {
      this.ops.chatCache.cache.clear();
      throw error;
    });
  }

  private async applyServerMessage(conversationId: string, message: ChatMessage): Promise<{ applied: HubOpApplied } | { refused: string }> {
    if (!message.metadata?.urgentAlert) return { refused: "The server writes only urgent alert cards." };
    if (await this.deps.storage.conversationTombstones().isDeleted(conversationId)) return { refused: "This chat was deleted." };
    const store = this.deps.storage.hubOps();
    if (await store.isRemoved(conversationId, message.id)) return { refused: "This message was removed." };
    const loaded = await this.ops.chatCache.load(conversationId);
    if (!loaded) return { refused: "There is no such chat." };
    const conversation: Conversation = { ...loaded, messages: [...loaded.messages], metadata: { ...loaded.metadata } };
    const opId = randomUUID();
    const acceptedAt = this.deps.now().toISOString();
    const seq = (await store.head()) + 1;
    const index = conversation.messages.findIndex((item) => item.id === message.id);
    const current = index >= 0 ? conversation.messages[index] : undefined;
    if (current && current.metadata?.serverWriter !== HUB_SERVER_WRITER) return { refused: "A device wrote this message." };
    const stored = storedMessage(message, {
      serverSeq: typeof current?.metadata?.serverSeq === "number" ? current.metadata.serverSeq : seq,
      serverWriter: HUB_SERVER_WRITER,
      reactions: current?.metadata?.reactions
    });
    if (current) conversation.messages[index] = stored; else conversation.messages.push(stored);
    conversation.updatedAt = acceptedAt;
    const effect: HubOpEffect = current ? { kind: "message.update", message: stored } : { kind: "message.create", message: stored };
    const result: HubOpResult = { opId, status: "accepted", seq };
    const entry: HubFeedEntry = { seq, opId, deviceId: HUB_SERVER_WRITER, conversationId, acceptedAt, effect };
    await this.ops.chatCache.save(conversation, { result, entry });
    return { applied: { deviceId: HUB_SERVER_WRITER, entry, conversation, ...(current ? { previous: current } : {}) } };
  }

  private async applyOne(device: HubDevice, raw: unknown, devices: HubDevice[]): Promise<Outcome> {
    const problem = hubOpShapeProblem(raw);
    const opId = isHubOpId((raw as { opId?: unknown } | undefined)?.opId) ? (raw as { opId: string }).opId : "";
    if (problem) return reject(opId, problem);
    const op = raw as HubOp;
    if (Buffer.byteLength(JSON.stringify(op)) > HUB_OP_MAX_BYTES) return reject(opId, "The operation is too large.");
    const store = this.deps.storage.hubOps();
    const prior = (await store.accepted([op.opId])).get(op.opId);
    if (prior) {
      if (prior.deviceId !== device.deviceId) return reject(opId, "Another device already used this operation id.");
      return { result: { ...prior.result, status: "duplicate" } as HubOpResult };
    }
    if (await this.deps.storage.conversationTombstones().isDeleted(op.conversationId)) return reject(opId, "This chat was deleted.");
    const acceptedAt = this.deps.now().toISOString();
    const seq = (await store.head()) + 1;
    const accepted = (effect: HubOpEffect, extra: { claim?: HubClaimOutcome; turn?: HubTurn } = {}) => ({
      result: { opId, status: "accepted" as const, seq, ...extra },
      entry: { seq, opId, deviceId: device.deviceId, conversationId: op.conversationId, acceptedAt, effect } satisfies HubFeedEntry
    });

    if (op.kind === "conversation.create") {
      // A machine never starts a chat through the app: one it wrote around
      // the app could name any project folder for the members it then asks.
      if (device.role === "machine") return reject(opId, "A cloud machine does not start chats.");
      // A phone paired for one chat starts no other.
      if (device.role === "phone" && device.scope?.scope !== "device") return reject(opId, "This phone was paired for one chat, so it does not start new ones.");
      if (await this.ops.chatCache.load(op.conversationId)) return reject(opId, "This chat already exists.");
      const fields = withMainSessionNamed(conversationFields(op.conversation));
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
      await this.ops.chatCache.save(conversation, done);
      return { result: done.result, applied: { deviceId: device.deviceId, entry: done.entry, conversation } };
    }

    if (op.kind === "chat.import") return this.ops.imports.applyImport(device, op, devices, { opId, seq, acceptedAt });
    if (op.kind === "artifact.import") {
      const outcome = await this.deps.artifacts.import(device, op, { opId, seq, acceptedAt });
      return { result: outcome.result, ...(outcome.entry ? { applied: { deviceId: device.deviceId, entry: outcome.entry } } : {}) };
    }
    if (isArtifactOp(op)) {
      const outcome = await this.deps.artifacts.apply(device, op, { opId, seq, acceptedAt }, (conversation, participantId) => homeDeviceId(conversation, participantId, devices));
      return { result: outcome.result, ...(outcome.entry ? { applied: { deviceId: device.deviceId, entry: outcome.entry } } : {}) };
    }
    if (op.kind === "card.raise" || op.kind === "card.answer" || op.kind === "card.settle") return this.ops.cards.applyCard(device, op, devices, { opId, seq, acceptedAt });
    if (op.kind === "turn.request" || op.kind === "turn.stop" || op.kind === "turn.claim" || op.kind === "turn.finish") {
      return this.ops.turns.applyTurn(device, op, devices, { opId, seq, acceptedAt });
    }

    const loaded = await this.ops.chatCache.load(op.conversationId);
    if (!loaded) return reject(opId, "There is no such chat.");
    const conversation: Conversation = { ...loaded, messages: [...loaded.messages], metadata: { ...loaded.metadata } };

    switch (op.kind) {
      case "conversation.update": {
        // A machine changes what concerns its own members, and nothing that
        // reaches the members that run elsewhere (hubMachineScope.ts).
        let asked: { title?: string; repoPath?: string | null; metadata?: Record<string, unknown>; removedMetadataKeys?: string[] } = op;
        let usedGrants: string[] = [];
        if (device.role === "machine") {
          // The User's approvals and rules matter only to a change of the
          // members or their rules.
          const scoped = scopeMachineConversationUpdate(loaded, op, device.machineId, changesMembers(op) ? {
            approvals: await store.userApprovals(op.conversationId, device.deviceId),
            used: await store.usedGrants(op.conversationId),
            rules: await this.ops.memberRules.memberRules()
          } : {});
          if (scoped.refused.length) this.deps.log("hub.op.machine-scoped", { opId, conversationId: op.conversationId, deviceId: device.deviceId, refused: scoped.refused.slice(0, 20) });
          asked = scoped.update;
          usedGrants = scoped.used;
        }
        const metadata = sharedMetadata(asked.metadata ?? {});
        // A chat's main session is named when the chat is made and never
        // changed (shared/mainSession.ts): nor given to a chat from before.
        if (metadata.mainSessionParticipantId !== undefined && metadata.mainSessionParticipantId !== loaded.metadata.mainSessionParticipantId) {
          delete metadata.mainSessionParticipantId;
        }
        const removed = (asked.removedMetadataKeys ?? []).filter((key) => (SHARED_CONVERSATION_METADATA_KEYS as readonly string[]).includes(key) &&
          key !== "mainSessionParticipantId");
        if (asked.title !== undefined) conversation.title = asked.title;
        if (asked.repoPath === null) delete conversation.repoPath;
        else if (asked.repoPath !== undefined) conversation.repoPath = asked.repoPath;
        for (const [key, value] of Object.entries(metadata)) (conversation.metadata as Record<string, unknown>)[key] = value;
        for (const key of removed) delete (conversation.metadata as Record<string, unknown>)[key];
        // Pinning orders the User's list; it is not activity in the chat, so
        // the chat keeps its time (and its place among the recent ones). An
        // update left with nothing but a pin, or with nothing at all once the
        // keys it may not change were taken out, does not move it either.
        const pinOnly = asked.title === undefined && asked.repoPath === undefined &&
          [...Object.keys(metadata), ...removed].every((key) => CHAT_LIST_ORDER_METADATA_KEYS.includes(key)) &&
          (Object.keys(asked.metadata ?? {}).length > 0 || (asked.removedMetadataKeys ?? []).length > 0);
        if (!pinOnly) conversation.updatedAt = acceptedAt;
        const done = accepted({
          kind: "conversation.update",
          ...(asked.title !== undefined ? { title: asked.title } : {}),
          ...(asked.repoPath !== undefined ? { repoPath: asked.repoPath } : {}),
          ...(Object.keys(metadata).length ? { metadata } : {}),
          ...(removed.length ? { removedMetadataKeys: removed } : {}),
          updatedAt: conversation.updatedAt
        });
        // What gave a lasting change gives it once, noted in the same commit
        // as the change it allowed.
        await this.ops.chatCache.save(conversation, done, usedGrants.length ? (condition) => store.useGrantsSql(op.conversationId, usedGrants, acceptedAt, condition) : undefined);
        return { result: done.result, applied: { deviceId: device.deviceId, entry: done.entry, conversation } };
      }
      case "conversation.delete": {
        const done = accepted({ kind: "conversation.delete" });
        // The chat's documents go with it, in the same commit (Д9).
        const documents = await this.deps.artifacts.deletionSql(op.conversationId, acceptedAt);
        // So do the cards its members waited on: nobody answers or settles
        // them any more (every operation on a deleted chat is refused).
        await this.deps.storage.deleteConversation(op.conversationId, {
          alsoCommitSql: `${store.insertSql({ ...done.entry, kind: op.kind, result: done.result })} ${documents} ${store.deleteCardsSql(op.conversationId)}`
        });
        this.ops.chatCache.cache.delete(op.conversationId);
        return { result: done.result, applied: { deviceId: device.deviceId, entry: done.entry } };
      }
      case "message.create": {
        if (conversation.messages.some((message) => message.id === op.message.id)) return reject(opId, "A message with this id already exists.");
        if (await store.isRemoved(op.conversationId, op.message.id)) return reject(opId, "This message was removed.");
        const refusal = mayWriteMessage(device, conversation, op.message, devices);
        if (refusal) return reject(opId, refusal.rejected);
        const message = storedMessage(op.message, { serverSeq: seq, serverWriter: device.deviceId });
        // A User's message asks a turn of every member it names: waiting on
        // the server for the device each member runs on (Д4). Only one the
        // User wrote: a machine writes the User's words only for its own
        // members (a choice she answered), and never asks anyone by them.
        const turns = device.role === "machine" ? [] : requestedTurnsFor(conversation, message, devices, { by: device.deviceId, at: acceptedAt });
        // From a phone, never of a machine whose program would run a named
        // member's mode otherwise than its controls say: refused with the
        // line, as the computer refuses its own (cliModesTurnRefusal).
        if (device.role === "phone") {
          const modes = await this.ops.memberRules.cliModesRefusal(conversation, turns.map((turn) => turn.participantId), devices);
          if (modes) return reject(opId, modes);
        }
        conversation.messages.push(message);
        // A closed Accord's line is the User's own view of the chat, not
        // news: the chat keeps its place in her list, as a pin does. The
        // server's copy records it over the whole chat, for the phone's list.
        const closedLaunchId = accordClosedLaunchId(message);
        if (!closedLaunchId) conversation.updatedAt = acceptedAt;
        const done = accepted({ kind: "message.create", message, ...(turns.length ? { turns } : {}) });
        await this.ops.chatCache.save(conversation, done, (condition) => turns.map((turn) => store.turnSql(turn, condition)).join("\n"));
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
        if (device.role === "machine" && op.message.role === "user" && op.message.metadata?.hiddenFromTimeline !== true) {
          return reject(opId, "A cloud machine writes the User's words only as a hidden answer for its own member.");
        }
        const message = storedMessage(op.message, {
          serverSeq: typeof current.metadata?.serverSeq === "number" ? current.metadata.serverSeq : seq,
          serverWriter: writer ?? device.deviceId,
          reactions: current.metadata?.reactions
        });
        conversation.messages[index] = message;
        conversation.updatedAt = acceptedAt;
        const done = accepted({ kind: "message.update", message });
        await this.ops.chatCache.save(conversation, done);
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
        await this.ops.chatCache.save(conversation, done);
        return { result: done.result, applied: { deviceId: device.deviceId, entry: done.entry, conversation } };
      }
      case "message.remove": {
        conversation.messages = conversation.messages.filter((message) => message.id !== op.messageId);
        conversation.updatedAt = acceptedAt;
        const done = accepted({ kind: "message.remove", messageId: op.messageId });
        await this.ops.chatCache.save(conversation, done, (condition) => store.removedSql(op.conversationId, op.messageId, acceptedAt, condition));
        return { result: done.result, applied: { deviceId: device.deviceId, entry: done.entry, conversation } };
      }
    }
  }

  /** Runs a reading after the operations being applied and before the next:
   *  it sees each of them whole or not at all. */
  betweenOperations<T>(read: () => Promise<T>): Promise<T> {
    const run = this.queue.then(read);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

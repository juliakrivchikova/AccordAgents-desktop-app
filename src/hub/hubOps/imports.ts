import { SHARED_CONVERSATION_METADATA_KEYS } from "../../main/services/chatChanges";
import type { HubDevice } from "../../shared/hubProtocol";
import type { HubFeedEntry, HubOp, HubOpEffect, HubOpResult } from "../../shared/hubOps";
import type { ChatMessage, Conversation } from "../../shared/types";
import { conversationFields, homeDeviceId, reject, storedMessage, withMainSessionNamed } from "./chatRecords";
import type { Outcome } from "./types";
import type { HubOpsModules } from "./modules";
import type { HubOpsDependencies } from "./dependencies";

/** Chats a device brings to the server. */
export class Imports {
  constructor(
    private readonly ops: Pick<HubOpsModules, "chatCache">,
    private readonly deps: Pick<HubOpsDependencies, "storage">
  ) {}

  /** Moving a chat to the server, one time, from the computer that held
   *  it: its fields, then its messages page by page; the last page names the
   *  order. Messages only the server held (written on a phone and not yet on
   *  the computer) keep their place by time. */
  async applyImport(
    device: HubDevice,
    op: Extract<HubOp, { kind: "chat.import" }>,
    devices: HubDevice[],
    place: { opId: string; seq: number; acceptedAt: string }
  ): Promise<Outcome> {
    const { opId, seq, acceptedAt } = place;
    if (device.role !== "owner") return reject(opId, "Only the computer that held the chats moves them to the server.");
    const loaded = await this.ops.chatCache.load(op.conversationId);
    if (!loaded && !op.conversation) return reject(opId, "The first page of a chat names its fields.");
    const conversation: Conversation = loaded
      ? { ...loaded, messages: [...loaded.messages], metadata: { ...loaded.metadata } }
      : { id: op.conversationId, title: "", kind: "chat", createdAt: acceptedAt, updatedAt: acceptedAt, messages: [], findings: [],
        metadata: { participantSessions: [], warnings: [], running: false } as unknown as Conversation["metadata"] };
    if (op.conversation) {
      // A chat's main session is named when it is made and never changed: a
      // chat the server has keeps its own; a new one names only a member
      // with the main session's role.
      const fields = loaded ? conversationFields(op.conversation) : withMainSessionNamed(conversationFields(op.conversation));
      if (loaded) {
        if (loaded.metadata.mainSessionParticipantId !== undefined) fields.metadata.mainSessionParticipantId = loaded.metadata.mainSessionParticipantId;
        else delete fields.metadata.mainSessionParticipantId;
      }
      conversation.title = fields.title;
      conversation.createdAt = fields.createdAt;
      if (fields.repoPath) conversation.repoPath = fields.repoPath; else delete conversation.repoPath;
      for (const key of SHARED_CONVERSATION_METADATA_KEYS) {
        if (fields.metadata[key] !== undefined) (conversation.metadata as Record<string, unknown>)[key] = fields.metadata[key];
        else delete (conversation.metadata as Record<string, unknown>)[key];
      }
    }
    const removed = await this.deps.storage.hubOps().removedIds(op.conversationId);
    const indexOf = new Map(conversation.messages.map((message, index) => [message.id, index]));
    for (const incoming of op.messages) {
      if (removed.has(incoming.id)) continue;
      const index = indexOf.get(incoming.id) ?? -1;
      // Written here through an operation since (a move interrupted and
      // sent again): the server's copy is the newer one.
      if (index >= 0 && Number(conversation.messages[index].metadata?.serverSeq ?? 0) > 0) continue;
      const writer = incoming.role === "participant" && incoming.participantId
        ? homeDeviceId(conversation, incoming.participantId, devices) ?? device.deviceId
        : device.deviceId;
      const existing = index >= 0 ? conversation.messages[index] : undefined;
      const message = storedMessage(incoming, {
        serverSeq: 0,
        serverWriter: typeof existing?.metadata?.serverWriter === "string" ? existing.metadata.serverWriter : writer,
        reactions: incoming.metadata?.reactions ?? existing?.metadata?.reactions
      });
      if (index >= 0) conversation.messages[index] = message;
      else indexOf.set(message.id, conversation.messages.push(message) - 1);
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
    await this.ops.chatCache.save(conversation, { result, entry });
    return { result, applied: { deviceId: device.deviceId, entry, conversation } };
  }
}

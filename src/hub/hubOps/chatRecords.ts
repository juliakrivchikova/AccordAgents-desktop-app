import { createHash } from "node:crypto";
import { LOCAL_MESSAGE_METADATA_KEYS, SHARED_CONVERSATION_METADATA_KEYS } from "../../main/services/chatChanges";
import type { HubDevice } from "../../shared/hubProtocol";
import { isChatViewMode, mainSessionMemberOf, mainSessionParticipantId } from "../../shared/mainSession";
import { chatSubagentProvidersOf } from "../../shared/subagentProviders";
import {
  hubTurnRunId, isHubArtifactOpKind, type HubArtifactOpKind, type HubConversationFields, type HubOp, type HubTurn
} from "../../shared/hubOps";
import type { ChatMessage, ChatMessageReactions, Conversation } from "../../shared/types";
import { HUB_SERVER_WRITER } from "./constants";
import type { Outcome } from "./types";

/** What a message says, to tell whether it changed. */
export function contentHash(content: string | undefined): string {
  return createHash("sha256").update(content ?? "").digest("hex");
}

export function isArtifactOp(op: HubOp): op is Extract<HubOp, { kind: HubArtifactOpKind }> {
  return isHubArtifactOpKind(op.kind);
}

export function reject(opId: string, reason: string): Outcome {
  return { result: { opId, status: "rejected", reason } };
}

export function sharedMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const shared: Record<string, unknown> = {};
  for (const key of SHARED_CONVERSATION_METADATA_KEYS) if (metadata[key] !== undefined) shared[key] = metadata[key];
  // A pin is `true` and when it was made; anything else a device sends for
  // it is not taken (it would reach every device's list).
  if (shared.pinned !== undefined && shared.pinned !== true) {
    delete shared.pinned;
    delete shared.pinnedAt;
  }
  if (shared.pinnedAt !== undefined && !(typeof shared.pinnedAt === "string" && shared.pinnedAt.length <= 64 && Number.isFinite(Date.parse(shared.pinnedAt)))) {
    delete shared.pinnedAt;
  }
  // The main session is a member's id, and the view one of the two views
  // (shared/mainSession.ts); anything else reaches no device.
  if (shared.mainSessionParticipantId !== undefined && !(typeof shared.mainSessionParticipantId === "string" &&
    shared.mainSessionParticipantId.length > 0 && shared.mainSessionParticipantId.length <= 128)) {
    delete shared.mainSessionParticipantId;
  }
  if (shared.chatView !== undefined && !isChatViewMode(shared.chatView)) {
    delete shared.chatView;
  }
  // The chat's sub-agents: only well-formed entries reach a device.
  if (shared.subagentProviders !== undefined) {
    const layer = chatSubagentProvidersOf({ subagentProviders: shared.subagentProviders });
    if (layer) shared.subagentProviders = layer;
    else delete shared.subagentProviders;
  }
  return shared;
}

/** A new chat names its main session: only a member with the main
 *  session's role (a name for any other member is not taken). A phone from
 *  before sends the main session the computer offered it
 *  (HubNewChatOptions.assistant) among the members without naming it: it is
 *  told by its role, which only a main session has, so that chat is a
 *  main-session chat on every device too. */
export function withMainSessionNamed(fields: HubConversationFields): HubConversationFields {
  const participants = Array.isArray(fields.metadata.participants)
    ? (fields.metadata.participants as unknown[]).filter((item): item is { id: string; roleConfigId?: string } =>
      Boolean(item) && typeof item === "object" && typeof (item as { id?: unknown }).id === "string")
    : [];
  const named = fields.metadata.mainSessionParticipantId;
  const mainSession = mainSessionMemberOf(participants, typeof named === "string" ? named : undefined);
  const { mainSessionParticipantId: _named, ...metadata } = fields.metadata;
  return { ...fields, metadata: mainSession ? { ...metadata, mainSessionParticipantId: mainSession.id } : metadata };
}

export function conversationFields(fields: HubConversationFields): HubConversationFields {
  return {
    title: fields.title,
    kind: "chat",
    createdAt: fields.createdAt,
    ...(fields.repoPath ? { repoPath: fields.repoPath } : {}),
    metadata: sharedMetadata(fields.metadata)
  };
}

export function sharedFieldsOf(conversation: Conversation): HubConversationFields {
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
export function storedMessage(message: ChatMessage, server: { serverSeq: number; serverWriter: string; reactions?: ChatMessageReactions }): ChatMessage {
  const metadata: Record<string, unknown> = { ...(message.metadata ?? {}) };
  for (const key of LOCAL_MESSAGE_METADATA_KEYS) delete metadata[key];
  delete metadata.reactions;
  // An urgent alert's card is the server's alone: a device cannot make one.
  if (server.serverWriter !== HUB_SERVER_WRITER) delete metadata.urgentAlert;
  if (server.reactions && Object.keys(server.reactions).length) metadata.reactions = server.reactions;
  metadata.serverSeq = server.serverSeq;
  metadata.serverWriter = server.serverWriter;
  return { ...message, metadata: metadata as ChatMessage["metadata"] };
}

export function applyReactions(
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
export function requestedTurnsFor(conversation: Conversation, message: ChatMessage, devices: HubDevice[], by: { by: string; at: string }): HubTurn[] {
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

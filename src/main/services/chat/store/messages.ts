import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChatMessage, ChatMessageReactions, Conversation, ParticipantConfig } from "../../../../shared/types";
import { turnFinishedNoteFor } from "../../../../shared/turnFinishedNote";
import { sanitizeWarningList, sanitizeWarningText } from "../../../../shared/warnings";
import { chatParticipants, chatUserDataPath } from "../members/identity";
import { normalizeChatReactionEmoji } from "../../../../shared/chatReactions";

/** A place's name as a member is told it: one short line of text. */
export function placeName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const line = value.replace(/[\r\n\t]+/g, " ").trim().slice(0, 80);
  return line || undefined;
}

/** Copy for values adopted out of a stored snapshot into the live
 *  conversation, so in-place edits of the live object never reach the snapshot
 *  (see readStoredChatStateForRefresh). */
export function cloneJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function chatCreateLogPayload(conversation: Conversation): Record<string, unknown> {
  const participants = chatParticipants(conversation);
  return {
    conversationId: conversation.id,
    titlePreview: conversation.title.trim().replace(/\s+/g, " ").slice(0, 160),
    titleLength: conversation.title.length,
    repoPath: conversation.repoPath,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    participantCount: participants.length,
    participants: participants.map((participant) => ({
      id: participant.id,
      handle: participant.handle,
      kind: participant.kind,
      roleConfigId: participant.roleConfigId
    })),
    messageCount: conversation.messages.length
  };
}

/** Run ids recorded by the cloud-worker transport that no longer exists.
 *  Read only: they identify a chat's historical run files and tell whether a
 *  member ever ran, so deleting a chat still removes what it left behind. */
export function storedRemoteRunIds(value: unknown): string[] {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value as Record<string, unknown>) : [];
}

export async function enqueueDeletedConversationArtifactCleanup(conversation: Conversation): Promise<string> {
  const root = path.join(chatUserDataPath(), "pending-chat-deletions");
  await mkdir(root, { recursive: true });
  const marker = path.join(root, `${conversation.id.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
  const temp = `${marker}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify({
    conversationId: conversation.id,
    runIds: storedRemoteRunIds(conversation.metadata.remoteRunHandles),
    createdAt: new Date().toISOString()
  }), { mode: 0o600 });
  await rename(temp, marker);
  return marker;
}

/** A reply that ended with other messages below it gets a note at the end
 *  of where it stands, leading back to it (turnFinishedNote.ts). Written by
 *  the device the member runs on, in the same save as the reply. */
export function appendTurnFinishedNote(conversation: Conversation, accepted: ChatMessage[]): void {
  if (accepted.length === 0) {
    return;
  }
  const note = turnFinishedNoteFor(conversation, accepted, {
    createdAt: new Date().toISOString(),
    removedIds: normalizedRemovedChatMessageIds(conversation.metadata.removedChatMessageIds)
  });
  if (note) {
    conversation.messages.push(note);
  }
}

export function addConversationWarning(conversation: Conversation, warning: string): void {
  const sanitized = sanitizeWarningText(warning);
  if (!sanitized) {
    return;
  }
  const warnings = sanitizeWarningList(conversation.metadata.warnings);
  if (warnings.includes(sanitized)) {
    return;
  }
  conversation.metadata = { ...conversation.metadata, warnings: [...warnings, sanitized] };
}

export function findMessageRecord(conversation: Conversation, messageId: string): { message: ChatMessage; sequence: number } | undefined {
  const normalizedId = messageId.trim();
  if (!normalizedId) {
    return undefined;
  }
  for (const [sequence, message] of conversation.messages.entries()) {
    if (message.id === normalizedId) {
      return { message, sequence };
    }
  }
  return undefined;
}

export function messageContentPreview(message: ChatMessage): string {
  return message.content.trim().replace(/\s+/g, " ").slice(0, 160);
}

export function createChatMessage(
  role: ChatMessage["role"],
  content: string,
  participant?: ParticipantConfig,
  metadata?: ChatMessage["metadata"],
  status: ChatMessage["status"] = "done"
): ChatMessage {
  return {
    id: randomUUID(),
    role,
    participantId: participant?.id,
    participantLabel: participant?.label,
    content,
    createdAt: new Date().toISOString(),
    status,
    metadata
  };
}

export function clone(conversation: Conversation): Conversation {
  return cloneJsonValue(conversation);
}

export function stableJson(value: unknown): string {
  return JSON.stringify(stableJsonValue(value));
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stableJsonValue(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    sorted[key] = stableJsonValue(record[key]);
  }
  return sorted;
}

export function normalizedRemovedChatMessageIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item && !ids.includes(item)) {
      ids.push(item);
    }
  }
  return ids.slice(-CHAT_REMOVED_MESSAGE_ID_MAX);
}

export function normalizedChatMessageReactions(value: unknown): ChatMessageReactions {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const reactions: ChatMessageReactions = {};
  for (const [emoji, rawReactors] of Object.entries(value)) {
    let normalizedEmoji: string;
    try {
      normalizedEmoji = normalizeChatReactionEmoji(emoji);
    } catch {
      continue;
    }
    if (!Array.isArray(rawReactors)) {
      continue;
    }
    const seenActors = new Set<string>();
    const reactors: ChatMessageReactions[string] = [];
    for (const item of rawReactors) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        continue;
      }
      const reactor = item as Record<string, unknown>;
      const actorId = typeof reactor.actorId === "string" ? reactor.actorId.trim() : "";
      const actorLabel = typeof reactor.actorLabel === "string" ? reactor.actorLabel.trim() : "";
      const actorKind = reactor.actorKind === "user"
        ? "user"
        : reactor.actorKind === "participant"
          ? "participant"
          : undefined;
      const at = typeof reactor.at === "string" && reactor.at.trim() ? reactor.at.trim() : new Date().toISOString();
      if (!actorId || !actorLabel || !actorKind) {
        continue;
      }
      const key = `${actorKind}:${actorId}`;
      if (seenActors.has(key)) {
        continue;
      }
      seenActors.add(key);
      reactors.push({ actorId, actorLabel, actorKind, at });
    }
    if (reactors.length > 0) {
      reactions[normalizedEmoji] = reactors;
    }
  }
  return reactions;
}

// Union merge for completed-message upsert: carry a placeholder's accumulated
// reactions onto the fresh completed message (which has none of its own).
// Existing/placeholder reactors win on a duplicate emoji + actor. Both this and
// the stale-refresh path share normalizedChatMessageReactions for shape/dedup.
export function mergeChatMessageReactions(existing: unknown, incoming: unknown): ChatMessageReactions | undefined {
  const existingReactions = normalizedChatMessageReactions(existing);
  const incomingReactions = normalizedChatMessageReactions(incoming);
  const merged: ChatMessageReactions = {};
  const emojis = new Set([...Object.keys(existingReactions), ...Object.keys(incomingReactions)]);
  for (const emoji of emojis) {
    const seenActors = new Set<string>();
    const reactors: ChatMessageReactions[string] = [];
    for (const reactor of [...(existingReactions[emoji] ?? []), ...(incomingReactions[emoji] ?? [])]) {
      const key = `${reactor.actorKind}:${reactor.actorId}`;
      if (seenActors.has(key)) {
        continue;
      }
      seenActors.add(key);
      reactors.push(reactor);
    }
    if (reactors.length > 0) {
      merged[emoji] = reactors;
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function hasStaleRunRecoveryMarker(message: ChatMessage): boolean {
  return Boolean(message.metadata?.staleRunRecovery);
}

export const CHAT_REMOVED_MESSAGE_ID_MAX = 100;

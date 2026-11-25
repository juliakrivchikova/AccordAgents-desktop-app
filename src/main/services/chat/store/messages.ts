import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChatMessage, Conversation, ParticipantConfig } from "../../../../shared/types";
import { turnFinishedNoteFor } from "../../../../shared/turnFinishedNote";
import { sanitizeWarningList, sanitizeWarningText } from "../../../../shared/warnings";
import { chatParticipants, chatUserDataPath } from "../members/identity";
import { normalizedRemovedChatMessageIds } from "./mergeStoredChat";

/** Copy for values adopted out of a stored snapshot into the live
 *  conversation, so in-place edits of the live object never reach the snapshot
 *  (see readStoredChatStateForRefresh). */
/** A place's name as a member is told it: one short line of text. */
export function placeName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const line = value.replace(/[\r\n\t]+/g, " ").trim().slice(0, 80);
  return line || undefined;
}

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

export function storedRemoteRunParticipantIds(value: unknown): Set<string> {
  const participantIds = new Set<string>();
  if (!value || typeof value !== "object" || Array.isArray(value)) return participantIds;
  for (const handle of Object.values(value as Record<string, unknown>)) {
    const participantId = handle && typeof handle === "object" ? (handle as { participantId?: unknown }).participantId : undefined;
    if (typeof participantId === "string" && participantId) participantIds.add(participantId);
  }
  return participantIds;
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

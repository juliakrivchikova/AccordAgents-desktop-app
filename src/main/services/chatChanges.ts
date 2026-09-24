import { createHash } from "node:crypto";
import { stableJson } from "../../shared/stableJson";
import type { ChatMessage, ChatMessageReactions, ChatReactor, Conversation } from "../../shared/types";

/**
 * Chat content as events: the one way a chat's state reaches another device.
 *
 * A save compares the chat with what the database held before it (never with
 * an in-memory guess, which a restart would lose) and records the difference
 * as one signed `chat.changes` event, committed in the same SQLite transaction
 * as the save. Receivers fold that event into their own copy.
 *
 * Who may change what is decided per field, not per message:
 *   - a message's content and status: only its owner (the device that runs
 *     the member that wrote it, or the device where it was typed);
 *   - reactions: anyone, merged key by key;
 *   - removal: anyone, merged as a union of removed ids;
 *   - the chat's own shared fields (title, members, project, archive state):
 *     only the device that installed the machines (the desktop).
 * Everything else on a chat or a message is device-local run bookkeeping and
 * never leaves the device.
 */

export const CHAT_CHANGES_EVENT_KIND = "chat.changes";
export const CHAT_CHANGES_VERSION = 1;

/** One log scope per chat, so a gap in one chat never holds another. */
export function chatChangesLogScope(conversationId: string): string {
  return `chat-changes:${conversationId}`;
}

export function isChatChangesLogScope(logScopeId: string): boolean {
  return logScopeId.startsWith("chat-changes:") && logScopeId.length > "chat-changes:".length;
}

/** Conversation metadata that is chat content. Every other key is local. */
export const SHARED_CONVERSATION_METADATA_KEYS: readonly string[] = [
  "participants",
  "autoTitle",
  "appToolApprovalPolicies",
  "archived",
  "archivedAt",
  "residency"
];

/** Message metadata that describes one device's run of a message. */
export const LOCAL_MESSAGE_METADATA_KEYS: readonly string[] = [
  "executionLease",
  "queuedBehind",
  "stopPending",
  "machinePending",
  "cloudRunPreparation",
  "staleRunRecovery",
  /** Which device created a message that arrived from elsewhere. */
  "remoteAuthorOriginId"
];

export interface SharedConversationState {
  title: string;
  kind: Conversation["kind"];
  createdAt: string;
  repoPath?: string;
  metadata: Record<string, unknown>;
}

export interface ChatReactionAdded {
  emoji: string;
  reactor: ChatReactor;
}

export interface ChatReactionRemoved {
  emoji: string;
  actorId: string;
}

export type ChatChange =
  | { type: "conversation.created"; conversation: SharedConversationState }
  | { type: "conversation.updated"; title?: string; repoPath?: string | null; metadata?: Record<string, unknown>; removedMetadataKeys?: string[] }
  | { type: "message.created"; message: ChatMessage }
  | { type: "message.updated"; message: ChatMessage }
  | { type: "message.reactions"; messageId: string; added: ChatReactionAdded[]; removed: ChatReactionRemoved[] }
  | { type: "message.removed"; messageId: string };

export interface ChatChangesPayload {
  version: typeof CHAT_CHANGES_VERSION;
  conversationId: string;
  updatedAt: string;
  changes: ChatChange[];
}

/** What the database held for a chat, reduced to what a diff needs. */
export interface ChatChangeBaseline {
  shared: Record<string, string>;
  messages: Map<string, { shared: string; reactions: Map<string, string> }>;
  removed: Set<string>;
}

export interface ChatChangeDiffPolicy {
  /** May this device change the chat's own shared fields? */
  emitsConversationFields: boolean;
  /** May this device change this message's content and status? */
  ownsMessage(message: ChatMessage): boolean;
}

export interface ChatChangeDiff {
  changes: ChatChange[];
  /** Content changes this device made to messages it does not own. They stay
   *  local; the owner's version wins everywhere else. */
  suppressedMessageIds: string[];
}

export interface ChatChangeApplyPolicy {
  acceptsConversationFields(originId: string): boolean;
  acceptsMessageUpdate(existing: ChatMessage, conversation: Conversation, originId: string): boolean;
}

export type ChatChangeApplyResult =
  | { status: "applied"; conversation: Conversation; created: boolean; changed: boolean; ignored: string[] }
  | { status: "missing-conversation" };

function hash(value: unknown): string {
  return createHash("sha1").update(stableJson(value ?? null)).digest("hex");
}

export function sharedConversationState(conversation: Conversation): SharedConversationState {
  const metadata: Record<string, unknown> = {};
  for (const key of SHARED_CONVERSATION_METADATA_KEYS) {
    if (conversation.metadata?.[key] !== undefined) metadata[key] = conversation.metadata[key];
  }
  return {
    title: conversation.title,
    kind: conversation.kind,
    createdAt: conversation.createdAt,
    ...(conversation.repoPath ? { repoPath: conversation.repoPath } : {}),
    metadata
  };
}

/** The message as it travels: local run bookkeeping removed. */
export function sharedMessage(message: ChatMessage, options: { withReactions: boolean }): ChatMessage {
  const { metadata, ...rest } = message;
  if (!metadata) return { ...rest };
  const shared: Record<string, unknown> = { ...metadata };
  for (const key of LOCAL_MESSAGE_METADATA_KEYS) delete shared[key];
  if (!options.withReactions) delete shared.reactions;
  return Object.keys(shared).length ? { ...rest, metadata: shared as ChatMessage["metadata"] } : { ...rest };
}

function reactionEntries(message: ChatMessage): Map<string, string> {
  const entries = new Map<string, string>();
  const reactions = message.metadata?.reactions;
  if (!reactions || typeof reactions !== "object") return entries;
  for (const [emoji, reactors] of Object.entries(reactions)) {
    if (!Array.isArray(reactors)) continue;
    for (const reactor of reactors) {
      if (!reactor || typeof reactor.actorId !== "string") continue;
      entries.set(reactionKey(emoji, reactor.actorId), stableJson({ emoji, reactor }));
    }
  }
  return entries;
}

function reactionKey(emoji: string, actorId: string): string {
  return `${emoji}\u0000${actorId}`;
}

function removedIds(conversation: Conversation): Set<string> {
  const value = conversation.metadata?.removedChatMessageIds;
  return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === "string" && id.length > 0) : []);
}

function sharedFieldHashes(conversation: Conversation): Record<string, string> {
  const state = sharedConversationState(conversation);
  const hashes: Record<string, string> = {
    title: hash(state.title),
    repoPath: hash(state.repoPath ?? null)
  };
  for (const key of SHARED_CONVERSATION_METADATA_KEYS) {
    hashes[`metadata.${key}`] = hash(state.metadata[key] ?? null);
  }
  return hashes;
}

/** Undefined when the database holds no row for the chat yet. */
export function chatChangeBaseline(conversation: Conversation | undefined): ChatChangeBaseline | undefined {
  if (!conversation) return undefined;
  const messages = new Map<string, { shared: string; reactions: Map<string, string> }>();
  for (const message of conversation.messages) {
    messages.set(message.id, {
      shared: hash(sharedMessage(message, { withReactions: false })),
      reactions: reactionEntries(message)
    });
  }
  return { shared: sharedFieldHashes(conversation), messages, removed: removedIds(conversation) };
}

export function diffChatChanges(
  baseline: ChatChangeBaseline | undefined,
  next: Conversation,
  policy: ChatChangeDiffPolicy
): ChatChangeDiff {
  const changes: ChatChange[] = [];
  const suppressedMessageIds: string[] = [];
  const removed = removedIds(next);
  if (!baseline) {
    changes.push({ type: "conversation.created", conversation: sharedConversationState(next) });
    for (const message of next.messages) {
      if (!removed.has(message.id)) changes.push({ type: "message.created", message: sharedMessage(message, { withReactions: true }) });
    }
    return { changes, suppressedMessageIds };
  }
  if (policy.emitsConversationFields) {
    const hashes = sharedFieldHashes(next);
    const state = sharedConversationState(next);
    const update: Extract<ChatChange, { type: "conversation.updated" }> = { type: "conversation.updated" };
    let changed = false;
    if (hashes.title !== baseline.shared.title) {
      update.title = state.title;
      changed = true;
    }
    if (hashes.repoPath !== baseline.shared.repoPath) {
      update.repoPath = state.repoPath ?? null;
      changed = true;
    }
    for (const key of SHARED_CONVERSATION_METADATA_KEYS) {
      const field = `metadata.${key}`;
      if (hashes[field] === baseline.shared[field]) continue;
      changed = true;
      if (state.metadata[key] === undefined) {
        (update.removedMetadataKeys ??= []).push(key);
      } else {
        (update.metadata ??= {})[key] = state.metadata[key];
      }
    }
    if (changed) changes.push(update);
  }
  for (const message of next.messages) {
    if (removed.has(message.id)) continue;
    const before = baseline.messages.get(message.id);
    if (!before) {
      changes.push({ type: "message.created", message: sharedMessage(message, { withReactions: true }) });
      continue;
    }
    if (hash(sharedMessage(message, { withReactions: false })) !== before.shared) {
      if (policy.ownsMessage(message)) {
        changes.push({ type: "message.updated", message: sharedMessage(message, { withReactions: false }) });
      } else {
        suppressedMessageIds.push(message.id);
      }
    }
    const after = reactionEntries(message);
    const added: ChatReactionAdded[] = [];
    const removedReactions: ChatReactionRemoved[] = [];
    for (const [key, value] of after) {
      if (before.reactions.get(key) !== value) added.push(JSON.parse(value) as ChatReactionAdded);
    }
    for (const key of before.reactions.keys()) {
      if (!after.has(key)) {
        const [emoji, actorId] = key.split("\u0000");
        removedReactions.push({ emoji, actorId });
      }
    }
    if (added.length || removedReactions.length) {
      changes.push({ type: "message.reactions", messageId: message.id, added, removed: removedReactions });
    }
  }
  for (const id of removed) {
    if (!baseline.removed.has(id)) changes.push({ type: "message.removed", messageId: id });
  }
  return { changes, suppressedMessageIds };
}

function sortedByCreatedAt(messages: ChatMessage[]): ChatMessage[] {
  return messages
    .map((message, index) => ({ message, index }))
    .sort((left, right) => left.message.createdAt.localeCompare(right.message.createdAt) || left.index - right.index)
    .map((entry) => entry.message);
}

/** Keeps this device's own bookkeeping and reactions on a message whose
 *  shared content is replaced by an incoming copy. */
function mergeIncomingMessage(existing: ChatMessage | undefined, incoming: ChatMessage, originId: string, created: boolean): ChatMessage {
  const metadata: Record<string, unknown> = { ...(incoming.metadata ?? {}) };
  for (const key of LOCAL_MESSAGE_METADATA_KEYS) delete metadata[key];
  if (existing?.metadata) {
    for (const key of LOCAL_MESSAGE_METADATA_KEYS) {
      if (existing.metadata[key as keyof typeof existing.metadata] !== undefined) {
        metadata[key] = existing.metadata[key as keyof typeof existing.metadata];
      }
    }
    if (!created && existing.metadata.reactions !== undefined) metadata.reactions = existing.metadata.reactions;
  }
  if (!existing) metadata.remoteAuthorOriginId = originId;
  return Object.keys(metadata).length ? { ...incoming, metadata: metadata as ChatMessage["metadata"] } : { ...incoming, metadata: undefined };
}

function applyReactions(message: ChatMessage, added: ChatReactionAdded[], removed: ChatReactionRemoved[]): ChatMessage {
  const reactions: ChatMessageReactions = {};
  for (const [emoji, reactors] of Object.entries(message.metadata?.reactions ?? {})) {
    if (Array.isArray(reactors) && reactors.length) reactions[emoji] = [...reactors];
  }
  for (const entry of removed) {
    const list = reactions[entry.emoji]?.filter((reactor) => reactor.actorId !== entry.actorId);
    if (!list) continue;
    if (list.length) reactions[entry.emoji] = list; else delete reactions[entry.emoji];
  }
  for (const entry of added) {
    const list = (reactions[entry.emoji] ?? []).filter((reactor) => reactor.actorId !== entry.reactor.actorId);
    list.push(entry.reactor);
    reactions[entry.emoji] = list;
  }
  const metadata = { ...(message.metadata ?? {}) } as NonNullable<ChatMessage["metadata"]>;
  if (Object.keys(reactions).length) metadata.reactions = reactions; else delete metadata.reactions;
  return { ...message, metadata };
}

function newConversation(conversationId: string, state: SharedConversationState, updatedAt: string): Conversation {
  return {
    id: conversationId,
    title: state.title,
    kind: state.kind,
    createdAt: state.createdAt,
    updatedAt,
    ...(state.repoPath ? { repoPath: state.repoPath } : {}),
    messages: [],
    findings: [],
    metadata: { ...state.metadata, participantSessions: [], warnings: [], running: false }
  };
}

/**
 * Folds one incoming `chat.changes` event into this device's copy. Pure: the
 * caller persists the result (without emitting it again).
 */
export function applyChatChanges(
  existing: Conversation | undefined,
  payload: ChatChangesPayload,
  originId: string,
  policy: ChatChangeApplyPolicy
): ChatChangeApplyResult {
  let conversation = existing ? { ...existing, messages: [...existing.messages], metadata: { ...existing.metadata } } : undefined;
  let created = false;
  let changed = false;
  const ignored: string[] = [];
  for (const change of payload.changes) {
    if (change.type === "conversation.created") {
      if (!conversation) {
        conversation = newConversation(payload.conversationId, change.conversation, payload.updatedAt);
        created = true;
        changed = true;
      }
      continue;
    }
    if (!conversation) return { status: "missing-conversation" };
    switch (change.type) {
      case "conversation.updated": {
        if (!policy.acceptsConversationFields(originId)) {
          ignored.push("conversation.updated");
          break;
        }
        if (typeof change.title === "string") conversation.title = change.title;
        if (change.repoPath === null) delete conversation.repoPath;
        else if (typeof change.repoPath === "string") conversation.repoPath = change.repoPath;
        for (const [key, value] of Object.entries(change.metadata ?? {})) {
          if (SHARED_CONVERSATION_METADATA_KEYS.includes(key)) conversation.metadata[key] = value;
        }
        for (const key of change.removedMetadataKeys ?? []) {
          if (SHARED_CONVERSATION_METADATA_KEYS.includes(key)) delete conversation.metadata[key];
        }
        changed = true;
        break;
      }
      case "message.created":
      case "message.updated": {
        if (!change.message || typeof change.message.id !== "string") {
          ignored.push(change.type);
          break;
        }
        if (removedIds(conversation).has(change.message.id)) break;
        const index = conversation.messages.findIndex((message) => message.id === change.message.id);
        if (index < 0) {
          conversation.messages.push(mergeIncomingMessage(undefined, change.message, originId, true));
          changed = true;
          break;
        }
        const current = conversation.messages[index];
        if (!policy.acceptsMessageUpdate(current, conversation, originId)) {
          ignored.push(`${change.type}:${change.message.id}`);
          break;
        }
        conversation.messages[index] = mergeIncomingMessage(current, change.message, originId, false);
        changed = true;
        break;
      }
      case "message.reactions": {
        const index = conversation.messages.findIndex((message) => message.id === change.messageId);
        if (index < 0) {
          ignored.push(`message.reactions:${change.messageId}`);
          break;
        }
        conversation.messages[index] = applyReactions(conversation.messages[index], change.added ?? [], change.removed ?? []);
        changed = true;
        break;
      }
      case "message.removed": {
        const removed = removedIds(conversation);
        if (!removed.has(change.messageId)) {
          conversation.metadata.removedChatMessageIds = [...removed, change.messageId].slice(-100);
        }
        conversation.messages = conversation.messages.filter((message) => message.id !== change.messageId);
        changed = true;
        break;
      }
    }
  }
  if (!conversation) return { status: "missing-conversation" };
  if (changed) {
    conversation.messages = sortedByCreatedAt(conversation.messages);
    if (payload.updatedAt && (!conversation.updatedAt || payload.updatedAt > conversation.updatedAt)) conversation.updatedAt = payload.updatedAt;
  }
  return { status: "applied", conversation, created, changed, ignored };
}

const CHANGE_TYPES = new Set(["conversation.created", "conversation.updated", "message.created", "message.updated", "message.reactions", "message.removed"]);

export function isChatChangesPayload(value: unknown): value is ChatChangesPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<ChatChangesPayload>;
  return payload.version === CHAT_CHANGES_VERSION && typeof payload.conversationId === "string" && payload.conversationId.length > 0 &&
    typeof payload.updatedAt === "string" && Array.isArray(payload.changes) &&
    payload.changes.every((change) => Boolean(change) && typeof change === "object" && CHANGE_TYPES.has((change as ChatChange).type));
}

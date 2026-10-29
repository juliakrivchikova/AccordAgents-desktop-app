import { createHash } from "node:crypto";
import { stableJson } from "../../shared/stableJson";
import type { ChatMessage, ChatReactor, Conversation } from "../../shared/types";

/**
 * What a save changed in a chat: the one way a chat's change leaves a device
 * for the User's server, which owns every chat (agreements Д1–Д13). A save
 * compares the chat with what the database held before it (never with an
 * in-memory guess, which a restart would lose); chatServerOps turns the
 * difference into operations, queued in the same SQLite transaction as the
 * save.
 *
 * What a device writes is decided per field, not per message:
 *   - a message's content and status: only the device that may write it
 *     (where its member runs, or where it was typed);
 *   - reactions: anyone, key by key;
 *   - removal: anyone;
 *   - the chat's own shared fields (title, members, project, archive state).
 * Everything else on a chat or a message is device-local run bookkeeping and
 * never leaves the device.
 */

/** Chat ids name directories (chats/<id>) on every device, so one that
 *  arrives from another device must be a plain token, never a path. */
export function isSafeChatId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
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
  /** Which device created a message, as messages from before the User's
   *  server owned the chats recorded it. */
  "remoteAuthorOriginId",
  /** The User's server: the turns a message asked for, as this device
   *  last heard of them, and a placeholder bubble for a member that runs
   *  elsewhere (shown until its device writes the real one). */
  "serverTurns",
  "serverPlaceholder",
  "serverRejected",
  /** A card of a member elsewhere answered on the server and not applied
   *  there yet, as this device shows it. */
  "serverCard"
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

type MessageDigest = { shared: string; reactions: Map<string, string> };

/**
 * A saved chat's messages are immutable objects, kept from one save to the
 * next while unchanged (see buildConversationSnapshot), so a message is
 * digested once, not on every save of a chat that is thousands long.
 */
const messageDigests = new WeakMap<ChatMessage, MessageDigest>();

function messageDigest(message: ChatMessage): MessageDigest {
  let digest = messageDigests.get(message);
  if (!digest) {
    digest = { shared: hash(sharedMessage(message, { withReactions: false })), reactions: reactionEntries(message) };
    messageDigests.set(message, digest);
  }
  return digest;
}

/** Undefined when the database holds no row for the chat yet. */
export function chatChangeBaseline(conversation: Conversation | undefined): ChatChangeBaseline | undefined {
  if (!conversation) return undefined;
  const messages = new Map<string, MessageDigest>();
  for (const message of conversation.messages) messages.set(message.id, messageDigest(message));
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
    const digest = messageDigest(message);
    if (digest === before) continue;
    if (digest.shared !== before.shared) {
      if (policy.ownsMessage(message)) {
        changes.push({ type: "message.updated", message: sharedMessage(message, { withReactions: false }) });
      } else {
        suppressedMessageIds.push(message.id);
      }
    }
    const after = digest.reactions;
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

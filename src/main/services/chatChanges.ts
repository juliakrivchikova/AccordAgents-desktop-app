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
/**
 * Every enrolled machine is addressed every change; one whose runtime folds
 * an older version is sent none of them (and no turn) until it is updated,
 * and then gets them all in order. A payload of a newer version than a device
 * folds waits there, unapplied, until that device is updated.
 */
export const CHAT_CHANGES_VERSION = 1;

export const CHAT_CHANGES_LOG_SCOPE_PREFIX = "chat-changes:";

/** One log scope per chat, so a gap in one chat never holds another. */
export function chatChangesLogScope(conversationId: string): string {
  return `${CHAT_CHANGES_LOG_SCOPE_PREFIX}${conversationId}`;
}

export function isChatChangesLogScope(logScopeId: string): boolean {
  return logScopeId.startsWith(CHAT_CHANGES_LOG_SCOPE_PREFIX) && isSafeChatId(logScopeId.slice(CHAT_CHANGES_LOG_SCOPE_PREFIX.length));
}

/** A SQL condition selecting chat change scopes on `column`, as an index range. */
export function chatChangesScopeSql(column: string): string {
  return `${column} >= '${CHAT_CHANGES_LOG_SCOPE_PREFIX}' and ${column} < 'chat-changes;'`;
}

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
  /** Machines only: the desktop's newest change of this chat its author had
   *  applied. A member or a home it names may come from that change, so
   *  another machine judges this one only once it has applied it too. */
  after?: { originId: string; originSeq: number };
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
  /** May `originId` set the chat's shared fields, including creating it? */
  acceptsConversationFields(originId: string): boolean;
  /** May `originId` change this message's content and status (to `incoming`)? */
  acceptsMessageUpdate(existing: ChatMessage, conversation: Conversation, originId: string, incoming: ChatMessage): boolean;
  /** May `originId` add this message? A member's reply comes only from where
   *  that member runs (or the desktop that dispatches it). */
  acceptsMessageCreate(message: ChatMessage, conversation: Conversation, originId: string): boolean;
  /** May `originId` remove this message? Only the desktop, or the device that
   *  may change it. */
  acceptsMessageRemoval(existing: ChatMessage | undefined, conversation: Conversation, originId: string): boolean;
  /** A chat this device does not hold yet is waited for (machines), or a
   *  change for it is refused (the desktop, where every chat starts). */
  holdsUnknownChats: boolean;
}

export type ChatChangeApplyResult =
  | { status: "applied"; conversation: Conversation; created: boolean; changed: boolean; ignored: string[] }
  | { status: "missing-conversation" }
  /** Nothing to store: every change was refused (a chat this device will
   *  never hold, or one the sender may not create). */
  | { status: "ignored"; ignored: string[] };

/** How many removed message ids a chat remembers (the same cap ChatService uses). */
export const CHAT_REMOVED_MESSAGE_IDS_MAX = 100;

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

/** Messages in creation order; the original order breaks ties. */
function sortedByCreatedAt(messages: ChatMessage[]): ChatMessage[] {
  return messages
    .map((message, index) => ({ message, index }))
    .sort((left, right) => left.message.createdAt.localeCompare(right.message.createdAt) || left.index - right.index)
    .map((entry) => entry.message);
}

/** Keeps this device's own bookkeeping and reactions on a message whose
 *  shared content is replaced by an incoming change. */
function mergeIncomingMessage(existing: ChatMessage | undefined, incoming: ChatMessage, originId: string): ChatMessage {
  const metadata: Record<string, unknown> = { ...(incoming.metadata ?? {}) };
  for (const key of LOCAL_MESSAGE_METADATA_KEYS) delete metadata[key];
  if (existing?.metadata) {
    for (const key of LOCAL_MESSAGE_METADATA_KEYS) {
      if (existing.metadata[key as keyof typeof existing.metadata] !== undefined) {
        metadata[key] = existing.metadata[key as keyof typeof existing.metadata];
      }
    }
    // An owner's update carries no reactions; this device's merged set stays.
    if (existing.metadata.reactions !== undefined) metadata.reactions = existing.metadata.reactions;
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
  // Only the chat's shared fields are taken from another device; everything
  // else on a new chat starts as this device's own.
  const metadata: Record<string, unknown> = { participantSessions: [], warnings: [], running: false };
  for (const key of SHARED_CONVERSATION_METADATA_KEYS) {
    if (state.metadata?.[key] !== undefined) metadata[key] = state.metadata[key];
  }
  return {
    id: conversationId,
    title: state.title,
    kind: "chat",
    createdAt: state.createdAt,
    updatedAt,
    ...(state.repoPath ? { repoPath: state.repoPath } : {}),
    messages: [],
    findings: [],
    metadata: metadata as Conversation["metadata"]
  };
}

/** Reactions to a message this device does not hold yet. They come from
 *  another device's log than the message itself, so they can arrive first;
 *  they are kept here (device-local) and applied when the message arrives. */
const PENDING_REACTIONS_KEY = "pendingChatReactions";
const PENDING_REACTIONS_MAX = 200;

type PendingReactions = Record<string, { added: ChatReactionAdded[]; removed: ChatReactionRemoved[] }>;

function pendingReactions(conversation: Conversation): PendingReactions {
  const value = (conversation.metadata as Record<string, unknown>)[PENDING_REACTIONS_KEY];
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as PendingReactions) } : {};
}

function setPendingReactions(conversation: Conversation, pending: PendingReactions): void {
  const ids = Object.keys(pending);
  const metadata = conversation.metadata as Record<string, unknown>;
  if (!ids.length) {
    delete metadata[PENDING_REACTIONS_KEY];
    return;
  }
  const kept = ids.slice(-PENDING_REACTIONS_MAX);
  metadata[PENDING_REACTIONS_KEY] = Object.fromEntries(kept.map((id) => [id, pending[id]]));
}

/**
 * Folds one incoming `chat.changes` event into this device's copy. Pure: the
 * caller persists the result (without emitting it again). A change the rules
 * refuse is listed in `ignored`; it never stops the rest of the event.
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
    if (!isValidChange(change)) {
      ignored.push(`invalid:${typeof (change as { type?: unknown })?.type === "string" ? (change as { type: string }).type : "unknown"}`);
      continue;
    }
    if (change.type === "conversation.created") {
      if (!conversation) {
        if (!policy.acceptsConversationFields(originId)) {
          ignored.push("conversation.created");
          continue;
        }
        conversation = newConversation(payload.conversationId, change.conversation, payload.updatedAt);
        created = true;
        changed = true;
      }
      continue;
    }
    if (!conversation) {
      if (policy.holdsUnknownChats) return { status: "missing-conversation" };
      ignored.push(`${change.type}:unknown-chat`);
      continue;
    }
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
        if (removedIds(conversation).has(change.message.id)) break;
        const index = conversation.messages.findIndex((message) => message.id === change.message.id);
        if (index < 0) {
          if (!policy.acceptsMessageCreate(change.message, conversation, originId)) {
            ignored.push(`${change.type}:${change.message.id}`);
            break;
          }
          let inserted = mergeIncomingMessage(undefined, change.message, originId);
          const pending = pendingReactions(conversation);
          const held = pending[inserted.id];
          if (held) {
            inserted = applyReactions(inserted, held.added, held.removed);
            delete pending[inserted.id];
            setPendingReactions(conversation, pending);
          }
          conversation.messages.push(inserted);
          changed = true;
          break;
        }
        const current = conversation.messages[index];
        if (!policy.acceptsMessageUpdate(current, conversation, originId, change.message)) {
          ignored.push(`${change.type}:${change.message.id}`);
          break;
        }
        conversation.messages[index] = mergeIncomingMessage(current, change.message, originId);
        changed = true;
        break;
      }
      case "message.reactions": {
        const index = conversation.messages.findIndex((message) => message.id === change.messageId);
        if (index < 0) {
          if (removedIds(conversation).has(change.messageId)) break;
          const pending = pendingReactions(conversation);
          const held = pending[change.messageId] ?? { added: [], removed: [] };
          // Kept as where each reaction ended up, in the order they came: one
          // added and then removed before the message arrives stays removed.
          const same = (emoji: string, actorId: string) => (entry: { emoji: string; actorId?: string; reactor?: { actorId: string } }) =>
            entry.emoji === emoji && (entry.actorId ?? entry.reactor?.actorId) === actorId;
          let added = held.added.filter((entry) => !change.removed.some((removal) => same(removal.emoji, removal.actorId)(entry))
            && !change.added.some((addition) => same(addition.emoji, addition.reactor.actorId)(entry)));
          let removed = held.removed.filter((entry) => !change.added.some((addition) => same(addition.emoji, addition.reactor.actorId)(entry))
            && !change.removed.some((removal) => same(removal.emoji, removal.actorId)(entry)));
          added = [...added, ...change.added];
          removed = [...removed, ...change.removed];
          pending[change.messageId] = { added, removed };
          setPendingReactions(conversation, pending);
          changed = true;
          break;
        }
        conversation.messages[index] = applyReactions(conversation.messages[index], change.added, change.removed);
        changed = true;
        break;
      }
      case "message.removed": {
        const current = conversation.messages.find((message) => message.id === change.messageId);
        if (!policy.acceptsMessageRemoval(current, conversation, originId)) {
          ignored.push(`message.removed:${change.messageId}`);
          break;
        }
        const removed = removedIds(conversation);
        if (!removed.has(change.messageId)) {
          conversation.metadata.removedChatMessageIds = [...removed, change.messageId].slice(-CHAT_REMOVED_MESSAGE_IDS_MAX);
        }
        conversation.messages = conversation.messages.filter((message) => message.id !== change.messageId);
        changed = true;
        break;
      }
    }
  }
  if (!conversation) {
    return policy.holdsUnknownChats ? { status: "missing-conversation" } : { status: "ignored", ignored };
  }
  if (changed) {
    conversation.messages = sortedByCreatedAt(conversation.messages);
    if (payload.updatedAt && (!conversation.updatedAt || payload.updatedAt > conversation.updatedAt)) conversation.updatedAt = payload.updatedAt;
  }
  return { status: "applied", conversation, created, changed, ignored };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isValidMessage(value: unknown): value is ChatMessage {
  return isRecord(value) && typeof value.id === "string" && value.id.length > 0 && value.id.length <= 256 &&
    typeof value.role === "string" && typeof value.content === "string" && typeof value.createdAt === "string" &&
    (value.metadata === undefined || isRecord(value.metadata));
}

function isValidReactor(value: unknown): value is ChatReactor {
  return isRecord(value) && typeof value.actorId === "string" && value.actorId.length > 0;
}

/** One change of a known type with the fields applying it reads. Anything
 *  else is skipped: refusing the whole event would stop that chat's log on
 *  this device for good, and a newer peer may add change types. */
export function isValidChange(value: unknown): value is ChatChange {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "conversation.created": {
      const state = value.conversation;
      return isRecord(state) && typeof state.title === "string" && typeof state.createdAt === "string" &&
        state.kind === "chat" && (state.repoPath === undefined || typeof state.repoPath === "string") && isRecord(state.metadata);
    }
    case "conversation.updated":
      return (value.title === undefined || typeof value.title === "string") &&
        (value.repoPath === undefined || value.repoPath === null || typeof value.repoPath === "string") &&
        (value.metadata === undefined || isRecord(value.metadata)) &&
        (value.removedMetadataKeys === undefined || (Array.isArray(value.removedMetadataKeys) && value.removedMetadataKeys.every((key) => typeof key === "string")));
    case "message.created":
    case "message.updated":
      return isValidMessage(value.message);
    case "message.reactions":
      return typeof value.messageId === "string" && Array.isArray(value.added) && Array.isArray(value.removed) &&
        value.added.every((entry) => isRecord(entry) && typeof entry.emoji === "string" && isValidReactor(entry.reactor)) &&
        value.removed.every((entry) => isRecord(entry) && typeof entry.emoji === "string" && typeof entry.actorId === "string");
    case "message.removed":
      return typeof value.messageId === "string" && value.messageId.length > 0;
    default:
      return false;
  }
}

/** A chat change event a device can fold: a safe chat id and a list of
 *  changes. Individual changes are checked when applied. */
/** A payload written by a newer version waits, unapplied, until this device
 *  is updated: skipping what it does not understand would lose it for good. */
export function isSupportedChatChangesVersion(payload: Pick<ChatChangesPayload, "version">): boolean {
  return payload.version <= CHAT_CHANGES_VERSION;
}

/**
 * Applies reactions held for messages that have since arrived some other way
 * than as a change (a finished turn, a back delta). Returns whether any was.
 */
export function applyHeldReactions(conversation: Conversation): boolean {
  const pending = pendingReactions(conversation);
  const ids = Object.keys(pending);
  if (!ids.length) return false;
  const indexes = new Map(conversation.messages.map((message, index) => [message.id, index]));
  let changed = false;
  for (const id of ids) {
    const index = indexes.get(id);
    if (index === undefined) continue;
    conversation.messages[index] = applyReactions(conversation.messages[index], pending[id].added, pending[id].removed);
    delete pending[id];
    changed = true;
  }
  if (changed) setPendingReactions(conversation, pending);
  return changed;
}

export function isChatChangesPayload(value: unknown): value is ChatChangesPayload {
  if (!isRecord(value)) return false;
  return typeof value.version === "number" && value.version >= 1 && isSafeChatId(value.conversationId) &&
    typeof value.updatedAt === "string" && Array.isArray(value.changes);
}

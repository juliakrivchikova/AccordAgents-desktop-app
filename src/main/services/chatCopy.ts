import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import type { ChatMessage, Conversation } from "../../shared/types";
import {
  LOCAL_MESSAGE_METADATA_KEYS,
  SHARED_CONVERSATION_METADATA_KEYS,
  sharedConversationState,
  sharedMessage,
  type SharedConversationState
} from "./chatChanges";
import type { MachineChatCopyProvider } from "./machineInstaller";
import type { ChatCopyMark, StorageService } from "./storage";

/**
 * The first copy of every chat a machine gets, made over the SSH connection
 * that sets the machine up, not through the relay.
 *
 * The desktop reads its chat-change marks FIRST and only then exports the
 * chats: anything committed after the marks reaches the machine as ordinary
 * chat change events (it may also be in the copy; applying it twice is
 * harmless), so nothing can fall between the copy and the events.
 *
 * The copy carries chat content only: no identity keys, no delivery queues,
 * no run state, no provider sessions.
 */

export const CHAT_COPY_VERSION = 1;
export const CHAT_COPY_CONVERSATIONS_FILE = "conversations.jsonl";
export const CHAT_COPY_STATE_FILE = "state.sqlite3";
export const CHAT_COPY_MANIFEST_FILE = "manifest.json";

export interface ChatCopyManifest {
  version: typeof CHAT_COPY_VERSION;
  exportedAt: string;
  desktopOriginId: string;
  conversations: number;
  messages: number;
  bytes: number;
  marks: ChatCopyMark[];
  stateTables: string[];
}

export interface CopiedConversation {
  id: string;
  updatedAt: string;
  shared: SharedConversationState;
  messages: ChatMessage[];
  removed: string[];
}

export interface ChatCopyImportSummary {
  conversations: number;
  skippedDeleted: number;
  messages: number;
  marks: number;
}

/**
 * One chat per line. JSON already escapes every line break but two: U+2028 and
 * U+2029 are legal inside a JSON string, and a reader that treats them as line
 * ends (Node's readline does, from Node 24) would cut such a chat in half. They
 * are escaped here, and the reader splits on "\n" alone.
 */
function jsonLine(value: unknown): string {
  return JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

async function* jsonLines(file: string): AsyncGenerator<string> {
  let pending = "";
  for await (const chunk of createReadStream(file, { encoding: "utf8" })) {
    pending += chunk as string;
    let end = pending.indexOf("\n");
    while (end >= 0) {
      yield pending.slice(0, end);
      pending = pending.slice(end + 1);
      end = pending.indexOf("\n");
    }
  }
  if (pending) yield pending;
}

function removedIds(conversation: Pick<Conversation, "metadata">): string[] {
  const value = conversation.metadata?.removedChatMessageIds;
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
}

/** Desktop: writes the copy into `dir` (created empty) and returns its manifest. */
export async function exportChatCopy(
  storage: Pick<StorageService, "listConversations" | "getConversation" | "chatChangeMarks" | "exportChatCopyState">,
  dir: string,
  options: { desktopOriginId: string; now?: () => Date }
): Promise<ChatCopyManifest> {
  const now = options.now ?? (() => new Date());
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // Marks before data: see the module comment.
  const marks = await storage.chatChangeMarks(options.desktopOriginId);
  const stream = createWriteStream(path.join(dir, CHAT_COPY_CONVERSATIONS_FILE), { mode: 0o600 });
  let conversations = 0;
  let messages = 0;
  let bytes = 0;
  try {
    for (const summary of await storage.listConversations()) {
      if (summary.kind !== "chat") continue;
      const conversation = await storage.getConversation(summary.id);
      if (!conversation || conversation.kind !== "chat") continue;
      const copied: CopiedConversation = {
        id: conversation.id,
        updatedAt: conversation.updatedAt,
        shared: sharedConversationState(conversation),
        messages: conversation.messages.map((message) => sharedMessage(message, { withReactions: true })),
        removed: removedIds(conversation)
      };
      const line = `${jsonLine(copied)}\n`;
      bytes += Buffer.byteLength(line);
      if (!stream.write(line)) await once(stream, "drain");
      conversations += 1;
      messages += copied.messages.length;
    }
  } finally {
    stream.end();
    await once(stream, "close");
  }
  const state = await storage.exportChatCopyState(path.join(dir, CHAT_COPY_STATE_FILE));
  const manifest: ChatCopyManifest = {
    version: CHAT_COPY_VERSION,
    exportedAt: now().toISOString(),
    desktopOriginId: options.desktopOriginId,
    conversations,
    messages,
    bytes,
    marks,
    stateTables: state.tables
  };
  await writeFile(path.join(dir, CHAT_COPY_MANIFEST_FILE), JSON.stringify(manifest), { mode: 0o600 });
  return manifest;
}

/**
 * The desktop's half of a machine's first copy, as machine setup asks for it.
 *
 * Order matters: the machine becomes a recipient of every chat change first,
 * then saves that chose their recipients before that are waited for, and only
 * then are the marks read and the chats exported. A change committed after
 * that point reaches the machine as an event; one committed before it is in
 * the copy.
 */
export function machineChatCopyProvider(options: {
  storage: Pick<StorageService, "listConversations" | "getConversation" | "chatChangeMarks" | "exportChatCopyState">;
  desktopOriginId(): Promise<string>;
  adoptMachineIdentity(machineId: string, identity: { originId: string; publicKeyDerBase64: string }): Promise<void>;
  settleChatSaves(): Promise<void>;
  /** Other machines' changes held here beyond the marks, sent as events. */
  shareAfterCopy?(machineId: string, marks: ChatCopyMark[]): Promise<number>;
  /** The desktop's `chats` directory, whose pictures go along. */
  attachmentsDir?: string;
  tempDir: string;
}): MachineChatCopyProvider {
  return {
    export: async (machineId, identity) => {
      await options.adoptMachineIdentity(machineId, identity);
      await options.settleChatSaves();
      const dir = await mkdtemp(path.join(options.tempDir, "accordagents-chat-copy-"));
      const cleanup = (): Promise<void> => rm(dir, { recursive: true, force: true });
      try {
        const manifest = await exportChatCopy(options.storage, dir, { desktopOriginId: await options.desktopOriginId() });
        await options.shareAfterCopy?.(machineId, manifest.marks);
        return {
          dir,
          ...(options.attachmentsDir ? { attachmentsDir: options.attachmentsDir } : {}),
          summary: { conversations: manifest.conversations, messages: manifest.messages, bytes: manifest.bytes },
          cleanup
        };
      } catch (error) {
        await cleanup().catch(() => undefined);
        throw error;
      }
    }
  };
}

/** Where a project lives on this machine: its own copy when it has one, the
 *  desktop's path (the project's identity) otherwise. */
export function localizedRepository(
  local: Conversation | undefined,
  desktopRepoPath: string | undefined,
  hostMachineId: string | undefined
): { repoPath?: string; machineRepository?: { sourcePath: string; paths: Record<string, string> } } {
  if (!desktopRepoPath) return {};
  const current = local?.metadata?.machineRepository as { sourcePath?: string; paths?: Record<string, string> } | undefined;
  const paths = current?.sourcePath === desktopRepoPath && current.paths ? current.paths : {};
  return {
    repoPath: (hostMachineId && paths[hostMachineId]) || desktopRepoPath,
    machineRepository: { sourcePath: desktopRepoPath, paths }
  };
}

/**
 * One chat of the copy merged into this machine's own copy of it (if any).
 * The desktop's shared fields win; this machine keeps its own run bookkeeping,
 * its sessions, and its own members' replies.
 */
export function mergeCopiedConversation(
  local: Conversation | undefined,
  copied: CopiedConversation,
  options: { desktopOriginId: string; hostMachineId?: string }
): Conversation {
  const shared = new Set(SHARED_CONVERSATION_METADATA_KEYS);
  const metadata: Record<string, unknown> = {};
  if (local) {
    for (const [key, value] of Object.entries(local.metadata ?? {})) {
      if (!shared.has(key)) metadata[key] = value;
    }
  } else {
    metadata.participantSessions = [];
    metadata.warnings = [];
    metadata.running = false;
  }
  for (const [key, value] of Object.entries(copied.shared.metadata ?? {})) {
    if (shared.has(key)) metadata[key] = value;
  }
  const removed = new Set([...removedIds(local ?? { metadata: {} }), ...copied.removed]);
  if (removed.size) metadata.removedChatMessageIds = [...removed].slice(-100);
  else delete metadata.removedChatMessageIds;
  const homes = new Map<string, string>();
  for (const participant of Array.isArray(metadata.participants) ? metadata.participants as Array<{ id?: string; homeMachineId?: string }> : []) {
    if (participant?.id && participant.homeMachineId) homes.set(participant.id, participant.homeMachineId);
  }
  const ownedHere = (message: ChatMessage): boolean =>
    message.role === "participant" && Boolean(message.participantId) && Boolean(options.hostMachineId) &&
    homes.get(message.participantId!) === options.hostMachineId;
  const byId = new Map<string, ChatMessage>();
  const order: string[] = [];
  for (const message of local?.messages ?? []) {
    byId.set(message.id, message);
    order.push(message.id);
  }
  for (const incoming of copied.messages) {
    const current = byId.get(incoming.id);
    if (current && ownedHere(current)) continue;
    const merged: Record<string, unknown> = { ...(incoming.metadata ?? {}) };
    for (const key of LOCAL_MESSAGE_METADATA_KEYS) delete merged[key];
    const currentMetadata = (current?.metadata ?? {}) as Record<string, unknown>;
    for (const key of LOCAL_MESSAGE_METADATA_KEYS) {
      if (currentMetadata[key] !== undefined) merged[key] = currentMetadata[key];
    }
    if (!ownedHere(incoming)) merged.remoteAuthorOriginId = currentMetadata.remoteAuthorOriginId ?? options.desktopOriginId;
    else delete merged.remoteAuthorOriginId;
    byId.set(incoming.id, { ...incoming, metadata: merged as ChatMessage["metadata"] });
    if (!current) order.push(incoming.id);
  }
  const messages = order
    .filter((id) => !removed.has(id))
    .map((id, index) => ({ message: byId.get(id)!, index }))
    .sort((left, right) => left.message.createdAt.localeCompare(right.message.createdAt) || left.index - right.index)
    .map((entry) => entry.message);
  const repository = localizedRepository(local, copied.shared.repoPath, options.hostMachineId);
  if (repository.machineRepository) metadata.machineRepository = repository.machineRepository;
  else delete metadata.machineRepository;
  const updatedAt = local && local.updatedAt > copied.updatedAt ? local.updatedAt : copied.updatedAt;
  return {
    id: copied.id,
    title: copied.shared.title,
    kind: copied.shared.kind,
    createdAt: local?.createdAt ?? copied.shared.createdAt,
    updatedAt,
    ...(repository.repoPath ? { repoPath: repository.repoPath } : {}),
    messages,
    findings: local?.findings ?? [],
    metadata: metadata as Conversation["metadata"]
  };
}

/** Machine: imports a copy made by `exportChatCopy`. Running it again with the
 *  same copy changes nothing. Saves here are plain writes: nothing is emitted. */
export async function importChatCopy(
  storage: Pick<StorageService, "getConversation" | "saveConversation" | "importChatCopyState" | "applyChatCopyMarks" | "conversationTombstones">,
  dir: string,
  options: { hostMachineId?: string; localOriginId?: string; now?: () => Date }
): Promise<ChatCopyImportSummary> {
  const now = options.now ?? (() => new Date());
  const manifest = JSON.parse(await readFile(path.join(dir, CHAT_COPY_MANIFEST_FILE), "utf8")) as ChatCopyManifest;
  if (manifest.version !== CHAT_COPY_VERSION || typeof manifest.desktopOriginId !== "string" || !Array.isArray(manifest.marks)) {
    throw new Error("This chat copy was made by a different version of the app.");
  }
  // Deletions and artifacts first: a chat deleted on the desktop must not be
  // written here, and the tombstone is what says so.
  await storage.importChatCopyState(path.join(dir, CHAT_COPY_STATE_FILE));
  const tombstones = storage.conversationTombstones();
  const summary: ChatCopyImportSummary = { conversations: 0, skippedDeleted: 0, messages: 0, marks: 0 };
  for await (const line of jsonLines(path.join(dir, CHAT_COPY_CONVERSATIONS_FILE))) {
    if (!line.trim()) continue;
    const copied = JSON.parse(line) as CopiedConversation;
    if (await tombstones.isDeleted(copied.id)) {
      summary.skippedDeleted += 1;
      continue;
    }
    const local = await storage.getConversation(copied.id);
    const merged = mergeCopiedConversation(local && local.kind === "chat" ? local : undefined, copied, {
      desktopOriginId: manifest.desktopOriginId,
      hostMachineId: options.hostMachineId
    });
    await storage.saveConversation(merged);
    summary.conversations += 1;
    summary.messages += merged.messages.length;
  }
  await storage.applyChatCopyMarks(manifest.marks, now().toISOString(), options.localOriginId);
  summary.marks = manifest.marks.length;
  return summary;
}

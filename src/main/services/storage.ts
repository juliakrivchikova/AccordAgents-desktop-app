import path from "node:path";
import { userDataPath } from "../platform";
import type {
  ChatForkSeenReply, ChatMessage, ChatParticipantRequestBatch, ChatRunningMessageTarget, Conversation, ConversationMessagePage,
  ConversationMessagePageRequest, ConversationOpenResult, ConversationSummary
} from "../../shared/types";
import type { ChatSearchDocument } from "../../shared/chatSearchDocuments";
import { DeviceEventBlobStorage } from "./deviceEventBlobStorage";
import { HubStorage } from "./hubStorage";
import { HubOpsStore } from "./hubOpsStore";
import { HubClientOpsStore } from "./hubOpsClient";
import { NativeCommandStore } from "./nativeCommandStore";
import { MachinePowerStore } from "./machinePowerStore";
import type {
  ChatSearchConversationRead, ChatSearchConversationSnapshot, ChatSearchDocumentReplacement, ChatSearchIndexState,
  StoredChatSearchQueryResult
} from "./storage/search/types";
import type { ChatMemberProviderRow, DeviceIdentityRecord, SavedMessageRow, StorageServiceOptions } from "./storage/types";
import { createStorageModules, type StorageModules } from "./storage/modules";

export { SUPPORTED_STORAGE_SCHEMA_VERSION, PREVIOUS_STORAGE_SCHEMA_VERSION, STORAGE_SCHEMA_VERSION_META_KEY, UnsupportedStorageSchemaVersionError } from "./storage/database/schemaVersion";
export type { DeviceIdentityRecord, SavedMessageRow, StorageServiceOptions, ChatMemberProviderRow } from "./storage/types";
export { InvalidChatSearchSourceError, type ChatSearchConversationSnapshot, type ChatSearchConversationRead, type ChatSearchDocumentReplacement, type ChatSearchIndexState, type StoredChatSearchTitleMatch, type StoredChatSearchMessageMatch, type StoredChatSearchQueryResult } from "./storage/search/types";

/** The app's database. The work is done by the parts in ./storage. */
export class StorageService {
  private readonly modules: StorageModules;

  constructor(options: StorageServiceOptions = {}) {
    this.modules = createStorageModules({
      dbPath: options.dbPath ?? path.join(userDataPath(), "accordagents.sqlite3"),
      sqliteExecutable: options.sqliteExecutable ?? "sqlite3"
    });
  }

  init(): Promise<void> {
    return this.modules.schema.init();
  }

  // Cross-instance run cancellation. Multiple app instances can share this
  // database (a second dev/QA instance opens the same userData); a Stop click
  // in a non-owner instance cannot abort the owner's in-memory controllers, so
  // it records a request row here and the owning instance consumes it on its
  // run-owner heartbeat.
  requestRunCancel(conversationId: string, runId: string): Promise<void> {
    return this.modules.runCancels.requestRunCancel(conversationId, runId);
  }

  takeRunCancelRequests(runIds: string[]): Promise<string[]> {
    return this.modules.runCancels.takeRunCancelRequests(runIds);
  }

  /** A chat's kind, project folder and members, without its messages or
   *  the rest of its body (members' memory asks this on every request); its
   *  main session and view, for how the server words what it sends outside
   *  (an urgent alert names nobody by handle in the sessions view). */
  conversationAccess(id: string): Promise<{ kind: string; repoPath?: string; participants: unknown[]; mainSessionParticipantId?: string; chatView?: string } | undefined> {
    return this.modules.conversationReads.conversationAccess(id);
  }

  /** The chat's newest messages that give a member a task (a request item
   *  naming it as its target; not the requests it sent itself), read without
   *  the rest of the chat: how the sessions view titles that member
   *  (sessionsMemberTitle, titleTaskByMember). When none of them titles it,
   *  the newest delegation that names it is read as well, so a member with
   *  many follow-ups keeps the title its delegation gave it. */
  memberTaskMessages(conversationId: string, participantId: string, limit = 5): Promise<ChatMessage[]> {
    return this.modules.chatActivity.memberTaskMessages(conversationId, participantId, limit);
  }

  /** A chat's member requests, oldest first, each only its batch (not the
   *  rest of its message): the whole history's tasks, read once to give the
   *  members made before titles were kept with them theirs. */
  chatRequestBatches(conversationId: string): Promise<ChatParticipantRequestBatch[]> {
    return this.modules.conversationReads.chatRequestBatches(conversationId);
  }

  /** A chat's member session records (this device's own), without its
   *  messages: a main session made by Fork to new chat reads the session of
   *  the member it copies from that member's chat, which can be thousands of
   *  messages long. `undefined` when no such chat is stored. */
  conversationParticipantSessions(id: string): Promise<unknown[] | undefined> {
    return this.modules.conversationReads.conversationParticipantSessions(id);
  }

  /** The titles of the chats named (those this device still has). */
  conversationTitles(ids: readonly string[]): Promise<Record<string, string>> {
    return this.modules.conversationReads.conversationTitles(ids);
  }

  listConversations(): Promise<ConversationSummary[]> {
    return this.modules.conversationLists.listConversations();
  }

  /** Each chat's members, as the runtime fields that say which provider they
   *  run on (the CLI and any added provider) and their role (to tell the
   *  Assistant apart), for the usage signals. One
   *  query over the chats' own rows, the same body the chat list reads, that
   *  returns only those fields; no message is read, and a chat whose
   *  row cannot be read is left out rather than failing the rest. */
  listChatMemberProviders(): Promise<Array<Array<ChatMemberProviderRow>>> {
    return this.modules.conversationLists.listChatMemberProviders();
  }

  listChatCliSessions(): Promise<Array<{ conversationId: string; sessionId: string }>> {
    return this.modules.conversationLists.listChatCliSessions();
  }

  /** The chats with a User message written since `since` (the weekly usage
   *  snapshot), each with what decides the view it is shown in
   *  (shared/mainSession.ts chatViewFor): its main session, whether that is
   *  still a member, and its view. One query over the chat rows; a message's
   *  body is looked at only for rows written since then. */
  listChatViewsWithUserMessagesSince(since: string): Promise<Array<{ mainSessionParticipantId?: string; chatView?: string }>> {
    return this.modules.conversationLists.listChatViewsWithUserMessagesSince(since);
  }

  /** The messages whose choice still waits for the User, in the given chats:
   *  what the phone's chat list carries so a phone can drop a card the
   *  desktop no longer waits on. One query over the listed chats' rows (their
   *  payloads are scanned; a chat's history is never read through the CLI).
   *  Past the cap the set is incomplete and says so, because the phone treats
   *  what it is given as the whole. */
  listPendingChoiceMessages(conversationIds: string[]): Promise<{
    rows: Array<{ conversationId: string; message: ChatMessage }>;
    truncated: boolean;
  }> {
    return this.modules.chatActivity.listPendingChoiceMessages(conversationIds);
  }

  getConversation(id: string): Promise<Conversation | undefined> {
    return this.modules.conversationReads.getConversation(id);
  }

  /** A chat's project folder, without reading a conversation that can be
   *  thousands of messages long. `undefined` when the chat is not stored. */
  conversationRepoPath(id: string): Promise<{ repoPath?: string } | undefined> {
    return this.modules.conversationReads.conversationRepoPath(id);
  }

  chatProjectPaths(): Promise<string[]> {
    return this.modules.conversationReads.chatProjectPaths();
  }

  /** Whether a chat is stored here (and holds one message), without reading
   *  a conversation that can be thousands of messages long. */
  conversationPresence(id: string, messageId?: string): Promise<{ kind: Conversation["kind"]; hasMessage: boolean } | undefined> {
    return this.modules.conversationReads.conversationPresence(id, messageId);
  }

  openConversation(
    id: string,
    limit?: number,
    page?: { beforeMessageId?: string }
  ): Promise<ConversationOpenResult | undefined> {
    return this.modules.conversationReads.openConversation(id, limit, page);
  }

  listConversationMessages(request: ConversationMessagePageRequest): Promise<ConversationMessagePage> {
    return this.modules.conversationReads.listConversationMessages(request);
  }

  /** Whether a member has a finished reply in a chat (the rule of
   *  isFinishedMemberReply): it ran there, so its device holds a session to
   *  fork (Fork to new chat from the phone). Read newest first, stopping at
   *  the first; a member that never answered reads the chat's messages once
   *  (when the phone's menu opens, never per list). */
  conversationParticipantAnswered(conversationId: string, participantId: string): Promise<boolean> {
    return this.modules.conversationReads.conversationParticipantAnswered(conversationId, participantId);
  }

  /** The member's newest reply that ended a turn of its CLI (the rule of
   *  isMemberTurnEnd), as Fork to new chat keeps it (forkSeenReplyOf): where
   *  the copy ends. Read newest first, stopping at the first, and only the
   *  fields the cut needs (a reply can carry a long transcript). */
  conversationLastTurnEnd(conversationId: string, participantId: string): Promise<ChatForkSeenReply | undefined> {
    return this.modules.conversationReads.conversationLastTurnEnd(conversationId, participantId);
  }

  /** One message of a chat by its id: a single read through the chat's
   *  message-id index, for readers that need nothing around it. */
  conversationMessageById(conversationId: string, messageId: string): Promise<ChatMessage | undefined> {
    return this.modules.conversationReads.conversationMessageById(conversationId, messageId);
  }

  /** The member messages still in progress that answer these turns (the
   *  member and the message each turn answers), wherever they are in the
   *  chat. Read from the earliest of those messages on, not the whole chat;
   *  few and small (a turn's message holds only its placeholder until it
   *  ends). A dead message of another turn is never one of them. */
  listPendingTurnMessages(
    conversationId: string,
    turns: Array<{ messageId: string; participantId: string }>
  ): Promise<ChatMessage[]> {
    return this.modules.chatActivity.listPendingTurnMessages(conversationId, turns);
  }

  /** The member's turn in progress (see runningMessageForParticipant), found
   *  in the whole chat: an open chat holds only its latest page, and a long
   *  turn's message can be far above it. Reads only the chat's run state and,
   *  of its pending member messages, the run fields plus the first characters
   *  of their text (to recognise a hidden "waiting for approval" status), so
   *  the answer stays a handful of short rows on any chat. */
  findRunningParticipantMessage(conversationId: string, participantId: string): Promise<ChatRunningMessageTarget | undefined> {
    return this.modules.chatActivity.findRunningParticipantMessage(conversationId, participantId);
  }

  listChatSearchConversationSnapshots(options: { includeParticipants?: boolean } = {}): Promise<ChatSearchConversationSnapshot[]> {
    return this.modules.chatSearchIndex.listChatSearchConversationSnapshots(options);
  }

  readChatSearchConversation(conversationId: string): Promise<Conversation | undefined> {
    return this.modules.chatSearchIndex.readChatSearchConversation(conversationId);
  }

  readChatSearchConversations(conversationIds: string[]): Promise<ChatSearchConversationRead[]> {
    return this.modules.chatSearchIndex.readChatSearchConversations(conversationIds);
  }

  ensureChatSearchIndex(): Promise<void> {
    return this.modules.chatSearchIndex.ensureChatSearchIndex();
  }

  rebuildChatSearchIndex(): Promise<void> {
    return this.modules.chatSearchIndex.rebuildChatSearchIndex();
  }

  listChatSearchIndexStates(conversationIds?: string[]): Promise<ChatSearchIndexState[]> {
    return this.modules.chatSearchIndex.listChatSearchIndexStates(conversationIds);
  }

  replaceChatSearchDocuments(
    snapshot: ChatSearchConversationSnapshot,
    documents: ChatSearchDocument[],
    indexedAt: string
  ): Promise<void> {
    return this.modules.chatSearchIndex.replaceChatSearchDocuments(snapshot, documents, indexedAt);
  }

  replaceChatSearchDocumentsBatch(replacements: ChatSearchDocumentReplacement[]): Promise<void> {
    return this.modules.chatSearchIndex.replaceChatSearchDocumentsBatch(replacements);
  }

  deleteChatSearchDocuments(conversationIds: string[]): Promise<void> {
    return this.modules.chatSearchIndex.deleteChatSearchDocuments(conversationIds);
  }

  queryChatSearchIndex(request: {
    conversationIds: string[];
    matchQuery: string;
    startMarker: string;
    endMarker: string;
    limit: number;
    offset?: number;
  }): Promise<StoredChatSearchQueryResult> {
    return this.modules.chatSearchIndex.queryChatSearchIndex(request);
  }

  // A save used to delete every message row of a conversation and insert them
  // all back. On a 2400-message chat that is ~33MB of SQL text piped into a
  // spawned sqlite3 process, several times per turn, so the cost of saying
  // anything grew with the length of the chat. Only the rows that actually
  // changed are written now; the full rewrite remains as the fallback whenever
  // this process cannot prove what the database currently holds.
  /** Saves the conversation and returns the token stamped on its row. A caller
   *  that already serialized and hashed the messages for this exact snapshot
   *  passes them as `rows`; they are used only when they line up with the
   *  messages one to one, otherwise the messages are serialized here. */
  saveConversation(conversation: Conversation, options: {
    rows?: SavedMessageRow[];
    /** Statements that must commit in the same transaction as this save, or
     *  not at all: the chat's outgoing change event. `onlyIfSql` receives the
     *  condition the incremental write is gated on. */
    alsoCommit?: { sql: string; onlyIfSql(condition: string): string };
  } = {}): Promise<string> {
    return this.modules.conversationSaves.saveConversation(conversation, options);
  }

  /** True while the conversation row still carries `token`, the value a
   *  particular `saveConversation` call returned. Every save — from any
   *  instance or any caller in this process — stamps a new token, so a match
   *  proves nothing has written the conversation since that save and storage
   *  holds exactly the snapshot it persisted. */
  isConversationSaveOwned(conversationId: string, token: string): Promise<boolean> {
    return this.modules.conversationSaves.isConversationSaveOwned(conversationId, token);
  }

  /**
   * Chats this device has been told are gone.
   *
   * A replicated copy cannot tell a new conversation from a stale snapshot of
   * a deleted one; both are just rows arriving. The tombstone is what makes
   * the difference, and it has to outlive the rows and the process.
   */
  conversationTombstones(): {
    mark(conversationId: string, deletedAt: string): Promise<void>;
    isDeleted(conversationId: string): Promise<boolean>;
    deletedAt(conversationId: string): Promise<string | undefined>;
    pendingCopies(): Promise<Array<{ conversationId: string; deletedAt: string }>>;
  } {
    return this.modules.conversationSaves.conversationTombstones();
  }

  nativeCommands(): NativeCommandStore {
    return this.modules.relatedStores.nativeCommands();
  }

  machinePower(): MachinePowerStore {
    return this.modules.relatedStores.machinePower();
  }

  /** The hub's tables: on the hub, its roster, phone pairing, notices and
   *  push subscriptions; on a device that uses one, where it stands with it. */
  hub(): HubStorage {
    return this.modules.relatedStores.hub();
  }

  /** This device's operations for the User's server, and its failed sends. */
  hubClientOps(): HubClientOpsStore {
    return this.modules.relatedStores.hubClientOps();
  }

  /** This database through its own session, for a store whose tables live
   *  here too (the server's documents), so its changes and the server's
   *  order can commit together. */
  sqlExecutor(): { path: string; queryJson<T>(sql: string): Promise<T[]>; queryText(sql: string): Promise<string>; runSql(sql: string): Promise<void> } {
    return this.modules.sqlite.sqlExecutor();
  }

  /** The server's accepted operations and turns (the User's server only). */
  hubOps(): HubOpsStore {
    return this.modules.relatedStores.hubOps();
  }

  /** The User's server's bodies (pictures, avatars); no other device keeps any. */
  deviceEventBlobs(): DeviceEventBlobStorage {
    return this.modules.relatedStores.deviceEventBlobs();
  }

  getDeviceIdentityRecord(): Promise<DeviceIdentityRecord | undefined> {
    return this.modules.deviceIdentity.getDeviceIdentityRecord();
  }

  saveDeviceIdentityRecord(record: DeviceIdentityRecord): Promise<void> {
    return this.modules.deviceIdentity.saveDeviceIdentityRecord(record);
  }

  /** Puts this database back into the shape an older build can open: the full
   *  conversation copy is rebuilt from the body and the message rows, and the
   *  schema version is lowered again. Nothing is deleted — the body and the
   *  message rows stay exactly as they are, so running the current build again
   *  afterwards simply raises the version back. This is the supported way to go
   *  back to a previous version of the app; without it, raising the schema
   *  version would be a one-way door. */
  prepareStorageForOlderVersion(): Promise<{ conversations: number; schemaVersion: number }> {
    return this.modules.backups.prepareStorageForOlderVersion();
  }

  createPreMigrationBackup(label: string): Promise<string> {
    return this.modules.backups.createPreMigrationBackup(label);
  }

  deleteConversation(id: string, options: { alsoCommitSql?: string } = {}): Promise<boolean> {
    return this.modules.conversationSaves.deleteConversation(id, options);
  }

  /**
   * Drops, once, what devices and the server kept for the order of signed
   * events they used before the User's server owned the chats (agreement
   * Д7): nothing reads any of it any more. A large table (the computer's
   * event log is about 1.6 GB on the User's machine) is emptied a bounded
   * batch at a time, each its own short transaction, so chats keep saving
   * while it goes; the freed space stays in the file (no VACUUM: on a 4 GB
   * database it would hold everything for minutes). `keepBodies` keeps the
   * pictures and avatars the server holds. Stops early when `signal` aborts
   * and carries on at the next call; a database without these tables is
   * left alone at once.
   */
  dropLegacyEventTables(options: {
    keepBodies: boolean;
    signal?: AbortSignal;
    log?: (event: string, payload: Record<string, unknown>) => void;
    batchRows?: number;
    pauseMs?: number;
  }): Promise<{ tables: string[]; rows: number; done: boolean }> {
    return this.modules.startupRepairs.dropLegacyEventTables(options);
  }

  /** Chats holding an approved roster change that had not been applied yet
   *  (ChatAppToolApproval.memberRemovalQueuedAt or memberAdditionQueuedAt);
   *  read once at startup. */
  conversationIdsWithQueuedRosterChanges(): Promise<string[]> {
    return this.modules.conversationLists.conversationIdsWithQueuedRosterChanges();
  }

  /** Chats that may hold a card a member waits on: an approval waiting (or
   *  an approved roster change not made yet), a member's choice waiting, its
   *  mentions waiting for approval, or another device's card answered and
   *  shown here as waiting. Read at a start and a reconnect, so the cards on
   *  the User's server match them (ChatService.resumeServerCards). Without
   *  `messages` only the chats' bodies are read (a reconnect): every message
   *  row is read only at a start. */
  conversationIdsWithOpenCards(options: { messages?: boolean } = {}): Promise<string[]> {
    return this.modules.conversationLists.conversationIdsWithOpenCards(options);
  }

  /** The chats holding a member's choice that still waits for the User
   *  (ChatService.resumeChoiceExpiry). */
  conversationIdsWithPendingChoices(): Promise<string[]> {
    return this.modules.conversationLists.conversationIdsWithPendingChoices();
  }
}

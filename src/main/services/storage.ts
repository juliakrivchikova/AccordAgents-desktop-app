import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import { runCommand } from "./command";
import type {
  ChatEventAppendResult,
  ChatEventEnvelope,
  ChatEventProjectionRow
} from "../../shared/chatEvents";
import type {
  ChatMessage,
  Conversation,
  ConversationMessagePage,
  ConversationMessagePageInfo,
  ConversationMessagePageRequest,
  ConversationOpenResult,
  ConversationSummary,
  ListChatActivityRequest,
  ListChatActivityResult
} from "../../shared/types";
import {
  DEFAULT_CHAT_ACTIVITY_LIMIT,
  DEFAULT_CHAT_ACTIVITY_RECENT_CONVERSATION_LIMIT,
  DEFAULT_CHAT_ACTIVITY_RECENT_WINDOW_DAYS,
  buildChatActivityItems,
  limitChatActivityItems,
  sortChatActivityItems
} from "../../shared/chatActivity";
import { clearChatRunMetadata, clearParticipantCompactions, readParticipantCompactions } from "../../shared/chatRunState";
import { normalizeInferredParticipantRequestThreads as normalizeInferredParticipantRequestThreadMetadata } from "../../shared/chatParticipantRequestThreads";
import { normalizeConversationSummaryChatParticipants } from "../../shared/conversationSummary";
import { sanitizeConversationWarnings } from "../../shared/warnings";

const DEFAULT_MESSAGE_PAGE_LIMIT = 80;
const MAX_MESSAGE_PAGE_LIMIT = 200;
const SQLITE_BUSY_TIMEOUT_MS = 30_000;
const SQLITE_COMMAND_TIMEOUT_MS = 45_000;
const SQLITE_MIGRATION_TIMEOUT_MS = 120_000;
const SCHEMA_META_COMPLETE = "complete";
export const SUPPORTED_STORAGE_SCHEMA_VERSION = 1;
export const STORAGE_SCHEMA_VERSION_META_KEY = "storage-schema-version";
export const CHAT_EVENT_PROJECTION_VERSION = 1;
const CHAT_EVENT_DEVICE_IDENTITY_META_KEY = "chat-event-device-identity-v1";
const INFERRED_REQUEST_THREAD_MIGRATION_KEY = "inferred-participant-request-threads-v1";
const RUN_CANCEL_REQUEST_MAX_AGE_MS = 60 * 60_000;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function sqlString(value: string | undefined | null): string {
  if (value === undefined || value === null) {
    return "NULL";
  }
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlStringList(values: string[]): string {
  return values.length > 0 ? `(${values.map((value) => sqlString(value)).join(", ")})` : "('')";
}

function sqlStringPairList(values: Array<[string, string]>): string {
  return values.length > 0
    ? `(${values.map(([left, right]) => `(${sqlString(left)}, ${sqlString(right)})`).join(", ")})`
    : "(('', ''))";
}

function parseHexJson<T>(value: unknown, context: string): T {
  if (typeof value !== "string" || value.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(value)) {
    throw new Error(`Invalid hexadecimal JSON returned for ${context}.`);
  }
  let json: string;
  try {
    json = UTF8_DECODER.decode(Buffer.from(value, "hex"));
  } catch {
    throw new Error(`Invalid UTF-8 JSON returned for ${context}.`);
  }
  try {
    return JSON.parse(json) as T;
  } catch {
    throw new Error(`Invalid JSON returned for ${context}.`);
  }
}

function parseHexText(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(value)) {
    throw new Error(`Invalid hexadecimal text returned for ${context}.`);
  }
  try {
    return UTF8_DECODER.decode(Buffer.from(value, "hex"));
  } catch {
    throw new Error(`Invalid UTF-8 text returned for ${context}.`);
  }
}

function parseStorageSchemaVersion(value: string | undefined): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (!/^\d+$/.test(trimmed)) {
    throw new Error("This chat database has an invalid storage schema version. Restore a backup or update AccordAgents.");
  }
  return Number.parseInt(trimmed, 10);
}

export class UnsupportedStorageSchemaVersionError extends Error {
  constructor(storedVersion: number, supportedVersion: number) {
    super(
      `This chat database was written by a newer version of AccordAgents. Update to open it. ` +
        `Database schema ${storedVersion}, supported schema ${supportedVersion}.`
    );
    this.name = "UnsupportedStorageSchemaVersionError";
  }
}

export interface ChatEventDeviceIdentityRecord {
  originId: string;
  keyId: string;
  publicKeyDerBase64: string;
  privateKeyDerBase64: string;
  createdAt: string;
}

export interface ChatEventSequenceBasis {
  originSeq: number;
  prevHash?: string;
}

/** One message as it is about to be written, with the hash used to decide
 *  whether its row needs writing at all. */
interface SavedMessageRow {
  index: number;
  id: string;
  createdAt: string;
  json: string;
  hash: string;
}

/** What this process last committed for a conversation: the token it stamped on
 *  the row, and the message ids and hashes in the order it wrote them. */
interface SavedMessageState {
  token: string;
  rows: Array<{ id: string; hash: string }>;
}

function clearLegacyAccordState(metadata: Conversation["metadata"]): Conversation["metadata"] {
  const policies = Array.isArray(metadata.appToolApprovalPolicies)
    ? metadata.appToolApprovalPolicies.filter((policy) =>
        Boolean(
          policy &&
          typeof policy === "object" &&
          !Array.isArray(policy) &&
          (policy as { capability?: unknown }).capability !== "participants.request" &&
          (policy as { accordLaunchId?: unknown }).accordLaunchId === undefined &&
          (policy as { expiresAt?: unknown }).expiresAt === undefined
        )
      )
    : undefined;
  const next = { ...metadata };
  delete next.accordLaunch;
  delete next.accordRun;
  if (policies) {
    next.appToolApprovalPolicies = policies;
  }
  return next;
}

function hasPendingAppToolApprovals(conversation: Conversation): boolean {
  return Array.isArray(conversation.metadata.pendingAppToolApprovals) &&
    conversation.metadata.pendingAppToolApprovals.some((approval) =>
      approval &&
      typeof approval === "object" &&
      (approval as { status?: unknown }).status === "pending"
    );
}

function pendingApprovalTriggerTargets(conversation: Conversation): Array<[string, string]> {
  if (!Array.isArray(conversation.metadata.pendingAppToolApprovals)) {
    return [];
  }
  return conversation.metadata.pendingAppToolApprovals.flatMap((approval) => {
    const messageId = approval?.status === "pending" ? approval.resumeContext?.triggerMessageId?.trim() : "";
    return messageId ? [[conversation.id, messageId] as [string, string]] : [];
  });
}

function nonTerminalRemoteRunIds(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([runId, raw]) => {
    if (!runId || !raw || typeof raw !== "object" || Array.isArray(raw)) {
      return [];
    }
    const record = raw as Record<string, unknown>;
    const status = record.status;
    const worker = record.worker;
    const host = worker && typeof worker === "object" && !Array.isArray(worker)
      ? (worker as Record<string, unknown>).host
      : undefined;
    if (typeof host !== "string" || !host.trim()) {
      return [];
    }
    return status === "completed" || status === "failed" || status === "cancelled" ? [] : [runId];
  });
}

function withRemoteRunMetadata(metadata: Record<string, unknown>, runIds: string[]): Record<string, unknown> {
  if (runIds.length === 0) {
    return metadata;
  }
  const preferred = typeof metadata.runId === "string" && runIds.includes(metadata.runId)
    ? metadata.runId
    : runIds[0];
  return {
    ...metadata,
    running: true,
    runId: preferred,
    activeRunIds: runIds
  };
}

export interface StorageServiceOptions {
  dbPath?: string;
  sqliteExecutable?: string;
}

export class StorageService {
  private savedMessageStateCache: Map<string, SavedMessageState> | undefined;
  private readonly dbPath: string;
  private readonly sqliteExecutable: string;
  private initialized = false;

  constructor(options: StorageServiceOptions = {}) {
    this.dbPath = options.dbPath ?? path.join(app.getPath("userData"), "accordagents.sqlite3");
    this.sqliteExecutable = options.sqliteExecutable ?? "sqlite3";
  }

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await mkdir(path.dirname(this.dbPath), { recursive: true });
    await this.ensureSchemaMetaTable();
    await this.assertSupportedSchemaVersion();
    await this.configureSqliteRuntime();
    await this.runSql(`
      create table if not exists conversations (
        id text primary key,
        title text not null,
        kind text not null,
        created_at text not null,
        updated_at text not null,
        repo_path text,
        body_json text,
        payload_json text not null
      );
      create index if not exists idx_conversations_updated_at on conversations(updated_at);
      create table if not exists schema_meta (
        key text primary key,
        value text not null
      );
      create table if not exists conversation_messages (
        conversation_id text not null,
        sequence integer not null,
        message_id text not null,
        created_at text not null,
        payload_json text not null,
        primary key (conversation_id, sequence),
        unique (conversation_id, message_id)
      );
      create index if not exists idx_conversation_messages_conversation_sequence on conversation_messages(conversation_id, sequence);
      create table if not exists run_cancel_requests (
        run_id text primary key,
        conversation_id text not null,
        requested_at text not null
      );
      create table if not exists chat_events (
        event_id text primary key,
        conversation_id text not null,
        log_scope_id text not null,
        origin_id text not null,
        origin_seq integer not null,
        logical_ts text not null,
        kind text not null,
        payload_json text not null,
        payload_hash text not null,
        event_hash text not null,
        prev_hash text,
        signature text,
        key_id text,
        envelope_json text not null,
        received_at text not null,
        unique(origin_id, log_scope_id, origin_seq)
      );
      create index if not exists idx_chat_events_conversation_scope_origin
        on chat_events(conversation_id, log_scope_id, origin_id, origin_seq);
      create index if not exists idx_chat_events_received_at on chat_events(received_at);
      create table if not exists chat_event_projections (
        conversation_id text not null,
        projection_key text not null,
        version integer not null,
        last_event_id text,
        payload_json text not null,
        updated_at text not null,
        primary key (conversation_id, projection_key)
      );
    `);
    await this.pruneStaleRunCancelRequests();
    await this.ensureColumn("conversations", "body_json", "text");
    await this.ensureColumn("conversations", "save_token", "text");
    await this.backfillConversationBodiesAndMessages();
    await this.setSchemaMeta(STORAGE_SCHEMA_VERSION_META_KEY, String(SUPPORTED_STORAGE_SCHEMA_VERSION));
    this.initialized = true;
    await this.normalizeInferredParticipantRequestThreads();
    await this.clearInterruptedRuns();
  }

  // Cross-instance run cancellation. Multiple app instances can share this
  // database (a second dev/QA instance opens the same userData); a Stop click
  // in a non-owner instance cannot abort the owner's in-memory controllers, so
  // it records a request row here and the owning instance consumes it on its
  // run-owner heartbeat.
  async requestRunCancel(conversationId: string, runId: string): Promise<void> {
    await this.init();
    const normalizedRunId = runId.trim();
    if (!normalizedRunId) {
      return;
    }
    await this.runSql(`
      insert into run_cancel_requests (run_id, conversation_id, requested_at)
      values (${sqlString(normalizedRunId)}, ${sqlString(conversationId)}, ${sqlString(new Date().toISOString())})
      on conflict(run_id) do update set requested_at = excluded.requested_at;
    `);
  }

  async takeRunCancelRequests(runIds: string[]): Promise<string[]> {
    await this.init();
    const normalized = Array.from(new Set(runIds.map((runId) => runId.trim()).filter(Boolean)));
    if (normalized.length === 0) {
      return [];
    }
    const rows = await this.queryJson<{ runId: string }>(
      `select run_id as runId from run_cancel_requests where run_id in ${sqlStringList(normalized)};`
    );
    const matched = rows.map((row) => row.runId);
    if (matched.length > 0) {
      await this.runSql(`delete from run_cancel_requests where run_id in ${sqlStringList(matched)};`);
    }
    return matched;
  }

  private async pruneStaleRunCancelRequests(): Promise<void> {
    const cutoff = new Date(Date.now() - RUN_CANCEL_REQUEST_MAX_AGE_MS).toISOString();
    await this.runSql(`delete from run_cancel_requests where requested_at < ${sqlString(cutoff)};`);
  }

  async listConversations(): Promise<ConversationSummary[]> {
    await this.init();
    const rows = await this.queryJson<{
      id: string;
      title: string;
      kind: ConversationSummary["kind"];
      createdAt: string;
      updatedAt: string;
      repoPath?: string;
      running?: number | string | boolean | null;
      archived?: number | string | boolean | null;
      activeRunIdsCount?: number | string | null;
      chatParticipantsJson?: string | null;
    }>(
      `select
         id,
         title,
         kind,
         created_at as createdAt,
         updated_at as updatedAt,
         repo_path as repoPath,
         json_extract(coalesce(nullif(body_json, ''), payload_json), '$.metadata.running') as running,
         json_extract(coalesce(nullif(body_json, ''), payload_json), '$.metadata.archived') as archived,
         coalesce(json_array_length(coalesce(nullif(body_json, ''), payload_json), '$.metadata.activeRunIds'), 0) as activeRunIdsCount,
         json_extract(coalesce(nullif(body_json, ''), payload_json), '$.metadata.participants') as chatParticipantsJson
       from conversations
       order by updated_at desc;`
    );
    return rows.map((row) => {
      const activeCount = typeof row.activeRunIdsCount === "string"
        ? Number.parseInt(row.activeRunIdsCount, 10) || 0
        : (row.activeRunIdsCount ?? 0);
      const runningFlag = row.running === 1 || row.running === "1" || row.running === true || row.running === "true";
      const isRunning = activeCount > 0 || runningFlag;
      const isArchived = row.archived === 1 || row.archived === "1" || row.archived === true || row.archived === "true";
      const chatParticipants = row.kind === "chat"
        ? normalizeConversationSummaryChatParticipants(row.chatParticipantsJson)
        : undefined;
      return {
        id: row.id,
        title: row.title,
        kind: row.kind,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        repoPath: row.repoPath ?? undefined,
        running: isRunning,
        archived: isArchived,
        ...(chatParticipants ? { chatParticipants } : {})
      };
    });
  }

  async listChatActivity(request: ListChatActivityRequest = {}): Promise<ListChatActivityResult> {
    await this.init();
    const limit = normalizePositiveInteger(request.limit, DEFAULT_CHAT_ACTIVITY_LIMIT);
    const conversationLimit = normalizePositiveInteger(
      request.recentConversationLimit,
      DEFAULT_CHAT_ACTIVITY_RECENT_CONVERSATION_LIMIT
    );
    const recentWindowDays = normalizePositiveInteger(
      request.recentWindowDays,
      DEFAULT_CHAT_ACTIVITY_RECENT_WINDOW_DAYS
    );
    const rows = await this.queryJson<{
      id: string;
      bodyHex: string;
    }>(
      `select
         id,
         hex(coalesce(nullif(body_json, ''), json_set(payload_json, '$.messages', json_array()))) as bodyHex
       from conversations
       where kind = 'chat'
         and coalesce(json_extract(coalesce(nullif(body_json, ''), payload_json), '$.metadata.archived'), 0) not in (1, '1', 'true')
       order by updated_at desc
       limit ${conversationLimit};`
    );
    if (rows.length === 0) {
      return { items: [], generatedAt: new Date().toISOString() };
    }

    const conversationsById = new Map<string, Conversation>();
    for (const row of rows) {
      let conversation: Conversation;
      try {
        conversation = parseHexJson<Conversation>(row.bodyHex, `conversation ${row.id}`);
      } catch (error) {
        console.warn(
          `[StorageService] Skipping invalid chat activity conversation ${row.id}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        continue;
      }
      conversation.metadata = clearLegacyAccordState(conversation.metadata);
      conversation.messages = [];
      sanitizeConversationWarnings(conversation);
      conversationsById.set(conversation.id, conversation);
    }
    if (conversationsById.size === 0) {
      return { items: [], generatedAt: new Date().toISOString() };
    }

    const conversationIds = [...conversationsById.keys()];
    const approvalConversationIds = [...conversationsById.values()]
      .filter((conversation) => hasPendingAppToolApprovals(conversation))
      .map((conversation) => conversation.id);
    const approvalTriggerTargets = [...conversationsById.values()].flatMap(pendingApprovalTriggerTargets);
    const messages = await this.activityMessageRows(
      conversationIds,
      conversationLimit,
      approvalConversationIds,
      approvalTriggerTargets
    );
    for (const row of messages) {
      const conversation = conversationsById.get(row.conversationId);
      if (!conversation) {
        continue;
      }
      conversation.messages.push(row.message);
    }
    for (const conversation of conversationsById.values()) {
      conversation.messages.sort((left, right) => {
        const timeDelta = Date.parse(left.createdAt) - Date.parse(right.createdAt);
        return timeDelta || left.id.localeCompare(right.id);
      });
    }

    const excludedItemIds = new Set(
      (request.excludedItemIds ?? [])
        .filter((itemId): itemId is string => typeof itemId === "string" && itemId.trim().length > 0)
        .slice(-1_000)
    );
    const items = [...conversationsById.values()].flatMap((conversation) =>
      buildChatActivityItems(conversation, {
        recentWindowDays,
        lastViewedAt: request.lastViewedAtByConversationId?.[conversation.id]
      })
    ).filter((item) => !excludedItemIds.has(item.id));
    return {
      items: limitChatActivityItems(sortChatActivityItems(items), limit),
      generatedAt: new Date().toISOString()
    };
  }

  async getConversation(id: string): Promise<Conversation | undefined> {
    await this.init();
    return this.readWholeConversation(id);
  }

  // The conversation is assembled from its body plus its message rows. The old
  // full `payload_json` copy is no longer written — it duplicated everything the
  // rows already hold, and rewriting it cost megabytes on every save — so it is
  // only read for rows that predate this change and have no body yet.
  private async readWholeConversation(id: string): Promise<Conversation | undefined> {
    const bodyJson = await this.queryText(
      `select coalesce(nullif(body_json, ''), payload_json) from conversations where id = ${sqlString(id)} limit 1;`
    );
    if (!bodyJson) {
      return undefined;
    }
    const conversation = JSON.parse(bodyJson) as Conversation;
    const rows = await this.readAllConversationMessages(id);
    // No rows but the parsed copy has messages means this row still predates the
    // split and was never backfilled — that legacy payload is then the only
    // place the messages exist, so it wins. Anything else takes the rows.
    const legacyPayloadIsTheOnlySource = rows.length === 0 &&
      Array.isArray(conversation.messages) &&
      conversation.messages.length > 0;
    if (!legacyPayloadIsTheOnlySource) {
      conversation.messages = rows;
    }
    conversation.metadata = clearLegacyAccordState(conversation.metadata);
    sanitizeConversationWarnings(conversation);
    return conversation;
  }

  private async readAllConversationMessages(id: string): Promise<ChatMessage[]> {
    const rows = await this.queryJson<{ sequence: number; payloadHex: string }>(
      `
        select sequence, hex(payload_json) as payloadHex
        from conversation_messages
        where conversation_id = ${sqlString(id)}
        order by sequence;
      `
    );
    return rows.map((row) =>
      parseHexJson<ChatMessage>(row.payloadHex, `conversation message ${id}:${row.sequence}`)
    );
  }

  async openConversation(id: string, limit?: number): Promise<ConversationOpenResult | undefined> {
    await this.init();
    const bodyJson = await this.queryText(
      `select coalesce(nullif(body_json, ''), payload_json) from conversations where id = ${sqlString(id)} limit 1;`
    );
    if (!bodyJson) {
      return undefined;
    }
    const conversation = JSON.parse(bodyJson) as Conversation;
    conversation.metadata = clearLegacyAccordState(conversation.metadata);
    sanitizeConversationWarnings(conversation);
    const messagePage = await this.listConversationMessages({
      conversationId: id,
      limit
    });
    return {
      conversation: {
        ...conversation,
        messages: messagePage.messages
      },
      messagePage: messagePageInfo(messagePage)
    };
  }

  async listConversationMessages(request: ConversationMessagePageRequest): Promise<ConversationMessagePage> {
    await this.init();
    const limit = normalizeMessagePageLimit(request.limit);
    const aroundMessageId = typeof request.aroundMessageId === "string" ? request.aroundMessageId.trim() : "";
    let sequenceClause = "";
    if (aroundMessageId) {
      const targetRows = await this.queryJson<{ sequence: number }>(
        `
          select sequence
          from conversation_messages
          where conversation_id = ${sqlString(request.conversationId)}
            and message_id = ${sqlString(aroundMessageId)}
          limit 1;
        `
      );
      const targetSequence = targetRows[0]?.sequence;
      if (targetSequence === undefined) {
        const countRows = await this.queryJson<{ totalMessages: number }>(
          `select count(*) as totalMessages from conversation_messages where conversation_id = ${sqlString(request.conversationId)};`
        );
        return {
          messages: [],
          hasMoreBefore: false,
          totalMessages: countRows[0]?.totalMessages ?? 0
        };
      }
      sequenceClause = ` and sequence <= ${Math.max(0, Math.floor(targetSequence))}`;
    } else if (typeof request.beforeSequence === "number") {
      sequenceClause = ` and sequence < ${Math.max(0, Math.floor(request.beforeSequence))}`;
    }
    const rows = await this.queryJson<{ sequence: number; payloadHex: string }>(
      `
        select sequence, hex(payload_json) as payloadHex
        from conversation_messages
        where conversation_id = ${sqlString(request.conversationId)}${sequenceClause}
        order by sequence desc
        limit ${limit + 1};
      `
    );
    const selectedRows = rows.slice(0, limit).reverse();
    const countRows = await this.queryJson<{ totalMessages: number }>(
      `select count(*) as totalMessages from conversation_messages where conversation_id = ${sqlString(request.conversationId)};`
    );
    return {
      messages: selectedRows.map((row) =>
        parseHexJson<ChatMessage>(row.payloadHex, `conversation message ${request.conversationId}:${row.sequence}`)
      ),
      oldestSequence: selectedRows[0]?.sequence,
      newestSequence: selectedRows[selectedRows.length - 1]?.sequence,
      hasMoreBefore: rows.length > limit,
      totalMessages: countRows[0]?.totalMessages ?? selectedRows.length
    };
  }

  // Only ever a cache of what this process itself wrote. It is dropped whenever
  // the database turns out to hold something else, so a wrong entry costs one
  // full rewrite rather than a lost message. Created on demand because tests
  // build this service through `Object.create`, which skips field initialisers.
  private get savedMessageState(): Map<string, SavedMessageState> {
    if (!this.savedMessageStateCache) {
      this.savedMessageStateCache = new Map();
    }
    return this.savedMessageStateCache;
  }

  // A save used to delete every message row of a conversation and insert them
  // all back. On a 2400-message chat that is ~33MB of SQL text piped into a
  // spawned sqlite3 process, several times per turn, so the cost of saying
  // anything grew with the length of the chat. Only the rows that actually
  // changed are written now; the full rewrite remains as the fallback whenever
  // this process cannot prove what the database currently holds.
  async saveConversation(conversation: Conversation): Promise<void> {
    await this.init();
    const rows = conversation.messages.map((message, index) => {
      const json = JSON.stringify(message);
      return {
        index,
        id: message.id,
        createdAt: message.createdAt,
        json,
        hash: createHash("sha1").update(json).digest("hex")
      };
    });
    const previous = this.savedMessageState.get(conversation.id);
    const nextToken = randomUUID();
    // Another app instance can share this database. The token makes a partial
    // save atomic against that: every message statement is gated on this
    // process still owning the row it last wrote, so a foreign write in between
    // turns the whole batch into a no-op instead of splicing our rows into
    // theirs and producing a state neither instance ever held.
    let claimed = false;
    if (previous) {
      try {
        claimed = await this.writeConversationIncrementally(conversation, rows, previous, nextToken);
      } catch (error) {
        // A failed partial write leaves this process unable to say what the row
        // holds, so the cache is worthless and the next save must rewrite
        // everything.
        this.savedMessageState.delete(conversation.id);
        throw error;
      }
    }
    if (claimed) {
      this.savedMessageState.set(conversation.id, {
        token: nextToken,
        rows: rows.map((row) => ({ id: row.id, hash: row.hash }))
      });
      return;
    }
    this.savedMessageState.delete(conversation.id);
    await this.writeConversationInFull(conversation, rows, nextToken);
    this.savedMessageState.set(conversation.id, {
      token: nextToken,
      rows: rows.map((row) => ({ id: row.id, hash: row.hash }))
    });
  }

  private async writeConversationInFull(
    conversation: Conversation,
    rows: SavedMessageRow[],
    token: string
  ): Promise<void> {
    const bodyPayload = JSON.stringify(conversationBody(conversation));
    // `payload_json` used to hold a second, complete copy of the conversation —
    // every message again, megabytes of it, rewritten on every save. The body
    // and the message rows are the record now; the column stays because it is
    // `not null` and because rows written before this change are still read
    // through it, but it is no longer a copy of anything.
    const payload = bodyPayload;
    const messageRows = rows.map((row) => `
      insert into conversation_messages (conversation_id, sequence, message_id, created_at, payload_json)
      values (
        ${sqlString(conversation.id)},
        ${row.index},
        ${sqlString(row.id)},
        ${sqlString(row.createdAt)},
        ${sqlString(row.json)}
      );
    `).join("\n");
    await this.runSql(`
      begin;
      insert into conversations (id, title, kind, created_at, updated_at, repo_path, payload_json)
      values (
        ${sqlString(conversation.id)},
        ${sqlString(conversation.title)},
        ${sqlString(conversation.kind)},
        ${sqlString(conversation.createdAt)},
        ${sqlString(conversation.updatedAt)},
        ${sqlString(conversation.repoPath)},
        ${sqlString(payload)}
      )
      on conflict(id) do update set
        title = excluded.title,
        kind = excluded.kind,
        updated_at = excluded.updated_at,
        repo_path = excluded.repo_path,
        body_json = ${sqlString(bodyPayload)},
        payload_json = excluded.payload_json;
      update conversations set body_json = ${sqlString(bodyPayload)}, save_token = ${sqlString(token)}
        where id = ${sqlString(conversation.id)};
      delete from conversation_messages where conversation_id = ${sqlString(conversation.id)};
      ${messageRows}
      commit;
    `);
  }

  /** Returns false when this process no longer owns the row, so the caller must
   *  fall back to a full rewrite. */
  private async writeConversationIncrementally(
    conversation: Conversation,
    rows: SavedMessageRow[],
    previous: SavedMessageState,
    token: string
  ): Promise<boolean> {
    const bodyPayload = JSON.stringify(conversationBody(conversation));
    const payload = bodyPayload;
    // Messages are spliced, not only appended (`chat.ts` inserts a message into
    // the middle of the array and removes pending ones), and a splice shifts
    // every later row's sequence while leaving its content identical. Comparing
    // content alone would call those rows clean and leave stale sequences
    // behind, and re-inserting a message id that still exists at another
    // sequence would trip `unique (conversation_id, message_id)` and fail the
    // whole transaction. So the first position whose message id differs decides:
    // everything from there is rewritten, everything before it is touched only
    // when its content changed. An append makes that boundary the old length; an
    // in-place edit makes it the end.
    const shared = Math.min(previous.rows.length, rows.length);
    let divergence = shared;
    for (let index = 0; index < shared; index += 1) {
      if (previous.rows[index].id !== rows[index].id) {
        divergence = index;
        break;
      }
    }
    const owned = `exists (select 1 from conversations where id = ${sqlString(conversation.id)}
      and save_token = ${sqlString(previous.token)})`;
    const statements: string[] = [];
    statements.push(`
      delete from conversation_messages
      where conversation_id = ${sqlString(conversation.id)} and sequence >= ${divergence} and ${owned};
    `);
    for (const row of rows) {
      const changed = row.index >= divergence || previous.rows[row.index].hash !== row.hash;
      if (!changed) {
        continue;
      }
      statements.push(`
        insert into conversation_messages (conversation_id, sequence, message_id, created_at, payload_json)
        select ${sqlString(conversation.id)}, ${row.index}, ${sqlString(row.id)},
          ${sqlString(row.createdAt)}, ${sqlString(row.json)}
        where ${owned}
        on conflict(conversation_id, sequence) do update set
          message_id = excluded.message_id,
          created_at = excluded.created_at,
          payload_json = excluded.payload_json;
      `);
    }
    await this.runSql(`
      begin immediate;
      update conversations set
        title = ${sqlString(conversation.title)},
        kind = ${sqlString(conversation.kind)},
        updated_at = ${sqlString(conversation.updatedAt)},
        repo_path = ${sqlString(conversation.repoPath)},
        body_json = ${sqlString(bodyPayload)},
        payload_json = ${sqlString(payload)}
      where id = ${sqlString(conversation.id)} and save_token = ${sqlString(previous.token)};
      ${statements.join("\n")}
      update conversations set save_token = ${sqlString(token)}
        where id = ${sqlString(conversation.id)} and save_token = ${sqlString(previous.token)};
      commit;
    `);
    const observed = await this.queryText(
      `select save_token from conversations where id = ${sqlString(conversation.id)} limit 1;`
    );
    return observed === token;
  }

  async appendChatEvent(event: ChatEventEnvelope): Promise<ChatEventAppendResult> {
    return (await this.appendChatEvents([event]))[0];
  }

  async appendChatEvents(events: ChatEventEnvelope[]): Promise<ChatEventAppendResult[]> {
    await this.init();
    if (events.length === 0) {
      return [];
    }
    const envelopeJsonByEventId = new Map<string, string>();
    const receivedAt = new Date().toISOString();
    const valuesSql = events.map((event) => {
      this.assertValidChatEventEnvelope(event);
      const envelopeJson = JSON.stringify(event);
      envelopeJsonByEventId.set(event.eventId, envelopeJson);
      return this.chatEventInsertValuesSql(event, envelopeJson, receivedAt);
    }).join(",\n");
    const inserted = await this.queryJson<{ eventId: string }>(
      `
        insert or ignore into chat_events (
          event_id,
          conversation_id,
          log_scope_id,
          origin_id,
          origin_seq,
          logical_ts,
          kind,
          payload_json,
          payload_hash,
          event_hash,
          prev_hash,
          signature,
          key_id,
          envelope_json,
          received_at
        )
        values ${valuesSql}
        returning event_id as eventId;
      `
    );
    const insertedIds = new Set(inserted.map((row) => row.eventId));
    const results: ChatEventAppendResult[] = [];
    for (const event of events) {
      if (insertedIds.has(event.eventId)) {
        results.push({ status: "appended", eventId: event.eventId });
        continue;
      }
      const envelopeJson = envelopeJsonByEventId.get(event.eventId) ?? JSON.stringify(event);
      const conflict = await this.readChatEventConflictRecord(event);
      if (conflict?.source === "event-id" && conflict.envelopeJson === envelopeJson) {
        results.push({ status: "duplicate", eventId: event.eventId });
        continue;
      }
      results.push({
        status: "conflict",
        eventId: event.eventId,
        existingEventId: conflict?.eventId,
        conflictReason: conflict?.source === "origin-sequence" ? "origin-sequence-conflict" : "event-id-conflict"
      });
    }
    return results;
  }

  async listChatEvents(conversationId: string, logScopeId: string): Promise<ChatEventEnvelope[]> {
    await this.init();
    const rows = await this.queryJson<{ envelopeHex: string }>(
      `
        select hex(envelope_json) as envelopeHex
        from chat_events
        where conversation_id = ${sqlString(conversationId)}
          and log_scope_id = ${sqlString(logScopeId)}
        order by origin_id, origin_seq;
      `
    );
    return rows.map((row) => parseHexJson<ChatEventEnvelope>(row.envelopeHex, `chat event ${conversationId}:${logScopeId}`));
  }

  async hasChatEvent(conversationId: string, eventId: string): Promise<boolean> {
    await this.init();
    const normalizedConversationId = conversationId.trim();
    const normalizedEventId = eventId.trim();
    if (!normalizedConversationId || !normalizedEventId) {
      return false;
    }
    const rows = await this.queryJson<{ found: number }>(
      `
        select 1 as found
        from chat_events
        where conversation_id = ${sqlString(normalizedConversationId)}
          and event_id = ${sqlString(normalizedEventId)}
        limit 1;
      `
    );
    return rows.length > 0;
  }

  async saveChatEventProjection(row: ChatEventProjectionRow): Promise<void> {
    await this.init();
    if (!row.conversationId.trim() || !row.projectionKey.trim()) {
      throw new Error("Chat event projection requires conversationId and projectionKey.");
    }
    if (!Number.isInteger(row.version) || row.version <= 0) {
      throw new Error("Chat event projection version must be a positive integer.");
    }
    await this.runSql(`
      insert into chat_event_projections (
        conversation_id,
        projection_key,
        version,
        last_event_id,
        payload_json,
        updated_at
      )
      values (
        ${sqlString(row.conversationId)},
        ${sqlString(row.projectionKey)},
        ${Math.floor(row.version)},
        ${sqlString(row.lastEventId)},
        ${sqlString(JSON.stringify(row.payload))},
        ${sqlString(row.updatedAt)}
      )
      on conflict(conversation_id, projection_key) do update set
        version = excluded.version,
        last_event_id = excluded.last_event_id,
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at;
    `);
  }

  async getChatEventProjection<Projection = unknown>(
    conversationId: string,
    projectionKey: string
  ): Promise<ChatEventProjectionRow<Projection> | undefined> {
    await this.init();
    const rows = await this.queryJson<{
      conversationId: string;
      projectionKey: string;
      version: number;
      lastEventId?: string | null;
      payloadHex: string;
      updatedAt: string;
    }>(
      `
        select
          conversation_id as conversationId,
          projection_key as projectionKey,
          version,
          last_event_id as lastEventId,
          hex(payload_json) as payloadHex,
          updated_at as updatedAt
        from chat_event_projections
        where conversation_id = ${sqlString(conversationId)}
          and projection_key = ${sqlString(projectionKey)}
        limit 1;
      `
    );
    const row = rows[0];
    return row ? {
      conversationId: row.conversationId,
      projectionKey: row.projectionKey,
      version: row.version,
      lastEventId: row.lastEventId ?? undefined,
      payload: parseHexJson<Projection>(row.payloadHex, `chat event projection ${conversationId}:${projectionKey}`),
      updatedAt: row.updatedAt
    } : undefined;
  }

  async getChatEventDeviceIdentityRecord(): Promise<ChatEventDeviceIdentityRecord | undefined> {
    await this.init();
    const raw = await this.getSchemaMeta(CHAT_EVENT_DEVICE_IDENTITY_META_KEY);
    if (!raw) {
      return undefined;
    }
    const parsed = JSON.parse(raw) as ChatEventDeviceIdentityRecord;
    this.assertValidChatEventDeviceIdentityRecord(parsed);
    return parsed;
  }

  async saveChatEventDeviceIdentityRecord(record: ChatEventDeviceIdentityRecord): Promise<void> {
    await this.init();
    this.assertValidChatEventDeviceIdentityRecord(record);
    await this.setSchemaMeta(CHAT_EVENT_DEVICE_IDENTITY_META_KEY, JSON.stringify(record));
  }

  async getChatEventSequenceBasis(originId: string, logScopeId: string): Promise<ChatEventSequenceBasis> {
    await this.init();
    if (!originId.trim() || !logScopeId.trim()) {
      throw new Error("Chat event sequence basis requires originId and logScopeId.");
    }
    const rows = await this.queryJson<{ originSeq?: number | string | null; eventHash?: string | null }>(
      `
        select origin_seq as originSeq, event_hash as eventHash
        from chat_events
        where origin_id = ${sqlString(originId)}
          and log_scope_id = ${sqlString(logScopeId)}
        order by origin_seq desc
        limit 1;
      `
    );
    const latest = rows[0];
    if (!latest) {
      return { originSeq: 1 };
    }
    const latestSeq = typeof latest.originSeq === "string"
      ? Number.parseInt(latest.originSeq, 10)
      : latest.originSeq;
    if (latestSeq === undefined || latestSeq === null || !Number.isSafeInteger(latestSeq) || latestSeq < 1) {
      throw new Error("Stored chat event sequence is invalid.");
    }
    return {
      originSeq: latestSeq + 1,
      prevHash: typeof latest.eventHash === "string" && latest.eventHash.trim() ? latest.eventHash : undefined
    };
  }

  async createPreMigrationBackup(label: string): Promise<string> {
    await this.init();
    const safeLabel = label.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    if (!safeLabel) {
      throw new Error("Pre-migration backup label is required.");
    }
    const backupPath = `${this.dbPath}.${safeLabel}.bak`;
    await this.runSql(`vacuum into ${sqlString(backupPath)};`, SQLITE_MIGRATION_TIMEOUT_MS);
    return backupPath;
  }

  async deleteConversation(id: string): Promise<boolean> {
    await this.init();
    const exists = await this.queryText(
      `select id from conversations where id = ${sqlString(id)} limit 1;`
    );
    if (!exists) {
      return false;
    }
    await this.runSql(`
      begin;
      delete from conversation_messages where conversation_id = ${sqlString(id)};
      delete from conversations where id = ${sqlString(id)};
      commit;
    `);
    this.savedMessageState.delete(id);
    return true;
  }

  private async ensureColumn(table: string, column: string, definition: string): Promise<void> {
    const rows = await this.queryJson<{ name: string }>(`pragma table_info(${table});`);
    if (rows.some((row) => row.name === column)) {
      return;
    }
    await this.runSql(`alter table ${table} add column ${column} ${definition};`);
  }

  private async ensureSchemaMetaTable(): Promise<void> {
    await this.runSql(`
      create table if not exists schema_meta (
        key text primary key,
        value text not null
      );
    `);
  }

  private async configureSqliteRuntime(): Promise<void> {
    const journalMode = (await this.queryText("pragma journal_mode = wal;")).toLowerCase();
    if (journalMode && journalMode !== "wal") {
      console.warn(`[StorageService] SQLite journal_mode=wal requested, got ${journalMode}.`);
    }
  }

  private async assertSupportedSchemaVersion(): Promise<void> {
    const storedVersion = parseStorageSchemaVersion(await this.getSchemaMeta(STORAGE_SCHEMA_VERSION_META_KEY));
    if (storedVersion !== undefined && storedVersion > SUPPORTED_STORAGE_SCHEMA_VERSION) {
      throw new UnsupportedStorageSchemaVersionError(storedVersion, SUPPORTED_STORAGE_SCHEMA_VERSION);
    }
  }

  private assertValidChatEventEnvelope(event: ChatEventEnvelope): void {
    const requiredStrings = [
      ["eventId", event.eventId],
      ["conversationId", event.conversationId],
      ["logScopeId", event.logScopeId],
      ["originId", event.originId],
      ["logicalTs", event.logicalTs],
      ["kind", event.kind],
      ["payloadHash", event.payloadHash],
      ["eventHash", event.eventHash],
      ["createdAt", event.createdAt]
    ] as const;
    for (const [field, value] of requiredStrings) {
      if (typeof value !== "string" || !value.trim()) {
        throw new Error(`Chat event requires ${field}.`);
      }
    }
    if (!Number.isSafeInteger(event.originSeq) || event.originSeq <= 0) {
      throw new Error("Chat event originSeq must be a positive safe integer.");
    }
  }

  private assertValidChatEventDeviceIdentityRecord(record: ChatEventDeviceIdentityRecord): void {
    const requiredStrings = [
      ["originId", record.originId],
      ["keyId", record.keyId],
      ["publicKeyDerBase64", record.publicKeyDerBase64],
      ["privateKeyDerBase64", record.privateKeyDerBase64],
      ["createdAt", record.createdAt]
    ] as const;
    for (const [field, value] of requiredStrings) {
      if (typeof value !== "string" || !value.trim()) {
        throw new Error(`Chat event device identity requires ${field}.`);
      }
    }
  }

  private chatEventInsertValuesSql(event: ChatEventEnvelope, envelopeJson: string, receivedAt: string): string {
    return `(
      ${sqlString(event.eventId)},
      ${sqlString(event.conversationId)},
      ${sqlString(event.logScopeId)},
      ${sqlString(event.originId)},
      ${Math.floor(event.originSeq)},
      ${sqlString(event.logicalTs)},
      ${sqlString(event.kind)},
      ${sqlString(JSON.stringify(event.payload))},
      ${sqlString(event.payloadHash)},
      ${sqlString(event.eventHash)},
      ${sqlString(event.prevHash)},
      ${sqlString(event.signature)},
      ${sqlString(event.keyId)},
      ${sqlString(envelopeJson)},
      ${sqlString(receivedAt)}
    )`;
  }

  private async readChatEventConflictRecord(event: ChatEventEnvelope): Promise<{
    source: "event-id" | "origin-sequence";
    eventId: string;
    envelopeJson: string;
  } | undefined> {
    const rows = await this.queryJson<{ source: "event-id" | "origin-sequence"; eventId: string; envelopeHex: string }>(
      `
        select source, eventId, envelopeHex
        from (
          select
            0 as sortOrder,
            'event-id' as source,
            event_id as eventId,
            hex(envelope_json) as envelopeHex
          from chat_events
          where event_id = ${sqlString(event.eventId)}
          union all
          select
            1 as sortOrder,
            'origin-sequence' as source,
            event_id as eventId,
            hex(envelope_json) as envelopeHex
          from chat_events
          where origin_id = ${sqlString(event.originId)}
            and log_scope_id = ${sqlString(event.logScopeId)}
            and origin_seq = ${Math.floor(event.originSeq)}
        )
        order by sortOrder
        limit 1;
      `
    );
    const row = rows[0];
    return row ? {
      source: row.source,
      eventId: row.eventId,
      envelopeJson: parseHexText(row.envelopeHex, `chat event conflict ${event.eventId}`)
    } : undefined;
  }

  private async backfillConversationBodiesAndMessages(): Promise<void> {
    await this.runSql(`
      begin;
      update conversations
      set body_json = json_set(payload_json, '$.messages', json_array())
      where (body_json is null or body_json = '')
        and json_valid(payload_json);

      with valid_conversations as (
        select c.id, c.payload_json as payload_json
        from conversations c
        where json_valid(c.payload_json)
      ),
      target_conversations as (
        select c.id, c.payload_json as payload_json
        from valid_conversations c
        where json_type(c.payload_json, '$.messages') = 'array'
          and not exists (
            select 1
            from conversation_messages m
            where m.conversation_id = c.id
          )
      )
      insert or ignore into conversation_messages (conversation_id, sequence, message_id, created_at, payload_json)
      select
        c.id,
        cast(message.key as integer),
        json_extract(message.value, '$.id'),
        json_extract(message.value, '$.createdAt'),
        message.value
      from target_conversations c, json_each(c.payload_json, '$.messages') as message
      where json_extract(message.value, '$.id') is not null
        and json_extract(message.value, '$.createdAt') is not null;
      commit;
    `, SQLITE_MIGRATION_TIMEOUT_MS);
  }

  private async clearInterruptedRuns(): Promise<void> {
    // Run state lives in conversation metadata, which is what `body_json` holds.
    // The legacy full payload is only consulted for rows written before the
    // split; searching it for current rows would match a frozen copy and act on
    // state that is no longer true.
    const runMarkers = ["\"running\":true", "\"activeRunIds\":[", "\"participantCompactionsByParticipantId\":"];
    const ids = await this.queryConversationIds(
      runMarkers.map((marker) =>
        `coalesce(nullif(body_json, ''), payload_json) like '%${marker}%'`
      ).join(" or ")
    );
    for (const id of ids) {
      const conversation = await this.readWholeConversation(id);
      if (!conversation) {
        continue;
      }
      const activeRunIds = Array.isArray(conversation.metadata.activeRunIds) ? conversation.metadata.activeRunIds : [];
      const wasRunning = conversation.metadata.running === true || activeRunIds.length > 0;
      const hasParticipantCompactions = Object.keys(readParticipantCompactions(conversation.metadata)).length > 0;
      if (!wasRunning && !hasParticipantCompactions) {
        continue;
      }
      const remoteRunIds = nonTerminalRemoteRunIds(conversation.metadata.remoteRunHandles);
      const remoteRunIdSet = new Set(remoteRunIds);
      const metadataRunId = typeof conversation.metadata.runId === "string" ? conversation.metadata.runId : undefined;
      const localActiveRunIds = activeRunIds.filter((runId): runId is string => typeof runId === "string" && !remoteRunIdSet.has(runId));
      const onlyRemoteRunState = remoteRunIds.length > 0 &&
        localActiveRunIds.length === 0 &&
        (!metadataRunId || remoteRunIdSet.has(metadataRunId));
      if (onlyRemoteRunState) {
        conversation.metadata = withRemoteRunMetadata(clearChatRunMetadata(clearParticipantCompactions(conversation.metadata)), remoteRunIds);
        conversation.updatedAt = new Date().toISOString();
        await this.saveConversation(conversation);
        continue;
      }
    }
  }

  private async normalizeInferredParticipantRequestThreads(): Promise<void> {
    const completed = await this.getSchemaMeta(INFERRED_REQUEST_THREAD_MIGRATION_KEY);
    if (completed === SCHEMA_META_COMPLETE) {
      return;
    }

    // This marker sits in message metadata, not conversation metadata, so it is
    // not in `body_json` at all — the message rows are where it has to be looked
    // for. Rows written before the split have no body and no message rows yet,
    // so their legacy payload is still searched.
    const ids = await this.queryConversationIds(
      `exists (
        select 1 from conversation_messages m
        where m.conversation_id = conversations.id and m.payload_json like '%"source":"inferred"%'
      ) or (coalesce(body_json, '') = '' and payload_json like '%"source":"inferred"%')`
    );
    for (const id of ids) {
      const conversation = await this.readWholeConversation(id);
      if (!conversation) {
        continue;
      }
      if (!normalizeInferredParticipantRequestThreadMetadata(conversation)) {
        continue;
      }
      await this.saveConversation(conversation);
    }
    await this.setSchemaMeta(INFERRED_REQUEST_THREAD_MIGRATION_KEY, SCHEMA_META_COMPLETE);
  }

  private async queryConversationIds(whereSql: string): Promise<string[]> {
    const rows = await this.queryJson<{ id: string }>(`select id from conversations where ${whereSql};`);
    return rows.flatMap((row) => typeof row.id === "string" && row.id.trim() ? [row.id] : []);
  }

  private async activityMessageRows(
    conversationIds: string[],
    conversationLimit: number,
    approvalConversationIds: string[] = [],
    approvalTriggerTargets: Array<[string, string]> = []
  ): Promise<{ conversationId: string; sequence: number; message: ChatMessage }[]> {
    const idList = sqlStringList(conversationIds);
    const pendingRows = await this.queryJson<{ conversationId: string; sequence: number; payloadHex: string }>(
      `
        select conversation_id as conversationId, sequence, hex(payload_json) as payloadHex
        from conversation_messages
        where conversation_id in ${idList}
          and (
            json_extract(payload_json, '$.metadata.pendingChoice.status') = 'pending'
            or exists (
              select 1
              from json_each(payload_json, '$.metadata.pendingMentions') as mention
              where json_extract(mention.value, '$.status') = 'pending'
            )
            or json_extract(payload_json, '$.metadata.participantRequest.status') = 'pending_approval'
          )
        order by created_at desc;
      `
    );
    const pendingParticipantRows = await this.queryJson<{ conversationId: string; sequence: number; payloadHex: string }>(
      `
        select conversation_id as conversationId, sequence, hex(payload_json) as payloadHex
        from conversation_messages
        where conversation_id in ${idList}
          and json_extract(payload_json, '$.role') = 'participant'
          and json_extract(payload_json, '$.status') = 'pending'
          and json_extract(payload_json, '$.metadata.runId') is not null
        order by created_at desc
        limit ${Math.max(DEFAULT_CHAT_ACTIVITY_LIMIT, conversationLimit * 2)};
      `
    );
    const participantRows = await this.queryJson<{ conversationId: string; sequence: number; payloadHex: string }>(
      `
        select conversationId, sequence, hex(payloadJson) as payloadHex
        from (
          select
            conversation_id as conversationId,
            sequence,
            payload_json as payloadJson,
            row_number() over (
              partition by
                conversation_id,
                coalesce(
                  nullif(json_extract(payload_json, '$.participantId'), ''),
                  lower(nullif(json_extract(payload_json, '$.participantLabel'), '')),
                  message_id
                )
              order by created_at desc
            ) as rowNumber
          from conversation_messages
          where conversation_id in ${idList}
            and json_extract(payload_json, '$.role') = 'participant'
            and json_extract(payload_json, '$.status') = 'done'
            and coalesce(json_extract(payload_json, '$.metadata.hiddenFromTimeline'), 0) not in (1, '1', 'true')
        )
        where rowNumber <= 8
        order by json_extract(payloadJson, '$.createdAt') desc
        limit ${Math.max(DEFAULT_CHAT_ACTIVITY_LIMIT * 4, conversationLimit * 16)};
      `
    );
    const approvalContextRows = approvalConversationIds.length > 0
      ? await this.queryJson<{ conversationId: string; sequence: number; payloadHex: string }>(
        `
          select conversationId, sequence, hex(payloadJson) as payloadHex
          from (
            select
              conversation_id as conversationId,
              sequence,
              payload_json as payloadJson,
              row_number() over (partition by conversation_id order by created_at desc) as rowNumber
            from conversation_messages
            where conversation_id in ${sqlStringList(approvalConversationIds)}
              and coalesce(json_extract(payload_json, '$.role'), '') != 'system'
          )
          where rowNumber <= 48
          order by conversationId, sequence;
        `
      )
      : [];
    const approvalTriggerRows = approvalTriggerTargets.length > 0
      ? await this.queryJson<{ conversationId: string; sequence: number; payloadHex: string }>(
        `
          select conversation_id as conversationId, sequence, hex(payload_json) as payloadHex
          from conversation_messages
          where (conversation_id, message_id) in ${sqlStringPairList(approvalTriggerTargets)};
        `
      )
      : [];
    const decodeRows = (
      rows: Array<{ conversationId: string; sequence: number; payloadHex: string }>,
      context: string
    ) => rows.map((row) => ({
      conversationId: row.conversationId,
      sequence: row.sequence,
      message: parseHexJson<ChatMessage>(
        row.payloadHex,
        `${context} ${row.conversationId}:${row.sequence}`
      )
    }));
    const decodedPendingRows = decodeRows(pendingRows, "pending activity message");
    const decodedPendingParticipantRows = decodeRows(pendingParticipantRows, "pending participant activity message");
    const decodedParticipantRows = decodeRows(participantRows, "participant activity message");
    const decodedApprovalContextRows = decodeRows(approvalContextRows, "approval context message");
    const decodedApprovalTriggerRows = decodeRows(approvalTriggerRows, "approval trigger message");
    const activitySourceTargets = [
      ...decodedPendingRows,
      ...decodedPendingParticipantRows,
      ...decodedApprovalTriggerRows
    ].flatMap((row) => {
      const ids = [row.message.metadata?.sourceMessageId, row.message.metadata?.parentMessageId, row.message.metadata?.chatThreadRootId]
        .flatMap((value) => typeof value === "string" && value.trim() ? [value.trim()] : []);
      return [...new Set(ids)].map((messageId) => [row.conversationId, messageId] as [string, string]);
    });
    const activitySourceRows = activitySourceTargets.length > 0
      ? await this.queryJson<{ conversationId: string; sequence: number; payloadHex: string }>(
        `
          select conversation_id as conversationId, sequence, hex(payload_json) as payloadHex
          from conversation_messages
          where (conversation_id, message_id) in ${sqlStringPairList(activitySourceTargets)};
        `
      )
      : [];
    const decodedSourceRows = activitySourceRows.map((row) => ({
      conversationId: row.conversationId,
      sequence: row.sequence,
      message: parseHexJson<ChatMessage>(
        row.payloadHex,
        `activity source message ${row.conversationId}:${row.sequence}`
      )
    }));
    const byKey = new Map<string, { conversationId: string; sequence: number; message: ChatMessage }>();
    for (const row of [
      ...decodedPendingRows,
      ...decodedPendingParticipantRows,
      ...decodedParticipantRows,
      ...decodedApprovalContextRows,
      ...decodedApprovalTriggerRows,
      ...decodedSourceRows
    ]) {
      byKey.set(`${row.conversationId}:${row.sequence}`, row);
    }
    return [...byKey.values()];
  }

  private async getSchemaMeta(key: string): Promise<string | undefined> {
    const value = await this.queryText(`select value from schema_meta where key = ${sqlString(key)} limit 1;`);
    return value || undefined;
  }

  private async setSchemaMeta(key: string, value: string): Promise<void> {
    await this.runSql(`
      insert into schema_meta (key, value)
      values (${sqlString(key)}, ${sqlString(value)})
      on conflict(key) do update set value = excluded.value;
    `);
  }

  private async queryJson<T>(sql: string): Promise<T[]> {
    const result = await runCommand(this.sqliteExecutable ?? "sqlite3", this.sqliteArgs(["-json", this.dbPath, sql]), {
      timeoutMs: SQLITE_COMMAND_TIMEOUT_MS,
      primeLoginShellEnv: false
    });
    const text = result.stdout.trim();
    return text ? (JSON.parse(text) as T[]) : [];
  }

  private async queryText(sql: string): Promise<string> {
    const result = await runCommand(this.sqliteExecutable ?? "sqlite3", this.sqliteArgs(["-batch", "-noheader", this.dbPath, sql]), {
      timeoutMs: SQLITE_COMMAND_TIMEOUT_MS,
      primeLoginShellEnv: false
    });
    return result.stdout.trim();
  }

  private async runSql(sql: string, timeoutMs = SQLITE_COMMAND_TIMEOUT_MS): Promise<void> {
    await runCommand(this.sqliteExecutable ?? "sqlite3", this.sqliteArgs([this.dbPath]), {
      input: sql,
      timeoutMs,
      primeLoginShellEnv: false
    });
  }

  private sqliteArgs(args: string[]): string[] {
    return [
      "-cmd",
      `.timeout ${SQLITE_BUSY_TIMEOUT_MS}`,
      "-cmd",
      "pragma synchronous = normal;",
      ...args
    ];
  }
}

function normalizeMessagePageLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) {
    return DEFAULT_MESSAGE_PAGE_LIMIT;
  }
  return Math.max(1, Math.min(MAX_MESSAGE_PAGE_LIMIT, Math.floor(limit as number)));
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function conversationBody(conversation: Conversation): Conversation {
  return {
    ...conversation,
    messages: []
  };
}

function messagePageInfo(page: ConversationMessagePage): ConversationMessagePageInfo {
  return {
    oldestSequence: page.oldestSequence,
    newestSequence: page.newestSequence,
    hasMoreBefore: page.hasMoreBefore,
    totalMessages: page.totalMessages
  };
}

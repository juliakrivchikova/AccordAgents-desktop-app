import { mkdir } from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import { runCommand } from "./command";
import type {
  ChatMessage,
  ChatParticipant,
  Conversation,
  ConversationMessagePage,
  ConversationMessagePageInfo,
  ConversationMessagePageRequest,
  ConversationOpenResult,
  ConversationSummary,
  ListChatActivityRequest,
  ListChatActivityResult
} from "../../shared/types";
import type { ChatSearchDocument } from "../../shared/chatSearchDocuments";
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
const INFERRED_REQUEST_THREAD_MIGRATION_KEY = "inferred-participant-request-threads-v1";
const CHAT_SEARCH_INDEX_META_KEY = "chat-search-index-version";
const CHAT_SEARCH_INDEX_VERSION = 2;
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

export class InvalidChatSearchSourceError extends Error {
  constructor(readonly conversationId: string, cause?: unknown) {
    super(`Saved chat ${conversationId} could not be read for search.`, { cause });
    this.name = "InvalidChatSearchSourceError";
  }
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

export interface ChatSearchConversationSnapshot {
  conversationId: string;
  title: string;
  repoPath?: string;
  archived: boolean;
  updatedAt: string;
  messageCount: number;
  oldestMessageAt?: string;
  newestMessageAt?: string;
  participants: ChatParticipant[];
  sourceReadable?: boolean;
}

export interface ChatSearchConversationRead {
  snapshot: ChatSearchConversationSnapshot;
  conversation: Conversation;
}

export interface ChatSearchDocumentReplacement {
  snapshot: ChatSearchConversationSnapshot;
  documents: ChatSearchDocument[];
  indexedAt: string;
}

export interface ChatSearchIndexState {
  conversationId: string;
  sourceTitle: string;
  sourceUpdatedAt: string;
  sourceMessageCount: number;
  sourceNewestMessageAt?: string;
  indexedAt: string;
  indexSchemaVersion: number;
}

export interface StoredChatSearchTitleMatch {
  kind: "title";
  conversationId: string;
  titleText: string;
  snippet: string;
  rank: number;
}

export interface StoredChatSearchMessageMatch {
  kind: "message";
  conversationId: string;
  messageId: string;
  threadRootId?: string;
  role: "user" | "participant";
  authorLabel: string;
  createdAt: string;
  snippet: string;
  rank: number;
}

export interface StoredChatSearchQueryResult {
  titleMatches: StoredChatSearchTitleMatch[];
  messageMatches: StoredChatSearchMessageMatch[];
  messageMatchCount: number;
  matchedChatCount: number;
}

export class StorageService {
  private readonly dbPath: string;
  private readonly sqliteExecutable: string;
  private initialized = false;
  private chatSearchIndexReady = false;

  constructor(options: StorageServiceOptions = {}) {
    this.dbPath = options.dbPath ?? path.join(app.getPath("userData"), "accordagents.sqlite3");
    this.sqliteExecutable = options.sqliteExecutable ?? "sqlite3";
  }

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await mkdir(path.dirname(this.dbPath), { recursive: true });
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
    `);
    await this.pruneStaleRunCancelRequests();
    await this.ensureColumn("conversations", "body_json", "text");
    await this.backfillConversationBodiesAndMessages();
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
         json_extract(payload_json, '$.metadata.running') as running,
         json_extract(payload_json, '$.metadata.archived') as archived,
         coalesce(json_array_length(payload_json, '$.metadata.activeRunIds'), 0) as activeRunIdsCount,
         json_extract(payload_json, '$.metadata.participants') as chatParticipantsJson
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
         and coalesce(json_extract(payload_json, '$.metadata.archived'), 0) not in (1, '1', 'true')
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
    const payloadJson = await this.queryText(
      `select payload_json from conversations where id = ${sqlString(id)} limit 1;`
    );
    if (!payloadJson) {
      return undefined;
    }
    const conversation = JSON.parse(payloadJson) as Conversation;
    conversation.metadata = clearLegacyAccordState(conversation.metadata);
    sanitizeConversationWarnings(conversation);
    return conversation;
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

  async listChatSearchConversationSnapshots(options: { includeParticipants?: boolean } = {}): Promise<ChatSearchConversationSnapshot[]> {
    await this.init();
    const includeParticipants = options.includeParticipants !== false;
    const rows = await this.queryJson<{
      conversationId: string;
      title: string;
      repoPath?: string;
      archived?: number | string | boolean | null;
      updatedAt: string;
      messageCount: number | string;
      oldestMessageAt?: string | null;
      newestMessageAt?: string | null;
      participantsHex?: string;
      payloadValid: number | string;
    }>(`
      with chat_bodies as (
        select
          id,
          title,
          repo_path,
          updated_at,
          coalesce(nullif(body_json, ''), payload_json) as source_json
        from conversations
        where kind = 'chat'
      ), message_stats as (
        select
          conversation_id,
          count(*) as message_count,
          min(created_at) as oldest_message_at,
          max(created_at) as newest_message_at
        from conversation_messages
        group by conversation_id
      )
      select
        c.id as conversationId,
        c.title,
        c.repo_path as repoPath,
        case when json_valid(c.source_json) then json_extract(c.source_json, '$.metadata.archived') end as archived,
        c.updated_at as updatedAt,
        coalesce(s.message_count, 0) as messageCount,
        s.oldest_message_at as oldestMessageAt,
        s.newest_message_at as newestMessageAt,
        ${includeParticipants
          ? "case when json_valid(c.source_json) then hex(coalesce(json_extract(c.source_json, '$.metadata.participants'), '[]')) end"
          : "NULL"} as participantsHex,
        json_valid(c.source_json) as payloadValid
      from chat_bodies c
      left join message_stats s on s.conversation_id = c.id
      order by c.updated_at desc;
    `);
    return rows.map((row) => {
      const sourceReadable = sqliteBoolean(row.payloadValid);
      try {
        return {
          conversationId: row.conversationId,
          title: row.title,
          ...(row.repoPath ? { repoPath: row.repoPath } : {}),
          archived: sqliteBoolean(row.archived),
          updatedAt: row.updatedAt,
          messageCount: Number(row.messageCount) || 0,
          ...(row.oldestMessageAt ? { oldestMessageAt: row.oldestMessageAt } : {}),
          ...(row.newestMessageAt ? { newestMessageAt: row.newestMessageAt } : {}),
          participants: sourceReadable && includeParticipants && row.participantsHex
            ? parseHexJson<unknown[]>(row.participantsHex, `chat search participants ${row.conversationId}`)
              .filter(isStoredChatParticipant)
            : [],
          sourceReadable
        };
      } catch (error) {
        throw new InvalidChatSearchSourceError(row.conversationId, error);
      }
    });
  }

  async readChatSearchConversation(conversationId: string): Promise<Conversation | undefined> {
    await this.init();
    const rows = await this.queryJson<{ rowKind: "body" | "message"; sequence: number; payloadHex: string }>(`
      select rowKind, sequence, payloadHex
      from (
        select
          'body' as rowKind,
          -1 as sequence,
          hex(coalesce(nullif(body_json, ''), json_set(payload_json, '$.messages', json_array()))) as payloadHex
        from conversations
        where id = ${sqlString(conversationId)} and kind = 'chat'
        union all
        select
          'message' as rowKind,
          sequence,
          hex(payload_json) as payloadHex
        from conversation_messages
        where conversation_id = ${sqlString(conversationId)}
      )
      order by sequence;
    `);
    const body = rows.find((row) => row.rowKind === "body");
    if (!body) {
      return undefined;
    }
    const conversation = parseHexJson<Conversation>(body.payloadHex, `chat search conversation ${conversationId}`);
    conversation.metadata = clearLegacyAccordState(conversation.metadata);
    conversation.messages = rows
      .filter((row) => row.rowKind === "message")
      .map((row) => parseHexJson<ChatMessage>(row.payloadHex, `chat search message ${conversationId}:${row.sequence}`));
    sanitizeConversationWarnings(conversation);
    return conversation;
  }

  async readChatSearchConversations(conversationIds: string[]): Promise<ChatSearchConversationRead[]> {
    await this.init();
    if (conversationIds.length === 0) {
      return [];
    }
    const rows = await this.queryJson<{
      conversationId: string;
      title: string;
      repoPath?: string;
      archived?: number | string | boolean | null;
      updatedAt: string;
      messageCount: number | string;
      oldestMessageAt?: string | null;
      newestMessageAt?: string | null;
      participantsHex: string;
      payloadValid: number | string;
      rowKind: "body" | "message";
      sequence: number;
      payloadHex: string;
    }>(`
      with selected_conversations as (
        select
          c.id as conversation_id,
          c.title,
          c.repo_path,
          case when json_valid(coalesce(nullif(c.body_json, ''), c.payload_json))
            then json_extract(coalesce(nullif(c.body_json, ''), c.payload_json), '$.metadata.archived') end as archived,
          c.updated_at,
          case when json_valid(coalesce(nullif(c.body_json, ''), c.payload_json))
            then hex(coalesce(json_extract(coalesce(nullif(c.body_json, ''), c.payload_json), '$.metadata.participants'), '[]')) else '' end as participants_hex,
          case when json_valid(coalesce(nullif(c.body_json, ''), c.payload_json))
            then hex(coalesce(nullif(c.body_json, ''), c.payload_json)) else '' end as body_hex,
          json_valid(coalesce(nullif(c.body_json, ''), c.payload_json)) as payload_valid
        from conversations c
        where c.kind = 'chat' and c.id in ${sqlStringList(conversationIds)}
      ), message_stats as (
        select
          m.conversation_id,
          count(*) as message_count,
          min(m.created_at) as oldest_message_at,
          max(m.created_at) as newest_message_at
        from conversation_messages m
        where m.conversation_id in ${sqlStringList(conversationIds)}
        group by m.conversation_id
      ), source_rows as (
        select
          c.conversation_id, c.title, c.repo_path, c.archived, c.updated_at,
          coalesce(s.message_count, 0) as message_count,
          s.oldest_message_at, s.newest_message_at, c.participants_hex, c.payload_valid,
          'body' as row_kind, -1 as sequence, c.body_hex as payload_hex
        from selected_conversations c
        left join message_stats s on s.conversation_id = c.conversation_id
        union all
        select
          c.conversation_id, c.title, c.repo_path, c.archived, c.updated_at,
          s.message_count, s.oldest_message_at, s.newest_message_at, c.participants_hex, c.payload_valid,
          'message' as row_kind, m.sequence, hex(m.payload_json) as payload_hex
        from selected_conversations c
        join message_stats s on s.conversation_id = c.conversation_id
        join conversation_messages m on m.conversation_id = c.conversation_id
      )
      select
        conversation_id as conversationId,
        title,
        repo_path as repoPath,
        archived,
        updated_at as updatedAt,
        message_count as messageCount,
        oldest_message_at as oldestMessageAt,
        newest_message_at as newestMessageAt,
        participants_hex as participantsHex,
        payload_valid as payloadValid,
        row_kind as rowKind,
        sequence,
        payload_hex as payloadHex
      from source_rows
      order by conversation_id, sequence;
    `);
    const rowsByConversation = new Map<string, typeof rows>();
    for (const row of rows) {
      const grouped = rowsByConversation.get(row.conversationId) ?? [];
      grouped.push(row);
      rowsByConversation.set(row.conversationId, grouped);
    }
    return conversationIds.flatMap((conversationId) => {
      const conversationRows = rowsByConversation.get(conversationId);
      const body = conversationRows?.find((row) => row.rowKind === "body");
      if (!body) {
        return [];
      }
      if (!sqliteBoolean(body.payloadValid)) {
        throw new InvalidChatSearchSourceError(conversationId);
      }
      try {
        const conversation = parseHexJson<Conversation>(body.payloadHex, `chat search conversation ${conversationId}`);
        conversation.metadata = clearLegacyAccordState(conversation.metadata);
        conversation.messages = (conversationRows ?? [])
          .filter((row) => row.rowKind === "message")
          .map((row) => parseHexJson<ChatMessage>(row.payloadHex, `chat search message ${conversationId}:${row.sequence}`));
        sanitizeConversationWarnings(conversation);
        return [{
          snapshot: {
            conversationId,
            title: body.title,
            ...(body.repoPath ? { repoPath: body.repoPath } : {}),
            archived: sqliteBoolean(body.archived),
            updatedAt: body.updatedAt,
            messageCount: Number(body.messageCount) || 0,
            ...(body.oldestMessageAt ? { oldestMessageAt: body.oldestMessageAt } : {}),
            ...(body.newestMessageAt ? { newestMessageAt: body.newestMessageAt } : {}),
            participants: parseHexJson<unknown[]>(body.participantsHex, `chat search participants ${conversationId}`)
              .filter(isStoredChatParticipant)
          },
          conversation
        }];
      } catch (error) {
        throw new InvalidChatSearchSourceError(conversationId, error);
      }
    });
  }

  async ensureChatSearchIndex(): Promise<void> {
    await this.init();
    if (this.chatSearchIndexReady) {
      return;
    }
    const valid = await this.chatSearchIndexIsValid().catch(() => false);
    if (!valid) {
      await this.rebuildChatSearchIndex();
      return;
    }
    try {
      await this.runSql("insert into chat_search_fts(chat_search_fts) values('integrity-check');");
      this.chatSearchIndexReady = true;
    } catch {
      await this.rebuildChatSearchIndex();
    }
  }

  async rebuildChatSearchIndex(): Promise<void> {
    await this.init();
    this.chatSearchIndexReady = false;
    await this.runSql(`
      begin;
      drop table if exists chat_search_fts;
      drop table if exists chat_search_state;
      create virtual table chat_search_fts using fts5(
        conversation_id unindexed,
        document_kind unindexed,
        message_id unindexed,
        thread_root_id unindexed,
        role unindexed,
        author_label unindexed,
        created_at unindexed,
        conversation_updated_at unindexed,
        title_text,
        body,
        tokenize = 'unicode61 remove_diacritics 2'
      );
      create table chat_search_state (
        conversation_id text primary key,
        source_title text not null,
        source_updated_at text not null,
        source_message_count integer not null,
        source_newest_message_at text,
        indexed_at text not null,
        index_schema_version integer not null
      );
      insert into schema_meta (key, value)
      values (${sqlString(CHAT_SEARCH_INDEX_META_KEY)}, ${sqlString(String(CHAT_SEARCH_INDEX_VERSION))})
      on conflict(key) do update set value = excluded.value;
      commit;
    `, SQLITE_MIGRATION_TIMEOUT_MS);
    this.chatSearchIndexReady = true;
  }

  private async chatSearchIndexIsValid(): Promise<boolean> {
    const rows = await this.queryJson<{
      storedVersion?: string | null;
      ftsSql?: string | null;
      stateColumns?: string | null;
    }>(`
      select
        (select value from schema_meta where key = ${sqlString(CHAT_SEARCH_INDEX_META_KEY)}) as storedVersion,
        (select sql from sqlite_master where name = 'chat_search_fts' and type = 'table') as ftsSql,
        (select group_concat(name, ',') from pragma_table_info('chat_search_state')) as stateColumns;
    `);
    const row = rows[0];
    const ftsSql = row?.ftsSql?.toLowerCase() ?? "";
    const stateColumns = new Set((row?.stateColumns ?? "").split(",").filter(Boolean));
    const expectedStateColumns = [
      "conversation_id",
      "source_title",
      "source_updated_at",
      "source_message_count",
      "source_newest_message_at",
      "indexed_at",
      "index_schema_version"
    ];
    return row?.storedVersion === String(CHAT_SEARCH_INDEX_VERSION) &&
      ftsSql.includes("using fts5") &&
      [
        "conversation_id",
        "document_kind",
        "message_id",
        "thread_root_id",
        "role",
        "author_label",
        "created_at",
        "conversation_updated_at",
        "title_text",
        "body"
      ]
        .every((column) => ftsSql.includes(column)) &&
      expectedStateColumns.every((column) => stateColumns.has(column));
  }

  async listChatSearchIndexStates(conversationIds?: string[]): Promise<ChatSearchIndexState[]> {
    await this.ensureChatSearchIndex();
    if (conversationIds?.length === 0) {
      return [];
    }
    const rows = await this.queryJson<{
      conversationId: string;
      sourceTitle: string;
      sourceUpdatedAt: string;
      sourceMessageCount: number | string;
      sourceNewestMessageAt?: string | null;
      indexedAt: string;
      indexSchemaVersion: number | string;
    }>(`
      select
        conversation_id as conversationId,
        source_title as sourceTitle,
        source_updated_at as sourceUpdatedAt,
        source_message_count as sourceMessageCount,
        source_newest_message_at as sourceNewestMessageAt,
        indexed_at as indexedAt,
        index_schema_version as indexSchemaVersion
      from chat_search_state
      ${conversationIds ? `where conversation_id in ${sqlStringList(conversationIds)}` : ""};
    `);
    return rows.map((row) => ({
      conversationId: row.conversationId,
      sourceTitle: row.sourceTitle,
      sourceUpdatedAt: row.sourceUpdatedAt,
      sourceMessageCount: Number(row.sourceMessageCount) || 0,
      ...(row.sourceNewestMessageAt ? { sourceNewestMessageAt: row.sourceNewestMessageAt } : {}),
      indexedAt: row.indexedAt,
      indexSchemaVersion: Number(row.indexSchemaVersion) || 0
    }));
  }

  async replaceChatSearchDocuments(
    snapshot: ChatSearchConversationSnapshot,
    documents: ChatSearchDocument[],
    indexedAt: string
  ): Promise<void> {
    await this.replaceChatSearchDocumentsBatch([{ snapshot, documents, indexedAt }]);
  }

  async replaceChatSearchDocumentsBatch(replacements: ChatSearchDocumentReplacement[]): Promise<void> {
    await this.ensureChatSearchIndex();
    if (replacements.length === 0) {
      return;
    }
    const replacementSql = replacements.map(({ snapshot, documents, indexedAt }) => {
      const insertSql = documents.map((document) => `
        insert into chat_search_fts (
          conversation_id, document_kind, message_id, thread_root_id, role, author_label,
          created_at, conversation_updated_at, title_text, body
        ) values (
          ${sqlString(snapshot.conversationId)},
          ${sqlString(document.kind)},
          ${sqlString(document.kind === "message" ? document.messageId : undefined)},
          ${sqlString(document.kind === "message" ? document.threadRootId : undefined)},
          ${sqlString(document.kind === "message" ? document.role : undefined)},
          ${sqlString(document.kind === "message" ? document.authorLabel : undefined)},
          ${sqlString(document.kind === "message" ? document.createdAt : undefined)},
          ${sqlString(snapshot.updatedAt)},
          ${sqlString(document.kind === "title" ? document.titleText : undefined)},
          ${sqlString(document.kind === "message" ? document.body : undefined)}
        );
      `).join("\n");
      return `
        delete from chat_search_fts where conversation_id = ${sqlString(snapshot.conversationId)};
        ${insertSql}
        insert into chat_search_state (
          conversation_id, source_title, source_updated_at, source_message_count,
          source_newest_message_at, indexed_at, index_schema_version
        ) values (
          ${sqlString(snapshot.conversationId)},
          ${sqlString(snapshot.title)},
          ${sqlString(snapshot.updatedAt)},
          ${snapshot.messageCount},
          ${sqlString(snapshot.newestMessageAt)},
          ${sqlString(indexedAt)},
          ${CHAT_SEARCH_INDEX_VERSION}
        ) on conflict(conversation_id) do update set
          source_title = excluded.source_title,
          source_updated_at = excluded.source_updated_at,
          source_message_count = excluded.source_message_count,
          source_newest_message_at = excluded.source_newest_message_at,
          indexed_at = excluded.indexed_at,
          index_schema_version = excluded.index_schema_version;
      `;
    }).join("\n");
    await this.runSql(`
      begin;
      ${replacementSql}
      commit;
    `, SQLITE_MIGRATION_TIMEOUT_MS);
  }

  async deleteChatSearchDocuments(conversationIds: string[]): Promise<void> {
    await this.ensureChatSearchIndex();
    if (conversationIds.length === 0) {
      return;
    }
    await this.runSql(`
      begin;
      delete from chat_search_fts where conversation_id in ${sqlStringList(conversationIds)};
      delete from chat_search_state where conversation_id in ${sqlStringList(conversationIds)};
      commit;
    `);
  }

  async queryChatSearchIndex(request: {
    conversationIds: string[];
    matchQuery: string;
    startMarker: string;
    endMarker: string;
    limit: number;
    offset?: number;
  }): Promise<StoredChatSearchQueryResult> {
    await this.ensureChatSearchIndex();
    if (request.conversationIds.length === 0) {
      return { titleMatches: [], messageMatches: [], messageMatchCount: 0, matchedChatCount: 0 };
    }
    const rows = await this.queryJson<{
      rowKind: "title" | "message" | "counts";
      conversationId?: string | null;
      messageId?: string | null;
      threadRootId?: string | null;
      role?: "user" | "participant" | null;
      authorLabel?: string | null;
      createdAt?: string | null;
      titleText?: string | null;
      snippetHex?: string | null;
      rank?: number | string | null;
      messageMatchCount?: number | string | null;
      matchedChatCount?: number | string | null;
    }>(`
      with title_matches as (
        select
          'title' as rowKind,
          conversation_id as conversationId,
          NULL as messageId,
          NULL as threadRootId,
          NULL as role,
          NULL as authorLabel,
          NULL as createdAt,
          title_text as titleText,
          hex(highlight(chat_search_fts, 8, ${sqlString(request.startMarker)}, ${sqlString(request.endMarker)})) as snippetHex,
          bm25(chat_search_fts) as rank,
          NULL as messageMatchCount,
          NULL as matchedChatCount,
          conversation_updated_at as sortUpdatedAt,
          0 as rowOrder
        from chat_search_fts
        where chat_search_fts match ${sqlString(request.matchQuery)}
          and conversation_id in ${sqlStringList(request.conversationIds)}
          and document_kind = 'title'
      ), message_matches as (
        select
          'message' as rowKind,
          conversation_id as conversationId,
          message_id as messageId,
          thread_root_id as threadRootId,
          role,
          author_label as authorLabel,
          created_at as createdAt,
          NULL as titleText,
          hex(snippet(chat_search_fts, 9, ${sqlString(request.startMarker)}, ${sqlString(request.endMarker)}, ' … ', 24)) as snippetHex,
          bm25(chat_search_fts) as rank,
          NULL as messageMatchCount,
          NULL as matchedChatCount,
          conversation_updated_at as sortUpdatedAt,
          1 as rowOrder
        from chat_search_fts
        where chat_search_fts match ${sqlString(request.matchQuery)}
          and conversation_id in ${sqlStringList(request.conversationIds)}
          and document_kind = 'message'
        order by conversation_updated_at desc, conversation_id asc, created_at asc, message_id asc
        limit ${request.limit}
        offset ${Math.max(0, Math.floor(request.offset ?? 0))}
      ), match_counts as (
        select
          'counts' as rowKind,
          NULL as conversationId,
          NULL as messageId,
          NULL as threadRootId,
          NULL as role,
          NULL as authorLabel,
          NULL as createdAt,
          NULL as titleText,
          NULL as snippetHex,
          NULL as rank,
          coalesce(sum(case when document_kind = 'message' then 1 else 0 end), 0) as messageMatchCount,
          count(distinct conversation_id) as matchedChatCount,
          NULL as sortUpdatedAt,
          2 as rowOrder
        from chat_search_fts
        where chat_search_fts match ${sqlString(request.matchQuery)}
          and conversation_id in ${sqlStringList(request.conversationIds)}
      )
      select * from (
        select * from title_matches
        union all
        select * from message_matches
        union all
        select * from match_counts
      )
      order by rowOrder, sortUpdatedAt desc, conversationId asc, createdAt asc, messageId asc;
    `);
    const titleRows = rows.filter((row) => row.rowKind === "title");
    const messageRows = rows.filter((row) => row.rowKind === "message");
    const countRow = rows.find((row) => row.rowKind === "counts");
    return {
      titleMatches: titleRows.map((row) => ({
        kind: "title",
        conversationId: row.conversationId ?? "",
        titleText: row.titleText ?? "",
        snippet: parseHexText(row.snippetHex, `chat search title ${row.conversationId}`),
        rank: Number(row.rank) || 0
      })),
      messageMatches: messageRows.map((row) => ({
        kind: "message",
        conversationId: row.conversationId ?? "",
        messageId: row.messageId ?? "",
        ...(row.threadRootId ? { threadRootId: row.threadRootId } : {}),
        role: row.role ?? "user",
        authorLabel: row.authorLabel ?? "",
        createdAt: row.createdAt ?? "",
        snippet: parseHexText(row.snippetHex, `chat search snippet ${row.conversationId}:${row.messageId}`),
        rank: Number(row.rank) || 0
      })),
      messageMatchCount: Number(countRow?.messageMatchCount) || 0,
      matchedChatCount: Number(countRow?.matchedChatCount) || 0
    };
  }

  async saveConversation(conversation: Conversation): Promise<void> {
    await this.init();
    const payload = JSON.stringify(conversation);
    const bodyPayload = JSON.stringify(conversationBody(conversation));
    const messageRows = conversation.messages.map((message, index) => `
      insert into conversation_messages (conversation_id, sequence, message_id, created_at, payload_json)
      values (
        ${sqlString(conversation.id)},
        ${index},
        ${sqlString(message.id)},
        ${sqlString(message.createdAt)},
        ${sqlString(JSON.stringify(message))}
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
      update conversations set body_json = ${sqlString(bodyPayload)} where id = ${sqlString(conversation.id)};
      delete from conversation_messages where conversation_id = ${sqlString(conversation.id)};
      ${messageRows}
      commit;
    `);
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
    return true;
  }

  private async ensureColumn(table: string, column: string, definition: string): Promise<void> {
    const rows = await this.queryJson<{ name: string }>(`pragma table_info(${table});`);
    if (rows.some((row) => row.name === column)) {
      return;
    }
    await this.runSql(`alter table ${table} add column ${column} ${definition};`);
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
    const ids = await this.queryConversationIds(
      "payload_json like '%\"running\":true%' or payload_json like '%\"activeRunIds\":[%' or payload_json like '%\"participantCompactionsByParticipantId\":%'"
    );
    for (const id of ids) {
      const payloadJson = await this.readConversationPayloadById(id);
      if (!payloadJson) {
        continue;
      }
      let conversation: Conversation;
      try {
        conversation = JSON.parse(payloadJson) as Conversation;
      } catch {
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

    const ids = await this.queryConversationIds("payload_json like '%\"source\":\"inferred\"%'");
    for (const id of ids) {
      const payloadJson = await this.readConversationPayloadById(id);
      if (!payloadJson) {
        continue;
      }
      let conversation: Conversation;
      try {
        conversation = JSON.parse(payloadJson) as Conversation;
      } catch {
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

  private async readConversationPayloadById(id: string): Promise<string | undefined> {
    const payloadJson = await this.queryText(
      `select payload_json from conversations where id = ${sqlString(id)} limit 1;`
    );
    return payloadJson || undefined;
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
    return ["-cmd", `.timeout ${SQLITE_BUSY_TIMEOUT_MS}`, ...args];
  }
}

function normalizeMessagePageLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) {
    return DEFAULT_MESSAGE_PAGE_LIMIT;
  }
  return Math.max(1, Math.min(MAX_MESSAGE_PAGE_LIMIT, Math.floor(limit as number)));
}

function sqliteBoolean(value: number | string | boolean | null | undefined): boolean {
  return value === 1 || value === "1" || value === true || value === "true";
}

function isStoredChatParticipant(value: unknown): value is ChatParticipant {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { handle?: unknown }).handle === "string"
  );
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

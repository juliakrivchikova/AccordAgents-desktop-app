import { mkdir } from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import { runCommand } from "./command";
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
const INFERRED_REQUEST_THREAD_MIGRATION_KEY = "inferred-participant-request-threads-v1";

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

export class StorageService {
  private readonly dbPath: string;
  private initialized = false;

  constructor() {
    this.dbPath = path.join(app.getPath("userData"), "accordagents.sqlite3");
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
    `);
    await this.ensureColumn("conversations", "body_json", "text");
    await this.backfillConversationBodiesAndMessages();
    this.initialized = true;
    await this.normalizeInferredParticipantRequestThreads();
    await this.clearInterruptedRuns();
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
      bodyJson: string;
    }>(
      `select
         id,
         coalesce(nullif(body_json, ''), json_set(payload_json, '$.messages', json_array())) as bodyJson
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
      try {
        const conversation = JSON.parse(row.bodyJson) as Conversation;
        conversation.metadata = clearLegacyAccordState(conversation.metadata);
        conversation.messages = [];
        sanitizeConversationWarnings(conversation);
        conversationsById.set(conversation.id, conversation);
      } catch {
        continue;
      }
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
      try {
        conversation.messages.push(JSON.parse(row.payloadJson) as ChatMessage);
      } catch {
        continue;
      }
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
    const rows = await this.queryJson<{ sequence: number; payloadJson: string }>(
      `
        select sequence, payload_json as payloadJson
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
      messages: selectedRows.map((row) => JSON.parse(row.payloadJson) as ChatMessage),
      oldestSequence: selectedRows[0]?.sequence,
      newestSequence: selectedRows[selectedRows.length - 1]?.sequence,
      hasMoreBefore: rows.length > limit,
      totalMessages: countRows[0]?.totalMessages ?? selectedRows.length
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
  ): Promise<{ conversationId: string; sequence: number; payloadJson: string }[]> {
    const idList = sqlStringList(conversationIds);
    const pendingRows = await this.queryJson<{ conversationId: string; sequence: number; payloadJson: string }>(
      `
        select conversation_id as conversationId, sequence, payload_json as payloadJson
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
    const pendingParticipantRows = await this.queryJson<{ conversationId: string; sequence: number; payloadJson: string }>(
      `
        select conversation_id as conversationId, sequence, payload_json as payloadJson
        from conversation_messages
        where conversation_id in ${idList}
          and json_extract(payload_json, '$.role') = 'participant'
          and json_extract(payload_json, '$.status') = 'pending'
          and json_extract(payload_json, '$.metadata.runId') is not null
        order by created_at desc
        limit ${Math.max(DEFAULT_CHAT_ACTIVITY_LIMIT, conversationLimit * 2)};
      `
    );
    const participantRows = await this.queryJson<{ conversationId: string; sequence: number; payloadJson: string }>(
      `
        select conversation_id as conversationId, sequence, payload_json as payloadJson
        from conversation_messages
        where conversation_id in ${idList}
          and json_extract(payload_json, '$.role') = 'participant'
          and json_extract(payload_json, '$.status') = 'done'
        order by created_at desc
        limit ${Math.max(DEFAULT_CHAT_ACTIVITY_LIMIT, conversationLimit * 8)};
      `
    );
    const approvalContextRows = approvalConversationIds.length > 0
      ? await this.queryJson<{ conversationId: string; sequence: number; payloadJson: string }>(
        `
          select conversationId, sequence, payloadJson
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
      ? await this.queryJson<{ conversationId: string; sequence: number; payloadJson: string }>(
        `
          select conversation_id as conversationId, sequence, payload_json as payloadJson
          from conversation_messages
          where (conversation_id, message_id) in ${sqlStringPairList(approvalTriggerTargets)};
        `
      )
      : [];
    const activitySourceTargets = [...pendingRows, ...pendingParticipantRows, ...approvalTriggerRows].flatMap((row) => {
      try {
        const message = JSON.parse(row.payloadJson) as ChatMessage;
        const ids = [message.metadata?.sourceMessageId, message.metadata?.parentMessageId, message.metadata?.chatThreadRootId]
          .flatMap((value) => typeof value === "string" && value.trim() ? [value.trim()] : []);
        return [...new Set(ids)].map((messageId) => [row.conversationId, messageId] as [string, string]);
      } catch {
        return [];
      }
    });
    const activitySourceRows = activitySourceTargets.length > 0
      ? await this.queryJson<{ conversationId: string; sequence: number; payloadJson: string }>(
        `
          select conversation_id as conversationId, sequence, payload_json as payloadJson
          from conversation_messages
          where (conversation_id, message_id) in ${sqlStringPairList(activitySourceTargets)};
        `
      )
      : [];
    const byKey = new Map<string, { conversationId: string; sequence: number; payloadJson: string }>();
    for (const row of [
      ...pendingRows,
      ...pendingParticipantRows,
      ...participantRows,
      ...approvalContextRows,
      ...approvalTriggerRows,
      ...activitySourceRows
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
    const result = await runCommand("sqlite3", this.sqliteArgs(["-json", this.dbPath, sql]), {
      timeoutMs: SQLITE_COMMAND_TIMEOUT_MS,
      primeLoginShellEnv: false
    });
    const text = result.stdout.trim();
    return text ? (JSON.parse(text) as T[]) : [];
  }

  private async queryText(sql: string): Promise<string> {
    const result = await runCommand("sqlite3", this.sqliteArgs(["-batch", "-noheader", this.dbPath, sql]), {
      timeoutMs: SQLITE_COMMAND_TIMEOUT_MS,
      primeLoginShellEnv: false
    });
    return result.stdout.trim();
  }

  private async runSql(sql: string, timeoutMs = SQLITE_COMMAND_TIMEOUT_MS): Promise<void> {
    await runCommand("sqlite3", this.sqliteArgs([this.dbPath]), { input: sql, timeoutMs, primeLoginShellEnv: false });
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

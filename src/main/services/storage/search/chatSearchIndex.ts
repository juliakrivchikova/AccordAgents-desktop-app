import type { ChatMessage, Conversation } from "../../../../shared/types";
import type { ChatSearchDocument } from "../../../../shared/chatSearchDocuments";
import { sanitizeConversationWarnings } from "../../../../shared/warnings";
import { SQLITE_MIGRATION_TIMEOUT_MS } from "../constants";
import { clearLegacyAccordState, isStoredChatParticipant } from "../conversations/conversationBody";
import { CHAT_SEARCH_INDEX_META_KEY, CHAT_SEARCH_INDEX_VERSION } from "../database/schemaVersion";
import { parseHexJson, parseHexText, sqliteBoolean, sqlString, sqlStringList } from "../database/sqlText";
import {
  type ChatSearchConversationRead, type ChatSearchConversationSnapshot, type ChatSearchDocumentReplacement,
  type ChatSearchIndexState, InvalidChatSearchSourceError, type StoredChatSearchQueryResult
} from "./types";
import type { StorageModules } from "../modules";

/** The index chat search looks in. */
export class ChatSearchIndex {
  private chatSearchIndexReady = false;

  constructor(private readonly storage: Pick<StorageModules, "schema" | "sqlite">) {}

  async listChatSearchConversationSnapshots(options: { includeParticipants?: boolean } = {}): Promise<ChatSearchConversationSnapshot[]> {
    await this.storage.schema.init();
    const includeParticipants = options.includeParticipants !== false;
    const rows = await this.storage.sqlite.queryJson<{
      conversationId: string;
      title: string;
      repoPath?: string;
      archived?: number | string | boolean | null;
      updatedAt: string;
      messageCount: number | string;
      oldestMessageAt?: string | null;
      newestMessageAt?: string | null;
      participantsHex?: string;
      mainSessionParticipantId?: string | null;
      chatView?: string | null;
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
        case when json_valid(c.source_json) then json_extract(c.source_json, '$.metadata.mainSessionParticipantId') end as mainSessionParticipantId,
        case when json_valid(c.source_json) then json_extract(c.source_json, '$.metadata.chatView') end as chatView,
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
          ...(typeof row.mainSessionParticipantId === "string" && row.mainSessionParticipantId ? { mainSessionParticipantId: row.mainSessionParticipantId } : {}),
          ...(typeof row.chatView === "string" && row.chatView ? { chatView: row.chatView } : {}),
          sourceReadable
        };
      } catch (error) {
        throw new InvalidChatSearchSourceError(row.conversationId, error);
      }
    });
  }

  async readChatSearchConversation(conversationId: string): Promise<Conversation | undefined> {
    await this.storage.schema.init();
    const rows = await this.chatSearchSourceRows([conversationId]);
    const body = rows.find(isBodyRow);
    if (!body) {
      return undefined;
    }
    return searchedConversation(conversationId, body, rows);
  }

  /** The chats' rows as search reads them: each chat's body once, then its
   *  messages without what search does not look in (a reply's stream and its
   *  steps are most of a chat's bytes). With the chat's columns repeated on
   *  every message, 24 chats outgrew what a string can hold (2026-11-25). */
  private chatSearchSourceRows(conversationIds: string[]): Promise<ChatSearchSourceRow[]> {
    const ids = sqlStringList(conversationIds);
    const body = "coalesce(nullif(c.body_json, ''), c.payload_json)";
    return this.storage.sqlite.queryJson<ChatSearchSourceRow>(`
      select * from (
        select
          'body' as rowKind,
          c.id as conversationId,
          -1 as sequence,
          c.title as title,
          c.repo_path as repoPath,
          case when json_valid(${body}) then json_extract(${body}, '$.metadata.archived') end as archived,
          c.updated_at as updatedAt,
          (select count(*) from conversation_messages m where m.conversation_id = c.id) as messageCount,
          (select min(m.created_at) from conversation_messages m where m.conversation_id = c.id) as oldestMessageAt,
          (select max(m.created_at) from conversation_messages m where m.conversation_id = c.id) as newestMessageAt,
          json_valid(${body}) as payloadValid,
          case when json_valid(${body}) then hex(json_set(${body}, '$.messages', json_array())) else '' end as payloadHex
        from conversations c
        where c.kind = 'chat' and c.id in ${ids}
        union all
        select
          'message', conversation_id, sequence, null, null, null, null, null, null, null, null,
          hex(case when json_valid(payload_json)
            then json_remove(payload_json, '$.metadata.processingTranscript', '$.metadata.activityEvents') else payload_json end)
        from conversation_messages
        where conversation_id in ${ids}
      )
      order by conversationId, sequence;
    `);
  }

  async readChatSearchConversations(conversationIds: string[]): Promise<ChatSearchConversationRead[]> {
    await this.storage.schema.init();
    if (conversationIds.length === 0) {
      return [];
    }
    const rows = await this.chatSearchSourceRows(conversationIds);
    const rowsByConversation = new Map<string, typeof rows>();
    for (const row of rows) {
      const grouped = rowsByConversation.get(row.conversationId) ?? [];
      grouped.push(row);
      rowsByConversation.set(row.conversationId, grouped);
    }
    return conversationIds.flatMap((conversationId) => {
      const conversationRows = rowsByConversation.get(conversationId);
      const body = conversationRows?.find(isBodyRow);
      if (!body) {
        return [];
      }
      if (!sqliteBoolean(body.payloadValid)) {
        throw new InvalidChatSearchSourceError(conversationId);
      }
      try {
        const conversation = searchedConversation(conversationId, body, conversationRows ?? []);
        const participants = conversation.metadata.participants;
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
            participants: (Array.isArray(participants) ? participants : []).filter(isStoredChatParticipant)
          },
          conversation
        }];
      } catch (error) {
        throw new InvalidChatSearchSourceError(conversationId, error);
      }
    });
  }

  async ensureChatSearchIndex(): Promise<void> {
    await this.storage.schema.init();
    if (this.chatSearchIndexReady) {
      return;
    }
    const valid = await this.chatSearchIndexIsValid().catch(() => false);
    if (!valid) {
      await this.rebuildChatSearchIndex();
      return;
    }
    try {
      await this.storage.sqlite.runSql("insert into chat_search_fts(chat_search_fts) values('integrity-check');");
      this.chatSearchIndexReady = true;
    } catch {
      await this.rebuildChatSearchIndex();
    }
  }

  async rebuildChatSearchIndex(): Promise<void> {
    await this.storage.schema.init();
    this.chatSearchIndexReady = false;
    await this.storage.sqlite.runSql(`
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
    const rows = await this.storage.sqlite.queryJson<{
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
    const rows = await this.storage.sqlite.queryJson<{
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
    await this.storage.sqlite.runSql(`
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
    await this.storage.sqlite.runSql(`
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
    const rows = await this.storage.sqlite.queryJson<{
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
}

interface ChatSearchBodyRow {
  rowKind: "body";
  conversationId: string;
  title: string;
  repoPath?: string | null;
  archived?: number | string | boolean | null;
  updatedAt: string;
  messageCount: number | string;
  oldestMessageAt?: string | null;
  newestMessageAt?: string | null;
  payloadValid: number | string;
  payloadHex: string;
}

interface ChatSearchMessageRow {
  rowKind: "message";
  conversationId: string;
  sequence: number;
  payloadHex: string;
}

type ChatSearchSourceRow = ChatSearchBodyRow | ChatSearchMessageRow;

function isBodyRow(row: ChatSearchSourceRow): row is ChatSearchBodyRow {
  return row.rowKind === "body";
}

function searchedConversation(conversationId: string, body: ChatSearchBodyRow, rows: readonly ChatSearchSourceRow[]): Conversation {
  const conversation = parseHexJson<Conversation>(body.payloadHex, `chat search conversation ${conversationId}`);
  conversation.metadata = clearLegacyAccordState(conversation.metadata);
  conversation.messages = rows.flatMap((row) => row.rowKind === "message"
    ? [parseHexJson<ChatMessage>(row.payloadHex, `chat search message ${conversationId}:${row.sequence}`)]
    : []);
  sanitizeConversationWarnings(conversation);
  return conversation;
}

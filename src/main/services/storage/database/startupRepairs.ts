import { clearChatRunMetadata, clearParticipantCompactions, readParticipantCompactions } from "../../../../shared/chatRunState";
import {
  normalizeInferredParticipantRequestThreads as normalizeInferredParticipantRequestThreadMetadata
} from "../../../../shared/chatParticipantRequestThreads";
import { SQLITE_MIGRATION_TIMEOUT_MS } from "../constants";
import { nonTerminalRemoteRunIds, withRemoteRunMetadata } from "../conversations/conversationBody";
import {
  LEGACY_BODY_TABLES, LEGACY_CLIENT_STATE_KEYS, LEGACY_DROP_BATCH_ROWS, LEGACY_DROP_PAUSE_MS, LEGACY_EVENT_TABLES,
  LEGACY_META_KEYS
} from "./legacyTables";
import { INFERRED_REQUEST_THREAD_MIGRATION_KEY, SCHEMA_META_COMPLETE } from "./schemaVersion";
import { sqlStringList } from "./sqlText";
import type { StorageModules } from "../modules";

/** What is put right in an existing database when the app starts. */
export class StartupRepairs {
  constructor(private readonly storage: Pick<StorageModules, "conversationLists" | "conversationReads" | "conversationSaves" | "schema" | "sqlite">) {}

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
  async dropLegacyEventTables(options: {
    keepBodies: boolean;
    signal?: AbortSignal;
    log?: (event: string, payload: Record<string, unknown>) => void;
    batchRows?: number;
    pauseMs?: number;
  }): Promise<{ tables: string[]; rows: number; done: boolean }> {
    await this.storage.schema.init();
    const wanted = [...LEGACY_EVENT_TABLES, ...(options.keepBodies ? [] : LEGACY_BODY_TABLES)];
    const present = new Set((await this.storage.sqlite.queryJson<{ name: string }>(
      `select name from sqlite_master where type = 'table' and name in ${sqlStringList(wanted)};`
    )).map((row) => row.name));
    const batch = Math.max(1, Math.floor(options.batchRows ?? LEGACY_DROP_BATCH_ROWS));
    const pauseMs = Math.max(0, Math.floor(options.pauseMs ?? LEGACY_DROP_PAUSE_MS));
    const started = Date.now();
    const dropped: string[] = [];
    let rows = 0;
    const stopped = (): boolean => options.signal?.aborted === true;
    for (const table of wanted) {
      if (!present.has(table)) continue;
      for (;;) {
        if (stopped()) return { tables: dropped, rows, done: false };
        const [result] = await this.storage.sqlite.queryJson<{ deleted: number }>(
          `delete from ${table} where rowid in (select rowid from ${table} limit ${batch}); select changes() as deleted;`
        );
        const deleted = Number(result?.deleted ?? 0) || 0;
        rows += deleted;
        if (deleted < batch) break;
        await new Promise((resolve) => setTimeout(resolve, pauseMs));
      }
      await this.storage.sqlite.runSql(`drop table if exists ${table};`);
      dropped.push(table);
    }
    // What this device kept about where it stood in the old order.
    await this.storage.sqlite.runSql(`
      delete from schema_meta where key in ${sqlStringList(LEGACY_META_KEYS)};
      delete from hub_client_state where key in ${sqlStringList(LEGACY_CLIENT_STATE_KEYS)};
    `).catch(() => undefined);
    if (dropped.length > 0) {
      options.log?.("storage.legacy-tables.dropped", { tables: dropped, rows, ms: Date.now() - started });
    }
    return { tables: dropped, rows, done: true };
  }

  async backfillConversationBodiesAndMessages(): Promise<void> {
    await this.storage.sqlite.runSql(`
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

  async clearInterruptedRuns(): Promise<void> {
    // Run state lives in conversation metadata, which is what `body_json` holds.
    // The legacy full payload is only consulted for rows written before the
    // split; searching it for current rows would match a frozen copy and act on
    // state that is no longer true.
    const runMarkers = ["\"running\":true", "\"activeRunIds\":[", "\"participantCompactionsByParticipantId\":"];
    const ids = await this.storage.conversationLists.queryConversationIds(
      runMarkers.map((marker) =>
        `coalesce(nullif(body_json, ''), payload_json) like '%${marker}%'`
      ).join(" or ")
    );
    for (const id of ids) {
      const conversation = await this.storage.conversationReads.readWholeConversation(id);
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
        await this.storage.conversationSaves.saveConversation(conversation);
        continue;
      }
    }
  }

  async normalizeInferredParticipantRequestThreads(): Promise<void> {
    const completed = await this.storage.sqlite.getSchemaMeta(INFERRED_REQUEST_THREAD_MIGRATION_KEY);
    if (completed === SCHEMA_META_COMPLETE) {
      return;
    }

    // This marker sits in message metadata, not conversation metadata, so it is
    // not in `body_json` at all — the message rows are where it has to be looked
    // for. Rows written before the split have no body and no message rows yet,
    // so their legacy payload is still searched.
    const ids = await this.storage.conversationLists.queryConversationIds(
      `exists (
        select 1 from conversation_messages m
        where m.conversation_id = conversations.id and m.payload_json like '%"source":"inferred"%'
      ) or (coalesce(body_json, '') = '' and payload_json like '%"source":"inferred"%')`
    );
    for (const id of ids) {
      const conversation = await this.storage.conversationReads.readWholeConversation(id);
      if (!conversation) {
        continue;
      }
      if (!normalizeInferredParticipantRequestThreadMetadata(conversation)) {
        continue;
      }
      await this.storage.conversationSaves.saveConversation(conversation);
    }
    await this.storage.sqlite.setSchemaMeta(INFERRED_REQUEST_THREAD_MIGRATION_KEY, SCHEMA_META_COMPLETE);
  }
}

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { NATIVE_COMMAND_SCHEMA_SQL } from "../../nativeCommandStore";
import { MACHINE_POWER_SCHEMA } from "../../machinePowerStore";
import { pendingReplyRowHintSql, SQLITE_MIGRATION_TIMEOUT_MS } from "../constants";
import {
  parseStorageSchemaVersion, STORAGE_SCHEMA_VERSION_META_KEY, SUPPORTED_STORAGE_SCHEMA_VERSION,
  UnsupportedStorageSchemaVersionError
} from "./schemaVersion";
import type { StorageModules } from "../modules";
import type { StorageDependencies } from "../dependencies";

/** Sets the database up and brings an older one up to date. */
export class Schema {
  private initialized = false;
  /** The one set-up under way: callers that arrive while it runs wait for
   *  it instead of starting a second one, which on a new database would add
   *  the same column twice and stop the app from starting. */
  private initializing?: Promise<void>;

  constructor(
    private readonly storage: Pick<StorageModules, "backups" | "runCancels" | "sqlite" | "startupRepairs">,
    private readonly deps: Pick<StorageDependencies, "dbPath">
  ) {}

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }
    if (!this.initializing) {
      // A set-up that fails is tried again by the next caller.
      this.initializing = this.runInit().finally(() => {
        this.initializing = undefined;
      });
    }
    return this.initializing;
  }

  private async runInit(): Promise<void> {
    await mkdir(path.dirname(this.deps.dbPath), { recursive: true });
    await this.ensureSchemaMetaTable();
    await this.assertSupportedSchemaVersion();
    await this.configureSqliteRuntime();
    await this.storage.sqlite.runSql(`
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
      -- A chat the owner deleted. Kept after the rows are gone, because a
      -- snapshot already in flight would otherwise write it back: the copy
      -- has no way to tell "new" from "stale" without a record of the absence.
      create table if not exists deleted_conversations (
        conversation_id text primary key,
        deleted_at text not null
      );
      -- Enforce absence inside the write transaction, including stale writers
      -- in other processes and snapshots queued before deletion started.
      create trigger if not exists deleted_conversation_insert before insert on conversations
        when exists (select 1 from deleted_conversations where conversation_id = new.id)
        begin select raise(abort, 'Chat was permanently deleted.'); end;
      create trigger if not exists deleted_conversation_update before update on conversations
        when exists (select 1 from deleted_conversations where conversation_id = new.id)
        begin select raise(abort, 'Chat was permanently deleted.'); end;
      create trigger if not exists deleted_message_insert before insert on conversation_messages
        when exists (select 1 from deleted_conversations where conversation_id = new.conversation_id)
        begin select raise(abort, 'Chat was permanently deleted.'); end;
      create trigger if not exists deleted_message_update before update on conversation_messages
        when exists (select 1 from deleted_conversations where conversation_id = new.conversation_id)
        begin select raise(abort, 'Chat was permanently deleted.'); end;
      ${NATIVE_COMMAND_SCHEMA_SQL}
      ${MACHINE_POWER_SCHEMA}
      -- Where each relay mailbox was read to, from before the relay was removed.
      drop table if exists device_event_mailbox_cursors;
    `);
    await this.storage.runCancels.pruneStaleRunCancelRequests();
    await this.ensureColumn("conversations", "body_json", "text");
    await this.ensureColumn("conversations", "save_token", "text");
    // The few message rows that may be a member's reply not ended yet, so the
    // chat list finds them without reading every message (listConversations).
    // Built once over the existing rows; sqlite keeps it on every write after.
    await this.storage.sqlite.runSql(
      `create index if not exists idx_conversation_messages_pending_reply on conversation_messages(conversation_id)
         where ${pendingReplyRowHintSql("payload_json")};`,
      SQLITE_MIGRATION_TIMEOUT_MS
    );
    await this.storage.startupRepairs.backfillConversationBodiesAndMessages();
    await this.storage.backups.backUpBeforeSchemaUpgrade();
    await this.storage.sqlite.setSchemaMeta(STORAGE_SCHEMA_VERSION_META_KEY, String(SUPPORTED_STORAGE_SCHEMA_VERSION));
    this.initialized = true;
    await this.storage.startupRepairs.normalizeInferredParticipantRequestThreads();
    await this.storage.startupRepairs.clearInterruptedRuns();
  }

  private async ensureColumn(table: string, column: string, definition: string): Promise<void> {
    const rows = await this.storage.sqlite.queryJson<{ name: string }>(`pragma table_info(${table});`);
    if (rows.some((row) => row.name === column)) {
      return;
    }
    await this.storage.sqlite.runSql(`alter table ${table} add column ${column} ${definition};`);
  }

  private async ensureSchemaMetaTable(): Promise<void> {
    await this.storage.sqlite.runSql(`
      create table if not exists schema_meta (
        key text primary key,
        value text not null
      );
    `);
  }

  private async configureSqliteRuntime(): Promise<void> {
    const journalMode = (await this.storage.sqlite.queryText("pragma journal_mode = wal;")).toLowerCase();
    if (journalMode && journalMode !== "wal") {
      console.warn(`[StorageService] SQLite journal_mode=wal requested, got ${journalMode}.`);
    }
  }

  private async assertSupportedSchemaVersion(): Promise<void> {
    const storedVersion = parseStorageSchemaVersion(await this.storage.sqlite.getSchemaMeta(STORAGE_SCHEMA_VERSION_META_KEY));
    if (storedVersion !== undefined && storedVersion > SUPPORTED_STORAGE_SCHEMA_VERSION) {
      throw new UnsupportedStorageSchemaVersionError(storedVersion, SUPPORTED_STORAGE_SCHEMA_VERSION);
    }
  }
}

import { SQLITE_MIGRATION_TIMEOUT_MS } from "../constants";
import {
  parseStorageSchemaVersion, PREVIOUS_STORAGE_SCHEMA_VERSION, STORAGE_SCHEMA_VERSION_META_KEY, SUPPORTED_STORAGE_SCHEMA_VERSION
} from "./schemaVersion";
import { sqlString } from "./sqlText";
import type { StorageModules } from "../modules";
import type { StorageDependencies } from "../dependencies";

/** Copies of the database made before it changes shape. */
export class Backups {
  constructor(
    private readonly storage: Pick<StorageModules, "conversationSaves" | "schema" | "sqlite">,
    private readonly deps: Pick<StorageDependencies, "dbPath">
  ) {}

  /** Puts this database back into the shape an older build can open: the full
   *  conversation copy is rebuilt from the body and the message rows, and the
   *  schema version is lowered again. Nothing is deleted — the body and the
   *  message rows stay exactly as they are, so running the current build again
   *  afterwards simply raises the version back. This is the supported way to go
   *  back to a previous version of the app; without it, raising the schema
   *  version would be a one-way door. */
  async prepareStorageForOlderVersion(): Promise<{ conversations: number; schemaVersion: number }> {
    await this.storage.schema.init();
    const rows = await this.storage.sqlite.queryJson<{ total: number }>("select count(*) as total from conversations;");
    await this.storage.sqlite.runSql(`
      begin immediate;
      update conversations
      set payload_json = json_set(
        coalesce(nullif(body_json, ''), payload_json),
        '$.messages',
        coalesce(
          (
            select json_group_array(json(ordered.message_json))
            from (
              select m.payload_json as message_json
              from conversation_messages m
              where m.conversation_id = conversations.id
              order by m.sequence
            ) as ordered
          ),
          json_array()
        )
      )
      where json_valid(coalesce(nullif(body_json, ''), payload_json));
      commit;
    `, SQLITE_MIGRATION_TIMEOUT_MS);
    await this.storage.sqlite.setSchemaMeta(STORAGE_SCHEMA_VERSION_META_KEY, String(PREVIOUS_STORAGE_SCHEMA_VERSION));
    // Anything this process believed about the rows it wrote is meaningless to
    // the build that opens the database next.
    this.storage.conversationSaves.savedMessageState.clear();
    return { conversations: rows[0]?.total ?? 0, schemaVersion: PREVIOUS_STORAGE_SCHEMA_VERSION };
  }

  async createPreMigrationBackup(label: string): Promise<string> {
    await this.storage.schema.init();
    return this.backUpDatabaseTo(label);
  }

  private async backUpDatabaseTo(label: string): Promise<string> {
    const safeLabel = label.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    if (!safeLabel) {
      throw new Error("Pre-migration backup label is required.");
    }
    const backupPath = `${this.deps.dbPath}.${safeLabel}.bak`;
    await this.storage.sqlite.runSql(`vacuum into ${sqlString(backupPath)};`, SQLITE_MIGRATION_TIMEOUT_MS);
    return backupPath;
  }

  /** Raising the schema version is what stops an older build from destroying
   *  this database, but it also means that build can no longer open it. A copy
   *  taken the moment before the version rises is the floor under that: whatever
   *  goes wrong afterwards, the database as the previous version left it is
   *  still on disk, next to the live one. Taken once — a second upgrade of an
   *  already-upgraded database finds the version unchanged and does nothing. */
  async backUpBeforeSchemaUpgrade(): Promise<void> {
    const storedVersion = parseStorageSchemaVersion(await this.storage.sqlite.getSchemaMeta(STORAGE_SCHEMA_VERSION_META_KEY));
    if (storedVersion === undefined || storedVersion >= SUPPORTED_STORAGE_SCHEMA_VERSION) {
      return;
    }
    try {
      // Deliberately not `createPreMigrationBackup`: this runs from inside
      // `init`, and that method starts by awaiting `init` itself, which would
      // re-enter it before `initialized` is set and never return.
      const backupPath = await this.backUpDatabaseTo(`schema-${storedVersion}`);
      console.info(`[StorageService] Backed up the chat database before upgrading it to schema ${SUPPORTED_STORAGE_SCHEMA_VERSION}: ${backupPath}`);
    } catch (error) {
      // A missing backup must not stop the app from opening. It is a safety net,
      // and the upgrade itself is not destructive — the old copy is what the
      // user loses the option of, not their data.
      console.warn(`[StorageService] Could not back up the chat database before the schema upgrade: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

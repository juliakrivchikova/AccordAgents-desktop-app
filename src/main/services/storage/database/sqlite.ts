import { SqliteSession } from "../../sqliteSession";
import { sqlString } from "./sqlText";
import type { StorageModules } from "../modules";
import type { StorageDependencies } from "../dependencies";

const SQLITE_BUSY_TIMEOUT_MS = 30_000;
const SQLITE_COMMAND_TIMEOUT_MS = 45_000;

/** The database itself: every read and write goes through here. */
export class Sqlite {
  private sqliteSession?: SqliteSession;

  constructor(
    private readonly storage: Pick<StorageModules, "schema">,
    private readonly deps: Pick<StorageDependencies, "dbPath" | "sqliteExecutable">
  ) {}

  /** This database through its own session, for a store whose tables live
   *  here too (the server's documents), so its changes and the server's
   *  order can commit together. */
  sqlExecutor(): { path: string; queryJson<T>(sql: string): Promise<T[]>; queryText(sql: string): Promise<string>; runSql(sql: string): Promise<void> } {
    return {
      path: this.deps.dbPath,
      queryJson: async <T>(sql: string) => {
        await this.storage.schema.init();
        return this.queryJson<T>(sql);
      },
      queryText: async (sql: string) => {
        await this.storage.schema.init();
        return this.queryText(sql);
      },
      runSql: async (sql: string) => {
        await this.storage.schema.init();
        await this.runSql(sql);
      }
    };
  }

  async getSchemaMeta(key: string): Promise<string | undefined> {
    const value = await this.queryText(`select value from schema_meta where key = ${sqlString(key)} limit 1;`);
    return value || undefined;
  }

  async setSchemaMeta(key: string, value: string): Promise<void> {
    await this.runSql(`
      insert into schema_meta (key, value)
      values (${sqlString(key)}, ${sqlString(value)})
      on conflict(key) do update set value = excluded.value;
    `);
  }

  async queryJson<T>(sql: string): Promise<T[]> {
    const text = (await this.databaseSession().run(sql, "json", SQLITE_COMMAND_TIMEOUT_MS)).trim();
    return text ? (JSON.parse(text) as T[]) : [];
  }

  async queryText(sql: string): Promise<string> {
    return (await this.databaseSession().run(sql, "list", SQLITE_COMMAND_TIMEOUT_MS)).trim();
  }

  async runSql(sql: string, timeoutMs = SQLITE_COMMAND_TIMEOUT_MS): Promise<void> {
    await this.databaseSession().run(sql, "list", timeoutMs);
  }

  private databaseSession(): SqliteSession {
    return this.sqliteSession ??= new SqliteSession(this.deps.sqliteExecutable ?? "sqlite3", this.deps.dbPath, SQLITE_BUSY_TIMEOUT_MS);
  }
}

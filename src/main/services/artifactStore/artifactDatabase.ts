import { mkdir } from "node:fs/promises";
import path from "node:path";
import { runCommand } from "../command";
import { migrateArtifactRevisions } from "../artifactRevisions";
import { SQLITE_BUSY_TIMEOUT_MS, SQLITE_COMMAND_TIMEOUT_MS } from "./sqlText";
import type { ArtifactStoreDependencies } from "./dependencies";

const initByPath = new Map<string, Promise<void>>();

/** The documents' tables and how they are read and written. */
export class ArtifactDatabase {
  private initialized = false;

  constructor(private readonly deps: Pick<ArtifactStoreDependencies, "dbPath" | "executor" | "sqliteExecutable">) {}

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }
    const pending = initByPath.get(this.deps.dbPath);
    if (pending) {
      await pending;
      this.initialized = true;
      return;
    }
    const initialization = this.initialize();
    initByPath.set(this.deps.dbPath, initialization);
    try {
      await initialization;
      this.initialized = true;
    } finally {
      if (initByPath.get(this.deps.dbPath) === initialization) {
        initByPath.delete(this.deps.dbPath);
      }
    }
  }

  private async initialize(): Promise<void> {
    await mkdir(path.dirname(this.deps.dbPath), { recursive: true });
    await this.runSql(`
      create table if not exists artifacts (
        id text primary key,
        conversation_id text not null,
        name text not null,
        name_key text not null,
        owner text not null,
        contributors_json text not null,
        required_signers_json text not null,
        labels_json text not null,
        head_version integer not null,
        created_at text not null,
        updated_at text not null,
        archived_at text
      );
      create unique index if not exists idx_artifacts_conversation_name_key on artifacts(conversation_id, name_key);
      create index if not exists idx_artifacts_conversation_updated on artifacts(conversation_id, updated_at);
      create table if not exists artifact_versions (
        artifact_id text not null,
        version integer not null,
        content text not null,
        author text not null,
        note text,
        created_at text not null,
        primary key (artifact_id, version)
      );
      create table if not exists artifact_signatures (
        artifact_id text not null,
        version integer not null,
        signer text not null,
        signed_at text not null,
        primary key (artifact_id, version, signer)
      );
    `);
    const additions = [
      ["lifecycle", "alter table artifacts add column lifecycle text not null default 'published';"],
      ["allowed_draft_authors_json", "alter table artifacts add column allowed_draft_authors_json text not null default '[]';"],
      ["required_draft_authors_json", "alter table artifacts add column required_draft_authors_json text not null default '[]';"],
      ["audience_policy_json", "alter table artifacts add column audience_policy_json text not null default '{}';"],
      ["draft_roster_revision", "alter table artifacts add column draft_roster_revision integer not null default 0;"],
      ["archived_at", "alter table artifacts add column archived_at text;"],
      ["origin_message_id", "alter table artifacts add column origin_message_id text;"]
    ] as const;
    for (const [name, sql] of additions) {
      await this.ensureArtifactColumn(name, sql);
    }
    await this.runSql(`
      begin immediate;
      create table if not exists artifact_drafts (
        id text primary key,
        artifact_id text not null,
        author text not null,
        state text not null,
        content text not null,
        readers_json text not null,
        edit_revision integer not null,
        supersedes_draft_id text,
        created_at text not null,
        updated_at text not null,
        submitted_at text
      );
      create index if not exists idx_artifact_drafts_artifact on artifact_drafts(artifact_id, created_at);
      create unique index if not exists idx_artifact_drafts_one_editing
        on artifact_drafts(artifact_id, author) where state = 'editing';
      create table if not exists artifact_version_sources (
        artifact_id text not null,
        version integer not null,
        draft_id text not null,
        author text not null,
        submitted_at text not null,
        content_hash text not null,
        disposition text not null,
        exclusion_rationale text,
        primary key (artifact_id, version, draft_id)
      );
      create table if not exists artifact_operations (
        conversation_id text not null,
        artifact_id text,
        actor text not null,
        operation_kind text not null,
        operation_id text not null,
        request_hash text not null,
        result_json text not null,
        applied integer not null default 0,
        created_at text not null,
        primary key (conversation_id, actor, operation_kind, operation_id)
      );
      create table if not exists artifact_event_outbox (
        id text primary key,
        conversation_id text not null,
        artifact_id text not null,
        kind text not null,
        actor text not null,
        content text not null,
        created_at text not null,
        delivered_at text
      );
      create index if not exists idx_artifact_outbox_pending on artifact_event_outbox(delivered_at, created_at);
      create table if not exists artifact_conversation_tombstones (
        conversation_id text primary key,
        deleted_at text not null
      );
      commit;
    `);
    await migrateArtifactRevisions({ query: <T>(sql: string) => this.queryJson<T>(sql), execute: sql => this.runSql(sql) });
    // Documents are the server's (Д7): the fold of document events each device
    // kept before is gone with that scheme.
    await this.runSql("drop table if exists artifact_state_events;");
  }

  private async ensureArtifactColumn(name: string, sql: string): Promise<void> {
    const hasColumn = async (): Promise<boolean> => {
      const columns = await this.queryJson<{ name: string }>("pragma table_info(artifacts);");
      return columns.some((column) => column.name === name);
    };
    if (await hasColumn()) {
      return;
    }
    try {
      await this.runSql(sql);
    } catch (error) {
      // Another app process may have added the column after our PRAGMA read.
      // SQLite has no `add column if not exists`, so re-read before failing.
      if (!(await hasColumn())) {
        throw error;
      }
    }
  }

  async queryJson<T>(sql: string): Promise<T[]> {
    if (this.deps.executor) return this.deps.executor.queryJson<T>(sql);
    const result = await runCommand(this.deps.sqliteExecutable, this.sqliteArgs(["-json", this.deps.dbPath]), {
      input: sql,
      timeoutMs: SQLITE_COMMAND_TIMEOUT_MS,
      primeLoginShellEnv: false
    });
    const text = result.stdout.trim();
    return text ? (JSON.parse(text) as T[]) : [];
  }

  async queryText(sql: string): Promise<string> {
    if (this.deps.executor) return (await this.deps.executor.queryText(sql)).trim();
    const result = await runCommand(this.deps.sqliteExecutable, this.sqliteArgs(["-batch", "-noheader", this.deps.dbPath]), {
      input: sql,
      timeoutMs: SQLITE_COMMAND_TIMEOUT_MS,
      primeLoginShellEnv: false
    });
    return result.stdout.trim();
  }

  async runSql(sql: string): Promise<void> {
    if (this.deps.executor) return this.deps.executor.runSql(sql);
    await runCommand(this.deps.sqliteExecutable, this.sqliteArgs([this.deps.dbPath]), {
      input: sql,
      timeoutMs: SQLITE_COMMAND_TIMEOUT_MS,
      primeLoginShellEnv: false
    });
  }

  private sqliteArgs(args: string[]): string[] {
    // sqlite3 otherwise continues executing later statements after an error.
    // In a multi-statement transaction that can reach COMMIT after an outbox
    // insert failed, making an apparently rejected mutation partially durable.
    // Bail closes the connection with the transaction still open, so SQLite
    // rolls the whole transaction back.
    return ["-bail", "-cmd", `.timeout ${SQLITE_BUSY_TIMEOUT_MS}`, "-cmd", "pragma synchronous = FULL;", ...args];
  }
}

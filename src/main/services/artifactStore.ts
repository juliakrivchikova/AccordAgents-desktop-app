import { mkdir } from "node:fs/promises";
import path from "node:path";
import { runCommand } from "./command";
import { artifactRevision, migrateArtifactRevisions, revisionInsertSql, revisionProjectionInsertSql, type ArtifactRevision } from "./artifactRevisions";
import { artifactNameKey } from "../../shared/artifacts";
import type {
  HubArtifactDraftRow,
  HubArtifactImportRows,
  HubArtifactRecord,
  HubArtifactRevision,
  HubArtifactRevisionMeta,
  HubArtifactState
} from "../../shared/hubOps";

// SQLite persistence for artifacts. Deliberately independent from conversation
// payload storage: artifacts must survive chat compaction, agent session loss,
// and app restarts, and are append-only at the version level. Uses the same
// sqlite3-CLI approach as StorageService (no native binding), but takes an
// explicit dbPath so it can run under plain `node --test` without Electron.
//
// The User's server owns every document (agreements Д1, Д9): there this store
// is the documents themselves, decided by ArtifactService; on the computer and
// on every machine it is a copy the server's feed keeps current
// (`applyServerStates`), never written by a device's own rules.

const SQLITE_BUSY_TIMEOUT_MS = 30_000;
const SQLITE_COMMAND_TIMEOUT_MS = 45_000;

/** Runs this store's SQL through another connection (the server's own
 *  database session) instead of a sqlite3 process per statement. */
export interface ArtifactSqlExecutor {
  queryJson<T>(sql: string): Promise<T[]>;
  queryText(sql: string): Promise<string>;
  runSql(sql: string): Promise<void>;
}

export interface ArtifactRecord {
  id: string;
  conversationId: string;
  name: string;
  owner: string;
  contributors: string[];
  requiredSigners: string[];
  labels: string[];
  lifecycle: "collecting_drafts" | "published";
  allowedDraftAuthors: string[];
  requiredDraftAuthors: string[];
  audiencePolicyByAuthor: Record<string, { allowedReaders: string[]; requiredReaders: string[] }>;
  draftRosterRevision: number;
  headVersion: number;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface ArtifactDraftRecord {
  id: string;
  artifactId: string;
  author: string;
  state: "editing" | "submitted" | "superseded" | "withdrawn";
  content: string;
  readers: string[];
  editRevision: number;
  supersedesDraftId?: string;
  createdAt: string;
  updatedAt: string;
  submittedAt?: string;
}

export interface ArtifactVersionSourceRecord {
  artifactId: string;
  version: number;
  draftId: string;
  author: string;
  submittedAt: string;
  contentHash: string;
  disposition: "considered" | "excluded";
  exclusionRationale?: string;
}

export interface ArtifactOperationRecord {
  conversationId: string;
  artifactId?: string;
  actor: string;
  operationKind: string;
  operationId: string;
  requestHash: string;
  resultJson: string;
  createdAt: string;
}

export interface ArtifactEventRecord {
  id: string;
  conversationId: string;
  artifactId: string;
  kind: string;
  actor: string;
  content: string;
  createdAt: string;
  deliveredAt?: string;
}

export interface ArtifactVersionRecord {
  artifactId: string;
  version: number;
  versionEventId?: string;
  contentHash?: string;
  baseVersionEventId?: string;
  content: string;
  author: string;
  note?: string;
  createdAt: string;
}

export interface ArtifactVersionMetaRecord {
  artifactId: string;
  version: number;
  versionEventId: string;
  contentHash: string;
  author: string;
  note?: string;
  createdAt: string;
}

export interface ArtifactSignatureRecord {
  artifactId: string;
  version?: number;
  versionEventId: string;
  contentHash: string;
  signer: string;
  signedAt: string;
}

interface ArtifactRow {
  id: string;
  conversationId: string;
  name: string;
  owner: string;
  contributorsJson: string;
  requiredSignersJson: string;
  labelsJson: string;
  lifecycle: "collecting_drafts" | "published";
  allowedDraftAuthorsJson: string;
  requiredDraftAuthorsJson: string;
  audiencePolicyJson: string;
  draftRosterRevision: number;
  headVersion: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

interface ArtifactDraftRow {
  id: string;
  artifactId: string;
  author: string;
  state: ArtifactDraftRecord["state"];
  content: string;
  readersJson: string;
  editRevision: number;
  supersedesDraftId: string | null;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
}

interface ArtifactVersionSourceRow extends Omit<ArtifactVersionSourceRecord, "exclusionRationale"> {
  exclusionRationale: string | null;
}

interface ArtifactEventRow extends Omit<ArtifactEventRecord, "deliveredAt"> {
  deliveredAt: string | null;
}

function sqlString(value: string | undefined | null): string {
  if (value === undefined || value === null) {
    return "NULL";
  }
  return `'${value.replace(/'/g, "''")}'`;
}

function parseStringArray(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

function parseAudiencePolicy(json: string): ArtifactRecord["audiencePolicyByAuthor"] {
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const result: ArtifactRecord["audiencePolicyByAuthor"] = {};
    for (const [author, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        continue;
      }
      const policy = value as Record<string, unknown>;
      result[author] = {
        allowedReaders: Array.isArray(policy.allowedReaders)
          ? policy.allowedReaders.filter((entry): entry is string => typeof entry === "string")
          : [],
        requiredReaders: Array.isArray(policy.requiredReaders)
          ? policy.requiredReaders.filter((entry): entry is string => typeof entry === "string")
          : []
      };
    }
    return result;
  } catch {
    return {};
  }
}

const ARTIFACT_SELECT = `
  select
    id,
    conversation_id as conversationId,
    name,
    owner,
    contributors_json as contributorsJson,
    required_signers_json as requiredSignersJson,
    labels_json as labelsJson,
    lifecycle,
    allowed_draft_authors_json as allowedDraftAuthorsJson,
    required_draft_authors_json as requiredDraftAuthorsJson,
    audience_policy_json as audiencePolicyJson,
    draft_roster_revision as draftRosterRevision,
    head_version as headVersion,
    created_at as createdAt,
    updated_at as updatedAt,
    archived_at as archivedAt
  from artifacts
`;

export class ArtifactStore {
  private readonly mutationQueues = new Map<string, Promise<unknown>>();

  /** Local edits and incoming events in this runtime share one queue.
   * Independent runtimes remain guarded by SQLite preconditions. */
  withMutation<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
    const key = conversationId;
    const previous = this.mutationQueues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(fn);
    const tail = next.then(() => undefined, () => undefined);
    this.mutationQueues.set(key, tail);
    return next.finally(() => {
      if (this.mutationQueues.get(key) === tail) this.mutationQueues.delete(key);
    });
  }
  private static readonly initByPath = new Map<string, Promise<void>>();
  private initialized = false;

  constructor(
    private readonly dbPath: string,
    private readonly sqliteExecutable = "sqlite3",
    private readonly executor?: ArtifactSqlExecutor
  ) {}

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }
    const pending = ArtifactStore.initByPath.get(this.dbPath);
    if (pending) {
      await pending;
      this.initialized = true;
      return;
    }
    const initialization = this.initialize();
    ArtifactStore.initByPath.set(this.dbPath, initialization);
    try {
      await initialization;
      this.initialized = true;
    } finally {
      if (ArtifactStore.initByPath.get(this.dbPath) === initialization) {
        ArtifactStore.initByPath.delete(this.dbPath);
      }
    }
  }

  private async initialize(): Promise<void> {
    await mkdir(path.dirname(this.dbPath), { recursive: true });
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
      ["archived_at", "alter table artifacts add column archived_at text;"]
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

  async insertArtifact(
    record: ArtifactRecord,
    nameKey: string,
    firstVersion: ArtifactVersionRecord,
    event?: ArtifactEventRecord,
    alsoCommitSql?: string
  ): Promise<boolean> {
    await this.init();
    const revision = artifactRevision(firstVersion, event?.id);
    const output = await this.queryText(`
      begin immediate;
      insert into artifacts (
        id, conversation_id, name, name_key, owner,
        contributors_json, required_signers_json, labels_json,
        lifecycle, allowed_draft_authors_json, required_draft_authors_json,
        audience_policy_json, draft_roster_revision,
        head_version, created_at, updated_at
      ) select
        ${sqlString(record.id)},
        ${sqlString(record.conversationId)},
        ${sqlString(record.name)},
        ${sqlString(nameKey)},
        ${sqlString(record.owner)},
        ${sqlString(JSON.stringify(record.contributors))},
        ${sqlString(JSON.stringify(record.requiredSigners))},
        ${sqlString(JSON.stringify(record.labels))},
        ${sqlString(record.lifecycle)},
        ${sqlString(JSON.stringify(record.allowedDraftAuthors))},
        ${sqlString(JSON.stringify(record.requiredDraftAuthors))},
        ${sqlString(JSON.stringify(record.audiencePolicyByAuthor))},
        ${Math.floor(record.draftRosterRevision)},
        ${Math.floor(record.headVersion)},
        ${sqlString(record.createdAt)},
        ${sqlString(record.updatedAt)}
      where not exists (
        select 1 from artifact_conversation_tombstones
        where conversation_id = ${sqlString(record.conversationId)}
      );
      ${revisionInsertSql(revision, `exists (select 1 from artifacts where id = ${sqlString(record.id)})`)}
      ${revisionProjectionInsertSql(revision)}
      ${event ? `
        insert into artifact_event_outbox (
          id, conversation_id, artifact_id, kind, actor, content, created_at, delivered_at
        )
        select
          ${sqlString(event.id)}, ${sqlString(event.conversationId)}, ${sqlString(event.artifactId)},
          ${sqlString(event.kind)}, ${sqlString(event.actor)}, ${sqlString(event.content)},
          ${sqlString(event.createdAt)}, ${sqlString(event.deliveredAt)}
        where exists (select 1 from artifacts where id = ${sqlString(record.id)});
      ` : ""}
      select count(*) from artifacts where id = ${sqlString(record.id)};
      ${alsoCommitSql ?? ""}
      commit;
    `);
    return Number.parseInt(output.trim(), 10) === 1;
  }

  async insertCollectingArtifact(
    record: ArtifactRecord,
    nameKey: string,
    operation: ArtifactOperationRecord,
    event: ArtifactEventRecord,
    alsoCommitSql?: string
  ): Promise<boolean> {
    await this.init();
    await this.runSql(`
      begin immediate;
      ${this.insertOperationSql(operation)}
      insert or ignore into artifacts (
        id, conversation_id, name, name_key, owner,
        contributors_json, required_signers_json, labels_json,
        lifecycle, allowed_draft_authors_json, required_draft_authors_json,
        audience_policy_json, draft_roster_revision,
        head_version, created_at, updated_at
      )
      select
        ${sqlString(record.id)},
        ${sqlString(record.conversationId)},
        ${sqlString(record.name)},
        ${sqlString(nameKey)},
        ${sqlString(record.owner)},
        ${sqlString(JSON.stringify(record.contributors))},
        ${sqlString(JSON.stringify(record.requiredSigners))},
        ${sqlString(JSON.stringify(record.labels))},
        ${sqlString(record.lifecycle)},
        ${sqlString(JSON.stringify(record.allowedDraftAuthors))},
        ${sqlString(JSON.stringify(record.requiredDraftAuthors))},
        ${sqlString(JSON.stringify(record.audiencePolicyByAuthor))},
        ${Math.floor(record.draftRosterRevision)},
        0,
        ${sqlString(record.createdAt)},
        ${sqlString(record.updatedAt)}
      where ${this.operationPendingSql(operation)}
        and not exists (
          select 1 from artifact_conversation_tombstones
          where conversation_id = ${sqlString(record.conversationId)}
        );
      update artifact_operations set applied = 1
      where ${this.operationIdentitySql(operation)}
        and request_hash = ${sqlString(operation.requestHash)}
        and applied = 0
        and exists (select 1 from artifacts where id = ${sqlString(record.id)});
      insert into artifact_event_outbox (
        id, conversation_id, artifact_id, kind, actor, content, created_at, delivered_at
      )
      select
        ${sqlString(event.id)}, ${sqlString(event.conversationId)}, ${sqlString(event.artifactId)},
        ${sqlString(event.kind)}, ${sqlString(event.actor)}, ${sqlString(event.content)},
        ${sqlString(event.createdAt)}, NULL
      where ${this.operationAppliedSql(operation)};
      ${this.deletePendingOperationSql(operation)}
      ${alsoCommitSql ?? ""}
      commit;
    `);
    return (await this.getOperation(
      operation.conversationId,
      operation.actor,
      operation.operationKind,
      operation.operationId
    ))?.applied === true;
  }

  async getById(id: string): Promise<ArtifactRecord | undefined> {
    await this.init();
    const rows = await this.queryJson<ArtifactRow>(`${ARTIFACT_SELECT} where id = ${sqlString(id)} limit 1;`);
    return rows[0] ? this.recordFromRow(rows[0]) : undefined;
  }

  operationCommittedSql(operation: ArtifactOperationRecord): string {
    return this.operationAppliedSql(operation);
  }

  async getByName(conversationId: string, nameKey: string): Promise<ArtifactRecord | undefined> {
    await this.init();
    const rows = await this.queryJson<ArtifactRow>(
      `${ARTIFACT_SELECT} where conversation_id = ${sqlString(conversationId)} and name_key = ${sqlString(nameKey)} limit 1;`
    );
    return rows[0] ? this.recordFromRow(rows[0]) : undefined;
  }

  async listByConversation(conversationId: string): Promise<ArtifactRecord[]> {
    await this.init();
    const rows = await this.queryJson<ArtifactRow>(
      `${ARTIFACT_SELECT} where conversation_id = ${sqlString(conversationId)} order by updated_at desc, name asc;`
    );
    return rows.map((row) => this.recordFromRow(row));
  }

  async getVersion(artifactId: string, version: number): Promise<ArtifactRevision | undefined> {
    await this.init();
    const rows = await this.queryJson<ArtifactRevision & { note: string | null }>(
      `
        select r.artifact_id as artifactId, p.version, r.version_event_id as versionEventId, r.content_hash as contentHash, r.base_version_event_id as baseVersionEventId,
          r.content, r.author, r.note, r.created_at as createdAt
        from artifact_revisions r join artifact_version_projection p on p.version_event_id = r.version_event_id
        where r.artifact_id = ${sqlString(artifactId)} and p.version = ${Math.floor(version)}
        limit 1;
      `
    );
    const row = rows[0];
    return row ? artifactRevision({ ...row, note: row.note ?? undefined }) : undefined;
  }

  async listVersionMetas(artifactId: string): Promise<ArtifactVersionMetaRecord[]> {
    await this.init();
    const rows = await this.queryJson<ArtifactVersionMetaRecord & { note: string | null }>(
      `
        select r.artifact_id as artifactId, p.version, r.version_event_id as versionEventId, r.content_hash as contentHash,
          r.author, r.note, r.created_at as createdAt
        from artifact_revisions r join artifact_version_projection p on p.version_event_id = r.version_event_id
        where r.artifact_id = ${sqlString(artifactId)} order by p.version asc;
      `
    );
    return rows.map((row) => ({ ...row, note: row.note ?? undefined }));
  }

  /** An immutable revision remains readable even when it loses its displayed
   * number during projection. Its signatures continue to name this identity. */
  async getRevision(artifactId: string, versionEventId: string): Promise<(ArtifactRevision & { superseded: boolean }) | undefined> {
    await this.init();
    const rows = await this.queryJson<ArtifactRevision & { superseded: number; note: string | null }>(`
      select r.artifact_id as artifactId, coalesce(p.version, r.original_version) as version,
        r.version_event_id as versionEventId, r.content_hash as contentHash, r.base_version_event_id as baseVersionEventId, r.content, r.author, r.note,
        r.created_at as createdAt, p.version is null as superseded
      from artifact_revisions r left join artifact_version_projection p on p.version_event_id = r.version_event_id
      where r.artifact_id = ${sqlString(artifactId)} and r.version_event_id = ${sqlString(versionEventId)};`);
    const row = rows[0];
    return row ? { ...artifactRevision({ ...row, note: row.note ?? undefined }), superseded: Boolean(row.superseded) } : undefined;
  }

  async listSignatures(artifactId: string): Promise<ArtifactSignatureRecord[]> {
    await this.init();
    return this.queryJson<ArtifactSignatureRecord>(
      `
        select s.artifact_id as artifactId, p.version, s.version_event_id as versionEventId, s.content_hash as contentHash,
          s.signer, s.signed_at as signedAt
        from artifact_bound_signatures s join artifact_revisions r on r.version_event_id = s.version_event_id and r.content_hash = s.content_hash
        left join artifact_version_projection p on p.artifact_id = s.artifact_id and p.version_event_id = s.version_event_id
        where s.artifact_id = ${sqlString(artifactId)} order by p.version asc, s.signed_at asc;
      `
    );
  }

  async listHeadSignaturesByArtifact(conversationId: string): Promise<Map<string, ArtifactSignatureRecord[]>> {
    await this.init();
    const rows = await this.queryJson<ArtifactSignatureRecord>(
      `
        select s.artifact_id as artifactId, p.version, s.version_event_id as versionEventId, s.content_hash as contentHash, s.signer, s.signed_at as signedAt
        from artifact_bound_signatures s
        join artifact_version_projection p on p.artifact_id = s.artifact_id and p.version_event_id = s.version_event_id
        join artifact_revisions r on r.version_event_id = s.version_event_id and r.content_hash = s.content_hash
        join artifacts a on a.id = s.artifact_id and a.head_version = p.version
        where a.conversation_id = ${sqlString(conversationId)}
        order by s.signed_at asc;
      `
    );
    const byArtifact = new Map<string, ArtifactSignatureRecord[]>();
    for (const row of rows) {
      const list = byArtifact.get(row.artifactId) ?? [];
      list.push(row);
      byArtifact.set(row.artifactId, list);
    }
    return byArtifact;
  }

  // Append a new head version guarded by the expected current head. Returns
  // true only when THIS call performed the write. Comparing the resulting head
  // to the target version is not enough: a competing writer racing to the same
  // target would make the loser look successful and silently drop its content.
  // Instead the guarded update runs inside one immediate transaction and
  // `changes()` reports whether this writer's update took effect.
  async appendVersion(
    record: ArtifactVersionRecord,
    expectedHeadVersion: number,
    event?: ArtifactEventRecord,
    /** Statements committed with this change, so the two are one transaction.
     *  A caller uses it for the chat event that makes the change visible to
     *  other peers: a failure here loses both, never one. */
    alsoCommitSql?: string
  ): Promise<boolean> {
    await this.init();
    const id = sqlString(record.artifactId);
    const base = await this.getVersion(record.artifactId, expectedHeadVersion);
    if (!base || (record.baseVersionEventId && record.baseVersionEventId !== base.versionEventId)) return false;
    const revision = artifactRevision({ ...record, baseVersionEventId: base.versionEventId }, event?.id);
    const expected = Math.floor(expectedHeadVersion);
    const version = Math.floor(record.version);
    const output = await this.queryText(`
      begin immediate;
      ${revisionInsertSql(revision, `(select head_version from artifacts where id = ${id}) = ${expected} and exists(select 1 from artifact_version_projection where artifact_id = ${id} and version = ${expected} and version_event_id = ${sqlString(base.versionEventId)})`)}
      ${revisionProjectionInsertSql(revision)}
      update artifacts
      set head_version = ${version}, updated_at = ${sqlString(record.createdAt)}
      where id = ${id} and head_version = ${expected} and exists(select 1 from artifact_version_projection where artifact_id = ${id} and version_event_id = ${sqlString(revision.versionEventId)});
      ${event ? `
        insert into artifact_event_outbox (
          id, conversation_id, artifact_id, kind, actor, content, created_at, delivered_at
        )
        select
          ${sqlString(event.id)}, ${sqlString(event.conversationId)}, ${sqlString(event.artifactId)},
          ${sqlString(event.kind)}, ${sqlString(event.actor)}, ${sqlString(event.content)},
          ${sqlString(event.createdAt)}, NULL
        where changes() = 1;
        select changes();
      ` : "select changes();"}
      ${alsoCommitSql ?? ""}
      commit;
    `);
    return Number.parseInt(output.trim(), 10) === 1;
  }

  async updateName(
    id: string,
    name: string,
    nameKey: string,
    updatedAt: string,
    event?: ArtifactEventRecord,
    alsoCommitSql?: string
  ): Promise<void> {
    await this.init();
    await this.runSql(`
      begin immediate;
      update artifacts
      set name = ${sqlString(name)}, name_key = ${sqlString(nameKey)}, updated_at = ${sqlString(updatedAt)}
      where id = ${sqlString(id)};
      ${event ? this.insertEventSql(event) : ""}
      ${alsoCommitSql ?? ""}
      commit;
    `);
  }

  async updateAccess(
    id: string,
    access: { owner: string; contributors: string[]; requiredSigners: string[]; labels: string[] },
    updatedAt: string,
    alsoCommitSql?: string
  ): Promise<void> {
    await this.init();
    await this.runSql(`
      begin immediate;
      update artifacts
      set
        owner = ${sqlString(access.owner)},
        contributors_json = ${sqlString(JSON.stringify(access.contributors))},
        required_signers_json = ${sqlString(JSON.stringify(access.requiredSigners))},
        labels_json = ${sqlString(JSON.stringify(access.labels))},
        updated_at = ${sqlString(updatedAt)}
      where id = ${sqlString(id)};
      ${alsoCommitSql ?? ""}
      commit;
    `);
  }

  // Idempotent: returns true when the signature was newly recorded, false when
  // this signer had already signed this version.
  async insertSignature(
    record: ArtifactSignatureRecord,
    event?: ArtifactEventRecord,
    /** Committed with the signature, for the same reason as `appendVersion`. */
    alsoCommitSql?: string,
    /** A signed event records a past action, whose authorization was checked
     * at its origin. Later archive/access changes cannot erase that fact. */
    historical = false
  ): Promise<boolean> {
    await this.init();
    const output = await this.queryText(`
      begin immediate;
      create temp table signature_guard(valid integer check(valid = 1));
      insert into signature_guard select case when exists(
        select 1 from artifact_revisions r join artifacts a on a.id = r.artifact_id
        where r.artifact_id = ${sqlString(record.artifactId)} and r.version_event_id = ${sqlString(record.versionEventId)}
          and r.content_hash = ${sqlString(record.contentHash)}
          ${historical ? "" : `and a.archived_at is null
          and exists(select 1 from json_each(a.required_signers_json) where value = ${sqlString(record.signer)})`}
      ) then 1 else 0 end;
      insert or ignore into artifact_bound_signatures (artifact_id, version_event_id, content_hash, signer, signed_at)
      select artifact_id, version_event_id, content_hash, ${sqlString(record.signer)}, ${sqlString(record.signedAt)}
      from artifact_revisions where artifact_id = ${sqlString(record.artifactId)}
        and version_event_id = ${sqlString(record.versionEventId)} and content_hash = ${sqlString(record.contentHash)};
      ${event ? `
        insert into artifact_event_outbox (
          id, conversation_id, artifact_id, kind, actor, content, created_at, delivered_at
        )
        select
          ${sqlString(event.id)}, ${sqlString(event.conversationId)}, ${sqlString(event.artifactId)},
          ${sqlString(event.kind)}, ${sqlString(event.actor)}, ${sqlString(event.content)},
          ${sqlString(event.createdAt)}, NULL
        where changes() = 1;
        update artifacts set updated_at = ${sqlString(record.signedAt)}
        where id = ${sqlString(record.artifactId)} and exists (
          select 1 from artifact_event_outbox where id = ${sqlString(event.id)}
        );
        select count(*) from artifact_event_outbox where id = ${sqlString(event.id)};
      ` : "select changes();"}
      ${alsoCommitSql ?? ""}
      commit;
    `);
    return Number.parseInt(output.trim(), 10) === 1;
  }

  async touch(id: string, updatedAt: string): Promise<void> {
    await this.init();
    await this.runSql(`update artifacts set updated_at = ${sqlString(updatedAt)} where id = ${sqlString(id)};`);
  }

  async updateArchived(
    id: string,
    archivedAt: string | undefined,
    updatedAt: string,
    event?: ArtifactEventRecord,
    alsoCommitSql?: string
  ): Promise<void> {
    await this.init();
    await this.runSql(`
      begin immediate;
      update artifacts
      set archived_at = ${sqlString(archivedAt)}, updated_at = ${sqlString(updatedAt)}
      where id = ${sqlString(id)};
      ${event ? this.insertEventSql(event) : ""}
      ${alsoCommitSql ?? ""}
      commit;
    `);
  }

  async getOperation(
    conversationId: string,
    actor: string,
    operationKind: string,
    operationId: string
  ): Promise<(ArtifactOperationRecord & { applied: boolean }) | undefined> {
    await this.init();
    const rows = await this.queryJson<ArtifactOperationRecord & { applied: number }>(`
      select
        conversation_id as conversationId,
        artifact_id as artifactId,
        actor,
        operation_kind as operationKind,
        operation_id as operationId,
        request_hash as requestHash,
        result_json as resultJson,
        created_at as createdAt,
        applied
      from artifact_operations
      where conversation_id = ${sqlString(conversationId)}
        and actor = ${sqlString(actor)}
        and operation_kind = ${sqlString(operationKind)}
        and operation_id = ${sqlString(operationId)}
      limit 1;
    `);
    const row = rows[0];
    return row ? { ...row, applied: row.applied === 1 } : undefined;
  }

  async listDrafts(artifactId: string): Promise<ArtifactDraftRecord[]> {
    await this.init();
    const rows = await this.queryJson<ArtifactDraftRow>(`
      select
        id,
        artifact_id as artifactId,
        author,
        state,
        content,
        readers_json as readersJson,
        edit_revision as editRevision,
        supersedes_draft_id as supersedesDraftId,
        created_at as createdAt,
        updated_at as updatedAt,
        submitted_at as submittedAt
      from artifact_drafts
      where artifact_id = ${sqlString(artifactId)}
      order by created_at asc, id asc;
    `);
    return rows.map((row) => this.draftFromRow(row));
  }

  async getDraft(draftId: string): Promise<ArtifactDraftRecord | undefined> {
    await this.init();
    const rows = await this.queryJson<ArtifactDraftRow>(`
      select
        id,
        artifact_id as artifactId,
        author,
        state,
        content,
        readers_json as readersJson,
        edit_revision as editRevision,
        supersedes_draft_id as supersedesDraftId,
        created_at as createdAt,
        updated_at as updatedAt,
        submitted_at as submittedAt
      from artifact_drafts
      where id = ${sqlString(draftId)}
      limit 1;
    `);
    return rows[0] ? this.draftFromRow(rows[0]) : undefined;
  }

  async saveDraft(
    record: ArtifactDraftRecord,
    expectedEditRevision: number,
    expectedRosterRevision: number,
    operation: ArtifactOperationRecord,
    alsoCommitSql?: string
  ): Promise<boolean> {
    await this.init();
    const isNew = expectedEditRevision === 0;
    await this.runSql(`
      begin immediate;
      ${this.insertOperationSql(operation)}
      ${isNew ? `
        insert into artifact_drafts (
          id, artifact_id, author, state, content, readers_json, edit_revision,
          supersedes_draft_id, created_at, updated_at, submitted_at
        )
        select
          ${sqlString(record.id)}, ${sqlString(record.artifactId)}, ${sqlString(record.author)},
          'editing', ${sqlString(record.content)}, ${sqlString(JSON.stringify(record.readers))},
          1, ${sqlString(record.supersedesDraftId)}, ${sqlString(record.createdAt)},
          ${sqlString(record.updatedAt)}, NULL
        where ${this.operationPendingSql(operation)}
          and exists (
            select 1 from artifacts
            where id = ${sqlString(record.artifactId)}
              and lifecycle = 'collecting_drafts'
              and draft_roster_revision = ${Math.floor(expectedRosterRevision)}
          )
          and not exists (
            select 1 from artifact_drafts
            where artifact_id = ${sqlString(record.artifactId)}
              and author = ${sqlString(record.author)} and state = 'editing'
          )
          and (
            (${sqlString(record.supersedesDraftId)} is null and not exists (
              select 1 from artifact_drafts current
              where current.artifact_id = ${sqlString(record.artifactId)}
                and current.author = ${sqlString(record.author)}
                and current.state = 'submitted'
            ))
            or (${sqlString(record.supersedesDraftId)} is not null and exists (
              select 1 from artifact_drafts current
              where current.id = ${sqlString(record.supersedesDraftId)}
                and current.artifact_id = ${sqlString(record.artifactId)}
                and current.author = ${sqlString(record.author)}
                and current.state = 'submitted'
            ))
          );
      ` : `
        update artifact_drafts
        set
          content = ${sqlString(record.content)},
          readers_json = ${sqlString(JSON.stringify(record.readers))},
          edit_revision = ${Math.floor(record.editRevision)},
          updated_at = ${sqlString(record.updatedAt)}
        where id = ${sqlString(record.id)}
          and artifact_id = ${sqlString(record.artifactId)}
          and author = ${sqlString(record.author)}
          and state = 'editing'
          and edit_revision = ${Math.floor(expectedEditRevision)}
          and exists (
            select 1 from artifacts
            where id = ${sqlString(record.artifactId)}
              and lifecycle = 'collecting_drafts'
              and draft_roster_revision = ${Math.floor(expectedRosterRevision)}
          )
          and ${this.operationPendingSql(operation)};
      `}
      update artifact_operations set applied = 1
      where ${this.operationIdentitySql(operation)} and applied = 0 and changes() = 1;
      update artifacts
      set updated_at = ${sqlString(record.updatedAt)}
      where id = ${sqlString(record.artifactId)} and ${this.operationAppliedSql(operation)};
      ${this.deletePendingOperationSql(operation)}
      ${alsoCommitSql ?? ""}
      commit;
    `);
    return (await this.getOperation(
      operation.conversationId,
      operation.actor,
      operation.operationKind,
      operation.operationId
    ))?.applied === true;
  }

  async submitDraft(
    draft: ArtifactDraftRecord,
    expectedEditRevision: number,
    expectedRosterRevision: number,
    operation: ArtifactOperationRecord,
    event: ArtifactEventRecord,
    alsoCommitSql?: string
  ): Promise<boolean> {
    await this.init();
    await this.runSql(`
      begin immediate;
      ${this.insertOperationSql(operation)}
      update artifact_drafts
      set state = 'submitted', submitted_at = ${sqlString(draft.submittedAt)}, updated_at = ${sqlString(draft.updatedAt)}
      where id = ${sqlString(draft.id)}
        and artifact_id = ${sqlString(draft.artifactId)}
        and author = ${sqlString(draft.author)}
        and state = 'editing'
        and edit_revision = ${Math.floor(expectedEditRevision)}
        and exists (
          select 1 from artifacts
          where id = ${sqlString(draft.artifactId)}
            and lifecycle = 'collecting_drafts'
            and draft_roster_revision = ${Math.floor(expectedRosterRevision)}
        )
        and ${this.operationPendingSql(operation)}
        and (
          supersedes_draft_id is null
          or exists (
            select 1 from artifact_drafts prior
            where prior.id = artifact_drafts.supersedes_draft_id
              and prior.artifact_id = artifact_drafts.artifact_id
              and prior.author = artifact_drafts.author
              and prior.state = 'submitted'
          )
        )
        and not exists (
          select 1 from artifact_drafts current
          where current.artifact_id = artifact_drafts.artifact_id
            and current.author = artifact_drafts.author
            and current.state = 'submitted'
            and current.id <> coalesce(artifact_drafts.supersedes_draft_id, '')
        );
      update artifact_operations set applied = 1
      where ${this.operationIdentitySql(operation)} and applied = 0 and changes() = 1;
      update artifact_drafts
      set state = 'superseded', updated_at = ${sqlString(draft.updatedAt)}
      where id = ${sqlString(draft.supersedesDraftId)}
        and artifact_id = ${sqlString(draft.artifactId)}
        and author = ${sqlString(draft.author)}
        and state = 'submitted'
        and ${this.operationAppliedSql(operation)};
      update artifacts
      set updated_at = ${sqlString(draft.updatedAt)}
      where id = ${sqlString(draft.artifactId)} and ${this.operationAppliedSql(operation)};
      insert into artifact_event_outbox (
        id, conversation_id, artifact_id, kind, actor, content, created_at, delivered_at
      )
      select
        ${sqlString(event.id)}, ${sqlString(event.conversationId)}, ${sqlString(event.artifactId)},
        ${sqlString(event.kind)}, ${sqlString(event.actor)}, ${sqlString(event.content)},
        ${sqlString(event.createdAt)}, NULL
      where ${this.operationAppliedSql(operation)};
      ${this.deletePendingOperationSql(operation)}
      ${alsoCommitSql ?? ""}
      commit;
    `);
    return (await this.getOperation(
      operation.conversationId,
      operation.actor,
      operation.operationKind,
      operation.operationId
    ))?.applied === true;
  }

  async withdrawDraft(
    draft: ArtifactDraftRecord,
    expectedRosterRevision: number,
    operation: ArtifactOperationRecord,
    event: ArtifactEventRecord,
    alsoCommitSql?: string
  ): Promise<boolean> {
    await this.init();
    await this.runSql(`
      begin immediate;
      ${this.insertOperationSql(operation)}
      update artifact_drafts
      set state = 'withdrawn', updated_at = ${sqlString(draft.updatedAt)}
      where id = ${sqlString(draft.id)}
        and artifact_id = ${sqlString(draft.artifactId)}
        and state = 'submitted'
        and exists (
          select 1 from artifacts
          where id = ${sqlString(draft.artifactId)}
            and lifecycle = 'collecting_drafts'
            and draft_roster_revision = ${Math.floor(expectedRosterRevision)}
        )
        and ${this.operationPendingSql(operation)}
        and not exists (
          select 1 from artifact_drafts replacement
          where replacement.supersedes_draft_id = artifact_drafts.id
            and replacement.state = 'editing'
        );
      update artifact_operations set applied = 1
      where ${this.operationIdentitySql(operation)} and applied = 0 and changes() = 1;
      update artifacts
      set updated_at = ${sqlString(draft.updatedAt)}
      where id = ${sqlString(draft.artifactId)} and ${this.operationAppliedSql(operation)};
      insert into artifact_event_outbox (
        id, conversation_id, artifact_id, kind, actor, content, created_at, delivered_at
      )
      select
        ${sqlString(event.id)}, ${sqlString(event.conversationId)}, ${sqlString(event.artifactId)},
        ${sqlString(event.kind)}, ${sqlString(event.actor)}, ${sqlString(event.content)},
        ${sqlString(event.createdAt)}, NULL
      where ${this.operationAppliedSql(operation)};
      ${this.deletePendingOperationSql(operation)}
      ${alsoCommitSql ?? ""}
      commit;
    `);
    return (await this.getOperation(
      operation.conversationId,
      operation.actor,
      operation.operationKind,
      operation.operationId
    ))?.applied === true;
  }

  async updateDraftRoster(
    artifactId: string,
    expectedRevision: number,
    roster: Pick<ArtifactRecord, "allowedDraftAuthors" | "requiredDraftAuthors" | "audiencePolicyByAuthor">,
    updatedAt: string,
    operation: ArtifactOperationRecord,
    alsoCommitSql?: string
  ): Promise<boolean> {
    await this.init();
    await this.runSql(`
      begin immediate;
      ${this.insertOperationSql(operation)}
      update artifacts
      set
        allowed_draft_authors_json = ${sqlString(JSON.stringify(roster.allowedDraftAuthors))},
        required_draft_authors_json = ${sqlString(JSON.stringify(roster.requiredDraftAuthors))},
        audience_policy_json = ${sqlString(JSON.stringify(roster.audiencePolicyByAuthor))},
        draft_roster_revision = draft_roster_revision + 1,
        updated_at = ${sqlString(updatedAt)}
      where id = ${sqlString(artifactId)}
        and lifecycle = 'collecting_drafts'
        and draft_roster_revision = ${Math.floor(expectedRevision)}
        and ${this.operationPendingSql(operation)};
      update artifact_operations set applied = 1
      where ${this.operationIdentitySql(operation)} and applied = 0 and changes() = 1;
      ${this.deletePendingOperationSql(operation)}
      ${alsoCommitSql ?? ""}
      commit;
    `);
    return (await this.getOperation(
      operation.conversationId,
      operation.actor,
      operation.operationKind,
      operation.operationId
    ))?.applied === true;
  }

  async publishFirstVersion(
    artifact: ArtifactRecord,
    version: ArtifactVersionRecord,
    sources: ArtifactVersionSourceRecord[],
    requiredSigners: string[],
    operation: ArtifactOperationRecord,
    event: ArtifactEventRecord,
    alsoCommitSql?: string
  ): Promise<boolean> {
    await this.init();
    const revision = artifactRevision(version, event.id);
    const requiredChecks = artifact.requiredDraftAuthors.map((author) => {
      const sourceIds = sources
        .filter((candidate) => candidate.author === author && candidate.disposition === "considered")
        .map((candidate) => sqlString(candidate.draftId));
      return sourceIds.length > 0 ? `
      and exists (
        select 1 from artifact_drafts
        where id in (${sourceIds.join(", ")})
          and artifact_id = ${sqlString(artifact.id)}
          and author = ${sqlString(author)}
          and state = 'submitted'
      )
    ` : "and 0";
    }).join("\n");
    const sourceChecks = sources.map((source) => `
      and exists (
        select 1 from artifact_drafts
        where id = ${sqlString(source.draftId)}
          and artifact_id = ${sqlString(artifact.id)}
          and author = ${sqlString(source.author)}
          and submitted_at = ${sqlString(source.submittedAt)}
          and state in ('submitted', 'superseded', 'withdrawn')
      )
    `).join("\n");
    const sourceInserts = sources.map((source) => `
      insert into artifact_bound_sources (
        artifact_id, version_event_id, draft_id, author, submitted_at,
        content_hash, disposition, exclusion_rationale
      )
      select
        ${sqlString(source.artifactId)}, ${sqlString(revision.versionEventId)}, draft.id,
        draft.author, draft.submitted_at, ${sqlString(source.contentHash)},
        ${sqlString(source.disposition)}, ${sqlString(source.exclusionRationale)}
      from artifact_drafts draft
      where ${this.operationPendingSql(operation)}
        and draft.id = ${sqlString(source.draftId)}
        and draft.artifact_id = ${sqlString(artifact.id)}
        and draft.author = ${sqlString(source.author)}
        and draft.submitted_at = ${sqlString(source.submittedAt)}
        and draft.state in ('submitted', 'superseded', 'withdrawn')
        and exists (
          select 1 from artifact_version_projection
          where artifact_id = ${sqlString(artifact.id)} and version = 1 and version_event_id = ${sqlString(revision.versionEventId)}
        );
    `).join("\n");
    await this.runSql(`
      begin immediate;
      ${this.insertOperationSql(operation)}
      ${revisionInsertSql(revision, `${this.operationPendingSql(operation)}
        and exists (
          select 1 from artifacts
          where id = ${sqlString(artifact.id)}
            and lifecycle = 'collecting_drafts'
            and head_version = 0
            and draft_roster_revision = ${Math.floor(artifact.draftRosterRevision)}
            ${requiredChecks}
            ${sourceChecks}
        )`)}
      ${revisionProjectionInsertSql(revision)}
      ${sourceInserts}
      update artifacts
      set
        lifecycle = 'published',
        head_version = 1,
        required_signers_json = ${sqlString(JSON.stringify(requiredSigners))},
        updated_at = ${sqlString(version.createdAt)}
      where id = ${sqlString(artifact.id)}
        and lifecycle = 'collecting_drafts'
        and head_version = 0
        and ${this.operationPendingSql(operation)}
        and exists (
          select 1 from artifact_version_projection
          where artifact_id = ${sqlString(artifact.id)} and version = 1 and version_event_id = ${sqlString(revision.versionEventId)}
        );
      insert into artifact_event_outbox (
        id, conversation_id, artifact_id, kind, actor, content, created_at, delivered_at
      )
      select
        ${sqlString(event.id)}, ${sqlString(event.conversationId)}, ${sqlString(event.artifactId)},
        ${sqlString(event.kind)}, ${sqlString(event.actor)}, ${sqlString(event.content)},
        ${sqlString(event.createdAt)}, NULL
      where changes() = 1;
      update artifact_operations set applied = 1
      where ${this.operationIdentitySql(operation)} and applied = 0 and changes() = 1;
      ${this.deletePendingOperationSql(operation)}
      ${alsoCommitSql ?? ""}
      commit;
    `);
    return (await this.getOperation(
      operation.conversationId,
      operation.actor,
      operation.operationKind,
      operation.operationId
    ))?.applied === true;
  }

  async listVersionSources(artifactId: string, version: number): Promise<ArtifactVersionSourceRecord[]> {
    await this.init();
    const rows = await this.queryJson<ArtifactVersionSourceRow>(`
      select
        s.artifact_id as artifactId, p.version,
        s.draft_id as draftId, s.author, s.submitted_at as submittedAt,
        s.content_hash as contentHash, s.disposition, s.exclusion_rationale as exclusionRationale
      from artifact_bound_sources s join artifact_version_projection p
        on p.artifact_id = s.artifact_id and p.version_event_id = s.version_event_id
      where s.artifact_id = ${sqlString(artifactId)} and p.version = ${Math.floor(version)}
      order by s.submitted_at asc, s.draft_id asc;
    `);
    return rows.map((row) => ({ ...row, exclusionRationale: row.exclusionRationale ?? undefined }));
  }

  async listPendingEvents(
    limit = 100,
    after?: Pick<ArtifactEventRecord, "createdAt" | "id">
  ): Promise<ArtifactEventRecord[]> {
    await this.init();
    const rows = await this.queryJson<ArtifactEventRow>(`
      select
        id,
        conversation_id as conversationId,
        artifact_id as artifactId,
        kind,
        actor,
        content,
        created_at as createdAt,
        delivered_at as deliveredAt
      from artifact_event_outbox
      where delivered_at is null
        ${after ? `and (
          created_at > ${sqlString(after.createdAt)}
          or (created_at = ${sqlString(after.createdAt)} and id > ${sqlString(after.id)})
        )` : ""}
      order by created_at asc, id asc
      limit ${Math.max(1, Math.floor(limit))};
    `);
    return rows.map((row) => ({ ...row, deliveredAt: row.deliveredAt ?? undefined }));
  }

  async markEventDelivered(id: string, deliveredAt: string): Promise<void> {
    await this.init();
    await this.runSql(`
      update artifact_event_outbox
      set delivered_at = coalesce(delivered_at, ${sqlString(deliveredAt)})
      where id = ${sqlString(id)};
    `);
  }

  async deleteByConversation(conversationId: string): Promise<void> {
    await this.init();
    await this.runSql(`begin immediate; ${this.deleteByConversationSql(conversationId, new Date().toISOString())} commit;`);
  }

  /** The statements that delete a chat's documents and keep them deleted (a
   *  late write for the chat is refused by the tombstone), to commit with
   *  the chat's own deletion. */
  deleteByConversationSql(conversationId: string, deletedAt: string): string {
    const artifacts = `(select id from artifacts where conversation_id = ${sqlString(conversationId)})`;
    return `
      insert or ignore into artifact_conversation_tombstones (conversation_id, deleted_at)
      values (${sqlString(conversationId)}, ${sqlString(deletedAt)});
      delete from artifact_version_sources where artifact_id in ${artifacts};
      delete from artifact_bound_sources where artifact_id in ${artifacts};
      delete from artifact_bound_signatures where artifact_id in ${artifacts};
      delete from artifact_version_projection where artifact_id in ${artifacts};
      delete from artifact_revisions where artifact_id in ${artifacts};
      delete from artifact_signatures where artifact_id in ${artifacts};
      delete from artifact_versions where artifact_id in ${artifacts};
      delete from artifact_drafts where artifact_id in ${artifacts};
      delete from artifact_event_outbox where conversation_id = ${sqlString(conversationId)};
      delete from artifact_operations where conversation_id = ${sqlString(conversationId)};
      delete from artifacts where conversation_id = ${sqlString(conversationId)};
    `;
  }

  // --- the server's documents, whole -----------------------------------------

  /** One document as the server holds it, without revision bodies. */
  async serverState(artifactId: string): Promise<HubArtifactState | undefined> {
    const record = await this.getById(artifactId);
    return record ? (await this.statesOf([record]))[0] : undefined;
  }

  /** Every document of a chat, without revision bodies. */
  async serverStates(conversationId: string): Promise<HubArtifactState[]> {
    return this.statesOf(await this.listByConversation(conversationId));
  }

  private async statesOf(records: ArtifactRecord[]): Promise<HubArtifactState[]> {
    if (records.length === 0) return [];
    await this.init();
    const states = new Map<string, HubArtifactState>(records.map((record) => [record.id, {
      record: hubRecord(record), revisions: [], projection: [], signatures: [], sources: [], drafts: []
    }]));
    // A chat's documents are read in a few statements, not five per document.
    for (let start = 0; start < records.length; start += 200) {
      const ids = records.slice(start, start + 200).map((record) => sqlString(record.id)).join(", ");
      const revisions = await this.queryJson<RevisionMetaRow>(`select ${REVISION_META_COLUMNS} from artifact_revisions
        where artifact_id in (${ids}) order by artifact_id, original_version, created_at, version_event_id;`);
      for (const row of revisions) states.get(row.artifactId)?.revisions.push(revisionMeta(row));
      const projection = await this.queryJson<{ artifactId: string; version: number; versionEventId: string }>(`select artifact_id as artifactId,
        version, version_event_id as versionEventId from artifact_version_projection where artifact_id in (${ids}) order by artifact_id, version;`);
      for (const row of projection) states.get(row.artifactId)?.projection.push({ version: Number(row.version), versionEventId: row.versionEventId });
      const signatures = await this.queryJson<{ artifactId: string; versionEventId: string; contentHash: string; signer: string; signedAt: string }>(`select
        artifact_id as artifactId, version_event_id as versionEventId, content_hash as contentHash, signer, signed_at as signedAt
        from artifact_bound_signatures where artifact_id in (${ids}) order by artifact_id, signed_at, signer;`);
      for (const { artifactId, ...row } of signatures) states.get(artifactId)?.signatures.push(row);
      const sources = await this.queryJson<{ artifactId: string; versionEventId: string; draftId: string; author: string; submittedAt: string;
        contentHash: string; disposition: "considered" | "excluded"; exclusionRationale: string | null }>(`select artifact_id as artifactId,
        version_event_id as versionEventId, draft_id as draftId, author, submitted_at as submittedAt, content_hash as contentHash, disposition,
        exclusion_rationale as exclusionRationale from artifact_bound_sources where artifact_id in (${ids}) order by artifact_id, submitted_at, draft_id;`);
      for (const { artifactId, exclusionRationale, ...row } of sources) {
        states.get(artifactId)?.sources.push({ ...row, ...(exclusionRationale ? { exclusionRationale } : {}) });
      }
      const drafts = await this.queryJson<ArtifactDraftRow>(`${DRAFT_SELECT} where artifact_id in (${ids}) order by artifact_id, created_at, id;`);
      for (const row of drafts) states.get(row.artifactId)?.drafts.push(hubDraft(this.draftFromRow(row)));
    }
    return records.map((record) => states.get(record.id)!);
  }

  /** One revision with its body, whether or not it shows a number now. */
  async revisionWithContent(artifactId: string, versionEventId: string): Promise<HubArtifactRevision | undefined> {
    await this.init();
    const rows = await this.queryJson<RevisionMetaRow & { content: string }>(`select ${REVISION_META_COLUMNS}, content from artifact_revisions
      where artifact_id = ${sqlString(artifactId)} and version_event_id = ${sqlString(versionEventId)};`);
    return rows[0] ? { ...revisionMeta(rows[0]), content: rows[0].content } : undefined;
  }

  /** Which of these revisions this copy already holds, with their hashes. */
  async heldRevisions(versionEventIds: string[]): Promise<Map<string, string>> {
    const held = new Map<string, string>();
    if (versionEventIds.length === 0) return held;
    await this.init();
    for (let start = 0; start < versionEventIds.length; start += 500) {
      const rows = await this.queryJson<{ id: string; hash: string }>(`select version_event_id as id, content_hash as hash from artifact_revisions
        where version_event_id in (${versionEventIds.slice(start, start + 500).map(sqlString).join(", ")});`);
      for (const row of rows) held.set(row.id, row.hash);
    }
    return held;
  }

  /**
   * Makes this copy hold documents exactly as the server holds them: each
   * state replaces this copy's document of that id (its fields, revisions,
   * numbering, signatures, sources and drafts), in one commit. With
   * `replaceConversation`, documents of the chat the server did not list go.
   * `bodies` are the revisions this copy did not hold yet. A chat deleted
   * here keeps nothing.
   */
  async applyServerStates(
    conversationId: string,
    states: HubArtifactState[],
    bodies: Map<string, HubArtifactRevision>,
    options: { replaceConversation?: boolean; forget?: string[]; keep?: string[] } = {}
  ): Promise<void> {
    await this.init();
    const chat = sqlString(conversationId);
    const statements: string[] = [];
    const listed = states.map((state) => sqlString(state.record.id));
    if (options.replaceConversation) {
      const kept = [...listed, ...(options.keep ?? []).map(sqlString)];
      const gone = `(select id from artifacts where conversation_id = ${chat}${kept.length ? ` and id not in (${kept.join(", ")})` : ""})`;
      statements.push(forgetSql(gone));
    }
    if (options.forget?.length) statements.push(forgetSql(`(${options.forget.map(sqlString).join(", ")})`));
    // Names move between documents (a rename, a swap): every document of this
    // chat named here is freed of its name first, then given the server's.
    if (listed.length) {
      statements.push(`update artifacts set name_key = '#moving:' || id where conversation_id = ${chat} and id in (${listed.join(", ")});`);
    }
    for (const state of states) {
      const record = state.record;
      if (record.conversationId !== conversationId) throw new Error("A document from the server names another chat.");
      const problem = serverStateProblem(state);
      if (problem) throw new Error(problem);
      const id = sqlString(record.id);
      const keep = (rows: string[]) => rows.length ? ` and version_event_id not in (${rows.join(", ")})` : "";
      const revisionIds = state.revisions.map((revision) => sqlString(revision.versionEventId));
      // Another document of this chat holding the same name here is stale: it
      // is renamed or gone on the server, and its own state follows.
      statements.push(`update artifacts set name_key = '#stale:' || id where conversation_id = ${chat} and id <> ${id}
        and name_key = ${sqlString(artifactNameKey(record.name))};`);
      statements.push(`insert into artifacts (id, conversation_id, name, name_key, owner, contributors_json, required_signers_json, labels_json,
          lifecycle, allowed_draft_authors_json, required_draft_authors_json, audience_policy_json, draft_roster_revision, head_version,
          created_at, updated_at, archived_at)
        values (${id}, ${chat}, ${sqlString(record.name)}, ${sqlString(artifactNameKey(record.name))}, ${sqlString(record.owner)},
          ${sqlString(JSON.stringify(record.contributors))}, ${sqlString(JSON.stringify(record.requiredSigners))}, ${sqlString(JSON.stringify(record.labels))},
          ${sqlString(record.lifecycle)}, ${sqlString(JSON.stringify(record.allowedDraftAuthors))}, ${sqlString(JSON.stringify(record.requiredDraftAuthors))},
          ${sqlString(JSON.stringify(record.audiencePolicyByAuthor))}, ${Math.floor(record.draftRosterRevision)}, ${Math.floor(record.headVersion)},
          ${sqlString(record.createdAt)}, ${sqlString(record.updatedAt)}, ${sqlString(record.archivedAt)})
        on conflict(id) do update set name = excluded.name, name_key = excluded.name_key, owner = excluded.owner,
          contributors_json = excluded.contributors_json, required_signers_json = excluded.required_signers_json, labels_json = excluded.labels_json,
          lifecycle = excluded.lifecycle, allowed_draft_authors_json = excluded.allowed_draft_authors_json,
          required_draft_authors_json = excluded.required_draft_authors_json, audience_policy_json = excluded.audience_policy_json,
          draft_roster_revision = excluded.draft_roster_revision, head_version = excluded.head_version, created_at = excluded.created_at,
          updated_at = excluded.updated_at, archived_at = excluded.archived_at
        where artifacts.conversation_id = excluded.conversation_id;`);
      statements.push(`delete from artifact_version_projection where artifact_id = ${id};`);
      statements.push(`delete from artifact_bound_signatures where artifact_id = ${id};`);
      statements.push(`delete from artifact_bound_sources where artifact_id = ${id};`);
      statements.push(`delete from artifact_drafts where artifact_id = ${id};`);
      statements.push(`delete from artifact_revisions where artifact_id = ${id}${keep(revisionIds)};`);
      for (const meta of state.revisions) {
        const body = bodies.get(meta.versionEventId);
        if (!body) continue;
        const revision = artifactRevision({ artifactId: record.id, version: meta.originalVersion, versionEventId: meta.versionEventId,
          contentHash: meta.contentHash, baseVersionEventId: meta.baseVersionEventId, content: body.content, author: meta.author,
          note: meta.note, createdAt: meta.createdAt });
        // A row this copy held under the same id with another body was wrong:
        // the server's body replaces it.
        statements.push(`delete from artifact_revisions where version_event_id = ${sqlString(meta.versionEventId)} and content_hash <> ${sqlString(meta.contentHash)};`);
        statements.push(revisionInsertSql(revision, `not exists(select 1 from artifact_revisions where version_event_id = ${sqlString(meta.versionEventId)})`));
      }
      for (const row of state.projection) {
        statements.push(`insert into artifact_version_projection(artifact_id, version, version_event_id)
          select ${id}, ${Math.floor(row.version)}, version_event_id from artifact_revisions
          where artifact_id = ${id} and version_event_id = ${sqlString(row.versionEventId)};`);
      }
      for (const row of state.signatures) {
        statements.push(`insert or ignore into artifact_bound_signatures(artifact_id, version_event_id, content_hash, signer, signed_at)
          values (${id}, ${sqlString(row.versionEventId)}, ${sqlString(row.contentHash)}, ${sqlString(row.signer)}, ${sqlString(row.signedAt)});`);
      }
      for (const row of state.sources) {
        statements.push(`insert or ignore into artifact_bound_sources(artifact_id, version_event_id, draft_id, author, submitted_at, content_hash, disposition, exclusion_rationale)
          values (${id}, ${sqlString(row.versionEventId)}, ${sqlString(row.draftId)}, ${sqlString(row.author)}, ${sqlString(row.submittedAt)},
            ${sqlString(row.contentHash)}, ${sqlString(row.disposition)}, ${sqlString(row.exclusionRationale)});`);
      }
      for (const draft of state.drafts) statements.push(draftInsertSql(draft, record.id));
    }
    // A revision this copy does not hold the body of is never shown as held:
    // the whole state waits for it instead.
    const missing = states.flatMap((state) => state.revisions.filter((meta) => !bodies.has(meta.versionEventId)).map((meta) => meta.versionEventId));
    const guard = missing.length
      ? `insert into server_state_guard select case when (select count(*) from artifact_revisions where version_event_id in (${missing.map(sqlString).join(", ")})) = ${missing.length} then 1 else 0 end;`
      : "";
    await this.runSql(`begin immediate;
      create temp table server_state_guard(valid integer check(valid = 1));
      insert into server_state_guard select case when exists(select 1 from artifact_conversation_tombstones where conversation_id = ${chat}) then 0 else 1 end;
      ${statements.join("\n")}
      ${guard}
      commit;`).catch(async (error) => {
      // A chat deleted here keeps nothing, whatever the server still sent.
      if (await this.isConversationDeleted(conversationId)) return;
      throw error;
    });
  }

  /** Drops this copy of one document (the server no longer has it). */
  async forgetArtifact(artifactId: string): Promise<void> {
    await this.init();
    await this.runSql(`begin immediate; ${forgetSql(`(${sqlString(artifactId)})`)} commit;`);
  }

  async isConversationDeleted(conversationId: string): Promise<boolean> {
    await this.init();
    const rows = await this.queryJson<{ one: number }>(`select 1 as one from artifact_conversation_tombstones where conversation_id = ${sqlString(conversationId)};`);
    return rows.length > 0;
  }

  /** Every row of a chat's documents, as the computer moves them to the
   *  server (one time): revisions with their bodies, and the operations
   *  that keep a repeated operation id answering the same. */
  async exportConversation(conversationId: string): Promise<Required<HubArtifactImportRows>> {
    await this.init();
    const records = await this.listByConversation(conversationId);
    const rows: Required<HubArtifactImportRows> = { artifacts: [], revisions: [], projection: [], signatures: [], sources: [], drafts: [], operations: [] };
    for (const state of await this.statesOf(records)) {
      const artifactId = state.record.id;
      rows.artifacts.push(state.record);
      for (const meta of state.revisions) {
        const revision = await this.revisionWithContent(artifactId, meta.versionEventId);
        if (revision) rows.revisions.push(revision);
      }
      rows.projection.push(...state.projection.map((row) => ({ ...row, artifactId })));
      rows.signatures.push(...state.signatures.map((row) => ({ ...row, artifactId })));
      rows.sources.push(...state.sources.map((row) => ({ ...row, artifactId })));
      rows.drafts.push(...state.drafts);
    }
    const operations = await this.queryJson<{ artifactId: string | null; actor: string; operationKind: string; operationId: string; requestHash: string;
      resultJson: string; createdAt: string }>(`select artifact_id as artifactId, actor, operation_kind as operationKind, operation_id as operationId,
      request_hash as requestHash, result_json as resultJson, created_at as createdAt from artifact_operations
      where conversation_id = ${sqlString(conversationId)} and applied = 1 order by created_at, operation_id;`);
    rows.operations.push(...operations.map(({ artifactId, ...row }) => ({ ...row, ...(artifactId ? { artifactId } : {}) })));
    return rows;
  }

  /**
   * The statements that keep a page of documents moved from the computer,
   * exactly as they were (ids, revision ids and hashes, numbering,
   * signatures, sources, drafts, operations). What the server holds already
   * stays. A moved document whose name another document already took here
   * keeps its rows under a free name. Returns the documents the page names
   * and the rows refused (a revision whose body does not match its hash).
   */
  async importSql(conversationId: string, rows: HubArtifactImportRows): Promise<{ sql: string; artifactIds: string[]; refused: string[] }> {
    await this.init();
    const chat = sqlString(conversationId);
    const statements: string[] = [];
    const refused: string[] = [];
    const artifactIds = new Set<string>();
    const existing = new Map((await this.listByConversation(conversationId)).map((record) => [artifactNameKey(record.name), record.id]));
    for (const record of rows.artifacts ?? []) {
      if (record.conversationId !== conversationId) { refused.push(`document ${record.id}: another chat`); continue; }
      artifactIds.add(record.id);
      let name = record.name;
      for (let suffix = 2; existing.has(artifactNameKey(name)) && existing.get(artifactNameKey(name)) !== record.id; suffix += 1) {
        name = `${record.name} (${suffix})`;
      }
      existing.set(artifactNameKey(name), record.id);
      statements.push(`insert or ignore into artifacts (id, conversation_id, name, name_key, owner, contributors_json, required_signers_json, labels_json,
          lifecycle, allowed_draft_authors_json, required_draft_authors_json, audience_policy_json, draft_roster_revision, head_version,
          created_at, updated_at, archived_at)
        values (${sqlString(record.id)}, ${chat}, ${sqlString(name)}, ${sqlString(artifactNameKey(name))}, ${sqlString(record.owner)},
          ${sqlString(JSON.stringify(record.contributors))}, ${sqlString(JSON.stringify(record.requiredSigners))}, ${sqlString(JSON.stringify(record.labels))},
          ${sqlString(record.lifecycle)}, ${sqlString(JSON.stringify(record.allowedDraftAuthors))}, ${sqlString(JSON.stringify(record.requiredDraftAuthors))},
          ${sqlString(JSON.stringify(record.audiencePolicyByAuthor))}, ${Math.floor(record.draftRosterRevision)}, ${Math.floor(record.headVersion)},
          ${sqlString(record.createdAt)}, ${sqlString(record.updatedAt)}, ${sqlString(record.archivedAt)});`);
    }
    // Rows of a document go only to that document, in this chat.
    const owned = (artifactId: string) => `exists(select 1 from artifacts a where a.id = ${sqlString(artifactId)} and a.conversation_id = ${chat})`;
    for (const revision of rows.revisions ?? []) {
      let checked: ArtifactRevision;
      try {
        checked = artifactRevision({ artifactId: revision.artifactId, version: revision.originalVersion, versionEventId: revision.versionEventId,
          contentHash: revision.contentHash, baseVersionEventId: revision.baseVersionEventId, content: revision.content, author: revision.author,
          note: revision.note, createdAt: revision.createdAt });
      } catch {
        refused.push(`revision ${revision.versionEventId}: its body does not match its hash`);
        continue;
      }
      artifactIds.add(revision.artifactId);
      statements.push(revisionInsertSql(checked, `${owned(revision.artifactId)} and not exists(select 1 from artifact_revisions where version_event_id = ${sqlString(revision.versionEventId)})`));
    }
    for (const row of rows.projection ?? []) {
      artifactIds.add(row.artifactId);
      statements.push(`insert or ignore into artifact_version_projection(artifact_id, version, version_event_id)
        select ${sqlString(row.artifactId)}, ${Math.floor(row.version)}, version_event_id from artifact_revisions
        where artifact_id = ${sqlString(row.artifactId)} and version_event_id = ${sqlString(row.versionEventId)} and ${owned(row.artifactId)};`);
    }
    for (const row of rows.signatures ?? []) {
      artifactIds.add(row.artifactId);
      statements.push(`insert or ignore into artifact_bound_signatures(artifact_id, version_event_id, content_hash, signer, signed_at)
        select ${sqlString(row.artifactId)}, ${sqlString(row.versionEventId)}, ${sqlString(row.contentHash)}, ${sqlString(row.signer)}, ${sqlString(row.signedAt)}
        where ${owned(row.artifactId)};`);
    }
    for (const row of rows.sources ?? []) {
      artifactIds.add(row.artifactId);
      statements.push(`insert or ignore into artifact_bound_sources(artifact_id, version_event_id, draft_id, author, submitted_at, content_hash, disposition, exclusion_rationale)
        select ${sqlString(row.artifactId)}, ${sqlString(row.versionEventId)}, ${sqlString(row.draftId)}, ${sqlString(row.author)}, ${sqlString(row.submittedAt)},
          ${sqlString(row.contentHash)}, ${sqlString(row.disposition)}, ${sqlString(row.exclusionRationale)} where ${owned(row.artifactId)};`);
    }
    for (const draft of rows.drafts ?? []) {
      artifactIds.add(draft.artifactId);
      statements.push(draftInsertSql(draft, draft.artifactId, `${owned(draft.artifactId)} and not exists(select 1 from artifact_drafts where id = ${sqlString(draft.id)})
        and not (${sqlString(draft.state)} = 'editing' and exists(select 1 from artifact_drafts where artifact_id = ${sqlString(draft.artifactId)}
          and author = ${sqlString(draft.author)} and state = 'editing'))`));
    }
    for (const operation of rows.operations ?? []) {
      statements.push(`insert or ignore into artifact_operations (conversation_id, artifact_id, actor, operation_kind, operation_id, request_hash, result_json, applied, created_at)
        values (${chat}, ${sqlString(operation.artifactId)}, ${sqlString(operation.actor)}, ${sqlString(operation.operationKind)}, ${sqlString(operation.operationId)},
          ${sqlString(operation.requestHash)}, ${sqlString(operation.resultJson)}, 1, ${sqlString(operation.createdAt)});`);
    }
    return { sql: statements.join("\n"), artifactIds: [...artifactIds], refused };
  }

  /** Runs statements in one commit (the server: a change and its place in
   *  the order together). */
  async commitSql(sql: string): Promise<void> {
    await this.init();
    await this.runSql(`begin immediate; ${sql} commit;`);
  }

  private recordFromRow(row: ArtifactRow): ArtifactRecord {
    return {
      id: row.id,
      conversationId: row.conversationId,
      name: row.name,
      owner: row.owner,
      contributors: parseStringArray(row.contributorsJson),
      requiredSigners: parseStringArray(row.requiredSignersJson),
      labels: parseStringArray(row.labelsJson),
      lifecycle: row.lifecycle === "collecting_drafts" ? "collecting_drafts" : "published",
      allowedDraftAuthors: parseStringArray(row.allowedDraftAuthorsJson),
      requiredDraftAuthors: parseStringArray(row.requiredDraftAuthorsJson),
      audiencePolicyByAuthor: parseAudiencePolicy(row.audiencePolicyJson),
      draftRosterRevision: typeof row.draftRosterRevision === "number"
        ? row.draftRosterRevision
        : Number.parseInt(String(row.draftRosterRevision), 10) || 0,
      headVersion: typeof row.headVersion === "number" ? row.headVersion : Number.parseInt(String(row.headVersion), 10) || 0,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      archivedAt: row.archivedAt ?? undefined
    };
  }

  private draftFromRow(row: ArtifactDraftRow): ArtifactDraftRecord {
    return {
      id: row.id,
      artifactId: row.artifactId,
      author: row.author,
      state: row.state,
      content: row.content,
      readers: parseStringArray(row.readersJson),
      editRevision: typeof row.editRevision === "number" ? row.editRevision : Number.parseInt(String(row.editRevision), 10) || 0,
      supersedesDraftId: row.supersedesDraftId ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      submittedAt: row.submittedAt ?? undefined
    };
  }

  private insertOperationSql(operation: ArtifactOperationRecord): string {
    return `
      insert or ignore into artifact_operations (
        conversation_id, artifact_id, actor, operation_kind, operation_id,
        request_hash, result_json, applied, created_at
      ) values (
        ${sqlString(operation.conversationId)}, ${sqlString(operation.artifactId)}, ${sqlString(operation.actor)},
        ${sqlString(operation.operationKind)}, ${sqlString(operation.operationId)},
        ${sqlString(operation.requestHash)}, ${sqlString(operation.resultJson)}, 0,
        ${sqlString(operation.createdAt)}
      );
    `;
  }

  private operationIdentitySql(operation: ArtifactOperationRecord): string {
    return `conversation_id = ${sqlString(operation.conversationId)}
      and actor = ${sqlString(operation.actor)}
      and operation_kind = ${sqlString(operation.operationKind)}
      and operation_id = ${sqlString(operation.operationId)}`;
  }

  private operationPendingSql(operation: ArtifactOperationRecord): string {
    return `exists (
      select 1 from artifact_operations
      where ${this.operationIdentitySql(operation)}
        and request_hash = ${sqlString(operation.requestHash)}
        and result_json = ${sqlString(operation.resultJson)}
        and applied = 0
    )`;
  }

  private operationAppliedSql(operation: ArtifactOperationRecord): string {
    return `exists (
      select 1 from artifact_operations
      where ${this.operationIdentitySql(operation)}
        and request_hash = ${sqlString(operation.requestHash)}
        and result_json = ${sqlString(operation.resultJson)}
        and applied = 1
    )`;
  }

  private deletePendingOperationSql(operation: ArtifactOperationRecord): string {
    return `delete from artifact_operations
      where ${this.operationIdentitySql(operation)}
        and request_hash = ${sqlString(operation.requestHash)}
        and result_json = ${sqlString(operation.resultJson)}
        and applied = 0;`;
  }

  private insertEventSql(event: ArtifactEventRecord): string {
    return `
      insert or ignore into artifact_event_outbox (
        id, conversation_id, artifact_id, kind, actor, content, created_at, delivered_at
      ) values (
        ${sqlString(event.id)}, ${sqlString(event.conversationId)}, ${sqlString(event.artifactId)},
        ${sqlString(event.kind)}, ${sqlString(event.actor)}, ${sqlString(event.content)},
        ${sqlString(event.createdAt)}, ${sqlString(event.deliveredAt)}
      );
    `;
  }

  private async queryJson<T>(sql: string): Promise<T[]> {
    if (this.executor) return this.executor.queryJson<T>(sql);
    const result = await runCommand(this.sqliteExecutable, this.sqliteArgs(["-json", this.dbPath]), {
      input: sql,
      timeoutMs: SQLITE_COMMAND_TIMEOUT_MS,
      primeLoginShellEnv: false
    });
    const text = result.stdout.trim();
    return text ? (JSON.parse(text) as T[]) : [];
  }

  private async queryText(sql: string): Promise<string> {
    if (this.executor) return (await this.executor.queryText(sql)).trim();
    const result = await runCommand(this.sqliteExecutable, this.sqliteArgs(["-batch", "-noheader", this.dbPath]), {
      input: sql,
      timeoutMs: SQLITE_COMMAND_TIMEOUT_MS,
      primeLoginShellEnv: false
    });
    return result.stdout.trim();
  }

  private async runSql(sql: string): Promise<void> {
    if (this.executor) return this.executor.runSql(sql);
    await runCommand(this.sqliteExecutable, this.sqliteArgs([this.dbPath]), {
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

const DRAFT_SELECT = `
  select
    id,
    artifact_id as artifactId,
    author,
    state,
    content,
    readers_json as readersJson,
    edit_revision as editRevision,
    supersedes_draft_id as supersedesDraftId,
    created_at as createdAt,
    updated_at as updatedAt,
    submitted_at as submittedAt
  from artifact_drafts
`;

const REVISION_META_COLUMNS = `artifact_id as artifactId, version_event_id as versionEventId, original_version as originalVersion,
  base_version_event_id as baseVersionEventId, content_hash as contentHash, author, note, created_at as createdAt`;

interface RevisionMetaRow {
  artifactId: string;
  versionEventId: string;
  originalVersion: number;
  baseVersionEventId: string | null;
  contentHash: string;
  author: string;
  note: string | null;
  createdAt: string;
}

function revisionMeta(row: RevisionMetaRow): HubArtifactRevisionMeta {
  return {
    artifactId: row.artifactId,
    versionEventId: row.versionEventId,
    originalVersion: Number(row.originalVersion),
    ...(row.baseVersionEventId ? { baseVersionEventId: row.baseVersionEventId } : {}),
    contentHash: row.contentHash,
    author: row.author,
    ...(row.note !== null && row.note !== undefined ? { note: row.note } : {}),
    createdAt: row.createdAt
  };
}

function hubRecord(record: ArtifactRecord): HubArtifactRecord {
  const { archivedAt, ...rest } = record;
  return { ...rest, ...(archivedAt ? { archivedAt } : {}) };
}

function hubDraft(draft: ArtifactDraftRecord): HubArtifactDraftRow {
  const { supersedesDraftId, submittedAt, ...rest } = draft;
  return { ...rest, ...(supersedesDraftId ? { supersedesDraftId } : {}), ...(submittedAt ? { submittedAt } : {}) };
}

function draftInsertSql(draft: HubArtifactDraftRow, artifactId: string, condition?: string): string {
  return `insert into artifact_drafts (id, artifact_id, author, state, content, readers_json, edit_revision, supersedes_draft_id, created_at, updated_at, submitted_at)
    select ${sqlString(draft.id)}, ${sqlString(artifactId)}, ${sqlString(draft.author)}, ${sqlString(draft.state)}, ${sqlString(draft.content)},
      ${sqlString(JSON.stringify(draft.readers))}, ${Math.floor(draft.editRevision)}, ${sqlString(draft.supersedesDraftId)}, ${sqlString(draft.createdAt)},
      ${sqlString(draft.updatedAt)}, ${sqlString(draft.submittedAt)}
    ${condition ? `where ${condition}` : ""};`;
}

/** Why a document as the server sent it cannot be held as it is, or
 *  undefined when it can. */
export function serverStateProblem(state: HubArtifactState): string | undefined {
  const known = new Set(state.revisions.map((revision) => revision.versionEventId));
  if (state.projection.some((row) => !known.has(row.versionEventId)) || state.projection.length !== state.record.headVersion) {
    return `Document ${state.record.id} from the server numbers a revision it does not list.`;
  }
  return undefined;
}

/** Statements that drop documents from this copy (by an id list or a
 *  subquery of ids), without marking their chat deleted. */
function forgetSql(ids: string): string {
  return `
    delete from artifact_bound_sources where artifact_id in ${ids};
    delete from artifact_bound_signatures where artifact_id in ${ids};
    delete from artifact_version_projection where artifact_id in ${ids};
    delete from artifact_drafts where artifact_id in ${ids};
    delete from artifact_revisions where artifact_id in ${ids};
    delete from artifacts where id in ${ids};
  `;
}


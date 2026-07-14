import { mkdir } from "node:fs/promises";
import path from "node:path";
import { runCommand } from "./command";

// SQLite persistence for artifacts. Deliberately independent from conversation
// payload storage: artifacts must survive chat compaction, agent session loss,
// and app restarts, and are append-only at the version level. Uses the same
// sqlite3-CLI approach as StorageService (no native binding), but takes an
// explicit dbPath so it can run under plain `node --test` without Electron.

const SQLITE_BUSY_TIMEOUT_MS = 30_000;
const SQLITE_COMMAND_TIMEOUT_MS = 45_000;

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
  content: string;
  author: string;
  note?: string;
  createdAt: string;
}

export interface ArtifactVersionMetaRecord {
  artifactId: string;
  version: number;
  author: string;
  note?: string;
  createdAt: string;
}

export interface ArtifactSignatureRecord {
  artifactId: string;
  version: number;
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
    updated_at as updatedAt
  from artifacts
`;

export class ArtifactStore {
  private static readonly initByPath = new Map<string, Promise<void>>();
  private initialized = false;

  constructor(private readonly dbPath: string) {}

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
        updated_at text not null
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
      ["draft_roster_revision", "alter table artifacts add column draft_roster_revision integer not null default 0;"]
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
    event?: ArtifactEventRecord
  ): Promise<boolean> {
    await this.init();
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
      insert into artifact_versions (artifact_id, version, content, author, note, created_at)
      select
        ${sqlString(firstVersion.artifactId)},
        ${Math.floor(firstVersion.version)},
        ${sqlString(firstVersion.content)},
        ${sqlString(firstVersion.author)},
        ${sqlString(firstVersion.note)},
        ${sqlString(firstVersion.createdAt)}
      where exists (select 1 from artifacts where id = ${sqlString(record.id)});
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
      commit;
    `);
    return Number.parseInt(output.trim(), 10) === 1;
  }

  async insertCollectingArtifact(
    record: ArtifactRecord,
    nameKey: string,
    operation: ArtifactOperationRecord,
    event: ArtifactEventRecord
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

  async getVersion(artifactId: string, version: number): Promise<ArtifactVersionRecord | undefined> {
    await this.init();
    const rows = await this.queryJson<ArtifactVersionRecord & { note: string | null }>(
      `
        select artifact_id as artifactId, version, content, author, note, created_at as createdAt
        from artifact_versions
        where artifact_id = ${sqlString(artifactId)} and version = ${Math.floor(version)}
        limit 1;
      `
    );
    const row = rows[0];
    return row ? { ...row, note: row.note ?? undefined } : undefined;
  }

  async listVersionMetas(artifactId: string): Promise<ArtifactVersionMetaRecord[]> {
    await this.init();
    const rows = await this.queryJson<ArtifactVersionMetaRecord & { note: string | null }>(
      `
        select artifact_id as artifactId, version, author, note, created_at as createdAt
        from artifact_versions
        where artifact_id = ${sqlString(artifactId)}
        order by version asc;
      `
    );
    return rows.map((row) => ({ ...row, note: row.note ?? undefined }));
  }

  async listSignatures(artifactId: string): Promise<ArtifactSignatureRecord[]> {
    await this.init();
    return this.queryJson<ArtifactSignatureRecord>(
      `
        select artifact_id as artifactId, version, signer, signed_at as signedAt
        from artifact_signatures
        where artifact_id = ${sqlString(artifactId)}
        order by version asc, signed_at asc;
      `
    );
  }

  async listHeadSignaturesByArtifact(conversationId: string): Promise<Map<string, ArtifactSignatureRecord[]>> {
    await this.init();
    const rows = await this.queryJson<ArtifactSignatureRecord>(
      `
        select s.artifact_id as artifactId, s.version, s.signer, s.signed_at as signedAt
        from artifact_signatures s
        join artifacts a on a.id = s.artifact_id and a.head_version = s.version
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
    event?: ArtifactEventRecord
  ): Promise<boolean> {
    await this.init();
    const id = sqlString(record.artifactId);
    const expected = Math.floor(expectedHeadVersion);
    const version = Math.floor(record.version);
    const output = await this.queryText(`
      begin immediate;
      insert into artifact_versions (artifact_id, version, content, author, note, created_at)
      select ${id}, ${version}, ${sqlString(record.content)}, ${sqlString(record.author)}, ${sqlString(record.note)}, ${sqlString(record.createdAt)}
      where (select head_version from artifacts where id = ${id}) = ${expected};
      update artifacts
      set head_version = ${version}, updated_at = ${sqlString(record.createdAt)}
      where id = ${id} and head_version = ${expected};
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
      commit;
    `);
    return Number.parseInt(output.trim(), 10) === 1;
  }

  async updateName(
    id: string,
    name: string,
    nameKey: string,
    updatedAt: string,
    event?: ArtifactEventRecord
  ): Promise<void> {
    await this.init();
    await this.runSql(`
      begin immediate;
      update artifacts
      set name = ${sqlString(name)}, name_key = ${sqlString(nameKey)}, updated_at = ${sqlString(updatedAt)}
      where id = ${sqlString(id)};
      ${event ? this.insertEventSql(event) : ""}
      commit;
    `);
  }

  async updateAccess(
    id: string,
    access: { owner: string; contributors: string[]; requiredSigners: string[]; labels: string[] },
    updatedAt: string
  ): Promise<void> {
    await this.init();
    await this.runSql(`
      update artifacts
      set
        owner = ${sqlString(access.owner)},
        contributors_json = ${sqlString(JSON.stringify(access.contributors))},
        required_signers_json = ${sqlString(JSON.stringify(access.requiredSigners))},
        labels_json = ${sqlString(JSON.stringify(access.labels))},
        updated_at = ${sqlString(updatedAt)}
      where id = ${sqlString(id)};
    `);
  }

  // Idempotent: returns true when the signature was newly recorded, false when
  // this signer had already signed this version.
  async insertSignature(record: ArtifactSignatureRecord, event?: ArtifactEventRecord): Promise<boolean> {
    await this.init();
    const output = await this.queryText(`
      begin immediate;
      insert or ignore into artifact_signatures (artifact_id, version, signer, signed_at)
      values (
        ${sqlString(record.artifactId)},
        ${Math.floor(record.version)},
        ${sqlString(record.signer)},
        ${sqlString(record.signedAt)}
      );
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
      commit;
    `);
    return Number.parseInt(output.trim(), 10) === 1;
  }

  async touch(id: string, updatedAt: string): Promise<void> {
    await this.init();
    await this.runSql(`update artifacts set updated_at = ${sqlString(updatedAt)} where id = ${sqlString(id)};`);
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
    operation: ArtifactOperationRecord
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
    event: ArtifactEventRecord
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
    event: ArtifactEventRecord
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
    operation: ArtifactOperationRecord
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
    event: ArtifactEventRecord
  ): Promise<boolean> {
    await this.init();
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
      insert into artifact_version_sources (
        artifact_id, version, draft_id, author, submitted_at,
        content_hash, disposition, exclusion_rationale
      )
      select
        ${sqlString(source.artifactId)}, ${Math.floor(source.version)}, draft.id,
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
          select 1 from artifact_versions
          where artifact_id = ${sqlString(artifact.id)} and version = 1
        );
    `).join("\n");
    await this.runSql(`
      begin immediate;
      ${this.insertOperationSql(operation)}
      insert into artifact_versions (artifact_id, version, content, author, note, created_at)
      select
        ${sqlString(version.artifactId)}, 1, ${sqlString(version.content)}, ${sqlString(version.author)},
        ${sqlString(version.note)}, ${sqlString(version.createdAt)}
      where ${this.operationPendingSql(operation)}
        and exists (
          select 1 from artifacts
          where id = ${sqlString(artifact.id)}
            and lifecycle = 'collecting_drafts'
            and head_version = 0
            and draft_roster_revision = ${Math.floor(artifact.draftRosterRevision)}
            ${requiredChecks}
            ${sourceChecks}
        );
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
          select 1 from artifact_versions
          where artifact_id = ${sqlString(artifact.id)} and version = 1
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
        artifact_id as artifactId,
        version,
        draft_id as draftId,
        author,
        submitted_at as submittedAt,
        content_hash as contentHash,
        disposition,
        exclusion_rationale as exclusionRationale
      from artifact_version_sources
      where artifact_id = ${sqlString(artifactId)} and version = ${Math.floor(version)}
      order by submitted_at asc, draft_id asc;
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
    const artifacts = `(select id from artifacts where conversation_id = ${sqlString(conversationId)})`;
    await this.runSql(`
      begin immediate;
      insert or ignore into artifact_conversation_tombstones (conversation_id, deleted_at)
      values (${sqlString(conversationId)}, ${sqlString(new Date().toISOString())});
      delete from artifact_version_sources where artifact_id in ${artifacts};
      delete from artifact_signatures where artifact_id in ${artifacts};
      delete from artifact_versions where artifact_id in ${artifacts};
      delete from artifact_drafts where artifact_id in ${artifacts};
      delete from artifact_event_outbox where conversation_id = ${sqlString(conversationId)};
      delete from artifact_operations where conversation_id = ${sqlString(conversationId)};
      delete from artifacts where conversation_id = ${sqlString(conversationId)};
      commit;
    `);
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
      updatedAt: row.updatedAt
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

  private async runSql(sql: string): Promise<void> {
    await runCommand("sqlite3", this.sqliteArgs([this.dbPath]), {
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
    return ["-bail", "-cmd", `.timeout ${SQLITE_BUSY_TIMEOUT_MS}`, ...args];
  }
}

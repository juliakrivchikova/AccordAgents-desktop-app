import { createHash, randomUUID } from "node:crypto";
import type { ArtifactVersionRecord } from "./artifactStore";

export interface ArtifactRevision extends ArtifactVersionRecord {
  versionEventId: string;
  contentHash: string;
}

export const ARTIFACT_REVISION_SCHEMA = `
  create table if not exists artifact_revisions (
    version_event_id text primary key,
    artifact_id text not null,
    original_version integer not null,
    base_version_event_id text,
    content_hash text not null,
    content text not null,
    author text not null,
    note text,
    created_at text not null
  );
  create index if not exists idx_artifact_revisions_artifact on artifact_revisions(artifact_id);
  create trigger if not exists artifact_revision_immutable before update on artifact_revisions
    begin select raise(abort, 'Artifact revisions are immutable; change their projection instead.'); end;
  create table if not exists artifact_version_projection (
    artifact_id text not null,
    version integer not null,
    version_event_id text not null references artifact_revisions(version_event_id),
    primary key(artifact_id, version),
    unique(artifact_id, version_event_id)
  );
  create table if not exists artifact_bound_signatures (
    artifact_id text not null,
    version_event_id text not null references artifact_revisions(version_event_id),
    content_hash text not null,
    signer text not null,
    signed_at text not null,
    primary key(artifact_id, version_event_id, signer)
  );
  create table if not exists artifact_bound_sources (
    artifact_id text not null,
    version_event_id text not null references artifact_revisions(version_event_id),
    draft_id text not null,
    author text not null,
    submitted_at text not null,
    content_hash text not null,
    disposition text not null,
    exclusion_rationale text,
    primary key(artifact_id, version_event_id, draft_id)
  );
  create table if not exists artifact_revision_migration (id integer primary key check(id = 1));
`;

export function artifactRevision(record: ArtifactVersionRecord, eventId?: string): ArtifactRevision {
  const contentHash = createHash("sha256").update(record.content, "utf8").digest("hex");
  if (record.contentHash && record.contentHash !== contentHash) throw new Error("Artifact content does not match its immutable hash.");
  return { ...record, baseVersionEventId: record.baseVersionEventId ?? undefined,
    versionEventId: record.versionEventId ?? eventId ?? randomUUID(), contentHash };
}

export function revisionInsertSql(record: ArtifactRevision, predicate = "1"): string {
  return `insert into artifact_revisions(version_event_id, artifact_id, original_version, base_version_event_id, content_hash, content, author, note, created_at)
    select ${q(record.versionEventId)}, ${q(record.artifactId)}, ${Math.floor(record.version)}, ${q(record.baseVersionEventId)}, ${q(record.contentHash)}, ${q(record.content)},
      ${q(record.author)}, ${q(record.note)}, ${q(record.createdAt)} where ${predicate};`;
}

export function revisionProjectionInsertSql(record: ArtifactRevision): string {
  return `insert into artifact_version_projection(artifact_id, version, version_event_id)
    select artifact_id, ${Math.floor(record.version)}, version_event_id from artifact_revisions
    where version_event_id = ${q(record.versionEventId)} and artifact_id = ${q(record.artifactId)};`;
}

/** Upgrade a drained legacy store in bounded reads. Each copied revision is
 * restartable; signatures/sources and the completion marker commit together.
 * The old tables are retained read-only for recovery, never used for new writes. */
export async function migrateArtifactRevisions(database: { query<T>(sql: string): Promise<T[]>; execute(sql: string): Promise<void> }): Promise<void> {
  await database.execute(ARTIFACT_REVISION_SCHEMA);
  if ((await database.query<{ id: number }>("select id from artifact_revision_migration where id = 1;")).length) return;
  for (;;) {
    if ((await database.query<{ id: number }>("select id from artifact_revision_migration where id = 1;")).length) return;
    const rows = await database.query<ArtifactVersionRecord>(`select v.artifact_id as artifactId, v.version, v.content, v.author, v.note, v.created_at as createdAt
      from artifact_versions v join artifacts a on a.id = v.artifact_id
      left join artifact_version_projection p on p.artifact_id = v.artifact_id and p.version = v.version
      where p.version_event_id is null order by v.artifact_id, v.version limit 1;`);
    if (!rows.length) break;
    const row = rows[0];
    if (row.version > 1) {
      const parent = await database.query<{ id: string }>(`select version_event_id as id from artifact_version_projection where artifact_id = ${q(row.artifactId)} and version = ${row.version - 1};`);
      if (!parent[0]) throw new Error("The legacy artifact history has a missing parent revision.");
      row.baseVersionEventId = parent[0].id;
    }
    const hash = createHash("sha256").update(JSON.stringify([row.artifactId, row.version, row.content, row.author, row.note ?? null, row.createdAt])).digest("hex");
    const revision = artifactRevision(row, `legacy-artifact-version:${hash}`);
    await database.execute(`begin immediate;
      ${revisionInsertSql(revision, `not exists(select 1 from artifact_revision_migration) and not exists(select 1 from artifact_revisions where version_event_id = ${q(revision.versionEventId)})`)}
      insert or ignore into artifact_version_projection(artifact_id, version, version_event_id)
      select ${q(row.artifactId)}, ${Math.floor(row.version)}, ${q(revision.versionEventId)} where not exists(select 1 from artifact_revision_migration);
      commit;`);
  }
  await database.execute(`begin immediate;
    create temp table migration_guard(valid integer check(valid = 1));
    insert into migration_guard select case when exists(select 1 from artifact_revision_migration) or not exists(
      select 1 from artifact_versions v join artifacts a on a.id = v.artifact_id
      left join artifact_version_projection p on p.artifact_id = v.artifact_id and p.version = v.version
      where p.version_event_id is null
    ) then 1 else 0 end;
    insert or ignore into artifact_bound_signatures(artifact_id, version_event_id, content_hash, signer, signed_at)
      select s.artifact_id, r.version_event_id, r.content_hash, s.signer, s.signed_at from artifact_signatures s
      join artifact_version_projection p on p.artifact_id = s.artifact_id and p.version = s.version
      join artifact_revisions r on r.version_event_id = p.version_event_id
      where not exists(select 1 from artifact_revision_migration);
    insert or ignore into artifact_bound_sources(artifact_id, version_event_id, draft_id, author, submitted_at, content_hash, disposition, exclusion_rationale)
      select s.artifact_id, p.version_event_id, s.draft_id, s.author, s.submitted_at, s.content_hash, s.disposition, s.exclusion_rationale
      from artifact_version_sources s join artifact_version_projection p on p.artifact_id = s.artifact_id and p.version = s.version
      where not exists(select 1 from artifact_revision_migration);
    update artifact_operations as o set result_json = json_set(o.result_json,
      '$.value.version.versionEventId', r.version_event_id, '$.value.version.contentHash', r.content_hash)
      from artifact_version_projection p join artifact_revisions r on r.version_event_id = p.version_event_id
      where not exists(select 1 from artifact_revision_migration) and o.operation_kind = 'publish_v1'
        and p.artifact_id = o.artifact_id and p.version = json_extract(o.result_json, '$.value.version.version')
        and r.content = json_extract(o.result_json, '$.value.version.content')
        and json_extract(o.result_json, '$.value.version.versionEventId') is null;
    insert or ignore into artifact_revision_migration(id) values (1);
    create trigger if not exists artifact_legacy_versions_insert before insert on artifact_versions
      begin select raise(abort, 'This database uses immutable artifact revisions; upgrade AccordAgents.'); end;
    create trigger if not exists artifact_legacy_versions_update before update on artifact_versions
      begin select raise(abort, 'This database uses immutable artifact revisions; upgrade AccordAgents.'); end;
    create trigger if not exists artifact_legacy_signatures_insert before insert on artifact_signatures
      begin select raise(abort, 'This database uses content-bound signatures; upgrade AccordAgents.'); end;
    create trigger if not exists artifact_legacy_signatures_update before update on artifact_signatures
      begin select raise(abort, 'This database uses content-bound signatures; upgrade AccordAgents.'); end;
    commit;`);
}

function q(value: string | undefined | null): string { return value == null ? "NULL" : `'${value.replace(/'/g, "''")}'`; }

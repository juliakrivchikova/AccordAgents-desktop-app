import { artifactRevision, revisionInsertSql, revisionProjectionInsertSql, type ArtifactRevision } from "../artifactRevisions";
import type { ArtifactVersionSourceRow } from "./artifactRows";
import { sqlString } from "./sqlText";
import type {
  ArtifactEventRecord, ArtifactSignatureRecord, ArtifactVersionMetaRecord, ArtifactVersionRecord, ArtifactVersionSourceRecord
} from "./types";
import type { ArtifactStoreModules } from "./modules";

/** A document's versions and who signed them. */
export class ArtifactVersions {
  constructor(private readonly store: Pick<ArtifactStoreModules, "artifactDatabase">) {}

  async getVersion(artifactId: string, version: number): Promise<ArtifactRevision | undefined> {
    await this.store.artifactDatabase.init();
    const rows = await this.store.artifactDatabase.queryJson<ArtifactRevision & { note: string | null }>(
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
    await this.store.artifactDatabase.init();
    const rows = await this.store.artifactDatabase.queryJson<ArtifactVersionMetaRecord & { note: string | null }>(
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
    await this.store.artifactDatabase.init();
    const rows = await this.store.artifactDatabase.queryJson<ArtifactRevision & { superseded: number; note: string | null }>(`
      select r.artifact_id as artifactId, coalesce(p.version, r.original_version) as version,
        r.version_event_id as versionEventId, r.content_hash as contentHash, r.base_version_event_id as baseVersionEventId, r.content, r.author, r.note,
        r.created_at as createdAt, p.version is null as superseded
      from artifact_revisions r left join artifact_version_projection p on p.version_event_id = r.version_event_id
      where r.artifact_id = ${sqlString(artifactId)} and r.version_event_id = ${sqlString(versionEventId)};`);
    const row = rows[0];
    return row ? { ...artifactRevision({ ...row, note: row.note ?? undefined }), superseded: Boolean(row.superseded) } : undefined;
  }

  async listSignatures(artifactId: string): Promise<ArtifactSignatureRecord[]> {
    await this.store.artifactDatabase.init();
    return this.store.artifactDatabase.queryJson<ArtifactSignatureRecord>(
      `
        select s.artifact_id as artifactId, p.version, s.version_event_id as versionEventId, s.content_hash as contentHash,
          s.signer, s.signed_at as signedAt
        from artifact_bound_signatures s join artifact_revisions r on r.version_event_id = s.version_event_id and r.content_hash = s.content_hash
        left join artifact_version_projection p on p.artifact_id = s.artifact_id and p.version_event_id = s.version_event_id
        where s.artifact_id = ${sqlString(artifactId)} order by p.version asc, s.signed_at asc;
      `
    );
  }

  /** Whether any chat has a document for two or more signers (or draft
   *  authors), and whether one has its newest version signed by every one of
   *  them; and whether a document for fewer signers exists (`plain`). With
   *  `since`, only a document made since then counts as started or plain,
   *  and only one whose last signature came since then as signed (a copy of
   *  an older document from the server does not). Over the documents' own
   *  small tables; no body is read. */
  async multiSignerDocumentStatus(since?: string, plainSince: string | undefined = since): Promise<{ started: boolean; signed: boolean; plain: boolean }> {
    await this.store.artifactDatabase.init();
    const afterMoment = (column: string, moment: string | undefined) => (moment ? `and julianday(${column}) >= julianday(${sqlString(moment)})` : "");
    const after = (column: string) => afterMoment(column, since);
    const headSignature = `
      select 1 from artifact_bound_signatures s
      join artifact_version_projection p on p.artifact_id = s.artifact_id and p.version_event_id = s.version_event_id
      join artifact_revisions r on r.version_event_id = s.version_event_id and r.content_hash = s.content_hash
      where s.artifact_id = a.id and p.version = a.head_version`;
    const rows = await this.store.artifactDatabase.queryJson<{ started: number; signed: number; plain: number }>(
      `
        select
          exists(
            select 1 from artifacts a
            where (json_array_length(a.required_signers_json) >= 2 or json_array_length(a.required_draft_authors_json) >= 2)
              ${after("a.created_at")}
          ) as started,
          exists(
            select 1 from artifacts a
            where a.lifecycle = 'published' and json_array_length(a.required_signers_json) >= 2
              and not exists (
                select 1 from json_each(a.required_signers_json) required
                where not exists (${headSignature} and s.signer = required.value)
              )
              ${since ? `and exists (${headSignature} and s.signer in (select value from json_each(a.required_signers_json)) ${after("s.signed_at")})` : ""}
          ) as signed,
          exists(
            select 1 from artifacts a
            where json_array_length(a.required_signers_json) < 2 and json_array_length(a.required_draft_authors_json) < 2
              ${afterMoment("a.created_at", plainSince)}
          ) as plain;
      `
    );
    return { started: Number(rows[0]?.started) === 1, signed: Number(rows[0]?.signed) === 1, plain: Number(rows[0]?.plain) === 1 };
  }

  async listHeadSignaturesByArtifact(conversationId: string): Promise<Map<string, ArtifactSignatureRecord[]>> {
    await this.store.artifactDatabase.init();
    const rows = await this.store.artifactDatabase.queryJson<ArtifactSignatureRecord>(
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
    await this.store.artifactDatabase.init();
    const id = sqlString(record.artifactId);
    const base = await this.getVersion(record.artifactId, expectedHeadVersion);
    if (!base || (record.baseVersionEventId && record.baseVersionEventId !== base.versionEventId)) return false;
    const revision = artifactRevision({ ...record, baseVersionEventId: base.versionEventId }, event?.id);
    const expected = Math.floor(expectedHeadVersion);
    const version = Math.floor(record.version);
    const output = await this.store.artifactDatabase.queryText(`
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
    await this.store.artifactDatabase.init();
    const output = await this.store.artifactDatabase.queryText(`
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

  async listVersionSources(artifactId: string, version: number): Promise<ArtifactVersionSourceRecord[]> {
    await this.store.artifactDatabase.init();
    const rows = await this.store.artifactDatabase.queryJson<ArtifactVersionSourceRow>(`
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
}

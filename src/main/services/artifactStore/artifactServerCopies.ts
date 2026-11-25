import { artifactRevision, revisionInsertSql, type ArtifactRevision } from "../artifactRevisions";
import { artifactNameKey } from "../../../shared/artifacts";
import type { HubArtifactImportRows, HubArtifactRevision, HubArtifactState } from "../../../shared/hubOps";
import { type ArtifactDraftRow, DRAFT_SELECT } from "./artifactRows";
import { deleteByConversationSql, draftFromRow } from "./artifactSql";
import {
  draftInsertSql, forgetSql, hubDraft, hubRecord, REVISION_META_COLUMNS, revisionMeta, type RevisionMetaRow, serverStateProblem
} from "./serverRecords";
import { sqlString } from "./sqlText";
import type { ArtifactRecord } from "./types";
import type { ArtifactStoreModules } from "./modules";

/** What the User's server keeps of documents. */
export class ArtifactServerCopies {
  constructor(private readonly store: Pick<ArtifactStoreModules, "artifactDatabase" | "artifactRecords">) {}

  async deleteByConversation(conversationId: string): Promise<void> {
    await this.store.artifactDatabase.init();
    await this.store.artifactDatabase.runSql(`begin immediate; ${deleteByConversationSql(conversationId, new Date().toISOString())} commit;`);
  }

  // --- the server's documents, whole -----------------------------------------

  /** One document as the server holds it, without revision bodies. */
  async serverState(artifactId: string): Promise<HubArtifactState | undefined> {
    const record = await this.store.artifactRecords.getById(artifactId);
    return record ? (await this.statesOf([record]))[0] : undefined;
  }

  /** Every document of a chat, without revision bodies. */
  async serverStates(conversationId: string): Promise<HubArtifactState[]> {
    return this.statesOf(await this.store.artifactRecords.listByConversation(conversationId));
  }

  private async statesOf(records: ArtifactRecord[]): Promise<HubArtifactState[]> {
    if (records.length === 0) return [];
    await this.store.artifactDatabase.init();
    const states = new Map<string, HubArtifactState>(records.map((record) => [record.id, {
      record: hubRecord(record), revisions: [], projection: [], signatures: [], sources: [], drafts: []
    }]));
    // A chat's documents are read in a few statements, not five per document.
    for (let start = 0; start < records.length; start += 200) {
      const ids = records.slice(start, start + 200).map((record) => sqlString(record.id)).join(", ");
      const revisions = await this.store.artifactDatabase.queryJson<RevisionMetaRow>(`select ${REVISION_META_COLUMNS} from artifact_revisions
        where artifact_id in (${ids}) order by artifact_id, original_version, created_at, version_event_id;`);
      for (const row of revisions) states.get(row.artifactId)?.revisions.push(revisionMeta(row));
      const projection = await this.store.artifactDatabase.queryJson<{ artifactId: string; version: number; versionEventId: string }>(`select artifact_id as artifactId,
        version, version_event_id as versionEventId from artifact_version_projection where artifact_id in (${ids}) order by artifact_id, version;`);
      for (const row of projection) states.get(row.artifactId)?.projection.push({ version: Number(row.version), versionEventId: row.versionEventId });
      const signatures = await this.store.artifactDatabase.queryJson<{ artifactId: string; versionEventId: string; contentHash: string; signer: string; signedAt: string }>(`select
        artifact_id as artifactId, version_event_id as versionEventId, content_hash as contentHash, signer, signed_at as signedAt
        from artifact_bound_signatures where artifact_id in (${ids}) order by artifact_id, signed_at, signer;`);
      for (const { artifactId, ...row } of signatures) states.get(artifactId)?.signatures.push(row);
      const sources = await this.store.artifactDatabase.queryJson<{ artifactId: string; versionEventId: string; draftId: string; author: string; submittedAt: string;
        contentHash: string; disposition: "considered" | "excluded"; exclusionRationale: string | null }>(`select artifact_id as artifactId,
        version_event_id as versionEventId, draft_id as draftId, author, submitted_at as submittedAt, content_hash as contentHash, disposition,
        exclusion_rationale as exclusionRationale from artifact_bound_sources where artifact_id in (${ids}) order by artifact_id, submitted_at, draft_id;`);
      for (const { artifactId, exclusionRationale, ...row } of sources) {
        states.get(artifactId)?.sources.push({ ...row, ...(exclusionRationale ? { exclusionRationale } : {}) });
      }
      const drafts = await this.store.artifactDatabase.queryJson<ArtifactDraftRow>(`${DRAFT_SELECT} where artifact_id in (${ids}) order by artifact_id, created_at, id;`);
      for (const row of drafts) states.get(row.artifactId)?.drafts.push(hubDraft(draftFromRow(row)));
    }
    return records.map((record) => states.get(record.id)!);
  }

  /** One revision with its body, whether or not it shows a number now. */
  async revisionWithContent(artifactId: string, versionEventId: string): Promise<HubArtifactRevision | undefined> {
    await this.store.artifactDatabase.init();
    const rows = await this.store.artifactDatabase.queryJson<RevisionMetaRow & { content: string }>(`select ${REVISION_META_COLUMNS}, content from artifact_revisions
      where artifact_id = ${sqlString(artifactId)} and version_event_id = ${sqlString(versionEventId)};`);
    return rows[0] ? { ...revisionMeta(rows[0]), content: rows[0].content } : undefined;
  }

  /** Which of these revisions this copy already holds, with their hashes. */
  async heldRevisions(versionEventIds: string[]): Promise<Map<string, string>> {
    const held = new Map<string, string>();
    if (versionEventIds.length === 0) return held;
    await this.store.artifactDatabase.init();
    for (let start = 0; start < versionEventIds.length; start += 500) {
      const rows = await this.store.artifactDatabase.queryJson<{ id: string; hash: string }>(`select version_event_id as id, content_hash as hash from artifact_revisions
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
    await this.store.artifactDatabase.init();
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
          created_at, updated_at, archived_at, origin_message_id)
        values (${id}, ${chat}, ${sqlString(record.name)}, ${sqlString(artifactNameKey(record.name))}, ${sqlString(record.owner)},
          ${sqlString(JSON.stringify(record.contributors))}, ${sqlString(JSON.stringify(record.requiredSigners))}, ${sqlString(JSON.stringify(record.labels))},
          ${sqlString(record.lifecycle)}, ${sqlString(JSON.stringify(record.allowedDraftAuthors))}, ${sqlString(JSON.stringify(record.requiredDraftAuthors))},
          ${sqlString(JSON.stringify(record.audiencePolicyByAuthor))}, ${Math.floor(record.draftRosterRevision)}, ${Math.floor(record.headVersion)},
          ${sqlString(record.createdAt)}, ${sqlString(record.updatedAt)}, ${sqlString(record.archivedAt)},
          ${sqlString(record.originMessageId)})
        on conflict(id) do update set name = excluded.name, name_key = excluded.name_key, owner = excluded.owner,
          contributors_json = excluded.contributors_json, required_signers_json = excluded.required_signers_json, labels_json = excluded.labels_json,
          lifecycle = excluded.lifecycle, allowed_draft_authors_json = excluded.allowed_draft_authors_json,
          required_draft_authors_json = excluded.required_draft_authors_json, audience_policy_json = excluded.audience_policy_json,
          draft_roster_revision = excluded.draft_roster_revision, head_version = excluded.head_version, created_at = excluded.created_at,
          updated_at = excluded.updated_at, archived_at = excluded.archived_at,
          origin_message_id = excluded.origin_message_id
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
    await this.store.artifactDatabase.runSql(`begin immediate;
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
    await this.store.artifactDatabase.init();
    await this.store.artifactDatabase.runSql(`begin immediate; ${forgetSql(`(${sqlString(artifactId)})`)} commit;`);
  }

  async isConversationDeleted(conversationId: string): Promise<boolean> {
    await this.store.artifactDatabase.init();
    const rows = await this.store.artifactDatabase.queryJson<{ one: number }>(`select 1 as one from artifact_conversation_tombstones where conversation_id = ${sqlString(conversationId)};`);
    return rows.length > 0;
  }

  /** Every row of a chat's documents, as the computer moves them to the
   *  server (one time): revisions with their bodies, and the operations
   *  that keep a repeated operation id answering the same. */
  async exportConversation(conversationId: string): Promise<Required<HubArtifactImportRows>> {
    await this.store.artifactDatabase.init();
    const records = await this.store.artifactRecords.listByConversation(conversationId);
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
    const operations = await this.store.artifactDatabase.queryJson<{ artifactId: string | null; actor: string; operationKind: string; operationId: string; requestHash: string;
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
    await this.store.artifactDatabase.init();
    const chat = sqlString(conversationId);
    const statements: string[] = [];
    const refused: string[] = [];
    const artifactIds = new Set<string>();
    const existing = new Map((await this.store.artifactRecords.listByConversation(conversationId)).map((record) => [artifactNameKey(record.name), record.id]));
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
          created_at, updated_at, archived_at, origin_message_id)
        values (${sqlString(record.id)}, ${chat}, ${sqlString(name)}, ${sqlString(artifactNameKey(name))}, ${sqlString(record.owner)},
          ${sqlString(JSON.stringify(record.contributors))}, ${sqlString(JSON.stringify(record.requiredSigners))}, ${sqlString(JSON.stringify(record.labels))},
          ${sqlString(record.lifecycle)}, ${sqlString(JSON.stringify(record.allowedDraftAuthors))}, ${sqlString(JSON.stringify(record.requiredDraftAuthors))},
          ${sqlString(JSON.stringify(record.audiencePolicyByAuthor))}, ${Math.floor(record.draftRosterRevision)}, ${Math.floor(record.headVersion)},
          ${sqlString(record.createdAt)}, ${sqlString(record.updatedAt)}, ${sqlString(record.archivedAt)},
          ${sqlString(record.originMessageId)});`);
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
    await this.store.artifactDatabase.init();
    await this.store.artifactDatabase.runSql(`begin immediate; ${sql} commit;`);
  }
}

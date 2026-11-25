import type { ArtifactRevision } from "./artifactRevisions";
import type { HubArtifactImportRows, HubArtifactRevision, HubArtifactState } from "../../shared/hubOps";
import { deleteByConversationSql, operationCommittedSql } from "./artifactStore/artifactSql";
import type {
  ArtifactDraftRecord, ArtifactEventRecord, ArtifactOperationRecord, ArtifactRecord, ArtifactSignatureRecord, ArtifactSqlExecutor,
  ArtifactVersionMetaRecord, ArtifactVersionRecord, ArtifactVersionSourceRecord
} from "./artifactStore/types";
import { createArtifactStoreModules, type ArtifactStoreModules } from "./artifactStore/modules";

export type { ArtifactSqlExecutor, ArtifactRecord, ArtifactDraftRecord, ArtifactVersionSourceRecord, ArtifactOperationRecord, ArtifactEventRecord, ArtifactVersionRecord, ArtifactVersionMetaRecord, ArtifactSignatureRecord } from "./artifactStore/types";
export { serverStateProblem } from "./artifactStore/serverRecords";

/** Documents in the database. The work is done by the parts in ./artifactStore. */
export class ArtifactStore {
  private readonly modules: ArtifactStoreModules;

  constructor(dbPath: string, sqliteExecutable = "sqlite3", executor?: ArtifactSqlExecutor) {
    this.modules = createArtifactStoreModules({ dbPath, sqliteExecutable, executor });
  }

  /** Local edits and incoming events in this runtime share one queue.
   * Independent runtimes remain guarded by SQLite preconditions. */
  withMutation<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
    return this.modules.artifactOperations.withMutation(conversationId, fn);
  }

  init(): Promise<void> {
    return this.modules.artifactDatabase.init();
  }

  insertArtifact(
    record: ArtifactRecord,
    nameKey: string,
    firstVersion: ArtifactVersionRecord,
    event?: ArtifactEventRecord,
    alsoCommitSql?: string
  ): Promise<boolean> {
    return this.modules.artifactRecords.insertArtifact(record, nameKey, firstVersion, event, alsoCommitSql);
  }

  insertCollectingArtifact(
    record: ArtifactRecord,
    nameKey: string,
    operation: ArtifactOperationRecord,
    event: ArtifactEventRecord,
    alsoCommitSql?: string
  ): Promise<boolean> {
    return this.modules.artifactRecords.insertCollectingArtifact(record, nameKey, operation, event, alsoCommitSql);
  }

  getById(id: string): Promise<ArtifactRecord | undefined> {
    return this.modules.artifactRecords.getById(id);
  }

  operationCommittedSql(operation: ArtifactOperationRecord): string {
    return operationCommittedSql(operation);
  }

  getByName(conversationId: string, nameKey: string): Promise<ArtifactRecord | undefined> {
    return this.modules.artifactRecords.getByName(conversationId, nameKey);
  }

  listByConversation(conversationId: string): Promise<ArtifactRecord[]> {
    return this.modules.artifactRecords.listByConversation(conversationId);
  }

  getVersion(artifactId: string, version: number): Promise<ArtifactRevision | undefined> {
    return this.modules.artifactVersions.getVersion(artifactId, version);
  }

  listVersionMetas(artifactId: string): Promise<ArtifactVersionMetaRecord[]> {
    return this.modules.artifactVersions.listVersionMetas(artifactId);
  }

  /** An immutable revision remains readable even when it loses its displayed
   * number during projection. Its signatures continue to name this identity. */
  getRevision(artifactId: string, versionEventId: string): Promise<(ArtifactRevision & { superseded: boolean }) | undefined> {
    return this.modules.artifactVersions.getRevision(artifactId, versionEventId);
  }

  listSignatures(artifactId: string): Promise<ArtifactSignatureRecord[]> {
    return this.modules.artifactVersions.listSignatures(artifactId);
  }

  /** Whether any chat has a document for two or more signers (or draft
   *  authors), and whether one has its newest version signed by every one of
   *  them; and whether a document for fewer signers exists (`plain`). With
   *  `since`, only a document made since then counts as started or plain,
   *  and only one whose last signature came since then as signed (a copy of
   *  an older document from the server does not). Over the documents' own
   *  small tables; no body is read. */
  multiSignerDocumentStatus(since?: string, plainSince: string | undefined = since): Promise<{ started: boolean; signed: boolean; plain: boolean }> {
    return this.modules.artifactVersions.multiSignerDocumentStatus(since, plainSince);
  }

  listHeadSignaturesByArtifact(conversationId: string): Promise<Map<string, ArtifactSignatureRecord[]>> {
    return this.modules.artifactVersions.listHeadSignaturesByArtifact(conversationId);
  }

  // Append a new head version guarded by the expected current head. Returns
  // true only when THIS call performed the write. Comparing the resulting head
  // to the target version is not enough: a competing writer racing to the same
  // target would make the loser look successful and silently drop its content.
  // Instead the guarded update runs inside one immediate transaction and
  // `changes()` reports whether this writer's update took effect.
  appendVersion(
    record: ArtifactVersionRecord,
    expectedHeadVersion: number,
    event?: ArtifactEventRecord,
    /** Statements committed with this change, so the two are one transaction.
     *  A caller uses it for the chat event that makes the change visible to
     *  other peers: a failure here loses both, never one. */
    alsoCommitSql?: string
  ): Promise<boolean> {
    return this.modules.artifactVersions.appendVersion(record, expectedHeadVersion, event, alsoCommitSql);
  }

  updateName(
    id: string,
    name: string,
    nameKey: string,
    updatedAt: string,
    event?: ArtifactEventRecord,
    alsoCommitSql?: string
  ): Promise<void> {
    return this.modules.artifactRecords.updateName(id, name, nameKey, updatedAt, event, alsoCommitSql);
  }

  updateAccess(
    id: string,
    access: { owner: string; contributors: string[]; requiredSigners: string[]; labels: string[] },
    updatedAt: string,
    alsoCommitSql?: string
  ): Promise<void> {
    return this.modules.artifactRecords.updateAccess(id, access, updatedAt, alsoCommitSql);
  }

  // Idempotent: returns true when the signature was newly recorded, false when
  // this signer had already signed this version.
  insertSignature(
    record: ArtifactSignatureRecord,
    event?: ArtifactEventRecord,
    /** Committed with the signature, for the same reason as `appendVersion`. */
    alsoCommitSql?: string,
    /** A signed event records a past action, whose authorization was checked
     * at its origin. Later archive/access changes cannot erase that fact. */
    historical = false
  ): Promise<boolean> {
    return this.modules.artifactVersions.insertSignature(record, event, alsoCommitSql, historical);
  }

  touch(id: string, updatedAt: string): Promise<void> {
    return this.modules.artifactRecords.touch(id, updatedAt);
  }

  updateArchived(
    id: string,
    archivedAt: string | undefined,
    updatedAt: string,
    event?: ArtifactEventRecord,
    alsoCommitSql?: string
  ): Promise<void> {
    return this.modules.artifactRecords.updateArchived(id, archivedAt, updatedAt, event, alsoCommitSql);
  }

  getOperation(
    conversationId: string,
    actor: string,
    operationKind: string,
    operationId: string
  ): Promise<(ArtifactOperationRecord & { applied: boolean }) | undefined> {
    return this.modules.artifactOperations.getOperation(conversationId, actor, operationKind, operationId);
  }

  listDrafts(artifactId: string): Promise<ArtifactDraftRecord[]> {
    return this.modules.artifactDraftRecords.listDrafts(artifactId);
  }

  getDraft(draftId: string): Promise<ArtifactDraftRecord | undefined> {
    return this.modules.artifactDraftRecords.getDraft(draftId);
  }

  saveDraft(
    record: ArtifactDraftRecord,
    expectedEditRevision: number,
    expectedRosterRevision: number,
    operation: ArtifactOperationRecord,
    alsoCommitSql?: string
  ): Promise<boolean> {
    return this.modules.artifactDraftRecords.saveDraft(record, expectedEditRevision, expectedRosterRevision, operation, alsoCommitSql);
  }

  submitDraft(
    draft: ArtifactDraftRecord,
    expectedEditRevision: number,
    expectedRosterRevision: number,
    operation: ArtifactOperationRecord,
    event: ArtifactEventRecord,
    alsoCommitSql?: string
  ): Promise<boolean> {
    return this.modules.artifactDraftRecords.submitDraft(draft, expectedEditRevision, expectedRosterRevision, operation, event, alsoCommitSql);
  }

  withdrawDraft(
    draft: ArtifactDraftRecord,
    expectedRosterRevision: number,
    operation: ArtifactOperationRecord,
    event: ArtifactEventRecord,
    alsoCommitSql?: string
  ): Promise<boolean> {
    return this.modules.artifactDraftRecords.withdrawDraft(draft, expectedRosterRevision, operation, event, alsoCommitSql);
  }

  updateDraftRoster(
    artifactId: string,
    expectedRevision: number,
    roster: Pick<ArtifactRecord, "allowedDraftAuthors" | "requiredDraftAuthors" | "audiencePolicyByAuthor">,
    updatedAt: string,
    operation: ArtifactOperationRecord,
    alsoCommitSql?: string
  ): Promise<boolean> {
    return this.modules.artifactDraftRecords.updateDraftRoster(artifactId, expectedRevision, roster, updatedAt, operation, alsoCommitSql);
  }

  publishFirstVersion(
    artifact: ArtifactRecord,
    version: ArtifactVersionRecord,
    sources: ArtifactVersionSourceRecord[],
    requiredSigners: string[],
    operation: ArtifactOperationRecord,
    event: ArtifactEventRecord,
    alsoCommitSql?: string
  ): Promise<boolean> {
    return this.modules.artifactDraftRecords.publishFirstVersion(artifact, version, sources, requiredSigners, operation, event, alsoCommitSql);
  }

  listVersionSources(artifactId: string, version: number): Promise<ArtifactVersionSourceRecord[]> {
    return this.modules.artifactVersions.listVersionSources(artifactId, version);
  }

  listPendingEvents(
    limit = 100,
    after?: Pick<ArtifactEventRecord, "createdAt" | "id">
  ): Promise<ArtifactEventRecord[]> {
    return this.modules.artifactOperations.listPendingEvents(limit, after);
  }

  markEventDelivered(id: string, deliveredAt: string): Promise<void> {
    return this.modules.artifactOperations.markEventDelivered(id, deliveredAt);
  }

  deleteByConversation(conversationId: string): Promise<void> {
    return this.modules.artifactServerCopies.deleteByConversation(conversationId);
  }

  /** The statements that delete a chat's documents and keep them deleted (a
   *  late write for the chat is refused by the tombstone), to commit with
   *  the chat's own deletion. */
  deleteByConversationSql(conversationId: string, deletedAt: string): string {
    return deleteByConversationSql(conversationId, deletedAt);
  }

  // --- the server's documents, whole -----------------------------------------

  /** One document as the server holds it, without revision bodies. */
  serverState(artifactId: string): Promise<HubArtifactState | undefined> {
    return this.modules.artifactServerCopies.serverState(artifactId);
  }

  /** Every document of a chat, without revision bodies. */
  serverStates(conversationId: string): Promise<HubArtifactState[]> {
    return this.modules.artifactServerCopies.serverStates(conversationId);
  }

  /** One revision with its body, whether or not it shows a number now. */
  revisionWithContent(artifactId: string, versionEventId: string): Promise<HubArtifactRevision | undefined> {
    return this.modules.artifactServerCopies.revisionWithContent(artifactId, versionEventId);
  }

  /** Which of these revisions this copy already holds, with their hashes. */
  heldRevisions(versionEventIds: string[]): Promise<Map<string, string>> {
    return this.modules.artifactServerCopies.heldRevisions(versionEventIds);
  }

  /**
   * Makes this copy hold documents exactly as the server holds them: each
   * state replaces this copy's document of that id (its fields, revisions,
   * numbering, signatures, sources and drafts), in one commit. With
   * `replaceConversation`, documents of the chat the server did not list go.
   * `bodies` are the revisions this copy did not hold yet. A chat deleted
   * here keeps nothing.
   */
  applyServerStates(
    conversationId: string,
    states: HubArtifactState[],
    bodies: Map<string, HubArtifactRevision>,
    options: { replaceConversation?: boolean; forget?: string[]; keep?: string[] } = {}
  ): Promise<void> {
    return this.modules.artifactServerCopies.applyServerStates(conversationId, states, bodies, options);
  }

  /** Drops this copy of one document (the server no longer has it). */
  forgetArtifact(artifactId: string): Promise<void> {
    return this.modules.artifactServerCopies.forgetArtifact(artifactId);
  }

  isConversationDeleted(conversationId: string): Promise<boolean> {
    return this.modules.artifactServerCopies.isConversationDeleted(conversationId);
  }

  /** Every row of a chat's documents, as the computer moves them to the
   *  server (one time): revisions with their bodies, and the operations
   *  that keep a repeated operation id answering the same. */
  exportConversation(conversationId: string): Promise<Required<HubArtifactImportRows>> {
    return this.modules.artifactServerCopies.exportConversation(conversationId);
  }

  /**
   * The statements that keep a page of documents moved from the computer,
   * exactly as they were (ids, revision ids and hashes, numbering,
   * signatures, sources, drafts, operations). What the server holds already
   * stays. A moved document whose name another document already took here
   * keeps its rows under a free name. Returns the documents the page names
   * and the rows refused (a revision whose body does not match its hash).
   */
  importSql(conversationId: string, rows: HubArtifactImportRows): Promise<{ sql: string; artifactIds: string[]; refused: string[] }> {
    return this.modules.artifactServerCopies.importSql(conversationId, rows);
  }

  /** Runs statements in one commit (the server: a change and its place in
   *  the order together). */
  commitSql(sql: string): Promise<void> {
    return this.modules.artifactServerCopies.commitSql(sql);
  }
}

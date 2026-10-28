import { normalizeArtifactMember } from "../../shared/artifacts";
import {
  isHubArtifactOpKind,
  isHubChatId,
  type HubArtifactAnswer,
  type HubArtifactImportRows,
  type HubArtifactNote,
  type HubArtifactOpKind,
  type HubArtifactRevision,
  type HubArtifactState,
  type HubFeedEntry,
  type HubOp,
  type HubOpEffect
} from "../../shared/hubOps";
import type {
  ArtifactDiffResult,
  ArtifactDraftContent,
  ArtifactDraftSummary,
  ArtifactDraftView,
  ArtifactError,
  ArtifactReadResult,
  ArtifactResult,
  ArtifactSummary,
  CollectingArtifactReadResult,
  CreateArtifactRequest,
  DiffArtifactRequest,
  ListArtifactDraftsRequest,
  PublishArtifactRequest,
  PublishedArtifactReadResult,
  ReadArtifactDraftRequest,
  ReadArtifactRequest,
  RenameArtifactRequest,
  ReplaceArtifactDraftRequest,
  ReviseArtifactRequest,
  SaveArtifactDraftRequest,
  SetArtifactArchivedRequest,
  SignArtifactRequest,
  SubmitArtifactDraftRequest,
  UpdateArtifactAccessRequest,
  UpdateArtifactDraftRosterRequest,
  WithdrawArtifactDraftRequest
} from "../../shared/types";
import { ArtifactService, artifactCreateMixedFieldError } from "./artifacts";
import { serverStateProblem, type ArtifactStore } from "./artifactStore";
import { newOpId } from "./chatServerOps";
import type { HubOpOutcome } from "./hubOpsClient";

/** How long a document action waits for the server's answer before it is
 *  taken back and reported as not made (Д13). Under the minute a member's
 *  command line gives a tool call. */
export const ARTIFACT_SERVER_WAIT_MS = 45_000;
/** How long an accepted action waits for this device's copy to show it, so
 *  the caller's next read sees its own change. */
export const ARTIFACT_COPY_WAIT_MS = 15_000;

/** The server's answer, or that none came and the action was taken back. */
export type ArtifactWriteOutcome = HubOpOutcome | { status: "unconfirmed"; reason: string };

/** What this device's link to the User's server offers documents. */
export interface ArtifactServerLink {
  /** This device's id on the server. */
  deviceId(): string;
  /** Sends one document action (in order with this device's other writes)
   *  and waits up to `waitMs` for the server's answer; an action no answer
   *  came for is taken back unless a request is carrying it. */
  write(op: HubOp, waitMs: number): Promise<ArtifactWriteOutcome>;
  /** Resolves true once this device's copy holds the server's order through
   *  `seq`. */
  applied(seq: number, timeoutMs: number): Promise<boolean>;
  /** A chat's documents as the server holds them (no revision bodies). */
  conversationArtifacts(conversationId: string): Promise<HubArtifactState[]>;
  /** One document (undefined: the server has none). */
  artifact(artifactId: string): Promise<HubArtifactState | undefined>;
  /** One revision's body (undefined: the server has none). */
  revision(artifactId: string, versionEventId: string): Promise<HubArtifactRevision | undefined>;
}

/** The document actions the tools and the window call. The same on the
 *  computer and on every machine (parity requirement 1). */
export type ArtifactOperations = Pick<ArtifactService,
  "list" | "read" | "diff" | "create" | "revise" | "rename" | "sign" | "updateAccess" | "setArchived" |
  "listDrafts" | "readDraft" | "saveDraft" | "submitDraft" | "replaceDraft" | "withdrawDraft" | "updateDraftRoster" | "publish">;

export interface ArtifactClientDeps {
  /** This device's copy of the documents. */
  store: ArtifactStore;
  /** A chat's members on this device ("user" + handles), undefined for no chat. */
  getMembers(conversationId: string): Promise<string[] | undefined>;
  /** Writes a document's chat note into the chat (once per note id). */
  postNote(conversationId: string, eventId: string, content: string): Promise<void>;
  /** Whether this device holds the chat. */
  hasChat(conversationId: string): Promise<boolean>;
  /** This chat's documents changed here. */
  onChanged?(conversationId: string): void;
  logger?(event: string, payload: Record<string, unknown>): void;
  /** Tests: how long an action waits for the server (ARTIFACT_SERVER_WAIT_MS). */
  serverWaitMs?: number;
}

/**
 * Documents on a device (the computer or a machine), now that the User's
 * server owns them (agreements Д1, Д2, Д9, Д13). Reading is from this
 * device's copy, by the same rules as everywhere (ArtifactService). Every
 * change is an operation written to the server, which decides it by those
 * rules and answers; the answer is what the caller gets, never a change made
 * here first. The copy follows the server's feed, and the device that acted
 * writes the change's chat note into the chat.
 */
export class ArtifactClient implements ArtifactOperations {
  private readonly reader: ArtifactService;
  private link?: ArtifactServerLink;
  /** Copies of documents are replaced one at a time: a later reading is never
   *  overwritten by an earlier one that finished last. */
  private copying: Promise<unknown> = Promise.resolve();
  /** Documents whose copy here could not be replaced (this device's own
   *  database refused it): read again with the next feed entries, so one
   *  document never holds back the chats' feed. */
  private readonly uncopied = new Map<string, string>();

  constructor(private readonly deps: ArtifactClientDeps) {
    this.reader = new ArtifactService({
      store: deps.store,
      getMembers: (conversationId) => deps.getMembers(conversationId),
      postNote: (conversationId, eventId, content) => deps.postNote(conversationId, eventId, content),
      ...(deps.logger ? { logger: deps.logger } : {})
    });
  }

  /** The link to the server (undefined while there is none). */
  setServerLink(link: ArtifactServerLink | undefined): void {
    this.link = link;
  }

  // --- reading (this device's copy) ----------------------------------------

  list(actor: string, conversationId: string): Promise<ArtifactResult<ArtifactSummary[]>> {
    return this.reader.list(actor, conversationId);
  }

  read(actor: string, request: ReadArtifactRequest): Promise<ArtifactResult<ArtifactReadResult>> {
    return this.reader.read(actor, request);
  }

  diff(actor: string, request: DiffArtifactRequest): Promise<ArtifactResult<ArtifactDiffResult>> {
    return this.reader.diff(actor, request);
  }

  listDrafts(actor: string, request: ListArtifactDraftsRequest): Promise<ArtifactResult<ArtifactDraftView[]>> {
    return this.reader.listDrafts(actor, request);
  }

  readDraft(actor: string, request: ReadArtifactDraftRequest): Promise<ArtifactResult<ArtifactDraftContent>> {
    return this.reader.readDraft(actor, request);
  }

  // --- changing (the server decides) ---------------------------------------

  create(actor: string, request: CreateArtifactRequest): Promise<ArtifactResult<ArtifactReadResult>> {
    if (isRequest(request)) {
      const mixed = artifactCreateMixedFieldError(request);
      if (mixed) return Promise.resolve(invalid(mixed));
    }
    return this.write("artifact.create", actor, request, (answer, member) => this.readBack(member, request, answer));
  }

  revise(actor: string, request: ReviseArtifactRequest): Promise<ArtifactResult<ArtifactReadResult>> {
    return this.write("artifact.revise", actor, request, (answer, member) => this.readBack(member, request, answer));
  }

  rename(actor: string, request: RenameArtifactRequest): Promise<ArtifactResult<ArtifactSummary>> {
    return this.write("artifact.rename", actor, request, (answer, member) => this.summaryBack(member, request, answer));
  }

  sign(actor: string, request: SignArtifactRequest): Promise<ArtifactResult<ArtifactSummary>> {
    return this.write("artifact.sign", actor, request, (answer, member) => this.summaryBack(member, request, answer));
  }

  updateAccess(actor: string, request: UpdateArtifactAccessRequest): Promise<ArtifactResult<ArtifactSummary>> {
    return this.write("artifact.access", actor, request, (answer, member) => this.summaryBack(member, request, answer));
  }

  setArchived(actor: string, request: SetArtifactArchivedRequest): Promise<ArtifactResult<ArtifactSummary>> {
    return this.write("artifact.archive", actor, request, (answer, member) => this.summaryBack(member, request, answer));
  }

  saveDraft(actor: string, request: SaveArtifactDraftRequest): Promise<ArtifactResult<ArtifactDraftContent>> {
    return this.write("artifact.draft.save", actor, request, (answer, member) => this.draftBack(member, request, answer));
  }

  submitDraft(actor: string, request: SubmitArtifactDraftRequest): Promise<ArtifactResult<ArtifactDraftContent>> {
    return this.write("artifact.draft.submit", actor, request, (answer, member) => this.draftBack(member, request, answer));
  }

  replaceDraft(actor: string, request: ReplaceArtifactDraftRequest): Promise<ArtifactResult<ArtifactDraftContent>> {
    return this.write("artifact.draft.replace", actor, request, (answer, member) => this.draftBack(member, request, answer));
  }

  withdrawDraft(actor: string, request: WithdrawArtifactDraftRequest): Promise<ArtifactResult<ArtifactDraftSummary>> {
    return this.write("artifact.draft.withdraw", actor, request, async (answer, member) => {
      const drafts = await this.reader.listDrafts(member, { conversationId: request.conversationId, artifactId: answer?.artifactId ?? request.artifactId, name: request.name });
      if (!drafts.ok) return drafts;
      const draft = drafts.value.find((item) => item.id === (answer?.draftId ?? request.draftId));
      return draft ? { ok: true, value: draft } : notFound("Draft not found.");
    });
  }

  updateDraftRoster(actor: string, request: UpdateArtifactDraftRosterRequest): Promise<ArtifactResult<CollectingArtifactReadResult>> {
    return this.write("artifact.roster", actor, request, async (answer, member) => {
      const read = await this.readBack(member, request, answer);
      if (!read.ok) return read;
      return read.value.lifecycle === "collecting_drafts" ? { ok: true, value: read.value } : invalid("The document is no longer collecting drafts.");
    });
  }

  publish(actor: string, request: PublishArtifactRequest): Promise<ArtifactResult<PublishedArtifactReadResult>> {
    return this.write("artifact.publish", actor, request, async (answer, member) => {
      const read = await this.readBack(member, request, answer);
      if (!read.ok) return read;
      return read.value.lifecycle === "published" ? { ok: true, value: read.value } : invalid("Published artifact could not be read.");
    });
  }

  /**
   * One document action: written to the server, which decides it; its
   * answer is returned once this copy shows what it accepted. When no answer
   * comes in time the action is taken back (unless a request is carrying
   * it) and the caller is told plainly that it was not confirmed (Д13).
   * `readBack` builds the answer from this copy when the server kept no
   * answer of its own (it was asked the same action again).
   */
  private async write<T>(
    kind: HubArtifactOpKind,
    actorRaw: string,
    request: unknown,
    readBack: (answer: HubArtifactAnswer | undefined, actor: string) => Promise<ArtifactResult<T>>
  ): Promise<ArtifactResult<T>> {
    if (!isRequest(request)) return invalid("A request is required.");
    const conversationId = request.conversationId;
    if (typeof conversationId !== "string" || !conversationId) return invalid("conversationId is required.");
    const actor = normalizeArtifactMember(actorRaw);
    if (!actor) return invalid("Missing acting member.");
    if (!isHubChatId(conversationId)) return notFound("Chat not found.");
    const link = this.link;
    if (!link) {
      return unavailable("This device is not linked to your server, so nothing was changed. Try again once it is.");
    }
    const op = { opId: newOpId(), kind, conversationId, actor, request: wireRequest(request) } as HubOp;
    const started = Date.now();
    const outcome = await link.write(op, this.deps.serverWaitMs ?? ARTIFACT_SERVER_WAIT_MS);
    this.log("artifact.server.answer", { kind, conversationId, opId: op.opId, status: outcome.status, ms: Date.now() - started,
      ...(outcome.status === "rejected" ? { reason: outcome.reason } : {}) });
    if (outcome.status === "unconfirmed") return unavailable(outcome.reason);
    if (outcome.status === "rejected") {
      return (outcome.artifact?.result as ArtifactResult<T> | undefined) ?? invalid(outcome.reason);
    }
    // Accepted: the caller's next read on this device sees its own change.
    if (!await link.applied(outcome.seq, ARTIFACT_COPY_WAIT_MS)) {
      this.log("artifact.server.copy-behind", { kind, conversationId, opId: op.opId, seq: outcome.seq });
    }
    const result = outcome.artifact?.result as ArtifactResult<T> | undefined;
    return result ?? readBack(outcome.artifact, actor);
  }

  private async readBack(
    actor: string,
    request: { conversationId: string; artifactId?: string; name?: string },
    answer: HubArtifactAnswer | undefined
  ): Promise<ArtifactResult<ArtifactReadResult>> {
    return this.reader.read(actor, { conversationId: request.conversationId, artifactId: answer?.artifactId ?? request.artifactId, name: request.name });
  }

  private async summaryBack(
    actor: string,
    request: { conversationId: string; artifactId?: string; name?: string },
    answer: HubArtifactAnswer | undefined
  ): Promise<ArtifactResult<ArtifactSummary>> {
    const read = await this.readBack(actor, request, answer);
    return read.ok ? { ok: true, value: read.value.summary } : read;
  }

  private async draftBack(
    actor: string,
    request: { conversationId: string; artifactId?: string; name?: string; draftId?: string },
    answer: HubArtifactAnswer | undefined
  ): Promise<ArtifactResult<ArtifactDraftContent>> {
    const draftId = answer?.draftId ?? request.draftId;
    if (!draftId) return notFound("Draft not found.");
    return this.reader.readDraft(actor, { conversationId: request.conversationId, artifactId: answer?.artifactId ?? request.artifactId, name: request.name, draftId });
  }

  // --- the copy ------------------------------------------------------------

  /** A chat deleted here: its documents go, and stay gone. */
  deleteConversationArtifacts(conversationId: string): Promise<void> {
    return this.deps.store.deleteByConversation(conversationId);
  }

  /** Notes of changes this device made before documents moved to the server
   *  and never got into the chat. */
  flushPendingArtifactEvents(): Promise<void> {
    return this.reader.flushPendingArtifactEvents();
  }

  /** Every row of a chat's documents, for the one-time move to the server. */
  exportConversation(conversationId: string): Promise<Required<HubArtifactImportRows>> {
    return this.deps.store.exportConversation(conversationId);
  }

  /**
   * What the server accepted for documents, in its order: each document it
   * names is read again whole and replaces this copy's; then the notes of the
   * changes this device made are written into their chats. Throws (the feed
   * is read again from the same place) when the server could not be read.
   */
  async applyServerEntries(entries: HubFeedEntry[]): Promise<void> {
    const me = this.link?.deviceId();
    const changed = new Map<string, string>(this.uncopied);
    const notes: Array<{ conversationId: string; note: HubArtifactNote }> = [];
    for (const entry of entries) {
      const effect = entry.effect;
      if (effect.kind === "artifact.import") {
        for (const artifactId of effect.artifactIds) changed.set(artifactId, entry.conversationId);
        continue;
      }
      if (!isHubArtifactOpKind(effect.kind)) continue;
      const change = effect as Extract<HubOpEffect, { kind: HubArtifactOpKind }>;
      changed.set(change.artifactId, entry.conversationId);
      if (change.note && me && entry.deviceId === me) notes.push({ conversationId: entry.conversationId, note: change.note });
    }
    for (const [artifactId, conversationId] of changed) await this.refresh(conversationId, artifactId);
    for (const { conversationId, note } of notes) {
      if (!await this.deps.hasChat(conversationId)) continue;
      await this.deps.postNote(conversationId, note.eventId, note.content);
    }
  }

  /** Replaces this copy of one document with the server's. Reading the
   *  server is what may fail and be tried again (it throws); this device's
   *  own database refusing the copy is logged and tried with the next
   *  entries instead. */
  refresh(conversationId: string, artifactId: string): Promise<void> {
    return this.serially(async () => {
      const link = this.requireLink();
      const state = await link.artifact(artifactId);
      const bodies = state ? await this.bodiesFor(link, [state]) : new Map<string, HubArtifactRevision>();
      try {
        if (state) await this.deps.store.applyServerStates(state.record.conversationId, [state], bodies);
        else await this.deps.store.forgetArtifact(artifactId);
        this.uncopied.delete(artifactId);
      } catch (error) {
        this.uncopied.set(artifactId, conversationId);
        this.log("artifact.server.copy-failed", { conversationId, artifactId, message: error instanceof Error ? error.message : String(error) });
        return;
      }
      this.notify(state?.record.conversationId ?? conversationId);
    });
  }

  /** Replaces this copy of a chat's documents with the server's: what the
   *  server does not have goes. */
  reloadConversation(conversationId: string): Promise<void> {
    return this.serially(async () => {
      const link = this.requireLink();
      const all = await link.conversationArtifacts(conversationId);
      // A document this copy cannot hold as sent is kept here as it was (and
      // said in the log), never dropped, and never holds the others back.
      const held = all.filter((state) => !serverStateProblem(state));
      const kept = all.filter((state) => serverStateProblem(state)).map((state) => state.record.id);
      for (const artifactId of kept) {
        this.log("artifact.server.copy-failed", { conversationId, artifactId, message: serverStateProblem(all.find((state) => state.record.id === artifactId)!) });
      }
      const bodies = await this.bodiesFor(link, held);
      await this.deps.store.applyServerStates(conversationId, held, bodies, { replaceConversation: true, keep: kept });
      this.notify(conversationId);
    });
  }

  /** The bodies of the revisions this copy does not hold yet (each read once:
   *  a revision never changes). */
  private async bodiesFor(link: ArtifactServerLink, states: HubArtifactState[]): Promise<Map<string, HubArtifactRevision>> {
    const metas = states.flatMap((state) => state.revisions);
    const held = await this.deps.store.heldRevisions(metas.map((meta) => meta.versionEventId));
    const bodies = new Map<string, HubArtifactRevision>();
    for (const meta of metas) {
      if (held.get(meta.versionEventId) === meta.contentHash) continue;
      const revision = await link.revision(meta.artifactId, meta.versionEventId);
      if (!revision || revision.contentHash !== meta.contentHash) {
        throw new Error(`The server could not give revision ${meta.versionEventId} of document ${meta.artifactId}.`);
      }
      bodies.set(meta.versionEventId, revision);
    }
    return bodies;
  }

  private serially<T>(work: () => Promise<T>): Promise<T> {
    const run = this.copying.then(work, work);
    this.copying = run.catch(() => undefined);
    return run;
  }

  private requireLink(): ArtifactServerLink {
    if (!this.link) throw new Error("This device is not linked to your server.");
    return this.link;
  }

  private notify(conversationId: string): void {
    try {
      this.deps.onChanged?.(conversationId);
    } catch {
      // A window that cannot be told never breaks the copy.
    }
  }

  private log(event: string, payload: Record<string, unknown>): void {
    try {
      this.deps.logger?.(event, payload);
    } catch {
      // Logging never breaks a document action.
    }
  }
}

function isRequest(value: unknown): value is { conversationId?: unknown } & Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * A request as it travels. A number that is not a number (a tool gave
 * "abc" for a version) travels as its text, so the server's rules refuse it
 * as they did here, instead of reading the JSON null as zero.
 */
function wireRequest(request: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(request, (_key, value: unknown) =>
    typeof value === "number" && !Number.isFinite(value) ? String(value) : value)) as Record<string, unknown>;
}

function invalid<T>(message: string): ArtifactResult<T> {
  return { ok: false, error: { code: "invalid_request", message } };
}

function notFound<T>(message: string): ArtifactResult<T> {
  return { ok: false, error: { code: "not_found", message } };
}

function unavailable<T>(message: string): ArtifactResult<T> {
  const error: ArtifactError = { code: "server_unavailable", message };
  return { ok: false, error };
}

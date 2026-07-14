import { createHash, randomUUID } from "node:crypto";
import type {
  ArtifactDraftAudiencePolicyByAuthor,
  ArtifactDraftContent,
  ArtifactDraftSummary,
  ArtifactDraftView,
  ArtifactDiffResult,
  ArtifactError,
  ArtifactReadResult,
  ArtifactResult,
  ArtifactSummary,
  ArtifactVersionContent,
  ArtifactVersionMeta,
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
  SignArtifactRequest,
  SubmitArtifactDraftRequest,
  UpdateArtifactDraftRosterRequest,
  UpdateArtifactAccessRequest,
  WithdrawArtifactDraftRequest
} from "../../shared/types";
import {
  ARTIFACT_CONTENT_MAX_BYTES,
  ARTIFACT_LABEL_MAX_LENGTH,
  ARTIFACT_MAX_LABELS,
  ARTIFACT_NAME_MAX_LENGTH,
  ARTIFACT_NOTE_MAX_LENGTH,
  artifactApprovalShortLabel,
  artifactMemberLabel,
  artifactNameKey,
  artifactReference,
  computeArtifactApproval,
  normalizeArtifactMember,
  normalizeArtifactMemberList,
  normalizeArtifactName
} from "../../shared/artifacts";
import { unifiedLineDiff } from "../../shared/artifactDiff";
import type {
  ArtifactDraftRecord,
  ArtifactEventRecord,
  ArtifactOperationRecord,
  ArtifactRecord,
  ArtifactSignatureRecord,
  ArtifactStore,
  ArtifactVersionSourceRecord
} from "./artifactStore";

export interface ArtifactServiceDeps {
  store: ArtifactStore;
  // Current member set for a chat ("user" + chat member handles), or undefined
  // when the conversation does not exist or is not a chat.
  getMembers(conversationId: string): Promise<string[] | undefined>;
  // Post a brief linked note into the chat timeline. Never receives artifact bodies.
  postNote?(conversationId: string, eventId: string, content: string): Promise<void>;
  // Notify the renderer that this chat's artifact list changed.
  onChanged?(conversationId: string): void;
  logger?(event: string, payload: Record<string, unknown>): void;
  now?(): string;
}

interface ArtifactContext {
  conversationId: string;
  actor: string;
  members: string[];
}

function ok<T>(value: T): ArtifactResult<T> {
  return { ok: true, value };
}

function fail<T>(error: ArtifactError): ArtifactResult<T> {
  return { ok: false, error };
}

function invalid<T>(message: string): ArtifactResult<T> {
  return fail<T>({ code: "invalid_request", message });
}

export class ArtifactService {
  // Serializes all artifact mutations per conversation. Combined with the
  // SQL-level expected-head guard in ArtifactStore.appendVersion this makes
  // concurrent revisions of the same base version a deterministic
  // one-winner/one-stale-loser outcome instead of a lost update.
  private readonly mutationQueues = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: ArtifactServiceDeps) {}

  async deleteConversationArtifacts(conversationId: string): Promise<void> {
    await this.withMutation(conversationId, () => this.deps.store.deleteByConversation(conversationId));
  }

  async list(actorRaw: string, conversationId: string): Promise<ArtifactResult<ArtifactSummary[]>> {
    const context = await this.requireMember(actorRaw, conversationId);
    if (!context.ok) {
      return context;
    }
    const records = await this.deps.store.listByConversation(conversationId);
    const headSignatures = await this.deps.store.listHeadSignaturesByArtifact(conversationId);
    const summaries = await Promise.all(records.map(async (record) => this.summaryFromRecord(
      record,
      headSignatures.get(record.id) ?? [],
      record.lifecycle === "collecting_drafts" ? await this.deps.store.listDrafts(record.id) : []
    )));
    return ok(summaries);
  }

  async read(actorRaw: string, request: ReadArtifactRequest): Promise<ArtifactResult<ArtifactReadResult>> {
    const context = await this.requireMember(actorRaw, request.conversationId);
    if (!context.ok) {
      return context;
    }
    const resolved = await this.resolveArtifact(request.conversationId, request.artifactId, request.name);
    if (!resolved.ok) {
      return resolved;
    }
    const record = resolved.value;
    if (record.lifecycle === "collecting_drafts") {
      if (request.version !== undefined) {
        return invalid("A collecting artifact has no published version yet.");
      }
      return this.collectingRead(context.value.actor, record);
    }
    if (request.version !== undefined && !isVersionNumber(request.version)) {
      return invalid("version must be a positive integer.");
    }
    const version = request.version === undefined ? record.headVersion : Math.floor(request.version);
    const versionRecord = await this.deps.store.getVersion(record.id, version);
    if (!versionRecord) {
      return fail({
        code: "not_found",
        message: `Version ${version} of artifact "${record.name}" does not exist (versions run 1..${record.headVersion}).`
      });
    }
    const signatures = await this.deps.store.listSignatures(record.id);
    const summary = this.summaryFromRecord(record, signatures.filter((signature) => signature.version === record.headVersion));
    const versionContent: ArtifactVersionContent = {
      version: versionRecord.version,
      author: versionRecord.author,
      note: versionRecord.note,
      createdAt: versionRecord.createdAt,
      signatures: signatures
        .filter((signature) => signature.version === versionRecord.version)
        .map((signature) => ({ signer: signature.signer, signedAt: signature.signedAt })),
      content: versionRecord.content
    };
    const sources = await this.deps.store.listVersionSources(record.id, versionRecord.version);
    if (!request.includeHistory) {
      return ok({ lifecycle: "published", summary, version: versionContent, sources });
    }
    const metas = await this.deps.store.listVersionMetas(record.id);
    const history: ArtifactVersionMeta[] = metas.map((meta) => ({
      version: meta.version,
      author: meta.author,
      note: meta.note,
      createdAt: meta.createdAt,
      signatures: signatures
        .filter((signature) => signature.version === meta.version)
        .map((signature) => ({ signer: signature.signer, signedAt: signature.signedAt }))
    }));
    return ok({ lifecycle: "published", summary, version: versionContent, history, sources });
  }

  async diff(actorRaw: string, request: DiffArtifactRequest): Promise<ArtifactResult<ArtifactDiffResult>> {
    const context = await this.requireMember(actorRaw, request.conversationId);
    if (!context.ok) {
      return context;
    }
    const resolved = await this.resolveArtifact(request.conversationId, request.artifactId, request.name);
    if (!resolved.ok) {
      return resolved;
    }
    const record = resolved.value;
    if (record.lifecycle !== "published") {
      return invalid("A collecting artifact has no published versions to compare.");
    }
    if (!isVersionNumber(request.fromVersion) || !isVersionNumber(request.toVersion)) {
      return invalid("fromVersion and toVersion must be positive integers.");
    }
    const fromVersion = Math.floor(request.fromVersion);
    const toVersion = Math.floor(request.toVersion);
    const [from, to] = await Promise.all([
      this.deps.store.getVersion(record.id, fromVersion),
      this.deps.store.getVersion(record.id, toVersion)
    ]);
    if (!from || !to) {
      const missing = !from ? fromVersion : toVersion;
      return fail({
        code: "not_found",
        message: `Version ${missing} of artifact "${record.name}" does not exist (versions run 1..${record.headVersion}).`
      });
    }
    const headSignatures = (await this.deps.store.listSignatures(record.id))
      .filter((signature) => signature.version === record.headVersion);
    return ok({
      summary: this.summaryFromRecord(record, headSignatures),
      fromVersion,
      toVersion,
      diff: unifiedLineDiff(from.content, to.content, {
        fromLabel: `${record.name} v${fromVersion}`,
        toLabel: `${record.name} v${toVersion}`
      })
    });
  }

  async create(actorRaw: string, request: CreateArtifactRequest): Promise<ArtifactResult<ArtifactReadResult>> {
    return this.withMutation(request.conversationId, async () => {
      const input = request as unknown as Record<string, unknown>;
      const forbidden = request.initialState === "collecting_drafts"
        ? ["content", "note", "requiredSigners"]
        : ["allowedDraftAuthors", "requiredDraftAuthors", "audiencePolicyByAuthor", "operationId"];
      const mixedField = forbidden.find((field) => Object.prototype.hasOwnProperty.call(input, field));
      if (mixedField) {
        return invalid(`Field "${mixedField}" is not valid for initialState "${request.initialState ?? "published"}".`);
      }
      const context = await this.requireMember(actorRaw, request.conversationId);
      if (!context.ok) {
        return context;
      }
      const { actor, members } = context.value;
      const name = normalizeArtifactName(request.name);
      const nameError = validateName(name);
      if (nameError) {
        return invalid<ArtifactReadResult>(nameError);
      }
      const contributors = normalizeArtifactMemberList(request.contributors ?? []);
      const requiredSigners = request.initialState === "collecting_drafts"
        ? []
        : normalizeArtifactMemberList(request.requiredSigners ?? []);
      const memberError = validateMemberSets(members, contributors, requiredSigners);
      if (memberError) {
        return invalid<ArtifactReadResult>(memberError);
      }
      const labelsResult = normalizeLabels(request.labels);
      if (typeof labelsResult === "string") {
        return invalid<ArtifactReadResult>(labelsResult);
      }
      if (request.initialState === "collecting_drafts") {
        const operationIdError = validateOperationId(request.operationId);
        if (operationIdError) {
          return invalid(operationIdError);
        }
        const rosterResult = normalizeDraftRoster(
          members,
          request.allowedDraftAuthors,
          request.requiredDraftAuthors,
          request.audiencePolicyByAuthor
        );
        if (typeof rosterResult === "string") {
          return invalid(rosterResult);
        }
        const requestHash = hashRequest({
          name,
          contributors,
          labels: labelsResult,
          ...rosterResult
        });
        const prior = await this.operationResult(
          request.conversationId,
          actor,
          "create_collecting",
          request.operationId,
          requestHash
        );
        if (prior) {
          return prior.ok
            ? this.read(actorRaw, { conversationId: request.conversationId, artifactId: prior.value.artifactId })
            : prior;
        }
        const existing = await this.deps.store.getByName(request.conversationId, artifactNameKey(name));
        if (existing) {
          return fail({
            code: "name_taken",
            message: `An artifact named "${existing.name}" already exists in this chat.`
          });
        }
        const now = this.now();
        const record: ArtifactRecord = {
          id: randomUUID(),
          conversationId: request.conversationId,
          name,
          owner: actor,
          contributors: contributors.filter((member) => member !== actor),
          requiredSigners: [],
          labels: labelsResult,
          lifecycle: "collecting_drafts",
          allowedDraftAuthors: rosterResult.allowedDraftAuthors,
          requiredDraftAuthors: rosterResult.requiredDraftAuthors,
          audiencePolicyByAuthor: rosterResult.audiencePolicyByAuthor,
          draftRosterRevision: 0,
          headVersion: 0,
          createdAt: now,
          updatedAt: now
        };
        const operation = this.operation(
          request.conversationId,
          actor,
          "create_collecting",
          request.operationId,
          requestHash,
          { artifactId: record.id },
          now,
          record.id
        );
        const event = this.event(
          record,
          actor,
          "collection_created",
          `${artifactMemberLabel(actor)} created draft collection ${artifactReference(record.id, name)} · Drafts 0/${record.requiredDraftAuthors.length}`,
          now
        );
        const inserted = await this.deps.store.insertCollectingArtifact(record, artifactNameKey(name), operation, event);
        if (!inserted) {
          const retry = await this.operationResult(
            request.conversationId,
            actor,
            "create_collecting",
            request.operationId,
            requestHash
          );
          if (retry?.ok) {
            return this.read(actorRaw, { conversationId: request.conversationId, artifactId: retry.value.artifactId });
          }
          if (retry) {
            return retry;
          }
          const conflicting = await this.deps.store.getByName(request.conversationId, artifactNameKey(name));
          return conflicting
            ? fail({ code: "name_taken", message: `An artifact named "${conflicting.name}" already exists in this chat.` })
            : invalid("The collecting artifact could not be created.");
        }
        const durable = await this.operationResult(
          request.conversationId,
          actor,
          "create_collecting",
          request.operationId,
          requestHash
        );
        if (!durable?.ok) {
          return durable ?? invalid("Stored operation result is missing.");
        }
        this.notifyChanged(request.conversationId);
        await this.flushPendingArtifactEvents();
        return this.read(actorRaw, { conversationId: request.conversationId, artifactId: durable.value.artifactId });
      }
      const contentError = validateContent(request.content);
      if (contentError) {
        return invalid<ArtifactReadResult>(contentError);
      }
      const existing = await this.deps.store.getByName(request.conversationId, artifactNameKey(name));
      if (existing) {
        return fail<ArtifactReadResult>({
          code: "name_taken",
          message: `An artifact named "${existing.name}" already exists in this chat. Names must be unique (case-insensitive); pick another name or revise the existing artifact.`
        });
      }
      const now = this.now();
      const record: ArtifactRecord = {
        id: randomUUID(),
        conversationId: request.conversationId,
        name,
        owner: actor,
        contributors: contributors.filter((member) => member !== actor),
        requiredSigners,
        labels: labelsResult,
        lifecycle: "published",
        allowedDraftAuthors: [],
        requiredDraftAuthors: [],
        audiencePolicyByAuthor: {},
        draftRosterRevision: 0,
        headVersion: 1,
        createdAt: now,
        updatedAt: now
      };
      const note = normalizeNote(request.note);
      const event = this.event(
        record,
        actor,
        "created",
        `${artifactMemberLabel(actor)} created artifact ${artifactReference(record.id, name)} · v1`,
        now
      );
      const inserted = await this.deps.store.insertArtifact(
        record,
        artifactNameKey(name),
        {
          artifactId: record.id,
          version: 1,
          content: request.content,
          author: actor,
          note,
          createdAt: now
        },
        event
      );
      if (!inserted) {
        return invalid("The chat was deleted before the artifact could be created.");
      }
      this.notifyChanged(request.conversationId);
      await this.flushPendingArtifactEvents();
      return this.read(actorRaw, { conversationId: request.conversationId, artifactId: record.id });
    });
  }

  async revise(actorRaw: string, request: ReviseArtifactRequest): Promise<ArtifactResult<ArtifactReadResult>> {
    return this.withMutation(request.conversationId, async () => {
      const context = await this.requireMember(actorRaw, request.conversationId);
      if (!context.ok) {
        return context;
      }
      const { actor } = context.value;
      const resolved = await this.resolveArtifact(request.conversationId, request.artifactId, request.name);
      if (!resolved.ok) {
        return resolved;
      }
      const record = resolved.value;
      if (record.lifecycle !== "published") {
        return invalid<ArtifactReadResult>("Publish the artifact before revising published versions.");
      }
      const accessError = this.requireContributor(record, actor, "revise");
      if (accessError) {
        return fail<ArtifactReadResult>(accessError);
      }
      if (!isVersionNumber(request.baseVersion)) {
        return invalid<ArtifactReadResult>("baseVersion must be the version number your edit is based on.");
      }
      const contentError = validateContent(request.content);
      if (contentError) {
        return invalid<ArtifactReadResult>(contentError);
      }
      const baseVersion = Math.floor(request.baseVersion);
      if (baseVersion !== record.headVersion) {
        return this.staleVersionError(record, baseVersion);
      }
      const now = this.now();
      const note = normalizeNote(request.note);
      const nextVersion = record.headVersion + 1;
      const event = this.event(
        record,
        actor,
        "revised",
        `${artifactMemberLabel(actor)} revised ${artifactReference(record.id, record.name)} · v${nextVersion}${note ? ` — ${note}` : ""}`,
        now
      );
      const accepted = await this.deps.store.appendVersion(
        {
          artifactId: record.id,
          version: nextVersion,
          content: request.content,
          author: actor,
          note,
          createdAt: now
        },
        record.headVersion,
        event
      );
      if (!accepted) {
        // Another writer advanced the head between our read and the guarded
        // write (only possible across processes; in-process writes are queued).
        const refreshed = await this.deps.store.getById(record.id);
        return this.staleVersionError(refreshed ?? record, baseVersion);
      }
      this.notifyChanged(request.conversationId);
      await this.flushPendingArtifactEvents();
      return this.read(actorRaw, { conversationId: request.conversationId, artifactId: record.id });
    });
  }

  async rename(actorRaw: string, request: RenameArtifactRequest): Promise<ArtifactResult<ArtifactSummary>> {
    return this.withMutation(request.conversationId, async () => {
      const context = await this.requireMember(actorRaw, request.conversationId);
      if (!context.ok) {
        return context;
      }
      const { actor } = context.value;
      const resolved = await this.resolveArtifact(request.conversationId, request.artifactId, request.name);
      if (!resolved.ok) {
        return resolved;
      }
      const record = resolved.value;
      const accessError = this.requireContributor(record, actor, "rename");
      if (accessError) {
        return fail<ArtifactSummary>(accessError);
      }
      const newName = normalizeArtifactName(request.newName);
      const nameError = validateName(newName);
      if (nameError) {
        return invalid<ArtifactSummary>(nameError);
      }
      const newKey = artifactNameKey(newName);
      const existing = await this.deps.store.getByName(request.conversationId, newKey);
      if (existing && existing.id !== record.id) {
        return fail<ArtifactSummary>({
          code: "name_taken",
          message: `An artifact named "${existing.name}" already exists in this chat.`
        });
      }
      if (record.name === newName) {
        return this.summaryResult(record.id);
      }
      const oldName = record.name;
      const now = this.now();
      // Rename is a label change only: no new version, signatures untouched.
      const event = this.event(
        record,
        actor,
        "renamed",
        `${artifactMemberLabel(actor)} renamed artifact ${artifactReference(record.id, newName)} (was "${oldName}")`,
        now
      );
      await this.deps.store.updateName(record.id, newName, newKey, now, event);
      this.notifyChanged(request.conversationId);
      await this.flushPendingArtifactEvents();
      return this.summaryResult(record.id);
    });
  }

  async sign(actorRaw: string, request: SignArtifactRequest): Promise<ArtifactResult<ArtifactSummary>> {
    return this.withMutation(request.conversationId, async () => {
      const context = await this.requireMember(actorRaw, request.conversationId);
      if (!context.ok) {
        return context;
      }
      const { actor } = context.value;
      const resolved = await this.resolveArtifact(request.conversationId, request.artifactId, request.name);
      if (!resolved.ok) {
        return resolved;
      }
      const record = resolved.value;
      if (record.lifecycle !== "published") {
        return invalid<ArtifactSummary>("Publish the artifact before signing a published version.");
      }
      if (!record.requiredSigners.includes(actor)) {
        return fail<ArtifactSummary>({
          code: "access_denied",
          message: `${artifactMemberLabel(actor)} is not in the required-signer set of "${record.name}" (required: ${record.requiredSigners.map(artifactMemberLabel).join(", ") || "none"}).`
        });
      }
      if (request.version !== undefined && !isVersionNumber(request.version)) {
        return invalid<ArtifactSummary>("version must be a positive integer.");
      }
      const version = request.version === undefined ? record.headVersion : Math.floor(request.version);
      const versionRecord = await this.deps.store.getVersion(record.id, version);
      if (!versionRecord) {
        return fail<ArtifactSummary>({
          code: "not_found",
          message: `Version ${version} of artifact "${record.name}" does not exist (versions run 1..${record.headVersion}).`
        });
      }
      const now = this.now();
      const existingSignatures = await this.deps.store.listSignatures(record.id);
      const projected = computeArtifactApproval(
        record.requiredSigners,
        [...existingSignatures
          .filter((signature) => signature.version === version)
          .map((signature) => ({ signer: signature.signer, signedAt: signature.signedAt })),
        { signer: actor, signedAt: now }]
      );
      const approvalSuffix = version === record.headVersion
        ? ` (${artifactApprovalShortLabel(projected)})`
        : "";
      const event = this.event(
        record,
        actor,
        "signed",
        `${artifactMemberLabel(actor)} signed ${artifactReference(record.id, record.name)} v${version}${approvalSuffix}`,
        now
      );
      const inserted = await this.deps.store.insertSignature(
        {
          artifactId: record.id,
          version,
          signer: actor,
          signedAt: now
        },
        event
      );
      if (inserted) {
        this.notifyChanged(request.conversationId);
        const summaryAfter = await this.summaryResult(record.id);
        await this.flushPendingArtifactEvents();
        return summaryAfter;
      }
      return this.summaryResult(record.id);
    });
  }

  async updateAccess(actorRaw: string, request: UpdateArtifactAccessRequest): Promise<ArtifactResult<ArtifactSummary>> {
    return this.withMutation(request.conversationId, async () => {
      const context = await this.requireMember(actorRaw, request.conversationId);
      if (!context.ok) {
        return context;
      }
      const { actor, members } = context.value;
      const resolved = await this.resolveArtifact(request.conversationId, request.artifactId, request.name);
      if (!resolved.ok) {
        return resolved;
      }
      const record = resolved.value;
      if (record.owner !== actor) {
        return fail<ArtifactSummary>({
          code: "access_denied",
          message: `Only the owner (${artifactMemberLabel(record.owner)}) can manage owner, contributors, or required signers of "${record.name}".`
        });
      }
      if (record.lifecycle === "collecting_drafts" && request.requiredSigners !== undefined) {
        return invalid<ArtifactSummary>("Set required signers when publishing v1, not while collecting drafts.");
      }
      const nextOwner = request.owner === undefined ? record.owner : normalizeArtifactMember(request.owner);
      const nextContributors = request.contributors === undefined
        ? record.contributors
        : normalizeArtifactMemberList(request.contributors);
      const nextRequiredSigners = request.requiredSigners === undefined
        ? record.requiredSigners
        : normalizeArtifactMemberList(request.requiredSigners);
      if (!nextOwner) {
        return invalid<ArtifactSummary>("owner must be a chat member.");
      }
      const memberError = validateMemberSets(members, [nextOwner, ...nextContributors], nextRequiredSigners);
      if (memberError) {
        return invalid<ArtifactSummary>(memberError);
      }
      let nextLabels = record.labels;
      if (request.labels !== undefined) {
        const labelsResult = normalizeLabels(request.labels);
        if (typeof labelsResult === "string") {
          return invalid<ArtifactSummary>(labelsResult);
        }
        nextLabels = labelsResult;
      }
      await this.deps.store.updateAccess(
        record.id,
        {
          owner: nextOwner,
          contributors: nextContributors.filter((member) => member !== nextOwner),
          requiredSigners: nextRequiredSigners,
          labels: nextLabels
        },
        this.now()
      );
      this.notifyChanged(request.conversationId);
      return this.summaryResult(record.id);
    });
  }

  async listDrafts(
    actorRaw: string,
    request: ListArtifactDraftsRequest
  ): Promise<ArtifactResult<ArtifactDraftView[]>> {
    const context = await this.requireMember(actorRaw, request.conversationId);
    if (!context.ok) {
      return context;
    }
    const resolved = await this.resolveArtifact(request.conversationId, request.artifactId, request.name);
    if (!resolved.ok) {
      return resolved;
    }
    const drafts = await this.deps.store.listDrafts(resolved.value.id);
    return ok(this.draftViews(context.value.actor, drafts));
  }

  async readDraft(
    actorRaw: string,
    request: ReadArtifactDraftRequest
  ): Promise<ArtifactResult<ArtifactDraftContent>> {
    const context = await this.requireMember(actorRaw, request.conversationId);
    if (!context.ok) {
      return context;
    }
    const resolved = await this.resolveArtifact(request.conversationId, request.artifactId, request.name);
    if (!resolved.ok) {
      return resolved;
    }
    const draft = await this.deps.store.getDraft(request.draftId);
    if (!draft || draft.artifactId !== resolved.value.id) {
      return fail({ code: "not_found", message: "Draft not found." });
    }
    if (!this.canReadDraft(context.value.actor, draft)) {
      return draft.state === "editing"
        ? fail({ code: "not_found", message: "Draft not found." })
        : fail({ code: "access_denied", message: "This draft's content was not shared with you." });
    }
    return ok(this.draftContent(draft));
  }

  async saveDraft(
    actorRaw: string,
    request: SaveArtifactDraftRequest
  ): Promise<ArtifactResult<ArtifactDraftContent>> {
    return this.withMutation(request.conversationId, async () => {
      const context = await this.requireMember(actorRaw, request.conversationId);
      if (!context.ok) {
        return context;
      }
      const { actor, members } = context.value;
      const resolved = await this.resolveArtifact(request.conversationId, request.artifactId, request.name);
      if (!resolved.ok) {
        return resolved;
      }
      const artifact = resolved.value;
      const contentError = validateContent(request.content);
      if (contentError) {
        return invalid(contentError);
      }
      const operationIdError = validateOperationId(request.operationId);
      if (operationIdError) {
        return invalid(operationIdError);
      }
      const expectedRevision = Math.floor(request.expectedEditRevision);
      if (!Number.isFinite(expectedRevision) || expectedRevision < 0) {
        return invalid("expectedEditRevision must be zero for a new draft or the current positive edit revision.");
      }
      const requestHash = hashRequest({
        artifactId: artifact.id,
        draftId: request.draftId,
        expectedRevision,
        content: request.content,
        readers: normalizeArtifactMemberList(request.readers)
      });
      const prior = await this.operationResult<ArtifactDraftContent>(
        request.conversationId,
        actor,
        "save_draft",
        request.operationId,
        requestHash
      );
      if (prior) {
        if (!prior.ok) {
          return prior as ArtifactResult<ArtifactDraftContent>;
        }
        if (prior.value.value) {
          return ok(prior.value.value);
        }
        return prior.value.draftId
          ? this.readDraft(actorRaw, { conversationId: request.conversationId, artifactId: artifact.id, draftId: prior.value.draftId })
          : invalid("Stored operation result is invalid.");
      }
      if (artifact.lifecycle !== "collecting_drafts") {
        return invalid("Drafts can only be edited while the artifact is collecting drafts.");
      }
      if (!artifact.allowedDraftAuthors.includes(actor)) {
        return fail({ code: "access_denied", message: `${artifactMemberLabel(actor)} is not an allowed draft author.` });
      }
      const readersResult = normalizeDraftReaders(members, actor, request.readers, artifact.audiencePolicyByAuthor[actor]);
      if (typeof readersResult === "string") {
        return invalid(readersResult);
      }
      let existing: ArtifactDraftRecord | undefined;
      if (request.draftId) {
        existing = await this.deps.store.getDraft(request.draftId);
        if (!existing || existing.artifactId !== artifact.id || existing.author !== actor || existing.state !== "editing") {
          return fail({ code: "not_found", message: "Editable draft not found." });
        }
        if (existing.editRevision !== expectedRevision) {
          return fail({
            code: "stale_version",
            message: `Draft is at edit revision ${existing.editRevision}; your save expected ${expectedRevision}.`,
            currentEditRevision: existing.editRevision
          });
        }
      } else if (expectedRevision !== 0) {
        return invalid("A new draft must use expectedEditRevision 0.");
      } else {
        const currentSubmitted = (await this.deps.store.listDrafts(artifact.id))
          .find((draft) => draft.author === actor && draft.state === "submitted");
        if (currentSubmitted) {
          return invalid("A submitted draft already exists. Use replaceDraft to create an editable replacement.");
        }
      }
      const now = this.now();
      const draft: ArtifactDraftRecord = {
        id: existing?.id ?? randomUUID(),
        artifactId: artifact.id,
        author: actor,
        state: "editing",
        content: request.content,
        readers: readersResult,
        editRevision: existing ? existing.editRevision + 1 : 1,
        supersedesDraftId: existing?.supersedesDraftId,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      };
      const operation = this.operation(
        request.conversationId,
        actor,
        "save_draft",
        request.operationId,
        requestHash,
        { artifactId: artifact.id, draftId: draft.id, value: this.draftContent(draft) },
        now,
        artifact.id
      );
      const saved = await this.deps.store.saveDraft(
        draft,
        expectedRevision,
        artifact.draftRosterRevision,
        operation
      );
      if (!saved) {
        const refreshed = await this.deps.store.getDraft(draft.id);
        return fail({
          code: "stale_version",
          message: "The draft changed before this save completed.",
          currentEditRevision: refreshed?.editRevision
        });
      }
      const durable = await this.operationResult<ArtifactDraftContent>(
        request.conversationId,
        actor,
        "save_draft",
        request.operationId,
        requestHash
      );
      if (!durable?.ok || !durable.value.value) {
        return durable?.ok ? invalid("Stored operation result is invalid.") : durable ?? invalid("Stored operation result is missing.");
      }
      this.notifyChanged(request.conversationId);
      return ok(durable.value.value);
    });
  }

  async submitDraft(
    actorRaw: string,
    request: SubmitArtifactDraftRequest
  ): Promise<ArtifactResult<ArtifactDraftContent>> {
    return this.withMutation(request.conversationId, async () => {
      const context = await this.requireMember(actorRaw, request.conversationId);
      if (!context.ok) {
        return context;
      }
      const { actor, members } = context.value;
      const resolved = await this.resolveArtifact(request.conversationId, request.artifactId, request.name);
      if (!resolved.ok) {
        return resolved;
      }
      const artifact = resolved.value;
      const operationIdError = validateOperationId(request.operationId);
      if (operationIdError) {
        return invalid(operationIdError);
      }
      const requestHash = hashRequest({
        artifactId: artifact.id,
        draftId: request.draftId,
        expectedEditRevision: Math.floor(request.expectedEditRevision)
      });
      const prior = await this.operationResult<ArtifactDraftContent>(
        request.conversationId,
        actor,
        "submit_draft",
        request.operationId,
        requestHash
      );
      if (prior) {
        if (!prior.ok) {
          return prior as ArtifactResult<ArtifactDraftContent>;
        }
        if (prior.value.value) {
          return ok(prior.value.value);
        }
        return prior.value.draftId
          ? this.readDraft(actorRaw, { conversationId: request.conversationId, artifactId: artifact.id, draftId: prior.value.draftId })
          : invalid("Stored operation result is invalid.");
      }
      if (artifact.lifecycle !== "collecting_drafts") {
        return invalid("Drafts can only be submitted while the artifact is collecting drafts.");
      }
      const current = await this.deps.store.getDraft(request.draftId);
      if (!current || current.artifactId !== artifact.id || current.author !== actor || current.state !== "editing") {
        return fail({ code: "not_found", message: "Editable draft not found." });
      }
      if (current.editRevision !== Math.floor(request.expectedEditRevision)) {
        return fail({
          code: "stale_version",
          message: `Draft is at edit revision ${current.editRevision}; submit expected ${request.expectedEditRevision}.`,
          currentEditRevision: current.editRevision
        });
      }
      const readersError = normalizeDraftReaders(
        members,
        actor,
        current.readers,
        artifact.audiencePolicyByAuthor[actor]
      );
      if (typeof readersError === "string") {
        return invalid(readersError);
      }
      const now = this.now();
      const submitted: ArtifactDraftRecord = { ...current, state: "submitted", submittedAt: now, updatedAt: now };
      const operation = this.operation(
        request.conversationId,
        actor,
        "submit_draft",
        request.operationId,
        requestHash,
        { artifactId: artifact.id, draftId: current.id, value: this.draftContent(submitted) },
        now,
        artifact.id
      );
      const event = this.event(
        artifact,
        actor,
        current.supersedesDraftId ? "draft_replaced" : "draft_submitted",
        `${artifactMemberLabel(actor)} submitted a draft to ${artifactReference(artifact.id, artifact.name)} · Submitted`,
        now
      );
      const accepted = await this.deps.store.submitDraft(
        submitted,
        current.editRevision,
        artifact.draftRosterRevision,
        operation,
        event
      );
      if (!accepted) {
        return invalid("The draft changed or another current submission already exists.");
      }
      const durable = await this.operationResult<ArtifactDraftContent>(
        request.conversationId,
        actor,
        "submit_draft",
        request.operationId,
        requestHash
      );
      if (!durable?.ok || !durable.value.value) {
        return durable?.ok ? invalid("Stored operation result is invalid.") : durable ?? invalid("Stored operation result is missing.");
      }
      this.notifyChanged(request.conversationId);
      await this.flushPendingArtifactEvents();
      return ok(durable.value.value);
    });
  }

  async replaceDraft(
    actorRaw: string,
    request: ReplaceArtifactDraftRequest
  ): Promise<ArtifactResult<ArtifactDraftContent>> {
    return this.withMutation(request.conversationId, async () => {
      const context = await this.requireMember(actorRaw, request.conversationId);
      if (!context.ok) {
        return context;
      }
      const { actor, members } = context.value;
      const resolved = await this.resolveArtifact(request.conversationId, request.artifactId, request.name);
      if (!resolved.ok) {
        return resolved;
      }
      const artifact = resolved.value;
      const contentError = validateContent(request.content);
      if (contentError) {
        return invalid(contentError);
      }
      const operationIdError = validateOperationId(request.operationId);
      if (operationIdError) {
        return invalid(operationIdError);
      }
      const requestHash = hashRequest({
        artifactId: artifact.id,
        supersedesDraftId: request.supersedesDraftId,
        content: request.content,
        readers: normalizeArtifactMemberList(request.readers)
      });
      const prior = await this.operationResult<ArtifactDraftContent>(
        request.conversationId,
        actor,
        "replace_draft",
        request.operationId,
        requestHash
      );
      if (prior) {
        if (!prior.ok) {
          return prior as ArtifactResult<ArtifactDraftContent>;
        }
        if (prior.value.value) {
          return ok(prior.value.value);
        }
        return prior.value.draftId
          ? this.readDraft(actorRaw, { conversationId: request.conversationId, artifactId: artifact.id, draftId: prior.value.draftId })
          : invalid("Stored operation result is invalid.");
      }
      if (artifact.lifecycle !== "collecting_drafts") {
        return invalid("Submitted drafts can only be replaced while collecting.");
      }
      const current = await this.deps.store.getDraft(request.supersedesDraftId);
      if (!current || current.artifactId !== artifact.id || current.author !== actor || current.state !== "submitted") {
        return fail({ code: "not_found", message: "Current submitted draft not found." });
      }
      const readersResult = normalizeDraftReaders(members, actor, request.readers, artifact.audiencePolicyByAuthor[actor]);
      if (typeof readersResult === "string") {
        return invalid(readersResult);
      }
      const now = this.now();
      const replacement: ArtifactDraftRecord = {
        id: randomUUID(),
        artifactId: artifact.id,
        author: actor,
        state: "editing",
        content: request.content,
        readers: readersResult,
        editRevision: 1,
        supersedesDraftId: current.id,
        createdAt: now,
        updatedAt: now
      };
      const operation = this.operation(
        request.conversationId,
        actor,
        "replace_draft",
        request.operationId,
        requestHash,
        { artifactId: artifact.id, draftId: replacement.id, value: this.draftContent(replacement) },
        now,
        artifact.id
      );
      const saved = await this.deps.store.saveDraft(
        replacement,
        0,
        artifact.draftRosterRevision,
        operation
      );
      if (!saved) {
        return invalid("An editable replacement already exists for this author.");
      }
      const durable = await this.operationResult<ArtifactDraftContent>(
        request.conversationId,
        actor,
        "replace_draft",
        request.operationId,
        requestHash
      );
      if (!durable?.ok || !durable.value.value) {
        return durable?.ok ? invalid("Stored operation result is invalid.") : durable ?? invalid("Stored operation result is missing.");
      }
      this.notifyChanged(request.conversationId);
      return ok(durable.value.value);
    });
  }

  async withdrawDraft(
    actorRaw: string,
    request: WithdrawArtifactDraftRequest
  ): Promise<ArtifactResult<ArtifactDraftSummary>> {
    return this.withMutation(request.conversationId, async () => {
      const context = await this.requireMember(actorRaw, request.conversationId);
      if (!context.ok) {
        return context;
      }
      const { actor } = context.value;
      const resolved = await this.resolveArtifact(request.conversationId, request.artifactId, request.name);
      if (!resolved.ok) {
        return resolved;
      }
      const artifact = resolved.value;
      const operationIdError = validateOperationId(request.operationId);
      if (operationIdError) {
        return invalid(operationIdError);
      }
      const requestHash = hashRequest({ artifactId: artifact.id, draftId: request.draftId });
      const prior = await this.operationResult<ArtifactDraftSummary>(
        request.conversationId,
        actor,
        "withdraw_draft",
        request.operationId,
        requestHash
      );
      if (prior) {
        if (!prior.ok) {
          return prior as ArtifactResult<ArtifactDraftSummary>;
        }
        if (prior.value.value) {
          return ok(prior.value.value);
        }
        if (!prior.value.draftId) {
          return invalid("Stored operation result is invalid.");
        }
        const priorDraft = await this.deps.store.getDraft(prior.value.draftId);
        return priorDraft ? ok(this.draftSummary(priorDraft, this.canReadDraft(actor, priorDraft))) : fail({ code: "not_found", message: "Draft not found." });
      }
      if (artifact.lifecycle !== "collecting_drafts") {
        return invalid("Drafts can only be withdrawn while collecting.");
      }
      const current = await this.deps.store.getDraft(request.draftId);
      if (!current || current.artifactId !== artifact.id || current.state !== "submitted") {
        return fail({ code: "not_found", message: "Current submitted draft not found." });
      }
      if (current.author !== actor && artifact.owner !== actor) {
        return fail({ code: "access_denied", message: "Only the draft author or artifact owner can withdraw it." });
      }
      const now = this.now();
      const withdrawn: ArtifactDraftRecord = { ...current, state: "withdrawn", updatedAt: now };
      const operation = this.operation(
        request.conversationId,
        actor,
        "withdraw_draft",
        request.operationId,
        requestHash,
        {
          artifactId: artifact.id,
          draftId: current.id,
          value: this.draftSummary(withdrawn, this.canReadDraft(actor, withdrawn))
        },
        now,
        artifact.id
      );
      const event = this.event(
        artifact,
        actor,
        "draft_withdrawn",
        `${artifactMemberLabel(current.author)} withdrew a draft from ${artifactReference(artifact.id, artifact.name)} · Withdrawn`,
        now
      );
      const accepted = await this.deps.store.withdrawDraft(
        withdrawn,
        artifact.draftRosterRevision,
        operation,
        event
      );
      if (!accepted) {
        return invalid("The draft is no longer current or has an editable replacement.");
      }
      const durable = await this.operationResult<ArtifactDraftSummary>(
        request.conversationId,
        actor,
        "withdraw_draft",
        request.operationId,
        requestHash
      );
      if (!durable?.ok || !durable.value.value) {
        return durable?.ok ? invalid("Stored operation result is invalid.") : durable ?? invalid("Stored operation result is missing.");
      }
      this.notifyChanged(request.conversationId);
      await this.flushPendingArtifactEvents();
      return ok(durable.value.value);
    });
  }

  async updateDraftRoster(
    actorRaw: string,
    request: UpdateArtifactDraftRosterRequest
  ): Promise<ArtifactResult<CollectingArtifactReadResult>> {
    return this.withMutation(request.conversationId, async () => {
      const context = await this.requireMember(actorRaw, request.conversationId);
      if (!context.ok) {
        return context;
      }
      const { actor, members } = context.value;
      const resolved = await this.resolveArtifact(request.conversationId, request.artifactId, request.name);
      if (!resolved.ok) {
        return resolved;
      }
      const artifact = resolved.value;
      const operationIdError = validateOperationId(request.operationId);
      if (operationIdError) {
        return invalid(operationIdError);
      }
      const expectedRevision = Math.floor(request.expectedDraftRosterRevision);
      if (!Number.isFinite(expectedRevision) || expectedRevision < 0) {
        return invalid("expectedDraftRosterRevision must be a non-negative integer.");
      }
      const requestHash = hashRequest({
        artifactId: artifact.id,
        expectedRevision,
        allowedDraftAuthors: normalizeArtifactMemberList(request.allowedDraftAuthors),
        requiredDraftAuthors: normalizeArtifactMemberList(request.requiredDraftAuthors),
        audiencePolicyByAuthor: request.audiencePolicyByAuthor
      });
      const prior = await this.operationResult<CollectingArtifactReadResult>(
        request.conversationId,
        actor,
        "update_draft_roster",
        request.operationId,
        requestHash
      );
      if (prior) {
        if (!prior.ok) {
          return prior as ArtifactResult<CollectingArtifactReadResult>;
        }
        if (prior.value.value) {
          return ok(prior.value.value);
        }
        return this.collectingRead(actor, (await this.deps.store.getById(artifact.id)) ?? artifact);
      }
      if (artifact.lifecycle !== "collecting_drafts") {
        return invalid("The draft roster is immutable after publication.");
      }
      if (actor !== "user" && actor !== artifact.owner) {
        return fail({ code: "access_denied", message: "Only User or the artifact owner can update the draft roster." });
      }
      const rosterResult = normalizeDraftRoster(
        members,
        request.allowedDraftAuthors,
        request.requiredDraftAuthors,
        request.audiencePolicyByAuthor
      );
      if (typeof rosterResult === "string") {
        return invalid(rosterResult);
      }
      if (artifact.draftRosterRevision !== expectedRevision) {
        return fail({
          code: "stale_version",
          message: `Draft roster is at revision ${artifact.draftRosterRevision}; update expected ${expectedRevision}.`,
          currentRosterRevision: artifact.draftRosterRevision
        });
      }
      const now = this.now();
      const drafts = await this.deps.store.listDrafts(artifact.id);
      const updatedRecord: ArtifactRecord = {
        ...artifact,
        ...rosterResult,
        draftRosterRevision: artifact.draftRosterRevision + 1,
        updatedAt: now
      };
      const storedValue = this.collectingValue(actor, updatedRecord, drafts);
      const operation = this.operation(
        request.conversationId,
        actor,
        "update_draft_roster",
        request.operationId,
        requestHash,
        { artifactId: artifact.id, value: storedValue },
        now,
        artifact.id
      );
      const accepted = await this.deps.store.updateDraftRoster(
        artifact.id,
        expectedRevision,
        rosterResult,
        now,
        operation
      );
      if (!accepted) {
        const refreshed = await this.deps.store.getById(artifact.id);
        return fail({
          code: "stale_version",
          message: "The draft roster changed before this update completed.",
          currentRosterRevision: refreshed?.draftRosterRevision
        });
      }
      const durable = await this.operationResult<CollectingArtifactReadResult>(
        request.conversationId,
        actor,
        "update_draft_roster",
        request.operationId,
        requestHash
      );
      if (!durable?.ok || !durable.value.value) {
        return durable?.ok ? invalid("Stored operation result is invalid.") : durable ?? invalid("Stored operation result is missing.");
      }
      this.notifyChanged(request.conversationId);
      return ok(durable.value.value);
    });
  }

  async publish(
    actorRaw: string,
    request: PublishArtifactRequest
  ): Promise<ArtifactResult<PublishedArtifactReadResult>> {
    return this.withMutation(request.conversationId, async () => {
      const context = await this.requireMember(actorRaw, request.conversationId);
      if (!context.ok) {
        return context;
      }
      const { actor, members } = context.value;
      const resolved = await this.resolveArtifact(request.conversationId, request.artifactId, request.name);
      if (!resolved.ok) {
        return resolved;
      }
      const artifact = resolved.value;
      const contentError = validateContent(request.content);
      if (contentError) {
        return invalid(contentError);
      }
      const operationIdError = validateOperationId(request.operationId);
      if (operationIdError) {
        return invalid(operationIdError);
      }
      const requiredSigners = normalizeArtifactMemberList(request.requiredSigners);
      const requestHash = hashRequest({
        artifactId: artifact.id,
        content: request.content,
        note: normalizeNote(request.note),
        requiredSigners,
        sources: request.sources
      });
      const prior = await this.operationResult<PublishedArtifactReadResult>(
        request.conversationId,
        actor,
        "publish_v1",
        request.operationId,
        requestHash
      );
      if (prior) {
        if (!prior.ok) {
          return prior as ArtifactResult<PublishedArtifactReadResult>;
        }
        if (prior.value.value) {
          return ok(prior.value.value);
        }
        const priorRead = await this.read(actorRaw, { conversationId: request.conversationId, artifactId: prior.value.artifactId });
        return priorRead.ok && priorRead.value.lifecycle === "published"
          ? priorRead as ArtifactResult<PublishedArtifactReadResult>
          : invalid("Published artifact could not be read.");
      }
      if (artifact.lifecycle !== "collecting_drafts") {
        return invalid("Only a collecting artifact can publish its first version.");
      }
      if (artifact.owner !== actor) {
        return fail({ code: "access_denied", message: "Only the artifact owner can publish v1." });
      }
      const signerError = validateMemberSets(members, [], requiredSigners);
      if (signerError) {
        return invalid(signerError);
      }
      const rosterResult = normalizeDraftRoster(
        members,
        artifact.allowedDraftAuthors,
        artifact.requiredDraftAuthors,
        artifact.audiencePolicyByAuthor
      );
      if (typeof rosterResult === "string") {
        return invalid(`Draft roster is no longer valid: ${rosterResult}`);
      }
      const drafts = await this.deps.store.listDrafts(artifact.id);
      const currentSubmitted = new Map(
        drafts.filter((draft) => draft.state === "submitted").map((draft) => [draft.author, draft])
      );
      const missing = artifact.requiredDraftAuthors.filter((author) => !currentSubmitted.has(author));
      if (missing.length > 0) {
        return invalid(`Cannot publish until required drafts are submitted: ${missing.map(artifactMemberLabel).join(", ")}.`);
      }
      for (const draft of currentSubmitted.values()) {
        const readersResult = normalizeDraftReaders(
          members,
          draft.author,
          draft.readers,
          artifact.audiencePolicyByAuthor[draft.author]
        );
        if (typeof readersResult === "string") {
          return invalid(`Draft audience for ${artifactMemberLabel(draft.author)} is no longer valid: ${readersResult}`);
        }
      }
      if (!Array.isArray(request.sources) || request.sources.length === 0) {
        return invalid("sources must include every required submitted draft.");
      }
      const sourceIds = new Set<string>();
      const sources: ArtifactVersionSourceRecord[] = [];
      for (const source of request.sources) {
        if (sourceIds.has(source.draftId)) {
          return invalid(`Duplicate source draft: ${source.draftId}.`);
        }
        sourceIds.add(source.draftId);
        const draft = drafts.find((candidate) => candidate.id === source.draftId);
        if (!draft || draft.state === "editing") {
          return invalid(`Source draft ${source.draftId} is not a frozen draft of this artifact.`);
        }
        if (source.disposition !== "considered" && source.disposition !== "excluded") {
          return invalid(`Invalid source disposition for ${source.draftId}.`);
        }
        const rationale = normalizeNote(source.exclusionRationale);
        if (source.disposition === "excluded" && !rationale) {
          return invalid(`Excluded source ${source.draftId} requires an exclusion rationale.`);
        }
        sources.push({
          artifactId: artifact.id,
          version: 1,
          draftId: draft.id,
          author: draft.author,
          submittedAt: draft.submittedAt ?? draft.updatedAt,
          contentHash: createHash("sha256").update(draft.content).digest("hex"),
          disposition: source.disposition,
          exclusionRationale: rationale
        });
      }
      for (const author of artifact.requiredDraftAuthors) {
        const draft = currentSubmitted.get(author)!;
        const source = sources.find((candidate) => candidate.draftId === draft.id);
        if (!source || source.disposition !== "considered") {
          return invalid(`The current required draft from ${artifactMemberLabel(author)} must be a considered source.`);
        }
      }
      const now = this.now();
      const note = normalizeNote(request.note);
      const publishedRecord: ArtifactRecord = {
        ...artifact,
        lifecycle: "published",
        headVersion: 1,
        requiredSigners,
        updatedAt: now
      };
      const storedValue: PublishedArtifactReadResult = {
        lifecycle: "published",
        summary: this.summaryFromRecord(publishedRecord, []),
        version: {
          version: 1,
          author: actor,
          note,
          createdAt: now,
          signatures: [],
          content: request.content
        },
        sources
      };
      const operation = this.operation(
        request.conversationId,
        actor,
        "publish_v1",
        request.operationId,
        requestHash,
        { artifactId: artifact.id, value: storedValue },
        now,
        artifact.id
      );
      const event = this.event(
        artifact,
        actor,
        "published",
        `${artifactMemberLabel(actor)} published ${artifactReference(artifact.id, artifact.name)} · v1`,
        now
      );
      const accepted = await this.deps.store.publishFirstVersion(
        artifact,
        {
          artifactId: artifact.id,
          version: 1,
          content: request.content,
          author: actor,
          note,
          createdAt: now
        },
        sources,
        requiredSigners,
        operation,
        event
      );
      if (!accepted) {
        return invalid("Publication readiness changed before v1 could be committed.");
      }
      const durable = await this.operationResult<PublishedArtifactReadResult>(
        request.conversationId,
        actor,
        "publish_v1",
        request.operationId,
        requestHash
      );
      if (!durable?.ok || !durable.value.value) {
        return durable?.ok ? invalid("Stored operation result is invalid.") : durable ?? invalid("Stored operation result is missing.");
      }
      this.notifyChanged(request.conversationId);
      await this.flushPendingArtifactEvents();
      return ok(durable.value.value);
    });
  }

  async flushPendingArtifactEvents(): Promise<void> {
    if (!this.deps.postNote) {
      return;
    }
    let cursor: { createdAt: string; id: string } | undefined;
    while (true) {
      const pending = await this.deps.store.listPendingEvents(100, cursor);
      if (pending.length === 0) {
        return;
      }
      for (const event of pending) {
        try {
          await this.deps.postNote(event.conversationId, event.id, event.content);
          await this.deps.store.markEventDelivered(event.id, this.now());
        } catch (error) {
          this.log("artifacts.post-note-error", {
            conversationId: event.conversationId,
            eventId: event.id,
            message: errorMessage(error)
          });
        }
      }
      const last = pending[pending.length - 1]!;
      cursor = { createdAt: last.createdAt, id: last.id };
    }
  }

  // --- internals -----------------------------------------------------------

  private async collectingRead(actor: string, record: ArtifactRecord): Promise<ArtifactResult<CollectingArtifactReadResult>> {
    const drafts = await this.deps.store.listDrafts(record.id);
    return ok(this.collectingValue(actor, record, drafts));
  }

  private collectingValue(
    actor: string,
    record: ArtifactRecord,
    drafts: ArtifactDraftRecord[]
  ): CollectingArtifactReadResult {
    const submittedAuthors = new Set(drafts.filter((draft) => draft.state === "submitted").map((draft) => draft.author));
    const missingRequiredAuthors = record.requiredDraftAuthors.filter((author) => !submittedAuthors.has(author));
    const summary = this.summaryFromRecord(record, [], drafts);
    return {
      lifecycle: "collecting_drafts",
      summary,
      allowedDraftAuthors: record.allowedDraftAuthors,
      requiredDraftAuthors: record.requiredDraftAuthors,
      audiencePolicyByAuthor: actor === "user" || actor === record.owner ? record.audiencePolicyByAuthor : {},
      drafts: this.draftViews(actor, drafts),
      missingRequiredAuthors,
      readyToPublish: missingRequiredAuthors.length === 0
    };
  }

  private draftViews(actor: string, drafts: ArtifactDraftRecord[]): ArtifactDraftView[] {
    return drafts.flatMap((draft) => {
      const readable = this.canReadDraft(actor, draft);
      if (draft.state === "editing" && !readable) {
        return [];
      }
      return [readable ? this.draftContent(draft) : this.draftSummary(draft, false)];
    });
  }

  private canReadDraft(actor: string, draft: ArtifactDraftRecord): boolean {
    // Explicit readers may inspect work-in-progress drafts before submission.
    // Unselected members cannot discover editing drafts through list/read.
    return actor === "user" || actor === draft.author || draft.readers.includes(actor);
  }

  private draftSummary(draft: ArtifactDraftRecord, hasContent: boolean): ArtifactDraftSummary {
    return {
      id: draft.id,
      artifactId: draft.artifactId,
      author: draft.author,
      state: draft.state,
      editRevision: draft.editRevision,
      createdAt: draft.createdAt,
      updatedAt: draft.updatedAt,
      submittedAt: draft.submittedAt,
      supersedesDraftId: draft.supersedesDraftId,
      hasContent
    };
  }

  private draftContent(draft: ArtifactDraftRecord): ArtifactDraftContent {
    return {
      ...this.draftSummary(draft, true),
      hasContent: true,
      content: draft.content,
      readers: draft.readers,
      effectiveReaders: normalizeArtifactMemberList(["user", draft.author, ...draft.readers])
    };
  }

  private async operationResult<T = unknown>(
    conversationId: string,
    actor: string,
    operationKind: string,
    operationId: string,
    requestHash: string
  ): Promise<ArtifactResult<{ artifactId: string; draftId?: string; value?: T }> | undefined> {
    const existing = await this.deps.store.getOperation(conversationId, actor, operationKind, operationId);
    if (!existing) {
      return undefined;
    }
    if (existing.requestHash !== requestHash) {
      return invalid(`operationId "${operationId}" was already used with a different request.`);
    }
    if (!existing.applied) {
      return invalid(`operationId "${operationId}" exists but its mutation did not complete.`);
    }
    try {
      const parsed = JSON.parse(existing.resultJson) as { artifactId?: unknown; draftId?: unknown; value?: unknown };
      if (typeof parsed.artifactId !== "string") {
        return invalid("Stored operation result is invalid.");
      }
      return ok({
        artifactId: parsed.artifactId,
        draftId: typeof parsed.draftId === "string" ? parsed.draftId : undefined,
        value: parsed.value as T | undefined
      });
    } catch {
      return invalid("Stored operation result is invalid.");
    }
  }

  private operation<T = unknown>(
    conversationId: string,
    actor: string,
    operationKind: string,
    operationId: string,
    requestHash: string,
    result: { artifactId: string; draftId?: string; value?: T },
    createdAt: string,
    artifactId?: string
  ): ArtifactOperationRecord {
    return {
      conversationId,
      artifactId,
      actor,
      operationKind,
      operationId,
      requestHash,
      resultJson: JSON.stringify(result),
      createdAt
    };
  }

  private event(
    artifact: ArtifactRecord,
    actor: string,
    kind: string,
    content: string,
    createdAt: string
  ): ArtifactEventRecord {
    return {
      id: randomUUID(),
      conversationId: artifact.conversationId,
      artifactId: artifact.id,
      kind,
      actor,
      content,
      createdAt
    };
  }

  private async requireMember(
    actorRaw: string,
    conversationId: string
  ): Promise<ArtifactResult<ArtifactContext>> {
    const actor = normalizeArtifactMember(actorRaw);
    if (!actor) {
      return invalid("Missing acting member.");
    }
    if (!conversationId || typeof conversationId !== "string") {
      return invalid("conversationId is required.");
    }
    const members = await this.deps.getMembers(conversationId);
    if (!members) {
      return fail({ code: "not_found", message: "Chat not found." });
    }
    if (!members.includes(actor)) {
      return fail({
        code: "access_denied",
        message: `${artifactMemberLabel(actor)} is not a member of this chat.`
      });
    }
    return ok({ conversationId, actor, members });
  }

  private async resolveArtifact(
    conversationId: string,
    artifactId: string | undefined,
    name: string | undefined
  ): Promise<ArtifactResult<ArtifactRecord>> {
    const id = typeof artifactId === "string" ? artifactId.trim() : "";
    if (id) {
      const record = await this.deps.store.getById(id);
      if (!record || record.conversationId !== conversationId) {
        return fail({ code: "not_found", message: `No artifact with id ${id} in this chat.` });
      }
      return ok(record);
    }
    const normalizedName = normalizeArtifactName(name ?? "");
    if (!normalizedName) {
      return invalid("Provide artifactId or name.");
    }
    const record = await this.deps.store.getByName(conversationId, artifactNameKey(normalizedName));
    if (!record) {
      return fail({ code: "not_found", message: `No artifact named "${normalizedName}" in this chat.` });
    }
    return ok(record);
  }

  private requireContributor(record: ArtifactRecord, actor: string, action: string): ArtifactError | undefined {
    if (record.owner === actor || record.contributors.includes(actor)) {
      return undefined;
    }
    return {
      code: "access_denied",
      message: `${artifactMemberLabel(actor)} cannot ${action} "${record.name}": only the owner (${artifactMemberLabel(record.owner)}) and contributors (${record.contributors.map(artifactMemberLabel).join(", ") || "none"}) can.`
    };
  }

  private async staleVersionError(record: ArtifactRecord, baseVersion: number): Promise<ArtifactResult<ArtifactReadResult>> {
    const head = await this.deps.store.getVersion(record.id, record.headVersion);
    const signatures = head
      ? (await this.deps.store.listSignatures(record.id)).filter((signature) => signature.version === head.version)
      : [];
    return fail({
      code: "stale_version",
      message: `Your edit was based on v${baseVersion}, but "${record.name}" is now at v${record.headVersion}. Nothing was saved. Re-apply your change on top of the current version and revise again with baseVersion ${record.headVersion}.`,
      currentVersion: record.headVersion,
      current: head
        ? {
            version: head.version,
            author: head.author,
            note: head.note,
            createdAt: head.createdAt,
            signatures: signatures.map((signature) => ({ signer: signature.signer, signedAt: signature.signedAt })),
            content: head.content
          }
        : undefined
    });
  }

  private async summaryResult(artifactId: string): Promise<ArtifactResult<ArtifactSummary>> {
    const record = await this.deps.store.getById(artifactId);
    if (!record) {
      return fail({ code: "not_found", message: "Artifact not found." });
    }
    const headSignatures = (await this.deps.store.listSignatures(record.id))
      .filter((signature) => signature.version === record.headVersion);
    const drafts = record.lifecycle === "collecting_drafts" ? await this.deps.store.listDrafts(record.id) : [];
    return ok(this.summaryFromRecord(record, headSignatures, drafts));
  }

  private summaryFromRecord(
    record: ArtifactRecord,
    headSignatures: ArtifactSignatureRecord[],
    drafts: ArtifactDraftRecord[] = []
  ): ArtifactSummary {
    const submittedAuthors = new Set(drafts.filter((draft) => draft.state === "submitted").map((draft) => draft.author));
    return {
      id: record.id,
      conversationId: record.conversationId,
      name: record.name,
      owner: record.owner,
      contributors: record.contributors,
      labels: record.labels,
      lifecycle: record.lifecycle,
      headVersion: record.headVersion,
      draftRosterRevision: record.draftRosterRevision,
      requiredDraftCount: record.requiredDraftAuthors.length,
      submittedDraftCount: record.requiredDraftAuthors.filter((author) => submittedAuthors.has(author)).length,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      approval: computeArtifactApproval(
        record.requiredSigners,
        headSignatures.map((signature) => ({ signer: signature.signer, signedAt: signature.signedAt }))
      )
    };
  }

  private withMutation<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.mutationQueues.get(conversationId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(fn);
    this.mutationQueues.set(conversationId, next.catch(() => undefined));
    return next;
  }

  private notifyChanged(conversationId: string): void {
    try {
      this.deps.onChanged?.(conversationId);
    } catch (error) {
      this.log("artifacts.on-changed-error", { conversationId, message: errorMessage(error) });
    }
  }

  private now(): string {
    return this.deps.now ? this.deps.now() : new Date().toISOString();
  }

  private log(event: string, payload: Record<string, unknown>): void {
    try {
      this.deps.logger?.(event, payload);
    } catch {
      // Logging must never break artifact operations.
    }
  }
}

function isVersionNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.floor(value) >= 1;
}

function validateName(name: string): string | undefined {
  if (!name) {
    return "Artifact name is required.";
  }
  if (name.length > ARTIFACT_NAME_MAX_LENGTH) {
    return `Artifact name must be at most ${ARTIFACT_NAME_MAX_LENGTH} characters.`;
  }
  return undefined;
}

function validateContent(content: unknown): string | undefined {
  if (typeof content !== "string" || content.length === 0) {
    return "Artifact content must be a non-empty string.";
  }
  if (Buffer.byteLength(content, "utf8") > ARTIFACT_CONTENT_MAX_BYTES) {
    return `Artifact content is limited to ${Math.floor(ARTIFACT_CONTENT_MAX_BYTES / 1024)} KB per version.`;
  }
  return undefined;
}

function validateMemberSets(members: string[], contributors: string[], requiredSigners: string[]): string | undefined {
  const memberSet = new Set(members);
  const unknown = [...new Set([...contributors, ...requiredSigners])].filter((member) => !memberSet.has(member));
  if (unknown.length > 0) {
    return `Not current chat members: ${unknown.join(", ")}. Members are "user" and chat member handles.`;
  }
  return undefined;
}

function normalizeLabels(raw: string[] | undefined): string[] | string {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    return "labels must be an array of short strings.";
  }
  const labels = [...new Set(raw
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.replace(/\s+/g, " ").trim())
    .filter((value) => value.length > 0))];
  if (labels.some((label) => label.length > ARTIFACT_LABEL_MAX_LENGTH)) {
    return `Each label must be at most ${ARTIFACT_LABEL_MAX_LENGTH} characters.`;
  }
  if (labels.length > ARTIFACT_MAX_LABELS) {
    return `At most ${ARTIFACT_MAX_LABELS} labels are allowed.`;
  }
  return labels;
}

function normalizeNote(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const note = raw.replace(/\s+/g, " ").trim();
  if (!note) {
    return undefined;
  }
  return note.length > ARTIFACT_NOTE_MAX_LENGTH ? `${note.slice(0, ARTIFACT_NOTE_MAX_LENGTH - 1)}…` : note;
}

function validateOperationId(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return "operationId is required.";
  }
  if (value.length > 240) {
    return "operationId must be at most 240 characters.";
  }
  return undefined;
}

function normalizeDraftRoster(
  members: string[],
  allowedRaw: string[],
  requiredRaw: string[],
  policyRaw: ArtifactDraftAudiencePolicyByAuthor
): {
  allowedDraftAuthors: string[];
  requiredDraftAuthors: string[];
  audiencePolicyByAuthor: ArtifactDraftAudiencePolicyByAuthor;
} | string {
  if (!Array.isArray(allowedRaw) || !Array.isArray(requiredRaw) || !policyRaw || typeof policyRaw !== "object") {
    return "allowedDraftAuthors, requiredDraftAuthors, and audiencePolicyByAuthor are required.";
  }
  const allowedDraftAuthors = normalizeArtifactMemberList(allowedRaw);
  const requiredDraftAuthors = normalizeArtifactMemberList(requiredRaw);
  if (allowedDraftAuthors.length !== allowedRaw.length || requiredDraftAuthors.length !== requiredRaw.length) {
    return "Draft author lists must contain unique, valid chat member handles.";
  }
  if (allowedDraftAuthors.length === 0 || requiredDraftAuthors.length === 0) {
    return "At least one allowed and required draft author is needed.";
  }
  const memberSet = new Set(members);
  const unknownAuthors = allowedDraftAuthors.filter((author) => !memberSet.has(author));
  if (unknownAuthors.length > 0) {
    return `Not current chat members: ${unknownAuthors.join(", ")}.`;
  }
  const allowedSet = new Set(allowedDraftAuthors);
  const outside = requiredDraftAuthors.filter((author) => !allowedSet.has(author));
  if (outside.length > 0) {
    return `Required draft authors must also be allowed: ${outside.join(", ")}.`;
  }
  const rawKeys = Object.keys(policyRaw).map(normalizeArtifactMember).filter((value): value is string => Boolean(value));
  if (rawKeys.length !== allowedDraftAuthors.length || rawKeys.some((key) => !allowedSet.has(key))) {
    return "Audience policy keys must exactly match allowed draft authors.";
  }
  const audiencePolicyByAuthor: ArtifactDraftAudiencePolicyByAuthor = {};
  for (const author of allowedDraftAuthors) {
    const rawPolicy = policyRaw[author] ?? policyRaw[`@${author}`];
    if (!rawPolicy || !Array.isArray(rawPolicy.allowedReaders) || !Array.isArray(rawPolicy.requiredReaders)) {
      return `Audience policy is required for ${author}.`;
    }
    const allowedReaders = normalizeArtifactMemberList(rawPolicy.allowedReaders)
      .filter((reader) => reader !== "user" && reader !== author);
    const requiredReaders = normalizeArtifactMemberList(rawPolicy.requiredReaders)
      .filter((reader) => reader !== "user" && reader !== author);
    const unknownReaders = [...new Set([...allowedReaders, ...requiredReaders])].filter((reader) => !memberSet.has(reader));
    if (unknownReaders.length > 0) {
      return `Audience policy for ${author} names non-members: ${unknownReaders.join(", ")}.`;
    }
    const readerSet = new Set(allowedReaders);
    const missingAllowed = requiredReaders.filter((reader) => !readerSet.has(reader));
    if (missingAllowed.length > 0) {
      return `Required readers for ${author} must also be allowed: ${missingAllowed.join(", ")}.`;
    }
    audiencePolicyByAuthor[author] = { allowedReaders, requiredReaders };
  }
  return { allowedDraftAuthors, requiredDraftAuthors, audiencePolicyByAuthor };
}

function normalizeDraftReaders(
  members: string[],
  author: string,
  readersRaw: string[],
  policy: { allowedReaders: string[]; requiredReaders: string[] } | undefined
): string[] | string {
  if (!policy) {
    return `No audience policy exists for ${author}.`;
  }
  if (!Array.isArray(readersRaw)) {
    return "readers must be an array of chat member handles.";
  }
  const readers = normalizeArtifactMemberList(readersRaw)
    .filter((reader) => reader !== "user" && reader !== author);
  const memberSet = new Set(members);
  const unknown = readers.filter((reader) => !memberSet.has(reader));
  if (unknown.length > 0) {
    return `Draft readers are not current chat members: ${unknown.join(", ")}.`;
  }
  const allowed = new Set(policy.allowedReaders);
  const forbidden = readers.filter((reader) => !allowed.has(reader));
  if (forbidden.length > 0) {
    return `Draft readers are forbidden by the artifact audience policy: ${forbidden.join(", ")}.`;
  }
  const readerSet = new Set(readers);
  const missing = policy.requiredReaders.filter((reader) => !readerSet.has(reader));
  if (missing.length > 0) {
    return `Draft readers must include: ${missing.join(", ")}.`;
  }
  return readers;
}

function hashRequest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

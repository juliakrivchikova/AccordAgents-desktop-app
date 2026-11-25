import { createHash, randomUUID } from "node:crypto";
import type {
  ArtifactReadResult, ArtifactResult, CreateArtifactRequest, PublishArtifactRequest, PublishedArtifactReadResult
} from "../../../shared/types";
import { artifactRevisionExistsSql } from "../artifactRevisions";
import {
  artifactMemberLabel, artifactNameKey, artifactReference, normalizeArtifactMemberList, normalizeArtifactName
} from "../../../shared/artifacts";
import type { ArtifactRecord, ArtifactVersionSourceRecord } from "../artifactStore";
import { archivedMutationError, artifactEvent, artifactOperation } from "./artifactRules";
import { summaryFromRecord } from "./artifactViews";
import { artifactCreateMixedFieldError, fail, invalid, ok } from "./results";
import {
  hashRequest, isOriginMessageId, normalizeDraftReaders, normalizeDraftRoster, normalizeLabels, normalizeNote, validateContent,
  validateMemberSets, validateName, validateOperationId
} from "./validation";
import type { ArtifactModules } from "./modules";
import type { ArtifactServiceDeps } from "./dependencies";

/** Creates a document and publishes its first version. */
export class ArtifactPublishing {
  constructor(
    private readonly artifacts: Pick<ArtifactModules, "artifactLookups" | "artifactMutations" | "artifactReads">,
    private readonly deps: Pick<ArtifactServiceDeps, "store">
  ) {}

  async create(actorRaw: string, request: CreateArtifactRequest): Promise<ArtifactResult<ArtifactReadResult>> {
    return this.artifacts.artifactMutations.withMutation(request.conversationId, async () => {
      const mixedField = artifactCreateMixedFieldError(request);
      if (mixedField) {
        return invalid(mixedField);
      }
      const context = await this.artifacts.artifactLookups.requireMember(actorRaw, request.conversationId);
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
        const prior = await this.artifacts.artifactMutations.operationResult(
          request.conversationId,
          actor,
          "create_collecting",
          request.operationId,
          requestHash
        );
        if (prior) {
          return prior.ok
            ? this.artifacts.artifactReads.read(actorRaw, { conversationId: request.conversationId, artifactId: prior.value.artifactId })
            : prior;
        }
        const existing = await this.deps.store.getByName(request.conversationId, artifactNameKey(name));
        if (existing) {
          return fail({
            code: "name_taken",
            message: `An artifact named "${existing.name}" already exists in this chat.`
          });
        }
        const now = this.artifacts.artifactMutations.now();
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
          updatedAt: now,
          ...(isOriginMessageId(request.originMessageId) ? { originMessageId: request.originMessageId } : {})
        };
        const operation = artifactOperation(
          request.conversationId,
          actor,
          "create_collecting",
          request.operationId,
          requestHash,
          { artifactId: record.id },
          now,
          record.id
        );
        const event = artifactEvent(
          record,
          actor,
          "collection_created",
          `${artifactMemberLabel(actor)} created draft collection ${artifactReference(record.id, name)} · Drafts 0/${record.requiredDraftAuthors.length}`,
          now
        );
        const inserted = await this.artifacts.artifactMutations.commit(
          { conversationId: request.conversationId, artifactId: record.id, event },
          this.deps.store.operationCommittedSql(operation),
          sql => this.deps.store.insertCollectingArtifact(record, artifactNameKey(name), operation, event, sql)
        );
        if (!inserted) {
          const retry = await this.artifacts.artifactMutations.operationResult(
            request.conversationId,
            actor,
            "create_collecting",
            request.operationId,
            requestHash
          );
          if (retry?.ok) {
            return this.artifacts.artifactReads.read(actorRaw, { conversationId: request.conversationId, artifactId: retry.value.artifactId });
          }
          if (retry) {
            return retry;
          }
          const conflicting = await this.deps.store.getByName(request.conversationId, artifactNameKey(name));
          return conflicting
            ? fail({ code: "name_taken", message: `An artifact named "${conflicting.name}" already exists in this chat.` })
            : invalid("The collecting artifact could not be created.");
        }
        const durable = await this.artifacts.artifactMutations.operationResult(
          request.conversationId,
          actor,
          "create_collecting",
          request.operationId,
          requestHash
        );
        if (!durable?.ok) {
          return durable ?? invalid("Stored operation result is missing.");
        }
        this.artifacts.artifactMutations.notifyChanged(request.conversationId);
        await this.artifacts.artifactMutations.flushPendingArtifactEvents();
        return this.artifacts.artifactReads.read(actorRaw, { conversationId: request.conversationId, artifactId: durable.value.artifactId });
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
      const now = this.artifacts.artifactMutations.now();
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
      const event = artifactEvent(
        record,
        actor,
        "created",
        `${artifactMemberLabel(actor)} created artifact ${artifactReference(record.id, name)} · v1`,
        now
      );
      const firstVersion = { artifactId: record.id, version: 1, versionEventId: event.id, content: request.content, author: actor, note, createdAt: now };
      const inserted = await this.artifacts.artifactMutations.commit({ conversationId: request.conversationId, artifactId: record.id, event }, artifactRevisionExistsSql(record.id, event.id),
        sql => this.deps.store.insertArtifact(record, artifactNameKey(name), firstVersion, event, sql)
      );
      if (!inserted) {
        return invalid("The chat was deleted before the artifact could be created.");
      }
      this.artifacts.artifactMutations.notifyChanged(request.conversationId);
      await this.artifacts.artifactMutations.flushPendingArtifactEvents();
      return this.artifacts.artifactReads.read(actorRaw, { conversationId: request.conversationId, artifactId: record.id });
    });
  }

  async publish(
    actorRaw: string,
    request: PublishArtifactRequest
  ): Promise<ArtifactResult<PublishedArtifactReadResult>> {
    return this.artifacts.artifactMutations.withMutation(request.conversationId, async () => {
      const context = await this.artifacts.artifactLookups.requireMember(actorRaw, request.conversationId);
      if (!context.ok) {
        return context;
      }
      const { actor, members } = context.value;
      const resolved = await this.artifacts.artifactLookups.resolveArtifact(request.conversationId, request.artifactId, request.name);
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
      const prior = await this.artifacts.artifactMutations.operationResult<PublishedArtifactReadResult>(
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
        const priorRead = await this.artifacts.artifactReads.read(actorRaw, { conversationId: request.conversationId, artifactId: prior.value.artifactId });
        return priorRead.ok && priorRead.value.lifecycle === "published"
          ? priorRead as ArtifactResult<PublishedArtifactReadResult>
          : invalid("Published artifact could not be read.");
      }
      const archivedError = archivedMutationError(artifact, "publishing it");
      if (archivedError) {
        return fail<PublishedArtifactReadResult>(archivedError);
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
      const now = this.artifacts.artifactMutations.now();
      const note = normalizeNote(request.note);
      const publishedRecord: ArtifactRecord = {
        ...artifact,
        lifecycle: "published",
        headVersion: 1,
        requiredSigners,
        updatedAt: now
      };
      const event = artifactEvent(
        artifact,
        actor,
        "published",
        `${artifactMemberLabel(actor)} published ${artifactReference(artifact.id, artifact.name)} · v1${note ? ` — ${note}` : ""}`,
        now
      );
      const storedValue: PublishedArtifactReadResult = {
        lifecycle: "published",
        summary: summaryFromRecord(publishedRecord, []),
        version: {
          version: 1,
          versionEventId: event.id,
          contentHash: createHash("sha256").update(request.content).digest("hex"),
          author: actor,
          note,
          createdAt: now,
          signatures: [],
          content: request.content
        },
        sources
      };
      const operation = artifactOperation(
        request.conversationId,
        actor,
        "publish_v1",
        request.operationId,
        requestHash,
        { artifactId: artifact.id, value: storedValue },
        now,
        artifact.id
      );
      const firstVersion = { artifactId: artifact.id, version: 1, versionEventId: event.id, content: request.content, author: actor, note, createdAt: now };
      const accepted = await this.artifacts.artifactMutations.commit({ conversationId: request.conversationId, artifactId: artifact.id, event }, this.deps.store.operationCommittedSql(operation),
        sql => this.deps.store.publishFirstVersion(artifact, firstVersion, sources, requiredSigners, operation, event, sql)
      );
      if (!accepted) {
        return invalid("Publication readiness changed before v1 could be committed.");
      }
      const durable = await this.artifacts.artifactMutations.operationResult<PublishedArtifactReadResult>(
        request.conversationId,
        actor,
        "publish_v1",
        request.operationId,
        requestHash
      );
      if (!durable?.ok || !durable.value.value) {
        return durable?.ok ? invalid("Stored operation result is invalid.") : durable ?? invalid("Stored operation result is missing.");
      }
      this.artifacts.artifactMutations.notifyChanged(request.conversationId);
      await this.artifacts.artifactMutations.flushPendingArtifactEvents();
      return ok(durable.value.value);
    });
  }
}

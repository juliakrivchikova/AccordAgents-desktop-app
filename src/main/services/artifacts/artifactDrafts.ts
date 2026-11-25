import { randomUUID } from "node:crypto";
import type {
  ArtifactDraftContent, ArtifactDraftSummary, ArtifactResult, CollectingArtifactReadResult, ReplaceArtifactDraftRequest,
  SaveArtifactDraftRequest, SubmitArtifactDraftRequest, UpdateArtifactDraftRosterRequest, WithdrawArtifactDraftRequest
} from "../../../shared/types";
import { artifactMemberLabel, artifactReference, normalizeArtifactMemberList } from "../../../shared/artifacts";
import type { ArtifactDraftRecord, ArtifactRecord } from "../artifactStore";
import { archivedMutationError, artifactEvent, artifactOperation } from "./artifactRules";
import { canReadDraftContent, collectingValue, draftContent, draftSummary, mustSubmitOwnDraftFirst } from "./artifactViews";
import { fail, invalid, ok } from "./results";
import { hashRequest, normalizeDraftReaders, normalizeDraftRoster, validateContent, validateOperationId } from "./validation";
import type { ArtifactModules } from "./modules";
import type { ArtifactServiceDeps } from "./dependencies";

/** Drafts several members write before a document is published. */
export class ArtifactDrafts {
  constructor(
    private readonly artifacts: Pick<ArtifactModules, "artifactLookups" | "artifactMutations" | "artifactReads">,
    private readonly deps: Pick<ArtifactServiceDeps, "store">
  ) {}

  async saveDraft(
    actorRaw: string,
    request: SaveArtifactDraftRequest
  ): Promise<ArtifactResult<ArtifactDraftContent>> {
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
      const prior = await this.artifacts.artifactMutations.operationResult<ArtifactDraftContent>(
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
          ? this.artifacts.artifactReads.readDraft(actorRaw, { conversationId: request.conversationId, artifactId: artifact.id, draftId: prior.value.draftId })
          : invalid("Stored operation result is invalid.");
      }
      const archivedError = archivedMutationError(artifact, "editing drafts");
      if (archivedError) {
        return fail<ArtifactDraftContent>(archivedError);
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
      const now = this.artifacts.artifactMutations.now();
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
      const operation = artifactOperation(
        request.conversationId,
        actor,
        "save_draft",
        request.operationId,
        requestHash,
        { artifactId: artifact.id, draftId: draft.id, value: draftContent(draft) },
        now,
        artifact.id
      );
      const saved = await this.artifacts.artifactMutations.commit(
        { conversationId: request.conversationId, artifactId: artifact.id, draftId: draft.id }, this.deps.store.operationCommittedSql(operation),
        sql => this.deps.store.saveDraft(draft, expectedRevision, artifact.draftRosterRevision, operation, sql)
      );
      if (!saved) {
        const refreshed = await this.deps.store.getDraft(draft.id);
        return fail({
          code: "stale_version",
          message: "The draft changed before this save completed.",
          currentEditRevision: refreshed?.editRevision
        });
      }
      const durable = await this.artifacts.artifactMutations.operationResult<ArtifactDraftContent>(
        request.conversationId,
        actor,
        "save_draft",
        request.operationId,
        requestHash
      );
      if (!durable?.ok || !durable.value.value) {
        return durable?.ok ? invalid("Stored operation result is invalid.") : durable ?? invalid("Stored operation result is missing.");
      }
      this.artifacts.artifactMutations.notifyChanged(request.conversationId);
      return ok(durable.value.value);
    });
  }

  async submitDraft(
    actorRaw: string,
    request: SubmitArtifactDraftRequest
  ): Promise<ArtifactResult<ArtifactDraftContent>> {
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
      const operationIdError = validateOperationId(request.operationId);
      if (operationIdError) {
        return invalid(operationIdError);
      }
      const requestHash = hashRequest({
        artifactId: artifact.id,
        draftId: request.draftId,
        expectedEditRevision: Math.floor(request.expectedEditRevision)
      });
      const prior = await this.artifacts.artifactMutations.operationResult<ArtifactDraftContent>(
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
          ? this.artifacts.artifactReads.readDraft(actorRaw, { conversationId: request.conversationId, artifactId: artifact.id, draftId: prior.value.draftId })
          : invalid("Stored operation result is invalid.");
      }
      const archivedError = archivedMutationError(artifact, "submitting drafts");
      if (archivedError) {
        return fail<ArtifactDraftContent>(archivedError);
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
      const now = this.artifacts.artifactMutations.now();
      const submitted: ArtifactDraftRecord = { ...current, state: "submitted", submittedAt: now, updatedAt: now };
      const operation = artifactOperation(
        request.conversationId,
        actor,
        "submit_draft",
        request.operationId,
        requestHash,
        { artifactId: artifact.id, draftId: current.id, value: draftContent(submitted) },
        now,
        artifact.id
      );
      const event = artifactEvent(
        artifact,
        actor,
        current.supersedesDraftId ? "draft_replaced" : "draft_submitted",
        `${artifactMemberLabel(actor)} submitted a draft to ${artifactReference(artifact.id, artifact.name)} · Submitted`,
        now
      );
      const accepted = await this.artifacts.artifactMutations.commit(
        { conversationId: request.conversationId, artifactId: artifact.id, event, draftId: current.id }, this.deps.store.operationCommittedSql(operation),
        sql => this.deps.store.submitDraft(submitted, current.editRevision, artifact.draftRosterRevision, operation, event, sql)
      );
      if (!accepted) {
        return invalid("The draft changed or another current submission already exists.");
      }
      const durable = await this.artifacts.artifactMutations.operationResult<ArtifactDraftContent>(
        request.conversationId,
        actor,
        "submit_draft",
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

  async replaceDraft(
    actorRaw: string,
    request: ReplaceArtifactDraftRequest
  ): Promise<ArtifactResult<ArtifactDraftContent>> {
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
      const requestHash = hashRequest({
        artifactId: artifact.id,
        supersedesDraftId: request.supersedesDraftId,
        content: request.content,
        readers: normalizeArtifactMemberList(request.readers)
      });
      const prior = await this.artifacts.artifactMutations.operationResult<ArtifactDraftContent>(
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
          ? this.artifacts.artifactReads.readDraft(actorRaw, { conversationId: request.conversationId, artifactId: artifact.id, draftId: prior.value.draftId })
          : invalid("Stored operation result is invalid.");
      }
      const archivedError = archivedMutationError(artifact, "replacing drafts");
      if (archivedError) {
        return fail<ArtifactDraftContent>(archivedError);
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
      const now = this.artifacts.artifactMutations.now();
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
      const operation = artifactOperation(
        request.conversationId,
        actor,
        "replace_draft",
        request.operationId,
        requestHash,
        { artifactId: artifact.id, draftId: replacement.id, value: draftContent(replacement) },
        now,
        artifact.id
      );
      const saved = await this.artifacts.artifactMutations.commit(
        { conversationId: request.conversationId, artifactId: artifact.id, draftId: replacement.id }, this.deps.store.operationCommittedSql(operation),
        sql => this.deps.store.saveDraft(replacement, 0, artifact.draftRosterRevision, operation, sql)
      );
      if (!saved) {
        return invalid("An editable replacement already exists for this author.");
      }
      const durable = await this.artifacts.artifactMutations.operationResult<ArtifactDraftContent>(
        request.conversationId,
        actor,
        "replace_draft",
        request.operationId,
        requestHash
      );
      if (!durable?.ok || !durable.value.value) {
        return durable?.ok ? invalid("Stored operation result is invalid.") : durable ?? invalid("Stored operation result is missing.");
      }
      this.artifacts.artifactMutations.notifyChanged(request.conversationId);
      return ok(durable.value.value);
    });
  }

  async withdrawDraft(
    actorRaw: string,
    request: WithdrawArtifactDraftRequest
  ): Promise<ArtifactResult<ArtifactDraftSummary>> {
    return this.artifacts.artifactMutations.withMutation(request.conversationId, async () => {
      const context = await this.artifacts.artifactLookups.requireMember(actorRaw, request.conversationId);
      if (!context.ok) {
        return context;
      }
      const { actor } = context.value;
      const resolved = await this.artifacts.artifactLookups.resolveArtifact(request.conversationId, request.artifactId, request.name);
      if (!resolved.ok) {
        return resolved;
      }
      const artifact = resolved.value;
      const operationIdError = validateOperationId(request.operationId);
      if (operationIdError) {
        return invalid(operationIdError);
      }
      const requestHash = hashRequest({ artifactId: artifact.id, draftId: request.draftId });
      const prior = await this.artifacts.artifactMutations.operationResult<ArtifactDraftSummary>(
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
        return priorDraft
          ? ok(draftSummary(priorDraft, canReadDraftContent(actor, artifact, priorDraft, await this.deps.store.listDrafts(artifact.id))))
          : fail({ code: "not_found", message: "Draft not found." });
      }
      const archivedError = archivedMutationError(artifact, "withdrawing drafts");
      if (archivedError) {
        return fail<ArtifactDraftSummary>(archivedError);
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
      const now = this.artifacts.artifactMutations.now();
      const withdrawn: ArtifactDraftRecord = { ...current, state: "withdrawn", updatedAt: now };
      const operation = artifactOperation(
        request.conversationId,
        actor,
        "withdraw_draft",
        request.operationId,
        requestHash,
        {
          artifactId: artifact.id,
          draftId: current.id,
          value: draftSummary(withdrawn, canReadDraftContent(actor, artifact, withdrawn, await this.deps.store.listDrafts(artifact.id)))
        },
        now,
        artifact.id
      );
      const event = artifactEvent(
        artifact,
        actor,
        "draft_withdrawn",
        `${artifactMemberLabel(current.author)} withdrew a draft from ${artifactReference(artifact.id, artifact.name)} · Withdrawn`,
        now
      );
      const accepted = await this.artifacts.artifactMutations.commit(
        { conversationId: request.conversationId, artifactId: artifact.id, event, draftId: current.id }, this.deps.store.operationCommittedSql(operation),
        sql => this.deps.store.withdrawDraft(withdrawn, artifact.draftRosterRevision, operation, event, sql)
      );
      if (!accepted) {
        return invalid("The draft is no longer current or has an editable replacement.");
      }
      const durable = await this.artifacts.artifactMutations.operationResult<ArtifactDraftSummary>(
        request.conversationId,
        actor,
        "withdraw_draft",
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

  async updateDraftRoster(
    actorRaw: string,
    request: UpdateArtifactDraftRosterRequest
  ): Promise<ArtifactResult<CollectingArtifactReadResult>> {
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
      const prior = await this.artifacts.artifactMutations.operationResult<CollectingArtifactReadResult>(
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
        return this.artifacts.artifactLookups.collectingRead(actor, (await this.deps.store.getById(artifact.id)) ?? artifact);
      }
      const archivedError = archivedMutationError(artifact, "changing the draft roster");
      if (archivedError) {
        return fail<CollectingArtifactReadResult>(archivedError);
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
      const now = this.artifacts.artifactMutations.now();
      const drafts = await this.deps.store.listDrafts(artifact.id);
      if (mustSubmitOwnDraftFirst(actor, artifact, drafts) && !rosterResult.requiredDraftAuthors.includes(actor)) {
        return fail({
          code: "access_denied",
          message: "Submit your own draft before removing yourself from the required draft authors."
        });
      }
      const updatedRecord: ArtifactRecord = {
        ...artifact,
        ...rosterResult,
        draftRosterRevision: artifact.draftRosterRevision + 1,
        updatedAt: now
      };
      const storedValue = collectingValue(actor, updatedRecord, drafts);
      const operation = artifactOperation(
        request.conversationId,
        actor,
        "update_draft_roster",
        request.operationId,
        requestHash,
        { artifactId: artifact.id, value: storedValue },
        now,
        artifact.id
      );
      const accepted = await this.artifacts.artifactMutations.commit(
        { conversationId: request.conversationId, artifactId: artifact.id }, this.deps.store.operationCommittedSql(operation),
        sql => this.deps.store.updateDraftRoster(artifact.id, expectedRevision, rosterResult, now, operation, sql)
      );
      if (!accepted) {
        const refreshed = await this.deps.store.getById(artifact.id);
        return fail({
          code: "stale_version",
          message: "The draft roster changed before this update completed.",
          currentRosterRevision: refreshed?.draftRosterRevision
        });
      }
      const durable = await this.artifacts.artifactMutations.operationResult<CollectingArtifactReadResult>(
        request.conversationId,
        actor,
        "update_draft_roster",
        request.operationId,
        requestHash
      );
      if (!durable?.ok || !durable.value.value) {
        return durable?.ok ? invalid("Stored operation result is invalid.") : durable ?? invalid("Stored operation result is missing.");
      }
      this.artifacts.artifactMutations.notifyChanged(request.conversationId);
      return ok(durable.value.value);
    });
  }
}

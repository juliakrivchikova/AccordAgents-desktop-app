import { randomUUID } from "node:crypto";
import type {
  ArtifactReadResult, ArtifactResult, ArtifactSummary, RenameArtifactRequest, ReviseArtifactRequest, SetArtifactArchivedRequest,
  SignArtifactRequest, UpdateArtifactAccessRequest
} from "../../../shared/types";
import { artifactRevisionExistsSql, artifactSignatureExistsSql } from "../artifactRevisions";
import {
  artifactApprovalShortLabel, artifactMemberLabel, artifactNameKey, artifactReference, computeArtifactApproval,
  normalizeArtifactMember, normalizeArtifactMemberList, normalizeArtifactName
} from "../../../shared/artifacts";
import { archivedMutationError, artifactEvent, canManageAccess, requireContributor } from "./artifactRules";
import { fail, invalid } from "./results";
import { isVersionNumber, normalizeLabels, normalizeNote, validateContent, validateMemberSets, validateName } from "./validation";
import type { ArtifactModules } from "./modules";
import type { ArtifactServiceDeps } from "./dependencies";

/** Changes a published document. */
export class ArtifactChanges {
  constructor(
    private readonly artifacts: Pick<ArtifactModules, "artifactLookups" | "artifactMutations" | "artifactReads">,
    private readonly deps: Pick<ArtifactServiceDeps, "store">
  ) {}

  async deleteConversationArtifacts(conversationId: string): Promise<void> {
    await this.artifacts.artifactMutations.withMutation(conversationId, () => this.deps.store.deleteByConversation(conversationId));
  }

  async revise(actorRaw: string, request: ReviseArtifactRequest): Promise<ArtifactResult<ArtifactReadResult>> {
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
      const record = resolved.value;
      if (record.lifecycle !== "published") {
        return invalid<ArtifactReadResult>("Publish the artifact before revising published versions.");
      }
      const accessError = requireContributor(record, actor, "revise");
      if (accessError) {
        return fail<ArtifactReadResult>(accessError);
      }
      const archivedError = archivedMutationError(record, "revising it");
      if (archivedError) {
        return fail<ArtifactReadResult>(archivedError);
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
        return this.artifacts.artifactLookups.staleVersionError(record, baseVersion);
      }
      const baseRevision = await this.deps.store.getVersion(record.id, baseVersion);
      if (!baseRevision || (request.baseVersionEventId !== undefined && request.baseVersionEventId !== baseRevision.versionEventId) ||
          (request.baseContentHash !== undefined && request.baseContentHash !== baseRevision.contentHash)) {
        return this.artifacts.artifactLookups.staleVersionError(record, baseVersion);
      }
      const now = this.artifacts.artifactMutations.now();
      const note = normalizeNote(request.note);
      const nextVersion = record.headVersion + 1;
      const event = artifactEvent(
        record,
        actor,
        "revised",
        `${artifactMemberLabel(actor)} revised ${artifactReference(record.id, record.name)} · v${nextVersion}${note ? ` — ${note}` : ""}`,
        now
      );
      const versionEventId = randomUUID();
      const appendVersionRecord = {
        artifactId: record.id,
        version: nextVersion,
        baseVersionEventId: baseRevision.versionEventId,
        versionEventId,
        content: request.content,
        author: actor,
        note,
        createdAt: now
      };
      // The revision and whatever records it (on the User's server, its place
      // in the order) are one commit.
      const accepted = await this.artifacts.artifactMutations.commit(
        { conversationId: request.conversationId, artifactId: record.id, event },
        artifactRevisionExistsSql(record.id, versionEventId),
        (sql) => this.deps.store.appendVersion(appendVersionRecord, record.headVersion, event, sql)
      );
      if (!accepted) {
        // Another writer advanced the head between our read and the guarded
        // write (only possible across processes; in-process writes are queued).
        const refreshed = await this.deps.store.getById(record.id);
        return this.artifacts.artifactLookups.staleVersionError(refreshed ?? record, baseVersion);
      }
      this.artifacts.artifactMutations.notifyChanged(request.conversationId);
      await this.artifacts.artifactMutations.flushPendingArtifactEvents();
      return this.artifacts.artifactReads.read(actorRaw, { conversationId: request.conversationId, artifactId: record.id });
    });
  }

  async rename(actorRaw: string, request: RenameArtifactRequest): Promise<ArtifactResult<ArtifactSummary>> {
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
      const record = resolved.value;
      const accessError = requireContributor(record, actor, "rename");
      if (accessError) {
        return fail<ArtifactSummary>(accessError);
      }
      const archivedError = archivedMutationError(record, "renaming it");
      if (archivedError) {
        return fail<ArtifactSummary>(archivedError);
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
        return this.artifacts.artifactLookups.summaryResult(record.id);
      }
      const oldName = record.name;
      const now = this.artifacts.artifactMutations.now();
      // Rename is a label change only: no new version, signatures untouched.
      const event = artifactEvent(
        record,
        actor,
        "renamed",
        `${artifactMemberLabel(actor)} renamed artifact ${artifactReference(record.id, newName)} (was "${oldName}")`,
        now
      );
      await this.artifacts.artifactMutations.commit({ conversationId: request.conversationId, artifactId: record.id, event }, "1",
        sql => this.deps.store.updateName(record.id, newName, newKey, now, event, sql)
      );
      this.artifacts.artifactMutations.notifyChanged(request.conversationId);
      await this.artifacts.artifactMutations.flushPendingArtifactEvents();
      return this.artifacts.artifactLookups.summaryResult(record.id);
    });
  }

  async sign(actorRaw: string, request: SignArtifactRequest): Promise<ArtifactResult<ArtifactSummary>> {
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
      const archivedError = archivedMutationError(record, "signing it");
      if (archivedError) {
        return fail<ArtifactSummary>(archivedError);
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
      const now = this.artifacts.artifactMutations.now();
      const existingSignatures = await this.deps.store.listSignatures(record.id);
      if ((request.versionEventId !== undefined && request.versionEventId !== versionRecord.versionEventId) ||
          (request.contentHash !== undefined && request.contentHash !== versionRecord.contentHash)) {
        return fail<ArtifactSummary>({ code: "stale_version", message: "The displayed artifact version now refers to different content; read it again before signing." });
      }
      const projected = computeArtifactApproval(
        record.requiredSigners,
        [...existingSignatures
          .filter((signature) => signature.versionEventId === versionRecord.versionEventId && signature.contentHash === versionRecord.contentHash)
          .map((signature) => ({ signer: signature.signer, signedAt: signature.signedAt })),
        { signer: actor, signedAt: now }]
      );
      const approvalSuffix = version === record.headVersion
        ? ` (${artifactApprovalShortLabel(projected)})`
        : "";
      const event = artifactEvent(
        record,
        actor,
        "signed",
        `${artifactMemberLabel(actor)} signed ${artifactReference(record.id, record.name)} v${version}${approvalSuffix}`,
        now
      );
      const signatureRecord = {
        artifactId: record.id,
        version,
        versionEventId: versionRecord.versionEventId,
        contentHash: versionRecord.contentHash,
        signer: actor,
        signedAt: now
      };
      // One commit: a signature the User saw accepted is never left without
      // what records it.
      const inserted = await this.artifacts.artifactMutations.commit(
        { conversationId: request.conversationId, artifactId: record.id, event },
        artifactSignatureExistsSql(record.id, versionRecord.versionEventId, actor),
        (sql) => this.deps.store.insertSignature(signatureRecord, event, sql)
      );
      if (inserted) {
        this.artifacts.artifactMutations.notifyChanged(request.conversationId);
        const summaryAfter = await this.artifacts.artifactLookups.summaryResult(record.id);
        await this.artifacts.artifactMutations.flushPendingArtifactEvents();
        return summaryAfter;
      }
      return this.artifacts.artifactLookups.summaryResult(record.id);
    });
  }

  async updateAccess(actorRaw: string, request: UpdateArtifactAccessRequest): Promise<ArtifactResult<ArtifactSummary>> {
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
      const record = resolved.value;
      if (!canManageAccess(record, actor)) {
        return fail<ArtifactSummary>({
          code: "access_denied",
          message: `Only User or the owner (${artifactMemberLabel(record.owner)}) can manage owner, contributors, or required signers of "${record.name}".`
        });
      }
      const archivedError = archivedMutationError(record, "changing access");
      if (archivedError) {
        return fail<ArtifactSummary>(archivedError);
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
      const access = { owner: nextOwner, contributors: nextContributors.filter(member => member !== nextOwner), requiredSigners: nextRequiredSigners, labels: nextLabels };
      await this.artifacts.artifactMutations.commit({ conversationId: request.conversationId, artifactId: record.id }, "1",
        sql => this.deps.store.updateAccess(record.id, access, this.artifacts.artifactMutations.now(), sql)
      );
      this.artifacts.artifactMutations.notifyChanged(request.conversationId);
      return this.artifacts.artifactLookups.summaryResult(record.id);
    });
  }

  async setArchived(actorRaw: string, request: SetArtifactArchivedRequest): Promise<ArtifactResult<ArtifactSummary>> {
    return this.artifacts.artifactMutations.withMutation(request.conversationId, async () => {
      const context = await this.artifacts.artifactLookups.requireMember(actorRaw, request.conversationId);
      if (!context.ok) {
        return context;
      }
      const { actor } = context.value;
      if (typeof request.archived !== "boolean") {
        return invalid<ArtifactSummary>("archived must be true or false.");
      }
      const resolved = await this.artifacts.artifactLookups.resolveArtifact(request.conversationId, request.artifactId, request.name);
      if (!resolved.ok) {
        return resolved;
      }
      const record = resolved.value;
      if (!canManageAccess(record, actor)) {
        return fail<ArtifactSummary>({
          code: "access_denied",
          message: `Only User or the owner (${artifactMemberLabel(record.owner)}) can archive or restore "${record.name}".`
        });
      }
      const alreadyArchived = Boolean(record.archivedAt);
      if (request.archived === alreadyArchived) {
        return this.artifacts.artifactLookups.summaryResult(record.id);
      }
      const now = this.artifacts.artifactMutations.now();
      const event = artifactEvent(
        record,
        actor,
        request.archived ? "archived" : "restored",
        `${artifactMemberLabel(actor)} ${request.archived ? "archived" : "restored"} artifact ${artifactReference(record.id, record.name)}`,
        now
      );
      await this.artifacts.artifactMutations.commit({ conversationId: request.conversationId, artifactId: record.id, event }, "1",
        sql => this.deps.store.updateArchived(record.id, request.archived ? now : undefined, now, event, sql)
      );
      this.artifacts.artifactMutations.notifyChanged(request.conversationId);
      await this.artifacts.artifactMutations.flushPendingArtifactEvents();
      return this.artifacts.artifactLookups.summaryResult(record.id);
    });
  }
}

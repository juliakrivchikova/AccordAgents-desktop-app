import type {
  ArtifactDraftContent, ArtifactDraftView, ArtifactDiffResult, ArtifactReadResult, ArtifactResult, ArtifactSummary,
  ArtifactVersionContent, ArtifactVersionMeta, DiffArtifactRequest, ListArtifactDraftsRequest, ReadArtifactDraftRequest,
  ReadArtifactRequest
} from "../../../shared/types";
import { unifiedLineDiff } from "../../../shared/artifactDiff";
import { canReadDraft, draftContent, draftViews, mustSubmitOwnDraftFirst, summaryFromRecord } from "./artifactViews";
import { fail, invalid, ok, SUBMIT_OWN_DRAFT_FIRST_MESSAGE } from "./results";
import { isVersionNumber } from "./validation";
import type { ArtifactModules } from "./modules";
import type { ArtifactServiceDeps } from "./dependencies";

/** Reads documents, their versions and drafts. */
export class ArtifactReads {
  constructor(
    private readonly artifacts: Pick<ArtifactModules, "artifactLookups">,
    private readonly deps: Pick<ArtifactServiceDeps, "store">
  ) {}

  async list(actorRaw: string, conversationId: string): Promise<ArtifactResult<ArtifactSummary[]>> {
    const context = await this.artifacts.artifactLookups.requireMember(actorRaw, conversationId);
    if (!context.ok) {
      return context;
    }
    const records = await this.deps.store.listByConversation(conversationId);
    const headSignatures = await this.deps.store.listHeadSignaturesByArtifact(conversationId);
    const summaries = await Promise.all(records.map(async (record) => summaryFromRecord(
      record,
      headSignatures.get(record.id) ?? [],
      record.lifecycle === "collecting_drafts" ? await this.deps.store.listDrafts(record.id) : []
    )));
    return ok(summaries);
  }

  async read(actorRaw: string, request: ReadArtifactRequest): Promise<ArtifactResult<ArtifactReadResult>> {
    const context = await this.artifacts.artifactLookups.requireMember(actorRaw, request.conversationId);
    if (!context.ok) {
      return context;
    }
    const resolved = await this.artifacts.artifactLookups.resolveArtifact(request.conversationId, request.artifactId, request.name);
    if (!resolved.ok) {
      return resolved;
    }
    const record = resolved.value;
    if (record.lifecycle === "collecting_drafts") {
      if (request.version !== undefined) {
        return invalid("A collecting artifact has no published version yet.");
      }
      return this.artifacts.artifactLookups.collectingRead(context.value.actor, record);
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
    const summary = summaryFromRecord(record, signatures.filter((signature) => signature.version === record.headVersion));
    const versionContent: ArtifactVersionContent = {
      version: versionRecord.version,
      versionEventId: versionRecord.versionEventId,
      contentHash: versionRecord.contentHash,
      author: versionRecord.author,
      note: versionRecord.note,
      createdAt: versionRecord.createdAt,
      signatures: signatures
        .filter((signature) => signature.versionEventId === versionRecord.versionEventId && signature.contentHash === versionRecord.contentHash)
        .map((signature) => ({ signer: signature.signer, signedAt: signature.signedAt, versionEventId: signature.versionEventId, contentHash: signature.contentHash })),
      content: versionRecord.content
    };
    const sources = await this.deps.store.listVersionSources(record.id, versionRecord.version);
    if (!request.includeHistory) {
      return ok({ lifecycle: "published", summary, version: versionContent, sources });
    }
    const metas = await this.deps.store.listVersionMetas(record.id);
    const history: ArtifactVersionMeta[] = metas.map((meta) => ({
      version: meta.version,
      versionEventId: meta.versionEventId,
      contentHash: meta.contentHash,
      author: meta.author,
      note: meta.note,
      createdAt: meta.createdAt,
      signatures: signatures
        .filter((signature) => signature.versionEventId === meta.versionEventId && signature.contentHash === meta.contentHash)
        .map((signature) => ({ signer: signature.signer, signedAt: signature.signedAt, versionEventId: signature.versionEventId, contentHash: signature.contentHash }))
    }));
    return ok({ lifecycle: "published", summary, version: versionContent, history, sources });
  }

  async diff(actorRaw: string, request: DiffArtifactRequest): Promise<ArtifactResult<ArtifactDiffResult>> {
    const context = await this.artifacts.artifactLookups.requireMember(actorRaw, request.conversationId);
    if (!context.ok) {
      return context;
    }
    const resolved = await this.artifacts.artifactLookups.resolveArtifact(request.conversationId, request.artifactId, request.name);
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
      summary: summaryFromRecord(record, headSignatures),
      fromVersion,
      toVersion,
      diff: unifiedLineDiff(from.content, to.content, {
        fromLabel: `${record.name} v${fromVersion}`,
        toLabel: `${record.name} v${toVersion}`
      })
    });
  }

  async listDrafts(
    actorRaw: string,
    request: ListArtifactDraftsRequest
  ): Promise<ArtifactResult<ArtifactDraftView[]>> {
    const context = await this.artifacts.artifactLookups.requireMember(actorRaw, request.conversationId);
    if (!context.ok) {
      return context;
    }
    const resolved = await this.artifacts.artifactLookups.resolveArtifact(request.conversationId, request.artifactId, request.name);
    if (!resolved.ok) {
      return resolved;
    }
    const drafts = await this.deps.store.listDrafts(resolved.value.id);
    return ok(draftViews(context.value.actor, resolved.value, drafts));
  }

  async readDraft(
    actorRaw: string,
    request: ReadArtifactDraftRequest
  ): Promise<ArtifactResult<ArtifactDraftContent>> {
    const context = await this.artifacts.artifactLookups.requireMember(actorRaw, request.conversationId);
    if (!context.ok) {
      return context;
    }
    const resolved = await this.artifacts.artifactLookups.resolveArtifact(request.conversationId, request.artifactId, request.name);
    if (!resolved.ok) {
      return resolved;
    }
    const draft = await this.deps.store.getDraft(request.draftId);
    if (!draft || draft.artifactId !== resolved.value.id) {
      return fail({ code: "not_found", message: "Draft not found." });
    }
    if (!canReadDraft(context.value.actor, draft)) {
      return draft.state === "editing"
        ? fail({ code: "not_found", message: "Draft not found." })
        : fail({ code: "access_denied", message: "This draft's content was not shared with you." });
    }
    const { actor } = context.value;
    if (draft.author !== actor
      && mustSubmitOwnDraftFirst(actor, resolved.value, await this.deps.store.listDrafts(resolved.value.id))) {
      return fail({ code: "access_denied", message: SUBMIT_OWN_DRAFT_FIRST_MESSAGE });
    }
    return ok(draftContent(draft));
  }
}

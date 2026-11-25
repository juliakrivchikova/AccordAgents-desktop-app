import type { ArtifactReadResult, ArtifactResult, ArtifactSummary, CollectingArtifactReadResult } from "../../../shared/types";
import { artifactMemberLabel, artifactNameKey, normalizeArtifactMember, normalizeArtifactName } from "../../../shared/artifacts";
import type { ArtifactRecord } from "../artifactStore";
import { collectingValue, summaryFromRecord } from "./artifactViews";
import { fail, invalid, ok } from "./results";
import type { ArtifactContext } from "./types";
import type { ArtifactServiceDeps } from "./dependencies";

/** Finds the document and the member a request names. */
export class ArtifactLookups {
  constructor(private readonly deps: Pick<ArtifactServiceDeps, "getMembers" | "store">) {}

  // --- internals -----------------------------------------------------------

  async collectingRead(actor: string, record: ArtifactRecord): Promise<ArtifactResult<CollectingArtifactReadResult>> {
    const drafts = await this.deps.store.listDrafts(record.id);
    return ok(collectingValue(actor, record, drafts));
  }

  async requireMember(
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

  async resolveArtifact(
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

  async staleVersionError(record: ArtifactRecord, baseVersion: number): Promise<ArtifactResult<ArtifactReadResult>> {
    const head = await this.deps.store.getVersion(record.id, record.headVersion);
    const signatures = head
      ? (await this.deps.store.listSignatures(record.id)).filter((signature) => signature.versionEventId === head.versionEventId && signature.contentHash === head.contentHash)
      : [];
    return fail({
      code: "stale_version",
      message: `The base revision of your edit (v${baseVersion}) has changed. "${record.name}" is now at v${record.headVersion}. Nothing was saved. Read the current revision and re-apply your change using its version identity and content hash.`,
      currentVersion: record.headVersion,
      current: head
        ? {
            version: head.version,
            versionEventId: head.versionEventId,
            contentHash: head.contentHash,
            author: head.author,
            note: head.note,
            createdAt: head.createdAt,
            signatures: signatures.map((signature) => ({ signer: signature.signer, signedAt: signature.signedAt, versionEventId: signature.versionEventId, contentHash: signature.contentHash })),
            content: head.content
          }
        : undefined
    });
  }

  async summaryResult(artifactId: string): Promise<ArtifactResult<ArtifactSummary>> {
    const record = await this.deps.store.getById(artifactId);
    if (!record) {
      return fail({ code: "not_found", message: "Artifact not found." });
    }
    const headSignatures = (await this.deps.store.listSignatures(record.id))
      .filter((signature) => signature.version === record.headVersion);
    const drafts = record.lifecycle === "collecting_drafts" ? await this.deps.store.listDrafts(record.id) : [];
    return ok(summaryFromRecord(record, headSignatures, drafts));
  }
}

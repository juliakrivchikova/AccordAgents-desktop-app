import type {
  ArtifactDraftContent, ArtifactDraftSummary, ArtifactDraftView, ArtifactSummary, CollectingArtifactReadResult
} from "../../../shared/types";
import { ARTIFACT_USER_MEMBER } from "../../../shared/types";
import { computeArtifactApproval, normalizeArtifactMemberList } from "../../../shared/artifacts";
import type { ArtifactDraftRecord, ArtifactRecord, ArtifactSignatureRecord } from "../artifactStore";

export function collectingValue(
  actor: string,
  record: ArtifactRecord,
  drafts: ArtifactDraftRecord[]
): CollectingArtifactReadResult {
  const submittedAuthors = new Set(drafts.filter((draft) => draft.state === "submitted").map((draft) => draft.author));
  const missingRequiredAuthors = record.requiredDraftAuthors.filter((author) => !submittedAuthors.has(author));
  const summary = summaryFromRecord(record, [], drafts);
  return {
    lifecycle: "collecting_drafts",
    summary,
    allowedDraftAuthors: record.allowedDraftAuthors,
    requiredDraftAuthors: record.requiredDraftAuthors,
    audiencePolicyByAuthor: actor === "user" || actor === record.owner ? record.audiencePolicyByAuthor : {},
    drafts: draftViews(actor, record, drafts),
    missingRequiredAuthors,
    readyToPublish: missingRequiredAuthors.length === 0
  };
}

export function draftViews(actor: string, record: ArtifactRecord, drafts: ArtifactDraftRecord[]): ArtifactDraftView[] {
  return drafts.flatMap((draft) => {
    if (draft.state === "editing" && !canReadDraft(actor, draft)) {
      return [];
    }
    return [canReadDraftContent(actor, record, draft, drafts) ? draftContent(draft) : draftSummary(draft, false)];
  });
}

// The single rule for whether an actor may see a draft's body: it was shared
// with them, and they are not a required author still owing their own draft.
export function canReadDraftContent(
  actor: string,
  record: ArtifactRecord,
  draft: ArtifactDraftRecord,
  drafts: ArtifactDraftRecord[]
): boolean {
  return canReadDraft(actor, draft)
    && (draft.author === actor || !mustSubmitOwnDraftFirst(actor, record, drafts));
}

// While a collection gathers drafts, a required author who has never
// submitted a draft of their own cannot read anyone else's, so every first
// draft stays independent even when authors write at the same time. Any draft
// the author ever submitted counts, including one later withdrawn or
// replaced: that first draft was already written unseen. Only required
// authors are held back, because they must submit anyway; an optional author
// is never locked out. User always reads everything shared with them.
export function mustSubmitOwnDraftFirst(actor: string, record: ArtifactRecord, drafts: ArtifactDraftRecord[]): boolean {
  return record.lifecycle === "collecting_drafts"
    && actor !== ARTIFACT_USER_MEMBER
    && record.requiredDraftAuthors.includes(actor)
    && !drafts.some((draft) => draft.author === actor && Boolean(draft.submittedAt));
}

export function canReadDraft(actor: string, draft: ArtifactDraftRecord): boolean {
  // Explicit readers may inspect work-in-progress drafts before submission.
  // Unselected members cannot discover editing drafts through list/read.
  return actor === "user" || actor === draft.author || draft.readers.includes(actor);
}

export function draftSummary(draft: ArtifactDraftRecord, hasContent: boolean): ArtifactDraftSummary {
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

export function draftContent(draft: ArtifactDraftRecord): ArtifactDraftContent {
  return {
    ...draftSummary(draft, true),
    hasContent: true,
    content: draft.content,
    readers: draft.readers,
    effectiveReaders: normalizeArtifactMemberList(["user", draft.author, ...draft.readers])
  };
}

export function summaryFromRecord(
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
    archivedAt: record.archivedAt,
    ...(record.originMessageId ? { originMessageId: record.originMessageId } : {}),
    approval: computeArtifactApproval(
      record.requiredSigners,
      headSignatures.map((signature) => ({ signer: signature.signer, signedAt: signature.signedAt }))
    )
  };
}

// --- Artifacts -------------------------------------------------------------
// Named, versioned, signable work products scoped to one chat. Artifacts live
// in their own SQLite tables (not in conversation payloads) so they survive
// context compaction, agent session resets, and app restarts. The User's
// server owns them and decides every change; each device keeps a copy it
// reads. Members are addressed by normalized handle ("gera") or the reserved
// "user" for the human.

export const ARTIFACT_USER_MEMBER = "user";

export type ArtifactLifecycle = "collecting_drafts" | "published";

export type ArtifactDraftState = "editing" | "submitted" | "superseded" | "withdrawn";

export type ArtifactSourceDisposition = "considered" | "excluded";

export interface ArtifactDraftAudiencePolicy {
  allowedReaders: string[];
  requiredReaders: string[];
}

export type ArtifactDraftAudiencePolicyByAuthor = Record<string, ArtifactDraftAudiencePolicy>;

export interface ArtifactSignature {
  signer: string;
  signedAt: string;
  versionEventId?: string;
  contentHash?: string;
}

export interface ArtifactVersionMeta {
  version: number;
  versionEventId: string;
  contentHash: string;
  author: string;
  note?: string;
  createdAt: string;
  signatures: ArtifactSignature[];
}

export interface ArtifactVersionContent extends ArtifactVersionMeta {
  content: string;
}

export interface ArtifactVersionSource {
  draftId: string;
  author: string;
  submittedAt: string;
  contentHash: string;
  disposition: ArtifactSourceDisposition;
  exclusionRationale?: string;
}

export type ArtifactApprovalState = "none-required" | "unsigned" | "partially-signed" | "approved";

export interface ArtifactApproval {
  state: ArtifactApprovalState;
  requiredSigners: string[];
  // Required signers who have signed the CURRENT (head) version.
  signedCurrent: string[];
}

export interface ArtifactSummary {
  id: string;
  conversationId: string;
  name: string;
  owner: string;
  contributors: string[];
  labels: string[];
  lifecycle: ArtifactLifecycle;
  headVersion: number;
  draftRosterRevision: number;
  requiredDraftCount: number;
  submittedDraftCount: number;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  /** The chat message the document was started for, when the app recorded
   *  one: that message's card in the chat shows the document's progress. */
  originMessageId?: string;
  approval: ArtifactApproval;
}

export interface PublishedArtifactReadResult {
  lifecycle: "published";
  summary: ArtifactSummary;
  version: ArtifactVersionContent;
  history?: ArtifactVersionMeta[];
  sources?: ArtifactVersionSource[];
}

export interface ArtifactDraftSummary {
  id: string;
  artifactId: string;
  author: string;
  state: ArtifactDraftState;
  editRevision: number;
  createdAt: string;
  updatedAt: string;
  submittedAt?: string;
  supersedesDraftId?: string;
  hasContent: boolean;
}

export interface ArtifactDraftContent extends ArtifactDraftSummary {
  hasContent: true;
  content: string;
  readers: string[];
  effectiveReaders: string[];
}

export type ArtifactDraftView = ArtifactDraftSummary | ArtifactDraftContent;

export interface CollectingArtifactReadResult {
  lifecycle: "collecting_drafts";
  summary: ArtifactSummary;
  allowedDraftAuthors: string[];
  requiredDraftAuthors: string[];
  audiencePolicyByAuthor: ArtifactDraftAudiencePolicyByAuthor;
  drafts: ArtifactDraftView[];
  missingRequiredAuthors: string[];
  readyToPublish: boolean;
}

export type ArtifactReadResult = PublishedArtifactReadResult | CollectingArtifactReadResult;

export interface ArtifactDiffResult {
  summary: ArtifactSummary;
  fromVersion: number;
  toVersion: number;
  diff: string;
}

export type ArtifactErrorCode =
  | "not_found"
  | "access_denied"
  | "stale_version"
  | "name_taken"
  | "invalid_request"
  // The User's server, which owns documents, did not confirm the change
  // (unreachable, or no answer in time): nothing is shown as done.
  | "server_unavailable";

export interface ArtifactError {
  code: ArtifactErrorCode;
  message: string;
  // For stale_version: the version the artifact is actually at, plus its content
  // so the editor can redo the change on top of it.
  currentVersion?: number;
  current?: ArtifactVersionContent;
  currentEditRevision?: number;
  currentRosterRevision?: number;
}

export type ArtifactResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ArtifactError };

export interface ListArtifactsRequest {
  conversationId: string;
}

export interface ReadArtifactRequest {
  conversationId: string;
  artifactId?: string;
  name?: string;
  version?: number;
  includeHistory?: boolean;
}

export interface DiffArtifactRequest {
  conversationId: string;
  artifactId?: string;
  name?: string;
  fromVersion: number;
  toVersion: number;
}

export interface CreatePublishedArtifactRequest {
  conversationId: string;
  name: string;
  initialState?: "published";
  content: string;
  note?: string;
  contributors?: string[];
  requiredSigners?: string[];
  labels?: string[];
}

export interface CreateCollectingArtifactRequest {
  conversationId: string;
  name: string;
  initialState: "collecting_drafts";
  content?: never;
  note?: never;
  contributors?: string[];
  requiredSigners?: never;
  labels?: string[];
  allowedDraftAuthors: string[];
  requiredDraftAuthors: string[];
  audiencePolicyByAuthor: ArtifactDraftAudiencePolicyByAuthor;
  operationId: string;
  /** The chat message this collection was started for. Set by the app from
   *  the creating member's turn, never taken from the member's arguments. */
  originMessageId?: string;
}

export type CreateArtifactRequest = CreatePublishedArtifactRequest | CreateCollectingArtifactRequest;

export interface ReviseArtifactRequest {
  conversationId: string;
  artifactId?: string;
  name?: string;
  baseVersion: number;
  baseVersionEventId?: string;
  baseContentHash?: string;
  content: string;
  note?: string;
}

export interface RenameArtifactRequest {
  conversationId: string;
  artifactId?: string;
  name?: string;
  newName: string;
}

export interface SignArtifactRequest {
  conversationId: string;
  artifactId?: string;
  name?: string;
  version?: number;
  versionEventId?: string;
  contentHash?: string;
}

export interface UpdateArtifactAccessRequest {
  conversationId: string;
  artifactId?: string;
  name?: string;
  owner?: string;
  contributors?: string[];
  requiredSigners?: string[];
  labels?: string[];
}

export interface ArtifactReferenceRequest {
  conversationId: string;
  artifactId?: string;
  name?: string;
}

export interface SetArtifactArchivedRequest extends ArtifactReferenceRequest {
  archived: boolean;
}

export interface ListArtifactDraftsRequest extends ArtifactReferenceRequest {}

export interface ReadArtifactDraftRequest extends ArtifactReferenceRequest {
  draftId: string;
}

export interface SaveArtifactDraftRequest extends ArtifactReferenceRequest {
  draftId?: string;
  expectedEditRevision: number;
  content: string;
  readers: string[];
  operationId: string;
}

export interface SubmitArtifactDraftRequest extends ArtifactReferenceRequest {
  draftId: string;
  expectedEditRevision: number;
  operationId: string;
}

export interface ReplaceArtifactDraftRequest extends ArtifactReferenceRequest {
  supersedesDraftId: string;
  content: string;
  readers: string[];
  operationId: string;
}

export interface WithdrawArtifactDraftRequest extends ArtifactReferenceRequest {
  draftId: string;
  operationId: string;
}

export interface UpdateArtifactDraftRosterRequest extends ArtifactReferenceRequest {
  allowedDraftAuthors: string[];
  requiredDraftAuthors: string[];
  audiencePolicyByAuthor: ArtifactDraftAudiencePolicyByAuthor;
  expectedDraftRosterRevision: number;
  operationId: string;
}

export interface PublishArtifactSourceRequest {
  draftId: string;
  disposition: ArtifactSourceDisposition;
  exclusionRationale?: string;
}

export interface PublishArtifactRequest extends ArtifactReferenceRequest {
  content: string;
  note?: string;
  requiredSigners: string[];
  sources: PublishArtifactSourceRequest[];
  operationId: string;
}

export interface ArtifactsUpdatedEvent {
  conversationId: string;
}

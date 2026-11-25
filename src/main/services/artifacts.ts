import type {
  ArtifactDraftContent, ArtifactDraftSummary, ArtifactDraftView, ArtifactDiffResult, ArtifactReadResult, ArtifactResult,
  ArtifactSummary, CollectingArtifactReadResult, CreateArtifactRequest, DiffArtifactRequest, ListArtifactDraftsRequest,
  PublishArtifactRequest, PublishedArtifactReadResult, ReadArtifactDraftRequest, ReadArtifactRequest, RenameArtifactRequest,
  ReplaceArtifactDraftRequest, ReviseArtifactRequest, SaveArtifactDraftRequest, SetArtifactArchivedRequest, SignArtifactRequest,
  SubmitArtifactDraftRequest, UpdateArtifactDraftRosterRequest, UpdateArtifactAccessRequest, WithdrawArtifactDraftRequest
} from "../../shared/types";
import type { ArtifactServiceDeps } from "./artifacts/dependencies";
import { createArtifactModules, type ArtifactModules } from "./artifacts/modules";

export type { ArtifactServiceDeps, ArtifactCommittedChange } from "./artifacts/dependencies";
export { artifactCreateMixedFieldError, SUBMIT_OWN_DRAFT_FIRST_MESSAGE } from "./artifacts/results";

/**
 * The rules of documents (artifacts). The User's server decides every change
 * with them over its own documents (HubArtifacts, agreement Д9); each device
 * reads its copy with them (ArtifactClient), so a read means the same
 * everywhere and a change is never made by a device's own copy of the rules.
 */
export class ArtifactService {
  private readonly modules: ArtifactModules;

  constructor(
    deps: ArtifactServiceDeps
  ) {
    this.modules = createArtifactModules(deps);
  }

  deleteConversationArtifacts(conversationId: string): Promise<void> {
    return this.modules.artifactChanges.deleteConversationArtifacts(conversationId);
  }

  list(actorRaw: string, conversationId: string): Promise<ArtifactResult<ArtifactSummary[]>> {
    return this.modules.artifactReads.list(actorRaw, conversationId);
  }

  read(actorRaw: string, request: ReadArtifactRequest): Promise<ArtifactResult<ArtifactReadResult>> {
    return this.modules.artifactReads.read(actorRaw, request);
  }

  diff(actorRaw: string, request: DiffArtifactRequest): Promise<ArtifactResult<ArtifactDiffResult>> {
    return this.modules.artifactReads.diff(actorRaw, request);
  }

  create(actorRaw: string, request: CreateArtifactRequest): Promise<ArtifactResult<ArtifactReadResult>> {
    return this.modules.artifactPublishing.create(actorRaw, request);
  }

  revise(actorRaw: string, request: ReviseArtifactRequest): Promise<ArtifactResult<ArtifactReadResult>> {
    return this.modules.artifactChanges.revise(actorRaw, request);
  }

  rename(actorRaw: string, request: RenameArtifactRequest): Promise<ArtifactResult<ArtifactSummary>> {
    return this.modules.artifactChanges.rename(actorRaw, request);
  }

  sign(actorRaw: string, request: SignArtifactRequest): Promise<ArtifactResult<ArtifactSummary>> {
    return this.modules.artifactChanges.sign(actorRaw, request);
  }

  updateAccess(actorRaw: string, request: UpdateArtifactAccessRequest): Promise<ArtifactResult<ArtifactSummary>> {
    return this.modules.artifactChanges.updateAccess(actorRaw, request);
  }

  setArchived(actorRaw: string, request: SetArtifactArchivedRequest): Promise<ArtifactResult<ArtifactSummary>> {
    return this.modules.artifactChanges.setArchived(actorRaw, request);
  }

  listDrafts(
    actorRaw: string,
    request: ListArtifactDraftsRequest
  ): Promise<ArtifactResult<ArtifactDraftView[]>> {
    return this.modules.artifactReads.listDrafts(actorRaw, request);
  }

  readDraft(
    actorRaw: string,
    request: ReadArtifactDraftRequest
  ): Promise<ArtifactResult<ArtifactDraftContent>> {
    return this.modules.artifactReads.readDraft(actorRaw, request);
  }

  saveDraft(
    actorRaw: string,
    request: SaveArtifactDraftRequest
  ): Promise<ArtifactResult<ArtifactDraftContent>> {
    return this.modules.artifactDrafts.saveDraft(actorRaw, request);
  }

  submitDraft(
    actorRaw: string,
    request: SubmitArtifactDraftRequest
  ): Promise<ArtifactResult<ArtifactDraftContent>> {
    return this.modules.artifactDrafts.submitDraft(actorRaw, request);
  }

  replaceDraft(
    actorRaw: string,
    request: ReplaceArtifactDraftRequest
  ): Promise<ArtifactResult<ArtifactDraftContent>> {
    return this.modules.artifactDrafts.replaceDraft(actorRaw, request);
  }

  withdrawDraft(
    actorRaw: string,
    request: WithdrawArtifactDraftRequest
  ): Promise<ArtifactResult<ArtifactDraftSummary>> {
    return this.modules.artifactDrafts.withdrawDraft(actorRaw, request);
  }

  updateDraftRoster(
    actorRaw: string,
    request: UpdateArtifactDraftRosterRequest
  ): Promise<ArtifactResult<CollectingArtifactReadResult>> {
    return this.modules.artifactDrafts.updateDraftRoster(actorRaw, request);
  }

  publish(
    actorRaw: string,
    request: PublishArtifactRequest
  ): Promise<ArtifactResult<PublishedArtifactReadResult>> {
    return this.modules.artifactPublishing.publish(actorRaw, request);
  }

  flushPendingArtifactEvents(): Promise<void> {
    return this.modules.artifactMutations.flushPendingArtifactEvents();
  }
}

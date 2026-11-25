import { ipcMain } from "electron";
import type {
  CreateArtifactRequest, DiffArtifactRequest, ListArtifactsRequest, ListArtifactDraftsRequest, PublishArtifactRequest,
  ReadArtifactRequest, ReadArtifactDraftRequest, RenameArtifactRequest, ReplaceArtifactDraftRequest, ReviseArtifactRequest,
  SaveArtifactDraftRequest, SetArtifactArchivedRequest, SignArtifactRequest, SubmitArtifactDraftRequest,
  UpdateArtifactDraftRosterRequest, WithdrawArtifactDraftRequest, UpdateArtifactAccessRequest
} from "../../../shared/types";
import { ARTIFACT_USER_MEMBER } from "../../../shared/types";
import type { DesktopApp } from "../desktopApp";

export function registerArtifactsIpc(desktopApp: DesktopApp): void {
  // Artifact operations from the renderer act as the human chat member ("user").
  ipcMain.handle("artifacts:list", (_event, request: ListArtifactsRequest) =>
    desktopApp.artifactService.list(ARTIFACT_USER_MEMBER, request?.conversationId ?? ""));

  ipcMain.handle("artifacts:read", (_event, request: ReadArtifactRequest) =>
    desktopApp.artifactService.read(ARTIFACT_USER_MEMBER, request));

  ipcMain.handle("artifacts:diff", (_event, request: DiffArtifactRequest) =>
    desktopApp.artifactService.diff(ARTIFACT_USER_MEMBER, request));

  ipcMain.handle("artifacts:create", (_event, request: CreateArtifactRequest) =>
    desktopApp.artifactService.create(ARTIFACT_USER_MEMBER, request));

  ipcMain.handle("artifacts:revise", (_event, request: ReviseArtifactRequest) =>
    desktopApp.artifactService.revise(ARTIFACT_USER_MEMBER, request));

  ipcMain.handle("artifacts:rename", (_event, request: RenameArtifactRequest) =>
    desktopApp.artifactService.rename(ARTIFACT_USER_MEMBER, request));

  ipcMain.handle("artifacts:sign", (_event, request: SignArtifactRequest) =>
    desktopApp.artifactService.sign(ARTIFACT_USER_MEMBER, request));

  ipcMain.handle("artifacts:set-access", (_event, request: UpdateArtifactAccessRequest) =>
    desktopApp.artifactService.updateAccess(ARTIFACT_USER_MEMBER, request));

  ipcMain.handle("artifacts:set-archived", (_event, request: SetArtifactArchivedRequest) =>
    desktopApp.artifactService.setArchived(ARTIFACT_USER_MEMBER, request));

  ipcMain.handle("artifacts:drafts:list", (_event, request: ListArtifactDraftsRequest) =>
    desktopApp.artifactService.listDrafts(ARTIFACT_USER_MEMBER, request));

  ipcMain.handle("artifacts:drafts:read", (_event, request: ReadArtifactDraftRequest) =>
    desktopApp.artifactService.readDraft(ARTIFACT_USER_MEMBER, request));

  ipcMain.handle("artifacts:drafts:save", (_event, request: SaveArtifactDraftRequest) =>
    desktopApp.artifactService.saveDraft(ARTIFACT_USER_MEMBER, request));

  ipcMain.handle("artifacts:drafts:submit", (_event, request: SubmitArtifactDraftRequest) =>
    desktopApp.artifactService.submitDraft(ARTIFACT_USER_MEMBER, request));

  ipcMain.handle("artifacts:drafts:replace", (_event, request: ReplaceArtifactDraftRequest) =>
    desktopApp.artifactService.replaceDraft(ARTIFACT_USER_MEMBER, request));

  ipcMain.handle("artifacts:drafts:withdraw", (_event, request: WithdrawArtifactDraftRequest) =>
    desktopApp.artifactService.withdrawDraft(ARTIFACT_USER_MEMBER, request));

  ipcMain.handle("artifacts:drafts:set-roster", (_event, request: UpdateArtifactDraftRosterRequest) =>
    desktopApp.artifactService.updateDraftRoster(ARTIFACT_USER_MEMBER, request));

  ipcMain.handle("artifacts:publish", (_event, request: PublishArtifactRequest) =>
    desktopApp.artifactService.publish(ARTIFACT_USER_MEMBER, request));
}

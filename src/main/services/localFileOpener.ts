import { shell } from "electron";
import type {
  InspectLocalFileRequest,
  InspectLocalFileResult,
  LocalFileOpenAction,
  OpenLocalFileRequest,
  OpenLocalFileResult
} from "../../shared/types";
import { resolveLocalFile, type LocalFileResolutionFailureReason } from "./repoFile";
import { SettingsService } from "./settings";
import { StorageService } from "./storage";

// Opens a local file reference clicked in chat output. This does not grant agents file-read
// access, but opening is still a local OS action and outside-workspace targets require consent.
export class LocalFileOpenerService {
  constructor(private readonly storage: StorageService, private readonly settings: SettingsService) {}

  async inspectLocalFile(request: InspectLocalFileRequest): Promise<InspectLocalFileResult> {
    const { conversationId } = this.normalizeRequestIdentity(request);
    const conversation = await this.storage.getConversation(conversationId);
    if (!conversation) {
      throw new Error("Conversation not found.");
    }

    const resolution = await resolveLocalFile(conversation.repoPath, request.path);
    if (!resolution.ok) {
      throw new Error(this.failureMessage(resolution.reason));
    }

    return {
      path: request.path,
      absolutePath: resolution.absolutePath,
      insideWorkspace: resolution.insideWorkspace,
      line: typeof request.line === "number" ? request.line : undefined,
      column: typeof request.column === "number" ? request.column : undefined
    };
  }

  async openLocalFile(request: OpenLocalFileRequest): Promise<OpenLocalFileResult> {
    const { conversationId } = this.normalizeRequestIdentity(request);
    const explicitAction = this.normalizeAction(request.action);

    const conversation = await this.storage.getConversation(conversationId);
    if (!conversation) {
      throw new Error("Conversation not found.");
    }

    const resolution = await resolveLocalFile(conversation.repoPath, request.path);
    if (!resolution.ok) {
      throw new Error(this.failureMessage(resolution.reason));
    }

    const action = explicitAction ?? (await this.defaultAction(resolution.insideWorkspace));

    if (action === "reveal") {
      shell.showItemInFolder(resolution.absolutePath);
    } else {
      const error = await shell.openPath(resolution.absolutePath);
      if (error) {
        throw new Error(`Could not open the file with the default app: ${error}`);
      }
    }

    return {
      action,
      path: request.path,
      absolutePath: resolution.absolutePath,
      insideWorkspace: resolution.insideWorkspace,
      line: typeof request.line === "number" ? request.line : undefined,
      column: typeof request.column === "number" ? request.column : undefined,
      // Neither system-default open nor Finder reveal can jump to a specific line.
      lineNavigationSupported: false
    };
  }

  async setOpenPreference(action: unknown) {
    return this.settings.setRepoFileOpenAction(this.normalizeAction(action) ?? null);
  }

  private normalizeRequestIdentity(request: InspectLocalFileRequest | OpenLocalFileRequest): { conversationId: string } {
    const conversationId = typeof request?.conversationId === "string" ? request.conversationId.trim() : "";
    if (!conversationId) {
      throw new Error("A conversation is required to open a file.");
    }
    return { conversationId };
  }

  private normalizeAction(action: unknown): LocalFileOpenAction | undefined {
    return action === "open" || action === "reveal" ? action : undefined;
  }

  private async defaultAction(insideWorkspace: boolean): Promise<LocalFileOpenAction> {
    if (!insideWorkspace) {
      throw new Error("Choose how to open this outside-workspace file first.");
    }
    return (await this.settings.getRepoFileOpenAction()) ?? "open";
  }

  private failureMessage(reason: LocalFileResolutionFailureReason): string {
    switch (reason) {
      case "base-missing":
        return "This chat has no selected workspace, so relative file links cannot be opened.";
      case "directory":
        return "That path is a directory, not a file.";
      case "not-regular-file":
        return "That path is not a regular file.";
      case "not-found":
        return "That file no longer exists.";
      default:
        return "That file path is invalid.";
    }
  }
}

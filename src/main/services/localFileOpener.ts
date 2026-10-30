import { shell } from "electron";
import type {
  InspectLocalFileRequest,
  InspectLocalFileResult,
  LocalFileOpenAction,
  OpenLocalFileRequest,
  OpenLocalFileResult,
  RepoFileOpenAction
} from "../../shared/types";
import type { FilePreviewChatLookup } from "./filePreview";
import { IntellijLauncherService, type IntellijLauncher } from "./intellijLauncher";
import type { LocalFileResolution, LocalFileResolutionFailureReason } from "./repoFile";
import { SettingsService } from "./settings";
import { WorkspaceFileResolver } from "./workspaceFiles";

interface LocalFileShell {
  openPath(filePath: string): Promise<string>;
  showItemInFolder(filePath: string): void;
}

export interface LocalFileOpenerDependencies {
  shell?: LocalFileShell;
  intellijLauncher?: IntellijLauncher;
  resolver?: WorkspaceFileResolver;
}

// Opens a local file reference clicked in chat output. This does not grant agents file-read
// access, but opening is still a local OS action and outside-workspace targets require consent.
export class LocalFileOpenerService {
  private readonly fileShell: LocalFileShell;
  private readonly intellijLauncher: IntellijLauncher;
  private readonly resolver: WorkspaceFileResolver;

  constructor(
    private readonly chats: FilePreviewChatLookup,
    private readonly settings: SettingsService,
    deps: LocalFileOpenerDependencies = {}
  ) {
    this.fileShell = deps.shell ?? shell;
    this.intellijLauncher = deps.intellijLauncher ?? new IntellijLauncherService();
    this.resolver = deps.resolver ?? new WorkspaceFileResolver();
  }

  // The chat's project folder and its git worktrees are the workspace
  // (WorkspaceFileResolver); the consent check and the open decide the same way
  // as the file panel's read and write.
  private async resolveFor(conversationId: string, rawPath: unknown): Promise<LocalFileResolution & { ok: true }> {
    const chat = await this.chats.conversationRepoPath(conversationId);
    if (!chat) {
      throw new Error("Conversation not found.");
    }
    const resolution = await this.resolver.resolve(chat.repoPath, rawPath);
    if (!resolution.ok) {
      throw new Error(this.failureMessage(resolution.reason));
    }
    return resolution;
  }

  async inspectLocalFile(request: InspectLocalFileRequest): Promise<InspectLocalFileResult> {
    const { conversationId } = this.normalizeRequestIdentity(request);
    const resolution = await this.resolveFor(conversationId, request.path);

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

    const resolution = await this.resolveFor(conversationId, request.path);

    const action = explicitAction ?? (await this.defaultAction(resolution.insideWorkspace));
    let openedAction = action;
    let fallbackMessage: string | undefined;
    let lineNavigationSupported = false;

    if (action === "reveal") {
      this.fileShell.showItemInFolder(resolution.absolutePath);
    } else if (action === "intellij-idea") {
      const result = await this.intellijLauncher.openFile({
        filePath: resolution.absolutePath,
        line: request.line,
        column: request.column
      });
      if (result.opened) {
        lineNavigationSupported = result.lineNavigationSupported;
      } else if (explicitAction) {
        throw new Error(result.message);
      } else {
        await this.openWithDefaultApp(resolution.absolutePath, result.message);
        openedAction = "open";
        fallbackMessage = `${result.message} Opened with the default app instead.`;
      }
    } else {
      await this.openWithDefaultApp(resolution.absolutePath);
    }

    return {
      action: openedAction,
      path: request.path,
      absolutePath: resolution.absolutePath,
      insideWorkspace: resolution.insideWorkspace,
      line: typeof request.line === "number" ? request.line : undefined,
      column: typeof request.column === "number" ? request.column : undefined,
      fallbackMessage,
      lineNavigationSupported
    };
  }

  async setOpenPreference(action: unknown) {
    return this.settings.setRepoFileOpenAction(this.normalizePreference(action) ?? null);
  }

  private normalizePreference(action: unknown): RepoFileOpenAction | undefined {
    return action === "panel" ? "panel" : this.normalizeAction(action);
  }

  private normalizeRequestIdentity(request: InspectLocalFileRequest | OpenLocalFileRequest): { conversationId: string } {
    const conversationId = typeof request?.conversationId === "string" ? request.conversationId.trim() : "";
    if (!conversationId) {
      throw new Error("A conversation is required to open a file.");
    }
    return { conversationId };
  }

  private normalizeAction(action: unknown): LocalFileOpenAction | undefined {
    return action === "open" || action === "reveal" || action === "intellij-idea" ? action : undefined;
  }

  private async defaultAction(insideWorkspace: boolean): Promise<LocalFileOpenAction> {
    if (!insideWorkspace) {
      throw new Error("Choose how to open this outside-workspace file first.");
    }
    const preference = await this.settings.getRepoFileOpenAction();
    // "panel" is the renderer's to show; an OS open asked without an action
    // (an unsupported file type, the panel's own button) uses the panel's
    // "Open in…" choice.
    if (preference === "panel" || !preference) {
      return (await this.settings.getRepoFileExternalOpenAction?.()) ?? "open";
    }
    return preference;
  }

  private async openWithDefaultApp(filePath: string, fallbackCause?: string): Promise<void> {
    const error = await this.fileShell.openPath(filePath);
    if (error) {
      const prefix = fallbackCause ? `${fallbackCause} Also could not open with the default app` : "Could not open the file with the default app";
      throw new Error(`${prefix}: ${error}`);
    }
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

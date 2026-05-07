import path from "node:path";
import { randomUUID } from "node:crypto";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import type { GitDiffRequest, ProviderKind, ProviderSettingsUpdate, ReviewRequest } from "../shared/types";
import { CliAgentRunner } from "./services/cliAgents";
import { ConsensusService } from "./services/consensus";
import { GitService } from "./services/git";
import { ProviderRunner } from "./services/providers";
import { SettingsService } from "./services/settings";
import { StorageService } from "./services/storage";

let mainWindow: BrowserWindow | undefined;

const gitService = new GitService();
const settingsService = new SettingsService();
const storageService = new StorageService();
const providerRunner = new ProviderRunner(settingsService);
const cliAgentRunner = new CliAgentRunner();
const consensusService = new ConsensusService(gitService, storageService, providerRunner, cliAgentRunner);
const activeReviews = new Map<string, AbortController>();

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 920,
    minWidth: 1080,
    minHeight: 720,
    title: "AI Consensus",
    backgroundColor: "#f5f2ec",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../../renderer/index.html"));
  }
}

function registerIpc(): void {
  ipcMain.handle("settings:get", () => settingsService.getPublicSettings());
  ipcMain.handle("settings:update-provider", (_event, update: ProviderSettingsUpdate) => settingsService.updateProvider(update));
  ipcMain.handle("settings:list-provider-models", (_event, kind: ProviderKind) => providerRunner.listModels(kind));
  ipcMain.handle("agents:detect", () => cliAgentRunner.detectAgents());
  ipcMain.handle("git:inspect-repo", (_event, repoPath: string) => gitService.inspectRepo(repoPath));
  ipcMain.handle("git:get-diff", (_event, request: GitDiffRequest) => gitService.getDiff(request));
  ipcMain.handle("conversations:list", () => storageService.listConversations());
  ipcMain.handle("conversations:get", (_event, id: string) => storageService.getConversation(id));
  ipcMain.handle("conversations:start-review", async (_event, request: ReviewRequest) => {
    const runId = request.runId ?? randomUUID();
    const controller = new AbortController();
    activeReviews.set(runId, controller);

    try {
      return await consensusService.startReview(
        { ...request, runId },
        controller.signal,
        (progress) => mainWindow?.webContents.send("conversations:review-progress", progress)
      );
    } catch (error) {
      const phase = controller.signal.aborted ? "cancelled" : "error";
      mainWindow?.webContents.send("conversations:review-progress", {
        runId,
        phase,
        message: error instanceof Error ? error.message : String(error),
        createdAt: new Date().toISOString()
      });
      throw error;
    } finally {
      activeReviews.delete(runId);
    }
  });
  ipcMain.handle("conversations:cancel-review", (_event, runId: string) => {
    activeReviews.get(runId)?.abort();
  });
  ipcMain.handle("dialog:select-repo", async () => {
    const options: Electron.OpenDialogOptions = {
      title: "Select repository",
      properties: ["openDirectory"]
    };
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    return result.canceled ? undefined : result.filePaths[0];
  });
}

app.whenReady().then(async () => {
  registerIpc();
  await storageService.init();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

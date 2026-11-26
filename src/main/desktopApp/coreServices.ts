import path from "node:path";
import { app, dialog, MessageChannelMain, protocol, utilityProcess } from "electron";
import { TerminalService } from "../terminal/terminalService";
import { createQuitConfirmation, installQuitConfirmation } from "../terminal/quitConfirmation";
import { DeviceIdentityService } from "../services/deviceIdentity";
import { MobilePairingService } from "../services/mobilePairing";
import { CLAUDE_CODE_COMMAND_ENV_OPTIONS, CliAgentRunner } from "../services/cliAgents";
import { ConsensusService } from "../services/consensus";
import { AppMcpService } from "../services/appMcp";
import { AppSkillsService } from "../services/appSkills";
import { AgentEnvironmentService } from "../services/agentEnvironment";
import { commandEnvironment, ensureLoginShellEnvPrimed, onComputerEnvironmentRead, resolveCommandPath, setCommandDebugLogger } from "../services/command";
import { LocalCliSignInService } from "../services/localCliSignIn";
import { DebugLogService } from "../services/debugLogs";
import { GitService } from "../services/git";
import { ProviderRunner } from "../services/providers";
import { LocalFileOpenerService } from "../services/localFileOpener";
import { FilePreviewService } from "../services/filePreview";
import { createExternalOpenLimiter, createFileEditFlusher, FILE_EDIT_FLUSH_TIMEOUT_MS } from "../services/filePanelWindow";
import { WorkspaceFileResolver } from "../services/workspaceFiles";
import { FILE_PREVIEW_PROTOCOL } from "../../shared/filePreview";
import { SettingsService } from "../services/settings";
import { StorageService } from "../services/storage";
import { ChatSearchService } from "../services/chatSearch";
import { CliImportService } from "../services/cliImport";
import { resolveSqliteExecutable } from "../services/sqliteCli";
import { PluginService } from "../services/plugins";
import { UserSkillsService } from "../services/userSkills";
import { appSkillsSourceRoot } from "./agentDetection";
import { sendToMainWindow } from "./windowState";
import { MAIN_DIRECTORY } from "../mainDirectory";
import type { DesktopApp } from "./desktopApp";

// A quit asked for with a signal (a launcher, kill, Ctrl+C in a terminal) is
// a program's, not the User's: it quits with the usual steps and asks nothing,
// as Terminal.app does. Chromium installs its own handlers while the app
// starts, after this file runs; ours go in once the app is ready, so they are
// the ones in place. Like Chromium's, they take one signal: then they step
// aside and the next signal ends the app at once, even with this process busy.
const QUIT_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;

/** What every other part of the app stands on. */
export function createCoreServices(desktopApp: DesktopApp): void {
  desktopApp.gitService = new GitService();
  desktopApp.settingsService = new SettingsService();

  desktopApp.agentEnvironmentService = new AgentEnvironmentService(desktopApp.settingsService, undefined, undefined, (error) => {
    void desktopApp.debugLogService.write("agent-environment.reconcile-error", { message: error instanceof Error ? error.message : String(error) });
  });

  // Every successful reading of this computer brings the automatic variables in
  // step, so the cloud machines follow it without the Environment page open.
  onComputerEnvironmentRead(() => {
    void desktopApp.agentEnvironmentService.reconcile().catch((error: unknown) => {
      void desktopApp.debugLogService.write("agent-environment.reconcile-error", { message: error instanceof Error ? error.message : String(error) });
    });
  });

  desktopApp.sqliteExecutable = resolveSqliteExecutable({
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    isPackaged: app.isPackaged
  });

  desktopApp.storageService = new StorageService({ sqliteExecutable: desktopApp.sqliteExecutable });
  desktopApp.debugLogService = new DebugLogService();
  desktopApp.chatSearchService = new ChatSearchService(desktopApp.storageService, desktopApp.debugLogService);
  // The User's own CLI threads on this computer, read where each CLI keeps
  // them (docs/design/cli-import/plan.md).
  desktopApp.cliImportService = new CliImportService({
    codexExecutable: async () => {
      await ensureLoginShellEnvPrimed();
      return resolveCommandPath("codex", commandEnvironment());
    },
    sqliteExecutable: desktopApp.sqliteExecutable,
    env: () => commandEnvironment(),
    appDataDir: app.getPath("appData")
  });

  // The terminal panel: shells run in their own utility process, so heavy output
  // or a crash of the native terminal module never reaches this process.
  desktopApp.terminalService = new TerminalService({
    forkHost: () => {
      const host = utilityProcess.fork(path.join(MAIN_DIRECTORY, "terminal", "terminalHost.js"), [], {
        serviceName: "AccordAgents Terminal",
        stdio: ["ignore", "ignore", "pipe"]
      });
      host.stderr?.on("data", (chunk: Buffer) => {
        void desktopApp.debugLogService.write("terminal.host-stderr", { text: chunk.toString("utf8").slice(0, 2_000) });
      });
      return host;
    },
    createChannel: () => {
      const { port1, port2 } = new MessageChannelMain();
      return { hostEnd: port1, windowEnd: port2 };
    },
    // A shell gets what local members get: the login shell's environment and
    // the variables enabled in Settings.
    environment: async () => {
      await ensureLoginShellEnvPrimed();
      return { ...commandEnvironment(), ...(await desktopApp.settingsService.getManualAgentEnvironment()).env };
    },
    log: (event, payload) => { void desktopApp.debugLogService.write(event, payload); }
  });

  /** A quit while a command runs in the terminal panel asks first, as
   *  Terminal.app does. Registered ahead of every other quit step: while the
   *  User is asked, none of them starts. An update's Restart asks the same
   *  question itself (confirmRestart) and lets its quit through. */
  desktopApp.quitConfirmation = createQuitConfirmation({
    // Not for an update's restart (asked already) nor for the re-quit after the
    // quit steps already ran: those are past asking.
    hasTerminals: () => !desktopApp.quittingForUpdate && !desktopApp.quitCleanupStarted && desktopApp.terminalService.hasLiveTerminals(),
    runningCommands: () => desktopApp.terminalService.runningCommands(),
    // A window that went away under the question is no Quit.
    ask: async (commands) => (await desktopApp.askToQuitOverRunningCommands(commands, "quit").answer) === true,
    quit: () => app.quit(),
    log: (event, payload) => { desktopApp.debugLogService.writeNow(event, payload); }
  });

  installQuitConfirmation(app, desktopApp.quitConfirmation);
  void app.whenReady().then(() => setImmediate(() => installQuitSignalHandlers(desktopApp)));
  desktopApp.workspaceFileResolver = new WorkspaceFileResolver();
  desktopApp.localFileOpenerService = new LocalFileOpenerService(desktopApp.storageService, desktopApp.settingsService, { resolver: desktopApp.workspaceFileResolver });

  desktopApp.filePreviewService = new FilePreviewService(desktopApp.storageService, desktopApp.workspaceFileResolver, app.getPath("userData"), (event) => {
    if (desktopApp.mainWindow && !desktopApp.mainWindow.isDestroyed()) desktopApp.mainWindow.webContents.send("files:changed", event);
  });

  // Images and HTML pages the chat's side panel shows load through this scheme,
  // only by tokens the panel was handed for the file it opened. It has to be
  // declared before the app is ready.
  protocol.registerSchemesAsPrivileged([
    { scheme: FILE_PREVIEW_PROTOCOL, privileges: { standard: true, secure: true, stream: true } }
  ]);

  desktopApp.fileEditFlusher = createFileEditFlusher({
    send: (requestId) => {
      const window = desktopApp.mainWindow;
      if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return false;
      window.webContents.send("files:flush", requestId);
      return true;
    },
    log: (event, payload) => { void desktopApp.debugLogService.write(event, payload); }
  });

  desktopApp.allowFilePreviewOutsideOpen = createExternalOpenLimiter();
  desktopApp.providerRunner = new ProviderRunner();
  setCommandDebugLogger(desktopApp.debugLogService);
  void desktopApp.debugLogService.write("crash-reports.start", { ...desktopApp.crashReportingStart, teamDevice: desktopApp.teamDevice });

  process.on("uncaughtException", (error, origin) => {
    recordMainProcessRuntimeError(desktopApp, "uncaughtException", error, origin);
  });

  process.on("unhandledRejection", (reason) => {
    recordMainProcessRuntimeError(desktopApp, "unhandledRejection", reason);
  });

  desktopApp.cliAgentRunner = new CliAgentRunner(
    desktopApp.debugLogService,
    () => desktopApp.settingsService.getManualAgentEnvironment(),
    { electronAppPath: app.getAppPath() }
  );

  // A CLI's own sign-in, started from the setup panel with the environment
  // members run with, so the credentials land where they will look.
  desktopApp.localCliSignInService = new LocalCliSignInService(
    (state) => { sendToMainWindow(desktopApp, "cli-sign-in:updated", state); },
    {
      manualEnvironment: async () => (await desktopApp.settingsService.getManualAgentEnvironment()).env,
      envOptions: { "claude-code": CLAUDE_CODE_COMMAND_ENV_OPTIONS },
      onSignedIn: () => {
        desktopApp.cliAgentRunner.invalidateAgentReadiness();
        // The phone's New chat offers the Assistant on a ready CLI too.
        desktopApp.hubPhonePublisher.scheduleCatalog();
      }
    },
    desktopApp.debugLogService
  );

  void desktopApp.settingsService.getCliAgentRunTimeoutMs()
    .then((timeoutMs) => desktopApp.cliAgentRunner.setRunTimeoutMs(timeoutMs))
    .catch((error) => {
      void desktopApp.debugLogService.write("settings.cli-agent-timeout.load-error", {
        message: error instanceof Error ? error.message : String(error)
      });
    });

  desktopApp.userSkillsService = new UserSkillsService({
    internalSourceRoot: appSkillsSourceRoot()
  });

  desktopApp.pluginService = new PluginService({
    userSkills: desktopApp.userSkillsService
  });

  desktopApp.appSkillsService = new AppSkillsService({
    sourceRoot: appSkillsSourceRoot(),
    appVersion: app.getVersion(),
    debugLogs: desktopApp.debugLogService
  });

  desktopApp.appMcpService = new AppMcpService(desktopApp.debugLogService);

  /** This computer's own key: it signs its requests to the User's server and
   *  what it seals and signs in its machines' rooms. */
  desktopApp.deviceIdentityService = new DeviceIdentityService(desktopApp.storageService);

  desktopApp.mobilePairingService = new MobilePairingService(desktopApp.deviceIdentityService);

  desktopApp.consensusService = new ConsensusService(desktopApp.gitService, desktopApp.storageService, desktopApp.providerRunner, desktopApp.cliAgentRunner, desktopApp.debugLogService, (conversation) => {
    sendToMainWindow(desktopApp, "conversations:updated", conversation);
  });
}

function installQuitSignalHandlers(desktopApp: DesktopApp): void {
  const onQuitSignal = (signal: NodeJS.Signals): void => {
    for (const each of QUIT_SIGNALS) process.removeListener(each, onQuitSignal);
    desktopApp.debugLogService.writeNow("app-quit.signal", { signal });
    desktopApp.quitConfirmation.allow();
    app.quit();
  };
  for (const signal of QUIT_SIGNALS) process.on(signal, onQuitSignal);
}

/**
 * Asks the window to save every file open in its panel and waits for it, at
 * most FILE_EDIT_FLUSH_TIMEOUT_MS. Unsaved text is also kept in userData, so a
 * window that does not answer loses nothing; it is offered again at the next start.
 */
export function flushRendererFileEdits(desktopApp: DesktopApp): Promise<void> {
  return desktopApp.fileEditFlusher.flush(FILE_EDIT_FLUSH_TIMEOUT_MS);
}

function runtimeErrorDetails(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack
    };
  }
  return { message: String(error) };
}

function recordMainProcessRuntimeError(desktopApp: DesktopApp, kind: "uncaughtException" | "unhandledRejection", error: unknown, origin?: string): void {
  const details = runtimeErrorDetails(error);
  console.error(`Main process ${kind}:`, error);
  void desktopApp.debugLogService.write("main.runtime-error", {
    kind,
    origin,
    ...details
  });
  // Before the app's window is up startup failed; while only the server
  // update's loader is up, the window still comes once it is done.
  if ((!desktopApp.mainWindow || desktopApp.mainWindow.isDestroyed()) && !desktopApp.serverUpdateLoaderOpen) {
    dialog.showErrorBox("AccordAgents failed", details.message);
    app.quit();
  }
}

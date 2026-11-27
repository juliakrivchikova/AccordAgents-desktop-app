import { spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isCliTerminalPlatform } from "../../shared/cliReadiness";
import { app, BrowserWindow, dialog, shell, type WebContents } from "electron";
import { createQuitQuestion, quitConfirmationDetail } from "../terminal/quitConfirmation";
import { normalizeExternalUrlForOpen } from "../../shared/externalLinks";
import { CRASH_REPORTS_ACTIVE_ARG, crashReportingActive } from "../services/crashReporting";
import { isServerUpdateLoaderWindow } from "../services/serverUpdateLoader";
import { commandEnvironment, refreshLoginShellEnv, windowsPowerShellPath } from "../services/command";
import { filePreviewNavigationDecision, shouldFlushBeforeClose } from "../services/filePanelWindow";
import { flushRendererFileEdits } from "./coreServices";
import { quitWasCancelled } from "./quit";
import { MAIN_DIRECTORY } from "../mainDirectory";
import type { DesktopApp } from "./desktopApp";

/** How long the quit question waits for a window that is still loading. */
const QUIT_PROMPT_WINDOW_LOAD_TIMEOUT_MS = 10_000;

export function createQuitPrompt(desktopApp: DesktopApp): void {
  /** One question for whoever asks while it is open (see createQuitQuestion). */
  desktopApp.askToQuitOverRunningCommands = createQuitQuestion((commands) => showTerminalQuitQuestion(desktopApp, commands));
}

export async function openExternalUrl(url: unknown): Promise<void> {
  await shell.openExternal(normalizeExternalUrlForOpen(url));
}

/**
 * An HTML page in the file panel runs in a sandboxed frame. Its navigation stays
 * inside what the panel granted; a link out goes to the system browser, and
 * nothing it does can navigate the app's own window.
 */
function guardFilePreviewNavigation(desktopApp: DesktopApp, contents: WebContents): void {
  contents.on("will-frame-navigate", (event) => {
    const decision = filePreviewNavigationDecision({
      url: event.url,
      isMainFrame: event.isMainFrame,
      // Compared by id: frame objects are not guaranteed to be the same instance.
      isPanelFrame: event.frame?.parent?.frameTreeNodeId === contents.mainFrame.frameTreeNodeId,
      granted: desktopApp.filePreviewService.isGrantedUrl(event.url)
    }, desktopApp.allowFilePreviewOutsideOpen);
    if (decision === "allow") return;
    event.preventDefault();
    if (decision === "open-outside") void openExternalUrl(event.url).catch(() => undefined);
  });
  // window.open from a page in the panel; the app itself opens outside links through IPC.
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) && desktopApp.allowFilePreviewOutsideOpen()) void openExternalUrl(url).catch(() => undefined);
    return { action: "deny" };
  });
  contents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) desktopApp.filePreviewService.releaseAll();
  });
}

export async function openTerminal(): Promise<void> {
  if (!isCliTerminalPlatform(process.platform)) {
    throw new Error("Open Terminal is available on macOS and Windows only.");
  }
  if (process.platform === "win32") {
    // A new PowerShell window in the home folder, in Windows Terminal when
    // that is the default terminal: where the setup panel's commands run.
    // Like a new macOS Terminal it gets the PATH installers set since the app
    // started, and it runs the .ps1 shims npm installs, which Windows'
    // default policy refuses.
    await refreshLoginShellEnv();
    const cmd = path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
    const args = ["/d", "/c", "start", "\"\"", `"${windowsPowerShellPath()}"`, "-NoLogo", "-ExecutionPolicy", "RemoteSigned"];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(cmd, args, {
        cwd: homedir(), env: commandEnvironment(), detached: true, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true
      });
      // `start` returns as soon as the window is up, or fails at once.
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Could not start PowerShell (exit code ${code}).`)));
    });
    return;
  }
  const candidates = [
    "/System/Applications/Utilities/Terminal.app",
    "/Applications/Utilities/Terminal.app"
  ];
  for (const candidate of candidates) {
    const error = await shell.openPath(candidate);
    if (!error) {
      return;
    }
  }
  throw new Error("Terminal could not be opened.");
}

/** The window an update question is asked on: the main one, or any other
 *  still open. */
export function updatePromptWindow(desktopApp: DesktopApp): BrowserWindow | undefined {
  if (desktopApp.mainWindow && !desktopApp.mainWindow.isDestroyed()) return desktopApp.mainWindow;
  return BrowserWindow.getAllWindows().find((window) => !window.isDestroyed() && !isServerUpdateLoaderWindow(window));
}

/** Whether a frame shows the app's own page: the dev server's in a dev run,
 *  else the bundled index.html, compared as file paths (URL encodings of the
 *  same path may differ). */
function isAppPageUrl(url: string): boolean {
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) return url.startsWith(devServerUrl);
  if (!url.startsWith("file:")) return false;
  try {
    return path.resolve(fileURLToPath(url.split(/[?#]/)[0] ?? "")) === path.resolve(MAIN_DIRECTORY, "../../renderer/index.html");
  } catch {
    return false;
  }
}

/** Refuses a call that does not come from the app's own page in a window's
 *  main frame (a subframe, or a document the window navigated to). */
export function assertAppPage(desktopApp: DesktopApp, event: Electron.IpcMainInvokeEvent, what = "The terminal", logEvent = "terminal.refused-sender"): void {
  const frame = event.senderFrame;
  const fromAppPage = Boolean(frame) && frame === event.sender.mainFrame && isAppPageUrl(frame?.url ?? "");
  if (!fromAppPage) {
    void desktopApp.debugLogService.write(logEvent, { url: frame?.url ?? null });
    throw new Error(`${what} is only available to the app's own window.`);
  }
}

/** The question on the app's window, as a sheet: a message box with no
 *  shown parent window runs modally on macOS and stops the whole main process
 *  until it is answered (see showUpdateRestartPrompt). With the window closed
 *  or minimized, it is brought back first. */
async function showTerminalQuitQuestion(desktopApp: DesktopApp, commands: Array<string | null> | undefined): Promise<boolean | undefined> {
  // The app's own window if one is open (also one whose page crashed), else
  // a new one.
  if (!updatePromptWindow(desktopApp)) createWindow(desktopApp);
  const window = updatePromptWindow(desktopApp);
  // With no window to ask on, the question cannot be asked: quit.
  if (!window || window.isDestroyed()) return true;
  if (window.isMinimized()) window.restore();
  window.show();
  if (process.platform === "darwin") app.focus({ steal: true });
  window.focus();
  if (window.webContents.isLoading()) {
    await new Promise<void>((resolve) => {
      const loaded = (): void => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        if (!window.isDestroyed()) window.webContents.removeListener("did-finish-load", loaded);
        resolve();
      }, QUIT_PROMPT_WINDOW_LOAD_TIMEOUT_MS);
      window.webContents.once("did-finish-load", loaded);
    });
  }
  if (window.isDestroyed()) return true;
  // A sheet whose window goes away never answers: settle it as unanswered,
  // or every later quit would wait for it forever.
  let onClosed: (() => void) | undefined;
  const closed = new Promise<undefined>((resolve) => {
    onClosed = () => resolve(undefined);
    window.once("closed", onClosed);
  });
  const answered = dialog.showMessageBox(window, {
    type: "warning",
    buttons: ["Quit", "Cancel"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    message: "Quit AccordAgents?",
    detail: quitConfirmationDetail(commands)
  }).then(({ response }) => response === 0);
  try {
    return await Promise.race([answered, closed]);
  } finally {
    if (onClosed && !window.isDestroyed()) window.removeListener("closed", onClosed);
  }
}

export function createWindow(desktopApp: DesktopApp): void {
  const windowTitle = process.env.ACCORDAGENTS_WINDOW_TITLE?.trim() || "AccordAgents";
  const window = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 1080,
    minHeight: 720,
    title: windowTitle,
    backgroundColor: "#f5f2ec",
    ...(process.platform === "darwin" ? {
      titleBarStyle: "hiddenInset" as const,
      // Centred in the renderer's 46px title rows (--app-header-height): the
      // buttons are 14px tall, so a top of 16 puts their middle at 23, level
      // with the sidebar's brand row and the workspace title (17 left them a
      // pixel low, the User, 2026-11-22). Rows leave
      // --app-traffic-light-inset (80px) clear for the lights.
      trafficLightPosition: { x: 16, y: 16 }
    } : {}),
    webPreferences: {
      preload: path.join(MAIN_DIRECTORY, "../preload/index.js"),
      additionalArguments: crashReportingActive() ? [CRASH_REPORTS_ACTIVE_ARG] : [],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  desktopApp.mainWindow = window;
  // A restart for an update waits for every window to close; these say which
  // window closed, which did not, and why a renderer could not answer.
  const windowId = window.id;
  void desktopApp.debugLogService.write("app-window.created", { windowId, windows: BrowserWindow.getAllWindows().length });
  let fileEditsFlushedForClose = false;
  window.on("close", (event) => {
    // Closing the window without quitting (Cmd+W): the panel saves its open
    // file first. Never while quitting or restarting for an update: a prevented
    // close then cancels the quit (2026-10-20), and both of those save through
    // their own step.
    if (shouldFlushBeforeClose({
      alreadyFlushed: fileEditsFlushedForClose,
      quittingForUpdate: desktopApp.quittingForUpdate,
      quitCleanupStarted: desktopApp.quitCleanupStarted,
      isMainWindow: desktopApp.mainWindow === window
    })) {
      event.preventDefault();
      fileEditsFlushedForClose = true;
      void flushRendererFileEdits(desktopApp).finally(() => {
        if (!window.isDestroyed()) window.close();
      });
      return;
    }
    desktopApp.debugLogService.writeNow("app-window.close", { windowId, forUpdate: desktopApp.quittingForUpdate, quitting: desktopApp.quitCleanupStarted });
    if (desktopApp.mainWindow === window) {
      // Kept for a quit whose window then keeps its page (quitWasCancelled).
      if (desktopApp.quitCleanupStarted) desktopApp.mainWindowLetGoByQuit = window;
      desktopApp.mainWindow = undefined;
    }
  });
  window.on("closed", () => {
    desktopApp.debugLogService.writeNow("app-window.closed", { windowId, windows: BrowserWindow.getAllWindows().length });
    desktopApp.filePreviewService.releaseAll();
  });
  guardFilePreviewNavigation(desktopApp, window.webContents);
  // macOS hides the traffic lights in full screen: the title rows then drop
  // the room they keep for them (app-shell.tsx).
  const sendFullScreen = (): void => {
    if (!window.isDestroyed()) window.webContents.send("app:full-screen-changed", window.isFullScreen());
  };
  window.on("enter-full-screen", sendFullScreen);
  window.on("leave-full-screen", sendFullScreen);
  window.on("unresponsive", () => {
    void desktopApp.debugLogService.write("app-window.unresponsive", { windowId });
  });
  window.on("responsive", () => {
    void desktopApp.debugLogService.write("app-window.responsive", { windowId });
  });
  window.webContents.on("will-prevent-unload", () => {
    desktopApp.debugLogService.writeNow("app-window.unload-prevented", { windowId });
    // The page keeps itself open as the quit closes the windows: the quit
    // does not happen. While its steps run nothing of the quit closes a
    // window, so a page kept then is another close's (Cmd+W), not the quit's.
    if (desktopApp.quitCleanupFinished) quitWasCancelled(desktopApp, "a window kept its page");
  });
  window.webContents.on("destroyed", () => {
    if (desktopApp.mainWindow === window) {
      desktopApp.mainWindow = undefined;
    }
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    desktopApp.filePreviewService.releaseAll();
    void desktopApp.debugLogService.write("app-window.renderer-gone", { windowId, reason: details.reason, exitCode: details.exitCode });
    if (desktopApp.mainWindow === window) {
      desktopApp.mainWindow = undefined;
    }
  });
  window.on("page-title-updated", (event) => {
    if (windowTitle !== "AccordAgents") {
      event.preventDefault();
      window.setTitle(windowTitle);
    }
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    void window.loadURL(devServerUrl);
    window.webContents.openDevTools({ mode: "detach" });
  } else {
    void window.loadFile(path.join(MAIN_DIRECTORY, "../../renderer/index.html"));
  }
}

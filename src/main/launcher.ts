import { app } from "electron";
import { desktopUserDataDirOverride } from "./platform";
import { runGeminiMcpProxy } from "./services/geminiMcpProxy";

if (require("electron-squirrel-startup")) {
  app.quit();
} else if (process.argv.includes("--accordagents-native-supervisor")) {
  // Use the signed app's fixed entrypoint, not ELECTRON_RUN_AS_NODE (disabled
  // in packaged builds). Never initialize the desktop or its real profile here.
  if (!process.connected || typeof process.send !== "function") process.exit(1);
  app.disableHardwareAcceleration();
  app.dock?.hide();
  require("./services/nativeProcessSupervisor").runNativeProcessSupervisor();
} else if (process.argv.includes("--accordagents-gemini-mcp-proxy")) {
  app.dock?.hide();
  runGeminiMcpProxy();
} else if (process.platform === "win32" && !holdsSingleInstanceLock()) {
  process.stderr.write(`AccordAgents is already running with ${app.getPath("userData")}; its window was brought forward. ACCORDAGENTS_USER_DATA_DIR starts another profile.\n`);
  app.quit();
} else {
  require("./main");
}

/** Windows starts a new process for every launch, also while the app keeps
 *  running in the notification area: the running one opens its window
 *  (`second-instance`), and this one leaves before it touches the profile.
 *  The lock lives in the profile, so separate profiles run side by side. */
function holdsSingleInstanceLock(): boolean {
  const userDataDirOverride = desktopUserDataDirOverride();
  if (userDataDirOverride) {
    app.setPath("userData", userDataDirOverride);
  }
  return app.requestSingleInstanceLock();
}

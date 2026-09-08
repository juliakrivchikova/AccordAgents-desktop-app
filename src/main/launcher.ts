import { app } from "electron";
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
} else {
  require("./main");
}

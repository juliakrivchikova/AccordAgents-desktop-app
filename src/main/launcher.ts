import { app } from "electron";
import { runGeminiMcpProxy } from "./services/geminiMcpProxy";

if (process.argv.includes("--accordagents-gemini-mcp-proxy")) {
  app.dock?.hide();
  runGeminiMcpProxy();
} else {
  require("./main");
}

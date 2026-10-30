/**
 * Entry point of the terminal host: an Electron utility process started by
 * the main process the first time a terminal opens. It owns every shell, so
 * heavy output and a crash of the native terminal module stay out of the
 * main process, and talks to the window directly over a MessagePort.
 */
import type { MessagePortMain } from "electron";
import { spawn as spawnPty } from "node-pty";
import type { TerminalWindowToHostMessage } from "../../shared/terminal";
import {
  TERMINAL_HOST_HANGUP_MS,
  TerminalHostCore,
  type HostWindowPort,
  type MainToTerminalHostMessage,
  type TerminalHostToMainMessage
} from "./terminalHostCore";
import { ensureSpawnHelperExecutable } from "./spawnHelper";
import { readForegroundGroup } from "./foregroundGroup";

ensureSpawnHelperExecutable();

const parentPort = process.parentPort;

const core = new TerminalHostCore(
  (options) => spawnPty(options.shell, options.args, {
    name: "xterm-256color",
    cwd: options.cwd,
    env: options.env as { [key: string]: string },
    cols: options.cols,
    rows: options.rows,
    encoding: "utf8"
  }),
  (message: TerminalHostToMainMessage) => parentPort.postMessage(message),
  process.platform === "win32" ? undefined : readForegroundGroup
);

function windowPort(windowKey: string, port: MessagePortMain): HostWindowPort {
  port.on("message", (event) => {
    core.handleWindow(windowKey, event.data as TerminalWindowToHostMessage);
  });
  port.on("close", () => core.portClosed(windowKey));
  port.start();
  return {
    post: (message) => port.postMessage(message),
    close: () => port.close()
  };
}

parentPort.on("message", (event) => {
  const message = event.data as MainToTerminalHostMessage;
  if (message.type === "connect") {
    const port = event.ports[0];
    if (port) core.handleMain(message, windowPort(message.windowKey, port));
    return;
  }
  core.handleMain(message);
  if (message.type === "shutdown") {
    // Give the shells their hangup, then leave.
    setTimeout(() => process.exit(0), TERMINAL_HOST_HANGUP_MS);
  }
});

/**
 * The terminal panel: a regular shell on this computer, shown under the chat
 * the way the Codex desktop app shows one. These are the shapes shared by the
 * main process, the terminal host process and the window.
 *
 * Bytes never cross the main process: the host and the window talk over a
 * MessagePort, and main only starts, stops and lists terminals.
 */

export interface TerminalSummary {
  terminalId: string;
  /** The folder the shell started in. */
  cwd: string;
  /** The project folder this terminal belongs to, normalized; null when it
   *  was opened from a chat with no project. Compared with the open chat's
   *  project to warn about a mismatch. */
  workspaceRoot: string | null;
  /** What the tab shows: the name of the folder it started in. */
  title: string;
  /** The terminal stopped with the host that ran it; Restart brings it back
   *  in the same folder. */
  lost?: boolean;
}

export type TerminalHostState = "stopped" | "running" | "crashed";

export interface TerminalListResult {
  hostState: TerminalHostState;
  terminals: TerminalSummary[];
}

export interface CreateTerminalRequest {
  /** The project folder of the chat the terminal is opened from. */
  repoPath?: string;
  cols?: number;
  rows?: number;
}

/** Sent to windows when the host stops or starts again. */
export type TerminalHostStateEvent = TerminalListResult;

/** Messages the host sends the window over the terminal port. */
export type TerminalHostToWindowMessage =
  | { type: "data"; terminalId: string; data: string }
  | { type: "snapshot"; terminalId: string; serialized: string; cols: number; rows: number }
  | { type: "exit"; terminalId: string; exitCode: number; signal?: number };

/** Messages the window sends the host over the terminal port. */
export type TerminalWindowToHostMessage =
  | { type: "attach"; terminalId: string; cols: number; rows: number }
  | { type: "detach"; terminalId: string }
  | { type: "input"; terminalId: string; data: string }
  | { type: "resize"; terminalId: string; cols: number; rows: number }
  | { type: "ack"; terminalId: string; chars: number };

/** Output the window has not yet confirmed writing above which the host stops
 *  reading the shell, and below which it reads again. Counted in string
 *  characters, which is what crosses the port. */
export const TERMINAL_FLOW_HIGH_WATERMARK = 512 * 1024;
export const TERMINAL_FLOW_LOW_WATERMARK = 128 * 1024;

/** The preload posts this to its own page to hand the terminal port to the
 *  app (a MessagePort cannot cross contextBridge). The sandboxed preload
 *  cannot load this file, so it repeats these three strings; a test checks
 *  they match. */
export const TERMINAL_PORT_WINDOW_MESSAGE = "accordagents:terminal-port";
/** Main → preload: a new port to the terminal host. */
export const TERMINAL_PORT_CHANNEL = "terminal:port";
/** Main → preload: the host stopped or started again. */
export const TERMINAL_HOST_STATE_CHANNEL = "terminal:host-state";

/** A shell's size before its window has measured it. */
export const TERMINAL_DEFAULT_COLS = 80;
export const TERMINAL_DEFAULT_ROWS = 24;
/** Lines kept above the screen, by the window and by the host's mirror alike,
 *  so a tab shown again gets all of its history back. */
export const TERMINAL_SCROLLBACK_LINES = 5000;

/**
 * Whether a terminal belongs to the open chat, by Codex's rule: two empty
 * folders match, an empty and a set one do not, two set ones match when they
 * are the same folder.
 */
export function terminalWorkspaceMatches(terminalRoot: string | null | undefined, chatRoot: string | null | undefined): boolean {
  return normalizeRoot(terminalRoot) === normalizeRoot(chatRoot);
}

function normalizeRoot(root: string | null | undefined): string | null {
  if (typeof root !== "string") return null;
  const trimmed = root.trim();
  if (!trimmed) return null;
  return trimmed.length > 1 ? trimmed.replace(/\/+$/, "") : trimmed;
}

/** The tab title: the last segment of the folder, or the folder itself for
 *  the root. */
export function terminalTitleForCwd(cwd: string): string {
  const trimmed = cwd.replace(/\/+$/, "");
  if (!trimmed) return "/";
  const segment = trimmed.split("/").pop();
  return segment || trimmed;
}

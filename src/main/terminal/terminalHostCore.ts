import path from "node:path";
import { Terminal as HeadlessTerminal, type ITerminalAddon } from "@xterm/headless";
import {
  TERMINAL_DEFAULT_COLS,
  TERMINAL_DEFAULT_ROWS,
  TERMINAL_FLOW_HIGH_WATERMARK,
  TERMINAL_FLOW_LOW_WATERMARK,
  TERMINAL_SCROLLBACK_LINES,
  type TerminalHostToWindowMessage,
  type TerminalWindowToHostMessage
} from "../../shared/terminal";

/** The part of a node-pty terminal the host uses. */
export interface HostPty {
  readonly pid: number;
  readonly process: string;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  pause(): void;
  resume(): void;
  kill(signal?: string): void;
}

export interface HostSpawnOptions {
  shell: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  cols: number;
  rows: number;
}

export type HostSpawn = (options: HostSpawnOptions) => HostPty;

/** The process group in the foreground of a shell's terminal, or undefined
 *  when it cannot be read (then the foreground name decides). */
export type ForegroundGroup = (shellPid: number) => Promise<number | undefined>;

/** One window's end of the terminal port, as the host sees it. */
export interface HostWindowPort {
  post(message: TerminalHostToWindowMessage): void;
  close(): void;
}

/** What main asks the host to do. */
export type MainToTerminalHostMessage =
  | {
    type: "create";
    terminalId: string;
    shell: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    cols: number;
    rows: number;
    /** A line shown first in the terminal, before the shell's own output. */
    notice?: string;
  }
  | { type: "kill"; terminalId: string }
  | { type: "connect"; windowKey: string }
  | { type: "window-gone"; windowKey: string }
  | { type: "running-query"; requestId: string }
  | { type: "shutdown" };

/** What the host tells main. */
export type TerminalHostToMainMessage =
  | { type: "created"; terminalId: string }
  | { type: "create-failed"; terminalId: string; error: string }
  | { type: "exit"; terminalId: string; exitCode: number; signal?: number }
  /** One entry per terminal running a command: its name, or null when the
   *  name cannot be read. Empty: nothing runs. */
  | { type: "running"; requestId: string; commands: Array<string | null> };

/** What the host uses of @xterm/addon-serialize. Its own typings pull the
 *  browser's DOM types into the main process's program, so it is loaded
 *  untyped here. */
interface ScreenSerializer extends ITerminalAddon {
  serialize(options?: { scrollback?: number }): string;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { SerializeAddon } = require("@xterm/addon-serialize") as { SerializeAddon: new () => ScreenSerializer };

const DATA_FLUSH_MS = 8;
/** On shutdown the host gives its shells this long to take their hangup and
 *  then exits; main kills it if it is still there TERMINAL_HOST_KILL_AFTER_MS
 *  after asking, which must be the later of the two. */
export const TERMINAL_HOST_HANGUP_MS = 200;
export const TERMINAL_HOST_KILL_AFTER_MS = 500;
const MAX_DIMENSION = 1000;

interface Session {
  terminalId: string;
  pty: HostPty;
  shellName: string;
  mirror: HeadlessTerminal;
  serializer: ScreenSerializer;
  pending: string;
  flushTimer?: ReturnType<typeof setTimeout>;
  /** Characters sent (or held) for windows and not yet confirmed written. */
  unacked: number;
  /** Characters given to the mirror and not yet parsed by it. */
  mirrorBacklog: number;
  paused: boolean;
  disposables: Array<{ dispose(): void }>;
}

interface WindowConnection {
  key: string;
  port: HostWindowPort;
  attached: Set<string>;
  /** Terminals whose snapshot is being taken for this window, with the
   *  output that arrived meanwhile: it is sent right after the snapshot. */
  attaching: Map<string, string[]>;
}

/**
 * The terminal host: owns every shell, keeps a mirror of each screen so a
 * window that shows a terminal (again) gets the screen back, and paces each
 * shell to what both the mirror and the window can take. A shell is held back
 * while either is too far behind, so a runaway command can neither exhaust the
 * host's memory nor flood the window.
 */
export class TerminalHostCore {
  private readonly sessions = new Map<string, Session>();
  private readonly windows = new Map<string, WindowConnection>();

  constructor(
    private readonly spawn: HostSpawn,
    private readonly toMain: (message: TerminalHostToMainMessage) => void,
    private readonly foregroundGroup?: ForegroundGroup
  ) {}

  handleMain(message: MainToTerminalHostMessage, port?: HostWindowPort): void {
    switch (message.type) {
      case "create":
        this.create(message);
        return;
      case "kill":
        this.sessions.get(message.terminalId)?.pty.kill();
        return;
      case "connect":
        if (port) this.connect(message.windowKey, port);
        return;
      case "window-gone":
        this.disconnect(message.windowKey, true);
        return;
      case "running-query":
        void this.runningCommands().then((commands) => {
          this.toMain({ type: "running", requestId: message.requestId, commands });
        });
        return;
      case "shutdown":
        this.shutdown();
        return;
    }
  }

  handleWindow(windowKey: string, message: TerminalWindowToHostMessage): void {
    const connection = this.windows.get(windowKey);
    if (!connection || !message || typeof message.terminalId !== "string") return;
    const session = this.sessions.get(message.terminalId);
    if (!session) {
      // The shell ended before this window showed it: say so, or the window
      // would keep an empty tab for it.
      if (message.type === "attach") connection.port.post({ type: "exit", terminalId: message.terminalId, exitCode: -1 });
      return;
    }
    switch (message.type) {
      case "attach":
        this.attach(connection, session, message.cols, message.rows);
        return;
      case "detach":
        this.detach(connection, session);
        return;
      case "input":
        if (typeof message.data === "string" && message.data) session.pty.write(message.data);
        return;
      case "resize":
        this.resize(session, message.cols, message.rows);
        return;
      case "ack":
        if (!Number.isFinite(message.chars) || message.chars <= 0) return;
        session.unacked = Math.max(0, session.unacked - message.chars);
        this.pace(session);
        return;
    }
  }

  /** The window's port closed: it reloaded or closed. */
  portClosed(windowKey: string): void {
    this.disconnect(windowKey, false);
  }

  /** Whether some shell has a command in its terminal's foreground (not the
   *  shell itself waiting at its prompt). */
  /** The commands running in the terminals, one per terminal that has one:
   *  its name ("npm", "vim") for the User to see what a quit stops, or null. */
  async runningCommands(): Promise<Array<string | null>> {
    const sessions = [...this.sessions.values()];
    const running = await Promise.all(sessions.map((session) => this.commandRunning(session)));
    return sessions.filter((_session, index) => running[index]).map((session) => foregroundName(session));
  }

  sessionCount(): number {
    return this.sessions.size;
  }

  isPaused(terminalId: string): boolean {
    return this.sessions.get(terminalId)?.paused ?? false;
  }

  shutdown(): void {
    for (const session of this.sessions.values()) {
      try { session.pty.kill(); } catch { /* already gone */ }
    }
  }

  private create(message: Extract<MainToTerminalHostMessage, { type: "create" }>): void {
    if (this.sessions.has(message.terminalId)) {
      this.toMain({ type: "create-failed", terminalId: message.terminalId, error: "A terminal with this id already exists." });
      return;
    }
    const cols = clampDimension(message.cols, TERMINAL_DEFAULT_COLS);
    const rows = clampDimension(message.rows, TERMINAL_DEFAULT_ROWS);
    let pty: HostPty;
    try {
      pty = this.spawn({ shell: message.shell, args: message.args, cwd: message.cwd, env: message.env, cols, rows });
    } catch (error) {
      this.toMain({ type: "create-failed", terminalId: message.terminalId, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const mirror = new HeadlessTerminal({ cols, rows, scrollback: TERMINAL_SCROLLBACK_LINES, allowProposedApi: true });
    const serializer = new SerializeAddon();
    mirror.loadAddon(serializer);
    const session: Session = {
      terminalId: message.terminalId,
      pty,
      shellName: path.basename(message.shell),
      mirror,
      serializer,
      pending: "",
      unacked: 0,
      mirrorBacklog: 0,
      paused: false,
      disposables: []
    };
    this.sessions.set(message.terminalId, session);
    if (message.notice) this.output(session, `\x1b[2m${message.notice}\x1b[0m\r\n`);
    session.disposables.push(pty.onData((data) => this.output(session, data)));
    session.disposables.push(pty.onExit(({ exitCode, signal }) => this.exited(session, exitCode, signal)));
    this.toMain({ type: "created", terminalId: message.terminalId });
  }

  private output(session: Session, data: string): void {
    session.mirrorBacklog += data.length;
    try {
      session.mirror.write(data, () => {
        session.mirrorBacklog = Math.max(0, session.mirrorBacklog - data.length);
        this.pace(session);
      });
    } catch {
      // xterm refuses data once far behind; pacing below keeps it from
      // getting there, and a refusal must never take the host down.
      session.mirrorBacklog = Math.max(0, session.mirrorBacklog - data.length);
    }
    session.pending += data;
    if (!session.flushTimer) {
      session.flushTimer = setTimeout(() => this.flush(session), DATA_FLUSH_MS);
    }
    this.pace(session);
  }

  private flush(session: Session): void {
    if (session.flushTimer) clearTimeout(session.flushTimer);
    session.flushTimer = undefined;
    const data = session.pending;
    if (!data) return;
    session.pending = "";
    let delivered = false;
    for (const connection of this.windows.values()) {
      const held = connection.attaching.get(session.terminalId);
      if (held) {
        held.push(data);
        delivered = true;
        continue;
      }
      if (!connection.attached.has(session.terminalId)) continue;
      connection.port.post({ type: "data", terminalId: session.terminalId, data });
      delivered = true;
    }
    // Output no window shows goes only to the mirror; the mirror's own
    // backlog paces the shell then.
    if (delivered) session.unacked += data.length;
    this.pace(session);
  }

  /** Holds the shell back while the mirror or a window is too far behind,
   *  and lets it go once both have caught up. */
  private pace(session: Session): void {
    const behind = session.unacked > TERMINAL_FLOW_HIGH_WATERMARK || session.mirrorBacklog > TERMINAL_FLOW_HIGH_WATERMARK;
    const caughtUp = session.unacked < TERMINAL_FLOW_LOW_WATERMARK && session.mirrorBacklog < TERMINAL_FLOW_LOW_WATERMARK;
    if (!session.paused && behind) {
      session.paused = true;
      session.pty.pause();
    } else if (session.paused && caughtUp) {
      session.paused = false;
      session.pty.resume();
    }
  }

  /** Forgets what windows have not confirmed: a window that (re)attaches
   *  starts from a snapshot, and one that went away confirms nothing. */
  private forgetUnacked(session: Session): void {
    session.unacked = 0;
    this.pace(session);
  }

  private attach(connection: WindowConnection, session: Session, cols: number, rows: number): void {
    // A new port's attach can arrive before the old port's close, so what
    // was counted against earlier windows is dropped here too.
    this.forgetUnacked(session);
    // Output so far is already in the mirror's queue and goes into the
    // snapshot; it is sent now only to windows that were attached before.
    this.flush(session);
    connection.attached.delete(session.terminalId);
    const held: string[] = [];
    connection.attaching.set(session.terminalId, held);
    this.resize(session, cols, rows);
    // The mirror parses what it is given asynchronously; the empty write's
    // callback runs once everything before it is on the mirror's screen.
    session.mirror.write("", () => {
      if (this.windows.get(connection.key) !== connection) return;
      if (connection.attaching.get(session.terminalId) !== held) return;
      connection.attaching.delete(session.terminalId);
      if (this.sessions.get(session.terminalId) !== session) return;
      connection.port.post({
        type: "snapshot",
        terminalId: session.terminalId,
        serialized: session.serializer.serialize({ scrollback: TERMINAL_SCROLLBACK_LINES }),
        cols: session.mirror.cols,
        rows: session.mirror.rows
      });
      connection.attached.add(session.terminalId);
      const data = held.join("");
      if (data) connection.port.post({ type: "data", terminalId: session.terminalId, data });
    });
  }

  /** The window stopped showing this terminal (a hidden tab, a closed
   *  panel): its output goes only to the mirror until it is shown again. */
  private detach(connection: WindowConnection, session: Session): void {
    connection.attached.delete(session.terminalId);
    connection.attaching.delete(session.terminalId);
    this.forgetUnacked(session);
  }

  private resize(session: Session, cols: number, rows: number): void {
    const nextCols = clampDimension(cols, session.mirror.cols);
    const nextRows = clampDimension(rows, session.mirror.rows);
    if (nextCols === session.mirror.cols && nextRows === session.mirror.rows) return;
    try { session.pty.resize(nextCols, nextRows); } catch { /* the shell may be exiting */ }
    session.mirror.resize(nextCols, nextRows);
  }

  private exited(session: Session, exitCode: number, signal?: number): void {
    this.flush(session);
    // Every window hears it, also those not showing this terminal now, so a
    // hidden tab closes too.
    for (const connection of this.windows.values()) {
      connection.attaching.delete(session.terminalId);
      connection.attached.delete(session.terminalId);
      connection.port.post({ type: "exit", terminalId: session.terminalId, exitCode, signal });
    }
    for (const disposable of session.disposables) disposable.dispose();
    if (session.flushTimer) clearTimeout(session.flushTimer);
    session.mirror.dispose();
    this.sessions.delete(session.terminalId);
    this.toMain({ type: "exit", terminalId: session.terminalId, exitCode, signal });
  }

  private connect(windowKey: string, port: HostWindowPort): void {
    this.disconnect(windowKey, true);
    this.windows.set(windowKey, { key: windowKey, port, attached: new Set(), attaching: new Map() });
  }

  private disconnect(windowKey: string, closePort: boolean): void {
    const connection = this.windows.get(windowKey);
    if (!connection) return;
    this.windows.delete(windowKey);
    if (closePort) {
      try { connection.port.close(); } catch { /* already closed */ }
    }
    const terminalIds = [...connection.attached, ...connection.attaching.keys()];
    connection.attached.clear();
    connection.attaching.clear();
    for (const terminalId of terminalIds) {
      const session = this.sessions.get(terminalId);
      if (session) this.forgetUnacked(session);
    }
  }

  private async commandRunning(session: Session): Promise<boolean> {
    if (this.foregroundGroup) {
      const group = await this.foregroundGroup(session.pty.pid).catch(() => undefined);
      // The shell leads its own process group; anything else in front of the
      // terminal is a command it started.
      if (group !== undefined) return group !== session.pty.pid;
    }
    const foreground = foregroundProcessName(session);
    return foreground !== undefined && foreground !== session.shellName;
  }
}

/** The name of the process in front of a terminal, as a login shell shows
 *  it without its leading dash; undefined when it cannot be read. */
function foregroundProcessName(session: Session): string | undefined {
  try {
    return path.basename(session.pty.process ?? "").replace(/^-/, "") || undefined;
  } catch {
    return undefined;
  }
}

function foregroundName(session: Session): string | null {
  const name = foregroundProcessName(session);
  return name && name !== session.shellName ? name : null;
}

function clampDimension(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const rounded = Math.floor(value);
  if (rounded < 1) return fallback;
  return Math.min(rounded, MAX_DIMENSION);
}

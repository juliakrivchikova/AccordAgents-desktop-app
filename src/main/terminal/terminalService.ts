import { randomUUID } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MessagePortMain } from "electron";
import {
  TERMINAL_DEFAULT_COLS,
  TERMINAL_DEFAULT_ROWS,
  TERMINAL_HOST_STATE_CHANNEL,
  TERMINAL_PORT_CHANNEL,
  terminalTitleForCwd,
  type CreateTerminalRequest,
  type TerminalHostState,
  type TerminalListResult,
  type TerminalSummary
} from "../../shared/terminal";
import { TERMINAL_HOST_KILL_AFTER_MS, type MainToTerminalHostMessage, type TerminalHostToMainMessage } from "./terminalHostCore";

/** The terminal host process, as main uses it (an Electron UtilityProcess). */
export interface TerminalHostProcess {
  postMessage(message: MainToTerminalHostMessage, transfer?: MessagePortMain[]): void;
  on(event: "message", listener: (message: TerminalHostToMainMessage) => void): void;
  on(event: "exit", listener: (code: number) => void): void;
  kill(): boolean;
}

/** A window the terminal talks to (an Electron WebContents). */
export interface TerminalWindow {
  readonly id: number;
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
  postMessage(channel: string, message: unknown, transfer: MessagePortMain[]): void;
  once(event: "destroyed", listener: () => void): void;
}

export interface TerminalServiceOptions {
  forkHost: () => TerminalHostProcess;
  /** A new MessageChannelMain: one end for the host, one for the window. */
  createChannel: () => { hostEnd: MessagePortMain; windowEnd: MessagePortMain };
  /** The environment a shell gets: the same one local members get. */
  environment: () => Promise<NodeJS.ProcessEnv>;
  homeDir?: string;
  platform?: NodeJS.Platform;
  log?: (event: string, payload: Record<string, unknown>) => void;
  createTimeoutMs?: number;
  runningQueryTimeoutMs?: number;
}

interface TerminalRecord extends TerminalSummary {
  shell: string;
  args: string[];
}

/** Variables of the app itself that a user's shell has no use for. */
const APP_ONLY_ENV_KEY = /^(ELECTRON_|ACCORDAGENTS_|ACCORD_AGENTS_|VITE_DEV_SERVER_URL$|ORIGINAL_XDG_CURRENT_DESKTOP$|CHROME_DESKTOP$)/;

export const TERMINAL_RESTARTED_NOTICE = "The terminal restarted. Processes that were running in it were stopped.";

export function missingProjectNotice(repoPath: string): string {
  return `Project folder ${repoPath} was not found on this computer. The terminal opened in your home folder.`;
}

/**
 * The main process's side of the terminal panel: starts and restarts the
 * host, keeps the list of terminals (so they can be reopened if the host
 * dies), hands each window its port, and answers the update restart gate.
 * Not one byte of terminal input or output passes through here.
 */
export class TerminalService {
  private host?: TerminalHostProcess;
  private hostState: TerminalHostState = "stopped";
  private stopping = false;
  private readonly terminals = new Map<string, TerminalRecord>();
  /** Terminals the host lost when it died; they come back on restart. */
  private readonly lost = new Set<string>();
  private readonly pendingCreates = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  /** Shells that ended before their start was confirmed. */
  private readonly endedWhileStarting = new Set<string>();
  private readonly pendingQueries = new Map<string, (commands: Array<string | null> | undefined) => void>();
  private readonly windows = new Map<number, TerminalWindow>();
  private restarting?: Promise<TerminalListResult>;
  private readonly homeDir: string;
  private readonly platform: NodeJS.Platform;

  constructor(private readonly options: TerminalServiceOptions) {
    this.homeDir = options.homeDir ?? os.homedir();
    this.platform = options.platform ?? process.platform;
  }

  list(): TerminalListResult {
    return { hostState: this.hostState, terminals: this.summaries() };
  }

  async create(request: CreateTerminalRequest = {}): Promise<TerminalSummary> {
    const folder = await this.resolveFolder(request.repoPath);
    const environment = terminalEnvironment(await this.options.environment());
    const { shell, args } = this.shellFor(environment);
    const record: TerminalRecord = {
      terminalId: randomUUID(),
      cwd: folder.cwd,
      workspaceRoot: folder.workspaceRoot,
      title: terminalTitleForCwd(folder.cwd),
      shell,
      args
    };
    // Listed only once started: a host that dies meanwhile must not leave a
    // tab for a shell that never ran.
    await this.startShell(record, environment, request.cols, request.rows, folder.notice);
    if (this.endedWhileStarting.delete(record.terminalId)) throw new Error("The terminal's shell ended as soon as it started.");
    this.terminals.set(record.terminalId, record);
    this.log("terminal.created", { terminalId: record.terminalId, missingProject: Boolean(folder.notice) });
    return summary(record, false);
  }

  kill(terminalId: string): void {
    if (this.lost.has(terminalId) || !this.host) {
      this.forget(terminalId);
      this.broadcastState();
      return;
    }
    if (this.terminals.has(terminalId)) this.host.postMessage({ type: "kill", terminalId });
  }

  /** Remembers a window, so it hears when the host stops unexpectedly. */
  watchWindow(window: TerminalWindow): void {
    if (this.windows.has(window.id) || window.isDestroyed()) return;
    this.windows.set(window.id, window);
    window.once("destroyed", () => {
      this.windows.delete(window.id);
      this.host?.postMessage({ type: "window-gone", windowKey: String(window.id) });
    });
  }

  /** Gives the window a fresh port to the host. False while no host runs. */
  connect(window: TerminalWindow): boolean {
    this.watchWindow(window);
    if (!this.host || this.hostState !== "running" || window.isDestroyed()) return false;
    const { hostEnd, windowEnd } = this.options.createChannel();
    this.host.postMessage({ type: "connect", windowKey: String(window.id) }, [hostEnd]);
    window.postMessage(TERMINAL_PORT_CHANNEL, null, [windowEnd]);
    return true;
  }

  /** Brings back the terminals the host lost when it stopped unexpectedly.
   *  One restart at a time: a second click joins the one under way. */
  restartLost(): Promise<TerminalListResult> {
    this.restarting ??= this.restartLostOnce().finally(() => { this.restarting = undefined; });
    return this.restarting;
  }

  private async restartLostOnce(): Promise<TerminalListResult> {
    const lost = [...this.lost].map((id) => this.terminals.get(id)).filter((record): record is TerminalRecord => Boolean(record));
    if (lost.length) {
      const environment = terminalEnvironment(await this.options.environment());
      for (const record of lost) {
        try {
          await this.startShell(record, environment, undefined, undefined, TERMINAL_RESTARTED_NOTICE);
          if (this.endedWhileStarting.delete(record.terminalId)) this.forget(record.terminalId);
          // Closed while it was starting again: nobody shows it any more.
          else if (!this.terminals.has(record.terminalId)) this.host?.postMessage({ type: "kill", terminalId: record.terminalId });
          else this.lost.delete(record.terminalId);
        } catch (error) {
          this.log("terminal.restart-failed", { terminalId: record.terminalId, error: errorText(error) });
        }
      }
    } else {
      this.ensureHost();
    }
    this.broadcastState();
    return this.list();
  }

  async workspaceRoot(repoPath?: string): Promise<string | null> {
    return (await this.resolveFolder(repoPath)).workspaceRoot;
  }

  /** Whether there are shells running now (tabs not lost with the host). */
  hasLiveTerminals(): boolean {
    return Boolean(this.host) && this.hostState === "running" && this.terminals.size > this.lost.size;
  }

  /** The commands running in the terminals; undefined when the host does not
   *  answer in time (then nobody can say nothing runs). */
  runningCommands(): Promise<Array<string | null> | undefined> {
    const host = this.host;
    if (!host || !this.hasLiveTerminals()) return Promise.resolve([]);
    const requestId = randomUUID();
    return new Promise<Array<string | null> | undefined>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingQueries.delete(requestId);
        resolve(undefined);
      }, this.options.runningQueryTimeoutMs ?? 1_500);
      this.pendingQueries.set(requestId, (commands) => {
        clearTimeout(timer);
        resolve(commands);
      });
      host.postMessage({ type: "running-query", requestId });
    });
  }

  /** On quit: every shell gets its hangup and the host leaves. */
  shutdown(): void {
    const host = this.host;
    if (!host) return;
    this.stopping = true;
    try { host.postMessage({ type: "shutdown" }); } catch { /* already gone */ }
    const timer = setTimeout(() => { try { host.kill(); } catch { /* already gone */ } }, TERMINAL_HOST_KILL_AFTER_MS);
    timer.unref?.();
  }

  private async startShell(
    record: TerminalRecord,
    env: NodeJS.ProcessEnv,
    cols: number | undefined,
    rows: number | undefined,
    notice: string | undefined
  ): Promise<void> {
    const host = this.ensureHost();
    const created = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCreates.delete(record.terminalId);
        reject(new Error("The terminal did not start in time."));
      }, this.options.createTimeoutMs ?? 10_000);
      this.pendingCreates.set(record.terminalId, {
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: (error) => { clearTimeout(timer); reject(error); }
      });
    });
    host.postMessage({
      type: "create",
      terminalId: record.terminalId,
      shell: record.shell,
      args: record.args,
      cwd: record.cwd,
      env,
      cols: cols ?? TERMINAL_DEFAULT_COLS,
      rows: rows ?? TERMINAL_DEFAULT_ROWS,
      ...(notice ? { notice } : {})
    });
    await created;
  }

  private ensureHost(): TerminalHostProcess {
    if (this.host && this.hostState === "running") return this.host;
    const host = this.options.forkHost();
    this.host = host;
    this.hostState = "running";
    this.stopping = false;
    host.on("message", (message) => {
      if (this.host === host) this.handleHostMessage(message);
    });
    host.on("exit", (code) => {
      if (this.host !== host) return;
      this.hostExited(code);
    });
    this.log("terminal.host-started", {});
    // Windows that held a port to an earlier host need one to this host.
    if (this.windows.size) queueMicrotask(() => this.broadcastState());
    return host;
  }

  private handleHostMessage(message: TerminalHostToMainMessage): void {
    switch (message.type) {
      case "created": {
        const pending = this.pendingCreates.get(message.terminalId);
        this.pendingCreates.delete(message.terminalId);
        if (pending) pending.resolve();
        // A start that came after its caller gave up: nobody lists this
        // shell, so it must not run unseen.
        else if (!this.terminals.has(message.terminalId)) this.host?.postMessage({ type: "kill", terminalId: message.terminalId });
        return;
      }
      case "create-failed":
        this.pendingCreates.get(message.terminalId)?.reject(new Error(`The terminal could not start: ${message.error}`));
        this.pendingCreates.delete(message.terminalId);
        return;
      case "exit":
        this.log("terminal.exited", { terminalId: message.terminalId, exitCode: message.exitCode, signal: message.signal ?? null });
        if (this.pendingCreates.has(message.terminalId)) this.endedWhileStarting.add(message.terminalId);
        if (this.terminals.has(message.terminalId)) {
          this.forget(message.terminalId);
          // A window without a port (its panel closed since a reload) hears
          // it this way and drops the tab.
          this.broadcastState();
        }
        return;
      case "running":
        this.pendingQueries.get(message.requestId)?.(message.commands);
        this.pendingQueries.delete(message.requestId);
        return;
    }
  }

  private hostExited(code: number): void {
    const expected = this.stopping;
    this.host = undefined;
    for (const pending of this.pendingCreates.values()) pending.reject(new Error("The terminal stopped before it started."));
    this.pendingCreates.clear();
    for (const answer of this.pendingQueries.values()) answer([]);
    this.pendingQueries.clear();
    if (expected || this.terminals.size === 0) {
      this.hostState = "stopped";
      this.terminals.clear();
      this.lost.clear();
      // Windows drop their port to the host that is gone.
      if (!expected) this.broadcastState();
      return;
    }
    this.hostState = "crashed";
    for (const terminalId of this.terminals.keys()) this.lost.add(terminalId);
    this.log("terminal.host-crashed", { code, terminals: this.terminals.size });
    this.broadcastState();
  }

  private forget(terminalId: string): void {
    this.terminals.delete(terminalId);
    this.lost.delete(terminalId);
  }

  private broadcastState(): void {
    const event = this.list();
    for (const window of this.windows.values()) {
      if (!window.isDestroyed()) window.send(TERMINAL_HOST_STATE_CHANNEL, event);
    }
  }

  private summaries(): TerminalSummary[] {
    return [...this.terminals.values()].map((record) => summary(record, this.lost.has(record.terminalId)));
  }

  private async resolveFolder(repoPath: string | undefined): Promise<{ cwd: string; workspaceRoot: string | null; notice?: string }> {
    const requested = typeof repoPath === "string" ? repoPath.trim() : "";
    if (!requested) return { cwd: this.homeDir, workspaceRoot: null };
    try {
      const real = await fs.realpath(requested);
      if ((await fs.stat(real)).isDirectory()) return { cwd: real, workspaceRoot: real };
    } catch {
      // Missing or unreadable: open at home and say so.
    }
    return { cwd: this.homeDir, workspaceRoot: path.resolve(requested), notice: missingProjectNotice(requested) };
  }

  private shellFor(env: NodeJS.ProcessEnv): { shell: string; args: string[] } {
    if (this.platform === "win32") {
      return { shell: "powershell.exe", args: [] };
    }
    const candidates = [env.SHELL, safeUserShell(), "/bin/zsh", "/bin/bash", "/bin/sh"];
    const shell = candidates.find((candidate): candidate is string =>
      typeof candidate === "string" && path.isAbsolute(candidate) && existsSync(candidate)) ?? "/bin/sh";
    return { shell, args: ["-l"] };
  }

  private log(event: string, payload: Record<string, unknown>): void {
    this.options.log?.(event, payload);
  }
}

/** A shell's environment: what local members get, without the app's own
 *  variables, with a terminal type xterm.js understands. */
export function terminalEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || APP_ONLY_ENV_KEY.test(key)) continue;
    env[key] = value;
  }
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  env.TERM_PROGRAM = "AccordAgents";
  if (!env.LANG) env.LANG = "en_US.UTF-8";
  return env;
}

function summary(record: TerminalRecord, lost: boolean): TerminalSummary {
  return {
    terminalId: record.terminalId,
    cwd: record.cwd,
    workspaceRoot: record.workspaceRoot,
    title: record.title,
    ...(lost ? { lost: true } : {})
  };
}

function safeUserShell(): string | undefined {
  try {
    return os.userInfo().shell ?? undefined;
  } catch {
    return undefined;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

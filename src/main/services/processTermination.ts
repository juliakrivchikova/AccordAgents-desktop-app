import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { performance } from "node:perf_hooks";

type KillableProcess = Pick<ChildProcess, "pid" | "kill">;
type TrackedProcess = KillableProcess & Pick<ChildProcess, "exitCode" | "signalCode" | "killed">;

export interface CapturedPosixProcess {
  pid: number;
  startedAt: string;
}

export interface PosixProcessRow extends CapturedPosixProcess {
  ppid: number;
  pgid: number;
  state?: string;
}

export type PosixProcessTableReader = () => Map<number, PosixProcessRow> | undefined;

const POSIX_PS_PATH = "/bin/ps";
const POSIX_PS_ARGS = ["-axo", "pid=,ppid=,pgid=,stat=,lstart="];
const POSIX_PS_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const POSIX_PS_TIMEOUT_MS = 1_000;
// A `ps` that printed nothing new for this long while the event loop was
// live is treated as hung; it normally answers in tens of milliseconds.
const POSIX_PS_ASYNC_TIMEOUT_MS = 2_000;
// However long a stalled loop or a slow but progressing `ps` keeps a read
// alive, it ends by then. Three owner samples stay inside the app's 35 s
// native start window.
const PROCESS_TABLE_MAX_MS = 8_000;
const PROCESS_TABLE_STALL_MS = 100;
const PROCESS_TABLE_RECHECK_MS = 1_000;

function parsePosixProcessTable(output: string): Map<number, PosixProcessRow> {
  const rows = new Map<number, PosixProcessRow>();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/);
    if (!match) {
      continue;
    }
    const pid = Number.parseInt(match[1], 10);
    rows.set(pid, {
      pid,
      ppid: Number.parseInt(match[2], 10),
      pgid: Number.parseInt(match[3], 10),
      state: match[4],
      startedAt: match[5]
    });
  }
  return rows;
}

export function readPosixProcessTableSync(): Map<number, PosixProcessRow> | undefined {
  if (process.platform === "win32") {
    return new Map();
  }
  if (process.platform === "linux") {
    try {
      const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      const rows = new Map<number, PosixProcessRow>();
      for (const pid of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
        try { const row = parseLinuxProcessStat(readFileSync(`/proc/${pid}/stat`, "utf8"), boot); rows.set(row.pid, row); }
        catch (error) { if (!processDisappeared(error)) throw error; }
      }
      return rows;
    } catch { return undefined; }
  }
  try {
    const output = execFileSync(POSIX_PS_PATH, POSIX_PS_ARGS, {
      encoding: "utf8",
      maxBuffer: POSIX_PS_MAX_BUFFER_BYTES,
      timeout: POSIX_PS_TIMEOUT_MS,
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" }
    });
    return parsePosixProcessTable(output);
  } catch {
    return undefined;
  }
}

export function readPosixProcessTableAsync(): Promise<Map<number, PosixProcessRow> | undefined> {
  if (process.platform === "win32") {
    return Promise.resolve(new Map());
  }
  if (process.platform === "linux") return readLinuxProcessTable();
  return readProcessTableOutput(POSIX_PS_PATH, POSIX_PS_ARGS, POSIX_PS_ASYNC_TIMEOUT_MS);
}

/** Runs a `ps`-shaped command and parses its table, or returns undefined.
 *  A table is accepted only when the command exited cleanly and its whole
 *  output was read: a partial table would report live processes as gone.
 *
 *  The deadline counts the command's silence, not wall time. Electron's main
 *  thread holds the event loop for hundreds of milliseconds, sometimes over a
 *  second, while the app starts, and the packaged native supervisor runs
 *  there. During such a stall `ps` blocks on a full stdout pipe (8 KB per
 *  loop turn in Electron), so a wall-clock timer came due mid-output and
 *  killed it: execFile then reported an empty table as a success. A deadline
 *  that fired late, or after output kept arriving, is checked again after
 *  another live window; PROCESS_TABLE_MAX_MS bounds the whole read.
 *  Exported for tests. */
export async function readProcessTableOutput(
  command: string,
  args: string[],
  timeoutMs: number,
  maxMs = PROCESS_TABLE_MAX_MS
): Promise<Map<number, PosixProcessRow> | undefined> {
  const output = await readCommandOutput(command, args, { timeoutMs, maxMs, env: { ...process.env, LC_ALL: "C", TZ: "UTC" } });
  return output === undefined ? undefined : parsePosixProcessTable(output);
}

/** A short command's whole stdout, or undefined when it failed, overflowed
 *  or stayed silent past its deadline on a live event loop (see
 *  readProcessTableOutput for why the deadline must survive a stalled loop). */
export function readCommandOutput(
  command: string,
  args: string[],
  options: { timeoutMs: number; maxMs?: number; maxBytes?: number; env?: NodeJS.ProcessEnv }
): Promise<string | undefined> {
  const { timeoutMs, maxMs = PROCESS_TABLE_MAX_MS, maxBytes = POSIX_PS_MAX_BUFFER_BYTES, env = process.env } = options;
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"], env });
    } catch {
      resolve(undefined);
      return;
    }
    const startedAt = performance.now();
    const chunks: Buffer[] = [];
    let bytes = 0;
    let bytesAtCheck = 0;
    let ended = false;
    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (output: string | undefined): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      resolve(output);
      return true;
    };
    const abandon = (): void => {
      // Settled first: kill() can emit "error" synchronously, which lands here.
      if (!finish(undefined)) return;
      try { child.kill("SIGKILL"); } catch { /* it already exited */ }
      child.stdout?.destroy();
    };
    const complete = (): void => {
      if (!ended || !exit) return;
      finish(exit.code === 0 && exit.signal === null ? Buffer.concat(chunks).toString("utf8") : undefined);
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) { abandon(); return; }
      chunks.push(chunk);
    });
    child.stdout?.on("end", () => { ended = true; complete(); });
    child.stdout?.on("error", abandon);
    child.on("error", abandon);
    child.on("exit", (code, signal) => { exit = { code, signal }; complete(); });
    const arm = (ms: number): void => {
      const due = performance.now() + ms;
      // setImmediate: output that is already waiting is read before the check.
      timer = setTimeout(() => setImmediate(() => {
        if (settled) return;
        const now = performance.now();
        const stalled = now - due > PROCESS_TABLE_STALL_MS;
        const progressed = bytes > bytesAtCheck;
        bytesAtCheck = bytes;
        if ((stalled || progressed) && now - startedAt < maxMs) {
          arm(Math.min(timeoutMs, PROCESS_TABLE_RECHECK_MS, Math.max(1, maxMs - (now - startedAt))));
          return;
        }
        abandon();
      }), ms);
    };
    arm(timeoutMs);
  });
}

/** The process reading the table and the process that started it both exist
 *  while it runs, so a sample that cannot show both was not read (`ps` failed,
 *  hung or overflowed): sample again, fresh, a bounded number of times. The
 *  parent is the one that started us; once it is gone (we were reparented)
 *  there is no owner to record. Identities come from the same reader as every
 *  later liveness check, so they stay comparable. */
export async function captureProcessAndParent(
  readTable: (fresh: boolean) => Promise<Map<number, PosixProcessRow> | undefined>,
  self: { pid: number; ppid: number } = process,
  attempts = 3,
  retryMs = 250
): Promise<{ self: CapturedPosixProcess; parent: CapturedPosixProcess } | undefined> {
  const parentPid = self.ppid;
  if (parentPid <= 1) return undefined;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, retryMs * attempt));
    if (self.ppid !== parentPid) return undefined;
    const rows = await readTable(attempt > 0);
    const own = capturePosixProcessIdentity(self.pid, () => rows);
    const parent = capturePosixProcessIdentity(parentPid, () => rows);
    if (own && parent && rows?.get(self.pid)?.ppid === parentPid) return { self: own, parent };
  }
  return undefined;
}

/** /proc starttime is measured since boot, not against wall time (kernel
 * proc documentation, stat field 22). Include the kernel boot identity so
 * persisted pids cannot match an unrelated process after an OS restart. */
export function parseLinuxProcessStat(value: string, boot: string): PosixProcessRow {
  const close = value.lastIndexOf(")");
  const pid = Number(value.slice(0, value.indexOf(" ")));
  const fields = value.slice(close + 2).trim().split(/\s+/);
  const ppid = Number(fields[1]);
  const pgid = Number(fields[2]);
  if (close < 0 || !Number.isSafeInteger(pid) || pid < 1 || !Number.isSafeInteger(ppid) || ppid < 0 ||
      !Number.isSafeInteger(pgid) || pgid < 0 || !/^\d+$/.test(fields[19] ?? "") || !/^[a-fA-F0-9-]{36}$/.test(boot)) {
    throw new Error("Invalid process identity from /proc.");
  }
  return { pid, ppid, pgid, state: fields[0], startedAt: `linux:${boot}:${fields[19]}` };
}

async function readLinuxProcessTable(): Promise<Map<number, PosixProcessRow> | undefined> {
  try {
    const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    const pids = (await readdir("/proc")).filter((name) => /^\d+$/.test(name));
    const rows = new Map<number, PosixProcessRow>();
    for (let offset = 0; offset < pids.length; offset += 32) {
      await Promise.all(pids.slice(offset, offset + 32).map(async (pid) => {
        try { const row = parseLinuxProcessStat(await readFile(`/proc/${pid}/stat`, "utf8"), boot); rows.set(row.pid, row); }
        catch (error) { if (!processDisappeared(error)) throw error; }
      }));
    }
    return rows;
  } catch { return undefined; }
}

function processDisappeared(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ESRCH";
}

export function capturePosixDescendantsFromTable(
  rootPid: number | undefined,
  rows: Map<number, PosixProcessRow>,
  retained: CapturedPosixProcess[] = [],
  rootIdentity?: CapturedPosixProcess
): CapturedPosixProcess[] {
  const childPids = new Map<number, number[]>();
  for (const row of rows.values()) {
    const children = childPids.get(row.ppid) ?? [];
    children.push(row.pid);
    childPids.set(row.ppid, children);
  }
  const captured = new Map<string, CapturedPosixProcess>();
  const retainedRoots: number[] = [];
  for (const identity of retained) {
    if (rows.get(identity.pid)?.startedAt === identity.startedAt) {
      captured.set(`${identity.pid}:${identity.startedAt}`, identity);
      retainedRoots.push(identity.pid);
    }
  }
  const rootMatches = rootPid && (
    !rootIdentity || rows.get(rootPid)?.startedAt === rootIdentity.startedAt
  );
  const pending = [
    ...(rootMatches ? (childPids.get(rootPid) ?? []) : []),
    ...retainedRoots.flatMap((pid) => childPids.get(pid) ?? [])
  ];
  const visited = new Set<number>();
  while (pending.length > 0) {
    const pid = pending.pop();
    if (!pid || visited.has(pid)) {
      continue;
    }
    visited.add(pid);
    const row = rows.get(pid);
    if (!row) {
      continue;
    }
    const identity = { pid: row.pid, startedAt: row.startedAt };
    captured.set(`${identity.pid}:${identity.startedAt}`, identity);
    pending.push(...(childPids.get(pid) ?? []));
  }
  return Array.from(captured.values());
}

export function capturePosixDescendants(
  rootPid: number | undefined,
  retained: CapturedPosixProcess[] = [],
  rootIdentity?: CapturedPosixProcess,
  readProcessTable: PosixProcessTableReader = readPosixProcessTableSync
): CapturedPosixProcess[] {
  if (process.platform === "win32" || (!rootPid && retained.length === 0)) {
    return [];
  }
  const rows = readProcessTable();
  return rows ? capturePosixDescendantsFromTable(rootPid, rows, retained, rootIdentity) : retained;
}

export function capturePosixProcessIdentity(
  pid: number | undefined,
  readProcessTable: PosixProcessTableReader = readPosixProcessTableSync
): CapturedPosixProcess | undefined {
  if (process.platform === "win32" || !pid) {
    return undefined;
  }
  const row = readProcessTable()?.get(pid);
  return row ? { pid: row.pid, startedAt: row.startedAt } : undefined;
}

export function hasLiveCapturedPosixProcesses(
  captured: CapturedPosixProcess[],
  readProcessTable: PosixProcessTableReader = readPosixProcessTableSync
): boolean {
  if (captured.length === 0) {
    return false;
  }
  const rows = readProcessTable();
  if (!rows) {
    return true;
  }
  return captured.some((identity) => {
    const row = rows.get(identity.pid);
    return row?.startedAt === identity.startedAt && !row.state?.startsWith("Z");
  });
}

export function terminateCapturedPosixProcesses(
  captured: CapturedPosixProcess[],
  signal: NodeJS.Signals,
  readProcessTable: PosixProcessTableReader = readPosixProcessTableSync
): void {
  if (captured.length === 0) {
    return;
  }
  const rows = readProcessTable();
  if (!rows) {
    return;
  }
  const signaledGroups = new Set<number>();
  for (const identity of captured) {
    const current = rows.get(identity.pid);
    if (!current || current.startedAt !== identity.startedAt || current.state?.startsWith("Z")) {
      continue;
    }
    try {
      if (current.pgid === current.pid && !signaledGroups.has(current.pgid)) {
        process.kill(-current.pgid, signal);
        signaledGroups.add(current.pgid);
      } else {
        process.kill(current.pid, signal);
      }
    } catch {
      // A captured process may exit between the identity check and the signal.
    }
  }
}

export function terminateProcess(
  child: KillableProcess,
  signal: NodeJS.Signals,
  killDescendants = false
): void {
  if (!killDescendants || !child.pid) {
    child.kill(signal);
    return;
  }

  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      child.kill(signal);
      return;
    }
  }

  try {
    const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR;
    const taskkillPath = windowsRoot ? path.join(windowsRoot, "System32", "taskkill.exe") : "taskkill.exe";
    const args = ["/PID", String(child.pid), "/T"];
    if (signal === "SIGKILL") {
      args.push("/F");
    }
    const taskkill = spawnSync(taskkillPath, args, {
      stdio: "ignore",
      windowsHide: true,
      timeout: 5_000
    });
    if (taskkill.error || taskkill.status !== 0) {
      child.kill(signal);
    }
  } catch {
    child.kill(signal);
  }
}

export function terminateProcessTreeIfRunning(child: TrackedProcess, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  terminateProcess(child, signal, true);
}

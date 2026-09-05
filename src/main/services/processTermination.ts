import { execFile, execFileSync, spawnSync, type ChildProcess } from "node:child_process";
import path from "node:path";

type KillableProcess = Pick<ChildProcess, "pid" | "kill">;
type TrackedProcess = KillableProcess & Pick<ChildProcess, "exitCode" | "signalCode" | "killed">;

export interface CapturedPosixProcess {
  pid: number;
  startedAt: string;
}

export interface PosixProcessRow extends CapturedPosixProcess {
  ppid: number;
  pgid: number;
}

export type PosixProcessTableReader = () => Map<number, PosixProcessRow> | undefined;

const POSIX_PS_PATH = "/bin/ps";
const POSIX_PS_ARGS = ["-axo", "pid=,ppid=,pgid=,lstart="];
const POSIX_PS_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const POSIX_PS_TIMEOUT_MS = 1_000;

function parsePosixProcessTable(output: string): Map<number, PosixProcessRow> {
  const rows = new Map<number, PosixProcessRow>();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/);
    if (!match) {
      continue;
    }
    const pid = Number.parseInt(match[1], 10);
    rows.set(pid, {
      pid,
      ppid: Number.parseInt(match[2], 10),
      pgid: Number.parseInt(match[3], 10),
      startedAt: match[4]
    });
  }
  return rows;
}

export function readPosixProcessTableSync(): Map<number, PosixProcessRow> | undefined {
  if (process.platform === "win32") {
    return new Map();
  }
  try {
    const output = execFileSync(POSIX_PS_PATH, POSIX_PS_ARGS, {
      encoding: "utf8",
      maxBuffer: POSIX_PS_MAX_BUFFER_BYTES,
      timeout: POSIX_PS_TIMEOUT_MS
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
  return new Promise((resolve) => {
    execFile(POSIX_PS_PATH, POSIX_PS_ARGS, {
      encoding: "utf8",
      maxBuffer: POSIX_PS_MAX_BUFFER_BYTES,
      timeout: POSIX_PS_TIMEOUT_MS
    }, (error, stdout) => {
      resolve(error ? undefined : parsePosixProcessTable(stdout));
    });
  });
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
  return captured.some((identity) => rows.get(identity.pid)?.startedAt === identity.startedAt);
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
    if (!current || current.startedAt !== identity.startedAt) {
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

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { CloudRunWorkerSettings } from "../../shared/types";
import type { RemoteRunWorkerTarget } from "./remoteRuns";

export function normalizeCloudRunWorkerSettings(value: unknown): CloudRunWorkerSettings {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<CloudRunWorkerSettings>
    : {};
  const port = typeof record.port === "number" && Number.isFinite(record.port)
    ? Math.max(1, Math.min(65_535, Math.floor(record.port)))
    : undefined;
  return {
    host: trimOptionalString(record.host),
    user: trimOptionalString(record.user),
    port,
    identityFile: trimOptionalString(record.identityFile),
    hostKeyAlias: normalizeHostKeyAlias(record.hostKeyAlias),
    workerRoot: trimOptionalString(record.workerRoot),
    remoteCwd: trimOptionalString(record.remoteCwd),
    codexPath: trimOptionalString(record.codexPath),
    claudePath: trimOptionalString(record.claudePath)
  };
}

// A worker target recorded inside a run handle, a session handle or a cleanup
// tombstone carries the public address the box had at the time. An AWS worker
// gets a NEW public address every stop/start, so those stored addresses go dead
// while the machine itself is alive and reachable at a new one. Dialling a dead
// address costs a full SSH timeout (15s) per attempt, on every reconcile pass.
//
// `hostKeyAlias` ("accordagents-<instanceId>") identifies the machine and does
// not change with the address, so it decides what a stored target means now:
//   - same machine as the configured worker -> use the current address;
//   - a different machine -> we no longer manage it, do not dial it at all;
//   - no alias on either side (manual SSH worker) -> leave it untouched.
export function resolveCurrentWorkerAddress(
  remembered: RemoteRunWorkerTarget,
  current: RemoteRunWorkerTarget | undefined
): RemoteRunWorkerTarget | undefined {
  const rememberedAlias = remembered.hostKeyAlias?.trim();
  const currentAlias = current?.hostKeyAlias?.trim();
  if (!rememberedAlias || !current || !currentAlias) {
    return remembered;
  }
  if (rememberedAlias !== currentAlias) {
    return undefined;
  }
  if (remembered.host === current.host && remembered.port === current.port) {
    return remembered;
  }
  return {
    ...remembered,
    host: current.host,
    port: current.port,
    identityFile: current.identityFile ?? remembered.identityFile
  };
}

export function cloudRunWorkerTargetFromSettings(worker: CloudRunWorkerSettings): RemoteRunWorkerTarget | undefined {
  const host = worker.host?.trim();
  if (!host) {
    return undefined;
  }
  return {
    host,
    user: worker.user,
    port: worker.port,
    identityFile: worker.identityFile,
    hostKeyAlias: worker.hostKeyAlias,
    workerRoot: worker.workerRoot,
    remoteCwd: worker.remoteCwd,
    codexPath: worker.codexPath,
    claudePath: worker.claudePath
  };
}

export function buildCloudRunSshTarget(worker: Pick<RemoteRunWorkerTarget, "host" | "user" | "identityFile">): string {
  validateCloudRunSshWorkerFields(worker);
  const host = worker.host.trim();
  const user = worker.user?.trim();
  return user ? `${user}@${host}` : host;
}

export function cloudRunSshOptionArgs(
  worker: Pick<RemoteRunWorkerTarget, "host" | "user" | "identityFile" | "hostKeyAlias" | "port">
): string[] {
  validateCloudRunSshWorkerFields(worker);
  const args = [
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    // Fail fast instead of hanging on a lossy link: bound the TCP/banner phase
    // and drop a stalled established session within ~24s so callers can retry or
    // fall back promptly (e.g. the warm-session check must not block on a blip).
    "-o",
    "ConnectTimeout=15",
    "-o",
    "ServerAliveInterval=8",
    "-o",
    "ServerAliveCountMax=3",
    ...sshMultiplexArgs(worker)
  ];
  if (worker.identityFile?.trim()) {
    args.push("-i", worker.identityFile.trim());
  }
  if (worker.hostKeyAlias?.trim()) {
    args.push("-o", `HostKeyAlias=${normalizeHostKeyAlias(worker.hostKeyAlias)}`);
  }
  if (typeof worker.port === "number" && Number.isFinite(worker.port) && worker.port > 0) {
    args.push("-p", String(Math.floor(worker.port)));
  }
  return args;
}

// A fresh TCP+auth handshake to a cloud worker costs ~1.8s, and a single chat
// turn opens about six of them (warm-session probe, mirror probe, prompt /
// context-snapshot / env writes, launch) before the agent says anything, plus
// one every few seconds while a run is polled. Measured 2026-08-20: the
// handshakes, not the data, were roughly half the pre-answer wait.
//
// Multiplexing spends that handshake once and rides the same connection for the
// rest: ~1.8s for the first call, ~0.3s for each one after it. `ControlMaster=auto`
// opens a fresh connection whenever the shared one is missing or stale, so the
// worst case is exactly today's behaviour rather than a failure. `ControlPersist`
// keeps it only while a run is live; it expires between turns.
function sshMultiplexArgs(
  worker: Pick<RemoteRunWorkerTarget, "host" | "user" | "port">
): string[] {
  const controlDir = sshControlDirectory();
  if (!controlDir) {
    return [];
  }
  // ssh's own %C token expands to a 40-char hash and it appends a 16-char
  // temporary suffix while creating the listener, which overruns the 104-byte
  // Unix socket limit under a normal home directory. Hash the destination
  // ourselves and keep it short.
  const user = worker.user?.trim() ?? "";
  const port = typeof worker.port === "number" && Number.isFinite(worker.port) ? Math.floor(worker.port) : 22;
  const key = createHash("sha256").update(`${user}@${worker.host.trim()}:${port}`).digest("hex").slice(0, 12);
  const controlPath = path.join(controlDir, key);
  // 16 bytes of headroom for the suffix ssh adds while binding the socket.
  if (Buffer.byteLength(controlPath) + 17 > 104) {
    return [];
  }
  return [
    "-o",
    "ControlMaster=auto",
    "-o",
    `ControlPath=${controlPath}`,
    "-o",
    "ControlPersist=90"
  ];
}

let cachedSshControlDirectory: string | null | undefined;

function sshControlDirectory(): string | null {
  if (cachedSshControlDirectory !== undefined) {
    return cachedSshControlDirectory;
  }
  try {
    // Under the user's home rather than a world-writable temp dir: the socket
    // grants shell access to the worker, so it must not sit where another local
    // account could pre-create or swap it.
    const dir = path.join(homedir(), ".accordagents", "ssh");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    cachedSshControlDirectory = dir;
  } catch {
    // No directory means no multiplexing, which is simply the old behaviour.
    cachedSshControlDirectory = null;
  }
  return cachedSshControlDirectory;
}

export function shellQuotePosix(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function validateCloudRunSshWorkerFields(
  worker: Pick<RemoteRunWorkerTarget, "host" | "user" | "identityFile">
): void {
  const host = worker.host.trim();
  rejectLeadingDash("Worker host", host);
  const user = worker.user?.trim();
  if (user) {
    rejectLeadingDash("Worker user", user);
  }
  const identityFile = worker.identityFile?.trim();
  if (identityFile) {
    rejectLeadingDash("Worker identity file", identityFile);
  }
  const target = user ? `${user}@${host}` : host;
  rejectLeadingDash("Worker SSH target", target);
}

function trimOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function normalizeHostKeyAlias(value: unknown): string | undefined {
  const alias = trimOptionalString(value);
  if (!alias) return undefined;
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(alias)) {
    throw new Error("Worker host key alias contains unsupported characters.");
  }
  return alias;
}

function rejectLeadingDash(label: string, value: string): void {
  if (value.startsWith("-")) {
    throw new Error(`${label} must not start with '-'.`);
  }
}

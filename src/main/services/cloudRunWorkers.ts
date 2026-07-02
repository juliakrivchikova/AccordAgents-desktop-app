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
    workerRoot: trimOptionalString(record.workerRoot),
    remoteCwd: trimOptionalString(record.remoteCwd),
    codexPath: trimOptionalString(record.codexPath)
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
    workerRoot: worker.workerRoot,
    remoteCwd: worker.remoteCwd,
    codexPath: worker.codexPath
  };
}

export function buildCloudRunSshTarget(worker: Pick<RemoteRunWorkerTarget, "host" | "user" | "identityFile">): string {
  validateCloudRunSshWorkerFields(worker);
  const host = worker.host.trim();
  const user = worker.user?.trim();
  return user ? `${user}@${host}` : host;
}

export function cloudRunSshOptionArgs(
  worker: Pick<RemoteRunWorkerTarget, "host" | "user" | "identityFile" | "port">
): string[] {
  validateCloudRunSshWorkerFields(worker);
  const args = [
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new"
  ];
  if (worker.identityFile?.trim()) {
    args.push("-i", worker.identityFile.trim());
  }
  if (typeof worker.port === "number" && Number.isFinite(worker.port) && worker.port > 0) {
    args.push("-p", String(Math.floor(worker.port)));
  }
  return args;
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

function rejectLeadingDash(label: string, value: string): void {
  if (value.startsWith("-")) {
    throw new Error(`${label} must not start with '-'.`);
  }
}

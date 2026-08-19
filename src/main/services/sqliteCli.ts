import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export const WINDOWS_SQLITE_SHA256 = "5da2398d4913b893bd1ea578d85403b3a83a06fabf9d2303ca9f63ef0849fc6f";
export const WINDOWS_SQLITE_SIZE = 4_022_272;
export const DAMAGED_SQLITE_INSTALLATION_MESSAGE =
  "AccordAgents cannot start because its bundled SQLite runtime is missing or damaged. Reinstall AccordAgents, then try again.";

export class BundledSqliteInstallationError extends Error {
  constructor(detail: string, options?: ErrorOptions) {
    super(`${DAMAGED_SQLITE_INSTALLATION_MESSAGE} (${detail})`, options);
    this.name = "BundledSqliteInstallationError";
  }
}

export interface SqliteCliResolverOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  appPath?: string;
  resourcesPath?: string;
  isPackaged?: boolean;
}

export function resolveSqliteExecutable({
  platform = process.platform,
  arch = process.arch,
  appPath,
  resourcesPath,
  isPackaged = false
}: SqliteCliResolverOptions = {}): string {
  if (platform !== "win32") {
    return "sqlite3";
  }

  const root = isPackaged ? resourcesPath : appPath;
  if (!root) {
    throw new Error(`Cannot resolve the bundled SQLite runtime without a ${isPackaged ? "resourcesPath" : "appPath"}.`);
  }

  const bundleDirectory = arch === "x64" ? "win32-x64" : `win32-${arch}`;
  return isPackaged
    ? path.join(root, "sqlite", bundleDirectory, "sqlite3.exe")
    : path.join(root, "assets", "sqlite", bundleDirectory, "sqlite3.exe");
}

export interface ValidateSqliteExecutableOptions {
  executable: string;
  platform?: NodeJS.Platform;
  arch?: string;
}

async function sha256File(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

export async function validateSqliteExecutable({
  executable,
  platform = process.platform,
  arch = process.arch
}: ValidateSqliteExecutableOptions): Promise<void> {
  if (platform !== "win32") {
    return;
  }
  if (arch !== "x64") {
    throw new BundledSqliteInstallationError(`Windows ${arch} is not supported by this installer`);
  }

  try {
    const file = await stat(executable);
    if (!file.isFile() || file.size !== WINDOWS_SQLITE_SIZE) {
      throw new Error(`unexpected file size ${file.size}`);
    }
    const digest = await sha256File(executable);
    if (digest.toLowerCase() !== WINDOWS_SQLITE_SHA256) {
      throw new Error(`checksum mismatch ${digest}`);
    }
  } catch (error) {
    if (error instanceof BundledSqliteInstallationError) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new BundledSqliteInstallationError(detail, { cause: error });
  }
}

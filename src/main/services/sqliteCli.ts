import { existsSync as fileExistsSync } from "node:fs";
import path from "node:path";

export interface SqliteCliResolverOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  appPath?: string;
  resourcesPath?: string;
  isPackaged?: boolean;
  existsSync?: (filePath: string) => boolean;
}

export function resolveSqliteExecutable({
  platform = process.platform,
  arch = process.arch,
  appPath,
  resourcesPath,
  isPackaged = false,
  existsSync = fileExistsSync
}: SqliteCliResolverOptions = {}): string {
  if (platform !== "win32") {
    return "sqlite3";
  }

  if (arch !== "x64") {
    throw new Error(`The bundled SQLite runtime supports Windows x64 only; received ${arch}.`);
  }

  const root = isPackaged ? resourcesPath : appPath;
  if (!root) {
    throw new Error(`Cannot resolve the bundled SQLite runtime without a ${isPackaged ? "resourcesPath" : "appPath"}.`);
  }

  const executable = isPackaged
    ? path.join(root, "sqlite", "win32-x64", "sqlite3.exe")
    : path.join(root, "assets", "sqlite", "win32-x64", "sqlite3.exe");
  if (!existsSync(executable)) {
    throw new Error(`Bundled SQLite executable is missing: ${executable}`);
  }

  return executable;
}

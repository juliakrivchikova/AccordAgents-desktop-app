import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parseJsonRecord } from "../cliAgents/runs/records";

// The Claude desktop app keeps a record of each session its sidebar shows as
// `<appData>/Claude/claude-code-sessions/<account>/<org>/local_<uuid>.json`
// (163 records of 2 accounts here, 56 MB, 2026-11-26). The other files and
// folders there (`account-plugins-sent.json`, `scheduled-tasks.json`,
// `deleted_<uuid>`, …) are not sessions.

const RECORD_FILE = /^local_[0-9a-f-]+\.json$/i;
/** Records read at once: one can be 1 MB. */
const RECORDS_AT_ONCE = 32;

/** A session as the Claude app's sidebar shows it. */
export interface ClaudeAppSession {
  /** The app's own id (`local_<uuid>`). */
  localId: string;
  /** Its Claude Code session: the transcript's file name. */
  cliSessionId: string;
  title: string;
  /** Where its Claude Code session runs (can be a worktree of `originCwd`). */
  cwd?: string;
  /** The repository the app files it under. */
  originCwd?: string;
  lastActivityAt?: number;
  /** The app's id of the session it was started from (a side session). */
  spawnedFrom?: string;
}

/** Where Electron's `app.getPath("appData")` is on this platform. */
export function defaultAppDataDir(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (platform === "darwin") return path.join(homedir(), "Library", "Application Support");
  if (platform === "win32") return env.APPDATA?.trim() || path.join(homedir(), "AppData", "Roaming");
  return env.XDG_CONFIG_HOME?.trim() || path.join(homedir(), ".config");
}

/** The sessions the Claude app lists for every account signed in here,
 *  archived ones left out. */
export async function claudeAppSessions(appDataDir: string): Promise<ClaudeAppSession[]> {
  const root = path.join(appDataDir, "Claude", "claude-code-sessions");
  let accounts: Dirent[];
  try {
    accounts = await readdir(root, { withFileTypes: true });
  } catch (error) {
    throw new Error((error as NodeJS.ErrnoException).code === "ENOENT"
      ? "The Claude app keeps no threads on this computer"
      : "The Claude app's threads could not be read");
  }
  const files: string[] = [];
  for (const account of accounts) {
    if (!account.isDirectory()) continue;
    const organizations = await readdir(path.join(root, account.name), { withFileTypes: true }).catch(() => [] as Dirent[]);
    for (const organization of organizations) {
      if (!organization.isDirectory()) continue;
      const folder = path.join(root, account.name, organization.name);
      const names = await readdir(folder).catch(() => [] as string[]);
      files.push(...names.filter((name) => RECORD_FILE.test(name)).map((name) => path.join(folder, name)));
    }
  }
  const sessions: ClaudeAppSession[] = [];
  for (let start = 0; start < files.length; start += RECORDS_AT_ONCE) {
    const read = await Promise.all(files.slice(start, start + RECORDS_AT_ONCE).map(async (file) => {
      const record = parseJsonRecord(await readFile(file, "utf8").catch(() => ""));
      return record ? sessionOf(record, path.basename(file, ".json")) : undefined;
    }));
    sessions.push(...read.filter((session): session is ClaudeAppSession => Boolean(session)));
  }
  return sessions;
}

function sessionOf(record: Record<string, unknown>, fileId: string): ClaudeAppSession | undefined {
  if (record.isArchived === true || typeof record.cliSessionId !== "string" || !record.cliSessionId) return undefined;
  const text = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);
  const parent = record.spawnedFrom && typeof record.spawnedFrom === "object" ? text((record.spawnedFrom as Record<string, unknown>).sessionId) : undefined;
  const cwd = text(record.cwd);
  const originCwd = text(record.originCwd);
  return {
    localId: text(record.sessionId) ?? fileId,
    cliSessionId: record.cliSessionId,
    title: text(record.title) ?? "",
    ...(cwd ? { cwd } : {}),
    ...(originCwd ? { originCwd } : {}),
    ...(typeof record.lastActivityAt === "number" ? { lastActivityAt: record.lastActivityAt } : {}),
    ...(parent ? { spawnedFrom: parent } : {})
  };
}

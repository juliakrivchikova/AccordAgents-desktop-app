import { stat } from "node:fs/promises";
import type { ChatProviderKind, CliImportListRequest, CliImportListResult, CliImportThread } from "../../../shared/types";
import { oneLine } from "./text";
import type { CliThreadFound, CliThreadReader } from "./types";

const REASON_MAX_CHARS = 200;

/** The threads of every CLI, newest first; a CLI whose store cannot be read
 *  is said with why, and the others are listed all the same. */
export async function listCliThreads(readers: readonly CliThreadReader[], request: CliImportListRequest): Promise<CliImportListResult> {
  const results = await Promise.all(readers.map(async (reader): Promise<{ kind: ChatProviderKind; threads?: CliThreadFound[]; reason?: string }> => {
    try {
      return { kind: reader.kind, threads: await reader.list(request.includeAutomated === true) };
    } catch (error) {
      return { kind: reader.kind, reason: oneLine(error instanceof Error ? error.message : String(error), REASON_MAX_CHARS) };
    }
  }));
  // A thread once: Codex's pages can repeat a thread that changed while they
  // were read (its list is ordered by a time that moves).
  const seen = new Set<string>();
  const found = results.flatMap((result) => result.threads ?? []).filter((thread) => {
    const key = `${thread.kind}:${thread.sessionId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const existing = await foldersThatExist(found.map((thread) => thread.folder));
  const threads: CliImportThread[] = found
    .map((thread) => ({ ...thread, folderExists: existing.has(thread.folder) }))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return {
    threads,
    unavailable: results.flatMap((result) => (result.reason !== undefined ? [{ kind: result.kind, reason: result.reason }] : []))
  };
}

async function foldersThatExist(folders: readonly string[]): Promise<Set<string>> {
  const unique = [...new Set(folders)].filter(Boolean);
  const exists = await Promise.all(unique.map(async (folder) => (await stat(folder).catch(() => undefined))?.isDirectory() === true));
  return new Set(unique.filter((_, index) => exists[index]));
}

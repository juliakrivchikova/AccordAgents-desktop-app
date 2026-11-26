import type { ChatProviderKind, CliImportThread } from "../../../shared/types";
import { normalizeProjectPath, projectLabelForPath } from "../../../shared/newChat";

/** Which CLI the list shows: one, or all. */
export type CliImportKindFilter = ChatProviderKind | "all";

/** A thread changed in its CLI this recently may still be open there. */
export const RECENTLY_UPDATED_MS = 10 * 60_000;

export interface CliImportFolder {
  key: string;
  folder: string;
  label: string;
  exists: boolean;
  /** Newest first. */
  threads: CliImportThread[];
}

/** The folders a list falls into, as the dialog lists them: folders that
 *  exist and hold several threads (most first), then folders that are gone,
 *  then folders with one thread each. */
export interface CliImportFolderSections {
  folders: CliImportFolder[];
  gone: CliImportFolder[];
  single: CliImportFolder[];
}

const timeOf = (value: string): number => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** The threads the filters let through, newest first. */
export function filterCliThreads(threads: CliImportThread[], kind: CliImportKindFilter, query: string): CliImportThread[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return threads
    .filter((thread) => kind === "all" || thread.kind === kind)
    .filter((thread) => words.every((word) => `${thread.title} ${thread.folder}`.toLowerCase().includes(word)))
    .sort((left, right) => timeOf(right.updatedAt) - timeOf(left.updatedAt));
}

export function cliImportFolderSections(threads: CliImportThread[]): CliImportFolderSections {
  const byFolder = new Map<string, CliImportFolder>();
  for (const thread of threads) {
    const key = normalizeProjectPath(thread.folder) ?? "";
    const folder = byFolder.get(key) ?? { key, folder: thread.folder, label: key ? projectLabelForPath(key) : "No folder", exists: thread.folderExists, threads: [] };
    folder.threads.push(thread);
    byFolder.set(key, folder);
  }
  const all = [...byFolder.values()];
  const byCount = (left: CliImportFolder, right: CliImportFolder): number =>
    right.threads.length - left.threads.length || timeOf(right.threads[0]?.updatedAt ?? "") - timeOf(left.threads[0]?.updatedAt ?? "");
  return {
    folders: all.filter((folder) => folder.exists && folder.threads.length > 1).sort(byCount),
    gone: all.filter((folder) => !folder.exists).sort(byCount),
    single: all.filter((folder) => folder.exists && folder.threads.length === 1).sort(byCount)
  };
}

/** A thread that can be chosen: not in a chat already. */
export function isImportable(thread: CliImportThread): boolean {
  return !thread.conversationId;
}

export function isRecentlyUpdated(thread: CliImportThread, now: number): boolean {
  return now - timeOf(thread.updatedAt) < RECENTLY_UPDATED_MS;
}

/** A folder's newest threads not yet in the app: New chat offers them
 *  under its heading for the folder chosen there. */
export function newestCliThreadsInFolder(threads: CliImportThread[], repoPath: string | undefined, limit: number): CliImportThread[] {
  const folder = normalizeProjectPath(repoPath);
  if (!folder) return [];
  return threads
    .filter((thread) => isImportable(thread) && thread.folderExists && normalizeProjectPath(thread.folder) === folder)
    .sort((left, right) => timeOf(right.updatedAt) - timeOf(left.updatedAt))
    .slice(0, limit);
}

/** The key of a thread in a selection. */
export function threadKey(thread: Pick<CliImportThread, "kind" | "sessionId">): string {
  return `${thread.kind}:${thread.sessionId}`;
}

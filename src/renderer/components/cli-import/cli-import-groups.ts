import type { ChatProviderKind, CliImportThread } from "../../../shared/types";
import { normalizeProjectPath, projectLabelForPath } from "../../../shared/newChat";

/** Which CLI the list shows: one, or all. */
export type CliImportKindFilter = ChatProviderKind | "all";

/** A thread changed in its CLI this recently may still be open there. */
export const RECENTLY_UPDATED_MS = 10 * 60_000;

/** A project the CLIs' apps list threads under: the thread's own folder, or
 *  the repository a worktree belongs to. */
export interface CliImportProject {
  key: string;
  path: string;
  label: string;
  /** Some of its threads' folders are still on this computer. */
  exists: boolean;
  /** Newest first. */
  threads: CliImportThread[];
}

/** The projects a list falls into, as the dialog lists them: those on this
 *  computer, then those whose folder is gone, each newest thread first. */
export interface CliImportProjectSections {
  projects: CliImportProject[];
  gone: CliImportProject[];
}

/** A thread as the dialog lists it: a side session right under the thread it
 *  was started from, one step in. */
export interface CliImportThreadRowItem {
  thread: CliImportThread;
  nested: boolean;
}

const timeOf = (value: string): number => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const newestFirst = (left: CliImportThread, right: CliImportThread): number => timeOf(right.updatedAt) - timeOf(left.updatedAt);

/** The threads the filters let through, newest first. */
export function filterCliThreads(threads: CliImportThread[], kind: CliImportKindFilter, query: string): CliImportThread[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return threads
    .filter((thread) => kind === "all" || thread.kind === kind)
    .filter((thread) => words.every((word) => `${thread.title} ${thread.project ?? ""} ${thread.folder}`.toLowerCase().includes(word)))
    .sort(newestFirst);
}

/** The key of the project a thread is listed under. */
export function cliImportProjectKey(thread: Pick<CliImportThread, "project" | "folder">): string {
  return normalizeProjectPath(thread.project ?? thread.folder) ?? "";
}

export function cliImportProjectSections(threads: CliImportThread[]): CliImportProjectSections {
  const byKey = new Map<string, CliImportProject>();
  for (const thread of [...threads].sort(newestFirst)) {
    const key = cliImportProjectKey(thread);
    const project = byKey.get(key) ?? { key, path: key, label: thread.projectName ?? (key ? projectLabelForPath(key) : "No folder"), exists: false, threads: [] };
    // A name its app gives the project wins over the folder's.
    if (thread.projectName && project.label !== thread.projectName && !project.threads.some((other) => other.projectName)) project.label = thread.projectName;
    project.exists ||= thread.folderExists;
    project.threads.push(thread);
    byKey.set(key, project);
  }
  // Insertion follows the newest thread, so the map is already newest first.
  const all = [...byKey.values()];
  return { projects: all.filter((project) => project.exists), gone: all.filter((project) => !project.exists) };
}

/** A project's threads in list order: each side session right after the
 *  thread it was started from (when that one is listed too), newest first
 *  among siblings; a side session whose parent is not listed stays on top. */
export function cliImportThreadRows(threads: CliImportThread[]): CliImportThreadRowItem[] {
  const sorted = [...threads].sort(newestFirst);
  const listed = new Set(sorted.map(threadKey));
  const parentOf = (thread: CliImportThread): string | undefined => {
    const parent = thread.parentSessionId && threadKey({ kind: thread.kind, sessionId: thread.parentSessionId });
    return parent && parent !== threadKey(thread) && listed.has(parent) ? parent : undefined;
  };
  const children = new Map<string, CliImportThread[]>();
  for (const thread of sorted) {
    const parent = parentOf(thread);
    if (parent) children.set(parent, [...(children.get(parent) ?? []), thread]);
  }
  const rows: CliImportThreadRowItem[] = [];
  const placed = new Set<string>();
  const place = (thread: CliImportThread, nested: boolean): void => {
    if (placed.has(threadKey(thread))) return;
    placed.add(threadKey(thread));
    rows.push({ thread, nested });
    for (const child of children.get(threadKey(thread)) ?? []) place(child, true);
  };
  for (const thread of sorted) if (!parentOf(thread)) place(thread, false);
  // Threads that name each other as parents have no top: list them as they come.
  for (const thread of sorted) place(thread, false);
  return rows;
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
    .filter((thread) => isImportable(thread) && thread.folderExists && cliImportProjectKey(thread) === folder)
    .sort(newestFirst)
    .slice(0, limit);
}

/** The key of a thread in a selection. */
export function threadKey(thread: Pick<CliImportThread, "kind" | "sessionId">): string {
  return `${thread.kind}:${thread.sessionId}`;
}

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { asRecord } from "../cliAgents/runs/records";

// The Codex app (ChatGPT.app on Codex 0.170) lists the threads of
// `thread/list` by project (measured here, 2026-11-26): one the User put in a
// project is under it, else one whose folder is inside a project's root;
// a chat it started outside every project (`~/Documents/Codex/<date>/…`) is
// among its chats, and a pinned thread is pinned. It shows no other thread
// (125 of 948 here), and the threads AccordAgents runs through the app-server
// are AccordAgents' own (originator `accordagents`, 23 here).

/** A project of `project/list`, with its roots. */
export interface CodexProject {
  id: string;
  name?: string;
  roots: string[];
}

/** What the Codex app keeps of its sidebar (`.codex-global-state.json`). */
export interface CodexAppState {
  /** A thread the User put in a project, to that project's id. */
  assignments: Map<string, string>;
  projectless: Set<string>;
  pinned: Set<string>;
  /** Project ids from before projects moved into the app-server, to theirs
   *  there (assignments still name some by the old id). */
  migratedProjectIds: Map<string, string>;
  /** The roots of the `local-…` projects of that time, by id. */
  localProjectRoots: Map<string, string[]>;
}

const OWN_ORIGINATOR = "accordagents";

export function codexHome(env: NodeJS.ProcessEnv): string {
  return env.CODEX_HOME?.trim() || path.join(env.HOME?.trim() || homedir(), ".codex");
}

export async function readCodexAppState(home: string): Promise<CodexAppState> {
  let state: Record<string, unknown> | undefined;
  try {
    state = asRecord(JSON.parse(await readFile(path.join(home, ".codex-global-state.json"), "utf8")) as unknown);
  } catch (error) {
    throw new Error((error as NodeJS.ErrnoException).code === "ENOENT"
      ? "The Codex app keeps no threads on this computer"
      : "The Codex app's threads could not be read");
  }
  const assignments = new Map<string, string>();
  for (const [threadId, value] of Object.entries(asRecord(state?.["thread-project-assignments"]) ?? {})) {
    const projectId = asRecord(value)?.projectId;
    if (typeof projectId === "string") assignments.set(threadId, projectId);
  }
  const migratedProjectIds = new Map<string, string>();
  for (const byHost of Object.values(asRecord(state?.["app-server-project-id-by-legacy-project-id-by-host"]) ?? {})) {
    for (const [legacyId, id] of Object.entries(asRecord(byHost) ?? {})) {
      if (typeof id === "string") migratedProjectIds.set(legacyId, id);
    }
  }
  const localProjectRoots = new Map<string, string[]>();
  for (const [id, value] of Object.entries(asRecord(state?.["local-projects"]) ?? {})) {
    localProjectRoots.set(id, strings(asRecord(value)?.rootPaths));
  }
  return {
    assignments,
    projectless: new Set(strings(state?.["projectless-thread-ids"])),
    pinned: new Set(strings(state?.["pinned-thread-ids"])),
    migratedProjectIds,
    localProjectRoots
  };
}

/** Where the Codex app lists a thread: under a project's root, on its own
 *  (a chat, a pinned thread), or not at all (undefined). */
export function codexAppPlace(
  thread: { id: string; cwd: string; originator?: unknown },
  projects: readonly CodexProject[],
  state: CodexAppState
): { projectRoot?: string; projectName?: string } | undefined {
  if (thread.originator === OWN_ORIGINATOR) return undefined;
  const assignedId = state.assignments.get(thread.id);
  const assigned = assignedId !== undefined ? assignedProject(assignedId, projects, state) : undefined;
  if (assigned) return { projectRoot: containingRoot(thread.cwd, assigned.roots) ?? assigned.roots[0], ...named(assigned) };
  if (state.projectless.has(thread.id)) return {};
  const projectRoot = containingRoot(thread.cwd, projects.flatMap((project) => project.roots));
  const owner = projectRoot ? projects.find((project) => project.roots.includes(projectRoot)) : undefined;
  if (projectRoot) return { projectRoot, ...(owner ? named(owner) : {}) };
  return state.pinned.has(thread.id) ? {} : undefined;
}

function assignedProject(projectId: string, projects: readonly CodexProject[], state: CodexAppState): CodexProject | undefined {
  const id = state.migratedProjectIds.get(projectId) ?? projectId;
  const localRoots = state.localProjectRoots.get(projectId) ?? [];
  return projects.find((project) => project.id === id)
    ?? projects.find((project) => project.roots.some((root) => localRoots.includes(root)));
}

/** The deepest of the roots that holds the folder. */
function containingRoot(folder: string, roots: readonly string[]): string | undefined {
  let found: string | undefined;
  for (const root of roots) {
    const relative = path.relative(root, folder);
    const inside = relative === "" || (relative.split(path.sep)[0] !== ".." && !path.isAbsolute(relative));
    if (folder && inside && (!found || root.length > found.length)) found = root;
  }
  return found;
}

function named(project: CodexProject): { projectName?: string } {
  return project.name ? { projectName: project.name } : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

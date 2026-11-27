import path from "node:path";
import { runCommand } from "../command";
import { claudeProjectFolderName } from "../memberSessionFiles";

/** One of the User's projects as this device has it: her path for it (as
 *  her chats name it) and the folder it is in here (the same on the
 *  computer; the machine's copy on a cloud machine). */
export interface DeviceProject {
  projectPath: string;
  localPath: string;
}

/** How long a folder's git repository is remembered. */
const ROOT_REMEMBERED_MS = 60 * 60_000;

/** The folder of the git repository a folder is in (its main checkout for a
 *  worktree), as Claude Code names its memory after it; undefined outside one. */
export async function gitRepositoryRoot(dir: string): Promise<string | undefined> {
  const result = await runCommand("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"], { timeoutMs: 5_000 }).catch(() => undefined);
  const common = result?.exitCode === 0 ? result.stdout.trim() : "";
  return common && path.basename(common) === ".git" ? path.dirname(common) : undefined;
}

/** Which of the User's projects a CLI's memory belongs to. */
export class ProjectFolders {
  private readonly roots = new Map<string, { root?: string; at: number }>();

  constructor(
    private readonly repositoryRoot: (dir: string) => Promise<string | undefined> = gitRepositoryRoot,
    private readonly now: () => number = Date.now
  ) {}

  /** Claude Code's memory folder names, each with the project it belongs to:
   *  a project's own folder first, then the repository it is in (a
   *  worktree's memory is its repository's). */
  async claudeFolders(projects: readonly DeviceProject[]): Promise<Map<string, string>> {
    const folders = new Map<string, string>();
    for (const project of projects) {
      const name = claudeProjectFolderName(project.localPath);
      if (name && !folders.has(name)) folders.set(name, project.projectPath);
    }
    for (const project of projects) {
      const root = await this.root(project.localPath);
      const name = root ? claudeProjectFolderName(root) : undefined;
      if (name && !folders.has(name)) folders.set(name, project.projectPath);
    }
    return folders;
  }

  /** The project a folder is in (the deepest one holding it). */
  projectFor(projects: readonly DeviceProject[], dir: string): string | undefined {
    const wanted = path.resolve(dir);
    let best: DeviceProject | undefined;
    for (const project of projects) {
      const local = path.resolve(project.localPath);
      if ((wanted === local || wanted.startsWith(`${local}${path.sep}`)) && (!best || local.length > path.resolve(best.localPath).length)) best = project;
    }
    return best?.projectPath;
  }

  private async root(dir: string): Promise<string | undefined> {
    const known = this.roots.get(dir);
    if (known && this.now() - known.at < ROOT_REMEMBERED_MS) return known.root;
    const root = await this.repositoryRoot(dir).catch(() => undefined);
    this.roots.set(dir, { root, at: this.now() });
    return root;
  }
}

/** The projects of the chats this device keeps, each as its chats name it
 *  (the scope members' project notes are kept under). */
export function projectsOfChats(repoPaths: readonly string[]): DeviceProject[] {
  const seen = new Set<string>();
  const projects: DeviceProject[] = [];
  for (const repoPath of repoPaths) {
    if (typeof repoPath !== "string" || !repoPath.trim() || seen.has(repoPath)) continue;
    seen.add(repoPath);
    projects.push({ projectPath: repoPath, localPath: repoPath.trim().replace(/[\\/]+$/g, "") || repoPath.trim() });
  }
  return projects;
}

/** A cloud machine's projects: the copies the computer published for it
 *  (her path → the copy here), and the chats here whose project is not a
 *  copy (the computer's own path, where the machine has the same folder). */
export function projectsOfMachine(published: Record<string, string>, repoPaths: readonly string[]): DeviceProject[] {
  const projects: DeviceProject[] = Object.entries(published)
    .filter(([projectPath, localPath]) => projectPath.trim() && localPath.trim())
    .map(([projectPath, localPath]) => ({ projectPath, localPath }));
  const copies = new Set(Object.values(published));
  for (const project of projectsOfChats(repoPaths)) {
    if (!copies.has(project.projectPath) && !projects.some((known) => known.projectPath === project.projectPath)) projects.push(project);
  }
  return projects;
}

import path from "node:path";
import type { MachineInstallRecord } from "../../shared/machineInstall";
import type { AwsDiskListing, AwsInstanceProject, AwsInstanceProjectProgress, AwsInstanceProjects } from "../../shared/types";

export const AWS_PROJECTS_NOT_SET_UP = "Projects can be added once the cloud program is set up on the instance.";
export const AWS_PROJECT_ADD_CANCELLED = "The copy was cancelled.";

export class AwsProjectAddCancelled extends Error {
  constructor() { super(AWS_PROJECT_ADD_CANCELLED); }
}

export interface AwsInstanceProjectsOptions {
  /** This computer's cloud program on the configured instance. */
  record(): Promise<MachineInstallRecord | undefined>;
  /** The instance's project copies folder, read on the instance. */
  listCopies(): Promise<AwsDiskListing>;
  /** This computer's projects, newest first (the New chat list). */
  knownProjects(): Promise<Array<{ path: string; label: string }>>;
  /** Copies a project to the machine and records where it is. */
  copy(machineId: string, localPath: string, signal: AbortSignal, progress: (message: string) => void): Promise<void>;
  /** Forgets recorded copies the instance no longer has. */
  forget(machineId: string, localPaths: string[]): Promise<void>;
  progress(progress: AwsInstanceProjectProgress): void;
}

/**
 * Settings → AWS → Projects: the one place where the User sees, adds and
 * deletes the project copies on her instance. Deleting goes through the
 * disk tools (the instance decides what may go), adding through the same
 * copy a cloud member's first turn in a project makes.
 */
export class AwsInstanceProjectsService {
  private readonly copying = new Map<string, AbortController>();

  constructor(private readonly options: AwsInstanceProjectsOptions) {}

  async list(): Promise<AwsInstanceProjects> {
    const [record, listing, known] = await Promise.all([this.options.record(), this.options.listCopies(), this.options.knownProjects()]);
    const recorded = Object.entries(record?.projects ?? {});
    const folders = listing.entries.filter((entry) => entry.dir);
    // A recorded copy the instance does not have any more (deleted another
    // way, or before deletes were followed) is forgotten, so the next turn in
    // its project copies it again. Only when the whole folder was listed.
    if (record && !listing.truncated) {
      const missing = recorded.filter(([, remotePath]) => remotePath.startsWith(`${listing.path}/`)
        && !folders.some((entry) => remotePath === entry.path || remotePath.startsWith(`${entry.path}/`))).map(([localPath]) => localPath);
      if (missing.length) await this.options.forget(record.machineId, missing);
    }
    const copies: AwsInstanceProject[] = folders.map((entry) => {
      const localPath = recorded.find(([, remotePath]) => remotePath === entry.path || remotePath.startsWith(`${entry.path}/`))?.[0];
      return {
        path: entry.path,
        name: localPath ? path.basename(localPath) : entry.name.replace(/-[0-9a-f]{10}$/, ""),
        ...(localPath ? { localPath } : {}),
        bytes: entry.bytes,
        lock: entry.lock,
        ...(entry.work?.length ? { work: entry.work } : {})
      };
    });
    // A project recorded as copied whose copy is not there any more is
    // offered again: adding it copies it.
    const onInstance = new Set(copies.flatMap((copy) => copy.localPath ? [copy.localPath] : []));
    const available = known.filter((project) => !onInstance.has(project.path));
    return {
      copies,
      available,
      ...(record?.installRoot ? {} : { addUnavailable: AWS_PROJECTS_NOT_SET_UP }),
      ...(listing.space ? { freeBytes: listing.space.availableBytes } : {})
    };
  }

  async add(localPath: string): Promise<void> {
    if (typeof localPath !== "string" || !path.isAbsolute(localPath)) throw new Error("Choose a project to add.");
    if (this.copying.has(localPath)) throw new Error("This project is being copied already.");
    // Taken before anything is awaited, so a Cancel or a second Add right
    // away finds it.
    const controller = new AbortController();
    this.copying.set(localPath, controller);
    try {
      // Only this computer's projects go to the instance, never any folder.
      if (!(await this.options.knownProjects()).some((project) => project.path === localPath)) throw new Error("Choose one of your projects to add.");
      const record = await this.options.record();
      if (!record?.installRoot) throw new Error(AWS_PROJECTS_NOT_SET_UP);
      controller.signal.throwIfAborted();
      await this.options.copy(record.machineId, localPath, controller.signal, (message) => this.options.progress({ localPath, message }));
    } catch (error) {
      if (controller.signal.aborted) throw new AwsProjectAddCancelled();
      throw error;
    } finally {
      if (this.copying.get(localPath) === controller) this.copying.delete(localPath);
    }
  }

  cancel(localPath: string): void {
    this.copying.get(localPath)?.abort(new Error("cancelled"));
  }
}

import type {
  AwsDiskChangeResult,
  AwsDiskCleanCategory,
  AwsDiskListing,
  AwsDiskReport,
  CloudRunWorkerSettings
} from "../../shared/types";
import { awsInstanceDiskScript, type AwsInstanceDiskRequest } from "./awsInstanceDiskScript";
import { buildCloudRunSshTarget, cloudRunSshOptionArgs, cloudRunWorkerTargetFromSettings } from "./cloudRunWorkers";
import { CommandError, commandFailureDetail, runCommand } from "./command";
import { isTransientSshError, runWithSshRetries } from "./sshRetry";

const READ_TIMEOUT_MS = 4 * 60_000;
const REUSE_MS = 10 * 60_000;
const CHANGE_TIMEOUT_MS = 5 * 60_000;
/** The instance stops its own work this long before the desktop gives up,
 *  so a pass that runs too long never keeps walking the disk unseen. */
const REMOTE_MARGIN_MS = 15_000;
const MAX_DELETE_PATHS = 500;
const CLEAN_CATEGORIES: readonly AwsDiskCleanCategory[] = ["program-logs", "caches", "program-versions", "system-logs"];

export type AwsInstanceDiskExec = (worker: CloudRunWorkerSettings, remoteCommand: string, script: string, timeoutMs: number) => Promise<string>;

/** This desktop's program folder and data folder on the instance. */
export interface AwsInstanceProgramFolders {
  root: string;
  data: string;
}

export interface AwsInstanceDiskOptions {
  /** The running instance to talk to; must never start or wake it. */
  worker: () => Promise<CloudRunWorkerSettings>;
  program: () => Promise<AwsInstanceProgramFolders>;
  exec?: AwsInstanceDiskExec;
  log?: (event: string, data: Record<string, unknown>) => void;
}

/** Measures, cleans and browses the AWS instance's disk for Settings. Every
 *  rule about what may be removed lives in the script on the instance. One
 *  request reaches the instance at a time: two passes over a small disk at
 *  once only slow each other and the agents working there. */
export class AwsInstanceDiskService {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly exec: AwsInstanceDiskExec;
  /** Changes asked for so far. Requests run in the order they are made, so
   *  a measurement asked for before the latest change measured the disk
   *  before it: it is neither kept nor handed to a caller wanting fresh numbers. */
  private changes = 0;
  /** The last measurement, kept so Settings opens with numbers at once. */
  private last?: { instanceKey: string; report: AwsDiskReport };
  private measuring?: { instanceKey: string; changes: number; promise: Promise<AwsDiskReport> };

  constructor(private readonly options: AwsInstanceDiskOptions) {
    this.exec = options.exec ?? defaultExec;
  }

  /** A measurement newer than REUSE_MS is returned as is unless asked to
   *  measure again; callers share one measurement in flight unless a change
   *  happened after it started. */
  async report(options: { refresh?: boolean } = {}): Promise<AwsDiskReport> {
    const worker = await this.options.worker();
    const instanceKey = worker.hostKeyAlias ?? worker.host ?? "";
    if (!options.refresh && this.last?.instanceKey === instanceKey && Date.now() - this.last.report.measuredAt < REUSE_MS) {
      return this.last.report;
    }
    if (this.measuring?.instanceKey === instanceKey && this.measuring.changes === this.changes) return this.measuring.promise;
    const changes = this.changes;
    const promise = this.serial(() => this.run<AwsDiskReport>(worker, { mode: "report" }, READ_TIMEOUT_MS, true))
      .then((report) => {
        if (changes === this.changes) this.last = { instanceKey, report };
        return report;
      })
      .finally(() => { if (this.measuring?.promise === promise) this.measuring = undefined; });
    this.measuring = { instanceKey, changes, promise };
    return promise;
  }

  /** A folder's entries, largest first; "@runs" and "@mirrors" name the
   *  cloud run files and the project copies. */
  list(path?: string): Promise<AwsDiskListing> {
    if (path !== undefined && (typeof path !== "string" || path.includes("\0"))) throw new Error("Choose a folder on the instance.");
    return this.serial(async () => this.run<AwsDiskListing>(await this.options.worker(), { mode: "list", arg: path ?? "" }, READ_TIMEOUT_MS, true));
  }

  clean(category: AwsDiskCleanCategory): Promise<AwsDiskChangeResult> {
    if (!CLEAN_CATEGORIES.includes(category)) throw new Error("Nothing to clean up there.");
    return this.change({ mode: "clean", arg: category }, (result) => this.options.log?.("aws.disk.clean", {
      category, freedBytes: result.freedBytes, failed: result.failed.length
    }));
  }

  remove(paths: string[]): Promise<AwsDiskChangeResult> {
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_DELETE_PATHS
      || paths.some((path) => typeof path !== "string" || !path.startsWith("/") || path.includes("\0"))) {
      throw new Error("Choose the files to delete again.");
    }
    return this.change({ mode: "delete", arg: paths }, (result) => this.options.log?.("aws.disk.delete", {
      requested: paths.length, removed: result.removed ?? 0, freedBytes: result.freedBytes, failed: result.failed.length
    }));
  }

  private change(request: Omit<AwsInstanceDiskRequest, "root" | "data">, logged: (result: AwsDiskChangeResult) => void): Promise<AwsDiskChangeResult> {
    this.changes += 1;
    this.last = undefined;
    return this.serial(async () => {
      const result = await this.run<AwsDiskChangeResult>(await this.options.worker(), request, CHANGE_TIMEOUT_MS, false);
      logged(result);
      return result;
    });
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async run<T>(worker: CloudRunWorkerSettings, request: Omit<AwsInstanceDiskRequest, "root" | "data">, timeoutMs: number, retry: boolean): Promise<T> {
    const program = await this.options.program();
    const script = awsInstanceDiskScript({ ...request, root: program.root, data: program.data });
    const remoteSeconds = Math.max(1, Math.floor((timeoutMs - REMOTE_MARGIN_MS) / 1000));
    // GNU timeout stops python3 and every du or git it started.
    const remoteCommand = `command -v timeout >/dev/null 2>&1 && exec timeout -k 10 ${remoteSeconds} python3 - || exec python3 -`;
    const call = (): Promise<string> => this.exec(worker, remoteCommand, script, timeoutMs);
    let stdout: string;
    try {
      // Only a connection that failed to open is tried again: a pass that ran
      // out of time would only run out of time again, on top of itself.
      stdout = retry ? await runWithSshRetries(call, { attempts: 3, isTransient: connectionFailure }) : await call();
    } catch (error) {
      throw new Error(diskCommandError(error));
    }
    const parsed = parseLastJson(stdout) as ({ ok?: boolean; error?: string } & T) | undefined;
    if (!parsed) throw new Error("The instance did not answer with its disk details. Try again.");
    if (parsed.ok === false) throw new Error(parsed.error ? `The instance refused: ${parsed.error}.` : "The instance refused the request.");
    return parsed;
  }
}

function connectionFailure(error: unknown): boolean {
  return !(error instanceof CommandError && (error.result.timedOut || error.result.exitCode === 124)) && isTransientSshError(error);
}

function parseLastJson(stdout: string): unknown {
  const lines = stdout.trim().split("\n").reverse();
  for (const line of lines) {
    const text = line.trim();
    if (!text.startsWith("{")) continue;
    try { return JSON.parse(text); } catch { /* keep looking */ }
  }
  return undefined;
}

export function diskCommandError(error: unknown): string {
  if (error instanceof CommandError) {
    if (error.result.timedOut || error.result.exitCode === 124) return "The instance took too long to answer. Try again.";
    const detail = commandFailureDetail(error);
    return detail ? `The instance could not run the disk check: ${detail}` : "The instance could not run the disk check.";
  }
  return error instanceof Error ? error.message : String(error);
}

const defaultExec: AwsInstanceDiskExec = async (settings, remoteCommand, script, timeoutMs) => {
  const worker = cloudRunWorkerTargetFromSettings(settings);
  if (!worker) throw new Error("The AWS instance did not provide an address to connect to.");
  const result = await runCommand("ssh", [...cloudRunSshOptionArgs(worker), buildCloudRunSshTarget(worker), remoteCommand], {
    input: script,
    timeoutMs
  });
  return result.stdout;
};

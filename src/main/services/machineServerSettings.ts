import type { HubMachineSettings } from "../../shared/hubOps";
import type { MachineSettingsDocument } from "../../shared/machineLink";

/** How often a machine reads its settings from the User's server without
 *  being told they changed (a word on the live socket can be missed). */
export const MACHINE_SETTINGS_RECHECK_MS = 5 * 60_000;

/**
 * A machine's settings, as the computer that set it up published them on the
 * User's server, sealed for this machine alone (the server never opens them).
 * Read at start, when the server says they changed, every few minutes, and
 * before a turn the server asks of a member here, so a member runs with what
 * the User set as a local member would. Each read asks only for what is newer
 * than what this machine applied.
 */
export class MachineServerSettings {
  private appliedAt?: string;
  private queue: Promise<boolean> = Promise.resolve(false);
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly options: {
    read: (since?: string) => Promise<HubMachineSettings>;
    open: (sealed: string) => Promise<MachineSettingsDocument>;
    /** Applies the whole document (settings, then where projects live). */
    apply: (document: MachineSettingsDocument) => Promise<void>;
    /** Runtime knobs read again from what was imported. */
    onImported?: () => Promise<void> | void;
    log: (event: string, payload: Record<string, unknown>) => void;
    everyMs?: number;
  }) {}

  /** When what this machine runs with was published (undefined: nothing yet). */
  applied(): string | undefined {
    return this.appliedAt;
  }

  /** Reads and applies what is newer; true when something was applied. One
   *  read at a time, each started after the call. A failure is logged and the
   *  machine keeps what it has; the next read tries again. */
  refresh(reason: string): Promise<boolean> {
    const run = this.queue.then(() => this.refreshNow(reason), () => this.refreshNow(reason));
    this.queue = run.catch(() => false);
    return run;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.refresh("recheck").catch(() => undefined); }, this.options.everyMs ?? MACHINE_SETTINGS_RECHECK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async refreshNow(reason: string): Promise<boolean> {
    let answer: HubMachineSettings;
    try {
      answer = await this.options.read(this.appliedAt);
    } catch (error) {
      this.options.log("machine.settings.read-failed", { reason, message: errorText(error) });
      return false;
    }
    if (answer.unchanged || !answer.sealed || !answer.updatedAt) return false;
    if (this.appliedAt && answer.updatedAt <= this.appliedAt) return false;
    try {
      const document = await this.options.open(answer.sealed);
      await this.options.apply(document);
      this.appliedAt = answer.updatedAt;
      this.options.log("machine.settings.applied", { reason, publishedAt: answer.updatedAt, exportedAt: document.settings.exportedAt, projects: Object.keys(document.projects).length });
    } catch (error) {
      // Kept as it was; read again next time (never half-applied: the import
      // validates the whole snapshot before it writes).
      this.options.log("machine.settings.apply-failed", { reason, publishedAt: answer.updatedAt, message: errorText(error) });
      return false;
    }
    await Promise.resolve().then(() => this.options.onImported?.()).catch((error: unknown) => {
      this.options.log("machine.settings.after-import-failed", { message: errorText(error) });
    });
    return true;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

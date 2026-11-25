import { uptime } from "node:os";
import type { ScriptDependencies } from "../dependencies";

/** The host the scripts run on. */
export class ScriptHost {
  /** The name the desktop gave this host, once it has. */
  private hostName: { label: string; phrase: string } | undefined;

  constructor(private readonly deps: Pick<ScriptDependencies, "options">) {}

  /** The host's name as the User knows it. A machine learns the name the
   *  desktop gave it only once the desktop greets it. */
  setHostName(label: string, phrase: string): void {
    if (label === this.hostLabel() && phrase === this.hostPhrase()) return;
    this.hostName = { label, phrase };
    this.changed();
  }

  hostLabel(): string {
    return this.hostName ? this.hostName.label : this.deps.options.hostLabel;
  }

  hostPhrase(): string {
    return this.hostName ? this.hostName.phrase : this.deps.options.hostPhrase;
  }

  log(event: string, payload: Record<string, unknown>): void {
    try {
      this.deps.options.debugLog?.(event, payload);
    } catch {
      // Debug logging never breaks a run.
    }
  }

  changed(): void {
    try {
      this.deps.options.onChanged?.();
    } catch {
      // A listener failure must not break the script that changed.
    }
  }

  bootAt(): number {
    return this.deps.options.bootAt?.() ?? Date.now() - uptime() * 1000;
  }
}

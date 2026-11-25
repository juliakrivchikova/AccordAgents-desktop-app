import type { SettingsUsageEvent } from "./memberUsageEvent";

/** Reports a changed member preset to whoever counts usage. */
export class MemberUsage {
  /** Told what a save did, on the computer only (a machine's runtime sets
   *  none): the usage signals. */
  private usageObserver?: (event: SettingsUsageEvent) => void;

  setUsageObserver(observer: ((event: SettingsUsageEvent) => void) | undefined): void {
    this.usageObserver = observer;
  }

  notifyUsage(event: SettingsUsageEvent): void {
    try {
      this.usageObserver?.(event);
    } catch {
      // An observer never changes what a save does.
    }
  }
}

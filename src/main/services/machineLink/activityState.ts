export interface MachineActivity {
  machineId: string;
  connected: boolean;
  /** True when the machine answered the request; false when this is its
   *  last known hello, which may predate turns that started or ended since.
   *  A decision that would stop the runtime must not act on a stale answer. */
  fresh: boolean;
  /** Runtime version the machine reports. */
  appVersion?: string;
  /** Runs executing on the machine, as it says. A turn asked of it that it
   *  has not taken waits on the User's server and does not count: the
   *  runtime that is there when it is taken runs it. */
  activeRunIds: string[];
}

export function machineActivityIsBusy(activity: MachineActivity): boolean {
  return activity.activeRunIds.length > 0;
}

/** What a member's work says while its machine cannot take it yet, on a
 *  turn's bubble and on a compaction's status line alike. */
export function machineWaitingText(machineName: string, reason?: string): string {
  return `Waiting for machine ${machineName}${reason ? `: ${reason}` : ""}`;
}

/** What it says once Stop was pressed and the machine has not confirmed it
 *  (Rule 2, docs/parity-requirements.md). */
export function machineStopPendingText(machineName: string): string {
  return `Stop requested — waiting for machine ${machineName}`;
}

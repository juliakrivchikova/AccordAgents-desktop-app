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

/** What a card of a member on a machine says once it was answered (here or
 *  on another device) and the machine has not applied the answer yet. */
export function machineAnswerPendingText(machineName: string): string {
  return `Answer saved. Waiting for machine ${machineName} to confirm it.`;
}

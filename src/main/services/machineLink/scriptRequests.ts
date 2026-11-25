import type { MachineConnection } from "./types";

export function rejectPendingScripts(connection: MachineConnection, reason: string): void {
  for (const pending of connection.pendingScripts.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error(reason));
  }
  connection.pendingScripts.clear();
}

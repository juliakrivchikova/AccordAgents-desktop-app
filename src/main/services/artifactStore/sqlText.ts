// SQLite persistence for artifacts. Deliberately independent from conversation
// payload storage: artifacts must survive chat compaction, agent session loss,
// and app restarts, and are append-only at the version level. Uses the same
// sqlite3-CLI approach as StorageService (no native binding), but takes an
// explicit dbPath so it can run under plain `node --test` without Electron.
//
// The User's server owns every document (agreements Д1, Д9): there this store
// is the documents themselves, decided by ArtifactService; on the computer and
// on every machine it is a copy the server's feed keeps current
// (`applyServerStates`), never written by a device's own rules.

export const SQLITE_BUSY_TIMEOUT_MS = 30_000;

export const SQLITE_COMMAND_TIMEOUT_MS = 45_000;

export function sqlString(value: string | undefined | null): string {
  if (value === undefined || value === null) {
    return "NULL";
  }
  return `'${value.replace(/'/g, "''")}'`;
}

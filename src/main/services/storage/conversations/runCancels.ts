import { sqlString, sqlStringList } from "../database/sqlText";
import type { StorageModules } from "../modules";

const RUN_CANCEL_REQUEST_MAX_AGE_MS = 60 * 60_000;

/** Stop requests one app instance leaves for another. */
export class RunCancels {
  constructor(private readonly storage: Pick<StorageModules, "schema" | "sqlite">) {}

  // Cross-instance run cancellation. Multiple app instances can share this
  // database (a second dev/QA instance opens the same userData); a Stop click
  // in a non-owner instance cannot abort the owner's in-memory controllers, so
  // it records a request row here and the owning instance consumes it on its
  // run-owner heartbeat.
  async requestRunCancel(conversationId: string, runId: string): Promise<void> {
    await this.storage.schema.init();
    const normalizedRunId = runId.trim();
    if (!normalizedRunId) {
      return;
    }
    await this.storage.sqlite.runSql(`
      insert into run_cancel_requests (run_id, conversation_id, requested_at)
      values (${sqlString(normalizedRunId)}, ${sqlString(conversationId)}, ${sqlString(new Date().toISOString())})
      on conflict(run_id) do update set requested_at = excluded.requested_at;
    `);
  }

  async takeRunCancelRequests(runIds: string[]): Promise<string[]> {
    await this.storage.schema.init();
    const normalized = Array.from(new Set(runIds.map((runId) => runId.trim()).filter(Boolean)));
    if (normalized.length === 0) {
      return [];
    }
    const rows = await this.storage.sqlite.queryJson<{ runId: string }>(
      `select run_id as runId from run_cancel_requests where run_id in ${sqlStringList(normalized)};`
    );
    const matched = rows.map((row) => row.runId);
    if (matched.length > 0) {
      await this.storage.sqlite.runSql(`delete from run_cancel_requests where run_id in ${sqlStringList(matched)};`);
    }
    return matched;
  }

  async pruneStaleRunCancelRequests(): Promise<void> {
    const cutoff = new Date(Date.now() - RUN_CANCEL_REQUEST_MAX_AGE_MS).toISOString();
    await this.storage.sqlite.runSql(`delete from run_cancel_requests where requested_at < ${sqlString(cutoff)};`);
  }
}

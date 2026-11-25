import type { ArtifactEventRow } from "./artifactRows";
import { sqlString } from "./sqlText";
import type { ArtifactEventRecord, ArtifactOperationRecord } from "./types";
import type { ArtifactStoreModules } from "./modules";

/** Which requests were already carried out, and the events they still have to tell. */
export class ArtifactOperations {
  private readonly mutationQueues = new Map<string, Promise<unknown>>();

  constructor(private readonly store: Pick<ArtifactStoreModules, "artifactDatabase">) {}

  /** Local edits and incoming events in this runtime share one queue.
   * Independent runtimes remain guarded by SQLite preconditions. */
  withMutation<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
    const key = conversationId;
    const previous = this.mutationQueues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(fn);
    const tail = next.then(() => undefined, () => undefined);
    this.mutationQueues.set(key, tail);
    return next.finally(() => {
      if (this.mutationQueues.get(key) === tail) this.mutationQueues.delete(key);
    });
  }

  async getOperation(
    conversationId: string,
    actor: string,
    operationKind: string,
    operationId: string
  ): Promise<(ArtifactOperationRecord & { applied: boolean }) | undefined> {
    await this.store.artifactDatabase.init();
    const rows = await this.store.artifactDatabase.queryJson<ArtifactOperationRecord & { applied: number }>(`
      select
        conversation_id as conversationId,
        artifact_id as artifactId,
        actor,
        operation_kind as operationKind,
        operation_id as operationId,
        request_hash as requestHash,
        result_json as resultJson,
        created_at as createdAt,
        applied
      from artifact_operations
      where conversation_id = ${sqlString(conversationId)}
        and actor = ${sqlString(actor)}
        and operation_kind = ${sqlString(operationKind)}
        and operation_id = ${sqlString(operationId)}
      limit 1;
    `);
    const row = rows[0];
    return row ? { ...row, applied: row.applied === 1 } : undefined;
  }

  async listPendingEvents(
    limit = 100,
    after?: Pick<ArtifactEventRecord, "createdAt" | "id">
  ): Promise<ArtifactEventRecord[]> {
    await this.store.artifactDatabase.init();
    const rows = await this.store.artifactDatabase.queryJson<ArtifactEventRow>(`
      select
        id,
        conversation_id as conversationId,
        artifact_id as artifactId,
        kind,
        actor,
        content,
        created_at as createdAt,
        delivered_at as deliveredAt
      from artifact_event_outbox
      where delivered_at is null
        ${after ? `and (
          created_at > ${sqlString(after.createdAt)}
          or (created_at = ${sqlString(after.createdAt)} and id > ${sqlString(after.id)})
        )` : ""}
      order by created_at asc, id asc
      limit ${Math.max(1, Math.floor(limit))};
    `);
    return rows.map((row) => ({ ...row, deliveredAt: row.deliveredAt ?? undefined }));
  }

  async markEventDelivered(id: string, deliveredAt: string): Promise<void> {
    await this.store.artifactDatabase.init();
    await this.store.artifactDatabase.runSql(`
      update artifact_event_outbox
      set delivered_at = coalesce(delivered_at, ${sqlString(deliveredAt)})
      where id = ${sqlString(id)};
    `);
  }
}

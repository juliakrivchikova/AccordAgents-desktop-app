import type { StorageService } from "../../main/services/storage";
import type { ChatMessage } from "../../shared/types";
import { messageOf, quote } from "./alertText";
import { OPEN_STATES } from "./constants";
import type { AlertRecord } from "./types";
import type { HubAlertModules } from "./modules";
import type { HubAlertDependencies } from "./dependencies";

const SCHEMA_SQL = `
create table if not exists urgent_alerts (
  id text primary key,
  request_key text not null unique,
  conversation_id text not null,
  state text not null,
  record_json text not null,
  created_at text not null,
  updated_at text not null
);
create index if not exists urgent_alerts_state on urgent_alerts(state);
`;

/** The alerts the server keeps. */
export class AlertRecords {
  private ready?: Promise<void>;
  queue: Promise<unknown> = Promise.resolve();
  readonly cardRetries = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly alerts: Pick<HubAlertModules, "alertFlow">,
    private readonly deps: Pick<HubAlertDependencies, "log" | "now" | "options">
  ) {}

  init(): Promise<void> {
    this.ready ??= this.storage().runSql(SCHEMA_SQL).catch((error: unknown) => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }

  storage(): ReturnType<StorageService["sqlExecutor"]> {
    return this.deps.options.storage.sqlExecutor();
  }

  serialize<T>(work: () => Promise<T>): Promise<T> {
    // Nothing new starts once closing: the storage is going away.
    const run = this.queue.then(() => this.alerts.alertFlow.closed ? Promise.reject(new Error("Urgent alerts are closing.")) : work());
    this.queue = run.catch(() => undefined);
    return run;
  }

  // --- records and the card -----------------------------------------------------

  async record(alertId: string): Promise<AlertRecord | undefined> {
    const rows = await this.storage().queryJson<{ record: string }>(`select record_json as record from urgent_alerts where id = ${quote(alertId)};`);
    return rows[0] ? JSON.parse(rows[0].record) as AlertRecord : undefined;
  }

  async recordByRequestKey(requestKey: string): Promise<AlertRecord | undefined> {
    const rows = await this.storage().queryJson<{ record: string }>(`select record_json as record from urgent_alerts where request_key = ${quote(requestKey)};`);
    return rows[0] ? JSON.parse(rows[0].record) as AlertRecord : undefined;
  }

  async openRecords(): Promise<AlertRecord[]> {
    const rows = await this.storage().queryJson<{ record: string }>(
      `select record_json as record from urgent_alerts where state in (${OPEN_STATES.map(quote).join(", ")}) order by created_at;`);
    return rows.map((row) => JSON.parse(row.record) as AlertRecord);
  }

  async save(record: AlertRecord): Promise<void> {
    await this.storage().runSql(`update urgent_alerts set state = ${quote(record.view.state)}, record_json = ${quote(JSON.stringify(record))},
      updated_at = ${quote(this.deps.now().toISOString())} where id = ${quote(record.view.id)};`);
  }

  /** The alert's card in its chat, as the server writes it. `strict`: a
   *  refusal fails (raising an alert in a chat the server cannot write to). */
  async writeCard(record: AlertRecord, options: { strict?: boolean } = {}): Promise<void> {
    const message: ChatMessage = {
      id: record.messageId,
      role: "participant",
      participantId: record.participantId,
      participantLabel: record.requester,
      content: record.text,
      createdAt: record.view.createdAt,
      status: "done",
      metadata: { urgentAlert: record.view }
    };
    let outcome: { seq: number } | { refused: string };
    try {
      outcome = await this.deps.options.ops.writeServerMessage(record.conversationId, message);
    } catch (error) {
      if (options.strict) throw error;
      // The alert goes on (its calls, Telegram); the card catches up shortly.
      this.deps.log("hub.alert.card.write-failed", { alertId: record.view.id, message: messageOf(error) });
      this.retryCard(record.view.id);
      return;
    }
    if ("refused" in outcome) {
      this.deps.log("hub.alert.card.refused", { alertId: record.view.id, reason: outcome.refused });
      if (options.strict) throw new Error(outcome.refused);
    }
  }

  /** Writes the card again from the record as it then stands. */
  private retryCard(alertId: string, attempt = 1): void {
    if (this.alerts.alertFlow.closed || this.cardRetries.has(alertId) || attempt > 6) return;
    const timer = setTimeout(() => {
      this.cardRetries.delete(alertId);
      void this.serialize(async () => {
        const record = await this.record(alertId);
        if (!record) return;
        await this.deps.options.ops.writeServerMessage(record.conversationId, {
          id: record.messageId, role: "participant", participantId: record.participantId, participantLabel: record.requester,
          content: record.text, createdAt: record.view.createdAt, status: "done", metadata: { urgentAlert: record.view }
        });
      }).catch((error: unknown) => {
        this.deps.log("hub.alert.card.write-failed", { alertId, attempt, message: messageOf(error) });
        this.retryCard(alertId, attempt + 1);
      });
    }, 5_000 * attempt);
    timer.unref?.();
    this.cardRetries.set(alertId, timer);
  }
}

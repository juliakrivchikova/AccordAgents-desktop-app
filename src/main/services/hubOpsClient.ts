import { HubHttpError, type HubClient } from "./hubClient";
import { HUB_FEED_WAIT_MAX_MS, HUB_OPS_MAX_PER_REQUEST, type HubClaimOutcome, type HubFeedEntry, type HubOp, type HubTurn } from "../../shared/hubOps";

/**
 * A device's side of the chats the User's server owns (agreements Д1, Д3):
 * the operations it wrote and has not had answered yet, every failed attempt
 * with its reason (Д12), and where it read the server's feed. Kept in the
 * device's own database, on the computer and on every machine.
 */
export const HUB_CLIENT_OPS_SCHEMA_SQL = `
  create table if not exists hub_client_ops (
    op_id text primary key,
    conversation_id text not null,
    kind text not null,
    -- The message a message.create writes, so a turn can wait for it.
    message_id text,
    op_json text not null,
    status text not null check(status in ('queued', 'accepted', 'rejected')),
    attempts integer not null default 0,
    last_error text,
    seq integer,
    result_json text,
    created_at text not null,
    updated_at text not null
  );
  create index if not exists hub_client_ops_queued on hub_client_ops(status);
  create index if not exists hub_client_ops_message on hub_client_ops(conversation_id, message_id);
  create table if not exists hub_client_op_failures (
    id integer primary key autoincrement,
    op_id text not null,
    conversation_id text not null,
    kind text not null,
    at text not null,
    reason text not null
  );
`;

interface Database {
  init(): Promise<void>;
  query<T>(sql: string): Promise<T[]>;
  execute(sql: string): Promise<void>;
}

export interface HubClientOpRow {
  opId: string;
  conversationId: string;
  kind: string;
  messageId?: string;
  op: HubOp;
  status: "queued" | "accepted" | "rejected";
  attempts: number;
  lastError?: string;
  seq?: number;
  claim?: HubClaimOutcome;
  turn?: HubTurn;
  createdAt: string;
}

export interface HubClientOpFailure {
  opId: string;
  conversationId: string;
  kind: string;
  at: string;
  reason: string;
}

/** One request carries about this much at most (the server takes 16 MB). */
const FLUSH_MAX_BYTES = 12 * 1024 * 1024;
/** Answered operations are kept this long (what was sent, for the log). */
const ANSWERED_KEEP_MS = 7 * 24 * 60 * 60_000;
/** Failed attempts kept, newest. */
const FAILURES_KEPT = 1_000;

export class HubClientOpsStore {
  private ready?: Promise<void>;

  constructor(private readonly database: Database) {}

  private async init(): Promise<void> {
    this.ready ??= (async () => {
      await this.database.init();
      await this.database.execute(HUB_CLIENT_OPS_SCHEMA_SQL);
    })();
    try {
      await this.ready;
    } catch (error) {
      this.ready = undefined;
      throw error;
    }
  }

  /** The statements that queue operations, to commit with the local save
   *  that made them (or alone). Known ids are not queued twice. */
  insertSql(ops: HubOp[], at: string, condition?: string): string {
    return ops.map((op) => {
      const messageId = op.kind === "message.create" ? op.message.id : undefined;
      return `insert into hub_client_ops(op_id, conversation_id, kind, message_id, op_json, status, created_at, updated_at)
        select ${quote(op.opId)}, ${quote(op.conversationId)}, ${quote(op.kind)}, ${messageId ? quote(messageId) : "null"},
          ${quote(JSON.stringify(op))}, 'queued', ${quote(at)}, ${quote(at)}
        ${condition ? `where ${condition}` : ""}
        on conflict(op_id) do nothing;`;
    }).join("\n");
  }

  async enqueue(ops: HubOp[], at: string): Promise<void> {
    if (ops.length === 0) return;
    await this.init();
    await this.database.execute(`begin immediate; ${this.insertSql(ops, at)} commit;`);
  }

  /** Waiting operations in the order they were written. */
  async queued(limit: number, maxBytes: number): Promise<HubClientOpRow[]> {
    await this.init();
    const rows = await this.database.query<RawRow & { size: number }>(`select ${COLUMNS}, length(op_json) as size from hub_client_ops
      where status = 'queued' order by rowid limit ${Math.max(1, Math.floor(limit))};`);
    const picked: HubClientOpRow[] = [];
    let bytes = 0;
    for (const row of rows) {
      if (picked.length > 0 && bytes + Number(row.size) > maxBytes) break;
      bytes += Number(row.size);
      picked.push(fromRow(row));
    }
    return picked;
  }

  async count(status: "queued" | "rejected"): Promise<number> {
    await this.init();
    const rows = await this.database.query<{ count: number }>(`select count(*) as count from hub_client_ops where status = ${quote(status)};`);
    return Number(rows[0]?.count ?? 0);
  }

  async get(opId: string): Promise<HubClientOpRow | undefined> {
    await this.init();
    const rows = await this.database.query<RawRow>(`select ${COLUMNS} from hub_client_ops where op_id = ${quote(opId)};`);
    return rows[0] ? fromRow(rows[0]) : undefined;
  }

  /** Every operation of a chat that is not answered yet, oldest first. */
  async forConversation(conversationId: string): Promise<HubClientOpRow[]> {
    await this.init();
    const rows = await this.database.query<RawRow>(`select ${COLUMNS} from hub_client_ops
      where conversation_id = ${quote(conversationId)} and status = 'queued' order by rowid;`);
    return rows.map(fromRow);
  }

  /** The newest operation that writes this message. */
  async forMessage(conversationId: string, messageId: string): Promise<HubClientOpRow | undefined> {
    await this.init();
    const rows = await this.database.query<RawRow>(`select ${COLUMNS} from hub_client_ops
      where conversation_id = ${quote(conversationId)} and message_id = ${quote(messageId)} order by rowid desc limit 1;`);
    return rows[0] ? fromRow(rows[0]) : undefined;
  }

  async accept(opId: string, seq: number, at: string, extra: { claim?: HubClaimOutcome; turn?: HubTurn } = {}): Promise<void> {
    await this.init();
    await this.database.execute(`update hub_client_ops set status = 'accepted', seq = ${Math.max(0, Math.floor(seq))}, last_error = null,
      result_json = ${Object.keys(extra).length ? quote(JSON.stringify(extra)) : "null"}, updated_at = ${quote(at)}
      where op_id = ${quote(opId)};`);
  }

  async reject(row: HubClientOpRow, reason: string, at: string): Promise<void> {
    await this.init();
    await this.database.execute(`begin immediate;
      update hub_client_ops set status = 'rejected', last_error = ${quote(reason)}, updated_at = ${quote(at)} where op_id = ${quote(row.opId)};
      ${this.failureSql(row, reason, at)}
      commit;`);
  }

  /** A whole request failed (no answer, or the server refused the request):
   *  every operation in it is tried again, and each attempt is recorded. */
  async failed(rows: HubClientOpRow[], reason: string, at: string): Promise<void> {
    if (rows.length === 0) return;
    await this.init();
    await this.database.execute(`begin immediate;
      update hub_client_ops set attempts = attempts + 1, last_error = ${quote(reason)}, updated_at = ${quote(at)}
        where op_id in (${rows.map((row) => quote(row.opId)).join(", ")});
      ${rows.map((row) => this.failureSql(row, reason, at)).join("\n")}
      commit;`);
  }

  async failures(limit = 200): Promise<HubClientOpFailure[]> {
    await this.init();
    return this.database.query<HubClientOpFailure>(`select op_id as opId, conversation_id as conversationId, kind, at, reason
      from hub_client_op_failures order by id desc limit ${Math.max(1, Math.floor(limit))};`);
  }

  /** Answered operations past their keep, and the oldest failures. */
  async prune(now: number): Promise<void> {
    await this.init();
    const before = new Date(now - ANSWERED_KEEP_MS).toISOString();
    await this.database.execute(`begin immediate;
      delete from hub_client_ops where status != 'queued' and updated_at < ${quote(before)};
      delete from hub_client_op_failures where id <= (select coalesce(max(id), 0) - ${FAILURES_KEPT} from hub_client_op_failures);
      commit;`);
  }

  private failureSql(row: HubClientOpRow, reason: string, at: string): string {
    return `insert into hub_client_op_failures(op_id, conversation_id, kind, at, reason)
      values (${quote(row.opId)}, ${quote(row.conversationId)}, ${quote(row.kind)}, ${quote(at)}, ${quote(reason.slice(0, 2_000))});`;
  }
}

interface RawRow {
  opId: string;
  conversationId: string;
  kind: string;
  messageId: string | null;
  opJson: string;
  status: HubClientOpRow["status"];
  attempts: number;
  lastError: string | null;
  seq: number | null;
  resultJson: string | null;
  createdAt: string;
}

const COLUMNS = `op_id as opId, conversation_id as conversationId, kind, message_id as messageId, op_json as opJson, status, attempts,
  last_error as lastError, seq, result_json as resultJson, created_at as createdAt`;

function fromRow(row: RawRow): HubClientOpRow {
  return {
    opId: row.opId,
    conversationId: row.conversationId,
    kind: row.kind,
    ...(row.messageId ? { messageId: row.messageId } : {}),
    op: JSON.parse(row.opJson) as HubOp,
    status: row.status,
    attempts: Number(row.attempts) || 0,
    ...(row.lastError ? { lastError: row.lastError } : {}),
    ...(row.seq !== null && row.seq !== undefined ? { seq: Number(row.seq) } : {}),
    ...(row.resultJson ? JSON.parse(row.resultJson) as { claim?: HubClaimOutcome; turn?: HubTurn } : {}),
    createdAt: row.createdAt
  };
}

export type HubOpOutcome =
  | { status: "accepted"; seq: number; claim?: HubClaimOutcome; turn?: HubTurn }
  | { status: "rejected"; reason: string };

/** Where this device read the server's feed. */
export const HUB_FEED_CURSOR_KEY = "ops-cursor";

const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 30_000;

/**
 * Sends a device's operations to the User's server in the order they were
 * written, and reads back everything the server accepted (from any device),
 * in the server's order. "Accepted" is what the device shows as sent (Д3);
 * until then it tries again, every failure recorded with its reason (Д12).
 */
export class HubOpsClient {
  private flushing?: Promise<void>;
  private flushAgain = false;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private retryMs = RETRY_MIN_MS;
  private reading?: Promise<void>;
  private stopped = true;
  private unreachableSince?: number;
  private lastError?: string;
  private readonly waiters = new Map<string, Array<(outcome: HubOpOutcome) => void>>();
  private readonly statusListeners: Array<() => void> = [];
  private readerWake?: () => void;
  /** Cancels the feed read in flight (a stop does not wait out its long wait). */
  private reading_?: AbortController;

  constructor(private readonly options: {
    store: HubClientOpsStore;
    /** Where the feed was read up to (kept with the device's other hub state). */
    cursor: { get(): Promise<string | undefined>; set(value: string): Promise<void> };
    /** The current link to the server (absent while there is none). */
    client: () => HubClient | undefined;
    /** Applies what the server accepted to this device's copy, durably,
     *  before the place is moved past it. */
    apply(entries: HubFeedEntry[]): Promise<void>;
    /** Reads the chats again (the feed forgot this device's place); returns
     *  the place to continue from. */
    resync(): Promise<number>;
    onAnswered?(row: HubClientOpRow, outcome: HubOpOutcome): void;
    log(event: string, payload: Record<string, unknown>): void;
    now?: () => number;
  }) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.nudge();
    this.reading ??= this.readLoop().finally(() => { this.reading = undefined; });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.readerWake?.();
    this.reading_?.abort();
    await this.flushing?.catch(() => undefined);
    await this.reading?.catch(() => undefined);
  }

  /** The statements that queue operations with a local save (alsoCommit). */
  queueSql(ops: HubOp[], condition?: string): string {
    return this.options.store.insertSql(ops, new Date(this.now()).toISOString(), condition);
  }

  async enqueue(ops: HubOp[]): Promise<void> {
    await this.options.store.enqueue(ops, new Date(this.now()).toISOString());
    this.nudge();
  }

  /** Sends what waits, now (a save queued something, the link came back). */
  nudge(): void {
    if (this.stopped) return;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    if (this.flushing) {
      this.flushAgain = true;
      return;
    }
    this.flushing = this.flush().finally(() => {
      this.flushing = undefined;
      if (this.flushAgain) {
        this.flushAgain = false;
        this.nudge();
      }
    });
  }

  /** Resolves once the server answered this operation. */
  waitFor(opId: string, signal?: AbortSignal): Promise<HubOpOutcome> {
    return new Promise((resolve, reject) => {
      const done = (outcome: HubOpOutcome) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(outcome);
      };
      const onAbort = () => {
        const list = this.waiters.get(opId)?.filter((item) => item !== done);
        if (list?.length) this.waiters.set(opId, list); else this.waiters.delete(opId);
        reject(signal?.reason ?? new Error("Cancelled."));
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.set(opId, [...(this.waiters.get(opId) ?? []), done]);
      // Answered already (or before this was asked).
      void this.options.store.get(opId).then((row) => {
        if (row?.status === "accepted") {
          this.answer(opId, { status: "accepted", seq: row.seq ?? 0, ...(row.claim ? { claim: row.claim } : {}), ...(row.turn ? { turn: row.turn } : {}) });
        }
        else if (row?.status === "rejected") this.answer(opId, { status: "rejected", reason: row.lastError ?? "Rejected." });
      }).catch(() => undefined);
    });
  }

  /** A chat moved to the server whole: what was queued for its content is in
   *  that move, so it is settled as accepted and not sent again (turns still
   *  go). Whoever waits for those operations hears so. */
  async settleMoved(conversationId: string): Promise<void> {
    const at = new Date(this.now()).toISOString();
    for (const row of await this.options.store.forConversation(conversationId)) {
      if (row.kind.startsWith("turn.")) continue;
      await this.options.store.accept(row.opId, 0, at);
      this.answer(row.opId, { status: "accepted", seq: 0 });
    }
  }

  /** Whether writes reach the server now, and how many wait. */
  async status(): Promise<{ queued: number; unreachableSince?: number; lastError?: string }> {
    return {
      queued: await this.options.store.count("queued"),
      ...(this.unreachableSince !== undefined ? { unreachableSince: this.unreachableSince } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {})
    };
  }

  onStatusChanged(listener: () => void): void {
    this.statusListeners.push(listener);
  }

  private answer(opId: string, outcome: HubOpOutcome): void {
    const list = this.waiters.get(opId);
    this.waiters.delete(opId);
    for (const resolve of list ?? []) resolve(outcome);
  }

  private setReachable(reachable: boolean, error?: string): void {
    const before = this.unreachableSince;
    if (reachable) {
      this.unreachableSince = undefined;
      this.lastError = undefined;
    } else {
      this.unreachableSince ??= this.now();
      this.lastError = error;
    }
    if (before !== this.unreachableSince) for (const listener of this.statusListeners) listener();
  }

  private async flush(): Promise<void> {
    for (;;) {
      if (this.stopped) return;
      const client = this.options.client();
      const batch = await this.options.store.queued(HUB_OPS_MAX_PER_REQUEST, FLUSH_MAX_BYTES);
      if (batch.length === 0) return;
      const at = new Date(this.now()).toISOString();
      if (!client) {
        // No link yet: kept, tried when the link comes (nudge).
        return;
      }
      let response;
      try {
        response = await client.writeOps(batch.map((row) => row.op));
      } catch (error) {
        const reason = error instanceof HubHttpError ? `The server answered ${error.status}: ${error.message}` : error instanceof Error ? error.message : String(error);
        await this.options.store.failed(batch, reason, at).catch(() => undefined);
        this.options.log("hub.ops.send-failed", { ops: batch.length, reason, retryMs: this.retryMs });
        this.setReachable(false, reason);
        this.scheduleRetry();
        return;
      }
      this.retryMs = RETRY_MIN_MS;
      this.setReachable(true);
      const byId = new Map(response.results.map((result) => [result.opId, result]));
      for (const row of batch) {
        const result = byId.get(row.opId);
        if (!result) continue;
        if (result.status === "rejected") {
          await this.options.store.reject(row, result.reason, at);
          this.options.log("hub.ops.rejected", { opId: row.opId, kind: row.kind, conversationId: row.conversationId, reason: result.reason });
          const outcome: HubOpOutcome = { status: "rejected", reason: result.reason };
          this.options.onAnswered?.(row, outcome);
          this.answer(row.opId, outcome);
        } else {
          const extra = { ...(result.claim ? { claim: result.claim } : {}), ...(result.turn ? { turn: result.turn } : {}) };
          await this.options.store.accept(row.opId, result.seq, at, extra);
          const outcome: HubOpOutcome = { status: "accepted", seq: result.seq, ...extra };
          this.options.onAnswered?.(row, outcome);
          this.answer(row.opId, outcome);
        }
      }
      if (byId.size === 0) return;
    }
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    const delay = this.retryMs;
    this.retryMs = Math.min(RETRY_MAX_MS, this.retryMs * 2);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.nudge();
    }, delay);
    this.retryTimer.unref?.();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.readerWake = undefined; resolve(); }, ms);
      timer.unref?.();
      this.readerWake = () => { clearTimeout(timer); this.readerWake = undefined; resolve(); };
    });
  }

  /** Wakes the reader early (the link came back). */
  wakeReader(): void {
    this.readerWake?.();
  }

  private async readLoop(): Promise<void> {
    let failures = 0;
    while (!this.stopped) {
      const client = this.options.client();
      if (!client) {
        await this.sleep(2_000);
        continue;
      }
      try {
        const stored = await this.options.cursor.get();
        let cursor = stored === undefined ? NaN : Number(stored);
        if (!Number.isSafeInteger(cursor) || cursor < 0) {
          cursor = await this.options.resync();
          await this.options.cursor.set(String(cursor));
        }
        let page;
        const cancel = new AbortController();
        this.reading_ = cancel;
        try {
          page = await client.feed(cursor, HUB_FEED_WAIT_MAX_MS, cancel.signal);
        } catch (error) {
          if (this.stopped) return;
          if (!(error instanceof HubHttpError && error.status === 410)) throw error;
          this.options.log("hub.feed.gone", { after: cursor });
          const head = await this.options.resync();
          await this.options.cursor.set(String(head));
          continue;
        } finally {
          if (this.reading_ === cancel) this.reading_ = undefined;
        }
        if (page.entries.length > 0) {
          await this.options.apply(page.entries);
          await this.options.cursor.set(String(page.entries[page.entries.length - 1].seq));
        }
        failures = 0;
      } catch (error) {
        failures += 1;
        this.options.log("hub.feed.read-failed", { message: error instanceof Error ? error.message : String(error), failures });
        await this.sleep(Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.min(4, failures - 1)));
      }
    }
  }
}

function quote(value: string): string {
  // The sqlite3 shell reads statements line by line and a NUL ends a line:
  // the rest of the literal would leak into the statement.
  if (value.includes("\u0000")) throw new Error("A value with a NUL character cannot be stored.");
  return `'${value.replace(/'/g, "''")}'`;
}

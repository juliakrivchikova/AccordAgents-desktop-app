/** The hub's copy of the relay's sealed mailboxes: one row per mailbox (its
 *  lock, counters and doorbell state), its envelopes and its execution
 *  claims. Everything stored is ciphertext or routing metadata, as on the
 *  relay. */
export const HUB_RELAY_SCHEMA_SQL = `
  create table if not exists hub_relay_mailboxes (
    mailbox_id text primary key,
    token_hash text,
    registered_at text,
    epoch text,
    arrival_seq integer not null default 0,
    revoked_at text,
    push_subscription text,
    push_last_sent integer,
    push_read_cursor integer not null default 0,
    push_finish_seq integer,
    push_last_result text,
    push_at integer
  );
  create table if not exists hub_relay_events (
    mailbox_id text not null,
    event_id text not null,
    arrival_seq integer not null,
    arrived_at text not null,
    conversation_id text not null,
    log_scope_id text not null,
    origin_id text not null,
    origin_seq integer not null,
    ct_length integer not null,
    event_json text not null,
    primary key(mailbox_id, event_id)
  );
  create index if not exists hub_relay_events_arrival on hub_relay_events(mailbox_id, arrival_seq);
  create index if not exists hub_relay_events_age on hub_relay_events(arrived_at);
  create table if not exists hub_relay_claims (
    mailbox_id text not null,
    claim_key text not null,
    claim_json text not null,
    expires_at text not null,
    primary key(mailbox_id, claim_key)
  );
`;

interface Database {
  init(): Promise<void>;
  query<T>(sql: string): Promise<T[]>;
  execute(sql: string): Promise<void>;
}

export interface HubRelayMailboxRow {
  mailboxId: string;
  tokenHash: string | null;
  registeredAt: string | null;
  epoch: string | null;
  arrivalSeq: number;
  revokedAt: string | null;
  pushSubscription: string | null;
  pushLastSent: number | null;
  pushReadCursor: number;
  pushFinishSeq: number | null;
  pushLastResult: string | null;
  pushAt: number | null;
  /** What this mailbox's pairing may read through the server's phone API
   *  (JSON of MobilePhoneScope), as the desktop that made the pairing said. */
  phoneScope: string | null;
}

/** What sorting and choosing a page needs, without the envelope itself. */
export interface HubRelayEventMeta {
  eventId: string;
  arrivalSeq: number;
  conversationId: string;
  logScopeId: string;
  originId: string;
  originSeq: number;
  ctLength: number;
}

export interface HubRelayStoredEvent {
  eventId: string;
  arrivalSeq: number;
  arrivedAt: string;
  conversationId: string;
  logScopeId: string;
  originId: string;
  originSeq: number;
  ctLength: number;
  eventJson: string;
}

export type HubRelayMailboxUpdate = Partial<Omit<HubRelayMailboxRow, "mailboxId">>;

const COLUMNS: Record<keyof HubRelayMailboxUpdate, string> = {
  tokenHash: "token_hash",
  registeredAt: "registered_at",
  epoch: "epoch",
  arrivalSeq: "arrival_seq",
  revokedAt: "revoked_at",
  pushSubscription: "push_subscription",
  pushLastSent: "push_last_sent",
  pushReadCursor: "push_read_cursor",
  pushFinishSeq: "push_finish_seq",
  pushLastResult: "push_last_result",
  pushAt: "push_at",
  phoneScope: "phone_scope"
};

const MAILBOX_SELECT = `mailbox_id as mailboxId, token_hash as tokenHash, registered_at as registeredAt, epoch,
  arrival_seq as arrivalSeq, revoked_at as revokedAt, push_subscription as pushSubscription, push_last_sent as pushLastSent,
  push_read_cursor as pushReadCursor, push_finish_seq as pushFinishSeq, push_last_result as pushLastResult, push_at as pushAt,
  phone_scope as phoneScope`;

/** Ids are read and written in groups no longer than this. */
const ID_BATCH = 200;

export class HubRelayStorage {
  private ready?: Promise<void>;

  constructor(private readonly database: Database) {}

  private async init(): Promise<void> {
    this.ready ??= (async () => {
      await this.database.init();
      await this.database.execute(HUB_RELAY_SCHEMA_SQL);
      // Added after the first servers were set up: their table gains it.
      const columns = await this.database.query<{ name: string }>("select name from pragma_table_info('hub_relay_mailboxes');");
      if (!columns.some((column) => column.name === "phone_scope")) {
        await this.database.execute("alter table hub_relay_mailboxes add column phone_scope text;");
      }
    })();
    try {
      await this.ready;
    } catch (error) {
      this.ready = undefined;
      throw error;
    }
  }

  async mailbox(mailboxId: string): Promise<HubRelayMailboxRow | undefined> {
    await this.init();
    const rows = await this.database.query<HubRelayMailboxRow>(`select ${MAILBOX_SELECT} from hub_relay_mailboxes where mailbox_id = ${quote(mailboxId)};`);
    return rows[0] ? normalizeMailbox(rows[0]) : undefined;
  }

  /** Writes the named fields, creating the mailbox's row when it has none. */
  async updateMailbox(mailboxId: string, update: HubRelayMailboxUpdate): Promise<void> {
    await this.init();
    const entries = Object.entries(update) as Array<[keyof HubRelayMailboxUpdate, string | number | null | undefined]>;
    const assignments = entries.map(([key, value]) => `${COLUMNS[key]} = ${literal(value)}`);
    await this.database.execute(`
      insert into hub_relay_mailboxes(mailbox_id) values (${quote(mailboxId)}) on conflict(mailbox_id) do nothing;
      ${assignments.length ? `update hub_relay_mailboxes set ${assignments.join(", ")} where mailbox_id = ${quote(mailboxId)};` : ""}
    `);
  }

  /** Revocation: everything readable goes, the row stays as the tombstone. */
  async revoke(mailboxId: string, revokedAt: string): Promise<void> {
    await this.init();
    await this.database.execute(`
      begin immediate;
      delete from hub_relay_events where mailbox_id = ${quote(mailboxId)};
      delete from hub_relay_claims where mailbox_id = ${quote(mailboxId)};
      update hub_relay_mailboxes set token_hash = null, registered_at = null, epoch = null, arrival_seq = 0, push_subscription = null,
        push_last_sent = null, push_read_cursor = 0, push_finish_seq = null, push_last_result = null, push_at = null, phone_scope = null,
        revoked_at = ${quote(revokedAt)}
      where mailbox_id = ${quote(mailboxId)};
      commit;
    `);
  }

  async existingEventIds(mailboxId: string, eventIds: string[]): Promise<Set<string>> {
    await this.init();
    const found = new Set<string>();
    for (let index = 0; index < eventIds.length; index += ID_BATCH) {
      const batch = eventIds.slice(index, index + ID_BATCH);
      const rows = await this.database.query<{ eventId: string }>(`
        select event_id as eventId from hub_relay_events where mailbox_id = ${quote(mailboxId)} and event_id in (${batch.map(quote).join(", ")});
      `);
      for (const row of rows) found.add(row.eventId);
    }
    return found;
  }

  /** Stores envelopes and the mailbox's new counter in one transaction. */
  async appendEvents(mailboxId: string, events: HubRelayStoredEvent[], arrivalSeq: number): Promise<void> {
    if (events.length === 0) return;
    await this.init();
    await this.database.execute(`
      begin immediate;
      ${events.map((event) => `
        insert into hub_relay_events(mailbox_id, event_id, arrival_seq, arrived_at, conversation_id, log_scope_id, origin_id, origin_seq, ct_length, event_json)
          values (${quote(mailboxId)}, ${quote(event.eventId)}, ${event.arrivalSeq}, ${quote(event.arrivedAt)}, ${quote(event.conversationId)},
            ${quote(event.logScopeId)}, ${quote(event.originId)}, ${event.originSeq}, ${event.ctLength}, ${quote(event.eventJson)})
          on conflict(mailbox_id, event_id) do nothing;`).join("")}
      update hub_relay_mailboxes set arrival_seq = ${arrivalSeq} where mailbox_id = ${quote(mailboxId)};
      commit;
    `);
  }

  /** Envelopes that arrived before `cutoff` (or carry no arrival time) are gone. */
  async sweepExpired(mailboxId: string | undefined, cutoffIso: string): Promise<void> {
    await this.init();
    const scope = mailboxId === undefined ? "" : `mailbox_id = ${quote(mailboxId)} and `;
    await this.database.execute(`delete from hub_relay_events where ${scope}(arrived_at < ${quote(cutoffIso)} or arrived_at = '');`);
  }

  /** The same for the given ids only: an append clears just the expired
   *  copies of what it brings, the periodic sweep the rest. */
  async sweepExpiredIds(mailboxId: string, eventIds: string[], cutoffIso: string): Promise<void> {
    await this.init();
    for (let index = 0; index < eventIds.length; index += ID_BATCH) {
      const batch = eventIds.slice(index, index + ID_BATCH);
      await this.database.execute(`
        delete from hub_relay_events where mailbox_id = ${quote(mailboxId)} and event_id in (${batch.map(quote).join(", ")})
          and (arrived_at < ${quote(cutoffIso)} or arrived_at = '');
      `);
    }
  }

  async sweepExpiredClaims(nowIso: string): Promise<void> {
    await this.init();
    await this.database.execute(`delete from hub_relay_claims where expires_at <= ${quote(nowIso)};`);
  }

  /** The oldest envelope still kept (arrived at or after `keptSinceIso`). */
  async oldestArrivalSeq(mailboxId: string, keptSinceIso: string): Promise<number | undefined> {
    await this.init();
    const rows = await this.database.query<{ oldest: number | null }>(`select min(arrival_seq) as oldest from hub_relay_events where mailbox_id = ${quote(mailboxId)} and arrived_at >= ${quote(keptSinceIso)};`);
    const oldest = rows[0]?.oldest;
    return oldest === null || oldest === undefined ? undefined : Number(oldest);
  }

  /** The envelopes a read may choose from, metadata only. */
  /** Envelopes that arrived before `keptSinceIso` are past their keeping
   *  and not offered (the hourly sweep deletes them). */
  async candidates(mailboxId: string, keptSinceIso: string, filter: { conversationId?: string; logScopeId?: string; originId?: string; afterOriginSeq?: number; afterArrival?: number }): Promise<HubRelayEventMeta[]> {
    await this.init();
    const where = [`mailbox_id = ${quote(mailboxId)}`, `arrived_at >= ${quote(keptSinceIso)}`];
    if (filter.conversationId) where.push(`conversation_id = ${quote(filter.conversationId)}`);
    if (filter.logScopeId) where.push(`log_scope_id = ${quote(filter.logScopeId)}`);
    if (filter.originId) where.push(`origin_id = ${quote(filter.originId)}`);
    if (filter.afterOriginSeq !== undefined) where.push(`origin_seq > ${Math.floor(filter.afterOriginSeq)}`);
    if (filter.afterArrival !== undefined) where.push(`arrival_seq > ${Math.floor(filter.afterArrival)}`);
    const rows = await this.database.query<HubRelayEventMeta>(`
      select event_id as eventId, arrival_seq as arrivalSeq, conversation_id as conversationId, log_scope_id as logScopeId,
        origin_id as originId, origin_seq as originSeq, ct_length as ctLength
      from hub_relay_events where ${where.join(" and ")};
    `);
    return rows.map((row) => ({ ...row, arrivalSeq: Number(row.arrivalSeq), originSeq: Number(row.originSeq), ctLength: Number(row.ctLength) }));
  }

  /** The stored envelopes for these ids, as stored. */
  async eventJson(mailboxId: string, eventIds: string[]): Promise<Map<string, string>> {
    await this.init();
    const found = new Map<string, string>();
    for (let index = 0; index < eventIds.length; index += ID_BATCH) {
      const batch = eventIds.slice(index, index + ID_BATCH);
      const rows = await this.database.query<{ eventId: string; eventJson: string }>(`
        select event_id as eventId, event_json as eventJson from hub_relay_events
        where mailbox_id = ${quote(mailboxId)} and event_id in (${batch.map(quote).join(", ")});
      `);
      for (const row of rows) found.set(row.eventId, row.eventJson);
    }
    return found;
  }

  async deleteEvents(mailboxId: string, eventIds: string[]): Promise<string[]> {
    if (eventIds.length === 0) return [];
    const existing = await this.existingEventIds(mailboxId, eventIds);
    const deleted = eventIds.filter((id) => existing.has(id));
    for (let index = 0; index < deleted.length; index += ID_BATCH) {
      const batch = deleted.slice(index, index + ID_BATCH);
      await this.database.execute(`delete from hub_relay_events where mailbox_id = ${quote(mailboxId)} and event_id in (${batch.map(quote).join(", ")});`);
    }
    return [...new Set(deleted)];
  }

  async claim(mailboxId: string, claimKey: string): Promise<string | undefined> {
    await this.init();
    const rows = await this.database.query<{ claimJson: string }>(`select claim_json as claimJson from hub_relay_claims where mailbox_id = ${quote(mailboxId)} and claim_key = ${quote(claimKey)};`);
    return rows[0]?.claimJson;
  }

  async saveClaim(mailboxId: string, claimKey: string, claimJson: string, expiresAt: string): Promise<void> {
    await this.init();
    await this.database.execute(`
      insert into hub_relay_claims(mailbox_id, claim_key, claim_json, expires_at) values (${quote(mailboxId)}, ${quote(claimKey)}, ${quote(claimJson)}, ${quote(expiresAt)})
      on conflict(mailbox_id, claim_key) do update set claim_json = excluded.claim_json, expires_at = excluded.expires_at;
    `);
  }

  /** Mailboxes with a ring waiting for its time. */
  async pendingRings(): Promise<Array<{ mailboxId: string; pushAt: number }>> {
    await this.init();
    const rows = await this.database.query<{ mailboxId: string; pushAt: number }>(`select mailbox_id as mailboxId, push_at as pushAt from hub_relay_mailboxes where push_at is not null;`);
    return rows.map((row) => ({ mailboxId: row.mailboxId, pushAt: Number(row.pushAt) }));
  }
}

function normalizeMailbox(row: HubRelayMailboxRow): HubRelayMailboxRow {
  const num = (value: unknown): number | null => value === null || value === undefined ? null : Number(value);
  return {
    ...row,
    arrivalSeq: Number(row.arrivalSeq) || 0,
    pushReadCursor: Number(row.pushReadCursor) || 0,
    pushLastSent: num(row.pushLastSent),
    pushFinishSeq: num(row.pushFinishSeq),
    pushAt: num(row.pushAt)
  };
}

function literal(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("A relay counter must be a finite number.");
    return String(Math.floor(value));
  }
  return quote(value);
}

function quote(value: string): string {
  // The sqlite3 shell reads statements line by line and a NUL ends a line:
  // the rest of the literal would leak into the statement.
  if (value.includes("\u0000")) throw new Error("A value with a NUL character cannot be stored.");
  return `'${value.replace(/'/g, "''")}'`;
}

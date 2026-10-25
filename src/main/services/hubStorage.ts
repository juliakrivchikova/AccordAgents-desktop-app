import type { ChatEventEnvelope } from "../../shared/chatEvents";
import type { HubDevice, HubDeviceRole, HubLoggedEvent } from "../../shared/hubProtocol";

/** The hub's own tables, beside the chat tables StorageService keeps. */
export const HUB_SCHEMA_SQL = `
  create table if not exists hub_log (
    hub_seq integer primary key autoincrement,
    event_id text not null unique references chat_events(event_id),
    origin_id text not null,
    conversation_id text not null,
    kind text not null,
    accepted_at text not null
  );
  -- Folding reads one chat's changes from a position.
  create index if not exists hub_log_conversation on hub_log(conversation_id, kind, hub_seq);
  create table if not exists hub_devices (
    device_id text primary key,
    public_key text not null,
    role text not null check(role in ('owner', 'desktop', 'machine', 'phone')),
    name text not null,
    machine_id text,
    added_at text not null
  );
  create table if not exists hub_push_subscriptions (
    device_id text not null,
    endpoint text not null,
    subscription_json text not null,
    created_at text not null,
    primary key(device_id, endpoint)
  );
  create table if not exists hub_device_cursors (
    device_id text primary key,
    hub_seq integer not null,
    updated_at text not null
  );
  create table if not exists hub_fold_state (
    conversation_id text primary key,
    hub_seq integer not null
  );
  -- On a device that uses a hub: how far it pushed its own events and read the order.
  create table if not exists hub_client_state (
    key text primary key,
    value text not null
  );
  -- On a device: places in the order it read but could not take yet (an
  -- author it does not know yet, a channel not set up yet, a chat it does
  -- not hold yet). Read again from the hub until taken, or given up after
  -- two weeks (one held for its author: until the roster drops it).
  create table if not exists hub_client_held_events (
    hub_seq integer primary key,
    event_id text not null,
    origin_id text not null,
    conversation_id text not null,
    reason text not null,
    held_at text not null,
    -- When it started waiting for anything but its author (the two weeks
    -- after which it is given up count from here).
    due_from text
  );
  create index if not exists hub_client_held_chat on hub_client_held_events(origin_id, conversation_id);
  -- On the hub: where each reader stands. The hub forgets nothing a reader
  -- still needs: everything after its floor (min of its cursor and its
  -- lowest held place) is kept until it reads it or is taken off the roster.
  create table if not exists hub_reader_floors (
    device_id text primary key,
    floor integer not null,
    read_at text not null,
    first_read_at text,
    held_from integer not null default 0,
    held_since text,
    held_count integer not null default 0,
    -- 1 once the device said what it holds on a read: an older one does not,
    -- and while it reads nothing it reads is forgotten.
    reports integer not null default 0,
    -- Changes the device gave up on after holding them two weeks.
    gave_up_count integer not null default 0,
    gave_up_at text
  );
  -- On the hub: which roster machines read the order, and the channel they
  -- share with the desktop (replaced with the roster).
  create table if not exists hub_device_reads (
    device_id text primary key,
    reader integer not null,
    rendezvous_id text
  );
  -- On the hub: every machine a channel was ever said to belong to, kept
  -- when the roster changes, so a removed machine's channel is known as its.
  create table if not exists hub_pair_machines (
    rendezvous_id text not null,
    device_id text not null,
    primary key(rendezvous_id, device_id)
  );
  -- On the hub: how far each chain was forgotten. A chain continues from
  -- here, an event at or below it is not placed again, and a reader that
  -- finds a gap is told it is gone by design.
  create table if not exists hub_chain_marks (
    origin_id text not null,
    log_scope_id text not null,
    origin_seq integer not null,
    event_hash text not null,
    primary key(origin_id, log_scope_id)
  );
  -- On the hub: the newest position forgotten, per class of readers
  -- ('chat-changes', 'chat-actions', 'pair:<rendezvousId>').
  create table if not exists hub_prune_state (
    class text primary key,
    hub_seq integer not null
  );
  -- On the hub: what one retention rule picked to forget in one look at the
  -- order, forgotten from here a batch at a time (cleared by the next look).
  create table if not exists hub_retention_candidates (
    hub_seq integer primary key,
    event_id text not null,
    origin_id text not null,
    log_scope_id text not null,
    origin_seq integer not null,
    event_hash text not null,
    class text not null,
    bytes integer
  );
`;

/** Where one reader stands on the hub. */
export interface HubReaderFloor {
  deviceId: string;
  floor: number;
  readAt: string;
  firstReadAt?: string;
  heldSince?: string;
  heldCount: number;
  /** The device says what it holds on its reads (an older one does not). */
  reports: boolean;
  /** Changes it gave up on after holding them two weeks, and when last. */
  gaveUpCount?: number;
  gaveUpAt?: string;
}

/** A roster machine's reading: whether it reads the order, and its channel. */
export interface HubDeviceRead {
  deviceId: string;
  reader: boolean;
  rendezvousId?: string;
}

/** One forgotten stretch, as a retention batch reports it. */
export interface HubPruneResult {
  events: number;
  bytes: number;
}

/** The kind the order's chat changes carry (chatChanges.ts). */
const CHAT_CHANGES_KIND = "chat.changes";
const CHAT_ACTIONS_SCOPE = "chat:actions";

/** Where a device keeps its place with the hub (hub_client_state keys). */
export const HUB_CLIENT_PUSHED_KEY = "pushed-rowid";
export const HUB_CLIENT_PULLED_KEY = "pulled-hub-seq";
export const HUB_CLIENT_HUB_ID_KEY = "hub-id";
/** What this device gave up on: `{ [originId]: { count, at } }`. */
export const HUB_CLIENT_GIVEN_UP_KEY = "given-up";

/** Places held because of who wrote them: they wait for the roster, never
 *  for a clock (a newer version's change waits for this device's update). */
export const HELD_FOR_AUTHOR_REASONS = ["unknown-origin", "not-ready", "newer-version"] as const;

/** A held place in the order, as the device keeps it. */
export interface HubHeldEvent {
  hubSeq: number;
  eventId: string;
  originId: string;
  conversationId: string;
  reason: string;
  heldAt: string;
}

interface Database {
  init(): Promise<void>;
  query<T>(sql: string): Promise<T[]>;
  execute(sql: string): Promise<void>;
}

/** One pull reads at most this much envelope JSON. */
const PULL_PAGE_BYTES = 4 * 1024 * 1024;
/** No page of the hub's tables is longer than this. */
const HUB_STORAGE_PAGE_MAX = 1000;

export class HubStorage {
  private ready?: Promise<void>;

  constructor(private readonly database: Database) {}

  private async init(): Promise<void> {
    this.ready ??= (async () => {
      await this.database.init();
      await this.database.execute(HUB_SCHEMA_SQL);
      // A table made by an earlier build of this program has no give-up columns yet.
      const columns = new Set((await this.database.query<{ name: string }>(`select name from pragma_table_info('hub_reader_floors');`)).map((row) => row.name));
      if (!columns.has("gave_up_count")) await this.database.execute(`alter table hub_reader_floors add column gave_up_count integer not null default 0;`);
      if (!columns.has("gave_up_at")) await this.database.execute(`alter table hub_reader_floors add column gave_up_at text;`);
      const heldColumns = new Set((await this.database.query<{ name: string }>(`select name from pragma_table_info('hub_client_held_events');`)).map((row) => row.name));
      if (!heldColumns.has("due_from")) await this.database.execute(`alter table hub_client_held_events add column due_from text;`);
      // A hub updated to floors: every device that read before stands where
      // it last read, not where the owner stands now (one stopped during the
      // update has not read what came since). Not marked as reporting.
      await this.database.execute(`
        insert or ignore into hub_reader_floors(device_id, floor, read_at, first_read_at)
          select c.device_id, c.hub_seq, c.updated_at, c.updated_at from hub_device_cursors c
          join hub_devices d on d.device_id = c.device_id where d.role != 'phone';
      `);
    })();
    try {
      await this.ready;
    } catch (error) {
      this.ready = undefined;
      throw error;
    }
  }

  /** Gives accepted events their places in the order, in the order given
   *  (once each; a repeat keeps the first). `placed` says whether this call
   *  gave the place. */
  async logMany(events: ChatEventEnvelope[], acceptedAt: string): Promise<Map<string, { hubSeq: number; placed: boolean }>> {
    const places = new Map<string, { hubSeq: number; placed: boolean }>();
    if (events.length === 0) return places;
    await this.init();
    const ids = events.map((event) => quote(event.eventId)).join(", ");
    const before = new Set((await this.database.query<{ eventId: string }>(`select event_id as eventId from hub_log where event_id in (${ids});`)).map((row) => row.eventId));
    const rows = await this.database.query<{ eventId: string; hubSeq: number }>(`
      begin immediate;
      ${events.filter((event) => !before.has(event.eventId)).map((event) => `
        insert into hub_log(event_id, origin_id, conversation_id, kind, accepted_at)
          select ${quote(event.eventId)}, ${quote(event.originId)}, ${quote(event.conversationId)}, ${quote(event.kind)}, ${quote(acceptedAt)}
          where not exists (select 1 from hub_log where event_id = ${quote(event.eventId)})
            and exists (select 1 from chat_events where event_id = ${quote(event.eventId)});`).join("")}
      commit;
      select event_id as eventId, hub_seq as hubSeq from hub_log where event_id in (${ids});
    `);
    for (const row of rows) {
      const hubSeq = Number(row.hubSeq);
      if (!Number.isSafeInteger(hubSeq) || hubSeq < 1) throw new Error("The hub could not place an accepted event.");
      places.set(row.eventId, { hubSeq, placed: !before.has(row.eventId) });
    }
    return places;
  }

  /** Where a chain stood in the desktop's first copy of the chats: the hub
   *  continues it from there without holding the earlier events. */
  async chainAnchor(originId: string, logScopeId: string): Promise<{ originSeq: number; eventHash: string } | undefined> {
    await this.init();
    const rows = await this.database.query<{ originSeq: number; eventHash: string }>(`
      select origin_seq as originSeq, event_hash as eventHash from device_event_applied_heads
      where origin_id = ${quote(originId)} and log_scope_id = ${quote(logScopeId)};
    `).catch(() => []);
    const row = rows[0];
    return row && Number.isSafeInteger(Number(row.originSeq)) ? { originSeq: Number(row.originSeq), eventHash: row.eventHash } : undefined;
  }

  /** The newest position ever given, forgotten or not: a forgotten newest
   *  event must not make the order look shorter to its readers. */
  async head(): Promise<number> {
    await this.init();
    const rows = await this.database.query<{ head: number | null }>(`
      select max(coalesce((select max(hub_seq) from hub_log), 0),
        coalesce((select seq from sqlite_sequence where name = 'hub_log'), 0)) as head;
    `);
    return Number(rows[0]?.head ?? 0) || 0;
  }

  /**
   * Events after `afterSeq`, in the hub's order, bounded by count and bytes;
   * without those `skipOriginId` wrote (a device does not read its own back).
   * `through` is how far the page covers, skipped events included.
   */
  async pull(afterSeq: number, limit: number, skipOriginId?: string): Promise<{ events: HubLoggedEvent[]; through: number }> {
    await this.init();
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new Error("Invalid hub position.");
    const count = Math.max(1, Math.min(limit, HUB_STORAGE_PAGE_MAX));
    // Read up to where the order stood when the page began: a later event
    // is never jumped over by `through`.
    const head = await this.head();
    const skip = skipOriginId ? `and origin_id != ${quote(skipOriginId)}` : "";
    const places = (await this.database.query<{ hubSeq: number }>(`
      select hub_seq as hubSeq from hub_log
      where hub_seq > ${afterSeq} and hub_seq <= ${head} ${skip}
      order by hub_seq limit ${count};
    `)).map((row) => Number(row.hubSeq));
    if (places.length === 0) return { events: [], through: Math.max(afterSeq, head) };
    const rows = await this.database.query<{ hubSeq: number; envelope: string }>(`
      with page as (
        select l.hub_seq as hubSeq, e.envelope_json as envelope,
          sum(length(cast(e.envelope_json as blob))) over (order by l.hub_seq) as bytes,
          row_number() over (order by l.hub_seq) as ordinal
        from hub_log l join chat_events e on e.event_id = l.event_id
        where l.hub_seq in (${places.join(", ")})
      ) select hubSeq, envelope from page where bytes <= ${PULL_PAGE_BYTES} or ordinal = 1 order by hubSeq;
    `);
    const events = rows.map((row) => ({ hubSeq: Number(row.hubSeq), event: JSON.parse(row.envelope) as ChatEventEnvelope }));
    // A whole short page covers everything up to the head; a full or
    // byte-cut one stops at its last event.
    const complete = places.length < count && events.length === places.length;
    const last = events.length > 0 ? events[events.length - 1].hubSeq : places[places.length - 1];
    return { events, through: complete ? head : last };
  }

  /** One chat's accepted changes of `kind` after a position, for folding. */
  async conversationEvents(conversationId: string, kind: string, afterSeq: number, limit: number): Promise<HubLoggedEvent[]> {
    await this.init();
    const rows = await this.database.query<{ hubSeq: number; envelope: string }>(`
      select l.hub_seq as hubSeq, e.envelope_json as envelope
      from hub_log l join chat_events e on e.event_id = l.event_id
      where l.conversation_id = ${quote(conversationId)} and l.kind = ${quote(kind)} and l.hub_seq > ${afterSeq}
      order by l.hub_seq limit ${Math.max(1, Math.min(limit, HUB_STORAGE_PAGE_MAX))};
    `);
    return rows.map((row) => ({ hubSeq: Number(row.hubSeq), event: JSON.parse(row.envelope) as ChatEventEnvelope }));
  }

  async foldedThrough(conversationId: string): Promise<number> {
    await this.init();
    const rows = await this.database.query<{ hubSeq: number }>(`select hub_seq as hubSeq from hub_fold_state where conversation_id = ${quote(conversationId)};`);
    return Number(rows[0]?.hubSeq ?? 0) || 0;
  }

  async setFoldedThrough(conversationId: string, hubSeq: number): Promise<void> {
    await this.init();
    await this.database.execute(`
      insert into hub_fold_state(conversation_id, hub_seq) values (${quote(conversationId)}, ${hubSeq})
      on conflict(conversation_id) do update set hub_seq = max(hub_seq, excluded.hub_seq);
    `);
  }

  /** Chats with accepted changes of `kind` not yet folded. */
  async unfoldedConversations(kind: string): Promise<string[]> {
    await this.init();
    const rows = await this.database.query<{ conversationId: string }>(`
      select l.conversation_id as conversationId from hub_log l
      left join hub_fold_state f on f.conversation_id = l.conversation_id
      where l.kind = ${quote(kind)}
      group by l.conversation_id
      having max(l.hub_seq) > coalesce(max(f.hub_seq), 0);
    `);
    return rows.map((row) => row.conversationId);
  }

  async devices(): Promise<HubDevice[]> {
    await this.init();
    const rows = await this.database.query<{ deviceId: string; publicKey: string; role: HubDeviceRole; name: string; machineId: string | null; addedAt: string }>(`
      select device_id as deviceId, public_key as publicKey, role, name, machine_id as machineId, added_at as addedAt from hub_devices order by added_at;
    `);
    return rows.map((row) => ({
      deviceId: row.deviceId, publicKeyDerBase64: row.publicKey, role: row.role, name: row.name, addedAt: row.addedAt,
      ...(row.machineId ? { machineId: row.machineId } : {})
    }));
  }

  /** Replaces the roster in one transaction. The owner row is kept as it is. */
  async replaceRoster(devices: HubDevice[], now: string): Promise<void> {
    await this.init();
    // The owner is in the list it sends (as a desktop) and stays the owner.
    const owners = new Set((await this.database.query<{ deviceId: string }>(`select device_id as deviceId from hub_devices where role = 'owner';`)).map((row) => row.deviceId));
    const values = devices.filter((device) => device.role !== "owner" && !owners.has(device.deviceId)).map((device) =>
      `(${quote(device.deviceId)}, ${quote(device.publicKeyDerBase64)}, ${quote(device.role)}, ${quote(device.name)}, ${device.machineId ? quote(device.machineId) : "null"}, ${quote(device.addedAt || now)})`);
    const reads = devices.filter((device) => device.role === "machine" && !owners.has(device.deviceId)).map((device) =>
      `(${quote(device.deviceId)}, ${device.reader ? 1 : 0}, ${device.rendezvousId ? quote(device.rendezvousId) : "null"})`);
    // A reader added now is kept for from where the owner stands: the copy of
    // the chats it starts from is the owner's, made at or after that point.
    await this.database.execute(`
      begin immediate;
      delete from hub_devices where role != 'owner';
      ${values.length ? `insert into hub_devices(device_id, public_key, role, name, machine_id, added_at) values ${values.join(", ")};` : ""}
      delete from hub_push_subscriptions where device_id not in (select device_id from hub_devices);
      delete from hub_device_reads;
      ${reads.length ? `insert into hub_device_reads(device_id, reader, rendezvous_id) values ${reads.join(", ")};` : ""}
      insert or ignore into hub_pair_machines(rendezvous_id, device_id)
        select rendezvous_id, device_id from hub_device_reads where rendezvous_id is not null;
      -- Taking a device off the roster lets go of what was kept for it.
      delete from hub_reader_floors where device_id not in (select device_id from hub_devices);
      -- A reader that read before stands where it last read; a new one where
      -- the owner stands (its first copy is the owner's, made since).
      insert or ignore into hub_reader_floors(device_id, floor, read_at, first_read_at, reports)
        select r.device_id, c.hub_seq, c.updated_at, c.updated_at, 0
        from hub_device_reads r join hub_device_cursors c on c.device_id = r.device_id where r.reader = 1;
      insert or ignore into hub_reader_floors(device_id, floor, read_at, reports)
        select r.device_id, coalesce((select f.floor from hub_reader_floors f join hub_devices o on o.device_id = f.device_id and o.role = 'owner'), 0), ${quote(now)}, 1
        from hub_device_reads r where r.reader = 1;
      commit;
    `);
  }

  /** Which roster machines read the order, and their channels. */
  async deviceReads(): Promise<HubDeviceRead[]> {
    await this.init();
    const rows = await this.database.query<{ deviceId: string; reader: number; rendezvousId: string | null }>(`
      select device_id as deviceId, reader, rendezvous_id as rendezvousId from hub_device_reads;
    `);
    return rows.map((row) => ({ deviceId: row.deviceId, reader: Number(row.reader) === 1, ...(row.rendezvousId ? { rendezvousId: row.rendezvousId } : {}) }));
  }

  async readerFloors(deviceId?: string): Promise<HubReaderFloor[]> {
    await this.init();
    const rows = await this.database.query<{ deviceId: string; floor: number; readAt: string; firstReadAt: string | null; heldSince: string | null; heldCount: number; reports: number; gaveUpCount: number; gaveUpAt: string | null }>(`
      select device_id as deviceId, floor, read_at as readAt, first_read_at as firstReadAt, held_since as heldSince, held_count as heldCount, reports,
        gave_up_count as gaveUpCount, gave_up_at as gaveUpAt
      from hub_reader_floors ${deviceId ? `where device_id = ${quote(deviceId)}` : ""};
    `);
    return rows.map((row) => ({
      deviceId: row.deviceId, floor: Number(row.floor) || 0, readAt: row.readAt, heldCount: Number(row.heldCount) || 0, reports: Number(row.reports) === 1,
      ...(row.firstReadAt ? { firstReadAt: row.firstReadAt } : {}), ...(row.heldSince ? { heldSince: row.heldSince } : {}),
      ...(row.gaveUpAt ? { gaveUpAt: row.gaveUpAt, gaveUpCount: Number(row.gaveUpCount) || 0 } : {})
    }));
  }

  async readerFloor(deviceId: string): Promise<HubReaderFloor | undefined> {
    return (await this.readerFloors(deviceId))[0];
  }

  /**
   * A read: the device's place in the order (what a phone is not rung for)
   * and its floor, in one write. `held` is what a device that reports says
   * it holds; without it the device does not report, and its floor is where
   * it reads from.
   */
  async recordRead(deviceId: string, cursor: number, floor: number, held: { from: number; since?: string; count: number; gaveUp?: { count: number; at: string } } | undefined, now: string): Promise<void> {
    await this.init();
    await this.database.execute(`
      begin immediate;
      insert into hub_device_cursors(device_id, hub_seq, updated_at) values (${quote(deviceId)}, ${Math.max(0, Math.floor(cursor))}, ${quote(now)})
      on conflict(device_id) do update set hub_seq = excluded.hub_seq, updated_at = excluded.updated_at;
      insert into hub_reader_floors(device_id, floor, read_at, first_read_at, held_from, held_since, held_count, reports)
        values (${quote(deviceId)}, ${Math.max(0, Math.floor(floor))}, ${quote(now)}, ${quote(now)}, ${Math.max(0, Math.floor(held?.from ?? 0))},
          ${held?.since ? quote(held.since) : "null"}, ${Math.max(0, Math.floor(held?.count ?? 0))}, ${held ? 1 : 0})
      on conflict(device_id) do update set floor = excluded.floor, read_at = excluded.read_at,
        first_read_at = coalesce(hub_reader_floors.first_read_at, excluded.first_read_at),
        held_from = excluded.held_from, held_since = excluded.held_since, held_count = excluded.held_count, reports = excluded.reports;
      ${held?.gaveUp ? `update hub_reader_floors set gave_up_count = ${Math.max(0, Math.floor(held.gaveUp.count))}, gave_up_at = ${quote(held.gaveUp.at)}
        where device_id = ${quote(deviceId)};` : ""}
      commit;
    `);
  }

  /** A device starts reading at `floor` (a snapshot): kept for from there. */
  async startReader(deviceId: string, floor: number, now: string): Promise<void> {
    await this.init();
    // Only a device that reports asks for a start (a snapshot).
    await this.database.execute(`
      insert into hub_reader_floors(device_id, floor, read_at, first_read_at, reports)
        values (${quote(deviceId)}, ${Math.max(0, Math.floor(floor))}, ${quote(now)}, ${quote(now)}, 1)
      on conflict(device_id) do update set floor = excluded.floor, read_at = excluded.read_at, reports = 1,
        first_read_at = coalesce(hub_reader_floors.first_read_at, excluded.first_read_at);
    `);
  }

  /** The newest position forgotten in any of these classes (0 when none). */
  async prunedThrough(classes: string[]): Promise<number> {
    if (classes.length === 0) return 0;
    await this.init();
    const rows = await this.database.query<{ hubSeq: number | null }>(`
      select max(hub_seq) as hubSeq from hub_prune_state where class in (${classes.map(quote).join(", ")});
    `);
    return Number(rows[0]?.hubSeq ?? 0) || 0;
  }

  /** Every pair class forgotten so far (for a desktop, which is in all of them). */
  async prunedPairClasses(): Promise<string[]> {
    await this.init();
    const rows = await this.database.query<{ class: string }>(`select class from hub_prune_state where substr(class, 1, 5) = 'pair:';`);
    return rows.map((row) => row.class);
  }

  /** How far a chain was forgotten. */
  async chainMark(originId: string, logScopeId: string): Promise<{ originSeq: number; eventHash: string } | undefined> {
    await this.init();
    const rows = await this.database.query<{ originSeq: number; eventHash: string }>(`
      select origin_seq as originSeq, event_hash as eventHash from hub_chain_marks
      where origin_id = ${quote(originId)} and log_scope_id = ${quote(logScopeId)};
    `);
    return rows[0] ? { originSeq: Number(rows[0].originSeq), eventHash: rows[0].eventHash } : undefined;
  }

  /** Records that a chain is gone up to `originSeq` (its author no longer
   *  holds what came before, and this hub never had it). */
  async markChain(originId: string, logScopeId: string, originSeq: number, eventHash: string): Promise<void> {
    if (!Number.isSafeInteger(originSeq) || originSeq < 1) return;
    await this.init();
    await this.database.execute(`
      insert into hub_chain_marks(origin_id, log_scope_id, origin_seq, event_hash)
        values (${quote(originId)}, ${quote(logScopeId)}, ${Math.floor(originSeq)}, ${quote(eventHash)})
      on conflict(origin_id, log_scope_id) do update set origin_seq = excluded.origin_seq, event_hash = excluded.event_hash
        where excluded.origin_seq > hub_chain_marks.origin_seq;
    `);
  }

  /** One chain's retained events in a range, for a reader that found a gap. */
  async chainEvents(originId: string, logScopeId: string, fromSeq: number, toSeq: number, limit: number): Promise<HubLoggedEvent[]> {
    await this.init();
    const rows = await this.database.query<{ hubSeq: number; envelope: string }>(`
      with page as (
        select l.hub_seq as hubSeq, e.envelope_json as envelope,
          sum(length(cast(e.envelope_json as blob))) over (order by e.origin_seq) as bytes,
          row_number() over (order by e.origin_seq) as ordinal
        from chat_events e join hub_log l on l.event_id = e.event_id
        where e.origin_id = ${quote(originId)} and e.log_scope_id = ${quote(logScopeId)}
          and e.origin_seq between ${Math.max(1, Math.floor(fromSeq))} and ${Math.max(1, Math.floor(toSeq))}
        order by e.origin_seq limit ${Math.max(1, Math.min(limit, HUB_STORAGE_PAGE_MAX))}
      ) select hubSeq, envelope from page where bytes <= ${PULL_PAGE_BYTES} or ordinal = 1 order by ordinal;
    `);
    return rows.map((row) => ({ hubSeq: Number(row.hubSeq), event: JSON.parse(row.envelope) as ChatEventEnvelope }));
  }

  /** The lowest position of a chat change the hub's copy does not hold yet
   *  (0 when every one is folded). */
  async lowestUnfolded(): Promise<number> {
    await this.init();
    const rows = await this.database.query<{ hubSeq: number | null }>(`
      select min(l.hub_seq) as hubSeq from hub_log l
      left join hub_fold_state f on f.conversation_id = l.conversation_id
      where l.kind = ${quote(CHAT_CHANGES_KIND)} and l.hub_seq > coalesce(f.hub_seq, 0);
    `);
    return Number(rows[0]?.hubSeq ?? 0) || 0;
  }

  /** The lowest retained position in these scopes written by someone other
   *  than `exceptOrigin` (0 when none): a device's own channels start there. */
  async lowestInScopes(prefixes: string[], exceptOrigin: string, after = 0): Promise<number> {
    const usable = prefixes.filter((prefix) => prefix.length > 0 && prefix.length <= 512);
    if (usable.length === 0) return 0;
    await this.init();
    const rows = await this.database.query<{ hubSeq: number | null }>(`
      select min(l.hub_seq) as hubSeq from hub_log l join chat_events e on e.event_id = l.event_id
      where l.hub_seq > ${Math.max(0, Math.floor(after))} and l.origin_id != ${quote(exceptOrigin)}
        and (${usable.map((prefix) => `substr(e.log_scope_id, 1, ${prefix.length}) = ${quote(prefix)}`).join(" or ")});
    `);
    return Number(rows[0]?.hubSeq ?? 0) || 0;
  }

  /** How far the hub's copy covers each chat change chain: folded events,
   *  forgotten ones, and the first copy's anchors. */
  async copyMarks(conversationId?: string): Promise<Array<{ originId: string; logScopeId: string; originSeq: number; eventHash: string }>> {
    await this.init();
    const scope = conversationId ? `chat-changes:${conversationId}` : undefined;
    const ofScope = scope ? `log_scope_id = ${quote(scope)}` : "substr(log_scope_id, 1, 13) = 'chat-changes:'";
    const rows = await this.database.query<{ originId: string; logScopeId: string; originSeq: number; eventHash: string }>(`
      select originId, logScopeId, originSeq, eventHash from (
        select e.origin_id as originId, e.log_scope_id as logScopeId, e.origin_seq as originSeq, e.event_hash as eventHash,
          row_number() over (partition by e.origin_id, e.log_scope_id order by e.origin_seq desc) as rn
        from hub_log l join chat_events e on e.event_id = l.event_id
        join hub_fold_state f on f.conversation_id = l.conversation_id
        where l.kind = ${quote(CHAT_CHANGES_KIND)} and l.hub_seq <= f.hub_seq ${conversationId ? `and l.conversation_id = ${quote(conversationId)}` : ""}
      ) where rn = 1
      union all
      select origin_id, log_scope_id, origin_seq, event_hash from hub_chain_marks where ${ofScope}
      union all
      select origin_id, log_scope_id, origin_seq, event_hash from device_event_applied_heads where ${ofScope};
    `);
    const best = new Map<string, { originId: string; logScopeId: string; originSeq: number; eventHash: string }>();
    for (const row of rows) {
      const key = `${row.originId}\n${row.logScopeId}`;
      const seq = Number(row.originSeq);
      if (!Number.isSafeInteger(seq) || seq < 1) continue;
      if ((best.get(key)?.originSeq ?? 0) < seq) best.set(key, { originId: row.originId, logScopeId: row.logScopeId, originSeq: seq, eventHash: row.eventHash });
    }
    return [...best.values()];
  }

  /**
   * Picks what one rule may forget, up to `limit` events, in one look at
   * the order (columns hub_seq, event_id, origin_id, log_scope_id,
   * origin_seq, event_hash, class, bytes) into this session's candidates;
   * `pruneCandidates` then forgets them a batch at a time. One look per run
   * and rule: looking again for every batch made the work grow with the
   * square of what there was to forget.
   */
  private async collect(candidatesSql: string, setupSql = ""): Promise<number> {
    await this.init();
    // A table of the hub's own, not a temp one: each command reaches the
    // database on a connection of its own.
    const rows = await this.database.query<{ count: number }>(`
      ${setupSql}
      begin immediate;
      delete from hub_retention_candidates;
      insert or ignore into hub_retention_candidates(hub_seq, event_id, origin_id, log_scope_id, origin_seq, event_hash, class, bytes)
        ${candidatesSql};
      commit;
      select count(*) as count from hub_retention_candidates;
    `);
    return Number(rows[0]?.count ?? 0) || 0;
  }

  /**
   * Forgets the next `limit` candidates (oldest first) in one transaction,
   * each still below the floor of its readers as they stand now (`shared`
   * for chat changes and actions, `pairs` per channel). Each chain's mark
   * and each class's forgotten position move with them, so nothing
   * forgotten is placed again and a late reader is told rather than left
   * waiting.
   */
  async pruneCandidates(shared: number, pairs: Map<string, number>, limit: number): Promise<HubPruneResult> {
    await this.init();
    const values = [...pairs].map(([rid, floor]) => `(${quote(`pair:${rid}`)}, ${Math.max(0, Math.floor(floor))})`).join(", ");
    const rows = await this.database.query<{ events: number; bytes: number | null }>(`
      create temp table if not exists hub_class_floors(class text primary key, floor integer);
      delete from temp.hub_class_floors;
      insert into temp.hub_class_floors(class, floor) values ('chat-changes', ${Math.max(0, Math.floor(shared))}), ('chat-actions', ${Math.max(0, Math.floor(shared))})${values ? `, ${values}` : ""};
      begin immediate;
      create temp table if not exists hub_pruned(hub_seq integer primary key, event_id text, origin_id text, log_scope_id text,
        origin_seq integer, event_hash text, class text, bytes integer);
      delete from temp.hub_pruned;
      insert or ignore into temp.hub_pruned(hub_seq, event_id, origin_id, log_scope_id, origin_seq, event_hash, class, bytes)
        select c.hub_seq, c.event_id, c.origin_id, c.log_scope_id, c.origin_seq, c.event_hash, c.class, c.bytes
        from hub_retention_candidates c join temp.hub_class_floors f on f.class = c.class
        where c.hub_seq <= f.floor and exists (select 1 from hub_log l where l.hub_seq = c.hub_seq)
        order by c.hub_seq limit ${Math.max(1, Math.floor(limit))};
      insert into hub_chain_marks(origin_id, log_scope_id, origin_seq, event_hash)
        select p.origin_id, p.log_scope_id, p.origin_seq, p.event_hash from temp.hub_pruned p
        where p.origin_seq = (select max(q.origin_seq) from temp.hub_pruned q where q.origin_id = p.origin_id and q.log_scope_id = p.log_scope_id)
        on conflict(origin_id, log_scope_id) do update set origin_seq = excluded.origin_seq, event_hash = excluded.event_hash
          where excluded.origin_seq > hub_chain_marks.origin_seq;
      insert into hub_prune_state(class, hub_seq) select class, max(hub_seq) from temp.hub_pruned group by class
        on conflict(class) do update set hub_seq = max(hub_prune_state.hub_seq, excluded.hub_seq);
      delete from hub_log where hub_seq in (select hub_seq from temp.hub_pruned);
      delete from chat_events where event_id in (select event_id from temp.hub_pruned);
      -- Taken, or no longer below its floor: not looked at again this run.
      delete from hub_retention_candidates where hub_seq in (select hub_seq from temp.hub_pruned)
        or hub_seq > coalesce((select f.floor from temp.hub_class_floors f where f.class = hub_retention_candidates.class), 0);
      commit;
      select count(*) as events, sum(bytes) as bytes from temp.hub_pruned;
    `);
    return { events: Number(rows[0]?.events ?? 0) || 0, bytes: Number(rows[0]?.bytes ?? 0) || 0 };
  }

  /** How long an envelope is, without reading it where sqlite can (3.43+). */
  private async lengthOf(column: string): Promise<string> {
    this.octetLength ??= this.database.query(`select octet_length('x') as n;`).then(() => true, () => false);
    return await this.octetLength ? `octet_length(${column})` : `length(cast(${column} as blob))`;
  }

  private octetLength?: Promise<boolean>;

  /** The newest event of a chain stays: an older version of the hub program
   *  (which knows no marks) continues it from there, and so does a device. */
  private static readonly NOT_CHAIN_HEAD = `e.origin_seq < (select max(n.origin_seq) from chat_events n where n.origin_id = e.origin_id and n.log_scope_id = e.log_scope_id)`;

  /** Folded chat changes every reader has read, older than the cutoff. */
  async collectChatChanges(floor: number, cutoffIso: string, limit: number): Promise<number> {
    return this.collect(`
      select l.hub_seq, l.event_id, e.origin_id, e.log_scope_id, e.origin_seq, e.event_hash, 'chat-changes', ${await this.lengthOf("e.envelope_json")}
      from hub_log l join chat_events e on e.event_id = l.event_id
      join hub_fold_state f on f.conversation_id = l.conversation_id
      where l.hub_seq <= ${Math.floor(floor)} and l.kind = ${quote(CHAT_CHANGES_KIND)} and l.hub_seq <= f.hub_seq and l.accepted_at < ${quote(cutoffIso)}
        and ${HubStorage.NOT_CHAIN_HEAD}
      order by l.hub_seq limit ${Math.max(1, Math.floor(limit))}`);
  }

  /** Chat actions every reader has read, older than the cutoff. */
  async collectChatActions(floor: number, cutoffIso: string, limit: number): Promise<number> {
    return this.collect(`
      select l.hub_seq, l.event_id, e.origin_id, e.log_scope_id, e.origin_seq, e.event_hash, 'chat-actions', ${await this.lengthOf("e.envelope_json")}
      from hub_log l join chat_events e on e.event_id = l.event_id
      where l.hub_seq <= ${Math.floor(floor)} and e.log_scope_id = ${quote(CHAT_ACTIONS_SCOPE)} and l.accepted_at < ${quote(cutoffIso)}
        and ${HubStorage.NOT_CHAIN_HEAD}
      order by l.hub_seq limit ${Math.max(1, Math.floor(limit))}`);
  }

  /** The channels between two devices (`device:<rid>:...`) and who is at
   *  their ends: the machines the roster ever named for each, and whoever
   *  wrote there (the hub learns an older desktop's machine from what it
   *  writes). */
  async pairAuthors(): Promise<Array<{ rendezvousId: string; originId: string }>> {
    await this.init();
    const rows = await this.database.query<{ rendezvousId: string; originId: string }>(`
      select distinct substr(e.log_scope_id, 8, instr(substr(e.log_scope_id, 8), ':') - 1) as rendezvousId, l.origin_id as originId
      from hub_log l join chat_events e on e.event_id = l.event_id
      where e.log_scope_id >= 'device:' and e.log_scope_id < 'device;'
      union
      select rendezvous_id as rendezvousId, device_id as originId from hub_pair_machines;
    `);
    return rows.filter((row) => row.rendezvousId);
  }

  /**
   * Events of the channels between two devices both of them have read: a
   * run's (`terminal:`, `cancel:`, `terminal-ack:` scopes) once its last event
   * is older than `runCutoffIso`, anything else once older than
   * `pairCutoffIso`. `floors` is the lower of the two devices' floors, per
   * channel; a channel not named is kept whole. A chain that goes on (a
   * chat's commands) keeps its newest event; one made for a single run,
   * approval or choice may go whole.
   */
  async collectPairEvents(floors: Map<string, number>, pairCutoffIso: string, runCutoffIso: string, limit: number): Promise<number> {
    if (floors.size === 0) return this.collect("select null, null, null, null, null, null, null, null where 0");
    const values = [...floors].map(([rid, floor]) => `(${quote(rid)}, ${Math.max(0, Math.floor(floor))})`).join(", ");
    const highest = Math.max(...floors.values());
    return this.collect(`
      with pair as (
        select l.hub_seq, l.event_id, l.accepted_at, e.origin_id, e.log_scope_id, e.origin_seq, e.event_hash, ${await this.lengthOf("e.envelope_json")} as bytes,
          substr(e.log_scope_id, 8, instr(substr(e.log_scope_id, 8), ':') - 1) as rid
        from hub_log l join chat_events e on e.event_id = l.event_id
        where l.hub_seq <= ${Math.floor(highest)} and e.log_scope_id >= 'device:' and e.log_scope_id < 'device;'
      ), scoped as (
        select *, case when json_valid(substr(log_scope_id, 9 + length(rid)))
          then json_extract(substr(log_scope_id, 9 + length(rid)), '$[1]') end as inner from pair
      ), keyed as (
        select *, case
          when inner like 'terminal:%' then substr(inner, 10)
          when inner like 'terminal-ack:%' then substr(inner, 14)
          when inner like 'cancel:%' then substr(inner, 8) end as run_id,
          (inner like 'terminal:%' or inner like 'terminal-ack:%' or inner like 'cancel:%' or inner like 'approval:%' or inner like 'choice:%') as single
        from scoped
      ), runs as (
        select run_id, max(accepted_at) as final_at from keyed where run_id is not null group by run_id
      )
      select k.hub_seq, k.event_id, k.origin_id, k.log_scope_id, k.origin_seq, k.event_hash, 'pair:' || k.rid, k.bytes
      from keyed k join temp.hub_pair_floors f on f.rid = k.rid
      left join runs r on r.run_id = k.run_id
      where k.hub_seq <= f.floor and (case when k.run_id is null then k.accepted_at < ${quote(pairCutoffIso)} else r.final_at < ${quote(runCutoffIso)} end)
        and (k.single or k.origin_seq < (select max(n.origin_seq) from chat_events n where n.origin_id = k.origin_id and n.log_scope_id = k.log_scope_id))
      order by k.hub_seq limit ${Math.max(1, Math.floor(limit))}`, `
      create temp table if not exists hub_pair_floors(rid text primary key, floor integer);
      delete from temp.hub_pair_floors;
      insert into temp.hub_pair_floors(rid, floor) values ${values};`);
  }

  /** Where each of these messages of a chat is stored now (undefined: not there). */
  async messageSequences(conversationId: string, messageIds: string[]): Promise<Array<number | undefined>> {
    if (messageIds.length === 0) return [];
    await this.init();
    const rows = await this.database.query<{ messageId: string; sequence: number }>(`
      select message_id as messageId, sequence from conversation_messages
      where conversation_id = ${quote(conversationId)} and message_id in (${messageIds.map(quote).join(", ")});
    `);
    const byId = new Map(rows.map((row) => [row.messageId, Number(row.sequence)]));
    return messageIds.map((id) => byId.get(id));
  }

  /** Rows and bytes the order holds now. */
  async logSize(): Promise<{ events: number; bytes: number }> {
    await this.init();
    const rows = await this.database.query<{ events: number; bytes: number | null }>(`
      select count(*) as events, sum(${await this.lengthOf("e.envelope_json")}) as bytes from hub_log l join chat_events e on e.event_id = l.event_id;
    `);
    return { events: Number(rows[0]?.events ?? 0) || 0, bytes: Number(rows[0]?.bytes ?? 0) || 0 };
  }

  /** Setup only: the desktop that set the hub up. Never replaced afterwards. */
  async setOwner(device: Omit<HubDevice, "role">): Promise<void> {
    await this.init();
    const rows = await this.database.query<{ deviceId: string }>(`select device_id as deviceId from hub_devices where role = 'owner';`);
    if (rows[0] && rows[0].deviceId !== device.deviceId) throw new Error("This hub already belongs to another desktop.");
    if (rows[0]) return;
    await this.database.execute(`
      insert into hub_devices(device_id, public_key, role, name, added_at)
        values (${quote(device.deviceId)}, ${quote(device.publicKeyDerBase64)}, 'owner', ${quote(device.name)}, ${quote(device.addedAt)});
    `);
  }

  async clientState(key: string): Promise<string | undefined> {
    await this.init();
    const rows = await this.database.query<{ value: string }>(`select value from hub_client_state where key = ${quote(key)};`);
    return rows[0]?.value;
  }

  async setClientState(key: string, value: string): Promise<void> {
    await this.init();
    await this.database.execute(`
      insert into hub_client_state(key, value) values (${quote(key)}, ${quote(value)})
      on conflict(key) do update set value = excluded.value;
    `);
  }

  /** This device's own events after a local position, oldest first. */
  async ownEventsAfter(originId: string, afterRowid: number, limit: number, scopePrefixes?: string[]): Promise<Array<{ rowid: number; event: ChatEventEnvelope }>> {
    await this.init();
    // Only the scopes the hub carries: a desktop's own log also holds what it
    // once wrote for other transports (phone mailbox batches), which no hub needs.
    const scopes = scopePrefixes?.length
      ? `and (${scopePrefixes.map((prefix) => `substr(log_scope_id, 1, ${prefix.length}) = ${quote(prefix)}`).join(" or ")})`
      : "";
    // The rowids first, the envelopes after: sorting whole envelopes to keep
    // a hundred of them took seconds on a desktop's real log.
    const rows = await this.database.query<{ rowid: number; envelope: string }>(`
      select rowid, envelope_json as envelope from chat_events
      where rowid in (
        select rowid from chat_events
        where origin_id = ${quote(originId)} and rowid > ${Math.max(0, Math.floor(afterRowid))} ${scopes}
        order by rowid limit ${Math.max(1, Math.min(limit, HUB_STORAGE_PAGE_MAX))}
      )
      order by rowid;
    `);
    return rows.map((row) => ({ rowid: Number(row.rowid), event: JSON.parse(row.envelope) as ChatEventEnvelope }));
  }

  /** The newest of this device's own events, as a local position. */
  async newestOwnRowid(originId: string): Promise<number> {
    await this.init();
    const rows = await this.database.query<{ rowid: number | null }>(`select max(rowid) as rowid from chat_events where origin_id = ${quote(originId)};`);
    return Number(rows[0]?.rowid ?? 0) || 0;
  }

  /** One chain of this device's events from a sequence number, for a hub that reports a gap. */
  async chainFrom(originId: string, logScopeId: string, fromSeq: number, limit: number): Promise<ChatEventEnvelope[]> {
    await this.init();
    const rows = await this.database.query<{ envelope: string }>(`
      select envelope_json as envelope from chat_events
      where origin_id = ${quote(originId)} and log_scope_id = ${quote(logScopeId)} and origin_seq >= ${fromSeq}
      order by origin_seq limit ${Math.max(1, Math.min(limit, HUB_STORAGE_PAGE_MAX))};
    `);
    return rows.map((row) => JSON.parse(row.envelope) as ChatEventEnvelope);
  }

  async holdEvent(held: HubHeldEvent): Promise<void> {
    if (!Number.isSafeInteger(held.hubSeq) || held.hubSeq < 1) throw new Error("Invalid hub position.");
    await this.init();
    // The give-up clock starts when it waits for anything but its author:
    // a place that waited for its author for weeks starts afresh once known.
    const forAuthor = HELD_FOR_AUTHOR_REASONS.map(quote).join(", ");
    await this.database.execute(`
      insert into hub_client_held_events(hub_seq, event_id, origin_id, conversation_id, reason, held_at, due_from)
        values (${held.hubSeq}, ${quote(held.eventId)}, ${quote(held.originId)}, ${quote(held.conversationId)}, ${quote(held.reason)}, ${quote(held.heldAt)}, ${quote(held.heldAt)})
      on conflict(hub_seq) do update set
        due_from = case when hub_client_held_events.reason in (${forAuthor}) and excluded.reason not in (${forAuthor})
          then excluded.held_at else hub_client_held_events.due_from end,
        reason = excluded.reason;
    `);
  }

  /** Held places after `afterSeq`, oldest first. */
  async heldEvents(afterSeq: number, limit: number): Promise<HubHeldEvent[]> {
    await this.init();
    const rows = await this.database.query<HubHeldEvent>(`
      select hub_seq as hubSeq, event_id as eventId, origin_id as originId, conversation_id as conversationId, reason, held_at as heldAt
      from hub_client_held_events where hub_seq > ${Math.max(0, Math.floor(afterSeq))}
      order by hub_seq limit ${Math.max(1, Math.min(limit, HUB_STORAGE_PAGE_MAX))};
    `);
    return rows.map((row) => ({ ...row, hubSeq: Number(row.hubSeq) }));
  }

  /** Whether an earlier change of this author to this chat is held: a later
   *  one waits behind it, so their order holds. */
  async holdsEarlier(originId: string, conversationId: string, hubSeq: number): Promise<boolean> {
    await this.init();
    const rows = await this.database.query<{ held: number }>(`
      select exists(select 1 from hub_client_held_events
        where origin_id = ${quote(originId)} and conversation_id = ${quote(conversationId)} and hub_seq < ${Math.floor(hubSeq)}) as held;
    `);
    return Number(rows[0]?.held) === 1;
  }

  async releaseHeld(hubSeqs: number[]): Promise<void> {
    const seqs = hubSeqs.filter((seq) => Number.isSafeInteger(seq));
    if (seqs.length === 0) return;
    await this.init();
    await this.database.execute(`delete from hub_client_held_events where hub_seq in (${seqs.join(", ")});`);
  }

  /** Another hub (set up again): its positions say nothing about these. */
  async clearHeld(): Promise<void> {
    await this.init();
    await this.database.execute(`delete from hub_client_held_events;`);
  }

  /** What this device holds: its lowest place, since when it holds its
   *  oldest, and how many (the hub keeps everything from the lowest). */
  async heldSummary(): Promise<{ lowest: number; oldestAt?: string; count: number }> {
    await this.init();
    const rows = await this.database.query<{ lowest: number | null; oldestAt: string | null; count: number }>(`
      select min(hub_seq) as lowest, min(held_at) as oldestAt, count(*) as count from hub_client_held_events;
    `);
    const row = rows[0];
    return { lowest: Number(row?.lowest ?? 0) || 0, count: Number(row?.count ?? 0) || 0, ...(row?.oldestAt ? { oldestAt: row.oldestAt } : {}) };
  }

  /**
   * Lets go of places held since before `beforeIso` for any reason but who
   * wrote them (`keepReasons`: those wait for the roster): changes this device
   * could not apply for two weeks. Returns what was given up.
   */
  async heldToGiveUp(beforeIso: string, keepReasons: readonly string[]): Promise<HubHeldEvent[]> {
    await this.init();
    const rows = await this.database.query<HubHeldEvent>(`
      select hub_seq as hubSeq, event_id as eventId, origin_id as originId, conversation_id as conversationId, reason, held_at as heldAt
      from hub_client_held_events
      where coalesce(due_from, held_at) < ${quote(beforeIso)} ${keepReasons.length ? `and reason not in (${keepReasons.map(quote).join(", ")})` : ""}
      order by hub_seq limit ${HUB_STORAGE_PAGE_MAX};
    `);
    return rows.map((row) => ({ ...row, hubSeq: Number(row.hubSeq) }));
  }

  /** Gives up these places and records it, in one transaction: a give-up
   *  is never without its record (which Settings shows). */
  async giveUpHeld(hubSeqs: number[], record: { key: string; value: string }): Promise<void> {
    const seqs = hubSeqs.filter((seq) => Number.isSafeInteger(seq));
    if (seqs.length === 0) return;
    await this.init();
    await this.database.execute(`
      begin immediate;
      insert into hub_client_state(key, value) values (${quote(record.key)}, ${quote(record.value)})
        on conflict(key) do update set value = excluded.value;
      delete from hub_client_held_events where hub_seq in (${seqs.join(", ")});
      commit;
    `);
  }

  /** Authors whose places are held because of who they are (not known yet,
   *  or their channel not set up yet). */
  async heldAuthors(reasons: readonly string[]): Promise<string[]> {
    if (reasons.length === 0) return [];
    await this.init();
    const rows = await this.database.query<{ originId: string }>(`
      select distinct origin_id as originId from hub_client_held_events where reason in (${reasons.map(quote).join(", ")}) limit 200;
    `);
    return rows.map((row) => row.originId);
  }

  /** Lets go of every place held for these authors (the roster says they
   *  were removed: nothing of theirs can be taken any more). */
  async releaseHeldOf(originIds: string[]): Promise<number> {
    if (originIds.length === 0) return 0;
    await this.init();
    const rows = await this.database.query<{ released: number }>(`
      delete from hub_client_held_events where origin_id in (${originIds.map(quote).join(", ")});
      select changes() as released;
    `);
    return Number(rows[0]?.released ?? 0) || 0;
  }

  /** On the hub: a body still being uploaded gets this fragment, replacing
   *  a different one (a complete, verified body is never touched). */
  async replaceBlobFragment(blobHash: string, index: number, byteLength: number, fragments: number): Promise<void> {
    await this.init();
    await this.database.execute(`
      begin immediate;
      delete from device_event_blob_fragments where blob_hash = ${quote(blobHash)} and fragment_index = ${Math.floor(index)};
      update device_event_blobs set byte_length = ${Math.floor(byteLength)}, fragments = ${Math.floor(fragments)} where blob_hash = ${quote(blobHash)};
      commit;
    `);
  }

  /** The hub holds these events now: the devices that read the hub no
   *  longer wait for them, so their outbox rows let go (and retention may
   *  prune them). A device still reached another way (a relay) keeps its row
   *  and is sent the event as before; `hubReaders` names the others, all of
   *  them when undefined. */
  async acknowledgeOutbox(eventIds: string[], at: string, hubReaders?: string[]): Promise<void> {
    if (eventIds.length === 0 || (hubReaders && hubReaders.length === 0)) return;
    await this.init();
    const readers = hubReaders ? `and device_id in (${hubReaders.map(quote).join(", ")})` : "";
    await this.database.execute(`
      update device_event_outbox set acknowledged_at = coalesce(acknowledged_at, ${quote(at)}), outcome = coalesce(outcome, 'applied')
      where event_id in (${eventIds.map(quote).join(", ")}) ${readers};
    `);
  }

  async savePushSubscription(deviceId: string, endpoint: string, subscriptionJson: string, now: string): Promise<void> {
    await this.init();
    await this.database.execute(`
      insert into hub_push_subscriptions(device_id, endpoint, subscription_json, created_at)
        values (${quote(deviceId)}, ${quote(endpoint)}, ${quote(subscriptionJson)}, ${quote(now)})
      on conflict(device_id, endpoint) do update set subscription_json = excluded.subscription_json;
    `);
  }

  async deletePushSubscription(deviceId: string, endpoint: string): Promise<void> {
    await this.init();
    await this.database.execute(`delete from hub_push_subscriptions where device_id = ${quote(deviceId)} and endpoint = ${quote(endpoint)};`);
  }

  async pushSubscriptions(): Promise<Array<{ deviceId: string; endpoint: string }>> {
    await this.init();
    return this.database.query<{ deviceId: string; endpoint: string }>(`select device_id as deviceId, endpoint from hub_push_subscriptions;`);
  }

  async setCursor(deviceId: string, hubSeq: number, now: string): Promise<void> {
    await this.init();
    await this.database.execute(`
      insert into hub_device_cursors(device_id, hub_seq, updated_at) values (${quote(deviceId)}, ${hubSeq}, ${quote(now)})
      on conflict(device_id) do update set hub_seq = excluded.hub_seq, updated_at = excluded.updated_at;
    `);
  }

  async cursor(deviceId: string): Promise<number> {
    await this.init();
    const rows = await this.database.query<{ hubSeq: number }>(`select hub_seq as hubSeq from hub_device_cursors where device_id = ${quote(deviceId)};`);
    return Number(rows[0]?.hubSeq ?? 0) || 0;
  }
}

function quote(value: string): string {
  // The sqlite3 shell reads statements line by line and a NUL ends a line:
  // the rest of the literal would leak into the statement.
  if (value.includes("\u0000")) throw new Error("A value with a NUL character cannot be stored.");
  return `'${value.replace(/'/g, "''")}'`;
}

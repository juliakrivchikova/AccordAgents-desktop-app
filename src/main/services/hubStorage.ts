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
  -- not hold yet). Read again from the hub until taken.
  create table if not exists hub_client_held_events (
    hub_seq integer primary key,
    event_id text not null,
    origin_id text not null,
    conversation_id text not null,
    reason text not null,
    held_at text not null
  );
  create index if not exists hub_client_held_chat on hub_client_held_events(origin_id, conversation_id);
`;

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
          where not exists (select 1 from hub_log where event_id = ${quote(event.eventId)});`).join("")}
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

  async head(): Promise<number> {
    await this.init();
    const rows = await this.database.query<{ head: number | null }>(`select max(hub_seq) as head from hub_log;`);
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
    await this.database.execute(`
      begin immediate;
      delete from hub_devices where role != 'owner';
      ${values.length ? `insert into hub_devices(device_id, public_key, role, name, machine_id, added_at) values ${values.join(", ")};` : ""}
      delete from hub_push_subscriptions where device_id not in (select device_id from hub_devices);
      commit;
    `);
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
    await this.database.execute(`
      insert into hub_client_held_events(hub_seq, event_id, origin_id, conversation_id, reason, held_at)
        values (${held.hubSeq}, ${quote(held.eventId)}, ${quote(held.originId)}, ${quote(held.conversationId)}, ${quote(held.reason)}, ${quote(held.heldAt)})
      on conflict(hub_seq) do update set reason = excluded.reason;
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

  /** Forgets places held since before `beforeIso` (their author is gone). */
  async dropHeldBefore(beforeIso: string): Promise<number> {
    await this.init();
    const rows = await this.database.query<{ dropped: number }>(`
      delete from hub_client_held_events where held_at < ${quote(beforeIso)};
      select changes() as dropped;
    `);
    return Number(rows[0]?.dropped ?? 0) || 0;
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

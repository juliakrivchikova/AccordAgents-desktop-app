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
`;

interface Database {
  init(): Promise<void>;
  query<T>(sql: string): Promise<T[]>;
  execute(sql: string): Promise<void>;
}

/** One pull reads at most this much envelope JSON. */
const PULL_PAGE_BYTES = 4 * 1024 * 1024;

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

  /** Gives an accepted event its place in the order (once; a repeat keeps the first). */
  async log(event: ChatEventEnvelope, acceptedAt: string): Promise<number> {
    await this.init();
    const rows = await this.database.query<{ hubSeq: number }>(`
      insert into hub_log(event_id, origin_id, conversation_id, kind, accepted_at)
        select ${quote(event.eventId)}, ${quote(event.originId)}, ${quote(event.conversationId)}, ${quote(event.kind)}, ${quote(acceptedAt)}
        where not exists (select 1 from hub_log where event_id = ${quote(event.eventId)});
      select hub_seq as hubSeq from hub_log where event_id = ${quote(event.eventId)};
    `);
    const hubSeq = Number(rows[0]?.hubSeq);
    if (!Number.isSafeInteger(hubSeq) || hubSeq < 1) throw new Error("The hub could not place an accepted event.");
    return hubSeq;
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

  /** Events after `afterSeq`, in the hub's order, bounded by count and bytes. */
  async pull(afterSeq: number, limit: number): Promise<HubLoggedEvent[]> {
    await this.init();
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new Error("Invalid hub position.");
    const rows = await this.database.query<{ hubSeq: number; envelope: string }>(`
      with page as (
        select l.hub_seq as hubSeq, e.envelope_json as envelope,
          sum(length(cast(e.envelope_json as blob))) over (order by l.hub_seq) as bytes,
          row_number() over (order by l.hub_seq) as ordinal
        from hub_log l join chat_events e on e.event_id = l.event_id
        where l.hub_seq > ${afterSeq}
        order by l.hub_seq limit ${Math.max(1, Math.min(limit, 1000))}
      ) select hubSeq, envelope from page where bytes <= ${PULL_PAGE_BYTES} or ordinal = 1 order by hubSeq;
    `);
    return rows.map((row) => ({ hubSeq: Number(row.hubSeq), event: JSON.parse(row.envelope) as ChatEventEnvelope }));
  }

  /** Accepted events of one chat after a position, for folding. */
  async conversationEvents(conversationId: string, afterSeq: number, limit: number): Promise<HubLoggedEvent[]> {
    await this.init();
    const rows = await this.database.query<{ hubSeq: number; envelope: string }>(`
      select l.hub_seq as hubSeq, e.envelope_json as envelope
      from hub_log l join chat_events e on e.event_id = l.event_id
      where l.conversation_id = ${quote(conversationId)} and l.hub_seq > ${afterSeq}
      order by l.hub_seq limit ${Math.max(1, Math.min(limit, 1000))};
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

  /** Chats with accepted events not yet folded. */
  async unfoldedConversations(): Promise<string[]> {
    await this.init();
    const rows = await this.database.query<{ conversationId: string }>(`
      select l.conversation_id as conversationId from hub_log l
      left join hub_fold_state f on f.conversation_id = l.conversation_id
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
    const values = devices.filter((device) => device.role !== "owner").map((device) =>
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
    const rows = await this.database.query<{ rowid: number; envelope: string }>(`
      select rowid, envelope_json as envelope from chat_events
      where origin_id = ${quote(originId)} and rowid > ${afterRowid} ${scopes}
      order by rowid limit ${Math.max(1, Math.min(limit, 500))};
    `);
    return rows.map((row) => ({ rowid: Number(row.rowid), event: JSON.parse(row.envelope) as ChatEventEnvelope }));
  }

  /** One chain of this device's events from a sequence number, for a hub that reports a gap. */
  async chainFrom(originId: string, logScopeId: string, fromSeq: number, limit: number): Promise<ChatEventEnvelope[]> {
    await this.init();
    const rows = await this.database.query<{ envelope: string }>(`
      select envelope_json as envelope from chat_events
      where origin_id = ${quote(originId)} and log_scope_id = ${quote(logScopeId)} and origin_seq >= ${fromSeq}
      order by origin_seq limit ${Math.max(1, Math.min(limit, 500))};
    `);
    return rows.map((row) => JSON.parse(row.envelope) as ChatEventEnvelope);
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
      on conflict(device_id) do update set hub_seq = max(hub_seq, excluded.hub_seq), updated_at = excluded.updated_at;
    `);
  }

  async cursor(deviceId: string): Promise<number> {
    await this.init();
    const rows = await this.database.query<{ hubSeq: number }>(`select hub_seq as hubSeq from hub_device_cursors where device_id = ${quote(deviceId)};`);
    return Number(rows[0]?.hubSeq ?? 0) || 0;
  }
}

function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

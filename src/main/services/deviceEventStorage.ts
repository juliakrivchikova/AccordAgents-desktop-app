import type { ChatEventEnvelope } from "../../shared/chatEvents";
import {
  DEVICE_EVENT_PAGE_BYTES,
  DEVICE_EVENT_PAGE_COUNT,
  type DeviceEventAppendOptions,
  type DeviceEventApplyOutcome,
  type DeviceEventDelivery,
  type DeviceEventGap,
  type DeviceEventReceipt
} from "../../shared/deviceEventDelivery";

export const DEVICE_EVENT_SCHEMA_SQL = `
  create table if not exists device_replica_copies (
    channel_id text not null,
    conversation_id text not null,
    syncing integer not null check(syncing in (0, 1)),
    primary key(channel_id, conversation_id)
  );
  create table if not exists device_replica_inventory (
    channel_id text not null,
    conversation_id text not null,
    message_id text not null,
    stamp text not null,
    primary key(channel_id, conversation_id, message_id)
  );
  create table if not exists device_event_mailbox_cursors (
    channel_id text not null,
    reader_id text not null,
    epoch text not null,
    arrival_seq integer not null,
    primary key(channel_id, reader_id)
  );
  create table if not exists device_event_outbox (
    event_id text not null references chat_events(event_id),
    device_id text not null,
    channel_id text not null,
    delivered_at text,
    acknowledged_at text,
    outcome text check(outcome in ('applied', 'superseded')),
    primary key(event_id, device_id)
  );
  create index if not exists idx_device_event_outbox_pending
    on device_event_outbox(channel_id, device_id, acknowledged_at);
  create table if not exists device_event_inbox (
    event_id text primary key references chat_events(event_id),
    device_id text not null,
    channel_id text not null,
    applied_at text,
    ack_delivered_at text,
    outcome text check(outcome in ('applied', 'superseded'))
  );
  create index if not exists idx_device_event_inbox_pending
    on device_event_inbox(channel_id, applied_at);
  create table if not exists device_event_applied_heads (
    origin_id text not null,
    log_scope_id text not null,
    origin_seq integer not null,
    event_hash text not null,
    primary key(origin_id, log_scope_id)
  );
`;

/** Runs inside appendChatEvents' FULL-sync transaction. Matching the complete
 * accepted envelope is intentional: an id collision must not enqueue a rejected
 * variant or give it a receive receipt. The outbox references the log, not a
 * second conversation-sized JSON copy. */
export function deviceEventAppendSql(events: ChatEventEnvelope[], options: DeviceEventAppendOptions): string {
  if (!options.ingress && !options.recipients?.length) return "";
  for (const recipient of [...(options.recipients ?? []), ...(options.ingress ? [options.ingress] : [])]) {
    if (!recipient.deviceId?.trim() || !recipient.channelId?.trim()) {
      throw new Error("Device event delivery requires a device and channel identity.");
    }
  }
  return events.map((event) => {
    const accepted = `from chat_events where event_id = ${quote(event.eventId)} and envelope_json = ${quote(JSON.stringify(event))}`;
    const destinations = (options.recipients ?? []).map((recipient) => `
      insert or ignore into device_event_outbox(event_id, device_id, channel_id)
      select event_id, ${quote(recipient.deviceId)}, ${quote(recipient.channelId)} ${accepted};
    `).join("\n");
    const ingress = options.ingress;
    return destinations + (ingress ? `
      insert or ignore into device_event_inbox(event_id, device_id, channel_id)
      select event_id, ${quote(ingress.deviceId)}, ${quote(ingress.channelId)} ${accepted};
    ` : "");
  }).join("\n");
}

interface Database {
  init(): Promise<void>;
  query<T>(sql: string): Promise<T[]>;
  execute(sql: string): Promise<void>;
}

export class DeviceEventStorage {
  constructor(private readonly database: Database) {}

  async replicaState(channelId: string): Promise<Array<{ conversationId: string; syncing: boolean; messages: Map<string, string> }>> {
    await this.database.init();
    const copies = await this.database.query<{ conversationId: string; syncing: number }>(`
      select conversation_id as conversationId, syncing from device_replica_copies where channel_id = ${quote(channelId)};
    `);
    const states = new Map(copies.map((copy) => [copy.conversationId, { ...copy, syncing: copy.syncing === 1, messages: new Map<string, string>() }]));
    let cursor = 0;
    for (;;) {
      const rows = await this.database.query<{ rowId: number; conversationId: string; messageId: string; stamp: string }>(`
        select rowid as rowId, conversation_id as conversationId, message_id as messageId, stamp
        from device_replica_inventory where channel_id = ${quote(channelId)} and rowid > ${cursor} order by rowid limit 500;
      `);
      if (!rows.length) break;
      for (const row of rows) {
        const state = states.get(row.conversationId) ?? { conversationId: row.conversationId, syncing: false, messages: new Map<string, string>() };
        state.messages.set(row.messageId, row.stamp);
        states.set(row.conversationId, state);
        cursor = row.rowId;
      }
    }
    return [...states.values()];
  }

  /** A replica's inventory is domain state, not socket state. Persist only
   * touched ids after the chat write, before acknowledging its event. */
  async saveReplicaState(channelId: string, conversationId: string, changes: { stamps?: Map<string, string>; removedIds?: string[]; syncing?: boolean }): Promise<void> {
    await this.database.init();
    const predicate = `channel_id = ${quote(channelId)} and conversation_id = ${quote(conversationId)}`;
    await this.database.execute(durable(`begin immediate;
      ${changes.syncing === undefined ? "" : `insert into device_replica_copies(channel_id, conversation_id, syncing)
        values (${quote(channelId)}, ${quote(conversationId)}, ${changes.syncing ? 1 : 0})
        on conflict(channel_id, conversation_id) do update set syncing = excluded.syncing;`}
      ${[...(changes.stamps ?? [])].map(([id, stamp]) => `insert into device_replica_inventory(channel_id, conversation_id, message_id, stamp)
        values (${quote(channelId)}, ${quote(conversationId)}, ${quote(id)}, ${quote(stamp)})
        on conflict(channel_id, conversation_id, message_id) do update set stamp = excluded.stamp;`).join("\n")}
      ${(changes.removedIds ?? []).map((id) => `delete from device_replica_inventory where ${predicate} and message_id = ${quote(id)};`).join("\n")}
      commit;
    `));
  }

  async hostMachineId(channelId: string): Promise<string | undefined> {
    await this.database.init();
    return (await this.database.query<{ value: string }>(
      `select value from schema_meta where key = ${quote(`device-channel-home:${channelId}`)};`
    ))[0]?.value;
  }

  async saveHostMachineId(channelId: string, machineId: string): Promise<void> {
    if (!machineId.trim()) throw new Error("A home machine requires an identity.");
    await this.database.init();
    await this.database.execute(durable(`
      insert into schema_meta(key, value) values (${quote(`device-channel-home:${channelId}`)}, ${quote(machineId)})
      on conflict(key) do update set value = case when value = excluded.value then value else null end;
    `));
  }

  async mailboxCursor(channelId: string, readerId: string): Promise<{ epoch: string; arrivalSeq: number }> {
    await this.database.init();
    return (await this.database.query<{ epoch: string; arrivalSeq: number }>(`
      select epoch, arrival_seq as arrivalSeq from device_event_mailbox_cursors
      where channel_id = ${quote(channelId)} and reader_id = ${quote(readerId)};
    `))[0] ?? { epoch: "", arrivalSeq: 0 };
  }

  async saveMailboxCursor(channelId: string, readerId: string, cursor: { epoch: string; arrivalSeq: number }): Promise<void> {
    requireCursor(cursor.arrivalSeq);
    await this.database.init();
    await this.database.execute(durable(`
      insert into device_event_mailbox_cursors(channel_id, reader_id, epoch, arrival_seq)
        values (${quote(channelId)}, ${quote(readerId)}, ${quote(cursor.epoch)}, ${cursor.arrivalSeq})
      on conflict(channel_id, reader_id) do update set epoch = excluded.epoch,
        arrival_seq = case when epoch = excluded.epoch then max(arrival_seq, excluded.arrival_seq) else excluded.arrival_seq end;
    `));
  }

  /** Include a cursor when draining: an offline first peer or a missing ACK must
   * not starve later events. A new retry pass starts without a cursor. */
  async listPending(channelId: string, afterRowId = 0, deviceId?: string): Promise<Array<DeviceEventDelivery & { rowId: number }>> {
    await this.database.init();
    requireCursor(afterRowId);
    const rows = await this.database.query<{
      rowId: number; envelope: string; deviceId: string; channelId: string; deliveredAt: string | null;
    }>(`
      with candidates as (
        select o.rowid as rowId, e.envelope_json as envelope, o.device_id as deviceId,
          o.channel_id as channelId, o.delivered_at as deliveredAt
        from device_event_outbox o join chat_events e on e.event_id = o.event_id
        where o.channel_id = ${quote(channelId)} and o.acknowledged_at is null and o.rowid > ${afterRowId}
          ${deviceId ? `and o.device_id = ${quote(deviceId)}` : ""}
        order by o.rowid limit ${DEVICE_EVENT_PAGE_COUNT}
      ), page as (
        select *, sum(length(cast(envelope as blob))) over (order by rowId) as bytes,
          row_number() over (order by rowId) as ordinal from candidates
      ) select rowId, envelope, deviceId, channelId, deliveredAt from page
        where bytes <= ${DEVICE_EVENT_PAGE_BYTES} or ordinal = 1 order by rowId;
    `);
    return rows.map((row) => ({
      rowId: row.rowId,
      event: JSON.parse(row.envelope) as ChatEventEnvelope,
      recipient: { deviceId: row.deviceId, channelId: row.channelId },
      ...(row.deliveredAt ? { deliveredAt: row.deliveredAt } : {})
    }));
  }

  /** Only a mailbox success calls this; WebSocket write success is not delivery. */
  async markDelivered(eventId: string, eventHash: string, deviceId: string, at: string): Promise<void> {
    await this.database.init();
    await this.database.execute(durable(`
      update device_event_outbox set delivered_at = coalesce(delivered_at, ${quote(at)})
      where event_id = ${quote(eventId)} and device_id = ${quote(deviceId)}
        and exists(select 1 from chat_events e where e.event_id = device_event_outbox.event_id and e.event_hash = ${quote(eventHash)});
    `));
  }

  async acknowledge(deviceId: string, receipt: DeviceEventReceipt): Promise<boolean> {
    requireOutcome(receipt.outcome);
    await this.database.init();
    const rows = await this.database.query<{ eventId: string }>(durable(`
      update device_event_outbox set acknowledged_at = coalesce(acknowledged_at, ${quote(receipt.appliedAt)}),
        outcome = coalesce(outcome, ${quote(receipt.outcome)})
      where event_id = ${quote(receipt.eventId)} and device_id = ${quote(deviceId)}
        and exists(select 1 from chat_events e where e.event_id = device_event_outbox.event_id and e.event_hash = ${quote(receipt.eventHash)})
      returning event_id as eventId;
    `));
    return rows.length === 1;
  }

  async receipt(eventId: string): Promise<DeviceEventReceipt | undefined> {
    await this.database.init();
    return (await this.database.query<DeviceEventReceipt>(`
      select i.event_id as eventId, e.event_hash as eventHash, i.outcome, i.applied_at as appliedAt
      from device_event_inbox i join chat_events e on e.event_id = i.event_id
      where i.event_id = ${quote(eventId)} and i.applied_at is not null;
    `))[0];
  }

  async pendingReceipts(channelId: string, deviceId: string): Promise<DeviceEventReceipt[]> {
    await this.database.init();
    return this.database.query<DeviceEventReceipt>(`
      select i.event_id as eventId, e.event_hash as eventHash, i.outcome, i.applied_at as appliedAt
      from device_event_inbox i join chat_events e on e.event_id = i.event_id
      where i.channel_id = ${quote(channelId)} and i.device_id = ${quote(deviceId)}
        and i.applied_at is not null and i.ack_delivered_at is null order by i.rowid limit ${DEVICE_EVENT_PAGE_COUNT};
    `);
  }

  async markReceiptDelivered(channelId: string, deviceId: string, receipt: DeviceEventReceipt): Promise<void> {
    await this.database.init();
    await this.database.execute(durable(`update device_event_inbox set ack_delivered_at = coalesce(ack_delivered_at, ${quote(new Date().toISOString())})
      where channel_id = ${quote(channelId)} and device_id = ${quote(deviceId)} and event_id = ${quote(receipt.eventId)}
        and applied_at = ${quote(receipt.appliedAt)} and outcome = ${quote(receipt.outcome)}
        and exists(select 1 from chat_events e where e.event_id = device_event_inbox.event_id and e.event_hash = ${quote(receipt.eventHash)});
    `));
  }

  async retainReceiptForRedelivery(eventId: string): Promise<void> {
    await this.database.init();
    await this.database.execute(durable(`update device_event_inbox set ack_delivered_at = null
      where event_id = ${quote(eventId)} and applied_at is not null and ack_delivered_at is not null;`));
  }

  /** At most the next contiguous event of each origin/scope. Different origins
   * can progress independently; a received-but-unapplied gap never gets an ACK. */
  async ready(channelId: string, deviceId?: string, excludedEventIds: string[] = []): Promise<ChatEventEnvelope[]> {
    await this.database.init();
    const rows = await this.database.query<{ envelope: string }>(`
      with candidates as (
        select e.envelope_json as envelope, e.logical_ts, e.origin_id, e.log_scope_id, e.origin_seq, e.event_id
        from device_event_inbox i join chat_events e on e.event_id = i.event_id
        left join device_event_applied_heads h on h.origin_id = e.origin_id and h.log_scope_id = e.log_scope_id
        where i.channel_id = ${quote(channelId)} and i.applied_at is null
          ${deviceId ? `and i.device_id = ${quote(deviceId)}` : ""}
          ${excludedEventIds.length ? `and e.event_id not in (${excludedEventIds.map(quote).join(",")})` : ""}
          and e.origin_seq = coalesce(h.origin_seq, 0) + 1
          and coalesce(e.prev_hash, '') = coalesce(h.event_hash, '')
        order by e.logical_ts, e.origin_id, e.log_scope_id, e.origin_seq, e.event_id limit ${DEVICE_EVENT_PAGE_COUNT}
      ), page as (
        select envelope,
          sum(length(cast(envelope as blob))) over (order by logical_ts, origin_id, log_scope_id, origin_seq, event_id) as bytes,
          row_number() over (order by logical_ts, origin_id, log_scope_id, origin_seq, event_id) as ordinal from candidates
      ) select envelope from page where bytes <= ${DEVICE_EVENT_PAGE_BYTES} or ordinal = 1 order by ordinal;
    `);
    return rows.map((row) => JSON.parse(row.envelope) as ChatEventEnvelope);
  }

  /** Called only after the domain owner has persisted its projection (or native
   * command receipt). The head and applied receipt commit together before ACK.
   * Retrying after a crash uses the same event id; domain actions must therefore
   * be idempotent, and native side effects need their own durable claim. */
  async markApplied(event: ChatEventEnvelope, outcome: DeviceEventApplyOutcome, at: string): Promise<DeviceEventReceipt> {
    requireOutcome(outcome);
    await this.database.init();
    const rows = await this.database.query<DeviceEventReceipt>(durable(`
      begin immediate;
      insert into device_event_applied_heads(origin_id, log_scope_id, origin_seq, event_hash)
        select e.origin_id, e.log_scope_id, e.origin_seq, e.event_hash
        from chat_events e join device_event_inbox i on i.event_id = e.event_id
        left join device_event_applied_heads h on h.origin_id = e.origin_id and h.log_scope_id = e.log_scope_id
        where e.event_id = ${quote(event.eventId)} and e.event_hash = ${quote(event.eventHash)}
          and i.applied_at is null and e.origin_seq = coalesce(h.origin_seq, 0) + 1
          and coalesce(e.prev_hash, '') = coalesce(h.event_hash, '')
      on conflict(origin_id, log_scope_id) do update set origin_seq = excluded.origin_seq, event_hash = excluded.event_hash;
      update device_event_inbox set applied_at = ${quote(at)}, outcome = ${quote(outcome)}
        where event_id = ${quote(event.eventId)} and applied_at is null and exists(
          select 1 from chat_events e join device_event_applied_heads h
            on h.origin_id = e.origin_id and h.log_scope_id = e.log_scope_id
          where e.event_id = device_event_inbox.event_id and e.event_hash = ${quote(event.eventHash)}
            and h.origin_seq = e.origin_seq and h.event_hash = e.event_hash
        );
      select i.event_id as eventId, e.event_hash as eventHash, i.outcome, i.applied_at as appliedAt
        from device_event_inbox i join chat_events e on e.event_id = i.event_id
        where i.event_id = ${quote(event.eventId)} and e.event_hash = ${quote(event.eventHash)} and i.applied_at is not null;
      commit;
    `));
    if (!rows[0]) {
      throw new Error(`Device event ${event.eventId} is not the next contiguous event.`);
    }
    return rows[0];
  }

  async gaps(channelId: string, deviceId?: string): Promise<DeviceEventGap[]> {
    await this.database.init();
    return this.database.query<DeviceEventGap>(`
      select e.origin_id as originId, e.log_scope_id as logScopeId,
        coalesce(h.origin_seq, 0) + 1 as fromSeq, min(e.origin_seq) - 1 as toSeq
      from device_event_inbox i join chat_events e on e.event_id = i.event_id
      left join device_event_applied_heads h on h.origin_id = e.origin_id and h.log_scope_id = e.log_scope_id
      where i.channel_id = ${quote(channelId)} and i.applied_at is null
        ${deviceId ? `and i.device_id = ${quote(deviceId)}` : ""}
      group by e.origin_id, e.log_scope_id
      having min(e.origin_seq) > coalesce(h.origin_seq, 0) + 1 limit ${DEVICE_EVENT_PAGE_COUNT};
    `);
  }

  /** Logical queued bytes across recipient deliveries, including referenced
   * bodies. Physical blob storage is shared; this is not a database file size. */
  async pressure(channelId: string): Promise<{ events: number; bytes: number; recipients: number }> {
    await this.database.init();
    return (await this.database.query<{ events: number; bytes: number; recipients: number }>(`
      select count(distinct e.event_id) as events,
        coalesce(sum(length(cast(e.envelope_json as blob)) + coalesce(b.byte_length, 0)), 0) as bytes,
        count(distinct o.device_id) as recipients
      from device_event_outbox o join chat_events e on e.event_id = o.event_id
      left join device_event_blobs b on json_extract(e.payload_json, '$.type') = 'device.event.blob'
        and b.blob_hash = json_extract(e.payload_json, '$.blobHash')
      where o.channel_id = ${quote(channelId)} and o.acknowledged_at is null;
    `))[0];
  }

  /** Repair only history this peer was already a recipient of, including ACKed
   * events after mailbox expiry. A repair request is not an access grant. */
  async repair(channelId: string, deviceId: string, gap: DeviceEventGap): Promise<ChatEventEnvelope[]> {
    requireCursor(gap.fromSeq);
    requireCursor(gap.toSeq);
    if (gap.fromSeq < 1 || gap.toSeq < gap.fromSeq) throw new Error("Invalid device event repair range.");
    await this.database.init();
    const rows = await this.database.query<{ envelope: string }>(`
      with candidates as (
      select e.envelope_json as envelope, e.origin_seq from device_event_outbox o join chat_events e on e.event_id = o.event_id
      where o.channel_id = ${quote(channelId)} and o.device_id = ${quote(deviceId)}
        and e.origin_id = ${quote(gap.originId)} and e.log_scope_id = ${quote(gap.logScopeId)}
        and e.origin_seq between ${gap.fromSeq} and ${Math.min(gap.toSeq, gap.fromSeq + DEVICE_EVENT_PAGE_COUNT - 1)}
      order by e.origin_seq
      ), page as (
        select envelope, sum(length(cast(envelope as blob))) over (order by origin_seq) as bytes,
          row_number() over (order by origin_seq) as ordinal from candidates
      ) select envelope from page where bytes <= ${DEVICE_EVENT_PAGE_BYTES} or ordinal = 1 order by ordinal;
    `);
    return rows.map((row) => JSON.parse(row.envelope) as ChatEventEnvelope);
  }
}

function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function durable(sql: string): string {
  return `pragma synchronous = full; pragma fullfsync = on; ${sql}`;
}

function requireOutcome(outcome: string): asserts outcome is DeviceEventApplyOutcome {
  if (outcome !== "applied" && outcome !== "superseded") {
    throw new Error("Invalid device event apply outcome.");
  }
}

function requireCursor(cursor: number): void {
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new Error("Invalid device event page cursor.");
  }
}

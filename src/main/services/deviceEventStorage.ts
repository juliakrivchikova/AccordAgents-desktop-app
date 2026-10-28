import { CHAT_ACTION_LOG_SCOPE } from "../../shared/chatActionEvents";
import { isChatChangesLogScope } from "./chatChanges";
import type { ChatEventEnvelope } from "../../shared/chatEvents";
import { decideChatEventRetention, type ChatEventRetentionDecision } from "../../shared/chatEventRetention";
import {
  DEVICE_EVENT_HEADER_PAGE_COUNT,
  DEVICE_EVENT_PAGE_BYTES,
  DEVICE_EVENT_PAGE_COUNT,
  type DeviceEventAppendOptions,
  type DeviceEventApplyOutcome,
  type DeviceEventDelivery,
  type DeviceEventGap,
  type DeviceEventPendingHeader,
  type DeviceEventReceipt,
  type DeviceEventRecipient
} from "../../shared/deviceEventDelivery";

export const DEVICE_EVENT_SCHEMA_SQL = `
  -- The copy-and-diff replication that used these is retired (chats travel as
  -- chat change events). They stay for an older version opening this file.
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
  -- Where each relay mailbox was read to, from before the relay was removed.
  drop table if exists device_event_mailbox_cursors;
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

  /** Include a cursor when draining: an offline first peer or a missing ACK must
   * not starve later events. A new retry pass starts without a cursor. */
  /** `excludeKinds`: events kept for the peer but not sent to it yet. They
   *  are left out here rather than read and skipped on every pass. */
  async listPending(channelId: string, afterRowId = 0, deviceId?: string, options: { excludeKinds?: readonly string[] } = {}): Promise<Array<DeviceEventDelivery & { rowId: number }>> {
    await this.database.init();
    requireCursor(afterRowId);
    const excluded = (options.excludeKinds ?? []).filter((kind) => typeof kind === "string" && kind.length > 0);
    const rows = await this.database.query<{
      rowId: number; envelope: string; deviceId: string; channelId: string; deliveredAt: string | null;
    }>(`
      with candidates as (
        select o.rowid as rowId, e.envelope_json as envelope, o.device_id as deviceId,
          o.channel_id as channelId, o.delivered_at as deliveredAt
        from device_event_outbox o join chat_events e on e.event_id = o.event_id
        where o.channel_id = ${quote(channelId)} and o.acknowledged_at is null and o.rowid > ${afterRowId}
          ${deviceId ? `and o.device_id = ${quote(deviceId)}` : ""}
          ${excluded.length ? `and e.kind not in (${excluded.map(quote).join(", ")})` : ""}
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

  /**
   * The same pending outbox as `listPending`, as identities only. A retry pass
   * reads these and loads the envelope of an event only when it is due again.
   * An unreachable peer lets the outbox grow into the hundreds, and re-reading
   * every retained envelope on each five-second pass kept the one database
   * connection busy for everything else the User did.
   */
  async listPendingHeaders(channelId: string, afterRowId = 0, deviceId?: string, options: { excludeKinds?: readonly string[] } = {}): Promise<DeviceEventPendingHeader[]> {
    await this.database.init();
    requireCursor(afterRowId);
    const excluded = (options.excludeKinds ?? []).filter((kind) => typeof kind === "string" && kind.length > 0);
    return this.database.query<DeviceEventPendingHeader>(`
      select o.rowid as rowId, e.event_id as eventId, e.event_hash as eventHash, e.origin_id as originId,
        e.origin_seq as originSeq, e.log_scope_id as logScopeId, o.delivered_at as deliveredAt
      from device_event_outbox o join chat_events e on e.event_id = o.event_id
      where o.channel_id = ${quote(channelId)} and o.acknowledged_at is null and o.rowid > ${afterRowId}
        ${deviceId ? `and o.device_id = ${quote(deviceId)}` : ""}
        ${excluded.length ? `and e.kind not in (${excluded.map(quote).join(", ")})` : ""}
      order by o.rowid limit ${DEVICE_EVENT_HEADER_PAGE_COUNT};
    `);
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
          and (e.log_scope_id = ${quote(CHAT_ACTION_LOG_SCOPE)} or (e.origin_seq = coalesce(h.origin_seq, 0) + 1
            and coalesce(e.prev_hash, '') = coalesce(h.event_hash, '')))
        order by e.logical_ts, e.origin_id, e.log_scope_id, e.origin_seq, e.event_id limit ${DEVICE_EVENT_PAGE_COUNT}
      ), page as (
        select envelope,
          sum(length(cast(envelope as blob))) over (order by logical_ts, origin_id, log_scope_id, origin_seq, event_id) as bytes,
          row_number() over (order by logical_ts, origin_id, log_scope_id, origin_seq, event_id) as ordinal from candidates
      ) select envelope from page where bytes <= ${DEVICE_EVENT_PAGE_BYTES} or ordinal = 1 order by ordinal;
    `);
    return rows.map((row) => JSON.parse(row.envelope) as ChatEventEnvelope);
  }


  /**
   * The chat-action log is folded, not replayed: supersede and duplicate are
   * decided from the actions themselves, so one held action must not stop the
   * ones behind it. In particular the answer to "I am missing this revision"
   * necessarily arrives after the action that asked for it.
   *
   * The head therefore records the furthest action seen rather than a
   * contiguous position, and each action is marked applied on its own.
   */
  private async markActionApplied(event: ChatEventEnvelope, outcome: DeviceEventApplyOutcome, at: string): Promise<DeviceEventReceipt> {
    const rows = await this.database.query<DeviceEventReceipt>(durable(`
      begin immediate;
      insert into device_event_applied_heads(origin_id, log_scope_id, origin_seq, event_hash)
        select e.origin_id, e.log_scope_id, e.origin_seq, e.event_hash
        from chat_events e join device_event_inbox i on i.event_id = e.event_id
        where e.event_id = ${quote(event.eventId)} and e.event_hash = ${quote(event.eventHash)} and i.applied_at is null
      on conflict(origin_id, log_scope_id) do update
        set event_hash = case when excluded.origin_seq > device_event_applied_heads.origin_seq
              then excluded.event_hash else device_event_applied_heads.event_hash end,
            origin_seq = max(excluded.origin_seq, device_event_applied_heads.origin_seq);
      update device_event_inbox set applied_at = ${quote(at)}, outcome = ${quote(outcome)}
        where event_id = ${quote(event.eventId)} and applied_at is null and exists(
          select 1 from chat_events e where e.event_id = device_event_inbox.event_id and e.event_hash = ${quote(event.eventHash)}
        );
      select i.event_id as eventId, e.event_hash as eventHash, i.outcome, i.applied_at as appliedAt
        from device_event_inbox i join chat_events e on e.event_id = i.event_id
        where i.event_id = ${quote(event.eventId)} and e.event_hash = ${quote(event.eventHash)} and i.applied_at is not null;
      commit;
    `));
    if (!rows[0]) throw new Error(`Chat action ${event.eventId} could not be recorded as applied.`);
    return rows[0];
  }

  /** Called only after the domain owner has persisted its projection (or native
   * command receipt). The head and applied receipt commit together before ACK.
   * Retrying after a crash uses the same event id; domain actions must therefore
   * be idempotent, and native side effects need their own durable claim. */
  async markApplied(event: ChatEventEnvelope, outcome: DeviceEventApplyOutcome, at: string): Promise<DeviceEventReceipt> {
    requireOutcome(outcome);
    await this.database.init();
    if (event.logScopeId === CHAT_ACTION_LOG_SCOPE) return this.markActionApplied(event, outcome, at);
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

  /** The last contiguous event of one origin and scope this device applied (0 when none). */
  async appliedHead(originId: string, logScopeId: string): Promise<number> {
    await this.database.init();
    const rows = await this.database.query<{ originSeq: number }>(`
      select origin_seq as originSeq from device_event_applied_heads
      where origin_id = ${quote(originId)} and log_scope_id = ${quote(logScopeId)};
    `);
    return rows[0]?.originSeq ?? 0;
  }

  /**
   * Chat change events that a chat copy already contained.
   *
   * The copy moved this device's position in their log past them, so they can
   * never be the next event and would wait unapplied for ever, holding the
   * sender's outbox with them. They are recorded as applied without being
   * applied again: an older change put over the copy could take a message back
   * to an earlier text. Returns the receipts to acknowledge.
   */
  async settleCovered(channelId: string, deviceId: string | undefined, at: string): Promise<DeviceEventReceipt[]> {
    await this.database.init();
    const inbound = `i.channel_id = ${quote(channelId)} ${deviceId ? `and i.device_id = ${quote(deviceId)}` : ""}`;
    const covered = `substr(e.log_scope_id, 1, 13) = 'chat-changes:' and e.origin_seq <= (
      select h.origin_seq from device_event_applied_heads h where h.origin_id = e.origin_id and h.log_scope_id = e.log_scope_id)`;
    return this.database.query<DeviceEventReceipt>(durable(`
      begin immediate;
      update device_event_inbox set applied_at = ${quote(at)}, outcome = 'applied' where event_id in (
        select i.event_id from device_event_inbox i join chat_events e on e.event_id = i.event_id
        where ${inbound} and i.applied_at is null and ${covered} limit ${DEVICE_EVENT_PAGE_COUNT});
      select i.event_id as eventId, e.event_hash as eventHash, i.outcome, i.applied_at as appliedAt
        from device_event_inbox i join chat_events e on e.event_id = i.event_id
        where ${inbound} and i.applied_at = ${quote(at)} and ${covered};
      commit;
    `));
  }

  /**
   * Gives `to` every chat change of `originId` this device holds beyond the
   * given marks (all of them in a chat without a mark). Delivery rows only:
   * the events themselves are the author's, unchanged.
   */
  async shareChatChangesAfter(originId: string, marks: Array<{ logScopeId: string; originSeq: number }>, to: DeviceEventRecipient): Promise<number> {
    if (!to.deviceId.trim() || !to.channelId.trim()) throw new Error("Device event delivery requires a device and channel identity.");
    await this.database.init();
    const known = marks.filter((mark) => isChatChangesLogScope(mark.logScopeId) && Number.isSafeInteger(mark.originSeq));
    const values = known.length
      ? known.map((mark) => `(${quote(mark.logScopeId)}, ${Math.floor(mark.originSeq)})`).join(", ")
      : "(null, 0)";
    const rows = await this.database.query<{ eventId: string }>(durable(`
      with marks(log_scope_id, origin_seq) as (values ${values})
      insert or ignore into device_event_outbox(event_id, device_id, channel_id)
        select e.event_id, ${quote(to.deviceId)}, ${quote(to.channelId)} from chat_events e
        left join marks m on m.log_scope_id = e.log_scope_id
        where e.origin_id = ${quote(originId)} and e.log_scope_id >= 'chat-changes:' and e.log_scope_id < 'chat-changes;'
          and e.origin_seq > coalesce(m.origin_seq, 0)
      returning event_id as eventId;
    `));
    return rows.length;
  }

  /**
   * Forgets chat change events every recipient has confirmed.
   *
   * A chat change only carries a chat's content from one device to another;
   * once every device it was meant for has it, and this device applied it (if
   * it came from elsewhere), it has no reader left. A device that needs those
   * chats later gets them from a copy, not from old events.
   *
   * Kept: the newest event of each chat and author, because the next event
   * continues its sequence; anything not yet confirmed or applied; and the
   * last `graceMs` of events, for a copy being taken at this moment. With the
   * User's hub, this device's own events past `keepOwnAfterRowid` have not
   * reached it yet and are kept too, confirmed or not. A body
   * stored separately goes with its event unless another kept event of that
   * chat still points to the same bytes.
   */
  async pruneConfirmedChatChanges(localOriginId: string, cutoffIso: string, options: { limit?: number; keepOwnAfterRowid?: number } = {}): Promise<{ events: number; blobs: number }> {
    const limit = options.limit ?? 2_000;
    const keepOwnAfterRowid = options.keepOwnAfterRowid;
    const unpushed = keepOwnAfterRowid === undefined ? ""
      : `and not (e.origin_id = ${quote(localOriginId)} and e.rowid > ${Math.max(0, Math.floor(keepOwnAfterRowid))})`;
    await this.database.init();
    const origins = new Set([localOriginId, ...(await this.database.query<{ originId: string }>(`
      select distinct origin_id as originId from device_event_applied_heads
      where log_scope_id >= 'chat-changes:' and log_scope_id < 'chat-changes;';
    `)).map((row) => row.originId)]);
    let events = 0;
    let blobs = 0;
    for (const originId of origins) {
      if (events >= limit) break;
      const rows = await this.database.query<{ events: number; blobs: number }>(durable(`
        begin immediate;
        create temp table if not exists chat_changes_pruned(event_id text primary key, log_scope_id text, blob_hash text);
        delete from temp.chat_changes_pruned;
        insert into temp.chat_changes_pruned(event_id, log_scope_id, blob_hash)
          select e.event_id, e.log_scope_id,
            case when json_extract(e.payload_json, '$.type') = 'device.event.blob' then json_extract(e.payload_json, '$.blobHash') end
          from chat_events e
          where e.origin_id = ${quote(originId)} and e.log_scope_id >= 'chat-changes:' and e.log_scope_id < 'chat-changes;'
            and e.received_at < ${quote(cutoffIso)}
            and e.origin_seq < (select max(n.origin_seq) from chat_events n where n.origin_id = e.origin_id and n.log_scope_id = e.log_scope_id)
            and not exists (select 1 from device_event_outbox o where o.event_id = e.event_id and o.acknowledged_at is null)
            and not exists (select 1 from device_event_inbox i where i.event_id = e.event_id and i.applied_at is null)
            ${unpushed}
          limit ${Math.max(1, Math.floor(limit - events))};
        delete from device_event_outbox where event_id in (select event_id from temp.chat_changes_pruned);
        delete from device_event_inbox where event_id in (select event_id from temp.chat_changes_pruned);
        delete from chat_events where event_id in (select event_id from temp.chat_changes_pruned);
        create temp table if not exists chat_changes_unreferenced(blob_hash text primary key);
        delete from temp.chat_changes_unreferenced;
        insert or ignore into temp.chat_changes_unreferenced(blob_hash)
          select p.blob_hash from temp.chat_changes_pruned p
          where p.blob_hash is not null and not exists (
            select 1 from chat_events r
            where r.origin_id = ${quote(originId)} and r.log_scope_id = p.log_scope_id
              and json_extract(r.payload_json, '$.blobHash') = p.blob_hash);
        delete from device_event_blob_fragments where blob_hash in (select blob_hash from temp.chat_changes_unreferenced);
        delete from device_event_blobs where blob_hash in (select blob_hash from temp.chat_changes_unreferenced);
        select (select count(*) from temp.chat_changes_pruned) as events, (select count(*) from temp.chat_changes_unreferenced) as blobs;
        delete from temp.chat_changes_pruned;
        delete from temp.chat_changes_unreferenced;
        commit;
      `));
      events += rows[0]?.events ?? 0;
      blobs += rows[0]?.blobs ?? 0;
    }
    return { events, blobs };
  }

  /**
   * Forgets this device's own events of the channels the User's hub carries
   * once the hub has them (at or before `pushedThroughRowid`) and they are
   * older than the cutoff. The hub's order is where every reader reads them;
   * this device keeps the newest event of each chain (the next one continues
   * it) and anything a relay recipient still waits for. Bodies are left to
   * the search for unreferenced ones (collectOrphans), which looks at every
   * event that might still point to them.
   */
  async pruneOwnDeviceEvents(localOriginId: string, options: { pushedThroughRowid: number; cutoffIso: string; scopePrefixes: readonly string[]; exactScopes?: readonly string[]; limit?: number }): Promise<number> {
    const prefixes = options.scopePrefixes.filter((prefix) => prefix.startsWith("device:") && prefix.length <= 512);
    // Whole scopes of this device's own that are not channels (the approval
    // cards a desktop publishes for the phone).
    const exact = (options.exactScopes ?? []).filter((scope) => scope.length > 0 && scope.length <= 512 && !scope.startsWith("device:"));
    if ((prefixes.length === 0 && exact.length === 0) || options.pushedThroughRowid <= 0) return 0;
    await this.database.init();
    const channel = prefixes.length
      ? `(e.log_scope_id >= 'device:' and e.log_scope_id < 'device;' and (${prefixes.map((prefix) => `substr(e.log_scope_id, 1, ${prefix.length}) = ${quote(prefix)}`).join(" or ")}))`
      : "0";
    const scopes = exact.length ? `${channel} or e.log_scope_id in (${exact.map(quote).join(", ")})` : channel;
    const rows = await this.database.query<{ events: number }>(durable(`
      begin immediate;
      create temp table if not exists device_events_pruned(event_id text primary key);
      delete from temp.device_events_pruned;
      insert into temp.device_events_pruned(event_id)
        select e.event_id from chat_events e
        where e.origin_id = ${quote(localOriginId)} and (${scopes})
          and e.rowid <= ${Math.floor(options.pushedThroughRowid)} and e.received_at < ${quote(options.cutoffIso)}
          and e.kind not in (${OWN_EVENTS_KEPT_KINDS.map(quote).join(", ")})
          and e.origin_seq < (select max(n.origin_seq) from chat_events n where n.origin_id = e.origin_id and n.log_scope_id = e.log_scope_id)
          and not exists (select 1 from device_event_outbox o where o.event_id = e.event_id and o.acknowledged_at is null)
        limit ${Math.max(1, Math.floor(options.limit ?? 2_000))};
      delete from device_event_outbox where event_id in (select event_id from temp.device_events_pruned);
      delete from device_event_inbox where event_id in (select event_id from temp.device_events_pruned);
      delete from chat_events where event_id in (select event_id from temp.device_events_pruned);
      select count(*) as events from temp.device_events_pruned;
      delete from temp.device_events_pruned;
      commit;
    `));
    return Number(rows[0]?.events ?? 0) || 0;
  }

  /**
   * A stretch of a chain the User's hub forgot by design (both ends had read
   * it, or it was a run's live progress): this device continues the chain
   * after it. Events of that stretch received here but not applied are
   * recorded as superseded. False when this device was already past it.
   */
  async skipTo(originId: string, logScopeId: string, originSeq: number, eventHash: string, at: string): Promise<boolean> {
    requireCursor(originSeq);
    await this.database.init();
    const rows = await this.database.query<{ moved: number }>(durable(`
      begin immediate;
      insert into device_event_applied_heads(origin_id, log_scope_id, origin_seq, event_hash)
        values (${quote(originId)}, ${quote(logScopeId)}, ${Math.floor(originSeq)}, ${quote(eventHash)})
      on conflict(origin_id, log_scope_id) do update set origin_seq = excluded.origin_seq, event_hash = excluded.event_hash
        where excluded.origin_seq > device_event_applied_heads.origin_seq;
      select changes() as moved;
      update device_event_inbox set applied_at = ${quote(at)}, outcome = 'superseded'
        where applied_at is null and event_id in (select event_id from chat_events
          where origin_id = ${quote(originId)} and log_scope_id = ${quote(logScopeId)} and origin_seq <= ${Math.floor(originSeq)});
      commit;
    `));
    return Number(rows[0]?.moved ?? 0) > 0;
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
  /**
   * What this emitter may forget, and who is holding it back.
   *
   * The relay buffers briefly and then forgets; an event is released only when
   * every machine in the roster has acknowledged it, so catch-up past the
   * relay's buffer is a resend from here. The decision itself lives in
   * `decideChatEventRetention`, shared with the phone's outbox, so the two
   * cannot disagree about when it is safe to forget something.
   *
   * Bounded: at most `limit` unacknowledged rows are examined, and
   * `truncated` says when there were more. On the User's largest chat the
   * outbox is per undelivered event, not per message in history.
   */
  async retention(channelId: string, roster?: readonly string[], limit = 5_000): Promise<ChatEventRetentionDecision & { truncated: boolean }> {
    await this.database.init();
    // Every outbox row, acknowledged or not: "may this be forgotten?" can only
    // be answered by looking at all of an event's recipients, not at the ones
    // that are still behind.
    const rows = await this.database.query<{
      eventId: string; deviceId: string; bytes: number; logicalTs: string; createdAt: string; acknowledged: number;
    }>(`
      select o.event_id as eventId, o.device_id as deviceId,
        length(cast(e.envelope_json as blob)) as bytes,
        e.logical_ts as logicalTs, e.received_at as createdAt,
        case when o.acknowledged_at is null then 0 else 1 end as acknowledged
      from device_event_outbox o join chat_events e on e.event_id = o.event_id
      where o.channel_id = ${quote(channelId)}
      order by o.rowid limit ${Math.max(1, Math.floor(limit)) + 1};
    `);
    const truncated = rows.length > limit;
    const examined = truncated ? rows.slice(0, limit) : rows;
    const entries = new Map<string, { eventId: string; bytes: number; logicalTs: string; createdAt: string }>();
    const ackedByDevice = new Map<string, Set<string>>();
    const recipients = new Set<string>();
    for (const row of examined) {
      entries.set(row.eventId, {
        eventId: row.eventId, bytes: row.bytes ?? 0,
        logicalTs: row.logicalTs ?? "", createdAt: row.createdAt ?? ""
      });
      recipients.add(row.deviceId);
      if (row.acknowledged) {
        const acked = ackedByDevice.get(row.deviceId) ?? new Set<string>();
        acked.add(row.eventId);
        ackedByDevice.set(row.deviceId, acked);
      }
    }
    const peers = roster?.length ? [...roster] : [...recipients];
    const decision = decideChatEventRetention({
      entries: [...entries.values()],
      roster: peers,
      acknowledgements: peers.map((peerId) => ({ peerId, eventIds: [...(ackedByDevice.get(peerId) ?? [])] }))
    });
    return { ...decision, truncated };
  }

  /**
   * Gives a device that has just become trusted the events this room still
   * owes anyone.
   *
   * A result published before that device was known has no delivery row for
   * it, and repair only serves what a peer was already a recipient of. Without
   * this, a device added while a turn was running would never see its result —
   * which is exactly the case where the desktop that started the turn is gone.
   */
  async shareUnacknowledged(channelId: string, deviceId: string): Promise<number> {
    await this.database.init();
    await this.database.execute(`
      insert or ignore into device_event_outbox(event_id, device_id, channel_id)
      select distinct o.event_id, ${quote(deviceId)}, ${quote(channelId)}
      from device_event_outbox o
      where o.channel_id = ${quote(channelId)} and o.acknowledged_at is null and o.device_id <> ${quote(deviceId)};
    `);
    return (await this.database.query<{ shared: number }>(`
      select count(*) as shared from device_event_outbox
      where channel_id = ${quote(channelId)} and device_id = ${quote(deviceId)} and acknowledged_at is null;
    `))[0]?.shared ?? 0;
  }

  /** When `deviceId` last confirmed something this device sent it. */
  async lastAcknowledgedAt(channelId: string, deviceId: string): Promise<string | undefined> {
    await this.database.init();
    return (await this.database.query<{ at: string | null }>(`
      select max(acknowledged_at) as at from device_event_outbox
      where channel_id = ${quote(channelId)} and device_id = ${quote(deviceId)} and acknowledged_at is not null;
    `))[0]?.at ?? undefined;
  }

  /**
   * Stops holding anything for a device the owner has taken off the roster.
   *
   * Revoking a device ends its authority at once. What it does not end by
   * itself is this side still carrying that device's share of the room: rows
   * addressed to it, re-offered on every reconnect and served from the
   * mailbox, which is retained traffic for a device that is no longer trusted.
   * Retention for the devices that remain is untouched; only this one's claim
   * on the room's history goes.
   */
  async forgetRecipient(channelId: string, deviceId: string): Promise<number> {
    await this.database.init();
    const rows = await this.database.query<{ eventId: string }>(durable(`
      delete from device_event_outbox where channel_id = ${quote(channelId)} and device_id = ${quote(deviceId)}
      returning event_id as eventId;`));
    return rows.length;
  }

  /**
   * A machine imported a chat copy covering every chat change up to `marks`:
   * the rows kept for it up to them are confirmed, not sent. Only chat change
   * scopes; the chat-action log's mark says how far it was seen, not applied.
   */
  async confirmCopied(channelId: string, deviceId: string, marks: ReadonlyArray<{ originId: string; logScopeId: string; originSeq: number }>, at: string): Promise<number> {
    await this.database.init();
    const covered = marks.filter((mark) => isChatChangesLogScope(mark.logScopeId) && typeof mark.originId === "string"
      && Number.isSafeInteger(mark.originSeq) && mark.originSeq > 0);
    let confirmed = 0;
    for (let index = 0; index < covered.length; index += 100) {
      const chunk = covered.slice(index, index + 100);
      const rows = await this.database.query<{ eventId: string }>(durable(`
        update device_event_outbox set acknowledged_at = ${quote(at)}, outcome = 'applied'
        where channel_id = ${quote(channelId)} and device_id = ${quote(deviceId)} and acknowledged_at is null
          and event_id in (${chunk.map((mark) => `select event_id from chat_events where origin_id = ${quote(mark.originId)}
            and log_scope_id = ${quote(mark.logScopeId)} and origin_seq <= ${Math.floor(mark.originSeq)}`).join(" union all ")})
        returning event_id as eventId;`));
      confirmed += rows.length;
    }
    return confirmed;
  }

  /**
   * Stops forwarding what a removed device wrote. The remaining machines drop
   * it from their rosters and refuse its signature from then on, so a row
   * that still offers one of its events to them would never be confirmed.
   */
  async forgetOrigin(originId: string): Promise<number> {
    await this.database.init();
    const rows = await this.database.query<{ eventId: string }>(durable(`
      delete from device_event_outbox where event_id in (select event_id from chat_events where origin_id = ${quote(originId)})
      returning event_id as eventId;`));
    return rows.length;
  }

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
   * events after mailbox expiry. A repair request is not an access grant.
   *
   * The chat-action log is the one exception, and not a widening: it is one
   * log for every machine in the roster, published to all of them, so a
   * machine enrolled after a decision was made is a recipient of it. Without
   * this it would sit behind a gap it can never close, and no action would
   * ever apply there. The rows it is served are recorded as deliveries, so
   * retention still waits for its acknowledgement.
   *
   * Chat changes are the same for a device that holds every chat (a machine,
   * or the desktop that enrolled it): it is a recipient of every chat change,
   * including one written before it was known, and one written by another
   * machine that this device holds (served unchanged, signed by its author).
   * Any other peer (a phone) is served only what was addressed to it.
   */
  async repair(channelId: string, deviceId: string, gap: DeviceEventGap, options: { anyChatChange?: boolean } = {}): Promise<ChatEventEnvelope[]> {
    requireCursor(gap.fromSeq);
    requireCursor(gap.toSeq);
    if (gap.fromSeq < 1 || gap.toSeq < gap.fromSeq) throw new Error("Invalid device event repair range.");
    await this.database.init();
    const broadcast = gap.logScopeId === CHAT_ACTION_LOG_SCOPE || (options.anyChatChange === true && isChatChangesLogScope(gap.logScopeId));
    const rows = await this.database.query<{ envelope: string }>(`
      with candidates as (
      select e.envelope_json as envelope, e.origin_seq from ${broadcast ? "chat_events e" : `device_event_outbox o join chat_events e on e.event_id = o.event_id`}
      where ${broadcast ? "" : `o.channel_id = ${quote(channelId)} and o.device_id = ${quote(deviceId)} and `}e.origin_id = ${quote(gap.originId)} and e.log_scope_id = ${quote(gap.logScopeId)}
        and e.origin_seq between ${gap.fromSeq} and ${Math.min(gap.toSeq, gap.fromSeq + DEVICE_EVENT_PAGE_COUNT - 1)}
      order by e.origin_seq
      ), page as (
        select envelope, sum(length(cast(envelope as blob))) over (order by origin_seq) as bytes,
          row_number() over (order by origin_seq) as ordinal from candidates
      ) select envelope from page where bytes <= ${DEVICE_EVENT_PAGE_BYTES} or ordinal = 1 order by ordinal;
    `);
    const events = rows.map((row) => JSON.parse(row.envelope) as ChatEventEnvelope);
    if (broadcast && events.length) {
      await this.database.execute(deviceEventAppendSql(events, { recipients: [{ deviceId, channelId }] }));
    }
    return events;
  }
}

/** Own events that are looked up by their id later, as proof that something
 *  was already sent or done (a turn's command while its run is pending, a
 *  stop): they are never forgotten here, or a late repeat would be taken for
 *  a first time. (An answer to a card is the User's server's: its device
 *  settles the card there, and keeps no event of it.) */
const OWN_EVENTS_KEPT_KINDS = ["machine.turn.request", "machine.turn.cancel"] as const;

function quote(value: string): string {
  // The sqlite3 shell reads statements line by line and a NUL ends a line:
  // the rest of the literal would leak into the statement.
  if (value.includes("\u0000")) throw new Error("A value with a NUL character cannot be stored.");
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

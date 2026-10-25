import type { ChatEventEnvelope } from "../../shared/chatEvents";
import { HUB_PHONE_INVITE_MAX_LIFETIME_MS, isHubPhoneScope, type HubDevice, type HubDeviceRole, type HubLoggedEvent, type HubPhoneInvite, type HubPhoneScope } from "../../shared/hubProtocol";

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
  -- On the hub: one-time phone invites the owner signed. A token is admitted once.
  create table if not exists hub_phone_invites (
    invite_id text primary key,
    token_hash text not null unique,
    invite_json text not null,
    signature text not null,
    expires_at text not null,
    created_at text not null,
    used_at text,
    device_id text,
    cancelled_at text,
    enrollment_json text,
    enrollment_signature text
  );
  -- On the hub: approval cards as the devices that hold them last said.
  create table if not exists hub_approval_cards (
    conversation_id text not null,
    approval_id text not null,
    approval_json text not null,
    status text not null,
    hub_seq integer not null,
    primary key(conversation_id, approval_id)
  );
  create index if not exists hub_approval_cards_pending on hub_approval_cards(status, conversation_id);
  -- On the hub: what a phone is rung for and its notification says.
  create table if not exists hub_notices (
    seq integer primary key autoincrement,
    conversation_id text not null,
    kind text not null,
    title text not null,
    body text not null,
    created_at text not null
  );
  -- On the hub: how far each phone has seen the notices.
  create table if not exists hub_phone_state (
    device_id text primary key,
    seen_notice_seq integer not null default 0,
    updated_at text not null
  );
  -- On the hub: documents the owner publishes (the composer's catalog).
  create table if not exists hub_documents (
    key text primary key,
    value_json text not null,
    updated_at text not null
  );
  -- On the hub: the start-only key for each machine, from the owner.
  create table if not exists hub_machine_wake (
    machine_id text primary key,
    config_json text not null,
    updated_at text not null,
    last_attempt_at text,
    last_result text
  );
`;

/** Columns added to tables an older hub created. */
const HUB_ADDED_COLUMNS: Array<{ table: string; column: string; definition: string }> = [
  { table: "hub_devices", column: "scope_json", definition: "text" },
  { table: "hub_devices", column: "invite_id", definition: "text" }
];

/** A notice the hub keeps for a phone's notification. */
export interface HubNotice {
  seq: number;
  conversationId: string;
  kind: "reply" | "approval";
  title: string;
  body: string;
  createdAt: string;
}

/** How many notices the hub keeps (the newest). */
const HUB_NOTICES_KEPT = 500;


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
/** Settled approval cards kept per chat (pending ones are always kept). */
const HUB_APPROVAL_CARDS_KEPT = 200;

export class HubStorage {
  private ready?: Promise<void>;

  constructor(private readonly database: Database) {}

  private async init(): Promise<void> {
    this.ready ??= (async () => {
      await this.database.init();
      await this.database.execute(HUB_SCHEMA_SQL);
      for (const added of HUB_ADDED_COLUMNS) {
        const columns = await this.database.query<{ name: string }>(`pragma table_info(${added.table});`);
        if (!columns.some((column) => column.name === added.column)) {
          await this.database.execute(`alter table ${added.table} add column ${added.column} ${added.definition};`);
        }
      }
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
    const rows = await this.database.query<{ deviceId: string; publicKey: string; role: HubDeviceRole; name: string; machineId: string | null; addedAt: string; scopeJson: string | null; inviteId: string | null }>(`
      select device_id as deviceId, public_key as publicKey, role, name, machine_id as machineId, added_at as addedAt,
        scope_json as scopeJson, invite_id as inviteId from hub_devices order by added_at;
    `);
    return rows.map((row) => {
      const scope = parseScope(row.scopeJson);
      return {
        deviceId: row.deviceId, publicKeyDerBase64: row.publicKey, role: row.role, name: row.name, addedAt: row.addedAt,
        ...(row.machineId ? { machineId: row.machineId } : {}),
        ...(scope ? { scope } : {}),
        ...(row.inviteId ? { inviteId: row.inviteId } : {})
      };
    });
  }

  /**
   * Replaces the roster in one transaction. The owner row is kept as it is,
   * and so is a phone that enrolled with an invite the owner has not settled
   * yet (it enrolled while the desktop was away): the owner's list cannot
   * name what it has not heard of. An invite the owner settled decides by the
   * list, and one still unused is no longer good.
   */
  async replaceRoster(devices: HubDevice[], now: string, resolvedInviteIds: string[] = []): Promise<void> {
    await this.init();
    // The owner is in the list it sends (as a desktop) and stays the owner.
    const owners = new Set((await this.database.query<{ deviceId: string }>(`select device_id as deviceId from hub_devices where role = 'owner';`)).map((row) => row.deviceId));
    const listed = devices.filter((device) => device.role !== "owner" && !owners.has(device.deviceId));
    const values = listed.map((device) =>
      `(${quote(device.deviceId)}, ${quote(device.publicKeyDerBase64)}, ${quote(device.role)}, ${quote(device.name)}, ${device.machineId ? quote(device.machineId) : "null"}, ${quote(device.addedAt || now)}, ${device.scope ? quote(JSON.stringify(device.scope)) : "null"}, ${device.inviteId ? quote(device.inviteId) : "null"})`);
    const keep = listed.length ? `and device_id not in (${listed.map((device) => quote(device.deviceId)).join(", ")})` : "";
    const resolved = resolvedInviteIds.length ? resolvedInviteIds.map(quote).join(", ") : "";
    await this.database.execute(`
      begin immediate;
      delete from hub_devices where role != 'owner' ${keep} and (invite_id is null${resolved ? ` or invite_id in (${resolved})` : ""});
      ${values.length ? `insert into hub_devices(device_id, public_key, role, name, machine_id, added_at, scope_json, invite_id) values ${values.join(", ")}
        on conflict(device_id) do update set public_key = excluded.public_key, role = excluded.role, name = excluded.name, machine_id = excluded.machine_id,
          scope_json = coalesce(excluded.scope_json, hub_devices.scope_json), invite_id = coalesce(excluded.invite_id, hub_devices.invite_id)
        where hub_devices.role != 'owner';` : ""}
      ${resolved ? `update hub_phone_invites set cancelled_at = ${quote(now)} where invite_id in (${resolved}) and used_at is null and cancelled_at is null;` : ""}
      delete from hub_push_subscriptions where device_id not in (select device_id from hub_devices);
      delete from hub_phone_state where device_id not in (select device_id from hub_devices);
      commit;
    `);
  }

  /** On the hub: an invite the owner signed, kept until a phone spends it. */
  async savePhoneInvite(invite: HubPhoneInvite, signature: string, now: string): Promise<void> {
    await this.init();
    await this.database.execute(`
      insert into hub_phone_invites(invite_id, token_hash, invite_json, signature, expires_at, created_at)
        values (${quote(invite.inviteId)}, ${quote(invite.tokenHash)}, ${quote(JSON.stringify(invite))}, ${quote(signature)}, ${quote(invite.expiresAt)}, ${quote(now)})
      on conflict(invite_id) do nothing;
      delete from hub_phone_invites where used_at is null and expires_at < ${quote(new Date(Date.parse(now) - HUB_PHONE_INVITE_MAX_LIFETIME_MS).toISOString())};
    `);
  }

  async phoneInviteByTokenHash(tokenHash: string): Promise<{
    invite: HubPhoneInvite; signature: string; usedAt?: string; deviceId?: string; cancelledAt?: string;
    enrollment?: { json: string; signature: string };
  } | undefined> {
    await this.init();
    const rows = await this.database.query<{ inviteJson: string; signature: string; usedAt: string | null; deviceId: string | null; cancelledAt: string | null; enrollmentJson: string | null; enrollmentSignature: string | null }>(`
      select invite_json as inviteJson, signature, used_at as usedAt, device_id as deviceId, cancelled_at as cancelledAt,
        enrollment_json as enrollmentJson, enrollment_signature as enrollmentSignature
      from hub_phone_invites where token_hash = ${quote(tokenHash)};
    `);
    const row = rows[0];
    if (!row) return undefined;
    return {
      invite: JSON.parse(row.inviteJson) as HubPhoneInvite, signature: row.signature,
      ...(row.usedAt ? { usedAt: row.usedAt } : {}), ...(row.deviceId ? { deviceId: row.deviceId } : {}), ...(row.cancelledAt ? { cancelledAt: row.cancelledAt } : {}),
      ...(row.enrollmentJson && row.enrollmentSignature ? { enrollment: { json: row.enrollmentJson, signature: row.enrollmentSignature } } : {})
    };
  }

  /** Spends an invite on one phone and admits the phone, in one transaction.
   *  False when the invite was spent or cancelled meanwhile. */
  async enrollPhone(inviteId: string, device: HubDevice & { scope: HubPhoneScope }, enrollment: { json: string; signature: string }, now: string): Promise<boolean> {
    await this.init();
    const rows = await this.database.query<{ taken: number }>(`
      begin immediate;
      update hub_phone_invites set used_at = ${quote(now)}, device_id = ${quote(device.deviceId)},
          enrollment_json = ${quote(enrollment.json)}, enrollment_signature = ${quote(enrollment.signature)}
        where invite_id = ${quote(inviteId)} and used_at is null and cancelled_at is null;
      insert into hub_devices(device_id, public_key, role, name, added_at, scope_json, invite_id)
        select ${quote(device.deviceId)}, ${quote(device.publicKeyDerBase64)}, 'phone', ${quote(device.name)}, ${quote(now)}, ${quote(JSON.stringify(device.scope))}, ${quote(inviteId)}
        where (select used_at from hub_phone_invites where invite_id = ${quote(inviteId)}) = ${quote(now)}
          and (select device_id from hub_phone_invites where invite_id = ${quote(inviteId)}) = ${quote(device.deviceId)}
        on conflict(device_id) do update set public_key = excluded.public_key, scope_json = excluded.scope_json, invite_id = excluded.invite_id
          where hub_devices.role = 'phone';
      commit;
      select count(*) as taken from hub_devices where device_id = ${quote(device.deviceId)} and invite_id = ${quote(inviteId)};
    `);
    return Number(rows[0]?.taken ?? 0) === 1;
  }

  /** Approval cards as the devices holding them last said, by hub order. */
  async saveApprovalCards(cards: Array<{ conversationId: string; approvalId: string; approvalJson: string; status: string; hubSeq: number }>): Promise<void> {
    if (cards.length === 0) return;
    await this.init();
    await this.database.execute(`
      begin immediate;
      ${cards.map((card) => `
        insert into hub_approval_cards(conversation_id, approval_id, approval_json, status, hub_seq)
          values (${quote(card.conversationId)}, ${quote(card.approvalId)}, ${quote(card.approvalJson)}, ${quote(card.status)}, ${Math.floor(card.hubSeq)})
        on conflict(conversation_id, approval_id) do update set approval_json = excluded.approval_json, status = excluded.status, hub_seq = excluded.hub_seq
          where excluded.hub_seq > hub_approval_cards.hub_seq;`).join("")}
      ${[...new Set(cards.map((card) => card.conversationId))].map((conversationId) => `
        delete from hub_approval_cards where conversation_id = ${quote(conversationId)} and status <> 'pending'
          and hub_seq < (select hub_seq from hub_approval_cards where conversation_id = ${quote(conversationId)}
            order by hub_seq desc limit 1 offset ${HUB_APPROVAL_CARDS_KEPT - 1});`).join("")}
      commit;
    `);
  }

  /** The status each named card has now (cards not held are left out). */
  async approvalCardStatuses(conversationId: string, approvalIds: string[]): Promise<Map<string, string>> {
    const ids = [...new Set(approvalIds)].slice(0, HUB_STORAGE_PAGE_MAX);
    if (ids.length === 0) return new Map();
    await this.init();
    const rows = await this.database.query<{ approvalId: string; status: string }>(`
      select approval_id as approvalId, status from hub_approval_cards
      where conversation_id = ${quote(conversationId)} and approval_id in (${ids.map(quote).join(", ")});
    `);
    return new Map(rows.map((row) => [row.approvalId, row.status]));
  }

  /** One chat's approval cards (the newest first, at most `limit`). */
  async approvalCards(conversationId: string, limit = 30): Promise<Array<{ approvalJson: string; status: string; hubSeq: number }>> {
    await this.init();
    return this.database.query(`
      select approval_json as approvalJson, status, hub_seq as hubSeq from hub_approval_cards
      where conversation_id = ${quote(conversationId)} order by hub_seq desc limit ${Math.max(1, Math.min(limit, HUB_STORAGE_PAGE_MAX))};
    `);
  }

  /** Every pending approval card, by chat, for the chat list. */
  async pendingApprovalCards(conversationIds: string[]): Promise<Array<{ conversationId: string; approvalJson: string }>> {
    if (conversationIds.length === 0) return [];
    await this.init();
    return this.database.query(`
      select conversation_id as conversationId, approval_json as approvalJson from hub_approval_cards
      where status = 'pending' and conversation_id in (${conversationIds.map(quote).join(", ")})
      order by hub_seq limit ${HUB_STORAGE_PAGE_MAX};
    `);
  }

  async addNotice(notice: Omit<HubNotice, "seq">): Promise<number> {
    await this.init();
    const rows = await this.database.query<{ seq: number }>(`
      insert into hub_notices(conversation_id, kind, title, body, created_at)
        values (${quote(notice.conversationId)}, ${quote(notice.kind)}, ${quote(notice.title)}, ${quote(notice.body)}, ${quote(notice.createdAt)});
      select last_insert_rowid() as seq;
    `);
    await this.database.execute(`delete from hub_notices where seq <= (select max(seq) from hub_notices) - ${HUB_NOTICES_KEPT};`);
    return Number(rows[0]?.seq ?? 0) || 0;
  }

  async notices(afterSeq: number, limit = 50): Promise<HubNotice[]> {
    await this.init();
    const rows = await this.database.query<HubNotice>(`
      select seq, conversation_id as conversationId, kind, title, body, created_at as createdAt from hub_notices
      where seq > ${Math.max(0, Math.floor(afterSeq))} order by seq limit ${Math.max(1, Math.min(limit, 200))};
    `);
    return rows.map((row) => ({ ...row, seq: Number(row.seq) }));
  }

  async noticeHead(): Promise<number> {
    await this.init();
    const rows = await this.database.query<{ seq: number | null }>(`select max(seq) as seq from hub_notices;`);
    return Number(rows[0]?.seq ?? 0) || 0;
  }

  async phoneSeenNotice(deviceId: string): Promise<number> {
    await this.init();
    const rows = await this.database.query<{ seq: number }>(`select seen_notice_seq as seq from hub_phone_state where device_id = ${quote(deviceId)};`);
    return Number(rows[0]?.seq ?? 0) || 0;
  }

  async setPhoneSeenNotice(deviceId: string, seq: number, now: string): Promise<void> {
    await this.init();
    await this.database.execute(`
      insert into hub_phone_state(device_id, seen_notice_seq, updated_at) values (${quote(deviceId)}, ${Math.max(0, Math.floor(seq))}, ${quote(now)})
      on conflict(device_id) do update set seen_notice_seq = max(seen_notice_seq, excluded.seen_notice_seq), updated_at = excluded.updated_at;
    `);
  }

  async document(key: string): Promise<{ value: unknown; updatedAt: string } | undefined> {
    await this.init();
    const rows = await this.database.query<{ valueJson: string; updatedAt: string }>(`select value_json as valueJson, updated_at as updatedAt from hub_documents where key = ${quote(key)};`);
    return rows[0] ? { value: JSON.parse(rows[0].valueJson) as unknown, updatedAt: rows[0].updatedAt } : undefined;
  }

  async setDocument(key: string, value: unknown, now: string): Promise<void> {
    await this.init();
    await this.database.execute(`
      insert into hub_documents(key, value_json, updated_at) values (${quote(key)}, ${quote(JSON.stringify(value))}, ${quote(now)})
      on conflict(key) do update set value_json = excluded.value_json, updated_at = excluded.updated_at;
    `);
  }

  /** The start keys the owner gave for its machines (replaces them all). */
  async replaceMachineWake(entries: Array<{ machineId: string; configJson: string }>, now: string): Promise<void> {
    await this.init();
    await this.database.execute(`
      begin immediate;
      delete from hub_machine_wake${entries.length ? ` where machine_id not in (${entries.map((entry) => quote(entry.machineId)).join(", ")})` : ""};
      ${entries.map((entry) => `insert into hub_machine_wake(machine_id, config_json, updated_at) values (${quote(entry.machineId)}, ${quote(entry.configJson)}, ${quote(now)})
        on conflict(machine_id) do update set config_json = excluded.config_json, updated_at = excluded.updated_at;`).join("")}
      commit;
    `);
  }

  async machineWake(): Promise<Array<{ machineId: string; configJson: string; lastAttemptAt?: string; lastResult?: string }>> {
    await this.init();
    const rows = await this.database.query<{ machineId: string; configJson: string; lastAttemptAt: string | null; lastResult: string | null }>(`
      select machine_id as machineId, config_json as configJson, last_attempt_at as lastAttemptAt, last_result as lastResult from hub_machine_wake;
    `);
    return rows.map((row) => ({ machineId: row.machineId, configJson: row.configJson, ...(row.lastAttemptAt ? { lastAttemptAt: row.lastAttemptAt } : {}), ...(row.lastResult ? { lastResult: row.lastResult } : {}) }));
  }

  async noteMachineWakeAttempt(machineId: string, at: string, result: string): Promise<void> {
    await this.init();
    await this.database.execute(`update hub_machine_wake set last_attempt_at = ${quote(at)}, last_result = ${quote(result.slice(0, 500))} where machine_id = ${quote(machineId)};`);
  }

  /** When each device last read the order (its cursor's time). */
  async cursorTimes(): Promise<Map<string, { hubSeq: number; updatedAt: string }>> {
    await this.init();
    const rows = await this.database.query<{ deviceId: string; hubSeq: number; updatedAt: string }>(`select device_id as deviceId, hub_seq as hubSeq, updated_at as updatedAt from hub_device_cursors;`);
    return new Map(rows.map((row) => [row.deviceId, { hubSeq: Number(row.hubSeq), updatedAt: row.updatedAt }]));
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
        where origin_id = ${quote(originId)} and conversation_id = ${quote(conversationId)} and hub_seq < ${Math.floor(hubSeq)}
          and reason != 'deferred-action') as held;
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

function parseScope(value: string | null): HubPhoneScope | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isHubPhoneScope(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function quote(value: string): string {
  // The sqlite3 shell reads statements line by line and a NUL ends a line:
  // the rest of the literal would leak into the statement.
  if (value.includes("\u0000")) throw new Error("A value with a NUL character cannot be stored.");
  return `'${value.replace(/'/g, "''")}'`;
}

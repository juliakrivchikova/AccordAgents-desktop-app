import { HUB_PHONE_INVITE_MAX_LIFETIME_MS, isHubPhoneScope, type HubDevice, type HubDeviceRole, type HubPhoneEnrollment, type HubPhoneEnrollmentRecord, type HubPhoneInvite, type HubPhoneScope } from "../../shared/hubProtocol";

/** The hub's own tables, beside the chat tables StorageService keeps (the
 *  chats as the server owns them are HubOpsStore's). */
export const HUB_SCHEMA_SQL = `
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
  -- On a device that uses a hub: where it read the server's feed, and what
  -- it moved there the first time (ServerChatLink).
  create table if not exists hub_client_state (
    key text primary key,
    value text not null
  );
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
  -- Cards are the server's own now (hub_cards, raised, answered and settled
  -- by operations): what the hub once folded from devices' events goes.
  drop table if exists hub_approval_cards;
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
  { table: "hub_devices", column: "invite_id", definition: "text" },
  { table: "hub_phone_state", column: "rung_notice_seq", definition: "integer not null default 0" }
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


interface Database {
  init(): Promise<void>;
  query<T>(sql: string): Promise<T[]>;
  execute(sql: string): Promise<void>;
}

/** No page of the hub's tables is longer than this. */
const HUB_STORAGE_PAGE_MAX = 1000;

export class HubStorage {
  private ready?: Promise<void>;

  constructor(private readonly database: Database) {}

  private async init(): Promise<void> {
    this.ready ??= (async () => {
      await this.database.init();
      await this.database.execute(HUB_SCHEMA_SQL);
      // The relay's sealed mailboxes and claims, from before the relay was
      // removed: nothing reads them any more.
      await this.database.execute(`
        drop table if exists hub_relay_events;
        drop table if exists hub_relay_claims;
        drop table if exists hub_relay_mailboxes;
      `);
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

  /** What each phone that enrolled with an invite enrolled with: the invite
   *  as the owner signed it and the phone's signed acceptance, for the owner
   *  to learn the phone from (GET /v1/roster). */
  async phoneEnrollments(): Promise<HubPhoneEnrollmentRecord[]> {
    await this.init();
    const rows = await this.database.query<{ deviceId: string; inviteJson: string; signature: string; enrollmentJson: string; enrollmentSignature: string }>(`
      select i.device_id as deviceId, i.invite_json as inviteJson, i.signature as signature,
        i.enrollment_json as enrollmentJson, i.enrollment_signature as enrollmentSignature
      from hub_phone_invites i join hub_devices d on d.device_id = i.device_id and d.invite_id = i.invite_id and d.role = 'phone'
      where i.used_at is not null and i.enrollment_json is not null and i.enrollment_signature is not null
      order by i.used_at limit ${HUB_STORAGE_PAGE_MAX};
    `);
    const records: HubPhoneEnrollmentRecord[] = [];
    for (const row of rows) {
      try {
        records.push({
          deviceId: row.deviceId,
          invite: JSON.parse(row.inviteJson) as HubPhoneInvite,
          inviteSignature: row.signature,
          enrollment: JSON.parse(row.enrollmentJson) as HubPhoneEnrollment,
          enrollmentSignature: row.enrollmentSignature
        });
      } catch {
        // An unreadable record proves nothing; the phone is left to the owner.
      }
    }
    return records;
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

  /** The newest notice a phone was rung for (kept across restarts). */
  async phoneRungNotice(deviceId: string): Promise<number> {
    await this.init();
    const rows = await this.database.query<{ seq: number }>(`select rung_notice_seq as seq from hub_phone_state where device_id = ${quote(deviceId)};`);
    return Number(rows[0]?.seq ?? 0) || 0;
  }

  async setPhoneRungNotice(deviceId: string, seq: number, now: string): Promise<void> {
    await this.init();
    await this.database.execute(`
      insert into hub_phone_state(device_id, seen_notice_seq, rung_notice_seq, updated_at) values (${quote(deviceId)}, 0, ${Math.max(0, Math.floor(seq))}, ${quote(now)})
      on conflict(device_id) do update set rung_notice_seq = max(rung_notice_seq, excluded.rung_notice_seq), updated_at = excluded.updated_at;
    `);
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

  /** The pictures the hub's copy of the chats names (phone pictures). */
  async namedPictureHashes(): Promise<string[]> {
    await this.init();
    const rows = await this.database.query<{ blobHash: string | null }>(`
      select distinct json_extract(a.value, '$.hubBlob.blobHash') as blobHash
      from conversation_messages m, json_each(m.payload_json, '$.metadata.imageAttachments') a
      where instr(m.payload_json, '"hubBlob"') > 0 and json_valid(m.payload_json);
    `);
    return rows.map((row) => row.blobHash).filter((hash): hash is string => typeof hash === "string");
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

  async deleteClientState(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.init();
    await this.database.execute(`delete from hub_client_state where key in (${keys.map(quote).join(", ")});`);
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

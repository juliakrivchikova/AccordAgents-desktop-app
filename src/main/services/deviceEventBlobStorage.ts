import { createHash } from "node:crypto";
import { BLOB_FRAGMENT_MAX_BYTES } from "../../shared/machineEvents";
import {
  DEVICE_EVENT_INLINE_BYTES, fragmentByteLength, isDeviceEventBlobReference,
  type DeviceEventBlobFragment, type DeviceEventBlobReference
} from "../../shared/deviceEventBlobs";

export const DEVICE_EVENT_BLOB_SCHEMA_SQL = `
  create table if not exists device_event_blobs (
    blob_hash text primary key,
    byte_length integer not null,
    fragments integer not null,
    verified integer not null default 0
  );
  create table if not exists device_event_blob_fragments (
    blob_hash text not null references device_event_blobs(blob_hash),
    fragment_index integer not null,
    fragment_hash text not null,
    bytes blob not null,
    primary key(blob_hash, fragment_index)
  );
  -- Finding bodies no event refers to any more, a few thousand events at a
  -- time: one look at every event of a large store at once would hold the
  -- database for a minute.
  create table if not exists device_event_blob_gc (
    key text primary key,
    value text not null
  );
  create table if not exists device_event_blob_gc_refs (
    blob_hash text primary key
  );
  -- Bodies kept for what is not an event's payload: a picture a message
  -- names, an avatar the composer's catalog names (no expiry), or a body a
  -- phone put up before the event naming it arrived (until it expires).
  create table if not exists device_event_blob_pins (
    blob_hash text not null,
    reason text not null,
    expires_at integer,
    primary key(blob_hash, reason)
  );
`;

/** One pass of the search for unreferenced bodies, as it is kept between runs. */
interface BlobGcPass {
  startedAt: number;
  /** Events up to here are looked at by the pass; later ones at its end. */
  endRowid: number;
  cursor: number;
  /** Bodies up to here existed when the pass began: only they may go. */
  blobRowid: number;
}

/** A blob reference is a short payload: longer ones are never looked into. */
const BLOB_REFERENCE_PAYLOAD_MAX = 512;
/** Unreferenced bodies deleted per transaction. */
const ORPHANS_PER_TRANSACTION = 25;

interface Database {
  init(): Promise<void>;
  query<T>(sql: string): Promise<T[]>;
  execute(sql: string): Promise<void>;
}

export class DeviceEventBlobIncompleteError extends Error {
  constructor() { super("Device event body is incomplete."); }
}

/** Local content-addressed storage. A body can exceed relay/mailbox limits;
 * every SQLite input and transport fragment remains bounded to 384 KiB raw.
 * Stored fragments are immutable, and only a fully hash-verified blob hydrates. */
export class DeviceEventBlobStorage {
  constructor(private readonly database: Database) {}

  async prepare(payload: unknown): Promise<unknown | DeviceEventBlobReference> {
    const json = JSON.stringify(payload);
    if (json === undefined) throw new Error("A device event requires a JSON payload.");
    const bytes = Buffer.from(json, "utf8");
    if (bytes.byteLength <= DEVICE_EVENT_INLINE_BYTES && !isDeviceEventBlobReference(payload)) return JSON.parse(json) as unknown;
    const reference: DeviceEventBlobReference = {
      type: "device.event.blob", blobHash: hash(bytes), byteLength: bytes.byteLength,
      fragments: Math.ceil(bytes.byteLength / BLOB_FRAGMENT_MAX_BYTES)
    };
    for (let index = 0; index < reference.fragments; index += 1) {
      await this.store({ reference, index, bytesBase64: bytes.subarray(index * BLOB_FRAGMENT_MAX_BYTES, (index + 1) * BLOB_FRAGMENT_MAX_BYTES).toString("base64") });
    }
    if (!await this.verify(reference)) throw new Error("The prepared device event blob is incomplete.");
    return reference;
  }

  async store(fragment: DeviceEventBlobFragment): Promise<void> {
    const { reference, index, bytesBase64 } = fragment;
    const expected = fragmentByteLength(reference, index);
    // Canonical base64 only: Buffer.from silently accepts truncated/invalid
    // encodings, which would otherwise be acknowledged as received bytes.
    if (typeof bytesBase64 !== "string" || bytesBase64.length !== Math.ceil(expected / 3) * 4) {
      throw new Error("Invalid device event fragment length.");
    }
    const bytes = Buffer.from(bytesBase64, "base64");
    if (bytes.byteLength !== expected || bytes.toString("base64") !== bytesBase64) {
      throw new Error("Invalid device event fragment bytes.");
    }
    await this.database.init();
    await this.database.execute(`
      pragma synchronous = full; pragma fullfsync = on;
      begin immediate;
      insert into device_event_blobs(blob_hash, byte_length, fragments)
        values (${quote(reference.blobHash)}, ${reference.byteLength}, ${reference.fragments})
      on conflict(blob_hash) do update set byte_length = case
        when byte_length = excluded.byte_length and fragments = excluded.fragments then byte_length else null end;
      insert into device_event_blob_fragments(blob_hash, fragment_index, fragment_hash, bytes)
        values (${quote(reference.blobHash)}, ${index}, ${quote(hash(bytes))}, X'${bytes.toString("hex")}')
      on conflict(blob_hash, fragment_index) do update set fragment_hash = case
        when fragment_hash = excluded.fragment_hash then fragment_hash else null end;
      commit;
    `);
  }

  async fragment(reference: DeviceEventBlobReference, index: number): Promise<DeviceEventBlobFragment | undefined> {
    fragmentByteLength(reference, index);
    await this.database.init();
    const rows = await this.database.query<{ hex: string; fragmentHash: string }>(`
      select hex(f.bytes) as hex, f.fragment_hash as fragmentHash
      from device_event_blob_fragments f join device_event_blobs b on b.blob_hash = f.blob_hash
      where f.blob_hash = ${quote(reference.blobHash)} and f.fragment_index = ${index}
        and b.byte_length = ${reference.byteLength} and b.fragments = ${reference.fragments};
    `);
    if (!rows[0]) return undefined;
    const bytes = Buffer.from(rows[0].hex, "hex");
    if (bytes.length !== fragmentByteLength(reference, index) || hash(bytes) !== rows[0].fragmentHash) {
      throw new Error("Stored device event fragment is corrupt.");
    }
    return { reference, index, bytesBase64: bytes.toString("base64") };
  }

  async verify(reference: DeviceEventBlobReference): Promise<boolean> {
    if (!await this.complete(reference)) return false;
    const digest = createHash("sha256");
    for (let index = 0; index < reference.fragments; index += 1) {
      const fragment = await this.fragment(reference, index);
      if (!fragment) return false;
      digest.update(Buffer.from(fragment.bytesBase64, "base64"));
    }
    await this.confirmHash(reference, digest.digest("hex"));
    return true;
  }

  private async complete(reference: DeviceEventBlobReference): Promise<boolean> {
    fragmentByteLength(reference, 0);
    await this.database.init();
    const rows = await this.database.query<{ total: number; bytes: number }>(`
      select count(*) as total, coalesce(sum(length(f.bytes)), 0) as bytes
      from device_event_blob_fragments f join device_event_blobs b on b.blob_hash = f.blob_hash
      where f.blob_hash = ${quote(reference.blobHash)} and b.byte_length = ${reference.byteLength} and b.fragments = ${reference.fragments};
    `);
    return rows[0]?.total === reference.fragments && rows[0]?.bytes === reference.byteLength;
  }

  private async confirmHash(reference: DeviceEventBlobReference, digest: string): Promise<void> {
    if (`sha256:${digest}` !== reference.blobHash) throw new Error("Device event blob hash mismatch.");
    await this.database.execute(`pragma synchronous = full; pragma fullfsync = on;
      update device_event_blobs set verified = 1 where blob_hash = ${quote(reference.blobHash)};
    `);
  }

  /**
   * Looks for bodies no stored event refers to, a bounded stretch of events
   * per call, and deletes them once a whole pass found no reference: a body
   * fetched for an event this device never kept, or one whose event was
   * forgotten without it. A body that appeared after the pass began, or
   * whose pass is younger than `graceMs` (an upload still waiting for its
   * event), stays. Running it again is harmless.
   */
  async collectOrphans(options: { now: number; graceMs: number; scanRows: number }): Promise<{ scanned: number; deleted: number; bytes: number; swept: boolean }> {
    await this.database.init();
    const read = async (): Promise<BlobGcPass | undefined> => {
      const rows = await this.database.query<{ value: string }>(`select value from device_event_blob_gc where key = 'pass';`);
      try { return rows[0] ? JSON.parse(rows[0].value) as BlobGcPass : undefined; } catch { return undefined; }
    };
    const save = (pass: BlobGcPass): Promise<void> => this.database.execute(`
      insert into device_event_blob_gc(key, value) values ('pass', ${quote(JSON.stringify(pass))})
      on conflict(key) do update set value = excluded.value;`);
    let pass = await read();
    if (!pass) {
      const [counts] = await this.database.query<{ blobs: number; blobRowid: number | null; endRowid: number | null }>(`
        select (select count(*) from device_event_blobs) as blobs, (select max(rowid) from device_event_blobs) as blobRowid,
          (select max(rowid) from chat_events) as endRowid;`);
      if (!counts || Number(counts.blobs) === 0) return { scanned: 0, deleted: 0, bytes: 0, swept: false };
      pass = { startedAt: options.now, endRowid: Number(counts.endRowid ?? 0) || 0, cursor: 0, blobRowid: Number(counts.blobRowid ?? 0) || 0 };
      await this.database.execute(`delete from device_event_blob_gc_refs;`);
      await save(pass);
    }
    const length = await this.byteLengthFunction();
    // Pinned bodies count as referred to while the pin stands.
    const pinned = `
      insert or ignore into device_event_blob_gc_refs(blob_hash)
        select blob_hash from device_event_blob_pins where expires_at is null or expires_at > ${Math.floor(options.now)};`;
    const references = (from: number, to?: number) => `
      ${pinned}
      insert or ignore into device_event_blob_gc_refs(blob_hash)
        select json_extract(payload_json, '$.blobHash') from chat_events
        where rowid > ${Math.floor(from)} ${to === undefined ? "" : `and rowid <= ${Math.floor(to)}`}
          and ${length}(payload_json) < ${BLOB_REFERENCE_PAYLOAD_MAX} and instr(payload_json, ${quote(`"device.event.blob"`)}) > 0
          and json_valid(payload_json) and json_extract(payload_json, '$.blobHash') is not null;`;
    if (pass.cursor < pass.endRowid) {
      const to = Math.min(pass.endRowid, pass.cursor + Math.max(1, Math.floor(options.scanRows)));
      await this.database.execute(references(pass.cursor, to));
      const scanned = to - pass.cursor;
      pass = { ...pass, cursor: to };
      await save(pass);
      if (pass.cursor < pass.endRowid) return { scanned, deleted: 0, bytes: 0, swept: false };
    }
    if (options.now - pass.startedAt < options.graceMs) return { scanned: 0, deleted: 0, bytes: 0, swept: false };
    // The bodies nothing refers to go a few at a time, each batch in one
    // transaction with a look at the events written since the last one (a
    // body may have been referred to again meanwhile: bodies are shared by
    // content).
    let lastLook = pass.endRowid;
    let deleted = 0;
    let bytes = 0;
    for (;;) {
      const [result] = await this.database.query<{ deleted: number; bytes: number | null; seen: number | null }>(`
        pragma synchronous = full; pragma fullfsync = on;
        begin immediate;
        ${references(lastLook)}
        create temp table if not exists blob_gc_orphans(blob_hash text primary key, byte_length integer);
        delete from temp.blob_gc_orphans;
        insert into temp.blob_gc_orphans(blob_hash, byte_length)
          select blob_hash, byte_length from device_event_blobs
          where rowid <= ${Math.floor(pass.blobRowid)} and blob_hash not in (select blob_hash from device_event_blob_gc_refs)
          limit ${ORPHANS_PER_TRANSACTION};
        delete from device_event_blob_fragments where blob_hash in (select blob_hash from temp.blob_gc_orphans);
        delete from device_event_blobs where blob_hash in (select blob_hash from temp.blob_gc_orphans);
        select count(*) as deleted, sum(byte_length) as bytes, (select max(rowid) from chat_events) as seen from temp.blob_gc_orphans;
        delete from temp.blob_gc_orphans;
        commit;
      `);
      deleted += Number(result?.deleted ?? 0) || 0;
      bytes += Number(result?.bytes ?? 0) || 0;
      lastLook = Math.max(lastLook, Number(result?.seen ?? 0) || 0);
      if ((Number(result?.deleted ?? 0) || 0) < ORPHANS_PER_TRANSACTION) break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    await this.database.execute(`delete from device_event_blob_gc where key = 'pass'; delete from device_event_blob_gc_refs;
      delete from device_event_blob_pins where expires_at is not null and expires_at <= ${Math.floor(options.now)};`);
    return { scanned: 0, deleted, bytes, swept: true };
  }

  /** Keeps these bodies for `reason` (forever, or until `expiresAt`). */
  async pin(blobHashes: string[], reason: string, expiresAt?: number): Promise<void> {
    const hashes = [...new Set(blobHashes)].filter((hash) => /^sha256:[0-9a-f]{64}$/.test(hash) || /^[0-9a-f]{64}$/.test(hash));
    if (hashes.length === 0) return;
    await this.database.init();
    await this.database.execute(`
      insert into device_event_blob_pins(blob_hash, reason, expires_at) values ${hashes.map((hash) => `(${quote(hash)}, ${quote(reason)}, ${expiresAt === undefined ? "null" : Math.floor(expiresAt)})`).join(", ")}
      on conflict(blob_hash, reason) do update set expires_at = case
        when device_event_blob_pins.expires_at is null or excluded.expires_at is null then null
        else max(device_event_blob_pins.expires_at, excluded.expires_at) end;
    `);
  }

  /** Lets go of every body pinned for `reason` but these. */
  async pinOnly(blobHashes: string[], reason: string): Promise<void> {
    await this.database.init();
    const keep = [...new Set(blobHashes)];
    await this.database.execute(`
      delete from device_event_blob_pins where reason = ${quote(reason)}${keep.length ? ` and blob_hash not in (${keep.map(quote).join(", ")})` : ""};
    `);
    await this.pin(keep, reason);
  }

  private byteLength?: Promise<string>;

  /** octet_length reads a value's size without reading the value (sqlite
   *  3.43 and later); older ones measure the text. */
  private byteLengthFunction(): Promise<string> {
    this.byteLength ??= this.database.query<{ n: number }>(`select octet_length('x') as n;`)
      .then(() => "octet_length", () => "length");
    return this.byteLength;
  }

  async hydrate(payload: unknown): Promise<unknown> {
    if (!isDeviceEventBlobReference(payload)) return payload;
    // Verify from stored bytes, not just a flag left by a previous process.
    if (!await this.complete(payload)) throw new DeviceEventBlobIncompleteError();
    const parts: Buffer[] = [];
    const digest = createHash("sha256");
    for (let index = 0; index < payload.fragments; index += 1) {
      const fragment = await this.fragment(payload, index);
      if (!fragment) throw new Error("Device event body lost a stored fragment.");
      const bytes = Buffer.from(fragment.bytesBase64, "base64");
      parts.push(bytes);
      digest.update(bytes);
    }
    await this.confirmHash(payload, digest.digest("hex"));
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts)));
  }
}

function hash(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function quote(value: string): string {
  // The sqlite3 shell reads statements line by line and a NUL ends a line:
  // the rest of the literal would leak into the statement.
  if (value.includes("\u0000")) throw new Error("A value with a NUL character cannot be stored.");
  return `'${value.replace(/'/g, "''")}'`;
}

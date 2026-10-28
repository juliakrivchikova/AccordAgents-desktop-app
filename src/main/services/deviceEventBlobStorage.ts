import { createHash } from "node:crypto";
import { fragmentByteLength, type DeviceEventBlobFragment, type DeviceEventBlobReference } from "../../shared/deviceEventBlobs";

/** The User's server keeps these: pictures a phone sends and the avatars the
 *  composer's catalog names, by their content. No other device keeps bodies. */
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
  -- Why each body is kept: a picture a message names, an avatar the
  -- composer's catalog names (no expiry), or a body put up before the
  -- message naming it arrived (until it expires). A body nothing keeps goes.
  create table if not exists device_event_blob_pins (
    blob_hash text not null,
    reason text not null,
    expires_at integer,
    primary key(blob_hash, reason)
  );
`;

/** Bodies nothing keeps deleted per transaction. */
const ORPHANS_PER_TRANSACTION = 25;

interface Database {
  init(): Promise<void>;
  query<T>(sql: string): Promise<T[]>;
  execute(sql: string): Promise<void>;
}

/** The server's content-addressed bodies. Every SQLite input and transport
 * fragment stays bounded to 384 KiB raw; stored fragments are immutable, and
 * a body counts as there only once its whole content matches its name. */
export class DeviceEventBlobStorage {
  private ready?: Promise<void>;

  constructor(private readonly database: Database) {}

  /** Made on first use: only the User's server keeps bodies. */
  private async init(): Promise<void> {
    this.ready ??= (async () => {
      await this.database.init();
      await this.database.execute(DEVICE_EVENT_BLOB_SCHEMA_SQL);
    })();
    try {
      await this.ready;
    } catch (error) {
      this.ready = undefined;
      throw error;
    }
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
    await this.init();
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

  /** A body still being uploaded gets this fragment, replacing a different
   *  one (a complete, verified body is never touched: see the server's PUT). */
  async replaceFragment(reference: DeviceEventBlobReference, index: number): Promise<void> {
    await this.init();
    await this.database.execute(`
      begin immediate;
      delete from device_event_blob_fragments where blob_hash = ${quote(reference.blobHash)} and fragment_index = ${Math.floor(index)};
      update device_event_blobs set byte_length = ${Math.floor(reference.byteLength)}, fragments = ${Math.floor(reference.fragments)} where blob_hash = ${quote(reference.blobHash)};
      commit;
    `);
  }

  async fragment(reference: DeviceEventBlobReference, index: number): Promise<DeviceEventBlobFragment | undefined> {
    fragmentByteLength(reference, index);
    await this.init();
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
    await this.init();
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
   * Deletes the bodies no pin keeps (or whose pins expired), a few per
   * transaction, then the expired pins. A body is pinned before its first
   * fragment is stored (PUT /v1/blobs), so an upload in progress is never
   * taken. Running it again is harmless.
   */
  async collectOrphans(options: { now: number }): Promise<{ deleted: number; bytes: number }> {
    await this.init();
    const now = Math.floor(options.now);
    let deleted = 0;
    let bytes = 0;
    for (;;) {
      const [result] = await this.database.query<{ deleted: number; bytes: number | null }>(`
        pragma synchronous = full; pragma fullfsync = on;
        begin immediate;
        create temp table if not exists blob_gc_orphans(blob_hash text primary key, byte_length integer);
        delete from temp.blob_gc_orphans;
        insert into temp.blob_gc_orphans(blob_hash, byte_length)
          select b.blob_hash, b.byte_length from device_event_blobs b
          where not exists (select 1 from device_event_blob_pins p
            where p.blob_hash = b.blob_hash and (p.expires_at is null or p.expires_at > ${now}))
          limit ${ORPHANS_PER_TRANSACTION};
        delete from device_event_blob_fragments where blob_hash in (select blob_hash from temp.blob_gc_orphans);
        delete from device_event_blobs where blob_hash in (select blob_hash from temp.blob_gc_orphans);
        select count(*) as deleted, sum(byte_length) as bytes from temp.blob_gc_orphans;
        delete from temp.blob_gc_orphans;
        commit;
      `);
      deleted += Number(result?.deleted ?? 0) || 0;
      bytes += Number(result?.bytes ?? 0) || 0;
      if ((Number(result?.deleted ?? 0) || 0) < ORPHANS_PER_TRANSACTION) break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    await this.database.execute(`delete from device_event_blob_pins where expires_at is not null and expires_at <= ${now};`);
    return { deleted, bytes };
  }

  /** Keeps these bodies for `reason` (forever, or until `expiresAt`). */
  async pin(blobHashes: string[], reason: string, expiresAt?: number): Promise<void> {
    const hashes = [...new Set(blobHashes)].filter((hash) => /^sha256:[0-9a-f]{64}$/.test(hash) || /^[0-9a-f]{64}$/.test(hash));
    if (hashes.length === 0) return;
    await this.init();
    await this.database.execute(`
      insert into device_event_blob_pins(blob_hash, reason, expires_at) values ${hashes.map((hash) => `(${quote(hash)}, ${quote(reason)}, ${expiresAt === undefined ? "null" : Math.floor(expiresAt)})`).join(", ")}
      on conflict(blob_hash, reason) do update set expires_at = case
        when device_event_blob_pins.expires_at is null or excluded.expires_at is null then null
        else max(device_event_blob_pins.expires_at, excluded.expires_at) end;
    `);
  }

  /** Lets go of every body pinned for `reason` but these. */
  async pinOnly(blobHashes: string[], reason: string): Promise<void> {
    await this.init();
    const keep = [...new Set(blobHashes)];
    await this.database.execute(`
      delete from device_event_blob_pins where reason = ${quote(reason)}${keep.length ? ` and blob_hash not in (${keep.map(quote).join(", ")})` : ""};
    `);
    await this.pin(keep, reason);
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

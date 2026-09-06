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
`;

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
  return `'${value.replace(/'/g, "''")}'`;
}

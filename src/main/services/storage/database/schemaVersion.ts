export const SCHEMA_META_COMPLETE = "complete";
export const SUPPORTED_STORAGE_SCHEMA_VERSION = 2;

/** What `prepareStorageForOlderVersion` puts the database back to. */
export const PREVIOUS_STORAGE_SCHEMA_VERSION = 1;

export const STORAGE_SCHEMA_VERSION_META_KEY = "storage-schema-version";

/** Where this device's identity is kept (the key's name is the stored one). */
export const DEVICE_IDENTITY_META_KEY = "chat-event-device-identity-v1";

export const INFERRED_REQUEST_THREAD_MIGRATION_KEY = "inferred-participant-request-threads-v1";
export const CHAT_SEARCH_INDEX_META_KEY = "chat-search-index-version";
export const CHAT_SEARCH_INDEX_VERSION = 2;

export function parseStorageSchemaVersion(value: string | undefined): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (!/^\d+$/.test(trimmed)) {
    throw new Error("This chat database has an invalid storage schema version. Restore a backup or update AccordAgents.");
  }
  return Number.parseInt(trimmed, 10);
}

export class UnsupportedStorageSchemaVersionError extends Error {
  constructor(storedVersion: number, supportedVersion: number) {
    super(
      `This chat database was written by a newer version of AccordAgents. Update to open it. ` +
        `Database schema ${storedVersion}, supported schema ${supportedVersion}.`
    );
    this.name = "UnsupportedStorageSchemaVersionError";
  }
}

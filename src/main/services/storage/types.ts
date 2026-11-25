/** This device's ed25519 identity (see deviceIdentity.ts). */
export interface DeviceIdentityRecord {
  originId: string;
  keyId: string;
  publicKeyDerBase64: string;
  privateKeyDerBase64: string;
  createdAt: string;
}

/** A message as storage writes it: its position, id, creation time, the JSON
 *  that goes into the row and the sha1 of that JSON, which is what decides
 *  whether the row changed since the last save. */
export interface SavedMessageRow {
  index: number;
  id: string;
  createdAt: string;
  json: string;
  hash: string;
}

export interface StorageServiceOptions {
  dbPath?: string;
  sqliteExecutable?: string;
}

/** One chat member's fields the usage signals read: its provider, role and
 *  saved member, and how many behavior rules it has. Nothing here is sent;
 *  the signals reduce it to families, counts and the app's own role ids. */
export interface ChatMemberProviderRow {
  kind?: unknown;
  hostId?: unknown;
  hostVendor?: unknown;
  roleConfigId?: unknown;
  participantConfigId?: unknown;
  handle?: unknown;
  behaviorRuleCount?: number;
}

export const MOBILE_PAIRING_VERSION = 1;

export type MobilePairingPurpose = "phone-control" | "person-invite";

export interface MobilePairingIssuer {
  originId: string;
  keyId: string;
  publicKeyDerBase64: string;
}

export interface MobilePairingCapability {
  scope: "conversation";
  conversationId: string;
  canRead: boolean;
  canWrite: boolean;
  canRunCloudParticipants: boolean;
  canInviteOthers?: boolean;
}

export interface MobilePairingPackage {
  version: typeof MOBILE_PAIRING_VERSION;
  purpose: MobilePairingPurpose;
  issuer: MobilePairingIssuer;
  rendezvousId: string;
  stableRoutingId: string;
  relayUrl?: string;
  staticOriginUrl?: string;
  capabilities: MobilePairingCapability[];
  fingerprint: string;
  createdAt: string;
  expiresAt: string;
}

export interface CreateMobilePairingRequest {
  conversationId: string;
  purpose?: MobilePairingPurpose;
  relayUrl?: string;
  staticOriginUrl?: string;
  ttlMinutes?: number;
  canRunCloudParticipants?: boolean;
  canInviteOthers?: boolean;
}

export interface CreateMobilePairingResult {
  package: MobilePairingPackage;
  qrPayload: string;
}

export function mobilePairingPayloadForQr(pairing: MobilePairingPackage): string {
  assertMobilePairingPackage(pairing);
  return JSON.stringify(pairing);
}

export function parseMobilePairingPayload(payload: string, now: Date = new Date()): MobilePairingPackage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (error) {
    throw new Error(`Invalid mobile pairing payload JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  assertMobilePairingPackage(parsed, now);
  return parsed;
}

export function assertMobilePairingPackage(value: unknown, now?: Date): asserts value is MobilePairingPackage {
  if (!isRecord(value)) {
    throw new Error("Mobile pairing package must be an object.");
  }
  if (value.version !== MOBILE_PAIRING_VERSION) {
    throw new Error("Unsupported mobile pairing package version.");
  }
  if (value.purpose !== "phone-control" && value.purpose !== "person-invite") {
    throw new Error("Mobile pairing package purpose is invalid.");
  }
  assertRecord(value.issuer, "Mobile pairing issuer");
  assertNonEmptyString(value.issuer.originId, "issuer.originId");
  assertNonEmptyString(value.issuer.keyId, "issuer.keyId");
  assertNonEmptyString(value.issuer.publicKeyDerBase64, "issuer.publicKeyDerBase64");
  assertNonEmptyString(value.rendezvousId, "rendezvousId");
  assertNonEmptyString(value.stableRoutingId, "stableRoutingId");
  assertNonEmptyString(value.fingerprint, "fingerprint");
  const createdAt = value.createdAt;
  const expiresAt = value.expiresAt;
  assertIsoDate(createdAt, "createdAt");
  assertIsoDate(expiresAt, "expiresAt");
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) {
    throw new Error("Mobile pairing expiry must be after creation.");
  }
  if (now && Date.parse(expiresAt) <= now.getTime()) {
    throw new Error("Mobile pairing package is expired.");
  }
  if (typeof value.relayUrl === "string") {
    assertHttpsOrWssUrl(value.relayUrl, "relayUrl");
  }
  if (typeof value.staticOriginUrl === "string") {
    assertHttpsUrl(value.staticOriginUrl, "staticOriginUrl");
  }
  if (!Array.isArray(value.capabilities) || value.capabilities.length === 0) {
    throw new Error("Mobile pairing package requires at least one capability.");
  }
  for (const capability of value.capabilities) {
    assertMobilePairingCapability(capability);
  }
  if (value.rendezvousId === value.stableRoutingId) {
    throw new Error("Mobile pairing rendezvousId must be separate from stableRoutingId.");
  }
}

function assertMobilePairingCapability(value: unknown): asserts value is MobilePairingCapability {
  assertRecord(value, "Mobile pairing capability");
  if (value.scope !== "conversation") {
    throw new Error("Mobile pairing capability scope is invalid.");
  }
  assertNonEmptyString(value.conversationId, "capability.conversationId");
  for (const field of ["canRead", "canWrite", "canRunCloudParticipants"] as const) {
    if (typeof value[field] !== "boolean") {
      throw new Error(`Mobile pairing capability ${field} must be boolean.`);
    }
  }
  if (value.canInviteOthers !== undefined && typeof value.canInviteOthers !== "boolean") {
    throw new Error("Mobile pairing capability canInviteOthers must be boolean.");
  }
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Mobile pairing package requires ${label}.`);
  }
}

function assertIsoDate(value: unknown, label: string): asserts value is string {
  assertNonEmptyString(value, label);
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`Mobile pairing package ${label} must be an ISO date.`);
  }
}

function assertHttpsOrWssUrl(value: string, label: string): void {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" && parsed.protocol !== "wss:") {
    throw new Error(`Mobile pairing ${label} must use https or wss.`);
  }
}

function assertHttpsUrl(value: string, label: string): void {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:") {
    throw new Error(`Mobile pairing ${label} must use https.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

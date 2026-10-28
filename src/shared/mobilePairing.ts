import { isAcceptableHubUrl } from "./hubProtocol";
export const MOBILE_PAIRING_VERSION = 1;

/** machine-host: a machine that hosts participants enrolls with this
 *  desktop. A phone pairs with the User's server instead (hubProtocol). */
export type MobilePairingPurpose = "machine-host";

export interface MobilePairingIssuer {
  originId: string;
  keyId: string;
  publicKeyDerBase64: string;
}

export interface MobilePairingConversationCapability {
  scope: "conversation";
  conversationId: string;
  canRead: boolean;
  canWrite: boolean;
  canRunCloudParticipants: boolean;
  canInviteOthers?: boolean;
}

export interface MobilePairingDeviceCapability {
  scope: "device";
  canRead: boolean;
  canWrite: boolean;
  canRunCloudParticipants: boolean;
  canListConversations: boolean;
  canInviteOthers?: boolean;
}

export type MobilePairingCapability = MobilePairingConversationCapability | MobilePairingDeviceCapability;

export interface MobilePairingPackage {
  version: typeof MOBILE_PAIRING_VERSION;
  purpose: MobilePairingPurpose;
  issuer: MobilePairingIssuer;
  rendezvousId: string;
  stableRoutingId: string;
  /** The key the machine's first hello is sealed with (and the settings it
   *  is sent before it has keys of its own with this desktop). The name is
   *  kept from the enrollments already installed on machines. */
  relaySealKeyBase64: string;
  /** The User's own server: the machine meets the computer that set it up in
   *  its room there, and reads and writes its chats there.
   *  Every enrollment made now names it; one without it is from the shared
   *  relay, which is gone. */
  hubUrl?: string;
  capabilities: MobilePairingCapability[];
  fingerprint: string;
  createdAt: string;
  expiresAt: string;
}

export interface CreateMobilePairingRequest {
  purpose?: MobilePairingPurpose;
  hubUrl?: string;
  ttlMinutes?: number;
  canRunCloudParticipants?: boolean;
}

export interface CreateMobilePairingResult {
  package: MobilePairingPackage;
  qrPayload: string;
}

/** Where the phone's app is loaded from. The phone itself talks only to
 *  the User's own server. */
export interface MobileControlEndpointDefaults {
  staticOriginUrl?: string;
}

export interface MobileControlSettings {
  provider: "none" | "accord-managed";
  defaults: MobileControlEndpointDefaults;
}

export const ACCORD_MANAGED_MOBILE_CONTROL_DEFAULTS: MobileControlEndpointDefaults = {
  staticOriginUrl: "https://mobile.accordagents.com/"
};

export const EMPTY_MOBILE_CONTROL_SETTINGS: MobileControlSettings = {
  provider: "none",
  defaults: {}
};

export function mobileControlSettingsFromEnvironment(env: Record<string, string | undefined>): MobileControlSettings {
  const defaults: MobileControlEndpointDefaults =
    env.ACCORDAGENTS_DISABLE_MANAGED_MOBILE_DEFAULTS === "1"
      ? {}
      : { ...ACCORD_MANAGED_MOBILE_CONTROL_DEFAULTS };
  const staticOriginUrl = normalizedOptionalHttpsUrl(env.ACCORDAGENTS_MOBILE_STATIC_ORIGIN_URL);
  if (staticOriginUrl) {
    defaults.staticOriginUrl = staticOriginUrl;
  }
  return {
    provider: defaults.staticOriginUrl ? "accord-managed" : EMPTY_MOBILE_CONTROL_SETTINGS.provider,
    defaults
  };
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
  if (value.purpose !== "machine-host") {
    throw new Error("Mobile pairing package purpose is invalid.");
  }
  assertRecord(value.issuer, "Mobile pairing issuer");
  assertNonEmptyString(value.issuer.originId, "issuer.originId");
  assertNonEmptyString(value.issuer.keyId, "issuer.keyId");
  assertNonEmptyString(value.issuer.publicKeyDerBase64, "issuer.publicKeyDerBase64");
  assertNonEmptyString(value.rendezvousId, "rendezvousId");
  assertNonEmptyString(value.stableRoutingId, "stableRoutingId");
  assertNonEmptyString(value.relaySealKeyBase64, "relaySealKeyBase64");
  assertBase64Url(value.relaySealKeyBase64, "relaySealKeyBase64");
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
  if (value.hubUrl !== undefined && (typeof value.hubUrl !== "string" || !/^https?:\/\/[^\s]+$/.test(value.hubUrl) || !isAcceptableHubUrl(value.hubUrl))) {
    throw new Error("Mobile pairing hubUrl must be an https URL (plain http only on this computer).");
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
  if (value.scope !== "conversation" && value.scope !== "device") {
    throw new Error("Mobile pairing capability scope is invalid.");
  }
  if (value.scope === "conversation") {
    assertNonEmptyString(value.conversationId, "capability.conversationId");
  } else if (typeof value.canListConversations !== "boolean") {
    throw new Error("Mobile pairing capability canListConversations must be boolean.");
  }
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

function normalizedOptionalHttpsUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "https:" ? parsed.toString() : undefined;
  } catch {
    return undefined;
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

function assertBase64Url(value: string, label: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`Mobile pairing package ${label} must be base64url.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

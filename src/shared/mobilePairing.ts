export const MOBILE_PAIRING_VERSION = 1;

export type MobilePairingPurpose = "phone-control" | "person-invite";

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
  relaySealKeyBase64: string;
  relayUrl?: string;
  mailboxUrl?: string;
  outboxUrl?: string;
  staticOriginUrl?: string;
  capabilities: MobilePairingCapability[];
  fingerprint: string;
  createdAt: string;
  expiresAt: string;
}

export interface CreateMobilePairingRequest {
  conversationId?: string;
  purpose?: MobilePairingPurpose;
  relayUrl?: string;
  mailboxUrl?: string;
  outboxUrl?: string;
  staticOriginUrl?: string;
  ttlMinutes?: number;
  canRunCloudParticipants?: boolean;
  canInviteOthers?: boolean;
}

export interface CreateMobilePairingResult {
  package: MobilePairingPackage;
  qrPayload: string;
  pwaUrl?: string;
  /** False when the relay could not be reached to register the mailbox lock
   *  at creation time; the link starts working once registration succeeds
   *  (retried on reconnect and on unregistered mailbox responses). */
  mailboxRegistered?: boolean;
}

export interface RevokeMobilePairingRequest {
  stableRoutingId: string;
  rendezvousId?: string;
  reason?: string;
}

export interface RevokeMobilePairingResult {
  revoked: boolean;
  stableRoutingId: string;
  rendezvousId?: string;
  revokedAt: string;
  reason: string;
}

export interface MobileControlEndpointDefaults {
  relayUrl?: string;
  mailboxUrl?: string;
  outboxUrl?: string;
  staticOriginUrl?: string;
}

export interface MobileControlSettings {
  provider: "none" | "accord-managed";
  defaults: MobileControlEndpointDefaults;
}

export const ACCORD_MANAGED_MOBILE_CONTROL_DEFAULTS: MobileControlEndpointDefaults = {
  relayUrl: "wss://relay.accordagents.com/v1/relay",
  mailboxUrl: "https://relay.accordagents.com/",
  outboxUrl: "https://relay.accordagents.com/v1/mailbox/events",
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
  const relayUrl = normalizedOptionalEnvironmentUrl(env.ACCORDAGENTS_MOBILE_RELAY_URL, "wss:");
  const mailboxUrl = normalizedOptionalEnvironmentUrl(env.ACCORDAGENTS_MOBILE_MAILBOX_URL, "https:");
  const outboxUrl = normalizedOptionalEnvironmentUrl(env.ACCORDAGENTS_MOBILE_OUTBOX_URL, "https:");
  const staticOriginUrl = normalizedOptionalEnvironmentUrl(env.ACCORDAGENTS_MOBILE_STATIC_ORIGIN_URL, "https:");
  if (relayUrl) {
    defaults.relayUrl = relayUrl;
  }
  if (mailboxUrl) {
    defaults.mailboxUrl = mailboxUrl;
  }
  if (outboxUrl) {
    defaults.outboxUrl = outboxUrl;
  }
  if (staticOriginUrl) {
    defaults.staticOriginUrl = staticOriginUrl;
  }
  const hasManagedRelay = defaults.relayUrl === ACCORD_MANAGED_MOBILE_CONTROL_DEFAULTS.relayUrl;
  const hasManagedStatic = defaults.staticOriginUrl === ACCORD_MANAGED_MOBILE_CONTROL_DEFAULTS.staticOriginUrl;
  return {
    provider: defaults.relayUrl && defaults.staticOriginUrl ? "accord-managed" : EMPTY_MOBILE_CONTROL_SETTINGS.provider,
    defaults: hasManagedRelay && hasManagedStatic
      ? { ...ACCORD_MANAGED_MOBILE_CONTROL_DEFAULTS, ...defaults }
      : defaults
  };
}

export function mobilePairingRequestWithEndpointDefaults(
  request: CreateMobilePairingRequest,
  defaults: MobileControlEndpointDefaults | undefined
): CreateMobilePairingRequest {
  return {
    ...request,
    relayUrl: nonEmptyOrDefault(request.relayUrl, defaults?.relayUrl),
    mailboxUrl: nonEmptyOrDefault(request.mailboxUrl, defaults?.mailboxUrl),
    outboxUrl: nonEmptyOrDefault(request.outboxUrl, defaults?.outboxUrl),
    staticOriginUrl: nonEmptyOrDefault(request.staticOriginUrl, defaults?.staticOriginUrl)
  };
}

export function mobilePairingPayloadForQr(pairing: MobilePairingPackage): string {
  assertMobilePairingPackage(pairing);
  return JSON.stringify(pairing);
}

export function mobilePairingPwaUrl(pairing: MobilePairingPackage, staticOriginUrl: string | undefined = pairing.staticOriginUrl): string {
  assertMobilePairingPackage(pairing);
  if (!staticOriginUrl) {
    throw new Error("Mobile pairing PWA URL requires staticOriginUrl.");
  }
  assertHttpsUrl(staticOriginUrl, "staticOriginUrl");
  const url = new URL(staticOriginUrl);
  const conversationCapability = pairing.capabilities.find(
    (capability): capability is MobilePairingConversationCapability => capability.scope === "conversation"
  );
  url.searchParams.set("v", String(pairing.version));
  url.searchParams.set("rid", pairing.rendezvousId);
  url.searchParams.set("route", pairing.stableRoutingId);
  url.searchParams.set("cap", pairing.fingerprint);
  if (conversationCapability) {
    url.searchParams.set("conversationId", conversationCapability.conversationId);
  }
  if (pairing.relayUrl && pairing.relayUrl !== ACCORD_MANAGED_MOBILE_CONTROL_DEFAULTS.relayUrl) {
    url.searchParams.set("relay", pairing.relayUrl);
  }
  if (pairing.mailboxUrl) {
    url.searchParams.set("mailbox", pairing.mailboxUrl);
  }
  if (pairing.outboxUrl) {
    url.searchParams.set("outbox", pairing.outboxUrl);
  }
  // Keep the sealing key in the URL fragment so it is never sent to the static origin.
  url.hash = `k=${pairing.relaySealKeyBase64}`;
  return url.toString();
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
  if (typeof value.relayUrl === "string") {
    assertWssUrl(value.relayUrl, "relayUrl");
  }
  if (typeof value.mailboxUrl === "string") {
    assertHttpsUrl(value.mailboxUrl, "mailboxUrl");
  }
  if (typeof value.outboxUrl === "string") {
    assertHttpsUrl(value.outboxUrl, "outboxUrl");
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

function nonEmptyOrDefault(value: string | undefined, fallback: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || fallback;
}

function normalizedOptionalEnvironmentUrl(value: string | undefined, protocol: "https:" | "wss:"): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === protocol ? parsed.toString() : undefined;
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

function assertWssUrl(value: string, label: string): void {
  const parsed = new URL(value);
  if (parsed.protocol !== "wss:") {
    throw new Error(`Mobile pairing ${label} must use wss.`);
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

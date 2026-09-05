import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  type CreateMobilePairingRequest,
  type CreateMobilePairingResult,
  MOBILE_PAIRING_VERSION,
  mobilePairingPwaUrl,
  mobilePairingPayloadForQr,
  type MobilePairingPackage,
  type MobilePairingPurpose
} from "../../shared/mobilePairing";
import { stableJson } from "../../shared/stableJson";
import { mailboxScopeIdForSealKey } from "./mailboxAccess";
import type { ChatEventLogService } from "./chatEventLog";

const DEFAULT_PAIRING_TTL_MINUTES = 10;
const MAX_PAIRING_TTL_MINUTES = 24 * 60;

export class MobilePairingService {
  constructor(
    private readonly eventLog: ChatEventLogService,
    private readonly now: () => Date = () => new Date()
  ) {}

  async createPairing(request: CreateMobilePairingRequest): Promise<CreateMobilePairingResult> {
    const purpose = request.purpose ?? "phone-control";
    const conversationId = request.conversationId?.trim();
    if (purpose === "person-invite" && !conversationId) {
      throw new Error("Person invite pairing requires a conversationId.");
    }
    const relayUrl = normalizedOptionalUrl(request.relayUrl, ["wss:"], "relayUrl");
    const mailboxUrl = normalizedOptionalUrl(request.mailboxUrl, ["https:"], "mailboxUrl");
    const outboxUrl = normalizedOptionalUrl(request.outboxUrl, ["https:"], "outboxUrl");
    const staticOriginUrl = normalizedOptionalUrl(request.staticOriginUrl, ["https:"], "staticOriginUrl");
    const identity = await this.eventLog.getOrCreateDeviceIdentity();
    const createdAtDate = this.now();
    const createdAt = createdAtDate.toISOString();
    const expiresAt = new Date(createdAtDate.getTime() + pairingTtlMs(request.ttlMinutes, purpose)).toISOString();
    const issuer = {
      originId: identity.originId,
      keyId: identity.keyId,
      publicKeyDerBase64: identity.publicKeyDerBase64
    };
    const stableRoutingId = `route-${sha256Hex(stableJson(issuer)).slice(0, 32)}`;
    const relaySealKeyBase64 = randomBytes(32).toString("base64url");
    const scopedOutboxUrl = scopedOutboxUrlForSealKey(outboxUrl, relaySealKeyBase64);
    const capability = purpose !== "person-invite" ? {
      scope: "device" as const,
      canRead: true,
      canWrite: true,
      canRunCloudParticipants: request.canRunCloudParticipants !== false,
      canListConversations: true,
      canInviteOthers: false
    } : {
      scope: "conversation" as const,
      conversationId: conversationId ?? "",
      canRead: true,
      canWrite: true,
      canRunCloudParticipants: request.canRunCloudParticipants !== false,
      canInviteOthers: request.canInviteOthers === true
    };
    const fingerprint = pairingFingerprint({
      issuer,
      stableRoutingId,
      relaySealKeyBase64,
      relayUrl,
      mailboxUrl,
      outboxUrl: scopedOutboxUrl,
      staticOriginUrl,
      capability
    });
    const pairing: MobilePairingPackage = {
      version: MOBILE_PAIRING_VERSION,
      purpose,
      issuer,
      rendezvousId: `rv-${randomUUID()}`,
      stableRoutingId,
      relaySealKeyBase64,
      ...(relayUrl ? { relayUrl } : {}),
      ...(mailboxUrl ? { mailboxUrl } : {}),
      ...(scopedOutboxUrl ? { outboxUrl: scopedOutboxUrl } : {}),
      ...(staticOriginUrl ? { staticOriginUrl } : {}),
      capabilities: [capability],
      fingerprint,
      createdAt,
      expiresAt
    };
    return {
      package: pairing,
      qrPayload: mobilePairingPayloadForQr(pairing),
      ...(staticOriginUrl ? { pwaUrl: mobilePairingPwaUrl(pairing, staticOriginUrl) } : {})
    };
  }
}

// Every pairing gets its own locked mailbox. The scope id is a one-way
// derivation from the pairing seal key, so the phone can recompute it from
// the link and the relay can never recover the key from it. Applies to any
// outbox, not only the managed default: a self-hosted relay runs the same
// locked contract.
function scopedOutboxUrlForSealKey(value: string | undefined, relaySealKeyBase64: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = new URL(value);
  parsed.searchParams.set("mailboxId", mailboxScopeIdForSealKey(relaySealKeyBase64));
  return parsed.toString();
}

function pairingTtlMs(ttlMinutes: number | undefined, purpose: MobilePairingPurpose = "phone-control"): number {
  // A machine enrollment is installed once and revoked by removing the
  // machine, so it is not bound by the short phone-link window.
  const maxMinutes = purpose === "machine-host" ? Number.MAX_SAFE_INTEGER : MAX_PAIRING_TTL_MINUTES;
  const minutes = ttlMinutes === undefined
    ? DEFAULT_PAIRING_TTL_MINUTES
    : Math.max(1, Math.min(maxMinutes, Math.floor(ttlMinutes)));
  return minutes * 60 * 1000;
}

function normalizedOptionalUrl(value: string | undefined, protocols: string[], label: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = new URL(trimmed);
  // A relay on this computer (wrangler dev, the reference relay) speaks plain
  // ws:; anything that leaves the machine must be wss:.
  const loopbackPlainWs = parsed.protocol === "ws:" && protocols.includes("wss:") && isLoopbackHost(parsed.hostname);
  if (!protocols.includes(parsed.protocol) && !loopbackPlainWs) {
    throw new Error(`${label} must use ${protocols.join(" or ")}.`);
  }
  return parsed.toString();
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
}

function pairingFingerprint(value: unknown): string {
  return sha256Hex(stableJson(value))
    .slice(0, 24)
    .toUpperCase()
    .match(/.{1,4}/g)
    ?.join("-") ?? "";
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

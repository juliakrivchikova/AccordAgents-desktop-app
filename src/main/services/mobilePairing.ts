import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  type CreateMobilePairingRequest,
  type CreateMobilePairingResult,
  MOBILE_PAIRING_VERSION,
  mobilePairingPwaUrl,
  mobilePairingPayloadForQr,
  type MobilePairingPackage
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
    const expiresAt = new Date(createdAtDate.getTime() + pairingTtlMs(request.ttlMinutes)).toISOString();
    const issuer = {
      originId: identity.originId,
      keyId: identity.keyId,
      publicKeyDerBase64: identity.publicKeyDerBase64
    };
    const stableRoutingId = `route-${sha256Hex(stableJson(issuer)).slice(0, 32)}`;
    const relaySealKeyBase64 = randomBytes(32).toString("base64url");
    const scopedOutboxUrl = scopedOutboxUrlForSealKey(outboxUrl, relaySealKeyBase64);
    const capability = purpose === "phone-control" ? {
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

function pairingTtlMs(ttlMinutes: number | undefined): number {
  const minutes = ttlMinutes === undefined
    ? DEFAULT_PAIRING_TTL_MINUTES
    : Math.max(1, Math.min(MAX_PAIRING_TTL_MINUTES, Math.floor(ttlMinutes)));
  return minutes * 60 * 1000;
}

function normalizedOptionalUrl(value: string | undefined, protocols: string[], label: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = new URL(trimmed);
  if (!protocols.includes(parsed.protocol)) {
    throw new Error(`${label} must use ${protocols.join(" or ")}.`);
  }
  return parsed.toString();
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

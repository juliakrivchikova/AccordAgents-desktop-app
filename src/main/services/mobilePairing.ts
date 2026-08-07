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
import type { ChatEventLogService } from "./chatEventLog";

const DEFAULT_PAIRING_TTL_MINUTES = 10;
const MAX_PAIRING_TTL_MINUTES = 24 * 60;

export class MobilePairingService {
  constructor(
    private readonly eventLog: ChatEventLogService,
    private readonly now: () => Date = () => new Date()
  ) {}

  async createPairing(request: CreateMobilePairingRequest): Promise<CreateMobilePairingResult> {
    const conversationId = request.conversationId.trim();
    if (!conversationId) {
      throw new Error("Mobile pairing requires a conversationId.");
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
    const capability = {
      scope: "conversation" as const,
      conversationId,
      canRead: true,
      canWrite: true,
      canRunCloudParticipants: request.canRunCloudParticipants !== false,
      canInviteOthers: request.canInviteOthers === true
    };
    const relaySealKeyBase64 = randomBytes(32).toString("base64url");
    const fingerprint = pairingFingerprint({
      issuer,
      stableRoutingId,
      relaySealKeyBase64,
      relayUrl,
      mailboxUrl,
      outboxUrl,
      staticOriginUrl,
      capability
    });
    const pairing: MobilePairingPackage = {
      version: MOBILE_PAIRING_VERSION,
      purpose: request.purpose ?? "phone-control",
      issuer,
      rendezvousId: `rv-${randomUUID()}`,
      stableRoutingId,
      relaySealKeyBase64,
      ...(relayUrl ? { relayUrl } : {}),
      ...(mailboxUrl ? { mailboxUrl } : {}),
      ...(outboxUrl ? { outboxUrl } : {}),
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

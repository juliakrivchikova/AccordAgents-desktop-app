import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  type CreateMobilePairingRequest,
  type CreateMobilePairingResult,
  MOBILE_PAIRING_VERSION,
  mobilePairingPayloadForQr,
  type MobilePairingPackage
} from "../../shared/mobilePairing";
import { stableJson } from "../../shared/stableJson";
import type { DeviceIdentityService } from "./deviceIdentity";
import { isAcceptableHubUrl } from "../../shared/hubProtocol";

const DEFAULT_PAIRING_TTL_MINUTES = 10;

export class MobilePairingService {
  constructor(
    private readonly deviceIdentity: Pick<DeviceIdentityService, "getOrCreateDeviceIdentity">,
    private readonly now: () => Date = () => new Date()
  ) {}

  /** A machine's enrollment with this desktop, on the User's server (the
   *  only place a machine meets its devices). The key it carries seals the
   *  machine's first hello; everything after uses keys of the device pair. */
  async createPairing(request: CreateMobilePairingRequest): Promise<CreateMobilePairingResult> {
    const purpose = request.purpose ?? "machine-host";
    if (purpose !== "machine-host") throw new Error("A phone pairs with your server from Settings → Device pairing.");
    // A local test hub runs on plain http; the User's real one is https.
    const hubUrl = normalizedOptionalUrl(request.hubUrl, ["https:", "http:"], "hubUrl");
    if (!hubUrl) throw new Error("Set up your server first (Settings → Your server): machines connect through it.");
    if (!isAcceptableHubUrl(hubUrl)) throw new Error("A hub is reached over HTTPS (plain HTTP only on this computer).");
    const identity = await this.deviceIdentity.getOrCreateDeviceIdentity();
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
    const capability = {
      scope: "device" as const,
      canRead: true,
      canWrite: true,
      canRunCloudParticipants: request.canRunCloudParticipants !== false,
      canListConversations: true,
      canInviteOthers: false
    };
    const fingerprint = pairingFingerprint({ issuer, stableRoutingId, relaySealKeyBase64, capability, hubUrl });
    const pairing: MobilePairingPackage = {
      version: MOBILE_PAIRING_VERSION,
      purpose,
      issuer,
      rendezvousId: `rv-${randomUUID()}`,
      stableRoutingId,
      relaySealKeyBase64,
      hubUrl,
      capabilities: [capability],
      fingerprint,
      createdAt,
      expiresAt
    };
    return { package: pairing, qrPayload: mobilePairingPayloadForQr(pairing) };
  }
}

/** A machine enrollment is installed once and revoked by removing the
 *  machine, so it is not bound by a short window. */
function pairingTtlMs(ttlMinutes: number | undefined): number {
  const minutes = ttlMinutes === undefined ? DEFAULT_PAIRING_TTL_MINUTES : Math.max(1, Math.floor(ttlMinutes));
  return minutes * 60 * 1000;
}

function normalizedOptionalUrl(value: string | undefined, protocols: string[], label: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const parsed = new URL(trimmed);
  if (!protocols.includes(parsed.protocol)) throw new Error(`${label} must use ${protocols.join(" or ")}.`);
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

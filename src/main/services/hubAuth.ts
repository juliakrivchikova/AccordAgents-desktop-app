import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, verify } from "node:crypto";
import { HUB_AUTH_MAX_SKEW_MS, HUB_AUTH_SCHEME, hubRequestSigningText } from "../../shared/hubProtocol";

/** A device identity as the chat event log keeps it. */
export interface HubSigningIdentity {
  originId: string;
  publicKeyDerBase64: string;
  privateKeyDerBase64: string;
}

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** The device id a public key stands for, as every device derives it. */
export function deviceIdForPublicKey(publicKeyDerBase64: string): string {
  return `device-${sha256Hex(Buffer.from(publicKeyDerBase64, "base64")).slice(0, 32)}`;
}

/** The Authorization header for one request to the hub. */
export function signHubRequest(identity: HubSigningIdentity, request: {
  method: string;
  pathWithQuery: string;
  body?: Buffer | string;
  now?: number;
}): string {
  const timestampMs = request.now ?? Date.now();
  const nonce = randomBytes(12).toString("base64url");
  const text = hubRequestSigningText({
    method: request.method,
    pathWithQuery: request.pathWithQuery,
    timestampMs,
    nonce,
    bodySha256Hex: sha256Hex(request.body ?? "")
  });
  const key = createPrivateKey({ key: Buffer.from(identity.privateKeyDerBase64, "base64"), format: "der", type: "pkcs8" });
  const signature = sign(null, Buffer.from(text, "utf8"), key).toString("base64url");
  return `${HUB_AUTH_SCHEME} ${identity.originId}.${timestampMs}.${nonce}.${signature}`;
}

export interface ParsedHubAuthorization {
  deviceId: string;
  timestampMs: number;
  nonce: string;
  signature: string;
}

export function parseHubAuthorization(header: string | undefined): ParsedHubAuthorization | undefined {
  if (!header || !header.startsWith(`${HUB_AUTH_SCHEME} `)) return undefined;
  const parts = header.slice(HUB_AUTH_SCHEME.length + 1).trim().split(".");
  if (parts.length !== 4) return undefined;
  const [deviceId, ms, nonce, signature] = parts;
  const timestampMs = Number(ms);
  if (!/^device-[0-9a-f]{32}$/.test(deviceId) || !Number.isSafeInteger(timestampMs) ||
      !/^[A-Za-z0-9_-]{8,64}$/.test(nonce) || !/^[A-Za-z0-9_-]{40,200}$/.test(signature)) return undefined;
  return { deviceId, timestampMs, nonce, signature };
}

/**
 * Whether a signed request is genuine and fresh: the key is the device's own
 * (its id derives from it), the signature covers this method, path, time,
 * nonce and body, the clock is close, and the nonce was not seen before.
 */
export function verifyHubRequest(auth: ParsedHubAuthorization, request: {
  method: string;
  pathWithQuery: string;
  body: Buffer | string;
  publicKeyDerBase64: string;
  now: number;
  seenNonce: (deviceId: string, nonce: string, timestampMs: number) => boolean;
}): boolean {
  if (deviceIdForPublicKey(request.publicKeyDerBase64) !== auth.deviceId) return false;
  if (Math.abs(request.now - auth.timestampMs) > HUB_AUTH_MAX_SKEW_MS) return false;
  const text = hubRequestSigningText({
    method: request.method,
    pathWithQuery: request.pathWithQuery,
    timestampMs: auth.timestampMs,
    nonce: auth.nonce,
    bodySha256Hex: sha256Hex(request.body)
  });
  let valid = false;
  try {
    const key = createPublicKey({ key: Buffer.from(request.publicKeyDerBase64, "base64"), format: "der", type: "spki" });
    valid = verify(null, Buffer.from(text, "utf8"), key, Buffer.from(auth.signature, "base64url"));
  } catch {
    return false;
  }
  // A replay inside the clock window is refused by its nonce.
  return valid && !request.seenNonce(auth.deviceId, auth.nonce, auth.timestampMs);
}

/** Remembers nonces for as long as their requests could still be fresh. */
export class HubNonceCache {
  private readonly seen = new Map<string, number>();

  constructor(private readonly windowMs = 2 * HUB_AUTH_MAX_SKEW_MS) {}

  /** True when this nonce was already used; records it otherwise. */
  checkAndRemember(deviceId: string, nonce: string, timestampMs: number, now: number): boolean {
    if (this.seen.size > 50_000) this.prune(now);
    const key = `${deviceId}:${nonce}`;
    if (this.seen.has(key)) return true;
    this.seen.set(key, timestampMs);
    return false;
  }

  private prune(now: number): void {
    for (const [key, at] of this.seen) if (now - at > this.windowMs) this.seen.delete(key);
  }
}

/** An Ed25519 signature over a text, standard base64 (invites, enrollments). */
export function signHubText(identity: Pick<HubSigningIdentity, "privateKeyDerBase64">, text: string): string {
  const key = createPrivateKey({ key: Buffer.from(identity.privateKeyDerBase64, "base64"), format: "der", type: "pkcs8" });
  return sign(null, Buffer.from(text, "utf8"), key).toString("base64");
}

export function verifyHubText(publicKeyDerBase64: string, text: string, signatureBase64: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyDerBase64, "base64"), format: "der", type: "spki" });
    return verify(null, Buffer.from(text, "utf8"), key, Buffer.from(signatureBase64, "base64"));
  } catch {
    return false;
  }
}

/** The node half of a phone certificate check (see verifyHubPhoneCertificate). */
export const hubCertificateCrypto = {
  verify: verifyHubText,
  sha256Hex: (text: string) => sha256Hex(text),
  deviceIdForPublicKey
};

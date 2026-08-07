import { webcrypto } from "node:crypto";

export interface MobileRelaySealedEnvelope {
  v: 1;
  alg: "A256GCM";
  iv: string;
  ct: string;
}

export async function sealMobileRelayPayload(payload: unknown, relaySealKeyBase64: string): Promise<string> {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const key = await importRelaySealKey(relaySealKeyBase64, ["encrypt"]);
  const ciphertext = await webcrypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(JSON.stringify(payload))
  );
  return JSON.stringify({
    v: 1,
    alg: "A256GCM",
    iv: Buffer.from(iv).toString("base64url"),
    ct: Buffer.from(ciphertext).toString("base64url")
  } satisfies MobileRelaySealedEnvelope);
}

export async function openMobileRelayPayload<Payload = unknown>(
  sealedPayload: string,
  relaySealKeyBase64: string
): Promise<Payload> {
  const envelope = assertSealedEnvelope(JSON.parse(sealedPayload));
  const key = await importRelaySealKey(relaySealKeyBase64, ["decrypt"]);
  const plaintext = await webcrypto.subtle.decrypt(
    { name: "AES-GCM", iv: Buffer.from(envelope.iv, "base64url") },
    key,
    Buffer.from(envelope.ct, "base64url")
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as Payload;
}

function assertSealedEnvelope(value: unknown): MobileRelaySealedEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Mobile relay sealed payload must be an object.");
  }
  const envelope = value as Partial<MobileRelaySealedEnvelope>;
  if (envelope.v !== 1 || envelope.alg !== "A256GCM") {
    throw new Error("Unsupported mobile relay sealed payload.");
  }
  assertBase64Url(envelope.iv, "iv");
  assertBase64Url(envelope.ct, "ct");
  return envelope as MobileRelaySealedEnvelope;
}

async function importRelaySealKey(
  relaySealKeyBase64: string,
  keyUsages: Array<"encrypt" | "decrypt">
): Promise<any> {
  assertBase64Url(relaySealKeyBase64, "relaySealKeyBase64");
  return webcrypto.subtle.importKey(
    "raw",
    Buffer.from(relaySealKeyBase64, "base64url"),
    "AES-GCM",
    false,
    keyUsages
  );
}

function assertBase64Url(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`Mobile relay ${label} must be base64url.`);
  }
}

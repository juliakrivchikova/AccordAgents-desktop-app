import { webcrypto } from "node:crypto";
import { deriveMachineChannelKey } from "../../shared/machineChannelKey";

/** A payload sealed with a symmetric key (AES-256-GCM): the key a machine's
 *  enrollment carries, or one derived for a pair of devices. */
interface SealedEnvelope {
  v: 1;
  alg: "A256GCM";
  iv: string;
  ct: string;
}

export async function sealChannelPayload(payload: unknown, keyBase64: string): Promise<string> {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const key = await importChannelKey(keyBase64, ["encrypt"]);
  const ciphertext = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(payload)));
  return JSON.stringify({
    v: 1, alg: "A256GCM", iv: Buffer.from(iv).toString("base64url"), ct: Buffer.from(ciphertext).toString("base64url")
  } satisfies SealedEnvelope);
}

export async function openChannelPayload<Payload = unknown>(sealedPayload: string, keyBase64: string): Promise<Payload> {
  const envelope = assertSealedEnvelope(JSON.parse(sealedPayload));
  const key = await importChannelKey(keyBase64, ["decrypt"]);
  const plaintext = await webcrypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(envelope.iv, "base64url") }, key, Buffer.from(envelope.ct, "base64url"));
  return JSON.parse(new TextDecoder().decode(plaintext)) as Payload;
}

function assertSealedEnvelope(value: unknown): SealedEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("A sealed payload must be an object.");
  const envelope = value as Partial<SealedEnvelope>;
  if (envelope.v !== 1 || envelope.alg !== "A256GCM") throw new Error("Unsupported sealed payload.");
  assertBase64Url(envelope.iv, "iv");
  assertBase64Url(envelope.ct, "ct");
  return envelope as SealedEnvelope;
}

async function importChannelKey(keyBase64: string, keyUsages: Array<"encrypt" | "decrypt">): Promise<webcrypto.CryptoKey> {
  assertBase64Url(keyBase64, "key");
  return webcrypto.subtle.importKey("raw", Buffer.from(keyBase64, "base64url"), "AES-GCM", false, keyUsages);
}

function assertBase64Url(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`A sealed payload's ${label} must be base64url.`);
}

type Identity = { publicKeyDerBase64: string; privateKeyDerBase64: string };
const channelKeys = new WeakMap<Identity, Map<string, string>>();

// Bound work to the device pairs, rather than repeating elliptic-curve work
// for every fragment of a large chat. Roster authorization precedes lookup.
function channelKey(identity: Identity, peer: string, room: string): string {
  let keys = channelKeys.get(identity);
  if (!keys) { keys = new Map(); channelKeys.set(identity, keys); }
  const id = JSON.stringify([peer, room]);
  const previous = keys.get(id);
  if (previous) return previous;
  const key = deriveMachineChannelKey(identity, peer, room);
  if (keys.size >= 128) keys.delete(keys.keys().next().value!);
  keys.set(id, key);
  return key;
}

/** The public sender identity is only a key selector. AEAD binds the two
 * identities and room; domain signatures and the pinned roster still decide
 * authority. No private key or derived channel key is sent. */
export async function sealMachinePayload(payload: unknown, identity: Identity,
  peerPublicKeyDerBase64: string, room: string): Promise<string> {
  const ciphertext = await sealChannelPayload(payload, channelKey(identity, peerPublicKeyDerBase64, room));
  return JSON.stringify({ ...JSON.parse(ciphertext), senderPublicKeyDerBase64: identity.publicKeyDerBase64 });
}

export async function openMachinePayload(ciphertext: string, identity: Identity,
  allowedPublicKeys: readonly string[] | undefined, room: string): Promise<unknown> {
  const envelope = JSON.parse(ciphertext) as { senderPublicKeyDerBase64?: unknown };
  const sender = envelope?.senderPublicKeyDerBase64;
  if (typeof sender !== "string" || (allowedPublicKeys && !allowedPublicKeys.includes(sender))) {
    throw new Error("Machine channel requires a trusted device key; update older devices to reconnect.");
  }
  return openChannelPayload(ciphertext, channelKey(identity, sender, room));
}

import { deriveMachineChannelKey } from "../../shared/machineChannelKey";
import { openMobileRelayPayload, sealMobileRelayPayload } from "./mobileRelaySealing";

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
export async function sealMachineRelayPayload(payload: unknown, identity: Identity,
  peerPublicKeyDerBase64: string, room: string): Promise<string> {
  const ciphertext = await sealMobileRelayPayload(payload, channelKey(identity, peerPublicKeyDerBase64, room));
  return JSON.stringify({ ...JSON.parse(ciphertext), senderPublicKeyDerBase64: identity.publicKeyDerBase64 });
}

export async function openMachineRelayPayload(ciphertext: string, identity: Identity,
  allowedPublicKeys: readonly string[] | undefined, room: string): Promise<unknown> {
  const envelope = JSON.parse(ciphertext) as { senderPublicKeyDerBase64?: unknown };
  const sender = envelope?.senderPublicKeyDerBase64;
  if (typeof sender !== "string" || (allowedPublicKeys && !allowedPublicKeys.includes(sender))) {
    throw new Error("Machine channel requires a trusted device key; update older devices to reconnect.");
  }
  return openMobileRelayPayload(ciphertext, channelKey(identity, sender, room));
}

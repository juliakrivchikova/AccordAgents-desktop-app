import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

// RFC 8410 DER forms exported by Node and WebCrypto: Ed25519 SPKI and
// version-0 PKCS8 containing a 32-byte seed, with absent algorithm parameters.
// Intentionally not a general ASN.1 parser: other algorithms, optional fields,
// noncanonical encodings and trailing data are rejected, never sliced away.
// https://www.rfc-editor.org/rfc/rfc8410.html#section-10
const PUBLIC_PREFIX = Uint8Array.of(0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00);
const PRIVATE_PREFIX = Uint8Array.of(0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20);
const KEY_CONTEXT = "accordagents.machine-channel.ed25519-x25519-hkdf-sha256.v1";
const KEY_SALT = sha256(utf8ToBytes(KEY_CONTEXT));

function readDerKey(encoded: string, prefix: Uint8Array, label: string): Uint8Array {
  const invalid = () => new Error(`Invalid machine channel ${label} Ed25519 key encoding.`);
  const byteLength = prefix.length + 32;
  if (typeof encoded !== "string" || encoded.length !== Math.ceil(byteLength / 3) * 4
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw invalid();
  let binary: string;
  try { binary = atob(encoded); } catch { throw invalid(); }
  // Re-encoding rejects nonzero padding bits and missing/extra padding too.
  if (binary.length !== byteLength || btoa(binary) !== encoded
    || !prefix.every((byte, index) => byte === binary.charCodeAt(index))) throw invalid();
  return Uint8Array.from(binary.slice(prefix.length), (character) => character.charCodeAt(0));
}

function validatePeerPublicKey(publicKey: Uint8Array): void {
  try {
    // Strict RFC 8032 decoding, not ZIP215's permissive consensus decoding.
    const point = ed25519.Point.fromBytes(publicKey, false);
    if (point.isSmallOrder() || !point.isTorsionFree()) throw new Error("Invalid subgroup.");
  } catch {
    throw new Error("Invalid machine channel peer Ed25519 public key.");
  }
}

/**
 * Derive one 32-byte AES key, encoded as unpadded base64url, for these two
 * persisted identities in this exact room. Both endpoints use this same
 * synchronous browser-compatible implementation; no key or identity is cached.
 *
 * Conversion uses noble-curves 1.9.7's vetted Ed25519 seed/public conversion,
 * followed by X25519 and HKDF-SHA256. References:
 * https://github.com/paulmillr/noble-curves/blob/1.9.7/src/abstract/edwards.ts
 * https://libsodium.gitbook.io/doc/advanced/ed25519-curve25519
 * https://www.rfc-editor.org/rfc/rfc7748.html#section-6.1
 *
 * This reuses long-lived signing identities to support existing enrollments;
 * it has NO forward secrecy. Compromise of either private identity exposes
 * recorded traffic for that pair. Separate ephemeral exchange keys would be
 * preferable in a new enrollment protocol, as the libsodium guidance explains.
 * A peer must already be authenticated by the trust roster; DH alone does not
 * authorize it. Binding both full Ed25519 public keys prevents ambiguity from
 * the two Edwards points that map to one Montgomery public key.
 *
 * This does not rotate legacy room seals or protect historical ciphertext
 * sealed with them. Any caller accepting a legacy seal still accepts traffic
 * using that old secret; callers must enforce authorization independently.
 */
export function deriveMachineChannelKey(
  identity: { privateKeyDerBase64: string; publicKeyDerBase64: string },
  peerPublicKeyDerBase64: string,
  room: string
): string {
  if (typeof room !== "string" || room.length === 0) throw new Error("Machine channel room is required.");
  const localPublic = readDerKey(identity.publicKeyDerBase64, PUBLIC_PREFIX, "local public");
  const peerPublic = readDerKey(peerPublicKeyDerBase64, PUBLIC_PREFIX, "peer public");
  validatePeerPublicKey(peerPublic);
  const seed = readDerKey(identity.privateKeyDerBase64, PRIVATE_PREFIX, "local private");
  let privateKey: Uint8Array | undefined;
  let sharedSecret: Uint8Array | undefined;
  let key: Uint8Array | undefined;
  try {
    const expectedPublic = ed25519.getPublicKey(seed);
    if (!expectedPublic.every((byte, index) => byte === localPublic[index])) {
      throw new Error("Machine channel local public and private keys do not match.");
    }
    privateKey = ed25519.utils.toMontgomerySecret(seed);
    // Noble also rejects an all-zero X25519 shared secret.
    sharedSecret = x25519.getSharedSecret(privateKey, ed25519.utils.toMontgomery(peerPublic));
    const publicKeys = [bytesToHex(localPublic), bytesToHex(peerPublic)].sort();
    // JSON frames every field unambiguously and preserves exact room strings,
    // including delimiters and unpaired surrogates, without UTF-8 collisions.
    const info = utf8ToBytes(JSON.stringify([KEY_CONTEXT, room, ...publicKeys]));
    key = hkdf(sha256, sharedSecret, KEY_SALT, info, 32);
    return btoa(String.fromCharCode(...key)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  } finally {
    // Best effort only: JS and the caller's persisted strings are not wiped.
    seed.fill(0);
    privateKey?.fill(0);
    sharedSecret?.fill(0);
    key?.fill(0);
  }
}

import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey,
  diffieHellman, generateKeyPairSync, hkdfSync, webcrypto } from "node:crypto";
import test from "node:test";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { deriveMachineChannelKey } from "../../shared/machineChannelKey";

type Identity = Parameters<typeof deriveMachineChannelKey>[0];
const ED_PUBLIC_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const ED_PRIVATE_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const X_PRIVATE_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

function identityFromPrivate(privateKey: ReturnType<typeof createPrivateKey>): Identity {
  return {
    publicKeyDerBase64: createPublicKey(privateKey).export({ format: "der", type: "spki" }).toString("base64"),
    privateKeyDerBase64: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64")
  };
}

function nativeIdentity(): Identity {
  return identityFromPrivate(generateKeyPairSync("ed25519").privateKey);
}

function publicDer(raw: Uint8Array): string {
  return Buffer.concat([ED_PUBLIC_PREFIX, raw]).toString("base64");
}

function rawPublic(identity: Identity): Buffer {
  return Buffer.from(identity.publicKeyDerBase64, "base64").subarray(ED_PUBLIC_PREFIX.length);
}

function nativeExchangePrivate(identity: Identity): ReturnType<typeof createPrivateKey> {
  // Independent native SHA512 + X25519 oracle for the Ed25519 seed conversion.
  const seed = Buffer.from(identity.privateKeyDerBase64, "base64").subarray(ED_PRIVATE_PREFIX.length);
  const scalar = createHash("sha512").update(seed).digest().subarray(0, 32);
  scalar[0] &= 248;
  scalar[31] = (scalar[31] & 127) | 64;
  return createPrivateKey({ key: Buffer.concat([X_PRIVATE_PREFIX, scalar]), format: "der", type: "pkcs8" });
}

test("native persisted Ed25519 identities derive the same stable 32-byte key on both sides", () => {
  const alice = nativeIdentity();
  const bob = nativeIdentity();
  const key = deriveMachineChannelKey(alice, bob.publicKeyDerBase64, "room");
  assert.match(key, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(key, "base64url").length, 32);
  assert.equal(key, deriveMachineChannelKey(bob, alice.publicKeyDerBase64, "room"));
  assert.equal(key, deriveMachineChannelKey(JSON.parse(JSON.stringify(alice)), bob.publicKeyDerBase64, "room"));
});

test("WebCrypto PKCS8/SPKI exports interoperate with native identities", async () => {
  const pair = await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  assert.ok("privateKey" in pair);
  const phone: Identity = {
    privateKeyDerBase64: Buffer.from(await webcrypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64"),
    publicKeyDerBase64: Buffer.from(await webcrypto.subtle.exportKey("spki", pair.publicKey)).toString("base64")
  };
  const desktop = nativeIdentity();
  assert.equal(deriveMachineChannelKey(phone, desktop.publicKeyDerBase64, "phone-room"),
    deriveMachineChannelKey(desktop, phone.publicKeyDerBase64, "phone-room"));
});

test("a third device cannot decrypt another pair's traffic or impersonate their local identity", () => {
  const alice = nativeIdentity();
  const bob = nativeIdentity();
  const third = nativeIdentity();
  const key = deriveMachineChannelKey(alice, bob.publicKeyDerBase64, "room");
  const nonce = Buffer.alloc(12, 1);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "base64url"), nonce);
  const ciphertext = Buffer.concat([cipher.update("private machine result", "utf8"), cipher.final()]);
  const decrypt = (candidate: string): string => {
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(candidate, "base64url"), nonce);
    decipher.setAuthTag(cipher.getAuthTag());
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  };
  assert.equal(decrypt(deriveMachineChannelKey(bob, alice.publicKeyDerBase64, "room")), "private machine result");
  for (const peer of [alice, bob]) {
    assert.throws(() => decrypt(deriveMachineChannelKey(third, peer.publicKeyDerBase64, "room")));
  }
  assert.throws(() => deriveMachineChannelKey({ ...alice, privateKeyDerBase64: third.privateKeyDerBase64 },
    bob.publicKeyDerBase64, "room"), /public and private keys do not match/);
});

test("exact rooms and full Ed25519 identities separate keys even for equivalent Montgomery points", () => {
  const alice = nativeIdentity();
  const bob = nativeIdentity();
  const rooms = ["room", "room\u0000", " room", "room ", "room|other", "é", "e\u0301", "\ud800", "\ud801"];
  assert.equal(new Set(rooms.map(room => deriveMachineChannelKey(alice, bob.publicKeyDerBase64, room))).size, rooms.length);
  const bobNegated = ed25519.Point.fromBytes(rawPublic(bob)).negate().toBytes();
  assert.deepEqual(ed25519.utils.toMontgomery(bobNegated), ed25519.utils.toMontgomery(rawPublic(bob)));
  assert.notEqual(deriveMachineChannelKey(alice, publicDer(bobNegated), "room"),
    deriveMachineChannelKey(alice, bob.publicKeyDerBase64, "room"));
  assert.throws(() => deriveMachineChannelKey(alice, bob.publicKeyDerBase64, ""), /room is required/);
});

test("derivation agrees with native X25519 and HKDF-SHA256", () => {
  const alice = nativeIdentity();
  const bob = nativeIdentity();
  const aPrivate = nativeExchangePrivate(alice);
  const bPrivate = nativeExchangePrivate(bob);
  const shared = diffieHellman({ privateKey: aPrivate, publicKey: createPublicKey(bPrivate) });
  assert.deepEqual(shared, diffieHellman({ privateKey: bPrivate, publicKey: createPublicKey(aPrivate) }));
  const context = "accordagents.machine-channel.ed25519-x25519-hkdf-sha256.v1";
  const info = JSON.stringify([context, "native-oracle", ...[rawPublic(alice).toString("hex"), rawPublic(bob).toString("hex")].sort()]);
  const expected = Buffer.from(hkdfSync("sha256", shared, createHash("sha256").update(context).digest(), Buffer.from(info), 32));
  assert.equal(deriveMachineChannelKey(alice, bob.publicKeyDerBase64, "native-oracle"), expected.toString("base64url"));
});

test("the conversion agrees with libsodium's published vector and X25519 with RFC 7748", () => {
  // https://github.com/jedisct1/libsodium/blob/1.0.20/test/default/ed25519_convert.c
  // https://github.com/jedisct1/libsodium/blob/1.0.20/test/default/ed25519_convert.exp
  const seed = Buffer.from("421151a459faeade3d247115f94aedae42318124095afabe4d1451a559faedee", "hex");
  const identity = identityFromPrivate(createPrivateKey({
    key: Buffer.concat([ED_PRIVATE_PREFIX, seed]), format: "der", type: "pkcs8"
  }));
  assert.equal(Buffer.from(ed25519.utils.toMontgomerySecret(seed)).toString("hex"),
    "8052030376d47112be7f73ed7a019293dd12ad910b654455798b4667d73de166");
  assert.equal(Buffer.from(ed25519.utils.toMontgomery(rawPublic(identity))).toString("hex"),
    "f1814f0e8ff1043d8a44d25babff3cedcae6c22c3edaa48f857ae70de2baae50");
  // https://www.rfc-editor.org/rfc/rfc7748.html#section-6.1
  const secret = x25519.getSharedSecret(
    Buffer.from("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a", "hex"),
    Buffer.from("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f", "hex"));
  assert.equal(Buffer.from(secret).toString("hex"), "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742");
});

test("noncanonical base64, malformed DER and other key algorithms are rejected", () => {
  const alice = nativeIdentity();
  const bob = nativeIdentity();
  const publicBytes = Buffer.from(bob.publicKeyDerBase64, "base64");
  const privateBytes = Buffer.from(alice.privateKeyDerBase64, "base64");
  const changed = (bytes: Buffer, index: number, value: number): string => {
    const copy = Buffer.from(bytes); copy[index] = value; return copy.toString("base64");
  };
  const paddingAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const publicString = bob.publicKeyDerBase64;
  const badPadding = publicString.slice(0, -2) + paddingAlphabet[paddingAlphabet.indexOf(publicString.at(-2)!) + 1] + "=";
  for (const value of ["", "!".repeat(publicString.length), publicString + "\n", publicString.slice(0, -1), badPadding,
    publicBytes.subarray(12).toString("base64"), Buffer.concat([publicBytes, Buffer.of(0)]).toString("base64"),
    changed(publicBytes, 8, 0x6e), changed(publicBytes, 11, 1), changed(publicBytes, 1, 0x29)]) {
    assert.throws(() => deriveMachineChannelKey(alice, value, "room"), /key encoding/);
    assert.throws(() => deriveMachineChannelKey({ ...alice, publicKeyDerBase64: value }, bob.publicKeyDerBase64, "room"), /key encoding/);
  }
  for (const value of ["", alice.privateKeyDerBase64 + "=", privateBytes.subarray(16).toString("base64"),
    Buffer.concat([privateBytes, Buffer.of(0)]).toString("base64"), changed(privateBytes, 4, 1),
    changed(privateBytes, 11, 0x6e), changed(privateBytes, 14, 0x03)]) {
    assert.throws(() => deriveMachineChannelKey({ ...alice, privateKeyDerBase64: value }, bob.publicKeyDerBase64, "room"), /key encoding/);
  }
});

test("invalid, noncanonical, small-order and mixed-torsion peer points are rejected", () => {
  const alice = nativeIdentity();
  const orderFour = ed25519.Point.fromBytes(new Uint8Array(32));
  const invalidPoints = [
    Buffer.alloc(32), // y=0, order four
    Buffer.from("01" + "00".repeat(31), "hex"), // identity, order one
    Buffer.from("ec" + "ff".repeat(30) + "7f", "hex"), // y=-1, order two
    Buffer.from("ed" + "ff".repeat(30) + "7f", "hex"), // y=p, noncanonical
    Buffer.from("01" + "00".repeat(30) + "80", "hex"), // noncanonical sign of x=0
    Buffer.from("02" + "00".repeat(31), "hex"), // not on the curve
    ed25519.Point.BASE.add(orderFour).toBytes() // not small-order, but contains torsion
  ];
  for (const point of invalidPoints) {
    assert.throws(() => deriveMachineChannelKey(alice, publicDer(point), "room"), /peer Ed25519 public key/);
  }
});

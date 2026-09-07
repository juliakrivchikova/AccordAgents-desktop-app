// The phone as a device of its own, able to command a machine directly.
//
// Until now the phone spoke only to the desktop: it sealed what it sent, and
// the desktop did the rest. With the desktop closed there was nobody to do the
// rest. A machine answers signed events from devices in its trust roster, so
// the phone needs two things it did not have: a signing key of its own, and a
// way to put a sealed event into the machine's room.
//
// Both are here, and both are the same contract the desktop uses — the same
// canonical bytes, the same event hash, the same Ed25519 signature over it —
// so a machine cannot tell (and does not need to tell) which of the owner's
// devices sent a command.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AccordMachineCommand = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  const IDENTITY_KEY = "machine-command-identity";

  function subtle() {
    const crypto = globalThis.crypto;
    if (!crypto || !crypto.subtle) throw new Error("This browser has no WebCrypto.");
    return crypto.subtle;
  }

  function bytesToBase64(bytes) {
    let binary = "";
    const view = new Uint8Array(bytes);
    for (let index = 0; index < view.length; index += 1) binary += String.fromCharCode(view[index]);
    return btoa(binary);
  }

  function base64ToBytes(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  function textBytes(value) {
    return new TextEncoder().encode(value);
  }

  async function sha256Hex(bytes) {
    const digest = await subtle().digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  // Byte-for-byte the desktop's stableJson: sorted keys, undefined dropped.
  function stableJson(value) {
    if (value === undefined) return "null";
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
    if (value && typeof value === "object") {
      const record = value;
      return `{${Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
        .join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
  }

  /**
   * This phone's signing identity.
   *
   * Ed25519 is what a device id is derived from on every other device, so the
   * same key type is used here rather than a second scheme the machines would
   * have to learn. A browser without it says so plainly instead of falling
   * back to something a machine will refuse.
   */
  async function createIdentity() {
    let pair;
    try {
      pair = await subtle().generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    } catch (error) {
      throw new Error("This device cannot sign machine commands: its browser has no Ed25519.");
    }
    const spki = new Uint8Array(await subtle().exportKey("spki", pair.publicKey));
    const pkcs8 = new Uint8Array(await subtle().exportKey("pkcs8", pair.privateKey));
    const hash = await sha256Hex(spki);
    return {
      deviceId: `device-${hash.slice(0, 32)}`,
      keyId: `ed25519-${hash.slice(0, 32)}`,
      publicKeyDerBase64: bytesToBase64(spki),
      privateKeyDerBase64: bytesToBase64(pkcs8),
      createdAt: new Date().toISOString()
    };
  }

  /** Loads the stored identity, creating one the first time. */
  async function ensureIdentity(store) {
    const existing = await store.get(IDENTITY_KEY);
    if (existing && existing.deviceId && existing.privateKeyDerBase64) return existing;
    const identity = await createIdentity();
    await store.set(IDENTITY_KEY, identity);
    return identity;
  }

  async function signingKey(identity) {
    return subtle().importKey(
      "pkcs8",
      base64ToBytes(identity.privateKeyDerBase64),
      { name: "Ed25519" },
      false,
      ["sign"]
    );
  }

  /**
   * One signed event, in the shape every machine already verifies.
   *
   * `originSeq` and `prevHash` are this phone's own per-scope chain: a machine
   * applies an origin's events only in contiguous order, so the caller keeps
   * the last sequence and hash for the scope it is writing to.
   */
  async function mintEvent(identity, request) {
    const payloadHash = `sha256:${await sha256Hex(textBytes(stableJson(request.payload)))}`;
    const logicalTs = request.logicalTs
      ?? [String(request.originSeq).padStart(16, "0"), identity.deviceId, request.logScopeId].join(":");
    const unsigned = {
      eventId: request.eventId,
      conversationId: request.conversationId,
      logScopeId: request.logScopeId,
      originId: identity.deviceId,
      originSeq: request.originSeq,
      logicalTs,
      kind: request.kind,
      payloadHash,
      prevHash: request.prevHash ?? null,
      keyId: identity.keyId,
      createdAt: request.createdAt ?? new Date().toISOString()
    };
    const eventHash = `sha256:${await sha256Hex(textBytes(stableJson(unsigned)))}`;
    const signature = bytesToBase64(new Uint8Array(
      await subtle().sign({ name: "Ed25519" }, await signingKey(identity), textBytes(eventHash))
    ));
    const event = { ...unsigned, payload: request.payload, eventHash, signature };
    if (request.prevHash) event.prevHash = request.prevHash;
    else delete event.prevHash;
    return event;
  }

  /** The device-event packet a machine's channel reads. */
  function eventPacket(from, to, event) {
    return { protocol: "accord-device-events-v1", from, to, type: "event", event };
  }

  /** The signature every device puts on an event: over its event hash. */
  async function signEventHash(identity, eventHash) {
    return bytesToBase64(new Uint8Array(
      await subtle().sign({ name: "Ed25519" }, await signingKey(identity), textBytes(eventHash))
    ));
  }

  async function verifyingKey(publicKeyDerBase64) {
    return subtle().importKey("spki", base64ToBytes(publicKeyDerBase64), { name: "Ed25519" }, false, ["verify"]);
  }

  /**
   * The signature on a transport packet, over the packet itself.
   *
   * A room's seal proves the sender is in the room. It does not prove *which*
   * device sent this, and an acknowledgement is exactly a claim about which
   * device applied something — it releases the sender's retained history. So
   * every packet that is not an event carries this signature, and an event
   * carries its own immutable one instead.
   *
   * Byte-for-byte src/main/services/devicePacketAuthentication.ts.
   */
  function packetBytes(packet) {
    const unsigned = {};
    for (const key of Object.keys(packet)) if (key !== "signature") unsigned[key] = packet[key];
    return textBytes("accord-device-packet-v1:" + stableJson(unsigned));
  }

  async function signPacket(identity, packet) {
    if (packet.from !== identity.deviceId) throw new Error("Cannot sign another device's packet.");
    const signature = bytesToBase64(new Uint8Array(
      await subtle().sign({ name: "Ed25519" }, await signingKey(identity), packetBytes(packet))
    ));
    return { ...packet, signature };
  }

  async function verifyPacket(packet, publicKeyDerBase64) {
    if (!packet || typeof packet.signature !== "string") return false;
    try {
      return await subtle().verify({ name: "Ed25519" }, await verifyingKey(publicKeyDerBase64),
        base64ToBytes(packet.signature), packetBytes(packet));
    } catch {
      return false;
    }
  }

  /**
   * An event's own signature, checked the way every other device checks it:
   * the payload has to hash to what the envelope claims, the envelope has to
   * hash to its event hash, and that hash has to be signed by the origin.
   *
   * Byte-for-byte verifySignedChatEvent in src/main/services/chatEventLog.ts.
   */
  async function verifyEvent(event, publicKeyDerBase64) {
    if (!event || typeof event.signature !== "string") return false;
    const unsigned = {
      eventId: event.eventId,
      conversationId: event.conversationId,
      logScopeId: event.logScopeId,
      originId: event.originId,
      originSeq: event.originSeq,
      logicalTs: event.logicalTs,
      kind: event.kind,
      payloadHash: event.payloadHash,
      prevHash: event.prevHash === undefined ? null : event.prevHash,
      keyId: event.keyId,
      createdAt: event.createdAt
    };
    try {
      if (`sha256:${await sha256Hex(textBytes(stableJson(event.payload)))}` !== event.payloadHash) return false;
      if (`sha256:${await sha256Hex(textBytes(stableJson(unsigned)))}` !== event.eventHash) return false;
      return await subtle().verify({ name: "Ed25519" }, await verifyingKey(publicKeyDerBase64),
        base64ToBytes(event.signature), textBytes(event.eventHash));
    } catch {
      return false;
    }
  }

  /** Whether this browser can sign and verify what a machine requires. Said
   *  plainly, rather than assuming every phone is the one that was tested. */
  async function capabilities() {
    try {
      const pair = await subtle().generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
      const signature = await subtle().sign({ name: "Ed25519" }, pair.privateKey, textBytes("probe"));
      const verified = await subtle().verify({ name: "Ed25519" }, pair.publicKey, signature, textBytes("probe"));
      return { ed25519: verified === true };
    } catch (error) {
      return { ed25519: false, reason: String((error && error.message) || error) };
    }
  }

  /**
   * Asks a machine to run a member's turn.
   *
   * The command carries its own id, so the same ask delivered twice — live and
   * again from the mailbox, or after this phone is restarted — is one turn on
   * the machine and not two.
   */
  function turnRequest(request) {
    return {
      type: "machine.turn.request",
      conversationId: request.conversationId,
      participantId: request.participant.id,
      participant: request.participant,
      messageId: request.messageId,
      runId: request.runId,
      pendingMessageId: request.pendingMessageId,
      requestedAt: request.requestedAt ?? new Date().toISOString()
    };
  }

  function cancelRequest(request) {
    return { type: "machine.turn.cancel", conversationId: request.conversationId, runId: request.runId };
  }

  return {
    stableJson,
    sha256Hex,
    textBytes,
    bytesToBase64,
    base64ToBytes,
    signEventHash,
    signPacket,
    verifyPacket,
    verifyEvent,
    capabilities,
    createIdentity,
    ensureIdentity,
    mintEvent,
    eventPacket,
    turnRequest,
    cancelRequest,
    machineCommandEventId: (runId) => `machine-command:${runId}`,
    machineCancelEventId: (runId) => `machine-cancel:${runId}`,
    deviceEventScope: (rendezvousId, conversationId, scope) =>
      `device:${rendezvousId}:${JSON.stringify([conversationId, scope || "actions"])}`
  };
});

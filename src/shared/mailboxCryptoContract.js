// Canonical mailbox crypto contract (W4). THIS FILE IS THE SINGLE SOURCE:
// scripts/generate-mailbox-crypto.mjs copies it verbatim into the PWA
// (src/mobile/mobile-app.js, between the generated markers), into the cloud
// runner script (src/main/services/mobileMailboxRunnerCrypto.generated.ts),
// and regenerates the known-answer fixture
// (scripts/mailbox-contract-vectors.json). Edit here, run the generator, and
// commit the regenerated outputs together — a stale copy is a review failure.
//
// Plain JS with zero imports so the same text runs in the browser page, the
// phone's service worker, and the cloud runner (Node >= 18.17 exposes
// globalThis.crypto). Constants must match src/shared/mailboxSealedPayload.ts;
// the generator refuses to run when they drift.
(function () {
  var MAILBOX_AUTH_TOKEN_INFO = "accord-mailbox-auth-v1";
  var MAILBOX_SCOPE_ID_INFO = "accord-mailbox-scope-v1";
  var MAILBOX_SCOPE_ID_PREFIX = "mb-";
  var MAILBOX_SCOPE_ID_LENGTH = 32;

  function subtle() {
    if (!globalThis.crypto || !globalThis.crypto.subtle) {
      throw new Error("Mailbox crypto requires WebCrypto.");
    }
    return globalThis.crypto.subtle;
  }

  function textToBytesC(value) {
    return new TextEncoder().encode(value);
  }

  function base64UrlToBytesC(value) {
    var normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    var padded = normalized + "===".slice((normalized.length + 3) % 4);
    var binary = atob(padded);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  function bytesToBase64UrlC(bytes) {
    var binary = "";
    for (var i = 0; i < bytes.length; i += 1) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  async function importSealKey(sealKeyBase64Url, usages) {
    return subtle().importKey("raw", base64UrlToBytesC(sealKeyBase64Url), "AES-GCM", false, usages);
  }

  // Seals a payload into the shared envelope: AES-256-GCM, 12-byte iv,
  // WebCrypto layout (auth tag appended to the ciphertext), base64url fields.
  async function sealToEnvelope(payload, sealKeyBase64Url) {
    var iv = new Uint8Array(12);
    globalThis.crypto.getRandomValues(iv);
    var key = await importSealKey(sealKeyBase64Url, ["encrypt"]);
    var ciphertext = await subtle().encrypt({ name: "AES-GCM", iv: iv }, key, textToBytesC(JSON.stringify(payload)));
    return {
      v: 1,
      alg: "A256GCM",
      iv: bytesToBase64UrlC(iv),
      ct: bytesToBase64UrlC(new Uint8Array(ciphertext))
    };
  }

  async function openEnvelope(envelope, sealKeyBase64Url) {
    if (!envelope || envelope.v !== 1 || envelope.alg !== "A256GCM") {
      throw new Error("Unsupported sealed mailbox payload.");
    }
    var key = await importSealKey(sealKeyBase64Url, ["decrypt"]);
    var plaintext = await subtle().decrypt(
      { name: "AES-GCM", iv: base64UrlToBytesC(envelope.iv) },
      key,
      base64UrlToBytesC(envelope.ct)
    );
    return JSON.parse(new TextDecoder().decode(plaintext));
  }

  // Both mailbox credentials are one-way HMAC-SHA256 derivations from the
  // pairing seal key; the relay can never recover the key from either.
  async function deriveAccess(sealKeyBase64Url) {
    var key = await subtle().importKey(
      "raw",
      base64UrlToBytesC(sealKeyBase64Url),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    var token = bytesToBase64UrlC(new Uint8Array(
      await subtle().sign("HMAC", key, textToBytesC(MAILBOX_AUTH_TOKEN_INFO))
    ));
    var scopeDigest = bytesToBase64UrlC(new Uint8Array(
      await subtle().sign("HMAC", key, textToBytesC(MAILBOX_SCOPE_ID_INFO))
    ));
    return {
      token: token,
      scopeId: MAILBOX_SCOPE_ID_PREFIX + scopeDigest.slice(0, MAILBOX_SCOPE_ID_LENGTH)
    };
  }

  globalThis.AccordMailboxCrypto = {
    MAILBOX_AUTH_TOKEN_INFO: MAILBOX_AUTH_TOKEN_INFO,
    MAILBOX_SCOPE_ID_INFO: MAILBOX_SCOPE_ID_INFO,
    MAILBOX_SCOPE_ID_PREFIX: MAILBOX_SCOPE_ID_PREFIX,
    MAILBOX_SCOPE_ID_LENGTH: MAILBOX_SCOPE_ID_LENGTH,
    sealToEnvelope: sealToEnvelope,
    openEnvelope: openEnvelope,
    deriveAccess: deriveAccess
  };
})();

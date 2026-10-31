// The phone's key cannot be read out of it.
//
// The phone signs every request to the User's server with its own key. It
// used to keep that key as text in IndexedDB, so any script that ever ran on
// the phone's site (a compromised deploy, a browser extension, a future
// injection bug) could copy it and act as the phone from anywhere, for good.
// Now a new key is a non-extractable WebCrypto key, kept as the key object,
// and a phone paired before keeps its pairing: its key, kept as text, becomes
// a non-extractable key on the next launch, the same key, nothing paired
// again, and the text is gone.
//
// Runs the real built PWA in Chrome against a real hub, like the other mobile
// harnesses.
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { rm } from "node:fs/promises";
import { HUB_PAIRING_KEY, attachApp, pairPage, launchChrome, member, serveMobileShell, sleep, startMobileHub, tempProfile } from "./mobile-hub-fixture.mjs";

const require = createRequire(import.meta.url);
const SITE_PORT = 8187;
const CDP_PORT = 9357;

const pairingOf = (app) => app.evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(HUB_PAIRING_KEY)}) || "null")`);
const identityRecord = (app) => app.evaluate(`(async () => {
  const db = await self.AccordMobileDb.openControlDb(indexedDB);
  const record = await new Promise((resolve) => {
    const request = db.transaction("meta").objectStore("meta").get("hub-identity");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(undefined);
  });
  db.close();
  if (!record) return null;
  let exported = "no key";
  if (record.privateKey) {
    try { await crypto.subtle.exportKey("pkcs8", record.privateKey); exported = "exported"; } catch { exported = "refused"; }
  }
  return {
    deviceId: record.deviceId,
    hasText: "privateKeyDerBase64" in record,
    isKey: record.privateKey instanceof CryptoKey,
    extractable: record.privateKey ? record.privateKey.extractable : null,
    exported
  };
})()`);

test("a phone paired now keeps a key that cannot be exported", { timeout: 120_000 }, async () => {
  const hub = await startMobileHub();
  const site = await serveMobileShell({ port: SITE_PORT, hubOrigins: [hub.base] });
  const profile = await tempProfile("aa-mobile-key-new-");
  const chrome = launchChrome({ port: CDP_PORT, profile, url: `${site.origin}/`, width: 430, height: 860 });
  let app;
  try {
    await hub.createChat("chat-new-phone", { title: "New phone", participants: [member("drew")] });
    app = await attachApp({ port: CDP_PORT });
    await pairPage(app, { hub, siteOrigin: site.origin });
    const sealed = await identityRecord(app);
    assert.deepEqual({ hasText: sealed.hasText, isKey: sealed.isKey, extractable: sealed.extractable, exported: sealed.exported },
      { hasText: false, isKey: true, extractable: false, exported: "refused" }, "the phone's key cannot be read out");
    assert.equal((await pairingOf(app)).deviceId, sealed.deviceId);
  } finally {
    app?.close?.();
    chrome.kill("SIGKILL");
    await site.close().catch(() => undefined);
    await hub.close();
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("a phone paired before keeps its pairing; its key kept as text becomes a non-extractable key", { timeout: 180_000 }, async () => {
  const { enrollHubPhone, bytesToBase64, sha256Hex } = require("../dist/main/shared/hubDeviceClient.js");
  const hub = await startMobileHub();
  const site = await serveMobileShell({ port: SITE_PORT + 1, hubOrigins: [hub.base] });
  const profile = await tempProfile("aa-mobile-key-seal-");
  const chrome = launchChrome({ port: CDP_PORT + 1, profile, url: `${site.origin}/`, width: 430, height: 860 });
  let app;
  try {
    await hub.createChat("chat-old-phone", { title: "Old phone", participants: [member("drew")] });
    // A phone's key the way phones kept it before: extractable, as text.
    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    const hash = await sha256Hex(spki);
    const legacy = {
      deviceId: `device-${hash.slice(0, 32)}`, keyId: `ed25519-${hash.slice(0, 32)}`,
      publicKeyDerBase64: bytesToBase64(spki), privateKeyDerBase64: bytesToBase64(pkcs8), createdAt: new Date().toISOString()
    };
    const code = await hub.invite();
    const answer = await enrollHubPhone({ hubUrl: hub.base, hubId: hub.hubId, token: code.token, identity: legacy, name: "Phone" });
    assert.equal(answer.deviceId, legacy.deviceId);

    app = await attachApp({ port: CDP_PORT + 1 });
    await app.waitFor(`Boolean(self.AccordMobileDb) && Boolean(globalThis.AccordAgentsMobile)`, "the app is up");
    // What such a phone holds: the key as text and its pairing.
    await app.evaluate(`(async () => {
      const db = await self.AccordMobileDb.openControlDb(indexedDB);
      await new Promise((resolve, reject) => {
        const tx = db.transaction("meta", "readwrite");
        tx.objectStore("meta").put({ key: "hub-identity", ...${JSON.stringify(legacy)} });
        tx.objectStore("meta").put({ key: "hub-pairing", hubUrl: ${JSON.stringify(hub.base)}, hubId: ${JSON.stringify(hub.hubId)}, deviceId: ${JSON.stringify(legacy.deviceId)} });
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
      localStorage.setItem(${JSON.stringify(HUB_PAIRING_KEY)}, JSON.stringify({ hubUrl: ${JSON.stringify(hub.base)}, hubId: ${JSON.stringify(hub.hubId)},
        deviceId: ${JSON.stringify(legacy.deviceId)}, scope: { scope: "device" }, pairedAt: new Date().toISOString(), protocol: 2 }));
    })()`);
    assert.equal((await identityRecord(app)).hasText, true, "the key starts as text");

    // The next launch.
    await app.send("Page.reload", {});
    await app.waitFor(`Boolean(globalThis.AccordAgentsMobile) && JSON.parse(localStorage.getItem("accordagents.mobile.chatList.v1") || "[]").length > 0`,
      "the phone reads its chats with the key it had", 20_000);
    await app.waitFor(`(async () => {
      const db = await self.AccordMobileDb.openControlDb(indexedDB);
      const record = await new Promise((resolve) => { const request = db.transaction("meta").objectStore("meta").get("hub-identity"); request.onsuccess = () => resolve(request.result); });
      db.close();
      return Boolean(record && record.privateKey && !("privateKeyDerBase64" in record));
    })()`, "the key was turned into a non-extractable key");
    const sealed = await identityRecord(app);
    assert.deepEqual(sealed, { deviceId: legacy.deviceId, hasText: false, isKey: true, extractable: false, exported: "refused" }, "same key, no text, not exportable");
    // Still the same phone to the server: nothing was paired again.
    assert.deepEqual((await hub.phones()).map((device) => device.deviceId), [legacy.deviceId]);
    // And it still signs: a fresh read after another launch works with the sealed key.
    await app.send("Page.reload", {});
    await app.waitFor(`Boolean(globalThis.AccordAgentsMobile) && document.querySelectorAll(".mobile-chat-row").length > 0`, "the chats show after the next launch", 20_000);
    const reads = hub.requests.filter((request) => request.path.startsWith("/v1/phone/") && request.at > Date.now() - 20_000);
    assert.ok(reads.length > 0, "the phone kept reading the server with the sealed key");
  } finally {
    app?.close?.();
    chrome.kill("SIGKILL");
    await site.close().catch(() => undefined);
    await hub.close();
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
});

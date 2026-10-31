// A pairing code is never used at once, and the phone's key cannot be read
// out of it.
//
// A link anyone can put in a chat ("PR #42") can carry a pairing code for
// anyone's server. Opened on a phone, it used to pair the phone with that
// server at once — silently replacing the User's own, sending it what she had
// not sent yet and keeping her old chats on screen. Now:
// (a) a code — opened, pasted or scanned — first asks, naming the server's
//     address, and pairs nothing until the User says yes; Cancel pairs nothing;
// (b) a code for another server than the one the phone is paired with says
//     so, names both, and "Keep current pairing" leaves everything as it was;
// (c) replacing the pairing clears what the phone kept for the old server:
//     its chats, and what it had not sent, never reach the new one;
// (d) another server gets another key.
//
// Runs the real built PWA in Chrome against real hubs, like the other mobile
// harnesses.
import assert from "node:assert/strict";
import test from "node:test";
import { rm } from "node:fs/promises";
import { HUB_PAIRING_KEY, attachApp, launchChrome, member, pairPage, serveMobileShell, sleep, startMobileHub, tempProfile } from "./mobile-hub-fixture.mjs";

const SITE_PORT = 8362;
const CDP_PORT = 9512;

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
const promptText = (app) => app.evaluate(`document.querySelector(".pairing-confirm") ? document.querySelector(".pairing-confirm").textContent : ""`);
const tapPrompt = (app, label) => app.evaluate(`(() => {
  const button = [...document.querySelectorAll("#chat-list button")].find((item) => item.textContent === ${JSON.stringify(label)});
  if (!button) return false;
  button.click();
  return true;
})()`);
const listedChats = (app) => app.evaluate(`JSON.parse(localStorage.getItem("accordagents.mobile.chatList.v1") || "[]").map((chat) => chat.id).sort()`);

test("a pairing code asks first, names the server, and another server gets nothing this phone kept", { timeout: 240_000 }, async () => {
  const hubA = await startMobileHub();
  const hubB = await startMobileHub();
  const site = await serveMobileShell({ port: SITE_PORT, hubOrigins: [hubA.base, hubB.base] });
  const profile = await tempProfile("aa-mobile-pair-confirm-");
  const chrome = launchChrome({ port: CDP_PORT, profile, url: `${site.origin}/`, width: 430, height: 860 });
  let app;
  try {
    await hubA.createChat("chat-on-a", { title: "On A", participants: [member("drew")] });
    await hubB.createChat("chat-on-b", { title: "On B", participants: [member("drew")] });
    app = await attachApp({ port: CDP_PORT });
    const hostA = new URL(hubA.base).host;
    const hostB = new URL(hubB.base).host;

    // (a) An unpaired phone opened at a code: it asks, names the server, and
    // pairs nothing until the yes; the code is already gone from the address.
    const first = await hubA.invite();
    await app.send("Page.navigate", { url: first.url(site.origin) });
    await app.waitFor(`Boolean(document.querySelector(".pairing-confirm"))`, "the phone asks before it pairs", 20_000);
    assert.ok((await promptText(app)).includes(hostA), `the question names the server: ${await promptText(app)}`);
    assert.equal(await app.evaluate(`location.hash`), "", "the code left the address bar");
    await sleep(800);
    assert.equal(hubA.requests.filter((request) => request.path === "/v1/phone/enroll").length, 0, "nothing was sent to the server before the yes");
    assert.equal((await hubA.phones()).length, 0, "the server has no phone yet");
    assert.ok(await tapPrompt(app, "Cancel"), "Cancel is offered");
    await app.waitFor(`!document.querySelector(".pairing-confirm")`, "Cancel closes the question");
    assert.equal(await pairingOf(app), null, "Cancel pairs nothing");
    assert.equal((await hubA.phones()).length, 0, "Cancel enrolls nothing");

    // Paired with A, with the yes: tapped twice in a row, it pairs once.
    const second = await hubA.invite();
    await app.send("Page.navigate", { url: second.url(site.origin) });
    await app.waitFor(`Boolean(document.querySelector("#chat-list .pairing-submit"))`, "the phone asks before it pairs", 20_000);
    await app.evaluate(`(() => { const button = document.querySelector("#chat-list .pairing-submit"); button.click(); button.click(); })()`);
    await app.waitFor(`Boolean(localStorage.getItem(${JSON.stringify(HUB_PAIRING_KEY)}))`, "paired with A", 20_000);
    await app.waitFor(`Boolean(globalThis.AccordAgentsMobile) && JSON.parse(localStorage.getItem("accordagents.mobile.chatList.v1") || "[]").length > 0`, "A's chats are read", 20_000);
    await sleep(800);
    assert.equal(hubA.requests.filter((request) => request.method === "POST" && request.path === "/v1/phone/enroll").length, 1, "one tap's worth of pairing");
    assert.equal(await app.evaluate(`Boolean(document.querySelector(".pairing-confirm"))`), false, "no failure replaced the chats");
    assert.equal((await pairingOf(app)).hubUrl, hubA.base);
    // (d) The key is a non-extractable key, not text.
    const sealed = await identityRecord(app);
    assert.deepEqual({ hasText: sealed.hasText, isKey: sealed.isKey, extractable: sealed.extractable, exported: sealed.exported },
      { hasText: false, isKey: true, extractable: false, exported: "refused" }, "the phone's key cannot be read out");

    // A message for A that A has not taken yet.
    await app.evaluate(`document.querySelector('.mobile-chat-row[data-conversation-id="chat-on-a"]').click()`);
    await app.waitFor(`Boolean(document.getElementById("composer-input")) && document.getElementById("timeline-screen").classList.contains("is-active")`, "chat on A is open");
    hubA.setGate(async (request) => (request.method === "POST" && request.path === "/v3/ops" ? { drop: true } : undefined));
    await app.evaluate(`(() => {
      const input = document.getElementById("composer-input");
      input.value = "secret meant for A";
      document.getElementById("composer-form").dispatchEvent(new Event("submit", { cancelable: true }));
    })()`);
    await app.waitFor(`AccordAgentsMobile.listOutboxEntries().then((entries) => entries.some((entry) => entry.payload && entry.payload.content === "secret meant for A"))`,
      "the message waits for A");

    // (b) A code for another server: it says this replaces the pairing, names
    // both servers; keeping the current pairing leaves everything as it was.
    const other = await hubB.invite();
    await app.send("Page.navigate", { url: other.url(site.origin) });
    await app.waitFor(`Boolean(document.querySelector(".pairing-confirm"))`, "the phone asks before replacing its pairing", 20_000);
    const replacing = await promptText(app);
    assert.ok(replacing.includes(hostA) && replacing.includes(hostB), `both servers are named: ${replacing}`);
    assert.match(replacing, /not sent yet are cleared/, "it says what replacing clears");
    assert.ok(await tapPrompt(app, "Keep current pairing"), "keeping the pairing is offered");
    await app.waitFor(`!document.querySelector(".pairing-confirm") && Boolean(document.querySelector('.mobile-chat-row[data-conversation-id="chat-on-a"]'))`,
      "the chats of A are back");
    assert.equal((await pairingOf(app)).hubUrl, hubA.base, "still paired with A");
    assert.equal((await hubB.phones()).length, 0, "B enrolled nothing");
    assert.ok(await app.evaluate(`AccordAgentsMobile.listOutboxEntries().then((entries) => entries.some((entry) => entry.payload && entry.payload.content === "secret meant for A"))`),
      "the message still waits for A");

    // (c) Replacing it: B's chats only, nothing kept for A, and A's message never reaches B.
    const again = await hubB.invite();
    await app.send("Page.navigate", { url: again.url(site.origin) });
    await app.waitFor(`Boolean(document.querySelector(".pairing-confirm"))`, "the phone asks again", 20_000);
    assert.ok(await tapPrompt(app, "Replace pairing"), "replacing is offered");
    await app.waitFor(`JSON.parse(localStorage.getItem(${JSON.stringify(HUB_PAIRING_KEY)}) || "{}").hubUrl === ${JSON.stringify(hubB.base)}`, "paired with B", 20_000);
    await app.waitFor(`Boolean(globalThis.AccordAgentsMobile) && JSON.parse(localStorage.getItem("accordagents.mobile.chatList.v1") || "[]").length > 0`, "B's chats are read", 20_000);
    assert.deepEqual(await listedChats(app), ["chat-on-b"], "only B's chats are on the phone");
    assert.equal(await app.evaluate(`AccordAgentsMobile.listOutboxEntries().then((entries) => entries.length)`), 0, "nothing kept for A waits to be sent");
    await sleep(1500);
    const sentToB = hubB.opsRequests.flatMap((request) => request.ops).concat(hubB.requests.filter((request) => request.ops).flatMap((request) => request.ops));
    assert.ok(!JSON.stringify(sentToB).includes("secret meant for A"), "A's message never reached B");
    assert.equal((await hubB.phones()).length, 1, "B has the phone");
    assert.notEqual((await identityRecord(app)).deviceId, sealed.deviceId, "another server, another key");
  } finally {
    app?.close?.();
    chrome.kill("SIGKILL");
    await site.close().catch(() => undefined);
    await hubA.close();
    await hubB.close();
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
});

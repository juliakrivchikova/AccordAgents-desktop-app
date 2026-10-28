// W-G(a): pairing credentials leave the address bar once the pairing is
// read, and a pairing made the old way (through the desktop's relay) is used
// for nothing.
//
// (a) A pairing URL surviving in history, screenshots or share sheets must
// not be able to pair anyone else: after the phone pairs with the User's
// server from the code the desktop shows, the code (the fragment and the
// `pair` parameter) is gone from the address, while non-credential params
// (the qa debug flag) survive. A link made the old way is scrubbed the same
// way and pairs nothing.
// (b) A phone that still holds an old pairing says once, plainly, that it has
// to pair again, and what that pairing kept on the phone is cleared; pairing
// with the server takes the note away. A phone already paired with the server
// drops an old pairing it still holds without a word.
//
// Runs the real built PWA in Chrome against a real hub, like the other mobile
// harnesses.
import assert from "node:assert/strict";
import test from "node:test";
import { rm } from "node:fs/promises";
import { HUB_PAIRING_KEY, attachApp, launchChrome, member, pairPage, serveMobileShell, sleep, startMobileHub, tempProfile } from "./mobile-hub-fixture.mjs";

const SITE_PORT = 8181;
const CDP_PORT = 9349;
const OLD_PAIRING_KEY = "accordagents.mobile.pairing.v1";
const OLD_NOTICE = "This phone was paired the old way. Pair it again from Settings on your Mac.";

test("pairing credentials leave the URL; an old pairing is cleared and said once", { timeout: 180_000 }, async () => {
  const hub = await startMobileHub();
  const site = await serveMobileShell({ port: SITE_PORT, hubOrigins: [hub.base] });
  const profile = await tempProfile("aa-mobile-hygiene-");
  const chrome = launchChrome({ port: CDP_PORT, profile, url: `${site.origin}/`, width: 430, height: 860 });
  let app;
  try {
    await hub.createChat("chat-hygiene", { title: "Hygiene", participants: [member("drew")] });
    app = await attachApp({ port: CDP_PORT });
    const evaluate = app.evaluate;
    const state = () => evaluate(`(async () => {
      const db = await self.AccordMobileDb.openControlDb(indexedDB);
      const all = (name) => new Promise((resolve) => { const request = db.transaction(name).objectStore(name).getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => resolve([]); });
      const stores = {};
      for (const name of ["sealedEnvelopes", "events", "machineEvents", "machineOutbox", "machineBlobs"]) stores[name] = (await all(name)).length;
      const meta = (await all("meta")).map((record) => record.key);
      const outbox = (await all("outbox")).map((entry) => entry.eventId + (entry.hub ? ":hub" : ""));
      db.close();
      const notices = [...document.querySelectorAll("#chat-list .mobile-empty")].map((node) => node.textContent.trim());
      return {
        href: location.href,
        old: localStorage.getItem(${JSON.stringify(OLD_PAIRING_KEY)}),
        hub: localStorage.getItem(${JSON.stringify(HUB_PAIRING_KEY)}),
        notices, stores, meta, outbox,
        chats: document.querySelectorAll(".mobile-chat-row").length,
        dock: !document.getElementById("home-dock").hidden
      };
    })()`);

    // --- a link made the old way pairs nothing and leaves the address ------
    const KEY = "a".repeat(43);
    await app.send("Page.navigate", { url: `${site.origin}/?rid=rv-hyg&route=route-hyg&cap=CAP-HYG&qa=1#k=${KEY}` });
    await app.waitFor(`Boolean(globalThis.AccordAgentsMobile) && Boolean(document.querySelector("#chat-list .mobile-empty"))`, "the app came up");
    await sleep(1000);
    let now = await state();
    assert.equal(now.old, null, "an old-way link is not kept as a pairing");
    assert.equal(now.hub, null, "and pairs nothing");
    for (const secret of ["rid=", "route=", "cap=", KEY, "#"]) {
      assert.ok(!now.href.includes(secret), `${secret} must leave the URL: ${now.href}`);
    }
    assert.ok(now.href.includes("qa=1"), "non-credential params survive the scrub: " + now.href);
    assert.deepEqual(now.notices.map((text) => text.startsWith("Scan the code from your Mac")), [true], `the phone asks to be paired: ${JSON.stringify(now.notices)}`);
    assert.equal(now.dock, false, "and shows no bar before it is");

    // --- an old pairing held on the phone: one plain notice, data cleared ---
    await evaluate(`(async () => {
      localStorage.setItem(${JSON.stringify(OLD_PAIRING_KEY)}, JSON.stringify({ endpoint: "wss://relay.accordagents.com/v1/relay", relaySealKeyBase64: ${JSON.stringify(KEY)},
        rendezvousId: "rv-old", routingId: "route-old", fingerprint: "CAP-OLD", pairedAt: new Date(0).toISOString() }));
      localStorage.setItem("accordagents.mobile.mailboxCursor.v1", JSON.stringify({ epoch: "e1", cursor: 7 }));
      const db = await self.AccordMobileDb.openControlDb(indexedDB);
      const tx = db.transaction(["meta", "sealedEnvelopes", "events", "machineEvents", "machineOutbox", "machineBlobs", "outbox"], "readwrite");
      tx.objectStore("meta").put({ key: "mailboxAccess", endpointUrl: "https://relay.accordagents.com/v1/mailbox/events", mailboxId: "mb-x", token: "t", cursor: 7 });
      tx.objectStore("meta").put({ key: "machine-command-identity", deviceId: "d" });
      tx.objectStore("meta").put({ key: "machine-access", machines: [] });
      tx.objectStore("meta").put({ key: "machine-change-order:o:c", seq: 1 });
      tx.objectStore("meta").put({ key: "chatTitles", titles: { kept: "Kept" } });
      tx.objectStore("sealedEnvelopes").put({ eventId: "env-1" });
      tx.objectStore("events").put({ eventId: "ev-1", originId: "o", logScopeId: "s", conversationId: "c" });
      tx.objectStore("machineEvents").put({ eventId: "mev-1", originId: "o", logScopeId: "s" });
      tx.objectStore("machineOutbox").put({ eventId: "mout-1" });
      tx.objectStore("machineBlobs").put({ key: "blob:1" });
      tx.objectStore("outbox").put({ eventId: "relay-entry", conversationId: "c", kind: "message.created", payload: { content: "old" }, status: "waiting-to-sync", createdAt: new Date(0).toISOString(), attempts: 0 });
      await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
      db.close();
      return true;
    })()`);
    await app.send("Page.reload", {});
    await app.waitFor(`Boolean(globalThis.AccordAgentsMobile) && Boolean(document.querySelector("#chat-list .mobile-empty"))`, "the app came up again");
    await sleep(1000);
    now = await state();
    assert.deepEqual(now.notices, [OLD_NOTICE], `one plain notice says why: ${JSON.stringify(now.notices)}`);
    assert.equal(now.old, null, "the old pairing is gone");
    assert.equal(await evaluate(`localStorage.getItem("accordagents.mobile.mailboxCursor.v1")`), null, "with its mailbox cursor");
    assert.deepEqual(now.stores, { sealedEnvelopes: 0, events: 0, machineEvents: 0, machineOutbox: 0, machineBlobs: 0 }, "what the old way kept is cleared");
    for (const key of ["mailboxAccess", "machine-command-identity", "machine-access", "machine-change-order:o:c"]) {
      assert.ok(!now.meta.includes(key), `${key} is cleared: ${JSON.stringify(now.meta)}`);
    }
    assert.ok(now.meta.includes("chatTitles"), "what is not the old pairing's is kept");
    assert.deepEqual(now.outbox, [], "the queue in the relay's form is cleared");
    assert.equal(now.dock, false, "no bar while unpaired");
    // The note stays until the phone is paired again, across a launch.
    await app.send("Page.reload", {});
    await app.waitFor(`Boolean(globalThis.AccordAgentsMobile) && Boolean(document.querySelector("#chat-list .mobile-empty"))`, "the app came up a third time");
    await sleep(500);
    assert.deepEqual((await state()).notices, [OLD_NOTICE], "the note survives a relaunch");

    // --- pairing with the server: the code leaves the address --------------
    await pairPage(app, { hub, siteOrigin: site.origin, query: "qa=1" });
    await app.waitFor(`document.querySelectorAll(".mobile-chat-row").length === 1`, "the chats from the server");
    now = await state();
    assert.ok(now.hub, "the phone is paired with the server");
    assert.equal((await hub.phones()).length, 1, "and the server knows it");
    for (const secret of ["pair=", "hub=", "t=", "#"]) {
      assert.ok(!now.href.includes(secret), `${secret} must leave the URL: ${now.href}`);
    }
    assert.ok(now.href.includes("qa=1"), "non-credential params survive the scrub: " + now.href);
    assert.deepEqual(now.notices, [], "the old-pairing note is gone once paired again");
    assert.equal(await evaluate(`localStorage.getItem("accordagents.mobile.oldPairingCleared.v1")`), null);
    assert.ok(now.meta.includes("hub-identity"), "the phone keeps its own key for the server");

    // --- paired again with a new code: the same phone, not a second one -----
    const firstId = JSON.parse(now.hub).deviceId;
    await pairPage(app, { hub, siteOrigin: site.origin });
    await app.waitFor(`document.querySelectorAll(".mobile-chat-row").length === 1`, "the chats after pairing again");
    const again = JSON.parse((await state()).hub);
    assert.equal(again.deviceId, firstId, "the phone keeps its key when it pairs with the same server again");
    const phones = await hub.phones();
    assert.equal(phones.length, 1, `the server knows one phone, on the new code: ${JSON.stringify(phones.map((phone) => phone.deviceId))}`);
    assert.equal(phones[0].deviceId, firstId);

    // --- a phone paired with the server drops an old pairing silently -------
    await evaluate(`(() => {
      localStorage.setItem(${JSON.stringify(OLD_PAIRING_KEY)}, JSON.stringify({ endpoint: "wss://relay.accordagents.com/v1/relay", relaySealKeyBase64: ${JSON.stringify(KEY)}, pairedAt: new Date(0).toISOString() }));
      return true;
    })()`);
    await app.send("Page.reload", {});
    await app.waitFor(`Boolean(globalThis.AccordAgentsMobile) && document.querySelectorAll(".mobile-chat-row").length === 1`, "the chats after the relaunch");
    now = await state();
    assert.equal(now.old, null, "the old pairing is dropped");
    assert.deepEqual(now.notices, [], "without a notice: this phone is paired");
    assert.ok(now.hub, "and its server pairing stands");
    assert.ok(now.outbox.every((entry) => entry.endsWith(":hub")), `only the server's queue is kept: ${JSON.stringify(now.outbox)}`);
  } finally {
    app?.close();
    chrome.kill("SIGKILL");
    await site.close();
    await hub.close();
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
});

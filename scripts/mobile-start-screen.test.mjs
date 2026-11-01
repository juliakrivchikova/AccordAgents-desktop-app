/**
 * Where the phone starts, and how it gets around from there (the User,
 * 2026-11-01, after Claude's app): a fresh start opens on New chat instead of
 * the chat or tab open last; the menu button at its top opens the chats; the
 * bar's round button starts a new chat; search is in the Chats header; the
 * chat list shows no avatars. A launch that says where to go (a tapped
 * notification) goes there, and coming back to the app keeps its place.
 *
 * Driven through the real PWA in a browser against a real hub. This is
 * desktop Chrome, not the installed phone: it runs the files the phone runs,
 * under the same origin headers.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { rm } from "node:fs/promises";
import { HUB_PAIRING_KEY, attachApp, launchChrome, member, openChat, pairPage, serveMobileShell, sleep, startMobileHub, tempProfile } from "./mobile-hub-fixture.mjs";

const ACTIVE = "accordagents.mobile.activeConversationId.v1";

async function phone(t, { sitePort, cdpPort, otherHubs = [] }) {
  const hub = await startMobileHub();
  const site = await serveMobileShell({ port: sitePort, hubOrigins: [hub.base, ...otherHubs.map((other) => other.base)] });
  const profile = await tempProfile("aa-mobile-start-");
  const chrome = launchChrome({ port: cdpPort, profile, url: `${site.origin}/` });
  let app;
  t.after(async () => {
    app?.close();
    chrome.kill("SIGKILL");
    await site.close();
    await hub.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  await hub.createChat("conv-alpha", { title: "Alpha plans", participants: [member("drew")] });
  await hub.createChat("conv-beta", { title: "Beta bugs", participants: [member("taylor")] });
  const assistant = { id: "t-assistant", handle: "assistant", roleConfigId: "administrator", kind: "codex-cli" };
  const newChat = { projects: [{ path: "/Users/u/site", label: "site" }], defaultProject: "/Users/u/site", assistant,
    members: [{ configId: "c-drew", uses: 1, participant: member("drew", { id: "t-drew", participantConfigId: "c-drew" }) }] };
  const published = await hub.call("PUT", "/v1/catalog", { catalog: { version: 1, publishedAt: new Date().toISOString(),
    roles: { administrator: "Chat Assistant" }, prompts: [], skills: [], avatars: {}, newChat } });
  assert.equal(published.ok, true);
  app = await attachApp({ port: cdpPort });
  await pairPage(app, { hub, siteOrigin: site.origin, query: "qa=1" });
  return { hub, site, app };
}

/** On screen: not hidden, and laid out. */
const shown = (id) => `(() => { const node = document.getElementById(${JSON.stringify(id)}); return Boolean(node && !node.hidden && node.offsetParent !== null); })()`;
const active = (id) => `document.getElementById(${JSON.stringify(id)}).classList.contains("is-active")`;
const offerRead = `document.querySelectorAll("#new-chat-members .new-chat-member").length > 0`;
const rowTitles = `[...document.querySelectorAll("#chat-list .mobile-chat-row strong")].map((node) => node.textContent)`;

/** A tap where a finger would land on the control: whatever is on top there
 *  gets it, so a control under another one is not tapped. */
async function tap(app, id) {
  const point = await app.evaluate(`(() => { const box = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();
    const x = box.left + box.width / 2; const y = box.top + box.height / 2; const hit = document.elementFromPoint(x, y);
    return { x, y, onTop: Boolean(hit && hit.closest(${JSON.stringify("#" + id)})) }; })()`);
  assert.equal(point.onTop, true, `#${id} is on top where it is tapped`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await app.send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", clickCount: 1 });
  }
}

async function reload(app) {
  await app.send("Page.reload", {});
  await app.waitFor(`document.readyState === "complete" && Boolean(globalThis.AccordAgentsMobile)`, "the app after the reload", 20_000);
}

test("a fresh start opens on New chat; its menu opens the chats, the bar starts chats, search is in the header", { timeout: 150_000 }, async (t) => {
  const { app, site } = await phone(t, { sitePort: 8351, cdpPort: 9491 });

  // Opened from a pairing code: the phone shows the chats it just read.
  assert.equal(await app.evaluate(shown("new-chat-screen")), false, "a launch to pair is not sent to New chat");
  await openChat(app, "conv-alpha");
  assert.equal(await app.evaluate(`localStorage.getItem(${JSON.stringify(ACTIVE)})`), "conv-alpha");

  // A fresh start: New chat, with what the computer offers, and not the chat
  // open last. No bar on it.
  await reload(app);
  await app.waitFor(`${shown("new-chat-screen")} && ${offerRead}`, "New chat as the first screen, with the offer");
  assert.equal(await app.evaluate(`localStorage.getItem(${JSON.stringify(ACTIVE)})`), null, "the chat open last is not restored");
  assert.equal(await app.evaluate(shown("home-dock")), false, "no bar on New chat");
  assert.equal(await app.evaluate(`document.getElementById("new-chat-close").getAttribute("aria-label")`), "Chats");

  // The menu button opens the chats, with the bar.
  await tap(app, "new-chat-close");
  await app.waitFor(`${active("chats-screen")} && !${shown("new-chat-screen")} && ${shown("home-dock")}`, "the chats with the bar");
  await app.waitFor(`${rowTitles}.length === 2`, "both chats listed");
  assert.equal(await app.evaluate(`document.querySelectorAll("#chat-list .mobile-chat-row .mobile-chat-avatar, #chat-list .mobile-chat-row .avatar-icon").length`), 0,
    "no avatars on the rows");
  assert.equal(await app.evaluate(`Boolean(document.querySelector(".mobile-chats-header #chat-search-toggle")) && ${shown("chat-search-toggle")}`), true,
    "search is in the Chats header");
  assert.equal(await app.evaluate(`Boolean(document.querySelector("#home-dock #new-chat-button")) && ${shown("new-chat-button")}`), true,
    "the bar's round button is New chat");

  // Search from the header: the bar steps aside while it is open.
  await tap(app, "chat-search-toggle");
  await app.waitFor(`${shown("chat-search")} && !${shown("home-dock")}`, "the search box, with the bar out of the way");
  await app.evaluate(`(() => { const input = document.getElementById("chat-search-input"); input.value = "alpha"; input.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  assert.deepEqual(await app.evaluate(rowTitles), ["Alpha plans"]);
  await app.evaluate(`document.getElementById("chat-search-close").click()`);
  await app.waitFor(`${rowTitles}.length === 2 && ${shown("home-dock")}`, "the whole list and the bar again");

  // A chat opened from the results, then another tab: the search does not
  // follow there and take the bar away.
  await tap(app, "chat-search-toggle");
  await app.evaluate(`(() => { const input = document.getElementById("chat-search-input"); input.value = "alpha"; input.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await openChat(app, "conv-alpha");
  await app.evaluate(`document.querySelector('[data-home-tab="activity"]').click()`);
  await app.waitFor(`${active("activity-screen")} && ${shown("home-dock")} && document.getElementById("chat-search").hidden`, "Activity with its bar, the search closed");
  await app.evaluate(`document.querySelector('[data-home-tab="chats"]').click()`);
  await app.waitFor(`${active("chats-screen")} && ${rowTitles}.length === 2`, "the whole list again");

  // The bar's round button opens New chat; the menu button goes back.
  await tap(app, "new-chat-button");
  await app.waitFor(`${shown("new-chat-screen")} && !${shown("home-dock")}`, "New chat from the bar");
  await tap(app, "new-chat-close");
  await app.waitFor(`${active("chats-screen")} && !${shown("new-chat-screen")}`, "the chats again");

  // Inside a chat the bar is under the composer, with New chat on it and no
  // search; the menu button from there opens the chats and leaves the chat.
  await openChat(app, "conv-beta");
  await app.waitFor(`${shown("new-chat-button")} && !${shown("chat-search-toggle")}`, "New chat on the bar inside a chat, no search");
  await tap(app, "new-chat-button");
  await app.waitFor(shown("new-chat-screen"), "New chat from inside a chat");
  // The chat under it is left: what arrives there meanwhile is not taken as read.
  assert.equal(await app.evaluate(`localStorage.getItem(${JSON.stringify(ACTIVE)}) === null && !${active("timeline-screen")}`), true,
    "New chat from inside a chat leaves that chat");
  await tap(app, "new-chat-close");
  await app.waitFor(`${active("chats-screen")} && localStorage.getItem(${JSON.stringify(ACTIVE)}) === null`, "the chats, the chat left");

  // Back in front while still running is not a start: the chat stays.
  await openChat(app, "conv-alpha");
  await app.evaluate(`document.dispatchEvent(new Event("visibilitychange"))`);
  await sleep(1_500);
  assert.equal(await app.evaluate(`${active("timeline-screen")} && !${shown("new-chat-screen")}`), true, "coming back keeps the chat open");
  assert.equal(await app.evaluate(`localStorage.getItem(${JSON.stringify(ACTIVE)})`), "conv-alpha");

  // A notification tapped while the app rests on New chat opens Activity.
  await reload(app);
  await app.waitFor(shown("new-chat-screen"), "New chat after a fresh start");
  await app.evaluate(`AccordAgentsMobile.openActivityFromNotification("pending")`);
  await app.waitFor(`${active("activity-screen")} && !${shown("new-chat-screen")}`, "Activity from a notification over New chat");

  // From another tab, the menu button opens the chats, not the tab it came from.
  await tap(app, "new-chat-button");
  await app.waitFor(shown("new-chat-screen"), "New chat from Activity");
  await tap(app, "new-chat-close");
  await app.waitFor(`${active("chats-screen")} && localStorage.getItem("accordagents.mobile.homeTab.v1") === "chats"`, "the chats from New chat opened on Activity");

  // A fresh start from Settings opens on New chat too.
  await app.evaluate(`document.querySelector('[data-home-tab="settings"]').click()`);
  await app.waitFor(active("settings-screen"), "Settings");
  await reload(app);
  await app.waitFor(shown("new-chat-screen"), "New chat after a fresh start left on Settings");

  // A link to a chat opens that chat, not New chat.
  await app.send("Page.navigate", { url: `${site.origin}/?qa=1&open=conv-beta` });
  await app.waitFor(`document.readyState === "complete" && ${active("timeline-screen")} &&
    document.getElementById("message-list").dataset.conversationId === "conv-beta"`, "the chat a link names", 20_000);
  await sleep(1_000);
  assert.equal(await app.evaluate(shown("new-chat-screen")), false, "a link's launch is not sent to New chat");
  assert.equal(await app.evaluate(`new URLSearchParams(location.search).has("open")`), false, "the link is used once");

  // A tapped notification opens the app on Activity, not on New chat.
  await app.send("Page.navigate", { url: `${site.origin}/?qa=1&tab=activity` });
  await app.waitFor(`document.readyState === "complete" && ${active("activity-screen")}`, "Activity from a notification", 20_000);
  await sleep(1_000);
  assert.equal(await app.evaluate(shown("new-chat-screen")), false, "a notification's launch is not sent to New chat");
});

test("New chat reads the offer again after no connection or a server error, not after a refusal, and only while it is on screen", { timeout: 240_000 }, async (t) => {
  const { app, hub } = await phone(t, { sitePort: 8353, cdpPort: 9493 });
  // The phone's way to the server for New chat, and whether it thinks it is
  // online, as the page says; every try is counted.
  await app.send("Page.enable");
  await app.send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
    const real = globalThis.fetch;
    globalThis.__attempts = 0;
    globalThis.__mode = sessionStorage.getItem("qa.newChatMode") || "ok";
    globalThis.__online = true;
    // Time on the page's monotonic clock only: signed requests carry the
    // wall clock, and the server refuses one that is off.
    const realNow = performance.now.bind(performance);
    performance.now = () => realNow() + (globalThis.__skew || 0);
    Object.defineProperty(Navigator.prototype, "onLine", { configurable: true, get() { return globalThis.__online; } });
    globalThis.fetch = function (input, init) {
      if (String(input && input.url || input).indexOf("/v1/phone/new-chat") >= 0) {
        globalThis.__attempts += 1;
        if (globalThis.__mode === "offline") return Promise.reject(new TypeError("Failed to fetch"));
        if (globalThis.__mode === "503" || globalThis.__mode === "404") {
          return Promise.resolve(new Response(JSON.stringify({ ok: false, error: "QA" }), { status: Number(globalThis.__mode), headers: { "content-type": "application/json" } }));
        }
      }
      return real.call(this, input, init);
    };
  })()` });
  const note = `(() => { const node = document.getElementById("new-chat-note"); return node.hidden ? "" : node.textContent; })()`;
  const attempts = () => app.evaluate(`globalThis.__attempts`);
  const mode = (value) => app.evaluate(`globalThis.__mode = ${JSON.stringify(value)}`);
  const reopen = async () => {
    await tap(app, "new-chat-close");
    await app.waitFor(active("chats-screen"), "the chats");
    await tap(app, "new-chat-button");
  };

  // No connection at the start: said once, Start off, and a first message typed meanwhile is kept.
  await app.evaluate(`sessionStorage.setItem("qa.newChatMode", "offline")`);
  await reload(app);
  await app.waitFor(`${shown("new-chat-screen")} && ${note}.indexOf("Could not reach your server") >= 0`, "New chat saying the server could not be reached");
  assert.equal(await app.evaluate(`document.getElementById("new-chat-start").disabled`), true);
  assert.equal(await app.evaluate(`${note}.indexOf("could not be reached") < 0`), true, `said once: ${await app.evaluate(note)}`);
  await app.evaluate(`(() => { sessionStorage.removeItem("qa.newChatMode"); const input = document.getElementById("new-chat-input"); input.value = "typed while offline"; input.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await sleep(1_500);

  // (a) By itself, with no other event: the next try of the backoff reads it.
  await mode("ok");
  await app.waitFor(`${shown("new-chat-screen")} && ${offerRead} && ${note}.indexOf("Could not reach") < 0`, "the offer read by the next try", 25_000);
  assert.equal(await app.evaluate(`document.getElementById("new-chat-input").value`), "typed while offline");

  // Left up untouched for long, New chat reads the offer again on coming
  // back, and keeps it as it was once something on it was touched.
  const members = `document.querySelectorAll("#new-chat-members .new-chat-member").length`;
  const publish = async (handles) => {
    const assistant = { id: "t-assistant", handle: "assistant", roleConfigId: "administrator", kind: "codex-cli" };
    const newChat = { projects: [{ path: "/Users/u/site", label: "site" }], defaultProject: "/Users/u/site", assistant,
      members: handles.map((handle, index) => ({ configId: `c-${handle}`, uses: handles.length - index, participant: member(handle, { id: `t-${handle}`, participantConfigId: `c-${handle}` }) })) };
    const published = await hub.call("PUT", "/v1/catalog", { catalog: { version: 1, publishedAt: new Date().toISOString(),
      roles: { administrator: "Chat Assistant" }, prompts: [], skills: [], avatars: {}, newChat } });
    assert.equal(published.ok, true);
  };
  await app.evaluate(`(() => { const input = document.getElementById("new-chat-input"); input.value = ""; input.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  const membersBefore = await app.evaluate(members);
  await publish(["drew", "gera"]);
  await app.evaluate(`(() => { globalThis.__skew = 6 * 60_000; window.dispatchEvent(new Event("online")); })()`);
  await app.waitFor(`${members} === ${membersBefore + 1}`, "the offer read again after a long rest", 15_000);
  await app.evaluate(`(() => { const input = document.getElementById("new-chat-input"); input.value = "a first message"; input.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await publish(["drew", "gera", "maya"]);
  const restedAt = await attempts();
  await app.evaluate(`(() => { globalThis.__skew = 20 * 60_000; window.dispatchEvent(new Event("online")); })()`);
  await sleep(3_000);
  assert.equal(await app.evaluate(members), membersBefore + 1, "touched, the offer on screen stays as it was");
  assert.equal(await app.evaluate(`document.getElementById("new-chat-input").value`), "a first message");
  assert.ok(await attempts() >= restedAt);
  await app.evaluate(`document.getElementById("new-chat-input").value = ""`);

  // (b) No tries while the phone says it is offline, and the tries go on:
  // online again, the next one reads it with no other event.
  await mode("offline");
  await reopen();
  await app.waitFor(`${note}.indexOf("Could not reach your server") >= 0`, "New chat failing again");
  await app.evaluate(`globalThis.__online = false`);
  const offlineFrom = await attempts();
  await mode("ok");
  await sleep(8_000);
  assert.equal(await attempts(), offlineFrom, "nothing tried while offline");
  await app.evaluate(`globalThis.__online = true`);
  await app.waitFor(`${offerRead} && ${note}.indexOf("Could not reach") < 0`, "the offer read by a later try once online", 40_000);

  // (b') Coming back online reads it at once, before the next try is due.
  await mode("offline");
  await reopen();
  await app.waitFor(`${note}.indexOf("Could not reach your server") >= 0`, "New chat failing once more");
  await mode("ok");
  await app.evaluate(`window.dispatchEvent(new Event("online"))`);
  await app.waitFor(`${offerRead} && ${note}.indexOf("Could not reach") < 0`, "the offer read on coming back online", 4_000);

  // (c) A server error is tried again.
  await mode("503");
  await reopen();
  await app.waitFor(`${note}.indexOf("Could not reach your server") >= 0`, "New chat saying the server failed");
  const failedAt = await attempts();
  await app.waitFor(`globalThis.__attempts > ${failedAt}`, "the server error tried again", 10_000);
  await mode("ok");
  await app.waitFor(`${offerRead} && ${note}.indexOf("Could not reach") < 0`, "the offer read once the server answers", 25_000);

  // (d) A server from before New chat on the phone is not asked again and again.
  await mode("404");
  await reopen();
  await app.waitFor(`${note}.indexOf("does not start chats from the phone yet") >= 0`, "the older server's answer");
  const refusedAt = await attempts();
  await sleep(7_000);
  assert.equal(await attempts(), refusedAt, "not tried again");

  // Left for a chat while the offer could not be read, New chat stays shut
  // when the phone is back: the read again is only for New chat on screen.
  await mode("offline");
  await reopen();
  await app.waitFor(`${note}.indexOf("Could not reach your server") >= 0`, "New chat failing once more");
  await tap(app, "new-chat-close");
  await openChat(app, "conv-alpha");
  const leftAt = await attempts();
  const listReads = () => hub.requests.filter((request) => request.path === "/v1/phone/chats").length;
  const readsBefore = listReads();
  await mode("ok");
  await app.evaluate(`window.dispatchEvent(new Event("online"))`);
  const end = Date.now() + 15_000;
  while (listReads() === readsBefore && Date.now() < end) await sleep(100);
  assert.ok(listReads() > readsBefore, "the phone read the chats on coming back");
  await sleep(500);
  assert.equal(await app.evaluate(`${active("timeline-screen")} && !${shown("new-chat-screen")}`), true, "the chat stays on screen");
  assert.equal(await attempts(), leftAt, "and New chat is not read behind it");
});

test("a phone paired for one chat starts in that chat, with no New chat", { timeout: 120_000 }, async (t) => {
  // The server pairs phones for every chat now; a phone paired for one chat
  // before keeps that pairing, and that is what this one holds.
  const { app } = await phone(t, { sitePort: 8355, cdpPort: 9495 });
  await app.evaluate(`(() => { const pairing = JSON.parse(localStorage.getItem(${JSON.stringify(HUB_PAIRING_KEY)}));
    pairing.scope = { scope: "conversation", conversationId: "conv-alpha" };
    localStorage.setItem(${JSON.stringify(HUB_PAIRING_KEY)}, JSON.stringify(pairing));
    localStorage.setItem(${JSON.stringify(ACTIVE)}, "conv-alpha"); })()`);
  await reload(app);
  await app.waitFor(`${active("timeline-screen")} && document.getElementById("message-list").dataset.conversationId === "conv-alpha"`, "the chat it is paired for");
  await sleep(1_000);
  assert.equal(await app.evaluate(shown("new-chat-screen")), false, "no New chat for a phone paired for one chat");
  assert.equal(await app.evaluate(`document.getElementById("new-chat-button").hidden`), true, "and no New chat on its bar");
});

test("a phone taken off the server starts on the note that says so, not on New chat", { timeout: 120_000 }, async (t) => {
  const { app, hub } = await phone(t, { sitePort: 8357, cdpPort: 9497 });
  // Removed while New chat is up: the note replaces it, and nothing beside
  // the note offers New chat or search.
  await tap(app, "new-chat-button");
  await app.waitFor(`${shown("new-chat-screen")} && ${offerRead}`, "New chat with the offer");
  const phoneDevice = (await hub.phones())[0];
  await hub.call("PUT", "/v1/roster", { devices: [{ deviceId: hub.owner.originId, publicKeyDerBase64: hub.owner.publicKeyDerBase64, role: "desktop", name: "Mac" }],
    resolvedInviteIds: [phoneDevice.inviteId] });
  await app.evaluate(`window.dispatchEvent(new Event("online"))`);
  await app.waitFor(`/This phone was removed from your server/.test(document.getElementById("chat-list").innerText) && !${shown("new-chat-screen")}`,
    "the removal said in place of the chats, New chat closed", 20_000);
  assert.equal(await app.evaluate(`${shown("chat-search-toggle")} || ${shown("new-chat-button")}`), false, "no search and no New chat beside the note");
  await reload(app);
  await app.waitFor(`/This phone was removed from your server/.test(document.getElementById("chat-list").innerText) && !${shown("new-chat-screen")}`,
    "the removal said on the chats screen, New chat closed");
  assert.equal(await app.evaluate(`${shown("chat-search-toggle")} || ${shown("new-chat-button")}`), false, "no search and no New chat over the note");
});

test("a phone removed while its chat search is open closes the search for the note", { timeout: 120_000 }, async (t) => {
  const { app, hub } = await phone(t, { sitePort: 8369, cdpPort: 9509 });
  await tap(app, "chat-search-toggle");
  await app.evaluate(`(() => { const input = document.getElementById("chat-search-input"); input.value = "alpha"; input.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await app.waitFor(`${shown("chat-search")} && ${rowTitles}.length === 1`, "the search open with one match");
  const phoneDevice = (await hub.phones())[0];
  await hub.call("PUT", "/v1/roster", { devices: [{ deviceId: hub.owner.originId, publicKeyDerBase64: hub.owner.publicKeyDerBase64, role: "desktop", name: "Mac" }],
    resolvedInviteIds: [phoneDevice.inviteId] });
  await app.evaluate(`window.dispatchEvent(new Event("online"))`);
  await app.waitFor(`/This phone was removed from your server/.test(document.getElementById("chat-list").innerText)`, "the removal note", 20_000);
  assert.deepEqual(await app.evaluate(`({ open: !document.getElementById("chat-search").hidden, query: document.getElementById("chat-search-input").value,
    searching: document.querySelector(".mobile-phone").dataset.searching })`), { open: false, query: "", searching: "0" }, "the search closed and emptied");
});

test("pairing with another server lands on its chats, as pairing with the same one does", { timeout: 150_000 }, async (t) => {
  const other = await startMobileHub();
  t.after(() => other.close());
  await other.createChat("conv-other", { title: "On the other server", participants: [member("drew")] });
  const { app, site, hub } = await phone(t, { sitePort: 8359, cdpPort: 9499, otherHubs: [other] });
  await app.evaluate(`document.querySelector('[data-home-tab="settings"]').click()`);
  await app.waitFor(active("settings-screen"), "Settings before pairing again");
  const code = await other.invite();
  const newChatReads = () => hub.requests.filter((request) => request.path === "/v1/phone/new-chat").length;
  const readsBefore = newChatReads();
  await app.send("Page.navigate", { url: code.url(site.origin) });
  await app.waitFor(`Boolean(document.querySelector(".pairing-confirm"))`, "the phone asks before replacing its pairing", 20_000);
  assert.equal(await app.evaluate(`${shown("new-chat-screen")} || ${shown("chat-search-toggle")} || ${shown("new-chat-button")}`), false,
    "nothing covers the question or sits beside it");
  assert.equal(newChatReads(), readsBefore, "a launch with a pairing code does not open New chat");
  await app.evaluate(`[...document.querySelectorAll("#chat-list button")].find((button) => button.textContent.trim() === "Replace pairing").click()`);
  await app.waitFor(`JSON.parse(localStorage.getItem(${JSON.stringify(HUB_PAIRING_KEY)}) || "{}").hubUrl === ${JSON.stringify(other.base)}`, "paired with the other server", 20_000);
  await app.waitFor(`Boolean(globalThis.AccordAgentsMobile) && ${rowTitles}.includes("On the other server")`, "its chats", 20_000);
  await sleep(1_000);
  assert.equal(await app.evaluate(`${active("chats-screen")} && !${shown("new-chat-screen")}`), true, "the chats, not New chat");
  // The pairing's mark is used once: the next start is a fresh one.
  assert.equal(await app.evaluate(`sessionStorage.getItem("accordagents.mobile.pairedReload.v1")`), null);
  await reload(app);
  await app.waitFor(shown("new-chat-screen"), "New chat on the next fresh start");
});

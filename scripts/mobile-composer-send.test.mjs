/**
 * Two messages sent one after the other while the first is still going out,
 * in the real PWA.
 *
 * The composer sends on the button's pointerup as well as on the form's
 * submit, and a flag made the two paths one send. It was held for the whole
 * send, network included: the second message typed while the first was still
 * being handed over on a slow connection was dropped on the floor, with
 * nothing on screen to say so (the field kept the text, the tap did nothing).
 * And a message queued while a flush was already in flight waited for the
 * retry tick half a minute later, because the flush in flight had read the
 * queue before it was written.
 *
 * This holds the server's answer for a while, sends twice inside that wait,
 * and expects both messages queued and both handed over promptly. The phone
 * is paired with a real hub (the User's own server) and sends to it exactly as
 * it does on her phone. Desktop Chrome, not the installed phone.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { rm } from "node:fs/promises";
import { attachApp, launchChrome, member, pairPage, serveMobileShell, sleep, startMobileHub, tempProfile } from "./mobile-hub-fixture.mjs";

const SITE_PORT = 8275;
const CDP_PORT = 9425;
const CHAT = "chat-send";
// How long the server holds each push: long enough to send again inside it.
const APPEND_HOLD_MS = 2_000;

test("a message sent while the previous one is still going out is queued and handed over", { timeout: 120_000 }, async (t) => {
  const hub = await startMobileHub();
  const site = await serveMobileShell({ port: SITE_PORT, hubOrigins: [hub.base] });
  const profile = await tempProfile("aa-mobile-composer-send-");
  const chrome = launchChrome({ port: CDP_PORT, profile, url: `${site.origin}/` });
  let app;
  const waitFor = async (read, accept, what, timeoutMs = 10_000) => {
    const end = Date.now() + timeoutMs;
    let last;
    while (Date.now() < end) {
      last = await read();
      if (accept(last)) return last;
      await sleep(100);
    }
    assert.fail(`${what}: last saw ${JSON.stringify(last)}`);
  };
  try {
    await hub.createChat(CHAT, { title: "Send", participants: [member("drew")] });
    app = await attachApp({ port: CDP_PORT });
    await pairPage(app, { hub, siteOrigin: site.origin });
    // Pairing writes one entry of its own (the certificate); it is handed
    // over before the messages, so the hold below meets only them.
    await app.waitFor(`AccordAgentsMobile.listOutboxEntries().then((entries) => entries.length > 0 && entries.every((entry) => entry.status === "acked"))`,
      "the pairing certificate was handed over");
    await app.evaluate(`document.querySelector('.mobile-chat-row[data-conversation-id=${JSON.stringify(CHAT)}]').click()`);
    await app.waitFor(`Boolean(globalThis.AccordAgentsMobile && document.getElementById("composer-input") && document.getElementById("composer-form")) && document.getElementById("timeline-screen").classList.contains("is-active")`,
      "the chat came up with its composer");

    // Every push of the phone's events is held by the server for a while.
    const pushed = [];
    hub.setGate(async (request) => {
      if (request.method === "POST" && request.path === "/v1/events") {
        pushed.push(request.at);
        return { delayMs: APPEND_HOLD_MS };
      }
      return undefined;
    });

    const send = (text) => app.evaluate(`(() => {
      const input = document.getElementById("composer-input");
      input.value = ${JSON.stringify(text)};
      document.getElementById("composer-form").dispatchEvent(new Event("submit", { cancelable: true }));
      return true;
    })()`);
    const queued = () => app.evaluate(`AccordAgentsMobile.listOutboxEntries().then((entries) => entries
      .filter((entry) => !entry.kind || entry.kind === "message.created")
      .map((entry) => entry.payload.content + ":" + entry.status).sort())`);

    await send("first");
    await waitFor(queued, (rows) => rows.length === 1, "the first message is queued");
    // Inside the server's hold on the first: the second is typed and sent.
    await sleep(400);
    await send("second");
    assert.equal(await app.evaluate(`document.getElementById("composer-input").value`), "", "the second message left the field");
    await waitFor(queued, (rows) => rows.length === 2, "the second message is queued while the first is still going out");
    // Both handed over: the second right behind the first, not on the retry
    // tick half a minute later. Each hand-over is a signed push the server
    // writes before it answers, so the budget is the two holds and the
    // server's own work, well inside the half minute.
    await waitFor(queued, (rows) => rows.every((row) => row.endsWith(":acked")), "both messages are handed over", APPEND_HOLD_MS * 2 + 10_000);
    await hub.settle();
    const messages = hub.phoneEvents("chat.changes");
    assert.equal(messages.length, 2, "the server received both");
    t.diagnostic(`pushes: ${pushed.length}, queue: ${JSON.stringify(await queued())}`);
  } finally {
    app?.close();
    chrome.kill("SIGKILL");
    await site.close();
    await hub.close();
    await rm(profile, { recursive: true, force: true });
  }
});

// A send went out only after the chat had been drawn again: every row read
// and checked, in one go, before the message was handed to the server. On a
// long chat that was most of the 0.8 to 2.5 seconds between Send and the
// server having it. Here drawing the chat is made slow on purpose, and the
// message must reach the server before the chat is drawn with it.
test("a sent message goes to the server before the chat is drawn again", { timeout: 120_000 }, async () => {
  const CHAT_LONG = "chat-send-long";
  const hub = await startMobileHub();
  const site = await serveMobileShell({ port: 8277, hubOrigins: [hub.base] });
  const profile = await tempProfile("aa-mobile-send-first-");
  const chrome = launchChrome({ port: 9427, profile, url: `${site.origin}/` });
  let app;
  try {
    const drew = member("drew");
    const history = Array.from({ length: 40 }, (_, index) => ({
      id: "h" + index, role: index % 2 ? "participant" : "user",
      ...(index % 2 ? { participantId: drew.id, participantLabel: "@drew" } : {}),
      content: "Earlier line " + index, status: "done", createdAt: new Date(Date.now() - (60 - index) * 60_000).toISOString()
    }));
    await hub.createChat(CHAT_LONG, { title: "Long chat", participants: [drew], messages: history });
    app = await attachApp({ port: 9427 });
    await pairPage(app, { hub, siteOrigin: site.origin });
    await app.waitFor(`AccordAgentsMobile.listOutboxEntries().then((entries) => entries.length > 0 && entries.every((entry) => entry.status === "acked"))`,
      "the pairing certificate was handed over");
    await app.evaluate(`document.querySelector('.mobile-chat-row[data-conversation-id=${JSON.stringify(CHAT_LONG)}]').click()`);
    await app.waitFor(`document.getElementById("message-list").innerText.includes("Earlier line 39")`, "the long chat is drawn");
    await hub.quiet();
    // Every row's time costs 25 ms from here on: one redraw of this chat
    // takes a second or more, the phone's own sending work does not.
    const timing = await app.evaluate(`(async () => {
      const descriptor = Object.getOwnPropertyDescriptor(Intl.DateTimeFormat.prototype, "format");
      Object.defineProperty(Intl.DateTimeFormat.prototype, "format", { configurable: true, get() {
        const format = descriptor.get.call(this);
        return function (date) { const end = performance.now() + 25; while (performance.now() < end) {} return format(date); };
      } });
      const fetchBefore = window.fetch;
      let postAt;
      window.fetch = function (input, init) {
        if (postAt === undefined && init && init.method === "POST" && String(input && input.url || input).includes("/v1/events")) postAt = performance.now();
        return fetchBefore.call(this, input, init);
      };
      let drawnAt;
      const list = document.getElementById("message-list");
      const observer = new MutationObserver(() => {
        if (drawnAt === undefined && list.innerText.includes("first thing after the history")) drawnAt = performance.now();
      });
      observer.observe(list, { childList: true, subtree: true, characterData: true });
      const sentAt = performance.now();
      const input = document.getElementById("composer-input");
      input.value = "first thing after the history";
      document.getElementById("composer-form").dispatchEvent(new Event("submit", { cancelable: true }));
      const end = Date.now() + 20_000;
      while ((postAt === undefined || drawnAt === undefined) && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 20));
      observer.disconnect();
      window.fetch = fetchBefore;
      Object.defineProperty(Intl.DateTimeFormat.prototype, "format", descriptor);
      return { post: postAt === undefined ? null : Math.round(postAt - sentAt), drawn: drawnAt === undefined ? null : Math.round(drawnAt - sentAt) };
    })()`);
    assert.ok(timing.post !== null && timing.drawn !== null, `the message was sent and drawn: ${JSON.stringify(timing)}`);
    assert.ok(timing.post < timing.drawn, `the message went to the server before the slow redraw drew it: ${JSON.stringify(timing)}`);
    await hub.settle();
    assert.equal(hub.phoneEvents("chat.changes").length, 1, "the server received it");

    // The stamp every event carries is read and advanced in one transaction:
    // asked for twenty times at once, it still gives twenty different stamps,
    // each after the one asked for before it.
    const stamps = await app.evaluate(`(() => {
      const deviceId = AccordAgentsMobile.loadHubPairing().deviceId;
      return Promise.all(Array.from({ length: 20 }, () => AccordAgentsMobile.hubLogicalTs(deviceId)));
    })()`);
    assert.equal(new Set(stamps).size, 20, `twenty distinct stamps: ${JSON.stringify(stamps)}`);
    assert.deepEqual(stamps, [...stamps].sort(), "each later than the one asked for before it");
  } finally {
    app?.close();
    chrome.kill("SIGKILL");
    await site.close();
    await hub.close();
    await rm(profile, { recursive: true, force: true });
  }
});

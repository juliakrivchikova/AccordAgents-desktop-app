/**
 * What the phone knows about chats it has not read page by page, in the real
 * PWA paired with a real hub (the User's own server).
 *
 * The phone reads a chat's pages only while that chat is open; everything
 * else it learns from the server's chat list. Two things went wrong with that
 * once the relay was gone:
 *  - a chat opened and left before its first page arrived was marked unread
 *    when the page landed, though the User had just opened it;
 *  - Activity listed only the chats the phone had opened: a reply in any
 *    other chat, and the notification about it, led to an empty Finished
 *    list. The server's list says for every chat which members run and what
 *    they last finished, and Activity lists that.
 *
 * Desktop Chrome, not the installed phone: supporting evidence for the phone
 * check, not a stand-in for it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { rm } from "node:fs/promises";
import { attachApp, launchChrome, member, pairPage, serveMobileShell, sleep, startMobileHub, tempProfile } from "./mobile-hub-fixture.mjs";

const DREW = member("drew");
const TAYLOR = member("taylor");
const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const reply = (id, author, content, minutes, extra = {}) => ({
  id, role: "participant", participantId: author.id, participantLabel: `@${author.handle}`, content, status: "done", createdAt: minutesAgo(minutes), ...extra
});
const unreadIds = `JSON.parse(localStorage.getItem("accordagents.mobile.unreadConversationIds.v1") || "[]")`;
const timelineReads = (hub, conversationId) => hub.requests.filter((request) =>
  request.path === "/v1/phone/timeline" && request.query.conversationId === conversationId);

test("a chat opened and left before its first page arrives is not marked unread", { timeout: 120_000 }, async () => {
  const CHAT = "chat-open-leave";
  const hub = await startMobileHub();
  const site = await serveMobileShell({ port: 8321, hubOrigins: [hub.base] });
  const profile = await tempProfile("aa-mobile-open-leave-");
  const chrome = launchChrome({ port: 9461, profile, url: `${site.origin}/` });
  let app;
  try {
    await hub.createChat(CHAT, { title: "Open and leave", participants: [DREW], createdAt: minutesAgo(30), messages: [
      { id: "u1", role: "user", content: "@drew how is it going?", status: "done", createdAt: minutesAgo(12) },
      reply("d1", DREW, "Done: the build is green.", 10)
    ] });
    app = await attachApp({ port: 9461 });
    await pairPage(app, { hub, siteOrigin: site.origin, query: "qa=1" });
    await hub.quiet();

    // The server is slow with this chat's page: the User opens the chat and
    // goes back before it arrives.
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    hub.setGate(async (request) => {
      if (request.path === "/v1/phone/timeline" && request.query.conversationId === CHAT) await held;
      return undefined;
    });
    await app.evaluate(`document.querySelector('.mobile-chat-row[data-conversation-id=${JSON.stringify(CHAT)}]').click()`);
    await app.waitFor(`document.getElementById("timeline-screen").classList.contains("is-active")`, "the chat opened");
    for (let i = 0; i < 50 && timelineReads(hub, CHAT).length === 0; i += 1) await sleep(100);
    assert.equal(timelineReads(hub, CHAT).length, 1, "opening the chat asked for its page");
    await app.evaluate(`document.getElementById("back-to-chats").click()`);
    await app.waitFor(`!document.getElementById("timeline-screen").classList.contains("is-active")`, "back on the list");
    release();
    hub.setGate(undefined);
    for (let i = 0; i < 50 && !timelineReads(hub, CHAT)[0].doneAt; i += 1) await sleep(100);
    assert.ok(timelineReads(hub, CHAT)[0].doneAt, "the page arrived after the User left");
    // The page was taken in: its rows stored, and whether it was news decided.
    await app.waitFor(`(window.__relayDebug || []).some((entry) => entry.event === "timeline-page" && entry.conversationId === ${JSON.stringify(CHAT)} && entry.opening && entry.changed > 0)`,
      "the page was taken in after the User left");
    assert.equal(await app.evaluate(`AccordAgentsMobile.listTimelineEntries(${JSON.stringify(CHAT)}).then((rows) => rows.some((row) => row.content === "Done: the build is green."))`),
      true, "the page's rows were stored");
    assert.deepEqual(await app.evaluate(unreadIds), [], "the chat the User just opened is not unread");
    assert.equal(await app.evaluate(`document.querySelector('.mobile-chat-row[data-conversation-id=${JSON.stringify(CHAT)}]').dataset.unread || ""`), "",
      "and its row in the list has no dot");
    // Nor is its reply news in Activity.
    await app.evaluate(`document.querySelector('[data-home-tab="activity"]').click()`);
    await app.waitFor(`Boolean(document.querySelector('.act-tab[data-activity-tab="finished"]'))`, "Activity's lists");
    await app.evaluate(`document.querySelector('.act-tab[data-activity-tab="finished"]').click()`);
    await app.waitFor(`[...document.querySelectorAll("#activity-list .act-row")].some((row) => row.innerText.includes("the build is green"))`, "the reply in Finished");
    assert.equal(await app.evaluate(`[...document.querySelectorAll("#activity-list .act-row")].find((row) => row.innerText.includes("the build is green")).classList.contains("is-unread")`),
      false, "the reply of a chat the User opened is not shown as unseen");
  } finally {
    app?.close();
    chrome.kill("SIGKILL");
    await site.close();
    await hub.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test("Activity lists every chat's running members and replies, not only the chats this phone opened", { timeout: 120_000 }, async (t) => {
  const FINISHED_CHAT = "chat-never-opened-reply";
  const RUNNING_CHAT = "chat-never-opened-run";
  const hub = await startMobileHub();
  const site = await serveMobileShell({ port: 8323, hubOrigins: [hub.base] });
  const profile = await tempProfile("aa-mobile-all-chats-");
  const chrome = launchChrome({ port: 9463, profile, url: `${site.origin}/` });
  let app;
  try {
    await hub.createChat(FINISHED_CHAT, { title: "Release notes", participants: [DREW], createdAt: minutesAgo(40), messages: [
      { id: "fu1", role: "user", content: "@drew write the release notes", status: "done", createdAt: minutesAgo(20) },
      reply("fd1", DREW, "Release notes are written and in the draft.", 5)
    ] });
    await hub.createChat(RUNNING_CHAT, { title: "Flaky test hunt", participants: [TAYLOR], createdAt: minutesAgo(40), messages: [
      { id: "ru1", role: "user", content: "@taylor find the flaky test", status: "done", createdAt: minutesAgo(3) },
      { id: "rt1", role: "participant", participantId: TAYLOR.id, participantLabel: "@taylor", content: "Bisecting the last ten runs.",
        status: "pending", createdAt: minutesAgo(1), metadata: { runId: "run-taylor-hunt" } }
    ] });
    app = await attachApp({ port: 9463 });
    await pairPage(app, { hub, siteOrigin: site.origin });
    await hub.quiet();

    // Then a member replies while the phone is not looking: the server rings
    // it, and the User taps the notification, which opens Activity's
    // Finished list, as the service worker opens it.
    await hub.addMessages(FINISHED_CHAT, [reply("fd2", DREW, "One more: the changelog link is fixed.", 0)]);
    await hub.quiet();
    await app.send("Page.navigate", { url: `${site.origin}/?tab=activity&list=finished` });
    const finished = await (async () => {
      for (let i = 0; i < 100; i += 1) {
        const rows = await app.evaluate(`(() => {
          const list = document.getElementById("activity-list");
          if (!list || list.dataset.activityTab !== "finished") return null;
          return [...list.querySelectorAll(".act-row")].map((row) => row.innerText.replace(/\\s+/g, " ").trim());
        })()`).catch(() => null);
        if (rows && rows.some((text) => text.includes("changelog link is fixed"))) return rows;
        await sleep(150);
      }
      return await app.evaluate(`[...document.querySelectorAll("#activity-list .act-row")].map((row) => row.innerText)`).catch(() => []);
    })();
    t.diagnostic(`finished rows: ${JSON.stringify(finished)}`);
    assert.ok(finished.some((text) => text.includes("changelog link is fixed") && text.includes("Release notes")),
      `the reply in a chat this phone never opened is listed where the notification lands: ${JSON.stringify(finished)}`);

    await app.waitFor(`Boolean(document.querySelector('.act-tab[data-activity-tab="running"]'))`, "Activity's lists");
    await app.evaluate(`document.querySelector('.act-tab[data-activity-tab="running"]').click()`);
    let running = [];
    for (let i = 0; i < 40; i += 1) {
      running = await app.evaluate(`[...document.querySelectorAll("#activity-list .act-row")].map((row) => row.innerText.replace(/\\s+/g, " ").trim())`);
      if (running.some((text) => text.includes("Flaky test hunt"))) break;
      await sleep(150);
    }
    assert.ok(running.some((text) => text.includes("Flaky test hunt") && text.includes("Bisecting")),
      `a member running in a chat this phone never opened is listed: ${JSON.stringify(running)}`);

    // All of it from the chat list: no chat's page was read for it.
    assert.deepEqual([...timelineReads(hub, FINISHED_CHAT), ...timelineReads(hub, RUNNING_CHAT)], [],
      "Activity reads no chat's pages; the User has hundreds of chats");

    // The run ends: the next list moves it to Finished.
    await hub.updateMessages(RUNNING_CHAT, [{ id: "rt1", role: "participant", participantId: TAYLOR.id, participantLabel: "@taylor",
      content: "Found it: the clock test races the timer.", status: "done", createdAt: minutesAgo(1), metadata: { runId: "run-taylor-hunt" } }]);
    await app.evaluate(`document.querySelector('.act-tab[data-activity-tab="finished"]').click()`);
    let after = [];
    for (let i = 0; i < 100; i += 1) {
      after = await app.evaluate(`[...document.querySelectorAll("#activity-list .act-row")].map((row) => row.innerText.replace(/\\s+/g, " ").trim())`);
      if (after.some((text) => text.includes("clock test races"))) break;
      await sleep(150);
    }
    assert.ok(after.some((text) => text.includes("clock test races")), `the finished run is listed as finished: ${JSON.stringify(after)}`);
  } finally {
    app?.close();
    chrome.kill("SIGKILL");
    await site.close();
    await hub.close();
    await rm(profile, { recursive: true, force: true });
  }
});

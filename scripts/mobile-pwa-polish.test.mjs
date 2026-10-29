// The PWA polish round, driven through the real shell in Chrome paired with
// a real hub (the User's own server), which holds the chats the desktop
// published: search, the time under a finished message, unread dots and the
// icon number, the members sheet, earlier history, the "/" menu with a picked
// skill, pull to refresh, coming back to the foreground, a picture at full
// size, and the wording a push-woken worker builds from the phone's own
// mirrors.
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { rm } from "node:fs/promises";
import { attachApp, launchChrome, pairPage, serveMobileShell, startMobileHub, tempProfile } from "./mobile-hub-fixture.mjs";

const require = createRequire(import.meta.url);
const SITE_PORT = 8197;
const CDP_PORT = 9377;
const CHAT_A = "conv-polish-alpha";
const CHAT_B = "conv-polish-beta";
const CHAT_C = "conv-polish-gamma";
// A 1x1 PNG, enough for a picture to load and be opened.
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const at = (minute, second = 0) => new Date(Date.UTC(2026, 8, 15, 12, minute, second)).toISOString();
const DREW = { id: "p-drew", handle: "drew", roleConfigId: "software-engineer", kind: "codex-cli" };
const TAYLOR = { id: "p-taylor", handle: "taylor", roleConfigId: "reviewer", kind: "claude-code", homeMachineId: "machine-1" };
const GERA = { id: "p-gera", handle: "gera", roleConfigId: "software-engineer", kind: "codex-cli" };
const message = (id, minute, author, content, metadata, second = 0) => ({
  id, role: author ? "participant" : "user", content, status: "done", createdAt: at(minute, second),
  ...(author ? { participantId: author.id, participantLabel: `@${author.handle}` } : {}),
  ...(metadata ? { metadata } : {})
});
// The server pages a chat 80 messages at a time. Between the two earlier
// messages and the latest two stand messages the phone does not show (empty
// system lines), so the latest page shows two rows and the one before it two.
const HIDDEN_FILLERS = Array.from({ length: 78 }, (_, index) => ({
  id: `f-${String(index + 1).padStart(2, "0")}`, role: "system", content: "", status: "done", createdAt: at(9, index % 60)
}));
const FIRST_OF_LATEST_PAGE = "f-01";

test("PWA polish: search, times, unread, members, earlier history, slash menu, refresh, foreground, pictures, notification wording", { timeout: 300_000 }, async () => {
  const { createDeviceIdentity } = require("../dist/main/main/services/deviceIdentity.js");
  const office = createDeviceIdentity(new Date().toISOString());
  const hub = await startMobileHub({ rosterDevices: [
    { deviceId: office.originId, publicKeyDerBase64: office.publicKeyDerBase64, role: "machine", name: "Office Mac", machineId: "machine-1" }
  ] });
  const site = await serveMobileShell({ port: SITE_PORT, hubOrigins: [hub.base] });
  // What the desktop publishes for the composer: role names, a saved prompt,
  // a skill its members can run.
  await hub.publishCatalog({
    roles: { "software-engineer": "Software Engineer", reviewer: "Reviewer" },
    prompts: [{ id: "prompt-1", label: "Standup", trigger: "standup", body: "Give me a standup summary." }],
    skills: [{ skillId: "skill-review", displayName: "review", frontmatterName: "review", description: "Review the diff", contentHash: "h", capabilityState: "invocable", variants: [], providerKinds: ["codex-cli", "claude-code"] }]
  });
  const picture = await hub.putBlob(Buffer.from(PNG_1X1, "base64"));
  // Least recently changed first: the list comes newest first.
  await hub.createChat(CHAT_C, { title: "Gamma notes", repoPath: "/work/Other project", participants: [GERA], messages: [message("c-001", 3, GERA, "Notes.")] });
  await hub.createChat(CHAT_B, { title: "Beta bugs", participants: [DREW], messages: [message("b-000", 2, undefined, "Fixed the crash.")] });
  await hub.createChat(CHAT_A, { title: "Alpha planning", participants: [DREW, TAYLOR], messages: [
    message("a-008", 8, undefined, "Two earlier."),
    message("a-009", 9, DREW, "One earlier."),
    ...HIDDEN_FILLERS,
    message("a-010", 10, undefined, "Latest question?"),
    message("a-011", 11, DREW, "Latest answer, with a picture.", { imageAttachments: [{
      id: "att-1", filename: "dot.png", mimeType: "image/png", sizeBytes: 68, width: 1, height: 1,
      storageKey: "attachments/att-1.png", createdAt: at(11), hubBlob: picture
    }] })
  ] });
  const timelineAsks = (conversationId) => hub.requests
    .filter((request) => request.method === "GET" && request.path === "/v1/phone/timeline" && request.query.conversationId === conversationId)
    .map((request) => ({ conversationId, beforeMessageId: request.query.beforeMessageId }));
  const listAsks = () => hub.requests.filter((request) => request.method === "GET" && request.path === "/v1/phone/chats").length;
  let sentByServer = [];
  const sent = () => sentByServer;
  const readSent = async () => {
    sentByServer = (await hub.phoneOps("message.create")).map((entry) => entry.effect.message);
    return sentByServer.length;
  };

  const profile = await tempProfile("aa-polish-");
  const chrome = launchChrome({ port: CDP_PORT, profile, url: `${site.origin}/`, width: 430, height: 860 });
  let app;
  try {
    app = await attachApp({ port: CDP_PORT });
    const evaluate = app.evaluate;
    const waitFor = async (read, predicate, description, attempts = 40) => {
      let value;
      for (let i = 0; i < attempts; i += 1) {
        value = await read();
        if (predicate(value)) return value;
        await new Promise((r) => setTimeout(r, 250));
      }
      assert.fail(`${description}: ${JSON.stringify(value)}`);
    };

    // The icon number is observed through a stand-in installed before the app
    // runs: headless Chrome has no home screen.
    await app.send("Page.enable");
    await app.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `window.__badge = []; navigator.setAppBadge = (n) => { window.__badge.push(n); return Promise.resolve(); }; navigator.clearAppBadge = () => { window.__badge.push(0); return Promise.resolve(); };`
    });
    await pairPage(app, { hub, siteOrigin: site.origin, query: "qa=1" });
    await evaluate(`navigator.serviceWorker.ready.then(() => true)`);
    await new Promise((r) => setTimeout(r, 2000));

    // --- the list, and searching it --------------------------------------
    const rowTitles = async () => await evaluate(`(() => [...document.querySelectorAll("#chat-list .mobile-chat-row strong")].map((n) => n.textContent))()`);
    await waitFor(rowTitles, (titles) => titles.length === 3, "the three chats from the desktop are listed");
    assert.ok(!(await evaluate(`(() => Boolean(document.querySelector('[aria-label="New chat"]')))()`)), "the phone offers no new-chat button: it cannot create one");
    await evaluate(`(() => { document.getElementById("chat-search-toggle").click(); return true; })()`);
    assert.equal(await evaluate(`(() => document.getElementById("chat-search").hidden)()`), false, "the search box opens");
    await evaluate(`(() => { const i = document.getElementById("chat-search-input"); i.value = "BETA"; i.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
    assert.deepEqual(await rowTitles(), ["Beta bugs"], "search filters by title, case-insensitively");
    await evaluate(`(() => { const i = document.getElementById("chat-search-input"); i.value = "gera"; i.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
    assert.deepEqual(await rowTitles(), ["Gamma notes"], "search also matches who wrote last");
    await evaluate(`(() => { const i = document.getElementById("chat-search-input"); i.value = "zzz"; i.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
    assert.match(await evaluate(`(() => document.getElementById("chat-list").textContent)()`), /No chats match/, "an empty result says so instead of showing the sync wait");
    await evaluate(`(() => { document.getElementById("chat-search-close").click(); return true; })()`);
    assert.equal((await rowTitles()).length, 3, "cancel restores the whole list");

    // --- unread: news in a chat that is not on screen ----------------------
    await hub.addMessages(CHAT_B, [message("b-001", 20, DREW, "Fixed the crash for real.")]);
    const unreadRows = async () => await evaluate(`(() => [...document.querySelectorAll('#chat-list .mobile-chat-row[data-unread="1"]')].map((n) => n.dataset.conversationId))()`);
    await waitFor(unreadRows, (ids) => ids.length === 1 && ids[0] === CHAT_B, "a reply landing in a chat that is not open marks it unread");
    assert.equal(await evaluate(`(() => document.querySelectorAll('#chat-list .mobile-chat-row[data-conversation-id="${CHAT_B}"] .mobile-unread-dot').length)()`), 1, "the row shows the dot");
    await waitFor(() => evaluate(`(() => window.__badge.at(-1))()`), (n) => n === 1, "the icon number is the count of unread chats");
    await evaluate(`(() => { document.querySelector('#chat-list .mobile-chat-row[data-conversation-id="${CHAT_B}"]').click(); return true; })()`);
    await waitFor(() => evaluate(`(() => document.getElementById("timeline-screen").classList.contains("is-active"))()`), Boolean, "the chat opens");
    await waitFor(() => evaluate(`(() => JSON.parse(localStorage.getItem("accordagents.mobile.unreadConversationIds.v1") || "[]"))()`), (ids) => ids.length === 0, "opening the chat reads it");
    await waitFor(() => evaluate(`(() => window.__badge.at(-1))()`), (n) => n === 0, "and clears the icon number");
    // The chat's page, read as it opened, is in before the reader leaves it.
    await waitFor(() => evaluate(`AccordAgentsMobile.listTimelineEntries(${JSON.stringify(CHAT_B)}).then((rows) => rows.length)`), (n) => n >= 2, "the chat's page is in");
    await hub.quiet();
    await new Promise((r) => setTimeout(r, 500));
    await evaluate(`(() => { document.getElementById("back-to-chats").click(); return true; })()`);
    await waitFor(unreadRows, (ids) => ids.length === 0, "the dot is gone from the list");

    // --- a chat with history: times, the members sheet, earlier messages ----
    await evaluate(`(() => { document.querySelector('#chat-list .mobile-chat-row[data-conversation-id="${CHAT_A}"]').click(); return true; })()`);
    const rows = async () => await evaluate(`(() => [...document.querySelectorAll("#message-list .message-row")].map((n) => ({ status: n.dataset.status, label: (n.querySelector(".message-status") || {}).textContent, text: (n.querySelector(".message-content") || {}).textContent })))()`);
    await waitFor(rows, (list) => list.length === 2, "the latest page arrives from the server");
    const latest = await rows();
    // The User's own message says when it was written and that the server
    // has it, in the words every device uses (agreement Д3).
    assert.equal(latest[0].status, "Sent");
    assert.match(latest[0].label, /^\d{2}:\d{2} · Sent$/, "the User's message shows its time and that it was sent");
    assert.match(latest[1].label, /^\d{2}:\d{2}$/, "a finished member's message shows the time it was written, not the word Done");
    assert.equal(await evaluate(`(() => document.getElementById("load-earlier").hidden)()`), false, "the desktop said there is more before this page, so the phone offers it");

    await evaluate(`(() => { document.getElementById("chat-members-toggle").click(); return true; })()`);
    assert.equal(await evaluate(`(() => document.getElementById("members-sheet").hidden)()`), false, "tapping the title opens the members");
    const members = await evaluate(`(() => [...document.querySelectorAll("#members-sheet-list .members-sheet-row")].map((n) => ({ name: n.querySelector("strong").textContent, role: n.querySelector(".members-sheet-role").textContent, where: n.querySelector(".members-sheet-location").textContent })))()`);
    assert.deepEqual(members, [
      { name: "@drew", role: "Software Engineer · Codex CLI", where: "Local · desktop" },
      { name: "@taylor", role: "Reviewer · Claude Code", where: "Office Mac" }
    ], "each member shows role, tool and where it runs");
    assert.equal(await evaluate(`(() => document.getElementById("members-sheet-title").textContent)()`), "2 members");
    await evaluate(`(() => { document.getElementById("members-sheet-close").click(); return true; })()`);
    assert.equal(await evaluate(`(() => document.getElementById("members-sheet").hidden)()`), true);

    await evaluate(`(() => { document.getElementById("load-earlier").click(); return true; })()`);
    await waitFor(rows, (list) => list.length === 4, "the earlier page is added");
    assert.deepEqual((await rows()).map((row) => row.text), ["Two earlier.", "One earlier.", "Latest question?", "Latest answer, with a picture."], "earlier rows go above, in order");
    assert.deepEqual(timelineAsks(CHAT_A).map((call) => call.beforeMessageId), [undefined, FIRST_OF_LATEST_PAGE], "the server was asked for the page before the oldest message it had given");
    assert.equal(await evaluate(`(() => document.getElementById("load-earlier").hidden)()`), true, "nothing earlier remains, so the offer goes away");

    // The latest page asked again — a pull, a reopen, a return to the
    // foreground — names its own oldest message as the page below it and
    // says there is more.
    // The phone already holds a-008: "earlier" must not move forward to a
    // page it has, or the next taps would re-fetch rows on screen and show
    // nothing.
    await evaluate(`window.AccordAgentsMobile.refreshOpenTimeline().then(() => true)`);
    assert.deepEqual(timelineAsks(CHAT_A).at(-1), { conversationId: CHAT_A, beforeMessageId: undefined }, "the refresh asked for the latest page");
    assert.deepEqual(await evaluate(`window.AccordAgentsMobile.timelinePageFor("${CHAT_A}")`), { hasMoreBefore: false, beforeMessageId: "a-008" }, "the cursor stays where the earlier pages left it");
    assert.equal(await evaluate(`(() => document.getElementById("load-earlier").hidden)()`), true, "and the offer stays away: this phone holds everything the desktop has");

    // --- a picture, opened at full size ----------------------------------
    await waitFor(() => evaluate(`(() => document.querySelector('#message-list .message-image')?.dataset.state)()`), (state) => state === "ready", "the picture's bytes arrive by id");
    await evaluate(`(() => { document.querySelector('#message-list .message-image').click(); return true; })()`);
    assert.equal(await evaluate(`(() => document.getElementById("image-viewer").hidden)()`), false, "tapping the picture opens it");
    assert.match(await evaluate(`(() => document.getElementById("image-viewer-image").src)()`), /^data:image\/png/, "at full size, from the bytes already held");
    await evaluate(`(() => { document.getElementById("image-viewer-close").click(); return true; })()`);
    assert.equal(await evaluate(`(() => document.getElementById("image-viewer").hidden)()`), true, "and closes");

    // --- the "/" menu -----------------------------------------------------
    await evaluate(`(() => { const i = document.getElementById("composer-input"); i.focus(); i.value = "@drew /"; i.setSelectionRange(7, 7); i.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
    const slashOptions = async () => await evaluate(`(() => [...document.querySelectorAll("#slash-menu .mobile-slash-option")].map((n) => n.dataset.slashKind + ":" + n.querySelector("strong").textContent))()`);
    await waitFor(slashOptions, (list) => list.length === 4, "the desktop's list appears under the draft");
    assert.deepEqual(await slashOptions(), ["command:/compact", "command:/goal", "prompt:/standup", "skill:/review"], "commands, then saved prompts, then skills, as the desktop orders them");
    const composerAsk = hub.requests.filter((request) => request.method === "GET" && request.path === "/v1/phone/composer").at(-1);
    assert.deepEqual({ conversationId: composerAsk.query.conversationId, query: composerAsk.query.query || "", content: composerAsk.query.content },
      { conversationId: CHAT_A, query: "", content: "@drew /" }, "the server is asked with the draft so far");
    await evaluate(`(() => { document.querySelector('#slash-menu .mobile-slash-option[data-slash-kind="skill"]').click(); return true; })()`);
    assert.equal(await evaluate(`(() => document.getElementById("composer-input").value)()`), "@drew /review ", "picking a skill writes its token");
    assert.equal(await evaluate(`(() => document.getElementById("slash-menu").hidden)()`), true);
    await evaluate(`(() => { const i = document.getElementById("composer-input"); i.value = "@drew /review the diff"; i.dispatchEvent(new Event("input", { bubbles: true })); document.getElementById("composer-form").requestSubmit(); return true; })()`);
    await waitFor(readSent, (n) => n === 1, "the message reaches the server");
    assert.equal(sent()[0].content, "@drew /review the diff");
    assert.equal(sent()[0].metadata.skillMentions?.[0]?.skillId, "skill-review", "carrying the picked skill, as the desktop composer would");

    // --- pull to refresh ---------------------------------------------------
    // The sent message comes back from the server and is drawn; the pull
    // starts once the chat is still.
    await hub.quiet();
    await new Promise((r) => setTimeout(r, 1000));
    const timelineAskCount = timelineAsks(CHAT_A).length;
    // A pull only counts from the very top of the list; anywhere else is a scroll.
    const surfaceBox = await evaluate(`(() => { const s = document.querySelector(".thread-surface"); s.scrollTop = 0; const r = s.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 20, scrollTop: s.scrollTop }; })()`);
    assert.equal(surfaceBox.scrollTop, 0);
    await app.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    await app.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: surfaceBox.x, y: surfaceBox.y }] });
    for (let step = 1; step <= 6; step += 1) {
      await app.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: surfaceBox.x, y: surfaceBox.y + step * 30 }] });
    }
    assert.equal(await evaluate(`(() => document.getElementById("timeline-refresh").classList.contains("is-armed"))()`), true, "a long enough pull arms the refresh");
    await app.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await app.send("Emulation.setTouchEmulationEnabled", { enabled: false, maxTouchPoints: 1 });
    await waitFor(() => timelineAsks(CHAT_A).length, (n) => n > timelineAskCount, "letting go asks the server for the timeline again");
    await waitFor(() => evaluate(`(() => document.getElementById("timeline-refresh").classList.contains("is-refreshing"))()`), (busy) => busy === false, "the spinner stops when the answer is in");

    // --- coming back to the foreground -------------------------------------
    const chatListAsks = listAsks();
    await evaluate(`(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => window.__hidden === true });
      window.__hidden = true;
      document.dispatchEvent(new Event("visibilitychange"));
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 5500));
    await evaluate(`(() => { window.__hidden = false; document.dispatchEvent(new Event("visibilitychange")); return true; })()`);
    await waitFor(() => listAsks(), (n) => n > chatListAsks, "returning asks the server again at once, instead of waiting for a timer");
    const resync = await waitFor(() => evaluate(`(() => (window.__relayDebug || []).filter((e) => e.event === "foreground-resync").at(-1))()`), Boolean, "the resync is recorded");
    assert.ok(resync.awayMs >= 5000, "after a real absence");
    await waitFor(() => evaluate(`(() => document.getElementById("connection-state").textContent)()`), (text) => text === "Synced", "and the chat is synced again");

    // --- an earlier page that arrives late ---------------------------------
    // The request's own wait can end before a slow answer lands. The answer
    // still carries its cursor and says it is history: the cursor is saved
    // where the rows land, and history never marks a chat unread.
    await evaluate(`(() => { document.getElementById("back-to-chats").click(); return true; })()`);
    await waitFor(() => evaluate(`(() => document.getElementById("chats-screen").classList.contains("is-active"))()`), Boolean, "back on the list");
    await evaluate(`window.AccordAgentsMobile.handleRelayTimelinePayload({
      type: "mobile.timeline.events",
      conversationId: "${CHAT_A}",
      events: [{ id: "a-007", messageId: "a-007", role: "participant", participantLabel: "@drew", content: "Three earlier.", status: "done", createdAt: "${at(7)}" }],
      page: { hasMoreBefore: true, beforeMessageId: "a-007", earlier: true }
    }, "${CHAT_A}")`);
    assert.deepEqual(await evaluate(`window.AccordAgentsMobile.timelinePageFor("${CHAT_A}")`), { hasMoreBefore: true, beforeMessageId: "a-007" }, "a late answer still moves the cursor");
    assert.deepEqual(await evaluate(`JSON.parse(localStorage.getItem("accordagents.mobile.unreadConversationIds.v1") || "[]")`), [], "history filled in behind the reader is not news");
    await evaluate(`(() => { document.querySelector('#chat-list .mobile-chat-row[data-conversation-id="${CHAT_A}"]').click(); return true; })()`);
    await waitFor(rows, (list) => list[0]?.text === "Three earlier.", "the late page's row is shown, above the rest");
    assert.equal(await evaluate(`(() => document.getElementById("load-earlier").hidden)()`), false, "and the offer is back because the answer said there is more");

    // --- what a push says, built from plaintext arrivals and the mirrors ----
    const described = await evaluate(`new Promise((resolve) => {
      navigator.serviceWorker.addEventListener("message", function once(event) {
        if (event.data && event.data.type === "accord-test-describe-done") {
          navigator.serviceWorker.removeEventListener("message", once);
          resolve(event.data.notifications);
        }
      });
      navigator.serviceWorker.ready.then((registration) => registration.active.postMessage({
        type: "accord-test-describe",
        arrivals: [
          { conversationId: "${CHAT_B}", kind: "mobile.timeline.events" },
          { conversationId: "${CHAT_B}", kind: "mobile.notice.reply" },
          { conversationId: "${CHAT_C}", kind: "mobile.notice.approval" },
          { conversationId: "conv-unknown", kind: "mobile.notice.reply" },
          { conversationId: "${CHAT_A}", kind: "mobile.notice.reply" }
        ]
      }));
    })`);
    // `approval` is what the tap lands on: Pending for an approval, Finished
    // for a reply.
    assert.deepEqual(described, [
      { conversationId: CHAT_B, body: "New message in Beta bugs", approval: false },
      { conversationId: CHAT_C, body: "Approval needed in Gamma notes", approval: true },
      { conversationId: CHAT_A, body: "New message in Alpha planning", approval: false }
    ], "each named chat gets its own line from the phone's own memory; an unknown chat gets nothing and message text never appears");
    // The page is showing Alpha right now. The worker counted it too — it
    // cannot know — so the page folds the count back at once: the icon says
    // three for the chats not on screen, not four, and the mirror the next
    // push builds on no longer names Alpha. Before, Alpha stayed on the icon
    // until the app was next brought back to the foreground.
    await waitFor(
      () => evaluate(`JSON.parse(localStorage.getItem("accordagents.mobile.unreadConversationIds.v1") || "[]")`),
      (ids) => ids.length === 3 && !ids.includes(CHAT_A),
      "the page adopts the worker's count for the chats it is not showing"
    );
    await waitFor(() => evaluate(`(() => window.__badge.at(-1))()`), (n) => n === 3, "the icon number is the three chats not on screen");
    const mirrored = await evaluate(`new Promise((resolve, reject) => {
      const open = self.AccordMobileDb.openControlDb(indexedDB);
      open.then((db) => {
        const request = db.transaction("meta").objectStore("meta").get("unreadConversations");
        request.onsuccess = () => { db.close(); resolve(request.result ? request.result.ids : []); };
        request.onerror = () => { db.close(); reject(request.error); };
      }).catch(reject);
    })`);
    assert.deepEqual([...mirrored].sort(), [CHAT_B, CHAT_C, "conv-unknown"].sort(), "the worker counted every chat that moved, known or not, and the page took the one on screen back out");
  } finally {
    app?.close();
    chrome.kill("SIGKILL");
    await site.close();
    await hub.close();
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
});

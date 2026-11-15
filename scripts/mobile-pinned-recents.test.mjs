/**
 * Pinned and Recents on the phone (the User, 2026-11-15), in the real PWA
 * paired with a real hub (the User's own server):
 *  - the list leads with Pinned (in the order pinned) and Recents (the 20
 *    newest chats of every project), then the projects; a chat may be listed
 *    in all three;
 *  - each row shows one mark: a member at work, else a choice waiting for
 *    the User (yellow), else something new, else none;
 *  - a long press on a row pins or unpins the chat for every device, through
 *    the server, without making the chat recent.
 *
 * Desktop Chrome, not the installed phone: supporting evidence for the phone
 * check, not a stand-in for it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { rm } from "node:fs/promises";
import { attachApp, launchChrome, member, pairPage, serveMobileShell, sleep, startMobileHub, tempProfile } from "./mobile-hub-fixture.mjs";

const DREW = member("drew");
const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const sectionTitles = `[...document.querySelectorAll("#chat-list .mobile-chat-group-title")].map((title) => title.dataset.section + ":" + title.dataset.group)`;
const sectionRows = (kind) => `[...document.querySelectorAll('#chat-list .mobile-chat-group[data-section="${kind}"] .mobile-chat-row')].map((row) => row.dataset.conversationId)`;
const markOf = (id) => `document.querySelector('#chat-list .mobile-chat-row[data-conversation-id=${JSON.stringify(id)}]')?.dataset.mark`;

test("Pinned, Recents and projects on the phone; one mark per row; a long press pins through the server", { timeout: 180_000 }, async () => {
  const hub = await startMobileHub();
  const site = await serveMobileShell({ port: 8379, hubOrigins: [hub.base] });
  const profile = await tempProfile("aa-mobile-pinned-");
  const chrome = launchChrome({ port: 9525, profile, url: `${site.origin}/` });
  let app;
  try {
    // 22 chats in two projects, newest last; the oldest is pinned.
    for (let index = 0; index < 22; index += 1) {
      await hub.createChat(`chat-${index}`, {
        title: `Chat ${index}`, participants: [DREW], repoPath: index % 2 ? "/Users/me/alpha" : "/Users/me/beta", createdAt: minutesAgo(500 - index),
        messages: [{ id: `u-${index}`, role: "user", content: `hello ${index}`, status: "done", createdAt: minutesAgo(400 - index * 10) }],
        ...(index === 0 ? { metadata: { pinned: true, pinnedAt: minutesAgo(5) } } : {})
      });
    }
    // A member's question waits for the User in one chat.
    const asking = {
      id: "ask-1", role: "participant", participantId: DREW.id, participantLabel: "@drew", content: "Which store?", status: "done", createdAt: minutesAgo(1),
      metadata: { pendingChoice: { id: "choice-ask-1", title: "Store", question: "Which store?", status: "pending", askedAt: minutesAgo(1), options: [{ id: "a", label: "SQLite" }, { id: "b", label: "Files" }] } }
    };
    await hub.writeMessage("chat-20", asking);
    await hub.raiseChoice("chat-20", asking);

    app = await attachApp({ port: 9525 });
    await pairPage(app, { hub, siteOrigin: site.origin, query: "qa=1" });
    await app.waitFor(`document.querySelectorAll('#chat-list .mobile-chat-group[data-section="recents"] .mobile-chat-row').length === 20`, "Recents listed");

    const titles = await app.evaluate(sectionTitles);
    assert.deepEqual(titles.slice(0, 2), ["pinned:Pinned", "recents:Recents"], "Pinned, then Recents, above the projects");
    assert.deepEqual(titles.slice(2).sort(), ["project:alpha", "project:beta"]);
    assert.deepEqual(await app.evaluate(sectionRows("pinned")), ["chat-0"]);
    const recents = await app.evaluate(sectionRows("recents"));
    assert.equal(recents.length, 20, "the 20 newest");
    assert.equal(recents[0], "chat-20", "newest first");
    assert.equal(recents.includes("chat-0"), false, "the oldest pinned chat is not among the newest");
    assert.equal(recents.includes("chat-1"), false);
    assert.equal(await app.evaluate(`document.querySelectorAll('#chat-list .mobile-chat-row[data-conversation-id="chat-0"]').length`), 2,
      "the pinned chat is listed under Pinned and under its project");

    // One mark per row: the waiting question is yellow.
    assert.equal(await app.evaluate(markOf("chat-20")), "waiting");
    assert.equal(await app.evaluate(`document.querySelector('#chat-list .mobile-chat-row[data-conversation-id="chat-20"] .mobile-waiting-dot') !== null`), true);
    assert.equal(await app.evaluate(`document.querySelector('#chat-list .mobile-chat-row[data-conversation-id="chat-20"] .mobile-unread-dot')`), null,
      "never two marks");
    const dotsOf = (id) => `[...document.querySelectorAll('#chat-list .mobile-chat-row[data-conversation-id=${JSON.stringify(id)}]')].map((row) =>
      [row.dataset.mark, row.classList.contains("is-unread"), row.querySelectorAll(".mobile-live-dot, .mobile-waiting-dot, .mobile-unread-dot").length])`;
    // News in it as well: the question still wins, and the row has no unread look.
    await hub.addMessages("chat-20", [{ id: "news-1", role: "participant", participantId: DREW.id, participantLabel: "@drew", content: "Also, the build is green.", status: "done", createdAt: new Date().toISOString() }]);
    await app.waitFor(`JSON.parse(localStorage.getItem("accordagents.mobile.unreadConversationIds.v1") || "[]").includes("chat-20")`, "the news marked the chat unread");
    await app.waitFor(`JSON.stringify(${dotsOf("chat-20")}) === JSON.stringify([["waiting", false, 1], ["waiting", false, 1]])`, "waiting over unread, one dot");
    // A member at work: that wins over the question.
    const working = { id: "work-1", role: "participant", participantId: DREW.id, participantLabel: "@drew", content: "", status: "pending", createdAt: new Date().toISOString() };
    await hub.writeMessage("chat-20", working);
    await app.waitFor(`JSON.stringify(${dotsOf("chat-20")}) === JSON.stringify([["running", false, 1], ["running", false, 1]])`, "running over waiting, one dot");
    await hub.rewriteMessage("chat-20", { ...working, status: "done", content: "Done." });
    await app.waitFor(`${dotsOf("chat-20")}.every((row) => row[0] === "waiting")`, "the question again once the work ended");

    // A real long press with a finger: the chat's actions, not the chat, and
    // the lifting finger taps nothing in the sheet.
    const recentRow = (id) => `#chat-list .mobile-chat-group[data-section="recents"] .mobile-chat-row[data-conversation-id="${id}"]`;
    await app.touchStart(recentRow("chat-19"));
    await sleep(700);
    await app.touchEnd();
    await app.waitFor(`!document.getElementById("chat-actions-sheet").hidden`, "a long press opened the chat's actions");
    assert.equal(await app.evaluate(`document.getElementById("timeline-screen").classList.contains("is-active")`), false, "and did not open the chat");
    assert.equal(await app.evaluate(`document.getElementById("chat-actions-pin").textContent`), "Pin");
    await sleep(500);
    await app.evaluate(`document.getElementById("chat-actions-close").click()`);
    assert.equal(await app.evaluate(`document.getElementById("chat-actions-sheet").hidden`), true);
    assert.deepEqual(await app.evaluate(sectionRows("pinned")), ["chat-0"], "nothing was pinned by the lifting finger");
    // A finger that moves scrolls; it opens nothing.
    const point = await app.touchStart(recentRow("chat-18"));
    await app.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: point.x, y: point.y - 40, radiusX: 1, radiusY: 1, force: 1 }] });
    await sleep(700);
    await app.touchEnd();
    await sleep(200);
    assert.equal(await app.evaluate(`document.getElementById("chat-actions-sheet").hidden`), true, "a moving finger opens no actions");

    // A long press on a recent chat: Pin.
    const serverChat = (id) => hub.storage.getConversation(id);
    const before = (await serverChat("chat-21")).updatedAt;
    await app.evaluate(`document.querySelector('#chat-list .mobile-chat-group[data-section="recents"] .mobile-chat-row[data-conversation-id="chat-21"]')
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))`);
    await app.waitFor(`!document.getElementById("chat-actions-sheet").hidden`, "the chat's actions opened");
    assert.equal(await app.evaluate(`document.getElementById("chat-actions-pin").textContent`), "Pin");
    await app.evaluate(`document.getElementById("chat-actions-pin").click()`);
    assert.equal(await app.evaluate(`document.getElementById("chat-actions-sheet").hidden`), true);
    await app.waitFor(`JSON.stringify(${sectionRows("pinned")}) === JSON.stringify(["chat-0", "chat-21"])`, "pinned at once, at the bottom");
    let held;
    for (let i = 0; i < 100; i += 1) {
      held = await serverChat("chat-21");
      if (held.metadata.pinned === true) break;
      await sleep(100);
    }
    assert.equal(held.metadata.pinned, true, "the server holds the pin for every device");
    assert.equal(held.updatedAt, before, "pinning is not activity: the chat keeps its time");
    assert.equal((await hub.phoneOps("conversation.update")).length, 1, "sent once, as the chat's own change");

    // And unpin the old one.
    await app.evaluate(`document.querySelector('#chat-list .mobile-chat-group[data-section="pinned"] .mobile-chat-row[data-conversation-id="chat-0"]')
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))`);
    await app.waitFor(`document.getElementById("chat-actions-pin").textContent === "Unpin"`, "offers Unpin for a pinned chat");
    await app.evaluate(`document.getElementById("chat-actions-pin").click()`);
    await app.waitFor(`JSON.stringify(${sectionRows("pinned")}) === JSON.stringify(["chat-21"])`, "unpinned");
    for (let i = 0; i < 100 && (await serverChat("chat-0")).metadata.pinned !== undefined; i += 1) await sleep(100);
    assert.equal((await serverChat("chat-0")).metadata.pinned, undefined);

    // The question is answered on another device: the yellow mark goes.
    await hub.answerCard("chat-20", "choice-ask-1", { selectedOptionId: "a" });
    await hub.settleCard("chat-20", "choice-ask-1", { result: "applied" });
    await app.waitFor(`${markOf("chat-20")} === "unread"`, "the answered question no longer waits; the news shows", 30_000);
  } finally {
    app?.close();
    chrome.kill("SIGKILL");
    await site.close();
    await hub.close();
    await rm(profile, { recursive: true, force: true });
  }
});

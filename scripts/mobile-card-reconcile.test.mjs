/**
 * The phone keeping its cards and its queue honest, driven through the real
 * PWA in a browser.
 *
 * The User's screenshot of 2026-09-20: three cards still "waiting" on the
 * phone that the desktop had closed days earlier, one of them saying "Answer
 * sent" beside live Allow/Deny buttons, and after a reload the same cards
 * looking as if nothing had ever been answered. This drives the paths behind
 * that: the chat list now says what still waits in every chat, and the phone
 * drops what it no longer lists; the "sent" mark survives a launch; and the
 * queue is flushed for every chat rather than the open one.
 *
 * The phone is paired with a real hub (the User's own server): the cards are
 * the server's, raised the way the desktop raises them, the list is the
 * server's, and the answers go into its order. One list is made by hand: a
 * list read just before a card arrived, which can only be had by holding it.
 *
 * This is a browser check, not the installed phone: it runs the same files the
 * phone runs, under the same origin headers, but a physically installed PWA is
 * not claimed by it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { rm } from "node:fs/promises";
import { attachApp, launchChrome, member, pairPage, serveMobileShell, sleep, startMobileHub, tempProfile } from "./mobile-hub-fixture.mjs";

const SITE_PORT = 8241;
const CDP_PORT = 9393;
const CHAT_A = "conv-reconcile-a";
const CHAT_B = "conv-reconcile-b";
const TAYLOR = member("taylor");
const GERA = member("gera");

const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const message = (id, author, content, minutes, metadata) => ({
  id, role: "participant", participantId: author.id, participantLabel: `@${author.handle}`, content, status: "done", createdAt: minutesAgo(minutes),
  ...(metadata ? { metadata } : {})
});
const choice = (id, status) => ({
  id, title: "What next?", question: "Что делаем дальше?",
  options: [{ id: "o1", label: "Ship it" }, { id: "o2", label: "Wait" }], status,
  ...(status === "cancelled" ? { cancelledAt: new Date().toISOString() } : {})
});
const approval = (status) => ({
  id: "perm-bash", conversationId: CHAT_B, requesterParticipantId: GERA.id, requesterHandle: "gera", requesterRoleConfigId: GERA.roleConfigId,
  toolName: "Bash", capability: "shell", status, request: { command: "ls" }, summary: "Use Bash",
  createdAt: minutesAgo(10), updatedAt: new Date().toISOString()
});
// A list the server built before a card arrived: what the phone may judge by.
const chatItem = (id, title, pendingCards) => ({
  id, title, group: "AccordAgents", snippet: "…", who: "gera:", updatedAt: minutesAgo(9), running: false,
  participants: ["@gera", "@taylor"], members: [], pendingCards
});
const TAP_SETTLE_MS = 700;

test("the phone drops cards the desktop closed, keeps its sent marks across a launch, and flushes every chat's queue", { timeout: 240_000 }, async (t) => {
  const hub = await startMobileHub();
  const site = await serveMobileShell({ port: SITE_PORT, hubOrigins: [hub.base] });
  const profile = await tempProfile("aa-mobile-reconcile-");
  const chrome = launchChrome({ port: CDP_PORT, profile, url: `${site.origin}/` });
  let app;
  try {
    await hub.createChat(CHAT_A, { title: "PWA cleanup", participants: [GERA, TAYLOR], createdAt: minutesAgo(20),
      messages: [message("a1", TAYLOR, "Что делаем дальше?", 10, { pendingChoice: choice("choice-stale", "pending") })] });
    await hub.createChat(CHAT_B, { title: "Octopi Tracker", participants: [GERA, TAYLOR], createdAt: minutesAgo(20),
      messages: [message("b1", GERA, "Need Bash for this.", 10)] });
    await hub.raiseApproval(CHAT_B, approval("pending"));
    app = await attachApp({ port: CDP_PORT });
    const evaluate = app.evaluate;
    const waitFor = async (expr, label, tries = 60) => {
      let value;
      for (let i = 0; i < tries; i += 1) {
        value = await evaluate(expr).catch(() => null);
        if (value) return value;
        await sleep(500);
      }
      assert.fail(`timed out waiting for ${label}`);
    };
    const reload = async () => {
      await app.send("Page.reload", {});
      await sleep(800);
      await waitFor(`document.readyState === "complete" && Boolean(globalThis.AccordAgentsMobile) ? true : null`, "the reloaded page");
    };
    const pendingRows = `(() => {
      const list = document.getElementById("activity-list");
      if (!document.getElementById("activity-screen").classList.contains("is-active") || list.dataset.activityTab !== "pending") return null;
      return [...list.querySelectorAll(".act-row")].map((row) => ({
        card: row.dataset.cardId || "", text: row.innerText.replace(/\\s+/g, " ").trim(),
        onItsWay: row.classList.contains("is-on-its-way"),
        disabled: [...row.querySelectorAll("button.act-pill")].map((button) => button.disabled)
      }));
    })()`;
    const openActivityPending = async () => {
      await evaluate(`document.querySelector('[data-home-tab="activity"]').click()`);
      await waitFor(`document.getElementById("activity-screen").classList.contains("is-active") ? true : null`, "Activity");
      await evaluate(`document.querySelector('[data-activity-tab="pending"]')?.click()`);
      await sleep(TAP_SETTLE_MS);
    };
    const answersAtServer = () => hub.phoneEvents("permission.decided");

    // Paired for every chat: no chat preselected, the phone opens on its
    // home screens. The list is what the server holds.
    await pairPage(app, { hub, siteOrigin: site.origin });
    await openActivityPending();
    let rows = await waitFor(`(() => { const rows = ${pendingRows}; return rows && rows.length === 2 ? rows : null; })()`, "both cards in Pending");
    t.diagnostic(`pending before: ${rows.map((row) => row.card).join(", ")}`);

    // The permission is allowed from the row. The answer is queued, handed to
    // the server, and the row says so.
    await evaluate(`document.querySelector('#activity-list .act-row[data-card-id="perm-bash"] .act-pill[data-option-id="allow"]').click()`);
    rows = await waitFor(`(() => {
      const rows = ${pendingRows};
      const row = rows && rows.find((item) => item.card === "perm-bash");
      return row && row.onItsWay && row.disabled.every(Boolean) ? rows : null;
    })()`, "the permission row to say the answer was sent");
    for (let i = 0; i < 40 && answersAtServer().length === 0; i += 1) await sleep(500);
    assert.equal(answersAtServer().length, 1, "the answer reached the server");

    // After a launch the mark is still there: the card is not offered as if
    // nothing had been answered (what the User saw), and it cannot be
    // answered a second time.
    await reload();
    await openActivityPending();
    rows = await waitFor(`(() => { const rows = ${pendingRows}; return rows && rows.length === 2 ? rows : null; })()`, "Pending after the launch");
    const permAfterLaunch = rows.find((row) => row.card === "perm-bash");
    assert.equal(permAfterLaunch.onItsWay, true, "the sent mark survived the launch");
    assert.ok(permAfterLaunch.disabled.every(Boolean), "and the options stay dead");
    assert.equal(await evaluate(`globalThis.AccordAgentsMobile.isCardSent("perm-bash")`), true);

    // An answer the server has taken is not lost, only waiting for the
    // desktop: however long ago it was given, the card stays locked and says
    // the answer was sent. Unlocked, a second answer only raced the first,
    // and the older one won on the desktop.
    await evaluate(`(() => {
      const marks = JSON.parse(localStorage.getItem("accordagents.mobile.controlCardSent.v1") || "{}");
      marks["perm-bash"] = { ...marks["perm-bash"], at: new Date(Date.now() - 11 * 60000).toISOString() };
      localStorage.setItem("accordagents.mobile.controlCardSent.v1", JSON.stringify(marks));
      return true;
    })()`);
    await reload();
    await openActivityPending();
    rows = await waitFor(`(() => {
      const rows = ${pendingRows};
      const row = rows && rows.find((item) => item.card === "perm-bash");
      return row && row.onItsWay && row.disabled.every(Boolean) ? rows : null;
    })()`, "an answer the server holds to keep the card locked");
    assert.equal(await evaluate(`globalThis.AccordAgentsMobile.isCardLocked("perm-bash")`), true);

    // An answer nobody has taken that has been on its way for too long has
    // stopped meaning anything: the card unlocks and says so, and answering
    // again replaces the earlier answer rather than racing it.
    const earlierEventId = await evaluate(`(async () => {
      const marks = JSON.parse(localStorage.getItem("accordagents.mobile.controlCardSent.v1") || "{}");
      const eventId = marks["perm-bash"] && marks["perm-bash"].eventId;
      const db = await self.AccordMobileDb.openControlDb(indexedDB);
      const tx = db.transaction("outbox", "readwrite");
      const store = tx.objectStore("outbox");
      await new Promise((resolve) => { const get = store.get(eventId); get.onsuccess = () => { store.put({ ...get.result, status: "waiting-to-sync" }); resolve(); }; });
      await new Promise((resolve) => { tx.oncomplete = resolve; });
      db.close();
      return eventId;
    })()`);
    assert.ok(earlierEventId, "the mark names the queue entry that carried the first answer");
    // The server takes nothing for now, so the launch's flush cannot hand the
    // answer over again behind the test's back.
    hub.setGate(async (request) => request.method === "POST" && request.path === "/v1/events" ? { status: 503, body: { ok: false } } : undefined);
    await reload();
    await openActivityPending();
    rows = await waitFor(`(() => {
      const rows = ${pendingRows};
      const row = rows && rows.find((item) => item.card === "perm-bash");
      return row && /You can answer again/.test(row.text) && !row.onItsWay && row.disabled.every((dead) => !dead) ? rows : null;
    })()`, "the stale answer to unlock the card");
    assert.equal(await evaluate(`globalThis.AccordAgentsMobile.isCardLocked("perm-bash")`), false);
    hub.setGate(undefined);
    await evaluate(`document.querySelector('#activity-list .act-row[data-card-id="perm-bash"] .act-pill[data-option-id="deny"]').click()`);
    await waitFor(`(() => {
      const rows = ${pendingRows};
      const row = rows && rows.find((item) => item.card === "perm-bash");
      return row && row.onItsWay && row.disabled.every(Boolean) ? true : null;
    })()`, "the second answer to lock the card again");
    const superseded = await evaluate(`globalThis.AccordAgentsMobile.listOutboxEntries().then((entries) => entries.map((entry) => entry.eventId + "=" + entry.status))`);
    assert.ok(superseded.includes(earlierEventId + "=superseded"), `the earlier answer was set aside, not sent: ${superseded.join(", ")}`);
    assert.equal(await evaluate(`globalThis.AccordAgentsMobile.desktopOwesEntry({ status: "superseded" })`), false);
    // The second answer goes out after the row already says so; give it time.
    for (let i = 0; i < 40 && answersAtServer().length < 2; i += 1) await sleep(500);
    assert.deepEqual(answersAtServer().map((event) => event.payload.stateId), ["approved", "denied"],
      "only the two answers the User actually gave reached the server");

    // The cards reached this phone a while ago (the User's were days old); a
    // card that arrived within the last few minutes is left for the next list
    // to judge, so age them here.
    await evaluate(`(() => {
      const all = JSON.parse(localStorage.getItem("accordagents.mobile.controlCards.v1") || "{}");
      for (const list of Object.values(all)) for (const card of list) card.receivedAt = new Date(Date.now() - 10 * 60000).toISOString();
      localStorage.setItem("accordagents.mobile.controlCards.v1", JSON.stringify(all));
      return true;
    })()`);
    // The choice is closed on the desktop while the phone is not looking at
    // its chat: only the chat list says so. Chat B still waits on the
    // permission. The stale choice leaves; the permission stays, still
    // marked as sent.
    await hub.updateMessages(CHAT_A, [message("a1", TAYLOR, "Что делаем дальше?", 10, { pendingChoice: choice("choice-stale", "cancelled") })]);
    rows = await waitFor(`(() => {
      const rows = ${pendingRows};
      return rows && rows.length === 1 && rows[0].card === "perm-bash" ? rows : null;
    })()`, "the choice the desktop closed to leave Pending");
    assert.equal(rows[0].onItsWay, true);
    const storedA = await evaluate(`JSON.parse(localStorage.getItem("accordagents.mobile.controlCards.v1"))[${JSON.stringify(CHAT_A)}] || []`);
    assert.deepEqual(storedA.filter((card) => card.status === "pending"), [], "chat A holds no pending card any more");

    // The chat itself agrees: nothing waits in it, under the message or at its end.
    await evaluate(`document.querySelector('[data-home-tab="chats"]').click()`);
    await waitFor(`document.querySelector('.mobile-chat-row[data-conversation-id=${JSON.stringify(CHAT_A)}]') ? true : null`, "chat A listed");
    await evaluate(`document.querySelector('.mobile-chat-row[data-conversation-id=${JSON.stringify(CHAT_A)}]').click()`);
    await waitFor(`document.getElementById("timeline-screen").classList.contains("is-active") ? true : null`, "chat A open");
    await sleep(1500);
    assert.equal(await evaluate(`document.querySelectorAll('#message-list .control-card:not(.control-card-answered)[data-card-id="choice-stale"]').length`), 0,
      "the closed choice is not offered in the chat any more");
    await evaluate(`document.getElementById("back-to-chats").click()`);
    await waitFor(`!document.getElementById("timeline-screen").classList.contains("is-active") ? true : null`, "back home");

    // A pending card younger than the list may simply have missed it: it
    // stays until the next list decides.
    await hub.addMessages(CHAT_A, [message("a2", TAYLOR, "One more question.", 0, { pendingChoice: choice("choice-fresh", "pending") })]);
    await openActivityPending();
    await waitFor(`(() => { const rows = ${pendingRows}; return rows && rows.some((row) => row.card === "choice-fresh") ? true : null; })()`, "the fresh card in Pending");
    // The desktop applies the permission's answer: the server's own list
    // stops naming it.
    await hub.raiseApproval(CHAT_B, approval("denied"));
    await evaluate(`globalThis.AccordAgentsMobile.handleRelayChatListPayload(${JSON.stringify({
      type: "mobile.chat-list", generatedAt: new Date().toISOString(),
      chats: [chatItem(CHAT_A, "PWA cleanup", []), chatItem(CHAT_B, "Octopi Tracker", [])]
    })})`);
    await waitFor(`(() => { const rows = ${pendingRows}; return rows && !rows.some((row) => row.card === "perm-bash") ? true : null; })()`, "the applied permission to leave Pending");
    await sleep(1200);
    rows = await evaluate(pendingRows);
    assert.ok(rows.some((row) => row.card === "choice-fresh"), "a card younger than the list is kept");
    assert.ok(!rows.some((row) => row.card === "perm-bash"), "a card the desktop no longer waits on is gone");
    assert.equal(await evaluate(`globalThis.AccordAgentsMobile.isCardSent("perm-bash")`), false, "its sent mark went with it");

    // The queue is flushed for every chat, not only the open one.
    await evaluate(`globalThis.AccordAgentsMobile.enqueueMessage({ content: "queued for chat A while elsewhere", conversationId: ${JSON.stringify(CHAT_A)} }).then(() => true)`);
    const flushed = await evaluate(`globalThis.AccordAgentsMobile.flushOutbox().then((result) => JSON.stringify(result))`);
    t.diagnostic(`flush: ${flushed}`);
    await hub.settle();
    const sent = hub.phoneEvents("chat.changes").filter((event) => event.conversationId === CHAT_A);
    assert.equal(sent.length, 1, "the queued message for the other chat went out");
    assert.equal(sent[0].payload.changes[0].message.content, "queued for chat A while elsewhere");
    const statuses = await evaluate(`globalThis.AccordAgentsMobile.listOutboxEntries().then((entries) => entries.map((entry) => entry.eventId + "=" + entry.status))`);
    // The answer set aside earlier stays set aside; everything the server was
    // owed is acked.
    assert.ok(!statuses.some((status) => !status.endsWith("=acked") && !status.endsWith("=superseded")),
      `everything else is acked or set aside: ${statuses.join(", ")}`);
  } finally {
    app?.close();
    chrome.kill("SIGKILL");
    await site.close();
    await hub.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

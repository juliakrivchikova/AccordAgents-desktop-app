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
 * the server's, raised the way a member's device raises them, the list is
 * the server's, and an answer is the card's one answer there. One list is
 * made by hand: a list read just before a card arrived, which can only be had
 * by holding it.
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
    await hub.raiseApproval(CHAT_B, approval("pending"), { participantId: GERA.id });
    await hub.raiseChoice(CHAT_A, message("a1", TAYLOR, "Что делаем дальше?", 10, { pendingChoice: choice("choice-stale", "pending") }), { participantId: TAYLOR.id });
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
    const answersAtServer = () => hub.phoneOps("card.answer");

    // Paired for every chat: no chat preselected, the phone opens on its
    // home screens. The list is what the server holds.
    await pairPage(app, { hub, siteOrigin: site.origin });
    await openActivityPending();
    let rows = await waitFor(`(() => { const rows = ${pendingRows}; return rows && rows.length === 2 ? rows : null; })()`, "both cards in Pending");
    t.diagnostic(`pending before: ${rows.map((row) => row.card).join(", ")}`);

    // The server takes nothing for now: the answer waits on the phone.
    hub.setGate(async (request) => request.method === "POST" && request.path === "/v3/ops" ? { status: 503, body: { ok: false, error: "Not now." } } : undefined);
    // The permission is allowed from the row. The answer is queued and the
    // row folds to it.
    await evaluate(`document.querySelector('#activity-list .act-row[data-card-id="perm-bash"] .act-pill[data-option-id="allow"]').click()`);
    rows = await waitFor(`(() => {
      const rows = ${pendingRows};
      const row = rows && rows.find((item) => item.card === "perm-bash");
      return row && row.onItsWay && row.disabled.every(Boolean) ? rows : null;
    })()`, "the permission row to fold to the answer");

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
    assert.equal((await answersAtServer()).length, 0, "the server took nothing yet");

    // An answer nobody has taken that has been on its way for too long has
    // stopped meaning anything: the card unlocks and says so, and answering
    // again replaces the earlier answer rather than racing it.
    const earlierEventId = await evaluate(`(() => {
      const marks = JSON.parse(localStorage.getItem("accordagents.mobile.controlCardSent.v1") || "{}");
      marks["perm-bash"] = { ...marks["perm-bash"], at: new Date(Date.now() - 11 * 60000).toISOString() };
      localStorage.setItem("accordagents.mobile.controlCardSent.v1", JSON.stringify(marks));
      return marks["perm-bash"].eventId;
    })()`);
    assert.ok(earlierEventId, "the mark names the queue entry that carried the first answer");
    await reload();
    await openActivityPending();
    rows = await waitFor(`(() => {
      const rows = ${pendingRows};
      const row = rows && rows.find((item) => item.card === "perm-bash");
      return row && /You can answer again/.test(row.text) && !row.onItsWay && row.disabled.every((dead) => !dead) ? rows : null;
    })()`, "the stale answer to unlock the card");
    assert.equal(await evaluate(`globalThis.AccordAgentsMobile.isCardLocked("perm-bash")`), false);
    await evaluate(`document.querySelector('#activity-list .act-row[data-card-id="perm-bash"] .act-pill[data-option-id="deny"]').click()`);
    await waitFor(`(() => {
      const rows = ${pendingRows};
      const row = rows && rows.find((item) => item.card === "perm-bash");
      return row && row.onItsWay && row.disabled.every(Boolean) ? true : null;
    })()`, "the second answer to lock the card again");
    hub.setGate(undefined);
    await evaluate(`globalThis.AccordAgentsMobile.flushOutbox().then(() => true)`);
    const superseded = await evaluate(`globalThis.AccordAgentsMobile.listOutboxEntries().then((entries) => entries.map((entry) => entry.eventId + "=" + entry.status))`);
    assert.ok(superseded.includes(earlierEventId + "=superseded"), `the earlier answer was set aside, not sent: ${superseded.join(", ")}`);
    assert.equal(await evaluate(`globalThis.AccordAgentsMobile.serverOwesEntry({ status: "superseded" })`), false);
    for (let i = 0; i < 40 && (await answersAtServer()).length < 1; i += 1) await sleep(500);
    const answers = await answersAtServer();
    assert.deepEqual(answers.map((entry) => entry.effect.card.answer.approve), [false], "only the answer the User stood by reached the server");
    // Answered on the server: nothing waits for the User in it any more.
    await waitFor(`(() => { const rows = ${pendingRows}; return rows && !rows.some((row) => row.card === "perm-bash") ? true : null; })()`, "the answered permission to leave Pending");
    assert.equal(await evaluate(`globalThis.AccordAgentsMobile.isCardSent("perm-bash")`), false, "its sent mark went with it");
    // The failed tries are in the send log, with the server's own words.
    const failures = await evaluate(`globalThis.AccordAgentsMobile.listSendFailures()`);
    assert.ok(failures.some((row) => row.kind === "card.answer" && row.cause === "http" && /503: Not now\./.test(row.reason)), `the 503 is in the log: ${JSON.stringify(failures.slice(0, 3))}`);

    // The choice is closed on the server while the phone is not looking at
    // its chat: only the chat list says so, and a list the phone asked for
    // after the card reached it is the later word, so the card goes at once.
    await hub.updateMessages(CHAT_A, [message("a1", TAYLOR, "Что делаем дальше?", 10, { pendingChoice: choice("choice-stale", "cancelled") })]);
    await hub.settleCard(CHAT_A, "choice-stale", { cancelled: true });
    rows = await waitFor(`(() => {
      const rows = ${pendingRows};
      return rows && rows.length === 0 ? rows : null;
    })()`, "the choice the server closed to leave Pending");
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

    // A list this phone asked for before a card reached it may simply have
    // missed the card: it stays until a later list decides.
    const fresh = message("a2", TAYLOR, "One more question.", 0, { pendingChoice: choice("choice-fresh", "pending") });
    await hub.addMessages(CHAT_A, [fresh]);
    await hub.raiseChoice(CHAT_A, fresh, { participantId: TAYLOR.id });
    await openActivityPending();
    await waitFor(`(() => { const rows = ${pendingRows}; return rows && rows.some((row) => row.card === "choice-fresh") ? true : null; })()`, "the fresh card in Pending");
    const emptyList = { type: "mobile.chat-list", generatedAt: new Date().toISOString(),
      chats: [chatItem(CHAT_A, "PWA cleanup", []), chatItem(CHAT_B, "Octopi Tracker", [])] };
    const freshAfter = (requestedAt) => evaluate(`(() => {
      globalThis.AccordAgentsMobile.handleRelayChatListPayload(${JSON.stringify(emptyList)}, { requestedAt: ${requestedAt} });
      const held = JSON.parse(localStorage.getItem("accordagents.mobile.controlCards.v1"))[${JSON.stringify(CHAT_A)}] || [];
      return held.some((card) => card.id === "choice-fresh" && card.status === "pending");
    })()`);
    assert.equal(await freshAfter(Date.now() - 60_000), true, "a list asked for before the card arrived does not close it");
    // A list asked for after the card arrived that does not name it is the
    // later word: the card goes at once, not minutes later.
    assert.equal(await freshAfter(Date.now()), false, "a list asked for after the card arrived closes it at once");

    // The queue is flushed for every chat, not only the open one.
    await evaluate(`globalThis.AccordAgentsMobile.enqueueMessage({ content: "queued for chat A while elsewhere", conversationId: ${JSON.stringify(CHAT_A)} }).then(() => true)`);
    const flushed = await evaluate(`globalThis.AccordAgentsMobile.flushOutbox().then((result) => JSON.stringify(result))`);
    t.diagnostic(`flush: ${flushed}`);
    await hub.settle();
    const sent = (await hub.phoneOps("message.create")).filter((entry) => entry.conversationId === CHAT_A);
    assert.equal(sent.length, 1, "the queued message for the other chat went out");
    assert.equal(sent[0].effect.message.content, "queued for chat A while elsewhere");
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

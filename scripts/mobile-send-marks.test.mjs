/**
 * What the phone says about what it sent, driven through the real PWA in a
 * browser against a real hub (the User's own server).
 *
 * The agreements of 2026-10-28 (artifact "Сервер — хозяин переписки") as the
 * User set them on 2026-10-29: a message is faded until the server accepted
 * it, then shown as any message, with no words about it; a member's reply
 * under it is the sign that work started; only a refusal says something, with
 * its reason. Every failed try is written to a log the User can read on the
 * phone, with its reason (Д12).
 * The incident behind them: two messages sat 9–12 minutes on the phone while
 * the app was open and the server reachable, and nothing said why.
 *
 * This is desktop Chrome, not the installed phone: it runs the files the
 * phone runs, under the same origin headers.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { rm } from "node:fs/promises";
import { attachApp, launchChrome, member, openChat, pairPage, serveMobileShell, sleep, startMobileHub, tempProfile } from "./mobile-hub-fixture.mjs";

const CHAT = "conv-marks";
const DREW = member("drew");

async function phone(t, ports) {
  const hub = await startMobileHub();
  const site = await serveMobileShell({ port: ports.site, hubOrigins: [hub.base] });
  const profile = await tempProfile("aa-mobile-marks-");
  const chrome = launchChrome({ port: ports.cdp, profile, url: `${site.origin}/`, width: 430, height: 860 });
  let app;
  t.after(async () => {
    app?.close();
    chrome.kill("SIGKILL");
    await site.close();
    await hub.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  await hub.createChat(CHAT, { title: "Marks", participants: [DREW] });
  app = await attachApp({ port: ports.cdp });
  await pairPage(app, { hub, siteOrigin: site.origin, query: "qa=1" });
  await openChat(app, CHAT);
  const send = (text) => app.evaluate(`(() => {
    const input = document.getElementById("composer-input");
    input.value = ${JSON.stringify(text)};
    input.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("composer-form").dispatchEvent(new Event("submit", { cancelable: true }));
    return true;
  })()`);
  /** The User's own rows: what each says under its text, and whether it fades. */
  const ownRows = () => app.evaluate(`[...document.querySelectorAll('#message-list .message-row[data-author="you"]')].map((row) => ({
    text: row.querySelector(".message-content").textContent,
    status: row.querySelector(".message-status").textContent,
    faded: row.classList.contains("is-on-its-way"),
    refused: row.classList.contains("is-refused")
  }))`);
  const entryOf = (text) => app.evaluate(`AccordAgentsMobile.listOutboxEntries().then((rows) => rows.find((row) => row.payload && row.payload.content === ${JSON.stringify(text)}) || null)`);
  return { hub, app, send, ownRows, entryOf };
}

test("a message the server cannot take says so, its failed tries are in the log with their reasons, and it is taken once when the server is back", { timeout: 180_000 }, async (t) => {
  const { hub, app, send, ownRows, entryOf } = await phone(t, { site: 8331, cdp: 9471 });
  // The connection drops on every write: nothing reaches the server.
  hub.setGate(async (request) => request.method === "POST" && request.path === "/v3/ops" ? { drop: true } : undefined);
  await send("@drew are you there?");
  await app.waitFor(`(async () => { const rows = await (${ownRowsSource()}); const row = rows.find((item) => item.text === "@drew are you there?"); return Boolean(row && /^\\d{2}:\\d{2}$/.test(row.status) && row.faded); })()`,
    "the message fades, with only its time under it");
  await app.waitFor(`document.getElementById("connection-state").textContent === "Not connected"`, "the header says nothing could be reached");
  // Tried again by itself while the app is open, the pauses growing.
  await app.waitFor(`AccordAgentsMobile.listSendFailures().then((rows) => rows.filter((row) => row.kind === "message.created").length >= 3)`,
    "three failed tries in the log", 20_000);
  const tries = (await app.evaluate(`AccordAgentsMobile.listSendFailures()`)).filter((row) => row.kind === "message.created").reverse();
  const gaps = tries.slice(1, 3).map((row, index) => Date.parse(row.at) - Date.parse(tries[index].at));
  t.diagnostic(`gaps between tries: ${gaps.join(", ")} ms`);
  assert.ok(gaps[0] >= 1_500 && gaps[0] < 3_500, `the first try again comes about two seconds later: ${gaps}`);
  assert.ok(gaps[1] >= 3_000 && gaps[1] < 6_500, `the next one waits longer: ${gaps}`);
  assert.equal(tries[0].text, "@drew are you there?", "the log says what was sent");
  assert.equal(tries[0].conversationId, CHAT);
  assert.equal(tries[0].chatTitle, "Marks", "and in which chat");
  assert.equal(tries[0].cause, "network");
  assert.match(tries[0].reason, /^Could not reach your server/, "and why");

  // The server answers, but with an error of its own: said with its words.
  hub.setGate(async (request) => request.method === "POST" && request.path === "/v3/ops" ? { status: 503, body: { ok: false, error: "The hub could not answer." } } : undefined);
  await app.evaluate(`AccordAgentsMobile.retryOutboxNow().then(() => true)`);
  const answered = (await app.evaluate(`AccordAgentsMobile.listSendFailures()`))[0];
  assert.equal(answered.cause, "http");
  assert.equal(answered.reason, "Your server answered 503: The hub could not answer.");
  assert.equal((await ownRows()).find((row) => row.text === "@drew are you there?").faded, true, "still not sent");

  // The log, from the chat's header, beside where it says it is not connected.
  await app.waitFor(`!document.getElementById("send-log-button").hidden && document.getElementById("send-log-spacer").hidden`, "the header's way to the log");
  await app.evaluate(`document.getElementById("send-log-button").click()`);
  await app.waitFor(`!document.getElementById("send-log-sheet").hidden && document.querySelectorAll("#send-log-list .send-log-row").length > 0`, "the send log to open");
  const log = await app.evaluate(`({
    summary: document.getElementById("send-log-summary").textContent,
    rows: [...document.querySelectorAll("#send-log-list .send-log-row")].map((row) => ({
      when: row.querySelector(".send-log-when").textContent, what: row.querySelector(".send-log-what").textContent,
      why: row.querySelector(".send-log-why").textContent, count: row.querySelector(".send-log-count")?.textContent || ""
    })),
    dockHidden: document.getElementById("home-dock").hidden
  })`);
  t.diagnostic(`log: ${JSON.stringify(log)}`);
  assert.equal(log.summary, "1 thing you sent has not reached your server yet. It is tried again while the app is open.");
  assert.equal(log.rows[0].what, "Message “@drew are you there?”");
  assert.equal(log.rows[0].why, "Your server answered 503: The hub could not answer.");
  assert.match(log.rows[0].when, /^\d{2}:\d{2} · Marks$/);
  assert.match(log.rows[1].why, /^Could not reach your server/);
  assert.match(log.rows[1].count, /^\d+ tries, \d{2}:\d{2}–\d{2}:\d{2}$/, "tries that failed the same way one after another are one row");
  assert.equal(log.dockHidden, true, "the bar steps aside for the log");
  await app.evaluate(`document.getElementById("send-log-close").click()`);

  // Back: taken at the next try, once, however many tries came before.
  hub.setGate(undefined);
  await app.waitFor(`(async () => { const rows = await (${ownRowsSource()}); const row = rows.find((item) => item.text === "@drew are you there?"); return Boolean(row && /^\\d{2}:\\d{2}$/.test(row.status) && !row.faded); })()`,
    "the message to be taken by the server when it is back", 40_000);
  await app.waitFor(`document.getElementById("connection-state").textContent === "Synced"`, "the header to say Synced once a send got through");
  const entry = await entryOf("@drew are you there?");
  assert.equal(entry.status, "acked");
  await hub.settle();
  const taken = (await hub.phoneOps("message.create")).filter((op) => op.opId === entry.eventId);
  assert.equal(taken.length, 1, "the server took the message once");
  const copy = (await hub.storage.getConversation(CHAT)).messages.filter((message) => message.id === entry.eventId);
  assert.equal(copy.length, 1, "and holds it once");
  assert.equal(copy[0].content, "@drew are you there?");
  await app.waitFor(`document.getElementById("send-log-button").hidden`, "the header's pointer to the log to go once everything was sent");
  // Settings keeps the way to the log.
  await app.evaluate(`document.getElementById("back-to-chats").click()`);
  await app.evaluate(`document.querySelector('[data-home-tab="settings"]').click()`);
  await app.waitFor(`/Send log/.test(document.getElementById("settings-list").innerText) && /Everything you sent has reached your server\\. Last failed try/.test(document.getElementById("settings-list").innerText)`,
    "Settings to name the send log");
});

test("a message the server refuses says it was not taken, and why, and is not tried again", { timeout: 120_000 }, async (t) => {
  const { hub, app, send, ownRows, entryOf } = await phone(t, { site: 8333, cdp: 9473 });
  hub.setGate(async (request) => request.method === "POST" && request.path === "/v3/ops"
    ? { status: 200, body: { results: (request.ops || []).map((op) => ({ opId: op.opId, status: "rejected", reason: "This chat was deleted." })), head: 0 } }
    : undefined);
  await send("refuse me");
  await app.waitFor(`(async () => { const rows = await (${ownRowsSource()}); const row = rows.find((item) => item.text === "refuse me"); return Boolean(row && row.status === "Not taken by your server: This chat was deleted." && row.refused && !row.faded); })()`,
    "the message to say it was not taken, with the server's reason");
  const entry = await entryOf("refuse me");
  assert.equal(entry.status, "refused");
  const carrying = () => hub.requests.filter((request) => request.path === "/v3/ops" && (request.ops || []).some((op) => op.opId === entry.eventId)).length;
  assert.equal(carrying(), 1, "sent once");
  await sleep(5_000);
  assert.equal(carrying(), 1, "a refusal is not tried again");
  const failures = await app.evaluate(`AccordAgentsMobile.listSendFailures()`);
  assert.equal(failures[0].cause, "refused");
  assert.equal(failures[0].reason, "Your server did not take it: This chat was deleted.");
  assert.equal(failures[0].text, "refuse me");
  // The header points at the log until it was looked at.
  await app.waitFor(`!document.getElementById("send-log-button").hidden`, "the header's way to the log after a refusal");
  await app.evaluate(`document.getElementById("send-log-button").click()`);
  await app.waitFor(`!document.getElementById("send-log-sheet").hidden`, "the log");
  assert.equal(await app.evaluate(`document.querySelector("#send-log-list .send-log-row .send-log-why").textContent`), "Your server did not take it: This chat was deleted.");
  await app.evaluate(`document.getElementById("send-log-close").click()`);
  await app.waitFor(`document.getElementById("send-log-button").hidden`, "the pointer to go once the refusal was seen");
  t.diagnostic(JSON.stringify(await ownRows()));
});

test("a message is faded until the server takes it, then shown as any message, and says nothing when a member takes it", { timeout: 120_000 }, async (t) => {
  const { hub, app, send, entryOf } = await phone(t, { site: 8335, cdp: 9475 });
  // The server's answer is held for a while, so the faded message can be seen.
  hub.setGate(async (request) => request.method === "POST" && request.path === "/v3/ops" ? { delayMs: 1_500 } : undefined);
  await app.evaluate(`(() => {
    window.__marks = [];
    const list = document.getElementById("message-list");
    const read = () => {
      for (const row of list.querySelectorAll('.message-row[data-author="you"]')) {
        if (row.querySelector(".message-content").textContent !== "@drew mark this") continue;
        const status = row.querySelector(".message-status").textContent;
        const shown = (row.classList.contains("is-on-its-way") ? "faded " : "plain ") + status;
        if (window.__marks[window.__marks.length - 1] !== shown) window.__marks.push(shown);
      }
    };
    new MutationObserver(read).observe(list, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class"] });
    return true;
  })()`);
  await send("@drew mark this");
  await app.waitFor(`window.__marks.some((mark) => mark.startsWith("plain "))`, "the message to be taken by the server", 20_000);
  const entry = await entryOf("@drew mark this");
  hub.setGate(undefined);
  // The member's own device (the Mac, for a member that runs there) takes
  // the turn the message asked of it: the message says nothing about it.
  const turn = await hub.turn(entry.eventId, DREW.id);
  assert.equal(turn.state, "requested", "the server asked a turn of the member the message names");
  await hub.claimTurn(CHAT, entry.eventId, DREW.id);
  await sleep(2_000);
  const marks = await app.evaluate(`window.__marks`);
  t.diagnostic(`marks: ${JSON.stringify(marks)}`);
  assert.deepEqual(marks.map((mark) => mark.replace(/\d{2}:\d{2}$/, "HH:MM")), ["faded HH:MM", "plain HH:MM"], `faded, then plain, only its time: ${JSON.stringify(marks)}`);
});

test("a Stop on a member still waiting for its device stops the turn on the server; two messages with the same words stay two", { timeout: 120_000 }, async (t) => {
  const { hub, app, send, ownRows, entryOf } = await phone(t, { site: 8337, cdp: 9477 });
  await send("@drew do not start this");
  // Nobody takes the turn: the member's row waits for the Mac, with Stop.
  await app.waitFor(`(() => { const row = document.querySelector('#message-list .message-row[data-row-key^="routed"]'); return Boolean(row && /Waiting for your Mac to start it/.test(row.innerText) && row.querySelector(".message-stop")); })()`,
    "the member's waiting row, with Stop");
  const entry = await entryOf("@drew do not start this");
  await app.evaluate(`document.querySelector('#message-list .message-row[data-row-key^="routed"] .message-stop').click()`);
  await app.waitFor(`AccordAgentsMobile.listOutboxEntries().then((rows) => rows.some((row) => row.kind === "turn.stop" && row.status === "acked"))`, "the server to take the Stop");
  const stop = (await app.evaluate(`AccordAgentsMobile.listOutboxEntries()`)).find((row) => row.kind === "turn.stop");
  assert.deepEqual([stop.payload.runId, stop.payload.messageId, stop.payload.participantId], [`turn-${entry.eventId}-${DREW.id}`, entry.eventId, DREW.id],
    "the Stop names the turn the message asked of the member");
  const turn = await hub.turn(entry.eventId, DREW.id);
  assert.equal(turn.state, "stopped", "stopped on the server before anyone took it");
  // The member's device comes later: the turn is not its to start.
  const claim = await hub.ops([{ opId: hub.nextOpId(), kind: "turn.claim", conversationId: CHAT, runId: turn.runId, messageId: entry.eventId, participantId: DREW.id }]);
  assert.equal(claim.results[0].claim, "stopped", "a stopped turn is never started");
  await app.waitFor(`!document.querySelector('#message-list .message-row[data-row-key^="routed"]')`, "the waiting row to go");
  const stopped = (await ownRows()).find((row) => row.text === "@drew do not start this");
  assert.ok(/^\d{2}:\d{2}$/.test(stopped.status) && !stopped.faded, "the message itself was sent, shown as any message");

  // Two messages with the same words, and a third written on the desktop:
  // three messages, told apart by their ids, never folded by their text.
  await send("same words");
  await app.waitFor(`AccordAgentsMobile.listOutboxEntries().then((rows) => rows.filter((row) => row.payload && row.payload.content === "same words" && row.status === "acked").length === 1)`, "the first one sent");
  await send("same words");
  await app.waitFor(`AccordAgentsMobile.listOutboxEntries().then((rows) => rows.filter((row) => row.payload && row.payload.content === "same words" && row.status === "acked").length === 2)`, "the second one sent");
  await hub.addMessages(CHAT, [{ id: "desktop-same", role: "user", content: "same words", status: "done", createdAt: new Date().toISOString() }]);
  await app.waitFor(`AccordAgentsMobile.listTimelineEntries(${JSON.stringify(CHAT)}).then((rows) => rows.filter((row) => row.role === "you" && row.content === "same words").length === 3)`,
    "the server's three copies on the phone");
  await sleep(500);
  const same = (await ownRows()).filter((row) => row.text === "same words");
  assert.equal(same.length, 3, `three messages, three rows: ${JSON.stringify(same)}`);
  assert.ok(same.every((row) => /^\d{2}:\d{2}$/.test(row.status) && !row.faded), "each of them sent");
  const copies = (await hub.storage.getConversation(CHAT)).messages.filter((message) => message.content === "same words");
  assert.equal(copies.length, 3, "and three on the server");
});

test("a phone taken off the server's devices says so and stops offering what it holds", { timeout: 120_000 }, async (t) => {
  const { hub, app, send, entryOf } = await phone(t, { site: 8339, cdp: 9479 });
  // Removed on the Mac: the owner's roster no longer names it, its invite settled.
  const phoneDevice = (await hub.phones())[0];
  await hub.call("PUT", "/v1/roster", { devices: [{ deviceId: hub.owner.originId, publicKeyDerBase64: hub.owner.publicKeyDerBase64, role: "desktop", name: "Mac" }],
    resolvedInviteIds: [phoneDevice.inviteId] });
  await send("after removal");
  await app.waitFor(`AccordAgentsMobile.listSendFailures().then((rows) => rows.some((row) => row.cause === "revoked"))`, "the removal in the send log");
  const failure = (await app.evaluate(`AccordAgentsMobile.listSendFailures()`)).find((row) => row.cause === "revoked");
  assert.equal(failure.reason, "This phone was removed from your server, so it cannot send. Pair it again from your Mac.");
  const entry = await entryOf("after removal");
  assert.equal(entry.status, "queued", "kept on the phone: it is the User's, and goes if the phone is paired again");
  const carrying = () => hub.requests.filter((request) => request.path === "/v3/ops" && (request.ops || []).some((op) => op.opId === entry.eventId)).length;
  const tried = carrying();
  await sleep(6_000);
  assert.equal(carrying(), tried, "not offered again and again to a server that no longer knows the phone");
  await app.waitFor(`/This phone was removed from your server/.test(document.body.innerText)`, "the phone says it was removed");
});

/** The User's own rows, as an expression the page evaluates. */
function ownRowsSource() {
  return `Promise.resolve([...document.querySelectorAll('#message-list .message-row[data-author="you"]')].map((row) => ({
    text: row.querySelector(".message-content").textContent,
    status: row.querySelector(".message-status").textContent,
    faded: row.classList.contains("is-on-its-way"),
    refused: row.classList.contains("is-refused")
  })))`;
}

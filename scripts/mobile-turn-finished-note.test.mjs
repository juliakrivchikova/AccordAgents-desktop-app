/**
 * A turn-finished note on the phone (the User, 2026-11-04): when a member's
 * reply had other messages below it once its turn ended, the chat ends with
 * the desktop's card — the member, "finished answering", the time and the
 * reply's first line, and a cross. A tap leads back to the reply; the cross
 * takes the note away on every device, and a note taken away on another
 * device leaves the phone too. Driven through the real PWA in a browser
 * against a real hub that holds the chat the desktop published.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { rm } from "node:fs/promises";
import { attachApp, launchChrome, member, openChat, pairPage, serveMobileShell, startMobileHub, tempProfile } from "./mobile-hub-fixture.mjs";

const at = (minute) => new Date(Date.UTC(2026, 10, 4, 20, minute)).toISOString();
const finishedNote = (id, minute, replyId, who, content) => ({
  id, role: "system", content, status: "done", createdAt: at(minute),
  metadata: { appMessageSource: "app_turn_finished_note", turnFinishedNote: { messageId: replyId, participantId: who.id, participantLabel: `@${who.handle}` } }
});

test("a turn-finished note on the phone leads back to the reply and can be taken away", { timeout: 150_000 }, async (t) => {
  const hub = await startMobileHub();
  const site = await serveMobileShell({ port: 8373, hubOrigins: [hub.base] });
  const profile = await tempProfile("aa-mobile-finished-note-");
  const chrome = launchChrome({ port: 9519, profile, url: `${site.origin}/`, width: 430, height: 860 });
  let app;
  t.after(async () => {
    app?.close();
    chrome.kill("SIGKILL");
    await site.close();
    await hub.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  const taylor = member("taylor");
  // Enough between the reply and the end of the chat that the reply is off screen.
  const filler = Array.from({ length: 14 }, (_, index) => ({
    id: `post-${index}`, role: "participant", participantId: taylor.id, participantLabel: "@taylor",
    content: `Progress ${index + 1}: still working on the button, checking another width and another theme.`,
    status: "done", createdAt: at(41 + index * 0.1), metadata: { appMessageSource: "app_chat_send_message" }
  }));
  await hub.createChat("conv-finished", { title: "Button", participants: [taylor], messages: [
    { id: "ask", role: "user", content: "@taylor fix the cut-off button", status: "done", createdAt: at(40) },
    { id: "reply", role: "participant", participantId: taylor.id, participantLabel: "@taylor",
      content: "Done: the Save button is no longer cut off.\n\nDetails follow.", status: "done", createdAt: at(40.5) },
    ...filler,
    { id: "reply-2", role: "participant", participantId: taylor.id, participantLabel: "@taylor",
      content: "Also done: the dark theme.", status: "done", createdAt: at(43) },
    { id: "post-last", role: "user", content: "ok", status: "done", createdAt: at(43.5) },
    finishedNote("turn-finished-reply", 44, "reply", taylor, "Done: the Save button is no longer cut off.")
  ] });
  app = await attachApp({ port: 9519 });
  await pairPage(app, { hub, siteOrigin: site.origin, query: "qa=1" });
  await openChat(app, "conv-finished");

  await app.waitFor(`Boolean(document.querySelector('#message-list .finished-note-card'))`, "the note is on screen");
  const pageClock = (iso) => app.evaluate(`new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(${JSON.stringify(iso)}))`);
  const card = await app.evaluate(`(() => {
    const rows = [...document.querySelectorAll('#message-list .message-row')];
    const row = document.querySelector('#message-list .finished-note-card').closest('.message-row');
    const box = row.querySelector('.finished-note-card').getBoundingClientRect();
    const text = document.querySelector('#message-list .message-row[data-author="agent"] .message-copy').getBoundingClientRect();
    return {
      last: rows.at(-1) === row,
      title: row.querySelector('.finished-note-title').textContent,
      preview: row.querySelector('.finished-note-preview').textContent,
      avatar: Boolean(row.querySelector('.finished-note-open .message-avatar')),
      close: Boolean(row.querySelector('.finished-note-close svg')),
      bubble: Boolean(row.querySelector('.message-bubble')),
      left: Math.round(box.left), textLeft: Math.round(text.left), right: Math.round(box.right), width: window.innerWidth
    };
  })()`);
  assert.equal(card.last, true, "the note is the chat's last row");
  assert.equal(card.title, `@taylor finished answering · ${await pageClock(at(44))}`);
  assert.equal(card.preview, "Done: the Save button is no longer cut off.");
  assert.deepEqual({ avatar: card.avatar, close: card.close, bubble: card.bubble }, { avatar: true, close: true, bubble: false });
  assert.ok(Math.abs(card.left - card.textLeft) <= 1, `the card starts where a member's text does: ${JSON.stringify(card)}`);
  assert.ok(card.right <= card.width, `the card stays on screen: ${JSON.stringify(card)}`);

  // A tap leads back to the reply: scrolled to and marked.
  await app.evaluate(`document.querySelector('#message-list .finished-note-open').click()`);
  await app.waitFor(`Boolean(document.querySelector('#message-list .message-row[data-thread-root="reply"].message-focused'))`, "the reply is marked");
  const landed = await app.evaluate(`(() => {
    const surface = document.querySelector('#message-list').closest('.thread-surface, .chat-body, main') || document.scrollingElement;
    const row = document.querySelector('#message-list .message-row[data-thread-root="reply"]').getBoundingClientRect();
    return { top: Math.round(row.top), bottom: Math.round(row.bottom), height: window.innerHeight };
  })()`);
  assert.ok(landed.top >= 0 && landed.top < landed.height, `the reply is on screen: ${JSON.stringify(landed)}`);

  // The cross takes the note away here at once, and on the server.
  await app.evaluate(`document.querySelector('#message-list .finished-note-close').click()`);
  await app.waitFor(`!document.querySelector('#message-list .finished-note-card')`, "the note is gone from the phone");
  const removed = async () => (await hub.phoneOps("message.remove")).map((entry) => entry.effect.messageId);
  for (let tries = 0; tries < 100 && !(await removed()).includes("turn-finished-reply"); tries += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(await removed(), ["turn-finished-reply"], "the phone asked the server to remove the note");
  const held = await hub.storage.getConversation("conv-finished");
  assert.ok(!held.messages.some((message) => message.id === "turn-finished-reply"), "the server no longer holds it");

  // A note taken away on the computer leaves the phone as well.
  await hub.addMessages("conv-finished", [finishedNote("turn-finished-reply-2", 46, "reply-2", taylor, "Also done: the dark theme.")]);
  await app.waitFor(`Boolean(document.querySelector('#message-list .finished-note-card'))`, "the second note arrives");
  await hub.addMessages("conv-finished", [{ id: "later", role: "user", content: "thanks", status: "done", createdAt: at(47) }]);
  await hub.ops([{ opId: hub.nextOpId(), kind: "message.remove", conversationId: "conv-finished", messageId: "turn-finished-reply-2" }]);
  await hub.addMessages("conv-finished", [{ id: "later-2", role: "user", content: "and one more", status: "done", createdAt: at(48) }]);
  await app.waitFor(`document.getElementById("message-list").textContent.includes("and one more") &&
    !document.querySelector('#message-list .finished-note-card')`, "the note taken away on the computer is gone from the phone");
});

/**
 * The message that starts an Accord is, on the phone as on the desktop, a
 * card: the subject, "Accord · led by @facilitator · with @members · time",
 * no launch prompt (the User, 2026-11-07). Old launches, worded with
 * "participants", become cards too; a message that only looks like one stays
 * the bubble it was. Driven through the real PWA in a browser against a real
 * hub that holds the chat the desktop published.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { rm } from "node:fs/promises";
import { attachApp, launchChrome, member, openChat, pairPage, serveMobileShell, startMobileHub, tempProfile } from "./mobile-hub-fixture.mjs";

const at = (minute) => new Date(Date.UTC(2026, 10, 7, 16, minute)).toISOString();
const launch = (subject, members, wording = "members") => [
  "@taylor /accord",
  "",
  "Subject:",
  subject,
  "",
  `Selected accord ${wording}: ${members}.`,
  `Run the accord skill for exactly those selected ${wording} and this subject. Use app_chat_request_participants for those ${wording} only. The app has enabled request-${wording} permission for you in this chat; the user can revoke it from your ${wording === "members" ? "member" : "participant"} controls.`
].join("\n");
const userMessage = (id, minute, content) => ({ id, role: "user", content, status: "done", createdAt: at(minute), metadata: { threadId: id } });

test("Accord launches show as cards on the phone", { timeout: 120_000 }, async (t) => {
  const hub = await startMobileHub();
  const site = await serveMobileShell({ port: 8373, hubOrigins: [hub.base] });
  const profile = await tempProfile("aa-mobile-accord-launch-");
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
  const drew = member("drew");
  await hub.createChat("conv-accord", { title: "Accord", participants: [taylor, drew], messages: [
    userMessage("u-new", 31, launch("Pick the launch shape.\nKeep it to one short round.", "drew, gera")),
    userMessage("u-old", 32, launch("Old wording", "drew", "participants")),
    userMessage("u-plain", 33, "@taylor /accord please look at this"),
    { id: "m-1", role: "participant", participantId: taylor.id, participantLabel: "@taylor", content: "Starting.", status: "done", createdAt: at(34) }
  ] });
  app = await attachApp({ port: 9519 });
  await pairPage(app, { hub, siteOrigin: site.origin, query: "qa=1" });
  await openChat(app, "conv-accord");

  const rows = () => app.evaluate(`(() => [...document.querySelectorAll('#message-list .message-row[data-author="you"]')].map((row) => ({
    card: Boolean(row.querySelector(".accord-launch-card")),
    bubble: Boolean(row.querySelector(".message-bubble")),
    title: row.querySelector(".artifact-note-title")?.textContent ?? null,
    kind: row.querySelector(".accord-launch-kind")?.textContent ?? null,
    handles: [...row.querySelectorAll(".accord-launch-handle")].map((node) => node.textContent),
    avatars: row.querySelectorAll(".accord-launch-avatar.avatar-icon").length,
    status: row.querySelector(".accord-launch-meta .message-status")?.textContent ?? null,
    body: row.querySelector(".accord-launch-body")?.textContent ?? null,
    icon: row.querySelectorAll(".accord-launch-icon svg path").length,
    threadRoot: row.dataset.threadRoot ?? null,
    text: row.textContent
  })))()`);
  const pageClock = (iso) => app.evaluate(`new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(${JSON.stringify(iso)}))`);
  await app.waitFor(`document.querySelectorAll('#message-list .message-row[data-author="you"]').length === 3`, "the three messages are on screen");
  const [fresh, old, plain] = await rows();

  assert.deepEqual(
    { card: fresh.card, bubble: fresh.bubble, kind: fresh.kind, icon: fresh.icon, threadRoot: fresh.threadRoot },
    { card: true, bubble: false, kind: "Accord", icon: 4, threadRoot: "u-new" },
    "a launch is a card, opens its thread like the message did, and carries the Start Accord glyph"
  );
  assert.equal(fresh.title, "Pick the launch shape.");
  assert.equal(fresh.body, "Keep it to one short round.");
  assert.deepEqual(fresh.handles, ["@taylor", "@drew", "@gera"]);
  assert.equal(fresh.avatars, 3, "every member named has a picture, a removed one its stand-in");
  assert.equal(fresh.status, await pageClock(at(31)));
  assert.ok(!/Selected accord|app_chat_request_participants|\/accord/.test(fresh.text), `no launch prompt on screen: ${fresh.text}`);

  assert.equal(old.card, true, "an old launch, worded with participants, is a card too");
  assert.deepEqual(old.handles, ["@taylor", "@drew"]);
  assert.equal(old.body, null, "no body line for a one-line subject");

  assert.equal(plain.card, false, "a message that only mentions /accord stays a bubble");
  assert.equal(plain.bubble, true);

  const box = await app.evaluate(`(() => {
    const card = document.querySelector('#message-list .accord-launch-card');
    const text = document.querySelector('#message-list .message-row[data-author="agent"] .message-copy');
    const c = card.getBoundingClientRect(); const m = text.getBoundingClientRect();
    return { left: Math.round(c.left), textLeft: Math.round(m.left), right: Math.round(c.right), width: window.innerWidth };
  })()`);
  assert.ok(Math.abs(box.left - box.textLeft) <= 1, `the card starts where a member's text does: ${JSON.stringify(box)}`);
  assert.ok(box.right <= box.width, `the card stays on screen: ${JSON.stringify(box)}`);

  // Redrawn rows keep their shape: a reply gives the launch its thread chip.
  await hub.addMessages("conv-accord", [
    { id: "m-2", role: "participant", participantId: taylor.id, participantLabel: "@taylor", content: "Asked @drew.", status: "done", createdAt: at(35), metadata: { threadId: "u-new", parentMessageId: "u-new", chatThreadRootId: "u-new" } }
  ]);
  await app.waitFor(`Boolean(document.querySelector('#message-list .message-row[data-thread-root="u-new"] .thread-chip'))`, "the launch gets its replies' chip");
  const redrawn = await rows();
  assert.ok(redrawn[0].card && !redrawn[0].bubble, `the launch is still a card: ${JSON.stringify(redrawn[0])}`);
});

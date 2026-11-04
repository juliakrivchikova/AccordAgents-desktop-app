/**
 * An artifact note on the phone is the desktop's card (the User,
 * 2026-11-04): no avatar or author line, the artifact's name, who did what
 * with the version and time, and the member's note. A note the card cannot
 * read stays the bubble it was. Driven through the real PWA in a browser
 * against a real hub that holds the chat the desktop published.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { rm } from "node:fs/promises";
import { attachApp, launchChrome, member, openChat, pairPage, serveMobileShell, startMobileHub, tempProfile } from "./mobile-hub-fixture.mjs";

const at = (minute) => new Date(Date.UTC(2026, 10, 4, 16, minute)).toISOString();
const note = (id, minute, content) => ({
  id, role: "system", content, status: "done", createdAt: at(minute),
  metadata: { appMessageSource: "app_artifact_note", artifactEventId: `event-${id}` }
});

test("artifact notes show as cards on the phone", { timeout: 120_000 }, async (t) => {
  const hub = await startMobileHub();
  const site = await serveMobileShell({ port: 8371, hubOrigins: [hub.base] });
  const profile = await tempProfile("aa-mobile-artifact-note-");
  const chrome = launchChrome({ port: 9517, profile, url: `${site.origin}/`, width: 430, height: 860 });
  let app;
  t.after(async () => {
    app?.close();
    chrome.kill("SIGKILL");
    await site.close();
    await hub.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  const taylor = member("taylor");
  await hub.createChat("conv-notes", { title: "Notes", participants: [taylor], messages: [
    { id: "m-1", role: "participant", participantId: taylor.id, participantLabel: "@taylor", content: "Updated the plan.", status: "done", createdAt: at(31) },
    note("n-revised", 32, "@taylor revised [Память участников — план v1](#artifact:art-1) · v4 — Правило выбора: знания проекта — в репозиторий"),
    note("n-signed", 40, "User signed [Память участников — план v1](#artifact:art-1) v4 (fully approved)"),
    note("n-unknown", 41, "@taylor did something new to [Plan](#artifact:art-1)")
  ] });
  app = await attachApp({ port: 9517 });
  await pairPage(app, { hub, siteOrigin: site.origin, query: "qa=1" });
  await openChat(app, "conv-notes");

  const rows = () => app.evaluate(`(() => [...document.querySelectorAll('#message-list .message-row[data-author="system"]')].map((row) => ({
    card: Boolean(row.querySelector(".artifact-note-card")),
    bubble: Boolean(row.querySelector(".message-bubble")),
    avatar: Boolean(row.querySelector(".message-avatar")),
    title: row.querySelector(".artifact-note-title")?.textContent ?? null,
    meta: row.querySelector(".artifact-note-meta")?.textContent ?? null,
    actorIsMember: Boolean(row.querySelector(".artifact-note-actor.is-member")),
    body: row.querySelector(".artifact-note-body")?.textContent ?? null,
    icon: Boolean(row.querySelector(".artifact-note-icon svg")),
    text: row.textContent
  })))()`);
  // The time as the page writes it, in the browser's own locale.
  const pageClock = (iso) => app.evaluate(`new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(${JSON.stringify(iso)}))`);
  await app.waitFor(`document.querySelectorAll('#message-list .message-row[data-author="system"]').length === 3`, "the three notes are on screen");
  const [revised, signed, unknown] = await rows();

  assert.deepEqual(
    { card: revised.card, bubble: revised.bubble, avatar: revised.avatar, icon: revised.icon, actorIsMember: revised.actorIsMember },
    { card: true, bubble: false, avatar: false, icon: true, actorIsMember: true },
    "a member's revision is a card with no avatar or bubble"
  );
  assert.equal(revised.title, "Память участников — план v1");
  assert.equal(revised.meta, `@taylor revised · v4 · ${await pageClock(at(32))}`);
  assert.equal(revised.body, "Правило выбора: знания проекта — в репозиторий");
  assert.ok(!revised.text.includes("#artifact:"), "the link's markup is not printed");

  assert.equal(signed.card, true);
  assert.equal(signed.actorIsMember, false, "the User is not coloured as a member");
  assert.equal(signed.meta, `You signed · v4 · fully approved · ${await pageClock(at(40))}`);
  assert.equal(signed.body, null, "no note line when there is no note");

  assert.equal(unknown.card, false, "a note the card cannot read stays a bubble");
  assert.equal(unknown.bubble, true);

  // In line with a member's text, inside the screen.
  const box = await app.evaluate(`(() => {
    const card = document.querySelector('#message-list .artifact-note-card');
    const text = document.querySelector('#message-list .message-row[data-author="agent"] .message-copy');
    const c = card.getBoundingClientRect(); const m = text.getBoundingClientRect();
    return { left: Math.round(c.left), textLeft: Math.round(m.left), right: Math.round(c.right), width: window.innerWidth };
  })()`);
  assert.ok(Math.abs(box.left - box.textLeft) <= 1, `the card starts where a member's text does: ${JSON.stringify(box)}`);
  assert.ok(box.right <= box.width, `the card stays on screen: ${JSON.stringify(box)}`);

  // Redrawn rows keep their shape: a later message leaves the cards cards,
  // and a note the desktop rewrites into one it can read becomes a card.
  await hub.addMessages("conv-notes", [
    { id: "m-2", role: "participant", participantId: taylor.id, participantLabel: "@taylor", content: "One more thing.", status: "done", createdAt: at(42) }
  ]);
  await hub.updateMessages("conv-notes", [note("n-unknown", 41, "@taylor archived artifact [Plan](#artifact:art-1)")]);
  await app.waitFor(`document.getElementById("message-list").textContent.includes("One more thing.") &&
    document.querySelectorAll('#message-list .artifact-note-card').length === 3`, "the rewritten note is a card after the redraw");
  const redrawn = await rows();
  assert.equal(redrawn.length, 3, "still three note rows");
  assert.ok(redrawn.every((row) => row.card && !row.bubble), `every note row is a card and nothing else: ${JSON.stringify(redrawn)}`);
  assert.equal(redrawn[2].meta, `@taylor archived · ${await pageClock(at(41))}`);
});

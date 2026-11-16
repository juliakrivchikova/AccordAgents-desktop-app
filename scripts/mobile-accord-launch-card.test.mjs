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
  const site = await serveMobileShell({ port: 8377, hubOrigins: [hub.base] });
  const profile = await tempProfile("aa-mobile-accord-launch-");
  const chrome = launchChrome({ port: 9523, profile, url: `${site.origin}/`, width: 430, height: 860 });
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
  app = await attachApp({ port: 9523 });
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

  // Her own message: on her side, where her bubbles are, inside the screen.
  const box = await app.evaluate(`(() => {
    const card = document.querySelector('#message-list .accord-launch-card');
    const bubble = document.querySelector('#message-list .message-row[data-author="you"] .message-bubble');
    const c = card.getBoundingClientRect(); const b = bubble.getBoundingClientRect();
    return { right: Math.round(c.right), bubbleRight: Math.round(b.right), left: Math.round(c.left), width: window.innerWidth };
  })()`);
  assert.ok(Math.abs(box.right - box.bubbleRight) <= 1, `the card ends where her bubbles do: ${JSON.stringify(box)}`);
  assert.ok(box.left >= 0 && box.right <= box.width, `the card stays on screen: ${JSON.stringify(box)}`);

  // Redrawn rows keep their shape: a reply gives the launch its thread chip.
  await hub.addMessages("conv-accord", [
    { id: "m-2", role: "participant", participantId: taylor.id, participantLabel: "@taylor", content: "Asked @drew.", status: "done", createdAt: at(35), metadata: { threadId: "u-new", parentMessageId: "u-new", chatThreadRootId: "u-new" } }
  ]);
  await app.waitFor(`Boolean(document.querySelector('#message-list .message-row[data-thread-root="u-new"] .thread-chip'))`, "the launch gets its replies' chip");
  const redrawn = await rows();
  assert.ok(redrawn[0].card && !redrawn[0].bubble, `the launch is still a card: ${JSON.stringify(redrawn[0])}`);

  // The Accord's document notes, filed under the launch, become the card's
  // stages and leave the timeline; a note filed under nothing keeps its card
  // (the User, 2026-11-08). New notes move the stages on in place.
  const ref = "[Launch shape](#artifact:art-1)";
  // Filed under the chat's newest Accord (u-old, started after u-new): the
  // one pinned above the composer.
  const filed = (id, minute, content, launchId = "u-old") => ({
    id, role: "system", content, status: "done", createdAt: at(minute),
    metadata: { appMessageSource: "app_artifact_note", artifactEventId: `e-${id}`, ...(launchId ? { accordLaunchMessageId: launchId } : {}) }
  });
  await hub.addMessages("conv-accord", [
    filed("n-1", 36, `@taylor created draft collection ${ref} · Drafts 0/3`),
    filed("n-2", 37, `@taylor submitted a draft to ${ref} · Submitted`),
    filed("n-other", 38, "@taylor created artifact [Notes](#artifact:art-9) · v1", null),
    // Filed under an Accord whose launch is not on this page: out of the chat too.
    filed("n-away", 38, "@taylor created draft collection [Elsewhere](#artifact:art-7) · Drafts 0/2", "u-not-loaded")
  ]);
  const progress = () => app.evaluate(`(() => {
    const card = document.querySelector('#accord-dock:not([hidden]) .accord-dock-card');
    return {
      status: card?.querySelector(".accord-progress-status")?.textContent ?? null,
      stages: [...(card?.querySelectorAll(".accord-progress-stage") ?? [])].map((stage) =>
        [stage.querySelector(".accord-progress-label").textContent, stage.className.replace("accord-progress-stage ", "")]),
      drafted: [...(card?.querySelectorAll(".accord-progress-stage:first-child .accord-progress-member") ?? [])].map((chip) =>
        [chip.querySelector(".accord-launch-handle").textContent, chip.classList.contains("is-given")]),
      note: card?.querySelector(".accord-progress-note-body")?.textContent ?? null,
      title: card?.querySelector(".accord-dock-title")?.textContent ?? null,
      inFeed: Boolean(document.querySelector('#message-list .accord-progress-stage')),
      aboveComposer: card ? Math.round(document.getElementById("composer-form").getBoundingClientRect().top - card.getBoundingClientRect().bottom) : null,
      open: [...(card?.querySelectorAll("button") ?? [])].some((button) => button.textContent.trim() === "Open"),
      notes: [...document.querySelectorAll('#message-list .artifact-note-card:not(.accord-launch-card)')].map((node) => node.textContent)
    };
  })()`);
  await app.waitFor(`document.querySelector('#accord-dock .accord-progress-status')?.textContent === "Drafts 1/2"`, "the card shows the drafts");
  const drafting = await progress();
  assert.deepEqual(drafting.stages, [["Drafts", "is-active"], ["Publish", "is-todo"], ["Signatures", "is-todo"], ["Accord reached", "is-todo"]]);
  assert.deepEqual(drafting.drafted, [["@taylor", true], ["@drew", false]]);
  assert.equal(drafting.notes.length, 1, `only the note of a document filed under no Accord is a card: ${JSON.stringify(drafting.notes)}`);
  assert.equal(drafting.title, "Launch shape", "the pinned card is titled with the document");
  assert.equal(drafting.inFeed, false, "the launch in the timeline stays its own compact card");
  assert.ok(drafting.aboveComposer >= 0 && drafting.aboveComposer <= 12, `pinned right above the composer: ${drafting.aboveComposer}`);

  await hub.addMessages("conv-accord", [
    // Written by a device on an older version: no link, still this document's.
    filed("n-3", 39, `@drew submitted a draft to ${ref} · Submitted`, null),
    filed("n-4", 40, `@gera submitted a draft to ${ref} · Submitted`),
    filed("n-5", 41, `@taylor published ${ref} · v1 — One short round, then ship.`),
    filed("n-6", 42, `@taylor signed ${ref} v1 (1/3 signed)`)
  ]);
  await app.waitFor(`document.querySelector('#accord-dock .accord-progress-status')?.textContent === "v1 · 1/3 signed"`, "the card moves on in place");
  const signing = await progress();
  assert.deepEqual(signing.stages, [["Drafts", "is-done"], ["v1 published", "is-done"], ["Signatures", "is-active"], ["Accord reached", "is-todo"]]);
  assert.equal(signing.note, "One short round, then ship.");
  assert.equal(signing.open, false, "the phone has no document viewer, so no Open");
  assert.equal(signing.notes.length, 1, "the unlinked note of the Accord's document folds too");

  // The head folds it into one line on this phone.
  await app.evaluate(`document.querySelector("#accord-dock .accord-dock-toggle").click()`);
  await app.waitFor(`document.querySelector("#accord-dock .accord-dock-card.is-folded") && !document.querySelector("#accord-dock .accord-progress-stage")`, "the card folds");
  assert.equal(await app.evaluate(`document.querySelector("#accord-dock .accord-progress-status").textContent`), "v1 · 1/3 signed");
  // × folds it into a line at the end of the chat as it is now, on the
  // server, so on every device (the User, 2026-11-16).
  const lastBefore = await app.evaluate(`[...document.querySelectorAll("#message-list .message-row")].at(-1)?.dataset.rowKey ?? null`);
  await app.evaluate(`document.querySelector("#accord-dock .accord-dock-close").click()`);
  await app.waitFor(`document.getElementById("accord-dock").hidden`, "× takes the card from above the composer");
  await app.waitFor(`Boolean(document.querySelector('#message-list .message-row[data-accord-line="1"] .card-row'))`, "its line is in the chat");
  const line = () => app.evaluate(`(() => {
    const rows = [...document.querySelectorAll("#message-list .message-row")];
    const row = rows.find((item) => item.dataset.accordLine === "1");
    return row ? {
      last: rows.at(-1) === row,
      afterLast: rows[rows.indexOf(row) - 1]?.dataset.rowKey ?? null,
      title: row.querySelector(".card-row-preview")?.textContent ?? null,
      outcome: row.querySelector(".card-row-outcome")?.textContent ?? null,
      button: row.querySelector(".card-row")?.tagName ?? null,
      stages: row.querySelectorAll(".accord-progress-stage").length,
      lines: rows.filter((item) => item.dataset.accordLine === "1").length
    } : null;
  })()`);
  const folded = await line();
  assert.deepEqual(folded, { last: true, afterLast: lastBefore, title: "Launch shape", outcome: "v1 · 1/3 signed", button: "BUTTON", stages: 0, lines: 1 });
  const written = await (async () => {
    for (let i = 0; i < 40; i += 1) {
      const ops = await hub.phoneOps("message.create");
      const found = ops.find((entry) => entry.effect.message?.metadata?.appMessageSource === "app_accord_closed");
      if (found) return found.effect.message;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return null;
  })();
  assert.ok(written, "the server holds the line the phone wrote");
  assert.equal(written.role, "system");
  assert.deepEqual(written.metadata.accordClosed, { launchMessageId: "u-old", title: "Launch shape" });
  assert.equal(written.content, "Accord folded: Launch shape");
  // A tap opens the Accord's card in the chat; its cross folds it back. Opened
  // while this phone's own copy is shown, it stays open when the server's
  // copy takes its place.
  await app.evaluate(`document.querySelector('#message-list .message-row[data-accord-line="1"] .card-row').click()`);
  await app.waitFor(`!(document.querySelector('#message-list .message-row[data-accord-line="1"]')?.dataset.rowKey || "outbox").startsWith("outbox")`, "the server's copy of the line is shown");
  await app.waitFor(`document.querySelectorAll('#message-list .message-row[data-accord-line="1"] .accord-progress-stage').length === 4`, "the line opens its card");
  assert.equal(await app.evaluate(`document.querySelector('#message-list .message-row[data-accord-line="1"] .accord-dock-close').getAttribute("aria-label")`), "Fold");
  await app.evaluate(`document.querySelector('#message-list .message-row[data-accord-line="1"] .accord-dock-close').click()`);
  await app.waitFor(`Boolean(document.querySelector('#message-list .message-row[data-accord-line="1"] .card-row'))`, "its cross folds it back");
  // A step taken after she closed it shows on the line.
  await hub.addMessages("conv-accord", [filed("n-7", 43, `@drew signed ${ref} v1 (2/3 signed)`)]);
  await app.waitFor(`document.querySelector('#message-list .message-row[data-accord-line="1"] .card-row-outcome')?.textContent === "v1 · 2/3 signed"`, "the line moves on");
  assert.equal(await app.evaluate(`document.getElementById("accord-dock").hidden`), true, "the card does not come back above the composer");
  await openChat(app, "conv-accord");
  await app.waitFor(`document.querySelectorAll('#message-list .message-row[data-author="you"]').length >= 3`, "the chat is open again");
  assert.equal(await app.evaluate(`document.getElementById("accord-dock").hidden`), true, "closed stays a line");
  assert.equal((await line())?.lines, 1, "one line");

  assert.equal((await progress()).notes.length, 1, "closed, the Accord's notes stay out of the chat");

  // Closed on her computer: the phone's card goes too, and the line is in
  // the chat where the computer wrote it.
  const ref2 = "[Second round](#artifact:art-2)";
  await hub.createChat("conv-accord-2", { title: "Accord 2", participants: [taylor, drew], messages: [
    userMessage("u-2", 50, launch("Second round", "drew"))
  ] });
  await hub.addMessages("conv-accord-2", [
    filed("n2-1", 51, `@taylor created draft collection ${ref2} · Drafts 0/2`, "u-2"),
    filed("n2-2", 52, `@taylor published ${ref2} · v1 — Short.`, "u-2")
  ]);
  await openChat(app, "conv-accord-2");
  await app.waitFor(`!document.getElementById("accord-dock").hidden && document.querySelector("#accord-dock .accord-dock-title")?.textContent === "Second round"`, "the second Accord is pinned");
  await hub.writeMessage("conv-accord-2", { id: "line-desk", role: "system", content: "Accord folded: Second round", status: "done", createdAt: new Date().toISOString(),
    metadata: { appMessageSource: "app_accord_closed", accordClosed: { launchMessageId: "u-2", title: "Second round" } } });
  await app.waitFor(`document.getElementById("accord-dock").hidden`, "closed on the computer: gone from the phone's composer too");
  await app.waitFor(`document.querySelector('#message-list .message-row[data-accord-line="1"] .card-row-preview')?.textContent === "Second round"`, "and its line is in the chat");
  assert.equal(await app.evaluate(`[...document.querySelectorAll("#message-list .message-row")].at(-1)?.dataset.accordLine ?? null`), "1", "last, where the computer wrote it");
  // Her server's list records it over the whole chat, so the card stays a
  // line here however much of the chat this phone has read.
  await app.waitFor(`(JSON.parse(localStorage.getItem("accordagents.mobile.chatList.v1") || "[]").find((chat) => chat.id === "conv-accord-2")?.accordClosed || []).includes("u-2")`,
    "the phone keeps the server's record of the folded Accord");
});

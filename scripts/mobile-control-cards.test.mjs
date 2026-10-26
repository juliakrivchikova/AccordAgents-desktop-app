/**
 * The phone answering a card, driven through the real PWA in a browser.
 *
 * A permission a member is waiting on is published exactly the way the desktop
 * publishes it — a card event on the User's own server, a real hub here — the
 * card is tapped in the page, and what the phone then holds and sends is
 * checked: the answer and its queue entry, the native identifiers carried
 * back, the card saying "sent" rather than "answered", the answer arriving in
 * the server's order, and all of it surviving a reload.
 *
 * This is a browser check, not the installed phone: it runs the same files the
 * phone runs, under the same origin headers, but a physically installed PWA is
 * not claimed by it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { attachApp, launchChrome, member, openChat, pairPage, serveMobileShell, sleep, startMobileHub, tempProfile } from "./mobile-hub-fixture.mjs";

const require = createRequire(import.meta.url);
const SITE_PORT = 8165;
const CDP_PORT = 9355;
const CONVERSATION = "conv-cards-qa";
const DREW = member("drew");

// The approval the desktop holds for its member, as it publishes it.
const approval = {
  id: "card-qa-1",
  conversationId: CONVERSATION,
  requesterParticipantId: DREW.id,
  requesterHandle: "drew",
  requesterRoleConfigId: DREW.roleConfigId,
  toolName: "app_artifact_read",
  capability: "artifacts.read",
  status: "pending",
  request: { capability: "read", path: "src/index.ts" },
  summary: "@drew wants to read a file: Read src/index.ts from the project.",
  machineName: "cloud-box",
  codexDecisionId: "native-decision-77",
  createdAt: new Date(Date.UTC(2026, 8, 7, 9, 0)).toISOString(),
  updatedAt: new Date(Date.UTC(2026, 8, 7, 9, 0)).toISOString()
};

// A member's message exactly as it arrives when it asks the User to choose:
// the prose, then the `User choice:` block the desktop turns into the card
// below it. The desktop hides that block from the bubble
// (src/renderer/components/chat/chat-display-content.ts); the phone shows the
// same message and must hide it too, or the User reads the question twice —
// once as protocol text, once as the card.
const message = {
  id: "m1", role: "participant", participantId: DREW.id, participantLabel: "@drew",
  content: [
    "Working on it.",
    "",
    "User choice:",
    "T: Where to fix",
    "Q: Which fix should I build?",
    "O1: In the relay | needs a deploy",
    "O2: On the phone | no deploy",
    "R: O1",
    "",
    // Prose after the block: a rule that simply cuts everything from the block
    // to the end of the message would eat this, and the User would never know
    // what the member wrote.
    "I will start as soon as you pick.",
    "",
    "```",
    "User choice:",
    "Q: this one is inside a fence and is not a control block",
    "```",
    "",
    "User choice:",
    "T: Second block",
    "Q: And this one is real too?",
    "O1: Yes",
    "O2: No"
  ].join("\n"),
  status: "done", createdAt: new Date(Date.UTC(2026, 8, 7, 8, 59)).toISOString()
};

test("a card published by the desktop is answered on the phone and survives a reload", { timeout: 180_000 }, async (t) => {
  const { createChatEventDeviceIdentity } = require("../dist/main/main/services/chatEventLog.js");
  const machine = createChatEventDeviceIdentity(new Date().toISOString());
  // A cloud machine the server can start: its Wake belongs in Settings.
  const hub = await startMobileHub({ rosterDevices: [
    { deviceId: machine.originId, publicKeyDerBase64: machine.publicKeyDerBase64, role: "machine", name: "cloud-box", machineId: "m1" }
  ] });
  await hub.call("PUT", "/v1/machine-wake", { machines: [{
    machineId: "m1", instanceId: "i-0943b28f7231ab93c", region: "us-east-1",
    credentials: { accessKeyId: "AKIAEXAMPLEWAKEKEY001", secretAccessKey: "syntheticSecretKeyForQaOnly00000", region: "us-east-1" }
  }] });
  const site = await serveMobileShell({ port: SITE_PORT, hubOrigins: [hub.base] });
  const profile = await tempProfile("aa-mobile-cards-");
  const chrome = launchChrome({ port: CDP_PORT, profile, url: `${site.origin}/`, width: 430, height: 860 });
  let app;
  try {
    await hub.createChat(CONVERSATION, { title: "Cards QA", participants: [DREW], messages: [message] });
    await hub.raiseApproval(CONVERSATION, approval);
    app = await attachApp({ port: CDP_PORT });
    await pairPage(app, { hub, siteOrigin: site.origin });
    await openChat(app, CONVERSATION);
    const evaluate = app.evaluate;

    const cardText = async () => evaluate(`(() => {
      const card = document.querySelector('[data-card-id="card-qa-1"]');
      return card ? card.innerText : null;
    })()`);
    let text = null;
    for (let i = 0; i < 60 && !text; i += 1) {
      text = await cardText();
      if (!text) await sleep(500);
    }
    assert.ok(text, "the card never appeared on the phone");
    assert.match(text, /wants to read a file/);
    assert.match(text, /Read src\/index\.ts/);
    assert.match(text, /cloud-box/);
    t.diagnostic(`card rendered: ${text.replace(/\n/g, " | ")}`);

    // The question is asked once: the card. The protocol block that produced
    // it is not chat text and never reaches the bubble.
    await app.waitFor(`Boolean(document.querySelector("#message-list .message-content"))`, "the member's message reached the phone");
    const bubble = await evaluate(`(() => {
      const node = document.querySelector("#message-list .message-content");
      return node ? node.innerText : null;
    })()`);
    assert.ok(bubble, "the member's message is on the phone's timeline");
    assert.match(bubble, /Working on it\./, "what the member wrote is still shown");
    assert.match(bubble, /I will start as soon as you pick\./, "prose after the block survives");
    assert.match(bubble, /inside a fence/, "a block inside a code fence is quoted text, not protocol");
    assert.doesNotMatch(bubble, /^\s*T: Where to fix/m, "the first raw choice block is gone");
    assert.doesNotMatch(bubble, /^\s*T: Second block/m, "the second one is gone too");
    assert.doesNotMatch(bubble, /^\s*O1: In the relay/m, "no protocol option lines in the bubble");
    assert.doesNotMatch(bubble, /^\s*Q: Which fix should I build\?/m, "no protocol question line in the bubble");

    // The User's own words are never control text, whatever they start with.
    await hub.addMessages(CONVERSATION, [{
      id: "m2", role: "user",
      content: "User choice: I would rather do it the other way.",
      status: "done", createdAt: new Date(Date.UTC(2026, 8, 7, 9, 5)).toISOString()
    }]);
    const ownWords = await (async () => {
      for (let i = 0; i < 40; i += 1) {
        const text = await evaluate(`(() => {
          const rows = [...document.querySelectorAll('#message-list .message-row')];
          const mine = rows.filter((row) => row.dataset.author !== "agent").map((row) => row.innerText).join(String.fromCharCode(10));
          return mine.trim() ? mine : null;
        })()`);
        if (text && /other way/.test(text)) return text;
        await sleep(500);
      }
      return null;
    })();
    assert.ok(ownWords, "the User's own message is shown as she wrote it");
    assert.match(ownWords, /User choice: I would rather do it the other way\./,
      "her words are not treated as a protocol block");

    // The question the User answered keeps its place under the message, the
    // way the desktop keeps it: the record of what was asked and chosen.
    await hub.updateMessages(CONVERSATION, [{ ...message, metadata: { pendingChoice: {
      id: "choice-answered", title: "Where to fix", question: "Which fix should I build?",
      options: [{ id: "relay", label: "In the relay" }, { id: "phone", label: "On the phone" }],
      status: "selected", selectedOptionId: "relay", selectedAt: new Date(Date.UTC(2026, 8, 7, 9, 1)).toISOString()
    } } }]);
    const answered = await (async () => {
      for (let i = 0; i < 40; i += 1) {
        const text = await evaluate(`(() => {
          const node = document.querySelector("#message-list .control-card-answered");
          return node ? node.innerText : null;
        })()`);
        if (text) return text;
        await sleep(500);
      }
      return null;
    })();
    assert.ok(answered, "the answered question is kept under its message");
    assert.match(answered, /Which fix should I build\?/, "the question is still readable");
    assert.match(answered, /In the relay/, "what was chosen is shown");
    assert.equal(await evaluate(`document.querySelectorAll('#message-list .control-card:not(.control-card-answered)[data-card-id="choice-answered"]').length`), 0,
      "an answered question is not offered for answering again");

    // Waking the machine lives in Settings, never over a chat (the User,
    // 2026-10-20: "это вообще не место для плашки").
    assert.equal(await evaluate(`(() => {
      const screen = document.getElementById("timeline-screen");
      return /Wake machine|Machine asleep|Asleep\\?/.test(screen.innerText) ||
        [...screen.querySelectorAll("button")].some((button) => /wake/i.test(button.innerText));
    })()`), false, "a chat must not carry the wake control");

    // Tap Allow, in the page.
    await evaluate(`(() => {
      document.querySelector('[data-card-id="card-qa-1"] [data-option-id="allow"]').click();
      return true;
    })()`);
    await sleep(2000);

    const stored = await evaluate(`(async () => {
      const outbox = await AccordAgentsMobile.listOutboxEntries();
      const decision = outbox.find((entry) => entry.kind === "permission.decided");
      return {
        decision: decision || null,
        cardState: document.querySelector('[data-card-id="card-qa-1"] .control-card-state')?.innerText || "",
        onItsWay: document.querySelector('[data-card-id="card-qa-1"]')?.classList.contains("is-on-its-way") === true,
        allowOffered: (() => { const allow = document.querySelector('[data-card-id="card-qa-1"] [data-option-id="allow"]'); return Boolean(allow && !allow.disabled); })()
      };
    })()`);
    assert.ok(stored.decision, "the answer was not written to the phone's queue");
    assert.equal(stored.decision.payload.targetKey, "approval:card-qa-1");
    assert.equal(stored.decision.payload.stateId, "approved");
    assert.equal(stored.decision.payload.detail.approve, true);
    assert.equal(stored.decision.payload.detail.codexDecisionId, "native-decision-77",
      "the native decision id must travel back with the answer");
    assert.deepEqual(stored.decision.payload.detail.draftOverride, { capability: "read", path: "src/index.ts" });
    // The event is made once, signed, and kept with its queue entry, so a
    // resend is the same bytes.
    assert.ok(stored.decision.minted && stored.decision.minted.eventId === stored.decision.eventId, "the signed event is kept with its queue entry");
    // A tap is not the answer being applied: the card folds to what was
    // answered and fades, and says nothing more (the User, 2026-09-24).
    assert.equal(stored.onItsWay, true, "the card fades while its answer is on its way");
    assert.equal(stored.cardState, "Your answer: Allow", "the card is folded to her answer, nothing about delivery");
    assert.equal(stored.allowOffered, false, "an answered card does not offer the action again");

    // The server took it: the signed answer is in its order, for the desktop
    // that holds the approval to apply.
    await hub.settle();
    const placed = hub.phoneEvents("permission.decided");
    assert.equal(placed.length, 1, "the answer never reached the server");
    assert.equal(placed[0].payload.targetKey, "approval:card-qa-1");
    assert.equal(placed[0].payload.detail.codexDecisionId, "native-decision-77");
    assert.equal(placed[0].payload.detail.decidedOn, "phone");

    // A reload must not lose it.
    await app.send("Page.reload", {});
    await sleep(2500);
    let reloaded = null;
    for (let i = 0; i < 40 && !reloaded; i += 1) {
      reloaded = await cardText().catch(() => null);
      if (!reloaded) await sleep(500);
    }
    assert.ok(reloaded, "the open card did not survive a reload");

    // Once the desktop states it is no longer pending, the card leaves.
    await hub.raiseApproval(CONVERSATION, { ...approval, status: "approved", updatedAt: new Date().toISOString() });
    let gone = false;
    for (let i = 0; i < 60 && !gone; i += 1) {
      gone = await evaluate(`document.querySelector('[data-card-id="card-qa-1"]') === null`) === true;
      if (!gone) await sleep(500);
    }
    assert.equal(gone, true, "an answered card must stop offering an action");

    // And the machine's Wake is where it belongs: in Settings.
    await evaluate(`document.getElementById("back-to-chats").click()`);
    await evaluate(`document.querySelector('[data-home-tab="settings"]').click()`);
    await app.waitFor(`/cloud-box/.test(document.getElementById("settings-list").innerText) && [...document.querySelectorAll("#settings-list button")].some((button) => /Wake/.test(button.innerText))`,
      "Settings offers to wake the machine");
  } finally {
    app?.close();
    chrome.kill("SIGKILL");
    await site.close();
    await hub.close();
    // Chrome is still letting go of its profile for a moment after the kill.
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

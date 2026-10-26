/**
 * A member removal card on the phone, driven through the real PWA in a browser
 * against a real hub: it asks in the desktop card's words, the answer goes in
 * the server's order, and once approved it stays visible (without buttons)
 * while it waits for running turns and for the Mac to apply it, then leaves.
 *
 * A browser check, not the installed phone: it runs the files the phone runs.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { attachApp, launchChrome, member, openChat, pairPage, serveMobileShell, sleep, startMobileHub, tempProfile } from "./mobile-hub-fixture.mjs";

const SITE_PORT = 8199;
const CDP_PORT = 9486;
const CONVERSATION = "conv-removal-qa";
const DREW = member("drew");
const GERA = member("gera");

const at = new Date(Date.UTC(2026, 9, 26, 9, 0)).toISOString();
const removal = {
  id: "removal-qa-1",
  conversationId: CONVERSATION,
  requesterParticipantId: DREW.id,
  requesterHandle: "drew",
  requesterRoleConfigId: DREW.roleConfigId,
  toolName: "app_participants_request_change",
  capability: "participants.manage",
  status: "pending",
  request: { kind: "participant_removal", operations: [{ type: "remove_participant_from_chat", participantId: GERA.id, handle: "gera" }] },
  summary: "Remove @gera from this chat",
  createdAt: at,
  updatedAt: at
};

test("a removal card asks in the desktop's words, and waits visibly once approved until it is applied", { timeout: 180_000 }, async () => {
  const hub = await startMobileHub();
  const site = await serveMobileShell({ port: SITE_PORT, hubOrigins: [hub.base] });
  const profile = await tempProfile("aa-mobile-removal-");
  const chrome = launchChrome({ port: CDP_PORT, profile, url: `${site.origin}/`, width: 430, height: 860 });
  let app;
  try {
    await hub.createChat(CONVERSATION, { title: "Removal QA", participants: [DREW, GERA], messages: [] });
    await hub.raiseApproval(CONVERSATION, removal);
    app = await attachApp({ port: CDP_PORT });
    await pairPage(app, { hub, siteOrigin: site.origin });
    await openChat(app, CONVERSATION);
    const card = () => app.evaluate(`(() => {
      const node = document.querySelector('[data-card-id="removal-qa-1"]');
      return node ? { text: node.innerText, waiting: node.classList.contains("control-card-waiting"),
        options: [...node.querySelectorAll("[data-option-id]")].map((button) => [button.dataset.optionId, button.innerText]) } : null;
    })()`);

    let shown = null;
    for (let i = 0; i < 60 && !shown; i += 1) {
      shown = await card();
      if (!shown) await sleep(500);
    }
    assert.ok(shown, "the removal card never appeared on the phone");
    assert.match(shown.text, /@drew wants to remove @gera from this chat/);
    assert.match(shown.text, /once @drew's turn has ended and no member is running/);
    assert.deepEqual(shown.options, [["allow", "Yes, remove @gera"], ["deny", "No, keep @gera in this chat"]]);

    await app.evaluate(`(() => { document.querySelector('[data-card-id="removal-qa-1"] [data-option-id="allow"]').click(); return true; })()`);
    for (let i = 0; i < 60 && hub.phoneEvents("permission.decided").length === 0; i += 1) {
      await sleep(250);
      await hub.settle();
    }
    const placed = hub.phoneEvents("permission.decided");
    assert.equal(placed.length, 1, "the answer reached the server");
    assert.equal(placed[0].payload.detail.approve, true);
    assert.deepEqual(placed[0].payload.detail.draftOverride, removal.request);

    // Approved, waiting for running turns and the Mac.
    await hub.raiseApproval(CONVERSATION, { ...removal, status: "approved", approvalScope: "once", memberRemovalQueuedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    let waiting = null;
    for (let i = 0; i < 60 && !(waiting && waiting.waiting); i += 1) {
      waiting = await card();
      if (!(waiting && waiting.waiting)) await sleep(500);
    }
    assert.ok(waiting?.waiting, "the approved removal stays visible while it waits");
    assert.match(waiting.text, /Removal approved/);
    assert.match(waiting.text, /Waiting for running turns to finish and for your Mac to apply it, then @gera leaves this chat\./);
    assert.deepEqual(waiting.options, [], "nothing left to answer");
    const pendingCount = await app.evaluate(`document.querySelectorAll('#control-cards .control-card:not(.control-card-waiting)').length`);
    assert.equal(pendingCount, 0, "it is not offered as a question");

    // Applied: it leaves.
    const { memberRemovalQueuedAt: _queued, ...applied } = { ...removal, status: "approved", memberRemovalQueuedAt: "" };
    await hub.raiseApproval(CONVERSATION, { ...applied, appliedParticipantIds: [GERA.id], updatedAt: new Date(Date.now() + 1000).toISOString() });
    let gone = false;
    for (let i = 0; i < 60 && !gone; i += 1) {
      gone = await app.evaluate(`document.querySelector('[data-card-id="removal-qa-1"]') === null`) === true;
      if (!gone) await sleep(500);
    }
    assert.equal(gone, true, "an applied removal no longer shows");
  } finally {
    app?.close();
    chrome.kill("SIGKILL");
    await site.close();
    await hub.close();
  }
});

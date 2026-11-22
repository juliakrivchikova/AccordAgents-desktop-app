/**
 * Claude Code's plan approval on the phone, driven through the real PWA in a
 * browser against a real hub: the card the member's device raises for
 * ExitPlanMode is the CLI's "Ready to code?" dialog (its words, the plan,
 * its rows); a Yes answers with the row the CLI names, "No, keep planning"
 * with the words typed in its field; Activity opens the card instead of
 * answering in the row, so the plan is read before it is approved.
 *
 * A browser check, not the installed phone: it runs the files the phone runs,
 * under the same origin headers.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { rm } from "node:fs/promises";
import { attachApp, launchChrome, member, openChat, pairPage, serveMobileShell, sleep, startMobileHub, tempProfile } from "./mobile-hub-fixture.mjs";

const SITE_PORT = 8169;
const CDP_PORT = 9359;
const CONVERSATION = "conv-plan-card-qa";
const DREW = member("drew");

function planApproval(id, minute) {
  const at = new Date(Date.UTC(2026, 10, 22, 9, minute)).toISOString();
  return {
    id,
    conversationId: CONVERSATION,
    requesterParticipantId: DREW.id,
    requesterHandle: "drew",
    requesterRoleConfigId: DREW.roleConfigId,
    toolName: "app_tool_permission",
    capability: "permissions.request",
    status: "pending",
    summary: "Ready to code?",
    request: {
      kind: "toolPermission",
      agentMode: "plan",
      toolName: "ExitPlanMode",
      planApproval: { plan: "# Add hello.txt\n\n1. Write **hello.txt** with `hi`.\n2. Run the tests." }
    },
    createdAt: at,
    updatedAt: at
  };
}

test("Claude Code's plan approval on the phone is the CLI's own card, and answers with its rows", { timeout: 180_000 }, async () => {
  const hub = await startMobileHub();
  const site = await serveMobileShell({ port: SITE_PORT, hubOrigins: [hub.base] });
  const profile = await tempProfile("aa-mobile-plan-");
  const chrome = launchChrome({ port: CDP_PORT, profile, url: `${site.origin}/`, width: 430, height: 860 });
  let app;
  try {
    await hub.createChat(CONVERSATION, { title: "Plan QA", participants: [DREW], messages: [] });
    await hub.raiseApproval(CONVERSATION, planApproval("plan-yes", 0), { participantId: DREW.id });
    await hub.raiseApproval(CONVERSATION, planApproval("plan-no", 1), { participantId: DREW.id });
    app = await attachApp({ port: CDP_PORT });
    await pairPage(app, { hub, siteOrigin: site.origin });
    await openChat(app, CONVERSATION);
    const evaluate = app.evaluate;
    const cardText = (id) => evaluate(`(() => { const card = document.querySelector('[data-card-id="${id}"]'); return card ? card.innerText : null; })()`);

    let text = null;
    for (let i = 0; i < 60 && !text; i += 1) {
      text = await cardText("plan-yes");
      if (!text) await sleep(500);
    }
    assert.ok(text, "the plan card never appeared on the phone");
    for (const words of ["Ready to code?", "Here is Claude's plan:", "Claude has written up a plan and is ready to execute. Would you like to proceed?",
      "Yes, auto-accept edits", "Yes, manually approve edits", "No, keep planning"]) {
      assert.ok(text.includes(words), `the card says "${words}"`);
    }
    assert.match(text, /Add hello\.txt/, "the plan is shown");
    // Rendered by the phone's markdown, as its messages are: lists and bold.
    assert.equal(await evaluate(`document.querySelectorAll('[data-card-id="plan-yes"] .control-card-plan li').length`), 2, "its steps are a list");
    assert.equal(await evaluate(`Boolean(document.querySelector('[data-card-id="plan-yes"] .control-card-plan strong'))`), true, "its bold text is bold");
    assert.equal(await evaluate(`document.querySelector('[data-card-id="plan-yes"] textarea').placeholder`), "Tell Claude what to change");
    assert.doesNotMatch(text, /\bAllow\b|\bDeny\b/, "not a permission's Allow and Deny");

    // A Yes answers at once, with the row the CLI names.
    await evaluate(`document.querySelector('[data-card-id="plan-yes"] [data-option-id="yes-accept-edits-keep-context"]').click()`);
    await app.waitFor(`AccordAgentsMobile.listOutboxEntries().then((rows) => rows.some((row) => row.kind === "card.answer" && row.payload.cardId === "plan-yes" && row.status === "acked"))`,
      "the server took the Yes", 20_000);
    await hub.settle();
    assert.deepEqual((await hub.card("plan-yes")).answer, { approve: true, planDecision: { optionId: "yes-accept-edits-keep-context" } });
    await app.waitFor(`/Yes, auto-accept edits\. Waiting for it to be applied\./.test(document.querySelector('[data-card-id="plan-yes"]')?.innerText || "")`,
      "the card says the row she picked", 20_000);

    // No, keep planning: her words go with it.
    await evaluate(`(() => {
      const field = document.querySelector('[data-card-id="plan-no"] textarea');
      field.value = "Split it into two steps.";
      field.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector('[data-card-id="plan-no"] [data-option-id="no"]').click();
      return true;
    })()`);
    await app.waitFor(`AccordAgentsMobile.listOutboxEntries().then((rows) => rows.some((row) => row.kind === "card.answer" && row.payload.cardId === "plan-no" && row.status === "acked"))`,
      "the server took the No", 20_000);
    await hub.settle();
    assert.deepEqual((await hub.card("plan-no")).answer, { approve: false, planDecision: { optionId: "no", feedback: "Split it into two steps." } });

    // Activity: a plan is read before it is approved, so its row opens the card.
    await hub.raiseApproval(CONVERSATION, planApproval("plan-activity", 2), { participantId: DREW.id });
    await evaluate(`document.getElementById("back-to-chats").click()`);
    await app.waitFor(`Boolean(document.querySelector('[data-home-tab="activity"]'))`, "the Activity tab", 20_000);
    await evaluate(`document.querySelector('[data-home-tab="activity"]').click()`);
    await app.waitFor(`Boolean(document.querySelector('[data-activity-tab="pending"]'))`, "the Pending tab", 20_000);
    await evaluate(`document.querySelector('[data-activity-tab="pending"]').click()`);
    await app.waitFor(`Boolean(document.querySelector('.act-row[data-card-id="plan-activity"]'))`, "the plan's Activity row", 20_000);
    assert.equal(await evaluate(`document.querySelectorAll('.act-row[data-card-id="plan-activity"] .act-pill').length`), 0, "no answer pills in the row");
    await evaluate(`document.querySelector('.act-row[data-card-id="plan-activity"]').click()`);
    await app.waitFor(`/Here is Claude's plan:/.test(document.querySelector('[data-card-id="plan-activity"].control-card')?.innerText || "")`,
      "the row opens the whole card", 20_000);
  } finally {
    app?.close();
    chrome.kill("SIGKILL");
    await site.close();
    await hub.close();
    // Chrome is still letting go of its profile for a moment after the kill.
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

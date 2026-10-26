// The eternal "Thinking" row, second half. A placeholder row ("Running..." /
// "@x is running...") is deleted by the terminal that carries its run keys —
// but a run can die without one (an interrupted app, or an answer written
// before terminals inherited the source's mobile event id), and then the row
// sat on screen forever with its clock ticking. When a terminal arrives, the
// phone now sweeps placeholder rows old enough that no live run could still
// own them (the CLI itself is killed at 15 minutes), while fresh placeholders
// and real pending text are untouched — the reverted age guard's mistake.
//
// The real PWA in Chrome, paired with a real hub (the User's own server).
// The three pending rows are what this phone holds and the server no longer
// does — a run that died without a word — so they are delivered the way the
// server's live progress delivers rows, through the app's own ingest path;
// the terminal that sweeps them is a real answer in the server's copy of the
// chat, read from it like any other.
import assert from "node:assert/strict";
import test from "node:test";
import { rm } from "node:fs/promises";
import { attachApp, launchChrome, member, openChat, pairPage, serveMobileShell, sleep, startMobileHub, tempProfile } from "./mobile-hub-fixture.mjs";

const SITE_PORT = 8171;
const CDP_PORT = 9345;
const CONVERSATION = "conv-corpse-qa";

// All times relative to the terminal at 01:40: the corpse is 40 minutes old,
// the fresh placeholder 2 minutes, the real pending text 3 minutes.
const corpsePlaceholder = {
  id: "corpse-row",
  messageId: "corpse-row",
  role: "participant",
  content: "Running...",
  status: "pending",
  createdAt: new Date(Date.UTC(2026, 0, 1, 1, 0)).toISOString(),
  runId: "mobile-old-evt",
  mobileEventId: "old-evt"
};
const freshPlaceholder = {
  id: "fresh-row",
  messageId: "fresh-row",
  role: "participant",
  participantLabel: "@drew",
  content: "@drew is running...",
  status: "pending",
  createdAt: new Date(Date.UTC(2026, 0, 1, 1, 38)).toISOString(),
  runId: "mobile-new-evt",
  mobileEventId: "new-evt"
};
const realPendingText = {
  id: "text-row",
  messageId: "text-row",
  role: "participant",
  participantLabel: "@drew",
  content: "Half of an answer that is still being writ",
  status: "pending",
  createdAt: new Date(Date.UTC(2026, 0, 1, 1, 37)).toISOString(),
  runId: "mobile-live-evt",
  mobileEventId: "live-evt"
};
// A finished answer from a different run, as the server's copy holds it.
const unrelatedTerminal = {
  id: "answer-row",
  role: "participant",
  participantId: "p-codex",
  participantLabel: "@codex",
  content: "A finished answer from a different run.",
  status: "done",
  createdAt: new Date(Date.UTC(2026, 0, 1, 1, 40)).toISOString(),
  metadata: { runId: "11111111-2222-3333-4444-555555555555" }
};

test("a terminal sweeps placeholder corpses but spares fresh placeholders and real pending text", { timeout: 180_000 }, async (t) => {
  const hub = await startMobileHub();
  const site = await serveMobileShell({ port: SITE_PORT, hubOrigins: [hub.base] });
  const profile = await tempProfile("aa-mobile-corpse-");
  const chrome = launchChrome({ port: CDP_PORT, profile, url: `${site.origin}/`, width: 430, height: 860 });
  let app;
  try {
    await hub.createChat(CONVERSATION, { title: "Corpse QA", participants: [member("drew"), member("codex", { kind: "codex-cli" })] });
    app = await attachApp({ port: CDP_PORT });
    await pairPage(app, { hub, siteOrigin: site.origin });
    await openChat(app, CONVERSATION);
    const evaluate = app.evaluate;
    await evaluate(`AccordAgentsMobile.handleRelayTimelinePayload(${JSON.stringify({ type: "mobile.timeline.events", conversationId: CONVERSATION, events: [corpsePlaceholder, freshPlaceholder, realPendingText] })}, undefined, { live: true })`);
    const runningRows = async () => await evaluate(
      `(() => document.querySelectorAll('#message-list .message-row[data-status="Running"]').length)()`
    );
    // The corpse has no participant label, so it names nobody at all; the two
    // live rows say "@drew". The labels tell the three rows apart without
    // depending on internal row keys. It used to render under an "Agent"
    // fallback with a letter avatar, which invented a member who does not
    // exist and then swapped identity when the real one started.
    const runningLabels = async () => await evaluate(
      `(() => [...document.querySelectorAll('#message-list .message-row[data-status="Running"] .message-handle')].map((n) => n.textContent).sort().join(","))()`
    );

    let appeared = 0;
    for (let i = 0; i < 20 && appeared < 3; i += 1) {
      await sleep(500);
      appeared = await runningRows();
    }
    assert.equal(appeared, 3, "all three pending rows appear before the terminal");
    // The unnamed corpse has no handle node at all now: it is a small pulsing
    // indication, not a row wearing a member's clothes.
    assert.equal(await runningLabels(), "@drew,@drew", "only the two named rows name anybody");
    assert.equal(
      await evaluate(`(() => document.querySelectorAll('#message-list .message-row[data-scaffolding="1"] .message-typing').length)()`),
      1,
      "the unnamed corpse is the quiet indication"
    );

    // W-M(f): a placeholder row with no text of its own cannot be followed —
    // it is blocked and a tap states the reason on the row — while a row
    // already carrying real text stays openable.
    const blockedState = JSON.parse(await evaluate(`(() => {
      const rows = [...document.querySelectorAll('#message-list .message-row[data-status="Running"]')];
      const blocked = rows.find((row) => row.dataset.streamBlocked);
      if (blocked) { blocked.click(); }
      return JSON.stringify({
        blockedCount: rows.filter((row) => row.dataset.streamBlocked).length,
        streamableCount: rows.filter((row) => row.dataset.streamable === "1").length,
        notice: blocked ? blocked.querySelector(".message-status")?.textContent : ""
      });
    })()`));
    // The unnamed corpse is no longer a message row at all — it is a small
    // pulsing indication that invites no tap, so there is nothing to block and
    // nothing to explain. The named placeholder still looks like a member's row
    // and therefore still has to say why it cannot be followed.
    assert.ok(blockedState.blockedCount >= 1, "the named placeholder is blocked while it has no text: " + JSON.stringify(blockedState));
    assert.equal(blockedState.streamableCount, 1, "the row with real text stays followable: " + JSON.stringify(blockedState));
    assert.equal(blockedState.notice, "No live connection", "a tap on a blocked row states the reason");

    await hub.addMessages(CONVERSATION, [unrelatedTerminal]);
    let remaining = 3;
    for (let i = 0; i < 20 && remaining >= 3; i += 1) {
      await sleep(500);
      remaining = await runningRows();
    }
    assert.equal(remaining, 2, "exactly the 40-minute-old placeholder is swept when a terminal arrives");
    assert.equal(await runningLabels(), "@drew,@drew", "the fresh placeholder and the real pending text survive");
    assert.equal(
      await evaluate(`(() => document.querySelectorAll('#message-list .message-row[data-scaffolding="1"]').length)()`),
      0,
      "the swept corpse takes its indication with it"
    );
    const textSurvives = await evaluate(
      `(() => (document.getElementById("message-list").textContent || "").includes("Half of an answer"))()`
    );
    assert.equal(textSurvives, true, "real pending text is untouched — the sweep is placeholder-only");
  } finally {
    app?.close();
    chrome.kill("SIGKILL");
    await site.close();
    await hub.close();
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
});

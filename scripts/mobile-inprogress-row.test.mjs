// W-N: the in-progress row must survive the run.
//
// Observed on the phone: the "@drew is running" row appears and disappears
// about a second later while the run is still going. The cause is the message
// the user sent *from the phone*. It comes back in the chat's next page as a
// finished ("done") event, and it carries the same run identity as the
// pending row — the run is named after it (`mobile-<eventId>`, and the same
// mobileEventId). The phone treated any non-pending event bearing a run
// identity as that run's terminal, so it deleted the pending row and recorded
// the run as terminal, which also blocked the row from ever coming back.
//
// This harness plays that sequence on a real hub (the User's own server):
// the desktop's chat changes are signed and folded there, and the real PWA,
// paired with it, reads the chat's pages and live progress from it. It
// asserts both halves: the user's own echo must not end the run, and the
// agent's finished message still must. Then the same run is watched as a
// stream while the server's live progress grows it.
import assert from "node:assert/strict";
import test from "node:test";
import { rm } from "node:fs/promises";
import { attachApp, launchChrome, member, openChat, pairPage, serveMobileShell, sleep, startMobileHub, tempProfile } from "./mobile-hub-fixture.mjs";

const SITE_PORT = 8151;
const CDP_PORT = 9341;
const CONVERSATION = "conv-inprogress-qa";
// The phone-originated event id, and the run named after it — the collision at
// the heart of this defect.
const MOBILE_EVENT_ID = "mob-evt-1";
const RUN_ID = `mobile-${MOBILE_EVENT_ID}`;
const DREW = member("drew");

const doneMessage = (i) => ({
  id: `m${String(i).padStart(3, "0")}`,
  role: i % 2 ? "participant" : "user",
  ...(i % 2 ? { participantId: DREW.id, participantLabel: "Drew" } : {}),
  content: `Earlier message number ${i}.`,
  status: "done",
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString()
});

// The member's turn while it is live: a pending message under the run.
const runningRow = {
  id: "m050",
  role: "participant",
  participantId: DREW.id,
  participantLabel: "@drew",
  content: "",
  status: "pending",
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 50)).toISOString(),
  metadata: { runId: RUN_ID, mobileEventId: MOBILE_EVENT_ID }
};

// The message the user sent from the phone, as the chat holds it: role
// "user", status "done", and the run's own identity — chat.ts names the run
// `mobile-<eventId>` and stores the same mobileEventId on the message.
const userEchoFromSnapshot = {
  id: RUN_ID,
  role: "user",
  content: "What is the status of the mailbox work?",
  status: "done",
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 49)).toISOString(),
  metadata: { runId: RUN_ID, mobileEventId: MOBILE_EVENT_ID }
};

test("the in-progress row survives the user's own echo and ends only on the agent's answer", { timeout: 180_000 }, async (t) => {
  const hub = await startMobileHub();
  const site = await serveMobileShell({ port: SITE_PORT, hubOrigins: [hub.base] });
  const profile = await tempProfile("aa-mobile-inprogress-");
  const chrome = launchChrome({ port: CDP_PORT, profile, url: `${site.origin}/`, width: 430, height: 860 });
  let app;
  try {
    await hub.createChat(CONVERSATION, { title: "In-progress QA", participants: [DREW], messages: Array.from({ length: 6 }, (_, i) => doneMessage(i)) });
    app = await attachApp({ port: CDP_PORT });
    await pairPage(app, { hub, siteOrigin: site.origin });
    await openChat(app, CONVERSATION);
    const evaluate = app.evaluate;
    await app.waitFor(`document.getElementById("message-list").textContent.includes("Earlier message number 5.")`, "the chat's history is shown");

    // The phone renders a pending row as an animated "Thinking" rather than
    // echoing the placeholder text, so the row is identified by its status.
    const runningRows = () => evaluate(
      `(() => document.querySelectorAll('#message-list .message-row[data-status="Running"]').length)()`
    );

    await hub.addMessages(CONVERSATION, [runningRow]);
    let appeared = 0;
    for (let i = 0; i < 20 && appeared === 0; i += 1) {
      await sleep(500);
      appeared = await runningRows();
    }
    if (appeared !== 1) {
      t.diagnostic(await evaluate(`(() => JSON.stringify({
        rows: document.getElementById("message-list")?.childElementCount ?? -1,
        statuses: [...document.querySelectorAll("#message-list > *")].map((n) => n.getAttribute("data-status")),
        html: (document.querySelector('#message-list > *:last-child')?.outerHTML || "").slice(0, 300),
        text: (document.getElementById("message-list")?.textContent || "").slice(0, 400)
      }))()`));
    }
    assert.equal(appeared, 1, "the in-progress row must appear while the run is live");

    // The user's own message lands in the chat as finished, under the run's
    // identity. The run has NOT ended.
    await hub.addMessages(CONVERSATION, [userEchoFromSnapshot]);
    await app.waitFor(`document.getElementById("message-list").textContent.includes("What is the status of the mailbox work?")`, "the user's own message came back");
    await sleep(4000);
    assert.equal(
      await runningRows(),
      1,
      "the user's own message coming back as done must not delete the in-progress row"
    );

    // The agent finishing still ends the run.
    await hub.updateMessages(CONVERSATION, [{ ...runningRow, content: "Here is the finished answer from the run.", status: "done" }]);
    let cleared = 1;
    for (let i = 0; i < 20 && cleared !== 0; i += 1) {
      await sleep(500);
      cleared = await runningRows();
    }
    assert.equal(cleared, 0, "the agent's finished answer must still clear the in-progress row");
    assert.ok(await evaluate(`document.getElementById("message-list").textContent.includes("Here is the finished answer from the run.")`), "and the answer is shown");

    // The server's page carries the live row and the echo together, so above
    // the echo can never arrive on its own. Delivered on its own — a page and
    // the live progress are two reads that land in either order — the rule
    // still has to hold: the same three deliveries, one at a time, through
    // the app's own ingest path.
    const ingest = (events) => evaluate(`AccordAgentsMobile.handleRelayTimelinePayload(${JSON.stringify({ type: "mobile.timeline.events", conversationId: CONVERSATION, events })})`);
    const run2 = "mobile-mob-evt-2";
    await ingest([{ id: "live-2", messageId: "live-2", role: "participant", participantLabel: "@drew", content: "@drew is running...", status: "pending",
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 58)).toISOString(), runId: run2, mobileEventId: "mob-evt-2" }]);
    await app.waitFor(`document.querySelectorAll('#message-list .message-row[data-status="Running"]').length === 1`, "the second live row appears");
    await ingest([{ id: run2, messageId: run2, role: "you", content: "And the second question?", status: "done",
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 57)).toISOString(), runId: run2, mobileEventId: "mob-evt-2" }]);
    await sleep(1500);
    assert.equal(await runningRows(), 1, "the user's own message delivered on its own must not delete the in-progress row either");
    await ingest([{ id: "answer-2", messageId: "answer-2", role: "participant", participantLabel: "@drew", content: "The second answer.", status: "done",
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 59)).toISOString(), runId: run2, mobileEventId: "mob-evt-2" }]);
    await app.waitFor(`document.querySelectorAll('#message-list .message-row[data-status="Running"]').length === 0`, "the agent's answer clears the second live row");

    // W-M: the same kind of run, watched as a stream. A fresh run so the row
    // is live again, its text growing with the server's live progress, then
    // opened by tapping it exactly as a reader would.
    const streamRunId = "mobile-stream-evt";
    const streaming = {
      id: "m100", role: "participant", participantId: DREW.id, participantLabel: "@drew", content: "", status: "pending",
      createdAt: new Date(Date.UTC(2026, 0, 1, 1, 0)).toISOString(), metadata: { runId: streamRunId, mobileEventId: "stream-evt" }
    };
    await hub.addMessages(CONVERSATION, [streaming]);
    await hub.progress(CONVERSATION, streamRunId, "Half of a sen", { participantLabel: "@drew" });
    let streamable = 0;
    for (let i = 0; i < 20 && streamable === 0; i += 1) {
      await sleep(500);
      streamable = await evaluate(`(() => document.querySelectorAll('#message-list .message-row[data-streamable="1"]').length)()`);
    }
    assert.equal(streamable, 1, "a live agent row can be opened");

    await evaluate(`(() => {
      document.querySelector('#message-list .message-row[data-streamable="1"]').click();
      return true;
    })()`);
    await sleep(500);
    const opened = await evaluate(`(() => {
      const view = document.getElementById("stream-view");
      return JSON.stringify({ hidden: view.hidden, text: (document.getElementById("stream-body").textContent || "").trim(), state: (document.getElementById("stream-state").textContent || "").trim() });
    })()`);
    const openedState = JSON.parse(opened);
    assert.equal(openedState.hidden, false, "tapping the live row opens the stream");
    assert.equal(openedState.text, "Half of a sen", "opening mid-run shows everything accumulated so far");

    // It grows as the reply grows.
    await hub.progress(CONVERSATION, streamRunId, "Half of a sentence, then the rest.", { participantLabel: "@drew" });
    let grown = "";
    for (let i = 0; i < 20 && !grown.endsWith("the rest."); i += 1) {
      await sleep(500);
      grown = await evaluate(`(() => (document.getElementById("stream-body").textContent || "").trim())()`);
    }
    assert.equal(grown, "Half of a sentence, then the rest.", "the stream follows the reply as it is written");

    // And when the run finishes the view stays, showing the finished answer.
    await hub.updateMessages(CONVERSATION, [{ ...streaming, content: "Half of a sentence, then the rest. Done.", status: "done" }]);
    let finished = "";
    for (let i = 0; i < 20 && !finished.includes("Done."); i += 1) {
      await sleep(500);
      finished = await evaluate(`(() => JSON.stringify({ hidden: document.getElementById("stream-view").hidden, text: (document.getElementById("stream-body").textContent || "").trim(), state: (document.getElementById("stream-state").textContent || "").trim() }))()`);
    }
    const finishedState = JSON.parse(finished);
    assert.equal(finishedState.hidden, false, "the view stays after the run finishes");
    assert.match(finishedState.text, /Done\.$/, "it shows the finished answer");
    assert.equal(finishedState.state, "Done", "and says the run is done rather than still writing");
  } finally {
    app?.close();
    chrome.kill("SIGKILL");
    await site.close();
    await hub.close();
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
});

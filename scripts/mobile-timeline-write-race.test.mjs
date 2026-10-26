/**
 * A run's end and its last live row arriving at the same moment, in the real
 * PWA.
 *
 * While a member writes, the server's live progress delivers the growing row;
 * when the run ends, the chat's newest page brings the finished answer. The
 * two reads are independent, so the finished answer can land while the last
 * live row is still being written. The end of a run deletes that run's live
 * rows, and it did, while every write read the chat back inside its own
 * transaction: IndexedDB runs those one after another, so the deletion always
 * saw the row in front of it. The rows now held in memory for a chat (so a
 * streaming member does not cost a full read per delivered row) were taken
 * the moment a write was created, before the write in front of it had landed
 * -- the deletion judged against a chat that did not yet hold the live row,
 * kept it, and "Thinking…" stayed above the answer it belonged to.
 *
 * This drives the two deliveries through the app's own ingest path, together,
 * and expects the finished answer alone. The phone is paired with a real hub
 * (the User's own server) that holds the chat. Desktop Chrome, not the
 * installed phone.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { rm } from "node:fs/promises";
import { attachApp, launchChrome, member, pairPage, serveMobileShell, startMobileHub, tempProfile } from "./mobile-hub-fixture.mjs";

const SITE_PORT = 8271;
const CDP_PORT = 9421;
const CHAT = "chat-race";
const ROUNDS = 8;

test("a run's end removes its live row even when the two land together", { timeout: 120_000 }, async (t) => {
  const hub = await startMobileHub();
  const site = await serveMobileShell({ port: SITE_PORT, hubOrigins: [hub.base] });
  const profile = await tempProfile("aa-mobile-write-race-");
  const chrome = launchChrome({ port: CDP_PORT, profile, url: `${site.origin}/` });
  let app;
  try {
    await hub.createChat(CHAT, { title: "Race", participants: [member("drew")] });
    app = await attachApp({ port: CDP_PORT });
    await pairPage(app, { hub, siteOrigin: site.origin });
    const evaluate = app.evaluate;
    // One earlier row, delivered and settled, so the chat is one the app
    // already holds rows for: the case an open, busy chat is always in.
    const seeded = await evaluate(`globalThis.AccordAgentsMobile.handleRelayTimelinePayload({
      type: "mobile.timeline.events", conversationId: ${JSON.stringify(CHAT)},
      events: [{ id: "seed", messageId: "seed", role: "participant", participantLabel: "@drew", content: "Earlier", status: "done",
        createdAt: new Date(Date.now() - 60000).toISOString(), runId: "run-seed" }]
    }, undefined, { deferRender: true })`);
    assert.ok(seeded >= 1, "the seed row was stored");

    // Each round: the run's last live row (the server's progress) and its
    // finished answer (the chat's newest page) are ingested at the same time. The live
    // row is stamped a moment after the answer, as a delta that left the
    // desktop after the snapshot did, so nothing but the deletion can end it.
    const rounds = await evaluate(`(async () => {
      const api = globalThis.AccordAgentsMobile;
      const rounds = [];
      for (let round = 0; round < ${ROUNDS}; round += 1) {
        const messageId = "m" + round;
        const runId = "run-" + round;
        const finishedAt = Date.now();
        const batch = (event) => ({ type: "mobile.timeline.events", conversationId: ${JSON.stringify(CHAT)}, events: [event] });
        const live = batch({ id: runId + ":@drew", messageId, role: "participant", participantLabel: "@drew",
          content: "Writing the answer for round " + round, status: "pending", createdAt: new Date(finishedAt + 5).toISOString(), runId });
        const finished = batch({ id: messageId, messageId, role: "participant", participantLabel: "@drew",
          content: "Answer " + round, status: "done", createdAt: new Date(finishedAt).toISOString(), runId });
        await Promise.all([
          api.handleRelayTimelinePayload(live, undefined, { deferRender: true, live: true }),
          api.handleRelayTimelinePayload(finished, undefined, { deferRender: true })
        ]);
        const rows = await api.listTimelineEntries(${JSON.stringify(CHAT)});
        rounds.push(rows.filter((row) => row.messageId === messageId).map((row) => row.status).sort().join("+"));
      }
      return rounds;
    })()`);
    t.diagnostic(`rows per round: ${rounds.join(", ")}`);
    assert.deepEqual(rounds, Array.from({ length: ROUNDS }, () => "done"), "each round ends with the finished answer alone");
  } finally {
    app?.close();
    chrome.kill("SIGKILL");
    await site.close();
    await hub.close();
    await rm(profile, { recursive: true, force: true });
  }
});

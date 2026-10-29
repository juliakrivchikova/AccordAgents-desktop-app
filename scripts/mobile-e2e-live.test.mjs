// End-to-end: the real desktop publisher, the User's own server, the real PWA.
//
// Every mobile harness before this one fed the phone envelopes I wrote by hand.
// That proves the phone reacts correctly to what I *think* the desktop sends,
// which is exactly the gap that let four consecutive "fixes" pass their tests
// and fail on User's phone. Here the live text comes from HubPhonePublisher
// itself — the shipped publication code, fed progress the way a real run
// emits it — goes to a real hub (the User's own server) through the desktop's
// own HubClient, is folded with the chat the desktop published there, and
// lands in a real browser running the built PWA, paired with that server.
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { rm } from "node:fs/promises";
import path from "node:path";
import { attachApp, launchChrome, member, openChat, pairPage, serveMobileShell, sleep, startMobileHub, tempProfile } from "./mobile-hub-fixture.mjs";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, "..");
const SITE_PORT = 8191;
const CDP_PORT = 9351;
const CONVERSATION = "conv-e2e";
const DREW = member("drew", { id: "participant-drew" });

test("live end-to-end: the in-progress row holds, streams, and becomes the answer", { timeout: 180_000 }, async (t) => {
  const { HubPhonePublisher } = require(path.join(repoRoot, "dist/main/main/services/hubPhonePublisher.js"));
  const { HubClient } = require(path.join(repoRoot, "dist/main/main/services/hubClient.js"));
  const hub = await startMobileHub();
  const site = await serveMobileShell({ port: SITE_PORT, hubOrigins: [hub.base] });

  // The desktop's link to its server and its publisher, as main.ts wires them.
  const client = new HubClient({ url: hub.base, identity: async () => hub.owner });
  const logged = [];
  const publisher = new HubPhonePublisher({
    client: () => client,
    hasPhones: async () => (await hub.phones()).length > 0,
    buildCatalog: async () => ({ roles: {}, prompts: [], skills: [] }),
    wakeKeys: async () => [],
    log: (event, payload) => logged.push({ event, ...payload })
  });

  // A run that writes its answer in pieces, exactly like a real one.
  const runId = "run-e2e-1";
  const ticks = ["Half a sen", "Half a sentence, and", "Half a sentence, and then the end."];
  const tick = (text, state, seconds) => ({
    runId,
    phase: state === "finished" ? "done" : "debate",
    message: "@drew is writing.",
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString(),
    agentProgress: {
      participantId: DREW.id,
      participantLabel: "@drew",
      state,
      messageId: "message-drew-e2e",
      partialContent: text
    }
  });
  // The member's message while its run is live, as the desktop's chat holds it.
  const pending = {
    id: "message-drew-e2e", role: "participant", participantId: DREW.id, participantLabel: "@drew", content: "",
    status: "pending", createdAt: new Date(Date.UTC(2026, 0, 1)).toISOString(), metadata: { runId }
  };

  const profile = await tempProfile("aa-e2e-");
  const chrome = launchChrome({ port: CDP_PORT, profile, url: `${site.origin}/`, width: 430, height: 860 });
  let app;
  try {
    await hub.createChat(CONVERSATION, { title: "E2E", participants: [DREW] });
    app = await attachApp({ port: CDP_PORT });
    await pairPage(app, { hub, siteOrigin: site.origin });
    await openChat(app, CONVERSATION);
    const evaluate = app.evaluate;

    const runningRows = () => evaluate(
      `(() => document.querySelectorAll('#message-list .message-row[data-status="Running"]').length)()`
    );
    const streamText = () => evaluate(
      `(() => (document.getElementById("stream-body")?.textContent || "").trim())()`
    );

    // The run starts on the desktop: its message, then its growing text
    // through the real publisher.
    await hub.addMessages(CONVERSATION, [pending]);
    publisher.noteConversation({ id: CONVERSATION, metadata: { participants: [DREW] } });
    publisher.noteProgress(tick(ticks[0], "running", 1), CONVERSATION);
    let rows = 0;
    for (let i = 0; i < 30 && rows === 0; i += 1) {
      await sleep(500);
      rows = await runningRows();
    }
    assert.equal(rows, 1, "the in-progress row reaches the phone from the real publisher");

    // It must still be there after the pause a real run takes.
    await sleep(6000);
    assert.equal(await runningRows(), 1, "the in-progress row holds while the run continues");

    // Opening it shows what has been written so far.
    await app.waitFor(`(document.querySelector('#message-list .message-row[data-streamable="1"] .message-content')?.textContent || "").includes(${JSON.stringify(ticks[0])})`,
      "the live text reached the row");
    await evaluate(`(() => { document.querySelector('#message-list .message-row[data-streamable="1"]').click(); return true; })()`);
    await sleep(500);
    assert.equal(await streamText(), ticks[0], "the stream opens on the text written so far");

    // And follows the reply as it grows.
    publisher.noteProgress(tick(ticks[1], "running", 2), CONVERSATION);
    let grown = "";
    for (let i = 0; i < 30 && grown !== ticks[1]; i += 1) {
      await sleep(500);
      grown = await streamText();
    }
    assert.equal(grown, ticks[1], "the stream follows the reply as it is written");

    // And becomes the answer when the run ends on the desktop.
    publisher.noteProgress(tick(ticks[2], "finished", 3), CONVERSATION);
    await hub.updateMessages(CONVERSATION, [{ ...pending, content: ticks[2], status: "done" }]);
    let finished = "";
    for (let i = 0; i < 30 && !finished.includes("then the end."); i += 1) {
      await sleep(500);
      finished = await streamText();
    }
    assert.equal(finished, ticks[2], "the stream shows the finished answer");
    assert.equal(await runningRows(), 0, "and the row is no longer running");
    assert.deepEqual(logged.filter((entry) => entry.event === "hub.phone.progress-error"), [], "the publisher posted every frame");

    t.diagnostic("row held, stream opened and followed — through the real publisher, the server and the PWA");
  } finally {
    app?.close();
    chrome.kill("SIGKILL");
    await site.close();
    await hub.close();
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
});

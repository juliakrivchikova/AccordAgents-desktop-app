// End-to-end: a turn that STARTS on the phone, from send to cleared row.
//
// The live harness proves an in-progress row appears, holds and streams. It
// never proves the row goes away, and it never starts the turn from the phone
// — it drives desktop-originated progress only. That is the exact gap User's
// screenshot fell into: she sent "Йоу" from the phone, the answer arrived, and
// a "Thinking" row stayed above it forever.
//
// The phone talks to the User's own server only. It decides who its message
// is for, by the desktop's own rules, and writes it as an operation the
// server takes (message.create); the server asks a turn of each member it
// names, and until the member's home takes that turn the phone shows the
// member it addressed, waiting. The home takes the turn under the run id
// every device computes for it (turn-<message>-<member>) and writes the
// member's message, and its live text goes to the server. Here the server is
// a real hub, the live text goes through the desktop's real publisher
// (HubPhonePublisher), and the phone is the built PWA in a real browser,
// which sends by typing into its own composer. The home's own turn logic is
// played by this harness: it answers each message the server took from the
// phone, in the shapes the desktop's chat writes.
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { attachApp, launchChrome, openChat, pairPage, serveMobileShell, startMobileHub, tempProfile } from "./mobile-hub-fixture.mjs";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, "..");
const SITE_PORT = 8291;
const CDP_PORT = 9352;
const CONVERSATION = "conv-turn";
// The chat's members: two to address, and the assistant an unaddressed
// message goes to when nobody has spoken yet.
const MEMBERS = [
  { id: "participant-taylor", handle: "taylor", roleConfigId: "software-engineer", kind: "claude-code" },
  { id: "participant-drew", handle: "drew", roleConfigId: "software-engineer", kind: "codex-cli" },
  { id: "participant-admin", handle: "admin", roleConfigId: "administrator", kind: "claude-code" }
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(label, predicate, { timeoutMs = 25_000, stepMs = 400, detail } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await predicate();
    if (last) {
      return last;
    }
    if (Date.now() > deadline) {
      // Read at the timeout, not at call time: a label built by interpolating
      // the dump up front reports the state before the wait, which is exactly
      // the state that was fine.
      const extra = detail ? await detail() : "";
      throw new Error(`timeout waiting for ${label}${extra ? `: ${extra}` : ""}`);
    }
    await sleep(stepMs);
  }
}

test("live end-to-end: a phone-sent turn clears its own in-progress row", { timeout: 600_000 }, async (t) => {
  const { HubPhonePublisher } = require(path.join(repoRoot, "dist/main/main/services/hubPhonePublisher.js"));
  const { HubClient } = require(path.join(repoRoot, "dist/main/main/services/hubClient.js"));
  const { hubTurnRunId } = require(path.join(repoRoot, "dist/main/shared/hubOps.js"));
  const hub = await startMobileHub();
  const site = await serveMobileShell({ port: SITE_PORT, hubOrigins: [hub.base] });
  const client = new HubClient({ url: hub.base, identity: async () => hub.owner, storage: hub.storage });
  const publisher = new HubPhonePublisher({
    client: () => client,
    hasPhones: async () => true,
    buildCatalog: async () => ({ roles: {}, prompts: [], skills: [] }),
    wakeKeys: async () => [],
    log: () => undefined
  });

  // ---- the member's home ---------------------------------------------------
  let turnSeq = 0;
  const holdUntilReleased = { current: undefined };
  // S7 holds the home off starting the turn, so the row the phone shows
  // before it does can be judged.
  const holdStart = { current: undefined };
  // S6 drives two members off one phone message and releases them one at a
  // time, so the harness can watch what the first finish does to the second.
  const fanoutGates = { current: undefined };
  const multiStepGates = { current: undefined };
  const failures = [];
  const progress = (runId, member, messageId, state, partialContent) => publisher.noteProgress({
    runId, phase: state === "finished" ? "done" : "debate", message: `@${member.handle} is responding.`, createdAt: new Date().toISOString(),
    agentProgress: { participantId: member.id, participantLabel: `@${member.handle}`, state, messageId, activity: "Thinking", partialContent }
  }, CONVERSATION);
  const memberMessage = (id, member, runId, sourceMessageId, content, status) => ({
    id, role: "participant", participantId: member.id, participantLabel: `@${member.handle}`, content, status,
    createdAt: new Date().toISOString(), metadata: { runId, sourceMessageId }
  });
  async function answer(message) {
    turnSeq += 1;
    const seq = turnSeq;
    const content = message.content;
    const targets = (message.metadata && message.metadata.deliveryTargets) || [];
    const members = targets.map((id) => MEMBERS.find((item) => item.id === id)).filter(Boolean);
    if (members.length > 1 && fanoutGates.current) {
      const gates = fanoutGates.current;
      fanoutGates.current = undefined;
      const turns = members.map((member) => ({ member, runId: hubTurnRunId(message.id, member.id), id: `msg-${member.handle}-${seq}` }));
      for (const turn of turns) await hub.claimTurn(CONVERSATION, message.id, turn.member.id);
      await hub.addMessages(CONVERSATION, turns.map((turn) => memberMessage(turn.id, turn.member, turn.runId, message.id, "", "pending")));
      for (const turn of turns) progress(turn.runId, turn.member, turn.id, "running", `@${turn.member.handle} is typing something`);
      for (const turn of turns) {
        await gates[`@${turn.member.handle}`];
        const reply = `Reply from @${turn.member.handle}.`;
        progress(turn.runId, turn.member, turn.id, "finished", reply);
        await hub.updateMessages(CONVERSATION, [memberMessage(turn.id, turn.member, turn.runId, message.id, reply, "done")]);
      }
      return;
    }
    const member = members[0];
    if (!member) {
      failures.push(`no member for ${JSON.stringify(content)}`);
      return;
    }
    const silent = content.includes("no progress yet");
    const multiStep = content.includes("multi step");
    const runId = hubTurnRunId(message.id, member.id);
    const answerId = `msg-answer-${seq}`;
    const tag = content.match(/#([a-z0-9-]+)/)?.[1];
    const text = tag ? `Answer for #${tag}.` : `Answer number ${seq}.`;
    if (holdStart.current) {
      await holdStart.current;
      holdStart.current = undefined;
    }
    // The home takes the turn on the server and starts it: the member's
    // message, live under the run.
    await hub.claimTurn(CONVERSATION, message.id, member.id);
    await hub.addMessages(CONVERSATION, [memberMessage(answerId, member, runId, message.id, "", "pending")]);
    if (!silent) progress(runId, member, answerId, "running", text.slice(0, 8));
    if (multiStep) {
      const gates = multiStepGates.current ?? {};
      multiStepGates.current = undefined;
      await gates.beforeInterim;
      // app_chat_send_message posts immediately and the run carries on: a
      // finished message and a live row belong to the same turn.
      await hub.addMessages(CONVERSATION, [memberMessage(`msg-interim-${seq}`, member, runId, message.id,
        // Long on purpose: a short row lands inside the "near the bottom"
        // slack, so a stand built from one-liners cannot tell following from
        // standing still. A real answer is many lines tall.
        `Interim note ${seq}.\n\n${Array.from({ length: 24 }, (_, line) => `Line ${line + 1} of the note, long enough to push the end of the conversation well out of sight.`).join("\n\n")}`,
        "done")]);
      progress(runId, member, answerId, "running", text.slice(0, 8));
      await gates.beforeFinish;
    }
    if (holdUntilReleased.current) {
      await holdUntilReleased.current;
      holdUntilReleased.current = undefined;
    } else {
      await sleep(content.includes("#slow") ? 6000 : 1200);
    }
    if (content.includes("#fail")) {
      // What a run that dies leaves: the member's message ends in an error.
      progress(runId, member, answerId, "finished", "");
      await hub.updateMessages(CONVERSATION, [memberMessage(answerId, member, runId, message.id, "The run could not be completed.", "error")]);
      return;
    }
    progress(runId, member, answerId, "finished", text);
    await hub.updateMessages(CONVERSATION, [memberMessage(answerId, member, runId, message.id, text, "done")]);
  }
  // Every message of the User's the server took from the phone, once.
  hub.composed.ops.onApplied(({ entry }) => {
    if (entry.deviceId === hub.owner.originId || entry.conversationId !== CONVERSATION) return;
    if (entry.effect.kind !== "message.create" || entry.effect.message.role !== "user") return;
    void answer(entry.effect.message).catch((error) => failures.push(String(error && error.stack || error)));
  });

  const profile = await tempProfile("aa-turn-");
  const chrome = launchChrome({ port: CDP_PORT, profile, url: `${site.origin}/`, width: 430, height: 860 });
  let app;
  try {
    await hub.createChat(CONVERSATION, { title: "Turn", participants: MEMBERS });
    app = await attachApp({ port: CDP_PORT });
    await pairPage(app, { hub, siteOrigin: site.origin, query: "qa=1" });
    await openChat(app, CONVERSATION);
    const evaluate = app.evaluate;

    const runningRows = () => evaluate(
      `(() => document.querySelectorAll('#message-list .message-row[data-status="Running"]').length)()`
    );
    const rowDump = () => evaluate(
      `(() => JSON.stringify(Array.from(document.querySelectorAll("#message-list .message-row")).map((row) => ({
        key: row.dataset.rowKey,
        status: row.dataset.status,
        text: (row.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 60)
      }))))()`
    );
    const bodyHas = (text) => evaluate(
      `(() => (document.getElementById("message-list")?.textContent || "").includes(${JSON.stringify(text)}))()`
    );
    const sendFromPhone = (text) => evaluate(`(() => {
      const input = document.getElementById("composer-input");
      const form = document.getElementById("composer-form");
      input.value = ${JSON.stringify(text)};
      input.dispatchEvent(new Event("input", { bubbles: true }));
      form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event("submit", { cancelable: true }));
      return true;
    })()`);

    // ---- S1: a plain phone-sent turn, no @mention. The exact shape of the
    // message in User's screenshot.
    await sendFromPhone("Йоу");
    await until("the in-progress row appears for the phone-sent turn", async () => await runningRows() > 0);
    await until("the answer arrives", async () => await bodyHas("Answer number 1."));
    await until(
      `S1: the in-progress row clears when the answer lands`,
      async () => await runningRows() === 0,
      { timeoutMs: 20_000, detail: rowDump }
    );
    t.diagnostic(`S1 rows after finish: ${await rowDump()}`);

    // ---- S2: the same turn with an @mention.
    await sendFromPhone("@taylor second one");
    await until("the mention turn shows an in-progress row", async () => await runningRows() > 0);
    await until("the second answer arrives", async () => await bodyHas("Answer number 2."));
    await until(
      `S2: the mention turn clears its in-progress row`,
      async () => await runningRows() === 0,
      { timeoutMs: 20_000, detail: rowDump }
    );

    // ---- S3: the app is killed mid-answer and relaunched. The row must reach
    // the answer after recovery instead of hanging in "Thinking".
    let release;
    holdUntilReleased.current = new Promise((resolve) => { release = resolve; });
    await sendFromPhone("third one");
    await until("the third turn shows an in-progress row", async () => await runningRows() > 0);
    await app.send("Page.reload", {});
    await sleep(5000);
    release();
    await until("the third answer arrives after relaunch", async () => await bodyHas("Answer number 3."), { timeoutMs: 30_000 });
    await until(
      `S3: a run interrupted by a relaunch still clears its row`,
      async () => await runningRows() === 0,
      { timeoutMs: 20_000, detail: rowDump }
    );

    // ---- S4: nothing accumulated across the three turns, and every answer is
    // still there exactly once.
    const dump = JSON.parse(await rowDump());
    assert.equal(
      dump.filter((row) => row.status === "Running").length,
      0,
      `S4: no in-progress rows survive three finished turns: ${JSON.stringify(dump)}`
    );
    for (const seq of [1, 2, 3]) {
      assert.equal(
        dump.filter((row) => row.text.includes(`Answer number ${seq}.`)).length,
        1,
        `S4: answer ${seq} appears exactly once: ${JSON.stringify(dump)}`
      );
    }

    // ---- S8: a long turn that posts a finished intermediate message and keeps
    // working. User watched one and saw TWO rows for one turn: an anonymous
    // "Thinking" and a second row carrying the real text. A turn is one live
    // row, whatever stood in for it before its home started it.
    let releaseInterim;
    let releaseFinish;
    multiStepGates.current = {
      beforeInterim: new Promise((resolve) => { releaseInterim = resolve; }),
      beforeFinish: new Promise((resolve) => { releaseFinish = resolve; })
    };
    await sendFromPhone("multi step please");
    await until("the live row carries real text", async () => await evaluate(
      `(() => [...document.querySelectorAll('#message-list .message-row[data-status="Running"]')]
        .some((row) => (row.querySelector(".message-content")?.textContent || "").trim().length > 0))()`
    ));
    await sleep(2500); // give any second row every chance to show up
    assert.equal(
      await runningRows(),
      1,
      `S8: a running turn shows exactly one live row, not a stand-in beside it: ${await rowDump()}`
    );
    releaseInterim();
    await until("the intermediate message arrives", async () => await bodyHas("Interim note 4."), { detail: rowDump });
    await sleep(2000);
    assert.equal(
      await runningRows(),
      1,
      `S8: posting an intermediate message leaves one live row: ${await rowDump()}`
    );
    releaseFinish();
    await until("the multi-step answer arrives", async () => await bodyHas("Answer number 4."), { timeoutMs: 30_000 });
    await until(
      `S8: the multi-step turn clears its live row`,
      async () => await runningRows() === 0,
      { timeoutMs: 20_000, detail: rowDump }
    );
    const multiDump = JSON.parse(await rowDump());
    for (const text of ["Interim note 4.", "Answer number 4."]) {
      assert.equal(
        multiDump.filter((row) => row.text.includes(text)).length,
        1,
        `S8: "${text}" appears exactly once: ${JSON.stringify(multiDump)}`
      );
    }

    // ---- S7: before its member has written anything, the row must not
    // borrow an identity. Showing "Agent" with a letter avatar and then
    // swapping to the real member mid-run invented somebody. The phone knows
    // who it addressed, so the row names that member from the first moment;
    // this run emits no text until released, so that row is the one judged.
    let releaseSilent;
    let releaseStart;
    holdUntilReleased.current = new Promise((resolve) => { releaseSilent = resolve; });
    holdStart.current = new Promise((resolve) => { releaseStart = resolve; });
    await sendFromPhone("no progress yet please");
    await until("the waiting row appears", async () => await runningRows() > 0);
    // Once the server holds the message, the row says whose home it waits for.
    const placeholder = JSON.parse(await until("the waiting row says what it waits for", async () => {
      const read = JSON.parse(await evaluate(`(() => {
        const row = document.querySelector('#message-list .message-row[data-status="Running"]');
        return JSON.stringify(row ? {
          handle: (row.querySelector(".message-handle")?.textContent || ""),
          text: (row.querySelector(".message-content")?.textContent || "").trim()
        } : null);
      })()`));
      return read && read.text.startsWith("Waiting for your Mac") ? JSON.stringify(read) : false;
    }, { detail: rowDump }));
    assert.match(placeholder.handle, /^@(taylor|drew|admin)$|^Chat Assistant$/, `S7: it names the member it was sent to: ${JSON.stringify(placeholder)}`);
    assert.notEqual(placeholder.handle, "Agent", `S7: it names nobody it does not know: ${JSON.stringify(placeholder)}`);
    assert.match(placeholder.text, /^Waiting for your Mac to start it/, `S7: and says it is waiting for the member's home, not that the member is writing: ${JSON.stringify(placeholder)}`);
    if (process.env.ACCORD_E2E_SHOT) {
      const shot = await app.send("Page.captureScreenshot", { format: "png" });
      await writeFile(process.env.ACCORD_E2E_SHOT, Buffer.from(shot.data, "base64"));
    }
    releaseStart();
    // Started, and still nothing written: the member's own row, under its name.
    await until("the member's own row replaces the waiting one", async () => await evaluate(`(() => {
      const rows = [...document.querySelectorAll('#message-list .message-row[data-status="Running"]')];
      return rows.length === 1 && !(rows[0].querySelector(".message-content")?.textContent || "").includes("Waiting for your Mac") &&
        (rows[0].querySelector(".message-handle")?.textContent || "") === ${JSON.stringify(placeholder.handle)};
    })()`), { detail: rowDump });
    releaseSilent();
    await until("the answer to the silent turn arrives", async () => await bodyHas("Answer number 5."));
    await until(
      `S7: the waiting row clears`,
      async () => await runningRows() === 0,
      { timeoutMs: 20_000, detail: rowDump }
    );
    const named = JSON.parse(await evaluate(`(() => JSON.stringify(Array.from(document.querySelectorAll("#message-list .message-row"))
      .map((row) => (row.querySelector(".message-handle")?.textContent || ""))
      .filter(Boolean)))()`));
    assert.ok(!named.includes("Agent"), `S7: no row is left showing a made-up identity: ${JSON.stringify(named)}`);

    // ---- S9: the view follows a turn it is watching, and never yanks a
    // reader who left the end. Sending already scrolled, but the waiting row
    // and the answer arrive AFTER that scroll, so they used to land below the
    // fold.
    const surfaceState = () => evaluate(`(() => {
      const surface = document.querySelector("#timeline-screen .thread-surface");
      const composer = document.getElementById("composer-form");
      const slack = 80 + (composer ? composer.getBoundingClientRect().height : 0);
      return JSON.stringify({
        atBottom: surface.scrollHeight - surface.scrollTop - surface.clientHeight <= slack,
        scrollTop: Math.round(surface.scrollTop),
        pill: document.getElementById("jump-to-latest")?.classList.contains("is-visible") === true
      });
    })()`);
    const rowInView = (selector) => evaluate(`(() => {
      const row = document.querySelector(${JSON.stringify(selector)});
      if (!row) { return false; }
      const box = row.getBoundingClientRect();
      const composer = document.getElementById("composer-form").getBoundingClientRect();
      return box.top >= 0 && box.bottom <= composer.top + 1;
    })()`);

    let releaseInterim9;
    let releaseFinish9;
    multiStepGates.current = {
      beforeInterim: new Promise((resolve) => { releaseInterim9 = resolve; }),
      beforeFinish: new Promise((resolve) => { releaseFinish9 = resolve; })
    };
    await sendFromPhone("multi step again, no progress yet");
    // (a) The waiting row comes into sight on its own.
    await until("the waiting row is on screen without touching the view", async () => await rowInView('#message-list .message-row[data-status="Running"]'));
    // (b) So does the intermediate message.
    releaseInterim9();
    await until("the intermediate message arrives", async () => await bodyHas("Interim note 6."));
    await sleep(1200);
    assert.equal(
      JSON.parse(await surfaceState()).atBottom,
      true,
      `S9: a reader at the end stays at the end as rows arrive: ${await surfaceState()}`
    );
    // (c) Now leave the end deliberately. Nothing may drag the view back.
    await evaluate(`(() => { document.querySelector("#timeline-screen .thread-surface").scrollTop = 0; return true; })()`);
    await sleep(600);
    const parked = JSON.parse(await surfaceState());
    assert.equal(parked.atBottom, false, "S9 precondition: the reader is in history");
    releaseFinish9();
    await until("the answer to the scrolled-away turn arrives", async () => await bodyHas("Answer number 6."), { timeoutMs: 30_000 });
    await sleep(1500);
    const afterAnswer = JSON.parse(await surfaceState());
    assert.equal(
      afterAnswer.atBottom,
      false,
      `S9: a reader who left the end is not yanked back by an arriving answer: ${JSON.stringify(afterAnswer)}`
    );
    assert.equal(
      afterAnswer.scrollTop,
      parked.scrollTop,
      `S9: the view does not move at all: ${JSON.stringify({ parked, afterAnswer })}`
    );
    assert.equal(afterAnswer.pill, true, `S9: the way back is offered instead: ${JSON.stringify(afterAnswer)}`);
    // Taking the offer returns to the end.
    await evaluate(`(() => { document.getElementById("jump-to-latest").click(); return true; })()`);
    await sleep(1200);
    assert.equal(JSON.parse(await surfaceState()).atBottom, true, "S9: the pill returns the reader to the end");
    await until("the scrolled-away turn still clears its row", async () => await runningRows() === 0, { timeoutMs: 20_000 });

    // ---- S10: two turns overlap. User double-texts, so two phone messages can
    // be in flight with interleaved terminals — exactly where deletes scoped by
    // message or mobile event id could cross-clear each other's rows.
    await sendFromPhone("first of two #slow");
    await sleep(500);
    await sendFromPhone("second of two #quick");
    await until("the quick turn finishes", async () => await bodyHas("Answer for #quick."), { timeoutMs: 30_000 });
    await sleep(1500);
    assert.equal(
      await runningRows(),
      1,
      `S10: finishing one turn leaves the other still running: ${await rowDump()}`
    );
    await until("the slow turn finishes", async () => await bodyHas("Answer for #slow."), { timeoutMs: 40_000 });
    await until(
      "S10: both overlapping turns clear their rows",
      async () => await runningRows() === 0,
      { timeoutMs: 20_000, detail: rowDump }
    );
    const overlapped = JSON.parse(await rowDump());
    for (const text of ["Answer for #slow.", "Answer for #quick."]) {
      assert.equal(
        overlapped.filter((row) => row.text.includes(text)).length,
        1,
        `S10: "${text}" survives the overlap exactly once: ${JSON.stringify(overlapped)}`
      );
    }

    // ---- S11: a run that dies. Its member's message ends in an error, and
    // that must still end the row rather than leaving "Thinking" over a dead
    // run.
    await sendFromPhone("this one #fail");
    await until("the failure is stated on the timeline", async () => await bodyHas("The run could not be completed."), { timeoutMs: 30_000 });
    await until(
      "S11: a failed run clears its in-progress row",
      async () => await runningRows() === 0,
      { timeoutMs: 20_000, detail: rowDump }
    );
    const failed = JSON.parse(await rowDump());
    assert.equal(
      failed.filter((row) => row.status === "Error" && row.text.includes("The run could not be completed.")).length,
      1,
      `S11: the failure reads as an error, once: ${JSON.stringify(failed)}`
    );
    assert.equal(
      await evaluate(`(() => document.querySelectorAll('#message-list .message-row[data-scaffolding="1"]').length)()`),
      0,
      "S11: a failed run takes its indication with it"
    );

    // ---- S6: two members answer ONE phone message, so both live rows share
    // its mobile event id. The first finish must leave the other member still
    // writing. Getting this wrong is the "Thinking flashes and vanishes"
    // regression.
    let releaseDrew;
    let releaseTaylor;
    fanoutGates.current = {
      "@drew": new Promise((resolve) => { releaseDrew = resolve; }),
      "@taylor": new Promise((resolve) => { releaseTaylor = resolve; })
    };
    await sendFromPhone("@drew @taylor both of you");
    await until("both members show an in-progress row", async () => await runningRows() >= 2);
    releaseDrew();
    await until("the first member's answer arrives", async () => await bodyHas("Reply from @drew."));
    await sleep(2500); // let every reconciliation pass settle before judging
    const midFanout = JSON.parse(await rowDump());
    const stillWriting = midFanout.filter((row) => row.status === "Running");
    assert.equal(
      stillWriting.length,
      1,
      `S6: one finish leaves exactly the other member writing: ${JSON.stringify(midFanout)}`
    );
    assert.ok(
      stillWriting[0].text.includes("@taylor"),
      `S6: the surviving in-progress row is the unfinished member's: ${JSON.stringify(midFanout)}`
    );
    releaseTaylor();
    await until("the second member's answer arrives", async () => await bodyHas("Reply from @taylor."));
    await until(
      `S6: the last finish clears the last row`,
      async () => await runningRows() === 0,
      { timeoutMs: 20_000, detail: rowDump }
    );
    const fanoutDump = JSON.parse(await rowDump());
    for (const label of ["@drew", "@taylor"]) {
      assert.equal(
        fanoutDump.filter((row) => row.text.includes(`Reply from ${label}.`)).length,
        1,
        `S6: ${label}'s answer appears exactly once: ${JSON.stringify(fanoutDump)}`
      );
    }

    // ---- S5: tapping does not open a previous answer. With no stale row left
    // to tap, the stream view must stay closed rather than resurrect history.
    await evaluate(`(() => {
      const row = document.querySelector('#message-list .message-row[data-streamable="1"]');
      if (row) { row.click(); }
      return true;
    })()`);
    await sleep(600);
    const streamOpen = await evaluate(`(() => document.getElementById("stream-view")?.hidden === false)()`);
    assert.equal(streamOpen, false, "S5: no finished row advertises itself as a live stream to follow");

    // ---- S12: the live text stops reaching the phone mid-turn. On a real
    // phone the reads are cut off often — iOS backgrounds the app, the
    // network drops — and the turn has to resolve from the chat itself once
    // it can be read again. Live text never reaches the chat's page, so the
    // rows are populated differently: the member's waiting row is the only
    // pending row until its message lands.
    let releaseOffline;
    holdUntilReleased.current = new Promise((resolve) => { releaseOffline = resolve; });
    await sendFromPhone("offline finish #server");
    await until("the turn is under way", async () => await runningRows() > 0);
    hub.setGate(async (request) => request.path === "/v1/phone/progress" ? { drop: true } : undefined);
    releaseOffline();
    await until(
      "the answer arrives with no live text at all",
      async () => await bodyHas("Answer for #server."),
      { timeoutMs: 45_000, detail: rowDump }
    );
    await until(
      "S12: a turn that finished with no live text still clears its row",
      async () => await runningRows() === 0,
      { timeoutMs: 25_000, detail: rowDump }
    );
    hub.setGate(undefined);

    assert.deepEqual(failures, [], "the home answered every message the phone sent");
    t.diagnostic(`all twelve scenarios green; final rows: ${await rowDump()}`);
  } finally {
    app?.close();
    chrome.kill("SIGKILL");
    await site.close();
    await hub.close();
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
});

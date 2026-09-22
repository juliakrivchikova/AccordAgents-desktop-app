/**
 * Activity on the phone, driven through the real PWA in a browser.
 *
 * The desktop's part is played the way the desktop plays it: sealed
 * `mobile.timeline.events` batches for two chats, posted to the reference
 * mailbox the phone drains. Nothing is written into the phone's storage by
 * hand except the pairing and the chat list. Then the bottom bar is used: the
 * Activity tab lists what the relay delivered, a permission is allowed and a
 * choice answered from it, a run is stopped from it, a finished update opens
 * its chat, and a card the desktop withdraws leaves the list.
 *
 * This is a browser check, not the installed phone: it runs the same files the
 * phone runs, under the same origin headers, but a physically installed PWA is
 * not claimed by it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { createCipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { spawn, execSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { attach } = require("./cdp.cjs");
const { createReferenceMailboxServer } = require("./mailbox-reference-server.cjs");
const { loadMobileOriginHeaders, mobileOriginHeadersForPath } = require("./mobile-origin-headers.cjs");

const repoRoot = path.resolve(import.meta.dirname, "..");
const root = path.join(repoRoot, "dist/mobile");
const SITE_PORT = 8215;
const MAILBOX_PORT = 8216;
const CDP_PORT = 9385;
const CHROME = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CHAT_POLISH = "conv-activity-polish";
const CHAT_CLOUD = "conv-activity-cloud";

const SEAL_KEY = randomBytes(32).toString("base64url");
const sealKeyBuffer = Buffer.from(SEAL_KEY, "base64url");
const MAILBOX_TOKEN = createHmac("sha256", sealKeyBuffer).update("accord-mailbox-auth-v1", "utf8").digest("base64url");
const MAILBOX_ID = "mb-" + createHmac("sha256", sealKeyBuffer).update("accord-mailbox-scope-v1", "utf8").digest("base64url").slice(0, 32);

const sealPayload = (payload) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sealKeyBuffer, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const tagged = Buffer.concat([ciphertext, cipher.getAuthTag()]);
  return { v: 1, alg: "A256GCM", iv: iv.toString("base64url"), ct: tagged.toString("base64url") };
};

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const originHeaders = loadMobileOriginHeaders(root);
const site = createServer(async (req, res) => {
  const url = req.url || "/";
  if (url.startsWith("/v1/mailbox/") || url.startsWith("/v1/push/")) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const upstream = await fetch(`http://127.0.0.1:${MAILBOX_PORT}${url}`, {
      method: req.method,
      headers: {
        "content-type": req.headers["content-type"] || "application/json",
        ...(req.headers.authorization ? { authorization: req.headers.authorization } : {})
      },
      body: req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks)
    });
    const body = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, { "content-type": "application/json" });
    res.end(body);
    return;
  }
  const rel = url.split("?")[0];
  const file = path.join(root, rel === "/" ? "index.html" : rel);
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": TYPES[path.extname(file)] || "application/octet-stream",
      ...mobileOriginHeadersForPath(originHeaders, rel)
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

const mailbox = createReferenceMailboxServer({ locked: true });
const mailboxServer = mailbox.server ?? mailbox;

let seq = 0;
const postEnvelope = async (payload) => {
  seq += 1;
  const res = await fetch(`http://127.0.0.1:${MAILBOX_PORT}/v1/mailbox/events?mailboxId=${MAILBOX_ID}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${MAILBOX_TOKEN}` },
    body: JSON.stringify({
      events: [{
        eventId: `activity-envelope-${seq}`,
        conversationId: payload.conversationId,
        logScopeId: payload.conversationId,
        originId: "desktop-origin",
        originSeq: seq,
        eventHash: `hash-${seq}`,
        kind: "mobile.timeline.events",
        payload: sealPayload(payload)
      }]
    })
  });
  const ack = await res.json();
  assert.ok(res.ok && ack.appendedEventIds.length === 1, `mailbox did not append: ${JSON.stringify(ack)}`);
};

const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const doneMessage = (id, label, content, minutes) => ({
  id, messageId: id, role: "participant", participantLabel: label, content, status: "done", createdAt: minutesAgo(minutes)
});

const polishEvents = [
  { id: "u1", messageId: "u1", role: "you", content: "@drew can you check the unread dot?", status: "done", createdAt: minutesAgo(12) },
  doneMessage("m1", "@drew", "Found it. The dot was only cleared on list taps.", 10),
  // A reply in the thread under @drew's first message.
  { ...doneMessage("m2", "@drew", "Fixed. The badge clears too now.", 6), threadRootId: "m1" },
  doneMessage("q1", "@taylor", "Review is green. Which target should the deploy go to?", 1),
  // A run still in progress: the row the desktop publishes while it works.
  {
    id: "run-taylor-1:@taylor", role: "participant", participantLabel: "@taylor",
    content: "Reviewing the diff now.", status: "pending", runId: "run-taylor-1", createdAt: minutesAgo(2)
  }
];
const choiceCard = {
  id: "choice-deploy", kind: "choice", conversationId: CHAT_POLISH, title: "Deploy target",
  summary: "Where should this deploy go?", requesterLabel: "@taylor",
  options: [
    { id: "staging", label: "Deploy to staging now — the phone picks it up the next time it opens" },
    { id: "preview", label: "Publish a preview from main first" }
  ],
  allowsCustomAnswer: true, allowsCancel: true, status: "pending", createdAt: minutesAgo(1), sourceMessageId: "q1"
};
const permissionCard = {
  id: "perm-deploy", kind: "permission", conversationId: CHAT_POLISH,
  title: "Grant @drew shell allow prefix \"npm run deploy:mobile\"",
  summary: "Grant @drew shell allow prefix \"npm run deploy:mobile\"", requesterLabel: "@drew",
  options: [{ id: "allow", label: "Allow" }, { id: "deny", label: "Deny" }],
  allowsCustomAnswer: false, allowsCancel: false, status: "pending", createdAt: minutesAgo(3),
  codexDecisionId: "native-decision-9"
};
const cloudEvents = [doneMessage("c1", "@morgan", "The machine is up and the runtime connected.", 18)];
// A permission whose summary is long and multi-line: answered in the row, so
// every word of it has to be on screen, the end included.
const longCommand = "Codex wants to run: " + "echo checking; ".repeat(30) + "\nrm -rf build/cache";
const cloudPermission = {
  id: "perm-cloud", kind: "permission", conversationId: CHAT_CLOUD, title: "Run a command", summary: longCommand,
  requesterLabel: "@morgan", machineName: "Cloud · eu-west-1",
  options: [{ id: "allow", label: "Allow" }, { id: "deny", label: "Deny" }],
  allowsCustomAnswer: false, allowsCancel: false, status: "pending", createdAt: minutesAgo(4)
};
const cloudChoice = {
  id: "choice-cloud", kind: "choice", conversationId: CHAT_CLOUD, title: "Region",
  summary: "Which region should the machine move to?", requesterLabel: "@morgan",
  options: [{ id: "eu", label: "Stay in eu-west-1" }, { id: "us", label: "Move to us-east-1" }],
  allowsCustomAnswer: true, allowsCancel: true, status: "pending", createdAt: minutesAgo(5), sourceMessageId: "c-question"
};
// Taps within this long of a redraw are ignored by the shell.
const TAP_SETTLE_MS = 600;

const killStaleCdp = () => {
  try { execSync(`lsof -ti tcp:${CDP_PORT} -sTCP:LISTEN | xargs kill -9`, { stdio: "ignore" }); } catch { /* nothing listening */ }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A left swipe on a row: the finger travels far enough for the list to hand
 *  the gesture over, and the row settles open. */
async function swipeLeft(app, selector) {
  const point = await app.touchStart(selector);
  for (const dx of [-20, -50, -90, -110]) {
    await app.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: point.x + dx, y: point.y, radiusX: 1, radiusY: 1, force: 1 }]
    });
    await sleep(40);
  }
  await app.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: []
  });
  await sleep(300);
}

test("Activity lists what the relay delivered and acts on it from the bottom bar", async (t) => {
  await new Promise((r) => site.listen(SITE_PORT, "127.0.0.1", r));
  await new Promise((r) => mailboxServer.listen(MAILBOX_PORT, "127.0.0.1", r));
  killStaleCdp();
  const profile = await mkdtemp(path.join(tmpdir(), "aa-mobile-activity-"));
  const chrome = spawn(CHROME, [
    "--headless=new", "--no-first-run", "--no-default-browser-check",
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    "--window-size=390,844", `http://127.0.0.1:${SITE_PORT}/`
  ], { stdio: "ignore" });

  let app;
  try {
    const registered = await fetch(`http://127.0.0.1:${MAILBOX_PORT}/v1/mailbox/register?mailboxId=${MAILBOX_ID}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${MAILBOX_TOKEN}` },
      body: JSON.stringify({ tokenHashBase64Url: createHash("sha256").update(MAILBOX_TOKEN, "utf8").digest("base64url") })
    });
    assert.ok(registered.ok, "mailbox registration failed");
    await postEnvelope({ type: "mobile.timeline.events", conversationId: CHAT_POLISH, events: polishEvents, cards: [choiceCard, permissionCard] });
    await postEnvelope({ type: "mobile.timeline.events", conversationId: CHAT_CLOUD, events: cloudEvents, cards: [cloudPermission, cloudChoice] });

    const attachWithRetry = async () => {
      app?.close();
      app = undefined;
      for (let i = 0; i < 40 && !app; i += 1) {
        try { app = await attach({ port: CDP_PORT, title: "AccordAgents" }); } catch { await sleep(500); }
      }
      assert.ok(app, "could not attach to Chrome");
    };
    await attachWithRetry();
    const evaluate = async (expr) => (await app.evaluate(expr)).result.value;
    const waitFor = async (expr, label, tries = 60) => {
      let value;
      for (let i = 0; i < tries; i += 1) {
        value = await evaluate(expr);
        if (value) return value;
        await sleep(500);
      }
      assert.fail(`timed out waiting for ${label}`);
    };
    const reload = async () => {
      await evaluate("location.reload()");
      await sleep(800);
      await attachWithRetry();
      await waitFor(`document.readyState === "complete" ? true : null`, "the reloaded page");
    };
    const storedEvents = (store, kind) => evaluate(`(async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open("accordagents-mobile-control");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const rows = await new Promise((resolve) => {
        const all = db.transaction(${JSON.stringify(store)}, "readonly").objectStore(${JSON.stringify(store)}).getAll();
        all.onsuccess = () => resolve(all.result);
        all.onerror = () => resolve([]);
      });
      db.close();
      return rows.filter((row) => row.kind === ${JSON.stringify(kind)});
    })()`);
    const tabCounts = `[...document.querySelectorAll(".act-tab")].map((tab) => tab.innerText.replace(/\\s+/g, " ").trim()).join("|")`;
    const listRows = (tab) => `(() => {
      const list = document.getElementById("activity-list");
      if (!document.getElementById("activity-screen").classList.contains("is-active") || list.dataset.activityTab !== ${JSON.stringify(tab)}) return null;
      return [...list.querySelectorAll(".act-row")].map((row) => ({
        key: row.dataset.activityKey, card: row.dataset.cardId || "", text: row.innerText.replace(/\\s+/g, " ").trim(), unread: row.classList.contains("is-unread")
      }));
    })()`;

    // A device-level pairing: no chat is preselected, so the phone opens on
    // its home screens.
    await evaluate(`(() => {
      localStorage.setItem("accordagents.mobile.pairing.v1", JSON.stringify({
        endpoint: "http://127.0.0.1:${SITE_PORT}/",
        outboxUrl: "http://127.0.0.1:${SITE_PORT}/v1/mailbox/events",
        relaySealKeyBase64: "${SEAL_KEY}",
        pairedAt: new Date(0).toISOString()
      }));
      localStorage.setItem("accordagents.mobile.chatList.v1", JSON.stringify([
        { id: "${CHAT_POLISH}", title: "PWA polish round", group: "AccordAgents", snippet: "…", updatedAt: new Date().toISOString(), participants: ["@drew", "@taylor"], running: true },
        { id: "${CHAT_CLOUD}", title: "Cloud machine setup", group: "AccordAgents", snippet: "…", updatedAt: new Date().toISOString(), participants: ["@morgan"] }
      ]));
      localStorage.removeItem("accordagents.mobile.activeConversationId.v1");
      return true;
    })()`);
    await reload();

    // The bar is there on the home screen, on Chats.
    assert.equal(await waitFor(`(() => {
      const dock = document.getElementById("home-dock");
      return dock && !dock.hidden && document.getElementById("chats-screen").classList.contains("is-active") ? "chats" : null;
    })()`, "the bottom bar on Chats"), "chats");

    // The Activity tab's number counts what waits for the User and the
    // unseen updates, once the relay's batches have landed.
    const badge = await waitFor(`(() => {
      const badge = document.getElementById("activity-badge");
      return badge && !badge.hidden && Number(badge.textContent) >= 4 ? badge.textContent : null;
    })()`, "the Activity badge");
    t.diagnostic(`Activity badge: ${badge}`);

    await evaluate(`document.querySelector('[data-home-tab="activity"]').click()`);
    // The lists catch up with a burst of batches shortly after it, not on
    // every write, so the counts are waited for rather than read once.
    await waitFor(`${tabCounts} === "Running 1|Pending 4|Finished 2" ? true : null`,
      "the tab counts (the question's own message is not also a finished update)");
    const pending = await waitFor(`(() => { const rows = ${listRows("pending")}; return rows && rows.length === 4 ? rows : null; })()`, "the Pending list");
    t.diagnostic(`pending rows: ${JSON.stringify(pending.map((row) => row.text.slice(0, 80)))}`);
    const byCard = Object.fromEntries(pending.map((row) => [row.card, row.text]));
    assert.match(byCard["choice-deploy"], /PWA polish round by @taylor/);
    assert.match(byCard["choice-deploy"], /Where should this deploy go\?/);
    assert.match(byCard["perm-deploy"], /by @drew/);
    assert.match(byCard["perm-deploy"], /npm run deploy:mobile/);
    // Answered in the row, so every word is on screen, the dangerous end too,
    // and where it will run.
    assert.match(byCard["perm-cloud"], /Cloud machine setup by @morgan · Cloud · eu-west-1/);
    const permissionText = await evaluate(`document.querySelector('[data-card-id="perm-cloud"] .act-preview').innerText`);
    assert.equal(permissionText, longCommand, "the whole command, line break kept");
    const clipped = await evaluate(`(() => { const p = document.querySelector('[data-card-id="perm-cloud"] .act-preview'); return p.scrollHeight > p.clientHeight + 1; })()`);
    assert.equal(clipped, false, "nothing of it is hidden");
    // The tab stays where it was put: chosen once, then kept.
    assert.equal(await evaluate(`localStorage.getItem("accordagents.mobile.activityTab.v1")`), "pending");

    // Allow, straight from the row: a second tap on Deny beside it does not
    // send a second, contradicting answer.
    await sleep(TAP_SETTLE_MS);
    await evaluate(`(() => {
      document.querySelector('[data-card-id="perm-deploy"] [data-option-id="allow"]').click();
      document.querySelector('[data-card-id="perm-deploy"] [data-option-id="deny"]').click();
      return true;
    })()`);
    await waitFor(`document.querySelector('[data-card-id="perm-deploy"] .act-state')?.innerText || null`, "the sent state");
    const decisions = await storedEvents("events", "permission.decided");
    assert.equal(decisions.length, 1, "one answer per card");
    assert.equal(decisions[0].conversationId, CHAT_POLISH);
    assert.equal(decisions[0].payload.targetKey, "approval:perm-deploy");
    assert.equal(decisions[0].payload.detail.approve, true);
    assert.equal(decisions[0].payload.detail.codexDecisionId, "native-decision-9");

    // Another chat's cards changing does not make that answer answerable again.
    await postEnvelope({ type: "mobile.timeline.events", conversationId: CHAT_CLOUD, events: cloudEvents, cards: [cloudChoice] });
    await waitFor(`document.querySelector('[data-card-id="perm-cloud"]') ? null : true`, "the other chat's permission withdrawn");
    assert.equal(await evaluate(`document.querySelector('[data-card-id="perm-deploy"] [data-option-id="allow"]').disabled`), true,
      "an answer already sent stays sent when another chat's cards change");
    assert.match(await evaluate(`document.querySelector('[data-card-id="perm-deploy"] .act-state').innerText`), /Waiting for the machine to apply it/);

    // The choice opens in full, with the bar out of reach behind it, and is
    // answered there.
    await sleep(TAP_SETTLE_MS);
    await evaluate(`document.querySelector('[data-card-id="choice-deploy"] .act-main').click()`);
    const item = await waitFor(`(() => {
      const view = document.getElementById("activity-item");
      return view && !view.hidden && view.querySelector('[data-card-id="choice-deploy"]') ? view.innerText : null;
    })()`, "the opened choice");
    assert.match(item, /Waiting for you · asked by @taylor/);
    assert.match(item, /Review is green/, "the message the question belongs to is shown with it");
    assert.equal(await evaluate(`document.getElementById("home-dock").hidden`), true, "the bar steps aside for the opened choice");
    await evaluate(`document.querySelector('#activity-item [data-option-id="staging"]').click()`);
    await waitFor(`(async () => {
      const db = await new Promise((resolve) => { const r = indexedDB.open("accordagents-mobile-control"); r.onsuccess = () => resolve(r.result); });
      const rows = await new Promise((resolve) => { const all = db.transaction("events").objectStore("events").getAll(); all.onsuccess = () => resolve(all.result); });
      db.close();
      return rows.some((row) => row.kind === "choice.answered") ? true : null;
    })()`, "the choice answer in the phone's event log");
    const answers = await storedEvents("events", "choice.answered");
    assert.equal(answers.length, 1);
    assert.equal(answers[0].payload.targetKey, "choice:choice-deploy");
    assert.equal(answers[0].payload.detail.selectedOptionId, "staging");
    assert.equal(answers[0].payload.detail.sourceMessageId, "q1");
    // The desktop takes the answer and stops listing the card: the opened
    // choice goes by itself, and the bar comes back.
    await postEnvelope({ type: "mobile.timeline.events", conversationId: CHAT_POLISH, events: polishEvents, cards: [permissionCard] });
    await waitFor(`document.getElementById("activity-item").hidden && !document.getElementById("home-dock").hidden ? true : null`,
      "the withdrawn choice to close");

    // "Open in chat" from an opened choice goes to that chat.
    await sleep(TAP_SETTLE_MS);
    await evaluate(`document.querySelector('[data-card-id="choice-cloud"] .act-main').click()`);
    await waitFor(`!document.getElementById("activity-item").hidden ? true : null`, "the second choice");
    await evaluate(`document.getElementById("activity-item-open").click()`);
    await waitFor(`(() => document.getElementById("timeline-screen").classList.contains("is-active") &&
      document.getElementById("chat-title").textContent === "Cloud machine setup" ? true : null)()`, "the choice's chat");
    await evaluate(`document.getElementById("back-to-chats").click()`);
    await waitFor(`document.getElementById("activity-screen").classList.contains("is-active") ? true : null`, "Activity again");

    // Running: stop a run from the list.
    await evaluate(`document.querySelector('[data-activity-tab="running"]').click()`);
    const running = await waitFor(`(() => { const rows = ${listRows("running")}; return rows && rows.length === 1 ? rows[0].text : null; })()`, "the Running list");
    assert.match(running, /PWA polish round by @taylor/);
    assert.match(running, /Reviewing the diff now/);
    await sleep(TAP_SETTLE_MS);
    await evaluate(`document.querySelector('#activity-list .act-stop').click()`);
    await waitFor(`(async () => {
      const db = await new Promise((resolve) => { const r = indexedDB.open("accordagents-mobile-control"); r.onsuccess = () => resolve(r.result); });
      const rows = await new Promise((resolve) => { const all = db.transaction("outbox").objectStore("outbox").getAll(); all.onsuccess = () => resolve(all.result); });
      db.close();
      return rows.some((row) => row.kind === "run.cancel.requested") ? true : null;
    })()`, "the stop request queued for the desktop");
    const cancels = await storedEvents("outbox", "run.cancel.requested");
    assert.equal(cancels[0].conversationId, CHAT_POLISH, "a stop from Activity names the run's own chat");
    assert.equal(cancels[0].payload.runId, "run-taylor-1");

    // Finished: one row per chat and member. @drew's newest is a thread reply,
    // so tapping the row opens that thread; coming back finds it read.
    await evaluate(`document.querySelector('[data-activity-tab="finished"]').click()`);
    // The answered question's own message is a finished update now.
    const finished = await waitFor(`(() => { const rows = ${listRows("finished")}; return rows && rows.length === 3 ? rows : null; })()`, "the Finished list");
    t.diagnostic(`finished rows: ${JSON.stringify(finished)}`);
    const drewRow = finished.find((row) => row.text.includes("PWA polish round by @drew"));
    assert.ok(drewRow, "@drew's updates have a row");
    assert.match(drewRow.text, /Fixed\. The badge clears too now\./);
    assert.match(drewRow.text, /\b2\b/, "two updates from @drew in that chat share one row");
    assert.equal(drewRow.unread, true);
    assert.ok(finished.some((row) => /PWA polish round by @taylor/.test(row.text) && /Review is green/.test(row.text)));
    assert.ok(finished.some((row) => /Cloud machine setup by @morgan/.test(row.text)));
    await sleep(TAP_SETTLE_MS);
    // The row, not only its text, is the way in.
    await evaluate(`document.querySelector('#activity-list .act-row[data-activity-key="${drewRow.key}"] .act-avatar').click()`);
    await waitFor(`(() => document.getElementById("timeline-screen").classList.contains("is-active") &&
      !document.getElementById("home-dock").hidden &&
      document.querySelector(".mobile-phone").dataset.dock === "chat" &&
      sessionStorage.getItem("accordagents.mobile.openThreadRootId.v1") === "m1" ? true : null)()`, "the thread to open with the bar under it");

    // The bar under a chat sits below the composer, not over it, and leaves
    // while the keyboard is up.
    const placed = await evaluate(`(() => {
      const dock = document.getElementById("home-dock").getBoundingClientRect();
      const composer = document.getElementById("composer-form").getBoundingClientRect();
      return {
        below: dock.top >= composer.bottom - 1,
        height: Math.round(dock.height),
        inside: dock.bottom <= window.innerHeight + 1
      };
    })()`);
    assert.equal(placed.below, true, "the bar is under the composer, never on top of it");
    assert.equal(placed.inside, true, "the whole bar is on screen, not pushed past the bottom");
    assert.ok(placed.height > 40, `the bar has its height: ${placed.height}px`);
    await evaluate(`document.getElementById("composer-input").focus()`);
    await waitFor(`document.getElementById("home-dock").hidden ? true : null`, "the bar to leave while typing");
    await evaluate(`document.getElementById("composer-input").blur()`);
    await waitFor(`(() => !document.getElementById("home-dock").hidden &&
      document.querySelector(".mobile-phone").dataset.dock === "chat" ? true : null)()`, "the bar to come back when the keyboard goes");

    // A reader up in history is left there when the bar goes and comes back;
    // only a reader who was at the latest message is kept at it.
    const scrolledUp = await evaluate(`(() => {
      const surface = document.querySelector("#timeline-screen .thread-surface");
      if (!surface || surface.scrollHeight <= surface.clientHeight + 80) return null;
      surface.scrollTop = 0;
      return Math.round(surface.scrollTop);
    })()`);
    t.diagnostic(scrolledUp === null ? "thread too short to test scrolled-up reader here" : "reader parked at the top of the thread");
    if (scrolledUp !== null) {
      await evaluate(`document.getElementById("composer-input").focus()`);
      await waitFor(`document.getElementById("home-dock").hidden ? true : null`, "the bar to leave with the reader up in history");
      await evaluate(`document.getElementById("composer-input").blur()`);
      await waitFor(`!document.getElementById("home-dock").hidden ? true : null`, "the bar to come back");
      await sleep(400);
      const stayed = await evaluate(`Math.round(document.querySelector("#timeline-screen .thread-surface").scrollTop)`);
      assert.ok(stayed <= 2, `a reader up in history is not yanked to the latest message (scrollTop ${stayed})`);
      await evaluate(`(() => {
        const surface = document.querySelector("#timeline-screen .thread-surface");
        surface.scrollTop = surface.scrollHeight;
        return true;
      })()`);
    }

    // Inside a chat the bar is the only place the User is told that something
    // elsewhere is waiting, so its number has to keep counting in there: a
    // question that arrives for another chat while this one is open is counted
    // without leaving it, and the number is the same one the home screens show.
    const badgeBefore = Number(await evaluate(`document.getElementById("activity-badge").textContent`));
    const chatBeforeBadge = await evaluate(`document.getElementById("message-list").childElementCount + ":" +
      document.getElementById("message-list").innerText.length`);
    await postEnvelope({
      type: "mobile.timeline.events",
      conversationId: CHAT_CLOUD,
      events: cloudEvents,
      cards: [cloudPermission, {
        id: "perm-chat-bar", kind: "permission", conversationId: CHAT_CLOUD, title: "Run a command",
        summary: "Codex wants to run: npm run build:mobile", requesterLabel: "@morgan",
        options: [{ id: "allow", label: "Allow" }, { id: "deny", label: "Deny" }],
        allowsCustomAnswer: false, allowsCancel: false, status: "pending", createdAt: new Date().toISOString()
      }]
    });
    const countedInChat = await waitFor(`(() => {
      const badge = document.getElementById("activity-badge");
      return document.getElementById("timeline-screen").classList.contains("is-active") &&
        !badge.hidden && Number(badge.textContent) === ${badgeBefore} + 1 ? Number(badge.textContent) : null;
    })()`, "the Activity number to count the new question while a chat is open");
    const chatAfterBadge = await evaluate(`document.getElementById("message-list").childElementCount + ":" +
      document.getElementById("message-list").innerText.length`);
    assert.equal(chatAfterBadge, chatBeforeBadge, "the chat itself is not redrawn for another chat's question");

    // A tab tapped from inside a chat leaves the chat for that screen.
    await evaluate(`document.querySelector('[data-home-tab="settings"]').click()`);
    await waitFor(`(() => document.getElementById("settings-screen").classList.contains("is-active") &&
      !document.getElementById("timeline-screen").classList.contains("is-active") &&
      !localStorage.getItem("accordagents.mobile.activeConversationId.v1") ? true : null)()`, "Settings from inside a chat");
    const countedAtHome = Number(await evaluate(`document.getElementById("activity-badge").textContent`));
    assert.equal(countedInChat, countedAtHome, "the number inside a chat is the one the home screens show, not a stale one");
    assert.ok(countedInChat > 0, "the waiting questions are counted");
    await evaluate(`document.querySelector('[data-home-tab="activity"]').click()`);
    await waitFor(`document.getElementById("activity-screen").classList.contains("is-active") ? true : null`, "Activity again");
    await sleep(TAP_SETTLE_MS);
    await evaluate(`document.querySelector('#activity-list .act-row[data-activity-key="${drewRow.key}"] .act-avatar').click()`);
    await waitFor(`document.getElementById("timeline-screen").classList.contains("is-active") ? true : null`, "the chat again");

    // The search button from a chat opened off the Chats list: the remembered
    // tab is Chats already, so only the open chat can tell the app to leave it.
    // Without that the box would open on a screen the reader cannot see.
    await evaluate(`document.querySelector('[data-home-tab="chats"]').click()`);
    await waitFor(`document.getElementById("chats-screen").classList.contains("is-active") ? true : null`, "Chats");
    await sleep(TAP_SETTLE_MS);
    await evaluate(`document.querySelector('#chat-list .mobile-chat-row').click()`);
    await waitFor(`(() => document.getElementById("timeline-screen").classList.contains("is-active") &&
      localStorage.getItem("accordagents.mobile.homeTab.v1") === "chats" ? true : null)()`, "a chat opened from the list");
    await evaluate(`document.getElementById("chat-search-toggle").click()`);
    await waitFor(`(() => document.getElementById("chats-screen").classList.contains("is-active") &&
      !document.getElementById("chat-search").hidden &&
      !localStorage.getItem("accordagents.mobile.activeConversationId.v1") ? true : null)()`,
      "the chat search from a chat opened off the list");
    await evaluate(`document.getElementById("chat-search-close").click()`);
    await sleep(TAP_SETTLE_MS);
    await evaluate(`document.querySelector('[data-home-tab="activity"]').click()`);
    await waitFor(`document.getElementById("activity-screen").classList.contains("is-active") ? true : null`, "Activity before the second search pass");
    await sleep(TAP_SETTLE_MS);
    await evaluate(`document.querySelector('#activity-list .act-row[data-activity-key="${drewRow.key}"] .act-avatar').click()`);
    await waitFor(`document.getElementById("timeline-screen").classList.contains("is-active") ? true : null`, "the chat from Activity again");

    // And from a chat opened off Activity, where the remembered tab is not
    // Chats: it leaves the chat and switches tab in one go.
    await evaluate(`document.getElementById("chat-search-toggle").click()`);
    await waitFor(`(() => document.getElementById("chats-screen").classList.contains("is-active") &&
      !document.getElementById("chat-search").hidden &&
      !localStorage.getItem("accordagents.mobile.activeConversationId.v1") ? true : null)()`, "the chat search from inside a chat");
    await evaluate(`document.getElementById("chat-search-close").click()`);
    await sleep(TAP_SETTLE_MS);
    await evaluate(`document.querySelector('[data-home-tab="activity"]').click()`);
    await waitFor(`document.getElementById("activity-screen").classList.contains("is-active") ? true : null`, "Activity after the search");
    await sleep(TAP_SETTLE_MS);
    await evaluate(`document.querySelector('#activity-list .act-row[data-activity-key="${drewRow.key}"] .act-avatar').click()`);
    await waitFor(`document.getElementById("timeline-screen").classList.contains("is-active") ? true : null`, "the chat once more");
    await evaluate(`document.getElementById("back-to-chats").click()`);
    const afterBack = await waitFor(`(() => {
      const rows = ${listRows("finished")};
      const drew = rows && rows.find((row) => row.text.includes("by @drew"));
      return drew ? drew : null;
    })()`, "Activity again after going back");
    assert.equal(afterBack.unread, false, "an update is read once its chat was opened");

    // @taylor's run, stamped by the desktop before the chat was opened just
    // now, reaches the phone after it: that is news, whatever the stamp says.
    const taylorFinalStamp = minutesAgo(0.5);
    await postEnvelope({
      type: "mobile.timeline.events", conversationId: CHAT_POLISH, events: [{
        id: "t-final", messageId: "t-final", role: "participant", participantLabel: "@taylor",
        content: "Review done: two nits, both in the thread.", status: "done", runId: "run-taylor-1", createdAt: taylorFinalStamp
      }]
    });
    const settled = await waitFor(`(() => {
      const rows = ${listRows("finished")};
      const taylor = rows && rows.find((row) => row.text.includes("Review done"));
      return taylor ? { first: rows[0].key === taylor.key, unread: taylor.unread, text: taylor.text } : null;
    })()`, "the finished run in Finished");
    assert.equal(settled.unread, true, "a run that ended after the chat was opened is unseen");
    assert.equal(settled.first, true, "and it is the newest update");
    assert.match(settled.text, /Review done/);
    await waitFor(`${tabCounts}.startsWith("Running 0") ? true : null`, "Running to empty");
    // The same message delivered again, and under another id, keeps what the
    // phone knows about it: still unseen.
    const tFinal = { messageId: "t-final", role: "participant", participantLabel: "@taylor",
      content: "Review done: two nits, both in the thread.", status: "done", runId: "run-taylor-1", createdAt: taylorFinalStamp };
    await postEnvelope({ type: "mobile.timeline.events", conversationId: CHAT_POLISH, events: [{ ...tFinal, id: "t-final" }] });
    await postEnvelope({ type: "mobile.timeline.events", conversationId: CHAT_POLISH, events: [{ ...tFinal, id: "page:t-final" }] });
    await sleep(3500);
    const again = await evaluate(`(() => {
      const rows = ${listRows("finished")};
      const taylor = rows && rows.find((row) => row.text.includes("Review done"));
      return taylor ? taylor.unread : null;
    })()`);
    assert.equal(again, true, "a re-delivered finished message is still news");

    // A run watched to its end in the open chat is not news afterwards.
    await sleep(TAP_SETTLE_MS);
    await evaluate(`[...document.querySelectorAll("#activity-list .act-row")].find((row) => row.innerText.includes("by @morgan")).click()`);
    await waitFor(`document.getElementById("chat-title").textContent === "Cloud machine setup" ? true : null`, "the cloud chat");
    await postEnvelope({ type: "mobile.timeline.events", conversationId: CHAT_CLOUD, events: [{
      id: "run-morgan-2:@morgan", role: "participant", participantLabel: "@morgan", content: "Checking the region.",
      status: "pending", runId: "run-morgan-2", createdAt: minutesAgo(0)
    }] });
    await waitFor(`document.getElementById("message-list").innerText.includes("Checking the region") ? true : null`, "the live row in the chat");
    await postEnvelope({ type: "mobile.timeline.events", conversationId: CHAT_CLOUD, events: [{
      id: "m-region", messageId: "m-region", role: "participant", participantLabel: "@morgan", content: "Region checked: eu-west-1 is fine.",
      status: "done", runId: "run-morgan-2", createdAt: minutesAgo(0)
    }] });
    await waitFor(`document.getElementById("message-list").innerText.includes("Region checked") ? true : null`, "the answer in the chat");
    await evaluate(`document.getElementById("back-to-chats").click()`);
    const watched = await waitFor(`(() => {
      const rows = ${listRows("finished")};
      const morgan = rows && rows.find((row) => row.text.includes("Region checked"));
      return morgan ? morgan : null;
    })()`, "the watched answer in Finished");
    assert.equal(watched.unread, false, "an answer watched as it finished is not news");

    // Swipe left on a finished row and it can be cleared from this phone, the
    // way the desktop clears a row from its own Activity (the User,
    // 2026-09-20). The row stands for that member's updates in that chat up to
    // now, so clearing takes those with it and nothing newer.
    await sleep(TAP_SETTLE_MS);
    const clearedKey = await evaluate(`(() => {
      const row = [...document.querySelectorAll("#activity-list .act-row")].find((node) => node.innerText.includes("Region checked"));
      return row ? row.dataset.activityKey : null;
    })()`);
    assert.ok(clearedKey, "the row to clear is on screen");
    await swipeLeft(app, `#activity-list .act-swipe[data-activity-key="${clearedKey}"] .act-row`);
    const clearVisible = await evaluate(`(() => {
      const wrap = document.querySelector('#activity-list .act-swipe[data-activity-key="${clearedKey}"]');
      const action = wrap && wrap.querySelector(".act-swipe-clear");
      return wrap && wrap.dataset.swiped === "1" && action ? action.innerText.trim() : null;
    })()`);
    assert.equal(clearVisible, "Clear", "the swipe opens the row's Clear action");
    assert.equal(await evaluate(`document.getElementById("activity-screen").classList.contains("is-active")`), true,
      "the swipe did not open the chat behind the row");
    assert.equal(await evaluate(`localStorage.getItem("accordagents.mobile.activeConversationId.v1")`), null,
      "and no chat was opened by it");
    // A batch landing between the swipe and the tap rebuilds the list; the
    // action must still be there under the finger.
    await postEnvelope({ type: "mobile.timeline.events", conversationId: CHAT_POLISH, events: polishEvents, cards: [permissionCard] });
    await sleep(1200);
    assert.equal(await evaluate(`(() => {
      const wrap = document.querySelector('#activity-list .act-swipe[data-activity-key="${clearedKey}"]');
      return wrap ? wrap.dataset.swiped : null;
    })()`), "1", "a redraw does not close the open action");
    await evaluate(`document.querySelector('#activity-list .act-swipe[data-activity-key="${clearedKey}"] .act-swipe-clear').click()`);
    await waitFor(`(() => {
      const rows = ${listRows("finished")};
      return rows && !rows.some((row) => row.text.includes("Region checked")) ? true : null;
    })()`, "the cleared row to go");
    await reload();
    await evaluate(`document.querySelector('[data-home-tab="activity"]').click()`);
    await waitFor(`document.getElementById("activity-screen").classList.contains("is-active") ? true : null`, "Activity after the reload");
    await evaluate(`document.querySelector('[data-activity-tab="finished"]').click()`);
    await sleep(1500);
    const stillCleared = await evaluate(`(() => {
      const rows = ${listRows("finished")};
      return rows ? rows.some((row) => row.text.includes("Region checked")) : null;
    })()`);
    assert.equal(stillCleared, false, "a cleared row stays cleared across a launch");
    // A newer update from the same member in the same chat is not covered by
    // what was cleared: the row comes back.
    await postEnvelope({ type: "mobile.timeline.events", conversationId: CHAT_CLOUD, events: [{
      id: "m-region-2", messageId: "m-region-2", role: "participant", participantLabel: "@morgan",
      content: "Region moved: eu-central-1 now.", status: "done", runId: "run-morgan-3", createdAt: minutesAgo(0)
    }] });
    await waitFor(`(() => {
      const rows = ${listRows("finished")};
      return rows && rows.some((row) => row.text.includes("Region moved")) ? true : null;
    })()`, "a newer update after a clear");

    // Swipe left on a waiting choice and it can be cancelled from the list,
    // the way the desktop's "Cancel pending card" does.
    await postEnvelope({
      type: "mobile.timeline.events",
      conversationId: CHAT_POLISH,
      events: polishEvents,
      cards: [permissionCard, {
        id: "choice-swipe", kind: "choice", conversationId: CHAT_POLISH, title: "Swipe target",
        summary: "Cancel me from the list?", requesterLabel: "@taylor",
        options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }],
        allowsCustomAnswer: true, allowsCancel: true, status: "pending",
        createdAt: minutesAgo(0), sourceMessageId: "m1"
      }]
    });
    await evaluate(`document.querySelector('[data-activity-tab="pending"]').click()`);
    await waitFor(`document.querySelector('#activity-list .act-row[data-card-id="choice-swipe"]') ? true : null`,
      "the new waiting choice in Pending");
    await sleep(TAP_SETTLE_MS);
    const cancelKey = await evaluate(`(() => {
      const row = document.querySelector('#activity-list .act-row[data-card-id="choice-swipe"]');
      return row ? row.dataset.activityKey : null;
    })()`);
    assert.ok(cancelKey, "a waiting choice is on screen");
    await swipeLeft(app, `#activity-list .act-swipe[data-activity-key="${cancelKey}"] .act-row`);
    const cancelVisible = await evaluate(`(() => {
      const action = document.querySelector('#activity-list .act-swipe[data-activity-key="${cancelKey}"] .act-swipe-cancel');
      return action ? action.innerText.trim() : null;
    })()`);
    assert.equal(cancelVisible, "Cancel", "the swipe opens the row's Cancel action");
    await sleep(TAP_SETTLE_MS);
    await evaluate(`document.querySelector('#activity-list .act-swipe[data-activity-key="${cancelKey}"] .act-swipe-cancel').click()`);
    const cancelled = await waitFor(`(async () => {
      const db = await new Promise((resolve) => { const r = indexedDB.open("accordagents-mobile-control"); r.onsuccess = () => resolve(r.result); });
      const rows = await new Promise((resolve) => { const all = db.transaction("events").objectStore("events").getAll(); all.onsuccess = () => resolve(all.result); });
      db.close();
      const row = rows.filter((entry) => entry.kind === "choice.answered").find((entry) => entry.payload && entry.payload.detail && entry.payload.detail.cancel);
      return row ? row.payload.targetKey : null;
    })()`, "the cancel in the phone's event log");
    assert.match(cancelled, /^choice:/, "the cancel is recorded against the choice card");

    // The desktop withdraws the last card: Pending empties.
    await postEnvelope({ type: "mobile.timeline.events", conversationId: CHAT_POLISH, events: polishEvents, cards: [] });
    await postEnvelope({ type: "mobile.timeline.events", conversationId: CHAT_CLOUD, events: cloudEvents, cards: [] });
    await evaluate(`document.querySelector('[data-activity-tab="pending"]').click()`);
    const emptied = await waitFor(`(() => {
      const list = document.getElementById("activity-list");
      return list.dataset.activityTab === "pending" && list.querySelectorAll(".act-row").length === 0 ? list.innerText : null;
    })()`, "Pending to empty");
    assert.match(emptied, /Nothing is waiting for you/);

    // Settings says what this phone can do about itself, and nothing it cannot.
    await evaluate(`document.querySelector('[data-home-tab="settings"]').click()`);
    const settings = await waitFor(`document.getElementById("settings-screen").classList.contains("is-active") ? document.getElementById("settings-list").innerText : null`, "Settings");
    assert.match(settings, /Paired with your desktop/);
    assert.match(settings, /Message alerts/);
    assert.doesNotMatch(settings, /Cloud machine/, "no wake without the key for a machine");

    // Search sits on the bar and searches the chats, from any tab.
    await evaluate(`document.getElementById("chat-search-toggle").click()`);
    await waitFor(`(() => document.getElementById("chats-screen").classList.contains("is-active") &&
      !document.getElementById("chat-search").hidden && document.getElementById("home-dock").offsetParent === null ? true : null)()`,
      "search to open on Chats, with the bar out of the way");
    await evaluate(`document.getElementById("chat-search-close").click()`);

    // A phone that is not paired shows the pairing screen and no bar, whatever
    // tab it was left on.
    await evaluate(`(() => {
      localStorage.removeItem("accordagents.mobile.pairing.v1");
      localStorage.setItem("accordagents.mobile.homeTab.v1", "activity");
      return true;
    })()`);
    await reload();
    await waitFor(`(() => document.getElementById("chats-screen").classList.contains("is-active") &&
      !document.getElementById("activity-screen").classList.contains("is-active") &&
      document.getElementById("home-dock").hidden ? true : null)()`, "no bar before pairing");
  } finally {
    app?.close();
    const exited = new Promise((resolve) => chrome.once("exit", resolve));
    chrome.kill("SIGKILL");
    await exited;
    site.close();
    mailboxServer.close();
    // Chrome's helpers can still be writing into the profile as it goes.
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

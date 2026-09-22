/**
 * The phone keeping its cards and its queue honest, driven through the real
 * PWA in a browser.
 *
 * The User's screenshot of 2026-09-20: three cards still "waiting" on the
 * phone that the desktop had closed days earlier, one of them saying "Answer
 * sent" beside live Allow/Deny buttons, and after a reload the same cards
 * looking as if nothing had ever been answered. This drives the paths behind
 * that: the desktop's chat list now says what still waits in every chat, and
 * the phone drops what it no longer lists; the "sent" mark survives a launch;
 * and the queue is flushed for every chat rather than the open one — except
 * what a member's own machine already holds.
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
const SITE_PORT = 8241;
const MAILBOX_PORT = 8242;
const CDP_PORT = 9393;
const CHROME = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CHAT_A = "conv-reconcile-a";
const CHAT_B = "conv-reconcile-b";

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
/** Every mailbox request the page made, for what it says about itself. */
const seenMailboxUrls = [];
/** While set, the box takes nothing: an answer stays this phone's to hand over. */
let refuseAppends = false;
const site = createServer(async (req, res) => {
  const url = req.url || "/";
  if (url.startsWith("/v1/mailbox/") || url.startsWith("/v1/push/")) {
    seenMailboxUrls.push(`${req.method} ${url}`);
    if (refuseAppends && req.method === "POST" && url.startsWith("/v1/mailbox/events")) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false }));
      return;
    }
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
        eventId: `reconcile-envelope-${seq}`,
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

/** What the phone posted into the box: its own queue entries, by kind. */
const mailboxKinds = async () => {
  const res = await fetch(`http://127.0.0.1:${MAILBOX_PORT}/v1/mailbox/events?mailboxId=${MAILBOX_ID}&afterArrival=0&limit=500`, {
    headers: { authorization: `Bearer ${MAILBOX_TOKEN}` }
  });
  const body = await res.json();
  return (body.events || []).filter((event) => event.originId !== "desktop-origin").map((event) => `${event.kind}:${event.eventId}`);
};

const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const message = (id, label, content, minutes) => ({
  id, messageId: id, role: "participant", participantLabel: label, content, status: "done", createdAt: minutesAgo(minutes)
});
const choiceCard = {
  id: "choice-stale", kind: "choice", conversationId: CHAT_A, title: "What next?", summary: "Что делаем дальше?",
  requesterLabel: "@taylor", options: [{ id: "o1", label: "Ship it" }, { id: "o2", label: "Wait" }],
  allowsCustomAnswer: true, allowsCancel: true, status: "pending", createdAt: minutesAgo(10), sourceMessageId: "a1"
};
const permissionCard = {
  id: "perm-bash", kind: "permission", conversationId: CHAT_B, title: "Use Bash", summary: "Use Bash",
  requesterLabel: "@gera", options: [{ id: "allow", label: "Allow" }, { id: "deny", label: "Deny" }],
  allowsCustomAnswer: false, allowsCancel: false, status: "pending", createdAt: minutesAgo(10)
};
const chatItem = (id, title, pendingCards) => ({
  id, title, group: "AccordAgents", snippet: "…", who: "gera:", updatedAt: minutesAgo(9), running: false,
  participants: ["@gera", "@taylor"], members: [], pendingCards
});
const TAP_SETTLE_MS = 700;

const killStaleCdp = () => {
  try { execSync(`lsof -ti tcp:${CDP_PORT} -sTCP:LISTEN | xargs kill -9`, { stdio: "ignore" }); } catch { /* nothing listening */ }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("the phone drops cards the desktop closed, keeps its sent marks across a launch, and flushes every chat's queue", async (t) => {
  await new Promise((r) => site.listen(SITE_PORT, "127.0.0.1", r));
  await new Promise((r) => mailboxServer.listen(MAILBOX_PORT, "127.0.0.1", r));
  killStaleCdp();
  const profile = await mkdtemp(path.join(tmpdir(), "aa-mobile-reconcile-"));
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
    await postEnvelope({ type: "mobile.timeline.events", conversationId: CHAT_A, events: [message("a1", "@taylor", "Что делаем дальше?", 10)], cards: [choiceCard] });
    await postEnvelope({ type: "mobile.timeline.events", conversationId: CHAT_B, events: [message("b1", "@gera", "Need Bash for this.", 10)], cards: [permissionCard] });

    const attachWithRetry = async () => {
      app?.close();
      app = undefined;
      for (let i = 0; i < 40 && !app; i += 1) {
        try { app = await attach({ port: CDP_PORT, title: "AccordAgents" }); } catch { await sleep(500); }
      }
      assert.ok(app, "could not attach to Chrome");
    };
    await attachWithRetry();
    const evaluate = async (expr) => {
      const result = await app.evaluate(expr);
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
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
      await waitFor(`document.readyState === "complete" && Boolean(globalThis.AccordAgentsMobile) ? true : null`, "the reloaded page");
    };
    const pendingRows = `(() => {
      const list = document.getElementById("activity-list");
      if (!document.getElementById("activity-screen").classList.contains("is-active") || list.dataset.activityTab !== "pending") return null;
      return [...list.querySelectorAll(".act-row")].map((row) => ({
        card: row.dataset.cardId || "", text: row.innerText.replace(/\\s+/g, " ").trim(),
        disabled: [...row.querySelectorAll("button.act-pill")].map((button) => button.disabled)
      }));
    })()`;
    const openActivityPending = async () => {
      await evaluate(`document.querySelector('[data-home-tab="activity"]').click()`);
      await waitFor(`document.getElementById("activity-screen").classList.contains("is-active") ? true : null`, "Activity");
      await evaluate(`document.querySelector('[data-activity-tab="pending"]')?.click()`);
      await sleep(TAP_SETTLE_MS);
    };

    // A device-level pairing: no chat preselected, the phone opens on its
    // home screens. The list is what the desktop last sent.
    await evaluate(`(() => {
      localStorage.setItem("accordagents.mobile.pairing.v1", JSON.stringify({
        endpoint: "http://127.0.0.1:${SITE_PORT}/",
        outboxUrl: "http://127.0.0.1:${SITE_PORT}/v1/mailbox/events",
        relaySealKeyBase64: "${SEAL_KEY}",
        pairedAt: new Date(0).toISOString()
      }));
      localStorage.setItem("accordagents.mobile.chatList.v1", JSON.stringify([
        ${JSON.stringify(chatItem(CHAT_A, "PWA cleanup"))},
        ${JSON.stringify(chatItem(CHAT_B, "Octopi Tracker"))}
      ]));
      localStorage.removeItem("accordagents.mobile.activeConversationId.v1");
      return true;
    })()`);
    await reload();

    await openActivityPending();
    let rows = await waitFor(`(() => { const rows = ${pendingRows}; return rows && rows.length === 2 ? rows : null; })()`, "both cards in Pending");
    t.diagnostic(`pending before: ${rows.map((row) => row.card).join(", ")}`);

    // The permission is allowed from the row. The answer is queued, posted
    // to the box, and the row says so.
    await evaluate(`document.querySelector('#activity-list .act-row[data-card-id="perm-bash"] .act-pill[data-option-id="allow"]').click()`);
    rows = await waitFor(`(() => {
      const rows = ${pendingRows};
      const row = rows && rows.find((item) => item.card === "perm-bash");
      return row && /Answer sent/.test(row.text) && row.disabled.every(Boolean) ? rows : null;
    })()`, "the permission row to say the answer was sent");
    let kinds = [];
    for (let i = 0; i < 40 && !kinds.some((kind) => kind.startsWith("permission.decided:")); i += 1) {
      kinds = await mailboxKinds();
      if (!kinds.some((kind) => kind.startsWith("permission.decided:"))) await sleep(500);
    }
    assert.ok(kinds.some((kind) => kind.startsWith("permission.decided:")), `the answer reached the box: ${kinds.join(", ")}`);

    // After a launch the mark is still there: the card is not offered as if
    // nothing had been answered (what the User saw), and it cannot be
    // answered a second time.
    await reload();
    await openActivityPending();
    rows = await waitFor(`(() => { const rows = ${pendingRows}; return rows && rows.length === 2 ? rows : null; })()`, "Pending after the launch");
    const permAfterLaunch = rows.find((row) => row.card === "perm-bash");
    assert.match(permAfterLaunch.text, /Answer sent/, "the sent mark survived the launch");
    assert.ok(permAfterLaunch.disabled.every(Boolean), "and the options stay dead");
    assert.equal(await evaluate(`globalThis.AccordAgentsMobile.isCardSent("perm-bash")`), true);

    // The page's own reads say they are the phone's, with the cursor it has
    // committed, so the relay's doorbell does not ring for what is already on
    // screen (the worker says the same of its background reads).
    assert.ok(seenMailboxUrls.some((url) => url.startsWith("GET ") && url.includes("reader=phone") && url.includes("afterArrival=")),
      `the page's cursor reads name the phone as the reader: ${seenMailboxUrls.filter((url) => url.startsWith("GET ")).slice(0, 3).join(" | ")}`);

    // An answer the mailbox has taken is not lost, only waiting for the
    // desktop: however long ago it was given, the card stays locked and says
    // the answer was sent. Unlocked, a second answer only raced the first,
    // and the older one won on the desktop.
    await evaluate(`(() => {
      const marks = JSON.parse(localStorage.getItem("accordagents.mobile.controlCardSent.v1") || "{}");
      marks["perm-bash"] = { ...marks["perm-bash"], at: new Date(Date.now() - 11 * 60000).toISOString() };
      localStorage.setItem("accordagents.mobile.controlCardSent.v1", JSON.stringify(marks));
      return true;
    })()`);
    await reload();
    await openActivityPending();
    rows = await waitFor(`(() => {
      const rows = ${pendingRows};
      const row = rows && rows.find((item) => item.card === "perm-bash");
      return row && /Answer sent/.test(row.text) && row.disabled.every(Boolean) ? rows : null;
    })()`, "an answer the mailbox holds to keep the card locked");
    assert.equal(await evaluate(`globalThis.AccordAgentsMobile.isCardLocked("perm-bash")`), true);
    // An answer nobody has taken (say the desktop never did) that has been on
    // its way for too long has stopped meaning anything: the card unlocks and
    // says so, and answering again replaces the earlier answer rather than
    // racing it.
    const earlierEventId = await evaluate(`(async () => {
      const marks = JSON.parse(localStorage.getItem("accordagents.mobile.controlCardSent.v1") || "{}");
      const eventId = marks["perm-bash"] && marks["perm-bash"].eventId;
      const db = await self.AccordMobileDb.openControlDb(indexedDB);
      const tx = db.transaction("outbox", "readwrite");
      const store = tx.objectStore("outbox");
      await new Promise((resolve) => { const get = store.get(eventId); get.onsuccess = () => { store.put({ ...get.result, status: "waiting-to-sync" }); resolve(); }; });
      await new Promise((resolve) => { tx.oncomplete = resolve; });
      db.close();
      return eventId;
    })()`);
    assert.ok(earlierEventId, "the mark names the queue entry that carried the first answer");
    // The box takes nothing for now, so the launch's flush cannot hand the
    // answer over again behind the test's back.
    refuseAppends = true;
    await reload();
    await openActivityPending();
    rows = await waitFor(`(() => {
      const rows = ${pendingRows};
      const row = rows && rows.find((item) => item.card === "perm-bash");
      return row && /You can answer again/.test(row.text) && row.disabled.every((dead) => !dead) ? rows : null;
    })()`, "the stale answer to unlock the card");
    assert.equal(await evaluate(`globalThis.AccordAgentsMobile.isCardLocked("perm-bash")`), false);
    refuseAppends = false;
    await evaluate(`document.querySelector('#activity-list .act-row[data-card-id="perm-bash"] .act-pill[data-option-id="deny"]').click()`);
    await waitFor(`(() => {
      const rows = ${pendingRows};
      const row = rows && rows.find((item) => item.card === "perm-bash");
      return row && /Answer sent/.test(row.text) && row.disabled.every(Boolean) ? true : null;
    })()`, "the second answer to lock the card again");
    const superseded = await evaluate(`globalThis.AccordAgentsMobile.listOutboxEntries().then((entries) => entries.map((entry) => entry.eventId + "=" + entry.status))`);
    assert.ok(superseded.includes(earlierEventId + "=superseded"), `the earlier answer was set aside, not sent: ${superseded.join(", ")}`);
    assert.equal(await evaluate(`globalThis.AccordAgentsMobile.desktopOwesEntry({ status: "superseded" })`), false);
    // The second answer goes out after the row already says so; give it time.
    for (let i = 0; i < 40 && kinds.filter((kind) => kind.startsWith("permission.decided:")).length < 2; i += 1) {
      kinds = await mailboxKinds();
      if (kinds.filter((kind) => kind.startsWith("permission.decided:")).length < 2) await sleep(500);
    }
    assert.equal(kinds.filter((kind) => kind.startsWith("permission.decided:")).length, 2, `only the two answers the User actually gave reached the box: ${kinds.join(", ")}`);

    // The cards reached this phone a while ago (the User's were days old); a
    // card that arrived within the last two minutes is left for the next list
    // to judge, so age them here.
    await evaluate(`(() => {
      const all = JSON.parse(localStorage.getItem("accordagents.mobile.controlCards.v1") || "{}");
      for (const list of Object.values(all)) for (const card of list) card.receivedAt = new Date(Date.now() - 10 * 60000).toISOString();
      localStorage.setItem("accordagents.mobile.controlCards.v1", JSON.stringify(all));
      return true;
    })()`);
    // The desktop's chat list arrives: chat A no longer waits on anything,
    // chat B still waits on the permission. The stale choice leaves; the
    // permission stays, still marked as sent.
    await evaluate(`globalThis.AccordAgentsMobile.handleRelayChatListPayload(${JSON.stringify({
      type: "mobile.chat-list", generatedAt: new Date().toISOString(),
      chats: [chatItem(CHAT_A, "PWA cleanup", []), chatItem(CHAT_B, "Octopi Tracker", [permissionCard])]
    })})`);
    rows = await waitFor(`(() => {
      const rows = ${pendingRows};
      return rows && rows.length === 1 && rows[0].card === "perm-bash" ? rows : null;
    })()`, "the choice the desktop closed to leave Pending");
    assert.match(rows[0].text, /Answer sent/);
    const storedA = await evaluate(`JSON.parse(localStorage.getItem("accordagents.mobile.controlCards.v1"))[${JSON.stringify(CHAT_A)}] || []`);
    assert.deepEqual(storedA.filter((card) => card.status === "pending"), [], "chat A holds no pending card any more");

    // The chat itself agrees: its pinned strip is empty.
    await evaluate(`localStorage.setItem("accordagents.mobile.activeConversationId.v1", ${JSON.stringify(CHAT_A)})`);
    await reload();
    await waitFor(`document.getElementById("timeline-screen").classList.contains("is-active") ? true : null`, "chat A open");
    await sleep(1500);
    assert.equal(await evaluate(`document.querySelectorAll('#control-cards [data-card-id="choice-stale"]').length`), 0,
      "the closed choice is not pinned above the composer");
    await evaluate(`document.getElementById("back-to-chats").click()`);
    await waitFor(`!document.getElementById("timeline-screen").classList.contains("is-active") ? true : null`, "back home");

    // A pending card younger than the list may simply have missed it: it
    // stays until the next list decides.
    const freshCard = { ...choiceCard, id: "choice-fresh", createdAt: new Date().toISOString(), sourceMessageId: "a1" };
    await postEnvelope({ type: "mobile.timeline.events", conversationId: CHAT_A, events: [], cards: [freshCard] });
    await openActivityPending();
    await waitFor(`(() => { const rows = ${pendingRows}; return rows && rows.some((row) => row.card === "choice-fresh") ? true : null; })()`, "the fresh card in Pending");
    await evaluate(`globalThis.AccordAgentsMobile.handleRelayChatListPayload(${JSON.stringify({
      type: "mobile.chat-list", generatedAt: new Date().toISOString(),
      chats: [chatItem(CHAT_A, "PWA cleanup", []), chatItem(CHAT_B, "Octopi Tracker", [])]
    })})`);
    await sleep(1200);
    rows = await evaluate(pendingRows);
    assert.ok(rows.some((row) => row.card === "choice-fresh"), "a card younger than the list is kept");
    assert.ok(!rows.some((row) => row.card === "perm-bash"), "a card the desktop no longer waits on is gone");
    assert.equal(await evaluate(`globalThis.AccordAgentsMobile.isCardSent("perm-bash")`), false, "its sent mark went with it");

    // A card learned from a member's machine directly is not the desktop's to
    // withdraw: it stays whatever the list says.
    await evaluate(`(() => {
      const all = JSON.parse(localStorage.getItem("accordagents.mobile.controlCards.v1") || "{}");
      all[${JSON.stringify(CHAT_B)}] = [{ ...${JSON.stringify(permissionCard)}, id: "perm-machine", source: "machine", createdAt: new Date(Date.now() - 3600000).toISOString() }];
      localStorage.setItem("accordagents.mobile.controlCards.v1", JSON.stringify(all));
      return true;
    })()`);
    await evaluate(`globalThis.AccordAgentsMobile.handleRelayChatListPayload(${JSON.stringify({
      type: "mobile.chat-list", generatedAt: new Date().toISOString(),
      chats: [chatItem(CHAT_A, "PWA cleanup", []), chatItem(CHAT_B, "Octopi Tracker", [])]
    })})`);
    // The list changed nothing this time, so nothing redrew; ask for a redraw
    // the way a pull to refresh does.
    await evaluate(`globalThis.AccordAgentsMobile.refreshChatList()`);
    await waitFor(`(() => { const rows = ${pendingRows}; return rows && rows.some((row) => row.card === "perm-machine") ? true : null; })()`, "the machine's own card kept");

    // The queue is flushed for every chat, and never for what a machine holds.
    await evaluate(`(async () => {
      await globalThis.AccordAgentsMobile.enqueueMessage({ content: "queued for chat A while elsewhere", conversationId: ${JSON.stringify(CHAT_A)} });
      const db = await self.AccordMobileDb.openControlDb(indexedDB);
      const tx = db.transaction("outbox", "readwrite");
      tx.objectStore("outbox").put({
        eventId: "held-by-machine", conversationId: ${JSON.stringify(CHAT_B)}, status: "syncing", deliveredVia: "machine",
        machineId: "m1", machineRunId: "mobile-held-by-machine", kind: "message.created",
        payload: { content: "already on the machine" }, createdAt: new Date().toISOString(), attempts: 1, updatedAt: new Date().toISOString()
      });
      await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
      db.close();
      return true;
    })()`);
    const flushed = await evaluate(`globalThis.AccordAgentsMobile.flushOutbox().then((result) => JSON.stringify(result))`);
    t.diagnostic(`flush: ${flushed}`);
    kinds = await mailboxKinds();
    assert.ok(kinds.some((kind) => kind.startsWith("message.created:")), `the queued message for the other chat went out: ${kinds.join(", ")}`);
    assert.ok(!kinds.some((kind) => kind.endsWith(":held-by-machine")), "what the machine holds did not go to the desktop as well");
    const statuses = await evaluate(`globalThis.AccordAgentsMobile.listOutboxEntries().then((entries) => entries.map((entry) => entry.eventId + "=" + entry.status))`);
    assert.ok(statuses.some((status) => status === "held-by-machine=syncing"), `the machine's entry is untouched: ${statuses.join(", ")}`);
    // The answer set aside earlier stays set aside; everything the desktop was
    // owed is acked.
    assert.ok(!statuses.some((status) => status !== "held-by-machine=syncing" && !status.endsWith("=acked") && !status.endsWith("=superseded")),
      `everything else is acked or set aside: ${statuses.join(", ")}`);
  } finally {
    app?.close();
    chrome.kill("SIGKILL");
    site.close();
    mailboxServer.close();
    await rm(profile, { recursive: true, force: true });
  }
});

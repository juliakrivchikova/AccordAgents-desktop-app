// The PWA polish round, driven through the real shell in Chrome against the
// real MobileRelayControlService over the reference relay and mailbox:
// search, the time under a finished message, unread dots and the icon number,
// the members sheet, earlier history, the "/" menu with a picked skill, pull
// to refresh, coming back to the foreground, a picture at full size, and the
// wording a push-woken worker builds without opening anything sealed.
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
const { attach, getJson } = require("./cdp.cjs");
const { createReferenceMailboxServer } = require("./mailbox-reference-server.cjs");
const { createReferenceRelayServer } = require("./relay-reference-server.cjs");
const { loadMobileOriginHeaders, mobileOriginHeadersForPath } = require("./mobile-origin-headers.cjs");

const repoRoot = path.resolve(import.meta.dirname, "..");
const root = path.join(repoRoot, "dist/mobile");
const SITE_PORT = 8197;
const MAILBOX_PORT = 8198;
const CDP_PORT = 9377;
const CHROME = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const RENDEZVOUS = "rv-polish";
const CHAT_A = "conv-polish-alpha";
const CHAT_B = "conv-polish-beta";
const CHAT_C = "conv-polish-gamma";

const SEAL_KEY = randomBytes(32).toString("base64url");
const sealKeyBuffer = Buffer.from(SEAL_KEY, "base64url");
const MAILBOX_TOKEN = createHmac("sha256", sealKeyBuffer).update("accord-mailbox-auth-v1", "utf8").digest("base64url");
const MAILBOX_ID = "mb-" + createHmac("sha256", sealKeyBuffer).update("accord-mailbox-scope-v1", "utf8").digest("base64url").slice(0, 32);
// A 1x1 PNG, enough for a picture to load and be opened.
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const sealPayload = (payload) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sealKeyBuffer, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const tagged = Buffer.concat([ciphertext, cipher.getAuthTag()]);
  return { v: 1, alg: "A256GCM", iv: iv.toString("base64url"), ct: tagged.toString("base64url") };
};

const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".png": "image/png", ".webmanifest": "application/manifest+json"
};

const killStaleCdp = () => {
  try {
    execSync(`lsof -ti tcp:${CDP_PORT} -sTCP:LISTEN | xargs kill -9`, { stdio: "ignore" });
  } catch {
    // nothing listening
  }
};

const at = (minute) => new Date(Date.UTC(2026, 8, 15, 12, minute)).toISOString();
const doneRow = (id, minute, role, content, extra = {}) => ({
  id, messageId: id, role, ...(role === "participant" ? { participantLabel: "@drew" } : {}),
  content, status: "done", createdAt: at(minute), ...extra
});

test("PWA polish: search, times, unread, members, earlier history, slash menu, refresh, foreground, pictures, notification wording", async () => {
  const { MobileRelayControlService } = await import(path.join(repoRoot, "dist/main/main/services/mobileRelayControl.js"));

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
    let rel = url.split("?")[0];
    if (rel === "/") rel = "/index.html";
    try {
      const body = await readFile(path.join(root, rel));
      // The shipped policy allows wss: only; this harness's relay is ws:.
      const headers = { ...mobileOriginHeadersForPath(originHeaders, rel) };
      delete headers["Content-Security-Policy"];
      res.writeHead(200, { "content-type": TYPES[path.extname(rel)] || "application/octet-stream", ...headers });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  await new Promise((r) => site.listen(SITE_PORT, "127.0.0.1", r));
  const mailbox = createReferenceMailboxServer({ locked: true });
  const mailboxServer = mailbox.server ?? mailbox;
  await new Promise((r) => mailboxServer.listen(MAILBOX_PORT, "127.0.0.1", r));
  const relay = createReferenceRelayServer();
  const relayAddress = await relay.listen();
  await fetch(`http://127.0.0.1:${MAILBOX_PORT}/v1/mailbox/register?mailboxId=${MAILBOX_ID}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${MAILBOX_TOKEN}` },
    body: JSON.stringify({ tokenHashBase64Url: createHash("sha256").update(MAILBOX_TOKEN, "utf8").digest("base64url") })
  });

  let mailboxSeq = 0;
  const postEnvelope = async (conversationId, kind, payload) => {
    mailboxSeq += 1;
    const res = await fetch(`http://127.0.0.1:${MAILBOX_PORT}/v1/mailbox/events?mailboxId=${MAILBOX_ID}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${MAILBOX_TOKEN}` },
      body: JSON.stringify({
        events: [{
          eventId: `polish-${mailboxSeq}`, conversationId, logScopeId: conversationId,
          originId: "desktop-origin", originSeq: mailboxSeq, eventHash: `hash-${mailboxSeq}`,
          kind, payload: sealPayload(payload)
        }]
      })
    });
    const ack = await res.json();
    assert.ok(res.ok && ack.appendedEventIds.length === 1, `mailbox did not append: ${JSON.stringify(ack)}`);
  };

  // What the desktop catalog answers. Counted, so refreshes are observable.
  const calls = { listChats: 0, timeline: [], composer: [] };
  const sent = [];
  const chats = [
    {
      id: CHAT_A, title: "Alpha planning", group: "AccordAgents", snippet: "Let us plan the release.", who: "drew:",
      updatedAt: at(1), running: false, participants: ["@drew", "@taylor"],
      members: [
        { id: "p-drew", handle: "drew", mentionHandle: "drew", displayName: "@drew", roleLabel: "Software Engineer", kind: "codex-cli" },
        { id: "p-taylor", handle: "taylor", mentionHandle: "taylor", displayName: "@taylor", roleLabel: "Reviewer", kind: "claude-code",
          homeMachineId: "machine-1", homeMachineName: "Office Mac", participant: { id: "p-taylor", handle: "taylor", roleConfigId: "reviewer", kind: "claude-code" } }
      ]
    },
    { id: CHAT_B, title: "Beta bugs", group: "AccordAgents", snippet: "Fixed the crash.", who: "you:", updatedAt: at(2), running: false, participants: ["@drew"], members: [] },
    { id: CHAT_C, title: "Gamma notes", group: "Other project", snippet: "Notes.", who: "gera:", updatedAt: at(3), running: false, participants: ["@gera"], members: [] }
  ];
  const control = new MobileRelayControlService(
    {
      relayUrl: relayAddress.url, rendezvousId: RENDEZVOUS, relayCapability: "PAIRING-FINGERPRINT",
      relaySealKeyBase64: SEAL_KEY, streamId: "route-polish:phone", reconnectDelayMs: 50
    },
    {
      async sendMessage(request) {
        sent.push(request);
        return { conversation: { id: request.conversationId, kind: "chat", title: "t", createdAt: at(0), updatedAt: at(0), messages: [], findings: [], metadata: {} } };
      },
      async readChatAttachment(request) {
        return { attachment: { id: request.attachmentId, mimeType: "image/png", sizeBytes: 68, filename: "dot.png" }, dataBase64: PNG_1X1 };
      }
    },
    {
      async listChats() { calls.listChats += 1; return chats; },
      async listTimeline() { return []; },
      async listTimelinePage(conversationId, options) {
        calls.timeline.push({ conversationId, beforeMessageId: options.beforeMessageId });
        if (conversationId !== CHAT_A) return { events: [], hasMoreBefore: false };
        if (options.beforeMessageId === "a-010") {
          return {
            events: [doneRow("a-008", 8, "you", "Two earlier."), doneRow("a-009", 9, "participant", "One earlier.")],
            hasMoreBefore: false, beforeMessageId: "a-008"
          };
        }
        return {
          events: [
            doneRow("a-010", 10, "you", "Latest question?"),
            doneRow("a-011", 11, "participant", "Latest answer, with a picture.", {
              attachments: [{ id: "att-1", filename: "dot.png", mimeType: "image/png", sizeBytes: 68, width: 1, height: 1 }]
            })
          ],
          hasMoreBefore: true, beforeMessageId: "a-010"
        };
      },
      async composerOptions(request) {
        calls.composer.push(request);
        return {
          commands: [{ id: "compact", label: "/compact", description: "Compact the mentioned member context" }],
          prompts: [{ id: "prompt-1", label: "Standup", trigger: "standup", body: "Give me a standup summary." }],
          skills: [{ skillId: "skill-review", displayName: "review", frontmatterName: "review", description: "Review the diff", contentHash: "h", capabilityState: "invocable", variants: [] }]
        };
      },
      isConversationAllowed() { return true; }
    },
    undefined,
    undefined
  );

  killStaleCdp();
  const profile = await mkdtemp(path.join(tmpdir(), "aa-polish-"));
  const chrome = spawn(CHROME, [
    "--headless=new", "--no-first-run", "--no-default-browser-check",
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    "--window-size=430,860", `http://127.0.0.1:${SITE_PORT}/?qa=1`
  ], { stdio: "ignore" });

  let app;
  try {
    await control.connect();
    let attachError;
    for (let i = 0; i < 60 && !app; i += 1) {
      try {
        const targets = await getJson("/json", { port: CDP_PORT });
        const page = targets.find((target) => target.type === "page" && (target.url || "").startsWith(`http://127.0.0.1:${SITE_PORT}`));
        if (!page) throw new Error(`no page target yet (${targets.length} targets)`);
        app = await attach({ port: CDP_PORT, title: page.title });
      } catch (error) {
        attachError = error;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    assert.ok(app, `could not attach to Chrome: ${attachError?.message ?? attachError}`);
    for (let i = 0; i < 60; i += 1) {
      const origin = await app.evaluate(`location.origin`).then((r) => r.result?.value).catch(() => undefined);
      if (origin === `http://127.0.0.1:${SITE_PORT}`) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const evaluate = async (expr) => {
      const result = await app.evaluate(expr);
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description || JSON.stringify(result.exceptionDetails));
      }
      return result.result.value;
    };
    const waitFor = async (read, predicate, description, attempts = 40) => {
      let value;
      for (let i = 0; i < attempts; i += 1) {
        value = await read();
        if (predicate(value)) return value;
        await new Promise((r) => setTimeout(r, 250));
      }
      assert.fail(`${description}: ${JSON.stringify(value)}`);
    };

    // The icon number is observed through a stand-in installed before the app
    // runs: headless Chrome has no home screen.
    await app.send("Page.enable");
    await app.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `window.__badge = []; navigator.setAppBadge = (n) => { window.__badge.push(n); return Promise.resolve(); }; navigator.clearAppBadge = () => { window.__badge.push(0); return Promise.resolve(); };`
    });
    await evaluate(`(() => {
      localStorage.setItem("accordagents.mobile.pairing.v1", JSON.stringify({
        endpoint: "http://127.0.0.1:${SITE_PORT}/",
        outboxUrl: "http://127.0.0.1:${SITE_PORT}/v1/mailbox/events",
        relayUrl: "${relayAddress.url}",
        rendezvousId: "${RENDEZVOUS}",
        fingerprint: "PAIRING-FINGERPRINT",
        routingId: "route-polish",
        streamId: "route-polish:phone",
        relaySealKeyBase64: "${SEAL_KEY}",
        pairedAt: new Date(0).toISOString()
      }));
      localStorage.removeItem("accordagents.mobile.activeConversationId.v1");
      return true;
    })()`);
    await evaluate(`navigator.serviceWorker.ready.then(() => true)`);
    await app.send("Page.reload", {});
    await new Promise((r) => setTimeout(r, 4000));

    // --- the list, and searching it --------------------------------------
    const rowTitles = async () => await evaluate(`(() => [...document.querySelectorAll("#chat-list .mobile-chat-row strong")].map((n) => n.textContent))()`);
    await waitFor(rowTitles, (titles) => titles.length === 3, "the three chats from the desktop are listed");
    assert.ok(!(await evaluate(`(() => Boolean(document.querySelector('[aria-label="New chat"]')))()`)), "the phone offers no new-chat button: it cannot create one");
    await evaluate(`(() => { document.getElementById("chat-search-toggle").click(); return true; })()`);
    assert.equal(await evaluate(`(() => document.getElementById("chat-search").hidden)()`), false, "the search box opens");
    await evaluate(`(() => { const i = document.getElementById("chat-search-input"); i.value = "BETA"; i.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
    assert.deepEqual(await rowTitles(), ["Beta bugs"], "search filters by title, case-insensitively");
    await evaluate(`(() => { const i = document.getElementById("chat-search-input"); i.value = "gera"; i.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
    assert.deepEqual(await rowTitles(), ["Gamma notes"], "search also matches who wrote last");
    await evaluate(`(() => { const i = document.getElementById("chat-search-input"); i.value = "zzz"; i.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
    assert.match(await evaluate(`(() => document.getElementById("chat-list").textContent)()`), /No chats match/, "an empty result says so instead of showing the sync wait");
    await evaluate(`(() => { document.getElementById("chat-search-close").click(); return true; })()`);
    assert.equal((await rowTitles()).length, 3, "cancel restores the whole list");

    // --- unread: news in a chat that is not on screen ----------------------
    await postEnvelope(CHAT_B, "mobile.timeline.events", {
      type: "mobile.timeline.events", conversationId: CHAT_B,
      events: [doneRow("b-001", 20, "participant", "Fixed the crash for real.")]
    });
    const unreadRows = async () => await evaluate(`(() => [...document.querySelectorAll('#chat-list .mobile-chat-row[data-unread="1"]')].map((n) => n.dataset.conversationId))()`);
    await waitFor(unreadRows, (ids) => ids.length === 1 && ids[0] === CHAT_B, "a reply landing in a chat that is not open marks it unread");
    assert.equal(await evaluate(`(() => document.querySelectorAll('#chat-list .mobile-chat-row[data-conversation-id="${CHAT_B}"] .mobile-unread-dot').length)()`), 1, "the row shows the dot");
    await waitFor(() => evaluate(`(() => window.__badge.at(-1))()`), (n) => n === 1, "the icon number is the count of unread chats");
    await evaluate(`(() => { document.querySelector('#chat-list .mobile-chat-row[data-conversation-id="${CHAT_B}"]').click(); return true; })()`);
    await waitFor(() => evaluate(`(() => document.getElementById("timeline-screen").classList.contains("is-active"))()`), Boolean, "the chat opens");
    await waitFor(() => evaluate(`(() => JSON.parse(localStorage.getItem("accordagents.mobile.unreadConversationIds.v1") || "[]"))()`), (ids) => ids.length === 0, "opening the chat reads it");
    await waitFor(() => evaluate(`(() => window.__badge.at(-1))()`), (n) => n === 0, "and clears the icon number");
    await evaluate(`(() => { document.getElementById("back-to-chats").click(); return true; })()`);
    await waitFor(unreadRows, (ids) => ids.length === 0, "the dot is gone from the list");

    // --- a chat with history: times, the members sheet, earlier messages ----
    await evaluate(`(() => { document.querySelector('#chat-list .mobile-chat-row[data-conversation-id="${CHAT_A}"]').click(); return true; })()`);
    const rows = async () => await evaluate(`(() => [...document.querySelectorAll("#message-list .message-row")].map((n) => ({ status: n.dataset.status, label: (n.querySelector(".message-status") || {}).textContent, text: (n.querySelector(".message-content") || {}).textContent })))()`);
    await waitFor(rows, (list) => list.length === 2, "the latest page arrives over the relay");
    const latest = await rows();
    assert.equal(latest[0].status, "Done");
    assert.match(latest[0].label, /^\d{2}:\d{2}$/, "a finished message shows the time it was written, not the word Done");
    assert.match(latest[1].label, /^\d{2}:\d{2}$/, "for the member's row too");
    assert.equal(await evaluate(`(() => document.getElementById("load-earlier").hidden)()`), false, "the desktop said there is more before this page, so the phone offers it");

    await evaluate(`(() => { document.getElementById("chat-members-toggle").click(); return true; })()`);
    assert.equal(await evaluate(`(() => document.getElementById("members-sheet").hidden)()`), false, "tapping the title opens the members");
    const members = await evaluate(`(() => [...document.querySelectorAll("#members-sheet-list .members-sheet-row")].map((n) => ({ name: n.querySelector("strong").textContent, role: n.querySelector(".members-sheet-role").textContent, where: n.querySelector(".members-sheet-location").textContent })))()`);
    assert.deepEqual(members, [
      { name: "@drew", role: "Software Engineer · Codex CLI", where: "Local · desktop" },
      { name: "@taylor", role: "Reviewer · Claude Code", where: "Office Mac" }
    ], "each member shows role, tool and where it runs");
    assert.equal(await evaluate(`(() => document.getElementById("members-sheet-title").textContent)()`), "2 members");
    await evaluate(`(() => { document.getElementById("members-sheet-close").click(); return true; })()`);
    assert.equal(await evaluate(`(() => document.getElementById("members-sheet").hidden)()`), true);

    await evaluate(`(() => { document.getElementById("load-earlier").click(); return true; })()`);
    await waitFor(rows, (list) => list.length === 4, "the earlier page is added");
    assert.deepEqual((await rows()).map((row) => row.text), ["Two earlier.", "One earlier.", "Latest question?", "Latest answer, with a picture."], "earlier rows go above, in order");
    assert.deepEqual(calls.timeline.filter((call) => call.conversationId === CHAT_A).map((call) => call.beforeMessageId), [undefined, "a-010"], "the desktop was asked for the page before the oldest message it had given");
    assert.equal(await evaluate(`(() => document.getElementById("load-earlier").hidden)()`), true, "nothing earlier remains, so the offer goes away");

    // The latest page asked again — a pull, a reopen, a return to the
    // foreground — names a-010 as the page below it and says there is more.
    // The phone already holds a-008: "earlier" must not move forward to a
    // page it has, or the next taps would re-fetch rows on screen and show
    // nothing.
    await evaluate(`window.AccordAgentsMobile.refreshOpenTimeline().then(() => true)`);
    assert.deepEqual(calls.timeline.at(-1), { conversationId: CHAT_A, beforeMessageId: undefined }, "the refresh asked for the latest page");
    assert.deepEqual(await evaluate(`window.AccordAgentsMobile.timelinePageFor("${CHAT_A}")`), { hasMoreBefore: false, beforeMessageId: "a-008" }, "the cursor stays where the earlier pages left it");
    assert.equal(await evaluate(`(() => document.getElementById("load-earlier").hidden)()`), true, "and the offer stays away: this phone holds everything the desktop has");

    // --- a picture, opened at full size ----------------------------------
    await waitFor(() => evaluate(`(() => document.querySelector('#message-list .message-image')?.dataset.state)()`), (state) => state === "ready", "the picture's bytes arrive by id");
    await evaluate(`(() => { document.querySelector('#message-list .message-image').click(); return true; })()`);
    assert.equal(await evaluate(`(() => document.getElementById("image-viewer").hidden)()`), false, "tapping the picture opens it");
    assert.match(await evaluate(`(() => document.getElementById("image-viewer-image").src)()`), /^data:image\/png/, "at full size, from the bytes already held");
    await evaluate(`(() => { document.getElementById("image-viewer-close").click(); return true; })()`);
    assert.equal(await evaluate(`(() => document.getElementById("image-viewer").hidden)()`), true, "and closes");

    // --- the "/" menu -----------------------------------------------------
    await evaluate(`(() => { const i = document.getElementById("composer-input"); i.focus(); i.value = "@drew /"; i.setSelectionRange(7, 7); i.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
    const slashOptions = async () => await evaluate(`(() => [...document.querySelectorAll("#slash-menu .mobile-slash-option")].map((n) => n.dataset.slashKind + ":" + n.querySelector("strong").textContent))()`);
    await waitFor(slashOptions, (list) => list.length === 3, "the desktop's list appears under the draft");
    assert.deepEqual(await slashOptions(), ["command:/compact", "prompt:/standup", "skill:/review"], "commands, then saved prompts, then skills, as the desktop orders them");
    assert.deepEqual(calls.composer.at(-1), { conversationId: CHAT_A, query: "", content: "@drew /" }, "the desktop is asked with the draft so far");
    await evaluate(`(() => { document.querySelector('#slash-menu .mobile-slash-option[data-slash-kind="skill"]').click(); return true; })()`);
    assert.equal(await evaluate(`(() => document.getElementById("composer-input").value)()`), "@drew /review ", "picking a skill writes its token");
    assert.equal(await evaluate(`(() => document.getElementById("slash-menu").hidden)()`), true);
    await evaluate(`(() => { const i = document.getElementById("composer-input"); i.value = "@drew /review the diff"; i.dispatchEvent(new Event("input", { bubbles: true })); document.getElementById("composer-form").requestSubmit(); return true; })()`);
    await waitFor(() => sent.length, (n) => n === 1, "the message reaches the desktop");
    assert.equal(sent[0].content, "@drew /review the diff");
    assert.equal(sent[0].skillMentions?.[0]?.skillId, "skill-review", "carrying the picked skill, as the desktop composer would");

    // --- pull to refresh ---------------------------------------------------
    const timelineAsks = calls.timeline.length;
    // A pull only counts from the very top of the list; anywhere else is a scroll.
    const surfaceBox = await evaluate(`(() => { const s = document.querySelector(".thread-surface"); s.scrollTop = 0; const r = s.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 20, scrollTop: s.scrollTop }; })()`);
    assert.equal(surfaceBox.scrollTop, 0);
    await app.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    await app.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: surfaceBox.x, y: surfaceBox.y }] });
    for (let step = 1; step <= 6; step += 1) {
      await app.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: surfaceBox.x, y: surfaceBox.y + step * 30 }] });
    }
    assert.equal(await evaluate(`(() => document.getElementById("timeline-refresh").classList.contains("is-armed"))()`), true, "a long enough pull arms the refresh");
    await app.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await app.send("Emulation.setTouchEmulationEnabled", { enabled: false, maxTouchPoints: 1 });
    await waitFor(() => calls.timeline.length, (n) => n > timelineAsks, "letting go asks the desktop for the timeline again");
    await waitFor(() => evaluate(`(() => document.getElementById("timeline-refresh").classList.contains("is-refreshing"))()`), (busy) => busy === false, "the spinner stops when the answer is in");

    // --- coming back to the foreground -------------------------------------
    const chatListAsks = calls.listChats;
    await evaluate(`(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => window.__hidden === true });
      window.__hidden = true;
      document.dispatchEvent(new Event("visibilitychange"));
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 5500));
    await evaluate(`(() => { window.__hidden = false; document.dispatchEvent(new Event("visibilitychange")); return true; })()`);
    await waitFor(() => calls.listChats, (n) => n > chatListAsks, "returning asks the desktop again at once, instead of waiting for a timer");
    const resync = await waitFor(() => evaluate(`(() => (window.__relayDebug || []).filter((e) => e.event === "foreground-resync").at(-1))()`), Boolean, "the resync is recorded");
    assert.ok(resync.awayMs >= 5000, "after a real absence, which is when the socket is replaced");
    await waitFor(() => evaluate(`(() => document.getElementById("connection-state").textContent)()`), (text) => text === "Synced", "and the chat is synced again");

    // --- an open still in flight when the resync drops the socket ----------
    // The keep-alive or a request can be dialling at the moment the foreground
    // resync closes the frozen socket and dials again. The relay seats the
    // newer connection and dismisses the older; the superseded open must
    // neither seat itself beside the replacement nor, failing, discard the
    // replacement's state — either left the live collector on a dead socket
    // and a third dial evicting the good one. The first socket's frames are
    // delivered late so its open is still pending when the resync happens.
    await evaluate(`(() => {
      const Native = globalThis.WebSocket;
      window.__native = Native;
      window.__made = [];
      const Wrapped = function (url) {
        const socket = new Native(url);
        const index = window.__made.length;
        window.__made.push(socket);
        if (index === 0) {
          const add = socket.addEventListener.bind(socket);
          socket.addEventListener = function (type, listener, options) {
            const late = type === "message"
              ? function (event) { setTimeout(function () { listener.call(socket, event); }, 1500); }
              : listener;
            return add(type, late, options);
          };
        }
        return socket;
      };
      Wrapped.prototype = Native.prototype;
      globalThis.WebSocket = Wrapped;
      window.AccordAgentsMobile.dropRelaySocket("race: start from no socket");
      window.__first = window.AccordAgentsMobile.refreshOpenTimeline();
      return true;
    })()`);
    await waitFor(() => evaluate(`window.__made.length`), (n) => n === 1, "the first open is in flight");
    await evaluate(`(() => {
      window.AccordAgentsMobile.dropRelaySocket("race: foreground resync");
      window.__second = window.AccordAgentsMobile.refreshChatList();
      return true;
    })()`);
    await waitFor(() => evaluate(`window.__made.length`), (n) => n >= 2, "the resync dialled again while the first open was still in flight");
    await evaluate(`Promise.all([window.__first, window.__second]).then(() => true)`);
    await new Promise((r) => setTimeout(r, 750));
    assert.equal(await evaluate(`window.__made.length`), 2, "no third dial: the superseded open did not discard the replacement");
    await waitFor(
      () => evaluate(`window.__made.map((socket) => socket.readyState)`),
      (states) => states[0] !== 1 && states.filter((state) => state === 1).length === 1,
      "the superseded first socket is closed and exactly one socket stays open"
    );
    await waitFor(() => evaluate(`(() => document.getElementById("connection-state").textContent)()`), (text) => text === "Synced", "the request that was waiting on the superseded open finished on the replacement");
    control.pushConversationSnapshot({
      id: CHAT_A, kind: "chat", title: "Alpha planning", createdAt: at(0), updatedAt: at(21),
      messages: [{ id: "a-021", role: "participant", participantLabel: "@drew", content: "After the race.", status: "done", createdAt: at(21) }],
      findings: [], metadata: { activeRunIds: [] }
    });
    await waitFor(rows, (list) => list.some((row) => row.text === "After the race."), "a live batch after the race arrives: the collector sits on the socket that stayed");
    await evaluate(`(() => { globalThis.WebSocket = window.__native; return true; })()`);

    // --- an earlier page that arrives late, through the socket collector ------
    // The request's own wait can end before a slow answer lands. The answer
    // still carries its cursor and says it is history: the cursor is saved
    // where the rows land, and history never marks a chat unread.
    await evaluate(`(() => { document.getElementById("back-to-chats").click(); return true; })()`);
    await waitFor(() => evaluate(`(() => document.getElementById("chats-screen").classList.contains("is-active"))()`), Boolean, "back on the list");
    await evaluate(`window.AccordAgentsMobile.handleRelayTimelinePayload({
      type: "mobile.timeline.events",
      conversationId: "${CHAT_A}",
      events: [{ id: "a-007", messageId: "a-007", role: "participant", participantLabel: "@drew", content: "Three earlier.", status: "done", createdAt: "${at(7)}" }],
      page: { hasMoreBefore: true, beforeMessageId: "a-007", earlier: true }
    }, "${CHAT_A}")`);
    assert.deepEqual(await evaluate(`window.AccordAgentsMobile.timelinePageFor("${CHAT_A}")`), { hasMoreBefore: true, beforeMessageId: "a-007" }, "a late answer still moves the cursor");
    assert.deepEqual(await evaluate(`JSON.parse(localStorage.getItem("accordagents.mobile.unreadConversationIds.v1") || "[]")`), [], "history filled in behind the reader is not news");
    await evaluate(`(() => { document.querySelector('#chat-list .mobile-chat-row[data-conversation-id="${CHAT_A}"]').click(); return true; })()`);
    await waitFor(rows, (list) => list[0]?.text === "Three earlier.", "the late page's row is shown, above the rest");
    assert.equal(await evaluate(`(() => document.getElementById("load-earlier").hidden)()`), false, "and the offer is back because the desktop said there is more");

    // --- what a push says, built from plaintext arrivals and the mirrors ----
    const described = await evaluate(`new Promise((resolve) => {
      navigator.serviceWorker.addEventListener("message", function once(event) {
        if (event.data && event.data.type === "accord-test-describe-done") {
          navigator.serviceWorker.removeEventListener("message", once);
          resolve(event.data.notifications);
        }
      });
      navigator.serviceWorker.ready.then((registration) => registration.active.postMessage({
        type: "accord-test-describe",
        arrivals: [
          { conversationId: "${CHAT_B}", kind: "mobile.timeline.events" },
          { conversationId: "${CHAT_B}", kind: "mobile.notice.reply" },
          { conversationId: "${CHAT_C}", kind: "mobile.notice.approval" },
          { conversationId: "conv-unknown", kind: "mobile.notice.reply" },
          { conversationId: "${CHAT_A}", kind: "mobile.notice.reply" }
        ]
      }));
    })`);
    assert.deepEqual(described, [
      { conversationId: CHAT_B, body: "New message in Beta bugs" },
      { conversationId: CHAT_C, body: "Approval needed in Gamma notes" },
      { conversationId: CHAT_A, body: "New message in Alpha planning" }
    ], "each named chat gets its own line from the phone's own memory; an unknown chat gets nothing and message text never appears");
    // The page is showing Alpha right now. The worker counted it too — it
    // cannot know — so the page folds the count back at once: the icon says
    // three for the chats not on screen, not four, and the mirror the next
    // push builds on no longer names Alpha. Before, Alpha stayed on the icon
    // until the app was next brought back to the foreground.
    await waitFor(
      () => evaluate(`JSON.parse(localStorage.getItem("accordagents.mobile.unreadConversationIds.v1") || "[]")`),
      (ids) => ids.length === 3 && !ids.includes(CHAT_A),
      "the page adopts the worker's count for the chats it is not showing"
    );
    await waitFor(() => evaluate(`(() => window.__badge.at(-1))()`), (n) => n === 3, "the icon number is the three chats not on screen");
    const mirrored = await evaluate(`new Promise((resolve, reject) => {
      const open = self.AccordMobileDb.openControlDb(indexedDB);
      open.then((db) => {
        const request = db.transaction("meta").objectStore("meta").get("unreadConversations");
        request.onsuccess = () => { db.close(); resolve(request.result ? request.result.ids : []); };
        request.onerror = () => { db.close(); reject(request.error); };
      }).catch(reject);
    })`);
    assert.deepEqual([...mirrored].sort(), [CHAT_B, CHAT_C, "conv-unknown"].sort(), "the worker counted every chat that moved, known or not, and the page took the one on screen back out");
  } finally {
    app?.close();
    control.close();
    chrome.kill("SIGKILL");
    killStaleCdp();
    site.close();
    mailboxServer.close();
    await relay.close();
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
});

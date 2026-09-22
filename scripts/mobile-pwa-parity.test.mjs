// Desktop parity on the phone, driven through the real shell in Chrome against
// the real MobileRelayControlService over the reference relay and mailbox:
// members show the avatar the desktop resolves for them (catalog id and
// provider, a drawn avatar fetched by id, the app mark for the assistant, the
// provider glyph for an author with no record); internal system rows the
// desktop never showed are dropped from what the phone stored before the
// desktop stopped sending them; and the projects in the chat list fold away.
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
const SITE_PORT = 8207;
const MAILBOX_PORT = 8208;
const CDP_PORT = 9378;
const CHROME = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const RENDEZVOUS = "rv-parity";
const CHAT_A = "conv-parity-alpha";
const CHAT_B = "conv-parity-beta";
const CHAT_C = "conv-parity-gamma";

const SEAL_KEY = randomBytes(32).toString("base64url");
const sealKeyBuffer = Buffer.from(SEAL_KEY, "base64url");
const MAILBOX_TOKEN = createHmac("sha256", sealKeyBuffer).update("accord-mailbox-auth-v1", "utf8").digest("base64url");
const MAILBOX_ID = "mb-" + createHmac("sha256", sealKeyBuffer).update("accord-mailbox-scope-v1", "utf8").digest("base64url").slice(0, 32);
// A 1x1 PNG: the drawn avatar's bytes.
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
  ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json"
};

const killStaleCdp = () => {
  try {
    execSync(`lsof -ti tcp:${CDP_PORT} -sTCP:LISTEN | xargs kill -9`, { stdio: "ignore" });
  } catch {
    // nothing listening
  }
};

const at = (minute) => new Date(Date.UTC(2026, 8, 18, 12, minute)).toISOString();
const row = (id, minute, role, participantLabel, content, extra = {}) => ({
  id, messageId: id, role, ...(participantLabel ? { participantLabel } : {}), content, status: "done", createdAt: at(minute), ...extra
});

test("PWA parity: avatars resolve like the desktop, internal system rows are gone, projects fold", async () => {
  const { MobileRelayControlService } = await import(path.join(repoRoot, "dist/main/main/services/mobileRelayControl.js"));
  const { CHAT_AVATAR_CATALOG, defaultChatAvatarId } = await import(path.join(repoRoot, "dist/main/shared/chatAvatarCatalog.js"));

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
          eventId: `parity-${mailboxSeq}`, conversationId, logScopeId: conversationId,
          originId: "desktop-origin", originSeq: mailboxSeq, eventHash: `hash-${mailboxSeq}`,
          kind, payload: sealPayload(payload)
        }]
      })
    });
    const ack = await res.json();
    assert.ok(res.ok && ack.appendedEventIds.length === 1, `mailbox did not append: ${JSON.stringify(ack)}`);
  };

  // The members as the desktop lists them: one with a chosen photo, one with
  // the provider logo, one with nothing chosen (hashed default from its id),
  // one drawn in the studio, and the chat assistant.
  const members = [
    { id: "p-drew", handle: "drew", mentionHandle: "drew", displayName: "@drew", roleLabel: "Software Engineer", kind: "codex-cli", avatarId: "codex-cat" },
    { id: "p-taylor", handle: "taylor", mentionHandle: "taylor", displayName: "@taylor", roleLabel: "Reviewer", kind: "claude-code", avatarId: "claude-logo" },
    { id: "p-morgan", handle: "morgan", mentionHandle: "morgan", displayName: "@morgan", roleLabel: "Designer", kind: "claude-code" },
    { id: "p-gera", handle: "gera", mentionHandle: "gera", displayName: "@gera", roleLabel: "Strategist", kind: "codex-cli", avatarId: "custom:drawn-1" },
    { id: "p-admin", handle: "admin", mentionHandle: "assistant", displayName: "Chat Assistant", roleLabel: "Chat Assistant", kind: "codex-cli", isAssistant: true }
  ];
  const morganDefault = defaultChatAvatarId("claude-code", "p-morgan");
  assert.ok(CHAT_AVATAR_CATALOG.some((entry) => entry.id === morganDefault && entry.mediaMode === "photo"), "the hashed default is a catalog photo");
  const chats = [
    { id: CHAT_A, title: "Alpha planning", group: "AccordAgents", snippet: "Let us plan.", who: "drew:", updatedAt: at(1), running: false, participants: ["@drew", "@taylor"], members },
    { id: CHAT_B, title: "Beta bugs", group: "AccordAgents", snippet: "Fixed.", who: "you:", updatedAt: at(2), running: false, participants: ["@admin", "@morgan"], members },
    // An older desktop's list: handles only, no member records, no avatar ids.
    { id: CHAT_C, title: "Gamma notes", group: "Other project", snippet: "Notes.", who: "kim:", updatedAt: at(3), running: false, participants: ["@kim"], members: [] }
  ];
  const avatarReads = [];
  const control = new MobileRelayControlService(
    {
      relayUrl: relayAddress.url, rendezvousId: RENDEZVOUS, relayCapability: "PAIRING-FINGERPRINT",
      relaySealKeyBase64: SEAL_KEY, streamId: "route-parity:phone", reconnectDelayMs: 50
    },
    {
      async sendMessage(request) {
        return { conversation: { id: request.conversationId, kind: "chat", title: "t", createdAt: at(0), updatedAt: at(0), messages: [], findings: [], metadata: {} } };
      }
    },
    {
      async listChats() { return chats; },
      async listTimeline() { return []; },
      async listTimelinePage(conversationId) {
        if (conversationId !== CHAT_A) return { events: [], hasMoreBefore: false };
        return {
          events: [
            row("a-001", 10, "you", undefined, "Who is here?"),
            row("a-002", 11, "participant", "@drew", "Drew, with a cat."),
            row("a-003", 12, "participant", "@taylor", "Taylor, with the logo."),
            row("a-004", 13, "participant", "@morgan", "Morgan, with the default."),
            row("a-005", 14, "participant", "@gera", "Gera, drawn in the studio."),
            row("a-006", 15, "participant", "Chat Assistant", "The assistant."),
            row("a-007", 16, "participant", "@claude-reviewer", "Not a member of this chat.")
          ],
          hasMoreBefore: false, beforeMessageId: "a-001"
        };
      },
      async readMemberAvatar(request) {
        avatarReads.push(request);
        return request.avatarId === "custom:drawn-1" ? { mediaType: "image/png", dataBase64: PNG_1X1 } : undefined;
      },
      isConversationAllowed() { return true; }
    },
    undefined,
    undefined
  );

  killStaleCdp();
  const profile = await mkdtemp(path.join(tmpdir(), "aa-parity-"));
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
    const settle = () => new Promise((r) => setTimeout(r, 4000));

    await app.send("Page.enable");
    await evaluate(`(() => {
      localStorage.setItem("accordagents.mobile.pairing.v1", JSON.stringify({
        endpoint: "http://127.0.0.1:${SITE_PORT}/",
        outboxUrl: "http://127.0.0.1:${SITE_PORT}/v1/mailbox/events",
        relayUrl: "${relayAddress.url}",
        rendezvousId: "${RENDEZVOUS}",
        fingerprint: "PAIRING-FINGERPRINT",
        routingId: "route-parity",
        streamId: "route-parity:phone",
        relaySealKeyBase64: "${SEAL_KEY}",
        pairedAt: new Date(0).toISOString()
      }));
      localStorage.removeItem("accordagents.mobile.activeConversationId.v1");
      return true;
    })()`);
    await evaluate(`navigator.serviceWorker.ready.then(() => true)`);
    await app.send("Page.reload", {});
    await settle();

    // The shared rules really are on the page: the same module the desktop
    // ships, not a copy.
    assert.equal(await evaluate(`typeof globalThis.AccordMobileShared.resolveChatParticipantAvatar`), "function");

    // --- the chat list: every row's avatars come from the member record -----
    const describeAvatar = `(node) => ({
      kind: [...node.classList].find((c) => /^avatar-(anthropic|codex|gemini|custom|generic)$/.test(c)) || null,
      media: node.querySelector(".avatar-media") ? [...node.querySelector(".avatar-media").classList].find((c) => /^avatar-media-(glyph|photo)$/.test(c)) : null,
      src: node.querySelector("img") ? node.querySelector("img").getAttribute("src") : null,
      text: node.querySelector("span.avatar-media") ? node.querySelector("span.avatar-media").textContent : null
    })`;
    const listAvatars = async () => await evaluate(`(() => {
      const describe = ${describeAvatar};
      return [...document.querySelectorAll("#chat-list .mobile-chat-row")].map((row) => ({
        id: row.dataset.conversationId,
        avatars: [...row.querySelectorAll(".mobile-chat-avatar")].map(describe)
      }));
    })()`);
    const list = await waitFor(listAvatars, (rows) => rows.length === 3 && rows.every((r) => r.avatars.length > 0), "the three chats are listed with avatars");
    const byChat = new Map(list.map((entry) => [entry.id, entry.avatars]));
    assert.deepEqual(byChat.get(CHAT_A), [
      { kind: "avatar-custom", media: "avatar-media-photo", src: "assets/avatars/codex-cat.png", text: null },
      { kind: "avatar-anthropic", media: "avatar-media-glyph", src: "assets/avatars/claude-logo.png", text: null }
    ], "a chosen photo covers the disc; the Claude logo is a glyph on the terracotta disc");
    assert.deepEqual(byChat.get(CHAT_B), [
      { kind: "avatar-custom", media: "avatar-media-glyph", src: "assets/accordagents-mark.png", text: null },
      { kind: "avatar-custom", media: "avatar-media-photo", src: `assets/avatars/${morganDefault}.png`, text: null }
    ], "the assistant shows the app mark; a member with nothing chosen shows the desktop's hashed default");
    assert.deepEqual(byChat.get(CHAT_C), [
      { kind: "avatar-generic", media: "avatar-media-glyph", src: null, text: "K" }
    ], "a member known only by handle shows initials, never a guessed animal");
    // The pictures themselves are served, not just named.
    for (const src of ["assets/avatars/codex-cat.png", "assets/avatars/claude-logo.png", `assets/avatars/${morganDefault}.png`]) {
      const response = await fetch(`http://127.0.0.1:${SITE_PORT}/${src}`);
      assert.equal(response.status, 200, `${src} is served`);
      assert.ok((await response.arrayBuffer()).byteLength > 100, `${src} has bytes`);
    }

    // --- projects fold, and stay folded across a reload --------------------
    const headers = async () => await evaluate(`(() => [...document.querySelectorAll("#chat-list .mobile-chat-group-title")].map((n) => ({
      name: n.querySelector(".mobile-chat-group-name").textContent, expanded: n.getAttribute("aria-expanded"),
      count: n.querySelector(".mobile-chat-group-count") ? n.querySelector(".mobile-chat-group-count").textContent : null,
      rows: n.nextElementSibling && n.nextElementSibling.classList.contains("mobile-chat-group") ? n.nextElementSibling.querySelectorAll(".mobile-chat-row").length : 0,
      tag: n.tagName, height: Math.round(n.getBoundingClientRect().height)
    })))()`);
    const plainHeaders = async () => (await headers()).map(({ name, expanded, count, rows }) => ({ name, expanded, count, rows }));
    assert.deepEqual(await plainHeaders(), [
      { name: "AccordAgents", expanded: "true", count: null, rows: 2 },
      { name: "Other project", expanded: "true", count: null, rows: 1 }
    ], "both projects start open");
    assert.ok((await headers()).every((header) => header.tag === "BUTTON" && header.height >= 44), "a project header is a real tap target");
    await evaluate(`(() => { document.querySelector('#chat-list .mobile-chat-group-title[data-group="AccordAgents"]').click(); return true; })()`);
    assert.deepEqual(await plainHeaders(), [
      { name: "AccordAgents", expanded: "false", count: "2", rows: 0 },
      { name: "Other project", expanded: "true", count: null, rows: 1 }
    ], "tapping a project folds it and shows how many chats it holds; the other project is now one tap away");
    await app.send("Page.reload", {});
    await settle();
    await waitFor(headers, (list) => list.length === 2, "the list is back after the reload");
    assert.deepEqual((await plainHeaders())[0], { name: "AccordAgents", expanded: "false", count: "2", rows: 0 }, "the fold survives a reload");
    await evaluate(`(() => { document.getElementById("chat-search-toggle").click(); const i = document.getElementById("chat-search-input"); i.value = "alpha"; i.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
    assert.deepEqual(await plainHeaders(), [{ name: "AccordAgents", expanded: null, count: null, rows: 1 }], "a search shows what it matches even inside a folded project, and the header is a plain label");
    assert.equal((await headers())[0].tag, "DIV");
    // A tap on the label while searching changes nothing — not even the fold
    // it does not show.
    await evaluate(`(() => { document.querySelector('#chat-list .mobile-chat-group-title[data-group="AccordAgents"]').click(); return true; })()`);
    await evaluate(`(() => { document.getElementById("chat-search-close").click(); return true; })()`);
    assert.equal((await plainHeaders())[0].expanded, "false", "closing the search restores the fold exactly as it was");
    // A reply into a folded project is not lost: its dot shows on the header.
    await postEnvelope(CHAT_B, "mobile.timeline.events", {
      type: "mobile.timeline.events", conversationId: CHAT_B,
      events: [row("b-001", 20, "participant", "@morgan", "Fixed for real.")]
    });
    await waitFor(() => evaluate(`(() => Boolean(document.querySelector('#chat-list .mobile-chat-group-title[data-group="AccordAgents"] .mobile-unread-dot')))()`), Boolean, "a folded project shows the unread dot");
    await evaluate(`(() => { document.querySelector('#chat-list .mobile-chat-group-title[data-group="AccordAgents"]').click(); return true; })()`);
    assert.equal((await headers())[0].rows, 2, "tapping again opens it");

    // --- message rows: the same resolution, and a drawn avatar's bytes -----
    await evaluate(`(() => { document.querySelector('#chat-list .mobile-chat-row[data-conversation-id="${CHAT_A}"]').click(); return true; })()`);
    const rowAvatars = async () => await evaluate(`(() => {
      const describe = ${describeAvatar};
      return [...document.querySelectorAll("#message-list .message-row")].filter((n) => n.querySelector(".message-avatar")).map((n) => ({
        handle: n.querySelector(".message-handle").textContent, ...describe(n.querySelector(".message-avatar"))
      }));
    })()`);
    await waitFor(rowAvatars, (rows) => rows.length === 6, "the members' rows arrive");
    const drawnLoaded = await waitFor(rowAvatars, (rows) => rows.some((r) => r.handle === "@gera" && r.src && r.src.startsWith("data:image/png;base64,")), "the drawn avatar's bytes arrive over the relay and replace the initials");
    assert.deepEqual(drawnLoaded.map(({ handle, kind, media, src, text }) => ({ handle, kind, media, src: src && src.startsWith("data:") ? "data:" : src, text })), [
      { handle: "@drew", kind: "avatar-custom", media: "avatar-media-photo", src: "assets/avatars/codex-cat.png", text: null },
      { handle: "@taylor", kind: "avatar-anthropic", media: "avatar-media-glyph", src: "assets/avatars/claude-logo.png", text: null },
      { handle: "@morgan", kind: "avatar-custom", media: "avatar-media-photo", src: `assets/avatars/${morganDefault}.png`, text: null },
      { handle: "@gera", kind: "avatar-custom", media: "avatar-media-photo", src: "data:", text: null },
      { handle: "Chat Assistant", kind: "avatar-custom", media: "avatar-media-glyph", src: "assets/accordagents-mark.png", text: null },
      { handle: "@claude-reviewer", kind: "avatar-anthropic", media: "avatar-media-glyph", src: "assets/avatars/claude-logo.png", text: null }
    ], "each row shows what the desktop shows; an author with no member record gets the provider glyph its name suggests");
    assert.deepEqual(avatarReads, [{ conversationId: CHAT_A, avatarId: "custom:drawn-1" }], "the drawn avatar was asked for once, scoped to its chat");

    // The members sheet and the "@" menu use the same pictures.
    await evaluate(`(() => { document.getElementById("chat-members-toggle").click(); return true; })()`);
    const sheet = await evaluate(`(() => { const describe = ${describeAvatar}; return [...document.querySelectorAll("#members-sheet-list .members-sheet-row .mobile-mention-avatar")].map(describe); })()`);
    assert.deepEqual(sheet.map((a) => a.kind), ["avatar-custom", "avatar-anthropic", "avatar-custom", "avatar-custom", "avatar-custom"]);
    assert.ok(sheet[3].src.startsWith("data:image/png;base64,"), "the drawn avatar is cached for the session, not fetched again");
    assert.equal(avatarReads.length, 1);
    await evaluate(`(() => { document.getElementById("members-sheet-close").click(); return true; })()`);

    // --- a thread has one way back, and it leads to the chat ----------------
    // Judged by what is painted, not by the attribute: the [hidden] rule is
    // what removes the button, and losing it must fail here.
    const visibleBacks = async () => await evaluate(`(() => [...document.querySelectorAll("#timeline-screen .mobile-chat-header .mobile-icon-button")].filter((n) => n.getClientRects().length > 0).map((n) => n.id))()`);
    assert.deepEqual(await visibleBacks(), ["back-to-chats"], "a chat shows one arrow, to the list");
    await evaluate(`(() => { sessionStorage.setItem("accordagents.mobile.openThreadRootId.v1", "a-001"); return true; })()`);
    await postEnvelope(CHAT_A, "mobile.timeline.events", {
      type: "mobile.timeline.events", conversationId: CHAT_A,
      events: [row("a-001-reply", 20, "participant", "@drew", "In the thread.", { threadRootId: "a-001" })]
    });
    await waitFor(() => evaluate(`(() => document.getElementById("chat-title").textContent)()`), (text) => text === "Thread", "the thread opens");
    assert.deepEqual(await visibleBacks(), ["back-to-timeline"], "a thread shows one arrow, to the chat — not two");

    await evaluate(`(() => { document.getElementById("back-to-timeline").click(); return true; })()`);
    await waitFor(visibleBacks, (ids) => ids.length === 1 && ids[0] === "back-to-chats", "leaving the thread brings the list arrow back");
    assert.ok(await evaluate(`(() => document.getElementById("timeline-screen").classList.contains("is-active"))()`), "and stays in the chat");

    // --- a run whose last message the desktop hides still ends on the phone
    await postEnvelope(CHAT_A, "mobile.timeline.events", {
      type: "mobile.timeline.events", conversationId: CHAT_A,
      events: [{ id: "run-9-live", messageId: "run-9-live", role: "participant", participantLabel: "@drew", content: "@drew is running...", status: "pending", createdAt: at(30), runId: "run-9" }]
    });
    // The phone renders a pending row as an animated "Thinking"; it is
    // identified by its status.
    const pendingRows = async () => await evaluate(`(() => [...document.querySelectorAll('#message-list .message-row[data-status="Running"]')].map((n) => n.dataset.rowKey))()`);
    await waitFor(pendingRows, (rows) => rows.length === 1, "the member's live row is shown");
    await postEnvelope(CHAT_A, "mobile.timeline.events", {
      type: "mobile.timeline.events", conversationId: CHAT_A,
      events: [{ id: "run-9-end", messageId: "run-9-end", role: "participant", participantLabel: "@drew", content: "Awaiting user approval.", status: "done", createdAt: at(31), runId: "run-9", hidden: true }]
    });
    await waitFor(pendingRows, (rows) => rows.length === 0, "a hidden terminal settles the live row");
    assert.ok(!(await evaluate(`(() => [...document.querySelectorAll("#message-list .message-content")].some((n) => n.textContent.includes("Awaiting user approval")))()`)), "and stores no bubble for it");

    // --- internal system rows stored before the desktop stopped sending them
    // are dropped once; the phone's own machine notes stay ------------------
    await postEnvelope(CHAT_A, "mobile.timeline.events", {
      type: "mobile.timeline.events", conversationId: CHAT_A,
      events: [
        row("auto-resume-1", 17, "system", undefined, "Auto-resumed @taylor after member request.\nTarget replies/errors are in the transcript above."),
        row("machine-warning:run-9:0", 18, "system", undefined, "The machine restarted this run.")
      ]
    });
    const systemRows = async () => await evaluate(`(() => [...document.querySelectorAll('#message-list .message-row[data-author="system"] .message-content')].map((n) => n.textContent.slice(0, 20)))()`);
    await waitFor(systemRows, (rows) => rows.length === 2, "an older desktop's system rows are stored as bubbles");
    await evaluate(`(() => { localStorage.removeItem("accordagents.mobile.internalSystemRowsDropped.v1"); return true; })()`);
    await app.send("Page.reload", {});
    await settle();
    await waitFor(rowAvatars, (rows) => rows.length === 6, "the chat is back after the reload");
    assert.deepEqual(await systemRows(), ["The machine restarte"], "the desktop's internal trigger is gone; the phone's own machine note stays");
    assert.equal(await evaluate(`localStorage.getItem("accordagents.mobile.internalSystemRowsDropped.v1")`), "1", "the sweep runs once");

    // --- a thread can be started from the phone -----------------------------
    // Reading a thread is no use if one can only be begun from the desktop.
    await evaluate(`(() => { sessionStorage.removeItem("accordagents.mobile.openThreadRootId.v1"); return true; })()`);
    await evaluate(`(() => { document.getElementById("back-to-timeline")?.click(); return true; })()`);
    await waitFor(
      () => evaluate(`(() => [...document.querySelectorAll("#message-list .thread-chip-start")].length)()`),
      (count) => count > 0,
      "a message with no replies offers to start a thread"
    );
    const startedRoot = await evaluate(`(() => {
      const chip = document.querySelector("#message-list .thread-chip-start");
      const root = chip.dataset.threadRoot;
      chip.click();
      return root;
    })()`);
    await waitFor(
      () => evaluate(`(() => sessionStorage.getItem("accordagents.mobile.openThreadRootId.v1"))()`),
      (root) => root === startedRoot,
      "tapping it opens that message's thread"
    );
    await waitFor(() => evaluate(`(() => document.getElementById("chat-title").textContent)()`), (text) => text === "Thread", "and the screen says so");
    await evaluate(`(() => { document.getElementById("back-to-timeline").click(); return true; })()`);

    // --- a message written in a thread is sent to that thread ---------------
    // Last, because it queues a message: without the thread it was written in
    // the desktop put it in the main timeline, and the User -- still looking
    // at the thread she wrote in -- could not see her own message at all.
    await evaluate(`(() => { sessionStorage.setItem("accordagents.mobile.openThreadRootId.v1", "a-001"); return true; })()`);
    await postEnvelope(CHAT_A, "mobile.timeline.events", {
      type: "mobile.timeline.events", conversationId: CHAT_A,
      events: [row("a-001-reply-2", 24, "participant", "@drew", "Still in the thread.", { threadRootId: "a-001" })]
    });
    await waitFor(() => evaluate(`(() => document.getElementById("chat-title").textContent)()`), (text) => text === "Thread", "the thread is open again");
    await evaluate(`(() => {
      const input = document.getElementById("composer-input");
      input.value = "written inside the thread";
      document.getElementById("composer-form").dispatchEvent(new Event("submit", { cancelable: true }));
      return true;
    })()`);
    const queuedInThread = await waitFor(
      () => evaluate(`(async () => {
        const queued = await AccordAgentsMobile.listOutboxEntries();
        const mine = queued.filter((entry) => (entry.payload && entry.payload.content) === "written inside the thread");
        return mine.length > 0 ? JSON.stringify(mine[0].payload) : null;
      })()`),
      (value) => Boolean(value),
      "the message written in the thread is queued"
    );
    assert.equal(JSON.parse(queuedInThread).threadRootId, "a-001", "a message written in a thread carries that thread");
    await waitFor(
      () => evaluate(`(() => document.getElementById("message-list").textContent.includes("written inside the thread"))()`),
      (shown) => shown === true,
      "and it is on screen in the thread it was written in"
    );
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

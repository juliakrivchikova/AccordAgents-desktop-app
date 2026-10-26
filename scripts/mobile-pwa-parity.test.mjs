// Desktop parity on the phone, driven through the real shell in Chrome
// paired with a real hub (the User's own server), which holds the chats the
// desktop published: members show the avatar the desktop resolves for them
// (catalog id and provider, a drawn avatar fetched by id from the server, the
// app mark for the assistant, the provider glyph for an author with no
// record); internal system rows the desktop never showed are dropped from
// what the phone stored before the desktop stopped sending them; and the
// projects in the chat list fold away.
import assert from "node:assert/strict";
import test from "node:test";
import { rm } from "node:fs/promises";
import path from "node:path";
import { attachApp, launchChrome, pairPage, serveMobileShell, startMobileHub, tempProfile } from "./mobile-hub-fixture.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const SITE_PORT = 8207;
const CDP_PORT = 9378;
const CHAT_A = "conv-parity-alpha";
const CHAT_B = "conv-parity-beta";
const CHAT_C = "conv-parity-gamma";
// A 1x1 PNG: the drawn avatar's bytes.
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const at = (minute) => new Date(Date.UTC(2026, 8, 18, 12, minute)).toISOString();
// A row as an older desktop sent it straight to the phone.
const row = (id, minute, role, participantLabel, content, extra = {}) => ({
  id, messageId: id, role, ...(participantLabel ? { participantLabel } : {}), content, status: "done", createdAt: at(minute), ...extra
});
// A message as the chat holds it on the server.
const message = (id, minute, role, author, content, metadata) => ({
  id, role: role === "you" ? "user" : role, content, status: "done", createdAt: at(minute),
  ...(author ? { participantId: author.id, participantLabel: author.label || `@${author.handle}` } : {}),
  ...(metadata ? { metadata } : {})
});

// The members as the desktop keeps them: one with a chosen photo, one with
// the provider logo, one with nothing chosen (hashed default from its id),
// one drawn in the studio, and the chat assistant.
const DREW = { id: "p-drew", handle: "drew", roleConfigId: "software-engineer", kind: "codex-cli", avatarId: "codex-cat" };
const TAYLOR = { id: "p-taylor", handle: "taylor", roleConfigId: "code-reviewer", kind: "claude-code", avatarId: "claude-logo" };
const MORGAN = { id: "p-morgan", handle: "morgan", roleConfigId: "product-designer", kind: "claude-code" };
const GERA = { id: "p-gera", handle: "gera", roleConfigId: "product-strategist", kind: "codex-cli", avatarId: "custom:drawn-1" };
const ADMIN = { id: "p-admin", handle: "admin", roleConfigId: "administrator", kind: "codex-cli", label: "Chat Assistant" };
const member = ({ label: _label, ...participant }) => participant;

test("PWA parity: avatars resolve like the desktop, internal system rows are gone, projects fold", { timeout: 240_000 }, async () => {
  const { CHAT_AVATAR_CATALOG, defaultChatAvatarId } = await import(path.join(repoRoot, "dist/main/shared/chatAvatarCatalog.js"));
  const hub = await startMobileHub();
  const site = await serveMobileShell({ port: SITE_PORT, hubOrigins: [hub.base] });
  const morganDefault = defaultChatAvatarId("claude-code", "p-morgan");
  assert.ok(CHAT_AVATAR_CATALOG.some((entry) => entry.id === morganDefault && entry.mediaMode === "photo"), "the hashed default is a catalog photo");
  // The drawn avatar's picture, published with the desktop's catalog.
  const drawn = await hub.putBlob(Buffer.from(PNG_1X1, "base64"));
  await hub.publishCatalog({ avatars: { "custom:drawn-1": { mimeType: "image/png", blob: drawn } } });
  // Least recently changed first: the list comes newest first, Alpha on top.
  // Gamma's one member has no role, so the server lists the handle and no
  // member record: the phone knows it by handle only.
  await hub.createChat(CHAT_C, { title: "Gamma notes", repoPath: "/work/Other project", participants: [{ id: "p-kim", handle: "kim", kind: "codex-cli" }] });
  await hub.createChat(CHAT_B, { title: "Beta bugs", participants: [ADMIN, MORGAN, DREW, TAYLOR, GERA].map(member) });
  await hub.createChat(CHAT_A, { title: "Alpha planning", participants: [DREW, TAYLOR, MORGAN, GERA, ADMIN].map(member), messages: [
    message("a-001", 10, "you", undefined, "Who is here?"),
    message("a-002", 11, "participant", DREW, "Drew, with a cat."),
    message("a-003", 12, "participant", TAYLOR, "Taylor, with the logo."),
    message("a-004", 13, "participant", MORGAN, "Morgan, with the default."),
    message("a-005", 14, "participant", GERA, "Gera, drawn in the studio."),
    message("a-006", 15, "participant", ADMIN, "The assistant."),
    { ...message("a-007", 16, "participant", undefined, "Not a member of this chat."), participantLabel: "@claude-reviewer" }
  ] });
  const avatarReads = () => hub.requests.filter((request) => request.method === "GET" && request.path === "/v1/phone/avatar")
    .map((request) => ({ conversationId: request.query.conversationId, avatarId: request.query.avatarId }));

  const profile = await tempProfile("aa-parity-");
  const chrome = launchChrome({ port: CDP_PORT, profile, url: `${site.origin}/`, width: 430, height: 860 });
  let app;
  try {
    app = await attachApp({ port: CDP_PORT });
    const evaluate = app.evaluate;
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
    await pairPage(app, { hub, siteOrigin: site.origin });
    await evaluate(`navigator.serviceWorker.ready.then(() => true)`);
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
      const response = await fetch(`${site.origin}/${src}`);
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
    await hub.addMessages(CHAT_B, [message("b-001", 20, "participant", MORGAN, "Fixed for real.")]);
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
    const drawnLoaded = await waitFor(rowAvatars, (rows) => rows.some((r) => r.handle === "@gera" && r.src && r.src.startsWith("data:image/png;base64,")), "the drawn avatar's bytes arrive from the server and replace the initials");
    assert.deepEqual(drawnLoaded.map(({ handle, kind, media, src, text }) => ({ handle, kind, media, src: src && src.startsWith("data:") ? "data:" : src, text })), [
      { handle: "@drew", kind: "avatar-custom", media: "avatar-media-photo", src: "assets/avatars/codex-cat.png", text: null },
      { handle: "@taylor", kind: "avatar-anthropic", media: "avatar-media-glyph", src: "assets/avatars/claude-logo.png", text: null },
      { handle: "@morgan", kind: "avatar-custom", media: "avatar-media-photo", src: `assets/avatars/${morganDefault}.png`, text: null },
      { handle: "@gera", kind: "avatar-custom", media: "avatar-media-photo", src: "data:", text: null },
      { handle: "Chat Assistant", kind: "avatar-custom", media: "avatar-media-glyph", src: "assets/accordagents-mark.png", text: null },
      { handle: "@claude-reviewer", kind: "avatar-anthropic", media: "avatar-media-glyph", src: "assets/avatars/claude-logo.png", text: null }
    ], "each row shows what the desktop shows; an author with no member record gets the provider glyph its name suggests");
    assert.deepEqual(avatarReads(), [{ conversationId: CHAT_A, avatarId: "custom:drawn-1" }], "the drawn avatar was asked for once, scoped to its chat");

    // The members sheet and the "@" menu use the same pictures.
    await evaluate(`(() => { document.getElementById("chat-members-toggle").click(); return true; })()`);
    const sheet = await evaluate(`(() => { const describe = ${describeAvatar}; return [...document.querySelectorAll("#members-sheet-list .members-sheet-row .mobile-mention-avatar")].map(describe); })()`);
    assert.deepEqual(sheet.map((a) => a.kind), ["avatar-custom", "avatar-anthropic", "avatar-custom", "avatar-custom", "avatar-custom"]);
    assert.ok(sheet[3].src.startsWith("data:image/png;base64,"), "the drawn avatar is cached for the session, not fetched again");
    assert.equal(avatarReads().length, 1);
    await evaluate(`(() => { document.getElementById("members-sheet-close").click(); return true; })()`);

    // --- a thread has one way back, and it leads to the chat ----------------
    // Judged by what is painted, not by the attribute: the [hidden] rule is
    // what removes the button, and losing it must fail here.
    const visibleBacks = async () => await evaluate(`(() => [...document.querySelectorAll("#timeline-screen .mobile-chat-header .mobile-icon-button")].filter((n) => n.getClientRects().length > 0).map((n) => n.id))()`);
    assert.deepEqual(await visibleBacks(), ["back-to-chats"], "a chat shows one arrow, to the list");
    await evaluate(`(() => { sessionStorage.setItem("accordagents.mobile.openThreadRootId.v1", "a-001"); return true; })()`);
    await hub.addMessages(CHAT_A, [message("a-001-reply", 20, "participant", DREW, "In the thread.", { chatThreadRootId: "a-001" })]);
    await waitFor(() => evaluate(`(() => document.getElementById("chat-title").textContent)()`), (text) => text === "Thread", "the thread opens");
    assert.deepEqual(await visibleBacks(), ["back-to-timeline"], "a thread shows one arrow, to the chat — not two");

    await evaluate(`(() => { document.getElementById("back-to-timeline").click(); return true; })()`);
    await waitFor(visibleBacks, (ids) => ids.length === 1 && ids[0] === "back-to-chats", "leaving the thread brings the list arrow back");
    assert.ok(await evaluate(`(() => document.getElementById("timeline-screen").classList.contains("is-active"))()`), "and stays in the chat");

    // --- a run whose last message the desktop hides still ends on the phone
    const run9 = { ...message("run-9-live", 30, "participant", DREW, ""), status: "pending", metadata: { runId: "run-9" } };
    await hub.addMessages(CHAT_A, [run9]);
    // The phone renders a pending row as an animated "Thinking"; it is
    // identified by its status.
    const pendingRows = async () => await evaluate(`(() => [...document.querySelectorAll('#message-list .message-row[data-status="Running"]')].map((n) => n.dataset.rowKey))()`);
    await waitFor(pendingRows, (rows) => rows.length === 1, "the member's live row is shown");
    // The run ends on a waiting status, which the desktop keeps off its
    // timeline: the server sends it marked hidden.
    await hub.updateMessages(CHAT_A, [{ ...run9, content: "Awaiting user approval.", status: "done" }]);
    await waitFor(pendingRows, (rows) => rows.length === 0, "a hidden terminal settles the live row");
    assert.ok(!(await evaluate(`(() => [...document.querySelectorAll("#message-list .message-content")].some((n) => n.textContent.includes("Awaiting user approval")))()`)), "and stores no bubble for it");

    // --- internal system rows stored before the desktop stopped sending them
    // are dropped once; the phone's own machine notes stay ------------------
    // The server never sends such rows; a phone that had them stored them
    // from an older desktop, through the same ingest path.
    await evaluate(`AccordAgentsMobile.handleRelayTimelinePayload(${JSON.stringify({
      type: "mobile.timeline.events", conversationId: CHAT_A,
      events: [
        row("auto-resume-1", 17, "system", undefined, "Auto-resumed @taylor after member request.\nTarget replies/errors are in the transcript above."),
        row("machine-warning:run-9:0", 18, "system", undefined, "The machine restarted this run.")
      ]
    })})`);
    const systemRows = async () => await evaluate(`(() => [...document.querySelectorAll('#message-list .message-row[data-author="system"] .message-content')].map((n) => n.textContent.slice(0, 20)))()`);
    await waitFor(systemRows, (rows) => rows.length === 2, "an older desktop's system rows are stored as bubbles");
    await evaluate(`(() => { localStorage.removeItem("accordagents.mobile.internalSystemRowsDropped.v1"); return true; })()`);
    await app.send("Page.reload", {});
    await settle();
    await waitFor(rowAvatars, (rows) => rows.length === 6, "the chat is back after the reload");
    assert.deepEqual(await systemRows(), ["The machine restarte"], "the desktop's internal trigger is gone; the phone's own machine note stays");
    assert.equal(await evaluate(`localStorage.getItem("accordagents.mobile.internalSystemRowsDropped.v1")`), "1", "the sweep runs once");
    // The desktop offers a thread on every message but a system note, and
    // the phone offers exactly what the desktop does.
    assert.equal(
      await evaluate(`(() => document.querySelectorAll('#message-list .message-row[data-author="system"][data-thread-root]').length)()`),
      0,
      "a system note does not open on its own screen"
    );

    // --- a thread can be started from the phone -----------------------------
    // Reading a thread is no use if one can only be begun from the desktop.
    // Slack's shape, which the User asked for: the message opens on its own
    // screen and the offer to answer it lives there, not under every message.
    await evaluate(`(() => { sessionStorage.removeItem("accordagents.mobile.openThreadRootId.v1"); return true; })()`);
    await evaluate(`(() => { document.getElementById("back-to-timeline")?.click(); return true; })()`);
    await waitFor(
      () => evaluate(`(() => [...document.querySelectorAll("#message-list .message-row[data-thread-root]")].length)()`),
      (count) => count > 0,
      "the chat has a message that can be opened"
    );
    assert.equal(
      await evaluate(`(() => document.getElementById("thread-reply-action").hidden)()`),
      true,
      "the offer is not in the chat itself"
    );
    // A message nobody has answered yet: the one the offer is for.
    const startedRoot = await evaluate(`(() => {
      const rows = [...document.querySelectorAll("#message-list .message-row[data-thread-root]:not([data-streamable])")]
        .filter((row) => !row.querySelector(".thread-chip"));
      const row = rows[rows.length - 1];
      const root = row.dataset.threadRoot;
      row.click();
      return root;
    })()`);
    await waitFor(
      () => evaluate(`(() => sessionStorage.getItem("accordagents.mobile.openThreadRootId.v1"))()`),
      (root) => root === startedRoot,
      "tapping a message opens it on its own screen"
    );
    await waitFor(() => evaluate(`(() => document.getElementById("chat-title").textContent)()`), (text) => text === "Thread", "and the screen says so");
    await waitFor(
      () => evaluate(`(() => JSON.stringify({
        hidden: document.getElementById("thread-reply-action").hidden,
        rows: document.querySelectorAll("#message-list .message-row").length,
        title: document.getElementById("chat-title").textContent
      }))()`),
      (state) => JSON.parse(state).hidden === false,
      "the screen offers to answer it in a thread"
    );
    await evaluate(`(() => { document.getElementById("thread-reply-button").click(); return true; })()`);
    assert.equal(
      await evaluate(`(() => document.activeElement === document.getElementById("composer-input"))()`),
      true,
      "and the offer puts the cursor in the reply field"
    );
    assert.equal(
      await evaluate(`(() => document.getElementById("composer-input").placeholder)()`),
      "Add a reply...",
      "which says it is a reply"
    );
    await evaluate(`(() => { document.getElementById("composer-input").blur(); document.getElementById("back-to-timeline").click(); return true; })()`);

    // --- a message written in a thread is sent to that thread ---------------
    // Last, because it queues a message: without the thread it was written in
    // the desktop put it in the main timeline, and the User -- still looking
    // at the thread she wrote in -- could not see her own message at all.
    await evaluate(`(() => { sessionStorage.setItem("accordagents.mobile.openThreadRootId.v1", "a-001"); return true; })()`);
    await hub.addMessages(CHAT_A, [message("a-001-reply-2", 24, "participant", DREW, "Still in the thread.", { chatThreadRootId: "a-001" })]);
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
    chrome.kill("SIGKILL");
    await site.close();
    await hub.close();
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
});

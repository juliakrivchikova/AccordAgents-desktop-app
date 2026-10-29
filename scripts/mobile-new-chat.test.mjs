/**
 * The phone's New chat, driven through the real PWA in a browser against a
 * real hub: the computer's New chat, as the computer prepared it (the User,
 * 2026-10-29). The chat is made on the server with the Chat Assistant and
 * each member chosen, starts with the computer's line, and its first message
 * asks the right member.
 *
 * This is desktop Chrome, not the installed phone: it runs the files the
 * phone runs, under the same origin headers.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { attachApp, launchChrome, member, pairPage, serveMobileShell, startMobileHub, tempProfile } from "./mobile-hub-fixture.mjs";

// A 1x1 PNG: what a photo from the phone's library stands for here.
const PICTURE = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

test("the phone starts a chat the way the computer would: in the project chosen, with the members chosen, asking the member named", { timeout: 120_000 }, async (t) => {
  const hub = await startMobileHub();
  const site = await serveMobileShell({ port: 8341, hubOrigins: [hub.base] });
  const profile = await tempProfile("aa-mobile-new-chat-");
  const chrome = launchChrome({ port: 9481, profile, url: `${site.origin}/`, width: 430, height: 860 });
  let app;
  t.after(async () => {
    app?.close();
    chrome.kill("SIGKILL");
    await site.close();
    await hub.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  await hub.createChat("conv-old", { title: "Old", participants: [member("drew")] });
  const assistant = { id: "t-assistant", handle: "assistant", roleConfigId: "administrator", kind: "codex-cli" };
  const drew = member("drew", { id: "t-drew", participantConfigId: "c-drew" });
  const gera = member("gera", { id: "t-gera", participantConfigId: "c-gera", kind: "codex-cli" });
  const newChat = {
    projects: [{ path: "/Users/u/site", label: "site" }, { path: "/Users/u/api", label: "api" }], defaultProject: "/Users/u/site", assistant,
    members: [{ configId: "c-gera", uses: 1, participant: gera }, { configId: "c-drew", uses: 4, participant: drew },
      { configId: "c-cass", uses: 0, participant: member("cass", { id: "t-cass", participantConfigId: "c-cass", kind: "claude-code" }), unavailable: "QA: Claude Code is not signed in." }]
  };
  const published = await hub.call("PUT", "/v1/catalog", { catalog: { version: 1, publishedAt: new Date().toISOString(), roles: { "software-engineer": "Engineer", administrator: "Chat Assistant" }, prompts: [], skills: [], avatars: {}, newChat } });
  assert.equal(published.ok, true);
  app = await attachApp({ port: 9481 });
  await pairPage(app, { hub, siteOrigin: site.origin, query: "qa=1" });
  await app.waitFor(`!document.getElementById("new-chat-button").hidden`, "the New chat button for a phone paired for every chat");
  const note = `(() => { const node = document.getElementById("new-chat-note"); return node.hidden ? "" : node.textContent; })()`;

  // A server from before New chat on the phone answers Not found: the panel
  // says the server has not updated yet, not that it is unreachable.
  await app.evaluate(`(() => { const real = window.fetch; window.__realFetch = real;
    window.fetch = function (input, init) {
      if (String(input && input.url || input).indexOf("/v1/phone/new-chat") >= 0) {
        return Promise.resolve(new Response(JSON.stringify({ ok: false, error: "Not found." }), { status: 404, headers: { "content-type": "application/json" } }));
      }
      return real.call(window, input, init);
    }; })()`);
  await app.evaluate(`document.getElementById("new-chat-button").click()`);
  await app.waitFor(`${note}.indexOf("does not start chats from the phone yet") >= 0`, "the older server's answer, in words");
  assert.equal(await app.evaluate(`document.getElementById("new-chat-start").disabled`), true);
  await app.evaluate(`window.fetch = window.__realFetch; document.getElementById("new-chat-close").click()`);

  await app.evaluate(`document.getElementById("new-chat-button").click()`);
  await app.waitFor(`document.querySelectorAll("#new-chat-members .new-chat-member").length === 4`, "the Chat Assistant and the saved members");

  // The phone cannot write its queue: nothing is queued, the chat is not in
  // the list, and the panel keeps the text and says why.
  await app.evaluate(`(() => { const real = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function () {
      if (this.name !== "outbox") return real.apply(this, arguments);
      IDBObjectStore.prototype.put = real;
      throw new Error("QA: the phone's storage is full");
    };
    const input = document.getElementById("new-chat-input"); input.value = "this one fails"; input.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("new-chat-start").click(); })()`);
  await app.waitFor(`${note}.indexOf("Could not start the chat: QA: the phone's storage is full") >= 0`, "the failure, in the panel");
  const failed = await app.evaluate(`({ open: !document.getElementById("new-chat-screen").hidden, text: document.getElementById("new-chat-input").value,
    started: localStorage.getItem("accordagents.mobile.startedChats.v1"), start: document.getElementById("new-chat-start").disabled })`);
  assert.deepEqual(failed, { open: true, text: "this one fails", started: null, start: false }, "nothing left behind, and it can be tried again");
  assert.equal((await hub.storage.listConversations()).some((summary) => summary.title === "this one fails"), false);

  // The server refuses the chat: it leaves the list, as the computer lists no
  // chat its New chat could not make, and the message says why.
  hub.setGate(async (request) => request.method === "POST" && request.path === "/v3/ops" && (request.ops || []).some((op) => op.kind === "conversation.create")
    ? { status: 200, body: { ok: true, results: request.ops.map((op) => ({ opId: op.opId, status: "rejected", reason: "QA: not this one" })) } }
    : undefined);
  await app.evaluate(`(() => { const input = document.getElementById("new-chat-input"); input.value = "refused chat"; input.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("new-chat-start").click(); })()`);
  await app.waitFor(`[...document.querySelectorAll('#message-list .message-row[data-author="you"] .message-status')].some((node) => node.textContent === "Not taken by your server: The chat was not created: QA: not this one")`,
    "the first message says the chat was not made, and why");
  assert.equal(await app.evaluate(`localStorage.getItem("accordagents.mobile.startedChats.v1")`), null, "out of the list");
  hub.setGate(undefined);
  await app.evaluate(`document.getElementById("back-to-chats").click()`);
  await app.waitFor(`document.getElementById("chats-screen").classList.contains("is-active")`, "back on the list");
  assert.equal(await app.evaluate(`document.getElementById("chat-list").innerText.indexOf("refused chat") >= 0`), false, "the list does not show it");
  assert.equal((await hub.storage.listConversations()).some((summary) => summary.title === "refused chat"), false);
  await app.evaluate(`document.getElementById("new-chat-button").click()`);
  await app.waitFor(`document.querySelectorAll("#new-chat-members .new-chat-member").length === 4`, "the screen again");
  // A screen of its own, the card's two lists closed until asked for.
  assert.deepEqual(await app.evaluate(`({
    projectsOpen: !document.getElementById("new-chat-projects-sheet").hidden, membersOpen: !document.getElementById("new-chat-members-sheet").hidden,
    project: document.getElementById("new-chat-project-label").textContent, members: document.getElementById("new-chat-members-button").getAttribute("aria-label"),
    dock: document.getElementById("home-dock").hidden
  })`), { projectsOpen: false, membersOpen: false, project: "site", members: "Members: Chat Assistant", dock: true });
  await app.evaluate(`document.getElementById("new-chat-project").click()`);
  await app.waitFor(`!document.getElementById("new-chat-projects-sheet").hidden`, "the project list");
  await app.evaluate(`document.querySelector('#new-chat-projects-sheet .members-sheet-close').click()`);
  await app.evaluate(`document.getElementById("new-chat-members-button").click()`);
  await app.waitFor(`!document.getElementById("new-chat-members-sheet").hidden && document.getElementById("new-chat-projects-sheet").hidden`, "the member list, alone");
  const panel = await app.evaluate(`({
    rows: [...document.querySelectorAll("#new-chat-members .new-chat-member")].map((row) => row.dataset.handle + ":" + row.getAttribute("aria-pressed")),
    folders: [...document.querySelectorAll("#new-chat-projects .new-chat-option")].map((row) => row.querySelector("strong").textContent + (row.getAttribute("aria-pressed") === "true" ? "*" : ""))
  })`);
  assert.deepEqual(panel.rows, ["assistant:true", "drew:false", "gera:false", "cass:false"], "the Assistant first and chosen, then the most used");
  assert.equal(await app.evaluate(`document.querySelector('#new-chat-members [data-handle="cass"]').dataset.unavailable`), "1", "one the computer cannot add now is shown so");

  // Named with @, a member the computer cannot add now stops the start, as
  // the computer's New chat does, with its reason.
  await app.evaluate(`(() => { const input = document.getElementById("new-chat-input"); input.value = "@cass have a look"; input.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("new-chat-start").click(); })()`);
  await app.waitFor(`${note} === "QA: Claude Code is not signed in."`, "the member's reason");
  assert.equal(await app.evaluate(`localStorage.getItem("accordagents.mobile.startedChats.v1")`), null, "no chat started");
  assert.deepEqual(panel.folders, ["site*", "api", "No project"], "the computer's projects, its own first, and none");
  assert.equal(await app.evaluate(`document.querySelector('#new-chat-projects [data-path="/Users/u/api"] .members-sheet-location').textContent`), "~/api", "where it is, the home folder as ~");
  await app.evaluate(`[...document.querySelectorAll("#new-chat-members .new-chat-member")].find((row) => row.dataset.handle === "gera").click()`);
  await app.waitFor(`document.getElementById("new-chat-members-button").getAttribute("aria-label") === "Members: Chat Assistant, @gera"`, "the members on the card");
  assert.equal(await app.evaluate(`document.querySelectorAll("#new-chat-avatars .mobile-mention-avatar").length`), 2, "their faces on the card");
  await app.evaluate(`document.querySelector('#new-chat-members-sheet .members-sheet-close').click()`);
  await app.evaluate(`document.getElementById("new-chat-project").click()`);
  await app.evaluate(`document.querySelector('#new-chat-projects [data-path="/Users/u/api"]').click()`);
  await app.waitFor(`document.getElementById("new-chat-projects-sheet").hidden && document.getElementById("new-chat-project-label").textContent === "api"`, "the project picked, the list closed");
  // A picture goes with the first message, as from the chat's composer.
  const picture = path.join(profile, "dot.png");
  await writeFile(picture, PICTURE);
  await app.send("DOM.enable");
  const { root } = await app.send("DOM.getDocument", { depth: -1, pierce: true });
  const { nodeId } = await app.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#new-chat-image-input" });
  await app.send("DOM.setFileInputFiles", { nodeId, files: [picture] });
  await app.waitFor(`document.querySelectorAll("#new-chat-attachments .composer-attachment-thumb").length === 1`, "the picture on the card");
  await app.evaluate(`(() => { const input = document.getElementById("new-chat-input"); input.value = "@drew start with the login page"; input.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await app.evaluate(`document.getElementById("new-chat-start").click()`);
  await app.waitFor(`document.getElementById("timeline-screen").classList.contains("is-active") && document.getElementById("chat-title").textContent === "start with the login page"`, "the new chat opened, titled as the computer titles it");
  let created;
  for (let attempt = 0; attempt < 100 && !created; attempt += 1) {
    const list = await hub.storage.listConversations();
    created = list.find((summary) => summary.title === "start with the login page");
    if (!created) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(created, "the chat is on the server");
  // Its first message goes right behind it, once the server took the chat.
  let chat;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    chat = await hub.storage.getConversation(created.id);
    if (chat.messages.some((item) => item.role === "user")) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(chat.repoPath, "/Users/u/api");
  assert.deepEqual(chat.metadata.participants.map((participant) => participant.handle), ["assistant", "gera", "drew"],
    "the Assistant, then the saved members chosen or named, in the order the computer saved them");
  assert.ok(chat.metadata.participants.every((participant) => !participant.id.startsWith("t-")), "each with a fresh id");
  assert.equal(chat.messages[0].content, "Chat started.\nMembers:\n- User\n- @assistant\n- @gera\n- @drew");
  const message = chat.messages.find((item) => item.role === "user");
  const drewId = chat.metadata.participants.find((participant) => participant.handle === "drew").id;
  assert.deepEqual(message.metadata.deliveryTargets, [drewId], "the member named is asked");
  const pictures = message.metadata.imageAttachments || [];
  assert.equal(pictures.length, 1, "the picture is on the first message");
  assert.equal(pictures[0].filename, "dot.png");
  assert.ok(pictures[0].hubBlob, "held by the server, where the computer reads it");
  await app.waitFor(`JSON.parse(localStorage.getItem("accordagents.mobile.chatList.v1") || "[]").some((item) => item.id === ${JSON.stringify(created.id)})`, "the server's list names it", 20_000);
  assert.equal(await app.evaluate(`localStorage.getItem("accordagents.mobile.startedChats.v1")`), null, "kept here only until the server listed it");

  // As on the computer, a picture on its own starts a chat, named after it.
  await app.evaluate(`document.getElementById("back-to-chats").click()`);
  await app.evaluate(`document.getElementById("new-chat-button").click()`);
  await app.waitFor(`document.querySelectorAll("#new-chat-members .new-chat-member").length === 4 && document.getElementById("new-chat-start").disabled`, "an empty card, nothing to start yet");
  const again = await app.send("DOM.getDocument", { depth: -1, pierce: true });
  const field = await app.send("DOM.querySelector", { nodeId: again.root.nodeId, selector: "#new-chat-image-input" });
  await app.send("DOM.setFileInputFiles", { nodeId: field.nodeId, files: [picture] });
  await app.waitFor(`!document.getElementById("new-chat-start").disabled`, "a picture is enough to start");
  await app.evaluate(`document.getElementById("new-chat-start").click()`);
  await app.waitFor(`document.getElementById("timeline-screen").classList.contains("is-active") && document.getElementById("chat-title").textContent === "Image: dot.png"`, "the picture's chat, titled as the computer titles it");
});

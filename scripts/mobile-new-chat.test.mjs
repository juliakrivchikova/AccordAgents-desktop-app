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
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { attachApp, launchChrome, member, pairPage, serveMobileShell, sleep, startMobileHub, tempProfile } from "./mobile-hub-fixture.mjs";

// A 1x1 PNG: what a photo from the phone's library stands for here.
const PICTURE = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

test("the phone starts a chat the way the computer would: in the project chosen, with the members chosen, asking the member named", { timeout: 120_000 }, async (t) => {
  // The cloud member's machine is one of the server's devices.
  const { createDeviceIdentity } = require("../dist/main/main/services/deviceIdentity.js");
  const cloudMachine = createDeviceIdentity(new Date().toISOString());
  const hub = await startMobileHub({ rosterDevices: [
    { deviceId: cloudMachine.originId, publicKeyDerBase64: cloudMachine.publicKeyDerBase64, role: "machine", name: "Cloud run", machineId: "m-cloud" }
  ] });
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
      { configId: "c-cass", uses: 0, participant: member("cass", { id: "t-cass", participantConfigId: "c-cass", kind: "claude-code" }), unavailable: "QA: Claude Code is not signed in." },
      // A Cloud run member: its machine has only the api project.
      { configId: "c-cloudy", uses: 0, participant: member("cloudy", { id: "t-cloudy", participantConfigId: "c-cloudy", kind: "claude-code", cloudRun: {} }), machineId: "m-cloud", projects: ["/Users/u/api"] }]
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
  // Where a finger can reach it: inside the card, on screen, the topmost thing there.
  assert.deepEqual(await app.evaluate(`(() => {
    const thumb = document.querySelector("#new-chat-attachments .composer-attachment-thumb").getBoundingClientRect();
    const card = document.querySelector(".new-chat-card").getBoundingClientRect();
    const hit = document.elementFromPoint(thumb.left + thumb.width / 2, thumb.top + thumb.height / 2);
    return { inside: thumb.top >= card.top && thumb.bottom <= card.bottom && thumb.left >= card.left && thumb.right <= card.right,
      onScreen: thumb.top >= 0 && thumb.bottom <= innerHeight, topmost: Boolean(hit && hit.closest("#new-chat-attachments")) };
  })()`), { inside: true, onScreen: true, topmost: true }, "the picture shows on the card");
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
  // Taken off again, there is nothing to start.
  await app.evaluate(`document.querySelector("#new-chat-attachments .composer-attachment-remove").click()`);
  await app.waitFor(`document.getElementById("new-chat-start").disabled && document.getElementById("new-chat-attachments").hidden`, "the picture removed");
  const field2 = await app.send("DOM.querySelector", { nodeId: (await app.send("DOM.getDocument", { depth: -1, pierce: true })).root.nodeId, selector: "#new-chat-image-input" });
  await app.send("DOM.setFileInputFiles", { nodeId: field2.nodeId, files: [picture] });
  await app.waitFor(`!document.getElementById("new-chat-start").disabled`, "the picture again");
  await app.evaluate(`document.getElementById("new-chat-start").click()`);
  await app.waitFor(`document.getElementById("timeline-screen").classList.contains("is-active") && document.getElementById("chat-title").textContent === "Image: dot.png"`, "the picture's chat, titled as the computer titles it");
  await app.evaluate(`document.getElementById("back-to-chats").click()`);
  let pictureChat;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const summary = (await hub.storage.listConversations()).find((item) => item.title === "Image: dot.png");
    pictureChat = summary ? await hub.storage.getConversation(summary.id) : undefined;
    if (pictureChat && pictureChat.messages.some((item) => item.role === "user")) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const first = pictureChat.messages.find((item) => item.role === "user");
  assert.equal(first.content, "", "a picture and no words");
  assert.equal((first.metadata.imageAttachments || []).length, 1);
  assert.ok(first.metadata.imageAttachments[0].hubBlob, "the picture is on the server");
  const assistantId = pictureChat.metadata.participants.find((participant) => participant.roleConfigId === "administrator").id;
  assert.deepEqual(first.metadata.deliveryTargets, [assistantId], "unaddressed, it is for the Chat Assistant, as on the computer");

  // A cloud member is offered only where its machine has the project (the
  // User, 2026-10-30), and the chat goes straight to that machine.
  await app.evaluate(`document.getElementById("new-chat-button").click()`);
  await app.waitFor(`document.querySelectorAll("#new-chat-members .new-chat-member").length >= 4`, "the screen for the cloud member");
  const handles = `[...document.querySelectorAll("#new-chat-members .new-chat-member")].map((row) => row.dataset.handle)`;
  const pickProject = async (path) => {
    await app.evaluate(`document.getElementById("new-chat-project").click()`);
    await app.evaluate(`document.querySelector('#new-chat-projects [data-path=${JSON.stringify(path)}]').click()`);
  };
  await pickProject("/Users/u/site");
  assert.equal((await app.evaluate(handles)).includes("cloudy"), false, "not in a project its machine does not have");
  await pickProject("/Users/u/api");
  await app.waitFor(`${handles}.includes("cloudy")`, "offered in the project its machine has");
  const where = await app.evaluate(`document.querySelector('#new-chat-members [data-handle="cloudy"] .members-sheet-location').textContent`);
  assert.equal(where, "Cloud run", "said to run on its machine, by its name, not here");
  await app.evaluate(`document.querySelector('#new-chat-members [data-handle="cloudy"]').click()`);
  await app.waitFor(`document.getElementById("new-chat-members-button").getAttribute("aria-label").indexOf("@cloudy") >= 0`, "chosen");
  await pickProject("/Users/u/site");
  await app.waitFor(`document.getElementById("new-chat-members-button").getAttribute("aria-label").indexOf("@cloudy") < 0 && !${handles}.includes("cloudy")`, "a project change takes it out");
  await pickProject("");
  await app.waitFor(`${handles}.includes("cloudy")`, "a chat without a project can have it");
  // Named with @ where its machine lacks the project, it stops the start.
  await pickProject("/Users/u/site");
  await app.evaluate(`(() => { const input = document.getElementById("new-chat-input"); input.value = "@cloudy check the deploy"; input.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("new-chat-start").click(); })()`);
  await app.waitFor(`${note}.indexOf("@cloudy runs on") === 0 && ${note}.indexOf("does not have this project") > 0`, "why it cannot start there");
  // The @ list, as on the computer: typing offers the members, a pick writes
  // the handle and adds the member.
  await pickProject("/Users/u/api");
  await app.evaluate(`(() => { const input = document.getElementById("new-chat-input"); input.focus(); input.value = "@clo"; input.setSelectionRange(4, 4); input.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await app.waitFor(`!document.getElementById("new-chat-mention-menu").hidden && [...document.querySelectorAll("#new-chat-mention-menu .mobile-mention-option")].map((row) => row.dataset.handle).join() === "cloudy"`, "the @ list offers the member");
  await app.evaluate(`document.querySelector('#new-chat-mention-menu [data-handle="cloudy"]').click()`);
  assert.equal(await app.evaluate(`document.getElementById("new-chat-input").value`), "@cloudy ", "the handle is written");
  await app.waitFor(`document.getElementById("new-chat-members-button").getAttribute("aria-label").indexOf("@cloudy") >= 0 && document.getElementById("new-chat-mention-menu").hidden`, "and the member is in the chat");
  await app.evaluate(`(() => { const input = document.getElementById("new-chat-input"); input.value = "@cloudy check the deploy"; input.dispatchEvent(new Event("input", { bubbles: true })); document.getElementById("new-chat-start").click(); })()`);
  await app.waitFor(`document.getElementById("timeline-screen").classList.contains("is-active") && document.getElementById("chat-title").textContent === "check the deploy"`, "the cloud member's chat opened");
  let cloudChat;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const summary = (await hub.storage.listConversations()).find((item) => item.title === "check the deploy");
    cloudChat = summary ? await hub.storage.getConversation(summary.id) : undefined;
    if (cloudChat && cloudChat.messages.some((item) => item.role === "user")) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(cloudChat.repoPath, "/Users/u/api");
  const cloudMember = cloudChat.metadata.participants.find((participant) => participant.handle === "cloudy");
  assert.equal(cloudMember.homeMachineId, "m-cloud", "on its machine, which takes its turns from the server");
  const cloudAsk = cloudChat.messages.find((item) => item.role === "user");
  assert.deepEqual(cloudAsk.metadata.deliveryTargets, [cloudMember.id]);
  // The server asks the machine for the turn: no computer in between.
  const turns = await hub.storage.hubOps().turnsFor(cloudChat.id, [cloudAsk.id]);
  assert.deepEqual(turns.map((turn) => ({ participantId: turn.participantId, state: turn.state })), [{ participantId: cloudMember.id, state: "requested" }]);
});

test("the @ list in New chat offers every member, the rest reached by scrolling, as on the computer", { timeout: 120_000 }, async (t) => {
  // The User's phone, 2026-10-31: her cloud member @victor, saved last and in
  // no chat yet, was not among the first six the list showed, and could not
  // be scrolled to.
  const { createDeviceIdentity } = require("../dist/main/main/services/deviceIdentity.js");
  const cloudMachine = createDeviceIdentity(new Date().toISOString());
  const hub = await startMobileHub({ rosterDevices: [
    { deviceId: cloudMachine.originId, publicKeyDerBase64: cloudMachine.publicKeyDerBase64, role: "machine", name: "Cloud run", machineId: "m-cloud" }
  ] });
  const site = await serveMobileShell({ port: 8343, hubOrigins: [hub.base] });
  const profile = await tempProfile("aa-mobile-new-chat-mentions-");
  const chrome = launchChrome({ port: 9483, profile, url: `${site.origin}/`, width: 402, height: 874 });
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
  const handles = ["drew", "taylor", "alex-manager", "gera", "alex-codex-qa-lead", "maya-design", "sam-product", "stephan", "remote-claude", "victor"];
  const members = handles.map((handle, index) => ({ configId: `c-${handle}`, uses: handles.length - index - 1,
    participant: member(handle, { id: `t-${handle}`, participantConfigId: `c-${handle}` }) }));
  // Victor as hers is: a Cloud run member whose machine has this project.
  members[members.length - 1] = { configId: "c-victor", uses: 0, machineId: "m-cloud", projects: ["/Users/u/site"],
    participant: member("victor", { id: "t-victor", participantConfigId: "c-victor", cloudRun: {} }) };
  // Not addable now: still left out of the @ list, as before.
  members.push({ configId: "c-cass", uses: 0, participant: member("cass", { id: "t-cass", participantConfigId: "c-cass" }), unavailable: "QA: Claude Code is not signed in." });
  const newChat = { projects: [{ path: "/Users/u/site", label: "site" }], defaultProject: "/Users/u/site", assistant, members };
  const published = await hub.call("PUT", "/v1/catalog", { catalog: { version: 1, publishedAt: new Date().toISOString(), roles: { "software-engineer": "Engineer", administrator: "Chat Assistant" }, prompts: [], skills: [], avatars: {}, newChat } });
  assert.equal(published.ok, true);
  app = await attachApp({ port: 9483 });
  await pairPage(app, { hub, siteOrigin: site.origin, query: "qa=1" });
  await app.waitFor(`!document.getElementById("new-chat-button").hidden`, "the New chat button");
  await app.evaluate(`document.getElementById("new-chat-button").click()`);
  await app.waitFor(`document.querySelectorAll("#new-chat-members .new-chat-member").length >= ${handles.length}`, "the New chat screen with the offer");

  const menu = `document.getElementById("new-chat-mention-menu")`;
  const offered = `[...document.querySelectorAll("#new-chat-mention-menu .mobile-mention-option")].map((row) => row.dataset.handle)`;
  const type = (text) => app.evaluate(`(() => { const input = document.getElementById("new-chat-input"); input.focus(); input.value = ${JSON.stringify(text)};
    input.setSelectionRange(input.value.length, input.value.length); input.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  // Where a row is on the screen, and whether a finger there lands on it.
  const rowAt = (handle) => app.evaluate(`(() => { const row = document.querySelector('#new-chat-mention-menu [data-handle=${JSON.stringify(handle)}]'); const box = row.getBoundingClientRect();
    const x = box.left + box.width / 2; const y = box.top + box.height / 2; const hit = document.elementFromPoint(x, y);
    return { x, y, onScreen: y > 0 && y < innerHeight, hit: Boolean(hit && hit.closest('[data-handle=${JSON.stringify(handle)}]')) }; })()`);
  await type("@");
  await app.waitFor(`!${menu}.hidden`, "the @ list opens");
  assert.deepEqual(await app.evaluate(offered), ["assistant", ...handles], "the Assistant and every member that can be added, the most used first");
  assert.equal(await app.evaluate(`${menu}.scrollHeight > ${menu}.clientHeight + 40`), true, "longer than the list's box: it scrolls");
  assert.equal((await rowAt("victor")).hit, false, "the last member starts below what the list shows");

  // A finger drags the list up, as on the phone: the last member comes into
  // view, the field keeps its keyboard and the list stays open.
  await app.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  const from = await rowAt("alex-codex-qa-lead");
  await app.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from.x, y: from.y, radiusX: 1, radiusY: 1, force: 1 }] });
  for (let step = 1; step <= 12; step += 1) {
    await app.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from.x, y: from.y - step * 25, radiusX: 1, radiusY: 1, force: 1 }] });
    await sleep(16);
  }
  await app.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(400);
  assert.equal(await app.evaluate(`${menu}.scrollTop > 0`), true, "the drag scrolled the list");
  assert.equal(await app.evaluate(`!${menu}.hidden && document.activeElement === document.getElementById("new-chat-input")`), true, "a drag picks nobody and keeps the field");
  assert.equal(await app.evaluate(`document.getElementById("new-chat-members-button").getAttribute("aria-label")`), "Members: Chat Assistant", "nobody added by the drag");
  const victor = await rowAt("victor");
  assert.deepEqual({ onScreen: victor.onScreen, hit: victor.hit }, { onScreen: true, hit: true }, "scrolled to, the last member is on the screen under the finger");
  // A key that changes nothing before the caret redraws the list where it was.
  const scrolled = await app.evaluate(`${menu}.scrollTop`);
  await app.evaluate(`document.getElementById("new-chat-input").dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", bubbles: true }))`);
  assert.equal(await app.evaluate(`${menu}.scrollTop`), scrolled, "kept where it was scrolled to");
  // A tap picks it.
  await app.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: victor.x, y: victor.y, radiusX: 1, radiusY: 1, force: 1 }] });
  await sleep(40);
  await app.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await app.send("Emulation.setTouchEmulationEnabled", { enabled: false, maxTouchPoints: 1 });
  await app.waitFor(`document.getElementById("new-chat-input").value === "@victor "`, "the handle is written");
  await app.waitFor(`document.getElementById("new-chat-members-button").getAttribute("aria-label").indexOf("@victor") >= 0 && ${menu}.hidden`, "and the member is in the chat");

  // Opened again, the list starts at its top, not where it was scrolled to.
  await type("@victor and @");
  await app.waitFor(`!${menu}.hidden`, "the @ list opens again");
  assert.equal(await app.evaluate(`${menu}.scrollTop`), 0, "from the first match");
  assert.equal((await rowAt("assistant")).hit, true, "the Chat Assistant in view");
  // Narrowed by typing after a scroll, it starts at its first match too.
  await app.evaluate(`${menu}.scrollTop = ${menu}.scrollHeight`);
  await type("@victor and @a");
  await app.waitFor(`${offered}[0] === "assistant" && ${menu}.scrollTop === 0`, "narrowed, from the first match");
});

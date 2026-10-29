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
import { rm } from "node:fs/promises";
import { attachApp, launchChrome, member, pairPage, serveMobileShell, startMobileHub, tempProfile } from "./mobile-hub-fixture.mjs";

test("the phone starts a chat the way the computer would: in the folder chosen, with the members chosen, asking the member named", { timeout: 120_000 }, async (t) => {
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
    members: [{ configId: "c-gera", uses: 1, participant: gera }, { configId: "c-drew", uses: 4, participant: drew }]
  };
  const published = await hub.call("PUT", "/v1/catalog", { catalog: { version: 1, publishedAt: new Date().toISOString(), roles: { "software-engineer": "Engineer", administrator: "Chat Assistant" }, prompts: [], skills: [], avatars: {}, newChat } });
  assert.equal(published.ok, true);
  app = await attachApp({ port: 9481 });
  await pairPage(app, { hub, siteOrigin: site.origin, query: "qa=1" });
  await app.waitFor(`!document.getElementById("new-chat-button").hidden`, "the New chat button for a phone paired for every chat");
  await app.evaluate(`document.getElementById("new-chat-button").click()`);
  await app.waitFor(`document.querySelectorAll("#new-chat-members .new-chat-member").length === 3`, "the Chat Assistant and the saved members");
  const panel = await app.evaluate(`({
    rows: [...document.querySelectorAll("#new-chat-members .new-chat-member")].map((row) => row.dataset.handle + ":" + row.getAttribute("aria-pressed")),
    folders: [...document.getElementById("new-chat-folder").options].map((option) => option.textContent + (option.selected ? "*" : ""))
  })`);
  assert.deepEqual(panel.rows, ["assistant:true", "drew:false", "gera:false"], "the Assistant first and chosen, then the most used");
  assert.deepEqual(panel.folders, ["site*", "api", "Work without a folder"], "the computer's projects, its folder first, and none");
  await app.evaluate(`[...document.querySelectorAll("#new-chat-members .new-chat-member")].find((row) => row.dataset.handle === "gera").click()`);
  await app.evaluate(`(() => { const folder = document.getElementById("new-chat-folder"); folder.value = "/Users/u/api"; folder.dispatchEvent(new Event("change", { bubbles: true }));
    const input = document.getElementById("new-chat-input"); input.value = "@drew start with the login page"; input.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await app.evaluate(`document.getElementById("new-chat-start").click()`);
  await app.waitFor(`document.getElementById("timeline-screen").classList.contains("is-active") && document.getElementById("chat-title").textContent === "start with the login page"`, "the new chat opened, titled as the computer titles it");
  let created;
  for (let attempt = 0; attempt < 100 && !created; attempt += 1) {
    const list = await hub.storage.listConversations();
    created = list.find((summary) => summary.title === "start with the login page");
    if (!created) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(created, "the chat is on the server");
  const chat = await hub.storage.getConversation(created.id);
  assert.equal(chat.repoPath, "/Users/u/api");
  assert.deepEqual(chat.metadata.participants.map((participant) => participant.handle), ["assistant", "gera", "drew"],
    "the Assistant, then the saved members chosen or named, in the order the computer saved them");
  assert.ok(chat.metadata.participants.every((participant) => !participant.id.startsWith("t-")), "each with a fresh id");
  assert.equal(chat.messages[0].content, "Chat started.\nMembers:\n- User\n- @assistant\n- @gera\n- @drew");
  const message = chat.messages.find((item) => item.role === "user");
  const drewId = chat.metadata.participants.find((participant) => participant.handle === "drew").id;
  assert.deepEqual(message.metadata.deliveryTargets, [drewId], "the member named is asked");
  await app.waitFor(`JSON.parse(localStorage.getItem("accordagents.mobile.chatList.v1") || "[]").some((item) => item.id === ${JSON.stringify(created.id)})`, "the server's list names it", 20_000);
  assert.equal(await app.evaluate(`localStorage.getItem("accordagents.mobile.startedChats.v1")`), null, "kept here only until the server listed it");
});

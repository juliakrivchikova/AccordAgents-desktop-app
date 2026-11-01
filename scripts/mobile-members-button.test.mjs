/**
 * The chat header's way to the members (the User, 2026-11-01): a button with
 * people and how many, at the header's end, opening the same sheet the title
 * opens. Driven through the real PWA in a browser against a real hub.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { rm } from "node:fs/promises";
import { attachApp, launchChrome, member, openChat, pairPage, serveMobileShell, startMobileHub, tempProfile } from "./mobile-hub-fixture.mjs";

const shown = (id) => `(() => { const node = document.getElementById(${JSON.stringify(id)}); return Boolean(node && !node.hidden && node.offsetParent !== null); })()`;

test("the chat header shows how many members there are, and the button opens them", { timeout: 120_000 }, async (t) => {
  const hub = await startMobileHub();
  const site = await serveMobileShell({ port: 8365, hubOrigins: [hub.base] });
  const profile = await tempProfile("aa-mobile-members-");
  const chrome = launchChrome({ port: 9505, profile, url: `${site.origin}/` });
  let app;
  t.after(async () => {
    app?.close();
    chrome.kill("SIGKILL");
    await site.close();
    await hub.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  await hub.createChat("conv-team", { title: "Team", participants: [member("drew"), member("taylor"), member("gera")] });
  await hub.createChat("conv-solo", { title: "Solo", participants: [member("drew")] });
  app = await attachApp({ port: 9505 });
  await pairPage(app, { hub, siteOrigin: site.origin, query: "qa=1" });

  await openChat(app, "conv-team");
  await app.waitFor(`${shown("chat-members-button")} && document.getElementById("chat-members-count").textContent === "3"`, "the members button with 3");
  assert.equal(await app.evaluate(`document.getElementById("chat-members-button").getAttribute("aria-label")`), "Members: 3 members");
  assert.equal(await app.evaluate(`document.getElementById("send-log-spacer").hidden`), true, "the button takes the spacer's place");
  // At the header's end, beside the title.
  const placed = await app.evaluate(`(() => { const header = document.querySelector("#timeline-screen .mobile-chat-header").getBoundingClientRect();
    const button = document.getElementById("chat-members-button").getBoundingClientRect();
    const title = document.getElementById("chat-members-toggle").getBoundingClientRect();
    return { right: Math.round(header.right - button.right), afterTitle: button.left >= title.right - 1, height: Math.round(button.height) }; })()`);
  assert.ok(placed.right <= 20 && placed.afterTitle && placed.height >= 44, `placed at the header's end: ${JSON.stringify(placed)}`);

  // A tap where a finger lands opens the members sheet.
  const point = await app.evaluate(`(() => { const box = document.getElementById("chat-members-button").getBoundingClientRect();
    const x = box.left + box.width / 2; const y = box.top + box.height / 2; const hit = document.elementFromPoint(x, y);
    return { x, y, onTop: Boolean(hit && hit.closest("#chat-members-button")) }; })()`);
  assert.equal(point.onTop, true, "nothing covers the button");
  for (const type of ["mousePressed", "mouseReleased"]) {
    await app.send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", clickCount: 1 });
  }
  await app.waitFor(`${shown("members-sheet")} && document.getElementById("members-sheet-title").textContent === "3 members" &&
    document.querySelectorAll("#members-sheet-list .members-sheet-row").length === 3`, "the members sheet");
  assert.equal(await app.evaluate(`document.getElementById("chat-members-button").getAttribute("aria-expanded")`), "true");
  await app.evaluate(`document.getElementById("members-sheet-close").click()`);
  await app.waitFor(`!${shown("members-sheet")} && document.getElementById("chat-members-button").getAttribute("aria-expanded") === "false"`, "the sheet closed");

  // The title still opens it, as before.
  await app.evaluate(`document.getElementById("chat-members-toggle").click()`);
  await app.waitFor(shown("members-sheet"), "the members sheet from the title");
  await app.evaluate(`document.getElementById("members-sheet-close").click()`);

  // Another chat says its own number.
  await app.evaluate(`document.getElementById("back-to-chats").click()`);
  await app.waitFor(`document.getElementById("chats-screen").classList.contains("is-active") && document.getElementById("chat-members-button").hidden === true`,
    "no members button once the chat is left");
  await openChat(app, "conv-solo");
  await app.waitFor(`document.getElementById("chat-members-count").textContent === "1" &&
    document.getElementById("chat-members-button").getAttribute("aria-label") === "Members: 1 member"`, "the other chat's one member");
});

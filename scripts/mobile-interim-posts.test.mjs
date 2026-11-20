// A member's posts during its turn, on the phone (the User, 2026-11-20): what
// a member writes with its reply tool while its turn goes on is part of its
// reply, as in the CLI. The phone shows the posts inside the reply's bubble,
// in order, above the reply's final words (and above "Thinking" while it
// runs); the reply stays the chat's last row, and no turn-finished note is
// needed to find it.
//
// Played on a real hub (the User's own server) with the real PWA paired to it.
import assert from "node:assert/strict";
import test from "node:test";
import { rm } from "node:fs/promises";
import { attachApp, launchChrome, member, openChat, pairPage, serveMobileShell, startMobileHub, tempProfile } from "./mobile-hub-fixture.mjs";

const SITE_PORT = 8397;
const CDP_PORT = 9547;
const CONVERSATION = "conv-interim-posts-qa";
const TAYLOR = member("taylor");
const at = (minute) => new Date(Date.UTC(2026, 10, 20, 10, minute)).toISOString();
const posts = [
  { id: "post-1", content: "Found the cause: the label wraps.", createdAt: at(21) },
  { id: "post-2", content: "Fixing it now.", createdAt: at(22) }
];
const turn = (fields = {}, metadata = {}) => ({
  id: "t-turn",
  role: "participant",
  participantId: TAYLOR.id,
  participantLabel: "@taylor",
  content: "",
  status: "pending",
  createdAt: at(20),
  ...fields,
  metadata: { runId: "run-taylor-turn", sourceMessageId: "ask", parentMessageId: "ask", ...metadata }
});

test("a member's posts during its turn show inside its reply on the phone, in order, and the reply stays last", { timeout: 180_000 }, async () => {
  const hub = await startMobileHub();
  const site = await serveMobileShell({ port: SITE_PORT, hubOrigins: [hub.base] });
  const profile = await tempProfile("aa-mobile-interim-posts-");
  const chrome = launchChrome({ port: CDP_PORT, profile, url: `${site.origin}/`, width: 390, height: 760 });
  let app;
  try {
    await hub.createChat(CONVERSATION, { title: "Posts QA", participants: [TAYLOR], messages: [
      { id: "ask", role: "user", content: "@taylor fix the cut-off button", status: "done", createdAt: at(19) }
    ] });
    app = await attachApp({ port: CDP_PORT });
    await pairPage(app, { hub, siteOrigin: site.origin });
    await openChat(app, CONVERSATION);
    const row = `document.querySelector('#message-list .message-row[data-thread-root="t-turn"]')`;
    const shape = `(() => {
      const item = ${row};
      if (!item) return null;
      const copy = item.querySelector(".message-copy");
      const children = [...copy.children].map((child) => child.classList.contains("message-content") ? "message-content" : child.className);
      return {
        status: item.dataset.status,
        posts: [...item.querySelectorAll(".message-interim-post")].map((node) => node.textContent.trim()),
        order: children,
        own: copy.querySelector(":scope > .message-content").textContent.trim(),
        last: [...document.querySelectorAll("#message-list .message-row")].at(-1) === item,
        note: Boolean(document.querySelector("#message-list .finished-note-card"))
      };
    })()`;

    await hub.addMessages(CONVERSATION, [turn()]);
    await app.waitFor(`Boolean(${row}) && ${row}.dataset.status === "Running"`, "the turn's row appears");

    // The member posts twice during its turn: the posts are written into its
    // running reply, as its device writes them.
    await hub.updateMessages(CONVERSATION, [turn({}, { interimPosts: posts })]);
    await app.waitFor(`${row} && ${row}.querySelectorAll(".message-interim-post").length === 2`, "the posts show in the running reply");
    const running = await app.evaluate(shape);
    assert.equal(running.status, "Running", "the posts end nothing: the turn goes on");
    assert.deepEqual(running.posts, posts.map((item) => item.content), "in the order they were made");
    assert.ok(running.order.indexOf("message-interim-posts") >= 0 && running.order.indexOf("message-interim-posts") < running.order.indexOf("message-content"),
      `the posts sit above the reply's own words: ${JSON.stringify(running.order)}`);
    assert.match(running.own, /^Thinking/, "below them the reply is still thinking");
    assert.equal(running.last, true, "the reply is the chat's last row");

    // The turn ends: its final words come under the posts.
    await hub.updateMessages(CONVERSATION, [turn({ status: "done", content: "Fixed: the button no longer wraps." }, { interimPosts: posts })]);
    await app.waitFor(`${row} && ${row}.dataset.status === "Done"`, "the reply is finished");
    const done = await app.evaluate(shape);
    assert.deepEqual(done.posts, posts.map((item) => item.content), "the posts stay in the finished reply");
    assert.equal(done.own, "Fixed: the button no longer wraps.");
    assert.equal(done.last, true, "the reply is still the chat's last row");
    assert.equal(done.note, false, "no turn-finished note: nothing came below the reply");

    // A reply whose words all went out as posts still shows them.
    await hub.addMessages(CONVERSATION, [{ id: "ask-2", role: "user", content: "@taylor and the dark theme", status: "done", createdAt: at(30) }]);
    await hub.addMessages(CONVERSATION, [{
      id: "t-posts-only", role: "participant", participantId: TAYLOR.id, participantLabel: "@taylor", content: "", status: "done", createdAt: at(31),
      metadata: { runId: "run-taylor-2", sourceMessageId: "ask-2", parentMessageId: "ask-2", interimPosts: [{ id: "post-3", content: "Dark theme done too.", createdAt: at(32) }] }
    }]);
    await app.waitFor(`[...document.querySelectorAll('#message-list .message-row[data-thread-root="t-posts-only"] .message-interim-post')].some((node) => node.textContent.includes("Dark theme done too."))`,
      "a reply made only of posts is shown");
  } finally {
    app?.close();
    const exited = new Promise((resolve) => chrome.once("exit", resolve));
    chrome.kill("SIGKILL");
    await exited;
    await site.close();
    await hub.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

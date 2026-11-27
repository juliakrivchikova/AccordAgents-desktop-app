// Settings → General → Show members’ actions on the computer (the User,
// 2026-11-27) reaches the phone through the User's own server: off, a
// running reply whose live line is the step in progress says "Thinking"
// instead, and stays so when a placeholder copy of it arrives later (the
// phone keeps the text it had, and what that text is). Played on a real hub
// with the real PWA paired to it.
import assert from "node:assert/strict";
import test from "node:test";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { attachApp, launchChrome, member, openChat, pairPage, serveMobileShell, sleep, startMobileHub, tempProfile } from "./mobile-hub-fixture.mjs";

const require = createRequire(import.meta.url);
const chatChanges = require("../dist/main/main/services/chatChanges.js");
for (const key of ["mainSessionParticipantId", "chatView"]) {
  if (!chatChanges.SHARED_CONVERSATION_METADATA_KEYS.includes(key)) chatChanges.SHARED_CONVERSATION_METADATA_KEYS.push(key);
}

const SITE_PORT = 8403;
const CDP_PORT = 9553;
const CONVERSATION = "conv-member-actions-qa";
const RUN_ID = "run-member-actions-1";
const DREW = member("drew");
const STEP = "Running npm test";

test("the computer's switch hides the step in progress on the phone, both ways, and a placeholder does not bring it back", { timeout: 180_000 }, async () => {
  const hub = await startMobileHub();
  const site = await serveMobileShell({ port: SITE_PORT, hubOrigins: [hub.base] });
  const profile = await tempProfile("aa-mobile-member-actions-");
  const chrome = launchChrome({ port: CDP_PORT, profile, url: `${site.origin}/`, width: 430, height: 860 });
  let app;
  try {
    const running = {
      id: "m-run", role: "participant", participantId: DREW.id, participantLabel: "@drew", content: "", status: "pending",
      createdAt: new Date().toISOString(), metadata: { runId: RUN_ID }
    };
    await hub.createChat(CONVERSATION, { title: "Actions QA", participants: [DREW], messages: [
      { id: "m-ask", role: "user", content: "Run the tests.", status: "done", createdAt: new Date(Date.now() - 60_000).toISOString() }
    ] });
    await hub.publishCatalog({ display: { showMemberActions: false } });
    app = await attachApp({ port: CDP_PORT });
    await pairPage(app, { hub, siteOrigin: site.origin });
    await openChat(app, CONVERSATION);
    await app.waitFor(`localStorage.getItem("accordagents.display.showMemberActions") === "0"`, "the phone learned the setting from its server", 20_000);

    const lastRow = `(() => document.querySelector('#message-list .message-row[data-status="Running"]')?.textContent || "")()`;
    await hub.addMessages(CONVERSATION, [running]);
    await hub.progress(CONVERSATION, RUN_ID, "", { participantLabel: "@drew", agentProgress: { participantId: DREW.id, messageId: running.id, activity: STEP } });
    await app.waitFor(`${lastRow}.includes("Thinking")`, "off: the running reply says it is thinking", 20_000);
    assert.doesNotMatch(await app.evaluate(lastRow), /npm test/, "off: no step in progress");

    await hub.publishCatalog({ display: { showMemberActions: true } });
    await app.waitFor(`${lastRow}.includes(${JSON.stringify(STEP)})`, "on: the step in progress shows at once, without a chat change", 15_000);

    await hub.publishCatalog({ display: { showMemberActions: false } });
    await app.waitFor(`!${lastRow}.includes("npm test") && ${lastRow}.includes("Thinking")`, "off again: back to thinking", 15_000);

    // A copy that only says the member is running (the server lost the step,
    // as after a restart) keeps the text the phone had, and what it is.
    await hub.progress(CONVERSATION, RUN_ID, "", { participantLabel: "@drew", agentProgress: { participantId: DREW.id, messageId: running.id } });
    await sleep(4000);
    assert.doesNotMatch(await app.evaluate(lastRow), /npm test/, "the kept step text stays hidden");
  } finally {
    app?.close();
    chrome.kill("SIGKILL");
    await site.close();
    await hub.close();
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("with actions hidden the phone's sessions view keeps a reply's notices about the run and drops its steps", { timeout: 180_000 }, async () => {
  const MAIN = member("main", { id: "p-main", roleConfigId: "main-session", kind: "codex-cli" });
  const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const event = (n, kind, label, extra = {}) => ({ id: `a${n}`, sequence: n, kind, label, createdAt: at(5), ...extra });
  const hub = await startMobileHub();
  const site = await serveMobileShell({ port: SITE_PORT + 1, hubOrigins: [hub.base] });
  const profile = await tempProfile("aa-mobile-member-notices-");
  const chrome = launchChrome({ port: CDP_PORT + 1, profile, url: `${site.origin}/` });
  let app;
  try {
    await hub.createChat("conv-notices", {
      title: "Notices", participants: [MAIN], createdAt: at(10),
      metadata: { mainSessionParticipantId: MAIN.id, chatView: "sessions" },
      messages: [
        { id: "u0", role: "user", content: "Fix it", status: "done", createdAt: at(9), metadata: { deliveryTargets: [MAIN.id] } },
        { id: "r0", role: "participant", participantId: MAIN.id, participantLabel: "@main", content: "Stopped: sign in again.", status: "done", createdAt: at(8),
          metadata: { sourceMessageId: "u0", workedMs: 4_000, activityEvents: [
            event(1, "command", "Running npm test", { detail: "npm test" }),
            event(2, "status", "@main has produced no provider output for 5 minutes."),
            event(3, "approval", "Codex needs you to sign in again", { status: "failed" })
          ] } }
      ]
    });
    await hub.publishCatalog({ display: { showMemberActions: false } });
    app = await attachApp({ port: CDP_PORT + 1 });
    await pairPage(app, { hub, siteOrigin: site.origin });
    await openChat(app, "conv-notices");
    await app.waitFor(`localStorage.getItem("accordagents.display.showMemberActions") === "0"`, "the phone learned the setting", 20_000);
    const row = `document.querySelector('#message-list .message-row[data-thread-root="r0"]')`;
    await app.waitFor(`Boolean(${row}?.querySelector("button.sessions-worked-toggle"))`, "its Worked for opens to its notices", 20_000);
    await app.evaluate(`${row}.querySelector("button.sessions-worked-toggle").click()`);
    await app.waitFor(`${row}.querySelectorAll(".sessions-activity-row").length === 2`, "two rows: the notices", 10_000);
    const text = await app.evaluate(`${row}.innerText`);
    assert.match(text, /no provider output for 5 minutes/);
    assert.match(text, /sign in again/);
    assert.doesNotMatch(text, /npm test/, "the step is gone");
  } finally {
    app?.close();
    chrome.kill("SIGKILL");
    await site.close();
    await hub.close();
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
});

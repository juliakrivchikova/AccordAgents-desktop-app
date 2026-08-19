import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchMobileQaBrowser } from "./mobile-qa-browser.mjs";

const require = createRequire(import.meta.url);
const { attach, getJson } = require("./cdp.cjs");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktopPort = Number(process.env.ELECTRON_CDP_PORT || 9223);
const profileDir = process.env.QA_ELECTRON_USER_DATA_DIR || process.env.ACCORDAGENTS_USER_DATA_DIR;
const electronBin = path.join(repoRoot, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const expectedStaticOrigin = normalizeTrailingSlash(process.env.ACCORDAGENTS_MOBILE_STATIC_ORIGIN_URL || "https://mobile.accordagents.com/");
const expectedRelayUrl = process.env.ACCORDAGENTS_MOBILE_RELAY_URL || "wss://relay.accordagents.com/v1/relay";
const expectedOutboxUrl = process.env.ACCORDAGENTS_MOBILE_OUTBOX_URL || "https://relay.accordagents.com/v1/mailbox/events";
const expectedRelayOrigin = new URL(expectedRelayUrl).hostname;
const expectedOutboxOrigin = new URL(expectedOutboxUrl).hostname;
const participantHandle = process.env.QA_MOBILE_PARTICIPANT_HANDLE || "@drew-codex-engineer";
const participantRemote = process.env.QA_MOBILE_PARTICIPANT_REMOTE !== "0";
const expectedResultText = `mobile-control-closed-lid-${Date.now()}`;
const chatTitle = process.env.QA_MOBILE_CHAT_TITLE || `closed lid mobile control ${Date.now()}`;
const participantMention = participantHandle.startsWith("@") ? participantHandle : `@${participantHandle}`;
const messageText = `${participantMention} reply with exact phrase ${expectedResultText}`;
const runStartedAt = new Date().toISOString();

if (!profileDir) {
  throw new Error("QA_ELECTRON_USER_DATA_DIR is required so this QA script never touches the default app profile.");
}
if (!existsSync(electronBin)) {
  throw new Error(`Electron binary not found: ${electronBin}. Run npm install or npm rebuild electron.`);
}

const chromePort = await freePort();
const chromeProfileDir = await mkdtemp(path.join(os.tmpdir(), "accordagents-closed-lid-chrome-"));
let desktopProcess;
let desktop;
let phone;
let chrome;

try {
  phase("launch isolated desktop");
  desktopProcess = launchDesktop();
  await waitForCdpTarget(desktopPort, "file://", "AccordAgents", 45_000);
  desktop = await attach({ port: desktopPort, timeoutMs: 20_000 });

  phase("create fresh desktop chat");
  await ensureFreshChatOpen(desktop);
  const desktopConversationId = await waitForSqliteConversationIdByTitle(chatTitle, 30_000);
  await dismissChatChoiceIfOpen(desktop);
  await closeMobileDialogIfOpen(desktop);

  phase("generate managed mobile QR");
  await openMobilePairingDialog(desktop);
  await clickSelector(desktop, ".chat-mobile-pairing-actions button:last-child");
  await waitForSelectorPoll(desktop, ".chat-mobile-pairing-qr img", 45_000);
  const pairingState = await desktop.evaluate(`(() => ({
    mobileUrl: document.querySelector(".chat-mobile-pairing-qr")?.dataset.mobileUrl,
    fingerprint: document.querySelector(".chat-mobile-pairing-qr code")?.textContent,
    qrReady: Boolean(document.querySelector(".chat-mobile-pairing-qr img")?.src?.startsWith("data:image/png"))
  }))()`);
  const pwaUrl = new URL(pairingState.result.value.mobileUrl);
  assert.equal(`${pwaUrl.origin}/`, expectedStaticOrigin);
  assert.equal(new URL(pwaUrl.searchParams.get("outbox") || "https://invalid.test").hostname, expectedOutboxOrigin);
  assert.ok(pairingState.result.value.qrReady, "QR image must be generated.");
  pwaUrl.searchParams.set("qa", String(Date.now()));
  const routeId = pwaUrl.searchParams.get("route");
  assert.ok(routeId, "PWA URL must include stable route id.");
  const mailboxUrl = mailboxEventsUrlFromPwaUrl(pwaUrl);

  phase("wait for mailbox runner and policy");
  await waitForMobileRunnerReady(routeId, 120_000, runStartedAt);
  const policyEvent = await waitForMailboxPolicy(mailboxUrl, chatTitle, desktopConversationId, 30_000);

  phase("launch phone PWA");
  chrome = await launchMobileQaBrowser({
    repoRoot,
    url: pwaUrl.toString(),
    port: chromePort,
    profileDir: chromeProfileDir
  });
  chrome.stderr.setEncoding("utf8");
  chrome.stderr.on("data", (chunk) => {
    if (/DevTools listening/.test(chunk)) return;
    process.stderr.write(chunk);
  });

  await waitForCdpTarget(chromePort, expectedStaticOrigin, "AccordAgents", 30_000);
  phone = await attach({ port: chromePort, title: "AccordAgents", timeoutMs: 20_000 });
  await phone.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
    screenWidth: 390,
    screenHeight: 844
  });
  await waitForMobileRuntime(phone);
  await openMobileChatByTitle(phone, chatTitle);

  phase("suspend desktop process group");
  desktop.close();
  desktop = undefined;
  stopProcessGroup(desktopProcess, "SIGSTOP");
  await sleep(1500);

  phase("send phone message while desktop is suspended");
  await phone.fill("#composer-input", messageText);
  await clickSelector(phone, "#send-button");
  const acked = await waitForPhoneAck(phone, messageText);
  assert.equal(acked.conversationId, desktopConversationId);
  const runningState = await waitForPhoneAgentStatus(phone, "Running", { timeoutMs: 60_000 });
  const participantResult = await waitForPhoneAgentStatus(phone, "Done", {
    timeoutMs: 240_000,
    textIncludes: expectedResultText
  });
  const phoneUi = await readPhoneUi(phone, messageText, expectedResultText);
  assert.equal(phoneUi.connectionState, "Synced");
  assert.equal(phoneUi.messageStatus, "Sent");
  assert.equal(phoneUi.resultMessageCount, 1);

  phase("resume desktop process group");
  stopProcessGroup(desktopProcess, "SIGCONT");
  await waitForCdpTarget(desktopPort, "file://", "AccordAgents", 45_000);
  desktop = await attach({ port: desktopPort, timeoutMs: 20_000 });
  await openDesktopChatByTitle(desktop, chatTitle);
  await waitForDesktopMessage(desktop, messageText, 45_000);
  await waitForDesktopParticipantResult(desktop, expectedResultText, 90_000);

  phase("verify durable desktop replay");
  const sqliteEvidence = await waitForSqliteMobileReplay({
    conversationId: acked.conversationId,
    mobileEventId: acked.eventId,
    expectedResultText
  });
  const desktopUi = await readDesktopUi(desktop, messageText, expectedResultText);
  assert.equal(desktopUi.userMessageCount, 1);
  assert.equal(desktopUi.resultMessageCount, 1);
  const desktopIdleState = await waitForSqliteConversationIdle(acked.conversationId, `mobile-${acked.eventId}`, 60_000);
  const phoneUiAfterDesktopResume = await readPhoneUi(phone, messageText, expectedResultText);
  assert.equal(phoneUiAfterDesktopResume.resultMessageCount, 1);

  const phoneScreenshot = await phone.screenshot({ timeoutMs: 10_000 });
  const desktopScreenshot = await desktop.screenshot({ timeoutMs: 10_000 });
  const phoneScreenshotPath = path.join("screenshots", `qa-mobile-control-closed-lid-phone-${Date.now()}.png`);
  const desktopScreenshotPath = path.join("screenshots", `qa-mobile-control-closed-lid-desktop-${Date.now()}.png`);
  await writeFile(phoneScreenshotPath, phoneScreenshot.data);
  await writeFile(desktopScreenshotPath, desktopScreenshot.data);

  console.log(JSON.stringify({
    status: "PASS",
    desktopPort,
    profileDir,
    pwaOrigin: pwaUrl.origin,
    relayHost: expectedRelayOrigin,
    outboxHost: expectedOutboxOrigin,
    routeId,
    fingerprint: pairingState.result.value.fingerprint,
    chatTitle,
    policyEventId: policyEvent.eventId,
    messageText,
    mobileEventId: acked.eventId,
    conversationId: acked.conversationId,
    expectedResultText,
    runningState,
    participantResult,
    sqliteEvidence,
    desktopIdleState,
    desktopUserMessageCount: desktopUi.userMessageCount,
    desktopResultMessageCount: desktopUi.resultMessageCount,
    phoneResultMessageCountAfterDesktopResume: phoneUiAfterDesktopResume.resultMessageCount,
    phoneScreenshotPath,
    desktopScreenshotPath
  }, null, 2));
} finally {
  phone?.close();
  desktop?.close();
  if (chrome && !chrome.killed) {
    chrome.kill("SIGTERM");
    await waitForProcessExit(chrome, 5_000);
  }
  if (desktopProcess && desktopProcess.exitCode === null && desktopProcess.signalCode === null) {
    try {
      stopProcessGroup(desktopProcess, "SIGCONT");
    } catch {
      // Already gone.
    }
    stopProcessGroup(desktopProcess, "SIGTERM");
    await waitForProcessExit(desktopProcess, 10_000, true);
  }
  await rm(chromeProfileDir, { recursive: true, force: true });
}

function normalizeTrailingSlash(value) {
  const url = new URL(value);
  return `${url.origin}/`;
}

function phase(name) {
  console.error(`[qa-mobile-closed-lid] ${new Date().toISOString()} ${name}`);
}

function launchDesktop() {
  const child = spawn(electronBin, [
    ".",
    `--remote-debugging-port=${desktopPort}`,
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling"
  ], {
    cwd: repoRoot,
    detached: true,
    env: {
      ...process.env,
      ACCORDAGENTS_USER_DATA_DIR: profileDir,
      ACCORD_AGENTS_DEBUG_LOGS: "1"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => process.stderr.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  return child;
}

function stopProcessGroup(child, signal) {
  process.kill(-child.pid, signal);
}

async function ensureFreshChatOpen(client) {
  await waitForSelectorPoll(
    client,
    ".new-chat-prompt, .sidebar-history-item, button[aria-label='Mobile control'], button[title='Mobile control']",
    30_000
  );
  if (!await hasSelector(client, ".new-chat-prompt")) {
    await clickNewChat(client);
  }
  await waitForSelectorPoll(client, ".new-chat-prompt", 30_000);
  await selectNewChatParticipant(client, participantHandle);
  if (participantRemote) {
    await setNewChatParticipantRemote(client, participantHandle);
  }
  await client.fill(".new-chat-prompt", chatTitle);
  await client.evaluate(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000;
    const tick = () => {
      const button = document.querySelector(".new-chat-send");
      if (button && !button.disabled) {
        resolve(true);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error("New chat start button did not become enabled."));
        return;
      }
      setTimeout(tick, 100);
    };
    tick();
  })`, {}, { timeoutMs: 11_000 });
  await clickSelector(client, ".new-chat-send");
  await waitForSelectorPoll(client, "button[aria-label='Mobile control'], button[title='Mobile control']", 30_000);
  await settleInitialChatAssistant(client);
  await dismissSetupOverlaysIfOpen(client);
}

async function openDesktopChatByTitle(client, title) {
  await client.evaluate(`new Promise((resolve, reject) => {
    const title = ${JSON.stringify(title)};
    const deadline = Date.now() + 15000;
    const tick = () => {
      const item = [...document.querySelectorAll(".sidebar-history-item")]
        .find((candidate) => candidate.textContent.includes(title));
      if (item) {
        item.click();
        resolve(true);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error("Desktop sidebar did not contain chat title: " + title));
        return;
      }
      setTimeout(tick, 100);
    };
    tick();
  })`, {}, { timeoutMs: 16_000 });
  await waitForSelectorPoll(client, "button[aria-label='Mobile control'], button[title='Mobile control']", 20_000);
}

async function clickNewChat(client) {
  const clicked = await client.evaluate(`(() => {
    const button = [...document.querySelectorAll("button")]
      .find((candidate) => candidate.textContent.trim() === "New chat");
    if (!button) return false;
    button.click();
    return true;
  })()`, {}, { timeoutMs: 5_000 });
  if (clicked.result.value !== true) {
    throw new Error("Could not open a fresh New Chat screen.");
  }
  await waitForSelectorPoll(client, ".new-chat-prompt", 10_000);
}

async function selectNewChatParticipant(client, handle) {
  if (!await hasSelector(client, ".new-chat-participant-trigger")) {
    return;
  }
  const addLabels = participantActionLabels("Add", handle);
  const removeLabels = participantActionLabels("Remove", handle);
  if (await hasAnyAriaLabel(client, removeLabels)) {
    return;
  }
  if (!await hasAnyAriaLabel(client, addLabels)) {
    await clickSelector(client, ".new-chat-participant-trigger");
  }
  if (!await waitForOptionalAriaLabel(client, addLabels, 3_000)) {
    await clickSelector(client, ".new-chat-participant-trigger");
    await waitForAriaLabel(client, addLabels, 10_000);
  }
  await clickAriaLabel(client, addLabels);
  await sleep(200);
}

async function setNewChatParticipantRemote(client, handle) {
  const expandLabels = participantActionLabels("Expand", handle, " settings");
  await waitForAriaLabel(client, expandLabels, 10_000);
  await clickAriaLabel(client, expandLabels);
  const switchSelector = `[aria-label="Cloud Run"]`;
  await waitForSelectorPoll(client, switchSelector, 10_000);
  const checked = await client.evaluate(`(() => {
    const control = document.querySelector(${JSON.stringify(switchSelector)});
    return control?.getAttribute("aria-checked") === "true";
  })()`);
  if (checked.result.value !== true) {
    await clickSelector(client, switchSelector);
    await sleep(200);
  }
}

async function openMobilePairingDialog(client) {
  await waitForSelectorPoll(client, "button[aria-label='Mobile control'], button[title='Mobile control']", 20_000);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await settleInitialChatAssistant(client);
    await dismissChatChoiceIfOpen(client);
    await clickSelector(client, "button[aria-label='Mobile control'], button[title='Mobile control']");
    if (await waitForOptionalSelector(client, ".chat-mobile-pairing-dialog", 2_500)) {
      return;
    }
  }
  throw new Error("Mobile pairing dialog did not open. " + JSON.stringify(await readDesktopDebugState(client), null, 2));
}

async function closeMobileDialogIfOpen(client) {
  if ((await client.evaluate(`Boolean(document.querySelector(".chat-mobile-pairing-dialog"))`)).result.value) {
    await clickSelector(client, "button[aria-label='Close mobile control']");
    await sleep(250);
  }
}

async function settleInitialChatAssistant(client) {
  await sleep(500);
  await client.evaluate(`(() => {
    document.querySelector(".chat-choice-cancel")?.click();
    const runningAssistant = [...document.querySelectorAll(".chat-message.is-running")]
      .some((message) => message.textContent.includes("Chat Assistant"));
    if (runningAssistant) {
      document.querySelector(".message-action-stop")?.click();
    }
  })()`, {}, { timeoutMs: 5_000 });
  await sleep(500);
  await dismissChatChoiceIfOpen(client);
}

async function dismissChatChoiceIfOpen(client) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const clicked = await client.evaluate(`(() => {
      const button = document.querySelector(".chat-choice-cancel");
      if (!button) return false;
      button.click();
      return true;
    })()`, {}, { timeoutMs: 5_000 });
    if (clicked.result.value !== true) {
      return;
    }
    await sleep(500);
  }
}

async function dismissSetupOverlaysIfOpen(client) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const clicked = await client.evaluate(`(() => {
      const approvalSkip = document.querySelector(".chat-approval-skip");
      if (approvalSkip) {
        approvalSkip.click();
        return true;
      }
      const choiceCancel = document.querySelector(".chat-choice-cancel");
      if (choiceCancel) {
        choiceCancel.click();
        return true;
      }
      return false;
    })()`, {}, { timeoutMs: 5_000 });
    if (clicked.result.value !== true) return;
    await sleep(500);
  }
}

async function waitForMobileRuntime(client) {
  await client.evaluate(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 20000;
    const tick = () => {
      if (globalThis.AccordAgentsMobile?.loadPairing() && document.querySelector("#chat-list")) {
        resolve(true);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error("Mobile runtime did not initialize."));
        return;
      }
      setTimeout(tick, 100);
    };
    tick();
  })`, {}, { timeoutMs: 21_000 });
}

async function openMobileChatByTitle(client, title) {
  await waitForSelectorPoll(client, ".mobile-chat-row", 30_000);
  const clicked = await client.evaluate(`(() => {
    const title = ${JSON.stringify(title)};
    const rows = [...document.querySelectorAll(".mobile-chat-row")];
    const row = rows.find((candidate) => candidate.textContent.includes(title));
    if (!row) {
      return {
        clicked: false,
        rows: rows.map((candidate) => candidate.textContent.trim()).slice(0, 20)
      };
    }
    row.click();
    return { clicked: true, rows: [] };
  })()`, {}, { timeoutMs: 5_000 });
  if (clicked.result.value?.clicked !== true) {
    throw new Error("Mobile PWA chat list did not contain chat title. " +
      JSON.stringify(clicked.result.value?.rows ?? []));
  }
  await client.evaluate(`new Promise((resolve, reject) => {
    const title = ${JSON.stringify(title)};
    const deadline = Date.now() + 10000;
    const tick = () => {
      const active = document.querySelector("#timeline-screen.is-active");
      const heading = document.querySelector("#chat-title")?.textContent?.trim();
      if (active && heading === title) {
        resolve(true);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error("Mobile PWA did not open selected chat timeline: " + JSON.stringify({
          expected: title,
          heading,
          text: document.body.innerText.slice(0, 2000)
        }, null, 2)));
        return;
      }
      setTimeout(tick, 100);
    };
    tick();
  })`, {}, { timeoutMs: 11_000 });
}

async function waitForPhoneAck(client, text) {
  const result = await client.evaluate(`new Promise((resolve, reject) => {
    const text = ${JSON.stringify(text)};
    const deadline = Date.now() + 30000;
    const tick = async () => {
      const outbox = await globalThis.AccordAgentsMobile.listOutboxEntries();
      const state = document.querySelector("#connection-state")?.textContent?.trim();
      const entry = outbox.find((item) => item.payload?.content === text);
      if (state === "Synced" &&
        document.body.innerText.includes(text) &&
        document.body.innerText.includes("Sent") &&
        entry &&
        entry.status === "acked") {
        resolve({
          eventId: entry.eventId,
          conversationId: entry.conversationId,
          status: entry.status
        });
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error("Phone PWA did not reach synced/acked state. " + JSON.stringify({
          state,
          outbox: outbox.map((item) => ({
            eventId: item.eventId,
            conversationId: item.conversationId,
            status: item.status,
            content: item.payload?.content,
            lastError: item.lastError
          })),
          text: document.body.innerText.slice(0, 2000),
          relayDebug: globalThis.__relayDebug || []
        }, null, 2)));
        return;
      }
      setTimeout(tick, 100);
    };
    tick();
  })`, {}, { timeoutMs: 31_000 });
  return result.result.value;
}

async function waitForPhoneAgentStatus(client, expectedStatus, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const textIncludes = options.textIncludes;
  const result = await client.evaluate(`new Promise((resolve, reject) => {
    const expectedStatus = ${JSON.stringify(expectedStatus)};
    const textIncludes = ${JSON.stringify(textIncludes ?? "")};
    const deadline = Date.now() + ${JSON.stringify(timeoutMs)};
    const readRows = () => [...document.querySelectorAll("#message-list .message-row")].map((row) => ({
      author: row.dataset.author,
      status: row.dataset.status,
      text: row.innerText
    }));
    const tick = () => {
      const rows = readRows();
      const match = rows.find((row) =>
        row.author === "agent" &&
          row.status === expectedStatus &&
          (!textIncludes || row.text.includes(textIncludes))
      );
      if (match) {
        resolve({ status: match.status, text: match.text.slice(0, 500) });
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error("Phone PWA did not render agent " + expectedStatus + " without reload. " + JSON.stringify({
          rows,
          state: document.querySelector("#connection-state")?.textContent?.trim(),
          relayDebug: globalThis.__relayDebug || []
        }, null, 2)));
        return;
      }
      setTimeout(tick, 250);
    };
    tick();
  })`, {}, { timeoutMs: timeoutMs + 1_000 });
  return result.result.value;
}

async function readPhoneUi(client, text, expected) {
  const result = await client.evaluate(`(() => ({
    connectionState: document.querySelector("#connection-state")?.textContent?.trim(),
    messageStatus: document.body.innerText.includes(${JSON.stringify(text)}) && document.body.innerText.includes("Sent") ? "Sent" : undefined,
    resultMessageCount: [...document.querySelectorAll(".message-row[data-author='agent']")]
      .filter((message) => message.innerText.includes(${JSON.stringify(expected)})).length,
    text: document.body.innerText.slice(0, 2000)
  }))()`);
  return result.result.value;
}

async function readDesktopUi(client, text, expected) {
  const result = await client.evaluate(`(() => ({
    hasUserMessage: document.body.innerText.includes(${JSON.stringify(text)}),
    hasResult: document.body.innerText.includes(${JSON.stringify(expected)}),
    userMessageCount: [...document.querySelectorAll(".chat-message.user")]
      .filter((message) => message.innerText.includes(${JSON.stringify(text)})).length,
    resultMessageCount: [...document.querySelectorAll(".chat-message:not(.user)")]
      .filter((message) => message.innerText.includes(${JSON.stringify(expected)})).length,
    textTail: document.body.innerText.slice(-2500)
  }))()`);
  return result.result.value;
}

async function waitForDesktopMessage(client, text, timeoutMs) {
  await client.evaluate(`new Promise((resolve, reject) => {
    const text = ${JSON.stringify(text)};
    const deadline = Date.now() + ${JSON.stringify(timeoutMs)};
    const tick = () => {
      if (document.body.innerText.includes(text)) {
        resolve(true);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error("Desktop conversation did not render expected text: " + text));
        return;
      }
      setTimeout(tick, 250);
    };
    tick();
  })`, {}, { timeoutMs: timeoutMs + 1_000 });
}

async function waitForDesktopParticipantResult(client, text, timeoutMs) {
  await client.evaluate(`new Promise((resolve, reject) => {
    const text = ${JSON.stringify(text)};
    const deadline = Date.now() + ${JSON.stringify(timeoutMs)};
    const tick = () => {
      const match = [...document.querySelectorAll(".chat-message:not(.user)")]
        .some((message) => message.innerText.includes(text));
      if (match) {
        resolve(true);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error("Desktop conversation did not render expected participant result: " + text));
        return;
      }
      setTimeout(tick, 250);
    };
    tick();
  })`, {}, { timeoutMs: timeoutMs + 1_000 });
}

async function waitForSqliteMobileReplay({ conversationId, mobileEventId, expectedResultText }) {
  const deadline = Date.now() + 60_000;
  let last;
  while (Date.now() < deadline) {
    const messages = readSqliteMessages(conversationId);
    const mobileUsers = messages.filter((message) =>
      message.role === "user" &&
        message.metadata?.appMessageSource === "mobile-relay" &&
        message.metadata?.mobileEventId === mobileEventId
    );
    const participantResults = messages.filter((message) =>
      message.role === "participant" &&
        message.metadata?.runId === `mobile-${mobileEventId}` &&
        (
          message.metadata?.mobileEventId === mobileEventId ||
          message.metadata?.sourceMessageId === mobileEventId
        ) &&
        message.content.includes(expectedResultText)
    );
    const pendingDuplicates = messages.filter((message) =>
      message.role === "participant" &&
        message.metadata?.runId === `mobile-${mobileEventId}` &&
        message.status === "pending"
    );
    last = {
      totalMessages: messages.length,
      mobileUserCount: mobileUsers.length,
      participantResultCount: participantResults.length,
      pendingDuplicateCount: pendingDuplicates.length
    };
    if (mobileUsers.length === 1 && participantResults.length === 1 && pendingDuplicates.length === 0) {
      return last;
    }
    await sleep(1000);
  }
  throw new Error("Desktop SQLite did not converge to one mobile user event and one cloud result. " + JSON.stringify(last, null, 2));
}

function readSqliteMessages(conversationId) {
  const dbPath = path.join(profileDir, "accordagents.sqlite3");
  const escapedConversationId = conversationId.replace(/'/g, "''");
  const result = spawnSync("sqlite3", [
    "-cmd",
    ".timeout 5000",
    dbPath,
    `select hex(payload_json) from conversation_messages where conversation_id='${escapedConversationId}' order by sequence;`
  ], { encoding: "utf8" });
  if (result.status !== 0) {
    if (/database is locked|SQLITE_BUSY/i.test(result.stderr || result.stdout)) {
      return [];
    }
    throw new Error(`sqlite3 failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((hex) => JSON.parse(Buffer.from(hex, "hex").toString("utf8")));
}

async function waitForSqliteConversationIdByTitle(title, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastTitles = [];
  while (Date.now() < deadline) {
    const conversations = readSqliteConversations();
    lastTitles = conversations.map((conversation) => conversation.title).filter(Boolean).slice(0, 20);
    const match = conversations.find((conversation) => conversation.title === title);
    if (match?.id) {
      return match.id;
    }
    await sleep(500);
  }
  throw new Error(`Conversation not found in SQLite by title: ${title}. Recent titles: ${JSON.stringify(lastTitles)}`);
}

function readSqliteConversations() {
  const dbPath = path.join(profileDir, "accordagents.sqlite3");
  const result = spawnSync("sqlite3", [
    "-cmd",
    ".timeout 5000",
    dbPath,
    "select id || char(9) || hex(payload_json) from conversations order by updated_at desc;"
  ], { encoding: "utf8" });
  if (result.status !== 0) {
    if (/database is locked|SQLITE_BUSY/i.test(result.stderr || result.stdout)) {
      return [];
    }
    throw new Error(`sqlite3 failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [id, hex] = line.split("\t");
      const payload = JSON.parse(Buffer.from(hex, "hex").toString("utf8"));
      return { id, title: payload.title };
    });
}

async function waitForSqliteConversationIdle(conversationId, runId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    let conversation;
    try {
      conversation = readSqliteConversation(conversationId);
    } catch (error) {
      if (isSqliteBusyError(error)) {
        last = { sqliteBusy: true, message: error instanceof Error ? error.message : String(error) };
        await sleep(500);
        continue;
      }
      throw error;
    }
    const metadata = conversation.metadata ?? {};
    const activeRunIds = Array.isArray(metadata.activeRunIds) ? metadata.activeRunIds : [];
    const activeRunParticipants = metadata.activeRunParticipants && typeof metadata.activeRunParticipants === "object"
      ? Object.keys(metadata.activeRunParticipants)
      : [];
    const remoteRunHandles = metadata.remoteRunHandles && typeof metadata.remoteRunHandles === "object"
      ? metadata.remoteRunHandles
      : {};
    const mobileRunHandle = remoteRunHandles[runId];
    last = {
      running: metadata.running === true,
      runId: metadata.runId,
      activeRunIds,
      activeRunParticipants,
      mobileRunPhase: mobileRunHandle?.phase,
      mobileRunTerminal: mobileRunHandle?.terminal === true
    };
    if (!last.running && activeRunIds.length === 0 && activeRunParticipants.length === 0) {
      await sleep(1500);
      return last;
    }
    await sleep(500);
  }
  throw new Error("Desktop SQLite did not reach idle before shutdown. " + JSON.stringify(last, null, 2));
}

function isSqliteBusyError(error) {
  return error instanceof Error && /database is locked|SQLITE_BUSY/i.test(error.message);
}

function readSqliteConversation(conversationId) {
  const dbPath = path.join(profileDir, "accordagents.sqlite3");
  const escapedConversationId = conversationId.replace(/'/g, "''");
  const result = spawnSync("sqlite3", [
    "-cmd",
    ".timeout 5000",
    dbPath,
    `select hex(payload_json) from conversations where id='${escapedConversationId}';`
  ], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`sqlite3 failed: ${result.stderr || result.stdout}`);
  }
  const hex = result.stdout.trim();
  if (!hex) {
    throw new Error(`Conversation not found in SQLite: ${conversationId}`);
  }
  return JSON.parse(Buffer.from(hex, "hex").toString("utf8"));
}

async function waitForMobileRunnerReady(routeId, timeoutMs, afterIso) {
  return waitForDebugLog("mobile.runner.ready", routeId, timeoutMs, afterIso, {
    failureEvents: new Set(["mobile.runner.not-started", "mobile.runner.start-error"])
  });
}

async function waitForDebugLog(eventName, routeId, timeoutMs, afterIso, options = {}) {
  const logPath = path.join(profileDir, "debug-logs", `${new Date().toISOString().slice(0, 10)}.jsonl`);
  const deadline = Date.now() + timeoutMs;
  const afterMs = afterIso ? Date.parse(afterIso) : 0;
  const failureEvents = options.failureEvents instanceof Set ? options.failureEvents : new Set();
  let lastContent = "";
  while (Date.now() < deadline) {
    try {
      lastContent = await readFile(logPath, "utf8");
      const entries = lastContent
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try { return JSON.parse(line); } catch { return undefined; }
        });
      const failure = entries.find((entry) =>
        failureEvents.has(entry?.event) &&
          entry.routingId === routeId &&
          (!afterMs || Date.parse(entry.timestamp || "") >= afterMs)
      );
      if (failure) {
        throw new Error(`Debug log reported ${failure.event} for ${routeId}: ${JSON.stringify({
          reason: failure.reason,
          message: failure.message,
          exitCode: failure.exitCode,
          timedOut: failure.timedOut,
          stderr: failure.stderr,
          stdout: failure.stdout
        }, null, 2)}`);
      }
      const match = entries.find((entry) =>
          entry?.event === eventName &&
          entry.routingId === routeId &&
          (!afterMs || Date.parse(entry.timestamp || "") >= afterMs)
        );
      if (match) {
        return match;
      }
    } catch {
      // Keep polling until the app writes the debug log.
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for debug log ${eventName} for ${routeId}. Tail: ${lastContent.slice(-4000)}`);
}

async function waitForMailboxPolicy(mailboxUrl, title, conversationId, timeoutMs) {
  const scopedUrl = new URL(mailboxUrl.toString());
  scopedUrl.searchParams.set("conversationId", conversationId);
  scopedUrl.searchParams.set("logScopeId", conversationId);
  scopedUrl.searchParams.set("limit", "100");
  const deadline = Date.now() + timeoutMs;
  let lastEvents = [];
  while (Date.now() < deadline) {
    const body = await fetchJson(scopedUrl.toString());
    lastEvents = Array.isArray(body.events) ? body.events : [];
    const policy = lastEvents.find((event) =>
      event.kind === "mobile.runner.policy" &&
        event.payload?.type === "mobile.runner.policy" &&
        event.payload?.title === title
    );
    if (policy) {
      return policy;
    }
    await sleep(500);
  }
  throw new Error(`Mailbox did not receive runner policy for ${title}. Events: ${JSON.stringify(lastEvents.map((event) => ({
    eventId: event.eventId,
    kind: event.kind,
    conversationId: event.conversationId,
    title: event.payload?.title
  })), null, 2)}`);
}

function mailboxEventsUrlFromPwaUrl(pwaUrl) {
  const outbox = pwaUrl.searchParams.get("outbox");
  if (outbox) {
    const url = new URL(outbox);
    url.searchParams.set("limit", "500");
    return url;
  }
  const relay = pwaUrl.searchParams.get("relay") || "wss://relay.accordagents.com/v1/relay";
  const route = pwaUrl.searchParams.get("route");
  const url = new URL("/v1/mailbox/events", relay);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  if (route) {
    url.searchParams.set("mailboxId", route);
  }
  url.searchParams.set("limit", "500");
  return url;
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`GET ${url} failed with HTTP ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function hasSelector(client, selector) {
  const result = await client.evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
  return result.result.value === true;
}

function participantActionLabels(action, handle, suffix = "") {
  const bare = handle.replace(/^@/, "");
  const display = `@${bare}`;
  return [...new Set([
    `${action} ${handle}${suffix}`,
    `${action} ${display}${suffix}`,
    `${action} ${bare}${suffix}`
  ])];
}

async function hasAnyAriaLabel(client, labels) {
  const result = await client.evaluate(`(() => {
    const labels = ${JSON.stringify(labels)};
    return [...document.querySelectorAll("[aria-label]")]
      .some((element) => labels.includes(element.getAttribute("aria-label")));
  })()`, {}, { timeoutMs: 5_000 });
  return result.result.value === true;
}

async function waitForOptionalAriaLabel(client, labels, timeoutMs) {
  try {
    await waitForAriaLabel(client, labels, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

async function waitForAriaLabel(client, labels, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await hasAnyAriaLabel(client, labels)) {
      return true;
    }
    await sleep(100);
  }
  const labelsInDom = await client.evaluate(`(() => [...document.querySelectorAll("[aria-label]")]
    .map((element) => element.getAttribute("aria-label"))
    .filter(Boolean)
    .slice(0, 80))()`, {}, { timeoutMs: 5_000 });
  throw new Error(`ARIA label not found: ${labels.join(" | ")}. Visible labels: ${JSON.stringify(labelsInDom.result.value)}`);
}

async function clickAriaLabel(client, labels) {
  const clicked = await client.evaluate(`(() => {
    const labels = ${JSON.stringify(labels)};
    const element = [...document.querySelectorAll("[aria-label]")]
      .find((candidate) => labels.includes(candidate.getAttribute("aria-label")));
    if (!element) return false;
    element.scrollIntoView({ block: "center", inline: "center" });
    element.click();
    return true;
  })()`, {}, { timeoutMs: 5_000 });
  if (clicked.result.value !== true) {
    throw new Error(`Could not click ARIA label: ${labels.join(" | ")}`);
  }
}

async function waitForOptionalSelector(client, selector, timeoutMs) {
  try {
    await waitForSelectorPoll(client, selector, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

async function waitForSelectorPoll(client, selector, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await hasSelector(client, selector)) {
        return true;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw lastError ?? new Error(`Selector not found: ${selector}`);
}

async function clickSelector(client, selector, timeoutMs = 10_000) {
  await waitForSelectorPoll(client, selector, timeoutMs);
  const clicked = await client.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return false;
    element.click();
    return true;
  })()`, {}, { timeoutMs: 5_000 });
  if (clicked.result.value !== true) {
    throw new Error(`Could not click selector: ${selector}`);
  }
}

async function readDesktopDebugState(client) {
  const result = await client.evaluate(`(() => ({
    title: document.title,
    mobileButtonCount: document.querySelectorAll("button[aria-label='Mobile control'], button[title='Mobile control']").length,
    dialogVisible: Boolean(document.querySelector(".chat-mobile-pairing-dialog")),
    buttons: [...document.querySelectorAll("button")].map((button) => ({
      text: button.textContent.trim(),
      aria: button.getAttribute("aria-label"),
      title: button.getAttribute("title"),
      disabled: button.disabled
    })).slice(0, 80),
    text: document.body.innerText.slice(0, 3000)
  }))()`, {}, { timeoutMs: 5_000 });
  return result.result.value;
}

async function waitForCdpTarget(debugPort, urlPrefix, expectedTitle, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastTargets = [];
  while (Date.now() < deadline) {
    try {
      lastTargets = await getJson("/json", { port: debugPort, timeoutMs: 1000 });
      const target = lastTargets.find((entry) =>
        entry.type === "page" &&
          typeof entry.url === "string" &&
          entry.url.startsWith(urlPrefix) &&
          (!expectedTitle || entry.title === expectedTitle)
      );
      if (target) {
        return target;
      }
    } catch {
      // Keep polling until the debugging endpoint appears.
    }
    await sleep(250);
  }
  throw new Error(`CDP page target did not appear for ${urlPrefix}: ${JSON.stringify(lastTargets)}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close(() => {
        if (!port) reject(new Error("Failed to allocate a local port."));
        else resolve(port);
      });
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForProcessExit(child, timeoutMs, killGroup = false) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      try {
        if (killGroup) stopProcessGroup(child, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      resolve();
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

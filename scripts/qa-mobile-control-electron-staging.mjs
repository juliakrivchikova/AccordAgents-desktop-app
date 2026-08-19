import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
const defaultManagedRelayUrl = "wss://relay.accordagents.com/v1/relay";
const expectedRelayUrl = process.env.ACCORDAGENTS_MOBILE_RELAY_URL || defaultManagedRelayUrl;
const expectedRelayOrigin = new URL(expectedRelayUrl).hostname;
const expectedStaticOrigin = normalizeTrailingSlash(process.env.ACCORDAGENTS_MOBILE_STATIC_ORIGIN_URL || "https://mobile.accordagents.com/");
const expectedResultText = `mobile-control-e2e-${Date.now()}`;
const participantHandle = process.env.QA_MOBILE_PARTICIPANT_HANDLE || "@drew-codex-engineer";
const participantRemote = process.env.QA_MOBILE_PARTICIPANT_REMOTE === "1";
const forceNewChat = process.env.QA_MOBILE_FORCE_NEW_CHAT === "1";
const chatTitle = process.env.QA_MOBILE_CHAT_TITLE || `staging mobile control setup ${Date.now()}`;
const requestedExistingChatTitle = process.env.QA_MOBILE_CHAT_TITLE && !forceNewChat ? chatTitle : "";
const participantMention = participantHandle.startsWith("@") ? participantHandle : `@${participantHandle}`;
const messageText = `${participantMention} reply with exact phrase ${expectedResultText}`;

const chromePort = await freePort();
const profileDir = await mkdtemp(path.join(os.tmpdir(), "accordagents-mobile-control-chrome-"));
let chrome;
let desktop;
let phone;

try {
  phase("attach desktop");
  const desktopTarget = await waitForCdpTarget(desktopPort, "file://");
  desktop = await attach({ port: desktopPort, title: desktopTarget.title, timeoutMs: 20_000 });
  phase("ensure chat open");
  await ensureChatOpen(desktop);
  if (forceNewChat) {
    phase("select fresh desktop chat");
    await openDesktopChatByTitle(desktop, chatTitle);
  }
  await dismissChatChoiceIfOpen(desktop);
  await closeMobileDialogIfOpen(desktop);
  phase("open mobile pairing dialog");
  await openMobilePairingDialog(desktop);

  phase("verify managed endpoint UI");
  const managedEndpointState = await desktop.evaluate(`(() => ({
    hasRelayInput: Boolean(document.querySelector("#mobile-relay-url")),
    hasStaticOriginInput: Boolean(document.querySelector("#mobile-static-origin")),
    hasOutboxInput: Boolean(document.querySelector("#mobile-outbox-url")),
    hasInvitePerson: document.body.innerText.includes("Invite person"),
    hasCustomEndpoints: document.body.innerText.includes("Custom endpoints"),
    actions: [...document.querySelectorAll(".chat-mobile-pairing-actions button")]
      .map((button) => button.textContent.trim())
  }))()`);
  assert.equal(managedEndpointState.result.value.hasInvitePerson, false);
  assert.equal(managedEndpointState.result.value.hasRelayInput, false);
  assert.equal(managedEndpointState.result.value.hasStaticOriginInput, false);
  assert.equal(managedEndpointState.result.value.hasOutboxInput, false);
  assert.equal(managedEndpointState.result.value.hasCustomEndpoints, false);
  assert.deepEqual(managedEndpointState.result.value.actions, ["Revoke", "Copy URL", "Generate"]);
  phase("generate QR");
  await clickSelector(desktop, ".chat-mobile-pairing-actions button:last-child");
  await waitForSelectorPoll(desktop, ".chat-mobile-pairing-qr img", 120_000);

  phase("read pairing state");
  const pairingState = await desktop.evaluate(`(() => ({
    mobileUrl: document.querySelector(".chat-mobile-pairing-qr")?.dataset.mobileUrl,
    purpose: document.querySelector(".chat-mobile-pairing-qr")?.dataset.pairingPurpose,
    fingerprint: document.querySelector(".chat-mobile-pairing-qr code")?.textContent,
    qrReady: Boolean(document.querySelector(".chat-mobile-pairing-qr img")?.src?.startsWith("data:image/png")),
    copyButtonText: [...document.querySelectorAll(".chat-mobile-pairing-actions button")].map((button) => button.textContent.trim())[0]
  }))()`);
  const pwaUrl = pairingState.result.value.mobileUrl;
  const parsedPwaUrl = new URL(pwaUrl);
  assert.equal(`${parsedPwaUrl.origin}/`, expectedStaticOrigin);
  assert.ok(parsedPwaUrl.searchParams.get("rid"), "PWA URL must include rendezvous id.");
  assert.ok(parsedPwaUrl.searchParams.get("route"), "PWA URL must include stable route id.");
  assert.ok(parsedPwaUrl.searchParams.get("cap"), "PWA URL must include relay capability.");
  if (expectedRelayUrl === defaultManagedRelayUrl) {
    assert.equal(parsedPwaUrl.searchParams.get("relay"), null, "Managed relay URL should not be repeated in the QR.");
  } else {
    assert.equal(parsedPwaUrl.searchParams.get("relay"), expectedRelayUrl, "Endpoint override must be carried in the QR.");
  }
  const compactKey = new URLSearchParams(parsedPwaUrl.hash.slice(1)).get("k");
  assert.ok(compactKey, "PWA URL must include the relay sealing key fragment.");
  assert.equal(pairingState.result.value.purpose, "phone-control");
  assert.equal(pairingState.result.value.qrReady, true);
  parsedPwaUrl.searchParams.set("qa", String(Date.now()));

  phase("launch phone chrome");
  chrome = await launchMobileQaBrowser({
    repoRoot,
    url: parsedPwaUrl.toString(),
    port: chromePort,
    profileDir
  });
  chrome.stderr.setEncoding("utf8");
  chrome.stderr.on("data", (chunk) => {
    if (/DevTools listening/.test(chunk)) return;
    process.stderr.write(chunk);
  });

  phase("wait for phone target");
  const phoneTarget = await waitForCdpTarget(chromePort, expectedStaticOrigin, "AccordAgents");
  await sleep(500);
  phase("attach phone");
  phone = await attach({ port: chromePort, title: phoneTarget.title, timeoutMs: 20_000 });
  await phone.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
    screenWidth: 390,
    screenHeight: 844
  });
  phase("wait for mobile runtime");
  await waitForSelectorPoll(phone, "#composer-input", 20_000);
  await waitForMobileRuntime(phone);
  phase("open paired mobile chat");
  await openMobileChatByTitle(phone, chatTitle);
  phase("send phone message");
  await phone.fill("#composer-input", messageText);
  await clickSelector(phone, "#send-button");
  phase("wait for phone ack");
  await waitForPhoneAck(phone, messageText);
  phase("wait for desktop message");
  await waitForDesktopMessage(desktop, messageText);
  phase("wait for phone running");
  const runningState = await waitForPhoneAgentStatus(phone, "Running");
  phase("wait for phone done");
  const participantResult = await waitForPhoneAgentStatus(phone, "Done", {
    timeoutMs: 120_000,
    textIncludes: expectedResultText
  });

  phase("read final UI");
  const phoneUi = await readPhoneUi(phone, messageText, expectedResultText);
  const desktopUi = await readDesktopUi(desktop, messageText);
  assert.equal(phoneUi.connectionState, "Synced");
  assert.equal(phoneUi.messageStatus, "Sent");
  assert.equal(phoneUi.messageText, messageText);
  assert.equal(phoneUi.resultMessageCount, 1);
  assert.equal(desktopUi.hasMessage, true);
  assert.equal(desktopUi.userMessageCount, 1);

  const phoneScreenshot = await phone.screenshot({ timeoutMs: 10_000 });
  const desktopScreenshot = await desktop.screenshot({ timeoutMs: 10_000 });
  const phoneScreenshotPath = path.join("screenshots", `qa-mobile-control-phone-${Date.now()}.png`);
  const desktopScreenshotPath = path.join("screenshots", `qa-mobile-control-desktop-${Date.now()}.png`);
  await writeFile(phoneScreenshotPath, phoneScreenshot.data);
  await writeFile(desktopScreenshotPath, desktopScreenshot.data);

  console.log(JSON.stringify({
    status: "PASS",
    desktopPort,
    pwaOrigin: parsedPwaUrl.origin,
    relayHost: expectedRelayOrigin,
    fingerprint: pairingState.result.value.fingerprint,
    chatTitle,
    messageText,
    expectedResultText,
    runningState,
    participantResult,
    desktopUserMessageCount: desktopUi.userMessageCount,
    phoneScreenshotPath,
    desktopScreenshotPath
  }, null, 2));
} finally {
  phone?.close();
  desktop?.close();
  if (chrome && !chrome.killed) {
    chrome.kill("SIGTERM");
  }
  await rm(profileDir, { recursive: true, force: true });
}

function normalizeTrailingSlash(value) {
  const url = new URL(value);
  return `${url.origin}/`;
}

function phase(name) {
  console.error(`[qa-mobile-control] ${new Date().toISOString()} ${name}`);
}

async function ensureChatOpen(client) {
  if (forceNewChat) {
    if (!await hasSelector(client, ".new-chat-prompt")) {
      await clickNewChat(client);
    }
    await startFreshChat(client);
    return;
  }
  if (requestedExistingChatTitle) {
    await openDesktopChatByTitle(client, requestedExistingChatTitle);
    await settleInitialChatAssistant(client);
    await dismissSetupOverlaysIfOpen(client);
    return;
  }
  if (await hasSelector(client, "button[aria-label='Mobile control'], button[title='Mobile control']")) {
    await settleInitialChatAssistant(client);
    await dismissChatChoiceIfOpen(client);
    return;
  }
  if (await hasSelector(client, ".sidebar-history-item")) {
    await clickSelector(client, ".sidebar-history-item");
    if (await waitForOptionalSelector(client, "button[aria-label='Mobile control'], button[title='Mobile control']", 10_000)) {
      await settleInitialChatAssistant(client);
      await dismissSetupOverlaysIfOpen(client);
      return;
    }
    await clickNewChat(client);
  }
  if (!await waitForOptionalSelector(client, ".new-chat-prompt", 30_000)) {
    throw new Error("No open chat and no new-chat prompt was available.");
  }
  await startFreshChat(client);
}

async function startFreshChat(client) {
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
    const deadline = Date.now() + 10000;
    const tick = () => {
      const item = [...document.querySelectorAll(".sidebar-history-item")]
        .find((candidate) => candidate.textContent.includes(title));
      if (item) {
        item.click();
        resolve(true);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error("Desktop sidebar did not contain fresh chat title: " + title));
        return;
      }
      setTimeout(tick, 100);
    };
    tick();
  })`, {}, { timeoutMs: 11_000 });
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
    element.scrollIntoView({ block: "center", inline: "center" });
    element.click();
    return true;
  })()`, {}, { timeoutMs: 5_000 });
  if (clicked.result.value !== true) {
    throw new Error(`Could not click selector: ${selector}`);
  }
}

async function dismissChatChoiceIfOpen(client) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const clicked = await client.evaluate(`(() => {
      const button = document.querySelector(".chat-choice-cancel");
      if (!button) { return false; }
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

async function closeMobileDialogIfOpen(client) {
  const hasDialog = await client.evaluate(`Boolean(document.querySelector(".chat-mobile-pairing-dialog"))`);
  if (hasDialog.result.value) {
    await clickSelector(client, "button[aria-label='Close mobile control']");
    await sleep(250);
  }
}

async function openMobilePairingDialog(client) {
  await waitForSelectorPoll(client, "button[aria-label='Mobile control'], button[title='Mobile control']", 20_000);
  await settleInitialChatAssistant(client);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await dismissChatChoiceIfOpen(client);
    await clickSelector(client, "button[aria-label='Mobile control'], button[title='Mobile control']");
    if (await waitForOptionalSelector(client, ".chat-mobile-pairing-dialog", 1_500)) {
      return;
    }
  }
  await waitForSelectorPoll(client, ".chat-mobile-pairing-dialog", 20_000);
}

async function waitForMobileRuntime(client) {
  await client.evaluate(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 15000;
    const tick = () => {
      if (globalThis.AccordAgentsMobile?.loadPairing() && document.querySelector("#composer-input")) {
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
  })`, {}, { timeoutMs: 16_000 });
}

async function openMobileChatByTitle(client, title) {
  await waitForSelectorPoll(client, ".mobile-chat-row", 20_000);
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
    throw new Error("Mobile PWA chat list did not contain fresh chat title. " +
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
        reject(new Error("Mobile PWA did not open the selected chat timeline: " + JSON.stringify({
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

async function waitForPhoneAck(client, expectedMessageText) {
  await client.evaluate(`new Promise((resolve, reject) => {
    const messageText = ${JSON.stringify(expectedMessageText)};
    const deadline = Date.now() + 20000;
    const tick = async () => {
      const outbox = await globalThis.AccordAgentsMobile.listOutboxEntries();
      const state = document.querySelector("#connection-state")?.textContent?.trim();
      if (state === "Synced" &&
        document.body.innerText.includes(messageText) &&
        document.body.innerText.includes("Sent") &&
        outbox.length > 0 &&
        outbox.every((entry) => entry.status === "acked")) {
        resolve(true);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error("Phone PWA did not reach synced/acked state. " + JSON.stringify({
          state,
          activeScreen: document.querySelector("#timeline-screen.is-active") ? "timeline" : "chats",
          outbox,
          relayDebug: globalThis.__relayDebug || [],
          text: document.body.innerText.slice(0, 2000)
        }, null, 2)));
        return;
      }
      setTimeout(tick, 100);
    };
    tick();
  })`, {}, { timeoutMs: 21_000 });
}

async function waitForDesktopMessage(client, text) {
  await client.evaluate(`new Promise((resolve, reject) => {
    const text = ${JSON.stringify(text)};
    const deadline = Date.now() + 20000;
    const tick = () => {
      if (document.body.innerText.includes(text)) {
        resolve(true);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error("Desktop conversation did not render mobile message."));
        return;
      }
      setTimeout(tick, 100);
    };
    tick();
  })`, {}, { timeoutMs: 21_000 });
}

async function readPhoneUi(client, text, expected) {
  const result = await client.evaluate(`(() => ({
    connectionState: document.querySelector("#connection-state")?.textContent?.trim(),
    messageText: ${JSON.stringify(text)},
    messageStatus: document.body.innerText.includes(${JSON.stringify(text)}) && document.body.innerText.includes("Sent") ? "Sent" : undefined,
    resultMessageCount: [...document.querySelectorAll(".message-row[data-author='agent']")]
      .filter((message) => message.innerText.includes(${JSON.stringify(expected)})).length,
    screenLabel: document.querySelector(".mobile-phone")?.dataset.screenLabel
  }))()`);
  return result.result.value;
}

async function readDesktopUi(client, text) {
  const result = await client.evaluate(`(() => ({
    hasMessage: document.body.innerText.includes(${JSON.stringify(text)}),
    userMessageCount: [...document.querySelectorAll(".chat-message.user")]
      .filter((message) => message.innerText.includes(${JSON.stringify(text)})).length,
    textTail: document.body.innerText.slice(-2000)
  }))()`);
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
        resolve({
          status: match.status,
          text: match.text.slice(0, 500)
        });
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

async function waitForCdpTarget(debugPort, urlPrefix, expectedTitle) {
  const deadline = Date.now() + 20_000;
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
      // Keep polling until Chrome exposes the debugging endpoint.
    }
    await sleep(250);
  }
  throw new Error(`Chrome page target did not appear for ${urlPrefix}: ${JSON.stringify(lastTargets)}`);
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

function waitForProcessExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve();
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once("exit", onExit);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
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
const relayUrl = process.env.ACCORDAGENTS_MOBILE_RELAY_URL || "wss://relay.accordagents.com/v1/relay";
const staticOriginUrl = normalizeTrailingSlash(process.env.ACCORDAGENTS_MOBILE_STATIC_ORIGIN_URL || "https://mobile.accordagents.com/");
const mailboxUrl = process.env.ACCORDAGENTS_MOBILE_MAILBOX_URL || managedMailboxUrlFromRelayUrl(relayUrl);
const outboxUrl = process.env.ACCORDAGENTS_MOBILE_OUTBOX_URL || managedOutboxUrlFromRelayUrl(relayUrl);

const { RelayTunnelClient } = await import("../dist/main/main/services/relayTunnelClient.js");
const { sealMobileRelayPayload, openMobileRelayPayload } = await import("../dist/main/main/services/mobileRelaySealing.js");
const { mobilePairingPwaUrl } = await import("../dist/main/shared/mobilePairing.js");
const { CLOUDFLARE_DURABLE_OBJECT_RELAY_MANIFEST } = await import("../dist/main/shared/relayProtocol.js");

const port = await freePort();
const profileDir = await mkdtemp(path.join(os.tmpdir(), "accordagents-mobile-chrome-"));
let chrome;
let desktop;
let cdp;
const chromeOutput = [];
const desktopStates = [];
const participantResultText = "cloud participant staging result";
const markdownResultText = "**Markdown result**\n\n- first item\n- second item\n\n`inline-code`";

try {
  const pairing = createPairing();
  const conversationId = `conversation-${randomUUID()}`;
  const qaUrl = new URL(mobilePairingPwaUrl(pairing, staticOriginUrl));
  qaUrl.searchParams.set("qa", randomUUID());

  desktop = new RelayTunnelClient({
    relayUrl,
    rendezvousId: pairing.rendezvousId,
    role: "desktop",
    capability: pairing.fingerprint,
    streamId: `${pairing.stableRoutingId}:phone`,
    manifest: CLOUDFLARE_DURABLE_OBJECT_RELAY_MANIFEST,
    reconnectDelayMs: 500
  });
  desktop.on("state", (state) => desktopStates.push(state));

  const initialChatList = nextMessage(desktop, { timeoutMs: 45_000 });
  await desktop.connect();

  chrome = await launchMobileQaBrowser({
    repoRoot,
    url: qaUrl.toString(),
    port,
    profileDir
  });
  chrome.stderr.setEncoding("utf8");
  chrome.stdout.setEncoding("utf8");
  chrome.stdout.on("data", (chunk) => {
    chromeOutput.push(String(chunk));
  });
  chrome.stderr.on("data", (chunk) => {
    chromeOutput.push(String(chunk));
    if (/DevTools listening/.test(chunk)) return;
    process.stderr.write(chunk);
  });

  const target = await waitForCdpTarget(port, staticOriginUrl);
  cdp = await attach({ port, title: target.title, timeoutMs: 20_000 });
  await cdp.send("Network.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
    screenWidth: 390,
    screenHeight: 844
  });
  await retryAcrossReloads(() => waitForMobileRuntime(cdp), { timeoutMs: 20_000 });
  await answerChatListAndOpenConversation(cdp, desktop, pairing, initialChatList, conversationId).catch(async (error) => {
    const failure = await readFailureState(cdp).catch((stateError) => ({
      error: stateError instanceof Error ? stateError.message : String(stateError)
    }));
    throw new Error(`${error.message}\nStartup state: ${JSON.stringify({
      desktopStates,
      ui: failure
    }, null, 2)}`);
  });

  const receivedMessage = nextMessage(desktop);
  await cdp.fill("#composer-input", "browser staging relay QA");
  await cdp.click("#send-button");

  const desktopMessage = await receivedMessage.catch(async (error) => {
    const failure = await readFailureState(cdp).catch((stateError) => ({
      error: stateError instanceof Error ? stateError.message : String(stateError)
    }));
    throw new Error(`${error.message}\nFailure state: ${JSON.stringify({
      desktopStates,
      ui: failure
    }, null, 2)}`);
  });
  const opened = await openMobileRelayPayload(desktopMessage.ciphertext, pairing.relaySealKeyBase64);
  assert.equal(opened.type, "mobile.outbox.events");
  assert.equal(opened.events.length, 1);
  assert.equal(opened.events[0].payload.content, "browser staging relay QA");

  const ack = await sealMobileRelayPayload({
    type: "mobile.outbox.ack",
    eventIds: [opened.events[0].eventId],
    ackRole: "desktop"
  }, pairing.relaySealKeyBase64);
  await desktop.sendCiphertext({
    logicalMessageId: `${desktopMessage.logicalMessageId}:ack`,
    ciphertext: ack,
    cursor: desktopMessage.logicalMessageId
  });

  await waitForUiAck(cdp).catch(async (error) => {
    const failure = await readFailureState(cdp).catch((stateError) => ({
      error: stateError instanceof Error ? stateError.message : String(stateError)
    }));
    throw new Error(`${error.message}\nFailure state: ${JSON.stringify({
      desktopStates,
      ui: failure
    }, null, 2)}`);
  });
  const runningTimelinePayload = {
    type: "mobile.timeline.events",
    conversationId,
    events: [{
      id: `participant-running-${opened.events[0].eventId}`,
      role: "participant",
      participantLabel: "@cloud-staging",
      content: "@cloud-staging is running...",
      status: "pending",
      createdAt: new Date(Date.now() + 500).toISOString(),
      runId: "cloud-run-staging-qa",
      messageId: `message-running-${opened.events[0].eventId}`,
      mobileEventId: opened.events[0].eventId
    }]
  };
  await desktop.sendCiphertext({
    logicalMessageId: `timeline-running:${opened.events[0].eventId}`,
    ciphertext: await sealMobileRelayPayload(runningTimelinePayload, pairing.relaySealKeyBase64),
    cursor: `${desktopMessage.logicalMessageId}:ack`
  });
  const stableRunning = await waitForStableRunningRow(cdp, runningTimelinePayload);
  const stableTerminal = waitForStableParticipantResultRow(cdp, participantResultText);
  const timeline = await sealMobileRelayPayload({
    type: "mobile.timeline.events",
    conversationId,
    events: [{
      id: `participant-${opened.events[0].eventId}`,
      role: "participant",
      participantLabel: "@cloud-staging",
      content: participantResultText,
      status: "done",
      createdAt: new Date(Date.now() + 1000).toISOString(),
      runId: "cloud-run-staging-qa",
      messageId: `message-${opened.events[0].eventId}`,
      mobileEventId: opened.events[0].eventId
    }, {
      id: `participant-markdown-${opened.events[0].eventId}`,
      role: "participant",
      participantLabel: "@cloud-staging",
      content: markdownResultText,
      status: "done",
      createdAt: new Date(Date.now() + 1500).toISOString(),
      runId: "cloud-run-staging-markdown-qa",
      messageId: `message-markdown-${opened.events[0].eventId}`
    }]
  }, pairing.relaySealKeyBase64);
  await desktop.sendCiphertext({
    logicalMessageId: `timeline:${opened.events[0].eventId}`,
    ciphertext: timeline,
    cursor: `${desktopMessage.logicalMessageId}:ack`
  });
  const stableParticipantResult = await stableTerminal;
  await waitForTimelineResult(cdp, participantResultText);
  await waitForRenderedMarkdown(cdp);
  const ui = await readUiState(cdp);
  assert.equal(ui.connectionState, "Synced");
  assert.equal(ui.outboxStatuses.length, 1);
  assert.equal(ui.outboxStatuses[0], "acked");
  assert.equal(ui.activeScreenLabel, "Chat timeline");
  assert.ok(ui.rows.some((row) =>
    row.author === "you" &&
    row.content === "browser staging relay QA" &&
    row.status === "Sent"
  ), "PWA must show the phone-originated command as sent.");
  assert.ok(ui.rows.some((row) =>
    row.author === "agent" &&
    row.handle === "@cloud-staging" &&
    row.content === participantResultText &&
    row.status === "Done"
  ), "PWA must show the cloud participant result from the relay timeline.");

  const offlineRetry = await runOfflineRetryScenario(cdp, conversationId);

  const screenshot = await cdp.screenshot({ timeoutMs: 10_000 });
  const screenshotPath = path.join(os.tmpdir(), `accordagents-mobile-pwa-staging-${Date.now()}.png`);
  await writeFile(screenshotPath, screenshot.data);
  const designContract = await assertMobilePwaDesignContract(cdp);

  console.log(JSON.stringify({
    status: "PASS",
    relayUrl,
    staticOriginUrl,
    rendezvousId: pairing.rendezvousId,
    messageId: opened.events[0].eventId,
    offlineRetry,
    participantResultText,
    stableRunning,
    stableParticipantResult,
    markdownRendered: true,
    designContract,
    screenshotPath
  }, null, 2));
} finally {
  cdp?.close();
  desktop?.close();
  if (chrome && !chrome.killed) {
    chrome.kill("SIGTERM");
    await waitForProcessExit(chrome, 5_000);
  }
  await rm(profileDir, { recursive: true, force: true });
}

async function runOfflineRetryScenario(client, conversationId) {
  const offlinePairing = createPairing();
  const offlineUrl = new URL(mobilePairingPwaUrl(offlinePairing, staticOriginUrl));
  offlineUrl.searchParams.set("qa", randomUUID());
  const offlineMessageText = `offline retry staging relay QA ${Date.now()}`;
  const offlineResultText = `mailbox timeline staging result ${Date.now()}`;

  await client.send("Page.navigate", { url: offlineUrl.toString() });
  await retryAcrossReloads(() => waitForMobileRuntime(client), { timeoutMs: 20_000 });
  await openCachedConversation(client, conversationId);
  await client.fill("#composer-input", offlineMessageText);
  const mailboxFailure = waitForMailboxFailure(client).catch((networkError) => ({
    error: networkError instanceof Error ? networkError.message : String(networkError)
  }));
  await client.click("#send-button");

  const acked = await waitForOutboxEntry(client, offlineMessageText, {
    timeoutMs: 25_000,
    description: "Mobile UI did not durably ack the offline relay message through mailbox.",
    predicate: (entry, state) =>
      entry.status === "acked" &&
        (state === "Synced" || state === "Tunnel reconnecting" || state === "Waiting to sync")
  }).catch(async (error) => {
    const failure = await readFailureState(client).catch((stateError) => ({
      error: stateError instanceof Error ? stateError.message : String(stateError)
    }));
    failure.mailboxFailure = await mailboxFailure;
    throw new Error(`${error.message}\nOffline mailbox ack failure state: ${JSON.stringify(failure, null, 2)}`);
  });

  const mailboxUrl = mailboxEventsUrlForPairing(offlinePairing);
  const mailboxRange = await fetchJson(mailboxUrl.toString());
  const storedEvent = mailboxRange.events?.find((event) => event.eventId === acked.eventId);
  assert.ok(storedEvent, "Managed mailbox must store the offline mobile-originated event.");
  assert.equal(storedEvent.payload?.content, offlineMessageText);

  await postJson(mailboxUrl.toString(), {
    events: [mailboxTimelineEnvelope({
      conversationId,
      content: offlineResultText,
      runId: `mailbox-run-${acked.eventId}`
    })]
  });
  await waitForTimelineResult(client, offlineResultText);
  return {
    eventId: acked.eventId,
    mailboxStored: true,
    mailboxTimelineDelivered: true,
    retryStatus: acked.status,
    resultText: offlineResultText
  };
}

async function waitForMailboxFailure(client) {
  const event = await client.waitForEvent("Network.responseReceived", {
    timeoutMs: 30_000,
    predicate: (params) =>
      params.response?.url?.includes("/v1/mailbox/events") &&
        params.response?.status >= 400
  });
  let body = "";
  try {
    const responseBody = await client.send("Network.getResponseBody", {
      requestId: event.requestId
    }, { timeoutMs: 5_000 });
    body = responseBody.body || "";
  } catch (error) {
    body = `Could not read response body: ${error instanceof Error ? error.message : String(error)}`;
  }
  return {
    url: event.response.url,
    status: event.response.status,
    statusText: event.response.statusText,
    body
  };
}

async function answerChatListAndOpenConversation(client, relayClient, pairing, pendingChatListMessage, conversationId) {
  const chatListMessage = await pendingChatListMessage;
  const request = await openMobileRelayPayload(chatListMessage.ciphertext, pairing.relaySealKeyBase64);
  assert.equal(request.type, "mobile.chat-list.request");
  await relayClient.sendCiphertext({
    logicalMessageId: `${chatListMessage.logicalMessageId}:chat-list`,
    ciphertext: await sealMobileRelayPayload(chatListPayload(conversationId), pairing.relaySealKeyBase64),
    cursor: chatListMessage.logicalMessageId
  });
  await openCachedConversation(client, conversationId, relayClient, pairing);
}

async function openCachedConversation(client, conversationId, relayClient, pairing) {
  const alreadyOpen = await client.evaluate(`Boolean(document.querySelector("#composer-input"))`);
  if (alreadyOpen.result.value === true && !relayClient) {
    return;
  }
  await waitForSelectorAcrossReloads(client, ".mobile-chat-row", { timeoutMs: 20_000 });
  const pendingTimeline = relayClient && pairing ? nextMessage(relayClient) : undefined;
  const clicked = await client.evaluate(`(() => {
    const rows = [...document.querySelectorAll(".mobile-chat-row")];
    const target = rows.find((row) => row.textContent.includes("Browser Staging QA"));
    if (!target) {
      return {
        clicked: false,
        rows: rows.map((row) => row.textContent.trim()).slice(0, 20)
      };
    }
    target.click();
    return { clicked: true, rowCount: rows.length };
  })()`, {}, { timeoutMs: 5_000 });
  assert.equal(clicked.result.value?.clicked, true, "PWA must render a selectable all-chat list containing the target chat.");
  assert.ok(clicked.result.value?.rowCount >= 2, "PWA all-chat list regression must include more than one available chat.");
  if (pendingTimeline) {
    const timelineMessage = await pendingTimeline;
    const timelineRequest = await openMobileRelayPayload(timelineMessage.ciphertext, pairing.relaySealKeyBase64);
    assert.equal(timelineRequest.type, "mobile.timeline.request");
    assert.equal(timelineRequest.conversationId, conversationId);
    await relayClient.sendCiphertext({
      logicalMessageId: `${timelineMessage.logicalMessageId}:timeline`,
      ciphertext: await sealMobileRelayPayload({
        type: "mobile.timeline.events",
        conversationId,
        events: []
      }, pairing.relaySealKeyBase64),
      cursor: timelineMessage.logicalMessageId
    });
  }
  await waitForSelectorAcrossReloads(client, "#composer-input", { timeoutMs: 20_000 });
}

function chatListPayload(conversationId) {
  return {
    type: "mobile.chat-list",
    chats: [
      {
        id: `other-${conversationId}`,
        title: "Other Mobile Chat",
        group: "AccordAgents",
        snippet: "not selected",
        who: "you:",
        updatedAt: new Date(Date.now() - 1000).toISOString(),
        running: false,
        participants: ["@drew-codex-engineer"]
      },
      {
        id: conversationId,
        title: "Browser Staging QA",
        group: "AccordAgents",
        snippet: "browser staging relay QA",
        who: "you:",
        updatedAt: new Date().toISOString(),
        running: false,
        participants: ["@drew-codex-engineer", "@cloud-staging"]
      }
    ]
  };
}

async function waitForTimelineResult(client, expectedText) {
  await client.evaluate(`new Promise((resolve, reject) => {
    const expectedText = ${JSON.stringify(expectedText)};
    const deadline = Date.now() + 15000;
    const tick = async () => {
      const timeline = await globalThis.AccordAgentsMobile.listTimelineEntries();
      const hasStoredResult = timeline.some((entry) => entry.content === expectedText && entry.status === "done");
      const hasVisibleResult = [...document.querySelectorAll(".message-row[data-author='agent'] .message-content")]
        .some((entry) => entry.textContent.trim() === expectedText);
      if (hasStoredResult && hasVisibleResult) {
        resolve(true);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error("Mobile UI did not render the participant timeline result."));
        return;
      }
      setTimeout(tick, 100);
    };
    tick();
  })`, {}, { timeoutMs: 16_000 });
}

async function waitForStableRunningRow(client, runningTimelinePayload) {
  const result = await client.evaluate(`new Promise((resolve, reject) => {
    const payload = ${JSON.stringify(runningTimelinePayload)};
    const expectedText = payload.events[0].content;
    const findRunningRow = () => [...document.querySelectorAll("#message-list .message-row")]
      .find((row) =>
        row.dataset.author === "agent" &&
          row.dataset.status === "Running" &&
          row.innerText.includes(expectedText)
      );
    const list = document.querySelector("#message-list");
    if (!list) {
      reject(new Error("Missing message list."));
      return;
    }
    let removedNodes = 0;
    let blankTransitions = 0;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        removedNodes += record.removedNodes.length;
      }
      if (list.children.length === 0) {
        blankTransitions += 1;
      }
    });
    observer.observe(list, { childList: true });
    const deadline = Date.now() + 15000;
    const tick = async () => {
      const row = findRunningRow();
      if (!row) {
        if (Date.now() > deadline) {
          observer.disconnect();
          reject(new Error("Running row did not appear. " + JSON.stringify({
            rows: [...document.querySelectorAll("#message-list .message-row")].map((item) => ({
              key: item.dataset.rowKey,
              status: item.dataset.status,
              text: item.innerText
            }))
          }, null, 2)));
          return;
        }
        setTimeout(tick, 100);
        return;
      }
      const rowKey = row.dataset.rowKey;
      const stableUntil = Date.now() + 3200;
      while (Date.now() < stableUntil) {
        await globalThis.AccordAgentsMobile.handleRelayTimelinePayload(payload, payload.conversationId);
        const current = findRunningRow();
        if (!current || current.dataset.rowKey !== rowKey) {
          observer.disconnect();
          reject(new Error("Running row was not stable across timeline renders. " + JSON.stringify({
            expectedRowKey: rowKey,
            currentRowKey: current?.dataset.rowKey,
            removedNodes,
            blankTransitions,
            rows: [...document.querySelectorAll("#message-list .message-row")].map((item) => ({
              key: item.dataset.rowKey,
              status: item.dataset.status,
              text: item.innerText
            }))
          }, null, 2)));
          return;
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 400));
      }
      observer.disconnect();
      if (removedNodes > 0 || blankTransitions > 0) {
        reject(new Error("Timeline render removed visible rows while Running was pending. " + JSON.stringify({
          rowKey,
          removedNodes,
          blankTransitions
        }, null, 2)));
        return;
      }
      resolve({ rowKey, durationMs: 3200, removedNodes, blankTransitions });
    };
    tick();
  })`, {}, { timeoutMs: 20_000 });
  return result.result.value;
}

async function waitForStableParticipantResultRow(client, expectedText) {
  const result = await client.evaluate(`new Promise((resolve, reject) => {
    const expectedText = ${JSON.stringify(expectedText)};
    const list = document.querySelector("#message-list");
    if (!list) {
      reject(new Error("Missing message list."));
      return;
    }
    let removedNodes = 0;
    let blankTransitions = 0;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        removedNodes += record.removedNodes.length;
      }
      if (list.children.length === 0) {
        blankTransitions += 1;
      }
    });
    observer.observe(list, { childList: true });
    const findResultRow = () => [...document.querySelectorAll("#message-list .message-row")]
      .find((row) =>
        row.dataset.author === "agent" &&
          row.dataset.status === "Done" &&
          row.innerText.includes(expectedText)
      );
    const deadline = Date.now() + 15000;
    const tick = () => {
      const row = findResultRow();
      if (!row) {
        if (Date.now() > deadline) {
          observer.disconnect();
          reject(new Error("Participant result row did not appear. " + JSON.stringify({
            removedNodes,
            blankTransitions,
            rows: [...document.querySelectorAll("#message-list .message-row")].map((item) => ({
              key: item.dataset.rowKey,
              status: item.dataset.status,
              text: item.innerText
            }))
          }, null, 2)));
          return;
        }
        setTimeout(tick, 100);
        return;
      }
      const rowKey = row.dataset.rowKey;
      setTimeout(() => {
        observer.disconnect();
        const current = findResultRow();
        if (!current || current.dataset.rowKey !== rowKey || removedNodes > 0 || blankTransitions > 0) {
          reject(new Error("Participant result render replaced visible rows. " + JSON.stringify({
            rowKey,
            currentRowKey: current?.dataset.rowKey,
            removedNodes,
            blankTransitions,
            rows: [...document.querySelectorAll("#message-list .message-row")].map((item) => ({
              key: item.dataset.rowKey,
              status: item.dataset.status,
              text: item.innerText
            }))
          }, null, 2)));
          return;
        }
        resolve({ rowKey, durationMs: 1200, removedNodes, blankTransitions });
      }, 1200);
    };
    tick();
  })`, {}, { timeoutMs: 18_000 });
  return result.result.value;
}

async function waitForRenderedMarkdown(client) {
  await client.evaluate(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 15000;
    const tick = async () => {
      const timeline = await globalThis.AccordAgentsMobile.listTimelineEntries();
      const hasStoredMarkdown = timeline.some((entry) =>
        entry.content === ${JSON.stringify(markdownResultText)} &&
          entry.status === "done"
      );
      const markdownRows = [...document.querySelectorAll(".message-row[data-author='agent'] .message-content")];
      const hasRenderedMarkdown = markdownRows.some((entry) =>
        entry.querySelector("strong")?.textContent === "Markdown result" &&
          [...entry.querySelectorAll("li")].map((item) => item.textContent.trim()).join("|") === "first item|second item" &&
          entry.querySelector("code")?.textContent === "inline-code" &&
          !entry.textContent.includes("**Markdown result**")
      );
      if (hasStoredMarkdown && hasRenderedMarkdown) {
        resolve(true);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error("Mobile UI did not render markdown timeline content. " + JSON.stringify({
          hasStoredMarkdown,
          rows: markdownRows.map((entry) => ({
            text: entry.textContent.trim(),
            html: entry.innerHTML
          }))
        }, null, 2)));
        return;
      }
      setTimeout(tick, 100);
    };
    tick();
  })`, {}, { timeoutMs: 16_000 });
}

async function assertMobilePwaDesignContract(client) {
  const mobile = await readDesignState(client);
  assert.equal(mobile.viewport.width, 390);
  assert.equal(mobile.viewport.height, 844);
  assert.equal(mobile.activeScreenLabel, "Chat timeline");
  assert.equal(mobile.stage.backgroundColor, "rgb(236, 238, 242)");
  assertAlmostEqual(mobile.phone.width, 390, "mobile phone width");
  assertAlmostEqual(mobile.phone.height, 844, "mobile phone height");
  assert.equal(mobile.phone.borderRadius, "0px");
  assert.equal(mobile.phone.borderTopWidth, "0px");
  assert.equal(mobile.phone.boxShadow, "none");
  assertTimelineInteriorContract(mobile);

  await client.send("Emulation.setDeviceMetricsOverride", {
    width: 800,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
    screenWidth: 800,
    screenHeight: 1000
  });
  await sleep(250);
  const desktop = await readDesignState(client);
  assert.equal(desktop.activeScreenLabel, "Chat timeline");
  assert.equal(desktop.stage.backgroundColor, "rgb(236, 238, 242)");
  assertAlmostEqual(desktop.phone.width, 390, "desktop phone frame width");
  assertAlmostEqual(desktop.phone.height, 844, "desktop phone frame height");
  assert.equal(desktop.phone.borderRadius, "44px");
  assert.equal(desktop.phone.borderTopWidth, "1px");
  assert.equal(desktop.phone.borderTopColor, "rgb(220, 222, 229)");
  assert.notEqual(desktop.phone.boxShadow, "none");
  assertTimelineInteriorContract(desktop);

  return {
    mobileViewport: {
      phone: `${Math.round(mobile.phone.width)}x${Math.round(mobile.phone.height)}`,
      borderless: mobile.phone.borderTopWidth === "0px" && mobile.phone.boxShadow === "none",
      timelinePadding: mobile.threadSurface.padding,
      composerHeight: mobile.composerInput.height
    },
    desktopFrame: {
      phone: `${Math.round(desktop.phone.width)}x${Math.round(desktop.phone.height)}`,
      radius: desktop.phone.borderRadius,
      borderColor: desktop.phone.borderTopColor,
      hasShadow: desktop.phone.boxShadow !== "none"
    }
  };
}

function assertTimelineInteriorContract(state) {
  assertAlmostEqual(state.statusBar.height, 52, "status bar height");
  assert.equal(state.chatHeader.padding, "2px 16px 12px");
  assert.equal(state.chatHeader.borderBottomColor, "rgb(240, 241, 244)");
  assert.equal(state.hasParticipantsButton, false, "v1 mobile control must not expose chat participant/invite UI.");
  assertAlmostEqual(state.iconButton.width, 44, "icon button width");
  assertAlmostEqual(state.iconButton.height, 44, "icon button height");
  assert.equal(state.threadSurface.padding, "16px 18px 10px");
  assert.equal(state.messageList.gap, "20px");
  assert.equal(state.userBubble.maxWidth, "82%");
  assert.equal(state.userBubble.backgroundColor, "rgb(236, 239, 243)");
  assert.equal(state.userBubble.borderRadius, "18px 18px 6px");
  assert.equal(state.userBubble.padding, "11px 14px");
  assertAlmostEqual(state.composerInput.height, 46, "composer input height");
  assert.equal(state.composerInput.borderRadius, "23px");
  assert.equal(state.composerInput.backgroundColor, "rgb(246, 247, 248)");
  assert.equal(state.composerInput.borderTopColor, "rgb(231, 233, 238)");
  assertAlmostEqual(state.sendButton.width, 46, "send button width");
  assertAlmostEqual(state.sendButton.height, 46, "send button height");
  assert.equal(state.sendButton.borderRadius, "50%");
}

async function readDesignState(client) {
  const result = await client.evaluate(`(() => {
    const styleFor = (selector) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error("Missing design contract element: " + selector);
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        width: rect.width,
        height: rect.height,
        padding: style.padding,
        gap: style.gap,
        borderRadius: style.borderRadius,
        backgroundColor: style.backgroundColor,
        borderTopColor: style.borderTopColor,
        borderTopWidth: style.borderTopWidth,
        borderBottomColor: style.borderBottomColor,
        boxShadow: style.boxShadow,
        maxWidth: style.maxWidth
      };
    };
    return {
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight
      },
      activeScreenLabel: document.querySelector(".mobile-screen.is-active")?.getAttribute("aria-label"),
      hasParticipantsButton: Boolean(document.querySelector('[aria-label="Participants"]')),
      stage: styleFor(".mobile-stage"),
      phone: styleFor(".mobile-phone"),
      statusBar: styleFor(".mobile-status-bar"),
      chatHeader: styleFor(".mobile-chat-header"),
      iconButton: styleFor(".mobile-icon-button"),
      threadSurface: styleFor(".thread-surface"),
      messageList: styleFor(".message-list"),
      userBubble: styleFor('.message-row[data-author="you"] .message-bubble'),
      composerInput: styleFor(".composer-input-wrap"),
      sendButton: styleFor("#send-button")
    };
  })()`);
  return result.result.value;
}

function assertAlmostEqual(actual, expected, label, tolerance = 1) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${expected} +/- ${tolerance}, got ${actual}`
  );
}

function createPairing() {
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + 10 * 60 * 1000);
  const stableRoutingId = `route-${randomUUID()}`;
  return {
    version: 1,
    purpose: "phone-control",
    issuer: {
      originId: "origin-staging-browser-qa",
      keyId: "qa-key",
      publicKeyDerBase64: Buffer.from("qa-public-key").toString("base64")
    },
    rendezvousId: `rv-${randomUUID()}`,
    stableRoutingId,
    relaySealKeyBase64: randomBytes(32).toString("base64url"),
    relayUrl,
    mailboxUrl,
    outboxUrl: scopedOutboxUrl(stableRoutingId),
    staticOriginUrl,
    capabilities: [{
      scope: "device",
      canRead: true,
      canWrite: true,
      canRunCloudParticipants: true,
      canListConversations: true,
      canInviteOthers: false
    }],
    fingerprint: randomBytes(12).toString("hex").toUpperCase().match(/.{1,4}/g).join("-"),
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString()
  };
}

function normalizeTrailingSlash(value) {
  const url = new URL(value);
  return `${url.origin}/`;
}

function managedMailboxUrlFromRelayUrl(value) {
  const url = new URL(value);
  if (url.protocol === "wss:") {
    url.protocol = "https:";
  } else if (url.protocol === "ws:") {
    url.protocol = "http:";
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function managedOutboxUrlFromRelayUrl(value) {
  const url = new URL(value);
  if (url.protocol === "wss:") {
    url.protocol = "https:";
  } else if (url.protocol === "ws:") {
    url.protocol = "http:";
  }
  url.pathname = "/v1/mailbox/events";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function scopedOutboxUrl(stableRoutingId) {
  const url = new URL(outboxUrl);
  url.searchParams.set("mailboxId", stableRoutingId);
  return url.toString();
}

function nextMessage(client, { timeoutMs = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    const offMessage = client.on("message", (message) => {
      cleanup();
      resolve(message);
    });
    const offError = client.on("error", (error) => {
      cleanup();
      reject(error);
    });
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Desktop relay client did not receive a mobile message."));
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      offMessage();
      offError();
    }
  });
}

async function waitForCdp(debugPort) {
  const deadline = Date.now() + 20_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      await getJson("/json", { port: debugPort, timeoutMs: 1000 });
      return;
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  }
  throw new Error(`Chrome CDP did not become available: ${lastError?.message ?? "timeout"}; exitCode=${chrome?.exitCode ?? "running"}; output=${chromeOutput.join("").slice(-4000)}`);
}

function mailboxEventsUrlForPairing(pairing) {
  const url = new URL("/v1/mailbox/events", relayUrl);
  if (url.protocol === "wss:") {
    url.protocol = "https:";
  } else if (url.protocol === "ws:") {
    url.protocol = "http:";
  }
  url.searchParams.set("mailboxId", pairing.stableRoutingId);
  url.searchParams.set("limit", "500");
  return url;
}

function mailboxTimelineEnvelope({ conversationId, content, runId }) {
  const eventId = `qa-mailbox-timeline-${randomUUID()}`;
  const createdAt = new Date().toISOString();
  const originId = `qa-worker-${randomUUID()}`;
  return {
    eventId,
    conversationId,
    logScopeId: conversationId,
    originId,
    originSeq: 1,
    logicalTs: `0000000000000001:${originId}:${conversationId}`,
    kind: "mobile.timeline.events",
    payload: {
      type: "mobile.timeline.events",
      conversationId,
      events: [{
        id: `qa-mailbox-result-${eventId}`,
        role: "participant",
        participantLabel: "@cloud-staging",
        content,
        status: "done",
        createdAt,
        runId,
        messageId: `message-${eventId}`
      }]
    },
    payloadHash: `sha256:${eventId}:payload`,
    eventHash: `sha256:${eventId}:event`,
    createdAt
  };
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`POST ${url} failed with HTTP ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { accept: "application/json" }
  });
  if (!response.ok) {
    throw new Error(`GET ${url} failed with HTTP ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function waitForCdpTarget(debugPort, urlPrefix) {
  await waitForCdp(debugPort);
  const deadline = Date.now() + 20_000;
  let lastTargets = [];
  while (Date.now() < deadline) {
    lastTargets = await getJson("/json", { port: debugPort, timeoutMs: 1000 });
    const target = lastTargets.find((entry) =>
      entry.type === "page" &&
        typeof entry.url === "string" &&
        entry.url.startsWith(urlPrefix) &&
        typeof entry.title === "string"
    );
    if (target) {
      return target;
    }
    await sleep(250);
  }
  throw new Error(`Chrome page target did not appear for ${urlPrefix}: ${JSON.stringify(lastTargets)}`);
}

async function waitForMobileRuntime(client) {
  await client.evaluate(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 15000;
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
  })`, {}, { timeoutMs: 16_000 });
}

async function waitForSelectorAcrossReloads(client, selector, { timeoutMs }) {
  await retryAcrossReloads(() => client.waitForSelector(selector, { timeoutMs: Math.min(5_000, timeoutMs) }), { timeoutMs });
}

async function retryAcrossReloads(operation, { timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!/Execution context was destroyed|Cannot find context|Target closed/i.test(error instanceof Error ? error.message : String(error))) {
        throw error;
      }
      await sleep(500);
    }
  }
  throw lastError ?? new Error("Operation did not complete before timeout.");
}

async function waitForUiAck(client) {
  await client.evaluate(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 15000;
    const tick = async () => {
      const state = document.querySelector("#connection-state")?.textContent?.trim();
      const status = document.querySelector(".message-status")?.textContent?.trim();
      const outbox = await globalThis.AccordAgentsMobile.listOutboxEntries();
      if (state === "Synced" && status === "Sent" && outbox.every((entry) => entry.status === "acked")) {
        resolve(true);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error("Mobile UI did not reach synced/acked state."));
        return;
      }
      setTimeout(tick, 100);
    };
    tick();
  })`, {}, { timeoutMs: 16_000 });
}

async function waitForOutboxEntry(client, content, { timeoutMs, description, predicate }) {
  const deadline = Date.now() + timeoutMs;
  let lastState;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await client.evaluate(`(async () => {
        const content = ${JSON.stringify(content)};
      const state = document.querySelector("#connection-state")?.textContent?.trim();
      const outbox = await globalThis.AccordAgentsMobile.listOutboxEntries();
      const entry = outbox.find((item) => item.payload?.content === content);
        return {
          state,
          entry: entry ? { ...entry, connectionState: state } : undefined,
          outbox: outbox.map((item) => ({
            eventId: item.eventId,
            status: item.status,
            attempts: item.attempts,
            content: item.payload?.content,
            lastError: item.lastError
          }))
        };
      })()`, {}, { timeoutMs: 3_000 });
      lastState = result.result.value;
      if (lastState.entry && predicate(lastState.entry, lastState.state)) {
        return lastState.entry;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (!/Execution context was destroyed|Cannot find context|Target closed|Runtime\.evaluate timeout/i.test(lastError)) {
        throw error;
      }
    }
    await sleep(250);
  }
  throw new Error(`${description} Last state: ${JSON.stringify(lastState ?? { error: lastError }, null, 2)}`);
}

async function readUiState(client) {
  const result = await client.evaluate(`(async () => {
    const outbox = await globalThis.AccordAgentsMobile.listOutboxEntries();
    const timeline = await globalThis.AccordAgentsMobile.listTimelineEntries();
    return {
      connectionState: document.querySelector("#connection-state")?.textContent?.trim(),
      outboxStatuses: outbox.map((entry) => entry.status),
      timelineStatuses: timeline.map((entry) => entry.status),
      screenLabel: document.querySelector(".mobile-phone")?.dataset.screenLabel,
      activeScreenLabel: document.querySelector(".mobile-screen.is-active")?.getAttribute("aria-label"),
      rows: [...document.querySelectorAll(".message-row")].map((row) => ({
        author: row.dataset.author,
        handle: row.querySelector(".message-handle")?.textContent?.trim(),
        content: row.querySelector(".message-content")?.textContent?.trim(),
        status: row.querySelector(".message-status")?.textContent?.trim()
      }))
    };
  })()`);
  return result.result.value;
}

async function readFailureState(client) {
  if (!client) {
    return { error: "CDP client unavailable" };
  }
  const result = await client.evaluate(`(async () => {
    const outbox = globalThis.AccordAgentsMobile
      ? await globalThis.AccordAgentsMobile.listOutboxEntries()
      : [];
    const pairing = globalThis.AccordAgentsMobile?.loadPairing?.();
    return {
      href: location.href,
      readyState: document.readyState,
      runtimeReady: Boolean(globalThis.AccordAgentsMobile),
      pairing,
      relayDebug: globalThis.__relayDebug || [],
      connectionState: document.querySelector("#connection-state")?.textContent?.trim(),
      activeScreenLabel: document.querySelector(".mobile-screen.is-active")?.getAttribute("aria-label"),
      chatRows: [...document.querySelectorAll(".mobile-chat-row")].map((row) => row.textContent.trim()),
      inputValue: document.querySelector("#composer-input")?.value,
      messageText: document.querySelector(".message-content")?.textContent?.trim(),
      messageStatus: document.querySelector(".message-status")?.textContent?.trim(),
      outbox: outbox.map((entry) => ({
        eventId: entry.eventId,
        status: entry.status,
        attempts: entry.attempts,
        content: entry.payload?.content,
        lastError: entry.lastError
      }))
    };
  })()`);
  return result.result.value;
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

function waitForProcessExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchMobileQaBrowser } from "./mobile-qa-browser.mjs";

const require = createRequire(import.meta.url);
const { attach, getJson } = require("./cdp.cjs");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pwaOrigin = process.env.QA_MOBILE_STATIC_ORIGIN_URL || "https://mobile.accordagents.com";
const pwaUrl = `${pwaOrigin}/?pushQa=${Date.now()}`;
const chromePort = await freePort();
const profileDir = await mkdtemp(path.join(os.tmpdir(), "accordagents-mobile-push-chrome-"));
let chrome;
let page;

try {
  phase("launch chrome pwa");
  chrome = await launchMobileQaBrowser({
    repoRoot,
    url: pwaUrl,
    port: chromePort,
    profileDir
  });
  chrome.stderr.setEncoding("utf8");
  chrome.stderr.on("data", (chunk) => {
    if (/DevTools listening/.test(chunk)) return;
    process.stderr.write(chunk);
  });

  await waitForCdpTarget(chromePort, pwaOrigin, "AccordAgents", 30_000);
  page = await attach({ port: chromePort, title: "AccordAgents", timeoutMs: 20_000 });
  await page.send("Browser.setPermission", {
    permission: { name: "notifications" },
    setting: "granted",
    origin: pwaOrigin
  });

  phase("wait for service worker");
  const registrationPromise = page.waitForEvent("ServiceWorker.workerRegistrationUpdated", {
    timeoutMs: 20_000,
    predicate: (params) => (params.registrations ?? []).some((registration) =>
      registration.scopeURL === `${pwaOrigin}/` && !registration.isDeleted
    )
  });
  await page.send("ServiceWorker.enable");
  await page.evaluate(`navigator.serviceWorker.ready.then((registration) => ({
    scope: registration.scope,
    active: registration.active?.state
  }))`, {}, { timeoutMs: 20_000 });
  const registrationEvent = await registrationPromise;
  const registration = registrationEvent.registrations.find((candidate) =>
    candidate.scopeURL === `${pwaOrigin}/` && !candidate.isDeleted
  );
  assert.ok(registration?.registrationId, "PWA service worker registration must be observable through CDP.");

  phase("deliver opaque push");
  const payload = JSON.stringify({
    version: 1,
    reason: "run-updated",
    conversationId: "conversation-push-qa",
    eventId: "event-push-qa",
    messageText: "MUST_NOT_APPEAR",
    approvalText: "MUST_NOT_APPEAR"
  });
  await page.send("ServiceWorker.deliverPushMessage", {
    origin: pwaOrigin,
    registrationId: registration.registrationId,
    data: payload
  }, { timeoutMs: 20_000 });

  console.log(JSON.stringify({
    status: "PASS",
    pwaOrigin,
    registrationId: registration.registrationId,
    scopeURL: registration.scopeURL,
    payloadFieldsSent: ["version", "reason", "conversationId", "eventId", "messageText", "approvalText"],
    notificationContract: "service worker ignores event.data and shows fixed opaque sync notification"
  }, null, 2));
} finally {
  page?.close();
  if (chrome && !chrome.killed) {
    chrome.kill("SIGTERM");
    await waitForProcessExit(chrome, 5_000);
  }
  await rm(profileDir, { recursive: true, force: true });
}

function phase(name) {
  console.error(`[qa-mobile-push] ${new Date().toISOString()} ${name}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (!address || typeof address === "string") {
          reject(new Error("Could not allocate a TCP port."));
          return;
        }
        resolve(address.port);
      });
    });
    server.on("error", reject);
  });
}

async function waitForCdpTarget(port, urlPrefix, title, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const targets = await getJson("/json", { port, timeoutMs: 2_000 });
      const target = targets.find((candidate) =>
        candidate.type === "page" &&
        candidate.title === title &&
        candidate.url.startsWith(urlPrefix)
      );
      if (target) return target;
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw lastError ?? new Error(`CDP target ${title} at ${urlPrefix} was not ready.`);
}

function waitForProcessExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

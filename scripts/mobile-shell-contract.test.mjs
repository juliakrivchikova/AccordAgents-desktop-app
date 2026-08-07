import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import WebSocket from "ws";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, "..");
const { createReferenceRelayServer } = require("./relay-reference-server.cjs");

test("mobile shell builds static installable PWA assets", async () => {
  await execFileAsync(process.execPath, ["scripts/build-mobile-shell.mjs"], {
    cwd: repoRoot
  });

  const manifest = JSON.parse(await readFile(path.join(repoRoot, "dist/mobile/manifest.webmanifest"), "utf8"));
  const worker = await readFile(path.join(repoRoot, "dist/mobile/service-worker.js"), "utf8");
  const app = await readFile(path.join(repoRoot, "dist/mobile/mobile-app.js"), "utf8");
  const icon = await stat(path.join(repoRoot, "dist/mobile/assets/accordagents-mark.png"));

  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, ".");
  assert.equal(manifest.icons[0].src, "assets/accordagents-mark.png");
  assert.ok(icon.size > 0);
  for (const asset of ["./index.html", "./mobile-app.css", "./mobile-app.js", "./manifest.webmanifest"]) {
    assert.match(worker, new RegExp(asset.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")));
  }
  assert.match(worker, /self\.addEventListener\("push"/);
  assert.match(worker, /Open AccordAgents to sync updates\./);
  assert.doesNotMatch(worker, /event\.data/);
  assert.match(app, /indexedDB\.open\(DB_NAME, DB_VERSION\)/);
  assert.match(app, /ackedEventIds\.includes\(entry\.eventId\)/);
  assert.match(app, /\/v1\/mailbox\/events/);
  assert.match(app, /events: \[syncing\]/);
  assert.match(app, /fragment\.get\("pairing"\)/);
  assert.match(app, /relaySealKeyBase64/);
  assert.match(app, /sealRelayPayload/);
  assert.match(app, /Tunnel reconnecting/);
  assert.match(app, /globalThis\.AccordAgentsMobile/);
});

test("mobile shell sends only sealed relay frames that the desktop can decrypt by pairing key", async () => {
  await execFileAsync("npm", ["run", "build:main"], {
    cwd: repoRoot
  });
  await execFileAsync(process.execPath, ["scripts/build-mobile-shell.mjs"], {
    cwd: repoRoot
  });
  await import(pathToFileURL(path.join(repoRoot, "dist/mobile/mobile-app.js")).toString());
  const { RelayTunnelClient } = await import("../dist/main/main/services/relayTunnelClient.js");
  const mobile = globalThis.AccordAgentsMobile;
  const relay = createReferenceRelayServer();
  const address = await relay.listen();
  try {
    const key = bytesToBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(32)));
    const desktop = new RelayTunnelClient({
      relayUrl: address.url,
      rendezvousId: "rv-mobile-shell",
      role: "desktop",
      capability: "PAIRING-FINGERPRINT",
      streamId: "route-mobile-shell:phone"
    });
    const received = nextMessage(desktop);

    await desktop.connect();
    const phone = await openPhoneSocket(address.url, "rv-mobile-shell", "PAIRING-FINGERPRINT");
    const sealed = await mobile.sealRelayPayload({
      type: "mobile.outbox.events",
      events: [{ eventId: "event-mobile-1", payload: { content: "relay secret text" } }]
    }, key);
    assert.doesNotMatch(sealed, /relay secret text/);
    const frames = mobile.chunkRelayCiphertext({
      streamId: "route-mobile-shell:phone",
      logicalMessageId: "event-mobile-1",
      ciphertext: sealed
    });
    for (const frame of frames) {
      phone.send(JSON.stringify(frame));
    }

    const message = await received;
    assert.equal(message.logicalMessageId, "event-mobile-1");
    assert.doesNotMatch(message.ciphertext, /relay secret text/);
    const opened = await mobile.openRelayPayload(message.ciphertext, key);
    assert.equal(opened.events[0].payload.content, "relay secret text");
    phone.close();
    desktop.close();
  } finally {
    await relay.close();
  }
});

function openPhoneSocket(relayUrl, rendezvousId, capability) {
  const url = new URL(relayUrl);
  url.searchParams.set("rid", rendezvousId);
  url.searchParams.set("role", "phone");
  url.searchParams.set("cap", capability);
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function nextMessage(client) {
  return new Promise((resolve) => {
    const off = client.on("message", (message) => {
      off();
      resolve(message);
    });
  });
}

function bytesToBase64Url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

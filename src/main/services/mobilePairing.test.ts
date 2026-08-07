import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseMobilePairingPayload } from "../../shared/mobilePairing";
import { ChatEventLogService } from "./chatEventLog";
import { MobilePairingService } from "./mobilePairing";
import { StorageService } from "./storage";

test("MobilePairingService creates QR payload with separate rendezvous and routing identity", async () => {
  const { storage, cleanup } = await testStorage();
  try {
    const service = new MobilePairingService(new ChatEventLogService(storage, fixedClock()), fixedClock());

    const result = await service.createPairing({
      conversationId: "conversation-1",
      relayUrl: "wss://relay.example.test/live",
      mailboxUrl: "https://mailbox.example.test/",
      outboxUrl: "https://mailbox.example.test/v1/mailbox/events",
      staticOriginUrl: "https://app.example.test/mobile/",
      ttlMinutes: 5
    });
    const parsed = parseMobilePairingPayload(result.qrPayload, new Date("2026-08-06T00:04:00.000Z"));

    assert.equal(parsed.version, 1);
    assert.equal(parsed.purpose, "phone-control");
    assert.equal(parsed.capabilities[0].conversationId, "conversation-1");
    assert.equal(parsed.capabilities[0].canRunCloudParticipants, true);
    assert.equal(parsed.rendezvousId.startsWith("rv-"), true);
    assert.equal(parsed.stableRoutingId.startsWith("route-"), true);
    assert.notEqual(parsed.rendezvousId, parsed.stableRoutingId);
    assert.match(parsed.relaySealKeyBase64, /^[A-Za-z0-9_-]+$/);
    assert.match(parsed.fingerprint, /^[0-9A-F]{4}(-[0-9A-F]{4}){5}$/);
    assert.equal(parsed.relayUrl, "wss://relay.example.test/live");
    assert.equal(parsed.mailboxUrl, "https://mailbox.example.test/");
    assert.equal(parsed.outboxUrl, "https://mailbox.example.test/v1/mailbox/events");
    assert.equal(parsed.staticOriginUrl, "https://app.example.test/mobile/");
    assert.ok(result.pwaUrl);
    const pwaUrl = new URL(result.pwaUrl);
    assert.equal(`${pwaUrl.origin}${pwaUrl.pathname}`, "https://app.example.test/mobile/");
    assert.equal(pwaUrl.searchParams.get("conversationId"), "conversation-1");
    assert.equal(pwaUrl.searchParams.get("routingId"), parsed.stableRoutingId);
    assert.equal(pwaUrl.searchParams.get("fingerprint"), parsed.fingerprint);
    assert.equal(pwaUrl.searchParams.has("relaySealKey"), false);
    assert.equal(pwaUrl.searchParams.has("rendezvousId"), false);
    assert.match(pwaUrl.hash, /^#pairing=/);
    const fragmentPayload = new URLSearchParams(pwaUrl.hash.slice(1)).get("pairing");
    assert.ok(fragmentPayload);
    const fragmentPairing = parseMobilePairingPayload(
      Buffer.from(fragmentPayload, "base64url").toString("utf8"),
      new Date("2026-08-06T00:04:00.000Z")
    );
    assert.equal(fragmentPairing.rendezvousId, parsed.rendezvousId);
    assert.equal(fragmentPairing.relaySealKeyBase64, parsed.relaySealKeyBase64);
  } finally {
    await cleanup();
  }
});

test("parseMobilePairingPayload rejects expired and unsafe URL packages", async () => {
  const { storage, cleanup } = await testStorage();
  try {
    const service = new MobilePairingService(new ChatEventLogService(storage, fixedClock()), fixedClock());
    const result = await service.createPairing({
      conversationId: "conversation-1",
      relayUrl: "wss://relay.example.test",
      ttlMinutes: 1
    });

    assert.throws(
      () => parseMobilePairingPayload(result.qrPayload, new Date("2026-08-06T00:02:00.000Z")),
      /expired/
    );
    const unsafe = JSON.parse(result.qrPayload);
    unsafe.staticOriginUrl = "http://app.example.test";
    assert.throws(
      () => parseMobilePairingPayload(JSON.stringify(unsafe), new Date("2026-08-06T00:00:10.000Z")),
      /staticOriginUrl must use https/
    );
    unsafe.staticOriginUrl = "https://app.example.test";
    unsafe.outboxUrl = "ws://mailbox.example.test/v1/mailbox/events";
    assert.throws(
      () => parseMobilePairingPayload(JSON.stringify(unsafe), new Date("2026-08-06T00:00:10.000Z")),
      /outboxUrl must use https/
    );
    unsafe.outboxUrl = "https://mailbox.example.test/v1/mailbox/events";
    unsafe.relayUrl = "https://relay.example.test";
    assert.throws(
      () => parseMobilePairingPayload(JSON.stringify(unsafe), new Date("2026-08-06T00:00:10.000Z")),
      /relayUrl must use wss/
    );
  } finally {
    await cleanup();
  }
});

async function testStorage(): Promise<{ storage: StorageService; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(path.join(tmpdir(), "accordagents-mobile-pairing-"));
  const storage = Object.create(StorageService.prototype) as any;
  storage.dbPath = path.join(directory, "accordagents.sqlite3");
  storage.initialized = false;
  await storage.init();
  return {
    storage: storage as StorageService,
    cleanup: async () => {
      await rm(directory, { recursive: true, force: true });
    }
  };
}

function fixedClock(): () => Date {
  return () => new Date("2026-08-06T00:00:00.000Z");
}

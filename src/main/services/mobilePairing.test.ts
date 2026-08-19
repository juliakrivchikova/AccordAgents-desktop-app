import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ACCORD_MANAGED_MOBILE_CONTROL_DEFAULTS,
  mobileControlSettingsFromEnvironment,
  mobilePairingRequestWithEndpointDefaults,
  parseMobilePairingPayload
} from "../../shared/mobilePairing";
import { ChatEventLogService } from "./chatEventLog";
import { mailboxScopeIdForSealKey } from "./mailboxAccess";
import { MobilePairingService } from "./mobilePairing";
import { StorageService } from "./storage";

test("MobilePairingService creates QR payload with separate rendezvous and routing identity", async () => {
  const { storage, cleanup } = await testStorage();
  try {
    const service = new MobilePairingService(new ChatEventLogService(storage, fixedClock()), fixedClock());

    const result = await service.createPairing({
      relayUrl: "wss://relay.example.test/live",
      mailboxUrl: "https://mailbox.example.test/",
      outboxUrl: "https://mailbox.example.test/v1/mailbox/events",
      staticOriginUrl: "https://app.example.test/mobile/",
      ttlMinutes: 5
    });
    const parsed = parseMobilePairingPayload(result.qrPayload, new Date("2026-08-06T00:04:00.000Z"));
    const capability = parsed.capabilities[0];

    assert.equal(parsed.version, 1);
    assert.equal(parsed.purpose, "phone-control");
    assert.equal(capability.scope, "device");
    assert.equal(capability.canRead, true);
    assert.equal(capability.canWrite, true);
    assert.equal(capability.canRunCloudParticipants, true);
    assert.equal(capability.scope === "device" ? capability.canListConversations : false, true);
    assert.equal(parsed.rendezvousId.startsWith("rv-"), true);
    assert.equal(parsed.stableRoutingId.startsWith("route-"), true);
    assert.notEqual(parsed.rendezvousId, parsed.stableRoutingId);
    assert.match(parsed.relaySealKeyBase64, /^[A-Za-z0-9_-]+$/);
    assert.match(parsed.fingerprint, /^[0-9A-F]{4}(-[0-9A-F]{4}){5}$/);
    assert.equal(parsed.relayUrl, "wss://relay.example.test/live");
    assert.equal(parsed.mailboxUrl, "https://mailbox.example.test/");
    assert.ok(parsed.outboxUrl?.startsWith("https://mailbox.example.test/v1/mailbox/events?mailboxId=mb-"));
    assert.equal(parsed.staticOriginUrl, "https://app.example.test/mobile/");
    assert.ok(result.pwaUrl);
    const pwaUrl = new URL(result.pwaUrl);
    assert.equal(`${pwaUrl.origin}${pwaUrl.pathname}`, "https://app.example.test/mobile/");
    assert.equal(pwaUrl.searchParams.get("conversationId"), null);
    assert.equal(pwaUrl.searchParams.get("rid"), parsed.rendezvousId);
    assert.equal(pwaUrl.searchParams.get("route"), parsed.stableRoutingId);
    assert.equal(pwaUrl.searchParams.get("cap"), parsed.fingerprint);
    assert.equal(pwaUrl.searchParams.has("relaySealKey"), false);
    assert.equal(pwaUrl.searchParams.has("rendezvousId"), false);
    assert.equal(new URLSearchParams(pwaUrl.hash.slice(1)).get("k"), parsed.relaySealKeyBase64);
    assert.ok(result.pwaUrl.length < result.qrPayload.length / 2);
  } finally {
    await cleanup();
  }
});

test("parseMobilePairingPayload rejects expired and unsafe URL packages", async () => {
  const { storage, cleanup } = await testStorage();
  try {
    const service = new MobilePairingService(new ChatEventLogService(storage, fixedClock()), fixedClock());
    const result = await service.createPairing({
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

test("MobilePairingService creates scoped person-invite QR payloads", async () => {
  const { storage, cleanup } = await testStorage();
  try {
    const service = new MobilePairingService(new ChatEventLogService(storage, fixedClock()), fixedClock());

    const result = await service.createPairing({
      conversationId: "conversation-people",
      purpose: "person-invite",
      relayUrl: "wss://relay.example.test/live",
      staticOriginUrl: "https://app.example.test/mobile/",
      canRunCloudParticipants: true,
      canInviteOthers: false,
      ttlMinutes: 10
    });
    const parsed = parseMobilePairingPayload(result.qrPayload, new Date("2026-08-06T00:04:00.000Z"));
    const capability = parsed.capabilities[0];

    assert.equal(parsed.purpose, "person-invite");
    assert.equal(capability.scope, "conversation");
    assert.equal(capability.scope === "conversation" ? capability.conversationId : "", "conversation-people");
    assert.equal(capability.canRead, true);
    assert.equal(capability.canWrite, true);
    assert.equal(capability.canRunCloudParticipants, true);
    assert.equal(capability.canInviteOthers, false);
    assert.ok(result.pwaUrl?.startsWith("https://app.example.test/mobile/"));
  } finally {
    await cleanup();
  }
});

test("mobile pairing request uses managed endpoint defaults when fields are blank", async () => {
  const settings = mobileControlSettingsFromEnvironment({
    ACCORDAGENTS_MOBILE_RELAY_URL: "wss://relay.example.test/v1/relay",
    ACCORDAGENTS_MOBILE_STATIC_ORIGIN_URL: "https://app.example.test/mobile/",
    ACCORDAGENTS_MOBILE_MAILBOX_URL: "https://mailbox.example.test/",
    ACCORDAGENTS_MOBILE_OUTBOX_URL: "https://mailbox.example.test/v1/mailbox/events"
  });
  assert.equal(settings.provider, "accord-managed");

  const request = mobilePairingRequestWithEndpointDefaults({
    relayUrl: " ",
    staticOriginUrl: "",
    ttlMinutes: 5
  }, settings.defaults);

  const { storage, cleanup } = await testStorage();
  try {
    const service = new MobilePairingService(new ChatEventLogService(storage, fixedClock()), fixedClock());
    const result = await service.createPairing(request);
    const parsed = parseMobilePairingPayload(result.qrPayload, new Date("2026-08-06T00:04:00.000Z"));

    assert.equal(parsed.relayUrl, "wss://relay.example.test/v1/relay");
    assert.equal(parsed.staticOriginUrl, "https://app.example.test/mobile/");
    assert.equal(parsed.mailboxUrl, "https://mailbox.example.test/");
    // Self-hosted outboxes run the same locked-mailbox contract, so the
    // per-pairing scope applies to every outbox URL, not only the managed one.
    assert.ok(parsed.outboxUrl);
    const outboxUrl = new URL(parsed.outboxUrl);
    assert.equal(`${outboxUrl.origin}${outboxUrl.pathname}`, "https://mailbox.example.test/v1/mailbox/events");
    assert.equal(outboxUrl.searchParams.get("mailboxId"), mailboxScopeIdForSealKey(parsed.relaySealKeyBase64));
    assert.ok(result.pwaUrl?.startsWith("https://app.example.test/mobile/"));
  } finally {
    await cleanup();
  }
});

test("mobile control settings provide AccordAgents managed staging endpoints by default", () => {
  const settings = mobileControlSettingsFromEnvironment({});

  assert.equal(settings.provider, "accord-managed");
  assert.deepEqual(settings.defaults, ACCORD_MANAGED_MOBILE_CONTROL_DEFAULTS);
});

test("MobilePairingService scopes the managed outbox mailbox by a seal-key derivation, not the routing id", async () => {
  const { storage, cleanup } = await testStorage();
  try {
    const service = new MobilePairingService(new ChatEventLogService(storage, fixedClock()), fixedClock());
    const result = await service.createPairing({
      ...ACCORD_MANAGED_MOBILE_CONTROL_DEFAULTS,
      ttlMinutes: 5
    });
    const parsed = parseMobilePairingPayload(result.qrPayload, new Date("2026-08-06T00:04:00.000Z"));

    assert.equal(parsed.mailboxUrl, "https://relay.accordagents.com/");
    assert.ok(parsed.outboxUrl);
    const outboxUrl = new URL(parsed.outboxUrl);
    assert.equal(`${outboxUrl.origin}${outboxUrl.pathname}`, "https://relay.accordagents.com/v1/mailbox/events");
    // The mailbox id must be derivable from the seal key alone (the phone
    // recomputes it from the link) and must not leak the routing identity.
    assert.equal(outboxUrl.searchParams.get("mailboxId"), mailboxScopeIdForSealKey(parsed.relaySealKeyBase64));
    assert.notEqual(outboxUrl.searchParams.get("mailboxId"), parsed.stableRoutingId);
    assert.match(result.pwaUrl ?? "", /outbox=/);
  } finally {
    await cleanup();
  }
});

test("two pairings from one desktop get distinct locked mailboxes", async () => {
  const { storage, cleanup } = await testStorage();
  try {
    const service = new MobilePairingService(new ChatEventLogService(storage, fixedClock()), fixedClock());
    const first = await service.createPairing({ ...ACCORD_MANAGED_MOBILE_CONTROL_DEFAULTS, ttlMinutes: 5 });
    const second = await service.createPairing({ ...ACCORD_MANAGED_MOBILE_CONTROL_DEFAULTS, ttlMinutes: 5 });

    assert.equal(first.package.stableRoutingId, second.package.stableRoutingId);
    const firstMailboxId = new URL(first.package.outboxUrl ?? "").searchParams.get("mailboxId");
    const secondMailboxId = new URL(second.package.outboxUrl ?? "").searchParams.get("mailboxId");
    assert.ok(firstMailboxId);
    // Same desktop, fresh seal key per link: each pairing must land in its
    // own mailbox so one phone's lock can never clobber another's.
    assert.notEqual(firstMailboxId, secondMailboxId);
  } finally {
    await cleanup();
  }
});

test("mobile control settings ignore unsafe managed endpoint defaults", () => {
  const settings = mobileControlSettingsFromEnvironment({
    ACCORDAGENTS_DISABLE_MANAGED_MOBILE_DEFAULTS: "1",
    ACCORDAGENTS_MOBILE_RELAY_URL: "https://relay.example.test/v1/relay",
    ACCORDAGENTS_MOBILE_STATIC_ORIGIN_URL: "http://app.example.test/mobile/"
  });

  assert.equal(settings.provider, "none");
  assert.deepEqual(settings.defaults, {});
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

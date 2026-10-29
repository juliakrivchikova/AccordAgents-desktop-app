import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ACCORD_MANAGED_MOBILE_CONTROL_DEFAULTS,
  mobileControlSettingsFromEnvironment,
  parseMobilePairingPayload
} from "../../shared/mobilePairing";
import { DeviceIdentityService } from "./deviceIdentity";
import { MobilePairingService } from "./mobilePairing";
import { StorageService } from "./storage";

test("a machine enrollment names the User's server and keeps its room apart from its routing identity", async () => {
  const { storage, cleanup } = await testStorage();
  try {
    const service = new MobilePairingService(new DeviceIdentityService(storage, fixedClock()), fixedClock());
    const result = await service.createPairing({ purpose: "machine-host", hubUrl: "https://hub.example.test", ttlMinutes: 5 });
    const parsed = parseMobilePairingPayload(result.qrPayload, new Date("2026-08-06T00:04:00.000Z"));
    const capability = parsed.capabilities[0];

    assert.equal(parsed.version, 1);
    assert.equal(parsed.purpose, "machine-host");
    assert.equal(parsed.hubUrl, "https://hub.example.test/");
    assert.equal(capability.scope, "device");
    assert.equal(capability.canRead, true);
    assert.equal(capability.canWrite, true);
    assert.equal(parsed.rendezvousId.startsWith("rv-"), true);
    assert.equal(parsed.stableRoutingId.startsWith("route-"), true);
    assert.notEqual(parsed.rendezvousId, parsed.stableRoutingId);
    assert.match(parsed.relaySealKeyBase64, /^[A-Za-z0-9_-]+$/);
    assert.match(parsed.fingerprint, /^[0-9A-F]{4}(-[0-9A-F]{4}){5}$/);
    // Nothing of the shared relay is named any more.
    for (const field of ["relayUrl", "mailboxUrl", "outboxUrl", "staticOriginUrl", "power"]) {
      assert.equal(field in parsed, false, field);
    }
  } finally {
    await cleanup();
  }
});

test("no machine enrollment without the User's server, and no phone pairing here at all", async () => {
  const { storage, cleanup } = await testStorage();
  try {
    const service = new MobilePairingService(new DeviceIdentityService(storage, fixedClock()), fixedClock());
    await assert.rejects(service.createPairing({ purpose: "machine-host" }), /Set up your server first/);
    await assert.rejects(service.createPairing({ purpose: "machine-host", hubUrl: "http://hub.example.test" }), /HTTPS/);
    await assert.rejects(service.createPairing({ purpose: "phone-control" as never, hubUrl: "https://hub.example.test" }), /pairs with your server/);
    // A test server on this computer is reached over plain HTTP.
    const local = await service.createPairing({ purpose: "machine-host", hubUrl: "http://127.0.0.1:18731" });
    assert.equal(local.package.hubUrl, "http://127.0.0.1:18731/");
  } finally {
    await cleanup();
  }
});

test("parseMobilePairingPayload rejects expired packages, other purposes and unsafe server addresses", async () => {
  const { storage, cleanup } = await testStorage();
  try {
    const service = new MobilePairingService(new DeviceIdentityService(storage, fixedClock()), fixedClock());
    const result = await service.createPairing({ purpose: "machine-host", hubUrl: "https://hub.example.test", ttlMinutes: 1 });

    assert.throws(() => parseMobilePairingPayload(result.qrPayload, new Date("2026-08-06T00:02:00.000Z")), /expired/);
    const at = new Date("2026-08-06T00:00:10.000Z");
    const changed = (patch: Record<string, unknown>): string => JSON.stringify({ ...JSON.parse(result.qrPayload), ...patch });
    assert.throws(() => parseMobilePairingPayload(changed({ purpose: "phone-control" }), at), /purpose is invalid/);
    assert.throws(() => parseMobilePairingPayload(changed({ hubUrl: "http://hub.example.test/" }), at), /hubUrl must be an https URL/);
    assert.doesNotThrow(() => parseMobilePairingPayload(result.qrPayload, at));
  } finally {
    await cleanup();
  }
});

test("the phone's app is loaded from the managed site by default; the phone itself talks only to the User's server", () => {
  const settings = mobileControlSettingsFromEnvironment({});
  assert.equal(settings.provider, "accord-managed");
  assert.deepEqual(settings.defaults, ACCORD_MANAGED_MOBILE_CONTROL_DEFAULTS);
  assert.deepEqual(Object.keys(settings.defaults), ["staticOriginUrl"]);
  assert.equal(mobileControlSettingsFromEnvironment({ ACCORDAGENTS_MOBILE_STATIC_ORIGIN_URL: "https://app.example.test/mobile/" }).defaults.staticOriginUrl,
    "https://app.example.test/mobile/");
});

test("mobile control settings ignore an unsafe site for the phone's app", () => {
  const settings = mobileControlSettingsFromEnvironment({
    ACCORDAGENTS_DISABLE_MANAGED_MOBILE_DEFAULTS: "1",
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

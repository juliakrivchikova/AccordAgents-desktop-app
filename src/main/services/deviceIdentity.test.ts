import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DeviceIdentityService } from "./deviceIdentity";
import { deviceIdForPublicKey, signHubRequest, parseHubAuthorization, verifyHubRequest } from "./hubAuth";
import { StorageService } from "./storage";

test("a device keeps one identity across restarts, and its requests verify against the key the roster names", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "accordagents-device-identity-"));
  try {
    const dbPath = path.join(dir, "test.sqlite3");
    const first = await new DeviceIdentityService(new StorageService({ dbPath })).getOrCreateDeviceIdentity();
    const again = await new DeviceIdentityService(new StorageService({ dbPath })).getOrCreateDeviceIdentity();
    assert.deepEqual(again, first, "the same identity after a restart");
    assert.match(first.originId, /^device-[0-9a-f]{32}$/);
    assert.equal(deviceIdForPublicKey(first.publicKeyDerBase64), first.originId, "the device id is the server's id for its key");
    const header = signHubRequest(first, { method: "GET", pathWithQuery: "/v3/chats", body: "" });
    const auth = parseHubAuthorization(header);
    assert.ok(auth);
    assert.equal(verifyHubRequest(auth, {
      method: "GET", pathWithQuery: "/v3/chats", body: Buffer.alloc(0), publicKeyDerBase64: first.publicKeyDerBase64, now: Date.now(),
      seenNonce: () => false
    }), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

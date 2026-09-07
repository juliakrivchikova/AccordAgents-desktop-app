/**
 * The phone's wake request must be the same signed call the desktop would make.
 * Two implementations exist only because the PWA cannot load TypeScript or the
 * AWS SDK; this asserts they cannot drift apart. The TypeScript one is itself
 * checked against @smithy/signature-v4, so this chain reaches the real signer.
 */
import assert from "node:assert/strict";
import { createHash, createHmac, webcrypto } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, "..");
const phone = require(path.join(repoRoot, "src/mobile/mobile-machine-wake.js"));
const desktop = require(path.join(repoRoot, "dist/main/shared/machineWakeRequest.js"));

const credentials = {
  accessKeyId: "AKIAEXAMPLEWAKEKEY001",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  region: "us-east-1"
};
const nodeCrypto = {
  async sha256Hex(data) { return createHash("sha256").update(data).digest("hex"); },
  async hmacSha256(key, data) { return new Uint8Array(createHmac("sha256", key).update(data).digest()); }
};
const now = new Date("2026-09-07T09:30:00.000Z");

test("the phone signs the same wake request the desktop does", async () => {
  for (const action of ["start", "describe"]) {
    const fromPhone = await phone.machineWakeRequest({
      action, instanceId: "i-0943b28f7231ab93c", credentials, crypto: nodeCrypto, now
    });
    const fromDesktop = await desktop.machineWakeRequest({
      action, instanceId: "i-0943b28f7231ab93c", credentials, crypto: nodeCrypto, now
    });
    assert.deepEqual(fromPhone, fromDesktop, action + " must be byte-identical on both");
  }
});

test("the phone's WebCrypto path matches its own Node path", async () => {
  const viaNode = await phone.machineWakeRequest({
    action: "start", instanceId: "i-0943b28f7231ab93c", credentials, crypto: nodeCrypto, now
  });
  const viaWebCrypto = await phone.machineWakeRequest({
    action: "start", instanceId: "i-0943b28f7231ab93c", credentials,
    crypto: phone.webCrypto(webcrypto.subtle), now
  });
  assert.deepEqual(viaWebCrypto, viaNode);
});

test("the phone cannot aim the key at another instance or region", async () => {
  await assert.rejects(phone.machineWakeRequest({
    action: "start", instanceId: "i-not-valid", credentials, crypto: nodeCrypto, now
  }), /instance id from its pairing/);
  await assert.rejects(phone.machineWakeRequest({
    action: "start", instanceId: "i-0943b28f7231ab93c",
    credentials: { ...credentials, region: "moon-1" }, crypto: nodeCrypto, now
  }), /Invalid AWS region/);
  const start = await phone.machineWakeRequest({
    action: "start", instanceId: "i-0943b28f7231ab93c", credentials, crypto: nodeCrypto, now
  });
  assert.ok(!/StopInstances|TerminateInstances/.test(start.body), "the phone cannot stop or terminate a machine");
});

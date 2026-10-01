// The phone's start key goes from the desktop's pairing link to the phone's
// saved pairing, in the link's fragment only: the desktop builds the link,
// the phone app reads it, and the wake button finds the key where it looks.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "..");
const { mobilePairingPwaUrl, mobilePairingWithStartKey } = require(path.join(root, "dist/main/shared/mobilePairing.js"));

function phoneApp() {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
    removeItem: (key) => { store.delete(key); }
  };
  delete require.cache[path.join(root, "src/mobile/mobile-app.js")];
  require(path.join(root, "src/mobile/mobile-app.js"));
  return globalThis.AccordAgentsMobile;
}

const { MobilePairingService } = require(path.join(root, "dist/main/main/services/mobilePairing.js"));
const { generateKeyPairSync } = require("node:crypto");
const { publicKey } = generateKeyPairSync("ed25519");
// A real package, as the desktop mints it.
const eventLog = { getOrCreateDeviceIdentity: async () => ({ originId: "origin-desk", keyId: "key-desk",
  publicKeyDerBase64: publicKey.export({ type: "spki", format: "der" }).toString("base64") }) };
const minted = await new MobilePairingService(eventLog).createPairing({ staticOriginUrl: "https://mobile.accordagents.com/" });
const pairing = minted.package;
const power = {
  version: 1, handoffId: "h-1", machineId: "m-1", instanceId: "i-0943b28f7231ab93c", region: "us-east-1",
  credentials: { accessKeyId: "AKIAWAKEKEY000000001", secretAccessKey: "wake/secret+value==", region: "us-east-1" },
  issuedTo: pairing.stableRoutingId, issuedAt: "2026-10-01T00:00:00.000Z"
};

test("the link the desktop shows carries the phone's start key in its fragment, and the phone keeps it", () => {
  const shown = mobilePairingWithStartKey(minted, power);
  const link = new URL(shown.pwaUrl);
  assert.equal(link.searchParams.has("w"), false, "the key is never in the part sent to the server");
  assert.equal(link.search.includes("AKIAWAKEKEY"), false);
  assert.match(link.hash, /^#k=[A-Za-z0-9_-]+&w=i-0943b28f7231ab93c\.us-east-1\.AKIAWAKEKEY000000001\.wake%2Fsecret%2Bvalue%3D%3D$/);
  assert.equal(JSON.stringify(shown.package).includes("wake/secret+value=="), false, "what the desktop keeps of the pairing holds no secret");
  assert.equal(shown.package.powerHandoffId, power.handoffId, "only which handoff it carried, so revoking it works");
  assert.equal(shown.package.power, undefined);
  const app = phoneApp();
  const saved = app.readBootstrapFromLocation({ href: link.toString() });
  assert.deepEqual(saved.power, {
    instanceId: power.instanceId, region: "us-east-1",
    credentials: { accessKeyId: "AKIAWAKEKEY000000001", secretAccessKey: "wake/secret+value==", region: "us-east-1" }
  });
  assert.deepEqual(JSON.parse(globalThis.localStorage.getItem("accordagents.mobile.pairing.v1")).power, saved.power,
    "it is kept on this device, where the wake button reads it");
});

test("a link without a start key pairs the phone without one, and a damaged one is left out", () => {
  const app = phoneApp();
  assert.equal(app.readBootstrapFromLocation({ href: mobilePairingWithStartKey(minted, undefined).pwaUrl }).power, undefined);
  const damaged = new URL(mobilePairingPwaUrl({ ...pairing, power }));
  damaged.hash = damaged.hash.replace(/&w=.*$/, "&w=i-0943b28f7231ab93c.us-east-1");
  const saved = app.readBootstrapFromLocation({ href: damaged.toString() });
  assert.equal(saved.power, undefined);
  assert.equal(saved.rendezvousId, pairing.rendezvousId, "the pairing itself still works");
});

test("after pairing, the start key is gone from the address bar and the history entry", () => {
  const app = phoneApp();
  const link = mobilePairingWithStartKey(minted, power).pwaUrl;
  const replaced = [];
  globalThis.location = new URL(link);
  globalThis.history = { replaceState: (_state, _title, url) => { replaced.push(url); } };
  try {
    app.readBootstrapFromLocation(globalThis.location);
  } finally {
    delete globalThis.location;
    delete globalThis.history;
  }
  assert.equal(replaced.length, 1);
  assert.doesNotMatch(replaced[0], /#|w=|AKIAWAKE|secret/);
});

test("AWS's answer to Wake reads as something the User can act on", () => {
  const app = phoneApp();
  const xml = (code) => `<Response><Errors><Error><Code>${code}</Code><Message>m</Message></Error></Errors></Response>`;
  assert.match(app.machineWakeFailure(400, xml("IncorrectInstanceState")), /still stopping/);
  assert.match(app.machineWakeFailure(400, xml("InvalidInstanceID.NotFound")), /no longer exists\. Pair this phone again/);
  for (const code of ["AuthFailure", "UnauthorizedOperation", "InvalidClientTokenId"]) {
    assert.match(app.machineWakeFailure(403, xml(code)), /no longer accepts this phone's start key/, code);
  }
  assert.match(app.machineWakeFailure(403, ""), /no longer accepts this phone's start key/);
  assert.equal(app.machineWakeFailure(500, xml("InternalError")), "AWS refused the request (InternalError).");
});

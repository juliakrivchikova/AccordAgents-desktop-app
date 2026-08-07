import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createReferenceRelayServer } = require("./relay-reference-server.cjs");

test("RelayTunnelClient forwards sealed ciphertext and reassembles chunks", async () => {
  const { RelayTunnelClient } = await import("../dist/main/main/services/relayTunnelClient.js");
  const relay = createReferenceRelayServer();
  const address = await relay.listen();
  try {
    const desktop = new RelayTunnelClient({
      relayUrl: address.url,
      rendezvousId: "pair-client-1",
      role: "desktop",
      capability: "cap-client-1",
      streamId: "stream-client-1"
    });
    const phone = new RelayTunnelClient({
      relayUrl: address.url,
      rendezvousId: "pair-client-1",
      role: "phone",
      capability: "cap-client-1",
      streamId: "stream-client-1"
    });
    const received = nextMessage(desktop);

    await desktop.connect();
    await phone.connect();
    await phone.sendCiphertext({
      logicalMessageId: "message-1",
      ciphertext: "sealed-ciphertext"
    });

    assert.deepEqual(await received, {
      logicalMessageId: "message-1",
      ciphertext: "sealed-ciphertext"
    });
    desktop.close();
    phone.close();
  } finally {
    await relay.close();
  }
});

test("RelayTunnelClient distinguishes forced relay close from desktop gone", async () => {
  const { RelayTunnelClient } = await import("../dist/main/main/services/relayTunnelClient.js");
  const relay = createReferenceRelayServer();
  const address = await relay.listen();
  try {
    const desktop = new RelayTunnelClient({
      relayUrl: address.url,
      rendezvousId: "pair-client-2",
      role: "desktop",
      capability: "cap-client-2",
      streamId: "stream-client-2",
      reconnectDelayMs: 50
    });
    const states = [];
    desktop.on("state", (state) => states.push(state));

    await desktop.connect();
    desktop.forceSocketCloseForTests();
    await waitForState(states, "tunnel-reconnecting");

    assert.ok(states.includes("connected"));
    assert.ok(states.includes("tunnel-reconnecting"));
    desktop.close();
  } finally {
    await relay.close();
  }
});

function nextMessage(client) {
  return new Promise((resolve) => {
    const off = client.on("message", (message) => {
      off();
      resolve(message);
    });
  });
}

function waitForState(states, expected) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (states.includes(expected)) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - started > 1000) {
        clearInterval(timer);
        reject(new Error(`State ${expected} was not observed.`));
      }
    }, 10);
  });
}

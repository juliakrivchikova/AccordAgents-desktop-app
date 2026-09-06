import assert from "node:assert/strict";
import http from "node:http";
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

test("RelayTunnelClient rejects HTTP upgrade failures without uncaught exceptions", async () => {
  const { RelayTunnelClient } = await import("../dist/main/main/services/relayTunnelClient.js");
  const server = http.createServer((_request, response) => {
    response.writeHead(429);
    response.end();
  });
  server.on("upgrade", (_request, socket) => {
    socket.write("HTTP/1.1 429 Too Many Requests\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    socket.destroy();
  });
  const address = await listen(server);
  const client = new RelayTunnelClient({
    relayUrl: address.url,
    rendezvousId: "pair-client-429",
    role: "desktop",
    capability: "cap-client-429",
    streamId: "stream-client-429"
  });
  try {
    await assert.rejects(
      () => client.connect(),
      /Relay tunnel rejected with HTTP 429/
    );
  } finally {
    client.close();
    await close(server);
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

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("HTTP server did not expose a TCP address."));
        return;
      }
      resolve({ url: `ws://127.0.0.1:${address.port}/v1/relay` });
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
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

// A connection that fails before opening rejects the open promise AND fires
// its close event. Each of the two used to schedule its own retry, so one
// network blip doubled the reconnect loops forever — and once the relay
// seats the newest connection, surplus loops evict each other's sockets
// once a second for good.
test("RelayTunnelClient runs exactly one reconnect loop after a failed connect", async () => {
  const { RelayTunnelClient } = await import("../dist/main/main/services/relayTunnelClient.js");
  const net = await import("node:net");
  let attempts = 0;
  const server = net.createServer((socket) => {
    attempts += 1;
    socket.destroy();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const client = new RelayTunnelClient({
    relayUrl: `ws://127.0.0.1:${port}/v1/relay`,
    rendezvousId: "pair-client-4",
    role: "desktop",
    capability: "cap-client-4",
    streamId: "stream-client-4",
    reconnectDelayMs: 50
  });
  client.on("error", () => {});
  await client.connect().catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 450));
  client.close();
  await new Promise((resolve) => server.close(resolve));
  // Single-flight allows the initial attempt plus one per 50ms window over
  // 450ms, with slack for timer jitter. The doubling bug multiplies the
  // attempts per window and lands far beyond this.
  assert.ok(attempts <= 11, `expected a single reconnect loop, saw ${attempts} attempts`);
  assert.ok(attempts >= 3, `reconnect loop should keep retrying, saw ${attempts} attempts`);
});

// W-F(c): a refused relay must be re-dialed with widening gaps, not hammered
// at a fixed cadence for the whole outage. The gaps grow exponentially (with
// jitter) and a successful open resets them — the reset is pinned by the
// open-handler's reconnectAttempts = 0.
test("RelayTunnelClient widens the reconnect gap while the relay refuses", async () => {
  const { RelayTunnelClient } = await import("../dist/main/main/services/relayTunnelClient.js");
  const net = await import("node:net");
  const stamps = [];
  const server = net.createServer((socket) => {
    stamps.push(Date.now());
    socket.destroy();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const client = new RelayTunnelClient({
    relayUrl: `ws://127.0.0.1:${port}/v1/relay`,
    rendezvousId: "pair-client-5",
    role: "desktop",
    capability: "cap-client-5",
    streamId: "stream-client-5",
    reconnectDelayMs: 60
  });
  client.on("error", () => {});
  await client.connect().catch(() => {});
  while (stamps.length < 5) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  client.close();
  await new Promise((resolve) => server.close(resolve));
  const gaps = stamps.slice(1).map((at, index) => at - stamps[index]);
  // With jitter in [0.75, 1.25] a doubling schedule keeps successive gaps at
  // least 1.2x apart; a fixed schedule keeps them equal and fails here.
  assert.ok(gaps[2] > gaps[1] * 1.2, `gap 3 must outgrow gap 2: ${JSON.stringify(gaps)}`);
  assert.ok(gaps[3] > gaps[2] * 1.2, `gap 4 must outgrow gap 3: ${JSON.stringify(gaps)}`);
});

test("RelayTunnelClient does not dial again for a socket it already replaced", async () => {
  const { RelayTunnelClient } = await import("../dist/main/main/services/relayTunnelClient.js");
  const relay = createReferenceRelayServer();
  const address = await relay.listen();
  try {
    const machine = new RelayTunnelClient({
      relayUrl: address.url,
      rendezvousId: "pair-replaced-1",
      role: "machine",
      deviceId: "did-machine-1",
      capability: "cap-replaced-1",
      streamId: "stream-replaced-1",
      reconnectDelayMs: 20
    });
    const errors = [];
    machine.on("error", (error) => errors.push(error.message));
    await machine.connect();
    // Close and dial again before the relay has processed the old close: the
    // old socket's close event arrives while the new socket is live and must
    // not start a second dial (which would evict the live socket, whose close
    // would dial again, forever).
    machine.close();
    await machine.connect();
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(machine.currentState(), "connected");
    assert.deepEqual(errors.filter((message) => message.includes("4001")), [], "no eviction loop after close+connect");
    machine.close();
  } finally {
    await relay.close();
  }
});

test("RelayTunnelClient does not dial again for a reconnect attempt it already abandoned", async () => {
  const { RelayTunnelClient } = await import("../dist/main/main/services/relayTunnelClient.js");
  const relay = createReferenceRelayServer();
  const address = await relay.listen();
  try {
    const machine = new RelayTunnelClient({
      relayUrl: address.url,
      rendezvousId: "pair-abandoned-1",
      role: "machine",
      deviceId: "did-machine-2",
      capability: "cap-abandoned-1",
      streamId: "stream-abandoned-1",
      reconnectDelayMs: 20
    });
    const errors = [];
    let connectedTransitions = 0;
    machine.on("error", (error) => errors.push(error.message));
    machine.on("state", (state) => { if (state === "connected") connectedTransitions += 1; });
    await machine.connect();
    // The relay drops the socket; the client schedules an automatic dial.
    machine.forceSocketCloseForTests();
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Before that dial completes, the owner closes and reconnects explicitly:
    // the abandoned attempt (and its failure handler) must not dial again.
    machine.close();
    await machine.connect();
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(machine.currentState(), "connected");
    assert.deepEqual(errors.filter((message) => message.includes("4001")), [], "no eviction after an abandoned attempt");
    assert.equal(connectedTransitions, 2, "exactly the initial connection and the explicit reconnect");
    machine.close();
  } finally {
    await relay.close();
  }
});

test("RelayTunnelClient targets machines by device id and reports peers", async () => {
  const { RelayTunnelClient } = await import("../dist/main/main/services/relayTunnelClient.js");
  const relay = createReferenceRelayServer();
  const address = await relay.listen();
  try {
    const desktop = new RelayTunnelClient({
      relayUrl: address.url,
      rendezvousId: "pair-client-m",
      role: "desktop",
      capability: "cap-client-m",
      streamId: "stream-client-m"
    });
    const machine = new RelayTunnelClient({
      relayUrl: address.url,
      rendezvousId: "pair-client-m",
      role: "machine",
      deviceId: "device-m1",
      capability: "cap-client-m",
      streamId: "stream-client-m"
    });
    const peerEvents = [];
    desktop.on("peer", (event) => peerEvents.push(event));
    const machinePeerEvents = [];
    machine.on("peer", (event) => machinePeerEvents.push(event));

    await desktop.connect();
    await machine.connect();
    await waitFor(() => peerEvents.some((event) => event.type === "peer-connected" && event.peer.deviceId === "device-m1"));
    await waitFor(() => machinePeerEvents.some((event) => event.type === "ready"));
    assert.deepEqual(machinePeerEvents.find((event) => event.type === "ready").peers, [{ deviceId: "desktop", role: "desktop" }]);

    await assert.rejects(machine.sendCiphertext({ logicalMessageId: "m-0", ciphertext: "x" }), /must target a device id/);

    const received = nextMessage(desktop);
    await machine.sendCiphertext({ logicalMessageId: "m-1", ciphertext: "sealed-from-machine", to: "desktop" });
    assert.deepEqual(await received, { logicalMessageId: "m-1", ciphertext: "sealed-from-machine" });

    const receivedByMachine = nextMessage(machine);
    await desktop.sendCiphertext({ logicalMessageId: "d-1", ciphertext: "sealed-to-machine", to: "device-m1" });
    assert.deepEqual(await receivedByMachine, { logicalMessageId: "d-1", ciphertext: "sealed-to-machine" });

    await desktop.sendCiphertext({ logicalMessageId: "d-2", ciphertext: "nowhere", to: "device-absent" });
    await waitFor(() => peerEvents.some((event) => event.type === "peer-not-connected" && event.to === "device-absent"));

    desktop.close();
    machine.close();
  } finally {
    await relay.close();
  }
});

function waitFor(predicate, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error("waitFor timed out"));
        return;
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

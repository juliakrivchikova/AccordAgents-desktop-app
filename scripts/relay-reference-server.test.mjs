import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createReferenceRelayServer } = require("./relay-reference-server.cjs");

test("reference relay forwards sealed frames between paired desktop and phone", async () => {
  const relay = createReferenceRelayServer();
  const address = await relay.listen();
  try {
    const desktop = await connect(`${address.url}?rid=pair-1&role=desktop&cap=cap-1`);
    const phone = await connect(`${address.url}?rid=pair-1&role=phone&cap=cap-1`);
    await phone.nextJson();
    await desktop.nextJson();
    await desktop.nextJson();
    const forwarded = desktop.nextJson();

    phone.socket.send(JSON.stringify(frame("message-1", "sealed-ciphertext")));

    assert.deepEqual(await forwarded, frame("message-1", "sealed-ciphertext"));
    desktop.socket.close();
    phone.socket.close();
  } finally {
    await relay.close();
  }
});

test("reference relay does not store frames sent before a peer connects", async () => {
  const relay = createReferenceRelayServer();
  const address = await relay.listen();
  try {
    const phone = await connect(`${address.url}?rid=pair-2&role=phone&cap=cap-2`);
    await phone.nextJson();
    const error = phone.nextJson();
    phone.socket.send(JSON.stringify(frame("message-before-peer", "sealed-ciphertext")));

    assert.deepEqual(await error, { type: "relay.error", code: "peer-not-connected" });

    const desktop = await connect(`${address.url}?rid=pair-2&role=desktop&cap=cap-2`);
    const control = await desktop.nextJson();

    assert.equal(control.type, "relay.ready");
    desktop.socket.close();
    phone.socket.close();
  } finally {
    await relay.close();
  }
});

test("reference relay closes frames above the provider floor with 1009", async () => {
  const relay = createReferenceRelayServer({ maxFrameBytes: 200 });
  const address = await relay.listen();
  try {
    const phone = await connect(`${address.url}?rid=pair-3&role=phone&cap=cap-3`);
    await phone.nextJson();
    const closed = phone.closedWith();

    phone.socket.send(JSON.stringify(frame("message-too-large", "x".repeat(500))));

    assert.deepEqual(await closed, { code: 1009, reason: "relay frame exceeds provider floor" });
    phone.socket.close();
  } finally {
    await relay.close();
  }
});

// Parity with the worker room: a silently dead socket reads as OPEN forever,
// so the newest connection must win the seat — refusing it locks the real
// client out behind its own ghost.
test("reference relay seats the newest connection and evicts the previous holder", async () => {
  const relay = createReferenceRelayServer();
  const address = await relay.listen();
  try {
    const first = await connect(`${address.url}?rid=pair-4&role=phone&cap=cap-4`);
    await first.nextJson();
    const firstClosed = first.closedWith();
    const second = await connect(`${address.url}?rid=pair-4&role=phone&cap=cap-4`);
    const seated = await second.nextJson();

    assert.deepEqual(await firstClosed, { code: 4001, reason: "replaced by newer connection" });
    assert.equal(seated.type, "relay.ready");
    assert.equal(seated.role, "phone");
    second.socket.close();
  } finally {
    await relay.close();
  }
});

function frame(logicalMessageId, ciphertextChunk) {
  return {
    protocol: "accord-relay-v1",
    streamId: "stream-1",
    logicalMessageId,
    frameId: `${logicalMessageId}:0:1`,
    frameIndex: 0,
    frameCount: 1,
    ciphertextChunk
  };
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const inbox = [];
    const waiters = [];
    const closeWaiters = [];
    socket.on("message", (data) => {
      const parsed = JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
      const waiter = waiters.shift();
      if (waiter) {
        waiter(parsed);
        return;
      }
      inbox.push(parsed);
    });
    socket.on("close", (code, reason) => {
      for (const waiter of closeWaiters.splice(0)) {
        waiter({ code, reason: reason.toString("utf8") });
      }
    });
    socket.once("open", () => resolve({
      socket,
      nextJson: () => inbox.length > 0
        ? Promise.resolve(inbox.shift())
        : new Promise((nextResolve) => waiters.push(nextResolve)),
      pending: () => inbox.length,
      closedWith: () => new Promise((nextResolve) => closeWaiters.push(nextResolve))
    }));
    socket.once("error", reject);
  });
}

// Machines transport: a room holds any number of addressed devices. Frames
// with `to` reach exactly that device; untargeted frames keep the legacy
// desktop <-> phone forwarding; phones are not told about machines.
test("reference relay addresses machines by device id and keeps the legacy pair untouched", async () => {
  const relay = createReferenceRelayServer();
  const address = await relay.listen();
  try {
    const desktop = await connect(`${address.url}?rid=pair-5&role=desktop&cap=cap-5`);
    const desktopReady = await desktop.nextJson();
    assert.equal(desktopReady.type, "relay.ready");
    assert.equal(desktopReady.deviceId, "desktop");
    assert.deepEqual(desktopReady.peers, []);

    const phone = await connect(`${address.url}?rid=pair-5&role=phone&cap=cap-5`);
    const phoneReady = await phone.nextJson();
    assert.equal(phoneReady.peerConnected, true);
    assert.deepEqual(await desktop.nextJson(), { type: "relay.peer-connected", role: "phone", rendezvousId: "pair-5", deviceId: "phone" });

    const machine = await connect(`${address.url}?rid=pair-5&role=machine&cap=cap-5&did=device-m1`);
    const machineReady = await machine.nextJson();
    assert.equal(machineReady.type, "relay.ready");
    assert.equal(machineReady.deviceId, "device-m1");
    assert.equal(machineReady.peerConnected, true);
    assert.deepEqual(machineReady.peers.map((peer) => peer.deviceId).sort(), ["desktop", "phone"]);
    assert.deepEqual(await desktop.nextJson(), { type: "relay.peer-connected", role: "machine", rendezvousId: "pair-5", deviceId: "device-m1" });

    // Machine -> desktop, targeted: only the desktop sees it.
    const toDesktop = desktop.nextJson();
    machine.socket.send(JSON.stringify({ ...frame("m-1", "sealed-from-machine"), to: "desktop" }));
    assert.deepEqual(await toDesktop, { ...frame("m-1", "sealed-from-machine"), to: "desktop" });

    // Desktop -> machine, targeted.
    const toMachine = machine.nextJson();
    desktop.socket.send(JSON.stringify({ ...frame("d-1", "sealed-to-machine"), to: "device-m1" }));
    assert.deepEqual(await toMachine, { ...frame("d-1", "sealed-to-machine"), to: "device-m1" });

    // Desktop untargeted frame: legacy forwarding to the phone only.
    const toPhone = phone.nextJson();
    desktop.socket.send(JSON.stringify(frame("d-2", "sealed-legacy")));
    assert.deepEqual(await toPhone, frame("d-2", "sealed-legacy"));

    // Targeting an absent device answers with the target named.
    const missing = desktop.nextJson();
    desktop.socket.send(JSON.stringify({ ...frame("d-3", "sealed-nowhere"), to: "device-absent" }));
    assert.deepEqual(await missing, { type: "relay.error", code: "peer-not-connected", to: "device-absent" });

    // The phone never heard about the machine, and the machine leaving is
    // announced to the desktop only.
    const machineGone = desktop.nextJson();
    machine.socket.close();
    assert.deepEqual(await machineGone, { type: "relay.peer-disconnected", role: "machine", rendezvousId: "pair-5", deviceId: "device-m1" });
    assert.equal(phone.pending(), 0);

    desktop.socket.close();
    phone.socket.close();
  } finally {
    await relay.close();
  }
});

test("reference relay requires a device id for machines and seats newest per device id", async () => {
  const relay = createReferenceRelayServer();
  const address = await relay.listen();
  try {
    const rejected = await connect(`${address.url}?rid=pair-6&role=machine&cap=cap-6`);
    assert.deepEqual(await rejected.closedWith(), { code: 1008, reason: "invalid relay pairing request" });

    const first = await connect(`${address.url}?rid=pair-6&role=machine&cap=cap-6&did=device-m2`);
    await first.nextJson();
    const firstClosed = first.closedWith();
    const second = await connect(`${address.url}?rid=pair-6&role=machine&cap=cap-6&did=device-m2`);
    const seated = await second.nextJson();
    assert.deepEqual(await firstClosed, { code: 4001, reason: "replaced by newer connection" });
    assert.equal(seated.deviceId, "device-m2");
    second.socket.close();
  } finally {
    await relay.close();
  }
});

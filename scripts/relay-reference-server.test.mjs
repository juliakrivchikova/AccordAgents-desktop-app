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

test("reference relay rejects a duplicate role for a rendezvous", async () => {
  const relay = createReferenceRelayServer();
  const address = await relay.listen();
  try {
    const first = await connect(`${address.url}?rid=pair-4&role=phone&cap=cap-4`);
    await first.nextJson();
    const second = await connect(`${address.url}?rid=pair-4&role=phone&cap=cap-4`);
    const closed = await second.closedWith();

    assert.deepEqual(closed, { code: 1008, reason: "duplicate relay role" });
    first.socket.close();
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
      closedWith: () => new Promise((nextResolve) => closeWaiters.push(nextResolve))
    }));
    socket.once("error", reject);
  });
}

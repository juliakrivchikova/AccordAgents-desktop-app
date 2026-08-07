import assert from "node:assert/strict";
import test from "node:test";
import {
  AWS_API_GATEWAY_WEBSOCKET_RELAY_MANIFEST,
  KNOWN_RELAY_PROVIDER_MANIFESTS,
  PUSHER_SIZED_RELAY_FLOOR,
  assertRelayCapabilityManifest,
  chunkRelayCiphertext,
  reassembleRelayCiphertext,
  smallestRelayFrameFloor
} from "../../shared/relayProtocol";

test("chunkRelayCiphertext fits every frame under the Pusher-sized floor", () => {
  const frames = chunkRelayCiphertext({
    streamId: "desktop-phone",
    logicalMessageId: "message-1",
    ciphertext: "a".repeat(31_000),
    manifest: PUSHER_SIZED_RELAY_FLOOR,
    cursor: "event-9"
  });

  assert.ok(frames.length > 1);
  assert.ok(frames.every((frame) => Buffer.byteLength(JSON.stringify(frame), "utf8") <= 10_240));
  assert.deepEqual(frames.map((frame) => frame.frameId), [
    `message-1:0:${frames.length}`,
    `message-1:1:${frames.length}`,
    `message-1:2:${frames.length}`,
    `message-1:3:${frames.length}`
  ]);
});

test("reassembleRelayCiphertext completes after shuffled duplicate-safe frames", () => {
  const frames = chunkRelayCiphertext({
    streamId: "desktop-phone",
    logicalMessageId: "message-1",
    ciphertext: "sealed".repeat(5_000)
  });
  const duplicatedAndShuffled = [frames[2], frames[0], frames[1], frames[2], frames[3]];

  assert.deepEqual(reassembleRelayCiphertext(duplicatedAndShuffled), {
    status: "complete",
    streamId: "desktop-phone",
    logicalMessageId: "message-1",
    ciphertext: "sealed".repeat(5_000)
  });
});

test("reassembleRelayCiphertext reports missing frame indexes for resume", () => {
  const frames = chunkRelayCiphertext({
    streamId: "desktop-phone",
    logicalMessageId: "message-1",
    ciphertext: "x".repeat(21_000)
  });

  assert.deepEqual(reassembleRelayCiphertext([frames[0], frames[2]]), {
    status: "missing",
    streamId: "desktop-phone",
    logicalMessageId: "message-1",
    missingFrameIndexes: [1]
  });
});

test("reassembleRelayCiphertext rejects conflicting duplicate frames", () => {
  const frames = chunkRelayCiphertext({
    streamId: "desktop-phone",
    logicalMessageId: "message-1",
    ciphertext: "x".repeat(21_000)
  });

  assert.deepEqual(reassembleRelayCiphertext([
    frames[0],
    { ...frames[0], ciphertextChunk: "different" }
  ]), {
    status: "conflict",
    reason: "duplicate frame index with different ciphertext"
  });
});

test("assertRelayCapabilityManifest rejects providers below the protocol floor", () => {
  assert.throws(
    () => assertRelayCapabilityManifest({
      provider: "too-small",
      maxFrameBytes: 8_192,
      maxLogicalMessageBytes: 1_000_000,
      binaryFrames: false,
      textFrames: true,
      providerHistory: "none"
    }),
    /frame size is below the protocol floor/
  );
});

test("known relay provider manifests declare numerical floors and reconnect constraints", () => {
  for (const manifest of KNOWN_RELAY_PROVIDER_MANIFESTS) {
    assert.doesNotThrow(() => assertRelayCapabilityManifest(manifest));
  }

  assert.equal(smallestRelayFrameFloor(KNOWN_RELAY_PROVIDER_MANIFESTS), 10_240);
  assert.equal(AWS_API_GATEWAY_WEBSOCKET_RELAY_MANIFEST.maxFrameBytes, 32 * 1024);
  assert.equal(AWS_API_GATEWAY_WEBSOCKET_RELAY_MANIFEST.maxLogicalMessageBytes, 128 * 1024);
  assert.equal(AWS_API_GATEWAY_WEBSOCKET_RELAY_MANIFEST.idleTimeoutMs, 10 * 60 * 1000);
  assert.equal(AWS_API_GATEWAY_WEBSOCKET_RELAY_MANIFEST.hardConnectionDurationMs, 2 * 60 * 60 * 1000);
  assert.equal(AWS_API_GATEWAY_WEBSOCKET_RELAY_MANIFEST.oversizeCloseCode, 1009);
});

test("relay chunking remains valid at the smallest known provider frame floor", () => {
  const frames = chunkRelayCiphertext({
    streamId: "desktop-phone",
    logicalMessageId: "provider-floor-message",
    ciphertext: "x".repeat(80_000),
    manifest: {
      ...PUSHER_SIZED_RELAY_FLOOR,
      maxFrameBytes: smallestRelayFrameFloor(KNOWN_RELAY_PROVIDER_MANIFESTS)
    }
  });

  assert.ok(frames.length > 1);
  assert.ok(frames.every((frame) => Buffer.byteLength(JSON.stringify(frame), "utf8") <= 10_240));
  assert.equal(reassembleRelayCiphertext(frames).status, "complete");
});

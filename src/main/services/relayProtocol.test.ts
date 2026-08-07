import assert from "node:assert/strict";
import test from "node:test";
import {
  PUSHER_SIZED_RELAY_FLOOR,
  assertRelayCapabilityManifest,
  chunkRelayCiphertext,
  reassembleRelayCiphertext
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

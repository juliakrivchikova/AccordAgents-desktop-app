export interface RelayCapabilityManifest {
  provider: string;
  maxFrameBytes: number;
  maxLogicalMessageBytes: number;
  idleTimeoutMs?: number;
  hardConnectionDurationMs?: number;
  oversizeCloseCode?: number;
  binaryFrames: boolean;
  textFrames: boolean;
  providerHistory: "none" | "disabled" | "ignored-for-correctness";
}

export interface RelayChunkFrame {
  protocol: "accord-relay-v1";
  streamId: string;
  logicalMessageId: string;
  frameId: string;
  frameIndex: number;
  frameCount: number;
  cursor?: string;
  ciphertextChunk: string;
}

export type RelayReassemblyResult =
  | { status: "complete"; streamId: string; logicalMessageId: string; ciphertext: string }
  | { status: "missing"; streamId?: string; logicalMessageId?: string; missingFrameIndexes: number[] }
  | { status: "conflict"; reason: string };

export const RELAY_PROTOCOL_MIN_FRAME_BYTES = 10_240;
export const RELAY_PROTOCOL_DEFAULT_LOGICAL_MESSAGE_BYTES = 10 * 1024 * 1024;

export const SELF_HOSTED_REFERENCE_RELAY_MANIFEST: RelayCapabilityManifest = {
  provider: "self-hosted-reference",
  maxFrameBytes: RELAY_PROTOCOL_MIN_FRAME_BYTES,
  maxLogicalMessageBytes: RELAY_PROTOCOL_DEFAULT_LOGICAL_MESSAGE_BYTES,
  oversizeCloseCode: 1009,
  binaryFrames: false,
  textFrames: true,
  providerHistory: "none"
};

export const AWS_API_GATEWAY_WEBSOCKET_RELAY_MANIFEST: RelayCapabilityManifest = {
  provider: "aws-api-gateway-websocket",
  maxFrameBytes: 32 * 1024,
  maxLogicalMessageBytes: 128 * 1024,
  idleTimeoutMs: 10 * 60 * 1000,
  hardConnectionDurationMs: 2 * 60 * 60 * 1000,
  oversizeCloseCode: 1009,
  binaryFrames: false,
  textFrames: true,
  providerHistory: "disabled"
};

export const ABLY_LOWER_TIER_RELAY_MANIFEST: RelayCapabilityManifest = {
  provider: "ably-lower-tier",
  maxFrameBytes: 64 * 1024,
  maxLogicalMessageBytes: RELAY_PROTOCOL_DEFAULT_LOGICAL_MESSAGE_BYTES,
  binaryFrames: false,
  textFrames: true,
  providerHistory: "ignored-for-correctness"
};

export const ABLY_HIGHER_TIER_RELAY_MANIFEST: RelayCapabilityManifest = {
  provider: "ably-higher-tier",
  maxFrameBytes: 256 * 1024,
  maxLogicalMessageBytes: RELAY_PROTOCOL_DEFAULT_LOGICAL_MESSAGE_BYTES,
  binaryFrames: false,
  textFrames: true,
  providerHistory: "ignored-for-correctness"
};

export const PUSHER_CHANNELS_RELAY_MANIFEST: RelayCapabilityManifest = {
  provider: "pusher-channels",
  maxFrameBytes: RELAY_PROTOCOL_MIN_FRAME_BYTES,
  maxLogicalMessageBytes: RELAY_PROTOCOL_DEFAULT_LOGICAL_MESSAGE_BYTES,
  binaryFrames: false,
  textFrames: true,
  providerHistory: "ignored-for-correctness"
};

export const CLOUDFLARE_DURABLE_OBJECT_RELAY_MANIFEST: RelayCapabilityManifest = {
  provider: "cloudflare-durable-object",
  maxFrameBytes: RELAY_PROTOCOL_MIN_FRAME_BYTES,
  maxLogicalMessageBytes: RELAY_PROTOCOL_DEFAULT_LOGICAL_MESSAGE_BYTES,
  oversizeCloseCode: 1009,
  binaryFrames: false,
  textFrames: true,
  providerHistory: "none"
};

export const PUSHER_SIZED_RELAY_FLOOR: RelayCapabilityManifest = PUSHER_CHANNELS_RELAY_MANIFEST;

export const KNOWN_RELAY_PROVIDER_MANIFESTS: RelayCapabilityManifest[] = [
  SELF_HOSTED_REFERENCE_RELAY_MANIFEST,
  CLOUDFLARE_DURABLE_OBJECT_RELAY_MANIFEST,
  AWS_API_GATEWAY_WEBSOCKET_RELAY_MANIFEST,
  ABLY_LOWER_TIER_RELAY_MANIFEST,
  ABLY_HIGHER_TIER_RELAY_MANIFEST,
  PUSHER_CHANNELS_RELAY_MANIFEST
];

const RELAY_FRAME_OVERHEAD_BYTES = 512;

export function assertRelayCapabilityManifest(manifest: RelayCapabilityManifest): void {
  const requiredStrings = [["provider", manifest.provider]] as const;
  for (const [field, value] of requiredStrings) {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`Relay capability manifest requires ${field}.`);
    }
  }
  if (!Number.isSafeInteger(manifest.maxFrameBytes) || manifest.maxFrameBytes < RELAY_PROTOCOL_MIN_FRAME_BYTES) {
    throw new Error(`Relay provider ${manifest.provider} frame size is below the protocol floor.`);
  }
  if (!Number.isSafeInteger(manifest.maxLogicalMessageBytes) || manifest.maxLogicalMessageBytes < manifest.maxFrameBytes) {
    throw new Error(`Relay provider ${manifest.provider} logical message size is invalid.`);
  }
  if (!manifest.textFrames && !manifest.binaryFrames) {
    throw new Error(`Relay provider ${manifest.provider} must support text or binary frames.`);
  }
  if (manifest.providerHistory !== "none" &&
    manifest.providerHistory !== "disabled" &&
    manifest.providerHistory !== "ignored-for-correctness") {
    throw new Error(`Relay provider ${manifest.provider} has an invalid history policy.`);
  }
  for (const [field, value] of [
    ["idleTimeoutMs", manifest.idleTimeoutMs],
    ["hardConnectionDurationMs", manifest.hardConnectionDurationMs],
    ["oversizeCloseCode", manifest.oversizeCloseCode]
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new Error(`Relay provider ${manifest.provider} ${field} is invalid.`);
    }
  }
}

export function smallestRelayFrameFloor(manifests: RelayCapabilityManifest[]): number {
  if (manifests.length === 0) {
    throw new Error("Relay frame floor requires at least one provider manifest.");
  }
  for (const manifest of manifests) {
    assertRelayCapabilityManifest(manifest);
  }
  return Math.min(...manifests.map((manifest) => manifest.maxFrameBytes));
}

export function chunkRelayCiphertext(request: {
  streamId: string;
  logicalMessageId: string;
  ciphertext: string;
  manifest?: RelayCapabilityManifest;
  cursor?: string;
}): RelayChunkFrame[] {
  const manifest = request.manifest ?? PUSHER_SIZED_RELAY_FLOOR;
  assertRelayCapabilityManifest(manifest);
  if (!request.streamId.trim() || !request.logicalMessageId.trim()) {
    throw new Error("Relay chunking requires streamId and logicalMessageId.");
  }
  if (utf8ByteLength(request.ciphertext) > manifest.maxLogicalMessageBytes) {
    throw new Error(`Relay logical message exceeds ${manifest.provider} maxLogicalMessageBytes.`);
  }
  const chunkSize = manifest.maxFrameBytes - RELAY_FRAME_OVERHEAD_BYTES;
  if (chunkSize <= 0) {
    throw new Error(`Relay provider ${manifest.provider} frame overhead leaves no payload space.`);
  }
  const chunks = chunkAscii(request.ciphertext, chunkSize);
  return chunks.map((chunk, index) => {
    const frame: RelayChunkFrame = {
      protocol: "accord-relay-v1",
      streamId: request.streamId,
      logicalMessageId: request.logicalMessageId,
      frameId: `${request.logicalMessageId}:${index}:${chunks.length}`,
      frameIndex: index,
      frameCount: chunks.length,
      ...(request.cursor ? { cursor: request.cursor } : {}),
      ciphertextChunk: chunk
    };
    const frameBytes = utf8ByteLength(JSON.stringify(frame));
    if (frameBytes > manifest.maxFrameBytes) {
      throw new Error(`Relay frame ${frame.frameId} exceeds ${manifest.provider} maxFrameBytes.`);
    }
    return frame;
  });
}

export function reassembleRelayCiphertext(frames: RelayChunkFrame[]): RelayReassemblyResult {
  if (frames.length === 0) {
    return { status: "missing", missingFrameIndexes: [] };
  }
  const first = frames[0];
  const conflicts = frames.find((frame) =>
    frame.protocol !== "accord-relay-v1" ||
      frame.streamId !== first.streamId ||
      frame.logicalMessageId !== first.logicalMessageId ||
      frame.frameCount !== first.frameCount
  );
  if (conflicts) {
    return { status: "conflict", reason: "mixed relay frames" };
  }
  if (!Number.isSafeInteger(first.frameCount) || first.frameCount < 1) {
    return { status: "conflict", reason: "invalid frame count" };
  }
  const chunks = new Map<number, RelayChunkFrame>();
  for (const frame of frames) {
    if (!Number.isSafeInteger(frame.frameIndex) || frame.frameIndex < 0 || frame.frameIndex >= first.frameCount) {
      return { status: "conflict", reason: "invalid frame index" };
    }
    const existing = chunks.get(frame.frameIndex);
    if (existing && existing.ciphertextChunk !== frame.ciphertextChunk) {
      return { status: "conflict", reason: "duplicate frame index with different ciphertext" };
    }
    chunks.set(frame.frameIndex, frame);
  }
  const missingFrameIndexes = Array.from({ length: first.frameCount }, (_, index) => index)
    .filter((index) => !chunks.has(index));
  if (missingFrameIndexes.length > 0) {
    return {
      status: "missing",
      streamId: first.streamId,
      logicalMessageId: first.logicalMessageId,
      missingFrameIndexes
    };
  }
  return {
    status: "complete",
    streamId: first.streamId,
    logicalMessageId: first.logicalMessageId,
    ciphertext: Array.from({ length: first.frameCount }, (_, index) => chunks.get(index)?.ciphertextChunk ?? "").join("")
  };
}

function chunkAscii(value: string, maxChunkBytes: number): string[] {
  if (value.length === 0) {
    return [""];
  }
  const chunks: string[] = [];
  for (let start = 0; start < value.length; start += maxChunkBytes) {
    chunks.push(value.slice(start, start + maxChunkBytes));
  }
  return chunks;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function nowIso() {
  return new Date().toISOString();
}

// What this phone did and was handed, kept in memory when the page is opened
// with `?qa` (the harnesses read it); nothing otherwise.
export function recordRelayDebug(entry) {
  try {
    if (!new URL(globalThis.location.href).searchParams.has("qa")) {
      return;
    }
    globalThis.__relayDebug = globalThis.__relayDebug || [];
    globalThis.__relayDebug.push({
      at: Date.now(),
      ...entry
    });
  } catch {
    return;
  }
}

export function createEventId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, function (byte) {
    return byte.toString(16).padStart(2, "0");
  }).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20)
  ].join("-");
}

export function base64UrlToBytes(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function textToBytes(value) {
  return new TextEncoder().encode(value);
}

export async function sha256Hex(value) {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Mobile outbox hashing requires WebCrypto.");
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", textToBytes(value));
  return Array.from(new Uint8Array(digest), function (byte) {
    return byte.toString(16).padStart(2, "0");
  }).join("");
}

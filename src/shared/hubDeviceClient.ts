/**
 * One of the User's devices talking to her server with nothing but WebCrypto
 * and fetch: the phone's app and its service worker (bundled by
 * scripts/build-mobile-shell.mjs as `AccordHubClient`). The same bytes the
 * desktop signs (hubRequestSigningText, the chat event hash), so the server
 * and every device check a phone's request and its events exactly as they
 * check the desktop's.
 */

import type { ChatEventEnvelope } from "./chatEvents";
import {
  HUB_AUTH_SCHEME,
  hubBlobFragmentPath,
  hubPhoneEnrollmentSigningText,
  hubRequestSigningText,
  type HubEventPushResponse,
  type HubHealth,
  type HubPhoneEnrollResponse,
  type HubPhoneEnrollment
} from "./hubProtocol";
// The run id a phone's turn takes on its member's home: the phone names it
// in Stop before the turn exists, so it must be built exactly the same way.
export { phoneTurnRunId } from "./hubProtocol";
import { stableJson } from "./stableJson";

/** The fragment size every device splits a large body by. */
export const HUB_CLIENT_BLOB_FRAGMENT_BYTES = 384 * 1024;

export interface HubDeviceIdentity {
  deviceId: string;
  keyId: string;
  publicKeyDerBase64: string;
  privateKeyDerBase64: string;
  createdAt: string;
}

export interface HubBlobReference {
  type: "device.event.blob";
  blobHash: string;
  byteLength: number;
  fragments: number;
}

/** A failure that says nothing about the request: no answer came. */
export class HubUnreachableError extends Error {
  readonly unreachable = true;
}

export class HubAnswerError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`The server answered ${status}.`);
  }
}

/** The slice of WebCrypto this needs, described structurally so it compiles
 *  for the Node main process (tests) and the browser alike. */
interface WebSubtle {
  digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>;
  generateKey(algorithm: { name: string }, extractable: boolean, usages: string[]): Promise<unknown>;
  exportKey(format: "spki" | "pkcs8", key: unknown): Promise<ArrayBuffer>;
  importKey(format: "pkcs8", keyData: Uint8Array, algorithm: { name: string }, extractable: boolean, usages: string[]): Promise<unknown>;
  sign(algorithm: { name: string }, key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
}

interface WebCrypto {
  subtle?: WebSubtle;
  getRandomValues<T extends Uint8Array>(array: T): T;
}

function webCrypto(): WebCrypto {
  const crypto = (globalThis as { crypto?: WebCrypto }).crypto;
  if (!crypto?.subtle) throw new Error("This browser has no WebCrypto.");
  return crypto;
}

function subtle(): WebSubtle {
  return webCrypto().subtle!;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function base64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const encoder = new TextEncoder();

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  const digest = new Uint8Array(await subtle().digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A new signing identity: an Ed25519 key, named as every device names one. */
export async function createHubDeviceIdentity(): Promise<HubDeviceIdentity> {
  let pair: { publicKey: unknown; privateKey: unknown };
  try {
    pair = await subtle().generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as { publicKey: unknown; privateKey: unknown };
  } catch {
    throw new Error("This phone's browser cannot make the key it pairs with (Ed25519). Update iOS or the browser, then pair again.");
  }
  const spki = new Uint8Array(await subtle().exportKey("spki", pair.publicKey));
  const pkcs8 = new Uint8Array(await subtle().exportKey("pkcs8", pair.privateKey));
  const hash = await sha256Hex(spki);
  return {
    deviceId: `device-${hash.slice(0, 32)}`,
    keyId: `ed25519-${hash.slice(0, 32)}`,
    publicKeyDerBase64: bytesToBase64(spki),
    privateKeyDerBase64: bytesToBase64(pkcs8),
    createdAt: new Date().toISOString()
  };
}

const keyCache = new Map<string, Promise<unknown>>();

function signingKey(identity: Pick<HubDeviceIdentity, "privateKeyDerBase64">): Promise<unknown> {
  const cached = keyCache.get(identity.privateKeyDerBase64);
  if (cached) return cached;
  const key = subtle().importKey("pkcs8", base64ToBytes(identity.privateKeyDerBase64), { name: "Ed25519" }, false, ["sign"]);
  keyCache.set(identity.privateKeyDerBase64, key);
  if (keyCache.size > 4) keyCache.delete(keyCache.keys().next().value!);
  return key;
}

async function sign(identity: Pick<HubDeviceIdentity, "privateKeyDerBase64">, text: string): Promise<Uint8Array> {
  return new Uint8Array(await subtle().sign({ name: "Ed25519" }, await signingKey(identity), encoder.encode(text)));
}

/** The Authorization header of one request, as hubAuth.signHubRequest makes it. */
export async function signHubRequestWeb(identity: Pick<HubDeviceIdentity, "deviceId" | "privateKeyDerBase64">, request: {
  method: string;
  pathWithQuery: string;
  body?: Uint8Array | string;
  now?: number;
}): Promise<string> {
  const timestampMs = request.now ?? Date.now();
  const nonce = base64Url(webCrypto().getRandomValues(new Uint8Array(12)));
  const text = hubRequestSigningText({
    method: request.method,
    pathWithQuery: request.pathWithQuery,
    timestampMs,
    nonce,
    bodySha256Hex: await sha256Hex(request.body ?? "")
  });
  return `${HUB_AUTH_SCHEME} ${identity.deviceId}.${timestampMs}.${nonce}.${base64Url(await sign(identity, text))}`;
}

/** One signed event in the envelope every device verifies
 *  (chatEventLog.createSignedChatEvent, verifySignedChatEvent). */
export async function mintHubEvent<Payload>(identity: Pick<HubDeviceIdentity, "deviceId" | "keyId" | "privateKeyDerBase64">, request: {
  eventId: string;
  conversationId: string;
  logScopeId: string;
  kind: string;
  payload: Payload;
  originSeq: number;
  prevHash?: string;
  logicalTs: string;
  createdAt: string;
}): Promise<ChatEventEnvelope<Payload>> {
  const payloadHash = `sha256:${await sha256Hex(stableJson(request.payload))}`;
  const unsigned = {
    eventId: request.eventId,
    conversationId: request.conversationId,
    logScopeId: request.logScopeId,
    originId: identity.deviceId,
    originSeq: request.originSeq,
    logicalTs: request.logicalTs,
    kind: request.kind,
    payloadHash,
    prevHash: request.prevHash ?? null,
    keyId: identity.keyId,
    createdAt: request.createdAt
  };
  const eventHash = `sha256:${await sha256Hex(stableJson(unsigned))}`;
  const signature = bytesToBase64(await sign(identity, eventHash));
  return {
    ...unsigned,
    prevHash: request.prevHash,
    payload: request.payload,
    eventHash,
    signature
  } as ChatEventEnvelope<Payload>;
}

/** Pairs a phone with the server: shows the invite's token and signs the
 *  acceptance with the phone's own key. */
export async function enrollHubPhone(options: {
  hubUrl: string;
  hubId: string;
  token: string;
  identity: HubDeviceIdentity;
  name: string;
  fetchImpl?: typeof fetch;
}): Promise<HubPhoneEnrollResponse> {
  const enrollment: HubPhoneEnrollment = {
    version: 1,
    hubId: options.hubId,
    tokenHash: await sha256Hex(options.token),
    deviceId: options.identity.deviceId,
    publicKeyDerBase64: options.identity.publicKeyDerBase64,
    name: options.name,
    enrolledAt: new Date().toISOString()
  };
  const signature = bytesToBase64(await sign(options.identity, hubPhoneEnrollmentSigningText(enrollment)));
  const response = await reach(options.fetchImpl ?? fetch, `${trimmed(options.hubUrl)}/v1/phone/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: options.token, enrollment, signature }),
    signal: AbortSignal.timeout(20_000)
  });
  const text = await response.text();
  if (!response.ok) throw new HubAnswerError(response.status, text);
  return JSON.parse(text) as HubPhoneEnrollResponse;
}

function trimmed(url: string): string {
  return url.replace(/\/+$/, "");
}

async function reach(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch (error) {
    throw new HubUnreachableError(`The server could not be reached: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Signed requests of one device to the User's server. */
export function createHubDeviceClient(options: {
  hubUrl: string;
  identity: () => Promise<Pick<HubDeviceIdentity, "deviceId" | "privateKeyDerBase64">>;
  fetchImpl?: typeof fetch;
}) {
  const base = trimmed(options.hubUrl);
  const fetchImpl = (): typeof fetch => options.fetchImpl ?? fetch.bind(globalThis);

  async function request(method: string, pathWithQuery: string, body?: Uint8Array | string, init: { timeoutMs?: number; contentType?: string } = {}): Promise<Response> {
    const identity = await options.identity();
    const authorization = await signHubRequestWeb(identity, { method, pathWithQuery, body: body ?? "" });
    const response = await reach(fetchImpl(), `${base}${pathWithQuery}`, {
      method,
      headers: { authorization, ...(init.contentType ? { "content-type": init.contentType } : {}) },
      ...(body !== undefined ? { body: body as never } : {}),
      cache: "no-store",
      signal: AbortSignal.timeout(init.timeoutMs ?? 20_000)
    } as RequestInit);
    if (!response.ok) throw new HubAnswerError(response.status, await response.text().catch(() => ""));
    return response;
  }

  function query(path: string, params?: Record<string, string | number | undefined | null>): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
    }
    const text = search.toString();
    return text ? `${path}?${text}` : path;
  }

  return {
    hubUrl: base,
    async health(): Promise<HubHealth> {
      const response = await reach(fetchImpl(), `${base}/v1/health`, { cache: "no-store", signal: AbortSignal.timeout(15_000) } as RequestInit);
      if (!response.ok) throw new HubAnswerError(response.status, await response.text().catch(() => ""));
      return response.json() as Promise<HubHealth>;
    },
    async getJson<T = unknown>(path: string, params?: Record<string, string | number | undefined | null>, init?: { timeoutMs?: number }): Promise<T> {
      return (await request("GET", query(path, params), undefined, init)).json() as Promise<T>;
    },
    async postJson<T = unknown>(path: string, body: unknown, init?: { timeoutMs?: number }): Promise<T> {
      return (await request("POST", path, JSON.stringify(body), { ...init, contentType: "application/json" })).json() as Promise<T>;
    },
    async pushEvents(events: ChatEventEnvelope[]): Promise<HubEventPushResponse> {
      return (await request("POST", "/v1/events", JSON.stringify({ events }), { contentType: "application/json", timeoutMs: 60_000 })).json() as Promise<HubEventPushResponse>;
    },
    /** Puts bytes on the server as a body named by its hash. */
    async uploadBlob(bytes: Uint8Array): Promise<HubBlobReference> {
      const reference: HubBlobReference = {
        type: "device.event.blob",
        blobHash: `sha256:${await sha256Hex(bytes)}`,
        byteLength: bytes.length,
        fragments: Math.max(1, Math.ceil(bytes.length / HUB_CLIENT_BLOB_FRAGMENT_BYTES))
      };
      for (let index = 0; index < reference.fragments; index += 1) {
        const part = bytes.subarray(index * HUB_CLIENT_BLOB_FRAGMENT_BYTES, Math.min(bytes.length, (index + 1) * HUB_CLIENT_BLOB_FRAGMENT_BYTES));
        await request("PUT", hubBlobFragmentPath(reference, index), part, { contentType: "application/octet-stream", timeoutMs: 60_000 });
      }
      return reference;
    },
    async registerPushSubscription(subscription: unknown): Promise<void> {
      await request("POST", "/v1/push-subscription", JSON.stringify({ subscription }), { contentType: "application/json" });
    },
    async vapidKey(): Promise<string> {
      const response = await reach(fetchImpl(), `${base}/v1/push/vapid`, { cache: "no-store", signal: AbortSignal.timeout(15_000) } as RequestInit);
      if (!response.ok) throw new HubAnswerError(response.status, "");
      const body = await response.json() as { publicKey?: string };
      if (!body.publicKey) throw new Error("The server has no push key.");
      return body.publicKey;
    }
  };
}

export type HubDeviceClient = ReturnType<typeof createHubDeviceClient>;

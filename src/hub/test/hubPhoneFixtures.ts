// The User's server with its owner desktop and a phone that pairs the way
// the PWA does, for the server's phone tests.
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type test from "node:test";
import { createDeviceIdentity } from "../../main/services/deviceIdentity";
import { sha256Hex, signHubRequest, signHubText } from "../../main/services/hubAuth";
import { StorageService } from "../../main/services/storage";
import { createHubDeviceClient, enrollHubPhone, createHubDeviceIdentity } from "../../shared/hubDeviceClient";
import { hubPhoneInviteSigningText, type HubPhoneInvite } from "../../shared/hubProtocol";
import { composeHub } from "../main";

type Identity = ReturnType<typeof createDeviceIdentity>;

function vapid() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]);
  return { publicKey: point.toString("base64url"), privateJwk: privateKey.export({ format: "jwk" }) };
}

export async function hub(t: test.TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-hub-phone-"));
  const storage = new StorageService({ dbPath: path.join(dir, "hub.sqlite3"), sqliteExecutable: "sqlite3" });
  await storage.init();
  const owner = createDeviceIdentity(new Date().toISOString());
  await storage.hub().setOwner({ deviceId: owner.originId, publicKeyDerBase64: owner.publicKeyDerBase64, name: "Mac", addedAt: new Date().toISOString() });
  const rings: Array<{ url: string; at: number }> = [];
  const aws: Array<{ url: string; body: string }> = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const text = String(url);
    if (text.startsWith("https://fcm.googleapis.com/")) {
      rings.push({ url: text, at: Date.now() });
      return new Response("", { status: 201 });
    }
    aws.push({ url: text, body: String(init?.body ?? "") });
    return new Response("<StartInstancesResponse/>", { status: 200 });
  }) as typeof fetch;
  const composed = composeHub({ storage, hubId: "hub-phone-test", version: "test", keys: vapid(), log: () => undefined, fetchImpl, pushDebounceMs: 50 });
  const http = await composed.server.listenHttp(0, "127.0.0.1");
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  t.after(async () => {
    await composed.close();
    await rm(dir, { recursive: true, force: true });
  });
  const call = async (identity: Identity, method: string, pathWithQuery: string, body?: unknown) => {
    const text = body === undefined ? "" : JSON.stringify(body);
    const response = await fetch(`${base}${pathWithQuery}`, {
      method,
      headers: { authorization: signHubRequest(identity, { method, pathWithQuery, body: text }), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: text })
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  /** What the server does after an answer (rings, live progress) is done by then. */
  const settle = async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  };
  return { dir, storage, owner, base, call, settle, rings, aws, ...composed };
}

/** The desktop invites, the phone enrolls the way the PWA does: WebCrypto. */
export async function pairPhone(h: Awaited<ReturnType<typeof hub>>, scope: HubPhoneInvite["scope"] = { scope: "device" }) {
  const token = randomBytes(32).toString("base64url");
  const invite: HubPhoneInvite = {
    version: 1, inviteId: `invite-${randomBytes(8).toString("hex")}`, hubId: "hub-phone-test", issuerDeviceId: h.owner.originId,
    tokenHash: sha256Hex(token), scope, name: "Phone", issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString()
  };
  assert.equal((await h.call(h.owner, "PUT", "/v1/phone-invites", { invite, signature: signHubText(h.owner, hubPhoneInviteSigningText(invite)) })).status, 200);
  const identity = await createHubDeviceIdentity();
  const answer = await enrollHubPhone({ hubUrl: h.base, hubId: "hub-phone-test", token, identity, name: "iPhone" });
  const client = createHubDeviceClient({ hubUrl: h.base, identity: async () => identity });
  return { identity, client, answer, invite };
}

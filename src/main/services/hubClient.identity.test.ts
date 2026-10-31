import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { HubServer } from "../../hub/hubServer";
import { loadOrCreateHubKey } from "../../hub/hubKey";
import { ChatSearchService } from "./chatSearch";
import { createDeviceIdentity } from "./deviceIdentity";
import { HubClient, HubIdentityError, HubTransientError } from "./hubClient";
import { StorageService } from "./storage";

/** A server of the User's, with its own key, and one that answers at an
 *  address in its place: another program, the same id it publishes. */
async function servers(t: test.TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-hub-identity-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const owner = createDeviceIdentity(new Date().toISOString());
  const start = async (name: string) => {
    const data = path.join(dir, name);
    await import("node:fs/promises").then((fs) => fs.mkdir(data, { recursive: true }));
    const storage = new StorageService({ dbPath: path.join(data, "hub.sqlite3"), sqliteExecutable: "sqlite3" });
    await storage.init();
    await storage.hub().setOwner({ deviceId: owner.originId, publicKeyDerBase64: owner.publicKeyDerBase64, name: "Desktop", addedAt: new Date().toISOString() });
    const hubKey = loadOrCreateHubKey(data);
    const server = new HubServer({ hubId: "hub-users", version: "test", storage, search: new ChatSearchService(storage), vapidPublicKey: "BPUB", hubKey });
    const http = await server.listenHttp(0, "127.0.0.1");
    t.after(() => server.close());
    return { base: `http://127.0.0.1:${(http.address() as AddressInfo).port}`, hubKey };
  };
  return { owner, users: await start("users"), impostor: await start("impostor") };
}

/** Every request a client made, and whether it was signed. */
function recording() {
  const seen: Array<{ url: string; signed: boolean }> = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push({ url: String(input), signed: headers.has("authorization") });
    return fetch(input, init);
  }) as typeof fetch;
  return { seen, fetchImpl };
}

test("the computer sends nothing to a server that cannot prove it holds the key learned at setup", async (t) => {
  const { owner, users, impostor } = await servers(t);
  const expect = async () => ({ hubId: "hub-users", hubKey: users.hubKey.publicKeyDerBase64 });

  // The User's own server proves itself; requests go through.
  const own = recording();
  const client = new HubClient({ url: users.base, identity: async () => owner, expect, fetchImpl: own.fetchImpl });
  const me = await client.me();
  assert.equal(me.role, "owner");
  assert.ok(own.seen.some((request) => request.url.includes("/v1/health?proof=")), "it asked the server to prove itself");

  // Someone else at the address, answering with the same id: refused before
  // anything signed leaves this computer.
  const theirs = recording();
  const fooled = new HubClient({ url: impostor.base, identity: async () => owner, expect, fetchImpl: theirs.fetchImpl });
  await assert.rejects(() => fooled.writeOps([]), (error: unknown) => error instanceof HubIdentityError && /could not prove it is your server/.test((error as Error).message));
  await assert.rejects(() => fooled.health(), HubIdentityError);
  await assert.rejects(() => fooled.uploadBytes(Buffer.from("picture")), HubIdentityError);
  assert.deepEqual(theirs.seen.filter((request) => request.signed), [], "nothing signed was sent to it");
  // To the queues it is a failure to reach the server: what waits keeps waiting.
  assert.ok(new HubIdentityError("x") instanceof HubTransientError);

  // A server that answers as another one is not the User's either.
  const renamed = new HubClient({ url: users.base, identity: async () => owner, expect: async () => ({ hubId: "hub-other" }) });
  await assert.rejects(() => renamed.me(), (error: unknown) => error instanceof HubIdentityError && /answers as another one/.test((error as Error).message));

  // A link set up before servers had a key checks the id only.
  const older = new HubClient({ url: users.base, identity: async () => owner, expect: async () => ({ hubId: "hub-users" }) });
  assert.equal((await older.me()).role, "owner");
});

test("the server's key is made once and kept", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-hub-key-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = loadOrCreateHubKey(dir);
  assert.deepEqual(loadOrCreateHubKey(dir), first);
  const { statSync } = await import("node:fs");
  assert.equal(statSync(path.join(dir, "hub-key.json")).mode & 0o777, 0o600);
});

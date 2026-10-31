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
  const start = async (name: string, port = 0) => {
    const data = path.join(dir, name);
    await import("node:fs/promises").then((fs) => fs.mkdir(data, { recursive: true }));
    const storage = new StorageService({ dbPath: path.join(data, "hub.sqlite3"), sqliteExecutable: "sqlite3" });
    await storage.init();
    await storage.hub().setOwner({ deviceId: owner.originId, publicKeyDerBase64: owner.publicKeyDerBase64, name: "Desktop", addedAt: new Date().toISOString() });
    const hubKey = loadOrCreateHubKey(data);
    const server = new HubServer({ hubId: "hub-users", version: "test", storage, search: new ChatSearchService(storage), vapidPublicKey: "BPUB", hubKey });
    const http = await server.listenHttp(port, "127.0.0.1");
    t.after(() => server.close());
    return { base: `http://127.0.0.1:${(http.address() as AddressInfo).port}`, port: (http.address() as AddressInfo).port, hubKey, close: () => server.close() };
  };
  return { owner, start, users: await start("users"), impostor: await start("impostor") };
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

test("a server that went away proves itself again: whoever answers at its address next gets nothing", async (t) => {
  const { owner, start, users } = await servers(t);
  const seen = recording();
  const client = new HubClient({ url: users.base, identity: async () => owner, fetchImpl: seen.fetchImpl,
    expect: async () => ({ hubId: "hub-users", hubKey: users.hubKey.publicKeyDerBase64 }) });
  assert.equal((await client.me()).role, "owner", "proved and taken at its word");
  // The User's server goes away; a request gets no answer.
  await users.close();
  await assert.rejects(() => client.me(), HubTransientError);
  // Someone else answers at the same address, with the same id.
  await start("someone-else", users.port);
  const before = seen.seen.length;
  await assert.rejects(() => client.writeOps([]), HubIdentityError);
  assert.deepEqual(seen.seen.slice(before).filter((request) => request.signed), [], "nothing signed went to it");
});

test("a server proves itself only to a well-formed challenge, and only when it has a key", async (t) => {
  const { users } = await servers(t);
  const ask = async (query: string) => (await (await fetch(`${users.base}/v1/health${query}`)).json()) as { proof?: unknown };
  assert.ok((await ask("?proof=abcdefghijklmnopqrstuvwx")).proof);
  assert.equal((await ask("?proof=short")).proof, undefined);
  assert.equal((await ask("?proof=" + "a".repeat(200))).proof, undefined);
  assert.equal((await ask("?proof=has%20space%20in%20it%20yes")).proof, undefined);
  assert.equal((await ask("")).proof, undefined);
});

test("the server's key file that holds no key is not replaced", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-hub-key-bad-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { writeFileSync, readFileSync } = await import("node:fs");
  writeFileSync(path.join(dir, "hub-key.json"), JSON.stringify({ something: "else" }));
  assert.throws(() => loadOrCreateHubKey(dir), /does not hold the server's key/);
  assert.equal(readFileSync(path.join(dir, "hub-key.json"), "utf8"), JSON.stringify({ something: "else" }));
});

test("a write always waits for a fresh proof: a server swapped without a single failed request gets none", async (t) => {
  const { owner, users, impostor } = await servers(t);
  let answering = users.base;
  const seen: Array<{ to: string; method: string; signed: boolean }> = [];
  // One address; behind it, whichever server answers now.
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const to = answering;
    seen.push({ to, method: init?.method ?? "GET", signed: new Headers(init?.headers).has("authorization") });
    return fetch(`${to}${url.pathname}${url.search}`, init);
  }) as typeof fetch;
  const client = new HubClient({ url: "http://hub.invalid", identity: async () => owner, fetchImpl,
    expect: async () => ({ hubId: "hub-users", hubKey: users.hubKey.publicKeyDerBase64 }) });
  assert.equal((await client.me()).role, "owner");
  answering = impostor.base;
  await assert.rejects(() => client.writeOps([]), HubIdentityError);
  assert.deepEqual(seen.filter((request) => request.to === impostor.base && request.signed), [], "the write never left");
});

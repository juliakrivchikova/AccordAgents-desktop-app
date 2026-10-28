// The User's own server for machine tests, composed the way src/hub/main.ts
// composes it: a real HubServer with its rooms and the chats it owns
// (HubOps: operations, the feed, turns). Every device is a plain client of
// it: chats, members' turns, Stops and a machine's settings go through the
// server; a machine's room carries only live control (greeting, scripts,
// pictures, live progress), which nothing keeps.
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const { StorageService } = await import("../dist/main/main/services/storage.js");
const { DeviceIdentityService } = await import("../dist/main/main/services/deviceIdentity.js");
const { HubTunnelClient } = await import("../dist/main/main/services/hubTunnelClient.js");
const { ChatSearchService } = await import("../dist/main/main/services/chatSearch.js");
const { HubServer } = await import("../dist/main/hub/hubServer.js");
const { HubOps } = await import("../dist/main/hub/hubOps.js");

export async function waitFor(predicate, timeoutMs = 10_000, what = "the condition") {
  const started = Date.now();
  while (!await predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`waitFor timed out: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** One of the User's devices: its own database and its own signing identity. */
export async function hubDevice(directory, name) {
  const dbPath = path.join(directory, `${name}.sqlite3`);
  const eventStorage = new StorageService({ dbPath });
  await eventStorage.init();
  const deviceIdentity = new DeviceIdentityService(eventStorage);
  const identity = await deviceIdentity.getOrCreateDeviceIdentity();
  return {
    name, dbPath, eventStorage, deviceIdentity, identity,
    deviceId: identity.originId,
    publicKeyDerBase64: identity.publicKeyDerBase64,
    issuer: { originId: identity.originId, keyId: identity.keyId, publicKeyDerBase64: identity.publicKeyDerBase64 }
  };
}

/**
 * A temporary directory, a desktop that owns a server, and the server itself.
 * `setRoster` names the server's other devices (machines with their machine
 * id, phones), as the desktop publishes them.
 */
export async function startHubWorld({ prefix = "accord-machine-hub-", devices = ["desktop", "machine"], hubId = "machine-hub-test" } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  const named = {};
  for (const name of devices) named[name] = await hubDevice(directory, name);
  const hubStore = await hubDevice(directory, "hub");
  const owner = named[devices[0]];
  await hubStore.eventStorage.hub().setOwner({ deviceId: owner.deviceId, publicKeyDerBase64: owner.publicKeyDerBase64, name: "Desktop", addedAt: new Date().toISOString() });
  const ops = new HubOps(hubStore.eventStorage);
  const progress = [];
  const server = new HubServer({ hubId, version: "test", storage: hubStore.eventStorage, ops,
    search: new ChatSearchService(hubStore.eventStorage), vapidPublicKey: "B", onProgress: (frames) => progress.push(...frames) });
  const http = await server.listenHttp(0, "127.0.0.1");
  const hubUrl = `http://127.0.0.1:${http.address().port}`;
  const closers = [];
  let closed = false;
  const world = {
    directory, hubUrl, hubStore, server, ops, owner, progress, ...named,
    /** Closed in reverse order by `close`. */
    defer(close) { closers.push(close); return close; },
    /** The server's roster besides its owner: machines (`{ device, machineId, name }`)
     *  and other devices (`{ device, role }`). */
    async setRoster(entries, resolvedInviteIds = []) {
      await hubStore.eventStorage.hub().replaceRoster(entries.map((entry) => ({
        deviceId: entry.device.deviceId, publicKeyDerBase64: entry.device.publicKeyDerBase64,
        role: entry.role ?? "machine", name: entry.name ?? entry.device.name,
        ...(entry.machineId ? { machineId: entry.machineId } : {}),
        ...(entry.role === "phone" ? { scope: { scope: "device" } } : {}), addedAt: ""
      })), new Date().toISOString(), resolvedInviteIds);
      server.invalidateRoster();
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const close of closers.reverse()) await Promise.resolve().then(close).catch(() => undefined);
      await server.close();
      // A device's sqlite writes may still be settling as it closes.
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  };
  return world;
}

/** A machine's enrollment, as Settings → Machines writes it: it names the server. */
export function machinePairing(issuerDevice, hubUrl, { rendezvousId, fingerprint = "TEST-CAP" } = {}) {
  const now = Date.now();
  return {
    version: 1, purpose: "machine-host",
    issuer: issuerDevice.issuer ?? issuerDevice,
    rendezvousId: rendezvousId ?? `rv-machine-${randomBytes(6).toString("hex")}`,
    stableRoutingId: "route-machine-test",
    relaySealKeyBase64: Buffer.from(new Uint8Array(32).map((_, index) => index + 1)).toString("base64url"),
    hubUrl,
    capabilities: [{ scope: "device", canRead: true, canWrite: true, canRunCloudParticipants: true, canListConversations: true }],
    fingerprint,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 3_600_000).toISOString()
  };
}

/** The desktop's room client for a machine (src/main/main.ts `createClient`). */
export function desktopRoomClient(desktop, { reconnectDelayMs = 50 } = {}) {
  return (enrollment) => enrollment.hubUrl ? new HubTunnelClient({ hubUrl: enrollment.hubUrl, rendezvousId: enrollment.rendezvousId, role: "desktop",
    identity: () => desktop.deviceIdentity.getOrCreateDeviceIdentity(), reconnectDelayMs }) : undefined;
}

/** The machine's room client (src/machine/main.ts). */
export function machineRoomClient(machine, hubUrl, { reconnectDelayMs = 50 } = {}) {
  return (enrollment) => new HubTunnelClient({ hubUrl, rendezvousId: enrollment.rendezvousId, role: "machine",
    identity: () => machine.deviceIdentity.getOrCreateDeviceIdentity(), reconnectDelayMs });
}

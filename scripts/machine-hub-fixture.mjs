// The User's own server for machine tests, composed the way src/hub/main.ts,
// src/main/main.ts and src/machine/main.ts compose it: a real HubServer
// (its rooms, its one order, its fold) and, on each device, a HubSync that
// pushes the device's own events and hands everyone else's in. Durable
// events travel only through the server's order; the rooms carry the live
// messages (hello, progress, a picture's parts) that are never kept.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const { StorageService } = await import("../dist/main/main/services/storage.js");
const { ChatEventLogService } = await import("../dist/main/main/services/chatEventLog.js");
const { HubTunnelClient } = await import("../dist/main/main/services/hubTunnelClient.js");
const { HubClient } = await import("../dist/main/main/services/hubClient.js");
const { HubSync, HUB_SCOPE_PREFIXES, HUB_SHARED_SCOPE_PREFIXES } = await import("../dist/main/main/services/hubSync.js");
const { ChatSearchService } = await import("../dist/main/main/services/chatSearch.js");
const { machineSigningKey } = await import("../dist/main/shared/machineLink.js");
const { HubServer } = await import("../dist/main/hub/hubServer.js");
const { HubLog } = await import("../dist/main/hub/hubLog.js");
const { HubFolder } = await import("../dist/main/hub/hubFolder.js");
const { hubApplyPolicy } = await import("../dist/main/hub/hubPolicy.js");

export { HUB_SCOPE_PREFIXES, HUB_SHARED_SCOPE_PREFIXES };

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
  const eventLog = new ChatEventLogService(eventStorage);
  const identity = await eventLog.getOrCreateDeviceIdentity();
  return {
    name, dbPath, eventStorage, eventLog, identity,
    deviceId: identity.originId,
    publicKeyDerBase64: identity.publicKeyDerBase64,
    issuer: { originId: identity.originId, keyId: identity.keyId, publicKeyDerBase64: identity.publicKeyDerBase64 }
  };
}

/** Rows straight from a device's file, read-only and off the services' loop. */
export async function sqliteCount(dbPath, table, where = "1 = 1") {
  const { stdout } = await promisify(execFile)("sqlite3", ["-readonly", "-cmd", ".timeout 10000", dbPath,
    `select count(*) from ${table} where ${where};`], { encoding: "utf8" });
  return Number(stdout.trim()) || 0;
}

/**
 * A temporary directory, a desktop that owns a server, and the server itself.
 * `machines` are put on the server's roster as the desktop publishes them
 * once setup recorded their keys; `setRoster` replaces that list later.
 */
export async function startHubWorld({ prefix = "accord-machine-hub-", devices = ["desktop", "machine"], hubId = "machine-hub-test" } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  const named = {};
  for (const name of devices) named[name] = await hubDevice(directory, name);
  const hubStore = await hubDevice(directory, "hub");
  const owner = named[devices[0]];
  await hubStore.eventStorage.hub().setOwner({ deviceId: owner.deviceId, publicKeyDerBase64: owner.publicKeyDerBase64, name: "Desktop", addedAt: new Date().toISOString() });
  const log = new HubLog(hubStore.eventStorage);
  const folder = new HubFolder(hubStore.eventStorage, hubApplyPolicy(hubStore.eventStorage));
  log.onAppended(({ changedConversationIds }) => folder.enqueue(changedConversationIds));
  const server = new HubServer({ hubId, version: "test", storage: hubStore.eventStorage, log,
    search: new ChatSearchService(hubStore.eventStorage), vapidPublicKey: "B" });
  const http = await server.listenHttp(0, "127.0.0.1");
  const hubUrl = `http://127.0.0.1:${http.address().port}`;
  const closers = [];
  let closed = false;
  const world = {
    directory, hubUrl, hubStore, server, log, folder, owner, ...named,
    /** Closed in reverse order by `close`. */
    defer(close) { closers.push(close); return close; },
    /** The server's roster besides its owner: machines (`{ device, machineId, name }`)
     *  and other trusted devices (`{ device, role }`). */
    async setRoster(entries, resolvedInviteIds = []) {
      await hubStore.eventStorage.hub().replaceRoster(entries.map((entry) => ({
        deviceId: entry.device.deviceId, publicKeyDerBase64: entry.device.publicKeyDerBase64,
        role: entry.role ?? "machine", name: entry.name ?? entry.device.name,
        ...(entry.machineId ? { machineId: entry.machineId } : {}), addedAt: ""
      })), new Date().toISOString(), resolvedInviteIds);
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const close of closers.reverse()) await Promise.resolve().then(close).catch(() => undefined);
      folder.close();
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
    identity: () => desktop.eventLog.getOrCreateDeviceIdentity(), reconnectDelayMs }) : undefined;
}

/** The machine's room clients, its own and its peers' (src/machine/main.ts). */
export function machineRoomClients(machine, hubUrl, { reconnectDelayMs = 50 } = {}) {
  const room = (rendezvousId) => new HubTunnelClient({ hubUrl, rendezvousId, role: "machine",
    identity: () => machine.eventLog.getOrCreateDeviceIdentity(), reconnectDelayMs });
  return {
    createClient: (enrollment) => room(enrollment.rendezvousId),
    createPeerClient: (peerRoom) => room(peerRoom.rendezvousId)
  };
}

/**
 * The desktop's HubSync, as src/main/main.ts composes it: a machine's event
 * goes to that machine's channel in the link, the desktop sends its shared
 * scopes and its machines' channels, and the machines it knows are the keys
 * it trusts. `records` is read at each call (the desktop's settings). `link`
 * may be a function returning the current link. With `pushOnly` it only
 * sends until `sync.start()`: src/main/main.ts reads the server only once
 * the machine link has started, since an event for a machine the link does
 * not hold yet would be passed over as another pair's traffic.
 */
export function startDesktopSync(world, desktop, link, { records, pairings = [], trustedKeys = {}, applyChatChange, admit, pushOnly = false } = {}) {
  const currentLink = typeof link === "function" ? link : () => link;
  const machineScopes = async () => {
    const list = typeof pairings === "function" ? await pairings() : pairings;
    return list.map((pairing) => `device:${pairing.rendezvousId}:`);
  };
  const sync = new HubSync({
    client: new HubClient({ url: world.hubUrl, identity: () => desktop.eventLog.getOrCreateDeviceIdentity(), storage: desktop.eventStorage }),
    storage: desktop.eventStorage,
    localOriginId: async () => desktop.deviceId,
    trustedKey: async (originId) => {
      const list = typeof records === "function" ? await records() : records ?? [];
      const record = list.find((item) => item.deviceId === originId);
      return (record ? machineSigningKey(record) : undefined) ?? trustedKeys[originId];
    },
    ...(admit ? { admit } : {}),
    deliver: (event, fetchBody) => currentLink() ? currentLink().receiveFromHub(event, fetchBody) : Promise.resolve("not-ready"),
    applyChatChange: applyChatChange ?? (async () => "applied"),
    onPushed: (eventIds) => desktop.eventStorage.hub().acknowledgeOutbox(eventIds, new Date().toISOString(), currentLink()?.hubReaders() ?? []),
    ownScopes: machineScopes,
    scopePrefixes: async () => [...HUB_SHARED_SCOPE_PREFIXES, ...await machineScopes()]
  });
  const unsubscribe = desktop.eventLog.onLocalAppend(() => sync.nudgePush());
  if (pushOnly) sync.startPushing(); else sync.start();
  const stop = () => { unsubscribe(); sync.stop(); };
  world.defer(stop);
  return { sync, stop };
}

/** The machine's HubSync, as src/machine/main.ts composes it. */
export function startMachineSync(world, machine, host, { applyChatChange } = {}) {
  const sync = new HubSync({
    client: new HubClient({ url: world.hubUrl, identity: () => machine.eventLog.getOrCreateDeviceIdentity(), storage: machine.eventStorage }),
    storage: machine.eventStorage,
    localOriginId: async () => machine.deviceId,
    trustedKey: async (originId) => host.trustedKey(originId),
    admit: (event, fetchBody) => host.admitPhoneCertificate(event, fetchBody),
    deliver: (event, fetchBody) => host.receiveFromHub(event, fetchBody),
    applyChatChange: applyChatChange ?? (async () => "applied"),
    onPushed: (eventIds) => machine.eventStorage.hub().acknowledgeOutbox(eventIds, new Date().toISOString()),
    scopePrefixes: HUB_SCOPE_PREFIXES,
    ownScopes: async () => host.hubChannelScopes()
  });
  const unsubscribe = machine.eventLog.onLocalAppend(() => sync.nudgePush());
  sync.start();
  const stop = () => { unsubscribe(); sync.stop(); };
  world.defer(stop);
  return { sync, stop };
}

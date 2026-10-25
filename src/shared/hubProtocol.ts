/**
 * The User's own server ("hub"): one ordered log of every signed event from
 * the User's devices, the chats it folds into, and the search over them.
 *
 * Devices write their events to the hub and read everyone else's back from
 * it by position. There is no per-peer outbox for durable events and no
 * device that has to be awake for another one to see news: the hub is
 * always on and holds the one order everybody reads. Live traffic that is
 * not kept (progress, presence) passes through the hub's rooms.
 *
 * Every request is signed by the device's own Ed25519 key (the same identity
 * its chat events are signed with); the hub answers only devices on its
 * roster, which the desktop that set it up keeps.
 */

import type { ChatEventEnvelope } from "./chatEvents";

export const HUB_PROTOCOL_VERSION = 1;

/** What a device is to the hub. The owner is the desktop that set it up and
 *  the only device that may change the roster. */
export const HUB_DEVICE_ROLES = ["owner", "desktop", "machine", "phone"] as const;
export type HubDeviceRole = typeof HUB_DEVICE_ROLES[number];
/** The roles a roster entry may name (the owner is set once, at setup). */
export const HUB_ROSTER_ROLES = ["desktop", "machine", "phone"] as const;
/** The side a device takes in a room. */
export type HubRoomRole = "desktop" | "machine" | "phone";

export function hubRoomRole(role: HubDeviceRole): HubRoomRole {
  return role === "owner" ? "desktop" : role;
}

export interface HubDevice {
  deviceId: string;
  publicKeyDerBase64: string;
  role: HubDeviceRole;
  name: string;
  addedAt: string;
  /** For a cloud machine: the desktop's id for it, which its members carry
   *  as `homeMachineId`, so the hub knows whose replies are its own. */
  machineId?: string;
  /** A machine that reads the hub's order (not one still on a relay): the
   *  hub keeps what it has not read yet. */
  reader?: boolean;
  /** The channel this machine shares with the desktop (`device:<id>:`). */
  rendezvousId?: string;
}

/** Signed request header: `Authorization: Accord <deviceId>.<ms>.<nonce>.<signature>`. */
export const HUB_AUTH_SCHEME = "Accord";
/** How far a request's clock may be from the hub's. */
export const HUB_AUTH_MAX_SKEW_MS = 5 * 60_000;

/** The exact bytes a device signs for one request. */
export function hubRequestSigningText(request: {
  method: string;
  pathWithQuery: string;
  timestampMs: number;
  nonce: string;
  bodySha256Hex: string;
}): string {
  return [
    "accord-hub-request-v1",
    request.method.toUpperCase(),
    request.pathWithQuery,
    String(request.timestampMs),
    request.nonce,
    `sha256:${request.bodySha256Hex}`
  ].join("\n");
}

/** One event the hub accepted, with its place in the hub's order. */
export interface HubLoggedEvent {
  hubSeq: number;
  event: ChatEventEnvelope;
}

export type HubEventPushStatus =
  /** Stored; `hubSeq` is its place in the order. */
  | "accepted"
  /** The hub already holds this very event. */
  | "duplicate"
  /** An earlier event of the same chain is missing: send from `expectedSeq`. */
  | "gap"
  /** A different event already holds this place in the chain. */
  | "conflict"
  /** The payload is a blob whose fragments the hub does not hold yet: upload
   *  them (PUT /v1/blobs) and push again. */
  | "blob-missing"
  /** Invalid: bad signature, not this device's, malformed, or too large. */
  | "rejected";

export interface HubEventPushResult {
  eventId: string;
  status: HubEventPushStatus;
  hubSeq?: number;
  expectedSeq?: number;
  error?: string;
}

/** POST /v1/events. A payload over the inline limit travels as a blob
 *  reference; the hub answers "blob-missing" until its fragments are there,
 *  each uploaded as hubBlobFragmentPath() names. */
export interface HubEventPushRequest {
  events: ChatEventEnvelope[];
}

export interface HubEventPushResponse {
  results: HubEventPushResult[];
  head: number;
}

/** GET /v1/events?after=<hubSeq>&limit=<n>: the order without the asking
 *  device's own events. */
export interface HubEventPullResponse {
  events: HubLoggedEvent[];
  /** How far this page covers, past the asker's own events too: the next
   *  read starts here. */
  through: number;
  /** The hub's newest position; more to read while `through` is below it. */
  head: number;
  /** Which hub this is: positions mean nothing at another one. */
  hubId?: string;
}

/** The live socket says only where the log is; devices then read from there. */
export interface HubLiveHead {
  type: "head";
  head: number;
}

/** GET /v1/health, unauthenticated: enough to check a pasted setup result. */
export interface HubHealth {
  ok: true;
  protocol: number;
  hubId: string;
  version: string;
  head: number;
}

/** PUT /v1/roster (owner only): the whole roster, owner included. */
export interface HubRosterRequest {
  devices: Array<Omit<HubDevice, "addedAt">>;
}

/** Largest request body the hub reads: a push of events, or a fragment. */
export const HUB_MAX_BODY_BYTES = 16 * 1024 * 1024;
/** Largest body of any other request (roster, push subscription). */
export const HUB_MAX_SMALL_BODY_BYTES = 256 * 1024;
/** Largest message a room forwards (live, unstored traffic). */
export const HUB_ROOM_MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
/** The room closes a device's older connection with this code when a newer
 *  one takes its seat. */
export const HUB_ROOM_REPLACED_CLOSE_CODE = 4001;

/** A hub address a device may use: HTTPS, or plain HTTP only on this
 *  computer (a local test hub). Everything a device sends travels to it. */
export function isAcceptableHubUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

/** Where one fragment of a large event body is uploaded and read. */
export function hubBlobFragmentPath(reference: { blobHash: string; byteLength: number; fragments: number }, index: number): string {
  return `/v1/blobs/${reference.blobHash}?bytes=${reference.byteLength}&fragments=${reference.fragments}&index=${index}`;
}

/** The WebSocket address of a hub route. */
export function hubWebSocketUrl(hubUrl: string, pathWithQuery: string): string {
  return `${hubUrl.replace(/\/+$/, "").replace(/^http/, "ws")}${pathWithQuery}`;
}
/** Events one pull returns at most. */
export const HUB_PULL_MAX_EVENTS = 200;
/** Events one push may carry. */
export const HUB_PUSH_MAX_EVENTS = 200;

/**
 * What a device reports on each read so the hub knows what it still needs:
 * its lowest held position (an event it read but could not take yet) and
 * since when it holds it. The hub keeps everything a reader still needs:
 * the reader's floor is min(its cursor, its lowest held position - 1).
 * Sent as query parameters of GET /v1/events (`held`, `heldSince`,
 * `heldCount`); `peek=1` marks a read that is not the device's own place
 * (a held event read again), which moves no cursor.
 */
export interface HubReadReport {
  /** Lowest held position, 0 when none. */
  held: number;
  /** When the oldest held position was first held (ms), 0 when none. */
  heldSince: number;
  heldCount: number;
  /** Changes it gave up on after holding them two weeks (`gaveUp`,
   *  `gaveUpAt` ms): the desktop says so in Settings. */
  gaveUp?: number;
  gaveUpAt?: number;
}

/** GET /v1/events answers 410 with this when the hub no longer holds every
 *  event this device needs after `after` (it was away while they were
 *  forgotten, or it never read here): the device starts again from a copy. */
export interface HubResyncRequired {
  ok: false;
  error: string;
  resync: true;
  /** Events this device would need were forgotten up to here. */
  prunedThrough: number;
}

/** One chain's newest event a hub copy covers (as ChatCopyMark). */
export interface HubCopyMark {
  originId: string;
  logScopeId: string;
  originSeq: number;
  eventHash: string;
}

/** One chat of the hub's copy, or one part of a chat too large for a page:
 *  the parts of a chat come in order, the last one with `more` unset. */
export interface HubCopyPart {
  id: string;
  updatedAt: string;
  shared: unknown;
  messages: unknown[];
  removed: string[];
  authors?: Record<string, string>;
  /** More messages of this chat follow on the next page. */
  more?: boolean;
}

/**
 * GET /v1/snapshot: where a device starts reading the order again, and (with
 * `copy=1`) the hub's copy of every chat, paged. The first page (no `page`)
 * fixes `hubSeq` and keeps everything after it for this device; `marks` say
 * how far each chat change chain the copy covers. Later pages repeat
 * `hubSeq` and carry on from `page`. `scopes` names the device's own
 * channel scopes (prefixes): it starts before any of their events the hub
 * still holds. `atMost` caps where it starts (a copy the device already
 * has, made at that position).
 */
export interface HubSnapshotResponse {
  hubSeq: number;
  hubId?: string;
  marks?: HubCopyMark[];
  conversations: HubCopyPart[];
  /** The next page's token; absent on the last page. */
  next?: string;
}

/** GET /v1/chain?origin=&scope=&from=&to=: one chain's events in a range,
 *  for a reader that found a gap. `pruned` says how far the hub forgot this
 *  chain (events up to it are gone, by design). */
export interface HubChainResponse {
  events: HubLoggedEvent[];
  pruned?: { originSeq: number; eventHash: string };
}

/** GET /v1/devices/known?ids=: which of these devices are on the roster now
 *  (one that is not was removed: what was held for it is let go). */
export interface HubKnownDevicesResponse {
  known: string[];
}

/** GET /v1/readers (owner only): every device that reads the order, where it
 *  stands, and what the hub keeps for it. */
export interface HubReaderStatus {
  deviceId: string;
  name: string;
  role: HubDeviceRole;
  machineId?: string;
  /** Last time it read the order (or was set up, before its first read). */
  readAt?: string;
  /** Never read here yet. */
  neverRead?: boolean;
  floor: number;
  /** Its oldest held position's age, when it holds any. */
  heldSince?: string;
  heldCount?: number;
  /** Changes it gave up on after holding them two weeks, and when last. */
  givenUpCount?: number;
  givenUpAt?: string;
}

export interface HubReadersResponse {
  head: number;
  readers: HubReaderStatus[];
}


/**
 * The User's own server ("hub"): one ordered log of every signed event from
 * the User's devices, the chats it folds into, and the search over them.
 *
 * Devices write their events to the hub and read everyone else's back from
 * it by position. There is no per-peer outbox, no forwarding between
 * devices, and no device that has to be awake for another one to see news:
 * the hub is always on and holds the one order everybody reads.
 *
 * Every request is signed by the device's own Ed25519 key (the same identity
 * its chat events are signed with); the hub answers only devices on its
 * roster, which the desktop that set it up keeps.
 */

import type { ChatEventEnvelope } from "./chatEvents";

export const HUB_PROTOCOL_VERSION = 1;

/** What a device is to the hub. The owner is the desktop that set it up and
 *  the only device that may change the roster. */
export type HubDeviceRole = "owner" | "desktop" | "machine" | "phone";

export interface HubDevice {
  deviceId: string;
  publicKeyDerBase64: string;
  role: HubDeviceRole;
  name: string;
  addedAt: string;
  /** For a cloud machine: the desktop's id for it, which its members carry
   *  as `homeMachineId`, so the hub knows whose replies are its own. */
  machineId?: string;
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
 *  reference; its fragments go first, each as PUT /v1/blobs/<hash>/<index>. */
export interface HubEventPushRequest {
  events: ChatEventEnvelope[];
}

export interface HubEventPushResponse {
  results: HubEventPushResult[];
  head: number;
}

/** GET /v1/events?after=<hubSeq>&limit=<n> */
export interface HubEventPullResponse {
  events: HubLoggedEvent[];
  /** The hub's newest position; more to read while the last event is below it. */
  head: number;
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

/** Largest request body the hub reads. */
export const HUB_MAX_BODY_BYTES = 16 * 1024 * 1024;
/** Events one pull returns at most. */
export const HUB_PULL_MAX_EVENTS = 200;
/** Events one push may carry. */
export const HUB_PUSH_MAX_EVENTS = 200;

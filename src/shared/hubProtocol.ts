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
import type { ChatProviderKind, ChatSkillMention } from "./types";
import type { MachineProgressFrame } from "./machineProgress";
import { stableJson } from "./stableJson";

/** 2: phones pair with the hub itself (one-time invites), read and write
 *  only through it with their own signatures, and are rung by it. */
export const HUB_PROTOCOL_VERSION = 2;
/** The first protocol a phone can pair with and work through. */
export const HUB_PHONE_PROTOCOL_VERSION = 2;

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
  /** For a phone: what it may read. A phone without one reads nothing. */
  scope?: HubPhoneScope;
  /** For a phone: the owner's invite it enrolled with. */
  inviteId?: string;
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
  /** Phone invites the owner has settled: a phone enrolled with one of these
   *  stays only while the list names it. A phone enrolled with an invite the
   *  owner has not settled yet (it enrolled while the desktop was away) is
   *  kept as the invite admitted it. */
  resolvedInviteIds?: string[];
}

/** What a phone may read: every chat, or one. */
export type HubPhoneScope = { scope: "device" } | { scope: "conversation"; conversationId: string };

export function isHubPhoneScope(value: unknown): value is HubPhoneScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as { scope?: unknown; conversationId?: unknown };
  if (record.scope === "device") return true;
  return record.scope === "conversation" && typeof record.conversationId === "string" && record.conversationId.length > 0 &&
    record.conversationId.length <= 200 && !/[\u0000-\u001f\u007f]/.test(record.conversationId);
}

/**
 * A one-time invitation for one phone, signed by the desktop that owns the
 * hub. The token itself travels only in the QR code; the hub keeps its hash
 * and admits the first phone that shows it before it expires.
 */
export interface HubPhoneInvite {
  version: 1;
  inviteId: string;
  hubId: string;
  issuerDeviceId: string;
  /** sha256 hex of the token. */
  tokenHash: string;
  scope: HubPhoneScope;
  name: string;
  issuedAt: string;
  expiresAt: string;
}

/** A phone's acceptance of an invite, signed with the phone's own key. */
export interface HubPhoneEnrollment {
  version: 1;
  hubId: string;
  tokenHash: string;
  deviceId: string;
  publicKeyDerBase64: string;
  name: string;
  enrolledAt: string;
}

/** Proof that a phone was invited by the owner and accepted with its key:
 *  any of the User's devices can check it with the owner's key alone, so a
 *  machine can answer a phone paired while the desktop was away. */
export interface HubPhoneCertificate {
  invite: HubPhoneInvite;
  inviteSignature: string;
  enrollment: HubPhoneEnrollment;
  enrollmentSignature: string;
  /** The invite's token, spent: the hub admits an invite once. */
  token: string;
}

/** POST /v1/phone/enroll, unsigned: the body proves the phone's key. */
export interface HubPhoneEnrollRequest {
  token: string;
  enrollment: HubPhoneEnrollment;
  signature: string;
}

export interface HubPhoneEnrollResponse {
  ok: true;
  hubId: string;
  deviceId: string;
  scope: HubPhoneScope;
  certificate: HubPhoneCertificate;
  protocol: number;
}

/** The event a phone writes first: its certificate, in its own chain, so
 *  every device that reads the hub learns the phone from the order itself. */
export const HUB_PHONE_ENROLLED_EVENT_KIND = "device.enrolled";
export const HUB_PHONE_ENROLLMENT_SCOPE = "device-enrollment";
/** Desktops publish the approval cards of their own members here. */
export const HUB_APPROVAL_CARD_EVENT_KIND = "chat.approval";
export const HUB_APPROVAL_CARD_SCOPE = "chat-approvals";
/** A desktop's own members' live progress goes to the hub by this request,
 *  not into the order: it is shown while the member runs and is worth
 *  nothing afterwards, so nothing keeps it (machines publish theirs as
 *  machine.turn.progress.delta in their channels). */
export const HUB_PROGRESS_PATH = "/v1/progress";
export interface HubProgressPost {
  frames: MachineProgressFrame[];
}

export function hubPhoneInviteSigningText(invite: HubPhoneInvite): string {
  return `accord-hub-phone-invite-v1\n${stableJson(invite)}`;
}

export function hubPhoneEnrollmentSigningText(enrollment: HubPhoneEnrollment): string {
  return `accord-hub-phone-enroll-v1\n${stableJson(enrollment)}`;
}

/** The deterministic run id of a member's turn for a message a phone wrote:
 *  every device computes the same one, so a turn is claimed once wherever
 *  the message is applied, and a Stop can name it before it starts. */
/** How far back a member's home looks for phone messages it took in but
 *  never started (see ChatService.resumePhoneTurns), and how often. */
export const PHONE_TURN_RESUME_WINDOW_MS = 24 * 60 * 60_000;
export const PHONE_TURN_RESUME_EVERY_MS = 10 * 60_000;

/** An invite's id, as the desktop makes it (`invite-<uuid>`). */
export function isHubPhoneInviteId(value: unknown): value is string {
  return typeof value === "string" && /^invite-[A-Za-z0-9-]{8,80}$/.test(value);
}
/** The longest a phone invite may wait to be used (the desktop's last ten
 *  minutes); an unused one is forgotten this long after it lapsed. */
export const HUB_PHONE_INVITE_MAX_LIFETIME_MS = 24 * 60 * 60_000;

export function phoneTurnRunId(messageId: string, participantId: string): string {
  return `phone-${messageId}-${participantId}`;
}

/** The message and member a phone turn's run id names (the phone writes
 *  message ids as UUIDs), or undefined for any other run id. */
export function parsePhoneTurnRunId(runId: string): { messageId: string; participantId: string } | undefined {
  const match = /^phone-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-(.+)$/i.exec(runId);
  return match ? { messageId: match[1], participantId: match[2] } : undefined;
}

/** Checks a phone certificate with nothing but the owner's key, so it holds
 *  on any of the User's devices. Crypto is passed in: the desktop and the
 *  machines use node's, nothing else needs it. */
export function verifyHubPhoneCertificate(certificate: unknown, options: {
  issuerDeviceId: string;
  issuerPublicKeyDerBase64: string;
  verify: (publicKeyDerBase64: string, text: string, signatureBase64: string) => boolean;
  sha256Hex: (text: string) => string;
  deviceIdForPublicKey: (publicKeyDerBase64: string) => string;
}): certificate is HubPhoneCertificate {
  if (!certificate || typeof certificate !== "object") return false;
  const cert = certificate as Partial<HubPhoneCertificate>;
  const invite = cert.invite;
  const enrollment = cert.enrollment;
  if (!invite || !enrollment || typeof cert.token !== "string" || typeof cert.inviteSignature !== "string" || typeof cert.enrollmentSignature !== "string") return false;
  if (invite.version !== 1 || enrollment.version !== 1 || invite.issuerDeviceId !== options.issuerDeviceId) return false;
  if (!isHubPhoneInviteId(invite.inviteId) || !isHubPhoneScope(invite.scope)) return false;
  if (invite.hubId !== enrollment.hubId || invite.tokenHash !== enrollment.tokenHash || options.sha256Hex(cert.token) !== invite.tokenHash) return false;
  if (typeof enrollment.publicKeyDerBase64 !== "string" || options.deviceIdForPublicKey(enrollment.publicKeyDerBase64) !== enrollment.deviceId) return false;
  const enrolledAt = Date.parse(enrollment.enrolledAt);
  const expiresAt = Date.parse(invite.expiresAt);
  const issuedAt = Date.parse(invite.issuedAt);
  // Accepted inside its window (the hub's clock decides; a few minutes either
  // side are a phone's clock, not a late acceptance).
  if (!Number.isFinite(enrolledAt) || !Number.isFinite(expiresAt) || !Number.isFinite(issuedAt) ||
      enrolledAt > expiresAt + HUB_AUTH_MAX_SKEW_MS || enrolledAt < issuedAt - HUB_AUTH_MAX_SKEW_MS) return false;
  try {
    return options.verify(options.issuerPublicKeyDerBase64, hubPhoneInviteSigningText(invite), cert.inviteSignature) &&
      options.verify(enrollment.publicKeyDerBase64, hubPhoneEnrollmentSigningText(enrollment), cert.enrollmentSignature);
  } catch {
    return false;
  }
}

/** The composer's catalog, published by the owner desktop (PUT /v1/catalog):
 *  what the phone offers after `/`, and the names it shows. */
export interface HubComposerCatalog {
  version: 1;
  publishedAt: string;
  /** Role labels by role config id. */
  roles: Record<string, string>;
  prompts: Array<{ id: string; label: string; trigger: string; body: string }>;
  /** The User's own skills (not a project's), as a skill mention carries
   *  them, with the providers each runs on. */
  skills: Array<ChatSkillMention & { providerKinds: ChatProviderKind[] }>;
  /** Custom avatars by id, as blobs the hub holds. */
  avatars: Record<string, { mimeType: string; blob: { type: "device.event.blob"; blobHash: string; byteLength: number; fragments: number } }>;
}

/** PUT /v1/machine-wake (owner only): the key the hub may use to start a
 *  stopped machine, scoped in AWS to starting the User's tagged instances.
 *  The whole set: a machine left out loses its key. */
export interface HubMachineWakeRequest {
  machines: Array<{
    machineId: string;
    instanceId: string;
    region: string;
    credentials: { accessKeyId: string; secretAccessKey: string; region: string };
  }>;
}

/** What the phone shows about a machine: whether it reads the hub now, and
 *  whether the hub is waking it. */
export interface HubMachineStatus {
  machineId: string;
  name: string;
  /** When the machine last read the hub's order. */
  lastSeenAt?: string;
  /** True when the hub has work for it and has asked AWS to start it. */
  waking: boolean;
  wakeError?: string;
  /** Whether the hub holds a start key for it (the phone's Wake button). */
  canWake: boolean;
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

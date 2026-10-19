// The relay the phone and the machines already speak, served by the User's
// own hub instead of Cloudflare: sealed mailboxes (/v1/mailbox/*) and live
// rooms (/v1/relay). A port of cloudflare/relay/src/index.ts, path for path
// and answer for answer, so a pairing that names this hub works exactly like
// one that names the relay. The difference is where it runs: one process
// with SQLite instead of a Durable Object per mailbox and room, so each
// mailbox's requests are taken one at a time (what an object's input gate
// did there).
import { createHash, randomUUID, type JsonWebKey } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import {
  MAILBOX_DELETE_PATH,
  MAILBOX_ERROR_PUSH_ENDPOINT_REJECTED,
  MAILBOX_ERROR_REGISTRATION_REFUSED,
  MAILBOX_ERROR_REVOKED,
  MAILBOX_ERROR_UNAUTHORIZED,
  MAILBOX_ERROR_UNREGISTERED,
  MAILBOX_ERROR_UNSEALED_PAYLOAD,
  MAILBOX_EVENT_TTL_MS_DEFAULT,
  MAILBOX_PUSH_MIN_INTERVAL_MS,
  MAILBOX_PUSH_SUBSCRIPTION_PATH,
  MAILBOX_REGISTER_PATH,
  MAILBOX_REVOKE_PATH,
  isAllowedPushEndpointHost,
  isSealedMailboxPayload
} from "../shared/mailboxSealedPayload";
import { HUB_RELAY_MANIFEST } from "../shared/relayProtocol";
import type { HubRelayEventMeta, HubRelayStorage } from "../main/services/hubRelayStorage";
import { vapidJwt } from "./hubPush";

export const RELAY_ROOM_PATH = "/v1/relay";
export const RELAY_MANIFEST_PATH = "/v1/relay/manifest";
export const RELAY_HEALTH_PATH = "/healthz";
const MAILBOX_EVENTS_PATH = "/v1/mailbox/events";
const MAILBOX_CLAIMS_PATH = "/v1/mailbox/claims";
export const RELAY_MAILBOX_PATHS: ReadonlySet<string> = new Set([
  MAILBOX_EVENTS_PATH, MAILBOX_CLAIMS_PATH, MAILBOX_REGISTER_PATH, MAILBOX_REVOKE_PATH, MAILBOX_DELETE_PATH, MAILBOX_PUSH_SUBSCRIPTION_PATH
]);
/** An append carries sealed timeline envelopes; the rest are small. */
export const RELAY_MAILBOX_APPEND_MAX_BYTES = 32 * 1024 * 1024;
export const RELAY_MAILBOX_SMALL_MAX_BYTES = 1024 * 1024;
export const RELAY_MAILBOX_TINY_MAX_BYTES = 4 * 1024;
/** Request bodies being read at once, all mailboxes together: the small
 *  server's memory is not left to how many arrive in parallel. */
export const RELAY_BODY_BYTES_IN_FLIGHT_MAX = 64 * 1024 * 1024;
const MAX_FRAME_BYTES = HUB_RELAY_MANIFEST.maxFrameBytes;
/** A read never answers with more envelope than this (the relay's limit). */
const SELECTION_MAX_BYTES = 6 * 1024 * 1024;
const DEFAULT_CLAIM_TTL_MS = 45_000;
const MIN_CLAIM_TTL_MS = 5_000;
const MAX_CLAIM_TTL_MS = 10 * 60_000;
const SWEEP_INTERVAL_MS = 60 * 60_000;
/** Sockets that stop answering pings are let go: their peers are told. */
const HEARTBEAT_MS = 30_000;
/** A peer that cannot keep up is let go rather than buffered for: more
 *  than a picture's frames (the relay buffered as much). */
const ROOM_MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
/** One stored envelope, as large as the relay could store one. */
const RELAY_EVENT_MAX_BYTES = 2 * 1024 * 1024;
/** One User's devices, with room to spare, and no one address taking them
 *  all (a desktop, a phone or a machine holds a few at most). */
const ROOM_MAX_SOCKETS = 2048;
const ROOM_MAX_SOCKETS_PER_ADDRESS = 128;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

type RelayRole = "desktop" | "phone" | "machine";

interface MailboxEvent {
  eventId: string;
  conversationId: string;
  logScopeId: string;
  originId: string;
  originSeq: number;
  logicalTs: string;
  kind: string;
  payload: unknown;
  payloadHash: string;
  eventHash: string;
  createdAt: string;
}

interface StoredPushSubscription {
  endpoint: string;
  suppressOriginId?: string;
  savedAt: string;
}

interface MailboxExecutionClaim {
  conversationId: string;
  eventId: string;
  ownerId: string;
  ownerRole: string;
  runId: string;
  claimedAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface RelayAnswer {
  status: number;
  body: unknown;
}

export interface HubRelayOptions {
  storage: HubRelayStorage;
  vapid?: { publicKey: string; privateJwk: JsonWebKey; subject: string };
  eventTtlMs?: number;
  pushMinIntervalMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (event: string, payload: Record<string, unknown>) => void;
  /** Takes a new mailbox from anyone, as the shared relay does (tests and
   *  the contract suite). On the User's server only her desktop may. */
  openRegistration?: boolean;
}

/** A refusal the caller is told about in these words; anything else is
 *  answered without the detail (it stays in the hub's log). */
class RelayRequestError extends Error {}

/** What the rooms use of a `ws` socket. */
interface WebSocket {
  readonly OPEN: number;
  readyState: number;
  bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  ping(): void;
  on(event: "pong", listener: () => void): this;
  on(event: "message", listener: (data: unknown, isBinary: boolean) => void): this;
  on(event: "close" | "error", listener: () => void): this;
}
interface WebSocketServerLike {
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, done: (socket: WebSocket) => void): void;
  close(): void;
}
const { WebSocketServer } = require("ws") as { WebSocketServer: new (options: { noServer: true; maxPayload: number }) => WebSocketServerLike };

/**
 * The sealed mailboxes. Every mailbox is locked at registration with the
 * hash of a bearer token the desktop derives from the pairing seal key;
 * reads, writes and claims require that token, and payloads must arrive
 * sealed, so the hub stores only ciphertext here.
 */
export class HubRelayMailboxes {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly rings = new Map<string, ReturnType<typeof setTimeout>>();
  private sweeper?: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(private readonly options: HubRelayOptions) {}

  /** Rings left waiting by the previous run, and the periodic sweep. */
  async start(): Promise<void> {
    for (const pending of await this.options.storage.pendingRings()) this.scheduleRing(pending.mailboxId, pending.pushAt);
    // In the background: a large backlog does not keep the hub offline after
    // a restart (what expired is never listed meanwhile).
    void this.sweepAll().catch((error) => this.log("relay.sweep.error", { message: errorMessage(error) }));
    this.sweeper = setInterval(() => void this.sweepAll().catch((error) => this.log("relay.sweep.error", { message: errorMessage(error) })), SWEEP_INTERVAL_MS);
    this.sweeper.unref?.();
  }

  close(): void {
    this.closed = true;
    if (this.sweeper) clearInterval(this.sweeper);
    for (const timer of this.rings.values()) clearTimeout(timer);
    this.rings.clear();
  }

  /** Before a body is read: a request that is not the mailbox owner's is
   *  answered from its headers alone, so nobody else makes the hub read one.
   *  Registration and revocation carry small bodies and decide for
   *  themselves. */
  async preauthorize(pathname: string, mailboxIdParam: string | null, authorization: string | undefined): Promise<RelayAnswer | undefined> {
    const mailboxId = normalizedMailboxId(mailboxIdParam);
    if (!mailboxId) return { status: 400, body: { ok: false, error: "mailboxId required" } };
    if (pathname === MAILBOX_REGISTER_PATH || pathname === MAILBOX_REVOKE_PATH) return undefined;
    const row = await this.options.storage.mailbox(mailboxId);
    if (row?.revokedAt) return { status: 401, body: { ok: false, error: MAILBOX_ERROR_REVOKED, revokedAt: row.revokedAt } };
    if (!row?.tokenHash) return { status: 401, body: { ok: false, error: MAILBOX_ERROR_UNREGISTERED } };
    const token = bearerToken(authorization);
    if (!token || !constantTimeEquals(row.tokenHash, sha256Base64Url(token))) return { status: 401, body: { ok: false, error: MAILBOX_ERROR_UNAUTHORIZED } };
    return undefined;
  }

  /** One mailbox request: `pathname` is one of RELAY_MAILBOX_PATHS.
   *  `ownerSigned` says whether the request also carries a valid signature
   *  of the server's owner (asked only when a new mailbox is registered). */
  async handle(method: string, pathname: string, mailboxIdParam: string | null, authorization: string | undefined, body: Buffer, query: URLSearchParams, ownerSigned: () => Promise<boolean> = async () => false): Promise<RelayAnswer> {
    // No default mailbox: a caller that does not name its own has nothing to talk to.
    const mailboxId = normalizedMailboxId(mailboxIdParam);
    if (!mailboxId) return { status: 400, body: { ok: false, error: "mailboxId required" } };
    return this.serialized(mailboxId, async () => {
      try {
        return await this.route(method, pathname, mailboxId, bearerToken(authorization), body, query, ownerSigned);
      } catch (error) {
        if (error instanceof RelayRequestError) return { status: 400, body: { ok: false, error: error.message } };
        this.log("relay.mailbox.error", { path: pathname, message: errorMessage(error) });
        return { status: 500, body: { ok: false, error: "The relay could not answer." } };
      }
    });
  }

  private async route(method: string, pathname: string, mailboxId: string, token: string, body: Buffer, query: URLSearchParams, ownerSigned: () => Promise<boolean>): Promise<RelayAnswer> {
    const storage = this.options.storage;
    const row = await storage.mailbox(mailboxId);
    // Terminal by design: a revoked mailbox answers everything, register
    // included, with its own code.
    if (row?.revokedAt) return { status: 401, body: { ok: false, error: MAILBOX_ERROR_REVOKED, revokedAt: row.revokedAt } };
    if (pathname === MAILBOX_REGISTER_PATH) return method === "POST" ? this.register(mailboxId, token, body, ownerSigned) : notAllowed();
    if (pathname === MAILBOX_REVOKE_PATH) return method === "POST" ? this.revoke(mailboxId, token) : notAllowed();
    if (!row?.tokenHash) return { status: 401, body: { ok: false, error: MAILBOX_ERROR_UNREGISTERED } };
    if (!token || !constantTimeEquals(row.tokenHash, sha256Base64Url(token))) return { status: 401, body: { ok: false, error: MAILBOX_ERROR_UNAUTHORIZED } };
    if (pathname === MAILBOX_CLAIMS_PATH) return method === "POST" ? this.claim(mailboxId, body) : notAllowed();
    if (pathname === MAILBOX_DELETE_PATH) return method === "POST" ? this.deleteEvents(mailboxId, body) : notAllowed();
    if (pathname === MAILBOX_PUSH_SUBSCRIPTION_PATH) return method === "POST" ? this.savePushSubscription(mailboxId, body) : notAllowed();
    if (pathname === MAILBOX_EVENTS_PATH) {
      if (method === "POST") return this.append(mailboxId, body);
      if (method === "GET") return this.list(mailboxId, query);
      return notAllowed();
    }
    return { status: 404, body: { ok: false, error: "not found" } };
  }

  // Trust-on-first-use, and only ever once: the desktop registers the lock
  // before the pairing link leaves it, so the scope id is unknowable to anyone
  // else at registration time.
  private async register(mailboxId: string, token: string, body: Buffer, ownerSigned: () => Promise<boolean>): Promise<RelayAnswer> {
    if (!token) return { status: 401, body: { ok: false, error: MAILBOX_ERROR_UNAUTHORIZED } };
    const parsed = parseJsonObject(body) as { tokenHashBase64Url?: unknown };
    const claimedHash = typeof parsed.tokenHashBase64Url === "string" ? parsed.tokenHashBase64Url.trim() : "";
    const computedHash = sha256Base64Url(token);
    if (!claimedHash || !constantTimeEquals(claimedHash, computedHash)) return { status: 400, body: { ok: false, error: "token hash mismatch" } };
    const row = await this.options.storage.mailbox(mailboxId);
    if (!row?.tokenHash) {
      // The User's server is hers alone: a new mailbox comes from her
      // desktop (the pairings it makes), never from whoever asks.
      if (!this.options.openRegistration && !await ownerSigned()) {
        return { status: 403, body: { ok: false, error: MAILBOX_ERROR_REGISTRATION_REFUSED } };
      }
      const epoch = randomUUID();
      await this.options.storage.updateMailbox(mailboxId, { tokenHash: computedHash, registeredAt: this.nowIso(), epoch });
      return { status: 200, body: { ok: true, registered: true, epoch } };
    }
    if (constantTimeEquals(row.tokenHash, computedHash)) {
      let epoch = row.epoch;
      if (!epoch) {
        epoch = randomUUID();
        await this.options.storage.updateMailbox(mailboxId, { epoch });
      }
      return { status: 200, body: { ok: true, registered: true, epoch } };
    }
    return { status: 401, body: { ok: false, error: MAILBOX_ERROR_UNAUTHORIZED } };
  }

  private async revoke(mailboxId: string, token: string): Promise<RelayAnswer> {
    const row = await this.options.storage.mailbox(mailboxId);
    // Nothing registered means nothing readable; success lets revoke retries settle.
    if (!row?.tokenHash) return { status: 200, body: { ok: true, revoked: false } };
    if (!token || !constantTimeEquals(row.tokenHash, sha256Base64Url(token))) return { status: 401, body: { ok: false, error: MAILBOX_ERROR_UNAUTHORIZED } };
    const timer = this.rings.get(mailboxId);
    if (timer) clearTimeout(timer);
    this.rings.delete(mailboxId);
    await this.options.storage.revoke(mailboxId, this.nowIso());
    return { status: 200, body: { ok: true, revoked: true } };
  }

  private async append(mailboxId: string, body: Buffer): Promise<RelayAnswer> {
    const parsed = parseJsonObject(body) as { events?: unknown; runFinished?: unknown };
    const incoming = Array.isArray(parsed.events) ? parsed.events.map(assertMailboxEvent) : [];
    const runFinished = parsed.runFinished === true;
    for (const event of incoming) {
      if (!isSealedMailboxPayload(event.payload)) return { status: 400, body: { ok: false, error: MAILBOX_ERROR_UNSEALED_PAYLOAD } };
    }
    const storage = this.options.storage;
    // An expired envelope is gone for every purpose, a repeat of its id too.
    const incomingIds = incoming.map((event) => event.eventId);
    await storage.sweepExpiredIds(mailboxId, incomingIds, new Date(this.now() - this.eventTtlMs()).toISOString());
    const existing = await storage.existingEventIds(mailboxId, incomingIds);
    const row = await storage.mailbox(mailboxId);
    let arrivalSeq = row?.arrivalSeq ?? 0;
    const arrivedAt = this.nowIso();
    const appendedEventIds: string[] = [];
    const duplicateEventIds: string[] = [];
    const stored = [];
    for (const event of incoming) {
      if (existing.has(event.eventId)) {
        duplicateEventIds.push(event.eventId);
        continue;
      }
      existing.add(event.eventId);
      arrivalSeq += 1;
      const ct = (event.payload as { ct?: unknown }).ct;
      const eventJson = JSON.stringify({ ...event, arrivalSeq, arrivedAt });
      // The relay kept an envelope as one stored value, at most this large.
      if (eventJson.length > RELAY_EVENT_MAX_BYTES) throw new RelayRequestError("Mailbox event is too large.");
      stored.push({
        eventId: event.eventId, arrivalSeq, arrivedAt, conversationId: event.conversationId, logScopeId: event.logScopeId,
        originId: event.originId, originSeq: event.originSeq, ctLength: typeof ct === "string" ? ct.length : 0,
        eventJson
      });
      appendedEventIds.push(event.eventId);
    }
    if (stored.length > 0) {
      await storage.appendEvents(mailboxId, stored, arrivalSeq);
      // The doorbell rings when a run finishes, not on every append. The
      // publisher marks the append whose batch carries a terminal snapshot.
      if (runFinished) {
        await storage.updateMailbox(mailboxId, { pushFinishSeq: arrivalSeq });
        const appendedIds = new Set(appendedEventIds);
        await this.maybeRing(mailboxId, incoming.filter((event) => appendedIds.has(event.eventId))).catch((error) => {
          this.log("relay.ring.not-scheduled", { message: errorMessage(error) });
        });
      }
    }
    return { status: 200, body: { ackRole: "mailbox", eventIds: incoming.map((event) => event.eventId), appendedEventIds, duplicateEventIds } };
  }

  private async list(mailboxId: string, query: URLSearchParams): Promise<RelayAnswer> {
    const conversationId = query.get("conversationId") ?? "";
    const logScopeId = query.get("logScopeId") ?? "";
    const originId = query.get("originId") ?? "";
    // Positions are whole numbers within what the store can compare; a
    // larger one stands for "after everything" as the relay's did.
    const afterSeq = boundedPosition(query.get("afterSeq"));
    const afterArrivalRaw = query.get("afterArrival");
    const afterArrival = afterArrivalRaw === null ? undefined : boundedPosition(afterArrivalRaw);
    const limit = Math.max(1, Math.min(1000, Number(query.get("limit") ?? "500") || 500));
    const tail = query.get("tail") === "true";
    // Cursor mode supersedes tail: ascending arrival order, strictly after the cursor.
    const cursorMode = afterArrival !== undefined;
    const storage = this.options.storage;
    // Expired envelopes are passed over here and deleted by the hourly
    // sweep: a read is not also a write over the whole box.
    const keptSince = new Date(this.now() - this.eventTtlMs()).toISOString();
    const candidates = await storage.candidates(mailboxId, keptSince, {
      ...(conversationId ? { conversationId } : {}),
      ...(logScopeId ? { logScopeId } : {}),
      ...(originId ? { originId } : {}),
      ...(originId ? { afterOriginSeq: afterSeq } : {}),
      ...(cursorMode ? { afterArrival } : {})
    });
    candidates.sort(cursorMode ? (left, right) => left.arrivalSeq - right.arrivalSeq : compareMailboxEvents);
    const chosen = chooseWithinBudget(candidates, limit, tail && !cursorMode);
    const json = await storage.eventJson(mailboxId, chosen.map((event) => event.eventId));
    const events = chosen.flatMap((event) => {
      const text = json.get(event.eventId);
      return text ? [JSON.parse(text) as unknown] : [];
    });
    const row = await storage.mailbox(mailboxId);
    const maxArrivalSeq = row?.arrivalSeq ?? 0;
    // With an empty box the oldest retained sequence is one past the
    // counter, so a reader's staleness test still sees that everything
    // expired underneath it.
    const oldestArrivalSeq = await storage.oldestArrivalSeq(mailboxId, keptSince) ?? maxArrivalSeq + 1;
    // What the phone says it already holds: its own cursor, from an
    // unfiltered read over the whole box only, clamped to what the box holds.
    const phoneRead = query.get("reader") === "phone" && cursorMode && !tail && !conversationId && !logScopeId && !originId;
    if (phoneRead) {
      const acknowledged = Math.min(Math.max(0, afterArrival as number), maxArrivalSeq);
      if (acknowledged > (row?.pushReadCursor ?? 0)) await storage.updateMailbox(mailboxId, { pushReadCursor: acknowledged });
    }
    return { status: 200, body: { events, maxArrivalSeq, oldestArrivalSeq, epoch: row?.epoch ?? "" } };
  }

  // Owner-driven deletion: the desktop names its own superseded envelopes.
  private async deleteEvents(mailboxId: string, body: Buffer): Promise<RelayAnswer> {
    const parsed = parseJsonObject(body) as { eventIds?: unknown };
    const eventIds = Array.isArray(parsed.eventIds)
      ? parsed.eventIds.filter((id): id is string => typeof id === "string" && Boolean(id.trim()) && !CONTROL_CHARACTER.test(id)).slice(0, 1000)
      : [];
    const deletedEventIds = await this.options.storage.deleteEvents(mailboxId, eventIds);
    return { status: 200, body: { ok: true, deletedEventIds } };
  }

  private async savePushSubscription(mailboxId: string, body: Buffer): Promise<RelayAnswer> {
    const parsed = parseJsonObject(body) as { subscription?: { endpoint?: unknown }; suppressOriginId?: unknown };
    const endpoint = typeof parsed.subscription?.endpoint === "string" ? parsed.subscription.endpoint.trim() : "";
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      return { status: 400, body: { ok: false, error: "push subscription endpoint must be a URL" } };
    }
    if (url.protocol !== "https:") return { status: 400, body: { ok: false, error: MAILBOX_ERROR_PUSH_ENDPOINT_REJECTED, reason: "https required" } };
    // Only real Web Push origins: anything else would make the hub an
    // egress hop for whoever owns the mailbox.
    if (!isAllowedPushEndpointHost(url.hostname)) return { status: 400, body: { ok: false, error: MAILBOX_ERROR_PUSH_ENDPOINT_REJECTED, reason: "unsupported push service" } };
    const suppress = typeof parsed.suppressOriginId === "string" && parsed.suppressOriginId.trim() ? parsed.suppressOriginId.trim() : undefined;
    const record: StoredPushSubscription = { endpoint: url.toString(), ...(suppress ? { suppressOriginId: suppress } : {}), savedAt: this.nowIso() };
    await this.options.storage.updateMailbox(mailboxId, { pushSubscription: JSON.stringify(record) });
    return { status: 200, body: { ok: true, saved: true } };
  }

  private async claim(mailboxId: string, body: Buffer): Promise<RelayAnswer> {
    const parsed = parseJsonObject(body) as Partial<Record<"conversationId" | "eventId" | "ownerId" | "ownerRole" | "runId" | "ttlMs", unknown>>;
    const conversationId = requiredTrimmedString(parsed.conversationId, "conversationId");
    const eventId = requiredTrimmedString(parsed.eventId, "eventId");
    const ownerId = requiredTrimmedString(parsed.ownerId, "ownerId");
    const ownerRole = requiredTrimmedString(parsed.ownerRole, "ownerRole");
    const runId = requiredTrimmedString(parsed.runId, "runId");
    const ttlMs = boundedClaimTtlMs(parsed.ttlMs);
    const now = this.now();
    const key = `${conversationId}:${eventId}`;
    const existingJson = await this.options.storage.claim(mailboxId, key);
    const existing = existingJson ? JSON.parse(existingJson) as MailboxExecutionClaim : undefined;
    if (existing && existing.ownerId !== ownerId && !claimExpired(existing, now)) {
      return { status: 200, body: { ok: true, acquired: false, claim: existing } };
    }
    const timestamp = new Date(now).toISOString();
    const claim: MailboxExecutionClaim = {
      conversationId, eventId, ownerId, ownerRole, runId,
      claimedAt: existing?.ownerId === ownerId ? existing.claimedAt : timestamp,
      updatedAt: timestamp,
      expiresAt: new Date(now + ttlMs).toISOString()
    };
    await this.options.storage.saveClaim(mailboxId, key, JSON.stringify(claim), claim.expiresAt);
    return { status: 200, body: { ok: true, acquired: true, claim } };
  }

  /** A finished run rings now, or once the debounce since the last ring has
   *  passed: deferred, never dropped, since it is the last thing that happens
   *  in that run. */
  private async maybeRing(mailboxId: string, appended: MailboxEvent[]): Promise<void> {
    const row = await this.options.storage.mailbox(mailboxId);
    const record = parseSubscription(row?.pushSubscription);
    if (!record) return;
    if (record.suppressOriginId && appended.every((event) => event.originId === record.suppressOriginId)) return;
    const at = Math.max(this.now(), (row?.pushLastSent ?? 0) + this.pushMinIntervalMs());
    // Never later than a ring already waiting.
    if (row?.pushAt !== null && row?.pushAt !== undefined && row.pushAt <= at) return;
    await this.options.storage.updateMailbox(mailboxId, { pushAt: at });
    this.scheduleRing(mailboxId, at);
  }

  private scheduleRing(mailboxId: string, at: number): void {
    if (this.closed) return;
    const previous = this.rings.get(mailboxId);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.rings.delete(mailboxId);
      // A failed ring is logged, not retried.
      void this.ring(mailboxId).catch((error) => this.log("relay.ring.failed", { message: errorMessage(error) }));
    }, Math.max(0, at - this.now()));
    timer.unref?.();
    this.rings.set(mailboxId, timer);
  }

  /** The empty VAPID-authenticated wake push. The subscription is read when
   *  it fires; the push service is asked outside the mailbox's queue, so an
   *  append never waits for it. A 404/410 means the subscription lapsed: it
   *  is dropped, and the phone registers again on its next open. */
  private async ring(mailboxId: string): Promise<void> {
    const storage = this.options.storage;
    const vapid = this.options.vapid;
    const due = await this.serialized(mailboxId, async () => {
      const row = await storage.mailbox(mailboxId);
      if (!row || row.revokedAt || row.pushAt === null) return undefined;
      await storage.updateMailbox(mailboxId, { pushAt: null });
      const record = parseSubscription(row.pushSubscription);
      // Nothing here the phone has not already read: no ring for an empty box.
      if (!record || row.pushReadCursor >= (row.pushFinishSeq ?? row.arrivalSeq) || !vapid) return undefined;
      const sentAt = this.now();
      await storage.updateMailbox(mailboxId, { pushLastSent: sentAt });
      return { record, sentAt };
    });
    if (!due || !vapid) return;
    const { record, sentAt } = due;
    const jwt = vapidJwt(new URL(record.endpoint).origin, vapid.subject, vapid.privateJwk, sentAt);
    let response: Response;
    try {
      response = await (this.options.fetchImpl ?? fetch)(record.endpoint, {
        method: "POST",
        // A bodyless POST says its length out loud: a push service may wait
        // for a body that never comes.
        headers: { TTL: "300", Urgency: "normal", "content-length": "0", Authorization: `vapid t=${jwt}, k=${vapid.publicKey}` },
        body: new Uint8Array(0),
        signal: AbortSignal.timeout(5_000)
      });
    } catch (error) {
      await this.serialized(mailboxId, () => storage.updateMailbox(mailboxId, { pushLastResult: JSON.stringify({ at: new Date(sentAt).toISOString(), failed: errorMessage(error) }) }));
      throw error;
    }
    this.log("relay.ring", { host: new URL(record.endpoint).host, status: response.status });
    await this.serialized(mailboxId, async () => {
      await storage.updateMailbox(mailboxId, { pushLastResult: JSON.stringify({ at: new Date(sentAt).toISOString(), status: response.status }) });
      if (response.status === 404 || response.status === 410) {
        // Unless the phone subscribed again while this ring was out.
        const current = parseSubscription((await storage.mailbox(mailboxId))?.pushSubscription);
        if (current?.endpoint === record.endpoint) await storage.updateMailbox(mailboxId, { pushSubscription: null });
      }
    });
  }

  private async sweepAll(): Promise<void> {
    await this.options.storage.sweepExpired(undefined, new Date(this.now() - this.eventTtlMs()).toISOString());
    await this.options.storage.sweepExpiredClaims(new Date(this.now()).toISOString());
  }

  /** One request per mailbox at a time, in arrival order. */
  private serialized<T>(mailboxId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(mailboxId) ?? Promise.resolve();
    const next = previous.then(work, work);
    const settled = next.catch(() => undefined);
    this.queues.set(mailboxId, settled);
    void settled.then(() => {
      if (this.queues.get(mailboxId) === settled) this.queues.delete(mailboxId);
    });
    return next;
  }

  private eventTtlMs(): number {
    return this.options.eventTtlMs ?? MAILBOX_EVENT_TTL_MS_DEFAULT;
  }

  private pushMinIntervalMs(): number {
    return this.options.pushMinIntervalMs ?? MAILBOX_PUSH_MIN_INTERVAL_MS;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  private log(event: string, payload: Record<string, unknown>): void {
    this.options.log?.(event, payload);
  }
}

interface RoomMember {
  socket: WebSocket;
  rendezvousId: string;
  role: RelayRole;
  capability: string;
  /** Device id inside the room; desktop and phone default to their role
   *  name so the two-party pairing keeps its exact wire behavior. */
  deviceId: string;
}

/**
 * The live rooms: the newest connection of a device takes its seat, frames
 * must be sealed relay frames, and the hub forwards them without keeping any.
 * The room's capability is whatever its open sockets carry; with none open
 * the newcomer defines it.
 */
export class HubRelayRooms {
  private readonly rooms = new Map<string, Set<RoomMember>>();
  // Larger than a frame may be, so an oversized one is closed with the
  // relay's own reason rather than the socket library's.
  private readonly sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  private socketCount = 0;
  private readonly socketsByAddress = new Map<string, number>();
  private readonly answered = new WeakSet<WebSocket>();
  private readonly heartbeat: ReturnType<typeof setInterval>;

  constructor() {
    this.heartbeat = setInterval(() => this.beat(), HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  close(): void {
    clearInterval(this.heartbeat);
    for (const members of this.rooms.values()) for (const member of members) member.socket.terminate();
    this.rooms.clear();
    this.sockets.close();
  }

  /** An HTTP request to the room path that is not a WebSocket upgrade. */
  static plainRequestAnswer(url: URL): RelayAnswer {
    if (!url.searchParams.get("rid")) return { status: 400, body: { ok: false, error: "rid required" } };
    return { status: 426, body: { ok: false, error: "websocket required" } };
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, url: URL, address = ""): void {
    const rendezvousId = url.searchParams.get("rid") ?? "";
    if (!rendezvousId) {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    const role = url.searchParams.get("role") ?? "";
    const capability = url.searchParams.get("cap") ?? "";
    const deviceId = isRelayRole(role) ? resolveRelayDeviceId(role, url.searchParams.get("did") ?? "") : "";
    if (this.socketCount >= ROOM_MAX_SOCKETS || (this.socketsByAddress.get(address) ?? 0) >= ROOM_MAX_SOCKETS_PER_ADDRESS) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      return;
    }
    this.sockets.handleUpgrade(request, socket, head, (ws) => {
      this.socketCount += 1;
      this.socketsByAddress.set(address, (this.socketsByAddress.get(address) ?? 0) + 1);
      let counted = true;
      const uncount = () => {
        if (!counted) return;
        counted = false;
        this.socketCount -= 1;
        const left = (this.socketsByAddress.get(address) ?? 1) - 1;
        if (left > 0) this.socketsByAddress.set(address, left); else this.socketsByAddress.delete(address);
      };
      ws.on("close", uncount);
      ws.on("error", uncount);
      if (!rendezvousId || !capability || !isRelayRole(role) || !deviceId) {
        ws.close(1008, "invalid relay pairing request");
        return;
      }
      const members = this.rooms.get(rendezvousId) ?? new Set<RoomMember>();
      const holder = [...members].find((member) => isOpen(member.socket));
      if (holder && holder.capability !== capability) {
        ws.close(1008, "capability mismatch");
        return;
      }
      // Nothing pings from the client side, so one whose remote silently
      // vanished still reads as open: the connection that just arrived is the
      // one provably alive. It takes the seat; every previous holder goes.
      for (const previous of [...members].filter((member) => member.deviceId === deviceId)) {
        try { previous.socket.close(4001, "replaced by newer connection"); } catch { /* already unreachable */ }
      }
      const member: RoomMember = { socket: ws, rendezvousId, role, capability, deviceId };
      members.add(member);
      this.rooms.set(rendezvousId, members);
      this.answered.add(ws);
      ws.on("pong", () => this.answered.add(ws));
      for (const other of this.announceTargets(members, member)) {
        if (!trySend(other.socket, JSON.stringify({ type: "relay.peer-connected", role, rendezvousId, deviceId }))) dropUnreachable(other.socket);
      }
      trySend(ws, JSON.stringify({
        type: "relay.ready",
        role,
        rendezvousId,
        deviceId,
        peerConnected: Boolean(this.legacyPeerFor(members, member)),
        peers: this.openPeers(members, member).map((other) => ({ deviceId: other.deviceId, role: other.role })).filter((peer) => peer.deviceId)
      }));
      ws.on("message", (data, isBinary) => this.message(members, member, data, isBinary));
      const gone = () => this.leave(rendezvousId, member);
      ws.on("close", gone);
      ws.on("error", gone);
    });
  }

  private message(members: Set<RoomMember>, sender: RoomMember, data: unknown, isBinary: boolean): void {
    // The relay answered its keepalive itself, outside the room.
    const text = isBinary ? undefined : rawText(data);
    if (text === "accord-ping") {
      trySend(sender.socket, "accord-pong");
      return;
    }
    if (text === undefined || Buffer.byteLength(text) > MAX_FRAME_BYTES) {
      sender.socket.close(text === undefined ? 1008 : 1009, text === undefined ? "invalid sealed relay frame" : "relay frame exceeds provider floor");
      return;
    }
    const target = sealedRelayFrameTarget(text);
    if (target === undefined) {
      sender.socket.close(1008, "invalid sealed relay frame");
      return;
    }
    const peer = target === null ? this.legacyPeerFor(members, sender) : this.openPeers(members, sender).find((member) => member.deviceId === target);
    const notConnected = JSON.stringify({ type: "relay.error", code: "peer-not-connected", ...(target === null ? {} : { to: target }) });
    if (!peer) {
      trySend(sender.socket, notConnected);
      return;
    }
    if (peer.socket.bufferedAmount > ROOM_MAX_BUFFERED_BYTES || !trySend(peer.socket, text)) {
      // The send just proved the peer is gone: the room stops claiming
      // otherwise, and the sender hears now rather than at an ack timeout.
      dropUnreachable(peer.socket);
      trySend(sender.socket, notConnected);
    }
  }

  /** A replaced socket also lands here when it finally closes: the device
   *  leaves only when no other open socket of it is still seated. */
  private leave(rendezvousId: string, member: RoomMember): void {
    const members = this.rooms.get(rendezvousId);
    if (!members || !members.delete(member)) return;
    if (members.size === 0) this.rooms.delete(rendezvousId);
    const stillSeated = [...members].some((other) => other.deviceId === member.deviceId && isOpen(other.socket));
    if (stillSeated) return;
    for (const other of this.announceTargets(members, member)) {
      trySend(other.socket, JSON.stringify({ type: "relay.peer-disconnected", role: member.role, rendezvousId, deviceId: member.deviceId }));
    }
  }

  private openPeers(members: Set<RoomMember>, self: RoomMember): RoomMember[] {
    return [...members].filter((member) => member !== self && isOpen(member.socket));
  }

  /** The counterpart of an untargeted frame: desktop and phone. A machine has
   *  none; its "peerConnected" means a desktop is present. */
  private legacyPeerFor(members: Set<RoomMember>, self: RoomMember): RoomMember | undefined {
    const wanted: RelayRole = self.role === "desktop" ? "phone" : "desktop";
    return this.openPeers(members, self).find((member) => member.role === wanted);
  }

  /** Who learns that a device joined or left: every other open peer, except
   *  that phones are not told about machines. */
  private announceTargets(members: Set<RoomMember>, self: RoomMember): RoomMember[] {
    return this.openPeers(members, self).filter((member) => !(self.role === "machine" && member.role === "phone"));
  }

  private beat(): void {
    for (const members of this.rooms.values()) {
      for (const member of members) {
        if (!this.answered.has(member.socket)) {
          member.socket.terminate();
          continue;
        }
        this.answered.delete(member.socket);
        try { member.socket.ping(); } catch { member.socket.terminate(); }
      }
    }
  }
}

/** Keeps the first (or, for a tail read, the last) `limit` events in the
 *  given order, and never more envelope than the read budget: fewer events
 *  is a page the reader advances past, an oversized answer is none. */
export function chooseWithinBudget(sorted: HubRelayEventMeta[], limit: number, keepNewest: boolean): HubRelayEventMeta[] {
  const ordered = keepNewest ? [...sorted].reverse() : sorted;
  const chosen: HubRelayEventMeta[] = [];
  let bytes = 0;
  for (const event of ordered) {
    if (chosen.length >= limit) break;
    const size = event.ctLength + 512;
    if (chosen.length > 0 && bytes + size > SELECTION_MAX_BYTES) break;
    chosen.push(event);
    bytes += size;
  }
  return keepNewest ? chosen.reverse() : chosen;
}

function compareMailboxEvents(left: HubRelayEventMeta, right: HubRelayEventMeta): number {
  return left.conversationId.localeCompare(right.conversationId) ||
    left.logScopeId.localeCompare(right.logScopeId) ||
    left.originId.localeCompare(right.originId) ||
    left.originSeq - right.originSeq ||
    left.eventId.localeCompare(right.eventId);
}

function assertMailboxEvent(value: unknown): MailboxEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RelayRequestError("Mailbox event must be an object.");
  const event = value as Partial<MailboxEvent>;
  for (const field of ["eventId", "conversationId", "logScopeId", "originId", "logicalTs", "kind", "payloadHash", "eventHash", "createdAt"] as const) {
    const fieldValue = event[field];
    if (typeof fieldValue !== "string" || !fieldValue.trim()) throw new RelayRequestError(`Mailbox event requires ${field}.`);
    // The hub keeps routing fields in SQLite through its shell, which
    // splits statements on some control characters.
    if (CONTROL_CHARACTER.test(fieldValue)) throw new RelayRequestError(`Mailbox event ${field} has a control character.`);
  }
  if (!Number.isSafeInteger(event.originSeq) || (event.originSeq as number) < 1) throw new RelayRequestError("Mailbox event requires positive originSeq.");
  return event as MailboxEvent;
}

function requiredTrimmedString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || CONTROL_CHARACTER.test(value)) throw new RelayRequestError(`Mailbox claim requires ${label}.`);
  return value.trim();
}

function boundedClaimTtlMs(value: unknown): number {
  const ttl = Number(value ?? DEFAULT_CLAIM_TTL_MS);
  if (!Number.isFinite(ttl)) return DEFAULT_CLAIM_TTL_MS;
  return Math.max(MIN_CLAIM_TTL_MS, Math.min(MAX_CLAIM_TTL_MS, Math.floor(ttl)));
}

function claimExpired(claim: MailboxExecutionClaim, now: number): boolean {
  const expiresAt = Date.parse(claim.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= now;
}

function parseSubscription(text: string | null | undefined): StoredPushSubscription | undefined {
  if (!text) return undefined;
  try {
    const value = JSON.parse(text) as StoredPushSubscription;
    return typeof value.endpoint === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

export function normalizedMailboxId(value: string | null): string {
  const trimmed = value?.trim();
  if (!trimmed) return "";
  return trimmed.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 128);
}

function bearerToken(authorization: string | undefined): string {
  const match = /^Bearer\s+([A-Za-z0-9_-]+)$/.exec((authorization ?? "").trim());
  return match ? match[1] : "";
}

function parseJsonObject(body: Buffer): Record<string, unknown> {
  try {
    const value = JSON.parse(body.length ? body.toString("utf8") : "{}") as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function notAllowed(): RelayAnswer {
  return { status: 405, body: { ok: false, error: "method not allowed" } };
}

function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

function constantTimeEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  const length = Math.max(leftBytes.length, rightBytes.length);
  let mismatch = leftBytes.length === rightBytes.length ? 0 : 1;
  for (let index = 0; index < length; index += 1) mismatch |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  return mismatch === 0;
}

function isRelayRole(value: string): value is RelayRole {
  return value === "desktop" || value === "phone" || value === "machine";
}

function resolveRelayDeviceId(role: RelayRole, deviceId: string): string {
  const trimmed = deviceId.trim();
  if (trimmed) return trimmed;
  return role === "desktop" || role === "phone" ? role : "";
}

/** undefined = not a sealed relay frame; null = untargeted; string = the
 *  device id it is for. */
function sealedRelayFrameTarget(data: string): string | null | undefined {
  try {
    const parsed = JSON.parse(data) as Partial<Record<"protocol" | "streamId" | "logicalMessageId" | "frameId" | "ciphertextChunk" | "to", unknown>>;
    const valid = parsed.protocol === "accord-relay-v1" && typeof parsed.streamId === "string" && typeof parsed.logicalMessageId === "string" &&
      typeof parsed.frameId === "string" && typeof parsed.ciphertextChunk === "string";
    if (!valid) return undefined;
    if (parsed.to === undefined) return null;
    return typeof parsed.to === "string" && parsed.to.trim() ? parsed.to.trim() : undefined;
  } catch {
    return undefined;
  }
}

function rawText(data: unknown): string | undefined {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return undefined;
}

function isOpen(socket: WebSocket): boolean {
  return socket.readyState === socket.OPEN;
}

function trySend(socket: WebSocket, data: string): boolean {
  if (!isOpen(socket)) return false;
  try {
    socket.send(data);
    return true;
  } catch {
    return false;
  }
}

function dropUnreachable(socket: WebSocket): void {
  try { socket.close(1011, "unreachable peer"); } catch { /* already gone */ }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A position from a query: a whole number, at least 0, at most the largest
 *  the store compares exactly. Anything unreadable is 0. */
function boundedPosition(value: string | null): number {
  const parsed = Number(value ?? "0");
  if (!Number.isFinite(parsed)) return parsed > 0 ? Number.MAX_SAFE_INTEGER : 0;
  return Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(parsed)));
}

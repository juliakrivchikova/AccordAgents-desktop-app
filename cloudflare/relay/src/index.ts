import { DurableObject } from "cloudflare:workers";
import {
  CLOUDFLARE_DURABLE_OBJECT_RELAY_MANIFEST,
  type RelayCapabilityManifest
} from "../../../src/shared/relayProtocol";
import {
  MAILBOX_DELETE_PATH,
  MAILBOX_ERROR_UNAUTHORIZED,
  MAILBOX_ERROR_UNREGISTERED,
  MAILBOX_ERROR_PUSH_ENDPOINT_REJECTED,
  MAILBOX_ERROR_REVOKED,
  MAILBOX_ERROR_UNSEALED_PAYLOAD,
  MAILBOX_EVENT_TTL_MS_DEFAULT,
  MAILBOX_PUSH_MIN_INTERVAL_MS,
  MAILBOX_PUSH_SUBSCRIPTION_PATH,
  MAILBOX_REGISTER_PATH,
  MAILBOX_REVOKE_PATH,
  PUSH_VAPID_PATH,
  isAllowedPushEndpointHost,
  isSealedMailboxPayload,
  mailboxBearerToken
} from "../../../src/shared/mailboxSealedPayload";

type MailboxAlarmSchedule = {
  sweepAt?: number;
  pushAt?: number;
};

type RelayRole = "desktop" | "phone";

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
  prevHash?: string;
  signature?: string;
  keyId?: string;
  createdAt: string;
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

interface MailboxLock {
  tokenHashBase64Url: string;
  registeredAt: string;
  /** Minted at registration; a recreated mailbox gets a new epoch so readers
   *  know their arrival cursor no longer applies. */
  epoch: string;
}

/** Server-stamped delivery metadata on a stored event. arrivalSeq orders
 *  cursor reads; arrivedAt drives retention (client createdAt has no
 *  authority over either). */
interface StoredMailboxEvent extends MailboxEvent {
  arrivalSeq: number;
  arrivedAt: string;
}

const RELAY_PATH = "/v1/relay";
const MAILBOX_EVENTS_PATH = "/v1/mailbox/events";
const MAILBOX_CLAIMS_PATH = "/v1/mailbox/claims";
const HEALTH_PATH = "/healthz";
const MANIFEST_PATH = "/v1/relay/manifest";
const MAX_FRAME_BYTES = CLOUDFLARE_DURABLE_OBJECT_RELAY_MANIFEST.maxFrameBytes;
const MAILBOX_LOCK_KEY = "lock";
const MAILBOX_ARRIVAL_SEQ_KEY = "arrival-seq";
const MAILBOX_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAILBOX_PUSH_SUBSCRIPTION_KEY = "push-subscription";
const MAILBOX_PUSH_LAST_SENT_KEY = "push-last-sent";
// W-C: a Durable Object has exactly one alarm, and the retention sweep already
// owns it. Both users write their own due time into this map and the alarm is
// armed to the earliest of them; alarm() fires every slot that is due, clears
// it, and re-arms to the earliest of what remains. Without this a deferred ring
// would silently cancel the sweep, or the reverse.
const MAILBOX_SCHEDULE_KEY = "alarm-schedule";
// W-G: revocation is terminal, so it leaves a permanent marker rather than
// wiping the object clean. A cleared object is indistinguishable from one that
// never existed, which would let a desktop restored from an old backup — or the
// revoked phone itself — silently re-register the same scope id and resurrect
// the mailbox. The tombstone outlives everything else in the object.
const MAILBOX_TOMBSTONE_KEY = "revoked-tombstone";
// A Durable Object's isolate has a fixed memory ceiling, and a sealed timeline
// envelope is not small. Reading the whole box at once therefore worked right
// up until a busy day filled it, then reset the isolate — and since every
// later request repeated the same read, the mailbox stayed reset: the phone
// could not send and the desktop could not append. Both the page size and the
// selection budget below exist to keep any single request's memory bounded by
// the request, never by how much the box happens to hold.
const MAILBOX_SCAN_PAGE = 64;
const MAILBOX_SELECTION_MAX_BYTES = 6 * 1024 * 1024;

/** W5 doorbell: the phone's Web Push subscription, stored behind the mailbox
 *  lock and destroyed with it on revoke. suppressOriginId is the phone's own
 *  event origin so its writes do not ring its own bell; origin ids are
 *  already cleartext envelope routing metadata. */
interface StoredPushSubscription {
  endpoint: string;
  suppressOriginId?: string;
  savedAt: string;
}
const DEFAULT_CLAIM_TTL_MS = 45_000;
const MIN_CLAIM_TTL_MS = 5_000;
const MAX_CLAIM_TTL_MS = 10 * 60_000;

interface RelayPeerAttachment {
  rendezvousId: string;
  role: RelayRole;
  capability: string;
}

// W-F(a): the room uses the WebSocket hibernation API. Sockets are accepted
// through the DurableObjectState with the role as a tag and the pairing
// context serialized onto the socket, so the object can be evicted between
// frames without dropping connections; the runtime answers keepalive pings
// from hibernation via the auto-response pair. No wire-protocol change: the
// ready/peer-connected/peer-disconnected messages, the newest-wins seat, the
// frame-size and sealed-shape guards, and the close codes are exactly the
// pre-hibernation contract.
export class RelayRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("accord-ping", "accord-pong"));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== RELAY_PATH) {
      return json({ ok: false, error: "not found" }, 404);
    }
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return json({ ok: false, error: "websocket required" }, 426);
    }

    const rendezvousId = url.searchParams.get("rid") ?? "";
    const role = url.searchParams.get("role") ?? "";
    const capability = url.searchParams.get("cap") ?? "";
    if (!rendezvousId || !capability || !isRelayRole(role)) {
      return websocketCloseResponse(1008, "invalid relay pairing request");
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // The room's capability is whatever its OPEN sockets carry; with none
    // open the newcomer defines it, exactly like the in-memory room state
    // used to. A dead-but-uncollected socket must not get a vote — it would
    // lock a legitimately re-paired phone out with 1008, the same class of
    // ghost lockout newest-wins removed for the seat itself.
    const holder = this.ctx.getWebSockets().find((socket) => isOpen(socket) && this.attachmentOf(socket));
    const roomCapability = holder ? this.attachmentOf(holder)?.capability : undefined;
    if (roomCapability !== undefined && roomCapability !== capability) {
      server.accept();
      server.close(1008, "capability mismatch");
      return new Response(null, { status: 101, webSocket: client });
    }

    // Nothing pings these sockets from the client side, so one whose remote
    // silently vanished still reads as OPEN. The connection that just
    // arrived is the one that is provably alive — seat it and dismiss every
    // previous holder of the role.
    for (const previous of this.ctx.getWebSockets(role)) {
      try {
        previous.close(4001, "replaced by newer connection");
      } catch {
        // Already unreachable — which is exactly why it lost the seat.
      }
    }

    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ rendezvousId, role, capability } satisfies RelayPeerAttachment);

    const peer = this.peerFor(role);
    if (peer && !this.trySend(peer, JSON.stringify({
      type: "relay.peer-connected",
      role,
      rendezvousId
    }))) {
      this.dropUnreachable(peer);
    }
    this.trySend(server, JSON.stringify({
      type: "relay.ready",
      role,
      rendezvousId,
      peerConnected: Boolean(this.peerFor(role))
    }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const attachment = this.attachmentOf(socket);
    if (!attachment) {
      try {
        socket.close(1008, "unattached relay socket");
      } catch {
        // Already gone.
      }
      return;
    }
    const frameBytes = relayFrameBytes(data);
    if (frameBytes > MAX_FRAME_BYTES) {
      socket.close(1009, "relay frame exceeds provider floor");
      return;
    }
    if (!isSealedRelayFrame(data)) {
      socket.close(1008, "invalid sealed relay frame");
      return;
    }
    const peer = this.peerFor(attachment.role);
    if (!peer) {
      this.trySend(socket, JSON.stringify({ type: "relay.error", code: "peer-not-connected" }));
      return;
    }
    if (!this.trySend(peer, data)) {
      // The send just proved the peer is gone; drop it so the room stops
      // claiming otherwise, and answer the sender now instead of letting it
      // wait out an ack timeout on a frame that went nowhere.
      this.dropUnreachable(peer);
      this.trySend(socket, JSON.stringify({ type: "relay.error", code: "peer-not-connected" }));
    }
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    this.announceRoleGone(socket);
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    this.announceRoleGone(socket);
  }

  /** A replaced socket also lands here when it finally closes, so the seat
   *  may already belong to a newer connection of the same role — announce
   *  the role leaving only when no other open socket still holds it. */
  private announceRoleGone(socket: WebSocket): void {
    const attachment = this.attachmentOf(socket);
    if (!attachment) {
      return;
    }
    const stillSeated = this.ctx.getWebSockets(attachment.role)
      .some((candidate) => candidate !== socket && isOpen(candidate));
    if (stillSeated) {
      return;
    }
    const peer = this.peerFor(attachment.role);
    if (peer) {
      this.trySend(peer, JSON.stringify({
        type: "relay.peer-disconnected",
        role: attachment.role,
        rendezvousId: attachment.rendezvousId
      }));
    }
  }

  private peerFor(role: RelayRole): WebSocket | undefined {
    return this.ctx.getWebSockets(otherRelayRole(role)).find((socket) => isOpen(socket));
  }

  private attachmentOf(socket: WebSocket): RelayPeerAttachment | undefined {
    try {
      return (socket.deserializeAttachment() as RelayPeerAttachment | null) ?? undefined;
    } catch {
      return undefined;
    }
  }

  /** Sending to a vanished socket throws; a room must survive that and
   *  reflect the death rather than die mid-forward. */
  private trySend(socket: WebSocket, data: string | ArrayBuffer): boolean {
    try {
      socket.send(data);
      return true;
    } catch {
      return false;
    }
  }

  private dropUnreachable(peer: WebSocket): void {
    try {
      peer.close(1011, "unreachable peer");
    } catch {
      // Already gone.
    }
  }
}

// Replaces the earlier MailboxStore class. Every mailbox is locked at
// registration with the hash of a bearer token the desktop derives from the
// pairing seal key; reads, writes, and claims all require that token, and
// event payloads must arrive sealed so the relay only ever stores ciphertext.
// The class rename is deliberate: the accompanying wrangler migration deletes
// the old MailboxStore class, which destroys every plaintext event stored
// while the mailbox path ran open.
export class SealedMailboxStore extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return corsPreflight();
    }
    try {
      // W-G: terminal by design — a revoked mailbox answers everything, register
      // included, with its own code. Checked before any other routing so no
      // path can reach storage that revocation was supposed to end.
      const revoked = await this.revokedResponse();
      if (revoked) {
        return revoked;
      }
      if (url.pathname === MAILBOX_REGISTER_PATH) {
        if (request.method === "POST") {
          return await this.register(request);
        }
        return json({ ok: false, error: "method not allowed" }, 405);
      }
      if (url.pathname === MAILBOX_REVOKE_PATH) {
        if (request.method === "POST") {
          return await this.revoke(request);
        }
        return json({ ok: false, error: "method not allowed" }, 405);
      }
      if (
        url.pathname !== MAILBOX_EVENTS_PATH &&
        url.pathname !== MAILBOX_CLAIMS_PATH &&
        url.pathname !== MAILBOX_DELETE_PATH &&
        url.pathname !== MAILBOX_PUSH_SUBSCRIPTION_PATH
      ) {
        return json({ ok: false, error: "not found" }, 404);
      }
      const denied = await this.requireAuthorized(request);
      if (denied) {
        return denied;
      }
      if (url.pathname === MAILBOX_CLAIMS_PATH) {
        if (request.method === "POST") {
          return await this.claimEvent(request);
        }
        return json({ ok: false, error: "method not allowed" }, 405);
      }
      if (url.pathname === MAILBOX_DELETE_PATH) {
        if (request.method === "POST") {
          return await this.deleteEvents(request);
        }
        return json({ ok: false, error: "method not allowed" }, 405);
      }
      if (url.pathname === MAILBOX_PUSH_SUBSCRIPTION_PATH) {
        if (request.method === "POST") {
          return await this.savePushSubscription(request);
        }
        return json({ ok: false, error: "method not allowed" }, 405);
      }
      if (request.method === "POST") {
        return await this.appendEvents(request);
      }
      if (request.method === "GET") {
        return await this.listEvents(url);
      }
      return json({ ok: false, error: "method not allowed" }, 405);
    } catch (error) {
      return json({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      }, 400);
    }
  }

  // Trust-on-first-use, and only ever once: the desktop registers the lock
  // before the pairing link leaves the machine, so the scope id is unknowable
  // to anyone else at registration time. A locked mailbox never changes its
  // token; a new pairing derives a new scope id and registers a new mailbox,
  // and revoking destroys this one.
  private async register(request: Request): Promise<Response> {
    const token = mailboxBearerToken(request.headers);
    if (!token) {
      return json({ ok: false, error: MAILBOX_ERROR_UNAUTHORIZED }, 401);
    }
    const body = await request.json().catch(() => ({})) as { tokenHashBase64Url?: unknown };
    const claimedHash = typeof body.tokenHashBase64Url === "string" ? body.tokenHashBase64Url.trim() : "";
    const computedHash = await sha256Base64Url(token);
    if (!claimedHash || !constantTimeEquals(claimedHash, computedHash)) {
      return json({ ok: false, error: "token hash mismatch" }, 400);
    }
    const lock = await this.ctx.storage.get<MailboxLock>(MAILBOX_LOCK_KEY);
    if (!lock) {
      const created: MailboxLock = {
        tokenHashBase64Url: computedHash,
        registeredAt: new Date().toISOString(),
        epoch: crypto.randomUUID()
      };
      await this.ctx.storage.put(MAILBOX_LOCK_KEY, created);
      return json({ ok: true, registered: true, epoch: created.epoch });
    }
    if (constantTimeEquals(lock.tokenHashBase64Url, computedHash)) {
      // Locks minted before epochs existed gain one on their next register.
      if (!lock.epoch) {
        lock.epoch = crypto.randomUUID();
        await this.ctx.storage.put(MAILBOX_LOCK_KEY, lock);
      }
      return json({ ok: true, registered: true, epoch: lock.epoch });
    }
    return json({ ok: false, error: MAILBOX_ERROR_UNAUTHORIZED }, 401);
  }

  private async revoke(request: Request): Promise<Response> {
    const lock = await this.ctx.storage.get<MailboxLock>(MAILBOX_LOCK_KEY);
    if (!lock) {
      // Nothing registered means nothing readable; report success so revoke
      // retries can settle.
      return json({ ok: true, revoked: false });
    }
    const token = mailboxBearerToken(request.headers);
    if (!token || !constantTimeEquals(lock.tokenHashBase64Url, await sha256Base64Url(token))) {
      return json({ ok: false, error: MAILBOX_ERROR_UNAUTHORIZED }, 401);
    }
    // Everything readable goes; the tombstone stays. Re-pairing is unaffected:
    // a fresh seal key derives a fresh scope id and therefore a different
    // object entirely.
    //
    // Deliberately NOT deleteAll(): on a SQLite-backed object that resets the
    // object itself, and the next request in flight comes back "Network
    // connection lost" instead of a clean revoked answer — the phone would see
    // a transport error where it needs a reason. Clearing the known keys leaves
    // the object alive to answer every later request with its tombstone.
    for (const prefix of ["event:", "claim:"]) {
      const listed = await this.ctx.storage.list({ prefix });
      for (const key of Array.from(listed.keys())) {
        await this.ctx.storage.delete(key);
      }
    }
    await this.ctx.storage.delete([
      MAILBOX_LOCK_KEY,
      MAILBOX_ARRIVAL_SEQ_KEY,
      MAILBOX_PUSH_SUBSCRIPTION_KEY,
      MAILBOX_PUSH_LAST_SENT_KEY,
      MAILBOX_SCHEDULE_KEY
    ]);
    // A revoked object must not keep an armed alarm: there is nothing left to
    // sweep and nothing left to ring.
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.put(MAILBOX_TOMBSTONE_KEY, { revokedAt: new Date().toISOString() });
    return json({ ok: true, revoked: true });
  }

  /** Answers every route, including register, once the mailbox is revoked. */
  private async revokedResponse(): Promise<Response | undefined> {
    const tombstone = await this.ctx.storage.get<{ revokedAt: string }>(MAILBOX_TOMBSTONE_KEY);
    if (!tombstone) {
      return undefined;
    }
    return json({ ok: false, error: MAILBOX_ERROR_REVOKED, revokedAt: tombstone.revokedAt }, 401);
  }

  private async requireAuthorized(request: Request): Promise<Response | undefined> {
    const lock = await this.ctx.storage.get<MailboxLock>(MAILBOX_LOCK_KEY);
    if (!lock) {
      return json({ ok: false, error: MAILBOX_ERROR_UNREGISTERED }, 401);
    }
    const token = mailboxBearerToken(request.headers);
    if (!token || !constantTimeEquals(lock.tokenHashBase64Url, await sha256Base64Url(token))) {
      return json({ ok: false, error: MAILBOX_ERROR_UNAUTHORIZED }, 401);
    }
    return undefined;
  }

  private async appendEvents(request: Request): Promise<Response> {
    const body = await request.json().catch(() => ({})) as { events?: unknown; runFinished?: unknown };
    const incoming = Array.isArray(body.events) ? body.events.map(assertMailboxEvent) : [];
    const runFinished = body.runFinished === true;
    for (const event of incoming) {
      if (!isSealedMailboxPayload(event.payload)) {
        return json({ ok: false, error: MAILBOX_ERROR_UNSEALED_PAYLOAD }, 400);
      }
    }
    const appendedEventIds: string[] = [];
    const duplicateEventIds: string[] = [];
    let arrivalSeq = (await this.ctx.storage.get<number>(MAILBOX_ARRIVAL_SEQ_KEY)) ?? 0;
    const arrivedAt = new Date().toISOString();
    for (const event of incoming) {
      const key = eventStorageKey(event.eventId);
      const existing = await this.ctx.storage.get<MailboxEvent>(key);
      if (existing) {
        duplicateEventIds.push(event.eventId);
        continue;
      }
      arrivalSeq += 1;
      await this.ctx.storage.put(key, { ...event, arrivalSeq, arrivedAt } satisfies StoredMailboxEvent);
      appendedEventIds.push(event.eventId);
    }
    if (appendedEventIds.length > 0) {
      await this.ctx.storage.put(MAILBOX_ARRIVAL_SEQ_KEY, arrivalSeq);
      // Retention sweep runs even when nobody reads; arm once, re-armed by
      // the alarm itself while events remain.
      await this.armAlarmSlot("sweepAt", Date.now() + MAILBOX_SWEEP_INTERVAL_MS);
      // W-C: the doorbell rings when a run *finishes*, not on every append.
      // The publisher sets runFinished on the append whose batch carries a
      // terminal snapshot — transient, batch-scoped request metadata, never a
      // stored envelope field. An unmarked append never rings.
      if (runFinished) {
        const appended = incoming.filter((event) => appendedEventIds.includes(event.eventId));
        this.ctx.waitUntil(this.maybeSendWakePush(appended).catch(() => undefined));
      }
    }
    return json({
      ackRole: "mailbox",
      eventIds: incoming.map((event) => event.eventId),
      appendedEventIds,
      duplicateEventIds
    });
  }

  private async savePushSubscription(request: Request): Promise<Response> {
    const body = await request.json().catch(() => ({})) as Partial<{
      subscription: { endpoint?: unknown };
      suppressOriginId: unknown;
    }>;
    const endpoint = typeof body.subscription?.endpoint === "string" ? body.subscription.endpoint.trim() : "";
    let parsed: URL;
    try {
      parsed = new URL(endpoint);
    } catch {
      return json({ ok: false, error: "push subscription endpoint must be a URL" }, 400);
    }
    if (parsed.protocol !== "https:") {
      return json({ ok: false, error: MAILBOX_ERROR_PUSH_ENDPOINT_REJECTED, reason: "https required" }, 400);
    }
    // W-D: only real Web Push origins. Anything else would make this worker an
    // unbounded egress hop for whoever owns the mailbox.
    if (!isAllowedPushEndpointHost(parsed.hostname)) {
      return json({ ok: false, error: MAILBOX_ERROR_PUSH_ENDPOINT_REJECTED, reason: "unsupported push service" }, 400);
    }
    const record: StoredPushSubscription = {
      endpoint: parsed.toString(),
      ...(typeof body.suppressOriginId === "string" && body.suppressOriginId.trim()
        ? { suppressOriginId: body.suppressOriginId.trim() }
        : {}),
      savedAt: new Date().toISOString()
    };
    await this.ctx.storage.put(MAILBOX_PUSH_SUBSCRIPTION_KEY, record);
    return json({ ok: true, saved: true });
  }

  /** Decides whether this finished run rings now, later, or not at all.
   *  A finish landing inside the debounce window must be DEFERRED, not
   *  dropped: it is the last thing that happens in that run, so dropping it
   *  means the phone is never told. */
  private async maybeSendWakePush(appended: MailboxEvent[]): Promise<void> {
    const record = await this.ctx.storage.get<StoredPushSubscription>(MAILBOX_PUSH_SUBSCRIPTION_KEY);
    if (!record) {
      return;
    }
    if (record.suppressOriginId && appended.every((event) => event.originId === record.suppressOriginId)) {
      return;
    }
    const now = Date.now();
    const lastSent = (await this.ctx.storage.get<number>(MAILBOX_PUSH_LAST_SENT_KEY)) ?? 0;
    const minInterval = this.pushMinIntervalMs();
    if (now - lastSent < minInterval) {
      await this.armAlarmSlot("pushAt", lastSent + minInterval);
      return;
    }
    await this.sendWakePush();
  }

  /** Sends the empty VAPID-authenticated wake push. Reads subscription and
   *  VAPID state at call time, so a deferred ring uses what is true when it
   *  fires rather than when it was scheduled. A 404/410 means the
   *  subscription lapsed: drop it, do not retry, and let the phone
   *  re-register on its next open. */
  private async sendWakePush(): Promise<void> {
    const record = await this.ctx.storage.get<StoredPushSubscription>(MAILBOX_PUSH_SUBSCRIPTION_KEY);
    if (!record) {
      return;
    }
    const env = this.env as {
      ACCORD_VAPID_PUBLIC_KEY?: string;
      ACCORD_VAPID_PRIVATE_KEY_JWK?: string;
      ACCORD_VAPID_SUBJECT?: string;
    };
    if (!env.ACCORD_VAPID_PUBLIC_KEY || !env.ACCORD_VAPID_PRIVATE_KEY_JWK) {
      return;
    }
    await this.ctx.storage.put(MAILBOX_PUSH_LAST_SENT_KEY, Date.now());
    const jwt = await vapidJwt(
      new URL(record.endpoint).origin,
      env.ACCORD_VAPID_SUBJECT ?? "mailto:relay@accordagents.com",
      env.ACCORD_VAPID_PRIVATE_KEY_JWK
    );
    const response = await fetch(record.endpoint, {
      method: "POST",
      headers: {
        TTL: "300",
        Urgency: "normal",
        Authorization: `vapid t=${jwt}, k=${env.ACCORD_VAPID_PUBLIC_KEY}`
      }
    });
    if (response.status === 404 || response.status === 410) {
      await this.ctx.storage.delete(MAILBOX_PUSH_SUBSCRIPTION_KEY);
    }
  }

  private async listEvents(url: URL): Promise<Response> {
    const conversationId = url.searchParams.get("conversationId") ?? "";
    const logScopeId = url.searchParams.get("logScopeId") ?? "";
    const originId = url.searchParams.get("originId") ?? "";
    const afterSeq = Number(url.searchParams.get("afterSeq") ?? "0");
    const afterArrivalRaw = url.searchParams.get("afterArrival");
    const afterArrival = afterArrivalRaw === null ? undefined : Math.max(0, Number(afterArrivalRaw) || 0);
    const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get("limit") ?? "500")));
    const tail = url.searchParams.get("tail") === "true";
    // Cursor mode supersedes tail: ascending arrival order, strictly after the
    // cursor, so the reader can advance to the last event it received.
    const cursorMode = afterArrival !== undefined;
    const order = cursorMode
      ? (left: StoredMailboxEvent, right: StoredMailboxEvent) => left.arrivalSeq - right.arrivalSeq
      : compareMailboxEvents;
    // The selection is built during the sweep instead of after it, so only the
    // events this reader can actually receive are ever held at once.
    const selection = new BoundedEventSelection(order, limit, tail && !cursorMode);
    const swept = await this.sweepExpired((event) => {
      if (conversationId && event.conversationId !== conversationId) {
        return;
      }
      if (logScopeId && event.logScopeId !== logScopeId) {
        return;
      }
      if (originId && event.originId !== originId) {
        return;
      }
      if (originId && Number.isFinite(afterSeq) && event.originSeq <= afterSeq) {
        return;
      }
      if (cursorMode && event.arrivalSeq <= (afterArrival as number)) {
        return;
      }
      selection.offer(event);
    });
    const maxArrivalSeq = (await this.ctx.storage.get<number>(MAILBOX_ARRIVAL_SEQ_KEY)) ?? 0;
    // With an empty box the oldest retained sequence is one past the counter,
    // so a reader's staleness test (cursor + 1 < oldestArrivalSeq) still
    // detects that everything expired underneath it.
    const oldestArrivalSeq = swept.oldestArrivalSeq ?? maxArrivalSeq + 1;
    const events = selection.take();
    const lock = await this.ctx.storage.get<MailboxLock>(MAILBOX_LOCK_KEY);
    return json({
      events,
      maxArrivalSeq,
      oldestArrivalSeq,
      epoch: lock?.epoch ?? ""
    });
  }

  // Owner-driven deletion (W3): the desktop names its own superseded
  // envelopes once a run's terminal snapshot is durable. Ids only — the
  // relay learns nothing it does not already store.
  private async deleteEvents(request: Request): Promise<Response> {
    const body = await request.json().catch(() => ({})) as { eventIds?: unknown };
    const eventIds = Array.isArray(body.eventIds)
      ? body.eventIds.filter((id): id is string => typeof id === "string" && Boolean(id.trim())).slice(0, 1000)
      : [];
    const deletedEventIds: string[] = [];
    for (const eventId of eventIds) {
      const key = eventStorageKey(eventId);
      if (await this.ctx.storage.get<MailboxEvent>(key)) {
        await this.ctx.storage.delete(key);
        deletedEventIds.push(eventId);
      }
    }
    return json({ ok: true, deletedEventIds });
  }

  private eventTtlMs(): number {
    const raw = Number((this.env as { ACCORD_MAILBOX_EVENT_TTL_MS?: string }).ACCORD_MAILBOX_EVENT_TTL_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : MAILBOX_EVENT_TTL_MS_DEFAULT;
  }

  /** Timing knob only, same shape as the retention TTL above: the deferred-ring
   *  test must not sleep for the production interval. It cannot relax any
   *  authorization or endpoint rule. */
  private pushMinIntervalMs(): number {
    const raw = Number((this.env as { ACCORD_MAILBOX_PUSH_MIN_INTERVAL_MS?: string }).ACCORD_MAILBOX_PUSH_MIN_INTERVAL_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : MAILBOX_PUSH_MIN_INTERVAL_MS;
  }

  /** Walks a key prefix one bounded page at a time. Deleting the key that was
   *  just yielded is safe: the cursor is the key itself, so a removal does not
   *  shift what comes next. */
  private async *scanPrefix<T>(prefix: string): AsyncGenerator<[string, T]> {
    let startAfter: string | undefined;
    for (;;) {
      const page = await this.ctx.storage.list<T>({
        prefix,
        limit: MAILBOX_SCAN_PAGE,
        ...(startAfter === undefined ? {} : { startAfter })
      });
      if (page.size === 0) {
        return;
      }
      const entries = Array.from(page.entries());
      for (let index = 0; index < entries.length; index += 1) {
        startAfter = entries[index][0];
        yield entries[index];
      }
      if (page.size < MAILBOX_SCAN_PAGE) {
        return;
      }
    }
  }

  /** Deletes expired events and reports what survived. Events stored before
   *  arrival stamping existed carry no arrivedAt; they are treated as expired
   *  rather than immortal.
   *
   *  Retained events are handed to `collect` one at a time rather than
   *  returned as an array: the caller keeps only the ones it will answer with,
   *  which is what stops a large mailbox from resetting the isolate. */
  private async sweepExpired(
    collect?: (event: StoredMailboxEvent) => void
  ): Promise<{ retainedCount: number; oldestArrivalSeq?: number }> {
    const cutoff = Date.now() - this.eventTtlMs();
    let retainedCount = 0;
    let oldestArrivalSeq: number | undefined;
    for await (const [key, event] of this.scanPrefix<StoredMailboxEvent>("event:")) {
      const arrivedAt = Date.parse(event.arrivedAt ?? "");
      if (!Number.isFinite(arrivedAt) || arrivedAt < cutoff) {
        await this.ctx.storage.delete(key);
        continue;
      }
      retainedCount += 1;
      if (oldestArrivalSeq === undefined || event.arrivalSeq < oldestArrivalSeq) {
        oldestArrivalSeq = event.arrivalSeq;
      }
      collect?.(event);
    }
    return { retainedCount, oldestArrivalSeq };
  }

  // Execution claims are written on every mobile message but were never
  // deleted, so a busy mailbox's storage grew without bound. Sweep expired
  // claims alongside events.
  private async sweepExpiredClaims(): Promise<void> {
    const now = Date.now();
    for await (const [key, claim] of this.scanPrefix<MailboxExecutionClaim>("claim:")) {
      if (claimExpired(claim, now)) {
        await this.ctx.storage.delete(key);
      }
    }
  }

  /** Writes one slot's due time and arms the object's single alarm to the
   *  earliest slot. Never moves an alarm later than an existing slot needs. */
  private async armAlarmSlot(slot: keyof MailboxAlarmSchedule, at: number): Promise<void> {
    const schedule = (await this.ctx.storage.get<MailboxAlarmSchedule>(MAILBOX_SCHEDULE_KEY)) ?? {};
    const existing = schedule[slot];
    if (existing !== undefined && existing <= at) {
      return;
    }
    schedule[slot] = at;
    await this.ctx.storage.put(MAILBOX_SCHEDULE_KEY, schedule);
    await this.rearmAlarm(schedule);
  }

  private async rearmAlarm(schedule: MailboxAlarmSchedule): Promise<void> {
    const due = [schedule.sweepAt, schedule.pushAt].filter((at): at is number => typeof at === "number");
    if (due.length === 0) {
      return;
    }
    const earliest = Math.min(...due);
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > earliest) {
      await this.ctx.storage.setAlarm(earliest);
    }
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const schedule = (await this.ctx.storage.get<MailboxAlarmSchedule>(MAILBOX_SCHEDULE_KEY)) ?? {};
    // Take every slot that is due, clear it, then run it. A slot that re-arms
    // itself (the sweep, while events remain) writes a fresh due time below.
    const sweepDue = schedule.sweepAt !== undefined && schedule.sweepAt <= now;
    const pushDue = schedule.pushAt !== undefined && schedule.pushAt <= now;
    if (sweepDue) {
      delete schedule.sweepAt;
    }
    if (pushDue) {
      delete schedule.pushAt;
    }
    await this.ctx.storage.put(MAILBOX_SCHEDULE_KEY, schedule);

    if (sweepDue) {
      const swept = await this.sweepExpired();
      await this.sweepExpiredClaims();
      if (swept.retainedCount > 0) {
        await this.armAlarmSlot("sweepAt", Date.now() + MAILBOX_SWEEP_INTERVAL_MS);
      }
    }
    if (pushDue) {
      // A deferred ring reads subscription state at fire time, not at the time
      // it was scheduled: the phone may have unsubscribed in between.
      await this.sendWakePush();
    }
    await this.rearmAlarm((await this.ctx.storage.get<MailboxAlarmSchedule>(MAILBOX_SCHEDULE_KEY)) ?? {});
  }

  private async claimEvent(request: Request): Promise<Response> {
    const body = await request.json().catch(() => ({})) as Partial<{
      conversationId: unknown;
      eventId: unknown;
      ownerId: unknown;
      ownerRole: unknown;
      runId: unknown;
      ttlMs: unknown;
    }>;
    const conversationId = requiredTrimmedString(body.conversationId, "conversationId");
    const eventId = requiredTrimmedString(body.eventId, "eventId");
    const ownerId = requiredTrimmedString(body.ownerId, "ownerId");
    const ownerRole = requiredTrimmedString(body.ownerRole, "ownerRole");
    const runId = requiredTrimmedString(body.runId, "runId");
    const ttlMs = boundedClaimTtlMs(body.ttlMs);
    const now = Date.now();
    const key = claimStorageKey(conversationId, eventId);
    const existing = await this.ctx.storage.get<MailboxExecutionClaim>(key);
    if (existing && existing.ownerId !== ownerId && !claimExpired(existing, now)) {
      return json({
        ok: true,
        acquired: false,
        claim: existing
      });
    }
    const timestamp = new Date(now).toISOString();
    const claim: MailboxExecutionClaim = {
      conversationId,
      eventId,
      ownerId,
      ownerRole,
      runId,
      claimedAt: existing?.ownerId === ownerId ? existing.claimedAt : timestamp,
      updatedAt: timestamp,
      expiresAt: new Date(now + ttlMs).toISOString()
    };
    await this.ctx.storage.put(key, claim);
    return json({
      ok: true,
      acquired: true,
      claim
    });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // Operational stop. Set ACCORD_RELAY_DISABLED=1 in wrangler vars to take
    // the relay out of service without deleting it or its stored mailboxes.
    // Turned on 2026-08-16 because the mailbox endpoints served chat content
    // to any caller; clear the flag once reads and writes require a key.
    if ((env as { ACCORD_RELAY_DISABLED?: string }).ACCORD_RELAY_DISABLED === "1") {
      return json({ ok: false, error: "relay_disabled" }, 503);
    }
    if (request.method === "OPTIONS") {
      return corsPreflight();
    }
    if (url.pathname === HEALTH_PATH) {
      return json({ ok: true, provider: CLOUDFLARE_DURABLE_OBJECT_RELAY_MANIFEST.provider });
    }
    if (url.pathname === PUSH_VAPID_PATH) {
      // The VAPID public key is public by definition; the private half lives
      // only as a deploy secret on the relay, the one party that sends.
      const publicKey = (env as { ACCORD_VAPID_PUBLIC_KEY?: string }).ACCORD_VAPID_PUBLIC_KEY ?? "";
      return json({ ok: Boolean(publicKey), publicKey });
    }
    if (url.pathname === MANIFEST_PATH) {
      return json({
        ok: true,
        manifest: CLOUDFLARE_DURABLE_OBJECT_RELAY_MANIFEST
      });
    }
    if (
      url.pathname === MAILBOX_EVENTS_PATH ||
      url.pathname === MAILBOX_CLAIMS_PATH ||
      url.pathname === MAILBOX_REGISTER_PATH ||
      url.pathname === MAILBOX_REVOKE_PATH ||
      url.pathname === MAILBOX_DELETE_PATH ||
      url.pathname === MAILBOX_PUSH_SUBSCRIPTION_PATH
    ) {
      // No default mailbox: a caller that does not name its own locked
      // mailbox has nothing to talk to.
      const mailboxId = normalizedMailboxId(url.searchParams.get("mailboxId"));
      if (!mailboxId) {
        return json({ ok: false, error: "mailboxId required" }, 400);
      }
      const stub = env.MAILBOXES.getByName(mailboxId);
      return stub.fetch(request);
    }
    if (url.pathname !== RELAY_PATH) {
      return json({ ok: false, error: "not found" }, 404);
    }

    const rendezvousId = url.searchParams.get("rid") ?? "";
    if (!rendezvousId) {
      return json({ ok: false, error: "rid required" }, 400);
    }
    const stub = env.RELAY_ROOMS.getByName(rendezvousId);
    return stub.fetch(request);
  }
} satisfies ExportedHandler<Env>;

function isRelayRole(value: string): value is RelayRole {
  return value === "desktop" || value === "phone";
}

function otherRelayRole(role: RelayRole): RelayRole {
  return role === "desktop" ? "phone" : "desktop";
}

function isOpen(socket: WebSocket | undefined): socket is WebSocket {
  return Boolean(socket && socket.readyState === WebSocket.OPEN);
}

function relayFrameBytes(data: string | ArrayBuffer): number {
  if (typeof data === "string") {
    return new TextEncoder().encode(data).byteLength;
  }
  return data.byteLength;
}

function isSealedRelayFrame(data: string | ArrayBuffer): boolean {
  if (typeof data !== "string") {
    return false;
  }
  try {
    const parsed = JSON.parse(data) as Partial<{
      protocol: unknown;
      streamId: unknown;
      logicalMessageId: unknown;
      frameId: unknown;
      ciphertextChunk: unknown;
    }>;
    return parsed.protocol === "accord-relay-v1" &&
      typeof parsed.streamId === "string" &&
      typeof parsed.logicalMessageId === "string" &&
      typeof parsed.frameId === "string" &&
      typeof parsed.ciphertextChunk === "string";
  } catch {
    return false;
  }
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

// RFC 8292 VAPID: a compact ES256 JWS over {aud, exp, sub}. WebCrypto's
// ECDSA P-256 signature is already the raw r||s form JWS expects.
async function vapidJwt(audience: string, subject: string, privateKeyJwkJson: string): Promise<string> {
  const header = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: subject
  })));
  const signingInput = `${header}.${claims}`;
  const key = await crypto.subtle.importKey(
    "jwk",
    JSON.parse(privateKeyJwkJson),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput)
  );
  return `${signingInput}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function constantTimeEquals(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let mismatch = leftBytes.length === rightBytes.length ? 0 : 1;
  for (let index = 0; index < length; index += 1) {
    mismatch |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return mismatch === 0;
}

function assertMailboxEvent(value: unknown): MailboxEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Mailbox event must be an object.");
  }
  const event = value as Partial<MailboxEvent>;
  for (const field of ["eventId", "conversationId", "logScopeId", "originId", "logicalTs", "kind", "payloadHash", "eventHash", "createdAt"] as const) {
    const fieldValue = event[field];
    if (typeof fieldValue !== "string" || !fieldValue.trim()) {
      throw new Error(`Mailbox event requires ${field}.`);
    }
  }
  if (!Number.isSafeInteger(event.originSeq) || event.originSeq < 1) {
    throw new Error("Mailbox event requires positive originSeq.");
  }
  return event as MailboxEvent;
}

/** Keeps the best `limit` events seen so far under a byte ceiling, so the
 *  memory a read costs is set by what the reader asked for and not by how much
 *  the mailbox holds. `keepNewest` selects from the end of the order (tail
 *  reads) instead of the start. */
class BoundedEventSelection {
  private readonly events: StoredMailboxEvent[] = [];
  private bytes = 0;
  private dirty = false;

  constructor(
    private readonly order: (left: StoredMailboxEvent, right: StoredMailboxEvent) => number,
    private readonly limit: number,
    private readonly keepNewest: boolean
  ) {}

  offer(event: StoredMailboxEvent): void {
    this.events.push(event);
    this.bytes += approximateEventBytes(event);
    this.dirty = true;
    // Trimming on a slack window rather than on every event keeps the sort
    // amortized while still bounding what is held.
    if (this.events.length >= this.limit * 2 || this.bytes > MAILBOX_SELECTION_MAX_BYTES) {
      this.trim();
    }
  }

  take(): StoredMailboxEvent[] {
    this.trim();
    return this.events;
  }

  private trim(): void {
    if (this.dirty) {
      this.events.sort(this.order);
      this.dirty = false;
    }
    if (this.events.length > this.limit) {
      if (this.keepNewest) {
        this.events.splice(0, this.events.length - this.limit);
      } else {
        this.events.length = this.limit;
      }
      this.bytes = this.events.reduce((total, event) => total + approximateEventBytes(event), 0);
    }
    // A single reader must not be answered with more than the ceiling even
    // when it asked for a large limit: fewer events now is a page the reader
    // advances past, while an oversized response is a mailbox that never
    // answers at all.
    while (this.events.length > 1 && this.bytes > MAILBOX_SELECTION_MAX_BYTES) {
      const dropped = this.keepNewest ? this.events.shift() : this.events.pop();
      this.bytes -= approximateEventBytes(dropped as StoredMailboxEvent);
    }
  }
}

/** The sealed ciphertext dominates an envelope's size; the constant covers the
 *  routing fields around it. Close enough to hold a budget, and free compared
 *  with serializing every candidate. */
function approximateEventBytes(event: StoredMailboxEvent): number {
  const payload = event.payload as { ct?: unknown } | undefined;
  const ciphertext = typeof payload?.ct === "string" ? payload.ct.length : 0;
  return ciphertext + 512;
}

function compareMailboxEvents(left: MailboxEvent, right: MailboxEvent): number {
  return left.conversationId.localeCompare(right.conversationId) ||
    left.logScopeId.localeCompare(right.logScopeId) ||
    left.originId.localeCompare(right.originId) ||
    left.originSeq - right.originSeq ||
    left.eventId.localeCompare(right.eventId);
}

function eventStorageKey(eventId: string): string {
  return `event:${eventId}`;
}

function claimStorageKey(conversationId: string, eventId: string): string {
  return `claim:${conversationId}:${eventId}`;
}

function claimExpired(claim: MailboxExecutionClaim, now: number): boolean {
  const expiresAt = Date.parse(claim.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= now;
}

function boundedClaimTtlMs(value: unknown): number {
  const ttl = Number(value ?? DEFAULT_CLAIM_TTL_MS);
  if (!Number.isFinite(ttl)) {
    return DEFAULT_CLAIM_TTL_MS;
  }
  return Math.max(MIN_CLAIM_TTL_MS, Math.min(MAX_CLAIM_TTL_MS, Math.floor(ttl)));
}

function requiredTrimmedString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Mailbox claim requires ${label}.`);
  }
  return value.trim();
}

function normalizedMailboxId(value: string | null): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 128);
}

function websocketCloseResponse(code: number, reason: string): Response {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();
  server.close(code, reason);
  return new Response(null, { status: 101, webSocket: client });
}

function corsPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders()
  });
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: corsHeaders()
  });
}

function corsHeaders(): HeadersInit {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
    "cache-control": "no-store"
  };
}

export function cloudflareRelayCapabilityManifest(): RelayCapabilityManifest {
  return CLOUDFLARE_DURABLE_OBJECT_RELAY_MANIFEST;
}

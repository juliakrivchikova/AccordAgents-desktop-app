import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import path from "node:path";
import type { Duplex } from "node:stream";
import { isDeviceEventBlobReference, type DeviceEventBlobReference } from "../shared/deviceEventBlobs";
import {
  HUB_AUTH_MAX_SKEW_MS,
  HUB_MAX_BODY_BYTES,
  HUB_MAX_SMALL_BODY_BYTES,
  HUB_PROTOCOL_VERSION,
  HUB_ROOM_MAX_MESSAGE_BYTES,
  HUB_ROOM_REPLACED_CLOSE_CODE,
  HUB_ROSTER_ROLES,
  hubRoomRole,
  type HubDevice,
  type HubHealth,
  type HubLiveHead,
  type HubRosterRequest
} from "../shared/hubProtocol";
import { HubNonceCache, deviceIdForPublicKey, parseHubAuthorization, verifyHubRequest, type ParsedHubAuthorization } from "../main/services/hubAuth";
import { HUB_RELAY_MANIFEST } from "../shared/relayProtocol";
import { HubRelayRooms, RELAY_BODY_BYTES_IN_FLIGHT_MAX, RELAY_HEALTH_PATH, RELAY_MAILBOX_APPEND_MAX_BYTES, RELAY_MAILBOX_PATHS, RELAY_MAILBOX_SMALL_MAX_BYTES, RELAY_MAILBOX_TINY_MAX_BYTES, RELAY_MANIFEST_PATH, RELAY_ROOM_PATH, type HubRelayMailboxes } from "./hubRelay";
import { MAILBOX_HUB_AUTHORIZATION_HEADER } from "../shared/mailboxSealedPayload";
import type { ChatSearchService } from "../main/services/chatSearch";
import type { StorageService } from "../main/services/storage";
import { HubRequestError, type HubLog } from "./hubLog";
import { isAllowedPushEndpoint } from "./hubPush";

export interface HubServerOptions {
  hubId: string;
  version: string;
  storage: StorageService;
  log: HubLog;
  search: ChatSearchService;
  vapidPublicKey: string;
  /** Files Let's Encrypt validation reads over plain HTTP. */
  acmeWebroot?: string;
  /** The relay the phone and machines speak (sealed mailboxes, live rooms). */
  relay?: { mailboxes: HubRelayMailboxes; rooms: HubRelayRooms };
  now?: () => number;
  debugLog?: (event: string, payload: Record<string, unknown>) => void;
}

const BLOB_PATH = /^\/v1\/blobs\/(sha256:[0-9a-f]{64})$/;

/** The little of `ws` the live socket uses (the package ships no types here). */
interface LiveSocket {
  readonly readyState: number;
  readonly OPEN: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  ping(): void;
  on(event: "close" | "error" | "pong", listener: () => void): void;
  on(event: "message", listener: (data: unknown) => void): void;
}

/** A socket that did not answer the last ping by the next one is dead (a
 *  laptop that slept, a phone that lost its network) and is closed. */
const HEARTBEAT_MS = 30_000;
/** A device that cannot keep up with its room is disconnected rather than
 *  buffered without end; it reconnects and continues. */
const ROOM_MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
/** Requests slower than this are logged; the rest only count. */
const SLOW_REQUEST_MS = 500;
/** Search text and cursors are plain text. */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/** One device in a room: the live, unstored path for messages that only
 *  matter while both ends are there (greetings, requests answered at once). */
interface RoomMember {
  deviceId: string;
  role: string;
  socket: LiveSocket;
}

const ROOM_ID = /^[A-Za-z0-9._:-]{1,128}$/;
interface LiveSocketServer {
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, done: (socket: LiveSocket) => void): void;
}
const { WebSocketServer } = require("ws") as { WebSocketServer: new (options: { noServer: true; maxPayload: number }) => LiveSocketServer };

/**
 * The hub's HTTP surface. Every route but the health check and the VAPID key
 * is signed by a device on the roster. The live socket only says where the
 * order's head is, and devices read the rest over HTTP; rooms forward live
 * messages between the User's devices without keeping them.
 */
export class HubServer {
  private readonly nonces = new HubNonceCache();
  /** Relay request bodies being read now, by their declared size. */
  private relayBodyBytes = 0;
  /** Live head sockets and the device each one belongs to. */
  private readonly live = new Map<LiveSocket, string>();
  private readonly sockets: LiveSocketServer = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  private readonly roomSockets: LiveSocketServer = new WebSocketServer({ noServer: true, maxPayload: HUB_ROOM_MAX_MESSAGE_BYTES });
  private readonly answered = new WeakSet<LiveSocket>();
  private heartbeat?: ReturnType<typeof setInterval>;
  private readonly rooms = new Map<string, Map<string, RoomMember>>();
  private servers: Server[] = [];
  private roster?: Promise<Map<string, HubDevice>>;
  private readonly now: () => number;

  constructor(private readonly options: HubServerOptions) {
    this.now = options.now ?? Date.now;
    options.log.onAppended(({ head }) => this.broadcastHead(head));
  }

  /** The roster changed (or may have): read it again on the next request. */
  invalidateRoster(): void {
    this.roster = undefined;
  }

  private rosterReadAt = 0;

  private async device(deviceId: string): Promise<HubDevice | undefined> {
    const read = () => {
      this.rosterReadAt = this.now();
      return this.options.storage.hub().devices().then((devices) => new Map(devices.map((device) => [device.deviceId, device])));
    };
    this.roster ??= read();
    try {
      const known = (await this.roster).get(deviceId);
      if (known) return known;
      // A device added by the setup (another process) is found on a fresh
      // read; an unknown one cannot make the hub read the roster more than
      // once a second.
      if (this.now() - this.rosterReadAt < 1_000) return undefined;
      this.roster = read();
      return (await this.roster).get(deviceId);
    } catch (error) {
      this.roster = undefined;
      throw error;
    }
  }

  /** Plain HTTP. In production it answers only the certificate challenge
   *  and the health check (`openOnly`); the rest needs TLS. Tests and local
   *  runs serve everything. */
  listenHttp(port: number, host?: string, options: { openOnly?: boolean } = {}): Promise<Server> {
    const server = createHttpServer((request, response) => void this.handle(request, response, options.openOnly === true));
    if (!options.openOnly) server.on("upgrade", (request, socket, head) => void this.upgrade(request, socket, head));
    return this.listen(server, port, host);
  }

  /** HTTPS with the certificate on disk, re-read when it is renewed. */
  listenHttps(port: number, files: { cert: string; key: string }, host?: string): Promise<Server> {
    const load = () => ({ cert: readFileSync(files.cert), key: readFileSync(files.key) });
    const server = createHttpsServer(load(), (request, response) => void this.handle(request, response));
    server.on("upgrade", (request, socket, head) => void this.upgrade(request, socket, head));
    let stamp = certStamp(files);
    const reload = setInterval(() => {
      const next = certStamp(files);
      if (next === stamp) return;
      try {
        server.setSecureContext(load());
        stamp = next;
        this.options.debugLog?.("hub.tls.reloaded", {});
      } catch (error) {
        this.options.debugLog?.("hub.tls.reload-failed", { message: error instanceof Error ? error.message : String(error) });
      }
    }, 60_000);
    reload.unref();
    server.on("close", () => clearInterval(reload));
    return this.listen(server, port, host);
  }

  private listen(server: Server, port: number, host?: string): Promise<Server> {
    this.heartbeat ??= setInterval(() => this.beat(), HEARTBEAT_MS);
    this.heartbeat.unref?.();
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        this.servers.push(server);
        resolve(server);
      });
    });
  }

  private watch(socket: LiveSocket): void {
    this.answered.add(socket);
    socket.on("pong", () => this.answered.add(socket));
  }

  private beat(): void {
    const sockets = [...this.live.keys(), ...[...this.rooms.values()].flatMap((members) => [...members.values()].map((member) => member.socket))];
    for (const socket of sockets) {
      if (!this.answered.has(socket)) {
        socket.terminate();
        continue;
      }
      this.answered.delete(socket);
      try { socket.ping(); } catch { socket.terminate(); }
    }
  }

  /** A device taken off the roster keeps nothing open: its live link and its
   *  seats in rooms close now, not when it next disconnects. */
  private async disconnectRemoved(): Promise<void> {
    const kept = new Set((await this.options.storage.hub().devices()).map((device) => device.deviceId));
    for (const [socket, deviceId] of this.live) if (!kept.has(deviceId)) socket.terminate();
    for (const members of this.rooms.values()) {
      for (const member of members.values()) if (!kept.has(member.deviceId)) member.socket.terminate();
    }
  }

  async close(): Promise<void> {
    this.options.relay?.mailboxes.close();
    this.options.relay?.rooms.close();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    for (const socket of this.live.keys()) socket.terminate();
    this.live.clear();
    for (const members of this.rooms.values()) for (const member of members.values()) member.socket.terminate();
    this.rooms.clear();
    await Promise.all(this.servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    this.servers = [];
  }

  private broadcastHead(head: number): void {
    const frame = JSON.stringify({ type: "head", head } satisfies HubLiveHead);
    for (const socket of this.live.keys()) {
      if (socket.readyState === socket.OPEN) socket.send(frame);
    }
  }

  /** What can be checked before the body is read: a signature header from a
   *  device on the roster, with a fresh clock. Nobody else makes the hub
   *  read a body. */
  private async preauthenticate(header: string | undefined): Promise<{ auth: ParsedHubAuthorization; device: HubDevice }> {
    const auth = parseHubAuthorization(header);
    if (!auth) throw new HubRequestError(401, "The request is not signed.");
    const device = await this.device(auth.deviceId);
    if (!device || Math.abs(this.now() - auth.timestampMs) > HUB_AUTH_MAX_SKEW_MS) throw new HubRequestError(401, "The request's signature is not accepted.");
    return { auth, device };
  }

  private async authenticate(method: string, body: Buffer, header: string | undefined, pathWithQuery: string, checked?: { auth: ParsedHubAuthorization; device: HubDevice }): Promise<HubDevice> {
    const { auth, device } = checked ?? await this.preauthenticate(header);
    const now = this.now();
    if (!verifyHubRequest(auth, {
      method, pathWithQuery, body, publicKeyDerBase64: device.publicKeyDerBase64, now,
      seenNonce: (deviceId, nonce, timestampMs) => this.nonces.checkAndRemember(deviceId, nonce, timestampMs, now)
    })) {
      throw new HubRequestError(401, "The request's signature is not accepted.");
    }
    return device;
  }

  private async upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", "http://hub");
      if (url.pathname === RELAY_ROOM_PATH && this.options.relay) return this.options.relay.rooms.handleUpgrade(request, socket, head, url, request.socket.remoteAddress ?? "");
      if (url.pathname === "/v1/room") return await this.joinRoom(request, socket, head, url);
      if (url.pathname !== "/v1/live") throw new HubRequestError(404, "Not found.");
      // A browser cannot set headers on a WebSocket: the signature of
      // "GET /v1/live" travels in the query instead.
      const device = await this.authenticate("GET", Buffer.alloc(0), url.searchParams.get("auth") ?? undefined, "/v1/live");
      this.sockets.handleUpgrade(request, socket, head, (ws) => {
        this.live.set(ws, device.deviceId);
        this.watch(ws);
        ws.on("close", () => this.live.delete(ws));
        ws.on("error", () => this.live.delete(ws));
        void this.options.log.head().then((value) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "head", head: value } satisfies HubLiveHead));
        });
      });
    } catch (error) {
      const status = error instanceof HubRequestError ? error.status : 500;
      socket.end(`HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : status === 404 ? "Not Found" : "Error"}\r\n\r\n`);
    }
  }

  /**
   * A room is where two or more of the User's devices pass messages that are
   * not kept: the hub forwards each to the device it names (or, without a
   * name, to the other side of a desktop-phone pair) and stores nothing.
   * The member's identity is the one its signature proves.
   */
  private async joinRoom(request: IncomingMessage, socket: Duplex, head: Buffer, url: URL): Promise<void> {
    const rid = url.searchParams.get("rid") ?? "";
    const role = url.searchParams.get("role") ?? "";
    if (!ROOM_ID.test(rid) || !["desktop", "phone", "machine"].includes(role)) throw new HubRequestError(400, "Invalid room.");
    const device = await this.authenticate("GET", Buffer.alloc(0), url.searchParams.get("auth") ?? undefined, `/v1/room?rid=${encodeURIComponent(rid)}&role=${role}`);
    // A device sits in a room as what the roster says it is.
    if (role !== hubRoomRole(device.role)) throw new HubRequestError(403, "A device joins a room only as what it is.");
    this.roomSockets.handleUpgrade(request, socket, head, (ws) => {
      this.watch(ws);
      const members = this.rooms.get(rid) ?? new Map<string, RoomMember>();
      this.rooms.set(rid, members);
      // The newest connection of a device takes its seat.
      const previous = members.get(device.deviceId);
      const member: RoomMember = { deviceId: device.deviceId, role, socket: ws };
      members.set(device.deviceId, member);
      if (previous) previous.socket.close(HUB_ROOM_REPLACED_CLOSE_CODE, "replaced");
      const others = [...members.values()].filter((item) => item !== member);
      ws.send(JSON.stringify({ type: "ready", deviceId: device.deviceId, peers: others.map((item) => ({ deviceId: item.deviceId, role: item.role })) }));
      if (!previous) for (const other of others) sendJson(other.socket, { type: "peer-connected", peer: { deviceId: device.deviceId, role } });
      ws.on("message", (data) => this.roomMessage(rid, member, data));
      const leave = () => {
        if (members.get(device.deviceId) !== member) return;
        members.delete(device.deviceId);
        if (members.size === 0) this.rooms.delete(rid);
        for (const other of members.values()) sendJson(other.socket, { type: "peer-disconnected", peer: { deviceId: device.deviceId, role } });
      };
      ws.on("close", leave);
      ws.on("error", leave);
    });
  }

  private roomMessage(rid: string, sender: RoomMember, data: unknown): void {
    let frame: { type?: unknown; to?: unknown; id?: unknown; data?: unknown };
    try {
      frame = JSON.parse(String(data)) as typeof frame;
    } catch {
      return;
    }
    if (frame.type !== "send" || typeof frame.id !== "string" || typeof frame.data !== "string") return;
    const members = this.rooms.get(rid);
    if (!members) return;
    const to = typeof frame.to === "string" && frame.to ? frame.to : undefined;
    // Without a name, a desktop and a phone reach each other (the two-party pair).
    const targets = to
      ? [members.get(to)].filter((item): item is RoomMember => Boolean(item))
      : [...members.values()].filter((item) => item !== sender && (sender.role === "phone" ? item.role === "desktop" : item.role === "phone"));
    if (targets.length === 0) {
      sendJson(sender.socket, { type: "error", code: "peer-not-connected", ...(to ? { to } : {}) });
      return;
    }
    for (const target of targets) {
      if (target.socket.bufferedAmount > ROOM_MAX_BUFFERED_BYTES) {
        target.socket.terminate();
        continue;
      }
      sendJson(target.socket, { type: "message", from: sender.deviceId, id: frame.id, data: frame.data });
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse, openOnly = false): Promise<void> {
    const started = this.now();
    let status = 200;
    try {
      cors(response);
      if (request.method === "OPTIONS") {
        status = 204;
        response.writeHead(204).end();
        return;
      }
      const url = new URL(request.url ?? "/", "http://hub");
      const pathWithQuery = `${url.pathname}${url.search}`;
      if (url.pathname.startsWith("/.well-known/acme-challenge/") && this.options.acmeWebroot) {
        return this.serveChallenge(url.pathname, response);
      }
      if (request.method === "GET" && url.pathname === "/v1/health") {
        return json(response, 200, {
          ok: true, protocol: HUB_PROTOCOL_VERSION, hubId: this.options.hubId, version: this.options.version, head: await this.options.log.head()
        } satisfies HubHealth);
      }
      if (request.method === "GET" && url.pathname === "/v1/push/vapid") {
        return json(response, 200, { ok: true, publicKey: this.options.vapidPublicKey });
      }
      if (openOnly) throw new HubRequestError(403, "Use HTTPS.");
      const relay = this.options.relay;
      if (relay) {
        // The relay's own paths answer as the relay did, with its own keys.
        if (request.method === "GET" && url.pathname === RELAY_HEALTH_PATH) return json(response, 200, { ok: true, provider: HUB_RELAY_MANIFEST.provider });
        if (request.method === "GET" && url.pathname === RELAY_MANIFEST_PATH) return json(response, 200, { ok: true, manifest: HUB_RELAY_MANIFEST });
        if (url.pathname === RELAY_ROOM_PATH) {
          const answer = HubRelayRooms.plainRequestAnswer(url);
          status = answer.status;
          return json(response, answer.status, answer.body);
        }
        if (RELAY_MAILBOX_PATHS.has(url.pathname)) {
          const mailboxId = url.searchParams.get("mailboxId");
          // Only the mailbox's owner makes the hub read a body.
          const refused = await relay.mailboxes.preauthorize(url.pathname, mailboxId, request.headers.authorization);
          if (refused) {
            status = refused.status;
            return json(response, refused.status, refused.body);
          }
          const append = request.method === "POST" && url.pathname === "/v1/mailbox/events";
          // Registration and revocation are a few bytes; nobody makes the
          // hub hold more for them.
          const tiny = url.pathname === "/v1/mailbox/register" || url.pathname === "/v1/mailbox/revoke";
          const limit = append ? RELAY_MAILBOX_APPEND_MAX_BYTES : tiny ? RELAY_MAILBOX_TINY_MAX_BYTES : RELAY_MAILBOX_SMALL_MAX_BYTES;
          const lengthHeader = request.headers["content-length"];
          const declared = lengthHeader === undefined ? undefined : Number(lengthHeader);
          if (declared !== undefined && (!Number.isFinite(declared) || declared > limit)) throw new HubRequestError(413, "The request is too large.");
          // A read has no body; a body of unstated length counts as the most it may be.
          const reserved = request.method === "GET" ? 0 : declared ?? limit;
          if (this.relayBodyBytes + reserved > RELAY_BODY_BYTES_IN_FLIGHT_MAX) throw new HubRequestError(503, "The hub is busy; try again.");
          this.relayBodyBytes += reserved;
          let body: Buffer;
          try {
            body = await readBody(request, limit);
          } finally {
            this.relayBodyBytes -= reserved;
          }
          const answer = await relay.mailboxes.handle(request.method ?? "GET", url.pathname, mailboxId, request.headers.authorization, body, url.searchParams, async () => {
            const header = request.headers[MAILBOX_HUB_AUTHORIZATION_HEADER];
            if (typeof header !== "string") return false;
            // Any device the User's server knows: her desktop (pairings),
            // her machines (their rooms with each other and the phone).
            const device = await this.authenticate(request.method ?? "POST", body, header, pathWithQuery).catch(() => undefined);
            return device?.role === "owner" || device?.role === "desktop" || device?.role === "machine";
          });
          status = answer.status;
          return json(response, answer.status, answer.body);
        }
      }
      const checked = await this.preauthenticate(request.headers.authorization);
      const large = (request.method === "POST" && url.pathname === "/v1/events") || (request.method === "PUT" && BLOB_PATH.test(url.pathname));
      const body = await readBody(request, large ? HUB_MAX_BODY_BYTES : HUB_MAX_SMALL_BODY_BYTES);
      const device = await this.authenticate(request.method ?? "GET", body, request.headers.authorization, pathWithQuery, checked);
      if (request.method === "POST" && url.pathname === "/v1/events") {
        const parsed = parseJson(body) as { events?: unknown };
        return json(response, 200, await this.options.log.push(device, parsed?.events));
      }
      if (request.method === "GET" && url.pathname === "/v1/events") {
        const after = Number(url.searchParams.get("after") ?? "0");
        const limit = Number(url.searchParams.get("limit") ?? "200");
        if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new HubRequestError(400, "Invalid position.");
        return json(response, 200, { ...await this.options.log.pull(device, after, limit), hubId: this.options.hubId });
      }
      const blob = BLOB_PATH.exec(url.pathname);
      if (blob) {
        const reference = blobReference(blob[1], url.searchParams);
        const index = Number(url.searchParams.get("index"));
        if (!reference || !Number.isSafeInteger(index) || index < 0 || index >= reference.fragments) throw new HubRequestError(400, "Invalid blob fragment.");
        if (request.method === "PUT") {
          await this.options.log.putBlobFragment(reference, index, body).catch((error: unknown) => {
            throw new HubRequestError(400, error instanceof Error ? error.message : String(error));
          });
          return json(response, 200, { ok: true });
        }
        if (request.method === "GET") {
          const bytes = await this.options.log.blobFragment(reference, index);
          if (!bytes) throw new HubRequestError(404, "The hub does not hold that fragment.");
          response.writeHead(200, { "content-type": "application/octet-stream", "content-length": bytes.length, "cache-control": "no-store" });
          response.end(bytes);
          return;
        }
      }
      if (request.method === "GET" && url.pathname === "/v1/search") {
        if (device.role === "machine") throw new HubRequestError(403, "Machines do not search the User's chats.");
        const cursor = url.searchParams.get("cursor") ?? undefined;
        const query = url.searchParams.get("q") ?? "";
        if (query.length > 1_000 || CONTROL_CHARACTER.test(query) || (cursor && (cursor.length > 4_096 || CONTROL_CHARACTER.test(cursor)))) {
          throw new HubRequestError(400, "Invalid search.");
        }
        return json(response, 200, await this.options.search.search({ requester: { kind: "user" }, query, ...(cursor ? { cursor } : {}) }));
      }
      if (request.method === "POST" && url.pathname === "/v1/push-subscription") {
        const parsed = parseJson(body) as { subscription?: { endpoint?: unknown } };
        const endpoint = parsed?.subscription?.endpoint;
        if (!isAllowedPushEndpoint(endpoint)) throw new HubRequestError(400, "That push endpoint is not accepted.");
        // Stored as the URL parser wrote it, never as sent.
        const normalized = new URL(endpoint).href;
        await this.options.storage.hub().savePushSubscription(device.deviceId, normalized, JSON.stringify({ ...parsed.subscription, endpoint: normalized }), new Date(this.now()).toISOString());
        return json(response, 200, { ok: true });
      }
      if (url.pathname === "/v1/roster") {
        if (device.role !== "owner") throw new HubRequestError(403, "Only the desktop that set up this hub changes its devices.");
        if (request.method === "GET") return json(response, 200, { devices: await this.options.storage.hub().devices() });
        if (request.method === "PUT") {
          const devices = validRoster(parseJson(body));
          await this.options.storage.hub().replaceRoster(devices, new Date(this.now()).toISOString());
          this.invalidateRoster();
          await this.disconnectRemoved();
          return json(response, 200, { devices: await this.options.storage.hub().devices() });
        }
      }
      throw new HubRequestError(404, "Not found.");
    } catch (error) {
      status = error instanceof HubRequestError ? error.status : 500;
      if (status === 500) this.options.debugLog?.("hub.request.error", { path: (request.url ?? "").split("?")[0], message: error instanceof Error ? error.message : String(error) });
      if (!response.headersSent) json(response, status, { ok: false, error: error instanceof Error && status !== 500 ? error.message : "The hub could not answer." });
    } finally {
      const ms = this.now() - started;
      if (status >= 500 || ms > SLOW_REQUEST_MS) this.options.debugLog?.("hub.request", { method: request.method, path: (request.url ?? "").split("?")[0], status, ms });
    }
  }

  private serveChallenge(pathname: string, response: ServerResponse): void {
    const token = pathname.slice("/.well-known/acme-challenge/".length);
    const file = path.join(this.options.acmeWebroot!, ".well-known", "acme-challenge", token);
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(token) || !existsSync(file)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(readFileSync(file));
  }
}

function sendJson(socket: LiveSocket, value: unknown): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(value));
}

function cors(response: ServerResponse): void {
  // Requests are authorized by their signature, never by cookies: any origin
  // may ask, as the phone's app does from its own site.
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-methods", "GET, POST, PUT, OPTIONS");
  response.setHeader("access-control-allow-headers", "authorization, content-type");
  response.setHeader("access-control-max-age", "600");
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { "content-type": "application/json", "content-length": body.length, "cache-control": "no-store" });
  response.end(body);
}

function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HubRequestError(413, "The request is too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function parseJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new HubRequestError(400, "The request body is not JSON.");
  }
}

function blobReference(blobHash: string, params: URLSearchParams): DeviceEventBlobReference | undefined {
  const reference = { type: "device.event.blob", blobHash, byteLength: Number(params.get("bytes")), fragments: Number(params.get("fragments")) };
  return isDeviceEventBlobReference(reference) ? reference : undefined;
}

function validRoster(value: unknown): HubDevice[] {
  const devices = (value as HubRosterRequest | undefined)?.devices;
  if (!Array.isArray(devices) || devices.length > 200) throw new HubRequestError(400, "Invalid roster.");
  return devices.map((device) => {
    if (!device || typeof device.publicKeyDerBase64 !== "string" || deviceIdForPublicKey(device.publicKeyDerBase64) !== device.deviceId ||
        !(HUB_ROSTER_ROLES as readonly string[]).includes(device.role) || typeof device.name !== "string" || device.name.length > 200 || CONTROL_CHARACTER.test(device.name) ||
        (device.machineId !== undefined && (typeof device.machineId !== "string" || device.machineId.length > 128))) {
      throw new HubRequestError(400, "Invalid roster entry.");
    }
    return { deviceId: device.deviceId, publicKeyDerBase64: device.publicKeyDerBase64, role: device.role, name: device.name, addedAt: "",
      ...(device.machineId ? { machineId: device.machineId } : {}) };
  });
}

/** Changes whenever either file does. The whole files: a renewed chain
 *  ends in the same intermediate certificate as the one before. */
export function certStamp(files: { cert: string; key: string }): string {
  try {
    return createHash("sha256").update(readFileSync(files.cert)).update(readFileSync(files.key)).digest("hex");
  } catch {
    return "";
  }
}

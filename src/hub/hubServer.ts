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
  HUB_PROGRESS_PATH,
  HUB_PROTOCOL_VERSION,
  HUB_ROOM_MAX_MESSAGE_BYTES,
  HUB_ROOM_REPLACED_CLOSE_CODE,
  HUB_ROSTER_ROLES,
  hubPhoneEnrollmentSigningText,
  hubPhoneInviteSigningText,
  HUB_PHONE_INVITE_MAX_LIFETIME_MS,
  hubRoomRole,
  isHubPhoneInviteId,
  isHubPhoneScope,
  type HubDevice,
  type HubHealth,
  type HubLiveHead,
  type HubLiveOps,
  type HubPhoneCertificate,
  type HubPhoneEnrollRequest,
  type HubPhoneEnrollResponse,
  type HubPhoneEnrollment,
  type HubPhoneInvite,
  type HubProgressPost,
  type HubReadReport,
  type HubResyncRequired,
  type HubRosterRequest,
  type HubRosterResponse
} from "../shared/hubProtocol";
import type { MachineProgressFrame } from "../shared/machineProgress";
import { HubNonceCache, deviceIdForPublicKey, parseHubAuthorization, sha256Hex, verifyHubRequest, verifyHubText, type ParsedHubAuthorization } from "../main/services/hubAuth";
import type { ChatSearchService } from "../main/services/chatSearch";
import type { StorageService } from "../main/services/storage";
import { HubRequestError, HubResyncRequiredError, type HubLog } from "./hubLog";
import { isAllowedPushEndpoint } from "./hubPush";
import { HUB_PHONE_PATHS, type HubPhoneApi } from "./hubPhone";
import { HubOpsRequestError, type HubOps } from "./hubOps";
import {
  HUB_ARTIFACT_PATH, HUB_ARTIFACTS_PATH, HUB_CARDS_PATH, HUB_CHAT_PATH, HUB_CHATS_PATH, HUB_FEED_PATH, HUB_MACHINE_SETTINGS_PATH, HUB_ME_PATH, HUB_OPS_PATH, HUB_TURNS_PATH,
  type HubCardsResponse, type HubFeedGone, type HubLiveSettings, type HubMachineSettings, type HubMachineSettingsPut, type HubMe, type HubTurnsResponse
} from "../shared/hubOps";

export interface HubServerOptions {
  hubId: string;
  version: string;
  storage: StorageService;
  log: HubLog;
  search: ChatSearchService;
  vapidPublicKey: string;
  /** Files Let's Encrypt validation reads over plain HTTP. */
  acmeWebroot?: string;
  /** The phone's reads: chat list, pages and changes from the server's copy. */
  phone?: HubPhoneApi;
  /** The owner published the composer catalog. */
  onCatalogChanged?: () => void;
  /** The owner's members' live progress (kept in memory, never stored). */
  onProgress?: (frames: MachineProgressFrame[]) => void;
  /** The chats as the server owns them: operations, the feed, chat pages. */
  ops?: HubOps;
  now?: () => number;
  debugLog?: (event: string, payload: Record<string, unknown>) => void;
}

const BLOB_PATH = /^\/v1\/blobs\/(sha256:[0-9a-f]{64})$/;
/** A pairing request is a key, a signature and a token. */
const ENROLL_MAX_BODY_BYTES = 16 * 1024;

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
/** Pages of the chat copy (/v1/snapshot?copy=1) built at the same time. */
const COPY_PAGES_IN_FLIGHT_MAX = 1;
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
/** How long a body a phone put up is kept before a message names it. */
const PHONE_UPLOAD_PIN_MS = 30 * 24 * 60 * 60_000;
const UPLOAD_PIN_MS = 24 * 60 * 60_000;

/** Pairing attempts per address, and from everywhere, in a minute. */
const ENROLL_ATTEMPTS_PER_ADDRESS = 10;
const ENROLL_ATTEMPTS_ALL = 600;

/** What the hub answers a signed request from a device not on its roster. */
export const HUB_NOT_ON_ROSTER = "This device is not on the hub's roster.";

export class HubServer {
  private readonly nonces = new HubNonceCache();
  /** Pages of the chat copy being built now. */
  private copyPagesInFlight = 0;
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
    options.ops?.onApplied(({ entry }) => this.broadcastOps(entry.seq));
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

  /**
   * Stops listening and closes every connection now: a phone's long wait
   * for news, a keep-alive connection, a live socket. A request waiting on
   * one of them would otherwise keep the program running long after a stop
   * (the service manager then waits for its kill timeout).
   */
  async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    for (const socket of this.live.keys()) socket.terminate();
    this.live.clear();
    for (const members of this.rooms.values()) for (const member of members.values()) member.socket.terminate();
    this.rooms.clear();
    const closed = Promise.all(this.servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    for (const server of this.servers) (server as Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    await closed;
    this.servers = [];
  }

  /** The chats as the server owns them (agreements Д1–Д3): any device on the
   *  roster writes operations and reads the feed and chat pages. */
  private async handleOps(request: IncomingMessage, response: ServerResponse, url: URL, device: HubDevice, body: Buffer): Promise<number> {
    const ops = this.options.ops as HubOps;
    if (request.method === "POST" && url.pathname === HUB_OPS_PATH) {
      json(response, 200, await ops.apply(device, parseJson(body)));
      return 200;
    }
    if (request.method === "GET" && url.pathname === HUB_FEED_PATH) {
      const after = Number(url.searchParams.get("after") ?? "0");
      const waitMs = Number(url.searchParams.get("waitMs") ?? "0");
      if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(waitMs) || waitMs < 0) throw new HubRequestError(400, "Invalid position.");
      const closed = new Promise<void>((resolve) => { request.once("close", () => resolve()); response.once("close", () => resolve()); });
      const answer = await ops.feed(after, waitMs, closed, device.deviceId);
      if ("gone" in answer) {
        this.options.debugLog?.("hub.feed.gone", { deviceId: device.deviceId, after, head: answer.head });
        json(response, 410, { ok: false, error: "The server no longer holds what comes after this place; read the chats again.", gone: true, head: answer.head } satisfies HubFeedGone);
        return 410;
      }
      json(response, 200, answer);
      return 200;
    }
    if (request.method === "GET" && url.pathname === HUB_CHATS_PATH) {
      json(response, 200, await ops.chats());
      return 200;
    }
    if (request.method === "GET" && url.pathname === HUB_CARDS_PATH) {
      const conversationId = url.searchParams.get("conversationId") ?? undefined;
      json(response, 200, { cards: await ops.openCards(conversationId || undefined), head: await ops.head() } satisfies HubCardsResponse);
      return 200;
    }
    if (request.method === "GET" && url.pathname === HUB_TURNS_PATH) {
      json(response, 200, { turns: await ops.waitingTurns(device), claimed: await ops.claimedTurns(device), head: await ops.head() } satisfies HubTurnsResponse);
      return 200;
    }
    if (request.method === "GET" && url.pathname === HUB_CHAT_PATH) {
      json(response, 200, await ops.chatPage(url.searchParams.get("conversationId") ?? "", url.searchParams.get("before") ?? undefined));
      return 200;
    }
    // Documents, as the server owns them (Д9): a chat's (without revision
    // bodies), one whole, or one revision's body.
    if (request.method === "GET" && url.pathname === HUB_ARTIFACTS_PATH) {
      json(response, 200, await ops.artifactStates(url.searchParams.get("conversationId") ?? ""));
      return 200;
    }
    if (request.method === "GET" && url.pathname === HUB_ARTIFACT_PATH) {
      const artifactId = url.searchParams.get("artifactId") ?? "";
      const revision = url.searchParams.get("revision");
      json(response, 200, revision ? await ops.artifactRevision(artifactId, revision) : await ops.artifactState(artifactId));
      return 200;
    }
    throw new HubRequestError(404, "Not found.");
  }

  /**
   * A machine's settings, sealed for it by the computer that set it up: the
   * owner puts them, the machine reads its own (by the machine id the roster
   * gives it). The server keeps the sealed text and never opens it; a put is
   * told to the machine at once on its live socket.
   */
  private async handleMachineSettings(request: IncomingMessage, response: ServerResponse, url: URL, device: HubDevice, body: Buffer): Promise<number> {
    const hub = this.options.storage.hub();
    if (request.method === "PUT") {
      if (device.role !== "owner") throw new HubRequestError(403, "Only the desktop that set up this hub publishes a machine's settings.");
      const parsed = parseJson(body) as Partial<HubMachineSettingsPut> | undefined;
      if (!parsed || typeof parsed.machineId !== "string" || !MACHINE_ID.test(parsed.machineId) ||
          typeof parsed.sealed !== "string" || parsed.sealed.length === 0 || parsed.sealed.length > HUB_MAX_BODY_BYTES) {
        throw new HubRequestError(400, "Invalid machine settings.");
      }
      const updatedAt = new Date(this.now()).toISOString();
      await hub.setDocument(machineSettingsKey(parsed.machineId), { sealed: parsed.sealed, updatedAt }, updatedAt);
      this.tellMachine(parsed.machineId, { type: "settings" } satisfies HubLiveSettings);
      this.options.debugLog?.("hub.machine-settings.published", { machineId: parsed.machineId, bytes: parsed.sealed.length });
      json(response, 200, { ok: true, updatedAt });
      return 200;
    }
    if (request.method === "GET") {
      if (device.role !== "machine" || !device.machineId) throw new HubRequestError(403, "Only a machine reads its settings, and only its own.");
      const stored = (await hub.document(machineSettingsKey(device.machineId)))?.value as { sealed?: unknown; updatedAt?: unknown } | undefined;
      const sealed = typeof stored?.sealed === "string" ? stored.sealed : undefined;
      const updatedAt = typeof stored?.updatedAt === "string" ? stored.updatedAt : undefined;
      const since = url.searchParams.get("since") ?? undefined;
      if (sealed && updatedAt && since && updatedAt <= since) {
        json(response, 200, { updatedAt, unchanged: true } satisfies HubMachineSettings);
        return 200;
      }
      json(response, 200, (sealed && updatedAt ? { sealed, updatedAt } : {}) satisfies HubMachineSettings);
      return 200;
    }
    throw new HubRequestError(404, "Not found.");
  }

  /** A live word to the devices of one machine (its settings changed). */
  private tellMachine(machineId: string, frame: HubLiveSettings): void {
    void this.options.storage.hub().devices().then((devices) => {
      const ids = new Set(devices.filter((item) => item.role === "machine" && item.machineId === machineId).map((item) => item.deviceId));
      const text = JSON.stringify(frame);
      for (const [socket, deviceId] of this.live) {
        if (ids.has(deviceId) && socket.readyState === socket.OPEN) socket.send(text);
      }
    }).catch(() => undefined);
  }

  private broadcastOps(head: number): void {
    const frame = JSON.stringify({ type: "ops", head } satisfies HubLiveOps);
    for (const socket of this.live.keys()) {
      if (socket.readyState === socket.OPEN) socket.send(frame);
    }
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
    // Said apart: a phone taken off the roster asks to be paired again, one
    // whose clock is off does not.
    if (!device) throw new HubRequestError(401, HUB_NOT_ON_ROSTER);
    if (Math.abs(this.now() - auth.timestampMs) > HUB_AUTH_MAX_SKEW_MS) throw new HubRequestError(401, "The request's clock is more than five minutes off.");
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
        void this.options.ops?.head().then((value) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "ops", head: value } satisfies HubLiveOps));
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
      // Also when it took the seat of an older connection of its own: the
      // others learn it came back (a restart, a new link), and greet it again.
      for (const other of others) sendJson(other.socket, { type: "peer-connected", peer: { deviceId: device.deviceId, role } });
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
    let failure: string | undefined;
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
      if (request.method === "POST" && url.pathname === "/v1/phone/enroll") {
        // Unsigned: the phone is not on the roster yet. Its body proves the
        // key it enrolls, and the invite's token proves the owner sent it.
        this.limitEnrollments(request.socket.remoteAddress ?? "");
        const body = await readBody(request, ENROLL_MAX_BODY_BYTES);
        return json(response, 200, await this.enroll(parseJson(body)));
      }
      // A phone app from before (a mailbox token) is told it was removed, so
      // it asks to be paired again instead of going quiet.
      if (this.options.phone && HUB_PHONE_PATHS.has(url.pathname) && /^Bearer /i.test(request.headers.authorization ?? "")) {
        status = 401;
        return json(response, 401, { ok: false, error: "phone_revoked" });
      }
      const checked = await this.preauthenticate(request.headers.authorization);
      const large = (request.method === "POST" && (url.pathname === "/v1/events" || url.pathname === HUB_OPS_PATH)) || (request.method === "PUT" && BLOB_PATH.test(url.pathname)) ||
        (request.method === "PUT" && url.pathname === "/v1/catalog") || (request.method === "POST" && url.pathname === HUB_PROGRESS_PATH) ||
        // A machine's settings carry the User's skills and environment.
        (request.method === "PUT" && url.pathname === HUB_MACHINE_SETTINGS_PATH);
      const body = await readBody(request, large ? HUB_MAX_BODY_BYTES : HUB_MAX_SMALL_BODY_BYTES);
      const device = await this.authenticate(request.method ?? "GET", body, request.headers.authorization, pathWithQuery, checked);
      if (this.options.phone && HUB_PHONE_PATHS.has(url.pathname)) {
        // Only a phone reads the phone's views, as what its invite allowed.
        if (device.role !== "phone") throw new HubRequestError(403, "Only a phone reads this.");
        status = await this.options.phone.handle(request, response, url, device, body);
        return;
      }
      if (request.method === "GET" && url.pathname === HUB_ME_PATH) {
        return json(response, 200, {
          deviceId: device.deviceId, role: device.role, name: device.name, ...(device.machineId ? { machineId: device.machineId } : {})
        } satisfies HubMe);
      }
      if (url.pathname === HUB_MACHINE_SETTINGS_PATH) {
        status = await this.handleMachineSettings(request, response, url, device, body);
        return;
      }
      if (this.options.ops && url.pathname.startsWith("/v3/")) {
        status = await this.handleOps(request, response, url, device, body);
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/events") {
        const parsed = parseJson(body) as { events?: unknown; anchor?: unknown };
        const anchor = parsed?.anchor;
        if (anchor !== undefined && (!Array.isArray(anchor) || anchor.length > 200 ||
            !anchor.every((scope) => typeof scope === "string" && scope.length > 0 && scope.length <= 512 && !CONTROL_CHARACTER.test(scope)))) {
          throw new HubRequestError(400, "Invalid anchor.");
        }
        return json(response, 200, await this.options.log.push(device, parsed?.events, anchor as string[] | undefined));
      }
      if (request.method === "GET" && url.pathname === "/v1/events") {
        const after = Number(url.searchParams.get("after") ?? "0");
        const limit = Number(url.searchParams.get("limit") ?? "200");
        if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new HubRequestError(400, "Invalid position.");
        const report = readReport(url.searchParams);
        try {
          return json(response, 200, { ...await this.options.log.pull(device, after, limit, report), hubId: this.options.hubId });
        } catch (error) {
          if (!(error instanceof HubResyncRequiredError)) throw error;
          status = 410;
          this.options.debugLog?.("hub.resync.required", { deviceId: device.deviceId, after, prunedThrough: error.prunedThrough });
          return json(response, 410, { ok: false, error: error.message, resync: true, prunedThrough: error.prunedThrough, hubId: this.options.hubId } satisfies HubResyncRequired & { hubId: string });
        }
      }
      if (request.method === "GET" && url.pathname === "/v1/chain") {
        if (device.role === "phone") throw new HubRequestError(403, "A phone reads the server's copy, not the order.");
        const origin = url.searchParams.get("origin") ?? "";
        const scope = url.searchParams.get("scope") ?? "";
        const from = Number(url.searchParams.get("from"));
        const to = Number(url.searchParams.get("to"));
        if (!origin || !scope || origin.length > 512 || scope.length > 512 || CONTROL_CHARACTER.test(origin) || CONTROL_CHARACTER.test(scope) ||
            !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from) throw new HubRequestError(400, "Invalid chain range.");
        return json(response, 200, await this.options.log.chain(origin, scope, from, to));
      }
      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        if (device.role === "phone") throw new HubRequestError(403, "A phone reads the server's copy, not the order.");
        const page = url.searchParams.get("page") ?? undefined;
        const scopes = (url.searchParams.get("scopes") ?? "").split(",").filter(Boolean);
        const atMostText = url.searchParams.get("atMost");
        const atMost = atMostText === null ? undefined : Number(atMostText);
        const sinceText = url.searchParams.get("since");
        const since = sinceText === null ? undefined : Number(sinceText);
        if (since !== undefined && (!Number.isSafeInteger(since) || since < 0)) throw new HubRequestError(400, "Invalid snapshot request.");
        if ((page && (page.length > 2048 || CONTROL_CHARACTER.test(page))) || scopes.length > 200 ||
            scopes.some((scope) => scope.length > 512 || CONTROL_CHARACTER.test(scope)) ||
            (atMost !== undefined && (!Number.isSafeInteger(atMost) || atMost < 0))) throw new HubRequestError(400, "Invalid snapshot request.");
        const chat = url.searchParams.get("chat") ?? undefined;
        if (chat !== undefined && (!chat || chat.length > 256 || CONTROL_CHARACTER.test(chat))) throw new HubRequestError(400, "Invalid snapshot request.");
        const copy = url.searchParams.get("copy") === "1";
        // A page of the copy costs the small server about a hundred MB while
        // it is built: one at a time, the others asked to come back.
        if (copy && this.copyPagesInFlight >= COPY_PAGES_IN_FLIGHT_MAX) throw new HubRequestError(503, "The hub is busy; try again.");
        if (copy) this.copyPagesInFlight += 1;
        let snapshot;
        try {
          snapshot = await this.options.log.snapshot(device, {
            ...(page ? { page } : {}), scopes, ...(atMost !== undefined ? { atMost } : {}), ...(since !== undefined ? { since } : {}), copy, ...(chat ? { chat } : {})
          });
        } finally {
          if (copy) this.copyPagesInFlight -= 1;
        }
        if (!page) this.options.debugLog?.("hub.snapshot.started", { deviceId: device.deviceId, hubSeq: snapshot.hubSeq, copy: url.searchParams.get("copy") === "1", ...(chat ? { chat } : {}) });
        return json(response, 200, { ...snapshot, hubId: this.options.hubId });
      }
      if (request.method === "GET" && url.pathname === "/v1/devices/known") {
        const ids = (url.searchParams.get("ids") ?? "").split(",").filter(Boolean);
        if (ids.length > 200 || ids.some((id) => id.length > 128 || CONTROL_CHARACTER.test(id))) throw new HubRequestError(400, "Invalid devices.");
        return json(response, 200, await this.options.log.known(ids));
      }
      if (request.method === "GET" && url.pathname === "/v1/readers") {
        if (device.role !== "owner") throw new HubRequestError(403, "Only the desktop that set up this hub reads where its devices stand.");
        return json(response, 200, await this.options.log.readers());
      }
      const blob = BLOB_PATH.exec(url.pathname);
      if (blob) {
        const reference = blobReference(blob[1], url.searchParams);
        const index = Number(url.searchParams.get("index"));
        if (!reference || !Number.isSafeInteger(index) || index < 0 || index >= reference.fragments) throw new HubRequestError(400, "Invalid blob fragment.");
        if (request.method === "PUT") {
          // A body is put up before what names it reaches the server: a
          // phone's picture (it may be offline in between) is kept a month
          // for it, anyone else's (a catalog's avatar, an event's body) a day.
          await this.options.storage.deviceEventBlobs().pin([reference.blobHash], device.role === "phone" ? "phone-upload" : "upload",
            this.now() + (device.role === "phone" ? PHONE_UPLOAD_PIN_MS : UPLOAD_PIN_MS));
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
        const hub = this.options.storage.hub();
        await hub.savePushSubscription(device.deviceId, normalized, JSON.stringify({ ...parsed.subscription, endpoint: normalized }), new Date(this.now()).toISOString());
        // One endpoint is one browser: a phone paired again under a new key
        // is rung once, as itself, not again for the key it had before.
        for (const other of (await hub.pushSubscriptions()).filter((item) => item.endpoint === normalized && item.deviceId !== device.deviceId)) {
          await hub.deletePushSubscription(other.deviceId, other.endpoint);
        }
        return json(response, 200, { ok: true });
      }
      if (url.pathname === "/v1/roster") {
        if (device.role !== "owner") throw new HubRequestError(403, "Only the desktop that set up this hub changes its devices.");
        // With what each phone enrolled: the owner learns a phone that paired
        // while it was away from here, and names it from then on.
        if (request.method === "GET") {
          return json(response, 200, {
            devices: await this.options.storage.hub().devices(),
            enrollments: await this.options.storage.hub().phoneEnrollments()
          } satisfies HubRosterResponse);
        }
        if (request.method === "PUT") {
          const parsed = parseJson(body);
          const devices = validRoster(parsed);
          const resolved = validInviteIds((parsed as HubRosterRequest | undefined)?.resolvedInviteIds);
          await this.options.storage.hub().replaceRoster(devices, new Date(this.now()).toISOString(), resolved);
          this.invalidateRoster();
          await this.disconnectRemoved();
          return json(response, 200, { devices: await this.options.storage.hub().devices() });
        }
      }
      if (url.pathname === "/v1/phone-invites" && request.method === "PUT") {
        if (device.role !== "owner") throw new HubRequestError(403, "Only the desktop that set up this hub invites phones.");
        const parsed = parseJson(body) as { invite?: HubPhoneInvite; signature?: unknown };
        const invite = this.validInvite(parsed?.invite, device);
        if (typeof parsed?.signature !== "string" || !verifyHubText(device.publicKeyDerBase64, hubPhoneInviteSigningText(invite), parsed.signature)) {
          throw new HubRequestError(400, "The invite's signature does not verify.");
        }
        await this.options.storage.hub().savePhoneInvite(invite, parsed.signature, new Date(this.now()).toISOString());
        return json(response, 200, { ok: true, inviteId: invite.inviteId });
      }
      if (url.pathname === "/v1/catalog" && request.method === "PUT") {
        if (device.role !== "owner") throw new HubRequestError(403, "Only the desktop that set up this hub publishes its catalog.");
        const parsed = parseJson(body) as { catalog?: unknown };
        if (!parsed?.catalog || typeof parsed.catalog !== "object") throw new HubRequestError(400, "Invalid catalog.");
        await this.options.storage.hub().setDocument("composer-catalog", parsed.catalog, new Date(this.now()).toISOString());
        // The avatars it names stay on the server while it names them.
        const avatars = Object.values((parsed.catalog as { avatars?: Record<string, { blob?: unknown }> }).avatars ?? {})
          .map((entry) => entry?.blob).filter(isDeviceEventBlobReference).map((blob) => blob.blobHash);
        await this.options.storage.deviceEventBlobs().pinOnly(avatars, "catalog");
        this.options.onCatalogChanged?.();
        return json(response, 200, { ok: true });
      }
      if (url.pathname === "/v1/machine-wake" && request.method === "PUT") {
        if (device.role !== "owner") throw new HubRequestError(403, "Only the desktop that set up this hub gives it start keys.");
        const entries = validMachineWake(parseJson(body));
        await this.options.storage.hub().replaceMachineWake(entries.map((entry) => ({ machineId: entry.machineId, configJson: JSON.stringify(entry) })), new Date(this.now()).toISOString());
        return json(response, 200, { ok: true, machines: entries.length });
      }
      if (url.pathname === HUB_PROGRESS_PATH && request.method === "POST") {
        // Members run on the computer and on machines; a phone runs nothing.
        if (device.role === "phone") throw new HubRequestError(403, "Only a device that runs members posts their progress.");
        const frames = (parseJson(body) as Partial<HubProgressPost> | undefined)?.frames;
        if (!Array.isArray(frames) || frames.length > 100) throw new HubRequestError(400, "Invalid progress.");
        this.options.onProgress?.(frames);
        return json(response, 200, { ok: true });
      }
      throw new HubRequestError(404, "Not found.");
    } catch (error) {
      status = error instanceof HubRequestError || error instanceof HubOpsRequestError ? error.status : 500;
      if (status !== 500 && error instanceof Error) failure = error.message;
      if (status === 500) this.options.debugLog?.("hub.request.error", { path: (request.url ?? "").split("?")[0], message: error instanceof Error ? error.message : String(error) });
      if (!response.headersSent) json(response, status, { ok: false, error: error instanceof Error && status !== 500 ? error.message : "The hub could not answer." });
    } finally {
      const ms = this.now() - started;
      const path = (request.url ?? "").split("?")[0];
      // A phone's wait for news is long on purpose.
      // Every refusal is logged with its reason, not only failures of the
      // server's own (agreement Д12): a device that cannot write is visible.
      if (status >= 500 || (status >= 400 && path.startsWith("/v3/")) ||
          (ms > SLOW_REQUEST_MS && path !== "/v1/phone/changes" && path !== HUB_FEED_PATH)) {
        this.options.debugLog?.("hub.request", { method: request.method, path, status, ms, ...(failure ? { reason: failure } : {}) });
      }
    }
  }

  /** Enrollment attempts per address in the last minute, and all together:
   *  nobody can make the hub check tokens without end. */
  private readonly enrollAttempts = new Map<string, number[]>();
  private enrollQueue: Promise<unknown> = Promise.resolve();

  private limitEnrollments(address: string): void {
    const now = this.now();
    const recent = (this.enrollAttempts.get(address) ?? []).filter((at) => now - at < 60_000);
    const all = [...this.enrollAttempts.values()].reduce((count, list) => count + list.filter((at) => now - at < 60_000).length, 0);
    // Per address against guessing (a code is 256 bits: nobody guesses it);
    // all together only against load, high enough that strangers cannot
    // keep the User's own phone from pairing.
    if (recent.length >= ENROLL_ATTEMPTS_PER_ADDRESS || all >= ENROLL_ATTEMPTS_ALL) throw new HubRequestError(429, "Too many pairing attempts; try again in a minute.");
    recent.push(now);
    this.enrollAttempts.set(address, recent);
    if (this.enrollAttempts.size > 1_000) {
      for (const [key, list] of this.enrollAttempts) if (!list.some((at) => now - at < 60_000)) this.enrollAttempts.delete(key);
    }
  }

  private validInvite(value: unknown, owner: HubDevice): HubPhoneInvite {
    const invite = value as Partial<HubPhoneInvite> | undefined;
    const now = this.now();
    const expiresAt = Date.parse(invite?.expiresAt ?? "");
    const issuedAt = Date.parse(invite?.issuedAt ?? "");
    if (!invite || invite.version !== 1 || !isHubPhoneInviteId(invite.inviteId) ||
        invite.hubId !== this.options.hubId || invite.issuerDeviceId !== owner.deviceId ||
        typeof invite.tokenHash !== "string" || !/^[0-9a-f]{64}$/.test(invite.tokenHash) ||
        // Every chat: the order has no per-chat fences for a phone's writes.
        !isHubPhoneScope(invite.scope) || invite.scope.scope !== "device" ||
        typeof invite.name !== "string" || invite.name.length > 200 || CONTROL_CHARACTER.test(invite.name) ||
        !Number.isFinite(expiresAt) || !Number.isFinite(issuedAt) || expiresAt <= now || expiresAt - now > HUB_PHONE_INVITE_MAX_LIFETIME_MS) {
      throw new HubRequestError(400, "Invalid invite.");
    }
    return {
      version: 1, inviteId: invite.inviteId, hubId: invite.hubId, issuerDeviceId: invite.issuerDeviceId, tokenHash: invite.tokenHash,
      scope: invite.scope, name: invite.name, issuedAt: invite.issuedAt!, expiresAt: invite.expiresAt!
    };
  }

  /** A phone shows an invite's token and signs its acceptance with its key:
   *  it is on the roster from then on, as the invite said. One at a time, so
   *  a token is spent once. */
  private enroll(value: unknown): Promise<HubPhoneEnrollResponse> {
    const run = this.enrollQueue.then(() => this.enrollNow(value));
    this.enrollQueue = run.catch(() => undefined);
    return run;
  }

  private async enrollNow(value: unknown): Promise<HubPhoneEnrollResponse> {
    const request = value as Partial<HubPhoneEnrollRequest> | undefined;
    const enrollment = request?.enrollment as Partial<HubPhoneEnrollment> | undefined;
    const refused = (message: string) => new HubRequestError(400, message);
    if (!request || typeof request.token !== "string" || !/^[A-Za-z0-9_-]{20,200}$/.test(request.token) || typeof request.signature !== "string" ||
        !enrollment || enrollment.version !== 1 || enrollment.hubId !== this.options.hubId || typeof enrollment.publicKeyDerBase64 !== "string" ||
        enrollment.publicKeyDerBase64.length > 200 || typeof enrollment.deviceId !== "string" || deviceIdForPublicKey(enrollment.publicKeyDerBase64) !== enrollment.deviceId ||
        typeof enrollment.name !== "string" || enrollment.name.length > 100 || CONTROL_CHARACTER.test(enrollment.name) ||
        typeof enrollment.enrolledAt !== "string" || !Number.isFinite(Date.parse(enrollment.enrolledAt))) {
      throw refused("Invalid pairing request.");
    }
    const tokenHash = sha256Hex(request.token);
    if (enrollment.tokenHash !== tokenHash) throw refused("Invalid pairing request.");
    const accepted: HubPhoneEnrollment = {
      version: 1, hubId: enrollment.hubId, tokenHash, deviceId: enrollment.deviceId, publicKeyDerBase64: enrollment.publicKeyDerBase64,
      name: enrollment.name, enrolledAt: enrollment.enrolledAt
    };
    if (!verifyHubText(accepted.publicKeyDerBase64, hubPhoneEnrollmentSigningText(accepted), request.signature)) throw refused("The pairing request's signature does not verify.");
    const hub = this.options.storage.hub();
    const stored = await hub.phoneInviteByTokenHash(tokenHash);
    const gone = new HubRequestError(410, "This pairing code was already used or has expired. Make a new one on your Mac.");
    if (!stored || stored.cancelledAt) throw gone;
    const answer = (enrollmentJson: string, enrollmentSignature: string): HubPhoneEnrollResponse => {
      const kept = JSON.parse(enrollmentJson) as HubPhoneEnrollment;
      const certificate: HubPhoneCertificate = {
        invite: stored.invite, inviteSignature: stored.signature, enrollment: kept, enrollmentSignature, token: request.token!
      };
      return { ok: true, hubId: this.options.hubId, deviceId: kept.deviceId, scope: stored.invite.scope, certificate, protocol: HUB_PROTOCOL_VERSION };
    };
    if (stored.usedAt) {
      // The same phone asking again (its answer was lost on the way) is told
      // again; anyone else is refused.
      if (stored.deviceId === accepted.deviceId && stored.enrollment) return answer(stored.enrollment.json, stored.enrollment.signature);
      throw gone;
    }
    const now = new Date(this.now()).toISOString();
    if (Date.parse(stored.invite.expiresAt) <= this.now()) throw gone;
    // Checked as every device checks the certificate later: a phone whose
    // clock is far off is told now, not admitted here and refused elsewhere.
    const enrolledAt = Date.parse(accepted.enrolledAt);
    if (enrolledAt > Date.parse(stored.invite.expiresAt) + HUB_AUTH_MAX_SKEW_MS || enrolledAt < Date.parse(stored.invite.issuedAt) - HUB_AUTH_MAX_SKEW_MS ||
        Math.abs(enrolledAt - this.now()) > HUB_AUTH_MAX_SKEW_MS) {
      throw refused("This phone's clock is off. Set it to update automatically, then scan the code again.");
    }
    const enrollmentJson = JSON.stringify(accepted);
    const taken = await hub.enrollPhone(stored.invite.inviteId, {
      deviceId: accepted.deviceId, publicKeyDerBase64: accepted.publicKeyDerBase64, role: "phone", name: accepted.name || stored.invite.name,
      addedAt: now, scope: stored.invite.scope
    }, { json: enrollmentJson, signature: request.signature }, now);
    if (!taken) throw gone;
    this.invalidateRoster();
    this.options.debugLog?.("hub.phone.enrolled", { deviceId: accepted.deviceId, inviteId: stored.invite.inviteId });
    return answer(enrollmentJson, request.signature);
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

/** What a device says it holds on a read (absent: a device that does not
 *  report, which is read as before and never told to start again). */
function readReport(params: URLSearchParams): (HubReadReport & { peek?: boolean }) | undefined {
  if (!params.has("held")) return undefined;
  const held = Number(params.get("held"));
  const heldSince = Number(params.get("heldSince") ?? "0");
  const heldCount = Number(params.get("heldCount") ?? "0");
  // heldSince is a time: no later than any date can be.
  if (![held, heldSince, heldCount].every((value) => Number.isSafeInteger(value) && value >= 0) || heldSince > MAX_DATE_MS) throw new HubRequestError(400, "Invalid read report.");
  const gaveUp = params.has("gaveUp") ? Number(params.get("gaveUp")) : undefined;
  const gaveUpAt = params.has("gaveUpAt") ? Number(params.get("gaveUpAt")) : undefined;
  if (gaveUp !== undefined && (!Number.isSafeInteger(gaveUp) || gaveUp < 1 || !Number.isSafeInteger(gaveUpAt) || (gaveUpAt as number) < 1 || (gaveUpAt as number) > MAX_DATE_MS)) {
    throw new HubRequestError(400, "Invalid read report.");
  }
  return { held, heldSince, heldCount, ...(gaveUp !== undefined ? { gaveUp, gaveUpAt } : {}), ...(params.get("peek") === "1" ? { peek: true } : {}) };
}

const RENDEZVOUS_ID = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_DATE_MS = 8_640_000_000_000_000;
const MACHINE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function machineSettingsKey(machineId: string): string {
  return `machine-settings:${machineId}`;
}

function validRoster(value: unknown): HubDevice[] {
  const devices = (value as HubRosterRequest | undefined)?.devices;
  if (!Array.isArray(devices) || devices.length > 200) throw new HubRequestError(400, "Invalid roster.");
  return devices.map((device) => {
    if (!device || typeof device.publicKeyDerBase64 !== "string" || deviceIdForPublicKey(device.publicKeyDerBase64) !== device.deviceId ||
        !(HUB_ROSTER_ROLES as readonly string[]).includes(device.role) || typeof device.name !== "string" || device.name.length > 200 || CONTROL_CHARACTER.test(device.name) ||
        (device.machineId !== undefined && (typeof device.machineId !== "string" || device.machineId.length > 128)) ||
        (device.rendezvousId !== undefined && (typeof device.rendezvousId !== "string" || !RENDEZVOUS_ID.test(device.rendezvousId)))) {
      throw new HubRequestError(400, "Invalid roster entry.");
    }
    // A phone is on the roster for every chat (see validInvite).
    if ((device.scope !== undefined && (device.role !== "phone" || !isHubPhoneScope(device.scope) || device.scope.scope !== "device")) ||
        (device.inviteId !== undefined && !isHubPhoneInviteId(device.inviteId))) {
      throw new HubRequestError(400, "Invalid roster entry.");
    }
    return { deviceId: device.deviceId, publicKeyDerBase64: device.publicKeyDerBase64, role: device.role, name: device.name, addedAt: "",
      ...(device.machineId ? { machineId: device.machineId } : {}),
      ...(device.scope ? { scope: device.scope } : {}),
      ...(device.inviteId ? { inviteId: device.inviteId } : {}),
      ...(device.role === "machine" && device.reader === true ? { reader: true } : {}),
      ...(device.role === "machine" && device.rendezvousId ? { rendezvousId: device.rendezvousId } : {}) };
  });
}

function validInviteIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 1_000 || !value.every(isHubPhoneInviteId)) {
    throw new HubRequestError(400, "Invalid settled invites.");
  }
  return value as string[];
}

function validMachineWake(value: unknown): import("../shared/hubProtocol").HubMachineWakeRequest["machines"] {
  const machines = (value as { machines?: unknown } | undefined)?.machines;
  const text = (item: unknown, pattern: RegExp) => typeof item === "string" && pattern.test(item);
  if (!Array.isArray(machines) || machines.length > 50) throw new HubRequestError(400, "Invalid start keys.");
  return machines.map((entry) => {
    const machine = entry as { machineId?: unknown; instanceId?: unknown; region?: unknown; credentials?: { accessKeyId?: unknown; secretAccessKey?: unknown; region?: unknown } };
    if (!text(machine?.machineId, /^[A-Za-z0-9._:-]{1,128}$/) || !text(machine.instanceId, /^i-[0-9a-f]{8,32}$/) || !text(machine.region, /^[a-z]{2}(-[a-z]+)+-\d$/) ||
        !text(machine.credentials?.accessKeyId, /^[A-Z0-9]{16,128}$/) || !text(machine.credentials?.secretAccessKey, /^[A-Za-z0-9/+=]{20,128}$/) || machine.credentials?.region !== machine.region) {
      throw new HubRequestError(400, "Invalid start key.");
    }
    return {
      machineId: machine.machineId as string, instanceId: machine.instanceId as string, region: machine.region as string,
      credentials: { accessKeyId: machine.credentials!.accessKeyId as string, secretAccessKey: machine.credentials!.secretAccessKey as string, region: machine.region as string }
    };
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

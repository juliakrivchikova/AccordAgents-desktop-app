import { existsSync, readFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import path from "node:path";
import type { Duplex } from "node:stream";
import { isDeviceEventBlobReference, type DeviceEventBlobReference } from "../shared/deviceEventBlobs";
import {
  HUB_MAX_BODY_BYTES,
  HUB_PROTOCOL_VERSION,
  type HubDevice,
  type HubHealth,
  type HubLiveHead,
  type HubRosterRequest
} from "../shared/hubProtocol";
import { HubNonceCache, deviceIdForPublicKey, parseHubAuthorization, verifyHubRequest } from "../main/services/hubAuth";
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
  now?: () => number;
  debugLog?: (event: string, payload: Record<string, unknown>) => void;
}

const BLOB_PATH = /^\/v1\/blobs\/(sha256:[0-9a-f]{64})$/;

/** The little of `ws` the live socket uses (the package ships no types here). */
interface LiveSocket {
  readonly readyState: number;
  readonly OPEN: number;
  send(data: string): void;
  terminate(): void;
  on(event: "close" | "error", listener: () => void): void;
}
interface LiveSocketServer {
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, done: (socket: LiveSocket) => void): void;
}
const { WebSocketServer } = require("ws") as { WebSocketServer: new (options: { noServer: true; maxPayload: number }) => LiveSocketServer };

/**
 * The hub's HTTP surface. Every route but the health check and the VAPID key
 * is signed by a device on the roster; the live socket only says where the
 * order's head is, and devices read the rest over HTTP.
 */
export class HubServer {
  private readonly nonces = new HubNonceCache();
  private readonly live = new Set<LiveSocket>();
  private readonly sockets: LiveSocketServer = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  private servers: Server[] = [];
  private roster?: Promise<Map<string, HubDevice>>;
  private readonly now: () => number;

  constructor(private readonly options: HubServerOptions) {
    this.now = options.now ?? Date.now;
    options.log.onAppended((head) => this.broadcastHead(head));
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
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        this.servers.push(server);
        resolve(server);
      });
    });
  }

  async close(): Promise<void> {
    for (const socket of this.live) socket.terminate();
    this.live.clear();
    await Promise.all(this.servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    this.servers = [];
  }

  private broadcastHead(head: number): void {
    const frame = JSON.stringify({ type: "head", head } satisfies HubLiveHead);
    for (const socket of this.live) {
      if (socket.readyState === socket.OPEN) socket.send(frame);
    }
  }

  private async authenticate(method: string, body: Buffer, header: string | undefined, pathWithQuery: string): Promise<HubDevice> {
    const auth = parseHubAuthorization(header);
    if (!auth) throw new HubRequestError(401, "The request is not signed.");
    const device = await this.device(auth.deviceId);
    const now = this.now();
    if (!device || !verifyHubRequest(auth, {
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
      if (url.pathname !== "/v1/live") throw new HubRequestError(404, "Not found.");
      // A browser cannot set headers on a WebSocket: the signature of
      // "GET /v1/live" travels in the query instead.
      await this.authenticate("GET", Buffer.alloc(0), url.searchParams.get("auth") ?? undefined, "/v1/live");
      this.sockets.handleUpgrade(request, socket, head, (ws) => {
        this.live.add(ws);
        ws.on("close", () => this.live.delete(ws));
        ws.on("error", () => this.live.delete(ws));
        void this.options.log.head().then((value) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "head", head: value } satisfies HubLiveHead));
        });
      });
    } catch (error) {
      const status = error instanceof HubRequestError ? error.status : 500;
      socket.end(`HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : status === 404 ? "Not Found" : "Error"}\r\n\r\n`);
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
      const body = await readBody(request);
      const device = await this.authenticate(request.method ?? "GET", body, request.headers.authorization, pathWithQuery);
      if (request.method === "POST" && url.pathname === "/v1/events") {
        const parsed = parseJson(body) as { events?: unknown };
        return json(response, 200, await this.options.log.push(device, parsed?.events));
      }
      if (request.method === "GET" && url.pathname === "/v1/events") {
        const after = Number(url.searchParams.get("after") ?? "0");
        const limit = Number(url.searchParams.get("limit") ?? "200");
        if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new HubRequestError(400, "Invalid position.");
        return json(response, 200, await this.options.log.pull(device, after, limit));
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
        return json(response, 200, await this.options.search.search({ requester: { kind: "user" }, query: url.searchParams.get("q") ?? "", ...(cursor ? { cursor } : {}) }));
      }
      if (request.method === "POST" && url.pathname === "/v1/push-subscription") {
        const parsed = parseJson(body) as { subscription?: { endpoint?: unknown } };
        const endpoint = parsed?.subscription?.endpoint;
        if (!isAllowedPushEndpoint(endpoint)) throw new HubRequestError(400, "That push endpoint is not accepted.");
        await this.options.storage.hub().savePushSubscription(device.deviceId, endpoint, JSON.stringify(parsed.subscription), new Date(this.now()).toISOString());
        return json(response, 200, { ok: true });
      }
      if (url.pathname === "/v1/roster") {
        if (device.role !== "owner") throw new HubRequestError(403, "Only the desktop that set up this hub changes its devices.");
        if (request.method === "GET") return json(response, 200, { devices: await this.options.storage.hub().devices() });
        if (request.method === "PUT") {
          const devices = validRoster(parseJson(body));
          await this.options.storage.hub().replaceRoster(devices, new Date(this.now()).toISOString());
          this.invalidateRoster();
          return json(response, 200, { devices: await this.options.storage.hub().devices() });
        }
      }
      throw new HubRequestError(404, "Not found.");
    } catch (error) {
      status = error instanceof HubRequestError ? error.status : 500;
      if (status === 500) this.options.debugLog?.("hub.request.error", { url: request.url, message: error instanceof Error ? error.message : String(error) });
      if (!response.headersSent) json(response, status, { ok: false, error: error instanceof Error && status !== 500 ? error.message : "The hub could not answer." });
    } finally {
      this.options.debugLog?.("hub.request", { method: request.method, path: (request.url ?? "").split("?")[0], status, ms: this.now() - started });
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

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > HUB_MAX_BODY_BYTES) {
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
        !["desktop", "machine", "phone"].includes(device.role) || typeof device.name !== "string" || device.name.length > 200 ||
        (device.machineId !== undefined && (typeof device.machineId !== "string" || device.machineId.length > 128))) {
      throw new HubRequestError(400, "Invalid roster entry.");
    }
    return { deviceId: device.deviceId, publicKeyDerBase64: device.publicKeyDerBase64, role: device.role, name: device.name, addedAt: "",
      ...(device.machineId ? { machineId: device.machineId } : {}) };
  });
}

function certStamp(files: { cert: string; key: string }): string {
  try {
    return readFileSync(files.cert).subarray(-64).toString("hex");
  } catch {
    return "";
  }
}

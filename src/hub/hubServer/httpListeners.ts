import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { HEARTBEAT_MS } from "./constants";
import { certStamp } from "./httpsCertificate";
import type { HubServerModules } from "./modules";
import type { HubServerDependencies } from "./dependencies";

/** The ports the server listens on. */
export class HttpListeners {
  private heartbeat?: ReturnType<typeof setInterval>;
  private servers: Server[] = [];

  constructor(
    private readonly server: Pick<HubServerModules, "liveSockets" | "requestRouter" | "rooms">,
    private readonly deps: Pick<HubServerDependencies, "options">
  ) {}

  /** Plain HTTP. In production it answers only the certificate challenge
   *  and the health check (`openOnly`); the rest needs TLS. Tests and local
   *  runs serve everything. */
  listenHttp(port: number, host?: string, options: { openOnly?: boolean } = {}): Promise<Server> {
    const server = createHttpServer((request, response) => void this.server.requestRouter.handle(request, response, options.openOnly === true));
    if (!options.openOnly) server.on("upgrade", (request, socket, head) => void this.server.liveSockets.upgrade(request, socket, head));
    return this.listen(server, port, host);
  }

  /** HTTPS with the certificate on disk, re-read when it is renewed. */
  listenHttps(port: number, files: { cert: string; key: string }, host?: string): Promise<Server> {
    const load = () => ({ cert: readFileSync(files.cert), key: readFileSync(files.key) });
    const server = createHttpsServer(load(), (request, response) => void this.server.requestRouter.handle(request, response));
    server.on("upgrade", (request, socket, head) => void this.server.liveSockets.upgrade(request, socket, head));
    let stamp = certStamp(files);
    const reload = setInterval(() => {
      const next = certStamp(files);
      if (next === stamp) return;
      try {
        server.setSecureContext(load());
        stamp = next;
        this.deps.options.debugLog?.("hub.tls.reloaded", {});
      } catch (error) {
        this.deps.options.debugLog?.("hub.tls.reload-failed", { message: error instanceof Error ? error.message : String(error) });
      }
    }, 60_000);
    reload.unref();
    server.on("close", () => clearInterval(reload));
    return this.listen(server, port, host);
  }

  private listen(server: Server, port: number, host?: string): Promise<Server> {
    this.heartbeat ??= setInterval(() => this.server.liveSockets.beat(), HEARTBEAT_MS);
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

  /**
   * Stops listening and closes every connection now: a phone's long wait
   * for news, a keep-alive connection, a live socket. A request waiting on
   * one of them would otherwise keep the program running long after a stop
   * (the service manager then waits for its kill timeout).
   */
  async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    for (const socket of this.server.liveSockets.live.keys()) socket.terminate();
    this.server.liveSockets.live.clear();
    for (const members of this.server.rooms.members.values()) for (const member of members.values()) member.socket.terminate();
    this.server.rooms.members.clear();
    const closed = Promise.all(this.servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    for (const server of this.servers) (server as Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    await closed;
    this.servers = [];
  }
}

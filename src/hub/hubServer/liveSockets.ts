import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { HubLiveOps } from "../../shared/hubProtocol";
import type { HubLiveSettings } from "../../shared/hubOps";
import { HubRequestError } from "./httpAnswers";
import type { LiveSocket, LiveSocketServer } from "./types";
import { WebSocketServer } from "./webSocketServer";
import type { HubServerModules } from "./modules";
import type { HubServerDependencies } from "./dependencies";

/** Devices that follow the server live. */
export class LiveSockets {
  /** Live sockets and the device each one belongs to. */
  readonly live = new Map<LiveSocket, string>();
  private readonly sockets: LiveSocketServer = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  private readonly answered = new WeakSet<LiveSocket>();

  constructor(
    private readonly server: Pick<HubServerModules, "deviceAuth" | "rooms">,
    private readonly deps: Pick<HubServerDependencies, "options">
  ) {}

  watch(socket: LiveSocket): void {
    this.answered.add(socket);
    socket.on("pong", () => this.answered.add(socket));
  }

  beat(): void {
    const sockets = [...this.live.keys(), ...[...this.server.rooms.members.values()].flatMap((members) => [...members.values()].map((member) => member.socket))];
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
  async disconnectRemoved(): Promise<void> {
    const kept = new Set((await this.deps.options.storage.hub().devices()).map((device) => device.deviceId));
    for (const [socket, deviceId] of this.live) if (!kept.has(deviceId)) socket.terminate();
    for (const members of this.server.rooms.members.values()) {
      for (const member of members.values()) if (!kept.has(member.deviceId)) member.socket.terminate();
    }
  }

  /** A live word to the devices of one machine (its settings changed). */
  tellMachine(machineId: string, frame: HubLiveSettings): void {
    void this.deps.options.storage.hub().devices().then((devices) => {
      const ids = new Set(devices.filter((item) => item.role === "machine" && item.machineId === machineId).map((item) => item.deviceId));
      const text = JSON.stringify(frame);
      for (const [socket, deviceId] of this.live) {
        if (ids.has(deviceId) && socket.readyState === socket.OPEN) socket.send(text);
      }
    }).catch(() => undefined);
  }

  broadcastOps(head: number): void {
    const frame = JSON.stringify({ type: "ops", head } satisfies HubLiveOps);
    for (const socket of this.live.keys()) {
      if (socket.readyState === socket.OPEN) socket.send(frame);
    }
  }

  async upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", "http://hub");
      if (url.pathname === "/v1/room") return await this.server.rooms.joinRoom(request, socket, head, url);
      if (url.pathname !== "/v1/live") throw new HubRequestError(404, "Not found.");
      // A browser cannot set headers on a WebSocket: the signature of
      // "GET /v1/live" travels in the query instead.
      const device = await this.server.deviceAuth.authenticate("GET", Buffer.alloc(0), url.searchParams.get("auth") ?? undefined, "/v1/live");
      this.sockets.handleUpgrade(request, socket, head, (ws) => {
        this.live.set(ws, device.deviceId);
        this.watch(ws);
        ws.on("close", () => this.live.delete(ws));
        ws.on("error", () => this.live.delete(ws));
        void this.deps.options.ops?.head().then((value) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "ops", head: value } satisfies HubLiveOps));
        });
      });
    } catch (error) {
      const status = error instanceof HubRequestError ? error.status : 500;
      socket.end(`HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : status === 404 ? "Not Found" : "Error"}\r\n\r\n`);
    }
  }
}

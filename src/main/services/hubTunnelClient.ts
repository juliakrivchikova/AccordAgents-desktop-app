import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { signHubRequest, type HubSigningIdentity } from "./hubAuth";
import type { RelayTunnelEvents as Events, RelayTunnelMessage, RelayTunnelPeer, RelayTunnelPeerEvent, RelayTunnelRole, RelayTunnelState, TunnelClient } from "./relayTunnelClient";
import type { RelayChunkFrame } from "../../shared/relayProtocol";
import { HUB_ROOM_REPLACED_CLOSE_CODE, hubWebSocketUrl } from "../../shared/hubProtocol";

interface MinimalWebSocket {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  ping(): void;
  on(event: "open" | "pong", listener: () => void): this;
  on(event: "message", listener: (data: unknown) => void): this;
  on(event: "close", listener: (code: number) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
}
const OPEN = 1;
const WebSocketClient = require("ws") as new (url: string) => MinimalWebSocket;
/** A room link pings this often and is given up when a ping goes unanswered:
 *  a machine that slept or lost its network must not look connected. */
const ROOM_PING_MS = 25_000;

/**
 * The same room a relay gave, served by the User's own hub: a device joins a
 * room with its signature, sees who else is there, and passes messages that
 * the hub forwards without keeping. Drop-in for RelayTunnelClient, so the
 * sealing and signing above it do not change.
 */
export class HubTunnelClient implements TunnelClient {
  private readonly emitter = new EventEmitter();
  private socket?: MinimalWebSocket;
  private heartbeat?: ReturnType<typeof setInterval>;
  private state: RelayTunnelState = "idle";
  private closed = false;
  private attempt = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private ownId = "";

  constructor(private readonly options: {
    hubUrl: string;
    rendezvousId: string;
    role: RelayTunnelRole;
    identity: () => Promise<HubSigningIdentity>;
    reconnectDelayMs?: number;
  }) {}

  on<Name extends keyof Events>(event: Name, listener: (...args: Events[Name]) => void): () => void {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
    return () => this.emitter.off(event, listener as (...args: unknown[]) => void);
  }

  currentState(): RelayTunnelState {
    return this.state;
  }

  deviceId(): string {
    return this.ownId;
  }

  async connect(): Promise<void> {
    this.closed = false;
    await this.open();
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.socket?.close(1000, "closed");
    this.socket = undefined;
    this.setState("closed");
  }

  async sendCiphertext(request: { logicalMessageId: string; ciphertext: string; cursor?: string; to?: string }): Promise<RelayChunkFrame[]> {
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN) throw new Error("The hub room is not connected.");
    if (this.options.role === "machine" && !request.to?.trim()) throw new Error("A machine must target a device id on every message.");
    socket.send(JSON.stringify({ type: "send", id: request.logicalMessageId || randomUUID(), data: request.ciphertext, ...(request.to ? { to: request.to } : {}) }));
    return [];
  }

  private async open(): Promise<void> {
    if (this.closed) return;
    this.setState(this.attempt === 0 ? "connecting" : "tunnel-reconnecting");
    const identity = await this.options.identity();
    this.ownId = identity.originId;
    const pathWithQuery = `/v1/room?rid=${encodeURIComponent(this.options.rendezvousId)}&role=${this.options.role}`;
    const auth = signHubRequest(identity, { method: "GET", pathWithQuery });
    const url = hubWebSocketUrl(this.options.hubUrl, `${pathWithQuery}&auth=${encodeURIComponent(auth)}`);
    const socket = new WebSocketClient(url);
    this.socket = socket;
    let answered = true;
    socket.on("pong", () => { answered = true; });
    socket.on("open", () => {
      this.attempt = 0;
      this.setState("connected");
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => {
        if (this.socket !== socket) return;
        if (!answered) {
          socket.terminate();
          return;
        }
        answered = false;
        try { socket.ping(); } catch { socket.terminate(); }
      }, ROOM_PING_MS);
      this.heartbeat.unref?.();
    });
    socket.on("message", (data) => this.handle(data));
    socket.on("error", (error) => {
      if (this.emitter.listenerCount("error") > 0) this.emitter.emit("error", error);
    });
    socket.on("close", (code) => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = undefined;
      // Replaced by a newer connection of this device: that one carries on.
      if (this.closed || code === HUB_ROOM_REPLACED_CLOSE_CODE) {
        if (!this.closed) this.setState("closed");
        return;
      }
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.closed || this.timer) return;
    const base = this.options.reconnectDelayMs ?? 1_000;
    const delay = Math.min(base * 60, base * 2 ** this.attempt) * (0.75 + Math.random() / 2);
    this.attempt = Math.min(this.attempt + 1, 8);
    this.setState("tunnel-reconnecting");
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.open().catch(() => this.scheduleReconnect());
    }, delay);
    this.timer.unref?.();
  }

  private handle(data: unknown): void {
    let frame: { type?: string; deviceId?: string; peers?: RelayTunnelPeer[]; peer?: RelayTunnelPeer; from?: string; id?: string; data?: string; code?: string; to?: string };
    try {
      frame = JSON.parse(String(data)) as typeof frame;
    } catch {
      return;
    }
    if (frame.type === "ready") {
      const peers = Array.isArray(frame.peers) ? frame.peers.filter((peer) => typeof peer?.deviceId === "string" && typeof peer?.role === "string") : [];
      this.emitter.emit("peer", { type: "ready", deviceId: frame.deviceId ?? this.ownId, peerConnected: peers.length > 0, peers } satisfies RelayTunnelPeerEvent);
    } else if (frame.type === "peer-connected" && frame.peer) {
      this.emitter.emit("peer", { type: "peer-connected", peer: frame.peer } satisfies RelayTunnelPeerEvent);
    } else if (frame.type === "peer-disconnected" && frame.peer) {
      this.emitter.emit("peer", { type: "peer-disconnected", peer: frame.peer } satisfies RelayTunnelPeerEvent);
    } else if (frame.type === "error" && frame.code === "peer-not-connected") {
      this.emitter.emit("peer", { type: "peer-not-connected", ...(frame.to ? { to: frame.to } : {}) } satisfies RelayTunnelPeerEvent);
    } else if (frame.type === "message" && typeof frame.data === "string") {
      this.emitter.emit("message", { logicalMessageId: frame.id ?? "", ciphertext: frame.data } satisfies RelayTunnelMessage);
    }
  }

  private setState(next: RelayTunnelState): void {
    if (this.state === next) return;
    this.state = next;
    this.emitter.emit("state", next);
  }
}

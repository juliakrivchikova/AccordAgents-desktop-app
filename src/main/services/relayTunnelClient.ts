import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import {
  chunkRelayCiphertext,
  PUSHER_SIZED_RELAY_FLOOR,
  reassembleRelayCiphertext,
  type RelayCapabilityManifest,
  type RelayChunkFrame
} from "../../shared/relayProtocol";

export type RelayTunnelRole = "desktop" | "phone";

export type RelayTunnelState =
  | "idle"
  | "connecting"
  | "connected"
  | "tunnel-reconnecting"
  | "closed";

export interface RelayTunnelClientOptions {
  relayUrl: string;
  rendezvousId: string;
  role: RelayTunnelRole;
  capability: string;
  streamId: string;
  manifest?: RelayCapabilityManifest;
  reconnectDelayMs?: number;
}

export interface RelayTunnelMessage {
  logicalMessageId: string;
  ciphertext: string;
}

interface RelayTunnelEvents {
  message: [RelayTunnelMessage];
  state: [RelayTunnelState];
  error: [Error];
}

type RelayTunnelEventName = keyof RelayTunnelEvents;

interface MinimalWebSocket {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "open", listener: () => void): this;
  on(event: "message", listener: (data: unknown) => void): this;
  on(event: "close", listener: (code: number, reason: Buffer) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "unexpected-response", listener: (request: unknown, response: IncomingMessage) => void): this;
}

interface MinimalWebSocketConstructor {
  readonly OPEN: number;
  new(url: string): MinimalWebSocket;
}

const WebSocket = require("ws") as MinimalWebSocketConstructor;

export class RelayTunnelClient {
  private readonly emitter = new EventEmitter();
  private readonly manifest: RelayCapabilityManifest;
  private readonly reconnectDelayMs: number;
  private readonly frameBuffer = new Map<string, RelayChunkFrame[]>();
  private socket?: MinimalWebSocket;
  private state: RelayTunnelState = "idle";
  private closed = false;
  private cursor?: string;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  // W-F(c): consecutive failed cycles widen the delay exponentially up to the
  // cap; a successful open resets it. A fixed delay hammered the relay once a
  // second for as long as an outage lasted.
  private reconnectAttempts = 0;

  constructor(private readonly options: RelayTunnelClientOptions) {
    this.manifest = options.manifest ?? PUSHER_SIZED_RELAY_FLOOR;
    this.reconnectDelayMs = Math.max(50, Math.floor(options.reconnectDelayMs ?? 1_000));
  }

  on<EventName extends RelayTunnelEventName>(
    event: EventName,
    listener: (...args: RelayTunnelEvents[EventName]) => void
  ): () => void {
    this.emitter.on(event, listener);
    return () => this.emitter.off(event, listener);
  }

  currentState(): RelayTunnelState {
    return this.state;
  }

  async connect(): Promise<void> {
    this.closed = false;
    await this.openSocket("connecting");
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.setState("closed");
    this.socket?.close(1000, "client closed");
    this.socket = undefined;
  }

  async sendCiphertext(request: {
    logicalMessageId: string;
    ciphertext: string;
    cursor?: string;
  }): Promise<RelayChunkFrame[]> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Relay tunnel is not connected.");
    }
    const frames = chunkRelayCiphertext({
      streamId: this.options.streamId,
      logicalMessageId: request.logicalMessageId,
      ciphertext: request.ciphertext,
      cursor: request.cursor ?? this.cursor,
      manifest: this.manifest
    });
    for (const frame of frames) {
      this.socket.send(JSON.stringify(frame));
    }
    return frames;
  }

  forceSocketCloseForTests(): void {
    this.socket?.close(1012, "test reconnect");
  }

  private async openSocket(connectingState: RelayTunnelState): Promise<void> {
    this.setState(connectingState);
    const socket = new WebSocket(this.connectionUrl());
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      socket.on("open", () => {
        settled = true;
        this.reconnectAttempts = 0;
        this.setState("connected");
        resolve();
      });
      socket.on("message", (data) => this.handleMessage(data));
      socket.on("close", (code, reason) => {
        if (this.socket === socket) {
          this.socket = undefined;
        }
        if (!settled) {
          reject(new Error("Relay tunnel closed before opening."));
          return;
        }
        // An abnormal close carries the relay's reason ("duplicate relay
        // role", "capability mismatch", …). Dropping it made a room lockout
        // look like generic network flap; surface it so the log names the
        // cause.
        if (code !== 1000 && code !== 1001) {
          this.emitError(new Error(`Relay tunnel closed: ${code} ${reason.toString() || "(no reason)"}`));
        }
        this.scheduleReconnect();
      });
      socket.on("error", (error) => {
        this.emitError(error);
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
      socket.on("unexpected-response", (_request, response) => {
        const status = response.statusCode ?? 0;
        const error = new Error(`Relay tunnel rejected with HTTP ${status}.`);
        response.resume();
        this.emitError(error);
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
    });
  }

  // Single-flight: a connection that fails before opening rejects the open
  // promise AND fires its close event, so two callers arrive here for one
  // socket. Without the pending-timer guard each of them started its own
  // retry loop, every later failure doubled the loops again, and once the
  // relay began seating the newest connection the surplus loops evicted each
  // other's sockets once a second, forever.
  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) {
      return;
    }
    this.setState("tunnel-reconnecting");
    // W-F(c): exponential backoff with jitter, capped at 60x the base delay
    // (1s -> 60s at the default base), reset by a successful open. The jitter
    // keeps a fleet of clients from re-dialing in lockstep after a relay
    // restart.
    const factor = Math.min(2 ** this.reconnectAttempts, 60);
    const delay = Math.min(this.reconnectDelayMs * factor, this.reconnectDelayMs * 60);
    const jittered = delay * (0.75 + Math.random() * 0.5);
    this.reconnectAttempts = Math.min(this.reconnectAttempts + 1, 8);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.closed) {
        return;
      }
      this.openSocket("tunnel-reconnecting").catch((error) => {
        this.emitError(error);
        this.scheduleReconnect();
      });
    }, jittered);
  }

  private handleMessage(data: unknown): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
    } catch (error) {
      this.emitError(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (isRelayFrame(parsed)) {
      this.handleFrame(parsed);
    }
  }

  private handleFrame(frame: RelayChunkFrame): void {
    const key = `${frame.streamId}\0${frame.logicalMessageId}`;
    const frames = [...(this.frameBuffer.get(key) ?? []), frame];
    this.frameBuffer.set(key, frames);
    const result = reassembleRelayCiphertext(frames);
    if (result.status === "complete") {
      this.frameBuffer.delete(key);
      this.cursor = result.logicalMessageId;
      this.emitter.emit("message", {
        logicalMessageId: result.logicalMessageId,
        ciphertext: result.ciphertext
      } satisfies RelayTunnelMessage);
    } else if (result.status === "conflict") {
      this.frameBuffer.delete(key);
      this.emitError(new Error(`Relay frame conflict: ${result.reason}`));
    }
  }

  private emitError(error: Error): void {
    if (this.emitter.listenerCount("error") > 0) {
      this.emitter.emit("error", error);
    }
  }

  private connectionUrl(): string {
    const url = new URL(this.options.relayUrl);
    url.searchParams.set("rid", this.options.rendezvousId);
    url.searchParams.set("role", this.options.role);
    url.searchParams.set("cap", this.options.capability);
    return url.toString();
  }

  private setState(next: RelayTunnelState): void {
    if (this.state === next) {
      return;
    }
    this.state = next;
    this.emitter.emit("state", next);
  }
}

function isRelayFrame(value: unknown): value is RelayChunkFrame {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (value as { protocol?: unknown }).protocol === "accord-relay-v1" &&
      typeof (value as { streamId?: unknown }).streamId === "string" &&
      typeof (value as { logicalMessageId?: unknown }).logicalMessageId === "string" &&
      typeof (value as { frameId?: unknown }).frameId === "string" &&
      typeof (value as { ciphertextChunk?: unknown }).ciphertextChunk === "string"
  );
}

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { MachineProgressFrame } from "../../shared/machineProgress";
import type { HubKey } from "../hubKey";
import type { ChatSearchService } from "../../main/services/chatSearch";
import type { StorageService } from "../../main/services/storage";
import type { HubPhoneApi } from "../hubPhone";
import type { HubOps } from "../hubOps";
import type { HubMemory } from "../hubMemory";
import type { HubAlerts } from "../hubAlerts";

export interface HubServerOptions {
  hubId: string;
  version: string;
  storage: StorageService;
  search: ChatSearchService;
  vapidPublicKey: string;
  /** The server's own key, with which it proves itself (`/v1/health?proof=`). */
  hubKey?: HubKey;
  /** Files Let's Encrypt validation reads over plain HTTP. */
  acmeWebroot?: string;
  /** The phone's reads: chat list, pages and changes from the server's copy. */
  phone?: HubPhoneApi;
  /** The owner published the composer catalog. */
  onCatalogChanged?: (catalog: unknown) => void;
  /** The owner's members' live progress (kept in memory, never stored). */
  onProgress?: (frames: MachineProgressFrame[]) => void;
  /** The chats as the server owns them: operations, the feed, chat pages. */
  ops?: HubOps;
  /** Members' long-term memory (shared/memory.ts). */
  memory?: HubMemory;
  /** Urgent alerts: Telegram and calls (shared/urgentAlerts.ts). */
  alerts?: HubAlerts;
  now?: () => number;
  debugLog?: (event: string, payload: Record<string, unknown>) => void;
}

/** The little of `ws` the live socket uses (the package ships no types here). */
export interface LiveSocket {
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

/** One device in a room: the live, unstored path for messages that only
 *  matter while both ends are there (greetings, requests answered at once). */
export interface RoomMember {
  deviceId: string;
  role: string;
  socket: LiveSocket;
}

export interface LiveSocketServer {
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, done: (socket: LiveSocket) => void): void;
}

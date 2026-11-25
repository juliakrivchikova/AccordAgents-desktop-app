import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { HUB_ROOM_MAX_MESSAGE_BYTES, HUB_ROOM_REPLACED_CLOSE_CODE, hubRoomRole } from "../../shared/hubProtocol";
import { ROOM_ID, ROOM_MAX_BUFFERED_BYTES } from "./constants";
import { HubRequestError, sendJson } from "./httpAnswers";
import type { LiveSocketServer, RoomMember } from "./types";
import { WebSocketServer } from "./webSocketServer";
import type { HubServerModules } from "./modules";

/** Rooms a machine and its desktop talk in. */
export class Rooms {
  private readonly roomSockets: LiveSocketServer = new WebSocketServer({ noServer: true, maxPayload: HUB_ROOM_MAX_MESSAGE_BYTES });
  readonly members = new Map<string, Map<string, RoomMember>>();

  constructor(private readonly server: Pick<HubServerModules, "deviceAuth" | "liveSockets">) {}

  /**
   * A room is where two or more of the User's devices pass messages that are
   * not kept: the hub forwards each to the device it names (or, without a
   * name, to the other side of a desktop-phone pair) and stores nothing.
   * The member's identity is the one its signature proves.
   */
  async joinRoom(request: IncomingMessage, socket: Duplex, head: Buffer, url: URL): Promise<void> {
    const rid = url.searchParams.get("rid") ?? "";
    const role = url.searchParams.get("role") ?? "";
    if (!ROOM_ID.test(rid) || !["desktop", "phone", "machine"].includes(role)) throw new HubRequestError(400, "Invalid room.");
    const device = await this.server.deviceAuth.authenticate("GET", Buffer.alloc(0), url.searchParams.get("auth") ?? undefined, `/v1/room?rid=${encodeURIComponent(rid)}&role=${role}`);
    // A device sits in a room as what the roster says it is.
    if (role !== hubRoomRole(device.role)) throw new HubRequestError(403, "A device joins a room only as what it is.");
    this.roomSockets.handleUpgrade(request, socket, head, (ws) => {
      this.server.liveSockets.watch(ws);
      const members = this.members.get(rid) ?? new Map<string, RoomMember>();
      this.members.set(rid, members);
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
        if (members.size === 0) this.members.delete(rid);
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
    const members = this.members.get(rid);
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
}

#!/usr/bin/env node

const http = require("node:http");
const { URL } = require("node:url");
const { WebSocket, WebSocketServer } = require("ws");

const DEFAULT_MAX_FRAME_BYTES = 10_240;

// Room semantics (parity with the Cloudflare worker room):
// - A room is keyed by the rendezvous id and holds any number of devices.
// - Every connection carries a role (desktop | phone | machine) and a device
//   id (`did`); desktop and phone default their device id to the role name so
//   the two-party pairing keeps its exact wire behavior.
// - Newest connection wins the seat of its device id; the previous holder is
//   closed with 4001.
// - A frame with `to` is delivered to that device only; a frame without `to`
//   keeps the legacy desktop <-> phone forwarding. Machines always target.
// - Machine joins/leaves are not announced to phones: the phone still reads
//   any peer-connected as "the desktop is here" until it learns machines.
function createReferenceRelayServer(options = {}) {
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  const rooms = new Map();
  const server = http.createServer((request, response) => {
    if (request.url === "/healthz") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, rooms: rooms.size }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false, error: "not found" }));
  });
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/v1/relay") {
      rejectUpgrade(socket, 404, "not found");
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      attachPeer(ws, rooms, {
        rendezvousId: url.searchParams.get("rid") ?? "",
        role: url.searchParams.get("role") ?? "",
        capability: url.searchParams.get("cap") ?? "",
        deviceId: url.searchParams.get("did") ?? "",
        maxFrameBytes
      });
    });
  });

  return {
    server,
    listen: (port = 0, host = "127.0.0.1") => new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Reference relay did not bind to a TCP port."));
          return;
        }
        resolve({
          port: address.port,
          url: `ws://${host}:${address.port}/v1/relay`
        });
      });
    }),
    close: () => new Promise((resolve, reject) => {
      for (const room of rooms.values()) {
        for (const seat of room.seats.values()) {
          seat.socket.terminate();
        }
      }
      wss.close();
      server.close((error) => error ? reject(error) : resolve());
    }),
    roomCount: () => rooms.size
  };
}

function attachPeer(ws, rooms, request) {
  const deviceId = resolveDeviceId(request.role, request.deviceId);
  if (!request.rendezvousId || !request.capability || !isRelayRole(request.role) || !deviceId) {
    ws.close(1008, "invalid relay pairing request");
    return;
  }

  let room = rooms.get(request.rendezvousId);
  if (!room) {
    room = {
      rendezvousId: request.rendezvousId,
      capability: request.capability,
      seats: new Map()
    };
    rooms.set(request.rendezvousId, room);
  }
  if (room.capability !== request.capability) {
    ws.close(1008, "capability mismatch");
    return;
  }
  // Parity with the worker room: nothing pings these sockets, so a dead one
  // can read as OPEN indefinitely. The newest connection is the live one —
  // seat it and dismiss the previous holder instead of locking the real
  // client out behind a ghost.
  const previous = room.seats.get(deviceId);
  if (previous) {
    room.seats.delete(deviceId);
    try {
      previous.socket.close(4001, "replaced by newer connection");
    } catch {
      // Already unreachable — which is exactly why it lost the seat.
    }
  }

  const seat = { socket: ws, role: request.role, deviceId };
  room.seats.set(deviceId, seat);
  ws.send(JSON.stringify({
    type: "relay.ready",
    role: request.role,
    rendezvousId: request.rendezvousId,
    deviceId,
    peerConnected: Boolean(legacyPeerFor(room, seat)),
    peers: openSeats(room).filter((other) => other !== seat).map((other) => ({ deviceId: other.deviceId, role: other.role }))
  }));
  for (const other of announceTargets(room, seat)) {
    other.socket.send(JSON.stringify({
      type: "relay.peer-connected",
      role: request.role,
      rendezvousId: request.rendezvousId,
      deviceId
    }));
  }

  ws.on("message", (data) => {
    const frameBytes = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(String(data), "utf8");
    if (frameBytes > request.maxFrameBytes) {
      ws.close(1009, "relay frame exceeds provider floor");
      return;
    }
    const frame = parseSealedRelayFrame(data);
    if (!frame) {
      ws.close(1008, "invalid sealed relay frame");
      return;
    }
    const target = frame.to === undefined ? legacyPeerFor(room, seat) : openSeat(room, frame.to);
    if (!target) {
      ws.send(JSON.stringify({ type: "relay.error", code: "peer-not-connected", ...(frame.to === undefined ? {} : { to: frame.to }) }));
      return;
    }
    target.socket.send(data);
  });

  ws.on("close", () => {
    if (room?.seats.get(deviceId) !== seat) {
      // Replaced earlier: the seat belongs to a newer connection, so this
      // close must not read as the device leaving the room.
      return;
    }
    room.seats.delete(deviceId);
    for (const other of announceTargets(room, seat)) {
      other.socket.send(JSON.stringify({
        type: "relay.peer-disconnected",
        role: request.role,
        rendezvousId: request.rendezvousId,
        deviceId
      }));
    }
    if (room.seats.size === 0) {
      rooms.delete(request.rendezvousId);
    }
  });
}

function isRelayRole(value) {
  return value === "desktop" || value === "phone" || value === "machine";
}

function resolveDeviceId(role, deviceId) {
  const trimmed = String(deviceId ?? "").trim();
  if (trimmed) {
    return trimmed;
  }
  return role === "desktop" || role === "phone" ? role : "";
}

function isOpen(socket) {
  return Boolean(socket && socket.readyState === WebSocket.OPEN);
}

function openSeats(room) {
  return [...room.seats.values()].filter((seat) => isOpen(seat.socket));
}

function openSeat(room, deviceId) {
  const seat = room.seats.get(deviceId);
  return seat && isOpen(seat.socket) ? seat : undefined;
}

/** Legacy counterpart of an untargeted frame: desktop <-> phone. A machine
 *  has no legacy counterpart; its "peerConnected" means a desktop is present. */
function legacyPeerFor(room, seat) {
  const wanted = seat.role === "desktop" ? "phone" : "desktop";
  return openSeats(room).find((other) => other !== seat && other.role === wanted);
}

/** Who learns that `seat` joined or left: every other open seat, except that
 *  phones are not told about machines. */
function announceTargets(room, seat) {
  return openSeats(room).filter((other) => other !== seat && !(seat.role === "machine" && other.role === "phone"));
}

function parseSealedRelayFrame(data) {
  try {
    const parsed = JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
    const valid = parsed &&
      parsed.protocol === "accord-relay-v1" &&
      typeof parsed.streamId === "string" &&
      typeof parsed.logicalMessageId === "string" &&
      typeof parsed.frameId === "string" &&
      typeof parsed.ciphertextChunk === "string" &&
      (parsed.to === undefined || (typeof parsed.to === "string" && parsed.to.trim().length > 0));
    return valid ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function rejectUpgrade(socket, statusCode, message) {
  socket.write(`HTTP/1.1 ${statusCode} ${message}\r\n\r\n`);
  socket.destroy();
}

if (require.main === module) {
  const relay = createReferenceRelayServer({
    maxFrameBytes: Number(process.env.ACCORD_RELAY_MAX_FRAME_BYTES || DEFAULT_MAX_FRAME_BYTES)
  });
  const port = Number(process.env.PORT || 18088);
  relay.listen(port, process.env.HOST || "127.0.0.1").then((address) => {
    console.log(`AccordAgents reference relay listening on ${address.url}`);
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  createReferenceRelayServer
};

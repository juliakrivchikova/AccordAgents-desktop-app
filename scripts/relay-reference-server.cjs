#!/usr/bin/env node

const http = require("node:http");
const { URL } = require("node:url");
const { WebSocket, WebSocketServer } = require("ws");

const DEFAULT_MAX_FRAME_BYTES = 10_240;

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
        room.desktop?.terminate();
        room.phone?.terminate();
      }
      wss.close();
      server.close((error) => error ? reject(error) : resolve());
    }),
    roomCount: () => rooms.size
  };
}

function attachPeer(ws, rooms, request) {
  if (!request.rendezvousId || !request.capability || !isRelayRole(request.role)) {
    ws.close(1008, "invalid relay pairing request");
    return;
  }

  let room = rooms.get(request.rendezvousId);
  if (!room) {
    room = {
      rendezvousId: request.rendezvousId,
      capability: request.capability
    };
    rooms.set(request.rendezvousId, room);
  }
  if (room.capability !== request.capability) {
    ws.close(1008, "capability mismatch");
    return;
  }
  if (isOpen(room[request.role])) {
    ws.close(1008, "duplicate relay role");
    return;
  }

  room[request.role] = ws;
  ws.send(JSON.stringify({
    type: "relay.ready",
    role: request.role,
    rendezvousId: request.rendezvousId,
    peerConnected: Boolean(peerFor(room, request.role))
  }));
  peerFor(room, request.role)?.send(JSON.stringify({
    type: "relay.peer-connected",
    role: request.role,
    rendezvousId: request.rendezvousId
  }));

  ws.on("message", (data) => {
    const frameBytes = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(String(data), "utf8");
    if (frameBytes > request.maxFrameBytes) {
      ws.close(1009, "relay frame exceeds provider floor");
      return;
    }
    if (!isSealedRelayFrame(data)) {
      ws.close(1008, "invalid sealed relay frame");
      return;
    }
    const peer = peerFor(room, request.role);
    if (!isOpen(peer)) {
      ws.send(JSON.stringify({ type: "relay.error", code: "peer-not-connected" }));
      return;
    }
    peer.send(data);
  });

  ws.on("close", () => {
    if (room?.[request.role] === ws) {
      delete room[request.role];
    }
    peerFor(room, request.role)?.send(JSON.stringify({
      type: "relay.peer-disconnected",
      role: request.role,
      rendezvousId: request.rendezvousId
    }));
    if (!room?.desktop && !room?.phone) {
      rooms.delete(request.rendezvousId);
    }
  });
}

function isRelayRole(value) {
  return value === "desktop" || value === "phone";
}

function isOpen(socket) {
  return Boolean(socket && socket.readyState === WebSocket.OPEN);
}

function peerFor(room, role) {
  return role === "desktop" ? room.phone : room.desktop;
}

function isSealedRelayFrame(data) {
  try {
    const parsed = JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
    return parsed &&
      parsed.protocol === "accord-relay-v1" &&
      typeof parsed.streamId === "string" &&
      typeof parsed.logicalMessageId === "string" &&
      typeof parsed.frameId === "string" &&
      typeof parsed.ciphertextChunk === "string";
  } catch {
    return false;
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

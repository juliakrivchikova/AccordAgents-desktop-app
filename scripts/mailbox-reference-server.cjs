#!/usr/bin/env node

const http = require("node:http");
const { mkdir, readFile, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { URL } = require("node:url");

function createReferenceMailboxServer(options = {}) {
  const storePath = options.storePath;
  const eventsById = new Map();
  let loaded = false;
  const server = http.createServer(async (request, response) => {
    try {
      await loadStore();
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/healthz") {
        writeJson(response, 200, { ok: true, eventCount: eventsById.size });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/mailbox/events") {
        const body = await readJsonBody(request);
        const incoming = Array.isArray(body.events) ? body.events : [];
        const appendedEventIds = [];
        const duplicateEventIds = [];
        for (const event of incoming) {
          assertMailboxEvent(event);
          if (eventsById.has(event.eventId)) {
            duplicateEventIds.push(event.eventId);
            continue;
          }
          eventsById.set(event.eventId, event);
          appendedEventIds.push(event.eventId);
        }
        if (appendedEventIds.length > 0) {
          await persistStore();
        }
        writeJson(response, 200, {
          ackRole: "mailbox",
          eventIds: incoming.map((event) => event.eventId),
          appendedEventIds,
          duplicateEventIds
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/mailbox/events") {
        const conversationId = url.searchParams.get("conversationId") ?? "";
        const logScopeId = url.searchParams.get("logScopeId") ?? conversationId;
        const originId = url.searchParams.get("originId") ?? "";
        const afterSeq = Number(url.searchParams.get("afterSeq") ?? "0");
        const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get("limit") ?? "500")));
        const events = Array.from(eventsById.values())
          .filter((event) => event.conversationId === conversationId)
          .filter((event) => event.logScopeId === logScopeId)
          .filter((event) => !originId || event.originId === originId)
          .filter((event) => !originId || !Number.isFinite(afterSeq) || event.originSeq > afterSeq)
          .sort(compareMailboxEvents)
          .slice(0, limit);
        writeJson(response, 200, { events });
        return;
      }
      writeJson(response, 404, { ok: false, error: "not found" });
    } catch (error) {
      writeJson(response, 400, {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  async function loadStore() {
    if (loaded || !storePath) {
      loaded = true;
      return;
    }
    loaded = true;
    try {
      const raw = await readFile(storePath, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.events)) {
        for (const event of parsed.events) {
          assertMailboxEvent(event);
          eventsById.set(event.eventId, event);
        }
      }
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return;
      }
      throw error;
    }
  }

  async function persistStore() {
    if (!storePath) {
      return;
    }
    await mkdir(path.dirname(storePath), { recursive: true });
    const events = Array.from(eventsById.values()).sort(compareMailboxEvents);
    await writeFile(storePath, JSON.stringify({ events }, null, 2), "utf8");
  }

  return {
    server,
    listen: (port = 0, host = "127.0.0.1") => new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Reference mailbox did not bind to a TCP port."));
          return;
        }
        resolve({
          port: address.port,
          url: `http://${host}:${address.port}`
        });
      });
    }),
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
    eventCount: () => eventsById.size
  };
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("error", reject);
    request.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function assertMailboxEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new Error("Mailbox event must be an object.");
  }
  for (const field of ["eventId", "conversationId", "logScopeId", "originId", "kind", "eventHash"]) {
    if (typeof event[field] !== "string" || !event[field].trim()) {
      throw new Error(`Mailbox event requires ${field}.`);
    }
  }
  if (!Number.isSafeInteger(event.originSeq) || event.originSeq < 1) {
    throw new Error("Mailbox event requires positive originSeq.");
  }
}

function compareMailboxEvents(left, right) {
  return left.conversationId.localeCompare(right.conversationId) ||
    left.logScopeId.localeCompare(right.logScopeId) ||
    left.originId.localeCompare(right.originId) ||
    left.originSeq - right.originSeq ||
    left.eventId.localeCompare(right.eventId);
}

if (require.main === module) {
  const mailbox = createReferenceMailboxServer({
    storePath: process.env.ACCORD_MAILBOX_STORE
  });
  mailbox.listen(Number(process.env.PORT || 18089), process.env.HOST || "127.0.0.1").then((address) => {
    console.log(`AccordAgents reference mailbox listening on ${address.url}`);
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { createReferenceMailboxServer };

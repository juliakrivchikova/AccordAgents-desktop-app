import assert from "node:assert/strict";
import { createRequire } from "node:module";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import type { ChatEventEnvelope } from "../../shared/chatEvents";
import { MailboxSyncClient } from "./mailboxSyncClient";

const requireScript = createRequire(__filename);
const { createReferenceMailboxServer } = requireScript(path.join(process.cwd(), "scripts/mailbox-reference-server.cjs")) as {
  createReferenceMailboxServer: (options?: { storePath?: string }) => {
    listen(port?: number, host?: string): Promise<{ port: number; url: string }>;
    close(): Promise<void>;
  };
};

test("MailboxSyncClient requires exact mailbox eventId ack and pulls scoped ranges", async () => {
  const mailbox = createReferenceMailboxServer();
  const address = await mailbox.listen();
  const client = new MailboxSyncClient({ baseUrl: address.url });
  try {
    const first = event({ eventId: "event-1", originSeq: 1 });
    const second = event({ eventId: "event-2", originSeq: 2 });

    const ack = await client.appendEvents([first, second]);
    const duplicate = await client.appendEvents([first]);
    const range = await client.listEvents({
      conversationId: "conversation-1",
      logScopeId: "conversation-1",
      originId: "device-1",
      afterSeq: 1
    });

    assert.deepEqual(ack.eventIds, ["event-1", "event-2"]);
    assert.deepEqual(ack.appendedEventIds, ["event-1", "event-2"]);
    assert.deepEqual(duplicate.duplicateEventIds, ["event-1"]);
    assert.deepEqual(range.map((item) => item.eventId), ["event-2"]);
  } finally {
    await mailbox.close();
  }
});

test("MailboxSyncClient rejects ack from wrong role or missing submitted eventId", async () => {
  const mismatchServer = ackServer({
    ackRole: "mailbox",
    eventIds: ["other-event"],
    appendedEventIds: ["other-event"],
    duplicateEventIds: []
  });
  const mismatchAddress = await listen(mismatchServer);
  try {
    const eventToSend = event({ eventId: "expected-event" });
    await assert.rejects(
      () => new MailboxSyncClient({ baseUrl: mismatchAddress.url }).appendEvents([eventToSend]),
      /eventId mismatch/
    );
  } finally {
    await close(mismatchServer);
  }

  const wrongRoleServer = ackServer({
    ackRole: "relay",
    eventIds: ["expected-event"],
    appendedEventIds: ["expected-event"],
    duplicateEventIds: []
  });
  const wrongRoleAddress = await listen(wrongRoleServer);
  try {
    const eventToSend = event({ eventId: "expected-event" });
    await assert.rejects(
      () => new MailboxSyncClient({ baseUrl: wrongRoleAddress.url }).appendEvents([eventToSend]),
      /ackRole mailbox/
    );
  } finally {
    await close(wrongRoleServer);
  }
});

function event(overrides: Partial<ChatEventEnvelope> = {}): ChatEventEnvelope {
  const eventId = overrides.eventId ?? "event-1";
  return {
    eventId,
    conversationId: "conversation-1",
    logScopeId: "conversation-1",
    originId: "device-1",
    originSeq: 1,
    logicalTs: "0000000000000001:device-1:conversation-1",
    kind: "message.created",
    payload: { content: "hello" },
    payloadHash: "sha256:payload",
    eventHash: `sha256:${eventId}`,
    createdAt: "2026-08-06T00:00:00.000Z",
    ...overrides
  };
}

function listen(server: http.Server): Promise<{ port: number; url: string }> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Test server did not bind a TCP port."));
        return;
      }
      resolve({ port: address.port, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function ackServer(payload: unknown): http.Server {
  return http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  });
}

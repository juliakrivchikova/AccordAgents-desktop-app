import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createReferenceMailboxServer } = require("./mailbox-reference-server.cjs");

test("reference mailbox acks exact eventIds and range-syncs scoped events", async () => {
  const mailbox = createReferenceMailboxServer();
  const address = await mailbox.listen();
  try {
    const first = event({ eventId: "event-1", originSeq: 1 });
    const second = event({ eventId: "event-2", originSeq: 2 });
    const ack = await postJson(`${address.url}/v1/mailbox/events`, { events: [first, second] });
    const duplicate = await postJson(`${address.url}/v1/mailbox/events`, { events: [first] });
    const range = await getJson(`${address.url}/v1/mailbox/events?conversationId=conversation-1&logScopeId=conversation-1&originId=device-1&afterSeq=1`);

    assert.deepEqual(ack, {
      ackRole: "mailbox",
      eventIds: ["event-1", "event-2"],
      appendedEventIds: ["event-1", "event-2"],
      duplicateEventIds: []
    });
    assert.deepEqual(duplicate, {
      ackRole: "mailbox",
      eventIds: ["event-1"],
      appendedEventIds: [],
      duplicateEventIds: ["event-1"]
    });
    assert.deepEqual(range.events.map((item) => item.eventId), ["event-2"]);
  } finally {
    await mailbox.close();
  }
});

test("reference mailbox persists events across restart", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "accordagents-mailbox-"));
  const storePath = path.join(directory, "events.json");
  const firstMailbox = createReferenceMailboxServer({ storePath });
  const firstAddress = await firstMailbox.listen();
  try {
    await postJson(`${firstAddress.url}/v1/mailbox/events`, {
      events: [event({ eventId: "event-persisted", originSeq: 1 })]
    });
  } finally {
    await firstMailbox.close();
  }

  const secondMailbox = createReferenceMailboxServer({ storePath });
  const secondAddress = await secondMailbox.listen();
  try {
    const range = await getJson(`${secondAddress.url}/v1/mailbox/events?conversationId=conversation-1&logScopeId=conversation-1`);
    assert.deepEqual(range.events.map((item) => item.eventId), ["event-persisted"]);
  } finally {
    await secondMailbox.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function event(overrides = {}) {
  return {
    eventId: "event-1",
    conversationId: "conversation-1",
    logScopeId: "conversation-1",
    originId: "device-1",
    originSeq: 1,
    logicalTs: "0000000000000001:device-1:conversation-1",
    kind: "message.created",
    payload: { content: "hello" },
    payloadHash: "sha256:payload",
    eventHash: `sha256:${overrides.eventId ?? "event-1"}`,
    createdAt: "2026-08-06T00:00:00.000Z",
    ...overrides
  };
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    assert.fail(await response.text());
  }
  return response.json();
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    assert.fail(await response.text());
  }
  return response.json();
}

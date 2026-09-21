import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import type { Conversation, SendChatMessageRequest, StartReviewResult } from "../../shared/types";
import { RelayTunnelClient } from "./relayTunnelClient";
import { MobileRelayControlService, timelineEventsFromConversation, timelineEventsFromSnapshot, type MobileRelayChatSender, type MobileTimelineEvents } from "./mobileRelayControl";
import { openMobileRelayPayload, sealMobileRelayPayload } from "./mobileRelaySealing";

const requireScript = createRequire(__filename);
const { createReferenceRelayServer } = requireScript(path.join(process.cwd(), "scripts/relay-reference-server.cjs")) as {
  createReferenceRelayServer(): {
    listen(): Promise<{ url: string }>;
    close(): Promise<void>;
  };
};

test("an empty pending participant is visible before output and after reconnect", () => {
  const conversation: Conversation = {
    id: "waiting-chat", kind: "chat", title: "Waiting", createdAt: "2026-09-12T20:00:00Z",
    updatedAt: "2026-09-12T20:00:00Z", findings: [], metadata: {},
    messages: [{
      id: "waiting-message", role: "participant", participantLabel: "@drew", content: "",
      status: "pending", createdAt: "2026-09-12T20:00:00Z",
      metadata: { runId: "waiting-run", chatThreadRootId: "question" }
    }]
  };
  assert.deepEqual(timelineEventsFromSnapshot(conversation), [{
    id: "waiting-message", messageId: "waiting-message", threadRootId: "question",
    role: "participant", participantLabel: "@drew", content: "@drew is running...",
    status: "pending", createdAt: "2026-09-12T20:00:00Z", runId: "waiting-run"
  }]);
  conversation.messages[0].status = "error";
  conversation.messages[0].content = "Interrupted before completion.";
  const terminal = timelineEventsFromSnapshot(conversation)[0];
  assert.equal(terminal.id, "waiting-message");
  assert.equal(terminal.status, "error");
  assert.equal(terminal.content, "Interrupted before completion.");
});

test("desktop progress sends Thinking before its first text over the live relay", { timeout: 5000 }, async () => {
  const key = Buffer.from("s".repeat(32)).toString("base64url");
  const relay = createReferenceRelayServer();
  const address = await relay.listen();
  const durable: MobileTimelineEvents[] = [];
  const desktop = new MobileRelayControlService({
    relayUrl: address.url, rendezvousId: "rv-start-progress", relayCapability: "PAIRING-FINGERPRINT",
    relaySealKeyBase64: key, conversationId: "conversation-1", streamId: "start-progress:phone"
  }, sender([]), undefined, undefined, { async publishTimeline(event) { durable.push(event); } });
  const phone = new RelayTunnelClient({
    relayUrl: address.url, rendezvousId: "rv-start-progress", role: "phone",
    capability: "PAIRING-FINGERPRINT", streamId: "start-progress:phone"
  });
  try {
    await Promise.all([desktop.connect(), phone.connect()]);
    for (const partialContent of [undefined, "First live text", "First live text grows"]) {
      let timer: NodeJS.Timeout | undefined;
      const incoming = Promise.race([
        nextMessage(phone),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("No live progress received")), 1500); })
      ]).finally(() => clearTimeout(timer));
      desktop.noteExternalChatProgress({
        runId: "waiting-run", phase: "debate", message: "Responding", createdAt: new Date().toISOString(),
        agentProgress: { state: "running", participantLabel: "@drew", messageId: "waiting-message", partialContent }
      });
      const payload = await openMobileRelayPayload((await incoming).ciphertext, key) as MobileTimelineEvents;
      assert.equal(payload.conversationId, "conversation-1");
      assert.equal(payload.events[0].id, "waiting-message");
      assert.equal(payload.events[0].status, "pending");
      assert.equal(payload.events[0].content, partialContent ?? "@drew is running...");
    }
    assert.deepEqual(durable, [], "live text must not be appended to durable history per fragment");
    const snapshot: Conversation = {
      id: "conversation-1", kind: "chat", title: "Waiting", createdAt: "2026-09-12T20:00:00Z",
      updatedAt: "2026-09-12T20:00:00Z", findings: [], metadata: {},
      messages: [{ id: "waiting-message", role: "participant", participantLabel: "@drew", content: "",
        status: "pending", createdAt: "2026-09-12T20:00:00Z", metadata: { runId: "waiting-run" } }]
    };
    desktop.noteExternalChatProgress({
      runId: "waiting-run", phase: "debate", message: "Responding", createdAt: new Date().toISOString(),
      agentProgress: { state: "running", participantLabel: "@drew", messageId: "waiting-message" }
    });
    desktop.pushConversationSnapshot(snapshot);
    await waitFor(() => durable.length === 1);
    assert.equal(durable.length, 1, "a live waiting frame cannot suppress its durable snapshot");
    desktop.noteExternalChatProgress({
      runId: "waiting-run", phase: "debate", message: "Responding", createdAt: new Date().toISOString(),
      agentProgress: { state: "running", participantLabel: "@drew", messageId: "waiting-message", partialContent: "More live text" }
    });
    desktop.pushConversationSnapshot(snapshot);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(durable.length, 1, "each text fragment must not cause a repeated durable waiting row");
  } finally { phone.close(); desktop.close(); await relay.close(); }
});

test("a failed durable waiting publication is retried on the next snapshot", async () => {
  let attempts = 0;
  const service = new MobileRelayControlService({
    relayUrl: "ws://127.0.0.1:1/v1/relay", rendezvousId: "rv-save-retry", relayCapability: "PAIRING-FINGERPRINT",
    relaySealKeyBase64: Buffer.from("r".repeat(32)).toString("base64url"), streamId: "save-retry:phone"
  }, sender([]), undefined, undefined, { async publishTimeline() {
    if (++attempts === 1) throw new Error("Storage unavailable");
  } });
  const snapshot: Conversation = {
    id: "waiting-chat", kind: "chat", title: "Waiting", createdAt: "2026-09-12T20:00:00Z",
    updatedAt: "2026-09-12T20:00:00Z", findings: [], metadata: {},
    messages: [{ id: "waiting-message", role: "participant", content: "", status: "pending",
      createdAt: "2026-09-12T20:00:00Z", metadata: { runId: "waiting-run" } }]
  };
  try {
    for (let i = 0; i < 2; i += 1) {
      service.pushConversationSnapshot(snapshot);
      await waitFor(() => attempts === i + 1);
    }
    service.pushConversationSnapshot(snapshot);
    await new Promise<void>(resolve => setTimeout(resolve, 20));
    assert.equal(attempts, 2, "retry the failed write, then suppress the successfully stored duplicate");
  } finally { service.close(); }
});

test("live text never queues chat-history reads, offline or after reconnect", async () => {
  const key = Buffer.from("p".repeat(32)).toString("base64url");
  const relay = createReferenceRelayServer();
  const address = await relay.listen();
  let cardReads = 0;
  const desktop = new MobileRelayControlService({
    relayUrl: address.url, rendezvousId: "rv-no-history-reads", relayCapability: "PAIRING-FINGERPRINT",
    relaySealKeyBase64: key, conversationId: "conversation-1", streamId: "route-no-history:phone"
  }, sender([]), {
    async listChats() { return []; },
    async listTimeline() { return []; },
    async listControlCards() { cardReads += 1; return []; }
  });
  const phone = new RelayTunnelClient({
    relayUrl: address.url, rendezvousId: "rv-no-history-reads", role: "phone",
    capability: "PAIRING-FINGERPRINT", streamId: "route-no-history:phone"
  });
  const emit = (index: number): void => desktop.noteExternalChatProgress({
    runId: "run-no-history", phase: "initial", message: "Streaming", createdAt: `2026-09-10T18:00:00.${String(index).padStart(3, "0")}Z`,
    agentProgress: { state: "running", participantLabel: "@test", messageId: "live-message", partialContent: `fragment ${index}` }
  } as Parameters<typeof desktop.noteExternalChatProgress>[0]);
  try {
    for (let index = 0; index < 200; index += 1) emit(index);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(cardReads, 0, "offline phones must not flood the database with history reads");
    await Promise.all([desktop.connect(), phone.connect()]);
    const reconnected = nextMessage(phone);
    emit(199);
    const payload = await openMobileRelayPayload((await reconnected).ciphertext, key) as MobileTimelineEvents;
    assert.equal(payload.events[0].content, "fragment 199", "offline progress was not marked delivered");
    for (let index = 200; index < 400; index += 1) emit(index);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(cardReads, 0, "connected streaming must not read history for every fragment either");
  } finally {
    phone.close(); desktop.close(); await relay.close();
  }
});

test("saved snapshots deliver and clear cards without a second history read or a visible message", async () => {
  const key = Buffer.from("q".repeat(32)).toString("base64url");
  let cardReads = 0;
  const published: MobileTimelineEvents[] = [];
  const checked: Conversation[] = [];
  const service = new MobileRelayControlService({
    relayUrl: "ws://127.0.0.1:1/v1/relay", rendezvousId: "rv-snapshot-cards", relayCapability: "PAIRING-FINGERPRINT",
    relaySealKeyBase64: key, streamId: "route-snapshot:phone"
  }, sender([]), {
    async listChats() { return []; },
    async listTimeline() { return []; },
    async listControlCards() { cardReads += 1; return []; },
    isConversationAllowed(id, snapshot) {
      assert.equal(snapshot?.id, id);
      checked.push(snapshot!);
      return snapshot?.metadata.archived !== true;
    }
  }, undefined, { async publishTimeline(timeline) { published.push(timeline); } });
  const conversation: Conversation = {
    id: "conversation-cards", kind: "chat", title: "Cards", createdAt: "2026-09-10T18:00:00Z",
    updatedAt: "2026-09-10T18:00:00Z", messages: [], findings: [],
    metadata: { pendingAppToolApprovals: [{
      id: "approval-1", status: "pending", summary: "Allow file editing?", createdAt: "2026-09-10T18:00:00Z"
    }] }
  };
  try {
    service.pushConversationSnapshot(conversation);
    await waitFor(() => published.length === 1);
    assert.equal(published.length, 1);
    assert.equal(published[0].cards?.[0].id, "approval-1");
    assert.equal(published[0].cards?.[0].options[0].id, "allow");
    service.pushConversationSnapshot({ ...conversation, metadata: {}, updatedAt: "2026-09-10T18:00:01Z" });
    await waitFor(() => published.length === 2);
    assert.deepEqual(published.at(-1)?.cards, [], "answered cards are explicitly removed");
    assert.equal(published.length, 2);
    service.pushConversationSnapshot({ ...conversation, metadata: { ...conversation.metadata, archived: true } });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(published.length, 2, "archived snapshots remain excluded");
    assert.equal(cardReads, 0);
    assert.equal(checked.length, 3);
  } finally { service.close(); }
});

test("MobileRelayControlService routes sealed mobile outbox events through ChatService sendMessage", async () => {
  const key = Buffer.from("a".repeat(32)).toString("base64url");
  const sent: unknown[] = [];
  const service = new MobileRelayControlService(
    {
      relayUrl: "ws://127.0.0.1:1/v1/relay",
      rendezvousId: "rv-direct",
      relayCapability: "PAIRING-FINGERPRINT",
      relaySealKeyBase64: key,
      conversationId: "conversation-1",
      streamId: "route-1:phone"
    },
    sender(sent)
  );
  const sealed = await sealMobileRelayPayload({
    type: "mobile.outbox.events",
    events: [{
      eventId: "event-1",
      conversationId: "conversation-1",
      payload: { content: "@codex continue" }
    }]
  }, key);

  assert.deepEqual(await service.acceptSealedMobileOutbox(sealed), {
    eventIds: ["event-1"],
    runIds: ["mobile-event-1"]
  });
  assert.deepEqual(sent, [{
    conversationId: "conversation-1",
    content: "@codex continue",
    runId: "mobile-event-1"
  }]);
  service.close();
});

test("MobileRelayControlService routes run.cancel.requested to the existing cancel path without creating a message", async () => {
  const key = Buffer.from("z".repeat(32)).toString("base64url");
  const cancelled: Array<{ conversationId: string; runId: string }> = [];
  const sent: unknown[] = [];
  const published: MobileTimelineEvents[] = [];
  const service = new MobileRelayControlService(
    {
      relayUrl: "ws://127.0.0.1:1/v1/relay",
      rendezvousId: "rv-cancel",
      relayCapability: "PAIRING-FINGERPRINT",
      relaySealKeyBase64: key,
      conversationId: "conversation-1",
      streamId: "route-cancel:phone"
    },
    {
      ...sender(sent),
      cancelRun(conversationId, runId) {
        cancelled.push({ conversationId, runId });
        return true;
      }
    },
    undefined,
    undefined,
    { async publishTimeline(timeline) { published.push(timeline); } }
  );

  try {
    const result = await service.acceptSealedMobileOutbox(await sealMobileRelayPayload({
      type: "mobile.outbox.events",
      events: [{
        eventId: "event-cancel-1",
        conversationId: "conversation-1",
        kind: "run.cancel.requested",
        payload: { runId: "participant-run-1" }
      }]
    }, key));

    assert.deepEqual(result, { eventIds: ["event-cancel-1"], runIds: [] });
    assert.deepEqual(cancelled, [{ conversationId: "conversation-1", runId: "participant-run-1" }]);
    assert.deepEqual(sent, []);
    assert.deepEqual(published, []);
  } finally {
    service.close();
  }
});

test("progress for a run in another chat is dropped, not delivered as this chat's", async () => {
  // The defect: live progress carries no conversation of its own, so a run this
  // control had not seen was attributed to the conversation the phone was
  // paired to — and that guess was then remembered, so every later frame of the
  // other chat's run arrived as this chat's. One chat's content ended up shown,
  // and stored, inside another.
  const key = Buffer.from("q".repeat(32)).toString("base64url");
  const sent: unknown[] = [];
  const decisions: string[] = [];
  const service = new MobileRelayControlService(
    {
      relayUrl: "ws://127.0.0.1:1/v1/relay",
      rendezvousId: "rv-leak",
      relayCapability: "PAIRING-FINGERPRINT",
      relaySealKeyBase64: key,
      conversationId: "paired-conversation",
      streamId: "route-leak:phone"
    },
    {
      ...sender(sent),
      conversationIdForRun: (runId: string) =>
        runId === "run-in-paired-chat" ? "paired-conversation" : "some-other-conversation"
    }
  );
  service.onLiveDiagnostic = (detail) => decisions.push(`${detail.kind}:${detail.logicalMessageId}`);

  const progressFor = (runId: string, text: string) => ({
    runId,
    phase: "debate" as const,
    message: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    agentProgress: {
      participantLabel: "@someone",
      state: "running" as const,
      partialContent: text
    }
  });

  try {
    service.noteExternalChatProgress(progressFor("run-in-another-chat", "a sentence from a chat this phone is not looking at"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(
      decisions,
      ["unknown-conversation:progress:run-in-another-chat"],
      "another conversation's run must be dropped before anything is published"
    );

    decisions.length = 0;
    service.noteExternalChatProgress(progressFor("run-in-paired-chat", "a sentence from the chat this phone is paired to"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(
      decisions.some((decision) => decision.startsWith("unknown-conversation")),
      false,
      "the paired conversation's own progress must still go through"
    );
  } finally {
    service.close();
  }
});

test("MobileRelayControlService ignores outbox events after pairing becomes inactive", async () => {
  const key = Buffer.from("n".repeat(32)).toString("base64url");
  const sent: unknown[] = [];
  const service = new MobileRelayControlService(
    {
      relayUrl: "ws://127.0.0.1:1/v1/relay",
      rendezvousId: "rv-inactive",
      relayCapability: "PAIRING-FINGERPRINT",
      relaySealKeyBase64: key,
      conversationId: "conversation-1",
      streamId: "route-inactive:phone",
      isActive: () => false
    },
    sender(sent)
  );
  try {
    const event = {
      eventId: "event-inactive",
      conversationId: "conversation-1",
      payload: { content: "@codex should not run" }
    };
    const sealed = await sealMobileRelayPayload({
      type: "mobile.outbox.events",
      events: [event]
    }, key);

    assert.deepEqual(await service.acceptSealedMobileOutbox(sealed), {
      eventIds: [],
      runIds: []
    });
    assert.deepEqual(await service.acceptMobileOutboxEvents([event]), {
      eventIds: [],
      runIds: []
    });
    assert.deepEqual(sent, []);
  } finally {
    service.close();
  }
});

test("MobileRelayControlService returns a sealed desktop ack over the relay", async () => {
  const key = Buffer.from("b".repeat(32)).toString("base64url");
  const sent: unknown[] = [];
  const relay = createReferenceRelayServer();
  const address = await relay.listen();
  const desktop = new MobileRelayControlService(
    {
      relayUrl: address.url,
      rendezvousId: "rv-ack",
      relayCapability: "PAIRING-FINGERPRINT",
      relaySealKeyBase64: key,
      conversationId: "conversation-1",
      streamId: "route-ack:phone",
      reconnectDelayMs: 50
    },
    sender(sent)
  );
  const phone = new RelayTunnelClient({
    relayUrl: address.url,
    rendezvousId: "rv-ack",
    role: "phone",
    capability: "PAIRING-FINGERPRINT",
    streamId: "route-ack:phone"
  });
  try {
    const ackMessage = nextMessage(phone);
    await desktop.connect();
    await phone.connect();
    await phone.sendCiphertext({
      logicalMessageId: "event-2",
      ciphertext: await sealMobileRelayPayload({
        type: "mobile.outbox.events",
        events: [{
          eventId: "event-2",
          conversationId: "conversation-1",
          payload: { content: "run from phone" }
        }]
      }, key)
    });

    const ack = await openMobileRelayPayload(await ackMessage.then((message) => message.ciphertext), key);
    assert.deepEqual(ack, {
      type: "mobile.outbox.ack",
      ackRole: "desktop",
      eventIds: ["event-2"],
      runIds: ["mobile-event-2"]
    });
    assert.deepEqual(sent, [{
      conversationId: "conversation-1",
      content: "run from phone",
      runId: "mobile-event-2"
    }]);
  } finally {
    phone.close();
    desktop.close();
    await relay.close();
  }
});

test("MobileRelayControlService deduplicates replayed mobile outbox event ids", async () => {
  const key = Buffer.from("k".repeat(32)).toString("base64url");
  const sent: unknown[] = [];
  const relay = createReferenceRelayServer();
  const address = await relay.listen();
  const desktop = new MobileRelayControlService(
    {
      relayUrl: address.url,
      rendezvousId: "rv-dedupe",
      relayCapability: "PAIRING-FINGERPRINT",
      relaySealKeyBase64: key,
      conversationId: "conversation-1",
      streamId: "route-dedupe:phone",
      reconnectDelayMs: 50
    },
    {
      ...sender([]),
      async hasAcceptedMobileEvent() {
        return false;
      },
      async sendMessage(request) {
        sent.push({
          conversationId: request.conversationId,
          content: request.content,
          runId: request.runId,
          mobileEventId: request.mobileEventId
        });
        return {
          conversation: {
            id: request.conversationId,
            kind: "chat",
            title: "Test chat",
            createdAt: "2026-08-07T00:00:00.000Z",
            updatedAt: "2026-08-07T00:00:00.000Z",
            messages: [],
            findings: [],
            metadata: {}
          },
          warnings: []
        };
      }
    }
  );
  const phone = new RelayTunnelClient({
    relayUrl: address.url,
    rendezvousId: "rv-dedupe",
    role: "phone",
    capability: "PAIRING-FINGERPRINT",
    streamId: "route-dedupe:phone"
  });
  const payload = {
    type: "mobile.outbox.events",
    events: [{
      eventId: "event-dedupe",
      conversationId: "conversation-1",
      payload: { content: "@codex run once" }
    }]
  };
  try {
    const messages = nextMessages(phone, 3);
    await desktop.connect();
    await phone.connect();
    await phone.sendCiphertext({
      logicalMessageId: "event-dedupe:first",
      ciphertext: await sealMobileRelayPayload(payload, key)
    });
    await phone.sendCiphertext({
      logicalMessageId: "event-dedupe:replay",
      ciphertext: await sealMobileRelayPayload(payload, key)
    });

    const openedMessages = await Promise.all((await messages).map((message) =>
      openMobileRelayPayload<{ type?: string }>(message.ciphertext, key)
    ));
    const acks = openedMessages.filter((message) => message.type === "mobile.outbox.ack");
    const runnings = openedMessages.filter((message) => message.type === "mobile.timeline.events");
    const expectedAck = {
      type: "mobile.outbox.ack",
      ackRole: "desktop",
      eventIds: ["event-dedupe"],
      runIds: ["mobile-event-dedupe"]
    };
    assert.deepEqual(acks, [expectedAck, expectedAck]);
    assert.equal(runnings.length, 1);
    assertRunningTimeline(runnings[0], "conversation-1", "mobile-event-dedupe", "@codex");
    assert.deepEqual(sent, [{
      conversationId: "conversation-1",
      content: "@codex run once",
      runId: "mobile-event-dedupe",
      mobileEventId: "event-dedupe"
    }]);
  } finally {
    phone.close();
    desktop.close();
    await relay.close();
  }
});

test("MobileRelayControlService does not redeliver persisted mobile outbox event ids", async () => {
  const key = Buffer.from("l".repeat(32)).toString("base64url");
  const sent: unknown[] = [];
  const service = new MobileRelayControlService(
    {
      relayUrl: "ws://127.0.0.1:1/v1/relay",
      rendezvousId: "rv-persisted-dedupe",
      relayCapability: "PAIRING-FINGERPRINT",
      relaySealKeyBase64: key,
      conversationId: "conversation-1",
      streamId: "route-persisted-dedupe:phone"
    },
    {
      ...sender([]),
      async hasAcceptedMobileEvent(conversationId, eventId) {
        return conversationId === "conversation-1" && eventId === "event-persisted";
      },
      async sendMessage(request) {
        sent.push(request);
        return {
          conversation: {
            id: request.conversationId,
            kind: "chat",
            title: "Test chat",
            createdAt: "2026-08-07T00:00:00.000Z",
            updatedAt: "2026-08-07T00:00:00.000Z",
            messages: [],
            findings: [],
            metadata: {}
          },
          warnings: []
        };
      }
    }
  );
  try {
    const sealed = await sealMobileRelayPayload({
      type: "mobile.outbox.events",
      events: [{
        eventId: "event-persisted",
        conversationId: "conversation-1",
        payload: { content: "@codex already delivered" }
      }]
    }, key);
    assert.deepEqual(await service.acceptSealedMobileOutbox(sealed), {
      eventIds: ["event-persisted"],
      runIds: ["mobile-event-persisted"]
    });
    assert.deepEqual(sent, []);
  } finally {
    service.close();
  }
});

test("MobileRelayControlService acks but does not run when execution claim is owned elsewhere", async () => {
  const key = Buffer.from("m".repeat(32)).toString("base64url");
  const sent: unknown[] = [];
  const claimAttempts: unknown[] = [];
  const service = new MobileRelayControlService(
    {
      relayUrl: "ws://127.0.0.1:1/v1/relay",
      rendezvousId: "rv-claim-owned",
      relayCapability: "PAIRING-FINGERPRINT",
      relaySealKeyBase64: key,
      conversationId: "conversation-1",
      streamId: "route-claim-owned:phone"
    },
    {
      ...sender(sent),
      async tryAcquireMobileEventExecution(event, runId) {
        claimAttempts.push({ eventId: event.eventId, runId });
        return false;
      }
    }
  );
  try {
    const sealed = await sealMobileRelayPayload({
      type: "mobile.outbox.events",
      events: [{
        eventId: "event-claim-owned",
        conversationId: "conversation-1",
        payload: { content: "@codex cloud already owns this" }
      }]
    }, key);
    assert.deepEqual(await service.acceptSealedMobileOutbox(sealed), {
      eventIds: ["event-claim-owned"],
      runIds: ["mobile-event-claim-owned"]
    });
    assert.deepEqual(claimAttempts, [{
      eventId: "event-claim-owned",
      runId: "mobile-event-claim-owned"
    }]);
    assert.deepEqual(sent, []);
  } finally {
    service.close();
  }
});

test("MobileRelayControlService acks and shows running before the local run finishes", async () => {
  const key = Buffer.from("i".repeat(32)).toString("base64url");
  const releaseRun = deferred<StartReviewResult>();
  const sent: unknown[] = [];
  const relay = createReferenceRelayServer();
  const address = await relay.listen();
  const desktop = new MobileRelayControlService(
    {
      relayUrl: address.url,
      rendezvousId: "rv-early-ack",
      relayCapability: "PAIRING-FINGERPRINT",
      relaySealKeyBase64: key,
      conversationId: "conversation-1",
      streamId: "route-early-ack:phone",
      reconnectDelayMs: 50
    },
    {
      ...sender([]),
      async sendMessage(request) {
        sent.push({
          conversationId: request.conversationId,
          content: request.content,
          runId: request.runId
        });
        return releaseRun.promise;
      }
    }
  );
  const phone = new RelayTunnelClient({
    relayUrl: address.url,
    rendezvousId: "rv-early-ack",
    role: "phone",
    capability: "PAIRING-FINGERPRINT",
    streamId: "route-early-ack:phone"
  });
  try {
    const messages = nextMessages(phone, 2);
    await desktop.connect();
    await phone.connect();
    await phone.sendCiphertext({
      logicalMessageId: "event-early-ack",
      ciphertext: await sealMobileRelayPayload({
        type: "mobile.outbox.events",
        events: [{
          eventId: "event-early-ack",
          conversationId: "conversation-1",
          payload: { content: "@local run from phone" }
        }]
      }, key)
    });

    const [ackMessage, runningMessage] = await messages;
    const ack = await openMobileRelayPayload<{ type: string }>(ackMessage.ciphertext, key);
    const running = await openMobileRelayPayload(runningMessage.ciphertext, key);
    assert.equal(ack.type, "mobile.outbox.ack");
    assertRunningTimeline(running, "conversation-1", "mobile-event-early-ack", "@local");
    assert.deepEqual(sent, [{
      conversationId: "conversation-1",
      content: "@local run from phone",
      runId: "mobile-event-early-ack"
    }]);
    releaseRun.resolve({
      conversation: {
        id: "conversation-1",
        kind: "chat",
        title: "Test chat",
        createdAt: "2026-08-07T00:00:00.000Z",
        updatedAt: "2026-08-07T00:00:00.000Z",
        messages: [],
        findings: [],
        metadata: {}
      },
      warnings: []
    });
  } finally {
    phone.close();
    desktop.close();
    releaseRun.resolve({
      conversation: {
        id: "conversation-1",
        kind: "chat",
        title: "Test chat",
        createdAt: "2026-08-07T00:00:00.000Z",
        updatedAt: "2026-08-07T00:00:00.000Z",
        messages: [],
        findings: [],
        metadata: {}
      },
      warnings: []
    });
    await relay.close();
  }
});

test("MobileRelayControlService returns the device chat list over the sealed relay", async () => {
  const key = Buffer.from("f".repeat(32)).toString("base64url");
  const relay = createReferenceRelayServer();
  const address = await relay.listen();
  const desktop = new MobileRelayControlService(
    {
      relayUrl: address.url,
      rendezvousId: "rv-chat-list",
      relayCapability: "PAIRING-FINGERPRINT",
      relaySealKeyBase64: key,
      streamId: "route-chat-list:phone",
      reconnectDelayMs: 50
    },
    sender([]),
    {
      async listChats() {
        return [{
          id: "conversation-1",
          title: "Accord with Taylor",
          group: "AccordAgents",
          snippet: "Last mobile-control message",
          who: "taylor:",
          updatedAt: "2026-08-07T00:00:00.000Z",
          running: false,
          participants: ["@taylor-claude-engineer", "@drew-codex-engineer"],
          members: [{
            id: "participant-taylor",
            handle: "taylor-claude-engineer",
            mentionHandle: "taylor-claude-engineer",
            displayName: "@taylor-claude-engineer",
            roleLabel: "Software Engineer",
            kind: "claude-code",
            avatarId: "claude-bunny"
          }]
        }];
      },
      async listTimeline() {
        return [];
      }
    }
  );
  const phone = new RelayTunnelClient({
    relayUrl: address.url,
    rendezvousId: "rv-chat-list",
    role: "phone",
    capability: "PAIRING-FINGERPRINT",
    streamId: "route-chat-list:phone"
  });
  try {
    const chatListMessage = nextMessage(phone);
    await desktop.connect();
    await phone.connect();
    await phone.sendCiphertext({
      logicalMessageId: "chat-list-request",
      ciphertext: await sealMobileRelayPayload({ type: "mobile.chat-list.request" }, key)
    });

    const payload = await openMobileRelayPayload(await chatListMessage.then((message) => message.ciphertext), key);
    assert.deepEqual(withoutGeneratedAt(payload), {
      type: "mobile.chat-list",
      chats: [{
        id: "conversation-1",
        title: "Accord with Taylor",
        group: "AccordAgents",
        snippet: "Last mobile-control message",
        who: "taylor:",
        updatedAt: "2026-08-07T00:00:00.000Z",
        running: false,
        participants: ["@taylor-claude-engineer", "@drew-codex-engineer"],
        members: [{
          id: "participant-taylor",
          handle: "taylor-claude-engineer",
          mentionHandle: "taylor-claude-engineer",
          displayName: "@taylor-claude-engineer",
          roleLabel: "Software Engineer",
          kind: "claude-code",
          avatarId: "claude-bunny"
        }]
      }]
    });
  } finally {
    phone.close();
    desktop.close();
    await relay.close();
  }
});

test("MobileRelayControlService scopes the person-invite chat list to one conversation", async () => {
  const key = Buffer.from("q".repeat(32)).toString("base64url");
  const relay = createReferenceRelayServer();
  const address = await relay.listen();
  const desktop = new MobileRelayControlService(
    {
      relayUrl: address.url,
      rendezvousId: "rv-scoped-chat-list",
      relayCapability: "PAIRING-FINGERPRINT",
      relaySealKeyBase64: key,
      conversationId: "conversation-1",
      streamId: "route-scoped-chat-list:phone",
      reconnectDelayMs: 50
    },
    sender([]),
    {
      async listChats() {
        return [
          {
            id: "conversation-1",
            title: "Allowed chat",
            group: "AccordAgents",
            snippet: "Visible through person invite",
            updatedAt: "2026-08-07T00:00:00.000Z",
            running: false,
            participants: ["@drew-codex-engineer"]
          },
          {
            id: "conversation-2",
            title: "Other chat",
            group: "AccordAgents",
            snippet: "Must not be exposed",
            updatedAt: "2026-08-07T00:00:00.000Z",
            running: false,
            participants: ["@taylor-claude-engineer"]
          }
        ];
      },
      async listTimeline() {
        return [];
      }
    }
  );
  const phone = new RelayTunnelClient({
    relayUrl: address.url,
    rendezvousId: "rv-scoped-chat-list",
    role: "phone",
    capability: "PAIRING-FINGERPRINT",
    streamId: "route-scoped-chat-list:phone"
  });
  try {
    const chatListMessage = nextMessage(phone);
    await desktop.connect();
    await phone.connect();
    await phone.sendCiphertext({
      logicalMessageId: "scoped-chat-list-request",
      ciphertext: await sealMobileRelayPayload({ type: "mobile.chat-list.request" }, key)
    });

    const payload = await openMobileRelayPayload(await chatListMessage.then((message) => message.ciphertext), key);
    assert.deepEqual(withoutGeneratedAt(payload), {
      type: "mobile.chat-list",
      chats: [{
        id: "conversation-1",
        title: "Allowed chat",
        group: "AccordAgents",
        snippet: "Visible through person invite",
        updatedAt: "2026-08-07T00:00:00.000Z",
        running: false,
        participants: ["@drew-codex-engineer"]
      }]
    });
  } finally {
    phone.close();
    desktop.close();
    await relay.close();
  }
});

test("MobileRelayControlService forwards participant progress to the phone after ack", async () => {
  const key = Buffer.from("d".repeat(32)).toString("base64url");
  const relay = createReferenceRelayServer();
  const address = await relay.listen();
  const desktop = new MobileRelayControlService(
    {
      relayUrl: address.url,
      rendezvousId: "rv-timeline",
      relayCapability: "PAIRING-FINGERPRINT",
      relaySealKeyBase64: key,
      conversationId: "conversation-1",
      streamId: "route-timeline:phone",
      reconnectDelayMs: 50
    },
    {
      ...sender([]),
      async sendMessage(request, _signal, progress) {
        progress?.({
          runId: request.runId ?? "run-missing",
          phase: "debate",
          message: "@cloud finished.",
          createdAt: "2026-08-07T00:00:01.000Z",
          agentProgress: {
            participantId: "participant-cloud",
            participantLabel: "@cloud",
            state: "finished",
            messageId: "message-cloud-result",
            partialContent: "cloud result visible on phone"
          }
        });
        return {
          conversation: {
            id: request.conversationId,
            kind: "chat",
            title: "Test chat",
            createdAt: "2026-08-07T00:00:00.000Z",
            updatedAt: "2026-08-07T00:00:01.000Z",
            messages: [],
            findings: [],
            metadata: {}
          },
          warnings: []
        };
      }
    }
  );
  const phone = new RelayTunnelClient({
    relayUrl: address.url,
    rendezvousId: "rv-timeline",
    role: "phone",
    capability: "PAIRING-FINGERPRINT",
    streamId: "route-timeline:phone"
  });
  try {
    const messages = nextMessages(phone, 3);
    await desktop.connect();
    await phone.connect();
    await phone.sendCiphertext({
      logicalMessageId: "event-cloud",
      ciphertext: await sealMobileRelayPayload({
        type: "mobile.outbox.events",
        events: [{
          eventId: "event-cloud",
          conversationId: "conversation-1",
          payload: { content: "@cloud run from phone" }
        }]
      }, key)
    });

    const [ackMessage, runningMessage, timelineMessage] = await messages;
    const ack = await openMobileRelayPayload<{ type: string }>(ackMessage.ciphertext, key);
    const running = await openMobileRelayPayload(runningMessage.ciphertext, key);
    const timeline = await openMobileRelayPayload(timelineMessage.ciphertext, key);
    assert.equal(ack.type, "mobile.outbox.ack");
    assertRunningTimeline(running, "conversation-1", "mobile-event-cloud", "@cloud");
    assert.deepEqual(timeline, {
      type: "mobile.timeline.events",
      conversationId: "conversation-1",
      events: [{
        id: "message-cloud-result",
        role: "participant",
        participantLabel: "@cloud",
        content: "cloud result visible on phone",
        status: "done",
        createdAt: "2026-08-07T00:00:01.000Z",
        runId: "mobile-event-cloud",
        messageId: "message-cloud-result"
      }]
    });
  } finally {
    phone.close();
    desktop.close();
    await relay.close();
  }
});

// Pending text stays live-only. The durable waiting row identifies the actual
// participant message once known, then that same row becomes the terminal.
test("MobileRelayControlService forwards terminal status when message content is unchanged, without a durable partial pending", async () => {
  const key = Buffer.from("s".repeat(32)).toString("base64url");
  const relay = createReferenceRelayServer();
  const address = await relay.listen();
  const desktop = new MobileRelayControlService(
    {
      relayUrl: address.url,
      rendezvousId: "rv-status-transition",
      relayCapability: "PAIRING-FINGERPRINT",
      relaySealKeyBase64: key,
      conversationId: "conversation-1",
      streamId: "route-status-transition:phone",
      reconnectDelayMs: 50
    },
    {
      ...sender([]),
      async sendMessage(request, _signal, progress) {
        for (const state of ["running", "finished"] as const) {
          progress?.({
            runId: request.runId ?? "run-missing",
            phase: state === "finished" ? "done" : "debate",
            message: "@cloud updated.",
            createdAt: state === "finished"
              ? "2026-08-07T00:00:02.000Z"
              : "2026-08-07T00:00:01.000Z",
            agentProgress: {
              participantId: "participant-cloud",
              participantLabel: "@cloud",
              state,
              messageId: "message-cloud-result",
              partialContent: "same rendered result"
            }
          });
        }
        return {
          conversation: {
            id: request.conversationId,
            kind: "chat",
            title: "Test chat",
            createdAt: "2026-08-07T00:00:00.000Z",
            updatedAt: "2026-08-07T00:00:02.000Z",
            messages: [],
            findings: [],
            metadata: {}
          },
          warnings: []
        };
      }
    }
  );
  const phone = new RelayTunnelClient({
    relayUrl: address.url,
    rendezvousId: "rv-status-transition",
    role: "phone",
    capability: "PAIRING-FINGERPRINT",
    streamId: "route-status-transition:phone"
  });
  try {
    const messages = nextMessages(phone, 4);
    let frameCount = 0;
    const unsubscribeCounter = phone.on("message", () => {
      frameCount += 1;
    });
    await desktop.connect();
    await phone.connect();
    await phone.sendCiphertext({
      logicalMessageId: "event-status-transition",
      ciphertext: await sealMobileRelayPayload({
        type: "mobile.outbox.events",
        events: [{
          eventId: "event-status-transition",
          conversationId: "conversation-1",
          payload: { content: "@cloud run from phone" }
        }]
      }, key)
    });

    const [, runningMessage, waitingMessage, doneMessage] = await messages;
    const running = await openMobileRelayPayload(runningMessage.ciphertext, key);
    const waiting = await openMobileRelayPayload(waitingMessage.ciphertext, key) as MobileTimelineEvents;
    const done = await openMobileRelayPayload(doneMessage.ciphertext, key);
    assertRunningTimeline(running, "conversation-1", "mobile-event-status-transition", "@cloud");
    assert.equal(waiting.events[0].content, "@cloud is running...");
    assert.equal(waiting.events[0].messageId, "message-cloud-result");
    assert.equal(waiting.events[0].status, "pending");
    assert.deepEqual(done, {
      type: "mobile.timeline.events",
      conversationId: "conversation-1",
      events: [{
        id: "message-cloud-result",
        role: "participant",
        participantLabel: "@cloud",
        content: "same rendered result",
        status: "done",
        createdAt: "2026-08-07T00:00:02.000Z",
        runId: "mobile-event-status-transition",
        messageId: "message-cloud-result"
      }]
    });
    // No later durable frame carries partial text or reopens the finished row.
    const seen = frameCount;
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(frameCount, seen, "no durable partial-pending frame may follow the terminal");
    unsubscribeCounter();
  } finally {
    phone.close();
    desktop.close();
    await relay.close();
  }
});

test("MobileRelayControlService pushes the resolved conversation timeline immediately after ack", async () => {
  const key = Buffer.from("g".repeat(32)).toString("base64url");
  const relay = createReferenceRelayServer();
  const address = await relay.listen();
  const desktop = new MobileRelayControlService(
    {
      relayUrl: address.url,
      rendezvousId: "rv-result-timeline",
      relayCapability: "PAIRING-FINGERPRINT",
      relaySealKeyBase64: key,
      conversationId: "conversation-1",
      streamId: "route-result-timeline:phone",
      reconnectDelayMs: 50
    },
    {
      ...sender([]),
      async sendMessage(request) {
        return {
          conversation: {
            id: request.conversationId,
            kind: "chat",
            title: "Test chat",
            createdAt: "2026-08-07T00:00:00.000Z",
            updatedAt: "2026-08-07T00:00:02.000Z",
            messages: [{
              id: "message-phone",
              role: "user",
              content: "@cloud run from phone",
              createdAt: "2026-08-07T00:00:01.000Z",
              status: "done"
            }, {
              id: "message-cloud-result",
              role: "participant",
              participantId: "participant-cloud",
              participantLabel: "@cloud",
              content: "resolved result visible without polling",
              createdAt: "2026-08-07T00:00:02.000Z",
              status: "done"
            }],
            findings: [],
            metadata: {}
          },
          warnings: []
        };
      }
    }
  );
  const phone = new RelayTunnelClient({
    relayUrl: address.url,
    rendezvousId: "rv-result-timeline",
    role: "phone",
    capability: "PAIRING-FINGERPRINT",
    streamId: "route-result-timeline:phone"
  });
  try {
    const messages = nextMessages(phone, 3);
    await desktop.connect();
    await phone.connect();
    await phone.sendCiphertext({
      logicalMessageId: "event-result",
      ciphertext: await sealMobileRelayPayload({
        type: "mobile.outbox.events",
        events: [{
          eventId: "event-result",
          conversationId: "conversation-1",
          payload: { content: "@cloud run from phone" }
        }]
      }, key)
    });

    const [ackMessage, runningMessage, timelineMessage] = await messages;
    const ack = await openMobileRelayPayload<{ type: string }>(ackMessage.ciphertext, key);
    const running = await openMobileRelayPayload(runningMessage.ciphertext, key);
    const timeline = await openMobileRelayPayload(timelineMessage.ciphertext, key);
    assert.equal(ack.type, "mobile.outbox.ack");
    assertRunningTimeline(running, "conversation-1", "mobile-event-result", "@cloud");
    assert.deepEqual(timeline, {
      type: "mobile.timeline.events",
      conversationId: "conversation-1",
      events: [{
        id: "message-cloud-result",
        role: "participant",
        participantLabel: "@cloud",
        content: "resolved result visible without polling",
        status: "done",
        createdAt: "2026-08-07T00:00:02.000Z",
        // The message carries no run of its own, so it falls back to its own
        // id — NOT the sending run's. Lending the send's id to history rows is
        // what made the phone read them as that run ending.
        runId: "message-cloud-result",
        messageId: "message-cloud-result"
      }]
    });
  } finally {
    phone.close();
    desktop.close();
    await relay.close();
  }
});

test("MobileRelayControlService forwards remote waiting status without provider text", async () => {
  const key = Buffer.from("e".repeat(32)).toString("base64url");
  const relay = createReferenceRelayServer();
  const address = await relay.listen();
  const desktop = new MobileRelayControlService(
    {
      relayUrl: address.url,
      rendezvousId: "rv-waiting-runner",
      relayCapability: "PAIRING-FINGERPRINT",
      relaySealKeyBase64: key,
      conversationId: "conversation-1",
      streamId: "route-waiting-runner:phone",
      reconnectDelayMs: 50
    },
    {
      ...sender([]),
      async sendMessage(request, _signal, progress) {
        progress?.({
          runId: request.runId ?? "run-missing",
          phase: "debate",
          message: "Waiting for runner",
          createdAt: "2026-08-07T00:00:01.000Z",
          agentProgress: {
            participantId: "participant-cloud",
            participantLabel: "@cloud",
            state: "running",
            messageId: "message-cloud-waiting",
            activity: "Waiting for runner",
            remoteRunStatus: {
              phase: "waiting-for-runner",
              label: "Waiting for runner",
              detail: "No cloud runner is available.",
              startedAt: "2026-08-07T00:00:01.000Z",
              updatedAt: "2026-08-07T00:00:01.000Z"
            }
          }
        });
        return {
          conversation: {
            id: request.conversationId,
            kind: "chat",
            title: "Test chat",
            createdAt: "2026-08-07T00:00:00.000Z",
            updatedAt: "2026-08-07T00:00:01.000Z",
            messages: [],
            findings: [],
            metadata: {}
          },
          warnings: []
        };
      }
    }
  );
  const phone = new RelayTunnelClient({
    relayUrl: address.url,
    rendezvousId: "rv-waiting-runner",
    role: "phone",
    capability: "PAIRING-FINGERPRINT",
    streamId: "route-waiting-runner:phone"
  });
  try {
    const messages = nextMessages(phone, 3);
    await desktop.connect();
    await phone.connect();
    await phone.sendCiphertext({
      logicalMessageId: "event-waiting-runner",
      ciphertext: await sealMobileRelayPayload({
        type: "mobile.outbox.events",
        events: [{
          eventId: "event-waiting-runner",
          conversationId: "conversation-1",
          payload: { content: "@cloud run from phone" }
        }]
      }, key)
    });

    const [, runningMessage, timelineMessage] = await messages;
    const running = await openMobileRelayPayload(runningMessage.ciphertext, key);
    const timeline = await openMobileRelayPayload(timelineMessage.ciphertext, key);
    assertRunningTimeline(running, "conversation-1", "mobile-event-waiting-runner", "@cloud");
    assert.deepEqual(timeline, {
      type: "mobile.timeline.events",
      conversationId: "conversation-1",
      events: [{
        id: "message-cloud-waiting",
        role: "participant",
        participantLabel: "@cloud",
        content: "Waiting for runner",
        status: "pending",
        createdAt: "2026-08-07T00:00:01.000Z",
        runId: "mobile-event-waiting-runner",
        messageId: "message-cloud-waiting"
      }]
    });
  } finally {
    phone.close();
    desktop.close();
    await relay.close();
  }
});

test("MobileRelayControlService pushes a terminal conversation snapshot for non-cloud mobile runs", async () => {
  const key = Buffer.from("h".repeat(32)).toString("base64url");
  const relay = createReferenceRelayServer();
  const address = await relay.listen();
  const desktop = new MobileRelayControlService(
    {
      relayUrl: address.url,
      rendezvousId: "rv-non-cloud-terminal",
      relayCapability: "PAIRING-FINGERPRINT",
      relaySealKeyBase64: key,
      conversationId: "conversation-1",
      streamId: "route-non-cloud-terminal:phone",
      reconnectDelayMs: 50
    },
    {
      ...sender([]),
      async sendMessage(request, _signal, progress) {
        progress?.({
          runId: request.runId ?? "run-missing",
          phase: "done",
          message: "Chat turn finished.",
          createdAt: "2026-08-07T00:00:03.000Z"
        });
        return {
          conversation: {
            id: request.conversationId,
            kind: "chat",
            title: "Test chat",
            createdAt: "2026-08-07T00:00:00.000Z",
            updatedAt: "2026-08-07T00:00:03.000Z",
            messages: [],
            findings: [],
            metadata: {}
          },
          warnings: []
        };
      }
    },
    {
      async listChats() {
        return [];
      },
      async listTimeline() {
        return [{
          id: "message-local-result",
          role: "participant",
          participantLabel: "@local",
          content: "**local result**\n- with markdown",
          status: "done",
          createdAt: "2026-08-07T00:00:02.000Z",
          messageId: "message-local-result"
        }];
      }
    }
  );
  const phone = new RelayTunnelClient({
    relayUrl: address.url,
    rendezvousId: "rv-non-cloud-terminal",
    role: "phone",
    capability: "PAIRING-FINGERPRINT",
    streamId: "route-non-cloud-terminal:phone"
  });
  try {
    const messages = nextMessages(phone, 3);
    await desktop.connect();
    await phone.connect();
    await phone.sendCiphertext({
      logicalMessageId: "event-non-cloud",
      ciphertext: await sealMobileRelayPayload({
        type: "mobile.outbox.events",
        events: [{
          eventId: "event-non-cloud",
          conversationId: "conversation-1",
          createdAt: "2026-08-07T00:00:01.000Z",
          payload: { content: "@local run from phone" }
        }]
      }, key)
    });

    const [ackMessage, runningMessage, snapshotMessage] = await messages;
    const ack = await openMobileRelayPayload<{ type: string }>(ackMessage.ciphertext, key);
    const running = await openMobileRelayPayload(runningMessage.ciphertext, key);
    const snapshot = await openMobileRelayPayload(snapshotMessage.ciphertext, key);
    assert.equal(ack.type, "mobile.outbox.ack");
    assertRunningTimeline(running, "conversation-1", "mobile-event-non-cloud", "@local");
    assert.deepEqual(snapshot, {
      type: "mobile.timeline.events",
      conversationId: "conversation-1",
      events: [{
        id: "message-local-result",
        role: "participant",
        participantLabel: "@local",
        content: "**local result**\n- with markdown",
        status: "done",
        createdAt: "2026-08-07T00:00:02.000Z",
        runId: "mobile-event-non-cloud",
        messageId: "message-local-result"
      }]
    });
  } finally {
    phone.close();
    desktop.close();
    await relay.close();
  }
});

test("MobileRelayControlService pushes desktop conversation snapshots to the phone", async () => {
  const key = Buffer.from("j".repeat(32)).toString("base64url");
  const relay = createReferenceRelayServer();
  const address = await relay.listen();
  const desktop = new MobileRelayControlService(
    {
      relayUrl: address.url,
      rendezvousId: "rv-desktop-snapshot",
      relayCapability: "PAIRING-FINGERPRINT",
      relaySealKeyBase64: key,
      conversationId: "conversation-1",
      streamId: "route-desktop-snapshot:phone",
      reconnectDelayMs: 50
    },
    sender([])
  );
  const phone = new RelayTunnelClient({
    relayUrl: address.url,
    rendezvousId: "rv-desktop-snapshot",
    role: "phone",
    capability: "PAIRING-FINGERPRINT",
    streamId: "route-desktop-snapshot:phone"
  });
  const conversation: Conversation = {
    id: "conversation-1",
    kind: "chat",
    title: "Test chat",
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:04.000Z",
    messages: [{
      id: "message-phone",
      role: "user",
      content: "@cloud run from phone",
      createdAt: "2026-08-07T00:00:01.000Z",
      status: "done"
    }, {
      id: "message-cloud-result",
      role: "participant",
      participantId: "participant-cloud",
      participantLabel: "@cloud",
      content: "remote result pushed after replay",
      createdAt: "2026-08-07T00:00:04.000Z",
      status: "done",
      metadata: {
        runId: "remote-run-1",
        appMessageSource: "remote-run-provider-output"
      }
    }],
    findings: [],
    metadata: {}
  };
  try {
    const message = nextMessage(phone);
    await desktop.connect();
    await phone.connect();
    desktop.pushConversationSnapshot(conversation);

    const timeline = await openMobileRelayPayload(await message.then((next) => next.ciphertext), key);
    assert.deepEqual(timeline, {
      type: "mobile.timeline.events",
      conversationId: "conversation-1",
      events: [{
        id: "message-phone",
        role: "you",
        content: "@cloud run from phone",
        status: "done",
        createdAt: "2026-08-07T00:00:01.000Z",
        runId: "message-phone",
        messageId: "message-phone"
      }, {
        id: "message-cloud-result",
        role: "participant",
        participantLabel: "@cloud",
        content: "remote result pushed after replay",
        status: "done",
        createdAt: "2026-08-07T00:00:04.000Z",
        runId: "remote-run-1",
        messageId: "message-cloud-result"
      }],
      cards: []
    });
  } finally {
    phone.close();
    desktop.close();
    await relay.close();
  }
});

test("MobileRelayControlService rejects mobile events outside the paired conversation", async () => {
  const key = Buffer.from("c".repeat(32)).toString("base64url");
  const service = new MobileRelayControlService(
    {
      relayUrl: "ws://127.0.0.1:1/v1/relay",
      rendezvousId: "rv-scope",
      relayCapability: "PAIRING-FINGERPRINT",
      relaySealKeyBase64: key,
      conversationId: "conversation-1",
      streamId: "route-scope:phone"
    },
    sender([])
  );
  const sealed = await sealMobileRelayPayload({
    type: "mobile.outbox.events",
    events: [{
      eventId: "event-3",
      conversationId: "conversation-2",
      payload: { content: "wrong scope" }
    }]
  }, key);

  await assert.rejects(
    () => service.acceptSealedMobileOutbox(sealed),
    /outside the paired scope/
  );
  service.close();
});

test("MobileRelayControlService processes mailbox outbox events and publishes timeline without a live relay", async () => {
  const published: unknown[] = [];
  const sent: unknown[] = [];
  const service = new MobileRelayControlService(
    {
      relayUrl: "ws://127.0.0.1:1/v1/relay",
      rendezvousId: "rv-mailbox",
      relayCapability: "PAIRING-FINGERPRINT",
      relaySealKeyBase64: Buffer.from("m".repeat(32)).toString("base64url"),
      conversationId: "conversation-1",
      streamId: "route-mailbox:phone"
    },
    {
      ...sender([]),
      async sendMessage(request) {
        sent.push({
          conversationId: request.conversationId,
          content: request.content,
          runId: request.runId,
          mobileEventId: request.mobileEventId
        });
        return {
          conversation: {
            id: request.conversationId,
            kind: "chat",
            title: "Test chat",
            createdAt: "2026-08-07T00:00:00.000Z",
            updatedAt: "2026-08-07T00:00:03.000Z",
            messages: [{
              id: "message-mailbox-result",
              role: "participant",
              participantId: "participant-cloud",
              participantLabel: "@cloud",
              content: "mailbox result visible on phone",
              createdAt: "2026-08-07T00:00:03.000Z",
              status: "done"
            }],
            findings: [],
            metadata: {}
          },
          warnings: []
        };
      }
    },
    undefined,
    undefined,
    {
      async publishTimeline(timeline) {
        published.push(timeline);
      }
    }
  );

  const accepted = await service.acceptMobileOutboxEvents([{
    eventId: "event-mailbox",
    conversationId: "conversation-1",
    createdAt: "2026-08-07T00:00:01.000Z",
    payload: { content: "@cloud run while desktop relay is unavailable" }
  }]);

  assert.deepEqual(accepted, {
    eventIds: ["event-mailbox"],
    runIds: ["mobile-event-mailbox"]
  });
  assert.deepEqual(sent, [{
    conversationId: "conversation-1",
    content: "@cloud run while desktop relay is unavailable",
    runId: "mobile-event-mailbox",
    mobileEventId: "event-mailbox"
  }]);
  assert.equal(published.length, 2);
  assertRunningTimeline(published[0], "conversation-1", "mobile-event-mailbox", "@cloud");
  assert.deepEqual(published[1], {
    type: "mobile.timeline.events",
    conversationId: "conversation-1",
    events: [{
      id: "message-mailbox-result",
      role: "participant",
      participantLabel: "@cloud",
      content: "mailbox result visible on phone",
      status: "done",
      createdAt: "2026-08-07T00:00:03.000Z",
      // Own id, not the sending run's: the conversation projection must not
      // lend one run's identity to messages that do not belong to it.
      runId: "message-mailbox-result",
      messageId: "message-mailbox-result"
    }]
  });
  service.close();
});

test("MobileRelayControlService fences concurrent relay and mailbox delivery for one mobile event", async () => {
  const key = Buffer.from("m".repeat(32)).toString("base64url");
  const releaseAcceptedCheck = deferred<boolean>();
  const sent: unknown[] = [];
  const published: MobileTimelineEvents[] = [];
  let acceptedChecks = 0;
  const service = new MobileRelayControlService(
    {
      relayUrl: "ws://127.0.0.1:1/v1/relay",
      rendezvousId: "rv-concurrent-dedupe",
      relayCapability: "PAIRING-FINGERPRINT",
      relaySealKeyBase64: key,
      conversationId: "conversation-1",
      streamId: "route-concurrent-dedupe:phone"
    },
    {
      ...sender([]),
      async hasAcceptedMobileEvent() {
        acceptedChecks += 1;
        return releaseAcceptedCheck.promise;
      },
      async sendMessage(request) {
        sent.push({
          conversationId: request.conversationId,
          content: request.content,
          runId: request.runId,
          mobileEventId: request.mobileEventId
        });
        return {
          conversation: {
            id: request.conversationId,
            kind: "chat",
            title: "Test chat",
            createdAt: "2026-08-07T00:00:00.000Z",
            updatedAt: "2026-08-07T00:00:00.000Z",
            messages: [],
            findings: [],
            metadata: {}
          },
          warnings: []
        };
      }
    },
    undefined,
    undefined,
    { async publishTimeline(timeline) { published.push(timeline); } }
  );
  const event = {
    eventId: "event-concurrent",
    conversationId: "conversation-1",
    createdAt: "2026-08-07T00:00:01.000Z",
    payload: { content: "@cloud run once" }
  };
  try {
    const first = service.acceptMobileOutboxEvents([event], "mailbox");
    await waitFor(() => acceptedChecks === 1);
    const second = service.acceptMobileOutboxEvents([event], "relay");
    releaseAcceptedCheck.resolve(false);

    assert.deepEqual(await Promise.all([first, second]), [{
      eventIds: ["event-concurrent"],
      runIds: ["mobile-event-concurrent"]
    }, {
      eventIds: ["event-concurrent"],
      runIds: ["mobile-event-concurrent"]
    }]);
    assert.deepEqual(sent, [{
      conversationId: "conversation-1",
      content: "@cloud run once",
      runId: "mobile-event-concurrent",
      mobileEventId: "event-concurrent"
    }]);
    assert.equal(published.length, 1);
    assertRunningTimeline(published[0], "conversation-1", "mobile-event-concurrent", "@cloud");
  } finally {
    releaseAcceptedCheck.resolve(false);
    service.close();
  }
});

test("MobileRelayControlService skips buffered relay delivery when mailbox already has the mobile result", async () => {
  const key = Buffer.from("r".repeat(32)).toString("base64url");
  const sent: unknown[] = [];
  const published: MobileTimelineEvents[] = [];
  let resultChecks = 0;
  const service = new MobileRelayControlService(
    {
      relayUrl: "ws://127.0.0.1:1/v1/relay",
      rendezvousId: "rv-mailbox-result-dedupe",
      relayCapability: "PAIRING-FINGERPRINT",
      relaySealKeyBase64: key,
      conversationId: "conversation-1",
      streamId: "route-mailbox-result-dedupe:phone"
    },
    {
      ...sender([]),
      async hasAcceptedMobileEvent() {
        return false;
      },
      async hasMobileMailboxResultForMobileEvent(conversationId, eventId) {
        resultChecks += 1;
        return conversationId === "conversation-1" && eventId === "event-fulfilled";
      },
      async sendMessage(request) {
        sent.push(request);
        throw new Error("sendMessage should not run for a fulfilled mobile mailbox event.");
      }
    },
    undefined,
    undefined,
    { async publishTimeline(timeline) { published.push(timeline); } }
  );
  try {
    const result = await service.acceptMobileOutboxEvents([{
      eventId: "event-fulfilled",
      conversationId: "conversation-1",
      createdAt: "2026-08-07T00:00:01.000Z",
      payload: { content: "@cloud already done" }
    }], "relay");

    assert.deepEqual(result, {
      eventIds: ["event-fulfilled"],
      runIds: ["mobile-event-fulfilled"]
    });
    assert.equal(resultChecks, 1);
    assert.deepEqual(sent, []);
    assert.deepEqual(published, []);
  } finally {
    service.close();
  }
});

function sender(sent: unknown[]): MobileRelayChatSender {
  return {
    async readChatAttachment() {
      throw new Error("No attachment in this fixture");
    },
    async sendMessage(request) {
      sent.push({
        conversationId: request.conversationId,
        content: request.content,
        runId: request.runId
      });
      return {
        conversation: {
          id: request.conversationId,
          kind: "chat",
          title: "Test chat",
          createdAt: "2026-08-07T00:00:00.000Z",
          updatedAt: "2026-08-07T00:00:00.000Z",
          messages: [],
          findings: [],
          metadata: {}
        },
        warnings: []
      };
    }
  };
}

function nextMessage(client: RelayTunnelClient): Promise<{ logicalMessageId: string; ciphertext: string }> {
  return new Promise((resolve) => {
    const off = client.on("message", (message) => {
      off();
      resolve(message);
    });
  });
}

function nextMessages(client: RelayTunnelClient, count: number): Promise<{ logicalMessageId: string; ciphertext: string }[]> {
  return new Promise((resolve) => {
    const messages: { logicalMessageId: string; ciphertext: string }[] = [];
    const off = client.on("message", (message) => {
      messages.push(message);
      if (messages.length >= count) {
        off();
        resolve(messages);
      }
    });
  });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition.");
}

function assertRunningTimeline(
  payload: unknown,
  conversationId: string,
  runId: string,
  participantLabel: string
): void {
  assert.equal((payload as { type?: string }).type, "mobile.timeline.events");
  assert.equal((payload as { conversationId?: string }).conversationId, conversationId);
  const events = (payload as { events?: unknown[] }).events;
  assert.equal(Array.isArray(events), true);
  assert.equal(events?.length, 1);
  assert.deepEqual({
    ...(events?.[0] as object),
    createdAt: "dynamic"
  }, {
    id: `${runId}:${participantLabel}`,
    role: "participant",
    participantLabel,
    content: `${participantLabel} is running...`,
    status: "pending",
    createdAt: "dynamic",
    runId,
    messageId: `${runId}:${participantLabel}`,
    mobileEventId: runId.startsWith("mobile-") ? runId.slice("mobile-".length) : undefined
  });
}

// W-C: the doorbell must ring exactly once per finished run, and a
// desktop-originated run never reaches the terminal-progress path here — the
// phone learns of it through conversation snapshots. This has now broken twice
// in opposite directions: inferring the marker from batch contents rang at the
// start of a run as well as the end, and removing the inference left
// desktop-originated runs silent.
test("MobileRelayControlService marks only the snapshot where a run stops being active", async () => {
  const key = Buffer.from("c".repeat(32)).toString("base64url");
  const published: Array<{ runFinished: boolean }> = [];
  const service = new MobileRelayControlService(
    {
      relayUrl: "ws://127.0.0.1:1/v1/relay",
      rendezvousId: "rv-run-finished",
      relayCapability: "cap",
      relaySealKeyBase64: key,
      conversationId: "conversation-1",
      streamId: "route:phone"
    },
    { async sendMessage() { throw new Error("not used"); } } as unknown as MobileRelayChatSender,
    undefined,
    undefined,
    {
      async publishTimeline(_timeline: MobileTimelineEvents, options?: { runFinished?: boolean }) {
        published.push({ runFinished: options?.runFinished === true });
      }
    }
  );

  // Each snapshot carries a genuinely new message: an unchanged batch is
  // dropped as already-delivered and never reaches the sink at all.
  let messageSeq = 0;
  const snapshot = (activeRunIds: string[], updatedAt: string, status = "done"): Conversation => {
    messageSeq += 1;
    return {
      id: "conversation-1",
      kind: "chat",
      title: "Test chat",
      createdAt: "2026-08-17T00:00:00.000Z",
      updatedAt,
      messages: [{
        id: `m${messageSeq}`,
        role: "participant",
        participantLabel: "@drew",
        content: `An answer ${messageSeq}.`,
        status,
        createdAt: `2026-08-17T00:00:0${messageSeq}.000Z`
      }],
      findings: [],
      metadata: { activeRunIds }
    } as unknown as Conversation;
  };

  const waitForPublished = async (count: number) => {
    for (let i = 0; i < 50 && published.length < count; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  // First snapshot after start: no transition is observable, so no ring — this
  // is what keeps a reconnect from ringing.
  service.pushConversationSnapshot(snapshot([], "2026-08-17T00:00:02.000Z"));
  await waitForPublished(1);
  assert.deepEqual(published, [{ runFinished: false }], "the first snapshot never rings");

  // A run starts: still no finish.
  service.pushConversationSnapshot(snapshot(["run-a"], "2026-08-17T00:00:03.000Z", "pending"));
  await waitForPublished(2);
  assert.deepEqual(published[1], { runFinished: false }, "a run starting is not a run finishing");

  // The finished answer is published while the run is still active — this is
  // what actually happens, about a second before the active set clears — so the
  // batch carrying it must be the one that rings.
  service.pushConversationSnapshot(snapshot(["run-a"], "2026-08-17T00:00:04.000Z"));
  await waitForPublished(3);
  assert.deepEqual(published[2], { runFinished: true }, "the batch carrying the finished answer rings");

  // The run disappears: that transition rings too, but by then there is
  // normally nothing new to send, so it is a backstop rather than the path.
  service.pushConversationSnapshot(snapshot([], "2026-08-17T00:00:05.000Z"));
  await waitForPublished(4);
  assert.deepEqual(published[3], { runFinished: true }, "the run leaving the active set rings");

  // A later batch carrying no participant terminal does not ring.
  service.pushConversationSnapshot({
    ...snapshot([], "2026-08-17T00:00:06.000Z"),
    messages: [{
      id: "m-you",
      role: "you",
      content: "another question",
      status: "done",
      createdAt: "2026-08-17T00:00:06.000Z"
    }]
  } as unknown as Conversation);
  await waitForPublished(5);
  assert.deepEqual(published[4], { runFinished: false }, "the user's own message never rings");

  service.close();
});

// W-C: an interrupted run produces no terminal of its own — the process died
// mid-answer. Recovery is the only thing that can tell the phone, and it must
// both ring and clear the row, or the ring announces an answer the phone still
// shows as running.
test("MobileRelayControlService publishes recovered interrupted runs as a marked terminal", async () => {
  const key = Buffer.from("d".repeat(32)).toString("base64url");
  const published: Array<{ runFinished: boolean; events: MobileTimelineEvents["events"] }> = [];
  const service = new MobileRelayControlService(
    {
      relayUrl: "ws://127.0.0.1:1/v1/relay",
      rendezvousId: "rv-recovery",
      relayCapability: "cap",
      relaySealKeyBase64: key,
      conversationId: "conversation-1",
      streamId: "route:phone"
    },
    { async sendMessage() { throw new Error("not used"); } } as unknown as MobileRelayChatSender,
    undefined,
    undefined,
    {
      async publishTimeline(timeline: MobileTimelineEvents, options?: { runFinished?: boolean }) {
        published.push({ runFinished: options?.runFinished === true, events: timeline.events });
      }
    }
  );

  const conversation = {
    id: "conversation-1",
    kind: "chat",
    title: "Test chat",
    createdAt: "2026-08-17T00:00:00.000Z",
    updatedAt: "2026-08-17T00:00:09.000Z",
    messages: [],
    findings: [],
    metadata: {}
  } as unknown as Conversation;

  const recovered = [{
    id: "m-interrupted",
    role: "participant",
    participantLabel: "@drew",
    content: "Interrupted before completion.",
    status: "error",
    createdAt: "2026-08-17T00:00:09.000Z",
    metadata: { runId: "run-dead" }
  }] as unknown as Parameters<typeof service.pushRecoveredRunTerminals>[1];

  service.pushRecoveredRunTerminals(conversation, recovered);
  for (let i = 0; i < 50 && published.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(published.length, 1, "recovery publishes exactly one batch");
  assert.equal(published[0].runFinished, true, "the recovery batch rings — nothing else ever will");
  const event = published[0].events[0];
  // The phone clears a pending row only for a participant event that is no
  // longer pending (W-N). Ring and row-clear have to agree, or the phone buzzes
  // for an answer it still shows as running.
  assert.equal(event.role, "participant", "the recovered terminal comes from the agent, not the system");
  assert.notEqual(event.status, "pending", "the recovered terminal is not pending");
  assert.equal(event.runId, "run-dead", "it carries the dead run's id so the phone can match the row");

  service.close();
});

// Gera's finding 1: recovery must not warm the transition map. Warming it flips
// the next snapshot out of first-delivery silence, and recovery's own save
// pushes that snapshot — so the cold history arrives as "newly delivered", the
// content arm trips on some old participant answer, and a second ring lands one
// debounce window later.
test("MobileRelayControlService does not ring again on the snapshot that follows recovery", async () => {
  const key = Buffer.from("e".repeat(32)).toString("base64url");
  const published: Array<{ runFinished: boolean }> = [];
  const service = new MobileRelayControlService(
    {
      relayUrl: "ws://127.0.0.1:1/v1/relay",
      rendezvousId: "rv-recovery-then-snapshot",
      relayCapability: "cap",
      relaySealKeyBase64: key,
      conversationId: "conversation-1",
      streamId: "route:phone"
    },
    { async sendMessage() { throw new Error("not used"); } } as unknown as MobileRelayChatSender,
    undefined,
    undefined,
    {
      async publishTimeline(_timeline: MobileTimelineEvents, options?: { runFinished?: boolean }) {
        published.push({ runFinished: options?.runFinished === true });
      }
    }
  );

  const conversation = {
    id: "conversation-1",
    kind: "chat",
    title: "Test chat",
    createdAt: "2026-08-17T00:00:00.000Z",
    updatedAt: "2026-08-17T00:00:09.000Z",
    // Cold history: finished participant answers from before the crash.
    messages: [
      { id: "old-1", role: "participant", participantLabel: "@drew", content: "An older answer.", status: "done", createdAt: "2026-08-17T00:00:01.000Z" },
      { id: "m-interrupted", role: "participant", participantLabel: "@drew", content: "Interrupted before completion.", status: "error", createdAt: "2026-08-17T00:00:09.000Z", metadata: { runId: "run-dead" } }
    ],
    findings: [],
    metadata: {}
  } as unknown as Conversation;

  const recovered = [conversation.messages[1]] as unknown as Parameters<typeof service.pushRecoveredRunTerminals>[1];
  service.pushRecoveredRunTerminals(conversation, recovered);
  for (let i = 0; i < 50 && published.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(published[0]?.runFinished, true, "recovery itself rings");

  // Recovery saves the conversation, and the save pushes a snapshot.
  service.pushConversationSnapshot(conversation);
  for (let i = 0; i < 50 && published.length < 2; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(published.length, 2, "the snapshot after recovery is published");
  assert.equal(published[1].runFinished, false, "but it must not ring a second time");

  service.close();
});

// Gera's finding 2: for a phone-originated run the finish was carried by an
// UNMARKED progress batch, and the marked batch was the catalog re-projection
// that follows it. Whether that re-projection survives the already-delivered
// filter is a string comparison — identical projection meant the marked batch
// dedups empty and the run never rings at all; a differing one meant a second
// ring later. The marker belongs on the batch that carries the finish.
test("MobileRelayControlService rings exactly once for a phone-originated finish, even when the catalog re-projection is identical", async () => {
  const key = Buffer.from("f".repeat(32)).toString("base64url");
  const published: Array<{ runFinished: boolean; count: number; statuses: string[] }> = [];
  const identicalProjection = [{
    id: "message-cloud-result",
    role: "participant" as const,
    participantLabel: "@cloud",
    content: "same rendered result",
    status: "done" as const,
    createdAt: "2026-08-07T00:00:02.000Z",
    runId: "mobile-event-identical",
    messageId: "message-cloud-result"
  }];
  const service = new MobileRelayControlService(
    {
      relayUrl: "ws://127.0.0.1:1/v1/relay",
      rendezvousId: "rv-identical-projection",
      relayCapability: "cap",
      relaySealKeyBase64: key,
      conversationId: "conversation-1",
      streamId: "route:phone"
    },
    {
      async sendMessage(
        request: Parameters<MobileRelayChatSender["sendMessage"]>[0],
        _signal: Parameters<MobileRelayChatSender["sendMessage"]>[1],
        progress: Parameters<MobileRelayChatSender["sendMessage"]>[2]
      ) {
        for (const state of ["running", "finished"] as const) {
          progress?.({
            runId: request.runId ?? "run-missing",
            phase: state === "finished" ? "done" : "debate",
            message: "@cloud updated.",
            createdAt: state === "finished" ? "2026-08-07T00:00:02.000Z" : "2026-08-07T00:00:01.000Z",
            agentProgress: {
              participantId: "participant-cloud",
              participantLabel: "@cloud",
              state,
              messageId: "message-cloud-result",
              partialContent: "same rendered result"
            }
          });
        }
        return {
          conversation: {
            id: request.conversationId,
            kind: "chat",
            title: "Test chat",
            createdAt: "2026-08-07T00:00:00.000Z",
            updatedAt: "2026-08-07T00:00:02.000Z",
            messages: [],
            findings: [],
            metadata: {}
          },
          warnings: []
        };
      }
    } as unknown as MobileRelayChatSender,
    {
      async listChats() { return []; },
      // Exactly what the terminal progress already delivered.
      async listTimeline() { return identicalProjection; }
    },
    undefined,
    {
      async publishTimeline(timeline: MobileTimelineEvents, options?: { runFinished?: boolean }) {
        published.push({
          runFinished: options?.runFinished === true,
          count: timeline.events.length,
          statuses: timeline.events.map((event) => String(event.status))
        });
      }
    }
  );

  try {
    await service.acceptMobileOutboxEvents([{
      eventId: "event-identical",
      conversationId: "conversation-1",
      createdAt: "2026-08-07T00:00:00.500Z",
      payload: { content: "@cloud run from phone" }
    }], "mailbox");
    for (let i = 0; i < 80 && published.length < 2; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const marked = published.filter((entry) => entry.runFinished);
    assert.equal(marked.length, 1, `exactly one batch rings, got ${JSON.stringify(published)}`);
    assert.ok(marked[0].count > 0, "the ringing batch is not empty, so it actually reaches the relay");
    assert.ok(
      marked[0].statuses.every((status) => status !== "pending"),
      "the ringing batch carries the finish, not progress"
    );
  } finally {
    service.close();
  }
});

// Found in use, twice over: one finished answer produced two notifications.
// The terminal message is delivered once as the terminal progress batch and
// again inside the conversation snapshot a second later, with a different
// projection and therefore a different delivery signature — so the
// already-delivered filter lets it through and the content arm marks it a
// second time. A run is announced finished once.
test("MobileRelayControlService announces a finished run exactly once", async () => {
  const key = Buffer.from("g".repeat(32)).toString("base64url");
  const published: Array<{ runFinished: boolean; statuses: string[] }> = [];
  const service = new MobileRelayControlService(
    {
      relayUrl: "ws://127.0.0.1:1/v1/relay",
      rendezvousId: "rv-announce-once",
      relayCapability: "cap",
      relaySealKeyBase64: key,
      conversationId: "conversation-1",
      streamId: "route:phone"
    },
    { async sendMessage() { throw new Error("not used"); } } as unknown as MobileRelayChatSender,
    undefined,
    undefined,
    {
      async publishTimeline(timeline: MobileTimelineEvents, options?: { runFinished?: boolean }) {
        published.push({
          runFinished: options?.runFinished === true,
          statuses: timeline.events.map((event) => `${event.role}:${event.status}`)
        });
      }
    }
  );

  const snapshotWith = (messages: unknown[], updatedAt: string) => ({
    id: "conversation-1",
    kind: "chat",
    title: "Test chat",
    createdAt: "2026-08-17T00:00:00.000Z",
    updatedAt,
    messages,
    findings: [],
    metadata: { activeRunIds: ["run-x"] }
  } as unknown as Conversation);

  const answer = (content: string) => ({
    id: "m-answer",
    role: "participant",
    participantLabel: "@drew",
    content,
    status: "done",
    createdAt: "2026-08-17T00:00:05.000Z",
    metadata: { runId: "run-x" }
  });

  const waitFor = async (count: number) => {
    for (let i = 0; i < 60 && published.length < count; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  // Warm the conversation so the first-delivery guard is not what is being
  // tested here.
  service.pushConversationSnapshot(snapshotWith([{
    id: "m-old", role: "participant", participantLabel: "@drew",
    content: "older", status: "done", createdAt: "2026-08-17T00:00:01.000Z"
  }], "2026-08-17T00:00:01.000Z"));
  await waitFor(1);

  // The finish, then the snapshot that follows carrying the same answer with a
  // different projection — different text is exactly what defeats the
  // already-delivered filter in the field.
  service.pushConversationSnapshot(snapshotWith([answer("The finished answer.")], "2026-08-17T00:00:05.000Z"));
  await waitFor(2);
  service.pushConversationSnapshot(snapshotWith([answer("The finished answer. ")], "2026-08-17T00:00:06.000Z"));
  await waitFor(3);

  const rings = published.filter((entry) => entry.runFinished);
  assert.equal(rings.length, 1, `one finished run rings once, got ${JSON.stringify(published)}`);

  service.close();
});

// W-M: a run started on the desktop must reach a watching phone as it is
// written. Its progress never reaches this service otherwise, so the phone saw
// one placeholder and then nothing until the answer landed — nothing to watch,
// and nothing to tap.
test("MobileRelayControlService streams desktop-run progress live and never persists it", async () => {
  const key = Buffer.from("h".repeat(32)).toString("base64url");
  const persisted: MobileTimelineEvents[] = [];
  const service = new MobileRelayControlService(
    {
      relayUrl: "ws://127.0.0.1:1/v1/relay",
      rendezvousId: "rv-desktop-stream",
      relayCapability: "cap",
      relaySealKeyBase64: key,
      conversationId: "conversation-1",
      streamId: "route:phone"
    },
    { async sendMessage() { throw new Error("not used"); } } as unknown as MobileRelayChatSender,
    undefined,
    undefined,
    { async publishTimeline(timeline: MobileTimelineEvents) { persisted.push(timeline); } }
  );

  const tick = (text: string, state: "running" | "finished", createdAt: string) => ({
    runId: "run-desktop",
    phase: state === "finished" ? "done" : "debate",
    message: "@drew is writing.",
    createdAt,
    agentProgress: {
      participantId: "participant-drew",
      participantLabel: "@drew",
      state,
      messageId: "message-drew",
      partialContent: text
    }
  }) as unknown as Parameters<typeof service.noteExternalChatProgress>[0];

  try {
    service.noteExternalChatProgress(tick("Half a sen", "running", "2026-08-17T00:00:01.000Z"));
    service.noteExternalChatProgress(tick("Half a sentence, then more.", "running", "2026-08-17T00:00:02.000Z"));
    // The finish is announced by the paths that own it, not by this one.
    service.noteExternalChatProgress(tick("Half a sentence, then more. Done.", "finished", "2026-08-17T00:00:03.000Z"));
    await new Promise((resolve) => setTimeout(resolve, 200));

    // W-M(d): partial text is for someone watching now. Persisting it would
    // re-append the whole growing answer to the mailbox on every flush.
    assert.deepEqual(persisted, [], "partial reply text is never handed to the durable sink");
  } finally {
    service.close();
  }
});

// Reported repeatedly from the phone: the "Thinking" row appears for a second
// and vanishes. The terminal re-projection stamped EVERY participant row with
// the finishing run's id — including another run's still-live row — and the
// phone drops a pending row whose run it already recorded as terminal. So any
// run finishing anywhere in the conversation killed the live one.
test("MobileRelayControlService never re-stamps a live row with a finishing run's id", async () => {
  const key = Buffer.from("i".repeat(32)).toString("base64url");
  const published: MobileTimelineEvents[] = [];
  const service = new MobileRelayControlService(
    {
      relayUrl: "ws://127.0.0.1:1/v1/relay",
      rendezvousId: "rv-no-restamp",
      relayCapability: "cap",
      relaySealKeyBase64: key,
      conversationId: "conversation-1",
      streamId: "route:phone"
    },
    { async sendMessage() { throw new Error("not used"); } } as unknown as MobileRelayChatSender,
    {
      async listChats() { return []; },
      async listTimeline() {
        return [
          // Run A's answer, just finished.
          {
            id: "m-a", role: "participant", participantLabel: "@a",
            content: "A is done.", status: "done",
            createdAt: "2026-08-17T00:00:05.000Z", runId: "run-a", messageId: "m-a"
          },
          // Run B, still writing. It must keep its own run.
          {
            id: "m-b", role: "participant", participantLabel: "@b",
            content: "B is still writing", status: "pending",
            createdAt: "2026-08-17T00:00:06.000Z", runId: "run-b", messageId: "m-b"
          }
        ];
      }
    },
    undefined,
    { async publishTimeline(timeline: MobileTimelineEvents) { published.push(timeline); } }
  );

  try {
    // Run A finishes. Its re-projection must not claim run B's live row.
    await service.publishTerminalReprojectionForTest({
      runId: "run-a",
      phase: "done",
      message: "@a finished.",
      createdAt: "2026-08-17T00:00:07.000Z",
      agentProgress: { participantId: "a", participantLabel: "@a", state: "finished", messageId: "m-a", partialContent: "A is done." }
    } as unknown as Parameters<typeof service.publishTerminalReprojectionForTest>[0]);
    await new Promise((resolve) => setTimeout(resolve, 200));

    const stamped = published.flatMap((timeline) => timeline.events)
      .filter((event) => event.messageId === "m-b");
    assert.ok(stamped.length > 0, "run B's row is published at all");
    for (const event of stamped) {
      assert.equal(event.runId, "run-b", "run B's live row keeps its own run, not the finishing one's");
    }
  } finally {
    service.close();
  }
});

// The row-kill User hit five times, found by Gera in her own trace. After a
// phone-originated send, the conversation projection stamped the SENDING run's
// id onto every history message that had no run of its own — so forty old
// finished answers all arrived carrying the live run's identity, and the phone
// deletes a pending row once its run terminates.
test("MobileRelayControlService never lends a run's id to unrelated history", async () => {
  const key = Buffer.from("j".repeat(32)).toString("base64url");
  const published: MobileTimelineEvents[] = [];
  const service = new MobileRelayControlService(
    {
      relayUrl: "ws://127.0.0.1:1/v1/relay",
      rendezvousId: "rv-no-lending",
      relayCapability: "cap",
      relaySealKeyBase64: key,
      conversationId: "conversation-1",
      streamId: "route:phone"
    },
    {
      async sendMessage(request: Parameters<MobileRelayChatSender["sendMessage"]>[0]) {
        return {
          conversation: {
            id: request.conversationId,
            kind: "chat",
            title: "Test chat",
            createdAt: "2026-08-17T00:00:00.000Z",
            updatedAt: "2026-08-17T00:00:09.000Z",
            messages: [
              // Pre-runId-era history: no metadata.runId at all. This is what
              // her main chat is full of.
              {
                id: "old-answer", role: "participant", participantLabel: "@drew",
                content: "An answer from before runIds existed.", status: "done",
                createdAt: "2026-08-16T00:00:00.000Z"
              }
            ],
            findings: [],
            metadata: {}
          },
          warnings: []
        } as unknown as StartReviewResult;
      }
    } as unknown as MobileRelayChatSender,
    undefined,
    undefined,
    { async publishTimeline(timeline: MobileTimelineEvents) { published.push(timeline); } }
  );

  try {
    await service.acceptMobileOutboxEvents([{
      eventId: "evt-lending",
      conversationId: "conversation-1",
      createdAt: "2026-08-17T00:00:01.000Z",
      payload: { content: "@drew hello" }
    }], "mailbox");
    for (let i = 0; i < 60 && published.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const old = published.flatMap((timeline) => timeline.events)
      .filter((event) => event.messageId === "old-answer");
    assert.ok(old.length > 0, "the old answer is published at all");
    for (const event of old) {
      assert.notEqual(
        event.runId,
        "mobile-evt-lending",
        "a history message must never carry the sending run's id — the phone would read it as that run ending"
      );
    }
  } finally {
    service.close();
  }
});

// The eternal "Thinking" row: a phone-sent message starts an ingest run named
// mobile-<eventId>, and the phone's placeholder row is keyed by that identity.
// The participant that answers runs under a fresh fan-out run id, so its
// terminal used to arrive carrying keys the placeholder never had — nothing
// deleted it, and the row outlived the answer on screen forever. The answer's
// terminal must inherit the source message's mobile event id.
test("MobileRelayControlService stamps the source's mobile event id onto the answering terminal", async () => {
  const key = Buffer.from("e".repeat(32)).toString("base64url");
  const published: Array<{ events: MobileTimelineEvents["events"] }> = [];
  const service = new MobileRelayControlService(
    {
      relayUrl: "ws://127.0.0.1:1/v1/relay",
      rendezvousId: "rv-source-id",
      relayCapability: "cap",
      relaySealKeyBase64: key,
      conversationId: "conversation-1",
      streamId: "route:phone"
    },
    { async sendMessage() { throw new Error("not used"); } } as unknown as MobileRelayChatSender,
    undefined,
    undefined,
    {
      async publishTimeline(timeline: MobileTimelineEvents) {
        published.push({ events: timeline.events });
      }
    }
  );

  const conversation = {
    id: "conversation-1",
    kind: "chat",
    title: "Test chat",
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:05.000Z",
    messages: [
      {
        id: "m-user",
        role: "user",
        content: "A question from the phone.",
        status: "done",
        createdAt: "2026-08-18T00:00:01.000Z",
        metadata: { appMessageSource: "mobile-relay", mobileEventId: "evt-9", runId: "mobile-evt-9" }
      },
      {
        id: "m-answer",
        role: "participant",
        participantLabel: "@drew",
        content: "The answer.",
        status: "done",
        createdAt: "2026-08-18T00:00:04.000Z",
        metadata: { runId: "1c2d3e4f-0000-0000-0000-000000000000", sourceMessageId: "m-user" }
      }
    ],
    findings: [],
    metadata: { activeRunIds: [] }
  } as unknown as Conversation;

  service.pushConversationSnapshot(conversation);
  for (let i = 0; i < 50 && published.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const answer = published[0]?.events.find((event) => event.messageId === "m-answer");
  assert.ok(answer, "the answer is projected");
  assert.equal(answer?.mobileEventId, "evt-9", "the terminal carries the source message's mobile event id");
  assert.equal(answer?.runId, "1c2d3e4f-0000-0000-0000-000000000000", "the run id stays the fan-out run's own");
  service.close();
});

// Streaming died while everything else stayed green: connected was set only by
// a successful FIRST dial, so one failed dial at app start silently discarded
// every live frame forever — while the background reconnect loop held a
// perfectly good socket that the durable paths never needed.
test("MobileRelayControlService publishes live frames after recovering from a failed first connect", async () => {
  const net = await import("node:net");
  const key = Buffer.from("f".repeat(32)).toString("base64url");
  const relay = createReferenceRelayServer();
  // Reserve a port but do not listen yet: the first dial must fail.
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const desktop = new MobileRelayControlService(
    {
      relayUrl: `ws://127.0.0.1:${port}/v1/relay`,
      rendezvousId: "rv-live-recovery",
      relayCapability: "PAIRING-FINGERPRINT",
      relaySealKeyBase64: key,
      conversationId: "conversation-1",
      streamId: "route-live:phone",
      reconnectDelayMs: 50
    },
    sender([])
  );
  const phone = new RelayTunnelClient({
    relayUrl: `ww`.replace("ww", `ws://127.0.0.1:${port}/v1/relay`),
    rendezvousId: "rv-live-recovery",
    role: "phone",
    capability: "PAIRING-FINGERPRINT",
    streamId: "route-live:phone"
  });
  try {
    await desktop.connect().catch(() => undefined);
    await (relay.listen as unknown as (port?: number, host?: string) => Promise<{ url: string }>)(port);
    const received = nextMessage(phone);
    await phone.connect();
    // Give the desktop's single-flight background loop time to seat.
    await new Promise((resolve) => setTimeout(resolve, 300));
    desktop.noteExternalChatProgress({
      runId: "run-live",
      phase: "agent-progress",
      createdAt: "2026-08-18T07:00:00.000Z",
      agentProgress: {
        state: "streaming",
        participantLabel: "@drew",
        messageId: "m-live",
        partialContent: "Halfway thro"
      }
    } as unknown as Parameters<typeof desktop.noteExternalChatProgress>[0]);
    const frame = await Promise.race([
      received,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no live frame within 3s")), 3000))
    ]);
    const payload = await openMobileRelayPayload(frame.ciphertext, key) as {
      type?: string;
      events?: Array<{ content?: string; status?: string }>;
    };
    assert.equal(payload.type, "mobile.timeline.events");
    assert.equal(payload.events?.[0]?.content, "Halfway thro");
    assert.equal(payload.events?.[0]?.status, "pending");
  } finally {
    phone.close();
    desktop.close();
    await relay.close();
  }
});

// W-M(d): the durable copy of a pending row must not carry the growing reply
// — it re-appended the whole answer to the mailbox on every flush — while
// the live-relay copy is exactly that text, for whoever is watching now.
test("MobileRelayControlService strips partial text from the durable copy and keeps it on the live one", async () => {
  const key = Buffer.from("g".repeat(32)).toString("base64url");
  const relay = createReferenceRelayServer();
  const address = await relay.listen();
  const published: MobileTimelineEvents[] = [];
  let capturedProgress: ((progress: unknown) => void) | undefined;
  const desktop = new MobileRelayControlService(
    {
      relayUrl: address.url,
      rendezvousId: "rv-split",
      relayCapability: "PAIRING-FINGERPRINT",
      relaySealKeyBase64: key,
      conversationId: "conversation-1",
      streamId: "route-split:phone",
      reconnectDelayMs: 50
    },
    {
      async sendMessage(request: { conversationId: string }, _signal: unknown, progress?: unknown) {
        capturedProgress = progress as (value: unknown) => void;
        return {
          conversation: {
            id: request.conversationId,
            kind: "chat",
            title: "Test chat",
            createdAt: "2026-08-18T00:00:00.000Z",
            updatedAt: "2026-08-18T00:00:00.000Z",
            messages: [],
            findings: [],
            metadata: {}
          },
          warnings: []
        } as unknown as StartReviewResult;
      }
    } as unknown as MobileRelayChatSender,
    undefined,
    undefined,
    {
      async publishTimeline(timeline: MobileTimelineEvents) {
        published.push(timeline);
      }
    }
  );
  const phone = new RelayTunnelClient({
    relayUrl: address.url,
    rendezvousId: "rv-split",
    role: "phone",
    capability: "PAIRING-FINGERPRINT",
    streamId: "route-split:phone"
  });
  try {
    const ackMessage = nextMessage(phone);
    await desktop.connect();
    await phone.connect();
    await phone.sendCiphertext({
      logicalMessageId: "event-split",
      ciphertext: await sealMobileRelayPayload({
        type: "mobile.outbox.events",
        events: [{
          eventId: "event-split",
          conversationId: "conversation-1",
          payload: { content: "run from phone" }
        }]
      }, key)
    });
    await ackMessage;
    const tick = {
      runId: "mobile-event-split",
      phase: "debate",
      message: "@drew is responding.",
      createdAt: "2026-08-18T13:00:00.000Z",
      agentProgress: {
        participantLabel: "@drew",
        state: "running",
        messageId: "m-split",
        activity: "Using Bash",
        partialContent: "Half of the actual reply text"
      }
    };
    const contents: Array<string | undefined> = [];
    const collector = (message: { ciphertext: string }) => {
      void openMobileRelayPayload(message.ciphertext, key).then((payload) => {
        const events = (payload as { events?: Array<{ content?: string }> }).events ?? [];
        for (const event of events) {
          contents.push(event.content);
        }
      }).catch(() => undefined);
    };
    const unsubscribe = phone.on("message", collector);
    await waitFor(() => Boolean(capturedProgress));
    capturedProgress?.(tick);
    desktop.noteExternalChatProgress(tick as never);
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline &&
      (!contents.includes("Using Bash") || !contents.includes("Half of the actual reply text"))) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    unsubscribe();
    assert.ok(contents.includes("Using Bash"), "the durable-shaped copy carries the activity label: " + JSON.stringify(contents));
    assert.ok(contents.includes("Half of the actual reply text"), "the live copy carries the partial text: " + JSON.stringify(contents));
    for (let i = 0; i < 30 && published.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const durableContents = published.flatMap((timeline) => timeline.events.map((event) => event.content));
    assert.ok(durableContents.includes("Using Bash"), "the durable sink received the pending row: " + JSON.stringify(durableContents));
    assert.ok(!durableContents.some((content) => (content ?? "").includes("Half of the actual reply")),
      "the durable sink must never see partial text: " + JSON.stringify(durableContents));
  } finally {
    phone.close();
    desktop.close();
    await relay.close();
  }
});

// The phone never received an image at all: the projection required non-empty
// text, so a screenshot with no caption was filtered out, and even a captioned
// one arrived with no sign that a picture existed.
test("the phone timeline carries image attachments as metadata, and a caption-less image is not dropped", () => {
  const conversation = {
    id: "conversation-attachments",
    kind: "chat" as const,
    title: "Attachments",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:02.000Z",
    messages: [
      {
        id: "message-with-caption",
        role: "participant" as const,
        participantId: "participant-1",
        participantLabel: "@drew",
        content: "here is the screen",
        createdAt: "2026-09-01T00:00:01.000Z",
        status: "done" as const,
        metadata: {
          imageAttachments: [{
            id: "attachment-1",
            filename: "shot.png",
            mimeType: "image/png" as const,
            sizeBytes: 597423,
            width: 1206,
            height: 2622,
            storageKey: "attachments/attachment-1.png",
            createdAt: "2026-09-01T00:00:01.000Z"
          }]
        }
      },
      {
        id: "message-image-only",
        role: "participant" as const,
        participantId: "participant-1",
        participantLabel: "@drew",
        content: "",
        createdAt: "2026-09-01T00:00:02.000Z",
        status: "done" as const,
        metadata: {
          imageAttachments: [{
            id: "attachment-2",
            filename: "second.png",
            mimeType: "image/png" as const,
            sizeBytes: 1024,
            width: 10,
            height: 20,
            storageKey: "attachments/attachment-2.png",
            createdAt: "2026-09-01T00:00:02.000Z"
          }]
        }
      },
      {
        id: "message-empty",
        role: "participant" as const,
        participantId: "participant-1",
        participantLabel: "@drew",
        content: "   ",
        createdAt: "2026-09-01T00:00:03.000Z",
        status: "done" as const
      }
    ],
    findings: [],
    metadata: {}
  };

  const events = timelineEventsFromSnapshot(conversation as never);
  assert.deepEqual(events.map((event) => event.id), ["message-with-caption", "message-image-only"]);
  assert.deepEqual(events[0].attachments, [{
    id: "attachment-1",
    filename: "shot.png",
    mimeType: "image/png",
    sizeBytes: 597423,
    width: 1206,
    height: 2622
  }]);
  // The bytes and the desktop-only storage path must not travel to the phone:
  // this projection re-sends the last forty rows on every batch.
  const serialized = JSON.stringify(events);
  assert.doesNotMatch(serialized, /storageKey/);
  assert.doesNotMatch(serialized, /dataBase64/);
  assert.equal(events[1].content, "");
  assert.equal(events[1].attachments?.[0].id, "attachment-2");
});

// The timeline carries only metadata, so this request is the only way a picture
// reaches the phone at all.
test("the phone can ask for one image by id, and an oversized one answers with a reason instead of the bytes", async () => {
  const key = Buffer.from("i".repeat(32)).toString("base64url");
  const relay = createReferenceRelayServer();
  const address = await relay.listen();
  const reads: Array<{ conversationId: string; attachmentId: string }> = [];
  const desktop = new MobileRelayControlService(
    {
      relayUrl: address.url,
      rendezvousId: "rv-attachment",
      relayCapability: "PAIRING-FINGERPRINT",
      relaySealKeyBase64: key,
      conversationId: "conversation-1",
      streamId: "route-attachment:phone"
    },
    {
      async sendMessage() {
        throw new Error("not used");
      },
      async readChatAttachment(request: { conversationId: string; attachmentId: string }) {
        reads.push(request);
        if (request.attachmentId === "attachment-huge") {
          return {
            attachment: { id: request.attachmentId, mimeType: "image/png", sizeBytes: 9 * 1024 * 1024 },
            dataBase64: "should-not-be-sent"
          };
        }
        if (request.attachmentId === "attachment-missing") {
          throw new Error("no such attachment");
        }
        return {
          attachment: { id: request.attachmentId, mimeType: "image/png", sizeBytes: 3 },
          dataBase64: "cG5n"
        };
      }
    } as never
  );
  const phone = new RelayTunnelClient({
    relayUrl: address.url,
    rendezvousId: "rv-attachment",
    role: "phone",
    capability: "PAIRING-FINGERPRINT",
    streamId: "route-attachment:phone"
  });
  try {
    const answers = nextMessages(phone, 3);
    await desktop.connect();
    await phone.connect();
    await phone.sendCiphertext({
      logicalMessageId: "ask-other-chat-image",
      ciphertext: await sealMobileRelayPayload({
        type: "mobile.attachment.request",
        conversationId: "conversation-outside-pairing",
        attachmentId: "attachment-1"
      }, key)
    });
    for (const attachmentId of ["attachment-1", "attachment-huge", "attachment-missing"]) {
      await phone.sendCiphertext({
        logicalMessageId: `ask-${attachmentId}`,
        ciphertext: await sealMobileRelayPayload({
          type: "mobile.attachment.request",
          conversationId: "conversation-1",
          attachmentId
        }, key)
      });
    }
    const payloads = [] as Array<Record<string, unknown>>;
    for (const message of await answers) {
      payloads.push(await openMobileRelayPayload<Record<string, unknown>>(message.ciphertext, key));
    }
    const byId = new Map(payloads.map((payload) => [payload.attachmentId as string, payload]));

    assert.deepEqual(byId.get("attachment-1"), {
      type: "mobile.attachment",
      conversationId: "conversation-1",
      attachmentId: "attachment-1",
      mimeType: "image/png",
      dataBase64: "cG5n"
    });
    // Ten megabytes through a phone's relay connection is not a picture, it is
    // a hang. The reason travels; the bytes do not.
    assert.equal(byId.get("attachment-huge")?.reason, "too-large");
    assert.equal(byId.get("attachment-huge")?.dataBase64, undefined);
    // A deleted id is an ordinary answer, so the phone stops waiting.
    assert.equal(byId.get("attachment-missing")?.reason, "unavailable");
    assert.ok(reads.every((read) => read.conversationId === "conversation-1"),
      "a request outside the pairing must not reach attachment storage");
    assert.deepEqual(reads.map((read) => read.attachmentId).sort(), [
      "attachment-1",
      "attachment-huge",
      "attachment-missing"
    ]);
  } finally {
    phone.close();
    desktop.close();
    await relay.close();
  }
});

// A phone can put anything in a payload, so what becomes a message is checked
// first: known image types, bounded count, bounded size — and an unusable one
// is dropped rather than failing the send, so the text still arrives.
test("images sent from the phone reach sendMessage, and unusable ones are dropped without losing the text", async () => {
  const key = Buffer.from("j".repeat(32)).toString("base64url");
  const sent: SendChatMessageRequest[] = [];
  const service = new MobileRelayControlService(
    {
      relayUrl: "ws://127.0.0.1:1/v1/relay",
      rendezvousId: "rv-upload",
      relayCapability: "PAIRING-FINGERPRINT",
      relaySealKeyBase64: key,
      conversationId: "conversation-1",
      streamId: "route-upload:phone"
    },
    {
      async sendMessage(request: SendChatMessageRequest) {
        sent.push(request);
        return {
          conversation: {
            id: request.conversationId,
            kind: "chat" as const,
            title: "t",
            createdAt: "2026-09-01T00:00:00.000Z",
            updatedAt: "2026-09-01T00:00:00.000Z",
            messages: [],
            findings: [],
            metadata: {}
          },
          warnings: []
        } as never;
      }
    } as never
  );
  const oversized = "A".repeat(Math.ceil((4 * 1024 * 1024) / 3) * 4 + 4);
  await service.acceptSealedMobileOutbox(await sealMobileRelayPayload({
    type: "mobile.outbox.events",
    events: [{
      eventId: "event-upload",
      conversationId: "conversation-1",
      payload: {
        content: "look at this",
        attachments: [
          { filename: "shot.png", mimeType: "image/png", dataBase64: "cG5n" },
          { filename: "notes.pdf", mimeType: "application/pdf", dataBase64: "cGRm" },
          { filename: "huge.png", mimeType: "image/png", dataBase64: oversized }
        ]
      }
    }]
  }, key));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].content, "look at this");
  assert.deepEqual(sent[0].imageAttachments, [
    { filename: "shot.png", mimeType: "image/png", dataBase64: "cG5n" }
  ]);
  service.close();
});

// Both halves of the caption-less case. The phone's own composer allows a
// picture with no text, so the desktop validator must too — otherwise the send
// is rejected, never acked, and the phone retries it forever.
test("a picture with no caption is accepted from the phone, and a changed picture is not suppressed as already delivered", async () => {
  const key = Buffer.from("k".repeat(32)).toString("base64url");
  const sent: SendChatMessageRequest[] = [];
  const service = new MobileRelayControlService(
    {
      relayUrl: "ws://127.0.0.1:1/v1/relay",
      rendezvousId: "rv-caption-less",
      relayCapability: "PAIRING-FINGERPRINT",
      relaySealKeyBase64: key,
      conversationId: "conversation-1",
      streamId: "route-caption-less:phone"
    },
    {
      async sendMessage(request: SendChatMessageRequest) {
        sent.push(request);
        return {
          conversation: {
            id: request.conversationId,
            kind: "chat" as const,
            title: "t",
            createdAt: "2026-09-01T00:00:00.000Z",
            updatedAt: "2026-09-01T00:00:00.000Z",
            messages: [],
            findings: [],
            metadata: {}
          },
          warnings: []
        } as never;
      }
    } as never
  );

  const accepted = await service.acceptSealedMobileOutbox(await sealMobileRelayPayload({
    type: "mobile.outbox.events",
    events: [{
      eventId: "event-picture-only",
      conversationId: "conversation-1",
      payload: {
        content: "",
        attachments: [{ filename: "shot.png", mimeType: "image/png", dataBase64: "cG5n" }]
      }
    }]
  }, key));
  assert.deepEqual(accepted.eventIds, ["event-picture-only"]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].content, "");
  assert.equal(sent[0].imageAttachments?.length, 1);

  // Base64 that is the right length but not base64 must not reach the decoder.
  await assert.rejects(service.acceptSealedMobileOutbox(await sealMobileRelayPayload({
    type: "mobile.outbox.events",
    events: [{
      eventId: "event-not-base64",
      conversationId: "conversation-1",
      payload: { content: "", attachments: [{ mimeType: "image/png", dataBase64: "!!!!" }] }
    }]
  }, key)));

  // The delivery signature has to notice a picture that appeared on a row whose
  // text and status never changed.
  const base = {
    id: "message-1",
    role: "participant" as const,
    content: "same text",
    status: "done" as const,
    createdAt: "2026-09-01T00:00:00.000Z"
  };
  const withImage = {
    ...base,
    attachments: [{ id: "a1", filename: "f.png", mimeType: "image/png", sizeBytes: 3, width: 1, height: 1 }]
  };
  assert.notEqual(
    JSON.stringify(timelineEventsFromSnapshot({
      id: "c", kind: "chat", title: "t", createdAt: base.createdAt, updatedAt: base.createdAt,
      messages: [{ ...base, metadata: { imageAttachments: withImage.attachments } }], findings: [], metadata: {}
    } as never)),
    JSON.stringify(timelineEventsFromSnapshot({
      id: "c", kind: "chat", title: "t", createdAt: base.createdAt, updatedAt: base.createdAt,
      messages: [base], findings: [], metadata: {}
    } as never))
  );
  service.close();
});

test("MobileRelayControlService answers a timeline request with the page cursor and pages before a message", async () => {
  const key = Buffer.from("p".repeat(32)).toString("base64url");
  const relay = createReferenceRelayServer();
  const address = await relay.listen();
  const pageRequests: Array<{ beforeMessageId?: string }> = [];
  const desktop = new MobileRelayControlService(
    {
      relayUrl: address.url,
      rendezvousId: "rv-timeline-page",
      relayCapability: "PAIRING-FINGERPRINT",
      relaySealKeyBase64: key,
      streamId: "route-timeline-page:phone",
      reconnectDelayMs: 50
    },
    sender([]),
    {
      async listChats() { return []; },
      async listTimeline() { throw new Error("the paged reader must be used when it exists"); },
      async listTimelinePage(_conversationId, options) {
        pageRequests.push(options);
        if (options.beforeMessageId === "m-oldest-of-first-page") {
          return {
            events: [{ id: "m-earlier", role: "you", content: "Earlier.", status: "done", createdAt: "2026-09-01T00:00:00.000Z" }],
            hasMoreBefore: false,
            beforeMessageId: "m-earlier"
          };
        }
        return {
          events: [{ id: "m-latest", role: "you", content: "Latest.", status: "done", createdAt: "2026-09-02T00:00:00.000Z" }],
          hasMoreBefore: true,
          beforeMessageId: "m-oldest-of-first-page"
        };
      },
      isConversationAllowed() { return true; }
    }
  );
  const phone = new RelayTunnelClient({
    relayUrl: address.url,
    rendezvousId: "rv-timeline-page",
    role: "phone",
    capability: "PAIRING-FINGERPRINT",
    streamId: "route-timeline-page:phone"
  });
  try {
    await desktop.connect();
    await phone.connect();
    const first = nextMessage(phone);
    await phone.sendCiphertext({
      logicalMessageId: "timeline-1",
      ciphertext: await sealMobileRelayPayload({ type: "mobile.timeline.request", conversationId: "conversation-1" }, key)
    });
    const firstPage = await openMobileRelayPayload<MobileTimelineEvents>(await first.then((message) => message.ciphertext), key);
    assert.deepEqual(firstPage.page, { hasMoreBefore: true, beforeMessageId: "m-oldest-of-first-page" });
    assert.equal(firstPage.events[0].id, "m-latest");

    const second = nextMessage(phone);
    await phone.sendCiphertext({
      logicalMessageId: "timeline-2",
      ciphertext: await sealMobileRelayPayload({
        type: "mobile.timeline.request", conversationId: "conversation-1", beforeMessageId: "m-oldest-of-first-page"
      }, key)
    });
    const earlierPage = await openMobileRelayPayload<MobileTimelineEvents>(await second.then((message) => message.ciphertext), key);
    assert.deepEqual(earlierPage.page, { hasMoreBefore: false, beforeMessageId: "m-earlier", earlier: true });
    assert.equal(earlierPage.events[0].id, "m-earlier");
    assert.deepEqual(pageRequests, [{ beforeMessageId: undefined }, { beforeMessageId: "m-oldest-of-first-page" }]);
  } finally {
    phone.close();
    desktop.close();
    await relay.close();
  }
});

test("MobileRelayControlService answers the composer request from the catalog and carries picked skills into sendMessage", async () => {
  const key = Buffer.from("s".repeat(32)).toString("base64url");
  const relay = createReferenceRelayServer();
  const address = await relay.listen();
  const composerRequests: Array<{ conversationId: string; query: string; content: string }> = [];
  const sent: SendChatMessageRequest[] = [];
  const desktop = new MobileRelayControlService(
    {
      relayUrl: address.url,
      rendezvousId: "rv-composer",
      relayCapability: "PAIRING-FINGERPRINT",
      relaySealKeyBase64: key,
      streamId: "route-composer:phone",
      reconnectDelayMs: 50
    },
    {
      async sendMessage(request: SendChatMessageRequest) {
        sent.push(request);
        return {
          conversation: {
            id: request.conversationId, kind: "chat", title: "t", createdAt: "2026-09-01T00:00:00.000Z",
            updatedAt: "2026-09-01T00:00:00.000Z", messages: [], findings: [], metadata: {}
          } as unknown as Conversation
        } as unknown as StartReviewResult;
      }
    } as unknown as MobileRelayChatSender,
    {
      async listChats() { return []; },
      async listTimeline() { return []; },
      async composerOptions(request) {
        composerRequests.push(request);
        return {
          commands: [{ id: "compact", label: "/compact", description: "Compact the mentioned member context" }],
          prompts: [{ id: "p1", label: "Daily standup", trigger: "standup", body: "Give me a standup summary." }],
          skills: [{
            skillId: "skill-1", displayName: "review", frontmatterName: "review", description: "Review the diff",
            contentHash: "hash", capabilityState: "invocable", variants: []
          }]
        };
      },
      isConversationAllowed() { return true; }
    }
  );
  const phone = new RelayTunnelClient({
    relayUrl: address.url,
    rendezvousId: "rv-composer",
    role: "phone",
    capability: "PAIRING-FINGERPRINT",
    streamId: "route-composer:phone"
  });
  try {
    await desktop.connect();
    await phone.connect();
    const reply = nextMessage(phone);
    await phone.sendCiphertext({
      logicalMessageId: "composer-1",
      ciphertext: await sealMobileRelayPayload({
        type: "mobile.composer.request", conversationId: "conversation-1", query: "re", content: "@drew /re"
      }, key)
    });
    const options = await openMobileRelayPayload<Record<string, unknown>>(await reply.then((message) => message.ciphertext), key);
    assert.equal(options.type, "mobile.composer");
    assert.equal(options.query, "re");
    assert.deepEqual(composerRequests, [{ conversationId: "conversation-1", query: "re", content: "@drew /re" }]);
    assert.equal((options.skills as Array<{ frontmatterName: string }>)[0].frontmatterName, "review");
    assert.equal((options.commands as Array<{ id: string }>)[0].id, "compact");
    assert.equal((options.prompts as Array<{ trigger: string }>)[0].trigger, "standup");

    const ack = nextMessage(phone);
    await phone.sendCiphertext({
      logicalMessageId: "send-1",
      ciphertext: await sealMobileRelayPayload({
        type: "mobile.outbox.events",
        events: [{
          eventId: "evt-skill-1",
          conversationId: "conversation-1",
          payload: {
            content: "@drew /review this",
            skillMentions: [{
              skillId: "skill-1", displayName: "review", frontmatterName: "review",
              contentHash: "hash", capabilityState: "invocable", variants: []
            }]
          }
        }]
      }, key)
    });
    await ack;
    for (let i = 0; i < 50 && sent.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(sent.length, 1);
    assert.equal(sent[0].skillMentions?.[0].skillId, "skill-1", "the picked skill reaches the chat service like the desktop composer's");

    // A message written with a thread open belongs to that thread. Without the
    // root the desktop placed it in the main timeline, where the User -- still
    // looking at the thread she wrote in -- never saw her own message.
    const threadAck = nextMessage(phone);
    await phone.sendCiphertext({
      logicalMessageId: "send-thread-1",
      ciphertext: await sealMobileRelayPayload({
        type: "mobile.outbox.events",
        events: [{
          eventId: "evt-thread-1",
          conversationId: "conversation-1",
          payload: { content: "inside the thread", threadRootId: "message-root-1" }
        }]
      }, key)
    });
    await threadAck;
    for (let i = 0; i < 50 && sent.length === 1; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(sent.length, 2);
    assert.equal(sent[1].chatThreadRootId, "message-root-1", "a reply written in a thread is sent to that thread");
  } finally {
    phone.close();
    desktop.close();
    await relay.close();
  }
});

test("MobileRelayControlService states what a ring is about: a finished reply, a member newly waiting", async () => {
  const key = Buffer.from("n".repeat(32)).toString("base64url");
  const published: Array<{ runFinished: boolean; notices?: string[] }> = [];
  const service = new MobileRelayControlService(
    {
      relayUrl: "ws://127.0.0.1:1/v1/relay",
      rendezvousId: "rv-notices",
      relayCapability: "cap",
      relaySealKeyBase64: key,
      conversationId: "conversation-1",
      streamId: "route:phone"
    },
    { async sendMessage() { throw new Error("not used"); } } as unknown as MobileRelayChatSender,
    undefined,
    undefined,
    {
      async publishTimeline(_timeline: MobileTimelineEvents, options?: { runFinished?: boolean; notices?: string[] }) {
        published.push({ runFinished: options?.runFinished === true, ...(options?.notices ? { notices: options.notices } : {}) });
      }
    }
  );
  let messageSeq = 0;
  const snapshot = (activeRunIds: string[], updatedAt: string, options: { status?: string; card?: boolean } = {}): Conversation => {
    messageSeq += 1;
    return {
      id: "conversation-1",
      kind: "chat",
      title: "Test chat",
      createdAt: "2026-08-17T00:00:00.000Z",
      updatedAt,
      messages: [{
        id: `m${messageSeq}`,
        role: "participant",
        participantLabel: "@drew",
        content: `An answer ${messageSeq}.`,
        status: options.status ?? "done",
        createdAt: `2026-08-17T00:00:0${messageSeq}.000Z`
      }],
      findings: [],
      metadata: {
        activeRunIds,
        ...(options.card
          ? { pendingAppToolApprovals: [{ id: "approval-1", status: "pending", summary: "Allow file editing?", createdAt: updatedAt }] }
          : {})
      }
    } as unknown as Conversation;
  };
  const waitForPublished = async (count: number) => {
    for (let i = 0; i < 50 && published.length < count; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  try {
    service.pushConversationSnapshot(snapshot([], "2026-08-17T00:00:02.000Z"));
    await waitForPublished(1);
    assert.deepEqual(published[0], { runFinished: false }, "history delivered after start carries no notice");

    service.pushConversationSnapshot(snapshot(["run-a"], "2026-08-17T00:00:03.000Z", { status: "pending" }));
    await waitForPublished(2);
    assert.deepEqual(published[1], { runFinished: false }, "a run starting is not news for the phone");

    service.pushConversationSnapshot(snapshot(["run-a"], "2026-08-17T00:00:04.000Z", { status: "pending", card: true }));
    await waitForPublished(3);
    assert.deepEqual(published[2], { runFinished: true, notices: ["approval"] }, "a member newly waiting rings and says approval");

    service.pushConversationSnapshot(snapshot(["run-a"], "2026-08-17T00:00:05.000Z", { card: true }));
    await waitForPublished(4);
    assert.deepEqual(published[3], { runFinished: true, notices: ["reply"] }, "the finished answer rings and says reply; the unchanged card does not repeat");
  } finally {
    service.close();
  }
});

test("a card answered on the phone over the live tunnel is delivered, not only acked", { timeout: 10000 }, async () => {
  // The defect: a decision arriving on the connected tunnel -- the path the
  // phone uses whenever the desktop is up -- was accepted and acked, and then
  // dropped. Only cancellations and messages were delivered here, so Stop kept
  // working while an answered choice never became a durable decision at all:
  // the member holding the question was never told, and the card stayed
  // pending above the phone's composer for ever.
  const key = Buffer.from("d".repeat(32)).toString("base64url");
  const relay = createReferenceRelayServer();
  const address = await relay.listen();
  const decisions: Array<{ kind: string; targetKey: string; conversationId: string }> = [];
  const desktop = new MobileRelayControlService({
    relayUrl: address.url, rendezvousId: "rv-decision", relayCapability: "PAIRING-FINGERPRINT",
    relaySealKeyBase64: key, conversationId: "conversation-1", streamId: "decision:phone"
  }, {
    ...sender([]),
    async applyMobileDecision(request) {
      decisions.push({ kind: request.kind, targetKey: request.payload.targetKey, conversationId: request.conversationId });
    }
  });
  const phone = new RelayTunnelClient({
    relayUrl: address.url, rendezvousId: "rv-decision", role: "phone",
    capability: "PAIRING-FINGERPRINT", streamId: "decision:phone"
  });
  try {
    await Promise.all([desktop.connect(), phone.connect()]);
    await phone.sendCiphertext({
      logicalMessageId: "phone-answer-1",
      ciphertext: await sealMobileRelayPayload({
        type: "mobile.outbox.events",
        events: [{
          eventId: "event-choice-1",
          conversationId: "conversation-1",
          kind: "choice.answered",
          payload: {
            operationId: "choice:choice-1:o1",
            targetKey: "choice:choice-1",
            stateId: "o1",
            detail: { sourceMessageId: "message-1", selectedOptionId: "o1" }
          }
        }]
      }, key)
    });
    await waitFor(() => decisions.length === 1, 5000);
    assert.deepEqual(decisions, [{
      kind: "choice.answered", targetKey: "choice:choice-1", conversationId: "conversation-1"
    }], "the answer must reach the desktop's decision path, not stop at the ack");
  } finally { phone.close(); desktop.close(); await relay.close(); }
});

// The desktop keeps internal system triggers off its timeline; the phone got
// every one of them as a bubble ("Auto-resumed @claude after member request.")
// because this projection never asked the desktop's rule.
test("the phone timeline hides what the desktop hides: internal system triggers, but not artifact notes", () => {
  const conversation = {
    id: "conversation-system",
    kind: "chat" as const,
    title: "System rows",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:05.000Z",
    messages: [
      {
        id: "user-ask",
        role: "user" as const,
        content: "@claude ask codex",
        createdAt: "2026-09-01T00:00:01.000Z",
        status: "done" as const
      },
      {
        id: "auto-resume",
        role: "system" as const,
        content: "Auto-resumed @claude after member request.\nTarget replies/errors are in the transcript above.",
        createdAt: "2026-09-01T00:00:02.000Z",
        status: "done" as const,
        metadata: { sourceMessageId: "user-ask" }
      },
      {
        id: "hidden-carrier",
        role: "participant" as const,
        participantId: "participant-1",
        participantLabel: "@claude",
        content: "context the desktop never shows",
        createdAt: "2026-09-01T00:00:03.000Z",
        status: "done" as const,
        metadata: { hiddenFromTimeline: true }
      },
      {
        id: "artifact-note",
        role: "system" as const,
        content: "@gera revised [Plan] · v3",
        createdAt: "2026-09-01T00:00:04.000Z",
        status: "done" as const,
        metadata: { appMessageSource: "app_artifact_note" }
      },
      {
        id: "answer",
        role: "participant" as const,
        participantId: "participant-1",
        participantLabel: "@claude",
        content: "Done.",
        createdAt: "2026-09-01T00:00:05.000Z",
        status: "done" as const
      }
    ],
    findings: [],
    metadata: {}
  };

  // The hidden member row travels flagged (it may end a run — next test); the
  // internal system row does not travel at all.
  assert.deepEqual(timelineEventsFromSnapshot(conversation as never).map((event) => [event.id, event.hidden === true]),
    [["user-ask", false], ["hidden-carrier", true], ["artifact-note", false], ["answer", false]]);
  assert.deepEqual(timelineEventsFromConversation(conversation as never).map((event) => [event.id, event.hidden === true]),
    [["hidden-carrier", true], ["artifact-note", false], ["answer", false]]);
  const serialized = JSON.stringify(timelineEventsFromSnapshot(conversation as never));
  assert.doesNotMatch(serialized, /Auto-resumed/);
});

// A member's message the desktop hides can be the one that ends its run — a
// reply that is exactly the instructed "Awaiting user approval.", or an
// inferred request carrier. Dropping it left the phone's pending row for that
// run spinning forever; it travels flagged so the phone settles the row and
// stores no bubble.
test("a hidden member message still travels to the phone, flagged, so the run it ends can settle", () => {
  const conversation = {
    id: "conversation-hidden-terminal",
    kind: "chat" as const,
    title: "Hidden terminal",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:04.000Z",
    messages: [
      {
        id: "user-ask",
        role: "user" as const,
        content: "@drew ask taylor",
        createdAt: "2026-09-01T00:00:01.000Z",
        status: "done" as const
      },
      {
        id: "waiting",
        role: "participant" as const,
        participantId: "participant-1",
        participantLabel: "@drew",
        content: "Awaiting user approval.",
        createdAt: "2026-09-01T00:00:02.000Z",
        status: "done" as const,
        metadata: { runId: "run-1" }
      },
      {
        id: "carrier",
        role: "participant" as const,
        participantId: "participant-1",
        participantLabel: "@drew",
        content: "@drew asked @taylor: review this",
        createdAt: "2026-09-01T00:00:03.000Z",
        status: "done" as const,
        metadata: {
          hiddenFromTimeline: true,
          participantRequest: { source: "inferred", triggerMessageId: "user-ask", items: [] }
        }
      },
      {
        id: "auto-resume",
        role: "system" as const,
        content: "Auto-resumed @drew after member request.",
        createdAt: "2026-09-01T00:00:04.000Z",
        status: "done" as const
      }
    ],
    findings: [],
    metadata: {}
  };
  const events = timelineEventsFromSnapshot(conversation as never);
  assert.deepEqual(events.map((event) => [event.id, event.hidden === true]), [
    ["user-ask", false],
    ["waiting", true],
    ["carrier", true]
  ]);
  assert.equal(events[1].runId, "run-1", "the terminal keeps the run it ends");
  assert.deepEqual(timelineEventsFromConversation(conversation as never).map((event) => [event.id, event.hidden === true]), [
    ["waiting", true],
    ["carrier", true]
  ]);
});

// A drawn avatar is a file on the desktop; the member record names it and the
// phone asks for the bytes once. Only a member of the named chat can be asked
// for, so a scoped pairing cannot enumerate pictures from other chats.
test("the phone can ask for a member's drawn avatar, and gets a reason instead of bytes when it cannot be served", async () => {
  const key = Buffer.from("k".repeat(32)).toString("base64url");
  const relay = createReferenceRelayServer();
  const address = await relay.listen();
  const reads: Array<{ conversationId: string; avatarId: string }> = [];
  const desktop = new MobileRelayControlService(
    {
      relayUrl: address.url,
      rendezvousId: "rv-avatar",
      relayCapability: "PAIRING-FINGERPRINT",
      relaySealKeyBase64: key,
      conversationId: "conversation-1",
      streamId: "route-avatar:phone"
    },
    {
      async sendMessage() {
        throw new Error("not used");
      }
    } as never,
    {
      async listChats() { return []; },
      async listTimeline() { return []; },
      async readMemberAvatar(request: { conversationId: string; avatarId: string }) {
        reads.push(request);
        if (request.avatarId === "custom:huge") {
          return { mediaType: "image/png", dataBase64: Buffer.alloc(5 * 1024 * 1024).toString("base64") };
        }
        if (request.avatarId === "custom:missing") {
          throw new Error("Avatar not found.");
        }
        if (request.avatarId === "custom:other-chat") {
          return undefined;
        }
        return { mediaType: "image/svg+xml", dataBase64: "PHN2Zy8+" };
      }
    }
  );
  const phone = new RelayTunnelClient({
    relayUrl: address.url,
    rendezvousId: "rv-avatar",
    role: "phone",
    capability: "PAIRING-FINGERPRINT",
    streamId: "route-avatar:phone"
  });
  try {
    const answers = nextMessages(phone, 4);
    await desktop.connect();
    await phone.connect();
    await phone.sendCiphertext({
      logicalMessageId: "ask-outside",
      ciphertext: await sealMobileRelayPayload({
        type: "mobile.avatar.request",
        conversationId: "conversation-outside-pairing",
        avatarId: "custom:drawn"
      }, key)
    });
    for (const avatarId of ["custom:drawn", "custom:huge", "custom:missing", "custom:other-chat"]) {
      await phone.sendCiphertext({
        logicalMessageId: `ask-${avatarId}`,
        ciphertext: await sealMobileRelayPayload({ type: "mobile.avatar.request", conversationId: "conversation-1", avatarId }, key)
      });
    }
    const payloads = [] as Array<Record<string, unknown>>;
    for (const message of await answers) {
      payloads.push(await openMobileRelayPayload<Record<string, unknown>>(message.ciphertext, key));
    }
    const byId = new Map(payloads.map((payload) => [payload.avatarId as string, payload]));
    assert.deepEqual(byId.get("custom:drawn"), {
      type: "mobile.avatar",
      conversationId: "conversation-1",
      avatarId: "custom:drawn",
      mimeType: "image/svg+xml",
      dataBase64: "PHN2Zy8+"
    });
    assert.equal(byId.get("custom:huge")?.reason, "too-large");
    assert.equal(byId.get("custom:huge")?.dataBase64, undefined);
    assert.equal(byId.get("custom:missing")?.reason, "unavailable");
    assert.equal(byId.get("custom:other-chat")?.reason, "unavailable");
    assert.ok(reads.every((read) => read.conversationId === "conversation-1"),
      "a request outside the pairing must not reach avatar storage");
  } finally {
    phone.close();
    desktop.close();
    await relay.close();
  }
});

/** The chat list says when it was built; the rest of it is compared as is. */
function withoutGeneratedAt(value: unknown): unknown {
  const { generatedAt, ...rest } = value as { generatedAt?: unknown };
  assert.equal(typeof generatedAt, "string", "the chat list says when it was built");
  assert.ok(Number.isFinite(Date.parse(generatedAt as string)), "as a moment on the desktop's clock");
  return rest;
}

test("cards are offered again after the durable sink failed to take them", async () => {
  let attempts = 0;
  const published: MobileTimelineEvents[] = [];
  const service = new MobileRelayControlService({
    relayUrl: "ws://127.0.0.1:1/v1/relay", rendezvousId: "rv-cards-retry", relayCapability: "PAIRING-FINGERPRINT",
    relaySealKeyBase64: Buffer.from("c".repeat(32)).toString("base64url"), streamId: "cards-retry:phone"
  }, sender([]), undefined, undefined, { async publishTimeline(timeline) {
    attempts += 1;
    if (attempts === 1) throw new Error("Mailbox unreachable");
    published.push(timeline);
  } });
  const conversation: Conversation = {
    id: "conversation-cards-retry", kind: "chat", title: "Cards", createdAt: "2026-09-20T10:00:00Z",
    updatedAt: "2026-09-20T10:00:00Z", findings: [],
    metadata: { pendingAppToolApprovals: [{
      id: "approval-retry", status: "pending", summary: "Allow file editing?", createdAt: "2026-09-20T10:00:00Z"
    }] },
    messages: [{ id: "m1", role: "participant", participantLabel: "@drew", content: "Ready.", status: "done",
      createdAt: "2026-09-20T09:59:00Z", metadata: { runId: "run-1" } }]
  };
  try {
    service.pushConversationSnapshot(conversation);
    await waitFor(() => attempts === 1);
    assert.equal(published.length, 0, "the first publish failed");
    // The same chat again, nothing changed on it: the cards the phone never
    // got go with this batch rather than being remembered as delivered.
    service.pushConversationSnapshot({ ...conversation, updatedAt: "2026-09-20T10:00:01Z" });
    await waitFor(() => published.length === 1);
    assert.equal(published[0].cards?.length, 1);
    assert.equal(published[0].cards?.[0].id, "approval-retry");
    // And once taken, an unchanged chat sends nothing more.
    service.pushConversationSnapshot({ ...conversation, updatedAt: "2026-09-20T10:00:02Z" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(published.length, 1, "delivered cards are not sent again unchanged");
  } finally { service.close(); }
});

test("a direct timeline request answers with the chat's cards", async () => {
  const key = Buffer.from("t".repeat(32)).toString("base64url");
  const relay = createReferenceRelayServer();
  const address = await relay.listen();
  const desktop = new MobileRelayControlService({
    relayUrl: address.url, rendezvousId: "rv-timeline-cards", relayCapability: "PAIRING-FINGERPRINT",
    relaySealKeyBase64: key, streamId: "timeline-cards:phone", reconnectDelayMs: 50
  }, sender([]), {
    async listChats() { return []; },
    async listTimeline() { return []; },
    async listTimelinePage() {
      return { events: [{ id: "m1", role: "participant", participantLabel: "@drew", content: "Which one?", status: "done",
        createdAt: "2026-09-20T10:00:00Z", runId: "run-1", messageId: "m1" }], hasMoreBefore: false, beforeMessageId: "m1" };
    },
    async listControlCards(conversationId) {
      return [{ id: "choice-open", kind: "choice", conversationId, title: "Which one?", summary: "Which one?",
        requesterLabel: "@drew", options: [{ id: "a", label: "A" }], allowsCustomAnswer: true, allowsCancel: true,
        status: "pending", createdAt: "2026-09-20T10:00:00Z", sourceMessageId: "m1" }];
    }
  });
  const phone = new RelayTunnelClient({
    relayUrl: address.url, rendezvousId: "rv-timeline-cards", role: "phone", capability: "PAIRING-FINGERPRINT", streamId: "timeline-cards:phone"
  });
  try {
    const answer = nextMessage(phone);
    await desktop.connect();
    await phone.connect();
    await phone.sendCiphertext({
      logicalMessageId: "timeline-request",
      ciphertext: await sealMobileRelayPayload({ type: "mobile.timeline.request", conversationId: "conversation-open" }, key)
    });
    const payload = await openMobileRelayPayload((await answer).ciphertext, key) as MobileTimelineEvents;
    assert.equal(payload.type, "mobile.timeline.events");
    assert.equal(payload.events.length, 1);
    assert.equal(payload.cards?.length, 1, "the page carries the chat's cards");
    assert.equal(payload.cards?.[0].id, "choice-open");
  } finally { phone.close(); desktop.close(); await relay.close(); }
});

test("a phone's answer is followed by the chat's cards as the desktop holds them, even unchanged", async () => {
  const key = Buffer.from("d".repeat(32)).toString("base64url");
  const relay = createReferenceRelayServer();
  const address = await relay.listen();
  const applied: string[] = [];
  const published: MobileTimelineEvents[] = [];
  const stillPending = [{ id: "approval-stale", kind: "permission" as const, conversationId: "conversation-1", title: "Use Bash",
    summary: "Use Bash", requesterLabel: "@gera", options: [{ id: "allow", label: "Allow" }, { id: "deny", label: "Deny" }],
    allowsCustomAnswer: false, allowsCancel: false, status: "pending" as const, createdAt: "2026-09-13T12:40:00Z" }];
  const desktop = new MobileRelayControlService({
    relayUrl: address.url, rendezvousId: "rv-decision-cards", relayCapability: "PAIRING-FINGERPRINT",
    relaySealKeyBase64: key, conversationId: "conversation-1", streamId: "decision-cards:phone", reconnectDelayMs: 50
  }, {
    ...sender([]),
    async applyMobileDecision(request) { applied.push(request.payload.operationId); }
  }, {
    async listChats() { return []; },
    async listTimeline() { return []; },
    async listControlCards() { return stillPending; }
  }, undefined, { async publishTimeline(timeline) { published.push(timeline); } });
  const phone = new RelayTunnelClient({
    relayUrl: address.url, rendezvousId: "rv-decision-cards", role: "phone", capability: "PAIRING-FINGERPRINT", streamId: "decision-cards:phone"
  });
  try {
    // The desktop already told this phone about the card once.
    await desktop.connect();
    await phone.connect();
    const first = nextMessage(phone);
    desktop.pushConversationSnapshot({
      id: "conversation-1", kind: "chat", title: "Octopi", createdAt: "2026-09-13T12:00:00Z", updatedAt: "2026-09-13T12:40:00Z",
      findings: [], messages: [], metadata: { pendingAppToolApprovals: [{ id: "approval-stale", status: "pending", summary: "Use Bash", createdAt: "2026-09-13T12:40:00Z" }] }
    } as unknown as Conversation);
    await first;
    await waitFor(() => published.length === 1);
    // The phone answers it. The desktop records the answer but the card is
    // still pending here (the machine that owns it has not taken it).
    const replies = nextMessages(phone, 2);
    await phone.sendCiphertext({
      logicalMessageId: "decision-1",
      ciphertext: await sealMobileRelayPayload({ type: "mobile.outbox.events", events: [{
        eventId: "decision-1", conversationId: "conversation-1", kind: "permission.decided",
        payload: { operationId: "permission:approval-stale:allow", targetKey: "approval:approval-stale", stateId: "approved", detail: { approve: true } }
      }] }, key)
    });
    const opened = await Promise.all((await replies).map((message) => openMobileRelayPayload(message.ciphertext, key)));
    assert.deepEqual(applied, ["permission:approval-stale:allow"]);
    const ack = opened.find((payload) => (payload as { type?: string }).type === "mobile.outbox.ack") as { eventIds: string[] };
    assert.deepEqual(ack.eventIds, ["decision-1"]);
    const cards = opened.find((payload) => (payload as { type?: string }).type === "mobile.timeline.events") as MobileTimelineEvents;
    assert.deepEqual(cards.events, [], "a cards-only batch");
    assert.equal(cards.cards?.[0].id, "approval-stale", "the cards as the desktop holds them now, unchanged or not");
    await waitFor(() => published.length === 2);
    assert.equal(published[1].cards?.[0].id, "approval-stale", "and the durable copy carries them too");
  } finally { phone.close(); desktop.close(); await relay.close(); }
});

test("an answer the desktop keeps failing to take is given up after a few tries and never freezes the mailbox", async () => {
  let attempts = 0;
  const diagnostics: string[] = [];
  const service = new MobileRelayControlService({
    relayUrl: "ws://127.0.0.1:1/v1/relay", rendezvousId: "rv-decision-giveup", relayCapability: "PAIRING-FINGERPRINT",
    relaySealKeyBase64: Buffer.from("g".repeat(32)).toString("base64url"), streamId: "decision-giveup:phone"
  }, {
    ...sender([]),
    async applyMobileDecision() { attempts += 1; throw new Error("The approval was already closed."); }
  });
  service.onDecisionDiagnostic = (detail) => { diagnostics.push(`${detail.outcome}:${detail.attempts}`); };
  const event = {
    eventId: "decision-stale", conversationId: "conversation-1", kind: "permission.decided" as const,
    payload: { operationId: "permission:closed:allow", targetKey: "approval:closed", stateId: "approved", detail: { approve: true } }
  };
  try {
    for (let poll = 1; poll <= 4; poll += 1) {
      const accepted = await service.acceptMobileOutboxEvents([event], `mailbox:${poll}`);
      assert.deepEqual(accepted.eventIds, [], `attempt ${poll} is reported as not taken, without throwing`);
    }
    const last = await service.acceptMobileOutboxEvents([event], "mailbox:5");
    assert.deepEqual(last.eventIds, ["decision-stale"], "the fifth attempt gives up and lets the page move on");
    assert.equal(attempts, 5);
    assert.deepEqual(diagnostics, ["failed:1", "failed:2", "failed:3", "failed:4", "given-up:5"]);
    const again = await service.acceptMobileOutboxEvents([event], "mailbox:6");
    assert.deepEqual(again.eventIds, ["decision-stale"], "a re-read of the same answer is not applied again");
    assert.equal(attempts, 5);
  } finally { service.close(); }
});

test("a message beside an answer the desktop cannot take is delivered once and acked; the answer is retried on later polls, then given up", async () => {
  const sent: unknown[] = [];
  let decisionAttempts = 0;
  const diagnostics: string[] = [];
  const service = new MobileRelayControlService({
    relayUrl: "ws://127.0.0.1:1/v1/relay", rendezvousId: "rv-mixed-page", relayCapability: "PAIRING-FINGERPRINT",
    relaySealKeyBase64: Buffer.from("x".repeat(32)).toString("base64url"), streamId: "mixed-page:phone"
  }, { ...sender(sent), async applyMobileDecision() { decisionAttempts += 1; throw new Error("The approval was already closed."); } });
  service.onDecisionDiagnostic = (detail) => { diagnostics.push(`${detail.outcome}:${detail.attempts}`); };
  const decision = { eventId: "decision-mixed", conversationId: "conversation-1", kind: "permission.decided" as const,
    payload: { operationId: "permission:closed:allow", targetKey: "approval:closed", stateId: "approved", detail: { approve: true } } };
  const message = { eventId: "message-mixed", conversationId: "conversation-1", createdAt: "2026-09-20T10:00:00.000Z", payload: { content: "hello" } };
  try {
    const first = await service.acceptMobileOutboxEvents([decision, message], "mailbox:1");
    assert.deepEqual(first.eventIds, ["message-mixed"], "the message is acked, the failing answer is not");
    assert.equal(sent.length, 1, "the message went to sendMessage once");
    // The page is consumed. The poller's retry tick is what offers the answer again.
    for (let poll = 2; poll <= 4; poll += 1) {
      const retried = await service.retryFailedDecisions(`mailbox:retry:${poll}`);
      assert.deepEqual(retried.eventIds, [], `attempt ${poll} still withheld`);
    }
    const last = await service.retryFailedDecisions("mailbox:retry:5");
    assert.deepEqual(last.eventIds, ["decision-mixed"], "the fifth attempt gives up and reports the answer as taken");
    assert.deepEqual(await service.retryFailedDecisions("mailbox:retry:6"), { eventIds: [], runIds: [] }, "nothing is left to retry");
    assert.equal(decisionAttempts, 5);
    assert.equal(sent.length, 1, "the message is never sent a second time");
    assert.deepEqual(diagnostics, ["failed:1", "failed:2", "failed:3", "failed:4", "given-up:5"]);
  } finally { service.close(); }
});

test("a batch the desktop refuses outright is answered with an empty ack rather than silence", async () => {
  const key = Buffer.from("n".repeat(32)).toString("base64url");
  const relay = createReferenceRelayServer();
  const address = await relay.listen();
  const desktop = new MobileRelayControlService({
    relayUrl: address.url, rendezvousId: "rv-nack", relayCapability: "PAIRING-FINGERPRINT",
    relaySealKeyBase64: key, conversationId: "conversation-1", streamId: "nack:phone", reconnectDelayMs: 50
  }, sender([]));
  const phone = new RelayTunnelClient({
    relayUrl: address.url, rendezvousId: "rv-nack", role: "phone", capability: "PAIRING-FINGERPRINT", streamId: "nack:phone"
  });
  try {
    await desktop.connect();
    await phone.connect();
    const reply = nextMessage(phone);
    await phone.sendCiphertext({
      logicalMessageId: "outside-scope",
      ciphertext: await sealMobileRelayPayload({ type: "mobile.outbox.events", events: [{
        eventId: "outside-1", conversationId: "another-conversation", payload: { content: "hello" }
      }] }, key)
    });
    const answered = await reply;
    assert.equal(answered.logicalMessageId, "outside-scope:ack");
    const ack = await openMobileRelayPayload(answered.ciphertext, key) as { type: string; eventIds: string[] };
    assert.equal(ack.type, "mobile.outbox.ack");
    assert.deepEqual(ack.eventIds, [], "nothing was taken, and the phone is told so at once");
  } finally { phone.close(); desktop.close(); await relay.close(); }
});

test("cards remembered as delivered are forgotten again when the durable sink refuses the batch, and a second snapshot inside the publish window does not ring twice", async () => {
  let publishes = 0;
  let release: (() => void) | undefined;
  const options: Array<{ runFinished?: boolean; notices?: string[] }> = [];
  const service = new MobileRelayControlService({
    relayUrl: "ws://127.0.0.1:1/v1/relay", rendezvousId: "rv-cards-window", relayCapability: "PAIRING-FINGERPRINT",
    relaySealKeyBase64: Buffer.from("w".repeat(32)).toString("base64url"), streamId: "cards-window:phone"
  }, sender([]), undefined, undefined, { async publishTimeline(_timeline, publishOptions) {
    publishes += 1;
    options.push(publishOptions ?? {});
    if (publishes === 1) throw new Error("Mailbox unreachable");
    // The second publish is held open, the way the relay now holds an append
    // while it rings the phone.
    await new Promise<void>((resolve) => { release = resolve; });
  } });
  const base: Conversation = {
    id: "conversation-window", kind: "chat", title: "Window", createdAt: "2026-09-20T10:00:00Z",
    updatedAt: "2026-09-20T10:00:00Z", findings: [], metadata: {},
    messages: [{ id: "m1", role: "participant", participantLabel: "@drew", content: "Ready.", status: "done",
      createdAt: "2026-09-20T09:59:00Z", metadata: { runId: "run-1" } }]
  };
  const withCard = (updatedAt: string): Conversation => ({ ...base, updatedAt, metadata: { pendingAppToolApprovals: [{
    id: "approval-window", status: "pending", summary: "Allow it?", createdAt: "2026-09-20T10:00:00Z"
  }] } });
  try {
    // First sighting: no card, delivered fine? No: the sink refuses it.
    service.pushConversationSnapshot(base);
    await waitFor(() => publishes === 1);
    // The card appears; the batch is published (held) — and a second snapshot
    // arrives while the first is still on its way.
    service.pushConversationSnapshot(withCard("2026-09-20T10:00:01Z"));
    await waitFor(() => publishes === 2);
    service.pushConversationSnapshot({ ...withCard("2026-09-20T10:00:02Z"), messages: [...base.messages, {
      id: "m2", role: "participant", participantLabel: "@drew", content: "Still here.", status: "done",
      createdAt: "2026-09-20T10:00:02Z", metadata: { runId: "run-2" } }] });
    await waitFor(() => publishes === 3);
    release?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(options[1].notices?.includes("approval"), true, "the card's first batch rings for it");
    assert.equal(options[2].notices?.includes("approval") ?? false, false, "the batch inside the window does not ring for the same card again");
  } finally { service.close(); }
});

test("a retried answer whose chat has left the pairing's scope is given up without taking the others with it", async () => {
  const attempts: string[] = [];
  const diagnostics: string[] = [];
  const allowed = new Set(["conversation-a", "conversation-b"]);
  const service = new MobileRelayControlService({
    relayUrl: "ws://127.0.0.1:1/v1/relay", rendezvousId: "rv-retry-scope", relayCapability: "PAIRING-FINGERPRINT",
    relaySealKeyBase64: Buffer.from("s".repeat(32)).toString("base64url"), streamId: "retry-scope:phone"
  }, {
    ...sender([]),
    async applyMobileDecision(request) { attempts.push(request.conversationId); throw new Error("Not yet."); }
  }, {
    async listChats() { return []; },
    async listTimeline() { return []; },
    isConversationAllowed(conversationId) { return allowed.has(conversationId); }
  });
  service.onDecisionDiagnostic = (detail) => { diagnostics.push(`${detail.conversationId}:${detail.outcome}`); };
  const decision = (conversationId: string) => ({
    eventId: `decision-${conversationId}`, conversationId, kind: "permission.decided" as const,
    payload: { operationId: `permission:${conversationId}:allow`, targetKey: `approval:${conversationId}`, stateId: "approved", detail: { approve: true } }
  });
  try {
    const first = await service.acceptMobileOutboxEvents([decision("conversation-a"), decision("conversation-b")], "mailbox:1");
    assert.deepEqual(first.eventIds, [], "both answers are withheld and kept for the next poll");
    allowed.delete("conversation-b");
    const retried = await service.retryFailedDecisions("mailbox:retry");
    assert.deepEqual(retried.eventIds, [], "the answer still in scope is retried and still withheld");
    assert.deepEqual(attempts, ["conversation-a", "conversation-b", "conversation-a"], "the out-of-scope answer is not tried again; the other is");
    assert.ok(diagnostics.includes("conversation-b:given-up"), `the refusal is said: ${diagnostics.join(", ")}`);
  } finally { service.close(); }
});

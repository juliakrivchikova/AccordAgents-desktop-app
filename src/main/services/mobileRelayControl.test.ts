import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import type { Conversation, StartReviewResult } from "../../shared/types";
import { RelayTunnelClient } from "./relayTunnelClient";
import { MobileRelayControlService, type MobileRelayChatSender, type MobileTimelineEvents } from "./mobileRelayControl";
import { openMobileRelayPayload, sealMobileRelayPayload } from "./mobileRelaySealing";

const requireScript = createRequire(__filename);
const { createReferenceRelayServer } = requireScript(path.join(process.cwd(), "scripts/relay-reference-server.cjs")) as {
  createReferenceRelayServer(): {
    listen(): Promise<{ url: string }>;
    close(): Promise<void>;
  };
};

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
    assert.deepEqual(payload, {
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
    assert.deepEqual(payload, {
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

// W-M(d) reshaped this path: a pending tick whose only content is the
// growing reply publishes NOTHING durable (the partial text is live-only),
// so the durable frames are the ack, the running placeholder, and the
// terminal — which keeps its text and must not be eaten by the delivery
// dedup even though the content never changed.
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
    const messages = nextMessages(phone, 3);
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

    const [, runningMessage, doneMessage] = await messages;
    const running = await openMobileRelayPayload(runningMessage.ciphertext, key);
    const done = await openMobileRelayPayload(doneMessage.ciphertext, key);
    assertRunningTimeline(running, "conversation-1", "mobile-event-status-transition", "@cloud");
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
    // The contract line: no fourth durable frame carries the partial text.
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
      }]
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

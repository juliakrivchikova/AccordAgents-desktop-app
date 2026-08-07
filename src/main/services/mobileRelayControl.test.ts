import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { RelayTunnelClient } from "./relayTunnelClient";
import { MobileRelayControlService, type MobileRelayChatSender } from "./mobileRelayControl";
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

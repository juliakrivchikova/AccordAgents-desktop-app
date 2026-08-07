import { randomUUID } from "node:crypto";
import type { ReviewProgress, SendChatMessageRequest, StartReviewResult } from "../../shared/types";
import { RelayTunnelClient, type RelayTunnelMessage } from "./relayTunnelClient";
import { openMobileRelayPayload, sealMobileRelayPayload } from "./mobileRelaySealing";

type ProgressCallback = (progress: ReviewProgress) => void;

export interface MobileRelayControlOptions {
  relayUrl: string;
  rendezvousId: string;
  relayCapability: string;
  relaySealKeyBase64: string;
  conversationId: string;
  streamId: string;
  reconnectDelayMs?: number;
}

export interface MobileRelayChatSender {
  sendMessage(
    request: SendChatMessageRequest,
    signal?: AbortSignal,
    progress?: ProgressCallback
  ): Promise<StartReviewResult>;
}

export interface MobileRelayAcceptedResult {
  eventIds: string[];
  runIds: string[];
}

interface MobileOutboxRequest {
  type: "mobile.outbox.events";
  events: MobileOutboxEvent[];
}

interface MobileOutboxEvent {
  eventId: string;
  conversationId: string;
  payload: {
    content: string;
  };
}

interface MobileOutboxAck {
  type: "mobile.outbox.ack";
  ackRole: "desktop";
  eventIds: string[];
  runIds: string[];
}

export class MobileRelayControlService {
  private readonly client: RelayTunnelClient;
  private readonly abortController = new AbortController();
  private connected = false;

  constructor(
    private readonly options: MobileRelayControlOptions,
    private readonly chat: MobileRelayChatSender,
    private readonly progress?: ProgressCallback
  ) {
    this.client = new RelayTunnelClient({
      relayUrl: options.relayUrl,
      rendezvousId: options.rendezvousId,
      role: "desktop",
      capability: options.relayCapability,
      streamId: options.streamId,
      reconnectDelayMs: options.reconnectDelayMs
    });
    this.client.on("message", (message) => {
      void this.handleMessage(message);
    });
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }
    await this.client.connect();
    this.connected = true;
  }

  close(): void {
    this.abortController.abort();
    this.client.close();
    this.connected = false;
  }

  async acceptSealedMobileOutbox(ciphertext: string): Promise<MobileRelayAcceptedResult> {
    const request = assertMobileOutboxRequest(
      await openMobileRelayPayload(ciphertext, this.options.relaySealKeyBase64)
    );
    const eventIds: string[] = [];
    const runIds: string[] = [];
    for (const event of request.events) {
      if (event.conversationId !== this.options.conversationId) {
        throw new Error("Mobile relay event conversationId is outside the paired scope.");
      }
      const runId = `mobile-${event.eventId || randomUUID()}`;
      await this.chat.sendMessage(
        {
          conversationId: event.conversationId,
          content: event.payload.content,
          runId
        },
        this.abortController.signal,
        this.progress
      );
      eventIds.push(event.eventId);
      runIds.push(runId);
    }
    return { eventIds, runIds };
  }

  private async handleMessage(message: RelayTunnelMessage): Promise<void> {
    const accepted = await this.acceptSealedMobileOutbox(message.ciphertext);
    const ack = await sealMobileRelayPayload({
      type: "mobile.outbox.ack",
      ackRole: "desktop",
      eventIds: accepted.eventIds,
      runIds: accepted.runIds
    } satisfies MobileOutboxAck, this.options.relaySealKeyBase64);
    await this.client.sendCiphertext({
      logicalMessageId: `${message.logicalMessageId}:ack`,
      ciphertext: ack
    });
  }
}

function assertMobileOutboxRequest(value: unknown): MobileOutboxRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Mobile relay request must be an object.");
  }
  const request = value as Partial<MobileOutboxRequest>;
  if (request.type !== "mobile.outbox.events" || !Array.isArray(request.events)) {
    throw new Error("Mobile relay request must contain mobile.outbox.events.");
  }
  if (request.events.length === 0) {
    throw new Error("Mobile relay request must contain at least one event.");
  }
  for (const event of request.events) {
    assertMobileOutboxEvent(event);
  }
  return request as MobileOutboxRequest;
}

function assertMobileOutboxEvent(value: unknown): asserts value is MobileOutboxEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Mobile relay outbox event must be an object.");
  }
  const event = value as Partial<MobileOutboxEvent>;
  assertNonEmptyString(event.eventId, "eventId");
  assertNonEmptyString(event.conversationId, "conversationId");
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
    throw new Error("Mobile relay outbox event requires payload.");
  }
  assertNonEmptyString((event.payload as Partial<MobileOutboxEvent["payload"]>).content, "payload.content");
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Mobile relay outbox event requires ${label}.`);
  }
}

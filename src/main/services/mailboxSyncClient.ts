import type { ChatEventEnvelope } from "../../shared/chatEvents";

export interface MailboxSyncClientOptions {
  baseUrl: string;
  fetchImpl?: FetchLike;
}

export interface MailboxAppendAck {
  ackRole: "mailbox";
  eventIds: string[];
  appendedEventIds: string[];
  duplicateEventIds: string[];
}

export interface MailboxRangeRequest {
  conversationId: string;
  logScopeId?: string;
  originId?: string;
  afterSeq?: number;
  limit?: number;
}

type FetchLike = (url: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

export class MailboxSyncClient {
  private readonly baseUrl: URL;
  private readonly fetchImpl: FetchLike;

  constructor(options: MailboxSyncClientOptions) {
    this.baseUrl = assertBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async appendEvents(events: ChatEventEnvelope[]): Promise<MailboxAppendAck> {
    if (events.length === 0) {
      return { ackRole: "mailbox", eventIds: [], appendedEventIds: [], duplicateEventIds: [] };
    }
    const response = await this.fetchImpl(this.endpoint("/v1/mailbox/events"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events })
    });
    const body = await readJsonResponse(response);
    const ack = assertMailboxAppendAck(body);
    assertExactAck(events, ack);
    return ack;
  }

  async listEvents(request: MailboxRangeRequest): Promise<ChatEventEnvelope[]> {
    assertNonEmptyString(request.conversationId, "conversationId");
    const url = new URL(this.endpoint("/v1/mailbox/events"));
    url.searchParams.set("conversationId", request.conversationId);
    url.searchParams.set("logScopeId", request.logScopeId ?? request.conversationId);
    if (request.originId) {
      url.searchParams.set("originId", request.originId);
    }
    if (request.afterSeq !== undefined) {
      if (!Number.isSafeInteger(request.afterSeq) || request.afterSeq < 0) {
        throw new Error("Mailbox range afterSeq must be a non-negative safe integer.");
      }
      url.searchParams.set("afterSeq", String(request.afterSeq));
    }
    if (request.limit !== undefined) {
      if (!Number.isSafeInteger(request.limit) || request.limit < 1) {
        throw new Error("Mailbox range limit must be a positive safe integer.");
      }
      url.searchParams.set("limit", String(request.limit));
    }
    const response = await this.fetchImpl(url.toString());
    const body = await readJsonResponse(response);
    return assertMailboxRange(body);
  }

  private endpoint(pathname: string): string {
    return new URL(pathname, this.baseUrl).toString();
  }
}

async function readJsonResponse(response: Awaited<ReturnType<FetchLike>>): Promise<unknown> {
  if (!response.ok) {
    throw new Error(`Mailbox request failed with HTTP ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

function assertMailboxAppendAck(value: unknown): MailboxAppendAck {
  assertRecord(value, "Mailbox append ack");
  if (value.ackRole !== "mailbox") {
    throw new Error("Mailbox append ack must come from ackRole mailbox.");
  }
  const eventIds = assertStringArray(value.eventIds, "Mailbox append ack eventIds");
  const appendedEventIds = assertStringArray(value.appendedEventIds, "Mailbox append ack appendedEventIds");
  const duplicateEventIds = assertStringArray(value.duplicateEventIds, "Mailbox append ack duplicateEventIds");
  return {
    ackRole: "mailbox",
    eventIds,
    appendedEventIds,
    duplicateEventIds
  };
}

function assertExactAck(events: ChatEventEnvelope[], ack: MailboxAppendAck): void {
  const expected = events.map((event) => event.eventId);
  if (ack.eventIds.length !== expected.length) {
    throw new Error("Mailbox append ack must name every submitted eventId exactly once.");
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (ack.eventIds[index] !== expected[index]) {
      throw new Error(`Mailbox append ack eventId mismatch at ${index}.`);
    }
  }
  for (const eventId of [...ack.appendedEventIds, ...ack.duplicateEventIds]) {
    if (!expected.includes(eventId)) {
      throw new Error(`Mailbox append ack named unexpected eventId ${eventId}.`);
    }
  }
}

function assertMailboxRange(value: unknown): ChatEventEnvelope[] {
  assertRecord(value, "Mailbox range response");
  if (!Array.isArray(value.events)) {
    throw new Error("Mailbox range response requires events array.");
  }
  for (const event of value.events) {
    assertChatEventEnvelope(event);
  }
  return value.events;
}

function assertChatEventEnvelope(value: unknown): asserts value is ChatEventEnvelope {
  assertRecord(value, "Mailbox event");
  for (const field of ["eventId", "conversationId", "logScopeId", "originId", "logicalTs", "kind", "payloadHash", "eventHash", "createdAt"]) {
    assertNonEmptyString(value[field], `Mailbox event ${field}`);
  }
  if (!Number.isSafeInteger(value.originSeq) || value.originSeq < 1) {
    throw new Error("Mailbox event originSeq must be a positive safe integer.");
  }
}

function assertBaseUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Mailbox baseUrl must use http or https.");
  }
  return url;
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
}

function assertStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${label} must be an array of non-empty strings.`);
  }
  return value;
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
}

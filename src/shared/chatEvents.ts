export type ChatEventKind = string;

export interface ChatEventEnvelope<Payload = unknown> {
  eventId: string;
  conversationId: string;
  logScopeId: string;
  originId: string;
  originSeq: number;
  logicalTs: string;
  kind: ChatEventKind;
  payload: Payload;
  payloadHash: string;
  eventHash: string;
  prevHash?: string;
  signature?: string;
  keyId?: string;
  createdAt: string;
}

export type ChatEventAppendStatus = "appended" | "duplicate" | "conflict";

export type ChatEventAppendConflictReason = "event-id-conflict" | "origin-sequence-conflict";

export interface ChatEventAppendResult {
  status: ChatEventAppendStatus;
  eventId: string;
  existingEventId?: string;
  conflictReason?: ChatEventAppendConflictReason;
}

export interface ChatEventProjectionRow<Projection = unknown> {
  conversationId: string;
  projectionKey: string;
  version: number;
  lastEventId?: string;
  payload: Projection;
  updatedAt: string;
}

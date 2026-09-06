import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify
} from "node:crypto";
import type { ChatEventEnvelope } from "../../shared/chatEvents";
import type { DeviceEventRecipient } from "../../shared/deviceEventDelivery";
import { HybridLogicalClock } from "../../shared/hlc";
import { stableJson } from "../../shared/stableJson";
import type {
  ChatEventDeviceIdentityRecord,
  StorageService
} from "./storage";

export interface CreateLocalChatEventRequest<Payload = unknown> {
  conversationId: string;
  logScopeId: string;
  kind: string;
  payload: Payload;
  eventId?: string;
  /** Written atomically with the event before it can be sent. */
  recipients?: DeviceEventRecipient[];
}

export interface SignedChatEventAppendResult<Payload = unknown> {
  event: ChatEventEnvelope<Payload>;
  status: "appended" | "duplicate";
}

const LOCAL_APPEND_RETRY_LIMIT = 3;

export class ChatEventLogService {
  private deviceIdentity?: ChatEventDeviceIdentityRecord;
  private deviceIdentityLoad?: Promise<ChatEventDeviceIdentityRecord>;
  private clock?: HybridLogicalClock;
  private readonly localAppendQueues = new Map<string, Promise<void>>();

  constructor(
    private readonly storage: StorageService,
    private readonly now: () => Date = () => new Date()
  ) {}

  private async getClock(): Promise<HybridLogicalClock> {
    const identity = await this.getOrCreateDeviceIdentity();
    if (!this.clock) {
      this.clock = new HybridLogicalClock(identity.originId, () => this.now().getTime());
    }
    return this.clock;
  }

  async getOrCreateDeviceIdentity(): Promise<ChatEventDeviceIdentityRecord> {
    if (this.deviceIdentity) {
      return this.deviceIdentity;
    }
    if (this.deviceIdentityLoad) {
      return this.deviceIdentityLoad;
    }
    this.deviceIdentityLoad = this.loadOrCreateDeviceIdentity().finally(() => {
      this.deviceIdentityLoad = undefined;
    });
    return this.deviceIdentityLoad;
  }

  private async loadOrCreateDeviceIdentity(): Promise<ChatEventDeviceIdentityRecord> {
    const existing = await this.storage.getChatEventDeviceIdentityRecord();
    if (existing) {
      this.deviceIdentity = existing;
      return existing;
    }
    const created = createChatEventDeviceIdentity(this.now().toISOString());
    await this.storage.saveChatEventDeviceIdentityRecord(created);
    this.deviceIdentity = created;
    return created;
  }

  async appendLocalEvent<Payload>(request: CreateLocalChatEventRequest<Payload>): Promise<SignedChatEventAppendResult<Payload>> {
    const identity = await this.getOrCreateDeviceIdentity();
    return this.enqueueLocalAppend(identity.originId, () => this.appendLocalEventWithIdentity(identity, request));
  }

  private async appendLocalEventWithIdentity<Payload>(
    identity: ChatEventDeviceIdentityRecord,
    request: CreateLocalChatEventRequest<Payload>
  ): Promise<SignedChatEventAppendResult<Payload>> {
    const clock = await this.getClock();
    for (let attempt = 0; attempt < LOCAL_APPEND_RETRY_LIMIT; attempt += 1) {
      if (request.eventId) {
        const existing = await this.storage.getChatEvent(request.eventId);
        if (existing) {
          if (existing.originId !== identity.originId || existing.conversationId !== request.conversationId ||
              existing.logScopeId !== request.logScopeId || existing.kind !== request.kind ||
              stableJson(existing.payload) !== stableJson(request.payload)) {
            throw new Error(`Chat event retry ${request.eventId} does not match its original action.`);
          }
          const appended = await this.storage.appendChatEvent(existing, { recipients: request.recipients });
          if (appended.status === "conflict") {
            throw new Error(`Chat event retry ${request.eventId} conflicts with stored history.`);
          }
          return { event: existing as ChatEventEnvelope<Payload>, status: "duplicate" };
        }
      }
      const basis = await this.storage.getChatEventSequenceBasis(identity.originId, request.logScopeId);
      clock.restore(await this.storage.getChatEventClock());
      const event = createSignedChatEvent(identity, {
        ...request,
        originSeq: basis.originSeq,
        prevHash: basis.prevHash,
        logicalTs: clock.tick(),
        createdAt: this.now().toISOString()
      });
      const result = await this.storage.appendChatEvent(event, { recipients: request.recipients });
      if (result.status === "appended" || result.status === "duplicate") {
        return { event, status: result.status };
      }
      if (result.conflictReason !== "origin-sequence-conflict" && !(request.eventId && result.conflictReason === "event-id-conflict")) {
        throw new Error(`Chat event append conflict for ${event.eventId}: ${result.conflictReason ?? "unknown"}.`);
      }
    }
    throw new Error("Chat event append failed after retrying origin sequence conflicts.");
  }

  private enqueueLocalAppend<Payload>(
    originId: string,
    append: () => Promise<SignedChatEventAppendResult<Payload>>
  ): Promise<SignedChatEventAppendResult<Payload>> {
    const queueKey = originId;
    const previous = this.localAppendQueues.get(queueKey) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(append);
    const tail = next.then(() => undefined, () => undefined);
    this.localAppendQueues.set(queueKey, tail);
    return next.finally(() => {
      if (this.localAppendQueues.get(queueKey) === tail) {
        this.localAppendQueues.delete(queueKey);
      }
    });
  }
}

export function createChatEventDeviceIdentity(createdAt: string): ChatEventDeviceIdentityRecord {
  const pair = generateKeyPairSync("ed25519");
  const publicKeyDer = pair.publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const privateKeyDer = pair.privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
  const keyHash = sha256Hex(publicKeyDer);
  return {
    originId: `device-${keyHash.slice(0, 32)}`,
    keyId: `ed25519-${keyHash.slice(0, 32)}`,
    publicKeyDerBase64: publicKeyDer.toString("base64"),
    privateKeyDerBase64: privateKeyDer.toString("base64"),
    createdAt
  };
}

export function createSignedChatEvent<Payload>(
  identity: ChatEventDeviceIdentityRecord,
  request: CreateLocalChatEventRequest<Payload> & {
    originSeq: number;
    prevHash?: string;
    createdAt: string;
    /** Hybrid logical clock key minted by the emitting machine. Callers that
     *  do not run a clock get the legacy per-origin timestamp. */
    logicalTs?: string;
  }
): ChatEventEnvelope<Payload> {
  assertCreateEventRequest(request);
  const payloadHash = `sha256:${sha256Hex(stableJson(request.payload))}`;
  const eventId = request.eventId ?? randomUUID();
  const logicalTs = request.logicalTs ?? logicalTimestamp(request.originSeq, identity.originId, request.logScopeId);
  const unsigned = {
    eventId,
    conversationId: request.conversationId,
    logScopeId: request.logScopeId,
    originId: identity.originId,
    originSeq: request.originSeq,
    logicalTs,
    kind: request.kind,
    payloadHash,
    prevHash: request.prevHash ?? null,
    keyId: identity.keyId,
    createdAt: request.createdAt
  };
  const eventHash = `sha256:${sha256Hex(stableJson(unsigned))}`;
  const signature = sign(
    null,
    Buffer.from(eventHash, "utf8"),
    createPrivateKey({
      key: Buffer.from(identity.privateKeyDerBase64, "base64"),
      format: "der",
      type: "pkcs8"
    })
  ).toString("base64");
  return {
    ...unsigned,
    prevHash: request.prevHash,
    payload: request.payload,
    eventHash,
    signature
  };
}

export function verifySignedChatEvent(event: ChatEventEnvelope, publicKeyDerBase64: string): boolean {
  const unsigned = {
    eventId: event.eventId,
    conversationId: event.conversationId,
    logScopeId: event.logScopeId,
    originId: event.originId,
    originSeq: event.originSeq,
    logicalTs: event.logicalTs,
    kind: event.kind,
    payloadHash: event.payloadHash,
    prevHash: event.prevHash ?? null,
    keyId: event.keyId,
    createdAt: event.createdAt
  };
  if (`sha256:${sha256Hex(stableJson(event.payload))}` !== event.payloadHash) {
    return false;
  }
  if (`sha256:${sha256Hex(stableJson(unsigned))}` !== event.eventHash) {
    return false;
  }
  if (!event.signature) {
    return false;
  }
  return verify(
    null,
    Buffer.from(event.eventHash, "utf8"),
    createPublicKey({
      key: Buffer.from(publicKeyDerBase64, "base64"),
      format: "der",
      type: "spki"
    }),
    Buffer.from(event.signature, "base64")
  );
}

function assertCreateEventRequest(request: CreateLocalChatEventRequest & {
  originSeq: number;
  createdAt: string;
}): void {
  const requiredStrings = [
    ["conversationId", request.conversationId],
    ["logScopeId", request.logScopeId],
    ["kind", request.kind],
    ["createdAt", request.createdAt]
  ] as const;
  for (const [field, value] of requiredStrings) {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`Chat event creation requires ${field}.`);
    }
  }
  if (!Number.isSafeInteger(request.originSeq) || request.originSeq <= 0) {
    throw new Error("Chat event creation requires a positive safe originSeq.");
  }
}

function logicalTimestamp(originSeq: number, originId: string, logScopeId: string): string {
  return `${String(originSeq).padStart(16, "0")}:${originId}:${logScopeId}`;
}

function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

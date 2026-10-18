import type { ChatEventEnvelope } from "../shared/chatEvents";
import { isDeviceEventBlobReference, type DeviceEventBlobReference } from "../shared/deviceEventBlobs";
import {
  HUB_PULL_MAX_EVENTS,
  HUB_PUSH_MAX_EVENTS,
  type HubDevice,
  type HubEventPullResponse,
  type HubEventPushResponse,
  type HubEventPushResult
} from "../shared/hubProtocol";
import { verifySignedChatEvent } from "../main/services/chatEventLog";
import { sha256Hex } from "../main/services/hubAuth";
import type { StorageService } from "../main/services/storage";

/** A payload over this travels as a blob reference (as on every device). */
const MAX_INLINE_EVENT_JSON_BYTES = 64 * 1024;

/**
 * The hub's one order of events.
 *
 * A device pushes its own signed events, in its own chain order; the hub
 * checks each against the device's key and the chain it extends, stores it,
 * and gives it the next place in the order. Everyone reads the order back
 * from any position. Nothing is forwarded and nothing waits on another
 * device: a device that was away reads from where it stopped.
 */
export class HubLog {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<(head: number, conversationIds: string[], originId: string) => void>();

  constructor(private readonly storage: StorageService, private readonly now: () => Date = () => new Date()) {}

  onAppended(listener: (head: number, conversationIds: string[], originId: string) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  head(): Promise<number> {
    return this.storage.hub().head();
  }

  /** Stores the device's events in order; one invalid event does not block the others. */
  push(device: HubDevice, events: unknown): Promise<HubEventPushResponse> {
    const run = this.queue.then(() => this.pushNow(device, events));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async pushNow(device: HubDevice, events: unknown): Promise<HubEventPushResponse> {
    if (!Array.isArray(events)) throw new HubRequestError(400, "The request has no events.");
    if (events.length > HUB_PUSH_MAX_EVENTS) throw new HubRequestError(413, `At most ${HUB_PUSH_MAX_EVENTS} events per request.`);
    const results: HubEventPushResult[] = [];
    const appended = new Set<string>();
    for (const candidate of events) {
      const result = await this.acceptOne(device, candidate);
      results.push(result);
      if (result.status === "accepted") appended.add((candidate as ChatEventEnvelope).conversationId);
    }
    const head = await this.storage.hub().head();
    if (appended.size > 0) {
      for (const listener of this.listeners) {
        try { listener(head, [...appended], device.deviceId); } catch { /* a listener never breaks a push */ }
      }
    }
    return { results, head };
  }

  private async acceptOne(device: HubDevice, candidate: unknown): Promise<HubEventPushResult> {
    const eventId = typeof (candidate as { eventId?: unknown })?.eventId === "string" ? (candidate as { eventId: string }).eventId : "";
    const reject = (error: string): HubEventPushResult => ({ eventId, status: "rejected", error });
    const event = validEnvelope(candidate);
    if (!event) return reject("The event is malformed.");
    if (event.originId !== device.deviceId) return reject("A device pushes only its own events.");
    if (Buffer.byteLength(JSON.stringify(event)) > MAX_INLINE_EVENT_JSON_BYTES) return reject("The event is too large to travel inline.");
    if (event.keyId !== keyIdForPublicKey(device.publicKeyDerBase64) || !verifySignedChatEvent(event, device.publicKeyDerBase64)) {
      return reject("The event's signature does not verify.");
    }
    if (isDeviceEventBlobReference(event.payload) && !await this.blobComplete(event.payload)) {
      return { eventId, status: "blob-missing" };
    }
    const basis = await this.chainBasis(event.originId, event.logScopeId);
    if (event.originSeq > basis.originSeq) return { eventId, status: "gap", expectedSeq: basis.originSeq };
    if (event.originSeq === basis.originSeq && (event.prevHash ?? undefined) !== basis.prevHash) {
      return reject("The event does not extend its chain.");
    }
    const [stored] = await this.storage.appendChatEvents([event]);
    if (stored?.status === "conflict") return { eventId, status: "conflict", error: stored.conflictReason };
    const hubSeq = await this.storage.hub().log(event, this.now().toISOString());
    return { eventId, status: stored?.status === "appended" ? "accepted" : "duplicate", hubSeq };
  }

  /** The next place in a chain: after its newest stored event, or after where
   *  the desktop's first copy left it. */
  private async chainBasis(originId: string, logScopeId: string): Promise<{ originSeq: number; prevHash?: string }> {
    const stored = await this.storage.getChatEventSequenceBasis(originId, logScopeId);
    const anchor = await this.storage.hub().chainAnchor(originId, logScopeId);
    if (anchor && anchor.originSeq + 1 > stored.originSeq) return { originSeq: anchor.originSeq + 1, prevHash: anchor.eventHash };
    return stored;
  }

  private async blobComplete(reference: DeviceEventBlobReference): Promise<boolean> {
    try {
      return await this.storage.deviceEventBlobs().verify(reference);
    } catch {
      return false;
    }
  }

  /** One fragment of a large payload, uploaded before its event. */
  async putBlobFragment(reference: DeviceEventBlobReference, index: number, bytes: Buffer): Promise<void> {
    await this.storage.deviceEventBlobs().store({ reference, index, bytesBase64: bytes.toString("base64") });
  }

  async blobFragment(reference: DeviceEventBlobReference, index: number): Promise<Buffer | undefined> {
    const fragment = await this.storage.deviceEventBlobs().fragment(reference, index);
    return fragment ? Buffer.from(fragment.bytesBase64, "base64") : undefined;
  }

  async pull(device: HubDevice, after: number, limit = HUB_PULL_MAX_EVENTS): Promise<HubEventPullResponse> {
    const hub = this.storage.hub();
    const events = await hub.pull(after, Math.min(limit, HUB_PULL_MAX_EVENTS));
    const head = await hub.head();
    // What a device asked from is what it already holds: a phone that read
    // past an event is not rung for it.
    await hub.setCursor(device.deviceId, after, this.now().toISOString());
    return { events, head };
  }
}

export class HubRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function keyIdForPublicKey(publicKeyDerBase64: string): string {
  return `ed25519-${sha256Hex(Buffer.from(publicKeyDerBase64, "base64")).slice(0, 32)}`;
}

function validEnvelope(value: unknown): ChatEventEnvelope | undefined {
  if (!value || typeof value !== "object") return undefined;
  const event = value as Partial<ChatEventEnvelope>;
  for (const field of ["eventId", "conversationId", "logScopeId", "originId", "logicalTs", "kind", "payloadHash", "eventHash", "createdAt", "signature", "keyId"] as const) {
    if (typeof event[field] !== "string" || !(event[field] as string).trim() || (event[field] as string).length > 512) return undefined;
  }
  if (!Number.isSafeInteger(event.originSeq) || (event.originSeq ?? 0) < 1) return undefined;
  if (event.prevHash !== undefined && event.prevHash !== null && typeof event.prevHash !== "string") return undefined;
  if (!("payload" in event)) return undefined;
  return event as ChatEventEnvelope;
}

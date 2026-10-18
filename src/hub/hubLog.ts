import type { ChatEventEnvelope } from "../shared/chatEvents";
import { DEVICE_EVENT_INLINE_BYTES, isDeviceEventBlobReference, type DeviceEventBlobReference } from "../shared/deviceEventBlobs";
import {
  HUB_PULL_MAX_EVENTS,
  HUB_PUSH_MAX_EVENTS,
  type HubDevice,
  type HubEventPullResponse,
  type HubEventPushResponse,
  type HubEventPushResult
} from "../shared/hubProtocol";
import { CHAT_CHANGES_EVENT_KIND, isChatChangesLogScope } from "../main/services/chatChanges";
import { verifySignedChatEvent } from "../main/services/chatEventLog";
import { sha256Hex } from "../main/services/hubAuth";
import type { StorageService } from "../main/services/storage";

/** The largest event envelope the hub stores inline: a device turns a
 *  payload over DEVICE_EVENT_INLINE_BYTES into a blob reference, so a real
 *  envelope stays well under this. */
const MAX_INLINE_EVENT_JSON_BYTES = DEVICE_EVENT_INLINE_BYTES * 2;

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
  private readonly listeners = new Set<HubAppendListener>();

  constructor(private readonly storage: StorageService, private readonly now: () => Date = () => new Date()) {}

  onAppended(listener: HubAppendListener): () => void {
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
    // Where each chain stands, moved along as this push extends it.
    const chains = new Map<string, ChainBasis>();
    const extending: Array<{ index: number; event: ChatEventEnvelope }> = [];
    for (const [index, candidate] of events.entries()) {
      const eventId = typeof (candidate as { eventId?: unknown })?.eventId === "string" ? (candidate as { eventId: string }).eventId : "";
      const reject = (error: string): HubEventPushResult => ({ eventId, status: "rejected", error });
      const event = validEnvelope(candidate);
      if (!event) { results.push(reject("The event is malformed.")); continue; }
      if (event.originId !== device.deviceId) { results.push(reject("A device pushes only its own events.")); continue; }
      // A chat change is the one kind that may be read second-hand; nothing
      // else may travel under its scope.
      if (isChatChangesLogScope(event.logScopeId) !== (event.kind === CHAT_CHANGES_EVENT_KIND)) { results.push(reject("The event's kind does not match its scope.")); continue; }
      if (Buffer.byteLength(JSON.stringify(event)) > MAX_INLINE_EVENT_JSON_BYTES) { results.push(reject("The event is too large to travel inline.")); continue; }
      if (event.keyId !== keyIdForPublicKey(device.publicKeyDerBase64) || !verifySignedChatEvent(event, device.publicKeyDerBase64)) {
        results.push(reject("The event's signature does not verify."));
        continue;
      }
      if (isDeviceEventBlobReference(event.payload) && !await this.blobComplete(event.payload)) {
        results.push({ eventId, status: "blob-missing" });
        continue;
      }
      const key = `${event.originId}\n${event.logScopeId}`;
      const basis = chains.get(key) ?? await this.chainBasis(event.originId, event.logScopeId);
      chains.set(key, basis);
      if (basis.anchorSeq !== undefined && event.originSeq <= basis.anchorSeq && event.originSeq < basis.originSeq) {
        // Already in the chats the hub was set up with: not added again.
        results.push({ eventId, status: "duplicate" });
        continue;
      }
      if (event.originSeq > basis.originSeq) { results.push({ eventId, status: "gap", expectedSeq: basis.originSeq }); continue; }
      if (event.originSeq === basis.originSeq) {
        if ((event.prevHash ?? undefined) !== basis.prevHash) { results.push(reject("The event does not extend its chain.")); continue; }
        chains.set(key, { ...basis, originSeq: basis.originSeq + 1, prevHash: event.eventHash });
      }
      // Below the chain's head: the very event again, or a conflict, which
      // the store tells apart.
      results.push({ eventId, status: "accepted" });
      extending.push({ index, event });
    }
    const placedConversations = new Set<string>();
    const placedChanges = new Set<string>();
    for (const batch of byteBatches(extending, (item) => Buffer.byteLength(JSON.stringify(item.event)), STORE_BATCH_BYTES)) {
      const stored = await this.storage.appendChatEvents(batch.map((item) => item.event));
      const toPlace = batch.filter((item, position) => {
        const outcome = stored[position];
        if (outcome?.status === "conflict") {
          results[item.index] = { eventId: item.event.eventId, status: "conflict", error: outcome.conflictReason };
          return false;
        }
        if (outcome?.status !== "appended") results[item.index] = { eventId: item.event.eventId, status: "duplicate" };
        return true;
      });
      const places = await this.storage.hub().logMany(toPlace.map((item) => item.event), this.now().toISOString());
      for (const item of toPlace) {
        const place = places.get(item.event.eventId);
        if (!place) throw new Error("The hub could not place an accepted event.");
        results[item.index] = { ...results[item.index], hubSeq: place.hubSeq };
        // Placed now, even when the event itself was stored before (a hub
        // that stopped between the two writes): devices are told about it.
        if (place.placed) {
          placedConversations.add(item.event.conversationId);
          if (item.event.kind === CHAT_CHANGES_EVENT_KIND) placedChanges.add(item.event.conversationId);
        }
      }
    }
    const head = await this.storage.hub().head();
    if (placedConversations.size > 0) {
      for (const listener of this.listeners) {
        try {
          listener({ head, conversationIds: [...placedConversations], changedConversationIds: [...placedChanges], originId: device.deviceId });
        } catch { /* a listener never breaks a push */ }
      }
    }
    return { results, head };
  }

  /** The next place in a chain: after its newest stored event, or after where
   *  the desktop's first copy left it. */
  private async chainBasis(originId: string, logScopeId: string): Promise<ChainBasis> {
    const stored = await this.storage.getChatEventSequenceBasis(originId, logScopeId);
    const anchor = await this.storage.hub().chainAnchor(originId, logScopeId);
    if (anchor && anchor.originSeq + 1 > stored.originSeq) return { originSeq: anchor.originSeq + 1, prevHash: anchor.eventHash, anchorSeq: anchor.originSeq };
    return { originSeq: stored.originSeq, prevHash: stored.prevHash, ...(anchor ? { anchorSeq: anchor.originSeq } : {}) };
  }

  private async blobComplete(reference: DeviceEventBlobReference): Promise<boolean> {
    try {
      return await this.storage.deviceEventBlobs().verify(reference);
    } catch {
      return false;
    }
  }

  /**
   * One fragment of a large payload, uploaded before its event. A body that
   * is complete is never touched again, and while it is incomplete a
   * fragment that differs replaces the stored one: a wrong upload can delay
   * a body, not spoil it.
   */
  async putBlobFragment(reference: DeviceEventBlobReference, index: number, bytes: Buffer): Promise<void> {
    if (await this.blobComplete(reference)) return;
    const blobs = this.storage.deviceEventBlobs();
    const existing = await blobs.fragment(reference, index).catch(() => null);
    if (existing === null || (existing && existing.bytesBase64 !== bytes.toString("base64"))) {
      await this.storage.hub().replaceBlobFragment(reference.blobHash, index, reference.byteLength, reference.fragments);
    }
    await blobs.store({ reference, index, bytesBase64: bytes.toString("base64") });
  }

  async blobFragment(reference: DeviceEventBlobReference, index: number): Promise<Buffer | undefined> {
    const fragment = await this.storage.deviceEventBlobs().fragment(reference, index).catch(() => undefined);
    return fragment ? Buffer.from(fragment.bytesBase64, "base64") : undefined;
  }

  /** The order after `after`, without what the asking device wrote itself. */
  async pull(device: HubDevice, after: number, limit = HUB_PULL_MAX_EVENTS): Promise<HubEventPullResponse> {
    const hub = this.storage.hub();
    const page = await hub.pull(after, Math.min(limit, HUB_PULL_MAX_EVENTS), device.deviceId);
    const head = await hub.head();
    // What a device asked from is what it already holds: a phone that read
    // past an event is not rung for it.
    await hub.setCursor(device.deviceId, after, this.now().toISOString());
    return { events: page.events, through: page.through, head };
  }
}

/** What one push placed in the order. */
export interface HubAppended {
  head: number;
  conversationIds: string[];
  /** Chats whose content changed (chat change events), not only their traffic. */
  changedConversationIds: string[];
  originId: string;
}

export type HubAppendListener = (appended: HubAppended) => void;

interface ChainBasis {
  originSeq: number;
  prevHash?: string;
  /** Where the hub's first copy of the chats left this chain. */
  anchorSeq?: number;
}

/** Events stored per write: one transaction, bounded statement size. */
const STORE_BATCH_BYTES = 2 * 1024 * 1024;

function byteBatches<T>(items: T[], size: (item: T) => number, limit: number): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let bytes = 0;
  for (const item of items) {
    const itemBytes = size(item);
    if (current.length > 0 && bytes + itemBytes > limit) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += itemBytes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export class HubRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function keyIdForPublicKey(publicKeyDerBase64: string): string {
  return `ed25519-${sha256Hex(Buffer.from(publicKeyDerBase64, "base64")).slice(0, 32)}`;
}

/** No control character in an event's names: they are stored as SQL text. */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

function validEnvelope(value: unknown): ChatEventEnvelope | undefined {
  if (!value || typeof value !== "object") return undefined;
  const event = value as Partial<ChatEventEnvelope>;
  for (const field of ["eventId", "conversationId", "logScopeId", "originId", "logicalTs", "kind", "payloadHash", "eventHash", "createdAt", "signature", "keyId"] as const) {
    const text = event[field];
    if (typeof text !== "string" || !text.trim() || text.length > 512 || CONTROL_CHARACTER.test(text)) return undefined;
  }
  if (!Number.isSafeInteger(event.originSeq) || (event.originSeq ?? 0) < 1) return undefined;
  if (event.prevHash !== undefined && event.prevHash !== null && (typeof event.prevHash !== "string" || CONTROL_CHARACTER.test(event.prevHash))) return undefined;
  if (!("payload" in event)) return undefined;
  return event as ChatEventEnvelope;
}

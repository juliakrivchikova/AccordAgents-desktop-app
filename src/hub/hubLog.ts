import type { ChatEventEnvelope } from "../shared/chatEvents";
import { DEVICE_EVENT_INLINE_BYTES, isDeviceEventBlobReference, type DeviceEventBlobReference } from "../shared/deviceEventBlobs";
import {
  HUB_PULL_MAX_EVENTS,
  HUB_PUSH_MAX_EVENTS,
  type HubChainResponse,
  type HubCopyMark,
  type HubCopyPart,
  type HubDevice,
  type HubEventPullResponse,
  type HubEventPushResponse,
  type HubEventPushResult,
  type HubKnownDevicesResponse,
  type HubReadReport,
  type HubReaderStatus,
  type HubReadersResponse,
  type HubSnapshotResponse
} from "../shared/hubProtocol";
import { CHAT_CHANGES_EVENT_KIND, isChatChangesLogScope } from "../main/services/chatChanges";
import { copiedConversation } from "../main/services/chatCopy";
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

  constructor(
    private readonly storage: StorageService,
    private readonly now: () => Date = () => new Date(),
    /** A snapshot page is at most about this much JSON (tests shorten it). */
    private readonly snapshotPageBytes = SNAPSHOT_PAGE_BYTES
  ) {}

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

  /** The next place in a chain: after its newest stored event, after where
   *  the desktop's first copy left it, or after where the hub forgot it. */
  private async chainBasis(originId: string, logScopeId: string): Promise<ChainBasis> {
    const stored = await this.storage.getChatEventSequenceBasis(originId, logScopeId);
    const anchor = await this.storage.hub().chainAnchor(originId, logScopeId);
    const mark = await this.storage.hub().chainMark(originId, logScopeId);
    // Held below this (copied, or kept and forgotten): not placed again.
    const below = Math.max(anchor?.originSeq ?? 0, mark?.originSeq ?? 0);
    const anchorSeq = below > 0 ? { anchorSeq: below } : {};
    const start = [anchor, mark].filter((item): item is { originSeq: number; eventHash: string } => Boolean(item))
      .sort((left, right) => right.originSeq - left.originSeq)[0];
    if (start && start.originSeq + 1 > stored.originSeq) return { originSeq: start.originSeq + 1, prevHash: start.eventHash, ...anchorSeq };
    return { originSeq: stored.originSeq, prevHash: stored.prevHash, ...anchorSeq };
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

  /**
   * The order after `after`, without what the asking device wrote itself.
   *
   * A device that says what it holds (`report`) is kept for from its floor:
   * min(after, its lowest held place - 1). Such a device asking from below
   * what the hub can vouch for (it never read here, or asks from before its
   * floor) while events it would need were forgotten there is told so
   * (HubResyncRequiredError) instead of being given a page with holes. A
   * `peek` (a held event read again) moves no cursor.
   */
  async pull(device: HubDevice, after: number, limit = HUB_PULL_MAX_EVENTS, report?: HubReadReport & { peek?: boolean }): Promise<HubEventPullResponse> {
    const hub = this.storage.hub();
    const now = this.now().toISOString();
    if (report) {
      const standing = await hub.readerFloor(device.deviceId);
      if (!standing || after < standing.floor) {
        const prunedThrough = await hub.prunedThrough(await this.readerClasses(device));
        if (prunedThrough > after) throw new HubResyncRequiredError(prunedThrough);
      }
    }
    const page = await hub.pull(after, Math.min(limit, HUB_PULL_MAX_EVENTS), device.deviceId);
    const head = await hub.head();
    if (!report?.peek) {
      // What a device asked from is what it already holds: a phone that read
      // past an event is not rung for it.
      await hub.setCursor(device.deviceId, after, now);
      if (report) {
        const floor = report.held > 0 ? Math.min(after, report.held - 1) : after;
        await hub.recordRead(device.deviceId, floor, {
          from: report.held, count: report.heldCount,
          ...(report.heldSince > 0 ? { since: new Date(report.heldSince).toISOString() } : {})
        }, now);
      } else if (device.role !== "phone") {
        // An older device does not say what it holds: its place is where it
        // reads from, as it was before floors (it drops what it held for
        // long itself).
        await hub.recordRead(device.deviceId, after, { from: 0, count: 0 }, now);
      }
    }
    return { events: page.events, through: page.through, head };
  }

  /** The classes of forgotten events a device reads: chat changes and
   *  actions, and its channels (a desktop is in every one; a machine whose
   *  channel the hub cannot tell is counted in every one too). */
  private async readerClasses(device: HubDevice): Promise<string[]> {
    const hub = this.storage.hub();
    const shared = ["chat-changes", "chat-actions"];
    const all = await hub.prunedPairClasses();
    if (device.role !== "machine") return [...shared, ...all];
    const rids = new Set((await hub.deviceReads()).filter((row) => row.deviceId === device.deviceId && row.rendezvousId).map((row) => row.rendezvousId as string));
    for (const row of await hub.pairAuthors()) if (row.originId === device.deviceId) rids.add(row.rendezvousId);
    return rids.size ? [...shared, ...[...rids].map((rid) => `pair:${rid}`)] : [...shared, ...all];
  }

  /** One chain's events in a range, for a reader that found a gap; with how
   *  far the hub forgot that chain. */
  async chain(originId: string, logScopeId: string, fromSeq: number, toSeq: number): Promise<HubChainResponse> {
    const hub = this.storage.hub();
    const events = await hub.chainEvents(originId, logScopeId, fromSeq, toSeq, HUB_PULL_MAX_EVENTS);
    const pruned = await hub.chainMark(originId, logScopeId);
    return { events, ...(pruned ? { pruned } : {}) };
  }

  /**
   * Where a device starts reading again, and the hub's copy of every chat.
   *
   * The first page fixes the position: the order's head, but before any
   * chat change the copy does not hold yet (`copy`), before any event still
   * kept in the device's own channels (`scopes`), and at most `atMost` (a
   * copy the device already has was made there). Everything after it is
   * kept for the device from now on. `marks` say how far the copy covers
   * each chat change chain; a change after a mark arrives as an event.
   */
  async snapshot(device: HubDevice, request: { page?: string; scopes: string[]; atMost?: number; copy: boolean; chat?: string }): Promise<HubSnapshotResponse> {
    const hub = this.storage.hub();
    let position: SnapshotPosition;
    let marks: HubCopyMark[] | undefined;
    if (request.chat) {
      // One chat's copy, for a reader whose chain of its changes the hub
      // forgot: it does not move where that reader stands.
      const scope = `chat-changes:${request.chat}`;
      position = request.page ? parseSnapshotPage(request.page) : { hubSeq: await hub.head(), afterId: "", offset: 0 };
      if (!request.page) marks = (await hub.copyMarks()).filter((mark) => mark.logScopeId === scope);
      const page = await this.copyPage(position, request.chat);
      return { hubSeq: position.hubSeq, ...(marks ? { marks } : {}), conversations: page.parts, ...(page.next ? { next: formatSnapshotPage(page.next) } : {}) };
    }
    if (request.page) {
      position = parseSnapshotPage(request.page);
    } else {
      let hubSeq = await hub.head();
      if (request.atMost !== undefined) hubSeq = Math.min(hubSeq, Math.max(0, Math.floor(request.atMost)));
      if (request.copy) {
        const unfolded = await hub.lowestUnfolded();
        if (unfolded > 0) hubSeq = Math.min(hubSeq, unfolded - 1);
      }
      const own = await hub.lowestInScopes(request.scopes, device.deviceId);
      if (own > 0) hubSeq = Math.min(hubSeq, own - 1);
      // Marks first, chats after: a chat read later can only hold more.
      if (request.copy) marks = await hub.copyMarks();
      await hub.startReader(device.deviceId, hubSeq, this.now().toISOString());
      position = { hubSeq, afterId: "", offset: 0 };
    }
    if (!request.copy) return { hubSeq: position.hubSeq, conversations: [] };
    const page = await this.copyPage(position);
    return { hubSeq: position.hubSeq, ...(marks ? { marks } : {}), conversations: page.parts, ...(page.next ? { next: formatSnapshotPage(page.next) } : {}) };
  }

  /** One page of the hub's copy after `position`: whole chats in id order,
   *  and a chat too large for one page in parts. */
  private async copyPage(position: SnapshotPosition, only?: string): Promise<{ parts: HubCopyPart[]; next?: SnapshotPosition }> {
    const tombstones = this.storage.conversationTombstones();
    const ids = only ? [only] : (await this.storage.listConversations()).filter((summary) => summary.kind === "chat").map((summary) => summary.id).sort();
    const continuing = position.offset > 0;
    let index = continuing ? ids.indexOf(position.afterId) : -1;
    if (index < 0) index = position.afterId ? ids.findIndex((id) => id > position.afterId) : 0;
    if (index < 0) return { parts: [] };
    const parts: HubCopyPart[] = [];
    const next = (afterId: string, offset: number): SnapshotPosition => ({ hubSeq: position.hubSeq, afterId, offset });
    let bytes = 0;
    // The last chat carried whole: the next page starts after it.
    let lastDone = continuing ? "" : position.afterId;
    for (; index < ids.length; index += 1) {
      const id = ids[index];
      const conversation = await tombstones.isDeleted(id) ? undefined : await this.storage.getConversation(id);
      if (!conversation || conversation.kind !== "chat") {
        lastDone = id;
        continue;
      }
      const copied = copiedConversation(conversation);
      const start = continuing && id === position.afterId ? Math.min(position.offset, copied.messages.length) : 0;
      const head = { id, updatedAt: copied.updatedAt, shared: copied.shared, removed: copied.removed, ...(copied.authors ? { authors: copied.authors } : {}) };
      const headBytes = Buffer.byteLength(JSON.stringify(head));
      if (parts.length > 0 && bytes + headBytes > this.snapshotPageBytes) return { parts, next: next(lastDone, 0) };
      bytes += headBytes;
      let end = start;
      // Messages until the page is full; the first item of a page always goes.
      while (end < copied.messages.length) {
        const size = Buffer.byteLength(JSON.stringify(copied.messages[end]));
        if (bytes + size > this.snapshotPageBytes && (end > start || parts.length > 0)) break;
        bytes += size;
        end += 1;
      }
      if (end === start && start < copied.messages.length) return { parts, next: start > 0 ? next(id, start) : next(lastDone, 0) };
      const more = end < copied.messages.length;
      parts.push({ ...head, messages: copied.messages.slice(start, end), ...(more ? { more: true } : {}) });
      if (more) return { parts, next: next(id, end) };
      lastDone = id;
      if (bytes >= this.snapshotPageBytes && index + 1 < ids.length) return { parts, next: next(id, 0) };
    }
    return { parts };
  }

  /** Every device that reads the order, where it stands and what it holds. */
  async readers(): Promise<HubReadersResponse> {
    const hub = this.storage.hub();
    const devices = await hub.devices();
    const floors = new Map((await hub.readerFloors()).map((row) => [row.deviceId, row]));
    const reads = new Map((await hub.deviceReads()).map((row) => [row.deviceId, row]));
    const readers: HubReaderStatus[] = [];
    for (const device of devices) {
      const standing = floors.get(device.deviceId);
      if (device.role === "phone" || (!standing && device.role !== "owner" && reads.get(device.deviceId)?.reader !== true)) continue;
      readers.push({
        deviceId: device.deviceId, name: device.name, role: device.role, ...(device.machineId ? { machineId: device.machineId } : {}),
        floor: standing?.floor ?? 0,
        ...(standing?.readAt ? { readAt: standing.readAt } : device.addedAt ? { readAt: device.addedAt } : {}),
        ...(!standing?.firstReadAt ? { neverRead: true } : {}),
        ...(standing?.heldSince ? { heldSince: standing.heldSince, heldCount: standing.heldCount } : {})
      });
    }
    return { head: await hub.head(), readers };
  }

  /** Which of these devices are on the roster now. */
  async known(ids: string[]): Promise<HubKnownDevicesResponse> {
    const roster = new Set((await this.storage.hub().devices()).map((device) => device.deviceId));
    return { known: ids.filter((id) => roster.has(id)) };
  }
}

/** A snapshot page is at most about this much JSON. */
const SNAPSHOT_PAGE_BYTES = 4 * 1024 * 1024;

interface SnapshotPosition {
  hubSeq: number;
  /** The last chat (by id) the previous page carried. */
  afterId: string;
  /** Messages of that chat already carried (0: it was complete). */
  offset: number;
}

function formatSnapshotPage(position: SnapshotPosition): string {
  return Buffer.from(JSON.stringify([position.hubSeq, position.afterId, position.offset])).toString("base64url");
}

function parseSnapshotPage(page: string): SnapshotPosition {
  try {
    const [hubSeq, afterId, offset] = JSON.parse(Buffer.from(page, "base64url").toString("utf8")) as [unknown, unknown, unknown];
    if (Number.isSafeInteger(hubSeq) && (hubSeq as number) >= 0 && typeof afterId === "string" && afterId.length <= 512 &&
        Number.isSafeInteger(offset) && (offset as number) >= 0) {
      return { hubSeq: hubSeq as number, afterId, offset: offset as number };
    }
  } catch { /* refused below */ }
  throw new HubRequestError(400, "Invalid snapshot page.");
}

/** The hub forgot events this device would need: it starts again from a copy. */
export class HubResyncRequiredError extends Error {
  constructor(readonly prunedThrough: number) {
    super("Events this device needs were forgotten by the server; it starts again from the server's copy.");
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

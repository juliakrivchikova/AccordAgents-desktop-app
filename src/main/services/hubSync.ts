import type { ChatEventEnvelope } from "../../shared/chatEvents";
import type { DeviceEventGap } from "../../shared/deviceEventDelivery";
import { HUB_PUSH_MAX_EVENTS, type HubCopyMark, type HubCopyPart, type HubEventPushResult, type HubLoggedEvent, type HubReadReport } from "../../shared/hubProtocol";
import { CHAT_ACTION_LOG_SCOPE } from "../../shared/chatActionEvents";
import { CHAT_CHANGES_EVENT_KIND, isChatChangesLogScope, isChatChangesPayload, type ChatChangesPayload } from "./chatChanges";
import { CHAT_COPY_HUB_POSITION_KEY, type CopiedConversation } from "./chatCopy";
import { verifySignedChatEvent } from "./chatEventLog";
import type { DeviceEventChannel } from "./deviceEventChannel";
import { DevicePacketAuthenticationError } from "./devicePacketAuthentication";
import { HubHttpError, HubTransientError, isHubResyncRequired, type HubClient } from "./hubClient";
import type { StorageService } from "./storage";

/** Where this device keeps its place with the hub (setup moves them). */
export const PUSHED_KEY = "pushed-rowid";
export const PULLED_KEY = "pulled-hub-seq";
export const HUB_ID_KEY = "hub-id";
const PUSH_BATCH = Math.min(100, HUB_PUSH_MAX_EVENTS);
/** Without the live link nothing announces new events: read anyway. With
 *  it, read now and then as well, in case it died without a word. */
const POLL_WITHOUT_LIVE_MS = 15_000;
const POLL_WITH_LIVE_MS = 60_000;
/** Places held back are read again at most this often unless nudged. */
const HELD_RETRY_MS = 10_000;
/** Held places read again from the hub per pass (the rest wait for the next). */
const HELD_RETRY_FETCHES = 100;
const HELD_PAGE = 500;
/** Whether the authors of held places are still on the roster is asked at
 *  most this often: one that is not was removed, and only then is what was
 *  held for it let go. Nothing is dropped for its age. */
const HELD_AUTHORS_CHECK_MS = 10 * 60_000;
/** Starting again from the hub's copy happens at most this often. */
const RESYNC_MIN_INTERVAL_MS = 30 * 60_000;
const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;

/** The log scopes a device sends to the hub: chat changes, its channels'
 *  events and chat actions; never what a desktop wrote for the old phone
 *  mailbox. A desktop narrows `device:` to the machines that read the hub. */
export const HUB_SCOPE_PREFIXES = ["chat-changes:", "device:", CHAT_ACTION_LOG_SCOPE] as const;
export const HUB_SHARED_SCOPE_PREFIXES = ["chat-changes:", CHAT_ACTION_LOG_SCOPE] as const;

/** What a channel did with an event from the hub's order. */
export type HubDeliverOutcome =
  /** Stored by the channel that owns it, which applies it (and retries). */
  | "delivered"
  /** It belongs to a channel this device will have (a machine whose channel
   *  is not set up yet): held and offered again. */
  | "not-ready"
  /** Its channel refused it for good (scope, signature, conflict). */
  | "refused"
  /** No channel of this device is about it. */
  | "not-mine";

/** Hands an event from the hub's order to the channel that owns it, its
 *  large body fetched first (only for an event a channel takes). */
export async function deliverToChannel(channel: DeviceEventChannel, event: ChatEventEnvelope, fetchBody?: () => Promise<void>): Promise<HubDeliverOutcome> {
  await fetchBody?.();
  try {
    return await channel.receiveFromHub(event) === "conflict" ? "refused" : "delivered";
  } catch (error) {
    if (error instanceof DevicePacketAuthenticationError) return "refused";
    throw error;
  }
}

/** How a reader's gap came out (HubSync.repairGap). */
export type HubGapRepair =
  /** The hub had the events: handed in again. */
  | "repaired"
  /** The hub forgot them by design: the chain continues past them. */
  | "skipped"
  /** A chat change chain the hub forgot: the chat taken from the hub's copy. */
  | "resynced"
  /** The hub never had them (refused from their author, or not yet placed). */
  | "unavailable";

/** What applying a chat change no channel took came to. */
export type HubApplyOutcome = "applied" | "ignored" | "held";

/** Where this device's own events stop being held by the hub: those after
 *  this position have not reached it yet. */
export async function hubPushedThrough(storage: Pick<StorageService, "hub">): Promise<number> {
  return Number(await storage.hub().clientState(PUSHED_KEY) ?? "0") || 0;
}

/** Applies a chat change from the hub that no channel took (a phone's): the
 *  same fold every device uses, with a change that must wait held. */
export function hubChatChangeApplier(storage: StorageService, chat: {
  applyRemoteChatChanges(event: ChatEventEnvelope, payload: ChatChangesPayload): Promise<"applied" | "missing-conversation" | "waiting">;
}): (event: ChatEventEnvelope) => Promise<HubApplyOutcome> {
  return async (event) => {
    const payload = await storage.deviceEventBlobs().hydrate(event.payload);
    if (!isChatChangesPayload(payload)) return "ignored";
    const outcome = await chat.applyRemoteChatChanges(event, payload);
    return outcome === "applied" ? "applied" : "held";
  };
}

type ReceiveOutcome = "done" | "unknown-origin" | "not-ready" | "waiting" | "blob-missing" | "error" | "refused";

/** A failure that says nothing about the event: the hub or the network was
 *  away (the client says so), or a channel was closing. The page is read
 *  again later. Anything else is about the event, which is held while the
 *  others go on. */
function isTransient(error: unknown): boolean {
  if (error instanceof HubTransientError || error instanceof HubHttpError) return true;
  return error instanceof Error && error.name === "DeviceEventChannelClosedError";
}

/** Held because of who wrote it (an author not known, a channel not set up):
 *  one such place still held means the others of that author are too. */
const BY_AUTHOR: ReadonlySet<string> = new Set(["unknown-origin", "not-ready"]);

/**
 * One device's link to the hub: its own events go up in the order they were
 * written, and everyone else's come down in the hub's order. Two cursors on
 * disk say how far each went; an event that cannot be taken yet (an author
 * this device does not know yet, a channel not set up yet, a chat it does
 * not hold yet) is held by its place and read again, never passed over.
 */
export class HubSync {
  private pushing?: Promise<void>;
  private pushAgain = false;
  private pulling?: Promise<void>;
  private pullAgain = false;
  private stopLive?: () => void;
  private started = false;
  private pushStarted = false;
  private stopped = false;
  private pullsPaused = false;
  private retry?: ReturnType<typeof setTimeout>;
  private retryDelay = RETRY_MIN_MS;
  private poll?: ReturnType<typeof setTimeout>;
  private connected = false;
  /** Whether the last read reached the hub (unset before the first). */
  private lastPullOk?: boolean;
  private heldRetryAt = 0;
  /** Chains the hub cannot continue from what this device still holds:
   *  reported once per run. */
  private readonly unplaceable = new Set<string>();
  private heldAuthorsCheckedAt = 0;
  private resyncing?: Promise<void>;
  private lastResyncAt = 0;
  private readonly repairing = new Set<string>();

  constructor(private readonly options: {
    client: HubClient;
    storage: StorageService;
    localOriginId: () => Promise<string>;
    /** The key a device signs with, when it is one of the User's devices
     *  this device knows. */
    trustedKey: (originId: string) => Promise<string | undefined>;
    /** Hands an event to the channel it belongs to; `fetchBody` stores its
     *  large body and is called only for an event a channel takes. */
    deliver?: (event: ChatEventEnvelope, fetchBody: () => Promise<void>) => Promise<HubDeliverOutcome>;
    /** Applies a chat change no channel took. */
    applyChatChange: (event: ChatEventEnvelope) => Promise<HubApplyOutcome>;
    log?: (event: string, payload: Record<string, unknown>) => void;
    /** Log scopes (by prefix) whose events this device sends, read at each
     *  pass (a desktop sends a machine's channel only while that machine
     *  reads the hub); all when unset. */
    scopePrefixes?: readonly string[] | (() => Promise<readonly string[]>);
    /** These own events are now held by the hub, so whoever waited to hand
     *  them over may let go of them. */
    onPushed?: (eventIds: string[]) => Promise<void>;
    /** This device's own channel scopes (`device:<id>:` prefixes): where it
     *  starts again, it starts before anything of theirs the hub holds. */
    ownScopes?: () => Promise<readonly string[]>;
    /** Merges one chat of the hub's copy into this device's own (the copy
     *  merge path a machine's first copy takes). Without it this device
     *  cannot start again from the hub's copy. */
    mergeCopy?: (copied: CopiedConversation) => Promise<void>;
    now?: () => number;
  }) {}

  /** Sends this device's events from now on; reading waits for `start`. */
  startPushing(): void {
    if (this.pushStarted) return;
    this.pushStarted = true;
    this.nudgePush();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.pushStarted = true;
    this.stopped = false;
    this.stopLive = this.options.client.live(
      () => this.nudgePull(),
      (connected) => {
        if (connected !== this.connected) this.options.log?.("hub.sync.live", { connected });
        this.connected = connected;
        if (connected) {
          // A fresh link catches up both ways.
          this.nudgePush();
          this.nudgePull();
        }
      }
    );
    this.nudgePush();
    this.nudgePull();
    this.schedulePoll();
  }

  stop(): void {
    this.stopped = true;
    this.stopLive?.();
    if (this.retry) clearTimeout(this.retry);
    if (this.poll) clearTimeout(this.poll);
  }

  /** Stops reading (a shutdown closes the channels events go to) while what
   *  this device still writes can be sent. */
  pausePulls(): void {
    this.pullsPaused = true;
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Whether the hub answers: the live link is up, or the last read reached
   *  it (without the live link the hub is still read every few seconds). */
  isReachable(): boolean {
    return this.connected || this.lastPullOk === true;
  }

  /** This device wrote an event: send it now. */
  nudgePush(): void {
    if (!this.pushStarted || this.stopped) return;
    if (this.pushing) {
      this.pushAgain = true;
      return;
    }
    this.pushing = this.pushAll().then(() => this.succeeded(), (error) => {
      this.options.log?.("hub.sync.push-error", { message: errorMessage(error) });
      this.scheduleRetry();
    }).finally(() => {
      this.pushing = undefined;
      if (this.pushAgain) {
        this.pushAgain = false;
        this.nudgePush();
      }
    });
  }

  nudgePull(): void {
    if (!this.started || this.stopped || this.pullsPaused) return;
    if (this.pulling) {
      this.pullAgain = true;
      return;
    }
    this.pulling = this.pullAll().then(() => {
      this.lastPullOk = true;
      this.succeeded();
    }, (error) => {
      this.lastPullOk = false;
      this.options.log?.("hub.sync.pull-error", { message: errorMessage(error) });
      this.scheduleRetry();
    }).finally(() => {
      this.pulling = undefined;
      if (this.pullAgain) {
        this.pullAgain = false;
        this.nudgePull();
      }
    });
  }

  /** Something this device was missing may be here now (a machine's key, a
   *  channel, a chat): offer the held places again. */
  nudgeHeld(): void {
    this.heldRetryAt = 0;
    this.nudgePull();
  }

  /** Resolves when nothing is in flight (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.pushing || this.pulling) {
      await this.pushing;
      await this.pulling;
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private succeeded(): void {
    this.retryDelay = RETRY_MIN_MS;
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retry) return;
    const delay = this.retryDelay * (0.75 + Math.random() / 2);
    this.retryDelay = Math.min(RETRY_MAX_MS, this.retryDelay * 2);
    this.retry = setTimeout(() => {
      this.retry = undefined;
      this.nudgePush();
      this.nudgePull();
    }, delay);
    this.retry.unref?.();
  }

  private schedulePoll(): void {
    if (this.stopped) return;
    this.poll = setTimeout(() => {
      this.poll = undefined;
      this.nudgePush();
      this.nudgePull();
      this.schedulePoll();
    }, this.connected ? POLL_WITH_LIVE_MS : POLL_WITHOUT_LIVE_MS);
    this.poll.unref?.();
  }

  private async pushAll(): Promise<void> {
    const hub = this.options.storage.hub();
    const originId = await this.options.localOriginId();
    let cursor = await hubPushedThrough(this.options.storage);
    const scopes = typeof this.options.scopePrefixes === "function" ? await this.options.scopePrefixes() : this.options.scopePrefixes;
    for (;;) {
      // Stopped (a shutdown, another hub): the rest is sent by the next link.
      if (this.stopped) return;
      const page = await hub.ownEventsAfter(originId, cursor, PUSH_BATCH, scopes ? [...scopes] : undefined);
      if (page.length === 0) return;
      const events = page.map((item) => item.event);
      let results = (await this.options.client.push(events)).results;
      // Bodies the hub lacks go up, then the page again.
      const missing = results.flatMap((result, index) => result.status === "blob-missing" ? [index] : []);
      if (missing.length > 0) {
        for (const index of missing) {
          if (!await this.options.client.uploadBlob(events[index])) {
            this.options.log?.("hub.sync.body-gone", { eventId: events[index].eventId });
          }
        }
        results = (await this.options.client.push(events)).results;
      }
      // A chain the hub misses the start of is sent from where it stands.
      const gaps = new Map<string, number>();
      for (const [index, result] of results.entries()) {
        const scope = events[index].logScopeId;
        if (result.status === "gap" && !gaps.has(scope) && !this.unplaceable.has(scope)) gaps.set(scope, result.expectedSeq ?? 1);
      }
      if (gaps.size > 0) {
        for (const [scope, fromSeq] of gaps) {
          if (!await this.fillGap(originId, scope, fromSeq)) this.reportUnplaceable(scope, fromSeq);
        }
        results = (await this.options.client.push(events)).results;
      }
      // Every event of the page is settled now: held by the hub, or refused
      // for good (and said so). Only a failure to reach the hub retries.
      const delivered = this.settle(events, results);
      if (delivered.length > 0) await this.options.onPushed?.(delivered);
      cursor = page[page.length - 1].rowid;
      await hub.setClientState(PUSHED_KEY, String(cursor));
      if (page.length < PUSH_BATCH) return;
    }
  }

  private settle(events: ChatEventEnvelope[], results: HubEventPushResult[]): string[] {
    const delivered: string[] = [];
    for (const [index, event] of events.entries()) {
      const result = results[index];
      if (result?.status === "accepted" || result?.status === "duplicate") {
        delivered.push(event.eventId);
        continue;
      }
      if (result?.status === "gap") {
        this.reportUnplaceable(event.logScopeId, result.expectedSeq ?? 1);
        continue;
      }
      // Not acknowledged: whoever else waits for this event keeps it.
      this.options.log?.("hub.sync.push-refused", { eventId: event.eventId, kind: event.kind, status: result?.status ?? "missing", error: result?.error ?? "" });
    }
    return delivered;
  }

  private reportUnplaceable(logScopeId: string, fromSeq: number): void {
    if (this.unplaceable.has(logScopeId)) return;
    this.unplaceable.add(logScopeId);
    // The hub misses events this device no longer holds; what follows in
    // this chain cannot be placed until the hub is given a starting point.
    this.options.log?.("hub.sync.chain-unplaceable", { logScopeId, fromSeq });
  }

  /** Sends one chain from `fromSeq`; false when this device no longer holds
   *  what the hub needs. */
  private async fillGap(originId: string, logScopeId: string, fromSeq: number): Promise<boolean> {
    const hub = this.options.storage.hub();
    let next = fromSeq;
    for (;;) {
      const chain = await hub.chainFrom(originId, logScopeId, next, PUSH_BATCH);
      if (chain.length === 0 || chain[0].originSeq !== next) return next > fromSeq;
      let response = await this.options.client.push(chain);
      const missing = response.results.flatMap((result, index) => result.status === "blob-missing" ? [index] : []);
      if (missing.length > 0) {
        for (const index of missing) await this.options.client.uploadBlob(chain[index]);
        response = await this.options.client.push(chain);
      }
      if (response.results.some((result) => result.status !== "accepted" && result.status !== "duplicate")) return false;
      next = chain[chain.length - 1].originSeq + 1;
      if (chain.length < PUSH_BATCH) return true;
    }
  }

  private async pullAll(): Promise<void> {
    const hub = this.options.storage.hub();
    let cursor = await this.startingCursor();
    let resynced = false;
    for (;;) {
      if (this.pullsPaused || this.stopped) return;
      let response;
      try {
        response = await this.options.client.pull(cursor, undefined, await this.readReport());
      } catch (error) {
        // The hub forgot what this device would need from here: it starts
        // again from the hub's copy, once per pass.
        if (!isHubResyncRequired(error) || resynced) throw error;
        resynced = true;
        await this.resync(Number(error.detail.prunedThrough) || 0);
        cursor = Number(await hub.clientState(PULLED_KEY) ?? "0") || 0;
        continue;
      }
      if (typeof response.hubId === "string" && response.hubId) {
        const known = await hub.clientState(HUB_ID_KEY);
        if (known !== response.hubId) {
          if (known) {
            // Another hub at this address: its order starts over, and so does
            // this device's reading of it.
            this.options.log?.("hub.sync.hub-changed", { from: known, to: response.hubId });
            await hub.clearHeld();
            cursor = 0;
            await hub.setClientState(PULLED_KEY, "0");
          }
          await hub.setClientState(HUB_ID_KEY, response.hubId);
          if (known) continue;
        }
      }
      if (!Number.isSafeInteger(response.head) || response.head < 0) throw new HubTransientError("The hub answered without a position.");
      if (cursor > response.head) {
        // The hub is behind this device (restored, or set up again): what it
        // places from now on would sit below the cursor and be missed.
        this.options.log?.("hub.sync.hub-behind", { cursor, head: response.head });
        cursor = response.head;
        await hub.setClientState(PULLED_KEY, String(cursor));
        continue;
      }
      const taken: number[] = [];
      for (const item of response.events) {
        if (this.pullsPaused || this.stopped) return;
        if (!Number.isSafeInteger(item.hubSeq)) continue;
        const outcome = await this.receiveOrHold(item);
        if (outcome === "done") taken.push(item.hubSeq);
        else await this.hold(item, outcome);
      }
      // Read again after a failure, a place held the first time may be taken
      // now: it is no longer held.
      await hub.releaseHeld(taken);
      // A page is taken whole before the cursor moves: taking an event twice
      // (after a restart mid-page) is harmless, skipping one is not.
      const last = response.events.length > 0 ? response.events[response.events.length - 1].hubSeq : cursor;
      const through = Math.max(cursor, Number.isSafeInteger(response.through) ? response.through : last);
      const moved = through !== cursor;
      if (moved) {
        cursor = through;
        await hub.setClientState(PULLED_KEY, String(cursor));
      }
      if (cursor >= response.head || !moved) break;
    }
    await this.retryHeld();
  }

  /** What this device holds, as each read tells the hub: the hub keeps
   *  everything from its lowest held place on. */
  private async readReport(): Promise<HubReadReport> {
    const held = await this.options.storage.hub().heldSummary();
    const since = held.oldestAt ? Date.parse(held.oldestAt) : 0;
    return { held: held.lowest, heldSince: Number.isFinite(since) ? since : 0, heldCount: held.count };
  }

  /**
   * Where this device reads from. A machine whose first copy of the chats
   * came with a position in this hub's order (and that never read it
   * before) starts there, not from the order's start: the hub is asked for
   * a starting point at most that position and before any event of its own
   * channels it still holds, and keeps everything after it from then on.
   */
  private async startingCursor(): Promise<number> {
    const hub = this.options.storage.hub();
    const stored = await hub.clientState(PULLED_KEY);
    if (stored !== undefined) return Number(stored) || 0;
    const text = await hub.clientState(CHAT_COPY_HUB_POSITION_KEY);
    if (!text) return 0;
    let position: { hubId?: unknown; hubSeq?: unknown };
    try { position = JSON.parse(text) as typeof position; } catch { return 0; }
    if (typeof position.hubId !== "string" || !Number.isSafeInteger(position.hubSeq)) return 0;
    try {
      const start = await this.options.client.snapshot({ copy: false, atMost: position.hubSeq as number, scopes: await this.ownScopes() });
      if (start.hubId && start.hubId !== position.hubId) {
        // The copy was made against another server: read this one from its start.
        this.options.log?.("hub.sync.copy-position-other-hub", { copyHubId: position.hubId, hubId: start.hubId });
        return 0;
      }
      await hub.setClientState(HUB_ID_KEY, start.hubId ?? position.hubId);
      await hub.setClientState(PULLED_KEY, String(start.hubSeq));
      this.options.log?.("hub.sync.started-from-copy", { copyHubSeq: position.hubSeq, hubSeq: start.hubSeq });
      return start.hubSeq;
    } catch (error) {
      // An older hub cannot say: read from the start, as before.
      if (error instanceof HubHttpError && error.status === 404) return 0;
      throw error;
    }
  }

  private async ownScopes(): Promise<string[]> {
    try { return [...(await this.options.ownScopes?.() ?? [])]; } catch { return []; }
  }

  /**
   * Starts this device again from the hub's copy: the hub fixes where it
   * reads from next and keeps everything after that for it, then pages its
   * copy of every chat, which goes through the same merge a machine's first
   * copy takes; the copy's marks say how far each chat change chain it
   * covers, so later changes continue from there. Applying a chat twice is
   * harmless, so a resync that stopped half way simply runs again.
   */
  async resync(prunedThrough = 0): Promise<void> {
    if (!this.resyncing && this.lastResyncAt && this.now() - this.lastResyncAt < RESYNC_MIN_INTERVAL_MS) {
      // A hub that keeps saying so is not answered with a copy every few
      // seconds: the read fails and is tried again later.
      throw new HubTransientError("The server asked to start again right after a start from its copy.");
    }
    this.resyncing ??= this.resyncNow(prunedThrough).then(() => { this.lastResyncAt = this.now(); }).finally(() => { this.resyncing = undefined; });
    return this.resyncing;
  }

  private async resyncNow(prunedThrough: number): Promise<void> {
    const hub = this.options.storage.hub();
    const merge = this.options.mergeCopy;
    if (!merge) throw new Error("This device cannot start again from the server's copy.");
    const started = this.now();
    this.options.log?.("hub.sync.resync.started", { prunedThrough });
    const scopes = await this.ownScopes();
    let page: string | undefined;
    let hubSeq: number | undefined;
    let hubId: string | undefined;
    let marks: HubCopyMark[] = [];
    let chats = 0;
    let bytes = 0;
    const partial = new Map<string, HubCopyPart>();
    for (;;) {
      if (this.stopped) throw new HubTransientError("Stopped while starting again from the server's copy.");
      const response = await this.options.client.snapshot({ copy: true, scopes, ...(page ? { page } : {}) });
      bytes += Buffer.byteLength(JSON.stringify(response));
      if (hubSeq === undefined) {
        hubSeq = response.hubSeq;
        hubId = response.hubId;
        marks = response.marks ?? [];
      }
      for (const part of response.conversations) {
        const earlier = partial.get(part.id);
        const joined = earlier ? { ...part, messages: [...earlier.messages, ...part.messages] } : part;
        if (part.more) {
          partial.set(part.id, joined);
          continue;
        }
        partial.delete(part.id);
        await merge(copiedFromPart(joined));
        chats += 1;
      }
      if (!response.next) break;
      page = response.next;
    }
    // A chat the last page left open (it went away meanwhile) is merged as far as it came.
    for (const part of partial.values()) {
      await merge(copiedFromPart(part));
      chats += 1;
    }
    await this.options.storage.applyChatCopyMarks(marks.map((mark) => ({ ...mark })), new Date(this.now()).toISOString(), await this.options.localOriginId());
    if (hubId) await hub.setClientState(HUB_ID_KEY, hubId);
    await hub.setClientState(PULLED_KEY, String(hubSeq ?? 0));
    this.options.log?.("hub.sync.resync.finished", { hubSeq, chats, marks: marks.length, bytes, ms: this.now() - started });
  }

  /**
   * A channel found a gap in a chain (or lacks an event's body): the hub is
   * asked for the range. What it has is handed in again. A stretch the hub
   * forgot by design is passed over (a chat change chain: that chat is taken
   * from the hub's copy, whose mark the chain continues from). What the hub
   * never had is reported and asked about again later.
   */
  async repairGap(gap: DeviceEventGap): Promise<HubGapRepair> {
    const key = `${gap.originId}\n${gap.logScopeId}\n${gap.fromSeq}`;
    if (this.repairing.has(key) || this.stopped) return "unavailable";
    this.repairing.add(key);
    try {
      const response = await this.options.client.chain(gap.originId, gap.logScopeId, gap.fromSeq, Math.max(gap.fromSeq, gap.toSeq));
      const pruned = response.pruned;
      const forgotten = pruned && pruned.originSeq >= gap.fromSeq ? pruned : undefined;
      let outcome: HubGapRepair = "repaired";
      if (response.events[0]?.event.originSeq !== gap.fromSeq) {
        // The start of the gap is not on the hub.
        if (!forgotten) {
          // Never placed (its author's push was refused, or has not come):
          // nothing to take yet; the author's side reports it.
          this.options.log?.("hub.sync.gap-unavailable", { ...gap, retained: response.events.length });
          return "unavailable";
        }
        outcome = await this.passOver(gap, forgotten);
      }
      // What the hub still holds after what it forgot is handed in.
      for (const item of response.events) {
        if (forgotten && item.event.originSeq <= forgotten.originSeq) continue;
        if (await this.receiveOrHold(item, { gapRepair: true }) !== "refused") continue;
        // Refused here for good (a signature, a scope, a conflict): the chain
        // goes on past it instead of waiting for it for ever.
        this.options.log?.("hub.sync.gap-refused", { ...gap, originSeq: item.event.originSeq, eventId: item.event.eventId });
        outcome = await this.passOver(gap, { originSeq: item.event.originSeq, eventHash: item.event.eventHash });
        break;
      }
      this.options.log?.("hub.sync.gap-repaired", { ...gap, outcome, events: response.events.length, ...(forgotten ? { prunedThrough: forgotten.originSeq } : {}) });
      return outcome;
    } catch (error) {
      this.options.log?.("hub.sync.gap-error", { ...gap, message: errorMessage(error) });
      return "unavailable";
    } finally {
      this.repairing.delete(key);
    }
  }

  /** A stretch of a chain this device will never get from the hub: a chat
   *  change chain's chat is taken from the hub's copy (whose mark the chain
   *  continues from), any other chain continues after it. */
  private async passOver(gap: DeviceEventGap, through: { originSeq: number; eventHash: string }): Promise<HubGapRepair> {
    if (isChatChangesLogScope(gap.logScopeId)) {
      await this.resyncChat(gap.logScopeId.slice("chat-changes:".length));
      // The copy covers at least this far: what the hub folded of the chain.
      await this.options.storage.deviceEvents().skipTo(gap.originId, gap.logScopeId, through.originSeq, through.eventHash, new Date(this.now()).toISOString());
      return "resynced";
    }
    const moved = await this.options.storage.deviceEvents().skipTo(gap.originId, gap.logScopeId, through.originSeq, through.eventHash, new Date(this.now()).toISOString());
    this.options.log?.("hub.sync.gap-skipped", { ...gap, through: through.originSeq, moved });
    return "skipped";
  }

  /** One chat from the hub's copy, for a chain of its changes the hub forgot. */
  private async resyncChat(conversationId: string): Promise<void> {
    const merge = this.options.mergeCopy;
    if (!merge) throw new Error("This device cannot take a chat from the server's copy.");
    let page: string | undefined;
    let marks: HubCopyMark[] = [];
    let joined: HubCopyPart | undefined;
    for (;;) {
      const response = await this.options.client.snapshot({ copy: true, chat: conversationId, ...(page ? { page } : {}) });
      if (!page) marks = response.marks ?? [];
      for (const part of response.conversations) {
        joined = joined && joined.id === part.id ? { ...part, messages: [...joined.messages, ...part.messages] } : part;
      }
      if (!response.next) break;
      page = response.next;
    }
    if (joined) await merge(copiedFromPart(joined));
    await this.options.storage.applyChatCopyMarks(marks, new Date(this.now()).toISOString(), await this.options.localOriginId());
  }

  private async hold(item: HubLoggedEvent, reason: string): Promise<void> {
    await this.options.storage.hub().holdEvent({
      hubSeq: item.hubSeq, eventId: item.event.eventId, originId: item.event.originId,
      conversationId: item.event.conversationId, reason, heldAt: new Date(this.now()).toISOString()
    });
  }

  /** Offers held places again, oldest first. Places held for their author
   *  (unknown, or its channel not set up) are asked about once per author
   *  and pass; every other place is tried on its own. */
  private async retryHeld(): Promise<void> {
    if (this.now() < this.heldRetryAt) return;
    this.heldRetryAt = this.now() + HELD_RETRY_MS;
    const hub = this.options.storage.hub();
    await this.releaseRemovedAuthors();
    const authorsStillMissing = new Set<string>();
    let fetches = 0;
    let after = 0;
    for (;;) {
      const page = await hub.heldEvents(after, HELD_PAGE);
      if (page.length === 0) return;
      for (const held of page) {
        after = held.hubSeq;
        if (this.pullsPaused || this.stopped) return;
        const author = `${held.originId}\n${held.reason}`;
        if (BY_AUTHOR.has(held.reason) && authorsStillMissing.has(author)) continue;
        if (fetches >= HELD_RETRY_FETCHES) {
          // The rest next pass, soon.
          this.heldRetryAt = 0;
          return;
        }
        fetches += 1;
        // A look at one held place, not this device's place in the order.
        const read = await this.options.client.pull(held.hubSeq - 1, 1, { ...await this.readReport(), peek: true });
        const item = read.events[0];
        if (!item || item.hubSeq !== held.hubSeq || item.event.eventId !== held.eventId) {
          // The hub no longer has that event there: nothing to take.
          await hub.releaseHeld([held.hubSeq]);
          continue;
        }
        const outcome = await this.receiveOrHold(item);
        if (outcome === "done") {
          await hub.releaseHeld([held.hubSeq]);
          continue;
        }
        if (outcome !== held.reason) await this.hold(item, outcome);
        if (BY_AUTHOR.has(outcome)) authorsStillMissing.add(`${held.originId}\n${outcome}`);
      }
      if (page.length < HELD_PAGE) return;
    }
  }

  /** Places held for who wrote them are let go only once the roster says
   *  that author was removed: the hub answers which are still on it. */
  private async releaseRemovedAuthors(): Promise<void> {
    if (this.now() - this.heldAuthorsCheckedAt < HELD_AUTHORS_CHECK_MS) return;
    const hub = this.options.storage.hub();
    const authors = await hub.heldAuthors([...BY_AUTHOR]);
    if (authors.length === 0) return;
    let known: Set<string>;
    try {
      known = new Set((await this.options.client.known(authors)).known);
    } catch (error) {
      // An older hub cannot say: everything stays held.
      if (error instanceof HubHttpError && error.status === 404) {
        this.heldAuthorsCheckedAt = this.now();
        return;
      }
      throw error;
    }
    this.heldAuthorsCheckedAt = this.now();
    const removed = authors.filter((author) => !known.has(author));
    if (removed.length === 0) return;
    const released = await hub.releaseHeldOf(removed);
    this.options.log?.("hub.sync.held-released", { authors: removed, released, reason: "removed-from-roster" });
  }

  private async receiveOrHold(item: HubLoggedEvent, options: { gapRepair?: boolean } = {}): Promise<ReceiveOutcome> {
    try {
      return await this.receive(item, options);
    } catch (error) {
      if (isTransient(error)) throw error;
      // This event cannot be taken now; the rest of the order can.
      this.options.log?.("hub.sync.receive-error", { hubSeq: item.hubSeq, eventId: item.event.eventId, kind: item.event.kind, message: errorMessage(error) });
      return "error";
    }
  }

  private async receive(item: HubLoggedEvent, options: { gapRepair?: boolean } = {}): Promise<ReceiveOutcome> {
    const { event } = item;
    // A hub that sends a device its own events back (an older one) is not
    // telling it anything.
    if (event.originId === await this.options.localOriginId()) return "done";
    const key = await this.options.trustedKey(event.originId);
    if (!key) return "unknown-origin";
    if (!verifySignedChatEvent(event, key)) {
      // Claims to be one of the User's devices but is not signed by it.
      this.options.log?.("hub.sync.bad-signature", { eventId: event.eventId, originId: event.originId });
      return options.gapRepair ? "refused" : "done";
    }
    // A large body is fetched only for an event this device takes: another
    // pair's traffic is passed over without it.
    const fetchBody = (): Promise<void> => this.options.client.fetchBlob(event);
    let delivered: HubDeliverOutcome;
    try {
      delivered = this.options.deliver ? await this.options.deliver(event, fetchBody) : "not-mine";
    } catch (error) {
      if (error instanceof HubHttpError && error.status === 404) return "blob-missing";
      throw error;
    }
    if (delivered === "delivered") return "done";
    if (delivered === "not-ready") return "not-ready";
    if (delivered === "refused") {
      this.options.log?.("hub.sync.refused", { eventId: event.eventId, kind: event.kind });
      return options.gapRepair ? "refused" : "done";
    }
    // Only a chat change is anyone's business beyond its channel: the rest
    // (traffic between two other devices) is neither stored nor applied here.
    if (event.kind !== CHAT_CHANGES_EVENT_KIND) return "done";
    // No channel orders these: an earlier change of this author to this chat
    // still held keeps this one behind it.
    if (await this.options.storage.hub().holdsEarlier(event.originId, event.conversationId, item.hubSeq)) return "waiting";
    try {
      await fetchBody();
    } catch (error) {
      if (error instanceof HubHttpError && error.status === 404) return "blob-missing";
      throw error;
    }
    const [stored] = await this.options.storage.appendChatEvents([event]);
    if (stored?.status === "conflict") {
      this.options.log?.("hub.sync.conflict", { eventId: event.eventId, reason: stored.conflictReason ?? "" });
      return "done";
    }
    const outcome = await this.options.applyChatChange(event);
    return outcome === "held" ? "waiting" : "done";
  }
}

/** A chat of the hub's copy, joined from its parts, as the copy merge takes it. */
function copiedFromPart(part: HubCopyPart): CopiedConversation {
  return {
    id: part.id,
    updatedAt: part.updatedAt,
    shared: part.shared as CopiedConversation["shared"],
    messages: part.messages as CopiedConversation["messages"],
    removed: part.removed,
    ...(part.authors ? { authors: part.authors } : {})
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

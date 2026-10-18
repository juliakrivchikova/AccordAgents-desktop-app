import type { ChatEventEnvelope } from "../../shared/chatEvents";
import { HUB_PUSH_MAX_EVENTS, type HubEventPushResult, type HubLoggedEvent } from "../../shared/hubProtocol";
import { CHAT_ACTION_LOG_SCOPE } from "../../shared/chatActionEvents";
import { CHAT_CHANGES_EVENT_KIND, isChatChangesPayload, type ChatChangesPayload } from "./chatChanges";
import { verifySignedChatEvent } from "./chatEventLog";
import type { DeviceEventChannel } from "./deviceEventChannel";
import { DevicePacketAuthenticationError } from "./devicePacketAuthentication";
import { HubHttpError, type HubClient } from "./hubClient";
import type { StorageService } from "./storage";

const PUSHED_KEY = "pushed-rowid";
const PULLED_KEY = "pulled-hub-seq";
const PUSH_BATCH = Math.min(100, HUB_PUSH_MAX_EVENTS);
/** Without the live link nothing announces new events: read anyway. With
 *  it, read now and then as well, in case it died without a word. */
const POLL_WITHOUT_LIVE_MS = 15_000;
const POLL_WITH_LIVE_MS = 60_000;
/** Places held back are read again at most this often unless nudged. */
const HELD_RETRY_MS = 10_000;
const HELD_RETRY_BATCH = 100;
/** A place held this long belongs to a device that is gone. */
const HELD_MAX_AGE_MS = 14 * 24 * 60 * 60_000;
const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;

/** The log scopes a device sends to the hub: chat changes, its channels'
 *  events and chat actions; never what a desktop wrote for the old phone
 *  mailbox. */
export const HUB_SCOPE_PREFIXES = ["chat-changes:", "device:", CHAT_ACTION_LOG_SCOPE] as const;

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

/** Hands an event from the hub's order to the channel that owns it. */
export async function deliverToChannel(channel: DeviceEventChannel, event: ChatEventEnvelope): Promise<HubDeliverOutcome> {
  try {
    return await channel.receiveFromHub(event) === "conflict" ? "refused" : "delivered";
  } catch (error) {
    if (error instanceof DevicePacketAuthenticationError) return "refused";
    throw error;
  }
}

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

type ReceiveOutcome = "done" | "unknown-origin" | "not-ready" | "waiting" | "blob-missing" | "error";

/** A failure that says nothing about the event: the hub or the network was
 *  away, or a channel was closing. The page is read again later. Anything
 *  else is about the event, which is held while the others go on. */
export class HubTransientError extends Error {}

function isTransient(error: unknown): boolean {
  if (error instanceof HubTransientError || error instanceof HubHttpError) return true;
  if (error instanceof TypeError) return true;
  const name = error instanceof Error ? error.name : "";
  return name === "AbortError" || name === "TimeoutError" || name === "DeviceEventChannelClosedError";
}

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
  private stopped = false;
  private pullsPaused = false;
  private retry?: ReturnType<typeof setTimeout>;
  private retryDelay = RETRY_MIN_MS;
  private poll?: ReturnType<typeof setTimeout>;
  private connected = false;
  private heldRetryAt = 0;
  /** Chains the hub cannot continue from what this device still holds:
   *  reported once per run. */
  private readonly unplaceable = new Set<string>();

  constructor(private readonly options: {
    client: HubClient;
    storage: StorageService;
    localOriginId: () => Promise<string>;
    /** The key a device signs with, when it is one of the User's devices
     *  this device knows. */
    trustedKey: (originId: string) => Promise<string | undefined>;
    /** Hands an event to the channel it belongs to. */
    deliver?: (event: ChatEventEnvelope) => Promise<HubDeliverOutcome>;
    /** Applies a chat change no channel took. */
    applyChatChange: (event: ChatEventEnvelope) => Promise<HubApplyOutcome>;
    log?: (event: string, payload: Record<string, unknown>) => void;
    /** Log scopes (by prefix) whose events this device sends; all when unset. */
    scopePrefixes?: readonly string[];
    /** These own events are now held by the hub, so whoever waited to hand
     *  them over may let go of them. */
    onPushed?: (eventIds: string[]) => Promise<void>;
    now?: () => number;
  }) {}

  start(): void {
    if (this.started) return;
    this.started = true;
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

  /** This device wrote an event: send it now. */
  nudgePush(): void {
    if (!this.started || this.stopped) return;
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
    this.pulling = this.pullAll().then(() => this.succeeded(), (error) => {
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
    for (;;) {
      const page = await hub.ownEventsAfter(originId, cursor, PUSH_BATCH, this.options.scopePrefixes ? [...this.options.scopePrefixes] : undefined);
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
    let cursor = Number(await hub.clientState(PULLED_KEY) ?? "0") || 0;
    for (;;) {
      if (this.pullsPaused || this.stopped) return;
      const response = await this.options.client.pull(cursor);
      if (cursor > response.head) {
        // The hub is behind this device (restored, or set up again): what it
        // places from now on would sit below the cursor and be missed.
        this.options.log?.("hub.sync.hub-behind", { cursor, head: response.head });
        cursor = response.head;
        await hub.setClientState(PULLED_KEY, String(cursor));
        continue;
      }
      for (const item of response.events) {
        if (this.pullsPaused || this.stopped) return;
        const outcome = await this.receiveOrHold(item);
        if (outcome !== "done") {
          await hub.holdEvent({ hubSeq: item.hubSeq, eventId: item.event.eventId, originId: item.event.originId, reason: outcome, heldAt: new Date(this.now()).toISOString() });
        }
      }
      // A page is taken whole before the cursor moves: taking an event twice
      // (after a restart mid-page) is harmless, skipping one is not.
      const last = response.events.length > 0 ? response.events[response.events.length - 1].hubSeq : cursor;
      const through = Math.max(cursor, response.through ?? last);
      const moved = through !== cursor;
      if (moved) {
        cursor = through;
        await hub.setClientState(PULLED_KEY, String(cursor));
      }
      if (cursor >= response.head || !moved) break;
    }
    await this.retryHeld();
  }

  /** Offers held places again, oldest first; one author still unknown (or
   *  one channel still missing) is not asked about twice per pass. */
  private async retryHeld(): Promise<void> {
    if (this.now() < this.heldRetryAt) return;
    this.heldRetryAt = this.now() + HELD_RETRY_MS;
    const hub = this.options.storage.hub();
    const dropped = await hub.dropHeldBefore(new Date(this.now() - HELD_MAX_AGE_MS).toISOString());
    if (dropped > 0) this.options.log?.("hub.sync.held-dropped", { dropped });
    const stillMissing = new Set<string>();
    for (const held of await hub.heldEvents(HELD_RETRY_BATCH)) {
      if (this.pullsPaused || this.stopped) return;
      const key = `${held.originId}\n${held.reason}`;
      if (stillMissing.has(key)) continue;
      const page = await this.options.client.pull(held.hubSeq - 1, 1);
      const item = page.events[0];
      if (!item || item.hubSeq !== held.hubSeq) {
        // The hub no longer has it there (restored without it): nothing to take.
        await hub.releaseHeld(held.hubSeq);
        continue;
      }
      const outcome = await this.receiveOrHold(item);
      if (outcome === "done") await hub.releaseHeld(held.hubSeq);
      else stillMissing.add(key);
    }
  }

  private async receiveOrHold(item: HubLoggedEvent): Promise<ReceiveOutcome> {
    try {
      return await this.receive(item);
    } catch (error) {
      if (isTransient(error)) throw error;
      // This event cannot be taken now; the rest of the order can.
      this.options.log?.("hub.sync.receive-error", { hubSeq: item.hubSeq, eventId: item.event.eventId, kind: item.event.kind, message: errorMessage(error) });
      return "error";
    }
  }

  private async receive(item: HubLoggedEvent): Promise<ReceiveOutcome> {
    const { event } = item;
    const key = await this.options.trustedKey(event.originId);
    if (!key) return "unknown-origin";
    if (!verifySignedChatEvent(event, key)) {
      // Claims to be one of the User's devices but is not signed by it.
      this.options.log?.("hub.sync.bad-signature", { eventId: event.eventId, originId: event.originId });
      return "done";
    }
    try {
      await this.options.client.fetchBlob(event);
    } catch (error) {
      if (error instanceof HubHttpError && error.status === 404) return "blob-missing";
      throw error;
    }
    const delivered = this.options.deliver ? await this.options.deliver(event) : "not-mine";
    if (delivered === "delivered") return "done";
    if (delivered === "not-ready") return "not-ready";
    if (delivered === "refused") {
      this.options.log?.("hub.sync.refused", { eventId: event.eventId, kind: event.kind });
      return "done";
    }
    // Only a chat change is anyone's business beyond its channel: the rest
    // (traffic between two other devices) is neither stored nor applied here.
    if (event.kind !== CHAT_CHANGES_EVENT_KIND) return "done";
    const [stored] = await this.options.storage.appendChatEvents([event]);
    if (stored?.status === "conflict") {
      this.options.log?.("hub.sync.conflict", { eventId: event.eventId, reason: stored.conflictReason ?? "" });
      return "done";
    }
    const outcome = await this.options.applyChatChange(event);
    return outcome === "held" ? "waiting" : "done";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

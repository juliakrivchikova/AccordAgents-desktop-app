import type { ChatEventEnvelope } from "../../shared/chatEvents";
import type { DeviceEventGap } from "../../shared/deviceEventDelivery";
import { HUB_APPROVAL_CARD_SCOPE, HUB_PHONE_ENROLLED_EVENT_KIND, HUB_PHONE_ENROLLMENT_SCOPE, HUB_PUSH_MAX_EVENTS, type HubCopyMark, type HubCopyPart, type HubEventPushResult, type HubLoggedEvent, type HubReadReport, type HubSnapshotResponse } from "../../shared/hubProtocol";
import { CHAT_ACTION_LOG_SCOPE } from "../../shared/chatActionEvents";
import { CHAT_CHANGES_EVENT_KIND, CHAT_CHANGES_LOG_SCOPE_PREFIX, isChatChangesLogScope, isChatChangesPayload, isSupportedChatChangesVersion, type ChatChangesPayload } from "./chatChanges";
import { CHAT_COPY_HUB_POSITION_KEY, type CopiedConversation } from "./chatCopy";
import { verifySignedChatEvent } from "./chatEventLog";
import type { DeviceEventChannel } from "./deviceEventChannel";
import { DevicePacketAuthenticationError } from "./devicePacketAuthentication";
import { HubHttpError, HubTransientError, isHubResyncRequired, type HubClient } from "./hubClient";
import { HELD_FOR_AUTHOR_REASONS, HUB_CLIENT_GIVEN_UP_KEY, HUB_CLIENT_HUB_ID_KEY, HUB_CLIENT_PULLED_KEY, HUB_CLIENT_PUSHED_KEY, type HubHeldEvent } from "./hubStorage";
import type { StorageService } from "./storage";

/** Where this device keeps its place with the hub (setup moves them). */
export const PUSHED_KEY = HUB_CLIENT_PUSHED_KEY;
export const PULLED_KEY = HUB_CLIENT_PULLED_KEY;
export const HUB_ID_KEY = HUB_CLIENT_HUB_ID_KEY;
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
 *  held for it let go. Places held for any other reason are given up after
 *  HELD_GIVE_UP_MS, and said so (giveUpOld). */
const HELD_AUTHORS_CHECK_MS = 10 * 60_000;
/** A change held this long for any reason but its author is given up (and
 *  said so). ACCORDAGENTS_HUB_GIVE_UP_HELD_MS shortens it for QA. */
const HELD_GIVE_UP_MS = (() => {
  const value = Number(process.env.ACCORDAGENTS_HUB_GIVE_UP_HELD_MS);
  return Number.isSafeInteger(value) && value > 0 ? value : 14 * 24 * 60 * 60_000;
})();
/** Starting again from the hub's copy happens at most this often; a start
 *  that failed is taken up again after RESYNC_RETRY_MS, doubling per failure. */
const RESYNC_MIN_INTERVAL_MS = 30 * 60_000;
const RESYNC_RETRY_MS = 30_000;
/** A copy page the hub is too busy to build now is asked again after about
 *  this long, this many times. */
const SNAPSHOT_BUSY_WAIT_MS = 1_000;
const SNAPSHOT_BUSY_RETRIES = 120;
/** A chat of the copy that could not be merged is tried again this many
 *  times (each after the start's backoff) before this device reads on
 *  without it; a later change of that chat takes it from the copy again. */
const RESYNC_CHAT_ATTEMPTS = 3;

/** A start from the hub's copy in progress (kept across a failed attempt). */
interface ResyncProgress {
  hubSeq: number;
  hubId?: string;
  marks: HubCopyMark[];
  /** The next page; none for the first. */
  page?: string;
  firstPage?: HubSnapshotResponse;
  partial: Map<string, HubCopyPart>;
  failed: Set<string>;
  chats: number;
  /** Every page is in; what is left is the chats that failed. */
  pagesDone: boolean;
  /** Attempts so far at the chats that failed. */
  attempts: number;
}
const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;

/** The log scopes a device sends to the hub: chat changes, its channels'
 *  events and chat actions; never what a desktop wrote for the old phone
 *  mailbox. A desktop narrows `device:` to the machines that read the hub. */
export const HUB_SCOPE_PREFIXES = ["chat-changes:", "device:", CHAT_ACTION_LOG_SCOPE] as const;
/** What a desktop sends besides its machines' channels: chat changes, chat
 *  actions, and for the phone the cards and the live progress of its own
 *  members. */
/** How often an unknown author's enrollment is asked for, and how much of
 *  its enrollment chain (a phone paired again has a few). */
const ENROLLMENT_ASK_EVERY_MS = 60_000;
const ENROLLMENT_CHAIN_READ = 20;

export const HUB_SHARED_SCOPE_PREFIXES = ["chat-changes:", CHAT_ACTION_LOG_SCOPE, HUB_APPROVAL_CARD_SCOPE] as const;

/** What a channel did with an event from the hub's order. */
export type HubDeliverOutcome =
  /** Stored by the channel that owns it, which applies it (and retries). */
  | "delivered"
  /** It belongs to a channel this device will have (a machine whose channel
   *  is not set up yet): held and offered again. */
  | "not-ready"
  /** Its channel refused it for good (scope, signature, conflict). */
  | "refused"
  /** Taken, but what it acts on is not here yet: held on its own and offered
   *  again (an answer to a card that has not arrived yet). */
  | "waiting"
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
export type HubApplyOutcome = "applied" | "ignored" | "held" | "newer-version";

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
    // Written by a newer version: it waits for this device's update, never
    // for a clock.
    if (!isSupportedChatChangesVersion(payload)) return "newer-version";
    const outcome = await chat.applyRemoteChatChanges(event, payload);
    return outcome === "applied" ? "applied" : "held";
  };
}

type ReceiveOutcome = "done" | "unknown-origin" | "not-ready" | "newer-version" | "waiting" | "deferred-action" | "blob-missing" | "error" | "refused" | "forged";

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
  private resyncNotBefore = 0;
  private resyncFailures = 0;
  private resyncProgress?: ResyncProgress;
  private caughtUp = false;
  private readonly repairing = new Set<string>();
  private repairQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: {
    client: HubClient;
    storage: StorageService;
    localOriginId: () => Promise<string>;
    /** The key a device signs with, when it is one of the User's devices
     *  this device knows. */
    trustedKey: (originId: string) => Promise<string | undefined>;
    /** An author this device does not know yet may prove itself with the
     *  event itself (a phone's enrollment, signed by the owner's invite): the
     *  key it signs with, once it is admitted. `fetchBody` stores the event's
     *  large body if it has one. */
    admit?: (event: ChatEventEnvelope, fetchBody: () => Promise<void>) => Promise<string | undefined>;
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
      if (chain.length === 0) return next > fromSeq;
      // This device forgot the start of what the hub misses (it keeps its own
      // channel events a week once the hub had them; this hub never did: it
      // was set up again, or restored). The chain goes on from what it still
      // holds, and readers are told the stretch before is gone.
      const anchor = chain[0].originSeq !== next;
      if (anchor && next > fromSeq) return true;
      if (anchor) this.options.log?.("hub.sync.chain-anchored", { logScopeId, fromSeq, at: chain[0].originSeq });
      let response = await this.options.client.push(chain, anchor ? { anchor: [logScopeId] } : undefined);
      const missing = response.results.flatMap((result, index) => result.status === "blob-missing" ? [index] : []);
      if (missing.length > 0) {
        for (const index of missing) await this.options.client.uploadBlob(chain[index]);
        response = await this.options.client.push(chain, anchor ? { anchor: [logScopeId] } : undefined);
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
        const known = await hub.clientState(HUB_ID_KEY);
        const answering = typeof error.detail.hubId === "string" ? error.detail.hubId : undefined;
        if (known && answering && known !== answering) {
          // Another hub at this address: what this device held was another
          // order's, and its place there means nothing here.
          this.options.log?.("hub.sync.hub-changed", { from: known, to: answering });
          this.resyncProgress = undefined;
          await hub.clearHeld();
          await hub.setClientState(PULLED_KEY, "0");
          await hub.setClientState(HUB_ID_KEY, answering);
          cursor = 0;
        }
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
            this.resyncProgress = undefined;
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
    if (!this.caughtUp) {
      // Once per run: how much this device read to reach the order's head.
      this.caughtUp = true;
      this.options.log?.("hub.sync.caught-up", { cursor, bytes: this.options.client.receivedBytes });
    }
    await this.retryHeld();
  }

  /** What this device holds, as each read tells the hub: the hub keeps
   *  everything from its lowest held place on. */
  private async readReport(): Promise<HubReadReport> {
    const held = await this.options.storage.hub().heldSummary();
    const since = held.oldestAt ? Date.parse(held.oldestAt) : 0;
    const given = summarizeGivenUp(await readGivenUp(this.options.storage));
    return {
      held: held.lowest, heldSince: Number.isFinite(since) ? since : 0, heldCount: held.count,
      ...(given ? { gaveUp: given.count, gaveUpAt: Date.parse(given.at) } : {})
    };
  }

  /**
   * A change held for two weeks for any reason but who wrote it (it failed
   * to apply, its body is gone, its chat never arrived) is given up: never
   * in silence. A line goes to the debug log, and the desktop says in
   * Settings which device's changes were given up and when. Places held for
   * their author wait for the roster instead (releaseRemovedAuthors).
   */
  private async giveUpOld(): Promise<void> {
    const at = new Date(this.now()).toISOString();
    const given = await this.options.storage.hub().heldToGiveUp(new Date(this.now() - HELD_GIVE_UP_MS).toISOString(), [...HELD_FOR_AUTHOR_REASONS]);
    if (given.length === 0) return;
    const byOrigin = new Map<string, HubHeldEvent[]>();
    for (const held of given) byOrigin.set(held.originId, [...(byOrigin.get(held.originId) ?? []), held]);
    const record = await readGivenUp(this.options.storage);
    for (const [originId, places] of byOrigin) record[originId] = { count: (record[originId]?.count ?? 0) + places.length, at };
    await this.options.storage.hub().giveUpHeld(given.map((held) => held.hubSeq), { key: HUB_CLIENT_GIVEN_UP_KEY, value: JSON.stringify(record) });
    for (const [originId, places] of byOrigin) {
      this.options.log?.("hub.sync.held-given-up", {
        originId, count: places.length, reasons: [...new Set(places.map((held) => held.reason))],
        conversationIds: [...new Set(places.map((held) => held.conversationId))].slice(0, 20),
        eventIds: places.map((held) => held.eventId).slice(0, 20), oldestHeldAt: places.map((held) => held.heldAt).sort()[0]
      });
    }
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
    if (!this.resyncing && this.now() < this.resyncNotBefore) {
      // A hub that keeps saying so is not answered with a copy every few
      // seconds: the read fails and is tried again later.
      throw new HubTransientError("The server asked to start again too soon after the last start from its copy.");
    }
    this.resyncing ??= this.resyncNow(prunedThrough).then(() => {
      this.resyncFailures = 0;
      this.resyncNotBefore = this.now() + RESYNC_MIN_INTERVAL_MS;
    }, (error: unknown) => {
      // A start that failed is taken up again where it stopped, after a
      // wait that grows with each failure.
      this.resyncFailures += 1;
      this.resyncNotBefore = this.now() + Math.min(RESYNC_MIN_INTERVAL_MS, RESYNC_RETRY_MS * 2 ** (this.resyncFailures - 1));
      throw error;
    }).finally(() => { this.resyncing = undefined; });
    return this.resyncing;
  }

  private async resyncNow(prunedThrough: number): Promise<void> {
    const hub = this.options.storage.hub();
    const merge = this.options.mergeCopy;
    if (!merge) throw new Error("This device cannot start again from the server's copy.");
    const started = this.now();
    const bytesBefore = this.options.client.receivedBytes;
    // Taken up where a failed attempt stopped: its position and marks hold,
    // and the hub keeps everything after that position for this device.
    const progress = this.resyncProgress ?? await this.startResync();
    this.resyncProgress = progress;
    this.options.log?.("hub.sync.resync.started", { prunedThrough, hubSeq: progress.hubSeq, resumed: progress.chats > 0 || Boolean(progress.page) });
    while (!progress.pagesDone) {
      if (this.stopped) throw new HubTransientError("Stopped while starting again from the server's copy.");
      const response = progress.firstPage ?? await this.snapshotPage({ copy: true, ...(progress.page ? { page: progress.page } : {}) });
      progress.firstPage = undefined;
      for (const part of response.conversations) {
        const earlier = progress.partial.get(part.id);
        const joined = earlier ? joinParts(earlier, part) : part;
        if (part.more) {
          progress.partial.set(part.id, joined);
          continue;
        }
        progress.partial.delete(part.id);
        await this.mergeOne(merge, joined, progress);
      }
      if (!response.next) {
        // A chat the last page left open (it went away meanwhile) is merged as far as it came.
        for (const part of progress.partial.values()) await this.mergeOne(merge, part, progress);
        progress.partial.clear();
        progress.pagesDone = true;
        break;
      }
      progress.page = response.next;
    }
    if (progress.failed.size > 0 && progress.attempts > 0) {
      // Taken up again: only the chats that could not be merged, each anew.
      for (const conversationId of [...progress.failed]) {
        try {
          await this.resyncChat(conversationId, { applyMarks: false });
          progress.failed.delete(conversationId);
          progress.chats += 1;
        } catch (error) {
          this.options.log?.("hub.sync.resync.chat-failed", { conversationId, attempt: progress.attempts + 1, message: errorMessage(error) });
        }
      }
    }
    if (progress.failed.size > 0 && progress.attempts + 1 < RESYNC_CHAT_ATTEMPTS) {
      progress.attempts += 1;
      throw new HubTransientError(`${progress.failed.size} chat(s) from the server's copy could not be merged; tried again later.`);
    }
    if (progress.failed.size > 0) {
      // Reported, not dropped in silence: a later change of such a chat
      // finds a gap and takes it from the copy again.
      this.options.log?.("hub.sync.resync.chats-skipped", { conversationIds: [...progress.failed] });
    }
    // A chat that could not be merged keeps its own marks: its changes after
    // its own position still come as events.
    const marks = progress.marks.filter((mark) => !progress.failed.has(mark.logScopeId.slice(CHAT_CHANGES_LOG_SCOPE_PREFIX.length)));
    await this.options.storage.applyChatCopyMarks(marks.map((mark) => ({ ...mark })), new Date(this.now()).toISOString(), await this.options.localOriginId());
    if (progress.hubId) await hub.setClientState(HUB_ID_KEY, progress.hubId);
    await hub.setClientState(PULLED_KEY, String(progress.hubSeq));
    this.resyncProgress = undefined;
    this.options.log?.("hub.sync.resync.finished", {
      hubSeq: progress.hubSeq, chats: progress.chats, failed: progress.failed.size, marks: marks.length,
      bytes: this.options.client.receivedBytes - bytesBefore, ms: this.now() - started
    });
  }

  /** The first page of a start from the hub's copy, which fixes where this
   *  device reads from next. */
  private async startResync(): Promise<ResyncProgress> {
    // What this device still holds stays kept for it: it starts before them,
    // and before what came after where it stood that the copy does not carry.
    const hub = this.options.storage.hub();
    const held = await hub.heldSummary();
    const since = Number(await hub.clientState(PULLED_KEY) ?? "0") || 0;
    const first = await this.snapshotPage({
      copy: true, scopes: await this.ownScopes(), since, ...(held.lowest > 0 ? { atMost: held.lowest - 1 } : {})
    });
    return {
      hubSeq: first.hubSeq, ...(first.hubId ? { hubId: first.hubId } : {}), marks: first.marks ?? [],
      partial: new Map(), failed: new Set(), chats: 0, firstPage: first, pagesDone: false, attempts: 0
    };
  }

  /** One page of the hub's copy. The hub builds one page at a time and asks
   *  the others to come back (503): asked again shortly, not counted as a
   *  failure of the start. */
  private async snapshotPage(request: Parameters<HubClient["snapshot"]>[0]): Promise<HubSnapshotResponse> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.options.client.snapshot(request);
      } catch (error) {
        if (!(error instanceof HubHttpError && error.status === 503) || attempt >= SNAPSHOT_BUSY_RETRIES || this.stopped) throw error;
        await new Promise((resolve) => setTimeout(resolve, SNAPSHOT_BUSY_WAIT_MS * (0.5 + Math.random())));
      }
    }
  }

  private async mergeOne(merge: (copied: CopiedConversation) => Promise<void>, part: HubCopyPart, progress: ResyncProgress): Promise<void> {
    try {
      await merge(copiedFromPart(part));
      progress.chats += 1;
    } catch (error) {
      // One chat that cannot be merged does not stop the others.
      progress.failed.add(part.id);
      this.options.log?.("hub.sync.resync.chat-failed", { conversationId: part.id, message: errorMessage(error) });
    }
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
    // One repair at a time: channels ask without waiting, and a burst of
    // gaps must not become a burst of requests to the small server.
    const turn = this.repairQueue.then(() => this.repairNow(gap));
    this.repairQueue = turn.then(() => undefined, () => undefined);
    try {
      return await turn;
    } finally {
      this.repairing.delete(key);
    }
  }

  private async repairNow(gap: DeviceEventGap): Promise<HubGapRepair> {
    // While this device starts again from the copy, a gap is asked about
    // later: the copy's marks may close it, and an older change must not be
    // put over a chat already taken from the copy.
    if (this.stopped || this.resyncing) return "unavailable";
    try {
      const response = await this.options.client.chain(gap.originId, gap.logScopeId, gap.fromSeq, Math.max(gap.fromSeq, gap.toSeq));
      const pruned = response.pruned;
      const events = [...response.events].sort((left, right) => left.event.originSeq - right.event.originSeq);
      let expected = gap.fromSeq;
      let outcome: HubGapRepair = "repaired";
      let handedIn = 0;
      // The chain in order: what the hub holds is handed in, and a stretch
      // before an event it holds is passed over only if the hub forgot it.
      for (const item of events) {
        const seq = item.event.originSeq;
        if (seq < expected) continue;
        if (seq > expected) {
          if (!pruned || pruned.originSeq < expected || !item.event.prevHash) {
            this.options.log?.("hub.sync.gap-unavailable", { ...gap, missing: expected, retained: events.length });
            return handedIn > 0 ? outcome : "unavailable";
          }
          outcome = await this.passOver(gap, { originSeq: seq - 1, eventHash: item.event.prevHash });
        }
        const received = await this.receiveOrHold(item, { gapRepair: true });
        if (received === "forged") {
          // An event its author did not sign is not what the gap misses.
          this.options.log?.("hub.sync.gap-unavailable", { ...gap, forged: seq });
          return "unavailable";
        }
        if (received === "refused") {
          // Refused here for good (a scope, a conflict): the chain goes on
          // past it instead of waiting for it for ever.
          this.options.log?.("hub.sync.gap-refused", { ...gap, originSeq: seq, eventId: item.event.eventId });
          outcome = await this.passOver(gap, { originSeq: seq, eventHash: item.event.eventHash });
        }
        handedIn += 1;
        expected = seq + 1;
      }
      if (expected <= gap.toSeq) {
        // The rest of the gap is not on the hub.
        if (pruned && pruned.originSeq >= expected) {
          outcome = await this.passOver(gap, await this.passOverPoint({ ...gap, fromSeq: expected }, pruned));
        } else if (handedIn === 0) {
          // Never placed (its author's push was refused, or has not come):
          // nothing to take yet; the author's side reports it.
          this.options.log?.("hub.sync.gap-unavailable", { ...gap, retained: events.length });
          return "unavailable";
        }
      }
      this.options.log?.("hub.sync.gap-repaired", { ...gap, outcome, events: handedIn, ...(pruned ? { prunedThrough: pruned.originSeq } : {}) });
      return outcome;
    } catch (error) {
      this.options.log?.("hub.sync.gap-error", { ...gap, message: errorMessage(error) });
      return "unavailable";
    }
  }

  /** How far to pass over: what the hub forgot, but not past what this
   *  device already holds (the event after the gap names the hash before it). */
  private async passOverPoint(gap: DeviceEventGap, forgotten: { originSeq: number; eventHash: string }): Promise<{ originSeq: number; eventHash: string }> {
    if (forgotten.originSeq <= gap.toSeq) return forgotten;
    const [after] = await this.options.storage.hub().chainFrom(gap.originId, gap.logScopeId, gap.toSeq + 1, 1);
    return after?.originSeq === gap.toSeq + 1 && after.prevHash ? { originSeq: gap.toSeq, eventHash: after.prevHash } : forgotten;
  }

  /** A stretch of a chain this device will never get from the hub: a chat
   *  change chain's chat is taken from the hub's copy (whose mark the chain
   *  continues from), any other chain continues after it. */
  private async passOver(gap: DeviceEventGap, through: { originSeq: number; eventHash: string }): Promise<HubGapRepair> {
    if (isChatChangesLogScope(gap.logScopeId)) {
      await this.resyncChat(gap.logScopeId.slice(CHAT_CHANGES_LOG_SCOPE_PREFIX.length));
      // The copy covers at least this far: what the hub folded of the chain.
      await this.options.storage.deviceEvents().skipTo(gap.originId, gap.logScopeId, through.originSeq, through.eventHash, new Date(this.now()).toISOString());
      return "resynced";
    }
    const moved = await this.options.storage.deviceEvents().skipTo(gap.originId, gap.logScopeId, through.originSeq, through.eventHash, new Date(this.now()).toISOString());
    this.options.log?.("hub.sync.gap-skipped", { ...gap, through: through.originSeq, moved });
    return "skipped";
  }

  /** One chat from the hub's copy, for a chain of its changes the hub forgot. */
  private async resyncChat(conversationId: string, options: { applyMarks?: boolean } = {}): Promise<void> {
    const merge = this.options.mergeCopy;
    if (!merge) throw new Error("This device cannot take a chat from the server's copy.");
    let page: string | undefined;
    let marks: HubCopyMark[] = [];
    let joined: HubCopyPart | undefined;
    for (;;) {
      const response = await this.snapshotPage({ copy: true, chat: conversationId, ...(page ? { page } : {}) });
      if (!page) marks = response.marks ?? [];
      for (const part of response.conversations) {
        joined = joined && joined.id === part.id ? joinParts(joined, part) : part;
      }
      if (!response.next) break;
      page = response.next;
    }
    if (joined) await merge(copiedFromPart(joined));
    if (options.applyMarks !== false) await this.options.storage.applyChatCopyMarks(marks, new Date(this.now()).toISOString(), await this.options.localOriginId());
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
    await this.giveUpOld();
    // A look moves nothing on the hub: what this device holds is said once.
    const report = { ...await this.readReport(), peek: true };
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
        let read;
        try {
          read = await this.options.client.pull(held.hubSeq - 1, 1, report);
        } catch (error) {
          if (!isHubResyncRequired(error)) throw error;
          // The hub forgot what was there and this device started again past
          // it: the held place has nothing left to take.
          this.options.log?.("hub.sync.held-forgotten", { hubSeq: held.hubSeq, eventId: held.eventId, reason: held.reason });
          await hub.releaseHeld([held.hubSeq]);
          continue;
        }
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

  /** Authors whose enrollment was asked for lately (not asked again soon). */
  private readonly enrollmentAsked = new Map<string, number>();

  private async admitFromEnrollment(originId: string): Promise<string | undefined> {
    const asked = this.enrollmentAsked.get(originId);
    if (asked !== undefined && this.now() - asked < ENROLLMENT_ASK_EVERY_MS) return undefined;
    this.enrollmentAsked.set(originId, this.now());
    if (this.enrollmentAsked.size > 200) this.enrollmentAsked.delete(this.enrollmentAsked.keys().next().value!);
    try {
      const chain = await this.options.client.chain(originId, HUB_PHONE_ENROLLMENT_SCOPE, 1, ENROLLMENT_CHAIN_READ);
      for (const item of [...chain.events].reverse()) {
        if (item.event.originId !== originId || item.event.kind !== HUB_PHONE_ENROLLED_EVENT_KIND) continue;
        const key = await this.options.admit!(item.event, () => this.options.client.fetchBlob(item.event));
        if (key && verifySignedChatEvent(item.event, key)) return key;
      }
    } catch (error) {
      this.options.log?.("hub.sync.enrollment-error", { originId, message: errorMessage(error) });
    }
    return undefined;
  }

  private async receive(item: HubLoggedEvent, options: { gapRepair?: boolean } = {}): Promise<ReceiveOutcome> {
    const { event } = item;
    // A hub that sends a device its own events back (an older one) is not
    // telling it anything.
    if (event.originId === await this.options.localOriginId()) return "done";
    let key = await this.options.trustedKey(event.originId);
    if (!key && this.options.admit) key = await this.options.admit(event, () => this.options.client.fetchBlob(event));
    // A phone whose enrollment this device never read (it started reading
    // after it, from the server's copy): its enrollment is asked for.
    if (!key && this.options.admit && event.kind !== HUB_PHONE_ENROLLED_EVENT_KIND) key = await this.admitFromEnrollment(event.originId);
    if (!key) return "unknown-origin";
    if (!verifySignedChatEvent(event, key)) {
      // Claims to be one of the User's devices but is not signed by it.
      this.options.log?.("hub.sync.bad-signature", { eventId: event.eventId, originId: event.originId });
      // Asked for to fill a gap, it is not what the gap misses: its hash
      // proves nothing, so the chain is not moved past it.
      return options.gapRepair ? "forged" : "done";
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
    // Held on its own: a chat change of the same author is not kept behind it.
    if (delivered === "waiting") return "deferred-action";
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
    return outcome === "held" ? "waiting" : outcome === "newer-version" ? "newer-version" : "done";
  }
}

/** What this device gave up on, by author. */
export async function readGivenUp(storage: Pick<StorageService, "hub">): Promise<Record<string, { count: number; at: string }>> {
  try {
    const parsed = JSON.parse(await storage.hub().clientState(HUB_CLIENT_GIVEN_UP_KEY) ?? "{}") as Record<string, { count?: unknown; at?: unknown }>;
    const record: Record<string, { count: number; at: string }> = {};
    for (const [originId, entry] of Object.entries(parsed)) {
      if (Number.isSafeInteger(entry?.count) && typeof entry?.at === "string" && Number.isFinite(Date.parse(entry.at))) record[originId] = { count: entry.count as number, at: entry.at };
    }
    return record;
  } catch {
    return {};
  }
}

function summarizeGivenUp(record: Record<string, { count: number; at: string }>): { count: number; at: string } | undefined {
  const entries = Object.values(record);
  if (entries.length === 0) return undefined;
  return { count: entries.reduce((sum, entry) => sum + entry.count, 0), at: entries.map((entry) => entry.at).sort().pop() as string };
}

/** Two parts of one chat of the hub's copy (newest messages first), joined:
 *  every message once, and who wrote each from both. */
function joinParts(earlier: HubCopyPart, part: HubCopyPart): HubCopyPart {
  const authors = { ...(earlier.authors ?? {}), ...(part.authors ?? {}) };
  return { ...part, messages: [...earlier.messages, ...part.messages], ...(Object.keys(authors).length ? { authors } : {}) };
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

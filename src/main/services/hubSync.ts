import type { ChatEventEnvelope } from "../../shared/chatEvents";
import { verifySignedChatEvent } from "./chatEventLog";
import type { HubClient } from "./hubClient";
import type { StorageService } from "./storage";

const PUSHED_KEY = "pushed-rowid";
const PULLED_KEY = "pulled-hub-seq";
const PUSH_BATCH = 100;

export type HubApplyOutcome = "applied" | "ignored";

/**
 * One device's link to the hub: its own events go up in the order they were
 * written, and everyone else's come down in the hub's order, each applied
 * once. Two cursors, both on disk, are all the state there is: what was
 * pushed and where reading stopped. Nothing waits on another device.
 */
export class HubSync {
  private pushing?: Promise<void>;
  private pushAgain = false;
  private pulling?: Promise<void>;
  private pullAgain = false;
  private stopLive?: () => void;
  private stopped = false;
  private retry?: ReturnType<typeof setTimeout>;
  private connected = false;

  constructor(private readonly options: {
    client: HubClient;
    storage: StorageService;
    localOriginId: () => Promise<string>;
    /** The key a device signs with, when it is one of the User's devices. */
    trustedKey: (originId: string) => Promise<string | undefined>;
    /** Applies a stored event from another device. Throw to retry it later. */
    apply: (event: ChatEventEnvelope) => Promise<HubApplyOutcome>;
    log?: (event: string, payload: Record<string, unknown>) => void;
    onConnectionChange?: (connected: boolean) => void;
    /** Log scopes (by prefix) whose events this device sends; all when unset. */
    scopePrefixes?: string[];
    /** Hands an event to the channel it belongs to (which stores and applies
     *  it itself); false leaves it to `apply`. */
    deliver?: (event: ChatEventEnvelope) => Promise<boolean>;
    /** These own events are now held by the hub, so whoever waited to hand
     *  them over may let go of them. */
    onPushed?: (eventIds: string[]) => Promise<void>;
  }) {}

  start(): void {
    this.stopped = false;
    this.stopLive = this.options.client.live(
      () => this.nudgePull(),
      (connected) => {
        this.connected = connected;
        this.options.onConnectionChange?.(connected);
        if (connected) {
          // A fresh link catches up both ways.
          this.nudgePush();
          this.nudgePull();
        }
      }
    );
    this.nudgePush();
    this.nudgePull();
  }

  stop(): void {
    this.stopped = true;
    this.stopLive?.();
    if (this.retry) clearTimeout(this.retry);
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** This device wrote an event: send it now. */
  nudgePush(): void {
    if (this.stopped) return;
    if (this.pushing) {
      this.pushAgain = true;
      return;
    }
    this.pushing = this.pushAll().catch((error) => {
      this.options.log?.("hub.sync.push-error", { message: error instanceof Error ? error.message : String(error) });
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
    if (this.stopped) return;
    if (this.pulling) {
      this.pullAgain = true;
      return;
    }
    this.pulling = this.pullAll().catch((error) => {
      this.options.log?.("hub.sync.pull-error", { message: error instanceof Error ? error.message : String(error) });
      this.scheduleRetry();
    }).finally(() => {
      this.pulling = undefined;
      if (this.pullAgain) {
        this.pullAgain = false;
        this.nudgePull();
      }
    });
  }

  /** Resolves when nothing is in flight (tests). */
  async idle(): Promise<void> {
    while (this.pushing || this.pulling) {
      await this.pushing;
      await this.pulling;
    }
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      this.nudgePush();
      this.nudgePull();
    }, 5_000);
    this.retry.unref?.();
  }

  private async pushAll(): Promise<void> {
    const hub = this.options.storage.hub();
    const originId = await this.options.localOriginId();
    let cursor = Number(await hub.clientState(PUSHED_KEY) ?? "0") || 0;
    for (;;) {
      const page = await hub.ownEventsAfter(originId, cursor, PUSH_BATCH, this.options.scopePrefixes);
      if (page.length === 0) return;
      const response = await this.options.client.push(page.map((item) => item.event));
      let advanced = cursor;
      const delivered: string[] = [];
      for (const [index, result] of response.results.entries()) {
        if (result.status === "gap") {
          // The hub misses earlier events of this chain (written before it
          // knew this device): send the chain from where the hub stands.
          const event = page[index].event;
          await this.fillGap(originId, event.logScopeId, result.expectedSeq ?? 1);
          // Push the page again; the filled chain makes it fit.
          break;
        }
        if (result.status === "blob-missing") break;
        if (result.status === "conflict" || result.status === "rejected") {
          this.options.log?.("hub.sync.push-refused", { eventId: result.eventId, status: result.status, error: result.error ?? "" });
        }
        advanced = page[index].rowid;
        delivered.push(page[index].event.eventId);
      }
      if (advanced === cursor) {
        // Nothing moved this pass (a gap was filled, or a body is missing):
        // try once more, then leave it for the next nudge.
        const again = await this.options.client.push(page.map((item) => item.event));
        const firstStuck = again.results.findIndex((result) => result.status === "gap" || result.status === "blob-missing");
        const settled = firstStuck === -1 ? page.length : firstStuck;
        if (settled === 0) throw new Error(`The hub cannot place event ${page[0].event.eventId} (${again.results[0]?.status}).`);
        advanced = page[settled - 1].rowid;
        delivered.push(...page.slice(0, settled).map((item) => item.event.eventId));
      }
      if (delivered.length) await this.options.onPushed?.(delivered);
      cursor = advanced;
      await hub.setClientState(PUSHED_KEY, String(cursor));
      if (page.length < PUSH_BATCH) return;
    }
  }

  private async fillGap(originId: string, logScopeId: string, fromSeq: number): Promise<void> {
    const hub = this.options.storage.hub();
    let next = fromSeq;
    for (;;) {
      const chain = await hub.chainFrom(originId, logScopeId, next, PUSH_BATCH);
      if (chain.length === 0) return;
      const response = await this.options.client.push(chain);
      const stuck = response.results.find((result) => result.status === "gap" || result.status === "blob-missing");
      if (stuck) throw new Error(`This device no longer holds the events the hub needs for ${logScopeId} (from ${stuck.expectedSeq ?? fromSeq}).`);
      next = chain[chain.length - 1].originSeq + 1;
      if (chain.length < PUSH_BATCH) return;
    }
  }

  private async pullAll(): Promise<void> {
    const hub = this.options.storage.hub();
    const originId = await this.options.localOriginId();
    let cursor = Number(await hub.clientState(PULLED_KEY) ?? "0") || 0;
    for (;;) {
      const response = await this.options.client.pull(cursor);
      for (const { hubSeq, event } of response.events) {
        if (event.originId !== originId) await this.receive(event);
        cursor = hubSeq;
        await hub.setClientState(PULLED_KEY, String(cursor));
      }
      if (response.events.length === 0 || cursor >= response.head) return;
    }
  }

  private async receive(event: ChatEventEnvelope): Promise<void> {
    const key = await this.options.trustedKey(event.originId);
    if (!key || !verifySignedChatEvent(event, key)) {
      // Not one of the User's devices (or not signed by it): never applied.
      this.options.log?.("hub.sync.untrusted", { eventId: event.eventId, originId: event.originId });
      return;
    }
    await this.options.client.fetchBlob(event);
    if (await this.options.deliver?.(event)) return;
    const [stored] = await this.options.storage.appendChatEvents([event]);
    if (stored?.status === "conflict") {
      this.options.log?.("hub.sync.conflict", { eventId: event.eventId, reason: stored.conflictReason ?? "" });
      return;
    }
    const outcome = await this.options.apply(event);
    if (outcome === "ignored") this.options.log?.("hub.sync.ignored", { eventId: event.eventId, kind: event.kind });
  }
}

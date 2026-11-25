import { HUB_FEED_PAGE_BYTES, HUB_FEED_PAGE_MAX, HUB_FEED_WAIT_MAX_MS, type HubFeedResponse } from "../../shared/hubOps";
import { type HubOpApplied, HubOpsRequestError } from "./types";
import type { HubOpsDependencies } from "./dependencies";

/** What changed, for devices that follow. */
export class Feed {
  private readonly waiters = new Set<() => void>();
  /** Counts what was accepted: a read that saw nothing new waits only if
   *  nothing was accepted while it read (a word given meanwhile is not lost). */
  private generation = 0;
  readonly listeners: Array<(applied: HubOpApplied) => void> = [];

  constructor(private readonly deps: Pick<HubOpsDependencies, "now" | "storage">) {}

  onApplied(listener: (applied: HubOpApplied) => void): void {
    this.listeners.push(listener);
  }

  async head(): Promise<number> {
    return this.deps.storage.hubOps().head();
  }

  // --- reading -------------------------------------------------------------

  /** What was accepted after `after`, waiting up to `waitMs` for something
   *  new. `gone` when the feed no longer holds what comes right after it. */
  async feed(after: number, waitMs: number, closed?: Promise<void>, deviceId?: string): Promise<HubFeedResponse | { gone: true; head: number }> {
    const store = this.deps.storage.hubOps();
    if (!Number.isSafeInteger(after) || after < 0) throw new HubOpsRequestError(400, "Invalid position.");
    // A place this server never gave (it was restored from an older copy, or
    // the device read another server before): read again from the start,
    // never skip what is numbered at or below it here.
    const head = await store.head();
    if (after > head) return { gone: true, head };
    if (deviceId) await store.recordRead(deviceId, after, this.deps.now().toISOString());
    if (after < await store.prunedThrough()) return { gone: true, head };
    let generation = this.generation;
    let page = await store.after(after, HUB_FEED_PAGE_MAX, HUB_FEED_PAGE_BYTES);
    // Something accepted while it read: read again rather than wait for the
    // next word (the one given meanwhile went to nobody).
    while (page.entries.length === 0 && waitMs > 0 && this.generation !== generation) {
      generation = this.generation;
      page = await store.after(after, HUB_FEED_PAGE_MAX, HUB_FEED_PAGE_BYTES);
    }
    // No await between that check and the wait's registration.
    if (page.entries.length === 0 && waitMs > 0) {
      await this.wait(Math.min(waitMs, HUB_FEED_WAIT_MAX_MS), closed);
      page = await store.after(after, HUB_FEED_PAGE_MAX, HUB_FEED_PAGE_BYTES);
    }
    return { entries: page.entries, more: page.more, head: await store.head() };
  }

  private wait(ms: number, closed?: Promise<void>): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.waiters.add(done);
      void closed?.then(done, done);
    });
  }

  wake(): void {
    this.generation += 1;
    for (const waiter of [...this.waiters]) waiter();
  }

  /** Feed readers waiting now (the server's status). */
  waiting(): number {
    return this.waiters.size;
  }
}

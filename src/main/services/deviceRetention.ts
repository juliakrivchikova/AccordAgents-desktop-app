import type { StorageService } from "./storage";

const HOUR_MS = 60 * 60_000;

/** Positive integers from the environment (QA shortens them). */
function envMs(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return process.env[name] !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/**
 * With the User's hub, what this device keeps of the hub's traffic stays
 * bounded too: its own events of the channels the hub carries are forgotten
 * once the hub has them and they are a week old (the newest event of each
 * chain stays, so the next one continues it), and large bodies no stored
 * event refers to any more are deleted (bodies fetched for other devices'
 * events before only the ones that concern this device were fetched, or
 * left behind by forgotten events). Shortly after start, then hourly; a
 * bounded amount per run. Returns a function that stops it.
 */
export function scheduleHubDeviceRetention(options: {
  storage: Pick<StorageService, "deviceEvents" | "deviceEventBlobs">;
  originId(): Promise<string>;
  /** The `device:` scopes the hub carries for this device; undefined while
   *  it has no hub (nothing is forgotten then). */
  hubScopes(): Promise<readonly string[] | undefined>;
  /** This device's own events up to this local position are on the hub. */
  pushedThrough(): Promise<number>;
  log(event: string, payload: Record<string, unknown>): void;
  now?: () => number;
}): () => void {
  const keepMs = envMs("ACCORDAGENTS_DEVICE_KEEP_OWN_EVENTS_MS", 7 * 24 * HOUR_MS);
  const blobGraceMs = envMs("ACCORDAGENTS_DEVICE_BLOB_GRACE_MS", HOUR_MS);
  const blobScanRows = envMs("ACCORDAGENTS_DEVICE_BLOB_SCAN_ROWS", 10_000);
  const intervalMs = envMs("ACCORDAGENTS_DEVICE_RETENTION_INTERVAL_MS", HOUR_MS);
  const firstRunMs = envMs("ACCORDAGENTS_DEVICE_RETENTION_FIRST_MS", 7 * 60_000);
  let running = false;
  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const scopes = await options.hubScopes();
      if (!scopes) return;
      const now = options.now?.() ?? Date.now();
      const originId = await options.originId();
      const pushedThrough = await options.pushedThrough();
      let events = 0;
      for (let batch = 0; batch < 10; batch += 1) {
        const pruned = await options.storage.deviceEvents().pruneOwnDeviceEvents(originId, {
          pushedThroughRowid: pushedThrough, cutoffIso: new Date(now - keepMs).toISOString(), scopePrefixes: scopes, limit: 2_000
        });
        events += pruned;
        if (pruned < 2_000) break;
      }
      const blobs = await options.storage.deviceEventBlobs().collectOrphans({ now, graceMs: blobGraceMs, scanRows: blobScanRows });
      if (events || blobs.deleted) options.log("device.events.pruned", { events, blobs: blobs.deleted, blobBytes: blobs.bytes });
    } catch (error) {
      options.log("device.events.prune-error", { message: error instanceof Error ? error.message : String(error) });
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => { void run(); }, firstRunMs);
  const timer = setInterval(() => { void run(); }, intervalMs);
  first.unref?.();
  timer.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

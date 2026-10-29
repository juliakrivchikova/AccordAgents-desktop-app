import type { StorageService } from "../main/services/storage";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/** How long the hub keeps what every reader has read, and how it works
 *  through it. Each can be set by the environment (QA shortens them). */
export interface HubRetentionConfig {
  intervalMs: number;
  firstRunMs: number;
  /** Accepted operations every computer and machine has read. */
  feedMs: number;
  /** Operations forgotten per transaction, and transactions per run. */
  batch: number;
  maxBatches: number;
  /** A computer or machine that has not read for this long (a machine
   *  stopped for weeks) no longer keeps the feed: when it reads again, it
   *  reads its chats again instead. */
  silentReaderMs: number;
}

export const HUB_RETENTION_DEFAULTS: HubRetentionConfig = {
  intervalMs: HOUR_MS,
  firstRunMs: 5 * 60_000,
  feedMs: 7 * DAY_MS,
  batch: 500,
  maxBatches: 40,
  silentReaderMs: 45 * DAY_MS
};

const ENV_KEYS: Record<keyof HubRetentionConfig, string> = {
  intervalMs: "ACCORDAGENTS_HUB_RETENTION_INTERVAL_MS",
  firstRunMs: "ACCORDAGENTS_HUB_RETENTION_FIRST_MS",
  feedMs: "ACCORDAGENTS_HUB_KEEP_FEED_MS",
  batch: "ACCORDAGENTS_HUB_RETENTION_BATCH",
  maxBatches: "ACCORDAGENTS_HUB_RETENTION_MAX_BATCHES",
  silentReaderMs: "ACCORDAGENTS_HUB_SILENT_READER_MS"
};

/** The defaults, with whatever the environment sets (a positive integer). */
export function hubRetentionConfig(env: NodeJS.ProcessEnv = process.env): HubRetentionConfig {
  const config = { ...HUB_RETENTION_DEFAULTS };
  for (const [key, name] of Object.entries(ENV_KEYS) as Array<[keyof HubRetentionConfig, string]>) {
    const value = Number(env[name]);
    if (env[name] !== undefined && Number.isSafeInteger(value) && value > 0) config[key] = value;
  }
  return config;
}

/** One forgotten stretch, as a retention run reports it. */
export interface HubPruneResult {
  events: number;
  bytes: number;
}

export interface HubRetentionReport {
  /** Accepted operations the server's feed forgot. */
  ops: HubPruneResult;
  /** Bodies (pictures, avatars) nothing names any more. */
  blobs: { deleted: number; bytes: number };
}

/**
 * Keeps the hub's storage bounded without forgetting anything a reader
 * still needs.
 *
 * The server's feed of accepted operations (agreements Д1–Д3) is read by
 * every computer and machine on the roster; an operation goes once every one
 * of them has read past it and it is a week old. A device that does not read
 * holds everything after its place until it reads or is taken off the
 * roster; a device that read less than what was forgotten reads its chats
 * again (HubFeedGone). Bodies no pin keeps (a picture a message names, an
 * avatar the catalog names, an upload waiting for its message) go too. One
 * bounded batch per transaction, so the server keeps taking writes while
 * this runs.
 */
export class HubRetention {
  private first?: ReturnType<typeof setTimeout>;
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<HubRetentionReport>;
  private closed = false;

  constructor(private readonly options: {
    storage: StorageService;
    config?: HubRetentionConfig;
    log?: (event: string, payload: Record<string, unknown>) => void;
    now?: () => number;
    /** Whether bodies may be swept now (false until what the chats and the
     *  catalog name is pinned on a server updated from a program that did
     *  not pin it), and the pins renewed before a sweep. */
    bodiesReady?: () => Promise<boolean>;
    renewPins?: () => Promise<void>;
  }) {}

  private get config(): HubRetentionConfig {
    return this.options.config ?? HUB_RETENTION_DEFAULTS;
  }

  start(): void {
    const run = (): void => {
      void this.runOnce().catch((error: unknown) => {
        this.options.log?.("hub.retention.error", { message: error instanceof Error ? error.message : String(error) });
      });
    };
    this.first = setTimeout(run, this.config.firstRunMs);
    this.timer = setInterval(run, this.config.intervalMs);
    this.first.unref?.();
    this.timer.unref?.();
  }

  /** Stops scheduling; a run in progress ends after its current batch. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
    await this.running?.catch(() => undefined);
  }

  runOnce(): Promise<HubRetentionReport> {
    this.running ??= this.run().finally(() => { this.running = undefined; });
    return this.running;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private async run(): Promise<HubRetentionReport> {
    const config = this.config;
    const now = this.now();
    const report: HubRetentionReport = { ops: { events: 0, bytes: 0 }, blobs: { deleted: 0, bytes: 0 } };
    const devices = await this.options.storage.hub().devices();
    // Every device that keeps copies of the chats reads the feed; a phone
    // reads the server's own copy and holds nothing back, and neither does
    // a computer or machine silent for weeks (it reads its chats again).
    const reads = await this.options.storage.hubOps().cursorTimes();
    const silentBefore = now - config.silentReaderMs;
    const readers = devices.filter((device) => {
      if (device.role === "phone") return false;
      const last = Date.parse(reads.get(device.deviceId)?.updatedAt ?? device.addedAt ?? "");
      return !Number.isFinite(last) || last >= silentBefore;
    }).map((device) => device.deviceId);
    const cutoff = new Date(now - config.feedMs).toISOString();
    for (let index = 0; index < config.maxBatches && !this.closed; index += 1) {
      const pruned = await this.options.storage.hubOps().prune(readers, cutoff, config.batch);
      report.ops.events += pruned.events;
      report.ops.bytes += pruned.bytes;
      if (pruned.events < config.batch) break;
      // Writes and reads in between.
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (!this.closed && (await this.options.bodiesReady?.().catch(() => false) ?? true)) {
      await this.options.renewPins?.().catch((error: unknown) => this.options.log?.("hub.retention.pins-error", { message: error instanceof Error ? error.message : String(error) }));
      if (!this.closed) report.blobs = await this.options.storage.deviceEventBlobs().collectOrphans({ now });
    }
    this.options.log?.(report.ops.events + report.blobs.deleted > 0 ? "hub.retention.pruned" : "hub.retention.kept", {
      ops: report.ops.events, opsBytes: report.ops.bytes, blobs: report.blobs.deleted, blobBytes: report.blobs.bytes
    });
    return report;
  }
}

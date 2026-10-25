import type { HubDevice } from "../shared/hubProtocol";
import type { HubPruneResult, HubReaderFloor } from "../main/services/hubStorage";
import type { StorageService } from "../main/services/storage";
import { hubPairChannelId } from "../main/services/hubChannels";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/** How long the hub keeps what every reader has read, and how it works
 *  through it. Each can be set by the environment (QA shortens them). */
export interface HubRetentionConfig {
  intervalMs: number;
  firstRunMs: number;
  /** Folded chat changes: the chat's copy holds them. */
  chatChangesMs: number;
  /** Events of the channel between a desktop and a machine. */
  pairMs: number;
  /** A run's events, counted from the run's last event. */
  runMs: number;
  chatActionsMs: number;
  /** A body no event refers to is deleted once a whole look at the events
   *  older than this found no reference. */
  blobGraceMs: number;
  /** Events forgotten per transaction, and transactions per rule per run. */
  batch: number;
  maxBatches: number;
  /** Events looked at per run in the search for unreferenced bodies. */
  blobScanRows: number;
}

export const HUB_RETENTION_DEFAULTS: HubRetentionConfig = {
  intervalMs: HOUR_MS,
  firstRunMs: 5 * 60_000,
  chatChangesMs: 7 * DAY_MS,
  pairMs: 3 * DAY_MS,
  runMs: DAY_MS,
  chatActionsMs: 30 * DAY_MS,
  blobGraceMs: HOUR_MS,
  batch: 500,
  maxBatches: 40,
  blobScanRows: 50_000
};

const ENV_KEYS: Record<keyof HubRetentionConfig, string> = {
  intervalMs: "ACCORDAGENTS_HUB_RETENTION_INTERVAL_MS",
  firstRunMs: "ACCORDAGENTS_HUB_RETENTION_FIRST_MS",
  chatChangesMs: "ACCORDAGENTS_HUB_KEEP_CHAT_CHANGES_MS",
  pairMs: "ACCORDAGENTS_HUB_KEEP_PAIR_MS",
  runMs: "ACCORDAGENTS_HUB_KEEP_RUN_MS",
  chatActionsMs: "ACCORDAGENTS_HUB_KEEP_CHAT_ACTIONS_MS",
  blobGraceMs: "ACCORDAGENTS_HUB_BLOB_GRACE_MS",
  batch: "ACCORDAGENTS_HUB_RETENTION_BATCH",
  maxBatches: "ACCORDAGENTS_HUB_RETENTION_MAX_BATCHES",
  blobScanRows: "ACCORDAGENTS_HUB_BLOB_SCAN_ROWS"
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

export interface HubRetentionReport {
  chatChanges: HubPruneResult;
  chatActions: HubPruneResult;
  pairs: HubPruneResult;
  blobs: { deleted: number; bytes: number };
  /** What the order holds after the run. */
  log: { events: number; bytes: number };
  /** The lowest floor among every reader of the shared scopes. */
  sharedFloor: number;
}

/**
 * Keeps the hub's storage bounded without forgetting anything a reader
 * still needs.
 *
 * Every device that reads the order has a floor: the lowest position it may
 * still ask for (its cursor, or its lowest held place before it). The hub
 * forgets an event only when every reader of its scope is past it, and only
 * after a grace period: chat changes once folded into the chat's copy (the
 * copy is the compacted state) and a week old; chat actions after thirty
 * days; the channel between a desktop and a machine after three days, and a
 * run's events a day after the run's last event. A reader that does not
 * read holds everything after its floor until it reads or is removed; the
 * desktop shows it (never dropped automatically). Bodies no remaining event
 * refers to go too. One bounded batch per transaction, so the order keeps
 * taking pushes while this runs.
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
    const hub = this.options.storage.hub();
    const config = this.config;
    const now = this.now();
    const cutoff = (ms: number): string => new Date(now - ms).toISOString();
    const devices = await hub.devices();
    const reads = await hub.deviceReads();
    const authors = await hub.pairAuthors();
    // Readers' floors as they stand now: read again before every batch, so a
    // reader that starts again meanwhile is not passed by what was picked.
    const current = async () => readerFloors(devices, reads, await hub.readerFloors(), authors);
    const floors = await current();
    const report: HubRetentionReport = {
      chatChanges: { events: 0, bytes: 0 }, chatActions: { events: 0, bytes: 0 }, pairs: { events: 0, bytes: 0 },
      blobs: { deleted: 0, bytes: 0 }, log: { events: 0, bytes: 0 }, sharedFloor: floors.shared
    };
    const most = config.batch * config.maxBatches;
    // One look per rule picks what may go; batches then forget it.
    const drain = async (collect: () => Promise<number>, into: HubPruneResult): Promise<void> => {
      if (this.closed || await collect() === 0) return;
      for (let index = 0; index < config.maxBatches && !this.closed; index += 1) {
        const now = await current();
        const result = await hub.pruneCandidates(now.shared, now.pairs, config.batch);
        into.events += result.events;
        into.bytes += result.bytes;
        if (result.events < config.batch) return;
        // Pushes and reads in between.
        await new Promise((resolve) => setImmediate(resolve));
      }
    };
    if (floors.shared > 0) {
      await drain(() => hub.collectChatChanges(floors.shared, cutoff(config.chatChangesMs), most), report.chatChanges);
      await drain(() => hub.collectChatActions(floors.shared, cutoff(config.chatActionsMs), most), report.chatActions);
    }
    await drain(() => hub.collectPairEvents(floors.pairs, cutoff(config.pairMs), cutoff(config.runMs), most), report.pairs);
    if (!this.closed) {
      // The order is small once kept short: one look reaches most of it.
      const blobs = await this.options.storage.deviceEventBlobs().collectOrphans({ now, graceMs: config.blobGraceMs, scanRows: config.blobScanRows });
      report.blobs = { deleted: blobs.deleted, bytes: blobs.bytes };
    }
    report.log = await hub.logSize();
    const forgot = report.chatChanges.events + report.chatActions.events + report.pairs.events + report.blobs.deleted;
    this.options.log?.(forgot > 0 ? "hub.retention.pruned" : "hub.retention.kept", {
      chatChanges: report.chatChanges.events, chatActions: report.chatActions.events, pairs: report.pairs.events,
      bytes: report.chatChanges.bytes + report.chatActions.bytes + report.pairs.bytes,
      blobs: report.blobs.deleted, blobBytes: report.blobs.bytes, logEvents: report.log.events, logBytes: report.log.bytes, sharedFloor: floors.shared
    });
    return report;
  }
}

/**
 * Who reads which scopes, and how far each scope may be forgotten.
 *
 * Readers are the devices on the roster that read the order: the owner,
 * every device that has read here, and machines the desktop says read it
 * (a machine still on a relay does not, and holds nothing). A reader that
 * has not read yet is kept for from where it was set up. Chat changes and
 * chat actions are read by all of them. A channel between two devices is
 * read by its two ends: the desktop and a machine it enrolled (`rv-...`,
 * the machine known from the roster or from what it wrote there), or any
 * two other devices (`pair-...`, named after both, which the hub computes
 * for every two devices on the roster). A device taken off the roster no
 * longer holds its channels; a channel with an end that does not read here
 * (a phone, a machine that never read) or whose ends are not known is kept
 * whole.
 */
export function readerFloors(
  devices: HubDevice[],
  reads: Array<{ deviceId: string; reader: boolean; rendezvousId?: string }>,
  floors: HubReaderFloor[],
  pairAuthors: Array<{ rendezvousId: string; originId: string }>
): { shared: number; pairs: Map<string, number> } {
  const byId = new Map(devices.map((device) => [device.deviceId, device]));
  // A reader that does not say what it holds (an older program) holds
  // everything while it reads: what it holds cannot be told apart.
  const floorById = new Map(floors.map((row) => [row.deviceId, row.reports ? row.floor : 0]));
  const readFlag = new Map(reads.map((row) => [row.deviceId, row]));
  const readers = new Set(devices.filter((device) => device.role !== "phone" &&
    (device.role === "owner" || floorById.has(device.deviceId) || readFlag.get(device.deviceId)?.reader === true)).map((device) => device.deviceId));
  const floorOf = (deviceId: string): number => floorById.get(deviceId) ?? 0;
  const shared = readers.size ? Math.min(...[...readers].map(floorOf)) : 0;
  const desktops = [...readers].filter((id) => byId.get(id)?.role === "owner" || byId.get(id)?.role === "desktop");
  const desktopFloor = desktops.length ? Math.min(...desktops.map(floorOf)) : 0;
  const ends = new Map<string, Set<string>>();
  const note = (rid: string, deviceId: string): void => {
    const set = ends.get(rid) ?? new Set<string>();
    set.add(deviceId);
    ends.set(rid, set);
  };
  for (const row of reads) if (row.rendezvousId) note(row.rendezvousId, row.deviceId);
  for (const row of pairAuthors) note(row.rendezvousId, row.originId);
  for (const [index, first] of devices.entries()) {
    for (const second of devices.slice(index + 1)) {
      if (first.role === "owner" || second.role === "owner") continue;
      const rid = hubPairChannelId(first.deviceId, second.deviceId);
      note(rid, first.deviceId);
      note(rid, second.deviceId);
    }
  }
  const pairs = new Map<string, number>();
  for (const [rid, ids] of ends) {
    const enrolled = !rid.startsWith("pair-");
    // The desktop's own writing in a machine's channel says nothing about
    // which machine is at its other end.
    const members = [...ids].filter((id) => !(enrolled && (byId.get(id)?.role === "owner" || byId.get(id)?.role === "desktop")));
    const present = members.filter((id) => byId.has(id));
    let floor = enrolled ? desktopFloor : Number.POSITIVE_INFINITY;
    for (const id of present) floor = Math.min(floor, byId.get(id)?.role !== "phone" && readers.has(id) ? floorOf(id) : 0);
    // Every end taken off the roster: what is left is the desktop's to read.
    if (present.length === 0) floor = desktopFloor;
    if (Number.isFinite(floor) && floor > 0) pairs.set(rid, floor);
  }
  return { shared, pairs };
}

import type { HubDevice } from "../shared/hubProtocol";
import type { HubPruneResult, HubReaderFloor } from "../main/services/hubStorage";
import type { StorageService } from "../main/services/storage";

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
    const floors = readerFloors(await hub.devices(), await hub.deviceReads(), await hub.readerFloors(), await hub.pairAuthors());
    const report: HubRetentionReport = {
      chatChanges: { events: 0, bytes: 0 }, chatActions: { events: 0, bytes: 0 }, pairs: { events: 0, bytes: 0 },
      blobs: { deleted: 0, bytes: 0 }, log: { events: 0, bytes: 0 }, sharedFloor: floors.shared
    };
    const drain = async (batch: () => Promise<HubPruneResult>, into: HubPruneResult): Promise<void> => {
      for (let index = 0; index < config.maxBatches && !this.closed; index += 1) {
        const result = await batch();
        into.events += result.events;
        into.bytes += result.bytes;
        if (result.events < config.batch) return;
        // Pushes and reads in between.
        await new Promise((resolve) => setImmediate(resolve));
      }
    };
    if (floors.shared > 0) {
      await drain(() => hub.pruneChatChanges(floors.shared, cutoff(config.chatChangesMs), config.batch), report.chatChanges);
      await drain(() => hub.pruneChatActions(floors.shared, cutoff(config.chatActionsMs), config.batch), report.chatActions);
    }
    await drain(() => hub.prunePairEvents(floors.pairs, cutoff(config.pairMs), cutoff(config.runMs), config.batch), report.pairs);
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
 * chat actions are read by all of them; a channel between the desktop and a
 * machine by those two, the machine known from the roster or from what it
 * wrote there. A machine taken off the roster no longer holds its channel;
 * a channel whose machine is not known is kept whole.
 */
export function readerFloors(
  devices: HubDevice[],
  reads: Array<{ deviceId: string; reader: boolean; rendezvousId?: string }>,
  floors: HubReaderFloor[],
  pairAuthors: Array<{ rendezvousId: string; originId: string }>
): { shared: number; pairs: Map<string, number>; readers: string[] } {
  const byId = new Map(devices.map((device) => [device.deviceId, device]));
  const floorById = new Map(floors.map((row) => [row.deviceId, row.floor]));
  const readFlag = new Map(reads.map((row) => [row.deviceId, row]));
  const readers = devices.filter((device) => device.role !== "phone" &&
    (device.role === "owner" || floorById.has(device.deviceId) || readFlag.get(device.deviceId)?.reader === true));
  const floorOf = (deviceId: string): number => floorById.get(deviceId) ?? 0;
  const shared = readers.length ? Math.min(...readers.map((device) => floorOf(device.deviceId))) : 0;
  const desktops = readers.filter((device) => device.role === "owner" || device.role === "desktop");
  const desktopFloor = desktops.length ? Math.min(...desktops.map((device) => floorOf(device.deviceId))) : 0;
  const machinesOf = new Map<string, Set<string>>();
  const note = (rid: string, deviceId: string): void => {
    const set = machinesOf.get(rid) ?? new Set<string>();
    set.add(deviceId);
    machinesOf.set(rid, set);
  };
  for (const row of reads) if (row.rendezvousId) note(row.rendezvousId, row.deviceId);
  for (const row of pairAuthors) {
    const role = byId.get(row.originId)?.role;
    // A desktop's own writing says nothing about which machine is the other end.
    if (role === "owner" || role === "desktop" || role === "phone") continue;
    note(row.rendezvousId, row.originId);
  }
  const pairs = new Map<string, number>();
  for (const [rid, ids] of machinesOf) {
    const onRoster = [...ids].filter((id) => byId.get(id)?.role === "machine");
    if (onRoster.length === 0) {
      // Its machine was removed: only the desktop still reads this channel.
      pairs.set(rid, desktopFloor);
      continue;
    }
    const machineFloor = Math.min(...onRoster.map((id) => readers.some((device) => device.deviceId === id) ? floorOf(id) : 0));
    pairs.set(rid, Math.min(desktopFloor, machineFloor));
  }
  for (const [rid, floor] of pairs) if (floor <= 0) pairs.delete(rid);
  return { shared, pairs, readers: readers.map((device) => device.deviceId) };
}

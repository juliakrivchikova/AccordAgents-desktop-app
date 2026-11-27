import { isPlanUsageProvider, normalizePlanUsageSnapshot } from "../../shared/planUsage";
import type { PlanUsageProvider, PlanUsageRefreshRequest, PlanUsageRefreshResult, PlanUsageSnapshot, PlanUsageView } from "../../shared/types";
import { HubHttpError, type HubClient } from "./hubClient";

/** A burst of changes (a reply's events) goes up once. */
const PUBLISH_DELAY_MS = 2_000;
/** A put that failed (the server away) is tried again after this. */
const PUBLISH_RETRY_MS = 60_000;

interface PlanUsageRunner {
  planUsage(): PlanUsageSnapshot[];
  onPlanUsageChanged(listener: (snapshots: PlanUsageSnapshot[]) => void): () => void;
  refreshPlanUsage(provider: PlanUsageProvider, force?: boolean): Promise<PlanUsageSnapshot[]>;
}

/**
 * The plan usage of this device's CLI accounts on the User's server, and, on
 * the computer, every machine's from there: a member on a cloud machine shows
 * the ring its own machine's CLI reports, exactly as a local member shows
 * this computer's, and nothing goes around the server. Each device puts its
 * last value (PUT /v1/plan-usage); the server tells the live devices, and
 * the computer reads them all again. A machine reads its own again when the
 * computer asks through the server (its live socket).
 */
export class PlanUsageLink {
  private machines: PlanUsageView["machines"] = {};
  private readonly listeners = new Set<(view: PlanUsageView) => void>();
  private stopRunner?: () => void;
  private stopLive?: () => void;
  private publishTimer?: ReturnType<typeof setTimeout>;
  private published?: string;
  private reading?: Promise<void>;
  private readAgain = false;
  /** Bumped by serverChanged: what an older server answers is dropped. */
  private generation = 0;

  constructor(private readonly options: {
    runner: PlanUsageRunner;
    client: () => HubClient | undefined;
    /** The computer: reads the machines' usage and follows the server live.
     *  A machine only puts its own (the runtime owns its live socket). */
    readsMachines: boolean;
    /** This device's id on the server: its own put is not read back. */
    ownDeviceId?: () => Promise<string>;
    log: (event: string, payload: Record<string, unknown>) => void;
  }) {}

  /** Starts listening to this device's CLIs (reads happen from now on). */
  start(): void {
    this.stopRunner ??= this.options.runner.onPlanUsageChanged(() => {
      this.schedulePublish();
      this.emit();
    });
    this.serverChanged();
  }

  stop(): void {
    this.stopRunner?.();
    this.stopRunner = undefined;
    this.stopLive?.();
    this.stopLive = undefined;
    if (this.publishTimer) clearTimeout(this.publishTimer);
    this.publishTimer = undefined;
  }

  /** Another server, or the first one: put again, read again, followed live. */
  serverChanged(): void {
    this.generation += 1;
    this.published = undefined;
    this.machines = {};
    this.stopLive?.();
    this.stopLive = undefined;
    this.schedulePublish(0);
    const client = this.options.client();
    if (client && this.options.readsMachines) {
      this.stopLive = client.live((connected) => {
        if (connected) void this.readMachines();
      }, (frame) => this.handleLiveFrame(frame));
    }
    this.emit();
  }

  view(): PlanUsageView {
    return { local: this.options.runner.planUsage(), machines: this.machines };
  }

  onChanged(listener: (view: PlanUsageView) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Reads again: this device's CLI, or a machine's through the server (its
   *  answer comes back as that machine's put; the server says whether the
   *  machine is there to take the request). */
  async refresh(request: PlanUsageRefreshRequest): Promise<PlanUsageRefreshResult> {
    if (!isPlanUsageProvider(request.provider)) return { view: this.view() };
    if (!request.machineId) {
      await this.options.runner.refreshPlanUsage(request.provider, request.force === true);
      return { view: this.view() };
    }
    const client = this.options.client();
    if (!client) return { view: this.view(), failed: "server-unreachable" };
    try {
      const answer = await client.requestPlanUsageRefresh({
        machineId: request.machineId, provider: request.provider, ...(request.force === true ? { force: true } : {})
      });
      return { view: this.view(), ...(answer?.delivered === false ? { failed: "machine-offline" as const } : {}) };
    } catch (error) {
      this.options.log("plan-usage.refresh-error", { machineId: request.machineId, message: error instanceof Error ? error.message : String(error) });
      return { view: this.view(), failed: "server-unreachable" };
    }
  }

  /** A word on the server's live socket (the machine passes its own here).
   *  The computer's own put is not read back. */
  handleLiveFrame(frame: { type: string } & Record<string, unknown>): void {
    if (frame.type === "plan-usage" && this.options.readsMachines) {
      void (this.options.ownDeviceId?.() ?? Promise.resolve(undefined)).catch(() => undefined).then((ownId) => {
        if (!ownId || frame.deviceId !== ownId) void this.readMachines();
      });
    }
    if (frame.type === "plan-usage-refresh" && isPlanUsageProvider(frame.provider as string)) {
      void this.options.runner.refreshPlanUsage(frame.provider as PlanUsageProvider, frame.force === true);
    }
  }

  /** The live link came back (the server may have restarted): put again. */
  reconnected(): void {
    this.published = undefined;
    this.schedulePublish(0);
  }

  private emit(): void {
    const view = this.view();
    for (const listener of this.listeners) {
      try {
        listener(view);
      } catch {
        // A listener's failure must not stop the others.
      }
    }
  }

  private schedulePublish(delayMs = PUBLISH_DELAY_MS): void {
    if (this.publishTimer && delayMs > 0) return;
    if (this.publishTimer) clearTimeout(this.publishTimer);
    this.publishTimer = setTimeout(() => {
      this.publishTimer = undefined;
      void this.publish();
    }, delayMs);
    this.publishTimer.unref?.();
  }

  private async publish(): Promise<void> {
    const client = this.options.client();
    const snapshots = this.options.runner.planUsage();
    const body = JSON.stringify(snapshots);
    if (!client || snapshots.length === 0 || body === this.published) return;
    try {
      await client.putPlanUsage(snapshots);
      this.published = body;
    } catch (error) {
      // A server older than plan usage says 404: put again at the next change.
      const older = error instanceof HubHttpError && error.status === 404;
      this.options.log("plan-usage.publish-error", { message: error instanceof Error ? error.message : String(error), retry: !older });
      if (!older) this.schedulePublish(PUBLISH_RETRY_MS);
    }
  }

  /** Every machine's usage as the server keeps it; one read at a time, and
   *  one more when asked meanwhile. */
  private readMachines(): Promise<void> {
    if (this.reading) {
      this.readAgain = true;
      return this.reading;
    }
    const generation = this.generation;
    this.reading = (async () => {
      const client = this.options.client();
      if (!client) return;
      const answer = await client.planUsage();
      if (generation !== this.generation) return;
      const machines: PlanUsageView["machines"] = {};
      for (const device of Array.isArray(answer?.devices) ? answer.devices : []) {
        if (typeof device?.machineId !== "string" || typeof device.updatedAt !== "string" || !Array.isArray(device.snapshots)) continue;
        const snapshots = device.snapshots.map(normalizePlanUsageSnapshot).filter((snapshot) => snapshot !== undefined);
        machines[device.machineId] = { snapshots, updatedAt: device.updatedAt };
      }
      this.machines = machines;
      this.emit();
    })().catch((error: unknown) => {
      this.options.log("plan-usage.read-error", { message: error instanceof Error ? error.message : String(error) });
    }).finally(() => {
      this.reading = undefined;
      if (this.readAgain) {
        this.readAgain = false;
        void this.readMachines();
      }
    });
    return this.reading;
  }
}

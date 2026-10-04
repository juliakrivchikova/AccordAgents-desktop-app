import { existsSync } from "node:fs";
import { uptime } from "node:os";
import path from "node:path";
import { AwsMachinePowerClient, awsErrorText, isAwsPowerRefusal } from "../../shared/awsMachinePowerClient";
import type { AwsMachinePowerConfig } from "../../shared/machinePower";
import { assertCurrentAwsMachine } from "./awsMachineIdentity";
import type { CliAgentRunner } from "./cliAgents";
import type { MachineHostService } from "./machineHost";
import { MachineIdleScheduler } from "./machineIdle";
import { MachineHostPowerRegistry, type MachineHostPowerOptions } from "./machineHostPower";
import { MACHINE_IDLE_STOP_MS, MACHINE_STOP_KEY_REFUSED } from "../../shared/machinePower";
import { userDataPath } from "../platform";
import type { MachinePowerStore } from "./machinePowerStore";
import { nativeHostIdentity, verifiedNativeHostReboot, type NativeHostIdentity } from "./nativeHostIdentity";
import { leaseProcessesGone, NativeProcessRegistry } from "./nativeProcessRegistry";
import { readPosixProcessTableAsync, type PosixProcessRow } from "./processTermination";
import { MachineMaintenance } from "./machineMaintenance";

type PowerClient = Pick<AwsMachinePowerClient, "stopAfterDrain" | "close" | "assertCanStop">;

/** How long a stop key AWS refused is left alone before it is asked again.
 *  The key only changes when the runtime restarts with a new one. */
const REFUSED_KEY_RECHECK_MS = 30 * 60_000;

/** Machine-owned power intent. A failed/uncertain AWS call keeps the local
 * fence across process restart; only a verified new host boot clears it.
 * Retries repeat EC2's idempotent stop intent, never a participant command. */
export class MachineIdlePower {
  private scheduler?: MachineIdleScheduler;
  private retry?: ReturnType<typeof setTimeout>;
  private closed = false;
  private stopping = false;
  private uncertainFence = false;
  private lastWarning?: string;
  /** What makes the current warning stale: new work (a neighbour was busy
   *  at the stop), or AWS accepting the stop key. Unset, a warning stays
   *  until another replaces it. */
  private warningResolvedBy?: "activity" | "key" | "coordination";
  /** Host uptime until which a refused stop key is not asked about again. */
  private keyRefusedUntilMs?: number;
  private hostIdentity?: NativeHostIdentity;
  /** Every deployment on this instance publishes what it is doing here.
   *  Idle is measured per profile; the instance is shared. */
  private hostPower?: MachineHostPowerRegistry;
  private readonly client: PowerClient;

  constructor(private readonly options: {
    config: AwsMachinePowerConfig;
    store: MachinePowerStore;
    host: Pick<MachineHostService, "hasWorkForIdleStop" | "prepareIdleStop" | "recoverIdleFence" | "retainIdleFence" | "publishPowerStatus" | "shutdown">;
    runner: Pick<CliAgentRunner, "hasActiveNativeWork" | "fenceIdleNativeAdmissions" | "shutdownWarmAgents">;
    nativeProcessDbPath: string;
    /** This deployment's user-data directory; identifies it host-wide. */
    profilePath?: string;
    /** The host-wide registration this runtime already publishes. Every
     *  runtime has one, with or without AWS power configuration, so a
     *  deployment that cannot stop the instance still keeps another one from
     *  stopping it underneath. */
    presence?: MachineHostPowerRegistry;
    /** The User's automatic-stop switch on the desktop, as last synced here.
     *  Off, this machine never stops the instance; it still publishes its
     *  work so a neighbour that is switched on can coordinate. */
    enabled?: () => Promise<boolean>;
    log(event: string, payload: Record<string, unknown>): void;
  }, private readonly environment: {
    identity(): Promise<NativeHostIdentity | undefined>;
    verifyAws(config: AwsMachinePowerConfig): Promise<void>;
    uptimeMs(): number;
    createHostRegistry?(options: MachineHostPowerOptions): MachineHostPowerRegistry;
    /** Whether a deployment whose runtime is gone still has agents running. */
    hasLiveNativeWork?(profilePath: string, host: NativeHostIdentity): Promise<boolean>;
    client?: PowerClient;
  } = {
    identity: async () => process.platform === "linux" ? nativeHostIdentity() : undefined,
    verifyAws: assertCurrentAwsMachine, uptimeMs: () => uptime() * 1000
  }) { this.client = environment.client ?? new AwsMachinePowerClient(options.config); }

  warning(): string | undefined { return this.lastWarning; }

  /** Called before the relay starts admitting commands. */
  async start(): Promise<void> {
    this.hostIdentity = await this.environment.identity();
    if (!this.hostIdentity) throw new Error("The host boot identity is unavailable; power recovery cannot safely admit work.");
    const bootId = this.hostIdentity.boot;
    // Other deployments on this same instance measure idle independently and
    // cannot see this one's work. Without a shared claim, whichever of them
    // reaches three hours first would stop the instance underneath the others.
    try {
      const registryOptions = {
        profilePath: this.options.profilePath ?? userDataPath(),
        bootId,
        uptimeMs: this.environment.uptimeMs
      };
      this.hostPower = this.options.presence
        ?? this.environment.createHostRegistry?.(registryOptions)
        ?? new MachineHostPowerRegistry(registryOptions);
      this.hostPower.publish(true);
    } catch (error) {
      // Fail closed: without coordination a stop could destroy another
      // deployment's work, so auto-stop is suspended instead of taken blind.
      this.hostPower = undefined;
      this.setWarning(`Automatic idle stop is suspended: this machine's deployments cannot coordinate (${errorText(error)}).`);
      return;
    }
    const retained = await this.options.store.stopFence(bootId);
    if (retained) {
      this.options.host.retainIdleFence();
      if (!this.options.runner.fenceIdleNativeAdmissions()) throw new Error("The retained idle stop raced native session admission.");
      this.stopping = true;
      this.setWarning("The machine is completing its retained idle stop; new turns remain queued.");
      return;
    }
    const previous = await this.options.store.read();
    if (previous?.bootId !== bootId) {
      await this.options.store.write({ version: 1, bootId, idleSinceMs: this.environment.uptimeMs() });
    }
    // A machine metadata outage suspends only auto-stop; native work can still
    // run, and the visible warning must not disappear just because a poll ran.
    this.scheduler = new MachineIdleScheduler({ state: this.options.store, bootId, uptimeMs: this.environment.uptimeMs,
      isBusy: async () => {
        const busy = await this.localBusy(bootId) || this.options.runner.hasActiveNativeWork();
        // Publish before answering, so a deployment deciding to stop right now
        // reads this one's current state rather than a stale claim.
        try { this.hostPower?.publish(busy); }
        catch (error) { this.setWarning(`Automatic idle stop is suspended: ${errorText(error)}`); return true; }
        return busy;
      },
      prepareStop: async since => {
        if (this.options.enabled && !await this.options.enabled()) {
          // Switched off is not a problem to report: nothing here is broken.
          this.clearWarning();
          return undefined;
        }
        if (this.keyRefusedUntilMs !== undefined && this.environment.uptimeMs() < this.keyRefusedUntilMs) return undefined;
        // The decision and the work that could invalidate it are one critical
        // section on this host. `beginStop` surveys every deployment's claim
        // and writes the intent inside the same lock an admission takes, so a
        // turn cannot start in the gap a plain read would leave open.
        if (!await this.beginHostStop(since)) return undefined;
        let committed = false;
        try {
          await this.environment.verifyAws(this.options.config);
          // A key AWS no longer accepts (rotated away, wrong region) would
          // fence every turn behind a stop that can never happen. Ask first,
          // as a dry run: a refusal leaves the machine awake with a warning
          // that reads the same each time, and is not asked again for a while.
          try {
            await this.client.assertCanStop();
          } catch (error) {
            if (!isAwsPowerRefusal(error)) throw error;
            this.keyRefusedUntilMs = this.environment.uptimeMs() + REFUSED_KEY_RECHECK_MS;
            this.setWarning(`Automatic idle stop is suspended: ${MACHINE_STOP_KEY_REFUSED}, so it stays awake (${awsErrorText(error)}).`, "key");
            return undefined;
          }
          this.keyRefusedUntilMs = undefined;
          this.resolveWarning("key");
          this.resolveWarning("activity");
          const drain = await this.options.host.prepareIdleStop({ bootId, uptimeMs: this.environment.uptimeMs(), idleSinceMs: since,
            fenceNative: () => this.options.runner.fenceIdleNativeAdmissions(), stopProviders: () => this.options.runner.shutdownWarmAgents(),
            commitHostStop: prepareLocal => this.hostPower!.commitStop(prepareLocal) });
          if (!drain) return undefined;
          committed = true;
          return async () => {
            this.stopping = true;
            this.setWarning("The machine is stopping after three hours idle; new turns remain queued.");
            try { await drain(); await this.stopAws(); }
            catch (error) { this.failedStop(error); }
          };
        } catch (error) {
          let fence: boolean;
          try { fence = await this.options.host.recoverIdleFence(bootId); }
          catch {
            this.uncertainFence = true;
            this.stopping = true;
            this.failedStop(error);
            // The scheduler stays active until we know whether preparation
            // committed. Recovery, not another preparation, owns these gates.
            return undefined;
          }
          if (!fence) throw error;
          this.stopping = true;
          return async () => this.failedStop(error);
        } finally {
          if (!committed && !this.stopping) await this.abandonHostStop();
        }
      },
      onError: error => this.setWarning(`Automatic idle stop is suspended: ${errorText(error)}`) });
  }

  /** Only after the host restored its inbox/copy barriers and run inventory.
   * Startup is busy even if no native process has been created yet. */
  ready(): void {
    if (this.stopping) this.scheduleRetry(0);
    else this.scheduler?.start();
  }

  noteActivity(): Promise<void> {
    try { this.hostPower?.publish(true); this.resolveWarning("activity"); }
    catch (error) { this.setWarning(`Automatic idle stop is suspended: ${errorText(error)}`); }
    return this.scheduler?.noteActivity() ?? Promise.resolve();
  }

  close(): void {
    this.closed = true;
    // Observation can end before the host finishes draining. The caller must
    // explicitly release the registration after admission and shutdown settle.
    this.scheduler?.close();
    if (this.retry) clearTimeout(this.retry);
    this.client.close();
  }

  async releaseAfterShutdown(): Promise<void> {
    if (!this.hostPower || !this.hostIdentity) return;
    if (!this.closed || this.options.runner.hasActiveNativeWork()) throw new Error("Native work has not finished shutting down.");
    await assertNativeRegistryClosed(this.options.nativeProcessDbPath, this.hostIdentity);
    this.hostPower.release();
  }

  private async localBusy(bootId: string): Promise<boolean> {
    if (this.options.runner.hasActiveNativeWork() || await this.options.host.hasWorkForIdleStop()) return true;
    if (!await this.options.store.hasMaintenance(bootId, this.environment.uptimeMs())) return false;
    await new MachineMaintenance(this.options.store, this.options.nativeProcessDbPath).recover(this.hostIdentity!);
    return this.options.store.hasMaintenance(bootId, this.environment.uptimeMs());
  }

  /**
   * Takes the host-wide intent to stop. Agents working on this host keep it
   * up without a warning: that is the rule, not a fault. Only a host whose
   * deployments cannot be read, or cannot coordinate, is reported.
   *
   * Three hours of quiet in this profile is not three hours of host idle: the
   * survey inside `beginStop` measures from the last moment ANY deployment
   * here was working, so a neighbour's short turn keeps the instance up.
   */
  private async beginHostStop(ownIdleSinceUptimeMs: number): Promise<boolean> {
    if (!this.hostPower) {
      this.setWarning("The machine stays awake: this machine's deployments cannot coordinate.");
      return false;
    }
    try {
      // A deployment that crashed or was killed cannot release its claim.
      // Its owner is gone; only agents it left running may hold the host.
      const released = await this.hostPower.releaseDeadClaims(profilePath => this.hasLiveNativeWork(profilePath));
      if (released) this.options.log("machine.host-power.released", { released });
      if (await this.hostPower.beginStop({ minIdleMs: MACHINE_IDLE_STOP_MS, ownIdleSinceUptimeMs })) {
        this.resolveWarning("coordination");
        return true;
      }
    } catch (error) {
      this.setWarning(`The machine stays awake: this machine's deployments cannot be read (${errorText(error)}).`, "coordination");
      return false;
    }
    let busy: Array<{ version: number; profilePath: string; kind: string }>;
    try { busy = this.hostPower.others().filter(claim => claim.busy); }
    catch (error) {
      this.setWarning(`The machine stays awake: this machine's deployments cannot be read (${errorText(error)}).`, "coordination");
      return false;
    }
    const outdated = busy.find(claim => claim.version !== 2);
    if (outdated) {
      this.setWarning(`The machine stays awake: another deployment on it (${outdated.profilePath}) needs an update before automatic stop can coordinate with it.`, "coordination");
      return false;
    }
    // Agents working, or working recently, next door is the ordinary reason to
    // stay up, not something the User has to act on.
    this.options.log("machine.idle.held", { busy: busy.length });
    this.resolveWarning("activity");
    this.resolveWarning("coordination");
    return false;
  }

  private hasLiveNativeWork(profilePath: string): Promise<boolean> {
    const host = this.hostIdentity!;
    return this.environment.hasLiveNativeWork
      ? this.environment.hasLiveNativeWork(profilePath, host)
      : nativeRegistryHasLiveWork(path.join(profilePath, "native-processes.sqlite3"), host);
  }

  private async abandonHostStop(): Promise<void> {
    try { await this.hostPower?.abandonStop(); }
    catch (error) { this.setWarning(`Automatic idle stop is suspended: ${errorText(error)}`); }
  }

  /** The gate every native admission on this host consults. */
  admission(): ((what: string) => Promise<{ admitted: true } | { admitted: false; reason: string }>) | undefined {
    return this.hostPower ? (what) => this.hostPower!.admit(what) : undefined;
  }

  private async stopAws(): Promise<void> {
    if (this.closed) return;
    if (this.uncertainFence) {
      const retained = await this.options.host.recoverIdleFence(this.hostIdentity!.boot);
      if (!retained) {
        await this.abandonHostStop();
        this.uncertainFence = false;
        this.stopping = false;
        this.setWarning("The interrupted idle-stop preparation did not commit; queued work can continue.");
        return;
      }
      this.uncertainFence = false;
    }
    if (!this.hostPower) throw new Error("The shared host stop cannot be verified; the machine stays awake.");
    const intent = this.hostPower.stopIntent();
    if (intent?.phase === "committed") {
      if (intent.profileId !== this.hostPower.identity().profileId) throw new Error("Another deployment owns the host stop; this deployment remains fenced.");
    } else {
      // A crash can separate the local SQLite fence from the shared file.
      // Never issue AWS Stop until admission is excluded across the host too.
      const state = await this.options.store.read();
      const since = state?.idleSinceMs ?? this.environment.uptimeMs();
      if ((!intent && !await this.beginHostStop(since)) || !await this.hostPower.commitStop()) {
        throw new Error("The shared host stop is not committed; another deployment may still be working.");
      }
    }
    await this.environment.verifyAws(this.options.config);
    await this.options.host.shutdown(() => this.options.runner.shutdownWarmAgents(), false);
    await assertNativeRegistryClosed(this.options.nativeProcessDbPath, this.hostIdentity!);
    if (this.closed) return;
    const state = await this.client.stopAfterDrain();
    this.setWarning(`The AWS machine is ${state.state} after three hours idle; queued turns run after it wakes.`);
    this.options.log("machine.idle.stop.accepted", { state: state.state });
  }

  private failedStop(error: unknown): void {
    this.setWarning(`Idle stop is not confirmed; native work remains queued: ${errorText(error)}`);
    this.scheduleRetry(30_000);
  }

  private scheduleRetry(delay: number): void {
    if (this.closed || this.retry || !this.stopping) return;
    this.retry = setTimeout(() => { this.retry = undefined; void this.stopAws().catch(error => this.failedStop(error)); }, delay);
    this.retry.unref();
  }

  private setWarning(warning: string, resolvedBy?: "activity" | "key" | "coordination"): void {
    this.warningResolvedBy = resolvedBy;
    if (this.lastWarning === warning) return;
    this.lastWarning = warning;
    this.options.log("machine.idle.status", { warning });
    void this.options.host.publishPowerStatus().catch(() => undefined);
  }

  /** Drops whatever warning is shown, for a state that has none. */
  private clearWarning(): void {
    if (!this.lastWarning) return;
    this.lastWarning = undefined;
    this.warningResolvedBy = undefined;
    this.options.log("machine.idle.status", { warning: null });
    void this.options.host.publishPowerStatus().catch(() => undefined);
  }

  /** Drops a warning its own cause has resolved, so the desktop does not keep
   *  showing a moment that has passed. */
  private resolveWarning(cause: "activity" | "key" | "coordination"): void {
    if (!this.lastWarning || this.warningResolvedBy !== cause) return;
    this.lastWarning = undefined;
    this.warningResolvedBy = undefined;
    this.options.log("machine.idle.status", { warning: null });
    void this.options.host.publishPowerStatus().catch(() => undefined);
  }
}

/** A dead runtime is not proof that its native work is gone. Every retained
 * executor needs its guardian's close receipt, a verified host reboot, or
 * proof that every process it recorded is gone. The last is what a guardian
 * killed together with its runtime leaves behind; without it one crash would
 * keep this machine awake, and this participant unable to start, until the
 * next reboot. */
export async function assertNativeRegistryClosed(registryPath: string, host: NativeHostIdentity,
  readProcessTable: () => Promise<Map<number, PosixProcessRow> | undefined> = readPosixProcessTableAsync): Promise<void> {
  const registry = new NativeProcessRegistry(registryPath);
  await registry.init();
  let rows: Map<number, PosixProcessRow> | undefined;
  let cursor = "";
  for (;;) {
    const leases = await registry.openLeases(cursor);
    if (!leases.length) return;
    for (const lease of leases) {
      if (verifiedNativeHostReboot(lease.host, host)) {
        await registry.update({ ...lease, phase: "closed", shutdownReason: "host-rebooted" });
      } else {
        rows ??= await readProcessTable();
        if (!rows || !leaseProcessesGone(lease, host, rows)) throw new Error("A native executor has not confirmed that its processes are gone.");
        await registry.update({ ...lease, phase: "closed", shutdownReason: "processes-gone" });
      }
      cursor = lease.scope;
    }
  }
}

/**
 * Whether another deployment on this host still has native work running,
 * read from its own registry without changing it.
 *
 * Its owner is gone, so nobody will close its leases; what counts is whether
 * the processes they recorded still exist. A deployment that never started a
 * native executor has no registry at all. One that cannot be read is assumed
 * to be working: a stop that kills a provider turn is lost work.
 */
export async function nativeRegistryHasLiveWork(registryPath: string, host: NativeHostIdentity,
  readProcessTable: () => Promise<Map<number, PosixProcessRow> | undefined> = readPosixProcessTableAsync): Promise<boolean> {
  if (!existsSync(registryPath)) return false;
  const registry = new NativeProcessRegistry(registryPath);
  let rows: Map<number, PosixProcessRow> | undefined;
  let cursor = "";
  for (;;) {
    const leases = await registry.openLeases(cursor);
    if (!leases.length) return false;
    for (const lease of leases) {
      if (!verifiedNativeHostReboot(lease.host, host)) {
        rows ??= await readProcessTable();
        if (!rows || !leaseProcessesGone(lease, host, rows)) return true;
      }
      cursor = lease.scope;
    }
  }
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }

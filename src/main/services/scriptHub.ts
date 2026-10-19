import type { MachineScriptsOperation } from "../../shared/machineLink";
import {
  SCRIPT_DESKTOP_HOST_ID,
  machineScriptHostPhrase,
  type ScheduledScriptSummary,
  type ScriptRevisionContent,
  type ScriptRunRow
} from "../../shared/scripts";
import type { MachineScriptHost } from "./machineLink";
import type { ScriptService } from "./scripts";

/** What the hub needs from the machine link. */
export interface ScriptMachinesPort {
  scriptHosts(): MachineScriptHost[];
  scriptsRequest(machineId: string, operation: MachineScriptsOperation, timeoutMs?: number): Promise<unknown>;
}

/** A list is shown without waiting longer than this for a slow machine. */
const LIST_TIMEOUT_MS = 6000;

type ScriptControl = "runNow" | "delete" | "releaseHeld" | "discardHeld";

/** The desktop's one view of every scheduled script: its own, and those that
 *  live on its machines (asked over the link, so key values and commands go
 *  to the one machine that runs the script). */
export class ScriptHub {
  /** Last list each machine answered, shown while it is away. */
  private readonly machineCache = new Map<string, ScheduledScriptSummary[]>();
  /** At most one list request per machine at a time; later callers share it. */
  private readonly inflight = new Map<string, Promise<ScheduledScriptSummary[] | undefined>>();

  constructor(
    private readonly local: ScriptService,
    private readonly machines: () => ScriptMachinesPort | undefined,
    private readonly listTimeoutMs = LIST_TIMEOUT_MS
  ) {}

  /** A machine's record id, or undefined for this desktop. A machine's own
   *  `machine:` id never names a host here: requests name the record id. */
  private machineHost(hostId: string | undefined): string | undefined {
    if (!hostId || hostId === SCRIPT_DESKTOP_HOST_ID) return undefined;
    if (hostId.startsWith("machine:")) throw new Error("Name a machine by its id in Settings → Machines.");
    return hostId;
  }

  private stamp(host: Pick<MachineScriptHost, "machineId" | "name">, summary: ScheduledScriptSummary, reachable: boolean): ScheduledScriptSummary {
    return {
      ...summary,
      // A runtime of another version may leave a list out; the renderer reads them all.
      secretNames: Array.isArray(summary.secretNames) ? summary.secretNames : [],
      savedSecretNames: Array.isArray(summary.savedSecretNames) ? summary.savedSecretNames : [],
      heldMessageCount: typeof summary.heldMessageCount === "number" ? summary.heldMessageCount : 0,
      hostId: host.machineId,
      hostLabel: host.name,
      hostPhrase: machineScriptHostPhrase(host.name),
      hostReachable: reachable,
      ...(reachable ? {} : { running: false })
    };
  }

  /** Asks one machine for its list (sharing a request already on its way);
   *  undefined when it cannot answer now. */
  private fetchMachine(port: ScriptMachinesPort, host: MachineScriptHost): Promise<ScheduledScriptSummary[] | undefined> {
    const pending = this.inflight.get(host.machineId);
    if (pending) return pending;
    const request = (async () => {
      try {
        const listed = await port.scriptsRequest(host.machineId, { op: "list" }, this.listTimeoutMs);
        const stamped = (Array.isArray(listed) ? listed as ScheduledScriptSummary[] : []).map((item) => this.stamp(host, item, true));
        this.machineCache.set(host.machineId, stamped);
        return stamped;
      } catch {
        return undefined;
      } finally {
        this.inflight.delete(host.machineId);
      }
    })();
    this.inflight.set(host.machineId, request);
    return request;
  }

  /** Every script. Machines named in `refresh` (all of them when it is
   *  omitted) are asked afresh; the others show their last answer unless
   *  none is known yet. */
  async list(refresh?: string[]): Promise<ScheduledScriptSummary[]> {
    const own = await this.local.list();
    const port = this.machines();
    const hosts = (port?.scriptHosts() ?? []).filter((host) => host.supported || this.machineCache.has(host.machineId));
    const remote = await Promise.all(hosts.map(async (host) => {
      const ask = host.connected && host.supported && (!refresh || refresh.includes(host.machineId) || !this.machineCache.has(host.machineId));
      const fresh = ask && port ? await this.fetchMachine(port, host) : undefined;
      if (fresh) return fresh;
      const cached = this.machineCache.get(host.machineId) ?? [];
      const reachable = host.connected && host.supported && !ask;
      return cached.map((item) => this.stamp(host, item, reachable));
    }));
    return [...own, ...remote.flat()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private async onMachine<T>(machineId: string, operation: MachineScriptsOperation): Promise<T> {
    const port = this.machines();
    if (!port) throw new Error("Machines are not available on this computer.");
    return await port.scriptsRequest(machineId, operation) as T;
  }

  private async summaryFrom(machineId: string, operation: MachineScriptsOperation): Promise<ScheduledScriptSummary> {
    const summary = await this.onMachine<ScheduledScriptSummary>(machineId, operation);
    const host = this.machines()?.scriptHosts().find((item) => item.machineId === machineId);
    return this.stamp({ machineId, name: host?.name ?? summary.hostLabel }, summary, true);
  }

  async revision(hostId: string | undefined, scriptId: string, revisionId?: string): Promise<ScriptRevisionContent> {
    const machineId = this.machineHost(hostId);
    if (machineId) return this.onMachine(machineId, { op: "revision", scriptId, ...(revisionId ? { revisionId } : {}) });
    return this.local.revisionContent(scriptId, revisionId);
  }

  async runs(hostId: string | undefined, scriptId: string): Promise<ScriptRunRow[]> {
    const machineId = this.machineHost(hostId);
    if (machineId) return this.onMachine(machineId, { op: "runs", scriptId });
    return this.local.runs(scriptId);
  }

  async setSecret(hostId: string | undefined, scriptId: string, name: string, value: string): Promise<ScheduledScriptSummary> {
    const machineId = this.machineHost(hostId);
    if (machineId) return this.summaryFrom(machineId, { op: "setSecret", scriptId, name, value });
    await this.local.setSecret(scriptId, name, value);
    return this.local.summary(scriptId);
  }

  async deleteSecret(hostId: string | undefined, scriptId: string, name: string): Promise<ScheduledScriptSummary> {
    const machineId = this.machineHost(hostId);
    if (machineId) return this.summaryFrom(machineId, { op: "deleteSecret", scriptId, name });
    await this.local.deleteSecret(scriptId, name);
    return this.local.summary(scriptId);
  }

  async setEnabled(hostId: string | undefined, scriptId: string, enabled: boolean): Promise<ScheduledScriptSummary> {
    const machineId = this.machineHost(hostId);
    if (machineId) return this.summaryFrom(machineId, { op: "setEnabled", scriptId, enabled });
    await this.local.setEnabled(scriptId, enabled);
    return this.local.summary(scriptId);
  }

  /** Run now, Delete, and the two held-message actions. */
  async control(hostId: string | undefined, op: ScriptControl, scriptId: string): Promise<void> {
    const machineId = this.machineHost(hostId);
    if (machineId) {
      await this.onMachine(machineId, { op, scriptId });
      return;
    }
    switch (op) {
      case "runNow": return this.local.runNow(scriptId);
      case "delete": return this.local.deleteScript(scriptId);
      case "releaseHeld": return this.local.releaseHeld(scriptId).then(() => undefined);
      case "discardHeld": return this.local.discardHeld(scriptId).then(() => undefined);
    }
  }
}

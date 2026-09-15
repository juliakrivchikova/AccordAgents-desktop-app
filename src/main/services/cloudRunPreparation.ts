import { createHash, randomUUID } from "node:crypto";
import type { AwsWorkerStatus, CloudRunWorkerSettings } from "../../shared/types";
import type { MachineRecord } from "../../shared/machineLink";
import type { MachineInstallRecord, MachineInstallRequest, MachineInstallResult, MachineInstallSnapshot, MachineMirrorBootstrapResult } from "../../shared/machineInstall";
import type { CloudRunPreparationProgress, CloudRunPreparationState, PrepareCloudRunRequest, PrepareCloudRunResult } from "../../shared/cloudRunPreparation";

interface Options {
  onProgress?(snapshot: CloudRunPreparationState): void;
  configuredInstanceId(): Promise<string | undefined>;
  appVersion: string;
  environmentId(): Promise<string>;
  aws: {
    status(): Promise<AwsWorkerStatus>;
    ensureExistingWorkerForRun(instanceId: string): Promise<CloudRunWorkerSettings>;
  };
  listMachines(): Promise<MachineRecord[]>;
  listInstalls(): Promise<MachineInstallRecord[]>;
  createMachine(name: string, awsInstanceId: string): Promise<MachineRecord>;
  install(request: MachineInstallRequest, progress: (snapshot: MachineInstallSnapshot) => void): Promise<MachineInstallResult>;
  isConnected(machineId: string): boolean;
  bootstrapProject(machineId: string, localPath: string, signal?: AbortSignal, progress?: (message: string) => void): Promise<MachineMirrorBootstrapResult>;
  saveInstall(record: MachineInstallRecord): Promise<void>;
  prepareMachine(worker: CloudRunWorkerSettings, record: MachineInstallRecord): Promise<void>;
  prepareProvider(worker: CloudRunWorkerSettings, provider: PrepareCloudRunRequest["provider"], record: MachineInstallRecord,
    progress: (snapshot: Omit<CloudRunPreparationProgress, "operationId">) => void): Promise<void>;
}

interface PreparedMachine {
  identity: string;
  instanceId: string;
  machine: MachineRecord;
  worker: CloudRunWorkerSettings;
  record: MachineInstallRecord;
  providers: Set<PrepareCloudRunRequest["provider"]>;
  retryProviders: Set<PrepareCloudRunRequest["provider"]>;
}

function preparationIdentity(machine: MachineRecord, record: MachineInstallRecord): string {
  return JSON.stringify([machine.id, machine.awsInstanceId, machine.deviceId, machine.lastHello?.instanceId,
    machine.lastHello?.instanceStartedAt, machine.lastHello?.instanceSequence, machine.lastHello?.appVersion,
    record.installRoot, record.userDataDir, record.profileHome, record.serviceName, record.serviceScope,
    record.target.host, record.target.port, record.target.user, record.target.identityFile, record.target.hostKeyAlias]);
}

export function cloudEnvironmentDirectory(environmentId: string): string {
  if (!environmentId.trim()) throw new Error("This desktop has no environment identity.");
  return `accordagents-${createHash("sha256").update(environmentId).digest("hex").slice(0, 24)}`;
}

/** The user's Cloud run selection prepares the existing instance. This never
 * provisions another server, moves a participant or starts a provider turn. */
export class CloudRunPreparationService {
  private active?: Promise<PrepareCloudRunResult>;
  private activeProvider?: PrepareCloudRunRequest["provider"];
  private activeInstance?: string;
  private listeners = new Set<(message: Omit<CloudRunPreparationProgress, "operationId">) => void>();
  private latest?: Omit<CloudRunPreparationProgress, "operationId">;
  private projects?: Promise<Map<string, Record<string, string>>>;
  private projectTasks = new Map<string, Promise<void>>();
  private states = new Map<string, CloudRunPreparationState>();
  private prepared?: PreparedMachine;

  constructor(private readonly options: Options) {}

  private key(request: Pick<PrepareCloudRunRequest, "provider" | "instanceId">): string {
    return `${request.provider}:${request.instanceId ?? "configured"}`;
  }

  snapshot(request: Pick<PrepareCloudRunRequest, "provider" | "instanceId">): CloudRunPreparationState | undefined {
    return this.states.get(this.key(request));
  }

  private publish(request: PrepareCloudRunRequest, phase: CloudRunPreparationState["phase"],
    snapshot: Omit<CloudRunPreparationProgress, "operationId">, machine?: MachineRecord): void {
    const state: CloudRunPreparationState = { ...snapshot, operationId: request.operationId,
      provider: request.provider, instanceId: request.instanceId, phase, ...(machine ? { machine } : {}) };
    this.states.set(this.key(request), state);
    this.options.onProgress?.(state);
  }

  private projectIndex(): Promise<Map<string, Record<string, string>>> {
    if (!this.projects) {
      this.projects = this.options.listInstalls().then(records => new Map(records.map(record => [record.machineId, record.projects ?? {}])));
      void this.projects.catch(() => { this.projects = undefined; });
    }
    return this.projects;
  }

  async repositoryPaths(sourcePath: string): Promise<Record<string, string>> {
    return Object.fromEntries([...(await this.projectIndex())].flatMap(([id, paths]) =>
      typeof paths[sourcePath] === "string" ? [[id, paths[sourcePath]]] : []));
  }

  /** Bootstrap once, outside the chat mutation lock. Existing projects and
   * participant-created worktrees are reused without another copy. */
  async prepareProject(machineId: string, localPath: string, signal?: AbortSignal, progress?: (message: string) => void): Promise<void> {
    signal?.throwIfAborted();
    progress?.("Preparing the project on your cloud machine…");
    const previous = this.projectTasks.get(machineId) ?? Promise.resolve();
    let started = false;
    const task = previous.catch(() => undefined).then(async () => {
      started = true;
      signal?.throwIfAborted();
      const index = await this.projectIndex();
      signal?.throwIfAborted();
      if (index.get(machineId)?.[localPath]) return;
      const records = await this.options.listInstalls();
      const record = records.find(item => item.machineId === machineId);
      if (!record) return; // Manually enrolled machines keep their own path.
      signal?.throwIfAborted();
      const result = await this.options.bootstrapProject(machineId, localPath, signal, progress);
      signal?.throwIfAborted();
      // A dirty checkout is already the machine's working copy. Keep every
      // change and worktree, and run there; never copy over it to make it clean.
      if (!["clean", "dirty", "directory"].includes(result.inspection.state) || !result.inspection.path.startsWith("/")) {
        throw new Error(result.message || "The cloud project could not be prepared.");
      }
      const current = (await this.options.listInstalls()).find(item => item.machineId === machineId);
      if (!current) throw new Error("The machine was removed during project setup.");
      const projects = { ...current.projects, [localPath]: result.inspection.path };
      signal?.throwIfAborted();
      await this.options.saveInstall({ ...current, projects });
      index.set(machineId, projects);
    });
    this.projectTasks.set(machineId, task);
    const forget = (): void => { if (this.projectTasks.get(machineId) === task) this.projectTasks.delete(machineId); };
    void task.then(forget, forget);
    // Cancelling a queued caller must not abort another chat's copy, release
    // its queue reservation early, or make the caller wait for that copy.
    let abortQueued: (() => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abortQueued = () => { if (!started) reject(signal?.reason); };
      signal?.addEventListener("abort", abortQueued, { once: true });
    });
    try { await Promise.race([task, cancelled]); }
    finally { if (abortQueued) signal?.removeEventListener("abort", abortQueued); }
  }

  async prepare(request: PrepareCloudRunRequest, progress: (snapshot: CloudRunPreparationProgress) => void): Promise<PrepareCloudRunResult> {
    if (typeof request?.operationId !== "string" || !request.operationId.trim() || (request.provider !== "codex-cli" && request.provider !== "claude-code")) {
      throw new Error("Choose a supported provider before preparing Cloud run.");
    }
    request = { ...request };
    let currentInstance: string | undefined;
    let prepared: PreparedMachine | undefined;
    try {
      currentInstance = await this.options.configuredInstanceId();
      if (request.instanceId && request.instanceId !== currentInstance) {
        throw new Error("This machine belongs to a different AWS instance. Select Cloud run to use the instance currently shown in Settings.");
      }
      prepared = await this.reusableMachine(currentInstance);
    }
    catch (error) {
      this.publish(request, "error", { message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    if (prepared?.providers.has(request.provider)) {
      this.publish(request, "ready", { message: "Cloud run is ready." }, prepared.machine);
      progress({ operationId: request.operationId, message: "Cloud run is ready." });
      return { machine: prepared.machine };
    }
    // A second provider waits for the same machine, then checks its own login.
    if (this.active && (this.activeProvider !== request.provider || this.activeInstance !== currentInstance)) {
      const waiting = { message: "Waiting for the other cloud setup to finish…" };
      this.publish(request, "preparing", waiting);
      progress({ ...waiting, operationId: request.operationId });
      await this.active.catch(() => undefined);
      return this.prepare(request, progress);
    }
    const listener = (snapshot: Omit<CloudRunPreparationProgress, "operationId">): void => {
      this.publish(request, "preparing", snapshot);
      progress({ ...snapshot, operationId: request.operationId });
    };
    this.listeners.add(listener);
    if (this.latest) listener(this.latest);
    if (!this.active) {
      this.activeProvider = request.provider;
      this.activeInstance = currentInstance;
      this.active = this.run(request.provider, currentInstance).catch(error => {
        // Refresh access when retrying the failed provider, without making
        // another member repeat a preparation that already succeeded.
        if (this.prepared && this.prepared.instanceId === currentInstance) this.prepared.retryProviders.add(request.provider);
        throw error;
      }).finally(() => {
        this.active = undefined;
        this.activeProvider = undefined;
        this.activeInstance = undefined;
        this.latest = undefined;
      });
    }
    try {
      const result = await this.active;
      this.publish(request, "ready", { message: "Cloud run is ready." }, result.machine);
      return result;
    } catch (error) {
      this.publish(request, "error", { message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    finally { this.listeners.delete(listener); }
  }

  private report(snapshot: Omit<CloudRunPreparationProgress, "operationId">): void {
    this.latest = snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }

  private async reusableMachine(instanceId?: string): Promise<PreparedMachine | undefined> {
    const prepared = this.prepared;
    if (!prepared || prepared.instanceId !== instanceId || !this.options.isConnected(prepared.machine.id)) return;
    const [machines, installs] = await Promise.all([this.options.listMachines(), this.options.listInstalls()]);
    const machine = machines.find(item => item.id === prepared.machine.id);
    const record = installs.find(item => item.machineId === prepared.machine.id);
    if (!machine || !record || !this.options.isConnected(machine.id) || machine.lastHello?.appVersion !== this.options.appVersion
      || preparationIdentity(machine, record) !== prepared.identity) return;
    return { ...prepared, machine, record };
  }

  private remember(instanceId: string, machine: MachineRecord, record: MachineInstallRecord,
    worker: CloudRunWorkerSettings): PreparedMachine {
    const identity = preparationIdentity(machine, record);
    const providers = new Set(this.prepared?.identity === identity ? this.prepared.providers : undefined);
    return this.prepared = { instanceId, machine, record, worker, identity, providers, retryProviders: new Set() };
  }

  private async run(provider: PrepareCloudRunRequest["provider"], expectedInstanceId?: string): Promise<PrepareCloudRunResult> {
    const prepared = await this.reusableMachine(expectedInstanceId);
    if (prepared && !prepared.retryProviders.has(provider)) {
      if (!prepared.providers.has(provider)) {
        await this.options.prepareProvider(prepared.worker, provider, prepared.record, snapshot => this.report(snapshot));
        prepared.providers.add(provider);
      }
      return { machine: prepared.machine };
    }
    this.report({ message: "Checking your AWS instance…" });
    const status = await this.options.aws.status();
    if (!status.handle || !status.configured || status.state !== "running") {
      throw new Error(status.message || "Start your AWS instance in Settings → General → AWS, then select Cloud run again.");
    }
    const instanceId = status.handle.instanceId;
    if (expectedInstanceId && instanceId !== expectedInstanceId) {
      throw new Error("This machine belongs to a different AWS instance. Select Cloud run to use the instance currently shown in Settings.");
    }
    const machines = await this.options.listMachines();
    const installs = await this.options.listInstalls();
    const installed = installs.find(item => item.target.hostKeyAlias === `accordagents-${instanceId}`);
    let machine = machines.find(item => item.awsInstanceId === instanceId)
      ?? machines.find(item => item.id === installed?.machineId);
    this.report({ message: "Connecting to your AWS instance…" });
    const worker = await this.options.aws.ensureExistingWorkerForRun(instanceId);
    if (!worker.host) throw new Error("AWS did not return an address for this instance.");
    const existing = installs.find(item => item.machineId === machine?.id);
    if (machine && existing?.installRoot && this.options.isConnected(machine.id) && machine.lastHello?.appVersion === this.options.appVersion) {
      // Selecting another member must never drain an already running machine.
      await this.options.prepareMachine(worker, existing);
      await this.options.prepareProvider(worker, provider, existing, snapshot => this.report(snapshot));
      this.remember(instanceId, machine, existing, worker).providers.add(provider);
      this.report({ message: "Cloud run is ready." });
      return { machine };
    }
    if (machine?.lastHello?.activeRunIds?.length || machine?.pendingRuns?.length) {
      throw new Error("The cloud runtime needs an update. Finish its current runs, then select Cloud run again.");
    }
    machine ??= await this.options.createMachine("Cloud run", instanceId);
    // The AWS instance is shared, its enrollment, data and CLI home are not.
    // Keep legacy paths on the desktop that already owns them so its provider
    // sessions and participant-created worktrees are never moved or discarded.
    const environmentId = await this.options.environmentId();
    const directory = cloudEnvironmentDirectory(environmentId);
    const established = existing?.installRoot ? existing : undefined;
    const result = await this.options.install({
      machineId: machine.id, operationId: randomUUID(), requiredProvider: provider,
      installRoot: established?.installRoot || `~/${directory}`,
      userDataDir: established?.userDataDir || undefined,
      serviceName: established?.serviceName || undefined,
      isolatedProfile: established ? established.isolatedProfile ?? Boolean(established.profileHome) : true,
      target: { host: worker.host, user: worker.user, port: worker.port, identityFile: worker.identityFile, hostKeyAlias: worker.hostKeyAlias }
    }, snapshot => this.report({ message: snapshot.error || snapshot.message, authUrl: snapshot.authUrl, authCode: snapshot.authCode,
      authProvider: snapshot.authProvider, authRequestId: snapshot.authRequestId }));
    if (result.snapshot.phase !== "ready") {
      throw new Error(result.snapshot.error || result.snapshot.message || "Cloud setup did not finish. Select Cloud run to retry.");
    }
    this.report({ message: "Cloud run is ready." });
    const restored = (await this.options.listMachines()).find(item => item.id === result.record.machineId);
    if (!restored) throw new Error("The cloud machine was removed during setup. Select Cloud run again.");
    this.remember(instanceId, restored, result.record, worker).providers.add(provider);
    return { machine: restored };
  }
}

import { createHash, randomUUID } from "node:crypto";
import type { AwsWorkerStatus, CloudRunWorkerSettings } from "../../shared/types";
import type { MachineRecord } from "../../shared/machineLink";
import type { MachineInstallRecord, MachineInstallRequest, MachineInstallResult, MachineInstallSnapshot, MachineMirrorBootstrapResult } from "../../shared/machineInstall";
import type { CloudRunPreparationProgress, PrepareCloudRunRequest, PrepareCloudRunResult } from "../../shared/cloudRunPreparation";

interface Options {
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
  bootstrapProject(machineId: string, localPath: string): Promise<MachineMirrorBootstrapResult>;
  saveInstall(record: MachineInstallRecord): Promise<void>;
  prepareProvider(worker: CloudRunWorkerSettings, provider: PrepareCloudRunRequest["provider"], record: MachineInstallRecord,
    progress: (snapshot: Omit<CloudRunPreparationProgress, "operationId">) => void): Promise<void>;
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

  constructor(private readonly options: Options) {}

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

  /** Called only when creating a chat or choosing/adding its machine member.
   * No SSH or copying belongs in the subsequent message/stream path. */
  async prepareProject(machineId: string, localPath: string): Promise<void> {
    const previous = this.projectTasks.get(machineId) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(async () => {
      const index = await this.projectIndex();
      if (index.get(machineId)?.[localPath]) return;
      const records = await this.options.listInstalls();
      const record = records.find(item => item.machineId === machineId);
      if (!record) return; // Manually enrolled machines keep their own path.
      const result = await this.options.bootstrapProject(machineId, localPath);
      // A dirty checkout is already the machine's working copy. Keep every
      // change and worktree, and run there; never copy over it to make it clean.
      if (!["clean", "dirty", "directory"].includes(result.inspection.state) || !result.inspection.path.startsWith("/")) {
        throw new Error(result.message || "The cloud project could not be prepared.");
      }
      const current = (await this.options.listInstalls()).find(item => item.machineId === machineId);
      if (!current) throw new Error("The machine was removed during project setup.");
      const projects = { ...current.projects, [localPath]: result.inspection.path };
      await this.options.saveInstall({ ...current, projects });
      index.set(machineId, projects);
    });
    this.projectTasks.set(machineId, task);
    try { await task; }
    finally { if (this.projectTasks.get(machineId) === task) this.projectTasks.delete(machineId); }
  }

  async prepare(request: PrepareCloudRunRequest, progress: (snapshot: CloudRunPreparationProgress) => void): Promise<PrepareCloudRunResult> {
    if (typeof request?.operationId !== "string" || !request.operationId.trim() || (request.provider !== "codex-cli" && request.provider !== "claude-code")) {
      throw new Error("Choose a supported provider before preparing Cloud run.");
    }
    // A second provider waits for the same machine, then checks its own login.
    if (this.active && (this.activeProvider !== request.provider || this.activeInstance !== request.instanceId)) {
      await this.active.catch(() => undefined);
      return this.prepare(request, progress);
    }
    const listener = (snapshot: Omit<CloudRunPreparationProgress, "operationId">): void => progress({ ...snapshot, operationId: request.operationId });
    this.listeners.add(listener);
    if (this.latest) listener(this.latest);
    if (!this.active) {
      this.activeProvider = request.provider;
      this.activeInstance = request.instanceId;
      this.active = this.run(request.provider, request.instanceId).finally(() => {
        this.active = undefined;
        this.activeProvider = undefined;
        this.activeInstance = undefined;
        this.latest = undefined;
      });
    }
    try { return await this.active; }
    finally { this.listeners.delete(listener); }
  }

  private report(snapshot: Omit<CloudRunPreparationProgress, "operationId">): void {
    this.latest = snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }

  private async run(provider: PrepareCloudRunRequest["provider"], expectedInstanceId?: string): Promise<PrepareCloudRunResult> {
    this.report({ message: "Checking your AWS instance…" });
    const status = await this.options.aws.status();
    if (!status.handle || !status.configured || status.state !== "running") {
      throw new Error(status.message || "Start your AWS instance in Settings → General → Machine instance (AWS), then select Cloud run again.");
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
      await this.options.prepareProvider(worker, provider, existing, snapshot => this.report(snapshot));
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
    }, snapshot => this.report({ message: snapshot.error || snapshot.message, authUrl: snapshot.authUrl, authCode: snapshot.authCode }));
    if (result.snapshot.phase !== "ready") {
      throw new Error(result.snapshot.error || result.snapshot.message || "Cloud setup did not finish. Select Cloud run to retry.");
    }
    this.report({ message: "Cloud run is ready." });
    return { machine: (await this.options.listMachines()).find(item => item.id === machine!.id) ?? machine };
  }
}

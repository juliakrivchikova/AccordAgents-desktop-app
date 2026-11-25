import { runCommand } from "../command";
import { defaultRemoteMirrorSync } from "../remoteMirrorSync";
import type { RemoteMirrorSyncRunner } from "../remoteMirrorSync";
import type { RemoteRunWorkerTarget } from "../remoteWorkerTarget";
import {
  buildPortableAgentSetupBundle, portableInvocationFromBundle, portableInvocationFromPrepared, portableInvocationSourceStats,
  preparePortableAgentSetupInvocation, resolvePortableAgentSetupRoots
} from "./bundle";
import { PORTABLE_AGENT_SETUP_VERSION, PORTABLE_SETUP_SYNC_TIMEOUT_MS } from "./constants";
import { computePortableAgentSetupSourceFingerprint } from "./fingerprint";
import { activateRemotePortableSetup, readRemoteSetupState, resolvePortableSetupRoot } from "./remoteState";
import type {
  DefaultRemoteAgentSetupSyncOptions, PortableAgentSetupInvocation, PortableAgentSetupPreparedInvocation, PortableAgentSetupRoots,
  PortableCommandRunner, RemoteAgentSetupSyncRequest, RemoteAgentSetupSyncRunner
} from "./types";

export class DefaultRemoteAgentSetupSync implements RemoteAgentSetupSyncRunner {
  private readonly mirrorSync: RemoteMirrorSyncRunner;
  private readonly commandRunner: PortableCommandRunner;
  private readonly chainByWorker = new Map<string, Promise<PortableAgentSetupInvocation>>();
  private readonly setupRootByWorker = new Map<string, string>();
  private readonly preparedInvocationByRoots = new Map<string, {
    sourceStats: string;
    invocation: PortableAgentSetupPreparedInvocation;
  }>();

  constructor(private readonly options: DefaultRemoteAgentSetupSyncOptions = {}) {
    this.mirrorSync = options.mirrorSync ?? defaultRemoteMirrorSync;
    this.commandRunner = options.commandRunner ?? runCommand;
  }

  sync(request: RemoteAgentSetupSyncRequest): Promise<PortableAgentSetupInvocation> {
    const workerKey = portableSetupWorkerKey(request.worker);
    const previous = this.chainByWorker.get(workerKey) ?? Promise.resolve({ fingerprint: "" });
    const next = previous
      .catch(() => ({ fingerprint: "" }))
      .then(() => this.syncWorker(workerKey, request));
    this.chainByWorker.set(workerKey, next);
    void next.finally(() => {
      if (this.chainByWorker.get(workerKey) === next) {
        this.chainByWorker.delete(workerKey);
      }
    }).catch(() => undefined);
    return next;
  }

  private async syncWorker(
    workerKey: string,
    request: RemoteAgentSetupSyncRequest
  ): Promise<PortableAgentSetupInvocation> {
    const roots = resolvePortableAgentSetupRoots(this.options, request.sourceEnvironment);
    const preparedInvocation = await this.prepareInvocation(roots, request.signal);
    const sourceFingerprint = await computePortableAgentSetupSourceFingerprint(
      roots,
      request.signal,
      preparedInvocation
    );
    const startedAt = Date.now();
    let setupRoot = this.setupRootByWorker.get(workerKey);
    if (!setupRoot) {
      setupRoot = await resolvePortableSetupRoot(request.worker, request.signal, this.commandRunner);
      this.setupRootByWorker.set(workerKey, setupRoot);
    }
    const remote = await readRemoteSetupState(
      request.worker,
      setupRoot,
      request.signal,
      this.commandRunner
    );
    if (
      remote.state?.sourceFingerprint === sourceFingerprint &&
      typeof remote.state.fingerprint === "string" &&
      remote.manifest?.version === PORTABLE_AGENT_SETUP_VERSION &&
      remote.manifest.fingerprint === remote.state.fingerprint &&
      remote.manifest.sourceFingerprint === sourceFingerprint
    ) {
      const invocation = portableInvocationFromPrepared(
        remote.state.fingerprint,
        preparedInvocation,
        remote.manifest
      );
      this.options.logger?.("remote-agent-setup.sync", {
        changed: false,
        durationMs: Date.now() - startedAt,
        fileCount: remote.manifest.fileCount,
        totalBytes: remote.manifest.totalBytes
      });
      return invocation;
    }
    const bundle = await buildPortableAgentSetupBundle({
      homeDir: roots.homeDir,
      codexHomeDir: roots.codexHomeDir,
      claudeConfigDir: roots.claudeConfigDir,
      geminiConfigDir: roots.geminiConfigDir,
      tempDir: this.options.tempDir,
      signal: request.signal,
      sourceFingerprint,
      preparedInvocation
    });
    const invocation = portableInvocationFromBundle(bundle);
    try {
      // Provider homes are deliberately shared, just like the user's local
      // global skill directories: an edit becomes visible to an in-flight CLI
      // when that CLI next reads SKILL.md rather than being frozen per run.
      const remoteBundlePath = `${setupRoot}/bundles/${bundle.fingerprint}`;
      const remoteStatePath = `${setupRoot}/state.json`;
      const bundleCurrent = remote.manifest?.version === PORTABLE_AGENT_SETUP_VERSION &&
        remote.manifest.fingerprint === bundle.fingerprint;
      if (!bundleCurrent) {
        await this.mirrorSync.syncUp({
          worker: request.worker,
          localPath: bundle.localPath,
          remotePath: remoteBundlePath,
          signal: request.signal,
          timeoutMs: PORTABLE_SETUP_SYNC_TIMEOUT_MS,
          contentMode: "exact"
        });
      }
      if (!bundleCurrent || remote.state?.fingerprint !== bundle.fingerprint) {
        await activateRemotePortableSetup(
          request.worker,
          remoteBundlePath,
          remoteStatePath,
          request.signal,
          this.commandRunner
        );
      }
      this.options.logger?.("remote-agent-setup.sync", {
        changed: !bundleCurrent,
        durationMs: Date.now() - startedAt,
        fileCount: bundle.manifest.fileCount,
        totalBytes: bundle.manifest.totalBytes
      });
      return invocation;
    } finally {
      await bundle.cleanup();
    }
  }

  private async prepareInvocation(
    roots: PortableAgentSetupRoots,
    signal?: AbortSignal
  ): Promise<PortableAgentSetupPreparedInvocation> {
    const rootsKey = JSON.stringify({
      codexHomeDir: roots.codexHomeDir,
      homeDir: roots.homeDir
    });
    const sourceStats = await portableInvocationSourceStats(roots, signal);
    const cached = this.preparedInvocationByRoots.get(rootsKey);
    if (cached?.sourceStats === sourceStats) {
      return cached.invocation;
    }
    const invocation = await preparePortableAgentSetupInvocation(roots, signal);
    this.preparedInvocationByRoots.set(rootsKey, { sourceStats, invocation });
    if (this.preparedInvocationByRoots.size > 8) {
      const oldest = this.preparedInvocationByRoots.keys().next().value as string | undefined;
      if (oldest && oldest !== rootsKey) {
        this.preparedInvocationByRoots.delete(oldest);
      }
    }
    return invocation;
  }
}

function portableSetupWorkerKey(worker: RemoteRunWorkerTarget): string {
  return JSON.stringify({
    host: worker.hostKeyAlias?.trim() || worker.host,
    user: worker.user,
    port: worker.port,
    identityFile: worker.identityFile,
    sshPath: worker.sshPath,
    workerRoot: worker.workerRoot,
    profileHome: worker.profileHome
  });
}

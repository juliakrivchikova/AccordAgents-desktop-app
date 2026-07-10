import type { CloudRunStatus, CloudRunWorkerSettings, RemoteRunHandle } from "../../shared/types";
import type { ChatService } from "./chat";
import { cloudRunWorkerTargetFromSettings } from "./cloudRunWorkers";
import type { DebugLogService } from "./debugLogs";
import type { RemoteDetachedRunState, RemoteRunService, RemoteRunWorkerTarget } from "./remoteRuns";
import type { SettingsService } from "./settings";

export class RemoteRunCoordinator {
  private readonly handles = new Map<string, RemoteRunHandle>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly inFlight = new Set<string>();
  private started = false;

  constructor(
    private readonly remoteRuns: RemoteRunService,
    private readonly chat: ChatService,
    private readonly settings: SettingsService,
    private readonly debugLogs: DebugLogService
  ) {}

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    const handles = await this.chat.listActiveRemoteRunHandles();
    for (const handle of handles) {
      this.trackRun(handle);
    }
    await this.reconcileParticipantSessions(handles);
  }

  async shutdownIdleSessions(): Promise<void> {
    this.started = false;
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    const sessions = await this.chat.listRemoteParticipantSessionHandles();
    await Promise.allSettled(sessions.map(async ({ handle }) => {
      await this.remoteRuns.stopParticipantSessionIfIdle(handle, false);
    }));
  }

  trackRun(handle: RemoteRunHandle): void {
    if (this.isTerminal(handle.status)) {
      this.stopRun(handle.runId);
      return;
    }
    const worker = cloudRunWorkerTargetFromSettings(handle.worker);
    if (!worker) {
      void this.debugLogs.write("remote-run.coordinator.invalid-worker", {
        conversationId: handle.conversationId,
        runId: handle.runId
      });
      return;
    }
    this.handles.set(handle.runId, handle);
    this.remoteRuns.registerDetachedRunContext(handle.runId, worker, {
      conversationId: handle.conversationId,
      participantId: handle.participantId
    });
    this.schedule(handle.runId, 0);
  }

  private schedule(runId: string, delayMs: number): void {
    const current = this.timers.get(runId);
    if (current) {
      clearTimeout(current);
    }
    const timer = setTimeout(() => {
      this.timers.delete(runId);
      void this.poll(runId);
    }, delayMs);
    this.timers.set(runId, timer);
  }

  private async poll(runId: string): Promise<void> {
    if (this.inFlight.has(runId)) {
      return;
    }
    const handle = this.handles.get(runId);
    const worker = handle ? cloudRunWorkerTargetFromSettings(handle.worker) : undefined;
    if (!handle || !worker || this.isTerminal(handle.status)) {
      this.stopRun(runId);
      return;
    }
    this.inFlight.add(runId);
    try {
      if (await this.markExpiredIfNeeded(handle)) {
        return;
      }
      const state = await this.remoteRuns.pollDetachedRun({
        conversationId: handle.conversationId,
        runId,
        worker,
        afterWorkerSeq: handle.workerCursorSeq
      });
      const updated = await this.chat.updateRemoteRunHandleState(handle.conversationId, runId, state);
      if (!updated || this.isTerminal(updated.status)) {
        this.stopRun(runId);
        return;
      }
      this.handles.set(runId, updated);
      this.schedule(runId, await this.pollIntervalMs());
    } catch (error) {
      await this.debugLogs.write("remote-run.coordinator.poll.error", {
        conversationId: handle.conversationId,
        runId,
        message: error instanceof Error ? error.message : String(error)
      });
      if (await this.markExpiredIfNeeded(handle)) {
        return;
      }
      this.schedule(runId, await this.pollIntervalMs());
    } finally {
      this.inFlight.delete(runId);
    }
  }

  // Stop polling a run the app has terminalized out-of-band (e.g. a user
  // cancel that could not be delivered to an unreachable worker). Without this
  // the coordinator keeps SSH-polling a dead run forever.
  stopTracking(runId: string): void {
    this.stopRun(runId);
  }

  private stopRun(runId: string): void {
    const timer = this.timers.get(runId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(runId);
    }
    this.handles.delete(runId);
    this.inFlight.delete(runId);
  }

  private async pollIntervalMs(): Promise<number> {
    const settings = await this.settings.getPublicSettings();
    return settings.cloudRuns.pollIntervalMs;
  }

  private async reconcileParticipantSessions(activeRunHandles: readonly RemoteRunHandle[]): Promise<void> {
    const activeRunIds = new Set(activeRunHandles.map((handle) => handle.runId));
    const sessions = await this.chat.listRemoteParticipantSessionHandles();
    const persistedSessionDirs = new Set(sessions.map((session) => session.handle.sessionDir));
    for (const session of sessions) {
      try {
        const state = await this.remoteRuns.inspectParticipantSession(session.handle);
        if (state.providerSessionId) {
          await this.chat.backfillRemoteParticipantSessionId(
            session.conversationId,
            session.participantId,
            state.providerSessionId,
            state.providerSessionValid !== false
          );
        }
        if (state.activeRunId) {
          if (!activeRunIds.has(state.activeRunId)) {
            await this.debugLogs.write("remote-session.reconcile.unknown-active", {
              conversationId: session.conversationId,
              participantId: session.participantId,
              runId: state.activeRunId
            });
          }
          continue;
        }
        if (state.status === "live") {
          await this.remoteRuns.stopParticipantSessionIfIdle(session.handle, false);
        }
      } catch (error) {
        await this.debugLogs.write("remote-session.reconcile.error", {
          conversationId: session.conversationId,
          participantId: session.participantId,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }

    const workers = new Map<string, RemoteRunWorkerTarget>();
    const rememberWorker = (settings: CloudRunWorkerSettings): void => {
      const worker = cloudRunWorkerTargetFromSettings(settings);
      if (!worker) {
        return;
      }
      const key = JSON.stringify([
        worker.host,
        worker.user,
        worker.port,
        worker.identityFile,
        worker.workerRoot
      ]);
      workers.set(key, worker);
    };
    for (const handle of activeRunHandles) {
      rememberWorker(handle.worker);
    }
    for (const session of sessions) {
      rememberWorker(session.handle.worker);
    }
    for (const tombstone of await this.settings.listRemoteSessionCleanupTombstones()) {
      rememberWorker(tombstone.handle.worker);
    }
    for (const worker of workers.values()) {
      try {
        const discovered = await this.remoteRuns.listParticipantSessions(worker);
        for (const session of discovered) {
          if (persistedSessionDirs.has(session.handle.sessionDir)) {
            continue;
          }
          if (session.activeRunId || session.hasQueuedTurns || (session.queuedRunIds?.length ?? 0) > 0) {
            await this.debugLogs.write("remote-session.reconcile.unknown-active", {
              conversationId: session.conversationId,
              participantId: session.participantId,
              runId: session.activeRunId,
              sessionDir: session.handle.sessionDir
            });
            continue;
          }
          await this.debugLogs.write("remote-session.reconcile.unknown-idle-preserved", {
            conversationId: session.conversationId,
            participantId: session.participantId,
            sessionDir: session.handle.sessionDir
          });
        }
      } catch (error) {
        await this.debugLogs.write("remote-session.reconcile.list.error", {
          workerHost: worker.host,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }

    await this.drainRemoteSessionCleanup();
  }

  async drainRemoteSessionCleanup(workerOverride?: CloudRunWorkerSettings): Promise<void> {
    const tombstones = await this.settings.listRemoteSessionCleanupTombstones();
    for (const tombstone of tombstones) {
      try {
        const handle = workerOverride && this.isSameWorkerIdentity(tombstone.handle.worker, workerOverride)
          ? { ...tombstone.handle, worker: workerOverride, updatedAt: new Date().toISOString() }
          : tombstone.handle;
        const state = await this.remoteRuns.inspectParticipantSession(handle);
        if (state.activeRunId || (state.queuedRunIds?.length ?? 0) > 0) {
          continue;
        }
        if (await this.remoteRuns.stopParticipantSessionIfIdle(handle, true, {
          removeArtifacts: tombstone.removeArtifacts === true,
          runIds: tombstone.runIds,
          providerSessionIds: tombstone.providerSessionIds
        })) {
          await this.settings.removeRemoteSessionCleanupTombstone(tombstone.id);
        }
      } catch (error) {
        await this.debugLogs.write("remote-session.tombstone.retry.error", {
          tombstoneId: tombstone.id,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  private isSameWorkerIdentity(left: CloudRunWorkerSettings, right: CloudRunWorkerSettings): boolean {
    const leftIdentity = left.identityFile?.trim() || "";
    const rightIdentity = right.identityFile?.trim() || "";
    if (!leftIdentity || !rightIdentity || leftIdentity !== rightIdentity) {
      return false;
    }
    return (left.user?.trim() || "") === (right.user?.trim() || "") &&
      (left.workerRoot?.trim() || "") === (right.workerRoot?.trim() || "");
  }

  private async markExpiredIfNeeded(handle: RemoteRunHandle): Promise<boolean> {
    const state = await this.expiredFailureState(handle);
    if (!state) {
      return false;
    }
    await this.chat.updateRemoteRunHandleState(handle.conversationId, handle.runId, state);
    await this.debugLogs.write("remote-run.coordinator.deadline.failed", {
      conversationId: handle.conversationId,
      runId: handle.runId,
      error: state.error
    });
    this.stopRun(handle.runId);
    return true;
  }

  private async expiredFailureState(handle: RemoteRunHandle): Promise<RemoteDetachedRunState | undefined> {
    const startedAtMs = Date.parse(handle.startedAt);
    if (!Number.isFinite(startedAtMs)) {
      return undefined;
    }
    const settings = await this.settings.getPublicSettings();
    const maxRuntimeMs = Math.max(1, Math.floor(settings.cloudRuns.maxRuntimeMs));
    if (Date.now() - startedAtMs < maxRuntimeMs) {
      return undefined;
    }
    const completedAt = new Date().toISOString();
    return {
      runId: handle.runId,
      conversationId: handle.conversationId,
      participantId: handle.participantId,
      status: "failed",
      completedAt,
      error: `Remote run exceeded max runtime of ${maxRuntimeMs}ms without terminal state.`
    };
  }

  private isTerminal(status: CloudRunStatus): boolean {
    return status === "completed" || status === "failed" || status === "cancelled";
  }
}

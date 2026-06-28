import type { CloudRunStatus, RemoteRunHandle } from "../../shared/types";
import type { ChatService } from "./chat";
import { cloudRunWorkerTargetFromSettings } from "./cloudRunWorkers";
import type { DebugLogService } from "./debugLogs";
import type { RemoteDetachedRunState, RemoteRunService } from "./remoteRuns";
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

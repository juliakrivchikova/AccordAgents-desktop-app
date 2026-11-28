import { randomUUID } from "node:crypto";
import type { ChatMessage, Conversation } from "../../../../shared/types";
import { readActiveRunIds } from "../../../../shared/chatRunState";
import { chatParticipants } from "../members/identity";
import { isPendingMessageForInterruptedParticipantRequest } from "../requests/requestRecords";
import { markInterruptedForRecovery } from "./interruptions";
import { chatRunOwners, metadataWithInterruptedRunWarning, processAppearsAlive, runOwnerHeartbeatFresh } from "./runOwnerRecords";
import type { ChatRunOwner } from "./types";
import { executionLeaseForRun, heartbeatParticipantExecutorLease } from "../sessions/leaseRecords";
import { stableJson } from "../store/messages";
import { metadataWithoutAutoTitleEligibility } from "../store/titles";
import type { ChatModules } from "../modules";
import type { ChatDependencies } from "../dependencies";

const CHAT_RUN_OWNER_HEARTBEAT_MS = 15_000;

/** Which app process owns a chat's run, and chats whose run was left by one that ended. */
export class RunOwners {
  private readonly appInstanceId = randomUUID();
  private runOwnerHeartbeatTimer?: NodeJS.Timeout;

  constructor(
    private readonly chat: Pick<ChatModules, "activeRuns" | "host" | "requestRecovery" | "runCancel" | "store">,
    private readonly deps: Pick<ChatDependencies, "debugLogs" | "onInterruptedRunsRecovered" | "storage">
  ) {}

  recoverStaleChatRun(conversation: Conversation): boolean {
    const activeIds = readActiveRunIds(conversation.metadata);
    const stillActive = activeIds.some((id) => this.chat.activeRuns.activeRunIds.has(id));
    const liveWork = this.chat.activeRuns.chatHasLiveWork(conversation.id);
    if (stillActive) {
      return false;
    }
    if (liveWork) {
      return false;
    }
    const interruptedRequests = this.chat.requestRecovery.markOrphanedParticipantRequestsInterrupted(conversation, {
      ignoreLocalRequestLocks: true
    });
    const wasRunning = conversation.metadata.running === true || activeIds.length > 0;
    const sweptMessages: ChatMessage[] = [];
    let pendingSwept = false;
    let hasLivePending = false;
    for (const message of conversation.messages) {
      if (message.status === "pending" && message.role === "participant") {
        if (this.isMessageRunLive(message)) {
          // A late-finishing run still owns this bubble; leave it pending so the
          // completed answer can replace it rather than be lost behind a sweep.
          hasLivePending = true;
          continue;
        }
        if (
          this.isMessageRunProtectedByExternalOwner(conversation, message) &&
          !isPendingMessageForInterruptedParticipantRequest(conversation, message)
        ) {
          continue;
        }
        markInterruptedForRecovery(message);
        sweptMessages.push(message);
        pendingSwept = true;
      }
    }
    // Only clear run metadata / flag an interrupt when the run is genuinely done.
    // If any pending bubble is still backed by a live run owned by this process,
    // leave run metadata intact so we don't recreate the "live run looks
    // interrupted/idle" state. Protected external/remote runs are safe to
    // preserve through metadataWithLiveRunState while stale local ids are removed.
    const shouldRefreshRunMetadata = wasRunning && !hasLivePending;
    let refreshedRunMetadata = false;
    if (shouldRefreshRunMetadata) {
      const nextMetadata = this.chat.activeRuns.metadataWithLiveRunState(conversation.id, conversation.metadata);
      if (stableJson(nextMetadata) !== stableJson(conversation.metadata)) {
        conversation.metadata = nextMetadata;
        refreshedRunMetadata = true;
      }
    }
    if (!interruptedRequests && !pendingSwept && !refreshedRunMetadata) {
      return false;
    }
    if (pendingSwept) {
      conversation.metadata = metadataWithInterruptedRunWarning(conversation.metadata);
      // Told once, on the recovery that produced them.
      this.deps.onInterruptedRunsRecovered?.(conversation, sweptMessages);
    }
    if (refreshedRunMetadata) {
      conversation.metadata = metadataWithoutAutoTitleEligibility(conversation.metadata);
    }
    conversation.updatedAt = new Date().toISOString();
    return true;
  }

  private isMessageRunLive(message: ChatMessage): boolean {
    const runId = message.metadata?.runId;
    if (typeof runId !== "string" || !runId) {
      return false;
    }
    return this.chat.activeRuns.activeRunIds.has(runId) || this.chat.activeRuns.chatRunControllers.has(runId) || this.chat.activeRuns.chatRunMeta.has(runId);
  }

  isMessageRunProtectedByExternalOwner(conversation: Conversation, message: ChatMessage): boolean {
    const runId = message.metadata?.runId;
    if (typeof runId !== "string" || !runId) {
      return false;
    }
    // Machines transport: a member whose home is another machine runs
    // there, and that machine owns every outcome of its runs (including
    // runs it started itself, such as a resume after an approval, which
    // this instance never registered). Such bubbles are never swept here;
    // the machine's result, or its answer to a query, finishes them. Inside
    // a machine runtime its own members are local and are swept as usual.
    if (!message.metadata?.cloudRunPreparation && message.participantId && chatParticipants(conversation).some((participant) =>
      participant.id === message.participantId && !this.chat.host.ownsParticipant(participant) && !(participant.cloudRun && !participant.homeMachineId)
    )) {
      return true;
    }
    const state = this.localRunOwnerState(conversation.metadata, runId);
    return state === "external-live";
  }

  storedMetadataHasProtectedLiveRuns(metadata: Record<string, unknown>): boolean {
    return readActiveRunIds(metadata).some((runId) => this.localRunOwnerState(metadata, runId) === "external-live");
  }

  localRunOwnerState(metadata: Record<string, unknown>, runId: string): "current" | "external-live" | "external-dead" | "unknown" {
    if (this.chat.activeRuns.activeRunIds.has(runId) || this.chat.activeRuns.chatRunControllers.has(runId) || this.chat.activeRuns.chatRunMeta.has(runId)) {
      return "current";
    }
    const owner = chatRunOwners(metadata)[runId];
    if (!owner) {
      return "unknown";
    }
    if (owner.processId === process.pid) {
      return "external-dead";
    }
    if (!owner.instanceId || !runOwnerHeartbeatFresh(owner)) {
      return "external-dead";
    }
    return processAppearsAlive(owner.processId) ? "external-live" : "external-dead";
  }

  currentRunOwner(existing: ChatRunOwner | undefined, now: string): ChatRunOwner {
    return {
      processId: process.pid,
      instanceId: this.appInstanceId,
      startedAt: existing?.instanceId === this.appInstanceId ? existing.startedAt : now,
      updatedAt: now
    };
  }

  ensureRunOwnerHeartbeatTimer(): void {
    if (this.runOwnerHeartbeatTimer) {
      return;
    }
    this.runOwnerHeartbeatTimer = setInterval(() => {
      void this.heartbeatActiveRunOwners().catch((error) => {
        void this.deps.debugLogs.write("chat.run-owner-heartbeat.error", {
          message: error instanceof Error ? error.message : String(error)
        });
      });
      void this.consumeCrossInstanceCancelRequests().catch((error) => {
        void this.deps.debugLogs.write("chat.cancel.cross-instance-consume.error", {
          message: error instanceof Error ? error.message : String(error)
        });
      });
    }, CHAT_RUN_OWNER_HEARTBEAT_MS);
    this.runOwnerHeartbeatTimer.unref();
  }

  clearRunOwnerHeartbeatTimer(): void {
    if (!this.runOwnerHeartbeatTimer) {
      return;
    }
    clearInterval(this.runOwnerHeartbeatTimer);
    this.runOwnerHeartbeatTimer = undefined;
  }

  // Honors Stop clicks recorded by other app instances sharing this storage:
  // they cannot abort this instance's in-memory controllers, so they enqueue
  // the run id via StorageService.requestRunCancel and this instance cancels
  // it on the next heartbeat tick.
  private async consumeCrossInstanceCancelRequests(): Promise<void> {
    if (this.chat.activeRuns.activeRunIds.size === 0) {
      return;
    }
    // A run enters activeRunIds (beginChatRun) before its abort controller
    // registers (ensureChatTurnController), and takeRunCancelRequests deletes
    // the rows it returns — consuming a request in that window would drop the
    // Stop permanently. Take only runs cancellable right now; the rest stay
    // queued for the next heartbeat tick.
    const cancellable = Array.from(this.chat.activeRuns.activeRunIds).filter((runId) => this.chat.activeRuns.chatRunControllers.has(runId));
    if (cancellable.length === 0) {
      return;
    }
    const requested = await this.deps.storage.takeRunCancelRequests(cancellable);
    for (const runId of requested) {
      void this.deps.debugLogs.write("chat.cancel.cross-instance-honored", { runId });
      // The User's Stop in another window of the app.
      this.chat.activeRuns.noteUserStop(runId);
      this.chat.runCancel.cancelRun(runId);
    }
  }

  private async heartbeatActiveRunOwners(): Promise<void> {
    const conversationIds = Array.from(this.chat.activeRuns.activeConversationRunIds.keys());
    if (conversationIds.length === 0) {
      return;
    }
    const now = new Date().toISOString();
    for (const conversationId of conversationIds) {
      const runIds = Array.from(this.chat.activeRuns.activeConversationRunIds.get(conversationId) ?? []);
      if (runIds.length === 0) {
        continue;
      }
      const conversation = await this.deps.storage.getConversation(conversationId);
      if (!conversation || conversation.kind !== "chat") {
        continue;
      }
      await this.chat.store.withChatMutation(conversation, async () => {
        for (const runId of runIds) {
          heartbeatParticipantExecutorLease(conversation, executionLeaseForRun(conversation, runId), now);
        }
        // Rebuild instead of patching owners in place: a raced or failed
        // cleanup can leave a finished run id in stored activeRunIds with no
        // owner, which the composer pill then counts forever. The rebuild
        // stamps fresh owners for this instance's live runs and sweeps stored
        // ids that are neither live here, externally owned, nor remote.
        conversation.metadata = this.chat.activeRuns.metadataWithLiveRunState(conversationId, conversation.metadata);
        conversation.updatedAt = now;
        await this.chat.store.saveConversation(conversation);
      });
    }
  }
}

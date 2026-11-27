import type { AgentContextUsage, ChatMessage, Conversation } from "../../../../shared/types";
import {
  readActiveRunIds, readActiveRunParticipants, withParticipantCompactionStarted, withParticipantCompactionsForRunRemoved
} from "../../../../shared/chatRunState";
import { agentContextUsageByParticipant } from "../compaction/contextUsage";
import { ACTIVE_RUN_OWNERS_KEY } from "./constants";
import { chatRunId, chatRunOwners, clearedChatRunMetadata } from "./runOwnerRecords";
import type { ChatRunOwner } from "./types";
import type { ProgressCallback } from "../types";
import type { ChatModules } from "../modules";
import type { ChatDependencies } from "../dependencies";

const ACTIVE_RUN_PARTICIPANTS_KEY = "activeRunParticipantIdsByRunId";

export interface ChatParticipantRun {
  runId: string;
  conversationId: string;
  participantId: string;
  participantHandle: string;
  aborted?: boolean;
}

/** Runs alive in this process: their chats, controllers, ends and waiters. */
export class ActiveRuns {
  private readonly participantRunSettledListeners = new Set<(run: ChatParticipantRun) => Promise<void> | void>();
  private readonly participantRunCompletionWaiters = new Map<string, Set<() => void>>();
  private readonly runQueues = new Map<string, Promise<void>>();
  readonly activeRunIds = new Set<string>();
  readonly activeConversationRunIds = new Map<string, Set<string>>();
  private readonly activeRunRefCounts = new Map<string, number>();
  private readonly activeConversationRunRefCounts = new Map<string, Map<string, number>>();
  private readonly backgroundRunnerCounts = new Map<string, number>();
  readonly chatRunControllers = new Map<string, Set<AbortController>>();
  readonly chatRunMeta = new Map<string, { conversationId: string; participantId: string; participantHandle: string; pendingMessageId?: string }>();
  readonly runProgressCallbacks = new Map<string, ProgressCallback>();
  /** Runs stopped by Send now for the message waiting behind them (RunCancel.sendNow):
   *  their reply ends with what it wrote and the turn goes on in that
   *  message's reply, never as "stopped by user". Until the run unregisters. */
  readonly sentNowRunIds = new Set<string>();
  /** Runs whose CLI has answered (its reply is in, the turn only settles):
   *  a request delivered now cuts none of them (RunCancel.deliverNow). */
  readonly cliReturnedRunIds = new Set<string>();

  constructor(
    private readonly chat: Pick<
      ChatModules,
      | "autoWatch" | "chatPostTools" | "members" | "participantRequests" | "runOwners" | "store" | "titles"
    >,
    private readonly deps: Pick<ChatDependencies, "debugLogs" | "storage">
  ) {}

  /** Runs that only wait for a member to come back from its own requests
   *  (ownRequestWaits.ts), and the member requests whose runner only waits
   *  so now: a restart loses nothing (the wait is armed again at the next
   *  start), so they hold no update, idle stop or restart of the member. */
  readonly waitOnlyRunIds = new Set<string>();
  /** How many waits of each request (one per target that waits). */
  private readonly waitOnlyRequestCounts = new Map<string, number>();

  beginWaitOnly(requestMessageId: string): void {
    this.waitOnlyRequestCounts.set(requestMessageId, (this.waitOnlyRequestCounts.get(requestMessageId) ?? 0) + 1);
  }

  endWaitOnly(requestMessageId: string): void {
    const left = (this.waitOnlyRequestCounts.get(requestMessageId) ?? 1) - 1;
    if (left > 0) this.waitOnlyRequestCounts.set(requestMessageId, left);
    else this.waitOnlyRequestCounts.delete(requestMessageId);
  }

  /** Whether a member's wait on its own requests runs here: a machine
   *  that hosts one stays on (its requester is resumed only from here, and
   *  nothing else wakes the machine for the member's answer). */
  hasWaitOnlyWork(): boolean {
    return this.waitOnlyRunIds.size > 0 || this.waitOnlyRequestCounts.size > 0;
  }

  activeParticipantRuns(): ChatParticipantRun[] {
    return [...this.chatRunMeta.entries()].filter(([runId]) => !this.waitOnlyRunIds.has(runId)).map(([runId, meta]) => ({ runId, ...meta }));
  }

  /** Every run alive here: members' turns and the runs that carry no member
   *  bubble, such as a compaction. Restarting the app kills all of them. */
  liveRunIds(): string[] {
    // A member request still collecting answers counts too: its requester
    // waits for them in the background, and a restart would lose that wait.
    const requestRunners = [...this.chat.participantRequests.participantRequestRunners.keys()]
      .filter((id) => !this.waitOnlyRequestCounts.has(id)).map((id) => `participant-request:${id}`);
    return [...new Set([...this.activeRunIds, ...this.chatRunMeta.keys(), ...requestRunners])].filter((id) => !this.waitOnlyRunIds.has(id));
  }

  onParticipantRunSettled(listener: (run: ChatParticipantRun) => Promise<void> | void): () => void {
    this.participantRunSettledListeners.add(listener);
    return () => { this.participantRunSettledListeners.delete(listener); };
  }

  async settledParticipantRunResult(run: ChatParticipantRun): Promise<{ messages: ChatMessage[]; warnings: string[]; contextUsage?: AgentContextUsage }> {
    // A native resume releases its provider controller before its caller
    // appends the returned messages. endChatRun is the end of that lifecycle.
    if (this.activeRunIds.has(run.runId)) {
      await new Promise<void>((resolve) => {
        const waiters = this.participantRunCompletionWaiters.get(run.runId) ?? new Set<() => void>();
        waiters.add(resolve);
        this.participantRunCompletionWaiters.set(run.runId, waiters);
      });
    }
    if (!(await this.chat.store.waitForQueuedSaveResult(run.conversationId))) {
      throw new Error("The run's final messages could not be stored.");
    }
    const conversation = await this.deps.storage.getConversation(run.conversationId);
    if (!conversation || conversation.kind !== "chat") {
      throw new Error("The run's chat is unavailable.");
    }
    const contextUsage = agentContextUsageByParticipant(conversation)[run.participantId];
    return {
      messages: conversation.messages.filter((message) => message.metadata?.runId === run.runId),
      warnings: Array.isArray(conversation.metadata.warnings) ? conversation.metadata.warnings.filter((warning): warning is string => typeof warning === "string") : [],
      ...(contextUsage ? { contextUsage } : {})
    };
  }

  forgetAllActiveChatRunRefs(conversationId: string, runId: string): void {
    while ((this.activeConversationRunRefCount(conversationId, runId) > 0) || this.activeRunIds.has(runId)) {
      this.forgetActiveChatRun(conversationId, runId);
    }
  }

  firstChatRunController(runId: string): AbortController | undefined {
    const controllers = this.chatRunControllers.get(runId);
    return controllers?.values().next().value;
  }

  /** Which conversation a run belongs to. Live progress carries no conversation
   *  of its own, so whoever forwards it — the phone relay in particular — has to
   *  ask rather than assume: attributing a run to the wrong chat puts one
   *  chat's content inside another. Undefined means "not known here", and the
   *  caller must drop the frame rather than pick a chat. */
  conversationIdForRun(runId: string): string | undefined {
    const targetRunId = runId.trim();
    if (!targetRunId) {
      return undefined;
    }
    const fromMeta = this.chatRunMeta.get(targetRunId)?.conversationId;
    if (fromMeta) {
      return fromMeta;
    }
    for (const [conversationId, runIds] of this.activeConversationRunIds) {
      if (runIds.has(targetRunId)) {
        return conversationId;
      }
    }
    return undefined;
  }

  hasActiveRunForConversation(conversationId: string, runId: string): boolean {
    const targetConversationId = conversationId.trim();
    const targetRunId = runId.trim();
    if (!targetConversationId || !targetRunId) {
      return false;
    }
    if (this.activeConversationRunIds.get(targetConversationId)?.has(targetRunId)) {
      return true;
    }
    if (this.chatRunMeta.get(targetRunId)?.conversationId === targetConversationId) {
      return true;
    }
    return false;
  }

  registerTargetRun(runId: string, controller: AbortController, meta: { conversationId: string; participantId: string; participantHandle: string }): void {
    this.registerRunController(runId, controller);
    this.chatRunMeta.set(runId, { ...meta });
  }

  registerRunController(runId: string, controller: AbortController): void {
    const controllers = this.chatRunControllers.get(runId) ?? new Set<AbortController>();
    controllers.add(controller);
    this.chatRunControllers.set(runId, controllers);
  }

  setTargetRunPendingMessageId(runId: string, messageId: string): void {
    const meta = this.chatRunMeta.get(runId);
    if (meta) {
      this.chatRunMeta.set(runId, { ...meta, pendingMessageId: messageId });
    }
  }

  unregisterTargetRun(runId: string, controller?: AbortController): void {
    const meta = this.chatRunMeta.get(runId);
    const aborted = controller?.signal.aborted ?? this.firstChatRunController(runId)?.signal.aborted;
    if (!this.unregisterRunController(runId, controller)) {
      return;
    }
    this.chatRunMeta.delete(runId);
    this.sentNowRunIds.delete(runId);
    this.cliReturnedRunIds.delete(runId);
    this.chat.chatPostTools.appSendMessageCountsByRun.delete(runId);
    this.chat.chatPostTools.appSendMessageImageBytesByRun.delete(runId);
    if (meta) {
      for (const listener of this.participantRunSettledListeners) {
        try {
          void Promise.resolve(listener({ runId, ...meta, aborted })).catch((error) => {
            void this.deps.debugLogs.write("chat.run.settled-listener.error", { runId, message: error instanceof Error ? error.message : String(error) });
          });
        } catch (error) {
          void this.deps.debugLogs.write("chat.run.settled-listener.error", { runId, message: error instanceof Error ? error.message : String(error) });
        }
      }
    }
  }

  unregisterRunController(runId: string, controller?: AbortController): boolean {
    if (controller) {
      const controllers = this.chatRunControllers.get(runId);
      controllers?.delete(controller);
      if (controllers && controllers.size > 0) {
        return false;
      }
    }
    this.chatRunControllers.delete(runId);
    return true;
  }

  async withChatRunLock<T>(
    conversationId: string,
    run: () => Promise<T>,
    options: { rejectIfQueued?: boolean; queuedMessage?: string } = {}
  ): Promise<T> {
    const previous = this.runQueues.get(conversationId);
    if (previous && options.rejectIfQueued) {
      throw new Error(options.queuedMessage ?? "Chat is busy.");
    }
    const previousRun = previous ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previousRun.catch(() => undefined).then(() => current);
    this.runQueues.set(conversationId, chained);
    await previousRun.catch(() => undefined);
    try {
      return await run();
    } finally {
      release();
      if (this.runQueues.get(conversationId) === chained) {
        this.runQueues.delete(conversationId);
      }
    }
  }

  /** `memberIds`: members this run will start or resume later than its own
   *  start (claimMembersForRun), so they cannot be removed meanwhile. */
  async beginChatRun(conversation: Conversation, runId: string, memberIds?: readonly string[]): Promise<void> {
    this.rememberActiveChatRun(conversation.id, runId);
    this.chat.members.claimMembersForRun(conversation.id, runId, memberIds);
    try {
      await this.chat.store.withChatMutation(conversation, async () => {
        if (conversation.metadata.archived === true) throw new Error("Unarchive the chat before starting a member.");
        conversation.metadata = this.metadataWithLiveRunState(conversation.id, {
          ...conversation.metadata,
          runId
        }, undefined, runId);
        conversation.updatedAt = new Date().toISOString();
        this.chat.store.queueSnapshot(conversation);
      });
    } catch (error) {
      this.forgetActiveChatRun(conversation.id, runId);
      throw error;
    }
  }

  async beginChatParticipantCompactionRun(conversation: Conversation, runId: string, participantId: string): Promise<void> {
    this.rememberActiveChatRun(conversation.id, runId);
    // Busy until the run ends here, whatever another flow's copy of the
    // compaction map says meanwhile.
    this.chat.members.claimMembersForRun(conversation.id, runId, [participantId]);
    try {
      await this.chat.store.withChatMutation(conversation, async () => {
        const now = new Date().toISOString();
        const liveMetadata = this.metadataWithLiveRunState(conversation.id, {
          ...conversation.metadata,
          runId
        }, undefined, runId);
        conversation.metadata = withParticipantCompactionStarted(liveMetadata, participantId, runId, now);
        conversation.updatedAt = now;
        this.chat.store.queueSnapshot(conversation);
      });
    } catch (error) {
      this.forgetActiveChatRun(conversation.id, runId);
      throw error;
    }
  }

  async endChatRun(conversation: Conversation, runId: string): Promise<void> {
    try {
      await this.chat.store.withChatMutation(conversation, async () => {
        conversation.metadata = withParticipantCompactionsForRunRemoved(conversation.metadata, runId);
        if (this.activeConversationRunRefCount(conversation.id, runId) <= 1) {
          const activeRunIds = readActiveRunIds(conversation.metadata);
          const ownsStoredRunState = activeRunIds.includes(runId) || chatRunId(conversation) === runId;
          const ownsLiveRunState = this.activeConversationRunIds.get(conversation.id)?.has(runId) === true;
          if (ownsStoredRunState || ownsLiveRunState) {
            conversation.metadata = this.metadataWithLiveRunState(conversation.id, conversation.metadata, runId);
          }
        }
        conversation.metadata = this.chat.titles.metadataAfterAutoTitleRunTerminal(conversation.id, conversation.metadata, runId);
        conversation.updatedAt = new Date().toISOString();
        this.chat.store.queueSnapshot(conversation);
      });
    } finally {
      {
        this.forgetActiveChatRun(conversation.id, runId);
        if (!this.activeRunIds.has(runId)) {
          const waiters = this.participantRunCompletionWaiters.get(runId);
          this.participantRunCompletionWaiters.delete(runId);
          for (const resolve of waiters ?? []) {
            resolve();
          }
        }
        if (!this.chatHasLiveWork(conversation.id)) {
          this.chat.autoWatch.scheduleAutoWatchEvaluation(conversation.id, "run-idle");
        }
      }
    }
  }

  private hasOtherLiveWork(conversationId: string, excludingRunId: string): boolean {
    const runIds = this.activeConversationRunIds.get(conversationId);
    if (runIds) {
      for (const id of runIds) {
        if (id !== excludingRunId) {
          return true;
        }
      }
    }
    return (this.backgroundRunnerCounts.get(conversationId) ?? 0) > 0;
  }

  metadataWithLiveRunState(
    conversationId: string,
    metadata: Record<string, unknown>,
    excludingRunId?: string,
    preferredRunId?: string
  ): Record<string, unknown> {
    const currentActiveRunIds = Array.from(this.activeConversationRunIds.get(conversationId) ?? [])
      .filter((runId) => runId !== excludingRunId);
    const protectedStoredRunIds = readActiveRunIds(metadata).filter((runId) =>
      runId !== excludingRunId && this.chat.runOwners.localRunOwnerState(metadata, runId) === "external-live"
    );
    const activeRunIds = Array.from(new Set([...protectedStoredRunIds, ...currentActiveRunIds]));
    const baseMetadata = clearedChatRunMetadata(metadata);
    if (activeRunIds.length > 0) {
      const metadataRunId = metadata.runId;
      const currentRunId = typeof metadataRunId === "string" && metadataRunId.trim()
        ? metadataRunId
        : undefined;
      const runId = preferredRunId && activeRunIds.includes(preferredRunId)
        ? preferredRunId
        : currentRunId && activeRunIds.includes(currentRunId)
          ? currentRunId
          : activeRunIds[0];
      let next: Record<string, unknown> = {
        ...baseMetadata,
        running: true,
        runId,
        activeRunIds
      };
      const existingOwners = chatRunOwners(metadata);
      const existingRunParticipants = readActiveRunParticipants(metadata);
      const currentActiveRunIdSet = new Set(currentActiveRunIds);
      const owners: Record<string, ChatRunOwner> = {};
      const runParticipants: Record<string, string> = {};
      for (const activeRunId of activeRunIds) {
        if (currentActiveRunIdSet.has(activeRunId)) {
          owners[activeRunId] = this.chat.runOwners.currentRunOwner(existingOwners[activeRunId], new Date().toISOString());
          const participantId = this.chatRunMeta.get(activeRunId)?.participantId ?? existingRunParticipants.get(activeRunId);
          if (participantId) {
            runParticipants[activeRunId] = participantId;
          }
          continue;
        }
        if (this.chat.runOwners.localRunOwnerState(metadata, activeRunId) === "external-live" && existingOwners[activeRunId]) {
          owners[activeRunId] = existingOwners[activeRunId];
          const participantId = existingRunParticipants.get(activeRunId);
          if (participantId) {
            runParticipants[activeRunId] = participantId;
          }
        }
      }
      if (Object.keys(owners).length > 0) {
        next[ACTIVE_RUN_OWNERS_KEY] = owners;
      }
      if (Object.keys(runParticipants).length > 0) {
        next[ACTIVE_RUN_PARTICIPANTS_KEY] = runParticipants;
      }
      return next;
    }
    if ((this.backgroundRunnerCounts.get(conversationId) ?? 0) > 0) {
      return {
        ...baseMetadata,
        running: true
      };
    }
    return baseMetadata;
  }

  rememberActiveChatRun(conversationId: string, runId: string): void {
    this.chat.runOwners.ensureRunOwnerHeartbeatTimer();
    this.activeRunRefCounts.set(runId, (this.activeRunRefCounts.get(runId) ?? 0) + 1);
    this.activeRunIds.add(runId);
    const runIds = this.activeConversationRunIds.get(conversationId) ?? new Set<string>();
    runIds.add(runId);
    this.activeConversationRunIds.set(conversationId, runIds);
    const runCounts = this.activeConversationRunRefCounts.get(conversationId) ?? new Map<string, number>();
    runCounts.set(runId, (runCounts.get(runId) ?? 0) + 1);
    this.activeConversationRunRefCounts.set(conversationId, runCounts);
  }

  forgetActiveChatRun(conversationId: string, runId: string): void {
    const nextGlobalCount = (this.activeRunRefCounts.get(runId) ?? 0) - 1;
    if (nextGlobalCount > 0) {
      this.activeRunRefCounts.set(runId, nextGlobalCount);
    } else {
      this.activeRunRefCounts.delete(runId);
      this.activeRunIds.delete(runId);
    }
    const runCounts = this.activeConversationRunRefCounts.get(conversationId);
    const nextConversationCount = (runCounts?.get(runId) ?? 0) - 1;
    if (runCounts && nextConversationCount > 0) {
      runCounts.set(runId, nextConversationCount);
      return;
    }
    runCounts?.delete(runId);
    if (runCounts && runCounts.size === 0) {
      this.activeConversationRunRefCounts.delete(conversationId);
    }
    if (this.chat.members.memberWorkClaims.get(runId)?.conversationId === conversationId) {
      this.chat.members.memberWorkClaims.delete(runId);
    }
    const runIds = this.activeConversationRunIds.get(conversationId);
    if (!runIds) {
      if (this.activeRunIds.size === 0) {
        this.chat.runOwners.clearRunOwnerHeartbeatTimer();
      }
      return;
    }
    runIds.delete(runId);
    if (runIds.size === 0) {
      this.activeConversationRunIds.delete(conversationId);
    }
    if (this.activeRunIds.size === 0) {
      this.chat.runOwners.clearRunOwnerHeartbeatTimer();
    }
  }

  private activeConversationRunRefCount(conversationId: string, runId: string): number {
    return this.activeConversationRunRefCounts.get(conversationId)?.get(runId) ?? 0;
  }

  chatHasLiveWork(conversationId: string): boolean {
    return (
      (this.activeConversationRunIds.get(conversationId)?.size ?? 0) > 0 ||
      (this.backgroundRunnerCounts.get(conversationId) ?? 0) > 0
    );
  }

  incrementBackgroundRunner(conversationId: string): void {
    this.backgroundRunnerCounts.set(conversationId, (this.backgroundRunnerCounts.get(conversationId) ?? 0) + 1);
  }

  decrementBackgroundRunner(conversationId: string): void {
    const nextCount = (this.backgroundRunnerCounts.get(conversationId) ?? 0) - 1;
    if (nextCount > 0) {
      this.backgroundRunnerCounts.set(conversationId, nextCount);
      return;
    }
    this.backgroundRunnerCounts.delete(conversationId);
    void this.tryClearRunningIfIdle(conversationId).catch((error) => {
      void this.deps.debugLogs.write("chat.background-runner.clear-idle.error", {
        conversationId,
        message: error instanceof Error ? error.message : String(error)
      });
    });
  }

  private async tryClearRunningIfIdle(conversationId: string): Promise<void> {
    if (this.chatHasLiveWork(conversationId)) {
      return;
    }
    await this.withChatRunLock(conversationId, async () => {
      if (this.chatHasLiveWork(conversationId)) {
        return;
      }
      await this.chat.store.waitForQueuedSave(conversationId);
      const read = (await this.chat.store.readStoredChatStateForRefresh(conversationId)).stored;
      if (!read || read.kind !== "chat" || read.metadata.running !== true) {
        return;
      }
      // On the chat as saved when its turn in the queue comes: a member the
      // User changed since the read above is not written back.
      const conversation: Conversation = { ...read, messages: [], metadata: {} };
      const cleared = await this.chat.store.withSavedChat(conversation, async () => {
        if (this.chatHasLiveWork(conversationId) || conversation.metadata.running !== true) {
          return false;
        }
        conversation.metadata = this.metadataWithLiveRunState(conversation.id, conversation.metadata);
        conversation.updatedAt = new Date().toISOString();
        await this.chat.store.saveConversation(conversation);
        return true;
      });
      if (cleared && !this.chatHasLiveWork(conversationId) && !this.chat.runOwners.storedMetadataHasProtectedLiveRuns(conversation.metadata)) {
        this.chat.autoWatch.scheduleAutoWatchEvaluation(conversationId, "background-runner-idle");
      }
    });
  }

  registerRunProgressCallback(runId: string, progress: ProgressCallback | undefined): () => void {
    if (!progress) {
      return () => undefined;
    }
    this.runProgressCallbacks.set(runId, progress);
    return () => {
      if (this.runProgressCallbacks.get(runId) === progress) {
        this.runProgressCallbacks.delete(runId);
      }
    };
  }
}

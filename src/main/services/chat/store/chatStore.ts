import { buildConversationSnapshot, cloneConversationBody, snapshotRowsBytes, type SnapshotMessageRow } from "../../chatSnapshotDelta";
import { chatChangeBaseline, diffChatChanges, type ChatChangeBaseline } from "../../chatChanges";
import { chatChangesToOps } from "../../chatServerOps";
import type { HubOp } from "../../../../shared/hubOps";
import type { ChatMessage, Conversation } from "../../../../shared/types";
import { recordClosedAccords } from "../../../../shared/accordProgress";
import { sanitizeWarningList, sanitizeWarningText } from "../../../../shared/warnings";
import { withoutAnsweredPlans } from "../approvals/approvalRecords";
import { clearLegacyAccordState } from "../choices/mentions";
import { applyRemovedChatMessageTombstones, mergeStoredChatMessages, mergeStoredChatTitle } from "./mergeStoredChat";
import { mergeStoredChatMetadata } from "./mergeStoredMetadata";
import { addConversationWarning, cloneJsonValue } from "./messages";
import type { ChatModules } from "../modules";
import type { ChatDependencies } from "../dependencies";

const CHAT_CHANGE_BASELINE_LIMIT = 256;

// Tracked chats are bounded by count and by retained serialized bytes; chats
// with a run in flight are evicted last, so a settings sweep over many chats
// does not make the chat the user is working in pay for a full re-emission.
const SNAPSHOT_STATE_LIMIT = 32;

const SNAPSHOT_STATE_BYTES_LIMIT = 256 * 1024 * 1024;

/** The one way a chat is read, changed and saved: mutations in turn, snapshots for the renderer, and the saves' outcomes. */
export class ChatStore {
  readonly saveQueues = new Map<string, Promise<void>>();
  // Serialized message rows of the last snapshot emitted per conversation. The
  // next snapshot reuses the rows of unchanged messages instead of re-parsing
  // every one, tells the renderer which messages changed, and hands storage
  // pre-hashed rows. Bounded to the most recently active chats.
  readonly snapshotRowStates = new Map<string, SnapshotMessageRow[]>();
  /** Per conversation: whether the latest queued save succeeded. */
  private readonly saveOutcomes = new Map<string, Promise<boolean>>();
  // The snapshot this process last persisted per tracked conversation, with the
  // save token that persist returned. While the database row still carries that
  // token, refreshStoredChatState reads this instead of re-reading every
  // message row through the sqlite3 CLI.
  readonly lastSavedSnapshots = new Map<string, { snapshot: Conversation; token: string }>();
  // What the database held after this process's last save of a chat, reduced
  // to what the change diff needs. Loaded from the database when absent (after
  // a restart, an eviction or a failed save), never guessed.
  readonly chatChangeBaselines = new Map<string, ChatChangeBaseline | undefined>();
  private readonly chatSavesInFlight = new Set<Promise<void>>();
  readonly chatMutationQueues = new Map<string, Promise<void>>();
  readonly chatSavedListeners = new Map<string, Set<(conversation: Conversation | undefined) => void>>();

  constructor(
    private readonly chat: Pick<
      ChatModules,
      | "activeRuns" | "claudeModes" | "deletion" | "host" | "requestGrants" | "requestRecovery" | "runOwners"
      | "selfCompaction" | "selfCompactionResumes" | "serverCards" | "serverLink" | "serverPlaceholders" | "serverTurns"
    >,
    private readonly deps: Pick<ChatDependencies, "debugLogs" | "onConversationSnapshot" | "storage">
  ) {}

  /** Saves what a member's tool call recorded on its copy of the chat
   *  through the chat's mutation queue. `apply` runs once the copy has been
   *  refreshed from storage, so a member list or settings the User changed
   *  since the call read the chat are not written back. A change to the
   *  member list itself belongs in `apply`: a member added to the copy before
   *  the refresh would be dropped by it. */
  async saveChatChange<T>(conversation: Conversation, apply: () => Promise<T> | T): Promise<T> {
    return this.withChatMutation(conversation, async () => {
      const result = await apply();
      conversation.updatedAt = new Date().toISOString();
      await this.saveConversation(conversation);
      return result;
    });
  }

  /** For a change the User makes to the members or a member's settings
   *  (withSavedChat): fills `conversation`, inside its mutation, with the chat exactly as saved
   *  at that moment (the refresh a copy read earlier gets would let the copy's
   *  older run state, watchers and the rest win). The messages are the saved
   *  ones, not copies: these changes replace a message they alter, never edit
   *  it in place. */
  withSavedChat<T>(conversation: Conversation, fn: () => Promise<T>): Promise<T> {
    return this.withChatMutation(conversation, async () => {
      await this.loadSavedChat(conversation);
      return fn();
    }, { skipRefresh: true });
  }

  private async loadSavedChat(conversation: Conversation): Promise<void> {
    await this.waitForQueuedSave(conversation.id);
    const stored = (await this.readStoredChatStateForRefresh(conversation.id)).stored;
    if (!stored || stored.kind !== "chat" || !Array.isArray(stored.metadata.participants)) {
      throw new Error("Chat was not found.");
    }
    Object.assign(conversation, stored, {
      metadata: cloneJsonValue(stored.metadata),
      messages: [...stored.messages]
    });
    applyRemovedChatMessageTombstones(conversation);
  }

  async appendConversationWarnings(conversation: Conversation, additions: string[]): Promise<void> {
    if (additions.length === 0) {
      return;
    }
    await this.withChatMutation(conversation, async () => {
      const existing = sanitizeWarningList(conversation.metadata.warnings);
      let mutated = false;
      for (const warning of additions) {
        const sanitized = sanitizeWarningText(warning);
        if (sanitized && !existing.includes(sanitized)) {
          existing.push(sanitized);
          mutated = true;
        }
      }
      if (!mutated) {
        return;
      }
      conversation.metadata = { ...conversation.metadata, warnings: existing };
      conversation.updatedAt = new Date().toISOString();
      this.queueSnapshot(conversation);
    });
  }

  async refreshStoredChatState(conversation: Conversation): Promise<void> {
    const read = await this.readStoredChatStateForRefresh(conversation.id);
    const stored = read.stored;
    if (!stored || stored.kind !== "chat") {
      return;
    }
    // Always merge: the (updatedAt, length) short-circuit was unsound under concurrent
    // sends, where two batches can land at the same length+timestamp with different
    // message ids. The merge is O(n) and id-keyed, so a no-op when storage matches.
    const title = mergeStoredChatTitle(stored, conversation);
    conversation.messages = mergeStoredChatMessages(stored.messages, conversation.messages, read.shared);
    conversation.metadata = mergeStoredChatMetadata(
      stored.metadata,
      conversation.metadata,
      this.chat.requestGrants.requestPermissionGrants.get(conversation),
      this.chat.activeRuns.activeConversationRunIds.get(conversation.id)
    );
    conversation.title = title;
    applyRemovedChatMessageTombstones(conversation);
    this.chat.serverPlaceholders.withoutGoneServerPlaceholders(conversation);
    conversation.updatedAt = stored.updatedAt > conversation.updatedAt ? stored.updatedAt : conversation.updatedAt;
  }

  // While the conversation row still carries the token of this process's last
  // save, storage holds exactly that saved snapshot, so it is read from memory:
  // the body is copied (callers merge into it) and the messages are shared,
  // with `shared` telling the merge to copy anything it adopts. Re-reading
  // every message row of a large chat through the sqlite3 CLI instead took over
  // a second per mutation and blocked the main thread for a third of it.
  async readStoredChatStateForRefresh(
    conversationId: string
  ): Promise<{ stored: Conversation | undefined; shared: boolean }> {
    const lastSaved = this.lastSavedSnapshots.get(conversationId);
    if (lastSaved && await this.deps.storage.isConversationSaveOwned(conversationId, lastSaved.token)) {
      return {
        stored: { ...cloneConversationBody(lastSaved.snapshot), messages: lastSaved.snapshot.messages },
        shared: true
      };
    }
    return { stored: await this.deps.storage.getConversation(conversationId), shared: false };
  }

  async waitForQueuedSave(conversationId: string): Promise<void> {
    await this.saveQueues.get(conversationId)?.catch(() => undefined);
  }

  /** Resolves with whether the latest queued save of this conversation
   *  reached SQLite. A failed write is a false, never an exception. */
  async waitForQueuedSaveResult(conversationId: string): Promise<boolean> {
    const outcome = this.saveOutcomes.get(conversationId);
    if (!outcome) {
      return true;
    }
    return outcome.catch(() => false);
  }

  /** W-G(e)/W-I: pairing-lifecycle warnings surface on the paired
   *  conversation — the one place the user looks when the phone goes quiet.
   *  Callers outside the service (the pairing lifecycle lives in main.ts)
   *  get this narrow door instead of the private internals. */
  async recordConversationWarning(conversationId: string, warning: string): Promise<void> {
    let conversation: Conversation;
    try {
      conversation = await this.requireChat(conversationId);
    } catch {
      return;
    }
    await this.withChatMutation(conversation, async () => {
      addConversationWarning(conversation, warning);
      conversation.updatedAt = new Date().toISOString();
      this.queueSnapshot(conversation);
    });
  }

  async requireChat(conversationId: string): Promise<Conversation> {
    if (this.chat.deletion.deletedConversationIds.has(conversationId) || await this.deps.storage.conversationTombstones?.().isDeleted(conversationId)) {
      throw new Error("Chat was permanently deleted.");
    }
    const conversation = await this.deps.storage.getConversation(conversationId);
    if (!conversation || conversation.kind !== "chat") {
      throw new Error("Chat conversation was not found.");
    }
    const removedTombstonesApplied = applyRemovedChatMessageTombstones(conversation);
    const legacyAccordStateRemoved = clearLegacyAccordState(conversation);
    const staleRunRecovered = this.chat.runOwners.recoverStaleChatRun(conversation);
    const delegationGroupsRecovered = [this.chat.requestRecovery.recoverDelegationGroupsOfEndedTurns(conversation), this.chat.selfCompaction.recoverSelfCompactions(conversation)].some(Boolean);
    if (staleRunRecovered || delegationGroupsRecovered || removedTombstonesApplied || legacyAccordStateRemoved) {
      if (legacyAccordStateRemoved) {
        conversation.updatedAt = new Date().toISOString();
      }
      await this.saveConversation(conversation);
    }
    return conversation;
  }

  queueSnapshot(conversation: Conversation): void {
    if (this.chat.deletion.deletedConversationIds.has(conversation.id)) {
      return;
    }
    this.chat.serverPlaceholders.withoutGoneServerPlaceholders(conversation);
    const grants = this.chat.requestGrants.pendingRequestPermissionGrants(conversation);
    const { snapshot, rows } = this.buildAndEmitSnapshot(conversation);
    const previous = this.saveQueues.get(conversation.id) ?? Promise.resolve();
    const outcome = previous
      .catch(() => undefined)
      .then(() => this.persistConversationSnapshot(snapshot, rows))
      .then(() => {
        this.chat.requestGrants.settleRequestPermissionGrants(conversation, grants);
        return true;
      }, (error: unknown) => {
        void this.deps.debugLogs.write("chat.persistence.error", {
          conversationId: conversation.id,
          message: error instanceof Error ? error.message : String(error),
          stderr: typeof (error as { result?: { stderr?: unknown } }).result?.stderr === "string"
            ? ((error as { result: { stderr: string } }).result.stderr).slice(0, 400)
            : undefined
        });
        return false;
      });
    // Callers that must know whether the rows actually reached SQLite (the
    // machines transport acknowledges results only then) read this outcome.
    this.saveOutcomes.set(conversation.id, outcome);
    const next = outcome.then(() => undefined);
    this.saveQueues.set(conversation.id, next);
    void next.finally(() => {
      if (this.saveQueues.get(conversation.id) === next) {
        this.saveQueues.delete(conversation.id);
      }
    });
  }

  private emitConversationSnapshot(conversation: Conversation): Conversation {
    return this.buildAndEmitSnapshot(conversation).snapshot;
  }

  private buildSnapshot(conversation: Conversation): ReturnType<typeof buildConversationSnapshot> {
    // Worked out from the whole chat on every save, so no path that changes
    // its messages (a merge, a reload from the server, the feed) can leave
    // it behind them.
    recordClosedAccords(conversation);
    return buildConversationSnapshot(conversation, this.snapshotRowStates.get(conversation.id));
  }

  private buildAndEmitSnapshot(conversation: Conversation): { snapshot: Conversation; rows: SnapshotMessageRow[] } {
    const built = this.buildSnapshot(conversation);
    this.rememberSnapshotRows(conversation.id, built.rows);
    this.deps.onConversationSnapshot?.(built.snapshot, built.update);
    return { snapshot: built.snapshot, rows: built.rows };
  }

  private rememberSnapshotRows(conversationId: string, rows: SnapshotMessageRow[]): void {
    this.snapshotRowStates.delete(conversationId);
    this.snapshotRowStates.set(conversationId, rows);
    let retainedBytes = 0;
    for (const tracked of this.snapshotRowStates.values()) {
      retainedBytes += snapshotRowsBytes(tracked);
    }
    const overLimit = (): boolean =>
      this.snapshotRowStates.size > SNAPSHOT_STATE_LIMIT ||
      retainedBytes > SNAPSHOT_STATE_BYTES_LIMIT;
    // Oldest first, idle chats before chats with a run in flight; the chat just
    // remembered is never evicted.
    for (const evictActiveToo of [false, true]) {
      for (const staleId of [...this.snapshotRowStates.keys()]) {
        if (!overLimit() || staleId === conversationId) {
          break;
        }
        const hasActiveRun = (this.chat.activeRuns.activeConversationRunIds.get(staleId)?.size ?? 0) > 0;
        if (hasActiveRun && !evictActiveToo) {
          continue;
        }
        retainedBytes -= snapshotRowsBytes(this.snapshotRowStates.get(staleId) ?? []);
        this.snapshotRowStates.delete(staleId);
        this.lastSavedSnapshots.delete(staleId);
      }
    }
  }

  private rememberLastSavedSnapshot(snapshot: Conversation, token: string | undefined): void {
    // A storage that does not report the token it stamped (test doubles) never
    // enables the in-memory refresh; only tracked chats keep their snapshot.
    if (typeof token === "string" && token && this.snapshotRowStates.has(snapshot.id)) {
      this.lastSavedSnapshots.set(snapshot.id, { snapshot, token });
    }
  }

  async withChatMutation<T>(
    conversation: Conversation,
    fn: () => Promise<T> | T,
    options: { skipRefresh?: boolean } = {}
  ): Promise<T> {
    const conversationId = conversation.id;
    const previous = this.chatMutationQueues.get(conversationId) ?? Promise.resolve();
    let resolveStep!: () => void;
    const step = new Promise<void>((resolve) => {
      resolveStep = resolve;
    });
    const chained = previous.catch(() => undefined).then(() => step);
    this.chatMutationQueues.set(conversationId, chained);
    await previous.catch(() => undefined);
    try {
      if (this.chat.deletion.deletedConversationIds.has(conversationId)) {
        throw new Error("Chat was permanently deleted.");
      }
      if (!options.skipRefresh) {
        // Wait for any in-flight saves to flush, then merge the latest stored state
        // into this batch's in-memory conversation reference. Concurrent sends each hold
        // their own Conversation object; without this, a save here can overwrite another
        // batch's user message / pending bubble / activeRunIds.
        await this.waitForQueuedSave(conversationId);
        await this.refreshStoredChatState(conversation);
      }
      return await fn();
    } finally {
      resolveStep();
      if (this.chatMutationQueues.get(conversationId) === chained) {
        this.chatMutationQueues.delete(conversationId);
      }
    }
  }

  async saveConversation(conversation: Conversation, options: { emitChanges?: boolean } = {}): Promise<void> {
    if (this.chat.deletion.deletedConversationIds.has(conversation.id)) {
      throw new Error("Chat was permanently deleted.");
    }
    const pending = this.saveQueues.get(conversation.id);
    if (pending) {
      await pending.catch(() => undefined);
    }
    this.chat.serverPlaceholders.withoutGoneServerPlaceholders(conversation);
    withoutAnsweredPlans(conversation);
    if (this.chat.selfCompactionResumes.selfCompactionMarks.has(conversation.id)) this.chat.selfCompactionResumes.withSelfCompactionMarks(conversation);
    const grants = this.chat.requestGrants.pendingRequestPermissionGrants(conversation);
    const built = this.buildSnapshot(conversation);
    // Rows are remembered before the save so a snapshot queued while this one
    // is in flight diffs against them, and so the saved snapshot is kept for
    // refreshStoredChatState (only tracked chats keep it).
    this.rememberSnapshotRows(conversation.id, built.rows);
    await this.persistConversationSnapshot(built.snapshot, built.rows, options);
    this.chat.requestGrants.settleRequestPermissionGrants(conversation, grants);
    this.deps.onConversationSnapshot?.(built.snapshot, built.update);
  }

  private persistConversationSnapshot(
    snapshot: Conversation,
    rows?: SnapshotMessageRow[],
    options: { emitChanges?: boolean } = {}
  ): Promise<void> {
    const run = this.persistConversationSnapshotNow(snapshot, rows, options);
    this.chatSavesInFlight.add(run);
    const settled = (): void => { this.chatSavesInFlight.delete(run); };
    run.then(settled, settled);
    return run;
  }

  /** Resolves once every chat save that had started when it was called has
   *  finished (and so has queued what it changed for the User's server). */
  async settleChatSaves(): Promise<void> {
    await Promise.allSettled([...this.chatSavesInFlight]);
  }

  private async persistConversationSnapshotNow(
    snapshot: Conversation,
    rows?: SnapshotMessageRow[],
    options: { emitChanges?: boolean } = {}
  ): Promise<void> {
    const link = this.chat.serverLink.current;
    // A link stopped (the app quitting, or between two links) still queues:
    // what a member ends meanwhile goes at the next start.
    const queue = this.chat.serverLink.serverQueue();
    if (queue && snapshot.kind === "chat") {
      // What this save changed goes to the server (Д1), queued in the same
      // transaction as the save: a crash keeps both or neither.
      let ops: HubOp[] = [];
      const finishes: Array<[string, { conversationId: string; participantId: string; op: HubOp; timer: ReturnType<typeof setTimeout> }]> = [];
      // The cards this chat's members here wait on go up, change or settle
      // with the save that made them so (Д9), whatever else it emits. Only
      // with a live link: the next start reconciles them.
      const cards = this.chat.serverCards.serverCardOpsFor(snapshot);
      if (options.emitChanges !== false) {
        const mayWrite = (message: ChatMessage) => this.chat.host.mayWriteOnServer(snapshot, message);
        const diff = diffChatChanges(await this.chatChangeBaselineFor(snapshot.id), snapshot, { emitsConversationFields: true, ownsMessage: mayWrite });
        ops = chatChangesToOps(snapshot, diff.changes, mayWrite);
        // The end of a turn run here goes after its member's last bubble, in
        // the same transaction.
        for (const [runId, deferred] of this.chat.serverTurns.deferredServerFinishes) {
          if (deferred.conversationId !== snapshot.id) continue;
          if (snapshot.messages.some((message) => message.participantId === deferred.participantId && message.metadata?.runId === runId && message.status === "pending")) continue;
          finishes.push([runId, deferred]);
        }
        for (const [runId, deferred] of finishes) {
          this.chat.serverTurns.deferredServerFinishes.delete(runId);
          ops.push(deferred.op);
        }
      }
      ops.push(...cards.ops);
      try {
        const token = ops.length
          ? await this.deps.storage.saveConversation(snapshot, { rows, alsoCommit: { sql: queue.queueSql(ops), onlyIfSql: (condition) => queue.queueSql(ops, condition) } })
          : await this.deps.storage.saveConversation(snapshot, { rows });
        this.rememberLastSavedSnapshot(snapshot, token);
        this.rememberChatChangeBaseline(snapshot.id, chatChangeBaseline(snapshot));
        cards.commit();
        this.chat.claudeModes.noteSavedClaudeMemberModes(snapshot);
        this.tellChatSaved(snapshot);
      } catch (error) {
        this.chatChangeBaselines.delete(snapshot.id);
        // Not written: the ends wait for the next save (or their timer).
        for (const [runId, deferred] of finishes) this.chat.serverTurns.deferredServerFinishes.set(runId, deferred);
        throw error;
      }
      for (const [, deferred] of finishes) clearTimeout(deferred.timer);
      if (ops.length) link?.nudge();
      return;
    }
    // Not linked to a server (yet): the chat is only saved here. The next
    // save with a link diffs against what the database holds then.
    this.chatChangeBaselines.delete(snapshot.id);
    this.rememberLastSavedSnapshot(snapshot, await this.deps.storage.saveConversation(snapshot, { rows }));
    this.chat.claudeModes.noteSavedClaudeMemberModes(snapshot);
    this.tellChatSaved(snapshot);
  }

  /** Whoever waits on a chat looks at it again, as it was saved. */
  private tellChatSaved(conversation: Conversation): void {
    for (const listener of [...this.chatSavedListeners.get(conversation.id) ?? []]) listener(conversation);
  }

  /** The chat's next save (the chat as saved), or undefined: a turn on the
   *  server changed, the time is up or it was aborted. */
  nextChatSave(conversationId: string, timeoutMs: number, signal: AbortSignal | undefined): Promise<Conversation | undefined> {
    return new Promise((resolve) => {
      const listeners = this.chatSavedListeners.get(conversationId) ?? new Set();
      this.chatSavedListeners.set(conversationId, listeners);
      const done = (conversation?: Conversation): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", aborted);
        listeners.delete(done);
        if (listeners.size === 0 && this.chatSavedListeners.get(conversationId) === listeners) this.chatSavedListeners.delete(conversationId);
        resolve(conversation);
      };
      const aborted = (): void => done();
      const timer = setTimeout(() => done(), timeoutMs);
      listeners.add(done);
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) done();
    });
  }

  /** Moves one chat to the server (the first link, 5.7): sent as this device
   *  holds it, with its saves held meanwhile; what was queued for it is part
   *  of the move. */
  async exportChatForServer(conversationId: string, send: (conversation: Conversation) => Promise<void>): Promise<void> {
    const conversation = await this.deps.storage.getConversation(conversationId);
    if (!conversation || conversation.kind !== "chat") return;
    await this.withChatMutation(conversation, async () => {
      await this.waitForQueuedSave(conversationId);
      const stored = await this.deps.storage.getConversation(conversationId);
      if (!stored) return;
      await send(stored);
      await this.chat.serverLink.current?.settleMoved?.(conversationId);
    });
  }

  private async chatChangeBaselineFor(conversationId: string): Promise<ChatChangeBaseline | undefined> {
    if (this.chatChangeBaselines.has(conversationId)) {
      const baseline = this.chatChangeBaselines.get(conversationId);
      this.rememberChatChangeBaseline(conversationId, baseline);
      return baseline;
    }
    const stored = await this.deps.storage.getConversation(conversationId);
    const baseline = chatChangeBaseline(stored && stored.kind === "chat" ? stored : undefined);
    this.rememberChatChangeBaseline(conversationId, baseline);
    return baseline;
  }

  private rememberChatChangeBaseline(conversationId: string, baseline: ChatChangeBaseline | undefined): void {
    this.chatChangeBaselines.delete(conversationId);
    this.chatChangeBaselines.set(conversationId, baseline);
    while (this.chatChangeBaselines.size > CHAT_CHANGE_BASELINE_LIMIT) {
      const oldest = this.chatChangeBaselines.keys().next().value;
      if (oldest === undefined || oldest === conversationId) break;
      this.chatChangeBaselines.delete(oldest);
    }
  }
}

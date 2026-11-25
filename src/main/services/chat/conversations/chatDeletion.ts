import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { isSafeChatId } from "../../chatChanges";
import { newOpId } from "../../chatServerOps";
import type { Conversation, DeleteChatConversationRequest } from "../../../../shared/types";
import { chatUserDataPath } from "../members/identity";
import { enqueueDeletedConversationArtifactCleanup, storedRemoteRunIds } from "../store/messages";
import type { ChatModules } from "../modules";
import type { ChatDependencies } from "../dependencies";

/** Deletes chats, here or on another device, and what they leave behind. */
export class ChatDeletion {
  readonly deletedConversationIds = new Set<string>();
  private artifactCleanup?: (conversationId: string) => Promise<void>;
  /** Wake delivery after storage atomically retained the tombstone and targets.
   *  A callback failure cannot discard that durable intent. */
  private onConversationDeleted?: (conversation: Pick<Conversation, "id" | "metadata">) => Promise<unknown>;

  constructor(
    private readonly chat: Pick<ChatModules, "activeRuns" | "promptSuggestions" | "runCancel" | "serverLink" | "store">,
    private readonly deps: Pick<ChatDependencies, "cliRunner" | "debugLogs" | "storage">
  ) {}

  setArtifactCleanup(handler: (conversationId: string) => Promise<void>): void {
    this.artifactCleanup = handler;
  }

  async deleteConversation(request: DeleteChatConversationRequest): Promise<boolean> {
    return this.chat.activeRuns.withChatRunLock(request.conversationId, async () => {
      await this.chat.store.waitForQueuedSave(request.conversationId);
      const conversation = await this.deps.storage.getConversation(request.conversationId);
      if (!conversation) {
        return false;
      }
      if (conversation.kind !== "chat") {
        throw new Error("Only chat conversations can be deleted.");
      }
      if (conversation.metadata.archived !== true) {
        throw new Error("Archive the chat before deleting it permanently.");
      }
      if (conversation.metadata.running === true || this.chat.activeRuns.chatHasLiveWork(conversation.id)) {
        throw new Error("Chat cannot be deleted while members are running.");
      }
      await this.deps.cliRunner.closeConversationSessions(conversation.id);
      this.deletedConversationIds.add(conversation.id);
      this.chat.promptSuggestions.suggestions.forgetConversation(conversation.id);
      this.chat.store.snapshotRowStates.delete(conversation.id);
      this.chat.store.lastSavedSnapshots.delete(conversation.id);
      try {
        await (this.chat.store.chatMutationQueues.get(conversation.id) ?? Promise.resolve()).catch(() => undefined);
        await this.chat.store.waitForQueuedSave(conversation.id);
        const cleanupMarker = await enqueueDeletedConversationArtifactCleanup(conversation);
        // The User's server owns the chat (Д1): the deletion goes there with
        // the rows (the tombstone commits with them too), and every other
        // device (its machines too) takes it from there.
        const serverDelete = this.chat.serverLink.serverQueue()?.queueSql([{ opId: newOpId(), kind: "conversation.delete", conversationId: conversation.id }]);
        const deleted = await this.deps.storage.deleteConversation(conversation.id, serverDelete ? { alsoCommitSql: serverDelete } : {});
        if (deleted && serverDelete) this.chat.serverLink.current?.nudge();
        if (!deleted) {
          await rm(cleanupMarker, { force: true });
          this.deletedConversationIds.delete(conversation.id);
          return false;
        }
        await this.cleanupDeletedConversationArtifacts(conversation)
          .then(() => rm(cleanupMarker, { force: true }))
          .catch((error) => {
            void this.deps.debugLogs.write("chat.delete.artifacts.error", {
              conversationId: conversation.id,
              message: error instanceof Error ? error.message : String(error)
            });
          });
        this.chat.store.saveQueues.delete(conversation.id);
        this.chat.store.chatMutationQueues.delete(conversation.id);
        // Every machine that hosts a member of this chat has its own copy and
        // its own providers. The participants were read before the rows went;
        // afterwards there is nothing left to read them from.
        await this.onConversationDeleted?.({ id: conversation.id, metadata: conversation.metadata }).catch((error) => {
          void this.deps.debugLogs.write("chat.delete.machines.error", {
            conversationId: conversation.id,
            message: error instanceof Error ? error.message : String(error)
          });
        });
        return true;
      } catch (error) {
        if (await this.deps.storage.getConversation(conversation.id)) {
          this.deletedConversationIds.delete(conversation.id);
        }
        throw error;
      }
    }, {
      rejectIfQueued: true,
      queuedMessage: "Chat cannot be deleted while members are running."
    });
  }

  setConversationDeletedHandler(handler: (conversation: Pick<Conversation, "id" | "metadata">) => Promise<unknown>): void {
    this.onConversationDeleted = handler;
  }

  private async cleanupDeletedConversationArtifacts(conversation: Conversation): Promise<void> {
    const runIds = storedRemoteRunIds(conversation.metadata.remoteRunHandles);
    await Promise.all([
      this.artifactCleanup?.(conversation.id) ?? Promise.resolve(),
      rm(path.join(chatUserDataPath(), "chats", conversation.id), {
        recursive: true,
        force: true
      }),
      ...runIds.map((runId) => rm(path.join(chatUserDataPath(), "remote-runs", `${runId}.jsonl`), {
        force: true
      }))
    ]);
  }

  async reconcileDeletedConversationArtifacts(): Promise<void> {
    const root = path.join(chatUserDataPath(), "pending-chat-deletions");
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      return;
    }
    for (const entry of entries.filter((name) => name.endsWith(".json"))) {
      const marker = path.join(root, entry);
      try {
        const record = JSON.parse(await readFile(marker, "utf8")) as {
          conversationId?: unknown;
          runIds?: unknown;
        };
        if (typeof record.conversationId !== "string") {
          continue;
        }
        // A marker may have been written before the deletion transaction
        // failed. Never remove artifacts from a conversation that still exists.
        if (await this.deps.storage.getConversation(record.conversationId)) continue;
        const runIds = Array.isArray(record.runIds)
          ? record.runIds.filter((value): value is string => typeof value === "string")
          : [];
        await Promise.all([
          this.artifactCleanup?.(record.conversationId) ?? Promise.resolve(),
          rm(path.join(chatUserDataPath(), "chats", record.conversationId), { recursive: true, force: true }),
          ...runIds.map((runId) => rm(path.join(chatUserDataPath(), "remote-runs", `${runId}.jsonl`), { force: true }))
        ]);
        await rm(marker, { force: true });
      } catch (error) {
        void this.deps.debugLogs.write("chat.delete.artifacts.retry-error", {
          marker,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  /**
   * Closes this device's providers for a chat that is being deleted elsewhere,
   * and proves they are gone.
   *
   * Deletion has to leave nothing running against a conversation that no
   * longer exists; a provider held for a chat nobody can open again is a
   * process nobody would ever come looking for.
   */
  async closeReplicatedConversationSessions(conversationId: string): Promise<void> {
    // The caller stored the tombstone first. Fence every mutation and future
    // admission before cancelling existing work; retain the fence on failure.
    this.deletedConversationIds.add(conversationId);
    this.chat.store.snapshotRowStates.delete(conversationId);
    this.chat.store.lastSavedSnapshots.delete(conversationId);
    for (const [runId, meta] of this.chat.activeRuns.chatRunMeta) {
      if (meta.conversationId === conversationId) this.chat.runCancel.cancelRun(runId);
    }
    await this.deps.cliRunner.closeConversationSessions(conversationId);
    await (this.chat.store.chatMutationQueues.get(conversationId) ?? Promise.resolve()).catch(() => undefined);
    await this.chat.store.waitForQueuedSave(conversationId);
  }

  async applyReplicatedConversationDeletion(conversationId: string, deletedAt: string): Promise<void> {
    // The id names a directory that is removed with the chat.
    if (!isSafeChatId(conversationId)) {
      void this.deps.debugLogs.write("chat.delete.unsafe-id-refused", { length: String(conversationId).length });
      return;
    }
    const conversation = await this.deps.storage.getConversation(conversationId);
    const marker = conversation ? await enqueueDeletedConversationArtifactCleanup(conversation) : undefined;
    await this.deps.storage.conversationTombstones().mark(conversationId, deletedAt);
    await this.closeReplicatedConversationSessions(conversationId);
    await this.deps.storage.deleteConversation(conversationId);
    if (conversation) {
      await this.cleanupDeletedConversationArtifacts(conversation).then(async () => {
        if (marker) await rm(marker, { force: true });
      }).catch(error => {
        void this.deps.debugLogs.write("chat.delete.artifacts.error", { conversationId, message: error instanceof Error ? error.message : String(error) });
      });
      await this.onConversationDeleted?.(conversation);
    }
  }

  async reconcileConversationDeletions(): Promise<void> {
    for (;;) {
      const pending = await this.deps.storage.conversationTombstones().pendingCopies();
      for (const row of pending) await this.applyReplicatedConversationDeletion(row.conversationId, row.deletedAt);
      if (pending.length < 100) return;
    }
  }
}

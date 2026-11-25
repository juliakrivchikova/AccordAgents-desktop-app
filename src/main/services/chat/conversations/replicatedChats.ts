import type { ChatParticipant, Conversation } from "../../../../shared/types";
import { metadataWithAutoWatchEnabled, resetAutoWatchDepthForUserMessage } from "../autoWatch/watchers";
import { chatParticipants, membersDroppedFrom } from "../members/identity";
import type { ChatModules } from "../modules";
import type { ChatDependencies } from "../dependencies";

/** Chats another device wrote, taken over here. */
export class ReplicatedChats {
  constructor(
    private readonly chat: Pick<ChatModules, "autoWatch" | "deletion" | "members" | "store">,
    private readonly deps: Pick<ChatDependencies, "cliRunner" | "storage">
  ) {}

  async applyReplicatedConversation(
    conversationId: string,
    merge: (existing: Conversation | undefined) => Conversation | undefined
  ): Promise<void> {
    if (this.chat.deletion.deletedConversationIds.has(conversationId) || await this.deps.storage.conversationTombstones?.().isDeleted(conversationId)) return;
    const existing = await this.deps.storage.getConversation(conversationId);
    if (!existing) {
      const created = merge(undefined);
      if (created) {
        this.reconcileReplicatedWatcher(undefined, created);
        if (created.metadata.archived === true) await this.deps.cliRunner.closeConversationSessions(conversationId);
        await this.chat.store.saveConversation(created);
      }
      return;
    }
    // The merge runs inside the mutation, against the copy refreshed there,
    // so a reply or session id written by a turn on this machine between the
    // read and the write is never replaced by an older desktop copy.
    const dropped: ChatParticipant[] = [];
    await this.chat.store.withChatMutation(existing, async () => {
      const merged = merge(existing);
      if (!merged) {
        return;
      }
      dropped.push(...membersDroppedFrom(existing, merged));
      this.reconcileReplicatedWatcher(existing, merged);
      if (merged.metadata.archived === true) await this.deps.cliRunner.closeConversationSessions(conversationId);
      existing.messages = merged.messages;
      existing.metadata = merged.metadata;
      existing.title = merged.title;
      existing.repoPath = merged.repoPath;
      existing.updatedAt = merged.updatedAt;
      await this.chat.store.saveConversation(existing);
    });
    this.chat.members.retireRemovedMembers(conversationId, dropped);
  }

  /** Called by the transport only after the entire copied chat is durable. */
  onReplicatedConversationReady(conversationId: string): void {
    this.chat.autoWatch.scheduleAutoWatchEvaluation(conversationId, "replicated-messages");
  }

  reconcileReplicatedWatcher(previous: Conversation | undefined, incoming: Conversation): void {
    // A first copy may still be an empty shell. Its initial cursor is chosen
    // from the complete history when the transport opens the copy barrier.
    if (!previous) return;
    const watcher = this.chat.autoWatch.activeAutoWatchParticipant(incoming);
    if (!watcher) return;
    const previousWatcher = previous && chatParticipants(previous).find(participant => participant.id === watcher.id);
    if (!previousWatcher?.autoWatch) {
      incoming.metadata = metadataWithAutoWatchEnabled(incoming, watcher.id);
    } else {
      const previousUserIds = new Set(previous?.messages.filter(message => message.role === "user").map(message => message.id));
      if (incoming.messages.some(message => message.role === "user" && !previousUserIds.has(message.id))) {
        resetAutoWatchDepthForUserMessage(incoming);
      }
    }
  }
}

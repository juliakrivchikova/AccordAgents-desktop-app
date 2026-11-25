import type { ChatMessage, Conversation } from "../../../../shared/types";
import type { ChatModules } from "../modules";
import type { ChatDependencies } from "../dependencies";

/** Placeholders of turns that another device runs. */
export class ServerPlaceholders {
  /** Placeholders shown here for a member elsewhere that are gone (its own
   *  bubble took their place, or its turn never ran). A copy of the chat read
   *  before one went (another send's, the feed's) must not bring it back when
   *  it merges with what is stored. Kept in memory: a placeholder belongs to
   *  a run of this process. */
  private readonly goneServerPlaceholders = new Set<string>();

  constructor(
    private readonly chat: Pick<ChatModules, "store">,
    private readonly deps: Pick<ChatDependencies, "storage">
  ) {}

  /** The User's server refused a message this device wrote: the message
   *  says so with the reason, instead of waiting to be sent (Д3). */
  async markMessageRefused(conversationId: string, messageId: string, reason: string): Promise<void> {
    const conversation = await this.deps.storage.getConversation(conversationId);
    if (!conversation || conversation.kind !== "chat") return;
    await this.chat.store.withChatMutation(conversation, async () => {
      const message = conversation.messages.find((item) => item.id === messageId);
      if (!message || message.metadata?.serverRejected === reason) return;
      message.metadata = { ...(message.metadata ?? {}), serverRejected: reason };
      // A closed Accord's line refused: the save records its card as pinned
      // again, unless another device's line for it is here.
      await this.chat.store.saveConversation(conversation, { emitChanges: false });
    });
  }

  /** A placeholder this device showed for a member elsewhere, once that
   *  member's own bubble has taken its place (or the turn never ran). */
  async dropServerPlaceholder(conversation: Conversation, messageId: string): Promise<void> {
    await this.chat.store.withChatMutation(conversation, async () => {
      if (this.removeServerPlaceholders(conversation, (message) => message.id === messageId)) this.chat.store.queueSnapshot(conversation);
    });
  }

  /** Takes the placeholders `gone` names out of this copy, and remembers them
   *  so that no other copy brings them back; true when one was here. */
  removeServerPlaceholders(conversation: Conversation, gone: (message: ChatMessage) => boolean): boolean {
    const before = conversation.messages.length;
    conversation.messages = conversation.messages.filter((message) => {
      if (!message.metadata?.serverPlaceholder || !gone(message)) return true;
      this.goneServerPlaceholders.add(message.id);
      return false;
    });
    while (this.goneServerPlaceholders.size > 5_000) {
      const oldest = this.goneServerPlaceholders.values().next().value;
      if (oldest === undefined) break;
      this.goneServerPlaceholders.delete(oldest);
    }
    return conversation.messages.length !== before;
  }

  /** A copy merged with what is stored, or about to be saved, keeps none of
   *  the placeholders that went meanwhile. */
  withoutGoneServerPlaceholders(conversation: Conversation): void {
    if (!this.goneServerPlaceholders.size) return;
    const gone = (message: ChatMessage) => Boolean(message.metadata?.serverPlaceholder) && this.goneServerPlaceholders.has(message.id);
    if (conversation.messages.some(gone)) conversation.messages = conversation.messages.filter((message) => !gone(message));
  }
}

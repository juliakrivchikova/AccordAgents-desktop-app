import type { Conversation } from "../../../../shared/types";
import { cloneConversation } from "./reviewRecords";
import type { ConsensusDependencies } from "../dependencies";

/** Saves and shows the conversation, one save after another. */
export class ConversationSaves {
  private readonly conversationSaveQueues = new Map<string, Promise<void>>();

  constructor(private readonly deps: Pick<ConsensusDependencies, "debugLogs" | "onConversationSnapshot" | "storage">) {}

  queueConversationSnapshot(conversation: Conversation): void {
    const snapshot = cloneConversation(conversation);
    this.deps.onConversationSnapshot?.(snapshot);
    const previous = this.conversationSaveQueues.get(conversation.id) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        await this.deps.storage.saveConversation(snapshot);
      })
      .catch((error) => {
        void this.deps.debugLogs.write("persistence.error", {
          conversationId: conversation.id,
          message: error instanceof Error ? error.message : String(error)
        });
      });
    this.conversationSaveQueues.set(conversation.id, next);
    void next.finally(() => {
      if (this.conversationSaveQueues.get(conversation.id) === next) {
        this.conversationSaveQueues.delete(conversation.id);
      }
    });
  }

  async flushAndSaveConversation(conversation: Conversation): Promise<void> {
    const pending = this.conversationSaveQueues.get(conversation.id);
    if (pending) {
      await pending.catch(() => undefined);
    }
    const snapshot = cloneConversation(conversation);
    await this.deps.storage.saveConversation(snapshot);
    this.deps.onConversationSnapshot?.(snapshot);
  }
}

import { createHash } from "node:crypto";
import type { SavedMessageRow } from "../../main/services/storage";
import { recordClosedAccords } from "../../shared/accordProgress";
import type { HubFeedEntry, HubOpResult } from "../../shared/hubOps";
import type { ChatMessage, Conversation } from "../../shared/types";
import { CACHE_MESSAGE_LIMIT } from "./constants";
import type { HubOpsDependencies } from "./dependencies";

/** Chats kept in memory between operations. */
export class ChatCache {
  readonly cache = new Map<string, { conversation: Conversation; token: string }>();
  private readonly rows = new WeakMap<ChatMessage, Omit<SavedMessageRow, "index" | "id">>();

  constructor(private readonly deps: Pick<HubOpsDependencies, "storage">) {}

  // --- storage -------------------------------------------------------------

  async load(conversationId: string): Promise<Conversation | undefined> {
    const cached = this.cache.get(conversationId);
    if (cached && await this.deps.storage.isConversationSaveOwned(conversationId, cached.token)) return cached.conversation;
    this.cache.delete(conversationId);
    const conversation = await this.deps.storage.getConversation(conversationId);
    return conversation?.kind === "chat" ? conversation : undefined;
  }

  async save(
    conversation: Conversation,
    done: { result: HubOpResult; entry: HubFeedEntry },
    also?: (condition?: string) => string
  ): Promise<void> {
    const store = this.deps.storage.hubOps();
    const record = { ...done.entry, kind: done.entry.effect.kind, result: done.result };
    // The Accords folded into the chat, from its lines, for the phone's list:
    // written on every save, whichever operation brought the lines.
    recordClosedAccords(conversation);
    const token = await this.deps.storage.saveConversation(conversation, {
      rows: this.rowsFor(conversation),
      alsoCommit: {
        sql: `${store.insertSql(record)} ${also?.() ?? ""}`,
        onlyIfSql: (condition) => `${store.insertSql(record, condition)} ${also?.(condition) ?? ""}`
      }
    });
    this.remember(conversation, token);
  }

  private rowsFor(conversation: Conversation): SavedMessageRow[] {
    return conversation.messages.map((message, index) => {
      let row = this.rows.get(message);
      if (!row) {
        const json = JSON.stringify(message);
        row = { createdAt: message.createdAt, json, hash: createHash("sha1").update(json).digest("hex") };
        this.rows.set(message, row);
      }
      return { index, id: message.id, ...row };
    });
  }

  private remember(conversation: Conversation, token: string): void {
    this.cache.delete(conversation.id);
    this.cache.set(conversation.id, { conversation, token });
    let messages = 0;
    for (const cached of this.cache.values()) messages += cached.conversation.messages.length;
    while (messages > CACHE_MESSAGE_LIMIT && this.cache.size > 1) {
      const [oldest] = this.cache.keys();
      messages -= this.cache.get(oldest)?.conversation.messages.length ?? 0;
      this.cache.delete(oldest);
    }
  }
}

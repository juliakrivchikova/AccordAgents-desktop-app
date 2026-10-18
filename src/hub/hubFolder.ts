import { CHAT_CHANGES_EVENT_KIND, applyChatChanges, isChatChangesPayload, type ChatChangeApplyPolicy, type ChatChangesPayload } from "../main/services/chatChanges";
import type { StorageService } from "../main/services/storage";
import type { Conversation } from "../shared/types";

/** Chats kept in memory between folds: re-reading a chat of thousands of
 *  messages for every event would be the slow part. */
const CACHE_LIMIT = 16;
const FOLD_BATCH = 200;

/**
 * Folds the order's chat changes into the hub's own copy of every chat, the
 * copy that search and the phone read. Behind the order, never in its way: a
 * push is answered as soon as its events are stored, and the folding catches
 * up in the background, one chat at a time.
 */
export class HubFolder {
  private readonly pending = new Set<string>();
  private running?: Promise<void>;
  private readonly cache = new Map<string, Conversation>();

  constructor(
    private readonly storage: StorageService,
    private readonly policy: () => Promise<ChatChangeApplyPolicy>,
    private readonly log: (event: string, payload: Record<string, unknown>) => void = () => undefined
  ) {}

  /** Folds whatever is left from before a restart. */
  async start(): Promise<void> {
    for (const conversationId of await this.storage.hub().unfoldedConversations()) this.pending.add(conversationId);
    this.kick();
  }

  enqueue(conversationIds: string[]): void {
    for (const conversationId of conversationIds) this.pending.add(conversationId);
    this.kick();
  }

  /** Resolves once everything queued so far is folded (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  private kick(): void {
    if (this.running || this.pending.size === 0) return;
    this.running = (async () => {
      while (this.pending.size > 0) {
        const [conversationId] = this.pending;
        this.pending.delete(conversationId);
        try {
          await this.fold(conversationId);
        } catch (error) {
          this.log("hub.fold.error", { conversationId, message: error instanceof Error ? error.message : String(error) });
        }
      }
    })().finally(() => {
      this.running = undefined;
      if (this.pending.size > 0) this.kick();
    });
  }

  private async fold(conversationId: string): Promise<void> {
    const hub = this.storage.hub();
    let through = await hub.foldedThrough(conversationId);
    const policy = await this.policy();
    for (;;) {
      const events = await hub.conversationEvents(conversationId, through, FOLD_BATCH);
      if (events.length === 0) return;
      let conversation = this.cache.get(conversationId) ?? await this.storage.getConversation(conversationId);
      let changed = false;
      let foldedTo = through;
      // Changes to a chat the hub does not hold yet wait for it: the chat's
      // creation (or the desktop's first copy) may come later in the order.
      let waiting: Array<{ hubSeq: number; originId: string; payload: ChatChangesPayload }> = [];
      const apply = (payload: ChatChangesPayload, originId: string): boolean => {
        const result = applyChatChanges(conversation, payload, originId, policy);
        if (result.status === "missing-conversation") return false;
        if (result.status === "applied") {
          conversation = result.conversation;
          changed = true;
        }
        return true;
      };
      for (const { hubSeq, event } of events) {
        if (event.kind === CHAT_CHANGES_EVENT_KIND) {
          const payload = await this.storage.deviceEventBlobs().hydrate(event.payload);
          if (isChatChangesPayload(payload) && payload.conversationId === conversationId) {
            if (!apply(payload, event.originId)) {
              waiting.push({ hubSeq, originId: event.originId, payload });
              continue;
            }
            if (waiting.length > 0) {
              for (const held of waiting) apply(held.payload, held.originId);
              waiting = [];
            }
          }
        }
        if (waiting.length === 0) foldedTo = hubSeq;
      }
      if (changed && conversation) {
        await this.storage.saveConversation(conversation);
        this.remember(conversation);
      }
      if (foldedTo === through) return;
      await hub.setFoldedThrough(conversationId, foldedTo);
      through = foldedTo;
      if (events.length < FOLD_BATCH) return;
    }
  }

  private remember(conversation: Conversation): void {
    this.cache.delete(conversation.id);
    this.cache.set(conversation.id, conversation);
    while (this.cache.size > CACHE_LIMIT) {
      const [oldest] = this.cache.keys();
      this.cache.delete(oldest);
    }
  }
}

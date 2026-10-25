import { createHash } from "node:crypto";
import { CHAT_CHANGES_EVENT_KIND, applyChatChanges, isChatChangesPayload, type ChatChangeApplyPolicy, type ChatChangesPayload } from "../main/services/chatChanges";
import type { SavedMessageRow, StorageService } from "../main/services/storage";
import type { ChatMessage, Conversation } from "../shared/types";

/** What one fold of a chat came to, for the phone. */
export interface HubFoldDetails {
  conversation: Conversation;
  /** Members' replies that finished in this fold. */
  settled: ChatMessage[];
  /** Messages the User wrote on a phone, new in this fold, with their place. */
  phoneMessages: Array<{ message: ChatMessage; hubSeq: number }>;
}

/** Chats kept in memory between folds, by their messages: re-reading a chat
 *  of thousands of messages for every change would be the slow part, and
 *  the hub runs on a small instance. */
const CACHE_MESSAGE_LIMIT = 6_000;
const FOLD_BATCH = 200;
/** A fold that failed is tried again after this. */
const FOLD_RETRY_MS = 30_000;

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
  /** A message's stored row, kept while the message object is unchanged, so
   *  a save serializes only what a change replaced. */
  private readonly rows = new WeakMap<ChatMessage, Omit<SavedMessageRow, "index" | "id">>();
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly reportedWaiting = new Set<string>();
  private closed = false;

  constructor(
    private readonly storage: StorageService,
    private readonly policy: () => Promise<ChatChangeApplyPolicy>,
    private readonly log: (event: string, payload: Record<string, unknown>) => void = () => undefined,
    /** A chat's hub copy changed (search reads it again), with what the
     *  phone is told about: members' replies that settled, and messages a
     *  phone wrote (their members' homes may need waking). */
    private readonly onFolded: (conversationId: string, details: HubFoldDetails) => void = () => undefined,
    /** Whether a device is one of the User's phones. */
    private readonly isPhone: (originId: string) => Promise<boolean> = async () => false
  ) {}

  /** Folds whatever is left from before a restart. */
  async start(): Promise<void> {
    for (const conversationId of await this.storage.hub().unfoldedConversations(CHAT_CHANGES_EVENT_KIND)) this.pending.add(conversationId);
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

  close(): void {
    this.closed = true;
    for (const timer of this.retries.values()) clearTimeout(timer);
    this.retries.clear();
  }

  private kick(): void {
    if (this.closed || this.running || this.pending.size === 0) return;
    this.running = (async () => {
      while (this.pending.size > 0 && !this.closed) {
        const [conversationId] = this.pending;
        this.pending.delete(conversationId);
        try {
          await this.fold(conversationId);
        } catch (error) {
          this.log("hub.fold.error", { conversationId, message: error instanceof Error ? error.message : String(error) });
          this.cache.delete(conversationId);
          this.retryLater(conversationId);
        }
      }
    })().finally(() => {
      this.running = undefined;
      if (this.pending.size > 0) this.kick();
    });
  }

  private retryLater(conversationId: string): void {
    if (this.closed || this.retries.has(conversationId)) return;
    const timer = setTimeout(() => {
      this.retries.delete(conversationId);
      this.enqueue([conversationId]);
    }, FOLD_RETRY_MS);
    timer.unref?.();
    this.retries.set(conversationId, timer);
  }

  private async fold(conversationId: string): Promise<void> {
    const hub = this.storage.hub();
    const policy = await this.policy();
    let foldedTo = await hub.foldedThrough(conversationId);
    // Read on past changes that wait: the chat's creation (or the desktop's
    // first copy) may come later in the order, and stopping at a full window
    // of waiting changes would never reach it.
    let readFrom = foldedTo;
    let conversation: Conversation | undefined;
    let loaded = false;
    let changed = false;
    // Changes to a chat the hub does not hold yet, in order.
    let waiting: Array<{ hubSeq: number; originId: string; payload: ChatChangesPayload }> = [];
    const settled = new Map<string, ChatMessage>();
    const phoneMessages = new Map<string, { message: ChatMessage; hubSeq: number }>();
    const phones = new Map<string, boolean>();
    const apply = async (payload: ChatChangesPayload, originId: string, hubSeq: number): Promise<boolean> => {
      const before = new Map((conversation?.messages ?? []).map((message) => [message.id, message.status]));
      const result = applyChatChanges(conversation, payload, originId, policy);
      if (result.status === "missing-conversation") return false;
      if (result.status === "applied") {
        conversation = result.conversation;
        changed = true;
        const touched = new Set(payload.changes.flatMap((change) => change.type === "message.created" || change.type === "message.updated" ? [change.message.id] : []));
        if (!phones.has(originId)) phones.set(originId, await this.isPhone(originId).catch(() => false));
        for (const message of conversation.messages) {
          if (!touched.has(message.id)) continue;
          // A member's reply that is done now and was running (or new).
          if (message.role === "participant" && (message.status === "done" || message.status === "error") &&
              (before.get(message.id) === undefined || before.get(message.id) === "pending")) settled.set(message.id, message);
          if (message.role === "user" && phones.get(originId) && !before.has(message.id)) phoneMessages.set(message.id, { message, hubSeq });
        }
      }
      return true;
    };
    for (;;) {
      const events = await hub.conversationEvents(conversationId, CHAT_CHANGES_EVENT_KIND, readFrom, FOLD_BATCH);
      if (events.length === 0) break;
      if (!loaded) {
        conversation = this.cache.get(conversationId) ?? await this.storage.getConversation(conversationId);
        loaded = true;
      }
      for (const { hubSeq, event } of events) {
        readFrom = hubSeq;
        const payload = await this.storage.deviceEventBlobs().hydrate(event.payload);
        if (!isChatChangesPayload(payload) || payload.conversationId !== conversationId) {
          if (waiting.length === 0) foldedTo = hubSeq;
          continue;
        }
        if (!await apply(payload, event.originId, hubSeq)) {
          waiting.push({ hubSeq, originId: event.originId, payload });
          continue;
        }
        if (waiting.length > 0) {
          for (const held of waiting) await apply(held.payload, held.originId, held.hubSeq);
          waiting = [];
        }
        foldedTo = hubSeq;
      }
      if (events.length < FOLD_BATCH) break;
    }
    if (waiting.length > 0 && !this.reportedWaiting.has(conversationId)) {
      // Kept, not dropped: folded once the chat arrives.
      this.reportedWaiting.add(conversationId);
      this.log("hub.fold.waiting", { conversationId, changes: waiting.length });
    } else if (waiting.length === 0) {
      this.reportedWaiting.delete(conversationId);
    }
    if (changed && conversation) {
      await this.storage.saveConversation(conversation, { rows: this.rowsFor(conversation) });
      const folded: Conversation = conversation;
      try {
        this.onFolded(conversationId, {
          conversation: folded,
          settled: [...settled.values()].filter((message) => folded.messages.some((item) => item.id === message.id)),
          phoneMessages: [...phoneMessages.values()]
        });
      } catch { /* a listener never breaks a fold */ }
    }
    if (conversation) this.remember(conversation);
    if (foldedTo > await hub.foldedThrough(conversationId)) await hub.setFoldedThrough(conversationId, foldedTo);
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

  private remember(conversation: Conversation): void {
    this.cache.delete(conversation.id);
    this.cache.set(conversation.id, conversation);
    let messages = 0;
    for (const cached of this.cache.values()) messages += cached.messages.length;
    while (messages > CACHE_MESSAGE_LIMIT && this.cache.size > 1) {
      const [oldest] = this.cache.keys();
      messages -= this.cache.get(oldest)?.messages.length ?? 0;
      this.cache.delete(oldest);
    }
  }
}

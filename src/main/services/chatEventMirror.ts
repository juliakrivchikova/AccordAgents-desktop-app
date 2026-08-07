import {
  foldChatConversationEvents,
  type ChatConversationEventEnvelope
} from "../../shared/chatEventProjection";
import { stableJson } from "../../shared/stableJson";
import type { Conversation } from "../../shared/types";
import { detectChatConversationProjectionDivergence, importConversationToEventLog } from "./chatEventMigration";
import type { ChatEventLogService } from "./chatEventLog";
import { CHAT_EVENT_PROJECTION_VERSION, type StorageService } from "./storage";

export const CHAT_EVENT_MIRROR_ENV = "ACCORD_AGENTS_CHAT_EVENT_MIRROR";
export const CHAT_EVENT_MIRROR_STRICT_ENV = "ACCORD_AGENTS_CHAT_EVENT_MIRROR_STRICT";
export const CHAT_CONVERSATION_PROJECTION_KEY = "conversation";

export interface ChatEventMirrorOptions {
  enabled?: boolean;
  strict?: boolean;
  now?: () => Date;
}

export interface ChatEventMirrorLogger {
  write(event: string, payload: Record<string, unknown>): Promise<void>;
}

export interface ChatEventMirrorResult {
  status: "disabled" | "skipped" | "mirrored" | "diverged" | "error";
  appendedEventId?: string;
  divergenceCount?: number;
}

export function chatEventMirrorOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): ChatEventMirrorOptions {
  return {
    enabled: env[CHAT_EVENT_MIRROR_ENV] === "1",
    strict: env[CHAT_EVENT_MIRROR_STRICT_ENV] === "1"
  };
}

export class ChatEventMirrorService {
  private readonly enabled: boolean;
  private readonly strict: boolean;
  private readonly now: () => Date;

  constructor(
    private readonly storage: StorageService,
    private readonly eventLog: ChatEventLogService,
    private readonly logger: ChatEventMirrorLogger,
    options: ChatEventMirrorOptions = {}
  ) {
    this.enabled = options.enabled === true;
    this.strict = options.strict === true;
    this.now = options.now ?? (() => new Date());
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async mirrorSavedConversation(
    previous: Conversation | undefined,
    next: Conversation
  ): Promise<ChatEventMirrorResult> {
    if (!this.enabled) {
      return { status: "disabled" };
    }
    if (next.kind !== "chat") {
      return { status: "skipped" };
    }
    try {
      const baseline = previous?.kind === "chat" ? previous : next;
      await importConversationToEventLog(this.storage, this.eventLog, baseline);
      let appendedEventId: string | undefined;
      if (previous?.kind === "chat" && stableJson(previous) !== stableJson(next)) {
        const append = await this.eventLog.appendLocalEvent({
          conversationId: next.id,
          logScopeId: next.id,
          kind: "conversation.snapshot.replaced",
          payload: {
            source: "legacy-dual-write",
            replacedAt: this.now().toISOString(),
            conversation: next
          }
        });
        appendedEventId = append.event.eventId;
      }
      const divergenceCount = await this.refreshProjection(next);
      if (divergenceCount > 0) {
        await this.logger.write("chat.event-mirror.diverged", {
          conversationId: next.id,
          divergenceCount
        });
        if (this.strict) {
          throw new Error(`Chat event mirror diverged for ${next.id}.`);
        }
        return { status: "diverged", appendedEventId, divergenceCount };
      }
      return { status: "mirrored", appendedEventId, divergenceCount };
    } catch (error) {
      await this.logger.write("chat.event-mirror.error", {
        conversationId: next.id,
        message: error instanceof Error ? error.message : String(error)
      });
      if (this.strict) {
        throw error;
      }
      return { status: "error" };
    }
  }

  private async refreshProjection(conversation: Conversation): Promise<number> {
    const events = await this.storage.listChatEvents(conversation.id, conversation.id);
    const folded = foldChatConversationEvents(events, {
      conversationId: conversation.id,
      logScopeId: conversation.id
    });
    const divergence = detectChatConversationProjectionDivergence(conversation, events);
    const lastEventId = folded.appliedEventIds[folded.appliedEventIds.length - 1];
    await this.storage.saveChatEventProjection({
      conversationId: conversation.id,
      projectionKey: CHAT_CONVERSATION_PROJECTION_KEY,
      version: CHAT_EVENT_PROJECTION_VERSION,
      lastEventId,
      payload: {
        conversation: folded.conversation,
        appliedEventIds: folded.appliedEventIds,
        gaps: folded.gaps,
        forks: folded.forks,
        divergence
      },
      updatedAt: this.now().toISOString()
    });
    return divergence.length + folded.gaps.length + folded.forks.length;
  }
}

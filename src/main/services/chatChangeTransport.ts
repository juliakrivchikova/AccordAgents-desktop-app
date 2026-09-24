import type { DeviceEventRecipient } from "../../shared/deviceEventDelivery";
import type { ChatMessage, ChatParticipant, Conversation } from "../../shared/types";
import type { ChatChangeTransport } from "./chat";
import { CHAT_CHANGES_EVENT_KIND, chatChangesLogScope, type ChatChangeApplyPolicy, type ChatChangeDiffPolicy } from "./chatChanges";
import type { ChatEventLogService } from "./chatEventLog";
import type { StorageService } from "./storage";

/**
 * The desktop and the machine runtime install the same outgoing path; they
 * differ only in who owns what.
 *
 * - The desktop owns the chat's shared fields and the messages of members that
 *   run on it. A member whose home is a machine owns its own replies there.
 * - A machine owns the replies of members whose home it is, and the messages
 *   typed into it directly (a phone talking to it while the desktop is off).
 *   It accepts the chat's shared fields only from the desktop that installed it.
 * - Anyone may create a message; a message that arrived from elsewhere may be
 *   changed only by the device it came from, or by the member's home.
 */
export interface ChatChangeTransportOptions {
  role: "desktop" | "machine";
  storage: Pick<StorageService, "deviceEventBlobs" | "chatEventAppendSql">;
  log: Pick<ChatEventLogService, "withPreparedLocalEvent">;
  /** Every device that should hold this device's chat changes. */
  recipients(): DeviceEventRecipient[];
  /** Called after an event committed, so the channels send it now. */
  onCommitted?(): void;
  /** Machine only: this runtime's machine id. */
  hostMachineId?(): string | undefined;
  /** Machine only: the desktop that installed this machine. */
  desktopOriginId?(): string | undefined;
  /** The device identity of a machine, by machine id, when known. */
  machineOriginId?(machineId: string): string | undefined;
}

function participantHome(conversation: Conversation, participantId: string | undefined): string | undefined {
  if (!participantId) return undefined;
  const participants = conversation.metadata?.participants;
  if (!Array.isArray(participants)) return undefined;
  const participant = (participants as ChatParticipant[]).find((item) => item?.id === participantId);
  const home = participant?.homeMachineId;
  return typeof home === "string" && home.length > 0 ? home : undefined;
}

function remoteAuthor(message: ChatMessage): string | undefined {
  const value = (message.metadata as Record<string, unknown> | undefined)?.remoteAuthorOriginId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function createChatChangeTransport(options: ChatChangeTransportOptions): ChatChangeTransport {
  const ownsMessage = (conversation: Conversation, message: ChatMessage): boolean => {
    if (message.role === "participant" && message.participantId) {
      const home = participantHome(conversation, message.participantId);
      if (options.role === "desktop") return !home;
      return Boolean(home) && home === options.hostMachineId?.();
    }
    return !remoteAuthor(message);
  };
  const expectedWriter = (conversation: Conversation, message: ChatMessage): string | undefined => {
    if (message.role === "participant" && message.participantId) {
      const home = participantHome(conversation, message.participantId);
      if (home) {
        if (options.role === "machine" && home === options.hostMachineId?.()) return undefined;
        return options.machineOriginId?.(home) ?? remoteAuthor(message);
      }
      return options.role === "machine" ? options.desktopOriginId?.() : undefined;
    }
    return remoteAuthor(message);
  };
  return {
    hasRecipients: () => options.recipients().length > 0,
    diffPolicy: (conversation): ChatChangeDiffPolicy => ({
      emitsConversationFields: options.role === "desktop",
      ownsMessage: (message) => ownsMessage(conversation, message)
    }),
    applyPolicy: (): ChatChangeApplyPolicy => ({
      acceptsConversationFields: (originId) => options.role === "machine" && originId === options.desktopOriginId?.(),
      acceptsMessageUpdate: (existing, conversation, originId) => {
        const writer = expectedWriter(conversation, existing);
        return Boolean(writer) && writer === originId;
      }
    }),
    commit: async (payload, write) => {
      const audience = options.recipients();
      const prepared = await options.storage.deviceEventBlobs().prepare(payload);
      const outcome = await options.log.withPreparedLocalEvent({
        conversationId: payload.conversationId,
        logScopeId: chatChangesLogScope(payload.conversationId),
        kind: CHAT_CHANGES_EVENT_KIND,
        payload: prepared,
        recipients: audience
      }, (ready) => write({
        sql: ready.sql,
        onlyIfSql: (condition) => ready.sql ? options.storage.chatEventAppendSql(ready.event, { recipients: audience }, condition) : ""
      }));
      if (outcome.committed) options.onCommitted?.();
      return { token: outcome.result, committed: outcome.committed, eventId: outcome.event.eventId };
    }
  };
}

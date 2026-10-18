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
 * - A member's turn that never left the desktop (stopped while preparing, or
 *   refused before it was sent) is settled by the desktop: the home machine
 *   only ever had its empty bubble.
 */
export interface ChatChangeTransportOptions {
  role: "desktop" | "machine";
  storage: Pick<StorageService, "deviceEventBlobs" | "chatEventAppendSql" | "getChatEventSequenceBasis" | "deviceEvents">;
  log: Pick<ChatEventLogService, "withPreparedLocalEvent" | "getOrCreateDeviceIdentity">;
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
  /** True while a hub keeps every change, so changes are written even with
   *  no other recipient. */
  alwaysEmit?(): boolean;
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

/** A member's bubble whose turn the desktop never sent to the member's home. */
function turnNeverSent(message: ChatMessage | undefined): boolean {
  return message?.metadata?.machineTurnNotSent === true;
}

export function createChatChangeTransport(options: ChatChangeTransportOptions): ChatChangeTransport {
  const ownsMessage = (conversation: Conversation, message: ChatMessage): boolean => {
    if (message.role === "participant" && message.participantId) {
      if (turnNeverSent(message)) return options.role === "desktop";
      const home = participantHome(conversation, message.participantId);
      if (options.role === "desktop") return !home;
      return Boolean(home) && home === options.hostMachineId?.();
    }
    return !remoteAuthor(message);
  };
  const expectedWriter = (conversation: Conversation, message: ChatMessage): string | undefined => {
    if (message.role === "participant" && message.participantId) {
      if (turnNeverSent(message)) return options.role === "machine" ? options.desktopOriginId?.() : undefined;
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
    hasRecipients: () => options.recipients().length > 0 || options.alwaysEmit?.() === true,
    head: async (conversationId) => {
      const { originId } = await options.log.getOrCreateDeviceIdentity();
      const logScopeId = chatChangesLogScope(conversationId);
      const basis = await options.storage.getChatEventSequenceBasis(originId, logScopeId);
      return { originId, logScopeId, originSeq: basis.originSeq - 1 };
    },
    diffPolicy: (conversation): ChatChangeDiffPolicy => ({
      emitsConversationFields: options.role === "desktop",
      ownsMessage: (message) => ownsMessage(conversation, message)
    }),
    applyPolicy: (): ChatChangeApplyPolicy => {
      const fromDesktop = (originId: string): boolean => options.role === "machine" && originId === options.desktopOriginId?.();
      return {
        acceptsConversationFields: fromDesktop,
        acceptsMessageUpdate: (existing, conversation, originId, incoming) => {
          const writer = expectedWriter(conversation, existing);
          if (writer && writer === originId) return true;
          // The desktop settles a turn it never sent, whatever the bubble
          // became here meanwhile (swept as interrupted, say).
          return fromDesktop(originId) && turnNeverSent(incoming) && existing.role === "participant";
        },
        acceptsMessageCreate: (message, conversation, originId) => {
          if (message.role !== "participant") return true;
          if (!message.participantId) return fromDesktop(originId);
          // A member's message comes from where it runs, or from the desktop
          // that dispatches it (the pending bubble of a member on a machine).
          if (fromDesktop(originId)) return true;
          const participants = Array.isArray(conversation.metadata?.participants) ? conversation.metadata.participants as ChatParticipant[] : [];
          if (!participants.some((participant) => participant?.id === message.participantId)) return false;
          const home = participantHome(conversation, message.participantId);
          if (!home) return false;
          if (options.role === "machine" && home === options.hostMachineId?.()) return false;
          return options.machineOriginId?.(home) === originId;
        },
        acceptsMessageRemoval: (existing, conversation, originId) => {
          if (fromDesktop(originId)) return true;
          if (!existing) return false;
          const writer = expectedWriter(conversation, existing);
          return Boolean(writer) && writer === originId;
        },
        holdsUnknownChats: options.role === "machine"
      };
    },
    dependency: async (payload) => {
      const after = payload.after;
      if (!after || typeof after.originId !== "string" || !Number.isSafeInteger(after.originSeq) || after.originSeq < 1) return undefined;
      const { originId } = await options.log.getOrCreateDeviceIdentity();
      if (after.originId === originId) return undefined;
      return { needed: after.originSeq, have: await options.storage.deviceEvents().appliedHead(after.originId, chatChangesLogScope(payload.conversationId)) };
    },
    commit: async (payload, write) => {
      const audience = options.recipients();
      // A machine says how far it had the desktop's changes of this chat; see
      // ChatChangesPayload.after.
      const desktop = options.role === "machine" ? options.desktopOriginId?.() : undefined;
      if (desktop) {
        const head = await options.storage.deviceEvents().appliedHead(desktop, chatChangesLogScope(payload.conversationId));
        if (head > 0) payload = { ...payload, after: { originId: desktop, originSeq: head } };
      }
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
      // Only a hint to send now: the channels' own timers send it regardless,
      // and a committed save must not be reported as failed because of it.
      if (outcome.committed) {
        try { options.onCommitted?.(); } catch { /* sent by the next retry tick */ }
      }
      return { token: outcome.result, committed: outcome.committed, eventId: outcome.event.eventId };
    }
  };
}

/**
 * Forgets confirmed chat change events shortly after start and then once an
 * hour, on the desktop and on machines alike. Returns a function that stops it.
 */
export function scheduleChatChangePruning(options: {
  storage: Pick<StorageService, "deviceEvents">;
  originId(): Promise<string>;
  log(event: string, payload: Record<string, unknown>): void;
  /** Events younger than this are kept whatever their state. */
  graceMs?: number;
  /** With the User's hub: this device's own events after this position have
   *  not reached it and are kept. */
  unpushedAfter?: () => Promise<number | undefined>;
  intervalMs?: number;
  firstRunMs?: number;
  now?: () => number;
}): () => void {
  const graceMs = options.graceMs ?? 24 * 60 * 60_000;
  let running = false;
  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const cutoff = new Date((options.now?.() ?? Date.now()) - graceMs).toISOString();
      const pruned = await options.storage.deviceEvents().pruneConfirmedChatChanges(await options.originId(), cutoff, undefined, await options.unpushedAfter?.());
      if (pruned.events || pruned.blobs) options.log("chat.changes.pruned", pruned);
    } catch (error) {
      options.log("chat.changes.prune-error", { message: error instanceof Error ? error.message : String(error) });
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => { void run(); }, options.firstRunMs ?? 5 * 60_000);
  const timer = setInterval(() => { void run(); }, options.intervalMs ?? 60 * 60_000);
  first.unref?.();
  timer.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

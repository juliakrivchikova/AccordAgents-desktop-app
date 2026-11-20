// The main session of a chat and the chat's two views (the User, 2026-11-20,
// docs/main-session.md).
//
// A chat made from now on has one main session: an ordinary member on the
// User's CLI that every message without an addressee goes to, that creates
// other members itself (no card) and gives them tasks. The Chat Assistant is
// not in such a chat. A chat made before keeps its Assistant and is always
// shown the old way.
//
// The view is only how the chat is shown, switched by the User any number of
// times; the chat works the same in both:
//   - "classic": today's timeline, every member's reply on it, with avatars;
//   - "sessions": the main timeline holds the User and the main session only
//     (plus the cards the User must answer and a card for every task the main
//     session gave); each other member's whole session is in the right panel.
//
// These rules are shared so the desktop and the phone (mobileSharedRules.ts)
// put every message in the same place.

import type {
  ChatMessage,
  ChatParticipant,
  ChatParticipantRequestBatch,
  ChatViewMode,
  ConversationMetadata
} from "./types";
import { turnFinishedNoteOf } from "./turnFinishedNoteSource";

export const MAIN_SESSION_ROLE_ID = "main-session";
export const MAIN_SESSION_HANDLE = "main";
export const DEFAULT_CHAT_VIEW: ChatViewMode = "sessions";
export const CHAT_VIEW_MODES: readonly ChatViewMode[] = ["classic", "sessions"];

type ChatMetadataLike = Pick<ConversationMetadata, "mainSessionParticipantId" | "chatView"> & {
  participants?: unknown;
};

/** The Workflow Manager's role. The main session took its place, so it is no
 *  longer offered for new members; members that have it keep it. */
export const WORKFLOW_MANAGER_ROLE_ID = "workflow-manager";

/** Whether a user or an app tool may give a new member this role: not the
 *  main session's own (a chat makes its one main session itself), and not
 *  the Workflow Manager's (the User, 2026-11-20). A member or a saved member
 *  that has one already keeps it. */
export function isRoleOfferedForNewMembers(roleConfigId: string | undefined): boolean {
  return roleConfigId !== MAIN_SESSION_ROLE_ID && roleConfigId !== WORKFLOW_MANAGER_ROLE_ID;
}

/** The main session among these members, told by its role (the phone and
 *  the server know a chat's members, not always its metadata). With more
 *  than one (never made by the app), the one the chat names wins. */
export function mainSessionMemberOf<T extends { id: string; roleConfigId?: string }>(
  participants: readonly T[],
  namedId?: string
): T | undefined {
  const candidates = participants.filter((participant) => participant.roleConfigId === MAIN_SESSION_ROLE_ID);
  return candidates.find((participant) => participant.id === namedId) ?? candidates[0];
}

export function isChatViewMode(value: unknown): value is ChatViewMode {
  return value === "classic" || value === "sessions";
}

function participantsOf(metadata: ChatMetadataLike | undefined): ChatParticipant[] {
  const value = metadata?.participants;
  return Array.isArray(value) ? value.filter((item): item is ChatParticipant => Boolean(item) && typeof item === "object") : [];
}

/** The chat's main session member id, when the chat has one and it is still
 *  a member. */
export function mainSessionParticipantId(metadata: ChatMetadataLike | undefined): string | undefined {
  const id = metadata?.mainSessionParticipantId;
  if (typeof id !== "string" || !id) return undefined;
  return participantsOf(metadata).some((participant) => participant.id === id) ? id : undefined;
}

export function isMainSessionChat(metadata: ChatMetadataLike | undefined): boolean {
  return mainSessionParticipantId(metadata) !== undefined;
}

export function isMainSessionParticipant(metadata: ChatMetadataLike | undefined, participantId: string | undefined): boolean {
  return Boolean(participantId) && mainSessionParticipantId(metadata) === participantId;
}

/** Whether the chat's own view switch works: only a chat with a main session
 *  has two views (the User: "у старого чата задизейблен свитч"). */
export function canSwitchChatView(metadata: ChatMetadataLike | undefined): boolean {
  return isMainSessionChat(metadata);
}

/** The view the chat is shown in. */
export function chatViewFor(metadata: ChatMetadataLike | undefined, fallback?: ChatViewMode): ChatViewMode {
  if (!isMainSessionChat(metadata)) return "classic";
  if (isChatViewMode(metadata?.chatView)) return metadata.chatView;
  return isChatViewMode(fallback) ? fallback : DEFAULT_CHAT_VIEW;
}

/** The members a User's message was addressed to, as resolved where it was
 *  written (deliveryTargets for the server, askedParticipantIds for the
 *  device's own asks). */
export function chatMessageAddressees(message: Pick<ChatMessage, "metadata">): string[] {
  const metadata = message.metadata as { deliveryTargets?: unknown; askedParticipantIds?: unknown } | undefined;
  const ids: string[] = [];
  for (const value of [metadata?.deliveryTargets, metadata?.askedParticipantIds]) {
    if (!Array.isArray(value)) continue;
    for (const id of value) {
      if (typeof id === "string" && id && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

/** What the sessions view needs to know about the whole loaded chat once. */
export interface SessionsViewIndex {
  mainSessionParticipantId: string;
  /** A member's reply to a request, by the reply's id: who asked. */
  requestReplyRequesterById: Map<string, string>;
  /** The main session's continuation after its request was answered, by the
   *  message id: it belongs on the main timeline. */
  autoResumeMessageIds: Set<string>;
  /** Request messages by id, for the task cards and the member panels. */
  requestBatchByMessageId: Map<string, ChatParticipantRequestBatch>;
}

export function buildSessionsViewIndex(messages: readonly ChatMessage[], mainSessionId: string): SessionsViewIndex {
  const requestReplyRequesterById = new Map<string, string>();
  const autoResumeMessageIds = new Set<string>();
  const requestBatchByMessageId = new Map<string, ChatParticipantRequestBatch>();
  for (const message of messages) {
    const batch = message.metadata?.participantRequest;
    if (!batch) continue;
    requestBatchByMessageId.set(message.id, batch);
    if (batch.autoResumeMessageId) autoResumeMessageIds.add(batch.autoResumeMessageId);
    for (const item of batch.items) {
      if (item.replyMessageId) requestReplyRequesterById.set(item.replyMessageId, batch.requesterParticipantId);
    }
  }
  return { mainSessionParticipantId: mainSessionId, requestReplyRequesterById, autoResumeMessageIds, requestBatchByMessageId };
}

export type SessionsViewLane =
  | { kind: "main" }
  | { kind: "member"; participantId: string };

/**
 * Where a message lives in the sessions view.
 *
 * - The User's message: on the main timeline, unless it was addressed only
 *   to other members (written in a member's panel, or with their @handles),
 *   then in the first such member's session.
 * - The main session's message: on the main timeline (its request messages
 *   become task cards there), except its answer to a member's request, which
 *   is part of that member's session.
 * - Another member's message: in its own session.
 * - Anything else (system lines, scripts, summaries): on the main timeline;
 *   the timeline's own visibility rules still hide internal lines.
 */
export function sessionsViewLane(message: ChatMessage, index: SessionsViewIndex): SessionsViewLane {
  const mainId = index.mainSessionParticipantId;
  // A scheduled task's post wakes the members it names (askedParticipantIds),
  // the way a User's message addresses them: a wake-up of one member only is
  // part of that member's session.
  if (message.role === "user" || message.role === "script") {
    const others = chatMessageAddressees(message).filter((id) => id !== mainId);
    const addressedMain = chatMessageAddressees(message).includes(mainId);
    if (!addressedMain && others.length > 0) return { kind: "member", participantId: others[0]! };
    return { kind: "main" };
  }
  if (message.role === "participant" && message.participantId) {
    if (message.participantId === mainId) {
      const requester = index.requestReplyRequesterById.get(message.id);
      if (requester && requester !== mainId && !index.autoResumeMessageIds.has(message.id)) {
        return { kind: "member", participantId: requester };
      }
      return { kind: "main" };
    }
    return { kind: "member", participantId: message.participantId };
  }
  return { kind: "main" };
}

/** The tasks a request message gives, for its card: the main session's
 *  requests to other members. */
export function isMainSessionTaskMessage(message: ChatMessage, index: SessionsViewIndex): boolean {
  return message.role === "participant"
    && message.participantId === index.mainSessionParticipantId
    && Boolean(message.metadata?.participantRequest);
}

/** Every message of one member's session, in order: its own messages, what
 *  was asked of it (requests naming it, the User's messages to it) and the
 *  main session's answers to its questions. */
export function memberSessionMessages(
  messages: readonly ChatMessage[],
  participantId: string,
  index: SessionsViewIndex
): ChatMessage[] {
  return messages.filter((message) => {
    const lane = sessionsViewLane(message, index);
    if (lane.kind === "member" && lane.participantId === participantId) return true;
    const batch = message.metadata?.participantRequest;
    if (batch && batch.requesterParticipantId !== participantId) {
      return batch.items.some((item) => item.targetParticipantId === participantId);
    }
    if (message.role === "user") {
      return chatMessageAddressees(message).includes(participantId)
        && !(lane.kind === "member" && lane.participantId === participantId);
    }
    return false;
  });
}

/** A note that another member finished answering: the reply it leads back
 *  to is in that member's session and its task card already says the task is
 *  done, so the sessions view shows it nowhere. The main session's own note
 *  stays on the main timeline. */
export function isOtherMemberTurnFinishedNote(message: ChatMessage, index: SessionsViewIndex): boolean {
  const note = turnFinishedNoteOf(message);
  return Boolean(note) && note!.participantId !== index.mainSessionParticipantId;
}

/** The messages on the main timeline of the sessions view, in order. */
export function mainTimelineMessages(messages: readonly ChatMessage[], index: SessionsViewIndex): ChatMessage[] {
  return messages.filter((message) => sessionsViewLane(message, index).kind === "main" && !isOtherMemberTurnFinishedNote(message, index));
}

/** The members the main session is waiting on: targets of its requests whose
 *  item is still running. */
export function membersMainSessionWaitsOn(messages: readonly ChatMessage[], index: SessionsViewIndex): string[] {
  const waiting: string[] = [];
  for (const message of messages) {
    if (!isMainSessionTaskMessage(message, index)) continue;
    const batch = message.metadata!.participantRequest!;
    if (batch.resumeRequester === false) continue;
    for (const item of batch.items) {
      if ((item.status === "running" || item.status === "pending_approval") && !waiting.includes(item.targetParticipantId)) {
        waiting.push(item.targetParticipantId);
      }
    }
  }
  return waiting;
}

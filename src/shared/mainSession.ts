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
  ChatProviderKind,
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

/** The view a new chat opens in: Settings → General's choice, else the
 *  sessions view. The New chat screen follows it (members picker or model
 *  chip). */
export function newChatViewFor(defaultChatView: unknown): ChatViewMode {
  return isChatViewMode(defaultChatView) ? defaultChatView : DEFAULT_CHAT_VIEW;
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
      if (index.autoResumeMessageIds.has(message.id)) return { kind: "main" };
      const requester = index.requestReplyRequesterById.get(message.id) ?? answeredRequesterOf(message, index);
      if (requester && requester !== mainId) {
        return { kind: "member", participantId: requester };
      }
      return { kind: "main" };
    }
    return { kind: "member", participantId: message.participantId };
  }
  return { kind: "main" };
}

/** The member whose request the main session answers with this message,
 *  told by the request it answers (its source) rather than by the request's
 *  reply id, which is set only when the turn ends: so the answer is in that
 *  member's session from its first token, not on the main timeline first. */
function answeredRequesterOf(message: ChatMessage, index: SessionsViewIndex): string | undefined {
  const metadata = message.metadata as { sourceMessageId?: unknown; participantRequestBatchId?: unknown; participantRequest?: unknown } | undefined;
  if (metadata?.participantRequest || typeof metadata?.sourceMessageId !== "string") return undefined;
  const batch = index.requestBatchByMessageId.get(metadata.sourceMessageId);
  if (!batch || batch.requesterParticipantId === index.mainSessionParticipantId) return undefined;
  if (typeof metadata.participantRequestBatchId === "string" && metadata.participantRequestBatchId !== batch.id) return undefined;
  return batch.items.some((item) => item.targetParticipantId === index.mainSessionParticipantId) ? batch.requesterParticipantId : undefined;
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

/** A note that a member finished answering ("<X> finished answering"): the
 *  sessions view shows none, the main session's own included (the User,
 *  2026-11-21): a member's task row already says it is done, and the main
 *  session's reply is the newest thing on its timeline. The classic view
 *  keeps them. */
export function isSessionsHiddenTurnFinishedNote(message: Pick<ChatMessage, "role" | "metadata">): boolean {
  return turnFinishedNoteOf(message) !== undefined;
}

/** The messages on the main timeline of the sessions view, in order. */
export function mainTimelineMessages(messages: readonly ChatMessage[], index: SessionsViewIndex): ChatMessage[] {
  return messages.filter((message) => sessionsViewLane(message, index).kind === "main" && !isSessionsHiddenTurnFinishedNote(message));
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

/** Where each of the main session's tasks is shown on the main timeline of
 *  the sessions view: inside the reply of the turn that gave it (its "Worked
 *  for …" fold, or the reply's live activity while it runs), as in T3 Code.
 *  A task and its turn's reply answer the same message (their source). A task
 *  whose reply is not among these messages stays where it is. */
export interface SessionsTaskPlacement {
  /** The task messages shown inside each reply, by the reply's id. */
  tasksByReplyId: Map<string, ChatMessage[]>;
  /** The task messages shown inside a reply, not on their own. */
  placedTaskIds: Set<string>;
}

export function sessionsTaskPlacement(mainMessages: readonly ChatMessage[], index: SessionsViewIndex): SessionsTaskPlacement {
  const tasksByReplyId = new Map<string, ChatMessage[]>();
  const placedTaskIds = new Set<string>();
  const repliesBySource = new Map<string, ChatMessage[]>();
  for (const message of mainMessages) {
    if (message.role !== "participant" || message.participantId !== index.mainSessionParticipantId || message.metadata?.participantRequest) continue;
    const source = message.metadata?.sourceMessageId;
    if (typeof source !== "string" || !source) continue;
    const replies = repliesBySource.get(source) ?? [];
    replies.push(message);
    repliesBySource.set(source, replies);
  }
  for (const message of mainMessages) {
    if (!isMainSessionTaskMessage(message, index)) continue;
    const source = message.metadata?.sourceMessageId ?? message.metadata?.participantRequest?.triggerMessageId;
    const replies = typeof source === "string" ? repliesBySource.get(source) : undefined;
    if (!replies?.length) continue;
    // The reply its turn was writing when it gave the task (a turn's reply
    // starts before its tool calls), else the first one after it.
    const before = replies.filter((reply) => reply.createdAt <= message.createdAt);
    const reply = before[before.length - 1] ?? replies[0]!;
    const tasks = tasksByReplyId.get(reply.id) ?? [];
    tasks.push(message);
    tasksByReplyId.set(reply.id, tasks);
    placedTaskIds.add(message.id);
  }
  return { tasksByReplyId, placedTaskIds };
}

/** A member that wrote in the chat, or was given a task in it, and is no
 *  longer in it (the main session removes the members it made once their
 *  work is done). Its session stays readable. */
export interface SessionsFormerMember {
  id: string;
  handle: string;
  /** Its provider as its newest task named it (targetKind), so its logo
   *  stays once it is gone. */
  kind?: ChatProviderKind;
}

export function sessionsFormerMembers(
  messages: readonly ChatMessage[],
  participants: readonly { id: string }[],
  mainSessionId: string
): SessionsFormerMember[] {
  const current = new Set(participants.map((participant) => participant.id));
  const former = new Map<string, SessionsFormerMember>();
  const note = (id: string | undefined, handle: string | undefined, kind?: ChatProviderKind): void => {
    if (!id || id === mainSessionId || current.has(id)) return;
    const clean = (handle ?? "").trim().replace(/^@/, "");
    const known = former.get(id);
    if (!known) former.set(id, { id, handle: clean, ...(kind ? { kind } : {}) });
    else {
      if (!known.handle && clean) known.handle = clean;
      // Messages are oldest first: the newest task's provider wins.
      if (kind) known.kind = kind;
    }
  };
  for (const message of messages) {
    if (message.role === "participant") note(message.participantId, message.participantLabel);
    for (const item of message.metadata?.participantRequest?.items ?? []) {
      note(item.targetParticipantId, item.targetHandle, isProviderKind(item.targetKind) ? item.targetKind : undefined);
    }
  }
  return [...former.values()];
}

function isProviderKind(value: unknown): value is ChatProviderKind {
  return value === "codex-cli" || value === "claude-code" || value === "gemini-cli";
}

/** A User's message to the main session as the sessions view shows it: the
 *  leading mention of the main session (the default addressee there) left
 *  out. */
export function withoutLeadingMention(content: string, handle: string | undefined): string {
  const clean = (handle ?? "").trim().replace(/^@/, "");
  if (!clean) return content;
  const escaped = clean.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const stripped = content.replace(new RegExp(`^\\s*@${escaped}(?![\\w-])[\\s,:;]*`, "i"), "");
  return stripped.trim() ? stripped : content;
}

// What the sessions view shows about the main session's tasks and the chat's
// other members (docs/main-session.md): the status of each task card, its one
// line of result, the members panel's rows and the "Waiting on" line. Pure
// rules over the loaded messages, shared so the phone can show the same.

import { isPendingReply, isWaitingChoice } from "./chatActiveRuns";
import { stripChatControlBlocks } from "./chatControlBlocks";
import type { ChatParticipantRosterStatus } from "./chatParticipantStatus";
import { sessionsViewLane, type SessionsViewIndex } from "./mainSession";
import type { ChatMessage, ChatParticipant, ChatParticipantRequestBatch, ChatParticipantRequestItem } from "./types";

/** A task's or a member's state as the sessions view names it. */
export type SessionsWorkStatus = "running" | "waiting" | "done" | "failed" | "stopped" | "idle";

export const SESSIONS_WORK_STATUS_LABELS: Record<SessionsWorkStatus, string> = {
  running: "Running",
  waiting: "Waiting for you",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
  idle: "Idle"
};

/** Roster states in which a member is still working. */
export function isMemberWorking(status: ChatParticipantRosterStatus | undefined): boolean {
  return status === "running" || status === "compacting" || status === "background";
}

/** The state of one task the main session gave, from the task's own status
 *  and what its member is doing now. */
export function sessionsTaskStatus(
  item: Pick<ChatParticipantRequestItem, "status">,
  memberStatus?: ChatParticipantRosterStatus
): Exclude<SessionsWorkStatus, "idle"> {
  switch (item.status) {
    case "pending_approval":
      return "waiting";
    case "running":
      if (memberStatus === "pending") return "waiting";
      if (memberStatus === "stopped") return "stopped";
      if (memberStatus === "error") return "failed";
      return "running";
    case "answered":
    case "resuming_requester":
    case "completed":
      return "done";
    case "failed":
    case "denied":
      return "failed";
    case "interrupted":
    default:
      return "stopped";
  }
}

/** A member's state in the members panel: what it does now, else how its
 *  latest task ended. */
export function sessionsMemberStatus(
  memberStatus: ChatParticipantRosterStatus | undefined,
  task: Pick<ChatParticipantRequestItem, "status"> | undefined
): SessionsWorkStatus {
  if (memberStatus === "pending") return "waiting";
  if (isMemberWorking(memberStatus)) return "running";
  if (memberStatus === "stopped") return "stopped";
  if (memberStatus === "error") return "failed";
  return task ? sessionsTaskStatus(task, memberStatus) : "idle";
}

/** The first line of a text worth showing in one row: control blocks (a
 *  `User choice:` block) and markdown markers left out. */
export function firstTextLine(text: string | undefined, maxLength = 160): string {
  const lines = stripChatControlBlocks(text ?? "").split("\n");
  for (const raw of lines) {
    const line = raw
      .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, "")
      .replace(/\*\*|__|`/g, "")
      .trim();
    if (!line) continue;
    return line.length > maxLength ? `${line.slice(0, maxLength - 1).trimEnd()}…` : line;
  }
  return "";
}

/** One line of the member's reply to a task, once it answered. */
export function sessionsTaskReplyLine(
  item: Pick<ChatParticipantRequestItem, "replyMessageId">,
  messagesById: ReadonlyMap<string, ChatMessage>
): string | undefined {
  const reply = item.replyMessageId ? messagesById.get(item.replyMessageId) : undefined;
  if (!reply || reply.status === "pending") return undefined;
  return firstTextLine(reply.content) || undefined;
}

/** When the member's work on a task started: its reply in progress (the turn
 *  it runs now), else the time the task was given. */
export function sessionsTaskRunningSince(
  item: Pick<ChatParticipantRequestItem, "targetParticipantId" | "createdAt">,
  messages: readonly ChatMessage[]
): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (isPendingReply(message) && message.participantId === item.targetParticipantId && message.createdAt >= item.createdAt) {
      return message.createdAt;
    }
  }
  return item.createdAt;
}

/** A member's reply in progress, if it is answering now. */
export function memberRunningSince(participantId: string, messages: readonly ChatMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (isPendingReply(message) && message.participantId === participantId) return message.createdAt;
  }
  return undefined;
}

export interface SessionsMemberTask {
  messageId: string;
  batch: ChatParticipantRequestBatch;
  item: ChatParticipantRequestItem;
}

/** Each member's latest task: the newest request item that names it. */
export function latestTaskByMember(messages: readonly ChatMessage[]): Map<string, SessionsMemberTask> {
  const tasks = new Map<string, SessionsMemberTask>();
  for (const message of messages) {
    const batch = message.metadata?.participantRequest;
    if (!batch) continue;
    for (const item of batch.items) {
      const current = tasks.get(item.targetParticipantId);
      if (!current || current.item.createdAt <= item.createdAt) {
        tasks.set(item.targetParticipantId, { messageId: message.id, batch, item });
      }
    }
  }
  return tasks;
}

/** A member's message asking the User whether to bring in the members it
 *  mentioned, not yet answered (here or on her server). */
export function isWaitingMentionApproval(message: Pick<ChatMessage, "id" | "role" | "metadata">): boolean {
  const answered = message.metadata?.serverCard?.state === "answered" && message.metadata.serverCard.cardId === `mention:${message.id}`;
  return message.role === "participant" && !answered &&
    (message.metadata?.pendingMentions ?? []).some((mention) => mention.status === "pending");
}

/** Members' messages with a card that still waits for the User (a choice,
 *  or whether to bring in the members it mentioned): they stay on the main
 *  timeline although the message is in the member's session. */
export function openMemberCardMessages(messages: readonly ChatMessage[], index: SessionsViewIndex): ChatMessage[] {
  return messages.filter((message) =>
    (isWaitingChoice(message) || isWaitingMentionApproval(message)) && sessionsViewLane(message, index).kind === "member");
}

export interface SessionsMemberRow {
  participant: ChatParticipant;
  status: SessionsWorkStatus;
  task?: SessionsMemberTask;
}

/** The members panel: every member but the main session; those that worked
 *  and ended (their latest task done, failed or stopped, nothing running)
 *  under "Previous". */
export function sessionsMemberRows(
  participants: readonly ChatParticipant[],
  mainSessionId: string,
  statusById: ReadonlyMap<string, ChatParticipantRosterStatus>,
  tasks: ReadonlyMap<string, SessionsMemberTask>
): { current: SessionsMemberRow[]; previous: SessionsMemberRow[] } {
  const current: SessionsMemberRow[] = [];
  const previous: SessionsMemberRow[] = [];
  for (const participant of participants) {
    if (participant.id === mainSessionId) continue;
    const task = tasks.get(participant.id);
    const status = sessionsMemberStatus(statusById.get(participant.id), task?.item);
    const row = { participant, status, ...(task ? { task } : {}) };
    const finished = Boolean(task) && (status === "done" || status === "failed" || status === "stopped");
    (finished ? previous : current).push(row);
  }
  return { current, previous };
}

/** "N members · K running" for a task card with several members. */
export function sessionsTaskGroupLabel(statuses: readonly SessionsWorkStatus[]): string {
  const running = statuses.filter((status) => status === "running").length;
  const members = `${statuses.length} ${statuses.length === 1 ? "member" : "members"}`;
  return running > 0 ? `${members} · ${running} running` : members;
}

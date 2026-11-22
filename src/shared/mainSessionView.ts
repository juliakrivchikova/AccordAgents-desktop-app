// What the sessions view shows about the main session's tasks and the chat's
// other members (docs/main-session.md): the status of each task card, its one
// line of result, the members panel's rows and the "Waiting on" line. Pure
// rules over the loaded messages, shared so the phone can show the same.

import { isPendingReply, isWaitingChoice } from "./chatActiveRuns";
import { stripChatControlBlocks } from "./chatControlBlocks";
import type { ChatParticipantRosterStatus } from "./chatParticipantStatus";
import { sessionsViewLane, type SessionsViewIndex } from "./mainSession";
import { APP_PARTICIPANTS_REQUEST_CHANGE_TOOL } from "./appMcpToolContracts";
import type { ChatAppToolApproval, ChatMessage, ChatParticipant, ChatParticipantRequestBatch, ChatParticipantRequestItem } from "./types";

/** The ordinary member's role: the sessions view names no role for it. */
const GENERIC_MEMBER_ROLE_ID = "generic-participant";

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

/** Whether the member's stopped or failed state is about this task: it comes
 *  from the member's newest finished message, which may be the end of an
 *  earlier turn while this task waits in its queue or its machine prepares.
 *  Only a message written since the task was given speaks for it. */
function endedSinceTask(item: Pick<ChatParticipantRequestItem, "createdAt">, memberFinishedAt: string | undefined): boolean {
  return memberFinishedAt !== undefined && memberFinishedAt >= item.createdAt;
}

/** The state of one task the main session gave, from the task's own status
 *  and what its member is doing now. `memberFinishedAt`: when the member's
 *  newest finished message was written (sessionsMemberActivity). */
export function sessionsTaskStatus(
  item: Pick<ChatParticipantRequestItem, "status" | "createdAt">,
  memberStatus?: ChatParticipantRosterStatus,
  memberFinishedAt?: string
): Exclude<SessionsWorkStatus, "idle"> {
  switch (item.status) {
    case "pending_approval":
      return "waiting";
    case "running":
      if (memberStatus === "pending") return "waiting";
      if (memberStatus === "stopped" && endedSinceTask(item, memberFinishedAt)) return "stopped";
      if (memberStatus === "error" && endedSinceTask(item, memberFinishedAt)) return "failed";
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
 *  latest task ended. A stopped or failed turn from before its latest task
 *  was given does not hide that task. */
export function sessionsMemberStatus(
  memberStatus: ChatParticipantRosterStatus | undefined,
  task: Pick<ChatParticipantRequestItem, "status" | "createdAt"> | undefined,
  memberFinishedAt?: string
): SessionsWorkStatus {
  if (memberStatus === "pending") return "waiting";
  if (isMemberWorking(memberStatus)) return "running";
  const stale = task !== undefined && !endedSinceTask(task, memberFinishedAt);
  if (memberStatus === "stopped" && !stale) return "stopped";
  if (memberStatus === "error" && !stale) return "failed";
  return task ? sessionsTaskStatus(task, memberStatus, memberFinishedAt) : "idle";
}

/** What every member's messages say about it, read in one pass per change
 *  of the loaded chat: its reply in progress (newest) and when its newest
 *  finished message was written. */
export interface SessionsMemberActivity {
  runningSince: ReadonlyMap<string, string>;
  finishedAt: ReadonlyMap<string, string>;
}

export function sessionsMemberActivity(messages: readonly ChatMessage[]): SessionsMemberActivity {
  const runningSince = new Map<string, string>();
  const finishedAt = new Map<string, string>();
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "participant" || !message.participantId) continue;
    const target = isPendingReply(message) ? runningSince : finishedAt;
    if (!target.has(message.participantId)) target.set(message.participantId, message.createdAt);
  }
  return { runningSince, finishedAt };
}

/** The first line of a text worth showing in one row: control blocks (a
 *  `User choice:` block) and markdown markers left out. */
export function firstTextLine(text: string | undefined, maxLength = 160): string {
  const lines = stripChatControlBlocks(text ?? "").split("\n");
  for (const raw of lines) {
    const line = raw
      .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, "")
      // A markdown link or image shows its text only ("[the resolution](#artifact:…)").
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
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

/** The longest a task's title made from its text runs, "…" included. */
export const SESSIONS_TASK_TITLE_MAX_CHARS = 40;
/** The longest a title the main session gave is kept. */
export const SESSIONS_TASK_GIVEN_TITLE_MAX_CHARS = 80;

/** A text cut at a word boundary to `max` characters at most, "…" included
 *  when it was cut. */
export function shortenAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = text.slice(0, Math.max(1, max - 1));
  const space = room.lastIndexOf(" ");
  const cut = (space > 0 ? room.slice(0, space) : room).replace(/[\s,;:.!?—–-]+$/u, "");
  return `${cut || room}…`;
}

/** A task's short title, as T3 Code titles a thread ("Спросить у Claude, как
 *  дела"): the one the main session gave it (app_chat_delegate_task), else
 *  the task's first sentence without its full stop, cut at a word to
 *  SESSIONS_TASK_TITLE_MAX_CHARS. Empty for a task without text. */
export function sessionsTaskTitle(item: Pick<ChatParticipantRequestItem, "prompt"> & { title?: unknown; targetHandle?: string }): string {
  const given = typeof item.title === "string" ? item.title.replace(/\s+/g, " ").trim() : "";
  if (given) return shortenAtWord(given, SESSIONS_TASK_GIVEN_TITLE_MAX_CHARS);
  // A task the app made from a reply that mentioned the member, before such
  // tasks were titled when made: titled from the reply's words it quotes.
  const excerpt = inferredTaskExcerpt(item.prompt);
  if (excerpt !== undefined) return sessionsMentionSentenceTitle(excerpt, item.targetHandle, { excerpt: true });
  const line = firstTextLine(typeof item.prompt === "string" ? item.prompt : "", Number.MAX_SAFE_INTEGER);
  const sentence = /^.+?[.!?…](?=\s|$)/u.exec(line)?.[0] ?? line;
  const plain = sentence.replace(/[\s.,;:]+$/u, "") || sentence;
  return shortenAtWord(plain, SESSIONS_TASK_TITLE_MAX_CHARS);
}

/** The title of a task with no words of its own left once its @-names are
 *  gone (sessionsMentionSentenceTitle). */
export const SESSIONS_UNNAMED_TASK_TITLE = "Agent";

/** The most of a sentence read for a title: far more than a title keeps, so
 *  a sentence of any length costs the same (a very long reply line must not
 *  stall the app). */
const MENTION_SENTENCE_MAX_CHARS = 400;

/** An `@handle` of anybody (letters, digits, "_" and "-") as a word, not
 *  inside an e-mail address, a path or a package name such as `@types/node`;
 *  a possessive "'s" after it goes with it. */
const ANY_MENTION_PATTERN = /(^|[^A-Za-z0-9_@./\\-])@[A-Za-z0-9_-]+(?:['’]s)?(?![A-Za-z0-9_\-/])/g;

function escapeForPattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A known member's `@handle` wherever it stands (after a dot, a slash or a
 *  dash too, as a reply mentions it), not inside a longer word or an e-mail
 *  address; a possessive "'s" after it goes with it. */
function knownMentionPattern(handle: string): RegExp {
  return new RegExp(`(^|[^A-Za-z0-9_])@${escapeForPattern(handle)}(?:['’]s)?(?![A-Za-z0-9_-])`, "gi");
}

/** The words a task the app made from a member's reply quotes from it
 *  (ChatService.inferredParticipantRequestPrompt: its first line says who
 *  appeared to ask, the next one quotes the reply); undefined for any other
 *  task. */
function inferredTaskExcerpt(prompt: unknown): string | undefined {
  if (typeof prompt !== "string" || !prompt.startsWith("@")) return undefined;
  const firstEnd = prompt.indexOf("\n");
  if (firstEnd < 0) return undefined;
  if (!/^@[A-Za-z0-9_-]{1,32} appeared to request your input in this chat reply\.$/.test(prompt.slice(0, firstEnd).trim())) return undefined;
  const secondEnd = prompt.indexOf("\n", firstEnd + 1);
  const quoted = /^Relevant excerpt: ?(.*)$/s.exec(prompt.slice(firstEnd + 1, secondEnd < 0 ? undefined : secondEnd));
  return quoted ? quoted[1]! : undefined;
}

/**
 * The title of a task the app made because a member's reply mentioned
 * another member (an inferred request): the reply's first sentence that
 * mentions `@targetHandle`, with no @-names, since the sessions view names
 * nobody by handle (the User, 2026-11-22). Its words stay as written (inline
 * code as its text); what removing a name leaves empty (brackets, emphasis,
 * a table cell) goes too. Cut at a word to SESSIONS_TASK_TITLE_MAX_CHARS, as
 * a task's own first sentence is; SESSIONS_UNNAMED_TASK_TITLE when no words
 * remain.
 *
 * `at`: where the mention the request was made from starts (its "@"), when
 * known; otherwise the first mention of `targetHandle`, else of anybody.
 * `handles`: the chat's members' handles, removed wherever they stand.
 * `excerpt`: the text is a quote that may start inside a word (a task made
 * before such tasks were titled), so a sentence that starts with the quote
 * drops its first, possibly cut, word.
 */
export function sessionsMentionSentenceTitle(
  reply: string,
  targetHandle?: string,
  options: { at?: number; handles?: readonly string[]; excerpt?: boolean } = {}
): string {
  const text = typeof reply === "string" ? reply : "";
  const wanted = targetHandle?.trim().replace(/^@/, "");
  let at = typeof options.at === "number" && options.at >= 0 && options.at < text.length ? options.at : -1;
  if (at < 0 && wanted) {
    const found = new RegExp(`@${escapeForPattern(wanted)}(?![A-Za-z0-9_-])`, "i").exec(text);
    if (found) at = found.index;
  }
  if (at < 0) {
    ANY_MENTION_PATTERN.lastIndex = 0;
    const found = ANY_MENTION_PATTERN.exec(text);
    ANY_MENTION_PATTERN.lastIndex = 0;
    at = found ? found.index + found[1]!.length : 0;
  }
  // Its sentence: from the end of the one before (or the line's start) to
  // its own end; a dot inside a word or a number ends none.
  let start = -1;
  for (let index = at - 1; index >= 0; index -= 1) {
    const char = text[index]!;
    if (char === "\n" || (/[.!?…]/u.test(char) && /\s/u.test(text[index + 1] ?? ""))) {
      start = index + 1;
      break;
    }
  }
  if (start < 0) {
    start = 0;
    if (options.excerpt && at >= 100) {
      const space = text.search(/\s/u);
      if (space >= 0 && space < at) start = space + 1;
    }
  }
  let end = text.length;
  for (let index = at; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === "\n") {
      end = index;
      break;
    }
    if (/[.!?…]/u.test(char) && (index + 1 === text.length || /\s/u.test(text[index + 1]!))) {
      end = index + 1;
      break;
    }
  }
  let sentence = text.slice(start, Math.min(end, start + MENTION_SENTENCE_MAX_CHARS)).replace(/[\u200B-\u200D\uFEFF]/gu, "");
  const known = [...new Set([...(options.handles ?? []), ...(wanted ? [wanted] : [])].map((handle) => handle.trim().replace(/^@/, "")).filter(Boolean))]
    .sort((left, right) => right.length - left.length);
  for (const handle of known) sentence = sentence.replace(knownMentionPattern(handle), "$1");
  const plain = firstTextLine(sentence.replace(ANY_MENTION_PATTERN, "$1"), Number.MAX_SAFE_INTEGER)
    .replace(/~~|\*/g, "")
    .replace(/<(\w+)[^>]*>\s*<\/\1>|\(\s*\)|\[\s*\]|\{\s*\}/g, "")
    .replace(/\|(?:\s*\|)+/g, "|")
    .replace(/\s+/g, " ")
    .replace(/\s+([,;:.!?…)\]])/gu, "$1")
    .replace(/([(\[])\s+/gu, "$1")
    .replace(/^[\s,;:.!?…—–|/-]+/u, "")
    .replace(/[\s.,;:—–|/-]+$/u, "")
    .trim();
  if (!/[\p{L}\p{N}]/u.test(plain)) return SESSIONS_UNNAMED_TASK_TITLE;
  return shortenAtWord(plain, SESSIONS_TASK_TITLE_MAX_CHARS);
}

/** A member's title in the sessions view (as in T3 Code): its current or
 *  latest task's title (sessionsTaskTitle); its handle without "@" only
 *  while it has none. */
export function sessionsMemberTitle(
  member: { handle?: string } | undefined,
  task?: Pick<ChatParticipantRequestItem, "prompt" | "targetHandle"> & { title?: unknown }
): string {
  return (task ? sessionsTaskTitle(task) : "") || (member?.handle ?? task?.targetHandle ?? "").trim().replace(/^@/, "") || "Session";
}

/** The line under a member's title: its provider, model and role (the role
 *  only when it is not the ordinary member's). */
export function sessionsMemberDetail(parts: { provider?: string; model?: string; roleLabel?: string; roleConfigId?: string }): string {
  const role = parts.roleConfigId && parts.roleConfigId !== GENERIC_MEMBER_ROLE_ID ? parts.roleLabel : undefined;
  return [parts.provider, parts.model, role].map((part) => part?.trim()).filter(Boolean).join(" · ");
}

/** The line at the end of the main timeline while the main session waits.
 *  The sessions view never says "members" (the User, 2026-11-21): it waits
 *  on tasks. */
export function sessionsWaitingText(titles: readonly string[]): string {
  return `Waiting on ${titles.length} ${titles.length === 1 ? "task" : "tasks"}: ${titles.join(", ")}`;
}

/** The summary heading the delegations inside a reply's "Worked for …". */
export function sessionsDelegationSummary(count: number): string {
  return `Delegated ${count} ${count === 1 ? "task" : "tasks"}`;
}

/** One task of a request as the sessions view shows it: whom it went to, its
 *  title, its state, since when it runs, how long it took and one line of
 *  its result or error. Worked out once per change of the loaded chat. */
export interface SessionsTaskEntry {
  messageId: string;
  item: ChatParticipantRequestItem;
  title: string;
  status: Exclude<SessionsWorkStatus, "idle">;
  /** While it runs: when its member's work on it started. */
  since?: string;
  /** Once it ended: how long it took. */
  durationMs?: number;
  /** One line of the member's reply, or of why it failed; "Stopped" for a
   *  stopped task. */
  line?: string;
  /** The line is a state, not words of the member (shown muted). */
  lineMuted?: true;
}

/** The sessions view's words for a member no longer in the chat. */
export const SESSIONS_REMOVED_MEMBER_DETAIL = "Removed from the chat";

export function sessionsTaskEntries(
  message: Pick<ChatMessage, "id">,
  batch: Pick<ChatParticipantRequestBatch, "items">,
  statusById: ReadonlyMap<string, ChatParticipantRosterStatus>,
  activity: SessionsMemberActivity,
  messagesById: ReadonlyMap<string, ChatMessage>,
  /** The sessions view's words for what the app wrote (why a task failed),
   *  without handles (sessionsViewText). */
  appText: (text: string) => string = (text) => text,
  /** The view's reading of a member's own words (its reply's line), by its
   *  mention rule (sessionsMentionText). */
  wordsText: (text: string) => string = (text) => text
): SessionsTaskEntry[] {
  return batch.items.map((item) => {
    const memberId = item.targetParticipantId;
    const status = sessionsTaskStatus(item, statusById.get(memberId), activity.finishedAt.get(memberId));
    const running = activity.runningSince.get(memberId);
    const reply = item.replyMessageId ? messagesById.get(item.replyMessageId) : undefined;
    const worked = typeof reply?.metadata?.workedMs === "number" && Number.isFinite(reply.metadata.workedMs) ? reply.metadata.workedMs : undefined;
    const elapsed = item.updatedAt ? Date.parse(item.updatedAt) - Date.parse(item.createdAt) : NaN;
    const replyLine = status === "done" ? sessionsTaskReplyLine(item, messagesById) : undefined;
    const line = status === "done" ? (replyLine ? wordsText(replyLine) : replyLine)
      : status === "failed" ? appText(firstTextLine(item.error)) || undefined
        : status === "stopped" ? SESSIONS_WORK_STATUS_LABELS.stopped : undefined;
    return {
      messageId: message.id,
      item,
      title: sessionsMemberTitle(undefined, item),
      status,
      ...(status === "running" ? { since: running && running >= item.createdAt ? running : item.createdAt } : {}),
      ...(status !== "running" && status !== "waiting" && (worked ?? elapsed) >= 0 ? { durationMs: worked ?? elapsed } : {}),
      ...(line ? { line } : {}),
      ...(status === "stopped" ? { lineMuted: true as const } : {})
    };
  });
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

/** The members panel: every member but the main session; while some member
 *  is running or waits for the User, those that worked and ended (their
 *  latest task done, failed or stopped) under "Previous". With nobody at
 *  work, every member is listed as it is, so the panel is never a lone
 *  folded group. */
export function sessionsMemberRows(
  participants: readonly ChatParticipant[],
  mainSessionId: string,
  statusById: ReadonlyMap<string, ChatParticipantRosterStatus>,
  tasks: ReadonlyMap<string, SessionsMemberTask>,
  finishedAt?: ReadonlyMap<string, string>
): { current: SessionsMemberRow[]; previous: SessionsMemberRow[] } {
  const rows: SessionsMemberRow[] = participants.flatMap((participant) => {
    if (participant.id === mainSessionId) return [];
    const task = tasks.get(participant.id);
    const status = sessionsMemberStatus(statusById.get(participant.id), task?.item, finishedAt?.get(participant.id));
    return [{ participant, status, ...(task ? { task } : {}) }];
  });
  if (!rows.some((row) => row.status === "running" || row.status === "waiting")) {
    return { current: rows, previous: [] };
  }
  const finished = (row: SessionsMemberRow): boolean =>
    Boolean(row.task) && (row.status === "done" || row.status === "failed" || row.status === "stopped");
  return { current: rows.filter((row) => !finished(row)), previous: rows.filter(finished) };
}

/** "N tasks · K running" for a task card that gave several tasks. */
export function sessionsTaskGroupLabel(statuses: readonly SessionsWorkStatus[]): string {
  const running = statuses.filter((status) => status === "running").length;
  const tasks = `${statuses.length} ${statuses.length === 1 ? "task" : "tasks"}`;
  return running > 0 ? `${tasks} · ${running} running` : tasks;
}

/** A former member's row (shared/mainSession.ts sessionsFormerMembers): how
 *  its latest task ended; nothing while that task still says it runs. */
export function sessionsFormerMemberStatus(task: Pick<ChatParticipantRequestItem, "status" | "createdAt"> | undefined): SessionsWorkStatus {
  if (!task) return "idle";
  const status = sessionsTaskStatus(task);
  return status === "running" || status === "waiting" ? "idle" : status;
}

/** A member the main session added for a task, applied without a card (its
 *  delegation, docs/main-session.md): the sessions view does not show the
 *  "member added" card, the task already says it. A card that waits for the
 *  User, or any other change, stays. */
export function isMainSessionDelegationRosterCard(
  approval: Pick<ChatAppToolApproval, "status" | "toolName" | "requesterParticipantId" | "request">,
  mainSessionId: string
): boolean {
  if (approval.status !== "auto-applied" || approval.toolName !== APP_PARTICIPANTS_REQUEST_CHANGE_TOOL || approval.requesterParticipantId !== mainSessionId) {
    return false;
  }
  const operations = (approval.request as { operations?: Array<{ type?: unknown }> } | undefined)?.operations;
  return Array.isArray(operations) && operations.length > 0 &&
    operations.every((operation) => operation?.type === "add_new_participant_to_chat" || operation?.type === "add_existing_participant_to_chat");
}

/** The longest handle a member can have. */
export const SESSIONS_MENTION_HANDLE_MAX_CHARS = 32;

/** A piece of text as the sessions view shows it: as written, or a member's
 *  `@handle` (as written, without the "@"), shown as that member's chip. */
export type SessionsMentionPiece = { text: string; handle?: undefined } | { handle: string; text?: undefined };

/**
 * A member's handle in a message, in the sessions view (docs/main-session.md):
 * one rule for the desktop and the phone, inside code and outside it. Only an
 * exact `@handle` of a member of the chat or a former one (`isMember`, given
 * the handle in lower case) is that member's chip: at most 32 characters, not
 * part of a longer word, an e-mail address, a path or a package name such as
 * `@types/node`. The main session's handle (`isMainSession`) is shown as a
 * plain word without its "@" (the sessions view has no handles, the User,
 * 2026-11-20). Everything else, handles of nobody included, stays as written.
 */
export function sessionsMentionPieces(
  text: string,
  isMember: (handle: string) => boolean,
  isMainSession: (handle: string) => boolean = () => false
): SessionsMentionPiece[] {
  const source = typeof text === "string" ? text : "";
  const pattern = /(^|[^A-Za-z0-9_@./\\-])@([A-Za-z0-9][A-Za-z0-9_-]*)(?![A-Za-z0-9_\-/])/g;
  const pieces: SessionsMentionPiece[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const handle = match[2]!;
    if (handle.length > SESSIONS_MENTION_HANDLE_MAX_CHARS) continue;
    const main = isMainSession(handle.toLowerCase());
    if (!main && !isMember(handle.toLowerCase())) continue;
    const start = match.index + match[1]!.length;
    if (start > cursor) pieces.push({ text: source.slice(cursor, start) });
    pieces.push(main ? { text: handle } : { handle });
    cursor = start + 1 + handle.length;
  }
  if (cursor < source.length) pieces.push({ text: source.slice(cursor) });
  return pieces;
}

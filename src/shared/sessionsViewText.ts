// The sessions view names nobody by handle (the User, 2026-11-21: "and so
// that I never see this crap '@main' anywhere in the UI"; docs/main-session.md).
// What the app itself writes — notices, failed replies, cards, Activity rows,
// status lines — is stored with handles, as members read it; the sessions view
// rewrites it when it shows it, so the classic view keeps every word as today
// and a chat switched back and forth shows each view's words.
//
// A member is named as the side panel names it: its current or latest task's
// title (sessionsMemberTitle), in quotes inside a sentence. The main session is
// named by nothing: a sentence about it loses its subject ("Stopped before it
// returned a response."), and elsewhere it is "it". What a member wrote itself
// is never passed through here.

import { chatViewFor, mainSessionParticipantId, sessionsFormerMembers } from "./mainSession";
import { sessionsMemberTitle, sessionsMentionPieces, titleTaskByMember } from "./mainSessionView";
import type { ChatMessage, ChatParticipant, ChatViewMode, ConversationMetadata } from "./types";

/** How the sessions view names a chat's members. */
export interface SessionsViewNames {
  /** The main session's handle, lower case, without "@". */
  mainHandle?: string;
  /** A member's or former member's title, by its handle in lower case
   *  without "@"; undefined for a handle of nobody in the chat. */
  titleOf: (handle: string) => string | undefined;
}

function cleanHandle(handle: unknown): string {
  return typeof handle === "string" ? handle.trim().replace(/^@+/, "").toLowerCase() : "";
}

/** A title as the sessions view's sentences quote it: a handle in it (a task's
 *  first sentence may name one, "Ask @gera to check") loses its "@". */
function titleWithoutHandles(title: string): string {
  return title.replace(/(^|[^A-Za-z0-9_@./\\-])@([A-Za-z0-9][A-Za-z0-9_-]*)/g, "$1$2").replace(/[\uE000-\uE002]/g, "");
}

export function sessionsViewNames(mainHandle: string | undefined, titles: Iterable<readonly [string, string]>): SessionsViewNames {
  const byHandle = new Map<string, string>();
  for (const [handle, title] of titles) {
    const key = cleanHandle(handle);
    if (key && typeof title === "string" && title) byHandle.set(key, titleWithoutHandles(title));
  }
  const main = cleanHandle(mainHandle) || undefined;
  return { ...(main ? { mainHandle: main } : {}), titleOf: (handle) => byHandle.get(cleanHandle(handle)) };
}

type ChatLike = {
  metadata?: Pick<ConversationMetadata, "mainSessionParticipantId" | "chatView"> & { participants?: unknown };
  messages?: readonly ChatMessage[];
};

/** A chat's names in the sessions view, from its members and loaded
 *  messages (the same titles as the side panel); undefined when the chat is
 *  shown in the classic view. */
export function sessionsViewNamesOf(
  chat: ChatLike | undefined,
  fallbackView?: ChatViewMode,
  /** A member's task title read elsewhere (its task message is not among
   *  the loaded ones), by its id. */
  knownTitles?: ReadonlyMap<string, string>
): SessionsViewNames | undefined {
  if (!chat || chatViewFor(chat.metadata, fallbackView) !== "sessions") return undefined;
  const mainId = mainSessionParticipantId(chat.metadata);
  if (!mainId) return undefined;
  const participants = (Array.isArray(chat.metadata?.participants) ? chat.metadata.participants : [])
    .filter((item): item is ChatParticipant => Boolean(item) && typeof item === "object" && typeof (item as ChatParticipant).id === "string");
  const messages = chat.messages ?? [];
  const tasks = titleTaskByMember(messages);
  const titles: Array<[string, string]> = [];
  const titleOf = (member: { id: string; handle?: string; taskTitle?: unknown }): string => {
    const task = tasks.get(member.id)?.item;
    // The title kept with the member names it before any task read here.
    const kept = typeof member.taskTitle === "string" && member.taskTitle.trim().length > 0;
    return task || kept ? sessionsMemberTitle(member, task) : knownTitles?.get(member.id) ?? sessionsMemberTitle(member, undefined);
  };
  for (const member of sessionsFormerMembers(messages, participants, mainId)) {
    if (member.handle) titles.push([member.handle, titleOf(member)]);
  }
  for (const participant of participants) {
    if (participant.id !== mainId && typeof participant.handle === "string") {
      titles.push([participant.handle, titleOf(participant)]);
    }
  }
  return sessionsViewNames(participants.find((participant) => participant.id === mainId)?.handle, titles);
}

/** Who a label names in the sessions view: "" for the main session (it is
 *  named by nothing, so a "who" line shows no name), a member's title, else
 *  the handle without its "@". */
export function sessionsViewLabel(handle: string | undefined, names: SessionsViewNames): string {
  const key = cleanHandle(handle);
  if (!key) return "";
  if (key === names.mainHandle) return "";
  return names.titleOf(key) ?? (handle as string).trim().replace(/^@+/, "");
}

// Handles stand in for the rules below as private-use marks: the main
// session one mark, a member its title between two. Every rule is built once.
const MAIN = "\uE000";
const OPEN = "\uE001";
const CLOSE = "\uE002";
const MARKS = /[\uE000-\uE002]/g;
const HANDLE = /(^|[^A-Za-z0-9_@./\\-])@([A-Za-z0-9][A-Za-z0-9_-]*)(?![A-Za-z0-9_\-/])/g;
/** Words kept as written: a quoted command, path or title, and code. */
const QUOTED = /("[^"\n]*"|`[^`\n]*`|“[^”\n]*”)/;
/** Any one named party: the main session, a member, or a handle of nobody
 *  here (a fork's source names a member of another chat). */
const ANY = `(?:${MAIN}|${OPEN}[^${CLOSE}]*${CLOSE}|@[A-Za-z0-9][A-Za-z0-9_-]*)`;
const SENTENCE_START = "(^|[.!?]\\s+|\\n\\s*)";
/** Verbs a sentence cannot start with once its subject is gone ("Is busy."):
 *  the main session is "It" there. */
const STATIVE = "(?:is|was|has|had|does|did|runs|belongs|cannot|can't|isn't|wasn't|doesn't|hasn't|will|would|may|starts)";

// The fork's notices (postForkNotice), written so they need no subject.
// Matched by their start and end, so a notice cut to the notices' length
// still reads right.
const FORK_COPY_MAY_INCLUDE = new RegExp(`^${MAIN}'s copy of ${ANY}'s session may include what ${ANY} did after you tapped Fork:`);
const FORK_STARTED_FROM = new RegExp(`^${MAIN} could not start from a copy of ${ANY}'s session in the chat `);
const FORK_COPY_OF_MAIN = new RegExp(`copy of ${MAIN}'s session`, "g");
/** The words such a notice used before 2026-11-22, kept for the notices
 *  stored with them; it now says "the session it was forked from". */
const FORK_COPY_OF_LABEL = /copy of the main session's session/g;

/** The main session's mark, wherever it is left, as a sentence without a
 *  name: no subject at a sentence's start, out of a list of names, nothing
 *  after "from", "for" or "by" at a clause's end, nothing after an action done
 *  to it, else "it". In order. */
const MAIN_RULES: ReadonlyArray<readonly [RegExp, string | ((...groups: string[]) => string)]> = [
  [new RegExp(`(${CLOSE})(?:,\\s*|\\s+and\\s+)${MAIN}(?![A-Za-z0-9'])`, "g"), "$1"],
  [new RegExp(`${MAIN}(?:,\\s*|\\s+and\\s+)(${OPEN})`, "g"), "$1"],
  [new RegExp(`${SENTENCE_START}${MAIN}:\\s+(\\S)`, "g"), (_m, start, next) => `${start}${next!.toUpperCase()}`],
  [new RegExp(`${SENTENCE_START}${MAIN}'s\\s+`, "g"), (_m, start) => `${start}The `],
  [new RegExp(`${SENTENCE_START}${MAIN}\\s+(?=${STATIVE}\\b)`, "g"), (_m, start) => `${start}It `],
  [new RegExp(`${SENTENCE_START}${MAIN}\\s+(\\S)`, "g"), (_m, start, next) => `${start}${next!.toUpperCase()}`],
  [new RegExp(`${MAIN}'s\\s+`, "g"), "the "],
  [new RegExp(`(^|\\s)(?:from|for|by)\\s${MAIN}(?=[:.,;)!?]|$)`, "g"), ""],
  [new RegExp(`\\bReturning (choice )?to ${MAIN}(?=[.,;:!?]|$)`, "g"), (_m, choice) => (choice ? "Returning the choice" : "Returning")],
  [new RegExp(`\\b(compact|Compact)\\s${MAIN}\\s+context\\b`, "g"), "$1 the context"],
  [new RegExp(`\\bonly to ${MAIN}(?=[.,;]|$)`, "g"), "only to this session"],
  [new RegExp(`\\b(Compacting|Compacted|compacting|compact|Compact|Restarting|Restarted|restarting|restart|Restart|Resuming|Auto-resumed|Moving|moving)\\s${MAIN}(?=[\\s.,;:!?]|$)`, "g"), "$1"],
  [new RegExp(`${SENTENCE_START}${MAIN}`, "g"), (_m, start) => `${start}It`],
  [new RegExp(MAIN, "g"), "it"]
];
const MEMBER_POSSESSIVE = new RegExp(`${OPEN}([^${CLOSE}]*)${CLOSE}'s\\b`, "g");
const MEMBER = new RegExp(`${OPEN}([^${CLOSE}]*)${CLOSE}`, "g");

function forkNotices(text: string): string {
  let result = text.replace(FORK_COPY_MAY_INCLUDE, "The copy may include what was done after you tapped Fork:");
  if (FORK_STARTED_FROM.test(result)) {
    result = result
      .replace(FORK_STARTED_FROM, "Could not start from a copy of the session in the chat ")
      .replace(/, so it starts a clean session\.?$/, ", so this chat starts a clean session.")
      .replace(/, so its next turn starts a clean session\.?$/, ", so the next turn starts a clean session.")
      .replace(/, so it started a clean session from the saved chat context\.?$/, ", so this chat started a clean session from the saved chat context.");
  }
  // A member made as a fork of the main session's own session.
  return result.replace(FORK_COPY_OF_MAIN, "copy of this chat's session").replace(FORK_COPY_OF_LABEL, "copy of this chat's session");
}

function withoutMainSession(text: string): string {
  return MAIN_RULES.reduce((current, [pattern, replacement]) =>
    typeof replacement === "string" ? current.replace(pattern, replacement) : current.replace(pattern, replacement as (...groups: string[]) => string), text);
}

function withMemberTitles(text: string): string {
  return text.replace(MEMBER_POSSESSIVE, "“$1”’s").replace(MEMBER, "“$1”");
}

/**
 * Text the app wrote, as the sessions view shows it: every `@handle` of the
 * main session or a member gone (a member by its title in quotes, the main
 * session by no name at all); handles of nobody in the chat, and anything in
 * quotes or backticks (a command, a path, a chat's title), stay as written.
 * Without names (the classic view) the text is returned as it is.
 */
export function sessionsViewText(text: string, names: SessionsViewNames | undefined): string {
  if (!names || typeof text !== "string" || !text.includes("@")) return text;
  let named = false;
  const mark = (part: string): string => part.replace(HANDLE, (match, before: string, handle: string) => {
    const key = handle.toLowerCase();
    if (key === names.mainHandle) {
      named = true;
      return `${before}${MAIN}`;
    }
    const title = names.titleOf(key);
    if (title === undefined) return match;
    named = true;
    return `${before}${OPEN}${title.replace(MARKS, "")}${CLOSE}`;
  });
  const marked = text.replace(MARKS, "").split(QUOTED).map((part, index) => (index % 2 === 1 ? part : mark(part))).join("");
  if (!named) return text;
  return withMemberTitles(withoutMainSession(forkNotices(marked)));
}

/**
 * A member's reply the app ended (failed, stopped, not started), as the
 * sessions view shows it: only the app's own paragraphs (those that start with
 * the member's handle, as every failure and stop line does, or say a Stop was
 * not confirmed for it) name nobody by handle; what the member wrote before
 * it failed stays its own words.
 */
export function sessionsViewReplyText(content: string, authorHandle: string | undefined, names: SessionsViewNames | undefined): string {
  if (!names || typeof content !== "string" || !content.includes("@")) return content;
  const own = cleanHandle(authorHandle);
  if (!own) return content;
  const escaped = own.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const appMade = new RegExp(`^\\s*(?:@${escaped}(?![A-Za-z0-9_-])|Stop not confirmed for @${escaped}(?![A-Za-z0-9_-]))`, "i");
  return content.split(/(\n{2,})/).map((part) => (appMade.test(part) ? sessionsViewText(part, names) : part)).join("");
}

/** A tool's own request, worded by its CLI's ask: a Claude tool ("Use Bash:
 *  <command or reason>") or Codex ("Codex wants to run: <command>", "Codex
 *  Auto Review denied: <command>"). Never reworded. */
const TOOL_REQUEST_SUMMARY = /^(?:Use [^\s:]+(?::|$)|Codex )/;

/**
 * An approval's summary, as the sessions view shows it: the app's words about
 * who asks and whom it names ("Grant @drew file edits", "Remove @gera from
 * this chat") without handles; a tool's request ("Use Bash: <the command or
 * the member's reason>", "Codex wants to run: <command>") exactly as written.
 */
export function sessionsViewSummaryText(summary: string, names: SessionsViewNames | undefined): string {
  if (typeof summary !== "string" || TOOL_REQUEST_SUMMARY.test(summary)) return summary;
  return sessionsViewText(summary, names);
}

/**
 * A member's own words shown as one plain line (a task's first line, a
 * reply's line in a task row, an Activity preview), read by the sessions
 * view's mention rule as its messages are (sessionsMentionPieces): a member's
 * exact `@handle` is its task's title, the main session's is a plain word,
 * everything else stays as written. Without names, as written.
 */
export function sessionsMentionText(text: string, names: SessionsViewNames | undefined): string {
  if (!names || typeof text !== "string" || !text.includes("@")) return text;
  return sessionsMentionPieces(text, (handle) => names.titleOf(handle) !== undefined, (handle) => handle === names.mainHandle)
    .map((piece) => (piece.handle !== undefined ? names.titleOf(piece.handle) ?? piece.handle : piece.text))
    .join("");
}

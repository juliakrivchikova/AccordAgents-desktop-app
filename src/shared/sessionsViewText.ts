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
import { latestTaskByMember, sessionsMemberTitle } from "./mainSessionView";
import type { ChatMessage, ChatParticipant, ChatViewMode, ConversationMetadata } from "./types";

/** How the sessions view names a chat's members. */
export interface SessionsViewNames {
  /** The main session's handle, lower case, without "@". */
  mainHandle?: string;
  /** A member's or former member's title, by its handle in lower case
   *  without "@"; undefined for a handle of nobody in the chat. */
  titleOf: (handle: string) => string | undefined;
}

function cleanHandle(handle: string | undefined): string {
  return (handle ?? "").trim().replace(/^@+/, "").toLowerCase();
}

export function sessionsViewNames(mainHandle: string | undefined, titles: Iterable<readonly [string, string]>): SessionsViewNames {
  const byHandle = new Map<string, string>();
  for (const [handle, title] of titles) {
    const key = cleanHandle(handle);
    if (key && title) byHandle.set(key, title);
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
export function sessionsViewNamesOf(chat: ChatLike | undefined, fallbackView?: ChatViewMode): SessionsViewNames | undefined {
  if (!chat || chatViewFor(chat.metadata, fallbackView) !== "sessions") return undefined;
  const mainId = mainSessionParticipantId(chat.metadata);
  if (!mainId) return undefined;
  const participants = (Array.isArray(chat.metadata?.participants) ? chat.metadata.participants : [])
    .filter((item): item is ChatParticipant => Boolean(item) && typeof item === "object" && typeof (item as ChatParticipant).id === "string");
  const messages = chat.messages ?? [];
  const tasks = latestTaskByMember(messages);
  const titles: Array<[string, string]> = [];
  for (const member of sessionsFormerMembers(messages, participants, mainId)) {
    if (member.handle) titles.push([member.handle, sessionsMemberTitle(member, tasks.get(member.id)?.item)]);
  }
  for (const participant of participants) {
    if (participant.id !== mainId && typeof participant.handle === "string") {
      titles.push([participant.handle, sessionsMemberTitle(participant, tasks.get(participant.id)?.item)]);
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
  return names.titleOf(key) ?? (handle ?? "").trim().replace(/^@+/, "");
}

// Handles stand in for the rules below as private-use marks: the main
// session one mark, a member its title between two.
const MAIN = "\uE000";
const OPEN = "\uE001";
const CLOSE = "\uE002";
const HANDLE = /(^|[^A-Za-z0-9_@./\\-])@([A-Za-z0-9][A-Za-z0-9_-]*)(?![A-Za-z0-9_\-/])/g;
/** Any one named party: the main session, a member, or a handle of nobody
 *  here (a fork's source names a member of another chat). */
const ANY = `(?:${MAIN}|${OPEN}[^${CLOSE}]*${CLOSE}|@[A-Za-z0-9][A-Za-z0-9_-]*)`;
const SENTENCE_START = "(^|[.!?]\\s+|\\n\\s*)";
/** Verbs a sentence cannot start with once its subject is gone ("Is busy."):
 *  the main session is "It" there. */
const STATIVE = "(?:is|was|has|had|does|did|runs|belongs|cannot|can't|isn't|wasn't|doesn't|hasn't|will|would|may|starts)";

/** The fork's notices (postForkNotice), written so they need no subject.
 *  Matched by their start and end, so a notice cut to the notices' length
 *  still reads right. */
function forkNotices(text: string): string {
  let result = text.replace(
    new RegExp(`^${MAIN}'s copy of ${ANY}'s session may include what ${ANY} did after you tapped Fork:`),
    "The copy may include what was done after you tapped Fork:"
  );
  const startedFrom = new RegExp(`^${MAIN} could not start from a copy of ${ANY}'s session in the chat `);
  if (startedFrom.test(result)) {
    result = result
      .replace(startedFrom, "Could not start from a copy of the session in the chat ")
      .replace(/, so it starts a clean session\.?$/, ", so this chat starts a clean session.")
      .replace(/, so its next turn starts a clean session\.?$/, ", so the next turn starts a clean session.")
      .replace(/, so it started a clean session from the saved chat context\.?$/, ", so this chat started a clean session from the saved chat context.");
  }
  // A member made as a fork of the main session's own session.
  return result
    .replace(new RegExp(`copy of ${MAIN}'s session`, "g"), "copy of this chat's session")
    .replace(/copy of the main session's session/g, "copy of this chat's session");
}

/** The main session's mark, wherever it is left, as a sentence without a
 *  name: no subject at a sentence's start, nothing after "from", "for" or
 *  "by" at a clause's end, nothing after an action done to it, else "it". */
function withoutMainSession(text: string): string {
  return text
    .replace(new RegExp(`${SENTENCE_START}${MAIN}:\\s+(\\S)`, "g"), (_m, start: string, next: string) => `${start}${next.toUpperCase()}`)
    .replace(new RegExp(`${SENTENCE_START}${MAIN}'s\\s+`, "g"), (_m, start: string) => `${start}The `)
    .replace(new RegExp(`${SENTENCE_START}${MAIN}\\s+(?=${STATIVE}\\b)`, "g"), (_m, start: string) => `${start}It `)
    .replace(new RegExp(`${SENTENCE_START}${MAIN}\\s+(\\S)`, "g"), (_m, start: string, next: string) => `${start}${next.toUpperCase()}`)
    .replace(new RegExp(`${MAIN}'s\\s+`, "g"), "the ")
    .replace(new RegExp(`(^|\\s)(?:from|for|by)\\s${MAIN}(?=[:.,;)!?]|$)`, "g"), "")
    .replace(new RegExp(`\\bReturning (choice )?to ${MAIN}(?=[.,;:!?]|$)`, "g"), (_m, choice: string | undefined) => choice ? "Returning the choice" : "Returning")
    .replace(new RegExp(`\\b(compact|Compact)\\s${MAIN}\\s+context\\b`, "g"), "$1 the context")
    .replace(new RegExp(`\\bonly to ${MAIN}(?=[.,;]|$)`, "g"), "only to this session")
    .replace(
      new RegExp(`\\b(Compacting|Compacted|compacting|compact|Compact|Restarting|Restarted|restarting|restart|Restart|Resuming|Auto-resumed|Moving|moving)\\s${MAIN}(?=[\\s.,;:!?]|$)`, "g"),
      "$1"
    )
    .replace(new RegExp(`${SENTENCE_START}${MAIN}`, "g"), (_m, start: string) => `${start}It`)
    .replace(new RegExp(MAIN, "g"), "it");
}

function withMemberTitles(text: string): string {
  return text
    .replace(new RegExp(`${OPEN}([^${CLOSE}]*)${CLOSE}'s\\b`, "g"), "“$1”’s")
    .replace(new RegExp(`${OPEN}([^${CLOSE}]*)${CLOSE}`, "g"), "“$1”");
}

/**
 * Text the app wrote, as the sessions view shows it: every `@handle` of the
 * main session or a member gone (a member by its title in quotes, the main
 * session by no name at all); handles of nobody in the chat stay as written.
 * Without names (the classic view) the text is returned as it is.
 */
export function sessionsViewText(text: string, names: SessionsViewNames | undefined): string {
  if (!names || typeof text !== "string" || !text.includes("@")) return text;
  let named = false;
  const marked = text.replace(HANDLE, (match, before: string, handle: string) => {
    const key = handle.toLowerCase();
    if (key === names.mainHandle) {
      named = true;
      return `${before}${MAIN}`;
    }
    const title = names.titleOf(key);
    if (title === undefined) return match;
    named = true;
    return `${before}${OPEN}${title.replace(/[\uE000-\uE002]/g, "")}${CLOSE}`;
  });
  if (!named) return text;
  return withMemberTitles(withoutMainSession(forkNotices(marked)));
}

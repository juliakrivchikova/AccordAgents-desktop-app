import { cachedChatList, loadChats } from "../chats/chatStore.js";
import { chatMembers } from "../members/mentions.js";
import { MAIN_SESSION_ROLE } from "../newChat/newChatChoices.js";
import { chatViewMetadata, chatViewOf, sessionsMemberTitleOf, sessionsRules, sessionsStateState } from "../sessions/sessionsState.js";

/** Who raised a card, beside its title: the member's handle, except in a
 *  sessions-view chat, where no handle is shown (docs/main-session.md): the
 *  main session gets no who line, a member its task's title (its handle as
 *  a plain word while this phone has no task for it). The label is cut
 *  with an ellipsis rather than pushed off the screen. */
export function appendCardWho(head, card) {
  const requester = cardRequesterLabel(card);
  if (!requester && !card.machineName) return;
  const who = document.createElement("span");
  who.className = "control-card-who";
  who.textContent = [requester, card.machineName].filter(Boolean).join(" · ");
  who.title = who.textContent;
  head.append(who);
}

export function cardRequesterLabel(card) {
  // The main session is named by nothing; a member by its task's title, or
  // its handle as a plain word while this phone has no task for it.
  return sessionsViewLabelFor(card.conversationId, card.requesterLabel);
}

/** A "who" label as the chat's view shows it: a handle ("@drew") becomes
 *  the member's task's title in the sessions view, "" for the main
 *  session; any other label ("Chat Assistant", "A member") stays. */
export function sessionsViewLabelFor(conversationId, label) {
  if (typeof label !== "string" || !/^\s*@/.test(label)) return label;
  const names = sessionsViewNamesFor(conversationId);
  return names ? sessionsRules().sessionsViewLabel(label, names) : label;
}

/** How a chat shown in the sessions view names its members (the shared
 *  sessionsViewText rule, one with the desktop): the main session by
 *  nothing, a member by its task's title (by its handle as a plain word
 *  while this phone has no task for it). Undefined in the classic view. */
export function sessionsViewNamesFor(conversationId) {
  const shared = sessionsRules();
  if (!shared || typeof shared.sessionsViewNames !== "function" || !conversationId) return undefined;
  const open = sessionsStateState.lastSessionsState && sessionsStateState.lastSessionsState.conversationId === conversationId ? sessionsStateState.lastSessionsState : undefined;
  // Worked out once per chat list and drawing of the open chat, not per
  // label: Activity and a chat's cards ask for every row.
  // A chat not open now names its members by the title each keeps, else
  // by the tasks it had when it was last open here (titles are read from
  // its messages, which only an open chat has); a member with neither is
  // "Agent", never its handle.
  const titled = open ? undefined : sessionsTitledNames.get(conversationId);
  const known = sessionsNamesCache.get(conversationId);
  if (known && cachedChatList && known.list === cachedChatList && known.state === open && known.titled === titled) return known.names;
  const names = sessionsViewNamesUncached(shared, conversationId, titled);
  if (cachedChatList) sessionsNamesCache.set(conversationId, { list: cachedChatList, state: open, titled: titled, names: names });
  if (open && names) sessionsTitledNames.set(conversationId, names);
  return names;
}

const sessionsNamesCache = new Map();
export const sessionsTitledNames = new Map();

function sessionsViewNamesUncached(shared, conversationId, titled) {
  const chat = loadChats().find(function (item) { return item.id === conversationId; });
  if (!chat || chatViewOf(chat) !== "sessions") return undefined;
  const members = chatMembers(chat);
  const mainId = shared.mainSessionParticipantId(chatViewMetadata(chat));
  const main = members.find(function (member) { return member.id === mainId; }) ||
    members.find(function (member) { return member.roleConfigId === MAIN_SESSION_ROLE; });
  const state = sessionsStateState.lastSessionsState && sessionsStateState.lastSessionsState.conversationId === conversationId ? sessionsStateState.lastSessionsState : undefined;
  const titles = [];
  if (state) {
    state.formerMembers.forEach(function (former) { if (former.handle) titles.push([former.handle, sessionsMemberTitleOf(state, former.id)]); });
  }
  members.forEach(function (member) {
    if (member === main || !member.handle) return;
    // As the computer names it (sessionsViewNamesOf): the title kept with
    // the member first, then one read while the chat was open, else
    // "Agent"; never a handle.
    const kept = typeof member.taskTitle === "string" && member.taskTitle.trim().length > 0;
    const title = state ? sessionsMemberTitleOf(state, member)
      : kept ? shared.sessionsMemberTitle(member, undefined)
        : (titled && titled.titleOf(member.handle)) || shared.sessionsMemberTitle(member, undefined);
    titles.push([member.handle, title]);
    if (member.mentionHandle && member.mentionHandle !== member.handle) titles.push([member.mentionHandle, title]);
  });
  const names = shared.sessionsViewNames(main ? main.mentionHandle || main.handle : undefined, titles);
  // A member no longer in the chat, by the title it had when the chat was
  // last open here.
  if (state || !titled) return names;
  return { ...names, titleOf: function (handle) { return names.titleOf(handle) || titled.titleOf(handle); } };
}

/** A card's words as the chat's view shows them: a permission card's are
 *  the app's (sessionsViewTextFor), its title and summary the approval's
 *  summary, whose tool request (a command, a reason) stays exactly as
 *  written (sessionsViewSummaryText); a choice's are its member's own. */
export function cardAppText(card, text, summary) {
  if (!card || card.kind === "choice") return text;
  return summary ? sessionsViewSummaryTextFor(card.conversationId, text) : sessionsViewTextFor(card.conversationId, text);
}

/** A member's own words in one plain line (an Activity preview, the chat
 *  list's subtitle), by the sessions view's mention rule. */
export function sessionsMentionTextFor(conversationId, text) {
  if (typeof text !== "string" || text.indexOf("@") < 0) return text;
  const shared = sessionsRules();
  const names = sessionsViewNamesFor(conversationId);
  return names && typeof shared.sessionsMentionText === "function" ? shared.sessionsMentionText(text, names) : text;
}

export function sessionsViewSummaryTextFor(conversationId, text) {
  if (typeof text !== "string" || text.indexOf("@") < 0) return text;
  const shared = sessionsRules();
  const names = sessionsViewNamesFor(conversationId);
  return names && typeof shared.sessionsViewSummaryText === "function" ? shared.sessionsViewSummaryText(text, names) : text;
}

/** Text the app wrote (a card's title, options, outcome; a failure; a
 *  status), as the chat's view shows it: without handles in the sessions
 *  view, as written in the classic view. */
export function sessionsViewTextFor(conversationId, text) {
  if (typeof text !== "string" || text.indexOf("@") < 0) return text;
  const names = sessionsViewNamesFor(conversationId);
  return names ? sessionsRules().sessionsViewText(text, names) : text;
}

import { createEventId, nowIso } from "../base/bytes.js";
import { forgetStartedChat, loadStartedChats, noteOwnChat, saveStartedChats } from "../chats/chatStore.js";
import { openConversation, selectedConversationId } from "../chats/openChat.js";
import { mobileSharedRules } from "../members/avatars.js";
import { activeChatRecord, membersSheetOpen, renderMembersSheetFork } from "../members/membersSheet.js";
import { normalizeMobileMember } from "../members/mentions.js";
import { unreachableDetail } from "../outbox/hubOutbox.js";
import { putOutboxEntries } from "../outbox/outboxStore.js";
import { createOutboxEvent, sendNow } from "../outbox/sending.js";
import { recordSendFailure, renderSendLogButton, sendFailureRecord } from "../outbox/sendLog.js";
import { loadPairing } from "../pairing/pairing.js";
import { renderChatTitleMenu, titleMenuState } from "./chatTitleMenu.js";
import { sessionsStateState } from "./sessionsState.js";
import { leaveOpenChat, screenOnShow } from "../shell/home.js";
import { serverPhoneGet } from "../sync/serverReads.js";

export const forkToNewChatState = {
  // What the item says for the member it was last opened for:
  // { key, status: "checking" | "ready", reason?, plan? }.
  forkMenu: undefined
};

// --- Fork to new chat ---------------------------------------------------
// A member (the main session, or one it made, or any member of a classic
// chat) copied into a new chat as that chat's main session, as the
// computer's member menus and roster cards make it
// (src/shared/forkToNewChat.ts): read from the server when its item opens
// (the member and its chat as the server holds them, with what the
// computer offers), refused with the computer's words, and made through
// the same queue as every new chat from the phone. The device that runs
// the new main session copies the member's session at its first turn.
// Its item is in the title's menu in the sessions view, and under the
// member in the classic view's members sheet (renderMembersSheetFork).

const FORK_SERVER_OUTDATED = "Your server does not fork chats from the phone yet. It will once AccordAgents on your computer has updated.";

// How long a tap on Fork waits for her server to say which reply the copy
// ends with before it goes by what the item read when it opened.
const FORK_SEEN_READ_TIMEOUT_MS = 4000;

const FORK_COMPUTER_OUTDATED = "Your computer does not fork chats from the phone yet. Update AccordAgents on your computer.";
let forkMenuToken = 0;
export let forkStarting = false;

export function forkMenuKey(conversationId, participantId) {
  return conversationId + "\u0000" + participantId;
}

/** Whether this phone's shared rules can fork (a page from before cannot). */
export function forkOffered() {
  const shared = mobileSharedRules();
  return Boolean(shared && typeof shared.forkToNewChatReasonFromOffer === "function");
}

/** The Fork to new chat item for a member: what it makes, "Checking…",
 *  or why not, and whether a tap makes it. What it makes is the
 *  computer's words, the same in both views. */
export function paintForkItem(button, detail, chat, participantId) {
  const shared = mobileSharedRules();
  const state = forkToNewChatState.forkMenu && forkToNewChatState.forkMenu.key === forkMenuKey(chat.id, participantId) ? forkToNewChatState.forkMenu : undefined;
  const checking = !state || state.status === "checking";
  const ready = !checking && !state.reason && Boolean(state.plan) && !forkStarting;
  const makes = shared.FORK_TO_NEW_CHAT_DETAIL;
  const text = forkStarting ? "Starting the new chat…" : checking ? "Checking…" : state.reason || makes;
  const disabled = ready ? "false" : "true";
  if (button.getAttribute("aria-disabled") !== disabled) button.setAttribute("aria-disabled", disabled);
  button.dataset.forkParticipant = participantId;
  if (detail.textContent !== text) detail.textContent = text;
}

export function renderTitleMenuFork(chat, participantId) {
  const button = document.getElementById("chat-title-fork");
  const detail = document.getElementById("chat-title-fork-detail");
  if (!button || !detail) return;
  const shown = Boolean(chat && participantId && forkOffered());
  if (button.hidden === shown) button.hidden = !shown;
  if (!shown) return;
  // The title's menu is the sessions view's alone (chatTitleMenuState).
  paintForkItem(button, detail, chat, participantId);
}

/** Both places the item is: what it says changed (read, starting, failed). */
function renderForkItems() {
  const chat = activeChatRecord();
  renderChatTitleMenu(chat);
  renderMembersSheetFork(chat);
}

/** A tap on the item: made only when it was read ready for this member;
 *  disabled, it stays where it is, its line saying why. */
export function forkFromItem(button) {
  const chat = activeChatRecord();
  const state = forkToNewChatState.forkMenu && chat ? forkToNewChatState.forkMenu : undefined;
  if (button.getAttribute("aria-disabled") === "true" || !state || state.key !== forkMenuKey(chat.id, button.dataset.forkParticipant || "") || !state.plan) return;
  void forkMemberToNewChat(state.plan);
}

/** Reads whether the member can be forked now, and what the new chat is
 *  made of, from the server: the member and its chat, and what the
 *  computer last told the server it offers. */
export async function readForkPlan(chat, participantId) {
  const key = forkMenuKey(chat.id, participantId);
  const token = ++forkMenuToken;
  forkToNewChatState.forkMenu = { key: key, status: "checking" };
  let answer;
  let failure;
  try {
    answer = await serverPhoneGet("/v1/phone/new-chat", { forkOf: chat.id, participantId: participantId });
  } catch (error) {
    failure = error;
  }
  if (token !== forkMenuToken) return;
  forkToNewChatState.forkMenu = { key: key, status: "ready", ...forkPlanFrom(answer, failure) };
  renderForkItems();
}

/** Why the member cannot be forked now, by the computer's rule and words,
 *  or what the new chat is made of. */
function forkPlanFrom(answer, failure) {
  const shared = mobileSharedRules();
  if (failure) {
    if (failure.serverStatus === 404 && String(failure.serverBody || failure.message || "").indexOf("chat_not_found") >= 0) return { reason: "This chat is not on your server." };
    if (failure.serverStatus === 404) return { reason: FORK_SERVER_OUTDATED };
    return { reason: "Could not reach your server: " + unreachableDetail(failure) };
  }
  const source = answer && answer.fork;
  if (!source) return { reason: answer && answer.unavailable && !answer.options ? answer.unavailable : FORK_SERVER_OUTDATED };
  if (!source.member) return { reason: "That member is no longer in its chat." };
  const offer = answer.options;
  if (!offer) return { reason: answer.unavailable || FORK_COMPUTER_OUTDATED };
  if (!offer.fork || !(offer.mainSession || offer.assistant)) return { reason: FORK_COMPUTER_OUTDATED };
  // As it runs now: a member the main session made never above it.
  const running = shared.memberAsItRunsNow(source.member, source.mainSession);
  const reason = shared.forkToNewChatReasonFromOffer({ running: running, answered: source.answered === true, offer: offer.fork });
  return reason ? { reason: reason } : { plan: { source: source, running: running, offer: offer, machines: answer.machines || {} } };
}

/** The member's last reply that ended a turn, read again from her server
 *  when she taps Fork; what the item read when it opened if that fails. */
async function forkSeenAtTap(plan) {
  try {
    const answer = await serverPhoneGet("/v1/phone/new-chat", { forkOf: plan.source.conversationId, participantId: plan.running.id }, { timeoutMs: FORK_SEEN_READ_TIMEOUT_MS });
    const fresh = answer && answer.fork;
    if (fresh && fresh.member) return fresh.seen || undefined;
  } catch (error) {
    // Out of reach: the read from when the item opened.
  }
  return plan.source.seen || undefined;
}

/** Makes the new chat on the server as the computer makes it ("<chat>
 *  (fork)", the member's project, the computer's view for a new chat, one
 *  main session on the member's provider, model, effort, access and place,
 *  marked with where it comes from), lists it, and opens it with nothing
 *  in it: the first message makes the copy. Gone from the chat it was
 *  forked from by then, she stays where she is; it is only listed. */
async function forkMemberToNewChat(plan) {
  const shared = mobileSharedRules();
  if (forkStarting || !shared) return;
  forkStarting = true;
  const startedFor = forkToNewChatState.forkMenu && forkToNewChatState.forkMenu.plan === plan ? forkToNewChatState.forkMenu.key : undefined;
  renderForkItems();
  const conversationId = createEventId();
  const title = shared.forkedChatTitle(plan.source.title);
  let listed = false;
  try {
    // The copy ends with the member's last reply that ended a turn as her
    // server has it now, at the tap (the User, 2026-11-21: "When you tap
    // Fork"): a reply that finished while the item was open counts. Out of
    // reach, what it read when the item opened.
    const seen = await forkSeenAtTap(plan);
    const createdAt = nowIso();
    const offer = plan.offer;
    const mainSession = shared.forkedMainSessionFor({
      mainSession: offer.mainSession || offer.assistant, basePermissions: offer.fork.basePermissions, member: plan.running,
      source: { id: plan.source.conversationId, title: plan.source.title }, seen: seen, id: createEventId()
    });
    const repoPath = plan.source.repoPath || undefined;
    const chatView = offer.defaultChatView === "classic" || offer.defaultChatView === "sessions" ? offer.defaultChatView : "sessions";
    const sessionsFields = { mainSessionParticipantId: mainSession.id, chatView: chatView };
    listed = true;
    noteOwnChat(conversationId);
    saveStartedChats([{
      id: conversationId, title: title, group: shared.mobileChatGroupLabel(repoPath), snippet: shared.mobileSnippet(""), who: "", updatedAt: createdAt,
      running: false, startedHere: true, deviceId: (loadPairing() || {}).deviceId, ...sessionsFields, canSwitchView: true,
      participants: ["@" + mainSession.handle],
      members: [normalizeMobileMember({ id: mainSession.id, handle: mainSession.handle, mentionHandle: mainSession.handle, displayName: "@" + mainSession.handle,
        roleLabel: "", roleConfigId: mainSession.roleConfigId, kind: mainSession.kind, homeMachineId: mainSession.homeMachineId,
        cloudRun: mainSession.cloudRun, participant: mainSession.homeMachineId ? mainSession : undefined,
        homeMachineName: mainSession.homeMachineId ? plan.machines[mainSession.homeMachineId] : undefined })].filter(Boolean)
    }].concat(loadStartedChats()));
    const create = await createOutboxEvent({
      conversationId: conversationId, kind: "conversation.create", createdAt: createdAt,
      payload: { conversation: { title: title, kind: "chat", createdAt: createdAt, ...(repoPath ? { repoPath: repoPath } : {}),
        metadata: { participants: [mainSession], ...sessionsFields } } }
    });
    const introId = createEventId();
    const intro = await createOutboxEvent({
      eventId: introId, conversationId: conversationId, kind: "message.system", createdAt: createdAt, dependsOn: create.eventId,
      payload: { message: { id: introId, role: "system", content: shared.newChatIntro([mainSession.handle]),
        createdAt: createdAt, status: "done", metadata: { threadId: "system" } } }
    });
    await putOutboxEntries([create, intro]);
    listed = false;
  } catch (error) {
    if (listed) forgetStartedChat(conversationId);
    forkStarting = false;
    const reason = "Could not start the chat: " + (error && error.message ? error.message : String(error));
    const menuShowsThisFork = Boolean(forkToNewChatState.forkMenu) && forkToNewChatState.forkMenu.key === startedFor;
    if (menuShowsThisFork) forkToNewChatState.forkMenu = { ...forkToNewChatState.forkMenu, reason: reason, plan: undefined };
    // Gone from where she tapped it (another chat or screen, or its menu
    // closed): said where the phone says a New chat that did not go
    // through, in the send log ("New chat: <title>"), the header pointing
    // at it until she has looked.
    if (!(menuShowsThisFork && stillInForkedChat(plan.source.conversationId) && (titleMenuState.chatTitleMenuOpen || membersSheetOpen))) {
      void recordSendFailure({ ...sendFailureRecord({ eventId: conversationId, kind: "conversation.create", conversationId: conversationId,
        payload: { conversation: { title: title } } }, { cause: "phone", reason: reason }), notStarted: true });
      renderSendLogButton();
    }
    renderForkItems();
    return;
  }
  forkStarting = false;
  const menuShowsThisFork = Boolean(forkToNewChatState.forkMenu) && forkToNewChatState.forkMenu.key === startedFor;
  if (!forkToNewChatState.forkMenu || menuShowsThisFork) forkToNewChatState.forkMenu = undefined;
  // Making it waits on her server (up to FORK_SEEN_READ_TIMEOUT_MS): gone
  // to another chat or screen by then, she stays there, keyboard and all;
  // the new chat is in her list.
  if (!stillInForkedChat(plan.source.conversationId)) {
    // The menu it was tapped in closes (she may have left by a
    // notification, not a tap that closes it); a menu she opened since
    // stays, its Fork item no longer "Starting the new chat…".
    if (menuShowsThisFork) titleMenuState.chatTitleMenuOpen = false;
    renderForkItems();
    void sendNow();
    return;
  }
  titleMenuState.chatTitleMenuOpen = false;
  // The new chat, open at once with its composer ready, as on the computer.
  leaveOpenChat();
  sessionsStateState.openAccordLaunchId = undefined;
  await openConversation(conversationId);
  document.getElementById("composer-input")?.focus();
  void sendNow();
}

/** Whether the chat she forked from is still what is on screen: open, on
 *  its timeline (a thread or member of it too), with New chat not over it. */
function stillInForkedChat(sourceConversationId) {
  const newChat = document.getElementById("new-chat-screen");
  return selectedConversationId() === sourceConversationId && screenOnShow() === "timeline" && !(newChat && !newChat.hidden);
}

import { recordRelayDebug } from "../base/bytes.js";
import { outboxStatusById } from "../base/storageKeys.js";
import { pendingCardsForMessage } from "../cards/cardRows.js";
import { sessionsTitledNames } from "../cards/cardText.js";
import { controlCardsFor } from "../cards/controlCardStore.js";
import { setOpenThreadRootId } from "../chat/chatScroll.js";
import { isCancellableMobileRow } from "../chat/messageRows.js";
import { render } from "../chat/render.js";
import { loadChats } from "../chats/chatStore.js";
import { openChatState } from "../chats/openChat.js";
import { mobileSharedRules } from "../members/avatars.js";
import { activeChatRecord, closeMembersSheet, memberKindLabel } from "../members/membersSheet.js";
import { chatMembers } from "../members/mentions.js";
import { OUTBOX_REFUSED, OUTBOX_SENT, OUTBOX_SUPERSEDED } from "../outbox/hubOutbox.js";
import { createOutboxEvent, persistOutboundEvent, sendNow } from "../outbox/sending.js";
import { isProviderKind } from "../sync/timelinePayload.js";

export const sessionsStateState = {
  // What the last drawing of the open chat worked out for its sessions view:
  // the members sheet, the header's button and every Stop read it.
  lastSessionsState: undefined,
  // The open chat's members as the sessions view names them in messages
  // (sessionsMentionsOf); undefined outside the sessions view.
  sessionsMentionScope: undefined,
  membersPreviousOpen: false,
  // The members that left the chat, listed under Removed when opened.
  membersRemovedOpen: false,
  // A message the chat was opened on (from Activity, a note, a link): in the
  // sessions view, the member's session it is in opens, as on the desktop.
  pendingSessionsTarget: undefined,
  // The Accord shown on its own screen in the sessions view (its launch id).
  openAccordLaunchId: undefined
};

// --- the main session and the sessions view --------------------------------
// A chat with a main session (docs/main-session.md) is shown in one of two
// views, switched in the chat's header as on the desktop and shared through
// her server like the pin. In the sessions view the main timeline holds the
// User and the main session (its tasks as cards), every other member's
// whole session opens on its own screen, and the members sheet says who
// does what. Where each message goes is the desktop's own rule
// (shared/mainSession.ts and mainSessionView.ts, bundled into
// mobile-shared.js); the phone only draws it.

// The member whose session is open, for this visit of the chat (like the
// open thread).
const OPEN_MEMBER_SESSION_KEY = "accordagents.mobile.openMemberSessionId.v1";

export const CHAT_VIEW_SWITCH_DISABLED_REASON = "This chat was made before the Sessions view, so it has the Classic view only.";

/** A view this phone asked for, shown until the server's list says so (as a
 *  pin is): kept while it waits to be sent, dropped when refused, and once
 *  taken, kept this long at most for the list to catch up. */
const VIEW_OVERRIDE_TAKEN_MS = 60_000;

const viewOverrides = new Map();

// Tasks opened to their whole text in a member's session, by row.
export const openTaskFolds = new Set();

// Finished replies whose "Worked for …" was opened to its tasks, by row.
export const openWorkedFolds = new Set();

export function sessionsRules() {
  const shared = mobileSharedRules();
  return shared && typeof shared.sessionsViewLane === "function" && typeof shared.chatViewFor === "function" &&
    typeof shared.sessionsMemberRows === "function" ? shared : undefined;
}

/** The chat as the shared rules read it: its main session while that is
 *  still a member, and its own view. */
export function chatViewMetadata(chat) {
  return {
    mainSessionParticipantId: chat ? chat.mainSessionParticipantId : undefined,
    chatView: chat ? chat.chatView : undefined,
    participants: chat ? chatMembers(chat).map(function (member) { return { id: member.id }; }) : []
  };
}

export function chatCanSwitchView(chat) {
  const shared = sessionsRules();
  return Boolean(chat && shared && shared.canSwitchChatView(chatViewMetadata(chat)));
}

function chatViewOverride(chat) {
  const override = viewOverrides.get(chat.id);
  if (!override) return undefined;
  const sent = override.eventId ? outboxStatusById.get(override.eventId) : undefined;
  const status = sent && sent.status;
  if (status === OUTBOX_SENT && !override.takenAt) override.takenAt = Date.now();
  // Only once her server has taken this pick: before that, a list saying
  // the same view is an older one (from before a pick made just ahead of
  // it), and the next list, with that earlier pick, would show it again.
  const settled = override.takenAt !== undefined && chat.chatView === override.view;
  const refused = status === OUTBOX_REFUSED || status === OUTBOX_SUPERSEDED;
  const stale = override.takenAt !== undefined && Date.now() - override.takenAt > VIEW_OVERRIDE_TAKEN_MS;
  if (settled || refused || stale) {
    viewOverrides.delete(chat.id);
    return undefined;
  }
  return override;
}

/** The view the chat is shown in: the one just picked here while her
 *  server takes it, else the chat's own. A chat without a main session is
 *  always classic. */
export function chatViewOf(chat) {
  const shared = sessionsRules();
  if (!chat || !shared || !shared.canSwitchChatView(chatViewMetadata(chat))) return "classic";
  const override = chatViewOverride(chat);
  return override ? override.view : shared.chatViewFor(chatViewMetadata(chat));
}

export function openMemberSessionId() {
  const value = sessionStorage.getItem(OPEN_MEMBER_SESSION_KEY);
  return value && value !== "none" ? value : undefined;
}

export function setOpenMemberSessionId(participantId) {
  if (participantId) sessionStorage.setItem(OPEN_MEMBER_SESSION_KEY, participantId);
  else sessionStorage.removeItem(OPEN_MEMBER_SESSION_KEY);
}

/** A member that has left the chat, as its session reads it: its handle
 *  from its messages and tasks, and its provider from the tasks it was
 *  given (shared sessionsFormerMembers), so its logo stays. */
function formerMemberRecord(former) {
  return { id: former.id, handle: former.handle || "member", mentionHandle: former.handle || "", displayName: former.handle || "member",
    roleLabel: "", kind: formerMemberKind(former), former: true };
}

export function formerMemberKind(former) {
  return former && isProviderKind(former.kind) ? former.kind : "";
}

/** The member whose session is open in the open chat, in the sessions
 *  view: one of its members, or one that has left it (read only). */
export function openMemberSessionMember(chat) {
  const participantId = openMemberSessionId();
  if (!participantId || !chat || chatViewOf(chat) !== "sessions" || participantId === chat.mainSessionParticipantId) return undefined;
  const member = chatMembers(chat).find(function (item) { return item.id === participantId; });
  if (member) return member;
  const state = sessionsStateState.lastSessionsState && sessionsStateState.lastSessionsState.conversationId === chat.id ? sessionsStateState.lastSessionsState : undefined;
  const former = state ? state.formerMembers.find(function (item) { return item.id === participantId; }) : undefined;
  return former ? formerMemberRecord(former) : undefined;
}

/** The chat's main session, while it is a member and the chat is shown in
 *  the sessions view: what the main composer writes to there. */
export function sessionsMainSessionIdOf(chat) {
  const shared = sessionsRules();
  if (!shared || !chat || chatViewOf(chat) !== "sessions") return undefined;
  return shared.mainSessionParticipantId(chatViewMetadata(chat));
}

export function openSessionsTarget(state, conversationId) {
  const shared = sessionsRules();
  const focus = openChatState.pendingMessageFocus && openChatState.pendingMessageFocus.conversationId === conversationId ? openChatState.pendingMessageFocus.messageId : undefined;
  const thread = sessionsStateState.pendingSessionsTarget && sessionsStateState.pendingSessionsTarget.conversationId === conversationId ? sessionsStateState.pendingSessionsTarget.messageId : undefined;
  for (const messageId of [focus, thread]) {
    const message = messageId ? state.messagesById.get(messageId) : undefined;
    if (!message) continue;
    if (messageId === thread) sessionsStateState.pendingSessionsTarget = undefined;
    const open = openMemberSessionId();
    // Already in the open member's session (its task, the main session's
    // answer to it): it stays open there.
    if (open && shared.memberSessionMessages(state.messages, open, state.index).some(function (item) { return item.id === messageId; })) return;
    const lane = shared.sessionsViewLane(message, state.index);
    if (lane.kind === "member" && state.knownMember(lane.participantId)) {
      if (open !== lane.participantId) setOpenMemberSessionId(lane.participantId);
    } else if (messageId === focus && open) {
      setOpenMemberSessionId(undefined);
    }
    return;
  }
}

/** Opens a member's session (a former member's too, read only), at the
 *  message given when there is one: its reply to a task, or the task. */
export function openMemberSession(participantId, focusMessageId) {
  const chat = activeChatRecord();
  if (!chat || chatViewOf(chat) !== "sessions" || !participantId) return;
  const state = sessionsStateState.lastSessionsState && sessionsStateState.lastSessionsState.conversationId === chat.id ? sessionsStateState.lastSessionsState : undefined;
  const known = chatMembers(chat).some(function (member) { return member.id === participantId; }) ||
    Boolean(state && state.formerMembers.some(function (member) { return member.id === participantId; }));
  if (!known || participantId === chat.mainSessionParticipantId) return;
  closeMembersSheet();
  setOpenThreadRootId(undefined);
  sessionsStateState.openAccordLaunchId = undefined;
  setOpenMemberSessionId(participantId);
  // The message to land on here, or none: a landing asked for before (in
  // a session the User left before it was drawn) is not carried over, or
  // the next drawing would open that member's session instead.
  openChatState.pendingMessageFocus = focusMessageId ? { conversationId: chat.id, messageId: focusMessageId } : undefined;
  void render();
}

/** The User's switch of the chat's view: shown at once, written for every
 *  device through her server, back to what it was if the server refuses. */
export async function setChatViewFromPhone(conversationId, view) {
  const chat = loadChats().find(function (item) { return item.id === conversationId; });
  if (!chat || (view !== "sessions" && view !== "classic") || !chatCanSwitchView(chat) || chatViewOf(chat) === view) return;
  const override = { view: view };
  viewOverrides.set(conversationId, override);
  setOpenThreadRootId(undefined);
  setOpenMemberSessionId(undefined);
  closeMembersSheet();
  void render();
  try {
    const entry = await createOutboxEvent({ conversationId: conversationId, kind: "conversation.view", payload: { view: view } })
      .then(persistOutboundEvent);
    override.eventId = entry.eventId;
  } catch (error) {
    viewOverrides.delete(conversationId);
    void render();
    recordRelayDebug({ event: "chat-view-not-queued", message: error instanceof Error ? error.message : String(error) });
    return;
  }
  await sendNow();
}

/** A drawn row as the shared rules read a message: who wrote it, whom the
 *  User's was for, what it answers, its request, whether a choice under it
 *  waits, and what kind of note or launch it is. */
function sessionsMessageOf(row) {
  const role = row.author === "you" ? "user" : row.author === "agent" ? "participant" : "system";
  const waitingChoice = role === "participant" && !row.scaffolding && pendingCardsForMessage(row).length > 0;
  return {
    id: row.sourceId || row.id,
    role: role,
    content: row.content || "",
    createdAt: row.createdAt,
    status: row.status === "Running" ? "pending" : row.status === "Error" || row.status === "Stopped" ? "error" : "done",
    ...(row.participantId ? { participantId: row.participantId } : {}),
    ...(role === "participant" && row.participantLabel ? { participantLabel: row.participantLabel } : {}),
    metadata: {
      // As the computer holds it: a reply a Stop or a quit ended.
      ...(row.status === "Stopped" ? { terminalReason: "user-stopped" } : {}),
      ...(Array.isArray(row.addressees) && row.addressees.length ? { deliveryTargets: row.addressees } : {}),
      ...(row.participantRequest ? { participantRequest: row.participantRequest } : {}),
      ...(waitingChoice ? { pendingChoice: { status: "pending" } } : {}),
      // What a member's turn answers: the main session's answer to a
      // member's question belongs in that member's session from its first
      // token (shared/mainSession.ts sessionsViewLane).
      ...(role !== "user" && row.sourceMessageId ? { sourceMessageId: row.sourceMessageId } : {}),
      ...(role === "system" && row.finishedNote ? { appMessageSource: "app_turn_finished_note", turnFinishedNote: row.finishedNote } : {}),
      // A finished compaction's line: in the compacted member's session
      // (shared sessionsViewLane), worded by its CLI.
      ...(role === "system" && row.compaction ? { compaction: { ...row.compaction, outcome: "completed" } } : {}),
      ...(row.accordLaunchByMainSession ? { accordLaunchByMainSession: true } : {}),
      // An urgent alert's card (the phone gets one only as the server wrote
      // it): on the main timeline whichever member raised it (shared
      // isMainTimelineAlertCard), as on the computer.
      ...(role === "participant" && row.urgentAlert && typeof row.urgentAlert.id === "string" ? { serverWriter: "server", urgentAlert: row.urgentAlert } : {}),
      ...(typeof row.workedMs === "number" ? { workedMs: row.workedMs } : {}),
      // A reply waiting behind its member's turn, and when a reply's own
      // turn began: which reply runs, and from when (sessionsMemberActivity).
      ...(row.queued ? { turnQueued: true } : {}),
      ...(row.runId ? { runId: row.runId } : {}),
      ...(typeof row.startedAt === "string" && row.startedAt ? { turnStartedAt: row.startedAt } : {})
    }
  };
}

/** A task whose request message is older than the pages this phone reads
 *  again keeps the status it had then; the member's own reply to it is
 *  newer and says how it ended. Read from that reply, as the request
 *  itself would say once read again. Not while the member waits on the
 *  User's card, which keeps a task running after its reply. */
function refreshTaskStates(messages, rows, statusById) {
  const replies = new Map();
  messages.forEach(function (message, position) {
    const source = message.metadata.sourceMessageId;
    if (message.role === "participant" && message.participantId && source) {
      replies.set(source + "\u0000" + message.participantId, { message: message, row: rows[position] });
    }
  });
  for (const message of messages) {
    const batch = message.metadata.participantRequest;
    if (!batch) continue;
    let changed = false;
    const items = batch.items.map(function (item) {
      if (item.status !== "running" || statusById.get(item.targetParticipantId) === "pending") return item;
      const reply = replies.get(message.id + "\u0000" + item.targetParticipantId);
      if (!reply || reply.message.status === "pending") return item;
      changed = true;
      // Stopped (a Stop, the User quitting) is interrupted, as on the computer.
      const stopped = (reply.row && reply.row.stopRequested) || (reply.message.metadata && reply.message.metadata.terminalReason === "user-stopped");
      if (reply.message.status === "error") return { ...item, status: stopped ? "interrupted" : "failed" };
      return { ...item, status: "answered", replyMessageId: reply.message.id };
    });
    if (changed) message.metadata = { ...message.metadata, participantRequest: { ...batch, items: items } };
  }
  return replies;
}

/** The open chat's sessions view, worked out once per drawing from the
 *  rows it draws; undefined when the chat is shown the classic way. */
export function sessionsStateFor(conversationId, chat, rows) {
  const shared = sessionsRules();
  if (!shared || !chat || chatViewOf(chat) !== "sessions") return undefined;
  const mainId = shared.mainSessionParticipantId(chatViewMetadata(chat));
  if (!mainId) return undefined;
  const messages = rows.map(sessionsMessageOf);
  const members = chatMembers(chat);
  // What each member does now, as far as this phone can see: answering
  // (a reply or a turn still going, with text or not yet), else waiting
  // for the User (a choice of its waits under one of its messages).
  const statusById = new Map();
  const runsByMember = new Map();
  rows.forEach(function (row, position) {
    if (row.author !== "agent" || !row.participantId) return;
    if (row.status === "Running") statusById.set(row.participantId, "running");
    else if (messages[position].metadata.pendingChoice && !statusById.has(row.participantId)) statusById.set(row.participantId, "pending");
    // Its turn, asked, queued or answering, with text or not yet: stopped
    // by its run, as the desktop stops a member by its run ids.
    if (row.runId && row.status === "Running" && (isCancellableMobileRow(row) || row.memberTurn)) {
      const runs = runsByMember.get(row.participantId) || [];
      if (!runs.some(function (run) { return run.runId === row.runId; })) {
        runs.push({ runId: row.runId, messageId: row.sourceMessageId, participantId: row.participantId, stopRequested: row.stopRequested === true });
      }
      runsByMember.set(row.participantId, runs);
    }
  });
  const replies = refreshTaskStates(messages, rows, statusById);
  const index = shared.buildSessionsViewIndex(messages, mainId);
  const messagesById = new Map(messages.map(function (message) { return [message.id, message]; }));
  const activity = shared.sessionsMemberActivity(messages);
  const tasksByMember = shared.latestTaskByMember(messages);
  // The task each member is named by: its delegation's, else its first; a
  // follow-up never renames it (shared titleTaskByMember, as the computer).
  const titleTasksByMember = typeof shared.titleTaskByMember === "function" ? shared.titleTaskByMember(messages) : tasksByMember;
  // A member held up by the User (its choice or mention question no newer
  // turn of its went past, a permission its turn waits on) waits for her
  // even while its turn runs, as on the computer (shared
  // sessionsMembersWaitingForUser). A server from before marks no card.
  const waitingSince = typeof shared.sessionsMembersWaitingSince === "function" ? shared.sessionsMembersWaitingSince(messages) : new Map();
  controlCardsFor(conversationId).forEach(function (card) {
    if (!card || card.status !== "pending" || card.holdsTurn !== true || typeof card.requesterParticipantId !== "string") return;
    if (!members.some(function (item) { return item.id === card.requesterParticipantId; })) return;
    const known = waitingSince.get(card.requesterParticipantId);
    if (known === undefined || (card.createdAt && (!known || card.createdAt < known))) waitingSince.set(card.requesterParticipantId, card.createdAt || "");
  });
  const waitingForUser = new Set(waitingSince.keys());
  const memberRows = shared.sessionsMemberRows(members, mainId, statusById, tasksByMember, activity.finishedAt, waitingForUser);
  const formerMembers = shared.sessionsFormerMembers(messages, members, mainId);
  const openCardIds = new Set(shared.openMemberCardMessages(messages, index).map(function (message) { return message.id; }));
  const mainMessages = shared.mainTimelineMessages(messages, index);
  const placement = shared.sessionsTaskPlacement(mainMessages, index);
  const mainMember = members.find(function (member) { return member.id === mainId; });
  const state = {
    conversationId: conversationId, chat: chat, mainId: mainId, mainMember: mainMember, mainHandle: mainMember ? mainMember.handle : "main",
    rows: rows, messages: messages, index: index, members: members, formerMembers: formerMembers,
    statusById: statusById, runsByMember: runsByMember, tasksByMember: tasksByMember, titleTasksByMember: titleTasksByMember, waitingForUser: waitingForUser, waitingSince: waitingSince, memberRows: memberRows,
    activity: activity, messagesById: messagesById, replies: replies, openCardIds: openCardIds,
    mainIds: new Set(mainMessages.map(function (message) { return message.id; })), placement: placement,
    // Running, not waiting for the User, as the computer counts them.
    runningCount: typeof shared.sessionsRunningCount === "function" ? shared.sessionsRunningCount(memberRows)
      : memberRows.current.filter(function (row) { return row.status === "running"; }).length,
    knownMember: function (id) {
      return id !== mainId && (members.some(function (member) { return member.id === id; }) || formerMembers.some(function (member) { return member.id === id; }));
    }
  };
  state.mentions = sessionsMentionsOf(state);
  // How the app's own words name members here (shared sessionsViewText).
  state.viewNames = typeof shared.sessionsViewNames === "function"
    ? shared.sessionsViewNames(state.mainHandle, [...state.mentions.byHandle].map(function (pair) { return [pair[0], pair[1].title]; }))
    : undefined;
  // Remembered for Activity and the chat list once the chat is closed.
  if (state.viewNames) sessionsTitledNames.set(conversationId, state.viewNames);
  return state;
}

/** A member as the sessions view names it (T3 Code's way): the short
 *  title of the task it is named by (shared titleTaskByMember: its
 *  delegation's, else its first); no handle. */
export function sessionsMemberTitleOf(state, memberOrId) {
  const shared = sessionsRules();
  const id = typeof memberOrId === "string" ? memberOrId : memberOrId && memberOrId.id;
  const member = typeof memberOrId === "string"
    ? state.members.find(function (item) { return item.id === id; }) || state.formerMembers.find(function (item) { return item.id === id; })
    : memberOrId;
  const task = id ? (state.titleTasksByMember || state.tasksByMember).get(id) : undefined;
  return shared.sessionsMemberTitle(member, task ? task.item : undefined);
}

/** The line under a member's title: provider and model, and its role when
 *  it is not the ordinary member's. */
export function sessionsMemberDetailOf(member) {
  const shared = sessionsRules();
  if (!member || member.former) return member && member.former ? sessionsRemovedMemberDetail() : "";
  return shared.sessionsMemberDetail({
    provider: memberKindLabel(member.kind),
    model: member.participant && typeof member.participant.model === "string" ? member.participant.model : undefined,
    roleLabel: member.roleLabel,
    roleConfigId: member.roleConfigId
  });
}

/** A removed member's line, worded once for the desktop and the phone. */
function sessionsRemovedMemberDetail() {
  const shared = sessionsRules();
  return shared && typeof shared.SESSIONS_REMOVED_MEMBER_DETAIL === "string" ? shared.SESSIONS_REMOVED_MEMBER_DETAIL : "Removed from the chat";
}

export function sessionsMemberName(member, fallback) {
  const state = sessionsStateState.lastSessionsState;
  if (member && state && member.id !== state.mainId) return sessionsMemberTitleOf(state, member);
  return member ? (member.id && state && member.id === state.mainId ? "" : member.handle) : fallback || "A member";
}

/** The members a mention in a message names, for its link chip: each
 *  member's (and former member's) title, provider and the message its
 *  latest task leads to. The main session and unknown handles are plain. */
function sessionsMentionsOf(state) {
  const byHandle = new Map();
  const add = function (member) {
    if (!member || member.id === state.mainId || !member.handle) return;
    const task = state.tasksByMember.get(member.id);
    byHandle.set(String(member.handle).replace(/^@/, "").toLowerCase(), {
      id: member.id, kind: member.kind || "", title: sessionsMemberTitleOf(state, member),
      focus: task ? sessionsTaskFocus(state, task.messageId, task.item) : undefined
    });
  };
  state.formerMembers.forEach(function (former) { add(formerMemberRecord(former)); });
  state.members.forEach(function (member) { add(member); if (member.mentionHandle && member.mentionHandle !== member.handle) add({ ...member, handle: member.mentionHandle }); });
  const key = JSON.stringify([state.mainHandle].concat([...byHandle].map(function (pair) { return [pair[0], pair[1].id, pair[1].title, pair[1].kind]; })));
  return { byHandle: byHandle, mainHandle: String(state.mainHandle || "").toLowerCase(), key: key };
}

/** The message a task leads to in its member's session: the member's
 *  reply to it (finished or in progress), else the task itself. */
function sessionsTaskFocus(state, messageId, item) {
  if (item.replyMessageId) return item.replyMessageId;
  const reply = state.replies.get(messageId + "\u0000" + item.targetParticipantId);
  return reply ? reply.message.id : messageId;
}

/** When a member's work began, while it is running: its reply in
 *  progress, else its latest task. */
export function sessionsMemberSince(state, participantId) {
  const shared = sessionsRules();
  const running = shared.memberRunningSince(participantId, state.messages);
  if (running) return running;
  const task = state.tasksByMember.get(participantId);
  return task ? shared.sessionsTaskRunningSince(task.item, state.messages) : undefined;
}

export function sessionsCanStop(state, participantIds) {
  return participantIds.some(function (id) {
    return (state.runsByMember.get(id) || []).some(function (run) { return !run.stopRequested; });
  });
}

export function sessionsStopping(state, participantIds) {
  const runs = participantIds.flatMap(function (id) { return state.runsByMember.get(id) || []; });
  return runs.length > 0 && runs.every(function (run) { return run.stopRequested; });
}

/** Each task of the main session's request as a delegation row draws it:
 *  the member's provider, the task's title, its state with its time and
 *  one line of its result, and the message the row opens at. */
/** A member's provider in the sessions view: a member's own, else that of
 *  a member who has left the chat, kept from the tasks it was given. */
function sessionsKindOf(state, participantId) {
  const member = state.members.find(function (candidate) { return candidate.id === participantId; });
  if (member) return member.kind || "";
  const former = state.formerMembers.find(function (candidate) { return candidate.id === participantId; });
  return formerMemberKind(former);
}

export function sessionsDelegationsOf(state, message) {
  const shared = sessionsRules();
  const batch = message.metadata.participantRequest;
  if (!batch) return [];
  const names = state.viewNames;
  const appText = function (text) { return names ? shared.sessionsViewText(text, names) : text; };
  const wordsText = function (text) { return names && typeof shared.sessionsMentionText === "function" ? shared.sessionsMentionText(text, names) : text; };
  return shared.sessionsTaskEntries(message, batch, state.statusById, state.activity, state.messagesById, appText, wordsText, state.waitingForUser).map(function (entry) {
    const member = state.members.find(function (candidate) { return candidate.id === entry.item.targetParticipantId; });
    return {
      participantId: entry.item.targetParticipantId,
      kind: member ? member.kind : sessionsKindOf(state, entry.item.targetParticipantId) || (isProviderKind(entry.item.targetKind) ? entry.item.targetKind : ""),
      title: entry.title,
      status: entry.status,
      line: entry.line || "",
      // A stopped task's line says so, muted (shared sessionsTaskEntries).
      ...(entry.lineMuted ? { lineMuted: true } : {}),
      since: entry.since,
      durationMs: entry.durationMs,
      focus: sessionsTaskFocus(state, message.id, entry.item)
    };
  });
}

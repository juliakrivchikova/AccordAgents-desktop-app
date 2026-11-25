import { accordIcon } from "../accord/accordCards.js";
import { openAccordScreen } from "../accord/accordDock.js";
import { lineIcon } from "../activity/activityData.js";
import { CHAT_LIST_AT_KEY } from "../base/storageKeys.js";
import { keepingReaderAtLatest } from "../chat/chatScroll.js";
import { render } from "../chat/render.js";
import { loadChats } from "../chats/chatStore.js";
import { openChatState, openConversation, selectedConversationId } from "../chats/openChat.js";
import { avatarForMember, mobileSharedRules, paintAvatar } from "./avatars.js";
import { chatMembers, selectedConversationMembers } from "./mentions.js";
import { chatTitleMenuState, toggleChatTitleMenu } from "../sessions/chatTitleMenu.js";
import { forkFromItem, forkOffered, forkStarting, forkToNewChatState, paintForkItem, readForkPlan } from "../sessions/forkToNewChat.js";
import { stopMembersFromPhone } from "../sessions/sessionsRows.js";
import {
  chatViewOf, formerMemberKind, openMemberSession, sessionsCanStop, sessionsMemberSince, sessionsMemberTitleOf, sessionsRules,
  sessionsStateState, sessionsStopping, setOpenMemberSessionId
} from "../sessions/sessionsState.js";
import { compactDuration, providerLogoElement, sessionsElapsedElement, sessionsStopButton } from "../sessions/sessionsStatus.js";
import { applyDock } from "../shell/home.js";
import { isPlaceholderTimelineContent, listTimelineEntries } from "../store/timelineRows.js";
import { loadListActivitySeen, withListActivity } from "../sync/chatListPayload.js";

// --- members of the open chat ---------------------------------------------
// Everything shown here is already on the phone: the chat list carries each
// member's role and home machine. Nothing is asked of the desktop.

export let membersSheetOpen = false;

// The member whose Fork to new chat item is open in the classic view's
// members sheet; one at a time, closed with the sheet.
let membersSheetForkId;

// Lucide's git-fork, the computer's roster card icon.
const FORK_ICON_PATHS = ["M9 18a3 3 0 1 0 6 0a3 3 0 1 0 -6 0", "M3 6a3 3 0 1 0 6 0a3 3 0 1 0 -6 0", "M15 6a3 3 0 1 0 6 0a3 3 0 1 0 -6 0",
  "M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9", "M12 12v3"];

// Where a tap on a member in the open chat's members sheet lands: a
// running member's turn in progress (the rule Activity's Running rows use),
// any other member's last message. Worked out from the rows the chat's
// drawing already read, so the open sheet costs no reads of its own.
let membersSheetTargets = { conversationId: undefined, running: new Map(), lastById: new Map(), lastByHandle: new Map() };

let lastMembersSheetSignature = "";

function memberHandleKey(value) {
  return String(value || "").trim().replace(/^@/, "").toLowerCase();
}

export function updateMembersSheetTargets(conversationId, chat, entries) {
  const activityApi = self.AccordMobileActivity;
  if (!activityApi || !conversationId || !chat) return;
  let running = new Map();
  try {
    const activity = activityApi.buildActivity({
      entries: withListActivity(entries, [chat], loadListActivitySeen()),
      chats: [chat],
      isPlaceholder: isPlaceholderTimelineContent,
      chatListAt: localStorage.getItem(CHAT_LIST_AT_KEY) || undefined,
      now: Date.now()
    });
    for (const row of activity.running) {
      if (row.handle && row.openMessageId && !running.has(memberHandleKey(row.handle))) {
        running.set(memberHandleKey(row.handle), { messageId: row.openMessageId, threadRootId: row.openThreadRootId });
      }
    }
  } catch {
    running = new Map();
  }
  // Rows come oldest first: the last one seen per member is its newest.
  const lastById = new Map();
  const lastByHandle = new Map();
  for (const entry of entries) {
    if (!entry || entry.role !== "participant" || entry.status === "pending") continue;
    if (!String(entry.content || "").trim() && !(Array.isArray(entry.attachments) && entry.attachments.length > 0)) continue;
    const target = { messageId: entry.messageId || entry.sourceId, threadRootId: entry.threadRootId || undefined };
    if (!target.messageId) continue;
    if (entry.participantId) lastById.set(entry.participantId, target);
    if (entry.participantLabel) lastByHandle.set(memberHandleKey(entry.participantLabel), target);
  }
  membersSheetTargets = { conversationId: conversationId, running: running, lastById: lastById, lastByHandle: lastByHandle };
}

function memberSheetTarget(member) {
  if (membersSheetTargets.conversationId !== selectedConversationId()) return undefined;
  const key = memberHandleKey(member.handle);
  return membersSheetTargets.running.get(key) ||
    (member.id && membersSheetTargets.lastById.get(member.id)) ||
    membersSheetTargets.lastByHandle.get(key);
}

/** A tap on a member: the chat lands on its turn in progress, or on its
 *  last message, as the desktop's members list does. */
function openMemberMessage(handle) {
  const conversationId = selectedConversationId();
  const member = selectedConversationMembers().find(function (item) { return item.handle === handle; });
  const target = member ? memberSheetTarget(member) : undefined;
  if (!conversationId || !target || !target.messageId) return;
  closeMembersSheet();
  void openConversation(conversationId, { threadRootId: target.threadRootId, messageId: target.messageId });
}

export function memberKindLabel(kind) {
  if (kind === "claude-code") {
    return "Claude Code";
  }
  if (kind === "codex-cli") {
    return "Codex CLI";
  }
  if (kind === "gemini-cli") {
    return "Gemini CLI";
  }
  return "";
}

// Same wording as the desktop's run-location control, from the phone's
// point of view: the desktop is "local".
export function memberLocationLabel(member) {
  if (member.homeMachineId) {
    return member.homeMachineName || "Machine";
  }
  if (member.cloudRun) {
    return "Cloud run · AWS";
  }
  return "Local · desktop";
}

/** The header keeps the handoff's spacer (the shell contract checks it)
 *  only while nothing sits at its end. With a chat open the members button
 *  is always there, so in practice the spacer stays hidden. */
export function syncHeaderSpacer() {
  const spacer = document.getElementById("send-log-spacer");
  if (!spacer) return;
  const sendLog = document.getElementById("send-log-button");
  const members = document.getElementById("chat-members-button");
  const viewSwitch = document.getElementById("chat-view-switch");
  spacer.hidden = Boolean(sendLog && !sendLog.hidden) || Boolean(members && !members.hidden) || Boolean(viewSwitch && !viewSwitch.hidden);
}

/** The header's way to the members, with how many there are, whenever a
 *  chat is open (the User, 2026-11-01): the title opens the same sheet, but
 *  nothing on screen said so. The number is the sheet's own count. */
export function renderMembersButton(conversationId, chat) {
  const button = document.getElementById("chat-members-button");
  if (!button) return;
  const count = chat ? chatMembers(chat).length : 0;
  const shown = Boolean(conversationId);
  if (button.hidden === shown) button.hidden = !shown;
  const number = document.getElementById("chat-members-count");
  // In the sessions view the button says how many members are at work, as
  // the desktop's "Members (N running)" does.
  const sessionsView = Boolean(chat) && chatViewOf(chat) === "sessions";
  const state = sessionsView && sessionsStateState.lastSessionsState && sessionsStateState.lastSessionsState.conversationId === conversationId ? sessionsStateState.lastSessionsState : undefined;
  const running = state ? state.runningCount : 0;
  const text = sessionsView ? (running > 0 ? String(running) : "") : count > 0 ? String(count) : "";
  if (number && number.textContent !== text) number.textContent = text;
  button.classList.toggle("is-running", sessionsView && running > 0);
  button.dataset.view = sessionsView ? "sessions" : "classic";
  // An Accord still open in the sessions view: a dot on the members icon,
  // whose sheet lists it.
  const dot = document.getElementById("chat-members-dot");
  const accordOpen = Boolean(state && (state.openAccord || sessionsStateState.openAccordLaunchId));
  if (dot && dot.hidden === accordOpen) dot.hidden = !accordOpen;
  button.classList.toggle("has-accord", accordOpen);
  // The sessions view never says "members" (the User, 2026-11-21).
  const label = sessionsView ? (running > 0 ? "Side panel (" + running + " running)" : "Side panel")
    : count === 1 ? "Members: 1 member" : count > 0 ? "Members: " + count + " members" : "Members";
  if (button.getAttribute("aria-label") !== label) button.setAttribute("aria-label", label);
  syncHeaderSpacer();
}

/** The sessions view's one panel (the header's icon; the desktop's right
 *  panel), with no title (the User, 2026-11-21): the chat's Accord, then
 *  the sessions the main session delegated (never the main session, whose
 *  settings are on the computer's composer chip) — logo, task, what it
 *  does, how long, Stop — with Stop all; those that worked and ended under
 *  Previous, and those no longer in the chat under Removed (their sessions
 *  read only). Nothing is said when there are none. */
function renderSessionsMembersSheet(state, list, title) {
  const shared = sessionsRules();
  // No Stop all, as on the computer: each session is stopped from its row.
  const stopAll = document.getElementById("members-sheet-stop-all");
  if (stopAll) stopAll.hidden = true;
  const rows = state.memberRows;
  // How long a member works or worked (every row says it, as on the
  // computer): waiting, from its turn's start to when it began to wait;
  // ended, its task.
  const workedMs = function (row, since) {
    const waitedAt = row.status === "waiting" && state.waitingSince ? state.waitingSince.get(row.participant.id) : undefined;
    const running = shared.memberRunningSince(row.participant.id, state.messages);
    const beforeWaiting = running && waitedAt ? Date.parse(waitedAt) - Date.parse(running) : NaN;
    if (Number.isFinite(beforeWaiting) && beforeWaiting >= 0) return beforeWaiting;
    return row.task && typeof shared.sessionsTaskDurationMs === "function" ? shared.sessionsTaskDurationMs(row.task.item, state.messagesById) : undefined;
  };
  const describe = function (row) {
    const id = row.participant.id;
    const since = row.status === "running" ? sessionsMemberSince(state, id) : undefined;
    const worked = row.status === "running" || row.status === "idle" ? undefined : workedMs(row, since);
    return {
      id: id,
      kind: row.participant.kind || "",
      name: sessionsMemberTitleOf(state, row.participant),
      status: row.status,
      since: since,
      workedMs: worked,
      canStop: sessionsCanStop(state, [id]),
      stopping: sessionsStopping(state, [id])
    };
  };
  const current = rows.current.map(describe);
  const previous = rows.previous.map(describe);
  const removed = state.formerMembers.map(function (former) {
    const task = state.tasksByMember.get(former.id);
    const status = shared.sessionsFormerMemberStatus(task ? task.item : undefined);
    return { id: former.id, kind: formerMemberKind(former), name: sessionsMemberTitleOf(state, former.id),
      status: status, workedMs: status !== "idle" && task && typeof shared.sessionsTaskDurationMs === "function" ? shared.sessionsTaskDurationMs(task.item, state.messagesById) : undefined,
      former: true };
  });
  const docked = state.openAccord || undefined;
  const accord = docked ? { launchId: docked.launchId, text: docked.progress.title + " · " + shared.accordProgressStatus(docked.progress) } : undefined;
  const signature = JSON.stringify(["sessions", state.conversationId, accord, current, previous, removed, sessionsStateState.membersPreviousOpen, sessionsStateState.membersRemovedOpen]);
  if (signature === lastMembersSheetSignature && list.childElementCount > 0) return;
  lastMembersSheetSignature = signature;
  if (title) {
    title.textContent = "";
    title.hidden = true;
  }
  document.getElementById("members-sheet")?.setAttribute("aria-label", "Side panel");
  list.replaceChildren();
  if (accord) {
    const item = document.createElement("div");
    item.className = "members-sheet-row sessions-accord-row is-openable";
    item.dataset.sheetAccord = accord.launchId;
    item.setAttribute("role", "button");
    item.tabIndex = 0;
    const icon = document.createElement("span");
    icon.className = "accord-strip-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.append(accordIcon(16));
    const text = document.createElement("span");
    text.className = "members-sheet-copy";
    const name = document.createElement("strong");
    name.textContent = "Accord";
    const line = document.createElement("span");
    line.className = "members-sheet-location";
    line.textContent = accord.text;
    text.append(name, line);
    item.append(icon, text);
    list.append(item);
  }
  // One line per session, the computer's anatomy (the User, 2026-11-22):
  // its provider's glyph with a dot while it runs (pulsing) or waits for
  // the User, no state words, its task, and how long it works or worked;
  // no model; Stop at the end while it runs.
  const statusLabel = function (status) {
    return shared && shared.SESSIONS_WORK_STATUS_LABELS ? shared.SESSIONS_WORK_STATUS_LABELS[status] || status : status;
  };
  const rowElement = function (row) {
    const item = document.createElement("div");
    item.className = "members-sheet-row sessions-member-row sessions-agent-row is-openable" + (row.former ? " is-former" : "");
    item.dataset.memberSession = row.id;
    item.dataset.memberStatus = row.status;
    item.setAttribute("role", "button");
    item.tabIndex = 0;
    item.setAttribute("aria-label", row.status === "idle" ? row.name : row.name + ", " + statusLabel(row.status));
    const glyph = document.createElement("span");
    glyph.className = "sessions-agent-glyph";
    glyph.append(providerLogoElement(row.kind));
    // A dot only while its state matters, as on the computer: it runs
    // (pulsing) or waits for the User; none once it ended.
    if (row.status === "running" || row.status === "waiting") {
      const dot = document.createElement("span");
      dot.className = "sessions-agent-dot is-" + row.status;
      dot.setAttribute("aria-hidden", "true");
      glyph.append(dot);
    }
    const name = document.createElement("strong");
    name.className = "members-sheet-task";
    name.textContent = row.name;
    const meta = document.createElement("span");
    meta.className = "sessions-agent-meta";
    const time = row.since ? sessionsElapsedElement(row.since, "is-compact")
      : typeof row.workedMs === "number" ? Object.assign(document.createElement("span"), { className: "sessions-agent-time", textContent: compactDuration(row.workedMs) })
        : undefined;
    if (time) meta.append(time);
    item.append(glyph, name, meta);
    // Stop only while it runs, as on the computer.
    if (!row.former && (row.status === "running" || row.stopping) && (row.canStop || row.stopping)) item.append(sessionsStopButton([row.id], row.canStop, row.stopping, "Stop " + row.name, "members-sheet-stop"));
    return item;
  };
  const group = function (label, dataName, open, entries) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "members-previous-toggle";
    toggle.dataset[dataName] = "1";
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    toggle.append(lineIcon([open ? "m6 9 6 6 6-6" : "m9 18 6-6-6-6"], 14));
    const text = document.createElement("span");
    text.textContent = label;
    const count = document.createElement("span");
    count.className = "members-previous-count";
    count.textContent = String(entries.length);
    toggle.append(text, count);
    list.append(toggle);
    if (open) for (const row of entries) list.append(rowElement(row));
  };
  for (const row of current) list.append(rowElement(row));
  if (previous.length > 0) group("Previous agents", "membersPrevious", sessionsStateState.membersPreviousOpen, previous);
  if (removed.length > 0) group("Removed", "membersRemoved", sessionsStateState.membersRemovedOpen, removed);
}

function renderMembersSheet(chat) {
  const sheet = document.getElementById("members-sheet");
  const list = document.getElementById("members-sheet-list");
  const title = document.getElementById("members-sheet-title");
  if (!sheet || !list) {
    return;
  }
  sheet.hidden = !membersSheetOpen;
  keepingReaderAtLatest(applyDock);
  for (const id of ["chat-members-toggle", "chat-members-button"]) {
    document.getElementById(id)?.setAttribute("aria-expanded", membersSheetOpen ? "true" : "false");
  }
  if (!membersSheetOpen) {
    return;
  }
  const conversationId = selectedConversationId();
  const stopAll = document.getElementById("members-sheet-stop-all");
  if (chat && chatViewOf(chat) === "sessions") {
    // The classic view's fork item does not stay open across a switch.
    membersSheetForkId = undefined;
    // Drawn from the chat's last drawing; until it is in, the sheet keeps
    // what it shows.
    if (sessionsStateState.lastSessionsState && sessionsStateState.lastSessionsState.conversationId === conversationId) renderSessionsMembersSheet(sessionsStateState.lastSessionsState, list, title);
    return;
  }
  if (stopAll) stopAll.hidden = true;
  const members = chat ? selectedConversationMembers() : [];
  const targets = membersSheetTargets.conversationId === conversationId ? membersSheetTargets : undefined;
  // Redrawn only when what it shows changed: a member streaming redraws the
  // chat every second or so, and a row replaced under the finger loses the tap.
  // Members known only by handle (a chat listed without its members) are
  // not offered: the server finds a member by its id.
  const forkable = forkOffered() && Boolean(chat) && Array.isArray(chat.members) && chat.members.length > 0;
  const signature = JSON.stringify([conversationId, forkable, members.map(function (member) {
    return [member.id, member.handle, member.displayName, member.roleLabel, member.kind, memberLocationLabel(member), member.avatarId || "",
      Boolean(targets && targets.running.has(memberHandleKey(member.handle))), Boolean(memberSheetTarget(member)), membersSheetForkId === member.id];
  })]);
  if (signature === lastMembersSheetSignature && list.childElementCount > 0) {
    renderMembersSheetFork(chat);
    return;
  }
  lastMembersSheetSignature = signature;
  document.getElementById("members-sheet")?.setAttribute("aria-label", "Members");
  if (title) {
    title.hidden = false;
    title.textContent = members.length === 1 ? "1 member" : members.length + " members";
  }
  list.replaceChildren();
  if (members.length === 0) {
    const empty = document.createElement("div");
    empty.className = "members-sheet-empty";
    empty.textContent = "No members in this chat yet.";
    list.append(empty);
    return;
  }
  members.forEach(function (member) {
    const row = document.createElement("div");
    row.className = "members-sheet-row";
    row.dataset.handle = member.handle;
    const avatar = document.createElement("span");
    avatar.className = "mobile-mention-avatar";
    paintAvatar(avatar, avatarForMember(member), selectedConversationId());
    const copy = document.createElement("span");
    copy.className = "members-sheet-copy";
    const nameLine = document.createElement("span");
    nameLine.className = "members-sheet-name-line";
    const name = document.createElement("strong");
    name.textContent = member.displayName;
    nameLine.append(name);
    const key = memberHandleKey(member.handle);
    if (targets && targets.running.has(key)) {
      const status = document.createElement("span");
      status.className = "members-sheet-status";
      const dot = document.createElement("span");
      dot.className = "mobile-live-dot";
      dot.setAttribute("aria-hidden", "true");
      status.append(dot, document.createTextNode("Running"));
      nameLine.append(status);
      row.dataset.running = "1";
    }
    const role = document.createElement("span");
    role.className = "members-sheet-role";
    role.textContent = [member.roleLabel, memberKindLabel(member.kind)].filter(Boolean).join(" · ");
    const location = document.createElement("span");
    location.className = "members-sheet-location";
    location.textContent = memberLocationLabel(member);
    copy.append(nameLine, role, location);
    // What a tap opens (its last message) is its own element beside the
    // fork action: a button inside a role=button would be out of a screen
    // reader's reach. A tap anywhere else on the row opens it too.
    const open = document.createElement("span");
    open.className = "members-sheet-open";
    open.append(avatar, copy);
    row.append(open);
    if (memberSheetTarget(member)) {
      row.classList.add("is-openable");
      open.setAttribute("role", "button");
      open.tabIndex = 0;
    }
    // Fork to new chat: a small action on the member, as on the computer's
    // roster card. A tap opens its item under the member (what it makes,
    // or why not, read from the server as the sessions view's title menu
    // reads it); a tap on the item makes the chat.
    const forkOpen = membersSheetForkId === member.id;
    if (forkable) row.append(membersSheetForkToggle(member, forkOpen));
    list.append(row);
    if (forkable && forkOpen) list.append(membersSheetForkItem());
  });
  renderMembersSheetFork(chat);
}

function membersSheetForkToggle(member, open) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "mobile-icon-button is-muted members-sheet-fork-toggle";
  button.dataset.memberFork = member.id;
  button.setAttribute("aria-label", mobileSharedRules().FORK_TO_NEW_CHAT_LABEL + ": " + member.displayName);
  button.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) button.setAttribute("aria-controls", "members-sheet-fork");
  button.append(lineIcon(FORK_ICON_PATHS, 18));
  return button;
}

/** The item itself, as the title's menu draws it; painted by
 *  renderMembersSheetFork. */
function membersSheetForkItem() {
  const button = document.createElement("button");
  button.type = "button";
  button.id = "members-sheet-fork";
  button.className = "chat-title-menu-item chat-title-menu-fork members-sheet-fork-item";
  button.setAttribute("aria-disabled", "true");
  button.setAttribute("aria-describedby", "members-sheet-fork-detail");
  const copy = document.createElement("span");
  copy.className = "chat-title-menu-copy";
  const label = document.createElement("span");
  label.className = "chat-title-menu-label";
  label.textContent = mobileSharedRules().FORK_TO_NEW_CHAT_LABEL;
  const detail = document.createElement("span");
  detail.id = "members-sheet-fork-detail";
  detail.className = "chat-title-menu-detail";
  detail.setAttribute("aria-live", "polite");
  copy.append(label, detail);
  button.append(copy);
  return button;
}

export function renderMembersSheetFork(chat) {
  const button = document.getElementById("members-sheet-fork");
  const detail = document.getElementById("members-sheet-fork-detail");
  if (!button || !detail || !chat || !membersSheetForkId || !forkOffered()) return;
  paintForkItem(button, detail, chat, membersSheetForkId);
}

/** A tap on a member's fork action: its item opens under it and is read
 *  again from the server, whatever it said before; a second tap closes it. */
function toggleMembersSheetFork(participantId) {
  const chat = activeChatRecord();
  // While a fork is being made its item says so; another opens after.
  if (!chat || !participantId || forkStarting) return;
  const focused = document.activeElement instanceof Element && document.activeElement.closest("[data-member-fork]") !== null;
  membersSheetForkId = membersSheetForkId === participantId ? undefined : participantId;
  if (membersSheetForkId) {
    forkToNewChatState.forkMenu = undefined;
    void readForkPlan(chat, membersSheetForkId);
  }
  renderMembersSheet(chat);
  // The list is drawn again: the toggle tapped keeps the focus, and the
  // item it opened is brought into view on a long list.
  const toggle = [...document.querySelectorAll("#members-sheet-list [data-member-fork]")].find(function (button) { return button.dataset.memberFork === participantId; });
  if (focused && toggle) toggle.focus();
  if (membersSheetForkId) document.getElementById("members-sheet-fork")?.scrollIntoView({ block: "nearest" });
}

export function renderMembersSheetIfOpen(chat) {
  if (membersSheetOpen) {
    renderMembersSheet(chat);
  }
}

export function activeChatRecord() {
  const conversationId = selectedConversationId();
  return loadChats().find(function (chat) {
    return chat.id === conversationId;
  });
}

export function openMembersSheet() {
  membersSheetOpen = true;
  renderMembersSheet(activeChatRecord());
  // Who is running and where each member lands, from the chat's rows; kept
  // current by the chat's own drawing while the sheet stays open.
  const conversationId = selectedConversationId();
  void listTimelineEntries(conversationId).then(function (entries) {
    if (!membersSheetOpen || selectedConversationId() !== conversationId) return;
    updateMembersSheetTargets(conversationId, activeChatRecord(), entries);
    renderMembersSheet(activeChatRecord());
  }).catch(function () { return undefined; });
}

export function closeMembersSheet() {
  membersSheetOpen = false;
  membersSheetForkId = undefined;
  lastMembersSheetSignature = "";
  renderMembersSheet(undefined);
}

export function wireMembersSheet() {
  const toggle = document.getElementById("chat-members-toggle");
  const sheet = document.getElementById("members-sheet");
  const close = document.getElementById("members-sheet-close");
  if (!toggle || !sheet) {
    return;
  }
  // The title and the members button open the same sheet.
  function toggleMembers() {
    if (!selectedConversationId()) {
      return;
    }
    if (membersSheetOpen) {
      closeMembersSheet();
    } else {
      openMembersSheet();
    }
  }
  // The title: the members in the classic view; in the sessions view (one
  // way to the members, the icon at the header's end) the view's menu.
  function titleTapped() {
    if (chatTitleMenuState(activeChatRecord()).available) {
      toggleChatTitleMenu();
      return;
    }
    toggleMembers();
  }
  toggle.addEventListener("click", titleTapped);
  document.getElementById("chat-members-button")?.addEventListener("click", toggleMembers);
  close?.addEventListener("click", closeMembersSheet);
  // One handler on the list: rows are redrawn as members start and stop.
  document.getElementById("members-sheet-list")?.addEventListener("click", function (event) {
    const target = event.target instanceof Element ? event.target : null;
    // The classic view's list: a member's Fork to new chat, and its item.
    const forkToggle = target ? target.closest("[data-member-fork]") : null;
    if (forkToggle) {
      toggleMembersSheetFork(forkToggle.dataset.memberFork);
      return;
    }
    const forkItem = target ? target.closest("#members-sheet-fork") : null;
    if (forkItem) {
      forkFromItem(forkItem);
      return;
    }
    // The sessions view's list: Stop a member, show the members that
    // ended, or open a member's session.
    const stop = target ? target.closest("[data-stop-members]") : null;
    if (stop) {
      if (!stop.disabled) void stopMembersFromPhone(stop.dataset.stopMembers.split(",").filter(Boolean));
      return;
    }
    if (target && target.closest("[data-members-previous]")) {
      sessionsStateState.membersPreviousOpen = !sessionsStateState.membersPreviousOpen;
      renderMembersSheet(activeChatRecord());
      return;
    }
    if (target && target.closest("[data-members-removed]")) {
      sessionsStateState.membersRemovedOpen = !sessionsStateState.membersRemovedOpen;
      renderMembersSheet(activeChatRecord());
      return;
    }
    // The main session's row leads back to its timeline; the Accord's to
    // its own screen.
    if (target && target.closest("[data-sheet-main]")) {
      closeMembersSheet();
      setOpenMemberSessionId(undefined);
      // A member's message still to be landed on would open its session again.
      openChatState.pendingMessageFocus = undefined;
      sessionsStateState.openAccordLaunchId = undefined;
      void render();
      return;
    }
    const accordRow = target ? target.closest("[data-sheet-accord]") : null;
    if (accordRow) {
      openAccordScreen(accordRow.dataset.sheetAccord);
      return;
    }
    const session = target ? target.closest("[data-member-session]") : null;
    if (session) {
      openMemberSession(session.dataset.memberSession);
      return;
    }
    const row = target ? target.closest(".members-sheet-row.is-openable") : null;
    if (row && row.dataset.handle) openMemberMessage(row.dataset.handle);
  });
  document.getElementById("members-sheet-stop-all")?.addEventListener("click", function (event) {
    const button = event.currentTarget;
    if (button.disabled) return;
    void stopMembersFromPhone(String(button.dataset.stopMembers || "").split(",").filter(Boolean));
  });
  sheet.addEventListener("click", function (event) {
    if (event.target instanceof Element && event.target.dataset.membersClose === "1") {
      closeMembersSheet();
    }
  });
}

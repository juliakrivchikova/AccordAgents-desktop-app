import { accordLaunchAvatarSignature, accordLaunchCardElement, accordLaunchCardForEntry } from "../accord/accordCards.js";
import { accordClosedLaunchOf, accordLineElement, accordLineSignatureOf } from "../accord/accordLines.js";
import { nowIso } from "../base/bytes.js";
import { cardsForMessage, noteProgressOf, pendingCardsForMessage, syncAnsweredCards } from "../cards/cardRows.js";
import { controlCardSignature, syncPendingCards } from "../cards/tailCards.js";
import { artifactNoteCardElement, artifactNoteCardForEntry } from "./artifactNotes.js";
import { setOpenThreadRootId } from "./chatScroll.js";
import { finishedNoteCardElement, finishedNoteOfEntry } from "./finishedNoteCard.js";
import { render } from "./render.js";
import { applyStreamableState } from "./streamView.js";
import { urgentAlertCardElement, urgentAlertOfEntry } from "./urgentAlerts.js";
import { syncWaitingActions, waitingSignature } from "./waitingMessage.js";
import { loadChats } from "../chats/chatStore.js";
import { selectedConversationId } from "../chats/openChat.js";
import { attachmentsNodeFor, renderAttachmentsInto } from "../media/attachments.js";
import { avatarForLabel, avatarSignature, clearAvatarKindClasses, paintAvatar } from "../members/avatars.js";
import { conversationMembers } from "../members/mentions.js";
import { OUTBOX_REFUSED, OUTBOX_SUPERSEDED } from "../outbox/hubOutbox.js";
import { serverOwesEntry, stopRequestedRunIds, stopRunFromPhone } from "../outbox/sending.js";
import { appendSessionsSpecial, sessionsDelegationsElement, sessionsSpecialSignature } from "../sessions/sessionsCards.js";
import { openWorkedFolds, sessionsRules, sessionsStateState } from "../sessions/sessionsState.js";
import {
  compactElapsed, formatWorked, isSessionsRunningEntry, providerLogoElement, sessionsRunningText, sessionsWorkedElement,
  sessionsWorkedSignature, syncSessionsWorked, syncSessionsWorking
} from "../sessions/sessionsStatus.js";
import { hubMachines } from "../settings/machineWake.js";
import { activitySignature, interimPostsSignature, syncInterimPosts } from "../sync/timelinePayload.js";
import { renderMessageContentIfChanged } from "../text/messageText.js";

// Held so a second bootstrap replaces the ticker instead of stacking another
// one on top of it.
let activeThinkingClockTimer;

export function messageRowSignature(entry) {
  const sessionsView = entry.presentation === "sessions";
  return JSON.stringify({
    replyCount: entry.replyCount,
    author: entry.author,
    participantLabel: entry.participantLabel,
    // The sessions view draws no avatars, and names an author only where
    // one must be told apart (the main session in a member's session).
    presentation: entry.presentation,
    authorLabel: entry.authorLabel,
    authorKind: entry.authorKind,
    worked: sessionsView ? entry.workedMs : undefined,
    continued: sessionsView && entry.turnContinues ? true : undefined,
    // Its steps (a running reply's rows; what its Worked for opens to, and
    // whether it is open).
    activity: sessionsView && activitySignature(entry)
      ? activitySignature(entry) + (openWorkedFolds.has(entry.rowKey || entry.id) ? ":open" : "") : undefined,
    liveStatus: sessionsView && entry.liveStatus ? true : undefined,
    waiting: sessionsView ? waitingSignature(entry) : undefined,
    startedAt: sessionsView ? entry.startedAt : undefined,
    sessions: sessionsView ? sessionsSpecialSignature(entry) : undefined,
    avatar: entry.author === "agent" && entry.identified !== false && !sessionsView ? avatarSignature(rowAvatar(entry)) : undefined,
    identified: entry.identified,
    scaffolding: entry.scaffolding,
    content: entry.content,
    interimPosts: interimPostsSignature(entry) || undefined,
    // The sessions view draws a mention as its member's chip (logo and
    // task title): a row that mentions someone is drawn again when who
    // they are changes, or its chip keeps an old title.
    mentions: sessionsView && sessionsStateState.sessionsMentionScope && entryMentionsSomeone(entry) ? sessionsStateState.sessionsMentionScope.key : undefined,
    answered: answeredCardsForMessage(entry).map(function (card) {
      return card.id + ":" + (card.outcome || "") + ":" + (card.decidedAt || "");
    }),
    pending: pendingCardsForMessage(entry).map(controlCardSignature),
    attachments: Array.isArray(entry.attachments)
      ? entry.attachments.map(function (attachment) { return attachment.id; })
      : undefined,
    status: entry.status,
    mark: entry.mark,
    when: formatClockTime(entry.createdAt),
    runId: entry.runId,
    turn: entry.sourceMessageId ? entry.sourceMessageId + ":" + (entry.participantId || "") : undefined,
    stopRequested: entry.stopRequested,
    accordAvatars: sessionsView ? undefined : accordLaunchSignatureOf(entry),
    noteProgress: noteProgressOf(entry),
    urgentAlert: entry.urgentAlert ? JSON.stringify(entry.urgentAlert) : undefined,
    accordLine: accordLineSignatureOf(entry)
  });
}

function entryMentionsSomeone(entry) {
  return String(entry.content || "").indexOf("@") >= 0 || (Array.isArray(entry.interimPosts) && entry.interimPosts.some(function (post) {
    return String(post && post.content || "").indexOf("@") >= 0;
  }));
}

function accordLaunchSignatureOf(entry) {
  const card = accordLaunchCardForEntry(entry);
  return card ? accordLaunchAvatarSignature(entry, card) : undefined;
}

// A pending agent row with no text yet is a run that has started and not
// produced output. The desktop shows an animated "Thinking" plus elapsed
// time; match it rather than the flat placeholder sentence.
export function isThinkingEntry(entry) {
  return entry.author === "agent" &&
    entry.status === "Running" &&
    /\bis running\.\.\.$|^Running\.\.\.$/.test((entry.content || "").trim());
}

// W-M(f): the stated reason lives on the row itself for a moment — no
// modal, no view that would hang empty.
export function flashRowNotice(row, text) {
  const status = row.querySelector(".message-status");
  if (!status || status.dataset.noticeTimer) {
    return;
  }
  const original = status.textContent;
  status.dataset.noticeTimer = "1";
  status.textContent = text;
  setTimeout(function () {
    delete status.dataset.noticeTimer;
    status.textContent = original;
  }, 1600);
}

function renderThinkingInto(container, entry) {
  if (container.dataset.thinking === "1") {
    return;
  }
  container.dataset.thinking = "1";
  container.textContent = "";
  const label = document.createElement("span");
  label.className = "thinking-label";
  label.textContent = "Thinking";
  const elapsed = document.createElement("span");
  elapsed.className = "thinking-elapsed";
  elapsed.dataset.startedAt = entry.createdAt || nowIso();
  elapsed.textContent = formatElapsed(entry.createdAt);
  container.append(label, elapsed);
}

export function formatElapsed(startedAt) {
  const started = Date.parse(startedAt || "");
  const total = Number.isFinite(started) ? Math.max(0, Math.floor((Date.now() - started) / 1000)) : 0;
  return Math.floor(total / 60) + ":" + String(total % 60).padStart(2, "0");
}

// Only the seconds text is touched, never the row, so ticking cannot cause
// the list churn that made the view jump.
export function startThinkingClock() {
  clearInterval(activeThinkingClockTimer);
  activeThinkingClockTimer = setInterval(function () {
    for (const node of document.querySelectorAll(".thinking-elapsed")) {
      const next = formatElapsed(node.dataset.startedAt);
      if (node.textContent !== next) {
        node.textContent = next;
      }
    }
    // The sessions view's running times count the way the desktop's do.
    for (const node of document.querySelectorAll(".sessions-elapsed")) {
      const next = node.classList.contains("is-compact") ? compactElapsed(node.dataset.startedAt) : formatWorked(node.dataset.startedAt);
      if (node.textContent !== next) node.textContent = next;
    }
  }, 1000);
}

// The slot is held either way so the row does not jump sideways when the
// participant becomes known; it simply carries no identity until then.
// Same clock the desktop prints under a message. A finished message says
// when it was written; only a message still in flight says what it is doing.
// One formatter for every row: toLocaleTimeString builds a new one per
// call, and every row's change check asks for its time on every redraw —
// the single largest cost of drawing a chat, which a send waited behind.
let clockFormatter;

export function formatClockTime(iso) {
  const time = Date.parse(iso || "");
  if (!Number.isFinite(time)) {
    return "";
  }
  if (!clockFormatter) clockFormatter = new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit", hour12: false });
  return clockFormatter.format(new Date(time));
}

export function messageStatusLabel(entry) {
  // A running reply of the sessions view says "Working for …" instead.
  if (isSessionsRunningEntry(entry)) return "";
  // A refused message of the User's says why; one not sent yet is faded
  // and shows its time like any other.
  if (entry.author === "you" && entry.mark) return entry.mark;
  if (entry.author === "you" || entry.status === "Done" || entry.status === "Sent") {
    return formatClockTime(entry.createdAt) || entry.status;
  }
  return entry.status;
}

/** A row's author: its name, or in the sessions view the main session's
 *  provider logo where an author must be told apart (a member's session). */
function fillRowHandle(handle, entry) {
  if (entry.authorKind) {
    if (handle.dataset.authorKind !== entry.authorKind) {
      handle.dataset.authorKind = entry.authorKind;
      handle.replaceChildren(providerLogoElement(entry.authorKind === "unknown" ? "" : entry.authorKind, "is-chip"));
    }
    return;
  }
  delete handle.dataset.authorKind;
  handle.textContent = rowHandleText(entry);
}

function rowHandleText(entry) {
  if (entry.presentation === "sessions") return entry.authorLabel || "";
  return entry.identified === false ? "" : (entry.participantLabel || "Agent");
}

// The member list can arrive after the row did, and a member's picture can
// change on the desktop; the row's signature carries the resolved avatar so
// the row is patched when either happens.
function rowAvatar(entry) {
  const conversationId = entry.conversationId || selectedConversationId();
  return avatarForLabel(conversationMembers(conversationId), entry.participantLabel || "Agent");
}

export function applyRowIdentity(avatar, entry) {
  // The sessions view shows nobody's avatar (docs/main-session.md): the
  // slot is drawn empty and the view's style takes it out.
  if (entry.identified === false || entry.presentation === "sessions") {
    if (avatar.dataset.avatarSignature !== "") {
      avatar.textContent = "";
      avatar.removeAttribute("style");
      clearAvatarKindClasses(avatar);
      avatar.dataset.avatarSignature = "";
      delete avatar.dataset.avatarLoaded;
    }
    avatar.dataset.identified = "0";
    return;
  }
  const conversationId = entry.conversationId || selectedConversationId();
  paintAvatar(avatar, rowAvatar(entry), conversationId);
  avatar.dataset.identified = "1";
}

function renderScaffoldingInto(item) {
  const dots = document.createElement("div");
  dots.className = "message-typing";
  dots.setAttribute("role", "status");
  dots.setAttribute("aria-label", "Waiting for a reply");
  for (let index = 0; index < 3; index += 1) {
    dots.append(document.createElement("span"));
  }
  item.append(dots);
}

/** How long after a message a member it was for may still be shown as
 *  not started yet. */
const ROUTED_ROW_MAX_MS = 30 * 60_000;

/**
 * A member a message of the User's asked a turn of, whose own device has
 * not taken it yet: shown under the message as waiting for that device
 * ("waking" while the server is starting its machine), with Stop, which
 * names the turn so its device never starts it. Gone once the turn is
 * taken (or stopped) on the server, or the member's own row arrives. A
 * message from this phone the server has not answered yet waits for it.
 */
export function routedRows(conversationId, messageEntries, timelineEntries, requestedStopRunIds) {
  const chat = loadChats().find(function (item) { return item.id === conversationId; });
  const members = chat && Array.isArray(chat.members) ? chat.members : [];
  const runIds = new Set(timelineEntries.map(function (entry) { return entry.runId; }).filter(Boolean));
  const stoppedLines = timelineEntries.filter(function (entry) {
    return entry.role === "system" && /stopped by user\.$/.test(String(entry.content || ""));
  });
  // What the server said of each message's turns (its copy carries them).
  const turnsByMessage = new Map();
  for (const entry of timelineEntries) {
    const messageId = entry.role === "you" ? (entry.messageId || entry.sourceId) : undefined;
    if (messageId && Array.isArray(entry.turns)) turnsByMessage.set(messageId, entry);
  }
  const asks = [];
  const own = new Set();
  for (const entry of messageEntries) {
    if (!entry.hub || entry.status === OUTBOX_REFUSED || entry.status === OUTBOX_SUPERSEDED) continue;
    own.add(entry.eventId);
    const copy = turnsByMessage.get(entry.eventId);
    // Once the server's copy is here, the turns it asked are what count; a
    // member it asked nothing of (not in the chat any more) waits for nobody.
    const targets = copy ? copy.turns.map(function (turn) { return turn.participantId; })
      : entry.hubDelivery && Array.isArray(entry.hubDelivery.targets) ? entry.hubDelivery.targets : [];
    asks.push({
      messageId: entry.eventId, createdAt: entry.createdAt, targets: targets, turns: copy ? copy.turns : undefined,
      sent: Boolean(copy) || !serverOwesEntry(entry),
      threadRootId: entry.payload && typeof entry.payload.threadRootId === "string" ? entry.payload.threadRootId : undefined
    });
  }
  for (const [messageId, copy] of turnsByMessage) {
    if (own.has(messageId)) continue;
    asks.push({ messageId: messageId, createdAt: copy.createdAt, targets: copy.turns.map(function (turn) { return turn.participantId; }),
      turns: copy.turns, sent: true, threadRootId: copy.threadRootId });
  }
  const rows = [];
  for (const ask of asks) {
    if (Date.now() - Date.parse(ask.createdAt) > ROUTED_ROW_MAX_MS) continue;
    for (const participantId of ask.targets) {
      const turn = ask.turns ? ask.turns.find(function (item) { return item.participantId === participantId; }) : undefined;
      // Taken by its device, stopped or done: the member's own row says so.
      if (turn && turn.state !== "requested") continue;
      const runId = turn ? turn.runId : globalThis.AccordHubClient.hubTurnRunId(ask.messageId, participantId);
      if (runIds.has(runId)) continue;
      const member = members.find(function (item) { return item.id === participantId; });
      if (!member) continue;
      const label = "@" + member.handle;
      if (stoppedLines.some(function (line) { return line.content.indexOf(label + " stopped") === 0 && line.createdAt >= ask.createdAt; })) continue;
      const machine = member.homeMachineId ? hubMachines.find(function (item) { return item.machineId === member.homeMachineId; }) : undefined;
      const where = member.homeMachineName || (machine && machine.name) || "its machine";
      // Not on the server yet (offline): nobody can start it, so the row
      // says what the message itself says.
      const content = !ask.sent ? "Waiting to sync…"
        : !member.homeMachineId ? "Waiting for your computer to start it…"
        : machine && machine.waking ? "Waking " + where + "…" : "Waiting for " + where + "…";
      rows.push({
        rowKey: "routed\0" + runId,
        id: runId,
        conversationId: conversationId,
        threadRootId: ask.threadRootId,
        author: "agent",
        participantLabel: label,
        identified: true,
        scaffolding: false,
        cancellable: true,
        content: content,
        status: "Running",
        createdAt: ask.createdAt + "~",
        sourceId: runId,
        runId: runId,
        // The turn a Stop names: the message and its member.
        sourceMessageId: ask.messageId,
        participantId: participantId,
        routed: true,
        stopRequested: requestedStopRunIds.has(runId) || stopRequestedRunIds.has(runId)
      });
    }
  }
  return rows;
}

export function isCancellableMobileRow(entry) {
  return entry.author === "agent" &&
    entry.status === "Running" &&
    Boolean(entry.runId) &&
    entry.cancellable !== false;
}

function syncMessageStopButton(meta, entry) {
  let button = meta.querySelector(".message-stop");
  // The sessions view's composer (and a member session's head) stops a
  // running reply: the reply itself has no Stop, as in T3 Code.
  if (!isCancellableMobileRow(entry) || isSessionsRunningEntry(entry)) {
    button?.remove();
    return;
  }
  if (!button) {
    button = document.createElement("button");
    button.type = "button";
    button.className = "message-stop";
    button.addEventListener("click", function (event) {
      event.preventDefault();
      event.stopPropagation();
      const targetRunId = button.dataset.runId;
      if (!targetRunId || button.disabled) {
        return;
      }
      button.disabled = true;
      button.textContent = "Stopping…";
      void stopRunFromPhone(targetRunId, undefined, { messageId: button.dataset.turnMessageId, participantId: button.dataset.participantId });
    });
    meta.append(button);
  }
  button.dataset.runId = entry.runId;
  button.dataset.turnMessageId = entry.sourceMessageId || "";
  button.dataset.participantId = entry.participantId || "";
  button.disabled = entry.stopRequested === true;
  button.textContent = entry.stopRequested ? "Stopping…" : "Stop";
  button.setAttribute("aria-label", "Stop response from " + rowHandleText(entry));
}

function createMessageRow(entry) {
  const item = document.createElement("li");
  item.className = "message-row";
  item.dataset.rowKey = entry.rowKey || entry.id;
  item.dataset.rowSignature = messageRowSignature(entry);
  item.dataset.status = entry.status;
  item.dataset.author = entry.author;
  item.classList.toggle("is-sessions", entry.presentation === "sessions");
  // The view it was drawn for: a view switch draws every row again.
  if (entry.presentation) item.dataset.presentation = entry.presentation;
  if (entry.presentation === "sessions" && entry.participantId) item.dataset.participantId = entry.participantId;
  // Which message this row is, for the screen a tap opens. Rows with nothing
  // the desktop can thread from -- scaffolding, a message still queued on
  // this phone -- carry none, so a tap on them does nothing.
  // Not a system note: the desktop offers a thread on every message but
  // those, and the phone offers exactly what the desktop does.
  if (entry.sourceId && !entry.scaffolding && entry.status !== "queued" && entry.author !== "system") {
    item.dataset.threadRoot = entry.sourceId;
  } else {
    delete item.dataset.threadRoot;
  }
  applyStreamableState(item, entry);
  if (entry.scaffolding) {
    item.dataset.scaffolding = "1";
    renderScaffoldingInto(item);
    return item;
  }
  // The sessions view's own rows: a task card, a member's session head,
  // its task, a member's choice still waiting.
  if (entry.presentation === "sessions" && appendSessionsSpecial(item, entry)) {
    return item;
  }
  if (urgentAlertOfEntry(entry)) {
    item.dataset.urgentAlert = "1";
    item.__urgentAlertEntry = entry;
    item.append(urgentAlertCardElement(entry));
    return item;
  }
  if (accordClosedLaunchOf(entry)) {
    item.dataset.accordLine = "1";
    item.append(accordLineElement(entry));
    return item;
  }
  const artifactNote = artifactNoteCardForEntry(entry);
  if (artifactNote) {
    item.dataset.artifactNote = "1";
    item.append(artifactNoteCardElement(entry, artifactNote));
    return item;
  }
  const accordLaunch = accordLaunchCardForEntry(entry);
  if (accordLaunch) {
    item.dataset.accordLaunch = "1";
    item.classList.toggle("is-on-its-way", Boolean(entry.onItsWay));
    item.classList.toggle("is-refused", Boolean(entry.refused));
    item.append(accordLaunchCardElement(entry, accordLaunch));
    appendThreadChip(item, entry);
    return item;
  }
  if (finishedNoteOfEntry(entry)) {
    item.dataset.finishedNote = "1";
    item.append(finishedNoteCardElement(entry));
    return item;
  }
  if (entry.author === "agent") {
    const avatar = document.createElement("div");
    avatar.className = "message-avatar";
    applyRowIdentity(avatar, entry);
    const copy = document.createElement("div");
    copy.className = "message-copy";
    const meta = document.createElement("div");
    meta.className = "message-meta";
    const handle = document.createElement("span");
    handle.className = "message-handle";
    fillRowHandle(handle, entry);
    const status = document.createElement("span");
    status.className = "message-status";
    status.textContent = messageStatusLabel(entry);
    const content = document.createElement("div");
    content.className = "message-content";
    if (isSessionsRunningEntry(entry)) {
      // No "Thinking" word: its "Working for …" and its steps say it.
      renderMessageContentIfChanged(content, sessionsRunningText(entry), entry.author);
    } else if (isThinkingEntry(entry)) {
      renderThinkingInto(content, entry);
    } else {
      renderMessageContentIfChanged(content, entryShownContent(entry), entry.author);
    }
    meta.append(handle, status);
    syncMessageStopButton(meta, entry);
    // The tasks the main session's turn gave (T3 Code): inside its "Worked
    // for …" above the reply, or under the reply while it is still written.
    // Any other finished reply of the sessions view says how long it worked
    // the same quiet way.
    const delegations = entry.presentation === "sessions" && entry.delegations && !entry.delegations.standalone
      ? sessionsDelegationsElement(entry.delegations) : sessionsWorkedElement(entry);
    if (delegations) delegations.dataset.workedSignature = sessionsWorkedSignature(entry);
    if (delegations && entry.delegations && entry.delegations.live) copy.append(meta, content, delegations);
    else if (delegations) copy.append(meta, delegations, content);
    else copy.append(meta, content);
    // What the member posted during its turn sits inside the reply, above
    // its final text (shared/interimPosts.ts).
    syncInterimPosts(copy, content, entry);
    syncSessionsWorking(copy, meta, entry);
    renderAttachmentsInto(attachmentsNodeFor(copy), entry);
    syncAnsweredCards(copy, entry);
    syncPendingCards(copy, entry);
    item.append(avatar, copy);
  } else {
    item.classList.toggle("is-on-its-way", Boolean(entry.onItsWay));
    item.classList.toggle("is-refused", Boolean(entry.refused));
    const bubble = document.createElement("div");
    bubble.className = "message-bubble";
    const content = document.createElement("div");
    content.className = "message-content";
    renderMessageContentIfChanged(content, entry.content, entry.author);
    const meta = document.createElement("div");
    meta.className = "message-status";
    meta.textContent = messageStatusLabel(entry);
    bubble.append(content, meta);
    renderAttachmentsInto(attachmentsNodeFor(bubble), entry);
    item.append(bubble);
    syncWaitingActions(item, entry);
  }
  appendThreadChip(item, entry);
  return item;
}

/** The question the User already answered stays with its own message, the
 *  way the desktop keeps the answered card under it; without this the phone
 *  would hide the protocol block from the bubble and leave no trace of what
 *  was asked or what was chosen (the User, 2026-09-20). */
export function answeredCardsForMessage(entry) {
  return cardsForMessage(entry).filter(function (card) {
    return card.status !== "pending" && card.kind === "choice";
  });
}

/** What a row's replies chip says; empty when it has no replies. */
function threadChipLabel(entry) {
  if (!entry.replyCount) return "";
  return entry.replyCount === 1 ? "1 reply" : entry.replyCount + " replies";
}

function appendThreadChip(item, entry) {
  const threadRoot = entry.sourceId;
  if (!entry.replyCount) {
    return;
  }
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "thread-chip";
  chip.dataset.threadRoot = threadRoot;
  chip.textContent = threadChipLabel(entry);
  chip.addEventListener("click", function () {
    setOpenThreadRootId(threadRoot);
    void render();
  });
  item.append(chip);
}

/** A row patched in place keeps its replies' chip in step: drawn before
 *  its first reply was stored (a redraw between two rows of one batch), it
 *  never got the chip, and the thread could not be opened from it. */
function syncThreadChip(item, entry) {
  const chip = Array.from(item.children).find(function (child) { return child.classList.contains("thread-chip"); });
  if (chip && chip.textContent === threadChipLabel(entry) && chip.dataset.threadRoot === entry.sourceId) return;
  if (chip) chip.remove();
  appendThreadChip(item, entry);
}

export function updateMessageRow(item, entry) {
  if (item.dataset.author !== entry.author) {
    return false;
  }
  // Drawn for the other view (Sessions <-> Classic): its shape differs
  // (folds, "Worked for", avatars), so it is drawn again whole.
  if ((item.dataset.presentation || "") !== (entry.presentation || "")) {
    return false;
  }
  // A sessions-view row of its own shape is drawn again whole; a message
  // turning into one or out of one is a different shape too. A member's
  // choice keeps its node while only its card changes, so a field being
  // typed in keeps the keyboard.
  if (item.dataset.sessionsKind === "choice" && entry.memberChoice && entry.presentation === "sessions") {
    const copy = item.querySelector(".sessions-member-choice");
    if (!copy) return false;
    item.dataset.rowSignature = messageRowSignature(entry);
    item.dataset.status = entry.status;
    syncPendingCards(copy, entry);
    return true;
  }
  // The tasks a reply's turn gave are drawn with the reply and kept in
  // step in place (a running main reply streams under them).
  const inlineDelegations = entry.presentation === "sessions" && entry.delegations && !entry.delegations.standalone;
  if (item.dataset.sessionsKind || (entry.presentation === "sessions" && sessionsSpecialSignature(entry) && !inlineDelegations)) {
    return false;
  }
  item.classList.toggle("is-sessions", entry.presentation === "sessions");
  // A note's card is drawn whole; a row turning into one, or out of one, is
  // a different shape, so the reconciler draws it again.
  if (item.dataset.artifactNote === "1" || artifactNoteCardForEntry(entry)) {
    return false;
  }
  if (item.dataset.finishedNote === "1" || finishedNoteOfEntry(entry)) {
    return false;
  }
  if (item.dataset.accordLaunch === "1" || accordLaunchCardForEntry(entry)) {
    return false;
  }
  if (item.dataset.accordLine === "1" || accordClosedLaunchOf(entry)) {
    return false;
  }
  // Scaffolding and a message are different shapes; the reconciler replaces
  // the node rather than trying to morph one into the other.
  if ((item.dataset.scaffolding === "1") !== Boolean(entry.scaffolding)) {
    return false;
  }
  if (entry.scaffolding) {
    item.dataset.rowSignature = messageRowSignature(entry);
    item.dataset.status = entry.status;
    return true;
  }
  item.dataset.rowSignature = messageRowSignature(entry);
  item.dataset.status = entry.status;
  // Not a system note: the desktop offers a thread on every message but
  // those, and the phone offers exactly what the desktop does.
  if (entry.sourceId && !entry.scaffolding && entry.status !== "queued" && entry.author !== "system") {
    item.dataset.threadRoot = entry.sourceId;
  } else {
    delete item.dataset.threadRoot;
  }
  // Rows are updated in place, so this has to be re-applied here too: a row
  // that finished while on screen must stop looking openable.
  applyStreamableState(item, entry);
  if (entry.author === "agent") {
    const avatar = item.querySelector(".message-avatar");
    const handle = item.querySelector(".message-handle");
    const status = item.querySelector(".message-status");
    // The reply's own words, not one of its posts above them.
    const content = item.querySelector(".message-copy > .message-content:not(.message-interim-post)");
    if (!avatar || !handle || !status || !content) {
      return false;
    }
    applyRowIdentity(avatar, entry);
    fillRowHandle(handle, entry);
    status.textContent = messageStatusLabel(entry);
    const meta = status.parentElement;
    if (!meta) {
      return false;
    }
    syncMessageStopButton(meta, entry);
    // A running row drawn again in place (its posts came) keeps "Thinking"
    // as a new row draws it, not the placeholder sentence.
    if (isThinkingEntry(entry) && !isSessionsRunningEntry(entry)) {
      delete content.dataset.markdownRaw;
      delete content.dataset.markdownSource;
      renderThinkingInto(content, entry);
    } else {
      delete content.dataset.thinking;
      renderMessageContentIfChanged(content, isSessionsRunningEntry(entry) ? sessionsRunningText(entry) : entryShownContent(entry), entry.author);
    }
    if (content.parentElement) syncInterimPosts(content.parentElement, content, entry);
    if (content.parentElement) syncSessionsWorking(content.parentElement, meta, entry);
    // Its "Worked for …" (and the tasks its turn gave): a reply that
    // finished on screen gets it as a new row has it.
    if (content.parentElement) syncSessionsWorked(content.parentElement, meta, content, entry);
    renderAttachmentsInto(attachmentsNodeFor(content.parentElement || item), entry);
    // A question answered while its row is on screen keeps its card there.
    syncAnsweredCards(content.parentElement || item, entry);
    syncPendingCards(content.parentElement || item, entry);
    syncThreadChip(item, entry);
    return true;
  }
  const status = item.querySelector(".message-status");
  const content = item.querySelector(".message-content");
  if (!status || !content) {
    return false;
  }
  item.classList.toggle("is-on-its-way", Boolean(entry.onItsWay));
  item.classList.toggle("is-refused", Boolean(entry.refused));
  status.textContent = messageStatusLabel(entry);
  renderMessageContentIfChanged(content, entryShownContent(entry), entry.author);
  renderAttachmentsInto(attachmentsNodeFor(content.parentElement || item), entry);
  syncWaitingActions(item, entry);
  syncThreadChip(item, entry);
  return true;
}

/** A row's text as the open chat's view shows it: a failed or stopped
 *  reply's words are the app's (the CLI's failure), so the sessions view
 *  names nobody by handle in them; a member's own words stay its own. */
function entryShownContent(entry) {
  const content = entry.content;
  const names = sessionsStateState.lastSessionsState && sessionsStateState.lastSessionsState.viewNames;
  if (!names || entry.author !== "agent" || (entry.status !== "error" && entry.status !== "Error" && entry.status !== "Stopped") || typeof content !== "string" || content.indexOf("@") < 0) return content;
  const shared = sessionsRules();
  if (!shared || typeof shared.sessionsViewReplyText !== "function") return content;
  const member = sessionsStateState.lastSessionsState.members.find(function (item) { return item.id === entry.participantId; });
  const author = (member && member.handle) || entry.participantLabel;
  return shared.sessionsViewReplyText(content, author, names);
}

// Nodes are consumed, not looked up by key. The old sweep asked "is this
// node's key still wanted?", which keeps EVERY node carrying a wanted key —
// so once two nodes ended up sharing one key, the loser was unreachable and
// stayed on screen forever, showing an answer or a "Thinking" that the store
// no longer had. Consuming one node per rendered row and removing whatever is
// left over cannot leave an orphan behind, whatever the keys look like.
export function reconcileMessageRows(list, rows, signatures) {
  const existing = new Map();
  for (const child of Array.from(list.children)) {
    if (child.id === "control-cards") continue;
    const bucket = existing.get(child.dataset.rowKey);
    if (bucket) {
      bucket.push(child);
    } else {
      existing.set(child.dataset.rowKey, [child]);
    }
  }
  // Which node each row takes, decided before anything moves. The nodes no
  // row takes leave first: removed at the end instead, they made every row
  // below them move, and a moved row takes the focus, and the keyboard, from
  // a card being typed in under its message.
  const claimed = rows.map(function (entry) {
    const bucket = existing.get(entry.rowKey || entry.id);
    return bucket && bucket.length > 0 ? bucket.shift() : undefined;
  });
  const kept = new Set(claimed.filter(Boolean));
  for (const child of Array.from(list.children)) {
    if (!kept.has(child) && child.id !== "control-cards") {
      child.remove();
    }
  }
  let cursor = list.firstElementChild;
  rows.forEach(function (entry, index) {
    let item = claimed[index];
    if (!item || item.dataset.rowSignature !== (signatures ? signatures[index] : messageRowSignature(entry))) {
      if (item && updateMessageRow(item, entry)) {
        // Keep the existing DOM node mounted so PWA updates do not flash.
      } else {
        const replacement = createMessageRow(entry);
        if (item) {
          const wasCursor = item === cursor;
          item.replaceWith(replacement);
          if (wasCursor) {
            cursor = replacement;
          }
        }
        item = replacement;
      }
    }
    if (item !== cursor) {
      list.insertBefore(item, cursor);
    }
    cursor = item.nextElementSibling;
  });
}

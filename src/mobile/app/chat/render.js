import { accordStillOpen, renderAccordDock, sessionsAccordOf, setAccordDockChoice } from "../accord/accordDock.js";
import { accordFoldedRow, accordLinesState, accordProgressFor } from "../accord/accordLines.js";
import { stopRunIdsOf } from "../activity/activityData.js";
import { refreshDockBadge, renderHome } from "../activity/activityView.js";
import { pendingControlCards } from "../cards/cardAnswers.js";
import { buildCardIndex, cardRowsState, noteProgressFor, typingInChatCard } from "../cards/cardRows.js";
import { controlCardSignature, renderTailCards } from "../cards/tailCards.js";
import {
  chatScrollState, groupRowsIntoThreads, isNearBottom, openThreadRootId, renderThreadHeader, renderThreadReplyAction,
  scrollToLatestWhenSettled, setJumpToLatestVisible, setOpenStreamRunId, setOpenThreadRootId, threadSurface
} from "./chatScroll.js";
import { renderLoadEarlier } from "./loadEarlier.js";
import { messageRowSignature, reconcileMessageRows, routedRows } from "./messageRows.js";
import { renderStreamView } from "./streamView.js";
import { renderChatList } from "../chats/chatListView.js";
import { loadChats, markConversationRead, markConversationViewed } from "../chats/chatStore.js";
import {
  clearFocusMark, focusedMessage, focusMessageRow, messageRowFor, openChatState, selectedConversationId
} from "../chats/openChat.js";
import { syncComposerStop } from "../composer/composerStop.js";
import { membersSheetOpen, renderMembersButton, renderMembersSheetIfOpen, updateMembersSheetTargets } from "../members/membersSheet.js";
import { clearForPairingNote } from "../newChat/newChatOffer.js";
import { OUTBOX_REFUSED } from "../outbox/hubOutbox.js";
import { listOutboxEntries } from "../outbox/outboxStore.js";
import { isMessageOutboxEntry, serverOwesEntry, stopRequestedRunIds } from "../outbox/sending.js";
import { renderSendLogButton } from "../outbox/sendLog.js";
import { canStartChats, isHubPairing, loadHubPairing, serverPairing } from "../pairing/hubPairing.js";
import { loadPairing, oldPairingCleared } from "../pairing/pairing.js";
import { renderPairingPrompt, renderUnpairedNotice } from "../pairing/pairingScreens.js";
import { enableMessageAlerts, pushEndpointRejected } from "../push/messageAlerts.js";
import { renderChatViewSwitch } from "../sessions/chatTitleMenu.js";
import { sessionsMainRows, sessionsMemberSessionRows } from "../sessions/sessionsRows.js";
import {
  chatViewOf, openMemberSessionId, openMemberSessionMember, openSessionsTarget, sessionsMemberName, sessionsStateFor,
  sessionsStateState, setOpenMemberSessionId
} from "../sessions/sessionsState.js";
import { homeTab, showScreen } from "../shell/home.js";
import {
  dedupeRenderRowsByKey, dedupeTimelineEntries, isScaffoldingEntry, listTimelineEntries, timelineRenderRowKey
} from "../store/timelineRows.js";
import { connectionStatusText, MARK_REFUSED } from "../sync/connectionStatus.js";

export const renderState = {
  // The thread to land in when the chat Activity is opening is first drawn.
  pendingThreadOpen: undefined
};

export let renderRevision = 0;

export async function render(connectionStatus) {
  const revision = ++renderRevision;
  const state = document.getElementById("connection-state");
  const list = document.getElementById("message-list");
  const chatsScreen = document.getElementById("chats-screen");
  const timelineScreen = document.getElementById("timeline-screen");
  const title = document.getElementById("chat-title");
  const activeId = selectedConversationId();
  if (!state || !list || !chatsScreen || !timelineScreen) {
    return;
  }
  if (list.dataset.conversationId !== (activeId || "")) {
    // Navigation changes the heading before IDB finishes. Remove the old
    // chat's rows and stream controls in the same turn, including on a failed
    // read; they must never remain actionable under the new chat's identity.
    if (list.dataset.conversationId !== undefined) {
      // A thread opened from Activity is the one place a chat is entered
      // straight into a thread; everything else starts on the main list.
      setOpenThreadRootId(renderState.pendingThreadOpen && renderState.pendingThreadOpen.conversationId === activeId ? renderState.pendingThreadOpen.rootId : undefined);
      renderState.pendingThreadOpen = undefined;
      setOpenMemberSessionId(undefined);
      sessionsStateState.lastSessionsState = undefined;
      if (sessionsStateState.pendingSessionsTarget && sessionsStateState.pendingSessionsTarget.conversationId !== activeId) sessionsStateState.pendingSessionsTarget = undefined;
      setOpenStreamRunId(undefined);
      renderStreamView([], connectionStatus);
    }
    list.dataset.conversationId = activeId || "";
    list.replaceChildren();
    if (focusedMessage && focusedMessage.conversationId !== activeId) clearFocusMark();
    renderThreadHeader(undefined);
    state.textContent = "";
    chatScrollState.lastRowsFingerprint = undefined;
    chatScrollState.lastScrolledConversationId = undefined;
  }
  if (serverPairing.hubPairingState && (serverPairing.hubPairingState.status === "confirm" || serverPairing.hubPairingState.replacing)) {
    // A code waiting for the User's yes, or a pairing that would replace
    // the one this phone has: in place of the chats.
    clearForPairingNote();
    renderPairingPrompt(serverPairing.hubPairingState);
    showScreen("chats");
    return;
  }
  if (serverPairing.hubPairingState && (!loadHubPairing() || serverPairing.hubPairingState.status === "revoked")) {
    // Pairing with the server, or why it did not work: in place of the
    // chats, with the code scanner to try again.
    clearForPairingNote();
    renderUnpairedNotice(serverPairing.hubPairingState.status === "pairing" ? "Pairing with your server…" : serverPairing.hubPairingState.message,
      "hub-" + serverPairing.hubPairingState.status);
    showScreen("chats");
    return;
  }
  if (!loadPairing()) {
    clearForPairingNote();
    // A phone that held a pairing made the old way is told why it has to
    // pair again, once and plainly; the old pairing itself is gone.
    if (oldPairingCleared()) {
      renderUnpairedNotice("This phone was paired the old way. Pair it again from Settings on your computer.", "old-pairing");
    } else {
      renderUnpairedNotice("Scan the code from your computer (Settings → Device Pairing) to connect this phone. " +
        "An installed app has its own storage, so it pairs separately from the browser.");
    }
    showScreen("chats");
    return;
  }
  const searchToggle = document.getElementById("chat-search-toggle");
  if (searchToggle) searchToggle.hidden = false;
  const newChatButton = document.getElementById("new-chat-button");
  if (newChatButton) newChatButton.hidden = !canStartChats(loadPairing());
  // W5: offer the doorbell once paired. iOS only grants Notification
  // permission from a user gesture, so this is a visible button, shown only
  // while permission is still undecided.
  const alertsButton = document.getElementById("enable-alerts");
  if (alertsButton) {
    const canOffer = isHubPairing(loadPairing()) &&
      "Notification" in globalThis &&
      "PushManager" in globalThis &&
      Notification.permission === "default";
    // W-K: a refused subscription replaces the offer with a plain statement.
    // Quiet-wait and alerts-will-never-arrive must not look the same.
    if (pushEndpointRejected) {
      alertsButton.hidden = false;
      alertsButton.disabled = true;
      alertsButton.dataset.alertsState = "unavailable";
      alertsButton.textContent = "Alerts aren't available in this browser. Messages still arrive when you open the app.";
    } else {
      alertsButton.dataset.alertsState = canOffer ? "offered" : "hidden";
      alertsButton.hidden = !canOffer;
    }
    if (!pushEndpointRejected && !alertsButton.dataset.wired) {
      alertsButton.dataset.wired = "1";
      alertsButton.addEventListener("click", function () {
        alertsButton.disabled = true;
        void enableMessageAlerts().finally(function () {
          if (pushEndpointRejected) {
            // The refusal arrived during this click; leave the stated
            // message the render pass just wrote instead of hiding it.
            return;
          }
          alertsButton.disabled = false;
          alertsButton.hidden = !("Notification" in globalThis) || Notification.permission !== "default";
        });
      });
    }
  }
  renderChatList();
  const openHomeTab = homeTab();
  showScreen(activeId ? "timeline" : openHomeTab);
  if (!activeId) {
    sessionsStateState.sessionsMentionScope = undefined;
    sessionsStateState.openAccordLaunchId = undefined;
    renderMembersButton(undefined, undefined);
    // Reopening the same chat should land at the latest message again.
    chatScrollState.lastScrolledConversationId = undefined;
    await renderHome(openHomeTab, revision);
    return;
  }
  const activeChat = loadChats().find(function (chat) {
    return chat.id === activeId;
  });
  // Inside a thread the heading says so from the first write: the chat's
  // name set here and "Thread" set again after the reads below made the
  // heading flip on every update while a member wrote into the thread (the
  // User, 2026-09-24).
  // A member's session belongs to the sessions view, a thread to the
  // classic one (the desktop closes either when the view changes).
  const inSessionsView = chatViewOf(activeChat) === "sessions";
  if (inSessionsView && openThreadRootId()) {
    // A thread asked for (from Activity, say) is the message it stands
    // for: its member's session opens once the rows are read.
    sessionsStateState.pendingSessionsTarget = { conversationId: activeId, messageId: openThreadRootId() };
    setOpenThreadRootId(undefined);
  }
  // A member that left the chat is known once the rows are read: its
  // session is closed then if nobody has it.
  const memberSession = openMemberSessionMember(activeChat);
  const accordEarly = inSessionsView && !memberSession && sessionsStateState.openAccordLaunchId;
  const heading = memberSession ? sessionsMemberName(memberSession) : accordEarly ? "Accord" : openThreadRootId() ? "Thread" : activeChat?.title || "AccordAgents";
  if (title && title.textContent !== heading) {
    title.textContent = heading;
  }
  // The back arrows and the composer's placeholder go with the heading,
  // not after the reads.
  renderThreadHeader(openThreadRootId(), memberSession, Boolean(accordEarly));
  renderChatViewSwitch(activeId, activeChat, Boolean(openThreadRootId() || memberSession || accordEarly));
  renderMembersButton(activeId, activeChat);
  // Looking at the chat is what reads it. A chat opened behind a locked
  // screen is not being looked at.
  if (!document.hidden) {
    markConversationRead(activeId);
  }
  renderMembersSheetIfOpen(activeChat);
  const entries = await listOutboxEntries(activeId);
  const timelineEntries = await listTimelineEntries(activeId);
  // A server update, navigation or another tab may have superseded this
  // read. Committing it would replace the current chat with the old snapshot.
  if (revision !== renderRevision || activeId !== selectedConversationId()) return;
  if (membersSheetOpen) {
    updateMembersSheetTargets(activeId, activeChat, timelineEntries);
    renderMembersSheetIfOpen(activeChat);
  }
  if (!document.hidden) {
    markConversationViewed(activeId, timelineEntries.reduce(function (newest, entry) {
      const at = entry && (entry.receivedAt || entry.createdAt);
      return typeof at === "string" && at > newest ? at : newest;
    }, ""));
  }
  // The bar is under the chat too, so its Activity number must keep up in
  // there: while a chat is open it is the only place the User is told that
  // something elsewhere is waiting. Only the number, never the lists — and
  // counted after this look at the chat is recorded, so what was just read
  // is not still counted as news.
  void refreshDockBadge(revision);
  const messageEntries = entries.filter(isMessageOutboxEntry);
  const requestedStopRunIds = new Set(stopRunIdsOf(entries));
  // A message this phone sent and the server's copy of it are one message:
  // matched by its id, never by its text (two messages saying the same are
  // two messages). The queue's row stands for both.
  const ownIds = new Set(messageEntries.map(function (entry) { return entry.eventId; }));
  const serverCopies = new Map();
  for (const entry of timelineEntries) {
    const messageId = entry.role === "you" ? (entry.messageId || entry.sourceId) : undefined;
    if (messageId && ownIds.has(messageId)) serverCopies.set(messageId, entry);
  }
  const visibleTimelineEntries = dedupeTimelineEntries(timelineEntries.filter(function (entry) {
    return !(entry.role === "you" && serverCopies.has(entry.messageId || entry.sourceId));
  }));
  state.textContent = connectionStatusText(connectionStatus);
  renderSendLogButton();
  let rows = messageEntries.map(function (entry) {
    const serverCopy = serverCopies.get(entry.eventId);
    // The server's copy is its word that it took the message, whether or
    // not its answer to the send reached this phone.
    const refused = entry.status === OUTBOX_REFUSED && !serverCopy;
    const notSent = !serverCopy && serverOwesEntry(entry);
    return {
      rowKey: "outbox\0" + entry.eventId,
      id: entry.eventId,
      conversationId: entry.conversationId,
      // Shown in the thread it was written in, not in the chat behind it.
      threadRootId: entry.payload && typeof entry.payload.threadRootId === "string"
        ? entry.payload.threadRootId
        : undefined,
      // On the server it is a message a thread can open from.
      ...(notSent || refused ? {} : { sourceId: entry.eventId }),
      author: "you",
      content: entry.payload.content,
      // A picture just sent from this phone shows in its own pending row
      // rather than only after the desktop echoes it back.
      attachments: Array.isArray(entry.payload.attachments)
        ? entry.payload.attachments.map(function (attachment, index) {
          return {
            id: "outbox:" + entry.eventId + ":" + index,
            filename: attachment.filename || "image",
            mimeType: attachment.mimeType,
            dataBase64: attachment.dataBase64
          };
        })
        : undefined,
      status: refused ? "Refused" : notSent ? "Queued" : "Sent",
      // Whom it is for, as this phone resolved it: the sessions view places
      // it by that until the server's copy says the same.
      ...(entry.hubDelivery && Array.isArray(entry.hubDelivery.targets) && entry.hubDelivery.targets.length
        ? { addressees: entry.hubDelivery.targets } : {}),
      ...(refused ? { mark: MARK_REFUSED + ": " + (entry.lastError || "No reason was given.") } : {}),
      onItsWay: notSent,
      refused: refused,
      createdAt: entry.createdAt
    };
  }).concat(visibleTimelineEntries.map(function (entry) {
    return {
      rowKey: timelineRenderRowKey(entry),
      id: entry.id,
      conversationId: entry.conversationId,
      // The stored entry and the rendered row are different shapes. Carrying
      // this across is what makes a picture appear at all: it was stored and
      // then dropped here, so a message with an image rendered as text.
      attachments: entry.attachments,
      author: entry.role === "you" ? "you" : entry.role === "system" ? "system" : "agent",
      ...(entry.finishedNote ? { finishedNote: entry.finishedNote } : {}),
      ...(entry.urgentAlert ? { urgentAlert: entry.urgentAlert } : {}),
      ...(entry.accordLaunchMessageId ? { accordLaunchMessageId: entry.accordLaunchMessageId } : {}),
      ...(entry.accordLaunch ? { accordLaunch: entry.accordLaunch } : {}),
      ...(entry.accordClosed ? { accordClosed: entry.accordClosed } : {}),
      ...(entry.compaction ? { compaction: entry.compaction } : {}),
      // The desktop publishes the in-progress row the moment it accepts the
      // message, before routing has picked anyone, and can only guess a
      // handle from an explicit @mention in the text. With no mention there
      // is no one to name yet — saying "Agent" with a letter avatar showed a
      // participant who does not exist and then swapped identity mid-run.
      participantLabel: entry.participantLabel || "Agent",
      identified: Boolean(entry.participantLabel),
      // Scaffolding that names nobody says one thing — "accepted, an answer
      // is coming" — and says it before anyone is picked. Rendered as a
      // message row it pretended to be a message: an avatar slot, a status, a
      // running clock, all belonging to a member who did not exist yet. It
      // gets a small indication instead.
      //
      // Scaffolding that DOES name a member ("@drew is running...") is not
      // empty — it says who is working, which is exactly what the desktop
      // shows — so it keeps the member row, the clock and the shimmer.
      scaffolding: isScaffoldingEntry(entry) && !entry.participantLabel,
      // Scaffolding stands for a message, not a run that can be stopped.
      cancellable: !isScaffoldingEntry(entry),
      content: entry.content,
      // Stopped, as the computer names a reply a Stop or a quit ended.
      status: entry.role === "you" ? "Sent" : entry.status === "error" ? (entry.stopped ? "Stopped" : "Error") : entry.status === "done" ? "Done" : "Running",
      // What a Stop names the member's turn on the server by.
      ...(entry.participantId ? { participantId: entry.participantId } : {}),
      ...(entry.sourceMessageId ? { sourceMessageId: entry.sourceMessageId } : {}),
      // What the sessions view places the row by and draws its task card from.
      ...(Array.isArray(entry.addressees) && entry.addressees.length ? { addressees: entry.addressees } : {}),
      ...(entry.participantRequest ? { participantRequest: entry.participantRequest } : {}),
      ...(Array.isArray(entry.interimPosts) && entry.interimPosts.length ? { interimPosts: entry.interimPosts } : {}),
      ...(entry.accordLaunchByMainSession ? { accordLaunchByMainSession: true } : {}),
      ...(typeof entry.workedMs === "number" ? { workedMs: entry.workedMs } : {}),
      ...(entry.turnContinues ? { turnContinues: true } : {}),
      ...(Array.isArray(entry.activity) && entry.activity.length ? { activity: entry.activity } : {}),
      ...(entry.activityMore ? { activityMore: entry.activityMore } : {}),
      ...(entry.liveStatus && entry.status === "pending" ? { liveStatus: true } : {}),
      // Waiting behind the member's turn before it: "Queued", and its
      // "Working for …" starts once its own turn does (startedAt), as on
      // the desktop.
      ...(entry.queued && entry.status === "pending" ? { queued: true } : {}),
      ...(typeof entry.startedAt === "string" && entry.startedAt ? { startedAt: entry.startedAt } : {}),
      // A member's "@x is running…" row is still its turn: the sessions
      // view stops it by its run like any running reply.
      ...(isScaffoldingEntry(entry) && entry.participantLabel && entry.participantId && entry.runId ? { memberTurn: true } : {}),
      createdAt: entry.createdAt,
      threadRootId: entry.threadRootId,
      sourceId: entry.sourceId || entry.id,
      // W-M: the run this row belongs to, so a live row can be opened as a
      // stream and the stream can keep following it as it grows. The mobile
      // event id rides along because the answering run has a fresh id of its
      // own: the frames it streams can only be bound to this row through the
      // source event they both answer.
      runId: entry.runId,
      stopRequested: requestedStopRunIds.has(entry.runId) || stopRequestedRunIds.has(entry.runId),
      mobileEventId: entry.mobileEventId
    };
  }));
  if (isHubPairing(loadPairing())) {
    rows = rows.concat(routedRows(activeId, messageEntries, timelineEntries, requestedStopRunIds));
  }
  // A closed Accord's line this phone wrote, until the server's copy is here.
  rows = rows.concat(entries.filter(function (entry) {
    const message = entry.kind === "message.system" && entry.payload ? entry.payload.message : undefined;
    return Boolean(message && message.metadata && message.metadata.accordClosed) && entry.status !== OUTBOX_REFUSED &&
      !timelineEntries.some(function (stored) { return stored.messageId === entry.eventId; });
  }).map(function (entry) {
    const message = entry.payload.message;
    return {
      rowKey: "outbox\0" + entry.eventId, id: entry.eventId, conversationId: entry.conversationId, author: "system",
      content: message.content, status: "Done", createdAt: entry.createdAt, accordClosed: message.metadata.accordClosed
    };
  }));
  rows = dedupeRenderRowsByKey(rows).sort(function (left, right) {
    return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
  });
  // One card per Accord: its progress from the notes filed under its
  // launch, and those notes leave the timeline (accordProgress.ts).
  accordLinesState.renderAccordProgress = accordProgressFor(rows);
  rows = rows.filter(function (row) { return !accordFoldedRow(row); });
  // A line her server refused, and no other written: the card is pinned
  // again (the refusal is in the send log).
  const accordLineEntries = entries.filter(function (entry) {
    const message = entry.kind === "message.system" && entry.payload ? entry.payload.message : undefined;
    return Boolean(message && message.metadata && message.metadata.accordClosed);
  });
  for (const entry of accordLineEntries) {
    const launchId = entry.payload.message.metadata.accordClosed.launchMessageId;
    const allRefused = accordLineEntries.every(function (other) {
      return other.payload.message.metadata.accordClosed.launchMessageId !== launchId || other.status === OUTBOX_REFUSED;
    });
    if (allRefused && !accordLinesState.renderAccordProgress.lines.has(launchId)) setAccordDockChoice("closedIntoChat", activeId, launchId, false);
  }
  // A question stands under the message that asked it, as on the desktop:
  // in the thread when it was asked in a thread, and in its place in the
  // history when that is further up. Only what has no message, a
  // permission, waits at the end of the chat (the User, 2026-10-01: a
  // question asked in a thread stood at the bottom of the main chat).
  cardRowsState.renderCardIndex = Object.assign(buildCardIndex(activeId), { revision: revision });
  // The sessions view (docs/main-session.md): every message in its one
  // place, by the desktop's rules, worked out from the rows drawn.
  const sessions = sessionsStateFor(activeId, activeChat, rows);
  // The chat's Accord still open, for the panel and the members icon's dot,
  // which are drawn between redraws too.
  if (sessions) sessions.openAccord = accordStillOpen(activeId, accordLinesState.renderAccordProgress.docked);
  sessionsStateState.lastSessionsState = sessions;
  // Mentions in messages are its members' chips in the sessions view only.
  sessionsStateState.sessionsMentionScope = sessions ? sessions.mentions : undefined;
  if (sessions) openSessionsTarget(sessions, activeId);
  const sessionMember = sessions ? openMemberSessionMember(activeChat) : undefined;
  if (!sessionMember && openMemberSessionId()) setOpenMemberSessionId(undefined);
  // The Accord on its own screen (the sessions view's line opens it).
  const accordScreen = sessions && !sessionMember && sessionsStateState.openAccordLaunchId ? sessionsAccordOf(sessionsStateState.openAccordLaunchId) : undefined;
  if (!accordScreen) sessionsStateState.openAccordLaunchId = undefined;
  // The desktop pins it above the chat's own composer only, not a thread's;
  // the sessions view keeps a quiet line of it there.
  renderAccordDock(activeId, openThreadRootId() || sessionMember || accordScreen ? null : accordLinesState.renderAccordProgress.docked, Boolean(sessions));
  renderStreamView(rows, connectionStatus);
  const openThread = sessions ? undefined : openThreadRootId();
  if (sessions) {
    rows = sessionMember ? sessionsMemberSessionRows(sessions, sessionMember)
      : accordScreen ? [{ rowKey: "accord-screen\u0000" + accordScreen.launchId, id: "accord-screen", conversationId: activeId, author: "system",
        status: "Done", content: "", createdAt: "", presentation: "sessions", accordScreen: accordScreen }]
      : sessionsMainRows(sessions);
  } else {
    // A compaction's line is the sessions view's only, as on the desktop.
    rows = groupRowsIntoThreads(rows.filter(function (row) { return !row.compaction; }), openThread).rows;
  }
  // A member that left the chat is read only: no composer under it.
  const readOnlyScreen = Boolean(sessionMember && sessionMember.former) || Boolean(accordScreen);
  document.getElementById("timeline-screen")?.classList.toggle("is-read-only", readOnlyScreen);
  // The heading says whose session it is once the reads are in (a message
  // opened from elsewhere may have opened or closed one).
  const finalHeading = sessionMember ? sessionsMemberName(sessionMember) : accordScreen ? "Accord" : openThread ? "Thread" : activeChat?.title || "AccordAgents";
  if (title && title.textContent !== finalHeading) title.textContent = finalHeading;
  renderThreadHeader(openThread, sessionMember, Boolean(accordScreen));
  syncComposerStop(sessions && !accordScreen && !readOnlyScreen ? sessions : undefined, sessionMember ? sessionMember.id : undefined);
  renderChatViewSwitch(activeId, activeChat, Boolean(openThread || sessionMember || accordScreen));
  renderMembersButton(activeId, activeChat);
  renderMembersSheetIfOpen(activeChat);
  renderThreadReplyAction(openThread, rows.length);
  renderLoadEarlier(activeId, openThread);
  // A thread or a member's session is a screen of its own over the chat.
  const openScreen = openThread || (sessionMember ? "member\u0000" + sessionMember.id : accordScreen ? "accord\u0000" + accordScreen.launchId : undefined);
  const view = sessions ? "sessions" : "classic";
  const previousThread = chatScrollState.lastRenderedThreadRootId;
  const sameChat = chatScrollState.lastScrolledConversationId === activeId;
  const sameView = chatScrollState.lastRenderedView === view;
  const openedConversation = !sameChat || !sameView || openScreen !== previousThread;
  chatScrollState.lastRenderedThreadRootId = openScreen;
  chatScrollState.lastRenderedView = view;
  // Where the chat was being read when a message was opened on its own
  // screen, for the way back: Slack's message screen returns to the same
  // place, and landing at the latest message instead lost the User the
  // spot she was reading in a chat of thousands of rows.
  if (sameChat && sameView && openScreen && !previousThread) {
    const surface = threadSurface();
    chatScrollState.mainListScrollTop = surface ? surface.scrollTop : undefined;
  } else if (!sameChat || !sameView) {
    chatScrollState.mainListScrollTop = undefined;
  }
  // Approved changes still waiting come first: the last card, next to the
  // composer, is one that needs an answer.
  const tailCards = (cardRowsState.renderCardIndex.waiting || []).concat(pendingControlCards(activeId).filter(function (card) {
    return card.kind !== "choice" || !card.sourceMessageId;
  }));
  // Each row's change check is worked out once per redraw and used twice:
  // for whether anything changed, and for which rows to patch.
  cardRowsState.renderNoteProgress = noteProgressFor(rows);
  const rowSignatures = rows.map(messageRowSignature);
  const rowsFingerprint = rows.map(function (row, index) {
    return (row.rowKey || row.id) + "\u0000" + rowSignatures[index];
  }).concat(tailCards.map(controlCardSignature)).join("\u0001");
  const rowsChanged = rowsFingerprint !== chatScrollState.lastRowsFingerprint;
  chatScrollState.lastRowsFingerprint = rowsFingerprint;
  // Measured BEFORE the rows are mounted: appending content is itself what
  // moves the end away, so asking afterwards always answers "not at the
  // bottom" and the view would never follow anything.
  // A card field being typed in stays where the finger left it while rows
  // come and go above it. Chrome anchors the scroll itself; Safari on the
  // iPhone does not, and the field slid under the keyboard mid-word.
  const typedField = typingInChatCard() ? document.activeElement : null;
  const typedTop = typedField ? typedField.getBoundingClientRect().top : 0;
  const wasAtBottom = isNearBottom(threadSurface());
  reconcileMessageRows(list, rows, rowSignatures);
  renderTailCards(list, tailCards);
  if (typedField && typedField.isConnected && document.activeElement === typedField) {
    const drift = typedField.getBoundingClientRect().top - typedTop;
    const surface = threadSurface();
    if (surface && Math.abs(drift) >= 1) surface.scrollTop += drift;
  }
  cardRowsState.renderCardIndex = null;
  cardRowsState.renderNoteProgress = null;
  accordLinesState.renderAccordProgress = null;
  chatScrollState.lastScrolledConversationId = activeId;
  if (focusedMessage && focusedMessage.conversationId === activeId) {
    // A row redrawn for a change in it keeps the mark.
    const marked = messageRowFor(list, focusedMessage.messageId);
    if (marked) marked.classList.add("message-focused");
  }
  if (openChatState.pendingMessageFocus && openChatState.pendingMessageFocus.conversationId === activeId) {
    const target = messageRowFor(list, openChatState.pendingMessageFocus.messageId);
    if (target) {
      openChatState.pendingMessageFocus = undefined;
      focusMessageRow(activeId, target);
      return;
    }
  }
  if (!rowsChanged && !openedConversation) {
    return;
  }
  if (openedConversation) {
    if (sameChat && sameView && !openScreen && previousThread && typeof chatScrollState.mainListScrollTop === "number") {
      // Back from a message's own screen: the same place, and the pill says
      // whether anything new waits below it.
      const surface = threadSurface();
      if (surface) {
        surface.scrollTop = chatScrollState.mainListScrollTop;
        setJumpToLatestVisible(!isNearBottom(surface));
      }
      chatScrollState.mainListScrollTop = undefined;
      return;
    }
    scrollToLatestWhenSettled("auto");
    return;
  }
  // A card being typed in stays under the finger: following the end would
  // scroll the field away mid-word, now that cards are in the chat.
  if (typingInChatCard()) {
    setJumpToLatestVisible(!isNearBottom(threadSurface()));
    return;
  }
  // Whoever is at the end is following the conversation, so the view follows
  // too: the indication that a reply is coming, and the reply itself, arrive
  // in sight instead of below the fold. Reading history is the opposite
  // intent — leaving the end is the reader's decision and nothing may undo
  // it, so the pill offers the way back rather than taking it.
  if (wasAtBottom) {
    scrollToLatestWhenSettled("auto");
    return;
  }
  setJumpToLatestVisible(true);
}

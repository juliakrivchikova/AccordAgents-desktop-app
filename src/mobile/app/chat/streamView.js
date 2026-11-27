import { sessionsViewLabelFor } from "../cards/cardText.js";
import { openStreamFollow, openThreadRootId, setOpenStreamRunId, setOpenThreadRootId } from "./chatScroll.js";
import { flashRowNotice, isCancellableMobileRow, isThinkingEntry } from "./messageRows.js";
import { render } from "./render.js";
import { closeUrgentAlert, toggleUrgentAlert } from "./urgentAlerts.js";
import { selectedConversationId } from "../chats/openChat.js";
import { stopRunFromPhone } from "../outbox/sending.js";
import { stopMembersFromPhone } from "../sessions/sessionsRows.js";
import { openLiveSteps, openMemberSession, openTaskFolds, openWorkedFolds, sessionsStateState } from "../sessions/sessionsState.js";
import { isPlaceholderTimelineContent } from "../store/timelineRows.js";
import { dismissFinishedNote, openFinishedNoteTarget } from "../sync/finishedNotes.js";
import { displayedMessageText } from "../text/messageText.js";

// W-M(b,c,e,f): the live reply, rendered in its own view.
//
// There is no new pipeline here: the accumulated text is already what the
// in-progress row carries, so opening the view mid-run shows everything so
// far by construction, and every later ingest updates it through the same
// render pass as the timeline.
export function renderStreamView(rows, connectionStatus) {
  const view = document.getElementById("stream-view");
  const body = document.getElementById("stream-body");
  const label = document.getElementById("stream-label");
  const state = document.getElementById("stream-state");
  const stop = document.getElementById("stream-stop");
  if (!view || !body || !label || !state || !stop) {
    return;
  }
  const follow = openStreamFollow();
  if (!follow) {
    view.hidden = true;
    return;
  }
  // Match by run id OR by the source's mobile event id, and prefer the
  // newest match: the placeholder row and the growing reply both answer the
  // same event, and the reply is the one worth showing.
  let row;
  for (const candidate of rows) {
    if (candidate.author !== "agent") {
      continue;
    }
    if (candidate.runId === follow.runId ||
      (follow.mobileEventId && candidate.mobileEventId === follow.mobileEventId)) {
      row = candidate;
    }
  }
  if (!row) {
    // The run is gone entirely — nothing honest left to show.
    setOpenStreamRunId(undefined);
    view.hidden = true;
    return;
  }
  view.hidden = false;
  // The open chat's view names the member (sessions: by its task; the main
  // session by nothing).
  const streamChatId = row.conversationId || (sessionsStateState.lastSessionsState && sessionsStateState.lastSessionsState.conversationId);
  const streamWho = sessionsViewLabelFor(streamChatId, row.participantLabel);
  label.textContent = streamWho || (row.participantLabel ? "" : "Agent");
  stop.hidden = !isCancellableMobileRow(row);
  stop.disabled = row.stopRequested === true;
  stop.dataset.runId = row.runId || "";
  stop.dataset.turnMessageId = row.sourceMessageId || "";
  stop.dataset.participantId = row.participantId || "";
  stop.textContent = row.stopRequested ? "Stopping…" : "Stop";
  stop.setAttribute("aria-label", streamWho || !row.participantLabel ? "Stop response from " + (streamWho || "Agent") : "Stop response");
  // (e) When the run finishes the view stays and shows the finished answer;
  // leaving is the reader's decision, not ours.
  state.textContent = row.status === "Running"
    ? (connectionStatus === "synced" || connectionStatus === undefined ? "Writing…" : "Writing… (reconnecting)")
    : row.status;
  const text = isThinkingEntry(row) ? "" : displayedMessageText(row.content, "agent");
  if (body.dataset.text !== text) {
    body.dataset.text = text;
    body.textContent = text || "Nothing written yet.";
    // Follow the tail only while the reader is already at it.
    if (body.dataset.pinned !== "0") {
      body.scrollTop = body.scrollHeight;
    }
  }
}

export function wireStreamView() {
  const view = document.getElementById("stream-view");
  const body = document.getElementById("stream-body");
  const close = document.getElementById("stream-close");
  const stop = document.getElementById("stream-stop");
  const list = document.getElementById("message-list");
  if (!view || !body || !close || !stop || !list || view.dataset.wired === "1") {
    return;
  }
  view.dataset.wired = "1";
  close.addEventListener("click", function () {
    setOpenStreamRunId(undefined);
    view.hidden = true;
  });
  stop.addEventListener("click", function () {
    const runId = stop.dataset.runId;
    if (!runId || stop.disabled) {
      return;
    }
    stop.disabled = true;
    stop.textContent = "Stopping…";
    void stopRunFromPhone(runId, undefined, { messageId: stop.dataset.turnMessageId, participantId: stop.dataset.participantId });
  });
  // Scrolling away from the tail stops the view yanking itself back down.
  body.addEventListener("scroll", function () {
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 24;
    body.dataset.pinned = atBottom ? "1" : "0";
  });
  list.addEventListener("click", function (event) {
    const row = event.target && event.target.closest ? event.target.closest(".message-row") : undefined;
    if (!row) {
      return;
    }
    // The sessions view: a task card's row or "@x asks" opens that member's
    // session; a Stop stops the members it names; a task opens to its text.
    const memberOpen = event.target.closest("[data-open-member]");
    if (memberOpen) {
      openMemberSession(memberOpen.dataset.openMember, memberOpen.dataset.focusMessage || undefined);
      return;
    }
    const liveSteps = event.target.closest("[data-live-steps]");
    if (liveSteps) {
      const key = liveSteps.dataset.liveSteps;
      if (openLiveSteps.has(key)) openLiveSteps.delete(key);
      else openLiveSteps.add(key);
      void render();
      return;
    }
    const workedFold = event.target.closest("[data-worked-fold]");
    if (workedFold) {
      const key = workedFold.dataset.workedFold;
      if (openWorkedFolds.has(key)) openWorkedFolds.delete(key);
      else openWorkedFolds.add(key);
      void render();
      return;
    }
    const membersStop = event.target.closest("[data-stop-members]");
    if (membersStop) {
      if (!membersStop.disabled) void stopMembersFromPhone(membersStop.dataset.stopMembers.split(",").filter(Boolean));
      return;
    }
    const taskFold = event.target.closest("[data-task-fold]");
    if (taskFold) {
      const key = taskFold.dataset.taskFold;
      if (openTaskFolds.has(key)) openTaskFolds.delete(key);
      else openTaskFolds.add(key);
      void render();
      return;
    }
    // An urgent alert's Got it (or its cross once it no longer waits): the
    // server closes it; a closed one folds, and a tap opens it again.
    const alertClose = event.target.closest("[data-urgent-alert-close]");
    if (alertClose) {
      if (!alertClose.disabled) void closeUrgentAlert(alertClose.dataset.urgentAlertClose, row);
      return;
    }
    const alertToggle = event.target.closest("[data-urgent-alert-toggle]");
    if (alertToggle) {
      toggleUrgentAlert(alertToggle.dataset.urgentAlertToggle, row);
      return;
    }
    // A turn-finished note: its cross takes it away, the rest of it leads
    // back to the reply.
    const noteDismiss = event.target.closest("[data-finished-note-dismiss]");
    if (noteDismiss) {
      void dismissFinishedNote(noteDismiss.dataset.finishedNoteDismiss).catch(function (error) {
        flashRowNotice(row, "Could not dismiss: " + (error && error.message ? error.message : "try again"));
      });
      return;
    }
    const noteTarget = event.target.closest("[data-finished-note-target]");
    if (noteTarget) {
      openFinishedNoteTarget(noteTarget.dataset.finishedNoteTarget);
      return;
    }
    // A card under a message is answered where it stands: a tap on it is
    // never a tap on the row, live or not.
    if (event.target.closest(".control-card")) {
      return;
    }
    // (f) A row that cannot be followed says why instead of opening a view
    // that would sit there empty.
    if (row.dataset.streamBlocked) {
      flashRowNotice(row, "No live connection");
      return;
    }
    if (row.dataset.streamable !== "1") {
      // Slack's shape, which the User asked for: a message opens on its own
      // screen, and the offer to answer it in a thread lives there rather
      // than under every message in the chat.
      // A tap meant for something inside the row -- a picture, a card, a
      // button, a link -- is not a tap on the message.
      const interactive = event.target && event.target.closest
        ? event.target.closest("button, a, img, input, textarea, select, label, .control-card")
        : undefined;
      if (interactive) {
        return;
      }
      const threadRoot = row.dataset.threadRoot;
      // The sessions view has no threads: every message has one place.
      const sessionsView = Boolean(sessionsStateState.lastSessionsState && sessionsStateState.lastSessionsState.conversationId === selectedConversationId());
      if (threadRoot && !openThreadRootId() && !sessionsView) {
        setOpenThreadRootId(threadRoot);
        void render();
      }
      return;
    }
    const runId = row.dataset.streamRunId;
    if (!runId) {
      return;
    }
    setOpenStreamRunId(runId, row.dataset.streamMobileEventId || undefined);
    body.dataset.pinned = "1";
    body.dataset.text = "";
    void render();
  });
}

// W-M(a): only a live agent row with a run to follow can be opened. Applied
// on create AND on update, because a row that ends while on screen is updated
// in place and would otherwise keep advertising a run that is over.
// W-M(f): a row can be followed live only when it already carries real text
// the view can honestly show; otherwise the view would sit empty until the
// server's progress brings some.
export function applyStreamableState(item, entry) {
  if (entry.scaffolding) {
    delete item.dataset.streamable;
    delete item.dataset.streamRunId;
    delete item.dataset.streamMobileEventId;
    delete item.dataset.streamBlocked;
    return;
  }
  if (entry.author === "agent" && entry.status === "Running" && entry.runId) {
    const followable = Boolean((entry.content || "").trim() && !isPlaceholderTimelineContent(entry.content));
    if (followable) {
      item.dataset.streamable = "1";
      item.dataset.streamRunId = entry.runId;
      delete item.dataset.streamBlocked;
    } else {
      delete item.dataset.streamable;
      delete item.dataset.streamRunId;
      item.dataset.streamBlocked = "no-live-connection";
    }
    if (entry.mobileEventId) {
      item.dataset.streamMobileEventId = entry.mobileEventId;
    } else {
      delete item.dataset.streamMobileEventId;
    }
    return;
  }
  delete item.dataset.streamable;
  delete item.dataset.streamRunId;
  delete item.dataset.streamMobileEventId;
  delete item.dataset.streamBlocked;
}

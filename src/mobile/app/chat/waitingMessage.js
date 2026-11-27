import { sendNowPressedRunIds, stopRequestedRunIds, stopRunFromPhone } from "../outbox/sending.js";
import { sessionsRules } from "../sessions/sessionsState.js";

/** The User's messages a member has not taken yet, by message id, by the
 *  desktop's rule (shared/waitingMessages.ts). */
export function waitingMessagesOf(messages, participantId) {
  const shared = sessionsRules();
  return shared && typeof shared.waitingMessages === "function" ? shared.waitingMessages(messages, participantId) : new Map();
}

/** A reply that has not started: the sessions view draws no row for it, the
 *  message it answers says what can be done with it. */
export function isWaitingReplyRow(message) {
  const shared = sessionsRules();
  return Boolean(shared && typeof shared.isWaitingReply === "function" && shared.isWaitingReply(message));
}

/** What a row's waiting line shows, for the row's change check. */
export function waitingSignature(entry) {
  const waiting = entry.waiting;
  if (!waiting) return undefined;
  return [waiting.runId, waiting.behind ? waiting.behind.runId : "", isPressed(waiting)].join(":");
}

function isPressed(waiting) {
  return stopRequestedRunIds.has(waiting.runId) ||
    Boolean(waiting.behind && (stopRequestedRunIds.has(waiting.behind.runId) || sendNowPressedRunIds.has(waiting.behind.runId)));
}

/** Under a message its member has not taken yet: send it now, which
 *  lets the member take it at once (as the CLI's send-now; its reply so far
 *  is not stopped), or take it back. Left alone, the
 *  member takes it itself (as on the desktop). */
export function syncWaitingActions(item, entry) {
  const shown = Array.from(item.children).find(function (child) { return child.classList.contains("message-waiting"); });
  const signature = waitingSignature(entry);
  if (shown && shown.dataset.waiting === signature) return;
  if (shown) shown.remove();
  const waiting = entry.waiting;
  if (!waiting) return;
  const line = document.createElement("div");
  line.className = "message-waiting";
  line.dataset.waiting = signature;
  if (waiting.behind) {
    line.append(waitingButton("is-send-now", "Send now", "Send this message now", waiting, function () {
      return stopRunFromPhone(waiting.behind.runId, undefined, { messageId: waiting.behind.messageId, participantId: waiting.participantId, sendNow: true, waitingRunId: waiting.runId });
    }));
  }
  line.append(waitingButton("is-take-back", "×", "Take this message back", waiting, function () {
    return stopRunFromPhone(waiting.runId, undefined, { messageId: entry.sourceId || entry.id, participantId: waiting.participantId });
  }));
  item.append(line);
}

function waitingButton(className, text, label, waiting, press) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "message-waiting-action " + className;
  button.textContent = text;
  button.setAttribute("aria-label", label);
  button.disabled = isPressed(waiting);
  button.addEventListener("click", function (event) {
    event.preventDefault();
    event.stopPropagation();
    if (button.disabled) return;
    for (const other of button.parentElement.querySelectorAll("button")) other.disabled = true;
    void press();
  });
  return button;
}

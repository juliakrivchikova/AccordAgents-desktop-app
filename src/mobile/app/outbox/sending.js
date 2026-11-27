import { createEventId } from "../base/bytes.js";
import { render } from "../chat/render.js";
import { loadChats } from "../chats/chatStore.js";
import { selectedConversationId } from "../chats/openChat.js";
import { hubOutboxEntry, OUTBOX_REFUSED, OUTBOX_SENT, OUTBOX_SUPERSEDED } from "./hubOutbox.js";
import { putOutboxEntries, putOutboxEntry } from "./outboxStore.js";
import { recordSendFailure } from "./sendLog.js";
import { isHubPairing } from "../pairing/hubPairing.js";
import { listTimelineEntries } from "../store/timelineRows.js";
import { retryOutboxNow } from "../sync/outboxRetry.js";
import { handOverBeforeDrawing } from "../sync/serverReads.js";

/** A queue entry for something this phone did: one operation for the
 *  User's server, kept here under the operation's id until the server
 *  answers it (see flushOutboxToServer). */
export async function createOutboxEvent(input) {
  return hubOutboxEntry(input);
}

/**
 * Queues what this device did. An entry is its own record, written before
 * anything is sent: a failed write here leaves nothing behind that the
 * User did not see fail.
 */
export function persistOutboundEvent(entry) {
  return putOutboxEntry(entry).then(function () { return entry; });
}

/** A message, and the desktop's line for each name in it that is no member
 *  ("No member named @x."), each its own operation right behind it. One
 *  transaction: the lines never wait without their message. */
export async function enqueueMessage(input) {
  const entries = await messageOutboxEntries(input);
  await putOutboxEntries(entries);
  return entries[0];
}

/** The message's entries, not written yet: the message first. */
export async function messageOutboxEntries(input) {
  const entry = await createOutboxEvent(input);
  const threadRootId = entry.payload && typeof entry.payload.threadRootId === "string" && entry.payload.threadRootId ? entry.payload.threadRootId : undefined;
  const notes = [];
  for (const handle of (entry.hubDelivery && entry.hubDelivery.unknownHandles) || []) {
    const noteId = createEventId();
    notes.push(await createOutboxEvent({
      eventId: noteId,
      conversationId: entry.conversationId,
      kind: "message.system",
      createdAt: entry.createdAt,
      dependsOn: entry.eventId,
      payload: { message: {
        id: noteId, role: "system", content: "No member named @" + handle + ".", createdAt: entry.createdAt, status: "done",
        metadata: { threadId: entry.eventId, parentMessageId: entry.eventId, ...(threadRootId ? { chatThreadRootId: threadRootId } : {}) }
      } }
    }));
  }
  return [entry].concat(notes);
}

/** A Stop of one member's turn on the server, named by the turn's run id,
 *  the message it answers and the member (`rowRunId` is the run id the row on
 *  screen carries, which may be the device's own name for the run). With
 *  `sendNow` it is the User's Send now on a message waiting behind the turn,
 *  not her Stop: the member's device lets it take that message now. */
export function enqueueTurnStop(input) {
  return createOutboxEvent({
    conversationId: input.conversationId,
    kind: "turn.stop",
    payload: {
      runId: input.runId, messageId: input.messageId, participantId: input.participantId,
      ...(input.rowRunId ? { rowRunId: input.rowRunId } : {}),
      ...(input.sendNow ? { sendNow: true } : {}),
      ...(input.sendNow && input.waitingRunId ? { waitingRunId: input.waitingRunId } : {})
    }
  }).then(persistOutboundEvent);
}

export function isMessageOutboxEntry(entry) {
  return !entry.kind || entry.kind === "message.created";
}

/** Whether a queue entry still waits for the server's answer: not taken
 *  (accepted, or a repeat of one it took), not refused for good, and not
 *  replaced by a later answer to the same card. */
export function serverOwesEntry(entry) {
  return Boolean(entry) && entry.status !== OUTBOX_SENT && entry.status !== OUTBOX_SUPERSEDED &&
    entry.status !== OUTBOX_REFUSED;
}

/** Runs the User has asked to stop, from the tap onward. The queue entry is
 *  written asynchronously, and a render in that gap used to put the Stop
 *  control back as if nothing had been asked -- which is both a lie and a
 *  second Stop the User can send by accident. */
export const stopRequestedRunIds = new Set();
/** Runs a Send now was pressed for (not stopping): their waiting buttons stay
 *  pressed until the message moves on, or are released if it could not be sent. */
export const sendNowPressedRunIds = new Set();

/**
 * The turn on the server a row's run is: its run id there, the message it
 * answers and its member. A routed row and a member's bubble say the last
 * two themselves (`known`); a run reached from somewhere else (the live
 * reply, Activity) is looked up in what this phone holds of the chat. A
 * device's own name for a run is the turn's id with "turn-" before it, as
 * every device names a turn it opens (ServerTurns.openServerTurn).
 */
export async function turnOfRun(conversationId, runId, known) {
  let messageId = known && typeof known.messageId === "string" && known.messageId ? known.messageId : undefined;
  let participantId = known && typeof known.participantId === "string" && known.participantId ? known.participantId : undefined;
  if (!messageId || !participantId) {
    const rows = await listTimelineEntries(conversationId).catch(function () { return []; });
    const chat = loadChats().find(function (item) { return item.id === conversationId; });
    const listed = chat && Array.isArray(chat.activity) ? chat.activity : [];
    const row = rows.concat(listed).find(function (item) {
      return item && item.runId === runId && typeof item.sourceMessageId === "string" && item.sourceMessageId && typeof item.participantId === "string" && item.participantId;
    });
    if (row) {
      messageId = messageId || row.sourceMessageId;
      participantId = participantId || row.participantId;
    }
  }
  if ((!messageId || !participantId) && runId.indexOf("turn-") === 0) {
    // The turn a User's message asks of a member is named after both.
    const chat = loadChats().find(function (item) { return item.id === conversationId; });
    for (const member of chat && Array.isArray(chat.members) ? chat.members : []) {
      const suffix = "-" + member.id;
      if (member.id && runId.length > 5 + suffix.length && runId.slice(-suffix.length) === suffix) {
        messageId = runId.slice(5, runId.length - suffix.length);
        participantId = member.id;
        break;
      }
    }
  }
  if (!messageId || !participantId) return undefined;
  return { runId: runId.indexOf("turn-") === 0 ? runId : "turn-" + runId, rowRunId: runId, messageId: messageId, participantId: participantId };
}

export async function stopRunFromPhone(runId, forConversationId, known) {
  // Activity stops a run in a chat that is not open, so it names the chat.
  const conversationId = forConversationId || selectedConversationId();
  if (!conversationId || typeof runId !== "string" || !runId.trim()) {
    return;
  }
  const wanted = runId.trim();
  // A Send now stops nothing: the run is not shown as stopping.
  const sendNowOnly = Boolean(known && known.sendNow);
  (sendNowOnly ? sendNowPressedRunIds : stopRequestedRunIds).add(wanted);
  await render();
  const turn = await turnOfRun(conversationId, wanted, known);
  if (!turn) {
    // Nothing to name it by: said in the send log, and the Stop comes back.
    stopRequestedRunIds.delete(wanted);
    sendNowPressedRunIds.delete(wanted);
    await recordSendFailure({
      conversationId: conversationId, kind: "turn.stop", text: sendNowOnly ? "Send now" : "Stop", cause: "phone",
      reason: "This phone does not know which message this run answers, so it could not name it to your server."
    });
    await render();
    return;
  }
  await enqueueTurnStop({
    conversationId: conversationId, runId: turn.runId, rowRunId: turn.rowRunId, messageId: turn.messageId, participantId: turn.participantId,
    sendNow: sendNowOnly,
    // The message it was pressed on, by its turn on the server.
    waitingRunId: sendNowOnly && known.waitingRunId ? (known.waitingRunId.indexOf("turn-") === 0 ? known.waitingRunId : "turn-" + known.waitingRunId) : undefined
  });
  // A Stop goes where every other write goes, at once; the member's own
  // device stops the run when it reads it, and the row keeps saying
  // "Stopping" until it has.
  await sendNow();
}

/** What the User just did goes to the server at once: the redraw does not
 *  hold it back, and the retries start over from their first pause. */
export async function sendNow() {
  const flushing = retryOutboxNow();
  await handOverBeforeDrawing(flushing);
  await render();
  const flushResult = await flushing;
  await render(flushResult.status);
  return flushResult;
}

/** Whether this phone can read and write at all: only through the User's
 *  server, once paired with it. */
export function canSync(pairing) {
  return isHubPairing(pairing);
}

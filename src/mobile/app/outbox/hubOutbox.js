import { createEventId, nowIso, recordRelayDebug } from "../base/bytes.js";
import { META_STORE, OUTBOX_STORE } from "../base/storageKeys.js";
import { forgetStartedChat, loadChats } from "../chats/chatStore.js";
import { activeConversationId } from "../chats/openChat.js";
import { mobileSharedRules } from "../members/avatars.js";
import { listOutboxEntries, noteOutboxStatus, updateOutboxEntry } from "./outboxStore.js";
import { serverOwesEntry, turnOfRun } from "./sending.js";
import { recordSendFailure, sendFailureRecord } from "./sendLog.js";
import {
  currentHubServer, HUB_SENT_KEEP_MS, hubClient, OLD_CHAIN_CLOCK_META_KEY, OLD_CHAIN_HEAD_META_PREFIX, serverPairing
} from "../pairing/hubPairing.js";
import { eventLogPort, requestToPromise, withOutbox } from "../store/database.js";
import { listTimelineEntries } from "../store/timelineRows.js";
import { noteHandOverRequestStarted } from "../sync/serverReads.js";

// --- what this phone writes: operations on the User's server --------------
// Everything this phone does to a chat is one operation the server owns
// (agreements Д1, Д10): a message is `message.create`, a Stop `turn.stop`,
// an answer to a card `card.answer`. Each waits in the queue under its own
// id until the server answers it. Accepted, or a repeat of one it already
// took, is "Sent" (Д3); rejected is not taken, and says the server's
// reason. No answer at all (no connection, a timeout, an error of the
// server's own) is offered again, and every such attempt is written to the
// send log with its reason (Д12).

// Where a queue entry stands: waiting for the server's answer, taken,
// refused for good, or replaced (an answer to a card the User answered
// again before the first one went).
const OUTBOX_QUEUED = "queued";

export const OUTBOX_SENT = "acked";
export const OUTBOX_REFUSED = "refused";
export const OUTBOX_SUPERSEDED = "superseded";

/** Operations in one request (the server takes a hundred at most), and
 *  about how much of them: the server reads sixteen megabytes of a request
 *  at most, and a request it cannot read would fail for every entry in it,
 *  every time. One operation over what the server takes (four megabytes) is
 *  not taken, and is said so here rather than sent forever. */
const HUB_OPS_PAGE = 50;

const HUB_OPS_PAGE_BYTES = 8 * 1024 * 1024;
const HUB_OP_MAX_BYTES_FALLBACK = 4 * 1024 * 1024;

// The order entries are sent in: the order they were written, so a line
// that belongs to a message goes behind it even when both carry one moment.
let outboxOrderLast = 0;

function nextOutboxOrder() {
  outboxOrderLast = Math.max(outboxOrderLast + 1, Date.now() * 1000);
  return outboxOrderLast;
}

function outboxOrderOf(entry) {
  if (typeof entry.order === "number" && Number.isFinite(entry.order)) return entry.order;
  const at = Date.parse(entry.createdAt || "");
  return Number.isFinite(at) ? at * 1000 : 0;
}

export async function hubOutboxEntry(input) {
  const eventId = input.eventId || createEventId();
  const createdAt = input.createdAt || nowIso();
  const kind = input.kind || "message.created";
  const conversationId = activeConversationId(input.conversationId);
  const payload = input.payload || {
    content: input.content,
    ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {})
  };
  return {
    // The operation's id; for a message, the message's id as well.
    eventId: eventId,
    conversationId: conversationId,
    kind: kind,
    payload: payload,
    createdAt: createdAt,
    order: nextOutboxOrder(),
    status: OUTBOX_QUEUED,
    attempts: 0,
    updatedAt: createdAt,
    hub: true,
    // The server it was written for: it goes to no other.
    hubServer: currentHubServer(),
    ops: 3,
    ...(input.dependsOn ? { dependsOn: input.dependsOn } : {}),
    // Who the message is for, decided now, from what this phone showed the
    // User when she sent it — the same rules the desktop applies to what is
    // typed there.
    ...(kind === "message.created" ? { hubDelivery: await resolvePhoneDelivery(conversationId, payload) } : {})
  };
}

/** A message written in a member's session goes to that member only:
 *  exactly these members, no @ read for addressees, no fallback (the
 *  desktop's targetParticipantIds). */
function explicitPhoneTargets(payload) {
  const ids = payload && Array.isArray(payload.targetParticipantIds)
    ? payload.targetParticipantIds.filter(function (id) { return typeof id === "string" && id; })
    : [];
  return ids.length ? Array.from(new Set(ids)) : undefined;
}

/** The members a draft is for, by the desktop's own rules (bundled from
 *  src/shared/chatDeliveryPolicy.ts), over the chat as this phone holds it. */
export async function resolvePhoneDelivery(conversationId, payload) {
  const explicit = explicitPhoneTargets(payload);
  if (explicit) return { targets: explicit, unknownHandles: [], resolved: true, explicit: true };
  const shared = mobileSharedRules();
  const chat = loadChats().find(function (item) { return item.id === conversationId; });
  const members = chat && Array.isArray(chat.members) ? chat.members : [];
  if (!shared || typeof shared.resolveChatDeliveryTargets !== "function") return { targets: [], unknownHandles: [], resolved: false };
  const participants = members.map(function (member) {
    return {
      id: member.id,
      handle: member.handle,
      // The member the chat names its main session is that, whatever this
      // phone stored of its role (an older copy of the list dropped it).
      roleConfigId: chat && chat.mainSessionParticipantId === member.id ? "main-session"
        : member.roleConfigId || (member.isAssistant ? "administrator" : "generic-participant"),
      kind: member.kind,
      ...(member.homeMachineId ? { homeMachineId: member.homeMachineId } : {})
    };
  });
  const rows = await listTimelineEntries(conversationId).catch(function () { return []; });
  const messages = rows.map(function (row) {
    return {
      id: row.messageId || row.sourceId || row.id,
      role: row.role === "you" ? "user" : row.role,
      content: row.content || "",
      createdAt: row.createdAt,
      ...(row.participantId ? { participantId: row.participantId } : {}),
      metadata: {
        ...(row.threadId ? { threadId: row.threadId } : {}),
        ...(row.threadRootId ? { chatThreadRootId: row.threadRootId } : {})
      }
    };
  });
  const threadRootId = payload && typeof payload.threadRootId === "string" ? payload.threadRootId : undefined;
  const result = shared.resolveChatDeliveryTargets({
    // The chat's main session takes what names nobody (docs/main-session.md).
    conversation: { id: conversationId, messages: messages, metadata: {
      participants: participants,
      ...(chat && chat.mainSessionParticipantId ? { mainSessionParticipantId: chat.mainSessionParticipantId } : {})
    } },
    participants: participants,
    content: String(payload && payload.content || ""),
    context: threadRootId ? { chatThreadRootId: threadRootId } : {},
    options: shared.CHAT_DELIVERY_POLICY_OPTIONS
  });
  return {
    targets: result.targets.map(function (participant) { return participant.id; }),
    unknownHandles: result.unknownHandles,
    resolved: true
  };
}

function imageExtension(mimeType) {
  return mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg";
}

/** The User's message as the server keeps it (the message the desktop
 *  makes of what is typed there): its id is the queue entry's, pictures go
 *  up first as bodies the server holds, and /goal carries its command. */
async function phoneMessage(entry, client) {
  const payload = entry.payload || {};
  const content = typeof payload.content === "string" ? payload.content : "";
  const messageId = entry.eventId;
  const delivery = entry.hubDelivery || { targets: [], unknownHandles: [] };
  const threadRootId = typeof payload.threadRootId === "string" && payload.threadRootId ? payload.threadRootId : undefined;
  const imageAttachments = [];
  for (const attachment of Array.isArray(payload.attachments) ? payload.attachments : []) {
    const bytes = base64ToBytesStd(attachment.dataBase64);
    const id = createEventId();
    const uploading = client.uploadBlob(bytes);
    noteHandOverRequestStarted();
    const reference = await uploading;
    imageAttachments.push({
      id: id,
      filename: attachment.filename || ("photo." + imageExtension(attachment.mimeType)),
      mimeType: attachment.mimeType,
      sizeBytes: bytes.length,
      width: Number(attachment.width) || 0,
      height: Number(attachment.height) || 0,
      storageKey: "attachments/" + id + "." + imageExtension(attachment.mimeType),
      createdAt: entry.createdAt,
      hubBlob: reference
    });
  }
  const shared = mobileSharedRules();
  let nativeCommand;
  if (shared && typeof shared.parseNativeGoalCommand === "function") {
    const goal = shared.parseNativeGoalCommand(content);
    if (goal.kind === "valid" && delivery.targets.length === 1) {
      const member = (loadChats().find(function (chat) { return chat.id === entry.conversationId; }) || {}).members || [];
      const target = member.find(function (item) { return item.id === delivery.targets[0]; });
      nativeCommand = { name: "goal", objective: shared.nativeGoalObjective(goal.contentWithoutCommand, target ? target.handle : "") };
    }
  }
  return {
    id: messageId,
    role: "user",
    content: content,
    createdAt: entry.createdAt,
    status: "done",
    metadata: {
      appMessageSource: "mobile-relay",
      mobileEventId: entry.eventId,
      threadId: messageId,
      ...(threadRootId ? { chatThreadRootId: threadRootId } : {}),
      // The server asks a turn of each of them (Д4); each member's own
      // device takes its turn, and its reply shows it started.
      deliveryTargets: delivery.targets,
      ...(Array.isArray(payload.skillMentions) && payload.skillMentions.length ? { skillMentions: payload.skillMentions } : {}),
      ...(imageAttachments.length ? { imageAttachments: imageAttachments } : {}),
      ...(nativeCommand ? { nativeCommand: nativeCommand } : {})
    }
  };
}

function base64ToBytesStd(value) {
  const binary = atob(String(value || ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * The operation a queue entry is. A message is made once — its pictures
 * put on the server, its attachments named — and kept with the entry, so
 * every later attempt sends the very same operation under the same id: the
 * server takes it once however often it arrives.
 */
async function operationOf(entry, client) {
  if (entry.op && entry.op.opId === entry.eventId) return entry.op;
  const base = { opId: entry.eventId, conversationId: entry.conversationId };
  const payload = entry.payload || {};
  if (entry.kind === "message.created") {
    const op = { ...base, kind: "message.create", message: await phoneMessage(entry, client) };
    // Another attempt may have made it meanwhile (one that outlived its
    // watchdog): the one kept first is the one sent, every time.
    let kept;
    await updateOutboxEntry(entry.eventId, function (stored) {
      if (stored.op && stored.op.opId === entry.eventId) {
        kept = stored.op;
        return undefined;
      }
      return { ...stored, op: op };
    });
    return kept || op;
  }
  if (entry.kind === "message.system") return { ...base, kind: "message.create", message: payload.message };
  if (entry.kind === "conversation.create") return { ...base, kind: "conversation.create", conversation: payload.conversation };
  if (entry.kind === "turn.stop") {
    return { ...base, kind: "turn.stop", runId: payload.runId, messageId: payload.messageId, participantId: payload.participantId };
  }
  if (entry.kind === "card.answer") return { ...base, kind: "card.answer", cardId: payload.cardId, answer: payload.answer || {} };
  if (entry.kind === "message.remove") return { ...base, kind: "message.remove", messageId: payload.messageId };
  // Pinning orders the User's list on every device; the server keeps the
  // chat's time for it.
  if (entry.kind === "conversation.pin") {
    return payload.pinned === true
      ? { ...base, kind: "conversation.update", metadata: { pinned: true, pinnedAt: payload.pinnedAt } }
      : { ...base, kind: "conversation.update", removedMetadataKeys: ["pinned", "pinnedAt"] };
  }
  // The chat's view, switched here: every device shows it so (shared
  // through her server like the pin).
  if (entry.kind === "conversation.view") {
    return { ...base, kind: "conversation.update", metadata: { chatView: payload.view } };
  }
  throw new Error("This phone cannot send a " + String(entry.kind || "change") + ".");
}

/** What a failed reach said, without the client's own "could not be
 *  reached" opening: the phone says that part in its own words. */
export function unreachableDetail(error) {
  const message = error && typeof error === "object" ? String(error.message || "") : String(error || "");
  return message.replace(/^The server could not be reached:\s*/, "");
}

/** Why an attempt failed, in words, and of which kind: no connection, a
 *  timeout, an error answer of the server's, or this phone's own. */
export function sendFailureOf(error) {
  if (error && error.timedOut) return { cause: "timeout", reason: "Your server did not answer in time." };
  if (error && error.name === "TimeoutError") return { cause: "timeout", reason: "Your server did not answer in time." };
  if (error && error.unreachable) {
    const detail = unreachableDetail(error);
    return { cause: "network", reason: "Could not reach your server" + (detail ? " (" + detail + ")" : "") + "." };
  }
  if (error && typeof error.status === "number") {
    let said = "";
    try { said = String(JSON.parse(error.body || "{}").error || ""); } catch { said = ""; }
    if (error.status === 401 && said.indexOf("not on the hub's roster") >= 0) {
      // Taken off the server's devices (removed on the desktop): said as the
      // reads say it, and nothing more is offered (see scheduleOutboxRetry).
      serverPairing.hubPairingState = { status: "revoked", message: "This phone was removed from your server. Pair it again from your computer." };
      return { cause: "revoked", reason: "This phone was removed from your server, so it cannot send. Pair it again from your computer." };
    }
    return { cause: "http", reason: "Your server answered " + error.status + (said ? ": " + said : ".") };
  }
  return { cause: "phone", reason: "This phone could not send it: " + String(error && error.message || error) };
}

/**
 * Sends what this phone still owes its server, in the order it was
 * written. Each entry waits until the server answers its operation:
 * accepted or a duplicate is sent, rejected is refused with the server's
 * reason. Anything else keeps it waiting, and is written to the send log.
 * A line that belongs to a message goes only once the message is taken,
 * and goes with it when it is refused.
 */
export async function flushOutboxToServer(entries) {
  const client = hubClient();
  // Written for another server (the phone was paired again meanwhile):
  // it never goes to this one.
  const server = currentHubServer();
  for (const stray of entries.filter(function (entry) { return entry.hub && serverOwesEntry(entry) && entry.hubServer && entry.hubServer !== server; })) {
    await settleOutboxEntry(stray, { status: OUTBOX_REFUSED, lastError: "Written for another server, so it was not sent to this one." });
  }
  let owed = entries.filter(function (entry) { return entry.hub && serverOwesEntry(entry) && (!entry.hubServer || entry.hubServer === server); })
    .sort(function (left, right) { return outboxOrderOf(left) - outboxOrderOf(right) || String(left.eventId).localeCompare(String(right.eventId)); });
  if (!client) return { status: "unreachable", sent: 0, pending: owed.length };
  let sent = 0;
  const total = owed.length;
  const statusOf = new Map(entries.map(function (entry) { return [entry.eventId, entry.status]; }));
  // Why each was refused, this pass's refusals included.
  const refusalOf = new Map(entries.map(function (entry) { return [entry.eventId, entry.lastError]; }));
  // A line goes once what it belongs to is taken, so a pass may free more.
  for (let pass = 0; pass < 3 && owed.length > 0; pass += 1) {
    const ready = [];
    const later = [];
    for (const entry of owed) {
      const parent = entry.dependsOn ? statusOf.get(entry.dependsOn) : undefined;
      if (entry.dependsOn && parent === OUTBOX_REFUSED) {
        const owner = entries.find(function (item) { return item.eventId === entry.dependsOn; });
        const why = refusalOf.get(entry.dependsOn);
        await settleOutboxEntry(entry, { status: OUTBOX_REFUSED, lastError: owner && owner.kind === "conversation.create"
          ? "The chat was not created" + (why ? ": " + why : ".")
          : "The message it belongs to was not taken." });
        continue;
      }
      if (entry.dependsOn && parent !== undefined && parent !== OUTBOX_SENT) {
        later.push(entry);
        continue;
      }
      try {
        const op = await operationOf(entry, client);
        const bytes = new TextEncoder().encode(JSON.stringify(op)).length;
        const most = Number(globalThis.AccordHubClient && globalThis.AccordHubClient.HUB_OP_MAX_BYTES) || HUB_OP_MAX_BYTES_FALLBACK;
        if (bytes > most) {
          const reason = "It is too large for your server to take (" + Math.ceil(bytes / 1024 / 1024) + " MB; it takes " + Math.floor(most / 1024 / 1024) + " MB at most).";
          await settleOutboxEntry(entry, { status: OUTBOX_REFUSED, lastError: reason });
          await recordSendFailure(sendFailureRecord(entry, { cause: "phone", reason: reason }));
          statusOf.set(entry.eventId, OUTBOX_REFUSED);
          refusalOf.set(entry.eventId, reason);
          if (entry.kind === "conversation.create") forgetStartedChat(entry.conversationId);
          continue;
        }
        ready.push({ entry: entry, op: op, bytes: bytes });
      } catch (error) {
        await noteFailedAttempt(entry, sendFailureOf(error));
        if (error && (error.unreachable || typeof error.status === "number")) {
          return { status: error.unreachable ? "unreachable" : "waiting-to-sync", sent: sent, pending: total - sent };
        }
      }
    }
    if (ready.length === 0) {
      owed = later;
      continue;
    }
    const pages = [];
    for (const item of ready) {
      const last = pages[pages.length - 1];
      if (last && last.items.length < HUB_OPS_PAGE && last.bytes + item.bytes <= HUB_OPS_PAGE_BYTES) {
        last.items.push(item);
        last.bytes += item.bytes;
      } else {
        pages.push({ items: [item], bytes: item.bytes });
      }
    }
    for (const { items: page } of pages) {
      let response;
      try {
        const posting = client.postOps(page.map(function (item) { return item.op; }));
        noteHandOverRequestStarted();
        response = await posting;
      } catch (error) {
        const failure = sendFailureOf(error);
        for (const item of page) await noteFailedAttempt(item.entry, failure);
        return { status: failure.cause === "network" || failure.cause === "timeout" ? "unreachable" : "waiting-to-sync", sent: sent, pending: total - sent };
      }
      const results = new Map((Array.isArray(response && response.results) ? response.results : []).map(function (result) { return [result && result.opId, result]; }));
      for (const item of page) {
        const result = results.get(item.op.opId);
        if (result && (result.status === "accepted" || result.status === "duplicate")) {
          await settleOutboxEntry(item.entry, { status: OUTBOX_SENT, ack: { seq: result.seq, status: result.status } });
          statusOf.set(item.entry.eventId, OUTBOX_SENT);
          sent += 1;
        } else if (result && result.status === "rejected") {
          const reason = String(result.reason || "No reason was given.");
          await settleOutboxEntry(item.entry, { status: OUTBOX_REFUSED, lastError: reason });
          await recordSendFailure(sendFailureRecord(item.entry, { cause: "refused", reason: "Your server did not take it: " + reason }));
          statusOf.set(item.entry.eventId, OUTBOX_REFUSED);
          refusalOf.set(item.entry.eventId, reason);
          if (item.entry.kind === "conversation.create") forgetStartedChat(item.entry.conversationId);
        } else {
          await noteFailedAttempt(item.entry, { cause: "http", reason: "Your server answered without a word about it." });
        }
      }
    }
    owed = later;
  }
  return { status: sent === total ? "synced" : "waiting-to-sync", sent: sent, pending: total - sent };
}

/** The server answered an entry: what it said is written on the entry,
 *  unless the entry was answered or replaced meanwhile. */
function settleOutboxEntry(entry, patch) {
  return updateOutboxEntry(entry.eventId, function (stored) {
    if (!serverOwesEntry(stored)) return undefined;
    return { ...stored, ...patch, attempts: (Number(stored.attempts) || 0) + 1, updatedAt: nowIso(),
      ...(patch.status === OUTBOX_SENT ? { lastError: undefined } : {}) };
  });
}

/** An attempt that got no answer: the entry keeps waiting, says why, and
 *  the attempt goes into the send log. */
async function noteFailedAttempt(entry, failure) {
  let attempts = (Number(entry.attempts) || 0) + 1;
  await updateOutboxEntry(entry.eventId, function (stored) {
    if (!serverOwesEntry(stored)) return undefined;
    attempts = (Number(stored.attempts) || 0) + 1;
    return { ...stored, status: OUTBOX_QUEUED, attempts: attempts, updatedAt: nowIso(), lastError: failure.reason, failedAt: nowIso() };
  }).catch(function () { return undefined; });
  await recordSendFailure(sendFailureRecord(entry, failure, attempts));
}

/** Entries the server answered, and those replaced, are kept a week (their
 *  bubbles, the marks of answers), then let go. */
export async function pruneSentHubEntries() {
  const cutoff = Date.now() - HUB_SENT_KEEP_MS;
  const entries = await listOutboxEntries();
  for (const entry of entries) {
    if (entry.hub && !serverOwesEntry(entry) && Date.parse(entry.updatedAt || entry.createdAt) < cutoff) {
      await withOutbox("readwrite", function (store) { return requestToPromise(store.delete(entry.eventId)); }).catch(function () { return undefined; });
    }
  }
}

/**
 * Once, on a phone that queued in the old way (each change a signed event
 * in its own chain): what it still owes becomes the operation it was, and
 * what only the chains needed goes — the phone's certificate event (the
 * desktop learns a phone from the server's roster now), the signed copies,
 * where each chain stood and its clock. Nothing is sent the old way.
 */
const QUEUE_RETIRED_KEY = "accordagents.mobile.queueOps.v1";

export async function retireSignedChains() {
  if (localStorage.getItem(QUEUE_RETIRED_KEY) === "1") return;
  const entries = await listOutboxEntries();
  const kept = [];
  const dropped = [];
  for (const entry of entries) {
    if (entry.ops === 3) continue;
    const { minted: _minted, logScopeId: _scope, ...rest } = entry;
    const base = { ...rest, ops: 3, order: outboxOrderOf(entry) };
    if (entry.kind === "device.enrolled") {
      dropped.push(entry.eventId);
      continue;
    }
    if (!serverOwesEntry(entry)) {
      kept.push(base);
      continue;
    }
    const owed = { ...base, status: OUTBOX_QUEUED };
    if (!entry.kind || entry.kind === "message.created") {
      kept.push(owed);
      // Its lines for names that are no members were part of its old
      // event; they go behind it as their own operations.
      for (const handle of (entry.hubDelivery && entry.hubDelivery.unknownHandles) || []) {
        const noteId = createEventId();
        const threadRootId = entry.payload && typeof entry.payload.threadRootId === "string" && entry.payload.threadRootId ? entry.payload.threadRootId : undefined;
        kept.push({
          eventId: noteId, conversationId: entry.conversationId, kind: "message.system", createdAt: entry.createdAt, order: outboxOrderOf(entry) + 1,
          status: OUTBOX_QUEUED, attempts: 0, updatedAt: nowIso(), hub: true, ops: 3, dependsOn: entry.eventId,
          payload: { message: { id: noteId, role: "system", content: "No member named @" + handle + ".", createdAt: entry.createdAt, status: "done",
            metadata: { threadId: entry.eventId, parentMessageId: entry.eventId, ...(threadRootId ? { chatThreadRootId: threadRootId } : {}) } } }
        });
      }
      continue;
    }
    if (entry.kind === "run.cancel.requested") {
      const runId = String(entry.payload && entry.payload.runId || "");
      const phoneTurn = /^phone-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-(.+)$/i.exec(runId);
      const turn = phoneTurn
        ? { runId: globalThis.AccordHubClient.hubTurnRunId(phoneTurn[1], phoneTurn[2]), rowRunId: runId, messageId: phoneTurn[1], participantId: phoneTurn[2] }
        : runId ? await turnOfRun(entry.conversationId, runId) : undefined;
      kept.push(turn
        ? { ...owed, kind: "turn.stop", payload: turn }
        : { ...owed, status: OUTBOX_REFUSED, lastError: "This Stop was queued by an earlier version of the app and could not be sent." });
      continue;
    }
    if (entry.kind === "permission.decided" || entry.kind === "choice.answered") {
      const payload = entry.payload || {};
      const detail = payload.detail || {};
      const cardId = String(payload.targetKey || "").replace(/^(approval|choice):/, "");
      const answer = entry.kind === "permission.decided"
        ? { approve: detail.approve === true, ...(detail.codexDecisionId ? { codexDecisionId: detail.codexDecisionId } : {}), ...(detail.draftOverride ? { draftOverride: detail.draftOverride } : {}) }
        : { ...(detail.selectedOptionId ? { selectedOptionId: detail.selectedOptionId } : {}), ...(detail.customAnswer !== undefined ? { customAnswer: detail.customAnswer } : {}),
          ...(detail.note !== undefined ? { note: detail.note } : {}), ...(detail.cancel ? { cancel: true } : {}) };
      kept.push(cardId
        ? { ...owed, kind: "card.answer", payload: { cardId: cardId, cardKind: entry.kind === "permission.decided" ? "permission" : "choice", answer: answer } }
        : { ...owed, status: OUTBOX_REFUSED, lastError: "This answer was queued by an earlier version of the app and could not be sent." });
      continue;
    }
    kept.push({ ...owed, status: OUTBOX_REFUSED, lastError: "This was queued by an earlier version of the app and could not be sent." });
  }
  await eventLogPort().runAtomic([OUTBOX_STORE, META_STORE], function (tx) {
    let chain = Promise.resolve();
    for (const eventId of dropped) chain = chain.then(function () { return tx.remove(OUTBOX_STORE, eventId); });
    for (const entry of kept) chain = chain.then(function () { return tx.put(OUTBOX_STORE, entry); });
    return chain.then(function () {
      return tx.removeWhere(META_STORE, function (record) {
        const key = record && typeof record.key === "string" ? record.key : "";
        return key === OLD_CHAIN_CLOCK_META_KEY || key.indexOf(OLD_CHAIN_HEAD_META_PREFIX) === 0;
      });
    });
  });
  for (const entry of kept) noteOutboxStatus(entry);
  localStorage.setItem(QUEUE_RETIRED_KEY, "1");
  recordRelayDebug({ event: "queue-retired", converted: kept.length, dropped: dropped.length });
}

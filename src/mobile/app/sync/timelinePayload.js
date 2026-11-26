import { refreshChatListSoon } from "../activity/activityData.js";
import { createEventId, nowIso, recordRelayDebug } from "../base/bytes.js";
import { storeControlCards } from "../cards/controlCardStore.js";
import { render } from "../chat/render.js";
import { markConversationsUnread, markConversationViewed } from "../chats/chatStore.js";
import { openChatState, selectedConversationId } from "../chats/openChat.js";
import { timelineAttachmentsFromEvent } from "../media/attachments.js";
import { isSupersededPendingEvent, rememberTerminalRun } from "../store/terminalRuns.js";
import { adoptTimelinePage } from "../store/timelinePages.js";
import {
  deletePendingTimelineEntriesForRun, deleteStalePlaceholderTimelineEntries, deleteTimelineEntry, putTimelineEntryDeduped
} from "../store/timelineRows.js";
import { dismissedFinishedNotes, dropRemovedFinishedNotes, finishedNoteOfEvent } from "./finishedNotes.js";
import { renderMessageContentIfChanged } from "../text/messageText.js";

// The line a finished compaction left (shared/mainSession.ts
// sessionsCompactionLineOf): the member compacted and the CLI that did it.
// It travels with no words; the sessions view words it by that CLI.
const COMPACTING_CLIS = ["claude-code", "codex-cli", "gemini-cli"];

function compactionOfEvent(event) {
  const line = event && event.role === "system" ? event.compaction : undefined;
  if (!line || typeof line.participantId !== "string" || !line.participantId) return undefined;
  return { participantId: line.participantId, ...(COMPACTING_CLIS.indexOf(line.cli) >= 0 ? { cli: line.cli } : {}) };
}

// What a member posted during its turn is part of its reply (the desktop's
// shared/interimPosts.ts): shown inside the reply, above its final words.
// Their pictures are among the reply's own.
function interimPostsOfEvent(event) {
  if (!event || !Array.isArray(event.interimPosts)) return {};
  const posts = event.interimPosts.filter(function (post) {
    return post && typeof post.id === "string" && post.id && typeof post.content === "string";
  }).map(function (post) {
    return { id: post.id, content: post.content, createdAt: typeof post.createdAt === "string" ? post.createdAt : "" };
  });
  return posts.length > 0 ? { interimPosts: posts } : {};
}

// Two copies' posts of one reply, together: each post once (the newer
// copy's), oldest first, as the desktop merges them.
export function mergedInterimPosts(older, newer) {
  const byId = new Map();
  const order = [];
  for (const post of (Array.isArray(older) ? older : []).concat(Array.isArray(newer) ? newer : [])) {
    if (!post || typeof post.id !== "string" || !post.id) continue;
    if (!byId.has(post.id)) order.push(post.id);
    byId.set(post.id, post);
  }
  return order.map(function (id, index) { return { post: byId.get(id), index: index }; })
    .sort(function (left, right) {
      return String(left.post.createdAt || "").localeCompare(String(right.post.createdAt || "")) || left.index - right.index;
    })
    .map(function (item) { return item.post; });
}

// A reply's steps as the sessions view shows them (shared/sessionsActivity.ts),
// made short by the server: one row each, the newest last, and how many
// earlier ones were left out.
const SESSIONS_ACTIVITY_KINDS = new Set(["thinking", "web", "shell", "read", "edit", "tool", "status"]);

function activityOfEvent(event) {
  if (!event || !Array.isArray(event.activity)) return {};
  const activity = event.activity.filter(function (row) {
    return row && SESSIONS_ACTIVITY_KINDS.has(row.kind) && typeof row.text === "string" && row.text.trim();
  }).slice(-24).map(function (row) { return { kind: row.kind, text: row.text.slice(0, 200), ...(row.folded === true ? { folded: true } : {}) }; });
  if (activity.length === 0) return {};
  const more = Number.isFinite(event.activityMore) && event.activityMore > 0 ? Math.floor(event.activityMore) : 0;
  return more > 0 ? { activity: activity, activityMore: more } : { activity: activity };
}

export function activitySignature(entry) {
  return entry && Array.isArray(entry.activity) && entry.activity.length
    ? JSON.stringify([entry.activity, entry.activityMore || 0])
    : "";
}

export function interimPostsSignature(entry) {
  return entry && Array.isArray(entry.interimPosts)
    ? entry.interimPosts.map(function (post) { return post.id; }).join(",")
    : "";
}

export function syncInterimPosts(copy, content, entry) {
  const posts = Array.isArray(entry.interimPosts) ? entry.interimPosts : [];
  let node = Array.from(copy.children).find(function (child) { return child.classList.contains("message-interim-posts"); });
  if (posts.length === 0) {
    node?.remove();
    return;
  }
  if (!node) {
    node = document.createElement("div");
    node.className = "message-interim-posts";
  }
  if (node.nextSibling !== content) copy.insertBefore(node, content);
  const signature = interimPostsSignature(entry);
  if (node.dataset.signature === signature) return;
  node.dataset.signature = signature;
  node.textContent = "";
  for (const post of posts) {
    const item = document.createElement("div");
    item.className = "message-content message-interim-post";
    renderMessageContentIfChanged(item, post.content, entry.author);
    node.append(item);
  }
}

/** A member request as the server sent it (mobileTimeline.ts
 *  MobileTaskBatch), only what is well formed. */
export function isProviderKind(value) {
  return value === "codex-cli" || value === "claude-code" || value === "gemini-cli";
}

function taskBatchOfEvent(event) {
  const batch = event && event.participantRequest;
  if (!batch || typeof batch !== "object" || typeof batch.id !== "string" || typeof batch.requesterParticipantId !== "string" ||
    !Array.isArray(batch.items)) {
    return {};
  }
  const text = function (value) { return typeof value === "string" ? value : ""; };
  const items = batch.items.filter(function (item) {
    return item && typeof item.targetParticipantId === "string" && item.targetParticipantId && typeof item.status === "string";
  }).slice(0, 24).map(function (item) {
    return {
      targetParticipantId: item.targetParticipantId,
      targetHandle: text(item.targetHandle),
      prompt: text(item.prompt),
      // Its short title when the main session gave it: only that title
      // names the member, as on the desktop (shared titleTaskByMember); a
      // follow-up's is made again from its text. A server from before
      // does not say which, so its title is kept.
      ...(typeof item.title === "string" && item.title && item.titled !== false ? { title: item.title } : {}),
      status: item.status,
      createdAt: text(item.createdAt),
      ...(typeof item.updatedAt === "string" && item.updatedAt ? { updatedAt: item.updatedAt } : {}),
      ...(typeof item.replyMessageId === "string" && item.replyMessageId ? { replyMessageId: item.replyMessageId } : {}),
      ...(typeof item.error === "string" && item.error ? { error: item.error } : {}),
      // The member's provider when the task was given: its logo once it
      // has left the chat.
      ...(isProviderKind(item.targetKind) ? { targetKind: item.targetKind } : {})
    };
  });
  if (items.length === 0) return {};
  return { participantRequest: {
    id: batch.id,
    requesterParticipantId: batch.requesterParticipantId,
    requesterHandle: text(batch.requesterHandle),
    resumeRequester: batch.resumeRequester !== false,
    ...(typeof batch.autoResumeMessageId === "string" && batch.autoResumeMessageId ? { autoResumeMessageId: batch.autoResumeMessageId } : {}),
    items: items
  } };
}

export async function handleRelayTimelinePayload(payload, fallbackConversationId, options) {
  if (payload?.type !== "mobile.timeline.events" || !Array.isArray(payload.events)) {
    return 0;
  }
  // Never the chat that happens to be open: a batch that does not say which
  // conversation it belongs to used to be filed under whatever the user was
  // looking at, which is how another chat's messages appeared in this one.
  const conversationId = payload.conversationId || fallbackConversationId;
  if (!conversationId) {
    return 0;
  }
  // Only the answer to a direct request says where this chat's history
  // stops; batches that arrive on their own (live progress) carry no page
  // and leave the stored cursor alone. Handled here rather than by the
  // requester, so the rows never arrive without their cursor.
  if (payload.page && typeof payload.page === "object") {
    await adoptTimelinePage(conversationId, payload);
  }
  let stored = 0;
  let changed = 0;
  // Only a tap on the chat opens it: a chat restored at launch was not
  // opened this time, and what came while the app was closed stays news.
  const opening = Boolean(options && options.opening);
  const openedAt = opening && typeof options.openedAt === "string" ? options.openedAt : undefined;
  // Cards are drawn now, but a batch that carries only cards is not news
  // the chat is marked unread for: the refresh the desktop sends after the
  // phone's own answer, and a card it closes, put an unread dot and a
  // number on the icon for a chat nothing was said in.
  if (Array.isArray(payload.cards) && storeControlCards(conversationId, payload.cards)) {
    stored += 1;
  }
  for (const event of payload.events) {
    if (!event || typeof event !== "object") {
      continue;
    }
    const id = typeof event.id === "string" && event.id.trim() ? event.id : createEventId();
    const content = typeof event.content === "string" ? event.content.trim() : "";
    const attachments = timelineAttachmentsFromEvent(event);
    const interimPosts = event.role === "participant" ? interimPostsOfEvent(event) : {};
    const activity = event.role === "participant" ? activityOfEvent(event) : {};
    const compaction = compactionOfEvent(event);
    // A picture with no caption is still a message. Requiring text dropped it.
    if (!content && attachments.length === 0) {
      // A turn that ended with nothing to say travels hidden and empty: it
      // still ends its run below, and no bubble is stored for it.
      const endsRunUnseen = event.hidden === true && (event.status === "done" || event.status === "error");
      // A reply whose words all went out as posts during its turn shows them;
      // a part of a turn her next message joined shows its steps; a
      // compaction's line travels with no words of its own.
      if (!endsRunUnseen && !compaction && !interimPosts.interimPosts && !(event.turnContinues === true && activity.activity)) {
        continue;
      }
    }
    const status = event.status === "error" ? "error" : event.status === "done" ? "done" : "pending";
    const runId = typeof event.runId === "string" ? event.runId : undefined;
    const mobileEventId = typeof event.mobileEventId === "string" ? event.mobileEventId : undefined;
    const createdAt = typeof event.createdAt === "string" ? event.createdAt : nowIso();
    const role = event.role === "you" ? "you" : event.role === "system" ? "system" : "participant";
    // W-N: only the agent's own finished message ends the agent's run. A
    // message sent from this phone comes back in the next conversation
    // snapshot as "done" and carries the run's identity — the run is named
    // after it (`mobile-<eventId>`, same mobileEventId) — so treating any
    // non-pending event as terminal deleted the in-progress row about a
    // second after it appeared, and blacklisted the run so it never returned.
    const messageId = typeof event.messageId === "string" && event.messageId.trim() ? event.messageId.trim() : id;
    // A page of earlier history is a record, not a run ending: it must not
    // clear anything pending now, nor crowd the recent runs out of the
    // terminal bookkeeping, which is bounded.
    const historyPage = Boolean(options && options.historyPage) || Boolean(payload.page && payload.page.earlier === true);
    // When this phone watched the run end live (from the open chat), it notes when:
    // the message keeps the time the run started, and Activity lists an
    // update by when it finished. A backlog drained later carries no such
    // moment, so it keeps the desktop's stamp.
    let settledAt;
    // A member's post during its turn (its reply tool) is not the end of
    // the turn: the turn's own row stays running, and nothing of the run is
    // settled or barred from coming back. A server that does not mark posts
    // yet leaves this as it was.
    const midTurnPost = event.midTurn === true && status === "done";
    if (!historyPage && !midTurnPost && status !== "pending" && role === "participant" && (runId || mobileEventId || messageId)) {
      const cleared = await deletePendingTimelineEntriesForRun(conversationId, runId, mobileEventId, messageId, status);
      if (cleared > 0 && status === "done" && options && options.live) settledAt = nowIso();
      rememberTerminalRun(runId, mobileEventId, createdAt);
      await deleteStalePlaceholderTimelineEntries(conversationId, createdAt, historyPage ? undefined : payload.events);
    }
    if (!historyPage && status === "pending" && isSupersededPendingEvent(runId, mobileEventId, createdAt)) {
      continue;
    }
    // What the desktop keeps off its timeline travels only to end a run:
    // the bookkeeping above ran, and no bubble is stored for it. It counts
    // as handled so the settled row is drawn now, not on the next batch. A
    // copy stored before the desktop hid it (an older shell, a page read
    // that could not see the row's trigger) goes with it.
    if (event.hidden === true) {
      // A chat being opened on this message lands at its end instead: the
      // message has nothing to show, and reading earlier pages for it would
      // find nothing.
      if (openChatState.pendingMessageFocus && openChatState.pendingMessageFocus.conversationId === conversationId && openChatState.pendingMessageFocus.messageId === messageId) {
        openChatState.pendingMessageFocus = undefined;
      }
      if (await deleteTimelineEntry(conversationId ? conversationId + ":" + id : id)) {
        changed += 1;
      }
      stored += 1;
      continue;
    }
    // A note the User took away here stays away while the server has not
    // taken the removal yet.
    if (role === "system" && event.finishedNote && dismissedFinishedNotes.has(conversationId + ":" + id)) {
      continue;
    }
    const written = await putTimelineEntryDeduped({
      id: conversationId ? conversationId + ":" + id : id,
      sourceId: id,
      conversationId,
      role,
      participantLabel: typeof event.participantLabel === "string" ? event.participantLabel : undefined,
      content,
      attachments: attachments.length > 0 ? attachments : undefined,
      status,
      createdAt,
      runId,
      messageId: typeof event.messageId === "string" ? event.messageId : undefined,
      threadRootId: typeof event.threadRootId === "string" && event.threadRootId.trim()
        ? event.threadRootId
        : undefined,
      mobileEventId,
      // Who wrote it and in which thread: what the phone resolves an
      // unaddressed message to the member that spoke last by.
      ...(typeof event.participantId === "string" && event.participantId ? { participantId: event.participantId } : {}),
      ...(typeof event.threadId === "string" && event.threadId ? { threadId: event.threadId } : {}),
      // The message a member's turn answers: with its run and member, what
      // a Stop names the turn on the server by.
      ...(typeof event.sourceMessageId === "string" && event.sourceMessageId ? { sourceMessageId: event.sourceMessageId } : {}),
      // A turn-finished note: the reply it leads back to.
      ...(role === "system" ? finishedNoteOfEvent(event) : {}),
      // An urgent alert a member raised, as the server keeps it.
      ...(event.urgentAlert && typeof event.urgentAlert.id === "string" ? { urgentAlert: event.urgentAlert } : {}),
      // An artifact note filed under an Accord: the launch whose card shows it.
      ...(role === "system" && typeof event.accordLaunchMessageId === "string" && event.accordLaunchMessageId
        ? { accordLaunchMessageId: event.accordLaunchMessageId } : {}),
      // The line a closed Accord left: the phone draws its card there.
      ...(role === "system" && event.accordClosed && typeof event.accordClosed.launchMessageId === "string" && event.accordClosed.launchMessageId
        ? { accordClosed: { launchMessageId: event.accordClosed.launchMessageId, ...(typeof event.accordClosed.title === "string" ? { title: event.accordClosed.title } : {}) } } : {}),
      // A compaction's line: the sessions view shows it in that member's session.
      ...(compaction ? { compaction: compaction } : {}),
      // Who leads that Accord and who is in it: its card without its launch.
      ...(role === "system" && event.accordLaunch && typeof event.accordLaunch.facilitator === "string" && Array.isArray(event.accordLaunch.members)
        ? { accordLaunch: { facilitator: event.accordLaunch.facilitator, members: event.accordLaunch.members.filter(function (member) { return typeof member === "string"; }) } }
        : {}),
      // The User's message: where each turn it asked for stands.
      ...(role === "you" && Array.isArray(event.turns) ? { turns: event.turns.filter(function (turn) {
        return turn && typeof turn.participantId === "string" && typeof turn.runId === "string" && typeof turn.state === "string";
      }).map(function (turn) { return { participantId: turn.participantId, runId: turn.runId, state: turn.state }; }) } : {}),
      // The User's message: the members it was for, which the sessions view
      // places it by.
      ...(role === "you" && Array.isArray(event.addressees) ? { addressees: event.addressees.filter(function (id) {
        return typeof id === "string" && id;
      }).slice(0, 16) } : {}),
      // A member's request: its task card and the members list read it.
      ...(role === "participant" ? taskBatchOfEvent(event) : {}),
      ...interimPosts,
      // Its steps, as the sessions view's rows show them, and whether its
      // live text is where the run stands rather than words of the reply.
      ...activity,
      ...(role === "participant" && status === "pending" && event.liveStatus === true ? { liveStatus: true } : {}),
      // Waiting behind its member's turn before it, or when its own run
      // began: its "Queued", and where its "Working for …" counts from.
      ...(role === "participant" && status === "pending" && event.queued === true ? { queued: true } : {}),
      ...(role === "participant" && status === "pending" && typeof event.startedAt === "string" && !Number.isNaN(Date.parse(event.startedAt))
        ? { startedAt: event.startedAt } : {}),
      // An Accord the main session started: its card, like the User's own.
      ...(role === "participant" && event.accordLaunchByMainSession === true ? { accordLaunchByMainSession: true } : {}),
      // How long the turn worked: the sessions view's "Worked for …".
      ...(role === "participant" && typeof event.workedMs === "number" && Number.isFinite(event.workedMs) && event.workedMs >= 0
        ? { workedMs: event.workedMs } : {}),
      // A part of a turn her next message joined: no Worked for, its steps open.
      ...(role === "participant" && event.turnContinues === true ? { turnContinues: true } : {}),
      // A reply stopped before its member finished (a Stop, a quit).
      ...(role === "participant" && status === "error" && event.stopped === true ? { stopped: true } : {}),
      ...(settledAt ? { settledAt: settledAt } : {})
    }, openedAt ? { arrivedAt: openedAt } : undefined);
    if (written) {
      changed += 1;
    }
    stored += 1;
  }
  // Turn-finished notes taken away on any device, as the newest page names
  // them: the copies kept here go too. Not news.
  if (Array.isArray(payload.removedNoteIds)) {
    stored += await dropRemovedFinishedNotes(conversationId, payload.removedNoteIds);
  }
  // News for a chat that is not on screen — or is, behind a locked screen —
  // is unread, the way the desktop marks a chat it is not showing. The
  // phone's own message echoed back is news too; the desktop treats it so.
  const historyBatch = Boolean(options && options.historyPage) || Boolean(payload.page && payload.page.earlier === true);
  // The page a chat is opened with is what the User opened it to read, not
  // news, even when it lands after she has left it again: its rows count
  // as come and seen when she opened the chat. What came after that is
  // still news, and the chat list says so.
  if (opening && openedAt && changed > 0 && (conversationId !== selectedConversationId() || document.hidden)) {
    markConversationViewed(conversationId, openedAt, openedAt);
  }
  if (changed > 0 && !historyBatch && !opening && (conversationId !== selectedConversationId() || document.hidden)) {
    markConversationsUnread([conversationId]);
  }
  // For the QA harness: a page answered, and whether it was news.
  if (payload.page) recordRelayDebug({ event: "timeline-page", conversationId: conversationId, opening: opening, changed: changed });
  if (changed > 0 && !historyBatch) {
    refreshChatListSoon(conversationId);
  }
  if (stored > 0 && !(options && options.deferRender)) {
    await render("synced");
  }
  return stored;
}

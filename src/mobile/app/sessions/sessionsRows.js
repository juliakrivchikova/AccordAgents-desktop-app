import { render } from "../chat/render.js";
import { isWaitingReplyRow, waitingMessagesOf } from "../chat/waitingMessage.js";
import { selectedConversationId } from "../chats/openChat.js";
import { memberLocationLabel } from "../members/membersSheet.js";
import { enqueueTurnStop, sendNow, stopRequestedRunIds, turnOfRun } from "../outbox/sending.js";
import { recordSendFailure } from "../outbox/sendLog.js";
import {
  openTaskFolds, openWorkedFolds, sessionsCanStop, sessionsDelegationsOf, sessionsMemberDetailOf, sessionsMemberName,
  sessionsMemberSince, sessionsMemberTitleOf, sessionsRules, sessionsStateState, sessionsStopping
} from "./sessionsState.js";

/** The rows of the main timeline (shared/mainSession.ts mainTimelineMessages):
 *  the User's messages to the main session, the main session's replies
 *  with the tasks each turn gave inside its "Worked for …", what has no
 *  member (system lines) and the members' choices still waiting for the
 *  User. No avatars, threads or handles. */
export function sessionsMainRows(state) {
  const shared = sessionsRules();
  const rows = [];
  const waiting = waitingMessagesOf(state.messages, state.mainId);
  state.rows.forEach(function (row, position) {
    const message = state.messages[position];
    if (isWaitingReplyRow(message)) return;
    const base = { ...row, presentation: "sessions", replyCount: undefined };
    if (state.openCardIds.has(message.id)) {
      const member = state.members.find(function (candidate) { return candidate.id === row.participantId; });
      rows.push({ ...base, memberChoice: { participantId: row.participantId || "", name: sessionsMemberName(member, row.participantLabel), kind: member ? member.kind : "" } });
      return;
    }
    if (!state.mainIds.has(message.id) || state.placement.placedTaskIds.has(message.id)) return;
    if (shared.isMainSessionTaskMessage(message, state.index)) {
      // A task its turn's reply does not hold: its rows on their own.
      rows.push({ ...base, delegations: { standalone: true, entries: sessionsDelegationsOf(state, message) } });
      return;
    }
    if (row.author === "you") {
      base.content = shared.withoutLeadingMention(String(row.content || ""), state.mainHandle);
      base.waiting = waiting.get(message.id);
    }
    const tasks = state.placement.tasksByReplyId.get(message.id);
    // A part of a turn her next message joined, with nothing in it, is not
    // drawn (as in the CLI's transcript).
    if (row.turnContinues && !tasks && !String(row.content || "").trim() && !(Array.isArray(row.activity) && row.activity.length) &&
      !(Array.isArray(row.interimPosts) && row.interimPosts.length)) return;
    if (tasks && row.author === "agent") {
      const key = row.rowKey || row.id;
      const live = row.status === "Running";
      const continued = Boolean(row.turnContinues) && !live;
      base.delegations = {
        key: key, live: live, continued: continued, open: live || continued || openWorkedFolds.has(key),
        workedMs: typeof row.workedMs === "number" ? row.workedMs : undefined,
        // A finished turn's steps, which its fold opens to with its tasks
        // (while it runs they are under its "Working for …").
        ...(!live && Array.isArray(row.activity) && row.activity.length ? { activity: row.activity, activityMore: row.activityMore || 0 } : {}),
        summary: shared.sessionsDelegationSummary(tasks.reduce(function (count, task) {
          return count + (task.metadata.participantRequest ? task.metadata.participantRequest.items.length : 0);
        }, 0)),
        entries: tasks.flatMap(function (task) { return sessionsDelegationsOf(state, task); })
      };
    }
    rows.push(base);
  });
  return rows;
}

/** One member's whole session: what it was asked (its task folded to one
 *  line), its messages, the main session's answers to its questions and
 *  the User's messages to it, under a line saying what it does now. A
 *  member that has left the chat reads the same, without Stop. */
export function sessionsMemberSessionRows(state, member) {
  const shared = sessionsRules();
  const participantId = member.id;
  const ids = new Set(shared.memberSessionMessages(state.messages, participantId, state.index).map(function (message) { return message.id; }));
  const task = state.tasksByMember.get(participantId);
  const status = member.former ? shared.sessionsFormerMemberStatus(task ? task.item : undefined)
    : shared.sessionsMemberStatus(state.statusById.get(participantId), task ? task.item : undefined, state.activity.finishedAt.get(participantId),
      Boolean(state.waitingForUser && state.waitingForUser.has(participantId)));
  const rows = [{
    rowKey: "member-session-head\u0000" + participantId, id: "member-session-head", conversationId: state.conversationId, author: "system",
    status: "Done", content: "", createdAt: "", presentation: "sessions",
    memberHead: {
      participantId: participantId,
      kind: member.kind || "",
      detail: sessionsMemberDetailOf(member),
      location: member.former ? "" : memberLocationLabel(member),
      status: status,
      since: status === "running" ? sessionsMemberSince(state, participantId) : undefined,
      canStop: !member.former && sessionsCanStop(state, [participantId]),
      stopping: !member.former && sessionsStopping(state, [participantId])
    }
  }];
  let shown = 0;
  const waiting = waitingMessagesOf(state.messages, participantId);
  state.rows.forEach(function (drawn, position) {
    const message = state.messages[position];
    if (!ids.has(message.id)) return;
    shown += 1;
    if (isWaitingReplyRow(message)) return;
    const batch = message.metadata.participantRequest;
    const given = batch && batch.requesterParticipantId !== participantId
      ? batch.items.find(function (item) { return item.targetParticipantId === participantId; })
      : undefined;
    // A question this member asked the main session reads alone, as on the
    // desktop: the main session is named by nothing.
    const asksMain = batch && batch.requesterParticipantId === participantId && typeof shared.withoutLeadingMention === "function";
    const base = { ...drawn, presentation: "sessions", replyCount: undefined,
      ...(drawn.author === "you" ? { waiting: waiting.get(message.id) } : {}),
      ...(asksMain ? { content: shared.withoutLeadingMention(String(drawn.content || ""), state.mainHandle) } : {}) };
    if (given) {
      const key = drawn.rowKey || drawn.id;
      rows.push({ ...base, taskFold: {
        label: batch.requesterParticipantId === state.mainId ? "Task" : "Task from " + sessionsMemberTitleOf(state, batch.requesterParticipantId),
        // The main session's words, by the view's mention rule.
        preview: state.viewNames && typeof shared.sessionsMentionText === "function"
          ? shared.sessionsMentionText(shared.firstTextLine(given.prompt), state.viewNames) : shared.firstTextLine(given.prompt),
        open: openTaskFolds.has(key)
      } });
      return;
    }
    // The main session's answer here is told apart by its provider's logo,
    // named by nothing.
    rows.push(drawn.author === "agent" && drawn.participantId === state.mainId ? { ...base, authorKind: state.mainMember ? state.mainMember.kind || "unknown" : "unknown" } : base);
  });
  if (shown === 0) {
    rows.push({ rowKey: "member-session-empty", id: "member-session-empty", conversationId: state.conversationId, author: "system",
      status: "Done", content: "", createdAt: "", presentation: "sessions", sessionsEmpty: "Nothing in this session yet." });
  }
  return rows;
}

/** Stops every running turn of these members, each named to the server as
 *  a Stop from a row names it; one send for all of them. */
export async function stopMembersFromPhone(participantIds) {
  const conversationId = selectedConversationId();
  const state = sessionsStateState.lastSessionsState;
  if (!conversationId || !state || state.conversationId !== conversationId) return;
  const runs = participantIds.flatMap(function (id) { return state.runsByMember.get(id) || []; }).filter(function (run) {
    return !run.stopRequested && !stopRequestedRunIds.has(run.runId);
  });
  if (runs.length === 0) return;
  for (const run of runs) stopRequestedRunIds.add(run.runId);
  await render();
  for (const run of runs) {
    const turn = await turnOfRun(conversationId, run.runId, { messageId: run.messageId, participantId: run.participantId });
    if (!turn) {
      stopRequestedRunIds.delete(run.runId);
      await recordSendFailure({
        conversationId: conversationId, kind: "turn.stop", text: "Stop", cause: "phone",
        reason: "This phone does not know which message this run answers, so it could not name it to your server."
      });
      continue;
    }
    await enqueueTurnStop({ conversationId: conversationId, runId: turn.runId, rowRunId: turn.rowRunId, messageId: turn.messageId, participantId: turn.participantId });
  }
  await sendNow();
}

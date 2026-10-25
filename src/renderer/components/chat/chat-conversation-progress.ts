import type {
  AgentRunProgress,
  ChatAgentActivityEvent,
  ChatAppToolApproval,
  ChatMessage,
  ReviewProgress
} from "../../../shared/types";

export interface ChatThinkingRow {
  key: string;
  runId: string;
  participantId?: string;
  participantLabel: string;
  activity?: string;
  activityEvents?: ChatAgentActivityEvent[];
  startedAt: string;
  updatedAt: string;
}

export type ChatTimelineRow =
  | { type: "load-older"; id: string }
  | { type: "message"; id: string; message: ChatMessage }
  | { type: "approval"; id: string; approval: ChatAppToolApproval }
  | { type: "thinking"; id: string; row: ChatThinkingRow };

/**
 * The rows of the main timeline: messages and resolved approval cards in time
 * order, the "Load older messages" row first while older messages exist, and the
 * thinking rows last while a run is active.
 *
 * Approvals come from chat metadata, which holds all of them, while messages are
 * a window of the newest pages. An approval older than the oldest loaded message
 * belongs to a page that is not loaded yet; it stays out until that page loads.
 * Otherwise every such card was stacked at the top of the window, out of its
 * place in time, and each older page then had to be slotted in above and between
 * them, reshuffling what the User was looking at.
 */
export function chatTimelineRows(input: {
  hasOlderMessages: boolean;
  olderMessagesLoading: boolean;
  isRunning: boolean;
  loadedMessages: readonly ChatMessage[];
  topLevelMessages: readonly ChatMessage[];
  resolvedApprovals: readonly ChatAppToolApproval[];
  thinkingRows: readonly ChatThinkingRow[];
}): ChatTimelineRow[] {
  const rows: ChatTimelineRow[] = [];
  const windowed = input.hasOlderMessages || input.olderMessagesLoading;
  if (windowed) {
    rows.push({ type: "load-older", id: "load-older" });
  }
  let loadedFrom: string | undefined;
  if (input.hasOlderMessages) {
    for (const message of input.loadedMessages) {
      if (loadedFrom === undefined || message.createdAt < loadedFrom) {
        loadedFrom = message.createdAt;
      }
    }
  }
  const entries: Array<{ createdAt: string; row: ChatTimelineRow }> = [
    ...input.topLevelMessages.map((message) => ({ createdAt: message.createdAt, row: { type: "message" as const, id: message.id, message } })),
    ...input.resolvedApprovals
      .filter((approval) => loadedFrom === undefined || approval.createdAt >= loadedFrom)
      .map((approval) => ({ createdAt: approval.createdAt, row: { type: "approval" as const, id: approval.id, approval } }))
  ];
  entries.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  rows.push(...entries.map((entry) => entry.row));
  if (input.isRunning) {
    rows.push(...input.thinkingRows.map((row) => ({ type: "thinking" as const, id: row.key, row })));
  }
  return rows;
}

export function chatThinkingRows(progress: ReviewProgress[]): ChatThinkingRow[] {
  const rows = new Map<string, ChatThinkingRow>();
  for (const item of progress) {
    if (item.phase === "done" || item.phase === "cancelled" || item.phase === "error") {
      for (const [key, row] of rows) {
        if (row.runId === item.runId) {
          rows.delete(key);
        }
      }
      continue;
    }
    const agentProgress = item.agentProgress;
    if (!agentProgress || agentProgress.messageId) {
      continue;
    }
    const participantLabel = agentProgress.participantLabel || item.participantLabel || "Agent";
    const key = `${item.runId}:${agentProgress.participantId || participantLabel}`;
    if (agentProgress.state === "finished") {
      rows.delete(key);
      continue;
    }
    const current = rows.get(key);
    rows.set(key, {
      key,
      runId: item.runId,
      participantId: agentProgress.participantId ?? current?.participantId,
      participantLabel,
      activity: agentProgress.activity?.trim() || current?.activity,
      activityEvents: agentProgress.activityEvents ?? current?.activityEvents,
      startedAt: current?.startedAt ?? item.createdAt,
      updatedAt: item.createdAt
    });
  }
  return Array.from(rows.values()).sort((left, right) => left.startedAt.localeCompare(right.startedAt));
}

export function liveMessageProgressById(progress: ReviewProgress[]): Map<string, AgentRunProgress> {
  const map = new Map<string, AgentRunProgress>();
  const runIdsByMessageId = new Map<string, string>();
  for (const item of progress) {
    if (item.phase === "done" || item.phase === "cancelled" || item.phase === "error") {
      for (const [messageId, runId] of runIdsByMessageId) {
        if (runId === item.runId) {
          map.delete(messageId);
          runIdsByMessageId.delete(messageId);
        }
      }
      continue;
    }
    const agentProgress = item.agentProgress;
    if (!agentProgress?.messageId) {
      continue;
    }
    if (agentProgress.state === "finished") {
      map.delete(agentProgress.messageId);
      runIdsByMessageId.delete(agentProgress.messageId);
      continue;
    }
    map.set(agentProgress.messageId, agentProgress);
    runIdsByMessageId.set(agentProgress.messageId, item.runId);
  }
  return map;
}

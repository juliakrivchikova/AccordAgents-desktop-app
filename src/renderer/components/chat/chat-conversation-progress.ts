import type {
  AgentRunProgress,
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
  startedAt: string;
  updatedAt: string;
}

export type ChatTimelineRow =
  | { type: "load-older"; id: string }
  | { type: "message"; id: string; message: ChatMessage }
  | { type: "approval"; id: string; approval: ChatAppToolApproval }
  | { type: "thinking"; id: string; row: ChatThinkingRow };

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

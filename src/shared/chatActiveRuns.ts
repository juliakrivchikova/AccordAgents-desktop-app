import { readActiveRunParticipants } from "./chatRunState";
import type { Conversation } from "./types";

export interface ActiveChatRunSummary {
  runIds: string[];
  participantIdsByRunId: Map<string, string>;
  runIdsByParticipantId: Map<string, string[]>;
  participantIds: string[];
  unresolvedRunIds: string[];
}

type ConversationRunState = Pick<Conversation, "metadata" | "messages">;

export function activeRunIdsForConversation(conversation: ConversationRunState): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const addRunId = (value: unknown): void => {
    const id = typeof value === "string" ? value.trim() : "";
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  };

  const active = conversation.metadata.activeRunIds;
  if (Array.isArray(active)) {
    for (const id of active) {
      addRunId(id);
    }
  }

  addRunId(conversation.metadata.runId);

  // Pending participant messages are intentionally included so the composer pill
  // remains visible while a legacy or partially-hydrated run is still streaming.
  for (const message of conversation.messages) {
    if (message.role === "participant" && message.status === "pending") {
      addRunId(message.metadata?.runId);
    }
  }

  return ids;
}

export function activeRunSummaryForConversation(conversation: ConversationRunState): ActiveChatRunSummary {
  const runIds = activeRunIdsForConversation(conversation);
  const liveRunIds = new Set(runIds);
  const participantIds = chatParticipantIds(conversation);
  const participantIdsByRunId = new Map<string, string>();

  const setParticipant = (runId: string, participantId: string): void => {
    if (!liveRunIds.has(runId) || participantIdsByRunId.has(runId) || !participantIds.has(participantId)) {
      return;
    }
    participantIdsByRunId.set(runId, participantId);
  };

  for (const [runId, participantId] of readActiveRunParticipants(conversation.metadata)) {
    setParticipant(runId, participantId);
  }

  for (const [runId, participantId] of activeRemoteRunParticipants(conversation.metadata, liveRunIds)) {
    setParticipant(runId, participantId);
  }

  for (const message of conversation.messages) {
    if (message.role !== "participant" || message.status !== "pending" || !message.participantId) {
      continue;
    }
    const runId = typeof message.metadata?.runId === "string" ? message.metadata.runId.trim() : "";
    if (runId) {
      setParticipant(runId, message.participantId);
    }
  }

  const seenParticipantIds = new Set<string>();
  const activeParticipantIds: string[] = [];
  const runIdsByParticipantId = new Map<string, string[]>();
  const unresolvedRunIds: string[] = [];
  for (const runId of runIds) {
    const participantId = participantIdsByRunId.get(runId);
    if (!participantId) {
      unresolvedRunIds.push(runId);
      continue;
    }
    runIdsByParticipantId.set(participantId, [
      ...(runIdsByParticipantId.get(participantId) ?? []),
      runId
    ]);
    if (!seenParticipantIds.has(participantId)) {
      seenParticipantIds.add(participantId);
      activeParticipantIds.push(participantId);
    }
  }

  return {
    runIds,
    participantIdsByRunId,
    runIdsByParticipantId,
    participantIds: activeParticipantIds,
    unresolvedRunIds
  };
}

function chatParticipantIds(conversation: Pick<Conversation, "metadata">): Set<string> {
  const participants = conversation.metadata.participants;
  const ids = new Set<string>();
  if (!Array.isArray(participants)) {
    return ids;
  }
  for (const item of participants) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const id = (item as { id?: unknown }).id;
    if (typeof id === "string" && id.trim()) {
      ids.add(id);
    }
  }
  return ids;
}

function activeRemoteRunParticipants(metadata: Record<string, unknown>, liveRunIds: Set<string>): Map<string, string> {
  const handles = metadata.remoteRunHandles;
  const participants = new Map<string, string>();
  if (!handles || typeof handles !== "object" || Array.isArray(handles)) {
    return participants;
  }
  for (const [runId, raw] of Object.entries(handles as Record<string, unknown>)) {
    if (!liveRunIds.has(runId) || !raw || typeof raw !== "object" || Array.isArray(raw)) {
      continue;
    }
    const record = raw as Record<string, unknown>;
    if (record.status === "completed" || record.status === "failed" || record.status === "cancelled") {
      continue;
    }
    const participantId = typeof record.participantId === "string" ? record.participantId.trim() : "";
    if (participantId) {
      participants.set(runId, participantId);
    }
  }
  return participants;
}

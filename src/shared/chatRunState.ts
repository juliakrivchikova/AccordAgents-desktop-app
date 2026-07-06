import type { ChatParticipantCompactionState } from "./types";

const PARTICIPANT_COMPACTIONS_KEY = "participantCompactionsByParticipantId";
const ACTIVE_RUN_OWNERS_KEY = "activeRunOwnersByRunId";
const ACTIVE_RUN_PARTICIPANTS_KEY = "activeRunParticipantIdsByRunId";

export function clearChatRunMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...metadata, running: false };
  delete next.runId;
  delete next.activeRunIds;
  delete next[ACTIVE_RUN_OWNERS_KEY];
  delete next[ACTIVE_RUN_PARTICIPANTS_KEY];
  return next;
}

export function readActiveRunIds(metadata: Record<string, unknown>): string[] {
  const raw = metadata.activeRunIds;
  if (!Array.isArray(raw)) {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.trim() && !seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

export function withActiveRunIdAdded(metadata: Record<string, unknown>, runId: string): Record<string, unknown> {
  const list = readActiveRunIds(metadata);
  if (list.includes(runId)) {
    return { ...metadata, activeRunIds: list, running: true };
  }
  return { ...metadata, activeRunIds: [...list, runId], running: true };
}

export function withActiveRunIdRemoved(metadata: Record<string, unknown>, runId: string): Record<string, unknown> {
  const list = readActiveRunIds(metadata).filter((id) => id !== runId);
  const next: Record<string, unknown> = { ...metadata, activeRunIds: list };
  const participants = readActiveRunParticipants(metadata);
  participants.delete(runId);
  next.running = list.length > 0;
  if (list.length === 0) {
    delete next.activeRunIds;
  }
  if (participants.size > 0) {
    next[ACTIVE_RUN_PARTICIPANTS_KEY] = Object.fromEntries(participants);
  } else {
    delete next[ACTIVE_RUN_PARTICIPANTS_KEY];
  }
  return next;
}

export function conversationIsRunning(metadata: Record<string, unknown>): boolean {
  if (readActiveRunIds(metadata).length > 0) {
    return true;
  }
  return metadata.running === true;
}

export function readActiveRunParticipants(metadata: Record<string, unknown>): Map<string, string> {
  const raw = metadata[ACTIVE_RUN_PARTICIPANTS_KEY];
  const participants = new Map<string, string>();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return participants;
  }
  for (const [runId, value] of Object.entries(raw as Record<string, unknown>)) {
    const participantId = typeof value === "string" ? value.trim() : "";
    if (runId.trim() && participantId) {
      participants.set(runId, participantId);
    }
  }
  return participants;
}

export function readParticipantCompactions(metadata: Record<string, unknown>): Record<string, ChatParticipantCompactionState> {
  const raw = metadata[PARTICIPANT_COMPACTIONS_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const out: Record<string, ChatParticipantCompactionState> = {};
  for (const [participantId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!participantId.trim() || !value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const record = value as Record<string, unknown>;
    const runId = typeof record.runId === "string" ? record.runId.trim() : "";
    const startedAt = typeof record.startedAt === "string" ? record.startedAt.trim() : "";
    if (runId && startedAt) {
      out[participantId] = { runId, startedAt };
    }
  }
  return out;
}

export function withParticipantCompactionStarted(
  metadata: Record<string, unknown>,
  participantId: string,
  runId: string,
  startedAt: string
): Record<string, unknown> {
  const id = participantId.trim();
  const compactRunId = runId.trim();
  const compactStartedAt = startedAt.trim();
  if (!id || !compactRunId || !compactStartedAt) {
    return metadata;
  }
  return {
    ...metadata,
    [PARTICIPANT_COMPACTIONS_KEY]: {
      ...readParticipantCompactions(metadata),
      [id]: {
        runId: compactRunId,
        startedAt: compactStartedAt
      }
    }
  };
}

export function withParticipantCompactionFinished(
  metadata: Record<string, unknown>,
  participantId: string,
  runId?: string
): Record<string, unknown> {
  const id = participantId.trim();
  if (!id) {
    return metadata;
  }
  const compacting = readParticipantCompactions(metadata);
  const current = compacting[id];
  if (!current || (runId && current.runId !== runId)) {
    return metadata;
  }
  delete compacting[id];
  const next: Record<string, unknown> = { ...metadata };
  if (Object.keys(compacting).length > 0) {
    next[PARTICIPANT_COMPACTIONS_KEY] = compacting;
  } else {
    delete next[PARTICIPANT_COMPACTIONS_KEY];
  }
  return next;
}

export function withParticipantCompactionsForRunRemoved(metadata: Record<string, unknown>, runId: string): Record<string, unknown> {
  const compactRunId = runId.trim();
  if (!compactRunId) {
    return metadata;
  }
  const compacting = readParticipantCompactions(metadata);
  let changed = false;
  for (const [participantId, state] of Object.entries(compacting)) {
    if (state.runId === compactRunId) {
      delete compacting[participantId];
      changed = true;
    }
  }
  if (!changed) {
    return metadata;
  }
  const next: Record<string, unknown> = { ...metadata };
  if (Object.keys(compacting).length > 0) {
    next[PARTICIPANT_COMPACTIONS_KEY] = compacting;
  } else {
    delete next[PARTICIPANT_COMPACTIONS_KEY];
  }
  return next;
}

export function clearParticipantCompactions(metadata: Record<string, unknown>): Record<string, unknown> {
  if (!(PARTICIPANT_COMPACTIONS_KEY in metadata)) {
    return metadata;
  }
  const next: Record<string, unknown> = { ...metadata };
  delete next[PARTICIPANT_COMPACTIONS_KEY];
  return next;
}

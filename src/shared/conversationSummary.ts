import type { ConversationSummaryChatParticipant } from "./types";

export function normalizeConversationSummaryChatParticipants(value: unknown): ConversationSummaryChatParticipant[] | undefined {
  const parsed = parseParticipantList(value);
  if (!Array.isArray(parsed)) {
    return undefined;
  }
  const participants: ConversationSummaryChatParticipant[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const handle = typeof record.handle === "string" ? record.handle.trim().replace(/^@/, "") : "";
    const kind = record.kind === "codex-cli" || record.kind === "claude-code" ? record.kind : undefined;
    if (!handle || !kind) {
      continue;
    }
    const participantConfigId = typeof record.participantConfigId === "string"
      ? record.participantConfigId.trim() || undefined
      : undefined;
    participants.push({
      ...(participantConfigId ? { participantConfigId } : {}),
      handle,
      kind
    });
  }
  return participants.length > 0 ? participants : undefined;
}

function parseParticipantList(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

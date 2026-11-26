import { isChatProviderKind } from "./chatProviders";
import { mainSessionMemberOf } from "./mainSession";
import type { ChatProviderKind, ConversationSummary, ConversationSummaryChatParticipant } from "./types";

/** An async list read can finish after a newer pushed outcome. Preserve any
 * chat changed since that read began, including additions, archive and removal. */
export function reconcileConversationSummaryRefresh(
  current: ConversationSummary[], incoming: ConversationSummary[],
  revisionsAtStart: Record<string, number>, revisionsNow: Record<string, number>
): ConversationSummary[] {
  const changed = (id: string): boolean => (revisionsNow[id] ?? 0) !== (revisionsAtStart[id] ?? 0);
  const currentById = new Map(current.map(summary => [summary.id, summary]));
  const result: ConversationSummary[] = [];
  const seen = new Set<string>();
  for (const summary of incoming) {
    seen.add(summary.id);
    const accepted = changed(summary.id) ? currentById.get(summary.id) : summary;
    if (accepted) result.push(accepted);
  }
  for (const summary of current) if (!seen.has(summary.id) && changed(summary.id)) result.push(summary);
  return result;
}

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
    const kind = isChatProviderKind(record.kind) ? record.kind : undefined;
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

/** The provider of the chat's main session among its stored members, found
 *  as `mainSessionMemberOf` finds it (by role; the one the chat names when
 *  there are more), for the chat list's glyph. */
export function conversationSummaryMainSessionKind(participants: unknown, namedId: unknown): ChatProviderKind | undefined {
  const parsed = parseParticipantList(participants);
  if (!Array.isArray(parsed)) {
    return undefined;
  }
  const members = parsed.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string") return [];
    return [{ id: record.id, roleConfigId: typeof record.roleConfigId === "string" ? record.roleConfigId : undefined, kind: record.kind }];
  });
  const kind = mainSessionMemberOf(members, typeof namedId === "string" ? namedId : undefined)?.kind;
  return isChatProviderKind(kind) ? kind : undefined;
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

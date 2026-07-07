import type { ChatParticipantConfig, ConversationSummary } from "../../../shared/types";
import type { AddableSavedParticipantConfig } from "./chat-participant-drafts";

export function sortSavedParticipantOptionsByUsage(
  options: AddableSavedParticipantConfig[],
  summaries: ConversationSummary[]
): AddableSavedParticipantConfig[] {
  if (options.length <= 1 || summaries.length === 0) {
    return options;
  }
  const usage = chatParticipantUsageCounts(summaries);
  return options
    .map((option, index) => ({
      option,
      index,
      count: savedParticipantUsageCount(option.config, usage)
    }))
    .sort((left, right) => (right.count - left.count) || (left.index - right.index))
    .map(({ option }) => option);
}

function chatParticipantUsageCounts(summaries: ConversationSummary[]): {
  byConfigId: Map<string, number>;
  byFallbackKey: Map<string, number>;
} {
  const byConfigId = new Map<string, number>();
  const byFallbackKey = new Map<string, number>();
  for (const summary of summaries) {
    if (summary.kind !== "chat" || !summary.chatParticipants) {
      continue;
    }
    for (const participant of summary.chatParticipants) {
      const participantConfigId = participant.participantConfigId?.trim();
      if (participantConfigId) {
        byConfigId.set(participantConfigId, (byConfigId.get(participantConfigId) ?? 0) + 1);
        continue;
      }
      const fallbackKey = savedParticipantFallbackKey(participant);
      byFallbackKey.set(fallbackKey, (byFallbackKey.get(fallbackKey) ?? 0) + 1);
    }
  }
  return { byConfigId, byFallbackKey };
}

function savedParticipantUsageCount(
  participant: ChatParticipantConfig,
  usage: { byConfigId: Map<string, number>; byFallbackKey: Map<string, number> }
): number {
  return (usage.byConfigId.get(participant.id) ?? 0) + (usage.byFallbackKey.get(savedParticipantFallbackKey(participant)) ?? 0);
}

function savedParticipantFallbackKey(participant: Pick<ChatParticipantConfig, "handle" | "kind">): string {
  return `${participant.kind}:${participant.handle.trim().replace(/^@/, "").toLowerCase()}`;
}

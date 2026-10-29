import type { ConversationSummary } from "../../../shared/types";
import { orderByParticipantUsage } from "../../../shared/newChat";
import type { AddableSavedParticipantConfig } from "./chat-participant-drafts";

export function sortSavedParticipantOptionsByUsage(
  options: AddableSavedParticipantConfig[],
  summaries: ConversationSummary[]
): AddableSavedParticipantConfig[] {
  return orderByParticipantUsage(options, (option) => option.config, summaries);
}

import type { Conversation } from "../../../shared/types";
import { visiblePlanDecisionRequests } from "./review-plan-decision-data";
import { timelineFindings } from "./review-plan-item-data";

export function threadExistsInConversation(conversation: Conversation, threadId: string): boolean {
  return (
    timelineFindings(conversation).some((finding) => finding.id === threadId) ||
    visiblePlanDecisionRequests(conversation).some((decision) => decision.id === threadId) ||
    conversation.messages.some((message) => message.metadata?.threadId === threadId || message.id === threadId)
  );
}

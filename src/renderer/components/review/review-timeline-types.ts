import type {
  Conversation,
  Finding,
  PlanDecisionRequest
} from "../../../shared/types";

export type TimelineItem =
  | { id: string; type: "message"; createdAt: string; message: Conversation["messages"][number] }
  | { id: string; type: "finding"; createdAt: string; finding: Finding }
  | { id: string; type: "decision"; createdAt: string; decision: PlanDecisionRequest };

export type SlackTimelineRow = { id: string; type: "load-older" } | TimelineItem;

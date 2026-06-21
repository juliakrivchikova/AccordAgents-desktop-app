import type {
  Conversation,
  ConversationKind,
  Finding,
  ReviewProgress
} from "../../../shared/types";
import { DEFAULT_NOTICE_CHARS, sanitizeWarningText } from "../../../shared/warnings";

export function pointStatus(finding: Finding): { kind: "confirmed" | "disputed" | "unresolved" | "filtered-out"; label: string } {
  if (finding.status === "Confirmed") {
    return { kind: "confirmed", label: "confirmed" };
  }
  if (finding.status === "Rejected") {
    return { kind: "filtered-out", label: "filtered out" };
  }
  const hasDispute = finding.rounds.some((round) => round.stance === "rejected" || round.stance === "originator-rebuttal" || round.stance === "final-resolution");
  return hasDispute ? { kind: "disputed", label: "disputed" } : { kind: "unresolved", label: "unresolved" };
}

export function liveProgressLabel(progress: ReviewProgress[]): string {
  const latest = progress[progress.length - 1];
  if (!latest) {
    return "Running";
  }
  const phase = phaseLabel(latest.phase);
  if (typeof latest.completed === "number" && typeof latest.total === "number" && latest.total > 0) {
    return `${phase}: ${latest.completed}/${latest.total} done`;
  }
  return phase;
}

export function displayNoticeText(content: string): string {
  return sanitizeWarningText(content, DEFAULT_NOTICE_CHARS);
}

export function mergeProgressIntoConversation(conversation: Conversation, _progress: ReviewProgress[]): Conversation {
  const messages = conversation.messages.filter((message) => !message.progressPhase);
  if (messages.length === conversation.messages.length) {
    return conversation;
  }
  return { ...conversation, messages };
}

export function conversationRelevantRunIds(conversation: Conversation): Set<string> {
  const ids = new Set<string>();
  const compatibilityRunId = metadataString(conversation.metadata.runId);
  if (compatibilityRunId) ids.add(compatibilityRunId);
  const active = conversation.metadata.activeRunIds;
  if (Array.isArray(active)) {
    for (const id of active) {
      if (typeof id === "string" && id) ids.add(id);
    }
  }
  for (const message of conversation.messages) {
    const messageRunId = message.metadata?.runId;
    if (typeof messageRunId === "string" && messageRunId) {
      ids.add(messageRunId);
    }
  }
  return ids;
}

export function conversationMatchesSnapshot(current: Conversation | undefined, updated: Conversation, currentRunId: string | undefined): boolean {
  if (!current) {
    return false;
  }
  const currentRun = metadataString(current.metadata.runId);
  const updatedRun = metadataString(updated.metadata.runId);
  return (
    current.id === updated.id ||
    Boolean(currentRun && updatedRun && currentRun === updatedRun) ||
    Boolean(currentRunId && updatedRun && currentRunId === updatedRun) ||
    Boolean(updatedRun && current.id === updatedRun)
  );
}

export function labelForKind(kind: ConversationKind): string {
  if (kind === "code-review") {
    return "Code review";
  }
  if (kind === "implementation-plan") {
    return "Implementation plan";
  }
  if (kind === "chat") {
    return "Chat";
  }
  return "Question";
}

export function metadataString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function phaseLabel(phase: ReviewProgress["phase"]): string {
  return phase
    .split("-")
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

import { randomUUID } from "node:crypto";
import type { ChatMessage, Conversation, GitDiffResult, ParticipantConfig, ReviewProgress, ReviewRequest } from "../../../../shared/types";
import type { ProgressCallback } from "../types";

const MAX_CONTEXT_CHARS = 90_000;

export function limitText(text: string, warnings: string[]): string {
  if (text.length <= MAX_CONTEXT_CHARS) {
    return text;
  }
  warnings.push(`Context was truncated to ${MAX_CONTEXT_CHARS.toLocaleString()} characters.`);
  return `${text.slice(0, MAX_CONTEXT_CHARS)}\n\n[Context truncated]`;
}

export function titleFor(request: ReviewRequest, diff: GitDiffResult | undefined): string {
  if (request.question.trim()) {
    return request.question.trim().slice(0, 80);
  }
  if (request.kind === "implementation-plan") {
    return "Implementation plan";
  }
  return diff?.title ?? "Consensus conversation";
}

export function consensusMessage(
  role: ChatMessage["role"],
  content: string,
  participant?: ParticipantConfig,
  status: ChatMessage["status"] = "done"
): ChatMessage {
  return {
    id: randomUUID(),
    role,
    participantId: participant?.id,
    participantLabel: participant?.label,
    content,
    createdAt: new Date().toISOString(),
    status
  };
}

export function cloneConversation(conversation: Conversation): Conversation {
  return JSON.parse(JSON.stringify(conversation)) as Conversation;
}

export function emitProgress(
  runId: string,
  progress: ProgressCallback | undefined,
  phase: ReviewProgress["phase"],
  message: string,
  details: Partial<Omit<ReviewProgress, "runId" | "phase" | "message" | "createdAt">> = {}
): void {
  progress?.({
    runId,
    phase,
    message,
    createdAt: new Date().toISOString(),
    ...details
  });
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("Review cancelled.");
  }
}

export function formatDuration(durationMs: number | undefined): string {
  if (durationMs === undefined) {
    return "";
  }
  return ` in ${(durationMs / 1000).toFixed(1)}s`;
}

export function formatParticipantLabelList(labels: string[]): string {
  if (labels.length === 0) {
    return "participants";
  }
  if (labels.length === 1) {
    return labels[0];
  }
  if (labels.length === 2) {
    return `${labels[0]} and ${labels[1]}`;
  }
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}

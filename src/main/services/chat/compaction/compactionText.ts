import { firstTextLine } from "../../../../shared/mainSessionView";
import { serverSeqOf } from "../../chatServerOps";
import type {
  ChatAppToolApproval, ChatMessage, ChatMessageMetadata, ChatParticipant, ChatParticipantSession, ChatSelfCompactionRequest,
  CompactChatParticipantRequest, Conversation
} from "../../../../shared/types";
import { COMPACTION_CANCELLED_BEFORE_START } from "../../cliAgents";
import { APP_CHAT_SEND_MESSAGE_TOOL, APP_CHAT_REQUEST_COMPACTION_TOOL } from "../../appMcp";
import { readParticipantCompactions } from "../../../../shared/chatRunState";
import { chatAppToolApprovals } from "../approvals/approvalRecords";
import { participantForMentionHandle, withoutFencedCode } from "../choices/mentions";
import { runIdBase, type SelfCompactionEnd, type SelfCompactionResume } from "./selfCompactionMarks";
import { chatParticipants } from "../members/identity";
import { participantRequestMessageForResumeContext } from "../requests/requestRecords";

interface CompactChatCommand {
  handle: string;
  instructions?: string;
}

const CHAT_COMPACT_INSTRUCTIONS_MAX_CHARS = 20_000;
const CHAT_SELF_COMPACTION_COOLDOWN_MS = 5 * 60_000;

/** The line a compaction that did not happen leaves, local or on a machine,
 *  whatever punctuation the reason ends with. */
export function compactionFailureLine(handle: string, error: string | undefined): string {
  return `Could not compact @${handle} context: ${(error ?? "").replace(/[.\s]+$/, "") || "unknown error"}.`;
}

/** The same line for a compaction a machine ran (or never got to run): a
 *  Stop before it started reads as a local one that never started. */
export function machineCompactionFailureLine(handle: string, status: string | undefined, error: string | undefined): string {
  return compactionFailureLine(handle, status === "interrupted" && !error ? COMPACTION_CANCELLED_BEFORE_START : error);
}

/** The message a machine member's compaction turn is placed against on the
 *  server: the one the User compacted from, or the chat's newest one the
 *  server holds. */
export function compactionAnchor(conversation: Conversation, request: { parentMessageId?: string }): ChatMessage | undefined {
  const accepted = (message: ChatMessage) => serverSeqOf(message) !== undefined && !message.metadata?.serverPlaceholder;
  const parentId = request.parentMessageId?.trim();
  const parent = parentId ? conversation.messages.find((message) => message.id === parentId && accepted(message)) : undefined;
  if (parent) return parent;
  for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
    if (accepted(conversation.messages[index])) return conversation.messages[index];
  }
  return undefined;
}

/** `/compact [instructions]` with no handle: the member it was written to. */
export function bareCompactCommand(content: string): { instructions?: string } | undefined {
  const match = withoutFencedCode(content).trim().match(/^\/compact(?:\s+([\s\S]+))?$/i);
  return match ? { instructions: normalizeCompactInstructions(match[1]) } : undefined;
}

export function parseCompactCommand(content: string): CompactChatCommand | undefined {
  const match = withoutFencedCode(content).trim().match(/^@([A-Za-z0-9_-]{1,32})\s+\/compact(?:\s+([\s\S]+))?$/i);
  if (!match) {
    return undefined;
  }
  return {
    handle: match[1],
    instructions: normalizeCompactInstructions(match[2])
  };
}

export function normalizeCompactInstructions(value: string | undefined): string | undefined {
  const instructions = value?.trim();
  if (!instructions) {
    return undefined;
  }
  if (instructions.length > CHAT_COMPACT_INSTRUCTIONS_MAX_CHARS) {
    throw new Error(`Compact instructions must be ${CHAT_COMPACT_INSTRUCTIONS_MAX_CHARS} characters or less.`);
  }
  return instructions;
}

export function normalizeSelfCompactionRequest(value: unknown): ChatSelfCompactionRequest {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as { instructions?: unknown }
    : {};
  return {
    type: "self_compaction",
    instructions: normalizeCompactInstructions(
      typeof record.instructions === "string" ? record.instructions : undefined
    )
  };
}

export function selfCompactionRequestGuard(
  conversation: Conversation,
  participant: ChatParticipant,
  ignoredApprovalId?: string
): { status: string; error: string; retryAfterMs?: number } | undefined {
  const sessions = Array.isArray(conversation.metadata.participantSessions)
    ? conversation.metadata.participantSessions as ChatParticipantSession[]
    : [];
  if (!sessions.some((session) => session.participantId === participant.id && Boolean(session.sessionId?.trim()))) {
    return {
      status: "no_active_session",
      error: `@${participant.handle} does not have an active session to compact yet.`
    };
  }
  if (readParticipantCompactions(conversation.metadata)[participant.id]) {
    return {
      status: "already_queued",
      error: `Context compaction is already queued or running for @${participant.handle}.`
    };
  }
  const pendingApproval = chatAppToolApprovals(conversation).find((approval) =>
    approval.id !== ignoredApprovalId &&
    approval.status === "pending" &&
    approval.toolName === APP_CHAT_REQUEST_COMPACTION_TOOL &&
    approval.requesterParticipantId === participant.id
  );
  if (pendingApproval) {
    return {
      status: "pending_user_approval",
      error: `A context compaction request from @${participant.handle} is already awaiting approval.`
    };
  }
  const requestedAtByParticipant = conversation.metadata.participantSelfCompactionRequestedAtByParticipantId;
  const requestedAt = requestedAtByParticipant && typeof requestedAtByParticipant === "object" && !Array.isArray(requestedAtByParticipant)
    ? (requestedAtByParticipant as Record<string, unknown>)[participant.id]
    : undefined;
  const requestedAtMs = typeof requestedAt === "string" ? Date.parse(requestedAt) : Number.NaN;
  if (Number.isFinite(requestedAtMs)) {
    const retryAfterMs = Math.max(0, CHAT_SELF_COMPACTION_COOLDOWN_MS - (Date.now() - requestedAtMs));
    if (retryAfterMs > 0) {
      return {
        status: "cooldown",
        error: `Context compaction for @${participant.handle} is cooling down.`,
        retryAfterMs
      };
    }
  }
  return undefined;
}

export function recordSelfCompactionRequested(conversation: Conversation, participantId: string, requestedAt: string): void {
  const current = conversation.metadata.participantSelfCompactionRequestedAtByParticipantId;
  const records = current && typeof current === "object" && !Array.isArray(current)
    ? current as Record<string, string>
    : {};
  conversation.metadata = {
    ...conversation.metadata,
    participantSelfCompactionRequestedAtByParticipantId: {
      ...records,
      [participantId]: requestedAt
    }
  };
}

export function selfCompactionResumeKey(conversationId: string, participantId: string, runId: string): string {
  return `${conversationId}\u0000${participantId}\u0000${runIdBase(runId)}`;
}

/** The member request the asking run answered, when it answered one. */
export function selfCompactionRequestMessage(conversation: Conversation, resume: SelfCompactionResume): ChatMessage | undefined {
  return resume.participantRequestBatchId
    ? participantRequestMessageForResumeContext(conversation, resume.triggerMessageId ?? "", resume.participantRequestBatchId)
    : undefined;
}

/** The app event that calls a member again after its own compaction. Never
 *  worded as a requester's resume (PARTICIPANT_REQUEST_AUTO_RESUME_PREFIX):
 *  a restart reads those as "already resumed". */
export function selfCompactionResumeText(participant: ChatParticipant, end: SelfCompactionEnd, instructions: string | undefined): string {
  const goOn = "Go on with the next step of your work now. If User has written to you since, her words come first. If nothing is left to do, say so in one line.";
  const keep = instructions?.trim();
  return [
    `@${participant.handle} goes on after the compaction it asked for.`,
    end.kind === "completed"
      ? `Your context was compacted. ${goOn}`
      : end.kind === "declined"
        ? `User chose not to compact your context now: it is as it was. ${goOn}`
        : `Your context could not be compacted${end.reason ? ` (${firstTextLine(end.reason, 200)})` : ""}: it is as it was. ${goOn}`,
    ...(keep ? [`What you asked the summary to keep: ${keep}`] : [])
  ].join("\n");
}

/** A run's reply (posts it sent meanwhile aside). */
export function repliesOfRun(conversation: Conversation, participantId: string, runId: string): ChatMessage[] {
  const base = runIdBase(runId);
  return conversation.messages.filter((message) => message.role === "participant" && message.participantId === participantId && message.metadata?.appMessageSource !== APP_CHAT_SEND_MESSAGE_TOOL &&
    typeof message.metadata?.runId === "string" && runIdBase(message.metadata.runId) === base);
}

export function pendingCompactionCard(conversation: Conversation, participantId: string, runId: string): ChatAppToolApproval | undefined {
  return chatAppToolApprovals(conversation).find((approval) => approval.status === "pending" && approval.toolName === APP_CHAT_REQUEST_COMPACTION_TOOL &&
    approval.requesterParticipantId === participantId && approval.resumeContext && runIdBase(approval.resumeContext.runId) === runIdBase(runId));
}

export function compactSuccessMessage(handle: string, instructions: string | undefined, requestedByHandle?: string): string {
  // The main session compacted it (app_chat_compact_participant): the User
  // did not, so the line says who and what it kept.
  if (requestedByHandle) {
    const focus = instructions ? firstTextLine(instructions, 300) : "";
    return `@${requestedByHandle} compacted @${handle} context${focus ? `. Focus: ${focus}` : "."}`;
  }
  if (!instructions) {
    return `Compacted @${handle} context.`;
  }
  return `Compacted @${handle} context with focus instructions.`;
}

export function compactRequestParticipant(conversation: Conversation, request: CompactChatParticipantRequest): ChatParticipant | undefined {
  const participants = chatParticipants(conversation);
  if (request.participantId) {
    const byId = participants.find((participant) => participant.id === request.participantId);
    if (byId) {
      return byId;
    }
  }
  return request.handle ? participantForMentionHandle(participants, request.handle) : undefined;
}

export function compactMessageMetadata(
  request: Pick<CompactChatParticipantRequest, "threadId" | "parentMessageId" | "chatThreadRootId" | "runId" | "triggeredBy" | "instructions" | "requestedByParticipantId">,
  participant: Pick<ChatParticipant, "id" | "kind">,
  outcome: "completed" | "failed" | "no-active-session"
): ChatMessageMetadata {
  const requestedBy = request.requestedByParticipantId?.trim();
  return {
    threadId: request.threadId?.trim() || undefined,
    parentMessageId: request.parentMessageId?.trim() || undefined,
    chatThreadRootId: request.chatThreadRootId?.trim() || undefined,
    runId: request.runId?.trim() || undefined,
    compaction: {
      triggeredBy: request.triggeredBy === "agent" ? "agent" : "user",
      participantId: participant.id,
      outcome,
      instructionsProvided: Boolean(request.instructions?.trim()),
      cli: participant.kind,
      ...(requestedBy ? { requestedByParticipantId: requestedBy } : {})
    }
  };
}

import { mainSessionParticipantId } from "../../../../shared/mainSession";
import type {
  ChatAppToolApproval, ChatAppToolApprovalScope, ChatMessage, ChatParticipant, ChatParticipantRequestApprovalRequest,
  ChatParticipantRequestBatch, ChatParticipantRequestInput, ChatParticipantRequestItem, ChatParticipantRequestStatus, Conversation
} from "../../../../shared/types";
import { chatMessageMemberText } from "../../../../shared/interimPosts";
import { CHAT_PARTICIPANT_REQUEST_MAX_CHAIN_BATCHES } from "../../../../shared/chatParticipantRequests";
import { APP_CHAT_REQUEST_PARTICIPANTS_TOOL, APP_PERMISSIONS_REQUEST_CHANGE_TOOL } from "../../appMcp";
import {
  chatAppToolApprovals, confirmationRequestWasAsked, isParticipantRequestApprovalRequest, newAppToolApproval,
  upsertAppToolApproval
} from "../approvals/approvalRecords";
import { participantForMentionHandle } from "../choices/mentions";
import { HANDLE_PATTERN } from "../constants";
import { chatParticipants, formatHandleList } from "../members/identity";
import {
  CHAT_PARTICIPANT_REQUEST_MAX_ITEMS, CHAT_PARTICIPANT_REQUEST_WAIT_DEFAULT_MS, PARTICIPANT_REQUEST_SCRUTINY_APPENDIX
} from "./constants";
import type { ParticipantRequestRunResult, PreparedParticipantRequest } from "./types";
import { recordLastMessageByParticipant } from "../store/lastMessages";
import { optionalBoundedPositiveInteger } from "../tools/toolInputs";
import type { ChatAppMcpActor } from "../types";

const CHAT_PARTICIPANT_REQUEST_MAX_BATCHES_PER_TURN = 4;
const CHAT_PARTICIPANT_REQUEST_RATE_WINDOW_MS = 60_000;
const CHAT_PARTICIPANT_REQUEST_RATE_LIMIT = 8;
const CHAT_PARTICIPANT_REQUEST_WAIT_MAX_MS = 300_000;

/** Records a prepared member request on the chat: its message, and a card
 *  for the targets that need the User's approval. */
export function recordPreparedParticipantRequest(
  conversation: Conversation,
  requester: ChatParticipant,
  prepared: PreparedParticipantRequest,
  actor: ChatAppMcpActor
): void {
  conversation.messages.push(prepared.requestMessage);
  recordLastMessageByParticipant(conversation, prepared.requestMessage);
  const pendingTargets = prepared.batch.items.filter((item) => item.status === "pending_approval");
  if (pendingTargets.length === 0) {
    return;
  }
  const participants = chatParticipants(conversation);
  const approval = newAppToolApproval(
    conversation,
    requester,
    APP_CHAT_REQUEST_PARTICIPANTS_TOOL,
    "participants.request",
    {
      ...prepared.request,
      requests: prepared.request.requests.filter((request) => {
        const target = participantForMentionHandle(participants, request.target);
        return target ? pendingTargets.some((item) => item.targetParticipantId === target.id) : false;
      }),
      requestMessageId: prepared.requestMessage.id,
      batchId: prepared.batch.id
    },
    participantRequestSummary(requester.handle, pendingTargets.map((item) => item.targetHandle)),
    "pending"
  );
  if (actor.runId && actor.triggerMessageId) {
    approval.resumeContext = {
      runId: actor.runId,
      triggerMessageId: actor.triggerMessageId,
      participantRequestBatchId: prepared.batch.id
    };
  }
  upsertAppToolApproval(conversation, approval);
}

export function participantRequestPromptForTarget(prompt: string): string {
  if (prompt.includes(PARTICIPANT_REQUEST_SCRUTINY_APPENDIX)) {
    return prompt;
  }
  if (!confirmationRequestWasAsked(prompt)) {
    return prompt;
  }
  return [prompt, "", PARTICIPANT_REQUEST_SCRUTINY_APPENDIX].join("\n");
}

export function normalizeParticipantRequest(raw: unknown): {
  requests: ChatParticipantRequestInput[];
  timeoutMs: number;
  resumeRequester: boolean;
} {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Member request must be an object.");
  }
  const record = raw as { requests?: unknown; timeoutMs?: unknown; resumeRequester?: unknown; deliver?: unknown };
  // For every target (top level), or for one (its request), which wins.
  const deliverOf = (value: unknown): "now" | "queue" | undefined => {
    if (value !== undefined && value !== "queue" && value !== "now") throw new Error("deliver is \"queue\" or \"now\".");
    return value;
  };
  const deliverAll = deliverOf(record.deliver);
  if (!Array.isArray(record.requests) || record.requests.length === 0) {
    throw new Error("Member request needs at least one target.");
  }
  if (record.requests.length > CHAT_PARTICIPANT_REQUEST_MAX_ITEMS) {
    throw new Error(`Member request can target at most ${CHAT_PARTICIPANT_REQUEST_MAX_ITEMS} members.`);
  }
  const requests: ChatParticipantRequestInput[] = [];
  for (const item of record.requests) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("Each member request item must be an object.");
    }
    const candidate = item as { target?: unknown; prompt?: unknown; reason?: unknown; deliver?: unknown };
    const deliver = deliverOf(candidate.deliver) ?? deliverAll;
    const target = typeof candidate.target === "string" ? candidate.target.trim().replace(/^@/, "") : "";
    const prompt = typeof candidate.prompt === "string" ? candidate.prompt.trim() : "";
    if (!HANDLE_PATTERN.test(target)) {
      throw new Error(`Invalid member target: ${String(candidate.target ?? "")}.`);
    }
    if (!prompt) {
      throw new Error(`Member request for @${target} needs a prompt.`);
    }
    requests.push({
      target,
      prompt,
      reason: typeof candidate.reason === "string" ? candidate.reason.trim().slice(0, 500) || undefined : undefined,
      ...(deliver === "now" ? { deliver } : {})
    });
  }
  return {
    requests,
    timeoutMs: optionalBoundedPositiveInteger(
      record.timeoutMs,
      "timeoutMs",
      CHAT_PARTICIPANT_REQUEST_WAIT_DEFAULT_MS,
      CHAT_PARTICIPANT_REQUEST_WAIT_MAX_MS
    ),
    resumeRequester: typeof record.resumeRequester === "boolean" ? record.resumeRequester : true
  };
}

export function participantRequestLimitError(
  conversation: Conversation,
  requester: ChatParticipant,
  actor: ChatAppMcpActor,
  depth: number,
  maxDepth: number,
  chainRootId: string,
  asksMainSessionOnly = false
): string | undefined {
  if (depth > maxDepth) {
    return `max depth (${maxDepth}) reached`;
  }
  // The main session's tasks and members' questions to it neither meet
  // nor count toward the chain limit (the User decided no limit on
  // members, 2026-11-20); the depth limit above and the rate limit below
  // still stop a loop.
  const mainId = mainSessionParticipantId(conversation.metadata);
  const chainBatches = asksMainSessionOnly ? [] : participantRequestBatches(conversation).filter((batch) =>
    participantRequestBatchChainRootId(batch) === chainRootId && !isMainSessionTaskOrQuestion(batch, mainId)
  );
  if (chainBatches.length >= CHAT_PARTICIPANT_REQUEST_MAX_CHAIN_BATCHES) {
    return `member request chain limit (${CHAT_PARTICIPANT_REQUEST_MAX_CHAIN_BATCHES}) reached`;
  }
  // The main session's tasks to members it made (app_chat_delegate_task)
  // are not member requests in this sense: it may give any number of them
  // in one turn and still ask a member something.
  const sameTurnMcpBatches = actor.triggerMessageId
    ? participantRequestBatches(conversation).filter((batch) =>
        batch.requesterParticipantId === requester.id &&
        batch.triggerMessageId === actor.triggerMessageId &&
        batch.source === "mcp" &&
        !batch.delegation
      )
    : [];
  if (sameTurnMcpBatches.some((batch) => participantRequestHasUnfinishedItems(batch))) {
    return "one active request batch is already attached to this requester turn";
  }
  if (sameTurnMcpBatches.length >= CHAT_PARTICIPANT_REQUEST_MAX_BATCHES_PER_TURN) {
    return `member request turn limit (${CHAT_PARTICIPANT_REQUEST_MAX_BATCHES_PER_TURN}) reached`;
  }
  const threshold = Date.now() - CHAT_PARTICIPANT_REQUEST_RATE_WINDOW_MS;
  const recent = participantRequestBatches(conversation).filter((batch) => !batch.delegation && Date.parse(batch.createdAt) >= threshold);
  if (recent.length >= CHAT_PARTICIPANT_REQUEST_RATE_LIMIT) {
    return `member request rate limit (${CHAT_PARTICIPANT_REQUEST_RATE_LIMIT}/minute) reached`;
  }
  return undefined;
}

/** A task the main session gave a member it made, or a member's question
 *  to the main session alone. */
function isMainSessionTaskOrQuestion(batch: ChatParticipantRequestBatch, mainId: string | undefined): boolean {
  if (batch.delegation) {
    return true;
  }
  return Boolean(mainId) && batch.requesterParticipantId !== mainId && batch.items.length > 0 &&
    batch.items.every((item) => item.targetParticipantId === mainId);
}

export function participantRequestBatchRequesterDepth(batch: ChatParticipantRequestBatch): number {
  return batch.requesterDepth ?? Math.max(0, batch.depth - 1);
}

export function participantRequestResumeDepth(batch: ChatParticipantRequestBatch, resumedParticipantId: string): number {
  return resumedParticipantId === batch.requesterParticipantId
    ? participantRequestBatchRequesterDepth(batch)
    : batch.depth;
}

function participantRequestBatchChainRootId(batch: ChatParticipantRequestBatch): string {
  return batch.chainRootId ?? batch.id;
}

export function participantRequestSummary(requesterHandle: string, targetHandles: string[]): string {
  return `@${requesterHandle} asks ${formatHandleList(targetHandles.map((handle) => `@${handle}`))}`;
}

export function participantRequestApprovalTargetIds(
  conversation: Conversation,
  request: ChatParticipantRequestApprovalRequest
): string[] {
  const participants = chatParticipants(conversation);
  const liveParticipantIds = new Set(participants.map((participant) => participant.id));
  const requestedHandles = new Set(request.requests.map((item) => item.target.replace(/^@/, "").toLowerCase()));
  const batch = participantRequestBatchForApproval(conversation, request);
  if (batch) {
    const ids: string[] = [];
    for (const item of batch.items) {
      if (
        requestedHandles.has(item.targetHandle.toLowerCase()) &&
        liveParticipantIds.has(item.targetParticipantId) &&
        !ids.includes(item.targetParticipantId)
      ) {
        ids.push(item.targetParticipantId);
      }
    }
    return ids;
  }
  const ids: string[] = [];
  for (const item of request.requests) {
    const targetHandle = item.target.replace(/^@/, "");
    const target = participantForMentionHandle(participants, targetHandle);
    if (target && !ids.includes(target.id)) {
      ids.push(target.id);
    }
  }
  return ids;
}

export function participantRequestBatchForApproval(
  conversation: Conversation,
  request: ChatParticipantRequestApprovalRequest
): ChatParticipantRequestBatch | undefined {
  const requestMessageId = request.requestMessageId;
  if (!requestMessageId) {
    return undefined;
  }
  const batch = conversation.messages.find((message) => message.id === requestMessageId)?.metadata?.participantRequest;
  if (!batch || (request.batchId && batch.id !== request.batchId)) {
    return undefined;
  }
  return batch;
}

export function applyParticipantRequestApprovalDecision(
  conversation: Conversation,
  approval: ChatAppToolApproval,
  decision: "approved" | "denied",
  _scope?: ChatAppToolApprovalScope
): void {
  if (!isParticipantRequestApprovalRequest(approval.request) || !approval.request.requestMessageId) {
    return;
  }
  const liveTargetIds = new Set(participantRequestApprovalTargetIds(conversation, approval.request));
  const requestedHandles = new Set(approval.request.requests.map((item) => item.target.replace(/^@/, "").toLowerCase()));
  const now = new Date().toISOString();
  updateParticipantRequestBatch(conversation, approval.request.requestMessageId, (batch) => {
    const items = batch.items.map((item) => {
      if (!requestedHandles.has(item.targetHandle.toLowerCase()) || item.status !== "pending_approval") {
        return item;
      }
      if (decision === "approved" && !liveTargetIds.has(item.targetParticipantId)) {
        return {
          ...item,
          status: "failed" as const,
          error: "Target member is no longer in this chat.",
          updatedAt: now
        };
      }
      return {
        ...item,
        status: decision === "approved" ? "running" as const : "denied" as const,
        updatedAt: now
      };
    });
    return {
      ...batch,
      items,
      status: rollupParticipantRequestStatus(items),
      updatedAt: now
    };
  });
}

export function formatParticipantRequestMessage(_requesterHandle: string, items: ChatParticipantRequestItem[]): string {
  return items.map((item) => `@${item.targetHandle} ${participantRequestPromptForTarget(item.prompt)}`.trim()).join("\n");
}

export function rollupParticipantRequestStatus(items: ChatParticipantRequestItem[], forced?: ChatParticipantRequestStatus): ChatParticipantRequestStatus {
  if (forced) {
    return forced;
  }
  if (items.some((item) => item.status === "pending_approval")) {
    return "pending_approval";
  }
  if (items.some((item) => item.status === "running")) {
    return "running";
  }
  if (items.some((item) => item.status === "resuming_requester")) {
    return "resuming_requester";
  }
  for (const status of ["failed", "denied", "interrupted", "completed", "answered"] as ChatParticipantRequestStatus[]) {
    if (items.some((item) => item.status === status)) {
      return status;
    }
  }
  return "completed";
}

export function updateParticipantRequestBatch(
  conversation: Conversation,
  requestMessageId: string,
  update: (batch: ChatParticipantRequestBatch) => ChatParticipantRequestBatch
): ChatParticipantRequestBatch | undefined {
  let updated: ChatParticipantRequestBatch | undefined;
  conversation.messages = conversation.messages.map((message) => {
    if (message.id !== requestMessageId || !message.metadata?.participantRequest) {
      return message;
    }
    updated = update(message.metadata.participantRequest);
    return {
      ...message,
      metadata: {
        ...message.metadata,
        participantRequest: updated
      }
    };
  });
  // Every way a request's item ends (its turn, an approval's resume, a
  // compaction the member went on from, a Stop, a quit, a restart) goes
  // through here: the requests that went out with it end with it.
  if (updated) settleRequestsAnsweredWith(conversation, requestMessageId, updated);
  return updated;
}

/** The requests that went out in one turn with `requestMessageId`'s
 *  (ChatParticipantRequestItem.answeredWith) and are still open end as its
 *  item for the same target has ended: the same status, reply and error, and
 *  they read the reply of the turn they went out in as well (an approval's
 *  resume or a compaction may have given the request a later reply). */
export function settleRequestsAnsweredWith(conversation: Conversation, requestMessageId: string, batch: ChatParticipantRequestBatch): void {
  const ended = batch.items.filter((item) => !isOpenParticipantRequestStatus(item.status));
  if (ended.length === 0) return;
  const now = new Date().toISOString();
  conversation.messages = conversation.messages.map((message) => {
    const other = message.metadata?.participantRequest;
    if (!other || message.id === requestMessageId) return message;
    let changed = false;
    const items = other.items.map((item) => {
      const lead = item.answeredWith?.requestMessageId === requestMessageId && isOpenParticipantRequestStatus(item.status)
        ? ended.find((candidate) => candidate.targetParticipantId === item.targetParticipantId)
        : undefined;
      if (!lead) return item;
      changed = true;
      const turnReply = item.answeredWith?.replyMessageId;
      const earlier = [...new Set([...(lead.earlierReplyMessageIds ?? []), ...(turnReply && turnReply !== lead.replyMessageId ? [turnReply] : [])])];
      return {
        ...item,
        status: lead.status,
        replyMessageId: lead.replyMessageId,
        error: lead.error,
        ...(earlier.length > 0 ? { earlierReplyMessageIds: earlier } : {}),
        updatedAt: now
      };
    });
    if (!changed) return message;
    return { ...message, metadata: { ...message.metadata, participantRequest: { ...other, items, status: rollupParticipantRequestStatus(items), updatedAt: now } } };
  });
}

export async function awaitParticipantRequestRunner(
  runner: Promise<ParticipantRequestRunResult>,
  timeoutMs: number
): Promise<{ timedOut: true } | { timedOut: false; result: ParticipantRequestRunResult }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      runner.then((result) => ({ timedOut: false as const, result })),
      new Promise<{ timedOut: true }>((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
        timer.unref();
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export function participantRequestMessageForResumeContext(
  conversation: Conversation,
  triggerMessageId: string,
  batchId: string
): ChatMessage | undefined {
  const triggerMessage = conversation.messages.find((message) => message.id === triggerMessageId);
  if (triggerMessage?.metadata?.participantRequest?.id === batchId) {
    return triggerMessage;
  }
  return conversation.messages.find((message) => message.metadata?.participantRequest?.id === batchId);
}

export function applyPermissionResumeToParticipantRequest(
  conversation: Conversation,
  requestMessageId: string,
  batchId: string,
  target: ChatParticipant,
  messages: ChatMessage[]
): string | undefined {
  const reply = messages[0];
  const now = new Date().toISOString();
  const updatedBatch = updateParticipantRequestBatch(conversation, requestMessageId, (current) => {
    if (current.id !== batchId) {
      return current;
    }
    const items = current.items.map((item) => {
      if (item.targetParticipantId !== target.id) {
        return item;
      }
      return {
        ...item,
        status: reply?.status === "error" ? "failed" as const : "answered" as const,
        replyMessageId: reply?.id,
        error: reply?.status === "error" ? reply.content : undefined,
        updatedAt: now
      };
    });
    return {
      ...current,
      completedInToolCall: false,
      items,
      status: rollupParticipantRequestStatus(items),
      updatedAt: now
    };
  });
  if (!updatedBatch || updatedBatch.id !== batchId || !updatedBatch.resumeRequester || updatedBatch.autoResumeMessageId) {
    return undefined;
  }
  return participantRequestHasUnfinishedItems(updatedBatch) ? undefined : requestMessageId;
}

export function participantRequestToolResult(
  conversation: Conversation,
  requestMessageId: string,
  extra: Record<string, unknown>,
  options: { includeReplies?: boolean } = {}
): Record<string, unknown> {
  const message = conversation.messages.find((item) => item.id === requestMessageId);
  const batch = message?.metadata?.participantRequest;
  if (!batch) {
    return { ok: false, status: "failed", error: "Member request was not found." };
  }
  return {
    ok: true,
    requestId: batch.id,
    requestMessageId,
    batch: participantRequestBatchForTool(conversation, batch, options),
    ...extra
  };
}

export function participantRequestFailedToolResult(error: string): Record<string, unknown> {
  return {
    ok: false,
    status: "failed",
    error
  };
}

export function participantRequestBatchForTool(
  conversation: Conversation,
  batch: ChatParticipantRequestBatch,
  options: { includeReplies?: boolean } = {}
): Record<string, unknown> {
  const includeReplies = options.includeReplies ?? true;
  return {
    id: batch.id,
    status: batch.status,
    source: batch.source,
    resumeRequester: batch.resumeRequester,
    requester: `@${batch.requesterHandle}`,
    items: batch.items.map((item) => {
      const reply = item.replyMessageId ? conversation.messages.find((message) => message.id === item.replyMessageId) : undefined;
      return {
        target: `@${item.targetHandle}`,
        prompt: item.prompt,
        reason: item.reason,
        status: item.status,
        replyMessageId: includeReplies ? item.replyMessageId : undefined,
        reply: includeReplies && reply ? chatMessageMemberText(reply) : undefined,
        error: item.error
      };
    })
  };
}

export function resolveParticipantRequestApprovalItems(
  conversation: Conversation,
  approval: ChatAppToolApproval,
  status: Extract<ChatParticipantRequestStatus, "denied" | "interrupted" | "failed">,
  reason: string,
  now: string
): boolean {
  if (!isParticipantRequestApprovalRequest(approval.request) || !approval.request.requestMessageId) {
    return false;
  }
  const requestedHandles = new Set(approval.request.requests.map((item) => item.target.replace(/^@/, "").toLowerCase()));
  let changed = false;
  updateParticipantRequestBatch(conversation, approval.request.requestMessageId, (batch) => {
    const items = batch.items.map((item) => {
      if (!requestedHandles.has(item.targetHandle.toLowerCase()) || !isOpenParticipantRequestStatus(item.status)) {
        return item;
      }
      changed = true;
      return {
        ...item,
        status,
        error: item.error ?? reason,
        updatedAt: now
      };
    });
    if (!changed) {
      return batch;
    }
    return {
      ...batch,
      items,
      status: rollupParticipantRequestStatus(items),
      error: batch.error ?? reason,
      updatedAt: now
    };
  });
  return changed;
}

export function resolveParticipantRequestTargetItem(
  conversation: Conversation,
  batchId: string,
  targetParticipantId: string,
  status: Extract<ChatParticipantRequestStatus, "denied" | "interrupted" | "failed">,
  reason: string,
  now: string
): boolean {
  let changed = false;
  for (const message of conversation.messages) {
    const batch = message.metadata?.participantRequest;
    if (!batch || batch.id !== batchId) {
      continue;
    }
    let messageChanged = false;
    const items = batch.items.map((item) => {
      if (item.targetParticipantId !== targetParticipantId || !isOpenParticipantRequestStatus(item.status)) {
        return item;
      }
      messageChanged = true;
      changed = true;
      return {
        ...item,
        status,
        error: item.error ?? reason,
        updatedAt: now
      };
    });
    if (!messageChanged) {
      continue;
    }
    message.metadata = {
      ...message.metadata,
      participantRequest: {
        ...batch,
        items,
        status: rollupParticipantRequestStatus(items),
        error: batch.error ?? reason,
        updatedAt: now
      }
    };
  }
  return changed;
}

export function terminalParticipantRequestBatch(
  batch: ChatParticipantRequestBatch,
  status: Extract<ChatParticipantRequestStatus, "denied" | "interrupted" | "failed">,
  reason: string,
  now: string,
  shouldUpdate: (item: ChatParticipantRequestItem) => boolean = (item) => isOpenParticipantRequestStatus(item.status)
): ChatParticipantRequestBatch {
  let changed = false;
  const items = batch.items.map((item) => {
    if (!shouldUpdate(item)) {
      return item;
    }
    changed = true;
    return {
      ...item,
      status,
      error: item.error ?? reason,
      updatedAt: now
    };
  });
  if (!changed) {
    return batch;
  }
  return {
    ...batch,
    items,
    status: rollupParticipantRequestStatus(items),
    error: batch.error ?? reason,
    updatedAt: now
  };
}

/** Whether a member asked in this request waits on the User's permission
 *  card for that turn (app_permissions_request_change): the request looks
 *  ended to a sweep (its item has no run), yet its answer comes when she
 *  answers the card. */
export function participantRequestWaitsOnPermissionCard(conversation: Conversation, requestMessage: ChatMessage, batch: ChatParticipantRequestBatch): boolean {
  return chatAppToolApprovals(conversation).some((approval) =>
    approval.status === "pending" &&
    approval.toolName === APP_PERMISSIONS_REQUEST_CHANGE_TOOL &&
    (approval.resumeContext?.triggerMessageId === requestMessage.id ||
      batch.items.some((item) => item.targetParticipantId === approval.requesterParticipantId && item.earlierReplyMessageIds?.length)) &&
    approval.resumeContext?.participantRequestBatchId === batch.id &&
    batch.items.some((item) => item.targetParticipantId === approval.requesterParticipantId));
}

export function pendingParticipantRequestApprovalTargetIds(
  conversation: Conversation,
  batch: ChatParticipantRequestBatch
): Set<string> {
  const targetIds = new Set<string>();
  for (const approval of chatAppToolApprovals(conversation)) {
    if (
      approval.status !== "pending" ||
      approval.toolName !== APP_CHAT_REQUEST_PARTICIPANTS_TOOL ||
      !isParticipantRequestApprovalRequest(approval.request) ||
      approval.request.batchId !== batch.id
    ) {
      continue;
    }
    const requestedHandles = new Set(approval.request.requests.map((item) => item.target.replace(/^@/, "").toLowerCase()));
    for (const item of batch.items) {
      if (requestedHandles.has(item.targetHandle.toLowerCase())) {
        targetIds.add(item.targetParticipantId);
      }
    }
  }
  return targetIds;
}

export function markParticipantRequestAutoResumeFailed(conversation: Conversation, requestMessageId: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  updateParticipantRequestBatch(conversation, requestMessageId, (batch) => ({
    ...batch,
    status: "failed",
    updatedAt: new Date().toISOString(),
    error: message || "Requester auto-resume failed before completion."
  }));
  conversation.updatedAt = new Date().toISOString();
}

export function participantRequestBatches(conversation: Conversation): ChatParticipantRequestBatch[] {
  return conversation.messages
    .map((message) => message.metadata?.participantRequest)
    .filter((batch): batch is ChatParticipantRequestBatch => Boolean(batch));
}

export function participantRequestHasUnfinishedItems(batch: ChatParticipantRequestBatch): boolean {
  return batch.items.some((item) =>
    item.status === "pending_approval" ||
    item.status === "running" ||
    item.status === "resuming_requester"
  );
}

export function participantRequestMessages(conversation: Conversation): Array<{ message: ChatMessage; batch: ChatParticipantRequestBatch }> {
  return conversation.messages
    .map((message) => ({ message, batch: message.metadata?.participantRequest }))
    .filter((item): item is { message: ChatMessage; batch: ChatParticipantRequestBatch } => Boolean(item.batch));
}

export function isOpenParticipantRequestStatus(status: ChatParticipantRequestStatus): boolean {
  return status === "pending_approval" || status === "running" || status === "resuming_requester";
}

export function isPendingMessageForInterruptedParticipantRequest(conversation: Conversation, message: ChatMessage): boolean {
  const requestMessageId = message.metadata?.parentMessageId ?? message.metadata?.sourceMessageId;
  if (!requestMessageId) {
    return false;
  }
  const requestMessage = conversation.messages.find((item) => item.id === requestMessageId);
  return requestMessage?.metadata?.participantRequest?.status === "interrupted";
}

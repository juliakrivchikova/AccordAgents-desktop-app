import { inCliOwnMode } from "../../../../shared/chatAccessModes";
import { isMainSessionChat, isMainSessionParticipant } from "../../../../shared/mainSession";
import { SESSIONS_TASK_GIVEN_TITLE_MAX_CHARS, shortenAtWord } from "../../../../shared/mainSessionView";
import { randomUUID } from "node:crypto";
import { choiceClosedForGoneMember } from "../../chatChoiceExpiry";
import type {
  ChatAppToolApproval, ChatAppToolApprovalRequest, ChatMessage, ChatMessageMetadata, ChatParticipant,
  ChatParticipantRemovalRequest, ChatParticipantRequestBatch, ChatProviderKind, ChatReasoningEffort, Conversation
} from "../../../../shared/types";
import { APP_CHAT_REQUEST_PARTICIPANTS_TOOL, APP_PARTICIPANTS_REQUEST_CHANGE_TOOL, APP_ROSTER_REQUEST_CHANGE_TOOL } from "../../appMcp";
import {
  chatAppToolApprovals, isParticipantChangeRequest, isParticipantRemovalRequest, isParticipantRequestApprovalRequest,
  isRoleParticipantChangeRequest, isRosterChangeRequest, upsertAppToolApprovalPolicy
} from "../approvals/approvalRecords";
import { participantForMentionHandle } from "../choices/mentions";
import { CHAT_ADMINISTRATOR_ROLE_ID, HANDLE_PATTERN } from "../constants";
import { chatParticipants, formatHandleList, isChatMainSession } from "./identity";
import type { ParticipantRemovalInput } from "./types";
import {
  isOpenParticipantRequestStatus, participantRequestBatchForApproval, rollupParticipantRequestStatus
} from "../requests/requestRecords";
import { createChatMessage } from "../store/messages";
import type { ChatTaskDelegationInput } from "../types";

/** Whether this desktop can confirm the User's answer behind a machine
 *  member's approved roster change (see ChatService.machineRosterDecision). */
export type MachineRosterDecision = { ok: true } | { ok: false; waiting: true } | { ok: false; waiting: false; problem: string };

/** Why the main session cannot be taken out of its chat, in words that name
 *  no main session (the User, 2026-11-22). */
export const MAIN_SESSION_NOT_REMOVABLE_MESSAGE = "This chat's own session cannot be removed.";

type MemberRemovalApproval = ChatAppToolApproval & { request: ChatParticipantRemovalRequest };

export function delegationRefusal(code: string, reason: string): Record<string, unknown> {
  return { ok: false, code, reason };
}

export function normalizeTaskDelegation(raw: unknown, promptMaxChars: number): ChatTaskDelegationInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("The delegation must be an object.");
  }
  const record = raw as Record<string, unknown>;
  const task = typeof record.task === "string" ? record.task.trim() : "";
  if (!task) {
    throw new Error("The delegation needs a task.");
  }
  if (task.length > promptMaxChars) {
    throw new Error(`The task exceeds ${promptMaxChars} characters; it is rejected, not truncated.`);
  }
  if (record.start !== undefined && record.start !== "clean" && record.start !== "fork") {
    throw new Error("start is \"clean\" or \"fork\".");
  }
  const handle = typeof record.handle === "string" ? record.handle.trim().replace(/^@/, "") : "";
  if (handle && !HANDLE_PATTERN.test(handle)) {
    throw new Error("Member names may use letters, numbers, underscores, and hyphens only (at most 32).");
  }
  const kind = record.kind;
  if (kind !== undefined && kind !== "claude-code" && kind !== "codex-cli" && kind !== "gemini-cli") {
    throw new Error("kind is claude-code, codex-cli or gemini-cli.");
  }
  if (record.permissions !== undefined && record.permissions !== null && (typeof record.permissions !== "object" || Array.isArray(record.permissions))) {
    throw new Error("permissions must be an object.");
  }
  const permissions = record.permissions ? record.permissions as Record<string, unknown> : undefined;
  const text = (value: unknown): string | undefined => typeof value === "string" ? value.trim() || undefined : undefined;
  const title = typeof record.title === "string" ? record.title.replace(/\s+/g, " ").trim() : "";
  return {
    task,
    ...(title ? { title: shortenAtWord(title, SESSIONS_TASK_GIVEN_TITLE_MAX_CHARS) } : {}),
    ...(record.start === "fork" || record.start === "clean" ? { start: record.start } : {}),
    ...(handle ? { handle } : {}),
    ...(text(record.roleConfigId) ? { roleConfigId: text(record.roleConfigId) } : {}),
    ...(kind ? { kind: kind as ChatProviderKind } : {}),
    ...(text(record.model) ? { model: text(record.model) } : {}),
    ...(text(record.reasoningEffort) ? { reasoningEffort: text(record.reasoningEffort) as ChatReasoningEffort } : {}),
    ...(record.agentMode === "plan" || record.agentMode === "default" || record.agentMode === "auto" ? { agentMode: record.agentMode } : {}),
    ...(permissions ? { permissions } : {}),
    ...(text(record.reason) ? { reason: text(record.reason)!.slice(0, 500) } : {})
  };
}

/** Members a member added without a card in a chat with a main session
 *  say who added them, so every device holds them to the main session's
 *  rights at each turn (participantForRun), and run in their CLI's own mode
 *  (inCliOwnMode: the sessions view has only the CLIs' own modes; the User,
 *  2026-11-22). Members the User added or approved herself say nothing. The
 *  members as the chat has them now. */
export function markAddedWithoutCard(conversation: Conversation, added: ChatParticipant[], requesterId: string): ChatParticipant[] {
  if (added.length === 0 || !isMainSessionChat(conversation.metadata)) {
    return added;
  }
  const ids = new Set(added.map((participant) => participant.id));
  const marked = new Map<string, ChatParticipant>();
  const participants = chatParticipants(conversation).map((participant) => {
    if (!ids.has(participant.id) || participant.id === requesterId || isMainSessionParticipant(conversation.metadata, participant.id)) {
      return participant;
    }
    const next = { ...participant, ...inCliOwnMode(participant.kind, participant.agentMode, participant.permissions), delegatedByParticipantId: requesterId };
    marked.set(participant.id, next);
    return next;
  });
  conversation.metadata = { ...conversation.metadata, participants };
  return added.map((participant) => marked.get(participant.id) ?? participant);
}

/** The member made for a task keeps that task's title (ChatParticipant
 *  taskTitle): the sessions view names it by it however much of the chat
 *  a device has loaded. The member as the chat has it now. */
export function withTaskTitle(conversation: Conversation, member: ChatParticipant, title: string | undefined): ChatParticipant {
  const taskTitle = title?.replace(/\s+/g, " ").trim();
  if (!taskTitle) return member;
  const next = { ...member, taskTitle };
  conversation.metadata = {
    ...conversation.metadata,
    participants: chatParticipants(conversation).map((participant) => participant.id === member.id ? next : participant)
  };
  return next;
}

/** Resolves and checks a removal against the chat as it is now. Used when a
 *  member asks and again when the User approves. */
export function prepareParticipantRemoval(
  conversation: Conversation,
  requesterId: string,
  input: ParticipantRemovalInput,
  excludingApprovalId?: string,
  options: { afterAdditions?: boolean } = {}
): { request: ChatParticipantRemovalRequest; summary: string } {
  const participants = chatParticipants(conversation);
  const requester = participants.find((participant) => participant.id === requesterId);
  if (!requester) {
    throw new Error("The requesting member is no longer in this chat.");
  }
  const assistantId = participants.find((item) => item.roleConfigId === CHAT_ADMINISTRATOR_ROLE_ID)?.id;
  const operations: ChatParticipantRemovalRequest["operations"] = [];
  for (const [index, target] of input.targets.entries()) {
    const member = target.participantId
      ? participants.find((participant) => participant.id === target.participantId)
      : participantForMentionHandle(participants, target.handle ?? "");
    if (!member) {
      const number = target.operationNumber ?? index + 1;
      throw new Error(target.participantId
        ? `Member operation ${number}: no member of this chat has id ${target.participantId}.`
        : `Member operation ${number}: @${target.handle} is not a member of this chat.`);
    }
    // The member list's rules, no more: a member may remove itself too.
    if (member.id === assistantId) {
      throw new Error("Chat Assistant cannot be removed from the chat.");
    }
    if (isChatMainSession(conversation, member)) {
      throw new Error(MAIN_SESSION_NOT_REMOVABLE_MESSAGE);
    }
    if (!operations.some((operation) => operation.participantId === member.id)) {
      operations.push({ type: "remove_participant_from_chat", participantId: member.id, handle: member.handle });
    }
  }
  if (!options.afterAdditions && participants.length - operations.length < 1) {
    throw new Error("The last chat member cannot be removed.");
  }
  const open = chatAppToolApprovals(conversation).find((approval): approval is MemberRemovalApproval =>
    approval.id !== excludingApprovalId &&
    isOpenMemberRemovalApproval(approval) &&
    approval.request.operations.some((operation) =>
      operations.some((item) => item.participantId === operation.participantId)
    )
  );
  if (open) {
    throw new Error(`A removal of ${memberRemovalHandles(open.request)} is already waiting ${open.status === "pending" ? "for the User" : "to be made"}.`);
  }
  const request: ChatParticipantRemovalRequest = { kind: "participant_removal", reason: input.reason, operations };
  return { request, summary: `Remove ${memberRemovalHandles(request)} from this chat` };
}

/** Pending, or decided (by the User, or by the member's Manage members
 *  setting) and not applied yet, wherever it is applied. */
function isOpenMemberRemovalApproval(approval: ChatAppToolApproval): approval is MemberRemovalApproval {
  return approval.toolName === APP_PARTICIPANTS_REQUEST_CHANGE_TOOL &&
    isParticipantRemovalRequest(approval.request) &&
    (approval.status === "pending" || isQueuedMemberRemovalApproval(approval));
}

/** A removal the User approved, or the member's Manage members setting
 *  allowed, that this device still has to apply once the chat's turns end
 *  (any device, Д2). */
export function isQueuedMemberRemovalApproval(approval: ChatAppToolApproval): approval is MemberRemovalApproval {
  return approval.toolName === APP_PARTICIPANTS_REQUEST_CHANGE_TOOL &&
    (approval.status === "approved" || approval.status === "auto-applied") &&
    typeof approval.memberRemovalQueuedAt === "string" &&
    isParticipantRemovalRequest(approval.request);
}

/** An approved addition waiting here to be applied: one a machine member
 *  asked for before every device applied its own members' changes (Д2). */
export function isQueuedMemberAdditionApproval(approval: ChatAppToolApproval): boolean {
  return typeof approval.memberAdditionQueuedAt === "string" &&
    (approval.status === "approved" || approval.status === "auto-applied") &&
    (
      (approval.toolName === APP_PARTICIPANTS_REQUEST_CHANGE_TOOL &&
        (isParticipantChangeRequest(approval.request) || isRoleParticipantChangeRequest(approval.request))) ||
      (approval.toolName === APP_ROSTER_REQUEST_CHANGE_TOOL && isRosterChangeRequest(approval.request))
    );
}

/** "Allow for chat" on a legacy roster card: later additions by the same
 *  member and role apply without a card. */
export function upsertRosterChatPolicy(conversation: Conversation, approval: ChatAppToolApproval, now: string): void {
  upsertAppToolApprovalPolicy(conversation, {
    id: randomUUID(),
    participantId: approval.requesterParticipantId,
    roleConfigId: approval.requesterRoleConfigId,
    toolName: approval.toolName,
    capability: approval.capability,
    scope: "chat",
    createdAt: now,
    updatedAt: now
  });
}

/** Now, or strictly later than `previous`: the metadata merge keeps the
 *  newer copy of a card and lets the current one win a tie. */
export function laterThan(previous: string | undefined): string {
  const now = new Date().toISOString();
  const at = Date.parse(previous ?? "");
  return Number.isFinite(at) && Date.parse(now) <= at ? new Date(at + 1).toISOString() : now;
}

/** A machine's card asks this desktop to change the member list only for a
 *  member that machine runs, on a card that machine owns. */
export function machineRosterCardProblem(conversation: Conversation, current: ChatAppToolApproval | undefined, incoming: ChatAppToolApproval): string | undefined {
  const requester = chatParticipants(conversation).find((participant) => participant.id === incoming.requesterParticipantId);
  if (!requester) {
    return "The requesting member is no longer in this chat.";
  }
  if (!incoming.homeMachineId || requester.homeMachineId !== incoming.homeMachineId || (current && current.homeMachineId !== incoming.homeMachineId)) {
    return `The request did not come from the computer @${requester.handle} runs on.`;
  }
  return undefined;
}

/** The User's answer behind a machine member's approved roster change, as
 *  the User's server holds it (Д10: the server's word, no signature): the
 *  card the member's machine raised, answered "approve" (mirrorServerCard
 *  notes it as `server:<card>@<answered at>`). `waiting`: not answered yet. */
export async function machineRosterDecision(
  _conversation: Conversation,
  approval: ChatAppToolApproval
): Promise<MachineRosterDecision> {
  const decisionId = approval.machineAppliedDecisionId;
  if (!decisionId) {
    return { ok: false, waiting: true };
  }
  if (!decisionId.startsWith(`server:${approval.id}@`)) {
    return { ok: false, waiting: false, problem: "Your approval of this change could not be confirmed on this computer; ask for it again." };
  }
  return { ok: true };
}

/** Who an addition request adds: a saved member by its preset, a new one
 *  by its handle. */
export function memberAdditionTargets(request: ChatAppToolApprovalRequest): Array<{ handle?: string; participantConfigId?: string }> {
  const participantRequest = isRoleParticipantChangeRequest(request)
    ? request.participantRequest
    : isParticipantChangeRequest(request) ? request : undefined;
  if (participantRequest) {
    return participantRequest.operations.map((operation) => operation.type === "add_existing_participant_to_chat"
      ? { participantConfigId: operation.participantConfigId }
      : { handle: operation.participant.handle });
  }
  if (isRosterChangeRequest(request)) {
    return request.operations.map((operation) => ({ handle: operation.participant.handle }));
  }
  return [];
}

export function memberRemovalHandles(request: ChatParticipantRemovalRequest): string {
  return formatHandleList(request.operations.map((operation) => `@${operation.handle}`));
}

export function memberRemovalProblem(conversation: Conversation, approval: ChatAppToolApproval, request: ChatParticipantRemovalRequest): string | undefined {
  try {
    // The stored request is what the User saw; an edited draft never
    // changes who is removed.
    prepareParticipantRemoval(conversation, approval.requesterParticipantId, {
      reason: request.reason,
      targets: request.operations.map((operation) => ({ participantId: operation.participantId }))
    }, approval.id);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function pushMemberRemovalFailure(conversation: Conversation, approval: ChatAppToolApproval, request: ChatParticipantRemovalRequest, reason: string): void {
  conversation.messages.push(createChatMessage(
    "system",
    `Could not remove ${memberRemovalHandles(request)} at ${requesterReference(conversation, approval)}'s request: ${reason}`,
    undefined,
    { threadId: "system", rosterChange: { approvalId: approval.id, outcome: "refused", error: reason } }
  ));
}

/** The asking member as this chat's member list names it (a machine's card
 *  carries its own copy of the handle). */
export function requesterReference(conversation: Conversation, approval: ChatAppToolApproval): string {
  const requester = chatParticipants(conversation).find((participant) => participant.id === approval.requesterParticipantId);
  return `@${requester?.handle ?? approval.requesterHandle}`;
}

/** Who a roster change is about, for the chat's message. */
export function rosterChangeTargetsText(approval: ChatAppToolApproval): string {
  if (isParticipantRemovalRequest(approval.request)) {
    return memberRemovalHandles(approval.request);
  }
  let handles: string[] = [];
  try {
    handles = memberAdditionTargets(approval.request).flatMap((target) => target.handle ? [`@${target.handle.replace(/^@/, "")}`] : []);
  } catch {
    handles = [];
  }
  return handles.length > 0 ? formatHandleList(handles) : "a member";
}

/** A machine member's removal names each member by id and by handle; the
 *  User approved the handles, so they must be the members' handles here. */
export function machineRemovalHandleProblem(conversation: Conversation, request: ChatParticipantRemovalRequest): string | undefined {
  const participants = chatParticipants(conversation);
  for (const operation of request.operations) {
    const member = participants.find((participant) => participant.id === operation.participantId);
    if (member && member.handle.replace(/^@/, "").toLowerCase() !== operation.handle.replace(/^@/, "").toLowerCase()) {
      return `The request names @${operation.handle}, but that member is @${member.handle} in this chat.`;
    }
  }
  return undefined;
}

export function appToolApprovalReferencesParticipant(
  conversation: Conversation,
  approval: ChatAppToolApproval,
  participant: ChatParticipant
): boolean {
  if (approval.requesterParticipantId === participant.id) {
    return true;
  }
  if (approval.toolName === APP_PARTICIPANTS_REQUEST_CHANGE_TOOL && isParticipantRemovalRequest(approval.request)) {
    return approval.request.operations.some((operation) => operation.participantId === participant.id);
  }
  if (approval.toolName !== APP_CHAT_REQUEST_PARTICIPANTS_TOOL || !isParticipantRequestApprovalRequest(approval.request)) {
    return false;
  }
  const batch = participantRequestBatchForApproval(conversation, approval.request);
  if (batch?.items.some((item) => item.targetParticipantId === participant.id)) {
    return true;
  }
  const participantHandle = participant.handle.toLowerCase();
  return approval.request.requests.some((request) =>
    request.target.trim().replace(/^@/, "").toLowerCase() === participantHandle
  );
}

export function cleanupRemovedParticipantMessageState(
  message: ChatMessage,
  participant: ChatParticipant,
  now: string,
  removalError: string
): ChatMessage {
  const metadata = message.metadata;
  if (!metadata?.pendingMentions?.length && !metadata?.participantRequest && !metadata?.pendingChoice) {
    return message;
  }
  let changed = false;
  let nextMetadata: ChatMessageMetadata = { ...metadata };
  // The member's own cards: nobody is left to take an answer to them.
  if (message.participantId === participant.id) {
    if (metadata.pendingChoice?.status === "pending") {
      nextMetadata = { ...nextMetadata, pendingChoice: choiceClosedForGoneMember(metadata.pendingChoice, now) };
      changed = true;
    }
    if (metadata.pendingMentions?.some((mention) => mention.status === "pending")) {
      nextMetadata = { ...nextMetadata, pendingMentions: metadata.pendingMentions.map((mention) =>
        mention.status === "pending" ? { ...mention, status: "rejected" as const } : mention) };
      changed = true;
    }
  }
  if (nextMetadata.pendingMentions?.length) {
    const before = nextMetadata.pendingMentions;
    const pendingMentions = before.filter((mention) => mention.targetParticipantId !== participant.id);
    if (pendingMentions.length !== before.length) {
      changed = true;
      if (pendingMentions.length > 0) {
        nextMetadata = { ...nextMetadata, pendingMentions };
      } else {
        const { pendingMentions: _removed, ...rest } = nextMetadata;
        nextMetadata = rest;
      }
    }
  }
  if (metadata.participantRequest) {
    const nextBatch = cleanupRemovedParticipantRequestBatch(metadata.participantRequest, participant, now, removalError);
    if (nextBatch !== metadata.participantRequest) {
      changed = true;
      nextMetadata = { ...nextMetadata, participantRequest: nextBatch };
    }
  }
  return changed ? { ...message, metadata: nextMetadata } : message;
}

function cleanupRemovedParticipantRequestBatch(
  batch: ChatParticipantRequestBatch,
  participant: ChatParticipant,
  now: string,
  removalError: string
): ChatParticipantRequestBatch {
  const requesterRemoved = batch.requesterParticipantId === participant.id;
  let changed = false;
  const items = batch.items.map((item) => {
    if (
      (requesterRemoved || item.targetParticipantId === participant.id) &&
      isOpenParticipantRequestStatus(item.status)
    ) {
      changed = true;
      return {
        ...item,
        status: "failed" as const,
        error: removalError,
        updatedAt: now
      };
    }
    return item;
  });
  if (!changed) {
    return batch;
  }
  return {
    ...batch,
    items,
    status: rollupParticipantRequestStatus(items),
    error: requesterRemoved ? removalError : batch.error,
    updatedAt: now
  };
}

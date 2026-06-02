import { normalizeAgentContextUsage } from "../../../shared/agentContext";
import type {
  AgentContextUsage,
  AgentRunProgress,
  ChatAppToolApproval,
  ChatImageAttachment,
  ChatMessage,
  ChatParticipant,
  ChatParticipantRequestApprovalRequest,
  ChatParticipantRequestBatch,
  ChatPermissionChangeRequest,
  ChatPermissionGrant,
  ChatRoleConfig,
  ChatShellPermissionRule,
  ChatParticipantSession,
  Conversation,
  RepoFileMention,
  ReviewProgress
} from "../../../shared/types";

export const APP_PERMISSIONS_REQUEST_CHANGE_TOOL = "app_permissions_request_change";
export const APP_ROSTER_REQUEST_CHANGE_TOOL = "app_roster_request_change";
export const APP_CHAT_REQUEST_PARTICIPANTS_TOOL = "app_chat_request_participants";
export const CHAT_CUSTOM_CHOICE_OPTION_ID = "__custom__";

const SHOW_CHAT_SYSTEM_MESSAGES = import.meta.env.VITE_AI_CONSENSUS_SHOW_SYSTEM_MESSAGES === "1";

export interface ChatThinkingRow {
  key: string;
  participantId?: string;
  participantLabel: string;
  activity?: string;
  startedAt: string;
  updatedAt: string;
}

export type ChatTimelineRow =
  | { type: "load-older"; id: string }
  | { type: "message"; id: string; message: ChatMessage }
  | { type: "thinking"; id: string; row: ChatThinkingRow };

export function chatThinkingRows(progress: ReviewProgress[]): ChatThinkingRow[] {
  const rows = new Map<string, ChatThinkingRow>();
  for (const item of progress) {
    if (item.phase === "done" || item.phase === "cancelled" || item.phase === "error") {
      rows.clear();
      continue;
    }
    const agentProgress = item.agentProgress;
    if (!agentProgress) {
      continue;
    }
    if (agentProgress.messageId) {
      continue;
    }
    const participantLabel = agentProgress.participantLabel || item.participantLabel || "Agent";
    const key = agentProgress.participantId || participantLabel;
    if (agentProgress.state === "finished") {
      rows.delete(key);
      continue;
    }
    const current = rows.get(key);
    rows.set(key, {
      key,
      participantId: agentProgress.participantId ?? current?.participantId,
      participantLabel,
      activity: agentProgress.activity?.trim() || current?.activity,
      startedAt: current?.startedAt ?? item.createdAt,
      updatedAt: item.createdAt
    });
  }
  return Array.from(rows.values()).sort((left, right) => left.startedAt.localeCompare(right.startedAt));
}

export function liveMessageProgressById(progress: ReviewProgress[]): Map<string, AgentRunProgress> {
  const map = new Map<string, AgentRunProgress>();
  for (const item of progress) {
    if (item.phase === "done" || item.phase === "cancelled" || item.phase === "error") {
      map.clear();
      continue;
    }
    const agentProgress = item.agentProgress;
    if (!agentProgress?.messageId) {
      continue;
    }
    if (agentProgress.state === "finished") {
      map.delete(agentProgress.messageId);
      continue;
    }
    map.set(agentProgress.messageId, agentProgress);
  }
  return map;
}

export function chatParticipants(conversation: Conversation | undefined): ChatParticipant[] {
  const value = conversation?.metadata.participants;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is ChatParticipant => {
    const participant = item as Partial<ChatParticipant>;
    return (
      typeof participant.id === "string" &&
      typeof participant.handle === "string" &&
      typeof participant.roleConfigId === "string" &&
      (participant.kind === "codex-cli" || participant.kind === "claude-code")
    );
  });
}

export function chatAppToolApprovals(conversation: Conversation | undefined): ChatAppToolApproval[] {
  const value = conversation?.metadata.pendingAppToolApprovals;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is ChatAppToolApproval => {
    const approval = item as Partial<ChatAppToolApproval>;
    const request = approval.request;
    const isRosterRequest =
      approval.toolName === APP_ROSTER_REQUEST_CHANGE_TOOL &&
      request &&
      typeof request === "object" &&
      !Array.isArray(request) &&
      Array.isArray((request as { operations?: unknown }).operations);
    const isPermissionRequest =
      approval.toolName === APP_PERMISSIONS_REQUEST_CHANGE_TOOL &&
      Boolean(chatPermissionChangeRequest(approval as ChatAppToolApproval));
    const isParticipantRequest =
      approval.toolName === APP_CHAT_REQUEST_PARTICIPANTS_TOOL &&
      Boolean(chatParticipantRequestApprovalRequest(approval as ChatAppToolApproval));
    return (
      typeof approval.id === "string" &&
      typeof approval.requesterHandle === "string" &&
      typeof approval.summary === "string" &&
      approval.status === "pending" &&
      (isRosterRequest || isPermissionRequest || isParticipantRequest)
    );
  });
}

export function chatParticipantRequestApprovalRequest(approval: ChatAppToolApproval): ChatParticipantRequestApprovalRequest | undefined {
  if (approval.toolName !== APP_CHAT_REQUEST_PARTICIPANTS_TOOL) {
    return undefined;
  }
  const request = approval.request as Partial<ChatParticipantRequestApprovalRequest>;
  return Array.isArray(request.requests) &&
    request.requests.every((item) => (
      item &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      typeof (item as { target?: unknown }).target === "string" &&
      typeof (item as { prompt?: unknown }).prompt === "string"
    ))
    ? {
        reason: typeof request.reason === "string" ? request.reason : undefined,
        requests: request.requests,
        resumeRequester: request.resumeRequester,
        source: request.source,
        requestMessageId: request.requestMessageId,
        batchId: request.batchId
      }
    : undefined;
}

export function chatPermissionChangeRequest(approval: ChatAppToolApproval): ChatPermissionChangeRequest | undefined {
  if (approval.toolName !== APP_PERMISSIONS_REQUEST_CHANGE_TOOL) {
    return undefined;
  }
  const request = approval.request as unknown as Record<string, unknown>;
  const reason = typeof request.reason === "string" ? request.reason : undefined;
  if ((request.kind === "portable" || request.kind === undefined) && Array.isArray(request.permissions)) {
    const permissions = request.permissions.filter((permission): permission is ChatPermissionGrant =>
      permission === "workspaceWrite" || permission === "webAccess" || permission === "repoRead"
    );
    return permissions.length === request.permissions.length && permissions.length > 0
      ? { kind: "portable", reason, permissions }
      : undefined;
  }
  if (request.kind === "shellRules" && Array.isArray(request.rules)) {
    const rules = request.rules.flatMap((item): ChatShellPermissionRule[] => {
      const rule = item as Partial<ChatShellPermissionRule>;
      if (
        !item ||
        typeof item !== "object" ||
        Array.isArray(item) ||
        (rule.action !== "allow" && rule.action !== "ask" && rule.action !== "deny") ||
        (rule.match !== "exact" && rule.match !== "prefix") ||
        typeof rule.pattern !== "string"
      ) {
        return [];
      }
      const pattern = rule.pattern.trim();
      return pattern ? [{ action: rule.action, match: rule.match, pattern }] : [];
    });
    return rules.length === request.rules.length && rules.length > 0
      ? { kind: "shellRules", reason, rules }
      : undefined;
  }
  if (request.kind === "providerNative" && request.provider === "claude-code" && Array.isArray(request.allowedTools)) {
    const allowedTools = request.allowedTools
      .map((token) => (typeof token === "string" ? token.trim() : ""))
      .filter((token) => token.length > 0);
    return allowedTools.length === request.allowedTools.length && allowedTools.length > 0
      ? { kind: "providerNative", reason, provider: "claude-code", allowedTools }
      : undefined;
  }
  return undefined;
}

export function chatPermissionGrantLabel(permission: ChatPermissionGrant): string {
  if (permission === "repoRead") {
    return "Repository read";
  }
  return permission === "workspaceWrite" ? "File editing" : "Web access";
}

export function chatPermissionGrantDescription(permission: ChatPermissionGrant): string {
  if (permission === "repoRead") {
    return "Allow read-only inspection of files in the selected repository.";
  }
  return permission === "workspaceWrite"
    ? "Allow file edits in the selected repository."
    : "Allow web search and fetch when the CLI supports it.";
}

export function participantRequestStatusLabel(batch: ChatParticipantRequestBatch): string {
  const targets = batch.items.map((item) => `@${item.targetHandle}`).join(", ");
  if (batch.status === "pending_approval") {
    return `Approval needed for ${targets}`;
  }
  if (batch.status === "running") {
    return `Running ${targets}`;
  }
  if (batch.status === "answered") {
    return `Answered by ${targets}`;
  }
  if (batch.status === "resuming_requester") {
    return `Returning to @${batch.requesterHandle}`;
  }
  if (batch.status === "completed") {
    return "Completed";
  }
  if (batch.status === "denied") {
    return "Denied";
  }
  if (batch.status === "failed") {
    return "Failed";
  }
  return "Interrupted";
}

export function chatContextUsageByParticipant(conversation: Conversation | undefined): Map<string, AgentContextUsage> {
  const value = conversation?.metadata.agentContextUsageByParticipant;
  const usageByParticipant = new Map<string, AgentContextUsage>();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return usageByParticipant;
  }
  for (const [participantId, usage] of Object.entries(value)) {
    const normalized = normalizeAgentContextUsage(usage);
    if (normalized) {
      usageByParticipant.set(participantId, normalized);
    }
  }
  return usageByParticipant;
}

export function chatSessionsByParticipant(conversation: Conversation | undefined): Map<string, ChatParticipantSession> {
  const value = conversation?.metadata.participantSessions;
  const sessions = new Map<string, ChatParticipantSession>();
  if (!Array.isArray(value)) {
    return sessions;
  }
  for (const item of value) {
    const session = item as Partial<ChatParticipantSession>;
    if (typeof session.participantId === "string" && typeof session.sessionId === "string") {
      sessions.set(session.participantId, session as ChatParticipantSession);
    }
  }
  return sessions;
}

export function contextUsageForMessage(
  message: Conversation["messages"][number],
  usageByParticipant: Map<string, AgentContextUsage>
): AgentContextUsage | undefined {
  return message.role === "participant" && message.participantId ? usageByParticipant.get(message.participantId) : undefined;
}

export function sessionIdForMessage(
  message: Conversation["messages"][number],
  sessionsByParticipant: Map<string, ChatParticipantSession>
): string | undefined {
  return message.role === "participant" && message.participantId
    ? sessionsByParticipant.get(message.participantId)?.sessionId || undefined
    : undefined;
}

export function chatMessageRepoFileMentions(message: Conversation["messages"][number]): RepoFileMention[] {
  const mentions = message.metadata?.repoFileMentions;
  if (!Array.isArray(mentions)) {
    return [];
  }
  const seen = new Set<string>();
  return mentions.flatMap((mention): RepoFileMention[] => {
    const filePath = typeof mention?.path === "string" ? mention.path.trim() : "";
    if (!filePath || seen.has(filePath)) {
      return [];
    }
    seen.add(filePath);
    return [{ path: filePath }];
  });
}

export function chatMessageImageAttachments(message: Conversation["messages"][number]): ChatImageAttachment[] {
  const attachments = message.metadata?.imageAttachments;
  if (!Array.isArray(attachments)) {
    return [];
  }
  const seen = new Set<string>();
  return attachments.flatMap((attachment): ChatImageAttachment[] => {
    if (
      !attachment ||
      typeof attachment !== "object" ||
      typeof attachment.id !== "string" ||
      seen.has(attachment.id)
    ) {
      return [];
    }
    seen.add(attachment.id);
    return [attachment as ChatImageAttachment];
  });
}

export function chatTopLevelMessages(conversation: Conversation): Conversation["messages"] {
  const participantRequestReplyRoots = chatParticipantRequestReplyRootMap(conversation);
  return conversation.messages.filter((message) => !isHiddenChatMessage(message) && !chatVisualThreadRootId(message, participantRequestReplyRoots));
}

export function chatThreadSummaryMap(conversation: Conversation): Map<string, { replies: Conversation["messages"]; latestReplyAt?: string }> {
  const summaries = new Map<string, { replies: Conversation["messages"]; latestReplyAt?: string }>();
  const participantRequestReplyRoots = chatParticipantRequestReplyRootMap(conversation);
  for (const message of conversation.messages) {
    if (isHiddenChatMessage(message)) {
      continue;
    }
    const rootId = chatVisualThreadRootId(message, participantRequestReplyRoots);
    if (!rootId) {
      continue;
    }
    const summary = summaries.get(rootId) ?? { replies: [] };
    summary.replies.push(message);
    if (!summary.latestReplyAt || Date.parse(message.createdAt) > Date.parse(summary.latestReplyAt)) {
      summary.latestReplyAt = message.createdAt;
    }
    summaries.set(rootId, summary);
  }
  for (const summary of summaries.values()) {
    summary.replies.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  }
  return summaries;
}

function isHiddenChatMessage(message: Conversation["messages"][number]): boolean {
  const content = message.content.trim();
  if (message.role === "participant") {
    return isParticipantRequestWaitingStatus(content);
  }
  if (message.role !== "system") {
    return false;
  }
  return !SHOW_CHAT_SYSTEM_MESSAGES;
}

function isParticipantRequestWaitingStatus(content: string): boolean {
  return (
    /^(?:participant request is awaiting user approval|awaiting user approval|waiting for user approval)\.?$/i.test(content) ||
    /^Asked\s+@[\w-]+(?:\s*,\s*@[\w-]+)*\.?\s+The participant request is awaiting User approval\.?$/i.test(content)
  );
}

export function chatContinuedMentionRequestIds(conversation: Conversation): Set<string> {
  return new Set(
    conversation.messages
      .filter((message) => message.metadata?.approvedContinuation && message.metadata.sourceMessageId)
      .map((message) => message.metadata?.sourceMessageId as string)
  );
}

function chatParticipantRequestReplyRootMap(conversation: Conversation): Map<string, string> {
  const roots = new Map<string, string>();
  for (const message of conversation.messages) {
    const batch = message.metadata?.participantRequest;
    if (!batch) {
      continue;
    }
    for (const item of batch.items) {
      if (item.replyMessageId) {
        roots.set(item.replyMessageId, message.id);
      }
    }
  }
  return roots;
}

function chatVisualThreadRootId(message: Conversation["messages"][number], participantRequestReplyRoots = new Map<string, string>()): string | undefined {
  if (message.metadata?.chatThreadRootId) {
    return message.metadata.chatThreadRootId;
  }
  const participantRequestRootId = participantRequestReplyRoots.get(message.id);
  if (participantRequestRootId) {
    return participantRequestRootId;
  }
  if (message.role === "user" && message.metadata?.parentMessageId) {
    return message.metadata.threadId ?? message.metadata.parentMessageId;
  }
  return undefined;
}

export function formatChatReplyDate(value: string): string {
  return new Date(value).toLocaleString();
}

export function formatChatChoiceReceiptTime(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true }).toUpperCase();
}

export function chatRoleLabel(roles: ChatRoleConfig[], participant: Pick<ChatParticipant, "roleConfigId">): string {
  return roles.find((role) => role.id === participant.roleConfigId)?.label ?? participant.roleConfigId;
}

export function chatDisplayContent(message: Conversation["messages"][number], author: string): string {
  if (message.metadata?.participantRequest) {
    return participantRequestDisplayContent(message.metadata.participantRequest);
  }
  if (message.role !== "participant") {
    return message.content;
  }
  const lines = message.content.replace(/\r\n/g, "\n").split("\n");
  const firstContentIndex = lines.findIndex((line) => line.trim());
  if (firstContentIndex < 0) {
    return "";
  }
  const firstLine = lines[firstContentIndex].trim();
  const labels = [author, message.participantLabel].filter((value): value is string => Boolean(value));
  if (!labels.some((label) => firstLine === label || firstLine === `@${label.replace(/^@/, "")}`)) {
    return stripChatControlBlocks(message.content);
  }
  const next = [...lines.slice(0, firstContentIndex), ...lines.slice(firstContentIndex + 1)];
  while (next.length > 0 && !next[0].trim()) {
    next.shift();
  }
  return stripChatControlBlocks(next.join("\n"));
}

function participantRequestDisplayContent(batch: ChatParticipantRequestBatch): string {
  if (batch.source === "inferred") {
    const targets = batch.items.map((item) => `@${item.targetHandle}`).join(", ");
    return `Asked ${targets} for input.`;
  }
  return batch.items.map((item) => `@${item.targetHandle} ${item.prompt}`.trim()).join("\n");
}

function stripChatControlBlocks(content: string): string {
  return stripUserChoiceBlocks(stripNoParticipantRequests(content)).trimEnd();
}

function stripNoParticipantRequests(content: string): string {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const next: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (/^participant requests\s*:\s*none\.?$/i.test(trimmed)) {
      continue;
    }
    if (/^participant requests\s*:\s*$/i.test(trimmed)) {
      const following = lines[index + 1]?.trim();
      if (following && /^(?:[-*]|\d+[.)])\s+none\.?$/i.test(following)) {
        index += 1;
        continue;
      }
    }
    next.push(line);
  }
  return next.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

function stripUserChoiceBlocks(content: string): string {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const nextLines: string[] = [];
  let inFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (/^```/.test(trimmed)) {
      inFence = !inFence;
      nextLines.push(lines[index]);
      continue;
    }
    if (inFence || !/^user choice\s*:/i.test(trimmed)) {
      nextLines.push(lines[index]);
      continue;
    }
    for (let blockIndex = index + 1; blockIndex < lines.length; blockIndex += 1) {
      const blockTrimmed = lines[blockIndex].trim();
      if (!blockTrimmed) {
        index = blockIndex;
        continue;
      }
      if (isUserChoiceDisplayProtocolLine(blockTrimmed)) {
        index = blockIndex;
        continue;
      }
      break;
    }
  }
  return nextLines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

function isUserChoiceDisplayProtocolLine(line: string): boolean {
  const normalized = line.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "").trim();
  return /^(?:T|TITLE|Q|QUESTION|R|RECOMMENDED|O\d+)\s*[:|]/i.test(normalized);
}

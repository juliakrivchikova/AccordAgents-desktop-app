import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type {
  ChatAppToolApprovalPolicy, ChatMessage, ChatParticipant, ChatParticipantRequestPermission, ChatProviderKind, ChatSkillMention, Conversation,
  RepoFileMention
} from "../../../../shared/types";
import {
  effectiveChatAgentPermissionsForProvider, normalizeChatAgentMode, normalizeChatAgentPermissions
} from "../../../../shared/agentPermissions";
import {
  chatParticipantForMentionHandle, extractChatMentions, mentionHandlesForChatParticipant, resolveChatDeliveryTargets,
  resolveChatMentionTargets
} from "../../../../shared/chatDeliveryPolicy";
import { sanitizeChatSkillMention } from "../../userSkills";
import type { UserSkillRunContext } from "../../userSkills";
import { CHAT_ADMINISTRATOR_ROLE_ID } from "../constants";
import { chatParticipants } from "../members/identity";
import { chatDeliveryPolicyOptions } from "../turns/deliveryTargets";
import type { ChatDispatchReplyContext } from "../types";

export function userSkillRunContext(conversation: Conversation, content: string, context?: ChatDispatchReplyContext): UserSkillRunContext {
  const dispatch = resolveDispatchTargetsForContent(conversation, content, context);
  const participantProviderKindById: Record<string, ChatProviderKind> = {};
  const runRootByParticipant: Record<string, string | undefined> = {};
  const runRootByProvider: Partial<Record<ChatProviderKind, string | undefined>> = {};
  for (const participant of dispatch.targets) {
    const agentMode = normalizeChatAgentMode(participant.agentMode);
    const permissions = effectiveChatAgentPermissionsForProvider(
      participant.kind,
      agentMode,
      normalizeChatAgentPermissions(participant.permissions)
    );
    const runRoot = permissions.repoRead ? conversation.repoPath : undefined;
    participantProviderKindById[participant.id] = participant.kind;
    runRootByParticipant[participant.id] = runRoot;
    if (Object.prototype.hasOwnProperty.call(runRootByProvider, participant.kind) && runRootByProvider[participant.kind] !== runRoot) {
      runRootByProvider[participant.kind] = undefined;
    } else {
      runRootByProvider[participant.kind] = runRoot;
    }
  }
  return {
    repoPath: conversation.repoPath,
    target: {
      participantIds: dispatch.targets.map((participant) => participant.id),
      providerKinds: Array.from(new Set(dispatch.targets.map((participant) => participant.kind))).sort(),
      hasClearTargets: dispatch.targets.length > 0 && dispatch.unknownHandles.length === 0
    },
    participantProviderKindById,
    runRootByParticipant,
    runRootByProvider
  };
}

export async function validateRepoFileMentions(
  conversation: Conversation,
  rawMentions: RepoFileMention[] | undefined,
  warnings: string[],
  content?: string
): Promise<RepoFileMention[]> {
  const candidates: Array<{ path: unknown; source: "request" | "content" }> = [];
  if (Array.isArray(rawMentions)) {
    candidates.push(...rawMentions.map((mention) => ({ path: mention?.path, source: "request" as const })));
  }
  candidates.push(...extractRepoFileMentionPaths(content).map((mentionPath) => ({ path: mentionPath, source: "content" as const })));
  if (candidates.length === 0) {
    return [];
  }
  if (!conversation.repoPath) {
    warnings.push("Skipped repository file mentions because this chat has no selected repository.");
    return [];
  }

  let repoRealPath: string;
  try {
    repoRealPath = await realpath(conversation.repoPath);
  } catch {
    warnings.push("Skipped repository file mentions because the selected repository no longer exists.");
    return [];
  }

  const mentions: RepoFileMention[] = [];
  const seen = new Set<string>();
  for (const item of candidates) {
    const normalizedPath = normalizeRepoFileMentionPath(item.path);
    if (!normalizedPath) {
      if (item.source === "request" || shouldWarnForParsedRepoFileMention(String(item.path ?? ""))) {
        warnings.push("Skipped repository file mention because the path is invalid.");
      }
      continue;
    }
    if (seen.has(normalizedPath)) {
      continue;
    }
    seen.add(normalizedPath);

    const absolutePath = path.resolve(conversation.repoPath, normalizedPath);
    if (!isPathInside(path.resolve(conversation.repoPath), absolutePath)) {
      warnings.push(`Skipped repository file mention ${normalizedPath}: path escapes repository.`);
      continue;
    }

    try {
      const linkInfo = await lstat(absolutePath);
      if (linkInfo.isDirectory()) {
        warnings.push(`Skipped repository file mention ${normalizedPath}: path is a directory.`);
        continue;
      }
      const realFilePath = await realpath(absolutePath);
      if (!isPathInside(repoRealPath, realFilePath)) {
        warnings.push(`Skipped repository file mention ${normalizedPath}: path escapes repository.`);
        continue;
      }
      const fileInfo = await stat(absolutePath);
      if (!fileInfo.isFile()) {
        warnings.push(`Skipped repository file mention ${normalizedPath}: path is not a regular file.`);
        continue;
      }
    } catch {
      if (item.source === "request" || shouldWarnForParsedRepoFileMention(normalizedPath)) {
        warnings.push(`Skipped repository file mention ${normalizedPath}: file no longer exists.`);
      }
      continue;
    }
    mentions.push({ path: normalizedPath });
  }
  return mentions;
}

function normalizeRepoFileMentionPath(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("\0") || trimmed.includes("\\") || trimmed.startsWith("/")) {
    return undefined;
  }
  const normalized = path.posix.normalize(trimmed);
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.split("/").includes("..")
  ) {
    return undefined;
  }
  return normalized;
}

function extractRepoFileMentionPaths(content: string | undefined): string[] {
  if (!content) {
    return [];
  }
  const paths: string[] = [];
  const seen = new Set<string>();
  const matches = withoutFencedCode(content).matchAll(/(^|\s)#([^\s`#]+)/g);
  for (const match of matches) {
    const normalizedPath = normalizeRepoFileMentionPath(trimRepoFileMentionToken(match[2] ?? ""));
    if (!normalizedPath || seen.has(normalizedPath)) {
      continue;
    }
    seen.add(normalizedPath);
    paths.push(normalizedPath);
  }
  return paths;
}

function trimRepoFileMentionToken(token: string): string {
  return token.replace(/[.,;:!?)]+$/g, "");
}

function shouldWarnForParsedRepoFileMention(pathValue: string): boolean {
  return pathValue.includes("/") || pathValue.includes(".");
}

export function isPathInside(parentPath: string, childPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return relative === "" || Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function defaultAdministratorDispatchTarget(conversation: Conversation): ChatParticipant | undefined {
  const participants = chatParticipants(conversation);
  return participants.find((participant) => participant.roleConfigId === CHAT_ADMINISTRATOR_ROLE_ID);
}

/** The members a message names by id (SendChatMessageRequest
 *  .targetParticipantIds), each once, in the chat's order. Every id must be
 *  a member of the chat now. */
export function explicitMessageTargets(conversation: Conversation, ids: unknown[]): ChatParticipant[] {
  const participants = chatParticipants(conversation);
  const wanted = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string" || !id.trim()) {
      throw new Error("A message can be sent only to members of this chat.");
    }
    if (!participants.some((participant) => participant.id === id.trim())) {
      throw new Error(`No member of this chat has id ${id.trim().slice(0, 80)}.`);
    }
    wanted.add(id.trim());
  }
  return participants.filter((participant) => wanted.has(participant.id));
}

export function resolveDispatchTargetsForContent(
  conversation: Conversation,
  content: string,
  context?: ChatDispatchReplyContext
): { targets: ChatParticipant[]; unknownHandles: string[] } {
  return resolveChatDeliveryTargets({
    conversation,
    participants: chatParticipants(conversation),
    content,
    context,
    options: chatDeliveryPolicyOptions()
  });
}

export function replyContextFromMessage(message: ChatMessage): ChatDispatchReplyContext {
  return {
    parentMessageId: message.metadata?.parentMessageId,
    threadId: message.metadata?.threadId,
    chatThreadRootId: message.metadata?.chatThreadRootId
  };
}

// Routing for a no-mention send. In a thread, continue with the newest participant
// in that thread. On the timeline, continue with the newest visible top-level
// participant. Parent author is only a fallback for exact-message reply contexts.
function resolveLastSenderTarget(
  conversation: Conversation,
  context?: ChatDispatchReplyContext
): ChatParticipant | undefined {
  const participants = chatParticipants(conversation);
  const participantById = (id: string | undefined): ChatParticipant | undefined =>
    id ? participants.find((participant) => participant.id === id) : undefined;

  const threadScoped = Boolean(context?.threadId || context?.chatThreadRootId);
  for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
    const message = conversation.messages[index];
    if (message.role !== "participant") {
      continue;
    }
    if (threadScoped) {
      if (!messageMatchesDispatchThread(message, context)) {
        continue;
      }
    } else if (!messageIsVisibleTopLevelChatParticipant(message)) {
      continue;
    }
    const author = participantById(message.participantId);
    if (author) {
      return author;
    }
  }

  if (context?.parentMessageId) {
    const parent = conversation.messages.find((message) => message.id === context.parentMessageId);
    if (parent?.role === "participant") {
      return participantById(parent.participantId);
    }
  }

  return undefined;
}

function messageMatchesDispatchThread(message: ChatMessage, context: ChatDispatchReplyContext | undefined): boolean {
  if (context?.threadId && message.metadata?.threadId === context.threadId) {
    return true;
  }
  if (!context?.chatThreadRootId) {
    return false;
  }
  return (
    message.id === context.chatThreadRootId ||
    message.metadata?.chatThreadRootId === context.chatThreadRootId ||
    message.metadata?.threadId === context.chatThreadRootId
  );
}

function messageIsVisibleTopLevelChatParticipant(message: ChatMessage): boolean {
  return message.metadata?.hiddenFromTimeline !== true && !message.metadata?.chatThreadRootId;
}

// The timeline reads this text back as the Accord card
// (src/shared/accordLaunchCard.ts); a change to its wording goes there too.
export function accordStartMessageContent(
  facilitator: ChatParticipant,
  targets: ChatParticipant[],
  subject: string,
  /** The facilitator's leave to ask members once it starts (the member that
   *  starts it gives no more than its own): what the last line tells it. */
  leave: ChatParticipantRequestPermission = "allow"
): string {
  const targetNames = targets.map((target) => target.handle).join(", ");
  const leaveLine = leave === "allow"
    ? "The app has enabled request-members permission for you in this chat; the user can revoke it from your member controls."
    : leave === "ask"
      ? "The app has left your requests to members to the user's approval in this chat, as for the member who started it; the user can change it from your member controls."
      : "The app has not enabled request-members permission for you in this chat; ask the user for it before you ask the members.";
  return [
    `@${facilitator.handle} /accord`,
    "",
    "Subject:",
    subject,
    "",
    `Selected accord members: ${targetNames}.`,
    `Run the accord skill for exactly those selected members and this subject. Use app_chat_request_participants for those members only. ${leaveLine}`
  ].join("\n");
}

export function hasStandaloneAccordSkillToken(content: string): boolean {
  return /(^|\s)\/accord\b/i.test(withoutInlineCode(withoutFencedCode(content)));
}

function withoutInlineCode(content: string): string {
  return content.replace(/`[^`\r\n]*`/g, "");
}

function resolveMentionTargets(conversation: Conversation, content: string): { targets: ChatParticipant[]; unknownHandles: string[] } {
  return resolveChatMentionTargets(chatParticipants(conversation), content, chatDeliveryPolicyOptions());
}

export function participantForMentionHandle(participants: ChatParticipant[], handle: string): ChatParticipant | undefined {
  return chatParticipantForMentionHandle(participants, handle, chatDeliveryPolicyOptions());
}

export function mentionHandlesForParticipant(participant: ChatParticipant): string[] {
  return mentionHandlesForChatParticipant(participant, chatDeliveryPolicyOptions());
}

export function extractMentions(content: string): string[] {
  return extractChatMentions(content);
}

export function withoutFencedCode(content: string): string {
  return content.replace(/```[\s\S]*?```/g, "");
}

export function chatSkillMentionsFromRaw(rawMentions: ChatSkillMention[] | undefined): ChatSkillMention[] {
  if (!Array.isArray(rawMentions)) {
    return [];
  }
  const seen = new Set<string>();
  const mentions: ChatSkillMention[] = [];
  for (const rawMention of rawMentions) {
    const mention = sanitizeChatSkillMention(rawMention);
    if (!mention || seen.has(mention.skillId)) {
      continue;
    }
    seen.add(mention.skillId);
    mentions.push(mention);
  }
  return mentions;
}

export function chatSkillMentions(message: ChatMessage): ChatSkillMention[] {
  return chatSkillMentionsFromRaw(message.metadata?.skillMentions);
}

export function repoFileMentions(message: ChatMessage): RepoFileMention[] {
  const seen = new Set<string>();
  const mentions: RepoFileMention[] = [];
  for (const mention of message.metadata?.repoFileMentions ?? []) {
    const normalizedPath = normalizeRepoFileMentionPath(mention.path);
    if (!normalizedPath || seen.has(normalizedPath)) {
      continue;
    }
    seen.add(normalizedPath);
    mentions.push({ path: normalizedPath });
  }
  return mentions;
}

export function clearLegacyAccordState(conversation: Conversation): boolean {
  const metadata = conversation.metadata;
  const nextMetadata: Conversation["metadata"] = { ...metadata };
  let changed = false;
  if ("accordLaunch" in nextMetadata) {
    delete nextMetadata.accordLaunch;
    changed = true;
  }
  if ("accordRun" in nextMetadata) {
    delete nextMetadata.accordRun;
    changed = true;
  }
  if (Array.isArray(metadata.appToolApprovalPolicies)) {
    const nextPolicies = metadata.appToolApprovalPolicies.filter((policy) => {
      if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
        return false;
      }
      const candidate = policy as Partial<ChatAppToolApprovalPolicy> & { accordLaunchId?: unknown; expiresAt?: unknown };
      return candidate.capability !== "participants.request" &&
        candidate.accordLaunchId === undefined &&
        candidate.expiresAt === undefined;
    });
    if (nextPolicies.length !== metadata.appToolApprovalPolicies.length) {
      nextMetadata.appToolApprovalPolicies = nextPolicies;
      changed = true;
    }
  }
  if (changed) {
    conversation.metadata = nextMetadata;
  }
  return changed;
}

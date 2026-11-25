import { newChatIntro } from "../../../../shared/newChat";
import type {
  AgentHealth, AppSettings, ChatMessage, ChatParticipant, ChatProviderKind, Conversation, SendChatMessageRequest
} from "../../../../shared/types";
import { normalizeManualChatTitle } from "../../../../shared/chatTitles";
import { NO_READY_CLI_MESSAGE, readyProviderKinds } from "../../../../shared/cliReadiness";
import type { ChatAppMcpActor } from "../types";

interface ChatAutoTitleMetadata {
  source: "first-agent" | "manual";
  title: string;
  appliedAt: string;
  participantId?: string;
  runId?: string;
  triggerMessageId?: string;
}

interface ChatAutoTitleEligibilityMetadata {
  triggerMessageId: string;
  targetParticipantIds: string[];
  targetRunIds: Record<string, string>;
  createdAt: string;
}

/** Why this computer starts no chat now, in the words its New chat uses;
 *  undefined when it can. */
export function newChatBlockedReason(agents: AgentHealth[], settings: AppSettings, assistantKind: ChatProviderKind | undefined): string | undefined {
  // A saved Assistant CLI that is not ready gives way to a ready one
  // (resolveAssistantProviderKind): only no ready CLI at all stops a chat.
  return readyProviderKinds(agents, settings.providers).length === 0 || !assistantKind ? NO_READY_CLI_MESSAGE : undefined;
}

export function chatIntro(participants: ChatParticipant[]): string {
  return newChatIntro(participants.map((participant) => participant.handle));
}

export function normalizeChatTitle(value: string): string {
  return normalizeManualChatTitle(value);
}

export function normalizeChatTitleToolRequest(value: unknown): { title: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Chat title request must be an object.");
  }
  const title = (value as { title?: unknown }).title;
  if (typeof title !== "string") {
    throw new Error("Chat title request requires a string title.");
  }
  return { title };
}

export function shouldCreateInitialAutoTitleEligibility(
  conversation: Conversation,
  request: SendChatMessageRequest,
  targets: ChatParticipant[]
): boolean {
  if (targets.length === 0) {
    return false;
  }
  if (conversation.metadata.autoTitle || conversation.metadata.autoTitleEligibility) {
    return false;
  }
  if (request.threadId?.trim() || request.parentMessageId?.trim() || request.chatThreadRootId?.trim()) {
    return false;
  }
  return !conversation.messages.some((message) => message.role === "user" || message.role === "participant");
}

export function initialAutoTitleEligibility(
  triggerMessage: ChatMessage,
  targets: ChatParticipant[],
  targetRunIds: ReadonlyMap<string, string>
): ChatAutoTitleEligibilityMetadata {
  const targetParticipantIds = targets.map((target) => target.id);
  const runIds: Record<string, string> = {};
  for (const participantId of targetParticipantIds) {
    const runId = targetRunIds.get(participantId);
    if (runId) {
      runIds[participantId] = runId;
    }
  }
  return {
    triggerMessageId: triggerMessage.id,
    targetParticipantIds,
    targetRunIds: runIds,
    createdAt: new Date().toISOString()
  };
}

export function chatAutoTitleMetadata(conversation: Conversation): ChatAutoTitleMetadata | undefined {
  const value = conversation.metadata.autoTitle;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Partial<ChatAutoTitleMetadata>;
  if (
    (record.source !== "first-agent" && record.source !== "manual") ||
    typeof record.title !== "string" ||
    typeof record.appliedAt !== "string"
  ) {
    return undefined;
  }
  return {
    source: record.source,
    title: record.title,
    appliedAt: record.appliedAt,
    participantId: typeof record.participantId === "string" ? record.participantId : undefined,
    runId: typeof record.runId === "string" ? record.runId : undefined,
    triggerMessageId: typeof record.triggerMessageId === "string" ? record.triggerMessageId : undefined
  };
}

export function chatAutoTitleEligibility(conversation: Conversation): ChatAutoTitleEligibilityMetadata | undefined {
  const value = conversation.metadata.autoTitleEligibility;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Partial<ChatAutoTitleEligibilityMetadata>;
  if (
    typeof record.triggerMessageId !== "string" ||
    !Array.isArray(record.targetParticipantIds) ||
    !record.targetParticipantIds.every((id): id is string => typeof id === "string" && id.length > 0) ||
    !record.targetRunIds ||
    typeof record.targetRunIds !== "object" ||
    Array.isArray(record.targetRunIds) ||
    typeof record.createdAt !== "string"
  ) {
    return undefined;
  }
  const targetRunIds: Record<string, string> = {};
  for (const [participantId, runId] of Object.entries(record.targetRunIds)) {
    if (typeof runId === "string" && runId.length > 0) {
      targetRunIds[participantId] = runId;
    }
  }
  return {
    triggerMessageId: record.triggerMessageId,
    targetParticipantIds: record.targetParticipantIds,
    targetRunIds,
    createdAt: record.createdAt
  };
}

export function actorMatchesAutoTitleEligibility(
  actor: ChatAppMcpActor,
  eligibility: ChatAutoTitleEligibilityMetadata | undefined
): boolean {
  if (!eligibility || actor.continuation) {
    return false;
  }
  if (!actor.triggerMessageId || actor.triggerMessageId !== eligibility.triggerMessageId) {
    return false;
  }
  if (!eligibility.targetParticipantIds.includes(actor.participantId)) {
    return false;
  }
  const expectedRunId = eligibility.targetRunIds[actor.participantId];
  return Boolean(expectedRunId && actor.runId && actor.runId === expectedRunId);
}

export function metadataWithManualChatTitle(
  metadata: Record<string, unknown>,
  title: string,
  appliedAt: string
): Record<string, unknown> {
  return metadataWithoutAutoTitleEligibility({
    ...metadata,
    autoTitle: {
      source: "manual",
      title,
      appliedAt
    } satisfies ChatAutoTitleMetadata
  });
}

export function metadataWithFirstAgentChatTitle(
  metadata: Record<string, unknown>,
  autoTitle: ChatAutoTitleMetadata
): Record<string, unknown> {
  return metadataWithoutAutoTitleEligibility({
    ...metadata,
    autoTitle
  });
}

export function metadataWithoutAutoTitleEligibility(metadata: Record<string, unknown>): Record<string, unknown> {
  const { autoTitleEligibility: _autoTitleEligibility, ...rest } = metadata;
  return rest;
}

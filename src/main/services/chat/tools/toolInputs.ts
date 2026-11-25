import type { ChatAccordResolutionMetadata, ChatMessage, ChatMessageReactions, Conversation } from "../../../../shared/types";
import { normalizeChatReactionEmoji } from "../../../../shared/chatReactions";
import { normalizeChatImageMimeType } from "../attachments/imageRecords";
import { CHAT_CONTEXT_READ_DEFAULT_LIMIT, CHAT_IMAGE_MAX_ATTACHMENTS } from "../constants";
import { messageAuthor } from "../members/identity";
import { normalizedChatMessageReactions } from "../store/mergeStoredChat";
import { messageContentPreview } from "../store/messages";
import { CHAT_CONTEXT_READ_MAX_LIMIT } from "./constants";
import type { ChatReactionMutationResult } from "./types";
import type { ChatToolImageAttachmentInput } from "../types";

interface ChatReactionActor {
  actorId: string;
  actorLabel: string;
  actorKind: "user" | "participant";
}

// A hard transport ceiling, not a truncation point. The send path rejects over-limit content
// with an explicit error and never shortens it, so the canonical /accord message keeps the
// exact text participants approve. Sits well under the MCP body cap (1 MB).
const CHAT_SEND_MESSAGE_MAX_CONTENT_LENGTH = 200_000;

export function normalizeChatReactionRequest(raw: unknown): { messageId: string; emoji: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Reaction request must be an object.");
  }
  const record = raw as Record<string, unknown>;
  const messageId = typeof record.messageId === "string" ? record.messageId.trim() : "";
  if (!messageId) {
    throw new Error("Reaction request needs messageId from app_chat_read_messages.");
  }
  return {
    messageId,
    emoji: normalizeChatReactionEmoji(record.emoji)
  };
}

export function normalizeChatSendMessageRequest(raw: unknown): {
  content: string;
  attachments: ChatToolImageAttachmentInput[];
  threadId?: string;
  parentMessageId?: string;
  chatThreadRootId?: string;
  accordResolution?: ChatAccordResolutionMetadata;
} {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Send-message request must be an object.");
  }
  const record = raw as Record<string, unknown>;
  // Preserve the exact submitted content (no trimming/normalization). The trimmed copy is
  // used only to reject empty/whitespace-only input. Over-limit content is rejected with an
  // explicit error, never silently shortened, so the canonical message keeps the exact text.
  if (record.content !== undefined && record.content !== null && typeof record.content !== "string") {
    throw new Error("Send-message content must be a string.");
  }
  const content = typeof record.content === "string" ? record.content : "";
  const attachments = normalizeChatSendMessageAttachments(record.attachments);
  if (!content.trim() && attachments.length === 0) {
    throw new Error("Send-message request needs non-empty content or at least one image attachment.");
  }
  if (content.length > CHAT_SEND_MESSAGE_MAX_CONTENT_LENGTH) {
    throw new Error(`Send-message content exceeds ${CHAT_SEND_MESSAGE_MAX_CONTENT_LENGTH} characters; it is rejected, not truncated.`);
  }
  const optionalId = (value: unknown, field: string): string | undefined => {
    if (value === undefined || value === null) {
      return undefined;
    }
    if (typeof value !== "string") {
      throw new Error(`${field} must be a string.`);
    }
    return value.trim() || undefined;
  };
  return {
    content,
    attachments,
    threadId: optionalId(record.threadId, "threadId"),
    parentMessageId: optionalId(record.parentMessageId, "parentMessageId"),
    chatThreadRootId: optionalId(record.chatThreadRootId, "chatThreadRootId"),
    accordResolution: normalizeAccordResolutionMetadata(record.accordResolution)
  };
}

function normalizeChatSendMessageAttachments(raw: unknown): ChatToolImageAttachmentInput[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new Error("Send-message attachments must be an array.");
  }
  if (raw.length > CHAT_IMAGE_MAX_ATTACHMENTS) {
    throw new Error(`Too many images. Attach at most ${CHAT_IMAGE_MAX_ATTACHMENTS} images per message.`);
  }
  return raw.map((item, index): ChatToolImageAttachmentInput => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Send-message attachment ${index + 1} is invalid.`);
    }
    const record = item as Record<string, unknown>;
    if (record.kind !== "image") {
      throw new Error("UnsupportedAttachmentType. Problem: app_chat_send_message v1 accepts image attachments only. Cause: the attachment kind was not \"image\". Fix: pass { \"kind\": \"image\", \"sourcePath\": \"...\" }.");
    }
    if (typeof record.sourcePath !== "string") {
      throw new Error("AttachmentImportDenied. Problem: image attachment sourcePath is required. Cause: the attachment did not include a file path. Fix: pass a sourcePath for an image file visible to this run.");
    }
    const sourcePath = record.sourcePath.trim();
    if (!sourcePath || sourcePath.includes("\0")) {
      throw new Error("AttachmentImportDenied. Problem: image attachment sourcePath is invalid. Cause: the path is empty or contains a NUL byte. Fix: pass a valid image file path.");
    }
    const filename = typeof record.filename === "string" && record.filename.trim()
      ? record.filename.trim()
      : undefined;
    const mimeType = record.mimeType === undefined || record.mimeType === null
      ? undefined
      : (typeof record.mimeType === "string"
          ? normalizeChatImageMimeType(record.mimeType)
          : (() => { throw new Error("AttachmentImportDenied. Problem: image attachment mimeType must be a string. Cause: the supplied MIME type is invalid. Fix: omit mimeType or pass image/png, image/jpeg, or image/webp."); })());
    return {
      kind: "image",
      sourcePath,
      filename,
      mimeType
    };
  });
}

function normalizeAccordResolutionMetadata(raw: unknown): ChatAccordResolutionMetadata | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("accordResolution must be an object.");
  }
  const record = raw as Record<string, unknown>;
  const stringArray = (value: unknown): string[] | undefined => {
    if (value === undefined || value === null) {
      return undefined;
    }
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
      throw new Error("accordResolution id arrays must contain only strings.");
    }
    return value as string[];
  };
  const version = record.version === undefined || record.version === null
    ? undefined
    : (typeof record.version === "number" && Number.isInteger(record.version) && record.version >= 1
        ? record.version
        : (() => { throw new Error("accordResolution.version must be a positive integer."); })());
  const optionalString = (value: unknown, field: string): string | undefined => {
    if (value === undefined || value === null) {
      return undefined;
    }
    if (typeof value !== "string") {
      throw new Error(`accordResolution.${field} must be a string.`);
    }
    return value.trim() || undefined;
  };
  const normalized: ChatAccordResolutionMetadata = {
    version,
    sourceMessageId: optionalString(record.sourceMessageId, "sourceMessageId"),
    selectedParticipantIds: stringArray(record.selectedParticipantIds),
    requiredApproverIds: stringArray(record.requiredApproverIds),
    supersedesMessageId: optionalString(record.supersedesMessageId, "supersedesMessageId"),
    status: optionalString(record.status, "status")
  };
  return Object.values(normalized).some((value) => value !== undefined) ? normalized : undefined;
}

export function toggleReactionOnMessage(
  conversation: Conversation,
  message: ChatMessage,
  sequence: number,
  emoji: string,
  actor: ChatReactionActor
): ChatReactionMutationResult {
  if (message.status === "pending") {
    throw new Error("Cannot react to a pending message.");
  }
  const reactions = normalizedChatMessageReactions(message.metadata?.reactions);
  const existingReactors = reactions[emoji] ?? [];
  const existingIndex = existingReactors.findIndex((reactor) =>
    reactor.actorId === actor.actorId && reactor.actorKind === actor.actorKind
  );
  const status: ChatReactionMutationResult["status"] = existingIndex >= 0 ? "removed" : "added";
  const nextReactors = existingIndex >= 0
    ? existingReactors.filter((_reactor, index) => index !== existingIndex)
    : [
        ...existingReactors,
        {
          actorId: actor.actorId,
          actorLabel: actor.actorLabel,
          actorKind: actor.actorKind,
          at: new Date().toISOString()
        }
      ];
  const nextReactions: ChatMessageReactions = { ...reactions };
  if (nextReactors.length > 0) {
    nextReactions[emoji] = nextReactors;
  } else {
    delete nextReactions[emoji];
  }
  message.metadata = {
    ...message.metadata,
    reactions: Object.keys(nextReactions).length > 0 ? nextReactions : undefined
  };
  return {
    status,
    messageId: message.id,
    sequence,
    emoji,
    author: messageAuthor(message),
    contentPreview: messageContentPreview(message),
    reactions: nextReactions
  };
}

export function normalizeChatMessageReadRequest(raw: unknown): {
  messageId?: string;
  threadId?: string;
  beforeSequence?: number;
  afterSequence?: number;
  limit: number;
} {
  if (raw !== undefined && raw !== null && (typeof raw !== "object" || Array.isArray(raw))) {
    throw new Error("Chat message read request must be an object.");
  }
  const record = (raw ?? {}) as Record<string, unknown>;
  const messageId = typeof record.messageId === "string"
    ? record.messageId.trim() || undefined
    : undefined;
  const threadId = typeof record.threadId === "string"
    ? record.threadId.trim().slice(0, 200) || undefined
    : undefined;
  return {
    messageId,
    threadId,
    beforeSequence: optionalNonNegativeInteger(record.beforeSequence, "beforeSequence"),
    afterSequence: optionalNonNegativeInteger(record.afterSequence, "afterSequence"),
    limit: optionalBoundedPositiveInteger(
      record.limit,
      "limit",
      CHAT_CONTEXT_READ_DEFAULT_LIMIT,
      CHAT_CONTEXT_READ_MAX_LIMIT
    )
  };
}

function optionalNonNegativeInteger(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer.`);
  }
  return value;
}

export function optionalBoundedPositiveInteger(value: unknown, field: string, fallback: number, max: number): number {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return Math.min(value, max);
}

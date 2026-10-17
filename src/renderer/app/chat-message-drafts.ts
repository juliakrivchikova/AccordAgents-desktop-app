import type { SetStateAction } from "react";

/**
 * Unsent composer text, one entry per chat. A chat with no entry has an empty
 * draft. Kept in renderer memory only: it lives as long as the app window.
 */
export type ChatMessageDrafts = Readonly<Record<string, string>>;

export function chatMessageDraftFor(drafts: ChatMessageDrafts, conversationId: string | undefined): string {
  return conversationId ? drafts[conversationId] ?? "" : "";
}

export function applyChatMessageDraft(
  drafts: ChatMessageDrafts,
  conversationId: string,
  value: SetStateAction<string>
): ChatMessageDrafts {
  const previous = drafts[conversationId] ?? "";
  const next = typeof value === "function" ? value(previous) : value;
  if (next === previous) {
    return drafts;
  }
  if (!next) {
    return withoutChatMessageDraft(drafts, conversationId);
  }
  return { ...drafts, [conversationId]: next };
}

export function withoutChatMessageDraft(drafts: ChatMessageDrafts, conversationId: string): ChatMessageDrafts {
  if (!(conversationId in drafts)) {
    return drafts;
  }
  const { [conversationId]: _removed, ...rest } = drafts;
  return rest;
}

import { HUB_CHAT_PAGE_MESSAGES, isHubChatId, isHubOpId, type HubChatPage, type HubChatsResponse } from "../../shared/hubOps";
import { conversationFields, sharedFieldsOf } from "./chatRecords";
import { HubOpsRequestError } from "./types";
import type { HubOpsModules } from "./modules";
import type { HubOpsDependencies } from "./dependencies";

/** Chats and their messages, page by page. */
export class ChatPages {
  constructor(
    private readonly ops: Pick<HubOpsModules, "feed">,
    private readonly deps: Pick<HubOpsDependencies, "storage">
  ) {}

  async chats(): Promise<HubChatsResponse> {
    const summaries = await this.deps.storage.listConversations();
    return {
      chats: summaries.filter((summary) => summary.kind === "chat").map((summary) => ({ id: summary.id, title: summary.title, updatedAt: summary.updatedAt })),
      head: await this.ops.feed.head()
    };
  }

  async chatPage(conversationId: string, before?: string): Promise<HubChatPage> {
    if (!isHubChatId(conversationId) || (before !== undefined && !isHubOpId(before))) throw new HubOpsRequestError(400, "Invalid chat page.");
    // The head first: a device that continues the feed from here misses
    // nothing accepted while this page was read.
    const head = await this.ops.feed.head();
    const opened = await this.deps.storage.openConversation(conversationId, HUB_CHAT_PAGE_MESSAGES, before ? { beforeMessageId: before } : undefined);
    if (!opened || opened.conversation.kind !== "chat") throw new HubOpsRequestError(404, "There is no such chat.");
    const conversation = opened.conversation;
    const messages = conversation.messages;
    return {
      conversationId,
      conversation: { ...conversationFields(sharedFieldsOf(conversation)), updatedAt: conversation.updatedAt },
      messages,
      turns: await this.deps.storage.hubOps().turnsFor(conversationId, messages.map((message) => message.id)),
      more: Boolean(opened.messagePage?.hasMoreBefore),
      head
    };
  }
}

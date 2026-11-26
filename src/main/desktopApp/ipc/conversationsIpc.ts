import { ipcMain } from "electron";
import type { ChatSearchRequest, ConversationMessagePageRequest } from "../../../shared/types";
import type { DesktopApp } from "../desktopApp";

export function registerConversationsIpc(desktopApp: DesktopApp): void {
  ipcMain.handle("conversations:list", () => desktopApp.storageService.listConversations());
  ipcMain.handle("chat-search:query", (_event, request: ChatSearchRequest) => desktopApp.chatSearchService.search(request));

  ipcMain.handle("conversations:get", async (_event, id: string) => {
    const conversation = await desktopApp.storageService.getConversation(id);
    return conversation ? desktopApp.chatService.hydrateContextUsage(conversation) : conversation;
  });

  ipcMain.handle("conversations:open", async (_event, id: string, limit?: number) => {
    const result = await desktopApp.storageService.openConversation(id, limit);
    if (!result) {
      return result;
    }
    // Members made before their task's title was kept with them get it once,
    // after the chat is open (its snapshot then carries them).
    void desktopApp.chatService.backfillSessionsTaskTitles(result.conversation).catch((error: unknown) => {
      console.warn(`[sessions] Member titles could not be backfilled: ${error instanceof Error ? error.message : String(error)}`);
    });
    // openConversation returns a paginated window of messages consistent with
    // result.messagePage. hydrateContextUsage runs withChatMutation ->
    // refreshStoredChatState, which reassigns conversation.messages to the full
    // stored history; that would un-window the result and leave messages.length
    // inconsistent with messagePage. Keep the refreshed context-usage metadata but
    // restore the windowed messages captured before hydration.
    const windowedMessages = result.conversation.messages;
    const hydrated = await desktopApp.chatService.hydrateContextUsage(result.conversation);
    if (hydrated.messages.length < result.messagePage.totalMessages) {
      // Hydration did not load the full history (non-chat kinds); keep the
      // window storage read.
      return {
        ...result,
        conversation: { ...hydrated, messages: windowedMessages }
      };
    }
    // Hydration can change or add messages (stale runs recovered, orphaned
    // requests marked). Later delta updates only describe changes after the
    // snapshot hydration emitted, so the window handed back is cut from the
    // hydrated history rather than the pre-hydration read.
    const total = hydrated.messages.length;
    const messages = hydrated.messages.slice(Math.max(0, total - Math.max(1, windowedMessages.length)));
    return {
      ...result,
      conversation: { ...hydrated, messages },
      messagePage: {
        totalMessages: total,
        oldestSequence: messages.length > 0 ? total - messages.length : undefined,
        newestSequence: messages.length > 0 ? total - 1 : undefined,
        hasMoreBefore: messages.length < total
      }
    };
  });

  ipcMain.handle("conversations:list-messages", (_event, request: ConversationMessagePageRequest) => desktopApp.storageService.listConversationMessages(request));

  ipcMain.handle("conversations:find-running-participant-message", (_event, conversationId: string, participantId: string) =>
    typeof conversationId === "string" && typeof participantId === "string"
      ? desktopApp.storageService.findRunningParticipantMessage(conversationId, participantId)
      : undefined);
}

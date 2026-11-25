import { randomUUID } from "node:crypto";
import { ipcMain } from "electron";
import type {
  ReadChatAttachmentRequest, RespondToChatAppToolApprovalRequest, RespondToChatChoiceRequest, RespondToChatMentionsRequest,
  ToggleChatReactionRequest, CloseAccordCardRequest, DismissTurnFinishedNoteRequest
} from "../../../shared/types";
import { emitReviewProgress } from "../chatServices";
import { sendToMainWindow } from "../windowState";
import type { DesktopApp } from "../desktopApp";

export function registerChatCardsIpc(desktopApp: DesktopApp): void {
  ipcMain.handle("chat:read-attachment", async (_event, request: ReadChatAttachmentRequest) => {
    return desktopApp.chatService.readChatAttachment(request);
  });

  ipcMain.handle("chat:toggle-reaction", async (_event, request: ToggleChatReactionRequest) => {
    return desktopApp.chatService.toggleReaction(request);
  });

  ipcMain.handle("chat:dismiss-turn-finished-note", async (_event, request: DismissTurnFinishedNoteRequest) => {
    await desktopApp.chatService.dismissTurnFinishedNote(request);
  });

  ipcMain.handle("chat:close-accord-card", async (_event, request: CloseAccordCardRequest) => {
    await desktopApp.chatService.closeAccordCard(request);
  });

  // Answers to cards a member waits on go to the User's server (agreement
  // Д9): the device the member runs on applies them, once, whichever device
  // answered first; this returns once the server took the answer.
  ipcMain.handle("chat:respond-to-mentions", async (_event, request: RespondToChatMentionsRequest) => {
    const runId = request.runId ?? randomUUID();
    const controller = new AbortController();
    desktopApp.activeReviews.set(runId, controller);
    try {
      return await desktopApp.chatService.answerMentionsCard({ ...request, runId }, controller.signal, (progress) => emitReviewProgress(desktopApp, progress));
    } catch (error) {
      const phase = controller.signal.aborted ? "cancelled" : "error";
      sendToMainWindow(desktopApp, "conversations:review-progress", {
        runId,
        phase,
        message: error instanceof Error ? error.message : String(error),
        createdAt: new Date().toISOString()
      });
      throw error;
    } finally {
      desktopApp.activeReviews.delete(runId);
    }
  });

  ipcMain.handle("chat:respond-to-choice", async (_event, request: RespondToChatChoiceRequest) => {
    await desktopApp.chatService.answerChoiceCard(request);
    return { conversation: await desktopApp.storageService.getConversation(request.conversationId), warnings: [] };
  });

  ipcMain.handle("chat:respond-to-app-tool-approval", async (_event, request: RespondToChatAppToolApprovalRequest) => {
    await desktopApp.chatService.answerAppToolApprovalCard(request);
    return desktopApp.storageService.getConversation(request.conversationId);
  });
}

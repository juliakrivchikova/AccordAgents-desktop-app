import { randomUUID } from "node:crypto";
import { ipcMain } from "electron";
import type {
  ComposeImplementationPlanRequest, ContinueReviewRequest, PlanDecisionClarificationRequest, PlanItemReviewRequest,
  RecoverImplementationPlanRequest, ReviseImplementationPlanRequest, RetryImplementationPlanSynthesisRequest, ReviewRequest
} from "../../../shared/types";
import { emitReviewProgress } from "../chatServices";
import { sendToMainWindow } from "../windowState";
import type { DesktopApp } from "../desktopApp";

export function registerReviewsIpc(desktopApp: DesktopApp): void {
  ipcMain.handle("conversations:save-decision-selections", async (_event, conversationId: string, selections: Record<string, string>) => {
    const conversation = await desktopApp.storageService.getConversation(conversationId);
    if (!conversation || conversation.kind !== "implementation-plan") {
      return conversation;
    }
    const normalizedSelections = Object.fromEntries(
      Object.entries(selections).filter(([decisionId, optionId]) => decisionId.trim() && optionId.trim())
    );
    conversation.metadata = {
      ...conversation.metadata,
      pendingDecisionSelections: normalizedSelections
    };
    conversation.updatedAt = new Date().toISOString();
    await desktopApp.storageService.saveConversation(conversation);
    return conversation;
  });

  ipcMain.handle("conversations:save-decision-resolutions", async (_event, conversationId: string, resolutions: Record<string, boolean>) => {
    const conversation = await desktopApp.storageService.getConversation(conversationId);
    if (!conversation || conversation.kind !== "implementation-plan") {
      return conversation;
    }
    const normalizedResolutions = Object.fromEntries(
      Object.entries(resolutions).filter(([decisionId, resolved]) => decisionId.trim() && resolved === true)
    );
    conversation.metadata = {
      ...conversation.metadata,
      pendingDecisionResolutions: normalizedResolutions
    };
    conversation.updatedAt = new Date().toISOString();
    await desktopApp.storageService.saveConversation(conversation);
    return conversation;
  });

  ipcMain.handle("conversations:save-plan-item-review", async (_event, request: PlanItemReviewRequest) => {
    return desktopApp.consensusService.savePlanItemReview(request);
  });

  ipcMain.handle("conversations:start-review", async (_event, request: ReviewRequest) => {
    const runId = request.runId ?? randomUUID();
    const controller = new AbortController();
    desktopApp.activeReviews.set(runId, controller);

    try {
      return await desktopApp.consensusService.startReview(
        { ...request, runId },
        controller.signal,
        (progress) => emitReviewProgress(desktopApp, progress)
      );
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

  ipcMain.handle("conversations:continue-review", async (_event, request: ContinueReviewRequest) => {
    const runId = request.runId ?? randomUUID();
    const controller = new AbortController();
    desktopApp.activeReviews.set(runId, controller);

    try {
      return await desktopApp.consensusService.continueReview(
        { ...request, runId },
        controller.signal,
        (progress) => emitReviewProgress(desktopApp, progress)
      );
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

  ipcMain.handle("conversations:compose-implementation-plan", async (_event, request: ComposeImplementationPlanRequest) => {
    const runId = request.runId ?? randomUUID();
    const controller = new AbortController();
    desktopApp.activeReviews.set(runId, controller);

    try {
      return await desktopApp.consensusService.composeImplementationPlan(
        { ...request, runId },
        controller.signal,
        (progress) => emitReviewProgress(desktopApp, progress)
      );
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

  ipcMain.handle("conversations:retry-implementation-plan-synthesis", async (_event, request: RetryImplementationPlanSynthesisRequest) => {
    const runId = request.runId ?? randomUUID();
    const controller = new AbortController();
    desktopApp.activeReviews.set(runId, controller);

    try {
      return await desktopApp.consensusService.retryImplementationPlanSynthesis(
        { ...request, runId },
        controller.signal,
        (progress) => emitReviewProgress(desktopApp, progress)
      );
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

  ipcMain.handle("conversations:recover-implementation-plan", async (_event, request: RecoverImplementationPlanRequest) => {
    const runId = request.runId ?? randomUUID();
    const controller = new AbortController();
    desktopApp.activeReviews.set(runId, controller);

    try {
      return await desktopApp.consensusService.recoverImplementationPlan(
        { ...request, runId },
        controller.signal,
        (progress) => emitReviewProgress(desktopApp, progress)
      );
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

  ipcMain.handle("conversations:revise-implementation-plan", async (_event, request: ReviseImplementationPlanRequest) => {
    const runId = request.runId ?? randomUUID();
    const controller = new AbortController();
    desktopApp.activeReviews.set(runId, controller);

    try {
      return await desktopApp.consensusService.reviseImplementationPlan(
        { ...request, runId },
        controller.signal,
        (progress) => emitReviewProgress(desktopApp, progress)
      );
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

  ipcMain.handle("conversations:ask-plan-decision-clarification", async (_event, request: PlanDecisionClarificationRequest) => {
    const runId = request.runId ?? randomUUID();
    const controller = new AbortController();
    desktopApp.activeReviews.set(runId, controller);

    try {
      return await desktopApp.consensusService.askPlanDecisionClarification(
        { ...request, runId },
        controller.signal,
        (progress) => emitReviewProgress(desktopApp, progress)
      );
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

  ipcMain.handle("conversations:cancel-review", (_event, runId: string) => {
    // Stop is unconditional and idempotent. A member running on another
    // device is stopped through the User's server (its turn there).
    const controller = desktopApp.activeReviews.get(runId);
    if (controller) {
      controller.abort();
      return;
    }
    desktopApp.chatService.cancelRun(runId);
  });
}

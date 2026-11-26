import { chatViewFor } from "../../../shared/mainSession";
import { randomUUID } from "node:crypto";
import { ipcMain } from "electron";
import type {
  AddChatParticipantRequest, CompactChatParticipantRequest, RestartChatParticipantRequest, CreateChatConversationRequest,
  DeleteChatConversationRequest, DismissConversationWarningsRequest, RenameChatConversationRequest, SetChatArchivedRequest,
  SetChatPinnedRequest, SetChatViewRequest, ChatViewState, ChatPinState, SendChatMessageRequest, StartChatAccordRequest,
  UpdateChatParticipantRuntimeRequest, UpdateChatSubagentProvidersRequest, RemoveChatParticipantRequest
} from "../../../shared/types";
import type { MemoryNote, MemoryNoteIdRequest, MemorySettingsListRequest } from "../../../shared/memory";
import { emitReviewProgress } from "../chatServices";
import { listMemoryNotesForSettings } from "../toolWiring";
import { observeAddedMember } from "../usageSignals";
import { sendToMainWindow } from "../windowState";
import type { DesktopApp } from "../desktopApp";

export function registerChatIpc(desktopApp: DesktopApp): void {
  ipcMain.handle("chat:create", async (event, request: CreateChatConversationRequest) => {
    const runId = request.runId ?? randomUUID();
    if (desktopApp.activeReviews.has(runId)) throw new Error("This chat action is already running.");
    const controller = new AbortController();
    desktopApp.activeReviews.set(runId, controller);
    desktopApp.activeChatCreations.add(controller);
    const cancelCreation = (): void => controller.abort();
    event.sender.once("destroyed", cancelCreation);
    try {
      const created = await desktopApp.chatService.createConversation({ ...request, runId }, controller.signal, (progress) => emitReviewProgress(desktopApp, progress));
      // Roles and a mixed chat are seen in the new chat itself; its members'
      // rules only in what was asked for.
      if ((request.participants ?? []).some((member) => (member.behaviorRuleIds?.length ?? 0) > 0)) {
        desktopApp.usageMilestones?.reach("behavior_rule_attached");
      }
      // A new project, or a member used once more: the phone's New chat
      // offers what this one does.
      desktopApp.hubPhonePublisher.scheduleCatalog();
      return created;
    } catch (error) {
      if (controller.signal.aborted) throw new Error("Chat creation cancelled.");
      throw error;
    } finally {
      event.sender.removeListener("destroyed", cancelCreation);
      desktopApp.activeChatCreations.delete(controller);
      desktopApp.activeReviews.delete(runId);
    }
  });

  ipcMain.handle("chat:rename", async (_event, request: RenameChatConversationRequest) => {
    return desktopApp.chatService.renameConversation(request);
  });

  ipcMain.handle("chat:set-archived", async (_event, request: SetChatArchivedRequest) => {
    return desktopApp.chatService.setArchived(request);
  });

  ipcMain.handle("chat:set-pinned", async (_event, request: SetChatPinnedRequest): Promise<ChatPinState | undefined> => {
    const saved = await desktopApp.chatService.setPinned(request);
    if (!saved) return undefined;
    const pinned = saved.metadata.pinned === true;
    const pinnedAt = typeof saved.metadata.pinnedAt === "string" ? saved.metadata.pinnedAt : undefined;
    return { conversationId: saved.id, pinned, ...(pinned && pinnedAt ? { pinnedAt } : {}) };
  });

  ipcMain.handle("chat:set-view", async (_event, request: SetChatViewRequest): Promise<ChatViewState | undefined> => {
    const saved = await desktopApp.chatService.setChatView(request);
    return saved ? { conversationId: saved.id, view: chatViewFor(saved.metadata) } : undefined;
  });

  ipcMain.handle("chat:delete", async (_event, request: DeleteChatConversationRequest) => {
    return desktopApp.chatService.deleteConversation(request);
  });

  ipcMain.handle("chat:dismiss-warnings", async (_event, request: DismissConversationWarningsRequest) => {
    return desktopApp.chatService.dismissConversationWarnings(request);
  });

  ipcMain.handle("chat:add-participant", async (_event, request: AddChatParticipantRequest) => {
    const updated = await desktopApp.chatService.addParticipant(request);
    if (updated && Array.isArray(updated.metadata?.participants)) {
      observeAddedMember(desktopApp, request.participant, updated.metadata.participants as Array<{ handle?: string; roleConfigId?: string }>);
    }
    return updated;
  });

  ipcMain.handle("chat:update-participant-runtime", async (_event, request: UpdateChatParticipantRuntimeRequest) => {
    return desktopApp.chatService.updateParticipantRuntime(request);
  });

  ipcMain.handle("chat:update-subagent-providers", async (_event, request: UpdateChatSubagentProvidersRequest) => {
    return desktopApp.chatService.updateSubagentProviders(request);
  });

  ipcMain.handle("chat:remove-participant", async (_event, request: RemoveChatParticipantRequest) => {
    return desktopApp.chatService.removeParticipant(request);
  });

  ipcMain.handle("chat:compact-participant", async (_event, request: CompactChatParticipantRequest) => {
    const runId = request.runId ?? randomUUID();
    const controller = new AbortController();
    desktopApp.activeReviews.set(runId, controller);

    try {
      return await desktopApp.chatService.compactParticipant(
        { ...request, triggeredBy: "user", runId },
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

  ipcMain.handle("chat:restart-participant", async (_event, request: RestartChatParticipantRequest) => {
    const runId = request.runId ?? randomUUID();
    const controller = new AbortController();
    desktopApp.activeReviews.set(runId, controller);
    try {
      await desktopApp.chatService.restartParticipant({ ...request, runId }, controller.signal, (progress) => emitReviewProgress(desktopApp, progress));
    } catch (error) {
      sendToMainWindow(desktopApp, "conversations:review-progress", {
        runId,
        phase: controller.signal.aborted ? "cancelled" : "error",
        message: error instanceof Error ? error.message : String(error),
        createdAt: new Date().toISOString()
      });
      throw error;
    } finally {
      desktopApp.activeReviews.delete(runId);
    }
  });

  ipcMain.handle("chat:start-accord", async (_event, request: StartChatAccordRequest) => {
    const runId = randomUUID();
    const controller = new AbortController();
    desktopApp.activeReviews.set(runId, controller);

    try {
      return await desktopApp.chatService.startAccord(
        request,
        controller.signal,
        (progress) => emitReviewProgress(desktopApp, progress),
        runId
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

  ipcMain.handle("chat:get-prompt-suggestions", (_event, conversationId: unknown) =>
    typeof conversationId === "string" ? desktopApp.chatService.listPromptSuggestions(conversationId) : []);

  ipcMain.handle("chat:get-background-tasks", (_event, conversationId: unknown) =>
    typeof conversationId === "string" ? desktopApp.chatService.backgroundTasksForConversation(conversationId) : {});

  ipcMain.handle("chat:send", async (_event, request: SendChatMessageRequest) => {
    const runId = request.runId ?? randomUUID();
    const controller = new AbortController();
    desktopApp.activeReviews.set(runId, controller);

    try {
      return await desktopApp.chatService.sendMessage(
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

  ipcMain.handle("memory:list", (_event, request: MemorySettingsListRequest) => listMemoryNotesForSettings(desktopApp, request));

  ipcMain.handle("memory:read", (_event, request: MemoryNoteIdRequest) =>
    desktopApp.serverChatLink.memory<MemoryNote>({ action: "owner-read", noteId: String(request?.noteId ?? "") }));

  ipcMain.handle("memory:delete", async (_event, request: MemoryNoteIdRequest) => {
    const noteId = String(request?.noteId ?? "");
    // Deleted by the User: it leaves the computer's copy first, so it never
    // comes back with a move to another server, even if the server's answer
    // is lost.
    await desktopApp.memoryMirror.forget(noteId);
    return desktopApp.serverChatLink.memory<{ deleted: boolean }>({ action: "delete", noteId });
  });
}

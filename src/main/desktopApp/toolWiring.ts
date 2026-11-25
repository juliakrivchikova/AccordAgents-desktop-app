import path from "node:path";
import { randomUUID } from "node:crypto";
import { app } from "electron";
import { NATIVE_PROCESS_REGISTRY_FILE, usesNativeProcessRegistry } from "../services/nativeProcessRegistry";
import { quitStep } from "../terminal/quitConfirmation";
import { createArtifactToolDispatcher, wireArtifactToolHandler, wireMemoryToolHandler, wireUrgentAlertToolHandler } from "../appToolWiring";
import type { MemoryOwnerListValue, MemorySettingsListRequest, MemorySettingsListResult } from "../../shared/memory";
import { MachineApprovalExecutor } from "../services/machineApprovalExecutor";
import { readPosixProcessTableAsync } from "../services/processTermination";
import { MachineChoiceExecutor, MachineMentionExecutor } from "../services/chatActionNativeClaims";
import type { ChatCardAppliers } from "../services/chatCards";
import { AvatarStudioService } from "../services/avatarStudio";
import { emitReviewProgress } from "./chatServices";
import { sendToMainWindow } from "./windowState";
import { MAIN_DIRECTORY } from "../mainDirectory";
import type { DesktopApp } from "./desktopApp";

export function wireAppTools(desktopApp: DesktopApp): void {
  // A deleted chat reaches every other device through the User's server (its
  // deletion is an operation there, which every device applies).
  desktopApp.chatService.setConversationDeletedHandler(async (conversation) => {
    sendToMainWindow(desktopApp, "conversations:deleted", conversation.id);
  });

  desktopApp.avatarStudioService = new AvatarStudioService({
    cliRunner: desktopApp.cliAgentRunner,
    workRoot: path.join(app.getPath("userData"), "avatar-studio"),
    promptRoot: path.join(MAIN_DIRECTORY, "prompts"),
    debugLogs: desktopApp.debugLogService
  });

  // Scratch pictures never outlive the app: sweep whatever an earlier session left
  // behind, and cancel live draws on quit.
  void desktopApp.avatarStudioService.shutdown();

  app.on("before-quit", quitStep(desktopApp.quitConfirmation, () => {
    void desktopApp.avatarStudioService.shutdown();
  }));

  desktopApp.dispatchArtifactTool = createArtifactToolDispatcher(desktopApp.artifactService);
  wireArtifactToolHandler(desktopApp.appMcpService, desktopApp.chatService, desktopApp.dispatchArtifactTool);

  // Members' memory lives on the User's server only (shared/memory.ts).
  wireMemoryToolHandler(desktopApp.appMcpService, desktopApp.chatService, () => desktopApp.serverChatLink, () => desktopApp.usageMilestones?.reach("memory_note_written"));

  wireUrgentAlertToolHandler(desktopApp.appMcpService, () => desktopApp.serverChatLink);
  desktopApp.chatService.setConnectorSignedInObserver(() => desktopApp.usageMilestones?.reach("connector_signed_in"));
  desktopApp.chatService.setCardAppliers(() => localCardAppliers(desktopApp));
  desktopApp.activeReviews = new Map<string, AbortController>();
  desktopApp.activeChatCreations = new Set<AbortController>();

  app.on("before-quit", quitStep(desktopApp.quitConfirmation, () => {
    for (const controller of desktopApp.activeChatCreations) controller.abort();
  }));
}

/** Settings → Memory: every note on the User's server, with the names of
 *  the roles and chats they are kept for. */
export async function listMemoryNotesForSettings(desktopApp: DesktopApp, request: MemorySettingsListRequest | undefined): Promise<MemorySettingsListResult> {
  const query: MemorySettingsListRequest = {
    ...(typeof request?.query === "string" && request.query.trim() ? { query: request.query.trim() } : {}),
    ...(typeof request?.tag === "string" && request.tag.trim() ? { tag: request.tag.trim() } : {}),
    ...(request?.kind ? { kind: request.kind } : {}),
    ...(request?.scope ? { scope: request.scope } : {}),
    ...(request?.archived ? { archived: true } : {})
  };
  const result = await desktopApp.serverChatLink.memory<MemoryOwnerListValue>({ action: "list", ...query });
  if (!result.ok) {
    if (result.error.code === "server_unavailable") return { status: "unavailable", notes: [], truncated: false, message: result.error.message, roleLabels: {}, chatTitles: {} };
    throw new Error(result.error.message);
  }
  const settings = await desktopApp.settingsService.getPublicSettings();
  const roleLabels = Object.fromEntries(settings.chatRoleConfigs.map((role) => [role.id, role.label]));
  // One read for the titles of the notes' chats; a chat missing here was deleted.
  const chatIds = [...new Set(result.value.notes.flatMap((note) => note.conversationId ? [note.conversationId] : []))];
  const chatTitles = await desktopApp.storageService.conversationTitles(chatIds);
  return { status: "ok", notes: result.value.notes, truncated: result.value.truncated, roleLabels, chatTitles };
}

/** This process, named the way a durable claim names its owner: one identity
 *  for every native admission this runtime takes. */
function localRuntimeIdentity(desktopApp: DesktopApp): Promise<{ runtimeId: string; pid: number; startedAt: string }> {
  const pending = desktopApp.runtimeIdentity ??= (async () => {
    const processIdentity = (await readPosixProcessTableAsync())?.get(process.pid);
    if (!processIdentity) throw new Error("This runtime's process identity could not be verified.");
    return { runtimeId: randomUUID(), pid: processIdentity.pid, startedAt: processIdentity.startedAt };
  })();
  void pending.catch(() => { if (desktopApp.runtimeIdentity === pending) desktopApp.runtimeIdentity = undefined; });
  return pending;
}

function localCardAppliers(desktopApp: DesktopApp): Promise<ChatCardAppliers> {
  const pending = desktopApp.cardAppliers ??= (async () => {
    const device = await desktopApp.deviceIdentityService.getOrCreateDeviceIdentity();
    const nativeProcessDbPath = usesNativeProcessRegistry() ? path.join(app.getPath("userData"), NATIVE_PROCESS_REGISTRY_FILE) : undefined;
    return {
      approval: new MachineApprovalExecutor({
        storage: desktopApp.storageService, chat: desktopApp.chatService,
        progress: (progress) => emitReviewProgress(desktopApp, progress),
        runtimeIdentity: () => localRuntimeIdentity(desktopApp), nativeProcessDbPath,
        codeApprover: () => device.originId
      }),
      choice: new MachineChoiceExecutor({ storage: desktopApp.storageService, chat: desktopApp.chatService,
        progress: (progress) => emitReviewProgress(desktopApp, progress), runtimeIdentity: () => localRuntimeIdentity(desktopApp), nativeProcessDbPath }),
      mention: new MachineMentionExecutor({ storage: desktopApp.storageService, chat: desktopApp.chatService,
        progress: (progress) => emitReviewProgress(desktopApp, progress), runtimeIdentity: () => localRuntimeIdentity(desktopApp) })
    };
  })();
  void pending.catch(() => { if (desktopApp.cardAppliers === pending) desktopApp.cardAppliers = undefined; });
  return pending;
}

import path from "node:path";
import { cloudEnvironmentDirectory } from "../services/cloudRunPreparation";
import { app } from "electron";
import type { ReviewProgress } from "../../shared/types";
import { artifactMembersForConversation } from "../../shared/artifacts";
import { ArtifactClient } from "../services/artifactClient";
import { ArtifactStore } from "../services/artifactStore";
import { ChatService } from "../services/chat";
import { CloudRunDoctorService } from "../services/cloudRunDoctor";
import { CloudRunSetupSession } from "../services/cloudRunSetupSession";
import { sendToMainWindow } from "./windowState";
import { openExternalUrl } from "./windows";
import type { DesktopApp } from "./desktopApp";

export function createChatServices(desktopApp: DesktopApp): void {
  desktopApp.chatService = new ChatService(desktopApp.storageService, desktopApp.settingsService, desktopApp.cliAgentRunner, desktopApp.debugLogService, desktopApp.appMcpService, (conversation, update) => {
    // The renderer receives the delta form — the messages that changed plus the
    // newest window — because on a chat with thousands of messages the full
    // snapshot is tens of megabytes per update.
    sendToMainWindow(desktopApp, "conversations:updated", update);
    // Which members live on machines (their live progress is theirs to publish).
    desktopApp.hubPhonePublisher.noteConversation(conversation);
    try {
      desktopApp.usageMilestones?.observeConversation(conversation, update.messages);
    } catch {
      // Usage signals never get in the way of a chat.
    }
  }, desktopApp.userSkillsService, (progress) => emitReviewProgress(desktopApp, progress));

  desktopApp.cloudRunDoctorService = new CloudRunDoctorService({
    environmentForWorker: async (worker, readOnly) => {
      if (!worker.hostKeyAlias?.startsWith("accordagents-i-")) return {};
      const directory = cloudEnvironmentDirectory((await desktopApp.deviceIdentityService.getOrCreateDeviceIdentity()).originId);
      return desktopApp.machineInstallerService.providerEnvironment(worker, `~/${directory}`, readOnly);
    },
    openExternal: (url) => {
      void openExternalUrl(url).catch(() => undefined);
    },
    logger: (event, payload) => {
      void desktopApp.debugLogService.write(event, payload);
    }
  });

  desktopApp.cloudRunSetupSession = new CloudRunSetupSession();
  desktopApp.hubRosterAgain = false;
  desktopApp.hubRosterRetryMs = 5_000;

  /** The server took this desktop's device list, which only its owner may set. */
  desktopApp.hubOwnerConfirmed = false;

  // Documents (artifacts) are the User's server's too (Д9): this computer keeps
  // a copy, in their own tables of the same SQLite database as conversations,
  // and writes every change through the server.
  desktopApp.artifactStore = new ArtifactStore(path.join(app.getPath("userData"), "accordagents.sqlite3"), desktopApp.sqliteExecutable);

  desktopApp.artifactService = new ArtifactClient({
    store: desktopApp.artifactStore,
    getMembers: async (conversationId) => {
      const opened = await desktopApp.storageService.openConversation(conversationId, 1);
      return opened?.conversation.kind === "chat" ? artifactMembersForConversation(opened.conversation) : undefined;
    },
    postNote: (conversationId, eventId, content, links) => desktopApp.chatService.postArtifactChatNote(conversationId, eventId, content, links),
    hasChat: async (conversationId) => (await desktopApp.storageService.openConversation(conversationId, 1))?.conversation.kind === "chat",
    onChanged: (conversationId) => {
      sendToMainWindow(desktopApp, "artifacts:updated", { conversationId });
      desktopApp.usageMilestones?.observeDocuments();
    },
    logger: (event, payload) => {
      void desktopApp.debugLogService.write(event, payload);
    }
  });

  desktopApp.chatService.setArtifactCleanup((conversationId) => desktopApp.artifactService.deleteConversationArtifacts(conversationId));
}

// Every progress path reaches the phone (through the server), not only the
// renderer: interactive runs (chat:send, accord, compaction) pass their own
// per-run callback.
export function emitReviewProgress(desktopApp: DesktopApp, progress: ReviewProgress): void {
  sendToMainWindow(desktopApp, "conversations:review-progress", progress);
  // A local member's live text, for the phone to show from the server.
  desktopApp.hubPhonePublisher.noteProgress(progress, desktopApp.chatService.conversationIdForRun(progress.runId));
}

/** Phones paired with the User's server (the ones it admits). */
export async function hubPhones(desktopApp: DesktopApp): Promise<import("../../shared/machineTrust").TrustedDeviceRecord[]> {
  return (await desktopApp.settingsService.listTrustedDevices().catch(() => [])).filter((device) => device.role === "phone" && device.inviteId && device.phoneScope);
}

import path from "node:path";
import { app } from "electron";
import { ServerChatLink } from "../services/serverChatLink";
import { MemoryMirror } from "../services/memoryMirror";
import { CliMemorySync } from "../services/cliMemorySync";
import { projectsOfChats } from "../services/cliMemorySync/projects";
import { commandEnvironment } from "../services/command";
import { HubPhonePublisher } from "../services/hubPhonePublisher";
import { HubMemberRulesPublisher, memberRulesFrom } from "../services/hubMemberRules";
import { hubPhones } from "./chatServices";
import type { DesktopApp } from "./desktopApp";

/** Chats, members' memory and the phone's views on the User's server. */
export function createServerChat(desktopApp: DesktopApp): void {
  /** The computer's copy of members' notes, moved with the chats to a new server. */
  desktopApp.memoryMirror = new MemoryMirror(() => desktopApp.storageService.sqlExecutor(), () => desktopApp.storageService.hub(),
    (event, payload) => { void desktopApp.debugLogService.write(event, payload); });

  /** The User's server owns every chat (agreements Д1–Д13): her own server, or
   *  the same server inside this app when she has none (Д6). */
  desktopApp.serverChatLink = new ServerChatLink({
    memoryMirror: desktopApp.memoryMirror,
    storage: desktopApp.storageService,
    chat: desktopApp.chatService,
    identity: () => desktopApp.deviceIdentityService.getOrCreateDeviceIdentity(),
    hubConfig: async () => {
      const config = await desktopApp.settingsService.getHubConfig();
      // With what the server must prove: the chats go to it only then.
      return config ? { url: config.url, hubId: config.hubId, hubKey: config.hubKey } : undefined;
    },
    startEmbedded: async (owner) => {
      const { startEmbeddedHub } = await import("../../hub/embeddedHub");
      return startEmbeddedHub({
        dataDir: path.join(app.getPath("userData"), "embedded-server"),
        owner,
        version: app.getVersion(),
        sqliteExecutable: desktopApp.sqliteExecutable,
        log: (event, payload) => { void desktopApp.debugLogService.write(event, payload); }
      });
    },
    machineNames: async () => (await desktopApp.settingsService.listMachines().catch(() => [])).map((machine) => ({ id: machine.id, name: machine.name })),
    movesChats: true,
    artifacts: desktopApp.artifactService,
    log: (event, payload) => { void desktopApp.debugLogService.write(event, payload); }
  });

  /** What members' CLIs remember on their own, kept in members' memory on
   *  the server too (shared/cliMemory.ts): started with the link. */
  desktopApp.cliMemorySync = new CliMemorySync({
    access: () => desktopApp.serverChatLink,
    serverId: () => desktopApp.serverChatLink.serverId(),
    database: () => desktopApp.storageService.sqlExecutor(),
    env: async () => ({ ...commandEnvironment(), ...(await desktopApp.settingsService.getManualAgentEnvironment()).env }),
    projects: async () => projectsOfChats(await desktopApp.storageService.chatProjectPaths()),
    homeOverride: process.env.ACCORDAGENTS_CLI_MEMORY_HOME,
    log: (event, payload) => { void desktopApp.debugLogService.write(event, payload); }
  });

  /** Whether the link to the server has been started in this run: at start,
   *  or after the server's program was updated before the window opened. */
  desktopApp.serverChatLinkStarted = false;

  // The User's rules for members (roles, saved members) on her server, which
  // holds the cloud machines' changes to a chat's members to them.
  desktopApp.hubMemberRulesPublisher = new HubMemberRulesPublisher({
    client: () => (desktopApp.hubOwnerConfirmed ? desktopApp.hubClient : undefined),
    // With each machine's program by its last hello: the server holds a
    // phone's or a machine's turns to a machine that cannot run a member's mode.
    rules: async () => memberRulesFrom(await desktopApp.settingsService.getPublicSettings(), desktopApp.machineLinkService?.cliModesByMachine()),
    log: (event, payload) => { void desktopApp.debugLogService.write(event, payload); }
  });

  desktopApp.hubPhonePublisher = new HubPhonePublisher({
    client: () => desktopApp.hubOwnerConfirmed ? desktopApp.hubClient : undefined,
    hasPhones: async () => (await hubPhones(desktopApp)).length > 0,
    machineMembersOf: async (conversationId) => {
      const opened = await desktopApp.storageService.openConversation(conversationId, 1);
      const participants = Array.isArray(opened?.conversation.metadata?.participants) ? opened!.conversation.metadata.participants as Array<{ id?: string; homeMachineId?: string }> : [];
      return new Set(participants.filter((participant) => participant?.id && participant.homeMachineId).map((participant) => participant.id as string));
    },
    buildCatalog: async (upload) => {
      const settings = await desktopApp.settingsService.getPublicSettings();
      for (const avatar of settings.chatCustomAvatars ?? []) {
        await upload(`custom:${avatar.id}`, `${avatar.id}:${avatar.createdAt}`, async () => {
          const read = await desktopApp.settingsService.readCustomAvatar(avatar.id);
          return { mimeType: read.mediaType, bytes: Buffer.from(read.dataBase64, "base64") };
        }).catch(() => undefined);
      }
      const skills = await desktopApp.userSkillsService.listAll({ limit: 300 }).catch(() => ({ skills: [] as import("../../shared/types").UserSkillSummary[] }));
      // The phone's New chat, as this computer's offers it; what it last
      // offered while it cannot tell now (a CLI check that failed, say).
      const newChat = await desktopApp.storageService.listConversations()
        .then((summaries) => desktopApp.chatService.newChatOptions(summaries))
        .catch((error) => {
          void desktopApp.debugLogService.write("hub.phone.new-chat-options-error", { message: error instanceof Error ? error.message : String(error) });
          return undefined;
        }) ?? desktopApp.lastNewChatOptions;
      desktopApp.lastNewChatOptions = newChat;
      return {
        ...(newChat ? { newChat } : {}),
        display: { showMemberActions: settings.chatShowMemberActions !== false },
        roles: Object.fromEntries(settings.chatRoleConfigs.map((role) => [role.id,
          role.id === "generic-participant" && role.label === "Generic Participant" ? "Generic Member" : role.label])),
        prompts: (settings.chatSavedPrompts ?? []).slice(0, 200).map((prompt) => ({ id: prompt.id, label: prompt.label, trigger: prompt.trigger, body: prompt.body.slice(0, 20_000) })),
        skills: skills.skills
          .filter((skill) => skill.capabilityState === "invocable" && !skill.ambiguous)
          .map(({ scopeKinds: _scopeKinds, statusMessage: _statusMessage, ambiguous: _ambiguous, ...skill }) => ({ ...skill, description: skill.description?.slice(0, 400) }))
      };
    },
    wakeKeys: async () => {
      const wake = await desktopApp.cloudRunAwsService.deviceWakePower().catch(() => undefined);
      if (!wake?.machineId) return [];
      return [{ machineId: wake.machineId, instanceId: wake.config.instanceId, region: wake.config.credentials.region, credentials: wake.config.credentials }];
    },
    log: (event, payload) => { void desktopApp.debugLogService.write(event, payload); }
  });

  // A provider's model list read in the background changed the phone's New
  // chat offer: published again (an unchanged catalog is not sent).
  desktopApp.chatService.onNewChatOffersChanged = () => desktopApp.hubPhonePublisher.scheduleCatalog();
}

/** The link to the server follows the hub settings: a new server, or none. */
export async function restartServerChatLink(desktopApp: DesktopApp): Promise<void> {
  await desktopApp.serverChatLink.stop();
  desktopApp.serverChatLinkStarted = true;
  // Also when the link first starts here (after the server's program was
  // updated before the window opened); it waits for the link itself.
  desktopApp.cliMemorySync.start();
  await desktopApp.serverChatLink.start();
}

export async function startServerChatLinkOnce(desktopApp: DesktopApp): Promise<void> {
  if (desktopApp.serverChatLinkStarted) return;
  desktopApp.serverChatLinkStarted = true;
  desktopApp.cliMemorySync.start();
  await desktopApp.serverChatLink.start().catch((error: unknown) => {
    void desktopApp.debugLogService.write("chat.server.start-error", { message: error instanceof Error ? error.message : String(error) });
  });
}

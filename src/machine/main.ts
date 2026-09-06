/**
 * AccordAgents machine runtime (machines transport, work item 2).
 *
 * A headless instance of the app: the same services the desktop runs, composed
 * without Electron, enrolled with one desktop through a machine pairing. It
 * hosts the participants whose home it is, serves the full App MCP tool
 * registry from its own copy of the chats, and talks to the desktop only
 * through the relay.
 *
 * Usage:
 *   node dist/main/machine/main.js --enrollment <pairing.json> [--user-data <dir>] [--name <machine name>]
 *   ACCORDAGENTS_MACHINE_ENROLLMENT=<pairing.json> node dist/main/machine/main.js
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { artifactMembersForConversation } from "../shared/artifacts";
import { assertMobilePairingPackage, type MobilePairingPackage } from "../shared/mobilePairing";
import { createArtifactToolDispatcher, wireArtifactToolHandler, wireChatAppToolHandlers } from "../main/appToolWiring";
import { createHeadlessPlatform, setHostPlatform, userDataPath } from "../main/platform";
import { AgentEnvironmentService } from "../main/services/agentEnvironment";
import { AppMcpService } from "../main/services/appMcp";
import { AppSkillsService } from "../main/services/appSkills";
import { ArtifactService } from "../main/services/artifacts";
import { ArtifactStore } from "../main/services/artifactStore";
import { ChatEventLogService } from "../main/services/chatEventLog";
import { ChatEventMirrorService, chatEventMirrorOptionsFromEnv } from "../main/services/chatEventMirror";
import { ChatService } from "../main/services/chat";
import { CliAgentRunner } from "../main/services/cliAgents";
import { setCommandDebugLogger } from "../main/services/command";
import { DebugLogService } from "../main/services/debugLogs";
import { MachineHostService } from "../main/services/machineHost";
import { PluginService } from "../main/services/plugins";
import { SettingsService } from "../main/services/settings";
import { StorageService } from "../main/services/storage";
import { UserSkillsService } from "../main/services/userSkills";

interface MachineArgs {
  enrollmentPath: string;
  userDataDir?: string;
  machineName?: string;
}

function parseArgs(argv: string[]): MachineArgs {
  let enrollmentPath = process.env.ACCORDAGENTS_MACHINE_ENROLLMENT?.trim() ?? "";
  let userDataDir = process.env.ACCORDAGENTS_USER_DATA_DIR?.trim() || undefined;
  let machineName = process.env.ACCORDAGENTS_MACHINE_NAME?.trim() || undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = (): string => {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error(`${arg} requires a value.`);
      }
      index += 1;
      return value;
    };
    if (arg === "--enrollment") {
      enrollmentPath = next();
    } else if (arg === "--user-data") {
      userDataDir = next();
    } else if (arg === "--name") {
      machineName = next();
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: accordagents-machine --enrollment <pairing.json> [--user-data <dir>] [--name <machine name>]");
      process.exit(0);
    }
  }
  if (!enrollmentPath) {
    throw new Error("A machine enrollment file is required (--enrollment <pairing.json> or ACCORDAGENTS_MACHINE_ENROLLMENT).");
  }
  return { enrollmentPath: path.resolve(enrollmentPath), userDataDir, machineName };
}

function readEnrollment(enrollmentPath: string): MobilePairingPackage {
  const raw = readFileSync(enrollmentPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  assertMobilePairingPackage(parsed);
  if (parsed.purpose !== "machine-host") {
    throw new Error("The enrollment file is not a machine-host pairing.");
  }
  return parsed;
}

function appSkillsSourceRoot(appPath: string): string {
  // Bundle layout (dist/machine/appSkills), compiled tree layout
  // (dist/main/main/appSkills), and the source tree, in that order.
  const candidates = [
    path.join(__dirname, "appSkills"),
    path.join(__dirname, "..", "main", "appSkills"),
    path.join(appPath, "src", "main", "appSkills")
  ];
  return candidates.find((candidate) => existsSync(path.join(candidate, "accord"))) ?? candidates[candidates.length - 1];
}

export async function startMachine(args: MachineArgs): Promise<() => Promise<void>> {
  const platform = createHeadlessPlatform({ userDataDir: args.userDataDir });
  setHostPlatform(platform);
  const enrollment = readEnrollment(args.enrollmentPath);

  const settingsService = new SettingsService();
  const storageService = new StorageService({ sqliteExecutable: "sqlite3" });
  const debugLogService = new DebugLogService();
  setCommandDebugLogger(debugLogService);
  const agentEnvironmentService = new AgentEnvironmentService(settingsService);
  void agentEnvironmentService;
  const cliAgentRunner = new CliAgentRunner(
    debugLogService,
    () => settingsService.getManualAgentEnvironment(),
    { electronAppPath: platform.appPath() }
  );
  void settingsService.getCliAgentRunTimeoutMs()
    .then((timeoutMs) => cliAgentRunner.setRunTimeoutMs(timeoutMs))
    .catch(() => undefined);
  const userSkillsService = new UserSkillsService({ internalSourceRoot: appSkillsSourceRoot(platform.appPath()) });
  const pluginService = new PluginService({ userSkills: userSkillsService });
  void pluginService;
  const appSkillsService = new AppSkillsService({
    sourceRoot: appSkillsSourceRoot(platform.appPath()),
    appVersion: platform.appVersion(),
    debugLogs: debugLogService
  });
  void appSkillsService;
  const appMcpService = new AppMcpService(debugLogService);
  const chatEventLogService = new ChatEventLogService(storageService);
  const chatEventMirrorService = new ChatEventMirrorService(
    storageService,
    chatEventLogService,
    debugLogService,
    chatEventMirrorOptionsFromEnv()
  );
  let hostRef: MachineHostService | undefined;
  const chatService = new ChatService(
    storageService,
    settingsService,
    cliAgentRunner,
    debugLogService,
    appMcpService,
    (conversation) => {
      hostRef?.noteConversationSnapshot(conversation);
    },
    userSkillsService,
    undefined,
    chatEventMirrorService
  );
  wireChatAppToolHandlers(appMcpService, chatService);
  const artifactStore = new ArtifactStore(path.join(userDataPath(), "accordagents.sqlite3"), "sqlite3");
  const artifactService = new ArtifactService({
    store: artifactStore,
    getMembers: async (conversationId) => {
      const conversation = await storageService.getConversation(conversationId);
      if (!conversation || conversation.kind !== "chat") {
        return undefined;
      }
      return artifactMembersForConversation(conversation);
    },
    postNote: (conversationId, eventId, content) => chatService.postArtifactChatNote(conversationId, eventId, content),
    onChanged: () => undefined,
    logger: (event, payload) => {
      void debugLogService.write(event, payload);
    }
  });
  chatService.setArtifactCleanup((conversationId) => artifactService.deleteConversationArtifacts(conversationId));
  wireArtifactToolHandler(appMcpService, chatService, createArtifactToolDispatcher(artifactService));

  await appMcpService.start();
  await storageService.init();
  const identity = await chatEventLogService.getOrCreateDeviceIdentity();

  const host = new MachineHostService(chatService, storageService, settingsService, debugLogService, {
    pairing: enrollment,
    deviceId: identity.originId,
    machineName: args.machineName,
    appVersion: platform.appVersion(),
    outboxPath: path.join(userDataPath(), "machine-outbox.json"),
    detectProviders: () => cliAgentRunner.detectAgents(),
    onSettingsImported: async () => {
      cliAgentRunner.setRunTimeoutMs(await settingsService.getCliAgentRunTimeoutMs());
    }
  });
  hostRef = host;
  await host.start();
  console.log(`AccordAgents machine ${identity.originId} connected to ${enrollment.relayUrl} (user data: ${userDataPath()})`);

  return async () => {
    host.close();
    await appMcpService.stop();
  };
}

if (require.main === module) {
  startMachine(parseArgs(process.argv.slice(2)))
    .then((stop) => {
      const shutdown = (): void => {
        void stop().finally(() => process.exit(0));
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}

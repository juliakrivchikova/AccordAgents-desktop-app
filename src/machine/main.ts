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
import { CHAT_ACTION_LOG_SCOPE } from "../shared/chatActionEvents";
import { ChatActionApplier } from "../main/services/chatActionApplier";
import { ChatActionEmitter } from "../main/services/chatActionEmitter";
import { createChatActionEffects } from "../main/services/chatActionEffects";
import { MachineIdlePower } from "../main/services/machineIdlePower";
import { MachineMaintenance } from "../main/services/machineMaintenance";
import { nativeHostIdentity } from "../main/services/nativeHostIdentity";
import { assertAwsMachinePowerConfig } from "../shared/machinePower";
import { assertCurrentAwsMachine } from "../main/services/awsMachineIdentity";
import { PluginService } from "../main/services/plugins";
import { SettingsService } from "../main/services/settings";
import { StorageService } from "../main/services/storage";
import { UserSkillsService } from "../main/services/userSkills";
import { artifactNameKey } from "../shared/artifacts";

interface MachineArgs {
  enrollmentPath: string;
  userDataDir?: string;
  machineName?: string;
  configurePower?: boolean;
  maintenanceCommand?: string[];
}

function parseArgs(argv: string[]): MachineArgs {
  let enrollmentPath = process.env.ACCORDAGENTS_MACHINE_ENROLLMENT?.trim() ?? "";
  let userDataDir = process.env.ACCORDAGENTS_USER_DATA_DIR?.trim() || undefined;
  let machineName = process.env.ACCORDAGENTS_MACHINE_NAME?.trim() || undefined;
  let configurePower = false;
  let maintenance = false;
  let maintenanceCommand: string[] | undefined;
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
    if (arg === "--" && maintenance) {
      maintenanceCommand = argv.slice(index + 1);
      break;
    } else if (arg === "--maintenance") {
      maintenance = true;
    } else if (arg === "--enrollment") {
      enrollmentPath = next();
    } else if (arg === "--user-data") {
      userDataDir = next();
    } else if (arg === "--name") {
      machineName = next();
    } else if (arg === "--configure-power") {
      configurePower = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: accordagents-machine --enrollment <pairing.json> [--user-data <dir>] [--name <machine name>]\nSetup only: accordagents-machine --configure-power --user-data <dir> (bounded JSON on stdin; keys never in argv)");
      process.exit(0);
    }
  }
  if (maintenance && (!maintenanceCommand?.length || !userDataDir || configurePower)) {
    throw new Error("Maintenance requires --user-data <dir> -- <command> [args] and cannot configure power at the same time.");
  }
  if (!enrollmentPath && !configurePower && !maintenance) {
    throw new Error("A machine enrollment file is required (--enrollment <pairing.json> or ACCORDAGENTS_MACHINE_ENROLLMENT).");
  }
  return { enrollmentPath: path.resolve(enrollmentPath), userDataDir, machineName, configurePower, maintenanceCommand };
}

async function runMachineMaintenance(args: MachineArgs): Promise<void> {
  setHostPlatform(createHeadlessPlatform({ userDataDir: args.userDataDir }));
  const storage = new StorageService({ sqliteExecutable: "sqlite3" });
  await storage.init();
  const maintenance = new MachineMaintenance(storage.machinePower(), path.join(userDataPath(), "native-processes.sqlite3"),
    path.join(userDataPath(), "accordagents.sqlite3"));
  const [command, ...commandArgs] = args.maintenanceCommand!;
  const code = await maintenance.run({ command, args: commandArgs, env: process.env,
    stdin: process.stdin, stdout: process.stdout, stderr: process.stderr });
  process.exit(code);
}

/** Installer-only key hand-off: the same host secret store seals it before
 * acknowledging success. Participant configuration cannot invoke this path. */
async function configureMachinePower(args: MachineArgs): Promise<void> {
  if (process.platform !== "linux") throw new Error("AWS machine power is configured on its Linux host.");
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 16 * 1024) throw new Error("The machine power setup payload is too large.");
    chunks.push(buffer);
  }
  let config: unknown;
  try { config = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("The machine power setup payload is invalid JSON."); }
  assertAwsMachinePowerConfig(config);
  await assertCurrentAwsMachine(config);
  setHostPlatform(createHeadlessPlatform({ userDataDir: args.userDataDir }));
  await new SettingsService().saveMachinePower(config);
  console.log("Machine power configured.");
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
    (progress) => hostRef?.noteNativeProgress(progress),
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
  // The machine records its own decisions and effects in the same log the
  // desktop uses, so a permission answered from the phone is told to the
  // provider here exactly once.
  const chatActionEmitter = new ChatActionEmitter({
    executedBy: args.machineName || "machine",
    hasEvent: async (eventId) => Boolean(await storageService.getChatEvent(eventId)),
    publish: async (action) => {
      await chatEventLogService.appendLocalEvent({
        conversationId: action.conversationId,
        logScopeId: CHAT_ACTION_LOG_SCOPE,
        kind: action.kind,
        payload: action.payload,
        eventId: `chat-action:${action.payload.operationId}`
      });
    },
    logger: (event, payload) => {
      void debugLogService.write(event, payload);
    }
  });
  const identity = await chatEventLogService.getOrCreateDeviceIdentity();
  await storageService.machineProgress().recoverLocal(identity.originId);

  let idlePower: MachineIdlePower | undefined;
  const host = new MachineHostService(chatService, storageService, settingsService, debugLogService, {
    // A signature or a superseded change that arrives here has to become part
    // of this machine's own state, not just a stored event.
    chatActions: new ChatActionApplier({
      effects: createChatActionEffects({
        chat: chatService as unknown as Parameters<typeof createChatActionEffects>[0]["chat"],
        emitter: chatActionEmitter,
        storage: { getConversation: (id) => storageService.getConversation(id) }
      }),
      artifacts: {
        getRevision: async (artifactId, versionEventId) => {
          const revision = await artifactStore.getRevision(artifactId, versionEventId);
          return revision
            ? { version: revision.version, contentHash: revision.contentHash, superseded: revision.superseded }
            : undefined;
        },
        insertSignature: (record) => artifactStore.insertSignature(record),
        hasArtifact: async (artifactId) => Boolean(await artifactStore.getById(artifactId)),
        createArtifact: async (request) => {
          await artifactStore.insertArtifact({
            id: request.artifactId,
            conversationId: request.conversationId,
            name: request.name,
            owner: request.owner,
            contributors: request.contributors,
            requiredSigners: request.requiredSigners,
            labels: request.labels,
            lifecycle: "published",
            allowedDraftAuthors: [],
            requiredDraftAuthors: [],
            audiencePolicyByAuthor: {},
            draftRosterRevision: 0,
            headVersion: request.revision.version,
            createdAt: request.createdAt,
            updatedAt: request.revision.createdAt
          }, artifactNameKey(request.name), {
            artifactId: request.artifactId,
            version: request.revision.version,
            versionEventId: request.revision.versionEventId,
            content: request.revision.content,
            author: request.revision.author,
            note: request.revision.note,
            createdAt: request.revision.createdAt
          });
        },
        retainRevision: (request) => artifactStore.retainProjectedRevision({
          artifactId: request.artifactId,
          versionEventId: request.versionEventId,
          baseVersionEventId: request.baseVersionEventId,
          version: request.version,
          content: request.content,
          contentHash: "",
          author: request.author,
          note: request.note,
          createdAt: request.createdAt
        })
      },
      logger: (event, payload) => {
        void debugLogService.write(event, payload);
      }
    }),
    serveChatActionDependency: async (dependency) => dependency.targetKey.startsWith("artifact:")
      && artifactService.emitRevisionActionFor(dependency.targetKey.slice("artifact:".length), dependency.stateId),
    pairing: enrollment,
    deviceId: identity.originId,
    machineName: args.machineName,
    appVersion: platform.appVersion(),
    eventStorage: storageService,
    eventLog: chatEventLogService,
    publicKeyDerBase64: identity.publicKeyDerBase64,
    outboxPath: path.join(userDataPath(), "machine-outbox.json"),
    nativeProcessDbPath: path.join(userDataPath(), "native-processes.sqlite3"),
    detectProviders: () => cliAgentRunner.detectAgents(),
    onNativeActivitySettled: () => idlePower?.noteActivity() ?? Promise.resolve(),
    idleStopWarning: () => idlePower?.warning(),
    onSettingsImported: async () => {
      cliAgentRunner.setRunTimeoutMs(await settingsService.getCliAgentRunTimeoutMs());
    },
    onDesktopMachineId: (machineId) => {
      chatService.setHostMachineId(machineId);
    }
  });
  hostRef = host;
  const powerConfig = await settingsService.getMachinePower();
  if (!powerConfig) {
    const priorPower = await storageService.machinePower().read();
    if (priorPower && await storageService.machinePower().stopFence(priorPower.bootId)) {
      const hostIdentity = await nativeHostIdentity();
      if (!hostIdentity || hostIdentity.boot === priorPower.bootId) {
        throw new Error("This machine has an unresolved idle stop but its power configuration is missing; native work remains held.");
      }
      await storageService.machinePower().write({ version: 1, bootId: hostIdentity.boot, idleSinceMs: null });
    }
  }
  if (powerConfig) {
    idlePower = new MachineIdlePower({ config: powerConfig, store: storageService.machinePower(), host,
      runner: cliAgentRunner, nativeProcessDbPath: path.join(userDataPath(), "native-processes.sqlite3"),
      log: (event, payload) => { void debugLogService.write(event, payload); } });
    await idlePower.start();
  }
  await host.start();
  idlePower?.ready();
  console.log(`AccordAgents machine ${identity.originId} connected to ${enrollment.relayUrl} (user data: ${userDataPath()})`);

  return async () => {
    await host.shutdown(() => cliAgentRunner.shutdownWarmAgents());
    idlePower?.close();
    await appMcpService.stop();
  };
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  (args.maintenanceCommand ? runMachineMaintenance(args).then(() => undefined) :
    args.configurePower ? configureMachinePower(args).then(() => undefined) : startMachine(args))
    .then((stop) => {
      if (!stop) return;
      let stopping = false;
      const shutdown = (): void => {
        if (stopping) return;
        stopping = true;
        void stop().then(() => process.exit(0), (error) => {
          stopping = false;
          console.error(`Machine shutdown is not complete: ${error instanceof Error ? error.message : String(error)}`);
        });
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}

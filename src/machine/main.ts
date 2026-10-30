/**
 * AccordAgents machine runtime.
 *
 * A headless instance of the app: the same services the desktop runs, composed
 * without Electron, set up by one desktop through a machine pairing. It is a
 * plain client of the User's server (agreements Д1–Д13): it reads the chats
 * there, takes the turns asked there of the members whose home it is, runs
 * them with the full App MCP tool registry, and writes their replies there.
 * It meets the desktop that set it up in its room on that server only for
 * live control (status, scripts, pictures, live progress).
 *
 * Usage:
 *   node dist/main/machine/main.js --enrollment <pairing.json> [--user-data <dir>] [--name <machine name>]
 *   ACCORDAGENTS_MACHINE_ENROLLMENT=<pairing.json> node dist/main/machine/main.js
 */

import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { artifactMembersForConversation } from "../shared/artifacts";
import { assertMobilePairingPackage, type MobilePairingPackage } from "../shared/mobilePairing";
import { deriveMachineChannelKey } from "../shared/machineChannelKey";
import { isMachineSettingsDocument } from "../shared/machineLink";
import { createArtifactToolDispatcher, wireArtifactToolHandler, wireChatAppToolHandlers } from "../main/appToolWiring";
import { createHeadlessPlatform, setHostPlatform, userDataPath } from "../main/platform";
import { AgentEnvironmentService } from "../main/services/agentEnvironment";
import { AppMcpService } from "../main/services/appMcp";
import { AppSkillsService } from "../main/services/appSkills";
import { ArtifactClient } from "../main/services/artifactClient";
import { ArtifactStore } from "../main/services/artifactStore";
import { DeviceIdentityService } from "../main/services/deviceIdentity";
import { ChatService } from "../main/services/chat";
import { CliAgentRunner } from "../main/services/cliAgents";
import { setCommandDebugLogger } from "../main/services/command";
import { DebugLogService } from "../main/services/debugLogs";
import { MachineHostService } from "../main/services/machineHost";
import { MachineServerSettings } from "../main/services/machineServerSettings";
import { openChannelPayload } from "../main/services/machineChannelSealing";
import { MachineIdlePower, assertNativeRegistryClosed } from "../main/services/machineIdlePower";
import { MachineHostPowerRegistry, type MachineHostAdmission } from "../main/services/machineHostPower";
import { NATIVE_PROCESS_REGISTRY_FILE } from "../main/services/nativeProcessRegistry";
import { hostname, uptime } from "node:os";
import { MachineMaintenance } from "../main/services/machineMaintenance";
import { nativeHostIdentity } from "../main/services/nativeHostIdentity";
import { assertAwsMachinePowerConfig, MACHINE_POWER_KEY_CHECK_MS, MACHINE_POWER_REFUSED_EXIT_CODE, MachinePowerRefusal, type AwsMachinePowerConfig } from "../shared/machinePower";
import { AwsMachinePowerClient, verifyMachinePowerKey } from "../shared/awsMachinePowerClient";
import { assertCurrentAwsMachine } from "../main/services/awsMachineIdentity";
import { PluginService } from "../main/services/plugins";
import { SettingsService } from "../main/services/settings";
import { StorageService } from "../main/services/storage";
import { UserSkillsService } from "../main/services/userSkills";
import { ScriptService, handleScriptsOperation } from "../main/services/scripts";
import { HubTunnelClient } from "../main/services/hubTunnelClient";
import { HubClient } from "../main/services/hubClient";
import { ServerChatLink } from "../main/services/serverChatLink";
import { ScriptSecretStore, ScriptStore } from "../main/services/scriptStore";
import { machineScriptHostPhrase } from "../shared/scripts";

interface MachineArgs {
  enrollmentPath: string;
  userDataDir?: string;
  machineName?: string;
  configurePower?: boolean;
  /** Setup only: ask AWS whether the key on stdin works, writing nothing. */
  checkPower?: boolean;
  /** Setup only: put back the power key the last configure replaced (a
   *  runtime that did not come back after the handover). */
  revertPower?: boolean;
  maintenanceCommand?: string[];
  /** Setup only: print this machine's device identity (creating it once). */
  deviceIdentity?: boolean;
}

function parseArgs(argv: string[]): MachineArgs {
  let enrollmentPath = process.env.ACCORDAGENTS_MACHINE_ENROLLMENT?.trim() ?? "";
  let userDataDir = process.env.ACCORDAGENTS_USER_DATA_DIR?.trim() || undefined;
  let machineName = process.env.ACCORDAGENTS_MACHINE_NAME?.trim() || undefined;
  let configurePower = false;
  let checkPower = false;
  let revertPower = false;
  let deviceIdentity = false;
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
    } else if (arg === "--check-power") {
      checkPower = true;
    } else if (arg === "--revert-power") {
      revertPower = true;
    } else if (arg === "--device-identity") {
      deviceIdentity = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: accordagents-machine --enrollment <pairing.json> [--user-data <dir>] [--name <machine name>]\nSetup only: accordagents-machine --check-power (bounded JSON on stdin; asks AWS, writes nothing)\nSetup only: accordagents-machine --configure-power --user-data <dir> (bounded JSON on stdin; keys never in argv)\nSetup only: accordagents-machine --revert-power --user-data <dir> (puts back the key the last --configure-power replaced)");
      process.exit(0);
    }
  }
  if ([configurePower, revertPower, checkPower].filter(Boolean).length > 1) throw new Error("--check-power, --configure-power and --revert-power cannot be combined.");
  if (maintenance && (!maintenanceCommand?.length || !userDataDir || configurePower || revertPower || checkPower)) {
    throw new Error("Maintenance requires --user-data <dir> -- <command> [args] and cannot configure power at the same time.");
  }
  if (deviceIdentity && !userDataDir) {
    throw new Error("Setup commands require --user-data <dir>.");
  }
  if (!enrollmentPath && !configurePower && !revertPower && !checkPower && !maintenance && !deviceIdentity) {
    throw new Error("A machine enrollment file is required (--enrollment <pairing.json> or ACCORDAGENTS_MACHINE_ENROLLMENT).");
  }
  return { enrollmentPath: path.resolve(enrollmentPath || "."), userDataDir, machineName, configurePower, checkPower, revertPower, maintenanceCommand,
    deviceIdentity };
}

async function runMachineMaintenance(args: MachineArgs): Promise<void> {
  setHostPlatform(createHeadlessPlatform({ userDataDir: args.userDataDir }));
  const storage = new StorageService({ sqliteExecutable: "sqlite3" });
  await storage.init();
  const maintenance = new MachineMaintenance(storage.machinePower(), path.join(userDataPath(), NATIVE_PROCESS_REGISTRY_FILE),
    path.join(userDataPath(), "accordagents.sqlite3"));
  // Maintenance is work like any other on this host. Without its own claim a
  // runtime in another profile could find the instance idle and stop it in the
  // middle of an install or a mirror sync.
  const hostIdentity = await nativeHostIdentity().catch(() => undefined);
  let presence: MachineHostPowerRegistry | undefined;
  if (hostIdentity) {
    presence = new MachineHostPowerRegistry({
      profilePath: userDataPath(), bootId: hostIdentity.boot, kind: "maintenance",
      uptimeMs: () => uptime() * 1000
    });
    const admitted = await presence.admit("this maintenance command");
    if (!admitted.admitted) {
      process.stderr.write(`${admitted.reason}\n`);
      process.exit(69);
    }
  }
  const [command, ...commandArgs] = args.maintenanceCommand!;
  try {
    const code = await maintenance.run({ command, args: commandArgs, env: process.env,
      stdin: process.stdin, stdout: process.stdout, stderr: process.stderr });
    // Released only after the guardian confirmed the child is gone, which
    // `run` awaits: an unconfirmed kill keeps the host awake on purpose.
    presence?.release();
    process.exit(code);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

/** Setup only: the identity this machine signs its requests to the User's
 *  server with, created once and kept in its own database, so the desktop
 *  can name it on the server's roster (and seal its settings for it) before
 *  the runtime first connects. The private key never leaves. */
async function printDeviceIdentity(args: MachineArgs): Promise<void> {
  setHostPlatform(createHeadlessPlatform({ userDataDir: args.userDataDir }));
  const storage = new StorageService({ sqliteExecutable: "sqlite3" });
  await storage.init();
  const identity = await new DeviceIdentityService(storage).getOrCreateDeviceIdentity();
  await finishSetupCommand({ originId: identity.originId, publicKeyDerBase64: identity.publicKeyDerBase64 });
}

/** The storage keeps a sqlite3 process open; a setup command prints its one
 *  JSON line and exits instead of waiting for it. */
function finishSetupCommand(result: unknown): Promise<never> {
  return new Promise(() => {
    process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0));
  });
}

const POWER_KEY_CHECK_RETRY_MS = 5_000;

/** The power key the installer pipes in: bounded, valid, and for this very
 * instance (IMDSv2). Anything wrong with it is a refusal, not a retry. */
async function readPowerConfig(): Promise<AwsMachinePowerConfig> {
  if (process.platform !== "linux") throw new Error("AWS machine power is configured on its Linux host.");
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 16 * 1024) throw new MachinePowerRefusal("The machine power setup payload is too large.");
    chunks.push(buffer);
  }
  let config: unknown;
  try { config = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new MachinePowerRefusal("The machine power setup payload is invalid JSON."); }
  try { assertAwsMachinePowerConfig(config); }
  catch (error) { throw new MachinePowerRefusal(error instanceof Error ? error.message : String(error)); }
  await assertCurrentAwsMachine(config);
  return config;
}

/** Installer-only, while the runtime still runs: asks AWS whether the key can
 * read and, as a dry run, stop this instance. A key AWS or this instance
 * refuses exits with MACHINE_POWER_REFUSED_EXIT_CODE; any other failure is
 * temporary and the installer tries the key again later. Writes nothing. */
async function checkMachinePower(): Promise<void> {
  const client = new AwsMachinePowerClient(await readPowerConfig());
  try {
    await verifyMachinePowerKey(client, { deadlineMs: MACHINE_POWER_KEY_CHECK_MS, retryMs: POWER_KEY_CHECK_RETRY_MS });
  } finally {
    client.close();
  }
  console.log("Machine power key accepted.");
}

/** Installer-only key hand-off, with the runtime drained and the key already
 * checked: the same host secret store seals it before acknowledging success.
 * Participant configuration cannot invoke this path. */
async function configureMachinePower(args: MachineArgs): Promise<void> {
  const config = await readPowerConfig();
  setHostPlatform(createHeadlessPlatform({ userDataDir: args.userDataDir }));
  await new SettingsService().saveMachinePower(config);
  console.log("Machine power configured.");
}

/** Setup only, with the runtime drained: the runtime did not come back after
 * a handover, so the key it ran with before (or none) is put back. */
async function revertMachinePower(args: MachineArgs): Promise<void> {
  setHostPlatform(createHeadlessPlatform({ userDataDir: args.userDataDir }));
  await new SettingsService().revertMachinePower();
  console.log("Machine power reverted.");
}

function readEnrollment(enrollmentPath: string): MobilePairingPackage & { hubUrl: string } {
  const raw = readFileSync(enrollmentPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  assertMobilePairingPackage(parsed);
  if (parsed.purpose !== "machine-host") {
    throw new Error("The enrollment file is not a machine-host pairing.");
  }
  // The shared relay is gone: a machine meets its desktop and phone only on
  // the User's own server, so an enrollment without one cannot connect.
  if (!parsed.hubUrl) {
    throw new Error("This machine was set up for the shared relay, which AccordAgents no longer uses. Set up your server on the desktop, then set this machine up again from there (Cloud run in a member's settings).");
  }
  return { ...parsed, hubUrl: parsed.hubUrl };
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

  const settingsService = new SettingsService({ profileHome: process.env.ACCORD_AGENTS_MACHINE_PROFILE_HOME });
  const storageService = new StorageService({ sqliteExecutable: "sqlite3" });
  const debugLogService = new DebugLogService();
  setCommandDebugLogger(debugLogService);
  const log = (event: string, payload: Record<string, unknown>): void => { void debugLogService.write(event, payload); };
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
  // The device identity this machine signs its requests to the User's server
  // with, and what it seals and signs in its room.
  const deviceIdentityService = new DeviceIdentityService(storageService);
  const deviceIdentity = () => deviceIdentityService.getOrCreateDeviceIdentity();
  let hostRef: MachineHostService | undefined;
  const chatService = new ChatService(
    storageService,
    settingsService,
    cliAgentRunner,
    debugLogService,
    appMcpService,
    undefined,
    userSkillsService,
    (progress) => hostRef?.noteNativeProgress(progress)
  );
  // Until the User's server says which machine this is, no member belongs to
  // this runtime and nothing runs here.
  chatService.setHostMachineId(undefined);
  wireChatAppToolHandlers(appMcpService, chatService);
  // Documents are the User's server's (Д9): this machine keeps a copy and
  // writes every change its members make through the server, exactly as the
  // computer does for its own members.
  const artifactStore = new ArtifactStore(path.join(userDataPath(), "accordagents.sqlite3"), "sqlite3");
  const artifactService = new ArtifactClient({
    store: artifactStore,
    getMembers: async (conversationId) => {
      const opened = await storageService.openConversation(conversationId, 1);
      return opened?.conversation.kind === "chat" ? artifactMembersForConversation(opened.conversation) : undefined;
    },
    postNote: (conversationId, eventId, content) => chatService.postArtifactChatNote(conversationId, eventId, content),
    hasChat: async (conversationId) => (await storageService.openConversation(conversationId, 1))?.conversation.kind === "chat",
    logger: log
  });
  chatService.setArtifactCleanup((conversationId) => artifactService.deleteConversationArtifacts(conversationId));
  wireArtifactToolHandler(appMcpService, chatService, createArtifactToolDispatcher(artifactService));

  await appMcpService.start();
  await storageService.init();
  const identity = await deviceIdentity();

  let idlePower: MachineIdlePower | undefined;
  /** The switch as this machine last read it; reported in every hello. */
  let autoStopEnabled: boolean | undefined = await settingsService.getMachineAutoStopEnabled().catch(() => undefined);
  // Every runtime on this host publishes what it is doing and consults the
  // shared barrier, with or without AWS power configuration. A deployment that
  // cannot stop the instance itself must still stop another one from stopping
  // it underneath, and must refuse to start work into a stop already decided.
  const nativeProcessDbPath = path.join(userDataPath(), NATIVE_PROCESS_REGISTRY_FILE);
  let presence: MachineHostPowerRegistry | undefined;
  let presenceWarning = "This machine cannot verify host-wide admission; native work remains queued.";
  const hostIdentity = await nativeHostIdentity().catch(() => undefined);
  if (hostIdentity) {
    try {
      presence = new MachineHostPowerRegistry({
        profilePath: userDataPath(),
        bootId: hostIdentity.boot,
        uptimeMs: () => uptime() * 1000
      });
      // A crash leaves a claim whose owner is dead, and a dead owner is not
      // proof its providers died with it. Clearing it needs this profile's own
      // guardian receipts; otherwise one crash disables automatic stop until
      // the host reboots.
      const cleared = await presence.adoptOwnStaleClaims(
        () => assertNativeRegistryClosed(nativeProcessDbPath, hostIdentity)
      ).catch((error) => {
        log("machine.host-power.adopt-failed", { message: error instanceof Error ? error.message : String(error) });
        return 0;
      });
      await presence.withLock(() => presence!.publish(true));
      presenceWarning = "";
      if (cleared) log("machine.host-power.adopted", { cleared });
    } catch (error) {
      presence = undefined;
      presenceWarning = `Host-wide admission is unavailable; native work remains queued: ${error instanceof Error ? error.message : String(error)}`;
      log("machine.host-power.unavailable", { message: error instanceof Error ? error.message : String(error) });
    }
  }
  // Refused before a provider (or a scheduled script) is started, not
  // discovered when the instance disappears underneath a running turn.
  const admitHostWork = (what: string): MachineHostAdmission | Promise<MachineHostAdmission> => presence
    ? presence.admit(what)
    : { admitted: false, reason: presenceWarning || "This machine cannot confirm it is staying awake." };
  cliAgentRunner.setHostAdmission(admitHostWork);
  // The name the desktop last gave this machine, kept for a restart while the
  // desktop is away; the host name only until it first greets this machine.
  const machineLabelPath = path.join(userDataPath(), "machine-label.json");
  let storedMachineLabel = await readFile(machineLabelPath, "utf8")
    .then((text) => (JSON.parse(text) as { name?: unknown }).name)
    .then((name) => typeof name === "string" && name.trim() ? name.trim() : undefined)
    .catch(() => undefined);
  const hubUrl = enrollment.hubUrl;
  const hubClient = new HubClient({ url: hubUrl, identity: deviceIdentity });
  // The User's server owns every chat (Д1): this machine writes its members'
  // replies there and takes their turns from there, like every device (Д2).
  // It moves nothing there: the computer did that.
  const serverChatLink = new ServerChatLink({
    storage: storageService,
    chat: chatService,
    identity: deviceIdentity,
    hubConfig: async () => ({ url: hubUrl }),
    machineNames: async () => [],
    movesChats: false,
    artifacts: artifactService,
    log
  });
  const host: MachineHostService = new MachineHostService(chatService, debugLogService, {
    pairing: enrollment,
    deviceId: identity.originId,
    machineName: args.machineName,
    appVersion: platform.appVersion(),
    publicKeyDerBase64: identity.publicKeyDerBase64,
    identity: deviceIdentity,
    // This machine meets the computer that set it up in its room on the
    // User's server, for live control only.
    createClient: (pairing: MobilePairingPackage) => new HubTunnelClient({
      hubUrl, rendezvousId: pairing.rendezvousId, role: "machine", identity: deviceIdentity
    }),
    storage: storageService,
    instancePath: path.join(userDataPath(), "machine-instance.json"),
    nativeProcessDbPath,
    // A stop another deployment has made final keeps this one from taking
    // new turns: they wait on the server for the next start.
    hostStopCommitted: () => {
      try { return !presence || presence.stopIntent()?.phase === "committed"; }
      catch { return true; }
    },
    detectProviders: () => cliAgentRunner.detectAgents(),
    onNativeActivitySettled: () => idlePower?.noteActivity() ?? Promise.resolve(),
    idleStopWarning: () => presenceWarning || idlePower?.warning(),
    autoStopEnabled: () => autoStopEnabled,
    unsentServerWrites: async () => {
      const status = await serverChatLink.status();
      return status ? { queued: status.queued, ...(status.lastError ? { lastError: status.lastError } : {}) } : undefined;
    },
    // Its members' live progress, for the phone (the server keeps none of it).
    postProgress: async (frames) => { await hubClient.postProgress(frames); },
    // These two reach `scriptService`, built below: the desktop's greeting and
    // its requests arrive only after host.start(), further down.
    onDesktopMachineName: (name) => {
      scriptService.setHostName(name, machineScriptHostPhrase(name));
      if (name !== storedMachineLabel) {
        storedMachineLabel = name;
        void writeFile(machineLabelPath, JSON.stringify({ name }), "utf8").catch(() => undefined);
      }
    },
    scripts: {
      handle: (operation) => handleScriptsOperation(scriptService, operation),
      keepsHostAwake: () => scriptService.keepsHostAwake(),
      scheduledCount: () => scriptService.scheduledCount(),
    }
  });
  hostRef = host;
  // Scheduled scripts that live on this machine: they run here with the lid
  // of the laptop closed, keep the instance awake while one is switched on,
  // and wake the members that run here.
  const machineLabel = storedMachineLabel ?? args.machineName ?? hostname();
  let scriptsAwake = "";
  const scriptService: ScriptService = new ScriptService({
    store: new ScriptStore(path.join(userDataPath(), "scripts")),
    secrets: new ScriptSecretStore(path.join(userDataPath(), "script-secrets.json"), platform.secrets),
    hostId: `machine:${identity.originId}`,
    hostLabel: machineLabel,
    hostPhrase: machineScriptHostPhrase(machineLabel),
    tokens: appMcpService,
    chat: {
      describeChat: (chatId) => chatService.describeChatForScripts(chatId),
      postScriptMessage: (input) => chatService.postScriptMessage({ ...input, progress: (progress) => host.noteNativeProgress(progress) })
    },
    node: { command: process.execPath, env: {} },
    admit: admitHostWork,
    localMembersOnly: true,
    debugLog: log,
    onChanged: () => {
      host.noteScriptsChanged();
      // Whether it must stay awake, and for how many scripts, is part of
      // what the desktop shows and what its automatic stop asks.
      const awake = `${scriptService.keepsHostAwake()}:${scriptService.scheduledCount()}`;
      if (awake !== scriptsAwake) {
        scriptsAwake = awake;
        void host.publishPowerStatus().catch(() => undefined);
      }
    }
  });
  chatService.setScriptHost(scriptService);
  appMcpService.setScriptApiHandler((context, _route, body) => scriptService.postFromScript(context, body));
  // A picture the User attached on the computer is read from the computer;
  // one she sent from her phone is read from her server.
  chatService.setMachineLink({
    fetchAttachment: (conversationId, attachmentId) => host.requestAttachment(conversationId, attachmentId)
  });
  chatService.setHubBlobReader((reference) => hubClient.downloadBytes(reference));
  // The settings the computer published for this machine on the User's
  // server, sealed for it alone.
  const machineSettings = new MachineServerSettings({
    read: (since) => hubClient.machineSettings(since),
    open: async (sealed) => {
      const document = await openChannelPayload<unknown>(sealed, deriveMachineChannelKey(await deviceIdentity(), enrollment.issuer.publicKeyDerBase64, enrollment.rendezvousId));
      if (!isMachineSettingsDocument(document)) throw new Error("The settings published for this machine are not readable by this runtime.");
      return document;
    },
    apply: async (document) => {
      await settingsService.importMachineSettingsSnapshot(document.settings);
      chatService.setMachineProjects(document.projects);
    },
    onImported: async () => {
      cliAgentRunner.setRunTimeoutMs(await settingsService.getCliAgentRunTimeoutMs());
      // The User's automatic-stop switch arrives with the settings. Switched
      // on again, idle counts from now; either way the desktop is told what
      // this machine now has, so the two cannot silently disagree.
      const enabled = await settingsService.getMachineAutoStopEnabled().catch(() => undefined);
      if (enabled === autoStopEnabled) return;
      // The new idle start is written before the switch reads on here: a
      // failed write keeps it off, and the next import tries again.
      if (enabled === true && autoStopEnabled === false) await idlePower?.switchedOn();
      autoStopEnabled = enabled;
      void host.publishPowerStatus().catch(() => undefined);
    },
    log
  });
  // Before a member here starts a turn the server asked of it: nothing new
  // while this machine stops; its settings and its project folder as the
  // computer last published them.
  chatService.setServerTurnPreparation(async (turn) => {
    if (!host.takesNewWork()) return false;
    await machineSettings.refresh("turn");
    await chatService.refreshMachineRepository(turn.conversationId);
    return host.takesNewWork();
  });
  host.onFenceLifted(() => {
    void chatService.resumeServerTurns().catch((error) => log("machine.server-turns.resume-error", { message: error instanceof Error ? error.message : String(error) }));
    // Answers to its members' cards that waited while it took nothing new.
    void chatService.resumeServerCards({ messages: false }).catch((error) => log("machine.server-cards.resume-error", { message: error instanceof Error ? error.message : String(error) }));
  });
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
      runner: cliAgentRunner, nativeProcessDbPath: nativeProcessDbPath,
      ...(presence ? { presence } : {}),
      // The User's switch as this machine took it from the desktop's settings.
      enabled: async () => {
        if (autoStopEnabled === undefined) throw new Error("Settings could not be read; automatic stop waits until they can.");
        return autoStopEnabled;
      },
      log });
    await idlePower.start();
  }
  await host.start();
  // The server's live word: its settings changed (or the link came back and
  // a word may have been missed).
  const stopLive = hubClient.live((connected) => {
    if (connected) void machineSettings.refresh("reconnected");
  }, (frame) => {
    if (frame.type === "settings") void machineSettings.refresh("published");
  });
  // Which machine this is, as the server's roster says (its members are the
  // ones whose home is that machine), then its settings, then its chats and
  // turns. A machine the roster does not name yet runs nothing and asks again.
  let stopping = false;
  const linking = (async () => {
    for (let attempt = 1; !stopping; attempt += 1) {
      try {
        const me = await hubClient.me();
        if (me.role !== "machine" || !me.machineId) throw new Error(`The server knows this device as ${me.role}, not as a machine.`);
        chatService.setHostMachineId(me.machineId);
        log("machine.server.identified", { machineId: me.machineId, attempt });
        break;
      } catch (error) {
        log("machine.server.identify-failed", { attempt, message: error instanceof Error ? error.message : String(error) });
        await new Promise((resolve) => setTimeout(resolve, Math.min(60_000, 2_000 * 2 ** Math.min(5, attempt - 1))).unref?.());
      }
    }
    if (stopping) return;
    await machineSettings.refresh("start");
    machineSettings.start();
    if (stopping) return;
    await serverChatLink.start();
    // Its members' decided removals a restart left waiting (Д2: made here).
    void chatService.resumeQueuedMemberRemovals().catch((error) => log("machine.member-removal.resume-error", { message: error instanceof Error ? error.message : String(error) }));
  })().catch((error) => log("machine.server.link-error", { message: error instanceof Error ? error.message : String(error) }));
  void scriptService.start().catch((error) => debugLogService.write("scripts.start.error", { message: String(error) }));
  idlePower?.ready();
  // A runtime with no AWS key is still an equal deployment on this host: it
  // publishes both busy and idle, and may veto another runtime's stop.
  let presenceRefresh: Promise<void> = Promise.resolve();
  let refreshing = false;
  let presenceClosed = false;
  const presenceTimer = !idlePower && presence ? setInterval(() => {
    if (refreshing || presenceClosed) return;
    refreshing = true;
    presenceRefresh = (async () => {
      const busy = await host.hasWorkForIdleStop() || cliAgentRunner.hasActiveNativeWork();
      if (!presenceClosed) presence!.publish(busy);
    })().catch(error => {
      presenceWarning = `Host-wide idle state cannot be saved; the machine stays awake: ${error instanceof Error ? error.message : String(error)}`;
      void host.publishPowerStatus().catch(() => undefined);
    }).finally(() => { refreshing = false; });
  }, 30_000) : undefined;
  presenceTimer?.unref();
  console.log(`AccordAgents machine ${identity.originId} connected to ${enrollment.hubUrl} (user data: ${userDataPath()})`);

  // One stop, whoever asks for it (the service manager's SIGTERM): a second
  // request waits for the first instead of running the shutdown again. A stop
  // that failed may be asked for again.
  let stopRequest: Promise<void> | undefined;
  const stopOnce = async (): Promise<void> => {
    stopping = true;
    presenceClosed = true;
    if (presenceTimer) clearInterval(presenceTimer);
    await presenceRefresh;
    try { presence?.publish(true); } catch (error) {
      log("machine.host-power.shutdown-claim-failed", { message: String(error) });
    }
    await scriptService.stop();
    // Nothing new is taken from here on; the members running now end, and
    // what they wrote last (their replies, their turns' ends) is queued for
    // the server while the link still stands.
    await host.shutdown(() => cliAgentRunner.shutdownWarmAgents());
    await linking;
    const deadline = Date.now() + 5_000;
    for (;;) {
      const status = await serverChatLink.status().catch(() => undefined);
      if (!status || status.queued === 0 || Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // An unreachable server gets what is left at the next start.
    await serverChatLink.stop();
    machineSettings.stop();
    stopLive();
    idlePower?.close();
    await idlePower?.releaseAfterShutdown();
    // The registration outlives the idle scheduler: it is released only once
    // this runtime's own native work is proven closed, so a neighbour never
    // reads a shutdown in progress as an idle host.
    if (presence && hostIdentity && !idlePower) {
      if (cliAgentRunner.hasActiveNativeWork()) throw new Error("Native work has not finished shutting down.");
      await assertNativeRegistryClosed(nativeProcessDbPath, hostIdentity);
      presence.release();
    }
    await appMcpService.stop();
  };
  return () => {
    stopRequest ??= stopOnce().catch((error: unknown) => {
      stopRequest = undefined;
      throw error;
    });
    return stopRequest;
  };
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  (args.maintenanceCommand ? runMachineMaintenance(args).then(() => undefined) :
    args.deviceIdentity ? printDeviceIdentity(args).then(() => undefined) :
    args.configurePower ? configureMachinePower(args).then(() => undefined) :
    args.checkPower ? checkMachinePower().then(() => undefined) :
    args.revertPower ? revertMachinePower(args).then(() => undefined) : startMachine(args))
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
      process.exit(error instanceof MachinePowerRefusal ? MACHINE_POWER_REFUSED_EXIT_CODE : 1);
    });
}

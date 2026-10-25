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
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { moveEnrollment, shellCommandLine } from "./transportMove";
import path from "node:path";
import { artifactMembersForConversation } from "../shared/artifacts";
import { ACCORD_MANAGED_MOBILE_CONTROL_DEFAULTS, assertMobilePairingPackage, type MobilePairingPackage } from "../shared/mobilePairing";
import { createArtifactToolDispatcher, wireArtifactToolHandler, wireChatAppToolHandlers } from "../main/appToolWiring";
import { createHeadlessPlatform, setHostPlatform, userDataPath } from "../main/platform";
import { AgentEnvironmentService } from "../main/services/agentEnvironment";
import { AppMcpService } from "../main/services/appMcp";
import { AppSkillsService } from "../main/services/appSkills";
import { ArtifactService } from "../main/services/artifacts";
import { ArtifactStore } from "../main/services/artifactStore";
import { artifactEventWriter, artifactProjectionPort } from "../main/services/artifactReplication";
import { createChatChangeTransport, scheduleChatChangePruning } from "../main/services/chatChangeTransport";
import { importChatCopy } from "../main/services/chatCopy";
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
import { HUB_SCOPE_PREFIXES, HubSync, PULLED_KEY, hubChatChangeApplier, hubPushedThrough } from "../main/services/hubSync";
import { HubClient } from "../main/services/hubClient";
import { signHubRequest } from "../main/services/hubAuth";
import { setMailboxRegistrationSigner } from "../main/services/mailboxAccess";
import { ScriptSecretStore, ScriptStore } from "../main/services/scriptStore";
import { machineScriptHostPhrase } from "../shared/scripts";
import { PHONE_TURN_RESUME_EVERY_MS, PHONE_TURN_RESUME_WINDOW_MS } from "../shared/hubProtocol";
import { phoneTurnsSince } from "../main/services/phoneTurnClaims";

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
  /** Setup only: import a chat copy the desktop exported into this directory. */
  importChatCopy?: string;
  /** The desktop's id for this machine, for which members' replies are its own. */
  machineId?: string;
}

function parseArgs(argv: string[]): MachineArgs {
  let enrollmentPath = process.env.ACCORDAGENTS_MACHINE_ENROLLMENT?.trim() ?? "";
  let userDataDir = process.env.ACCORDAGENTS_USER_DATA_DIR?.trim() || undefined;
  let machineName = process.env.ACCORDAGENTS_MACHINE_NAME?.trim() || undefined;
  let configurePower = false;
  let checkPower = false;
  let revertPower = false;
  let deviceIdentity = false;
  let importChatCopy: string | undefined;
  let machineId: string | undefined;
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
    } else if (arg === "--import-chat-copy") {
      importChatCopy = next();
    } else if (arg === "--machine-id") {
      machineId = next();
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: accordagents-machine --enrollment <pairing.json> [--user-data <dir>] [--name <machine name>]\nSetup only: accordagents-machine --check-power (bounded JSON on stdin; asks AWS, writes nothing)\nSetup only: accordagents-machine --configure-power --user-data <dir> (bounded JSON on stdin; keys never in argv)\nSetup only: accordagents-machine --revert-power --user-data <dir> (puts back the key the last --configure-power replaced)");
      process.exit(0);
    }
  }
  if ([configurePower, revertPower, checkPower].filter(Boolean).length > 1) throw new Error("--check-power, --configure-power and --revert-power cannot be combined.");
  if (maintenance && (!maintenanceCommand?.length || !userDataDir || configurePower || revertPower || checkPower)) {
    throw new Error("Maintenance requires --user-data <dir> -- <command> [args] and cannot configure power at the same time.");
  }
  if ((deviceIdentity || importChatCopy) && !userDataDir) {
    throw new Error("Setup commands require --user-data <dir>.");
  }
  if (!enrollmentPath && !configurePower && !revertPower && !checkPower && !maintenance && !deviceIdentity && !importChatCopy) {
    throw new Error("A machine enrollment file is required (--enrollment <pairing.json> or ACCORDAGENTS_MACHINE_ENROLLMENT).");
  }
  return { enrollmentPath: path.resolve(enrollmentPath || "."), userDataDir, machineName, configurePower, checkPower, revertPower, maintenanceCommand,
    deviceIdentity, importChatCopy: importChatCopy ? path.resolve(importChatCopy) : undefined, machineId };
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

/** Setup only: the identity this machine signs its events with, created once
 *  and kept in its own database, so the desktop can address chat changes to
 *  it before the runtime first connects. The private key never leaves. */
async function printDeviceIdentity(args: MachineArgs): Promise<void> {
  setHostPlatform(createHeadlessPlatform({ userDataDir: args.userDataDir }));
  const storage = new StorageService({ sqliteExecutable: "sqlite3" });
  await storage.init();
  const identity = await new ChatEventLogService(storage).getOrCreateDeviceIdentity();
  await finishSetupCommand({ originId: identity.originId, publicKeyDerBase64: identity.publicKeyDerBase64 });
}

/** The storage keeps a sqlite3 process open; a setup command prints its one
 *  JSON line and exits instead of waiting for it. */
function finishSetupCommand(result: unknown): Promise<never> {
  return new Promise(() => {
    process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0));
  });
}

/** Setup only: merges the desktop's chat copy into this machine's database.
 *  Runs while the runtime is stopped; nothing it writes is emitted. */
async function runChatCopyImport(args: MachineArgs): Promise<void> {
  setHostPlatform(createHeadlessPlatform({ userDataDir: args.userDataDir }));
  const storage = new StorageService({ sqliteExecutable: "sqlite3" });
  await storage.init();
  // The artifact tables the copy fills are created by the artifact store.
  await new ArtifactStore(path.join(userDataPath(), "accordagents.sqlite3"), "sqlite3").init();
  const identity = await new ChatEventLogService(storage).getOrCreateDeviceIdentity();
  const summary = await importChatCopy(storage, args.importChatCopy!, { hostMachineId: args.machineId, localOriginId: identity.originId });
  await finishSetupCommand({ ok: true, ...summary });
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

function readEnrollment(enrollmentPath: string): MobilePairingPackage {
  const raw = readFileSync(enrollmentPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  assertMobilePairingPackage(parsed);
  if (parsed.purpose !== "machine-host") {
    throw new Error("The enrollment file is not a machine-host pairing.");
  }
  return parsed;
}

/** How long a moved runtime waits for its own orderly stop before it exits
 *  anyway: its enrollment names the new address, and staying up on the old
 *  one with no new work would help nobody. */
const RESTART_STOP_TIMEOUT_MS = 30_000;

/** Starts this runtime again after it stops. Under its service the service
 *  manager does (it restarts a runtime that exits); run by hand, a copy of
 *  it is started once this one has let go of its files. */
function restartRuntime(stop: (() => Promise<void>) | undefined): void {
  if (!process.env.INVOCATION_ID) {
    // The copy waits until this process is gone: two runtimes never share
    // the machine's files.
    const command = shellCommandLine([process.execPath, ...process.execArgv, ...process.argv.slice(1)]);
    spawn("/bin/sh", ["-c", `while kill -0 ${process.pid} 2>/dev/null; do sleep 1; done; exec ${command}`], { detached: true, stdio: "ignore", env: process.env }).unref();
  }
  void Promise.race([
    (stop ?? (async () => undefined))().catch((error: unknown) => {
      console.error(`Machine shutdown before restart is not complete: ${error instanceof Error ? error.message : String(error)}`);
    }),
    new Promise((resolve) => setTimeout(resolve, RESTART_STOP_TIMEOUT_MS))
  ]).finally(() => process.exit(0));
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
  /** Set once the runtime is up; a move restarts through it. */
  let stopRuntime: (() => Promise<void>) | undefined;
  // This machine's own mailboxes on the User's server (its rooms with
  // other machines, with the phone) are registered with its signature.
  setMailboxRegistrationSigner(async ({ url, method, pathWithQuery, body }) => {
    // Only the User's own server takes it; the shared relay never sees it.
    const relay = enrollment.relayUrl ? new URL(enrollment.relayUrl) : undefined;
    const shared = ACCORD_MANAGED_MOBILE_CONTROL_DEFAULTS.relayUrl ? new URL(ACCORD_MANAGED_MOBILE_CONTROL_DEFAULTS.relayUrl).host : undefined;
    if (!relay || relay.host !== url.host || relay.host === shared) return undefined;
    return signHubRequest(await chatEventLogService.getOrCreateDeviceIdentity(), { method, pathWithQuery, body });
  });
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
  // Until enrollment supplies our identity, no member belongs to this runtime.
  chatService.setHostMachineId(undefined);
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
    // Through the User's hub nobody is waited on (see MachineHostService).
    ...artifactEventWriter(storageService, chatEventLogService, () => hostRef?.chatActionRecipients() ?? (enrollment.hubUrl ? [] : [{
      deviceId: enrollment.issuer.originId, channelId: enrollment.rendezvousId
    }]), artifactStore),
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
        void debugLogService.write("machine.host-power.adopt-failed", { message: error instanceof Error ? error.message : String(error) });
        return 0;
      });
      await presence.withLock(() => presence!.publish(true));
      presenceWarning = "";
      if (cleared) void debugLogService.write("machine.host-power.adopted", { cleared });
    } catch (error) {
      presence = undefined;
      presenceWarning = `Host-wide admission is unavailable; native work remains queued: ${error instanceof Error ? error.message : String(error)}`;
      void debugLogService.write("machine.host-power.unavailable", { message: error instanceof Error ? error.message : String(error) });
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
  const hubRoom = (url: string, rendezvousId: string) => new HubTunnelClient({
    hubUrl: url, rendezvousId, role: "machine",
    identity: () => chatEventLogService.getOrCreateDeviceIdentity()
  });
  const host: MachineHostService = new MachineHostService(chatService, storageService, settingsService, debugLogService, {
    // A signature or a superseded change that arrives here has to become part
    // of this machine's own state, not just a stored event.
    chatActions: new ChatActionApplier({
      effects: createChatActionEffects({
        chat: chatService as unknown as Parameters<typeof createChatActionEffects>[0]["chat"],
        emitter: chatActionEmitter,
        applyApproval: (event, payload) => host.applyApprovalAction(event, payload),
        applyChoice: (event, payload) => host.applyChoiceAction(event, payload),
        homeMachineId: () => host.enrolledMachineId(),
        storage: { getConversation: (id) => storageService.getConversation(id) }
      }),
      artifacts: artifactProjectionPort(artifactStore, () => undefined),
      logger: (event, payload) => {
        void debugLogService.write(event, payload);
      }
    }),
    serveChatActionDependency: async (dependency) => dependency.targetKey.startsWith("artifact:")
      && artifactService.emitRevisionActionFor(dependency.targetKey.slice("artifact:".length), dependency.stateId),
    pairing: enrollment,
    // With the User's hub, this machine meets its devices in the hub's rooms
    // and its events travel in the hub's order (no relay, no mailbox).
    ...(hubUrl ? {
      hubMode: true,
      createClient: (pairing: MobilePairingPackage) => hubRoom(hubUrl, pairing.rendezvousId),
      createPeerClient: (room: { rendezvousId: string }) => hubRoom(hubUrl, room.rendezvousId)
    } : {}),
    deviceId: identity.originId,
    machineName: args.machineName,
    appVersion: platform.appVersion(),
    eventStorage: storageService,
    eventLog: chatEventLogService,
    publicKeyDerBase64: identity.publicKeyDerBase64,
    outboxPath: path.join(userDataPath(), "machine-outbox.json"),
    nativeProcessDbPath: path.join(userDataPath(), NATIVE_PROCESS_REGISTRY_FILE),
    // A stop another deployment has made final holds this one's queued
    // commands in the durable inbox instead of failing them as turns.
    hostStopCommitted: () => {
      try { return !presence || presence.stopIntent()?.phase === "committed"; }
      catch { return true; }
    },
    detectProviders: () => cliAgentRunner.detectAgents(),
    onNativeActivitySettled: () => idlePower?.noteActivity() ?? Promise.resolve(),
    idleStopWarning: () => presenceWarning || idlePower?.warning(),
    autoStopEnabled: () => autoStopEnabled,
    onSettingsImported: async () => {
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
      void hostRef?.publishPowerStatus().catch(() => undefined);
    },
    onDesktopMachineId: (machineId) => {
      chatService.setHostMachineId(machineId);
    },
    // These two reach `scriptService`, built below: the desktop's greeting and
    // its requests arrive only after host.start(), further down.
    onDesktopMachineName: (name) => {
      scriptService.setHostName(name, machineScriptHostPhrase(name));
      if (name !== storedMachineLabel) {
        storedMachineLabel = name;
        void writeFile(machineLabelPath, JSON.stringify({ name }), "utf8").catch(() => undefined);
      }
    },
    moveTransport: async (addresses) => { await moveEnrollment(args.enrollmentPath, addresses); },
    restartRuntime: () => restartRuntime(stopRuntime),
    scripts: {
      handle: (operation) => handleScriptsOperation(scriptService, operation),
      keepsHostAwake: () => scriptService.keepsHostAwake(),
      scheduledCount: () => scriptService.scheduledCount(),
      runningNow: () => scriptService.isRunningNow()
    },
    // Chats reach this machine as change events from the desktop.
    applyChatChanges: (event, payload) => chatService.applyRemoteChatChanges(event, payload)
  });
  hostRef = host;
  // This machine's own changes (its members' replies, messages typed into it
  // while the desktop is away) go to the desktop and the other machines the
  // same way.
  chatService.setChatChangeTransport(createChatChangeTransport({
    role: "machine",
    storage: storageService,
    log: chatEventLogService,
    recipients: () => host.chatChangeRecipients(),
    onCommitted: () => host.nudgeEventChannel(),
    hostMachineId: () => host.enrolledMachineId(),
    desktopOriginId: () => enrollment.issuer.originId,
    machineOriginId: (machineId) => host.machineOriginId(machineId),
    alwaysEmit: () => Boolean(enrollment.hubUrl)
  }));
  const stopChatChangePruning = scheduleChatChangePruning({
    storage: storageService,
    originId: async () => (await chatEventLogService.getOrCreateDeviceIdentity()).originId,
    unpushedAfter: async () => enrollment.hubUrl ? hubPushedThrough(storageService) : undefined,
    log: (event, payload) => { void debugLogService.write(event, payload); }
  });
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
    debugLog: (event, payload) => {
      void debugLogService.write(event, payload);
    },
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
  // A member here asking other members goes through the desktop: it owns the
  // roster and runs each target where that member lives.
  chatService.setParticipantRequestDelegate({
    delegateParticipantRequest: (request) => host.delegateParticipantRequest(request)
  });
  // A member here compacting its own context goes through the desktop too,
  // when it is there, so the User sees and can stop it as one they started.
  chatService.setCompactionDelegate({
    canDelegateCompaction: () => host.canDelegateCompaction(),
    delegateCompaction: (request) => host.delegateCompaction(request)
  });
  // And a picture the User attached is read from the desktop too: the chat's
  // text is replicated here, its attachment files are not.
  chatService.setMachineLink({
    runTurn: async () => { throw new Error("A machine does not dispatch turns to another machine."); },
    fetchAttachment: (conversationId, attachmentId) => host.requestAttachment(conversationId, attachmentId)
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
      log: (event, payload) => { void debugLogService.write(event, payload); } });
    await idlePower.start();
  }
  await host.start();
  const hubClient = enrollment.hubUrl
    ? new HubClient({ url: enrollment.hubUrl, identity: () => chatEventLogService.getOrCreateDeviceIdentity(), storage: storageService })
    : undefined;
  if (hubClient) {
    // A picture the User sent from her phone is read from her server.
    chatService.setHubBlobReader((reference) => hubClient.downloadBytes(reference));
  }
  // A message the User wrote on her phone starts the members that live here.
  const isUsersPhone = (originId: string): boolean | Promise<boolean> => host.isPhone(originId);
  chatService.setPhoneOrigins(isUsersPhone, await phoneTurnsSince(storageService.hub(), PULLED_KEY, Date.now(), PHONE_TURN_RESUME_WINDOW_MS)
    .catch(() => new Date().toISOString()));
  // Phone messages taken in but never started here (a restart between the
  // two, or an older runtime took them in) start once the roster is known.
  let phoneTurnsStopped = false;
  const resumePhoneTurns = (): void => {
    if (phoneTurnsStopped) return;
    void chatService.resumePhoneTurns(new Date(Date.now() - PHONE_TURN_RESUME_WINDOW_MS).toISOString()).catch((error) => {
      void debugLogService.write("chat.phone-turns.resume-error", { message: error instanceof Error ? error.message : String(error) });
    });
  };
  const phoneTurnsFirst = setTimeout(resumePhoneTurns, 30_000);
  const phoneTurnsEvery = setInterval(resumePhoneTurns, PHONE_TURN_RESUME_EVERY_MS);
  phoneTurnsFirst.unref?.();
  phoneTurnsEvery.unref?.();
  const hubSync = hubClient ? new HubSync({
    client: hubClient,
    storage: storageService,
    localOriginId: async () => (await chatEventLogService.getOrCreateDeviceIdentity()).originId,
    trustedKey: async (originId) => host.trustedKey(originId),
    // A phone paired while the desktop was away proves itself here.
    admit: (event) => host.admitPhoneCertificate(event),
    deliver: (event) => host.receiveFromHub(event),
    applyChatChange: hubChatChangeApplier(storageService, chatService),
    onPushed: (eventIds) => storageService.hub().acknowledgeOutbox(eventIds, new Date().toISOString()),
    scopePrefixes: HUB_SCOPE_PREFIXES,
    log: (event, payload) => { void debugLogService.write(event, payload); }
  }) : undefined;
  if (hubSync) {
    chatEventLogService.onLocalAppend(() => hubSync.nudgePush());
    hubSync.start();
  }
  void scriptService.start().catch((error) => debugLogService.write("scripts.start.error", { message: String(error) }));
  // Repair artifact actions written by runtimes whose event writer was absent.
  // The ids are immutable, so a restart cannot create another version or signature.
  void (async () => {
    for (const conversation of await storageService.listConversations()) {
      if (conversation.kind === "chat") await artifactService.recoverActionEvents(conversation.id);
    }
    await artifactService.flushPendingArtifactEvents();
  })().catch(error => debugLogService.write("artifact.action.recover-failed", { message: String(error) }));
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
  console.log(`AccordAgents machine ${identity.originId} connected to ${enrollment.hubUrl ?? enrollment.relayUrl} (user data: ${userDataPath()})`);

  // One stop, whoever asks for it (a move's restart, the service manager's
  // SIGTERM): a second request waits for the first instead of running the
  // shutdown again. A stop that failed may be asked for again.
  let stopping: Promise<void> | undefined;
  const stopOnce = async (): Promise<void> => {
    // Nothing new is claimed while the runtime stops (it could not run it).
    phoneTurnsStopped = true;
    clearTimeout(phoneTurnsFirst);
    clearInterval(phoneTurnsEvery);
    presenceClosed = true;
    stopChatChangePruning();
    if (presenceTimer) clearInterval(presenceTimer);
    await presenceRefresh;
    try { presence?.publish(true); } catch (error) {
      void debugLogService.write("machine.host-power.shutdown-claim-failed", { message: String(error) });
    }
    await scriptService.stop();
    // The channels close with the host: nothing is read into them any more,
    // so nothing read now is lost; it is read again on the next start.
    hubSync?.pausePulls();
    await host.shutdown(() => cliAgentRunner.shutdownWarmAgents());
    if (hubSync) {
      // What the shutdown itself wrote (interrupted turns) goes up before the
      // link closes; an unreachable hub gets it on the next start instead.
      hubSync.nudgePush();
      await Promise.race([hubSync.idle(), new Promise((resolve) => setTimeout(resolve, 5_000).unref())]);
      hubSync.stop();
    }
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
  stopRuntime = () => {
    stopping ??= stopOnce().catch((error: unknown) => {
      stopping = undefined;
      throw error;
    });
    return stopping;
  };
  return stopRuntime;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  (args.maintenanceCommand ? runMachineMaintenance(args).then(() => undefined) :
    args.deviceIdentity ? printDeviceIdentity(args).then(() => undefined) :
    args.importChatCopy ? runChatCopyImport(args).then(() => undefined) :
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

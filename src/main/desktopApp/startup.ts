import path from "node:path";
import { app, BrowserWindow, dialog, powerMonitor, protocol } from "electron";
import { createBackgroundTray } from "../backgroundTray";
import { HubTunnelClient } from "../services/hubTunnelClient";
import { MachineLinkService } from "../services/machineLink";
import { machinePowerNeedsDelivery } from "../services/machineInstaller";
import { MACHINE_POWER_MAX_ATTEMPTS, MACHINE_POWER_RETRY_MS } from "../../shared/machineInstall";
import type { MobilePairingPackage } from "../../shared/mobilePairing";
import { openServerUpdateLoader, updateServerBeforeOpening } from "../services/serverUpdateLoader";
import {
  ACTIVITY_RECHECK_MS, appHiddenForUpdate, bootstrapAppUpdater, createUpdateRestart, createUpdateRestartGate,
  currentUpdateWindows, quitAndInstallUpdate, showUpdateRestartPrompt, updatePromptWindowShown
} from "../services/appUpdater";
import { MachineAutoUpgradeService } from "../services/machineAutoUpgrade";
import { machineUpgradeTarget } from "../services/machineUpgradeTarget";
import { MachineRecoveryService } from "../services/machineRecovery";
import { MachineInactivityCheck } from "../services/machineInactivity";
import { ensureLoginShellEnvPrimed } from "../services/command";
import { FILE_PREVIEW_PROTOCOL } from "../../shared/filePreview";
import { BundledSqliteInstallationError, DAMAGED_SQLITE_INSTALLATION_MESSAGE, validateSqliteExecutable } from "../services/sqliteCli";
import { detectAgentsWithAppSkills } from "./agentDetection";
import { showMainWindow } from "./appEvents";
import { flushRendererFileEdits } from "./coreServices";
import {
  HUB_PROGRAM_UPDATE_RETRY_MS, claimServerUpdateBeforeOpening, hubProgramUpdateDue, scheduleHubProgramUpdate, startHubLink
} from "./hubLink";
import { hubFeedReads, publishHubRoster } from "./hubRoster";
import { registerIpc } from "./ipc/registerIpc";
import { inspectCloudMachine, machineListResult } from "./machineRequests";
import { removeRelayEra } from "./machines";
import { broadcastScripts } from "./scheduledScripts";
import { startServerChatLinkOnce } from "./serverChat";
import { installMediaPermissionGate } from "./speech";
import { USAGE_SNAPSHOT_CHECK_MS } from "./usageSignals";
import { sendToMainWindow } from "./windowState";
import { createWindow, updatePromptWindow } from "./windows";
import { MAIN_DIRECTORY } from "../mainDirectory";
import type { DesktopApp } from "./desktopApp";

/** Starts everything once Electron is ready, then opens the window. */
export function startWhenReady(desktopApp: DesktopApp): void {
  void app.whenReady().then(async () => {
    await validateSqliteExecutable({ executable: desktopApp.sqliteExecutable });
    const { usageMilestones } = desktopApp;
    void usageMilestones?.start().catch((error: unknown) => {
      void desktopApp.debugLogService.write("usage.start-failed", { message: error instanceof Error ? error.message : String(error) });
    });
    if (usageMilestones) {
      // An app left open across a week boundary still sends that week's numbers.
      setInterval(() => void usageMilestones.sendWeeklySnapshotIfDue(), USAGE_SNAPSHOT_CHECK_MS).unref();
    }
    protocol.handle(FILE_PREVIEW_PROTOCOL, (request) => desktopApp.filePreviewService.handleProtocolRequest(request));
    registerIpc(desktopApp);
    installMediaPermissionGate(desktopApp);
    // Loaded now, so the microphone check above answers from the saved choice.
    void desktopApp.speechToTextService.getState().catch(() => undefined);
    let betaUpdates = false;
    try {
      betaUpdates = await desktopApp.settingsService.getBetaUpdatesEnabled();
    } catch (error) {
      void desktopApp.debugLogService.write("app-updater-settings-read-error", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
    // A downloaded update is applied only when no member is working anywhere:
    // restarting kills the local members' CLI processes, and the new desktop
    // then upgrades every machine's runtime, which kills the members there.
    const updateRestartGate = createUpdateRestartGate({
      isBusy: async () => desktopApp.chatService.liveRunIds().length > 0
        || desktopApp.machineInstallerService.hasActiveOperations()
        || (await desktopApp.machineLinkService?.anyMachineBusy().catch(() => true)) === true,
      onActivitySettled: (listener) => {
        const offRun = desktopApp.chatService.onParticipantRunSettled(() => listener());
        const offHello = desktopApp.machineLinkService?.onHello(() => listener());
        return () => { offRun(); offHello?.(); };
      },
      // The question is asked on a window; one waiting for a window is asked as
      // soon as the User brings one up.
      onWindowAvailable: (listener) => {
        const onFocus = (): void => listener();
        app.on("browser-window-focus", onFocus);
        return () => { app.removeListener("browser-window-focus", onFocus); };
      },
      canPrompt: () => updatePromptWindowShown(updatePromptWindow(desktopApp)),
      prompt: (info) => showUpdateRestartPrompt(info, updatePromptWindow(desktopApp), () => desktopApp.quitConfirmation.holding()),
      // A command running in the terminal does not hold the update back; the
      // User's Restart asks about it the way her own quit does.
      confirmRestart: async () => {
        const commands = await desktopApp.terminalService.runningCommands();
        if (commands !== undefined && commands.length === 0) return true;
        desktopApp.debugLogService.writeNow("app-update-confirm-asked", { commands: commands ?? null });
        const question = desktopApp.askToQuitOverRunningCommands(commands, "restart");
        const restart = await question.answer.catch((error: unknown) => {
          // A question that cannot be asked does not hold the User's Restart.
          desktopApp.debugLogService.writeNow("app-update-confirm-error", { error: error instanceof Error ? error.message : String(error) });
          return true;
        });
        desktopApp.debugLogService.writeNow("app-update-confirm-answered", { restart: restart ?? null, quitAsked: question.quitAsked });
        // She also quit while asked: her Quit goes on as a quit, the way a quit
        // while the update prompt is open does, and the update installs as the
        // app quits. Restarting as well would race that quit.
        if (restart && question.quitAsked) return false;
        return restart;
      },
      quitAndInstall: (() => {
        const restart = createUpdateRestart({
          quitAndInstall: () => {
            desktopApp.updateRestartRequested = true;
            // Asked already (Restart asks about the terminal's commands): the
            // update's own quit, which on Windows does not mark itself as one,
            // must not ask again.
            desktopApp.quitConfirmation.allow();
            quitAndInstallUpdate();
          },
          windows: currentUpdateWindows,
          appHidden: appHiddenForUpdate,
          log: (event, payload) => { desktopApp.debugLogService.writeNow(event, payload); }
        });
        // A restart for an update skips the normal quit cleanup, so the file
        // panel saves here, before the windows close.
        return () => { void flushRendererFileEdits(desktopApp).finally(restart); };
      })(),
      log: (event, payload) => { void desktopApp.debugLogService.write(event, payload); }
    });
    bootstrapAppUpdater(desktopApp.debugLogService, betaUpdates, updateRestartGate);
    // The first start after this desktop updated, while the User's server still
    // runs the older program: the server is updated before the app opens (the
    // User, 2026-10-29), and until then only a loader is shown and no member
    // starts — the link to the server, through which every turn comes, waits.
    // Once per version of this desktop: a server that stays away, or an update
    // that keeps failing, does not hold every later start; the regular update
    // tries again while the app is open.
    const serverUpdate = await hubProgramUpdateDue(desktopApp).then(async (due) => due && await claimServerUpdateBeforeOpening(due.to) ? due : undefined)
      .catch(() => undefined);
    const serverUpdateLoader = serverUpdate ? openServerUpdateLoader(path.join(MAIN_DIRECTORY, "../../renderer/assets")) : undefined;
    if (serverUpdate) {
      desktopApp.hubProgramUpdatingBeforeOpening = true;
      desktopApp.serverUpdateLoaderOpen = true;
    }
    await desktopApp.appMcpService.start();
    await desktopApp.storageService.init();
    // A scheduled script wakes members by writing into a chat: with the server
    // being updated first, it starts once the chats go through the server.
    const startScripts = (): void => {
      void desktopApp.scriptService.start().catch((error) => {
        void desktopApp.debugLogService.write("scripts.start.error", { message: error instanceof Error ? error.message : String(error) });
      });
    };
    if (!serverUpdate) startScripts();
    // A laptop that slept through a due time runs it (or records it missed) on wake.
    powerMonitor.on("resume", () => {
      void desktopApp.scriptService.tick();
    });
    // Before any machine connects: what the shared relay set up goes first.
    await removeRelayEra(desktopApp).catch((error: unknown) => {
      void desktopApp.debugLogService.write("relay.remove-error", { message: error instanceof Error ? error.message : String(error) });
    });
    try {
      const desktopIdentity = await desktopApp.deviceIdentityService.getOrCreateDeviceIdentity();
      desktopApp.machineLinkService = new MachineLinkService(desktopApp.settingsService, desktopApp.debugLogService, {
        // A machine's key changed: the User's server is told who may use it.
        onDevicesChanged: () => publishHubRoster(desktopApp),
        createClient: (pairing: MobilePairingPackage) => pairing.hubUrl ? new HubTunnelClient({
          hubUrl: pairing.hubUrl, rendezvousId: pairing.rendezvousId, role: "desktop",
          identity: () => desktopApp.deviceIdentityService.getOrCreateDeviceIdentity(),
          // The same server the link proved; a room elsewhere is not opened.
          verify: async () => {
            const client = desktopApp.hubClient;
            if (!client || client.hubUrl !== (pairing.hubUrl ?? "").replace(/\/+$/, "")) throw new Error("This room is not on the server this computer is linked to.");
            await client.health();
          }
        }) : undefined,
        appVersion: app.getVersion(),
        desktopDeviceId: desktopIdentity.originId,
        deviceIdentity: desktopApp.deviceIdentityService,
        // A member on a machine reads a picture attached here from here (one
        // the phone sent it reads from the server).
        readChatAttachment: (request) => desktopApp.chatService.readChatAttachment(request),
        // Each machine's settings go to the User's server, sealed for it alone.
        publishSettings: async (machineId, sealed) => {
          const client = desktopApp.hubClient;
          if (!client) throw new Error("This computer is not linked to your server.");
          await client.putMachineSettings({ machineId, sealed });
        },
        // Where this desktop's projects were copied on each machine.
        machineProjects: async (machineId) => (await desktopApp.settingsService.listMachineInstalls()).find((record) => record.machineId === machineId)?.projects ?? {}
      });
      const machineLink = desktopApp.machineLinkService;
      // A turn of a member on a machine is asked once the machine has the
      // chat's project and its settings say where (Д4: the machine runs it).
      desktopApp.chatService.setRemoteTurnPreparation({
        beforeRemoteTurn: () => machineLink.syncSettings(),
        machineProjectReady: async (machineId, repoPath) => {
          const install = (await desktopApp.settingsService.listMachineInstalls()).find((record) => record.machineId === machineId);
          // A machine set up by hand keeps its own folders.
          return !install || Boolean(install.projects?.[repoPath]);
        }
      });
      desktopApp.chatService.setMachineWaitReason((machineId) => machineLink.turnWaitReason(machineId));
      desktopApp.chatService.setMachineMemberRestartSupport((machineId) => machineLink.memberRestartSupport(machineId));
      desktopApp.chatService.setMachineSessionMove((target) => machineLink.sessionMoveTarget(target));
      desktopApp.chatService.setMachineForkToNewChatSupport((machineId) => machineLink.forkToNewChatSupport(machineId));
      desktopApp.chatService.setMachineCliModesSupport((machineId) => machineLink.cliModesSupport(machineId));
      desktopApp.chatService.setMachineCliStartDefaults((machineId) => machineLink.cliStartDefaults(machineId));
      // The machines are read before the link to the server starts, so their
      // keys are on the server's roster before anything is written for them;
      // a passing failure to read is tried again first.
      for (let attempt = 1; ; attempt += 1) {
        try {
          await desktopApp.machineLinkService.loadMachines();
          break;
        } catch (error) {
          void desktopApp.debugLogService.write("machine-link.load-error", { attempt, message: error instanceof Error ? error.message : String(error) });
          if (attempt >= 3) break;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
      // Every chat is the server's (Д1): saves go there, its feed comes back.
      // A server about to be updated is linked once its program is replaced.
      if (!serverUpdate) await startServerChatLinkOnce(desktopApp);
      await startHubLink(desktopApp).catch((error: unknown) => {
        void desktopApp.debugLogService.write("hub.link.start-error", { message: error instanceof Error ? error.message : String(error) });
      });
      // A saved setting (an environment value, a role, a rule, a prompt, a
      // member preset) reaches the machines at once, not only on their next
      // connection. Bursts of writes are sent once.
      let machineSettingsSync: ReturnType<typeof setTimeout> | undefined;
      desktopApp.settingsService.onStoredChange(() => {
        desktopApp.hubPhonePublisher.scheduleCatalog();
        desktopApp.hubMemberRulesPublisher.publish(2_000);
        if (machineSettingsSync) clearTimeout(machineSettingsSync);
        machineSettingsSync = setTimeout(() => {
          machineSettingsSync = undefined;
          void desktopApp.machineLinkService?.syncSettings().catch((error) => {
            void desktopApp.debugLogService.write("machine-link.settings.sync-error", { message: error instanceof Error ? error.message : String(error) });
          });
        }, 500);
        machineSettingsSync.unref?.();
      });
      desktopApp.machineLinkService.onStatus(() => {
        void machineListResult(desktopApp).then((result) => sendToMainWindow(desktopApp, "machines:updated", result));
      });
      // A machine coming or going changes which scripts Settings can reach, and
      // a machine says when its own scripts changed.
      let scriptHostsKey = "";
      desktopApp.machineLinkService.onStatus(() => {
        const key = JSON.stringify(desktopApp.machineLinkService?.scriptHosts() ?? []);
        if (key === scriptHostsKey) return;
        scriptHostsKey = key;
        broadcastScripts(desktopApp);
      });
      desktopApp.machineLinkService.onScriptsChanged((machineId) => broadcastScripts(desktopApp, [machineId]));
      // A restarted runtime greets again with a new instance; until then its
      // requests are refused, so it is asked again once it has.
      desktopApp.machineLinkService.onHello((event) => broadcastScripts(desktopApp, [event.machineId]));
      desktopApp.machineLinkService.onHello(() => desktopApp.usageMilestones?.reach("first_cloud_machine"));
      // A machine's program said what it runs (an update, a first hello): the
      // server is told, unless nothing changed (an unchanged set is not sent).
      let machinePrograms = "";
      desktopApp.machineLinkService.onHello(() => {
        const said = JSON.stringify(desktopApp.machineLinkService?.cliModesByMachine() ?? {});
        if (said === machinePrograms) return;
        machinePrograms = said;
        desktopApp.hubMemberRulesPublisher.publish(500);
      });
      desktopApp.machineLinkService.onMemberBackgroundTasks((event) => {
        if (event.member) {
          desktopApp.chatService.applyMachineBackgroundTasks(event.machineId, event.member);
        } else if (event.snapshot) {
          desktopApp.chatService.replaceMachineBackgroundTasks(event.machineId, event.snapshot);
        }
      });
      desktopApp.machineLinkService.onPromptSuggestion((event) => desktopApp.chatService.receiveMemberPromptSuggestion({
        conversationId: event.conversationId,
        participantId: event.participantId,
        runId: event.runId,
        text: event.suggestion
      }, event.machineId));
      // A machine member's live progress, for this window only: the machine
      // posts it to the server itself for the phone.
      desktopApp.machineLinkService.onProgress((progress) => sendToMainWindow(desktopApp, "conversations:review-progress", progress));
      desktopApp.machineLinkService.setConversationLoader((conversationId) => desktopApp.storageService.getConversation(conversationId));
      // Machines update together with the desktop: a machine whose runtime is
      // older than this desktop is upgraded as soon as it is connected and idle.
      const link = desktopApp.machineLinkService;
      const autoUpgrade = new MachineAutoUpgradeService({
        desktopVersion: app.getVersion(),
        listInstalls: () => desktopApp.settingsService.listMachineInstalls(),
        machineName: async (machineId) => (await desktopApp.settingsService.listMachines()).find((machine) => machine.id === machineId)?.name,
        machineActivity: (machineId) => link.machineActivity(machineId),
        resolveTarget: (record) => machineUpgradeTarget(record, {
          machineInstanceId: async (machineId) => (await desktopApp.settingsService.listMachines()).find((item) => item.id === machineId)?.awsInstanceId,
          configuredInstanceId: async () => (await desktopApp.settingsService.getPublicSettings()).cloudRuns.awsHandle?.instanceId,
          ensureExistingWorker: (instanceId, options) => desktopApp.cloudRunAwsService.ensureExistingWorkerForRun(instanceId, options),
          inspect: () => desktopApp.cloudRunAwsService.workerForInspection(),
          log: (event, payload) => { void desktopApp.debugLogService.write(event, payload); }
        }),
        payloadReady: () => {
          const payload = desktopApp.machineInstallerService.readPayload();
          return payload.ok ? { ok: true } : { ok: false, message: payload.message };
        },
        upgrade: (request, onProgress) => desktopApp.machineInstallerService.upgrade(request, onProgress),
        powerDue: async (record) => {
          const power = await desktopApp.cloudRunAwsService.machinePowerFor(record.machineId);
          return power && machinePowerNeedsDelivery(record, power) ? power.credentials.accessKeyId : undefined;
        },
        // A minute past the record's own retry window, so the key is due again.
        powerRetryMs: MACHINE_POWER_RETRY_MS + 60_000,
        powerMaxAttempts: MACHINE_POWER_MAX_ATTEMPTS,
        // Her server updates itself after this desktop does: a machine waits for it.
        serverVersion: async () => {
          const client = desktopApp.hubOwnerConfirmed ? desktopApp.hubClient : undefined;
          return client ? (await client.health()).version : undefined;
        },
        holdTurns: (machineId, reason) => link.holdTurns(machineId, reason),
        onProgress: (snapshot) => sendToMainWindow(desktopApp, "machines:install-progress", snapshot),
        onChanged: async () => { sendToMainWindow(desktopApp, "machines:updated", await machineListResult(desktopApp)); },
        logger: (event, payload) => { void desktopApp.debugLogService.write(event, payload); }
      });
      // A hello the desktop itself asked for (machineActivity) is not announced
      // here, so evaluating on every hello cannot feed itself.
      link.onHello((event) => { void autoUpgrade.evaluate(event.machineId); });
      desktopApp.evaluateMachineUpdates = () => { void autoUpgrade.evaluate(); };
      desktopApp.machineRecovery = new MachineRecoveryService({
        now: () => Date.now(),
        linkStartedAt: () => desktopApp.machineLinkStartedAt,
        // Where the machine is met says whether it is there: its room on the
        // relay, or on the User's server for a machine that talks only to it.
        linkState: (machineId) => link.presenceState(machineId),
        machineOnInstance: () => desktopApp.cloudRunAwsService.autoStopMachineRecord(),
        instanceRunningSince: () => desktopApp.cloudRunAwsService.instanceRunningSince(),
        setupRunning: (machineId) => Boolean(desktopApp.machineInstallerService.activeOperation(machineId)),
        inspect: (record) => inspectCloudMachine(desktopApp, record),
        reinstall: async (machineId) => {
          // A turn sent meanwhile waits for the new program instead of
          // reaching one that is about to be stopped.
          const release = link.holdTurns(machineId, "The cloud machine's program is being set up again.");
          try {
            await desktopApp.cloudRunPreparation.prepareRuntime({ agentsChecked: true, machineId, automatic: true });
          } finally {
            release();
          }
          void autoUpgrade.evaluate();
          void machineListResult(desktopApp).then((result) => sendToMainWindow(desktopApp, "machines:updated", result)).catch(() => undefined);
        },
        log: (event, payload) => { void desktopApp.debugLogService.write(event, payload); }
      });
      const recoveryTimer = setInterval(() => { void desktopApp.machineRecovery?.check(); }, 60_000);
      recoveryTimer.unref?.();
      desktopApp.retryMachineUpdate = (machineId) => autoUpgrade.retry(machineId);
      desktopApp.chatService.onParticipantRunSettled(() => { if (autoUpgrade.hasWaiting()) void autoUpgrade.evaluate(); });
      // A turn started from the phone ends on the machine without an event this
      // desktop subscribes to; while a machine waits for idle, ask again.
      const autoUpgradeTimer = setInterval(() => { if (autoUpgrade.hasWaiting()) void autoUpgrade.evaluate(); }, ACTIVITY_RECHECK_MS);
      autoUpgradeTimer.unref?.();
      desktopApp.machineLinkStartedAt = Date.now();
      // An instance that was terminated while this desktop was closed leaves
      // no machine behind and no pile of chat changes kept for it. Looked at
      // once the link has its machines, so a removal is not undone by start.
      const forgetGoneInstance = (): void => {
        void desktopApp.cloudRunAwsService.forgetInstanceIfGone().catch((error: unknown) => {
          void desktopApp.debugLogService.write("aws-worker.gone-check.error", { message: error instanceof Error ? error.message : String(error) });
        });
      };
      void desktopApp.machineLinkService.start().then(() => {
        desktopApp.markMachineLinkReady();
        forgetGoneInstance();
        return autoUpgrade.evaluate();
      }).catch((error) => {
        desktopApp.markMachineLinkReady();
        forgetGoneInstance();
        void desktopApp.debugLogService.write("machine-link.start.error", { message: error instanceof Error ? error.message : String(error) });
      });
      // While a machine stays away, the User's server keeps everything it has
      // not read. Once every 10 days the User is asked about machines inactive
      // that long, in the window's notice stack; the answers come back over IPC.
      new MachineInactivityCheck({
        listMachines: () => desktopApp.settingsService.listMachines(),
        isConnected: (machineId) => link.isMachineConnected(machineId),
        // Its last read of the server's feed counts as activity too (it may
        // work for the phone while this desktop is closed).
        lastActiveAt: async (machine) => machine.deviceId ? (await hubFeedReads(desktopApp))?.get(machine.deviceId) : undefined,
        lastCheckAt: () => desktopApp.settingsService.getMachineInactivityCheckAt(),
        saveLastCheckAt: (at) => desktopApp.settingsService.saveMachineInactivityCheckAt(at),
        ask: (machine) => desktopApp.machineInactivityQuestions.ask({ machineId: machine.id, name: machine.name, inactiveDays: machine.inactiveDays }),
        log: (event, payload) => { void desktopApp.debugLogService.write(event, payload); }
      }).start();
      link.onHello((event) => desktopApp.machineInactivityQuestions.settle(event.machineId, "active"));
    } catch (error) {
      void desktopApp.debugLogService.write("machine-link.init.error", { message: error instanceof Error ? error.message : String(error) });
      desktopApp.markMachineLinkReady();
    }
    if (serverUpdate && serverUpdateLoader) {
      const offProgress = desktopApp.hubInstaller.onProgress((state) => {
        if (state.status === "installing" && state.message) serverUpdateLoader.status(state.message);
      });
      try {
        let installing: Promise<{ status: string; message?: string }> | undefined;
        const outcome = await updateServerBeforeOpening({
          ownerConfirmed: () => desktopApp.hubOwnerConfirmed,
          install: () => {
            desktopApp.hubProgramUpdateTries.set(serverUpdate.to, (desktopApp.hubProgramUpdateTries.get(serverUpdate.to) ?? 0) + 1);
            installing = desktopApp.hubInstaller.install({});
            return installing;
          },
          loader: serverUpdateLoader,
          log: (event, payload) => { void desktopApp.debugLogService.write(event, payload); },
          from: serverUpdate.from,
          to: serverUpdate.to
        });
        if (outcome === "timed-out" && installing) {
          // It goes on behind the open app; the scheduled update waits for it.
          void installing.finally(() => { desktopApp.hubProgramUpdatingBeforeOpening = false; }).catch(() => undefined);
        } else {
          desktopApp.hubProgramUpdatingBeforeOpening = false;
        }
        if (outcome === "failed") scheduleHubProgramUpdate(desktopApp, HUB_PROGRAM_UPDATE_RETRY_MS, { replace: true });
      } catch (error) {
        desktopApp.hubProgramUpdatingBeforeOpening = false;
        void desktopApp.debugLogService.write("hub.program-update.error", { message: error instanceof Error ? error.message : String(error), beforeOpening: true });
      } finally {
        offProgress();
      }
      // Updated or not, the chats go through the server from here (an update
      // that linked the server again has started the link already), and what
      // writes into chats starts after it: below, and the scripts.
      await startServerChatLinkOnce(desktopApp);
      startScripts();
    }
    // A document's chat note this computer wrote before documents moved to the
    // server and never got into the chat goes in now (later notes come with the
    // server's feed).
    await desktopApp.artifactService.flushPendingArtifactEvents().catch((error) => {
      void desktopApp.debugLogService.write("artifacts.outbox.startup-error", {
        message: error instanceof Error ? error.message : String(error)
      });
    });
    await desktopApp.chatService.reconcileConversationDeletions().catch((error) => {
      void desktopApp.debugLogService.write("chat.delete.reconcile-error", { message: error instanceof Error ? error.message : String(error) });
    });
    await desktopApp.chatService.reconcileDeletedConversationArtifacts().catch((error) => {
      void desktopApp.debugLogService.write("chat.delete.artifacts.reconcile-error", {
        message: error instanceof Error ? error.message : String(error)
      });
    });
    // A member removal the User approved before the app quit, still waiting for
    // a turn to end (nothing runs after a restart, so it is applied now), and a
    // machine member's addition not applied yet.
    void desktopApp.chatService.resumeQueuedRosterChanges().catch((error) => {
      void desktopApp.debugLogService.write("chat.member-removal.resume-error", {
        message: error instanceof Error ? error.message : String(error)
      });
    });
    createWindow(desktopApp);
    desktopApp.appWindowOpened = true;
    desktopApp.serverUpdateLoaderOpen = false;
    serverUpdateLoader?.close();
    if (process.platform === "win32") {
      desktopApp.backgroundTray = await createBackgroundTray(() => showMainWindow(desktopApp)).catch((error: unknown) => {
        // Without the icon, closing the window quits, as it did before.
        void desktopApp.debugLogService.write("app-tray.create-error", { message: error instanceof Error ? error.message : String(error) });
        return undefined;
      });
    }
    // The first reading also brings the automatic variables in step.
    void ensureLoginShellEnvPrimed();
    await detectAgentsWithAppSkills(desktopApp).catch((error) => {
      void desktopApp.debugLogService.write("app-skills-startup-sync-error", {
        error: error instanceof Error ? error.message : String(error)
      });
    });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow(desktopApp);
      }
    });
  }).catch((error) => {
    const damagedSqlite = error instanceof BundledSqliteInstallationError;
    const message = damagedSqlite
      ? DAMAGED_SQLITE_INSTALLATION_MESSAGE
      : error instanceof Error ? error.message : String(error);
    console.error("Failed to start AccordAgents:", error);
    dialog.showErrorBox(damagedSqlite ? "AccordAgents installation is damaged" : "AccordAgents failed to start", message);
    app.quit();
  });
}

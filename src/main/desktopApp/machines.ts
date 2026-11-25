import path from "node:path";
import { randomUUID } from "node:crypto";
import { app } from "electron";
import { MachineLinkService } from "../services/machineLink";
import { removeRelayEraRecords } from "../services/relayRemoval";
import { MachineInactivityQuestions } from "../services/machineInactivityQuestions";
import type { CreateMachineRequest, CreateMachineResult, MachineListResult } from "../../shared/machineLink";
import type { MachineInstallRecord } from "../../shared/machineInstall";
import type { MachineRuntimePayloadLocation } from "../services/machineInstaller";
import type { CreateMobilePairingResult } from "../../shared/mobilePairing";
import { commandEnvironment } from "../services/command";
import { DefaultRemoteAgentSetupSync } from "../services/remoteAgentSetup";
import { publishHubRoster } from "./hubRoster";
import { MACHINE_ENROLLMENT_TTL_MINUTES, machineListResult } from "./machineRequests";
import { sendToMainWindow } from "./windowState";
import type { DesktopApp } from "./desktopApp";

/** What Settings says where a machine would start without the User's server. */
export const SET_UP_SERVER_FOR_MACHINES = "Set up your server first (Settings → Your server): cloud machines connect through it.";

export function createMachineServices(desktopApp: DesktopApp): void {
  /** Questions about machines that stopped being used, waiting for the User. */
  desktopApp.machineInactivityQuestions = new MachineInactivityQuestions((questions) => sendToMainWindow(desktopApp, "machines:inactivity-questions", questions));

  desktopApp.machineProfileSync = new DefaultRemoteAgentSetupSync();

  desktopApp.prepareMachineProfile = async (record: MachineInstallRecord): Promise<void> => {
    await desktopApp.machineProfileSync.sync({
      worker: { ...record.target, workerRoot: record.installRoot, profileHome: record.profileHome },
      sourceEnvironment: { ...commandEnvironment(), ...(await desktopApp.settingsService.getManualAgentEnvironment()).env }
    });
  };
}

// Machines transport: the ONLY SSH path to a machine. Installing, upgrading
// and the one-time project mirror; never a message, a turn or a Stop.
export function requireMachineLink(desktopApp: DesktopApp): MachineLinkService {
  if (!desktopApp.machineLinkService) {
    throw new Error("Machines are not ready yet; try again in a moment.");
  }
  return desktopApp.machineLinkService;
}

export function machineRuntimePayload(): MachineRuntimePayloadLocation {
  // A packaged app ships the Linux runtime beside its asar, in
  // Contents/Resources/machine: rsync has to read real files, and nothing
  // inside an asar has a real path. A checkout uses what `npm run build`
  // produced. The override exists for QA and for pointing a packaged app at a
  // specific build; it deliberately skips the version check.
  const override = process.env.ACCORDAGENTS_MACHINE_BUNDLE_DIR?.trim();
  if (override) {
    return { dir: override, source: "override" };
  }
  if (app.isPackaged) {
    return { dir: path.join(process.resourcesPath, "machine"), source: "packaged", expectVersion: app.getVersion() };
  }
  return { dir: path.join(app.getAppPath(), "dist", "machine"), source: "checkout", expectVersion: app.getVersion() };
}

/** Removes a machine from this desktop: Settings > Remove, and the answer
 *  "no longer in use" to the inactive-machine question. The cloud instance
 *  itself is not deleted. */
export async function removeMachine(desktopApp: DesktopApp, id: string): Promise<MachineListResult> {
  const record = (await desktopApp.settingsService.listMachines()).find((machine) => machine.id === id);
  await desktopApp.machineLinkService?.disconnectMachine(id);
  try {
    // Every device that was handed this machine's power key loses the handoff
    // with the machine; the key itself still needs rotating, and the outcome
    // is written to the debug log rather than lost.
    for (const outcome of await desktopApp.machinePowerHandoffService.revokeForMachine(id, "machine-removed")) {
      void desktopApp.debugLogService.write("machine.power.handoff.revoked", {
        handoffId: outcome.handoffId, keyRotationRequired: outcome.keyRotationRequired, detail: outcome.detail
      });
    }
    await desktopApp.settingsService.removeMachine(id);
    // However it was removed (Settings, AWS, the relay's cleanup), a question
    // about it is settled with it.
    desktopApp.machineInactivityQuestions.settle(id, "remove");
  } catch (error) {
    // Not removed: it stays a machine of this desktop, connected again, and
    // nothing kept for it is dropped.
    if (record) await desktopApp.machineLinkService?.connectMachine(record).catch(() => undefined);
    throw error;
  }
  await desktopApp.machineLinkService?.forgetMachine(id);
  // The User's server drops it from its roster: it reads and writes nothing more.
  publishHubRoster(desktopApp);
  const result = await machineListResult(desktopApp);
  sendToMainWindow(desktopApp, "machines:updated", result);
  return result;
}

/** What the shared relay set up is taken off this desktop (see
 *  relayRemoval.ts); the other machines' rosters follow. */
export async function removeRelayEra(desktopApp: DesktopApp): Promise<void> {
  const recorded = await removeRelayEraRecords({
    settings: desktopApp.settingsService,
    removeMachine: (machineId) => removeMachine(desktopApp, machineId).catch((error: unknown) => {
      void desktopApp.debugLogService.write("relay.remove-machine-error", { machineId, message: error instanceof Error ? error.message : String(error) });
      throw error;
    }),
    handoffs: desktopApp.machinePowerHandoffService,
    log: (event, payload) => { void desktopApp.debugLogService.write(event, payload); }
  });
  if (!recorded) return;
  void desktopApp.debugLogService.write("relay.removed", { machines: recorded.machines.length, phones: recorded.phones.length, startKeyHanded: recorded.startKeyHanded });
  publishHubRoster(desktopApp);
}

/** A machine's enrollment with the User's own server: its room there, nothing
 *  else (its chats it reads from the server like every device). */
function createHubMachinePairing(desktopApp: DesktopApp, hubUrl: string): Promise<CreateMobilePairingResult> {
  return desktopApp.mobilePairingService.createPairing({ purpose: "machine-host", ttlMinutes: MACHINE_ENROLLMENT_TTL_MINUTES, hubUrl });
}

export async function createMachine(desktopApp: DesktopApp, request: CreateMachineRequest, awsInstanceId?: string): Promise<CreateMachineResult> {
  const name = typeof request?.name === "string" ? request.name.trim() : "";
  if (!name) {
    throw new Error("A machine needs a name.");
  }
  // A machine talks only to the User's own server: it meets this desktop in
  // its room there and reads and writes its chats there. Without a server
  // there are no machines.
  const hub = await desktopApp.settingsService.getHubConfig();
  if (!hub) throw new Error(SET_UP_SERVER_FOR_MACHINES);
  const pairing = await createHubMachinePairing(desktopApp, hub.url);
  const record = {
    id: randomUUID(),
    name,
    ...(awsInstanceId ? { awsInstanceId } : {}),
    deviceId: "",
    pairingKey: pairing.package.rendezvousId,
    createdAt: new Date().toISOString()
  };
  await desktopApp.settingsService.saveMachine(record, pairing.package);
  await desktopApp.machineLinkService?.connectMachine(record).catch((error) => {
    void desktopApp.debugLogService.write("machine-link.connect.error", { machineId: record.id, message: error instanceof Error ? error.message : String(error) });
  });
  void machineListResult(desktopApp).then((result) => sendToMainWindow(desktopApp, "machines:updated", result));
  return { machine: record, enrollmentJson: JSON.stringify(pairing.package, null, 2) };
}

import { createHash } from "node:crypto";
import { machineSigningKey, type MachineSettingsDocument, type MachineSettingsSnapshot } from "../../../shared/machineLink";
import { deriveMachineChannelKey } from "../../../shared/machineChannelKey";
import { sealChannelPayload } from "../machineChannelSealing";
import { errorMessage, machineSettingsKey } from "./linkText";
import type { MachineConnection } from "./types";
import type { MachineLinkModules } from "./modules";
import type { MachineLinkDependencies } from "./dependencies";

/** Sends machines the settings they need. */
export class SettingsPublication {
  /** What each machine's settings on the User's server were last published
   *  from (a digest of what a machine uses, the key it is sealed for and the
   *  place it was put): the same is not put again. Kept in memory, so every
   *  start of this desktop publishes once. */
  readonly publishedSettings = new Map<string, string>();
  private settingsPublication: Promise<void> = Promise.resolve();

  constructor(
    private readonly link: Pick<MachineLinkModules, "machineConnections">,
    private readonly deps: Pick<MachineLinkDependencies, "debugLogs" | "options" | "settings">
  ) {}

  // --- settings on the User's server ---------------------------------------

  /** The User's server changed (another one, or the link came back): every
   *  machine's settings are put there again. */
  resetPublishedSettings(): void {
    this.publishedSettings.clear();
  }

  /**
   * Puts the current settings of every machine this desktop set up on the
   * User's server, sealed for that machine alone (called after a settings
   * save, when the server link starts, and when a machine greets). A machine
   * already given exactly these is not given them again. A machine whose key
   * is not known yet is given them once it is (adoptMachineIdentity, hello).
   */
  syncSettings(): Promise<void> {
    const run = this.settingsPublication.then(() => this.syncSettingsNow());
    this.settingsPublication = run.catch(() => undefined);
    return run;
  }

  private async syncSettingsNow(): Promise<void> {
    const publish = this.deps.options.publishSettings;
    if (!publish || this.link.machineConnections.closed) return;
    let snapshot: MachineSettingsSnapshot | undefined;
    const identity = await this.deps.options.deviceIdentity.getOrCreateDeviceIdentity();
    const failures: string[] = [];
    for (const record of await this.deps.settings.listMachines()) {
      const machineKey = machineSigningKey(this.link.machineConnections.machineRecord(record.id) ?? record);
      if (!machineKey) continue;
      const pairing = this.link.machineConnections.connections.get(record.id)?.pairing ?? await this.deps.settings.getMachinePairing(record.pairingKey);
      if (!pairing?.hubUrl || pairing.issuer.originId !== this.deps.options.desktopDeviceId) continue;
      try {
        snapshot ??= await this.deps.settings.exportMachineSettingsSnapshot();
        const projects = await this.deps.options.machineProjects?.(record.id) ?? {};
        const digest = createHash("sha256").update(JSON.stringify([machineSettingsKey(snapshot), projects, machineKey, pairing.hubUrl, pairing.rendezvousId])).digest("hex");
        if (this.publishedSettings.get(record.id) === digest) continue;
        const document: MachineSettingsDocument = { version: 1, settings: snapshot, projects };
        const sealed = await sealChannelPayload(document, deriveMachineChannelKey(identity, machineKey, pairing.rendezvousId));
        await publish(record.id, sealed);
        this.publishedSettings.set(record.id, digest);
        void this.deps.debugLogs.write("machine-link.settings.published", { machineId: record.id, bytes: sealed.length });
      } catch (error) {
        failures.push(`${record.name}: ${errorMessage(error)}`);
      }
    }
    if (failures.length) throw new Error(`Settings could not be published for ${failures.join("; ")}`);
  }

  // --- the room -------------------------------------------------------------

  /** Saves the machine's record (its greeting, its identity). */
  persistRecord(connection: MachineConnection, required = false): Promise<void> {
    const record = connection.record;
    const write = connection.persist
      .then(() => this.deps.settings.saveMachine(record))
      .then(() => undefined);
    connection.persist = write.catch((error: unknown) => {
      void this.deps.debugLogs.write("machine-link.record.save-error", { machineId: record.id, message: errorMessage(error) });
    });
    return required ? write : connection.persist;
  }
}

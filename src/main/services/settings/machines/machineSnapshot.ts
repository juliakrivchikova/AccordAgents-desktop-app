import { hostPlatform } from "../../../platform";
import type { MachineSettingsSnapshot } from "../../../../shared/machineLink";
import type { MobilePairingPackage } from "../../../../shared/mobilePairing";
import { assertAgentEnvironmentKeyAllowed } from "../../../../shared/agentEnvironment";
import type { StoredAgentEnvironmentVariable, StoredSettings } from "../types";
import type { SettingsModules } from "../modules";

/** The settings a machine is given when it is set up. */
export class MachineSnapshot {
  constructor(private readonly settings: Pick<SettingsModules, "agentEnvironment" | "secrets" | "settingsStore">) {}

  /** What a machine needs to run participants exactly like this desktop:
   *  roles, rules, saved prompts, participant presets, prompt-context and
   *  limit settings, and the manually configured agent environment values.
   *  Dedicated provider/AWS credentials and machine records are excluded;
   *  secrets explicitly configured in agent environment variables travel. */
  async exportMachineSettingsSnapshot(): Promise<MachineSettingsSnapshot> {
    const stored = await this.settings.settingsStore.readStored();
    const {
      providers: _providers,
      encryptedAwsCredentials: _aws,
      awsWorkerHandle: _handle,
      awsWorkerRegion: _region,
      awsWorkerOperation: _operation,
      awsWorkerProvisioningToken: _token,
      awsWorkerSpecAcceptance: _spec,
      awsWorkerVolumeExpansion: _volume,
      awsWorkerGoneNotice: _goneNotice,
      leavingMachines: _leavingMachines,
      cloudRuns: _cloudRuns,
      cloudRunsMode: _cloudRunsMode,
      cloudRunsDeviceId: _cloudRunsDeviceId,
      agentEnvironment: _agentEnvironment,
      machines: _machines,
      machineInstalls: _machineInstalls,
      encryptedMachinePairings: _pairings,
      encryptedMachinePower: _power,
      encryptedMachinePowerPrevious: _previousPower,
      machinePowerHandoffs: _powerHandoffs,
      trustedDevices: _trustedDevices,
      hubPhoneInvites: _hubPhoneInvites,
      machineDeviceRevocations: _machineDeviceRevocations,
      relayRemoval: _relayRemoval,
      relayRemovalPending: _relayRemovalPending,
      relayRemovalFailures: _relayRemovalFailures,
      machineInactivityCheckAt: _machineInactivityCheckAt,
      lastRepoPath: _lastRepoPath,
      ...shareable
    } = stored;
    // A partial export would remove the unreadable variable on the receiver.
    // Read the same snapshot and fail before publishing anything instead.
    const environment = this.settings.agentEnvironment.readManualAgentEnvironment(stored, true, true);
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      settingsJson: JSON.stringify(shareable),
      agentEnvironment: Object.entries(environment.env)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        .map(([key, value]) => ({ key, value }))
    };
  }

  /** Applies a desktop snapshot on a machine: shareable settings replace the
   *  machine's copy, environment values are stored with the machine's own
   *  secret store, and everything the machine owns (its records, providers)
   *  is kept. */
  async importMachineSettingsSnapshot(snapshot: MachineSettingsSnapshot): Promise<void> {
    if (!snapshot || snapshot.version !== 1 || typeof snapshot.settingsJson !== "string") {
      throw new Error("Machine settings snapshot is invalid.");
    }
    const incoming = JSON.parse(snapshot.settingsJson) as Partial<StoredSettings>;
    if (!incoming || typeof incoming !== "object" || Array.isArray(incoming) || !Array.isArray(snapshot.agentEnvironment)) {
      throw new Error("Machine settings snapshot is invalid.");
    }
    if (snapshot.agentEnvironment.length && !hostPlatform().secrets.isEncryptionAvailable()) {
      throw new Error("Machine environment requires the machine's secret store.");
    }
    const now = new Date().toISOString();
    const seen = new Set<string>();
    const variables = snapshot.agentEnvironment.map((entry): StoredAgentEnvironmentVariable => {
      if (!entry || typeof entry.value !== "string") throw new Error("Machine environment contains an invalid value.");
      const key = assertAgentEnvironmentKeyAllowed(entry.key);
      if (seen.has(key)) throw new Error("Machine environment contains a duplicate key.");
      seen.add(key);
      return { key, ...this.settings.secrets.encodeAgentEnvironmentValue(entry.value), enabled: true, updatedAt: now };
    });
    const stored = await this.settings.settingsStore.readStored();
    const next: StoredSettings = {
      ...stored,
      ...incoming,
      providers: stored.providers,
      encryptedAwsCredentials: stored.encryptedAwsCredentials,
      awsWorkerHandle: stored.awsWorkerHandle,
      awsWorkerRegion: stored.awsWorkerRegion,
      awsWorkerOperation: stored.awsWorkerOperation,
      awsWorkerProvisioningToken: stored.awsWorkerProvisioningToken,
      awsWorkerSpecAcceptance: stored.awsWorkerSpecAcceptance,
      awsWorkerVolumeExpansion: stored.awsWorkerVolumeExpansion,
      awsWorkerGoneNotice: stored.awsWorkerGoneNotice,
      leavingMachines: stored.leavingMachines,
      cloudRuns: stored.cloudRuns,
      cloudRunsMode: stored.cloudRunsMode,
      cloudRunsDeviceId: stored.cloudRunsDeviceId,
      agentEnvironment: { variables },
      machines: stored.machines,
      machineInstalls: stored.machineInstalls,
      encryptedMachinePairings: stored.encryptedMachinePairings,
      encryptedMachinePower: stored.encryptedMachinePower,
      encryptedMachinePowerPrevious: stored.encryptedMachinePowerPrevious,
      machinePowerHandoffs: stored.machinePowerHandoffs,
      trustedDevices: stored.trustedDevices,
      hubPhoneInvites: stored.hubPhoneInvites,
      machineDeviceRevocations: stored.machineDeviceRevocations,
      relayRemoval: stored.relayRemoval,
      relayRemovalPending: stored.relayRemovalPending,
      relayRemovalFailures: stored.relayRemovalFailures,
      machineInactivityCheckAt: stored.machineInactivityCheckAt,
      lastRepoPath: stored.lastRepoPath
    };
    // One atomic settings write replaces both configuration and environment.
    // A failed secret operation or disk write must not launch with a partially
    // applied snapshot, or silently retain an obsolete environment variable.
    await this.settings.settingsStore.writeStored(next, true);
  }

  readMachinePairings(stored: StoredSettings): Record<string, MobilePairingPackage> {
    if (!stored.encryptedMachinePairings) {
      return {};
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(this.settings.secrets.openJson(stored.encryptedMachinePairings));
    } catch (error) {
      // Never treat an unreadable record as empty: a later save would replace
      // every stored enrollment. The stored blob stays as it is.
      throw new Error(
        `Stored machine enrollments could not be read (${error instanceof Error ? error.message : String(error)}). ` +
        "They were left untouched; if the system secret store changed, remove and re-enroll the machines."
      );
    }
    return parsed && typeof parsed === "object" ? parsed as Record<string, MobilePairingPackage> : {};
  }
}

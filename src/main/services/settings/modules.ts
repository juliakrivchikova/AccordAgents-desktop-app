import type { SettingsDependencies } from "./dependencies";
import { AgentEnvironment } from "./environment/agentEnvironment";
import { AppPreferences } from "./preferences/appPreferences";
import { AwsWorker } from "./aws/awsWorker";
import { BehaviorRules } from "./roles/behaviorRules";
import { CloudRuns } from "./aws/cloudRuns";
import { CustomAvatars } from "./avatars/customAvatars";
import { HubSettings } from "./machines/hubSettings";
import { MachinePower } from "./machines/machinePower";
import { MachineRegistry } from "./machines/machineRegistry";
import { MachineSnapshot } from "./machines/machineSnapshot";
import { MemberPresets } from "./members/memberPresets";
import { MemberUsage } from "./members/memberUsage";
import { PhoneInvites } from "./machines/phoneInvites";
import { ProviderDefaults } from "./providers/providerDefaults";
import { ProviderHosts } from "./providers/providerHosts";
import { PublicSettings } from "./stored/publicSettings";
import { RelayRemoval } from "./machines/relayRemoval";
import { RoleConfigs } from "./roles/roleConfigs";
import { SavedPrompts } from "./roles/savedPrompts";
import { Secrets } from "./stored/secrets";
import { SettingsStore } from "./stored/settingsStore";
import { TrustedDevices } from "./machines/trustedDevices";

/** The settings' parts. Each names the ones it uses in its constructor. */
export interface SettingsModules {
  readonly settingsStore: SettingsStore;
  readonly secrets: Secrets;
  readonly publicSettings: PublicSettings;
  readonly memberUsage: MemberUsage;
  readonly memberPresets: MemberPresets;
  readonly customAvatars: CustomAvatars;
  readonly providerDefaults: ProviderDefaults;
  readonly providerHosts: ProviderHosts;
  readonly roleConfigs: RoleConfigs;
  readonly behaviorRules: BehaviorRules;
  readonly savedPrompts: SavedPrompts;
  readonly appPreferences: AppPreferences;
  readonly agentEnvironment: AgentEnvironment;
  readonly cloudRuns: CloudRuns;
  readonly awsWorker: AwsWorker;
  readonly machineRegistry: MachineRegistry;
  readonly trustedDevices: TrustedDevices;
  readonly phoneInvites: PhoneInvites;
  readonly relayRemoval: RelayRemoval;
  readonly hubSettings: HubSettings;
  readonly machinePower: MachinePower;
  readonly machineSnapshot: MachineSnapshot;
}

/** Builds every part around one registry: parts call each other only once all of them exist. */
export function createSettingsModules(deps: SettingsDependencies): SettingsModules {
  const modules = {} as { -readonly [Key in keyof SettingsModules]: SettingsModules[Key] };
  modules.settingsStore = new SettingsStore(deps);
  modules.secrets = new Secrets();
  modules.publicSettings = new PublicSettings(modules);
  modules.memberUsage = new MemberUsage();
  modules.memberPresets = new MemberPresets(modules);
  modules.customAvatars = new CustomAvatars(modules);
  modules.providerDefaults = new ProviderDefaults(modules);
  modules.providerHosts = new ProviderHosts(modules);
  modules.roleConfigs = new RoleConfigs(modules);
  modules.behaviorRules = new BehaviorRules(modules);
  modules.savedPrompts = new SavedPrompts(modules);
  modules.appPreferences = new AppPreferences(modules);
  modules.agentEnvironment = new AgentEnvironment(modules, deps);
  modules.cloudRuns = new CloudRuns(modules);
  modules.awsWorker = new AwsWorker(modules);
  modules.machineRegistry = new MachineRegistry(modules);
  modules.trustedDevices = new TrustedDevices(modules);
  modules.phoneInvites = new PhoneInvites(modules);
  modules.relayRemoval = new RelayRemoval(modules);
  modules.hubSettings = new HubSettings(modules);
  modules.machinePower = new MachinePower(modules);
  modules.machineSnapshot = new MachineSnapshot(modules);
  return modules;
}

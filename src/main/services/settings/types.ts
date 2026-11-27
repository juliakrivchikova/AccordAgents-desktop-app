import type { MachineRecord } from "../../../shared/machineLink";
import type { TrustedDeviceRecord } from "../../../shared/machineTrust";
import type { MachineInstallRecord } from "../../../shared/machineInstall";
import type { MachinePowerHandoffRecord } from "../../../shared/machinePowerHandoff";
import type {
  AgentEnvironmentValueProtection, ChatBehaviorRuleConfig, ChatSavedPromptConfig, AwsWorkerHandleInfo, AwsWorkerOperationSnapshot,
  AwsWorkerSpec, AwsWorkerVolumeExpansion, CloudRunsSettings, CloudRunWorkerMode, CliProviderHostCli, CliProviderHostVendor,
  ChatParticipantConfig, ChatParticipantSeedState, ChatPromptContextSettings, ChatProviderKind, ChatRoleConfig, ProviderSettings,
  RepoFileExternalOpenAction, RepoFileOpenAction
} from "../../../shared/types";
import type { CustomAvatarSummary } from "../../../shared/avatarStudio";
import type { HubLinkConfig } from "../../../shared/hubSetup";
import type { AwsWorkerGoneNotice, LeavingMachine } from "./aws/leavingMachines";
import type { StoredHubPhoneInvite } from "./machines/hubSetting";
import type { RelayRemovalFailure, RelayRemovalPending, RelayRemovalRecord } from "./machines/relayRemovalRecords";

type StoredProviderSettings = ProviderSettings & {
  encryptedApiKey?: string;
};

export interface StoredAgentEnvironmentVariable {
  key: string;
  encryptedValue: string;
  enabled?: boolean;
  updatedAt: string;
  protection?: AgentEnvironmentValueProtection;
  /** Read from this computer and kept in step with it; absent for a value
   *  the User added or changed. */
  source?: "automatic";
}

export interface StoredCliProviderHost {
  id: string;
  label: string;
  cli: CliProviderHostCli;
  vendor: CliProviderHostVendor;
  baseUrl: string;
  encryptedApiKey?: string;
  protection?: AgentEnvironmentValueProtection;
  updatedAt: string;
}

interface StoredAgentEnvironmentSettings {
  variables?: StoredAgentEnvironmentVariable[];
  /** Names the User deleted while this computer still sets them: reading the
   *  computer again does not bring them back, and members here do not get
   *  the computer's value either. */
  removedAutomaticKeys?: string[];
}

export interface StoredSettings {
  settingsVersion?: number;
  roundLimitDefault: number;
  betaUpdates?: boolean;
  /** False: members' actions are not listed in their replies. */
  chatShowMemberActions?: boolean;
  cliAgentRunTimeoutMs?: number;
  chatParticipantRequestMaxDepth?: number;
  chatParticipantRequestPromptMaxChars?: number;
  chatAutoWatchWakeLimit?: number;
  chatPromptContext?: ChatPromptContextSettings;
  cloudRuns?: CloudRunsSettings;
  cloudRunsMode?: CloudRunWorkerMode;
  encryptedAwsCredentials?: string;
  awsWorkerHandle?: AwsWorkerHandleInfo;
  awsWorkerRegion?: string;
  cloudRunsDeviceId?: string;
  awsWorkerOperation?: AwsWorkerOperationSnapshot;
  awsWorkerProvisioningToken?: string;
  awsWorkerSpecAcceptance?: {
    instanceId: string;
    desired: AwsWorkerSpec;
  };
  awsWorkerVolumeExpansion?: AwsWorkerVolumeExpansion;
  /** The app removed its instance by itself because AWS no longer has it;
   *  the AWS page says so until another instance is connected. */
  awsWorkerGoneNotice?: AwsWorkerGoneNotice;
  /** Machines on an instance that can never come back, not removed yet. */
  leavingMachines?: LeavingMachine[];
  agentEnvironment?: StoredAgentEnvironmentSettings;
  cliProviderHosts?: StoredCliProviderHost[];
  assistantProviderKind?: ChatProviderKind;
  /** How a new chat starts besides its CLI (shared/newChatDefaults.ts). */
  newChatDefaults?: unknown;
  /** Each CLI's model and effort for the agents a chat gives tasks to
   *  (Settings → General → Agents, shared/subagentProviders.ts). */
  subagentDefaults?: unknown;
  /** The projects' lists of agents from before Settings' defaults
   *  (2026-11-26, never released): no longer read, but kept in the file as
   *  stored, so a downgrade keeps them. */
  subagentProvidersByProject?: unknown;
  /** The view new chats opened in before every new chat opened in the
   *  sessions view: no longer read, but kept in the file as stored, so a
   *  downgrade keeps her choice. */
  defaultChatView?: unknown;
  lastSuccessfulChatProviderKind?: ChatProviderKind;
  lastRepoPath?: string;
  repoFileOpenAction?: RepoFileOpenAction;
  /** What the file panel's "Open in…" button does; the User's OS choice from before the panel existed. */
  repoFileExternalOpenAction?: RepoFileExternalOpenAction;
  /** Set once the file panel became the default click (2026-10-30), so the switch happens once. */
  repoFileOpenPanelMigrated?: boolean;
  providers: StoredProviderSettings[];
  chatRoleConfigs?: ChatRoleConfig[];
  chatBehaviorRules?: ChatBehaviorRuleConfig[];
  chatSavedPrompts?: ChatSavedPromptConfig[];
  chatParticipantConfigs?: ChatParticipantConfig[];
  chatCustomAvatars?: CustomAvatarSummary[];
  chatParticipantSeedState?: ChatParticipantSeedState;
  /** Enrolled machines (machines transport). The pairing packages carry the
   *  key each machine's first hello is sealed with, and are stored sealed,
   *  keyed by MachineRecord.pairingKey. */
  machines?: MachineRecord[];
  encryptedMachinePairings?: string;
  /** This host's power key is never part of participant settings replication. */
  encryptedMachinePower?: string;
  /** The power key `encryptedMachinePower` replaced ("none" when there was
   *  none), so a handover the runtime did not come back from can put it back.
   *  Consumed by that revert; absent, there is nothing to revert. */
  encryptedMachinePowerPrevious?: string;
  /** The User's automatic-stop switch. Unset reads as on, so a stop key set
   *  up before the switch existed keeps working. Shared with machines in the
   *  settings snapshot: the machine's runtime is what decides to stop. */
  machineAutoStopEnabled?: boolean;
  /** When the User last changed the switch: a machine's report older than
   *  this predates the change and says nothing about whether it arrived. */
  machineAutoStopChangedAt?: string;
  /** The User's own server (hub), once it is set up. */
  hub?: HubLinkConfig;
  /** Who holds a copy of the phone's start key. Records only, never the
   *  secret, and never sent to a machine: they name the User's devices. */
  machinePowerHandoffs?: MachinePowerHandoffRecord[];
  /** How each machine was installed from THIS desktop (SSH access, install
   *  root, service, installed version). Never travels to a machine: it carries
   *  this desktop's way in. */
  machineInstalls?: MachineInstallRecord[];
  /** Devices the User has said may use this desktop's machines. Their public
   *  keys are what a machine checks a command's signature against; there is
   *  nothing secret in them. */
  trustedDevices?: TrustedDeviceRecord[];
  /** Phone invites this desktop made for its server, and what became of
   *  each: a phone enrolled with it, or it was revoked. */
  hubPhoneInvites?: StoredHubPhoneInvite[];
  machineDeviceRevocations?: Record<string, string>;
  /** When the records set up through the shared relay were taken off this
   *  desktop, and what they were: its presence means the removal ran. */
  relayRemoval?: RelayRemovalRecord;
  /** What the removal found before it took anything off (a start that stops
   *  half way): kept, so the record still names everything. */
  relayRemovalPending?: RelayRemovalPending;
  /** Relay machines whose removal failed at the last start; each is tried
   *  again at every start until it goes. */
  relayRemovalFailures?: RelayRemovalFailure[];
  /** When this desktop last asked about machines that stopped being used. */
  machineInactivityCheckAt?: string;
}

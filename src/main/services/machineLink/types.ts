import type { MachineRecord } from "../../../shared/machineLink";
import type { MobilePairingPackage } from "../../../shared/mobilePairing";
import type { ChatBackgroundTasksEvent, ReviewProgress } from "../../../shared/types";
import type { TunnelClient } from "../hubTunnelClient";
import type { DeviceIdentityService } from "../deviceIdentity";

export interface MachineLinkOptions {
  appVersion: string;
  desktopDeviceId: string;
  /** This desktop's device identity: what it signs and seals with. */
  deviceIdentity: Pick<DeviceIdentityService, "getOrCreateDeviceIdentity">;
  /** Builds the client for one machine's room on the User's server (a test
   *  stand-in in tests); undefined when this desktop has no server. */
  createClient?: (pairing: MobilePairingPackage) => TunnelClient | undefined;
  /** The set of machines (or their keys) changed: whoever admits devices by
   *  key, the User's server, is told again. */
  onDevicesChanged?: () => void;
  /** The bytes of a picture a machine asks for: a picture attached on this
   *  desktop is kept here, and a member on a machine reads it from here. */
  readChatAttachment?: (request: { conversationId: string; attachmentId: string })
    => Promise<{ attachment: { mimeType?: string; filename?: string }; dataBase64: string }>;
  /** Puts one machine's settings, sealed for it, on the User's server. */
  publishSettings?: (machineId: string, sealed: string) => Promise<void>;
  /** Where this desktop's projects live on a machine (by this desktop's path). */
  machineProjects?: (machineId: string) => Promise<Record<string, string>>;
  now?: () => Date;
}

/** A machine's members' background work: one member's change, the machine's
 *  complete list (`snapshot`, replacing what it reported before), or nothing
 *  (`snapshot` empty) when the machine went away. */
export interface MachineMemberBackgroundEvent {
  machineId: string;
  member?: ChatBackgroundTasksEvent;
  snapshot?: ChatBackgroundTasksEvent[];
}

/** The machine that sent it is named: the desktop offers a suggestion only
 *  for a reply it asked of that machine. */
export interface MachinePromptSuggestionEvent {
  machineId: string;
  conversationId: string;
  runId: string;
  participantId: string;
  suggestion: string;
}

export interface MachineConnection {
  record: MachineRecord;
  pairing: MobilePairingPackage;
  client: TunnelClient;
  machineDeviceId?: string;
  /** Serializes machine-record writes for this connection. */
  persist: Promise<void>;
  /** Inbound messages are decrypted and applied strictly in arrival order. */
  inbound: Promise<void>;
  /** Sealing and frame writes preserve order. */
  outbound: Promise<void>;
  /** A hello arrived on this connection; until then the machine is asked
   *  to greet a desktop that just connected. */
  helloSeen: boolean;
  helloRequestTimer?: ReturnType<typeof setTimeout>;
  /** The hello request in flight from machineActivity(), shared by every
   *  caller asking meanwhile: one request, one answering hello. */
  activityProbe?: Promise<boolean>;
  /** Monotonic start counter of the newest runtime instance seen. */
  latestInstanceSequence?: number;
  /** Requests waiting for the machine's answer (scheduled scripts). */
  pendingScripts: Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>;
  /** Live progress being decoded, by run: the stream and its newest state. */
  progress: Map<string, { streamId: string; sequence: number; progress: ReviewProgress }>;
}

/** A machine as Settings → Scheduled Tasks sees it. */
export interface MachineScriptHost {
  machineId: string;
  name: string;
  connected: boolean;
  supported: boolean;
}

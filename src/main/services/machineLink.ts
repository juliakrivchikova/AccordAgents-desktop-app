/**
 * Machine link, desktop side.
 *
 * A cloud machine is a plain client of the User's server (agreements Д1–Д13):
 * its members' turns are asked of it there, it takes them there and writes
 * their replies there, and a Stop reaches it there (ChatService). This desktop
 * dispatches nothing to it. What is left here is the live control between
 * this desktop and the machines it set up, in each machine's room on the
 * server, never stored: the machine's greeting and status (Settings, updates,
 * automatic stop), its scheduled scripts, a picture a member there reads from
 * this desktop, background-task labels, next-prompt suggestions and live
 * progress for this window. And this desktop publishes each machine's
 * settings on the server, sealed for that machine alone.
 */

import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  MACHINE_LINK_PROTOCOL,
  isMachineLinkEnvelope,
  MACHINE_ATTACHMENT_PART_BYTES,
  machineSigningKey,
  type MachineAttachmentRequestBody,
  type MachineHelloBody,
  type MachineLinkEnvelope,
  type MachineLinkMessage,
  type MachineLinkStatus,
  type MachineRecord,
  type MachineScriptsOperation,
  type MachineSettingsDocument,
  type MachineSettingsSnapshot
} from "../../shared/machineLink";
import { decodeMachineProgress, type MachineProgressFrame } from "../../shared/machineProgress";
import type { MobilePairingPackage } from "../../shared/mobilePairing";
import { assertRecoverableMachineEnrollment } from "../../shared/machineEnrollmentRecovery";
import type { Conversation, ReviewProgress } from "../../shared/types";
import type { DebugLogService } from "./debugLogs";
import { deriveMachineChannelKey } from "../../shared/machineChannelKey";
import { openMachinePayload, sealChannelPayload, sealMachinePayload } from "./machineChannelSealing";
import type { TunnelClient } from "./hubTunnelClient";
import { signMachineControl, verifyMachineControl } from "./machineControlAuthentication";
import type { SettingsService } from "./settings";
import type { ChatEventLogService } from "./chatEventLog";
import type { MachineRecoveryLinkState } from "./machineRecovery";

export interface MachineLinkOptions {
  appVersion: string;
  desktopDeviceId: string;
  /** This desktop's device identity: what it signs and seals with. */
  eventLog: Pick<ChatEventLogService, "getOrCreateDeviceIdentity">;
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

export type { MachineLinkStatus };

function cleanBackgroundLabels(labels: unknown[]): string[] {
  return labels.filter((label): label is string => typeof label === "string").slice(0, 50);
}

/** A machine's members' background work: one member's change, the machine's
 *  complete list (`snapshot`, replacing what it reported before), or nothing
 *  (`snapshot` empty) when the machine went away. */
export interface MachineMemberBackgroundEvent {
  machineId: string;
  member?: { conversationId: string; participantId: string; labels: string[] };
  snapshot?: Array<{ conversationId: string; participantId: string; labels: string[] }>;
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

interface MachineConnection {
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

/** How long a scheduled-script request waits for the machine's answer. */
const SCRIPTS_REQUEST_TIMEOUT_MS = 20_000;
/** How long one hold of a machine's turns lasts unless renewed, and how
 *  often it is renewed while held. */
const TURN_HOLD_MS = 15 * 60_000;
const TURN_HOLD_RENEW_MS = 5 * 60_000;
/** Runs whose live progress is followed per machine, at most. */
const LIVE_PROGRESS_RUNS_MAX = 64;

/** A machine as Settings → Scripts sees it. */
export interface MachineScriptHost {
  machineId: string;
  name: string;
  connected: boolean;
  supported: boolean;
}

/** How long a freshly connected desktop waits for the machine's own hello
 *  before asking for one. */
const HELLO_REQUEST_GRACE_MS = 750;
/** How long a connected machine gets to answer a hello request before its
 *  last known hello is used instead. */
const MACHINE_ACTIVITY_TIMEOUT_MS = 15_000;

export interface MachineActivity {
  machineId: string;
  connected: boolean;
  /** True when the machine answered the request; false when this is its
   *  last known hello, which may predate turns that started or ended since.
   *  A decision that would stop the runtime must not act on a stale answer. */
  fresh: boolean;
  /** Runtime version the machine reports. */
  appVersion?: string;
  /** Runs executing on the machine, as it says. A turn asked of it that it
   *  has not taken waits on the User's server and does not count: the
   *  runtime that is there when it is taken runs it. */
  activeRunIds: string[];
}

export function machineActivityIsBusy(activity: MachineActivity): boolean {
  return activity.activeRunIds.length > 0;
}

export class MachineLinkService {
  private readonly emitter = new EventEmitter();
  private readonly scriptsChangedListeners: Array<(machineId: string) => void> = [];
  private readonly progressListeners: Array<(progress: ReviewProgress) => void> = [];
  private readonly suggestionListeners: Array<(event: MachinePromptSuggestionEvent) => void> = [];
  private readonly backgroundListeners: Array<(event: MachineMemberBackgroundEvent) => void> = [];
  private conversationLoader?: (conversationId: string) => Promise<Conversation | undefined>;
  private readonly connections = new Map<string, MachineConnection>();
  /** Why a machine cannot take turns right now (its runtime is being
   *  replaced), by machine id: shown on a waiting member's bubble. */
  private readonly turnHolds = new Map<string, Array<{ reason: string }>>();
  /** Every enrolled machine, read from settings before any connects. */
  private readonly enrolled = new Map<string, MachineRecord>();
  /** What each machine's settings on the User's server were last published
   *  from (a digest of what a machine uses, the key it is sealed for and the
   *  place it was put): the same is not put again. Kept in memory, so every
   *  start of this desktop publishes once. */
  private readonly publishedSettings = new Map<string, string>();
  private settingsPublication: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly seenMessageIds = new Set<string>();
  private readonly now: () => Date;

  constructor(
    private readonly settings: Pick<SettingsService, "listMachines" | "saveMachine" | "removeMachine" | "getMachinePairing" | "exportMachineSettingsSnapshot"> & Partial<Pick<SettingsService, "restoreMachineEnrollment">>,
    private readonly debugLogs: Pick<DebugLogService, "write">,
    private readonly options: MachineLinkOptions
  ) {
    this.now = options.now ?? (() => new Date());
  }

  onStatus(listener: (status: MachineLinkStatus[]) => void): () => void {
    this.emitter.on("status", listener);
    return () => this.emitter.off("status", listener);
  }

  /** A member hosted on a machine started or ended background work; `labels`
   *  empty also when the machine went away (nothing it said holds any more). */
  onMemberBackgroundTasks(listener: (event: MachineMemberBackgroundEvent) => void): () => void {
    this.backgroundListeners.push(listener);
    return () => { const index = this.backgroundListeners.indexOf(listener); if (index >= 0) this.backgroundListeners.splice(index, 1); };
  }

  /** A member's next-prompt suggestion from the machine that ran its reply. */
  onPromptSuggestion(listener: (event: MachinePromptSuggestionEvent) => void): () => void {
    this.suggestionListeners.push(listener);
    return () => { const index = this.suggestionListeners.indexOf(listener); if (index >= 0) this.suggestionListeners.splice(index, 1); };
  }

  /** A machine member's live progress, for this window (the phone reads it
   *  from the server, where the machine posts it itself). */
  onProgress(listener: (progress: ReviewProgress) => void): () => void {
    this.progressListeners.push(listener);
    return () => { const index = this.progressListeners.indexOf(listener); if (index >= 0) this.progressListeners.splice(index, 1); };
  }

  /** Lets the link check that a picture a machine asks for is in a chat. */
  setConversationLoader(loader: (conversationId: string) => Promise<Conversation | undefined>): void {
    this.conversationLoader = loader;
  }

  /** Reads the enrolled machines, so the server's roster names them before
   *  any chat activity. */
  async loadMachines(): Promise<void> {
    for (const record of await this.settings.listMachines()) {
      if (!this.connections.has(record.id)) this.enrolled.set(record.id, record);
    }
  }

  async start(): Promise<void> {
    this.closed = false;
    const machines = await this.settings.listMachines();
    for (const record of machines) if (!this.connections.has(record.id)) this.enrolled.set(record.id, record);
    void this.debugLogs.write("machine-link.start", { machines: machines.length, desktopDeviceId: this.options.desktopDeviceId });
    for (const record of machines) {
      await this.connectMachine(record).catch((error) => {
        void this.debugLogs.write("machine-link.connect.error", { machineId: record.id, message: errorMessage(error) });
      });
    }
  }

  async connectMachine(record: MachineRecord, pairingOverride?: MobilePairingPackage): Promise<void> {
    const existing = this.connections.get(record.id);
    if (existing) {
      existing.record = record;
      return;
    }
    this.enrolled.set(record.id, record);
    const pairing = pairingOverride ?? await this.settings.getMachinePairing(record.pairingKey);
    if (!pairing) throw new Error(`Machine ${record.name} has no pairing package.`);
    // A machine is reached in its room on the User's server, nowhere else.
    const client = pairing.hubUrl ? this.options.createClient?.(pairing) : undefined;
    if (!client) throw new Error(`${record.name} is not set up with your server; choose Cloud run in a member's settings to set it up again.`);
    const connection: MachineConnection = {
      record,
      pairing,
      client,
      persist: Promise.resolve(),
      inbound: Promise.resolve(),
      outbound: Promise.resolve(),
      helloSeen: false,
      pendingScripts: new Map(),
      progress: new Map()
    };
    this.connections.set(record.id, connection);
    client.on("peer", (event) => {
      if (this.connections.get(record.id) !== connection) return;
      void this.debugLogs.write("machine-link.peer", {
        machineId: record.id,
        type: event.type,
        ...(event.type === "ready" ? { peers: event.peers.map((peer) => `${peer.role}:${peer.deviceId ?? ""}`) } : {}),
        ...(event.type === "peer-connected" || event.type === "peer-disconnected" ? { peer: `${event.peer.role}:${event.peer.deviceId ?? ""}` } : {})
      });
      // Only this machine's own device decides whether it is here.
      const isThisMachine = (peer: { role: string; deviceId?: string }) => peer.role === "machine" &&
        (!connection.record.deviceId || peer.deviceId === connection.record.deviceId);
      if (event.type === "ready") {
        this.setMachinePeer(connection, event.peers.find(isThisMachine)?.deviceId);
      } else if (event.type === "peer-connected" && isThisMachine(event.peer)) {
        // Connected again (also in the seat of a connection the server had not
        // seen close): what it knows now is asked afresh, not assumed.
        if (connection.machineDeviceId === event.peer.deviceId) this.machineReturned(connection);
        else this.setMachinePeer(connection, event.peer.deviceId);
      } else if (event.type === "peer-disconnected" && isThisMachine(event.peer)) {
        this.setMachinePeer(connection, undefined);
      }
    });
    client.on("message", (message) => {
      if (this.connections.get(record.id) !== connection) return;
      // Strictly in order from decryption on: a progress frame must not be
      // overtaken by the next one.
      connection.inbound = connection.inbound
        .then(() => this.handleMessage(connection, message.ciphertext))
        .catch((error) => {
          void this.debugLogs.write("machine-link.message.error", { machineId: record.id, message: errorMessage(error) });
        });
    });
    client.on("state", (state) => {
      if (this.connections.get(record.id) !== connection) return;
      void this.debugLogs.write("machine-link.tunnel.state", { machineId: record.id, state });
      if (state !== "connected") this.setMachinePeer(connection, undefined);
    });
    client.on("error", (error) => {
      void this.debugLogs.write("machine-link.tunnel.error", { machineId: record.id, message: error.message });
    });
    await client.connect().catch((error) => {
      void this.debugLogs.write("machine-link.connect.retrying", { machineId: record.id, message: errorMessage(error) });
    });
  }

  /** Closes a machine's connection. It stays enrolled until `forgetMachine`. */
  async disconnectMachine(machineId: string): Promise<void> {
    const connection = this.connections.get(machineId);
    if (!connection) return;
    this.enrolled.set(machineId, connection.record);
    this.connections.delete(machineId);
    if (connection.helloRequestTimer) clearTimeout(connection.helloRequestTimer);
    this.rejectPendingScripts(connection, "The machine was removed.");
    connection.client.close();
    this.emitMemberBackground({ machineId, snapshot: [] });
    this.emitStatus();
  }

  /** The machine is no longer enrolled: removed from the app. */
  async forgetMachine(machineId: string): Promise<void> {
    await this.disconnectMachine(machineId);
    this.enrolled.delete(machineId);
    this.publishedSettings.delete(machineId);
  }

  close(): void {
    this.closed = true;
    if (this.turnHoldTimer) clearInterval(this.turnHoldTimer);
    this.turnHoldTimer = undefined;
    for (const connection of this.connections.values()) {
      if (connection.helloRequestTimer) clearTimeout(connection.helloRequestTimer);
      connection.client.close();
    }
    this.connections.clear();
  }

  /** Holds a machine's turns while its runtime is being replaced: the
   *  machine takes no new turn from the User's server meanwhile (they wait
   *  there for the runtime that takes them), and a waiting member's bubble
   *  says why. Each caller gets its own release; turns go on once every
   *  holder let go. */
  holdTurns(machineId: string, reason: string): () => void {
    const holds = this.turnHolds.get(machineId) ?? [];
    const hold = { reason };
    holds.push(hold);
    this.turnHolds.set(machineId, holds);
    void this.debugLogs.write("machine-link.turns.held", { machineId, reason });
    this.sendTurnHold(machineId);
    if (!this.turnHoldTimer) {
      // Renewed while held: the machine lets a hold lapse by itself.
      this.turnHoldTimer = setInterval(() => { for (const id of this.turnHolds.keys()) this.sendTurnHold(id); }, TURN_HOLD_RENEW_MS);
      this.turnHoldTimer.unref?.();
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.turnHolds.get(machineId) ?? []).filter((item) => item !== hold);
      if (remaining.length) {
        this.turnHolds.set(machineId, remaining);
        return;
      }
      this.turnHolds.delete(machineId);
      if (this.turnHolds.size === 0 && this.turnHoldTimer) {
        clearInterval(this.turnHoldTimer);
        this.turnHoldTimer = undefined;
      }
      const connection = this.connections.get(machineId);
      if (connection?.machineDeviceId) void this.send(connection, { type: "machine.turns.release" }).catch(() => undefined);
      void this.debugLogs.write("machine-link.turns.released", { machineId });
    };
  }

  private turnHoldTimer?: ReturnType<typeof setInterval>;

  private sendTurnHold(machineId: string): void {
    const reason = this.turnHolds.get(machineId)?.[0]?.reason;
    const connection = this.connections.get(machineId);
    if (!reason || !connection?.machineDeviceId) return;
    void this.send(connection, { type: "machine.turns.hold", reason, until: new Date(this.now().getTime() + TURN_HOLD_MS).toISOString() }).catch(() => undefined);
  }

  hasTurnHold(machineId: string): boolean {
    return this.turnHolds.has(machineId);
  }

  /** Why turns asked of this machine wait right now, when this desktop knows. */
  turnWaitReason(machineId: string): string | undefined {
    return this.turnHolds.get(machineId)?.[0]?.reason;
  }

  /** Ask a machine to do something with its scheduled scripts and wait for
   *  the answer. Ephemeral and sealed to that machine: a key value travels
   *  only here, never on the server or in settings. */
  async scriptsRequest(machineId: string, operation: MachineScriptsOperation, timeoutMs = SCRIPTS_REQUEST_TIMEOUT_MS): Promise<unknown> {
    const connection = this.connections.get(machineId);
    if (!connection) throw new Error("That machine is not set up on this computer.");
    if (!this.managesScripts(connection)) {
      throw new Error(`Scheduled scripts on ${connection.record.name} are managed from the desktop that set it up.`);
    }
    if (!connection.machineDeviceId) throw new Error(`${connection.record.name} is not connected right now.`);
    const hello = connection.record.lastHello;
    if (!hello) throw new Error(`${connection.record.name} has not greeted this desktop yet; try again in a moment.`);
    if (hello.scriptsSupported !== true) {
      throw new Error(`${connection.record.name} runs an older runtime without scheduled scripts; upgrade it in Settings → Machines.`);
    }
    const requestId = randomUUID();
    const answer = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        connection.pendingScripts.delete(requestId);
        reject(new Error(`${connection.record.name} did not answer in time.`));
      }, timeoutMs);
      timer.unref?.();
      connection.pendingScripts.set(requestId, { resolve, reject, timer });
    });
    try {
      await this.send(connection, { type: "machine.scripts.request", requestId,
        ...(hello.instanceId ? { instanceId: hello.instanceId } : {}),
        expiresAt: new Date(this.now().getTime() + timeoutMs).toISOString(), operation });
    } catch (error) {
      const pending = connection.pendingScripts.get(requestId);
      if (pending) {
        clearTimeout(pending.timer);
        connection.pendingScripts.delete(requestId);
      }
      throw error;
    }
    return answer;
  }

  /** Every machine whose scripts this desktop manages, with whether it is
   *  connected now and runs a runtime that hosts scripts. */
  scriptHosts(): MachineScriptHost[] {
    return [...this.connections.values()].filter((connection) => this.managesScripts(connection)).map((connection) => ({
      machineId: connection.record.id,
      name: connection.record.name,
      connected: Boolean(connection.machineDeviceId),
      supported: connection.record.lastHello?.scriptsSupported === true
    }));
  }

  /** A machine takes script requests only from the desktop that set it up. */
  private managesScripts(connection: MachineConnection): boolean {
    return this.options.desktopDeviceId === connection.pairing.issuer.originId;
  }

  onScriptsChanged(listener: (machineId: string) => void): () => void {
    this.scriptsChangedListeners.push(listener);
    return () => {
      const index = this.scriptsChangedListeners.indexOf(listener);
      if (index >= 0) this.scriptsChangedListeners.splice(index, 1);
    };
  }

  private rejectPendingScripts(connection: MachineConnection, reason: string): void {
    for (const pending of connection.pendingScripts.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    connection.pendingScripts.clear();
  }

  status(): MachineLinkStatus[] {
    return [...this.connections.values()].map((connection) => {
      const hello = connection.record.lastHello;
      const warning = [hello?.unsentWarning, hello?.idleStopWarning].filter(Boolean).join("; ");
      return {
        machineId: connection.record.id,
        name: connection.record.name,
        connected: Boolean(connection.machineDeviceId),
        deviceId: connection.machineDeviceId ?? connection.record.deviceId ?? undefined,
        lastSeenAt: connection.record.lastSeenAt,
        lastHello: hello,
        ...(warning ? { warning } : {})
      };
    });
  }

  /** The device identity of an enrolled machine as its signed hello or its
   *  setup proved it. */
  machineDeviceId(machineId: string): string | undefined {
    return this.machineRecord(machineId)?.deviceId || undefined;
  }

  private machineRecord(machineId: string): MachineRecord | undefined {
    return this.connections.get(machineId)?.record ?? this.enrolled.get(machineId);
  }

  /**
   * Machine setup reads the identity of the runtime it installs and records
   * it here: from then on the User's server admits it (the roster names it),
   * and its settings can be sealed for it, although it has not connected yet.
   */
  async adoptMachineIdentity(machineId: string, identity: { originId: string; publicKeyDerBase64: string }): Promise<void> {
    const connection = this.connections.get(machineId);
    if (!connection) throw new Error("This machine is not connected from this desktop.");
    if (connection.record.deviceId && connection.record.deviceId !== identity.originId) {
      throw new Error("The machine's enrolled device identity changed; its history cannot be accepted as the previous machine.");
    }
    if (connection.record.deviceId === identity.originId && connection.record.devicePublicKeyDerBase64 === identity.publicKeyDerBase64) return;
    connection.record = { ...connection.record, deviceId: identity.originId, devicePublicKeyDerBase64: identity.publicKeyDerBase64 };
    await this.persistRecord(connection, true);
    void this.debugLogs.write("machine-link.identity.adopted", { machineId, deviceId: identity.originId });
    this.options.onDevicesChanged?.();
    await this.syncSettings().catch((error: unknown) => {
      void this.debugLogs.write("machine-link.settings.sync-error", { machineId, message: errorMessage(error) });
    });
  }

  /** True while any connected machine says it is working. The AWS idle stop
   *  asks this before stopping a box. */
  hasActiveMachineWork(): boolean {
    for (const connection of this.connections.values()) {
      if (!connection.machineDeviceId) continue;
      if ((connection.record.lastHello?.activeRunIds?.length ?? 0) > 0) return true;
    }
    return false;
  }

  /** True while scheduled scripts need a machine awake. Asked about one AWS
   *  instance, only the machines on it count, by what they last said even when
   *  the link is down at that moment; otherwise any connected one. */
  machineKeepsAwake(awsInstanceId?: string): boolean {
    const onInstance = awsInstanceId
      ? [...this.connections.values()].filter((connection) => connection.record.awsInstanceId === awsInstanceId)
      : [];
    if (onInstance.length > 0) return onInstance.some((connection) => connection.record.lastHello?.keepAwake === true);
    for (const connection of this.connections.values()) {
      if (connection.machineDeviceId && connection.record.lastHello?.keepAwake === true) return true;
    }
    return false;
  }

  /** Every hello a machine sends: a (re)connect, a restart, a status change,
   *  or an answer to `machine.hello.request`. */
  onHello(listener: (event: { machineId: string; appVersion?: string; deviceId?: string }) => void): () => void {
    const wrapped = (event: { machineId: string; appVersion?: string; deviceId?: string; solicited?: boolean }): void => {
      if (!event.solicited) listener(event);
    };
    this.emitter.on("hello", wrapped);
    return () => { this.emitter.off("hello", wrapped); };
  }

  /** What one machine is doing right now, from a hello it sends on request.
   *  Answered with the last known hello when the machine does not reply in
   *  time, and undefined when it is not enrolled or not connected. */
  async machineActivity(machineId: string, options: { fresh?: boolean; timeoutMs?: number } = {}): Promise<MachineActivity | undefined> {
    const connection = this.connections.get(machineId);
    if (!connection?.machineDeviceId) return undefined;
    let fresh = false;
    if (options.fresh !== false) {
      if (!connection.activityProbe) {
        const probe = new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => finish(false), options.timeoutMs ?? MACHINE_ACTIVITY_TIMEOUT_MS);
          timer.unref?.();
          const onHello = (event: { machineId: string }): void => { if (event.machineId === machineId) finish(true); };
          const finish = (value: boolean): void => {
            clearTimeout(timer);
            this.emitter.off("hello", onHello);
            if (connection.activityProbe === probe) connection.activityProbe = undefined;
            void this.debugLogs.write("machine-link.activity", { machineId, fresh: value });
            resolve(value);
          };
          this.emitter.on("hello", onHello);
          void this.send(connection, { type: "machine.hello.request", desktopDeviceId: this.options.desktopDeviceId }).catch(() => undefined);
        });
        connection.activityProbe = probe;
      }
      fresh = await connection.activityProbe;
    }
    const hello = connection.record.lastHello;
    return {
      machineId,
      connected: Boolean(connection.machineDeviceId),
      fresh,
      appVersion: hello?.appVersion,
      activeRunIds: [...(hello?.activeRunIds ?? [])]
    };
  }

  /** True while any connected machine is running a turn, asked afresh. */
  async anyMachineBusy(options: { timeoutMs?: number } = {}): Promise<boolean> {
    const activities = await Promise.all([...this.connections.keys()].map((machineId) => this.machineActivity(machineId, options)));
    // A connected machine that did not answer is not known to be idle.
    return activities.some((activity) => activity !== undefined && (!activity.fresh || machineActivityIsBusy(activity)));
  }

  isMachineConnected(machineId: string): boolean {
    return Boolean(this.connections.get(machineId)?.machineDeviceId);
  }

  /** This desktop's own way into the machine's room on the User's server is
   *  open, so a machine missing there is missing, not hidden by an outage on
   *  this side. */
  reachesRoom(machineId: string): boolean {
    return this.connections.get(machineId)?.client.currentState() === "connected";
  }

  /** Whether the machine's program is in touch, as its room says. */
  presenceState(machineId: string): MachineRecoveryLinkState {
    if (this.isMachineConnected(machineId)) return "connected";
    return this.reachesRoom(machineId) ? "out-of-touch" : "unknown";
  }

  /** The enrollment package for a machine, as the installer writes it to the
   *  machine. Read on demand and never held anywhere else. */
  async enrollmentJson(machineId: string): Promise<string> {
    const record = (await this.settings.listMachines()).find((machine) => machine.id === machineId);
    if (!record) throw new Error("Machine not found.");
    const pairing = await this.settings.getMachinePairing(record.pairingKey);
    if (!pairing) throw new Error("The machine's enrollment is missing; remove and add the machine again.");
    return JSON.stringify(pairing, null, 2);
  }

  /** Restore this owner's existing remote connection. Never disconnects a
   *  machine that is working. */
  private enrollmentRecovery = new Map<string, { requested: string; installed: string; installedMachineId: string; task: Promise<string> }>();

  restoreEnrollment(machineId: string, requestedJson: string, installedJson: string, installedMachineId = machineId): Promise<string> {
    const active = this.enrollmentRecovery.get(machineId);
    if (active) {
      if (active.requested === requestedJson && active.installed === installedJson && active.installedMachineId === installedMachineId) return active.task;
      return Promise.reject(new Error("Another connection recovery is running. Wait for it to finish, then try again."));
    }
    const task = this.restoreEnrollmentNow(machineId, requestedJson, installedJson, installedMachineId).finally(() => this.enrollmentRecovery.delete(machineId));
    this.enrollmentRecovery.set(machineId, { requested: requestedJson, installed: installedJson, installedMachineId, task });
    return task;
  }

  private async restoreEnrollmentNow(machineId: string, requestedJson: string, installedJson: string, installedMachineId: string): Promise<string> {
    const requested = JSON.parse(requestedJson) as MobilePairingPackage;
    const installed = JSON.parse(installedJson) as MobilePairingPackage;
    assertRecoverableMachineEnrollment(requested, installed);
    if (!this.settings.restoreMachineEnrollment) throw new Error("Machine connection recovery is unavailable.");
    const connection = this.connections.get(machineId);
    if (machineId === installedMachineId && connection?.pairing.rendezvousId === installed.rendezvousId) return machineId;
    if (connection && (connection.machineDeviceId || (connection.record.lastHello?.activeRunIds?.length ?? 0) > 0)) {
      throw new Error("The machine still has an active connection or running work. Finish it before restoring its connection.");
    }
    await this.disconnectMachine(machineId);
    try {
      if (connection) {
        await connection.inbound;
        await connection.outbound;
        await connection.persist;
      }
      const restored = await this.settings.restoreMachineEnrollment(machineId, requested, installed, installedMachineId);
      await this.connectMachine(restored);
      return restored.id;
    } catch (error) {
      // On disk failure restore the old route; after a committed save or a
      // process restart, this reads the new route and reconnects to it instead.
      const saved = (await this.settings.listMachines()).find(machine => machine.id === machineId || machine.id === installedMachineId);
      if (saved) await this.connectMachine(saved).catch(() => undefined);
      throw error;
    }
  }

  /** Resolves on the next hello from this machine that arrives after the call
   *  started. With `expectAppVersion` it also requires that hello to report
   *  that version, so an upgrade is only "done" once the new runtime greeted. */
  waitForConnected(machineId: string, timeoutMs: number, expectAppVersion?: string): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.emitter.off("hello", onHello);
        resolve(value);
      };
      const onHello = (event: { machineId: string; appVersion?: string }): void => {
        if (event.machineId !== machineId) return;
        if (expectAppVersion && event.appVersion !== expectAppVersion) {
          void this.debugLogs.write("machine-link.wait.version-mismatch", { machineId, expected: expectAppVersion, reported: event.appVersion ?? "" });
          return;
        }
        finish(true);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      timer.unref?.();
      this.emitter.on("hello", onHello);
    });
  }

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
    const publish = this.options.publishSettings;
    if (!publish || this.closed) return;
    let snapshot: MachineSettingsSnapshot | undefined;
    const identity = await this.options.eventLog.getOrCreateDeviceIdentity();
    const failures: string[] = [];
    for (const record of await this.settings.listMachines()) {
      const machineKey = machineSigningKey(this.machineRecord(record.id) ?? record);
      if (!machineKey) continue;
      const pairing = this.connections.get(record.id)?.pairing ?? await this.settings.getMachinePairing(record.pairingKey);
      if (!pairing?.hubUrl || pairing.issuer.originId !== this.options.desktopDeviceId) continue;
      try {
        snapshot ??= await this.settings.exportMachineSettingsSnapshot();
        const projects = await this.options.machineProjects?.(record.id) ?? {};
        const digest = createHash("sha256").update(JSON.stringify([machineSettingsKey(snapshot), projects, machineKey, pairing.hubUrl, pairing.rendezvousId])).digest("hex");
        if (this.publishedSettings.get(record.id) === digest) continue;
        const document: MachineSettingsDocument = { version: 1, settings: snapshot, projects };
        const sealed = await sealChannelPayload(document, deriveMachineChannelKey(identity, machineKey, pairing.rendezvousId));
        await publish(record.id, sealed);
        this.publishedSettings.set(record.id, digest);
        void this.debugLogs.write("machine-link.settings.published", { machineId: record.id, bytes: sealed.length });
      } catch (error) {
        failures.push(`${record.name}: ${errorMessage(error)}`);
      }
    }
    if (failures.length) throw new Error(`Settings could not be published for ${failures.join("; ")}`);
  }

  // --- the room -------------------------------------------------------------

  /** Saves the machine's record (its greeting, its identity). */
  private persistRecord(connection: MachineConnection, required = false): Promise<void> {
    const record = connection.record;
    const write = connection.persist
      .then(() => this.settings.saveMachine(record))
      .then(() => undefined);
    connection.persist = write.catch((error: unknown) => {
      void this.debugLogs.write("machine-link.record.save-error", { machineId: record.id, message: errorMessage(error) });
    });
    return required ? write : connection.persist;
  }

  private async handleMessage(connection: MachineConnection, ciphertext: string): Promise<void> {
    const pinned = machineSigningKey(connection.record);
    const payload = await openMachinePayload(ciphertext, await this.options.eventLog.getOrCreateDeviceIdentity(),
      pinned ? [pinned] : undefined, connection.pairing.rendezvousId);
    if (!isMachineLinkEnvelope(payload)) return;
    if (!pinned && payload.body.type !== "machine.hello") {
      throw new Error("A new machine must introduce its identity before sending anything else.");
    }
    const hello = payload.body.type === "machine.hello" ? payload.body : undefined;
    const from = connection.record.deviceId || hello?.deviceId;
    const key = pinned ?? hello?.publicKeyDerBase64;
    if (!from || !key || !verifyMachineControl(payload, { from, publicKeyDerBase64: key, to: this.options.desktopDeviceId, room: connection.pairing.rendezvousId })) {
      throw new Error("A machine's messages carry its signing identity.");
    }
    if (this.seenMessageIds.has(payload.messageId)) return;
    this.seenMessageIds.add(payload.messageId);
    if (this.seenMessageIds.size > 10_000) {
      const first = this.seenMessageIds.values().next().value;
      if (first) this.seenMessageIds.delete(first);
    }
    await this.handleBody(connection, payload.body);
  }

  private async handleBody(connection: MachineConnection, body: MachineLinkMessage): Promise<void> {
    switch (body.type) {
      case "machine.hello":
        await this.handleHello(connection, body);
        return;
      case "machine.turn.progress.delta":
        this.receiveProgress(connection, body);
        return;
      case "machine.member.background":
        if (typeof body.conversationId !== "string" || typeof body.participantId !== "string" || !Array.isArray(body.labels)) return;
        this.emitMemberBackground({
          machineId: connection.record.id,
          member: { conversationId: body.conversationId, participantId: body.participantId, labels: cleanBackgroundLabels(body.labels) }
        });
        return;
      case "machine.member.background.snapshot":
        if (!Array.isArray(body.members)) return;
        this.emitMemberBackground({
          machineId: connection.record.id,
          snapshot: body.members
            .filter((member) => member && typeof member.conversationId === "string" && typeof member.participantId === "string" && Array.isArray(member.labels))
            .slice(0, 500)
            .map((member) => ({ conversationId: member.conversationId, participantId: member.participantId, labels: cleanBackgroundLabels(member.labels) }))
        });
        return;
      case "machine.turn.suggestion":
        if (typeof body.suggestion !== "string" || typeof body.participantId !== "string" || typeof body.runId !== "string") return;
        for (const listener of this.suggestionListeners) {
          listener({ machineId: connection.record.id, conversationId: body.conversationId, runId: body.runId, participantId: body.participantId, suggestion: body.suggestion });
        }
        return;
      case "machine.scripts.result": {
        const pending = connection.pendingScripts.get(body.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          connection.pendingScripts.delete(body.requestId);
          if (body.ok) pending.resolve(body.result);
          else pending.reject(new Error(body.error || "The machine refused."));
        }
        return;
      }
      case "machine.scripts.changed":
        for (const listener of this.scriptsChangedListeners) {
          try { listener(connection.record.id); } catch { /* a listener failure never breaks the link */ }
        }
        return;
      case "machine.attachment.request":
        // Served off the inbound chain: reading a chat and sending a picture
        // takes seconds on a large chat, and live progress must not wait.
        void this.answerAttachmentRequest(connection, body);
        return;
      default:
        return;
    }
  }

  /** One live progress frame of a member on this machine: decoded against the
   *  run's stream so far, and shown. A frame whose base was missed (this
   *  desktop reconnected mid-stream) waits for the next whole one: the machine
   *  starts every run's stream anew for a desktop that greets it. */
  private receiveProgress(connection: MachineConnection, frame: MachineProgressFrame): void {
    if (!frame || typeof frame.runId !== "string" || typeof frame.streamId !== "string" || !Number.isSafeInteger(frame.sequence)) return;
    const current = connection.progress.get(frame.runId);
    if (current && current.streamId === frame.streamId && frame.sequence <= current.sequence) return;
    const base = current && current.streamId === frame.streamId && frame.sequence === current.sequence + 1 ? current.progress : undefined;
    let progress: ReviewProgress;
    try {
      progress = decodeMachineProgress(base, frame);
    } catch {
      return;
    }
    const terminal = progress.phase === "done" || progress.phase === "error" || progress.phase === "cancelled" || progress.agentProgress?.state === "finished";
    connection.progress.delete(frame.runId);
    if (!terminal) {
      connection.progress.set(frame.runId, { streamId: frame.streamId, sequence: frame.sequence, progress });
      while (connection.progress.size > LIVE_PROGRESS_RUNS_MAX) connection.progress.delete(connection.progress.keys().next().value as string);
    }
    for (const listener of this.progressListeners) {
      try { listener(progress); } catch (error) {
        void this.debugLogs.write("machine-link.progress.listener-error", { machineId: connection.record.id, message: errorMessage(error) });
      }
    }
  }

  private async handleHello(connection: MachineConnection, hello: MachineHelloBody): Promise<void> {
    // A hello from an instance older than one already seen (the old process
    // saying goodbye late) is ignored, when both carry the start counter.
    const stale = typeof hello.instanceSequence === "number" && typeof connection.latestInstanceSequence === "number"
      && hello.instanceSequence < connection.latestInstanceSequence;
    if (stale) {
      void this.debugLogs.write("machine-link.hello.stale-instance", { machineId: connection.record.id, instanceId: hello.instanceId, instanceSequence: hello.instanceSequence });
      return;
    }
    if (!hello.publicKeyDerBase64) throw new Error("This machine must introduce its signing key.");
    if (connection.record.deviceId && connection.record.deviceId !== hello.deviceId) {
      throw new Error("The machine's enrolled device identity changed; its history cannot be accepted as the previous machine.");
    }
    const keyChanged = machineSigningKey(connection.record) !== hello.publicKeyDerBase64 || connection.record.deviceId !== hello.deviceId;
    if (typeof hello.instanceSequence === "number") connection.latestInstanceSequence = hello.instanceSequence;
    connection.machineDeviceId = hello.deviceId;
    connection.helloSeen = true;
    if (connection.helloRequestTimer) {
      clearTimeout(connection.helloRequestTimer);
      connection.helloRequestTimer = undefined;
    }
    const { type: _type, ...rest } = hello;
    connection.record = {
      ...connection.record,
      deviceId: hello.deviceId,
      lastSeenAt: this.now().toISOString(),
      lastHello: rest
    };
    await this.persistRecord(connection, true);
    if (this.options.desktopDeviceId === connection.pairing.issuer.originId) {
      await this.send(connection, { type: "machine.hello.ack", desktopDeviceId: this.options.desktopDeviceId, appVersion: this.options.appVersion,
        machineId: connection.record.id, machineName: connection.record.name });
      if (keyChanged) this.options.onDevicesChanged?.();
      // A runtime that greets while its turns are held (the new one an update
      // started) holds them too until the update is done.
      this.sendTurnHold(connection.record.id);
      // Its settings on the server, sealed for the key it greeted with.
      void this.syncSettings().catch((error: unknown) => {
        void this.debugLogs.write("machine-link.settings.sync-error", { machineId: connection.record.id, message: errorMessage(error) });
      });
    }
    this.emitStatus();
    // Machine setup waits for a hello that arrives AFTER it restarted the
    // runtime, and checks the version it reports.
    this.emitter.emit("hello", { machineId: connection.record.id, appVersion: hello.appVersion, deviceId: hello.deviceId, solicited: Boolean(connection.activityProbe) });
  }

  /** The bytes of a picture a machine asked for. Answered either way: a
   *  refusal tells the member the picture is unavailable, where silence would
   *  leave it waiting out its turn. Sent in bounded parts. */
  private async answerAttachmentRequest(connection: MachineConnection, body: MachineAttachmentRequestBody): Promise<void> {
    const reply = { type: "machine.attachment.result" as const, requestId: body.requestId,
      conversationId: body.conversationId, attachmentId: body.attachmentId };
    try {
      if (!this.options.readChatAttachment) throw new Error("This desktop cannot read chat pictures.");
      const conversation = await this.conversationLoader?.(body.conversationId);
      if (!conversation || conversation.kind !== "chat") throw new Error("This chat is not on this desktop.");
      const read = await this.options.readChatAttachment({ conversationId: body.conversationId, attachmentId: body.attachmentId });
      const bytes = Buffer.from(read.dataBase64, "base64");
      const parts = Math.max(1, Math.ceil(bytes.length / MACHINE_ATTACHMENT_PART_BYTES));
      for (let part = 0; part < parts; part += 1) {
        const slice = bytes.subarray(part * MACHINE_ATTACHMENT_PART_BYTES, (part + 1) * MACHINE_ATTACHMENT_PART_BYTES);
        await this.send(connection, { ...reply, ok: true, part, parts, dataBase64: slice.toString("base64"),
          ...(part === 0 && read.attachment?.mimeType ? { mediaType: read.attachment.mimeType } : {}),
          ...(part === 0 && read.attachment?.filename ? { fileName: read.attachment.filename } : {}) });
      }
    } catch (error) {
      void this.debugLogs.write("machine-link.attachment.refused", { machineId: connection.record.id,
        conversationId: body.conversationId, attachmentId: body.attachmentId, message: errorMessage(error) });
      await this.send(connection, { ...reply, ok: false, error: errorMessage(error) }).catch(() => undefined);
    }
  }

  private emitMemberBackground(event: MachineMemberBackgroundEvent): void {
    for (const listener of this.backgroundListeners) {
      try { listener(event); } catch (error) {
        void this.debugLogs.write("machine-link.background.listener-error", { machineId: event.machineId, message: errorMessage(error) });
      }
    }
  }

  private setMachinePeer(connection: MachineConnection, deviceId: string | undefined): void {
    const changed = connection.machineDeviceId !== deviceId;
    if (!deviceId) {
      if (connection.machineDeviceId) this.emitMemberBackground({ machineId: connection.record.id, snapshot: [] });
      connection.machineDeviceId = undefined;
      // Whatever greeted this connection before, a return is greeted again.
      connection.helloSeen = false;
      connection.progress.clear();
      this.rejectPendingScripts(connection, `${connection.record.name} disconnected.`);
    } else if (!connection.machineDeviceId) {
      connection.machineDeviceId = deviceId;
      this.greetReturningMachine(connection);
    }
    if (changed) this.emitStatus();
  }

  /** The machine's new connection took the seat of one the server had not
   *  seen close (it restarted, or its link came back). */
  private machineReturned(connection: MachineConnection): void {
    connection.helloSeen = false;
    connection.progress.clear();
    this.greetReturningMachine(connection);
  }

  private greetReturningMachine(connection: MachineConnection): void {
    // Back on the link: ask for the members' background work running now.
    void this.send(connection, { type: "machine.member.background.request" }).catch(() => undefined);
    if (!connection.helloSeen && !connection.helloRequestTimer) {
      // The machine is there; if it does not greet this connection by itself
      // shortly, ask for the hello.
      connection.helloRequestTimer = setTimeout(() => {
        connection.helloRequestTimer = undefined;
        if (connection.helloSeen || !connection.machineDeviceId) return;
        void this.debugLogs.write("machine-link.hello.requested", { machineId: connection.record.id });
        void this.send(connection, { type: "machine.hello.request", desktopDeviceId: this.options.desktopDeviceId }).catch(() => undefined);
      }, HELLO_REQUEST_GRACE_MS);
      connection.helloRequestTimer.unref?.();
    }
  }

  private send(connection: MachineConnection, body: MachineLinkMessage): Promise<void> {
    const send = connection.outbound.then(() => this.sendNow(connection, body));
    connection.outbound = send.catch(() => undefined);
    return send;
  }

  private async sendNow(connection: MachineConnection, body: MachineLinkMessage): Promise<void> {
    const to = connection.machineDeviceId;
    if (!to) throw new Error(`${connection.record.name} is not connected.`);
    const envelope: MachineLinkEnvelope = {
      protocol: MACHINE_LINK_PROTOCOL,
      messageId: randomUUID(),
      sentAt: this.now().toISOString(),
      body
    };
    const identity = await this.options.eventLog.getOrCreateDeviceIdentity();
    const signed = signMachineControl(envelope, identity, connection.pairing.rendezvousId, to);
    const peerKey = machineSigningKey(connection.record);
    if (!peerKey) {
      // Only a greeting request may use the enrollment's own seal, before the
      // machine's key is known. Nothing else is included.
      if (body.type !== "machine.hello.request") throw new Error("The machine must introduce its identity first.");
      const ciphertext = await sealChannelPayload(signed, connection.pairing.relaySealKeyBase64);
      await connection.client.sendCiphertext({ logicalMessageId: envelope.messageId, ciphertext, to });
      return;
    }
    const ciphertext = await sealMachinePayload(signed, identity, peerKey, connection.pairing.rendezvousId);
    await connection.client.sendCiphertext({ logicalMessageId: envelope.messageId, ciphertext, to });
  }

  private emitStatus(): void {
    this.emitter.emit("status", this.status());
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The part of a settings snapshot a machine uses; the export time is not. */
function machineSettingsKey(snapshot: MachineSettingsSnapshot): string {
  return JSON.stringify([snapshot.settingsJson, snapshot.agentEnvironment]);
}

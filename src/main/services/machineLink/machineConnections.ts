import { EventEmitter } from "node:events";
import type { MachineLinkStatus, MachineRecord } from "../../../shared/machineLink";
import type { MobilePairingPackage } from "../../../shared/mobilePairing";
import type { MachineRecoveryLinkState } from "../machineRecovery";
import { HELLO_REQUEST_GRACE_MS } from "./constants";
import { errorMessage } from "./linkText";
import { rejectPendingScripts } from "./scriptRequests";
import type { MachineConnection } from "./types";
import type { MachineLinkModules } from "./modules";
import type { MachineLinkDependencies } from "./dependencies";

/** The machines this computer is connected to. */
export class MachineConnections {
  readonly emitter = new EventEmitter();
  readonly connections = new Map<string, MachineConnection>();
  /** Every enrolled machine, read from settings before any connects. */
  readonly enrolled = new Map<string, MachineRecord>();
  closed = false;

  constructor(
    private readonly link: Pick<MachineLinkModules, "machineMessages" | "settingsPublication" | "turnHolds">,
    private readonly deps: Pick<MachineLinkDependencies, "debugLogs" | "options" | "settings">
  ) {}

  onStatus(listener: (status: MachineLinkStatus[]) => void): () => void {
    this.emitter.on("status", listener);
    return () => this.emitter.off("status", listener);
  }

  /** Reads the enrolled machines, so the server's roster names them before
   *  any chat activity. */
  async loadMachines(): Promise<void> {
    for (const record of await this.deps.settings.listMachines()) {
      if (!this.connections.has(record.id)) this.enrolled.set(record.id, record);
    }
  }

  async start(): Promise<void> {
    this.closed = false;
    const machines = await this.deps.settings.listMachines();
    for (const record of machines) if (!this.connections.has(record.id)) this.enrolled.set(record.id, record);
    void this.deps.debugLogs.write("machine-link.start", { machines: machines.length, desktopDeviceId: this.deps.options.desktopDeviceId });
    for (const record of machines) {
      await this.connectMachine(record).catch((error) => {
        void this.deps.debugLogs.write("machine-link.connect.error", { machineId: record.id, message: errorMessage(error) });
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
    const pairing = pairingOverride ?? await this.deps.settings.getMachinePairing(record.pairingKey);
    if (!pairing) throw new Error(`Machine ${record.name} has no pairing package.`);
    // A machine is reached in its room on the User's server, nowhere else.
    const client = pairing.hubUrl ? this.deps.options.createClient?.(pairing) : undefined;
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
      void this.deps.debugLogs.write("machine-link.peer", {
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
        .then(() => this.link.machineMessages.handleMessage(connection, message.ciphertext))
        .catch((error) => {
          void this.deps.debugLogs.write("machine-link.message.error", { machineId: record.id, message: errorMessage(error) });
        });
    });
    client.on("state", (state) => {
      if (this.connections.get(record.id) !== connection) return;
      void this.deps.debugLogs.write("machine-link.tunnel.state", { machineId: record.id, state });
      if (state !== "connected") this.setMachinePeer(connection, undefined);
    });
    client.on("error", (error) => {
      void this.deps.debugLogs.write("machine-link.tunnel.error", { machineId: record.id, message: error.message });
    });
    await client.connect().catch((error) => {
      void this.deps.debugLogs.write("machine-link.connect.retrying", { machineId: record.id, message: errorMessage(error) });
    });
  }

  /** Closes a machine's connection. It stays enrolled until `forgetMachine`. */
  async disconnectMachine(machineId: string): Promise<void> {
    const connection = this.connections.get(machineId);
    if (!connection) return;
    this.enrolled.set(machineId, connection.record);
    this.connections.delete(machineId);
    if (connection.helloRequestTimer) clearTimeout(connection.helloRequestTimer);
    rejectPendingScripts(connection, "The machine was removed.");
    connection.client.close();
    this.link.machineMessages.emitMemberBackground({ machineId, snapshot: [] });
    this.emitStatus();
  }

  /** The machine is no longer enrolled: removed from the app. */
  async forgetMachine(machineId: string): Promise<void> {
    await this.disconnectMachine(machineId);
    this.enrolled.delete(machineId);
    this.link.settingsPublication.publishedSettings.delete(machineId);
  }

  close(): void {
    this.closed = true;
    if (this.link.turnHolds.turnHoldTimer) clearInterval(this.link.turnHolds.turnHoldTimer);
    this.link.turnHolds.turnHoldTimer = undefined;
    for (const connection of this.connections.values()) {
      if (connection.helloRequestTimer) clearTimeout(connection.helloRequestTimer);
      connection.client.close();
    }
    this.connections.clear();
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

  machineRecord(machineId: string): MachineRecord | undefined {
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
    await this.link.settingsPublication.persistRecord(connection, true);
    void this.deps.debugLogs.write("machine-link.identity.adopted", { machineId, deviceId: identity.originId });
    this.deps.options.onDevicesChanged?.();
    await this.link.settingsPublication.syncSettings().catch((error: unknown) => {
      void this.deps.debugLogs.write("machine-link.settings.sync-error", { machineId, message: errorMessage(error) });
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
          void this.deps.debugLogs.write("machine-link.wait.version-mismatch", { machineId, expected: expectAppVersion, reported: event.appVersion ?? "" });
          return;
        }
        finish(true);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      timer.unref?.();
      this.emitter.on("hello", onHello);
    });
  }

  private setMachinePeer(connection: MachineConnection, deviceId: string | undefined): void {
    const changed = connection.machineDeviceId !== deviceId;
    if (!deviceId) {
      if (connection.machineDeviceId) this.link.machineMessages.emitMemberBackground({ machineId: connection.record.id, snapshot: [] });
      connection.machineDeviceId = undefined;
      // Whatever greeted this connection before, a return is greeted again.
      connection.helloSeen = false;
      connection.progress.clear();
      rejectPendingScripts(connection, `${connection.record.name} disconnected.`);
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
    void this.link.machineMessages.send(connection, { type: "machine.member.background.request" }).catch(() => undefined);
    if (!connection.helloSeen && !connection.helloRequestTimer) {
      // The machine is there; if it does not greet this connection by itself
      // shortly, ask for the hello.
      connection.helloRequestTimer = setTimeout(() => {
        connection.helloRequestTimer = undefined;
        if (connection.helloSeen || !connection.machineDeviceId) return;
        void this.deps.debugLogs.write("machine-link.hello.requested", { machineId: connection.record.id });
        void this.link.machineMessages.send(connection, { type: "machine.hello.request", desktopDeviceId: this.deps.options.desktopDeviceId }).catch(() => undefined);
      }, HELLO_REQUEST_GRACE_MS);
      connection.helloRequestTimer.unref?.();
    }
  }

  emitStatus(): void {
    this.emitter.emit("status", this.status());
  }
}

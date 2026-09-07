/**
 * A machine's connections to the owner's other devices.
 *
 * Everything a machine is asked to do arrives as a signed device event on a
 * sealed channel. There used to be exactly one such channel, to the desktop
 * that enrolled the machine, so with that desktop closed nothing could reach
 * it. This holds one channel per device in the trust roster instead.
 *
 * Two shapes of connection, both over the same relay and the same event
 * protocol:
 *
 * - Devices that come to this machine (the owner's desktops, the phone) are
 *   met in this machine's own room, on the connection it already has.
 * - Another machine is reached in *its* room, so a second connection is
 *   opened to it — this is how a member here asks a member there with no
 *   desktop involved.
 *
 * A device that is not in the roster gets no channel, so its packets are
 * dropped before any signature or command is considered.
 */
import { randomUUID } from "node:crypto";
import { stableJson } from "../../shared/stableJson";
import type { ChatEventEnvelope } from "../../shared/chatEvents";
import type { DeviceEventApplyOutcome } from "../../shared/deviceEventDelivery";
import type { DeviceEventPacket } from "../../shared/deviceEventChannel";
import { isDeviceEventPacket } from "../../shared/deviceEventChannel";
import type { MobilePairingPackage } from "../../shared/mobilePairing";
import type { TrustedPeerAccess } from "../../shared/machineTrust";
import { DeviceEventChannel, type DeferredWithDependency } from "./deviceEventChannel";
import type { ChatEventLogService } from "./chatEventLog";
import type { RelayTunnelClient } from "./relayTunnelClient";
import { deriveMachineChannelKey } from "../../shared/machineChannelKey";
import { openMachineRelayPayload, sealMachineRelayPayload } from "./machineRelaySealing";
import type { StorageService } from "./storage";

export interface MachinePeerFabricOptions {
  selfDeviceId: string;
  storage: StorageService;
  eventLog: ChatEventLogService;
  /** This machine's own room: where the owner's devices come to reach it. */
  home: MobilePairingPackage;
  /** The live connection to the home room, owned by the caller. */
  homeClient: RelayTunnelClient;
  /** Opens a connection to another device's room (another machine). */
  createClient(room: { relayUrl: string; rendezvousId: string; sealKeyBase64: string; fingerprint?: string }): RelayTunnelClient;
  isPeerConnected(deviceId: string): boolean;
  apply(event: ChatEventEnvelope, payload: unknown, peer: TrustedPeerAccess): Promise<DeviceEventApplyOutcome | "deferred" | DeferredWithDependency>;
  serveDependency?(dependency: { targetKey: string; stateId: string }): Promise<boolean>;
  onDependencyUnavailable?(dependency: { targetKey: string; stateId: string }): void;
  onError(error: Error): void;
  logger(event: string, payload: Record<string, unknown>): void;
}

/** How often a machine re-offers what it still owes to each trusted device. */
const SHARE_INTERVAL_MS = 2_000;

interface PeerConnection {
  peer: TrustedPeerAccess;
  channel: DeviceEventChannel;
  /** Undefined for peers met in this machine's own room. */
  client?: RelayTunnelClient;
}

export class MachinePeerFabric {
  private readonly connections = new Map<string, PeerConnection>();
  private readonly rooms = new Map<string, RelayTunnelClient>();
  private started = false;
  private shareTimer?: ReturnType<typeof setInterval>;
  private sharing?: Promise<void>;

  constructor(private readonly options: MachinePeerFabricOptions) {}

  /** Channels for the peers this fabric currently trusts. */
  peerDeviceIds(): string[] {
    return [...this.connections.keys()];
  }

  channel(deviceId: string): DeviceEventChannel | undefined {
    return this.connections.get(deviceId)?.channel;
  }

  /** The room a peer's channel speaks in. A delivery row has to name the same
   *  room the channel flushes, or nothing is ever sent. */
  roomFor(deviceId: string): string | undefined {
    const connection = this.connections.get(deviceId);
    return connection ? this.channelIdFor(connection.peer) : undefined;
  }

  /** Everyone a result should be delivered to, as outbox recipients. */
  recipients(): Array<{ deviceId: string; channelId: string }> {
    return [...this.connections.values()].map((connection) => ({
      deviceId: connection.peer.deviceId,
      channelId: this.channelIdFor(connection.peer)
    }));
  }

  start(): void {
    this.started = true;
    for (const connection of this.connections.values()) connection.channel.start();
    // Whatever this machine still owes anyone in a room is owed to every
    // trusted device in it. Keeping that true on a timer, rather than only at
    // the moment an event is published, is what makes it independent of which
    // device happened to be known when a turn started.
    this.shareTimer ??= setInterval(() => { void this.shareOutstanding(); }, SHARE_INTERVAL_MS);
    this.shareTimer.unref?.();
    void this.shareOutstanding();
  }

  close(): void {
    this.started = false;
    if (this.shareTimer) clearInterval(this.shareTimer);
    this.shareTimer = undefined;
    for (const connection of this.connections.values()) connection.channel.close();
    for (const client of this.rooms.values()) client.close();
    this.rooms.clear();
    this.connections.clear();
  }

  /**
   * Brings the connections in line with the roster: new devices get a channel,
   * devices that were taken off it lose theirs immediately.
   */
  async reconcile(peers: readonly TrustedPeerAccess[]): Promise<void> {
    const wanted = new Map(peers.filter((peer) => peer.deviceId !== this.options.selfDeviceId).map((peer) => [peer.deviceId, peer]));
    for (const [deviceId, connection] of this.connections) {
      if (!wanted.has(deviceId) || stableJson(wanted.get(deviceId)) !== stableJson(connection.peer)) {
        connection.channel.close();
        this.connections.delete(deviceId);
        // A device taken off the roster stops being owed the room's history.
        // Leaving its rows in place would keep re-offering them on every
        // reconnect and serving them from the mailbox to a device the owner
        // has revoked. Nothing the remaining devices are owed is touched.
        const forgotten = wanted.has(deviceId) ? 0 : await this.options.storage.deviceEvents()
          .forgetRecipient(this.channelIdFor(connection.peer), deviceId)
          .catch(() => 0);
        this.options.logger("machine-host.trust.peer-removed", { deviceId, forgotten });
      }
    }
    for (const [key, client] of this.rooms) {
      if (![...this.connections.values()].some(connection => connection.client === client)) {
        client.close();
        this.rooms.delete(key);
      }
    }
    for (const peer of wanted.values()) {
      if (this.connections.has(peer.deviceId)) continue;
      const room = await this.meetingRoom(peer);
      let client: RelayTunnelClient | undefined;
      let connect = false;
      if (!room.here) {
        const key = `${room.relayUrl} ${room.rendezvousId}`;
        client = this.rooms.get(key);
        if (!client) {
          client = this.options.createClient({
            relayUrl: room.relayUrl,
            rendezvousId: room.rendezvousId,
            sealKeyBase64: room.sealKeyBase64,
            ...(room.fingerprint ? { fingerprint: room.fingerprint } : {})
          });
          this.rooms.set(key, client);
          let inbound: Promise<void> = Promise.resolve();
          client.on("message", (message) => {
            inbound = inbound.then(() => this.receiveSealed(message.ciphertext, room.rendezvousId)).catch((error) => {
              this.options.logger("machine-host.trust.receive-error", {
                rendezvousId: room.rendezvousId,
                message: error instanceof Error ? error.message : String(error)
              });
            });
          });
          client.on("error", (error) => { this.options.onError(error instanceof Error ? error : new Error(String(error))); });
          client.on("state", (state) => {
            this.options.logger("machine-host.trust.room-state", { rendezvousId: room.rendezvousId, state });
          });
          connect = true;
        }
      }
      this.connections.set(peer.deviceId, {
        peer,
        client,
        channel: this.buildChannel(peer, room, client)
      });
      if (connect) await client!.connect().catch((error) => {
        this.options.logger("machine-host.trust.connect-retrying", { rendezvousId: room.rendezvousId,
          message: error instanceof Error ? error.message : String(error) });
      });
      // Whatever this room still owes anyone is owed to this device too:
      // a result published while it was not yet trusted must still reach it.
      const shared = await this.options.storage.deviceEvents()
        .shareUnacknowledged(this.channelIdFor(peer), peer.deviceId)
        .catch(() => 0);
      this.options.logger("machine-host.trust.peer-added", {
        deviceId: peer.deviceId, role: peer.role, room: room.rendezvousId, pending: shared
      });
      if (this.started) this.connections.get(peer.deviceId)!.channel.start();
    }
  }

  /** Every trusted device gets a delivery row for everything its room has not
   *  acknowledged, and then a flush. Idempotent: rows are inserted or ignored. */
  private shareOutstanding(): Promise<void> {
    if (this.sharing) return this.sharing;
    const run = this.shareOutstandingNow();
    this.sharing = run;
    return run.finally(() => { if (this.sharing === run) this.sharing = undefined; });
  }

  private async shareOutstandingNow(): Promise<void> {
    for (const connection of this.connections.values()) {
      try {
        const pending = await this.options.storage.deviceEvents()
          .shareUnacknowledged(this.channelIdFor(connection.peer), connection.peer.deviceId);
        if (pending > 0) await connection.channel.flush();
      } catch (error) {
        this.options.logger("machine-host.trust.share-error", {
          deviceId: connection.peer.deviceId,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  /**
   * Hands an inbound packet to the channel of the device that sent it.
   * Returns false when nothing trusted claims it, which is what makes an
   * unknown device's traffic a no-op rather than an input.
   */
  async receive(packet: DeviceEventPacket): Promise<boolean> {
    const connection = this.connections.get(packet.from);
    if (!connection) {
      this.options.logger("machine-host.trust.rejected", { from: packet.from, type: packet.type });
      return false;
    }
    await connection.channel.receive(packet);
    return true;
  }

  private async receiveSealed(ciphertext: string, room: string): Promise<void> {
    const payload = await openMachineRelayPayload(ciphertext, await this.options.eventLog.getOrCreateDeviceIdentity(),
      [...this.connections.values()].map(connection => connection.peer.publicKeyDerBase64), room);
    if (isDeviceEventPacket(payload)) await this.receive(payload);
  }

  async openHomeFrame(ciphertext: string, _legacyRoomKey?: string): Promise<DeviceEventPacket | undefined> {
    try {
      const payload = await openMachineRelayPayload(ciphertext, await this.options.eventLog.getOrCreateDeviceIdentity(),
        [...this.connections.values()].map(connection => connection.peer.publicKeyDerBase64), this.options.home.rendezvousId);
      return isDeviceEventPacket(payload) ? payload : undefined;
    } catch { return undefined; }
  }

  /**
   * The room two devices meet in, decided the same way on both sides.
   *
   * A controller (a desktop, the phone) comes to this machine, so they meet
   * here. Two machines each own a room, so they agree on one of them by
   * device id — otherwise each would speak in its own room and neither would
   * recognise the other's scope.
   */
  private channelIdFor(peer: TrustedPeerAccess): string {
    if (peer.role !== "machine") return this.options.home.rendezvousId;
    return this.options.selfDeviceId < peer.deviceId ? this.options.home.rendezvousId : peer.rendezvousId;
  }

  /** The room, sealing key and capability a peer is met with. */
  private async meetingRoom(peer: TrustedPeerAccess): Promise<{ rendezvousId: string; relayUrl: string; sealKeyBase64: string; fingerprint?: string; here: boolean }> {
    const room = this.channelIdFor(peer);
    const here = room === this.options.home.rendezvousId;
    return {
      rendezvousId: room,
      relayUrl: here ? this.options.home.relayUrl ?? peer.relayUrl : peer.relayUrl,
      sealKeyBase64: deriveMachineChannelKey(await this.options.eventLog.getOrCreateDeviceIdentity(), peer.publicKeyDerBase64, room),
      fingerprint: here ? this.options.home.fingerprint : peer.fingerprint,
      here
    };
  }

  private buildChannel(
    peer: TrustedPeerAccess,
    room: { rendezvousId: string; relayUrl: string; sealKeyBase64: string; fingerprint?: string; here: boolean },
    client: RelayTunnelClient | undefined
  ): DeviceEventChannel {
    const send = async (packet: DeviceEventPacket): Promise<void> => {
      const ciphertext = await sealMachineRelayPayload(packet, await this.options.eventLog.getOrCreateDeviceIdentity(), peer.publicKeyDerBase64, room.rendezvousId);
      const transport = client ?? this.options.homeClient;
      await transport.sendCiphertext({ logicalMessageId: randomUUID(), ciphertext, to: peer.deviceId });
    };
    return new DeviceEventChannel({
      storage: this.options.storage,
      eventLog: this.options.eventLog,
      // The mailbox of the room this peer is met in, so a device that is not
      // online right now still receives what it was sent.
      pairing: { ...this.options.home, rendezvousId: room.rendezvousId, relaySealKeyBase64: room.sealKeyBase64,
        relayUrl: room.relayUrl, fingerprint: room.fingerprint ?? "",
        outboxUrl: room.here ? this.options.home.outboxUrl : peer.outboxUrl },
      channelId: this.channelIdFor(peer),
      localDeviceId: this.options.selfDeviceId,
      peerDeviceId: peer.deviceId,
      peerPublicKeyDerBase64: peer.publicKeyDerBase64,
      isPeerConnected: () => this.options.isPeerConnected(peer.deviceId),
      send,
      apply: (event, payload) => {
        if (this.connections.get(peer.deviceId)?.peer !== peer) throw new Error("Machine peer authorization changed.");
        return this.options.apply(event, payload, peer);
      },
      ...(this.options.serveDependency ? { serveDependency: this.options.serveDependency } : {}),
      ...(this.options.onDependencyUnavailable ? { onDependencyUnavailable: this.options.onDependencyUnavailable } : {}),
      onError: this.options.onError
    });
  }
}

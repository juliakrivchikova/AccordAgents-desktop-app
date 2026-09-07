/**
 * Who may command a machine, and how to reach them.
 *
 * A machine used to answer exactly one device: the desktop that enrolled it.
 * With that desktop closed, nothing could start a turn there, and a member on
 * one machine could not ask a member on another. The roster replaces that
 * single hard-coded peer with an explicit list of the owner's own devices.
 *
 * Every device owns a sealed relay room; to speak to a device you join its
 * room. A roster entry therefore carries both an identity (the device id and
 * the public key its events are signed with) and the way in (the room, and
 * the key that seals it). The owner's desktop is the only issuer: a machine
 * accepts a roster only inside the channel sealed and signed with the
 * enrollment it was installed with, so no peer can add itself.
 *
 * The seal key of a room is shared with the devices that need to reach it.
 * They are all the same person's devices, and the relay itself never holds a
 * key. A device outside the roster cannot authorize commands, even if it kept
 * a room seal from before removal; revoking its access to ciphertext also
 * requires rotating that seal.
 */

export type TrustedPeerRole = "desktop" | "phone" | "machine";

export interface TrustedPeerAccess {
  deviceId: string;
  publicKeyDerBase64: string;
  role: TrustedPeerRole;
  name?: string;
  /** The room this peer listens in, and the key that seals it. */
  relayUrl: string;
  rendezvousId: string;
  relaySealKeyBase64: string;
  outboxUrl?: string;
  /** The room's capability fingerprint: the relay admits a connection only
   *  when it presents the one the room was opened with. */
  fingerprint?: string;
  /** For a machine peer: the id members carry as `homeMachineId`. */
  machineId?: string;
}

export interface MachineTrustRoster {
  version: 1;
  /** The desktop that owns this installation; the only issuer of a roster. */
  issuerDeviceId: string;
  updatedAt: string;
  peers: TrustedPeerAccess[];
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isTrustedPeerAccess(value: unknown): value is TrustedPeerAccess {
  if (!value || typeof value !== "object") return false;
  const peer = value as Partial<TrustedPeerAccess>;
  return nonEmpty(peer.deviceId) && nonEmpty(peer.publicKeyDerBase64) && nonEmpty(peer.relayUrl)
    && nonEmpty(peer.rendezvousId) && nonEmpty(peer.relaySealKeyBase64)
    && (peer.role === "desktop" || peer.role === "phone" || peer.role === "machine");
}

export function isMachineTrustRoster(value: unknown): value is MachineTrustRoster {
  if (!value || typeof value !== "object") return false;
  const roster = value as Partial<MachineTrustRoster>;
  return roster.version === 1 && nonEmpty(roster.issuerDeviceId) && nonEmpty(roster.updatedAt)
    && Array.isArray(roster.peers) && roster.peers.every(isTrustedPeerAccess);
}

/** The roster as this machine should hold it. The enrollment separately keeps
 * its issuer trusted; duplicate identities are rejected before normalization. */
export function normalizeMachineTrustRoster(roster: MachineTrustRoster, selfDeviceId: string): MachineTrustRoster {
  const peers = new Map<string, TrustedPeerAccess>();
  for (const peer of roster.peers) {
    if (peer.deviceId === selfDeviceId) continue;
    peers.set(peer.deviceId, peer);
  }
  return { version: 1, issuerDeviceId: roster.issuerDeviceId, updatedAt: roster.updatedAt, peers: [...peers.values()] };
}

/** Rooms to join, with the peers expected in each. A device is reached in its
 *  own room, so several peers can share one connection. */
export function trustedPeerRooms(peers: readonly TrustedPeerAccess[]): Array<{
  relayUrl: string;
  rendezvousId: string;
  relaySealKeyBase64: string;
  fingerprint?: string;
  peers: TrustedPeerAccess[];
}> {
  const rooms = new Map<string, {
    relayUrl: string;
    rendezvousId: string;
    relaySealKeyBase64: string;
    fingerprint?: string;
    peers: TrustedPeerAccess[];
  }>();
  for (const peer of peers) {
    const key = `${peer.relayUrl} ${peer.rendezvousId}`;
    const room = rooms.get(key) ?? {
      relayUrl: peer.relayUrl,
      rendezvousId: peer.rendezvousId,
      relaySealKeyBase64: peer.relaySealKeyBase64,
      ...(peer.fingerprint ? { fingerprint: peer.fingerprint } : {}),
      peers: []
    };
    room.peers.push(peer);
    rooms.set(key, room);
  }
  return [...rooms.values()];
}

/**
 * A device the owner has said may use their machines, as this desktop stores
 * it. The room is not part of it: a device is met in the room of whichever
 * machine it is talking to, so that is filled in per machine when the roster
 * is sent.
 */
export interface TrustedDeviceRecord {
  deviceId: string;
  publicKeyDerBase64: string;
  role: TrustedPeerRole;
  name: string;
  addedAt: string;
  /**
   * The key this device's own frames are sealed with.
   *
   * Every trusted device used to be handed the machine room's single seal key,
   * so removing one from the roster ended its authority and left it able to
   * read everything the others were sent. A key per device means a revoked
   * device never held the others' in the first place: there is nothing to
   * rotate, and no device that stayed has to do anything.
   *
   * Optional only for records written before this existed; those are given one
   * the next time they are read.
   */
  channelSealKeyBase64?: string;
}

export function isTrustedDeviceRecord(value: unknown): value is TrustedDeviceRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<TrustedDeviceRecord>;
  return nonEmpty(record.deviceId) && nonEmpty(record.publicKeyDerBase64) && nonEmpty(record.name)
    && nonEmpty(record.addedAt)
    && (record.role === "desktop" || record.role === "phone" || record.role === "machine");
}

/** A device id is derived from its public key, so a record whose id does not
 *  match the key it carries is not the device it claims to be. */
export function trustedDeviceIdMatchesKey(record: { deviceId: string; publicKeyDerBase64: string }, sha256Hex: (bytes: Uint8Array) => string): boolean {
  const bytes = Uint8Array.from(Buffer.from(record.publicKeyDerBase64, "base64"));
  return record.deviceId === `device-${sha256Hex(bytes).slice(0, 32)}`;
}

import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import type { DeviceEventPacket } from "../../shared/deviceEventChannel";
import { stableJson } from "../../shared/stableJson";
import type { ChatEventDeviceIdentityRecord } from "./storage";

/** Untrusted bytes are not a retryable local persistence failure. */
export class DevicePacketAuthenticationError extends Error {}

function bytes(packet: DeviceEventPacket): Buffer {
  const { signature: _signature, ...unsigned } = packet;
  return Buffer.from(`accord-device-packet-v1:${stableJson(unsigned)}`);
}

/** ACKs can release retained history, so a shared room key is insufficient:
 * they must be authenticated as the particular device that applied the event. */
export function signDevicePacket(packet: DeviceEventPacket, identity: ChatEventDeviceIdentityRecord): DeviceEventPacket {
  if (packet.from !== identity.originId) throw new Error("Cannot sign another device's packet.");
  const signature = sign(null, bytes(packet), createPrivateKey({ key: Buffer.from(identity.privateKeyDerBase64, "base64"),
    format: "der", type: "pkcs8" })).toString("base64");
  return { ...packet, signature };
}

export function verifyDevicePacket(packet: DeviceEventPacket, publicKeyDerBase64: string): boolean {
  try {
    return typeof packet.signature === "string" && verify(null, bytes(packet),
      createPublicKey({ key: Buffer.from(publicKeyDerBase64, "base64"), format: "der", type: "spki" }),
      Buffer.from(packet.signature, "base64"));
  } catch { return false; }
}

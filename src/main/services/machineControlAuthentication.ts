import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import type { MachineLinkEnvelope } from "../../shared/machineLink";
import { stableJson } from "../../shared/stableJson";
import type { ChatEventDeviceIdentityRecord } from "./storage";

interface ControlAuthentication {
  from: string;
  to: string;
  room: string;
  publicKeyDerBase64: string;
  signature: string;
}
type SignedControl = MachineLinkEnvelope & { authentication: ControlAuthentication };

export function machineControlSender(envelope: MachineLinkEnvelope): string | undefined {
  const from = (envelope as Partial<SignedControl>).authentication?.from;
  return typeof from === "string" ? from : undefined;
}

/** The room's shared seal permits transport; it cannot grant the authority of
 * another device. Presence uses the same signing identity as durable events. */
export function signMachineControl(envelope: MachineLinkEnvelope, identity: ChatEventDeviceIdentityRecord, room: string, to: string): SignedControl {
  const unsigned = { ...envelope, authentication: { from: identity.originId, to, room, publicKeyDerBase64: identity.publicKeyDerBase64 } };
  const signature = sign(null, Buffer.from(stableJson(unsigned)), createPrivateKey({
    key: Buffer.from(identity.privateKeyDerBase64, "base64"), format: "der", type: "pkcs8"
  })).toString("base64");
  return { ...unsigned, authentication: { ...unsigned.authentication, signature } };
}

export function verifyMachineControl(envelope: MachineLinkEnvelope, expected: { from: string; to: string; room: string; publicKeyDerBase64: string }): boolean {
  try {
    const auth = (envelope as Partial<SignedControl>).authentication;
    if (!auth || auth.from !== expected.from || auth.to !== expected.to || auth.room !== expected.room ||
        auth.publicKeyDerBase64 !== expected.publicKeyDerBase64 || typeof auth.signature !== "string") return false;
    const key = Buffer.from(auth.publicKeyDerBase64, "base64");
    if (auth.from !== `device-${createHash("sha256").update(key).digest("hex").slice(0, 32)}`) return false;
    const { signature, ...unsignedAuth } = auth;
    return verify(null, Buffer.from(stableJson({ ...envelope, authentication: unsignedAuth })),
      createPublicKey({ key, format: "der", type: "spki" }), Buffer.from(signature, "base64"));
  } catch { return false; }
}

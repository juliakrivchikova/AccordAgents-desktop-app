import { assertMobilePairingPackage, type MobilePairingPackage } from "./mobilePairing";

/** SSH proves access to the installation; its enrollment must additionally
 * belong to this desktop identity before we restore any connection secrets. */
export function assertRecoverableMachineEnrollment(requested: unknown, installed: unknown): asserts installed is MobilePairingPackage {
  assertMobilePairingPackage(requested);
  assertMobilePairingPackage(installed);
  if (requested.purpose !== "machine-host" || installed.purpose !== "machine-host"
    || requested.issuer.originId !== installed.issuer.originId
    || requested.issuer.publicKeyDerBase64 !== installed.issuer.publicKeyDerBase64) {
    throw new Error("This installation belongs to another environment; nothing was replaced.");
  }
  if (!installed.relayUrl) throw new Error("The saved machine connection has no relay address.");
}

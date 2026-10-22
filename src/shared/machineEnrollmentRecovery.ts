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
  // A machine that talks only to the User's server is met there instead,
  // and only on the server this desktop uses now: reconnecting to another
  // (one set up before this one) would send its commands where nobody reads.
  if (!installed.relayUrl && !installed.hubUrl) throw new Error("The saved machine connection has neither a relay nor a server address.");
  if (installed.hubUrl && (!requested.hubUrl || serverOrigin(installed.hubUrl) !== serverOrigin(requested.hubUrl))) {
    throw new Error("This installation talks to another server than the one this desktop uses; nothing was replaced.");
  }
}

function serverOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

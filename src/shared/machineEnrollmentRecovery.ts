import { assertMobilePairingPackage, type MobilePairingPackage } from "./mobilePairing";

/**
 * The enrollment an installation found over SSH is restored with: SSH proves
 * access to the installation, and its enrollment must additionally belong to
 * this desktop identity before any connection secret is restored.
 *
 * A machine talks only to the User's server, and only to the one this
 * desktop uses now: reconnecting to another (one set up before this one)
 * would send its commands where nobody reads them. An installation set up
 * for the shared relay keeps its identity (its room, its key, the id its
 * members carry) and meets this desktop on the User's server from now on:
 * what is returned names that server and nothing of the relay, and is what
 * the installer writes to the machine.
 */
export function recoverableMachineEnrollment(requested: unknown, installed: unknown): MobilePairingPackage {
  assertMobilePairingPackage(requested);
  assertMobilePairingPackage(installed);
  if (requested.purpose !== "machine-host" || installed.purpose !== "machine-host"
    || requested.issuer.originId !== installed.issuer.originId
    || requested.issuer.publicKeyDerBase64 !== installed.issuer.publicKeyDerBase64) {
    throw new Error("This installation belongs to another environment; nothing was replaced.");
  }
  if (!requested.hubUrl || (installed.hubUrl && serverOrigin(installed.hubUrl) !== serverOrigin(requested.hubUrl))) {
    throw new Error("This installation talks to another server than the one this desktop uses; nothing was replaced.");
  }
  if (installed.hubUrl) return installed;
  const { version, purpose, issuer, rendezvousId, stableRoutingId, relaySealKeyBase64, capabilities, fingerprint, createdAt, expiresAt } = installed;
  return { version, purpose, issuer, rendezvousId, stableRoutingId, relaySealKeyBase64, hubUrl: requested.hubUrl, capabilities, fingerprint, createdAt, expiresAt };
}

/** The same check for an enrollment already in the server's form, as the
 *  desktop stores and connects it. */
export function assertRecoverableMachineEnrollment(requested: unknown, installed: unknown): asserts installed is MobilePairingPackage {
  const restored = recoverableMachineEnrollment(requested, installed);
  if (restored !== installed) {
    throw new Error("This installation was set up for the shared relay; set it up again with Cloud run to move it to your server.");
  }
}

function serverOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

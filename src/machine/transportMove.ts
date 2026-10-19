// A machine moving to another relay address (the User's own server): its
// enrollment file is rewritten in one step, and the runtime starts again.
import { readFileSync } from "node:fs";
import { chmod, rename, writeFile } from "node:fs/promises";
import { assertMobilePairingPackage, type MobilePairingPackage } from "../shared/mobilePairing";

/** The enrollment with the relay's new addresses, replaced in one step: a
 *  machine stopped half way keeps the old file, never half of each. It holds
 *  the pairing's seal key, so it stays readable by this account only. */
export async function moveEnrollment(enrollmentPath: string, addresses: { relayUrl: string; outboxUrl: string }): Promise<MobilePairingPackage> {
  const current = JSON.parse(readFileSync(enrollmentPath, "utf8")) as unknown;
  assertMobilePairingPackage(current);
  const next: MobilePairingPackage = { ...current, relayUrl: addresses.relayUrl, outboxUrl: addresses.outboxUrl };
  assertMobilePairingPackage(next);
  const temp = `${enrollmentPath}.moving`;
  await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, enrollmentPath);
  return next;
}

/** A command line for /bin/sh that runs exactly these arguments. */
export function shellCommandLine(parts: string[]): string {
  return parts.map((part) => `'${part.replace(/'/g, "'\\''")}'`).join(" ");
}

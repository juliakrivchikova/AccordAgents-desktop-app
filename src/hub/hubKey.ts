import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createDeviceIdentity } from "../main/services/deviceIdentity";

/** The server's own Ed25519 key: it proves to the devices that set it up and
 *  use it that they talk to this server (hubProofSigningText), whoever holds
 *  its address. Made once, kept beside its id, readable by the server only. */
export interface HubKey {
  publicKeyDerBase64: string;
  privateKeyDerBase64: string;
}

export function loadOrCreateHubKey(dir: string): HubKey {
  const file = path.join(dir, "hub-key.json");
  if (existsSync(file)) {
    const stored = JSON.parse(readFileSync(file, "utf8")) as Partial<HubKey>;
    if (typeof stored.publicKeyDerBase64 === "string" && typeof stored.privateKeyDerBase64 === "string") {
      return { publicKeyDerBase64: stored.publicKeyDerBase64, privateKeyDerBase64: stored.privateKeyDerBase64 };
    }
  }
  const made = createDeviceIdentity(new Date().toISOString());
  const key = { publicKeyDerBase64: made.publicKeyDerBase64, privateKeyDerBase64: made.privateKeyDerBase64 };
  // Not over an existing file: a key that could not be read is not replaced
  // silently (the devices that know it would refuse the new one).
  writeFileSync(file, JSON.stringify(key), { mode: 0o600, flag: existsSync(file) ? "w" : "wx" });
  return key;
}

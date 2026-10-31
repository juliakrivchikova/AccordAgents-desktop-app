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
    // Never replaced silently: the devices that know the key would refuse
    // the server from then on, with nothing to say why.
    throw new Error(`${file} does not hold the server's key; it is left as it is.`);
  }
  const made = createDeviceIdentity(new Date().toISOString());
  const key = { publicKeyDerBase64: made.publicKeyDerBase64, privateKeyDerBase64: made.privateKeyDerBase64 };
  writeFileSync(file, JSON.stringify(key), { mode: 0o600, flag: "wx" });
  return key;
}

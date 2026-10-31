import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import path from "node:path";
import { createDeviceIdentity } from "../main/services/deviceIdentity";

/** The server's own Ed25519 key: it proves to the devices that set it up and
 *  use it that they talk to this server (hubProofSigningText), whoever holds
 *  its address. Made once, kept beside its id, readable by the server only. */
export interface HubKey {
  publicKeyDerBase64: string;
  privateKeyDerBase64: string;
}

function readKey(file: string): HubKey | undefined {
  try {
    const stored = JSON.parse(readFileSync(file, "utf8")) as Partial<HubKey>;
    if (typeof stored.publicKeyDerBase64 === "string" && typeof stored.privateKeyDerBase64 === "string") {
      return { publicKeyDerBase64: stored.publicKeyDerBase64, privateKeyDerBase64: stored.privateKeyDerBase64 };
    }
  } catch {
    // Unreadable: said below.
  }
  return undefined;
}

/** Written whole or not at all (a full disk or a power cut never leaves half
 *  a key behind). */
function writeKey(file: string, key: HubKey): void {
  const temporary = `${file}.${process.pid}.tmp`;
  const handle = openSync(temporary, "wx", 0o600);
  try {
    writeSync(handle, JSON.stringify(key));
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  renameSync(temporary, file);
}

/**
 * The server's key, made the first time. A file that holds no key is never
 * replaced on its own (the devices that know the key would refuse the server
 * with nothing to say why): the server runs without proving itself, and the
 * devices say so. Only the owner setting the server up again over SSH
 * (`replaceUnreadable`) puts it aside and makes a new key, which that setup
 * then hands to the computer.
 */
export function loadOrCreateHubKey(dir: string, options: { replaceUnreadable?: boolean } = {}): HubKey {
  const file = path.join(dir, "hub-key.json");
  if (existsSync(file)) {
    const kept = readKey(file);
    if (kept) return kept;
    if (!options.replaceUnreadable) throw new Error(`${file} does not hold the server's key; it is left as it is.`);
    renameSync(file, `${file}.unreadable-${Date.now()}`);
  }
  const made = createDeviceIdentity(new Date().toISOString());
  const key = { publicKeyDerBase64: made.publicKeyDerBase64, privateKeyDerBase64: made.privateKeyDerBase64 };
  try {
    writeKey(file, key);
  } catch (error) {
    rmSync(`${file}.${process.pid}.tmp`, { force: true });
    throw error;
  }
  return key;
}

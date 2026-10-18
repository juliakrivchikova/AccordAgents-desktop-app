/**
 * Setting up the User's own hub: the command she runs once in Terminal with
 * her AWS administrator account (it creates the server), the line it prints,
 * and what the desktop does with that line (it installs the hub over SSH).
 */

/** What the setup command prints for the app; the rest is base64 JSON. */
export const HUB_SETUP_BLOB_PREFIX = "accord-hub-v1:";

/** The server the command created (or found): where it is and how to reach
 *  it. No secret: the key the desktop logs in with never leaves the desktop. */
export interface HubServerBlob {
  version: 1;
  region: string;
  instanceName: string;
  ip: string;
  user: string;
}

/** The server as the desktop remembers it after setup. */
export interface HubServerRecord extends HubServerBlob {
  installedAt?: string;
  /** The hub program version last installed there. */
  installedVersion?: string;
}

export type HubSetupPhase =
  | "connecting"
  | "preparing"
  | "uploading"
  | "starting"
  | "owner"
  | "chats"
  | "certificate"
  | "checking"
  | "ready"
  | "error";

/** What Settings shows about the hub. */
export interface HubSetupState {
  /** Nothing set up yet, an installation running, set up, or the last one failed. */
  status: "none" | "installing" | "ready" | "failed";
  phase?: HubSetupPhase;
  message?: string;
  /** The address the desktop syncs with, once set up. */
  url?: string;
  server?: HubServerRecord;
  /** The hub program version this app would install. */
  bundledVersion: string;
  updatedAt?: string;
}

export interface HubSetupCommandRequest {
  region: string;
}

export interface HubSetupCommandResult {
  command: string;
  region: string;
}

export interface HubInstallRequest {
  /** The line the setup command printed. */
  blob: string;
}

const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d$/;
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

export function isHubRegion(value: unknown): value is string {
  return typeof value === "string" && REGION.test(value);
}

/** Reads the setup command's line (with anything around it pasted too). */
export function parseHubServerBlob(text: string): HubServerBlob {
  const match = /accord-hub-v1:([A-Za-z0-9+/=_-]+)/.exec(text);
  if (!match) throw new Error(`Paste the line the command printed; it starts with ${HUB_SETUP_BLOB_PREFIX}`);
  let value: Partial<HubServerBlob>;
  try {
    value = JSON.parse(Buffer.from(match[1], "base64").toString("utf8")) as Partial<HubServerBlob>;
  } catch {
    throw new Error("The pasted line is incomplete; copy the whole line the command printed.");
  }
  if (value.version !== 1 || !isHubRegion(value.region) || typeof value.instanceName !== "string" || !NAME.test(value.instanceName) ||
      typeof value.ip !== "string" || !IPV4.test(value.ip) || typeof value.user !== "string" || !/^[a-z_][a-z0-9_-]{0,31}$/.test(value.user)) {
    throw new Error("The pasted line does not describe a server; run the command again and paste its last line.");
  }
  return { version: 1, region: value.region, instanceName: value.instanceName, ip: value.ip, user: value.user };
}

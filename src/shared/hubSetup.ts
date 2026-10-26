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
  /** Names the command this desktop issued, so a line from anywhere else
   *  (a message, a document) is not taken for it. */
  nonce?: string;
  /** The server's SSH host keys as AWS reports them ("<algorithm> <key>"):
   *  the desktop trusts exactly these instead of the first key it sees. */
  hostKeys?: string[];
}

/** The server as the desktop remembers it after setup. */
export interface HubServerRecord extends Omit<HubServerBlob, "nonce" | "hostKeys"> {
  installedAt?: string;
  /** The hub program version last installed there. */
  installedVersion?: string;
}

/** The hub this desktop syncs with, as settings keep it. */
export interface HubLinkConfig {
  url: string;
  hubId?: string;
  server?: HubServerRecord;
}

/** Setup's steps, in order. */
export const HUB_SETUP_STEPS = ["connecting", "preparing", "uploading", "owner", "chats", "starting", "certificate", "checking"] as const;
export type HubSetupStep = typeof HUB_SETUP_STEPS[number];
export type HubSetupPhase = HubSetupStep | "ready" | "error";

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
  /** Why setup stopped when it needs the User: the server belongs to another
   *  computer and starting it over is hers to decide. */
  reason?: "another-owner";
  /** Steps that had nothing to do (the chats were there already). */
  skipped?: HubSetupStep[];
  /** Whether the desktop's live link to the hub is up right now. */
  reachable?: boolean;
  /** Plain lines about the server's readers: a device that has not read
   *  from it for a long time (the server keeps everything it has not read:
   *  start it or remove it), or changes held for a long time. */
  notices?: string[];
  /** Lines the User may dismiss: changes a device could not apply for two
   *  weeks and gave up on, and what the shared relay's removal took off this
   *  desktop (shown with or without a server). */
  dismissableNotices?: Array<{ id: string; text: string }>;
  /** The region to offer for a new server: the one AWS is used in already. */
  defaultRegion?: string;
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
  /** The line the setup command printed; without it, the server this desktop
   *  already uses is updated. */
  blob?: string;
  /** The User agreed to start over a server another computer set up. */
  startOver?: boolean;
}

const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d$/;
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const USER = /^[a-z_][a-z0-9_-]{0,31}$/;

export function isHubRegion(value: unknown): value is string {
  return typeof value === "string" && REGION.test(value);
}

const HOST_KEY = /^(?:ssh-ed25519|ecdsa-sha2-nistp(?:256|384|521)|ssh-rsa) [A-Za-z0-9+/=]{40,1024}$/;
const NONCE = /^[A-Za-z0-9_-]{16,64}$/;

/** A setup command's label, as the command and the line it prints carry it. */
export function isHubNonce(value: unknown): value is string {
  return typeof value === "string" && NONCE.test(value);
}

/** Where a server is and who logs in there: the fields every SSH command
 *  and script on it is built from, whether they came from a pasted line or
 *  from settings. */
export function isHubServerAddress(value: { version?: unknown; region?: unknown; instanceName?: unknown; ip?: unknown; user?: unknown }): boolean {
  return value.version === 1 && isHubRegion(value.region) && typeof value.instanceName === "string" && NAME.test(value.instanceName) &&
    typeof value.ip === "string" && IPV4.test(value.ip) && typeof value.user === "string" && USER.test(value.user);
}

/** Base64 (either alphabet) to text, the same in Node and the browser. */
function decodeBase64Text(value: string): string {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

/** Reads the setup command's line (with anything around it pasted too). */
export function parseHubServerBlob(text: string): HubServerBlob {
  const match = new RegExp(`${HUB_SETUP_BLOB_PREFIX}([A-Za-z0-9+/=_-]+)`).exec(text);
  if (!match) throw new Error(`Paste the line the command printed; it starts with ${HUB_SETUP_BLOB_PREFIX}`);
  let value: Partial<HubServerBlob>;
  try {
    value = JSON.parse(decodeBase64Text(match[1])) as Partial<HubServerBlob>;
  } catch {
    throw new Error("The pasted line is incomplete; copy the whole line the command printed.");
  }
  if (!isHubServerAddress(value) ||
      (value.nonce !== undefined && !isHubNonce(value.nonce)) ||
      (value.hostKeys !== undefined && (!Array.isArray(value.hostKeys) || value.hostKeys.length > 8 || !value.hostKeys.every((key) => typeof key === "string" && HOST_KEY.test(key))))) {
    throw new Error("The pasted line does not describe a server; run the command again and paste its last line.");
  }
  return {
    version: 1, region: value.region as string, instanceName: value.instanceName as string, ip: value.ip as string, user: value.user as string,
    ...(value.nonce ? { nonce: value.nonce } : {}),
    ...(value.hostKeys?.length ? { hostKeys: value.hostKeys } : {})
  };
}

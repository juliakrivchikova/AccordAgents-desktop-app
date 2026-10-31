import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCommand } from "./command";

/**
 * A new AWS machine's SSH host key, made on this computer before the machine
 * exists and handed to it in its first-boot settings (cloud-init `ssh_keys`).
 * This computer then knows the key before it first connects: whoever answers
 * at the machine's address with another key (someone in the network between
 * them while it is set up) is refused, instead of being trusted on first use
 * and handed the machine's link to the User's server, its sign-ins and the
 * project copies.
 *
 * Kept in this app's own known-hosts file, under the name every connection to
 * the machine already uses (`accordagents-<instanceId>`). A machine made
 * before this has no line there and is checked as it always was.
 */
export interface WorkerHostKey {
  /** OpenSSH private key text (cloud-init `ed25519_private`). */
  privateKey: string;
  /** `ssh-ed25519 AAAA… comment` (cloud-init `ed25519_public`). */
  publicKey: string;
}

export function workerKnownHostsPath(keyDir: string): string {
  return path.join(keyDir, "known_hosts");
}

export async function generateWorkerHostKey(run: typeof runCommand = runCommand): Promise<WorkerHostKey> {
  const dir = await mkdtemp(path.join(tmpdir(), "accordagents-host-key-"));
  try {
    const file = path.join(dir, "host");
    await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "accordagents-machine-host", "-f", file], { timeoutMs: 15_000 });
    return {
      privateKey: (await readFile(file, "utf8")).trim(),
      publicKey: (await readFile(`${file}.pub`, "utf8")).trim()
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The host key for one launch: made once per launch token and kept until the
 * machine is known, so a launch tried again with the same token (AWS answers
 * the first one's machine) gives the same key, not a new one that would not
 * match the token's first request or the machine it made.
 */
export async function hostKeyForLaunch(keyDir: string, launchToken: string | undefined, make: () => Promise<WorkerHostKey> = generateWorkerHostKey): Promise<WorkerHostKey> {
  if (!launchToken) return make();
  const dir = path.join(keyDir, "launch-host-keys");
  const file = path.join(dir, `${createHash("sha256").update(launchToken).digest("hex").slice(0, 32)}.json`);
  const kept = await readFile(file, "utf8").then((text) => JSON.parse(text) as Partial<WorkerHostKey>).catch(() => undefined);
  if (kept && typeof kept.privateKey === "string" && typeof kept.publicKey === "string") return { privateKey: kept.privateKey, publicKey: kept.publicKey };
  const made = await make();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify(made), { mode: 0o600 });
  return made;
}

/** The launch's key is known under the machine's name now: its copy goes. */
export async function forgetLaunchHostKey(keyDir: string, launchToken: string | undefined): Promise<void> {
  if (!launchToken) return;
  await rm(path.join(keyDir, "launch-host-keys", `${createHash("sha256").update(launchToken).digest("hex").slice(0, 32)}.json`), { force: true });
}

const ALIAS = /^accordagents-i-[0-9a-f]{8,32}$/;

/** Whether a connection name is one this app gives the AWS machines it makes. */
export function isAwsMachineAlias(alias: string): boolean {
  return ALIAS.test(alias);
}

const PUBLIC_KEY = /^ssh-ed25519 [A-Za-z0-9+/=]+( .*)?$/;

/** Records the key a machine will answer with, under its connection name. */
export async function pinWorkerHostKey(keyDir: string, alias: string, publicKey: string): Promise<void> {
  if (!ALIAS.test(alias)) throw new Error(`Not a machine's connection name: ${alias}`);
  if (!PUBLIC_KEY.test(publicKey)) throw new Error("Not an Ed25519 host key.");
  await mkdir(keyDir, { recursive: true, mode: 0o700 });
  const file = workerKnownHostsPath(keyDir);
  const [type, key] = publicKey.split(" ");
  const kept = (await readFile(file, "utf8").catch(() => "")).split("\n")
    .filter((line) => line.trim() && line.split(" ")[0] !== alias);
  await writeFile(file, `${[...kept, `${alias} ${type} ${key}`].join("\n")}\n`, { mode: 0o600 });
}

/** cloud-init lines that give the machine this host key. With `ssh_keys`
 *  set, cloud-init makes no other host keys: this is the machine's only one. */
export function workerHostKeyCloudInit(hostKey: WorkerHostKey): string[] {
  return [
    "ssh_deletekeys: true",
    "ssh_keys:",
    "  ed25519_private: |",
    ...hostKey.privateKey.split("\n").map((line) => `    ${line}`),
    `  ed25519_public: ${hostKey.publicKey}`
  ];
}

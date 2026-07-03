import { constants } from "node:fs";
import { access, chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { runCommand } from "./command";
import type { AwsWorkerKeyMaterial } from "./awsWorkerLifecycle";

const KEY_PREFIX = "accordagents-worker";
const MANIFEST_FILE = "device-key.json";

interface AwsWorkerKeyManifest {
  keyName: string;
  createdAt: string;
}

export interface AwsWorkerKeyMaterialOptions {
  keyDir: string;
  rotate?: boolean;
  suffix?: () => string;
  now?: () => Date;
}

export function awsWorkerKeyDir(userDataPath: string): string {
  return path.join(userDataPath, "cloud-runs-keys");
}

export function awsWorkerPrivateKeyPath(keyDir: string, keyName: string): string {
  return path.join(keyDir, `${assertKeyName(keyName)}.pem`);
}

export async function generateOrLoadAwsWorkerKeyMaterial(
  options: AwsWorkerKeyMaterialOptions
): Promise<AwsWorkerKeyMaterial> {
  await mkdir(options.keyDir, { recursive: true });
  if (!options.rotate) {
    const existing = await loadExistingKey(options.keyDir);
    if (existing) {
      return existing;
    }
  }
  return generateNewKey(options);
}

export async function deleteAwsWorkerKeyMaterial(keyDir: string, keyName: string): Promise<void> {
  const privateKeyPath = awsWorkerPrivateKeyPath(keyDir, keyName);
  await unlinkIfExists(privateKeyPath);
  await unlinkIfExists(`${privateKeyPath}.pub`);
  const manifest = await readManifest(keyDir);
  if (manifest?.keyName === keyName) {
    await unlinkIfExists(path.join(keyDir, MANIFEST_FILE));
  }
}

async function loadExistingKey(keyDir: string): Promise<AwsWorkerKeyMaterial | undefined> {
  const manifest = await readManifest(keyDir);
  if (!manifest) {
    return undefined;
  }
  try {
    const keyName = assertKeyName(manifest.keyName);
    const privateKeyPath = awsWorkerPrivateKeyPath(keyDir, keyName);
    await access(privateKeyPath, constants.R_OK);
    const publicKeyOpenSsh = (await readFile(`${privateKeyPath}.pub`, "utf8")).trim();
    if (!isOpenSshPublicKey(publicKeyOpenSsh)) {
      return undefined;
    }
    return { keyName, publicKeyOpenSsh, privateKeyPath, reused: true };
  } catch {
    return undefined;
  }
}

async function generateNewKey(options: AwsWorkerKeyMaterialOptions): Promise<AwsWorkerKeyMaterial> {
  const now = options.now ?? (() => new Date());
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const keyName = `${KEY_PREFIX}-${assertSuffix((options.suffix ?? defaultSuffix)())}`;
    const privateKeyPath = awsWorkerPrivateKeyPath(options.keyDir, keyName);
    if (await exists(privateKeyPath) || await exists(`${privateKeyPath}.pub`)) {
      continue;
    }
    await runCommand("bash", [
      "-lc",
      `ssh-keygen -t ed25519 -N '' -q -f ${shellQuote(privateKeyPath)} -C ${shellQuote(keyName)}`
    ], { timeoutMs: 30_000 });
    await chmod(privateKeyPath, 0o600);
    const publicKeyOpenSsh = (await readFile(`${privateKeyPath}.pub`, "utf8")).trim();
    if (!isOpenSshPublicKey(publicKeyOpenSsh)) {
      throw new Error("Generated AWS worker public key was not an OpenSSH key.");
    }
    await writeManifest(options.keyDir, { keyName, createdAt: now().toISOString() });
    return { keyName, publicKeyOpenSsh, privateKeyPath, reused: false };
  }
  throw new Error("Could not generate a unique AWS worker key name.");
}

async function readManifest(keyDir: string): Promise<AwsWorkerKeyManifest | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path.join(keyDir, MANIFEST_FILE), "utf8")) as Partial<AwsWorkerKeyManifest>;
    if (typeof parsed.keyName === "string" && typeof parsed.createdAt === "string") {
      return { keyName: parsed.keyName, createdAt: parsed.createdAt };
    }
  } catch {
    // Missing or invalid manifests are repaired by generating a new key.
  }
  return undefined;
}

async function writeManifest(keyDir: string, manifest: AwsWorkerKeyManifest): Promise<void> {
  await writeFile(path.join(keyDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function unlinkIfExists(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

function isOpenSshPublicKey(value: string): boolean {
  return /^ssh-(ed25519|rsa|ecdsa-sha2-nistp(256|384|521))\s+\S+/.test(value);
}

function defaultSuffix(): string {
  return randomBytes(8).toString("hex");
}

function assertSuffix(value: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    throw new Error(`Invalid AWS worker key suffix: ${value}`);
  }
  return trimmed;
}

function assertKeyName(value: string): string {
  const trimmed = value.trim();
  if (!/^accordagents-worker(?:-[A-Za-z0-9._-]+)?$/.test(trimmed)) {
    throw new Error(`Invalid AWS worker key name: ${value}`);
  }
  return trimmed;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

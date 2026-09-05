/**
 * Host platform seam (machines transport, work item 2).
 *
 * The same main-process services run inside Electron on a desktop and as a
 * headless Node runtime on a Linux machine. This module is the only place that
 * asks Electron for paths, packaging state, and secret storage; everywhere
 * else imports these functions instead of "electron", so the headless build
 * composes the identical services with Node fallbacks.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface HostPlatform {
  /** electron = desktop app; headless = the machine runtime installed
   *  explicitly; bare = plain Node with nothing configured (unit tests). */
  kind: "electron" | "headless" | "bare";
  userDataPath(): string;
  appPath(): string;
  appVersion(): string;
  isPackaged(): boolean;
  secrets: {
    isEncryptionAvailable(): boolean;
    encryptString(plain: string): Buffer;
    decryptString(cipher: Buffer): string;
  };
  openExternal(url: string): Promise<void>;
  openPath(target: string): Promise<string>;
}

interface ElectronLike {
  app: {
    getPath(name: "userData"): string;
    getAppPath(): string;
    getVersion(): string;
    isPackaged: boolean;
  };
  safeStorage: {
    isEncryptionAvailable(): boolean;
    encryptString(plain: string): Buffer;
    decryptString(cipher: Buffer): string;
  };
  shell: {
    openExternal(url: string): Promise<void>;
    openPath(target: string): Promise<string>;
  };
}

let cached: HostPlatform | undefined;
let override: HostPlatform | undefined;

/** Tests and the headless entrypoint may install an explicit platform. */
export function setHostPlatform(platform: HostPlatform | undefined): void {
  override = platform;
  cached = undefined;
}

export function hostPlatform(): HostPlatform {
  if (override) {
    return override;
  }
  if (!cached) {
    cached = loadElectronPlatform() ?? createBarePlatform();
  }
  return cached;
}

export function userDataPath(): string {
  return hostPlatform().userDataPath();
}

export function isHeadlessHost(): boolean {
  return hostPlatform().kind === "headless";
}

/** True inside Electron or when the machine runtime installed a platform;
 *  false for plain Node (unit tests), where callers keep their temp-dir
 *  fallbacks. */
export function hasConfiguredHostPlatform(): boolean {
  return hostPlatform().kind !== "bare";
}

/** Plain Node with nothing configured: no OS secret store, user data from
 *  `ACCORDAGENTS_USER_DATA_DIR` or a per-process temp directory. Keeps unit
 *  tests free of side effects in the real home directory. */
function createBarePlatform(): HostPlatform {
  const userDataDir = path.resolve(
    process.env.ACCORDAGENTS_USER_DATA_DIR?.trim() || path.join(os.tmpdir(), `accordagents-bare-${process.pid}`)
  );
  const appPath = process.env.ACCORDAGENTS_APP_PATH?.trim() || path.resolve(__dirname, "..", "..", "..");
  return {
    kind: "bare",
    userDataPath: () => userDataDir,
    appPath: () => appPath,
    appVersion: () => readPackageVersion(appPath),
    isPackaged: () => false,
    secrets: {
      isEncryptionAvailable: () => false,
      encryptString: () => {
        throw new Error("No secret store is available on a bare Node host.");
      },
      decryptString: () => {
        throw new Error("No secret store is available on a bare Node host.");
      }
    },
    openExternal: async () => undefined,
    openPath: async () => "Opening files is not available on this host."
  };
}

function loadElectronPlatform(): HostPlatform | undefined {
  if (!process.versions.electron) {
    return undefined;
  }
  try {
    // Resolved at runtime so the headless build never loads Electron.
    const electron = require("electron") as Partial<ElectronLike>;
    if (!electron.app || typeof electron.app.getPath !== "function") {
      return undefined;
    }
    const { app, safeStorage, shell } = electron as ElectronLike;
    return {
      kind: "electron",
      userDataPath: () => app.getPath("userData"),
      appPath: () => app.getAppPath(),
      appVersion: () => app.getVersion(),
      isPackaged: () => app.isPackaged,
      secrets: {
        isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
        encryptString: (plain) => safeStorage.encryptString(plain),
        decryptString: (cipher) => safeStorage.decryptString(cipher)
      },
      openExternal: (url) => shell.openExternal(url),
      openPath: (target) => shell.openPath(target)
    };
  } catch {
    return undefined;
  }
}

export interface HeadlessPlatformOptions {
  userDataDir?: string;
  appPath?: string;
  appVersion?: string;
}

/**
 * Headless machine: user data under `ACCORDAGENTS_USER_DATA_DIR` (default
 * `~/.accordagents/machine`), secrets sealed with a per-machine key file
 * (0600) using AES-256-GCM, no shell integration.
 */
export function createHeadlessPlatform(options: HeadlessPlatformOptions = {}): HostPlatform {
  const userDataDir = path.resolve(
    options.userDataDir ?? process.env.ACCORDAGENTS_USER_DATA_DIR?.trim() ?? path.join(os.homedir(), ".accordagents", "machine")
  );
  const appPath = options.appPath ?? process.env.ACCORDAGENTS_APP_PATH?.trim() ?? path.resolve(__dirname, "..", "..", "..");
  const appVersion = options.appVersion ?? readPackageVersion(appPath);
  let key: Buffer | undefined;
  const loadKey = (): Buffer => {
    if (key) {
      return key;
    }
    mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
    const keyPath = path.join(userDataDir, "machine-secrets.key");
    if (!existsSync(keyPath)) {
      writeFileSync(keyPath, randomBytes(32).toString("base64") + "\n", { mode: 0o600 });
    }
    const raw = Buffer.from(readFileSync(keyPath, "utf8").trim(), "base64");
    key = raw.length === 32 ? raw : createHash("sha256").update(raw).digest();
    return key;
  };
  return {
    kind: "headless",
    userDataPath: () => userDataDir,
    appPath: () => appPath,
    appVersion: () => appVersion,
    isPackaged: () => process.env.ACCORDAGENTS_MACHINE_PACKAGED === "1",
    secrets: {
      isEncryptionAvailable: () => true,
      encryptString: (plain) => {
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", loadKey(), iv);
        const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
        return Buffer.concat([Buffer.from("am1"), iv, cipher.getAuthTag(), body]);
      },
      decryptString: (sealed) => {
        if (sealed.length < 3 + 12 + 16 || sealed.subarray(0, 3).toString() !== "am1") {
          throw new Error("Machine secret has an unknown format.");
        }
        const iv = sealed.subarray(3, 15);
        const tag = sealed.subarray(15, 31);
        const body = sealed.subarray(31);
        const decipher = createDecipheriv("aes-256-gcm", loadKey(), iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
      }
    },
    openExternal: async () => undefined,
    openPath: async () => "Opening files is not available on a headless machine."
  };
}

function readPackageVersion(appPath: string): string {
  try {
    const parsed = JSON.parse(readFileSync(path.join(appPath, "package.json"), "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

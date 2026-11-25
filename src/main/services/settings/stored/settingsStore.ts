import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { DEFAULT_PROVIDERS } from "../providers/defaultProviders";
import { hasLegacyProviderData, mergeDefaults } from "./storedDefaults";
import type { StoredSettings } from "../types";
import type { SettingsDependencies } from "../dependencies";

/** The settings file: read once, written whole, one write after another. */
export class SettingsStore {
  private storedState: StoredSettings | undefined;
  readError?: unknown;
  private storedLoad: Promise<StoredSettings> | undefined;
  private storedWriteQueue: Promise<void> = Promise.resolve();
  private readonly storedChangeListeners = new Set<() => void>();

  constructor(private readonly deps: Pick<SettingsDependencies, "settingsPath">) {}

  async readStored(): Promise<StoredSettings> {
    if (this.storedState) return this.storedState;
    if (!this.storedLoad) {
      this.storedLoad = (async () => {
        try {
          const raw = await readFile(this.deps.settingsPath, "utf8");
          const parsed = JSON.parse(raw) as StoredSettings;
          if (Object.hasOwn(parsed, "encryptedMachinePower") && (typeof parsed.encryptedMachinePower !== "string" || !parsed.encryptedMachinePower.trim())) {
            throw new Error("The stored machine power key has an invalid format.");
          }
          const merged = mergeDefaults(parsed);
          this.storedState = merged;
          if (hasLegacyProviderData(parsed)) {
            await this.writeStored(merged).catch((error) => {
              console.warn(
                `Failed to purge legacy provider data from settings: ${error instanceof Error ? error.message : String(error)}`
              );
            });
          }
          return merged;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.readError = error;
          const fallback = mergeDefaults({ settingsVersion: 1, roundLimitDefault: 1, providers: DEFAULT_PROVIDERS });
          this.storedState = fallback;
          return fallback;
        }
      })();
    }
    try {
      return await this.storedLoad;
    } finally {
      this.storedLoad = undefined;
    }
  }

  /** Called after every settings write that reached the disk. */
  onStoredChange(listener: () => void): () => void {
    this.storedChangeListeners.add(listener);
    return () => { this.storedChangeListeners.delete(listener); };
  }

  async writeStored(settings: StoredSettings, durable = false): Promise<void> {
    const previous = this.storedState;
    this.storedState = settings;
    const serialized = `${JSON.stringify(settings, null, 2)}\n`;
    const write = this.storedWriteQueue.then(async () => {
      await mkdir(path.dirname(this.deps.settingsPath), { recursive: true });
      const temporary = `${this.deps.settingsPath}.${randomUUID()}.tmp`;
      try {
        if (durable) {
          const file = await open(temporary, "wx", 0o600);
          try { await file.writeFile(serialized, "utf8"); await file.sync(); }
          finally { await file.close(); }
        } else await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600 });
        await rename(temporary, this.deps.settingsPath);
        if (durable && process.platform !== "win32") {
          const directory = await open(path.dirname(this.deps.settingsPath), "r");
          try { await directory.sync(); } finally { await directory.close(); }
        }
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    });
    this.storedWriteQueue = write.catch(() => undefined);
    try { await write; }
    catch (error) {
      if (durable && this.storedState === settings) this.storedState = previous;
      throw error;
    }
    for (const listener of this.storedChangeListeners) {
      try { listener(); } catch { /* a listener's failure is not the write's */ }
    }
  }
}

import { StorageService } from "../../storage";
import type { StorageDependencies } from "../dependencies";
import { createStorageModules, type StorageModules } from "../modules";

// The parts of the storage as its tests set them up and watch them: their
// private members too, so a test names the part that does the work.
type Open<T> = { -readonly [Key in keyof T]-?: any };

export function storageParts(storage: unknown): Open<StorageModules> {
  return (storage as { modules: Open<StorageModules> }).modules;
}

/** What that storage was given; one object, shared by every part. */
export function storageDependencies(storage: unknown): Open<StorageDependencies> {
  return storageParts(storage).sqlite.deps as Open<StorageDependencies>;
}

/** A storage that was given no database: a test says what it reads and writes. */
export function storageWithoutDatabase(): any {
  return Object.assign(Object.create(StorageService.prototype), {
    modules: createStorageModules({ dbPath: "", sqliteExecutable: "sqlite3" })
  });
}

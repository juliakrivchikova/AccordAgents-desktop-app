

/** Where the database is and what opens it. */
export interface StorageDependencies {
  readonly dbPath: string;
  readonly sqliteExecutable: string;
}

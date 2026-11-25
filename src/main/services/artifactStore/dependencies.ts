import type { ArtifactSqlExecutor } from "./types";

/** Where the documents are kept. */
export interface ArtifactStoreDependencies {
  readonly dbPath: string;
  readonly sqliteExecutable: string;
  readonly executor?: ArtifactSqlExecutor;
}

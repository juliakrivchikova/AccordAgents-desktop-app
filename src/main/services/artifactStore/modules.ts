import type { ArtifactStoreDependencies } from "./dependencies";
import { ArtifactDatabase } from "./artifactDatabase";
import { ArtifactDraftRecords } from "./artifactDraftRecords";
import { ArtifactOperations } from "./artifactOperations";
import { ArtifactRecords } from "./artifactRecords";
import { ArtifactServerCopies } from "./artifactServerCopies";
import { ArtifactVersions } from "./artifactVersions";

/** The document store's parts. Each names the ones it uses in its constructor. */
export interface ArtifactStoreModules {
  readonly artifactDatabase: ArtifactDatabase;
  readonly artifactRecords: ArtifactRecords;
  readonly artifactVersions: ArtifactVersions;
  readonly artifactDraftRecords: ArtifactDraftRecords;
  readonly artifactOperations: ArtifactOperations;
  readonly artifactServerCopies: ArtifactServerCopies;
}

/** Builds every part around one registry: parts call each other only once all of them exist. */
export function createArtifactStoreModules(deps: ArtifactStoreDependencies): ArtifactStoreModules {
  const modules = {} as { -readonly [Key in keyof ArtifactStoreModules]: ArtifactStoreModules[Key] };
  modules.artifactDatabase = new ArtifactDatabase(deps);
  modules.artifactRecords = new ArtifactRecords(modules);
  modules.artifactVersions = new ArtifactVersions(modules);
  modules.artifactDraftRecords = new ArtifactDraftRecords(modules);
  modules.artifactOperations = new ArtifactOperations(modules);
  modules.artifactServerCopies = new ArtifactServerCopies(modules);
  return modules;
}

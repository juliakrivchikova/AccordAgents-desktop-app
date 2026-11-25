import type { ArtifactServiceDeps } from "./dependencies";
import { ArtifactChanges } from "./artifactChanges";
import { ArtifactDrafts } from "./artifactDrafts";
import { ArtifactLookups } from "./artifactLookups";
import { ArtifactMutations } from "./artifactMutations";
import { ArtifactPublishing } from "./artifactPublishing";
import { ArtifactReads } from "./artifactReads";

/** The documents service's parts. Each names the ones it uses in its constructor. */
export interface ArtifactModules {
  readonly artifactReads: ArtifactReads;
  readonly artifactPublishing: ArtifactPublishing;
  readonly artifactChanges: ArtifactChanges;
  readonly artifactDrafts: ArtifactDrafts;
  readonly artifactMutations: ArtifactMutations;
  readonly artifactLookups: ArtifactLookups;
}

/** Builds every part around one registry: parts call each other only once all of them exist. */
export function createArtifactModules(deps: ArtifactServiceDeps): ArtifactModules {
  const modules = {} as { -readonly [Key in keyof ArtifactModules]: ArtifactModules[Key] };
  modules.artifactReads = new ArtifactReads(modules, deps);
  modules.artifactPublishing = new ArtifactPublishing(modules, deps);
  modules.artifactChanges = new ArtifactChanges(modules, deps);
  modules.artifactDrafts = new ArtifactDrafts(modules, deps);
  modules.artifactMutations = new ArtifactMutations(deps);
  modules.artifactLookups = new ArtifactLookups(deps);
  return modules;
}

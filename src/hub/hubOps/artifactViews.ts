import {
  isHubChatId, isHubOpId, type HubArtifactResponse, type HubArtifactRevisionResponse, type HubArtifactsResponse
} from "../../shared/hubOps";
import { HubOpsRequestError } from "./types";
import type { HubOpsModules } from "./modules";
import type { HubOpsDependencies } from "./dependencies";

/** Documents as devices read them. */
export class ArtifactViews {
  constructor(
    private readonly ops: Pick<HubOpsModules, "feed" | "operations">,
    private readonly deps: Pick<HubOpsDependencies, "artifacts">
  ) {}

  /** A chat's documents, as one consistent reading (between operations). */
  artifactStates(conversationId: string): Promise<HubArtifactsResponse> {
    if (!isHubChatId(conversationId)) return Promise.reject(new HubOpsRequestError(400, "Invalid chat id."));
    return this.ops.operations.betweenOperations(async () => ({ head: await this.ops.feed.head(), artifacts: await this.deps.artifacts.states(conversationId) }));
  }

  /** One document whole, without revision bodies; none when the server has
   *  no such document. */
  artifactState(artifactId: string): Promise<HubArtifactResponse> {
    if (!isHubOpId(artifactId)) return Promise.reject(new HubOpsRequestError(400, "Invalid document id."));
    return this.ops.operations.betweenOperations(async () => {
      const head = await this.ops.feed.head();
      const artifact = await this.deps.artifacts.state(artifactId);
      return artifact ? { artifact, head } : { head };
    });
  }

  /** One revision's body; none when the server has no such revision. */
  async artifactRevision(artifactId: string, versionEventId: string): Promise<HubArtifactRevisionResponse> {
    if (!isHubOpId(artifactId) || !versionEventId || versionEventId.length > 256) throw new HubOpsRequestError(400, "Invalid revision.");
    const revision = await this.deps.artifacts.revision(artifactId, versionEventId);
    return revision ? { revision } : {};
  }
}

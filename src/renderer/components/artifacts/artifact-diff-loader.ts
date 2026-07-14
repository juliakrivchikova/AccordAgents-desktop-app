import type { AppBridge, ArtifactDiffResult, ArtifactError, ArtifactResult } from "../../../shared/types";

export async function loadArtifactDiff(options: {
  bridge: Pick<AppBridge, "diffArtifactVersions">;
  conversationId: string;
  artifactId: string;
  fromVersion: number;
  toVersion: number;
  isCurrent: () => boolean;
}): Promise<ArtifactResult<ArtifactDiffResult> | undefined> {
  try {
    const result = await options.bridge.diffArtifactVersions({
      conversationId: options.conversationId,
      artifactId: options.artifactId,
      fromVersion: options.fromVersion,
      toVersion: options.toVersion
    });
    return options.isCurrent() ? result : undefined;
  } catch (caught) {
    if (!options.isCurrent()) {
      return undefined;
    }
    const error: ArtifactError = {
      code: "invalid_request",
      message: caught instanceof Error ? caught.message : String(caught)
    };
    return { ok: false, error };
  }
}

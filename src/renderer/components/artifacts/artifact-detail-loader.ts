import type { AppBridge, ArtifactDraftView, ArtifactError, ArtifactReadResult } from "../../../shared/types";

interface ArtifactDetailLoadCallbacks {
  onReadError: (error: ArtifactError) => void;
  onDetail: (detail: ArtifactReadResult) => void;
  onDrafts: (drafts: ArtifactDraftView[], error?: ArtifactError) => void;
}

export async function loadArtifactDetail(options: {
  bridge: Pick<AppBridge, "readArtifact" | "listArtifactDrafts">;
  conversationId: string;
  artifactId: string;
  version?: number;
  isCurrent: () => boolean;
  callbacks: ArtifactDetailLoadCallbacks;
}): Promise<ArtifactReadResult | undefined> {
  const result = await options.bridge.readArtifact({
    conversationId: options.conversationId,
    artifactId: options.artifactId,
    version: options.version,
    includeHistory: true
  });
  if (!options.isCurrent()) return undefined;
  if (!result.ok) {
    options.callbacks.onReadError(result.error);
    return undefined;
  }
  options.callbacks.onDetail(result.value);
  if (result.value.lifecycle === "collecting_drafts") {
    options.callbacks.onDrafts(result.value.drafts);
    return result.value;
  }
  const hasDraftCollection = (result.value.sources?.length ?? 0) > 0
    || result.value.summary.requiredDraftCount > 0
    || result.value.summary.submittedDraftCount > 0;
  if (!hasDraftCollection) {
    // Ordinary published artifacts never had a draft collection. Keep their
    // existing UI and avoid an irrelevant draft-list IPC call. Summary counts
    // keep the archive reachable while viewing revisions after v1.
    options.callbacks.onDrafts([]);
    return result.value;
  }
  const draftResult = await options.bridge.listArtifactDrafts({
    conversationId: options.conversationId,
    artifactId: options.artifactId
  });
  if (!options.isCurrent()) return undefined;
  options.callbacks.onDrafts(draftResult.ok ? draftResult.value : [], draftResult.ok ? undefined : draftResult.error);
  return result.value;
}

import type { ArtifactDraftContent, CollectingArtifactReadResult } from "../../../shared/types";
import { ArtifactContentSurface } from "./artifact-content-surface";

// Title, actions and the draft picker live in the panel header; the body is the
// selected draft's content. The first draft is shown until another is picked.
export function ArtifactDraftInbox(props: { detail: CollectingArtifactReadResult; selectedDraftId?: string }): JSX.Element {
  const { detail } = props;
  const selectedDraft = detail.drafts.find((draft) => draft.id === props.selectedDraftId) ?? detail.drafts[0];
  const selectedContent = selectedDraft?.hasContent ? selectedDraft as ArtifactDraftContent : undefined;

  return (
    <div className="artifacts-panel-body artifact-detail artifact-draft-inbox" data-testid="artifact-draft-inbox">
      {detail.drafts.length === 0 ? (
        <div className="artifacts-empty artifact-draft-empty">No drafts yet.</div>
      ) : selectedContent ? (
        <ArtifactContentSurface content={selectedContent.content} testId="artifact-draft-content" />
      ) : (
        <div className="artifact-draft-unavailable">Draft content is unavailable.</div>
      )}
    </div>
  );
}

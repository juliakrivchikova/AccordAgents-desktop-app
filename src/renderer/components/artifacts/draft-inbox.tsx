import { useEffect, useState } from "react";
import { Pencil } from "lucide-react";

import type { ArtifactDraftContent, CollectingArtifactReadResult } from "../../../shared/types";
import { artifactMemberLabel } from "../../../shared/artifacts";
import { IconButton } from "../primitives/icon-button";
import { ArtifactContentSurface } from "./artifact-content-surface";
import { ArtifactVersionSelector } from "./artifact-version-selector";

export function ArtifactDraftInbox(props: {
  detail: CollectingArtifactReadResult;
  busy: boolean;
  canRename: boolean;
  renaming: boolean;
  renameValue: string;
  onRenameValueChange: (value: string) => void;
  onStartRename: () => void;
  onCancelRename: () => void;
  onSubmitRename: () => void;
}): JSX.Element {
  const { detail } = props;
  const [selectedDraftId, setSelectedDraftId] = useState<string | undefined>(detail.drafts[0]?.id);
  const selectedDraft = detail.drafts.find((draft) => draft.id === selectedDraftId) ?? detail.drafts[0];
  const selectedContent = selectedDraft?.hasContent ? selectedDraft as ArtifactDraftContent : undefined;

  useEffect(() => {
    if (!selectedDraftId || !detail.drafts.some((draft) => draft.id === selectedDraftId)) {
      setSelectedDraftId(detail.drafts[0]?.id);
    }
  }, [detail.drafts, selectedDraftId]);

  return (
    <div className="artifacts-panel-body artifact-detail artifact-draft-inbox" data-testid="artifact-draft-inbox">
      <div className="artifact-detail-head">
        {props.renaming ? (
          <div className="artifact-rename-row">
            <input value={props.renameValue} onChange={(event) => props.onRenameValueChange(event.target.value)} aria-label="New artifact name" />
            <button type="button" className="artifact-primary-action" disabled={props.busy || !props.renameValue.trim()} onClick={props.onSubmitRename}>Save</button>
            <button type="button" className="artifact-secondary-action" onClick={props.onCancelRename}>Cancel</button>
          </div>
        ) : (
          <h4 className="artifact-name">
            {detail.summary.name}
            {props.canRename && (
              <IconButton label="Rename artifact" icon={Pencil} size="xs" onClick={props.onStartRename} />
            )}
          </h4>
        )}
        <div className="artifact-detail-meta">
          <span className="artifact-version-chip artifact-draft-chip">Collecting drafts</span>
          <span className="artifact-draft-progress" data-testid="artifact-draft-progress">
            {detail.summary.submittedDraftCount}/{detail.summary.requiredDraftCount} required submitted
          </span>
        </div>
        <div className="artifact-people">
          <span>Owner {artifactMemberLabel(detail.summary.owner)}</span>
          <span> · Draft authors {detail.allowedDraftAuthors.map(artifactMemberLabel).join(", ")}</span>
        </div>
      </div>

      {detail.drafts.length === 0 ? (
        <div className="artifacts-empty">No drafts yet.</div>
      ) : (
        <>
          <ArtifactVersionSelector
            history={[]}
            drafts={detail.drafts}
            selectedDraftId={selectedDraft?.id}
            onShowVersion={() => undefined}
            onShowDraft={setSelectedDraftId}
          />
          {selectedDraft && (
            <div className="artifact-draft-author" data-testid="artifact-draft-author">
              Draft by <strong>{artifactMemberLabel(selectedDraft.author)}</strong>
            </div>
          )}
          {selectedContent ? (
            <ArtifactContentSurface content={selectedContent.content} testId="artifact-draft-content" />
          ) : (
            <div className="artifact-draft-unavailable">Draft content is unavailable.</div>
          )}
        </>
      )}
    </div>
  );
}

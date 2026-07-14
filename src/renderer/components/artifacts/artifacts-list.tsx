import type { ArtifactSummary } from "../../../shared/types";
import { ArtifactApprovalBadge } from "./artifact-approval-badge";
import { formatArtifactTimestamp } from "./artifact-detail";

export function ArtifactsList(props: {
  artifacts: ArtifactSummary[];
  onSelect: (artifactId: string) => void;
}): JSX.Element {
  if (props.artifacts.length === 0) {
    return (
      <div className="artifacts-empty">
        No artifacts in this chat yet. Members and agents can create durable, versioned, signable documents here — plans, QA case lists, decisions, todo lists, anything.
      </div>
    );
  }
  return (
    <ul className="artifact-list">
      {props.artifacts.map((artifact) => (
        <li key={artifact.id}>
          <button type="button" className="artifact-list-item" onClick={() => props.onSelect(artifact.id)}>
            <span className="artifact-list-name">{artifact.name}</span>
            <span className="artifact-list-meta">
              {artifact.lifecycle === "collecting_drafts" ? (
                <span className="artifact-version-chip artifact-draft-chip">
                  Drafts {artifact.submittedDraftCount}/{artifact.requiredDraftCount}
                </span>
              ) : (
                <>
                  <span className="artifact-version-chip">v{artifact.headVersion}</span>
                  <ArtifactApprovalBadge approval={artifact.approval} />
                </>
              )}
              <span className="artifact-updated">{formatArtifactTimestamp(artifact.updatedAt)}</span>
            </span>
            {artifact.labels.length > 0 && (
              <span className="artifact-labels">
                {artifact.labels.map((label) => <span key={label} className="artifact-label">{label}</span>)}
              </span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

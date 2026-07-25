import { FileText } from "lucide-react";

import type { ArtifactSummary } from "../../../shared/types";
import { artifactMemberLabel } from "../../../shared/artifacts";
import { ArtifactApprovedMark } from "./artifact-approval-badge";
import { formatArtifactRelativeTimestamp } from "./artifact-detail";

export function ArtifactsList(props: {
  artifacts: ArtifactSummary[];
  onSelect: (artifactId: string) => void;
  emptyMessage?: string;
}): JSX.Element {
  if (props.artifacts.length === 0) {
    return (
      <div className="artifacts-empty">
        {props.emptyMessage ?? "No artifacts in this chat yet. Members and agents can create durable, versioned, signable documents here — plans, QA case lists, decisions, todo lists, anything."}
      </div>
    );
  }
  return (
    <ul className="artifact-list">
      {props.artifacts.map((artifact) => (
        <li key={artifact.id}>
          <button type="button" className="artifact-list-item" onClick={() => props.onSelect(artifact.id)}>
            <span className="artifact-list-mark" aria-hidden>
              <FileText size={15} strokeWidth={1.9} />
            </span>
            <span className="artifact-list-body">
              <span className="artifact-list-line">
                <span className="artifact-list-name">{artifact.name}</span>
                {artifact.approval.state === "approved" && <ArtifactApprovedMark />}
              </span>
              <span className="artifact-list-meta">
                {artifact.lifecycle === "collecting_drafts" ? (
                  <>Drafts {artifact.submittedDraftCount}/{artifact.requiredDraftCount}</>
                ) : (
                  <>v{artifact.headVersion} · {artifactMemberLabel(artifact.owner)} · Updated {formatArtifactRelativeTimestamp(artifact.updatedAt)}</>
                )}
              </span>
              {artifact.labels.length > 0 && (
                <span className="artifact-labels">
                  {artifact.labels.map((label) => <span key={label} className="artifact-label">{label}</span>)}
                </span>
              )}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

import { ChevronDown } from "lucide-react";

import type { ArtifactDraftView, ArtifactVersionMeta } from "../../../shared/types";
import { artifactMemberLabel } from "../../../shared/artifacts";

function draftOptionLabel(draft: ArtifactDraftView): string {
  const timestamp = Date.parse(draft.submittedAt ?? draft.updatedAt);
  const date = Number.isFinite(timestamp)
    ? new Date(timestamp).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : draft.submittedAt ?? draft.updatedAt;
  const state = `${draft.state.charAt(0).toUpperCase()}${draft.state.slice(1)}`;
  return `Draft by ${artifactMemberLabel(draft.author)} · ${state} · ${date}`;
}

export function ArtifactVersionSelector(props: {
  selectedVersion?: number;
  headVersion?: number;
  history: ArtifactVersionMeta[];
  drafts: ArtifactDraftView[];
  selectedDraftId?: string;
  onShowVersion: (version: number) => void;
  onShowDraft: (draftId: string) => void;
}): JSX.Element {
  const selectedEntry = props.selectedDraftId
    ? `draft:${props.selectedDraftId}`
    : props.selectedVersion !== undefined ? `version:${props.selectedVersion}` : "";
  const versions = [...props.history].sort((left, right) => right.version - left.version);

  function selectEntry(value: string): void {
    if (value.startsWith("version:")) {
      props.onShowVersion(Number(value.slice("version:".length)));
      return;
    }
    if (value.startsWith("draft:")) {
      props.onShowDraft(value.slice("draft:".length));
    }
  }

  return (
    <label className="artifact-version-selector">
      <span className="artifact-version-selector-label">Version or draft</span>
      <span className="artifact-version-selector-control">
        <select
          value={selectedEntry}
          aria-label="Artifact versions and drafts"
          data-testid="artifact-version-selector"
          onChange={(event) => selectEntry(event.currentTarget.value)}
        >
          {versions.length > 0 && (
            <optgroup label="Versions">
              {versions.map((version) => (
                <option key={version.version} value={`version:${version.version}`}>
                  v{version.version} · {artifactMemberLabel(version.author)}{version.version === props.headVersion ? " · Current" : ""}
                </option>
              ))}
            </optgroup>
          )}
          {props.drafts.length > 0 && (
            <optgroup label="Drafts">
              {props.drafts.map((draft) => (
                <option key={draft.id} value={`draft:${draft.id}`}>{draftOptionLabel(draft)}</option>
              ))}
            </optgroup>
          )}
        </select>
        <ChevronDown size={16} aria-hidden />
      </span>
    </label>
  );
}

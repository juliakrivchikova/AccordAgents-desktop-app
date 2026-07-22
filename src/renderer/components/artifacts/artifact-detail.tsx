import { useEffect, useState } from "react";
import { FileDiff, FileText } from "lucide-react";

import type { ArtifactDraftContent, ArtifactDraftView, ArtifactError, PublishedArtifactReadResult } from "../../../shared/types";
import { artifactMemberLabel } from "../../../shared/artifacts";
import { ReviseArtifactForm } from "./artifact-forms";
import { ArtifactVersionSelector } from "./artifact-version-selector";
import { ArtifactContentSurface } from "./artifact-content-surface";

export interface ArtifactCompareState {
  fromVersion: number;
  toVersion: number;
  diff?: string;
}

export function formatArtifactTimestamp(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    return value;
  }
  return new Date(time).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function formatArtifactRelativeTimestamp(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    return value;
  }
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  const units: Array<[number, string]> = [
    [60 * 60 * 24 * 30, "mo"],
    [60 * 60 * 24 * 7, "w"],
    [60 * 60 * 24, "d"],
    [60 * 60, "h"],
    [60, "m"]
  ];
  for (const [unitSeconds, label] of units) {
    if (seconds >= unitSeconds) {
      return `${Math.floor(seconds / unitSeconds)}${label} ago`;
    }
  }
  return "just now";
}

export function ArtifactDetailView(props: {
  detail: PublishedArtifactReadResult;
  drafts: ArtifactDraftView[];
  draftError?: ArtifactError;
  mode: "view" | "revise";
  busy: boolean;
  canEdit: boolean;
  canSign: boolean;
  alreadySigned: boolean;
  reviseBase: number;
  compare?: ArtifactCompareState;
  showDiff: boolean;
  renaming: boolean;
  renameValue: string;
  onRenameValueChange: (value: string) => void;
  onStartRename: () => void;
  onCancelRename: () => void;
  onSubmitRename: () => void;
  onStartRevise: () => void;
  onSubmitRevise: (content: string, note: string | undefined) => void;
  onCancelForm: () => void;
  onSign: () => void;
  onShowVersion: (version: number) => void;
  onShowDiffChange: (showDiff: boolean) => void;
  onRetryDrafts: () => void;
}): JSX.Element {
  const { detail } = props;
  const [selectedDraftId, setSelectedDraftId] = useState<string | undefined>(undefined);
  const selectedDraft = props.drafts.find((draft) => draft.id === selectedDraftId);
  const selectedDraftContent = selectedDraft?.hasContent ? selectedDraft as ArtifactDraftContent : undefined;

  useEffect(() => setSelectedDraftId(undefined), [detail.summary.id, detail.version.version]);
  useEffect(() => {
    if (selectedDraftId && !props.drafts.some((draft) => draft.id === selectedDraftId)) {
      setSelectedDraftId(undefined);
    }
  }, [props.drafts, selectedDraftId]);

  return (
    <div className="artifacts-panel-body artifact-detail" tabIndex={0} aria-label="Artifact details">
      <div className="artifact-detail-head">
        <div className="artifact-people-row">
          <span className="artifact-people-label">Owner</span>
          <span className="artifact-people-value">{artifactMemberLabel(detail.summary.owner)}</span>
        </div>
        {!selectedDraft && detail.summary.approval.requiredSigners.length > 0 && (
          <div className="artifact-people-row">
            <span className="artifact-people-label">Signers</span>
            <span className="artifact-people-value">
              {detail.summary.approval.requiredSigners.map((signer) => (
                <span key={signer} className="artifact-signer">
                  {artifactMemberLabel(signer)}
                  {detail.summary.approval.signedCurrent.includes(signer) ? <span aria-label="signed">✓</span> : null}
                </span>
              ))}
            </span>
          </div>
        )}
        {detail.summary.labels.length > 0 && (
          <div className="artifact-labels">{detail.summary.labels.map((label) => <span key={label} className="artifact-label">{label}</span>)}</div>
        )}
      </div>

      {props.mode === "revise" ? (
        <ReviseArtifactForm
          key={`revise-${detail.summary.id}-${props.reviseBase}`}
          baseVersion={props.reviseBase}
          initialContent={detail.version.version === detail.summary.headVersion ? detail.version.content : ""}
          busy={props.busy}
          onCancel={props.onCancelForm}
          onSubmit={props.onSubmitRevise}
        />
      ) : (
        <>
          <div className="artifact-toolbar">
            <ArtifactVersionSelector
              key={detail.summary.id}
              selectedVersion={selectedDraftId ? undefined : detail.version.version}
              headVersion={detail.summary.headVersion}
              history={detail.history ?? []}
              drafts={props.drafts}
              selectedDraftId={selectedDraftId}
              onShowVersion={(version) => {
                setSelectedDraftId(undefined);
                props.onShowVersion(version);
              }}
              onShowDraft={setSelectedDraftId}
            />
            {!selectedDraft && detail.version.version > 1 && (
              <div className="artifact-diff-segment" role="tablist" aria-label="Artifact view">
                <button
                  type="button"
                  className={!props.showDiff ? "is-selected" : undefined}
                  role="tab"
                  aria-selected={!props.showDiff}
                  disabled={props.busy}
                  onClick={() => props.onShowDiffChange(false)}
                >
                  <FileText size={14} aria-hidden /> Content
                </button>
                <button
                  type="button"
                  className={props.showDiff ? "is-selected" : undefined}
                  role="tab"
                  aria-selected={props.showDiff}
                  disabled={props.busy}
                  data-testid="artifact-show-diff-toggle"
                  onClick={() => props.onShowDiffChange(true)}
                >
                  <FileDiff size={14} aria-hidden /> Diff
                </button>
              </div>
            )}
            {!selectedDraft && props.canSign && !props.alreadySigned && (
              <button
                type="button"
                className="artifact-secondary-action"
                disabled={props.busy}
                title={`Sign v${detail.version.version}`}
                onClick={props.onSign}
              >
                Sign v{detail.version.version}
              </button>
            )}
          </div>
          {props.draftError ? (
            <div className="artifact-draft-error" role="alert">
              <span>Drafts could not be loaded: {props.draftError.message}</span>
              <button type="button" className="artifact-secondary-action" onClick={props.onRetryDrafts}>Retry</button>
            </div>
          ) : null}
          {selectedDraft ? (
            <>
              <div className="artifact-draft-author" data-testid="artifact-draft-author">
                Draft by <strong>{artifactMemberLabel(selectedDraft.author)}</strong>
              </div>
              {selectedDraftContent ? (
                <ArtifactContentSurface
                  content={selectedDraftContent.content}
                  testId="artifact-draft-content"
                />
              ) : (
                <div className="artifact-draft-unavailable">Draft content is unavailable.</div>
              )}
            </>
          ) : (
            <>
              {props.showDiff ? (
                props.compare?.diff !== undefined ? (
                  <pre
                    className="artifact-diff-pre"
                    data-testid="artifact-version-diff"
                    aria-label={`Changes from v${detail.version.version - 1} to v${detail.version.version}`}
                  >
                    {props.compare.diff.split("\n").map((line, index) => (
                      <span key={index} className={diffLineClass(line)}>{line || " "}{"\n"}</span>
                    ))}
                  </pre>
                ) : (
                  <div className="artifact-diff-loading" role="status">
                    {props.busy ? "Loading diff…" : "Diff unavailable."}
                  </div>
                )
              ) : (
                <>
                  {detail.version.note && <div className="artifact-version-note">Note: {detail.version.note}</div>}
                  <ArtifactContentSurface
                    content={detail.version.content}
                    testId="artifact-version-content"
                    onRevise={props.canEdit ? props.onStartRevise : undefined}
                    reviseDisabled={props.busy}
                  />
                </>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

function diffLineClass(line: string): string {
  if (line.startsWith("+")) {
    return "artifact-diff-add";
  }
  if (line.startsWith("-")) {
    return "artifact-diff-del";
  }
  if (line.startsWith("@@")) {
    return "artifact-diff-hunk";
  }
  return "artifact-diff-context";
}

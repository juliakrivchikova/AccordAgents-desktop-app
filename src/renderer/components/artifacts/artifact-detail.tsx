import { useEffect, useState } from "react";
import { Pencil } from "lucide-react";

import type { ArtifactDraftContent, ArtifactDraftView, ArtifactError, PublishedArtifactReadResult } from "../../../shared/types";
import { artifactMemberLabel } from "../../../shared/artifacts";
import { IconButton } from "../primitives";
import { ArtifactApprovalBadge } from "./artifact-approval-badge";
import { AccessArtifactForm, ReviseArtifactForm } from "./artifact-forms";
import type { ArtifactAccessValues } from "./artifact-forms";
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

export function ArtifactDetailView(props: {
  detail: PublishedArtifactReadResult;
  drafts: ArtifactDraftView[];
  draftError?: ArtifactError;
  mode: "view" | "revise" | "access";
  busy: boolean;
  canEdit: boolean;
  canSign: boolean;
  isOwner: boolean;
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
  onStartAccess: () => void;
  onSubmitAccess: (values: ArtifactAccessValues) => void;
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
        {props.renaming ? (
          <div className="artifact-rename-row">
            <input value={props.renameValue} onChange={(event) => props.onRenameValueChange(event.target.value)} aria-label="New artifact name" />
            <button type="button" className="artifact-primary-action" disabled={props.busy || !props.renameValue.trim()} onClick={props.onSubmitRename}>Save</button>
            <button type="button" className="artifact-secondary-action" onClick={props.onCancelRename}>Cancel</button>
          </div>
        ) : (
          <h4 className="artifact-name">
            {detail.summary.name}
            {props.canEdit && (
              <IconButton
                label="Rename artifact"
                icon={Pencil}
                size="xs"
                tooltip="Rename (label only; references and versions keep working)"
                onClick={props.onStartRename}
              />
            )}
          </h4>
        )}
        <div className="artifact-detail-meta">
          {selectedDraft ? (
            <span className="artifact-version-chip artifact-draft-chip">Draft by {artifactMemberLabel(selectedDraft.author)}</span>
          ) : (
            <>
              <span className="artifact-version-chip">v{detail.version.version}{detail.version.version !== detail.summary.headVersion ? ` of ${detail.summary.headVersion}` : ""}</span>
              <ArtifactApprovalBadge approval={detail.summary.approval} />
            </>
          )}
        </div>
        <div className="artifact-people">
          <span>Owner {artifactMemberLabel(detail.summary.owner)}</span>
          {detail.summary.contributors.length > 0 && (
            <span> · Contributors {detail.summary.contributors.map(artifactMemberLabel).join(", ")}</span>
          )}
          {!selectedDraft && detail.summary.approval.requiredSigners.length > 0 && (
            <span> · Signers {detail.summary.approval.requiredSigners.map((signer) => `${artifactMemberLabel(signer)}${detail.summary.approval.signedCurrent.includes(signer) ? " ✓" : ""}`).join(", ")}</span>
          )}
        </div>
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
      ) : props.mode === "access" ? (
        <AccessArtifactForm
          summary={detail.summary}
          busy={props.busy}
          onCancel={props.onCancelForm}
          onSubmit={props.onSubmitAccess}
        />
      ) : (
        <>
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
              <div className="artifact-actions-row">
                {props.canEdit && <button type="button" className="artifact-primary-action" disabled={props.busy} onClick={props.onStartRevise}>Revise</button>}
                {props.canSign && (
                  <button
                    type="button"
                    className="artifact-secondary-action"
                    disabled={props.busy || props.alreadySigned}
                    title={props.alreadySigned ? "You already signed this version" : `Sign v${detail.version.version}`}
                    onClick={props.onSign}
                  >
                    {props.alreadySigned ? "Signed ✓" : `Sign v${detail.version.version}`}
                  </button>
                )}
                {detail.version.version > 1 && (
                  <label className={`artifact-diff-toggle${props.busy ? " is-disabled" : ""}`}>
                    <input
                      type="checkbox"
                      checked={props.showDiff}
                      disabled={props.busy}
                      aria-label="Show diff"
                      data-testid="artifact-show-diff-toggle"
                      onChange={(event) => props.onShowDiffChange(event.currentTarget.checked)}
                    />
                    <span className="artifact-diff-toggle-track" aria-hidden><span /></span>
                    <span>Show diff</span>
                  </label>
                )}
                {props.isOwner && <button type="button" className="artifact-secondary-action" disabled={props.busy} onClick={props.onStartAccess}>Access…</button>}
              </div>
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

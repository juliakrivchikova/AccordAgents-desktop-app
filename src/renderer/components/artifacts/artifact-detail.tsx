import { useState } from "react";
import { Check, Eye, History, Pencil, X } from "lucide-react";

import type { ArtifactDraftContent, ArtifactDraftView, ArtifactError, PublishedArtifactReadResult } from "../../../shared/types";
import { artifactMemberLabel } from "../../../shared/artifacts";
import { ArtifactContentSurface } from "./artifact-content-surface";
import { MarkdownText } from "../content/markdown-text";

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
  selectedDraftId?: string;
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
  // The version or draft on screen is picked in the panel header.
  const selectedDraft = props.selectedDraftId ? props.drafts.find((draft) => draft.id === props.selectedDraftId) : undefined;
  const selectedDraftContent = selectedDraft?.hasContent ? selectedDraft as ArtifactDraftContent : undefined;
  const headVersion = detail.summary.headVersion;
  const viewingOlder = !selectedDraft && props.mode !== "revise" && detail.version.version !== headVersion;
  const needsSignature = !selectedDraft && props.mode !== "revise" && props.canSign && !props.alreadySigned;

  return (
    <div className="artifacts-panel-body artifact-detail" tabIndex={0} aria-label="Artifact details">
      {selectedDraft || viewingOlder ? (
        <div className="artifact-view-notice" role="status" data-testid="artifact-view-notice">
          <History size={14} aria-hidden />
          <span>
            {selectedDraft
              ? <>Viewing a draft by <strong>{artifactMemberLabel(selectedDraft.author)}</strong></>
              : <>Viewing <strong>v{detail.version.version}</strong> · not the current version</>}
          </span>
          <button type="button" className="artifact-link-button" onClick={() => props.onShowVersion(headVersion)}>
            Back to v{headVersion}
          </button>
        </div>
      ) : null}
      {props.draftError ? (
        <div className="artifact-draft-error" role="alert">
          <span>Drafts could not be loaded: {props.draftError.message}</span>
          <button type="button" className="artifact-secondary-action" onClick={props.onRetryDrafts}>Retry</button>
        </div>
      ) : null}
      {selectedDraft ? (
        <>
          {selectedDraftContent ? (
            <ArtifactContentSurface
              content={selectedDraftContent.content}
              testId="artifact-draft-content"
            />
          ) : (
            <div className="artifact-draft-unavailable">Draft content is unavailable.</div>
          )}
        </>
      ) : props.mode === "revise" ? (
        <ArtifactRevisionSurface
          key={`revise-${detail.summary.id}`}
          baseVersion={props.reviseBase}
          initialContent={detail.version.version === detail.summary.headVersion ? detail.version.content : ""}
          busy={props.busy}
          onCancel={props.onCancelForm}
          onSubmit={props.onSubmitRevise}
        />
      ) : (
        <>
          {props.showDiff ? (
            <>
              <div className="artifact-diff-caption">
                Changes from v{detail.version.version - 1} to v{detail.version.version} ·{" "}
                <button
                  type="button"
                  className="artifact-link-button"
                  data-testid="artifact-show-content"
                  onClick={() => props.onShowDiffChange(false)}
                >
                  Show content
                </button>
              </div>
              {props.compare?.diff !== undefined ? (
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
              )}
            </>
          ) : (
            <ArtifactContentSurface
              content={detail.version.content}
              testId="artifact-version-content"
              note={detail.version.note}
              onRevise={props.canEdit ? props.onStartRevise : undefined}
              reviseDisabled={props.busy}
              signLabel={`Sign v${detail.version.version}`}
              onSign={needsSignature ? props.onSign : undefined}
            />
          )}
        </>
      )}
    </div>
  );
}

function ArtifactRevisionSurface(props: {
  baseVersion: number;
  initialContent: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (content: string, note: string | undefined) => void;
}): JSX.Element {
  const [content, setContent] = useState(props.initialContent);
  const [note, setNote] = useState("");
  // Preview renders the unsaved edit; it never leaves revise mode or drops the edit.
  const [preview, setPreview] = useState(false);
  return (
    <div className="artifact-content-surface artifact-edit-surface" data-testid="artifact-revision-content">
      <div className="artifact-content-fabs artifact-edit-fabs">
        <div className="artifact-fab-segment" role="tablist" aria-label="Artifact edit mode">
          <button
            type="button"
            className={preview ? "is-selected" : undefined}
            role="tab"
            aria-selected={preview}
            data-testid="artifact-revise-preview-toggle"
            onClick={() => setPreview(true)}
          >
            <Eye size={14} aria-hidden /> Preview
          </button>
          <button
            type="button"
            className={!preview ? "is-selected" : undefined}
            role="tab"
            aria-selected={!preview}
            data-testid="artifact-revise-edit-toggle"
            onClick={() => setPreview(false)}
          >
            <Pencil size={14} aria-hidden /> Edit
          </button>
        </div>
        <button type="button" className="artifact-content-action" aria-label="Cancel editing" title="Cancel" onClick={props.onCancel}>
          <X size={15} aria-hidden />
        </button>
        <button
          type="button"
          className="artifact-content-action artifact-edit-save"
          aria-label={`Save as v${props.baseVersion + 1}`}
          title={`Save as v${props.baseVersion + 1}`}
          disabled={props.busy || !content}
          onClick={() => props.onSubmit(content, note.trim() ? note : undefined)}
        >
          <Check size={15} aria-hidden />
        </button>
      </div>
      {preview && (
        <div className="artifact-content-markdown" data-testid="artifact-revise-preview">
          {content.trim()
            ? <MarkdownText content={content} />
            : <span className="artifact-revise-preview-empty">Nothing to preview yet.</span>}
        </div>
      )}
      {/* Hidden rather than unmounted so undo history, caret and scroll survive Preview. */}
      <textarea
        id="artifact-revise-content"
        className="artifact-content-edit-textarea"
        aria-label={`Artifact content for v${props.baseVersion + 1}`}
        hidden={preview}
        value={content}
        onChange={(event) => setContent(event.target.value)}
      />
      <label className="artifact-revision-note">
        <span>Revision note</span>
        <input
          value={note}
          aria-label="Revision note"
          placeholder="Optional"
          onChange={(event) => setNote(event.target.value)}
        />
      </label>
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

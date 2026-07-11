import { Pencil } from "lucide-react";

import type { ArtifactReadResult } from "../../../shared/types";
import { artifactMemberLabel } from "../../../shared/artifacts";
import { MarkdownText } from "../content/markdown-text";
import { IconButton } from "../primitives";
import { ArtifactApprovalBadge } from "./artifact-approval-badge";
import { AccessArtifactForm, ReviseArtifactForm } from "./artifact-forms";
import type { ArtifactAccessValues } from "./artifact-forms";

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
  detail: ArtifactReadResult;
  mode: "view" | "revise" | "access";
  busy: boolean;
  canEdit: boolean;
  canSign: boolean;
  isOwner: boolean;
  alreadySigned: boolean;
  reviseBase: number;
  compare?: ArtifactCompareState;
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
  onCompare: (fromVersion: number, toVersion: number) => void;
}): JSX.Element {
  const { detail } = props;
  return (
    <div className="artifacts-panel-body artifact-detail">
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
          <span className="artifact-version-chip">v{detail.version.version}{detail.version.version !== detail.summary.headVersion ? ` of ${detail.summary.headVersion}` : ""}</span>
          <ArtifactApprovalBadge approval={detail.summary.approval} />
        </div>
        <div className="artifact-people">
          <span>Owner {artifactMemberLabel(detail.summary.owner)}</span>
          {detail.summary.contributors.length > 0 && (
            <span> · Contributors {detail.summary.contributors.map(artifactMemberLabel).join(", ")}</span>
          )}
          {detail.summary.approval.requiredSigners.length > 0 && (
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
            {props.isOwner && <button type="button" className="artifact-secondary-action" disabled={props.busy} onClick={props.onStartAccess}>Access…</button>}
          </div>
          {detail.version.note && <div className="artifact-version-note">Note: {detail.version.note}</div>}
          <div className="artifact-content-markdown">
            <MarkdownText content={detail.version.content} />
          </div>
          <div className="artifact-history">
            <h5>History</h5>
            <ul>
              {[...(detail.history ?? [])].reverse().map((meta) => (
                <li key={meta.version} className={meta.version === detail.version.version ? "artifact-history-current" : undefined}>
                  <button type="button" className="artifact-history-version" onClick={() => props.onShowVersion(meta.version)}>
                    v{meta.version}
                  </button>
                  <span className="artifact-history-meta">
                    {artifactMemberLabel(meta.author)} · {formatArtifactTimestamp(meta.createdAt)}
                    {meta.note ? ` · ${meta.note}` : ""}
                    {meta.signatures.length > 0 ? ` · signed by ${meta.signatures.map((signature) => artifactMemberLabel(signature.signer)).join(", ")}` : ""}
                  </span>
                  {meta.version > 1 && (
                    <button type="button" className="artifact-diff-action" disabled={props.busy} onClick={() => props.onCompare(meta.version - 1, meta.version)}>
                      diff v{meta.version - 1}→v{meta.version}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
          {props.compare?.diff !== undefined && (
            <div className="artifact-compare">
              <h5>Comparison v{props.compare.fromVersion} → v{props.compare.toVersion}</h5>
              <pre className="artifact-diff-pre">
                {props.compare.diff.split("\n").map((line, index) => (
                  <span key={index} className={diffLineClass(line)}>{line || " "}{"\n"}</span>
                ))}
              </pre>
            </div>
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

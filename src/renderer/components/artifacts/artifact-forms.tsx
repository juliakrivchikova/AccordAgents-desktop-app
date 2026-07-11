import { useState } from "react";
import { Eye, Pencil } from "lucide-react";

import type { ArtifactSummary } from "../../../shared/types";
import { MarkdownText } from "../content/markdown-text";
import { ResizableTextarea } from "../primitives";

export interface ArtifactCreateValues {
  name: string;
  content: string;
  contributors: string[];
  requiredSigners: string[];
  labels: string[];
}

export interface ArtifactAccessValues {
  owner?: string;
  contributors: string[];
  requiredSigners: string[];
  labels: string[];
}

export function splitMemberList(value: string): string[] {
  return value.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

function ArtifactMarkdownEditor(props: {
  id: string;
  label: string;
  value: string;
  rows: number;
  placeholder?: string;
  onChange: (value: string) => void;
}): JSX.Element {
  const [preview, setPreview] = useState(false);
  const trimmedValue = props.value.trim();
  return (
    <div className="artifact-content-editor">
      <div className="artifact-content-editor-head">
        <label className="artifact-content-editor-label" htmlFor={props.id}>{props.label}</label>
        <span className="artifact-content-preview-toggle" aria-label="Artifact content editor mode">
          <button type="button" className={preview ? "is-selected" : ""} onClick={() => setPreview(true)}>
            <Eye size={14} aria-hidden /> Preview
          </button>
          <button type="button" className={!preview ? "is-selected" : ""} onClick={() => setPreview(false)}>
            <Pencil size={14} aria-hidden /> Edit
          </button>
        </span>
      </div>
      {preview ? (
        <div className="artifact-content-preview">
          {trimmedValue ? <MarkdownText content={trimmedValue} /> : <span>Nothing to preview yet.</span>}
        </div>
      ) : (
        <ResizableTextarea
          id={props.id}
          className="artifact-content-editor-textarea"
          value={props.value}
          rows={props.rows}
          maxHeight={420}
          placeholder={props.placeholder}
          onChange={(event) => props.onChange(event.target.value)}
        />
      )}
    </div>
  );
}

export function CreateArtifactForm(props: {
  busy: boolean;
  onCancel: () => void;
  onSubmit: (values: ArtifactCreateValues) => void;
}): JSX.Element {
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [contributors, setContributors] = useState("");
  const [signers, setSigners] = useState("");
  const [labels, setLabels] = useState("");
  return (
    <div className="artifacts-panel-body artifact-form">
      <label>Name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Release plan, QA cases, Todo list — any name" /></label>
      <ArtifactMarkdownEditor
        id="artifact-create-content"
        label="Content"
        value={content}
        rows={12}
        placeholder="Free-form Markdown"
        onChange={setContent}
      />
      <label>Contributors <span className="artifact-hint">comma-separated members; you own it either way</span>
        <input value={contributors} onChange={(event) => setContributors(event.target.value)} placeholder="gera, codex" />
      </label>
      <label>Required signers <span className="artifact-hint">only they can sign; all must sign the current version for full approval</span>
        <input value={signers} onChange={(event) => setSigners(event.target.value)} placeholder="user, gera" />
      </label>
      <label>Labels <span className="artifact-hint">optional, free-form</span>
        <input value={labels} onChange={(event) => setLabels(event.target.value)} placeholder="plan, v1" />
      </label>
      <div className="artifact-form-actions">
        <button type="button" className="artifact-secondary-action" onClick={props.onCancel}>Cancel</button>
        <button
          type="button"
          className="artifact-primary-action"
          disabled={props.busy || !name.trim() || !content}
          onClick={() => props.onSubmit({
            name,
            content,
            contributors: splitMemberList(contributors),
            requiredSigners: splitMemberList(signers),
            labels: splitMemberList(labels)
          })}
        >
          Create
        </button>
      </div>
    </div>
  );
}

export function ReviseArtifactForm(props: {
  baseVersion: number;
  initialContent: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (content: string, note: string | undefined) => void;
}): JSX.Element {
  const [content, setContent] = useState(props.initialContent);
  const [note, setNote] = useState("");
  return (
    <div className="artifact-form">
      <ArtifactMarkdownEditor
        id="artifact-revise-content"
        label={`Content (v${props.baseVersion} → v${props.baseVersion + 1})`}
        value={content}
        rows={14}
        onChange={setContent}
      />
      <label>Revision note <span className="artifact-hint">optional, shown in history and the chat note</span>
        <input value={note} onChange={(event) => setNote(event.target.value)} />
      </label>
      <div className="artifact-form-actions">
        <button type="button" className="artifact-secondary-action" onClick={props.onCancel}>Cancel</button>
        <button
          type="button"
          className="artifact-primary-action"
          disabled={props.busy || !content}
          onClick={() => props.onSubmit(content, note.trim() ? note : undefined)}
        >
          Save as v{props.baseVersion + 1}
        </button>
      </div>
    </div>
  );
}

export function AccessArtifactForm(props: {
  summary: ArtifactSummary;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (values: ArtifactAccessValues) => void;
}): JSX.Element {
  const [owner, setOwner] = useState(props.summary.owner);
  const [contributors, setContributors] = useState(props.summary.contributors.join(", "));
  const [signers, setSigners] = useState(props.summary.approval.requiredSigners.join(", "));
  const [labels, setLabels] = useState(props.summary.labels.join(", "));
  return (
    <div className="artifact-form">
      <label>Owner<input value={owner} onChange={(event) => setOwner(event.target.value)} /></label>
      <label>Contributors<input value={contributors} onChange={(event) => setContributors(event.target.value)} /></label>
      <label>Required signers<input value={signers} onChange={(event) => setSigners(event.target.value)} /></label>
      <label>Labels<input value={labels} onChange={(event) => setLabels(event.target.value)} /></label>
      <div className="artifact-form-actions">
        <button type="button" className="artifact-secondary-action" onClick={props.onCancel}>Cancel</button>
        <button
          type="button"
          className="artifact-primary-action"
          disabled={props.busy}
          onClick={() => props.onSubmit({
            owner: owner.trim() || undefined,
            contributors: splitMemberList(contributors),
            requiredSigners: splitMemberList(signers),
            labels: splitMemberList(labels)
          })}
        >
          Save access
        </button>
      </div>
    </div>
  );
}

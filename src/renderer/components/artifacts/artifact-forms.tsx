import { useEffect, useState } from "react";
import { BadgeCheck, Eye, FileText, Pencil } from "lucide-react";

import { artifactMemberLabel, normalizeArtifactMember } from "../../../shared/artifacts";
import { ARTIFACT_USER_MEMBER } from "../../../shared/types";
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
  contributors?: string[];
  requiredSigners?: string[];
  labels?: string[];
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

export function AccessArtifactForm(props: {
  summary: ArtifactSummary;
  members: string[];
  busy: boolean;
  onSubmit: (values: ArtifactAccessValues) => Promise<boolean>;
}): JSX.Element {
  const [owner, setOwner] = useState(props.summary.owner);
  const [contributors, setContributors] = useState(props.summary.contributors);
  const [signerMembers, setSignerMembers] = useState(props.summary.approval.requiredSigners);
  const [labels, setLabels] = useState(props.summary.labels.join(", "));
  const savedOwnerMember = props.summary.owner;
  const selectedOwnerMember = normalizeArtifactMember(owner) || savedOwnerMember;
  const canEditSigners = props.summary.lifecycle === "published";
  const memberRows = [
    ...new Set([ARTIFACT_USER_MEMBER, savedOwnerMember, selectedOwnerMember, ...props.members, ...contributors, ...signerMembers].map(normalizeArtifactMember).filter(Boolean))
  ];
  useEffect(() => {
    setOwner(props.summary.owner);
    setContributors(props.summary.contributors);
    setSignerMembers(props.summary.approval.requiredSigners);
    setLabels(props.summary.labels.join(", "));
  }, [props.summary.id, props.summary.owner, props.summary.contributors, props.summary.approval.requiredSigners, props.summary.labels]);

  function savedContributorValues(nextContributors: string[]): string[] {
    return normalizeMemberList(nextContributors).filter((entry) => (
      entry !== ARTIFACT_USER_MEMBER && entry !== savedOwnerMember
    ));
  }

  function accessValues(): ArtifactAccessValues {
    const nextOwner = selectedOwnerMember;
    const nextContributors = normalizeMemberList(contributors).filter((entry) => (
      entry !== ARTIFACT_USER_MEMBER && entry !== nextOwner
    ));
    const values: ArtifactAccessValues = {
      owner: nextOwner,
      contributors: nextContributors,
      labels: splitMemberList(labels)
    };
    if (canEditSigners) {
      values.requiredSigners = normalizeMemberList(signerMembers);
    }
    return values;
  }

  async function toggleContributor(member: string): Promise<void> {
    if (props.busy || member === ARTIFACT_USER_MEMBER || member === savedOwnerMember) {
      return;
    }
    const previous = contributors;
    const nextContributors = contributors.includes(member)
      ? contributors.filter((entry) => entry !== member)
      : [...contributors, member];
    const normalized = savedContributorValues(nextContributors);
    setContributors(normalized);
    if (!await props.onSubmit({ contributors: normalized })) {
      setContributors(previous);
    }
  }

  async function toggleSigner(member: string): Promise<void> {
    if (props.busy || !canEditSigners) {
      return;
    }
    const previous = signerMembers;
    const normalized = signerMembers.includes(member)
      ? signerMembers.filter((entry) => entry !== member)
      : [...signerMembers, member];
    setSignerMembers(normalized);
    if (!await props.onSubmit({ requiredSigners: normalizeMemberList(normalized) })) {
      setSignerMembers(previous);
    }
  }

  async function saveDetails(): Promise<void> {
    await props.onSubmit(accessValues());
  }

  return (
    <div className="artifact-access-popover" role="dialog" aria-label="Manage artifact access">
      <div className="aap-head">
        <strong>Manage access</strong>
        <span>Who can read or edit this artifact</span>
      </div>
      <div className="aap-list">
        {memberRows.map((member) => {
          const isOwner = member === savedOwnerMember;
          const isUser = member === ARTIFACT_USER_MEMBER;
          const canWrite = isUser || isOwner || contributors.includes(member);
          const tags = [
            isUser ? "User" : undefined,
            isOwner ? "Owner" : undefined,
            contributors.includes(member) && !isOwner ? "Editor" : undefined,
            signerMembers.includes(member) ? "Signer" : undefined
          ].filter(Boolean);
          return (
            <div className="aap-row" key={member}>
              <span className="aap-name">
                {artifactMemberLabel(member)}
                <span className="aap-tag">{tags.join(" · ") || "Viewer"}</span>
              </span>
              <div className="aap-perms">
                <button type="button" className="aap-perm on" aria-pressed="true" title="All chat members can read artifacts">
                  <FileText size={13} aria-hidden /> Read
                </button>
                <button
                  type="button"
                  className={`aap-perm${canWrite ? " on" : ""}`}
                  aria-pressed={canWrite}
                  disabled={props.busy || isUser || isOwner}
                  data-testid={`artifact-access-write-${member}`}
                  title={isUser ? "User always keeps write permission" : isOwner ? "Owner can always write" : undefined}
                  onClick={() => void toggleContributor(member)}
                >
                  <Pencil size={13} aria-hidden /> Write
                </button>
                {canEditSigners && (
                  <button
                    type="button"
                    className={`aap-perm${signerMembers.includes(member) ? " on" : ""}`}
                    aria-pressed={signerMembers.includes(member)}
                    disabled={props.busy}
                    data-testid={`artifact-access-sign-${member}`}
                    onClick={() => void toggleSigner(member)}
                  >
                    <BadgeCheck size={13} aria-hidden /> Sign
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="aap-fields">
        <label>
          <span>Owner</span>
          <select
            value={selectedOwnerMember}
            disabled={props.busy}
            data-testid="artifact-access-owner"
            onChange={(event) => setOwner(event.currentTarget.value)}
          >
            {memberRows.map((member) => (
              <option key={member} value={member}>{artifactMemberLabel(member)}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Labels</span>
          <input
            value={labels}
            disabled={props.busy}
            placeholder="plan, v1"
            data-testid="artifact-access-labels"
            onChange={(event) => setLabels(event.currentTarget.value)}
          />
        </label>
        <button
          type="button"
          className="artifact-secondary-action"
          disabled={props.busy}
          data-testid="artifact-access-save-details"
          onClick={() => void saveDetails()}
        >
          Save details
        </button>
      </div>
    </div>
  );
}

function normalizeMemberList(values: string[]): string[] {
  return [...new Set(values.map(normalizeArtifactMember).filter(Boolean))];
}

import { useEffect, useState } from "react";
import { BadgeCheck, Eye, FileText, Pencil } from "lucide-react";

import { artifactMemberLabel, normalizeArtifactMember } from "../../../shared/artifacts";
import { ARTIFACT_USER_MEMBER } from "../../../shared/types";
import type { ArtifactDraftView, ArtifactSummary } from "../../../shared/types";
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
      {preview && (
        <div className="artifact-content-preview markdown-preview">
          {trimmedValue ? <MarkdownText content={trimmedValue} /> : <span>Nothing to preview yet.</span>}
        </div>
      )}
      <ResizableTextarea
        id={props.id}
        className="artifact-content-editor-textarea"
        hidden={preview}
        value={props.value}
        rows={props.rows}
        maxHeight={420}
        placeholder={props.placeholder}
        onChange={(event) => props.onChange(event.target.value)}
      />
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

interface ArtifactMemberStatus {
  text: string;
  done: boolean;
}

// Who has handed in a draft and who has signed the current version, per member.
export function artifactMemberStatuses(
  member: string,
  summary: ArtifactSummary,
  drafts: ArtifactDraftView[],
  requiredDraftAuthors: string[]
): ArtifactMemberStatus[] {
  const statuses: ArtifactMemberStatus[] = [];
  const own = drafts.filter((draft) => normalizeArtifactMember(draft.author) === member);
  if (own.some((draft) => draft.state === "submitted")) {
    statuses.push({ text: "Draft submitted", done: true });
  } else if (own.some((draft) => draft.state === "editing")) {
    statuses.push({ text: "Draft in progress", done: false });
  } else if (own.some((draft) => draft.state === "withdrawn")) {
    statuses.push({ text: "Draft withdrawn", done: false });
  } else if (requiredDraftAuthors.map(normalizeArtifactMember).includes(member)) {
    statuses.push({ text: "No draft yet", done: false });
  }
  if (summary.lifecycle === "published") {
    if (summary.approval.signedCurrent.map(normalizeArtifactMember).includes(member)) {
      statuses.push({ text: `Signed v${summary.headVersion}`, done: true });
    } else if (summary.approval.requiredSigners.map(normalizeArtifactMember).includes(member)) {
      statuses.push({ text: `Not signed v${summary.headVersion}`, done: false });
    }
  }
  return statuses;
}

export function AccessArtifactForm(props: {
  summary: ArtifactSummary;
  members: string[];
  drafts?: ArtifactDraftView[];
  requiredDraftAuthors?: string[];
  readOnly?: boolean;
  busy: boolean;
  onSubmit: (values: ArtifactAccessValues) => Promise<boolean>;
}): JSX.Element {
  const drafts = props.drafts ?? [];
  const requiredDraftAuthors = props.requiredDraftAuthors ?? [];
  const locked = props.busy || Boolean(props.readOnly);
  const [owner, setOwner] = useState(props.summary.owner);
  const [contributors, setContributors] = useState(props.summary.contributors);
  const [signerMembers, setSignerMembers] = useState(props.summary.approval.requiredSigners);
  const [labels, setLabels] = useState(props.summary.labels.join(", "));
  const savedOwnerMember = props.summary.owner;
  const selectedOwnerMember = normalizeArtifactMember(owner) || savedOwnerMember;
  const canEditSigners = props.summary.lifecycle === "published";
  const accessRows = [
    ...new Set([ARTIFACT_USER_MEMBER, savedOwnerMember, selectedOwnerMember, ...props.members, ...contributors, ...signerMembers].map(normalizeArtifactMember).filter(Boolean))
  ];
  // Draft authors and signers who are no longer in the chat keep their status row,
  // but the server only accepts current members, so their access can't be edited.
  const formerRows = [
    ...new Set([...props.summary.approval.signedCurrent, ...requiredDraftAuthors, ...drafts.map((draft) => draft.author)]
      .map(normalizeArtifactMember).filter((member) => member && !accessRows.includes(member)))
  ];
  const memberRows = [...accessRows, ...formerRows];
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
    if (locked || member === ARTIFACT_USER_MEMBER || member === savedOwnerMember || formerRows.includes(member)) {
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
    if (locked || !canEditSigners) {
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
        <span>{props.readOnly ? "Archived — restore it to change access" : "Who can read or edit this artifact"}</span>
      </div>
      <div className="aap-list">
        {memberRows.map((member) => {
          const isOwner = member === savedOwnerMember;
          const isFormer = formerRows.includes(member);
          const isUser = member === ARTIFACT_USER_MEMBER;
          const canWrite = isUser || isOwner || contributors.includes(member);
          const tags = [
            isUser ? "User" : undefined,
            isOwner ? "Owner" : undefined,
            contributors.includes(member) && !isOwner ? "Editor" : undefined,
            signerMembers.includes(member) ? "Signer" : undefined
          ].filter(Boolean);
          const statuses = artifactMemberStatuses(member, props.summary, drafts, requiredDraftAuthors);
          return (
            <div className="aap-row" key={member}>
              <span className="aap-name">
                {artifactMemberLabel(member)}
                <span className="aap-tag">{isFormer ? "Not in this chat" : tags.join(" · ") || "Viewer"}</span>
                {statuses.length > 0 && (
                  <span className="aap-status" data-testid={`artifact-access-status-${member}`}>
                    {statuses.map((status, index) => (
                      <span key={status.text}>
                        {index > 0 ? " · " : ""}
                        <span className={status.done ? "is-done" : "is-pending"}>{status.text}</span>
                      </span>
                    ))}
                  </span>
                )}
              </span>
              <div className="aap-perms">
                <button type="button" className="aap-perm on" aria-pressed="true" title="All chat members can read artifacts">
                  <FileText size={13} aria-hidden /> Read
                </button>
                <button
                  type="button"
                  className={`aap-perm${canWrite ? " on" : ""}`}
                  aria-pressed={canWrite}
                  disabled={locked || isUser || isOwner || isFormer}
                  data-testid={`artifact-access-write-${member}`}
                  title={isUser ? "User always keeps write permission" : isOwner ? "Owner can always write" : undefined}
                  onClick={() => void toggleContributor(member)}
                >
                  <Pencil size={13} aria-hidden /> Write
                </button>
                {canEditSigners && !isFormer && (
                  <button
                    type="button"
                    className={`aap-perm${signerMembers.includes(member) ? " on" : ""}`}
                    aria-pressed={signerMembers.includes(member)}
                    disabled={locked}
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
            disabled={locked}
            data-testid="artifact-access-owner"
            onChange={(event) => setOwner(event.currentTarget.value)}
          >
            {accessRows.map((member) => (
              <option key={member} value={member}>{artifactMemberLabel(member)}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Labels</span>
          <input
            value={labels}
            disabled={locked}
            placeholder="plan, v1"
            data-testid="artifact-access-labels"
            onChange={(event) => setLabels(event.currentTarget.value)}
          />
        </label>
        {!props.readOnly && (
          <button
            type="button"
            className="artifact-secondary-action"
            disabled={props.busy}
            data-testid="artifact-access-save-details"
            onClick={() => void saveDetails()}
          >
            Save details
          </button>
        )}
      </div>
    </div>
  );
}

function normalizeMemberList(values: string[]): string[] {
  return [...new Set(values.map(normalizeArtifactMember).filter(Boolean))];
}

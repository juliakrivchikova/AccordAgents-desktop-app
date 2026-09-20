import type { ReactNode } from "react";
import { BadgeCheck, Check, ChevronDown } from "lucide-react";
import { DropdownMenu } from "radix-ui";

import type { ArtifactDraftView, ArtifactVersionMeta } from "../../../shared/types";
import { artifactMemberLabel } from "../../../shared/artifacts";

export interface ArtifactPickerEntry {
  value: string;
  title: string;
  meta: string;
  note?: string;
  signed?: { count: number; required: number };
}

export interface ArtifactSubtitleParts {
  prefix: string;
  strong: string;
  suffix: string;
}

const VERSION_PREFIX = "version:";
const DRAFT_PREFIX = "draft:";

export function artifactVersionEntryValue(version: number): string {
  return `${VERSION_PREFIX}${version}`;
}

export function artifactDraftEntryValue(draftId: string): string {
  return `${DRAFT_PREFIX}${draftId}`;
}

function formatWhen(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : value;
}

export function artifactDraftLabel(draft: ArtifactDraftView): string {
  return `Draft by ${artifactMemberLabel(draft.author)}`;
}

function draftStateLabel(draft: ArtifactDraftView): string {
  return `${draft.state.charAt(0).toUpperCase()}${draft.state.slice(1)}`;
}

// Rows of the header's version picker: every version (newest first) and every draft.
export function artifactPickerEntries(props: {
  history: ArtifactVersionMeta[];
  drafts: ArtifactDraftView[];
  headVersion?: number;
  requiredSigners?: string[];
}): { versions: ArtifactPickerEntry[]; drafts: ArtifactPickerEntry[] } {
  const required = props.requiredSigners ?? [];
  const versions = [...props.history].sort((left, right) => right.version - left.version).map((version) => ({
    value: artifactVersionEntryValue(version.version),
    title: `v${version.version}${version.version === props.headVersion ? " · Current" : ""}`,
    meta: `${artifactMemberLabel(version.author)} · ${formatWhen(version.createdAt)}`,
    note: version.note,
    signed: required.length > 0
      ? { count: version.signatures.filter((signature) => required.includes(signature.signer)).length, required: required.length }
      : undefined
  }));
  const drafts = props.drafts.map((draft) => ({
    value: artifactDraftEntryValue(draft.id),
    title: artifactDraftLabel(draft),
    meta: `${draftStateLabel(draft)} · ${formatWhen(draft.submittedAt ?? draft.updatedAt)}`
  }));
  return { versions, drafts };
}

export function selectArtifactPickerEntry(
  value: string,
  onShowVersion: (version: number) => void,
  onShowDraft: (draftId: string) => void
): void {
  if (value.startsWith(VERSION_PREFIX)) {
    const version = Number(value.slice(VERSION_PREFIX.length));
    if (Number.isFinite(version)) {
      onShowVersion(version);
    }
    return;
  }
  if (value.startsWith(DRAFT_PREFIX)) {
    const draftId = value.slice(DRAFT_PREFIX.length);
    if (draftId) {
      onShowDraft(draftId);
    }
  }
}

// The header line under the title, which is also the picker's trigger.
export function artifactSubtitleParts(input: {
  lifecycle: "published" | "collecting_drafts";
  archived: boolean;
  version?: { version: number; author: string };
  draft?: ArtifactDraftView;
  submittedDraftCount: number;
  requiredDraftCount: number;
  updatedLabel: string;
}): ArtifactSubtitleParts {
  const archived = input.archived ? "Archived · " : "";
  const draftLabel = input.draft ? artifactDraftLabel(input.draft) : "";
  if (input.lifecycle === "collecting_drafts") {
    const progress = `Collecting drafts ${input.submittedDraftCount}/${input.requiredDraftCount}`;
    return {
      prefix: `${archived}${progress}${draftLabel ? " · " : ""}`,
      strong: draftLabel,
      // Without the state a withdrawn or superseded draft reads as the live one.
      suffix: input.draft ? ` · ${draftStateLabel(input.draft)}` : ""
    };
  }
  if (input.draft) {
    return { prefix: archived, strong: draftLabel, suffix: ` · ${draftStateLabel(input.draft)}` };
  }
  const version = input.version;
  return {
    prefix: archived,
    strong: version ? `v${version.version}` : "",
    suffix: version ? ` by ${artifactMemberLabel(version.author)} · ${input.updatedLabel}` : input.updatedLabel
  };
}

export function ArtifactVersionSelector(props: {
  label: ReactNode;
  selectedVersion?: number;
  headVersion?: number;
  history: ArtifactVersionMeta[];
  drafts: ArtifactDraftView[];
  selectedDraftId?: string;
  requiredSigners?: string[];
  disabled?: boolean;
  onShowVersion: (version: number) => void;
  onShowDraft: (draftId: string) => void;
}): JSX.Element {
  const selectedEntry = props.selectedDraftId
    ? artifactDraftEntryValue(props.selectedDraftId)
    : props.selectedVersion !== undefined ? artifactVersionEntryValue(props.selectedVersion) : "";
  const entries = artifactPickerEntries(props);
  const isEmpty = entries.versions.length === 0 && entries.drafts.length === 0;
  const selectEntry = (value: string): void => selectArtifactPickerEntry(value, props.onShowVersion, props.onShowDraft);

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild disabled={props.disabled}>
        <button type="button" className="artifact-version-trigger" data-testid="artifact-version-selector" title="Choose version or draft">
          <span>{props.label}</span>
          <ChevronDown size={13} aria-hidden />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="artifact-menu artifact-version-menu" align="start" sideOffset={6} collisionPadding={12}>
          {isEmpty && (
            <DropdownMenu.Item className="artifact-menu-item" disabled>
              <span className="artifact-menu-item-label">No versions or drafts yet</span>
            </DropdownMenu.Item>
          )}
          <DropdownMenu.RadioGroup value={selectedEntry} onValueChange={selectEntry}>
            {entries.versions.length > 0 && <DropdownMenu.Label className="artifact-menu-label">Versions</DropdownMenu.Label>}
            {entries.versions.map((entry) => <ArtifactPickerRow key={entry.value} entry={entry} />)}
            {entries.versions.length > 0 && entries.drafts.length > 0 && <DropdownMenu.Separator className="artifact-menu-separator" />}
            {entries.drafts.length > 0 && <DropdownMenu.Label className="artifact-menu-label">Drafts</DropdownMenu.Label>}
            {entries.drafts.map((entry) => <ArtifactPickerRow key={entry.value} entry={entry} />)}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function ArtifactPickerRow({ entry }: { entry: ArtifactPickerEntry }): JSX.Element {
  const complete = Boolean(entry.signed && entry.signed.count >= entry.signed.required);
  return (
    <DropdownMenu.RadioItem value={entry.value} className="artifact-menu-item artifact-version-item">
      <span className="artifact-menu-check">
        <DropdownMenu.ItemIndicator><Check size={15} aria-hidden /></DropdownMenu.ItemIndicator>
      </span>
      <span className="artifact-version-row">
        <span className="artifact-version-row-title">
          <span>{entry.title}</span>
          {entry.signed ? (
            <span className={`artifact-version-signed${complete ? " is-complete" : ""}`}>
              {complete ? <BadgeCheck size={13} aria-hidden /> : null}
              Signed {entry.signed.count}/{entry.signed.required}
            </span>
          ) : null}
        </span>
        <span className="artifact-version-row-meta">{entry.meta}</span>
        {entry.note ? <span className="artifact-version-row-note">{entry.note}</span> : null}
      </span>
    </DropdownMenu.RadioItem>
  );
}
